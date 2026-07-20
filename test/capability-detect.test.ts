import { describe, it, expect } from "vitest";
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
    expect(detectCapabilityUse(f, ["ocr"]).used).toEqual(["ocr"]);
  });

  it("detects a `python3 -c import cv2` usage when cv is omitted", () => {
    const f = eventsFileWith([assistantToolUse("Bash", { command: 'python3 -c "import cv2; print(cv2.__version__)"' })]);
    expect(detectCapabilityUse(f, ["cv"]).used).toEqual(["cv"]);
  });

  it("detects via a FAILURE string in an isError tool_result (the secondary corroborator)", () => {
    const f = eventsFileWith([userToolResult("Traceback ...\nModuleNotFoundError: No module named 'markitdown'")]);
    expect(detectCapabilityUse(f, ["ml_extract"]).used).toEqual(["ml_extract"]);
  });

  it("does NOT fire when the used family is NOT omitted (image has it → empty intersection)", () => {
    const f = eventsFileWith([assistantToolUse("Bash", { command: "tesseract scan.png out" })]);
    expect(detectCapabilityUse(f, []).used).toEqual([]); // full image: omitted = []
    expect(detectCapabilityUse(f, ["cv"]).used).toEqual([]); // ocr used but only cv omitted
  });

  it("does NOT fire on a non-error tool_result that merely echoes a failure-like string", () => {
    const f = eventsFileWith([userToolResult("the string 'No module named cv2' appeared in docs", /*is_error*/ false)]);
    expect(detectCapabilityUse(f, ["cv"]).used).toEqual([]);
  });

  it("covers subagent tool calls (no parentToolUseId filter)", () => {
    const f = eventsFileWith([
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Bash", input: { command: "soffice --headless --convert-to pdf x.docx" } }] },
      },
    ]);
    expect(detectCapabilityUse(f, ["office_convert"]).used).toEqual(["office_convert"]);
  });

  it("returns used:[] AND health:'missing' for a nonexistent events file (NOT a clean scan)", () => {
    const r = detectCapabilityUse(join(tmpdir(), "does-not-exist.jsonl"), ALL);
    expect(r.used).toEqual([]);
    expect(r.health).toBe("missing");
  });
});

describe("detectCapabilityUse — scan health (the health-blind false-green guard)", () => {
  it("reports health:'missing' — not 'complete' — when events.jsonl cannot be read, even though used comes back empty", () => {
    // This is the core false-green this guard exists to prevent: an unreadable file must NEVER be
    // indistinguishable from "we scanned it and genuinely found nothing".
    const r = detectCapabilityUse(join(tmpdir(), "definitely-does-not-exist-" + Date.now() + ".jsonl"), ["ocr"]);
    expect(r.used).toEqual([]);
    expect(r.health).toBe("missing");
    expect(r.malformedLines).toBe(0);
  });

  it("reports health:'degraded' with a malformed-line count when a line fails to parse, and does NOT silently drop a real signal", () => {
    const dir = mkdtempSync(join(tmpdir(), "cap-health-"));
    const f = join(dir, "events.jsonl");
    // Line 1: a genuine tesseract usage (must still be detected). Line 2: truncated/corrupt JSON.
    writeFileSync(
      f,
      [JSON.stringify(assistantToolUse("Bash", { command: "tesseract scan.png out" })), '{"type":"assistant","message":'].join("\n"),
    );
    const r = detectCapabilityUse(f, ["ocr"]);
    expect(r.used).toEqual(["ocr"]); // the surviving line's signal is still attributed
    expect(r.health).toBe("degraded");
    expect(r.malformedLines).toBe(1);
  });

  it("reports health:'degraded' when the ONLY line carrying the capability signal is the corrupted one — used comes back empty but health says don't trust it", () => {
    const dir = mkdtempSync(join(tmpdir(), "cap-health-"));
    const f = join(dir, "events.jsonl");
    // A single, unparseable line — corrupting it erases the only capability-use signal (this is #67's exact
    // failure mode). used:[] must NOT be read as "scanned clean".
    writeFileSync(f, '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"tesseract x"');
    const r = detectCapabilityUse(f, ["ocr"]);
    expect(r.used).toEqual([]);
    expect(r.health).toBe("degraded");
    expect(r.malformedLines).toBe(1);
  });

  it("counts multiple malformed lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "cap-health-"));
    const f = join(dir, "events.jsonl");
    writeFileSync(f, ["not json", "{also not json", JSON.stringify(assistantToolUse("Bash", { command: "echo hi" }))].join("\n"));
    const r = detectCapabilityUse(f, ["ocr"]);
    expect(r.health).toBe("degraded");
    expect(r.malformedLines).toBe(2);
  });

  it("reports health:'complete' on a genuinely empty (0-byte) events.jsonl — a fresh file is a real clean scan, not degraded", () => {
    const dir = mkdtempSync(join(tmpdir(), "cap-health-"));
    const f = join(dir, "events.jsonl");
    writeFileSync(f, "");
    const r = detectCapabilityUse(f, ["ocr"]);
    expect(r.used).toEqual([]);
    expect(r.health).toBe("complete");
    expect(r.malformedLines).toBe(0);
  });

  it("reports health:'complete' with malformedLines:0 on a clean multi-line scan that finds nothing (unchanged green)", () => {
    const f = eventsFileWith([assistantToolUse("Bash", { command: "echo hello" }), userToolResult("all good", false)]);
    const r = detectCapabilityUse(f, ["ocr", "cv"]);
    expect(r.used).toEqual([]);
    expect(r.health).toBe("complete");
    expect(r.malformedLines).toBe(0);
  });

  it("reports health:'complete' alongside actual detected use (the happy-path positive case)", () => {
    const f = eventsFileWith([assistantToolUse("Bash", { command: "tesseract scan.png out" })]);
    const r = detectCapabilityUse(f, ["ocr"]);
    expect(r.used).toEqual(["ocr"]);
    expect(r.health).toBe("complete");
    expect(r.malformedLines).toBe(0);
  });

  it("short-circuits to health:'complete' when omitted is empty, without touching the filesystem", () => {
    const r = detectCapabilityUse(join(tmpdir(), "does-not-exist-and-never-read.jsonl"), []);
    expect(r).toEqual({ used: [], health: "complete", malformedLines: 0 });
  });
});

describe("detectCapabilityUse — workspace-script follow (the hidden-import false-negative)", () => {
  it("detects `import cv2` inside a `python script.py` whose command text hides it", () => {
    const { events, workRoot } = eventsAndWorkspace([assistantToolUse("Bash", { command: "python analyze.py input.png" })]);
    writeScript(workRoot, "analyze.py", "import sys\nimport cv2\nprint(cv2.__version__)\n");
    // Command text alone is undetectable (no signature); the script scan attributes it.
    expect(detectCapabilityUse(events, ["cv"]).used).toEqual([]); // no workRoot → can't follow the file
    expect(detectCapabilityUse(events, ["cv"], workRoot).used).toEqual(["cv"]);
  });

  it("follows a nested relative script path (`python3 ./pkg/run.py`)", () => {
    const { events, workRoot } = eventsAndWorkspace([assistantToolUse("Bash", { command: "python3 ./pkg/run.py --flag" })]);
    writeScript(workRoot, "pkg/run.py", "from wand.image import Image\n");
    expect(detectCapabilityUse(events, ["magick"], workRoot).used).toEqual(["magick"]);
  });

  it("is a no-op when the referenced script is missing (read-only, guarded)", () => {
    const { events, workRoot } = eventsAndWorkspace([assistantToolUse("Bash", { command: "python gone.py" })]);
    expect(detectCapabilityUse(events, ["cv"], workRoot).used).toEqual([]);
  });

  it("refuses to escape the workspace root via `../`", () => {
    const { events, workRoot } = eventsAndWorkspace([assistantToolUse("Bash", { command: "python ../escape.py" })]);
    // Place a cv2-importing file OUTSIDE workRoot; the containment guard must not read it.
    writeScript(dirname(workRoot), "escape.py", "import cv2\n");
    expect(detectCapabilityUse(events, ["cv"], workRoot).used).toEqual([]);
  });

  it("does not follow inline `-c` code as a file path", () => {
    const { events, workRoot } = eventsAndWorkspace([assistantToolUse("Bash", { command: 'python3 -c "print(1)"' })]);
    // No .py token to follow; nothing to read, nothing detected.
    expect(detectCapabilityUse(events, ["cv"], workRoot).used).toEqual([]);
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
    expect(detectCapabilityUse(events, ["cv"], workRoot).used).toEqual(["cv"]);
  });

  it("two interpreter segments each follow only their own first file: 'python run.py; python helper.py'", () => {
    const { events, workRoot } = eventsAndWorkspace([assistantToolUse("Bash", { command: "python run.py; python helper.py" })]);
    writeScript(workRoot, "run.py", "import cv2\n");
    writeScript(workRoot, "helper.py", "import wand\n");
    // Both interpreter segments are followed; cv AND magick should be detected.
    const found = detectCapabilityUse(events, ["cv", "magick"], workRoot).used;
    expect(found).toContain("cv");
    expect(found).toContain("magick");
  });

  it("flags after the interpreter are skipped: 'python -u run.py' follows run.py (not -u)", () => {
    const { events, workRoot } = eventsAndWorkspace([assistantToolUse("Bash", { command: "python -u run.py" })]);
    writeScript(workRoot, "run.py", "import cv2\n");
    expect(detectCapabilityUse(events, ["cv"], workRoot).used).toEqual(["cv"]);
  });

  it("non-interpreter commands ('cat file.py') are NOT followed into the workspace", () => {
    const { events, workRoot } = eventsAndWorkspace([assistantToolUse("Bash", { command: "cat file.py" })]);
    writeScript(workRoot, "file.py", "import cv2\n");
    // `cat` is not in SCRIPT_INTERPRETERS; file.py must NOT be scanned.
    expect(detectCapabilityUse(events, ["cv"], workRoot).used).toEqual([]);
  });
});
