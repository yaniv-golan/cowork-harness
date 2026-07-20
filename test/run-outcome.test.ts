import { describe, it, expect } from "vitest";
import { deriveOutcome } from "../src/run/outcome.js";
import type { RunResult } from "../src/types.js";

/** `result` ("did the agent finish?"), `verdict.pass` ("did it satisfy the asserts/guards?") and the
 *  process exit code are three separate signals that legitimately disagree — a fail-severity signal like
 *  `outputs_delete` flips the verdict while `result.result` stays "success". An orchestrator driving an
 *  improvement loop has to answer "did this iteration deliver something usable?" EVERY iteration, and had
 *  to reconstruct it from all three. `outcome` is that rollup. It adds no new judgement: it is a pure
 *  function of fields the run already carries. */
function r(over: Partial<RunResult> = {}): RunResult {
  return {
    result: "success",
    verdict: { pass: true, exitCode: 0, signals: [], guards: [], failures: [] },
    ...over,
  } as RunResult;
}

describe("deriveOutcome", () => {
  it("errored — the agent or infra failed, whatever the verdict says", () => {
    expect(deriveOutcome(r({ result: "error" }))).toBe("errored");
    // an errored run whose verdict happens to pass is still errored: `result` dominates
    expect(deriveOutcome(r({ result: "error", verdict: { pass: true, exitCode: 0, signals: [], guards: [], failures: [] } }))).toBe(
      "errored",
    );
  });

  it("delivered_clean — finished and satisfied the verdict", () => {
    expect(deriveOutcome(r())).toBe("delivered_clean");
  });

  it("delivered_with_verdict_fail — produced a usable deliverable but tripped a policy assert", () => {
    const withFail = r({
      verdict: {
        pass: false,
        exitCode: 1,
        signals: [{ code: "outputs_delete", severity: "fail", message: "x" }],
        guards: [],
        failures: [],
      },
    } as Partial<RunResult>);
    expect(deriveOutcome(withFail)).toBe("delivered_with_verdict_fail");
  });

  it("no_deliverable — finished, but the run itself reports it produced nothing to use", () => {
    // Derived from the EXISTING no-deliverable signals rather than a new notion of "delivered":
    // `stalled` and `ended_with_question` both already mean "no outputs/ deliverable was written".
    const stalled = r({
      verdict: { pass: false, exitCode: 1, signals: [{ code: "stalled", severity: "fail", message: "x" }], guards: [], failures: [] },
    } as Partial<RunResult>);
    expect(deriveOutcome(stalled)).toBe("no_deliverable");

    const asked = r({
      verdict: {
        pass: true,
        exitCode: 0,
        signals: [{ code: "ended_with_question", severity: "warn", message: "x" }],
        guards: [],
        failures: [],
      },
    } as Partial<RunResult>);
    expect(deriveOutcome(asked)).toBe("no_deliverable");
  });

  it("is undefined when there is no verdict to roll up (never guesses)", () => {
    expect(deriveOutcome(r({ verdict: undefined }))).toBeUndefined();
  });
});
