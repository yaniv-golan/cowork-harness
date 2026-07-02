import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findUngatedPathToolCalls } from "../src/run/execute.js";

function writeEvents(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "tripwire-"));
  const file = join(dir, "events.jsonl");
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

const toolUse = (id: string, name: string) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id, name, input: {} }] },
});
const toolResult = (id: string, isError = false) => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "ok" }] },
});

describe("findUngatedPathToolCalls (the hostloop runtime tripwire)", () => {
  it("flags a gated tool call that succeeded with no evidence the gate fired", () => {
    const file = writeEvents([toolUse("t1", "Read"), toolResult("t1", false)]);
    const ungated = findUngatedPathToolCalls(file, new Set());
    expect(ungated).toEqual(["Read (t1)"]);
  });

  it("does NOT flag a call the gate is recorded as having seen", () => {
    const file = writeEvents([toolUse("t1", "Read"), toolResult("t1", false)]);
    expect(findUngatedPathToolCalls(file, new Set(["t1"]))).toEqual([]);
  });

  it("does NOT flag an errored tool call (nothing to verify — the call didn't succeed)", () => {
    const file = writeEvents([toolUse("t1", "Write"), toolResult("t1", true)]);
    expect(findUngatedPathToolCalls(file, new Set())).toEqual([]);
  });

  it("does NOT flag a call whose tool_result was never observed", () => {
    const file = writeEvents([toolUse("t1", "Edit")]);
    expect(findUngatedPathToolCalls(file, new Set())).toEqual([]);
  });

  it("ignores non-gated tools entirely", () => {
    const file = writeEvents([toolUse("t1", "Bash"), toolResult("t1", false)]);
    expect(findUngatedPathToolCalls(file, new Set())).toEqual([]);
  });

  it("covers MultiEdit as a gated tool", () => {
    const file = writeEvents([toolUse("t1", "MultiEdit"), toolResult("t1", false)]);
    expect(findUngatedPathToolCalls(file, new Set())).toEqual(["MultiEdit (t1)"]);
  });

  it("returns [] for a missing/unreadable events file", () => {
    expect(findUngatedPathToolCalls("/nonexistent/path/events.jsonl", new Set())).toEqual([]);
  });
});
