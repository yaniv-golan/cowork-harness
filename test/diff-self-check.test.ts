import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { eventsFromLines } from "../src/run/trace-view.js";
import { canonicalizeInput, diffToolSequence, type NormalizedToolRow } from "../src/run/diff.js";

// §9 lesson 1: self-diff the real committed cassette FIRST, before building the full command/rendering
// machinery — an early correctness signal, not a final regression test. If this isn't identical, the
// normalization design is wrong before any more code gets built on top of it.
function toolRowsFromEvents(lines: string[]): NormalizedToolRow[] {
  const events = eventsFromLines(lines, "example-pdf-skill.cassette.json");
  return events
    .filter((e) => e.type === "tool_use" && !e.parentToolUseId && !e.synthetic)
    .map((e: any) => ({ name: e.name, canon: canonicalizeInput(e.input) }));
}

describe("§9 lesson 1 checkpoint: self-diff the real committed cassette", () => {
  it("example-pdf-skill.cassette.json diffed against itself is identical (every op is 'same')", () => {
    const cassette = JSON.parse(readFileSync("examples/replays/example-pdf-skill.cassette.json", "utf8"));
    const rows = toolRowsFromEvents(cassette.events);
    expect(rows.length).toBeGreaterThan(0); // sanity: the fixture actually has tool calls to compare
    const ops = diffToolSequence(rows, rows);
    expect(ops.every((o) => o.op === "same")).toBe(true);
    expect(ops).toHaveLength(rows.length);
  });

  it("example-multiselect-gate.cassette.json diffed against itself is also identical", () => {
    const cassette = JSON.parse(readFileSync("examples/replays/example-multiselect-gate.cassette.json", "utf8"));
    const rows = toolRowsFromEvents(cassette.events);
    const ops = diffToolSequence(rows, rows);
    expect(ops.every((o) => o.op === "same")).toBe(true);
  });
});
