import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLatestRunForScenario } from "../src/run/latest-run.js";
import { reindexFromRunsTree } from "../src/run/run-index.js";
import { buildInspectView } from "../src/run/inspect-view.js";
import { packageEvidence } from "../src/critique/package-evidence.js";
import { snapshotTurnBoundary } from "../src/critique/evidence.js";

// LAYER 2 OF THE SINGLE-SOURCE GUARD: assert RESOLVED BEHAVIOUR, not source shape.
//
// The static scan (turn-layout-single-source.test.ts) matches a line that names an artifact while building
// a path. It structurally cannot see the form both REAL escapes took: a candidates array on one line and
// `join(outDir, f)` on another, so neither line has both halves. run-index probed
// `/^result\.turn-\d+\.json$/` against readdir entries; critique/evidence.ts iterated
// `["result.turn-1.json", "result.json"]`. No shape matcher catches those without also flagging every
// message string that names a file.
//
// So poison the root. A dir with real `turns/` content AND sentinel-bearing root files is a directory
// where any reader that still prefers, or falls back to, the run-dir root will surface a value that cannot
// come from anywhere else. The sentinel is the whole point: a reader reading nothing looks identical to a
// reader reading correctly, but a reader reading the ROOT is unmistakable.
//
// The two layers have deliberately complementary blind spots. This one cannot see a reader that resolves
// to nothing (that is what C4's per-command refusal tests cover); the static one cannot see a split-line
// probe. Neither closes the class alone, and claiming either does is how the previous guard got trusted
// past its reach.

const SENTINEL = "DECOY-ROOT-VALUE-MUST-NEVER-SURFACE";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "decoy-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A CURRENT-layout dir whose root is poisoned with pre-layout files a correct reader must never touch. */
function poisonedDir(scenario = "scn", id = "sess-1"): string {
  const d = join(root, scenario, id);
  mkdirSync(join(d, "turns", "1"), { recursive: true });

  const realResult = JSON.stringify({ scenario, result: "success", turn: 1, verdict: { pass: true } });
  writeFileSync(join(d, "turns", "1", "result.json"), realResult);
  writeFileSync(join(d, "turns", "1", "run.jsonl"), `{"t":"transcript","text":"real turn content"}`);
  writeFileSync(join(d, "events.jsonl"), "");
  writeFileSync(join(d, "status.json"), JSON.stringify({ startedAt: "2026-07-20T10:00:00.000Z" }));

  // The decoys: every shape a pre-layout dir could present at the root.
  // The sentinel is placed in several fields on purpose: each reader surfaces a different slice, and a
  // probe whose sentinel sits in a field that reader never renders passes while observing nothing —
  // which is exactly how the critique probe below first passed against a reintroduced escape.
  const decoy = JSON.stringify({
    scenario: SENTINEL,
    result: "failure",
    verdict: { pass: false },
    finalMessage: SENTINEL,
    referencesRead: [SENTINEL],
    toolCounts: { [SENTINEL]: 1 },
  });
  writeFileSync(join(d, "result.json"), decoy);
  writeFileSync(join(d, "run.jsonl"), `{"t":"transcript","text":"${SENTINEL}"}`);
  writeFileSync(join(d, "result.turn-1.json"), decoy);
  writeFileSync(join(d, "run.turn-1.jsonl"), `{"t":"transcript","text":"${SENTINEL}"}`);
  return d;
}

describe("no reader falls back to the run-dir root", () => {
  it("findLatestRunForScenario never surfaces the root decoy — it refuses instead", () => {
    // Refusing IS the right outcome here: a poisoned dir is genuinely `mixed`, and the earliest turn of a
    // real mixed dir is unaddressable. What this guard forbids is the decoy's content coming back as if it
    // were the run's — refusal and correct-read both satisfy that; only a root read fails it.
    poisonedDir();
    let observed: string;
    try {
      observed = JSON.stringify(findLatestRunForScenario(root, "scn") ?? {});
    } catch (e) {
      observed = (e as Error).message;
    }
    expect(observed, "a root file surfaced through status --latest-for").not.toContain(SENTINEL);
  });

  it("reindexFromRunsTree indexes the turn, never the root decoy", () => {
    poisonedDir();
    const { rows } = reindexFromRunsTree(root);
    expect(JSON.stringify(rows), "a root/archived file was indexed").not.toContain(SENTINEL);
  });

  it("buildInspectView renders the turn, never the root decoy", () => {
    const d = poisonedDir();
    // A poisoned dir is genuinely `mixed`, so refusing is a correct outcome too — what must NOT happen is
    // rendering the decoy's content as if it were the run's.
    let rendered = "";
    try {
      rendered = JSON.stringify(buildInspectView(d));
    } catch (e) {
      rendered = (e as Error).message;
    }
    expect(rendered, "a root file surfaced through inspect").not.toContain(SENTINEL);
  });

  it("packageEvidence reads the TURN, never the root decoy — the reader a real escape lived in", () => {
    // THE MOST IMPORTANT PROBE IN THIS FILE. One of the two real historic escapes was in
    // critique/evidence.ts: `["result.turn-1.json", "result.json"]` on one line, `join(outDir, f)` on the
    // next. Reintroducing it verbatim was invisible to BOTH guard layers and to all 212 critique tests —
    // the static scan cannot see a split-line probe, and this file previously drove only three readers,
    // none of them critique's. `packageEvidence` is also UNGATED (critique must keep working), so unlike
    // diff/inspect no refusal fires first to mask a root read.
    const d = poisonedDir();
    const skillDir = mkdtempSync(join(tmpdir(), "decoy-skill-"));
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: d\ndescription: d\n---\nbody\n");
    const pkg = packageEvidence(d, snapshotTurnBoundary(d), skillDir, true);
    expect(JSON.stringify(pkg), "a root/archived file surfaced through critique's evidence package").not.toContain(SENTINEL);
    rmSync(skillDir, { recursive: true, force: true });
  });

  it("the decoys are actually readable — otherwise this whole file passes vacuously", () => {
    // Guards the guard: if the fixture stopped writing decoys, every assertion above would pass while
    // testing nothing at all.
    const d = poisonedDir();
    const { readFileSync, existsSync } = require("node:fs") as typeof import("node:fs");
    for (const f of ["result.json", "run.jsonl", "result.turn-1.json", "run.turn-1.jsonl"]) {
      expect(existsSync(join(d, f)), `decoy ${f} was not written`).toBe(true);
      expect(readFileSync(join(d, f), "utf8"), `decoy ${f} carries no sentinel`).toContain(SENTINEL);
    }
  });
});
