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

describe.skipIf(!can)("prune", () => {
  it("usage: --keep-last 0 exits 2 with a clear message", () => {
    const r = spawnSync("node", [CLI, "prune", "--keep-last", "0"], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--keep-last must be a positive integer/);
  });

  it("prune on a non-existent directory exits 0", () => {
    const r = spawnSync("node", [CLI, "prune", "/tmp/does-not-exist-cwh-test"], { encoding: "utf8" });
    expect(r.status).toBe(0);
  });

  it("prune --dry-run does not delete any directories", () => {
    const runsRoot = mkdtempSync(join(tmpdir(), "cwh-runs-"));
    makeRunDir(runsRoot, "my-scenario", "run-a");
    makeRunDir(runsRoot, "my-scenario", "run-b");
    makeRunDir(runsRoot, "my-scenario", "run-c");
    const r = spawnSync("node", [CLI, "prune", "--keep-last", "1", "--dry-run", runsRoot], {
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/dry.run/i);
    // All directories still exist
    const remaining = readdirSync(join(runsRoot, "my-scenario"));
    expect(remaining.length).toBe(3);
  });

  it("prune --keep-last 1 leaves exactly 1 run dir per scenario", () => {
    const runsRoot = mkdtempSync(join(tmpdir(), "cwh-runs-"));
    // Three run dirs; the mtime tiebreaker sorts alphabetically descending,
    // so "run-c" is "newest" and will be kept.
    makeRunDir(runsRoot, "s", "run-a");
    makeRunDir(runsRoot, "s", "run-b");
    makeRunDir(runsRoot, "s", "run-c");
    const r = spawnSync("node", [CLI, "prune", "--keep-last", "1", runsRoot], { encoding: "utf8" });
    expect(r.status).toBe(0);
    const remaining = readdirSync(join(runsRoot, "s"));
    expect(remaining.length).toBe(1);
  });

  it("prune --keep-last N ≥ count leaves all dirs intact", () => {
    const runsRoot = mkdtempSync(join(tmpdir(), "cwh-runs-"));
    makeRunDir(runsRoot, "s", "run-a");
    makeRunDir(runsRoot, "s", "run-b");
    const r = spawnSync("node", [CLI, "prune", "--keep-last", "5", runsRoot], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(readdirSync(join(runsRoot, "s")).length).toBe(2);
  });

  // §1c — pinned sess-* dirs are persisted/resumable sessions on the shared root: never pruned, and they
  // must NOT consume a --keep-last slot (partition before counting), or a retained pinned dir would evict
  // a newer ephemeral local_* that should survive.
  it("never prunes pinned sess-* dirs, and they don't consume a --keep-last slot", () => {
    const runsRoot = mkdtempSync(join(tmpdir(), "cwh-runs-"));
    makeRunDir(runsRoot, "s", "sess-ci"); // pinned — must survive
    makeRunDir(runsRoot, "s", "local_a");
    makeRunDir(runsRoot, "s", "local_b");
    makeRunDir(runsRoot, "s", "local_c"); // newest ephemeral by name-desc tiebreaker — must survive
    const r = spawnSync("node", [CLI, "prune", "--keep-last", "1", runsRoot], { encoding: "utf8" });
    expect(r.status).toBe(0);
    const remaining = readdirSync(join(runsRoot, "s")).sort();
    expect(remaining).toContain("sess-ci"); // pinned retained
    expect(remaining).toContain("local_c"); // the 1 kept ephemeral — proves sess-* didn't eat the slot
    expect(remaining).not.toContain("local_a");
    expect(remaining).not.toContain("local_b");
    expect(remaining.length).toBe(2);
  });

  // H6: a COMPLETED run (has result.json) outranks a newer EMPTY scaffold dir for a keep slot. The completed
  // run's name sorts LAST by the name-desc tiebreaker, so under the old pure-mtime+name ranking the empty dir
  // would have won the single slot — the real-run-first ranking flips that. keep-last stays a hard cap (1 kept).
  it("prefers a completed run over a newer empty (no result.json/events.jsonl) dir", () => {
    const runsRoot = mkdtempSync(join(tmpdir(), "cwh-runs-"));
    makeRunDir(runsRoot, "s", "local_aaa"); // completed (result.json); sorts LAST by name-desc
    mkdirSync(join(runsRoot, "s", "local_zzz"), { recursive: true }); // newer EMPTY scaffold; sorts FIRST by name-desc
    const r = spawnSync("node", [CLI, "prune", "--keep-last", "1", runsRoot], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(readdirSync(join(runsRoot, "s"))).toEqual(["local_aaa"]); // completed survived; empty pruned; count == keep-last
  });

  // H6: a real-but-THREW run (no result.json, but a session started so events.jsonl exists) is a real run.
  it("retains a run with events.jsonl but no result.json (a threw/in-flight run) over an empty dir", () => {
    const runsRoot = mkdtempSync(join(tmpdir(), "cwh-runs-"));
    const threw = join(runsRoot, "s", "local_aaa");
    mkdirSync(threw, { recursive: true });
    writeFileSync(join(threw, "events.jsonl"), '{"type":"init"}\n'); // started; no result.json
    mkdirSync(join(runsRoot, "s", "local_zzz"), { recursive: true }); // empty scaffold
    const r = spawnSync("node", [CLI, "prune", "--keep-last", "1", runsRoot], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(readdirSync(join(runsRoot, "s"))).toEqual(["local_aaa"]);
  });
});
