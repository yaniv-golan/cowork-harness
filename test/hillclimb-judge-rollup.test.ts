import { describe, it, expect } from "vitest";
import { combineJudges } from "../src/hillclimb/judge-rollup.js";
import type { TokenUsage } from "../src/types.js";

const u = (input: number, output = 0): TokenUsage => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
});

describe("combineJudges (the per-row judge_model / judge_usage rule)", () => {
  it("no judged assert ⇒ both keys absent (unpriced is not $0)", () => {
    const r = combineJudges([{}, { judgeModel: undefined }]);
    expect(Object.keys(r)).toEqual([]); // not merely undefined-valued keys
    expect(Object.keys(combineJudges([{ judgeModel: "m1" }]))).toEqual(["judge_model"]);
  });

  it("one judge model ⇒ that model, usage summed over every assert", () => {
    expect(
      combineJudges([
        { judgeModel: "m1", judgeUsage: u(10, 1) },
        { judgeModel: "m1", judgeUsage: u(5, 2) },
      ]),
    ).toEqual({
      judge_model: "m1",
      judge_usage: u(15, 3),
    });
  });

  it("several models ⇒ the one with the most input tokens, plus a per-model breakdown", () => {
    const r = combineJudges([
      { judgeModel: "small", judgeUsage: u(10) },
      { judgeModel: "big", judgeUsage: u(100) },
      { judgeModel: "small", judgeUsage: u(20) },
    ]);
    expect(r.judge_model).toBe("big");
    expect(r.judge_usage).toEqual(u(130));
    expect(r.judge_models).toEqual({ big: u(100), small: u(30) });
  });

  it("a tie on input tokens resolves deterministically (lexicographic), whatever the assert order", () => {
    const a = combineJudges([
      { judgeModel: "b", judgeUsage: u(5) },
      { judgeModel: "a", judgeUsage: u(5) },
    ]);
    const b = combineJudges([
      { judgeModel: "a", judgeUsage: u(5) },
      { judgeModel: "b", judgeUsage: u(5) },
    ]);
    expect(a.judge_model).toBe("a");
    expect(b.judge_model).toBe("a");
  });

  it("a judged assert that reported no tokens still names the model; usage stays absent when none reported", () => {
    expect(combineJudges([{ judgeModel: "m1" }])).toEqual({ judge_model: "m1" });
  });
});
