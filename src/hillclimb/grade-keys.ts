// The grade keys of a hillclimb row, declared from the scenario. ONE producer: the row writer emits exactly
// these keys and `state-template` declares exactly these metrics, so the two cannot drift.
//
// Order matters to the report: its headline is the first `binary` metric, else the first (L l.304; H
// l.148), so `pass` leads. Every `_present` companion comes next, before any graded key, so a companion can
// never become the headline by accident and the graded keys stay together.
//
// Keys:
//   pass              the run verdict, 0|1
//   <metric>_present  1 when the scenario-declared float <metric> was measured on this row (F2: the float
//                     itself is OMITTED when unavailable, never 0)
//   a<i>_present      1 when semantic assertion i was graded (its evidence was not refused); its claim keys
//                     are omitted otherwise — a refused grade is not a failed one
//   a<i>              0|1 for a non-semantic assertion i
//   a<i>_c<j>         0|1 for claim j of semantic assertion i (aligned by rubric index)
//   <metric>          the float value of a scenario-declared metric

import type { Assertion } from "../types.js";
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
  kind: "binary" | "float";
  /** <= 14 characters (the full viewer's legend width, M l.73-75). */
  label: string;
  better?: "higher" | "lower";
  scale?: number;
}

const LABEL_MAX = 14;
const label = (s: string): string => (s.length <= LABEL_MAX ? s : s.slice(0, LABEL_MAX));

export function gradeKeyDecls(assertions: readonly Assertion[], metrics: readonly MetricDecl[] = []): GradeKeyDecl[] {
  const rows = scenarioRows("", assertions);
  const companions: GradeKeyDecl[] = [];
  const graded: GradeKeyDecl[] = [];
  for (const m of metrics) companions.push({ id: `${m.id}_present`, kind: "binary", label: label(`${m.id} measured`) });
  for (const r of rows) {
    const i = r.assertionIndex;
    if (r.kind === "semantic_rollup") companions.push({ id: `a${i}_present`, kind: "binary", label: label(`a${i} graded`) });
    else if (r.kind === "assertion")
      graded.push({ id: `a${i}`, kind: "binary", label: label(`a${i} ${firstAssertionKey(assertions[i])}`) });
    else graded.push({ id: `a${i}_c${r.claimIndex}`, kind: "binary", label: label(`a${i} claim ${r.claimIndex}`) });
  }
  for (const m of metrics)
    graded.push({ id: m.id, kind: "float", label: label(m.id), better: m.better, ...(m.scale !== undefined ? { scale: m.scale } : {}) });
  return [{ id: "pass", kind: "binary", label: "Pass" }, ...companions, ...graded];
}

export { presentCompanionOf } from "./present.js";
