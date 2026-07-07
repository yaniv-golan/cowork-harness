import type { TimelineEvent } from "../agent/timeline.js";

/**
 * Pairs each `tool_use` with its `tool_result` by `toolUseId` and aggregates the wall-gap between them
 * per tool name. A `tool_use` with no `toolUseId`, or one with no matching `tool_result` in this
 * timeline (e.g. the run ended mid-call), contributes no duration data — it's silently excluded, not
 * an error; the tool's call is still visible via `RunResult.toolCounts`.
 *
 * Honesty caveat: this includes
 * model latency between the tool_use emission and the result being observed — a wall gap, not isolated
 * script CPU time. The SDK stream carries no runtime-side exec start/end stamp, so this is the best
 * available signal, not a truer one.
 */
export function foldToolDurations(timeline: TimelineEvent[]): Record<string, { calls: number; totalMs: number; maxMs: number }> {
  const pending = new Map<string, { name: string; ts: number }>();
  const out: Record<string, { calls: number; totalMs: number; maxMs: number }> = {};
  for (const ev of timeline) {
    if (ev.type === "tool_use" && ev.toolUseId) {
      pending.set(ev.toolUseId, { name: ev.name, ts: ev.ts });
    } else if (ev.type === "tool_result" && ev.toolUseId) {
      const start = pending.get(ev.toolUseId);
      if (!start) continue;
      pending.delete(ev.toolUseId);
      const callMs = ev.ts - start.ts;
      const bucket = out[start.name] ?? { calls: 0, totalMs: 0, maxMs: 0 };
      bucket.calls += 1;
      bucket.totalMs += callMs;
      bucket.maxMs = Math.max(bucket.maxMs, callMs);
      out[start.name] = bucket;
    }
  }
  return out;
}

export interface SkillActivityEntry {
  skillId: string;
  invocationSeq: number;
  toolCounts: Record<string, number>;
  toolCallCount: number;
  dispatchCount: number;
  durationMs?: number;
}

/**
 * Groups CONSECUTIVE (in seq order) timeline entries sharing the same `skillScope` into one window —
 * NOT a merge-by-value across the whole timeline, since the same skill invoked twice with something
 * else in between is two separate invocations (windows are sequential, never re-opened).
 * `invocationSeq` is the seq of the window's first entry (for a real skill window that IS the Skill
 * tool_use itself; for "(root)", it's simply the first entry's seq — there's no literal invocation).
 * `durationMs` is the window's last-entry-ts minus first-entry-ts; `undefined` is never produced here
 * (every entry always has a `ts`) but the field stays optional to match `RunResult.skillActivity`'s
 * declared shape for parity with `toolDurations`'s convention.
 * A window's `toolCounts`/`toolCallCount` include tool calls made by any sub-agent dispatched during
 * that window (parented `tool_use` events inherit the window's `skillScope`), not just literal
 * top-level calls — matching `foldToolDurations`'s same subagent-inclusive scope above.
 * A `tool_use` with no `toolUseId` is a synthetic MCP round-trip echo (the real call already arrived
 * as an assistant `tool_use` block with a `toolUseId`) and is excluded, mirroring `foldToolDurations`'s
 * de-facto exclusion (it only pairs entries that have a `toolUseId`) and `run.ts`'s top-level
 * `toolCounts` (`else if (!ev.synthetic)`) — otherwise a bogus `mcp__*` key could appear here that no
 * other RunResult field shows, and `skill_tool_used` could false-pass against the echo alone.
 */
export function foldSkillActivity(timeline: TimelineEvent[]): SkillActivityEntry[] {
  const windows: (SkillActivityEntry & { startTs: number; endTs: number })[] = [];
  let current: (SkillActivityEntry & { startTs: number; endTs: number }) | undefined;
  for (const ev of timeline) {
    if (ev.type !== "tool_use" && ev.type !== "subagent_dispatch") continue;
    if (ev.type === "tool_use" && !ev.toolUseId) continue; // synthetic MCP echo — no toolUseId, already counted via the real tool_use block
    const skillId = ev.skillScope ?? "(root)";
    if (!current || current.skillId !== skillId) {
      current = { skillId, invocationSeq: ev.seq, toolCounts: {}, toolCallCount: 0, dispatchCount: 0, startTs: ev.ts, endTs: ev.ts };
      windows.push(current);
    }
    current.endTs = ev.ts;
    if (ev.type === "tool_use") {
      current.toolCounts[ev.name] = (current.toolCounts[ev.name] ?? 0) + 1;
      current.toolCallCount++;
    } else {
      current.dispatchCount++;
    }
  }
  return windows.map(({ startTs, endTs, ...rest }) => ({ ...rest, durationMs: endTs - startTs }));
}

/** Denormalizes each subagent's attributed skill window from the matching TimelineEvent —
 *  looked up by toolUseId, mirroring the existing tool-result/output pairing pattern in run.ts. Pure,
 *  non-mutating (returns new objects) so callers can use it directly in an assembleRunResult literal. */
export function attributeSubagentSkills<T extends { toolUseId: string }>(
  subagents: T[],
  timeline: TimelineEvent[],
): (T & { attributedSkillId?: string })[] {
  const byToolUseId = new Map<string, string | undefined>();
  for (const ev of timeline) if (ev.type === "subagent_dispatch") byToolUseId.set(ev.toolUseId, ev.skillScope);
  return subagents.map((sa) => ({ ...sa, attributedSkillId: byToolUseId.get(sa.toolUseId) }));
}
