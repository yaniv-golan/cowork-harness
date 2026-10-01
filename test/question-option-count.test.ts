import { describe, it, expect } from "vitest";
import { evaluate, type AssertContext } from "../src/assert.js";
import { MODEL_AUTHORED_TEXT_KEYS, QUESTION_GATE_KEYS, requiredVersionFor } from "../src/run/cassette.js";
import { assertContradiction } from "../src/run/execute.js";
import { ScenarioObject, type Assertion } from "../src/types.js";

// `question_option_count` counts the options whose label matches a regex, per sub-question, and requires the bound on
// EVERY selected one: "exactly one option per gate carries the reserved no-change prefix" over gates the model
// composes and the author cannot list in advance. The producer paths (events.jsonl → verify-run) are pinned in
// test/question-options-lanes.test.ts; this file pins bounds, messages and the fail-closed paths.

const PREFIX = "No changes — ";
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
const run = (qoc: unknown, c: AssertContext) => evaluate([{ question_option_count: qoc } as Assertion], c)[0]!;
const msg = (r: { pass: boolean; message?: string; evidence?: string }) => r.message ?? r.evidence ?? "";

const GATES = [
  gate("Keep the TAM figure?", [`${PREFIX}keep it`, "Replace with bottom-up"]),
  gate("Keep the competitor list?", ["Add Acme", `${PREFIX}keep the list`]),
  gate("Ship the report?", [`${PREFIX}ship as is`, "Re-score moat"]),
];

describe("question_option_count: bounds over every sub-question", () => {
  it("exactly: 1 passes when every sub-question has one match", () => {
    const r = run({ matches: `^${PREFIX}`, exactly: 1 }, ctx({ gateOptions: GATES }));
    expect(r.pass).toBe(true);
    expect(msg(r)).toMatch(/all 3 sub-question\(s\)/);
  });

  it("fails naming ONLY the offending sub-question, with its count and labels", () => {
    const two = [...GATES.slice(0, 2), gate("Ship the report?", [`${PREFIX}ship`, `${PREFIX}re-score`])];
    const r = run({ matches: `^${PREFIX}`, exactly: 1 }, ctx({ gateOptions: two }));
    expect(r.pass).toBe(false);
    expect(msg(r)).toMatch(/1 of 3 did not: "Ship the report\?" has 2 of \[/);
    expect(msg(r)).not.toMatch(/TAM/);
  });

  it("exactly: 0 passes when nothing matches and fails on one match", () => {
    const verb = `^${PREFIX}.*\\b(add|remove|re-score)\\b`;
    expect(run({ matches: verb, exactly: 0 }, ctx({ gateOptions: GATES })).pass).toBe(true);
    const bad = [gate("Keep the list?", [`${PREFIX}add Acme`, "Remove Beta"])];
    expect(run({ matches: verb, exactly: 0 }, ctx({ gateOptions: bad })).pass).toBe(false);
  });

  it("min / max, alone and together", () => {
    const g = [gate("Pick", ["keep a", "keep b", "drop c"])];
    expect(run({ matches: "^keep", min: 2 }, ctx({ gateOptions: g })).pass).toBe(true);
    expect(run({ matches: "^keep", min: 3 }, ctx({ gateOptions: g })).pass).toBe(false);
    expect(run({ matches: "^keep", max: 1 }, ctx({ gateOptions: g })).pass).toBe(false);
    expect(run({ matches: "^keep", min: 1, max: 2 }, ctx({ gateOptions: g })).pass).toBe(true);
  });

  it("a sub-question with no options counts 0; a duplicated label counts twice", () => {
    expect(run({ matches: "x", exactly: 1 }, ctx({ gateOptions: [gate("Free text?", [])] })).pass).toBe(false);
    expect(run({ matches: "^keep", exactly: 2 }, ctx({ gateOptions: [gate("Pick", ["keep", "keep"])] })).pass).toBe(true);
  });

  it("when_question narrows; an unselected sub-question cannot fail the rule", () => {
    const g = [...GATES, gate("Which file?", ["a.xlsx", "b.xlsx"])];
    expect(run({ matches: `^${PREFIX}`, exactly: 1 }, ctx({ gateOptions: g })).pass).toBe(false);
    expect(run({ when_question: "^(Keep|Ship)", matches: `^${PREFIX}`, exactly: 1 }, ctx({ gateOptions: g })).pass).toBe(true);
  });

  it("a verb rule stays case-insensitive by default, so a capitalised verb is still caught", () => {
    const g = [gate("Keep the list?", [`${PREFIX}Add Acme`, "Remove Beta"])];
    const verb = `^${PREFIX}.*\\b(add|remove)\\b`;
    expect(run({ matches: verb, exactly: 0 }, ctx({ gateOptions: g })).pass).toBe(false);
    // case_sensitive applies to the whole pattern: here it would miss `Add` — the documented false pass.
    expect(run({ matches: verb, exactly: 0, case_sensitive: true }, ctx({ gateOptions: g })).pass).toBe(true);
  });

  it("is case-insensitive by default and case-sensitive on request", () => {
    const g = [gate("Pick", ["no changes — keep", "Change it"])];
    expect(run({ matches: `^${PREFIX}`, exactly: 1 }, ctx({ gateOptions: g })).pass).toBe(true);
    expect(run({ matches: `^${PREFIX}`, exactly: 1, case_sensitive: true }, ctx({ gateOptions: g })).pass).toBe(false);
  });

  it("matches the option LABEL only, never its description", () => {
    const g = [{ question: "Pick", options: [{ label: "Keep", description: `${PREFIX}nothing moves` }] }];
    expect(run({ matches: `^${PREFIX}`, exactly: 1 }, ctx({ gateOptions: g })).pass).toBe(false);
  });
});

describe("question_option_count: never vacuous", () => {
  it("zero sub-questions asked FAILS, even for exactly: 0", () => {
    const r = run({ matches: "x", exactly: 0 }, ctx({ gateOptions: [] }));
    expect(r.pass).toBe(false);
    expect(msg(r)).toMatch(/no question was asked \(0 gate\(s\) recorded\)/);
  });

  it("a when_question selecting nothing FAILS", () => {
    const r = run({ when_question: "nothing like this", matches: "x", exactly: 0 }, ctx({ gateOptions: GATES }));
    expect(r.pass).toBe(false);
    expect(msg(r)).toMatch(/no question matching \/nothing like this\/i was asked \(3 gate\(s\) recorded\)/);
  });

  it("absent gate evidence fails evidence-unavailable", () => {
    expect(msg(run({ matches: "x", exactly: 0 }, ctx({ gateOptions: undefined })))).toMatch(/^evidence unavailable/);
    expect(msg(run({ matches: "x", exactly: 0 }, ctx({ gateOptions: GATES, gateOptionsMissing: true })))).toMatch(/^evidence unavailable/);
  });

  it("a bad regex fails naming it", () => {
    expect(msg(run({ matches: "(", exactly: 1 }, ctx({ gateOptions: GATES })))).toMatch(/bad regex "\("/);
    expect(msg(run({ matches: "(", exactly: 1, case_sensitive: true }, ctx({ gateOptions: GATES })))).toMatch(/bad regex "\("/);
    expect(msg(run({ matches: "x", when_question: "(", exactly: 1 }, ctx({ gateOptions: GATES })))).toMatch(/bad regex "\("/);
  });

  it("reports a bad bound before missing evidence, so the message does not depend on the lane", () => {
    expect(msg(run({ matches: "x" }, ctx({ gateOptions: undefined })))).toMatch(/checks nothing/);
  });

  it("repeats the bound check for a hand-built context that skipped parse", () => {
    expect(msg(run({ matches: "x" }, ctx({ gateOptions: GATES })))).toMatch(/checks nothing/);
    expect(msg(run({ matches: "x", exactly: 1, min: 1 }, ctx({ gateOptions: GATES })))).toMatch(/not both/);
    expect(msg(run({ matches: "x", min: 2, max: 1 }, ctx({ gateOptions: GATES })))).toMatch(/greater than/);
  });
});

// A replayed cassette or a scrubbed run dir can carry option labels a redaction policy rewrote. A label carrying a
// token counts as unknown either way, and each count is the range [n, n + unknown], so `exactly: 0` cannot pass on a
// label whose original bytes matched.
describe("question_option_count: redaction-rewritten labels", () => {
  const TOKEN = "[REDACTED:path:0123456789ab]";
  it("exactly: 0 is evidence-unavailable when a rewritten label might have matched", () => {
    const g = [gate("Pick", [`Write to ${TOKEN}`, "Skip"])];
    const r = run({ matches: "/Users/", exactly: 0 }, ctx({ gateOptions: g }));
    expect(r.pass).toBe(false);
    expect(msg(r)).toMatch(/^evidence unavailable: .*redaction/);
    expect(msg(r)).not.toContain(TOKEN);
  });

  it("a count the unknown labels cannot change still decides", () => {
    const g = [gate("Pick", [`${PREFIX}keep`, `${PREFIX}also`, `Write to ${TOKEN}`])];
    // Two definite matches already exceed exactly: 1, whatever the rewritten label was.
    expect(msg(run({ matches: `^${PREFIX}`, exactly: 1 }, ctx({ gateOptions: g })))).toMatch(/did not/);
    // min: 2 holds whatever it was.
    expect(run({ matches: `^${PREFIX}`, min: 2 }, ctx({ gateOptions: g })).pass).toBe(true);
  });

  it("a regex never hits a token's own text", () => {
    const g = [gate("Pick", [TOKEN])];
    expect(msg(run({ matches: "REDACTED", min: 1 }, ctx({ gateOptions: g })))).toMatch(/^evidence unavailable/);
  });

  // No substitution makes a hit on a rewritten label trustworthy: `.`, `[^/]` and a negative lookahead all match a
  // token's own text. Each of these was a definite (wrong) verdict when a hit was judged on a sentinel.
  it.each([
    ["^Keep [^/]", { exactly: 1 }, [`Keep ${TOKEN}`, "Other"]],
    ["^Write to .$", { exactly: 0 }, [`Write to ${TOKEN}`]],
    ["^(?!.*/Users)", { exactly: 1 }, [`Save to ${TOKEN}`, "Skip"]],
  ])("/%s/ over a rewritten label is evidence-unavailable, never a verdict", (matches, bound, labels) => {
    const r = run({ matches, ...bound }, ctx({ gateOptions: [gate("Pick", labels as string[])] }));
    expect(r.pass).toBe(false);
    expect(msg(r)).toMatch(/^evidence unavailable: .*redaction/);
  });

  it("a when_question that cannot see a rewritten question blocks a pass, never a fail the others earned", () => {
    const g = [gate(`Save ${TOKEN}?`, ["keep a", "keep b"]), gate("Save /Users/b?", ["keep a"])];
    const r = run({ when_question: "/Users/", matches: "^keep", exactly: 1 }, ctx({ gateOptions: g }));
    expect(msg(r)).toMatch(/^evidence unavailable: .*question text rewritten/);
    // A definite violation among the identifiable ones still fails as a violation.
    const bad = [gate(`Save ${TOKEN}?`, ["keep a"]), gate("Save /Users/b?", ["keep a", "keep b"])];
    expect(msg(run({ when_question: "/Users/", matches: "^keep", exactly: 1 }, ctx({ gateOptions: bad })))).toMatch(/did not/);
    // Only rewritten questions: nothing identifiable, evidence-unavailable rather than "no question was asked".
    expect(
      msg(run({ when_question: "/Users/", matches: "^keep", exactly: 1 }, ctx({ gateOptions: [gate(`Save ${TOKEN}?`, ["keep"])] }))),
    ).toMatch(/^evidence unavailable: .*no sub-question/);
  });

  it("a frozen regex the policy rewrote is evidence-unavailable", () => {
    expect(msg(run({ matches: `^${TOKEN}`, exactly: 0 }, ctx({ gateOptions: GATES })))).toMatch(/^evidence unavailable: .*rewritten/);
  });
});

describe("question_option_count: load time, buckets, cassette version", () => {
  const parse = (qoc: unknown) =>
    ScenarioObject.safeParse({ prompt: "x", fidelity: "container", assert: [{ question_option_count: qoc }] });

  it.each([
    [{ matches: "x" }, /checks nothing/],
    [{ matches: "x", exactly: 1, max: 2 }, /not both/],
    [{ matches: "x", min: 3, max: 1 }, /greater than/],
    [{ matches: "", exactly: 1 }, /./],
    [{ matches: "x", exactly: -1 }, /./],
    [{ matches: "x", exactly: 1, case_sensitive: false }, /./],
    [{ matches: "x", exactly: 1, extra: true }, /./],
    // A double-quoted YAML "\b" arrives as a backspace: a regex that would silently match nothing.
    [{ matches: "^No\b", exactly: 0 }, /control character/],
    [{ matches: "x", when_question: "a\bb", exactly: 0 }, /control character/],
  ])("refuses %j before the spawn", (qoc, re) => {
    const r = parse(qoc);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(re);
  });

  it("accepts exactly: 0 and min-only / max-only", () => {
    for (const q of [
      { matches: "x", exactly: 0 },
      { matches: "x", min: 1 },
      { matches: "x", max: 0 },
    ])
      expect(parse(q).success).toBe(true);
  });

  it("is a gate key and a model-authored-text key", () => {
    expect(QUESTION_GATE_KEYS).toContain("question_option_count");
    expect(MODEL_AUTHORED_TEXT_KEYS).toContain("question_option_count");
  });

  it("stamps cassette v14, parsed or loose (a v13 reader's schema rejects the key)", () => {
    const a = [{ question_option_count: { matches: "x", exactly: 0 } }];
    expect(requiredVersionFor(ScenarioObject.parse({ prompt: "x", fidelity: "container", assert: a }))).toBe(14);
    expect(requiredVersionFor({ assert: a })).toBe(14);
    expect(requiredVersionFor({ assert: [{ question_options: { equals: ["a"] } }] })).toBeLessThan(14);
  });

  it("requires a gate, so it contradicts questions_count_max: 0 — exactly: 0 included", () => {
    const sc = ScenarioObject.parse({
      prompt: "x",
      fidelity: "container",
      assert: [{ questions_count_max: 0 }, { question_option_count: { matches: "x", exactly: 0 } }],
    });
    expect(assertContradiction(sc)).toMatch(/question_option_count/);
  });
});
