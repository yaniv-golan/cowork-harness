import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { makeSemanticJudge } from "../src/decide/semantic-judge.js";
import type { Complete } from "../src/decide/decider.js";
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

  it("pre-pass grades, then evaluate() reads it — all claims pass + structured per-claim results attached", async () => {
    const a = sem(["alpha", "beta"]); // one object, reused (results are keyed by assertion identity)
    const c = ctx({ transcript: "alpha and beta are both here" });
    await runSemanticJudges([a], c, stub);
    const r = evaluate([a], c)[0];
    expect(r.pass).toBe(true); // 2/2 >= all
    expect(r.semanticClaims).toEqual([
      { index: 0, claim: "alpha", pass: true },
      { index: 1, claim: "beta", pass: true },
    ]); // the per-claim profile a gate diffs across runs, not just the summary message
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

  it("records the judge model as provenance on the assertion result", async () => {
    const judge: SemanticJudge = Object.assign(async (rubric: string[]) => rubric.map((claim, index) => ({ index, claim, pass: true })), {
      model: "claude-opus-4-8",
    });
    const a = sem(["x"]);
    const c = ctx({ transcript: "x" });
    await runSemanticJudges([a], c, judge);
    expect(evaluate([a], c)[0].judgeModel).toBe("claude-opus-4-8");
  });

  it("honors a per-assert judge_model override via the judgeFor factory", async () => {
    const runLevel: SemanticJudge = Object.assign(async (r: string[]) => r.map((claim, index) => ({ index, claim, pass: true })), {
      model: "run-level",
    });
    const overrideJudge: SemanticJudge = Object.assign(async (r: string[]) => r.map((claim, index) => ({ index, claim, pass: true })), {
      model: "override-model",
    });
    const a: Assertion = { semantic_matches: { rubric: ["x"], judge_model: "override-model" } };
    const c = ctx({ transcript: "x" });
    await runSemanticJudges([a], c, runLevel, (model) => (model === "override-model" ? overrideJudge : runLevel));
    // the override judge graded, and its model is what's recorded — not the run-level default
    expect(evaluate([a], c)[0].judgeModel).toBe("override-model");
  });
});

describe("semantic_matches — replay classification", () => {
  it("is a LIVE-ONLY key, so replay strips it (never re-graded / never a replay false-green)", () => {
    expect(LIVE_ONLY_KEYS).toContain("semantic_matches");
  });
});

describe("semantic_matches — judge cost + prompt-hash provenance on the assertion result", () => {
  /** A judge double that behaves like makeSemanticJudge's cost stamping: sets lastCostUsd per call. */
  function costedJudge(steps: Array<{ cost?: number; fail?: boolean }>, promptHash?: string): SemanticJudge {
    let i = 0;
    const j: SemanticJudge = async (rubric) => {
      const s = steps[i++]!;
      j.lastCostUsd = s.cost;
      if (s.fail) throw new Error("malformed grade");
      return rubric.map((claim, index) => ({ index, claim, pass: true }));
    };
    if (promptHash) j.promptHash = promptHash;
    return j;
  }

  it("sums the cost of BOTH attempts when the first grade is retried", async () => {
    const a = sem(["alpha"]);
    const c = ctx({ transcript: "alpha" });
    await runSemanticJudges([a], c, costedJudge([{ cost: 0.01, fail: true }, { cost: 0.02 }]));
    expect(evaluate([a], c)[0].judgeCostUsd).toBeCloseTo(0.03, 10);
  });

  it("counts a priced attempt even when the other attempt carried no cost", async () => {
    const a = sem(["alpha"]);
    const c = ctx({ transcript: "alpha" });
    await runSemanticJudges([a], c, costedJudge([{ fail: true }, { cost: 0.02 }]));
    expect(evaluate([a], c)[0].judgeCostUsd).toBeCloseTo(0.02, 10);
  });

  it("omits judgeCostUsd when no attempt was priced (unpriced is not $0)", async () => {
    const a = sem(["alpha"]);
    const c = ctx({ transcript: "alpha" });
    await runSemanticJudges([a], c, costedJudge([{}]));
    expect(evaluate([a], c)[0]).not.toHaveProperty("judgeCostUsd");
  });

  it("stamps judgePromptHash from the judge that graded, and omits it for a judge that has none", async () => {
    const a = sem(["alpha"]);
    const c = ctx({ transcript: "alpha" });
    await runSemanticJudges([a], c, costedJudge([{ cost: 0.01 }], "abcdef0123456789"));
    expect(evaluate([a], c)[0].judgePromptHash).toBe("abcdef0123456789");
    const b = sem(["alpha"]);
    const c2 = ctx({ transcript: "alpha" });
    await runSemanticJudges([b], c2, stub);
    expect(evaluate([b], c2)[0]).not.toHaveProperty("judgePromptHash");
  });
});

describe("semantic_matches — judgeModel provenance fallback", () => {
  const withKey = (): Assertion => ({ semantic_matches: { rubric: ["alpha"], judge_model: "claude-per-assert-1" } });
  const modelless: SemanticJudge = async (rubric) => rubric.map((claim, index) => ({ index, claim, pass: true }));

  it("records the per-assert judge_model when that key actually selected the judge", async () => {
    const a = withKey();
    const c = ctx({ transcript: "alpha" });
    await runSemanticJudges([a], c, modelless, () => (async (r: string[]) => modelless(r, "")) as SemanticJudge);
    expect(evaluate([a], c)[0].judgeModel).toBe("claude-per-assert-1");
  });

  it("does NOT record a per-assert judge_model that a run-level judge overrode", async () => {
    const a = withKey();
    const c = ctx({ transcript: "alpha" });
    await runSemanticJudges([a], c, modelless); // no factory: the run-level judge graded
    expect(evaluate([a], c)[0].judgeModel).toBe("unknown");
  });
});

describe("semantic_matches — judge token usage on the assertion result", () => {
  const GRADE = '{"results":[{"index":0,"pass":true}]}';

  it("sums judgeUsage over BOTH attempts of a retried grade, every model key included", async () => {
    const replies = [
      { text: "not json", usage: { main: { inputTokens: 100, outputTokens: 4, cacheReadInputTokens: 10, costUSD: 0.01 } } },
      {
        text: GRADE,
        usage: {
          main: { inputTokens: 200, outputTokens: 6, cacheCreationInputTokens: 5, costUSD: 0.02 },
          aux: { inputTokens: 1, costUSD: 0.001 },
        },
      },
    ];
    let n = 0;
    const complete: Complete = async () => ({ ...replies[n++]!, model: "m" });
    const a = sem(["alpha"]);
    const c = ctx({ transcript: "alpha" });
    await runSemanticJudges([a], c, makeSemanticJudge({ complete }));
    const r = evaluate([a], c)[0];
    expect(n).toBe(2);
    expect(r.judgeUsage).toEqual({ input_tokens: 301, output_tokens: 10, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 });
    expect(r.judgeCostUsd).toBeCloseTo(0.031, 10);
  });

  it("omits judgeUsage when no attempt reported token counters", async () => {
    const a = sem(["alpha"]);
    const c = ctx({ transcript: "alpha" });
    await runSemanticJudges([a], c, makeSemanticJudge({ complete: async () => ({ text: GRADE, model: "m" }) }));
    expect(evaluate([a], c)[0]).not.toHaveProperty("judgeUsage");
  });
});

describe("semantic_matches — judgedDoc fingerprints the document the judge actually received", () => {
  const sha = (t: string): string => createHash("sha256").update(t, "utf8").digest("hex");
  /** A judge double that CAPTURES the answer it was handed — the oracle is what left the harness, not a
   *  recomputation through the function under test. */
  function capturing(): { judge: SemanticJudge; received: string[] } {
    const received: string[] = [];
    const judge: SemanticJudge = async (rubric, answer) => {
      received.push(answer);
      return rubric.map((claim, index) => ({ index, claim, pass: true }));
    };
    return { judge, received };
  }
  /** Walk the received document by each section's `chars` (sections are joined by a blank line) and
   *  check every section's hash against the slice of the RECEIVED text it claims to cover. */
  function walk(doc: string, sections: Array<{ sha256: string; chars: number }>): void {
    let off = 0;
    for (const s of sections) {
      expect(sha(doc.slice(off, off + s.chars))).toBe(s.sha256);
      off += s.chars + 2;
    }
  }

  it("top-level sha256 equals the received document; sections name each part (kind, path) and hash its received bytes", async () => {
    const { judge, received } = capturing();
    const a = sem(["alpha"]);
    const c = ctx({
      transcript: "the transcript says alpha",
      finalMessage: "final: alpha with TOKEN-XYZ inside",
      secrets: ["TOKEN-XYZ"],
      authoredFiles: [
        { path: "outputs/report.md", content: "# Report\nalpha" },
        { path: "scratchpad/notes.txt", content: "draft", truncated: true },
      ],
    } as Partial<AssertContext>);
    await runSemanticJudges([a], c, judge);
    const r = evaluate([a], c)[0];
    expect(received).toHaveLength(1);
    const doc = received[0]!;
    expect(doc).not.toContain("TOKEN-XYZ"); // the fingerprint covers the SCRUBBED bytes that left
    expect(r.judgedDoc?.sha256).toBe(sha(doc));
    expect(r.judgedDoc?.sections.map((s) => [s.kind, s.path])).toEqual([
      ["final", undefined],
      ["transcript", undefined],
      ["authored", "outputs/report.md"],
      ["authored", "scratchpad/notes.txt"],
      ["scratch_note", undefined],
      ["health", undefined],
    ]);
    walk(doc, r.judgedDoc!.sections);
    // Without an aggregate cut the sections tile the document exactly.
    const total = r.judgedDoc!.sections.reduce((n, s) => n + s.chars, 0) + 2 * (r.judgedDoc!.sections.length - 1);
    expect(total).toBe(doc.length);
  });

  it("includes sub-agent sections only for the assert that opted in", async () => {
    const { judge, received } = capturing();
    const plain = sem(["alpha"]);
    const withSub: Assertion = { semantic_matches: { rubric: ["alpha"], include_subagent_text: true } };
    const c = ctx({
      transcript: "alpha",
      subagents: [{ description: "worker", reasoning: [{ kind: "text", text: "sub-agent found alpha" }] }] as AssertContext["subagents"],
    });
    await runSemanticJudges([plain, withSub], c, judge);
    const [r1, r2] = evaluate([plain, withSub], c);
    expect(r1.judgedDoc?.sha256).toBe(sha(received[0]!));
    expect(r2.judgedDoc?.sha256).toBe(sha(received[1]!));
    expect(r1.judgedDoc?.sections.map((s) => s.kind)).toEqual(["transcript"]);
    expect(r2.judgedDoc?.sections.map((s) => s.kind)).toEqual(["transcript", "subagent"]);
    walk(received[1]!, r2.judgedDoc!.sections);
  });

  it("past the aggregate cap: the hash is still of the received (cut) document, and sections stop at the cut", async () => {
    const { judge, received } = capturing();
    const a = sem(["alpha"]);
    const c = ctx({
      transcript: "alpha",
      authoredFiles: [
        { path: "outputs/big.md", content: "x".repeat(300 * 1024) },
        { path: "outputs/after.md", content: "never reached" },
      ],
    });
    await runSemanticJudges([a], c, judge);
    const r = evaluate([a], c)[0];
    const doc = received[0]!;
    expect(doc).toMatch(/chars truncated for the judge input budget/);
    expect(r.judgedDoc?.sha256).toBe(sha(doc));
    const kinds = r.judgedDoc!.sections.map((s) => s.path ?? s.kind);
    expect(kinds).toEqual(["transcript", "outputs/big.md"]); // the file wholly past the cut is not a section
    walk(doc, r.judgedDoc!.sections);
    const big = r.judgedDoc!.sections[1]!;
    expect(big.chars).toBeLessThan(300 * 1024); // clipped to what the judge saw
  });

  it("is recorded on an INVALID grade too — the judge was still sent the document, twice", async () => {
    const received: string[] = [];
    const broken: SemanticJudge = async (_rubric, answer) => {
      received.push(answer);
      throw new Error("malformed grade");
    };
    const a = sem(["alpha"]);
    const c = ctx({ transcript: "alpha" });
    await runSemanticJudges([a], c, broken);
    const r = evaluate([a], c)[0];
    expect(r.judgeInvalid).toBe(true);
    expect(received).toHaveLength(2);
    expect(received[1]).toBe(received[0]);
    expect(r.judgedDoc?.sha256).toBe(sha(received[0]!));
  });

  it("is absent on an assert the judge never graded", () => {
    const a = sem(["alpha"]);
    expect(evaluate([a], ctx({ transcript: "alpha" }))[0]).not.toHaveProperty("judgedDoc");
  });
});
