import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { scenarioContentDrift } from "../src/run/cassette.js";

// WS-A2: verify-cassettes must catch a committed scenario whose PROMPT diverged from the cassette's frozen
// prompt — the fingerprint doesn't cover the prompt, so this was previously invisible. A resolvable+drifted
// prompt is a hard fail; an unresolvable/unparseable source is a non-failing note (can't compare ⇒ not red).

const frozen = (prompt: string) => ({ scenarioSource: "s.yaml", scenario: { name: "c", prompt } }) as any;

describe("scenarioContentDrift (function-level)", () => {
  it("matching prompt → verifiable, no drift", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-scd-"));
    writeFileSync(join(d, "s.yaml"), "prompt: hi\n");
    const r = scenarioContentDrift(frozen("hi"), join(d, "x.cassette.json"));
    expect(r).toEqual({ verifiable: true, drifted: [] });
  });

  it("edited on-disk prompt → verifiable drift on `prompt`", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-scd-"));
    writeFileSync(join(d, "s.yaml"), "prompt: CHANGED\n");
    const r = scenarioContentDrift(frozen("hi"), join(d, "x.cassette.json"));
    expect(r).toEqual({ verifiable: true, drifted: ["prompt"] });
  });

  it("no resolvable source → not verifiable (note, not a hard fail)", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-scd-"));
    // scenarioSource points at a file that doesn't exist, and no name-lookup sibling exists.
    const r = scenarioContentDrift(frozen("hi"), join(d, "x.cassette.json"));
    expect(r.verifiable).toBe(false);
  });

  it("unparseable on-disk YAML → not verifiable, never throws (batch must not abort)", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-scd-"));
    writeFileSync(join(d, "s.yaml"), "prompt: [unterminated\n");
    const r = scenarioContentDrift(frozen("hi"), join(d, "x.cassette.json"));
    expect(r.verifiable).toBe(false);
  });

  it("a lenient cassette missing scenario.name does NOT throw (would otherwise abort the batch)", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-scd-"));
    // No scenarioSource and no name → resolution would slug(undefined) and throw; must be caught.
    const nameless = { scenario: { prompt: "hi" } } as any;
    expect(() => scenarioContentDrift(nameless, join(d, "x.cassette.json"))).not.toThrow();
    expect(scenarioContentDrift(nameless, join(d, "x.cassette.json")).verifiable).toBe(false);
  });

  it("a name-lookup match (recorded source gone) is a NOTE, not a hard-fail — avoids same-name false-red", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-scd-"));
    // scenarioSource recorded but missing → falls back to a fuzzy <name>.yaml sibling that may be unrelated.
    writeFileSync(join(d, "c.yaml"), "prompt: a totally different scenario reusing the name\n");
    const cassette = { scenarioSource: "gone.yaml", scenario: { name: "c", prompt: "hi" } } as any;
    const r = scenarioContentDrift(cassette, join(d, "x.cassette.json"));
    // resolvable-by-name + drifted → downgraded to a non-failing note, NOT a { verifiable:true, drifted:["prompt"] } finding
    expect(r).toEqual({ verifiable: false, reason: expect.stringMatching(/resolved by name/) });
  });
});

// End-to-end: the hard fail is inert unless the `ok` aggregation + envelope schema are wired. Proven against
// the built CLI so the whole path (emit → ok → schema) is exercised.
const CLI = resolve("dist/cli.js");
const cassetteFixture = (prompt: string) => ({
  scenario: {
    name: "c",
    baseline: "latest",
    session: "(inline)",
    fidelity: "container",
    prompt,
    answers: [],
    expect_denied: [],
    assert: [{ result: "success" }],
  },
  scenarioSource: "s.yaml",
  events: [JSON.stringify({ type: "result", subtype: "success" })],
});
function envelope(args: string[], cwd: string): any {
  const r = spawnSync("node", [CLI, ...args, "--output-format", "json"], { encoding: "utf8", cwd });
  return JSON.parse(r.stdout);
}

describe.skipIf(!existsSync(CLI))("verify-cassettes gates on scenario prompt drift (end-to-end)", () => {
  it("matching prompt → ok:true; edited prompt → ok:false with scenarioDrift; --skip-scenario-drift → ok:true", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-scd-e2e-"));
    const cassettePath = join(d, "c.cassette.json");
    writeFileSync(cassettePath, JSON.stringify(cassetteFixture("hi")));
    writeFileSync(join(d, "s.yaml"), "prompt: hi\n");

    const clean = envelope(["verify-cassettes", cassettePath], d);
    expect(clean.ok).toBe(true);
    expect(clean.coverage.scenarioDrift).toBe(true);
    expect(clean.results[0].scenarioDrift).toEqual([]);

    // Edit the committed prompt → the frozen cassette prompt now diverges → hard fail.
    writeFileSync(join(d, "s.yaml"), "prompt: a DIFFERENT prompt\n");
    const drifted = envelope(["verify-cassettes", cassettePath], d);
    expect(drifted.ok).toBe(false);
    expect(drifted.results[0].scenarioDrift.length).toBeGreaterThan(0);

    // Opt out → back to green (a skipped check can't fail).
    const skipped = envelope(["verify-cassettes", cassettePath, "--skip-scenario-drift"], d);
    expect(skipped.ok).toBe(true);
    expect(skipped.coverage.scenarioDrift).toBe(false);
  });

  it("a nameless cassette in the batch does NOT abort the run — both files are scanned", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-scd-nameless-"));
    // lenient cassette shape: no scenario.name, no scenarioSource → the drift resolver would slug(undefined).
    writeFileSync(
      join(d, "a.cassette.json"),
      JSON.stringify({
        scenario: { prompt: "hi", session: "(inline)", assert: [] },
        events: [JSON.stringify({ type: "result", subtype: "success" })],
      }),
    );
    writeFileSync(join(d, "b.cassette.json"), JSON.stringify(cassetteFixture("hi")));
    const env = envelope(["verify-cassettes", d], d);
    expect(env.results).toHaveLength(2); // batch continued; not a crash with results:[]
    expect(env.results.every((r: any) => r.error === undefined)).toBe(true); // no per-file internal crash
  });
});
