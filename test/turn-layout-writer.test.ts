import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentTurn } from "../src/run/execute.js";
import { currentTurnFromDirs, listTurns, turnWriteDir } from "../src/run/turn-layout.js";

// The per-turn layout's crash contract. This is the part that killed the first draft of the plan, so it
// is tested first and hardest.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "turn-writer-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const completeTurn = (n: number) => {
  mkdirSync(join(dir, "turns", String(n)), { recursive: true });
  writeFileSync(join(dir, "turns", String(n), "run.jsonl"), "{}\n");
  writeFileSync(join(dir, "turns", String(n), "result.json"), JSON.stringify({ turn: n }));
};

describe("turn detection is keyed on run.jsonl, not result.json", () => {
  it("counts a completed turn", () => {
    completeTurn(1);
    expect(currentTurn(dir)).toBe(2);
  });

  it("a mkdir'd-then-crashed turn dir is NOT a turn — the retry reuses it", () => {
    completeTurn(1);
    mkdirSync(join(dir, "turns", "2"), { recursive: true });
    expect(currentTurn(dir), "an empty turn dir inflated the turn number").toBe(2);
  });

  it("an ORPHAN run.jsonl counts as a completed turn — the retry must NOT overwrite it", () => {
    // THE case that broke the first design. The writer emits run.jsonl BEFORE result.json, so a crash
    // between them leaves a turn whose transcript is COMPLETE and whose result assembly failed: a real,
    // paid, history-advancing turn. Keying completeness on result.json would call it incomplete and let
    // the retry clobber a finished transcript — and on a retried turn 1 (which gets no events marker) it
    // would fuse two attempts' events into one verdict.
    completeTurn(1);
    mkdirSync(join(dir, "turns", "2"), { recursive: true });
    writeFileSync(join(dir, "turns", "2", "run.jsonl"), "{}\n"); // transcript written, result never
    expect(currentTurn(dir), "a completed transcript was treated as an incomplete turn").toBe(3);
  });

  it("ignores non-numeric turn entries", () => {
    completeTurn(1);
    mkdirSync(join(dir, "turns", "2junk"), { recursive: true });
    writeFileSync(join(dir, "turns", "2junk", "run.jsonl"), "{}\n");
    expect(currentTurnFromDirs(dir)).toBe(2);
  });

  it("falls back to the LEGACY rule when there are no turn dirs", () => {
    // chat dirs, and every run dir written before this change, are legacy-shaped forever.
    writeFileSync(join(dir, "run.jsonl"), "{}\n");
    writeFileSync(join(dir, "result.json"), "{}");
    expect(currentTurn(dir)).toBe(2);
  });
});

describe("turnWriteDir", () => {
  it("creates the turn directory", () => {
    const d = turnWriteDir(dir, 3);
    expect(existsSync(d)).toBe(true);
    expect(d).toBe(join(dir, "turns", "3"));
  });

  it("is idempotent (a retry reusing its own turn must not fail)", () => {
    turnWriteDir(dir, 2);
    expect(() => turnWriteDir(dir, 2)).not.toThrow();
  });
});

describe("the four per-turn artifacts are addressable per turn", () => {
  it("each turn keeps its own copy — nothing is renamed or overwritten", () => {
    completeTurn(1);
    writeFileSync(join(dir, "turns", "1", "trace.json"), '{"t":1}');
    completeTurn(2);
    writeFileSync(join(dir, "turns", "2", "trace.json"), '{"t":2}');
    expect(listTurns(dir)).toEqual([1, 2]);
    // Defect #2, encoded: turn 1's trace used to be DESTROYED by turn 2's write.
    expect(existsSync(join(dir, "turns", "1", "trace.json"))).toBe(true);
    expect(existsSync(join(dir, "turns", "2", "trace.json"))).toBe(true);
  });
});
