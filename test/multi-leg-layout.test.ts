import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listTurns,
  latestTurn,
  resolveGraded,
  hasTurnDirs,
  classifyRunDir,
  requireTurns,
  currentTurnFromDirs,
  preLayoutMessage,
  legDirsOf,
  readLegMarker,
} from "../src/run/turn-layout.js";
import { LegacyRunDirError, MultiLegRunDirError, RunDirShapeError } from "../src/errors.js";

// A multi-leg run dir: the scenario root holds `legs/<id>/`, each a complete single-session run dir (a prompt leg)
// or an action record (a host-action leg). Its SHAPE comes from the `leg.json` markers, written before each leg
// starts, so an in-flight or crashed root is already `legs` — `scenario-result.json` only marks completion.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "multi-leg-layout-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const put = (rel: string, body = "{}") => {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
};
const leg = (id: string, index: number, kind: "prompt" | "action") =>
  put(`legs/${id}/leg.json`, JSON.stringify({ scenarioRoot: "../..", id, index, kind, workdir: "persistent" }));

describe("classifyRunDir: the legs shape", () => {
  it("is `legs` from the first leg.json on, complete only once scenario-result.json exists", () => {
    put("status.json");
    leg("ask", 0, "prompt");
    expect(classifyRunDir(dir)).toEqual({ kind: "legs", legs: ["ask"], complete: false });
    leg("apply", 1, "action");
    leg("resume", 2, "prompt");
    // ordered by the leg's index, not by name
    expect(classifyRunDir(dir)).toEqual({ kind: "legs", legs: ["ask", "apply", "resume"], complete: false });
    put("scenario-result.json");
    expect(classifyRunDir(dir)).toEqual({ kind: "legs", legs: ["ask", "apply", "resume"], complete: true });
  });

  it("a legs/ dir with no leg.json marker is not a legs root", () => {
    mkdirSync(join(dir, "legs", "ask"), { recursive: true });
    expect(classifyRunDir(dir)).toEqual({ kind: "none" });
  });

  it("a legs root that also holds root turns/ or pre-layout markers is mixed (refused)", () => {
    leg("ask", 0, "prompt");
    put("turns/1/run.jsonl", "");
    const shape = classifyRunDir(dir);
    expect(shape.kind).toBe("mixed");
    if (shape.kind === "mixed") expect(shape.markers).toContain("legs/");
  });

  it("an action leg dir is `action-leg`; a prompt leg dir is an ordinary turns dir", () => {
    leg("apply", 1, "action");
    expect(classifyRunDir(join(dir, "legs", "apply"))).toEqual({ kind: "action-leg" });
    leg("ask", 0, "prompt");
    put("legs/ask/turns/1/run.jsonl", "");
    put("legs/ask/turns/1/result.json");
    expect(classifyRunDir(join(dir, "legs", "ask"))).toEqual({ kind: "turns", turns: [1] });
  });

  it("legDirsOf ignores ids outside the grammar and non-directories", () => {
    leg("ask", 0, "prompt");
    put("legs/..x/leg.json", "{}");
    put("legs/stray-file", "x");
    expect(legDirsOf(dir).map((l) => l.id)).toEqual(["ask"]);
    expect(readLegMarker(join(dir, "legs", "ask"))?.kind).toBe("prompt");
  });
});

describe("the turn helpers fail closed on a multi-leg root or an action leg", () => {
  // Today these return []/undefined/false on a dir with no turns/ — the silent "read nothing" a caller would
  // mistake for an empty run. On a legs root they must throw, so every caller that was not taught the shape is loud.
  const helpers: Array<[string, (d: string) => unknown]> = [
    ["listTurns", listTurns],
    ["latestTurn", latestTurn],
    ["hasTurnDirs", hasTurnDirs],
    ["resolveGraded", (d) => resolveGraded(d, "result.json")],
    ["currentTurnFromDirs", currentTurnFromDirs],
    ["requireTurns", (d) => requireTurns(d, "probe")],
  ];

  for (const [name, fn] of helpers) {
    it(`${name} throws MultiLegRunDirError on a complete legs root`, () => {
      leg("ask", 0, "prompt");
      put("scenario-result.json");
      expect(() => fn(dir)).toThrow(MultiLegRunDirError);
    });
    it(`${name} throws MultiLegRunDirError on an in-flight legs root`, () => {
      leg("ask", 0, "prompt");
      expect(() => fn(dir)).toThrow(/has not finished/);
    });
    it(`${name} throws MultiLegRunDirError on an action leg`, () => {
      leg("apply", 1, "action");
      expect(() => fn(join(dir, "legs", "apply"))).toThrow(/host-action leg/);
    });
    it(`${name} still works on a prompt leg dir`, () => {
      leg("ask", 0, "prompt");
      put("legs/ask/turns/1/run.jsonl", "");
      put("legs/ask/turns/1/result.json");
      expect(() => fn(join(dir, "legs", "ask"))).not.toThrow();
    });
  }

  it("the error is a RunDirShapeError, and so is LegacyRunDirError (one routing branch covers both)", () => {
    leg("ask", 0, "prompt");
    let caught: unknown;
    try {
      listTurns(dir);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RunDirShapeError);
    expect(new LegacyRunDirError("x")).toBeInstanceOf(RunDirShapeError);
  });

  it("the messages name the legs and the way forward", () => {
    leg("ask", 0, "prompt");
    leg("resume", 2, "prompt");
    put("scenario-result.json");
    expect(() => requireTurns(dir, "inspect")).toThrow(
      `inspect: ${dir} is a multi-leg run dir (legs: ask, resume). inspect reads one agent session; point it at ` +
        `${join(dir, "legs")}/<id> for a prompt leg, or see ${join(dir, "scenario-result.json")} for the scenario verdict.`,
    );
    expect(preLayoutMessage(classifyRunDir(dir), dir)).toContain("multi-leg run dir (legs: ask, resume)");
  });
});
