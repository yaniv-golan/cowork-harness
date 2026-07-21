import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listTurns, latestTurn, turnArtifactPath, readTurnResult, resolveGraded, classifyRunDir } from "../src/run/turn-layout.js";
import { reindexFromRunsTree } from "../src/run/run-index.js";
import { foldResources } from "../src/runtime/resource-sampler.js";

// This file used to drive the SAME assertions against both the legacy shape and the per-turn shape and
// require the seam to answer identically — the mitigation for "the whole suite fabricates legacy-shaped
// dirs, so it keeps passing while exercising none of the new layout."
//
// That parity is no longer the model: the seam (turn-layout.ts) now addresses ONLY turns/<N>/ and
// DETECTS (never resolves) a legacy/mixed dir — see turn-layout.test.ts's classifyRunDir suite for that
// half. What's left here is what genuinely still spans both shapes: `reindexFromRunsTree` (run-index.ts),
// which independently scans for name-mangled root archives regardless of what the seam does, and
// `foldResources`, whose root fallback (no `turn` argument) is still a supported capability, not a
// legacy-shape special case.
//
// `turnDir()` used to also write a root `result.json` "compat copy" — that was accurate when execute.ts
// wrote one, but no writer does anymore (see execute.ts's success path). Leaving it in the fixture would
// silently have made this describe block's own dir MIXED (turns/ + a root marker), not the plain per-turn
// shape its title claims — `classifyRunDir` is asserted below specifically to keep that honest.

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

/** Two turns in the LEGACY shape: latest at the root, earlier name-mangled. Still a real on-disk shape
 *  `run-index.ts`'s archive scan must keep indexing — it is NOT resolved by the seam any more (see
 *  turn-layout.test.ts), but reindexing must not silently drop it either. */
function legacyDir(outDir: string) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "result.turn-1.json"), RESULT(1, { outDir, cost: { usd: 1 } }));
  writeFileSync(join(outDir, "run.turn-1.jsonl"), "{}\n");
  writeFileSync(join(outDir, "trace.turn-1.json"), '{"t":1}');
  writeFileSync(join(outDir, "result.json"), RESULT(2, { outDir, cost: { usd: 2 } }));
  writeFileSync(join(outDir, "run.jsonl"), "{}\n");
  writeFileSync(join(outDir, "trace.json"), '{"t":2}');
}

/** The same two turns in the PER-TURN shape — no root copy of anything, matching what a real run
 *  actually writes on disk today (see test/turn-layout-e2e.test.ts's real-run assertion of the same). */
function turnDir(outDir: string) {
  for (const n of [1, 2]) {
    mkdirSync(join(outDir, "turns", String(n)), { recursive: true });
    writeFileSync(join(outDir, "turns", String(n), "result.json"), RESULT(n, { outDir, cost: { usd: n } }));
    writeFileSync(join(outDir, "turns", String(n), "run.jsonl"), "{}\n");
    writeFileSync(join(outDir, "turns", String(n), "trace.json"), `{"t":${n}}`);
  }
}

/** The shape a pre-layout dir resumed under CURRENT code actually produces: turn 1 archived at the root
 *  (name-mangled, from `archivePriorTurnFiles`'s still-live legacy branch) and turn 2 under `turns/` (from
 *  `turnWriteDir`). Not hypothetical — `execute-origin-guard.test.ts` exercises the write-side gate that
 *  now REFUSES to `--resume` onto one of these; this fixture is the shape that gate exists to stop minting
 *  and the shape any dir created before that gate existed is stuck in. */
function mixedDir(outDir: string) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "result.turn-1.json"), RESULT(1, { outDir, cost: { usd: 1 } }));
  writeFileSync(join(outDir, "run.turn-1.jsonl"), "{}\n");
  writeFileSync(join(outDir, "trace.turn-1.json"), '{"t":1}');
  mkdirSync(join(outDir, "turns", "2"), { recursive: true });
  writeFileSync(join(outDir, "turns", "2", "result.json"), RESULT(2, { outDir, cost: { usd: 2 } }));
  writeFileSync(join(outDir, "turns", "2", "run.jsonl"), "{}\n");
  writeFileSync(join(outDir, "turns", "2", "trace.json"), '{"t":2}');
}

describe("the seam addresses the per-turn shape — the legacy shape is DETECTED, not resolved", () => {
  let outDir: string;
  beforeEach(() => {
    outDir = join(root, "s", "sess-1");
    turnDir(outDir);
  });

  it("classifyRunDir names this dir 'turns', not 'mixed' — no root marker snuck back in", () => {
    expect(classifyRunDir(outDir)).toEqual({ kind: "turns", turns: [1, 2] });
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

  it("resolves the GRADED turn to turns/1/ by role", () => {
    const p = resolveGraded(outDir, "trace.json");
    expect(p).toBe(join(outDir, "turns", "1", "trace.json"));
  });

  it("prefers the *.graded.json alias when critique wrote one", () => {
    writeFileSync(join(outDir, "result.graded.json"), RESULT(1, { outDir }));
    expect(resolveGraded(outDir, "result.json")).toBe(join(outDir, "result.graded.json"));
  });
});

describe("a legacy-shaped dir is classified, never silently addressed as turns/1/", () => {
  it("classifyRunDir names it legacy, and the seam finds no turns at all", () => {
    const outDir = join(root, "s", "sess-legacy");
    legacyDir(outDir);
    expect(classifyRunDir(outDir).kind).toBe("legacy");
    expect(listTurns(outDir)).toEqual([]);
    expect(readTurnResult(outDir, 1)).toBeUndefined();
    expect(readTurnResult(outDir, 2)).toBeUndefined();
  });
});

describe("a MIXED dir (turns/ + a stray root archive) is classified, and turn 1 is unaddressable through the seam", () => {
  it("classifyRunDir names it mixed; listTurns sees ONLY turns/ (the root archive is invisible to it)", () => {
    // This IS the defect the removal exists to make unrepresentable going forward (see
    // execute-origin-guard.test.ts's resume refusal) — but a dir already in this shape on disk is real,
    // and the seam must still name it rather than silently treating it as an ordinary single-turn dir.
    const outDir = join(root, "s", "sess-mixed");
    mixedDir(outDir);
    const shape = classifyRunDir(outDir);
    expect(shape.kind).toBe("mixed");
    expect(
      listTurns(outDir),
      "the seam never merges in the root archive — that union is exactly what shipped the turn-1-invisible defect",
    ).toEqual([2]);
    expect(readTurnResult(outDir, 1), "turn 1's archived result must not be silently substituted").toBeUndefined();
    expect((readTurnResult(outDir, 2) as { cost?: { usd: number } })?.cost?.usd).toBe(2);
  });
});

const SHAPES: [string, (d: string) => void][] = [
  ["legacy", legacyDir],
  ["per-turn", turnDir],
];

describe.each(SHAPES)("stats --reindex indexes BOTH turns on a %s dir, exactly once each", (_name, build) => {
  it("finds two rows and does not double-count the latest", () => {
    // run-index.ts's archive scan is independent of the seam (it does its own root-dir readdir), so it
    // keeps indexing the legacy shape's archives even though the seam no longer resolves them; the
    // per-turn shape carries no root copy at all anymore, so there is nothing left to double-count.
    const outDir = join(root, "s", "sess-x");
    build(outDir);
    const { rows } = reindexFromRunsTree(root);
    const mine = rows.filter((r) => r.outDir === outDir);
    expect(mine, `expected exactly one row per turn, got ${JSON.stringify(mine.map((r) => r.turn))}`).toHaveLength(2);
    expect(mine.map((r) => r.turn).sort()).toEqual([1, 2]);
  });
});

describe("stats --reindex on a MIXED dir — a known, pinned gap, not a claim this is fixed", () => {
  it("indexes ONLY the turns/ portion — the archived turn 1 is silently dropped", () => {
    // `reindexFromRunsTree` takes the `hasTurnDirs(outDir)` branch (enumerates turns/ only) and then
    // `continue`s past the archive scan entirely (run-index.ts) — so on a MIXED dir the archived
    // `result.turn-1.json` is never reached, unlike on a pure `legacy` dir (no turns/) where that same scan
    // is what indexes it. This is the reindex-side twin of the read-side "turn 1 unaddressable on a mixed
    // dir" defect; closing it needs a run-index.ts change, out of scope here. Pinned so a future change to
    // this behavior is a deliberate diff against a documented expectation, not a silent regression either
    // way.
    const outDir = join(root, "s", "sess-mixed-reindex");
    mixedDir(outDir);
    const { rows } = reindexFromRunsTree(root);
    const mine = rows.filter((r) => r.outDir === outDir);
    expect(mine.map((r) => r.turn)).toEqual([2]);
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

  it("still folds the root file when no turn number is given (chat's own converted lane still passes one; this covers the general capability)", () => {
    const outDir = join(root, "s", "sess-legacy-r");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "resources.jsonl"), JSON.stringify({ rssBytes: 42 }) + "\n");
    expect(foldResources(outDir, "container", 1000)?.peakRssBytes).toBe(42);
  });
});
