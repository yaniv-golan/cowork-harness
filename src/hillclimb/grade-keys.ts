// The grade keys of a hillclimb row, and the metrics a flow declares. ONE producer:
// the row writer emits a case's keys in `caseKeyDecls` order, and `state-template` declares `flowMetricDecls`.
//
// A flow's cases usually have different assertion lists, so a per-index key means different things on
// different rows. Declared are therefore only keys that mean the same on every row:
//   pass              the run verdict, 0|1 — first, so it is the report's headline (build-report-lite.mjs l.304; eval-hillclimb.md l.148).
//                     OMITTED when the verdict failed only because semantic grading was refused
//   pass_present      0 exactly then; 1 otherwise
//   claims_present    1 when at least one semantic_matches claim was graded on this row
//   <metric>_present  1 when the scenario-declared float <metric> was measured (the float is OMITTED
//                     when unavailable, never 0); a case that does not declare <metric> carries 0
//   claims            the pooled share of graded semantic_matches claims that passed (refused asserts
//                     excluded); judge kind, scale 1
//   <metric>          a scenario-declared float — the UNION over the flow's cases
// With semantic_pairwise in the flow (any case), every row also carries — the union rule, so a case without one
// carries the companions as 0:
//   win_present       1 when every pairwise assert of the case was compared with the baseline reference
//   win_<vN>_present  the same against a later variant's reference (a metric only, never the verdict)
//   win               the mean pairwise value vs the baseline (1 win, 0.5 tie or both_bad, 0 loss); judge kind
//   win_<vN>          the same vs <vN>'s reference
//   both_bad          1 when the judge found both outputs bad on any pairwise assert; its companion is win_present
// The per-index keys stay on every row as drill-down data, and are declared only when every case has the
// identical assertion list:
//   a<i>_present      1 when semantic assertion i was graded (its evidence was not refused)
//   a<i>              0|1 for a non-semantic assertion i
//   a<i>_c<j>         0|1 for claim j of semantic assertion i
//   a<i>_win(_<vN>)   the pairwise value of assertion i, with its a<i>_win(_<vN>)_present
// Every `_present` companion precedes the graded keys, so none can become the headline by accident.

import type { Assertion } from "../types.js";
import { UsageError } from "../errors.js";
import { scenarioRows } from "../eval/classify.js";
import { firstAssertionKey } from "../run/repeat.js";

/** A scenario-declared numeric metric, as the grade key and template need it. */
export interface MetricDecl {
  id: string;
  better: "higher" | "lower";
  scale?: number;
  unbounded?: true;
}

export interface GradeKeyDecl {
  id: string;
  kind: "binary" | "float" | "judge";
  /** <= 14 characters (the full viewer's legend width, SCHEMA.md l.73-75). */
  label: string;
  better?: "higher" | "lower";
  scale?: number;
}

const LABEL_MAX = 14;
const label = (s: string): string => (s.length <= LABEL_MAX ? s : s.slice(0, LABEL_MAX));

const PASS: GradeKeyDecl = { id: "pass", kind: "binary", label: "Pass" };
const PASS_PRESENT: GradeKeyDecl = { id: "pass_present", kind: "binary", label: "pass measured" };
const CLAIMS_PRESENT: GradeKeyDecl = { id: "claims_present", kind: "binary", label: "claims graded" };
const CLAIMS: GradeKeyDecl = { id: "claims", kind: "judge", label: "Claims passed", scale: 1, better: "higher" };
// Lower is better: a variant that raises both-bad is a regression, not a gain (a binary defaults to "higher").
const BOTH_BAD: GradeKeyDecl = { id: "both_bad", kind: "binary", label: "Both bad", better: "lower" };
const winId = (ref?: string) => (ref === undefined ? "win" : `win_${ref}`);
const winDecl = (ref?: string): GradeKeyDecl => ({
  id: winId(ref),
  kind: "judge",
  label: label(ref === undefined ? "Win vs base" : `Win vs ${ref}`),
  scale: 1,
  better: "higher",
});
const winPresentDecl = (ref?: string): GradeKeyDecl => ({
  id: `${winId(ref)}_present`,
  kind: "binary",
  label: label(ref === undefined ? "win measured" : `win ${ref} meas`),
});

/** A flow's `semantic_pairwise` columns: present when any of its cases has the key. `metricRefs` are the later
 *  variants' references (`v3`, …) — each a `win_<vN>` column. */
export interface PairwiseDecls {
  metricRefs: readonly string[];
}

/** The pairwise keys of a case, split as `perIndex` splits: companions first, graded after. `flow` adds the
 *  flow-wide columns; `perAssert` the per-index drill-down of THIS assertion list. */
function pairwiseKeys(
  assertions: readonly Assertion[],
  pw: PairwiseDecls,
  perAssert: boolean,
): { companions: GradeKeyDecl[]; graded: GradeKeyDecl[]; perIndexCompanions: GradeKeyDecl[]; perIndexGraded: GradeKeyDecl[] } {
  const refs = [undefined, ...pw.metricRefs];
  const idx = perAssert ? assertions.map((a, i) => (a.semantic_pairwise !== undefined ? i : -1)).filter((i) => i >= 0) : [];
  return {
    companions: refs.map(winPresentDecl),
    graded: [...refs.map(winDecl), BOTH_BAD],
    perIndexCompanions: idx.flatMap((i) =>
      refs.map((r) => ({ id: `a${i}_${winId(r)}_present`, kind: "binary" as const, label: label(`a${i} ${winId(r)} meas`) })),
    ),
    perIndexGraded: idx.flatMap((i) =>
      refs.map((r) => ({
        id: `a${i}_${winId(r)}`,
        kind: "judge" as const,
        label: label(`a${i} ${winId(r)}`),
        scale: 1,
        better: "higher" as const,
      })),
    ),
  };
}

/** Ids a scenario metric may not take: each would collide with a key the runner generates. */
export function reservedMetricId(id: string): boolean {
  return /^(pass|claims|win|both_bad)$/.test(id) || /^a\d+(_|$)/.test(id) || /_present$/.test(id) || /(^|_)(win|both_bad)(_|$)/.test(id);
}

const hasSemantic = (assertions: readonly Assertion[]) => assertions.some((a) => a.semantic_matches !== undefined);

/** A whole-assertion row the pairwise judge can refuse: a semantic_pairwise assert with no other key (a multi-key
 *  one keeps one pass for all its keys — classify.ts repRowValues). */
export const refusableAssertion = (a: Assertion): boolean => a.semantic_pairwise !== undefined && Object.keys(a).length === 1;

function perIndex(assertions: readonly Assertion[]): { companions: GradeKeyDecl[]; graded: GradeKeyDecl[] } {
  const companions: GradeKeyDecl[] = [];
  const graded: GradeKeyDecl[] = [];
  for (const r of scenarioRows("", assertions)) {
    const i = r.assertionIndex;
    if (r.kind === "semantic_rollup") companions.push({ id: `a${i}_present`, kind: "binary", label: label(`a${i} graded`) });
    else if (r.kind === "assertion") {
      // A single-key semantic_pairwise assert can be refused (its reference or evidence unavailable): not
      // measured, so it carries a companion like a semantic_matches roll-up.
      if (refusableAssertion(assertions[i])) companions.push({ id: `a${i}_present`, kind: "binary", label: label(`a${i} graded`) });
      graded.push({ id: `a${i}`, kind: "binary", label: label(`a${i} ${firstAssertionKey(assertions[i])}`) });
    } else graded.push({ id: `a${i}_c${r.claimIndex}`, kind: "binary", label: label(`a${i} claim ${r.claimIndex}`) });
  }
  return { companions, graded };
}

const floatDecl = (m: MetricDecl): GradeKeyDecl => ({
  id: m.id,
  kind: "float",
  label: label(m.id),
  better: m.better,
  ...(m.scale !== undefined ? { scale: m.scale } : {}),
});
const presentDecl = (id: string): GradeKeyDecl => ({ id: `${id}_present`, kind: "binary", label: label(`${id} measured`) });

/** Every key one case's scored rows carry, in row order. `metrics` is the FLOW's union, so a case that does
 *  not declare a metric still carries its `_present` (as 0). `claims_present` is on every row. */
export function caseKeyDecls(
  assertions: readonly Assertion[],
  metrics: readonly MetricDecl[] = [],
  pairwise?: PairwiseDecls,
): GradeKeyDecl[] {
  const idx = perIndex(assertions);
  const pw = pairwise ? pairwiseKeys(assertions, pairwise, true) : undefined;
  return [
    PASS,
    PASS_PRESENT,
    CLAIMS_PRESENT,
    ...(pw?.companions ?? []),
    ...metrics.map((m) => presentDecl(m.id)),
    ...idx.companions,
    ...(pw?.perIndexCompanions ?? []),
    CLAIMS,
    ...(pw?.graded ?? []),
    ...idx.graded,
    ...(pw?.perIndexGraded ?? []),
    ...metrics.map(floatDecl),
  ];
}

/** The metrics a flow declares, given each case's assertion list and its scenario-declared metrics. Throws
 *  UsageError when two cases declare one metric id differently. */
export function flowMetricDecls(
  cases: ReadonlyArray<{ assertions: readonly Assertion[]; metrics?: readonly MetricDecl[] }>,
  pairwise: PairwiseDecls = { metricRefs: [] },
): GradeKeyDecl[] {
  const union = metricUnion(cases);
  const anySemantic = cases.some((c) => hasSemantic(c.assertions));
  const first = cases[0]?.assertions ?? [];
  const identical = cases.every((c) => JSON.stringify(c.assertions) === JSON.stringify(first));
  const idx = identical ? perIndex(first) : { companions: [], graded: [] };
  const pw = flowHasPairwise(cases) ? pairwiseKeys(first, pairwise, identical) : undefined;
  return [
    PASS,
    PASS_PRESENT,
    ...(anySemantic ? [CLAIMS_PRESENT] : []),
    ...(pw?.companions ?? []),
    ...union.map((m) => presentDecl(m.id)),
    ...idx.companions,
    ...(pw?.perIndexCompanions ?? []),
    ...(anySemantic ? [CLAIMS] : []),
    ...(pw?.graded ?? []),
    ...idx.graded,
    ...(pw?.perIndexGraded ?? []),
    ...union.map(floatDecl),
  ];
}

/** Whether any case of the flow has a `semantic_pairwise` assert (every row then carries the win columns). */
export const flowHasPairwise = (cases: ReadonlyArray<{ assertions: readonly Assertion[] }>): boolean =>
  cases.some((c) => c.assertions.some((a) => a.semantic_pairwise !== undefined));

/** The union of the cases' scenario-declared metrics, in first-seen order. A metric id declared with a
 *  different direction or bound in another case is refused: one column cannot mean two things. */
export function metricUnion(cases: ReadonlyArray<{ metrics?: readonly MetricDecl[] }>): MetricDecl[] {
  const seen = new Map<string, MetricDecl>();
  for (const c of cases)
    for (const m of c.metrics ?? []) {
      const prev = seen.get(m.id);
      if (prev === undefined) seen.set(m.id, m);
      else if (prev.better !== m.better || prev.scale !== m.scale || prev.unbounded !== m.unbounded)
        throw new UsageError(
          `metric "${m.id}" is declared differently in two scenarios (${JSON.stringify(prev)} vs ${JSON.stringify(m)}); one column cannot mean two things — make the declarations identical or rename one`,
        );
    }
  return [...seen.values()];
}

export { presentCompanionOf } from "./present.js";
