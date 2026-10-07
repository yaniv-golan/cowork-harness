import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CASSETTE_VERSION, V14_ASSERT_FEATURES, requiredVersionFor, readCassette, cassetteSchemaUrl } from "../src/run/cassette.js";
import { ScenarioObject } from "../src/types.js";

// v14 is ONE interpretation bump shared by the keys that need a v14 reader. Its first user is
// `semantic_matches.include_fork_results`: live-only, but `readCassette` strict-parses every frozen assert
// BEFORE the live-only strip, so without the lift a v13 reader rejects it as "unrecognized assertion … re-record"
// — the wrong remedy. With it, a v13 reader takes the future-cassette path: "too new; upgrade".

const parse = (assert: unknown[]) => ScenarioObject.parse({ prompt: "x", fidelity: "container", assert });
const SM = (extra: Record<string, unknown> = {}) => ({ semantic_matches: { rubric: ["r"], ...extra } });

describe("v14: include_fork_results lifts the stamp", () => {
  it("this build writes and reads at least v14 (v15 since the keys added after it)", () => {
    expect(CASSETTE_VERSION).toBeGreaterThanOrEqual(14);
    expect(cassetteSchemaUrl(14)).toMatch(/schema\/cassette\.v14\.json$/);
    expect(existsSync(join(process.cwd(), "schema", "cassette.v14.json"))).toBe(true);
  });
  it("include_fork_results: true stamps 14", () => {
    expect(requiredVersionFor(parse([SM({ include_fork_results: true })]))).toBe(14);
  });
  it("include_fork_results: false ALSO stamps 14 — a v13 reader rejects the key whatever its value", () => {
    expect(requiredVersionFor(parse([SM({ include_fork_results: false })]))).toBe(14);
  });
  it("v14 dominates a v13 object form in the same scenario", () => {
    expect(requiredVersionFor(parse([{ tool_called: { tool: "Bash" } }, SM({ include_fork_results: true })]))).toBe(14);
  });
  it("every other semantic_matches option keeps the stamp where it was", () => {
    expect(requiredVersionFor(parse([SM({ include_subagent_text: true, evidence_files: ["outputs/a.md"] })]))).toBe(12);
    expect(requiredVersionFor(parse([{ tool_called: { tool: "Bash" } }, SM()]))).toBe(13);
  });
  it("a loose on-disk scenario (as rehash reads it) is judged the same way", () => {
    expect(requiredVersionFor({ prompt: "x", assert: [SM({ include_fork_results: true })] })).toBe(14);
    expect(requiredVersionFor({ prompt: "x", assert: [{ semantic_matches: null }, 5, null] })).toBe(12);
  });
  it("V14_ASSERT_FEATURES is the one list of the v14 assert-level keys (closed; new keys go to V15)", () => {
    expect(V14_ASSERT_FEATURES.length).toBeGreaterThanOrEqual(1);
  });
});

describe("a v13-only reader's view of a v14 cassette", () => {
  // Simulated as in the v13 suite: a cassette stamped one above this build's max takes exactly the
  // future-cassette path a v13 build takes for a v14 one. The v13 build cannot know `include_fork_results`;
  // an invented sibling key stands in for it here.
  const cassette = (version: number) =>
    JSON.stringify({
      cassetteVersion: version,
      scenario: {
        name: "s",
        baseline: "latest",
        session: "(inline)",
        fidelity: "container",
        prompt: "hi",
        answers: [],
        expect_denied: [],
        assert: [{ semantic_matches: { rubric: ["r"], include_key_from_the_future: true } }],
      },
      events: [],
      controlOut: [],
    });
  const read = (text: string) => {
    const f = join(mkdtempSync(join(tmpdir(), "cwh-v14-")), "c.cassette.json");
    writeFileSync(f, text);
    return readCassette(f);
  };
  it("a cassette stamped above the reader's max is tolerated at parse (and refused as too new by replay/verify)", () => {
    const r = read(cassette(CASSETTE_VERSION + 1));
    expect("error" in r ? r.error : "").toBe("");
  });
  it("the same key in a cassette stamped AT the reader's max is the 're-record' refusal the stamp exists to avoid", () => {
    const r = read(cassette(CASSETTE_VERSION));
    expect("error" in r ? r.error : "").toMatch(/unrecognized assertion/);
  });
  it("this build reads a v14 cassette that carries include_fork_results", () => {
    const text = cassette(14).replace('"include_key_from_the_future":true', '"include_fork_results":true');
    const r = read(text);
    expect("error" in r ? r.error : "").toBe("");
  });
});
