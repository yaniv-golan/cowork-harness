/**
 * The machine-readable record of what `--max-budget-usd` actually enforced on this invocation.
 *
 * A leaf module on purpose: the pre-flights in `budget.ts` WRITE it, and the shared envelope builders in
 * `envelope.ts` READ it. `budget.ts` already imports `envelope.ts` (for `fail`), so the state cannot live
 * in either without a cycle.
 *
 * Why process-level state rather than a value threaded to every emitter: a CLI process runs exactly one
 * command, and the cap is a fact about that invocation, not about any one `RunResult` (a batch cap has no
 * single result to live in). Every JSON document the command prints — the `results[]` envelope, a
 * payload-shaped envelope, or the error envelope — goes through `envelope.ts`, so reading it there puts
 * the marker on every one of them without an emitter being able to forget it. That is the failure this
 * exists to fix: an uncapped run used to be visible only as a stderr line a JSON consumer never parses.
 */

/** One shape, used both as the top-level `budget` key on an envelope and as `error.budget` on a refusal. */
export interface BudgetStatus {
  /** The `--max-budget-usd` value. */
  capUsd: number;
  /** `single`: the cap was compared against each scenario's OWN worst observed cost (`run`, `skill`, a
   *  single-file `record`, and each scenario of `run <dir/>`). `batch`: against the SUM over a `record`
   *  batch (`record <dir/>`, `record --rerecord-stale`). */
  basis: "single" | "batch";
  /** `true`: every scenario had priced history, so the pre-flight compared a real estimate to the cap.
   *  `false` (`single` basis only): at least one scenario had none and ran with NO cap — `unpriced[]` names
   *  them. `"lower_bound"` (`batch` basis only): some scenarios contributed $0 to the summed estimate, so
   *  the cap was checked against a lower bound and is weaker than it looks. */
  enforced: true | false | "lower_bound";
  /** Why the cap is not fully enforced. Present exactly when `enforced !== true`. */
  reason?: "no_history";
  /** `single`: the largest worst-observed cost among the priced scenarios. `batch`: the summed estimate
   *  over the priced ones. Absent when nothing was priced. */
  estimateUsd?: number;
  /** Scenarios with no priced run history in `runsDir`'s index. Empty when `enforced === true`. */
  unpriced: string[];
  /** The runs root whose `index.jsonl` supplied (or failed to supply) the history. */
  runsDir: string;
  /** True when `--run-dir` / `COWORK_HARNESS_RUNS_DIR` moved the runs root off the default — the usual
   *  reason a scenario that HAS run before shows up in `unpriced[]`. */
  runsDirRedirected: boolean;
}

let current: BudgetStatus | undefined;

/** Fold one pre-flight's outcome into the invocation's status. `run <dir/>` pre-flights each scenario on
 *  its own, so this MERGES: the union of `unpriced`, the largest `estimateUsd`, and `enforced` true only
 *  while every scenario so far was priced. A `batch` status replaces rather than merges — it is one
 *  pre-flight over the whole batch. */
export function recordBudgetStatus(s: BudgetStatus): void {
  if (current === undefined || s.basis === "batch" || current.basis === "batch") {
    current = { ...s, unpriced: [...s.unpriced] };
    return;
  }
  const unpriced = [...current.unpriced];
  for (const u of s.unpriced) if (!unpriced.includes(u)) unpriced.push(u);
  const estimates = [current.estimateUsd, s.estimateUsd].filter((e): e is number => e !== undefined);
  const enforced = unpriced.length === 0;
  current = {
    capUsd: s.capUsd,
    basis: "single",
    enforced,
    ...(enforced ? {} : { reason: "no_history" as const }),
    ...(estimates.length ? { estimateUsd: Math.max(...estimates) } : {}),
    unpriced,
    runsDir: s.runsDir,
    runsDirRedirected: s.runsDirRedirected,
  };
}

/** The status to publish, or `undefined` when no pre-flight ran (no `--max-budget-usd`, or a `--repeat`
 *  lane, whose cap is the running total reported in `rollups[].stoppedEarly`). */
export function budgetStatus(): BudgetStatus | undefined {
  return current;
}

/** Test seam: forget any recorded status. */
export function resetBudgetStatus(): void {
  current = undefined;
}
