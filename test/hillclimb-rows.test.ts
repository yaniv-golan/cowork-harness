// One attempt → one results.jsonl row or one errors.jsonl row (runner-scaffold.mjs runner-scaffold.mjs l.509-564).
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
import { metricSig } from "../src/hillclimb/grade-keys.js";
import { UNTRUSTED_JUDGE_PREFIX } from "../src/hillclimb/schema-check.js";
import { UnansweredError, BoundaryError } from "../src/errors.js";
import type { Assertion, RunResult, ScenarioMetric } from "../src/types.js";

const FX = join(import.meta.dirname, "fixtures", "eval-classify");
const fixture = (n: string): RunResult => JSON.parse(readFileSync(join(FX, `${n}.json`), "utf8")) as RunResult;
const frames = readFileSync(join(import.meta.dirname, "fixtures", "hillclimb-runs", "result-event-pair.jsonl"), "utf8")
  .trim()
  .split("\n");
const mainFrame = (model: string) => JSON.stringify({ type: "assistant", parent_tool_use_id: null, message: { model } });
const eventsFor = (model: string) => [frames[0], mainFrame(model), frames[1]];

const words: ScenarioMetric = { id: "words", artifact: "outputs/stats.json", path: "words", better: "lower", unbounded: true };
const ratio: ScenarioMetric = { id: "ratio", artifact: "outputs/stats.json", path: "ratio", better: "higher", scale: 1 };

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
    expect(row.grade).toEqual({
      pass: 1,
      pass_present: 1,
      claims_present: 1,
      a3_present: 1,
      claims: 1,
      a0: 1,
      a1: 1,
      a2: 1,
      a3_c0: 1,
      a3_c1: 1,
      a3_c2: 1,
      a3_c3: 1,
      a3_c4: 1,
    });
    expect(Object.keys(row.grade).slice(0, 5)).toEqual(["pass", "pass_present", "claims_present", "a3_present", "claims"]);
    expect(row.model).toBe("claude-sonnet-5");
  });

  it("latency_s = the agent's own duration minus retry backoff; wall_s is the whole attempt", () => {
    const r = { ...fixture("success-semantic"), apiRetries: { count: 2, delayMs: 3156, subagentCount: 0, subagentDelayMs: 0 } }; // ADDED: apiRetries
    const row = attemptRow({ result: r }, ctx(r)).row as Record<string, any>;
    expect(row.latency_s).toBeCloseTo((16134 - 3156) / 1000);
    expect(row.meta).toMatchObject({ retries: 2, retry_delay_s: 3.156, wall_s: 41.5 });
    expect(row.meta).not.toHaveProperty("retries_unrecorded");
  });

  it("with no result frame, latency falls back to the attempt's wall clock and says so", () => {
    const r = fixture("success-semantic");
    const row = attemptRow({ result: r }, ctx(r, { events: [frames[0], mainFrame("claude-sonnet-5")] })).row as Record<string, any>;
    expect(row.latency_s).toBe(41.5);
    expect(row.meta.latency_basis).toBe("wall");
    expect(row).not.toHaveProperty("stop_reason");
    expect(row.status).toBe("ok");
  });

  it("max_tokens on the result frame ⇒ status truncated (runner-scaffold.mjs l.522)", () => {
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

  it("a [1m] context-window key in modelUsage is the same model: usage is found, not dropped", () => {
    // From a real kept run (numbers only): the main loop reported claude-opus-5; modelUsage keyed claude-opus-5[1m].
    const r = {
      ...fixture("success-semantic"),
      models: ["claude-opus-5"],
      modelUsage: {
        "claude-opus-5[1m]": {
          inputTokens: 2,
          outputTokens: 4,
          cacheReadInputTokens: 17216,
          cacheCreationInputTokens: 33648,
          costUSD: 0.345198,
        },
      },
      cost: { usd: 0.345198 },
    } as unknown as RunResult;
    const row = attemptRow({ result: r }, ctx(r, { pin: "claude-opus-5" })).row as Record<string, any>;
    expect(row.usage).toEqual({ input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 17216, cache_creation_input_tokens: 33648 });
    expect(row.in_tokens).toBe(2 + 17216 + 33648);
  });

  it("never RunResult.usage (the last call only): the row's usage differs from it on the same result", () => {
    const slash = fixture("slash-success-synthetic");
    // ADDED: a last-call usage that disagrees with the session's modelUsage, as on real runs
    const r = {
      ...fixture("success-semantic"),
      modelUsage: slash.modelUsage,
      usage: { input_tokens: 88, output_tokens: 7 },
    } as unknown as RunResult;
    const row = attemptRow({ result: r }, ctx(r)).row as Record<string, any>;
    expect(row.usage.output_tokens).toBe(1306);
  });

  it("a usage field the agent did not report is left out, never written as 0", () => {
    // ADDED: an entry without cache counters
    const r = {
      ...fixture("success-semantic"),
      modelUsage: { "claude-sonnet-5": { inputTokens: 5, outputTokens: 9 } },
    } as unknown as RunResult;
    const row = attemptRow({ result: r }, ctx(r)).row as Record<string, any>;
    expect(row.usage).toEqual({ input_tokens: 5, output_tokens: 9 });
    expect(row.in_tokens).toBe(5);
  });

  it("perf and meta extras: skill_invoked 1/0/absent, decider_usd from the decider's cost, meta.ablated", () => {
    const r = { ...fixture("success-semantic"), deciderCostUsd: 0.012 } as unknown as RunResult; // ADDED: decider cost
    const yes = attemptRow({ result: r }, ctx(r, { skillInvoked: true, meta: { ...ctx(r).meta, ablated: true } })).row as Record<
      string,
      any
    >;
    expect(yes).toMatchObject({ skill_invoked: 1, decider_usd: 0.012, meta: { ablated: true } });
    expect((attemptRow({ result: r }, ctx(r, { skillInvoked: false })).row as Record<string, any>).skill_invoked).toBe(0);
    expect(attemptRow({ result: r }, ctx(r)).row).not.toHaveProperty("skill_invoked");
  });

  it("a run answered through the LLM decider is flagged non-deterministic", () => {
    const r = fixture("success-semantic");
    const row = attemptRow({ result: r }, ctx(r, { meta: { ...ctx(r).meta, nonDeterministic: true } })).row as Record<string, any>;
    expect(row.meta.non_deterministic).toBe(true);
    expect((attemptRow({ result: r }, ctx(r)).row as Record<string, any>).meta).not.toHaveProperty("non_deterministic");
  });

  it("an agent-caused failure carries no judge explanation, even when rationales were recorded", () => {
    const r = structuredClone(fixture("success-semantic"));
    // ADDED: the run stalled (an agent failure) after its claims were graded with rationales
    (r as unknown as Record<string, unknown>).stalledOnQuestion = true;
    r.assertions[3].semanticClaims = r.assertions[3].semanticClaims!.map((c) => ({ ...c, rationale: "why" }));
    const row = attemptRow({ result: r }, ctx(r)).row as Record<string, any>;
    expect(row.meta.failure_class).toBe("errored_agent");
    expect(row).not.toHaveProperty("explanation");
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
    expect(Object.keys(row.explanation)).toEqual(["claims", "a3_c0", "a3_c1", "a3_c2", "a3_c3", "a3_c4"]);
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
    expect(row.grade).toMatchObject({ a3_present: 0, claims_present: 0, pass_present: 0 });
    // the verdict failed ONLY because the grade was refused: the headline is not measured
    expect(row.grade).not.toHaveProperty("pass");
    for (let j = 0; j < 5; j++) expect(row.grade).not.toHaveProperty(`a3_c${j}`);
    expect(row.grade).not.toHaveProperty("claims");
  });

  it("a refusal beside a REAL failure still scores pass 0 — only a refusal-only fail is unmeasured", () => {
    const r = structuredClone(fixture("success-semantic"));
    // ADDED: the refusal, and a genuinely failed non-semantic assertion
    r.assertions[3] = {
      ...r.assertions[3],
      pass: false,
      semanticClaims: undefined,
      semanticEvidence: { reason: "in_scope_truncated" },
    } as never;
    r.assertions[0] = { ...r.assertions[0], pass: false };
    const row = attemptRow({ result: r }, ctx(r)).row as Record<string, any>;
    expect(row.grade).toMatchObject({ pass: 0, pass_present: 1 });
  });

  it("a MULTI-key semantic assertion whose evidence was refused: a<i>_present is 0, as for a single key", () => {
    const r = structuredClone(fixture("success-semantic"));
    // ADDED: a second key on the semantic assertion, and a refusal of its evidence
    const both = { ...r.assertions[3].assertion, max_tool_errors: 0 } as Assertion;
    r.assertions[3] = {
      ...r.assertions[3],
      assertion: both,
      pass: false,
      semanticClaims: undefined,
      semanticEvidence: { reason: "in_scope_truncated" },
    } as never;
    const assertions = r.assertions.map((a) => a.assertion) as Assertion[];
    const row = attemptRow({ result: r }, ctx(r, { assertions })).row as Record<string, any>;
    expect(row.grade.a3_present).toBe(0);
    // Its other key's outcome is unknowable from the one grade, so a failure is NOT hidden as "unmeasured":
    // only a single-key semantic refusal leaves pass unmeasured (the shared classifier's rule).
    expect(row.grade).toMatchObject({ pass: 0, pass_present: 1 });
    for (let j = 0; j < 5; j++) expect(row.grade).not.toHaveProperty(`a3_c${j}`);
  });

  it("claims pools graded claims: 3 of 5 passed ⇒ 0.6; explanation.claims names the failed claims first", () => {
    const r = structuredClone(fixture("success-semantic"));
    // ADDED: two failing claims and a rationale per claim
    r.assertions[3].semanticClaims = r.assertions[3].semanticClaims!.map((c) => ({ ...c, pass: c.index > 1, rationale: `why ${c.index}` }));
    const row = attemptRow({ result: r }, ctx(r)).row as Record<string, any>;
    expect(row.grade.claims).toBeCloseTo(0.6);
    expect(row.explanation.claims).toBe(
      `${UNTRUSTED_JUDGE_PREFIX}2/5 claims failed. FAILED a3_c0: claim 1 — why 0 | FAILED a3_c1: claim 2 — why 1 | passed a3_c2: claim 3 — why 2 | passed a3_c3: claim 4 — why 3 | passed a3_c4: claim 5 — why 4`,
    );
  });

  it("a case with no semantic assert carries claims_present 0 and no claims", () => {
    const r = fixture("public-scenario-pinned");
    const row = attemptRow({ result: r }, ctx(r)).row as Record<string, any>;
    expect(row.grade.claims_present).toBe(0);
    expect(row.grade).not.toHaveProperty("claims");
  });

  it("a flow metric this case does not produce is carried as <id>_present 0, never as a value", () => {
    const r = fixture("success-semantic");
    const row = attemptRow({ result: r }, ctx(r, { metrics: [words] })).row as Record<string, any>;
    expect(row.grade.words_present).toBe(0);
    expect(row.grade).not.toHaveProperty("words");
    expect(row.meta).not.toHaveProperty("metrics_unavailable");
  });

  it("a measured metric is its value (a 0 included) with <id>_present 1, after the graded keys, in declaration order", () => {
    const r = {
      ...fixture("success-semantic"),
      metrics: [
        { id: "ratio", value: 0 },
        { id: "words", value: 412 },
      ],
    }; // ADDED: metrics
    const row = attemptRow({ result: r }, ctx(r, { metrics: [words, ratio] })).row as Record<string, any>;
    expect(row.grade).toMatchObject({ words_present: 1, ratio_present: 1, words: 412, ratio: 0 });
    const keys = Object.keys(row.grade);
    expect(keys.slice(-2)).toEqual(["words", "ratio"]);
    expect(keys.indexOf("words_present")).toBe(keys.indexOf("claims_present") + 1);
    expect(row.meta).not.toHaveProperty("metrics_unavailable");
  });

  it("an unavailable metric is OMITTED, never 0: <id>_present 0 and the reason in meta.metrics_unavailable", () => {
    const r = {
      ...fixture("success-semantic"),
      metrics: [
        { id: "words", unavailable: "pre_run" as const },
        { id: "ratio", value: 0.5 },
      ],
    }; // ADDED: metrics
    const row = attemptRow({ result: r }, ctx(r, { metrics: [words, ratio] })).row as Record<string, any>;
    expect(row.grade.words_present).toBe(0);
    expect(row.grade).not.toHaveProperty("words");
    expect(row.grade.ratio).toBe(0.5);
    expect(row.meta.metrics_unavailable).toEqual({ words: "pre_run" });
  });

  it("an agent-caused failure omits every float, even a measured one: <id>_present 0", () => {
    const r = { ...fixture("stalled-on-question"), metrics: [{ id: "words", value: 9 }] }; // ADDED: metrics
    const row = attemptRow({ result: r }, ctx(r, { metrics: [words] })).row as Record<string, any>;
    expect(row.meta.failure_class).toBe("errored_agent");
    expect(row.grade.words_present).toBe(0);
    expect(row.grade).not.toHaveProperty("words");
  });

  it("every scored row stamps the flow's metric declarations as meta.metric_sigs, measured or not", () => {
    const r = { ...fixture("success-semantic"), metrics: [{ id: "ratio", value: 0.5 }] }; // ADDED: metrics
    const row = attemptRow({ result: r }, ctx(r, { metrics: [words, ratio] })).row as Record<string, any>;
    expect(row.meta.metric_sigs).toEqual({ words: metricSig(words), ratio: metricSig(ratio) });
    // An agent-caused failure is a scored row too: its sigs are stamped like any other.
    const failed = fixture("stalled-on-question");
    expect((attemptRow({ result: failed }, ctx(failed, { metrics: [words] })).row as Record<string, any>).meta.metric_sigs).toEqual({
      words: metricSig(words),
    });
  });

  it("a flow with no metrics stamps no meta.metric_sigs", () => {
    const r = fixture("success-semantic");
    expect((attemptRow({ result: r }, ctx(r)).row as Record<string, any>).meta).not.toHaveProperty("metric_sigs");
    expect((attemptRow({ result: r }, ctx(r, { metrics: [] })).row as Record<string, any>).meta).not.toHaveProperty("metric_sigs");
  });

  it("a metric never carries an explanation, beside a judge's rationale that does", () => {
    const base = fixture("success-semantic");
    const r = {
      ...base,
      assertions: base.assertions.map((g) =>
        g.semanticClaims ? { ...g, semanticClaims: g.semanticClaims.map((c) => ({ ...c, rationale: "why" })) } : g,
      ),
      metrics: [{ id: "words", value: 3 }],
    }; // ADDED: rationales, metrics
    const row = attemptRow({ result: r }, ctx(r, { metrics: [words] })).row as Record<string, any>;
    expect(Object.keys(row.explanation).length).toBeGreaterThan(0);
    expect(row.explanation).not.toHaveProperty("words");
    expect(row.explanation).not.toHaveProperty("words_present");
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
      run_id: "local_1",
    });
  });
});

describe("error rows (runner-scaffold.mjs l.549-564)", () => {
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

  it("no model evidence on an otherwise-valid run ⇒ serving_substitution; on an agent error it stays scored", () => {
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

  it("error rows keep what the spend analysis needs: run_id and the per-model breakdown", () => {
    const slash = fixture("slash-success-synthetic");
    const r = { ...fixture("timeout"), modelUsage: slash.modelUsage }; // ADDED: modelUsage
    const row = errRow(attemptRow({ result: r }, ctx(r, { runnerTimeout: true })));
    expect(row.meta).toMatchObject({ run_id: "local_1", models: { "claude-sonnet-5": { output_tokens: 1306 } } });
  });

  it("retries: no retry evidence (apiRetries absent) is said, not written as 0 on a scored row", () => {
    const r = fixture("success-semantic"); // the excerpt has no apiRetries
    const row = attemptRow({ result: r }, ctx(r)).row as Record<string, any>;
    expect(row.meta).not.toHaveProperty("retries");
    expect(row.meta.retries_unrecorded).toBe(true);
  });

  it("an invalid-judge error row keeps the judge's spend (judge_model, judge_usage) for the later promotion", () => {
    const r = structuredClone(fixture("success-semantic"));
    // ADDED: an invalid grade that was nevertheless billed
    r.assertions[3] = {
      ...r.assertions[3],
      judgeInvalid: true,
      judgeModel: "claude-haiku-4-5-20251001",
      judgeUsage: { input_tokens: 700, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    };
    const row = errRow(attemptRow({ result: r }, ctx(r)));
    expect(row).toMatchObject({
      failure_class: "judge_invalid",
      judge_model: "claude-haiku-4-5-20251001",
      judge_usage: { input_tokens: 700 },
    });
  });

  it("judge_retries: unrecorded attempts say so rather than claim 0", () => {
    const r = structuredClone(fixture("success-semantic"));
    r.assertions[3].judgeModel = "claude-haiku-4-5-20251001"; // ADDED: a judged assert with no attempt count
    const row = errRow(attemptRow({ result: r }, ctx(r, { runnerTimeout: true })));
    expect(row).toMatchObject({ judge_retries: 0, meta: { judge_retries_unrecorded: true } });
  });

  it("judge_retries: recorded attempts count the retries, and say nothing is unrecorded", () => {
    const r = structuredClone(fixture("success-semantic"));
    r.assertions[3].judgeModel = "claude-haiku-4-5-20251001";
    r.assertions[3].judgeAttempts = 2;
    const row = attemptRow({ result: r }, ctx(r)).row as Record<string, any>;
    expect(row.meta.judge_retries).toBe(1);
    expect(row.meta).not.toHaveProperty("judge_retries_unrecorded");
  });
});

describe("attemptRow — meta.judge_transport", () => {
  it("asserts judged on different transports list every distinct one, never folding them into one", () => {
    const base = fixture("success-semantic");
    const sem = base.assertions.find((a) => a.assertion.semantic_matches)!;
    const r = {
      ...base,
      assertions: [
        ...base.assertions.map((a) => (a === sem ? { ...a, judgeTransport: { isolation: "strict" } } : a)),
        { ...sem, judgeTransport: { isolation: "strict", strictMcp: false as const } },
      ],
    } as RunResult;
    const meta = (attemptRow({ result: r }, ctx(r)).row as Record<string, any>).meta;
    expect(meta).not.toHaveProperty("judge_transport");
    expect(meta.judge_transports).toEqual([{ isolation: "strict" }, { isolation: "strict", strictMcp: false }]);
  });
});

describe("attemptRow — a refused single-key semantic_pairwise assert is not measured", () => {
  const pairwise = (refused: boolean): RunResult => {
    const base = fixture("success-semantic");
    const assertion = { semantic_pairwise: { refs: ["/refs/store"], judge_model: "claude-haiku-4-5-20251001" } } as unknown as Assertion;
    const grade = {
      assertion,
      pass: !refused,
      ...(refused ? { pairwise: [{ status: "missing" }] } : { pairwise: [{ status: "graded", outcome: "win" }] }),
    };
    return { ...base, assertions: [base.assertions[0], grade as never], verdict: { pass: !refused } as never } as RunResult;
  };

  it("refused: a<i> is omitted and its companion a<i>_present says 0 — never a silent missing key", () => {
    const r = pairwise(true);
    const row = attemptRow({ result: r }, ctx(r)).row as Record<string, any>;
    expect(row.grade).not.toHaveProperty("a1");
    expect(row.grade.a1_present).toBe(0);
  });

  it("graded: a<i> carries the outcome and a<i>_present is 1", () => {
    const r = pairwise(false);
    const row = attemptRow({ result: r }, ctx(r)).row as Record<string, any>;
    expect(row.grade.a1).toBe(1);
    expect(row.grade.a1_present).toBe(1);
  });
});

// The effort the agent's own session transcript says each main-loop call went out with, against the requested one.
// Lines shaped as real kept transcripts (see test/hillclimb-served-model.test.ts).
describe("requested vs sent effort", () => {
  const t = (effort: string | undefined, model = "claude-sonnet-5") =>
    JSON.stringify({ type: "assistant", isSidechain: false, message: { model }, ...(effort ? { effort } : {}), perTurnEffort: null });
  const req = (effort: string, noSelector = false) => ({ requestedEffort: { effort, noSelector } });

  it("sent as requested: scored, with meta.effort, meta.effort_sent and meta.model_requested", () => {
    const r = fixture("success-semantic");
    const out = attemptRow({ result: r }, ctx(r, { ...req("high"), transcript: [t("high"), t("high")] }));
    expect(out.dest).toBe("results");
    expect(out.row.meta).toMatchObject({ effort: "high", effort_sent: "high", model_requested: "claude-sonnet-5" });
  });

  it("a different effort sent is an error row, never a scored one", () => {
    const r = fixture("success-semantic");
    const out = attemptRow({ result: r }, ctx(r, { ...req("high"), transcript: [t("high"), t("medium")] }));
    expect(out.dest).toBe("errors");
    expect(out.row).toMatchObject({ failure_class: "serving_substitution", error: "sent effort medium != requested high" });
    expect(out.row.meta).toMatchObject({ failure_rule: "effort_not_sent", effort: "high" });
  });

  it("a different effort outranks the agent's own failure, as a served-model mismatch does", () => {
    const r = fixture("exit-agent");
    const out = attemptRow({ result: r }, ctx(r, { ...req("high"), transcript: [t("low")] }));
    expect(out.dest).toBe("errors");
    expect((out.row.meta as Record<string, unknown>).failure_rule).toBe("effort_not_sent");
  });

  it("an effort requested but absent on a main-loop call is an error row", () => {
    const r = fixture("success-semantic");
    const out = attemptRow({ result: r }, ctx(r, { ...req("high"), transcript: [t("high"), t(undefined)] }));
    expect(out.dest).toBe("errors");
    expect(out.row).toMatchObject({
      failure_class: "serving_substitution",
      error: "the requested effort high was not sent on 1 of 2 main-loop call(s)",
    });
    expect((out.row.meta as Record<string, unknown>).failure_rule).toBe("effort_not_sent");
  });

  it("no transcript to confirm it, though the main loop answered, is an error row", () => {
    const r = fixture("success-semantic");
    for (const transcript of [undefined, []]) {
      const out = attemptRow({ result: r }, ctx(r, { ...req("medium"), ...(transcript ? { transcript } : {}) }));
      expect(out.dest).toBe("errors");
      expect(out.row.error).toBe("the requested effort medium is not confirmed: the agent's session transcript records no main-loop call");
    }
  });

  it("absence does not outrank the agent's own failure: an agent that failed is still scored", () => {
    const r = fixture("exit-agent");
    const out = attemptRow({ result: r }, ctx(r, { ...req("high"), transcript: [] }));
    expect(out.dest).toBe("results");
    expect(out.row.meta).toMatchObject({ effort: "high" });
    expect(out.row.meta).not.toHaveProperty("effort_sent");
  });

  it("a model with no effort selector may send none: scored", () => {
    const r = fixture("success-semantic");
    const out = attemptRow({ result: r }, ctx(r, { ...req("medium", true), transcript: [t(undefined)] }));
    expect(out.dest).toBe("results");
  });

  it("nothing requested (a caller outside hillclimb run) checks nothing", () => {
    const r = fixture("success-semantic");
    const out = attemptRow({ result: r }, ctx(r, { transcript: [t("low")] }));
    expect(out.dest).toBe("results");
    expect(out.row.meta).not.toHaveProperty("effort");
  });
});
