// The session's turn cap, read in one place. A run whose agent stopped at the session's `agent_max_turns` ends as
// `result: error` (the SDK's `error_max_turns`). For a scenario that sets the cap on purpose (a trigger eval, a
// bounded probe) that is the expected end, and `allow_max_turns: true` makes it a completed run: the verdict raises no
// `result_error`, and `eval` buckets it `turn_cap_allowed`. It never makes the run a success: `result: success` still
// grades the literal result. The verdict (verdict.ts), the classifier (eval/classify.ts) and the `result` key's
// message (assert.ts) all read these two functions, so they cannot disagree.
import type { RunResult } from "../types.js";

/** What the predicate reads. Every field is the run result's own. */
export interface TurnCapEvidence {
  result?: RunResult["result"];
  errorSource?: RunResult["errorSource"];
  resultErrorKind?: RunResult["resultErrorKind"];
  turnCap?: RunResult["turnCap"];
  usage?: { turns?: number };
}

/** The run ended at the session's turn cap: an agent-reported error result (`errorSource: "result"`, kind `agent`, so
 *  a transport, auth or usage-limit end never counts) after at least `turnCap.maxTurns` turns of a cap the session
 *  set. The subtype is not read: an `error_during_execution` at the cap reached it too. */
export function turnCapReached(r: TurnCapEvidence): boolean {
  if (r.result !== "error" || r.errorSource !== "result" || r.resultErrorKind !== "agent") return false;
  if (r.turnCap?.source !== "session") return false;
  const turns = r.usage?.turns;
  return typeof turns === "number" && turns >= r.turnCap.maxTurns;
}

/** Some graded assertion carries `allow_max_turns: true`, alone or beside another key (as `allow_stall` is read). */
export function allowsMaxTurns(assertions: readonly { assertion?: { allow_max_turns?: unknown } }[] | undefined): boolean {
  return (assertions ?? []).some((a) => a.assertion?.allow_max_turns === true);
}

/** The cap was reached and the scenario allowed it: the run completed, and no `result_error` is raised for it. */
export function turnCapAllowed(
  r: TurnCapEvidence,
  assertions: readonly { assertion?: { allow_max_turns?: unknown } }[] | undefined,
): boolean {
  return turnCapReached(r) && allowsMaxTurns(assertions);
}
