import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

function makeRunDir(runsRoot: string, scenario: string, runId: string): string {
  const dir = join(runsRoot, scenario, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), JSON.stringify({ result: "success" }));
  return dir;
}

describe.skipIf(!can)("runs gc", () => {
  it("usage: --keep-last 0 exits 2 with a clear message", () => {
    const r = spawnSync("node", [CLI, "runs", "gc", "--keep-last", "0"], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--keep-last must be a positive integer/);
  });

  it("runs gc on a non-existent directory exits 0", () => {
    const r = spawnSync("node", [CLI, "runs", "gc", "/tmp/does-not-exist-cwh-test"], { encoding: "utf8" });
    expect(r.status).toBe(0);
  });

  it("runs gc --dry-run does not delete any directories", () => {
    const runsRoot = mkdtempSync(join(tmpdir(), "cwh-runs-"));
    makeRunDir(runsRoot, "my-scenario", "run-a");
    makeRunDir(runsRoot, "my-scenario", "run-b");
    makeRunDir(runsRoot, "my-scenario", "run-c");
    const r = spawnSync("node", [CLI, "runs", "gc", "--keep-last", "1", "--dry-run", runsRoot], {
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/dry.run/i);
    // All directories still exist
    const remaining = readdirSync(join(runsRoot, "my-scenario"));
    expect(remaining.length).toBe(3);
  });

  it("runs gc --keep-last 1 leaves exactly 1 run dir per scenario", () => {
    const runsRoot = mkdtempSync(join(tmpdir(), "cwh-runs-"));
    // Three run dirs; the mtime tiebreaker sorts alphabetically descending,
    // so "run-c" is "newest" and will be kept.
    makeRunDir(runsRoot, "s", "run-a");
    makeRunDir(runsRoot, "s", "run-b");
    makeRunDir(runsRoot, "s", "run-c");
    const r = spawnSync("node", [CLI, "runs", "gc", "--keep-last", "1", runsRoot], { encoding: "utf8" });
    expect(r.status).toBe(0);
    const remaining = readdirSync(join(runsRoot, "s"));
    expect(remaining.length).toBe(1);
  });

  it("runs gc --keep-last N ≥ count leaves all dirs intact", () => {
    const runsRoot = mkdtempSync(join(tmpdir(), "cwh-runs-"));
    makeRunDir(runsRoot, "s", "run-a");
    makeRunDir(runsRoot, "s", "run-b");
    const r = spawnSync("node", [CLI, "runs", "gc", "--keep-last", "5", runsRoot], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(readdirSync(join(runsRoot, "s")).length).toBe(2);
  });
});
