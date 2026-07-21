import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

// Drives the REAL CLI. The unit tests cover assess/execute; this covers the thing a user actually runs —
// argument handling, the dry-run default, the report, and the exit code. A feature can be perfectly
// implemented and still be unreachable from the command line.

const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

function runsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mig-cli-"));
  const d = join(root, "scn", "sess-a");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "result.json"), JSON.stringify({ scenario: "scn", turn: 1 }));
  writeFileSync(join(d, "run.jsonl"), `{"t":"transcript"}`);
  writeFileSync(join(d, "events.jsonl"), "");
  // A dir that must be REFUSED, not laundered: no transcript anywhere.
  const bad = join(root, "empty", "local_x");
  mkdirSync(bad, { recursive: true });
  writeFileSync(join(bad, "resources.jsonl"), `{"ts":1}`);
  return root;
}

const run = (args: string[]) => spawnSync("node", [CLI, "migrate-run-dir", ...args], { encoding: "utf8" });

describe.skipIf(!can)("migrate-run-dir CLI", () => {
  it("DRY RUNS BY DEFAULT — reports the work without touching anything", () => {
    const root = runsRoot();
    const before = readFileSync(join(root, "scn", "sess-a", "result.json"), "utf8");
    const r = run([root]);
    expect(`${r.stdout}${r.stderr}`).toMatch(/\(dry-run\)/);
    expect(`${r.stdout}${r.stderr}`).toMatch(/1 to migrate/);
    // The safe mode is the one you get by accident: no --write, no writes.
    expect(existsSync(join(root, "scn", "sess-a", "turns")), "the dry run migrated the directory").toBe(false);
    expect(readFileSync(join(root, "scn", "sess-a", "result.json"), "utf8")).toBe(before);
    rmSync(root, { recursive: true, force: true });
  });

  it("--write migrates, leaves non-per-turn files at the root, and is idempotent", () => {
    const root = runsRoot();
    const d = join(root, "scn", "sess-a");
    expect(run([root, "--write"]).status).toBe(1); // 1 because the empty dir is refused

    expect(readFileSync(join(d, "turns", "1", "result.json"), "utf8")).toContain(`"turn":1`);
    expect(existsSync(join(d, "result.json")), "root artifact not moved").toBe(false);
    expect(existsSync(join(d, "events.jsonl")), "events.jsonl must never move — trace depends on it").toBe(true);

    const second = run([root, "--write"]);
    expect(`${second.stdout}${second.stderr}`, "a second pass should find nothing to migrate").toMatch(/0 to migrate/);
    rmSync(root, { recursive: true, force: true });
  });

  it("ENUMERATES refusals with their reason and exits non-zero", () => {
    const root = runsRoot();
    const r = run([root]);
    const all = `${r.stdout}${r.stderr}`;
    expect(all, "a refusal was counted but not named — a bare count reads as 'nothing to do'").toMatch(/empty\/local_x/);
    expect(all).toMatch(/no run\.jsonl anywhere/);
    expect(r.status, "refusals are unfinished work and must be visible to a CI caller").toBe(1);
    rmSync(root, { recursive: true, force: true });
  });

  it("exits 0 and reports nothing to do on a root with no legacy dirs", () => {
    const root = mkdtempSync(join(tmpdir(), "mig-cli-clean-"));
    const d = join(root, "scn", "sess-a", "turns", "1");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "result.json"), JSON.stringify({ scenario: "scn", turn: 1 }));
    writeFileSync(join(d, "run.jsonl"), `{"t":"transcript"}`);
    const r = run([root]);
    expect(r.status).toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/1 already current/);
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects more than one positional", () => {
    const r = run(["a", "b"]);
    expect(r.status).toBe(2);
    expect(`${r.stdout}${r.stderr}`).toMatch(/optional <runs-dir>/);
  });
});

describe.skipIf(!can)("orphaned journals and the dry-run guarantee", () => {
  it("SWEEPS a journal whose run dir no longer exists, instead of deadlocking prune forever", () => {
    // The walker iterates RUN DIRS, so a journal whose dir was deleted is never visited and never swept.
    // `prune` then skips that scenario permanently, printing "run migrate-run-dir to finish" — advice that
    // provably does nothing. Nothing in the system could clear the state.
    const root = mkdtempSync(join(tmpdir(), "mig-orphan-"));
    const jd = join(root, ".migrating", "ghost");
    mkdirSync(jd, { recursive: true });
    const jp = join(jd, "sess-gone.json");
    writeFileSync(
      jp,
      JSON.stringify({ outDir: join(root, "ghost", "sess-gone"), ops: [], dirMtimes: {}, identity: { ino: 1, birthtimeMs: 1 } }),
    );

    const r = spawnSync("node", [CLI, "migrate-run-dir", root, "--write"], { encoding: "utf8" });
    expect(existsSync(jp), "an orphaned journal survived — prune will skip this scenario forever").toBe(false);
    expect(`${r.stdout}${r.stderr}`, "the sweep was silent").toMatch(/orphan/i);
    rmSync(root, { recursive: true, force: true });
  });

  it("DRY RUN performs no recovery and writes nothing, even with a journal in flight", () => {
    // The no-write guarantee had zero coverage: a mutant that ran recovery under dry-run moved files and
    // deleted the journal while still printing "(dry-run)", and the whole suite stayed green.
    const root = mkdtempSync(join(tmpdir(), "mig-dryrun-"));
    const d = join(root, "scn", "sess-a");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "result.json"), JSON.stringify({ scenario: "scn", turn: 1 }));
    writeFileSync(join(d, "run.jsonl"), `{"t":"transcript"}`);
    const jd = join(root, ".migrating", "scn");
    mkdirSync(jd, { recursive: true });
    const jp = join(jd, "sess-a.json");
    writeFileSync(jp, JSON.stringify({ outDir: d, ops: [], dirMtimes: {}, identity: { ino: 1, birthtimeMs: 1 } }));

    const before = readdirSync(d).sort().join(",");
    spawnSync("node", [CLI, "migrate-run-dir", root], { encoding: "utf8" });
    expect(readdirSync(d).sort().join(","), "a dry run modified the run dir").toBe(before);
    expect(existsSync(jp), "a dry run consumed the journal").toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});

describe.skipIf(!can)("--scenario scoping", () => {
  function twoScenarios(): string {
    const root = mkdtempSync(join(tmpdir(), "mig-scope-"));
    for (const s of ["alpha", "beta"]) {
      const d = join(root, s, "sess-1");
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "result.json"), JSON.stringify({ scenario: s, turn: 1 }));
      writeFileSync(join(d, "run.jsonl"), `{"t":"transcript"}`);
    }
    return root;
  }

  it("migrates ONLY the named scenario, leaving the others untouched", () => {
    // Without this the tool cannot perform the staged rollout its own docs recommend: you either migrate
    // one directory by hand or commit to all 1,630 at once.
    const root = twoScenarios();
    const r = spawnSync("node", [CLI, "migrate-run-dir", root, "--scenario", "alpha", "--write"], { encoding: "utf8" });
    expect(r.status, `failed: ${r.stderr}`).toBe(0);
    expect(existsSync(join(root, "alpha", "sess-1", "turns", "1", "result.json")), "the named scenario was not migrated").toBe(true);
    expect(existsSync(join(root, "beta", "sess-1", "result.json")), "an unnamed scenario was migrated").toBe(true);
    expect(existsSync(join(root, "beta", "sess-1", "turns")), "an unnamed scenario was migrated").toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("reports counts for the named scenario only", () => {
    const root = twoScenarios();
    const r = spawnSync("node", [CLI, "migrate-run-dir", root, "--scenario", "alpha"], { encoding: "utf8" });
    expect(`${r.stdout}${r.stderr}`, "counted dirs outside the named scenario").toMatch(/1 to migrate/);
    rmSync(root, { recursive: true, force: true });
  });

  it("exits 2 on an unknown scenario rather than silently doing nothing", () => {
    const root = twoScenarios();
    const r = spawnSync("node", [CLI, "migrate-run-dir", root, "--scenario", "nope"], { encoding: "utf8" });
    expect(r.status, "an unknown scenario looked like a successful no-op").toBe(2);
    expect(`${r.stdout}${r.stderr}`).toMatch(/nope/);
    rmSync(root, { recursive: true, force: true });
  });
});
