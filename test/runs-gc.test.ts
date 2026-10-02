import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readdirSync, utimesSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { finalizeRunStatus, writeRunningStatus, type RunStatusMeta } from "../src/run/run-status.js";
import { hillclimbRunLabel } from "../src/run/run-labels.js";
import type { RunRecord } from "../src/run/run.js";

const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

function makeRunDir(runsRoot: string, scenario: string, runId: string): string {
  const dir = join(runsRoot, scenario, runId);
  // turns/1/result.json — the single addressable shape; `isRealRun` (runs-gc.ts) now checks `hasTurnDirs`
  // instead of a root result.json, since no writer produces a root compat copy anymore.
  const turn1 = join(dir, "turns", "1");
  mkdirSync(turn1, { recursive: true });
  writeFileSync(join(turn1, "result.json"), JSON.stringify({ result: "success" }));
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

  // pinned sess-* dirs are persisted/resumable sessions on the shared root: never pruned, and they
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

  it("--pinned-older-than reclaims only stale pinned sessions (opt-in), keeping fresh ones", () => {
    const runsRoot = mkdtempSync(join(tmpdir(), "cwh-runs-"));
    const stale = makeRunDir(runsRoot, "s", "sess-old");
    makeRunDir(runsRoot, "s", "sess-fresh");
    // backdate the stale pinned session's mtime to 10 days ago
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000);
    utimesSync(stale, tenDaysAgo, tenDaysAgo);
    const r = spawnSync("node", [CLI, "prune", "--pinned-older-than", "7d", runsRoot], { encoding: "utf8" });
    expect(r.status).toBe(0);
    const remaining = readdirSync(join(runsRoot, "s")).sort();
    expect(remaining).toContain("sess-fresh"); // within the window → kept
    expect(remaining).not.toContain("sess-old"); // older than 7d → reclaimed
  });

  it("without --pinned-older-than, no pinned session is ever touched (even a very old one)", () => {
    const runsRoot = mkdtempSync(join(tmpdir(), "cwh-runs-"));
    const old = makeRunDir(runsRoot, "s", "sess-old");
    const longAgo = new Date(Date.now() - 400 * 86_400_000);
    utimesSync(old, longAgo, longAgo);
    const r = spawnSync("node", [CLI, "prune", runsRoot], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(readdirSync(join(runsRoot, "s"))).toContain("sess-old"); // retained unconditionally
  });

  it("--pinned-older-than rejects a malformed or zero window (exit 2)", () => {
    for (const bad of ["soon", "0d", "0h"]) {
      const r = spawnSync("node", [CLI, "prune", "--pinned-older-than", bad], { encoding: "utf8" });
      expect(r.status, bad).toBe(2);
      expect(r.stderr, bad).toMatch(/--pinned-older-than must be/);
    }
  });

  // a COMPLETED run (has result.json) outranks a newer EMPTY scaffold dir for a keep slot. The completed
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

  // a real-but-THREW run (no result.json, but a session started so events.jsonl exists) is a real run.
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

describe.skipIf(!can)("prune refuses to rank a scenario with a migration in flight", () => {
  // Between a crashed migration and its recovery, the renames have ALREADY dirtied the run dir's mtime
  // but the restore has not run — and prune ranks keep-slots by exactly that mtime. So a half-migrated
  // OLD run ranks as the newest and evicts a genuinely newer one. The failure mode is a DELETED RUN,
  // the most expensive outcome in this feature, and it is silent.
  function runsRootWithJournal(): { root: string; kept: string; crashed: string } {
    const root = mkdtempSync(join(tmpdir(), "prune-mig-"));
    const crashed = makeRunDir(root, "scn", "local_oldest");
    const kept = makeRunDir(root, "scn", "local_newer");
    makeRunDir(root, "scn", "local_newest");
    // The crashed dir looks newest because migration touched it; the genuinely newer run looks older.
    const now = Date.now();
    utimesSync(crashed, now / 1000, now / 1000);
    utimesSync(kept, (now - 60_000) / 1000, (now - 60_000) / 1000);
    // A live journal for the crashed dir, where the migrator puts it.
    const jd = join(root, ".migrating", "scn");
    mkdirSync(jd, { recursive: true });
    writeFileSync(join(jd, "local_oldest.json"), JSON.stringify({ outDir: crashed, ops: [], dirMtimes: {}, identity: {} }));
    return { root, kept, crashed };
  }

  it("skips the scenario and deletes nothing while a journal is live", () => {
    const { root, kept, crashed } = runsRootWithJournal();
    const r = spawnSync("node", [CLI, "prune", "--keep-last", "1", root], { encoding: "utf8" });
    expect(r.status, `prune failed: ${r.stderr}`).toBe(0);
    expect(existsSync(kept), "prune deleted a run while a migration was in flight").toBe(true);
    expect(existsSync(crashed), "prune deleted the half-migrated dir, orphaning its journal").toBe(true);
    expect(`${r.stdout}${r.stderr}`, "prune said nothing about skipping the scenario").toMatch(/migrat/i);
  });

  it("prunes normally once the journal is gone", () => {
    const { root, kept } = runsRootWithJournal();
    rmSync(join(root, ".migrating"), { recursive: true, force: true });
    const r = spawnSync("node", [CLI, "prune", "--keep-last", "1", root], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(existsSync(kept), "with no journal, --keep-last 1 should have pruned this").toBe(false);
  });
});

describe.skipIf(!can)("prune does not demote an unmigrated legacy run to junk", () => {
  it("keeps a pre-layout run ahead of an empty scaffold for a keep slot", () => {
    // `isRealRun` moved from "has result.json OR events.jsonl" to "hasTurnDirs OR events.jsonl". That
    // reasons about CURRENT writers — but prune's population is history, including exactly the pre-layout
    // dirs `migrate-run-dir` exists to preserve. A legacy dir without events.jsonl silently dropped into
    // the junk tier and was deleted ahead of an empty scaffold. Silent deletion of real history is the
    // failure this file's own journal guard calls the most expensive outcome in the feature.
    const root = mkdtempSync(join(tmpdir(), "prune-legacy-"));
    const legacy = join(root, "scn", "local_legacy");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "result.json"), JSON.stringify({ scenario: "scn", result: "success" }));
    writeFileSync(join(legacy, "run.jsonl"), `{"t":"transcript"}`);
    const scaffold = join(root, "scn", "local_scaffold");
    mkdirSync(scaffold, { recursive: true }); // never started: nothing to lose

    const r = spawnSync("node", [CLI, "prune", "--keep-last", "1", root], { encoding: "utf8" });
    expect(r.status, `prune failed: ${r.stderr}`).toBe(0);
    expect(existsSync(legacy), "prune deleted an unmigrated legacy run — the history the migrator exists to save").toBe(true);
    expect(existsSync(scaffold), "the empty scaffold should have been pruned first").toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});

// Hillclimb runs: `hillclimb regrade` and `hillclimb freeze-ref` read a flow's kept run dirs, and refuse once one
// is gone. The run dir name (`local_<13 base36>`, like every unpinned run) cannot tell them apart; the run label
// `hillclimb:<basename(flow)>:<variant>` in status.json (else the latest turn's result.json) is the only signal.
// Every dir below is written by the real writers, and its mtime is set LAST, so the ranking the test intends is
// the one prune sees.
const FLOW = ".claude/hillclimb/flow";
const doneMeta = (runLabel?: string): RunStatusMeta => ({
  pid: 1,
  scenario: "s",
  fidelity: "container",
  sessionId: "00000000-0000-0000-0000-000000000000",
  startedAt: Date.now() - 60_000,
  ...(runLabel !== undefined ? { runLabel } : {}),
});
const emptyRecord = { toolCounts: {}, subagents: [] } as unknown as RunRecord;
let idSeq = 0;
/** A run id shaped like the one `hillclimb run` makes per attempt: `local_` + 13 base36 chars. */
const runId = () => `local_${(Date.now() * 1000 + idSeq++).toString(36).padStart(13, "0").slice(-13)}`;

interface DirOpts {
  label?: string; // runLabel in status.json and turns/1/result.json
  status?: "done" | "running" | "none" | "corrupt";
  resultLabel?: string | null; // override the result.json label; null = no label there
  turns?: boolean; // default true
  mtimeSec: number;
  name?: string;
}
function runDir(root: string, scenario: string, o: DirOpts): string {
  const dir = join(root, scenario, o.name ?? runId());
  mkdirSync(dir, { recursive: true });
  const status = o.status ?? "done";
  const meta = doneMeta(o.label);
  if (status === "done") {
    writeRunningStatus(dir, meta);
    finalizeRunStatus(dir, meta, emptyRecord, "success", 1000);
  } else if (status === "running") {
    writeRunningStatus(dir, meta);
  } else if (status === "corrupt") {
    writeFileSync(join(dir, "status.json"), '{"state":"runn');
  }
  if (o.turns !== false) {
    const t1 = join(dir, "turns", "1");
    mkdirSync(t1, { recursive: true });
    const rl = o.resultLabel === undefined ? o.label : (o.resultLabel ?? undefined);
    writeFileSync(join(t1, "result.json"), JSON.stringify({ result: "success", ...(rl !== undefined ? { runLabel: rl } : {}) }));
  }
  utimesSync(dir, o.mtimeSec, o.mtimeSec); // LAST write: status.json and turns/ above re-stamp the dir
  return dir;
}
const T0 = Math.floor(Date.now() / 1000) - 3600;
const prune = (args: string[], env: NodeJS.ProcessEnv = {}) =>
  spawnSync("node", [CLI, "prune", ...args], { encoding: "utf8", env: { ...process.env, ...env } });
const names = (root: string, scenario: string) => readdirSync(join(root, scenario)).sort();
const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);

describe.skipIf(!can)("prune and hillclimb runs", () => {
  const baseline = hillclimbRunLabel(FLOW, "baseline");
  const v1 = hillclimbRunLabel(FLOW, "v1");

  it("keeps every hillclimb-labelled run past --keep-last, and says how many per scenario and label", () => {
    const root = mkdtempSync(join(tmpdir(), "prune-hc-"));
    for (let i = 0; i < 8; i++) runDir(root, "s", { label: baseline, mtimeSec: T0 + i });
    const r = prune(["--keep-last", "1", root]);
    expect(r.status, r.stderr).toBe(0);
    expect(names(root, "s")).toHaveLength(8);
    expect(r.stderr).toMatch(/kept 8 hillclimb run dir\(s\)/);
    expect(r.stderr).toMatch(/s\s+hillclimb:flow:baseline\s+8/);
    expect(r.stderr).toMatch(/--include-hillclimb/);
    expect(r.stderr).toMatch(/nothing to prune \(0 run dir\(s\) within --keep-last 1; protected 8 hillclimb\)/);
  });

  it("hillclimb runs take no --keep-last slot when they are newer than the plain runs", () => {
    const root = mkdtempSync(join(tmpdir(), "prune-hc-"));
    const plain = [0, 1, 2].map((i) => runDir(root, "s", { mtimeSec: T0 + i }));
    const hc = [0, 1, 2, 3, 4, 5].map((i) => runDir(root, "s", { label: i % 2 ? v1 : baseline, mtimeSec: T0 + 100 + i }));
    const r = prune(["--keep-last", "2", root]);
    expect(r.status, r.stderr).toBe(0);
    for (const d of hc) expect(existsSync(d), `hillclimb run ${base(d)} was pruned`).toBe(true);
    expect(existsSync(plain[2]) && existsSync(plain[1]), "a hillclimb run took a --keep-last slot").toBe(true);
    expect(existsSync(plain[0])).toBe(false);
    expect(names(root, "s")).toHaveLength(8);
    expect(r.stderr).toMatch(/pruned 1 run dir\(s\), kept 2, protected 6 hillclimb/);
  });

  it("hillclimb runs are kept when they are OLDER than the plain runs too (not merely by rank)", () => {
    const root = mkdtempSync(join(tmpdir(), "prune-hc-"));
    const hc = [0, 1, 2, 3, 4, 5].map((i) => runDir(root, "s", { label: baseline, mtimeSec: T0 + i }));
    const plain = [0, 1, 2].map((i) => runDir(root, "s", { mtimeSec: T0 + 100 + i }));
    const r = prune(["--keep-last", "2", root]);
    expect(r.status, r.stderr).toBe(0);
    for (const d of hc) expect(existsSync(d), `hillclimb run ${base(d)} was pruned`).toBe(true);
    expect(existsSync(plain[0])).toBe(false);
    expect(existsSync(plain[1]) && existsSync(plain[2])).toBe(true);
  });

  it("--dry-run lists each protected run, the per-label count and the final protected count, and deletes nothing", () => {
    const root = mkdtempSync(join(tmpdir(), "prune-hc-"));
    [0, 1, 2].forEach((i) => runDir(root, "s", { mtimeSec: T0 + i }));
    const hc = [0, 1, 2, 3, 4, 5].map((i) => runDir(root, "s", { label: baseline, mtimeSec: T0 + 100 + i }));
    const r = prune(["--keep-last", "2", "--dry-run", root]);
    expect(r.status, r.stderr).toBe(0);
    expect(names(root, "s")).toHaveLength(9);
    for (const d of hc) expect(r.stderr).toContain(`(dry-run) ⛨ kept hillclimb ${d}`);
    expect(r.stderr).toMatch(/s\s+hillclimb:flow:baseline\s+6/);
    expect(r.stderr).toMatch(/pruned 1 run dir\(s\), kept 2, protected 6 hillclimb \(dry-run — nothing deleted\)/);
  });

  it("a real prune does not list each protected dir (only --dry-run does)", () => {
    const root = mkdtempSync(join(tmpdir(), "prune-hc-"));
    runDir(root, "s", { label: baseline, mtimeSec: T0 });
    const r = prune(["--keep-last", "1", root]);
    expect(r.stderr).not.toMatch(/⛨ kept hillclimb/);
  });

  it("groups the protected count by scenario and label", () => {
    const root = mkdtempSync(join(tmpdir(), "prune-hc-"));
    [0, 1].forEach((i) => runDir(root, "alpha", { label: baseline, mtimeSec: T0 + i }));
    [0, 1, 2].forEach((i) => runDir(root, "alpha", { label: v1, mtimeSec: T0 + 10 + i }));
    [0, 1, 2, 3].forEach((i) => runDir(root, "beta", { label: v1, mtimeSec: T0 + 20 + i }));
    const r = prune(["--keep-last", "1", root]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/kept 9 hillclimb run dir\(s\)/);
    expect(r.stderr).toMatch(/alpha\s+hillclimb:flow:baseline\s+2/);
    expect(r.stderr).toMatch(/alpha\s+hillclimb:flow:v1\s+3/);
    expect(r.stderr).toMatch(/beta\s+hillclimb:flow:v1\s+4/);
  });

  it("--include-hillclimb puts them back into the ranking: the newest N overall survive, not zero", () => {
    const root = mkdtempSync(join(tmpdir(), "prune-hc-"));
    [0, 1].forEach((i) => runDir(root, "s", { mtimeSec: T0 + i }));
    const hc = [0, 1, 2, 3].map((i) => runDir(root, "s", { label: baseline, mtimeSec: T0 + 100 + i }));
    const r = prune(["--include-hillclimb", "--keep-last", "1", root]);
    expect(r.status, r.stderr).toBe(0);
    expect(names(root, "s")).toEqual([base(hc[3])]);
    expect(r.stderr).toMatch(/3 hillclimb run dir\(s\) pruned under --include-hillclimb/);
    expect(r.stderr).toMatch(/every flow/i);
    expect(r.stderr).not.toMatch(/protected \d+ hillclimb/);
  });

  it("finds the label in the latest turn's result.json when status.json is missing or damaged", () => {
    const root = mkdtempSync(join(tmpdir(), "prune-hc-"));
    const noStatus = runDir(root, "s", { label: v1, status: "none", mtimeSec: T0 });
    const corrupt = runDir(root, "s", { label: v1, status: "corrupt", mtimeSec: T0 + 1 });
    runDir(root, "s", { mtimeSec: T0 + 100 });
    const r = prune(["--keep-last", "1", root]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(noStatus), "a hillclimb run with no status.json was pruned").toBe(true);
    expect(existsSync(corrupt), "a hillclimb run with a damaged status.json was pruned").toBe(true);
    expect(r.stderr).toMatch(/s\s+hillclimb:flow:v1\s+2/);
  });

  it("a run with no readable label is an ordinary run, pruned past the cap", () => {
    const root = mkdtempSync(join(tmpdir(), "prune-hc-"));
    const noLabel = runDir(root, "s", { status: "none", mtimeSec: T0 }); // result.json without a label
    const corruptNoTurns = runDir(root, "s", { status: "corrupt", turns: false, mtimeSec: T0 + 1 });
    const keep = runDir(root, "s", { mtimeSec: T0 + 100 });
    const r = prune(["--keep-last", "1", root]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(noLabel)).toBe(false);
    expect(existsSync(corruptNoTurns)).toBe(false);
    expect(existsSync(keep)).toBe(true);
    expect(r.stderr).not.toMatch(/hillclimb/);
  });

  it("only a label that STARTS with hillclimb: is protected; user and eval labels are pruned normally", () => {
    const root = mkdtempSync(join(tmpdir(), "prune-hc-"));
    const user = runDir(root, "s", { label: "my-gen-3", mtimeSec: T0 });
    const lookalike = runDir(root, "s", { label: "my-hillclimb-try", mtimeSec: T0 + 1 });
    const ev = runDir(root, "s", { label: "eval:20261002-000000-abc123:before", mtimeSec: T0 + 2 });
    const handLabelled = runDir(root, "s", { label: "hillclimb:mine", mtimeSec: T0 + 3 }); // a user --label hillclimb:…
    runDir(root, "s", { mtimeSec: T0 + 100 });
    const r = prune(["--keep-last", "1", root]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(user)).toBe(false);
    expect(existsSync(lookalike), "a label containing 'hillclimb' mid-string was protected").toBe(false);
    expect(existsSync(ev)).toBe(false);
    expect(existsSync(handLabelled)).toBe(true);
    expect(r.stderr).toMatch(/1 of the pruned run dir\(s\) belong to eval 20261002-000000-abc123/);
  });

  it("a pinned sess-* dir stays kept and still takes no slot next to hillclimb runs", () => {
    const root = mkdtempSync(join(tmpdir(), "prune-hc-"));
    const pinned = runDir(root, "s", { name: "sess-ci", mtimeSec: T0 + 500 });
    const hc = runDir(root, "s", { label: baseline, mtimeSec: T0 + 400 });
    const plainNew = runDir(root, "s", { mtimeSec: T0 + 2 });
    const plainOld = runDir(root, "s", { mtimeSec: T0 + 1 });
    const r = prune(["--keep-last", "1", root]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(pinned) && existsSync(hc) && existsSync(plainNew)).toBe(true);
    expect(existsSync(plainOld)).toBe(false);
  });

  it("with no hillclimb runs the final line carries no hillclimb clause", () => {
    const root = mkdtempSync(join(tmpdir(), "prune-hc-"));
    [0, 1, 2].forEach((i) => runDir(root, "s", { mtimeSec: T0 + i }));
    const pruned = prune(["--keep-last", "1", root]);
    expect(pruned.stderr).toMatch(/✓ prune: pruned 2 run dir\(s\), kept 1\n/);
    const none = prune(["--keep-last", "5", root]);
    expect(none.stderr).toMatch(/✓ prune: nothing to prune \(1 run dir\(s\) within --keep-last 5\)\n/);
    expect(`${pruned.stderr}${none.stderr}`).not.toMatch(/hillclimb|running/);
  });
});

describe.skipIf(!can)("prune never deletes a run that is still running", () => {
  it("skips a live running run past the cap and reports it", () => {
    const root = mkdtempSync(join(tmpdir(), "prune-live-"));
    const live = runDir(root, "s", { status: "running", mtimeSec: T0 });
    const keep = runDir(root, "s", { mtimeSec: T0 + 100 });
    const r = prune(["--keep-last", "1", root]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(live), "prune deleted a run whose status.json says it is still running").toBe(true);
    expect(existsSync(keep)).toBe(true);
    expect(r.stderr).toContain(`↷ skipped ${live}: still running`);
    expect(r.stderr).toMatch(/skipped 1 running/);
  });

  it("the guard holds under --include-hillclimb and for a stale pinned session", () => {
    const root = mkdtempSync(join(tmpdir(), "prune-live-"));
    const liveHc = runDir(root, "s", { label: hillclimbRunLabel(FLOW, "v1"), status: "running", mtimeSec: T0 });
    const livePinned = runDir(root, "s", { name: "sess-live", status: "running", mtimeSec: T0 - 30 * 86_400 });
    runDir(root, "s", { mtimeSec: T0 + 100 });
    const r = prune(["--include-hillclimb", "--pinned-older-than", "7d", "--keep-last", "1", root]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(liveHc)).toBe(true);
    expect(existsSync(livePinned)).toBe(true);
    expect(r.stderr).toMatch(/skipped 2 running/);
  });

  it("a STALE running status (the writer is gone) does not shield the run", () => {
    const root = mkdtempSync(join(tmpdir(), "prune-live-"));
    const dead = runDir(root, "s", { status: "running", mtimeSec: T0 });
    runDir(root, "s", { mtimeSec: T0 + 100 });
    const r = prune(["--keep-last", "1", root], { COWORK_HARNESS_STATUS_STALE_MS: "1" });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(dead), "a crashed run frozen at 'running' was kept forever").toBe(false);
    expect(r.stderr).not.toMatch(/still running/);
  });
});
