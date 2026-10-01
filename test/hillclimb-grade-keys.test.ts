// The grade keys a hillclimb row carries, and the metrics a flow DECLARES.
//
// A flow's cases usually have different assertion lists, so a per-index key (`a0`) can mean a file check in
// one case and a rubric in another. Declared, therefore, are only metrics that mean the same thing on every
// row: `pass`, the `_present` companions, the pooled `claims` score, and the scenario-declared floats
// (their union). Per-index keys stay on every row as drill-down data and are declared only when every case
// has the identical assertion list. One producer for the row writer and `state-template`.
import { describe, it, expect } from "vitest";
import { caseKeyDecls, flowMetricDecls, presentCompanionOf, reservedMetricId } from "../src/hillclimb/grade-keys.js";
import { parseScenarioFile } from "../src/run/execute.js";
import { UsageError } from "../src/errors.js";
import type { Assertion } from "../src/types.js";

const real = parseScenarioFile("test/evals/scenarios/eval-14-subagent-dispatch-and-declared-unused.yaml");
const claimCount = real.assert[0].semantic_matches!.rubric.length;

const mixed = [
  { file_exists: "outputs/report.md" },
  { semantic_matches: { rubric: ["cites a source", "names the risk"] } },
  { tool_called: { name: "Write" } },
] as unknown as Assertion[];
const other = [{ file_exists: "outputs/other.md" }] as unknown as Assertion[];

describe("caseKeyDecls — every key one case's rows carry, in row order", () => {
  it("pass, the companions, claims, then the per-index keys, then the floats", () => {
    expect(caseKeyDecls(mixed, [{ id: "words", better: "lower", unbounded: true }]).map((d) => d.id)).toEqual([
      "pass",
      "pass_present",
      "claims_present",
      "words_present",
      "a1_present",
      "claims",
      "a0",
      "a1_c0",
      "a1_c1",
      "a2",
      "words",
    ]);
  });

  it("claims is a judge-kind score on a 0-1 scale, higher is better", () => {
    expect(caseKeyDecls(mixed).find((d) => d.id === "claims")).toMatchObject({ kind: "judge", scale: 1, better: "higher" });
  });

  it("labels fit the legend (<= 14 chars)", () => {
    for (const d of caseKeyDecls(mixed, [{ id: "a_long_metric_identifier", better: "higher", scale: 1 }]))
      expect(d.label.length).toBeLessThanOrEqual(14);
  });
});

describe("flowMetricDecls — what the flow declares", () => {
  it("cases with identical assertion lists: everything, per-index keys included", () => {
    const ids = flowMetricDecls([{ assertions: real.assert }, { assertions: real.assert }]).map((d) => d.id);
    expect(ids).toEqual([
      "pass",
      "pass_present",
      "claims_present",
      "a0_present",
      "claims",
      ...Array.from({ length: claimCount }, (_, j) => `a0_c${j}`),
    ]);
  });

  it("cases with different lists: only what means the same on every row — no per-index key", () => {
    const ids = flowMetricDecls([{ assertions: mixed }, { assertions: other }]).map((d) => d.id);
    expect(ids).toEqual(["pass", "pass_present", "claims_present", "claims"]);
  });

  it("no semantic assert anywhere: no claims metric", () => {
    expect(flowMetricDecls([{ assertions: other }, { assertions: [] }]).map((d) => d.id)).toEqual(["pass", "pass_present"]);
  });

  it("scenario-declared floats are the UNION over cases, each with its companion", () => {
    const ids = flowMetricDecls([
      { assertions: other, metrics: [{ id: "words", better: "lower", unbounded: true }] },
      { assertions: [], metrics: [{ id: "ratio", better: "higher", scale: 1 }] },
    ]).map((d) => d.id);
    expect(ids).toEqual(["pass", "pass_present", "words_present", "ratio_present", "words", "ratio"]);
  });

  it("one metric id declared two different ways is refused", () => {
    expect(() =>
      flowMetricDecls([
        { assertions: [], metrics: [{ id: "words", better: "lower", unbounded: true }] },
        { assertions: [], metrics: [{ id: "words", better: "higher", unbounded: true }] },
      ]),
    ).toThrow(UsageError);
  });

  it("a float declares better, and scale only when bounded", () => {
    const decls = flowMetricDecls([
      {
        assertions: [],
        metrics: [
          { id: "ratio", better: "higher", scale: 1 },
          { id: "cost", better: "lower", unbounded: true },
        ],
      },
    ]);
    expect(decls.find((d) => d.id === "ratio")).toMatchObject({ kind: "float", better: "higher", scale: 1 });
    expect(decls.find((d) => d.id === "cost")).not.toHaveProperty("scale");
  });
});

describe("reservedMetricId — a scenario metric may not shadow a generated key", () => {
  it("refuses pass, claims, per-index shapes, companions and pairwise keys", () => {
    for (const id of ["pass", "claims", "a0", "a12_c3", "a1_present", "x_present", "win", "a0_win", "both_bad", "a0_both_bad_v2"])
      expect(reservedMetricId(id), id).toBe(true);
    for (const id of ["words", "cost_ratio", "alpha", "presentation"]) expect(reservedMetricId(id), id).toBe(false);
  });
});

describe("presentCompanionOf — the explicit key → companion map the _present exemption uses", () => {
  it("claims, a metric, a claim key", () => {
    expect(presentCompanionOf("pass")).toBe("pass_present");
    expect(presentCompanionOf("claims")).toBe("claims_present");
    expect(presentCompanionOf("words")).toBe("words_present");
    expect(presentCompanionOf("a1_c0")).toBe("a1_present");
  });

  it("always-graded keys have none", () => {
    for (const k of ["a0", "a1_present", "claims_present", "pass_present"]) expect(presentCompanionOf(k)).toBeUndefined();
  });
});
