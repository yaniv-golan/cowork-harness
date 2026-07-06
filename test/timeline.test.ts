import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toTimelineFields, TimelineWriter, type TimelineHeader, type TimelineEvent } from "../src/agent/timeline.js";
import type { AgentEvent } from "../src/agent/session.js";

describe("toTimelineFields", () => {
  it("maps a tool_use event", () => {
    const ev: AgentEvent = {
      type: "tool_use",
      name: "Bash",
      input: { command: "echo hi" },
      toolUseId: "toolu_1",
      parentToolUseId: undefined,
    };
    expect(toTimelineFields(ev)).toEqual({ type: "tool_use", toolUseId: "toolu_1", name: "Bash", parentToolUseId: undefined });
  });

  it("carries model onto a tool_use event when the AgentEvent has one", () => {
    const fields = toTimelineFields({
      type: "tool_use",
      name: "Bash",
      input: { command: "x" },
      toolUseId: "toolu_1",
      model: "claude-sonnet-4-5",
    });
    expect(fields).toEqual({
      type: "tool_use",
      toolUseId: "toolu_1",
      name: "Bash",
      parentToolUseId: undefined,
      model: "claude-sonnet-4-5",
    });
  });

  it("omits model from a tool_use event when the AgentEvent has none (undefined, not a dropped key vs a present-but-undefined key — both serialize identically to JSON)", () => {
    const fields = toTimelineFields({ type: "tool_use", name: "Bash", input: { command: "x" }, toolUseId: "toolu_1" });
    expect((fields as any).model).toBeUndefined();
  });

  it("maps a tool_result event", () => {
    const ev: AgentEvent = { type: "tool_result", toolUseId: "toolu_1", isError: false, text: "ok" };
    expect(toTimelineFields(ev)).toEqual({ type: "tool_result", toolUseId: "toolu_1", isError: false });
  });

  it("maps a subagent_dispatch event", () => {
    const ev: AgentEvent = {
      type: "subagent_dispatch",
      toolUseId: "toolu_2",
      parentToolUseId: undefined,
      agentType: "general-purpose",
      declaredTools: [],
    };
    expect(toTimelineFields(ev)).toEqual({
      type: "subagent_dispatch",
      toolUseId: "toolu_2",
      parentToolUseId: undefined,
      agentType: "general-purpose",
    });
  });

  it("maps a thinking event", () => {
    const ev: AgentEvent = { type: "thinking", text: "reasoning..." };
    expect(toTimelineFields(ev)).toEqual({ type: "thinking" });
  });

  it("maps a decision event, carrying only the request kind", () => {
    const ev: AgentEvent = { type: "decision", request: { id: "d1", kind: "permission", tool: "Bash", input: {} } };
    expect(toTimelineFields(ev)).toEqual({ type: "decision", kind: "permission" });
  });

  it("maps a result event", () => {
    const ev: AgentEvent = { type: "result", isError: false };
    expect(toTimelineFields(ev)).toEqual({ type: "result", isError: false });
  });

  it("returns undefined for event types with no timeline-relevant signal yet (init/assistant_text/metrics/error/raw)", () => {
    expect(toTimelineFields({ type: "init", tools: [], mcpServers: [], skills: [] })).toBeUndefined();
    expect(toTimelineFields({ type: "assistant_text", text: "hi" })).toBeUndefined();
    expect(toTimelineFields({ type: "metrics", data: {} })).toBeUndefined();
    expect(toTimelineFields({ type: "error", source: "protocol", message: "x" })).toBeUndefined();
    expect(toTimelineFields({ type: "raw", line: "x" })).toBeUndefined();
  });
});

describe("TimelineWriter", () => {
  function tmp(): string {
    return mkdtempSync(join(tmpdir(), "timeline-test-"));
  }

  it("writes a header line first, with v:1 and both start-time anchors", () => {
    const outDir = tmp();
    const w = new TimelineWriter(outDir);
    return new Promise<void>((resolve) => {
      w.end(() => {
        const lines = readFileSync(join(outDir, "timeline.jsonl"), "utf8").trim().split("\n");
        const header: TimelineHeader = JSON.parse(lines[0]);
        expect(header.v).toBe(1);
        expect(typeof header.startedAtWall).toBe("string");
        expect(new Date(header.startedAtWall).toString()).not.toBe("Invalid Date");
        expect(typeof header.startedAtMono).toBe("string");
        expect(() => BigInt(header.startedAtMono)).not.toThrow();
        resolve();
      });
    });
  });

  it("records a mappable event with seq 0, a non-negative ts, and the given line index", () => {
    const outDir = tmp();
    const w = new TimelineWriter(outDir);
    const entry = w.record({ type: "tool_use", name: "Bash", input: {}, toolUseId: "toolu_1" }, 0);
    expect(entry).toMatchObject({ seq: 0, line: 0, type: "tool_use", toolUseId: "toolu_1", name: "Bash" });
    expect(entry!.ts).toBeGreaterThanOrEqual(0);
    return new Promise<void>((resolve) => {
      w.end(() => {
        const lines = readFileSync(join(outDir, "timeline.jsonl"), "utf8").trim().split("\n");
        expect(lines).toHaveLength(2); // header + 1 entry
        const written: TimelineEvent = JSON.parse(lines[1]);
        expect(written).toEqual(entry);
        resolve();
      });
    });
  });

  it("returns undefined and writes nothing for an unmappable event (e.g. assistant_text)", () => {
    const outDir = tmp();
    const w = new TimelineWriter(outDir);
    const entry = w.record({ type: "assistant_text", text: "hi" }, 0);
    expect(entry).toBeUndefined();
    return new Promise<void>((resolve) => {
      w.end(() => {
        const lines = readFileSync(join(outDir, "timeline.jsonl"), "utf8").trim().split("\n");
        expect(lines).toHaveLength(1); // header only
        resolve();
      });
    });
  });

  it("seq increments only across MAPPABLE events, skipping unmappable ones — two events on the same line share that line but get distinct, consecutive seq values", () => {
    const outDir = tmp();
    const w = new TimelineWriter(outDir);
    const first = w.record({ type: "tool_use", name: "Agent", input: { subagent_type: "general-purpose" }, toolUseId: "toolu_3" }, 5);
    const skipped = w.record({ type: "assistant_text", text: "narrating" }, 5);
    const second = w.record({ type: "subagent_dispatch", toolUseId: "toolu_3", agentType: "general-purpose", declaredTools: [] }, 5);
    expect(first).toMatchObject({ seq: 0, line: 5 });
    expect(skipped).toBeUndefined();
    expect(second).toMatchObject({ seq: 1, line: 5 });
  });

  it("stamps skillScope='(root)' on tool_use/subagent_dispatch entries before any Skill call", () => {
    const outDir = tmp();
    const w = new TimelineWriter(outDir);
    const e1 = w.record({ type: "tool_use", name: "Read", input: {}, toolUseId: "t1" }, 0);
    expect(e1).toMatchObject({ skillScope: "(root)" });
  });

  it("opens a new sticky window on a top-level Skill tool_use, attributing the Skill call itself to the NEW window", () => {
    const outDir = tmp();
    const w = new TimelineWriter(outDir);
    const e1 = w.record({ type: "tool_use", name: "Skill", input: { skill: "my-plugin:my-skill" }, toolUseId: "t1" }, 0);
    expect(e1).toMatchObject({ skillScope: "my-plugin:my-skill" });
  });

  it("attributes subsequent top-level tool_use entries to the sticky window until the next Skill call", () => {
    const outDir = tmp();
    const w = new TimelineWriter(outDir);
    w.record({ type: "tool_use", name: "Skill", input: { skill: "a" }, toolUseId: "t1" }, 0);
    const e2 = w.record({ type: "tool_use", name: "Bash", input: {}, toolUseId: "t2" }, 1);
    expect(e2).toMatchObject({ skillScope: "a" });
    w.record({ type: "tool_use", name: "Skill", input: { skill: "b" }, toolUseId: "t3" }, 2);
    const e4 = w.record({ type: "tool_use", name: "Read", input: {}, toolUseId: "t4" }, 3);
    expect(e4).toMatchObject({ skillScope: "b" }); // sequential, not nested — "a"'s window is fully replaced
  });

  it("stamps a subagent_dispatch AND its children with the sticky window active at dispatch time", () => {
    const outDir = tmp();
    const w = new TimelineWriter(outDir);
    w.record({ type: "tool_use", name: "Skill", input: { skill: "a" }, toolUseId: "t1" }, 0);
    const dispatch = w.record({ type: "subagent_dispatch", toolUseId: "disp1", agentType: "general-purpose", declaredTools: [] }, 1);
    expect(dispatch).toMatchObject({ skillScope: "a" });
    const child = w.record({ type: "tool_use", name: "Read", input: {}, toolUseId: "t3", parentToolUseId: "disp1" }, 2);
    expect(child).toMatchObject({ skillScope: "a" }); // rule 3: child inherits the sticky window (unchanged since the dispatch opened)
  });

  it("a Skill tool_use that is itself parented (inside a sub-agent) does NOT change the top-level sticky window", () => {
    const outDir = tmp();
    const w = new TimelineWriter(outDir);
    const dispatch = w.record({ type: "subagent_dispatch", toolUseId: "disp1", agentType: "general-purpose", declaredTools: [] }, 0);
    expect(dispatch).toMatchObject({ skillScope: "(root)" });
    w.record({ type: "tool_use", name: "Skill", input: { skill: "nested" }, toolUseId: "t1", parentToolUseId: "disp1" }, 1);
    const afterward = w.record({ type: "tool_use", name: "Read", input: {}, toolUseId: "t2" }, 2);
    expect(afterward).toMatchObject({ skillScope: "(root)" }); // top-level window unaffected by a nested Skill call
  });
});
