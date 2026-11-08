// `hillclimb seed`: a flow's baseline from an eval arm. The eval runs in-process with a fake runner that keeps a real
// run dir per rep (turns/1/result.json + events.jsonl), as executeScenario lays one out; nothing spends.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { RunResult } from "../src/types.js";
import { loadBaseline } from "../src/baseline.js";
import { buildFingerprint } from "../src/run/cassette.js";
import { runOutDir } from "../src/run/execute.js";
import { turnArtifactPath } from "../src/run/turn-layout.js";
import { runEval, parseEvalArgs, type EvalJobSpec } from "../src/eval/command.js";
import { writeStopped } from "../src/eval/stopped.js";
import { seedBaseline } from "../src/hillclimb/seed.js";
import { runHillclimbCommand, type RunCommandDeps } from "../src/hillclimb/run-command.js";
import { parseHillclimbRunArgs } from "../src/hillclimb/args.js";
import { checkFlowDir } from "../src/hillclimb/schema-check.js";

const FX = join(import.meta.dirname, "fixtures", "eval-classify");
const fixture = (name: string): RunResult => JSON.parse(readFileSync(join(FX, `${name}.json`), "utf8")) as RunResult;
const frames = readFileSync(join(import.meta.dirname, "fixtures", "hillclimb-runs", "result-event-pair.jsonl"), "utf8")
  .trim()
  .split("\n");
const MODEL = "claude-sonnet-5";
const SESSION_ID = "a9997992-62b9-4795-9b94-b7fc106bce6f";
const CSV_ASSERTS = `assert:
  - result: success
  - tool_called: Skill
  - tool_called: Bash
  - user_visible_artifact: outputs/metrics.json
  - user_visible_artifact: outputs/summary.md
  - transcript_matches: 'metrics\\.json'
  - no_delete_in_outputs: true
`;

let root: string;
let snaps: string;
let err: string[];
const saved: Record<string, string | undefined> = {};

function writePlugin(dir: string, body: string): void {
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "csv-metrics" }));
  mkdirSync(join(dir, "skills", "csv-metrics"), { recursive: true });
  writeFileSync(join(dir, "skills", "csv-metrics", "SKILL.md"), `---\nname: csv-metrics\ndescription: d\n---\n${body}\n`);
}

/** The eval's scenario dir (also the flow's target), and an eval of arms before/after kept on disk. */
async function evalOf(opts: { reps?: number } = {}) {
  const scen = join(root, "scenarios");
  mkdirSync(scen, { recursive: true });
  writePlugin(join(root, "declared", "csv-metrics"), "declared");
  writePlugin(join(root, "a", "csv-metrics"), "version A");
  writePlugin(join(root, "b", "csv-metrics"), "version B");
  writeFileSync(join(root, "session.yaml"), `model: ${MODEL}\nplugins:\n  local_plugins:\n    - ./declared/csv-metrics\n`);
  writeFileSync(
    join(scen, "csv-metrics.yaml"),
    `baseline: latest\nsession: ../session.yaml\nfidelity: container\nprompt: analyze\n${CSV_ASSERTS}`,
  );
  const runJob = async (spec: EvalJobSpec): Promise<RunResult> => {
    const baseline = loadBaseline(spec.scenario.baseline);
    const outDir = runOutDir(spec.scenario.name, spec.job.runId);
    const r = {
      ...fixture("public-scenario-pinned"),
      scenario: spec.scenario.name,
      modelPinHonored: true,
      fidelity: "container",
      outDir,
      cost: { usd: 0.5 },
      durationMs: 7000,
      fingerprint: buildFingerprint(spec.scenario.session, baseline.appVersion, undefined, spec.scenario.skills, baseline, spec.session),
    } as RunResult;
    mkdirSync(join(outDir, "turns", "1"), { recursive: true });
    writeFileSync(turnArtifactPath(outDir, 1, "result.json"), JSON.stringify(r));
    // The agent's own session transcript, where a container run keeps it: its main-loop call went out at the pinned effort.
    const projects = join(outDir, "work", "session", "mnt", ".claude", "projects", "-sessions-x");
    mkdirSync(projects, { recursive: true });
    writeFileSync(
      join(projects, `${SESSION_ID}.jsonl`),
      JSON.stringify({ type: "assistant", isSidechain: false, effort: "medium", message: { model: MODEL } }) + "\n",
    );
    writeFileSync(
      join(outDir, "events.jsonl"),
      [frames[0], JSON.stringify({ type: "assistant", parent_tool_use_id: null, message: { model: MODEL } }), frames[1]].join("\n"),
    );
    return r;
  };
  const evalDir = join(root, "eval");
  const a = parseEvalArgs([
    scen,
    "--arm",
    `before=${join(root, "a", "csv-metrics")}`,
    "--arm",
    `after=${join(root, "b", "csv-metrics")}`,
    "--out",
    evalDir,
    "--quiet",
    "--reps",
    String(opts.reps ?? 4),
  ]);
  await runEval(a, {
    runJob,
    tokenCheck: () => ({ id: "token", title: "Auth token", status: "ok", detail: "found", required: true }),
    isolationCheck: () => undefined,
    judgeCheck: async () => ({ lines: [] }),
    log: () => {},
    evalId: "seedtest",
    now: () => new Date("2026-11-01T00:00:00Z"),
  });
  return { scen, evalDir };
}

const seed = (evalDir: string, arm = "after", flow = "flow") =>
  seedBaseline(
    { target: "scenarios", flow, fromEval: evalDir, arm },
    { cwd: root, env: {}, secrets: [], stderr: (l) => err.push(l), snapshotRoot: snaps },
  );
const rows = (f: string) =>
  existsSync(join(root, "flow", "baseline", f))
    ? readFileSync(join(root, "flow", "baseline", f), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, any>)
    : [];
const snapshotDirs = () => {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d) as string[]) {
      if (depth === 2) out.push(join(d, e));
      else walk(join(d, e), depth + 1);
    }
  };
  walk(snaps, 0);
  return out;
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "hc-seed-")));
  snaps = realpathSync(mkdtempSync(join(tmpdir(), "hc-seed-snaps-")));
  for (const k of ["COWORK_HARNESS_RUNS_DIR", "COWORK_HARNESS_MODEL", "COWORK_HARNESS_JUDGE_MODEL", "COWORK_HARNESS_GITSET"])
    saved[k] = process.env[k];
  process.env.COWORK_HARNESS_RUNS_DIR = join(root, "runs");
  delete process.env.COWORK_HARNESS_MODEL;
  delete process.env.COWORK_HARNESS_JUDGE_MODEL;
  process.env.COWORK_HARNESS_GITSET = "0";
  err = [];
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const d of [root, snaps]) rmSync(d, { recursive: true, force: true });
});

describe("hillclimb seed: accepted", () => {
  it("installs the arm's snapshot and writes one row per rep, recording where each came from; _state.json untouched", async () => {
    const { evalDir } = await evalOf();
    const r = await seed(evalDir);
    expect(r.exitCode, err.join("\n")).toBe(0);
    expect(r).toMatchObject({ seeded: 4, errors: 0, variant: "baseline" });
    const rs = rows("results.jsonl");
    expect(rs.map((x) => x.rep)).toEqual([0, 1, 2, 3]);
    const manifest = JSON.parse(readFileSync(join(evalDir, "manifest.json"), "utf8"));
    for (const x of rs) {
      // eval numbers its reps from 1, a flow its slots from 0
      expect(x.meta.seeded_from).toMatchObject({ eval_id: "seedtest", arm: "after", eval_rep: x.rep + 1 });
      expect(x.meta.seeded_from.seeder_version).toMatch(/^\d+\.\d+\.\d+/);
      expect(x.meta.env.harnessVersion).toBe(manifest.harnessVersion);
      expect(x.cost_usd).toBe(0.5);
      // A valid row's latency is the result event's duration_ms, as a live row's.
      expect(x.latency_s).toBe(16.134);
      expect(x.meta.content_sig).toBe(manifest.arms[1].sigs["csv-metrics"]);
    }
    expect(existsSync(join(root, "flow", "_state.json"))).toBe(false);
    expect(r.snapshot).toBeDefined();
    expect(readFileSync(join(r.snapshot!, "skills", "csv-metrics", "SKILL.md"), "utf8")).toMatch(/version B/);
    expect(existsSync(`${r.snapshot}.complete`)).toBe(true);
    expect(JSON.parse(readFileSync(join(root, "flow", "baseline", "summary.json"), "utf8")).cost_usd_total).toBe(2);
    expect(checkFlowDir(join(root, "flow"), { profile: "harness" }).findings.filter((f) => f.level === "error")).toEqual([]);
  });

  it("the next baseline pass reuses the seeded snapshot and has nothing left to run", async () => {
    const { evalDir } = await evalOf();
    await seed(evalDir);
    const runDeps: RunCommandDeps = {
      cwd: root,
      env: {},
      snapshotRoot: snaps,
      secrets: [],
      stderr: (l) => err.push(l),
      flags: {},
      isolationCheck: () => undefined,
      judgeCheck: async () => ({ lines: [] }),
      tokenCheck: () => ({ id: "token", title: "Auth token", status: "ok", detail: "found", required: true }),
      runScenario: async () => {
        throw new Error("no agent run");
      },
      indexRows: () => [],
    };
    const args = (...a: string[]) => {
      const p = parseHillclimbRunArgs(["scenarios", "--flow", "flow", "--reps", "4", ...a]);
      if (p.help) throw new Error("help");
      return p;
    };
    err = [];
    const r = await runHillclimbCommand(args("--approve-harness", "--dry-run"), runDeps);
    expect(r.exitCode, err.join("\n")).toBe(0);
    expect(r.remaining).toEqual({});
    expect(err.join("\n")).not.toMatch(/plugin snapshot:/);
    // The live plugin holds other content than arm `after`: the baseline's reps run from the seeded snapshot.
    expect(err.join("\n")).toMatch(/differs from variant baseline's snapshot \(taken on its first run\); its reps run from the snapshot/);
  });
});

describe("hillclimb seed: refused before any write (exit 2)", () => {
  const refused = async (evalDir: string, re: RegExp, arm = "after") => {
    const r = await seed(evalDir, arm);
    expect(r.exitCode, err.join("\n")).toBe(2);
    expect(r.error?.message).toMatch(re);
    expect(rows("results.jsonl")).toEqual([]);
    expect(rows("errors.jsonl")).toEqual([]);
    expect(snapshotDirs()).toEqual([]);
  };

  it("an edited scenario file", async () => {
    const { evalDir, scen } = await evalOf();
    writeFileSync(join(scen, "csv-metrics.yaml"), readFileSync(join(scen, "csv-metrics.yaml"), "utf8").replace("analyze", "analyse"));
    await refused(evalDir, /case csv-metrics: the scenario file \(sha256\) differs/);
  });

  it("an edited session file", async () => {
    const { evalDir } = await evalOf();
    writeFileSync(join(root, "session.yaml"), readFileSync(join(root, "session.yaml"), "utf8") + "effort: high\n");
    await refused(evalDir, /the session file \(sha256\) differs/);
  });

  it("a different agent pin", async () => {
    const { evalDir } = await evalOf();
    process.env.COWORK_HARNESS_MODEL = "claude-opus-5";
    // The session's model: wins over the env, so the pin only moves when the session names none: drop it.
    writeFileSync(join(root, "session.yaml"), `plugins:\n  local_plugins:\n    - ./declared/csv-metrics\n`);
    await refused(evalDir, /differs/);
  });

  it("an arm whose content no longer matches what its reps ran (removed afterwards)", async () => {
    const { evalDir } = await evalOf();
    const manifest = JSON.parse(readFileSync(join(evalDir, "manifest.json"), "utf8"));
    writeFileSync(join(evalDir, manifest.arms[1].snapshot, "skills", "csv-metrics", "SKILL.md"), "tampered\n");
    await refused(evalDir, /the eval arm's snapshot hashes to .* but its reps ran .* the content differs/);
  });

  it("a frozen-search-corpus eval", async () => {
    const { evalDir } = await evalOf();
    const p = join(evalDir, "manifest.json");
    const m = JSON.parse(readFileSync(p, "utf8"));
    m.schemaVersion = 1;
    m.pins.searchCorpus = { poolId: "p", sha256: "a".repeat(64), miss: "empty", copy: "pool" };
    writeFileSync(p, JSON.stringify(m));
    await refused(evalDir, /frozen search corpus/);
  });

  it("an eval that stopped early, and one with a pruned run dir", async () => {
    const { evalDir } = await evalOf();
    writeStopped(evalDir, {
      reason: "grader_credential",
      source: "judge",
      status: 401,
      atJob: 1,
      scenario: "csv-metrics",
      arm: "after",
      rep: 0,
    } as never);
    await refused(evalDir, /stopped early/);
    rmSync(join(evalDir, "stopped.json"));
    const line = JSON.parse(
      readFileSync(join(evalDir, "runs.jsonl"), "utf8")
        .trim()
        .split("\n")
        .find((l) => l.includes('"arm":"after"'))!,
    );
    rmSync(line.runDir.replace(/^~/, homedir()), { recursive: true, force: true });
    await refused(evalDir, /is gone/);
  });

  it("a semantic_pairwise case, and a protocol-tier case", async () => {
    const { evalDir, scen } = await evalOf();
    const file = join(scen, "csv-metrics.yaml");
    const orig = readFileSync(file, "utf8");
    writeFileSync(file, orig + "  - semantic_pairwise:\n      rubric: ['answers']\n      judge_model: claude-haiku-4-5-20251001\n");
    await refused(evalDir, /pairwise flows start from a live baseline pass/);
    writeFileSync(file, orig.replace("fidelity: container", "fidelity: protocol"));
    await refused(evalDir, /protocol tier/);
  });

  it("an existing baseline row, an existing baseline snapshot, an unknown or ambiguous arm", async () => {
    const { evalDir } = await evalOf();
    mkdirSync(join(root, "flow", "baseline"), { recursive: true });
    writeFileSync(join(root, "flow", "baseline", "errors.jsonl"), JSON.stringify({ prompt_id: "x", rep: 0 }) + "\n");
    expect((await seed(evalDir)).error?.message).toMatch(/already has rows/);
    rmSync(join(root, "flow"), { recursive: true });
    expect((await seed(evalDir, "nope")).error?.message).toMatch(/names no arm/);
    // A seeded flow's second seed: its snapshot (and rows) already exist.
    expect((await seed(evalDir)).exitCode).toBe(0);
    rmSync(join(root, "flow", "baseline", "results.jsonl"));
    const second = await seed(evalDir);
    expect(second.exitCode).toBe(2);
    expect(second.error?.message).toMatch(/already has a plugin snapshot/);
  });
});
