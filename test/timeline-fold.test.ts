import { describe, it, expect } from "vitest";
import { foldToolDurations, foldSkillActivity, attributeSubagentSkills } from "../src/run/timeline-fold.js";
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

describe("foldSkillActivity", () => {
  it("groups consecutive same-skillScope entries into one window, tallying toolCounts/toolCallCount/dispatchCount", () => {
    const timeline: TimelineEvent[] = [
      ev({ type: "tool_use", seq: 0, ts: 0, skillScope: "(root)", name: "Read" }),
      ev({ type: "tool_use", seq: 1, ts: 10, skillScope: "my-skill", name: "Skill" }),
      ev({ type: "tool_use", seq: 2, ts: 20, skillScope: "my-skill", name: "Bash" }),
      ev({ type: "subagent_dispatch", seq: 3, ts: 30, skillScope: "my-skill", toolUseId: "d1", agentType: "x" }),
    ];
    const activity = foldSkillActivity(timeline);
    expect(activity).toEqual([
      { skillId: "(root)", invocationSeq: 0, toolCounts: { Read: 1 }, toolCallCount: 1, dispatchCount: 0, durationMs: 0 },
      { skillId: "my-skill", invocationSeq: 1, toolCounts: { Skill: 1, Bash: 1 }, toolCallCount: 2, dispatchCount: 1, durationMs: 20 },
    ]);
  });

  it("starts a new window when skillScope changes back to a PREVIOUSLY-seen value (sequential, not merged)", () => {
    const timeline: TimelineEvent[] = [
      ev({ type: "tool_use", seq: 0, ts: 0, skillScope: "a", name: "Read" }),
      ev({ type: "tool_use", seq: 1, ts: 10, skillScope: "b", name: "Bash" }),
      ev({ type: "tool_use", seq: 2, ts: 20, skillScope: "a", name: "Write" }),
    ];
    const activity = foldSkillActivity(timeline);
    expect(activity).toHaveLength(3); // NOT merged into one "a" window — two separate "a" invocations
    expect(activity.map((a) => a.skillId)).toEqual(["a", "b", "a"]);
  });

  it("treats entries with no skillScope (e.g. an older pre-M5 timeline) as belonging to '(root)'", () => {
    const timeline: TimelineEvent[] = [ev({ type: "tool_use", seq: 0, ts: 0, name: "Read" })]; // no skillScope field
    const activity = foldSkillActivity(timeline);
    expect(activity[0].skillId).toBe("(root)");
  });

  it("returns [] for an empty timeline", () => {
    expect(foldSkillActivity([])).toEqual([]);
  });
});

describe("attributeSubagentSkills", () => {
  it("copies each subagent's matching TimelineEvent.subagent_dispatch.skillScope onto attributedSkillId, by toolUseId", () => {
    const timeline: TimelineEvent[] = [
      ev({ type: "subagent_dispatch", seq: 0, ts: 0, skillScope: "my-skill", toolUseId: "d1", agentType: "x" }),
    ];
    const subagents = [{ toolUseId: "d1", agentType: "x", declaredTools: [], toolsUsed: [] }];
    const result = attributeSubagentSkills(subagents, timeline);
    expect(result[0].attributedSkillId).toBe("my-skill");
  });

  it("leaves attributedSkillId undefined when no matching timeline entry exists (e.g. no timeline data)", () => {
    const subagents = [{ toolUseId: "d1", agentType: "x", declaredTools: [], toolsUsed: [] }];
    const result = attributeSubagentSkills(subagents, []);
    expect(result[0].attributedSkillId).toBeUndefined();
  });

  it("does not mutate the input array (returns a new array with new objects)", () => {
    const timeline: TimelineEvent[] = [ev({ type: "subagent_dispatch", seq: 0, ts: 0, skillScope: "x", toolUseId: "d1", agentType: "x" })];
    const subagents = [{ toolUseId: "d1", agentType: "x", declaredTools: [], toolsUsed: [] }];
    const result = attributeSubagentSkills(subagents, timeline);
    expect(result).not.toBe(subagents);
    expect(subagents[0]).not.toHaveProperty("attributedSkillId");
  });
});
