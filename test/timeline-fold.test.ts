import { describe, it, expect } from "vitest";
import { foldToolDurations } from "../src/run/timeline-fold.js";
import type { TimelineEvent } from "../src/agent/timeline.js";

function ev(partial: Partial<TimelineEvent> & Pick<TimelineEvent, "type">): TimelineEvent {
  return { seq: 0, ts: 0, line: 0, ...partial } as TimelineEvent;
}

describe("foldToolDurations", () => {
  it("pairs a tool_use with its tool_result by toolUseId and computes the call duration", () => {
    const timeline: TimelineEvent[] = [
      ev({ type: "tool_use", ts: 100, toolUseId: "t1", name: "Bash" }),
      ev({ type: "tool_result", ts: 340, toolUseId: "t1", isError: false }),
    ];
    expect(foldToolDurations(timeline)).toEqual({ Bash: { calls: 1, totalMs: 240, maxMs: 240 } });
  });

  it("aggregates multiple calls to the same tool: calls/totalMs/maxMs", () => {
    const timeline: TimelineEvent[] = [
      ev({ type: "tool_use", ts: 0, toolUseId: "t1", name: "Read" }),
      ev({ type: "tool_result", ts: 50, toolUseId: "t1", isError: false }),
      ev({ type: "tool_use", ts: 100, toolUseId: "t2", name: "Read" }),
      ev({ type: "tool_result", ts: 300, toolUseId: "t2", isError: false }),
    ];
    expect(foldToolDurations(timeline)).toEqual({ Read: { calls: 2, totalMs: 250, maxMs: 200 } });
  });

  it("keeps different tool names in separate buckets", () => {
    const timeline: TimelineEvent[] = [
      ev({ type: "tool_use", ts: 0, toolUseId: "t1", name: "Bash" }),
      ev({ type: "tool_result", ts: 10, toolUseId: "t1", isError: false }),
      ev({ type: "tool_use", ts: 20, toolUseId: "t2", name: "Read" }),
      ev({ type: "tool_result", ts: 25, toolUseId: "t2", isError: false }),
    ];
    expect(foldToolDurations(timeline)).toEqual({
      Bash: { calls: 1, totalMs: 10, maxMs: 10 },
      Read: { calls: 1, totalMs: 5, maxMs: 5 },
    });
  });

  it("excludes an unpaired tool_use (no matching tool_result — e.g. the run ended mid-call)", () => {
    const timeline: TimelineEvent[] = [ev({ type: "tool_use", ts: 0, toolUseId: "t1", name: "Bash" })];
    expect(foldToolDurations(timeline)).toEqual({});
  });

  it("excludes a tool_use with no toolUseId (cannot be paired reliably)", () => {
    const timeline: TimelineEvent[] = [
      ev({ type: "tool_use", ts: 0, name: "Bash" }),
      ev({ type: "tool_result", ts: 10, toolUseId: "t1", isError: false }),
    ];
    expect(foldToolDurations(timeline)).toEqual({});
  });

  it("returns {} for an empty timeline", () => {
    expect(foldToolDurations([])).toEqual({});
  });

  it("ignores non-tool_use/tool_result event types", () => {
    const timeline: TimelineEvent[] = [
      ev({ type: "thinking" }),
      ev({ type: "tool_use", ts: 0, toolUseId: "t1", name: "Bash" }),
      ev({ type: "result", isError: false }),
      ev({ type: "tool_result", ts: 5, toolUseId: "t1", isError: false }),
    ];
    expect(foldToolDurations(timeline)).toEqual({ Bash: { calls: 1, totalMs: 5, maxMs: 5 } });
  });
});
