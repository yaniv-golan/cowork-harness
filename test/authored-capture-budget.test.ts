import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureAuthoredFilesWithHealth, authoredTotalBytes, DEFAULT_AUTHORED_PER_FILE_BYTES } from "../src/run/artifacts.js";

// `RunResult.authoredCapture` is the capture's own returned `budget` (execute.ts passes it straight
// through), so the thing to pin is that the returned budget IS the one the walk read under.
describe("authored-file capture reports the budget it actually used", () => {
  const roots: string[] = [];
  afterEach(() => {
    delete process.env.COWORK_HARNESS_AUTHORED_TOTAL_BYTES;
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });
  function stage(files: Record<string, number>): string {
    const root = mkdtempSync(join(tmpdir(), "cwh-capbudget-"));
    roots.push(root);
    mkdirSync(join(root, "outputs"), { recursive: true });
    for (const [name, n] of Object.entries(files)) writeFileSync(join(root, "outputs", name), "z".repeat(n));
    return root;
  }

  it("a non-default total budget from the env is the one reported AND the one the walk spent", () => {
    process.env.COWORK_HARNESS_AUTHORED_TOTAL_BYTES = "20000";
    const root = stage({ "a.md": 15_000, "b.md": 15_000 });
    const cap = captureAuthoredFilesWithHealth(root, ["outputs"], [], {}, { totalBytes: authoredTotalBytes() });
    expect(cap.budget).toEqual({ perFileBytes: DEFAULT_AUTHORED_PER_FILE_BYTES, totalBytes: 20_000 });
    const read = cap.files.reduce((n, f) => n + f.content.length, 0);
    expect(read).toBe(cap.budget.totalBytes); // the walk stopped exactly at the reported total
  });

  it("an explicit per-file cap is reported and bounds each incidental file", () => {
    const root = stage({ "a.md": 9_000 });
    const cap = captureAuthoredFilesWithHealth(root, ["outputs"], [], {}, { perFileBytes: 4_096, totalBytes: 100_000 });
    expect(cap.budget).toEqual({ perFileBytes: 4_096, totalBytes: 100_000 });
    expect(cap.files[0]!.content.length).toBe(cap.budget.perFileBytes);
  });

  it("says whether the scratchpad was walked: yes with a scratchpad root, no on a resume or without one", () => {
    const root = stage({ "a.md": 10 });
    const scratch = mkdtempSync(join(tmpdir(), "cwh-capbudget-scratch-"));
    roots.push(scratch);
    writeFileSync(join(scratch, "draft.md"), "d");
    const walked = captureAuthoredFilesWithHealth(root, ["outputs"], [], {}, { scratchpadRoot: scratch });
    expect(walked.scratchpadWalked).toBe(true);
    expect(walked.files.map((f) => f.path)).toContain("scratchpad/draft.md"); // it really was walked
    expect(captureAuthoredFilesWithHealth(root, ["outputs"], [], {}, { scratchpadRoot: scratch, resume: true }).scratchpadWalked).toBe(
      false,
    );
    expect(captureAuthoredFilesWithHealth(root, ["outputs"], [], {}, {}).scratchpadWalked).toBe(false);
    expect(captureAuthoredFilesWithHealth(root, ["outputs"], [], undefined, { scratchpadRoot: scratch }).scratchpadWalked).toBe(false);
  });

  it("reports the budget even when there is no pre-run manifest to diff against", () => {
    const root = stage({});
    const cap = captureAuthoredFilesWithHealth(root, ["outputs"], [], undefined, { totalBytes: 1234 });
    expect(cap.health.noPreRunManifest).toBe(true);
    expect(cap.budget.totalBytes).toBe(1234);
  });
});
