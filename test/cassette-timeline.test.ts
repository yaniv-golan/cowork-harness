import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTimeline } from "../src/run/cassette.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "cassette-timeline-"));
}

describe("readTimeline", () => {
  it("returns undefined when timeline.jsonl doesn't exist (older harness build / feature predates the run)", () => {
    expect(readTimeline(tmp())).toBeUndefined();
  });

  it("returns undefined when timeline.jsonl exists but is empty", () => {
    const dir = tmp();
    writeFileSync(join(dir, "timeline.jsonl"), "");
    expect(readTimeline(dir)).toBeUndefined();
  });

  it("returns undefined when the header line itself doesn't parse as JSON", () => {
    const dir = tmp();
    writeFileSync(join(dir, "timeline.jsonl"), "not json\n");
    expect(readTimeline(dir)).toBeUndefined();
  });

  it("parses a header plus entries written in TimelineWriter's real format", () => {
    const dir = tmp();
    const header = { v: 1, startedAtWall: "2026-07-05T00:00:00.000Z", startedAtMono: "123456789" };
    const entry1 = { seq: 0, ts: 5, line: 0, type: "tool_use", toolUseId: "toolu_1", name: "Bash" };
    const entry2 = { seq: 1, ts: 12, line: 1, type: "result", isError: false };
    writeFileSync(join(dir, "timeline.jsonl"), [header, entry1, entry2].map((o) => JSON.stringify(o)).join("\n") + "\n");
    const parsed = readTimeline(dir);
    expect(parsed).toBeDefined();
    expect(parsed!.header).toEqual(header);
    expect(parsed!.events).toEqual([entry1, entry2]);
  });

  it("drops a malformed individual entry line rather than failing the whole read", () => {
    const dir = tmp();
    const header = { v: 1, startedAtWall: "2026-07-05T00:00:00.000Z", startedAtMono: "1" };
    const good = { seq: 0, ts: 0, line: 0, type: "result", isError: false };
    writeFileSync(join(dir, "timeline.jsonl"), [JSON.stringify(header), "not json either", JSON.stringify(good)].join("\n") + "\n");
    const parsed = readTimeline(dir);
    expect(parsed).toBeDefined();
    expect(parsed!.events).toEqual([good]);
  });
});
