import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ALWAYS_CONTENT_KEYS, QUESTION_GATE_KEYS, MANIFEST_KEYS, LIVE_ONLY_KEYS } from "../src/run/cassette";
import { VERDICT_MODIFIER_KEYS } from "../src/types.js";

// Anti-drift guard: docs/cassette.md's "Assertion table" hand-documents every replay-evaluated
// assertion key. Source of truth = the three key arrays in src/run/cassette.ts (ALWAYS_CONTENT_KEYS /
// QUESTION_GATE_KEYS / MANIFEST_KEYS) — a key added to any of them without a matching doc row would
// silently make the table (which claims to "mirror" that source) go stale. Catch that here instead of
// relying on a human noticing during review.
describe("docs/cassette.md ↔ src/run/cassette.ts replay-key sync", () => {
  const docs = readFileSync(resolve("docs/cassette.md"), "utf8");
  const allKeys = [...new Set([...ALWAYS_CONTENT_KEYS, ...QUESTION_GATE_KEYS, ...MANIFEST_KEYS])];

  it("parsed a sane key set", () => {
    // sanity: catches an import that silently resolved to an empty/undefined array
    expect(allKeys.length).toBeGreaterThan(15);
    expect(allKeys).toContain("skill_triggered");
    expect(allKeys).toContain("file_exists");
  });

  it("every replay-evaluated assertion key is documented as a backtick-quoted token", () => {
    const missing = allKeys.filter((k) => !docs.includes(`\`${k}\``));
    expect(missing, `docs/cassette.md is missing a row for: ${missing.join(", ")}`).toEqual([]);
  });
});

// Anti-drift guard: README.md's "What replay checks" blockquote table summarizes the same four key
// buckets as its own compact reference. Unlike docs/cassette.md's per-key table (guarded above), this
// table groups keys under wildcard tokens (`transcript_*`, `tool_*`, ...) instead of listing every
// member — so this guard is wildcard-aware: a key is "covered" if its literal backtick token appears
// in the right bucket's cell, OR a `prefix_*` token appears whose prefix is a prefix of the key.
describe("README.md ↔ src/run/cassette.ts replay-bucket sync", () => {
  const readme = readFileSync(resolve("README.md"), "utf8");

  const markerIdx = readme.indexOf("> **What replay checks.**");
  const endIdx = markerIdx === -1 ? -1 : readme.indexOf("Authoritative list:", markerIdx);
  // Fail loudly (not a silent vacuous pass) if the marker/table moved or was renamed — same
  // anti-false-pass discipline test/scenario-docs-sync.test.ts uses for its own anchor.
  it('found the "What replay checks" table', () => {
    expect(markerIdx, 'README.md\'s "> **What replay checks.**" marker was not found — did the table move or get renamed?').toBeGreaterThan(
      -1,
    );
    expect(endIdx, 'README.md\'s "Authoritative list:" trailer (end of the replay-bucket table) was not found').toBeGreaterThan(markerIdx);
  });

  const table = markerIdx === -1 || endIdx === -1 ? "" : readme.slice(markerIdx, endIdx);

  // A row looks like `> | <label> | <cell...> |`. Anchoring the label between two `|`s (only
  // whitespace on either side) rules out "Always skipped (live-only)" false-matching a plain
  // "Always" lookup.
  const cellFor = (labelPattern: string): string => {
    const re = new RegExp(String.raw`^>\s*\|\s*${labelPattern}\s*\|(.*)\|\s*$`, "m");
    return table.match(re)?.[1] ?? "";
  };
  const alwaysCell = cellFor("Always");
  const controlOutCell = cellFor(String.raw`Only if the cassette carries \`controlOut\``);
  const manifestCell = cellFor(String.raw`Only if the cassette carries an \`artifacts\` manifest`);
  const liveOnlyCell = cellFor(String.raw`Always skipped \(live-only\)`);

  it("parsed all four non-empty bucket cells", () => {
    // sanity: a table refactor that renames/reorders a row shouldn't silently reduce this guard to a
    // vacuous "no keys were missing because we found zero cells" pass.
    expect(alwaysCell.length, "Always cell not found/empty").toBeGreaterThan(0);
    expect(controlOutCell.length, "controlOut cell not found/empty").toBeGreaterThan(0);
    expect(manifestCell.length, "manifest cell not found/empty").toBeGreaterThan(0);
    expect(liveOnlyCell.length, "live-only cell not found/empty").toBeGreaterThan(0);
  });

  const covered = (key: string, cell: string): boolean => {
    if (cell.includes(`\`${key}\``)) return true;
    for (const m of cell.matchAll(/`([a-zA-Z0-9]+_)\*`/g)) {
      if (key.startsWith(m[1])) return true;
    }
    return false;
  };

  // The verdict-modifier keys (allow_permissive_auto_allow, etc.) are folded into ALWAYS_CONTENT_KEYS
  // (see its definition) but README's Always cell represents them only as the prose phrase "the
  // verdict modifiers" — no literal or wildcard token a mechanical `covered()` check could match.
  // Excluded here the same way scenario-docs-sync.test.ts excludes its own non-literal NON_AUTHORABLE
  // set, rather than forcing "the verdict modifiers" to become wildcard-matchable prose.
  const verdictModifierSet = new Set<string>(VERDICT_MODIFIER_KEYS);
  const alwaysCheckable = ALWAYS_CONTENT_KEYS.filter((k) => !verdictModifierSet.has(k));

  it("every Always-bucket key (except the verdict modifiers) is covered in the Always cell", () => {
    const missing = alwaysCheckable.filter((k) => !covered(k, alwaysCell));
    expect(missing, `README.md's Always cell is missing: ${missing.join(", ")}`).toEqual([]);
  });

  it("every controlOut-bucket key is covered in the controlOut cell", () => {
    const missing = QUESTION_GATE_KEYS.filter((k) => !covered(k, controlOutCell));
    expect(missing, `README.md's controlOut cell is missing: ${missing.join(", ")}`).toEqual([]);
  });

  it("every manifest-bucket key is covered in the manifest cell", () => {
    const missing = MANIFEST_KEYS.filter((k) => !covered(k, manifestCell));
    expect(missing, `README.md's manifest cell is missing: ${missing.join(", ")}`).toEqual([]);
  });

  it("every live-only-bucket key is covered in the live-only cell", () => {
    const missing = LIVE_ONLY_KEYS.filter((k) => !covered(k, liveOnlyCell));
    expect(missing, `README.md's live-only cell is missing: ${missing.join(", ")}`).toEqual([]);
  });
});
