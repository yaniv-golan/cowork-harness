import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Every caller of the turn-layout helpers has a decided disposition for a multi-leg run dir. The helpers throw
// MultiLegRunDirError on a legs root or an action leg (test/multi-leg-layout.test.ts), so a caller is safe if it
// either lets that throw out or branches on the shape first. This pins the caller set: a NEW caller reds here until
// someone decides what it does with a multi-leg dir and adds it below. A caller that wraps a helper in a catch must
// let the multi-leg error through, which the second test checks for the callers known to catch.

const HELPERS =
  /\b(requireTurns|classifyRunDir|listTurns|currentTurnFromDirs|turnArtifactPath|turnWriteDir|latestTurn|hasTurnDirs|resolveGraded|gradedAliasPath|currentTurnEventLines)\(/;

/** caller file → its disposition for a multi-leg dir (the plan's reader table). */
const DISPOSITIONS: Record<string, string> = {
  "src/cli.ts": "routes RunDirShapeError as runtime; diff refuses a root; inspect refuses a root; trace footer reads a leg dir",
  "src/critique/command.ts": "n/a: writes and reads its own single-session dirs",
  "src/critique/evidence.ts": "n/a: its own single-session dirs",
  "src/critique/package-evidence.ts": "n/a: its own single-session dirs",
  "src/eval/job-runner.ts": "unreachable (eval refuses legs); the helper throw propagates",
  "src/eval/plan-history.ts": "excludes multiLeg index rows before any read",
  "src/fixture/export.ts": "refuses a root (requireTurns); a leg resolves its tree through legTreeRoot",
  "src/fixture/workspace.ts": "re-throws MultiLegRunDirError from its catch",
  "src/hillclimb/freeze-ref.ts": "re-throws MultiLegRunDirError (not a hillclimb row)",
  "src/hillclimb/regrade.ts": "re-throws MultiLegRunDirError (not a hillclimb row)",
  "src/hillclimb/result-event.ts": "per-leg events lines by construction",
  "src/hillclimb/served-model.ts": "per-leg events lines by construction",
  "src/refs/compose.ts": "shape pre-check before its try: refused as a reference",
  "src/run/chat.ts": "n/a: writer of its own single-session dirs",
  "src/run/execute.ts": "the writer",
  "src/run/inspect-view.ts": "requireTurns refuses a root; a leg dir is unchanged",
  "src/run/latest-run.ts": "branches on the legs shape before latestTurn",
  "src/run/migrate-run-dir.ts": "no-op on legs / action-leg before any listTurns",
  "src/run/recorded-agent-version.ts": "per-leg events lines by construction",
  "src/run/regrade.ts": "through assertContextFromRunDir: refuses a root and a non-final persistent leg",
  "src/run/renderer.ts": "writer side: prints leg paths",
  "src/run/run-index.ts": "legs arm before listTurns: one roll-up row",
  "src/run/run-labels.ts": "legs arm before latestTurn, never throws",
  "src/run/runs-gc.ts": "legs evidence counts as a real run",
  "src/run/scaffold.ts": "requireTurns refuses a root",
  "src/run/trace-view.ts": "resolveEventsFile refuses a multi-leg candidate; a leg dir is unchanged",
  "src/run/verify-context.ts": "requireTurns refuses a root; legTreeRoot refuses a non-final persistent leg",
  "src/runtime/image-capabilities.ts": "per-leg events lines by construction",
  "src/search-corpus/harvest.ts": "resolveGraded throws on a multi-leg root, so search-pool build stops loudly; a leg dir reads as a run",
};

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("multi-leg: every turn-layout caller has a disposition", () => {
  it("the caller set is exactly the pinned one", () => {
    const callers = tsFiles("src")
      .map((p) => relative(".", p))
      .filter((p) => p !== "src/run/turn-layout.ts" && p !== "src/run/turn-events.ts")
      .filter((p) => HELPERS.test(readFileSync(p, "utf8")))
      .sort();
    expect(callers).toEqual(Object.keys(DISPOSITIONS).sort());
  });

  it("the callers that catch a helper's throw let MultiLegRunDirError out", () => {
    for (const f of ["src/fixture/workspace.ts", "src/hillclimb/freeze-ref.ts", "src/hillclimb/regrade.ts"]) {
      expect(readFileSync(f, "utf8"), f).toMatch(/instanceof MultiLegRunDirError\)/);
    }
    // compose turns its catch into a refusal, so it must classify BEFORE the try.
    const compose = readFileSync("src/refs/compose.ts", "utf8");
    expect(compose.indexOf("classifyRunDir(runDir)")).toBeLessThan(compose.indexOf("latestTurn(runDir)"));
  });
});
