// The metric rows' statistics: the exact Wilcoxon–Mann–Whitney rank-sum test, its conditional floor, the
// adversarial completion that guards excluded reps, Hodges–Lehmann, the SD fields and the family rule. Every pin
// is an exact enumeration (or a closed form), never a simulation — the stats.ts purity contract.
import { describe, it, expect } from "vitest";
import {
  wmwExact,
  wmwNullMass,
  hodgesLehmann,
  sampleSd,
  pooledSdInterval95,
  chiSquareQuantile,
  metricRowP,
  evaluateMetricFamily,
  mdsSdUnits,
  type MetricKey,
  type MetricRowInput,
} from "../src/eval/stats.js";

const M = (g: number): MetricKey => ({ level: 2, g });
const W: MetricKey = { level: 1, g: 0 };

/** Every way to pick k of n indices (the brute-force oracle's relabelings). */
function combinations(n: number, k: number): number[][] {
  const out: number[][] = [];
  const rec = (start: number, acc: number[]) => {
    if (acc.length === k) return void out.push([...acc]);
    for (let i = start; i < n; i++) rec(i + 1, [...acc, i]);
  };
  rec(0, []);
  return out;
}

const cmpKey = (x: MetricKey, y: MetricKey) => x.level - y.level || x.g - y.g;

/** Brute-force float oracle: mid-ranks, every relabeling of B's slots, |W − E| ≥ observed within 1e-9. */
function bruteP(a: MetricKey[], b: MetricKey[]): number {
  const pool = [...a, ...b];
  const sorted = [...pool].sort(cmpKey);
  const rank = (x: MetricKey) => {
    const first = sorted.findIndex((y) => cmpKey(x, y) === 0);
    let last = first;
    while (last + 1 < sorted.length && cmpKey(sorted[last + 1], x) === 0) last++;
    return (first + last) / 2 + 1;
  };
  const ranks = pool.map(rank);
  const n2 = b.length;
  const e = (n2 * (pool.length + 1)) / 2;
  const obs = Math.abs(ranks.slice(a.length).reduce((s, r) => s + r, 0) - e);
  const subsets = combinations(pool.length, n2);
  const hits = subsets.filter((s) => Math.abs(s.reduce((acc, i) => acc + ranks[i], 0) - e) >= obs * (1 - 1e-9)).length;
  return hits / subsets.length;
}

/** A fixed pseudo-random sequence (LCG) for the tie patterns: hard-coded, so the test is deterministic. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

describe("wmwExact: the DP equals brute-force enumeration", () => {
  it("over distinct values for every n1, n2 <= 7", () => {
    const rnd = lcg(7);
    for (let n1 = 1; n1 <= 7; n1++)
      for (let n2 = 1; n2 <= 7; n2++) {
        const vals = Array.from({ length: n1 + n2 }, (_, i) => i + rnd() * 0.5);
        const perm = vals
          .map((v) => [rnd(), v])
          .sort((x, y) => x[0] - y[0])
          .map((x) => x[1]);
        const a = perm.slice(0, n1).map(M);
        const b = perm.slice(n1).map(M);
        expect(wmwExact(a, b).p).toBeCloseTo(bruteP(a, b), 12);
      }
  });

  it("over >= 50 tie patterns per size (all tied, two values, a 1–5 score, small counts, worst-ranked reps)", () => {
    const rnd = lcg(42);
    for (let n1 = 2; n1 <= 7; n1++)
      for (let n2 = 2; n2 <= 7; n2++)
        for (let t = 0; t < 50; t++) {
          const draw = (): MetricKey => {
            if (t === 0) return M(3);
            if (t < 10) return M(rnd() < 0.5 ? 0 : 1);
            if (t < 30) return M(1 + Math.floor(rnd() * 5));
            if (t < 45) return M(Math.floor(-Math.log(1 - rnd()) * 3));
            return rnd() < 0.2 ? W : M(Math.floor(rnd() * 4));
          };
          const a = Array.from({ length: n1 }, draw);
          const b = Array.from({ length: n2 }, draw);
          expect(wmwExact(a, b).p).toBeCloseTo(bruteP(a, b), 12);
        }
  });
});

describe("wmwExact: floors and the exact null size", () => {
  const distinct = (n1: number, n2: number) => ({
    a: Array.from({ length: n1 }, (_, i) => M(i)),
    b: Array.from({ length: n2 }, (_, i) => M(100 + i)),
  });
  it.each([
    [3, 3, 0.1],
    [3, 4, 2 / 35],
    [3, 5, 2 / 56],
    [4, 4, 2 / 70],
    [4, 5, 2 / 126],
    [5, 5, 2 / 252],
    [6, 6, 2 / 924],
  ])("no-tie floor %i v %i = %f (a full separation reaches it)", (n1, n2, floor) => {
    const { a, b } = distinct(n1, n2);
    const r = wmwExact(a, b);
    expect(r.floor).toBeCloseTo(floor, 12);
    expect(r.p).toBeCloseTo(floor, 12);
    expect(r.favours).toBe("B");
  });

  it("a constant pool has floor 1 and p 1", () => {
    const r = wmwExact([M(2), M(2), M(2), M(2), M(2)], [M(2), M(2), M(2), M(2), M(2)]);
    expect(r.floor).toBe(1);
    expect(r.p).toBe(1);
    expect(r.favours).toBe("none");
  });

  it("a two-value pool at 5v5 (five 0s, five 1s) has the conditional floor of its tie structure, 2/252", () => {
    // The only splits reaching the extreme put all 1s on one side: 2 of 252.
    expect(wmwExact([M(0), M(0), M(0), M(0), M(0)], [M(1), M(1), M(1), M(1), M(1)]).floor).toBeCloseTo(2 / 252, 12);
    // Six 0s and four 1s: the extreme splits put all four 1s (plus one 0) in B or in A — 2·C(6,1) of 252.
    expect(wmwExact([M(0), M(0), M(0), M(0), M(0)], [M(0), M(1), M(1), M(1), M(1)]).floor).toBeCloseTo(12 / 252, 12);
  });

  it.each([
    [3, 3, 0],
    [3, 4, 0],
    [3, 5, 2],
    [4, 4, 2],
    [4, 5, 4],
    [5, 5, 8],
    [6, 6, 38],
  ])("over every split of %i+%i distinct values, exactly %i give p <= 0.05 (the false-possible rate)", (n1, n2, hits) => {
    const vals = Array.from({ length: n1 + n2 }, (_, i) => M(i));
    const subsets = combinations(n1 + n2, n2);
    const k = subsets.filter((s) => {
      const set = new Set(s);
      return (
        wmwExact(
          vals.filter((_, i) => !set.has(i)),
          s.map((i) => vals[i]),
        ).p <= 0.05
      );
    }).length;
    expect(k).toBe(hits);
  });

  it("wmwNullMass is the same null mass in closed form", () => {
    expect(wmwNullMass(5, 5, 0.05)).toBeCloseTo(8 / 252, 12);
    expect(wmwNullMass(5, 5, 0.025 / 3)).toBeCloseTo(2 / 252, 12);
    expect(wmwNullMass(3, 3, 0.05)).toBe(0);
    expect(wmwNullMass(6, 6, 0.05)).toBeCloseTo(38 / 924, 12);
  });
});

describe("worst rank: strictly beyond every measured value, tied only with other worst-ranked reps", () => {
  it("A = [0,2,3,4,5], B = [1,2,3,4,errored], better: higher, min 0 → p = 0.444, never 0.556", () => {
    const a = [0, 2, 3, 4, 5].map(M);
    const strict = wmwExact(a, [M(1), M(2), M(3), M(4), W]);
    expect(strict.p).toBeCloseTo(112 / 252, 12);
    // The rejected convention (the errored rep tied with a measured value at the bound `min`) gives 0.556.
    const tiedWithMin = wmwExact(a, [M(1), M(2), M(3), M(4), M(0)]);
    expect(tiedWithMin.p).toBeCloseTo(0.5556, 3);
    expect(strict.p).not.toBeCloseTo(tiedWithMin.p, 3);
  });

  it("the crash detector: metric unchanged, A clean, B with e errored reps (5v5), exact over every split", () => {
    // P(`possible worse`) = share of splits of the 10 − e measured values with p <= 0.05 favouring A.
    const expected = [4 / 252, 4 / 126, 4 / 56, 6 / 21, 4 / 6, 1];
    for (let e = 0; e <= 5; e++) {
      const vals = Array.from({ length: 10 - e }, (_, i) => M(i));
      const subsets = combinations(10 - e, 5 - e);
      const worse = subsets.filter((s) => {
        const set = new Set(s);
        const b = [...s.map((i) => vals[i]), ...Array.from({ length: e }, () => W)];
        const r = wmwExact(
          vals.filter((_, i) => !set.has(i)),
          b,
        );
        return r.p <= 0.05 && r.favours === "A";
      }).length;
      expect(worse / subsets.length).toBeCloseTo(expected[e], 12);
    }
  });
});

describe("the crash detector under the DEFAULT metric rule (Holm at alpha/2), computed independently (Fractions)", () => {
  it.each([
    ["m = 1 (level 0.025)", 0.025, [1 / 126, 1 / 63, 1 / 28, 2 / 21, 1 / 2, 1]],
    ["m = 3 (rank-1 level 0.025/3)", 0.025 / 3, [1 / 252, 1 / 126, 1 / 56, 1 / 21, 1 / 6, 1]],
  ])("P(`confirmed worse`) for e = 0…5 errored B reps, %s", (_name, level, expected) => {
    for (let e = 0; e <= 5; e++) {
      const vals = Array.from({ length: 10 - e }, (_, i) => i);
      const subsets = combinations(10 - e, 5 - e);
      const confirmed = subsets.filter((s) => {
        const set = new Set(s);
        const row: MetricRowInput = {
          id: "c",
          better: "higher",
          a: { values: vals.filter((_, i) => !set.has(i)), worst: 0, excluded: 0 },
          b: { values: s.map((i) => vals[i]), worst: e, excluded: 0 },
        };
        return evaluateMetricFamily([row], { rule: "holm", alpha: 0.05, q: 0.1, level, threshold: 4 }).rows[0].label === "confirmed worse";
      }).length;
      expect(confirmed / subsets.length).toBeCloseTo((expected as number[])[e], 12);
    }
  });
});

describe("metricRowP: excluded (class X) reps are guarded by the adversarial completion", () => {
  const row = (a: { values: number[]; worst?: number; excluded?: number }, b: typeof a): Parameters<typeof metricRowP>[0] => ({
    better: "higher",
    a: { values: a.values, worst: a.worst ?? 0, excluded: a.excluded ?? 0 },
    b: { values: b.values, worst: b.worst ?? 0, excluded: b.excluded ?? 0 },
  });

  it("5 A reps above 4 measured B reps with 1 B rep excluded: survivor 0.0159, adversarial 0.151, labelled p 0.151", () => {
    const r = metricRowP(row({ values: [10, 11, 12, 13, 14] }, { values: [1, 2, 3, 4], excluded: 1 }));
    expect(r.survivorP).toBeCloseTo(2 / 126, 12);
    expect(r.adversarialP).toBeCloseTo(0.151, 3);
    expect(r.p).toBeCloseTo(r.adversarialP!, 12);
    expect(r.favours).toBe("A");
  });

  it("no X rep: no adversarial p, labelled p = survivor p", () => {
    const r = metricRowP(row({ values: [10, 11, 12, 13, 14] }, { values: [1, 2, 3, 4, 5] }));
    expect(r.adversarialP).toBeUndefined();
    expect(r.p).toBeCloseTo(2 / 252, 12);
  });

  it("an arm with BOTH an errored rep and an X rep: the adversarial X sits strictly beyond the worst-ranked rep", () => {
    // B favoured on survivors; B's X rep goes to the worst end, BEYOND B's own errored rep (its own tie group).
    const input = row({ values: [1, 2, 3, 4, 5] }, { values: [10, 11, 12], worst: 1, excluded: 1 });
    const r = metricRowP(input);
    expect(r.favours).toBe("B");
    const adversarial = wmwExact([1, 2, 3, 4, 5].map(M), [M(10), M(11), M(12), W, { level: 0, g: 0 }]);
    expect(r.adversarialP).toBeCloseTo(adversarial.p, 12);
    // Tying the X rep with the errored rep (one group) would give a different p: the ordering is load-bearing.
    const tiedWithW = wmwExact([1, 2, 3, 4, 5].map(M), [M(10), M(11), M(12), W, W]);
    expect(adversarial.p).not.toBeCloseTo(tiedWithW.p, 6);
  });

  it("an adversarial completion whose direction flips counts as p = 1", () => {
    // Survivors: B slightly above; B's 3 X reps placed at the worst end flip the direction to A.
    const r = metricRowP(row({ values: [1, 2, 3, 4, 5] }, { values: [6, 7], excluded: 3 }));
    expect(r.favours).toBe("B");
    expect(r.adversarialP).toBe(1);
    expect(r.p).toBe(1);
  });

  it("better: lower maps the goodness score: smaller B values favour B", () => {
    const r = metricRowP({ ...row({ values: [10, 11, 12, 13, 14] }, { values: [1, 2, 3, 4, 5] }), better: "lower" });
    expect(r.favours).toBe("B");
  });
});

describe("the adversarial completion's tied blocks never change a label (the searched range of the stats.ts comment)", () => {
  // A tied block of excluded reps at an extreme is not always the completion with the LARGEST p (distinct values there
  // can give a larger one), so the claim is narrower: over every split of distinct survivors, the label from
  // max(survivor, tied adversarial) equals the label from max(survivor, distinct adversarial) at every level.
  const levels = [0.025 / 3, 0.0125, 0.025, 0.05, 0.1];
  const xSplits: Array<[number, number]> = [
    [0, 2],
    [2, 0],
    [1, 1],
    [0, 3],
    [1, 2],
    [2, 1],
  ];
  const label = (p: number, survivor: number, level: number) => (p <= level ? "flag" : survivor <= level ? "unresolved" : "none");
  it.each([
    [5, 3],
    [5, 4],
    [4, 4],
    [5, 5],
  ])("survivors %i v %i", (n1, n2) => {
    const vals = Array.from({ length: n1 + n2 }, (_, i) => i);
    for (const s of combinations(n1 + n2, n2)) {
      const set = new Set(s);
      const a = vals.filter((_, i) => !set.has(i));
      const b = s.map((i) => vals[i]);
      for (const [xa, xb] of xSplits) {
        const tied = metricRowP({ better: "higher", a: { values: a, worst: 0, excluded: xa }, b: { values: b, worst: 0, excluded: xb } });
        if (tied.adversarialP === undefined) continue;
        // The same completion with each excluded rep distinct (its own key) instead of one tied block.
        let distinctP = 1;
        if (tied.favours !== "none") {
          const favA = tied.favours === "A";
          const worst = (n: number, base: number) => Array.from({ length: n }, (_, i): MetricKey => ({ level: 0, g: base + i }));
          const best = (n: number, base: number) => Array.from({ length: n }, (_, i): MetricKey => ({ level: 3, g: base + i }));
          const adv = wmwExact(
            [...a.map(M), ...(favA ? worst(xa, 0) : best(xa, 0))],
            [...b.map(M), ...(favA ? best(xb, 100) : worst(xb, 100))],
          );
          distinctP = adv.favours === tied.favours ? adv.p : 1;
        }
        for (const lv of levels)
          expect(label(Math.max(tied.survivorP, distinctP), tied.survivorP, lv)).toBe(label(tied.p, tied.survivorP, lv));
      }
    }
  });
});

describe("hodgesLehmann", () => {
  it("a hand-computed 5v5 case: shift 2, interval [D(3), D(23)] = [-1, 5], coverage 0.968", () => {
    const hl = hodgesLehmann([1, 2, 3, 4, 5], [3, 4, 5, 6, 7])!;
    expect(hl.shift).toBe(2);
    expect(hl.lower).toBe(-1);
    expect(hl.upper).toBe(5);
    expect(hl.k).toBe(3);
    expect(hl.coverage).toBeCloseTo(1 - 8 / 252, 12);
  });

  it.each([
    [4, 4, 1, 1 - 2 / 70],
    [4, 5, 2, 0.968],
    [5, 5, 3, 0.968],
    [6, 6, 6, 0.959],
    [3, 3, 1, 0.9],
  ])("%i v %i picks k = %i (coverage %f): the smallest coverage >= 0.95, or k = 1 when none reaches it", (n1, n2, k, cov) => {
    const hl = hodgesLehmann(
      Array.from({ length: n1 }, (_, i) => i),
      Array.from({ length: n2 }, (_, i) => i * 1.5),
    )!;
    expect(hl.k).toBe(k);
    expect(hl.coverage).toBeCloseTo(cov, 3);
  });

  it("undefined when an arm has no measured value", () => {
    expect(hodgesLehmann([], [1, 2])).toBeUndefined();
  });
});

describe("SD fields", () => {
  it("sampleSd uses n − 1; undefined below two values", () => {
    expect(sampleSd([1, 2, 3, 4, 5])).toBeCloseTo(Math.sqrt(2.5), 12);
    expect(sampleSd([7])).toBeUndefined();
  });

  it("chi-square quantiles match the published table", () => {
    expect(chiSquareQuantile(0.975, 8)).toBeCloseTo(17.5345, 3);
    expect(chiSquareQuantile(0.025, 8)).toBeCloseTo(2.17973, 4);
    expect(chiSquareQuantile(0.975, 4)).toBeCloseTo(11.1433, 3);
    expect(chiSquareQuantile(0.025, 3)).toBeCloseTo(0.215795, 4);
  });

  it.each([
    [4, 0.6, 2.87],
    [8, 0.68, 1.92],
    [3, 0.57, 3.73],
    [10, 0.7, 1.76],
  ])("the 95%% interval's factor on s at df = %i is [%f, %f] (to the design's two decimals)", (df, lo, hi) => {
    const i = pooledSdInterval95(1, df)!;
    expect(Math.abs(i.lower - lo)).toBeLessThan(0.006);
    expect(Math.abs(i.upper - hi)).toBeLessThan(0.006);
  });
});

describe("mdsSdUnits: the offline normal-shift table, keyed by n and the attainable p threshold", () => {
  it.each([
    [5, 0.05, 2.4],
    [5, 0.025, 2.8],
    [5, 0.025 / 3, 3.2],
    [6, 0.05, 2.0],
    [6, 0.025, 2.4],
    [6, 0.025 / 3, 3.0],
    [6, 0.01, 2.6],
    [4, 0.05, 3.0],
  ])("n = %i, level %f → %f SD", (n, level, sd) => {
    expect(mdsSdUnits(n, level)).toBe(sd);
  });
  it("undefined when nothing attainable is <= the level, or n is outside the table", () => {
    expect(mdsSdUnits(4, 0.025)).toBeUndefined();
    expect(mdsSdUnits(3, 0.05)).toBeUndefined();
    expect(mdsSdUnits(7, 0.05)).toBeUndefined();
  });
});

describe("evaluateMetricFamily", () => {
  const sep = (better: "higher" | "lower" = "higher"): MetricRowInput => ({
    id: "m",
    better,
    a: { values: [10, 11, 12, 13, 14], worst: 0, excluded: 0 },
    b: { values: [1, 2, 3, 4, 5], worst: 0, excluded: 0 },
  });
  const holm = (F: number) => ({ rule: "holm" as const, alpha: 0.05, q: 0.1, level: 0.05 / F, threshold: 4 });
  const bh = { rule: "bh" as const, alpha: 0.05, q: 0.1, level: 0.1, threshold: 4 };

  it("direction: better: lower with B smaller is `better`; the same data under higher is `worse`; numericDirection is the same", () => {
    const lower = evaluateMetricFamily([sep("lower")], holm(1)).rows[0];
    const higher = evaluateMetricFamily([sep("higher")], holm(1)).rows[0];
    expect(lower.direction).toBe("better");
    expect(higher.direction).toBe("worse");
    expect(lower.numericDirection).toBe("down");
    expect(higher.numericDirection).toBe("down");
    expect(higher.label).toBe("confirmed worse");
  });

  it("a constant metric is `underpowered` (every value tied), never `no detectable change`, and stays in m", () => {
    const c: MetricRowInput = {
      id: "c",
      better: "higher",
      a: { values: [3, 3, 3, 3, 3], worst: 0, excluded: 0 },
      b: { values: [3, 3, 3, 3, 3], worst: 0, excluded: 0 },
    };
    const out = evaluateMetricFamily([c, { ...sep(), id: "s" }], holm(1));
    expect(out.rows[0].label).toBe("underpowered");
    expect(out.rows[0].floor).toBe(1);
    expect(out.m).toBe(2);
  });

  it("fewer than threshold tested reps (excluded reps do not count) → insufficient, out of m", () => {
    const r: MetricRowInput = {
      id: "i",
      better: "higher",
      a: { values: [1, 2, 3, 4, 5], worst: 0, excluded: 0 },
      b: { values: [1, 2, 3], worst: 0, excluded: 2 },
    };
    const out = evaluateMetricFamily([r], holm(1));
    expect(out.rows[0].label).toBe("insufficient");
    expect(out.m).toBe(0);
  });

  it("survivor p <= alpha but the guarded p > alpha → `unresolved`, in m, never gating", () => {
    const r: MetricRowInput = {
      id: "u",
      better: "higher",
      a: { values: [10, 11, 12, 13, 14], worst: 0, excluded: 0 },
      b: { values: [1, 2, 3, 4], worst: 0, excluded: 1 },
    };
    const out = evaluateMetricFamily([r], holm(1));
    expect(out.rows[0].label).toBe("unresolved");
    expect(out.rows[0].survivorP).toBeCloseTo(2 / 126, 12);
    expect(out.m).toBe(1);
  });

  it("Holm at alpha/2: one row at the floor confirms when m <= 3, not at m = 4 (5v5)", () => {
    const rows = (m: number) => Array.from({ length: m }, (_, i) => ({ ...sep(), id: `m${i}` }));
    expect(evaluateMetricFamily(rows(3), holm(2)).rows.every((r) => r.label === "confirmed worse")).toBe(true);
    expect(evaluateMetricFamily(rows(4), holm(2)).rows.every((r) => r.label === "possible worse")).toBe(true);
    expect(evaluateMetricFamily(rows(3), holm(2)).minRowsToConfirm).toBe(1);
    expect(evaluateMetricFamily(rows(4), holm(2)).minRowsToConfirm).toBeNull();
  });

  it("BH confirmation also needs p <= alpha (a p between alpha and q is never confirmed)", () => {
    // B's rank sum 37 at 5v5: p = 14/252 = 0.0556, above alpha, below q.
    const r: MetricRowInput = {
      id: "x",
      better: "higher",
      a: { values: [1, 2, 4, 5, 6], worst: 0, excluded: 0 },
      b: { values: [3, 7, 8, 9, 10], worst: 0, excluded: 0 },
    };
    const out = evaluateMetricFamily([r], bh).rows[0];
    expect(out.p).toBeGreaterThan(0.05);
    expect(out.p).toBeLessThan(0.1);
    expect(out.label).toBe("no detectable change");
  });

  it("the family A/A pins, from the label function over the enumerated 5v5 p distribution", () => {
    // P(a single null row is confirmed) under each rule, exactly; three independent rows compose.
    const vals = Array.from({ length: 10 }, (_, i) => i);
    const subsets = combinations(10, 5);
    const confirmRate = (o: Parameters<typeof evaluateMetricFamily>[1], m: number) => {
      // Holm's / BH's any-confirm over m independent null rows = 1 − (1 − P(row p <= the rank-1 level))^m.
      const rank1 = o.rule === "holm" ? o.level / m : Math.min(o.alpha, o.q / m);
      const single =
        subsets.filter((s) => {
          const set = new Set(s);
          const row: MetricRowInput = {
            id: "n",
            better: "higher",
            a: { values: vals.filter((_, i) => !set.has(i)), worst: 0, excluded: 0 },
            b: { values: s.map((i) => vals[i]), worst: 0, excluded: 0 },
          };
          return evaluateMetricFamily([row], { ...o, level: o.rule === "holm" ? rank1 : o.level }).rows[0].label.startsWith("confirmed");
        }).length / subsets.length;
      return 1 - (1 - single) ** m;
    };
    expect(confirmRate(holm(2), 3)).toBeCloseTo(1 - (1 - 2 / 252) ** 3, 12);
    expect(confirmRate(bh, 3)).toBeCloseTo(1 - (1 - 8 / 252) ** 3, 12);
    expect(1 - (1 - 2 / 252) ** 3).toBeCloseTo(0.0236, 4);
    expect(1 - (1 - 8 / 252) ** 3).toBeCloseTo(0.0922, 4);
  });

  it("mds: possible at alpha, confirmed at the family's single-row level, in units of the pooled SD", () => {
    const out = evaluateMetricFamily([sep()], holm(2)).rows[0];
    expect(out.mds?.possible.sdUnits).toBe(2.4);
    expect(out.mds?.confirmed?.sdUnits).toBe(2.8);
    expect(out.mds?.possible.units).toBeCloseTo(2.4 * out.pooledSd!, 12);
  });

  it('no mds when every measured value is equal (SD 0): no scale, never "≈ 0"', () => {
    const r: MetricRowInput = {
      id: "z",
      better: "lower",
      a: { values: [5, 5, 5, 5, 5], worst: 0, excluded: 0 },
      b: { values: [5, 5, 5, 5, 5], worst: 0, excluded: 0 },
    };
    const out = evaluateMetricFamily([r], holm(2)).rows[0];
    expect(out.pooledSd).toBe(0);
    expect(out.mds).toBeUndefined();
  });

  it("mds at unequal arms uses the smaller arm (conservative) and says so", () => {
    const r: MetricRowInput = {
      id: "u",
      better: "higher",
      a: { values: [1, 2, 3, 4, 5], worst: 0, excluded: 0 },
      b: { values: [1, 2, 3, 4], worst: 0, excluded: 0 },
    };
    const out = evaluateMetricFamily([r], holm(1)).rows[0];
    expect(out.mds?.n).toBe(4);
    expect(out.mds?.possible.sdUnits).toBe(3.0);
  });
});
