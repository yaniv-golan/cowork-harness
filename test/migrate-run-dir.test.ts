import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessRunDir } from "../src/run/migrate-run-dir.js";

// Phase 1 (ASSESS) is where every data-safety rule lives, and it is specified to be COMPLETELY
// mutation-free: three prior revisions of this spec deleted or fabricated a turn because assessment and
// execution were interleaved. So these tests assert on the PLAN, and additionally assert that assessing
// never touched the directory.

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "migrate-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A run dir under a realistic `<runsRoot>/<scenario>/<runId>` tree. */
function runDir(name = "sess-1"): string {
  const d = join(root, "scn", name);
  mkdirSync(d, { recursive: true });
  return d;
}

function write(dir: string, rel: string, body: string): void {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
}

/** A snapshot of every file path + its bytes, to prove assessment mutated nothing. */
function snapshot(dir: string): string {
  const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(`${p.slice(dir.length)}:${statSync(p).size}:${readFileSync(p, "utf8")}`);
    }
  };
  walk(dir);
  return out.join("\n");
}

const RESULT = (turn?: number) => JSON.stringify(turn === undefined ? { scenario: "scn" } : { scenario: "scn", turn });
const TRANSCRIPT = `{"t":"transcript","text":"hi"}`;

describe("assessRunDir — the plain single-turn legacy dir (1,618 of the real population)", () => {
  it("plans a move of every root artifact into turns/1", () => {
    const d = runDir();
    write(d, "result.json", RESULT(1));
    write(d, "run.jsonl", TRANSCRIPT);
    write(d, "trace.json", "{}");
    write(d, "events.jsonl", "");
    const before = snapshot(d);

    const a = assessRunDir(d);

    expect(a.kind, `expected a plan, got ${a.kind === "refuse" ? a.reason : a.kind}`).toBe("plan");
    if (a.kind !== "plan") return;
    const moves = a.plan.ops.filter((o) => o.kind === "move").map((o) => `${o.from.slice(d.length)} -> ${o.to.slice(d.length)}`);
    expect(moves.sort()).toEqual(
      ["/result.json -> /turns/1/result.json", "/run.jsonl -> /turns/1/run.jsonl", "/trace.json -> /turns/1/trace.json"].sort(),
    );
    // events.jsonl is NOT per-turn: moving it breaks `trace`, the one command that reads legacy dirs.
    expect(moves.join(), "events.jsonl must never move").not.toContain("events.jsonl");
    expect(snapshot(d), "ASSESSMENT MUTATED THE DIRECTORY").toBe(before);
  });
});

describe("assessRunDir — the shapes that must NOT be migrated", () => {
  it("skips an aborted stub (2,111 of the real population) without calling it a failure", () => {
    const d = runDir();
    write(d, "status.json", "{}");
    write(d, "mounts.json", "{}");
    expect(assessRunDir(d).kind).toBe("skip");
  });

  it("reports an already-current dir as a no-op", () => {
    const d = runDir();
    write(d, "turns/1/result.json", RESULT(1));
    write(d, "turns/1/run.jsonl", TRANSCRIPT);
    expect(assessRunDir(d).kind).toBe("noop");
  });

  it("REFUSES a dir with no transcript anywhere, rather than laundering it past the gates", () => {
    // The 5 real resources-only dirs. Migrating one yields a `turns` shape with no run.jsonl, which
    // `requireTurns` happily passes — and `diff` then reports two DIFFERENT such dirs as identical,
    // exit 0. Migration must never convert refused-legacy into gate-passing-empty.
    const d = runDir();
    write(d, "resources.jsonl", `{"ts":1,"rssBytes":1}`);
    write(d, "events.jsonl", "");
    const a = assessRunDir(d);
    expect(a.kind).toBe("refuse");
    if (a.kind === "refuse") expect(a.reason).toMatch(/transcript|run\.jsonl/i);
  });
});

describe("assessRunDir — the compat-copy trap (root artifact beside turns/)", () => {
  it("DELETES a root result.json byte-identical to a lower turn, without minting a bogus slot", () => {
    const d = runDir();
    write(d, "turns/1/result.json", RESULT(1));
    write(d, "turns/1/run.jsonl", TRANSCRIPT);
    write(d, "turns/2/result.json", RESULT(2));
    write(d, "turns/2/run.jsonl", TRANSCRIPT);
    write(d, "result.json", RESULT(1)); // identical to turn 1, NOT the highest turn
    const a = assessRunDir(d);
    expect(a.kind).toBe("plan");
    if (a.kind !== "plan") return;
    expect(a.plan.ops.filter((o) => o.kind === "delete").map((o) => o.path.slice(d.length))).toEqual(["/result.json"]);
    expect(
      a.plan.ops.some((o) => o.kind === "move" && o.to.includes("turns/3")),
      "minted a bogus turn 3",
    ).toBe(false);
  });

  it("MOVES a root result.json into an empty counterpart slot instead of deleting the only copy", () => {
    // The documented crash contract: run.jsonl is written before result.json, so turns/1 can hold a
    // transcript and no result while the root still holds that turn's only result.
    const d = runDir();
    write(d, "turns/1/run.jsonl", TRANSCRIPT);
    write(d, "result.json", RESULT(1));
    const a = assessRunDir(d);
    expect(a.kind).toBe("plan");
    if (a.kind !== "plan") return;
    expect(
      a.plan.ops.filter((o) => o.kind === "delete"),
      "deleted the only copy of turn 1's result",
    ).toEqual([]);
    expect(a.plan.ops.filter((o) => o.kind === "move").map((o) => o.to.slice(d.length))).toEqual(["/turns/1/result.json"]);
  });

  it("REFUSES when the root artifact is neither a duplicate nor placeable", () => {
    const d = runDir();
    write(d, "turns/1/result.json", RESULT(1));
    write(d, "turns/1/run.jsonl", TRANSCRIPT);
    write(d, "result.json", RESULT(9)); // different content, and turn 1's slot is occupied
    const a = assessRunDir(d);
    expect(a.kind).toBe("refuse");
    // The reason must name THIS cause. Asserting only `kind === "refuse"` passes against any
    // refuse-everything implementation — it cannot tell a correct refusal from a broken one.
    if (a.kind === "refuse") expect(a.reason).toMatch(/result\.json/);
  });
});

describe("assessRunDir — per-dir turn mapping on archive dirs (the 12 real ones)", () => {
  it("maps archives to their own turn and root artifacts to max+1, per DIR not per artifact family", () => {
    // These dirs archive result/run but NEVER trace — so root trace.json is the LATEST turn's, not
    // turn 1's. A per-artifact-family reading mislabels it in 12/12 real cases.
    const d = runDir();
    write(d, "result.turn-1.json", RESULT(1));
    write(d, "run.turn-1.jsonl", TRANSCRIPT);
    write(d, "result.json", RESULT(2));
    write(d, "run.jsonl", TRANSCRIPT);
    write(d, "trace.json", "{}");
    const a = assessRunDir(d);
    expect(a.kind).toBe("plan");
    if (a.kind !== "plan") return;
    const moves = Object.fromEntries(
      a.plan.ops.filter((o) => o.kind === "move").map((o) => [o.from.slice(d.length), o.to.slice(d.length)]),
    );
    expect(moves["/result.turn-1.json"]).toBe("/turns/1/result.json");
    expect(moves["/run.turn-1.jsonl"]).toBe("/turns/1/run.jsonl");
    expect(moves["/result.json"]).toBe("/turns/2/result.json");
    expect(moves["/trace.json"], "root trace.json is turn 2's, not turn 1's").toBe("/turns/2/trace.json");
  });

  it("REFUSES when two planned operations would target the same destination", () => {
    // Neither the archive mapping nor the 3-branch rule sees the other's PLAN; each only checks
    // existing occupancy. Without a uniqueness assertion the second rename silently wins.
    const d = runDir();
    mkdirSync(join(d, "turns", "1"), { recursive: true });
    write(d, "result.turn-1.json", RESULT(1));
    write(d, "run.turn-1.jsonl", TRANSCRIPT);
    write(d, "result.json", RESULT()); // no .turn stamp — 404 of 1,630 real results have none
    const a = assessRunDir(d);
    expect(a.kind).toBe("refuse");
    if (a.kind === "refuse") expect(a.reason).toMatch(/destination|collide|conflict/i);
  });
});

describe("assessRunDir — the cumulative resources file on archive dirs (N6/P2-7)", () => {
  it("SPLITS a cumulative resources.jsonl at the prior turn's completion boundary", () => {
    // On the 12 real archive dirs `resources.jsonl` spans BOTH turns (they predate beginTurn's resources
    // rename): its first sample lands seconds before turn 1 completed and its last during turn 2. Carrying
    // the whole file into one slot attributes turn-1 samples to turn 2 — data preserved, telemetry wrong.
    // The boundary is the prior turn's result archive mtime, i.e. that turn's completion time.
    const d = runDir();
    write(d, "result.turn-1.json", RESULT(1));
    write(d, "run.turn-1.jsonl", TRANSCRIPT);
    write(d, "result.json", RESULT(2));
    write(d, "run.jsonl", TRANSCRIPT);
    const boundaryMs = new Date("2026-01-15T10:00:00Z").getTime();
    utimesSync(join(d, "result.turn-1.json"), boundaryMs / 1000, boundaryMs / 1000);
    write(
      d,
      "resources.jsonl",
      [
        `{"ts":${boundaryMs - 2000},"rssBytes":1}`,
        `{"ts":${boundaryMs - 500},"rssBytes":2}`,
        `{"ts":${boundaryMs + 1500},"rssBytes":3}`,
      ].join("\n") + "\n",
    );

    const a = assessRunDir(d);
    expect(a.kind, `expected a plan, got ${a.kind === "refuse" ? a.reason : a.kind}`).toBe("plan");
    if (a.kind !== "plan") return;
    const split = a.plan.ops.find((o) => o.kind === "split");
    expect(split, "no split planned — the cumulative file would be carried whole into one turn").toBeDefined();
    if (split?.kind !== "split") return;
    expect(split.boundaryMs).toBe(boundaryMs);
    expect(split.toLow.slice(d.length)).toBe("/turns/1/resources.jsonl");
    expect(split.toHigh.slice(d.length)).toBe("/turns/2/resources.jsonl");
  });

  it("does NOT split a resources.jsonl that lies entirely on one side of the boundary", () => {
    const d = runDir();
    write(d, "result.turn-1.json", RESULT(1));
    write(d, "run.turn-1.jsonl", TRANSCRIPT);
    write(d, "result.json", RESULT(2));
    write(d, "run.jsonl", TRANSCRIPT);
    const boundaryMs = new Date("2026-01-15T10:00:00Z").getTime();
    utimesSync(join(d, "result.turn-1.json"), boundaryMs / 1000, boundaryMs / 1000);
    write(d, "resources.jsonl", `{"ts":${boundaryMs + 1000},"rssBytes":3}\n`);

    const a = assessRunDir(d);
    expect(a.kind).toBe("plan");
    if (a.kind !== "plan") return;
    expect(
      a.plan.ops.some((o) => o.kind === "split"),
      "split a file that never spans the boundary",
    ).toBe(false);
    expect(
      a.plan.ops.filter((o) => o.kind === "move").map((o) => o.to.slice(d.length)),
      "a wholly-turn-2 resources file belongs in turn 2",
    ).toContain("/turns/2/resources.jsonl");
  });
});

// ── Gaps a code review found by mutation: 9 of 15 mutations to assessRunDir left the suite GREEN,
// including one that silently deleted a genuine archive. Each test below kills a specific survivor.

describe("assessRunDir — split destinations are subject to the SAME collision rules as moves", () => {
  function spanning(d: string, boundaryMs: number, name: string): void {
    write(d, name, [`{"ts":${boundaryMs - 1000},"rssBytes":1}`, `{"ts":${boundaryMs + 1000},"rssBytes":2}`].join("\n") + "\n");
  }

  it("REFUSES when a split destination collides with another planned operation", () => {
    // The archive move targets turns/1/resources.jsonl and the split's toLow targets the same path.
    // Uniqueness was enforced for moves only, so execute ran the move and the split then overwrote it.
    const d = runDir();
    write(d, "result.turn-1.json", RESULT(1));
    write(d, "run.turn-1.jsonl", TRANSCRIPT);
    write(d, "resources.turn-1.jsonl", `{"ts":1,"rssBytes":9}`);
    write(d, "result.json", RESULT(2));
    write(d, "run.jsonl", TRANSCRIPT);
    const boundaryMs = new Date("2026-01-15T10:00:00Z").getTime();
    utimesSync(join(d, "result.turn-1.json"), boundaryMs / 1000, boundaryMs / 1000);
    spanning(d, boundaryMs, "resources.jsonl");

    const a = assessRunDir(d);
    expect(a.kind, "a split silently overwrote another operation's destination").toBe("refuse");
  });

  it("REFUSES when a split destination already exists on disk", () => {
    // Fixture deliberately avoids every OTHER refusal path (the archives are byte-identical to their
    // slots, so they resolve as duplicates) — otherwise this passes on an unrelated refusal, which is
    // exactly what it did before: it was green while the split still overwrote the file.
    const d = runDir();
    write(d, "turns/1/result.json", RESULT(1));
    write(d, "turns/1/run.jsonl", TRANSCRIPT);
    write(d, "turns/1/resources.jsonl", `{"ts":1,"rssBytes":42}`); // pre-existing telemetry
    write(d, "result.turn-1.json", RESULT(1)); // identical to the slot -> duplicate, not a refusal
    write(d, "run.turn-1.jsonl", TRANSCRIPT); // ditto
    const boundaryMs = new Date("2026-01-15T10:00:00Z").getTime();
    utimesSync(join(d, "result.turn-1.json"), boundaryMs / 1000, boundaryMs / 1000);
    spanning(d, boundaryMs, "resources.jsonl");

    const a = assessRunDir(d);
    expect(a.kind, "a split overwrote pre-existing telemetry").toBe("refuse");
    if (a.kind === "refuse") expect(a.reason, "refused, but for an unrelated reason").toMatch(/resources/);
  });
});

describe("assessRunDir — an ARCHIVE-named resources file is split on content too (F3)", () => {
  it("splits resources.turn-N.jsonl when its samples span the boundary — the filename is a hint, not authority", () => {
    // The N1 resume fix MINTS exactly this file (it renames a cumulative root resources.jsonl to
    // resources.turn-<prior>.jsonl), so every archive dir resumed between upgrade and migration hits it.
    const d = runDir();
    write(d, "result.turn-1.json", RESULT(1));
    write(d, "run.turn-1.jsonl", TRANSCRIPT);
    write(d, "result.json", RESULT(2));
    write(d, "run.jsonl", TRANSCRIPT);
    const boundaryMs = new Date("2026-01-15T10:00:00Z").getTime();
    utimesSync(join(d, "result.turn-1.json"), boundaryMs / 1000, boundaryMs / 1000);
    write(
      d,
      "resources.turn-1.jsonl",
      [`{"ts":${boundaryMs - 1000},"rssBytes":1}`, `{"ts":${boundaryMs + 1000},"rssBytes":2}`].join("\n") + "\n",
    );

    const a = assessRunDir(d);
    expect(a.kind).toBe("plan");
    if (a.kind !== "plan") return;
    const split = a.plan.ops.find((o) => o.kind === "split");
    expect(split, "an archive-named cumulative file was carried whole into one turn").toBeDefined();
  });
});

describe("assessRunDir — resources attribution when the file does NOT span the boundary (P2-7)", () => {
  function archiveDir(boundaryMs: number): string {
    const d = runDir();
    write(d, "result.turn-1.json", RESULT(1));
    write(d, "run.turn-1.jsonl", TRANSCRIPT);
    write(d, "result.json", RESULT(2));
    write(d, "run.jsonl", TRANSCRIPT);
    utimesSync(join(d, "result.turn-1.json"), boundaryMs / 1000, boundaryMs / 1000);
    return d;
  }

  it("attributes an entirely-BEFORE-boundary file to the PRIOR turn, not the latest", () => {
    const boundaryMs = new Date("2026-01-15T10:00:00Z").getTime();
    const d = archiveDir(boundaryMs);
    write(d, "resources.jsonl", `{"ts":${boundaryMs - 5000},"rssBytes":1}\n`);
    const a = assessRunDir(d);
    expect(a.kind).toBe("plan");
    if (a.kind !== "plan") return;
    const mv = a.plan.ops.find((o) => o.kind === "move" && o.from.endsWith("resources.jsonl"));
    expect(mv?.kind === "move" ? mv.to.slice(d.length) : undefined, "turn-1 telemetry was labeled turn 2").toBe("/turns/1/resources.jsonl");
  });

  it("REFUSES rather than attributing a file whose sample timestamps are unparseable", () => {
    const boundaryMs = new Date("2026-01-15T10:00:00Z").getTime();
    const d = archiveDir(boundaryMs);
    write(d, "resources.jsonl", `not json at all\n`);
    const a = assessRunDir(d);
    expect(a.kind, "samples with no usable timestamp were attributed by guess").toBe("refuse");
  });

  it("puts a sample exactly ON the boundary in the PRIOR turn (<=, not <)", () => {
    const boundaryMs = new Date("2026-01-15T10:00:00Z").getTime();
    const d = archiveDir(boundaryMs);
    write(d, "resources.jsonl", [`{"ts":${boundaryMs},"rssBytes":1}`, `{"ts":${boundaryMs + 1000},"rssBytes":2}`].join("\n") + "\n");
    const a = assessRunDir(d);
    expect(a.kind).toBe("plan");
    if (a.kind !== "plan") return;
    const split = a.plan.ops.find((o) => o.kind === "split");
    expect(split, "a boundary-exact sample did not register as spanning").toBeDefined();
  });
});

describe("assessRunDir — archive/slot collision, BOTH arms (they are both reachable)", () => {
  it("DROPS an archive identical to the slot it targets", () => {
    const d = runDir();
    write(d, "turns/1/result.json", RESULT(1));
    write(d, "turns/1/run.jsonl", TRANSCRIPT);
    write(d, "result.turn-1.json", RESULT(1)); // identical to the slot
    const a = assessRunDir(d);
    expect(a.kind).toBe("plan");
    if (a.kind !== "plan") return;
    expect(a.plan.ops.filter((o) => o.kind === "delete").map((o) => o.path.slice(d.length))).toEqual(["/result.turn-1.json"]);
  });

  it("REFUSES when an archive collides with a slot holding DIFFERENT bytes", () => {
    // Mutating this arm to "delete the archive" left all 24 tests green — a silent data-destroying
    // regression with no coverage at all.
    const d = runDir();
    write(d, "turns/1/result.json", RESULT(1));
    write(d, "turns/1/run.jsonl", TRANSCRIPT);
    write(d, "result.turn-1.json", RESULT(7)); // DIFFERENT
    const a = assessRunDir(d);
    expect(a.kind, "a differing archive was silently dropped").toBe("refuse");
  });
});

describe("assessRunDir — the .turn cross-check", () => {
  it("REFUSES when a root result.json's stamp disagrees with the only free slot", () => {
    const d = runDir();
    write(d, "turns/1/run.jsonl", TRANSCRIPT); // turn 1 lacks a result -> it is the free slot
    write(d, "turns/2/result.json", RESULT(2));
    write(d, "turns/2/run.jsonl", TRANSCRIPT);
    write(d, "result.json", RESULT(5)); // stamped 5, but the free slot is 1
    const a = assessRunDir(d);
    expect(a.kind, "a mis-stamped result was placed into a slot it does not belong to").toBe("refuse");
  });
});

describe("assessRunDir — byte-identity deletion is restricted to SELF-LABELING artifacts (P2-6)", () => {
  it("does NOT delete an empty root resources.jsonl merely because a turn's is also empty", () => {
    // trace/resources carry no turn stamp, so byte-identity is not proof of duplication: an empty file
    // matches every other empty file. Deleting here loses turn N's file EXISTENCE.
    const d = runDir();
    write(d, "turns/1/result.json", RESULT(1));
    write(d, "turns/1/run.jsonl", TRANSCRIPT);
    write(d, "turns/1/resources.jsonl", "");
    write(d, "turns/2/result.json", RESULT(2));
    write(d, "turns/2/run.jsonl", TRANSCRIPT);
    write(d, "resources.jsonl", ""); // identical bytes to turns/1's, but it is turn 2's
    const a = assessRunDir(d);
    expect(a.kind).toBe("plan");
    if (a.kind !== "plan") return;
    expect(
      a.plan.ops.some((o) => o.kind === "delete"),
      "an empty resources file was deleted as a 'duplicate'",
    ).toBe(false);
  });
});

describe("assessRunDir — the boundary itself is undeterminable", () => {
  it("REFUSES when there is no archived result to date the prior turn's completion", () => {
    // An archive dir that kept run.turn-1.jsonl but not result.turn-1.json: the boundary a resources
    // split depends on cannot be established, so any attribution would be a guess.
    const d = runDir();
    write(d, "run.turn-1.jsonl", TRANSCRIPT);
    write(d, "result.json", RESULT(2));
    write(d, "run.jsonl", TRANSCRIPT);
    write(d, "resources.jsonl", `{"ts":1,"rssBytes":1}\n`);
    const a = assessRunDir(d);
    expect(a.kind).toBe("refuse");
    if (a.kind === "refuse") expect(a.reason).toMatch(/boundary/i);
  });
});

describe("assessRunDir — the POST-CRASH shape, where the boundary lives in turns/ not at the root", () => {
  it("REFUSES a cumulative resources.jsonl beside turns/ rather than carrying it whole", () => {
    // The shape left by a mid-split crash whose journal was then removed — which the tool's own
    // malformed-journal message told the user to do. The archives have already moved into turns/, so
    // there is no root `result.turn-N.json` left to date the boundary with. Deriving `maxArchive` from
    // the root alone made the split unreachable, the cumulative file was moved WHOLE into the lowest free
    // slot, a torn destination was laundered as turn-1 telemetry, and the run reported SUCCESS.
    const d = runDir();
    const B = new Date("2026-01-15T10:00:00Z").getTime();
    write(d, "turns/1/result.json", RESULT(1));
    write(d, "turns/1/run.jsonl", TRANSCRIPT);
    write(d, "turns/2/result.json", RESULT(2));
    write(d, "turns/2/run.jsonl", TRANSCRIPT);
    utimesSync(join(d, "turns/1/result.json"), B / 1000, B / 1000);
    write(d, "turns/1/resources.jsonl", `{"ts":1,"TORN`); // the half-written destination
    write(d, "resources.jsonl", [`{"ts":${B - 2000},"rss":1}`, `{"ts":${B + 1500},"rss":3}`].join("\n") + "\n");

    const a = assessRunDir(d);
    expect(a.kind, "a cumulative file was carried whole into one turn after a crash").toBe("refuse");
    if (a.kind === "refuse") expect(a.reason).toMatch(/resources/);
  });

  it("still SPLITS correctly when the boundary is only available from turns/", () => {
    // The same crash WITHOUT a torn destination: every artifact has migrated except the cumulative
    // resources file, so both turns exist and the boundary must come from `turns/1/result.json`'s mtime.
    // (Both turns must be real — a split whose high half landed in a turn with no result or transcript
    // would be manufacturing the very no-transcript shape the migrator refuses elsewhere.)
    const d = runDir();
    const B = new Date("2026-01-15T10:00:00Z").getTime();
    write(d, "turns/1/result.json", RESULT(1));
    write(d, "turns/1/run.jsonl", TRANSCRIPT);
    write(d, "turns/2/result.json", RESULT(2));
    write(d, "turns/2/run.jsonl", TRANSCRIPT);
    utimesSync(join(d, "turns/1/result.json"), B / 1000, B / 1000);
    write(d, "resources.jsonl", [`{"ts":${B - 2000},"rss":1}`, `{"ts":${B + 1500},"rss":3}`].join("\n") + "\n");

    const a = assessRunDir(d);
    expect(a.kind, `expected a plan, got ${a.kind === "refuse" ? a.reason : a.kind}`).toBe("plan");
    if (a.kind !== "plan") return;
    const split = a.plan.ops.find((o) => o.kind === "split");
    expect(split, "no split — the boundary was not derived from turns/").toBeDefined();
    if (split?.kind === "split") {
      expect(split.boundaryMs).toBe(B);
      expect(split.toLow.slice(d.length)).toBe("/turns/1/resources.jsonl");
      expect(split.toHigh.slice(d.length)).toBe("/turns/2/resources.jsonl");
    }
  });
});

describe("assessRunDir — critique's graded aliases (the plan's last open question)", () => {
  it("leaves result.graded.json / trace.graded.json alone and does not treat them as contamination", () => {
    // The plan left this OPEN: should the migrator re-point the graded aliases? Answering it here rather
    // than shipping an unanswered question.
    //
    // No. They are root-level COPIES of the graded turn, not per-turn artifacts — critique writes them
    // precisely so a consumer has a role-stable name that does not move. The migrator must neither move
    // them (that would break the stable name) nor count them as pre-layout markers (that would make every
    // migrated critique dir look mixed and get refused forever).
    const d = runDir();
    write(d, "result.json", RESULT(1));
    write(d, "run.jsonl", TRANSCRIPT);
    write(d, "result.graded.json", RESULT(1));
    write(d, "trace.graded.json", "{}");

    const a = assessRunDir(d);
    expect(a.kind, `expected a plan, got ${a.kind === "refuse" ? a.reason : a.kind}`).toBe("plan");
    if (a.kind !== "plan") return;
    const touched = a.plan.ops.map((o) => (o.kind === "delete" ? o.path : o.kind === "move" ? o.from : o.from));
    expect(
      touched.some((p) => p.includes("graded")),
      "the migrator moved or deleted a graded alias",
    ).toBe(false);
  });

  it("a MIGRATED critique dir is `turns`, not `mixed` — the aliases must not make it look contaminated", () => {
    const d = runDir();
    write(d, "turns/1/result.json", RESULT(1));
    write(d, "turns/1/run.jsonl", TRANSCRIPT);
    write(d, "turns/2/result.json", RESULT(2));
    write(d, "turns/2/run.jsonl", TRANSCRIPT);
    write(d, "result.graded.json", RESULT(1));
    write(d, "trace.graded.json", "{}");
    expect(assessRunDir(d).kind, "a normal critique dir was not recognised as already current").toBe("noop");
  });
});
