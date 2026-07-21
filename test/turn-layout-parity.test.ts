import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listTurns, latestTurn, turnArtifactPath, readTurnResult, resolveGraded } from "../src/run/turn-layout.js";
import { reindexFromRunsTree } from "../src/run/run-index.js";
import { foldResources } from "../src/runtime/resource-sampler.js";

// CROSS-LAYOUT PARITY.
//
// The per-turn layout landed with a legacy branch that must keep working forever (chat dirs never
// participate in turn bookkeeping, and every run dir written before the change is legacy-shaped). That
// creates a specific hazard: the whole existing suite fabricates legacy-shaped dirs, so it keeps passing
// while exercising NONE of the new layout — the flip would ship on legacy-only coverage, which is this
// repo's vacuous-guard pattern at the level of a whole feature.
//
// Rather than mechanically migrate ~19 fixture files (most of which legitimately test the legacy shape),
// this drives the SAME assertions against BOTH shapes and requires the answers to agree. A consumer that
// works on one and not the other fails here.

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "parity-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const RESULT = (turn: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    command: "skill",
    scenario: "s",
    fidelity: "container",
    baseline: "b",
    result: "success",
    startedAt: new Date().toISOString(),
    decisions: [],
    egress: [],
    assertions: [],
    turn,
    ...extra,
  });

/** Two turns in the LEGACY shape: latest at the root, earlier name-mangled. */
function legacyDir(outDir: string) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "result.turn-1.json"), RESULT(1, { outDir, cost: { usd: 1 } }));
  writeFileSync(join(outDir, "run.turn-1.jsonl"), "{}\n");
  writeFileSync(join(outDir, "trace.turn-1.json"), '{"t":1}');
  writeFileSync(join(outDir, "result.json"), RESULT(2, { outDir, cost: { usd: 2 } }));
  writeFileSync(join(outDir, "run.jsonl"), "{}\n");
  writeFileSync(join(outDir, "trace.json"), '{"t":2}');
}

/** The same two turns in the PER-TURN shape, plus the root compat copy the writer emits. */
function turnDir(outDir: string) {
  for (const n of [1, 2]) {
    mkdirSync(join(outDir, "turns", String(n)), { recursive: true });
    writeFileSync(join(outDir, "turns", String(n), "result.json"), RESULT(n, { outDir, cost: { usd: n } }));
    writeFileSync(join(outDir, "turns", String(n), "run.jsonl"), "{}\n");
    writeFileSync(join(outDir, "turns", String(n), "trace.json"), `{"t":${n}}`);
  }
  writeFileSync(join(outDir, "result.json"), RESULT(2, { outDir, cost: { usd: 2 } })); // compat copy
}

const SHAPES: [string, (d: string) => void][] = [
  ["legacy", legacyDir],
  ["per-turn", turnDir],
];

describe.each(SHAPES)("the seam answers identically on a %s two-turn dir", (_name, build) => {
  let outDir: string;
  beforeEach(() => {
    outDir = join(root, "s", "sess-1");
    build(outDir);
  });

  it("enumerates both turns", () => {
    expect(listTurns(outDir)).toEqual([1, 2]);
    expect(latestTurn(outDir)).toBe(2);
  });

  it("reads each turn's own result", () => {
    expect((readTurnResult(outDir, 1) as { cost?: { usd: number } })?.cost?.usd).toBe(1);
    expect((readTurnResult(outDir, 2) as { cost?: { usd: number } })?.cost?.usd).toBe(2);
  });

  it("addresses every per-turn artifact of turn 1 to a file that EXISTS", () => {
    // The seam returns paths whether or not they exist, so assert existence explicitly — otherwise a
    // wrong-but-plausible path passes.
    for (const a of ["result.json", "run.jsonl", "trace.json"] as const) {
      const p = turnArtifactPath(outDir, 1, a);
      expect(readdirSync(join(p, "..")), `${a} for turn 1 resolved to a nonexistent ${p}`).toContain(p.split("/").pop());
    }
  });

  it("resolves the GRADED turn to turn 1 by role", () => {
    const p = resolveGraded(outDir, "trace.json");
    expect(p).toBeDefined();
    expect(String(p)).toContain(_name === "legacy" ? "trace.turn-1.json" : join("turns", "1", "trace.json"));
  });

  it("prefers the *.graded.json alias when critique wrote one", () => {
    writeFileSync(join(outDir, "result.graded.json"), RESULT(1, { outDir }));
    expect(resolveGraded(outDir, "result.json")).toBe(join(outDir, "result.graded.json"));
  });
});

describe.each(SHAPES)("stats --reindex indexes BOTH turns on a %s dir, exactly once each", (_name, build) => {
  it("finds two rows and does not double-count the latest", () => {
    // The per-turn shape carries the latest turn TWICE on disk (turns/2 + the root compat copy). Indexing
    // both would write two rows with one identity for one completion — the double-count this asserts against.
    const outDir = join(root, "s", "sess-x");
    build(outDir);
    const { rows } = reindexFromRunsTree(root);
    const mine = rows.filter((r) => r.outDir === outDir);
    expect(mine, `expected exactly one row per turn, got ${JSON.stringify(mine.map((r) => r.turn))}`).toHaveLength(2);
    expect(mine.map((r) => r.turn).sort()).toEqual([1, 2]);
  });
});

describe("resources are scoped per turn in the new layout", () => {
  it("folds only THIS turn's samples", () => {
    // Defect #5, encoded at the fold: turn 1's peak must not be judged against turn 2's cap.
    const outDir = join(root, "s", "sess-r");
    mkdirSync(join(outDir, "turns", "1"), { recursive: true });
    mkdirSync(join(outDir, "turns", "2"), { recursive: true });
    writeFileSync(join(outDir, "turns", "1", "resources.jsonl"), JSON.stringify({ rssBytes: 900_000_000 }) + "\n");
    writeFileSync(join(outDir, "turns", "2", "resources.jsonl"), JSON.stringify({ rssBytes: 1_000 }) + "\n");
    const fold = foldResources(outDir, "container", 1000, undefined, 2);
    expect(fold?.peakRssBytes, "turn 1's peak leaked into turn 2's fold").toBe(1_000);
  });

  it("still folds the root file for a legacy/chat dir (no turn number)", () => {
    const outDir = join(root, "s", "sess-legacy-r");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "resources.jsonl"), JSON.stringify({ rssBytes: 42 }) + "\n");
    expect(foldResources(outDir, "container", 1000)?.peakRssBytes).toBe(42);
  });
});
