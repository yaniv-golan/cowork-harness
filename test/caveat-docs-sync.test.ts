import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { TOOL_USE_BLIND_KEYS, MODEL_AUTHORED_TEXT_KEYS } from "../src/run/cassette.js";
import { Assertion } from "../src/types.js";
import { catalogText } from "./helpers/assertion-catalog.js";

// WHY THIS FILE EXISTS. `semantic_matches` has carried a ⚠️ since 2026-07 spelling out that its corpus
// excludes every tool_use — "a rubric claim about whether a tool was called is unassertable". The four
// transcript keys have the IDENTICAL blindness and said only "the assistant transcript". A consumer
// reached for `transcript_matches` against text living in a gate question, and it could not have matched
// at any phrasing; the recording fail-closed after the money was spent.
//
// docs/scenario.md is already guarded for key PRESENCE (scenario-docs-sync.test.ts), so a new key cannot
// ship undocumented. Nothing guarded the CAVEAT, which is why the asymmetry survived a year. These tests
// close that: the caveat is now a property of an enumerable set, not of prose someone remembered to paste.
//
// On the copy-paste objection: yes, a developer satisfies this by pasting the sentence onto the row. That
// is the intended action. The rot mode being guarded is a NEW blind/model-authored key added with no
// caveat at all — and an enumerable set catches exactly that.

const scenarioDoc = readFileSync("docs/scenario.md", "utf8");
// The per-key table moved from scenario-schema.md into its own reference, since split by family across
// references/assertion-catalog*.md. `row()` returning undefined is
// tolerated below (the table covers a subset), so a wrong file here would skip every key silently — the
// "found at least one row" test pins that.
const skillRef = catalogText();
const cassetteDoc = readFileSync("docs/cassette.md", "utf8");

const TOOL_USE_SENTINEL = "excludes every `tool_use`/`tool_result`";
const DRIFT_SENTINEL = "model-composed and is reworded run to run";

/** Backticks are markdown, not meaning: the same sentence is written with them in a docs table and without
 *  them in a zod `.describe()` (which is rendered as plain text by `assertions --list`). Compare on the
 *  words. Without this the guard silently exempts every non-markdown surface — which is how the first
 *  version of this file ended up covering only the two docs it read. */
const words = (s: string) => s.replace(/`/g, "");
const carries = (text: string, sentinel: string) => words(text).includes(words(sentinel));

/** The one table row documenting `key`, or undefined. Rows open with `| \`key` — matching the backtick
 *  prevents `transcript_matches` from being satisfied by `transcript_not_matches`' row. */
function row(doc: string, key: string): string | undefined {
  for (const line of doc.split("\n")) {
    if (!line.startsWith("| `")) continue;
    const name = line.slice(3).split(/[`:]/)[0];
    if (name === key) return line;
  }
  return undefined;
}

/** The user-facing help text for one key, read exactly as `cli.ts` reads it (`Assertion.shape[k].description`
 *  — zod's PUBLIC getter, and the single source both `assertions --list` and the generated JSON schema use).
 *
 *  Deliberately not `._def.description`: that internal is not populated the same way across the src and dist
 *  builds, so a guard written against it reports "no describe" for every key and fails for the wrong reason.
 *  Measured while writing this file. */
function describeOf(key: string): string | undefined {
  const shape = Assertion.shape as Record<string, { description?: string } | undefined>;
  return shape[key]?.description;
}

/** Every documented key whose row carries `sentinel` — the docs → set direction. */
function rowsCarrying(doc: string, sentinel: string): string[] {
  const out: string[] = [];
  for (const line of doc.split("\n")) {
    if (!line.startsWith("| `")) continue;
    if (!carries(line, sentinel)) continue;
    out.push(line.slice(3).split(/[`:]/)[0]);
  }
  return out;
}

describe("keys blind to tool_use carry the exclusion in their docs row", () => {
  it("the sets are non-empty and every member is a real assertion key (an anchor that rots must fail HERE)", () => {
    expect(TOOL_USE_BLIND_KEYS.length).toBeGreaterThan(0);
    expect(MODEL_AUTHORED_TEXT_KEYS.length).toBeGreaterThan(0);
    const real = new Set(Object.keys(Assertion.shape));
    expect(TOOL_USE_BLIND_KEYS.filter((k) => !real.has(k as string))).toEqual([]);
    expect(MODEL_AUTHORED_TEXT_KEYS.filter((k) => !real.has(k as string))).toEqual([]);
  });

  it.each(TOOL_USE_BLIND_KEYS)("docs/scenario.md documents %s with the tool_use exclusion", (key) => {
    const r = row(scenarioDoc, key as string);
    expect(r, `docs/scenario.md has no table row for ${key}`).toBeDefined();
    expect(carries(r!, TOOL_USE_SENTINEL), `docs/scenario.md's ${key} row must say it ${TOOL_USE_SENTINEL}`).toBe(true);
  });

  // cassette.md's replay table covers a subset; where it DOES describe one of these keys, the caveat has to
  // travel with it — that table is what a reader consults when placing an assert in CI.
  it.each(TOOL_USE_BLIND_KEYS)("docs/cassette.md's row for %s, where it has one, carries it too", (key) => {
    const r = row(cassetteDoc, key as string);
    if (r === undefined) return;
    expect(carries(r, TOOL_USE_SENTINEL), `docs/cassette.md's ${key} row must say it ${TOOL_USE_SENTINEL}`).toBe(true);
  });

  it.each(MODEL_AUTHORED_TEXT_KEYS)("docs/scenario.md warns that %s matches model-authored text", (key) => {
    const r = row(scenarioDoc, key as string);
    expect(r, `docs/scenario.md has no table row for ${key}`).toBeDefined();
    expect(carries(r!, DRIFT_SENTINEL), `docs/scenario.md's ${key} row must say the text is ${DRIFT_SENTINEL}`).toBe(true);
  });

  // THE SURFACES THE FIRST VERSION OF THIS GUARD MISSED. It read `docs/scenario.md` and `docs/cassette.md`
  // and nothing else — so the caveat was added to exactly the two files the guard checked, while
  // `assertions --list` (the CLI's own help), `schema/scenario.schema.json` (the editor surface) and the
  // packaged skill reference (billed into every agent's context) kept the pre-commit asymmetry. A guard
  // whose scope is narrower than the claim it enforces IS the bug it is meant to prevent.
  it.each(TOOL_USE_BLIND_KEYS)("the zod describe for %s — the `assertions --list` and JSON-schema surface — carries it", (key) => {
    const d = describeOf(key as string);
    expect(d, `no zod .describe() found for ${key}`).toBeDefined();
    expect(carries(d!, TOOL_USE_SENTINEL), `${key}'s describe() must say it ${TOOL_USE_SENTINEL}`).toBe(true);
  });

  it.each(MODEL_AUTHORED_TEXT_KEYS)("the zod describe for %s warns about model-authored text", (key) => {
    const d = describeOf(key as string);
    expect(d, `no zod .describe() found for ${key}`).toBeDefined();
    expect(carries(d!, DRIFT_SENTINEL), `${key}'s describe() must say the text is ${DRIFT_SENTINEL}`).toBe(true);
  });

  it.each(TOOL_USE_BLIND_KEYS)("the packaged skill reference documents %s with the exclusion", (key) => {
    const r = row(skillRef, key as string);
    if (r === undefined) return; // that table covers a subset; where it describes the key, the caveat travels
    expect(carries(r, TOOL_USE_SENTINEL), `references/assertion-catalog*.md's ${key} row must say it ${TOOL_USE_SENTINEL}`).toBe(true);
  });

  it("the packaged skill reference has rows for these keys at all (the tolerated-undefined above is not every key)", () => {
    expect((TOOL_USE_BLIND_KEYS as string[]).filter((k) => row(skillRef, k) !== undefined).length).toBeGreaterThan(0);
  });

  // THE DIRECTION THAT ACTUALLY ROTS. Everything above runs set → docs: it catches a member whose row lost
  // the caveat, but NOT a key quietly REMOVED from the set — nothing forces a key into it (the replay-bucket
  // exhaustiveness throw covers the replay-class arrays only, and these sets have no other consumer). Dropping
  // `transcript_matches` from TOOL_USE_BLIND_KEYS was measured as a zero-failure mutation. Running docs → set
  // closes it: the row keeps the sentence, so the key must still be claimed.
  it("every row carrying the tool_use sentinel belongs to TOOL_USE_BLIND_KEYS", () => {
    const claimed = new Set((TOOL_USE_BLIND_KEYS as string[]).map((k) => k));
    const orphans = rowsCarrying(scenarioDoc, TOOL_USE_SENTINEL).filter((k) => !claimed.has(k));
    expect(
      orphans,
      `docs/scenario.md documents the tool_use exclusion for keys missing from TOOL_USE_BLIND_KEYS: ${orphans.join(", ")}`,
    ).toEqual([]);
  });

  it("every row carrying the drift sentinel belongs to MODEL_AUTHORED_TEXT_KEYS", () => {
    const claimed = new Set((MODEL_AUTHORED_TEXT_KEYS as string[]).map((k) => k));
    const orphans = rowsCarrying(scenarioDoc, DRIFT_SENTINEL).filter((k) => !claimed.has(k));
    expect(
      orphans,
      `docs/scenario.md documents model-authored drift for keys missing from MODEL_AUTHORED_TEXT_KEYS: ${orphans.join(", ")}`,
    ).toEqual([]);
  });

  // BOTH DIRECTIONS, or this file is decorative: a guard that only ever checks the rows that already pass
  // cannot fail. These prove the two ways it is meant to break.
  it("fails when a member's caveat is deleted", () => {
    const key = "transcript_matches";
    const before = row(scenarioDoc, key)!;
    // Mutate THAT ROW, not the first occurrence in the file. A whole-document `.replace()` hits
    // semantic_matches' row (it appears earlier and already carried the sentence), so the document
    // changes, this test goes green, and it proves nothing about the row under test. That near-miss is
    // why the mutation is anchored and then re-asserted below.
    const mutated = scenarioDoc.replace(before, before.replace(TOOL_USE_SENTINEL, "the assistant transcript"));
    const after = row(mutated, key)!;
    expect(after, "mutation did not apply to the row under test").not.toEqual(before);
    expect(after).not.toContain(TOOL_USE_SENTINEL);
    // ...and the rest of the table is untouched, so a green above is about this row alone.
    expect(row(mutated, "semantic_matches")).toContain(TOOL_USE_SENTINEL);
  });

  // The other direction, and it must EXERCISE the guard rather than the helper. Asserting that
  // `row(doc, "made_up")` is undefined proves only that the lookup works; it says nothing about whether a
  // set member with no row would actually be caught. So run the guard's own predicate over a set with an
  // extra member and require a failure.
  it("fails when a key is added to the set with no documented row", () => {
    const check = (keys: string[]) =>
      keys
        .map((k) => {
          const r = row(scenarioDoc, k);
          return r === undefined || !r.includes(TOOL_USE_SENTINEL) ? k : undefined;
        })
        .filter((k): k is string => k !== undefined);

    // The real set passes the predicate today...
    expect(check(TOOL_USE_BLIND_KEYS as string[])).toEqual([]);
    // ...and the same predicate catches an undocumented member, which is the rot mode this file exists for.
    expect(check([...(TOOL_USE_BLIND_KEYS as string[]), "tool_result_contains"])).toEqual(["tool_result_contains"]);
  });

  // transcript_no_host_path LOOKS like a transcript key and is deliberately excluded: it reads the post-run
  // host-path scan (ctx.hostPathLeaked), not the transcript string. Pinning the exclusion stops a later
  // "tidy-up" from sweeping it in and attaching a caveat that would be false.
  it("does not sweep in transcript_no_host_path, which reads a scan and not the transcript", () => {
    expect(TOOL_USE_BLIND_KEYS).not.toContain("transcript_no_host_path");
  });
});
