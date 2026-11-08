// `hillclimb seed`: a flow's baseline from an eval arm. The eval runs in-process with a fake runner that keeps a real
// run dir per rep (turns/1/result.json + events.jsonl), as executeScenario lays one out; nothing spends.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { RunResult, Scenario } from "../src/types.js";
import type { SessionConfig } from "../src/session.js";
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

/** One kept run dir, as executeScenario lays it out: result.json, events.jsonl and the agent's session transcript.
 *  `served` is the model the agent was served (the pin unless a test says otherwise). */
function fakeRun(scenario: Scenario, session: SessionConfig, runId: string, served = MODEL): RunResult {
  const baseline = loadBaseline(scenario.baseline);
  const outDir = runOutDir(scenario.name, runId);
  const r = {
    ...fixture("public-scenario-pinned"),
    scenario: scenario.name,
    modelPinHonored: true,
    fidelity: "container",
    outDir,
    cost: { usd: 0.5 },
    durationMs: 7000,
    // The skill the run invoked: what the skill_invoked column reads.
    skillActivity: [{ skillId: "csv-metrics:csv-metrics" }],
    fingerprint: buildFingerprint(scenario.session, baseline.appVersion, undefined, scenario.skills, baseline, session),
  } as RunResult;
  mkdirSync(join(outDir, "turns", "1"), { recursive: true });
  writeFileSync(turnArtifactPath(outDir, 1, "result.json"), JSON.stringify(r));
  // The agent's own session transcript, where a container run keeps it: its main-loop call went out at the pinned effort.
  const projects = join(outDir, "work", "session", "mnt", ".claude", "projects", "-sessions-x");
  mkdirSync(projects, { recursive: true });
  writeFileSync(
    join(projects, `${SESSION_ID}.jsonl`),
    JSON.stringify({ type: "assistant", isSidechain: false, effort: "medium", message: { model: served } }) + "\n",
  );
  writeFileSync(
    join(outDir, "events.jsonl"),
    [frames[0], JSON.stringify({ type: "assistant", parent_tool_use_id: null, message: { model: served } }), frames[1]].join("\n"),
  );
  return r;
}

/** The eval's scenario dir (also the flow's target), and an eval of arms before/after kept on disk. */
async function evalOf(opts: { reps?: number; skill?: string; served?: (rep: number) => string } = {}) {
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
  const runJob = async (spec: EvalJobSpec): Promise<RunResult> =>
    fakeRun(spec.scenario, spec.session, spec.job.runId, opts.served?.(spec.job.rep));
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
    ...(opts.skill ? ["--skill", opts.skill] : []),
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
/** A live `hillclimb run` over the same fake runner: the oracle a seeded row is compared with. */
const liveDeps = (): RunCommandDeps => ({
  cwd: root,
  env: {},
  snapshotRoot: snaps,
  secrets: [],
  stderr: (l) => err.push(l),
  flags: {},
  isolationCheck: () => undefined,
  judgeCheck: async () => ({ lines: [] }),
  tokenCheck: () => ({ id: "token", title: "Auth token", status: "ok", detail: "found", required: true }),
  runScenario: async (a) => fakeRun(a.scenario, a.extra.session!, a.extra.runId!),
  indexRows: () => [],
});
const runArgs = (...a: string[]) => {
  const p = parseHillclimbRunArgs(["scenarios", ...a]);
  if (p.help) throw new Error("help");
  return p;
};
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

describe("hillclimb seed: the rows a live pass would write", () => {
  it("a seeded row carries the same keys as a live row (bar where it came from), the skill column included", async () => {
    const { evalDir } = await evalOf({ skill: "csv-metrics" });
    const r = await seed(evalDir);
    expect(r.exitCode, err.join("\n")).toBe(0);
    const seeded = rows("results.jsonl");
    expect(seeded).toHaveLength(4);
    for (const x of seeded) {
      expect(x.skill_invoked).toBe(1);
      expect(x.meta.skill_tracked).toBe("csv-metrics:csv-metrics");
    }
    const live = await runHillclimbCommand(
      runArgs("--flow", "flow2", "--reps", "1", "--concurrency", "1", "--skill", "csv-metrics", "--approve-harness", "--no-judge-check"),
      liveDeps(),
    );
    expect(live.exitCode, err.join("\n")).toBe(0);
    const liveRow = readFileSync(join(root, "flow2", "baseline", "results.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, any>)[0];
    expect(liveRow.skill_invoked).toBe(1);
    const keys = (o: Record<string, unknown>, drop: string[] = []) =>
      Object.keys(o)
        .filter((k) => !drop.includes(k))
        .sort();
    expect(keys(seeded[0])).toEqual(keys(liveRow));
    expect(keys(seeded[0].meta, ["seeded_from"])).toEqual(keys(liveRow.meta));
    expect(liveRow.meta.seeded_from).toBeUndefined();
  });

  it("a rep whose run dir kept no result is an errors row (the next pass re-runs it)", async () => {
    const { evalDir } = await evalOf();
    const line = JSON.parse(
      readFileSync(join(evalDir, "runs.jsonl"), "utf8")
        .trim()
        .split("\n")
        .find((l) => l.includes('"arm":"after"'))!,
    );
    rmSync(join(line.runDir.replace(/^~/, homedir()), "turns"), { recursive: true, force: true });
    const r = await seed(evalDir);
    expect(r.exitCode, err.join("\n")).toBe(0);
    expect(r).toMatchObject({ seeded: 3, errors: 1 });
    expect(rows("errors.jsonl")[0].meta.seeded_from).toMatchObject({ eval_rep: line.rep });
  });

  it("summary.json carries the requested model and effort, as a pass writes it", async () => {
    const { evalDir } = await evalOf();
    await seed(evalDir);
    expect(JSON.parse(readFileSync(join(root, "flow", "baseline", "summary.json"), "utf8"))).toMatchObject({
      model_requested: MODEL,
      effort: "medium",
    });
  });
});

describe("hillclimb seed: a failed write", () => {
  it("exits 1 and removes what it wrote: no rows, no snapshot", async () => {
    const { evalDir } = await evalOf();
    // A directory where the first rep's trace goes: that write fails, after the snapshot is installed.
    mkdirSync(join(root, "flow", "baseline", "traces", "csv-metrics_rep0.json"), { recursive: true });
    const r = await seed(evalDir);
    expect(r.exitCode, err.join("\n")).toBe(1);
    expect(r.error?.message).toMatch(/what it wrote was removed/);
    expect(rows("results.jsonl")).toEqual([]);
    expect(rows("errors.jsonl")).toEqual([]);
    expect(snapshotDirs()).toEqual([]);
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

  it("an eval that names no such scenario, or recorded another assert_sig, baseline or judge pins", async () => {
    const { evalDir } = await evalOf();
    const p = join(evalDir, "manifest.json");
    const orig = readFileSync(p, "utf8");
    const tamper = (f: (m: any) => void) => {
      const m = JSON.parse(orig);
      f(m);
      writeFileSync(p, JSON.stringify(m));
    };
    tamper((m) => (m.scenarios[0].name = "other"));
    await refused(evalDir, /has no scenario named "csv-metrics"/);
    tamper((m) => (m.scenarios[0].assertions = []));
    await refused(evalDir, /assert_sig differs/);
    tamper((m) => (m.scenarios[0].baseline = "0.0.1"));
    await refused(evalDir, /the baseline differs/);
    tamper((m) => m.pins.judge.resolved.push({ scenario: "csv-metrics", assertionIndex: 9, model: "claude-haiku-4-5-20251001" }));
    await refused(evalDir, /the judge pins differ/);
  });

  it("an eval that ran with plugins.from_host", async () => {
    const { evalDir } = await evalOf();
    const p = join(evalDir, "runs.jsonl");
    const lines = readFileSync(p, "utf8").trim().split("\n");
    const i = lines.findIndex((l) => l.includes('"arm":"after"'));
    lines[i] = JSON.stringify({ ...JSON.parse(lines[i]), hostInputs: { setHash: "a".repeat(64) } });
    writeFileSync(p, lines.join("\n") + "\n");
    await refused(evalDir, /plugins\.from_host/);
  });

  it("a baseline lock another live process holds", async () => {
    const { evalDir } = await evalOf();
    mkdirSync(join(root, "flow", "baseline"), { recursive: true });
    writeFileSync(join(root, "flow", "baseline", ".lock"), JSON.stringify({ pid: process.pid }));
    await refused(evalDir, /holds .*\.lock/);
  });

  it("an arm whose reps were served two model ids for one pin (cleaned up: nothing left)", async () => {
    const { evalDir } = await evalOf({ served: (rep) => (rep === 2 ? `${MODEL}-20261101` : MODEL) });
    await refused(evalDir, /were served .* and .*: a baseline's scores must come from one model/);
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
