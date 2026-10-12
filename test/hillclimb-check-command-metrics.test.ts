// hillclimb check over a flow with numeric metrics: a column holding two signatures is an error, a scorer failure on
// a row the agent did not fail is a warning naming the rows, and a float measured on different shares of each
// variant's rows is called incomparable.
import { describe, it, expect } from "vitest";
import { metricSigFindings, scorerRobustnessWarnings, incomparableMetricWarnings } from "../src/hillclimb/check.js";

const row = (o: { id: string; rep: number; grade?: Record<string, number>; meta?: Record<string, unknown> }) =>
  JSON.stringify({ prompt_id: o.id, rep: o.rep, grade: o.grade ?? {}, meta: o.meta ?? {} });
const snap = (variants: Record<string, string[]>, metrics: object[] = [{ id: "leaks", kind: "float", better: "lower" }]) =>
  ({
    state: JSON.stringify({ metrics }),
    variants: Object.fromEntries(Object.entries(variants).map(([v, rows]) => [v, { results: rows.join("\n") }])),
  }) as never;

describe("metricSigFindings", () => {
  it("one signature per column is clean; two is an error", () => {
    expect(metricSigFindings(snap({ baseline: [row({ id: "c", rep: 1, meta: { metric_sigs: { leaks: "a" } } })] }))).toEqual([]);
    const f = metricSigFindings(
      snap({
        baseline: [row({ id: "c", rep: 1, meta: { metric_sigs: { leaks: "a" } } })],
        v1: [row({ id: "c", rep: 1, meta: { metric_sigs: { leaks: "b" } } })],
      }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ level: "error", rule: "metrics.sig_mixed" });
  });
});

describe("scorerRobustnessWarnings", () => {
  it("names a command scorer failure on a row the agent did not fail, and ignores an agent-failed row", () => {
    const w = scorerRobustnessWarnings(
      snap({
        v1: [
          row({ id: "c", rep: 1, meta: { metrics_unavailable: { leaks: "command_timeout" } } }),
          row({ id: "c", rep: 2, meta: { failure_class: "errored_agent", metrics_unavailable: { leaks: "command_failed" } } }),
          row({ id: "c", rep: 3, meta: { metrics_unavailable: { leaks: "missing_artifact" } } }),
        ],
      }),
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/metric leaks's scorer failed on 1 row\(s\) the agent did not fail: v1\/c rep 1 \(command_timeout\)/);
  });
});

describe("incomparableMetricWarnings", () => {
  const m = (present: number, value?: number) => ({ leaks_present: present, ...(value !== undefined ? { leaks: value } : {}) });
  it("equal presence: no warning", () => {
    expect(
      incomparableMetricWarnings(
        snap({ baseline: [row({ id: "c", rep: 1, grade: m(1, 3) })], v1: [row({ id: "c", rep: 1, grade: m(1, 2) })] }),
      ),
    ).toEqual([]);
  });
  it("5/5 vs 3/5 measured: incomparable, naming each variant's share", () => {
    const five = (n: number) => Array.from({ length: 5 }, (_, i) => row({ id: "c", rep: i + 1, grade: i < n ? m(1, 1) : m(0) }));
    const w = incomparableMetricWarnings(snap({ baseline: five(5), v1: five(3) }));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/metric leaks is incomparable across variants \(baseline 5\/5 vs v1 3\/5 measured\)/);
  });
});
