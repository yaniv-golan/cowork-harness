import { describe, it, expect } from "vitest";
import { Run } from "../src/run/run.js";
import type { AgentEvent, AgentSession, DecisionResponse } from "../src/agent/session.js";
import { ScriptedDecider } from "../src/decide/decider.js";

// Minimal in-memory session that yields a scripted event sequence (mirrors classify-result-error.test.ts's
// MockSession, which in turn mirrors seams.test.ts's).
class MockSession implements AgentSession {
  constructor(private events: AgentEvent[]) {}
  async *start(): AsyncIterable<AgentEvent> {
    for (const e of this.events) yield e;
  }
  sendUserTurn() {}
  respond(_id: string, _r: DecisionResponse) {
    return { delivered: true };
  }
  close() {}
}

const drive = (events: AgentEvent[]) => new Run(new MockSession(events), new ScriptedDecider([])).drive("go");

describe("fork-scoped tool_use classification (fork skill / Agent(fork) inner tools count as main-agent work)", () => {
  it("a context:fork skill's inner Bash counts in toolCounts/toolsCalled/toolErrors, NOT subagentTools", async () => {
    const rec = await drive([
      { type: "tool_use", name: "Skill", input: { skill: "probe" }, toolUseId: "S" },
      { type: "tool_use", name: "Bash", input: { command: "echo hi" }, parentToolUseId: "S", toolUseId: "B" },
      { type: "tool_result", toolUseId: "B", isError: false, text: "hi" },
    ]);
    expect(rec.toolCounts.Bash).toBe(1);
    expect(rec.toolsCalled.has("Bash")).toBe(true);
    expect(rec.toolErrors.Bash?.calls).toBe(1);
    expect(rec.subagentTools.has("Bash")).toBe(false);
    expect(rec.subagents.length).toBe(0);
  });

  it("a real Agent dispatch's inner Bash stays isolated in subagentTools, not toolCounts (regression pin)", async () => {
    const rec = await drive([
      { type: "tool_use", name: "Agent", input: { subagent_type: "general-purpose" }, toolUseId: "A" },
      { type: "subagent_dispatch", toolUseId: "A", dispatchAgentType: "general-purpose", declaredTools: [], typeOmitted: false },
      { type: "tool_use", name: "Bash", input: { command: "echo hi" }, parentToolUseId: "A", toolUseId: "B" },
    ]);
    expect(rec.toolCounts.Agent).toBe(1);
    expect(rec.toolCounts.Bash).toBeUndefined();
    expect(rec.subagentTools.has("Bash")).toBe(true);
  });

  it("a nested fork skill (Skill inside Skill) propagates main-agent scope transitively", async () => {
    const rec = await drive([
      { type: "tool_use", name: "Skill", input: { skill: "outer" }, toolUseId: "S" },
      { type: "tool_use", name: "Skill", input: { skill: "inner" }, parentToolUseId: "S", toolUseId: "S2" },
      { type: "tool_use", name: "Bash", input: { command: "echo hi" }, parentToolUseId: "S2", toolUseId: "B" },
    ]);
    expect(rec.toolCounts.Bash).toBe(1);
  });

  it("a fork skill invoked INSIDE a sub-agent does NOT leak into main-agent toolCounts (it inherits the sub-agent's context, not the main agent's)", async () => {
    const rec = await drive([
      { type: "tool_use", name: "Agent", input: { subagent_type: "general-purpose" }, toolUseId: "A" },
      { type: "subagent_dispatch", toolUseId: "A", dispatchAgentType: "general-purpose", declaredTools: [], typeOmitted: false },
      { type: "tool_use", name: "Skill", input: { skill: "probe" }, parentToolUseId: "A", toolUseId: "S" },
      { type: "tool_use", name: "Bash", input: { command: "echo hi" }, parentToolUseId: "S", toolUseId: "B" },
    ]);
    expect(rec.toolCounts.Bash).toBeUndefined();
  });

  it("an explicit Agent(subagent_type:'fork') dispatch's inner Bash counts as main-agent work, while dispatch_count is unaffected", async () => {
    const rec = await drive([
      { type: "tool_use", name: "Agent", input: { subagent_type: "fork" }, toolUseId: "F" },
      { type: "subagent_dispatch", toolUseId: "F", dispatchAgentType: "fork", declaredTools: [], typeOmitted: false },
      { type: "tool_use", name: "Bash", input: { command: "echo hi" }, parentToolUseId: "F", toolUseId: "B" },
    ]);
    expect(rec.toolCounts.Bash).toBe(1);
    expect(rec.toolCounts.Agent).toBe(1);
    expect(rec.subagents.length).toBe(1);
    expect(rec.subagentTools.has("Bash")).toBe(false);
  });

  it("a fork skill repeating the SAME Bash call twice is a redundant group; a sub-agent's repeat is excluded", async () => {
    const rec = await drive([
      // fork skill: same Bash call twice → redundant group of 2.
      { type: "tool_use", name: "Skill", input: { skill: "probe" }, toolUseId: "S" },
      { type: "tool_use", name: "Bash", input: { command: "echo hi" }, parentToolUseId: "S", toolUseId: "B1" },
      { type: "tool_use", name: "Bash", input: { command: "echo hi" }, parentToolUseId: "S", toolUseId: "B2" },
      // real sub-agent: same Ls call twice → excluded from redundantToolCalls (isolated).
      { type: "tool_use", name: "Agent", input: { subagent_type: "general-purpose" }, toolUseId: "A" },
      { type: "subagent_dispatch", toolUseId: "A", dispatchAgentType: "general-purpose", declaredTools: [], typeOmitted: false },
      { type: "tool_use", name: "Ls", input: { path: "." }, parentToolUseId: "A", toolUseId: "L1" },
      { type: "tool_use", name: "Ls", input: { path: "." }, parentToolUseId: "A", toolUseId: "L2" },
    ]);
    const bashGroup = rec.redundantToolCalls.find((g) => g.name === "Bash");
    expect(bashGroup?.count).toBe(2);
    expect(rec.redundantToolCalls.find((g) => g.name === "Ls")).toBeUndefined();
  });

  // #16: a subagent that dispatches a child carries parentToolUseId into its record, so result.json
  // consumers can reconstruct the nested dispatch tree (it was silently dropped from the push before).
  it("a nested subagent_dispatch records its parentToolUseId (dispatch tree is reconstructable)", async () => {
    const rec = await drive([
      { type: "tool_use", name: "Agent", input: { subagent_type: "general-purpose" }, toolUseId: "A" },
      { type: "subagent_dispatch", toolUseId: "A", dispatchAgentType: "general-purpose", declaredTools: [], typeOmitted: false },
      {
        type: "subagent_dispatch",
        toolUseId: "C",
        parentToolUseId: "A",
        dispatchAgentType: "general-purpose",
        declaredTools: [],
        typeOmitted: false,
      },
    ]);
    const parent = rec.subagents.find((s) => s.toolUseId === "A");
    const child = rec.subagents.find((s) => s.toolUseId === "C");
    expect(parent?.parentToolUseId).toBeUndefined(); // top-level dispatch has no parent
    expect(child?.parentToolUseId).toBe("A");
  });
});
