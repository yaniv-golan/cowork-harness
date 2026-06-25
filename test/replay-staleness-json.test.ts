import { describe, it, expect, afterEach } from "vitest";
import { replayCassette, CASSETTE_VERSION } from "../src/run/cassette.js";
import { computeVerdict } from "../src/run/verdict.js";
import { loadBaseline } from "../src/baseline.js";
import type { Fingerprint } from "../src/types.js";

// Fix 1/2 (founder-skills CI-recipe feedback): replay must surface class-tagged `staleness[]` and
// `skippedAssertions` in the RunResult so a token-free JSON gate can see staleness WITHOUT it flipping the
// verdict by default; `--fail-on-skill-drift` then fails on skill-source classes only.

const LIVE = loadBaseline("latest").appVersion;

// Silence the ::warning:: lines these cassettes intentionally provoke.
const origWrite = process.stderr.write.bind(process.stderr);
afterEach(() => {
  process.stderr.write = origWrite;
});
function mute(): void {
  process.stderr.write = (() => true) as typeof process.stderr.write;
}

const okEvents = () => [
  JSON.stringify({ type: "system", subtype: "init", tools: [] }),
  JSON.stringify({ type: "result", subtype: "success", is_error: false }),
];

// A minimal replayable cassette carrying a fingerprint (so the staleness block runs). cassetteVersion is the
// CURRENT version so no future-version assertion confounds the strict cases.
const cassette = (fingerprint: Fingerprint, assert: unknown[] = [{ result: "success" }]) =>
  ({
    scenario: { name: "c", baseline: "latest", session: "(inline)", fidelity: "container", prompt: "hi", answers: [], expect_denied: [], assert },
    events: okEvents(),
    controlOut: [],
    fingerprint,
    cassetteVersion: CASSETTE_VERSION,
  }) as any;

const ok = (r: Awaited<ReturnType<typeof replayCassette>>) => computeVerdict(r, "replay").pass;

describe("replay surfaces class-tagged staleness in the JSON RunResult (Fix 1)", () => {
  it("a moved baseline → a non-failing `baseline` finding, ok stays true (default gate)", async () => {
    mute();
    const r = await replayCassette(cassette({ baseline: "0.0.0-stale-not-live" }));
    expect(r.staleness).toEqual([expect.objectContaining({ class: "baseline" })]);
    expect(ok(r)).toBe(true); // surfaced, not failed
  });

  it("baseline-unloadable vs skill-unresolvable get distinct `unverifiable-*` classes", async () => {
    mute();
    // skillHash set but session is unresolvable ((inline) ⇒ no dirs) and baseline matches live ⇒ exactly one
    // finding: unverifiable-skill (the skill check couldn't run; baseline is fine).
    const r = await replayCassette(cassette({ baseline: LIVE, skillHash: "deadbeef" }));
    expect(r.staleness).toEqual([expect.objectContaining({ class: "unverifiable-skill" })]);
    expect(ok(r)).toBe(true);
  });

  it("reports skippedAssertions for live-only assertions absent from assertions[]", async () => {
    mute();
    const r = await replayCassette(cassette({ baseline: LIVE }, [{ result: "success" }, { file_exists: "outputs/x.json" }]));
    expect(r.skippedAssertions?.full).toBeGreaterThanOrEqual(1); // file_exists is live-only without a manifest
    // the skipped assertion is filtered out, not present-and-passing
    expect(r.assertions.some((a) => a.assertion.file_exists !== undefined)).toBe(false);
  });
});

describe("--fail-on-skill-drift gates on skill-source classes only (Fix 2)", () => {
  it("fails on a skill/shared-root drift but a baseline-only drift stays green", async () => {
    mute();
    const baselineOnly = await replayCassette(cassette({ baseline: "0.0.0-stale-not-live" }), [], { failOnSkillDrift: true });
    expect(ok(baselineOnly)).toBe(true); // baseline drift is not skill-source drift

    const skillUnverifiable = await replayCassette(cassette({ baseline: LIVE, skillHash: "deadbeef" }), [], { failOnSkillDrift: true });
    expect(ok(skillUnverifiable)).toBe(false); // can't verify the skill ⇒ not green under this gate
  });

  it("--strict still fails on a baseline-only drift (superset; regression guard)", async () => {
    mute();
    const r = await replayCassette(cassette({ baseline: "0.0.0-stale-not-live" }), [], { strict: true });
    expect(ok(r)).toBe(false);
  });
});
