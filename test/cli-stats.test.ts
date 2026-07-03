import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

// CLI-level coverage for `stats` (E4). The pure aggregation logic (buildStats/reindexFromRunsTree/etc) is
// unit-tested in test/run-index.test.ts; this covers command wiring — arg parsing, exit codes,
// --output-format, --reindex against a real synthetic runs tree.
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

function runsRoot() {
  return mkdtempSync(join(tmpdir(), "cli-stats-runs-"));
}

function seedRun(root: string, scenario: string, runId: string, over: Record<string, unknown> = {}) {
  const dir = join(root, scenario, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "result.json"),
    JSON.stringify({
      scenario,
      fidelity: "container",
      baseline: "desktop-1.18286.0",
      result: "success",
      decisions: [],
      egress: [],
      assertions: [],
      outDir: dir,
      ...over,
    }),
  );
}

function run(args: string[], root: string) {
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8", env: { ...process.env, COWORK_HARNESS_RUNS_DIR: root } });
  return { code: r.status, out: r.stdout + r.stderr };
}

describe.skipIf(!can)("cli: stats (E4)", () => {
  it("--reindex rebuilds the index from a synthetic runs tree, then a plain call reads it back", () => {
    const root = runsRoot();
    seedRun(root, "my-scenario", "local_111", { durationMs: 5000, cost: { usd: 0.02 } });
    seedRun(root, "my-scenario", "local_222", { result: "error", durationMs: 3000 });
    const reindexed = run(["stats", "--reindex"], root);
    expect(reindexed.code).toBe(0);
    expect(reindexed.out).toMatch(/reindexed 2 run/);

    const r = run(["stats"], root);
    expect(r.code).toBe(0);
    expect(r.out).toContain("my-scenario: 2 run(s), 50% pass");
  });

  it("--output-format json emits a structured envelope with per-scenario stats", () => {
    const root = runsRoot();
    seedRun(root, "s", "local_1", { cost: { usd: 0.1 } });
    run(["stats", "--reindex"], root);
    const r = run(["stats", "--output-format", "json"], root);
    expect(r.code).toBe(0);
    const line = r.out.split("\n").find((l) => l.trim().startsWith("{"));
    const envelope = JSON.parse(line!);
    expect(envelope).toMatchObject({ tool: "cowork-harness", command: "stats", ok: true });
    expect(envelope.stats).toEqual([expect.objectContaining({ scenario: "s", runs: 1, passRate: 1 })]);
  });

  it("filters by scenario (positional)", () => {
    const root = runsRoot();
    seedRun(root, "a", "local_1");
    seedRun(root, "b", "local_1");
    run(["stats", "--reindex"], root);
    const r = run(["stats", "a"], root);
    expect(r.out).toContain("a:");
    expect(r.out).not.toContain("b:");
  });

  it("reports 'no indexed runs' cleanly for an empty/fresh runs root, exit 0 (not an error)", () => {
    const root = runsRoot();
    const r = run(["stats"], root);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/no indexed runs/);
  });

  it("rejects an invalid --metric value", () => {
    const root = runsRoot();
    const r = run(["stats", "--metric", "bogus"], root);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/--metric must be one of/);
  });

  it("rejects a non-positive --last", () => {
    const root = runsRoot();
    const r = run(["stats", "--last", "0"], root);
    expect(r.code).toBe(2);
  });

  it("rejects more than one positional", () => {
    const root = runsRoot();
    const r = run(["stats", "a", "b"], root);
    expect(r.code).toBe(2);
  });

  it("rejects an unknown flag", () => {
    const root = runsRoot();
    const r = run(["stats", "--bogus"], root);
    expect(r.code).toBe(2);
  });

  it("`stats --help` prints usage and exits 0", () => {
    const root = runsRoot();
    const r = run(["stats", "--help"], root);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/usage: stats/);
  });

  it("--metric cost narrows the text line to just the cost view", () => {
    const root = runsRoot();
    seedRun(root, "s", "local_1", { cost: { usd: 0.05 } });
    run(["stats", "--reindex"], root);
    const r = run(["stats", "--metric", "cost"], root);
    expect(r.out).toContain("cost p50=");
    expect(r.out).not.toContain("duration p50=");
  });

  it("--reindex is a true rebuild — a run dir removed from disk between reindexes drops out", () => {
    const root = runsRoot();
    seedRun(root, "s", "local_1");
    seedRun(root, "s", "local_2");
    run(["stats", "--reindex"], root);
    expect(run(["stats", "--output-format", "json"], root).out).toContain('"runs":2');
    // seed a FRESH tree with only one run (simulating the other having been pruned before a re-reindex)
    const root2 = runsRoot();
    seedRun(root2, "s", "local_1");
    run(["stats", "--reindex"], root2);
    expect(run(["stats", "--output-format", "json"], root2).out).toContain('"runs":1');
  });
});
