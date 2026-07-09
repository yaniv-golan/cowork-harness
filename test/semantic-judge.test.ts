import { describe, it, expect } from "vitest";
import { makeSemanticJudge, parseJudgeResults, extractJsonObject, buildJudgePrompt } from "../src/decide/semantic-judge.js";
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

  it("F5: the embedded output example is a NON-PARSEABLE template — it can never be mistaken for a grade, even for a 2-claim rubric", () => {
    // The example uses <…> placeholders, so JSON.parse fails on it → tryParseGrade returns null → it is
    // never a valid full-coverage survivor. Feeding the whole prompt (which contains the example) to the
    // parser for a 2-claim rubric must therefore find NO grade and throw, rather than grading on the example.
    const p = buildJudgePrompt(["a", "b"], "ans");
    expect(() => parseJudgeResults(p, ["a", "b"])).toThrow(/no valid full-coverage/);
    // Belt: the example must not contain a bare, parseable {"index":0,"pass":true} literal.
    expect(p).not.toMatch(/\{"index":\s*0,\s*"pass":\s*(true|false)\}/);
  });
});
