// `hillclimb run` orchestration, driven in-process with an injected job runner — nothing here spawns an agent.
//
// Each fake job returns the committed excerpt of a REAL kept run (test/fixtures/eval-classify/success-semantic.json)
// with the real init/result frames (test/fixtures/hillclimb-runs/result-event-pair.jsonl) and one main-loop
// assistant frame naming the excerpt's model. The scenario files hold the excerpt's own assertion list, so the
// grades line up. The wiring through the real runOneScenario is covered by the CLI wiring tests, not this one.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { runHillclimb, type JobReport, type RunnerDeps } from "../src/hillclimb/runner.js";
import { parseHillclimbRunArgs, type HillclimbRunArgs } from "../src/hillclimb/args.js";
import type { RunResult } from "../src/types.js";
import { stateTemplate } from "../src/hillclimb/state-template.js";
import { checkFlowDir } from "../src/hillclimb/schema-check.js";
import { hostPathTokens } from "../src/run/host-path-tokens.js";
import { parseScenarioFile } from "../src/run/execute.js";

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

describe("the harness gate (runner-scaffold.mjs l.238-277)", () => {
  it("no approved sha ⇒ exit 2 before any job, naming the files and the fix", async () => {
    const r = await runHillclimb(args(), deps());
    expect(r.exitCode).toBe(2);
    expect(jobs).toEqual([]);
    expect(err.join("\n")).toMatch(/no approved harness sha in .*_state\.json \(computed [0-9a-f]{12} over: .*evals\/alpha\.yaml/);
    expect(err.join("\n")).toMatch(/run once with --approve-harness/);
    // The reason the JSON envelope carries as error.message is the line stderr got.
    expect(r.error).toEqual({ category: "usage", message: expect.stringMatching(/no approved harness sha/) });
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
    expect(r.error?.message).toMatch(/harness changed since last approved run/);
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

  it("a trace write that fails after the row: row kept, no error row, counted failed, exit 1 (runner-scaffold.mjs l.541-548, 588)", async () => {
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

  it("progress and the final line use the scaffold's exact wording, with no ::warning:: prefix (runner-scaffold.mjs l.574-587)", async () => {
    await approved();
    await runHillclimb(args(), deps());
    expect(readFileSync(vfile("baseline", "progress.txt"), "utf8")).toMatch(
      /^\[baseline\] 2\/2 done \(2 ok, 0 failed\), \d+s elapsed, ~0s left\n$/,
    );
    expect(err.at(-1)).toBe("[baseline] done - 2 ok, 0 failed -> .claude/hillclimb/f/baseline/results.jsonl");
    expect(err.some((l) => l.startsWith("::"))).toBe(false);
  });

  it("a pass never writes _state.json (runner-scaffold.mjs l.12-13: loop-owned; only --approve-harness records harness_sha)", async () => {
    await approved();
    const before = readFileSync(join(flowDir(), "_state.json"));
    const mtime = statSync(join(flowDir(), "_state.json")).mtimeMs;
    await runHillclimb(args(), deps());
    expect(readFileSync(join(flowDir(), "_state.json")).equals(before)).toBe(true);
    expect(statSync(join(flowDir(), "_state.json")).mtimeMs).toBe(mtime);
  });

  it("the progress line ticks while jobs run, not only at the end", async () => {
    await approved();
    const slow = deps({
      tickMs: 20,
      runJob: async (j) => {
        await new Promise((res) => setTimeout(res, 120));
        return { result: excerpt, events, children: [], attemptS: 1, runnerTimeout: false, runDir: `/tmp/r/${j.c.id}` };
      },
    });
    await runHillclimb(args(), slow);
    const ticks = err.filter((l) => /^\[baseline\] 0\/2 done/.test(l));
    expect(ticks.length).toBeGreaterThan(0);
  });

  it("summary.json names no model when the pass saw more than one main model", async () => {
    await approved();
    // beta's main loop answered as a dated snapshot of the pin: still the pinned model, but a second id
    behave = (id) =>
      id === "beta"
        ? {
            events: [
              frames[0],
              JSON.stringify({ type: "assistant", parent_tool_use_id: null, message: { model: `${MODEL}-20260101` } }),
              frames[1],
            ],
          }
        : {};
    await runHillclimb(args(), deps());
    expect(rows("baseline")).toHaveLength(2);
    const summary = existsSync(vfile("baseline", "summary.json"))
      ? JSON.parse(readFileSync(vfile("baseline", "summary.json"), "utf8"))
      : {};
    expect(summary).not.toHaveProperty("model");
  });

  it("each case is held to ITS OWN snapshot signature; summary.json records one signature over all of them", async () => {
    await approved();
    const sigs: Record<string, string> = { alpha: "sig-a", beta: "sig-b" };
    // The excerpt's fingerprint is neither, so both reps are another snapshot's runs → error rows.
    await runHillclimb(args(), deps({ expectedContentSig: (c) => sigs[c.id] }));
    expect(rows("baseline", "errors.jsonl").map((x) => x.meta.failure_rule)).toEqual(["arm_source_drift", "arm_source_drift"]);
    const summary = JSON.parse(readFileSync(vfile("baseline", "summary.json"), "utf8"));
    expect(summary.source_sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it("files the run authored are copied into the flow and attached to the final assistant turn", async () => {
    await approved();
    const work = mkdtempSync(join(tmpdir(), "hc-run-work-"));
    try {
      mkdirSync(join(work, "outputs"), { recursive: true });
      writeFileSync(join(work, "outputs", "report.md"), `# report from ${homedir()}/x`);
      writeFileSync(join(work, "outputs", "huge.bin"), Buffer.alloc(3 * 1024 * 1024));
      // ADDED to the excerpt: a work dir and the artifacts the run recorded under it
      behave = () => ({
        result: {
          ...excerpt,
          workDir: work,
          artifacts: [
            { path: "outputs/report.md", bytes: 20 },
            { path: "outputs/huge.bin", bytes: 3 * 1024 * 1024 },
          ],
        } as RunResult,
        events: [
          ...events,
          JSON.stringify({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "done" }] } }),
        ],
      });
      await runHillclimb(args("--case", "alpha"), deps());
      const copied = readFileSync(vfile("baseline", "out/alpha_rep0/files/outputs/report.md"), "utf8");
      expect(copied).toBe("# report from ~/x"); // redacted like every other byte in the flow
      const trace = JSON.parse(readFileSync(vfile("baseline", "traces/alpha_rep0.json"), "utf8"));
      const last = trace.filter((t: { role: string }) => t.role === "assistant").at(-1);
      expect(last.attachments).toEqual([{ kind: "text", ref: "baseline/out/alpha_rep0/files/outputs/report.md" }]);
      expect(rows("baseline")[0].meta.outputs_skipped).toEqual([{ rel: "outputs/huge.bin", reason: "over the per-file cap" }]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("--ablate rows carry meta.ablated", async () => {
    await approved();
    const a = parseHillclimbRunArgs(["evals", "--flow", ".claude/hillclimb/f", "--concurrency", "2", "--ablate", "--approve-harness"]);
    if (a.help) throw new Error("help");
    await runHillclimb(a, deps());
    expect(rows("baseline").every((x) => x.meta.ablated === true)).toBe(true);
  });

  it("summary.json gets the observed model and keeps any key the loop wrote", async () => {
    await approved();
    mkdirSync(join(flowDir(), "baseline"), { recursive: true });
    writeFileSync(vfile("baseline", "summary.json"), JSON.stringify({ description: "loop" }));
    await runHillclimb(args(), deps());
    expect(JSON.parse(readFileSync(vfile("baseline", "summary.json"), "utf8"))).toEqual({ description: "loop", model: MODEL });
  });

  it("rows record whether the trace has the sub-agents' turns (meta.subagent_turns)", async () => {
    await approved();
    await runHillclimb(args(), deps());
    expect(rows("baseline").map((x) => x.meta.subagent_turns)).toEqual(["none", "none"]);
  });

  it("a secret straddling the trace cap does not leak a prefix into the trace or its sidecar", async () => {
    await approved();
    const secret = "sk-ant-runner-straddle-0123456789abcdef";
    // SYNTHETIC: a tool result just over the 64 KiB cap with the secret across the cut.
    const big = "x".repeat(64 * 1024 - 10) + secret + "y".repeat(100);
    const ev = [
      ...events,
      JSON.stringify({
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_use", id: "t9", name: "Read", input: {} }] },
      }),
      JSON.stringify({
        type: "user",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_result", tool_use_id: "t9", content: big }] },
      }),
    ];
    behave = () => ({ events: ev });
    await runHillclimb(args("--case", "alpha"), deps({ secrets: [secret] }));
    const trace = readFileSync(vfile("baseline", "traces/alpha_rep0.json"), "utf8");
    expect(trace).toContain("[truncated:");
    expect(trace).not.toContain(secret.slice(0, 8)); // only the first 10 bytes of the secret sit before the cut
    const blobs = join(flowDir(), "baseline", "out", "alpha_rep0", "blobs");
    for (const f of readdirSync(blobs)) expect(readFileSync(join(blobs, f), "utf8")).not.toContain(secret.slice(0, 8));
  });

  it("terminal escapes in model-influenced stderr text are stripped (runner-scaffold.mjs l.46-53)", async () => {
    await approved();
    behave = (id) => (id === "beta" ? { thrown: new Error("bad \x1b]0;pwned\x07title \x1b[31mred") } : {});
    await runHillclimb(args(), deps());
    const line = err.find((l) => l.includes("beta rep0 FAILED"))!;
    expect(line).not.toMatch(/\x1b/);
    expect(line).toContain("bad title red");
  });
});

describe("the written flow, end to end", () => {
  it("passes our schema reading (harness profile) with the state-template's declarations, and no byte names the host", async () => {
    await approved();
    const secret = "sk-ant-e2e-0123456789abcdefghij";
    // ADDED to the excerpt's events: a tool call whose result names the home dir, a secret and the run dir.
    const leaky = [
      ...events,
      JSON.stringify({
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file: `${homedir()}/x` } }] },
      }),
      JSON.stringify({
        type: "user",
        parent_tool_use_id: null,
        message: {
          content: [
            { type: "tool_result", tool_use_id: "t1", content: `${secret} at ${homedir()}/proj and ${homedir()}/.cowork-harness/runs/x` },
          ],
        },
      }),
    ];
    behave = () => ({ events: leaky, runDir: join(homedir(), ".cowork-harness", "runs", "s", "local_1") });
    const st = JSON.parse(readFileSync(join(flowDir(), "_state.json"), "utf8"));
    const t = stateTemplate({
      cases: [{ assertions: parseScenarioFile(join(cwd, "evals", "alpha.yaml")).assert }],
      harnessPaths: [],
      decider: false,
    });
    writeFileSync(join(flowDir(), "_state.json"), JSON.stringify({ ...st, ...t.state }));
    expect((await runHillclimb(args("--approve-harness"), deps({ secrets: [secret] }))).exitCode).toBe(0);
    const report = checkFlowDir(flowDir(), { profile: "harness" });
    expect(report.findings.filter((f) => f.level === "error")).toEqual([]);
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    for (const f of walk(flowDir())) {
      const text = readFileSync(f, "utf8");
      for (const bad of [secret, homedir(), "/Users/", `/${userInfo().username}/`]) expect(text, `${f} contains ${bad}`).not.toContain(bad);
      expect(hostPathTokens(text), f).toEqual([]);
    }
  });
});

describe("scenario metrics", () => {
  const METRIC = (better: string, id = "words") => `metrics:
  - id: ${id}
    artifact: outputs/stats.json
    path: totals.words
    better: ${better}
    unbounded: true
`;

  it("every row carries the flow's union: the value where measured, <id>_present 0 on a case that does not declare it", async () => {
    writeFileSync(join(cwd, "evals", "alpha.yaml"), SCENARIO("Alpha") + METRIC("lower"));
    await approved();
    behave = (id) => (id === "alpha" ? { result: { ...excerpt, metrics: [{ id: "words", value: 412 }] } } : {});
    expect((await runHillclimb(args("--approve-harness"), deps())).exitCode).toBe(0);
    for (const row of rows("baseline")) {
      if (row.prompt_id === "alpha") expect(row.grade).toMatchObject({ words_present: 1, words: 412 });
      else {
        expect(row.grade.words_present).toBe(0);
        expect(row.grade).not.toHaveProperty("words");
      }
    }
    // The rows read clean against the state-template's declarations for the same cases.
    const st = JSON.parse(readFileSync(join(flowDir(), "_state.json"), "utf8"));
    const t = stateTemplate({
      cases: ["alpha", "beta"].map((n) => {
        const s = parseScenarioFile(join(cwd, "evals", `${n}.yaml`));
        return { assertions: s.assert, ...(s.metrics ? { metrics: s.metrics } : {}) };
      }),
      harnessPaths: [],
      decider: false,
    });
    expect(t.state.metrics.map((m) => m.id)).toContain("words");
    writeFileSync(join(flowDir(), "_state.json"), JSON.stringify({ ...st, ...t.state }));
    expect(checkFlowDir(flowDir(), { profile: "harness" }).findings.filter((f) => f.level === "error")).toEqual([]);
  });

  it("one id declared two ways across cases refuses before spend and before any write, whatever --case selects", async () => {
    writeFileSync(join(cwd, "evals", "alpha.yaml"), SCENARIO("Alpha") + METRIC("lower"));
    writeFileSync(join(cwd, "evals", "beta.yaml"), SCENARIO("Beta") + METRIC("higher"));
    const r = await runHillclimb(args("--approve-harness", "--case", "alpha"), deps());
    expect(r.exitCode).toBe(2);
    expect(jobs).toEqual([]);
    expect(err.join("\n")).toMatch(/metric "words" is declared differently/);
    expect(existsSync(flowDir())).toBe(false);
  });

  it("a metric id that shadows a generated key is refused at load", async () => {
    writeFileSync(join(cwd, "evals", "alpha.yaml"), SCENARIO("Alpha") + METRIC("lower", "pass"));
    const r = await runHillclimb(args("--approve-harness"), deps());
    expect(r.exitCode).toBe(2);
    expect(jobs).toEqual([]);
    expect(err.join("\n")).toMatch(/metric id "pass" collides with a key the hillclimb runner generates/);
  });
});

describe("failures inside the pool", () => {
  it("a row that cannot be built is that attempt's error row; the pass goes on", async () => {
    await approved();
    // SYNTHETIC: a result whose assertions field is not a list, so the row builder throws on it.
    behave = (id) => (id === "alpha" ? { result: { ...excerpt, assertions: 5 as never, cost: { usd: 0.25 } } } : {});
    const r = await runHillclimb(args(), deps());
    expect(r).toMatchObject({ exitCode: 1, ok: 1, failed: 1 });
    expect(rows("baseline", "errors.jsonl")).toMatchObject([
      { prompt_id: "alpha", failure_class: "error", meta: { failure_rule: "row_build", cost_usd: 0.25, retries_unrecorded: true } },
    ]);
    expect(rows("baseline").map((x) => x.prompt_id)).toEqual(["beta"]);
  });

  it("a write that fails stops the pass: no further job is started, in-flight ones finish before the lock is released", async () => {
    await approved();
    writeFileSync(join(cwd, "evals", "gamma.yaml"), SCENARIO("Gamma"));
    await runHillclimb(args("--approve-harness", "--dry-run"), deps());
    // alpha plants a link where its error row must go, then fails: appending the error row is refused.
    let betaDone = false;
    const slowBeta = deps({
      runJob: async (j) => {
        jobs.push({ id: j.c.id, rep: j.rep, runLabel: j.runLabel });
        if (j.c.id === "alpha") {
          symlinkSync(join(cwd, "elsewhere"), vfile("baseline", "errors.jsonl"));
          throw new Error("boom");
        }
        await new Promise((res) => setTimeout(res, 50));
        if (j.c.id === "beta") betaDone = true;
        return { result: excerpt, events, children: [], attemptS: 1, runnerTimeout: false };
      },
    });
    const r = await runHillclimb(args(), slowBeta); // concurrency 2: alpha and beta start together
    expect(r.exitCode).toBe(1);
    expect(jobs.map((j) => j.id).sort()).toEqual(["alpha", "beta"]); // gamma never started
    expect(betaDone).toBe(true); // the in-flight job finished before runHillclimb returned
    expect(err.join("\n")).toMatch(/stopped mid-run/);
    expect(r.error).toEqual({ category: "runtime", message: expect.stringMatching(/^stopped mid-run/) });
    expect(existsSync(vfile("baseline", ".lock"))).toBe(false);
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

  it("an ABSOLUTE --flow inside a mounted folder is refused too (S supports an absolute --flow)", async () => {
    const abs = join(cwd, "mnt", "flow");
    const a = parseHillclimbRunArgs([join(cwd, "evals"), "--flow", abs, "--concurrency", "2", "--approve-harness"]);
    if (a.help) throw new Error("help");
    await refused(a, deps({ mountRoots: () => [join(cwd, "mnt")] }), /mount/);
  });

  it("a refused run records no approval: --approve-harness is honoured only once nothing refuses", async () => {
    const r = await runHillclimb(args("--approve-harness"), deps({ mountRoots: () => [cwd] }));
    expect(r.exitCode).toBe(2);
    const st = existsSync(join(flowDir(), "_state.json")) ? JSON.parse(readFileSync(join(flowDir(), "_state.json"), "utf8")) : {};
    expect(st.harness_sha).toBeUndefined();
  });

  it("a harness_paths entry inside a mounted folder is exposed too (a rubric the agent could read)", async () => {
    await approved();
    mkdirSync(join(cwd, "shared"));
    writeFileSync(join(cwd, "shared", "rubric.md"), "answers");
    const st = JSON.parse(readFileSync(join(flowDir(), "_state.json"), "utf8"));
    writeFileSync(join(flowDir(), "_state.json"), JSON.stringify({ ...st, harness_paths: ["shared/rubric.md"] }));
    await refused(args("--approve-harness"), deps({ mountRoots: () => [join(cwd, "shared")] }), /rubric\.md/);
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

describe("absolute paths", () => {
  it("an absolute --flow and an absolute scenario target run exactly like relative ones", async () => {
    const a = (...x: string[]) => {
      const p = parseHillclimbRunArgs([join(cwd, "evals"), "--flow", flowDir(), "--concurrency", "2", ...x]);
      if (p.help) throw new Error("help");
      return p;
    };
    expect((await runHillclimb(a("--approve-harness", "--dry-run"), deps())).exitCode).toBe(0);
    const r = await runHillclimb(a(), deps());
    expect(r.exitCode).toBe(0);
    expect(rows("baseline")).toHaveLength(2);
  });
});

describe("--dry-run", () => {
  it("reads the rows already written: a complete variant has nothing to run, and an error slot is named", async () => {
    await approved();
    behave = (id) => (id === "beta" ? "throw" : {});
    await runHillclimb(args(), deps());
    jobs = [];
    err = [];
    expect((await runHillclimb(args("--dry-run"), deps())).exitCode).toBe(0);
    expect(err).toContain("[baseline] 1 of 2 (id,rep) to run");
    expect(err.join("\n")).toMatch(/1 slot\(s\) re-run after a failed attempt: beta rep0/);
    expect(jobs).toEqual([]);
  });

  it("refuses a _state.json that is not an object, as the real run does", async () => {
    mkdirSync(flowDir(), { recursive: true });
    writeFileSync(join(flowDir(), "_state.json"), "[1,2]");
    expect((await runHillclimb(args("--dry-run"), deps())).exitCode).toBe(2);
  });

  it("prints the resolved scope and the gate status, runs nothing, writes nothing, exits 0", async () => {
    const r = await runHillclimb(args("--dry-run", "--reps", "3"), deps());
    expect(r.exitCode).toBe(0);
    expect(jobs).toEqual([]);
    expect(existsSync(flowDir())).toBe(false);
    expect(err).toContain("[baseline] 6 of 6 (id,rep) to run");
    expect(err.join("\n")).toMatch(/harness gate: absent/);
  });
});
