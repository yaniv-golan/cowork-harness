// Shared usage/quota-limit detection, used by both the run lane (src/run/run.ts, on the SDK result event)
// and the decider transport (src/decide/llm-transport.ts, on the `claude -p` envelope). Kept in its own
// module so both can import it without a run↔decide cycle.
//
// Detection is CONJUNCTIVE: HTTP 429 AND a terminal usage-limit message. A bare 429 is ambiguous — it is
// also a transient per-minute/overload window (which the SDK/transport legitimately retries) — so 429 alone
// must NOT be classified as quota exhaustion ("retry after reset"). The message list is the TERMINAL family
// (session/weekly/model/monthly-spend/org limits, out-of-credits, seat/org-disabled) and deliberately
// EXCLUDES advisory strings the agent emits on a SUCCESSFUL turn ("You're close to…", "You're now using
// usage credits") — those never carry is_error+429, but the list stays terminal-only for clarity.

const USAGE_LIMIT_TERMINAL = [
  /\byou'?ve (?:hit|reached) your\b[^.]*\blimit\b/i, // session/weekly/Opus/Sonnet/Fable 5/fast/monthly-spend/org limit
  /\byou'?ve used\b[^.]*\b(?:usage )?limit\b/i, // "You've used your … limit" / "…all your usage limit" (terminal variant)
  /\byou'?re out of usage\b/i, // "You're out of usage credits"
  /\byour org is out of usage\b/i,
  /\bout of usage credits\b/i,
  /\brequires usage credits\b/i, // e.g. "Fable 5 requires usage credits."
  /\bthis service is disabled for your org\b/i,
  /\byour seat type doesn'?t include\b/i,
];

// A TRANSIENT (retryable) 429 window — a per-minute / overload rate limit, NOT quota exhaustion. Even if
// such a message is worded with a "You've hit your …" opener, it must NOT be classified usage_limit (which
// would make it non-retryable and halt a batch). Checked as an exclusion so the terminal-quota families win
// only when the message is not the transient rate-limit/overload kind.
const TRANSIENT_LIMIT = /\brate limit\b|\boverloaded\b|\btry again\b/i;

/** True iff `text` (a result's subtype+message) is a TERMINAL usage/quota-limit message (and NOT a transient
 *  rate-limit/overload). Only meaningful in conjunction with HTTP 429 (a bare 429 is a transient overload). */
export function matchesTerminalUsageLimitText(text: string): boolean {
  if (TRANSIENT_LIMIT.test(text)) return false; // a retryable rate-limit/overload is not quota exhaustion
  return USAGE_LIMIT_TERMINAL.some((re) => re.test(text));
}

/** True iff this is a quota-exhausted usage limit: HTTP 429 AND terminal usage-limit text. `apiErrorStatus`
 *  may be undefined (older agent binaries / envelopes that don't carry it) — then fall back to text-only,
 *  since a terminal usage-limit MESSAGE is itself a strong signal when the status code is unavailable. */
export function isUsageLimit(text: string, apiErrorStatus: number | undefined): boolean {
  if (!matchesTerminalUsageLimitText(text)) return false;
  return apiErrorStatus === undefined || apiErrorStatus === 429;
}

/** `RunResult.decisions[].name` of the row the run lane records when a SUB-AGENT's task failed on a terminal usage
 *  limit (src/run/run.ts). Its `detail` is `{toolUseId?, subagentType?, taskId?, error, prior?}`; the verdict reads it
 *  to name the sub-agent, since the run's `errorSource` (`agent`) does not. */
export const SUBAGENT_USAGE_LIMIT = "subagent_usage_limit";

export interface SubagentUsageLimitDetail {
  toolUseId?: string;
  subagentType?: string;
  taskId?: string;
  /** The sub-agent's own error text, capped. */
  error: string;
  /** The run's error label before the sub-agent's limit upgraded it (`kind / source / subtype`), when it had one. */
  prior?: string;
}

/** The sub-agent usage-limit rows of a run's decisions, oldest first. */
export function subagentUsageLimits(decisions: ReadonlyArray<{ name: string; detail?: unknown }> | undefined): SubagentUsageLimitDetail[] {
  return (decisions ?? []).flatMap((d) => {
    if (d.name !== SUBAGENT_USAGE_LIMIT || !d.detail || typeof d.detail !== "object") return [];
    const x = d.detail as Record<string, unknown>;
    if (typeof x.error !== "string") return [];
    const s = (k: string) => (typeof x[k] === "string" ? { [k]: x[k] as string } : {});
    return [{ ...s("toolUseId"), ...s("subagentType"), ...s("taskId"), error: x.error, ...s("prior") }];
  });
}

/** One line naming the first sub-agent that hit the limit, e.g. `a sub-agent (toolu_…, research) hit a usage/quota
 *  limit: <text>`; undefined when the run has no such row. */
export function describeSubagentUsageLimit(decisions: Parameters<typeof subagentUsageLimits>[0]): string | undefined {
  const all = subagentUsageLimits(decisions);
  if (all.length === 0) return undefined;
  const first = all[0]!;
  const who = [first.toolUseId ?? first.taskId, first.subagentType].filter(Boolean).join(", ");
  const more = all.length > 1 ? ` (${all.length} sub-agent tasks failed this way)` : "";
  const prior = first.prior ? `; the run had already errored as ${first.prior}` : "";
  return `a sub-agent${who ? ` (${who})` : ""} hit a usage/quota limit: ${first.error.replace(/\s+/g, " ").trim()}${more}${prior}`;
}
