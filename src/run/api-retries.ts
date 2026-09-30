import type { RunResult } from "../types.js";

/** Fold the agent's own API retries out of the system events a run observed. The agent emits one `system`
 *  frame with `subtype: "api_retry"` per retried model call (carrying `attempt`, `max_retries`,
 *  `retry_delay_ms`, `error_status`, `error`); the stream parser surfaces it as a `system_event`, which the
 *  run keeps in `contextEvents`. Every frame counts; `delayMs` sums the numeric `retry_delay_ms` values.
 *
 *  `undefined` when no stream was observed (`contextEvents` absent); `{count: 0, delayMs: 0}` when one was
 *  and it held no retry — the two must stay distinct, or "no retries" and "could not tell" read alike. */
export function apiRetriesFrom(
  contextEvents: ReadonlyArray<{ subtype: string; data?: Record<string, unknown> }> | undefined,
): RunResult["apiRetries"] {
  if (!contextEvents) return undefined;
  let count = 0;
  let delayMs = 0;
  for (const e of contextEvents) {
    if (e.subtype !== "api_retry") continue;
    count++;
    const d = e.data?.retry_delay_ms;
    if (typeof d === "number" && Number.isFinite(d) && d > 0) delayMs += d;
  }
  return { count, delayMs };
}
