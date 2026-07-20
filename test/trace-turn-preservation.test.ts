import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archivePriorTurnFiles, currentTurn } from "../src/run/execute.js";

// `trace.json` is REBUILT from the current turn's record and overwritten on every completion
// (`writeTrace`). Unlike `result.json`/`run.jsonl` it was not archived — so a second turn did not rename
// the prior trace, it DESTROYED it. A `critique` therefore lost the graded turn's trace entirely.
//
// That is strictly worse than the result-file rename that started this whole thread: a rename hides data
// behind a surprising name; an overwrite deletes it.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trace-turn-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Minimal shape of a completed turn on disk: what `currentTurn` counts, plus the files archived. */
function seedTurn(contents: string) {
  writeFileSync(join(dir, "run.jsonl"), "{}\n");
  writeFileSync(join(dir, "result.json"), "{}");
  writeFileSync(join(dir, "trace.json"), contents);
}

describe("a resumed turn preserves the prior turn's trace", () => {
  it("archives trace.json instead of letting the next turn overwrite it", () => {
    seedTurn('{"turn":1}');
    archivePriorTurnFiles(dir);
    expect(existsSync(join(dir, "trace.turn-1.json")), "turn 1's trace was destroyed, not archived").toBe(true);
    expect(readFileSync(join(dir, "trace.turn-1.json"), "utf8")).toBe('{"turn":1}');
    // and the live name is free for the incoming turn to write
    expect(existsSync(join(dir, "trace.json"))).toBe(false);
  });

  it("does NOT perturb turn detection", () => {
    // `currentTurn` counts `run.turn-<N>.jsonl` files only. Archiving a third file type must not change
    // the count — a drifting turn number would corrupt every downstream row identity.
    seedTurn("{}");
    expect(currentTurn(dir)).toBe(2);
    archivePriorTurnFiles(dir);
    expect(currentTurn(dir), "archiving trace.json changed the computed turn number").toBe(2);
  });

  it("is a no-op on turn 1 (nothing to archive yet)", () => {
    writeFileSync(join(dir, "trace.json"), "{}");
    // No run.jsonl => this IS turn 1; archiving must not rename the trace out from under it.
    archivePriorTurnFiles(dir);
    expect(existsSync(join(dir, "trace.json"))).toBe(true);
    expect(existsSync(join(dir, "trace.turn-0.json"))).toBe(false);
  });

  it("tolerates a missing trace.json", () => {
    // A turn killed before writeTrace has no trace to archive; that must not throw.
    writeFileSync(join(dir, "run.jsonl"), "{}\n");
    writeFileSync(join(dir, "result.json"), "{}");
    expect(() => archivePriorTurnFiles(dir)).not.toThrow();
  });
});

describe("critique's graded trace uses a ROLE-stable name", () => {
  const SRC = readFileSync(join(process.cwd(), "src/critique/command.ts"), "utf8");

  it("copies trace.json -> trace.graded.json beside the graded result", () => {
    // Deliberately NOT left to `trace.turn-1.json`: that name only exists once a reflection turn has run,
    // so it depends on the future exactly as `result.turn-1.json` does — the defect this contract exists
    // to remove. A `*.graded.json` name is true the moment it is written, and survives a reflection turn
    // that never completes.
    expect(SRC).toContain('copyFileSync(liveTrace, join(outDir, "trace.graded.json"))');
  });

  it("writes it BEFORE the reflection turn can overwrite trace.json", () => {
    const copyIdx = SRC.indexOf('trace.graded.json"');
    const reflectIdx = SRC.indexOf("const reflect = await runSkillTurn(buildReflectionTurnArgs");
    expect(copyIdx).toBeGreaterThan(-1);
    expect(reflectIdx, "the reflection spawn moved — re-anchor this guard").toBeGreaterThan(-1);
    expect(copyIdx, "the graded trace copy must precede the reflection turn").toBeLessThan(reflectIdx);
  });
});
