import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listTurns, latestTurn, turnArtifactPath, readTurnResult, resolveGraded, hasTurnDirs } from "../src/run/turn-layout.js";

// The seam that will absorb the layout flip. Introduced over TODAY's on-disk shape and tested against it
// first, so the flip becomes a change to one file instead of twenty call sites.
//
// The legacy shape must resolve PERMANENTLY, not transitionally: `chat` writes a root `result.json` and
// never participates in turn bookkeeping, so new chat run dirs are legacy-shaped forever.

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

describe("legacy layout (root = latest turn, earlier turns name-mangled)", () => {
  it("a single-turn dir is turn 1 at the root", () => {
    put("result.json", '{"turn":1}');
    expect(listTurns(dir)).toEqual([1]);
    expect(latestTurn(dir)).toBe(1);
    expect(turnArtifactPath(dir, 1, "result.json")).toBe(join(dir, "result.json"));
  });

  it("a two-turn dir resolves BOTH — root is turn 2, the archive is turn 1", () => {
    put("result.turn-1.json", '{"turn":1}');
    put("result.json", '{"turn":2}');
    expect(listTurns(dir)).toEqual([1, 2]);
    expect(turnArtifactPath(dir, 1, "result.json")).toBe(join(dir, "result.turn-1.json"));
    expect(turnArtifactPath(dir, 2, "result.json")).toBe(join(dir, "result.json"));
  });

  it("addresses SIDECARS by turn too, which a directory-only API could not", () => {
    // The legacy shape has no per-turn directory: earlier turns are name-mangled at the root. An API of
    // only `turnDir(outDir, n)` could not address these at all — the gap that made the first seam design
    // unimplementable.
    put("result.turn-1.json");
    put("result.json");
    expect(turnArtifactPath(dir, 1, "run.jsonl")).toBe(join(dir, "run.turn-1.jsonl"));
    expect(turnArtifactPath(dir, 1, "trace.json")).toBe(join(dir, "trace.turn-1.json"));
    expect(turnArtifactPath(dir, 2, "run.jsonl")).toBe(join(dir, "run.jsonl"));
  });

  it("an empty dir has no turns (does not invent turn 1)", () => {
    expect(listTurns(dir)).toEqual([]);
    expect(latestTurn(dir)).toBeUndefined();
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

  it("prefers turn dirs over any stale legacy archive in the same dir", () => {
    put("result.turn-1.json");
    put("turns/1/result.json");
    put("turns/2/result.json");
    expect(listTurns(dir)).toEqual([1, 2]);
  });
});

describe("reading a turn's result", () => {
  it("parses the addressed turn", () => {
    put("result.turn-1.json", '{"turn":1,"marker":"graded"}');
    put("result.json", '{"turn":2}');
    expect((readTurnResult(dir, 1) as { marker?: string })?.marker).toBe("graded");
  });

  it("returns undefined rather than throwing on unreadable/absent", () => {
    put("result.json", "{not json");
    expect(readTurnResult(dir, 1)).toBeUndefined();
    expect(readTurnResult(dir, 9)).toBeUndefined();
  });

  it("strict mode refuses to substitute the root file for an archived turn", () => {
    // critique's turn-1 isolation depends on this: after a resume the root file is turn 2, and silently
    // substituting it would contaminate turn-1-only evidence.
    put("result.json", '{"turn":1}');
    expect(readTurnResult(dir, 1), "non-strict may use the root file").toBeDefined();
    expect(readTurnResult(dir, 1, { strict: true }), "strict must not substitute the root file").toBeUndefined();
  });
});

describe("graded resolution is by ROLE, not number", () => {
  it("prefers the stable alias critique writes", () => {
    put("result.graded.json", '{"turn":1}');
    put("result.turn-1.json", '{"turn":1}');
    put("result.json", '{"turn":2}');
    expect(resolveGraded(dir, "result.json")).toBe(join(dir, "result.graded.json"));
  });

  it("falls back to turn 1 when no alias exists", () => {
    put("result.turn-1.json");
    put("result.json");
    expect(resolveGraded(dir, "result.json")).toBe(join(dir, "result.turn-1.json"));
  });

  it("returns undefined when neither exists", () => {
    expect(resolveGraded(dir, "trace.json")).toBeUndefined();
  });
});
