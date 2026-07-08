import { describe, it, expect } from "vitest";
import { Run } from "../src/run/run.js";
import type { AgentEvent, AgentSession, DecisionResponse } from "../src/agent/session.js";
import { ScriptedDecider } from "../src/decide/decider.js";

// Token-free coverage for the presentedFiles derivation in Run.drive(): a `mcp__cowork__present_files`
// tool_use (the input file list) paired with its own tool_result (`textBlocks`, one path per input file,
// in order) — content-class, so this must work purely off the AgentEvent stream with no live MCP handler.
// Mirrors the MockSession pattern used by stall-detector.test.ts / session-events.test.ts.
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

const CWD = "/sessions/x";
const drive = (events: AgentEvent[]) => new Run(new MockSession(events), new ScriptedDecider([])).drive("go");

const initEv = (cwd: string): AgentEvent => ({ type: "init", tools: [], mcpServers: [], skills: [], cwd });
const presentFilesUse = (toolUseId: string, filePaths: string[]): AgentEvent => ({
  type: "tool_use",
  name: "mcp__cowork__present_files",
  input: { files: filePaths.map((file_path) => ({ file_path })) },
  toolUseId,
});
const presentFilesResult = (toolUseId: string, texts: string[]): AgentEvent => ({
  type: "tool_result",
  toolUseId,
  isError: false,
  text: texts.join(" "),
  textBlocks: texts,
});

describe("Run derives presentedFiles from present_files tool_use + tool_result", () => {
  it("a scratchpad file that lands under mnt/outputs is promoted, not leaked", async () => {
    const rec = await drive([
      initEv(CWD),
      presentFilesUse("tu1", [`${CWD}/a.md`]),
      presentFilesResult("tu1", [`${CWD}/mnt/outputs/a.md`]),
      { type: "result", isError: false },
    ]);
    expect(rec.presentedFiles).toEqual([{ from: `${CWD}/a.md`, to: `${CWD}/mnt/outputs/a.md`, promoted: true, leaked: false }]);
  });

  it("a passthrough file already under mnt/ is neither promoted nor leaked", async () => {
    const rec = await drive([
      initEv(CWD),
      presentFilesUse("tu1", [`${CWD}/mnt/outputs/existing.md`]),
      presentFilesResult("tu1", [`${CWD}/mnt/outputs/existing.md`]),
      { type: "result", isError: false },
    ]);
    expect(rec.presentedFiles).toEqual([
      { from: `${CWD}/mnt/outputs/existing.md`, to: `${CWD}/mnt/outputs/existing.md`, promoted: false, leaked: false },
    ]);
  });

  it("a scratchpad file that stays in the scratchpad (copy failure) is leaked", async () => {
    const rec = await drive([
      initEv(CWD),
      presentFilesUse("tu1", [`${CWD}/bad.sh`]),
      // present_files' own copy-failure branch returns the ORIGINAL (still-scratchpad) path.
      presentFilesResult("tu1", [`${CWD}/bad.sh`]),
      { type: "result", isError: false },
    ]);
    expect(rec.presentedFiles).toEqual([{ from: `${CWD}/bad.sh`, to: `${CWD}/bad.sh`, promoted: false, leaked: true }]);
  });

  it("multiple files in one call pair by index, in order", async () => {
    const rec = await drive([
      initEv(CWD),
      presentFilesUse("tu1", [`${CWD}/a.md`, `${CWD}/b.sh`, `${CWD}/mnt/outputs/c.md`]),
      presentFilesResult("tu1", [`${CWD}/mnt/outputs/a.md`, `${CWD}/b.sh`, `${CWD}/mnt/outputs/c.md`]),
      { type: "result", isError: false },
    ]);
    expect(rec.presentedFiles).toEqual([
      { from: `${CWD}/a.md`, to: `${CWD}/mnt/outputs/a.md`, promoted: true, leaked: false },
      { from: `${CWD}/b.sh`, to: `${CWD}/b.sh`, promoted: false, leaked: true },
      { from: `${CWD}/mnt/outputs/c.md`, to: `${CWD}/mnt/outputs/c.md`, promoted: false, leaked: false },
    ]);
  });

  it("rec.presentedFiles is empty when present_files was never called", async () => {
    const rec = await drive([initEv(CWD), { type: "result", isError: false }]);
    expect(rec.presentedFiles).toEqual([]);
  });

  it("without an init cwd, every path is classified as neither promoted nor leaked (fail-safe undercount)", async () => {
    const rec = await drive([
      // No init event at all — rec.cwd stays undefined.
      presentFilesUse("tu1", [`${CWD}/a.md`]),
      presentFilesResult("tu1", [`${CWD}/mnt/outputs/a.md`]),
      { type: "result", isError: false },
    ]);
    expect(rec.presentedFiles).toEqual([{ from: `${CWD}/a.md`, to: `${CWD}/mnt/outputs/a.md`, promoted: false, leaked: false }]);
  });

  it("a malformed present_files input (non-array files) yields no presented entries, does not throw", async () => {
    const rec = await drive([
      initEv(CWD),
      { type: "tool_use", name: "mcp__cowork__present_files", input: { files: "not-an-array" }, toolUseId: "tu1" },
      presentFilesResult("tu1", []),
      { type: "result", isError: false },
    ]);
    expect(rec.presentedFiles).toEqual([]);
  });
});
