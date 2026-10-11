// The correction families of one report section, computed from the FROZEN scenarios alone — so the live eval's
// preflight, `eval --dry-run`'s plan and the report all agree, and no family's level depends on how many of its
// rows happened to be tested.
//
// A section has up to two families: its pass rows (claim rows and non-semantic assertion rows, exactly as today)
// and its metric rows. The pass family is graded as in 4.x, at `--correction`'s level and never split. The metric
// family's default is Holm at alpha / F, where F is the number of families with at least one row in the section;
// under `--correction bh` it is BH at q with no split.
import type { Assertion, ScenarioMetric } from "../types.js";
import { scenarioRows } from "./classify.js";
import {
  attainableFloor,
  fisherTwoSided,
  metricConfirmLevel,
  metricCorrectionOptions,
  minRowsToConfirm,
  wmwAttainable,
  wmwNullMass,
  type Correction,
  type CorrectionOptions,
  type MetricFamilyOptions,
} from "./stats.js";

export interface MetricCorrection {
  rule: Correction;
  /** Split alpha evenly across the section's families (Holm only). */
  split: boolean;
}

/** The metric family's correction for the `--correction` the user GAVE (undefined: not given). Not given, or
 *  `holm` → Holm at alpha split across families; an explicit `bh` → BH at q, unsplit (exactly 4.x's rule, applied
 *  to the metric family too). The pass family's default stays bh either way. */
export function metricCorrectionFor(given: Correction | undefined): MetricCorrection {
  return given === "bh" ? { rule: "bh", split: false } : { rule: "holm", split: true };
}

/** What the section's rows are frozen from. */
export interface FrozenScenario {
  name: string;
  assertions: readonly Assertion[];
  metrics?: readonly ScenarioMetric[];
}

export interface SectionFamilies {
  /** Pass-family rows frozen in the section (semantic roll-ups are derived rows, not in it). */
  passM: number;
  /** Metric rows frozen in the section (one per declared metric per scenario). */
  metricM: number;
  /** Families with at least one row. */
  F: number;
  pass: CorrectionOptions;
  metric: Omit<MetricFamilyOptions, "threshold">;
  metricCorrection: MetricCorrection;
}

export function sectionFamilies(
  scenarios: readonly FrozenScenario[],
  s: { correction: Correction; alpha: number; q: number; metricCorrection?: MetricCorrection },
): SectionFamilies {
  const passM = scenarios.reduce((n, sc) => n + scenarioRows(sc.name, sc.assertions).filter((r) => r.kind !== "semantic_rollup").length, 0);
  const metricM = scenarios.reduce((n, sc) => n + (sc.metrics?.length ?? 0), 0);
  const F = (passM > 0 ? 1 : 0) + (metricM > 0 ? 1 : 0);
  const mc = s.metricCorrection ?? metricCorrectionFor(undefined);
  const level = mc.rule === "bh" ? s.q : s.alpha / (mc.split ? Math.max(1, F) : 1);
  return {
    passM,
    metricM,
    F,
    pass: { correction: s.correction, q: s.q, alpha: s.alpha },
    metric: { rule: mc.rule, alpha: s.alpha, q: s.q, level },
    metricCorrection: mc,
  };
}

export interface FamilyReach {
  kind: "pass" | "metrics";
  m: number;
  /** How many rows must sit at the full-reps floor together for one to reach `confirmed`; null: unreachable. */
  minRowsToConfirm: number | null;
}

/** `confirmed` reach of each family with rows, at the no-tie floor of `reps` v `reps` (equal for both tests). */
export function familyReach(f: SectionFamilies, reps: number): FamilyReach[] {
  const floor = attainableFloor(reps, reps);
  const out: FamilyReach[] = [];
  if (f.passM > 0) out.push({ kind: "pass", m: f.passM, minRowsToConfirm: minRowsToConfirm(floor, f.passM, f.pass) });
  if (f.metricM > 0)
    out.push({ kind: "metrics", m: f.metricM, minRowsToConfirm: minRowsToConfirm(floor, f.metricM, metricCorrectionOptions(f.metric)) });
  return out;
}

/** The single-row `confirmed` level of the pass family: alpha / m under Holm, min(alpha, q / m) under BH. */
export function passConfirmLevel(o: CorrectionOptions, m: number): number {
  const mm = Math.max(1, m);
  return o.correction === "holm" ? o.alpha / mm : Math.min(o.alpha, o.q / mm);
}

/** The attainable two-sided p values <= alpha at reps v reps: Fisher's for pass rows, the no-tie rank test's for
 *  metric rows. */
function attainableWithin(kind: "pass" | "metrics", reps: number, alpha: number): number[] {
  const ps = new Set<number>();
  if (kind === "pass") {
    for (let k1 = 0; k1 <= reps; k1++) for (let k2 = 0; k2 <= reps; k2++) ps.add(fisherTwoSided(k1, reps, k2, reps));
  } else for (const p of wmwAttainable(reps, reps)) ps.add(p);
  return [...ps].filter((p) => p <= alpha * (1 + 1e-9)).sort((a, b) => a - b);
}

/** "`confirmed` adds no evidence over `possible`": the family's single-row confirm level is at least the largest
 *  attainable p <= alpha at these reps, so every `possible` row of it is also `confirmed`. */
export function confirmedAddsNoEvidence(kind: "pass" | "metrics", f: SectionFamilies, reps: number): boolean {
  const m = kind === "pass" ? f.passM : f.metricM;
  if (m === 0) return false;
  const att = attainableWithin(kind, reps, f.pass.alpha);
  if (att.length === 0) return false;
  const level = kind === "pass" ? passConfirmLevel(f.pass, m) : metricConfirmLevel(f.metric, m);
  return level >= att[att.length - 1] * (1 - 1e-9);
}

/** The metric family's exact A/A any-confirmed rate at reps v reps under Holm (no ties; ties only lower it), or
 *  undefined under BH, whose exact rate for non-identical rows needs a computation the report does not carry. */
export function metricAaFalseConfirm(f: SectionFamilies, reps: number): number | undefined {
  if (f.metricM === 0 || f.metric.rule !== "holm") return undefined;
  const single = wmwNullMass(reps, reps, f.metric.level / f.metricM);
  return 1 - (1 - single) ** f.metricM;
}
