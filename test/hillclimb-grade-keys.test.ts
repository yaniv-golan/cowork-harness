// The grade keys a hillclimb row carries, declared from the SCENARIO (never from a result: an errored rep's
// result has fewer grades). One producer for the row writer and `state-template`, so the declared metric
// list and the keys on the rows cannot disagree.
import { describe, it, expect } from "vitest";
import { gradeKeyDecls, presentCompanionOf } from "../src/hillclimb/grade-keys.js";
import { parseScenarioFile } from "../src/run/execute.js";
import type { Assertion } from "../src/types.js";

const real = parseScenarioFile("test/evals/scenarios/eval-14-subagent-dispatch-and-declared-unused.yaml");

const mixed = [
  { file_exists: "outputs/report.md" },
  { semantic_matches: { rubric: ["cites a source", "names the risk"] } },
  { tool_called: { name: "Write" } },
] as unknown as Assertion[];

describe("gradeKeyDecls", () => {
  it("a real scenario: pass first, then the semantic assert's companion, then one binary per claim", () => {
    const decls = gradeKeyDecls(real.assert);
    const rubric = real.assert[0].semantic_matches!.rubric;
    expect(decls.map((d) => d.id)).toEqual(["pass", "a0_present", ...rubric.map((_, j) => `a0_c${j}`)]);
    expect(decls.every((d) => d.kind === "binary")).toBe(true);
  });

  it("pass is the first binary (the report's headline); every _present companion precedes the graded keys", () => {
    const ids = gradeKeyDecls(mixed, [{ id: "words", better: "lower", unbounded: true }]).map((d) => d.id);
    expect(ids).toEqual(["pass", "words_present", "a1_present", "a0", "a1_c0", "a1_c1", "a2", "words"]);
  });

  it("labels are at most 14 characters (the full viewer's legend width, M l.73-75)", () => {
    const decls = gradeKeyDecls(mixed, [{ id: "a_long_metric_identifier", better: "higher", scale: 1 }]);
    for (const d of decls) expect(d.label.length).toBeLessThanOrEqual(14);
  });

  it("a float metric declares kind float, better, and scale only when bounded (F1)", () => {
    const decls = gradeKeyDecls(
      [],
      [
        { id: "ratio", better: "higher", scale: 1 },
        { id: "cost", better: "lower", unbounded: true },
      ],
    );
    expect(decls.find((d) => d.id === "ratio")).toMatchObject({ kind: "float", better: "higher", scale: 1 });
    const cost = decls.find((d) => d.id === "cost")!;
    expect(cost).toMatchObject({ kind: "float", better: "lower" });
    expect(cost).not.toHaveProperty("scale");
  });
});

describe("presentCompanionOf — the explicit key → companion map the _present exemption uses", () => {
  it("maps a claim key to its assert's companion and a metric to its own", () => {
    expect(presentCompanionOf("a1_c0")).toBe("a1_present");
    expect(presentCompanionOf("words")).toBe("words_present");
  });

  it("binary keys that are always graded have no companion", () => {
    expect(presentCompanionOf("pass")).toBeUndefined();
    expect(presentCompanionOf("a0")).toBeUndefined();
    expect(presentCompanionOf("a1_present")).toBeUndefined();
  });
});
