import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveEventsFile } from "../src/run/trace-view.js";
import { indexRowFromResult, appendIndexRow } from "../src/run/run-index.js";
import type { RunResult } from "../src/types.js";

// E4: resolveEventsFile is the single choke point trace/inspect/scaffold/status resolve a run-id/fragment
// through — this proves the index-first migration is real (not a no-op) while preserving the exact
// pre-E4 fallback for un-indexed runs, per the plan's "same commands, same output" regression bar.

function withRunsDir<T>(dir: string, fn: () => T): T {
  const prev = process.env.COWORK_HARNESS_RUNS_DIR;
  process.env.COWORK_HARNESS_RUNS_DIR = dir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.COWORK_HARNESS_RUNS_DIR;
    else process.env.COWORK_HARNESS_RUNS_DIR = prev;
  }
}

function seedRunDir(runsDir: string, scenario: string, runId: string): string {
  const outDir = join(runsDir, scenario, runId);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "events.jsonl"), '{"type":"system","subtype":"init","tools":[]}\n');
  return outDir;
}

function rr(over: Partial<RunResult>): RunResult {
  return { scenario: "t", fidelity: "container", baseline: "x", result: "success", decisions: [], egress: [], assertions: [], outDir: "/x", ...over };
}

afterEach(() => {
  delete process.env.COWORK_HARNESS_RUNS_DIR;
});

describe("resolveEventsFile — index-first (E4), filesystem-walk fallback preserved", () => {
  it("resolves an indexed run's fragment via the index (not the filesystem walk)", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "resolve-idx-"));
    const outDir = seedRunDir(runsDir, "indexed-scenario", "local_555");
    appendIndexRow(runsDir, indexRowFromResult(rr({ scenario: "indexed-scenario", outDir }), { command: "run", partial: false }));

    withRunsDir(runsDir, () => {
      const f = resolveEventsFile("555");
      expect(f).toBe(join(outDir, "events.jsonl"));
    });
  });

  it("falls through to the filesystem walk for a run that exists on disk but was never indexed", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "resolve-idx-"));
    const outDir = seedRunDir(runsDir, "never-indexed", "local_777");
    // no appendIndexRow call — index.jsonl doesn't even exist

    withRunsDir(runsDir, () => {
      const f = resolveEventsFile("777");
      expect(f).toBe(join(outDir, "events.jsonl"));
    });
  });

  it("falls through to the filesystem walk when an indexed row's outDir no longer exists (pruned)", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "resolve-idx-"));
    // index a row pointing at a run dir that was never actually created on disk
    appendIndexRow(
      runsDir,
      indexRowFromResult(rr({ scenario: "pruned-scenario", outDir: join(runsDir, "pruned-scenario", "local_999") }), {
        command: "run",
        partial: false,
      }),
    );
    // ...but a DIFFERENT, real run dir exists on disk that the walk can still find via fragment matching
    const realOutDir = seedRunDir(runsDir, "pruned-scenario", "local_999_real");

    withRunsDir(runsDir, () => {
      const f = resolveEventsFile("999");
      // the pruned index row's target doesn't exist, so resolution must fall through to the walk, which
      // finds the REAL run dir (fragment "999" also matches "local_999_real")
      expect(f).toBe(join(realOutDir, "events.jsonl"));
    });
  });

  it("resolves the exact scenario/runId form via the index", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "resolve-idx-"));
    const outDir = seedRunDir(runsDir, "my-scenario", "local_1");
    appendIndexRow(runsDir, indexRowFromResult(rr({ scenario: "my-scenario", outDir }), { command: "run", partial: false }));

    withRunsDir(runsDir, () => {
      expect(resolveEventsFile("my-scenario/local_1")).toBe(join(outDir, "events.jsonl"));
    });
  });

  it("an ambiguous indexed fragment picks the most recent (by index ts) and warns", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "resolve-idx-"));
    const outA = seedRunDir(runsDir, "s", "local_100");
    const outB = seedRunDir(runsDir, "s", "local_200");
    const rowA = indexRowFromResult(rr({ scenario: "s", outDir: outA }), { command: "run", partial: false });
    const rowB = indexRowFromResult(rr({ scenario: "s", outDir: outB }), { command: "run", partial: false });
    appendIndexRow(runsDir, { ...rowA, ts: "2026-01-01T00:00:00Z" });
    appendIndexRow(runsDir, { ...rowB, ts: "2026-07-01T00:00:00Z" });

    withRunsDir(runsDir, () => {
      const f = resolveEventsFile("local"); // matches both by runId substring
      expect(f).toBe(join(outB, "events.jsonl")); // rowB has the later ts
    });
  });
});
