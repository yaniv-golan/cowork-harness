import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { runsRoot, resolveEventsFile, buildTrace } from "../src/run/trace-view.js";
import { renderFooter } from "../src/run/renderer.js";
import type { RunResult } from "../src/types.js";
import type { RenderPlan } from "../src/run/renderer.js";

// Initiative-G regression pins (#45, #47, #48, #58). Token-free & spawn-free: #45/#47/#48 import the
// source directly; #58 spawns the built CLI for usage-error exit codes (no agent spawn — the parser
// fails before any run starts).

// ── #45: runs/ root is resolved via COWORK_HARNESS_RUNS_DIR / repo-relative, NOT cwd-relative ──
describe("#45 — runsRoot resolves from another directory", () => {
  const orig = process.cwd();
  const origEnv = process.env.COWORK_HARNESS_RUNS_DIR;

  it("resolves a run under COWORK_HARNESS_RUNS_DIR even when cwd is elsewhere", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cwh-runsroot-"));
    const runDir = join(runsDir, "my-scenario", "run-xyz");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "events.jsonl"), "");
    // chdir to a DIFFERENT dir with no runs/ of its own — the cwd-relative bug would fail here.
    const elsewhere = mkdtempSync(join(tmpdir(), "cwh-elsewhere-"));
    process.chdir(elsewhere);
    process.env.COWORK_HARNESS_RUNS_DIR = runsDir;
    try {
      expect(runsRoot()).toBe(runsDir);
      const f = resolveEventsFile("run-xyz");
      expect(f).toBe(join(runDir, "events.jsonl"));
    } finally {
      if (origEnv === undefined) delete process.env.COWORK_HARNESS_RUNS_DIR;
      else process.env.COWORK_HARNESS_RUNS_DIR = origEnv;
      process.chdir(orig);
    }
  });
});

// ── #47: malformed JSON lines are skipped but warned (not silently dropped) ──
describe("#47 — eventsOf warns loudly on malformed JSON", () => {
  it("parses the good event and fires a ::warning:: for the bad line", () => {
    const dir = mkdtempSync(join(tmpdir(), "cwh-malformed-"));
    const f = join(dir, "events.jsonl");
    // one valid event + one truncated/garbage line
    writeFileSync(
      f,
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "r1", name: "Read", input: { file_path: "/x" } }] },
      }) + "\n{ this is not valid json\n",
    );
    const chunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: string) => {
      chunks.push(String(s));
      return true;
    };
    let rows;
    try {
      rows = buildTrace(f);
    } finally {
      (process.stderr as any).write = origWrite;
    }
    // the good event still parsed
    expect(rows.some((r) => r.kind === "tool" && r.name === "Read")).toBe(true);
    // and the malformed line was loud
    const combined = chunks.join("");
    expect(combined).toMatch(/::warning::/);
    expect(combined).toMatch(/malformed JSON/);
  });
});

// ── #48: answer hints partition scriptable (`first`) vs non-deterministic (`agent`/`external`/`human`) ──
describe("#48 — renderAnswerHints separates scriptable from non-deterministic answers", () => {
  const PLAN: RenderPlan = { live: false, progress: false, verbose: false, color: false };

  function footerOutput(unanswered: RunResult["unanswered"]): string {
    const r: RunResult = {
      scenario: "s",
      fidelity: "container",
      baseline: "x",
      result: "success",
      decisions: [],
      egress: [],
      assertions: [],
      unanswered,
      outDir: "/tmp/run",
    };
    const chunks: string[] = [];
    renderFooter(r, PLAN, { write: (s) => chunks.push(s) });
    return chunks.join("");
  }

  it("only `first` gets a --answer script hint; external/agent get the non-deterministic message", () => {
    const out = footerOutput([
      { question: "Pick a format", chosen: "Markdown", by: "first" },
      { question: "External call", chosen: "Yes", by: "external" },
      { question: "LLM call", chosen: "No", by: "llm" },
    ]);
    // the scriptable bucket: exactly the `first` answer is offered as a pinnable --answer line
    expect(out).toMatch(/to script, add:/);
    expect(out).toMatch(/--answer "Pick a format=Markdown"/);
    // the non-deterministic bucket exists and does NOT claim --answer reproduces it
    expect(out).toMatch(/non-deterministically.*not reproducible via --answer/);
    expect(out).toMatch(/chose "External call=Yes" \(by external\)/);
    expect(out).toMatch(/chose "LLM call=No" \(by llm\)/);
    // external/agent answers must NOT be presented as scriptable --answer lines
    expect(out).not.toMatch(/--answer "External call=Yes"/);
    expect(out).not.toMatch(/--answer "LLM call=No"/);
  });
});

// ── #58: a trailing value-less value-taking flag is a usage error (exit 2), not a silent undefined ──
const CLI = resolve("dist/cli.js");
const canCli = existsSync(CLI);

describe.skipIf(!canCli)("#58 — value-taking flags require a value (exit 2)", () => {
  function run(args: string[]) {
    const cwd = mkdtempSync(join(tmpdir(), "cwh-cli58-"));
    const r = spawnSync("node", [CLI, ...args], { encoding: "utf8", cwd });
    return { code: r.status, stderr: r.stderr };
  }

  it("trailing --decider-cmd with no value → exit 2", () => {
    const r = run(["skill", "folder", "hi", "--decider-cmd"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--decider-cmd requires a value/);
  });

  it("trailing --decider-dir with no value → exit 2", () => {
    const r = run(["skill", "folder", "hi", "--decider-dir"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--decider-dir requires a value/);
  });

  it("trailing --fidelity with no value → exit 2", () => {
    const r = run(["skill", "folder", "hi", "--fidelity"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--fidelity requires a value/);
  });
});

// CLI smokes for the new commands (built binary). Skipped when dist/ isn't built.
describe.skipIf(!canCli)("assert --list / scaffold (CLI smokes)", () => {
  const run = (args: string[]) => spawnSync("node", [CLI, ...args], { encoding: "utf8" });
  it("assert --list prints the schema-generated assertion keys", () => {
    const r = run(["assert", "--list"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/artifact_json/);
    expect(r.stdout).toMatch(/dispatch_count_max/);
  });
  it("assert --list --output-format json emits a machine envelope", () => {
    const r = run(["assert", "--list", "--output-format", "json"]);
    expect(r.status).toBe(0);
    const env = JSON.parse(r.stdout.trim().split("\n").filter(Boolean).pop()!);
    expect(env.assertions.some((a: any) => a.key === "file_exists" && a.description)).toBe(true);
  });
  it("scaffold with no --from-run is a usage error (exit 2)", () => {
    const r = run(["scaffold"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--from-run/);
  });
});
