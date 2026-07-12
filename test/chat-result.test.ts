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
    filesRead: [],
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
    fileToolAttempts: [],
    presentedFiles: [],
    webSearches: [],
    infraErrors: [],
    evidenceErrors: { taskTracking: 0, webSearchParse: 0, presentFilesMalformed: 0 },
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
    // deliberate exception: execution.location is descriptive provenance, not a verdict — a chat
    // genuinely knows it ran locally, so it's stamped even though every OTHER field above is undefined
    expect(r.execution).toEqual({ location: "local" });
  });

  it("passes thinkingElided through onto the assembled result", () => {
    const record = { ...minimalChatRecord(), thinkingElided: 5 };
    const r = buildChatResult(record, {
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
    expect(r.thinkingElided).toBe(5);
  });

  it("leaves thinkingElided at 0 (not undefined) when no thinking was ever capped", () => {
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
    expect(r.thinkingElided).toBe(0);
  });

  // NOTE: `tasks` is the deliberate EXCEPTION to this empty→undefined family — it emits [] for an observed
  // zero-task run (the assert.ts [] ≠ undefined contract is tasks-specific, #8-10). models/thinking/
  // webSearches keep collapsing to undefined.
  it("collapses webSearches to undefined when the run made zero WebSearch calls (matches models/thinking)", () => {
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
    expect(r.webSearches).toBeUndefined();
  });

  // #8-10: `tasks` is emitted as [] (NOT collapsed to undefined) for an observed zero-task run — the
  // assert.ts [] ≠ undefined contract distinguishes "observed, none" from "no telemetry".
  it("emits tasks: [] (not undefined) for an observed zero-task run", () => {
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
    expect(r.tasks).toEqual([]);
  });

  it("passes webSearches through unchanged when the run made at least one WebSearch call", () => {
    const record = {
      ...minimalChatRecord(),
      webSearches: [{ toolUseId: "toolu_1", query: "market size", results: [{ title: "Report", url: "https://example.com" }] }],
    };
    const r = buildChatResult(record, {
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
    expect(r.webSearches).toEqual([
      { toolUseId: "toolu_1", query: "market size", results: [{ title: "Report", url: "https://example.com" }] },
    ]);
  });
});
