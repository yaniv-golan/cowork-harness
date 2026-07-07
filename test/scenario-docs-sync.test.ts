import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Assertion } from "../src/types.js";

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
