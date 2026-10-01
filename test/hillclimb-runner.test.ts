// `hillclimb run` orchestration, driven in-process with an injected job runner — nothing here spawns an agent.
//
// Each fake job returns the committed excerpt of a REAL kept run (test/fixtures/eval-classify/success-semantic.json)
// with the real init/result frames (test/fixtures/hillclimb-runs/result-event-pair.jsonl) and one main-loop
// assistant frame naming the excerpt's model. The scenario files hold the excerpt's own assertion list, so the
// grades line up. The wiring through the real runOneScenario is H4b's stub-agent test, not this one.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHillclimb, type JobReport, type RunnerDeps } from "../src/hillclimb/runner.js";
import { parseHillclimbRunArgs, type HillclimbRunArgs } from "../src/hillclimb/args.js";
import type { RunResult } from "../src/types.js";

const FX = join(import.meta.dirname, "fixtures");
const excerpt = JSON.parse(readFileSync(join(FX, "eval-classify", "success-semantic.json"), "utf8")) as RunResult;
const frames = readFileSync(join(FX, "hillclimb-runs", "result-event-pair.jsonl"), "utf8")
  .trim()
  .split("\n");
const MODEL = "claude-sonnet-5";
const events = [frames[0], JSON.stringify({ type: "assistant", parent_tool_use_id: null, message: { model: MODEL } }), frames[1]];

const SCENARIO = (name: string) => `name: ${name}
fidelity: protocol
prompt: do the thing
assert:
  - skill_triggered: "<redacted>"
  - tool_no_error: "<redacted>"
  - max_tool_errors: 0
  - semantic_matches:
      rubric: ["claim 1", "claim 2", "claim 3", "claim 4", "claim 5"]
      min_pass: 3
      judge_model: "<redacted>"
      include_subagent_text: false
`;

let cwd: string;
let err: string[];
let jobs: Array<{ id: string; rep: number; runLabel: string }>;
let behave: (id: string, rep: number) => Partial<JobReport> | "throw";

const flowDir = () => join(cwd, ".claude/hillclimb/f");
const vfile = (v: string, f: string) => join(flowDir(), v, f);
const rows = (v: string, f = "results.jsonl") =>
  existsSync(vfile(v, f))
    ? readFileSync(vfile(v, f), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

function deps(over: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    cwd,
    secrets: [],
    stderr: (l) => err.push(l),
    virtual: { harnessVersion: "4.3.0", baselineId: "2.9939.4" },
    pin: () => MODEL,
    derivedPaths: (cases) => cases.map((c) => c.file),
    mountRoots: () => [],
    tickMs: 1_000_000,
    runJob: async (j) => {
      jobs.push({ id: j.c.id, rep: j.rep, runLabel: j.runLabel });
      const b = behave(j.c.id, j.rep);
      if (b === "throw") throw new Error("runner crashed");
      return { result: excerpt, events, children: [], attemptS: 12, runnerTimeout: false, runDir: `/tmp/runs/${j.c.id}/${j.rep}`, ...b };
    },
    ...over,
  };
}
const args = (...a: string[]): HillclimbRunArgs => {
  const p = parseHillclimbRunArgs(["evals", "--flow", ".claude/hillclimb/f", "--concurrency", "2", ...a]);
  if (p.help) throw new Error("help");
  return p;
};
const approved = async () => {
  const r = await runHillclimb(args("--approve-harness", "--dry-run"), deps());
  expect(r.exitCode).toBe(0);
};

beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "hc-run-")));
  mkdirSync(join(cwd, "evals"));
  writeFileSync(join(cwd, "evals", "alpha.yaml"), SCENARIO("Alpha"));
  writeFileSync(join(cwd, "evals", "beta.yaml"), SCENARIO("Beta"));
  err = [];
  jobs = [];
  behave = () => ({});
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("the harness gate (S l.238-277)", () => {
  it("no approved sha ⇒ exit 2 before any job, naming the files and the fix", async () => {
    const r = await runHillclimb(args(), deps());
    expect(r.exitCode).toBe(2);
    expect(jobs).toEqual([]);
    expect(err.join("\n")).toMatch(/no approved harness sha in .*_state\.json \(computed [0-9a-f]{12} over: .*evals\/alpha\.yaml/);
    expect(err.join("\n")).toMatch(/run once with --approve-harness/);
  });

  it("--approve-harness records the sha; a later edit to a scenario refuses until re-approved", async () => {
    await approved();
    expect(JSON.parse(readFileSync(join(flowDir(), "_state.json"), "utf8")).harness_sha).toMatch(/^[0-9a-f]{64}$/);
    expect((await runHillclimb(args(), deps())).exitCode).toBe(0);
    writeFileSync(join(cwd, "evals", "beta.yaml"), SCENARIO("Beta edited"));
    jobs = [];
    const r = await runHillclimb(args(), deps());
    expect(r.exitCode).toBe(2);
    expect(jobs).toEqual([]);
    expect(err.join("\n")).toMatch(/harness changed since last approved run/);
  });

  it("a --case subset computes the same sha as the full pass (a canary must not need its own approval)", async () => {
    await approved();
    expect((await runHillclimb(args("--case", "alpha"), deps())).exitCode).toBe(0);
    expect(jobs.map((j) => j.id)).toEqual(["alpha"]);
  });
});

describe("a pass", () => {
  it("runs cases × reps, writes one row and one trace per (case, rep), exits 0", async () => {
    await approved();
    const r = await runHillclimb(args("--reps", "2"), deps());
    expect(r.exitCode).toBe(0);
    expect(
      rows("baseline")
        .map((x) => `${x.prompt_id}:${x.rep}`)
        .sort(),
    ).toEqual(["alpha:0", "alpha:1", "beta:0", "beta:1"]);
    for (const id of ["alpha", "beta"])
      for (const rep of [0, 1]) expect(existsSync(vfile("baseline", `traces/${id}_rep${rep}.json`))).toBe(true);
    expect(jobs.every((j) => j.runLabel === "hillclimb:f:baseline")).toBe(true);
  });

  it("resume runs only the missing (case, rep) pairs; a complete variant runs nothing", async () => {
    await approved();
    await runHillclimb(args("--case", "alpha"), deps());
    jobs = [];
    expect((await runHillclimb(args("--reps", "2"), deps())).exitCode).toBe(0);
    expect(jobs.map((j) => `${j.id}:${j.rep}`).sort()).toEqual(["alpha:1", "beta:0", "beta:1"]);
    jobs = [];
    await runHillclimb(args("--reps", "2"), deps());
    expect(jobs).toEqual([]);
    expect(err).toContain("[baseline] 0 of 4 (id,rep) to run");
  });

  it("a failed attempt goes to errors.jsonl, never occupies its slot, exits 1 — and only that slot re-runs", async () => {
    await approved();
    behave = (id) => (id === "beta" ? "throw" : {});
    expect((await runHillclimb(args(), deps())).exitCode).toBe(1);
    expect(rows("baseline").map((x) => x.prompt_id)).toEqual(["alpha"]);
    expect(rows("baseline", "errors.jsonl")).toMatchObject([{ prompt_id: "beta", rep: 0, failure_class: "error" }]);
    behave = () => ({});
    jobs = [];
    expect((await runHillclimb(args(), deps())).exitCode).toBe(0);
    expect(jobs.map((j) => j.id)).toEqual(["beta"]);
  });

  it("a trace write that fails after the row: row kept, no error row, counted failed, exit 1 (S l.541-548, 588)", async () => {
    await approved();
    mkdirSync(join(flowDir(), "baseline", "traces"), { recursive: true });
    symlinkSync(join(cwd, "elsewhere"), vfile("baseline", "traces/alpha_rep0.json"));
    const r = await runHillclimb(args(), deps());
    expect(r.exitCode).toBe(1);
    expect(
      rows("baseline")
        .map((x) => x.prompt_id)
        .sort(),
    ).toEqual(["alpha", "beta"]);
    expect(rows("baseline", "errors.jsonl")).toEqual([]);
    expect(err.some((l) => /alpha rep0 scored, but a post-row write failed/.test(l))).toBe(true);
    expect(readFileSync(vfile("baseline", "progress.txt"), "utf8")).toMatch(/2\/2 done \(1 ok, 1 failed\)/);
  });

  it("progress and the final line use the scaffold's exact wording, with no ::warning:: prefix (S l.574-587)", async () => {
    await approved();
    await runHillclimb(args(), deps());
    expect(readFileSync(vfile("baseline", "progress.txt"), "utf8")).toMatch(
      /^\[baseline\] 2\/2 done \(2 ok, 0 failed\), \d+s elapsed, ~0s left\n$/,
    );
    expect(err.at(-1)).toBe("[baseline] done - 2 ok, 0 failed -> .claude/hillclimb/f/baseline/results.jsonl");
    expect(err.some((l) => l.startsWith("::"))).toBe(false);
  });

  it("summary.json gets the observed model and keeps any key the loop wrote", async () => {
    await approved();
    mkdirSync(join(flowDir(), "baseline"), { recursive: true });
    writeFileSync(vfile("baseline", "summary.json"), JSON.stringify({ description: "loop" }));
    await runHillclimb(args(), deps());
    expect(JSON.parse(readFileSync(vfile("baseline", "summary.json"), "utf8"))).toEqual({ description: "loop", model: MODEL });
  });

  it("terminal escapes in model-influenced stderr text are stripped (S l.46-53)", async () => {
    await approved();
    behave = (id) => (id === "beta" ? { thrown: new Error("bad \x1b]0;pwned\x07title \x1b[31mred") } : {});
    await runHillclimb(args(), deps());
    const line = err.find((l) => l.includes("beta rep0 FAILED"))!;
    expect(line).not.toMatch(/\x1b/);
    expect(line).toContain("bad title red");
  });
});

describe("refusals before spend (exit 2, no job)", () => {
  const refused = async (a: HillclimbRunArgs, d = deps(), msg?: RegExp) => {
    const r = await runHillclimb(a, d);
    expect(r.exitCode).toBe(2);
    expect(jobs).toEqual([]);
    if (msg) expect(err.join("\n")).toMatch(msg);
  };

  it("duplicate case ids", async () => {
    writeFileSync(join(cwd, "evals", "Alpha.yml"), SCENARIO("dup"));
    await refused(args("--approve-harness"), deps(), /duplicate case id/);
  });

  it("a split id that can never match a row", async () => {
    await approved();
    const st = JSON.parse(readFileSync(join(flowDir(), "_state.json"), "utf8"));
    writeFileSync(join(flowDir(), "_state.json"), JSON.stringify({ ...st, test_ids: ["case/1"] }));
    await refused(args(), deps(), /not a path-safe id/);
  });

  it("an unknown --case lists the ids", async () => {
    await approved();
    await refused(args("--case", "gamma"), deps(), /alpha \(Alpha\), beta \(Beta\)/);
  });

  it("the flow dir or a scenario inside a mounted folder: the agent could read prior grades and the rubric", async () => {
    await approved();
    await refused(args(), deps({ mountRoots: () => [join(cwd, "evals")] }), /mount/);
    await refused(args(), deps({ mountRoots: () => [cwd] }), /mount/);
  });

  it("--ablate into a flow that already holds non-ablated rows", async () => {
    await approved();
    await runHillclimb(args(), deps());
    jobs = [];
    await refused(args("--ablate", "--variant", "v1"), deps(), /--ablate/);
  });

  it("a variant another live process holds", async () => {
    await approved();
    mkdirSync(join(flowDir(), "baseline"), { recursive: true });
    writeFileSync(vfile("baseline", ".lock"), JSON.stringify({ pid: process.pid }));
    await refused(args(), deps(), /holds/);
  });
});

describe("--dry-run", () => {
  it("prints the resolved scope and the gate status, runs nothing, writes nothing, exits 0", async () => {
    const r = await runHillclimb(args("--dry-run", "--reps", "3"), deps());
    expect(r.exitCode).toBe(0);
    expect(jobs).toEqual([]);
    expect(existsSync(flowDir())).toBe(false);
    expect(err).toContain("[baseline] 6 of 6 (id,rep) to run");
    expect(err.join("\n")).toMatch(/harness gate: absent/);
  });
});
