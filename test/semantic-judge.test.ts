import { describe, it, expect } from "vitest";
import { makeSemanticJudge, parseJudgeResults, extractJsonObject, buildJudgePrompt } from "../src/decide/semantic-judge.js";
import type { Complete } from "../src/decide/decider.js";

// A stubbed transport (same shape as the shared claudeCliComplete) so the judge's prompt/parse/align
// logic is tested without a model call.
const complete = (text: string): Complete => async (_prompt, model) => ({ text, model });

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

  it("throws on non-JSON output", () => {
    expect(() => parseJudgeResults("not json at all", ["a"])).toThrow(/not valid JSON/);
  });

  it("throws when a rubric index has no result (never manufactures a verdict)", () => {
    expect(() => parseJudgeResults('{"results":[{"index":0,"pass":true}]}', ["a", "b"])).toThrow(/no result for rubric index 1/);
  });

  it("throws on a duplicate index", () => {
    expect(() => parseJudgeResults('{"results":[{"index":0,"pass":true},{"index":0,"pass":false}]}', ["a"])).toThrow(/duplicate result for index 0/);
  });

  it("throws when an entry has the wrong shape", () => {
    expect(() => parseJudgeResults('{"results":[{"index":0,"pass":"yes"}]}', ["a"])).toThrow(/index:number, pass:boolean/);
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
});
