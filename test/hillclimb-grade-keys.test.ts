// The grade keys a hillclimb row carries, and the metrics a flow DECLARES.
//
// A flow's cases usually have different assertion lists, so a per-index key (`a0`) can mean a file check in
// one case and a rubric in another. Declared, therefore, are only metrics that mean the same thing on every
// row: `pass`, the `_present` companions, the pooled `claims` score, and the scenario-declared floats
// (their union). Per-index keys stay on every row as drill-down data and are declared only when every case
// has the identical assertion list. One producer for the row writer and `state-template`.
import { describe, it, expect } from "vitest";
import {
  assertIdentity,
  assertSig,
  caseKeyDecls,
  flowMetricDecls,
  metricSig,
  metricUnion,
  presentCompanionOf,
  reservedMetricId,
} from "../src/hillclimb/grade-keys.js";
import { parseScenarioFile } from "../src/run/execute.js";
import { UsageError } from "../src/errors.js";
import type { Assertion, ScenarioMetric } from "../src/types.js";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const real = parseScenarioFile("test/evals/scenarios/eval-14-subagent-dispatch-and-declared-unused.yaml");
const claimCount = real.assert[0].semantic_matches!.rubric.length;

const mixed = [
  { file_exists: "outputs/report.md" },
  { semantic_matches: { rubric: ["cites a source", "names the risk"] } },
  { tool_called: { name: "Write" } },
] as unknown as Assertion[];
const other = [{ file_exists: "outputs/other.md" }] as unknown as Assertion[];
/** A scenario metric declaration, whole: the union compares every field. */
const metric = (id: string, over: Partial<ScenarioMetric> = {}): ScenarioMetric =>
  ({ id, artifact: "outputs/scores.json", path: id, better: "higher", scale: 1, ...over }) as ScenarioMetric;
const unboundedLower = (id: string, over: Partial<ScenarioMetric> = {}) =>
  metric(id, { better: "lower", scale: undefined, unbounded: true, ...over });

describe("caseKeyDecls — every key one case's rows carry, in row order", () => {
  it("pass, the companions, claims, then the per-index keys, then the floats", () => {
    expect(caseKeyDecls(mixed, [unboundedLower("words")]).map((d) => d.id)).toEqual([
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
    for (const d of caseKeyDecls(mixed, [metric("a_long_metric_identifier")])) expect(d.label.length).toBeLessThanOrEqual(14);
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
      { assertions: other, metrics: [unboundedLower("words")] },
      { assertions: [], metrics: [metric("ratio")] },
    ]).map((d) => d.id);
    expect(ids).toEqual(["pass", "pass_present", "words_present", "ratio_present", "words", "ratio"]);
  });

  it("one metric id declared two different ways is refused", () => {
    expect(() =>
      flowMetricDecls([
        { assertions: [], metrics: [unboundedLower("words")] },
        { assertions: [], metrics: [unboundedLower("words", { better: "higher" })] },
      ]),
    ).toThrow(UsageError);
  });

  it("any differing field is a conflict — the file, the path or the floor, not just the direction and bound", () => {
    for (const over of [{ artifact: "outputs/other.json" }, { path: "totals.words" }, { min: 10 }] as Partial<ScenarioMetric>[])
      expect(
        () =>
          flowMetricDecls([
            { assertions: [], metrics: [unboundedLower("words")] },
            { assertions: [], metrics: [unboundedLower("words", over)] },
          ]),
        JSON.stringify(over),
      ).toThrow(/metric "words" is declared differently/);
  });

  it("one id spelled in two cases (Words, words) is refused, naming both cases: the scenario compares ids case-insensitively", () => {
    expect(() =>
      flowMetricDecls([
        { name: "alpha", assertions: [], metrics: [unboundedLower("Words")] },
        { name: "beta", assertions: [], metrics: [unboundedLower("words")] },
      ]),
    ).toThrow(/metric "Words" \(alpha\) and metric "words" \(beta\) differ only in case/);
  });

  it("a conflicting declaration names both cases", () => {
    expect(() =>
      flowMetricDecls([
        { name: "alpha", assertions: [], metrics: [unboundedLower("words")] },
        { name: "beta", assertions: [], metrics: [unboundedLower("words", { better: "higher" })] },
      ]),
    ).toThrow(/metric "words" is declared differently in alpha and beta/);
  });

  it("a case with `metrics: []` is a case that declares none: it adds no column", () => {
    const ids = flowMetricDecls([
      { assertions: [], metrics: [] },
      { assertions: [], metrics: [unboundedLower("words")] },
    ]).map((d) => d.id);
    expect(ids).toEqual(["pass", "pass_present", "words_present", "words"]);
  });

  it("the same declaration in two cases is one column", () => {
    const ids = flowMetricDecls([
      { assertions: [], metrics: [unboundedLower("words", { min: 1 })] },
      { assertions: [], metrics: [unboundedLower("words", { min: 1 })] },
    ]).map((d) => d.id);
    expect(ids).toEqual(["pass", "pass_present", "words_present", "words"]);
  });

  it("a float declares better, and scale only when bounded", () => {
    const decls = flowMetricDecls([
      {
        assertions: [],
        metrics: [metric("ratio"), unboundedLower("cost")],
      },
    ]);
    expect(decls.find((d) => d.id === "ratio")).toMatchObject({ kind: "float", better: "higher", scale: 1 });
    expect(decls.find((d) => d.id === "cost")).not.toHaveProperty("scale");
  });
});

describe("metricSig — a short, stable signature of one metric's declaration, stamped on every row", () => {
  it("16 hex chars over the fields the union compares; any field change changes it, the id's letter case does not", () => {
    const base = metric("score");
    expect(metricSig(base)).toMatch(/^[0-9a-f]{16}$/);
    expect(metricSig({ ...base })).toBe(metricSig(base));
    expect(metricSig(metric("Score", { path: "score" }))).toBe(metricSig(base));
    for (const over of [
      { artifact: "outputs/other.json" },
      { path: "totals.score" },
      { better: "lower" },
      { scale: 2 },
      { scale: undefined, unbounded: true },
      { min: 0.5 },
    ] as Partial<ScenarioMetric>[])
      expect(metricSig(metric("score", over)), JSON.stringify(over)).not.toBe(metricSig(base));
    expect(metricSig(metric("other"))).not.toBe(metricSig(base));
  });

  it("an absent optional field is normalized the same way every time (key order and an explicit undefined do not matter)", () => {
    const a = { id: "w", artifact: "o.json", path: "w", better: "lower", unbounded: true } as ScenarioMetric;
    const b = {
      unbounded: true,
      better: "lower",
      path: "w",
      artifact: "o.json",
      id: "w",
      min: undefined,
      scale: undefined,
    } as ScenarioMetric;
    expect(metricSig(b)).toBe(metricSig(a));
  });

  it("`min` omitted and `min: 0` (its default) are one declaration: the same sig, and no conflict across cases", () => {
    expect(metricSig(metric("score", { min: 0 }))).toBe(metricSig(metric("score")));
    const u = metricUnion([
      { name: "a", metrics: [metric("score")] },
      { name: "b", metrics: [metric("score", { min: 0 })] },
    ]);
    expect(u.map((m) => m.id)).toEqual(["score"]);
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
    for (const k of ["a1_present", "claims_present", "pass_present"]) expect(presentCompanionOf(k)).toBeUndefined();
  });

  it("a whole-assertion key's companion is a<i>_present (only a refused single-key semantic_pairwise is ever omitted)", () => {
    expect(presentCompanionOf("a0")).toBe("a0_present");
  });
});

// `parseScenarioFile` rewrites `semantic_pairwise.refs` to host-absolute paths; hillclimb ignores refs (its references
// are the flow's), so neither the sig nor an assert's identity may depend on where the checkout lives.
describe("assertSig and assertIdentity: the same scenario in two checkouts", () => {
  const YAML = [
    "name: s",
    "baseline: latest",
    "fidelity: protocol",
    "prompt: hi",
    "assert:",
    "  - result: success",
    "  - semantic_pairwise:",
    "      rubric: ['answers']",
    "      refs: [./refs]",
    "",
  ].join("\n");
  const checkout = () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), "hc-sig-")));
    mkdirSync(join(d, "refs"));
    writeFileSync(join(d, "s.yaml"), YAML);
    return d;
  };
  it("is stable across two checkouts though the parsed refs differ", () => {
    const [a, b] = [checkout(), checkout()];
    try {
      const sa = parseScenarioFile(join(a, "s.yaml"));
      const sb = parseScenarioFile(join(b, "s.yaml"));
      // Precondition: the parse made the refs machine-specific.
      expect(sa.assert[1]!.semantic_pairwise!.refs).not.toEqual(sb.assert[1]!.semantic_pairwise!.refs);
      expect(assertSig(sa)).toBe(assertSig(sb));
      expect(assertIdentity(sa.assert[1])).toBe(assertIdentity(sb.assert[1]));
      // The rubric still counts.
      const edited = { ...sb.assert[1]!, semantic_pairwise: { ...sb.assert[1]!.semantic_pairwise!, rubric: ["other"] } };
      expect(assertIdentity(edited)).not.toBe(assertIdentity(sa.assert[1]));
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });
  it("a scenario with no refs keeps the sig it had (an upgrade does not call every row stale)", () => {
    // The sha256 prefix of the canonical {assert, expect_denied} for this list, as the sig was computed before refs were dropped.
    expect(assertSig({ assert: [{ result: "success" }, { transcript_contains: "x" }] as never })).toBe("033cab7ce16421ff");
  });
});
