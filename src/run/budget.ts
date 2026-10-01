/**
 * Cost pre-flight for `--max-budget-usd`.
 *
 * Extracted from `cli.ts` so `record` (which lives in `cassette.ts`) can reach it without importing
 * `cli.ts` — `cli.ts` already imports `cmdRecord` FROM `cassette.ts`, so a call in that direction would
 * be a cycle. Everything here is leaf-module-only for the same reason.
 */
import { resolve } from "node:path";
import { tildeify, writeAllSync } from "../io.js";
import { fail, type JsonErrorExtras } from "./envelope.js";
import { readIndex, scenarioCostHistory } from "./run-index.js";
import { defaultRunsHome, runsRoot } from "./trace-view.js";
import { claimRunsDirCauseNote, recordBudgetStatus, type BudgetStatus } from "./budget-status.js";

/** Human-facing line on stderr. `cli.ts` has its own module-scope `log` that is not importable; this is
 *  the same one-liner, kept local so the extraction stays leaf-only. */
const log = (s: string) => writeAllSync(2, s + "\n");

/** Exit code for a `--max-budget-usd` refusal. On `record` it is `1`, like every other pre-spend refusal
 *  of a scenario that loaded, so `2` there always means "did not load" (SPEC.md §11). `skill` and `run`
 *  keep `fail()`'s `runtime` default of `2`. The category stays `runtime` on every command. */
function budgetRefusalExitCode(command: string): 1 | undefined {
  return command === "record" ? 1 : undefined;
}

/** Where the history came from, and whether `--run-dir` / `COWORK_HARNESS_RUNS_DIR` moved it. The flag
 *  works by setting the variable, so the two cannot be told apart here — messages name both. Plain
 *  `resolve` on both sides, never `realpath`: the question is "did the user point somewhere else", and a
 *  symlinked tmpdir (macOS `/tmp` → `/private/tmp`) is not a different answer to it. */
export function runsDirInfo(): { runsDir: string; runsDirRedirected: boolean } {
  const runsDir = runsRoot();
  return { runsDir, runsDirRedirected: resolve(runsDir) !== resolve(defaultRunsHome()) };
}

/** The clause a missing-history warning appends. With a redirected runs root the likeliest cause is not
 *  "this scenario never ran" but "it ran into a different runs root" — the history is keyed by where runs
 *  were WRITTEN, so a fresh `--run-dir` per invocation starts every scenario unpriced, every time.
 *
 *  This is the TEXT only, readable any number of times — a plan payload or a non-exiting check can carry
 *  it without consuming the once-per-process claim `noHistoryCause` uses for stderr. Empty when the runs
 *  root is not redirected. */
export function noHistoryCauseText(): string {
  const { runsDir, runsDirRedirected } = runsDirInfo();
  if (!runsDirRedirected) return "";
  return (
    ` The runs root is redirected to ${tildeify(runsDir)} (--run-dir / COWORK_HARNESS_RUNS_DIR), and priced history is read ` +
    `from that root's index only — reuse one runs dir across invocations so the cap has history to enforce against.`
  );
}

/** `noHistoryCauseText`, at most once per process: `run <dir/>` pre-flights each scenario on its own, and
 *  the cause is the same for every one of them — repeating it per line would bury the scenario names it is
 *  attached to. */
function noHistoryCause(): string {
  const text = noHistoryCauseText();
  if (text === "" || !claimRunsDirCauseNote()) return "";
  return text;
}

/** The error extras a budget refusal carries: `error.code` + `error.budget`, plus any payload findings
 *  the refusal's envelope would otherwise lose. */
function refusalExtras(budget: BudgetStatus, payload?: Record<string, unknown>): JsonErrorExtras {
  return { error: { code: "budget_exceeded", budget }, ...(payload ? { payload } : {}) };
}

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
export function preflightBudget(
  command: string,
  scenario: string,
  maxBudgetUsd: number,
  json: boolean,
  refusalPayload?: Record<string, unknown>,
): void {
  const history = scenarioCostHistory(readIndex(runsRoot()), scenario);
  if (history.length === 0) {
    recordBudgetStatus({
      capUsd: maxBudgetUsd,
      basis: "single",
      enforced: false,
      reason: "no_history",
      unpriced: [scenario],
      ...runsDirInfo(),
    });
    log(
      `::warning:: --max-budget-usd: no priced run history for "${scenario}" — cannot pre-flight this run, proceeding UNCAPPED. ` +
        `(A single run has no mid-run cost signal to abort on; the cap becomes enforceable once this scenario has run once.)` +
        noHistoryCause(),
    );
    return;
  }
  // The WORST observed cost, not the median: this is a refusal gate, and an estimate that under-predicts
  // lets through exactly the expensive run the flag was reached for.
  const worst = Math.max(...history);
  const status: BudgetStatus = {
    capUsd: maxBudgetUsd,
    basis: "single",
    enforced: true,
    estimateUsd: worst,
    unpriced: [],
    ...runsDirInfo(),
  };
  // Recorded BEFORE a refusal can exit, so the top-level `budget` key is on the refusal's envelope too —
  // its presence must not depend on whether an earlier scenario happened to record one.
  recordBudgetStatus(status);
  if (worst > maxBudgetUsd)
    fail(
      command,
      "runtime",
      `--max-budget-usd $${maxBudgetUsd.toFixed(4)} refused before spending: "${scenario}" has cost up to $${worst.toFixed(4)} across ${history.length} prior run(s).`,
      `Raise the cap, or drop --max-budget-usd to run anyway. This is a PRE-flight estimate from history — a single run cannot be aborted mid-flight on cost (no live cost signal exists).`,
      json,
      budgetRefusalExitCode(command),
      undefined,
      refusalExtras(status, refusalPayload),
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

/** One scheduled scenario of a batch: a bare name is one run (`record`), an object carries how many runs
 *  of that scenario the batch schedules (an eval runs every scenario 2 x reps times). */
export type BatchItem = string | { scenario: string; jobs: number };

const itemScenario = (i: BatchItem): string => (typeof i === "string" ? i : i.scenario);
const itemJobs = (i: BatchItem): number => (typeof i === "string" ? 1 : i.jobs);

/** Summed worst-case cost of a batch, plus the scenarios that contributed nothing because they have no
 *  priced history. Pure (a history lookup, no spend), which is why it is safe to report unconditionally.
 *
 *  Each scenario contributes its worst observed cost TIMES its job count (1 for a bare name, so `record`'s
 *  figure is unchanged). The history counts (`pricedRuns`, `thinnest`) describe the basis and are not
 *  multiplied.
 *
 *  Split out of `preflightBatchBudget` so the number can be SHOWN, not only used to refuse. It was
 *  previously computed and discarded unless it happened to exceed a cap, so the only way to learn what a
 *  batch would cost was to bisect `--max-budget-usd` — reported by a consumer who had to do exactly
 *  that to size a 24-scenario re-record. */
export function estimateBatchCost(items: readonly BatchItem[]): {
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
  for (const item of items) {
    const s = itemScenario(item);
    const worst = worstObservedCost(s);
    if (worst === undefined) {
      unpriced.push(s);
      continue;
    }
    known += worst * itemJobs(item);
    const n = pricedRunCount(s);
    pricedRuns += n;
    thinnest = thinnest === undefined ? n : Math.min(thinnest, n);
  }
  return { known, unpriced, pricedRuns, thinnest };
}

/** The one-line estimate, phrased so a partially-unpriced total can never read as authoritative. An
 *  unqualified "$0.00" over a corpus that has never run is worse than no number at all. */
export function batchCostEstimateLine(
  scenarios: readonly BatchItem[],
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

/** The outcome of a batch budget check, with every line the exiting pre-flight would print, so a caller
 *  that must not exit (an eval, which removes temp snapshots in a `finally`) can emit them itself. */
export interface BatchBudgetCheck {
  /** The marker for this check. NOT recorded: `recordBudgetStatus` is the caller's job, before any refusal. */
  status: BudgetStatus;
  /** True when the summed estimate exceeds the cap (strict `>`: a history exactly at the cap never breached it). */
  refuse: boolean;
  estimate: ReturnType<typeof estimateBatchCost>;
  /** The no-history warning, WITHOUT the redirected-runs-root cause clause (append `noHistoryCauseText()`
   *  or let the exiting wrapper add it once per process). Absent when every scenario was priced. */
  noHistoryWarning?: string;
  /** The passing-path notice. Absent on a refusal. */
  notice?: string;
  /** The refusal's message and hint. Present exactly when `refuse`. */
  refusal?: { message: string; hint: string };
}

/** The batch gate's decision, with no side effect: it neither records the budget marker, nor logs, nor
 *  exits. `preflightBatchBudget` is this plus those three, so the two cannot drift apart. */
export function checkBatchBudget(items: readonly BatchItem[], maxBudgetUsd: number): BatchBudgetCheck {
  const estimate = estimateBatchCost(items);
  const { known, unpriced } = estimate;
  const status: BudgetStatus = {
    capUsd: maxBudgetUsd,
    basis: "batch",
    enforced: unpriced.length ? "lower_bound" : true,
    ...(unpriced.length ? { reason: "no_history" as const } : {}),
    ...(unpriced.length < items.length ? { estimateUsd: known } : {}),
    unpriced,
    ...runsDirInfo(),
  };
  const refuse = known > maxBudgetUsd;
  return {
    status,
    refuse,
    estimate,
    ...(unpriced.length
      ? {
          noHistoryWarning:
            `::warning:: --max-budget-usd: ${unpriced.length}/${items.length} scenario(s) have no priced run history and contribute $0 to the estimate ` +
            `(${unpriced.slice(0, 5).join(", ")}${unpriced.length > 5 ? `, +${unpriced.length - 5} more` : ""}) — ` +
            `the batch total below is a LOWER BOUND, so the cap is weaker than it looks until those have run once.`,
        }
      : {}),
    // Report the total on the PASSING path too. A cap that silently permits tells the user nothing about
    // how close they came, and deriving the number by bisecting the cap is not a workflow.
    ...(refuse
      ? {
          refusal: {
            message: `--max-budget-usd $${maxBudgetUsd.toFixed(4)} refused before spending: this batch of ${items.length} scenario(s) has cost up to $${known.toFixed(4)} in prior runs.`,
            hint: `Raise the cap, narrow the batch, or drop --max-budget-usd to run anyway. This is a PRE-flight estimate summed from per-scenario history — costs are not abortable mid-run (no live cost signal exists).`,
          },
        }
      : { notice: `::notice:: --max-budget-usd $${maxBudgetUsd.toFixed(4)}: ${batchCostEstimateLine(items, { known, unpriced })}` }),
  };
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
 *
 * The decision is `checkBatchBudget`'s; this wrapper records the marker, prints, and exits on a refusal.
 */
export function preflightBatchBudget(
  command: string,
  scenarios: readonly BatchItem[],
  maxBudgetUsd: number,
  json: boolean,
  refusalPayload?: Record<string, unknown>,
): void {
  const c = checkBatchBudget(scenarios, maxBudgetUsd);
  recordBudgetStatus(c.status); // before any refusal can exit — see preflightBudget
  if (c.noHistoryWarning !== undefined) log(c.noHistoryWarning + noHistoryCause());
  if (c.notice !== undefined) log(c.notice);
  if (c.refusal)
    fail(
      command,
      "runtime",
      c.refusal.message,
      c.refusal.hint,
      json,
      budgetRefusalExitCode(command),
      undefined,
      // A refusal over a lower bound is still a refusal (the known part alone exceeds the cap), so
      // `enforced` is whatever the estimate was — `unpriced[]` says which scenarios it did not include.
      refusalExtras(c.status, refusalPayload),
    );
}
