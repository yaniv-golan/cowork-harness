import { describe, it, expect } from "vitest";
import { buildChatResult } from "../src/run/chat-result.js";
import type { RunRecord } from "../src/run/run.js";

function minimalChatRecord(): RunRecord {
  // Build a RunRecord with the same field set the Run constructor initializes (grep run.ts's ctor).
  // The test only needs a well-formed record; populate toolCounts + result to prove passthrough.
  return {
    runId: "chat",
    result: "success",
    initTools: [],
    transcript: "hi",
    toolsCalled: new Set(["Bash"]),
    toolCounts: { Bash: 1 },
    subagentTools: new Set(),
    subagents: [],
    questions: [],
    decisions: [],
    permissiveAutoAllow: [],
    unanswered: [],
    toolResults: [],
    gateAnswers: [],
    gateDeliveries: [],
    skillsInvoked: [],
    models: ["claude-x"],
    thinking: [],
    thinkingElided: 0,
    toolErrors: {},
    redundantToolCalls: [],
    tasks: new Map(),
    context: { tools: [], mcpServers: [] },
    contextEvents: [],
    mcpErrors: [],
    hookEvents: [],
  } as RunRecord;
}

describe("buildChatResult", () => {
  it("builds a verdict-less chat result: mode=chat, assertions=[], verdict fields undefined", () => {
    const r = buildChatResult(minimalChatRecord(), {
      scenario: "(chat)",
      prompt: "hi",
      fidelity: "container",
      baseline: "1.0",
      outDir: "/tmp/nope",
      workRoot: "/tmp/nope/work",
      userVisibleRoots: ["outputs"],
      readonlyFolderRoots: [],
      egress: [],
      durationMs: 5,
    });
    expect(r.mode).toBe("chat");
    expect(r.assertions).toEqual([]);
    expect(r.result).toBe("success");
    expect(r.toolCounts).toEqual({ Bash: 1 });
    expect(r.models).toEqual(["claude-x"]);
    // no verdict / capability / gate signal
    expect(r.resultErrorKind).toBeUndefined();
    expect(r.stalledOnQuestion).toBeUndefined();
    expect(r.capabilityProbe).toBeUndefined();
    expect(r.missingCapabilityUse).toBeUndefined();
    expect(r.scan).toBeUndefined();
    expect(r.gateProvenance).toBeUndefined();
  });
});
