import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { archivePriorTurnRunJsonl } from "../src/run/execute";

// A1: a resumed turn must not clobber a prior turn's run.jsonl. `run.jsonl` stays the LATEST turn
// (the transcript-sidecar readers depend on that), and earlier turns are preserved as
// run.turn-<N>.jsonl so turn 1's transcript is still recoverable after --resume.
describe("run.jsonl per-turn preservation (A1)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cc-runturns-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const writeRun = (label: string) => writeFileSync(join(dir, "run.jsonl"), JSON.stringify({ t: "run", label }) + "\n");

  it("returns turn 1 and archives nothing on the first write", () => {
    expect(archivePriorTurnRunJsonl(dir)).toBe(1);
    expect(readdirSync(dir).filter((f) => f.startsWith("run.turn-"))).toEqual([]);
  });

  it("archives each prior turn under run.turn-<N>.jsonl instead of clobbering it", () => {
    // turn 1
    expect(archivePriorTurnRunJsonl(dir)).toBe(1);
    writeRun("turn-1-content");
    // turn 2 (resume): prior turn-1 run.jsonl is archived, this write is turn 2
    expect(archivePriorTurnRunJsonl(dir)).toBe(2);
    writeRun("turn-2-content");
    // turn 3 (resume again)
    expect(archivePriorTurnRunJsonl(dir)).toBe(3);
    writeRun("turn-3-content");

    // turn 1's content survives in its archive — the clobber footgun is gone
    expect(existsSync(join(dir, "run.turn-1.jsonl"))).toBe(true);
    expect(readFileSync(join(dir, "run.turn-1.jsonl"), "utf8")).toContain("turn-1-content");
    expect(existsSync(join(dir, "run.turn-2.jsonl"))).toBe(true);
    expect(readFileSync(join(dir, "run.turn-2.jsonl"), "utf8")).toContain("turn-2-content");
    // run.jsonl is the LATEST turn (back-compat for transcript-sidecar readers)
    expect(readFileSync(join(dir, "run.jsonl"), "utf8")).toContain("turn-3-content");
  });
});
