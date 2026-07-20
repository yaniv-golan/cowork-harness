// Shared parse for the `--repeat` family. These were parsed inline in `cmdRun`, which is precisely why
// they were `run`-only: the exploratory `skill` lane — where an iterate-across-fixes loop actually lives —
// rejected them as unknown flags. One implementation means the two lanes cannot drift.
//
// Throws `RepeatFlagError` rather than calling `fail()` so it stays a pure, unit-testable function; each
// command catches and routes through its own `fail()` (which owns the exit code and JSON envelope shape).

export class RepeatFlagError extends Error {}

export interface RepeatFlags {
  /** Undefined = no repeat batch; otherwise 2..100. */
  repeatN?: number;
  /** Batch verdict threshold. 1.0 (all must pass) unless `--min-pass-rate` says otherwise. */
  minPassRate: number;
  stopOnDiverge: boolean;
  maxBudgetUsd?: number;
  allowBudgetStop: boolean;
  /** argv with every consumed flag (and its value) removed. */
  rest: string[];
}

function numericValue(args: string[], i: number, flag: string): { value: string | undefined; consumedNext: boolean } {
  const a = args[i]!;
  return a === flag ? { value: args[i + 1], consumedNext: true } : { value: a.slice(flag.length + 1), consumedNext: false };
}

export function parseRepeatFlags(args: string[], command: string): RepeatFlags {
  let repeatN: number | undefined;
  let minPassRate = 1.0;
  let stopOnDiverge = false;
  let maxBudgetUsd: number | undefined;
  let allowBudgetStop = false;
  const rest: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--repeat" || a.startsWith("--repeat=")) {
      const { value, consumedNext } = numericValue(args, i, "--repeat");
      const n = value === undefined ? NaN : Number(value);
      if (!Number.isInteger(n) || n < 2 || n > 100)
        throw new RepeatFlagError(`--repeat requires an integer between 2 and 100 (got ${value === undefined ? "nothing" : `"${value}"`})`);
      repeatN = n;
      if (consumedNext) i++;
    } else if (a === "--min-pass-rate" || a.startsWith("--min-pass-rate=")) {
      const { value, consumedNext } = numericValue(args, i, "--min-pass-rate");
      const v = value === undefined ? NaN : Number(value);
      if (!Number.isFinite(v) || v < 0 || v > 1)
        throw new RepeatFlagError(
          `--min-pass-rate requires a number between 0 and 1 (got ${value === undefined ? "nothing" : `"${value}"`})`,
        );
      minPassRate = v;
      if (consumedNext) i++;
    } else if (a === "--max-budget-usd" || a.startsWith("--max-budget-usd=")) {
      const { value, consumedNext } = numericValue(args, i, "--max-budget-usd");
      const v = value === undefined ? NaN : Number(value);
      if (!Number.isFinite(v) || v <= 0)
        throw new RepeatFlagError(`--max-budget-usd requires a positive number (got ${value === undefined ? "nothing" : `"${value}"`})`);
      maxBudgetUsd = v;
      if (consumedNext) i++;
    } else if (a === "--stop-on-diverge") {
      stopOnDiverge = true;
    } else if (a === "--allow-budget-stop") {
      allowBudgetStop = true;
    } else {
      rest.push(a);
    }
  }

  // Every companion is meaningless without a batch to apply it to — fail loudly rather than silently
  // ignoring a flag the caller clearly meant to have an effect.
  const requiresRepeat = (cond: boolean, flag: string) => {
    if (cond && repeatN === undefined) throw new RepeatFlagError(`${flag} requires --repeat (${command})`);
  };
  requiresRepeat(minPassRate !== 1.0, "--min-pass-rate");
  requiresRepeat(stopOnDiverge, "--stop-on-diverge");
  requiresRepeat(maxBudgetUsd !== undefined, "--max-budget-usd");
  requiresRepeat(allowBudgetStop, "--allow-budget-stop");

  return { repeatN, minPassRate, stopOnDiverge, maxBudgetUsd, allowBudgetStop, rest };
}
