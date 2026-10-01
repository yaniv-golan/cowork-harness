// The grade keys of a flow's scenario-declared metrics, from one run's measurements (RunResult.metrics).
//
// For every metric in the flow's union: `<id>_present` is 1 when the run measured it and 0 otherwise — including a
// metric this case does not declare — and `<id>` is the value only when measured: an unmeasured metric is OMITTED,
// never 0 (a 0 would be a fabricated failure, or a win for a lower-is-better metric). Why a metric was not measured
// is returned apart, keyed by id, for the row's meta: a reason is not a grade.

import type { MetricUnavailable, RunResult, ScenarioMetric } from "../types.js";

export function metricEntries(
  result: Pick<RunResult, "metrics">,
  decls: readonly ScenarioMetric[],
): { grade: Record<string, number>; unavailable: Record<string, MetricUnavailable> } {
  const grade: Record<string, number> = {};
  const unavailable: Record<string, MetricUnavailable> = {};
  for (const m of decls) {
    const got = result.metrics?.find((x) => x.id === m.id);
    const ok = typeof got?.value === "number" && Number.isFinite(got.value);
    grade[`${m.id}_present`] = ok ? 1 : 0;
    if (ok) grade[m.id] = got!.value!;
    if (got?.unavailable !== undefined) unavailable[m.id] = got.unavailable;
  }
  return { grade, unavailable };
}
