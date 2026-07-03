import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ALWAYS_CONTENT_KEYS, QUESTION_GATE_KEYS, MANIFEST_KEYS } from "../src/run/cassette";

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
