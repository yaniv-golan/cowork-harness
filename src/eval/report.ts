// The eval report: built from `manifest.json` + `runs.jsonl` alone, by ONE function that both the live eval
// and `eval report <dir>` call — so the two are byte-identical by construction. Pure apart from reading and
// writing the eval dir: no clock, no environment beyond $HOME (for `~` redaction).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifyRep,
  repRowValues,
  scenarioRows,
  armMedians,
  semanticRefusalReason,
  type ArmMedians,
  type RepBucket,
  type RowKey,
  type RepClassification,
} from "./classify.js";
import {
  attainableFloor,
  evaluateFamily,
  insufficientThreshold,
  minRowsToConfirm,
  ceilingRowCount,
  zeroRowCount,
  type FamilyRowOutput,
  type Mdd,
} from "./stats.js";
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
    allInsufficient: boolean;
    /** Every section's `refusalImbalances`, tuned first. */
    refusalImbalances: RefusalImbalance[];
    failOnHit: boolean;
    judgeDisagreement: boolean;
    missingJobs: number;
    tornFinalLine: boolean;
    exitCode: 0 | 1;
  };
  cost: { agentUsd: number; judgeUsd: number };
  stoppedEarly: null;
  redactedHostPaths: number;
}

const SCORED: ReadonlySet<RepBucket> = new Set(["valid", "judge_invalid", "errored_agent"]);
const ERRORED: ReadonlySet<RepBucket> = new Set(["errored_infra", "errored_agent"]);

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
  };
}

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
    c: classifyRep(repEvidenceOf(line), { contentSig: sigFor(line.arm, line.scenario), judgePromptHash: m.pins.judge.promptHash }),
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
    const anyAllInfra = per.some((x) => x !== null && x.every((y) => y.c.bucket === "errored_infra"));
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
  const tuned = tunedNames.length ? sectionOf(m, tunedNames, classified, threshold, comparedNothing) : null;
  const heldOut = heldNames.length ? sectionOf(m, heldNames, classified, threshold, comparedNothing) : null;

  const arms: ReportArm[] = m.arms.map((a) => {
    const mine = classified.filter((x) => x.line.arm === a.label);
    const buckets: Partial<Record<RepBucket, number>> = {};
    const errorSources: Record<string, number> = {};
    const evidenceUnavailable: Record<string, number> = {};
    for (const x of mine) {
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
  const labels: Record<string, number> = {};
  for (const r of familyRows) labels[r.label] = (labels[r.label] ?? 0) + 1;
  const failOnHit =
    m.settings.failOn !== null &&
    gatingRows.some((r) =>
      m.settings.failOn === "confirmed"
        ? r.label === "confirmed drop"
        : r.label === "possible drop" || r.label === "confirmed drop" || r.label === "insufficient_refusals",
    );
  // Plain `insufficient` only: an `insufficient_refusals` row is a drop signal, gated by --fail-on alone.
  const allInsufficient = familyRows.length > 0 && familyRows.every((r) => r.label === "insufficient");
  const refusalImbalances = [...(tuned?.refusalImbalances ?? []), ...(heldOut?.refusalImbalances ?? [])];
  const judgeDisagreement = judgeDisagreements.length > 0;
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
      allInsufficient,
      failOnHit,
      judgeDisagreement,
      missingJobs,
      tornFinalLine,
      refusalImbalances,
      exitCode: failOnHit || allInsufficient || judgeDisagreement || comparedNothing.size > 0 ? 1 : 0,
    },
    cost: {
      agentUsd: sumFinite(lines.map((l) => l.result?.cost?.usd)),
      judgeUsd: sumFinite(lines.flatMap((l) => (l.grades[0]?.assertions ?? []).map((a) => a.judgeCostUsd))),
    },
    stoppedEarly: null,
    redactedHostPaths: 0,
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
  return out;
}

/** What to check first, from the most frequent bucket and rule of an all-errored arm. */
export function erroredHint(d: { bucket: RepBucket; rule: string }): string {
  if (d.bucket === "errored_agent") return "The agent failed in every rep: read the run dirs.";
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
  L.push(`Cost: agent ${fmtUsd(rep.cost.agentUsd)}, judge ${fmtUsd(rep.cost.judgeUsd)}.`);
  L.push(
    `Exit: ${rep.summary.exitCode}${rep.summary.failOnHit ? ` (a drop at the --fail-on ${rep.settings.failOn} level)` : ""}${rep.summary.failOnHit && [...(rep.sections.tuned?.rows ?? []), ...(rep.sections.tuned?.derivedRows ?? []), ...(rep.sections.heldOut?.rows ?? []), ...(rep.sections.heldOut?.derivedRows ?? [])].some((r) => r.label === "insufficient_refusals") ? " — including an insufficient_refusals row" : ""}.`,
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
