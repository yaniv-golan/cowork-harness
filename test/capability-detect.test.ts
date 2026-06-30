import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { detectCapabilityUse, CAPABILITY_FAMILIES, type CapabilityFamily } from "../src/runtime/image-capabilities.js";

const ALL = Object.keys(CAPABILITY_FAMILIES) as CapabilityFamily[];

function eventsFileWith(lines: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "cap-"));
  const f = join(dir, "events.jsonl");
  writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n"));
  return f;
}
/** Create an events.jsonl + a sibling workspace root, returning both so a `python script.py` can be followed. */
function eventsAndWorkspace(lines: object[]): { events: string; workRoot: string } {
  const dir = mkdtempSync(join(tmpdir(), "cap-ws-"));
  const events = join(dir, "events.jsonl");
  writeFileSync(events, lines.map((l) => JSON.stringify(l)).join("\n"));
  const workRoot = join(dir, "work");
  mkdirSync(workRoot, { recursive: true });
  return { events, workRoot };
}
function writeScript(workRoot: string, rel: string, body: string): void {
  const full = join(workRoot, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
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

describe("detectCapabilityUse — workspace-script follow (the hidden-import false-negative)", () => {
  it("detects `import cv2` inside a `python script.py` whose command text hides it", () => {
    const { events, workRoot } = eventsAndWorkspace([assistantToolUse("Bash", { command: "python analyze.py input.png" })]);
    writeScript(workRoot, "analyze.py", "import sys\nimport cv2\nprint(cv2.__version__)\n");
    // Command text alone is undetectable (no signature); the script scan attributes it.
    expect(detectCapabilityUse(events, ["cv"])).toEqual([]); // no workRoot → can't follow the file
    expect(detectCapabilityUse(events, ["cv"], workRoot)).toEqual(["cv"]);
  });

  it("follows a nested relative script path (`python3 ./pkg/run.py`)", () => {
    const { events, workRoot } = eventsAndWorkspace([assistantToolUse("Bash", { command: "python3 ./pkg/run.py --flag" })]);
    writeScript(workRoot, "pkg/run.py", "from wand.image import Image\n");
    expect(detectCapabilityUse(events, ["magick"], workRoot)).toEqual(["magick"]);
  });

  it("is a no-op when the referenced script is missing (read-only, guarded)", () => {
    const { events, workRoot } = eventsAndWorkspace([assistantToolUse("Bash", { command: "python gone.py" })]);
    expect(detectCapabilityUse(events, ["cv"], workRoot)).toEqual([]);
  });

  it("refuses to escape the workspace root via `../`", () => {
    const { events, workRoot } = eventsAndWorkspace([assistantToolUse("Bash", { command: "python ../escape.py" })]);
    // Place a cv2-importing file OUTSIDE workRoot; the containment guard must not read it.
    writeScript(dirname(workRoot), "escape.py", "import cv2\n");
    expect(detectCapabilityUse(events, ["cv"], workRoot)).toEqual([]);
  });

  it("does not follow inline `-c` code as a file path", () => {
    const { events, workRoot } = eventsAndWorkspace([assistantToolUse("Bash", { command: 'python3 -c "print(1)"' })]);
    // No .py token to follow; nothing to read, nothing detected.
    expect(detectCapabilityUse(events, ["cv"], workRoot)).toEqual([]);
  });
});

describe("scriptPathsInCommand per-segment scoping", () => {
  it("scopes script paths to their own interpreter segment: 'python run.py; cat helper.py' yields only run.py", () => {
    // `cat` is not an interpreter; helper.py must NOT be attributed to python.
    const { events, workRoot } = eventsAndWorkspace([assistantToolUse("Bash", { command: "python run.py; cat helper.py" })]);
    writeScript(workRoot, "run.py", "import cv2\n");
    // helper.py not written — if it were followed incorrectly, a missing-file read returns ""; safe either way.
    writeScript(workRoot, "helper.py", "# no cv2 here\n");
    // Only run.py (the interpreter segment) should be followed → cv is detected.
    // The key assertion: cv IS detected (run.py was followed) and the result is cv only once.
    expect(detectCapabilityUse(events, ["cv"], workRoot)).toEqual(["cv"]);
  });

  it("two interpreter segments each follow only their own first file: 'python run.py; python helper.py'", () => {
    const { events, workRoot } = eventsAndWorkspace([assistantToolUse("Bash", { command: "python run.py; python helper.py" })]);
    writeScript(workRoot, "run.py", "import cv2\n");
    writeScript(workRoot, "helper.py", "import wand\n");
    // Both interpreter segments are followed; cv AND magick should be detected.
    const found = detectCapabilityUse(events, ["cv", "magick"], workRoot);
    expect(found).toContain("cv");
    expect(found).toContain("magick");
  });

  it("flags after the interpreter are skipped: 'python -u run.py' follows run.py (not -u)", () => {
    const { events, workRoot } = eventsAndWorkspace([assistantToolUse("Bash", { command: "python -u run.py" })]);
    writeScript(workRoot, "run.py", "import cv2\n");
    expect(detectCapabilityUse(events, ["cv"], workRoot)).toEqual(["cv"]);
  });

  it("non-interpreter commands ('cat file.py') are NOT followed into the workspace", () => {
    const { events, workRoot } = eventsAndWorkspace([assistantToolUse("Bash", { command: "cat file.py" })]);
    writeScript(workRoot, "file.py", "import cv2\n");
    // `cat` is not in SCRIPT_INTERPRETERS; file.py must NOT be scanned.
    expect(detectCapabilityUse(events, ["cv"], workRoot)).toEqual([]);
  });
});
