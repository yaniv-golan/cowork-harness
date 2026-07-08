import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { archivePriorTurnFiles, currentTurn } from "../src/run/execute";

// A1/B3: a resumed turn must not clobber a prior turn's run.jsonl / result.json. Both stay the LATEST
// turn (their readers depend on that); earlier turns are preserved as run.turn-<N>.jsonl /
// result.turn-<N>.json so turn 1's transcript and result stay recoverable after --resume.
describe("per-turn run.jsonl/result.json preservation (A1/B3)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cc-runturns-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const writeTurn = (n: number) => {
    writeFileSync(join(dir, "run.jsonl"), JSON.stringify({ t: "run", label: `run-${n}` }) + "\n");
    writeFileSync(join(dir, "result.json"), JSON.stringify({ turn: n, label: `result-${n}` }));
  };

  it("returns turn 1 and archives nothing on the first write", () => {
    expect(currentTurn(dir)).toBe(1);
    expect(archivePriorTurnFiles(dir)).toBe(1);
    expect(readdirSync(dir).filter((f) => /\.turn-\d+\./.test(f))).toEqual([]);
  });

  it("archives each prior turn's run.jsonl AND result.json instead of clobbering them", () => {
    expect(archivePriorTurnFiles(dir)).toBe(1);
    writeTurn(1);
    // turn 2 (resume): prior turn-1 files archived, this write is turn 2
    expect(currentTurn(dir)).toBe(2);
    expect(archivePriorTurnFiles(dir)).toBe(2);
    writeTurn(2);
    // turn 3
    expect(archivePriorTurnFiles(dir)).toBe(3);
    writeTurn(3);

    // both files' earlier turns survive in their archives — the clobber footgun is gone
    expect(readFileSync(join(dir, "run.turn-1.jsonl"), "utf8")).toContain("run-1");
    expect(readFileSync(join(dir, "result.turn-1.json"), "utf8")).toContain("result-1");
    expect(readFileSync(join(dir, "run.turn-2.jsonl"), "utf8")).toContain("run-2");
    expect(readFileSync(join(dir, "result.turn-2.json"), "utf8")).toContain("result-2");
    // the live files are the LATEST turn (back-compat for their readers)
    expect(readFileSync(join(dir, "run.jsonl"), "utf8")).toContain("run-3");
    expect(readFileSync(join(dir, "result.json"), "utf8")).toContain("result-3");
  });
});
