// `hillclimb state-template` prints a `_state.json` skeleton and a `metrics.md` for the LOOP to save — the
// runner never writes _state.json beyond harness_sha (runner-scaffold.mjs l.12-13). It declares the metrics every row carries,
// the perf columns and the harness paths the gate digests, and never prints a loop-owned key.
import { describe, it, expect } from "vitest";
import { stateTemplate } from "../src/hillclimb/state-template.js";
import { flowMetricDecls } from "../src/hillclimb/grade-keys.js";
import { parseScenarioFile } from "../src/run/execute.js";
import type { Assertion, ScenarioMetric } from "../src/types.js";

const real = parseScenarioFile("test/evals/scenarios/eval-14-subagent-dispatch-and-declared-unused.yaml");
const other = [{ file_exists: "outputs/other.md" }] as unknown as Assertion[];

describe("stateTemplate", () => {
  const t = stateTemplate({ cases: [{ assertions: real.assert }, { assertions: other }], harnessPaths: ["evals/a.yaml"], decider: false });

  it("declares exactly the flow's metrics, in the producer's order, pass first", () => {
    expect(t.state.metrics).toEqual(flowMetricDecls([{ assertions: real.assert }, { assertions: other }]));
    expect(t.state.metrics[0]).toEqual({ id: "pass", kind: "binary", label: "Pass" });
  });

  it("perf_fields name the row's perf keys; decider_usd only when a decider is configured", () => {
    expect(t.state.perf_fields.map((p) => p.id)).toEqual([
      "cost_usd",
      "latency_s",
      "tool_calls",
      "web_searches",
      "in_tokens",
      "out_tokens",
      "skill_invoked",
    ]);
    expect(t.state.perf_fields[0]).toEqual({ id: "cost_usd", label: "Cost", unit: "$" });
    const d = stateTemplate({ cases: [{ assertions: other }], harnessPaths: [], decider: true });
    expect(d.state.perf_fields.at(-1)).toEqual({ id: "decider_usd", label: "Decider $", unit: "$" });
  });

  it("carries the harness paths and nothing loop-owned", () => {
    expect(t.state.harness_paths).toEqual(["evals/a.yaml"]);
    for (const k of ["goal", "best", "harness_sha", "train_ids", "test_ids", "val_ids", "approve_each_round", "current_round"])
      expect(t.state).not.toHaveProperty(k);
  });

  it("labels fit the legend (<= 14 chars)", () => {
    for (const m of t.state.metrics) expect(m.label.length).toBeLessThanOrEqual(14);
    for (const p of t.state.perf_fields) expect(p.label.length).toBeLessThanOrEqual(14);
  });

  it("metrics.md defines claims, says why per-index keys are undeclared here, and lists the floats", () => {
    expect(t.metricsMd).toMatch(/^# Metrics/);
    expect(t.metricsMd).toMatch(/`claims`.*passed.*graded/s);
    expect(t.metricsMd).toMatch(/`pass_present`.*refused/s);
    expect(t.metricsMd).toMatch(/per-assertion keys .* not declared/i);
    const withFloat = stateTemplate({
      cases: [
        {
          assertions: other,
          metrics: [{ id: "words", artifact: "outputs/stats.json", path: "totals.words", better: "lower", unbounded: true }],
        },
      ],
      harnessPaths: [],
      decider: false,
    });
    expect(withFloat.metricsMd).toMatch(/`words`.*lower is better.*no upper bound/s);
    expect(withFloat.metricsMd).toMatch(/measured rows only/);
  });

  it("a metric id that merely starts like a per-assertion key (a11y_score) is a float, not a legend entry", () => {
    const t2 = stateTemplate({
      cases: [
        { assertions: real.assert, metrics: [{ id: "a11y_score", artifact: "outputs/a.json", path: "score", better: "higher", scale: 1 }] },
        { assertions: real.assert, metrics: [{ id: "a11y_score", artifact: "outputs/a.json", path: "score", better: "higher", scale: 1 }] },
      ],
      harnessPaths: [],
      decider: false,
    });
    expect(t2.state.metrics.find((m) => m.id === "a11y_score")).toMatchObject({ kind: "float", better: "higher" });
    expect(t2.metricsMd).toMatch(/`a11y_score` — a scenario-declared number/);
    expect(t2.metricsMd).not.toMatch(/`a11y_score` — (claim|assertion|1 when)/);
  });

  it("identical assertion lists: metrics.md carries the per-assertion legend", () => {
    const same = stateTemplate({ cases: [{ assertions: real.assert }, { assertions: real.assert }], harnessPaths: [], decider: false });
    expect(same.metricsMd).toMatch(/`a0_c0`.*claim 0 of assertion 0/s);
  });
});

describe("labels (the full viewer's legend truncates at 14 chars)", () => {
  const m = (id: string): ScenarioMetric => ({ id, artifact: "outputs/stats.json", path: id, better: "lower", unbounded: true });
  const labels = (ms: ScenarioMetric[]) => {
    const t = stateTemplate({ cases: [{ assertions: other, metrics: ms }], harnessPaths: [], decider: false });
    return Object.fromEntries(t.state.metrics.map((d) => [d.id, d.label]));
  };

  it("response_length and response_length_present get distinct labels of at most 14 chars; the number keeps the plain one", () => {
    const l = labels([m("response_length")]);
    expect(l.response_length).toBe("response_lengt");
    expect(l.response_length_present).not.toBe(l.response_length);
    const all = Object.values(l);
    expect(new Set(all).size).toBe(all.length);
    for (const x of all) expect(x.length).toBeLessThanOrEqual(14);
  });

  it("two long ids that truncate alike are told apart too, and a short id's label is unchanged", () => {
    const l = labels([m("response_length_a"), m("response_length_b"), m("words")]);
    const all = Object.values(l);
    expect(new Set(all).size).toBe(all.length);
    for (const x of all) expect(x.length).toBeLessThanOrEqual(14);
    expect(l.words).toBe("words");
    expect(l.words_present).toBe("words measured");
    expect(l.pass).toBe("Pass");
  });
});
