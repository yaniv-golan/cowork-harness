/**
 * Cost pre-flight for `--max-budget-usd`.
 *
 * Extracted from `cli.ts` so `record` (which lives in `cassette.ts`) can reach it without importing
 * `cli.ts` — `cli.ts` already imports `cmdRecord` FROM `cassette.ts`, so a call in that direction would
 * be a cycle. Everything here is leaf-module-only for the same reason.
 */
import { writeAllSync } from "../io.js";
import { fail } from "./envelope.js";
import { readIndex, scenarioCostHistory } from "./run-index.js";
import { runsRoot } from "./trace-view.js";

/** Human-facing line on stderr. `cli.ts` has its own module-scope `log` that is not importable; this is
 *  the same one-liner, kept local so the extraction stays leaf-only. */
const log = (s: string) => writeAllSync(2, s + "\n");

/** Worst observed cost for a scenario, or `undefined` when it has never been priced. The WORST rather
 *  than the median: these are refusal gates, and an estimate that under-predicts lets through exactly
 *  the expensive run the flag was reached for. */
export function worstObservedCost(scenario: string): number | undefined {
  const history = scenarioCostHistory(readIndex(runsRoot()), scenario);
  return history.length === 0 ? undefined : Math.max(...history);
}

/** How many prior priced runs back a scenario's estimate — for messages that report their own basis. */
export function pricedRunCount(scenario: string): number {
  return scenarioCostHistory(readIndex(runsRoot()), scenario).length;
}

/**
 * `--max-budget-usd` on a SINGLE run (no `--repeat`): refuse BEFORE spending if this scenario's own
 * history says the run is likely to exceed the cap.
 *
 * Why pre-flight and not a mid-run kill: there is no live cost signal to abort on. `cost.usd` arrives
 * only with the SDK result message (by which point the run is paid for), and `api_metrics` — the one
 * mid-stream cost-adjacent event — is TTFT/output-token metering that carries no USD at all (verified
 * against the staged agent binary; see `CostInfo.raw` in types.ts). History is the only thing available
 * before the spend, so history is what this uses.
 *
 * Degrades LOUDLY, never silently: with no priced history there is nothing to compare against, so it
 * says so and proceeds rather than either blocking a first run or pretending the cap is enforced. That
 * mirrors the batch lane's own missing-telemetry degradation in `runRepeatBatch`.
 */
export function preflightBudget(command: string, scenario: string, maxBudgetUsd: number, json: boolean): void {
  const history = scenarioCostHistory(readIndex(runsRoot()), scenario);
  if (history.length === 0) {
    log(
      `::warning:: --max-budget-usd: no priced run history for "${scenario}" — cannot pre-flight this run, proceeding UNCAPPED. ` +
        `(A single run has no mid-run cost signal to abort on; the cap becomes enforceable once this scenario has run once.)`,
    );
    return;
  }
  // The WORST observed cost, not the median: this is a refusal gate, and an estimate that under-predicts
  // lets through exactly the expensive run the flag was reached for.
  const worst = Math.max(...history);
  if (worst > maxBudgetUsd)
    fail(
      command,
      "runtime",
      `--max-budget-usd $${maxBudgetUsd.toFixed(4)} refused before spending: "${scenario}" has cost up to $${worst.toFixed(4)} across ${history.length} prior run(s).`,
      `Raise the cap, or drop --max-budget-usd to run anyway. This is a PRE-flight estimate from history — a single run cannot be aborted mid-flight on cost (no live cost signal exists).`,
      json,
    );
}

/** Running-total enforcement across a `record` batch. See `batchBudgetTracker`. */
export interface BatchBudgetTracker {
  /** True once the cap is reached — remaining items must be skipped, not run. Always false when the
   *  running total is not enforceable (concurrency > 1, or telemetry went missing). */
  stopped(): boolean;
  /** Fold one completed run's cost in. `undefined` = the run reported no cost telemetry. */
  add(costUsd: number | undefined): void;
  /** Post-batch line when the cap cut the batch short, else undefined. */
  summary(completed: number, total: number): string | undefined;
}

/**
 * Running-total abort for a `record` batch — **only meaningful at `--concurrency 1`**.
 *
 * Above that, N runs are in flight when any one lands, so the total is only known after the overshoot
 * has already been paid for. An abort that fires then is not a cap, and shipping it as one would be a
 * false guarantee — so `enforceRunningTotal` is false there and the caller says so out loud instead.
 *
 * Missing cost telemetry disables the running total (loudly, once) rather than silently treating an
 * unpriced run as $0 — the same degradation `runRepeatBatch` performs on the `run --repeat` lane.
 */
export function batchBudgetTracker(
  maxBudgetUsd: number | undefined,
  enforceRunningTotal: boolean,
  onWarn: (s: string) => void = log,
): BatchBudgetTracker {
  let cumulative = 0;
  let telemetryMissing = false;
  let warned = false;
  return {
    stopped: () => maxBudgetUsd !== undefined && enforceRunningTotal && !telemetryMissing && cumulative >= maxBudgetUsd,
    add(costUsd) {
      if (maxBudgetUsd === undefined || !enforceRunningTotal) return;
      if (costUsd === undefined) {
        telemetryMissing = true;
        if (!warned) {
          onWarn(
            `::warning:: --max-budget-usd unenforceable: a run reported no cost telemetry — continuing this batch without a running-total cap`,
          );
          warned = true;
        }
        return;
      }
      cumulative += costUsd;
    },
    summary(completed, total) {
      if (!this.stopped() || completed >= total) return undefined;
      return (
        `::warning:: --max-budget-usd stopped the record batch early (${completed}/${total} recorded, $${cumulative.toFixed(4)} spent) — ` +
        `the remaining scenario(s) have NO cassette; this is an incomplete batch, not a failure by itself`
      );
    },
  };
}

/** Summed worst-case cost of a batch, plus the scenarios that contributed nothing because they have no
 *  priced history. Pure (a history lookup, no spend), which is why it is safe to report unconditionally.
 *
 *  Split out of `preflightBatchBudget` so the number can be SHOWN, not only used to refuse. It was
 *  previously computed and discarded unless it happened to exceed a cap, so the only way to learn what a
 *  batch would cost was to bisect `--max-budget-usd` — reported by a consumer who had to do exactly
 *  that to size a 24-scenario re-record. */
export function estimateBatchCost(scenarios: string[]): {
  known: number;
  unpriced: string[];
  /** Total priced runs behind the estimate, and the count for the THINNEST priced scenario. Reported
   *  because the number alone reads as a bound and is not one: it is a max over whatever this machine
   *  happens to have run. One prior run on a scenario is a single sample, not a worst case. */
  pricedRuns: number;
  thinnest: number | undefined;
} {
  let known = 0;
  let pricedRuns = 0;
  let thinnest: number | undefined;
  const unpriced: string[] = [];
  for (const s of scenarios) {
    const worst = worstObservedCost(s);
    if (worst === undefined) {
      unpriced.push(s);
      continue;
    }
    known += worst;
    const n = pricedRunCount(s);
    pricedRuns += n;
    thinnest = thinnest === undefined ? n : Math.min(thinnest, n);
  }
  return { known, unpriced, pricedRuns, thinnest };
}

/** The one-line estimate, phrased so a partially-unpriced total can never read as authoritative. An
 *  unqualified "$0.00" over a corpus that has never run is worse than no number at all. */
export function batchCostEstimateLine(
  scenarios: string[],
  est: { known: number; unpriced: string[]; pricedRuns?: number; thinnest?: number | undefined },
): string {
  const bound = est.unpriced.length ? " — LOWER BOUND" : "";
  const detail = est.unpriced.length
    ? ` (${est.unpriced.length}/${scenarios.length} scenario(s) have no priced run history and contribute $0: ` +
      `${est.unpriced.slice(0, 5).join(", ")}${est.unpriced.length > 5 ? `, +${est.unpriced.length - 5} more` : ""})`
    : // The complete case used to read `(all N scenario(s) priced from prior runs)`, which is an active
      // claim of authority — and the one case where this line said nothing qualifying. It is still
      // `sum(max(local history))`: a max over whatever THIS machine ran, so at a new baseline or a new
      // agent binary the history describes a materially different configuration and can UNDER-predict.
      // A consumer wrote "that is the ceiling, not the scope" into a plan off this line and had to retract.
      ` (all ${scenarios.length} scenario(s) priced)`;
  const basis =
    est.thinnest === undefined
      ? ""
      : ` — basis: ${est.pricedRuns} prior run(s) on THIS machine, thinnest scenario has ${est.thinnest}; ` +
        `a max over that history, NOT a bound`;
  return `estimated batch cost: $${est.known.toFixed(4)}${bound}${detail}${basis}`;
}

/**
 * Cumulative pre-flight for a `record` BATCH: refuse before spending anything if the summed worst-case
 * cost of every resolved scenario exceeds the cap.
 *
 * Different question from `preflightBudget`'s, deliberately. A per-scenario cap on a 16-scenario batch
 * permits 16x the number the user typed, which is not what "don't let a re-record batch surprise me"
 * means. `run --repeat` already reads `--max-budget-usd` cumulatively (see cli.ts's flag help), so this
 * is the established reading of the flag applied to the other batch lane, not a new one.
 *
 * Unpriced scenarios contribute 0 and are NAMED in the degradation warning: on a batch, "some of these
 * have no history" is a materially weaker statement than the single-run case and must not be reported
 * with the same sentence.
 */
export function preflightBatchBudget(command: string, scenarios: string[], maxBudgetUsd: number, json: boolean): void {
  const { known, unpriced } = estimateBatchCost(scenarios);
  if (unpriced.length)
    log(
      `::warning:: --max-budget-usd: ${unpriced.length}/${scenarios.length} scenario(s) have no priced run history and contribute $0 to the estimate ` +
        `(${unpriced.slice(0, 5).join(", ")}${unpriced.length > 5 ? `, +${unpriced.length - 5} more` : ""}) — ` +
        `the batch total below is a LOWER BOUND, so the cap is weaker than it looks until those have run once.`,
    );
  // Report the total on the PASSING path too. A cap that silently permits tells the user nothing about
  // how close they came, and deriving the number by bisecting the cap is not a workflow.
  if (known <= maxBudgetUsd)
    log(`::notice:: --max-budget-usd $${maxBudgetUsd.toFixed(4)}: ${batchCostEstimateLine(scenarios, { known, unpriced })}`);
  if (known > maxBudgetUsd)
    fail(
      command,
      "runtime",
      `--max-budget-usd $${maxBudgetUsd.toFixed(4)} refused before spending: this batch of ${scenarios.length} scenario(s) has cost up to $${known.toFixed(4)} in prior runs.`,
      `Raise the cap, narrow the batch, or drop --max-budget-usd to run anyway. This is a PRE-flight estimate summed from per-scenario history — costs are not abortable mid-run (no live cost signal exists).`,
      json,
    );
}
