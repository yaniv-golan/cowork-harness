import { describe, it, expect } from "vitest";
import { skillReferenceReadPath, Run } from "../src/run/run";
import type { AgentEvent, AgentSession, DecisionResponse } from "../src/agent/session.js";
import { ScriptedDecider } from "../src/decide/decider.js";

// Classify a Read tool's file_path as a skill reference/script access (the referencesRead signal).
describe("skillReferenceReadPath", () => {
  it("captures a reference Read under a mounted plugin root (container path shape)", () => {
    expect(
      skillReferenceReadPath(
        "/sessions/local_x/mnt/.local-plugins/marketplaces/local-desktop-app-uploads/cowork-harness/references/task-recipes.md",
      ),
    ).toBe("references/task-recipes.md");
  });

  it("captures a scripts Read too", () => {
    expect(skillReferenceReadPath("/mnt/.local-plugins/cache/my-plugin/scripts/scenario.py")).toBe("scripts/scenario.py");
  });

  it("captures a remote-plugin reference", () => {
    expect(skillReferenceReadPath("/mnt/.remote-plugins/plugin_abc/references/deep/guide.md")).toBe("references/deep/guide.md");
  });

  it("ignores a Read that isn't under a plugin root (a user document, an output)", () => {
    expect(skillReferenceReadPath("/mnt/uploads/report.pdf")).toBeUndefined();
    expect(skillReferenceReadPath("/mnt/outputs/result.md")).toBeUndefined();
    expect(skillReferenceReadPath("references/foo.md")).toBeUndefined(); // no plugin-root marker → not attributable
  });

  it("ignores a plugin-root Read that isn't a reference/script (e.g. SKILL.md, which is delivered whole)", () => {
    expect(skillReferenceReadPath("/mnt/.local-plugins/cache/my-plugin/SKILL.md")).toBeUndefined();
  });

  it("is empty-safe", () => {
    expect(skillReferenceReadPath("")).toBeUndefined();
  });
});

// Minimal in-memory session that yields a scripted event sequence (mirrors fork-skill-scope.test.ts's
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

const REF_PATH = "/sessions/local_x/mnt/.local-plugins/cache/my-plugin/references/foo.md";
const SCRIPT_PATH = "/mnt/.local-plugins/cache/my-plugin/scripts/bar.py";
const ASSET_PATH = "/mnt/.local-plugins/cache/my-plugin/assets/x.png";
const SKILL_MD_PATH = "/mnt/.local-plugins/cache/my-plugin/SKILL.md";

// Sub-agent counterpart of the main-agent-only filesRead capture: a dispatched sub-agent's Read of a
// references/scripts file is attributed to ITS subagents[] entry, correlated via parentToolUseId — the
// same join subagents[].toolsUsed already uses. Companion to fork-skill-scope.test.ts's toolsUsed/
// subagentTools attribution coverage.
describe("sub-agent referencesRead attribution", () => {
  it("a sub-agent Read of a reference file lands on ITS dispatch, NOT the top-level (main-only) filesRead", async () => {
    const rec = await drive([
      { type: "tool_use", name: "Agent", input: { subagent_type: "general-purpose" }, toolUseId: "A" },
      { type: "subagent_dispatch", toolUseId: "A", dispatchAgentType: "general-purpose", declaredTools: [], typeOmitted: false },
      { type: "tool_use", name: "Read", input: { file_path: REF_PATH }, parentToolUseId: "A", toolUseId: "R1" },
    ]);
    const sa = rec.subagents.find((s) => s.toolUseId === "A");
    expect(sa?.referencesRead).toEqual(["references/foo.md"]);
    expect(rec.filesRead).toEqual([]); // main-agent-only field is untouched by a sub-agent Read
  });

  it("main-agent-unchanged guard: a plain main-agent Read still populates ONLY the top-level filesRead, and leaves subagents empty", async () => {
    const rec = await drive([{ type: "tool_use", name: "Read", input: { file_path: REF_PATH } }]);
    expect(rec.filesRead).toEqual(["references/foo.md"]); // byte-identical to pre-existing main behavior
    expect(rec.subagents).toEqual([]);
  });

  it("two dispatches each Reading a different ref get their OWN referencesRead, not merged", async () => {
    const rec = await drive([
      { type: "tool_use", name: "Agent", input: { subagent_type: "general-purpose" }, toolUseId: "A1" },
      { type: "subagent_dispatch", toolUseId: "A1", dispatchAgentType: "general-purpose", declaredTools: [], typeOmitted: false },
      { type: "tool_use", name: "Read", input: { file_path: REF_PATH }, parentToolUseId: "A1", toolUseId: "R1" },
      { type: "tool_use", name: "Agent", input: { subagent_type: "general-purpose" }, toolUseId: "A2" },
      { type: "subagent_dispatch", toolUseId: "A2", dispatchAgentType: "general-purpose", declaredTools: [], typeOmitted: false },
      { type: "tool_use", name: "Read", input: { file_path: SCRIPT_PATH }, parentToolUseId: "A2", toolUseId: "R2" },
    ]);
    const sa1 = rec.subagents.find((s) => s.toolUseId === "A1");
    const sa2 = rec.subagents.find((s) => s.toolUseId === "A2");
    expect(sa1?.referencesRead).toEqual(["references/foo.md"]);
    expect(sa2?.referencesRead).toEqual(["scripts/bar.py"]);
  });

  it("a sub-agent Read of assets/ or SKILL.md is NOT captured (same filter as main)", async () => {
    const rec = await drive([
      { type: "tool_use", name: "Agent", input: { subagent_type: "general-purpose" }, toolUseId: "A" },
      { type: "subagent_dispatch", toolUseId: "A", dispatchAgentType: "general-purpose", declaredTools: [], typeOmitted: false },
      { type: "tool_use", name: "Read", input: { file_path: ASSET_PATH }, parentToolUseId: "A", toolUseId: "R1" },
      { type: "tool_use", name: "Read", input: { file_path: SKILL_MD_PATH }, parentToolUseId: "A", toolUseId: "R2" },
    ]);
    const sa = rec.subagents.find((s) => s.toolUseId === "A");
    expect(sa?.referencesRead).toEqual([]);
  });

  it("dedupes a repeated sub-agent Read of the same reference, first-seen order (mirrors main filesRead dedupe)", async () => {
    const rec = await drive([
      { type: "tool_use", name: "Agent", input: { subagent_type: "general-purpose" }, toolUseId: "A" },
      { type: "subagent_dispatch", toolUseId: "A", dispatchAgentType: "general-purpose", declaredTools: [], typeOmitted: false },
      { type: "tool_use", name: "Read", input: { file_path: REF_PATH }, parentToolUseId: "A", toolUseId: "R1" },
      { type: "tool_use", name: "Read", input: { file_path: SCRIPT_PATH }, parentToolUseId: "A", toolUseId: "R2" },
      { type: "tool_use", name: "Read", input: { file_path: REF_PATH }, parentToolUseId: "A", toolUseId: "R3" },
    ]);
    const sa = rec.subagents.find((s) => s.toolUseId === "A");
    expect(sa?.referencesRead).toEqual(["references/foo.md", "scripts/bar.py"]);
  });
});
