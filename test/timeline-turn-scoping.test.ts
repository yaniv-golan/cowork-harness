import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTimeline } from "../src/agent/timeline.js";

// `timeline.jsonl` is opened APPEND-mode with a fresh header per turn, so a resumed run's file is
// [header1, ...turn-1..., header2, ...turn-2...]. `readTimeline` used to return EVERY line after the
// first as an event, so turn 2 got turn 1's events.
//
// That is not merely telemetry noise: `skill_tool_used` evaluates against `ctx.skillActivity`, which is
// foldSkillActivity over exactly these events (execute.ts feeds the same read into the evaluate ctx and
// the result). A turn-1 skill window could therefore satisfy a turn-2 assertion — a FALSE PASS.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "timeline-turns-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const header = (wall: string) => JSON.stringify({ v: 1, startedAtWall: wall, startedAtMono: "1000" });
const ev = (seq: number, skillId: string) => JSON.stringify({ seq, ts: seq * 10, line: seq, type: "tool_start", tool: "Bash", skillId });

function write(...lines: string[]) {
  writeFileSync(join(dir, "timeline.jsonl"), lines.join("\n") + "\n");
}

describe("readTimeline returns only the CURRENT turn", () => {
  it("drops the prior turn's events on a two-segment file", () => {
    write(header("2026-01-01T00:00:00Z"), ev(0, "turn1-skill"), ev(1, "turn1-skill"), header("2026-01-01T01:00:00Z"), ev(0, "turn2-skill"));
    const r = readTimeline(dir)!;
    expect(r.events).toHaveLength(1);
    expect(r.events.map((e) => (e as { skillId?: string }).skillId)).toEqual(["turn2-skill"]);
  });

  it("does NOT return the second header as an event", () => {
    // It parses as valid JSON, so it used to be pushed into the event array — with no `seq`/`type`, and
    // without incrementing malformedLines, so the evidence-unavailable guard never fired on it.
    write(header("a"), ev(0, "s"), header("b"), ev(0, "s"));
    const r = readTimeline(dir)!;
    expect(
      r.events.every((e) => typeof (e as { seq?: number }).seq === "number"),
      "a header leaked into the events array",
    ).toBe(true);
  });

  it("returns the LAST header, so ts values pair with the right origin", () => {
    write(header("2026-01-01T00:00:00Z"), ev(0, "s"), header("2026-01-01T09:99:99Z"), ev(0, "s"));
    expect(readTimeline(dir)!.header?.startedAtWall).toBe("2026-01-01T09:99:99Z");
  });

  it("an empty FINAL segment returns nothing — never the prior turn's events", () => {
    // A turn that died immediately after opening its timeline. Returning turn 1's events here would
    // silently resurrect the exact contamination this fix removes, on the crash path.
    write(header("a"), ev(0, "turn1"), ev(1, "turn1"), header("b"));
    expect(readTimeline(dir)!.events).toHaveLength(0);
  });

  it("is unchanged for a single-turn file (the 99% path)", () => {
    write(header("a"), ev(0, "s"), ev(1, "s"), ev(2, "s"));
    const r = readTimeline(dir)!;
    expect(r.events).toHaveLength(3);
    expect(r.malformedLines).toBe(0);
    expect(r.headerCorrupt).toBeUndefined();
  });
});

describe("readTimeline degrades safely on damaged files", () => {
  it("a corrupt FIRST line is headerCorrupt even when a later header is valid", () => {
    // Deliberate: a file whose head is damaged is not trustworthy to segment. headerCorrupt routes the
    // callers to evidence-unavailable, which is the fail-safe direction.
    write("{not json", ev(0, "s"), header("b"), ev(0, "s"));
    const r = readTimeline(dir)!;
    expect(r.headerCorrupt).toBe(true);
    expect(r.events).toHaveLength(0);
  });

  it("a first line that PARSES but is not a header is also headerCorrupt", () => {
    // Previously accepted as a bogus header, with every later line returned as an event.
    write(ev(0, "s"), ev(1, "s"));
    expect(readTimeline(dir)!.headerCorrupt).toBe(true);
  });

  it("a corrupt MID-FILE header merges the turns but raises malformedLines", () => {
    // The boundary is lost, so the segments merge — but the same line fails JSON.parse, and every real
    // consumer treats malformedLines > 0 as evidence-unavailable. Fail-safe rather than silently blended.
    write(header("a"), ev(0, "turn1"), "{corrupt-header", ev(0, "turn2"));
    const r = readTimeline(dir)!;
    expect(r.malformedLines).toBeGreaterThan(0);
  });

  it("counts malformed lines only within the RETURNED segment", () => {
    // A corrupt line in turn 1 does not make turn 2's telemetry incomplete.
    write(header("a"), "{corrupt", header("b"), ev(0, "s"));
    const r = readTimeline(dir)!;
    expect(r.malformedLines, "an earlier segment's corruption was charged to the current turn").toBe(0);
    expect(r.events).toHaveLength(1);
  });
});
