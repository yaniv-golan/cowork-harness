// The eval report: built from `manifest.json` + `runs.jsonl` alone, by ONE function that both the live eval
// and `eval report <dir>` call — so the two are byte-identical by construction. Pure apart from reading and
// writing the eval dir: no clock, no environment beyond $HOME (for `~` redaction).
import { writeFileSync } from "node:fs";
import { INFRA_EXCLUDED } from "./classify.js";
import {
  asymmetry,
  asymmetryLine,
  ASYMMETRY_THRESHOLDS,
  sideMetrics,
  type AsymmetryCell,
  type CorpusSideMetrics,
} from "../search-corpus/asymmetry.js";
import { provenanceLine, type PoolProvenance } from "../search-corpus/provenance.js";
import { searchCorpusLabel } from "../search-corpus/label.js";
import { join } from "node:path";
import {
  classifyRep,
  repMetricValues,
  repRowValues,
  scenarioRows,
  armMedians,
  semanticRefusalReason,
  type ArmMedians,
  type RepBucket,
  type RowKey,
  type RepClassification,
  type MetricRepValue,
} from "./classify.js";
import {
  attainableFloor,
  evaluateFamily,
  insufficientThreshold,
  minRowsToConfirm,
  ceilingRowCount,
  zeroRowCount,
  evaluateMetricFamily,
  fisherNullMass,
  mdsSdUnits,
  type FamilyRowOutput,
  type Mdd,
  type MetricRowInput,
  type MetricRowOutput,
} from "./stats.js";
import { confirmedAddsNoEvidence, familyReach, metricAaFalseConfirm, sectionFamilies, type SectionFamilies } from "./families.js";
import { readManifest, type EvalManifest } from "./manifest.js";
import { readRunsLines, repEvidenceOf, RUNS_FILE, type RunsLine } from "./runs.js";
import { redactHostPaths } from "../run/host-path-tokens.js";

export const REPORT_JSON = "report.json";
export const REPORT_MD = "report.md";

type RowKind = "assertion" | "claim" | "semantic_rollup" | "errored_agent_rate" | "invocation_rate";

/** `insufficient_refusals`: the row is `insufficient`, the CANDIDATE arm refused at least 2 more
 *  `semantic_matches` grades for unavailable evidence than the baseline, and that excess alone is what took it
 *  below the threshold. A DROP signal at the `possible` level: `--fail-on possible` gates on it (never
 *  `confirmed`, which needs a tested row), and without `--fail-on` nothing gates — a refusal is excluded from
 *  the rows, so an edit that makes the deliverable outgrow the evidence budget would otherwise hide its own
 *  regression behind `insufficient`. */
export type ReportRowLabel = FamilyRowOutput["label"] | "insufficient_refusals";

export interface ReportRow extends Omit<FamilyRowOutput, "label"> {
  label: ReportRowLabel;
  scenario: string | null;
  kind: RowKind;
  /** Display text: the assertion key, or the claim. */
  text: string;
  assertionIndex?: number;
  minPass?: number | "all";
  /** In the section's correction family (claim and non-semantic assertion rows); derived rows are not. */
  inFamily: boolean;
  /** Reconciles the interval with the exact test when they point different ways. */
  note?: string;
  /** For a `possible`/`confirmed` row: run dirs where A passed and B failed (a drop), or the reverse. */
  evidence?: { a: string[]; b: string[] };
}

/** A metric row's label: the family's labels, plus two the report applies.
 *  - `insufficient_unmeasured`: the row is `insufficient`, the candidate has at least 2 more excluded (class X)
 *    reps than the baseline, and crediting back that excess would have reached the threshold — a worse-signal at
 *    the `possible` level, the analogue of `insufficient_refusals`.
 *  - `not compared`: a rep's metric state says the comparison itself is broken (`pruned`, `no_manifest`): out of
 *    the family, never gates, and the eval exits 1. */
export type MetricReportLabel = MetricRowOutput["label"] | "insufficient_unmeasured" | "not compared";

export interface MetricReportRow extends Omit<MetricRowOutput, "label" | "id"> {
  scenario: string;
  metricId: string;
  label: MetricReportLabel;
  /** In the section's metric family (`insufficient`, `insufficient_unmeasured` and `not compared` rows are not). */
  inFamily: boolean;
  /** Worst-ranked reps per arm, by cause (`errored_agent`, or a class-W reason). */
  worstRanked: { a: Record<string, number>; b: Record<string, number> };
  /** Excluded (class X) reps per arm, by reason. */
  excluded: { a: Record<string, number>; b: Record<string, number> };
  /** The reasons that put the row out of the comparison (`not compared` only). */
  notCompared?: string[];
  mdsBasis: string;
  note?: string;
  /** For a `possible`/`confirmed` row: run dirs of each arm's most extreme reps in the flagged direction. */
  evidence?: { a: string[]; b: string[] };
}

/** One correction family of a section, as every report states it. */
export interface FamilyLine {
  kind: "pass" | "metrics";
  /** Rows tested in the family. */
  m: number;
  correction: "bh" | "holm";
  /** The corrected value's level (BH's q, or Holm's alpha — split for the metric family by default). */
  level: number;
  split: boolean;
  /** The chance an A/A eval confirms at least one row of this family; absent when only the bound is known. */
  aaFalseConfirm?: number;
  aaBasis: "exact-no-ties" | "exact-observed-rates" | "bound-only";
  bound: number;
  /** `confirmed` adds no evidence over `possible` in this family at these reps. */
  confirmedAddsNoEvidence: boolean;
}

export interface ReportSection {
  scenarios: string[];
  /** Tested rows in the correction family. */
  m: number;
  floorAtFullReps: number;
  minRowsToConfirm: number | null;
  confirmableRows: number;
  ceilingRows: number;
  zeroRows: number;
  rows: ReportRow[];
  derivedRows: ReportRow[];
  classificationRows: ReportRow[];
  /** Per `semantic_matches` assertion whose refusals for unavailable evidence are unbalanced between the arms
   *  (they differ by ≥ 2 reps) or frequent (≥ 20% of an arm's scored reps). */
  refusalImbalances: RefusalImbalance[];
  /** One row per (scenario, declared metric); empty when the section declares none or metrics were not recorded. */
  metricRows: MetricReportRow[];
  /** The metric family's header figures; null when the section has no metric rows. */
  metricFamily: { m: number; floorAtFullReps: number; minRowsToConfirm: number | null; confirmableRows: number } | null;
  /** Every family with rows in this section: its correction, size and A/A false-confirm rate. */
  families: FamilyLine[];
}

export interface RefusalImbalance {
  scenario: string;
  assertionIndex: number;
  /** Refused grades of this assertion over the arm's scored reps (valid, judge_invalid, errored_agent). */
  a: { refused: number; scored: number };
  b: { refused: number; scored: number };
  /** The candidate's excess refusals left at least one of this assertion's rows `insufficient_refusals` — a
   *  drop signal that `--fail-on possible` gates on. */
  insufficientRefusals: boolean;
}

export interface ReportArm {
  label: string;
  role: "A" | "B";
  source: string;
  fileSet: string;
  fileCount: number;
  untrackedExcluded: number;
  scheduled: number;
  recorded: number;
  buckets: Partial<Record<RepBucket, number>>;
  errorSources: Record<string, number>;
  unclassified: number;
  ambiguousExit: number;
  /** `semantic_matches` grades that refused for unavailable evidence, by reason — counted once per (rep,
   *  assertion) over this arm's valid and judge_invalid reps. Each leaves that assertion's rows for that rep
   *  (`evidence_unavailable`), so this count is what keeps an arm that refuses more often visible. */
  evidenceUnavailable: Record<string, number>;
  /** Metric states over this arm's reps (one count per rep per declared metric): worst-ranked by cause, excluded by
   *  reason, and not-compared by reason. */
  metricStates: { worst: Record<string, number>; excluded: Record<string, number>; notCompared: Record<string, number> };
  medians: ArmMedians;
}

export interface EvalReport {
  schemaVersion: 0;
  evalId: string;
  startedAt: string;
  harnessVersion: string;
  arms: ReportArm[];
  settings: EvalManifest["settings"] & { threshold: number };
  pins: EvalManifest["pins"];
  skill: string | null;
  sections: { tuned: ReportSection | null; heldOut: ReportSection | null };
  judgeDisagreements: Array<{ scenario: string; assertionIndex: number; models: string[] }>;
  /** Every recorded rep, in schedule order, with the bucket the report put it in. */
  reps: Array<{
    index: number;
    arm: string;
    scenario: string;
    rep: number;
    runDir: string | null;
    bucket: RepBucket;
    rule: string;
    unclassified: boolean;
  }>;
  summary: {
    familyRows: number;
    /** Each (arm, scenario) whose every recorded rep errored, with its most frequent bucket and rule.
     *  `rowsInsufficient`: that scenario compared nothing — every rep of BOTH arms errored, or every rep of
     *  this arm is infrastructure — so its rows are `insufficient` and the eval exits 1. An arm whose every
     *  rep is the agent's own failure, against an arm with valid reps, is scored (a real drop) and listed
     *  with `rowsInsufficient: false`. */
    erroredArms: Array<{
      arm: string;
      scenario: string;
      reps: number;
      dominant: { bucket: RepBucket; rule: string; count: number };
      rowsInsufficient: boolean;
    }>;
    labels: Record<string, number>;
    /** Metric rows' labels, counted like `labels`. */
    metricLabels: Record<string, number>;
    /** False when the eval dir predates metric grading (its manifest froze no metric declarations): no metric row
     *  is graded and the exit code is unaffected. */
    metricsRecorded: boolean;
    /** Every section's families, tuned first. */
    families: Array<FamilyLine & { section: "tuned" | "heldOut" }>;
    /** Per section and family with rows: whether `confirmed` is reachable at --reps (the pre-run reach). */
    confirmReach: Array<{ section: "tuned" | "heldOut"; kind: "pass" | "metrics"; m: number; minRowsToConfirm: number | null }>;
    /** Metric rows `not compared` (each makes the eval exit 1). */
    notCompared: number;
    allInsufficient: boolean;
    /** Every section's `refusalImbalances`, tuned first. */
    refusalImbalances: RefusalImbalance[];
    failOnHit: boolean;
    judgeDisagreement: boolean;
    missingJobs: number;
    tornFinalLine: boolean;
    /** Reps whose evidence was not the pinned pool's (refused before they ran, or served off another pool). Any
     *  makes the eval exit 1. Absent without a pinned corpus. */
    searchPoolMismatch?: { reps: number; byArm: Record<string, number> };
    /** The comparison is CONFOUNDED: the pool was drawn from one arm (or from unknown sources), or the arms were served
     *  asymmetrically. Never changes the exit code. Absent when neither applies. */
    confounded?: { provenance?: string; asymmetry?: true };
    exitCode: 0 | 1;
  };
  cost: { agentUsd: number; judgeUsd: number };
  stoppedEarly: null;
  redactedHostPaths: number;
  /** Present when the eval pinned a frozen search corpus. */
  searchCorpus?: ReportSearchCorpus;
}

const SCORED: ReadonlySet<RepBucket> = new Set(["valid", "judge_invalid", "errored_agent"]);
/** The agent's errors and every infrastructure exclusion: an (arm, scenario) whose every rep is in this set errored. */
const ERRORED: ReadonlySet<RepBucket> = new Set(["errored_infra", "errored_agent", ...INFRA_EXCLUDED]);

/** The frozen search corpus, side by side per arm (from each scored rep's persisted counts). */
export interface ReportSearchCorpus {
  label: string;
  pin: NonNullable<EvalManifest["pins"]["searchCorpus"]>;
  provenance: PoolProvenance | null;
  provenanceLine: string;
  arms: Record<
    string,
    { total: CorpusSideMetrics; perScenario: Record<string, CorpusSideMetrics>; refusedReps: number; judgeWarned: number }
  >;
  asymmetry: { total: AsymmetryCell; perScenario: Record<string, AsymmetryCell>; thresholds: typeof ASYMMETRY_THRESHOLDS };
}

interface ClassifiedLine {
  line: RunsLine;
  c: RepClassification;
}

function sumFinite(xs: Array<number | undefined>): number {
  return xs.reduce<number>((a, b) => a + (typeof b === "number" && Number.isFinite(b) ? b : 0), 0);
}

const normalizeModel = (m: string) => m.replace(/\[\dm\]$/i, "").toLowerCase();

function noteFor(r: FamilyRowOutput): string | undefined {
  if (!r.interval || r.label === "insufficient") return undefined;
  const excludes0 = r.interval.lower > 0 || r.interval.upper < 0;
  const flagged = r.label.startsWith("possible") || r.label.startsWith("confirmed");
  if (excludes0 && !flagged) return "interval excludes 0, but the exact test at this n cannot confirm it; see MDD";
  if (!excludes0 && flagged) return "the exact test flags it, though the interval still includes 0";
  return undefined;
}

/** Derived rows are shown with their own test but never corrected, so at most `possible`. */
function asDerived(r: FamilyRowOutput): FamilyRowOutput {
  const { adjustedP: _drop, ...rest } = r;
  void _drop;
  const label = r.label === "confirmed drop" ? "possible drop" : r.label === "confirmed rise" ? "possible rise" : r.label;
  return { ...rest, label };
}

/** `comparedNothing`: scenarios whose reps contribute to no row (see `erroredArms`) — their rows keep 0
 *  reps, so they are `insufficient` and stay out of the correction family. */
function sectionOf(
  m: EvalManifest,
  scenarioNames: string[],
  classified: ClassifiedLine[],
  threshold: number,
  comparedNothing: ReadonlySet<string>,
  metricsRecorded: boolean,
): ReportSection {
  const [A, B] = m.arms;
  const opts = { correction: m.settings.correction, q: m.settings.q, alpha: m.settings.alpha, threshold };
  const familyInputs: Array<{
    key: RowKey;
    k1: number;
    n1: number;
    k2: number;
    n2: number;
    /** Reps of each arm this row excluded because the assertion refused for unavailable evidence. */
    rA: number;
    rB: number;
    a: Array<[string, 0 | 1]>;
    b: Array<[string, 0 | 1]>;
  }> = [];
  const refusalImbalances: RefusalImbalance[] = [];
  const derivedInputs: typeof familyInputs = [];
  for (const name of scenarioNames) {
    const scen = m.scenarios.find((s) => s.name === name)!;
    const rows = scenarioRows(name, scen.assertions);
    const perRow = new Map(
      rows.map((row) => [
        row.id,
        {
          key: row,
          k1: 0,
          n1: 0,
          k2: 0,
          n2: 0,
          rA: 0,
          rB: 0,
          a: [] as Array<[string, 0 | 1]>,
          b: [] as Array<[string, 0 | 1]>,
        },
      ]),
    );
    for (const { line, c } of classified) {
      if (line.scenario !== name || comparedNothing.has(name)) continue;
      const ev = repEvidenceOf(line);
      for (const v of repRowValues(rows, scen.assertions, c, ev.result)) {
        if (v.excluded === "evidence_unavailable") {
          const acc = perRow.get(v.row.id)!;
          if (line.arm === A.label) acc.rA++;
          else if (line.arm === B.label) acc.rB++;
        }
        if (v.value === undefined) continue;
        const acc = perRow.get(v.row.id)!;
        const dir = line.runDir ?? "(no run dir)";
        if (line.arm === A.label) {
          acc.n1++;
          acc.k1 += v.value;
          acc.a.push([dir, v.value]);
        } else if (line.arm === B.label) {
          acc.n2++;
          acc.k2 += v.value;
          acc.b.push([dir, v.value]);
        }
      }
    }
    for (const acc of perRow.values()) (acc.key.kind === "semantic_rollup" ? derivedInputs : familyInputs).push(acc);
    // Refusals per assertion, read off its roll-up and claim rows (an assertion's rows share one count).
    if (!comparedNothing.has(name)) {
      const scored = (arm: string) =>
        classified.filter((x) => x.line.scenario === name && x.line.arm === arm && SCORED.has(x.c.bucket)).length;
      const sA = scored(A.label);
      const sB = scored(B.label);
      for (const acc of perRow.values()) {
        if (acc.key.kind !== "semantic_rollup") continue;
        // A multi-key assertion's roll-up keeps its refused reps as fails, so its refusals are counted on its
        // claim rows (every rubric has at least one; all of them carry the same count).
        const claim = [...perRow.values()].find((c) => c.key.kind === "claim" && c.key.assertionIndex === acc.key.assertionIndex);
        const rA = Math.max(acc.rA, claim?.rA ?? 0);
        const rB = Math.max(acc.rB, claim?.rB ?? 0);
        const frequent = (r: number, n: number) => n > 0 && r >= REFUSAL_SHARE * n;
        if (Math.abs(rA - rB) >= REFUSAL_GAP || frequent(rA, sA) || frequent(rB, sB))
          refusalImbalances.push({
            scenario: name,
            assertionIndex: acc.key.assertionIndex,
            a: { refused: rA, scored: sA },
            b: { refused: rB, scored: sB },
            insufficientRefusals: [...perRow.values()].some(
              (r) => r.key.assertionIndex === acc.key.assertionIndex && refusalsGate(r, threshold),
            ),
          });
      }
    }
  }
  const fam = evaluateFamily(
    familyInputs.map((x) => ({ id: x.key.id, k1: x.k1, n1: x.n1, k2: x.k2, n2: x.n2 })),
    opts,
  );
  const der = evaluateFamily(
    derivedInputs.map((x) => ({ id: x.key.id, k1: x.k1, n1: x.n1, k2: x.k2, n2: x.n2 })),
    opts,
  );
  const withMeta = (inputs: typeof familyInputs, outs: FamilyRowOutput[], inFamily: boolean): ReportRow[] =>
    outs.map((o, i) => {
      const x = inputs[i];
      const base = inFamily ? o : asDerived(o);
      const scen = m.scenarios.find((s) => s.name === x.key.scenario)!;
      const assertion = scen.assertions[x.key.assertionIndex];
      const flagged = base.label.startsWith("possible") || base.label.startsWith("confirmed");
      const evidence = flagged
        ? base.direction === "drop"
          ? {
              a: x.a
                .filter(([, v]) => v === 1)
                .slice(0, 2)
                .map(([d]) => d),
              b: x.b
                .filter(([, v]) => v === 0)
                .slice(0, 2)
                .map(([d]) => d),
            }
          : {
              a: x.a
                .filter(([, v]) => v === 0)
                .slice(0, 2)
                .map(([d]) => d),
              b: x.b
                .filter(([, v]) => v === 1)
                .slice(0, 2)
                .map(([d]) => d),
            }
        : undefined;
      const note = noteFor(base);
      return {
        ...base,
        ...(base.label === "insufficient" && refusalsGate(x, threshold) ? { label: "insufficient_refusals" as const } : {}),
        scenario: x.key.scenario,
        kind: x.key.kind,
        text: x.key.kind === "claim" ? x.key.claim! : x.key.label,
        assertionIndex: x.key.assertionIndex,
        ...(x.key.kind === "semantic_rollup" && assertion?.semantic_matches?.min_pass !== undefined
          ? { minPass: assertion.semantic_matches.min_pass }
          : {}),
        inFamily,
        ...(note ? { note } : {}),
        ...(evidence ? { evidence } : {}),
      };
    });
  const rows = withMeta(familyInputs, fam.rows, true);
  const derivedRows = withMeta(derivedInputs, der.rows, false);

  // Classification rows: the errored-by-agent rate and the invocation rate, over the scored reps.
  const inSection = classified.filter((x) => scenarioNames.includes(x.line.scenario) && SCORED.has(x.c.bucket));
  const count = (arm: string, pred: (x: ClassifiedLine) => boolean | undefined) => {
    const reps = inSection.filter((x) => x.line.arm === arm);
    const decided = reps.filter((x) => pred(x) !== undefined);
    return { n: decided.length, k: decided.filter((x) => pred(x) === true).length };
  };
  const erroredPred = (x: ClassifiedLine) => x.c.bucket === "errored_agent";
  const invokedPred = (x: ClassifiedLine) => {
    const f = x.line.evidence?.invoked;
    return f === undefined || f === "unobservable" ? undefined : f;
  };
  const cls = [
    {
      id: "errored_agent_rate",
      kind: "errored_agent_rate" as const,
      text: "errored by the agent (rate; a rise is worse)",
      pred: erroredPred,
    },
    {
      id: "invocation_rate",
      kind: "invocation_rate" as const,
      text: `skill invoked${m.skill ? ` (${m.skill})` : ""} (rate, observable reps only)`,
      pred: invokedPred,
    },
  ].map((d) => {
    const a = count(A.label, d.pred);
    const b = count(B.label, d.pred);
    return { d, row: { id: d.id, k1: a.k, n1: a.n, k2: b.k, n2: b.n } };
  });
  const clsOut = evaluateFamily(
    cls.map((x) => x.row),
    opts,
  );
  const classificationRows: ReportRow[] = clsOut.rows.map((o, i) => {
    const base = asDerived(o);
    const note = noteFor(base);
    return { ...base, scenario: null, kind: cls[i].d.kind, text: cls[i].d.text, inFamily: false, ...(note ? { note } : {}) };
  });

  const full = m.settings.reps;
  const floorAtFullReps = attainableFloor(full, full);
  return {
    scenarios: scenarioNames,
    m: fam.m,
    floorAtFullReps,
    minRowsToConfirm: fam.m > 0 ? fam.minRowsToConfirm : minRowsToConfirm(floorAtFullReps, familyInputs.length, opts),
    confirmableRows: fam.confirmableRows,
    ceilingRows: ceilingRowCount(familyInputs),
    zeroRows: zeroRowCount(familyInputs),
    rows,
    derivedRows,
    classificationRows,
    refusalImbalances,
    ...metricSection(m, scenarioNames, classified, threshold, comparedNothing, metricsRecorded, familyInputs, fam.m, opts),
  };
}

/** A metric's excess of excluded reps worth naming on its row and in the header. */
const UNMEASURED_GAP = 2;

/** The section's metric rows, their family's header, and the family lines for both families. */
function metricSection(
  m: EvalManifest,
  scenarioNames: string[],
  classified: ClassifiedLine[],
  threshold: number,
  comparedNothing: ReadonlySet<string>,
  metricsRecorded: boolean,
  passInputs: ReadonlyArray<{ k1: number; n1: number; k2: number; n2: number }>,
  passTested: number,
  passOpts: { correction: "bh" | "holm"; q: number; alpha: number },
): Pick<ReportSection, "metricRows" | "metricFamily" | "families"> {
  const [A, B] = m.arms;
  const frozen = m.scenarios.filter((sc) => scenarioNames.includes(sc.name));
  const fams: SectionFamilies = sectionFamilies(
    frozen.map((sc) => ({ name: sc.name, assertions: sc.assertions, metrics: metricsRecorded ? (sc.metrics ?? []) : [] })),
    {
      correction: m.settings.correction,
      alpha: m.settings.alpha,
      q: m.settings.q,
      ...(m.settings.metricCorrection ? { metricCorrection: m.settings.metricCorrection } : {}),
    },
  );
  const reps = m.settings.reps;
  type Arm = {
    values: number[];
    worst: number;
    excluded: number;
    worstBy: Record<string, number>;
    excludedBy: Record<string, number>;
    notCompared: Set<string>;
    /** [run dir, goodness or -Infinity for a worst-ranked rep] for the evidence list. */
    dirs: Array<[string, number]>;
  };
  const newArm = (): Arm => ({ values: [], worst: 0, excluded: 0, worstBy: {}, excludedBy: {}, notCompared: new Set(), dirs: [] });
  const accs: Array<{ scenario: string; decl: NonNullable<(typeof frozen)[number]["metrics"]>[number]; a: Arm; b: Arm }> = [];
  if (metricsRecorded)
    for (const sc of frozen) {
      const decls = sc.metrics ?? [];
      const byId = new Map(decls.map((d) => [d.id, { scenario: sc.name, decl: d, a: newArm(), b: newArm() }]));
      accs.push(...byId.values());
      if (comparedNothing.has(sc.name)) continue;
      for (const { line, c } of classified) {
        if (line.scenario !== sc.name) continue;
        const arm = line.arm === A.label ? "a" : line.arm === B.label ? "b" : null;
        if (arm === null) continue;
        const dir = line.runDir ?? "(no run dir)";
        for (const { id, v } of repMetricValues(decls, c, repEvidenceOf(line).result)) {
          const acc = byId.get(id)![arm];
          addState(acc, v, dir, byId.get(id)!.decl.better);
        }
      }
    }
  function addState(acc: Arm, v: MetricRepValue, dir: string, better: "higher" | "lower"): void {
    if ("value" in v) {
      acc.values.push(v.value);
      acc.dirs.push([dir, better === "higher" ? v.value : -v.value]);
    } else if ("worst" in v) {
      acc.worst++;
      acc.worstBy[v.worst] = (acc.worstBy[v.worst] ?? 0) + 1;
      acc.dirs.push([dir, -Infinity]);
    } else if ("excluded" in v) {
      acc.excluded++;
      acc.excludedBy[v.excluded] = (acc.excludedBy[v.excluded] ?? 0) + 1;
    } else if ("notCompared" in v) acc.notCompared.add(v.notCompared);
  }
  const compared = accs.filter((x) => x.a.notCompared.size === 0 && x.b.notCompared.size === 0);
  const inputs: MetricRowInput[] = compared.map((x) => ({
    id: JSON.stringify([x.scenario, x.decl.id]),
    better: x.decl.better,
    a: { values: x.a.values, worst: x.a.worst, excluded: x.a.excluded },
    b: { values: x.b.values, worst: x.b.worst, excluded: x.b.excluded },
  }));
  const out = evaluateMetricFamily(inputs, { ...fams.metric, threshold });
  const byId = new Map(out.rows.map((r) => [r.id, r]));
  const sorted = (rec: Record<string, number>) => Object.fromEntries(Object.entries(rec).sort(([x], [y]) => x.localeCompare(y)));
  const metricRows: MetricReportRow[] = accs.map((x): MetricReportRow => {
    const id = JSON.stringify([x.scenario, x.decl.id]);
    const counts = {
      worstRanked: { a: sorted(x.a.worstBy), b: sorted(x.b.worstBy) },
      excluded: { a: sorted(x.a.excludedBy), b: sorted(x.b.excludedBy) },
    };
    const r = byId.get(id);
    if (r === undefined) {
      return {
        scenario: x.scenario,
        metricId: x.decl.id,
        better: x.decl.better,
        label: "not compared",
        inFamily: false,
        direction: "none",
        numericDirection: "none",
        p: 1,
        survivorP: 1,
        floor: 1,
        n1: x.a.values.length + x.a.worst,
        n2: x.b.values.length + x.b.worst,
        medians: {},
        sd: {},
        ...counts,
        notCompared: [...new Set([...x.a.notCompared, ...x.b.notCompared])].sort(),
        mdsBasis: MDS_BASIS,
        note: "a rep's metric state says the comparison is broken (a harness defect): not compared, and the eval exits 1",
      };
    }
    const { id: _id, label: baseLabel, ...rest } = r;
    void _id;
    const excess = x.b.excluded - x.a.excluded;
    const unmeasured =
      baseLabel === "insufficient" && excess >= UNMEASURED_GAP && r.n1 >= threshold && r.n2 < threshold && r.n2 + excess >= threshold;
    const label: MetricReportLabel = unmeasured ? "insufficient_unmeasured" : baseLabel;
    const notes: string[] = [];
    const worstNote = (arm: Arm, name: string, n: number) =>
      `${name} ${arm.worst} of ${n} worst-ranked (errored ${arm.worstBy.errored_agent ?? 0}, unmeasured ${arm.worst - (arm.worstBy.errored_agent ?? 0)})`;
    if (r.direction === "worse" && (label.startsWith("possible") || label.startsWith("confirmed")))
      notes.push(`${worstNote(x.a, "A", r.n1)}; ${worstNote(x.b, "B", r.n2)}`);
    if (label === "unresolved")
      notes.push(
        `survivor p ${fmtP(r.survivorP)} (${r.direction}) holds only while ${x.a.excluded + x.b.excluded} excluded rep(s) stay unknown (A ${x.a.excluded}, B ${x.b.excluded})`,
      );
    if (!unmeasured && Math.abs(excess) >= UNMEASURED_GAP)
      notes.push(`${excess > 0 ? "B" : "A"}: ${Math.abs(excess)} more excluded values than ${excess > 0 ? "A" : "B"}`);
    if (r.hl && x.a.worst + x.b.worst > 0) notes.push(`HL over measured reps (${x.a.values.length + x.b.values.length} of ${r.n1 + r.n2})`);
    if (r.floor === 1 && label === "underpowered") notes.push("every value tied");
    if (r.mds && r.n1 !== r.n2) notes.push(`MDS at n = ${r.mds.n} per arm (the smaller arm; conservative)`);
    const flagged = label.startsWith("possible") || label.startsWith("confirmed");
    const worseFirst = (dirs: Array<[string, number]>, asc: boolean) =>
      [...dirs]
        .sort((p, q) => (asc ? p[1] - q[1] : q[1] - p[1]))
        .slice(0, 2)
        .map(([d]) => d);
    const evidence = flagged
      ? r.direction === "worse"
        ? { a: worseFirst(x.a.dirs, false), b: worseFirst(x.b.dirs, true) }
        : { a: worseFirst(x.a.dirs, true), b: worseFirst(x.b.dirs, false) }
      : undefined;
    return {
      ...rest,
      scenario: x.scenario,
      metricId: x.decl.id,
      label,
      inFamily: r.adjustedP !== undefined,
      ...counts,
      mdsBasis: r.mds
        ? MDS_BASIS
        : r.pooledSd === 0
          ? `${MDS_BASIS}; none: no within-arm spread (pooled SD 0), so there is no scale to read a shift in`
          : `${MDS_BASIS}; none at n = ${Math.min(r.n1, r.n2)} per arm (the table covers 4–6)`,
      ...(notes.length ? { note: notes.join("; ") } : {}),
      ...(evidence ? { evidence } : {}),
    };
  });

  const families: FamilyLine[] = [];
  if (fams.passM > 0) {
    const level = passOpts.correction === "bh" ? passOpts.q : passOpts.alpha;
    // Holm: Holm rejects anything iff the smallest p <= alpha/m, so P(any) = 1 − Π(1 − P_i(p <= alpha/m)), each
    // row's P_i at its pooled observed rate (descriptive; it never feeds a label). BH: the bound only.
    const tested = passInputs.filter((x) => x.n1 >= threshold && x.n2 >= threshold && x.n1 > 0 && x.n2 > 0);
    const aa =
      passOpts.correction === "holm" && tested.length > 0
        ? 1 -
          tested.reduce(
            (acc, x) => acc * (1 - fisherNullMass(x.n1, x.n2, (x.k1 + x.k2) / (x.n1 + x.n2), passOpts.alpha / tested.length)),
            1,
          )
        : undefined;
    families.push({
      kind: "pass",
      m: passTested,
      correction: passOpts.correction,
      level,
      split: false,
      ...(aa !== undefined ? { aaFalseConfirm: aa } : {}),
      aaBasis: aa !== undefined ? "exact-observed-rates" : "bound-only",
      bound: level,
      confirmedAddsNoEvidence: confirmedAddsNoEvidence("pass", fams, reps),
    });
  }
  if (fams.metricM > 0 && metricsRecorded) {
    const mm = out.m;
    const aa = metricAaFalseConfirm(fams, reps, mm);
    families.push({
      kind: "metrics",
      m: mm,
      correction: fams.metric.rule,
      level: fams.metric.level,
      split: fams.metricCorrection.split && fams.F > 1,
      ...(aa !== undefined ? { aaFalseConfirm: aa } : {}),
      aaBasis: aa !== undefined ? "exact-no-ties" : "bound-only",
      bound: fams.metric.level,
      confirmedAddsNoEvidence: confirmedAddsNoEvidence("metrics", fams, reps),
    });
  }
  const reach = familyReach(fams, reps).find((r) => r.kind === "metrics");
  return {
    metricRows,
    metricFamily:
      metricRows.length > 0
        ? {
            m: out.m,
            floorAtFullReps: attainableFloor(reps, reps),
            minRowsToConfirm: out.m > 0 ? out.minRowsToConfirm : (reach?.minRowsToConfirm ?? null),
            confirmableRows: out.confirmableRows,
          }
        : null,
    families,
  };
}

const MDS_BASIS = "normal-shift table, 80% power, estimate";

/** A refusal gap or share worth a header warning. */
const REFUSAL_GAP = 2;
const REFUSAL_SHARE = 0.2;

/** Did the CANDIDATE's EXCESS refusals for unavailable evidence push this row below the threshold? The baseline
 *  had enough reps, the candidate refused at least REFUSAL_GAP more grades than it, and with only that excess
 *  credited back it would have had enough too — so one stray refusal, or a refusal beside some other lost rep,
 *  never labels a row. A baseline that refuses more is warned about but never labels: that is not the edit
 *  hiding a drop. */
function refusalsGate(x: { n1: number; n2: number; rA: number; rB: number }, threshold: number): boolean {
  const excess = x.rB - x.rA;
  return excess >= REFUSAL_GAP && x.n1 >= threshold && x.n2 < threshold && x.n2 + excess >= threshold;
}

/** Build the report model from the eval dir's manifest and runs. */
export function buildEvalReport(evalDir: string): EvalReport {
  const m = readManifest(evalDir);
  const { lines, tornFinalLine } = readRunsLines(join(evalDir, RUNS_FILE));
  const sigFor = (arm: string, scenario: string) => m.arms.find((a) => a.label === arm)?.sigs[scenario];
  const classified: ClassifiedLine[] = lines.map((line) => ({
    line,
    c: classifyRep(repEvidenceOf(line), {
      contentSig: sigFor(line.arm, line.scenario),
      judgePromptHash: m.pins.judge.promptHash,
      ...(m.pins.searchCorpus ? { searchCorpus: { sha256: m.pins.searchCorpus.sha256, miss: m.pins.searchCorpus.miss } } : {}),
    }),
  }));
  const threshold = insufficientThreshold(m.settings.reps, m.settings.allowUnderpowered);
  const tunedNames = m.scenarios.filter((s) => !s.heldOut).map((s) => s.name);
  const heldNames = m.scenarios.filter((s) => s.heldOut).map((s) => s.name);
  // Per (arm, scenario): every rep errored. A scenario compared nothing when every rep of BOTH arms errored
  // (0 against 0 is not "no detectable change"), or when one arm's every rep is infrastructure (that arm
  // never ran the skill). Its rows get no reps — `insufficient`, out of the family — and the eval exits 1.
  // An arm whose every rep is the AGENT's failure against an arm with valid reps is a real regression (a
  // skill that crashes every time) and is scored; the header still names it.
  const allErrored = (arm: string, scenario: string) => {
    const mine = classified.filter((x) => x.line.arm === arm && x.line.scenario === scenario);
    return mine.length > 0 && mine.every((x) => ERRORED.has(x.c.bucket)) ? mine : null;
  };
  const erroredArms: EvalReport["summary"]["erroredArms"] = [];
  for (const sc of m.scenarios) {
    const per = m.arms.map((a) => allErrored(a.label, sc.name));
    const both = per.every((x) => x !== null);
    // Infrastructure in any mix (a pool mismatch, a refused search, an infra error): that arm never ran on the evidence.
    const anyAllInfra = per.some((x) => x !== null && x.every((y) => INFRA_EXCLUDED.has(y.c.bucket)));
    m.arms.forEach((a, i) => {
      const mine = per[i];
      if (mine === null) return;
      const counts = new Map<string, { bucket: RepBucket; rule: string; count: number }>();
      for (const x of mine) {
        const k = `${x.c.bucket}\0${x.c.termination.rule}`;
        const e = counts.get(k) ?? { bucket: x.c.bucket, rule: x.c.termination.rule, count: 0 };
        e.count++;
        counts.set(k, e);
      }
      const dominant = [...counts.values()].sort(
        (p, q) => q.count - p.count || `${p.bucket}${p.rule}`.localeCompare(`${q.bucket}${q.rule}`),
      )[0];
      erroredArms.push({ arm: a.label, scenario: sc.name, reps: mine.length, dominant, rowsInsufficient: both || anyAllInfra });
    });
  }
  const comparedNothing = new Set(erroredArms.filter((e) => e.rowsInsufficient).map((e) => e.scenario));
  // `eval` has no resume, so a manifest and its runs.jsonl are written by one harness version: a manifest that froze
  // the declarations was written by a version that also recorded each rep's metrics.
  const metricsRecorded = m.scenarios.every((sc) => Array.isArray(sc.metrics));
  const tuned = tunedNames.length ? sectionOf(m, tunedNames, classified, threshold, comparedNothing, metricsRecorded) : null;
  const heldOut = heldNames.length ? sectionOf(m, heldNames, classified, threshold, comparedNothing, metricsRecorded) : null;

  const arms: ReportArm[] = m.arms.map((a) => {
    const mine = classified.filter((x) => x.line.arm === a.label);
    const buckets: Partial<Record<RepBucket, number>> = {};
    const errorSources: Record<string, number> = {};
    const evidenceUnavailable: Record<string, number> = {};
    const metricStates = {
      worst: {} as Record<string, number>,
      excluded: {} as Record<string, number>,
      notCompared: {} as Record<string, number>,
    };
    for (const x of mine) {
      if (metricsRecorded && !comparedNothing.has(x.line.scenario)) {
        const decls = m.scenarios.find((sc) => sc.name === x.line.scenario)?.metrics ?? [];
        for (const { v } of repMetricValues(decls, x.c, repEvidenceOf(x.line).result)) {
          const [bucket, key] =
            "worst" in v
              ? (["worst", v.worst] as const)
              : "excluded" in v
                ? (["excluded", v.excluded] as const)
                : "notCompared" in v
                  ? (["notCompared", v.notCompared] as const)
                  : [null, null];
          if (bucket) metricStates[bucket][key] = (metricStates[bucket][key] ?? 0) + 1;
        }
      }
      if (x.c.bucket === "valid" || x.c.bucket === "judge_invalid")
        for (const g of (repEvidenceOf(x.line).result?.assertions ?? []).filter((g) => g.source === undefined)) {
          const reason = g.judgeInvalid === true ? undefined : semanticRefusalReason(g);
          if (reason !== undefined) evidenceUnavailable[reason] = (evidenceUnavailable[reason] ?? 0) + 1;
        }
      buckets[x.c.bucket] = (buckets[x.c.bucket] ?? 0) + 1;
      const key = x.line.thrown
        ? `thrown:${x.line.thrown.kind}`
        : (x.c.termination.errorSource ?? (x.line.result?.result === "success" ? "none" : "unset"));
      errorSources[key] = (errorSources[key] ?? 0) + 1;
    }
    return {
      label: a.label,
      role: a.role,
      source: a.source,
      fileSet: a.fileSet,
      fileCount: a.fileCount,
      untrackedExcluded: a.untrackedExcluded,
      scheduled: m.settings.reps * m.scenarios.length,
      recorded: mine.length,
      buckets: Object.fromEntries(Object.entries(buckets).sort(([x], [y]) => x.localeCompare(y))),
      errorSources: Object.fromEntries(Object.entries(errorSources).sort(([x], [y]) => x.localeCompare(y))),
      unclassified: mine.filter((x) => x.c.termination.unclassified).length,
      ambiguousExit: mine.filter((x) => x.c.termination.ambiguousExit).length,
      evidenceUnavailable: Object.fromEntries(Object.entries(evidenceUnavailable).sort(([x], [y]) => x.localeCompare(y))),
      metricStates: {
        worst: Object.fromEntries(Object.entries(metricStates.worst).sort(([x], [y]) => x.localeCompare(y))),
        excluded: Object.fromEntries(Object.entries(metricStates.excluded).sort(([x], [y]) => x.localeCompare(y))),
        notCompared: Object.fromEntries(Object.entries(metricStates.notCompared).sort(([x], [y]) => x.localeCompare(y))),
      },
      medians: armMedians(mine.map((x) => ({ bucket: x.c.bucket, result: repEvidenceOf(x.line).result }))),
    };
  });

  // The judge must be one model per assertion across every scored rep that graded it (a judge_invalid grade
  // excluded). A tripwire that can only fire after spend, by construction.
  const judgeSeen = new Map<string, { scenario: string; assertionIndex: number; models: Set<string> }>();
  for (const { line, c } of classified) {
    if (!SCORED.has(c.bucket)) continue;
    const authored = (line.grades[0]?.assertions ?? []).filter((g) => g.source === undefined);
    authored.forEach((g, i) => {
      if ((!g.assertion.semantic_matches && !g.assertion.semantic_pairwise) || g.judgeInvalid === true || typeof g.judgeModel !== "string")
        return;
      const k = JSON.stringify([line.scenario, i]);
      const e = judgeSeen.get(k) ?? { scenario: line.scenario, assertionIndex: i, models: new Set<string>() };
      e.models.add(normalizeModel(g.judgeModel));
      judgeSeen.set(k, e);
    });
  }
  const judgeDisagreements = [...judgeSeen.values()]
    .filter((e) => e.models.size > 1)
    .map((e) => ({ scenario: e.scenario, assertionIndex: e.assertionIndex, models: [...e.models].sort() }));

  const familyRows = [...(tuned?.rows ?? []), ...(heldOut?.rows ?? [])];
  const gatingRows = [...familyRows, ...(tuned?.derivedRows ?? []), ...(heldOut?.derivedRows ?? [])];
  const metricRows = [...(tuned?.metricRows ?? []), ...(heldOut?.metricRows ?? [])];
  const labels: Record<string, number> = {};
  for (const r of familyRows) labels[r.label] = (labels[r.label] ?? 0) + 1;
  const metricLabels: Record<string, number> = {};
  for (const r of metricRows) metricLabels[r.label] = (metricLabels[r.label] ?? 0) + 1;
  // A metric that got worse is the same gating signal as a pass-rate drop; `better`, `unresolved` and `not compared`
  // metric rows never gate.
  const failOnHit =
    m.settings.failOn !== null &&
    (gatingRows.some((r) =>
      m.settings.failOn === "confirmed"
        ? r.label === "confirmed drop"
        : r.label === "possible drop" || r.label === "confirmed drop" || r.label === "insufficient_refusals",
    ) ||
      metricRows.some((r) =>
        m.settings.failOn === "confirmed"
          ? r.label === "confirmed worse"
          : r.label === "possible worse" || r.label === "confirmed worse" || r.label === "insufficient_unmeasured",
      ));
  // Plain `insufficient` only: an `insufficient_refusals` / `insufficient_unmeasured` row is a drop signal, gated by
  // --fail-on alone. Over both families, so a metrics-only eval whose every row is insufficient exits 1.
  const unionRows: Array<{ label: string }> = [...familyRows, ...metricRows];
  const allInsufficient = unionRows.length > 0 && unionRows.every((r) => r.label === "insufficient");
  const notCompared = metricRows.filter((r) => r.label === "not compared").length;
  const sectionsList = [
    ["tuned", tuned],
    ["heldOut", heldOut],
  ] as const;
  const familiesSummary = sectionsList.flatMap(([section, sec]) => (sec?.families ?? []).map((f) => ({ ...f, section })));
  const confirmReach = sectionsList.flatMap(([section, sec]) => {
    if (!sec) return [];
    const frozen = m.scenarios.filter((sc) => sec.scenarios.includes(sc.name));
    const fams = sectionFamilies(
      frozen.map((sc) => ({ name: sc.name, assertions: sc.assertions, metrics: metricsRecorded ? (sc.metrics ?? []) : [] })),
      {
        correction: m.settings.correction,
        alpha: m.settings.alpha,
        q: m.settings.q,
        ...(m.settings.metricCorrection ? { metricCorrection: m.settings.metricCorrection } : {}),
      },
    );
    return familyReach(fams, m.settings.reps).map((r) => ({ section, kind: r.kind, m: r.m, minRowsToConfirm: r.minRowsToConfirm }));
  });
  const refusalImbalances = [...(tuned?.refusalImbalances ?? []), ...(heldOut?.refusalImbalances ?? [])];
  const judgeDisagreement = judgeDisagreements.length > 0;
  const searchCorpus = m.pins.searchCorpus ? corpusSection(m, classified) : undefined;
  const mismatched = classified.filter((x) => x.c.bucket === "search_pool_mismatch");
  const searchPoolMismatch = m.pins.searchCorpus
    ? {
        reps: mismatched.length,
        byArm: Object.fromEntries(m.arms.map((a) => [a.label, mismatched.filter((x) => x.line.arm === a.label).length])),
      }
    : undefined;
  const confoundedBy = searchCorpus
    ? {
        ...(searchCorpus.provenance && (searchCorpus.provenance.class === "one-sided" || searchCorpus.provenance.class === "unknown")
          ? { provenance: searchCorpus.provenance.class }
          : {}),
        ...([searchCorpus.asymmetry.total, ...Object.values(searchCorpus.asymmetry.perScenario)].some((c) => c.judged && c.fires)
          ? { asymmetry: true as const }
          : {}),
      }
    : {};
  const recordedIdx = new Set(lines.map((l) => l.index));
  const missingJobs = m.settings.reps * m.scenarios.length * 2 - recordedIdx.size;
  return {
    schemaVersion: 0,
    evalId: m.evalId,
    startedAt: m.startedAt,
    harnessVersion: m.harnessVersion,
    arms,
    settings: { ...m.settings, threshold },
    pins: m.pins,
    skill: m.skill,
    sections: { tuned, heldOut },
    judgeDisagreements,
    reps: classified.map(({ line, c }) => ({
      index: line.index,
      arm: line.arm,
      scenario: line.scenario,
      rep: line.rep,
      runDir: line.runDir,
      bucket: c.bucket,
      rule: c.termination.rule,
      unclassified: c.termination.unclassified,
    })),
    summary: {
      familyRows: familyRows.length,
      erroredArms,
      labels: Object.fromEntries(Object.entries(labels).sort(([x], [y]) => x.localeCompare(y))),
      metricLabels: Object.fromEntries(Object.entries(metricLabels).sort(([x], [y]) => x.localeCompare(y))),
      metricsRecorded,
      families: familiesSummary,
      confirmReach,
      notCompared,
      allInsufficient,
      failOnHit,
      judgeDisagreement,
      missingJobs,
      tornFinalLine,
      refusalImbalances,
      ...(searchPoolMismatch ? { searchPoolMismatch } : {}),
      ...(Object.keys(confoundedBy).length ? { confounded: confoundedBy } : {}),
      exitCode:
        failOnHit ||
        allInsufficient ||
        judgeDisagreement ||
        comparedNothing.size > 0 ||
        notCompared > 0 ||
        (searchPoolMismatch?.reps ?? 0) > 0
          ? 1
          : 0,
    },
    cost: {
      agentUsd: sumFinite(lines.map((l) => l.result?.cost?.usd)),
      judgeUsd: sumFinite(lines.flatMap((l) => (l.grades[0]?.assertions ?? []).map((a) => a.judgeCostUsd))),
    },
    stoppedEarly: null,
    redactedHostPaths: 0,
    ...(searchCorpus ? { searchCorpus } : {}),
  };
}

/** Per arm, per scenario and in total, over the arm's SCORED reps; plus the asymmetry marker between the two arms. */
function corpusSection(m: EvalManifest, classified: ClassifiedLine[]): ReportSearchCorpus {
  const pin = m.pins.searchCorpus!;
  const counts = (xs: ClassifiedLine[]) =>
    xs.flatMap((x) => {
      const sc = x.line.result?.searchCorpus;
      return sc
        ? [
            {
              served: sc.metrics.served,
              miss: sc.metrics.miss,
              ...(sc.metrics.meanTopScore !== undefined ? { meanTopScore: sc.metrics.meanTopScore } : {}),
            },
          ]
        : [];
    });
  const arms: ReportSearchCorpus["arms"] = {};
  for (const a of m.arms) {
    const mine = classified.filter((x) => x.line.arm === a.label);
    const scored = mine.filter((x) => SCORED.has(x.c.bucket));
    arms[a.label] = {
      total: sideMetrics(counts(scored)),
      perScenario: Object.fromEntries(
        m.scenarios.map((sc) => [sc.name, sideMetrics(counts(scored.filter((x) => x.line.scenario === sc.name)))]),
      ),
      refusedReps: mine.filter((x) => x.c.bucket === "search_refused").length,
      judgeWarned: scored.filter((x) => x.line.result?.searchCorpus?.signals?.includes("search_corpus_semantic_judge")).length,
    };
  }
  const [A, B] = m.arms;
  const cell = (f: (l: string) => CorpusSideMetrics) => asymmetry({ label: A.label, m: f(A.label) }, { label: B.label, m: f(B.label) });
  const provenance = m.searchCorpusProvenance ?? null;
  return {
    label: searchCorpusLabel(pin.poolId, pin.sha256),
    pin,
    provenance,
    provenanceLine: provenance ? provenanceLine(provenance) : "pool provenance: not recorded",
    arms,
    asymmetry: {
      total: cell((l) => arms[l]!.total),
      perScenario: Object.fromEntries(m.scenarios.map((sc) => [sc.name, cell((l) => arms[l]!.perScenario[sc.name]!)])),
      thresholds: ASYMMETRY_THRESHOLDS,
    },
  };
}

// ---- markdown ------------------------------------------------------------------------------------------

const pct = (k: number, n: number) => (n === 0 ? "—" : `${k}/${n} (${Math.round((100 * k) / n)}%)`);
const fmtP = (p: number | undefined) => (p === undefined ? "—" : p < 0.0001 ? p.toExponential(1) : p.toFixed(4));
const fmtDiff = (x: number) => `${x >= 0 ? "+" : ""}${Math.round(x * 100)}pp`;
const fmtMdd = (d: Mdd) => (d === "n/a" ? "n/a" : d === "none" ? "none at this n" : `${Math.round(d * 100)}pp`);
// Backslashes first: escaping only the pipe turns a source `\|` into `\\|`, where the backslash escapes the
// backslash and the pipe is a live column separator again.
const cell = (s: string) => s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");
const fmtUsd = (x: number | undefined) => (x === undefined ? "—" : `$${x.toFixed(4)}`);

function rowLine(r: ReportRow): string {
  const tested = r.label !== "insufficient" && r.label !== "insufficient_refusals";
  const ci = r.interval ? `${fmtDiff(r.interval.difference)} [${fmtDiff(r.interval.lower)}, ${fmtDiff(r.interval.upper)}]` : "—";
  const mdd = r.mdd && r.label === "no detectable change" ? `MDD drop ${fmtMdd(r.mdd.drop)}, rise ${fmtMdd(r.mdd.rise)}` : "";
  const note = [r.minPass !== undefined ? `min_pass ${r.minPass}` : "", mdd, r.note ?? ""].filter(Boolean).join("; ");
  const where = r.scenario ? `${r.scenario} #${r.assertionIndex}${r.kind === "claim" ? " claim" : ""}` : "";
  return `| ${cell(where)} | ${cell(r.text)} | ${pct(r.k1, r.n1)} | ${pct(r.k2, r.n2)} | ${ci} | ${tested ? fmtP(r.p) : "—"} | ${tested ? fmtP(r.adjustedP) : "—"} | **${r.label}** | ${cell(note)} |`;
}

const TABLE_HEAD = [
  "| row | assertion / claim | A | B | B − A [95% CI] | p | adj. p | label | note |",
  "|---|---|---|---|---|---|---|---|---|",
];

function renderSection(title: string, s: ReportSection, rep: EvalReport): string[] {
  const out: string[] = [`## ${title}`, ""];
  const reps = rep.settings.reps;
  const level = rep.settings.correction === "bh" ? `BH at q = ${rep.settings.q}` : `Holm at alpha = ${rep.settings.alpha}`;
  if (s.rows.length === 0) out.push("No rows.", "");
  else {
    out.push(`Scenarios: ${s.scenarios.join(", ")}. Correction family: ${s.m} tested row(s) (${level}).`);
    out.push(
      `Attainable p floor at ${reps} vs ${reps} valid reps: ${fmtP(s.floorAtFullReps)}${s.floorAtFullReps > rep.settings.alpha ? ` — above alpha ${rep.settings.alpha}: no row can be flagged at this n` : ""}. ` +
        (s.minRowsToConfirm === null
          ? "`confirmed` is unreachable in this section at this n."
          : `\`confirmed\` needs ≥ ${s.minRowsToConfirm} row(s) at the floor; confirmable rows now: ${s.confirmableRows}.`),
    );
    out.push(
      `Ceiling: ${s.ceilingRows} row(s) at 100% in both arms: an improvement is undetectable for them. ${s.zeroRows} row(s) at 0% in both arms: a drop is undetectable for them.`,
    );
    out.push("", ...TABLE_HEAD, ...s.rows.map(rowLine), "");
  }
  const flagged = [...s.rows, ...s.derivedRows].filter((r) => r.evidence);
  if (flagged.length) {
    out.push("Evidence (run dirs; may be gone after `prune`):");
    for (const r of flagged)
      out.push(
        `- ${r.scenario} #${r.assertionIndex} ${r.kind === "claim" ? `"${r.text}"` : r.text} — ${r.label}: A ${r.direction === "drop" ? "passed" : "failed"} in ${r.evidence!.a.join(", ") || "—"}; B ${r.direction === "drop" ? "failed" : "passed"} in ${r.evidence!.b.join(", ") || "—"}`,
      );
    out.push("");
  }
  if (s.derivedRows.length) {
    out.push(
      "Derived rows — semantic_matches roll-ups (a function of their claims via min_pass). Not in the correction family, never `confirmed`; a `possible drop` here still counts for `--fail-on possible`:",
      "",
      ...TABLE_HEAD,
      ...s.derivedRows.map(rowLine),
      "",
    );
  }
  out.push("Classification rows — diagnostic, not in the family, never gate:", "", ...TABLE_HEAD, ...s.classificationRows.map(rowLine), "");
  out.push(...renderFamilies(s), ...renderMetrics(s, rep));
  return out;
}

const fmtPct = (x: number) => `${(100 * x).toFixed(x < 0.001 ? 2 : 1)}%`;

/** Every family's correction, size and A/A false-confirm rate, so two reports compare line by line. */
function renderFamilies(s: ReportSection): string[] {
  if (s.families.length === 0) return [];
  const out = ["Correction families:"];
  for (const f of s.families) {
    const rule = f.correction === "bh" ? `BH at q = ${f.level}` : `Holm at ${f.level}`;
    const aa =
      f.aaFalseConfirm !== undefined
        ? `A/A false-confirm ${fmtPct(f.aaFalseConfirm)} (${f.aaBasis === "exact-no-ties" ? "exact, no ties; ties only lower it" : "exact at the observed rates"}; bound ${fmtPct(f.bound)})`
        : `A/A false-confirm ≤ ${fmtPct(f.bound)} (bound${f.correction === "bh" ? "; FWER ≤ q under the global null, PRDS" : ""})`;
    out.push(
      `- ${f.kind === "pass" ? "pass rates" : "metrics"}: m = ${f.m}, ${rule}${f.split ? " (alpha split across this section's families)" : f.kind === "pass" ? " (unsplit)" : ""}; ${aa}.` +
        (f.confirmedAddsNoEvidence ? " At these reps `confirmed` adds no evidence over `possible` in this family." : ""),
    );
  }
  const bound = s.families.reduce((n, f) => n + f.bound, 0);
  if (s.families.length > 1) out.push(`- section-wide: a false \`confirmed\` in either family ≤ ${fmtPct(bound)} by the bounds.`);
  out.push("");
  return out;
}

const fmtNum = (x: number | undefined) =>
  x === undefined ? "—" : Number.isInteger(x) ? String(x) : x.toPrecision(4).replace(/\.?0+$/, "");

function metricLine(r: MetricReportRow): string {
  const tested = r.label !== "insufficient" && r.label !== "insufficient_unmeasured" && r.label !== "not compared";
  const hl = r.hl ? `${fmtNum(r.hl.shift)} [${fmtNum(r.hl.lower)}, ${fmtNum(r.hl.upper)}] (${(100 * r.hl.coverage).toFixed(1)}%)` : "—";
  const p = tested ? (r.adversarialP !== undefined ? `${fmtP(r.p)} (survivor ${fmtP(r.survivorP)})` : fmtP(r.p)) : "—";
  const mds = r.mds
    ? `${r.mds.possible.sdUnits} SD ≈ ${fmtNum(r.mds.possible.units)} [${fmtNum(r.mds.possible.unitsRange.lower)}–${fmtNum(r.mds.possible.unitsRange.upper)}]` +
      (r.mds.confirmed ? `; confirmed ${r.mds.confirmed.sdUnits} SD ≈ ${fmtNum(r.mds.confirmed.units)}` : "; confirmed: unreachable")
    : "—";
  const excluded = (rec: Record<string, number>) => Object.values(rec).reduce((n, v) => n + v, 0);
  const counts = `A ${r.n1}${excluded(r.excluded.a) ? ` +${excluded(r.excluded.a)} excl.` : ""}, B ${r.n2}${excluded(r.excluded.b) ? ` +${excluded(r.excluded.b)} excl.` : ""}`;
  return `| ${cell(`${r.scenario} ${r.metricId}`)} | ${r.better} | ${fmtNum(r.medians.a)} / ${fmtNum(r.medians.b)} | ${counts} | ${hl} | ${fmtNum(r.sd.a)} / ${fmtNum(r.sd.b)} | ${p} | ${tested ? fmtP(r.adjustedP) : "—"} | **${r.label}** | ${cell(mds)} | ${cell(r.note ?? "")} |`;
}

const METRIC_HEAD = [
  "| metric | better | median A / B | reps in test | HL shift B − A [interval] (coverage) | SD A / SD B | p | adj. p | label | MDS possible (units) | note |",
  "|---|---|---|---|---|---|---|---|---|---|---|",
];

function renderMetrics(s: ReportSection, rep: EvalReport): string[] {
  if (s.metricRows.length === 0 || !s.metricFamily) return [];
  const f = s.metricFamily;
  const reps = rep.settings.reps;
  const out = [
    "Metric rows — an exact rank test (Wilcoxon–Mann–Whitney) per declared metric, in their own correction family. A rep where the agent failed or the skill did not write the number ranks worst; a rep whose number is missing because of the scorer or a cap is left out, and no verdict may rest on its absence (`unresolved`).",
    `Metric family: ${f.m} tested row(s); no-tie floor at ${reps} vs ${reps}: ${fmtP(f.floorAtFullReps)} (a lower bound; ties raise it). ` +
      (f.minRowsToConfirm === null
        ? "`confirmed` is unreachable for metrics at this n."
        : `\`confirmed\` needs ≥ ${f.minRowsToConfirm} row(s) at the floor; confirmable rows now: ${f.confirmableRows}.`),
  ];
  const sd = mdsSdUnits(reps, rep.settings.alpha);
  if (sd !== undefined)
    out.push(
      `At ${reps} reps a metric row detects only shifts of ≈ ${sd} SD (80% power; an offline normal-shift table, an estimate). The \`--fail-on\` gate acts on \`worse\` only, so its false-fail rate per row is half the two-sided figure.`,
    );
  out.push("", ...METRIC_HEAD, ...s.metricRows.map(metricLine), "");
  const flagged = s.metricRows.filter((r) => r.evidence);
  if (flagged.length) {
    out.push("Metric evidence (run dirs of each arm's most extreme reps; may be gone after `prune`):");
    for (const r of flagged)
      out.push(`- ${r.scenario} ${r.metricId} — ${r.label}: A ${r.evidence!.a.join(", ") || "—"}; B ${r.evidence!.b.join(", ") || "—"}`);
    out.push("");
  }
  return out;
}

/** What to check first, from the most frequent bucket and rule of an all-errored arm. */
export function erroredHint(d: { bucket: RepBucket; rule: string }): string {
  if (d.bucket === "errored_agent") return "The agent failed in every rep: read the run dirs.";
  if (d.bucket === "search_pool_mismatch")
    return "The reps were refused before they ran, or served off another pool: the eval's pool copy (search-pool/ in the eval dir) changed. Re-run the eval.";
  if (d.bucket === "search_refused")
    return "Searches were refused in every rep, so the arm worked from different evidence: read each run's search-corpus.jsonl for the refusal reason.";
  switch (d.rule) {
    case "auth":
      return "The agent could not sign in: check its credential for this tier (`cowork-harness doctor --tier <tier>`).";
    case "usage_limit":
    case "kind_usage_limit":
      return "A usage or spend limit was hit: check the account's quota, then re-run.";
    case "no_model_answered":
      return "No model answered: check the agent's credential and the account's quota (`cowork-harness doctor --tier <tier>`).";
    case "source_spawn":
    case "thrown_boundary":
      return "The agent could not be started: check this tier's prerequisites (`cowork-harness doctor --tier <tier>`).";
    case "source_protocol":
    case "kind_transport":
      return "The connection to the agent or the API failed: check the network and re-run.";
    case "source_decider_timeout":
    case "thrown_decider_timeout":
      return "The --decider-cmd / --decider-dir channel did not answer in time: check the helper.";
    case "source_answer_channel_violation":
      return "Under answer_channel: none the agent sent a question or permission request anyway: check that the agent version honours --permission-prompts none.";
    default:
      return "A termination the classifier does not recognise: read the run dirs.";
  }
}

const REDACTION_PLACEHOLDER = "@@EVAL_REDACTION_COUNT@@";

export function renderReportMarkdown(rep: EvalReport): { text: string; redacted: number } {
  const L: string[] = [];
  const [A, B] = rep.arms;
  L.push(`# Paired evaluation ${rep.evalId}`, "");
  L.push(`Started ${rep.startedAt} · cowork-harness ${rep.harnessVersion} · EXPERIMENTAL (report schema and labels may change)`, "");
  L.push("Units: runs × grades — each rep is one run, graded once. **A drop is a signal to investigate, not proof.**", "");
  for (const a of [A, B])
    L.push(
      `- **${a.role} ${a.role === "A" ? "(baseline)" : "(candidate)"}: ${a.label}** = \`${a.source}\` — ${a.fileCount} file(s), ${a.untrackedExcluded} untracked excluded (${a.fileSet})`,
    );
  L.push("");
  const s = rep.settings;
  L.push(
    `Reps: ${s.reps} per arm per scenario, scheduled ABBA (rep 1 runs A then B, rep 2 B then A, …); a row needs ≥ ${s.threshold} valid reps per arm${s.allowUnderpowered ? " (--allow-underpowered)" : ""}. ` +
      `Correction: ${s.correction === "bh" ? `bh (q = ${s.q}, fixed)` : "holm"}, within each section; alpha ${s.alpha}. ${s.failOn === null ? "No --fail-on: no drop fails the eval (an all-insufficient result or a judge disagreement still exits 1)." : `--fail-on ${s.failOn}.`}`,
  );
  L.push("Family: claim sub-rows and non-semantic assertion rows. Roll-up and classification rows are shown separately.");
  L.push("No control arm: prior-answerable claims are not flagged.");
  const agentModels = [...new Set(rep.pins.agent.map((p) => p.model))].join(", ");
  const judgeModels = [...new Set(rep.pins.judge.resolved.map((p) => p.model))].join(", ") || "none (no judged assert)";
  L.push(
    `Agent model: ${agentModels}. Judge (${rep.pins.judge.mode === "override" ? "--judge-model" : "per assert"}): ${judgeModels}; prompt ${rep.pins.judge.promptHash.slice(0, 12)}.`,
  );
  if (!rep.summary.metricsRecorded)
    L.push("Metrics: not recorded in this eval dir (written before eval graded `metrics:`); re-run the eval to grade them.");
  if (rep.searchCorpus) {
    const sc = rep.searchCorpus;
    L.push(`Search: [${sc.label}]. Both arms were served from one private copy of the pool, pinned to its hash.`);
    L.push(
      `${sc.provenanceLine}. A frozen corpus holds search fixed: it cannot evaluate a change to what or when the skill searches (evaluate that live).`,
    );
    L.push(`Total: ${asymmetryLine(sc.asymmetry.total, sc.arms[A.label]!.total, sc.arms[B.label]!.total)}.`);
    if (Object.keys(sc.asymmetry.perScenario).length > 1)
      for (const [name, cell] of Object.entries(sc.asymmetry.perScenario))
        L.push(`- ${name}: ${asymmetryLine(cell, sc.arms[A.label]!.perScenario[name]!, sc.arms[B.label]!.perScenario[name]!)}`);
    if (rep.summary.confounded)
      L.push(
        `**CONFOUNDED** (${[rep.summary.confounded.provenance ? `pool ${rep.summary.confounded.provenance}` : "", rep.summary.confounded.asymmetry ? "asymmetric service" : ""].filter(Boolean).join(", ")}): read the comparison as the arms' behaviour on unequal evidence, not as the edit's effect.`,
      );
  }
  L.push(`Host paths redacted: ${REDACTION_PLACEHOLDER}.`, "");

  L.push("### Reps per arm", "");
  for (const a of [A, B]) {
    L.push(
      `- ${a.label}: ${a.recorded}/${a.scheduled} recorded; buckets ${
        Object.entries(a.buckets)
          .map(([k, v]) => `${k} ${v}`)
          .join(", ") || "none"
      }; errorSource ${
        Object.entries(a.errorSources)
          .map(([k, v]) => `${k} ${v}`)
          .join(", ") || "none"
      }`,
    );
    if (a.unclassified > 0)
      L.push(
        `  - **⚠ UNCLASSIFIED: ${a.unclassified} rep(s) in ${a.label}** — a termination the classification table does not recognise; excluded from the denominator. Read those run dirs before trusting this arm's rates.`,
      );
    if (a.ambiguousExit > 0)
      L.push(
        `  - ⚠ ${a.ambiguousExit} rep(s) ended in a nonzero agent exit — an out-of-memory kill and a skill-caused crash look alike here; scored as the agent's error.`,
      );
    const refused = Object.values(a.evidenceUnavailable).reduce((n, v) => n + v, 0);
    if (refused > 0)
      L.push(
        `  - ⚠ ${refused} semantic_matches grade(s) refused for unavailable evidence (${Object.entries(a.evidenceUnavailable)
          .map(([k, v]) => `${k} ${v}`)
          .join(", ")}) — neither a pass nor a fail, so each leaves that assertion's rows for that rep. An arm that refuses more ` +
          `often is producing evidence the judge cannot see whole; read those run dirs.` +
          (a.evidenceUnavailable.unrecorded
            ? ` (\`unrecorded\`: a runs.jsonl written before the reason was kept; there, a refusal whose claims also missed min_pass reads as a fail.)`
            : ""),
      );
    const states = (rec: Record<string, number>) =>
      Object.entries(rec)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ");
    if (Object.keys(a.metricStates.worst).length) L.push(`  - metric values ranked worst: ${states(a.metricStates.worst)}`);
    if (Object.keys(a.metricStates.excluded).length)
      L.push(
        `  - **⚠ metric values excluded (the scorer, the capture or a cap — not the skill): ${states(a.metricStates.excluded)}** — left out of the rank test and guarded, so no verdict rests on them; read those run dirs.`,
      );
    if (Object.keys(a.metricStates.notCompared).length)
      L.push(
        `  - **⚠ metric states that break the comparison: ${states(a.metricStates.notCompared)}** — a harness defect; those metric rows are not compared (exit 1).`,
      );
    const sca = rep.searchCorpus?.arms[a.label];
    if (sca) {
      const t = sca.total;
      L.push(
        `  - search (scored reps): ${t.served} served, ${t.miss} miss, miss rate ${t.missRate === undefined ? "—" : t.missRate.toFixed(2)}, mean top score ${t.meanTopScore === undefined ? "—" : t.meanTopScore.toFixed(2)}; ${sca.refusedReps} rep(s) excluded for a refused search`,
      );
      if (sca.judgeWarned > 0)
        L.push(
          `  - ⚠ ${sca.judgeWarned} rep(s) graded by a judge on recorded searches: a grade there is not evidence of research quality.`,
        );
    }
    const md = a.medians;
    L.push(
      `  - medians over ${md.eligibleReps} scored rep(s): cost ${fmtUsd(md.costUsd.median)} (n=${md.costUsd.n}), judge ${fmtUsd(md.judgeCostUsd.median)} (n=${md.judgeCostUsd.n}), turns ${md.turns.median ?? "—"} (n=${md.turns.n}), duration ${md.durationMs.median === undefined ? "—" : `${Math.round(md.durationMs.median / 1000)}s`} (n=${md.durationMs.n})`,
    );
  }
  if (rep.summary.missingJobs > 0) L.push(`- ⚠ ${rep.summary.missingJobs} scheduled job(s) have no record (the eval did not finish).`);
  if (rep.summary.tornFinalLine) L.push("- ⚠ runs.jsonl ends in a torn line (skipped).");
  L.push("");
  for (const e of rep.summary.erroredArms)
    L.push(
      `**⚠ Every rep of arm ${e.arm} in ${e.scenario} errored** — ${e.dominant.bucket} (${e.dominant.rule}) ${e.dominant.count}/${e.reps}. ` +
        (e.rowsInsufficient
          ? `Nothing was compared: ${e.scenario}'s rows are insufficient (exit 1). `
          : "Each of those reps is scored as failing every row (the other arm ran). ") +
        erroredHint(e.dominant),
      "",
    );
  const pm = rep.summary.searchPoolMismatch;
  if (pm && pm.reps > 0)
    L.push(
      `**⚠ ${pm.reps} rep(s) were not served from the pinned pool** (${Object.entries(pm.byArm)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")}): each was refused before it ran, or its evidence came from another pool. They are excluded and the eval exits 1. ` +
        erroredHint({ bucket: "search_pool_mismatch", rule: "" }),
      "",
    );
  for (const r of rep.summary.refusalImbalances) {
    L.push(
      `**⚠ ${r.scenario} #${r.assertionIndex} (semantic_matches) refused for unavailable evidence: A ${r.a.refused}/${r.a.scored}, B ${r.b.refused}/${r.b.scored} scored reps** — ` +
        `a refused grade leaves the rows, so the rates are over the reps that were graded. ` +
        (r.insufficientRefusals
          ? `The candidate's excess refusals left its rows \`insufficient_refusals\` — a drop signal (\`--fail-on possible\` gates on it): the edit may have made the deliverable outgrow the evidence the judge can see, hiding a drop rather than showing none.`
          : r.b.refused > r.a.refused
            ? "Read the candidate's run dirs: a deliverable that outgrew the evidence budget can hide a drop."
            : "Read those run dirs before trusting this assertion's rows."),
      "",
    );
  }
  // Excluded metric values unbalanced between the arms: the only signal of a candidate whose scorer fails exactly on
  // its bad runs, so it is named in the header whatever the row's label.
  const total = (rec: Record<string, number>) => Object.values(rec).reduce((n, v) => n + v, 0);
  const listed = (rec: Record<string, number>) =>
    Object.entries(rec)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ");
  for (const r of [...(rep.sections.tuned?.metricRows ?? []), ...(rep.sections.heldOut?.metricRows ?? [])]) {
    const excess = total(r.excluded.b) - total(r.excluded.a);
    if (Math.abs(excess) < UNMEASURED_GAP) continue;
    const more = excess > 0 ? "B" : "A";
    L.push(
      `**⚠ ${r.scenario} ${r.metricId}: ${more}: ${Math.abs(excess)} more excluded metric values than ${more === "B" ? "A" : "B"}** (A ${listed(r.excluded.a) || "none"}; B ${listed(r.excluded.b) || "none"}) — ` +
        "values the scorer, the capture or a cap left out; the row is graded on the rest, and a scorer that fails exactly on the bad runs hides a regression. Read those run dirs.",
      "",
    );
  }
  if (rep.judgeDisagreements.length) {
    L.push("**⚠ Judge model differed across reps** (exit 1):");
    for (const d of rep.judgeDisagreements) L.push(`- ${d.scenario} #${d.assertionIndex}: ${d.models.join(", ")}`);
    L.push("");
  }
  if (rep.sections.tuned) L.push(...renderSection(rep.sections.heldOut ? "Tuned scenarios" : "Rows", rep.sections.tuned, rep));
  if (rep.sections.heldOut) L.push(...renderSection("Held-out scenarios", rep.sections.heldOut, rep));
  L.push("## Summary", "");
  L.push(
    `Labels: ${
      Object.entries(rep.summary.labels)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ") || "none"
    }.`,
  );
  if (rep.summary.allInsufficient)
    L.push(
      `Every row is insufficient — see the errorSource histogram above for why reps were lost${
        rep.arms.some((a) => Object.keys(a.evidenceUnavailable).length > 0)
          ? ", and the evidence-refusal counts per arm: a refused semantic_matches grade also leaves its rows"
          : ""
      }.`,
    );
  if (Object.keys(rep.summary.metricLabels).length)
    L.push(
      `Metric labels: ${Object.entries(rep.summary.metricLabels)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")}.`,
    );
  if (rep.summary.notCompared > 0)
    L.push(`${rep.summary.notCompared} metric row(s) not compared (exit 1): see the per-arm metric states above.`);
  L.push(`Cost: agent ${fmtUsd(rep.cost.agentUsd)}, judge ${fmtUsd(rep.cost.judgeUsd)}.`);
  L.push(
    `Exit: ${rep.summary.exitCode}${rep.summary.failOnHit ? ` (a drop or a worse metric at the --fail-on ${rep.settings.failOn} level)` : ""}${rep.summary.failOnHit && [...(rep.sections.tuned?.rows ?? []), ...(rep.sections.tuned?.derivedRows ?? []), ...(rep.sections.heldOut?.rows ?? []), ...(rep.sections.heldOut?.derivedRows ?? [])].some((r) => r.label === "insufficient_refusals") ? " — including an insufficient_refusals row" : ""}.`,
    "",
  );
  const { text, redacted } = redactHostPaths(L.join("\n"));
  return { text: text.replace(REDACTION_PLACEHOLDER, String(redacted)), redacted };
}

export { redactHostPaths } from "../run/host-path-tokens.js";

/** Build, render and write `report.json` + `report.md`. The single path for both the live eval and
 *  `eval report`. */
export function writeEvalReport(evalDir: string): EvalReport {
  const model = buildEvalReport(evalDir);
  const { text, redacted } = renderReportMarkdown(model);
  const withCount = { ...model, redactedHostPaths: redacted };
  writeFileSync(join(evalDir, REPORT_JSON), JSON.stringify(withCount, null, 2) + "\n");
  writeFileSync(join(evalDir, REPORT_MD), text);
  return withCount;
}
