import { describe, it, expect } from "vitest";
import { batchCostEstimateLine } from "../src/run/budget.js";

/**
 * The batch cost estimate must not read as a ceiling, because it isn't one.
 *
 * It is `sum(max(local run history))` — a max over whatever THIS machine happens to have run. At a new
 * baseline or a new agent binary that history describes a materially different configuration, so it can
 * UNDER-predict exactly when it is most consulted. A consumer wrote "that is the ceiling, not the scope"
 * into an adoption plan off this line and had to retract it.
 *
 * The line always qualified the PARTIAL case (`— LOWER BOUND`). The complete case was the one that said
 * nothing qualifying and instead made an active claim of authority: `(all N scenario(s) priced from prior
 * runs)`. That inversion is what these cases pin.
 */

const line = (est: Parameters<typeof batchCostEstimateLine>[1], n = 26) => batchCostEstimateLine(Array(n).fill("s"), est);

describe("batchCostEstimateLine", () => {
  it("no longer claims authority on the fully-priced case", () => {
    const s = line({ known: 114.4096, unpriced: [], pricedRuns: 38, thinnest: 2 });
    expect(s, "the old phrasing asserted the number was backed and complete").not.toMatch(/priced from prior runs/);
  });

  it("states the basis: how much history, how thin, and that it is not a bound", () => {
    const s = line({ known: 114.4096, unpriced: [], pricedRuns: 38, thinnest: 2 });
    expect(s).toMatch(/basis: 38 prior run\(s\) on THIS machine/);
    expect(s).toMatch(/thinnest scenario has 2/);
    expect(s).toMatch(/NOT a bound/);
  });

  it("surfaces a single-sample estimate as such — one run is not a worst case", () => {
    expect(line({ known: 1, unpriced: [], pricedRuns: 1, thinnest: 1 })).toMatch(/thinnest scenario has 1/);
  });

  it("keeps the LOWER BOUND qualifier on the partially-priced case", () => {
    const s = line({ known: 70.15, unpriced: ["a", "b"], pricedRuns: 9, thinnest: 3 });
    expect(s).toMatch(/LOWER BOUND/);
    expect(s).toMatch(/2\/26 scenario\(s\) have no priced run history/);
    expect(s).toMatch(/basis: 9 prior run\(s\)/);
  });

  // Nothing priced at all: claiming "0 prior runs" as a basis would be a basis for nothing. Stay silent
  // rather than emit a confident-looking zero — the LOWER BOUND half already carries the warning.
  it("omits the basis entirely when no scenario has any history", () => {
    const s = line({ known: 0, unpriced: ["a"], pricedRuns: 0, thinnest: undefined }, 1);
    expect(s).toMatch(/LOWER BOUND/);
    expect(s).not.toMatch(/basis:/);
  });

  it("still leads with the number itself", () => {
    expect(line({ known: 114.4096, unpriced: [], pricedRuns: 38, thinnest: 2 })).toMatch(/^estimated batch cost: \$114\.4096/);
  });
});
