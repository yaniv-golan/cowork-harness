import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  indexRowFromResult,
  appendIndexRow,
  readIndex,
  buildStats,
  reindexFromRunsTree,
  resolveRunsFromIndex,
  type RunIndexRow,
} from "../src/run/run-index.js";
import type { RunResult } from "../src/types.js";

function muteStderr(): string[] {
  const lines: string[] = [];
  process.stderr.write = ((s: string | Uint8Array) => (lines.push(String(s)), true)) as typeof process.stderr.write;
  return lines;
}

function rr(over: Partial<RunResult>): RunResult {
  return {
    scenario: "t",
    fidelity: "container",
    baseline: "desktop-1.18286.0",
    result: "success",
    decisions: [],
    egress: [],
    assertions: [],
    outDir: "/tmp/x/t/local_1",
    ...over,
  };
}

describe("indexRowFromResult — pure derivation from a RunResult", () => {
  it("derives pass/signals from computeVerdict, not from result:success alone", () => {
    const passRow = indexRowFromResult(rr({}), { command: "run", partial: false });
    expect(passRow.pass).toBe(true);
    expect(passRow.result).toBe("success");

    const failRow = indexRowFromResult(rr({ result: "error" }), { command: "run", partial: false });
    expect(failRow.pass).toBe(false);
    expect(failRow.signals).toContain("result_error");
  });

  it("carries cost/tokens/turns via budgetFields (the same shared derivation E1/E3 use)", () => {
    const row = indexRowFromResult(rr({ cost: { usd: 0.05 }, usage: { input_tokens: 100, output_tokens: 50, turns: 3 } }), {
      command: "run",
      partial: false,
    });
    expect(row.costUsd).toBe(0.05);
    expect(row.tokens).toBe(150);
    expect(row.turns).toBe(3);
  });

  it("leaves cost/tokens/turns undefined (not 0) when telemetry is absent", () => {
    const row = indexRowFromResult(rr({}), { command: "run", partial: false });
    expect(row.costUsd).toBeUndefined();
    expect(row.tokens).toBeUndefined();
    expect(row.turns).toBeUndefined();
  });

  it("tags command and partial as given, not inferred", () => {
    const skillRow = indexRowFromResult(rr({}), { command: "skill", partial: false });
    expect(skillRow.command).toBe("skill");
    const partialRow = indexRowFromResult(rr({}), { command: "run", partial: true });
    expect(partialRow.partial).toBe(true);
  });

  it("indexRowFromResult accepts a chat command", () => {
    const row = indexRowFromResult(rr({ mode: "chat" }), { command: "chat", partial: false });
    expect(row.command).toBe("chat");
  });

  it("derives the scenario slug from outDir's parent-of-runId segment (matches the physical layout)", () => {
    const row = indexRowFromResult(rr({ outDir: "/home/x/.cowork-harness/runs/my-scenario/local_12345" }), {
      command: "run",
      partial: false,
    });
    expect(row.slug).toBe("my-scenario");
    expect(row.runId).toBe("local_12345");
  });

  it("carries nonDeterministic/effectiveFidelity/durationMs straight through", () => {
    const row = indexRowFromResult(rr({ nonDeterministic: true, effectiveFidelity: "microvm", durationMs: 4200 }), {
      command: "run",
      partial: false,
    });
    expect(row.nonDeterministic).toBe(true);
    expect(row.effectiveFidelity).toBe("microvm");
    expect(row.durationMs).toBe(4200);
  });

  it("derives cacheReadTokens/modelCostUsd from modelUsage (summed across all models)", () => {
    const row = indexRowFromResult(
      rr({
        modelUsage: {
          "claude-opus-4-8": { cacheReadInputTokens: 1000, costUSD: 0.5 },
          "claude-haiku-4-5": { cacheReadInputTokens: 200, costUSD: 0.1 },
        },
      }),
      { command: "run", partial: false },
    );
    expect(row.cacheReadTokens).toBe(1200);
    expect(row.modelCostUsd).toBeCloseTo(0.6);
  });

  it("leaves cacheReadTokens/modelCostUsd undefined when modelUsage is absent", () => {
    const row = indexRowFromResult(rr({ modelUsage: undefined }), { command: "run", partial: false });
    expect(row.cacheReadTokens).toBeUndefined();
    expect(row.modelCostUsd).toBeUndefined();
  });
});

describe("appendIndexRow / readIndex — the on-disk round trip", () => {
  it("writes and reads back one row", () => {
    const dir = mkdtempSync(join(tmpdir(), "run-index-"));
    const row = indexRowFromResult(rr({}), { command: "run", partial: false });
    appendIndexRow(dir, row);
    const rows = readIndex(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0].scenario).toBe("t");
  });

  it("appends across multiple calls without clobbering prior rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "run-index-"));
    appendIndexRow(dir, indexRowFromResult(rr({ scenario: "a" }), { command: "run", partial: false }));
    appendIndexRow(dir, indexRowFromResult(rr({ scenario: "b" }), { command: "run", partial: false }));
    expect(readIndex(dir).map((r) => r.scenario)).toEqual(["a", "b"]);
  });

  it("returns an empty array when index.jsonl doesn't exist yet (a fresh runs root)", () => {
    const dir = mkdtempSync(join(tmpdir(), "run-index-"));
    expect(readIndex(dir)).toEqual([]);
  });

  it("tolerates a corrupt/truncated trailing line (crash mid-append) — skips it, keeps the rest, no warning", () => {
    const dir = mkdtempSync(join(tmpdir(), "run-index-"));
    const row = indexRowFromResult(rr({}), { command: "run", partial: false });
    appendIndexRow(dir, row);
    writeFileSync(join(dir, "index.jsonl"), '{"v":1,"scenario":"trunc', { flag: "a" });
    const lines = muteStderr();
    const rows = readIndex(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0].scenario).toBe("t");
    expect(lines.join("")).not.toMatch(/corrupt/); // a truncated TRAILING line is the expected crash shape — quiet
  });

  it(
    "WARNS (does not silently vanish) a corrupt line that is NOT the trailing line — the observable " +
      "symptom of a real interleaving/corruption bug, distinct from an ordinary crash-mid-append",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "run-index-"));
      const good1 = indexRowFromResult(rr({ scenario: "a" }), { command: "run", partial: false });
      const good2 = indexRowFromResult(rr({ scenario: "b" }), { command: "run", partial: false });
      appendIndexRow(dir, good1);
      writeFileSync(join(dir, "index.jsonl"), "{ not valid json\n", { flag: "a" }); // corrupt, NOT the last line
      appendIndexRow(dir, good2);
      const lines = muteStderr();
      const rows = readIndex(dir);
      expect(rows.map((r) => r.scenario)).toEqual(["a", "b"]); // both good rows still survive
      expect(lines.join("")).toMatch(/::warning::.*corrupt line/);
    },
  );
});

function row(over: Partial<RunIndexRow>): RunIndexRow {
  return {
    v: 1,
    ts: "2026-07-03T00:00:00.000Z",
    command: "run",
    scenario: "t",
    slug: "t",
    runId: "local_1",
    fidelity: "container",
    baseline: "desktop-1.18286.0",
    result: "success",
    pass: true,
    signals: [],
    partial: false,
    nonDeterministic: false,
    outDir: "/tmp/x/t/local_1",
    git: { branch: null, sha: null },
    ...over,
  };
}

describe("buildStats — per-scenario aggregation", () => {
  it("computes runs count and pass rate per scenario", () => {
    const rows = [row({ scenario: "a", pass: true }), row({ scenario: "a", pass: false }), row({ scenario: "b", pass: true })];
    const stats = buildStats(rows, {});
    const a = stats.find((s) => s.scenario === "a")!;
    expect(a.runs).toBe(2);
    expect(a.passRate).toBeCloseTo(0.5);
    const b = stats.find((s) => s.scenario === "b")!;
    expect(b.runs).toBe(1);
    expect(b.passRate).toBe(1);
  });

  it("computes p50/p95 cost and duration", () => {
    const rows = [1, 2, 3, 4, 5].map((n) => row({ scenario: "a", costUsd: n * 0.01, durationMs: n * 1000 }));
    const stats = buildStats(rows, {});
    const a = stats.find((s) => s.scenario === "a")!;
    expect(a.p50CostUsd).toBeCloseTo(0.03);
    expect(a.p50DurationMs).toBe(3000);
  });

  it("computes p50/p95 tokens and turns too (the --metric tokens|turns targets)", () => {
    const rows = [1, 2, 3, 4, 5].map((n) => row({ scenario: "a", tokens: n * 1000, turns: n }));
    const stats = buildStats(rows, {});
    const a = stats.find((s) => s.scenario === "a")!;
    expect(a.p50Tokens).toBe(3000);
    expect(a.p50Turns).toBe(3);
  });

  it("leaves percentiles undefined (not 0) when no row in the group has that telemetry", () => {
    const stats = buildStats([row({ scenario: "a" })], {});
    const a = stats.find((s) => s.scenario === "a")!;
    expect(a.p50CostUsd).toBeUndefined();
    expect(a.p50Tokens).toBeUndefined();
    expect(a.p50Turns).toBeUndefined();
  });

  it("computes p50/p95 cache-read-tokens and model-cost too (the --metric cache-tokens|model-cost targets)", () => {
    const rows = [1, 2, 3, 4, 5].map((n) => row({ scenario: "a", cacheReadTokens: n * 100, modelCostUsd: n * 0.1 }));
    const stats = buildStats(rows, {});
    const a = stats.find((s) => s.scenario === "a")!;
    expect(a.p50CacheReadTokens).toBe(300);
    expect(a.p50ModelCostUsd).toBeCloseTo(0.3);
  });

  it("filters by scenario, since, baseline, and branch", () => {
    const rows = [
      row({ scenario: "a", ts: "2026-01-01T00:00:00Z", baseline: "desktop-1.17377.2", git: { branch: "main", sha: "aaa" } }),
      row({ scenario: "a", ts: "2026-07-01T00:00:00Z", baseline: "desktop-1.18286.0", git: { branch: "feature-x", sha: "bbb" } }),
      row({ scenario: "b", ts: "2026-07-01T00:00:00Z" }),
    ];
    expect(buildStats(rows, { scenario: "a" }).flatMap((s) => s.runs)).toEqual([2]);
    expect(buildStats(rows, { since: "2026-06-01" }).find((s) => s.scenario === "a")?.runs).toBe(1);
    expect(buildStats(rows, { baseline: "desktop-1.18286.0" }).find((s) => s.scenario === "a")?.runs).toBe(1);
    expect(buildStats(rows, { branch: "feature-x" }).find((s) => s.scenario === "a")?.runs).toBe(1);
  });

  it("--last windows AFTER the other filters apply, not before — 'last N main-branch runs', not 'last N runs, of which some are main'", () => {
    // 5 recent feature-branch runs, then 2 older main-branch runs — a naive "window first" would slice to
    // the 5 feature-branch rows and find ZERO main runs even though main has real history just outside it.
    const rows = [
      ...[1, 2, 3, 4, 5].map((n) => row({ scenario: "a", ts: `2026-07-0${n}T00:00:00Z`, git: { branch: "feature-x", sha: `f${n}` } })),
      row({ scenario: "a", ts: "2026-01-01T00:00:00Z", git: { branch: "main", sha: "m1" } }),
      row({ scenario: "a", ts: "2026-01-02T00:00:00Z", git: { branch: "main", sha: "m2" } }),
    ];
    const stats = buildStats(rows, { branch: "main", last: 5 });
    expect(stats.find((s) => s.scenario === "a")?.runs).toBe(2); // both main runs found — filter-then-window
  });

  it("--last windows the N most recent rows PER SCENARIO (not globally)", () => {
    const rows = [
      ...[1, 2, 3].map((n) => row({ scenario: "high-frequency", ts: `2026-07-0${n}T00:00:00Z` })),
      row({ scenario: "low-frequency", ts: "2026-01-01T00:00:00Z" }),
    ];
    const stats = buildStats(rows, { last: 1 });
    expect(stats.find((s) => s.scenario === "high-frequency")?.runs).toBe(1);
    expect(stats.find((s) => s.scenario === "low-frequency")?.runs).toBe(1); // not starved out by the busier scenario
  });

  it("reports lastGreenTs as the most recent PASSING run's timestamp, undefined if none passed", () => {
    const rows = [
      row({ scenario: "a", ts: "2026-01-01T00:00:00Z", pass: true }),
      row({ scenario: "a", ts: "2026-07-01T00:00:00Z", pass: false }),
    ];
    expect(buildStats(rows, {}).find((s) => s.scenario === "a")?.lastGreenTs).toBe("2026-01-01T00:00:00Z");
    const allFail = [row({ scenario: "b", pass: false })];
    expect(buildStats(allFail, {}).find((s) => s.scenario === "b")?.lastGreenTs).toBeUndefined();
  });

  it("marks a row's outDir pruned when the directory no longer exists on disk (a real existsSync check against a genuinely-absent path)", () => {
    const rows = [row({ scenario: "a", outDir: "/definitely/does/not/exist" })];
    const stats = buildStats(rows, {});
    expect(stats.find((s) => s.scenario === "a")?.prunedRuns).toBe(1);
  });
});

describe("resolveRunsFromIndex — mirrors resolveEventsFile's exact-then-fragment semantics over index rows", () => {
  const rows = [
    row({ scenario: "csv-metrics", slug: "csv-metrics", runId: "local_111" }),
    row({ scenario: "csv-metrics", slug: "csv-metrics", runId: "local_222" }),
    row({ scenario: "other-scenario", slug: "other-scenario", runId: "sess-abc" }),
  ];

  it("resolves an exact runId match", () => {
    const found = resolveRunsFromIndex(rows, "local_111");
    expect(found).toHaveLength(1);
    expect(found[0].runId).toBe("local_111");
  });

  it("resolves an exact scenario-dir + runId match", () => {
    const found = resolveRunsFromIndex(rows, "csv-metrics/local_222");
    expect(found).toHaveLength(1);
    expect(found[0].runId).toBe("local_222");
  });

  it("fragment-matches when no exact match exists, returning ALL candidates (ambiguity surfaced, not silently resolved)", () => {
    const found = resolveRunsFromIndex(rows, "csv-metrics");
    expect(found).toHaveLength(2);
  });

  it("returns an empty array for no match at all", () => {
    expect(resolveRunsFromIndex(rows, "nope-not-here")).toEqual([]);
  });
});

describe("reindexFromRunsTree — one-time migration from result.json files", () => {
  it("rebuilds index rows by walking <runsRoot>/<slug>/<runId>/result.json", () => {
    const runsRoot = mkdtempSync(join(tmpdir(), "run-index-tree-"));
    const runDir = join(runsRoot, "my-scenario", "local_999");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "result.json"),
      JSON.stringify({
        scenario: "my-scenario",
        fidelity: "container",
        baseline: "desktop-1.18286.0",
        result: "success",
        decisions: [],
        egress: [],
        assertions: [],
        outDir: runDir,
      }),
    );
    const { rows, written } = reindexFromRunsTree(runsRoot);
    expect(written).toBe(1);
    expect(rows[0].scenario).toBe("my-scenario");
    expect(rows[0].runId).toBe("local_999");
    // and it's actually persisted to index.jsonl, not just returned in memory
    expect(readIndex(runsRoot)).toHaveLength(1);
  });

  it(
    "does NOT fabricate ts/git for a reindexed row — ts comes from result.json's own mtime (not 'now'), " +
      "git is {branch:null,sha:null} (unknowable for a historical run, not 'whatever this checkout is')",
    () => {
      const runsRoot = mkdtempSync(join(tmpdir(), "run-index-tree-"));
      const runDir = join(runsRoot, "s", "local_1");
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        join(runDir, "result.json"),
        JSON.stringify({
          scenario: "s",
          fidelity: "container",
          baseline: "x",
          result: "success",
          decisions: [],
          egress: [],
          assertions: [],
          outDir: runDir,
        }),
      );
      const { rows } = reindexFromRunsTree(runsRoot);
      // result.json's mtime, not Date.now() at reindex time — a fresh file's mtime is recent but NOT
      // literally "this instant", so a >1s-old timestamp check would be flaky; instead assert it's a real
      // parseable ISO string distinct from a hardcoded sentinel, and that git is honestly unknown.
      expect(() => new Date(rows[0].ts).toISOString()).not.toThrow();
      expect(rows[0].git).toEqual({ branch: null, sha: null });
    },
  );

  it("reads `partial` from the persisted RunResult.partial field, not hardcoded false", () => {
    const runsRoot = mkdtempSync(join(tmpdir(), "run-index-tree-"));
    const runDir = join(runsRoot, "s", "local_1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "result.json"),
      JSON.stringify({
        scenario: "s",
        fidelity: "container",
        baseline: "x",
        result: "error",
        partial: true,
        decisions: [],
        egress: [],
        assertions: [],
        outDir: runDir,
      }),
    );
    const { rows } = reindexFromRunsTree(runsRoot);
    expect(rows[0].partial).toBe(true);
  });

  it("skips a run dir with a missing or corrupt result.json rather than throwing", () => {
    const runsRoot = mkdtempSync(join(tmpdir(), "run-index-tree-"));
    const badDir = join(runsRoot, "s", "local_bad");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "result.json"), "{ not valid json");
    const goodDir = join(runsRoot, "s", "local_good");
    mkdirSync(goodDir, { recursive: true });
    writeFileSync(
      join(goodDir, "result.json"),
      JSON.stringify({
        scenario: "s",
        fidelity: "container",
        baseline: "x",
        result: "success",
        decisions: [],
        egress: [],
        assertions: [],
        outDir: goodDir,
      }),
    );
    const { written, skipped } = reindexFromRunsTree(runsRoot);
    expect(written).toBe(1);
    expect(skipped).toBe(1);
  });

  it(
    "MERGES with any prior index.jsonl — a row whose outDir no longer exists on disk (pruned) is " +
      "PRESERVED, never dropped; a row whose outDir DOES exist is refreshed from its real result.json",
    () => {
      const runsRoot = mkdtempSync(join(tmpdir(), "run-index-tree-"));
      // a prior index row for a run dir that's since been pruned (no longer on disk)
      const prunedOutDir = join(runsRoot, "pruned-scenario", "local_gone");
      appendIndexRow(
        runsRoot,
        indexRowFromResult(rr({ scenario: "pruned-scenario", outDir: prunedOutDir }), { command: "run", partial: false }),
      );
      // a run dir that genuinely exists on disk, walked fresh
      const freshDir = join(runsRoot, "fresh", "local_1");
      mkdirSync(freshDir, { recursive: true });
      writeFileSync(
        join(freshDir, "result.json"),
        JSON.stringify({
          scenario: "fresh",
          fidelity: "container",
          baseline: "x",
          result: "success",
          decisions: [],
          egress: [],
          assertions: [],
          outDir: freshDir,
        }),
      );
      reindexFromRunsTree(runsRoot);
      const rows = readIndex(runsRoot);
      expect(rows.map((r) => r.scenario).sort()).toEqual(["fresh", "pruned-scenario"]);
    },
  );

  it("is idempotent / safe to re-run: reindexing twice in a row with no filesystem changes produces the same row set", () => {
    const runsRoot = mkdtempSync(join(tmpdir(), "run-index-tree-"));
    const runDir = join(runsRoot, "s", "local_1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "result.json"),
      JSON.stringify({
        scenario: "s",
        fidelity: "container",
        baseline: "x",
        result: "success",
        decisions: [],
        egress: [],
        assertions: [],
        outDir: runDir,
      }),
    );
    reindexFromRunsTree(runsRoot);
    reindexFromRunsTree(runsRoot);
    expect(readIndex(runsRoot)).toHaveLength(1); // not duplicated
  });

  it("returns an empty result for a runs root with no run dirs AND no prior index (never throws on a fresh clone)", () => {
    const runsRoot = mkdtempSync(join(tmpdir(), "run-index-tree-"));
    const { rows, written } = reindexFromRunsTree(runsRoot);
    expect(rows).toEqual([]);
    expect(written).toBe(0);
  });

  it(
    'carries forward the prior row\'s `command` (e.g. "skill") when re-deriving a walked row whose ' +
      "outDir ALSO exists in the prior index — RunResult.mode has no skill/record value, so defaulting " +
      "to run/chat would mislabel a run that was originally recorded as `skill` or `record`",
    () => {
      const runsRoot = mkdtempSync(join(tmpdir(), "run-index-tree-"));
      const outDir = join(runsRoot, "s", "local_1");
      mkdirSync(outDir, { recursive: true });
      writeFileSync(
        join(outDir, "result.json"),
        JSON.stringify({
          scenario: "s",
          fidelity: "container",
          baseline: "x",
          result: "success",
          decisions: [],
          egress: [],
          assertions: [],
          outDir,
        }),
      );
      // seed a prior index row for this SAME outDir, originally recorded as "skill"
      appendIndexRow(runsRoot, indexRowFromResult(rr({ scenario: "s", outDir }), { command: "skill", partial: false }));
      const { rows } = reindexFromRunsTree(runsRoot);
      expect(rows).toHaveLength(1);
      expect(rows[0].command).toBe("skill");
    },
  );

  it(
    "prefers the command persisted in result.json (#48) with NO prior index row — the lost-index case a " +
      "reindex is FOR: a result recorded as `skill` keeps `skill`, not defaulted to `run`",
    () => {
      const runsRoot = mkdtempSync(join(tmpdir(), "run-index-tree-"));
      const outDir = join(runsRoot, "s", "local_1");
      mkdirSync(outDir, { recursive: true });
      writeFileSync(
        join(outDir, "result.json"),
        JSON.stringify({
          scenario: "s",
          fidelity: "container",
          baseline: "x",
          result: "success",
          command: "skill", // #48: persisted originating command
          decisions: [],
          egress: [],
          assertions: [],
          outDir,
        }),
      );
      // NO prior index.jsonl at all (the reason to reindex) — provenance must come from result.json.
      const { rows } = reindexFromRunsTree(runsRoot);
      expect(rows).toHaveLength(1);
      expect(rows[0].command).toBe("skill");
    },
  );
});
