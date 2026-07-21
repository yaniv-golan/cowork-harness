import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
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
