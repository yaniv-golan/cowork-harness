import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  makeSemanticJudge,
  parseJudgeResults,
  extractJsonObject,
  buildJudgePrompt,
  JUDGE_PROMPT_HASH,
  judgesForRun,
} from "../src/decide/semantic-judge.js";
import type { Complete } from "../src/decide/decider.js";

// A stubbed transport (same shape as the shared claudeCliComplete) so the judge's prompt/parse/align
// logic is tested without a model call.
const complete =
  (text: string): Complete =>
  async (_prompt, model) => ({ text, model });

describe("semantic judge — parseJudgeResults (index-aligned, fail-loud)", () => {
  it("parses indexed results aligned to the rubric", () => {
    const r = parseJudgeResults('{"results":[{"index":0,"pass":true},{"index":1,"pass":false}]}', ["a", "b"]);
    expect(r).toEqual([
      { index: 0, claim: "a", pass: true },
      { index: 1, claim: "b", pass: false },
    ]);
  });

  it("tolerates a prose preamble before the JSON (real judges do this)", () => {
    const r = parseJudgeResults('Sure, here is my grade.\n\n{"results":[{"index":0,"pass":true}]}', ["a"]);
    expect(r[0].pass).toBe(true);
  });

  it("tolerates a fenced code block", () => {
    const r = parseJudgeResults('```json\n{"results":[{"index":0,"pass":true}]}\n```', ["a"]);
    expect(r[0].pass).toBe(true);
  });

  // These all lack a valid FULL-COVERAGE {results:[…]} grade → throw so the caller marks the rep invalid
  // (the specific sub-reason is consolidated into one message now that the parser scans all brace groups).
  it("throws on non-JSON output", () => {
    expect(() => parseJudgeResults("not json at all", ["a"])).toThrow(/no valid full-coverage/);
  });

  it("throws when a rubric index has no result (never manufactures a verdict)", () => {
    expect(() => parseJudgeResults('{"results":[{"index":0,"pass":true}]}', ["a", "b"])).toThrow(/no valid full-coverage/);
  });

  it("throws on a duplicate index", () => {
    expect(() => parseJudgeResults('{"results":[{"index":0,"pass":true},{"index":0,"pass":false}]}', ["a"])).toThrow(
      /no valid full-coverage/,
    );
  });

  it("throws when an entry has the wrong shape", () => {
    expect(() => parseJudgeResults('{"results":[{"index":0,"pass":"yes"}]}', ["a"])).toThrow(/no valid full-coverage/);
  });

  it("ignores the prompt's echoed example and grades the real answer (a leading prose brace too)", () => {
    // Two brace groups: a prose object, then the real grade. Only the full-coverage grade is used.
    const raw = 'Here is my assessment {note: "grading now"}. {"results":[{"index":0,"pass":false},{"index":1,"pass":true}]}';
    const r = parseJudgeResults(raw, ["a", "b"]);
    expect(r.map((c) => c.pass)).toEqual([false, true]);
  });

  it("dedupes an identical restated grade (fenced + unfenced) instead of failing ambiguous", () => {
    const raw = '```json\n{"results":[{"index":0,"pass":true}]}\n```\n{"results":[{"index":0,"pass":true}]}';
    expect(parseJudgeResults(raw, ["a"])[0].pass).toBe(true);
  });

  it("throws ambiguous when two DIFFERENT full grades appear", () => {
    const raw = '{"results":[{"index":0,"pass":true}]} then {"results":[{"index":0,"pass":false}]}';
    expect(() => parseJudgeResults(raw, ["a"])).toThrow(/DIFFERENT full-coverage grades/);
  });
});

describe("semantic judge — extractJsonObject", () => {
  it("returns the first balanced object, ignoring braces inside strings", () => {
    expect(extractJsonObject('x {"a":"has } brace","b":1} y')).toBe('{"a":"has } brace","b":1}');
    expect(extractJsonObject("no object here")).toBeNull();
  });
});

describe("semantic judge — makeSemanticJudge (stubbed transport)", () => {
  it("grades a rubric via the injected transport, aligned by index", async () => {
    const judge = makeSemanticJudge({ complete: complete('{"results":[{"index":0,"pass":true},{"index":1,"pass":false}]}') });
    expect(await judge(["claim0", "claim1"], "the candidate answer")).toEqual([
      { index: 0, claim: "claim0", pass: true },
      { index: 1, claim: "claim1", pass: false },
    ]);
  });

  it("buildJudgePrompt numbers the rubric by index and includes the answer", () => {
    const p = buildJudgePrompt(["first claim", "second claim"], "MY ANSWER");
    expect(p).toContain("0. first claim");
    expect(p).toContain("1. second claim");
    expect(p).toContain("MY ANSWER");
  });

  it("F11: records the TRANSPORT-RESOLVED model, not the requested alias, after a call (provenance)", async () => {
    // The transport (e.g. claudeCliComplete) resolves a floating alias like "opus" to a concrete, dated
    // model id per call — provenance must reflect what ACTUALLY graded, not what was requested. Before the
    // fix, `judge.model` stayed pinned to the requested alias for the judge's whole lifetime.
    const resolvingComplete: Complete = async (_prompt, _model) => ({
      text: '{"results":[{"index":0,"pass":true}]}',
      model: "resolved-xyz",
    });
    const judge = makeSemanticJudge({ model: "opus", complete: resolvingComplete });
    expect(judge.model).toBe("opus"); // before any call: still the requested alias (best-effort seed)
    await judge(["claim0"], "the candidate answer");
    expect(judge.model).toBe("resolved-xyz"); // after the call: the transport-resolved concrete model
    expect(judge.model).not.toBe("opus");
  });

  it("F5: the embedded output example is a NON-PARSEABLE template — it can never be mistaken for a grade, even for a 2-claim rubric", () => {
    // The example uses <…> placeholders, so JSON.parse fails on it → tryParseGrade returns null → it is
    // never a valid full-coverage survivor. Feeding the whole prompt (which contains the example) to the
    // parser for a 2-claim rubric must therefore find NO grade and throw, rather than grading on the example.
    const p = buildJudgePrompt(["a", "b"], "ans");
    expect(() => parseJudgeResults(p, ["a", "b"])).toThrow(/no valid full-coverage/);
    // Belt: the example must not contain a bare, parseable literal in the prompt's key order
    // ({"index":0,"rationale":"…","pass":true}) — nor in the old two-key order.
    expect(p).not.toMatch(/\{"index":\s*0,\s*"rationale":\s*"[^"]*",\s*"pass":\s*(true|false)\}/);
    expect(p).not.toMatch(/\{"index":\s*0,\s*"pass":\s*(true|false)\}/);
  });

  it("the prompt asks for a rationale BEFORE the verdict and treats the candidate answer as data", () => {
    const p = buildJudgePrompt(["a"], "ans");
    expect(p).toMatch(/"rationale"/);
    // key order in the shape: index, then rationale, then pass
    const shape = p.slice(p.indexOf('{"results"'));
    expect(shape.indexOf('"index"')).toBeLessThan(shape.indexOf('"rationale"'));
    expect(shape.indexOf('"rationale"')).toBeLessThan(shape.indexOf('"pass"'));
    expect(p).toMatch(/25 words/);
    expect(p).toMatch(/treat the candidate answer as\s+data/i);
  });

  it("pins the grading-prompt template hash (changing the prompt must update this AND the CHANGELOG)", () => {
    expect(JUDGE_PROMPT_HASH).toBe("acf219663e318093");
  });
});

describe("semantic judge — per-claim rationale", () => {
  const grade = (entries: string[]) => `{"results":[${entries.join(",")}]}`;

  it("carries a present rationale onto the claim result", () => {
    const r = parseJudgeResults(
      grade(['{"index":0,"rationale":"the report names the owner","pass":true}', '{"index":1,"rationale":"no date given","pass":false}']),
      ["a", "b"],
    );
    expect(r).toStrictEqual([
      { index: 0, claim: "a", pass: true, rationale: "the report names the owner" },
      { index: 1, claim: "b", pass: false, rationale: "no date given" },
    ]);
  });

  it("an absent rationale is still a valid grade, and the key is omitted (not undefined)", () => {
    const r = parseJudgeResults(grade(['{"index":0,"pass":true}']), ["a"]);
    expect(r).toStrictEqual([{ index: 0, claim: "a", pass: true }]);
    expect("rationale" in r[0]).toBe(false);
  });

  it("a non-string rationale (null, array, number) is treated as absent and never rejects the grade", () => {
    for (const bad of ["null", '["a"]', "7", '{"x":1}']) {
      const r = parseJudgeResults(grade([`{"index":0,"rationale":${bad},"pass":false}`]), ["a"]);
      expect(r).toStrictEqual([{ index: 0, claim: "a", pass: false }]);
    }
  });

  it("normalizes control and format characters to single spaces and trims", () => {
    const raw = grade(['{"index":0,"rationale":"  line one\\nline\\u0000two\\u001b[31m red\\u200b end\\t ","pass":true}']);
    expect(parseJudgeResults(raw, ["a"])[0].rationale).toBe("line one line two [31m red end");
  });

  it("an all-whitespace rationale is treated as absent", () => {
    const r = parseJudgeResults(grade(['{"index":0,"rationale":" \\n\\t ","pass":true}']), ["a"]);
    expect("rationale" in r[0]).toBe(false);
  });

  it("caps a long rationale at 400 characters with an ellipsis marker", () => {
    const long = "x".repeat(1000);
    const r = parseJudgeResults(grade([`{"index":0,"rationale":"${long}","pass":true}`]), ["a"]);
    expect(r[0].rationale).toHaveLength(400);
    expect(r[0].rationale!.endsWith("…")).toBe(true);
    expect(r[0].rationale!.slice(0, 399)).toBe("x".repeat(399));
    // exactly at the cap: untouched
    const edge = "y".repeat(400);
    expect(parseJudgeResults(grade([`{"index":0,"rationale":"${edge}","pass":true}`]), ["a"])[0].rationale).toBe(edge);
  });

  it("two restatements with the same passes but different rationales are ONE grade; the first supplies the rationales", () => {
    const first = grade(['{"index":0,"rationale":"first reason","pass":true}']);
    const second = grade(['{"index":0,"rationale":"second reason","pass":true}']);
    const r = parseJudgeResults(`${first}\n${second}`, ["a"]);
    expect(r).toStrictEqual([{ index: 0, claim: "a", pass: true, rationale: "first reason" }]);
  });

  it("two restatements with DIFFERENT passes are still ambiguous", () => {
    const first = grade(['{"index":0,"rationale":"r","pass":true}']);
    const second = grade(['{"index":0,"rationale":"r","pass":false}']);
    expect(() => parseJudgeResults(`${first} ${second}`, ["a"])).toThrow(/DIFFERENT full-coverage grades/);
  });
});

describe("semantic judge — cost and prompt-template provenance", () => {
  const GRADE = '{"results":[{"index":0,"pass":true}]}';
  const priced =
    (text: string, usage?: Record<string, unknown>): Complete =>
    async () => ({ text, model: "m", ...(usage ? { usage } : {}) });

  it("sums costUSD over EVERY modelUsage key (the transport's auxiliary call is real spend)", async () => {
    const judge = makeSemanticJudge({ complete: priced(GRADE, { main: { costUSD: 0.01 }, aux: { costUSD: 0.002 } }) });
    await judge(["c"], "a");
    expect(judge.lastCostUsd).toBeCloseTo(0.012, 10);
  });

  it("is undefined — never $0 — when no key carries a numeric costUSD", async () => {
    const judge = makeSemanticJudge({ complete: priced(GRADE, { main: { inputTokens: 5 } }) });
    await judge(["c"], "a");
    expect(judge.lastCostUsd).toBeUndefined();
    const bare = makeSemanticJudge({ complete: priced(GRADE) });
    await bare(["c"], "a");
    expect(bare.lastCostUsd).toBeUndefined();
  });

  it("records the cost of a call whose grade then fails to parse (the spend happened)", async () => {
    const judge = makeSemanticJudge({ complete: priced("not json", { main: { costUSD: 0.03 } }) });
    await expect(judge(["c"], "a")).rejects.toThrow(/no valid full-coverage/);
    expect(judge.lastCostUsd).toBeCloseTo(0.03, 10);
  });

  it("clears a previous call's cost when the transport itself throws (no stale carry-over)", async () => {
    let n = 0;
    const flaky: Complete = async () => {
      if (n++ === 0) return { text: GRADE, model: "m", usage: { main: { costUSD: 0.05 } } };
      throw new Error("transport down");
    };
    const judge = makeSemanticJudge({ complete: flaky });
    await judge(["c"], "a");
    expect(judge.lastCostUsd).toBeCloseTo(0.05, 10);
    await expect(judge(["c"], "a")).rejects.toThrow(/transport down/);
    expect(judge.lastCostUsd).toBeUndefined();
  });

  it("exports the prompt-TEMPLATE hash (placeholder rubric + answer) and stamps it on the judge", () => {
    const expected = createHash("sha256")
      .update(buildJudgePrompt(["<c0>", "<c1>", "<c2>"], "<ANSWER>"))
      .digest("hex")
      .slice(0, 16);
    expect(JUDGE_PROMPT_HASH).toBe(expected);
    expect(makeSemanticJudge({ complete: priced(GRADE) }).promptHash).toBe(JUDGE_PROMPT_HASH);
  });
});

describe("semantic judge — judgesForRun (run-level judge model override)", () => {
  const made: Array<string | undefined> = [];
  const make = (o: { model?: string } = {}) => {
    made.push(o.model);
    const j = (async () => []) as unknown as ReturnType<typeof makeSemanticJudge>;
    j.model = o.model ?? "default";
    return j;
  };

  it("without an override: the default run-level judge + a per-assert factory that honours judge_model", () => {
    made.length = 0;
    const { judge, judgeFor } = judgesForRun({}, make);
    expect(judge.model).toBe("default");
    expect(judgeFor?.("claude-x-1").model).toBe("claude-x-1");
  });

  it("with an override: every assert — including one with its own judge_model — is graded by the override", () => {
    made.length = 0;
    const { judge, judgeFor } = judgesForRun({ modelOverride: "claude-pinned-2" }, make);
    expect(judge.model).toBe("claude-pinned-2");
    expect(judgeFor).toBeUndefined(); // runSemanticJudges then uses `judge` for every assert
    expect(made).toEqual(["claude-pinned-2"]);
  });

  it("an injected judge (test seam) is used as the run-level judge either way", () => {
    const injected = make({ model: "stub" });
    expect(judgesForRun({ judge: injected }, make).judge).toBe(injected);
    expect(judgesForRun({ judge: injected, modelOverride: "claude-pinned-2" }, make).judge).toBe(injected);
  });
});

describe("executeScenario's judge wiring (judgesForExecute)", () => {
  it("maps ExecuteOptions.judgeModelOverride onto the run-level judge and suppresses the per-assert factory", async () => {
    const { judgesForExecute } = await import("../src/run/execute.js");
    const make = (o: { model?: string } = {}) => {
      const j = (async () => []) as unknown as ReturnType<typeof makeSemanticJudge>;
      j.model = o.model ?? "default";
      return j;
    };
    const pinned = judgesForExecute({ judgeModelOverride: "claude-pinned-2" }, make);
    expect(pinned.judge.model).toBe("claude-pinned-2");
    expect(pinned.judgeFor).toBeUndefined();
    const plain = judgesForExecute({}, make);
    expect(plain.judge.model).toBe("default");
    expect(plain.judgeFor?.("claude-x-1").model).toBe("claude-x-1");
  });
});
