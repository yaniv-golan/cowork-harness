// How one rep's metric state enters a metric row: worst rank (W), excluded and guarded (X), or not compared (N),
// keyed on the rep's bucket and the metric's unavailable reason.
import { describe, it, expect } from "vitest";
import { METRIC_UNAVAILABLE, type ScenarioMetric } from "../src/types.js";
import { METRIC_STATE_CLASS, repMetricValues, type RepClassification } from "../src/eval/classify.js";
import { buildRunsLine, repEvidenceOf } from "../src/eval/runs.js";

const decl: ScenarioMetric = { id: "leaks", artifact: "outputs/m.json", path: "n", better: "lower", unbounded: true };
const rep = (bucket: RepClassification["bucket"]): RepClassification =>
  ({
    bucket,
    termination: { bucket: "valid", rule: "success", unclassified: false, ambiguousExit: false },
    judgeInvalidAssertions: [],
  }) as RepClassification;
const result = (metrics?: Array<{ id: string; value?: number; unavailable?: (typeof METRIC_UNAVAILABLE)[number] }>) =>
  ({ result: "success", ...(metrics ? { metrics } : {}) }) as Parameters<typeof repMetricValues>[2];

describe("METRIC_STATE_CLASS", () => {
  it("classifies every METRIC_UNAVAILABLE reason (the Record is the completeness check)", () => {
    expect(Object.keys(METRIC_STATE_CLASS).sort()).toEqual([...METRIC_UNAVAILABLE].sort());
  });
  it("W: the skill did not produce the number; X: the scorer, capture or a cap; N: a harness defect", () => {
    expect(METRIC_STATE_CLASS).toEqual({
      missing_artifact: "W",
      missing_path: "W",
      not_json: "W",
      not_a_number: "W",
      pre_run: "W",
      size: "X",
      readonly: "X",
      remote: "X",
      pruned: "N",
      no_manifest: "N",
    });
  });
});

describe("repMetricValues", () => {
  it("a valid rep's measured value is ranked by value", () => {
    expect(repMetricValues([decl], rep("valid"), result([{ id: "leaks", value: 3 }]))).toEqual([{ id: "leaks", v: { value: 3 } }]);
  });
  it("judge_invalid keeps the metric (the judge has nothing to do with the artifact)", () => {
    expect(repMetricValues([decl], rep("judge_invalid"), result([{ id: "leaks", value: 3 }]))[0].v).toEqual({ value: 3 });
  });
  it("errored_agent is worst-ranked whatever the result holds — never an imputed 0, never excluded", () => {
    expect(repMetricValues([decl], rep("errored_agent"), result([{ id: "leaks", value: 0 }]))[0].v).toEqual({ worst: "errored_agent" });
  });
  it.each(["errored_infra", "arm_source_drift", "model_mismatch", "judge_prompt_mismatch"] as const)(
    "%s drops the rep, as on pass rows",
    (b) => {
      expect(repMetricValues([decl], rep(b), result([{ id: "leaks", value: 3 }]))[0].v).toEqual({ dropped: b });
    },
  );
  it.each([
    ["missing_artifact", { worst: "missing_artifact" }],
    ["pre_run", { worst: "pre_run" }],
    ["size", { excluded: "size" }],
    ["remote", { excluded: "remote" }],
    ["pruned", { notCompared: "pruned" }],
    ["no_manifest", { notCompared: "no_manifest" }],
  ] as const)("a valid rep with %s maps to its class", (reason, v) => {
    expect(repMetricValues([decl], rep("valid"), result([{ id: "leaks", unavailable: reason }]))[0].v).toEqual(v);
  });
  it("a valid rep with no entry for the declared id is excluded as metric_unrecorded (guarded, never worst-ranked)", () => {
    expect(repMetricValues([decl], rep("valid"), result())[0].v).toEqual({ excluded: "metric_unrecorded" });
    expect(repMetricValues([decl], rep("valid"), result([{ id: "other", value: 1 }]))[0].v).toEqual({ excluded: "metric_unrecorded" });
  });
});

describe("runs.jsonl keeps each rep's metrics", () => {
  it("buildRunsLine copies metrics verbatim and repEvidenceOf hands them to the classifier", () => {
    const line = buildRunsLine({
      index: 0,
      arm: "a",
      scenario: "s",
      rep: 1,
      runId: "local_x",
      runDir: undefined,
      result: {
        scenario: "s",
        result: "success",
        assertions: [],
        metrics: [
          { id: "leaks", value: 2 },
          { id: "w", unavailable: "size" },
        ],
      } as never,
      thrown: undefined,
      evidence: undefined,
    });
    expect(line.result?.metrics).toEqual([
      { id: "leaks", value: 2 },
      { id: "w", unavailable: "size" },
    ]);
    expect(repEvidenceOf(line).result?.metrics).toEqual(line.result?.metrics);
  });
});
