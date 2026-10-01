// The eval planner's pure estimator. Every expected number below was computed OUTSIDE this module: the
// power and N figures by an independent enumeration over `fisherTwoSided` (a throwaway script, 2026-10-01,
// pinned again here as literals), the MDD figures from `minimumDetectableDifference` directly, and the cost
// percentiles by hand. None is the function under test checking itself.
import { describe, it, expect } from "vitest";
import { attainableFloor, minimumDetectableDifference, wilsonInterval, type Mdd } from "../src/eval/stats.js";
import {
  HISTORY_WINDOW,
  THIN_BELOW,
  POWER_TARGET,
  EXACT_CONTENT_MIN,
  cachedMdd,
  confirmedSingleRowLevel,
  estimateScheduleCost,
  perRepCost,
  planRow,
  powerAt,
  projectedK1,
  pValueMatrixBuilds,
  resetPlannerCaches,
  scheduleCostJson,
  scheduleCostLine,
  sequentialPreview,
  type CostHistory,
  type RowPlanOptions,
} from "../src/eval/planner.js";

const history = (scenario: string, agent: number[], extra: Partial<CostHistory> = {}): CostHistory => ({
  scenario,
  samples: agent.map((agentUsd) => ({ agentUsd })),
  budgetGateWorstUsd: agent.length ? Math.max(...agent) : undefined,
  budgetGatePricedRuns: agent.length,
  distinctSkillHashes: 1,
  distinctTiers: 1,
  ...extra,
});

const opts = (o: Partial<RowPlanOptions> = {}): RowPlanOptions => ({
  reps: 5,
  alpha: 0.05,
  correction: "holm",
  q: 0.1,
  m: 7,
  minReps: 4,
  maxReps: 100,
  ...o,
});

describe("constants", () => {
  it("are the documented values, each one named export", () => {
    expect(HISTORY_WINDOW).toBe(50);
    expect(THIN_BELOW).toBe(5);
    expect(POWER_TARGET).toBe(0.8);
    expect(EXACT_CONTENT_MIN).toBe(5);
  });
});

describe("perRepCost — percentiles by hand", () => {
  it("[1,2,3,4,5]: p50 3, p95 5, mean 3, worst 5 on the cost basis; the gate figure carried apart", () => {
    const c = perRepCost(history("s", [5, 1, 4, 2, 3], { budgetGateWorstUsd: 8 }));
    expect(c).toMatchObject({
      pricedRuns: 5,
      p50Usd: 3,
      p95Usd: 5,
      meanUsd: 3,
      worstObservedUsd: 5,
      budgetGateWorstUsd: 8,
      thin: false,
      p95IsMax: true,
    });
  });

  it("[0.2]: p50 = p95 = 0.2, thin", () => {
    const c = perRepCost(history("s", [0.2]));
    expect(c).toMatchObject({ pricedRuns: 1, p50Usd: 0.2, p95Usd: 0.2, meanUsd: 0.2, thin: true });
  });

  it("p95 stops being the max above 20 runs (floor index)", () => {
    const xs = Array.from({ length: 21 }, (_, i) => i + 1); // 1..21
    const c = perRepCost(history("s", xs));
    expect(c.p95Usd).toBe(20); // floor(0.95 * 21) = 19 -> 20
    expect(c.p95IsMax).toBe(false);
  });

  it("unpriced samples are skipped, never counted as $0; judge figures are separate", () => {
    const h: CostHistory = {
      ...history("s", []),
      samples: [{ agentUsd: 2, judgeUsd: 0.1 }, { agentUsd: undefined, judgeUsd: 0.3 }, { agentUsd: 4 }],
      budgetGateWorstUsd: 4,
      budgetGatePricedRuns: 2,
    };
    const c = perRepCost(h);
    expect(c.pricedRuns).toBe(2);
    expect(c.meanUsd).toBe(3);
    expect(c.judgePricedRuns).toBe(2);
    expect(c.judgeUnpriced).toBe(1);
    expect(c.judgeMeanUsd).toBeCloseTo(0.2, 12);
  });

  it("no history: every figure absent, thin", () => {
    const c = perRepCost(history("s", []));
    expect(c.pricedRuns).toBe(0);
    expect(c.p50Usd).toBeUndefined();
    expect(c.worstObservedUsd).toBeUndefined();
    expect(c.thin).toBe(true);
  });
});

describe("estimateScheduleCost", () => {
  const a = history("a", [1, 2, 3, 4, 5]);
  const b = history("b", [0.5]);
  const none = history("none", []);

  it("scales each scenario by its jobs; totals sum the priced ones; worst-observed is jobs x worst, distinct from p95", () => {
    const c = estimateScheduleCost([
      { scenario: "a", jobs: 10, history: a },
      { scenario: "b", jobs: 10, history: b },
    ]);
    expect(c.jobs).toBe(20);
    expect(c.p50Usd).toBeCloseTo(10 * 3 + 10 * 0.5, 12);
    expect(c.meanUsd).toBeCloseTo(10 * 3 + 10 * 0.5, 12);
    expect(c.p95Usd).toBeCloseTo(10 * 5 + 10 * 0.5, 12);
    expect(c.worstObservedUsd).toBeCloseTo(10 * 5 + 10 * 0.5, 12);
    expect(c.lowerBound).toBe(false);
    expect(c.unpriced).toEqual([]);
    expect(c.pricedRuns).toBe(6);
    expect(c.thinnest).toBe(1);
  });

  it("worst-observed is on the SAME basis as p50/p95; the budget gate's wider figure is separate", () => {
    const h = history("w", [1, 1, 1], { budgetGateWorstUsd: 9, budgetGatePricedRuns: 7 });
    const c = estimateScheduleCost([{ scenario: "w", jobs: 2, history: h }]);
    expect(c.p95Usd).toBe(2);
    expect(c.worstObservedUsd).toBe(2);
    expect(c.budgetGateWorstUsd).toBe(18);
  });

  it("a scenario priced only on another tier or baseline adds nothing to any covered figure", () => {
    // No cost-basis history, but the gate (any tier/baseline) has one $2 run.
    const h = history("s", [], { budgetGateWorstUsd: 2, budgetGatePricedRuns: 1 });
    const c = estimateScheduleCost([{ scenario: "s", jobs: 10, history: h }]);
    expect(c).toMatchObject({ worstObservedUsd: 0, p50Usd: 0, lowerBound: true, unpriced: ["s"], pricedRuns: 0, thinnest: null });
    expect(c.budgetGateWorstUsd).toBe(20);
    // The covered JSON object carries the same basis — the gate figure never stands in for it.
    expect(scheduleCostJson(c).worstObservedUsd).toBe(0);
    const line = scheduleCostLine(c);
    expect(line).toMatch(/worst observed \$0\.0000/);
    expect(line).not.toMatch(/\$20/);
  });

  it("the line says p95 is the max whenever it is (20 or fewer priced runs), not only below 5", () => {
    const c = estimateScheduleCost([{ scenario: "a", jobs: 2, history: history("a", [1, 2, 3, 4, 5, 6]) }]);
    expect(scheduleCostLine(c)).toMatch(/p95 is the max observed run/);
    const many = estimateScheduleCost([
      {
        scenario: "a",
        jobs: 2,
        history: history(
          "a",
          Array.from({ length: 21 }, (_, i) => i + 1),
        ),
      },
    ]);
    expect(scheduleCostLine(many)).not.toMatch(/p95 is the max observed run/);
  });

  it("an unpriced scenario contributes 0, is named, and makes the total a lower bound", () => {
    const c = estimateScheduleCost([
      { scenario: "a", jobs: 10, history: a },
      { scenario: "none", jobs: 10, history: none },
    ]);
    expect(c.jobs).toBe(20);
    expect(c.unpriced).toEqual(["none"]);
    expect(c.lowerBound).toBe(true);
    expect(c.p50Usd).toBe(30);
    expect(scheduleCostLine(c)).toMatch(/LOWER BOUND/);
    expect(scheduleCostLine(c)).toMatch(/1\/2 scenario\(s\) have no priced run history and contribute \$0: none/);
  });

  it("nothing priced: zero totals, thinnest null, lower bound", () => {
    const c = estimateScheduleCost([{ scenario: "none", jobs: 4, history: none }]);
    expect(c).toMatchObject({ jobs: 4, p50Usd: 0, lowerBound: true, pricedRuns: 0, thinnest: null });
  });

  it("the text line labels p95 and worst as not bounds, and a thin history as a max", () => {
    const c = estimateScheduleCost([{ scenario: "b", jobs: 10, history: b }]);
    const line = scheduleCostLine(c);
    expect(line).toMatch(/p95 \$5\.0000 \(pessimistic: every run at its scenario's p95 — not a bound\)/);
    expect(line).toMatch(/worst observed \$5\.0000 \(every run at its scenario's worst on this basis — not a bound\)/);
    expect(line).toMatch(/thinnest scenario has 1 \(thin\); p95 is the max observed run for 1 scenario/);
    // The budget gate's wider basis is never printed on this line.
    expect(line).not.toMatch(/budget-gate/);
  });
});

describe("scheduleCostJson — the one serialization", () => {
  it("emits exactly the covered summary keys, in order, then the experimental ones", () => {
    const c = estimateScheduleCost([
      { scenario: "a", jobs: 10, history: history("a", [1, 2, 3]) },
      { scenario: "none", jobs: 10, history: history("none", []) },
    ]);
    const j = scheduleCostJson(c);
    expect(Object.keys(j)).toEqual([
      "jobs",
      "meanUsd",
      "p50Usd",
      "p95Usd",
      "worstObservedUsd",
      "lowerBound",
      "unpriced",
      "pricedRuns",
      "thinnest",
      "budgetGateWorstUsd",
      "judgeMeanUsd",
      "judgeP50Usd",
      "items",
    ]);
    expect(j.unpriced).toEqual(["none"]);
    expect(j.thinnest).toBe(3);
    expect(Object.keys(j.items[0])).toEqual([
      "scenario",
      "jobs",
      "priced",
      "meanUsd",
      "p50Usd",
      "p95Usd",
      "worstObservedUsd",
      "budgetGateWorstUsd",
      "perRep",
    ]);
    // Survives a JSON round trip unchanged: no undefined-valued covered key can silently disappear.
    expect(JSON.parse(JSON.stringify(j))).toEqual(j);
  });

  it("every covered key is present even when nothing is priced", () => {
    const j = scheduleCostJson(estimateScheduleCost([{ scenario: "none", jobs: 2, history: history("none", []) }]));
    const covered = ["jobs", "meanUsd", "p50Usd", "p95Usd", "worstObservedUsd", "lowerBound", "unpriced", "pricedRuns", "thinnest"];
    const round = JSON.parse(JSON.stringify(j)) as Record<string, unknown>;
    for (const k of covered) expect(round, k).toHaveProperty(k);
    expect(round.thinnest).toBeNull();
  });
});

describe("the p-value cache is the report's own MDD", () => {
  it("cachedMdd equals minimumDetectableDifference for every k1, N <= 100, at three levels", () => {
    for (const level of [0.05, 0.05 / 7, 0.1 / 7]) {
      for (let N = 1; N <= 100; N++) {
        for (let k1 = 0; k1 <= N; k1++) {
          expect(cachedMdd(k1, N, level), `k1=${k1} N=${N} level=${level}`).toEqual(minimumDetectableDifference(k1, N, N, level));
        }
      }
    }
  });
});

describe("projection", () => {
  it("k1 = round(p * N), clamped to 0..N", () => {
    expect(projectedK1(4 / 14, 12)).toBe(3);
    expect(projectedK1(1, 7)).toBe(7);
    expect(projectedK1(0, 7)).toBe(0);
    expect(projectedK1(1.2, 7)).toBe(7);
    expect(projectedK1(-0.1, 7)).toBe(0);
  });
});

describe("confirmedSingleRowLevel", () => {
  it("holm alpha/m; bh min(alpha, q/m)", () => {
    expect(confirmedSingleRowLevel({ correction: "holm", alpha: 0.05, q: 0.1, m: 7 })).toBeCloseTo(0.05 / 7, 15);
    expect(confirmedSingleRowLevel({ correction: "bh", alpha: 0.05, q: 0.1, m: 7 })).toBeCloseTo(0.1 / 7, 15);
    expect(confirmedSingleRowLevel({ correction: "bh", alpha: 0.05, q: 0.1, m: 1 })).toBe(0.05);
  });
});

describe("planRow — the ~30% row, a 50pp rise", () => {
  const plan = planRow({ k: 4, n: 14 }, opts({ targetEffect: 0.5 }));
  const t = plan.target!;

  it("possible: N = 12 (rise MDD exactly 0.5; N = 11 gives 0.545), stable from 12, power 60.9%", () => {
    expect(minimumDetectableDifference(3, 11, 11, 0.05).rise).toBeGreaterThan(0.5); // N = 11 is not enough
    expect(t.rise.possible.n).toBe(12);
    expect(t.rise.possible.stableFrom).toBe(12);
    expect(t.rise.possible.power).toBeCloseTo(0.60893, 4);
  });

  it("confirmed (single row, holm m = 7): N = 18, NOT 19, stable from 20, power 58.9%", () => {
    expect(cachedMdd(projectedK1(4 / 14, 19), 19, 0.05 / 7).rise).toBeGreaterThan(0.5);
    expect(t.rise.confirmedSingleRow.n).toBe(18);
    expect(t.rise.confirmedSingleRow.stableFrom).toBe(20);
    expect(t.rise.confirmedSingleRow.power).toBeCloseTo(0.58859, 4);
  });

  it("nForPower80: 18 (83.4%) possible, 27 (82.9%) confirmed", () => {
    expect(t.nForPower80.rise.possible.n).toBe(18);
    expect(t.nForPower80.rise.possible.power).toBeCloseTo(0.83394, 4);
    expect(t.nForPower80.rise.confirmedSingleRow.n).toBe(27);
    expect(t.nForPower80.rise.confirmedSingleRow.power).toBeCloseTo(0.82946, 4);
  });

  it("power is same-direction only and matches the independent figures", () => {
    expect(powerAt(12, 4 / 14, 4 / 14 + 0.5, 0.05, "rise")).toBeCloseTo(0.60893, 4);
    expect(powerAt(18, 4 / 14, 4 / 14 + 0.5, 0.05 / 7, "rise")).toBeCloseTo(0.58859, 4);
    // A rise in truth is essentially never "detected" as a drop.
    expect(powerAt(18, 4 / 14, 4 / 14 + 0.5, 0.05, "drop")).toBeLessThan(1e-6);
  });

  it("the rate carries its Wilson interval; the row is not thin at 14", () => {
    const w = wilsonInterval(4, 14);
    expect(plan.rate).toEqual({ k: 4, n: 14, p: 4 / 14, lo: w.lower, hi: w.upper, thin: false });
  });

  it("a drop of 50pp from 29% is impossible", () => {
    expect(t.drop.possible.n).toBe("impossible");
    expect(t.nForPower80.drop.possible.n).toBe("impossible");
  });

  it("nForPower80 is stable from the N it names (power is not monotone in N, so this is checked)", () => {
    expect(t.nForPower80.rise.possible.stableFrom).toBe(18);
    expect(t.nForPower80.rise.confirmedSingleRow.stableFrom).toBe(27);
  });

  it("power at --reps is reported for the target", () => {
    expect(t.powerAtReps.rise.possible).toBeCloseTo(0.242958, 5);
    // No table at N = 5 reaches 0.05/7 (the floor there is 1/126), so the region is empty.
    expect(t.powerAtReps.rise.confirmedSingleRow).toBe(0);
    expect(t.powerAtReps.drop.possible).toBe("impossible");
  });

  it("the valid-rep fraction inflates the scheduled N", () => {
    const p = planRow({ k: 4, n: 14 }, opts({ targetEffect: 0.5, validFraction: 0.8 }));
    expect(p.target!.rise.possible.scheduleReps).toBe(15); // ceil(12 / 0.8)
  });
});

describe("planRow — under BH", () => {
  it("the single-row confirmed level is min(alpha, q/m) = 0.1/7: N = 16, stable from 18; 80% power at 24", () => {
    const t = planRow({ k: 4, n: 14 }, opts({ correction: "bh", q: 0.1, targetEffect: 0.5 })).target!;
    expect(t.rise.confirmedSingleRow).toMatchObject({ n: 16, stableFrom: 18 });
    expect(t.nForPower80.rise.confirmedSingleRow).toMatchObject({ n: 24, stableFrom: 24 });
    // `possible` does not depend on the correction.
    expect(t.rise.possible).toMatchObject({ n: 12, stableFrom: 12 });
  });
});

describe("planRow — the consumer's own figure", () => {
  it("from 5/5 at N = 5 the smallest detectable drop is 80pp", () => {
    expect(planRow({ k: 5, n: 5 }, opts()).mddAtReps!.drop).toBe(0.8);
  });
});

describe("planRow — the ceiling", () => {
  it("14/14: rise n/a at every N in 4..100 and the target rise impossible at the point estimate", () => {
    for (let N = 4; N <= 100; N++) expect(planRow({ k: 14, n: 14 }, opts({ reps: N })).mddAtReps!.rise, `N=${N}`).toBe("n/a");
    const p = planRow({ k: 14, n: 14 }, opts({ targetEffect: 0.5 }));
    expect(p.target!.rise.possible.n).toBe("impossible");
    expect(p.notes.join("\n")).toMatch(/a rise is undetectable at any N at the point estimate/);
  });

  it("3/3: thin, the Wilson range printed, and the target recomputed at the Wilson lower bound", () => {
    const p = planRow({ k: 3, n: 3 }, opts({ targetEffect: 0.5 }));
    expect(p.rate).toMatchObject({ k: 3, n: 3, thin: true });
    expect(p.mddAtReps!.range).toBeDefined();
    const lo = wilsonInterval(3, 3).lower;
    expect(p.target!.atBound?.rise?.p).toBe(lo);
    expect(typeof p.target!.atBound?.rise?.possible.n).toBe("number");
    expect(p.notes.join("\n")).toMatch(new RegExp(`if the true rate is ${Math.round(lo * 100)}%, a 50pp rise needs N = \\d+`));
  });
});

describe("planRow — the floor (the ceiling's mirror)", () => {
  it("0/3: a drop is undetectable at the point estimate; the target is recomputed at the Wilson UPPER bound", () => {
    const p = planRow({ k: 0, n: 3 }, opts({ targetEffect: 0.5 }));
    expect(p.mddAtReps!.drop).toBe("n/a");
    expect(p.target!.drop.possible.n).toBe("impossible");
    const hi = wilsonInterval(0, 3).upper;
    expect(p.target!.atBound?.drop?.p).toBe(hi);
    expect(p.target!.atBound?.drop?.possible).toMatchObject({ n: 12, stableFrom: 12 });
    expect(p.target!.atBound?.rise).toBeUndefined();
    expect(p.notes.join("\n")).toMatch(/a drop is undetectable at any N at the point estimate/);
    expect(p.notes.join("\n")).toMatch(/if the true rate is 56%, a 50pp drop needs N = 12/);
  });
});

describe("planRow — thin history and unknown", () => {
  it("n < 5 is thin, n = 5 is not", () => {
    expect(planRow({ k: 2, n: 4 }, opts()).rate).toMatchObject({ thin: true });
    expect(planRow({ k: 2, n: 5 }, opts()).rate).toMatchObject({ thin: false });
  });

  it("no history: rate unknown, only the best case, no point MDD", () => {
    for (const h of [undefined, { k: 0, n: 0 }]) {
      const p = planRow(h, opts({ targetEffect: 0.3 }));
      expect(p.rate).toBe("unknown");
      expect(p.mddAtReps).toBeUndefined();
      expect(p.target).toBeUndefined();
      expect(p.bestCaseMddAtReps).toBeDefined();
    }
  });

  it("the best case is the minimum over every k1", () => {
    const N = 6;
    const p = planRow(undefined, opts({ reps: N }));
    const all = Array.from({ length: N + 1 }, (_, k1) => minimumDetectableDifference(k1, N, N, 0.05));
    const nums = (xs: Mdd[]) => xs.filter((x): x is number => typeof x === "number");
    expect(p.bestCaseMddAtReps.drop).toBe(Math.min(...nums(all.map((x) => x.drop))));
    expect(p.bestCaseMddAtReps.rise).toBe(Math.min(...nums(all.map((x) => x.rise))));
  });
});

describe("planRow — the MDD range covers EVERY k1 in the Wilson interval", () => {
  it("matches a brute-force min/max over the whole interval", () => {
    const N = 12;
    const p = planRow({ k: 6, n: 10 }, opts({ reps: N }));
    const w = wilsonInterval(6, 10);
    const ks: number[] = [];
    for (let k = Math.round(w.lower * N); k <= Math.round(w.upper * N); k++) ks.push(k);
    expect(ks.length).toBeGreaterThan(2);
    const rank = (x: Mdd) => (typeof x === "number" ? x : x === "none" ? 2 : 3);
    const range = (dir: "drop" | "rise") => {
      const vals = ks.map((k) => minimumDetectableDifference(k, N, N, 0.05)[dir]);
      const sorted = [...vals].sort((a, b) => rank(a) - rank(b));
      return [sorted[0], sorted[sorted.length - 1]];
    };
    expect(p.mddAtReps!.range).toEqual({ drop: range("drop"), rise: range("rise") });
  });
});

describe("planRow — N search edge cases", () => {
  it("p + delta > 1 is impossible (distinct from not-within-100); p + delta = 1 exactly is possible", () => {
    expect(planRow({ k: 8, n: 10 }, opts({ targetEffect: 0.3 })).target!.rise.possible.n).toBe("impossible");
    expect(planRow({ k: 5, n: 10 }, opts({ targetEffect: 0.5 })).target!.rise.possible.n).not.toBe("impossible");
  });

  it("compares with a float tolerance: an MDD of 0.6000000000000001 meets a 60pp target", () => {
    // From 4/14, N = 10 projects k1 = 3 and the rise MDD is 9/10 - 3/10, which floats to 0.6000000000000001.
    expect(cachedMdd(3, 10, 0.05).rise).toBeGreaterThan(0.6);
    const s = planRow({ k: 4, n: 14 }, opts({ targetEffect: 0.6 })).target!.rise.possible;
    expect(s.n).toBe(9);
    expect(s.stableFrom, "without the tolerance N = 10 fails and stability starts at 11").toBe(9);
  });

  it("no N <= 100 reaches a 5pp effect from 50%: null, not impossible", () => {
    const t = planRow({ k: 5, n: 10 }, opts({ targetEffect: 0.05 })).target!;
    expect(t.rise.possible).toMatchObject({ n: null, stableFrom: null });
  });

  it("stableFrom is the smallest N from which detection holds at every larger N", () => {
    // Constructed by search: a target where the smallest N is not where it becomes stable.
    const p = planRow({ k: 4, n: 14 }, opts({ targetEffect: 0.5 }));
    const N = p.target!.rise.confirmedSingleRow;
    expect(N.n).toBeLessThan(N.stableFrom!);
    for (let n = N.stableFrom!; n <= 100; n++) {
      const r = cachedMdd(projectedK1(4 / 14, n), n, 0.05 / 7).rise;
      expect(typeof r === "number" && r <= 0.5 + 1e-9, `N=${n}`).toBe(true);
    }
  });
});

describe("sequentialPreview — best case under the assumed scheme", () => {
  it("reps 4, m 1: L = 2, alpha/L = 0.025, the floor at 4 reps (2/70) misses it: null", () => {
    expect(attainableFloor(2, 2)).toBeCloseTo(1 / 3, 12);
    expect(attainableFloor(4, 4)).toBeCloseTo(2 / 70, 12);
    const s = sequentialPreview({ reps: 4, m: 1, alpha: 0.05 });
    expect(s.scheme).toMatchObject({ name: "bonferroni-looks-holm", lookEveryReps: 2, looks: 2, correction: "holm", implemented: false });
    expect(s.scheme.perLookAlpha).toBeCloseTo(0.025, 15);
    expect(s.firstConfirmableLook).toBeNull();
    expect(s.basis).toMatch(/best case/);
  });

  it("reachable at a larger --reps; pinned", () => {
    const s = sequentialPreview({ reps: 6, m: 1, alpha: 0.05 });
    // L = 3, per look 0.0167; floor(4,4) = 0.0286 misses, floor(6,6) = 0.00216 meets it at look 3.
    expect(s.firstConfirmableLook).toEqual({ look: 3, repsPerArm: 6 });
  });

  it("raising --reps can move the first confirmable look LATER (L grows): m = 3, reps 15 -> 16", () => {
    // reps 15: L = 7, per-row level 0.05/21 = 0.00238; floor(6,6) = 0.00216 meets it at look 3.
    // reps 16: L = 8, level 0.05/24 = 0.00208; floor(6,6) misses, floor(8,8) = 0.000155 meets it at look 4.
    expect(sequentialPreview({ reps: 15, m: 3, alpha: 0.05 }).firstConfirmableLook).toEqual({ look: 3, repsPerArm: 6 });
    expect(sequentialPreview({ reps: 16, m: 3, alpha: 0.05 }).firstConfirmableLook).toEqual({ look: 4, repsPerArm: 8 });
  });

  it("a look counts from 2 completed reps per arm; there is no planned-reps threshold on an interim look", () => {
    // Every rep a look, alpha 0.9 so a 3-rep look can reach its level (floor(3,3) = 0.1 <= 0.9/6).
    expect(sequentialPreview({ reps: 6, m: 1, alpha: 0.9, lookEveryReps: 1 }).firstConfirmableLook).toEqual({ look: 3, repsPerArm: 3 });
  });

  it("rejects a non-positive or fractional look spacing", () => {
    for (const bad of [0, -2, 1.5, Number.NaN])
      expect(() => sequentialPreview({ reps: 6, m: 1, alpha: 0.05, lookEveryReps: bad }), String(bad)).toThrow(RangeError);
  });

  it("odd --reps: looks only at complete blocks, and the unpaired rep is noted", () => {
    const s = sequentialPreview({ reps: 7, m: 1, alpha: 0.05 });
    expect(s.scheme.looks).toBe(3);
    expect(s.unpairedReps).toBe(1);
    expect(s.notes.join("\n")).toMatch(/unpaired/);
    expect(s.notes.join("\n")).toMatch(/most conservative spacing/);
  });

  it("per-row first look for a target effect", () => {
    const s = sequentialPreview({ reps: 40, m: 1, alpha: 0.05, rows: [{ id: "r", p: 4 / 14 }], targetEffect: 0.5 });
    const r = s.byRow![0];
    expect(r.id).toBe("r");
    // L = 20, level 0.05/20; the projected 50pp rise first reaches it at 22 reps per arm.
    expect(r.firstLookForTarget.rise).toEqual({ look: 11, repsPerArm: 22 });
    expect(r.firstLookForTarget.drop).toBeNull();
  });
});

describe("performance — the cached p-value matrices", () => {
  it("a COLD build of every rejection region for N = 4..100 at two levels stays inside a generous bound", () => {
    resetPlannerCaches();
    const before = pValueMatrixBuilds();
    const t0 = performance.now();
    for (let N = 4; N <= 100; N++) for (const level of [0.05, 0.05 / 7]) powerAt(N, 0.3, 0.6, level, "rise");
    const ms = performance.now() - t0;
    expect(pValueMatrixBuilds() - before, "one matrix per N, shared by both levels").toBe(97);
    // Measured ~0.2 s locally on Node 25; the bound allows a loaded CI runner on the Node 22 floor.
    expect(ms).toBeLessThan(10_000);
  });

  it("a 50-row plan at --reps 100 with a target effect finishes well inside a generous bound, and the cache is reused", () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ k: i % 15, n: 14 + (i % 7) }));
    const t0 = performance.now();
    for (const h of rows) planRow({ k: Math.min(h.k, h.n), n: h.n }, opts({ reps: 100, targetEffect: 0.3 }));
    const first = performance.now() - t0;
    // Generous: CI under load. Measured locally at a fraction of this.
    expect(first).toBeLessThan(10_000);
    const builds = pValueMatrixBuilds();
    for (const h of rows.slice(0, 5)) planRow({ k: Math.min(h.k, h.n), n: h.n }, opts({ reps: 100, targetEffect: 0.3 }));
    expect(pValueMatrixBuilds(), "a second plan must not rebuild any matrix").toBe(builds);
  });
});
