import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Assertion } from "../src/types.js";
import { MANIFEST_KEYS, ALWAYS_CONTENT_KEYS } from "../src/run/cassette";

// Anti-drift guard: docs/scenario.md's "Full schema" assertion table hand-documents every key in
// the Assertion zod schema (src/types.ts) — the same source `assertion-keys.json` / `Assertion.shape`
// export (see test/schema.test.ts, which pins their parity). A key added to the schema without a
// matching doc row would silently leave the user-facing catalog stale. Catch that here instead of
// relying on a human noticing during review.
// Keys the schema itself marks as not user-authorable in a scenario `assert:` block — they must NOT
// have a catalog row (documenting a way to write them would be wrong; authoring them is a load-time
// error). Audited against every `Assertion.shape` key's zod `.describe()` text for the literal phrase
// "NOT authorable" (src/types.ts); only one currently qualifies.
const NON_AUTHORABLE = new Set([
  // synthesized by the replay lane (serializeDecision vs. the frozen recording), never written by a
  // scenario author — see src/types.ts's own description and src/run/execute.ts's load-time rejection.
  "replay_protocol_fidelity",
]);

describe("docs/scenario.md ↔ src/types.ts Assertion key sync", () => {
  const doc = readFileSync(resolve("docs/scenario.md"), "utf8");
  const allKeys = Object.keys(Assertion.shape);
  const authorableKeys = allKeys.filter((k) => !NON_AUTHORABLE.has(k));

  it("parsed a sane key set", () => {
    // sanity: catches an import that silently resolved to an empty/undefined shape
    expect(allKeys.length).toBeGreaterThan(15);
    expect(allKeys).toContain("transcript_contains");
    expect(allKeys).toContain("tool_called");
  });

  // A table row looks like `| \`key: <type>\` | ... |` or `| \`key\` | ... |` — anchoring to a
  // line that starts with `|` (the `m` flag makes `^` match per-line) rules out a key that's only
  // ever mentioned in prose, which would otherwise false-pass this guard without a real catalog entry.
  const tableRow = (k: string) => new RegExp("^\\|\\s*`" + k + "[`:]", "m");

  it("the anchor matches a real table row but not a prose-only mention", () => {
    // known-documented key: has an actual `| \`transcript_contains: ...\` |` row.
    expect(tableRow("transcript_contains").test(doc)).toBe(true);
    // known-prose-only key: only ever appears in sentences, never as a table row — proves the anchor
    // rejects what the old document-wide regex would have false-passed.
    expect(tableRow("replay_protocol_fidelity").test(doc)).toBe(false);
  });

  it("every authorable assertion key is documented with a real table row", () => {
    const missing = authorableKeys.filter((k) => !tableRow(k).test(doc));
    expect(missing, `docs/scenario.md is missing assertion table rows for: ${missing.join(", ")}`).toEqual([]);
  });
});

// Anti-drift guard: docs/scenario.md's "### Which assertions survive `replay` (CI placement)" section
// hand-summarizes which assertion keys the replay lane evaluates, bucketed by when they're evaluated
// (always / only with controlOut / only with an artifact manifest). MANIFEST_KEYS (src/run/cassette.ts)
// is the authoritative list for the manifest-gated bucket ("Filesystem assertions") — this is the same
// root cause that let the "Filesystem assertions" key list and its "all N are skipped" count drift
// stale (both fixed alongside this guard). Catch a future drift mechanically instead of relying on a
// human noticing during review, mirroring how test/cassette-docs-sync.test.ts guards docs/cassette.md
// and README.md against the same three cassette.ts key arrays.
describe("docs/scenario.md ↔ src/run/cassette.ts MANIFEST_KEYS sync", () => {
  const doc = readFileSync(resolve("docs/scenario.md"), "utf8");

  // Extract the whole "Which assertions survive `replay`" section (heading to the next same-level
  // heading), not just the first bolded paragraph under it — the section's later "Filesystem
  // assertions" paragraph is where MANIFEST_KEYS is actually enumerated. Anchoring by heading text
  // (not a line number) survives edits elsewhere in the file; failing loudly if either anchor moved
  // avoids a silent vacuous pass (same discipline the README section guard above uses).
  const startMarker = "### Which assertions survive `replay` (CI placement)";
  const endMarker = "### Scenario YAML vs the pytest `cowork` lane";
  const startIdx = doc.indexOf(startMarker);
  const endIdx = startIdx === -1 ? -1 : doc.indexOf(endMarker, startIdx);

  it('found the "Which assertions survive `replay`" section', () => {
    expect(startIdx, `docs/scenario.md's "${startMarker}" heading was not found — did it move or get renamed?`).toBeGreaterThan(-1);
    expect(endIdx, `docs/scenario.md's "${endMarker}" heading (end of the section) was not found`).toBeGreaterThan(startIdx);
  });

  const section = startIdx === -1 || endIdx === -1 ? "" : doc.slice(startIdx, endIdx);

  it("parsed a non-empty section", () => {
    // sanity: catches a marker match that somehow yielded an empty/near-empty slice
    expect(section.length).toBeGreaterThan(200);
  });

  it("parsed a sane MANIFEST_KEYS set", () => {
    // sanity: catches an import that silently resolved to an empty/undefined array
    expect(MANIFEST_KEYS.length).toBeGreaterThan(3);
    expect(MANIFEST_KEYS).toContain("file_exists");
  });

  // A key is "covered" if its literal backtick token appears in the section, OR an accepted
  // `prefix_*` wildcard token appears whose prefix is a prefix of the key — mirrors the covered()
  // helper in test/cassette-docs-sync.test.ts's README guard. None of MANIFEST_KEYS currently share a
  // wildcard-able prefix with the section's `transcript_*`/`tool_*`/`subagent_*` tokens, so today every
  // member must be covered by a literal mention — but the wildcard branch is kept so this guard doesn't
  // need updating if a future manifest key happens to share one of those prefixes.
  const covered = (key: string): boolean => {
    if (section.includes(`\`${key}\``)) return true;
    for (const m of section.matchAll(/`([a-zA-Z0-9]+_)\*`/g)) {
      if (key.startsWith(m[1])) return true;
    }
    return false;
  };

  it("every MANIFEST_KEYS member is covered in the section", () => {
    const missing = MANIFEST_KEYS.filter((k) => !covered(k));
    expect(missing, `docs/scenario.md's replay section is missing: ${missing.join(", ")}`).toEqual([]);
  });

  // Same guard, applied to the content-class bucket ("Evaluated on replay (content assertions)") whose
  // authoritative list is ALWAYS_CONTENT_KEYS (src/run/cassette.ts). This bucket's prose summary drifted
  // stale once (it omitted no_vm_path_file_op while listing the rest), so pin it too: every content-class
  // key must be named in the section, either literally or via one of the `prefix_*` wildcard tokens the
  // covered() helper accepts (transcript_*/tool_*/subagent_* today).
  it("every ALWAYS_CONTENT_KEYS member is covered in the section", () => {
    const missing = ALWAYS_CONTENT_KEYS.filter((k) => !covered(k));
    expect(missing, `docs/scenario.md's replay content-assertion summary is missing: ${missing.join(", ")}`).toEqual([]);
  });
});
