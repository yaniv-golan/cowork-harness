// The run-outcome rollup. `result` ("did the agent finish?"), `verdict.pass` ("did it satisfy the
// asserts/guards?") and the process exit code are three separate signals that legitimately disagree — a
// fail-severity signal like `outputs_delete` flips the verdict while `result.result` stays "success"
// (docs/scenario.md documents that trap). Every consumer driving an iterative loop has to answer "did this
// iteration deliver something usable?" on every turn, and had to reconstruct it from all three.
//
// This adds no new judgement and no new source of truth: it is a PURE FUNCTION of fields the run already
// carries, so it can never disagree with them. The granular fields stay authoritative; this is ergonomics.
import type { RunResult } from "../types.js";

export type RunOutcome =
  /** The agent or the infrastructure failed. Dominates everything else — an errored run whose verdict
   *  happens to pass is still errored. */
  | "errored"
  /** A no-deliverable signal fired — `stalled`, or `ended_with_question`. **Scope limits worth knowing:**
   *  `ended_with_question` only fires on OPEN-ENDED scenarios (no substantive assertions authored) and
   *  only on the live lane, so (a) a scenario with real assertions can never reach this value however
   *  little it produced, and (b) the same run can classify differently live vs. replay. It is also
   *  warn-severity, so this value legitimately coexists with `verdict.pass: true` and exit 0. */
  | "no_deliverable"
  /** No no-deliverable signal fired, but the verdict failed — e.g. a policy assert or guard tripped. The
   *  case that most needed a name: `result: "success"` + `verdict.pass: false` + exit 1 at once. NOTE:
   *  "delivered" here means "the run reported no stall/question signal", NOT positive evidence that a
   *  deliverable exists — a run failing `file_exists` because nothing was written lands here. */
  | "delivered_with_verdict_fail"
  /** No no-deliverable signal fired and the verdict passed. Same caveat on "delivered" as above. */
  | "delivered_clean";

/** Signals whose meaning already IS "no deliverable was written". Kept as a set so adding a future
 *  no-deliverable signal is a one-line change here rather than a re-derivation of the rollup. */
const NO_DELIVERABLE_SIGNALS = new Set(["stalled", "ended_with_question"]);

/** Roll the result/verdict pair up into one enum. Returns `undefined` when there is no verdict to roll up
 *  (a partial or not-yet-graded result) — never guesses, for the same reason `artifacts` distinguishes
 *  UNAVAILABLE from empty. */
export function deriveOutcome(result: RunResult): RunOutcome | undefined {
  if (result.verdict === undefined) return undefined;
  if (result.result === "error") return "errored";
  if (result.verdict.signals.some((s) => NO_DELIVERABLE_SIGNALS.has(s.code))) return "no_deliverable";
  return result.verdict.pass ? "delivered_clean" : "delivered_with_verdict_fail";
}
