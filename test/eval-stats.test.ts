// Paired-evaluation statistics: every expected value below was computed independently (exact rational
// arithmetic over the hypergeometric, Python `fractions`) or taken from a published worked example, never
// from this module's own output.
import { describe, it, expect } from "vitest";
import {
  fisherTwoSided,
  wilsonInterval,
  newcombeDifference,
  bhAdjust,
  holmAdjust,
  attainableFloor,
  minRowsToConfirm,
  confirmableRowCount,
  minimumDetectableDifference,
  insufficientThreshold,
  labelRow,
  evaluateFamily,
  ceilingRowCount,
  zeroRowCount,
} from "../src/eval/stats.js";

describe("fisherTwoSided — sum of tables no more probable than the observed one", () => {
  it("3/3 vs 0/3 is exactly 1/10 (the floor at n = 3 is above alpha)", () => {
    expect(fisherTwoSided(3, 3, 0, 3)).toBeCloseTo(0.1, 12);
  });
  it("5/5 vs 0/5 is exactly 1/126", () => {
    expect(fisherTwoSided(5, 5, 0, 5)).toBeCloseTo(1 / 126, 12);
    expect(fisherTwoSided(5, 5, 0, 5)).toBeCloseTo(0.0079365079, 9);
  });
  it("4/5 vs 0/5 is exactly 1/21", () => {
    expect(fisherTwoSided(4, 5, 0, 5)).toBeCloseTo(1 / 21, 12);
  });
  it("is symmetric in arm order and in success/failure labelling", () => {
    expect(fisherTwoSided(0, 5, 5, 5)).toBeCloseTo(1 / 126, 12);
    expect(fisherTwoSided(1, 5, 5, 5)).toBeCloseTo(1 / 21, 12);
    expect(fisherTwoSided(1, 5, 4, 5)).toBeCloseTo(fisherTwoSided(4, 5, 1, 5), 12);
  });
  it("the mirror table of a symmetric collapse is counted (the tolerance exists for exactly this)", () => {
    // 5/5 vs 0/5 and 0/5 vs 5/5 have the same probability 1/252; the two-sided p is their sum. A strict `<`
    // without tolerance can drop the mirror when the two float products differ in the last ulp.
    expect(fisherTwoSided(5, 5, 0, 5)).toBeCloseTo(2 / 252, 12);
    expect(fisherTwoSided(7, 7, 0, 7)).toBeCloseTo(1 / 1716, 12);
    expect(fisherTwoSided(6, 6, 0, 6)).toBeCloseTo(1 / 462, 12);
  });
  it("counts a table whose exact probability equals the observed one but whose float value is 1 ulp higher", () => {
    // Found by search: without the relative tolerance these come out at roughly half their exact value.
    expect(fisherTwoSided(0, 2, 5, 8)).toBeCloseTo(4 / 9, 12);
    expect(fisherTwoSided(0, 2, 7, 12)).toBeCloseTo(6 / 13, 12);
    expect(fisherTwoSided(0, 1, 4, 7)).toBeCloseTo(1, 12);
    expect(fisherTwoSided(0, 2, 2, 5)).toBeCloseTo(1, 12);
  });
  it("asymmetric margins: 4/5 vs 1/4 is 13/63 by sum-of-tables, NOT 2x one-sided (1/3)", () => {
    const p = fisherTwoSided(4, 5, 1, 4);
    expect(p).toBeCloseTo(13 / 63, 12);
    expect(p).not.toBeCloseTo(1 / 3, 3);
  });
  it("equal rates give p = 1", () => {
    expect(fisherTwoSided(3, 5, 3, 5)).toBeCloseTo(1, 12);
    expect(fisherTwoSided(5, 5, 5, 5)).toBeCloseTo(1, 12);
    expect(fisherTwoSided(0, 4, 0, 5)).toBeCloseTo(1, 12);
  });
  it("rejects impossible tables", () => {
    expect(() => fisherTwoSided(6, 5, 0, 5)).toThrow();
    expect(() => fisherTwoSided(-1, 5, 0, 5)).toThrow();
    expect(() => fisherTwoSided(1.5, 5, 0, 5)).toThrow();
    expect(() => fisherTwoSided(0, 0, 0, 5)).toThrow();
  });
});

describe("Wilson / Newcombe (method 10) interval for a difference of proportions", () => {
  it("Wilson score interval for a single proportion", () => {
    // 0/10: (0, 0.2775); 10/10: (0.7225, 1). Newcombe 1998 builds method 10 from these.
    const w0 = wilsonInterval(0, 10);
    expect(w0.lower).toBeCloseTo(0, 12);
    expect(w0.upper).toBeCloseTo(0.2775, 4);
    const w10 = wilsonInterval(10, 10);
    expect(w10.lower).toBeCloseTo(0.7225, 4);
    expect(w10.upper).toBeCloseTo(1, 12);
  });
  // Newcombe RG. "Interval estimation for the difference between independent proportions: comparison of
  // eleven methods." Statistics in Medicine 1998;17:873-890, Table II, method 10 (score interval without
  // continuity correction). Each row is (k1/n1, k2/n2) -> (lower, upper) for p1 - p2, to 4 decimals.
  const table2: Array<[number, number, number, number, number, number]> = [
    [56, 70, 48, 80, 0.0524, 0.3339], // (a)
    [9, 10, 3, 10, 0.1705, 0.809], // (b)
    [6, 7, 2, 7, 0.0582, 0.8062], // (c)
    [5, 56, 0, 29, -0.0381, 0.1926], // (d)
    [0, 10, 0, 20, -0.1611, 0.2775], // (e)
    [0, 10, 0, 10, -0.2775, 0.2775], // (f)
    [10, 10, 0, 20, 0.6791, 1.0], // (g)
    [10, 10, 0, 10, 0.6075, 1.0], // (h)
  ];
  for (const [k1, n1, k2, n2, lo, hi] of table2) {
    it(`Newcombe 1998 Table II: ${k1}/${n1} - ${k2}/${n2} -> (${lo}, ${hi})`, () => {
      const r = newcombeDifference(k1, n1, k2, n2);
      expect(r.difference).toBeCloseTo(k1 / n1 - k2 / n2, 12);
      expect(r.lower).toBeCloseTo(lo, 4);
      expect(r.upper).toBeCloseTo(hi, 4);
    });
  }
  it("the interval always contains the point estimate and stays within [-1, 1]", () => {
    for (const [k1, n1, k2, n2] of [
      [5, 5, 0, 5],
      [0, 5, 5, 5],
      [3, 4, 2, 5],
      [1, 1, 0, 1],
    ]) {
      const r = newcombeDifference(k1, n1, k2, n2);
      expect(r.lower).toBeLessThanOrEqual(r.difference);
      expect(r.upper).toBeGreaterThanOrEqual(r.difference);
      expect(r.lower).toBeGreaterThanOrEqual(-1);
      expect(r.upper).toBeLessThanOrEqual(1);
    }
  });
});

describe("multiple-comparison corrections within a family", () => {
  it("BH step-up adjusted p-values, returned in input order", () => {
    // sorted: 0.01 (i=1), 0.02 (2), 0.03 (3), 0.5 (4); m = 4. raw i-th: 0.04, 0.04, 0.04, 0.5.
    const adj = bhAdjust([0.5, 0.01, 0.03, 0.02]);
    expect(adj[0]).toBeCloseTo(0.5, 12);
    expect(adj[1]).toBeCloseTo(0.04, 12);
    expect(adj[2]).toBeCloseTo(0.04, 12);
    expect(adj[3]).toBeCloseTo(0.04, 12);
  });
  it("BH enforces monotonicity from the top (a larger p never gets a smaller adjusted value)", () => {
    // sorted 0.01, 0.04, 0.045; m = 3: raw 0.03, 0.06, 0.045 -> cummin from top: 0.03, 0.045, 0.045.
    const adj = bhAdjust([0.045, 0.01, 0.04]);
    expect(adj).toEqual([expect.closeTo(0.045, 12), expect.closeTo(0.03, 12), expect.closeTo(0.045, 12)]);
  });
  it("BH gives tied p-values identical adjusted values", () => {
    const adj = bhAdjust([1 / 126, 1 / 126, 0.5, 1]);
    expect(adj[0]).toBe(adj[1]);
    // raw i-th values 4/126 (i = 1) and 2/126 (i = 2); the cumulative minimum from the top binds both at 2/126.
    expect(adj[0]).toBeCloseTo(2 / 126, 12);
  });
  it("Holm step-down adjusted p-values, returned in input order", () => {
    // sorted 0.01, 0.02, 0.03, 0.5; m = 4: 0.04, 0.06, 0.06, 0.5 (cummax).
    const adj = holmAdjust([0.5, 0.01, 0.03, 0.02]);
    expect(adj[0]).toBeCloseTo(0.5, 12);
    expect(adj[1]).toBeCloseTo(0.04, 12);
    expect(adj[2]).toBeCloseTo(0.06, 12);
    expect(adj[3]).toBeCloseTo(0.06, 12);
  });
  it("Holm gives tied p-values identical adjusted values and caps at 1", () => {
    const adj = holmAdjust([0.4, 0.4, 0.9]);
    expect(adj[0]).toBe(adj[1]);
    expect(adj[0]).toBeCloseTo(1, 12);
    expect(adj[2]).toBeCloseTo(1, 12);
  });
  it("an empty family adjusts to nothing", () => {
    expect(bhAdjust([])).toEqual([]);
    expect(holmAdjust([])).toEqual([]);
  });
});

describe("attainable-p floor", () => {
  it("equal arms", () => {
    expect(attainableFloor(1, 1)).toBeCloseTo(1, 12);
    expect(attainableFloor(2, 2)).toBeCloseTo(1 / 3, 12);
    expect(attainableFloor(3, 3)).toBeCloseTo(0.1, 12);
    expect(attainableFloor(4, 4)).toBeCloseTo(1 / 35, 12);
    expect(attainableFloor(5, 5)).toBeCloseTo(1 / 126, 12);
  });
  it("n1 != n2 is computed by enumeration, not by the smaller arm", () => {
    expect(attainableFloor(5, 4)).toBeCloseTo(1 / 126, 12);
    expect(attainableFloor(4, 5)).toBeCloseTo(1 / 126, 12);
    expect(attainableFloor(5, 3)).toBeCloseTo(1 / 56, 12);
    expect(attainableFloor(4, 3)).toBeCloseTo(1 / 35, 12);
    expect(attainableFloor(6, 5)).toBeCloseTo(1 / 462, 12);
  });
});

describe("reachability of `confirmed`", () => {
  const floor5 = 1 / 126;
  const BH = { correction: "bh", q: 0.1, alpha: 0.05 } as const;
  const HOLM = { correction: "holm", q: 0.1, alpha: 0.05 } as const;
  it("BH q = 0.10 at n = 5: one collapse confirms alone up to m = 12, two are needed from m = 13 to 25", () => {
    expect(minRowsToConfirm(floor5, 12, BH)).toBe(1);
    expect(minRowsToConfirm(floor5, 13, BH)).toBe(2);
    expect(minRowsToConfirm(floor5, 25, BH)).toBe(2);
    expect(minRowsToConfirm(floor5, 27, BH)).toBe(3);
  });
  it("Holm alpha = 0.05 at m = 25: unreachable at n = 5 and n = 6, reachable at n = 7", () => {
    expect(minRowsToConfirm(attainableFloor(5, 5), 25, HOLM)).toBeNull();
    expect(minRowsToConfirm(attainableFloor(6, 6), 25, HOLM)).toBeNull();
    expect(minRowsToConfirm(attainableFloor(7, 7), 25, HOLM)).toBe(1);
  });
  it("a floor above alpha is unreachable at any m, even where BH's q alone would admit it", () => {
    expect(minRowsToConfirm(0.05, 1, BH)).toBe(1); // exactly at alpha counts
    expect(minRowsToConfirm(0.1, 1, BH)).toBeNull(); // p <= q but p > alpha: `confirmed` implies `possible`
    expect(minRowsToConfirm(attainableFloor(3, 3), 1, BH)).toBeNull();
    expect(minRowsToConfirm(floor5, 0, BH)).toBeNull();
  });
  it("counts the rows that could reach `confirmed` if each sat at its own floor", () => {
    // 13 rows at n = 5 under BH q = 0.10: all 13 at the floor pass (13th threshold = 0.10 >= 1/126).
    expect(confirmableRowCount(Array(13).fill(floor5), BH)).toBe(13);
    // the 25th BH threshold is 25*0.1/25 = 0.1: a row with floor 0.04 passes it, one with floor 0.1 is
    // still out because its p could never be <= alpha, and one with floor 0.2 fails the threshold itself.
    expect(confirmableRowCount([...Array(24).fill(floor5), 0.04], BH)).toBe(25);
    expect(confirmableRowCount([...Array(24).fill(floor5), 0.1], BH)).toBe(24);
    expect(confirmableRowCount([...Array(24).fill(floor5), 0.2], BH)).toBe(24);
    // Holm at m = 25, alpha = 0.05: rank 1 needs 0.002 > 1/126, so nothing is confirmable.
    expect(confirmableRowCount(Array(25).fill(floor5), HOLM)).toBe(0);
    expect(confirmableRowCount(Array(25).fill(attainableFloor(7, 7)), HOLM)).toBe(25);
    expect(confirmableRowCount([], BH)).toBe(0);
  });
});

describe("minimum detectable difference by discrete search (n = 5, alpha = 0.05)", () => {
  it("k1 = 5: k2 in {0, 1} reach alpha, so the drop MDD is 0.8; a rise is impossible", () => {
    const m = minimumDetectableDifference(5, 5, 5, 0.05);
    expect(m.drop).toBeCloseTo(0.8, 12);
    expect(m.rise).toBe("n/a");
  });
  it("k1 = 4: only k2 = 0 reaches alpha, so the drop MDD is 0.8; no rise reaches it", () => {
    const m = minimumDetectableDifference(4, 5, 5, 0.05);
    expect(m.drop).toBeCloseTo(0.8, 12);
    expect(m.rise).toBe("none");
  });
  it("k1 = 3: no k2 reaches alpha in either direction", () => {
    const m = minimumDetectableDifference(3, 5, 5, 0.05);
    expect(m.drop).toBe("none");
    expect(m.rise).toBe("none");
  });
  it("k1 = 0 is a rise-only MDD (a drop is impossible): 0/5 vs 4/5 reaches alpha", () => {
    const m = minimumDetectableDifference(0, 5, 5, 0.05);
    expect(m.drop).toBe("n/a");
    expect(m.rise).toBeCloseTo(0.8, 12);
  });
  it("k1 = 1 is the mirror of k1 = 4", () => {
    const m = minimumDetectableDifference(1, 5, 5, 0.05);
    expect(m.drop).toBe("none");
    expect(m.rise).toBeCloseTo(0.8, 12);
  });
  it("n = 3 has no detectable difference at all", () => {
    expect(minimumDetectableDifference(3, 3, 3, 0.05)).toEqual({ drop: "none", rise: "n/a" });
  });
});

describe("insufficient threshold", () => {
  it("is max(2, min(4, reps - 1))", () => {
    expect(insufficientThreshold(1, false)).toBe(2);
    expect(insufficientThreshold(2, false)).toBe(2);
    expect(insufficientThreshold(3, false)).toBe(2);
    expect(insufficientThreshold(4, false)).toBe(3); // one infra error cannot kill --reps 4
    expect(insufficientThreshold(5, false)).toBe(4);
    expect(insufficientThreshold(10, false)).toBe(4);
  });
  it("allowUnderpowered lowers it to one valid rep per arm at every reps", () => {
    for (const reps of [1, 2, 3, 4, 5, 10]) {
      expect(insufficientThreshold(reps, true)).toBe(1);
      expect(insufficientThreshold(reps, true)).toBeLessThanOrEqual(insufficientThreshold(reps, false));
    }
  });
});

describe("row labels", () => {
  const base = { alpha: 0.05, level: 0.1, threshold: 4 };
  it("insufficient when either arm has fewer valid reps than the threshold", () => {
    expect(labelRow({ ...base, k1: 3, n1: 3, k2: 0, n2: 5, p: 0.01, adjustedP: 0.01 }).label).toBe("insufficient");
    expect(labelRow({ ...base, k1: 5, n1: 5, k2: 0, n2: 3, p: 0.01, adjustedP: 0.01 }).label).toBe("insufficient");
  });
  it("confirmed drop / rise when the corrected value is within the level", () => {
    expect(labelRow({ ...base, k1: 5, n1: 5, k2: 0, n2: 5, p: 1 / 126, adjustedP: 0.09 })).toMatchObject({
      label: "confirmed drop",
      direction: "drop",
    });
    expect(labelRow({ ...base, k1: 0, n1: 5, k2: 5, n2: 5, p: 1 / 126, adjustedP: 0.1 })).toMatchObject({
      label: "confirmed rise",
      direction: "rise",
    });
  });
  it("possible drop / rise on the unadjusted p when the corrected one misses", () => {
    expect(labelRow({ ...base, k1: 5, n1: 5, k2: 0, n2: 5, p: 1 / 126, adjustedP: 0.2 }).label).toBe("possible drop");
    expect(labelRow({ ...base, k1: 1, n1: 5, k2: 5, n2: 5, p: 1 / 21, adjustedP: 0.3 }).label).toBe("possible rise");
  });
  it("`confirmed` implies `possible`: a corrected value within q never confirms a p above alpha", () => {
    // m = 1 under BH: adjusted p = p = 0.1 <= q = 0.10, but 0.1 > alpha = 0.05.
    expect(labelRow({ ...base, threshold: 2, k1: 3, n1: 3, k2: 0, n2: 3, p: 0.1, adjustedP: 0.1 }).label).toBe("no detectable change");
  });
  it("no detectable change otherwise; a tie has no direction even if a p were small", () => {
    expect(labelRow({ ...base, k1: 5, n1: 5, k2: 3, n2: 5, p: 0.44, adjustedP: 0.9 })).toMatchObject({
      label: "no detectable change",
      direction: "drop",
    });
    expect(labelRow({ ...base, k1: 4, n1: 5, k2: 4, n2: 5, p: 1, adjustedP: 1 })).toMatchObject({
      label: "no detectable change",
      direction: "none",
    });
  });
  it("reports whether this row's own floor exceeds alpha (a `no detectable change` there is untestable)", () => {
    const r3 = labelRow({ ...base, threshold: 2, k1: 3, n1: 3, k2: 0, n2: 3, p: 0.1, adjustedP: 0.1 });
    expect(r3.label).toBe("no detectable change");
    expect(r3.floor).toBeCloseTo(0.1, 12);
    expect(r3.floorExceedsAlpha).toBe(true);
    const r5 = labelRow({ ...base, k1: 5, n1: 5, k2: 5, n2: 5, p: 1, adjustedP: 1 });
    expect(r5.floorExceedsAlpha).toBe(false);
  });
});

describe("evaluateFamily", () => {
  it("computes p, corrects within the testable rows only, and labels each row", () => {
    const rows = [
      { id: "collapse", k1: 5, n1: 5, k2: 0, n2: 5 },
      { id: "flat", k1: 5, n1: 5, k2: 5, n2: 5 },
      { id: "short", k1: 3, n1: 3, k2: 0, n2: 3 }, // insufficient at reps 5 -> not in the family
    ];
    const out = evaluateFamily(rows, { correction: "bh", q: 0.1, alpha: 0.05, threshold: 4 });
    const byId = Object.fromEntries(out.rows.map((r) => [r.id, r]));
    expect(out.m).toBe(2);
    expect(byId.collapse.p).toBeCloseTo(1 / 126, 12);
    expect(byId.collapse.adjustedP).toBeCloseTo(2 / 126, 12);
    expect(byId.collapse.label).toBe("confirmed drop");
    expect(byId.collapse.interval?.difference).toBeCloseTo(-1, 12); // B - A
    expect(byId.flat.label).toBe("no detectable change");
    expect(byId.short.label).toBe("insufficient");
    expect(byId.short.adjustedP).toBeUndefined();
    expect(byId.collapse.mdd?.drop).toBeCloseTo(0.8, 12);
  });
  it("a lone collapse among 13 rows at n = 5 is only `possible` under BH q = 0.10", () => {
    const rows = [
      { id: "collapse", k1: 5, n1: 5, k2: 0, n2: 5 },
      ...Array.from({ length: 12 }, (_, i) => ({ id: `flat${i}`, k1: 5, n1: 5, k2: 5, n2: 5 })),
    ];
    const out = evaluateFamily(rows, { correction: "bh", q: 0.1, alpha: 0.05, threshold: 4 });
    expect(out.rows[0].label).toBe("possible drop");
    expect(out.minRowsToConfirm).toBe(2);
  });
  it("Holm uses alpha as its level", () => {
    const rows = [
      { id: "a", k1: 5, n1: 5, k2: 0, n2: 5 },
      { id: "b", k1: 5, n1: 5, k2: 5, n2: 5 },
    ];
    const out = evaluateFamily(rows, { correction: "holm", q: 0.1, alpha: 0.05, threshold: 4 });
    expect(out.rows[0].adjustedP).toBeCloseTo(2 / 126, 12);
    expect(out.rows[0].label).toBe("confirmed drop");
  });
  it("an empty family is well-defined", () => {
    const out = evaluateFamily([], { correction: "bh", q: 0.1, alpha: 0.05, threshold: 4 });
    expect(out).toMatchObject({ m: 0, rows: [], minRowsToConfirm: null, confirmableRows: 0 });
  });
});

describe("ceiling and floor lines", () => {
  it("counts rows at 100% in both arms, and rows at 0% in both arms", () => {
    const rows = [
      { k1: 5, n1: 5, k2: 5, n2: 5 },
      { k1: 4, n1: 4, k2: 5, n2: 5 },
      { k1: 5, n1: 5, k2: 4, n2: 5 },
      { k1: 0, n1: 5, k2: 0, n2: 5 },
      { k1: 0, n1: 0, k2: 0, n2: 0 }, // no valid reps: neither a ceiling nor a floor
    ];
    expect(ceilingRowCount(rows)).toBe(2);
    expect(zeroRowCount(rows)).toBe(1);
  });
});
