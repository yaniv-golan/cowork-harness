import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync, utimesSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessRunDir, executeMigration, recoverIfNeeded, journalPathFor } from "../src/run/migrate-run-dir.js";

// THE CRASH PATH IS THE POINT OF THIS FILE.
//
// Four separate designs of this migrator's recovery each recreated the same permanently-stuck state in a
// new form: a marker written-but-never-consulted, then consulted-but-never-removed, then a "re-derive the
// plan" scheme that refuses forever because the renames mutate the very archive counts the derivation
// reads. The invariant every test below defends is the one that kept getting lost:
//
//     AFTER RECOVERY, THE DIRECTORY IS CORRECT *AND* A SUBSEQUENT RUN TERMINATES.
//
// A recovery that leaves the journal behind is not a recovery — it is the stuck state wearing a hat.

let root: string;
let journalRoot: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "migx-"));
  journalRoot = join(root, ".migrating");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const RESULT = (turn: number) => JSON.stringify({ scenario: "scn", turn });
const TRANSCRIPT = `{"t":"transcript","text":"hi"}`;
const OLD_MS = new Date("2026-01-15T09:00:00Z").getTime();

/** A plain pre-layout dir, deliberately stamped with an OLD mtime — the signal migration must preserve. */
function legacyDir(name = "sess-1"): string {
  const d = join(root, "scn", name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "result.json"), RESULT(1));
  writeFileSync(join(d, "run.jsonl"), TRANSCRIPT);
  writeFileSync(join(d, "trace.json"), "{}");
  writeFileSync(join(d, "events.jsonl"), "");
  for (const f of ["result.json", "run.jsonl", "trace.json", "events.jsonl"]) utimesSync(join(d, f), OLD_MS / 1000, OLD_MS / 1000);
  utimesSync(d, OLD_MS / 1000, OLD_MS / 1000);
  return d;
}

function planFor(d: string) {
  const a = assessRunDir(d);
  if (a.kind !== "plan") throw new Error(`expected a plan, got ${a.kind}`);
  return a.plan;
}

/** The migrated shape every test below expects. */
function expectMigrated(d: string): void {
  expect(existsSync(join(d, "turns", "1", "result.json")), "turns/1/result.json missing").toBe(true);
  expect(readFileSync(join(d, "turns", "1", "result.json"), "utf8")).toBe(RESULT(1));
  expect(readFileSync(join(d, "turns", "1", "run.jsonl"), "utf8")).toBe(TRANSCRIPT);
  expect(readFileSync(join(d, "turns", "1", "trace.json"), "utf8")).toBe("{}");
  for (const a of ["result.json", "run.jsonl", "trace.json"]) expect(existsSync(join(d, a)), `${a} still at root`).toBe(false);
  expect(existsSync(join(d, "events.jsonl")), "events.jsonl must never move").toBe(true);
}

describe("executeMigration — the success path", () => {
  it("moves the artifacts, preserves file AND directory mtimes, and removes the journal", () => {
    const d = legacyDir();
    executeMigration(planFor(d), { journalRoot });

    expectMigrated(d);
    // rename preserves file mtime for free; the DIRECTORY mtime has to be restored explicitly, because
    // moving files into turns/ re-stamps the parent — and run-dir mtime is what prune ranks by.
    expect(statSync(join(d, "turns", "1", "result.json")).mtimeMs).toBe(OLD_MS);
    expect(Math.round(statSync(d).mtimeMs), "run-dir mtime was not restored — prune ranking is now wrong").toBe(OLD_MS);
    expect(existsSync(journalPathFor(journalRoot, d)), "journal outlived a successful migration").toBe(false);
  });

  it("is idempotent — a second pass is a no-op", () => {
    const d = legacyDir();
    executeMigration(planFor(d), { journalRoot });
    expect(assessRunDir(d).kind).toBe("noop");
  });
});

describe("recovery — a crash at ANY point must complete AND terminate", () => {
  // Crash by throwing out of the per-op hook, which is how the CLI reports progress. Every index is
  // exercised, so this is the whole operation sequence rather than a hand-picked point.
  for (const crashAt of [0, 1, 2]) {
    it(`crash before op ${crashAt}: recovery completes the migration and removes the journal`, () => {
      const d = legacyDir();
      const plan = planFor(d);
      expect(() =>
        executeMigration(plan, {
          journalRoot,
          onOp: (_op, i) => {
            if (i === crashAt) throw new Error("simulated crash");
          },
        }),
      ).toThrow(/simulated crash/);

      // The journal must survive the crash — it is the only record of the plan.
      expect(existsSync(journalPathFor(journalRoot, d)), "journal did not survive the crash").toBe(true);

      const r = recoverIfNeeded(d, { journalRoot });
      expect(r.kind).toBe("recovered");
      expectMigrated(d);
      expect(Math.round(statSync(d).mtimeMs), "recovery did not restore the run-dir mtime").toBe(OLD_MS);
      // THE INVARIANT: recovery terminates. A journal left behind means every later run re-enters
      // replay and the dir never reaches assessment again.
      expect(existsSync(journalPathFor(journalRoot, d)), "RECOVERY LEFT THE JOURNAL — permanently stuck").toBe(false);
      expect(recoverIfNeeded(d, { journalRoot }).kind, "a second recovery should find nothing to do").toBe("none");
      expect(assessRunDir(d).kind).toBe("noop");
    });
  }

  it("crash DURING recovery still converges (double crash)", () => {
    const d = legacyDir();
    const plan = planFor(d);
    expect(() =>
      executeMigration(plan, {
        journalRoot,
        onOp: (_op, i) => {
          if (i === 1) throw new Error("crash 1");
        },
      }),
    ).toThrow();
    expect(() =>
      recoverIfNeeded(d, {
        journalRoot,
        onOp: (_op, i) => {
          if (i === 2) throw new Error("crash 2");
        },
      }),
    ).toThrow();
    expect(existsSync(journalPathFor(journalRoot, d)), "journal lost mid-recovery").toBe(true);

    expect(recoverIfNeeded(d, { journalRoot }).kind).toBe("recovered");
    expectMigrated(d);
    expect(existsSync(journalPathFor(journalRoot, d))).toBe(false);
  });
});

describe("recovery — the hazards of a journal that outlives its directory", () => {
  it("REFUSES rather than throwing when the journal is unreadable", () => {
    // A torn journal is possible on power loss. An uncaught JSON.parse would block this dir forever AND
    // abort the batch, violating "one bad dir never aborts the batch".
    const d = legacyDir();
    const jp = journalPathFor(journalRoot, d);
    mkdirSync(join(jp, ".."), { recursive: true });
    writeFileSync(jp, '{"ops":[{"kind":"mo');
    const r = recoverIfNeeded(d, { journalRoot });
    expect(r.kind).toBe("refuse");
    if (r.kind === "refuse") expect(r.reason).toMatch(/journal/i);
  });

  it("DISCARDS a stale journal whose run dir was deleted and recreated at the same path", () => {
    // Nothing sweeps a journal whose dir is gone, so a fresh run reusing scenario/runId would otherwise
    // have the stale plan replayed onto it — mislabeling it into turns/2 and minting phantom turns.
    const d = legacyDir();
    const plan = planFor(d);
    expect(() =>
      executeMigration(plan, {
        journalRoot,
        onOp: (_o, i) => {
          if (i === 0) throw new Error("crash");
        },
      }),
    ).toThrow();
    expect(existsSync(journalPathFor(journalRoot, d))).toBe(true);

    rmSync(d, { recursive: true, force: true });
    const fresh = legacyDir(); // same path, different directory

    const r = recoverIfNeeded(fresh, { journalRoot });
    expect(r.kind, "a stale journal was replayed onto a different directory").toBe("orphaned");
    expect(existsSync(journalPathFor(journalRoot, fresh)), "the orphaned journal was not swept").toBe(false);
    // And the fresh dir is untouched — still pre-layout, ready for its own assessment.
    expect(existsSync(join(fresh, "result.json"))).toBe(true);
  });

  it("REFUSES when a pending move's destination holds DIFFERENT bytes", () => {
    // Skipping on mere existence would strand the source and keep foreign bytes. Done-ness for a move is
    // "the source is gone", not "the destination exists".
    const d = legacyDir();
    const plan = planFor(d);
    expect(() =>
      executeMigration(plan, {
        journalRoot,
        onOp: (_o, i) => {
          if (i === 0) throw new Error("crash");
        },
      }),
    ).toThrow();
    const firstMove = plan.ops.find((o) => o.kind === "move");
    if (firstMove?.kind !== "move") throw new Error("no move in plan");
    mkdirSync(join(firstMove.to, ".."), { recursive: true });
    writeFileSync(firstMove.to, "FOREIGN BYTES");

    const r = recoverIfNeeded(d, { journalRoot });
    expect(r.kind).toBe("refuse");
    expect(readFileSync(firstMove.from, "utf8"), "the source was stranded").toBe(RESULT(1));
  });
});

describe("the journal lives OUTSIDE the run dir", () => {
  it("never writes into the directory whose mtime it is protecting", () => {
    const d = legacyDir();
    executeMigration(planFor(d), { journalRoot });
    expect(
      readdirSync(d).some((e) => e.includes("migrating")),
      "a marker was written inside the run dir",
    ).toBe(false);
    expect(journalPathFor(journalRoot, d).startsWith(journalRoot), "journal path escaped the journal root").toBe(true);
  });

  it("encodes scenario/runId unambiguously (a__b/c must not collide with a/b__c)", () => {
    const p1 = journalPathFor(journalRoot, join(root, "a__b", "c"));
    const p2 = journalPathFor(journalRoot, join(root, "a", "b__c"));
    expect(p1).not.toBe(p2);
  });
});

describe("the cumulative resources split, driven end to end", () => {
  // Planning a split proves nothing about the bytes. This drives assess -> execute and reads the files
  // back: a unit test that hands a builder its own input passes while the feature is dead, which is how
  // three features shipped broken in this repo.
  function archiveDirWithCumulativeResources(): { d: string; boundaryMs: number } {
    const d = join(root, "scn", "sess-cum");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "result.turn-1.json"), RESULT(1));
    writeFileSync(join(d, "run.turn-1.jsonl"), TRANSCRIPT);
    writeFileSync(join(d, "result.json"), RESULT(2));
    writeFileSync(join(d, "run.jsonl"), TRANSCRIPT);
    const boundaryMs = new Date("2026-01-15T10:00:00Z").getTime();
    utimesSync(join(d, "result.turn-1.json"), boundaryMs / 1000, boundaryMs / 1000);
    writeFileSync(
      join(d, "resources.jsonl"),
      [
        `{"ts":${boundaryMs - 2000},"rssBytes":1}`,
        `{"ts":${boundaryMs - 500},"rssBytes":2}`,
        `{"ts":${boundaryMs + 1500},"rssBytes":3}`,
      ].join("\n") + "\n",
    );
    return { d, boundaryMs };
  }

  it("lands turn-1 samples in turns/1 and turn-2 samples in turns/2, losing none", () => {
    const { d } = archiveDirWithCumulativeResources();
    const a = assessRunDir(d);
    if (a.kind !== "plan") throw new Error(`expected a plan, got ${a.kind}`);
    executeMigration(a.plan, { journalRoot });

    const low = readFileSync(join(d, "turns", "1", "resources.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    const high = readFileSync(join(d, "turns", "2", "resources.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(
      low.map((l) => JSON.parse(l).rssBytes),
      "turn-1 samples were mis-attributed",
    ).toEqual([1, 2]);
    expect(
      high.map((l) => JSON.parse(l).rssBytes),
      "turn-2 samples were mis-attributed",
    ).toEqual([3]);
    expect(low.length + high.length, "a sample was lost in the split").toBe(3);
    expect(existsSync(join(d, "resources.jsonl")), "the cumulative source survived the split").toBe(false);
  });

  it("re-splits from scratch on recovery rather than trusting a torn destination", () => {
    // A split is write+write+delete. Done-ness is "source is gone" — a destination that exists may be a
    // half-written file from the crashed attempt, so replay must OVERWRITE both sides using the boundary
    // recorded in the journal.
    const { d } = archiveDirWithCumulativeResources();
    const a = assessRunDir(d);
    if (a.kind !== "plan") throw new Error("expected a plan");
    const splitIndex = a.plan.ops.findIndex((o) => o.kind === "split");
    expect(splitIndex, "no split op to crash on").toBeGreaterThanOrEqual(0);

    expect(() =>
      executeMigration(a.plan, {
        journalRoot,
        onOp: (_o, i) => {
          if (i === splitIndex) throw new Error("crash at the split");
        },
      }),
    ).toThrow();
    // The state a real mid-split crash leaves: the source still present (the delete is last) and a
    // half-written destination. Recovery must treat the split as NOT done — because the source survives —
    // and overwrite the torn file rather than accepting it.
    mkdirSync(join(d, "turns", "1"), { recursive: true });
    writeFileSync(join(d, "turns", "1", "resources.jsonl"), `{"ts":1,"rssByt`);
    expect(existsSync(join(d, "resources.jsonl")), "fixture invalid: the split source should still exist").toBe(true);

    expect(recoverIfNeeded(d, { journalRoot }).kind).toBe("recovered");
    const low = readFileSync(join(d, "turns", "1", "resources.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(
      low.map((l) => JSON.parse(l).rssBytes),
      "recovery trusted a torn destination",
    ).toEqual([1, 2]);
  });
});

// ── A code review found the journal loader validates only two fields, so several malformed-but-parseable
// journals either threw (aborting the batch) or were treated as complete and deleted.

describe("recovery — a journal that PARSES but is malformed", () => {
  function plantJournal(d: string, body: unknown): string {
    const jp = journalPathFor(journalRoot, d);
    mkdirSync(join(jp, ".."), { recursive: true });
    writeFileSync(jp, JSON.stringify(body));
    return jp;
  }

  it("REFUSES a journal missing dirMtimes instead of throwing out of the batch", () => {
    const d = legacyDir();
    plantJournal(d, { outDir: d, ops: [], identity: { ino: 1, birthtimeMs: 1 } }); // no dirMtimes
    const r = recoverIfNeeded(d, { journalRoot });
    expect(r.kind, "a malformed journal escaped as an exception").toBe("refuse");
  });

  it("REFUSES a journal whose ops are not recognisable operations", () => {
    // Garbage ops made every op look 'done' (existsSync(undefined) is false), so recovery reported
    // SUCCESS and deleted the journal — corrupt recovery state, reported as complete.
    const d = legacyDir();
    const jp = plantJournal(d, {
      outDir: d,
      ops: [{ bogus: true }],
      identity: { ino: 1, birthtimeMs: 1 },
      dirMtimes: {},
    });
    const r = recoverIfNeeded(d, { journalRoot });
    expect(r.kind, "unrecognisable ops were treated as already-done").toBe("refuse");
    expect(existsSync(jp), "a journal it could not understand was deleted").toBe(true);
  });

  it("REFUSES a journal with no identity rather than deleting it as 'orphaned'", () => {
    const d = legacyDir();
    const jp = plantJournal(d, { outDir: d, ops: [], dirMtimes: {} });
    const r = recoverIfNeeded(d, { journalRoot });
    expect(r.kind).toBe("refuse");
    expect(existsSync(jp), "an unvalidated journal was destroyed rather than refused").toBe(true);
  });
});

describe("executeMigration — guards", () => {
  it("REFUSES to run when a journal for this dir already exists", () => {
    // Otherwise a crashed dir can be re-assessed and re-executed WITHOUT recovering, clobbering the only
    // record of the interrupted plan.
    const d = legacyDir();
    const plan = planFor(d);
    expect(() =>
      executeMigration(plan, {
        journalRoot,
        onOp: (_o, i) => {
          if (i === 0) throw new Error("crash");
        },
      }),
    ).toThrow();
    expect(() => executeMigration(planFor(d), { journalRoot })).toThrow(/journal|recover/i);
  });

  it("restores the mtimes of turns/ and each turns/<N>/, not just the run dir", () => {
    const d = legacyDir();
    mkdirSync(join(d, "turns", "1"), { recursive: true });
    const TURNS_MS = new Date("2026-02-01T08:00:00Z").getTime();
    utimesSync(join(d, "turns"), TURNS_MS / 1000, TURNS_MS / 1000);
    utimesSync(join(d, "turns", "1"), TURNS_MS / 1000, TURNS_MS / 1000);
    utimesSync(d, OLD_MS / 1000, OLD_MS / 1000);

    const a = assessRunDir(d);
    if (a.kind !== "plan") throw new Error(`expected a plan, got ${a.kind}`);
    executeMigration(a.plan, { journalRoot });

    expect(Math.round(statSync(d).mtimeMs)).toBe(OLD_MS);
    expect(Math.round(statSync(join(d, "turns")).mtimeMs), "turns/ mtime not restored").toBe(TURNS_MS);
    expect(Math.round(statSync(join(d, "turns", "1")).mtimeMs), "turns/1 mtime not restored").toBe(TURNS_MS);
  });
});
