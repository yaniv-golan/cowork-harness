// The grade keys of a flow's scenario-declared metrics, from one run's measurements (RunResult.metrics).
//
// For every metric in the flow's union: `<id>_present` is 1 when the run measured it and 0 otherwise — including a
// metric this case does not declare — and `<id>` is the value only when measured: an unmeasured metric is OMITTED,
// never 0 (a 0 would be a fabricated failure, or a win for a lower-is-better metric). Why a metric was not measured
// is returned apart, keyed by id, for the row's meta: a reason is not a grade.

import type { MetricUnavailable, RunResult, ScenarioMetric } from "../types.js";
import { UsageError } from "../errors.js";
import { metricSig } from "./grade-keys.js";
import type { FlowSnapshot } from "./schema-check.js";

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

/** The `meta.metric_sigs` of a row graded under these declarations: id → metricSig. The one producer, for the
 *  row writer and for any later pass that re-measures an old row's metrics (it sets `<id>`, `<id>_present` and
 *  this id's sig together). */
export function metricSigs(decls: readonly ScenarioMetric[]): Record<string, string> {
  return Object.fromEntries(decls.map((m) => [m.id, metricSig(m)]));
}

/** Each variant's scored rows' `meta.metric_sigs` (id → sig), in variant order (baseline, then v1, v2, ...). */
function rowSigs(snap: FlowSnapshot): Array<{ variant: string; sigs: Record<string, unknown> }> {
  const order = (v: string) => (v === "baseline" ? -1 : Number(v.slice(1)));
  const out: Array<{ variant: string; sigs: Record<string, unknown> }> = [];
  for (const variant of Object.keys(snap.variants).sort((a, b) => order(a) - order(b)))
    for (const line of (snap.variants[variant].results ?? "").split("\n")) {
      if (!line.trim()) continue;
      try {
        const sigs = (JSON.parse(line) as { meta?: { metric_sigs?: unknown } })?.meta?.metric_sigs;
        if (sigs && typeof sigs === "object" && !Array.isArray(sigs)) out.push({ variant, sigs: sigs as Record<string, unknown> });
      } catch {
        /* schema-check reports malformed lines */
      }
    }
  return out;
}

/** Refuses (UsageError) a pass whose metric union declares an id differently from the rows already in the flow:
 *  one column would hold two quantities. A row stamped without that id, or with no `metric_sigs` at all, predates
 *  the metric and is no conflict. */
export function refuseChangedMetrics(snap: FlowSnapshot, union: readonly ScenarioMetric[]): void {
  const rows = rowSigs(snap);
  for (const m of union) {
    const want = metricSig(m);
    const variants = new Set<string>();
    for (const r of rows)
      for (const [id, sig] of Object.entries(r.sigs))
        if (id.toLowerCase() === m.id.toLowerCase() && (id !== m.id || sig !== want)) variants.add(r.variant);
    if (variants.size)
      throw new UsageError(
        `metric "${m.id}" is declared differently from the rows already in ${[...variants].join(", ")}: the declaration changed since those rows were written, so one column would hold two quantities — start a new flow or give the changed metric a new id`,
      );
  }
}

/** The metric ids the flow's rows carry that no scenario declares any longer, each with the variants holding them.
 *  Removing a metric is allowed: the old rows keep their values, new rows do not carry it. */
export function removedMetrics(snap: FlowSnapshot, union: readonly ScenarioMetric[]): Map<string, string[]> {
  const current = new Set(union.map((m) => m.id.toLowerCase()));
  const out = new Map<string, string[]>();
  for (const r of rowSigs(snap))
    for (const id of Object.keys(r.sigs)) {
      if (current.has(id.toLowerCase())) continue;
      const vs = out.get(id) ?? [];
      if (!vs.includes(r.variant)) vs.push(r.variant);
      out.set(id, vs);
    }
  return out;
}

/** The metric ids the flow's rows carry that `_state.json`'s `metrics` does not declare, each with the variants
 *  holding them. Empty when `metrics` is not a list (kinds are then inferred, so nothing is stale). */
export function undeclaredRowMetrics(snap: FlowSnapshot, stateMetrics: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!Array.isArray(stateMetrics)) return out;
  const declared = new Set(stateMetrics.map((m) => (typeof m === "string" ? m : (m as { id?: unknown })?.id)));
  for (const r of rowSigs(snap))
    for (const id of Object.keys(r.sigs)) {
      if (declared.has(id)) continue;
      const vs = out.get(id) ?? [];
      if (!vs.includes(r.variant)) vs.push(r.variant);
      out.set(id, vs);
    }
  return out;
}
