// One attempt → one results.jsonl row or one errors.jsonl row (runner-scaffold.mjs S l.509-564).
//
// Inputs. Each RunResult is a committed excerpt of a real kept run (test/fixtures/eval-classify/, provenance
// in test/eval-classify.test.ts). The event lines are real frames too: the init/result pair
// (test/fixtures/hillclimb-runs/result-event-pair.jsonl) and one main-loop assistant frame naming the
// excerpt's own model. COMPOSED, not recorded together: the excerpt and the frames come from different runs,
// so fields the excerpt lacks (modelUsage, toolCalls, apiRetries, judge usage) are added per test and
// named there.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { attemptRow, type AttemptContext } from "../src/hillclimb/rows.js";
import { UNTRUSTED_JUDGE_PREFIX } from "../src/hillclimb/schema-check.js";
import { UnansweredError, BoundaryError } from "../src/errors.js";
import type { Assertion, RunResult } from "../src/types.js";

const FX = join(import.meta.dirname, "fixtures", "eval-classify");
const fixture = (n: string): RunResult => JSON.parse(readFileSync(join(FX, `${n}.json`), "utf8")) as RunResult;
const frames = readFileSync(join(import.meta.dirname, "fixtures", "hillclimb-runs", "result-event-pair.jsonl"), "utf8")
  .trim()
  .split("\n");
const mainFrame = (model: string) => JSON.stringify({ type: "assistant", parent_tool_use_id: null, message: { model } });
const eventsFor = (model: string) => [frames[0], mainFrame(model), frames[1]];

function ctx(r: RunResult | undefined, over: Partial<AttemptContext> = {}): AttemptContext {
  const assertions = (r?.assertions ?? []).filter((a) => a.source === undefined).map((a) => a.assertion) as Assertion[];
  const model = r?.models?.find((m) => !m.startsWith("<")) ?? "claude-sonnet-5";
  return {
    caseId: "case-a",
    scenarioName: "Case A",
    prompt: "do the thing",
    assertions,
    rep: 0,
    pin: model,
    events: eventsFor(model),
    attemptS: 41.5,
    runnerTimeout: false,
    tags: ["evals"],
    meta: { flowHash: "f00d", env: { harnessVersion: "4.3.0", baselineId: "2.9939.4" }, runDir: "~/.cowork-harness/runs/x/local_1" },
    ...over,
  };
}

describe("scored rows", () => {
  it("a valid run with a graded semantic assert: pass, a<i>, a<i>_present, a<i>_c<j>, status ok, stop_reason from the result frame", () => {
    const r = fixture("success-semantic");
    const out = attemptRow({ result: r }, ctx(r));
    expect(out.dest).toBe("results");
    const row = out.row as Record<string, any>;
    expect(row).toMatchObject({
      prompt_id: "case-a",
      rep: 0,
      prompt: "do the thing",
      tags: ["evals"],
      status: "ok",
      stop_reason: "end_turn",
    });
    expect(row.grade).toEqual({ pass: 1, a3_present: 1, a0: 1, a1: 1, a2: 1, a3_c0: 1, a3_c1: 1, a3_c2: 1, a3_c3: 1, a3_c4: 1 });
    expect(row.model).toBe("claude-sonnet-5");
  });

  it("latency_s = the agent's own duration minus retry backoff; wall_s is the whole attempt", () => {
    const r = { ...fixture("success-semantic"), apiRetries: { count: 2, delayMs: 3156, subagentCount: 0, subagentDelayMs: 0 } }; // ADDED: apiRetries
    const row = attemptRow({ result: r }, ctx(r)).row as Record<string, any>;
    expect(row.latency_s).toBeCloseTo((16134 - 3156) / 1000);
    expect(row.meta).toMatchObject({ retries: 2, retry_delay_s: 3.156, wall_s: 41.5 });
  });

  it("with no result frame, latency falls back to the attempt's wall clock and says so", () => {
    const r = fixture("success-semantic");
    const row = attemptRow({ result: r }, ctx(r, { events: [frames[0], mainFrame("claude-sonnet-5")] })).row as Record<string, any>;
    expect(row.latency_s).toBe(41.5);
    expect(row.meta.latency_basis).toBe("wall");
    expect(row).not.toHaveProperty("stop_reason");
    expect(row.status).toBe("ok");
  });

  it("max_tokens on the result frame ⇒ status truncated (S l.522)", () => {
    const r = fixture("success-semantic");
    // SYNTHETIC: the real result frame with stop_reason edited to max_tokens (no kept run has one).
    const clipped = JSON.stringify({ ...JSON.parse(frames[1]), stop_reason: "max_tokens" });
    const row = attemptRow({ result: r }, ctx(r, { events: [frames[0], mainFrame("claude-sonnet-5"), clipped] })).row as Record<
      string,
      any
    >;
    expect(row).toMatchObject({ status: "truncated", stop_reason: "max_tokens" });
  });

  it("usage is the main model's modelUsage entry in snake_case; in_tokens counts cache reads and writes; cost_usd is cost.usd", () => {
    const slash = fixture("slash-success-synthetic");
    const r = { ...fixture("success-semantic"), modelUsage: slash.modelUsage, cost: { usd: 0.0933 } }; // ADDED: a real modelUsage map + cost
    const row = attemptRow({ result: r }, ctx(r)).row as Record<string, any>;
    expect(row.usage).toEqual({
      input_tokens: 10,
      output_tokens: 1306,
      cache_read_input_tokens: 82056,
      cache_creation_input_tokens: 25539,
    });
    expect(row.in_tokens).toBe(10 + 82056 + 25539);
    expect(row.out_tokens).toBe(1306);
    expect(row.cost_usd).toBe(0.0933);
    expect(row.meta.models["claude-sonnet-5"]).toMatchObject({ output_tokens: 1306, cost_usd: 0.09333870000000001 });
  });

  it("no cost recorded ⇒ cost_usd absent, never 0 (unpriced is not free)", () => {
    const r = fixture("success-semantic");
    expect(attemptRow({ result: r }, ctx(r)).row).not.toHaveProperty("cost_usd");
  });

  it("tool_calls and web_searches count every recorded tool call, all origins; absent toolCalls ⇒ both absent", () => {
    const r = {
      ...fixture("success-semantic"),
      // ADDED: four calls across origins, two of them WebSearch (one in a sub-agent), one WebFetch
      toolCalls: [
        { name: "WebSearch", origin: "main" },
        { name: "WebSearch", origin: "subagent" },
        { name: "WebFetch", origin: "unknown" },
        { name: "Read", origin: "main" },
      ],
    } as unknown as RunResult;
    const row = attemptRow({ result: r }, ctx(r)).row as Record<string, any>;
    expect(row).toMatchObject({ tool_calls: 4, web_searches: 2 });
    expect(row.meta.web_fetches).toBe(1);
    const bare = attemptRow({ result: fixture("success-semantic") }, ctx(fixture("success-semantic"))).row;
    expect(bare).not.toHaveProperty("tool_calls");
    expect(bare).not.toHaveProperty("web_searches");
  });

  it("judge rationales become prefixed explanations on the claim keys; meta flags them untrusted and lists the claims", () => {
    const base = fixture("success-semantic");
    const r = structuredClone(base);
    const sm = r.assertions[3];
    sm.semanticClaims = sm.semanticClaims!.map((c) => ({ ...c, rationale: `because ${c.index}` })); // ADDED: rationales
    sm.judgeModel = "claude-haiku-4-5-20251001"; // ADDED: judge provenance
    sm.judgeUsage = { input_tokens: 900, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const row = attemptRow({ result: r }, ctx(r)).row as Record<string, any>;
    expect(row.explanation.a3_c0).toBe(`${UNTRUSTED_JUDGE_PREFIX}because 0`);
    expect(Object.keys(row.explanation)).toEqual(["a3_c0", "a3_c1", "a3_c2", "a3_c3", "a3_c4"]);
    expect(row.meta).toMatchObject({ explanation_untrusted: true, claims: { a3_c0: "claim 1" } });
    expect(row).toMatchObject({ judge_model: "claude-haiku-4-5-20251001", judge_usage: { input_tokens: 900, output_tokens: 80 } });
  });

  it("a refused semantic grade omits its claim keys and sets a<i>_present 0 — never a fabricated 0", () => {
    const r = structuredClone(fixture("success-semantic"));
    r.assertions[3] = {
      ...r.assertions[3],
      pass: false,
      semanticClaims: undefined,
      semanticEvidence: { reason: "in_scope_truncated" },
    } as never; // ADDED: a refusal
    const row = attemptRow({ result: r }, ctx(r)).row as Record<string, any>;
    expect(row.grade).toMatchObject({ a3_present: 0 });
    for (let j = 0; j < 5; j++) expect(row.grade).not.toHaveProperty(`a3_c${j}`);
  });

  it("an agent-caused failure (stalled on a question) is SCORED: every graded key 0, the reason in meta", () => {
    const r = fixture("stalled-on-question");
    const out = attemptRow({ result: r }, ctx(r));
    expect(out.dest).toBe("results");
    const row = out.row as Record<string, any>;
    expect(
      Object.entries(row.grade)
        .filter(([k]) => !k.endsWith("_present"))
        .every(([, v]) => v === 0),
    ).toBe(true);
    expect(row.meta).toMatchObject({ failure_class: "errored_agent", termination_rule: "stalled_on_question" });
  });

  it("a thrown UnansweredError is the agent's: scored, not an error row", () => {
    const r = fixture("unanswered-partial");
    const out = attemptRow({ result: r, thrown: new UnansweredError("unanswered question", "answer it with --answer") }, ctx(r));
    expect(out.dest).toBe("results");
    expect((out.row as Record<string, any>).meta.termination_rule).toBe("thrown_unanswered");
  });

  it("meta carries the run's identity: scenario name, run dir, session id, env with the agent version, flow hash", () => {
    const r = fixture("success-semantic");
    const row = attemptRow({ result: r }, ctx(r, { originalId: "case a" })).row as Record<string, any>;
    expect(row.meta).toMatchObject({
      scenario_name: "Case A",
      original_id: "case a",
      run_dir: "~/.cowork-harness/runs/x/local_1",
      session_id: "a9997992-62b9-4795-9b94-b7fc106bce6f",
      env: { harnessVersion: "4.3.0", baselineId: "2.9939.4", agentVersion: "2.1.280" },
      flow_hash: "f00d",
    });
  });
});

describe("error rows (S l.549-564)", () => {
  const errRow = (out: ReturnType<typeof attemptRow>) => {
    expect(out.dest).toBe("errors");
    return out.row as Record<string, any>;
  };

  it("the runner's own ceiling ⇒ timeout, latency = the whole attempt", () => {
    const r = fixture("timeout");
    const row = errRow(attemptRow({ result: r }, ctx(r, { runnerTimeout: true })));
    expect(row).toMatchObject({ prompt_id: "case-a", rep: 0, failure_class: "timeout", latency_s: 41.5, retries: 0 });
    expect(typeof row.error).toBe("string");
  });

  it("the scenario's own timeout_ms (not the runner's) is the skill stalling: scored", () => {
    const r = fixture("timeout");
    expect(attemptRow({ result: r }, ctx(r)).dest).toBe("results");
  });

  it("infrastructure (auth, usage limit, a BoundaryError) ⇒ error, with the rule in meta", () => {
    for (const n of ["auth-exit", "usage-limit"]) {
      const r = fixture(n);
      expect(errRow(attemptRow({ result: r }, ctx(r))).failure_class).toBe("error");
    }
    const row = errRow(attemptRow({ thrown: new BoundaryError("egress refused") }, ctx(undefined)));
    expect(row).toMatchObject({ failure_class: "error", meta: { failure_rule: "thrown_boundary" } });
    expect(row.error).toMatch(/egress refused/);
  });

  it("anything unclassified is an error row and says so", () => {
    const row = errRow(attemptRow({ thrown: new Error("boom") }, ctx(undefined)));
    expect(row).toMatchObject({ failure_class: "error", meta: { unclassified: true, failure_rule: "thrown_other" } });
  });

  it("a main-loop model outside the pin ⇒ serving_substitution, carrying the billed model and usage", () => {
    const slash = fixture("slash-success-synthetic");
    const r = { ...fixture("success-semantic"), modelUsage: slash.modelUsage }; // ADDED: modelUsage
    const row = errRow(attemptRow({ result: r }, ctx(r, { pin: "claude-opus-5" })));
    expect(row).toMatchObject({ failure_class: "serving_substitution", model: "claude-sonnet-5", usage: { output_tokens: 1306 } });
    expect(row.error).toMatch(/served model claude-sonnet-5 != requested claude-opus-5/);
  });

  it("served-model mismatch outranks an agent error: a score from the wrong model is not the skill's", () => {
    const r = fixture("stalled-on-question");
    expect(errRow(attemptRow({ result: r }, ctx(r, { pin: "claude-opus-5" }))).failure_class).toBe("serving_substitution");
  });

  it("no model evidence on an otherwise-valid run ⇒ serving_substitution (N5); on an agent error it stays scored", () => {
    const aligned = fixture("public-scenario-aligned"); // success, no modelPinHonored
    expect(errRow(attemptRow({ result: aligned }, ctx(aligned, { events: [] }))).failure_class).toBe("serving_substitution");
    const crashed = fixture("exit-agent");
    expect(attemptRow({ result: crashed }, ctx(crashed, { events: [] })).dest).toBe("results");
  });

  it("an invalid judge grade ⇒ judge_invalid, with the run dir kept for a later regrade promotion", () => {
    const r = structuredClone(fixture("success-semantic"));
    r.assertions[3] = { ...r.assertions[3], judgeInvalid: true }; // ADDED: no kept run has one
    const row = errRow(attemptRow({ result: r }, ctx(r)));
    expect(row).toMatchObject({ failure_class: "judge_invalid", meta: { run_dir: "~/.cowork-harness/runs/x/local_1" } });
  });

  it("a rep built from a different snapshot than the variant's ⇒ error, flagged as source drift", () => {
    const r = fixture("success-semantic");
    const row = errRow(attemptRow({ result: r }, ctx(r, { expectedContentSig: "not-this-variant" })));
    expect(row).toMatchObject({ failure_class: "error", meta: { arm_source_drift: true } });
  });

  it("a grade that cannot be lined up with the scenario is never guessed: error row", () => {
    const r = fixture("success-semantic");
    const row = errRow(attemptRow({ result: r }, ctx(r, { assertions: [{ file_exists: "x" }] as unknown as Assertion[] })));
    expect(row.meta.failure_rule).toBe("grade_alignment");
  });

  it("judge_retries: unrecorded attempts say so rather than claim 0", () => {
    const r = structuredClone(fixture("success-semantic"));
    r.assertions[3].judgeModel = "claude-haiku-4-5-20251001"; // ADDED: a judged assert with no attempt count
    const row = errRow(attemptRow({ result: r }, ctx(r, { runnerTimeout: true })));
    expect(row).toMatchObject({ judge_retries: 0, meta: { judge_retries_unrecorded: true } });
  });
});
