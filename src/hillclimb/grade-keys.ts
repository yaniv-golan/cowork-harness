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
// The per-index keys stay on every row as drill-down data, and are declared only when every case has the
// identical assertion list:
//   a<i>_present      1 when semantic assertion i was graded (its evidence was not refused)
//   a<i>              0|1 for a non-semantic assertion i
//   a<i>_c<j>         0|1 for claim j of semantic assertion i
// Every `_present` companion precedes the graded keys, so none can become the headline by accident.

import type { Assertion, ScenarioMetric } from "../types.js";
import { UsageError } from "../errors.js";
import { scenarioRows } from "../eval/classify.js";
import { firstAssertionKey } from "../run/repeat.js";

/** A scenario-declared numeric metric (the scenario's `metrics:` entry, whole). */
export type MetricDecl = ScenarioMetric;

export interface GradeKeyDecl {
  id: string;
  kind: "binary" | "float" | "judge";
  /** <= 14 characters (the full viewer's legend width, SCHEMA.md l.73-75). */
  label: string;
  better?: "higher" | "lower";
  scale?: number;
  /** A float's floor, when the scenario declares one: `check` reads it as the good end of a lower-is-better metric. */
  min?: number;
}

const LABEL_MAX = 14;
const label = (s: string): string => (s.length <= LABEL_MAX ? s : s.slice(0, LABEL_MAX));

const PASS: GradeKeyDecl = { id: "pass", kind: "binary", label: "Pass" };
const PASS_PRESENT: GradeKeyDecl = { id: "pass_present", kind: "binary", label: "pass measured" };
const CLAIMS_PRESENT: GradeKeyDecl = { id: "claims_present", kind: "binary", label: "claims graded" };
const CLAIMS: GradeKeyDecl = { id: "claims", kind: "judge", label: "Claims passed", scale: 1, better: "higher" };

/** Ids a scenario metric may not take — defined once, beside the scenario schema that refuses them. */
export { reservedMetricId } from "../types.js";

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
  ...(m.min !== undefined ? { min: m.min } : {}),
});
const presentDecl = (id: string): GradeKeyDecl => ({ id: `${id}_present`, kind: "binary", label: label(`${id} measured`) });

/** Every key one case's scored rows carry, in row order. `metrics` is the FLOW's union, so a case that does
 *  not declare a metric still carries its `_present` (as 0). `claims_present` is on every row. */
export function caseKeyDecls(assertions: readonly Assertion[], metrics: readonly MetricDecl[] = []): GradeKeyDecl[] {
  const idx = perIndex(assertions);
  return [
    PASS,
    PASS_PRESENT,
    CLAIMS_PRESENT,
    ...metrics.map((m) => presentDecl(m.id)),
    ...idx.companions,
    CLAIMS,
    ...idx.graded,
    ...metrics.map(floatDecl),
  ];
}

/** The metrics a flow declares, given each case's assertion list and its scenario-declared metrics. Throws
 *  UsageError when two cases declare one metric id differently. */
export function flowMetricDecls(
  cases: ReadonlyArray<{ assertions: readonly Assertion[]; metrics?: readonly MetricDecl[] }>,
): GradeKeyDecl[] {
  const union = metricUnion(cases);
  const anySemantic = cases.some((c) => hasSemantic(c.assertions));
  const first = cases[0]?.assertions ?? [];
  const identical = cases.every((c) => JSON.stringify(c.assertions) === JSON.stringify(first));
  const idx = identical ? perIndex(first) : { companions: [], graded: [] };
  return [
    PASS,
    PASS_PRESENT,
    ...(anySemantic ? [CLAIMS_PRESENT] : []),
    ...union.map((m) => presentDecl(m.id)),
    ...idx.companions,
    ...(anySemantic ? [CLAIMS] : []),
    ...idx.graded,
    ...union.map(floatDecl),
  ];
}

/** The union of the cases' scenario-declared metrics, in first-seen order. A metric id declared differently in
 *  another case (any field: the file, the path, the direction, the bound, the floor) is refused: one column cannot
 *  mean two things. Ids are compared case-insensitively, as the scenario compares its own: two spellings of one id
 *  would be two keys on a row but one file on a case-folding disk. */
export function metricUnion(cases: ReadonlyArray<{ metrics?: readonly MetricDecl[] }>): MetricDecl[] {
  const seen = new Map<string, MetricDecl>();
  const sig = (m: MetricDecl) => JSON.stringify([m.id, m.artifact, m.path, m.better, m.scale, m.unbounded, m.min]);
  for (const c of cases)
    for (const m of c.metrics ?? []) {
      const prev = seen.get(m.id.toLowerCase());
      if (prev === undefined) seen.set(m.id.toLowerCase(), m);
      else if (prev.id !== m.id)
        throw new UsageError(
          `metric "${prev.id}" and metric "${m.id}" differ only in case; ids are compared case-insensitively — spell them the same in every scenario`,
        );
      else if (sig(prev) !== sig(m))
        throw new UsageError(
          `metric "${m.id}" is declared differently in two scenarios (${JSON.stringify(prev)} vs ${JSON.stringify(m)}); one column cannot mean two things — make the declarations identical or rename one`,
        );
    }
  return [...seen.values()];
}

export { presentCompanionOf } from "./present.js";
