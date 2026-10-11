// The correction families of a section, from the frozen scenarios: the pass family is graded as in 4.x and never
// split; the metric family is Holm at alpha / F by default (F = families with a row in the section), or BH at q
// unsplit under `--correction bh`. One function feeds the preflight, the dry run and the report.
import { describe, it, expect } from "vitest";
import type { Assertion, ScenarioMetric } from "../src/types.js";
import {
  sectionFamilies,
  familyReach,
  confirmedAddsNoEvidence,
  metricAaFalseConfirm,
  metricCorrectionFor,
  type FrozenScenario,
} from "../src/eval/families.js";

const metric = (id: string): ScenarioMetric => ({ id, artifact: "outputs/m.json", path: "n", better: "lower", unbounded: true });
const asserts = (n: number): Assertion[] => Array.from({ length: n }, (_, i) => ({ transcript_matches: `x${i}` }) as Assertion);
const scen = (passRows: number, metrics: number): FrozenScenario => ({
  name: "s",
  assertions: asserts(passRows),
  metrics: Array.from({ length: metrics }, (_, i) => metric(`m${i}`)),
});
const bh = { correction: "bh" as const, alpha: 0.05, q: 0.1 };
const holm = { correction: "holm" as const, alpha: 0.05, q: 0.1 };

describe("sectionFamilies", () => {
  it("default (bh for pass rows): pass family BH q unsplit; metric family Holm at alpha/2 when both have rows", () => {
    const f = sectionFamilies([scen(13, 3)], bh);
    expect(f.F).toBe(2);
    expect(f.pass).toEqual({ correction: "bh", q: 0.1, alpha: 0.05 });
    expect(f.metric).toEqual({ rule: "holm", alpha: 0.05, q: 0.1, level: 0.025 });
  });

  it("a metrics-only section gives the metric family Holm at alpha", () => {
    expect(sectionFamilies([scen(0, 2)], bh).metric.level).toBe(0.05);
  });

  it("--correction bh, recorded as the metric correction, grades metrics BH at q with no split", () => {
    const f = sectionFamilies([scen(5, 3)], { ...bh, metricCorrection: { rule: "bh", split: false } });
    expect(f.metric).toEqual({ rule: "bh", alpha: 0.05, q: 0.1, level: 0.1 });
    expect(f.pass.correction).toBe("bh");
  });

  it("explicit --correction holm: pass Holm at alpha unsplit (as in 4.x), metrics Holm at alpha/2", () => {
    const f = sectionFamilies([scen(5, 1)], holm);
    expect(f.pass).toEqual({ correction: "holm", q: 0.1, alpha: 0.05 });
    expect(f.metric.level).toBe(0.025);
  });

  it("metricCorrectionFor maps the GIVEN --correction to the recorded metric rule (not given → holm split)", () => {
    expect(metricCorrectionFor(undefined)).toEqual({ rule: "holm", split: true });
    expect(metricCorrectionFor("bh")).toEqual({ rule: "bh", split: false });
    expect(metricCorrectionFor("holm")).toEqual({ rule: "holm", split: true });
  });

  it("F counts FROZEN rows: semantic roll-ups are not pass rows, claims are; modifier-only asserts are not rows", () => {
    const sem = { semantic_matches: { rubric: ["a claim"] } } as unknown as Assertion;
    const mod = { allow_stall: true } as unknown as Assertion;
    const f = sectionFamilies([{ name: "s", assertions: [sem, mod], metrics: [metric("m")] }], bh);
    expect(f.passM).toBe(1); // the claim row; the roll-up is derived
    expect(f.F).toBe(2);
    const onlyMod = sectionFamilies([{ name: "s", assertions: [mod], metrics: [metric("m")] }], bh);
    expect(onlyMod.F).toBe(1);
    expect(onlyMod.metric.level).toBe(0.05);
  });

  it("a scenario frozen without metrics (an old manifest) contributes no metric rows", () => {
    expect(sectionFamilies([{ name: "s", assertions: asserts(2) }], bh).metricM).toBe(0);
  });
});

describe("familyReach", () => {
  it("5 reps: a metric family of 3 can confirm beside pass rows, 4 cannot", () => {
    expect(familyReach(sectionFamilies([scen(13, 3)], bh), 5).find((r) => r.kind === "metrics")!.minRowsToConfirm).toBe(1);
    expect(familyReach(sectionFamilies([scen(13, 4)], bh), 5).find((r) => r.kind === "metrics")!.minRowsToConfirm).toBeNull();
  });

  it("the pass family's reach is exactly 4.x's (13 rows under bh need 2 collapsed rows; under holm unreachable)", () => {
    expect(familyReach(sectionFamilies([scen(13, 1)], bh), 5)[0]).toEqual({ kind: "pass", m: 13, minRowsToConfirm: 2 });
    expect(familyReach(sectionFamilies([scen(13, 1)], holm), 5)[0]).toEqual({ kind: "pass", m: 13, minRowsToConfirm: null });
  });

  it("4 reps never confirms a metric when the section has pass rows (floor 0.0286 > 0.025)", () => {
    expect(familyReach(sectionFamilies([scen(1, 1)], bh), 4).find((r) => r.kind === "metrics")!.minRowsToConfirm).toBeNull();
  });
});

describe("confirmedAddsNoEvidence", () => {
  it("pass family under bh at 5v5 fires at m <= 2, not at m = 3 (Fisher's attainable p <= 0.05 are 0.0079 and 0.0476)", () => {
    expect(confirmedAddsNoEvidence("pass", sectionFamilies([scen(2, 0)], bh), 5)).toBe(true);
    expect(confirmedAddsNoEvidence("pass", sectionFamilies([scen(3, 0)], bh), 5)).toBe(false);
  });

  it("metric family under --correction bh fires at m <= 3, not at m = 4 (the rank test's largest attainable p <= 0.05 is 8/252)", () => {
    const mc = { metricCorrection: { rule: "bh" as const, split: false } };
    expect(confirmedAddsNoEvidence("metrics", sectionFamilies([scen(0, 3)], { ...bh, ...mc }), 5)).toBe(true);
    expect(confirmedAddsNoEvidence("metrics", sectionFamilies([scen(0, 4)], { ...bh, ...mc }), 5)).toBe(false);
  });

  it("default metric family: only a metrics-only section with m = 1 fires", () => {
    expect(confirmedAddsNoEvidence("metrics", sectionFamilies([scen(0, 1)], bh), 5)).toBe(true);
    expect(confirmedAddsNoEvidence("metrics", sectionFamilies([scen(0, 2)], bh), 5)).toBe(false);
    expect(confirmedAddsNoEvidence("metrics", sectionFamilies([scen(1, 1)], bh), 5)).toBe(false);
  });
});

describe("metricAaFalseConfirm", () => {
  it("Holm at alpha/2, m = 3, 5v5: 1 − (1 − 2/252)^3 = 2.36%", () => {
    expect(metricAaFalseConfirm(sectionFamilies([scen(3, 3)], bh), 5)).toBeCloseTo(1 - (1 - 2 / 252) ** 3, 12);
  });
  it("Holm at alpha, metrics-only m = 1: 8/252 = 3.17%", () => {
    expect(metricAaFalseConfirm(sectionFamilies([scen(0, 1)], bh), 5)).toBeCloseTo(8 / 252, 12);
  });
  it("BH: no exact figure (bound only)", () => {
    expect(
      metricAaFalseConfirm(sectionFamilies([scen(0, 3)], { ...bh, metricCorrection: { rule: "bh", split: false } }), 5),
    ).toBeUndefined();
  });
  it("Holm at alpha/2 at 4v4 is 0: unreachable", () => {
    expect(metricAaFalseConfirm(sectionFamilies([scen(3, 1)], bh), 4)).toBe(0);
  });
});
