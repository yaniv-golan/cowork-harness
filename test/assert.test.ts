import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, type AssertContext } from "../src/assert.js";

function ctx(over: Partial<AssertContext> = {}): AssertContext {
  return {
    transcript: "",
    toolsCalled: new Set(),
    subagentTools: new Set(),
    egress: [],
    result: "success",
    workRoot: "/nonexistent",
    userVisiblePrefixes: ["outputs", ".projects"],
    outputsDeletes: [],
    questions: [],
    hostPathLeaked: false,
    selfHealRan: false,
    subagents: [],
    gateDeliveries: [],
    ...over,
  };
}
const pass = (r: ReturnType<typeof evaluate>) => r.every((x) => x.pass);

describe("transcript_matches — fuzzy content for stochastic prose", () => {
  const t = "The SOM is $4.9M for the AI meeting-notes market.";
  it("regex (alternation/anchor) matches; case-insensitive", () => {
    expect(pass(evaluate([{ transcript_matches: "som is \\$[0-9.]+m" }], ctx({ transcript: t })))).toBe(true);
    expect(pass(evaluate([{ transcript_matches: "tam|sam|som" }], ctx({ transcript: t })))).toBe(true);
  });
  it("fails when the pattern doesn't match", () => {
    const r = evaluate([{ transcript_matches: "EBITDA" }], ctx({ transcript: t }));
    expect(pass(r)).toBe(false);
    expect(r[0].message).toContain("did not match");
  });
  it("transcript_not_matches: passes when absent, fails when present", () => {
    expect(pass(evaluate([{ transcript_not_matches: "stack trace" }], ctx({ transcript: t })))).toBe(true);
    expect(pass(evaluate([{ transcript_not_matches: "SOM" }], ctx({ transcript: t })))).toBe(false);
  });
  it("a malformed regex FAILS cleanly (does not throw — evaluate has no try/catch)", () => {
    const r = evaluate([{ transcript_matches: "(" }], ctx({ transcript: t }));
    expect(pass(r)).toBe(false);
    expect(r[0].message).toContain("bad regex");
  });
});

describe("gate_answers_delivered (Part 3 — catches O7-class delivery failures)", () => {
  it("passes when every answered gate's delivery was OBSERVED and non-error", () => {
    const c = ctx({
      gateDeliveries: [
        { question: "Proceed?", delivered: true },
        { question: "Stage?", delivered: true },
      ],
    });
    expect(pass(evaluate([{ gate_answers_delivered: true }], c))).toBe(true);
  });
  // #19: an UNOBSERVED delivery (delivered=null) is no longer "neutral" — on a finished run/cassette
  // it is absence of the required evidence, so gate_answers_delivered:true must FAIL loud, not pass.
  it("FAILS when a gate's delivery is unobserved (delivered=null) — no silent false-green", () => {
    const c = ctx({
      gateDeliveries: [
        { question: "Proceed?", delivered: true },
        { question: "Stage?", delivered: null },
      ],
    });
    const r = evaluate([{ gate_answers_delivered: true }], c);
    expect(pass(r)).toBe(false);
    expect(r[0].message).toContain("unobserved");
  });
  it("FAILS when a gate's answer errored (the O7 q.map case)", () => {
    const c = ctx({
      gateDeliveries: [{ question: "Proceed?", delivered: false, error: "undefined is not an object (evaluating 'q.map')" }],
    });
    const r = evaluate([{ gate_answers_delivered: true }], c);
    expect(pass(r)).toBe(false);
    expect(r[0].message).toContain("q.map");
  });
});

describe("#5: multi-key assertions evaluate ALL keys (AND), not just the first", () => {
  it("passes only when every present key passes", () => {
    const c = ctx({ transcript: "hello world", toolsCalled: new Set(["Bash"]) });
    expect(pass(evaluate([{ transcript_contains: "hello", tool_called: "Bash" }], c))).toBe(true);
    // second key fails → whole assertion fails (first-key-wins would have passed on transcript)
    const r = evaluate([{ transcript_contains: "hello", tool_called: "Read" }], c);
    expect(pass(r)).toBe(false);
    expect(r[0].message).toContain("tool not called: Read");
  });
});

describe("subagent_dispatched matches agentType OR description (O1)", () => {
  const subs = [
    { agentType: "unknown", declaredTools: [], toolsUsed: [], description: "TOP_DOWN market sizing for Cadence" },
    { agentType: "example-skills:market-sizing", declaredTools: [], toolsUsed: [], description: "coaching" },
  ];
  it("matches a named dispatch by agentType", () => {
    expect(pass(evaluate([{ subagent_dispatched: "market-sizing" }], ctx({ subagents: subs })))).toBe(true);
  });
  it("matches an UNKNOWN-typed dispatch by its description (the skill set no subagent_type)", () => {
    expect(pass(evaluate([{ subagent_dispatched: "TOP_DOWN" }], ctx({ subagents: subs })))).toBe(true);
  });
  it("fails when neither type nor description matches", () => {
    expect(pass(evaluate([{ subagent_dispatched: "SLIDE_REVIEWS" }], ctx({ subagents: subs })))).toBe(false);
  });
});

describe("false-green catchers (deterministic)", () => {
  it("user_visible_artifact: only files under outputs/.projects count", () => {
    const work = mkdtempSync(join(tmpdir(), "cowork-assert-"));
    mkdirSync(join(work, "outputs"), { recursive: true });
    mkdirSync(join(work, "tmp"), { recursive: true });
    writeFileSync(join(work, "outputs", "a.md"), "x");
    writeFileSync(join(work, "tmp", "b.md"), "x");
    const c = ctx({ workRoot: work });
    expect(pass(evaluate([{ user_visible_artifact: "outputs/a.md" }], c))).toBe(true);
    // exists but NOT user-visible -> fails (mirrors Cowork: invisible to the user)
    expect(pass(evaluate([{ user_visible_artifact: "tmp/b.md" }], c))).toBe(false);
  });

  it("no_delete_in_outputs: flags any delete touching outputs", () => {
    expect(pass(evaluate([{ no_delete_in_outputs: true }], ctx({ outputsDeletes: [] })))).toBe(true);
    expect(pass(evaluate([{ no_delete_in_outputs: true }], ctx({ outputsDeletes: ["rm outputs/x"] })))).toBe(false);
  });

  it("subagent_tool_used/absent: tracks the sub-agent registry (v0.3.0 class)", () => {
    const c = ctx({ subagentTools: new Set(["Read", "Grep"]) });
    expect(pass(evaluate([{ subagent_tool_absent: "Bash" }], c))).toBe(true); // Bash didn't bind
    expect(pass(evaluate([{ subagent_tool_used: "Bash" }], c))).toBe(false);
  });

  it("question fidelity: question_asked + questions_count_max", () => {
    const c = ctx({ questions: ["Which fruit do you prefer?"] });
    expect(pass(evaluate([{ question_asked: "fruit" }], c))).toBe(true);
    expect(pass(evaluate([{ questions_count_max: 1 }], c))).toBe(true);
    expect(pass(evaluate([{ questions_count_max: 0 }], c))).toBe(false);
  });

  it("self_heal_ran + transcript_no_host_path", () => {
    expect(pass(evaluate([{ self_heal_ran: true }], ctx({ selfHealRan: true })))).toBe(true);
    expect(pass(evaluate([{ transcript_no_host_path: true }], ctx({ hostPathLeaked: true })))).toBe(false);
  });
});

// #5 — artifact_json: dotted-path resolver (three states) + operators; live-only (stripped on replay).
import { resolveDotPath } from "../src/assert.js";
import { collectArtifacts } from "../src/run/execute.js";

function artifactRoot(doc: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "cwh-artifact-"));
  mkdirSync(join(root, "outputs"), { recursive: true });
  writeFileSync(join(root, "outputs", "state.json"), JSON.stringify(doc));
  return root;
}

describe("resolveDotPath — three distinct states", () => {
  const doc = { me: { run_id: "r1", count: 3, note: null }, items: [{ id: "a" }] };
  it("value: a present value (including array index)", () => {
    expect(resolveDotPath(doc, "me.run_id")).toEqual({ state: "value", value: "r1" });
    expect(resolveDotPath(doc, "items.0.id")).toEqual({ state: "value", value: "a" });
    expect(resolveDotPath(doc, undefined)).toEqual({ state: "value", value: doc });
  });
  it("value with JSON null is distinct from absent", () => {
    expect(resolveDotPath(doc, "me.note")).toEqual({ state: "value", value: null });
  });
  it("absent: final key missing from a resolved parent", () => {
    expect(resolveDotPath(doc, "me.exclusivity_days")).toEqual({ state: "absent" });
  });
  it("unresolved: an intermediate segment is missing / not an object", () => {
    expect(resolveDotPath(doc, "nope.deep.key").state).toBe("unresolved");
    expect(resolveDotPath(doc, "me.run_id.x").state).toBe("unresolved"); // descend into a string
  });
});

describe("artifact_json assertion (#5)", () => {
  const doc = { me: { run_id: "r1", count: 3, note: null } };
  const root = artifactRoot(doc);
  const A = (artifact_json: any) => evaluate([{ artifact_json }], ctx({ workRoot: root }));
  it("equals on a dotted path", () => {
    expect(pass(A({ artifact: "outputs/state.json", path: "me.run_id", equals: "r1" }))).toBe(true);
    expect(pass(A({ artifact: "outputs/state.json", path: "me.run_id", equals: "WRONG" }))).toBe(false);
  });
  it("gt requires a number greater than", () => {
    expect(pass(A({ artifact: "outputs/state.json", path: "me.count", gt: 2 }))).toBe(true);
    expect(pass(A({ artifact: "outputs/state.json", path: "me.count", gt: 3 }))).toBe(false);
  });
  it("absent (anti-hallucination) vs is_null are distinct", () => {
    expect(pass(A({ artifact: "outputs/state.json", path: "me.exclusivity_days", absent: true }))).toBe(true);
    expect(pass(A({ artifact: "outputs/state.json", path: "me.note", absent: true }))).toBe(false); // present (null) ≠ absent
    expect(pass(A({ artifact: "outputs/state.json", path: "me.note", is_null: true }))).toBe(true);
    expect(pass(A({ artifact: "outputs/state.json", path: "me.run_id", is_null: true }))).toBe(false);
  });
  it("exists true/false", () => {
    expect(pass(A({ artifact: "outputs/state.json", path: "me.run_id", exists: true }))).toBe(true);
    expect(pass(A({ artifact: "outputs/state.json", path: "me.nope", exists: false }))).toBe(true);
  });
  it("an unresolved intermediate path FAILS LOUD (not a vacuous absent pass)", () => {
    const r = A({ artifact: "outputs/state.json", path: "nope.deep.key", absent: true });
    expect(pass(r)).toBe(false);
    expect(r[0].message).toMatch(/unresolvable/);
  });
  it("missing file and invalid JSON both fail", () => {
    expect(pass(A({ artifact: "outputs/missing.json", path: "x", exists: true }))).toBe(false);
  });
});

describe("collectArtifacts — ENV-MANIFEST recursive listing", () => {
  it("lists files (relative path + bytes) under the user-visible prefixes; empty when nothing written", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-manifest-"));
    mkdirSync(join(root, "outputs", "sub"), { recursive: true });
    writeFileSync(join(root, "outputs", "a.txt"), "hello");
    writeFileSync(join(root, "outputs", "sub", "b.json"), "{}");
    const got = collectArtifacts(root, ["outputs", ".projects"]);
    expect(got.map((g) => g.path)).toEqual(["outputs/a.txt", "outputs/sub/b.json"]);
    expect(got.find((g) => g.path === "outputs/a.txt")?.bytes).toBe(5);
    // a fresh root with no outputs/ → empty manifest (the all-or-nothing truncation signal)
    expect(collectArtifacts(mkdtempSync(join(tmpdir(), "cwh-empty-")), ["outputs"])).toEqual([]);
  });
});

describe("assertion path containment", () => {
  const root = mkdtempSync(join(tmpdir(), "assert-root-"));
  mkdirSync(join(root, "outputs"), { recursive: true });
  writeFileSync(join(root, "outputs", "report.pdf"), "x");

  it("file_exists finds a contained file and rejects traversal / absolute paths", () => {
    expect(pass(evaluate([{ file_exists: "outputs/report.pdf" }], ctx({ workRoot: root })))).toBe(true);
    const esc = evaluate([{ file_exists: "../../etc/passwd" }], ctx({ workRoot: root }));
    expect(pass(esc)).toBe(false);
    expect(esc[0].message).toMatch(/unsafe file_exists path/);
    expect(pass(evaluate([{ file_exists: "/etc/passwd" }], ctx({ workRoot: root })))).toBe(false);
  });

  it("user_visible_artifact rejects a traversal that slips past the prefix (normalized before the prefix test)", () => {
    const r = evaluate([{ user_visible_artifact: "outputs/../../escape" }], ctx({ workRoot: root }));
    expect(pass(r)).toBe(false);
    expect(r[0].message).toMatch(/unsafe user_visible_artifact path/);
    expect(pass(evaluate([{ user_visible_artifact: "outputs/report.pdf" }], ctx({ workRoot: root })))).toBe(true);
  });
});
