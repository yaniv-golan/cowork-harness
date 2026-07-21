import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeScenario, parseScenarioFile, beginTurn } from "../src/run/execute.js";
import { ResourceSampler, foldResources } from "../src/runtime/resource-sampler.js";
import { turnArtifactPath } from "../src/run/turn-layout.js";

// THE GAP THIS CLOSES.
//
// Every other test in this feature FABRICATES a run directory and then asserts about it. That is why the
// layout shipped with resource telemetry DEAD on every live sandboxed run: the sampler opened
// `turns/<N>/resources.jsonl` at run start, nothing created that directory until post-run, every sample
// threw ENOENT into a swallowed warning — and not one unit test noticed, because none of them ever drove
// the real startup ordering.
//
// A fabricated directory cannot catch a writer that never writes. These drive the real code.

let runsRoot: string;
let prevRunsDir: string | undefined;
beforeEach(() => {
  prevRunsDir = process.env.COWORK_HARNESS_RUNS_DIR;
  runsRoot = mkdtempSync(join(tmpdir(), "layout-e2e-"));
  process.env.COWORK_HARNESS_RUNS_DIR = runsRoot;
});
afterEach(() => {
  if (prevRunsDir === undefined) delete process.env.COWORK_HARNESS_RUNS_DIR;
  else process.env.COWORK_HARNESS_RUNS_DIR = prevRunsDir;
  rmSync(runsRoot, { recursive: true, force: true });
});

/** A `protocol`-tier scenario: no real agent binary spawns, so this is token-free and needs no Docker.
 *  It still drives the REAL executeScenario startup/teardown, which is the whole point — and that takes
 *  longer than vitest's 5s default, hence the explicit per-test timeouts below. */
function protocolScenario(name: string) {
  const dir = mkdtempSync(join(tmpdir(), "layout-scn-"));
  const f = join(dir, `${name}.yaml`);
  writeFileSync(f, `name: ${name}\nbaseline: latest\nsession: (inline)\nfidelity: protocol\nprompt: hi\n`);
  return parseScenarioFile(f);
}

/** Same idea, but the session mounts a real folder — `--session-id`/`--resume`'s cross-project guard
 *  treats an inline (sourceless) session as UNCONFIRMABLE and refuses to resume it at all (fail closed),
 *  so a resume test needs a session the guard can actually confirm. */
function sourcedProtocolScenario(name: string) {
  const src = mkdtempSync(join(tmpdir(), "layout-resume-src-"));
  writeFileSync(join(src, "f.txt"), "x");
  const dir = mkdtempSync(join(tmpdir(), "layout-resume-scn-"));
  writeFileSync(join(dir, "s.yaml"), `folders:\n  - from: ${src}\n`);
  const f = join(dir, `${name}.yaml`);
  writeFileSync(f, `name: ${name}\nbaseline: latest\nsession: ./s.yaml\nfidelity: protocol\nprompt: hi\n`);
  return parseScenarioFile(f);
}

describe("a REAL run produces the per-turn layout on disk", () => {
  it("writes turns/1/ with the per-turn artifacts, and NO root compat copy", async () => {
    const res = await executeScenario(protocolScenario("e2e-layout"), {});
    const outDir = res.outDir;

    const turn1 = join(outDir, "turns", "1");
    expect(existsSync(turn1), `no turns/1 in a real run dir — root held: ${readdirSync(outDir).join(", ")}`).toBe(true);
    for (const a of ["result.json", "run.jsonl", "trace.json"]) {
      expect(existsSync(join(turn1, a)), `turns/1/${a} was not written by a real run`).toBe(true);
    }

    // The compat copy is gone: turns/1/result.json is the ONLY copy. A resurrected root write would make
    // every reader that now goes through the seam silently start reading the wrong (root/stale) file again
    // on the next turn.
    expect(existsSync(join(outDir, "result.json")), "a root compat copy reappeared — it must not").toBe(false);
  }, 60_000);

  it("leaves the cumulative streams and session state at the ROOT, not inside turns/", async () => {
    // These must not move: `critique`'s turn-1 isolation proof records byte offsets into events.jsonl and
    // timeline.jsonl, and `cassette.events` is events.jsonl verbatim.
    const res = await executeScenario(protocolScenario("e2e-streams"), {});
    const outDir = res.outDir;
    for (const f of ["events.jsonl", "timeline.jsonl", "status.json"]) {
      expect(existsSync(join(outDir, f)), `${f} must stay at the run-dir root`).toBe(true);
    }
    expect(existsSync(join(outDir, "turns", "1", "events.jsonl")), "events.jsonl must NOT be per-turn").toBe(false);
  }, 60_000);

  it("a single-turn run has exactly one turn dir", async () => {
    const res = await executeScenario(protocolScenario("e2e-single"), {});
    const outDir = res.outDir;
    expect(readdirSync(join(outDir, "turns")).sort()).toEqual(["1"]);
  }, 60_000);
});

describe("a REAL two-turn resume — the actual path both shipped defects lived in", () => {
  // Every other test in this suite (and every fabricated-dir test elsewhere) drives at most ONE turn.
  // Both shipped defects — turn 1 unaddressable on a mixed dir, and `currentTurn` going BACKWARDS
  // (2 -> 1) on a resume — are RESUME-path defects, so a single-turn e2e cannot catch either. This drives
  // `executeScenario` twice against the SAME session dir, the only way to exercise beginTurn/currentTurn's
  // resume arithmetic and the seam's addressing of more than one turn for real.
  it("turns/1 and turns/2 both hold all four artifacts, turn numbers strictly increase, and turn 1's events.jsonl prefix is untouched", async () => {
    const scenario = sourcedProtocolScenario("e2e-resume");

    const first = await executeScenario(scenario, { sessionId: "e2e-resume-1" });
    const outDir = first.outDir;
    expect(first.turn, "a fresh single-shot run must be turn 1").toBe(1);

    const eventsBeforeResume = readFileSync(join(outDir, "events.jsonl"), "utf8");

    const second = await executeScenario(scenario, { sessionId: "e2e-resume-1", resume: true });
    expect(second.outDir, "a resume must reuse the same run dir, not mint a new one").toBe(outDir);
    expect(second.turn, "turn number went backwards or failed to advance on resume").toBe(2);

    for (const turn of [1, 2]) {
      for (const a of ["result.json", "run.jsonl", "trace.json"]) {
        const p = join(outDir, "turns", String(turn), a);
        expect(existsSync(p), `turns/${turn}/${a} missing after a real resume`).toBe(true);
      }
    }

    // The critique turn-1 isolation proof (snapshotTurnBoundary/verifyBoundaryIntegrity) depends on this:
    // turn 1's bytes must be a stable PREFIX of the cumulative events.jsonl after any later turn appends.
    const eventsAfterResume = readFileSync(join(outDir, "events.jsonl"), "utf8");
    expect(
      eventsAfterResume.startsWith(eventsBeforeResume),
      "turn 1's byte prefix in events.jsonl changed after a resume — this breaks critique's boundary proof",
    ).toBe(true);
    expect(eventsAfterResume.length, "a resume must only ever APPEND to events.jsonl").toBeGreaterThan(eventsBeforeResume.length);

    // The defect this whole removal targets: a resumed dir minting a root compat copy (or any root
    // artifact) alongside turns/ would make it MIXED — turn 1 unaddressable — right where the bug lived.
    for (const a of ["result.json", "run.jsonl", "trace.json"]) {
      expect(existsSync(join(outDir, a)), `a root ${a} reappeared after resume — the dir is now MIXED`).toBe(false);
    }
  }, 60_000);
});

describe("the sampler can actually WRITE where beginTurn puts it", () => {
  // The precise mechanism of the dead-telemetry bug: turn-aware addressing with no directory to write
  // into. Driving the two real components together catches it without a container — the e2e run above
  // cannot, because the sampler only runs at container/hostloop/microvm tiers.
  it("samples land in turns/<N>/resources.jsonl and fold back out", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "sampler-"));
    const turn = beginTurn(outDir);
    const s = new ResourceSampler(outDir, "container", async () => ({ ts: Date.now(), rssBytes: 4242 }), 5, turn);
    s.start();
    await new Promise((r) => setTimeout(r, 40));
    await s.stop();

    const path = join(outDir, "turns", String(turn), "resources.jsonl");
    expect(existsSync(path), "the sampler wrote nothing — beginTurn did not create the dir it opens").toBe(true);
    expect(foldResources(outDir, "container", 5, undefined, turn)?.peakRssBytes).toBe(4242);
    rmSync(outDir, { recursive: true, force: true });
  });

  it("a retried turn does not fuse its samples with the crashed attempt's", async () => {
    // The sampler APPENDS, and a retry reuses its own turn dir.
    const outDir = mkdtempSync(join(tmpdir(), "sampler-retry-"));
    const turn = beginTurn(outDir);
    for (const rss of [900_000_000, 1_000]) {
      const s = new ResourceSampler(outDir, "container", async () => ({ ts: Date.now(), rssBytes: rss }), 5, turn);
      s.start();
      await new Promise((r) => setTimeout(r, 40));
      await s.stop();
    }
    expect(foldResources(outDir, "container", 5, undefined, turn)?.peakRssBytes, "the crashed attempt's peak leaked into the retry").toBe(
      1_000,
    );
    rmSync(outDir, { recursive: true, force: true });
  });
});

describe("resuming a PRE-LAYOUT dir does not destroy the prior turn", () => {
  // The shape every published-1.6.0 run dir has on disk: the four artifacts at the root, no `turns/`.
  // A user upgrading to the per-turn layout and resuming an existing session hits exactly this path.
  //
  // The prior turn used to be DESTROYED here: `archivePriorTurnFiles` exists to prevent it and could
  // never fire (it runs POST-run, by which point `beginTurn` has created `turns/<N>` and its
  // `!hasTurnDirs` gate is permanently false), so the turn-2 compat write overwrote turn 1's root
  // `result.json`. That is fixed on the base branch by relocating into `turns/<prior>/` at turn start.
  //
  // ON THIS BRANCH the contract is different and STRONGER: the resume is REFUSED outright, before any
  // spawn and before `beginTurn` runs, so the relocation is unreachable here by construction. What must
  // be proven is therefore not "turn 1 survives relocation" but "the dir is not touched AT ALL" —
  // refusing is what makes the pre-layout population safe until `migrate-run-dir` converts it.
  function deShapeToLegacy(outDir: string): void {
    for (const a of ["result.json", "run.jsonl", "trace.json", "resources.jsonl"]) {
      const from = join(outDir, "turns", "1", a);
      if (existsSync(from)) renameSync(from, join(outDir, a));
    }
    rmSync(join(outDir, "turns"), { recursive: true, force: true });
  }

  it("refuses the resume and leaves every byte of the prior turn untouched", async () => {
    const scn = sourcedProtocolScenario("e2e-prelayout-resume");
    const first = await executeScenario(scn, { sessionId: "prelayout-1" });
    const outDir = first.outDir;

    deShapeToLegacy(outDir);
    expect(existsSync(join(outDir, "turns")), "fixture is not the pre-layout shape").toBe(false);
    const artifacts = ["result.json", "run.jsonl", "trace.json"];
    const before: Record<string, string> = {};
    for (const a of artifacts) before[a] = readFileSync(join(outDir, a), "utf8");
    const rootBefore = readdirSync(outDir).sort();

    await expect(
      executeScenario(scn, { sessionId: "prelayout-1", resume: true }),
      "a pre-layout dir must be refused, not silently resumed into a mixed shape",
    ).rejects.toThrow(/pre-layout|legacy|migrate/i);

    // Zero writes: same entries, same bytes, and no turns/ minted by a partially-started turn.
    expect(readdirSync(outDir).sort(), "the refused resume still modified the run dir").toEqual(rootBefore);
    expect(existsSync(join(outDir, "turns")), "the refused resume created a turn dir").toBe(false);
    for (const a of artifacts) {
      expect(readFileSync(join(outDir, a), "utf8"), `${a} was modified by a resume that was supposed to refuse`).toBe(before[a]);
    }
  }, 90_000);
});
