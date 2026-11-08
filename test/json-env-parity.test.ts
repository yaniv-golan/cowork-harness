import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fakeLimactl } from "./helpers/fake-limactl.js";

// COWORK_HARNESS_OUTPUT_FORMAT=json is documented as the default for `--output-format`, for EVERY command
// that takes the flag. Several commands honoured it only on their error path (the shared `isJsonOutput`)
// while their success path read the flag alone, so an env-only consumer got a JSON error envelope when a
// command failed and human text on stderr (stdout empty) when it succeeded — the one outcome a consumer
// most needs to parse.
//
// The behavioural rows below are the real guard: each drives a token-free SUCCESS path twice — once with
// the flag, once with only the env var — and requires the same single document (command, ok, exit code).
// `vm status` runs against a scripted limactl (macOS only — `vm` refuses other platforms), so off macOS that
// row is skipped and only the structural scan at the bottom covers `vm`.
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);
// `vm` is macOS-only; its row talks to a scripted limactl, never to a VM on this machine.
const notDarwin = process.platform !== "darwin";

const work = mkdtempSync(join(tmpdir(), "json-env-parity-"));
const runs = mkdtempSync(join(tmpdir(), "json-env-parity-runs-"));
// The var is REMOVED, not blanked: an empty value is itself refused as an invalid format.
const { COWORK_HARNESS_OUTPUT_FORMAT: _inherited, ...inheritedEnv } = process.env;
const baseEnv: NodeJS.ProcessEnv = {
  ...inheritedEnv,
  COWORK_HARNESS_RUNS_DIR: runs,
  COWORK_HARNESS_LIMACTL: fakeLimactl({ status: "Running", provisioning: "ready" }),
  CLAUDE_CODE_OAUTH_TOKEN: "",
  ANTHROPIC_API_KEY: "",
  ANTHROPIC_AUTH_TOKEN: "",
};

function cli(args: string[], env: NodeJS.ProcessEnv = {}) {
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8", cwd: work, env: { ...baseEnv, ...env } });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function oneDoc(stdout: string, stderr: string): Record<string, unknown> {
  try {
    return JSON.parse(stdout);
  } catch (e) {
    throw new Error(`stdout is not exactly one JSON document (${(e as Error).message}):\n${stdout}\nstderr:\n${stderr}`);
  }
}

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────────
const skill = join(work, "sk");
mkdirSync(skill);
writeFileSync(join(skill, "SKILL.md"), "---\nname: sk\ndescription: does a thing when asked\n---\nbody text\n");

const statusDir = join(work, "status-run");
mkdirSync(statusDir);
writeFileSync(
  join(statusDir, "status.json"),
  JSON.stringify({
    schemaVersion: 1,
    state: "done",
    pid: 999,
    scenario: "demo",
    fidelity: "container",
    sessionId: "local_x",
    startedAt: new Date(Date.now() - 5000).toISOString(),
    updatedAt: new Date().toISOString(),
    elapsedMs: 5000,
    toolCounts: { Read: 1 },
    subagentCount: 0,
    result: "success",
  }),
);

// A kept run whose recorded run succeeded and used `Read` (same shape as verify-run-envelope-parity).
const keptRun = join(work, "kept");
const workDir = join(keptRun, "work", "session", "mnt");
mkdirSync(join(workDir, "outputs"), { recursive: true });
const t1 = join(keptRun, "turns", "1");
mkdirSync(t1, { recursive: true });
writeFileSync(
  join(t1, "result.json"),
  JSON.stringify({
    scenario: "smoke",
    fidelity: "container",
    baseline: "desktop-1.14271.0",
    result: "success",
    decisions: [],
    toolCounts: { Read: 1 },
    gateDeliveries: [],
    egress: [],
    assertions: [],
    subagents: [],
    outDir: keptRun,
    workDir,
    durationMs: 1,
    scan: { outputsDeletes: [], hostPathLeaked: false, selfHealRan: false },
  }),
);
writeFileSync(join(t1, "run.jsonl"), JSON.stringify({ t: "run", scenario: "smoke" }) + "\n");
writeFileSync(join(t1, "trace.json"), JSON.stringify({ questions: [], steps: [] }));
const verifyScenario = join(work, "verify.yaml");
writeFileSync(verifyScenario, "name: smoke\nprompt: do the thing\nfidelity: container\nassert:\n  - tool_called: Read\n");

const CASSETTE = resolve("examples/replays/example-pdf-skill.cassette.json");
const REPLAYS = resolve("examples/replays");

// [label, argv, skip?]
const ROWS: [string, string[], boolean?][] = [
  ["doctor --tier protocol", ["doctor", "--tier", "protocol"]],
  ["status <dir>", ["status", statusDir]],
  ["verify-run <dir> <scenario>", ["verify-run", keptRun, verifyScenario]],
  ["analyze-skill <SKILL.md>", ["analyze-skill", join(skill, "SKILL.md")]],
  ["replay <cassette>", ["replay", CASSETTE]],
  ["verify-cassettes <dir>", ["verify-cassettes", REPLAYS]],
  ["critique <skill> --corpus-only", ["critique", skill, "--corpus-only"]],
  ["vm status", ["vm", "status"], notDarwin],
];

describe.skipIf(!can)("COWORK_HARNESS_OUTPUT_FORMAT=json alone gives the same document as --output-format json", () => {
  for (const [label, argv, skip] of ROWS) {
    it.skipIf(!!skip)(label, () => {
      const flag = cli([...argv, "--output-format", "json"]);
      const env = cli(argv, { COWORK_HARNESS_OUTPUT_FORMAT: "json" });
      const a = oneDoc(flag.stdout, flag.stderr);
      const b = oneDoc(env.stdout, env.stderr);
      expect(b.command, env.stdout).toBe(a.command);
      expect(b.ok, env.stdout).toBe(a.ok);
      expect(env.code, env.stderr).toBe(flag.code);
    });
  }

  // The explicit flag still wins over the env var in the other direction.
  it("env json + --output-format text prints text, not a document", () => {
    const r = cli(["verify-cassettes", REPLAYS, "--output-format", "text"], { COWORK_HARNESS_OUTPUT_FORMAT: "json" });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.trim().startsWith("{"), r.stdout).toBe(false);
  });
});

// STRUCTURAL: the flag is read in exactly one place. A command that reads `options["--output-format"]`
// itself decides the format from the flag alone and drops the env var — the defect above. Any bracket
// read of the key, in any quoting, is forbidden outside envelope.ts (the `values:`/`enums:` declarations
// are object keys, not reads, and do not match).
describe("--output-format is only resolved through the shared predicate", () => {
  function srcFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...srcFiles(p));
      else if (p.endsWith(".ts")) out.push(p);
    }
    return out;
  }
  const files = srcFiles(resolve("src"));

  it("the scan sees the source tree (never green over an empty scan)", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.endsWith(join("src", "run", "envelope.ts")))).toBe(true);
  });

  it("no bracket read of --output-format outside envelope.ts", () => {
    // A MEMBER read (`x["…"]`, `x?.["…"]`, `f()["…"]`), not an array literal such as `["--output-format"]`
    // passed as a list of value-taking flags.
    const READ = /(?:[\w$\])]|\?\.)\s*\[\s*["'`]--output-format["'`]\s*\]/;
    const hits: string[] = [];
    for (const f of files) {
      if (f.endsWith(join("src", "run", "envelope.ts"))) continue;
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (READ.test(line)) hits.push(`${relative(process.cwd(), f)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(hits, hits.join("\n")).toEqual([]);
  });

  it('no command defaults its format to a literal "text" (the env var must supply the default)', () => {
    const hits: string[] = [];
    for (const f of files) {
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/outputFormat\b[^=\n]*=\s*"text"\s*;/.test(line)) hits.push(`${relative(process.cwd(), f)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(hits, hits.join("\n")).toEqual([]);
  });
});
