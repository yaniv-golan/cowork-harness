import { createWriteStream, readFileSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import type { AgentEvent } from "./session.js";
import { warn } from "../io.js";

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
 * - `line` — the 0-based ordinal of the Nth real stdout message translated from the child process,
 *   NOT a raw index into the full persisted `events.jsonl`/`cassette.events[]` array. `events.jsonl`
 *   also contains harness-injected `_emu`-tagged diagnostic marker lines (`stdin_error`, `spawn_error`,
 *   `control_undelivered` — written from error-handling and control-frame-delivery code outside the
 *   main read loop) that are interleaved with real stdout lines but never counted in `line`. A future
 *   consumer that wants to join `line` back to `cassette.events[]` MUST first filter out any line whose
 *   parsed JSON has an `_emu` key before indexing by `line`, or the join will silently point at the
 *   wrong array element once any `_emu` marker has been written.
 *
 * `skill_invoked`, `task_updated`, `file_changed`, `scratchpad_promoted` are declared here (matching
 * the design's named union) but have NO producer yet — nothing in this milestone emits them. They
 * exist so later milestones (skill attribution, panels) extend `toTimelineFields` without
 * needing a second round of type changes. `file_changed` in particular is confirmed dead-on-arrival:
 * the current agent build has zero stream-message producer sites for file-change events (only
 * hook-callback payloads exist, a different mechanism) — kept only for forward-compatibility with a
 * future SDK build.
 *
 * `scratchpad_promoted` stays unproduced by design, not by omission: giving it a producer would need
 * `toTimelineFields`/`TimelineWriter` to (a) pair a `present_files` tool_use with its own tool_result
 * across two separate calls (an `undefined`-content tool_use event carries no result yet) and (b)
 * classify each pair against the VM cwd — both already implemented once, faithfully, in
 * `Run.notePresentedFiles` (src/run/run.ts), which owns `RunRecord.cwd`. Duplicating that pairing +
 * classification into this per-event, (mostly-)stateless mapper would fork the scratchpad-promotion
 * signal across two independent implementations that could silently drift. `RunResult.presentedFiles`
 * (and the `no_scratchpad_leak` assertion built on it) already give full observability — live AND
 * replay, since both tool_use/tool_result live in the ordinary events stream — with a single source of
 * truth. Revisit only if a consumer needs promotion positioned on the TIMELINE specifically (relative
 * ordering against other tool calls), not just recorded that it happened.
 */
export type TimelineEvent =
  | {
      seq: number;
      ts: number;
      line: number;
      type: "tool_use";
      toolUseId?: string;
      name: string;
      parentToolUseId?: string;
      skillScope?: string;
      model?: string;
    }
  | { seq: number; ts: number; line: number; type: "tool_result"; toolUseId?: string; isError: boolean }
  | {
      seq: number;
      ts: number;
      line: number;
      type: "subagent_dispatch";
      toolUseId: string;
      parentToolUseId?: string;
      dispatchAgentType: string;
      model?: string;
      skillScope?: string;
    }
  | { seq: number; ts: number; line: number; type: "skill_invoked"; skillId: string }
  | {
      seq: number;
      ts: number;
      line: number;
      type: "task_updated";
      taskId: string;
      status: string;
      subject?: string;
      activeForm?: string;
      description?: string;
      op: "create" | "update" | "delete";
    }
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
      return { type: "tool_use", toolUseId: ev.toolUseId, name: ev.name, parentToolUseId: ev.parentToolUseId, model: ev.model };
    case "tool_result":
      return { type: "tool_result", toolUseId: ev.toolUseId, isError: ev.isError };
    case "subagent_dispatch":
      return {
        type: "subagent_dispatch",
        toolUseId: ev.toolUseId,
        parentToolUseId: ev.parentToolUseId,
        dispatchAgentType: ev.dispatchAgentType,
      };
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
  // The sticky ordinal skill-activation window. Only a TOP-LEVEL Skill tool_use changes this —
  // it is deliberately NOT tracked per-toolUseId/frozen-at-dispatch-time: the real agent blocks
  // synchronously on a dispatch's own tool_result while the sub-agent runs (the dispatching turn
  // cannot emit a new top-level tool_use, including a Skill call, until the dispatch's result
  // returns across separate turns), so `currentSkillId` is invariant across the span from a dispatch
  // to all of its children in the common case — a plain live read of this field at each child's
  // arrival already equals whatever value was current when the dispatch itself opened. (Edge case,
  // not guaranteed: a single assistant message that batches a subagent_dispatch tool_use FOLLOWED by
  // a top-level Skill tool_use in the same turn would shift the window between the dispatch and its
  // later-streamed children — an odd, likely-rare model behavior; skillScope is a documented
  // best-effort heuristic, so this is an accepted imprecision, not a correctness bug to guard
  // against with a separate per-dispatch snapshot.)
  private currentSkillId = "(root)";

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

    if (fields.type === "tool_use" || fields.type === "subagent_dispatch") {
      // Rule 1: a top-level Skill tool_use opens a NEW window before it's stamped, so the Skill call
      // itself is attributed to the window it opens, not the one it's replacing.
      if (fields.type === "tool_use" && ev.type === "tool_use" && ev.name === "Skill" && !ev.parentToolUseId) {
        const skillInput = (ev.input as Record<string, unknown> | undefined)?.skill;
        this.currentSkillId = typeof skillInput === "string" ? skillInput : "(unknown)";
      }
      // Rule 2/3: every top-level call AND every dispatch's children stamp with the live sticky
      // window — see the field's doc comment above for why a dispatch's children never need a
      // separately-frozen value.
      (fields as { skillScope?: string }).skillScope = this.currentSkillId;
    }

    const entry = { seq: this.seq, ts: this.mono(), line, ...fields } as TimelineEvent;
    this.seq++;
    this.stream.write(JSON.stringify(entry) + "\n");
    return entry;
  }

  end(callback: () => void): void {
    this.stream.end(callback);
  }
}

function safeLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim());
  } catch (err: unknown) {
    // File-not-found is normal (e.g. an older harness build, or a run that predates this feature) —
    // stay quiet. Any other error (permissions, corrupted inode, etc.) is unexpected and must be loud.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      warn(`::warning:: [timeline] failed to read ${path}: ${String(err)}\n`);
    }
    return [];
  }
}

/**
 * Result of a `readTimeline` call that found SOME `timeline.jsonl` content — as opposed to the file
 * being missing/empty, which `readTimeline` still reports as `undefined` (see below). `header` and
 * `headerCorrupt` are mutually exclusive: a healthy read has `header` set and omits `headerCorrupt`; a
 * header-parse failure sets `headerCorrupt: true` and omits `header` (with `events: []` and
 * `malformedLines: 0`, since no entries could be attributed to a timeline whose header never parsed).
 * `malformedLines` (per-ENTRY corruption, counted separately from header corruption — see #35 below)
 * stays a plain number on the healthy shape so existing callers that already branch on
 * `malformedLines > 0` keep compiling and behaving the same. #43
 */
export interface TimelineReadResult {
  header?: TimelineHeader;
  events: TimelineEvent[];
  malformedLines: number;
  headerCorrupt?: true;
}

/** Reads and parses `timeline.jsonl` (written by `TimelineWriter` above). The first line is the
 *  header, the rest are entries. Returns `undefined` ONLY if the file is missing/empty (an older
 *  harness build, or a run that predates this feature) — genuine feature-absence. If the file EXISTS
 *  but its header line doesn't parse, that is feature-PRESENT-but-corrupt, a materially different
 *  condition for a caller deciding whether to trust derived evidence — so it returns a distinct
 *  `{ headerCorrupt: true, events: [], malformedLines: 0 }` result instead of collapsing to the same
 *  `undefined` a missing file produces (#43; before this fix the two were indistinguishable). Malformed
 *  individual entry lines (header parsed fine, some entry lines didn't) are dropped and counted in
 *  `malformedLines` rather than aborting the whole read. Relocated here (from `src/run/cassette.ts`,
 *  where it originated) so both `src/run/execute.ts` and `src/run/cassette.ts` can import it from a leaf
 *  module with no imports back into `run/`, avoiding an import cycle. Exported for direct unit testing
 *  (test/cassette-timeline.test.ts). */
/** A header line, structurally. `timeline.jsonl` is opened APPEND-mode and a fresh header is written per
 *  turn, so one file holds `[header1, ...turn-1..., header2, ...turn-2...]`.
 *
 *  Keyed on the two fields NO event variant carries. Deliberately not on `v` — an event variant could
 *  plausibly gain a version field, and this predicate silently mis-segmenting is worse than it being a
 *  little verbose. */
function isHeaderLine(o: unknown): o is TimelineHeader {
  if (!o || typeof o !== "object") return false;
  const h = o as TimelineHeader;
  return typeof h.startedAtMono === "string" && typeof h.startedAtWall === "string";
}

/** Header-SHAPED but not a valid header — e.g. `startedAtMono` present as a number.
 *
 *  Without this the fail-safe was one-sided: a mid-file header corrupted in a way that still parses as
 *  JSON silently failed `isHeaderLine`, got swallowed into the event array, and merged two turns with
 *  `malformedLines: 0` — no evidence-unavailable signal, so the false-PASS this fix exists to close
 *  survived that one shape. The FIRST line got a parses-but-not-a-header check; mid-file lines did not.
 *  Counting these as malformed restores the guarantee in both positions. */
function looksLikeBrokenHeader(o: unknown): boolean {
  if (!o || typeof o !== "object") return false;
  if (isHeaderLine(o)) return false;
  const h = o as Record<string, unknown>;
  return "startedAtMono" in h || "startedAtWall" in h;
}

export function readTimeline(outDir: string): TimelineReadResult | undefined {
  const lines = safeLines(join(outDir, "timeline.jsonl"));
  if (lines.length === 0) return undefined;
  let header: TimelineHeader;
  try {
    const first = JSON.parse(lines[0]);
    // A first line that parses but is NOT a header means a head-truncated/garbled file. Previously it was
    // accepted as a bogus header and every subsequent line returned as an event; treat it as corrupt so
    // callers route to evidence-unavailable instead of folding nonsense.
    if (!isHeaderLine(first)) return { events: [], malformedLines: 0, headerCorrupt: true };
    header = first;
  } catch {
    return { events: [], malformedLines: 0, headerCorrupt: true };
  }
  // TURN SCOPING. Return only the LAST segment — the current turn.
  //
  // Before this, every line after the first was returned as an event, so a resumed run (every `--resume`,
  // and EVERY `critique` reflection turn) folded the PRIOR turn's tool calls into the current turn's
  // result. That is not only telemetry noise: `skill_tool_used` (assert.ts) evaluates against
  // `ctx.skillActivity`, which is `foldSkillActivity` over exactly these events — so a turn-1 skill
  // window could satisfy a turn-2 assertion. A FALSE PASS, which is the failure class this project
  // exists to prevent.
  //
  // Reader-side on purpose: the file stays one append-only stream, because `critique`'s turn-1 isolation
  // proof (snapshotTurnBoundary / verifyBoundaryIntegrity) records BYTE OFFSETS into it. Splitting into
  // per-turn files would invalidate a verified integrity mechanism as a side effect of a telemetry fix.
  //
  // A corrupt FIRST header returns headerCorrupt above even when a later header is valid: a file whose
  // head is damaged is not trustworthy to segment. A corrupt MID-FILE header loses that boundary, merging
  // two turns — but it also fails JSON.parse below and so raises `malformedLines`, which the callers
  // already treat as evidence-unavailable. Fail-safe in both directions.
  let segmentStart = 0;
  for (let i = 1; i < lines.length; i++) {
    try {
      if (isHeaderLine(JSON.parse(lines[i]))) {
        segmentStart = i;
        header = JSON.parse(lines[i]);
      }
    } catch {
      /* counted as malformed in the fold below if it falls inside the returned segment */
    }
  }
  const events: TimelineEvent[] = [];
  // Count dropped entry lines: a partially-corrupt timeline (valid header, some unparseable lines) yields
  // an INCOMPLETE event set — a dropped line could be a skill/tool window. The caller uses this to treat
  // the derived skillActivity/toolDurations as evidence-unavailable rather than silently incomplete. #35
  let malformedLines = 0;
  for (const line of lines.slice(segmentStart + 1)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformedLines++;
      continue;
    }
    // A line can be valid JSON and still not be an event. Pushing it anyway put `null`/`42`/a broken
    // header into the event array with NO malformed count: `null` then crashed `foldSkillActivity` with a
    // TypeError during result assembly (aborting the run instead of reporting evidence-unavailable), and
    // a broken header silently merged two turns. Both are now counted, which routes callers to
    // evidence-unavailable — the fail-safe direction.
    if (!parsed || typeof parsed !== "object" || looksLikeBrokenHeader(parsed)) {
      malformedLines++;
      continue;
    }
    events.push(parsed as TimelineEvent);
  }
  return { header, events, malformedLines };
}
