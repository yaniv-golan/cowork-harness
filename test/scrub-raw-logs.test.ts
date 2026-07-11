import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubRawRunLogs } from "../src/run/execute.js";

const RAW_FILES = ["events.jsonl", "control-out.jsonl", "agent.stderr.log"];

describe("scrubRawRunLogs", () => {
  it("scrubs events.jsonl, control-out.jsonl, and agent.stderr.log in place", () => {
    const dir = mkdtempSync(join(tmpdir(), "scrub-raw-"));
    for (const f of RAW_FILES) writeFileSync(join(dir, f), "before sk-test-SECRET-VALUE after\n");
    scrubRawRunLogs(dir, ["sk-test-SECRET-VALUE"]);
    for (const f of RAW_FILES) expect(readFileSync(join(dir, f), "utf8")).toBe("before [REDACTED] after\n");
  });

  it("tolerates missing files and empty secret lists", () => {
    const dir = mkdtempSync(join(tmpdir(), "scrub-raw-"));
    expect(() => scrubRawRunLogs(dir, ["x"])).not.toThrow();
    expect(() => scrubRawRunLogs(dir, [])).not.toThrow();
  });
});
