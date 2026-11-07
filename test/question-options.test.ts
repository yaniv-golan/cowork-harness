import { describe, it, expect } from "vitest";
import { evaluate, type AssertContext } from "../src/assert.js";
import { QUESTION_GATE_KEYS } from "../src/run/cassette.js";
import { assertContradiction } from "../src/run/execute.js";
import { ScenarioObject, type Assertion, type Scenario } from "../src/types.js";

// The defect this key exists for, in one sentence: a consumer's skill enforced an option tuple ON THE
// FILE, the agent presented that list REVERSED — demoting "Stop review" from first to last, putting a
// different choice in the default slot — and every artifact assertion passed, because the artifact was
// right. The only wrong thing was what a person saw.

const gate = (question: string, labels: string[]) => ({ question, options: labels.map((label) => ({ label })) });

function ctx(over: Partial<AssertContext> = {}): AssertContext {
  return {
    transcript: "",
    toolsCalled: new Set<string>(),
    subagentTools: new Set<string>(),
    filesRead: [],
    initTools: [],
    workRoot: "/nonexistent",
    userVisiblePrefixes: ["outputs"],
    readonlyFolderRoots: [],
    outputsDeletes: [],
    questions: [],
    gateOptions: [],
    hostPathLeaked: false,
    selfHealRan: false,
    subagents: [],
    gateDeliveries: [],
    toolResultTexts: [],
    result: "success",
    ...over,
  } as unknown as AssertContext;
}

const run = (a: Assertion, c: AssertContext) => evaluate([a], c)[0];

describe("question_options — the option set and order a gate offered", () => {
  const shown = [gate("Rubric doesn't fit", ["Stop review", "Proceed anyway", "Pick another rubric"])];

  it("passes when the offered set matches in order", () => {
    const r = run(
      { question_options: { when_question: "rubric", equals: ["Stop review", "Proceed anyway", "Pick another rubric"] } },
      ctx({ gateOptions: shown }),
    );
    expect(r.pass).toBe(true);
  });

  // THE regression. Same three labels, reversed. A set comparison passes; this must not.
  it("FAILS on the same set in reversed order — the founder-facing defect", () => {
    const reversed = [gate("Rubric doesn't fit", ["Pick another rubric", "Proceed anyway", "Stop review"])];
    const r = run(
      { question_options: { when_question: "rubric", equals: ["Stop review", "Proceed anyway", "Pick another rubric"] } },
      ctx({ gateOptions: reversed }),
    );
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/expected \[Stop review/);
  });

  it("order: any tolerates the reorder, and still catches a changed set", () => {
    const reversed = [gate("Rubric doesn't fit", ["Pick another rubric", "Proceed anyway", "Stop review"])];
    const want = { when_question: "rubric", equals: ["Stop review", "Proceed anyway", "Pick another rubric"], order: "any" as const };
    expect(run({ question_options: want }, ctx({ gateOptions: reversed })).pass).toBe(true);
    const dropped = [gate("Rubric doesn't fit", ["Proceed anyway", "Stop review"])];
    expect(run({ question_options: want }, ctx({ gateOptions: dropped })).pass).toBe(false);
  });

  it("contains checks a subset, and under the default order a present-but-reordered subset FAILS", () => {
    expect(
      run({ question_options: { when_question: "rubric", contains: ["Stop review", "Proceed anyway"] } }, ctx({ gateOptions: shown })).pass,
    ).toBe(true);
    const swapped = [gate("Rubric doesn't fit", ["Proceed anyway", "Stop review", "Pick another rubric"])];
    const r = run(
      { question_options: { when_question: "rubric", contains: ["Stop review", "Proceed anyway"] } },
      ctx({ gateOptions: swapped }),
    );
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/out of order/);
    expect(
      run(
        { question_options: { when_question: "rubric", contains: ["Stop review", "Proceed anyway"], order: "any" } },
        ctx({ gateOptions: swapped }),
      ).pass,
    ).toBe(true);
  });

  it("a missing label is named in the failure", () => {
    const r = run({ question_options: { when_question: "rubric", contains: ["Stop review", "Escalate"] } }, ctx({ gateOptions: shown }));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/missing Escalate/);
  });
});

describe("question_options fails closed, never vacuously", () => {
  it("no gate matched the selector FAILS (an empty gate list cannot satisfy it)", () => {
    expect(run({ question_options: { when_question: "rubric", equals: ["a"] } }, ctx({ gateOptions: [] })).pass).toBe(false);
    const r = run({ question_options: { when_question: "nope", equals: ["a"] } }, ctx({ gateOptions: [gate("something else", ["a"])] }));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/no question matching/);
  });

  it("omitting when_question with several sub-questions FAILS as ambiguous, rather than taking the first", () => {
    const two = [gate("Which stage?", ["Seed", "Series A"]), gate("Rubric doesn't fit", ["Stop review", "Proceed anyway"])];
    const r = run({ question_options: { equals: ["Seed", "Series A"] } }, ctx({ gateOptions: two }));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/no `when_question` selects one/);
  });

  // `questionLabel` is `question || header`, and `question_asked` selects on that same string. A
  // header-only gate is a real shape (the in-VM handler indexes by header when `question` is empty), so
  // selecting on `q.question` alone would make authors write two regexes for one gate.
  it("selects a header-only gate by its header, the same string question_asked matches", () => {
    const headerOnly = [{ question: "Pick a stage", options: [{ label: "Seed" }, { label: "Series A" }] }];
    expect(
      run({ question_options: { when_question: "Pick a stage", equals: ["Seed", "Series A"] } }, ctx({ gateOptions: headerOnly })).pass,
    ).toBe(true);
  });

  it("omitting when_question is fine when exactly one sub-question fired", () => {
    expect(
      run({ question_options: { equals: ["Seed", "Series A"] } }, ctx({ gateOptions: [gate("Which stage?", ["Seed", "Series A"])] })).pass,
    ).toBe(true);
  });

  // The evidence-unavailable paths. Absent gate evidence must never read as "no gates offered that".
  it("evidence-missing FAILS on both channels", () => {
    const a: Assertion = { question_options: { equals: ["a"] } };
    expect(run(a, ctx({ gateOptions: undefined })).message).toMatch(/evidence unavailable/);
    expect(run(a, ctx({ gateOptions: [], gateOptionsMissing: true })).message).toMatch(/evidence unavailable/);
  });

  it("both or neither of equals/contains is rejected", () => {
    expect(run({ question_options: { equals: ["a"], contains: ["a"] } }, ctx({ gateOptions: [gate("q", ["a"])] })).pass).toBe(false);
    expect(run({ question_options: {} }, ctx({ gateOptions: [gate("q", ["a"])] })).pass).toBe(false);
  });

  it("a bad regex is reported, not silently treated as no-match", () => {
    const r = run({ question_options: { when_question: "([", equals: ["a"] } }, ctx({ gateOptions: [gate("q", ["a"])] }));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/bad regex/);
  });

  // Multiset, not Set: a duplicated option is a different offer.
  it("order: any does not treat a duplicated label as equal to a distinct one", () => {
    const dup = [gate("q", ["Stop", "Stop"])];
    expect(run({ question_options: { equals: ["Stop", "Go"], order: "any" } }, ctx({ gateOptions: dup })).pass).toBe(false);
  });
});

describe("question_options wiring", () => {
  // Sourced from ask-time capture, so it grades against the recorded controlOut exactly like the other gate keys.
  it("is classified as a gate key (graded against controlOut on replay)", () => {
    expect(QUESTION_GATE_KEYS).toContain("question_options");
  });

  // LOAD time, not evaluate time: on run/record a contradictory assert must be refused BEFORE the
  // spawn. The evaluator repeats the check for hand-built contexts, which is why an evaluate()-only
  // test passed while the schema still accepted the document.
  it("rejects equals + contains at LOAD, before any run is spent", () => {
    const doc = (qo: unknown) => ({ prompt: "p", fidelity: "container", assert: [{ question_options: qo }] });
    expect(() => ScenarioObject.parse(doc({ equals: ["a"], contains: ["a"] }))).toThrow(/exactly one of/);
    expect(() => ScenarioObject.parse(doc({ when_question: "x" }))).toThrow(/exactly one of/);
    // The valid forms still parse.
    expect(() => ScenarioObject.parse(doc({ equals: ["a"] }))).not.toThrow();
    expect(() => ScenarioObject.parse(doc({ contains: ["a"], order: "any" }))).not.toThrow();
  });

  it("contradicts questions_count_max: 0 at load time", () => {
    const scenario = { name: "s", assert: [{ questions_count_max: 0 }, { question_options: { equals: ["a"] } }] } as unknown as Scenario;
    expect(assertContradiction(scenario)).toMatch(/question_options/);
  });
});
