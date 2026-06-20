import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectCapabilityUse, CAPABILITY_FAMILIES, type CapabilityFamily } from "../src/runtime/image-capabilities.js";

const ALL = Object.keys(CAPABILITY_FAMILIES) as CapabilityFamily[];

function eventsFileWith(lines: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "cap-"));
  const f = join(dir, "events.jsonl");
  writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n"));
  return f;
}
const assistantToolUse = (name: string, input: object) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", name, input }] },
});
const userToolResult = (text: string, is_error = true) => ({
  type: "user",
  message: { content: [{ type: "tool_result", is_error, content: text }] },
});

describe("detectCapabilityUse — capability-USAGE ∩ omitted (the false-negative guard)", () => {
  it("detects a tesseract/OCR invocation in a Bash command when ocr is omitted", () => {
    const f = eventsFileWith([assistantToolUse("Bash", { command: "tesseract scan.png out -l eng" })]);
    expect(detectCapabilityUse(f, ["ocr"])).toEqual(["ocr"]);
  });

  it("detects a `python3 -c import cv2` usage when cv is omitted", () => {
    const f = eventsFileWith([assistantToolUse("Bash", { command: 'python3 -c "import cv2; print(cv2.__version__)"' })]);
    expect(detectCapabilityUse(f, ["cv"])).toEqual(["cv"]);
  });

  it("detects via a FAILURE string in an isError tool_result (the secondary corroborator)", () => {
    const f = eventsFileWith([userToolResult("Traceback ...\nModuleNotFoundError: No module named 'markitdown'")]);
    expect(detectCapabilityUse(f, ["ml_extract"])).toEqual(["ml_extract"]);
  });

  it("does NOT fire when the used family is NOT omitted (image has it → empty intersection)", () => {
    const f = eventsFileWith([assistantToolUse("Bash", { command: "tesseract scan.png out" })]);
    expect(detectCapabilityUse(f, [])).toEqual([]); // full image: omitted = []
    expect(detectCapabilityUse(f, ["cv"])).toEqual([]); // ocr used but only cv omitted
  });

  it("does NOT fire on a non-error tool_result that merely echoes a failure-like string", () => {
    const f = eventsFileWith([userToolResult("the string 'No module named cv2' appeared in docs", /*is_error*/ false)]);
    expect(detectCapabilityUse(f, ["cv"])).toEqual([]);
  });

  it("covers subagent tool calls (no parentToolUseId filter)", () => {
    const f = eventsFileWith([
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Bash", input: { command: "soffice --headless --convert-to pdf x.docx" } }] },
      },
    ]);
    expect(detectCapabilityUse(f, ["office_convert"])).toEqual(["office_convert"]);
  });

  it("returns [] for a missing/empty events file", () => {
    expect(detectCapabilityUse(join(tmpdir(), "does-not-exist.jsonl"), ALL)).toEqual([]);
  });
});
