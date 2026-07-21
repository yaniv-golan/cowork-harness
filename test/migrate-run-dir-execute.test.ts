import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  statSync,
  utimesSync,
  readdirSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessRunDir, executeMigration, recoverIfNeeded, journalPathFor, migrateRunsRoot } from "../src/run/migrate-run-dir.js";

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

// ── The batch walker had effectively no coverage: of its behaviours only the exit code had a killing
// test, and five distinct mutations to its control flow left the whole suite green.

describe("migrateRunsRoot — the batch walker's control flow", () => {
  function legacyIn(root: string, scenario: string, id: string): string {
    const d = join(root, scenario, id);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "result.json"), RESULT(1));
    writeFileSync(join(d, "run.jsonl"), TRANSCRIPT);
    return d;
  }

  it("counts a recovered dir ONCE — not as recovered AND already-current", () => {
    const r0 = mkdtempSync(join(tmpdir(), "walk-rec-"));
    const d = legacyIn(r0, "scn", "sess-a");
    const a = assessRunDir(d);
    if (a.kind !== "plan") throw new Error("expected a plan");
    const jr = join(r0, ".migrating");
    expect(() =>
      executeMigration(a.plan, {
        journalRoot: jr,
        onOp: (_o, i) => {
          if (i === 0) throw new Error("crash");
        },
      }),
    ).toThrow();

    const rep = migrateRunsRoot(r0, { write: true });
    expect(rep.recovered, "the recovered dir was not counted as recovered").toBe(1);
    expect(rep.recovered + rep.noop + rep.migrated + rep.skipped, "one dir was counted twice").toBe(1);
    rmSync(r0, { recursive: true, force: true });
  });

  it("reports a dir that THROWS instead of letting it vanish from the report", () => {
    // A per-dir failure must surface as a refusal row. Swallowing it silently drops the directory from
    // every count — the report then claims everything was handled when it wasn't.
    //
    // The fixture has to make the WALKER'S catch fire, not a refusal that some callee returns. An earlier
    // version used a journal-shaped directory, which `recoverIfNeeded` turned into an ordinary refusal —
    // so the test passed while the catch block was entirely unexercised, and a mutation that swallowed
    // the throw stayed green. Here `turns` exists as a FILE, so assess plans moves into `turns/1/` and
    // execute's mkdir hits ENOTDIR — a genuine throw from inside the walker's try.
    const r0 = mkdtempSync(join(tmpdir(), "walk-throw-"));
    const d = legacyIn(r0, "scn", "sess-a");
    writeFileSync(join(d, "turns"), "not a directory");
    legacyIn(r0, "scn", "sess-b"); // a healthy sibling that must still be processed

    const rep = migrateRunsRoot(r0, { write: true });
    expect(rep.refused.length, "the throwing dir vanished from the report").toBe(1);
    expect(rep.refused[0]?.dir).toBe(d);
    expect(rep.migrated, "one bad dir aborted the batch — the sibling was never migrated").toBe(1);
    rmSync(r0, { recursive: true, force: true });
  });

  it("never walks INTO the journal store as if it were a scenario", () => {
    const r0 = mkdtempSync(join(tmpdir(), "walk-jrnl-"));
    legacyIn(r0, "scn", "sess-a");
    mkdirSync(join(r0, ".migrating", "scn"), { recursive: true });
    writeFileSync(join(r0, ".migrating", "scn", "sess-a.json"), "{}");
    const rep = migrateRunsRoot(r0, { write: false });
    // Two entries under .migrating would inflate skipped/refused if the walker descended into it.
    expect(rep.skipped + rep.refused.length, "the walker treated .migrating as a scenario").toBe(0);
    expect(rep.migrated).toBe(1);
    rmSync(r0, { recursive: true, force: true });
  });

  it("calls onDir for every directory it reaches (--verbose is not decoration)", () => {
    const r0 = mkdtempSync(join(tmpdir(), "walk-ondir-"));
    legacyIn(r0, "scn", "sess-a");
    mkdirSync(join(r0, "scn", "local_stub"), { recursive: true });
    writeFileSync(join(r0, "scn", "local_stub", "status.json"), "{}");
    const seen: string[] = [];
    migrateRunsRoot(r0, { write: false, onDir: (d) => seen.push(d) });
    expect(seen.length, "onDir was not called for every dir — --verbose would print nothing").toBe(2);
    rmSync(r0, { recursive: true, force: true });
  });

  it("REFUSES a dir it cannot read, rather than reporting it as an empty stub", () => {
    // An unreadable dir looks identical to an aborted stub through existsSync/readdir: both "have no
    // per-turn artifacts". For a migration tool, "could not look" must never render as "nothing to do".
    const r0 = mkdtempSync(join(tmpdir(), "walk-perm-"));
    const d = legacyIn(r0, "scn", "sess-a");
    chmodSync(d, 0o000);
    try {
      // Skip if the platform/user can read it anyway (e.g. running as root).
      let readable = true;
      try {
        readdirSync(d);
      } catch {
        readable = false;
      }
      if (readable) return;
      const rep = migrateRunsRoot(r0, { write: false });
      expect(rep.skipped, "an unreadable dir was counted as an empty stub").toBe(0);
      expect(rep.refused.length, "an unreadable dir was not reported").toBe(1);
    } finally {
      chmodSync(d, 0o755);
      rmSync(r0, { recursive: true, force: true });
    }
  });
});

describe("the journal store does not accumulate empty shells", () => {
  // A successful migration removed its journal FILE but left `.migrating/<scenario>/` behind. Across a
  // real runs root that is one empty directory per scenario — 96 of them — which reads to a human (and to
  // anyone grepping) as a migration still in flight. `prune` is not fooled (it counts .json files), so
  // this is cosmetic, but "looks like a stalled migration" is a bad thing for a migration tool to leave.
  it("removes the scenario dir, and .migrating itself, once the last journal is gone", () => {
    const d = legacyDir();
    executeMigration(planFor(d), { journalRoot });
    expect(existsSync(journalPathFor(journalRoot, d)), "journal file left behind").toBe(false);
    expect(existsSync(join(journalRoot, "scn")), "empty .migrating/<scenario> shell left behind").toBe(false);
    expect(existsSync(journalRoot), "empty .migrating root left behind").toBe(false);
  });

  it("leaves a scenario dir alone while it still holds another journal", () => {
    // Two dirs in one scenario, one crashed: removing the shared parent would destroy the survivor's
    // journal — the only record of its interrupted plan.
    const a = legacyDir("sess-a");
    const b = legacyDir("sess-b");
    const planB = planFor(b);
    expect(() =>
      executeMigration(planB, {
        journalRoot,
        onOp: (_o, i) => {
          if (i === 0) throw new Error("crash");
        },
      }),
    ).toThrow();
    executeMigration(planFor(a), { journalRoot }); // succeeds, removes only its own journal

    expect(existsSync(journalPathFor(journalRoot, a)), "the successful dir's journal survived").toBe(false);
    expect(existsSync(journalPathFor(journalRoot, b)), "the CRASHED dir's journal was destroyed").toBe(true);
    expect(existsSync(join(journalRoot, "scn")), "the shared scenario dir was removed while still in use").toBe(true);
  });

  it("NEVER climbs above .migrating — the runs root itself is not cleanup's business", () => {
    // The cleanup walks up removing empty dirs. It must stop at `.migrating`: one level further is the
    // RUNS ROOT, and a root whose only content was the journal store would be deleted outright. Bounding
    // the climb is the entire safety property, and nothing else pins it.
    const r0 = mkdtempSync(join(tmpdir(), "walk-bound-"));
    mkdirSync(join(r0, ".migrating", "ghost"), { recursive: true });
    writeFileSync(
      join(r0, ".migrating", "ghost", "sess-gone.json"),
      JSON.stringify({ outDir: join(r0, "ghost", "sess-gone"), ops: [], dirMtimes: {}, identity: { ino: 1, birthtimeMs: 1 } }),
    );

    // The sweep removes the orphaned journal, which empties .migrating/ghost and then .migrating.
    migrateRunsRoot(r0, { write: true });

    expect(existsSync(join(r0, ".migrating")), "the emptied journal store should be gone").toBe(false);
    expect(existsSync(r0), "*** THE RUNS ROOT WAS DELETED ***").toBe(true);
    rmSync(r0, { recursive: true, force: true });
  });
});
