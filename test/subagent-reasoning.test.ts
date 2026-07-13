import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureSubagentReasoning, REASONING_CAP, REASONING_TEXT_CAP_BYTES } from "../src/run/subagent-reasoning.js";
import type { RunResult } from "../src/types.js";

type SubagentEntry = NonNullable<RunResult["subagents"]>[number];

function baseSubagent(toolUseId: string): SubagentEntry {
  return {
    toolUseId,
    dispatchAgentType: "general-purpose",
    declaredTools: [],
    toolsUsed: [],
  };
}

/** Stage a child transcript pair (`agent-<id>.meta.json` + `agent-<id>.jsonl`) under
 *  `<configDirRoot>/projects/<...anySegments>/subagents/`, matching the real on-disk shape a live
 *  sub-agent dispatch produces — deliberately nested under an arbitrary project-slug/session-uuid path
 *  to prove the capture globs recursively rather than reconstructing that path. */
function stageChild(
  configDirRoot: string,
  projSlug: string,
  parentSessionUuid: string,
  agentId: string,
  meta: { agentType: string; description: string; toolUseId: string; spawnDepth: number },
  lines: unknown[],
): void {
  const dir = join(configDirRoot, "projects", projSlug, parentSessionUuid, "subagents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `agent-${agentId}.meta.json`), JSON.stringify(meta));
  writeFileSync(join(dir, `agent-${agentId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

function assistantLine(content: unknown[]): unknown {
  return { type: "assistant", message: { role: "assistant", content } };
}

describe("captureSubagentReasoning (O — per-sub-agent reasoning from the child session transcript)", () => {
  it("joins by meta.toolUseId, extracts thinking+text turns IN ORDER, excludes tool_use/tool_result", () => {
    const configDir = mkdtempSync(join(tmpdir(), "cwh-reasoning-"));
    stageChild(
      configDir,
      "-some-project-slug",
      "982a7228-3ebd-4ce2-b778-aacebc9e9575",
      "a8e477820935cf9a6",
      { agentType: "general-purpose", description: "Write probe JSON file", toolUseId: "toolu_01T", spawnDepth: 1 },
      [
        { type: "user", message: { role: "user", content: "do the thing" } },
        assistantLine([{ type: "thinking", thinking: "I should resolve the absolute path first." }]),
        assistantLine([{ type: "text", text: "The Write tool requires an absolute path, so I need to resolve it." }]),
        assistantLine([{ type: "tool_use", id: "tu_1", name: "Write", input: {} }]),
        { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] } },
        assistantLine([{ type: "text", text: "Done." }]),
      ],
    );
    const subagents: SubagentEntry[] = [baseSubagent("toolu_01T")];
    captureSubagentReasoning(configDir, subagents);
    expect(subagents[0].reasoning).toEqual([
      { kind: "thinking", text: "I should resolve the absolute path first." },
      { kind: "text", text: "The Write tool requires an absolute path, so I need to resolve it." },
      { kind: "text", text: "Done." },
    ]);
    expect(subagents[0].reasoningElided).toBeUndefined();
  });

  it("marks an omitted-by-request thinking turn (empty text + non-empty signature) with redacted:true", () => {
    const configDir = mkdtempSync(join(tmpdir(), "cwh-reasoning-"));
    stageChild(
      configDir,
      "-proj",
      "sess-uuid",
      "aRedacted",
      { agentType: "general-purpose", description: "redacted thinking", toolUseId: "toolu_redact", spawnDepth: 1 },
      [
        // The real on-disk shape: sub-agent thinking returns empty (display forced to "omitted"), signature kept.
        assistantLine([{ type: "thinking", thinking: "", signature: "sig-continuation-token-abc123" }]),
        assistantLine([{ type: "text", text: "The receipt the sub-agent actually returned." }]),
      ],
    );
    const subagents: SubagentEntry[] = [baseSubagent("toolu_redact")];
    captureSubagentReasoning(configDir, subagents);
    expect(subagents[0].reasoning).toEqual([
      { kind: "thinking", text: "", redacted: true },
      { kind: "text", text: "The receipt the sub-agent actually returned." },
    ]);
  });

  it("does NOT mark redacted when a thinking block has real text, nor when empty text lacks a signature", () => {
    const configDir = mkdtempSync(join(tmpdir(), "cwh-reasoning-"));
    stageChild(
      configDir,
      "-proj",
      "sess-uuid",
      "aNoRedact",
      { agentType: "general-purpose", description: "no redact", toolUseId: "toolu_noredact", spawnDepth: 1 },
      [
        // Real text present → never redacted, even if a signature also rode along.
        assistantLine([{ type: "thinking", thinking: "a genuine thought", signature: "sig-xyz" }]),
        // Empty text with NO signature → no evidence any reasoning happened → left unflagged.
        assistantLine([{ type: "thinking", thinking: "" }]),
      ],
    );
    const subagents: SubagentEntry[] = [baseSubagent("toolu_noredact")];
    captureSubagentReasoning(configDir, subagents);
    expect(subagents[0].reasoning).toEqual([
      { kind: "thinking", text: "a genuine thought" },
      { kind: "thinking", text: "" },
    ]);
    // redacted is omitted (not false) on both
    expect(subagents[0].reasoning?.every((t) => !("redacted" in t))).toBe(true);
  });

  it("caps at REASONING_CAP entries, keeping the MOST RECENT ones, and counts the overflow in reasoningElided", () => {
    const configDir = mkdtempSync(join(tmpdir(), "cwh-reasoning-"));
    const total = REASONING_CAP + 7;
    const lines = Array.from({ length: total }, (_, i) => assistantLine([{ type: "text", text: `turn ${i}` }]));
    stageChild(
      configDir,
      "-proj",
      "sess-uuid",
      "aCapTest",
      { agentType: "general-purpose", description: "cap test", toolUseId: "toolu_cap", spawnDepth: 1 },
      lines,
    );
    const subagents: SubagentEntry[] = [baseSubagent("toolu_cap")];
    captureSubagentReasoning(configDir, subagents);
    expect(subagents[0].reasoning).toHaveLength(REASONING_CAP);
    expect(subagents[0].reasoningElided).toBe(7);
    // the surfaced window is the LAST REASONING_CAP turns (7..total-1), oldest (0..6) elided
    expect(subagents[0].reasoning?.[0]).toEqual({ kind: "text", text: `turn 7` });
    expect(subagents[0].reasoning?.[REASONING_CAP - 1]).toEqual({ kind: "text", text: `turn ${total - 1}` });
  });

  it("caps each entry's text at REASONING_TEXT_CAP_BYTES", () => {
    const configDir = mkdtempSync(join(tmpdir(), "cwh-reasoning-"));
    const longText = "x".repeat(REASONING_TEXT_CAP_BYTES + 500);
    stageChild(
      configDir,
      "-proj",
      "sess-uuid",
      "aLongText",
      { agentType: "general-purpose", description: "long text", toolUseId: "toolu_long", spawnDepth: 1 },
      [assistantLine([{ type: "thinking", thinking: longText }])],
    );
    const subagents: SubagentEntry[] = [baseSubagent("toolu_long")];
    captureSubagentReasoning(configDir, subagents);
    expect(subagents[0].reasoning?.[0].text).toHaveLength(REASONING_TEXT_CAP_BYTES);
  });

  it("a dispatch with no matching child file leaves reasoning undefined (not [])", () => {
    const configDir = mkdtempSync(join(tmpdir(), "cwh-reasoning-"));
    stageChild(
      configDir,
      "-proj",
      "sess-uuid",
      "aOther",
      { agentType: "general-purpose", description: "other dispatch", toolUseId: "toolu_other", spawnDepth: 1 },
      [assistantLine([{ type: "text", text: "hi" }])],
    );
    const subagents: SubagentEntry[] = [baseSubagent("toolu_nomatch")];
    captureSubagentReasoning(configDir, subagents);
    expect(subagents[0].reasoning).toBeUndefined();
  });

  it("a matched child file with NO thinking/text blocks (only tool_use) yields an empty array, not undefined", () => {
    const configDir = mkdtempSync(join(tmpdir(), "cwh-reasoning-"));
    stageChild(
      configDir,
      "-proj",
      "sess-uuid",
      "aTrivial",
      { agentType: "general-purpose", description: "trivial write", toolUseId: "toolu_trivial", spawnDepth: 1 },
      [assistantLine([{ type: "tool_use", id: "tu_1", name: "Write", input: {} }])],
    );
    const subagents: SubagentEntry[] = [baseSubagent("toolu_trivial")];
    captureSubagentReasoning(configDir, subagents);
    expect(subagents[0].reasoning).toEqual([]);
  });

  it("only the MATCHED dispatch is populated; a second, non-matching dispatch stays untouched", () => {
    const configDir = mkdtempSync(join(tmpdir(), "cwh-reasoning-"));
    stageChild(
      configDir,
      "-proj",
      "sess-uuid",
      "aMatch",
      { agentType: "general-purpose", description: "matched", toolUseId: "toolu_match", spawnDepth: 1 },
      [assistantLine([{ type: "text", text: "matched turn" }])],
    );
    const subagents: SubagentEntry[] = [baseSubagent("toolu_match"), baseSubagent("toolu_unmatched")];
    captureSubagentReasoning(configDir, subagents);
    expect(subagents[0].reasoning).toEqual([{ kind: "text", text: "matched turn" }]);
    expect(subagents[1].reasoning).toBeUndefined();
  });

  it("a malformed meta.json (invalid JSON) never throws and leaves reasoning undefined", () => {
    const configDir = mkdtempSync(join(tmpdir(), "cwh-reasoning-"));
    const dir = join(configDir, "projects", "-proj", "sess-uuid", "subagents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agent-aBad.meta.json"), "{not valid json");
    writeFileSync(join(dir, "agent-aBad.jsonl"), JSON.stringify(assistantLine([{ type: "text", text: "hi" }])) + "\n");
    const subagents: SubagentEntry[] = [baseSubagent("toolu_whatever")];
    expect(() => captureSubagentReasoning(configDir, subagents)).not.toThrow();
    expect(subagents[0].reasoning).toBeUndefined();
  });

  it("a malformed line inside a valid child .jsonl is skipped, not fatal to the rest of the file", () => {
    const configDir = mkdtempSync(join(tmpdir(), "cwh-reasoning-"));
    const dir = join(configDir, "projects", "-proj", "sess-uuid", "subagents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "agent-aMixed.meta.json"),
      JSON.stringify({ agentType: "general-purpose", description: "mixed", toolUseId: "toolu_mixed", spawnDepth: 1 }),
    );
    const goodLine1 = JSON.stringify(assistantLine([{ type: "text", text: "before the bad line" }]));
    const badLine = "{this is not json";
    const goodLine2 = JSON.stringify(assistantLine([{ type: "text", text: "after the bad line" }]));
    writeFileSync(join(dir, "agent-aMixed.jsonl"), [goodLine1, badLine, goodLine2].join("\n") + "\n");
    const subagents: SubagentEntry[] = [baseSubagent("toolu_mixed")];
    captureSubagentReasoning(configDir, subagents);
    expect(subagents[0].reasoning).toEqual([
      { kind: "text", text: "before the bad line" },
      { kind: "text", text: "after the bad line" },
    ]);
  });

  it("a configDirRoot with no projects/ dir at all never throws (e.g. a live tier that dispatched no sub-agents)", () => {
    const configDir = mkdtempSync(join(tmpdir(), "cwh-reasoning-"));
    const subagents: SubagentEntry[] = [baseSubagent("toolu_any")];
    expect(() => captureSubagentReasoning(configDir, subagents)).not.toThrow();
    expect(subagents[0].reasoning).toBeUndefined();
  });

  it("a non-existent configDirRoot entirely never throws", () => {
    const subagents: SubagentEntry[] = [baseSubagent("toolu_any")];
    expect(() => captureSubagentReasoning("/nonexistent/path/xyz", subagents)).not.toThrow();
    expect(subagents[0].reasoning).toBeUndefined();
  });

  it("an empty/undefined subagents array is a no-op", () => {
    expect(() => captureSubagentReasoning("/nonexistent", undefined)).not.toThrow();
    expect(() => captureSubagentReasoning("/nonexistent", [])).not.toThrow();
  });
});
