// `run --repeat N` variance rollup. Pure functions over RunResult[] — no I/O, no execution; the
// CLI loop in cli.ts drives N executeScenario calls and hands the results here.
import type { RunResult, Assertion } from "../types.js";
import { computeVerdict, type VerdictSignal } from "./verdict.js";
import { budgetFields } from "../assert.js";

export interface RepeatRollup {
  scenario: string;
  requested: number;
  completed: number;
  stoppedEarly?: "budget" | "diverged" | "unanswered" | "error";
  passes: number;
  passRate: number;
  signalHistogram: Partial<Record<VerdictSignal["code"], number>>;
  perAssertion: Array<{ index: number; key: string; passes: number; fails: number; sampleFailure?: string }>;
  totalCostUsd?: number;
  totalTokens?: number;
  nonDeterministicRuns: number; // gates answered by llm/first/external/human (RunResult.nonDeterministic)
}

/** The first DEFINED field name on an assertion object — the same "one behavior name" convention the
 *  CLI/docs already use to describe a multi-key assertion (e.g. `{result, tool_called}` displays as
 *  "result", its first key). Falls back to a positional label if somehow no key is set. Exported — the
 *  matrix rollup reuses this exact convention for its `failedAssertions` labels, not a re-derivation. */
export function firstAssertionKey(a: Assertion): string {
  for (const k of Object.keys(a)) if ((a as Record<string, unknown>)[k] !== undefined) return k;
  return "(empty assertion)";
}

/** Builds the variance rollup for one scenario's N repeat runs. `results` holds only the COMPLETED runs
 *  (possibly fewer than `requested` on an early stop) — nothing here re-derives verdicts differently from
 *  the single-run path; every pass/fail comes from `computeVerdict`, the one verdict source, so a repeat
 *  batch's per-run reasoning is never re-implemented ad hoc. */
export function buildRepeatRollup(
  scenario: string,
  requested: number,
  results: RunResult[],
  stoppedEarly?: "budget" | "diverged" | "unanswered" | "error",
): RepeatRollup {
  const verdicts = results.map((r) => computeVerdict(r, "live"));
  const passes = verdicts.filter((v) => v.pass).length;
  const passRate = results.length ? passes / results.length : 0;

  const signalHistogram: Partial<Record<VerdictSignal["code"], number>> = {};
  for (const v of verdicts) for (const s of v.signals) signalHistogram[s.code] = (signalHistogram[s.code] ?? 0) + 1;

  const maxAssertions = results.reduce((max, r) => Math.max(max, r.assertions.length), 0);
  const perAssertion: RepeatRollup["perAssertion"] = [];
  for (let i = 0; i < maxAssertions; i++) {
    let assertPasses = 0,
      assertFails = 0,
      sampleFailure: string | undefined;
    let key = `assertion[${i}]`;
    for (const r of results) {
      const a = r.assertions[i];
      if (!a) continue;
      key = firstAssertionKey(a.assertion);
      if (a.pass) assertPasses++;
      else {
        assertFails++;
        sampleFailure ??= a.message;
      }
    }
    perAssertion.push({ index: i, key, passes: assertPasses, fails: assertFails, sampleFailure });
  }

  let totalCostUsd: number | undefined;
  let totalTokens: number | undefined;
  for (const r of results) {
    const b = budgetFields(r);
    if (b.costUsd !== undefined) totalCostUsd = (totalCostUsd ?? 0) + b.costUsd;
    if (b.tokensTotal !== undefined) totalTokens = (totalTokens ?? 0) + b.tokensTotal;
  }

  const nonDeterministicRuns = results.filter((r) => r.nonDeterministic).length;

  return {
    scenario,
    requested,
    completed: results.length,
    stoppedEarly,
    passes,
    passRate,
    signalHistogram,
    perAssertion,
    totalCostUsd,
    totalTokens,
    nonDeterministicRuns,
  };
}

/**
 * The batch verdict formula (`ok` is redefined directly per invocation mode, no
 * `batchVerdict` shadow field). Deliberately separate from `buildRepeatRollup` — the rollup is pure
 * OBSERVATION (what happened), this is the POLICY judgment (pass or fail against a threshold), the same
 * split `computeVerdict` draws between recorded facts and pass/fail.
 *
 * `stoppedEarly:"diverged"` always fails regardless of the numeric rate — divergence (both a pass AND a
 * fail observed) IS the failure `--stop-on-diverge` exists to catch. `stoppedEarly:"unanswered"` also
 * always fails — an unanswered gate mid-batch means the scenario itself isn't fully scripted for
 * deterministic repetition, which is the real problem `--repeat` exists to surface, not noise to average
 * away against whatever completed cleanly beforehand. `stoppedEarly:"error"` (an uncaught exception —
 * a BoundaryError or any other error mid-batch) always fails for the same reason: a batch that couldn't
 * finish because something broke is a real failure, not a clean-but-incomplete measurement.
 * `stoppedEarly:"budget"` defaults to failing too — a budget cutoff means the batch never reached
 * `requested`, so a clean-looking passRate over a small completed prefix is "incomplete is not green",
 * the same principle `--matrix`'s `truncated` applies. Pass `allowBudgetStop: true` to opt back into the
 * old behavior (judge a budget-stopped batch on its own completed-runs passRate like any other batch —
 * an incomplete-but-clean run isn't itself a failure, that's a `::warning::` at the call site instead).
 */
export function rollupPasses(rollup: RepeatRollup, minPassRate = 1.0, allowBudgetStop = false): boolean {
  if (rollup.stoppedEarly === "diverged" || rollup.stoppedEarly === "unanswered" || rollup.stoppedEarly === "error") return false;
  if (rollup.stoppedEarly === "budget" && !allowBudgetStop) return false;
  return rollup.passRate >= minPassRate;
}
