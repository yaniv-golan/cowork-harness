import { describe, it, expect, vi } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  readFileSync,
  utimesSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { finalizeRunStatus, writeRunningStatus, type RunStatusMeta } from "../src/run/run-status.js";
import { hillclimbRunLabel } from "../src/run/run-labels.js";
import type { RunRecord } from "../src/run/run.js";
import { appendIndexRow, CRITIQUE_SESSION_PREFIX, type RunIndexRow } from "../src/run/run-index.js";
import { jobRunId } from "../src/eval/schedule.js";
import * as gc from "../src/run/runs-gc.js";

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
    makeRunDir(runsRoot, "my-scenario", "local_a");
    makeRunDir(runsRoot, "my-scenario", "local_b");
    makeRunDir(runsRoot, "my-scenario", "local_c");
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
    // so "local_c" is "newest" and will be kept.
    makeRunDir(runsRoot, "s", "local_a");
    makeRunDir(runsRoot, "s", "local_b");
    makeRunDir(runsRoot, "s", "local_c");
    const r = spawnSync("node", [CLI, "prune", "--keep-last", "1", runsRoot], { encoding: "utf8" });
    expect(r.status).toBe(0);
    const remaining = readdirSync(join(runsRoot, "s"));
    expect(remaining.length).toBe(1);
  });

  it("prune --keep-last N ≥ count leaves all dirs intact", () => {
    const runsRoot = mkdtempSync(join(tmpdir(), "cwh-runs-"));
    makeRunDir(runsRoot, "s", "local_a");
    makeRunDir(runsRoot, "s", "local_b");
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
/** A pid that has exited, so the running guard's live-process branch never applies unless a test asks for it. */
const DEAD_PID = spawnSync(process.execPath, ["-e", ""]).pid as number;
const doneMeta = (runLabel?: string, pid = DEAD_PID): RunStatusMeta => ({
  pid,
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
  pid?: number; // recorded in status.json (default: an exited pid)
  writtenAt?: number; // epoch ms the status writer sees as "now" (default: real now)
  mtimeSec: number;
  name?: string;
}
function runDir(root: string, scenario: string, o: DirOpts): string {
  const dir = join(root, scenario, o.name ?? runId());
  mkdirSync(dir, { recursive: true });
  const status = o.status ?? "done";
  const meta = doneMeta(o.label, o.pid);
  if (o.writtenAt !== undefined) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(o.writtenAt);
  }
  if (status === "done") {
    writeRunningStatus(dir, meta);
    finalizeRunStatus(dir, meta, emptyRecord, "success", 1000);
  } else if (status === "running") {
    writeRunningStatus(dir, meta);
  } else if (status === "corrupt") {
    writeFileSync(join(dir, "status.json"), '{"state":"runn');
  }
  if (o.writtenAt !== undefined) vi.useRealTimers();
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

  it("a status.json that parses without a label is an unlabelled run: result.json is not consulted", () => {
    const root = mkdtempSync(join(tmpdir(), "prune-hc-"));
    const unlabelled = runDir(root, "s", { resultLabel: v1, mtimeSec: T0 }); // status.json has no runLabel
    runDir(root, "s", { mtimeSec: T0 + 100 });
    const r = prune(["--keep-last", "1", root]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(unlabelled)).toBe(false);
  });

  it("a symlinked run dir is not read through: an ordinary run, and pruning it removes only the link", () => {
    const root = mkdtempSync(join(tmpdir(), "prune-hc-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "prune-hc-target-"));
    const target = runDir(elsewhere, "x", { label: baseline, mtimeSec: T0 });
    mkdirSync(join(root, "s"), { recursive: true });
    const link = join(root, "s", runId());
    symlinkSync(target, link);
    runDir(root, "s", { mtimeSec: T0 + 100 });
    const r = prune(["--keep-last", "1", root]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(link), "a symlinked dir was protected through its link").toBe(false);
    expect(existsSync(join(target, "status.json")), "pruning a symlinked run dir deleted its target").toBe(true);
    expect(r.stderr).not.toMatch(/protected \d+ hillclimb/);
  });

  it("a hillclimb-labelled sess-* dir follows the pinned rule, and --pinned-older-than reclaiming it does not name --include-hillclimb", () => {
    const root = mkdtempSync(join(tmpdir(), "prune-hc-"));
    const oldPinned = runDir(root, "s", { name: "sess-hc", label: baseline, mtimeSec: T0 - 30 * 86_400 });
    const r = prune(["--pinned-older-than", "7d", root]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(oldPinned)).toBe(false);
    expect(r.stderr).not.toMatch(/--include-hillclimb/);
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
    expect(existsSync(dead), "a crashed run frozen at 'running' (its process gone) was kept").toBe(false);
    expect(r.stderr).not.toMatch(/still running/);
  });

  // The status ticker runs only while the agent session is driven; staging before it and judging/finalizing after
  // it leave status.json at "running" with a frozen updatedAt. The recorded pid tells a live run from a crash.
  it("a stale running status whose recorded process is alive keeps the run", () => {
    const root = mkdtempSync(join(tmpdir(), "prune-live-"));
    const judging = runDir(root, "s", { label: hillclimbRunLabel(FLOW, "v1"), status: "running", pid: process.pid, mtimeSec: T0 });
    runDir(root, "s", { mtimeSec: T0 + 100 });
    const r = prune(["--include-hillclimb", "--keep-last", "1", root], { COWORK_HARNESS_STATUS_STALE_MS: "1" });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(judging), "prune deleted a live run between status ticks").toBe(true);
    expect(r.stderr).toContain(`↷ skipped ${judging}: still running (its process ${process.pid} is alive)`);
  });

  it("a live pid does not keep a running status last updated more than 24h ago", () => {
    const root = mkdtempSync(join(tmpdir(), "prune-live-"));
    const old = runDir(root, "s", { status: "running", pid: process.pid, writtenAt: Date.now() - 25 * 3_600_000, mtimeSec: T0 });
    runDir(root, "s", { mtimeSec: T0 + 100 });
    const r = prune(["--keep-last", "1", root]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(old), "a pid alive for over 24h kept a run frozen at 'running'").toBe(false);
  });

  it("an updatedAt more than a minute in the future does not count as live", () => {
    const root = mkdtempSync(join(tmpdir(), "prune-live-"));
    const future = runDir(root, "s", { status: "running", writtenAt: Date.now() + 10 * 60_000, mtimeSec: T0 });
    runDir(root, "s", { mtimeSec: T0 + 100 });
    const r = prune(["--keep-last", "1", root]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(future), "a future updatedAt shielded the run forever").toBe(false);
  });

  it.skipIf(process.platform === "win32")("a FIFO status.json does not hang prune", () => {
    const root = mkdtempSync(join(tmpdir(), "prune-live-"));
    const fifoDir = runDir(root, "s", { status: "none", mtimeSec: T0 });
    const mk = spawnSync("mkfifo", [join(fifoDir, "status.json")]);
    if (mk.status !== 0) return; // no mkfifo on this platform
    utimesSync(fifoDir, T0, T0);
    runDir(root, "s", { mtimeSec: T0 + 100 });
    const r = spawnSync("node", [CLI, "prune", "--include-hillclimb", "--keep-last", "1", root], { encoding: "utf8", timeout: 20_000 });
    expect(r.error, "prune hung reading a FIFO status.json").toBeUndefined();
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(fifoDir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------
// The level prune runs at. prune takes the RUNS ROOT (`<root>/<scenario>/<run>`). Handed a scenario dir, a run
// dir or the parent of a runs root, it used to treat the next level down as scenarios and delete their
// children past --keep-last. Two guards now: a shape check refuses the wrong level (exit 2, nothing deleted,
// --dry-run included), and only children named like a run id are ever ranked or deleted.

/** Every path under `root`, sorted, with a content hash for files. mtimes are not compared. */
function snapshotTree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out.push(`${r}/`);
        walk(p, r);
      } else {
        const buf = readFileSync(p);
        out.push(`${r} ${buf.length} ${createHash("sha256").update(buf).digest("hex").slice(0, 16)}`);
      }
    }
  };
  walk(root, "");
  return out;
}
/** A row written by the real index writer, so a fixture's `index.jsonl` is what a finished run leaves. */
function indexRow(root: string): void {
  appendIndexRow(root, {
    v: 1,
    ts: new Date().toISOString(),
    command: "run",
    scenario: "s",
    slug: "s",
    runId: "local_0000000000001",
    fidelity: "container",
    baseline: "desktop-0.0.0",
    result: "success",
    pass: true,
  } as RunIndexRow);
}
/** A runs root as a finished run leaves it: index.jsonl plus `<scenario>/<n runs>`. */
function realRoot(root: string, scenario = "s", n = 3): string {
  mkdirSync(root, { recursive: true });
  indexRow(root);
  for (let i = 0; i < n; i++) runDir(root, scenario, { mtimeSec: T0 + i });
  return root;
}
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const runCount = (dir: string) => readdirSync(dir).filter((n) => n.startsWith("local_")).length;

/** Run `args` against a fresh fixture, with and without --dry-run: exit 2, the message, and an unchanged tree.
 *  The real run goes LAST and its stderr is returned, so a caller's fixture variable names the same build. */
function expectRefused(build: () => { top: string; args: string[] }, message: RegExp, env: NodeJS.ProcessEnv = {}): string {
  let stderr = "";
  for (const dry of [true, false]) {
    const { top, args } = build();
    const before = snapshotTree(top);
    const r = prune(dry ? ["--dry-run", ...args] : args, env);
    const tag = dry ? "--dry-run" : "real";
    expect(r.status, `${tag}: ${r.stderr}`).toBe(2);
    expect(r.stderr, tag).toMatch(message);
    expect(r.stderr, tag).toMatch(/Nothing was deleted/);
    expect(r.stderr, tag).not.toMatch(/✗ pruned|\n\s+at /);
    expect(snapshotTree(top), `${tag}: the tree changed`).toEqual(before);
    if (!dry) stderr = r.stderr;
  }
  return stderr;
}

describe.skipIf(!can)("prune refuses a root at the wrong level", () => {
  it("R1: the parent of a runs root (P/runs) is refused; P/runs itself prunes", () => {
    let P = "";
    const err = expectRefused(() => {
      P = tmp("prune-lvl-");
      realRoot(join(P, "runs"), "s", 8);
      return { top: P, args: ["--keep-last", "1", P] };
    }, /looks like the parent of a runs root/);
    expect(err).toContain(join(P, "runs"));
    const ok = prune(["--keep-last", "1", join(P, "runs")]);
    expect(ok.status, ok.stderr).toBe(0);
    expect(runCount(join(P, "runs", "s"))).toBe(1);
  });

  it("R1b: refuses before touching an earlier-sorted child (no lazy per-scenario check)", () => {
    expectRefused(() => {
      const P = tmp("prune-lvl-");
      for (let i = 0; i < 7; i++) mkdirSync(join(P, "aaa-notes", `local_${i}aaaaaaaaaaaa`), { recursive: true });
      realRoot(join(P, "runs"), "s", 8);
      return { top: P, args: ["--keep-last", "1", P] };
    }, /looks like the parent of a runs root/);
  });

  it("R1c: a child with index.jsonl and only scaffold-dir scenarios is a runs root", () => {
    expectRefused(() => {
      const P = tmp("prune-lvl-");
      const C = join(P, "myroot");
      indexRow(C);
      for (const s of ["a", "b"]) for (let i = 0; i < 3; i++) mkdirSync(join(C, s, `local_${s}${i}aaaaaaaaaaaa`), { recursive: true });
      return { top: P, args: ["--keep-last", "1", P] };
    }, /looks like the parent of a runs root: .*myroot \(index\.jsonl\)/);
  });

  it("R1d: an empty child named runs (the default runs-dir name) is refused", () => {
    expectRefused(() => {
      const P = tmp("prune-lvl-");
      mkdirSync(join(P, "runs"));
      return { top: P, args: [P] };
    }, /looks like the parent of a runs root: .*runs \(the default runs-dir name\)/);
  });

  it("R1e: a runs root holding a nested runs root is refused with the nested message; the nested root prunes by its own path", () => {
    let R = "";
    const err = expectRefused(() => {
      R = realRoot(tmp("prune-lvl-"), "s", 3);
      realRoot(join(R, "nested"), "t", 3);
      return { top: R, args: ["--keep-last", "1", R] };
    }, /holds a nested runs root, so prune cannot run on it: /);
    expect(err).toContain(join(R, "nested"));
    expect(err).not.toMatch(/parent of/);
    const ok = prune(["--keep-last", "1", join(R, "nested")]);
    expect(ok.status, ok.stderr).toBe(0);
    expect(runCount(join(R, "nested", "t"))).toBe(1);
  });

  it("R1f: lists every runs root it found, not just the first", () => {
    let P = "";
    const err = expectRefused(() => {
      P = tmp("prune-lvl-");
      realRoot(join(P, "runs"));
      realRoot(join(P, "runs-old"));
      return { top: P, args: [P] };
    }, /looks like the parent of runs roots: /);
    expect(err).toContain(join(P, "runs"));
    expect(err).toContain(join(P, "runs-old"));
  });

  it("R2: a scenario dir is refused; the hint names the runs root, says prune has no per-scenario scope, and previews first", () => {
    let R = "";
    const err = expectRefused(() => {
      R = realRoot(tmp("prune-lvl-"), "s", 8);
      return { top: R, args: ["--keep-last", "1", join(R, "s")] };
    }, /looks like a scenario dir, not a runs root: .*local_\w+ is a run dir \(status\.json, turns\/\)/);
    expect(err).toMatch(/no per-scenario scope/);
    expect(err).toContain(`prune --dry-run ${R}`);
    expect(err).not.toMatch(/parent of/);
    const ok = prune(["--keep-last", "1", R]);
    expect(ok.status, ok.stderr).toBe(0);
    expect(runCount(join(R, "s"))).toBe(1);
  });

  it("R2b: ONE run-shaped child (status.json only) among empty scaffold dirs is enough", () => {
    expectRefused(() => {
      const R = tmp("prune-lvl-");
      runDir(R, "s", { turns: false, mtimeSec: T0 });
      for (let i = 0; i < 6; i++) mkdirSync(join(R, "s", `local_${i}zzzzzzzzzzzz`));
      return { top: R, args: ["--keep-last", "1", join(R, "s")] };
    }, /looks like a scenario dir/);
  });

  it("R2c: the check comes before --pinned-older-than and --include-hillclimb", () => {
    expectRefused(() => {
      const R = tmp("prune-lvl-");
      runDir(R, "s", { name: "sess-old", mtimeSec: T0 - 30 * 86_400 });
      runDir(R, "s", { status: "running", pid: process.pid, mtimeSec: T0 });
      return { top: R, args: ["--pinned-older-than", "7d", "--include-hillclimb", join(R, "s")] };
    }, /looks like a scenario dir/);
  });

  it("R2d: a root given by --run-dir is checked too", () => {
    expectRefused(() => {
      const R = realRoot(tmp("prune-lvl-"), "s", 8);
      return { top: R, args: ["--keep-last", "1", "--run-dir", join(R, "s")] };
    }, /looks like a scenario dir/);
  });

  it("R3: a run dir is refused; the hint names the runs root two levels up", () => {
    let R = "";
    const err = expectRefused(() => {
      R = tmp("prune-lvl-");
      const d = runDir(R, "s", { mtimeSec: T0 });
      writeFileSync(join(d, "events.jsonl"), '{"type":"init"}\n');
      for (let i = 1; i < 4; i++) runDir(R, "s", { mtimeSec: T0 + i });
      return { top: R, args: ["--keep-last", "1", d] };
    }, /looks like a run dir, not a runs root \(it has status\.json, events\.jsonl, turns\/\)/);
    expect(err).toMatch(/no per-scenario scope/);
    expect(err).toContain(`prune --dry-run ${R}`);
    const ok = prune(["--keep-last", "1", R]);
    expect(ok.status, ok.stderr).toBe(0);
    expect(runCount(join(R, "s"))).toBe(1);
  });

  it("R3b: one marker is enough: events.jsonl, turns/<N>, a pre-layout file, or .origin", () => {
    const shapes: Array<[string, (d: string) => void]> = [
      ["events.jsonl", (d) => writeFileSync(join(d, "events.jsonl"), "{}\n")],
      ["turns/", (d) => mkdirSync(join(d, "turns", "1"), { recursive: true })],
      ["result.json", (d) => (writeFileSync(join(d, "result.json"), "{}"), writeFileSync(join(d, "run.jsonl"), "{}\n"))],
      [".origin", (d) => writeFileSync(join(d, ".origin"), "{}")],
    ];
    for (const [marker, make] of shapes) {
      expectRefused(
        () => {
          const R = tmp("prune-lvl-");
          const d = join(R, "s", "local_0000000000001");
          mkdirSync(join(d, "work", "outputs", "a"), { recursive: true });
          make(d);
          return { top: R, args: [d] };
        },
        new RegExp(`looks like a run dir.*\\(it has [^)]*${marker.replace(/[.]/g, "\\.")}`),
      );
    }
  });

  it("R3c: a dir inside a run dir is refused", () => {
    expectRefused(() => {
      const R = tmp("prune-lvl-");
      const d = runDir(R, "s", { mtimeSec: T0 });
      for (let i = 0; i < 8; i++) mkdirSync(join(d, "work", "outputs", `local_${i}aaaaaaaaaaaa`), { recursive: true });
      return { top: R, args: ["--keep-last", "1", join(d, "work")] };
    }, /is inside the run dir .*local_/);
  });

  it("E1: an eval dir (manifest.json) and a dir of eval dirs are refused", () => {
    expectRefused(() => {
      const E = tmp("prune-lvl-");
      writeFileSync(join(E, "manifest.json"), "{}");
      writeFileSync(join(E, "runs.jsonl"), "");
      mkdirSync(join(E, "a", "local_0000000000001"), { recursive: true });
      mkdirSync(join(E, "a", "local_0000000000002"), { recursive: true });
      return { top: E, args: ["--keep-last", "1", E] };
    }, /looks like an eval dir/);
    expectRefused(() => {
      const Es = tmp("prune-lvl-");
      mkdirSync(join(Es, "20260930-000000-abc123", "x", "local_0000000000001"), { recursive: true });
      mkdirSync(join(Es, "20260930-000000-abc123", "x", "local_0000000000002"), { recursive: true });
      writeFileSync(join(Es, "20260930-000000-abc123", "manifest.json"), "{}");
      return { top: Es, args: ["--keep-last", "1", Es] };
    }, /looks like a dir of eval dirs/);
  });

  it("N0: a root that is a file exits 2 with no stack trace", () => {
    expectRefused(() => {
      const P = tmp("prune-lvl-");
      writeFileSync(join(P, "f"), "x");
      return { top: P, args: [join(P, "f")] };
    }, /is not a directory/);
  });
});

describe.skipIf(!can)("prune still prunes a real runs root", () => {
  it("F1/F2: an empty root and an index-only root", () => {
    const empty = tmp("prune-ok-");
    const r1 = prune([empty]);
    expect(r1.status, r1.stderr).toBe(0);
    expect(r1.stderr).toMatch(/nothing to prune/);
    const idx = tmp("prune-ok-");
    indexRow(idx);
    writeFileSync(join(idx, "capability-cache.json"), "{}");
    const r2 = prune([idx]);
    expect(r2.status, r2.stderr).toBe(0);
  });

  it("F3: a single scenario", () => {
    const R = realRoot(tmp("prune-ok-"), "s", 3);
    const r = prune(["--keep-last", "1", R]);
    expect(r.status, r.stderr).toBe(0);
    expect(runCount(join(R, "s"))).toBe(1);
  });

  it("F4: a scenario named runs, with runs or only scaffold dirs", () => {
    const R = realRoot(tmp("prune-ok-"), "runs", 3);
    const r = prune(["--keep-last", "1", R]);
    expect(r.status, r.stderr).toBe(0);
    expect(runCount(join(R, "runs"))).toBe(1);
    const S = tmp("prune-ok-");
    for (let i = 0; i < 3; i++) mkdirSync(join(S, "runs", `local_${i}aaaaaaaaaaaa`), { recursive: true });
    writeFileSync(join(S, "runs", ".DS_Store"), "");
    const r2 = prune(["--keep-last", "1", S]);
    expect(r2.status, r2.stderr).toBe(0);
    expect(runCount(join(S, "runs"))).toBe(1);
  });

  it("F5: scenarios named turns, events.jsonl, status.json, result.json", () => {
    const R = tmp("prune-ok-");
    indexRow(R);
    const scen = ["turns", "events.jsonl", "status.json", "result.json"];
    for (const s of scen) for (let i = 0; i < 3; i++) runDir(R, s, { mtimeSec: T0 + i });
    const r = prune(["--keep-last", "1", R]);
    expect(r.status, r.stderr).toBe(0);
    for (const s of scen) expect(runCount(join(R, s)), s).toBe(1);
  });

  it("F6: unrelated user dirs are left alone and counted", () => {
    const R = realRoot(tmp("prune-ok-"), "s", 3);
    mkdirSync(join(R, "notes", "a", "b"), { recursive: true });
    mkdirSync(join(R, "notes", "c"), { recursive: true });
    mkdirSync(join(R, "tmp"));
    const r = prune(["--keep-last", "1", R]);
    expect(r.status, r.stderr).toBe(0);
    expect(runCount(join(R, "s"))).toBe(1);
    expect(existsSync(join(R, "notes", "a", "b")) && existsSync(join(R, "notes", "c")) && existsSync(join(R, "tmp"))).toBe(true);
    expect(r.stderr).toMatch(/left alone 2 dir\(s\) not named like a run/);
  });

  it("F7: chat/, quarantine/, .migrating/ and capability-cache.json", () => {
    const R = tmp("prune-ok-");
    indexRow(R);
    for (let i = 0; i < 3; i++) runDir(R, "chat", { mtimeSec: T0 + i });
    mkdirSync(join(R, "quarantine"));
    writeFileSync(join(R, "quarantine", "x.cassette.json"), "{}");
    mkdirSync(join(R, ".migrating"));
    writeFileSync(join(R, "capability-cache.json"), "{}");
    const r = prune(["--keep-last", "1", R]);
    expect(r.status, r.stderr).toBe(0);
    expect(runCount(join(R, "chat"))).toBe(1);
    expect(existsSync(join(R, "quarantine", "x.cassette.json"))).toBe(true);
  });

  // The shape check has no reliable marker for a home dir or a repo. The name allowlist is what protects them:
  // nothing in them is named like a run id, so nothing is ranked or deleted, and the count says so.
  it("F8: a home-like dir is left untouched, with the count printed", () => {
    const H = tmp("prune-home-");
    for (const d of [
      "Documents/a",
      "Documents/b",
      "Library/Caches",
      "Library/Preferences",
      "code/yaniv/repo",
      "Desktop",
      "Music",
      "Pictures/x",
    ])
      mkdirSync(join(H, d), { recursive: true });
    writeFileSync(join(H, "Documents", "a", "notes.txt"), "keep me");
    realRoot(join(H, ".cowork-harness", "runs"), "s", 8);
    const before = snapshotTree(H);
    const r = prune(["--keep-last", "1", H]);
    expect(r.status, r.stderr).toBe(0);
    expect(snapshotTree(H)).toEqual(before);
    expect(r.stderr).toMatch(/left alone \d+ dir\(s\) not named like a run/);
  });

  it("F9: a repo-like dir is left untouched, with the count printed", () => {
    const G = tmp("prune-repo-");
    for (const d of [
      "src/run",
      "src/eval",
      "test/fixtures",
      "docs/img",
      "node_modules/a",
      "node_modules/b",
      "dist/x",
      "scripts/ci",
      ".git/objects",
      ".git/refs",
    ])
      mkdirSync(join(G, d), { recursive: true });
    writeFileSync(join(G, "package.json"), "{}");
    writeFileSync(join(G, "src", "run", "a.ts"), "export {}");
    const before = snapshotTree(G);
    const r = prune(["--keep-last", "1", G]);
    expect(r.status, r.stderr).toBe(0);
    expect(snapshotTree(G)).toEqual(before);
    expect(r.stderr).toMatch(/left alone 10 dir\(s\) not named like a run/);
    expect(r.stderr).toContain(`no <scenario>/<run> dirs found under ${G}; the default runs root is ~/.cowork-harness/runs`);
  });

  it("F10: a runs root nested three levels down is left untouched (the allowlist, not the shape check)", () => {
    const R = realRoot(tmp("prune-ok-"), "s", 3);
    realRoot(join(R, "x", "y", "nested"), "t", 8);
    for (const w of ["w1", "w2"]) mkdirSync(join(R, "x", w)); // siblings, so a ranking of x's children would delete
    const before = snapshotTree(join(R, "x"));
    const r = prune(["--keep-last", "1", R]);
    expect(r.status, r.stderr).toBe(0);
    expect(runCount(join(R, "s"))).toBe(1);
    expect(snapshotTree(join(R, "x"))).toEqual(before);
    expect(r.stderr).toMatch(/left alone 3 dir\(s\) not named like a run/);
  });
});

describe.skipIf(!can)("prune ranks and deletes only dirs named like a run id", () => {
  it("a run-shaped dir with another name is left alone and counted separately, with its path", () => {
    const R = realRoot(tmp("prune-names-"), "s", 3);
    const odd = ["run-a", "run-b", "local_ABC", "2026-10-01"].map((n) => runDir(R, "s", { name: n, mtimeSec: T0 - 100 }));
    const r = prune(["--keep-last", "1", R]);
    expect(r.status, r.stderr).toBe(0);
    for (const d of odd) expect(existsSync(d), d).toBe(true);
    expect(runCount(join(R, "s"))).toBe(2); // local_ABC counts here by prefix; the 3 real local_ ids trimmed to 1
    expect(r.stderr).toMatch(/left 4 run-shaped dir\(s\) with an unrecognised name alone: /);
    expect(r.stderr).toContain(join(R, "s", "2026-10-01"));
    expect(r.stderr).toMatch(/\(\+1 more\)/);
  });

  it("a sess- dir outside the session-id grammar is not reclaimed by --pinned-older-than", () => {
    const R = tmp("prune-names-");
    const bad = runDir(R, "s", { name: "sess-a.b", mtimeSec: T0 - 30 * 86_400 });
    const good = runDir(R, "s", { name: "sess-ok_1", mtimeSec: T0 - 30 * 86_400 });
    const r = prune(["--pinned-older-than", "7d", R]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(bad)).toBe(true);
    expect(existsSync(good)).toBe(false);
  });

  it("the grammars match what every writer mints", () => {
    expect(gc.LOCAL_RUN_ID_RE.test(`local_${process.hrtime.bigint().toString(36)}`)).toBe(true); // execute.ts, chat.ts
    expect(gc.LOCAL_RUN_ID_RE.test(jobRunId("20260930-000000-abc123", "before", 0, 1))).toBe(true); // eval
    expect(gc.LOCAL_RUN_ID_RE.test(`local_${BigInt("0xffffffffffffffff").toString(36).padStart(13, "0")}`)).toBe(true); // hillclimb
    expect(gc.PINNED_RUN_ID_RE.test(`sess-${CRITIQUE_SESSION_PREFIX}${randomUUID()}`)).toBe(true); // critique
    expect(gc.PINNED_RUN_ID_RE.test("sess-My_Session-1")).toBe(true); // --session-id [A-Za-z0-9_-]+
    for (const n of ["local_", "local_A", "local_a.b", "sess-", "sess-a/b", "sess-a.b", "run-a"])
      expect(gc.LOCAL_RUN_ID_RE.test(n) || gc.PINNED_RUN_ID_RE.test(n), n).toBe(false);
  });
});

describe("runDirEvidence: one reader for the ranking and the level check", () => {
  const mk = (make: (d: string) => void): string => {
    const d = join(tmp("prune-ev-"), "local_0000000000001");
    mkdirSync(d);
    make(d);
    return d;
  };
  const fixtures: Record<string, string> = {
    statusOnly: mk((d) => writeFileSync(join(d, "status.json"), "{}")),
    originOnly: mk((d) => writeFileSync(join(d, ".origin"), "{}")),
    eventsOnly: mk((d) => writeFileSync(join(d, "events.jsonl"), "{}\n")),
    turnsOnly: mk((d) => mkdirSync(join(d, "turns", "1"), { recursive: true })),
    legacy: mk((d) => writeFileSync(join(d, "result.json"), "{}")),
    mixed: mk((d) => (mkdirSync(join(d, "turns", "1"), { recursive: true }), writeFileSync(join(d, "trace.json"), "{}"))),
    empty: mk(() => {}),
    dirNamedLikeMarkers: mk((d) =>
      ["events.jsonl", "status.json", "result.json", ".origin", "turns"].forEach((n) => mkdirSync(join(d, n))),
    ),
  };

  it("isRealRun implies looksLikeRunDir; status.json and .origin alone mark a run dir but not a real run", () => {
    for (const [k, d] of Object.entries(fixtures)) if (gc.isRealRun(d)) expect(gc.looksLikeRunDir(d), k).toBe(true);
    for (const k of ["statusOnly", "originOnly"]) {
      expect(gc.looksLikeRunDir(fixtures[k]), k).toBe(true);
      expect(gc.isRealRun(fixtures[k]), k).toBe(false);
    }
    for (const k of ["eventsOnly", "turnsOnly", "legacy", "mixed"]) expect(gc.isRealRun(fixtures[k]), k).toBe(true);
    for (const k of ["empty", "dirNamedLikeMarkers"]) expect(gc.looksLikeRunDir(fixtures[k]), k).toBe(false);
  });

  it("a stray result.json or invalid status.json above a correct root does not refuse it", () => {
    const P = tmp("prune-ev-");
    writeFileSync(join(P, "result.json"), "{}");
    writeFileSync(join(P, "events.jsonl"), "{}\n");
    writeFileSync(join(P, "status.json"), '{"state":"done"}');
    const R = realRoot(join(P, "runs-here"), "s", 2);
    expect(gc.pruneLevelRefusal(R)).toBeUndefined();
    expect(gc.pruneLevelRefusal(join(R, "s"))).toMatch(/scenario dir/);
    expect(dirname(R)).toBe(P);
  });
});

describe.skipIf(!can)("prune level check: review follow-ups", () => {
  it("a runs root whose child holds a manifest.json still prunes; the child is left alone", () => {
    const R = realRoot(tmp("prune-fu-"), "s", 3);
    mkdirSync(join(R, "backup"));
    writeFileSync(join(R, "backup", "manifest.json"), "{}");
    const r = prune(["--keep-last", "1", R]);
    expect(r.status, r.stderr).toBe(0);
    expect(runCount(join(R, "s"))).toBe(1);
    expect(existsSync(join(R, "backup", "manifest.json"))).toBe(true);
  });

  it("<run>/turns/1 names the run dir it is inside, and hints at the runs root", () => {
    let R = "";
    let run = "";
    const err = expectRefused(() => {
      R = tmp("prune-fu-");
      run = runDir(R, "s", { mtimeSec: T0 });
      return { top: R, args: [join(run, "turns", "1")] };
    }, /is inside the run dir /);
    expect(err).toContain(`is inside the run dir ${run}`);
    expect(err).toContain(`prune --dry-run ${R}`);
  });

  it("the parent hint prefers the child named runs over an earlier-sorted runs root", () => {
    let P = "";
    const err = expectRefused(() => {
      P = tmp("prune-fu-");
      realRoot(join(P, "aaa-root"));
      realRoot(join(P, "runs"));
      return { top: P, args: [P] };
    }, /looks like the parent of runs roots: /);
    expect(err).toContain(`Did you mean: cowork-harness prune --dry-run ${join(P, "runs")} (or ${join(P, "aaa-root")})`);
  });

  it("several nested runs roots are listed as one clean list", () => {
    let R = "";
    const err = expectRefused(() => {
      R = realRoot(tmp("prune-fu-"), "s", 2);
      realRoot(join(R, "n1"), "t", 2);
      realRoot(join(R, "n2"), "t", 2);
      return { top: R, args: [R] };
    }, /holds nested runs roots, so prune cannot run on it: /);
    expect(err).toContain(`${join(R, "n1")} (index.jsonl), ${join(R, "n2")} (index.jsonl). Nothing was deleted.`);
  });

  it("a root from COWORK_HARNESS_RUNS_DIR says so; one from --run-dir or the positional does not", () => {
    const R = realRoot(tmp("prune-fu-"), "s", 3);
    const env = prune([], { COWORK_HARNESS_RUNS_DIR: join(R, "s") });
    expect(env.status, env.stderr).toBe(2);
    expect(env.stderr).toContain(`prune: ${join(R, "s")} (from COWORK_HARNESS_RUNS_DIR) looks like a scenario dir`);
    const flag = prune(["--run-dir", join(R, "s")], { COWORK_HARNESS_RUNS_DIR: "/tmp/cwh-env-loses" });
    expect(flag.status).toBe(2);
    expect(flag.stderr).not.toContain("from COWORK_HARNESS_RUNS_DIR");
    const pos = prune([join(R, "s")], { COWORK_HARNESS_RUNS_DIR: R });
    expect(pos.status).toBe(2);
    expect(pos.stderr).not.toContain("from COWORK_HARNESS_RUNS_DIR");
  });

  // chmod 000 has no effect for root, so the case is meaningless there.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("an unreadable dir is skipped and counted, not a crash", () => {
    const R = realRoot(tmp("prune-fu-"), "s", 3);
    const locked = join(R, "locked");
    mkdirSync(join(locked, "local_0000000000001"), { recursive: true });
    const P = tmp("prune-fu-");
    const lockedChild = join(P, "locked");
    mkdirSync(join(lockedChild, "x"), { recursive: true });
    chmodSync(locked, 0o000);
    chmodSync(lockedChild, 0o000);
    try {
      const r = prune(["--keep-last", "1", R]);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toContain(`skipped 1 dir(s) it could not read: ${locked}`);
      expect(runCount(join(R, "s"))).toBe(1);
      const lv = prune([P]); // the level scan meets the unreadable child, too
      expect(lv.status, lv.stderr).toBe(0);
      expect(lv.stderr).not.toMatch(/\n\s+at /);
    } finally {
      chmodSync(locked, 0o755);
      chmodSync(lockedChild, 0o755);
    }
    expect(existsSync(join(locked, "local_0000000000001"))).toBe(true);
  });
});
