import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CAPABILITY_FAMILIES } from "../src/runtime/image-capabilities.js";

// Keep the parity-gated capability table in docs/scenario.md in sync with the CAPABILITY_FAMILIES
// single source of truth. SECTION-ANCHORED on purpose: scenario.md mentions all six family tokens in
// prose elsewhere, so a whole-doc token check would pass vacuously with no table written. We diff ONLY
// the marker-delimited table region.
const BEGIN = "<!-- capability-families:begin";
const END = "<!-- capability-families:end -->";

describe("docs/scenario.md capability-families table ↔ CAPABILITY_FAMILIES", () => {
  const doc = readFileSync(resolve("docs/scenario.md"), "utf8");
  const families = Object.keys(CAPABILITY_FAMILIES);

  const begin = doc.indexOf(BEGIN);
  const end = doc.indexOf(END);

  it("the delimited table region exists (not silently removed)", () => {
    expect(begin, `${BEGIN} marker missing from docs/scenario.md`).toBeGreaterThanOrEqual(0);
    expect(end, `${END} marker missing from docs/scenario.md`).toBeGreaterThan(begin);
  });

  const region = begin >= 0 && end > begin ? doc.slice(begin, end) : "";

  it("every CAPABILITY_FAMILIES key appears as a row in the table region", () => {
    const missing = families.filter((f) => !region.includes("`" + f + "`"));
    expect(missing, `capability families absent from the docs table: ${missing.join(", ")}`).toEqual([]);
  });

  it("the table region names no stale family that is not in CAPABILITY_FAMILIES", () => {
    // Every backtick token in the region that looks like a family name (first column) must be real.
    const rowFamilies = [...region.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]);
    const stale = rowFamilies.filter((f) => !(families as string[]).includes(f));
    expect(stale, `stale capability families in the docs table: ${stale.join(", ")}`).toEqual([]);
  });
});
