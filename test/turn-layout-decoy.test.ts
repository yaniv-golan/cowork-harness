import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLatestRunForScenario } from "../src/run/latest-run.js";
import { indexRowFromResult, reindexFromRunsTree } from "../src/run/run-index.js";
import { buildInspectView } from "../src/run/inspect-view.js";
import { packageEvidence } from "../src/critique/package-evidence.js";
import { buildFilesView, buildUsageView } from "../src/run/trace-view.js";
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
  // A real gate event, so `buildGateTrace` has a row to annotate. With an empty stream there are no rows,
  // the provenance pairing has nothing to attach to, and that probe cannot fail however wrong the reader is.
  writeFileSync(
    join(d, "events.jsonl"),
    JSON.stringify({ _emu: "gate", kind: "question", requestId: "req-decoy", question: "q?", options: ["a", "b"] }) + "\n",
  );
  writeFileSync(join(d, "status.json"), JSON.stringify({ startedAt: "2026-07-20T10:00:00.000Z" }));

  // The decoys: every shape a pre-layout dir could present at the root.
  // The decoy must be a WELL-FORMED RunResult, and the sentinel must sit in fields each reader actually
  // renders. Both halves are load-bearing and both have failed here before:
  //   - a payload missing `assertions` (required; computeVerdict iterates it unconditionally) made every
  //     reader THROW on it, and run-index swallows that as "corrupt" — so no root read could ever surface
  //     the sentinel however wrong the reader was;
  //   - a sentinel sitting only in `scenario` was invisible to packageEvidence, which never renders it.
  // A probe that cannot observe is worse than no probe: it reports coverage it does not have.
  const decoy = JSON.stringify({
    // The schema's required set — scenario/fidelity/baseline/result/decisions/egress/assertions/outDir.
    // Omitting any of them makes a reader throw, and run-index swallows that as "corrupt": the sentinel
    // then cannot surface however wrong the reader is.
    fidelity: "container",
    baseline: "latest",
    egress: [],
    outDir: d,
    scenario: SENTINEL,
    result: "failure",
    verdict: { pass: false, exitCode: 1, failures: [{ message: SENTINEL }] },
    assertions: [{ assertion: { kind: SENTINEL }, pass: false, message: SENTINEL }],
    finalMessage: SENTINEL,
    referencesRead: [SENTINEL],
    toolCounts: { [SENTINEL]: 1 },
    decisions: [{ kind: "question", decision: "answered", requestId: "req-decoy", by: SENTINEL, question: SENTINEL, answer: SENTINEL }],
    // A Record, not an array: `buildUsageView` renders Object.entries KEYS, so an array puts "0" in the
    // output and the sentinel — sitting in a value — becomes structurally unrenderable.
    modelUsage: { [SENTINEL]: { costUSD: 1, inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 1, cacheCreationInputTokens: 0 } },
    workspaceFiles: [{ path: SENTINEL, bytes: 1 }],
    turn: 1,
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

  it("reindexFromRunsTree SKIPS a poisoned dir whole rather than half-indexing it", () => {
    // Honest name. With the removal complete, any root per-turn artifact makes a dir `mixed`, so
    // run-index's protection is the whole-dir skip — the walk never runs. The previous name claimed it
    // "indexes the turn, never the root decoy"; it indexed NOTHING and asserted only sentinel-absence,
    // which a skip satisfies trivially. Assert the actual protection instead.
    poisonedDir();
    const { rows, written, skippedLegacy } = reindexFromRunsTree(root);
    expect(skippedLegacy, "the poisoned (mixed) dir was not reported as skipped").toBe(1);
    expect(written, "half-indexed a dir it cannot fully read").toBe(0);
    expect(JSON.stringify(rows), "a root/archived file was indexed").not.toContain(SENTINEL);
  });

  it("a turns-only dir DOES index from turns/ — otherwise the skip above proves nothing", () => {
    // Pairs with the skip: without this, "0 rows" would be indistinguishable from a reader that indexes
    // nothing at all.
    const d = join(root, "clean", "sess-1");
    mkdirSync(join(d, "turns", "1"), { recursive: true });
    writeFileSync(
      join(d, "turns", "1", "result.json"),
      JSON.stringify({
        scenario: "clean",
        fidelity: "container",
        baseline: "latest",
        result: "success",
        decisions: [],
        egress: [],
        assertions: [],
        outDir: d,
        turn: 1,
        verdict: { pass: true, exitCode: 0, failures: [] },
      }),
    );
    writeFileSync(join(d, "turns", "1", "run.jsonl"), `{"t":"transcript"}`);
    const { written } = reindexFromRunsTree(root);
    expect(written, "a clean turns dir produced no row — the skip assertion above would be vacuous").toBeGreaterThan(0);
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

  // NOT PROBED, DELIBERATELY: `buildGateTrace`'s provenance pairing. Its rows come from `decision`
  // protocol frames, which this fixture cannot synthesise, so a probe here would assert "sentinel absent"
  // against an empty row set — blind, and claiming coverage it does not have. That is the exact defect
  // this file has now shipped three times, so it is recorded as a gap rather than papered over. The path
  // is covered positively by trace.test.ts's gate-provenance tests; what is missing is the
  // prefer-turn-fall-back-to-root regression, which those cannot see.
  //
  // `trace`'s readers are UNGATED by design — trace must keep working on a pre-layout dir, which is why
  // every other refusal points at it. That makes them the same risk profile as packageEvidence: no
  // refusal fires first to mask a root read. Each site's own comment records that a pre-seam root read
  // here was "guard-invisible".
  for (const [name, build] of [
    ["buildFilesView (--view files)", buildFilesView],
    ["buildUsageView (--view usage)", buildUsageView],
  ] as const) {
    it(`${name} never surfaces the root decoy`, () => {
      const d = poisonedDir();
      let observed: string;
      try {
        observed = JSON.stringify(build(join(d, "events.jsonl")));
      } catch (e) {
        observed = (e as Error).message;
      }
      expect(observed, `a root file surfaced through ${name}`).not.toContain(SENTINEL);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // THE META-GUARD. Every probe above asserts "the sentinel does NOT appear". That assertion is
  // satisfied just as well by a probe that can never see the sentinel at all — and three separate
  // probes here have shipped in exactly that state: one with the sentinel in a field the reader never
  // renders, one whose payload THREW inside the reader (swallowed as "corrupt"), and one whose
  // `modelUsage` was an array where the reader renders Record KEYS.
  //
  // Asserting the bytes are on disk cannot catch any of those. So prove OBSERVABILITY directly: plant the
  // decoy where each reader LEGITIMATELY looks, and require the sentinel to come back out. If it does,
  // that reader can surface decoy content — so the probe above genuinely tests something.
  describe("every probe can actually observe (else its not-found assertion is vacuous)", () => {
    /** The decoy content, planted at the turn location each reader is supposed to read. */
    function legitimatelyPlanted(): string {
      const d = poisonedDir();
      // Overwrite the REAL turn artifact with decoy content: a correct reader must now surface it.
      writeFileSync(join(d, "turns", "1", "result.json"), readFileSync(join(d, "result.json"), "utf8"));
      return d;
    }

    it("indexRowFromResult renders it", () => {
      const d = legitimatelyPlanted();
      const raw = JSON.parse(readFileSync(join(d, "turns", "1", "result.json"), "utf8")) as Parameters<typeof indexRowFromResult>[0];
      expect(JSON.stringify(indexRowFromResult(raw, { command: "run", partial: false }))).toContain(SENTINEL);
    });

    it("packageEvidence renders it", () => {
      const d = legitimatelyPlanted();
      const skillDir = mkdtempSync(join(tmpdir(), "decoy-skill-obs-"));
      writeFileSync(join(skillDir, "SKILL.md"), "---\nname: d\ndescription: d\n---\nbody\n");
      expect(JSON.stringify(packageEvidence(d, snapshotTurnBoundary(d), skillDir, true))).toContain(SENTINEL);
      rmSync(skillDir, { recursive: true, force: true });
    });

    it("buildFilesView renders it", () => {
      const d = legitimatelyPlanted();
      expect(JSON.stringify(buildFilesView(join(d, "events.jsonl")))).toContain(SENTINEL);
    });

    it("buildUsageView renders it", () => {
      const d = legitimatelyPlanted();
      expect(JSON.stringify(buildUsageView(join(d, "events.jsonl"))), "modelUsage shape is unrenderable — this probe is blind").toContain(
        SENTINEL,
      );
    });

    it("findLatestRunForScenario renders it", () => {
      const d = legitimatelyPlanted();
      // Remove the root markers so the dir is `turns`-shaped and the refusal does not pre-empt the read.
      for (const f of ["result.json", "run.jsonl", "result.turn-1.json", "run.turn-1.jsonl"]) rmSync(join(d, f), { force: true });
      expect(JSON.stringify(findLatestRunForScenario(root, "scn") ?? {})).toContain(SENTINEL);
    });
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
