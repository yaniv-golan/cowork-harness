import type { TimelineEvent } from "../agent/timeline.js";

/**
 * Pairs each `tool_use` with its `tool_result` by `toolUseId` and aggregates the wall-gap between them
 * per tool name. A `tool_use` with no `toolUseId`, or one with no matching `tool_result` in this
 * timeline (e.g. the run ended mid-call), contributes no duration data — it's silently excluded, not
 * an error; the tool's call is still visible via `RunResult.toolCounts`.
 *
 * Honesty caveat (see docs/internal/2026-07-05-full-scope-implementation-plan.md §4.2): this includes
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
 * else in between is two separate invocations (§5.2 rule 4: windows are sequential, never re-opened).
 * `invocationSeq` is the seq of the window's first entry (for a real skill window that IS the Skill
 * tool_use itself; for "(root)", it's simply the first entry's seq — there's no literal invocation).
 * `durationMs` is the window's last-entry-ts minus first-entry-ts; `undefined` is never produced here
 * (every entry always has a `ts`) but the field stays optional to match `RunResult.skillActivity`'s
 * declared shape for parity with `toolDurations`'s convention.
 */
export function foldSkillActivity(timeline: TimelineEvent[]): SkillActivityEntry[] {
  const windows: (SkillActivityEntry & { startTs: number; endTs: number })[] = [];
  let current: (SkillActivityEntry & { startTs: number; endTs: number }) | undefined;
  for (const ev of timeline) {
    if (ev.type !== "tool_use" && ev.type !== "subagent_dispatch") continue;
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
