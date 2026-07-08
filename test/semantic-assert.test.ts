import { describe, it, expect } from "vitest";
import { evaluate, runSemanticJudges, type AssertContext, type SemanticJudge } from "../src/assert.js";
import { LIVE_ONLY_KEYS } from "../src/run/cassette.js";
import type { Assertion } from "../src/types.js";

// Proves the design bet for a live-only, LLM-judged assertion: an ASYNC pre-pass (runSemanticJudges)
// populates ctx, then the SYNCHRONOUS evaluate()/check() reads it — so evaluate() never becomes async
// (replay determinism intact) — and the key is classified live-only so replay strips it. No real model
// call: the judge is injected. (The real judge is makeSemanticJudge; see semantic-judge.test.ts.)

// A local test double: pass a claim iff the answer literally contains it (deterministic).
const stub: SemanticJudge = async (rubric, answer) => rubric.map((claim, index) => ({ index, claim, pass: answer.includes(claim) }));

function ctx(over: Partial<AssertContext> = {}): AssertContext {
  return {
    transcript: "",
    toolsCalled: new Set(),
    subagentTools: new Set(),
    egress: [],
    result: "success",
    workRoot: "/nonexistent",
    userVisiblePrefixes: ["outputs", ".projects"],
    outputsDeletes: [],
    questions: [],
    hostPathLeaked: false,
    selfHealRan: false,
    subagents: [],
    gateDeliveries: [],
    toolResultTexts: [],
    skillsInvoked: [],
    skillToolAvailable: true,
    ...over,
  };
}

const sem = (rubric: string[], min_pass?: "all" | number): Assertion => ({
  semantic_matches: min_pass === undefined ? { rubric } : { rubric, min_pass },
});

describe("semantic_matches — async pre-pass + synchronous evaluate() compose", () => {
  it("evaluate() stays SYNCHRONOUS with a semantic assert present (returns an array, not a Promise)", () => {
    const r = evaluate([sem(["alpha"])], ctx({ transcript: "alpha" }));
    expect(Array.isArray(r)).toBe(true); // not a Promise — the async work lives only in runSemanticJudges
  });

  it("pre-pass grades, then evaluate() reads it — all claims pass (default min_pass: all)", async () => {
    const a = sem(["alpha", "beta"]); // one object, reused (results are keyed by assertion identity)
    const c = ctx({ transcript: "alpha and beta are both here" });
    await runSemanticJudges([a], c, stub);
    expect(evaluate([a], c)[0].pass).toBe(true); // 2/2 >= all
  });

  it("per-claim + min_pass verdict: default 'all' fails a partial; an integer threshold passes it", async () => {
    const aAll = sem(["alpha", "beta"]); // default min_pass: all
    const c = ctx({ transcript: "only alpha here" }); // stub passes alpha, fails beta -> 1/2
    await runSemanticJudges([aAll], c, stub);
    expect(evaluate([aAll], c)[0].pass).toBe(false); // 1/2 < all

    const aOne = sem(["alpha", "beta"], 1); // min_pass: 1
    const c2 = ctx({ transcript: "only alpha here" });
    await runSemanticJudges([aOne], c2, stub);
    expect(evaluate([aOne], c2)[0].pass).toBe(true); // 1/2 >= 1
  });

  it("FAILS evidence-unavailable when the pre-pass didn't run (never a vacuous pass)", () => {
    const a = sem(["alpha"]);
    const r = evaluate([a], ctx({ transcript: "alpha" })); // no runSemanticJudges called
    expect(r[0].pass).toBe(false);
    expect(r[0].message).toMatch(/evidence unavailable/i);
  });

  it("the judge is injectable (the real judge slots in the same way)", async () => {
    const alwaysPass: SemanticJudge = async (rubric) => rubric.map((claim, index) => ({ index, claim, pass: true }));
    const a = sem(["nothing in the transcript matches this"]);
    const c = ctx({ transcript: "" });
    await runSemanticJudges([a], c, alwaysPass);
    expect(evaluate([a], c)[0].pass).toBe(true);
  });
});

describe("semantic_matches — replay classification", () => {
  it("is a LIVE-ONLY key, so replay strips it (never re-graded / never a replay false-green)", () => {
    expect(LIVE_ONLY_KEYS).toContain("semantic_matches");
  });
});
