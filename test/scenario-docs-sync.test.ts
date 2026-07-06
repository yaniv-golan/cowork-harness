import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Assertion } from "../src/types.js";

// Anti-drift guard: docs/scenario.md's "Full schema" assertion table hand-documents every key in
// the Assertion zod schema (src/types.ts) — the same source `assertion-keys.json` / `Assertion.shape`
// export (see test/schema.test.ts, which pins their parity). A key added to the schema without a
// matching doc row would silently leave the user-facing catalog stale. Catch that here instead of
// relying on a human noticing during review.
describe("docs/scenario.md ↔ src/types.ts Assertion key sync", () => {
  const doc = readFileSync(resolve("docs/scenario.md"), "utf8");
  const allKeys = Object.keys(Assertion.shape);

  it("parsed a sane key set", () => {
    // sanity: catches an import that silently resolved to an empty/undefined shape
    expect(allKeys.length).toBeGreaterThan(15);
    expect(allKeys).toContain("transcript_contains");
    expect(allKeys).toContain("tool_called");
  });

  it("every assertion key is documented as a backtick-quoted token", () => {
    const missing = allKeys.filter((k) => !new RegExp("`" + k + "[`:]").test(doc));
    expect(missing, `docs/scenario.md is missing assertion rows for: ${missing.join(", ")}`).toEqual([]);
  });
});
