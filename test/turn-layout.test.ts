import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listTurns,
  latestTurn,
  turnArtifactPath,
  resolveGraded,
  hasTurnDirs,
  classifyRunDir,
  requireTurns,
  preLayoutMessage,
} from "../src/run/turn-layout.js";
import { LegacyRunDirError } from "../src/errors.js";

/** Read a turn's result, or undefined if absent/unparseable — what the deleted seam helper did, minus its
 *  provably-unreachable `strict` option. These assertions were always about whether a turn RESOLVES. */
function readTurn(outDir: string, turn: number): unknown | undefined {
  try {
    return JSON.parse(readFileSync(turnArtifactPath(outDir, turn, "result.json"), "utf8"));
  } catch {
    return undefined;
  }
}

// The seam that addresses one turn's artifacts. SINGLE SHAPE: every turn lives under `turns/<N>/` — no
// per-turn name-mangling, no bidirectional legacy fallback. A run dir written before this layout existed
// (or a `--resume` caught mid-migration, leaving `turns/` AND stray root files) is DETECTED by
// `classifyRunDir`, never silently resolved as if it were `turns/1/`.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "turn-layout-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const put = (rel: string, body = "{}") => {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
};

describe("no turns/ directory: never invents a turn or resolves a root/archived file", () => {
  it("an empty dir has no turns", () => {
    expect(listTurns(dir)).toEqual([]);
    expect(latestTurn(dir)).toBeUndefined();
    expect(hasTurnDirs(dir)).toBe(false);
  });

  it("a bare root result.json (the pre-layout shape) is NOT resolved as turn 1", () => {
    // The whole point of the single shape: a pre-layout dir is DETECTED (classifyRunDir), never silently
    // substituted for turns/1/ — that substitution is the defect class this removal exists to eliminate.
    put("result.json", '{"turn":1}');
    expect(listTurns(dir)).toEqual([]);
    expect(turnArtifactPath(dir, 1, "result.json")).toBe(join(dir, "turns", "1", "result.json"));
    expect(readTurn(dir, 1)).toBeUndefined();
  });

  it("a name-mangled archive alone is likewise not resolved", () => {
    put("result.turn-1.json", '{"turn":1}');
    expect(turnArtifactPath(dir, 1, "result.json")).toBe(join(dir, "turns", "1", "result.json"));
    expect(readTurn(dir, 1)).toBeUndefined();
  });
});

describe("per-turn directory layout", () => {
  it("enumerates turns/<N>/ and addresses artifacts inside them", () => {
    put("turns/1/result.json", '{"turn":1}');
    put("turns/2/result.json", '{"turn":2}');
    expect(hasTurnDirs(dir)).toBe(true);
    expect(listTurns(dir)).toEqual([1, 2]);
    expect(turnArtifactPath(dir, 1, "run.jsonl")).toBe(join(dir, "turns", "1", "run.jsonl"));
  });

  it("ignores non-numeric entries with an ANCHORED match", () => {
    // A `parseInt`-style scan reads "2junk" as turn 2, which would shift every turn number in the dir.
    put("turns/1/result.json");
    put("turns/2junk/result.json");
    put("turns/notes.md");
    expect(listTurns(dir)).toEqual([1]);
  });

  it("tolerates a GAP in turn numbers", () => {
    put("turns/1/result.json");
    put("turns/3/result.json");
    expect(listTurns(dir)).toEqual([1, 3]);
    expect(latestTurn(dir)).toBe(3);
  });

  it("a stray root archive next to turns/ does NOT get merged in — that dir is MIXED, not a union", () => {
    put("result.turn-1.json");
    put("turns/1/result.json");
    put("turns/2/result.json");
    expect(listTurns(dir)).toEqual([1, 2]); // from turns/ alone — the root archive is invisible to the seam
    expect(classifyRunDir(dir).kind).toBe("mixed");
  });
});

describe("reading a turn's result", () => {
  it("parses the addressed turn", () => {
    put("turns/1/result.json", '{"turn":1,"marker":"graded"}');
    put("turns/2/result.json", '{"turn":2}');
    expect((readTurn(dir, 1) as { marker?: string })?.marker).toBe("graded");
  });

  it("returns undefined rather than throwing on unreadable/absent", () => {
    put("turns/1/result.json", "{not json");
    expect(readTurn(dir, 1)).toBeUndefined();
    expect(readTurn(dir, 9)).toBeUndefined();
  });
});

describe("graded resolution is by ROLE, not number", () => {
  it("prefers the stable alias critique writes", () => {
    put("result.graded.json", '{"turn":1}');
    put("turns/1/result.json", '{"turn":1}');
    expect(resolveGraded(dir, "result.json")).toBe(join(dir, "result.graded.json"));
  });

  it("falls back to turns/1/ when no alias exists", () => {
    put("turns/1/result.json");
    expect(resolveGraded(dir, "result.json")).toBe(join(dir, "turns", "1", "result.json"));
  });

  it("returns undefined when neither exists", () => {
    expect(resolveGraded(dir, "trace.json")).toBeUndefined();
  });
});

describe("classifyRunDir: the ONLY place the legacy/mixed shape is still named, and only as a detector", () => {
  it("none: neither turns/ nor any pre-layout marker", () => {
    expect(classifyRunDir(dir)).toEqual({ kind: "none" });
  });

  it("turns: turns/ present, no root marker", () => {
    put("turns/1/result.json");
    expect(classifyRunDir(dir)).toEqual({ kind: "turns", turns: [1] });
  });

  it("a root result.json ALONGSIDE turns/ IS a marker — no writer produces a compat copy anymore", () => {
    // execute.ts no longer writes a root result.json compat copy of the latest turn, so a root
    // result.json next to turns/ can only mean a pre-layout dir was resumed under current code (or
    // something else wrote there) — a genuinely MIXED dir, not an ordinary current-layout one.
    put("turns/1/result.json");
    put("result.json", '{"turn":1}');
    const shape = classifyRunDir(dir);
    expect(shape.kind).toBe("mixed");
    expect((shape as { markers: string[] }).markers).toContain("result.json");
  });

  it("legacy: a root result.json/run.jsonl with no turns/", () => {
    put("result.json");
    put("run.jsonl");
    const shape = classifyRunDir(dir);
    expect(shape.kind).toBe("legacy");
    expect((shape as { markers: string[] }).markers.slice().sort()).toEqual(["result.json", "run.jsonl"]);
  });

  it("legacy: a name-mangled archive with no live root file and no turns/", () => {
    put("result.turn-1.json");
    expect(classifyRunDir(dir).kind).toBe("legacy");
  });

  it("mixed: turns/ present AND a root archive — the shape a resumed pre-layout dir actually produces", () => {
    put("result.turn-1.json");
    put("turns/2/result.json");
    const shape = classifyRunDir(dir);
    expect(shape.kind).toBe("mixed");
    expect((shape as { turns: number[] }).turns).toEqual([2]);
    expect((shape as { markers: string[] }).markers).toContain("result.turn-1.json");
  });

  it("mixed: turns/ present AND a root run.jsonl (never written by the current-layout writer)", () => {
    put("turns/1/result.json");
    put("run.jsonl"); // no current writer ever leaves this at the root once turns/ exists
    expect(classifyRunDir(dir).kind).toBe("mixed");
  });

  it('preLayoutMessage names the shape and the markers found, not just "missing"', () => {
    put("result.json");
    const shape = classifyRunDir(dir);
    const msg = preLayoutMessage(shape, dir);
    expect(msg).toContain(dir);
    expect(msg.toLowerCase()).toContain("pre-layout");
    expect(msg).toContain("result.json");
  });

  it("requireTurns returns the turn list for a current-layout dir", () => {
    put("turns/1/result.json");
    put("turns/2/result.json");
    expect(requireTurns(dir, "verify-run")).toEqual([1, 2]);
  });

  it("requireTurns throws LegacyRunDirError naming the command, for legacy/mixed/none alike", () => {
    expect(() => requireTurns(dir, "verify-run")).toThrow(LegacyRunDirError);
    expect(() => requireTurns(dir, "verify-run")).toThrow(/verify-run/);
    put("result.json");
    expect(() => requireTurns(dir, "verify-run")).toThrow(/verify-run/);
    expect(classifyRunDir(dir).kind).toBe("legacy");
  });

  it("mixed: a root RETRY archive is a marker too — the migrator moves it, so a reader must not read the dir as clean", () => {
    // contaminationMarkers and the migrator's ARCHIVE_RE must agree on what a pre-layout marker is. A root
    // `run.turn-1.retry-2.jsonl` is one the migrator plans to move; if the classifier misses it, diff/verify
    // read the dir as clean current-layout instead of refusing and pointing at migrate-run-dir.
    put("turns/1/run.jsonl");
    put("run.turn-1.retry-2.jsonl");
    const shape = classifyRunDir(dir);
    expect(shape.kind).toBe("mixed");
    expect((shape as { markers: string[] }).markers).toContain("run.turn-1.retry-2.jsonl");
  });
});

describe("turnsDirNumbers is a DIRECTORY scan with canonical decimals — a stray file or non-canonical name is not a turn", () => {
  it("a plain FILE named turns/1 is not counted as a turn", () => {
    put("turns/1", "i am a file, not a turn dir");
    expect(listTurns(dir)).toEqual([]);
    expect(classifyRunDir(dir).kind).toBe("none");
  });

  it("a non-canonical turns/01 directory is not silently addressed as turn 1", () => {
    // '01' -> Number 1, but the writer only ever produces String(1) = 'turns/1', so turnArtifactPath(,1,)
    // reads turns/1 — the data in turns/01 would be invisible. Reject the non-canonical spelling outright.
    put("turns/01/run.jsonl");
    put("turns/01/result.json");
    expect(listTurns(dir)).toEqual([]);
  });
});
