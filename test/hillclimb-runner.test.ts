// `hillclimb run` orchestration, driven in-process with an injected job runner — nothing here spawns an agent.
//
// Each fake job returns the committed excerpt of a REAL kept run (test/fixtures/eval-classify/success-semantic.json)
// with the real init/result frames (test/fixtures/hillclimb-runs/result-event-pair.jsonl) and one main-loop
// assistant frame naming the excerpt's model. The scenario files hold the excerpt's own assertion list, so the
// grades line up. The wiring through the real runOneScenario is covered by the CLI wiring tests, not this one.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { InterruptedError } from "../src/termination.js";
import { ExitRequested } from "../src/run/exit.js";
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
import { createHash } from "node:crypto";
import { requestedSummary, runHillclimb, type JobReport, type RunnerDeps } from "../src/hillclimb/runner.js";
import { parseHillclimbRunArgs, type HillclimbRunArgs } from "../src/hillclimb/args.js";
import type { RunResult } from "../src/types.js";
import { stateTemplate } from "../src/hillclimb/state-template.js";
import { metricSig } from "../src/hillclimb/grade-keys.js";
import { checkFlowDir } from "../src/hillclimb/schema-check.js";
import { checkReport } from "../src/hillclimb/cli.js";
import { hostPathTokens } from "../src/run/host-path-tokens.js";
import { parseScenarioFile } from "../src/run/execute.js";

const FX = join(import.meta.dirname, "fixtures");
const excerpt = JSON.parse(readFileSync(join(FX, "eval-classify", "success-semantic.json"), "utf8")) as RunResult;
const frames = readFileSync(join(FX, "hillclimb-runs", "result-event-pair.jsonl"), "utf8")
  .trim()
  .split("\n");
const MODEL = "claude-sonnet-5";
const events = [frames[0], JSON.stringify({ type: "assistant", parent_tool_use_id: null, message: { model: MODEL } }), frames[1]];
// The agent's own session transcript: its one main-loop call went out at the requested effort.
const transcript = [JSON.stringify({ type: "assistant", isSidechain: false, effort: "medium", message: { model: MODEL } })];

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
    requestedEffort: () => ({ effort: "medium", noSelector: false }),
    credentialEnv: () => ({ CLAUDE_CODE_ENTRYPOINT: "local-agent" }),
    derivedPaths: (cases) => cases.map((c) => c.file),
    mountRoots: () => [],
    tickMs: 1_000_000,
    runJob: async (j) => {
      jobs.push({ id: j.c.id, rep: j.rep, runLabel: j.runLabel });
      const b = behave(j.c.id, j.rep);
      if (b === "throw") throw new Error("runner crashed");
      return {
        result: excerpt,
        events,
        transcript,
        children: [],
        attemptS: 12,
        runnerTimeout: false,
        runDir: `/tmp/runs/${j.c.id}/local_${j.c.id}_${j.rep}`,
        ...b,
      };
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
    expect(JSON.parse(readFileSync(vfile("baseline", "summary.json"), "utf8"))).toEqual({
      description: "loop",
      model: MODEL,
      model_requested: MODEL,
      effort: "medium",
      effort_sent: "medium",
      // the excerpt records no cost and no credential frames: counted, never $0 or guessed
      cost_rows: 0,
      cost_rows_unrecorded: 2,
      judge_rows_unpriced: 0,
      judge_rows_unrecorded: 0,
      billing_basis: "unrecorded",
      billing_rows_unrecorded: 2,
    });
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
    expect(err.join("\n")).toMatch(/metric "words" is declared differently in alpha and beta/);
    expect(existsSync(flowDir())).toBe(false);
  });

  it("one id spelled in a different case in two scenarios refuses before spend, naming both cases", async () => {
    writeFileSync(join(cwd, "evals", "alpha.yaml"), SCENARIO("Alpha") + METRIC("lower", "Score"));
    writeFileSync(join(cwd, "evals", "beta.yaml"), SCENARIO("Beta") + METRIC("lower", "score"));
    const r = await runHillclimb(args("--approve-harness"), deps());
    expect(r.exitCode).toBe(2);
    expect(jobs).toEqual([]);
    expect(err.join("\n")).toMatch(/metric "Score" \(alpha\) and metric "score" \(beta\) differ only in case/);
  });

  it("a case with `metrics: []` declares none: its rows carry the union's <id>_present 0", async () => {
    writeFileSync(join(cwd, "evals", "alpha.yaml"), SCENARIO("Alpha") + METRIC("lower"));
    writeFileSync(join(cwd, "evals", "beta.yaml"), SCENARIO("Beta") + "metrics: []\n");
    await approved();
    behave = (id) => (id === "alpha" ? { result: { ...excerpt, metrics: [{ id: "words", value: 3 }] } } : {});
    expect((await runHillclimb(args("--approve-harness"), deps())).exitCode).toBe(0);
    const beta = rows("baseline").filter((r) => r.prompt_id === "beta");
    expect(beta.length).toBeGreaterThan(0);
    for (const row of beta) {
      expect(row.grade.words_present).toBe(0);
      expect(row.grade).not.toHaveProperty("words");
    }
  });

  describe("across passes: the declaration a flow's rows were graded under (meta.metric_sigs)", () => {
    const baselineWithWords = async () => {
      writeFileSync(join(cwd, "evals", "alpha.yaml"), SCENARIO("Alpha") + METRIC("lower"));
      await approved();
      behave = (id) => (id === "alpha" ? { result: { ...excerpt, metrics: [{ id: "words", value: 412 }] } } : {});
      expect((await runHillclimb(args("--approve-harness"), deps())).exitCode).toBe(0);
      expect(rows("baseline").every((r) => typeof r.meta.metric_sigs?.words === "string")).toBe(true);
      jobs = [];
      err = [];
    };

    it("(b) CHANGING a metric's declaration is refused before spend in every later pass, naming the metric and the variant", async () => {
      await baselineWithWords();
      writeFileSync(join(cwd, "evals", "alpha.yaml"), SCENARIO("Alpha") + METRIC("higher"));
      const shaBefore = JSON.parse(readFileSync(join(flowDir(), "_state.json"), "utf8")).harness_sha;
      for (const a of [args("--variant", "v1", "--approve-harness"), args("--variant", "v1", "--dry-run"), args("--approve-harness")]) {
        err = [];
        const r = await runHillclimb(a, deps());
        expect(r.exitCode).toBe(2);
        expect(jobs).toEqual([]);
        expect(r.error?.message).toMatch(/metric "words".*baseline.*declaration changed since those rows were written/);
        expect(r.error?.message).toMatch(/start a new flow or give the changed metric a new id/);
      }
      // Refused before the gate: no approval was recorded, and v1 was never created.
      expect(JSON.parse(readFileSync(join(flowDir(), "_state.json"), "utf8")).harness_sha).toBe(shaBefore);
      expect(existsSync(join(flowDir(), "v1"))).toBe(false);
    });

    it("every variant holding a conflicting row is named", async () => {
      await baselineWithWords();
      expect((await runHillclimb(args("--variant", "v1", "--approve-harness"), deps())).exitCode).toBe(0);
      writeFileSync(join(cwd, "evals", "alpha.yaml"), SCENARIO("Alpha") + METRIC("lower").replace("totals.words", "totals.count"));
      const r = await runHillclimb(args("--variant", "v2", "--approve-harness"), deps());
      expect(r.exitCode).toBe(2);
      expect(r.error?.message).toMatch(/baseline, v1/);
    });

    it("(a) ADDING a metric mid-flow is allowed: rows with no metric_sigs predate it, and the new rows carry its sig", async () => {
      await approved();
      expect((await runHillclimb(args("--approve-harness"), deps())).exitCode).toBe(0); // rows with no metric_sigs
      expect(rows("baseline").some((r) => "metric_sigs" in r.meta)).toBe(false);
      writeFileSync(join(cwd, "evals", "alpha.yaml"), SCENARIO("Alpha") + METRIC("lower"));
      behave = (id) => (id === "alpha" ? { result: { ...excerpt, metrics: [{ id: "words", value: 7 }] } } : {});
      expect((await runHillclimb(args("--variant", "v1", "--approve-harness"), deps())).exitCode).toBe(0);
      expect(rows("v1").map((r) => r.meta.metric_sigs)).toEqual([
        { words: metricSig(parseScenarioFile(join(cwd, "evals", "alpha.yaml")).metrics![0]) },
        expect.anything(),
      ]);
      // The same declaration again is no conflict.
      expect((await runHillclimb(args("--variant", "v2", "--approve-harness"), deps())).exitCode).toBe(0);
      // With the state-template re-merged, check reads the baseline rows as predating the metric, not as errors.
      const st = JSON.parse(readFileSync(join(flowDir(), "_state.json"), "utf8"));
      const t = stateTemplate({
        cases: ["alpha", "beta"].map((n) => {
          const sc = parseScenarioFile(join(cwd, "evals", `${n}.yaml`));
          return { assertions: sc.assert, ...(sc.metrics ? { metrics: sc.metrics } : {}) };
        }),
        harnessPaths: [],
        decider: false,
      });
      writeFileSync(join(flowDir(), "_state.json"), JSON.stringify({ ...st, ...t.state }));
      const report = checkFlowDir(flowDir(), { profile: "harness" });
      expect(report.findings.filter((f) => f.level === "error")).toEqual([]);
      expect(report.findings.filter((f) => /do not carry metric/.test(f.message)).map((f) => f.message)).toEqual([
        "2 rows do not carry metric words (baseline 2): written before a row that does, so they predate it (or a re-measure listed them) — `hillclimb regrade` re-measures them; its mean covers the rows that carry it only",
      ]);
    });

    it("(a) ADDING a metric beside one the rows already carry is allowed: a row whose metric_sigs lacks the id predates it", async () => {
      await baselineWithWords();
      writeFileSync(join(cwd, "evals", "beta.yaml"), SCENARIO("Beta") + METRIC("higher", "ratio").replace("unbounded: true", "scale: 1"));
      expect((await runHillclimb(args("--variant", "v1", "--approve-harness"), deps())).exitCode).toBe(0);
      expect(rows("v1").every((r) => Object.keys(r.meta.metric_sigs).sort().join() === "ratio,words")).toBe(true);
    });

    it("(c) REMOVING a metric is allowed, with a warning that older rows keep its values and new rows will not", async () => {
      await baselineWithWords();
      writeFileSync(join(cwd, "evals", "alpha.yaml"), SCENARIO("Alpha"));
      const r = await runHillclimb(args("--variant", "v1", "--approve-harness"), deps());
      expect(r.exitCode).toBe(0);
      expect(err.join("\n")).toMatch(
        /warning: metric words is no longer declared by any scenario: the rows in baseline keep its values, but new rows will not carry it/,
      );
      // What to do with its _state.json entries, and the refusal's real scope (rows that still carry the old sig).
      expect(err.join("\n")).toMatch(/remove its entries \(words and words_present\) from _state\.json's metrics/);
      expect(err.join("\n")).toMatch(/refused while any row still carries the old declaration/);
      expect(rows("v1").some((x) => "words_present" in x.grade || "metric_sigs" in x.meta)).toBe(false);
    });

    it("(c) then re-ADDING the removed id with a different declaration is a change, refused: the old rows still carry the old sig", async () => {
      await baselineWithWords();
      writeFileSync(join(cwd, "evals", "alpha.yaml"), SCENARIO("Alpha"));
      expect((await runHillclimb(args("--variant", "v1", "--approve-harness"), deps())).exitCode).toBe(0);
      writeFileSync(join(cwd, "evals", "alpha.yaml"), SCENARIO("Alpha") + METRIC("higher"));
      const r = await runHillclimb(args("--variant", "v2", "--approve-harness"), deps());
      expect(r.exitCode).toBe(2);
      expect(r.error?.message).toMatch(/metric "words" is declared differently from the rows already in baseline:/);
    });

    it("warns, without refusing, when the rows carry a metric _state.json's metrics does not declare", async () => {
      await baselineWithWords();
      const st = JSON.parse(readFileSync(join(flowDir(), "_state.json"), "utf8"));
      writeFileSync(join(flowDir(), "_state.json"), JSON.stringify({ ...st, metrics: [{ id: "pass", kind: "binary" }] }));
      const r = await runHillclimb(args("--variant", "v1", "--approve-harness"), deps());
      expect(r.exitCode).toBe(0);
      expect(err.join("\n")).toMatch(
        /warning: rows in baseline carry metric words, which _state\.json's metrics does not declare.*state-template/,
      );
      // Declared: no warning. No `metrics` at all (kinds inferred): nothing is stale, no warning.
      for (const metrics of [[{ id: "words", kind: "float", better: "lower" }], undefined]) {
        writeFileSync(join(flowDir(), "_state.json"), JSON.stringify({ ...st, metrics }));
        err = [];
        expect((await runHillclimb(args("--variant", "v1", "--approve-harness", "--dry-run"), deps())).exitCode).toBe(0);
        expect(err.join("\n")).not.toMatch(/does not declare/);
      }
    });
  });

  it("a metric id that shadows a generated key is refused at load", async () => {
    writeFileSync(join(cwd, "evals", "alpha.yaml"), SCENARIO("Alpha") + METRIC("lower", "pass"));
    const r = await runHillclimb(args("--approve-harness"), deps());
    expect(r.exitCode).toBe(2);
    expect(jobs).toEqual([]);
    expect(err.join("\n")).toMatch(/metric id "pass" collides with a key the hillclimb runner generates/);
  });
});

describe("the cost path: per-row judge spend and billing, the variant's spend in summary.json", () => {
  // Real frames: the kept run's result-frame modelUsage (agent 2.1.280) and the credential frames of
  // account-frames.json (identity values replaced). The judge cost sits where the live judge records it.
  const resultFrame = JSON.parse(frames[1]!) as { modelUsage: Record<string, Record<string, unknown>> };
  const acct = JSON.parse(readFileSync(join(FX, "hillclimb-runs", "account-frames.json"), "utf8")) as Record<string, object>;
  const fr = (...n: string[]) => n.map((k) => JSON.stringify(acct[k]));
  const judged = (cost?: number): RunResult => ({
    ...excerpt,
    cost: { usd: 0.3 },
    modelUsage: {
      [MODEL]: { ...resultFrame.modelUsage["claude-opus-4-8"], costUSD: 0.1 },
      "claude-opus-4-8": { ...resultFrame.modelUsage["claude-opus-4-8"], costUSD: 0.2 },
    } as never,
    assertions: excerpt.assertions.map((a, i) =>
      i === 3 ? { ...a, judgeModel: "claude-haiku-5", ...(cost !== undefined ? { judgeCostUsd: cost } : {}) } : a,
    ),
  });
  const withFrames = (...extra: string[]) => [events[0]!, ...extra, ...events.slice(1)];

  it("a scored row records judge_usd, meta.billing from the agent's own frames, and provider/cost_basis per model", async () => {
    await approved();
    behave = () => ({ result: judged(0.012), events: withFrames(...fr("account_oauth", "rate_limit_five_hour")) });
    await runHillclimb(args(), deps());
    const r = rows("baseline")[0];
    expect(r.judge_usd).toBe(0.012);
    expect(r.meta).not.toHaveProperty("judge_unpriced");
    expect(r.meta.billing).toEqual({
      api_key_source: "none",
      token_source: "CLAUDE_CODE_OAUTH_TOKEN",
      provider: "firstParty",
      cost_basis: "list",
      basis: "subscription",
    });
    expect(r.meta.models["claude-opus-4-8"]).toMatchObject({ cost_usd: 0.2, provider: "firstParty", cost_basis: "list" });
    // `usage` is unchanged: the main model only.
    expect(r.usage).toEqual({ input_tokens: 10, output_tokens: 914, cache_read_input_tokens: 97850, cache_creation_input_tokens: 14427 });
  });

  it("the basis follows the spawn env's precedence keys: the same frames are api_key without them, ambiguous with local-agent", async () => {
    await approved();
    behave = () => ({ result: judged(0.01), events: withFrames(...fr("account_oauth_and_key")) });
    await runHillclimb(args(), deps({ credentialEnv: () => ({}) }));
    expect(rows("baseline").map((r) => r.meta.billing.basis)).toEqual(["api_key", "api_key"]);
    rmSync(join(flowDir(), "baseline"), { recursive: true });
    await runHillclimb(args(), deps({ credentialEnv: () => ({ CLAUDE_CODE_ENTRYPOINT: "local-agent" }) }));
    expect(rows("baseline").map((r) => r.meta.billing.basis)).toEqual(["ambiguous", "ambiguous"]);
  });

  it("a judged assert with no recorded cost is counted (meta.judge_unpriced), never $0", async () => {
    await approved();
    behave = () => ({ result: judged(undefined) });
    await runHillclimb(args(), deps());
    const r = rows("baseline")[0];
    expect(r).not.toHaveProperty("judge_usd");
    expect(r.meta.judge_unpriced).toBe(1);
    expect(r.meta).not.toHaveProperty("billing"); // no account frame: absent, never guessed
  });

  it("summary.json carries the variant's spend over results + errors, and the pass prints it", async () => {
    await approved();
    behave = (id) =>
      id === "alpha"
        ? { result: judged(0.012), events: withFrames(...fr("account_oauth", "rate_limit_five_hour")) }
        : { result: judged(0.02), events: withFrames(...fr("account_oauth")), runnerTimeout: true };
    await runHillclimb(args(), deps());
    expect(rows("baseline", "errors.jsonl")[0].meta).toMatchObject({ cost_usd: 0.3, judge_usd: 0.02, billing: { basis: "subscription" } });
    const summary = JSON.parse(readFileSync(vfile("baseline", "summary.json"), "utf8"));
    expect(summary).toMatchObject({
      cost_usd_total: expect.closeTo(0.6, 10),
      cost_rows: 2,
      cost_rows_unrecorded: 0,
      judge_usd_total: expect.closeTo(0.032, 10),
      judge_rows_unpriced: 0,
      billing_basis: "subscription",
      billing_rows_unrecorded: 0,
    });
    expect(err.join("\n")).toContain(
      "[baseline] cost (variant total; basis subscription — cost_usd is the agent's list-price estimate, not a charge): agent $0.6000 over 2 row(s)",
    );
    // before the pass's done line, which stays its last
    const at = (p: string) => err.findIndex((l) => l.startsWith(p));
    expect(at("[baseline] cost (")).toBeGreaterThan(-1);
    expect(at("[baseline] cost (")).toBeLessThan(at("[baseline] done - "));
    expect(err.at(-1)).toMatch(/^\[baseline\] done - /);
  });

  it("warns once per variant when other models carry more than 25% of its cost_usd", async () => {
    await approved();
    behave = () => ({ result: judged(0.01) });
    await runHillclimb(args(), deps());
    // claude-opus-4-8 carries 0.2 of each row's 0.3 (the main loop is claude-sonnet-5).
    expect(err.filter((l) => l.includes("models other than the main loop's carry 67%"))).toHaveLength(1);
    // `hillclimb check` repeats it as a note.
    expect(checkReport(".claude/hillclimb/f", cwd).warnings).toContainEqual(
      expect.stringContaining("note: baseline: models other than the main loop's carry 67%"),
    );
  });

  it("no row or summary.json ever holds an account's identity keys or values", async () => {
    await approved();
    // alpha is scored, beta an error row (the runner's timeout): both carry meta.billing.
    behave = (id) => ({
      result: judged(0.01),
      events: withFrames(...fr("account_login", "rate_limit_seven_day")),
      ...(id === "beta" ? { runnerTimeout: true } : {}),
    });
    await runHillclimb(args(), deps());
    // The files and the pass's own stderr.
    const written = [
      ...["results.jsonl", "errors.jsonl", "summary.json"].map((f) => readFileSync(vfile("baseline", f), "utf8")),
      ...err,
    ].join("\n");
    expect(rows("baseline")[0].meta.billing.basis).toBe("subscription");
    expect(rows("baseline", "errors.jsonl")[0].meta.billing.basis).toBe("subscription");
    for (const leak of ["subscriptionType", "organization", "email", "user@example.invalid", "Example Org", "example-plan"])
      expect(written).not.toContain(leak);
  });
});

describe("failures inside the pool", () => {
  it("a row that cannot be built is that attempt's error row; the pass goes on", async () => {
    await approved();
    // SYNTHETIC: a result whose assertions field is not a list, so the row builder throws on it.
    // Its credential frames and decider spend are still read: they do not depend on what threw.
    const acct = JSON.parse(readFileSync(join(FX, "hillclimb-runs", "account-frames.json"), "utf8")) as Record<string, object>;
    behave = (id) =>
      id === "alpha"
        ? {
            result: { ...excerpt, assertions: 5 as never, cost: { usd: 0.25 }, deciderCostUsd: 0.003 },
            events: [events[0]!, JSON.stringify(acct.account_key), ...events.slice(1)],
          }
        : {};
    const r = await runHillclimb(args(), deps({ credentialEnv: () => ({}) }));
    expect(r).toMatchObject({ exitCode: 1, ok: 1, failed: 1 });
    expect(rows("baseline", "errors.jsonl")[0].meta).toMatchObject({ decider_usd: 0.003, billing: { basis: "api_key" } });
    expect(rows("baseline", "errors.jsonl")).toMatchObject([
      {
        prompt_id: "alpha",
        failure_class: "error",
        // what the attempt asked for, as on every other error row
        meta: { failure_rule: "row_build", cost_usd: 0.25, retries_unrecorded: true, model_requested: MODEL, effort: "medium" },
      },
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

describe("requestedSummary: summary.json's requested and sent keys over the variant's whole results.jsonl", () => {
  const row = (meta: Record<string, unknown>) => JSON.stringify({ prompt_id: "a", rep: 0, meta });
  it("one value is written, several are mixed, none is absent", () => {
    expect(
      requestedSummary(
        [
          row({ effort: "high", effort_sent: "high", model_requested: "m" }),
          row({ effort: "high", effort_sent: "high", model_requested: "m" }),
        ].join("\n"),
      ),
    ).toEqual({
      model_requested: "m",
      effort: "high",
      effort_sent: "high",
      effort_selector: undefined,
    });
    expect(requestedSummary([row({ effort: "high" }), row({ effort: "low" })].join("\n")).effort).toBe("mixed");
    // a row that records the key beside one that does not (written before it existed) is mixed, not the one value
    expect(requestedSummary([row({ effort: "high", model_requested: "m" }), row({})].join("\n"))).toMatchObject({
      effort: "mixed",
      model_requested: "mixed",
    });
    expect(requestedSummary(null)).toEqual({
      model_requested: undefined,
      effort: undefined,
      effort_sent: undefined,
      effort_selector: undefined,
    });
  });
  it("effort_selector: false when every row's model has no selector, mixed when only some", () => {
    expect(requestedSummary([row({ effort: "medium", effort_selector: false })].join("\n")).effort_selector).toBe(false);
    expect(
      requestedSummary([row({ effort: "medium", effort_selector: false }), row({ effort: "medium" })].join("\n")).effort_selector,
    ).toBe("mixed");
  });
});

describe("an interrupt learned from a probe inside a job", () => {
  it("stops the whole run as interrupted, not as one failed attempt", async () => {
    await approved();
    const runJob = async () => {
      throw new InterruptedError("SIGINT", "git");
    };
    await expect(runHillclimb(args(), deps({ runJob }))).rejects.toThrow(InterruptedError);
  });
});

describe("a requested exit from inside a job (an unanswered gate)", () => {
  it("lets the in-flight sibling finish and write its row, starts nothing else, then rethrows the request with its code", async () => {
    await approved();
    let started = 0;
    const base = deps().runJob;
    const runJob: RunnerDeps["runJob"] = async (j) => {
      const n = ++started;
      if (n === 1) {
        await new Promise((r) => setTimeout(r, 20));
        throw new ExitRequested(2);
      }
      await new Promise((r) => setTimeout(r, 120)); // still running when the first job asks to exit
      return base(j);
    };
    const run = runHillclimb(args("--reps", "2"), deps({ runJob })); // 4 tasks, 2 at a time
    await expect(run).rejects.toBeInstanceOf(ExitRequested);
    await expect(run).rejects.toMatchObject({ code: 2 });
    expect(started, "a task started after the request").toBe(2);
    expect(rows("baseline"), "the in-flight sibling's row").toHaveLength(1);
  });
});

describe("a grader failure every later grade would repeat stops the pass", () => {
  const judgeFailed = (status: number, retryable?: boolean) => ({
    result: {
      ...excerpt,
      assertions: excerpt.assertions.map((a, i) =>
        i === 3
          ? {
              ...a,
              pass: false,
              judgeInvalid: true,
              judgeError: { kind: "call" as const, status, message: `API ${status}`, ...(retryable !== undefined ? { retryable } : {}) },
            }
          : a,
      ),
    } as RunResult,
  });

  it("a judge 401 on the first attempt: no task starts after the in-flight ones, exit 1, `stopped` names the slot", async () => {
    await approved();
    behave = (id, rep) => (id === "alpha" && rep === 0 ? judgeFailed(401) : {});
    const r = await runHillclimb(args("--reps", "3"), deps());
    expect(r.exitCode).toBe(1);
    expect(r.stopped).toMatchObject({ reason: "grader_credential", source: "judge", status: 401, case: "alpha", rep: 0 });
    expect(jobs.length).toBeLessThanOrEqual(2); // concurrency 2: only the attempt already running beside it
    expect(r.error?.message).toContain("the way every later grade would");
  });

  it("an LLM decider call refused (a thrown ApiExitError 403) stops it too, source decider", async () => {
    const { ApiExitError } = await import("../src/decide/llm-transport.js");
    await approved();
    const r = await runHillclimb(
      args("--reps", "3"),
      deps({
        runJob: async (j) => {
          jobs.push({ id: j.c.id, rep: j.rep, runLabel: j.runLabel });
          throw new ApiExitError("API 403", 403, "first_party", "Forbidden");
        },
      }),
    );
    expect(r.stopped).toMatchObject({ source: "decider", status: 403 });
    expect(jobs.length).toBeLessThanOrEqual(2);
  });

  it.each([
    [500, true],
    [429, true],
  ])("(control) a judge %s (retryable %s) does not stop it", async (status, retryable) => {
    await approved();
    behave = (id, rep) => (id === "alpha" && rep === 0 ? judgeFailed(status, retryable) : {});
    const r = await runHillclimb(args("--reps", "3"), deps());
    expect(r.stopped).toBeUndefined();
    expect(jobs).toHaveLength(6);
  });
});

describe("one model per pin across a variant's scored rows", () => {
  const served = (m: string) => ({
    result: { ...excerpt, models: [m], modelPinHonored: true } as RunResult,
    events: [events[0]!, JSON.stringify({ type: "assistant", parent_tool_use_id: null, message: { model: m } }), events[2]!],
    transcript: [JSON.stringify({ type: "assistant", isSidechain: false, effort: "medium", message: { model: m } })],
  });

  it("one pass served two snapshots of the pin: exit 1 after the pass, both named", async () => {
    await approved();
    behave = (id) => served(id === "alpha" ? `${MODEL}-20251001` : `${MODEL}-20251101`);
    const r = await runHillclimb(args(), deps());
    expect(r.exitCode).toBe(1);
    expect(err.join("\n")).toMatch(new RegExp(`served ${MODEL}-20251001 and ${MODEL}-20251101 \\(cases alpha, beta\\)`));
  });

  it("a later pass over rows already split is refused before any run", async () => {
    await approved();
    behave = (id) => served(id === "alpha" ? `${MODEL}-20251001` : `${MODEL}-20251101`);
    await runHillclimb(args(), deps());
    jobs = [];
    const r = await runHillclimb(args("--reps", "2"), deps());
    expect(r.exitCode).toBe(2);
    expect(jobs).toHaveLength(0);
    expect(r.error?.message).toContain("its scores come from more than one model");
  });

  it("--allow-model-split: the split pass exits 0 with a warning, a later pass runs, and its rows record the flag", async () => {
    await approved();
    behave = (id) => served(id === "alpha" ? `${MODEL}-20251001` : `${MODEL}-20251101`);
    const first = await runHillclimb(args("--allow-model-split"), deps());
    expect(first.exitCode).toBe(0);
    expect(err.join("\n")).toContain("allowed (--allow-model-split)");
    const r = await runHillclimb(args("--reps", "2", "--allow-model-split"), deps());
    expect(r.exitCode).toBe(0);
    expect(rows("baseline").every((x: { meta: Record<string, unknown> }) => x.meta.model_split_allowed === true)).toBe(true);
  });

  it("(control) one snapshot on every row is fine", async () => {
    await approved();
    behave = () => served(`${MODEL}-20251001`);
    const r = await runHillclimb(args(), deps());
    expect(r.exitCode).toBe(0);
  });
});

describe("--gate-cmd: the gate runs once, before any rep", () => {
  const snap = () => {
    const d = join(cwd, "snap");
    mkdirSync(d, { recursive: true });
    return d;
  };
  const gate = (o: Partial<import("../src/hillclimb/gate-cmd.js").GateResult>, calls: unknown[] = []) =>
    (async (x: unknown) => {
      calls.push(x);
      return { ok: false, code: 3, signal: null, timedOut: false, tail: "tests failed\n", wallS: 0.4, ...o };
    }) as import("../src/hillclimb/gate-cmd.js").GateRunner;

  it("a failing gate ⇒ no job, one gate_failed row per open slot ($0), exit 1, and `hillclimb check` reports nothing", async () => {
    const calls: unknown[] = [];
    await runHillclimb(args("--approve-harness", "--dry-run", "--gate-cmd", "npm test"), deps());
    const r = await runHillclimb(args("--gate-cmd", "npm test", "--reps", "2"), deps({ gateSnapshot: snap(), runGate: gate({}, calls) }));
    expect(jobs).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ cmd: "npm test", snapshot: join(cwd, "snap"), variant: "baseline", timeoutS: 600 });
    expect(r).toMatchObject({ exitCode: 1, scheduled: 4, ok: 0, failed: 4 });
    const errs = rows("baseline", "errors.jsonl");
    expect(errs).toHaveLength(4);
    for (const e of errs)
      expect(e).toMatchObject({
        failure_class: "gate_failed",
        error: "the gate command exited 3; no rep of this variant ran",
        retries: 0,
        judge_retries: 0,
        latency_s: 0.4,
        meta: { cost_usd: 0, gate_exit: 3, gate_tail: "tests failed\n" },
      });
    const summary = JSON.parse(readFileSync(vfile("baseline", "summary.json"), "utf8"));
    expect(summary.cost_rows_unrecorded).toBe(0);
    // No rep ran: the gate rows are not cost rows at all.
    expect(summary.cost_rows ?? 0).toBe(0);
    const report = checkFlowDir(flowDir(), { profile: "harness" });
    // `check` has no error, warning or note on the gate rows (the flow-wide findings — no results.jsonl yet, no
    // declared metrics — are not about them).
    expect(report.findings.filter((f) => /errors\.jsonl/.test(f.file ?? ""))).toEqual([]);
    expect(report.findings.some((f) => f.file === "baseline/results.jsonl")).toBe(true);
  });

  it("the gate's tail is scrubbed with the run's secrets; a timeout records gate_timed_out", async () => {
    await runHillclimb(args("--approve-harness", "--dry-run", "--gate-cmd", "x"), deps());
    await runHillclimb(
      args("--gate-cmd", "x", "--reps", "1"),
      deps({
        secrets: ["s3cr3t-value-123"],
        gateSnapshot: snap(),
        runGate: gate({ code: null, signal: "SIGKILL", timedOut: true, tail: "token s3cr3t-value-123\n" }),
      }),
    );
    const e = rows("baseline", "errors.jsonl")[0];
    expect(e.meta).toMatchObject({ gate_timed_out: true, gate_signal: "SIGKILL" });
    expect(JSON.stringify(e)).not.toContain("s3cr3t-value-123");
    expect(e.error).toMatch(/timed out after 600s/);
  });

  it("a passing gate ⇒ the reps run; a dry run and a pass with no open slot never run it", async () => {
    const calls: unknown[] = [];
    await runHillclimb(args("--approve-harness", "--dry-run", "--gate-cmd", "x"), deps());
    await runHillclimb(args("--gate-cmd", "x", "--dry-run"), deps({ gateSnapshot: snap(), runGate: gate({ ok: true, code: 0 }, calls) }));
    expect(calls).toHaveLength(0);
    const r = await runHillclimb(
      args("--gate-cmd", "x", "--reps", "1"),
      deps({ gateSnapshot: snap(), runGate: gate({ ok: true, code: 0 }, calls) }),
    );
    expect(r.exitCode).toBe(0);
    expect(jobs).toHaveLength(2);
    expect(err.join("\n")).toMatch(/\[baseline\] gate command passed \(0\.4s\)/);
    await runHillclimb(args("--gate-cmd", "x", "--reps", "1"), deps({ gateSnapshot: snap(), runGate: gate({ ok: true, code: 0 }, calls) }));
    expect(calls).toHaveLength(1);
  });

  it("a gate fixed after a failure: the next pass runs the gate_failed slots", async () => {
    await runHillclimb(args("--approve-harness", "--dry-run", "--gate-cmd", "x"), deps());
    await runHillclimb(args("--gate-cmd", "x", "--reps", "1"), deps({ gateSnapshot: snap(), runGate: gate({}) }));
    expect(jobs).toEqual([]);
    const r = await runHillclimb(
      args("--gate-cmd", "x", "--reps", "1"),
      deps({ gateSnapshot: snap(), runGate: gate({ ok: true, code: 0 }) }),
    );
    expect(r.exitCode).toBe(0);
    expect(jobs).toHaveLength(2);
  });
});

describe("--max-budget-usd: a per-pass cap checked before each slot", () => {
  /** `args` without its default --concurrency 2 (each test names its own). */
  const bargs = (...a: string[]): HillclimbRunArgs => {
    const p = parseHillclimbRunArgs(["evals", "--flow", ".claude/hillclimb/f", ...a]);
    if (p.help) throw new Error("help");
    return p;
  };
  const priced = (usd: number) => () => ({ result: { ...excerpt, cost: { usd } } as RunResult });
  /** One scored $1 row per case: the variant's own history. */
  const seed = async () => {
    await approved();
    behave = priced(1);
    expect((await runHillclimb(args("--reps", "1"), deps())).exitCode).toBe(0);
    jobs = [];
  };

  it("stops before the slot that would cross: exit 1, stopped.reason budget, error.code budget_stopped, summary.json written", async () => {
    await seed();
    const r = await runHillclimb(bargs("--reps", "4", "--concurrency", "1", "--max-budget-usd", "2.5"), deps());
    expect(jobs).toHaveLength(2);
    expect(r.exitCode).toBe(1);
    expect(r.error).toMatchObject({ category: "runtime", code: "budget_stopped" });
    expect(r.error?.message).toMatch(/the cap is per pass: raise it, or re-run \(each pass has its own cap\)/);
    expect(r.error?.message).not.toMatch(/re-run to resume/);
    expect(r.stopped).toEqual({ reason: "budget", spentUsd: 2, capUsd: 2.5, atJob: 2, case: "alpha", rep: 3 });
    const summary = JSON.parse(readFileSync(vfile("baseline", "summary.json"), "utf8"));
    expect(summary.cost_rows).toBe(4);
  });

  it("an unpriced finished slot is charged its estimate: three no-cost failures and a $1 history stop before the fourth at $3.50", async () => {
    await seed();
    behave = () => "throw";
    const r = await runHillclimb(bargs("--reps", "5", "--concurrency", "1", "--max-budget-usd", "3.5"), deps());
    expect(jobs).toHaveLength(3);
    expect(r.stopped).toMatchObject({ reason: "budget", spentUsd: 3, atJob: 3 });
    expect(r.error?.message).toMatch(/unpriced 3/);
  });

  it("in-flight slots are reserved: --concurrency 4 with a cap of 1.5 slots starts exactly one", async () => {
    await seed();
    const r = await runHillclimb(bargs("--reps", "4", "--concurrency", "4", "--max-budget-usd", "1.5"), deps());
    expect(jobs).toHaveLength(1);
    expect(r.stopped).toMatchObject({ reason: "budget", atJob: 1 });
  });

  it("the grader probe's cost is the pass's starting spend", async () => {
    await seed();
    const r = await runHillclimb(args("--reps", "2", "--max-budget-usd", "1.5"), deps({ budgetStartUsd: 1 }));
    expect(jobs).toHaveLength(0);
    expect(r.stopped).toMatchObject({ reason: "budget", spentUsd: 1, atJob: 0 });
  });

  it("no history: estimated $0 (said once), and the cap is checked on what a slot spent — decider spend counted", async () => {
    await approved();
    behave = () => ({ result: { ...excerpt, deciderCostUsd: 3 } as RunResult });
    const r = await runHillclimb(bargs("--reps", "2", "--concurrency", "1", "--max-budget-usd", "2"), deps());
    expect(jobs).toHaveLength(1);
    expect(r.stopped).toMatchObject({ reason: "budget", spentUsd: 3, atJob: 1 });
    expect(err.filter((l) => /alpha has no cost history/.test(l))).toHaveLength(1);
  });

  it("no history at --concurrency 2: unestimated slots run one at a time, so the cap is passed by one slot at most", async () => {
    await approved();
    behave = priced(3);
    const r = await runHillclimb(bargs("--reps", "2", "--concurrency", "2", "--max-budget-usd", "2"), deps());
    // alpha rep0 starts at $0; alpha rep1 (also $0) waits for it, is then estimated at $3, and is stopped.
    expect(jobs).toHaveLength(1);
    expect(r.stopped).toMatchObject({ reason: "budget", spentUsd: 3, atJob: 1, case: "alpha", rep: 1 });
  });

  it("the index fallback prices a case with no rows in the variant", async () => {
    await approved();
    behave = priced(1);
    const r = await runHillclimb(
      bargs("--reps", "2", "--concurrency", "1", "--max-budget-usd", "3"),
      deps({ budgetIndexWorstUsd: () => 2 }),
    );
    // Case-major order. alpha rep0: est 2 (index) → spent 1; alpha rep1: est 1 (its own p95 now) → 1+1 ≤ 3, spent 2;
    // beta rep0: est 2 (index) → 2+2 > 3: stopped.
    expect(jobs).toHaveLength(2);
    expect(r.stopped).toMatchObject({ reason: "budget", spentUsd: 2, case: "beta", rep: 0 });
  });

  it("(control) no flag: no budget line and no stop; a grader stop keeps its own shape", async () => {
    await seed();
    const r = await runHillclimb(args("--reps", "2"), deps());
    expect(r.stopped).toBeUndefined();
    expect(err.join("\n")).not.toMatch(/budget/);
  });
});

describe("--gate-cmd in the harness sha: its hash, never its text", () => {
  const h = (s: string) => createHash("sha256").update(s).digest("hex");
  const CMD = "npm test -- --token-free-but-distinctive-7f3a";
  const state = () => JSON.parse(readFileSync(join(flowDir(), "_state.json"), "utf8"));

  it("approval records harness_gate_sha and the <gate-cmd> entry, prints the command, and never writes its text", async () => {
    const r = await runHillclimb(args("--approve-harness", "--dry-run", "--gate-cmd", CMD), deps());
    expect(r.exitCode).toBe(0);
    const st = state();
    expect(st.harness_gate_sha).toBe(h(CMD));
    expect(st.harness_files["<gate-cmd>"]).toBe(h(h(CMD)));
    expect(readFileSync(join(flowDir(), "_state.json"), "utf8")).not.toContain("distinctive-7f3a");
    expect(err.join("\n")).toContain(`gate command (runs on this host before the variant's reps): ${CMD}`);
  });

  it("the sha moves with the command and with its removal; the refusal names which", async () => {
    await runHillclimb(args("--approve-harness", "--dry-run", "--gate-cmd", CMD), deps());
    const sha = state().harness_sha;
    let r = await runHillclimb(args("--gate-cmd", `${CMD} x`), deps());
    expect(r.exitCode).toBe(2);
    expect(r.error?.message).toMatch(/harness changed since last approved run: --gate-cmd changed;/);
    r = await runHillclimb(args(), deps());
    expect(r.error?.message).toMatch(/--gate-cmd removed/);
    await approved();
    expect(state().harness_sha).not.toBe(sha);
    expect(state().harness_gate_sha).toBeUndefined();
    r = await runHillclimb(args("--gate-cmd", CMD), deps());
    expect(r.error?.message).toMatch(/--gate-cmd added/);
  });

  it("--gate-timeout without --gate-cmd is a usage error", () => {
    expect(() => args("--gate-timeout", "5")).toThrow(/--gate-timeout.*--gate-cmd/);
  });
});
