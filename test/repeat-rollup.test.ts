import { describe, it, expect } from "vitest";
import { buildRepeatRollup, rollupPasses } from "../src/run/repeat.js";
import type { RunResult, Assertion } from "../src/types.js";

function rr(over: Partial<RunResult>): RunResult {
  return {
    scenario: "t",
    fidelity: "container",
    baseline: "x",
    result: "success",
    decisions: [],
    egress: [],
    assertions: [],
    outDir: "/tmp/x",
    ...over,
  };
}
const assn = (assertion: Assertion, pass = true, message?: string): RunResult["assertions"][number] => ({ assertion, pass, message });

describe("buildRepeatRollup — pass rate, signal histogram, completeness", () => {
  it("computes passRate from computeVerdict, not just result:success", () => {
    const results = [rr({}), rr({}), rr({ result: "error" })];
    const rollup = buildRepeatRollup("t", 3, results);
    expect(rollup.requested).toBe(3);
    expect(rollup.completed).toBe(3);
    expect(rollup.passes).toBe(2);
    expect(rollup.passRate).toBeCloseTo(2 / 3);
  });

  it("passRate is 0 for an empty result set (no div-by-zero NaN)", () => {
    expect(buildRepeatRollup("t", 3, []).passRate).toBe(0);
  });

  it("builds a signal histogram from each run's computeVerdict signals", () => {
    const results = [rr({ result: "error" }), rr({ result: "error" }), rr({})];
    const rollup = buildRepeatRollup("t", 3, results);
    expect(rollup.signalHistogram.result_error).toBe(2);
  });

  it("records stoppedEarly when passed through (budget/diverged early-stop)", () => {
    const rollup = buildRepeatRollup("t", 5, [rr({})], "budget");
    expect(rollup.stoppedEarly).toBe("budget");
    expect(rollup.requested).toBe(5);
    expect(rollup.completed).toBe(1); // fewer than requested — the early-stop signal
  });
});

describe("buildRepeatRollup — per-assertion attribution", () => {
  it("attributes pass/fail per assertion INDEX (stable across identical-scenario runs)", () => {
    const results = [
      rr({ assertions: [assn({ tool_called: "Write" }, true), assn({ result: "success" }, true)] }),
      rr({ assertions: [assn({ tool_called: "Write" }, false, "not called"), assn({ result: "success" }, true)] }),
    ];
    const rollup = buildRepeatRollup("t", 2, results);
    expect(rollup.perAssertion).toHaveLength(2);
    expect(rollup.perAssertion[0]).toMatchObject({ index: 0, key: "tool_called", passes: 1, fails: 1, sampleFailure: "not called" });
    expect(rollup.perAssertion[1]).toMatchObject({ index: 1, key: "result", passes: 2, fails: 0 });
  });

  it("uses the first DEFINED assertion field as the display key for a multi-key assertion", () => {
    const results = [rr({ assertions: [assn({ result: "success", tool_called: "X" }, true)] })];
    const rollup = buildRepeatRollup("t", 1, results);
    expect(rollup.perAssertion[0].key).toBe("result");
  });
});

describe("buildRepeatRollup — cost/tokens/non-determinism", () => {
  it("sums cost.usd and usage token totals across all completed runs (reusing budgetFields)", () => {
    const results = [
      rr({ cost: { usd: 0.01 }, usage: { input_tokens: 100, output_tokens: 50 } }),
      rr({ cost: { usd: 0.02 }, usage: { input_tokens: 200, output_tokens: 100 } }),
    ];
    const rollup = buildRepeatRollup("t", 2, results);
    expect(rollup.totalCostUsd).toBeCloseTo(0.03);
    expect(rollup.totalTokens).toBe(450);
  });

  it("leaves totals undefined (not 0) when no run in the batch has cost telemetry", () => {
    const rollup = buildRepeatRollup("t", 2, [rr({}), rr({})]);
    expect(rollup.totalCostUsd).toBeUndefined();
    expect(rollup.totalTokens).toBeUndefined();
  });

  it("counts non-deterministic runs (gates answered by llm/first/external)", () => {
    const results = [rr({ nonDeterministic: true }), rr({ nonDeterministic: false }), rr({ nonDeterministic: true })];
    expect(buildRepeatRollup("t", 3, results).nonDeterministicRuns).toBe(2);
  });
});

describe("rollupPasses — the batch verdict formula (§8: ok redefined directly, no shadow field)", () => {
  it("passes when passRate meets the threshold", () => {
    const rollup = buildRepeatRollup("t", 4, [rr({}), rr({}), rr({}), rr({ result: "error" })]); // 3/4 = 0.75
    expect(rollupPasses(rollup, 0.75)).toBe(true);
    expect(rollupPasses(rollup, 0.8)).toBe(false);
  });

  it("defaults to requiring 1.0 (no flakiness tolerance) when minPassRate is omitted", () => {
    const allPass = buildRepeatRollup("t", 2, [rr({}), rr({})]);
    const onefail = buildRepeatRollup("t", 2, [rr({}), rr({ result: "error" })]);
    expect(rollupPasses(allPass)).toBe(true);
    expect(rollupPasses(onefail)).toBe(false);
  });

  it("a stoppedEarly:'diverged' batch ALWAYS fails, regardless of passRate — divergence IS the failure being gated", () => {
    // 1 pass out of 1 completed = passRate 1.0, which would normally satisfy even minPassRate:1.0 —
    // but --stop-on-diverge means a fail was already observed before this early-stop snapshot.
    const rollup = buildRepeatRollup("t", 10, [rr({})], "diverged");
    expect(rollupPasses(rollup, 0.5)).toBe(false);
    expect(rollupPasses(rollup, 1.0)).toBe(false);
  });

  it("a stoppedEarly:'budget' batch FAILS by default — incomplete is not green (opt out with allowBudgetStop)", () => {
    const rollup = buildRepeatRollup("t", 10, [rr({}), rr({})], "budget"); // 2/2 completed, all passing, but requested 10
    expect(rollupPasses(rollup, 1.0)).toBe(false);
    // Explicit opt-in restores the completed-runs passRate judgement, recording the incomplete sample.
    expect(rollupPasses(rollup, 1.0, true)).toBe(true);
  });

  it(
    "a stoppedEarly:'unanswered' batch ALWAYS fails, regardless of passRate — the scenario isn't fully " +
      "scripted for deterministic repetition, which is itself the problem, not an incomplete-but-clean stop",
    () => {
      const rollup = buildRepeatRollup("t", 10, [rr({}), rr({})], "unanswered"); // 2/2 completed, all passing
      expect(rollupPasses(rollup, 0.1)).toBe(false);
      expect(rollupPasses(rollup, 1.0)).toBe(false);
    },
  );

  it("a stoppedEarly:'error' batch ALWAYS fails — an uncaught exception mid-batch is a real failure, not noise", () => {
    const rollup = buildRepeatRollup("t", 10, [rr({}), rr({})], "error");
    expect(rollupPasses(rollup, 0.1)).toBe(false);
  });
});
