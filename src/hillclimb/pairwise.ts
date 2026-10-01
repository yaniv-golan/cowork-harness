// `semantic_pairwise` inside a hillclimb flow: which frozen references a pass judges against, how a run is told
// about them, and the values its row carries.
//
// A flow's references live in the flow: `<flow>/baseline/ref` (frozen from a good baseline row) and, after a
// `hillclimb freeze-ref`, `<flow>/vN/ref`. Every pairwise assert of every case is judged against all of them — the
// scenario's own `refs:` is ignored under hillclimb. Only the baseline GATES the verdict (`pass_if`); a later
// variant's reference is a metric (`win_<vN>`), so freezing one never changes what `pass` means.

import { join } from "node:path";
import { readdirSync } from "node:fs";
import type { Assertion, RunResult } from "../types.js";
import type { PairwiseRef } from "../run/pairwise-prepass.js";
import { lstatOrNull } from "./fs.js";
import { VARIANT_DIR_RE, UNTRUSTED_JUDGE_PREFIX } from "./schema-check.js";

export const BASELINE_REF = "baseline";

/** The flow's references: `baseline` always (its store may not exist yet — a baseline pass is neutral against it
 *  and freezes it; any other pass is refused until it exists), then every `vN` whose `ref/` exists, in numeric
 *  order. Read without following links: a symlinked `ref` is still listed, and reading it then fails integrity
 *  for that reference alone. */
export function discoverFlowRefs(flowAbs: string): PairwiseRef[] {
  const refs: PairwiseRef[] = [{ name: BASELINE_REF, store: join(flowAbs, BASELINE_REF, "ref") }];
  let names: string[] = [];
  try {
    names = readdirSync(flowAbs);
  } catch {
    return refs;
  }
  const variants = names
    .filter((n) => n !== BASELINE_REF && VARIANT_DIR_RE.test(n))
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  for (const v of variants) if (lstatOrNull(join(flowAbs, v, "ref")) !== null) refs.push({ name: v, store: join(flowAbs, v, "ref") });
  return refs;
}

/** The `ExecuteOptions.pairwise` (and the matching pre-spend setup) for one case of one pass. */
export function flowPairwiseOptions(
  caseId: string,
  variant: string,
  refs: readonly PairwiseRef[],
): { caseId: string; refs: PairwiseRef[]; neutralRefs: string[]; gateRefs: string[] } {
  return { caseId, refs: [...refs], neutralRefs: [variant], gateRefs: [BASELINE_REF] };
}

/** The metric references (every discovered one but the baseline), by name. */
export const metricRefNames = (refs: readonly PairwiseRef[]): string[] => refs.map((r) => r.name).filter((n) => n !== BASELINE_REF);

const isPairwise = (a: Assertion): boolean => a.semantic_pairwise !== undefined;

type Entry = RunResult["assertions"][number];
type Outcome = NonNullable<Entry["pairwise"]>[number];

const valued = (o: Outcome | undefined): o is Outcome & { value: number } =>
  o !== undefined && (o.status === "graded" || o.status === "neutral") && typeof o.value === "number";

const EXPLANATION_CAP = 2000;

/** The pairwise grade keys of one scored row, and the `win` explanation.
 *
 *  - `win`: the mean over the case's pairwise asserts of the value vs the baseline (1 win / 0.5 tie or both_bad / 0
 *    loss; 0.5 on the baseline's own rows, which are neutral). Omitted, with `win_present: 0`, when any of them was
 *    not compared with the baseline (refused evidence, a missing or damaged reference).
 *  - `both_bad`: 1 when any of them judged both outputs bad against the baseline; omitted with `win`.
 *  - `win_<vN>` / `win_<vN>_present`: the same against each later variant's reference — a metric only, so a
 *    comparison that could not be made blanks this column alone.
 *  - `a<i>_win` (+ `_<vN>`) and their `_present`: per assert, as drill-down.
 *  - An agent that failed (`errored_agent`) scores 0 everywhere, measured: the skill produced nothing to win with.
 *  - A case with no pairwise assert, in a flow that has some, carries every `_present` as 0 (one column set). */
export function pairwiseRowValues(input: {
  assertions: readonly Assertion[];
  entries: readonly Entry[];
  metricRefs: readonly string[];
  agentFailed: boolean;
}): { grade: Record<string, number>; explanation?: string } {
  const { assertions, entries, metricRefs, agentFailed } = input;
  const grade: Record<string, number> = {};
  const idx = assertions.map((a, i) => (isPairwise(a) ? i : -1)).filter((i) => i >= 0);
  const refsAll = [undefined, ...metricRefs] as const; // undefined = the baseline column (`win`)
  const col = (ref: string | undefined) => (ref === undefined ? "win" : `win_${ref}`);
  if (idx.length === 0) {
    for (const ref of refsAll) grade[`${col(ref)}_present`] = 0;
    return { grade };
  }
  if (agentFailed) {
    for (const ref of refsAll) {
      grade[`${col(ref)}_present`] = 1;
      grade[col(ref)] = 0;
      for (const i of idx) {
        grade[`a${i}_${col(ref)}_present`] = 1;
        grade[`a${i}_${col(ref)}`] = 0;
      }
    }
    grade.both_bad = 0;
    return { grade };
  }
  const refused = (i: number): boolean => {
    const e = entries[i];
    return e === undefined || (e.semanticEvidence !== undefined && e.semanticEvidence.reason !== "graded") || e.pairwise === undefined;
  };
  const outcome = (i: number, ref: string) => (refused(i) ? undefined : entries[i]!.pairwise!.find((o) => o.ref === ref));
  for (const ref of refsAll) {
    const name = ref ?? "baseline";
    const values: number[] = [];
    for (const i of idx) {
      const o = outcome(i, name);
      if (valued(o)) {
        grade[`a${i}_${col(ref)}_present`] = 1;
        grade[`a${i}_${col(ref)}`] = o.value;
        values.push(o.value);
      } else grade[`a${i}_${col(ref)}_present`] = 0;
    }
    if (values.length === idx.length) {
      grade[`${col(ref)}_present`] = 1;
      grade[col(ref)] = values.reduce((s, v) => s + v, 0) / values.length;
    } else grade[`${col(ref)}_present`] = 0;
  }
  if (grade.win_present === 1) grade.both_bad = idx.some((i) => outcome(i, "baseline")?.outcome === "both_bad") ? 1 : 0;
  // The judge's reasons for the baseline comparisons, when any was judged (a neutral row has none).
  const reasons = idx
    .map((i) => ({ i, o: outcome(i, "baseline") }))
    .filter((x) => x.o?.status === "graded" && x.o.rationale)
    .map((x) => `a${x.i} ${x.o!.outcome}: ${x.o!.rationale}`);
  if (grade.win_present === 1 && reasons.length) {
    const text = reasons.join(" | ");
    return { grade, explanation: UNTRUSTED_JUDGE_PREFIX + (text.length > EXPLANATION_CAP ? `${text.slice(0, EXPLANATION_CAP)}…` : text) };
  }
  return { grade };
}
