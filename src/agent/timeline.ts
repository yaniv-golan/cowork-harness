import { createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";
import type { AgentEvent } from "./session.js";

/** Written once, as the first line of `timeline.jsonl`. `startedAtMono` is the raw start-time
 *  `process.hrtime.bigint()` value, as a string (JSON cannot serialize BigInt) — every entry's `ts`
 *  is milliseconds elapsed since this instant, not wall-clock time. `startedAtWall` is the wall-clock
 *  anchor (ISO string) so absolute times are recoverable from a purely-relative `ts` stream. */
export interface TimelineHeader {
  v: 1;
  startedAtWall: string;
  startedAtMono: string;
}

/**
 * One entry per semantically-relevant `AgentEvent`. Every variant carries:
 * - `seq` — a per-timeline-entry monotonic counter (0, 1, 2, …), the TOTAL ORDER over timeline
 *   entries. NOT the `events.jsonl` line index — one raw line can yield several timeline entries
 *   (e.g. a `tool_use` that is also a sub-agent dispatch), each getting a distinct `seq` but sharing
 *   the same `line`.
 * - `ts` — milliseconds elapsed since `TimelineHeader.startedAtMono` (monotonic clock).
 * - `line` — the 0-based `events.jsonl` line index this entry was derived from, for joining back to
 *   the raw SDK bytes.
 *
 * `skill_invoked`, `task_updated`, `file_changed`, `scratchpad_promoted` are declared here (matching
 * the design's named union) but have NO producer yet — nothing in this milestone emits them. They
 * exist so later milestones (M5 skill attribution, M6 panels) extend `toTimelineFields` without
 * needing a second round of type changes. `file_changed` in particular is confirmed dead-on-arrival:
 * the current agent build has zero stream-message producer sites for file-change events (only
 * hook-callback payloads exist, a different mechanism) — kept only for forward-compatibility with a
 * future SDK build.
 */
export type TimelineEvent =
  | { seq: number; ts: number; line: number; type: "tool_use"; toolUseId?: string; name: string; parentToolUseId?: string; skillScope?: string; model?: string }
  | { seq: number; ts: number; line: number; type: "tool_result"; toolUseId?: string; isError: boolean }
  | { seq: number; ts: number; line: number; type: "subagent_dispatch"; toolUseId: string; parentToolUseId?: string; agentType: string; model?: string; skillScope?: string }
  | { seq: number; ts: number; line: number; type: "skill_invoked"; skillId: string }
  | { seq: number; ts: number; line: number; type: "task_updated"; taskId: string; status: string; subject?: string; activeForm?: string; description?: string; op: "create" | "update" | "delete" }
  | { seq: number; ts: number; line: number; type: "file_changed"; path: string; changeKind: "created" | "modified" | "deleted" }
  | { seq: number; ts: number; line: number; type: "scratchpad_promoted"; from: string; to: string }
  | { seq: number; ts: number; line: number; type: "thinking" }
  | { seq: number; ts: number; line: number; type: "decision"; kind: string }
  | { seq: number; ts: number; line: number; type: "result"; isError: boolean };

/**
 * Distributive over `TimelineEvent`'s union: `T extends unknown ? ... : never` forces TypeScript to
 * apply `Omit` per-member instead of computing `keyof` over the whole union (which would collapse to
 * only the keys shared by every variant). Without this, `Omit<TimelineEvent, ...>` silently drops all
 * variant-specific fields from the type `toTimelineFields`'s return literals are checked against.
 */
export type TimelineFields<T> = T extends unknown ? Omit<T, "seq" | "ts" | "line"> : never;

/**
 * Pure mapping from an already-translated `AgentEvent` to the type-specific fields of the
 * `TimelineEvent` it becomes (everything except `seq`/`ts`/`line`, which only `TimelineWriter` can
 * assign). Returns `undefined` for event types this milestone doesn't record yet (`init`,
 * `assistant_text`, `metrics`, `error`, `raw` carry no timeline-relevant signal today).
 * Exported and pure (no I/O) so it's testable without a real write stream.
 */
export function toTimelineFields(ev: AgentEvent): TimelineFields<TimelineEvent> | undefined {
  switch (ev.type) {
    case "tool_use":
      return { type: "tool_use", toolUseId: ev.toolUseId, name: ev.name, parentToolUseId: ev.parentToolUseId };
    case "tool_result":
      return { type: "tool_result", toolUseId: ev.toolUseId, isError: ev.isError };
    case "subagent_dispatch":
      return { type: "subagent_dispatch", toolUseId: ev.toolUseId, parentToolUseId: ev.parentToolUseId, agentType: ev.agentType };
    case "thinking":
      return { type: "thinking" };
    case "decision":
      return { type: "decision", kind: ev.request.kind };
    case "result":
      return { type: "result", isError: ev.isError };
    default:
      return undefined;
  }
}

/**
 * Writes `timeline.jsonl` in the same directory as `events.jsonl`/`control-out.jsonl` (see
 * `LiveAgentSession`'s constructor). A header line is written immediately on construction; each
 * `record()` call appends at most one entry (or none, if `toTimelineFields` doesn't recognize the
 * event) and returns what it wrote so the caller can (in later milestones) build on it without
 * re-reading the file.
 */
export class TimelineWriter {
  private stream: WriteStream;
  private startMono: bigint;
  private seq = 0;

  constructor(outDir: string) {
    this.stream = createWriteStream(join(outDir, "timeline.jsonl"), { flags: "a" });
    this.startMono = process.hrtime.bigint();
    const header: TimelineHeader = {
      v: 1,
      startedAtWall: new Date().toISOString(),
      startedAtMono: this.startMono.toString(),
    };
    this.stream.write(JSON.stringify(header) + "\n");
  }

  private mono(): number {
    return Number((process.hrtime.bigint() - this.startMono) / 1_000_000n);
  }

  record(ev: AgentEvent, line: number): TimelineEvent | undefined {
    const fields = toTimelineFields(ev);
    if (!fields) return undefined;
    const entry = { seq: this.seq, ts: this.mono(), line, ...fields } as TimelineEvent;
    this.seq++;
    this.stream.write(JSON.stringify(entry) + "\n");
    return entry;
  }

  end(callback: () => void): void {
    this.stream.end(callback);
  }
}
