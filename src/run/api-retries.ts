import type { RunResult } from "../types.js";

/** Fold the agent's retried model calls into `RunResult.apiRetries`, keeping the main loop and sub-agents
 *  apart.
 *
 *  - Main loop: one `system` frame with `subtype: "api_retry"` per retry (`attempt`, `max_retries`,
 *    `retry_delay_ms`, `error_status`, `error`), surfaced by the parser as a `system_event` in
 *    `contextEvents`. `delayMs` sums their `retry_delay_ms`: the main loop is sequential, so this is time
 *    the run really spent waiting.
 *  - Sub-agents: tallied by `Run` from `tool_progress` frames carrying `subagent_retry`. Kept separate
 *    because sub-agents run concurrently: their delays overlap in time, so `subagentDelayMs` is summed
 *    backoff across agents, not wall-clock time, and must never be added to `delayMs`.
 *
 *  `undefined` unless BOTH sides were observed (a record that was never driven carries neither); all
 *  zeros = observed, and no retry of either kind. */
export function apiRetriesFrom(
  contextEvents: ReadonlyArray<{ subtype: string; data?: Record<string, unknown> }> | undefined,
  subagentRetries: { count: number; delayMs: number } | undefined,
): RunResult["apiRetries"] {
  if (!contextEvents || !subagentRetries) return undefined;
  let count = 0;
  let delayMs = 0;
  for (const e of contextEvents) {
    if (e.subtype !== "api_retry") continue;
    count++;
    const d = e.data?.retry_delay_ms;
    if (typeof d === "number" && Number.isFinite(d) && d > 0) delayMs += d;
  }
  return { count, delayMs, subagentCount: subagentRetries.count, subagentDelayMs: subagentRetries.delayMs };
}
