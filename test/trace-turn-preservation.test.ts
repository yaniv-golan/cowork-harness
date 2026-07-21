import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archivePriorTurnFiles, currentTurn } from "../src/run/execute.js";
import { writeGradedAliases } from "../src/critique/command.js";

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

describe("critique's graded aliases are written, not just referenced in source", () => {
  // The first version of this block was TWO SOURCE-TEXT GREPS. An adversarial review broke it in one
  // edit: pointing the copy at a nonexistent filename left all 6 tests GREEN while `trace.graded.json`
  // could never be produced. Grepping for a call proves the call is written, never that it works — the
  // exact vacuous-guard pattern this repo keeps shipping. These drive the real function.
  it("copies BOTH the graded result and the graded trace", () => {
    // writeGradedAliases resolves turn 1 THROUGH the seam (turnArtifactPath) — under the current
    // single-shape layout that is turns/1/, not the run-dir root.
    mkdirSync(join(dir, "turns", "1"), { recursive: true });
    writeFileSync(join(dir, "turns", "1", "result.json"), '{"turn":1}');
    writeFileSync(join(dir, "turns", "1", "trace.json"), '{"trace":1}');
    writeGradedAliases(dir);
    expect(readFileSync(join(dir, "result.graded.json"), "utf8")).toBe('{"turn":1}');
    expect(readFileSync(join(dir, "trace.graded.json"), "utf8")).toBe('{"trace":1}');
  });

  it("copies the trace even when there is no result (and vice versa)", () => {
    // Independent best-effort copies: one missing source must not suppress the other.
    mkdirSync(join(dir, "turns", "1"), { recursive: true });
    writeFileSync(join(dir, "turns", "1", "trace.json"), '{"trace":1}');
    writeGradedAliases(dir);
    expect(existsSync(join(dir, "trace.graded.json"))).toBe(true);
    expect(existsSync(join(dir, "result.graded.json"))).toBe(false);
  });

  it("never throws when neither source exists", () => {
    // A task turn killed before either file was written must not fail the critique on a convenience copy.
    expect(() => writeGradedAliases(dir)).not.toThrow();
  });

  it("is ordered BEFORE the reflection turn can overwrite the sources", () => {
    // Kept as a source-position check because ordering is not observable from the function alone — but it
    // now supplements behavioral tests instead of standing in for them.
    const SRC = readFileSync(join(process.cwd(), "src/critique/command.ts"), "utf8");
    const callIdx = SRC.indexOf("writeGradedAliases(outDir)");
    const reflectIdx = SRC.indexOf("const reflect = await runSkillTurn(buildReflectionTurnArgs");
    expect(callIdx).toBeGreaterThan(-1);
    expect(reflectIdx, "the reflection spawn moved — re-anchor this guard").toBeGreaterThan(-1);
    expect(callIdx, "the graded aliases must be written before the reflection turn").toBeLessThan(reflectIdx);
  });
});
