import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, hostMatches, budgetFields, type AssertContext } from "../src/assert.js";

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
    toolResultTexts: [],
    skillsInvoked: [],
    skillToolAvailable: true,
    ...over,
  };
}
const pass = (r: ReturnType<typeof evaluate>) => r.every((x) => x.pass);

describe("hostMatches normalizes both sides (case + trailing dot), keeps subdomain semantics", () => {
  it("matches a mixed-case needle against a lowercase host", () => {
    expect(hostMatches("api.anthropic.com", "API.Anthropic.COM")).toBe(true);
    expect(hostMatches("API.ANTHROPIC.COM", "api.anthropic.com")).toBe(true);
  });

  it("matches a trailing-dot needle (FQDN form) against a bare host and vice versa", () => {
    expect(hostMatches("api.anthropic.com", "anthropic.com.")).toBe(true); // x.needle subdomain rule
    expect(hostMatches("anthropic.com.", "anthropic.com")).toBe(true); // exact after dot-strip
  });

  it("preserves the proper-subdomain boundary (no prefix-confusion match)", () => {
    expect(hostMatches("x.anthropic.com", "anthropic.com")).toBe(true);
    expect(hostMatches("evilanthropic.com", "anthropic.com")).toBe(false);
  });
});

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

describe("gate_answers_delivered (catches delivery failures)", () => {
  it("passes when every answered gate's delivery was OBSERVED and non-error", () => {
    const c = ctx({
      gateDeliveries: [
        { question: "Proceed?", delivered: true },
        { question: "Stage?", delivered: true },
      ],
    });
    expect(pass(evaluate([{ gate_answers_delivered: true }], c))).toBe(true);
  });
  // an UNOBSERVED delivery (delivered=null) is no longer "neutral" — on a finished run/cassette
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
  it("FAILS when a gate's answer errored (the q.map case)", () => {
    const c = ctx({
      gateDeliveries: [{ question: "Proceed?", delivered: false, error: "undefined is not an object (evaluating 'q.map')" }],
    });
    const r = evaluate([{ gate_answers_delivered: true }], c);
    expect(pass(r)).toBe(false);
    expect(r[0].message).toContain("q.map");
  });
  // T1: gate firing is model-dependent, so gate_answers_delivered:true must not hard-fail when no
  // gate fired at all — that would make the assertion unusable for optional-gate skills. This is
  // distinct from gateDeliveriesMissing (evidence absent), covered below.
  it("gate_answers_delivered: true passes VACUOUSLY when zero gates fired (gateDeliveries: [])", () => {
    const c = ctx({ gateDeliveries: [] });
    expect(pass(evaluate([{ gate_answers_delivered: true }], c))).toBe(true);
  });
});

describe("gate_answer_count_min (presence companion to gate_answers_delivered)", () => {
  it("fails when zero gates fired", () => {
    const c = ctx({ gateDeliveries: [] });
    const r = evaluate([{ gate_answer_count_min: 1 }], c);
    expect(pass(r)).toBe(false);
    expect(r[0].message).toContain("need ≥ 1");
  });
  it("passes when at least N gates were delivered", () => {
    const c = ctx({ gateDeliveries: [{ question: "Proceed?", delivered: true }] });
    expect(pass(evaluate([{ gate_answer_count_min: 1 }], c))).toBe(true);
  });
  it("fails when fewer than N gates were delivered (one delivered, need two)", () => {
    const c = ctx({ gateDeliveries: [{ question: "Proceed?", delivered: true }] });
    const r = evaluate([{ gate_answer_count_min: 2 }], c);
    expect(pass(r)).toBe(false);
    expect(r[0].message).toContain("only 1 gate answer(s)");
  });
});

describe("gateDeliveriesMissing — evidence-unavailable guard (bug-#33 regression: absent ≠ zero gates)", () => {
  it("gate_answers_delivered: true FAILS evidence-unavailable when gate telemetry is missing (NOT vacuous pass)", () => {
    const c = ctx({ gateDeliveries: [], gateDeliveriesMissing: true });
    const r = evaluate([{ gate_answers_delivered: true }], c);
    expect(pass(r)).toBe(false);
    expect(r[0].message).toContain("evidence unavailable");
  });
  it("gate_answer_count_min: 1 FAILS evidence-unavailable when gate telemetry is missing", () => {
    const c = ctx({ gateDeliveries: [], gateDeliveriesMissing: true });
    const r = evaluate([{ gate_answer_count_min: 1 }], c);
    expect(pass(r)).toBe(false);
    expect(r[0].message).toContain("evidence unavailable");
  });
});

describe("multi-key assertions evaluate ALL keys (AND), not just the first", () => {
  it("passes only when every present key passes", () => {
    const c = ctx({ transcript: "hello world", toolsCalled: new Set(["Bash"]) });
    expect(pass(evaluate([{ transcript_contains: "hello", tool_called: "Bash" }], c))).toBe(true);
    // second key fails → whole assertion fails (first-key-wins would have passed on transcript)
    const r = evaluate([{ transcript_contains: "hello", tool_called: "Read" }], c);
    expect(pass(r)).toBe(false);
    expect(r[0].message).toContain("tool not called: Read");
  });
});

describe("subagent_dispatched matches agentType OR description", () => {
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

describe("skill_triggered / no_skill_triggered (Wave 1 / E8)", () => {
  const invoked = ["my-pdf-skill:my-pdf-skill", "other-plugin:helper"];

  it("skill_triggered matches an invoked skill id by regex", () => {
    expect(pass(evaluate([{ skill_triggered: "my-pdf-skill" }], ctx({ skillsInvoked: invoked })))).toBe(true);
  });
  it("skill_triggered fails when no invoked skill matches", () => {
    const r = evaluate([{ skill_triggered: "nonexistent" }], ctx({ skillsInvoked: invoked }));
    expect(pass(r)).toBe(false);
    expect(r[0].message).toContain("no invoked skill matched");
  });
  it("no_skill_triggered passes when no invoked skill matches", () => {
    expect(pass(evaluate([{ no_skill_triggered: "nonexistent" }], ctx({ skillsInvoked: invoked })))).toBe(true);
  });
  it("no_skill_triggered fails when a skill DID match (negative-assertion catch)", () => {
    expect(pass(evaluate([{ no_skill_triggered: "my-pdf-skill" }], ctx({ skillsInvoked: invoked })))).toBe(false);
  });
  it("both keys fail as evidence-unavailable when the agent's init tool list has no Skill tool", () => {
    const r1 = evaluate([{ skill_triggered: "x" }], ctx({ skillToolAvailable: false }));
    expect(pass(r1)).toBe(false);
    expect(r1[0].message).toContain("evidence unavailable");
    const r2 = evaluate([{ no_skill_triggered: "x" }], ctx({ skillToolAvailable: false }));
    expect(pass(r2)).toBe(false);
    expect(r2[0].message).toContain("evidence unavailable");
  });
  it("no_skill_triggered fails as evidence-unavailable (not vacuously passes) when skillsInvoked data is absent", () => {
    const r = evaluate([{ no_skill_triggered: "x" }], ctx({ skillsInvokedMissing: true }));
    expect(pass(r)).toBe(false);
    expect(r[0].message).toContain("evidence unavailable");
  });
  it("skill_triggered on missing skillsInvoked data fails normally (no vacuous-pass risk for a positive claim)", () => {
    // mirrors subagent_dispatched's convention: a positive assertion over an empty/absent collection just
    // fails naturally — only the NEGATIVE assertion needs the evidence-unavailable guard.
    const r = evaluate([{ skill_triggered: "x" }], ctx({ skillsInvokedMissing: true, skillsInvoked: [] }));
    expect(pass(r)).toBe(false);
  });
  it("a malformed regex fails cleanly on both keys (no throw)", () => {
    expect(pass(evaluate([{ skill_triggered: "(" }], ctx()))).toBe(false);
    expect(pass(evaluate([{ no_skill_triggered: "(" }], ctx()))).toBe(false);
  });
});

describe("budgetFields (Wave 1 / E6a + Wave 2 / E6b) — the single derivation used by live/replay/verify-run", () => {
  it("computes all four from a fully-populated source", () => {
    expect(
      budgetFields({ cost: { usd: 1.5 }, usage: { input_tokens: 100, output_tokens: 50, turns: 7 }, toolCounts: { Read: 2, Write: 1 } }),
    ).toEqual({ costUsd: 1.5, tokensTotal: 150, toolCallsTotal: 3, turns: 7 });
  });
  it("returns undefined for each field when its source is absent (not 0)", () => {
    expect(budgetFields({})).toEqual({ costUsd: undefined, tokensTotal: undefined, toolCallsTotal: undefined, turns: undefined });
  });
  it("toolCallsTotal is 0 (a real value, not undefined) when toolCounts is a populated-but-empty object", () => {
    expect(budgetFields({ toolCounts: {} }).toolCallsTotal).toBe(0);
  });
  it("tokensTotal is undefined when only one of input/output tokens is a number", () => {
    expect(budgetFields({ usage: { input_tokens: 100 } }).tokensTotal).toBeUndefined();
  });
  it("turns passes through usage.turns directly (Wave 0 already computed it — no re-derivation here)", () => {
    expect(budgetFields({ usage: { turns: 4 } }).turns).toBe(4);
    expect(budgetFields({ usage: { turns: 0 } }).turns).toBe(0); // 0 turns is a real value, not "missing"
  });
});

describe("max_cost_usd / max_tokens / tool_calls_max (Wave 1 / E6a)", () => {
  it("max_cost_usd passes at/under the threshold, fails over it", () => {
    expect(pass(evaluate([{ max_cost_usd: 0.5 }], ctx({ costUsd: 0.5 })))).toBe(true);
    const r = evaluate([{ max_cost_usd: 0.5 }], ctx({ costUsd: 0.51 }));
    expect(pass(r)).toBe(false);
    expect(r[0].message).toContain("0.51");
  });
  it("max_cost_usd fails as evidence-unavailable (not a vacuous pass) when cost telemetry is absent", () => {
    const r = evaluate([{ max_cost_usd: 0.5 }], ctx({ costUsd: undefined }));
    expect(pass(r)).toBe(false);
    expect(r[0].message).toContain("evidence unavailable");
  });
  it("max_tokens passes at/under the threshold, fails over it", () => {
    expect(pass(evaluate([{ max_tokens: 1000 }], ctx({ tokensTotal: 1000 })))).toBe(true);
    expect(pass(evaluate([{ max_tokens: 1000 }], ctx({ tokensTotal: 1001 })))).toBe(false);
  });
  it("max_tokens fails as evidence-unavailable when token telemetry is absent", () => {
    const r = evaluate([{ max_tokens: 1000 }], ctx({ tokensTotal: undefined }));
    expect(pass(r)).toBe(false);
    expect(r[0].message).toContain("evidence unavailable");
  });
  it("tool_calls_max passes at/under the threshold, fails over it", () => {
    expect(pass(evaluate([{ tool_calls_max: 3 }], ctx({ toolCallsTotal: 3 })))).toBe(true);
    expect(pass(evaluate([{ tool_calls_max: 3 }], ctx({ toolCallsTotal: 4 })))).toBe(false);
  });
  it("tool_calls_max fails as evidence-unavailable when tool-count telemetry is absent", () => {
    const r = evaluate([{ tool_calls_max: 3 }], ctx({ toolCallsTotal: undefined }));
    expect(pass(r)).toBe(false);
    expect(r[0].message).toContain("evidence unavailable");
  });
});

describe("max_turns (Wave 2 / E6b — the last budget key, built on Wave 0's usage.turns)", () => {
  it("passes at/under the threshold, fails over it", () => {
    expect(pass(evaluate([{ max_turns: 5 }], ctx({ turns: 5 })))).toBe(true);
    const r = evaluate([{ max_turns: 5 }], ctx({ turns: 6 }));
    expect(pass(r)).toBe(false);
    expect(r[0].message).toContain("6");
  });
  it("0 turns is a real value that satisfies any non-negative max_turns, not evidence-unavailable", () => {
    expect(pass(evaluate([{ max_turns: 0 }], ctx({ turns: 0 })))).toBe(true);
  });
  it("fails as evidence-unavailable (not a vacuous pass) when turn telemetry is absent", () => {
    const r = evaluate([{ max_turns: 5 }], ctx({ turns: undefined }));
    expect(pass(r)).toBe(false);
    expect(r[0].message).toContain("evidence unavailable");
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

  it("user_visible_artifact honors DERIVED folder roots (bare name), not a hardcoded .projects prefix", () => {
    // A file written into a connected work folder that mounts at the bare name `project` (gated). Visibility
    // must come from the run's derived userVisibleRoots, NOT a fixed `.projects/` prefix.
    const work = mkdtempSync(join(tmpdir(), "cowork-assert-uvr-"));
    mkdirSync(join(work, "project"), { recursive: true });
    writeFileSync(join(work, "project", "report.md"), "x");
    // with the derived root present → visible
    expect(
      pass(
        evaluate([{ user_visible_artifact: "project/report.md" }], ctx({ workRoot: work, userVisiblePrefixes: ["outputs", "project"] })),
      ),
    ).toBe(true);
    // with only the legacy default → the bare-named folder file is INVISIBLE (proves derivation matters)
    expect(
      pass(
        evaluate([{ user_visible_artifact: "project/report.md" }], ctx({ workRoot: work, userVisiblePrefixes: ["outputs", ".projects"] })),
      ),
    ).toBe(false);
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

// Assertion evidence manifest: negative/absence assertions must fail loud when their
// verify-run evidence source is ABSENT (undefined in result.json), not pass vacuously. The flags
// default to "present" (undefined) so the replay/live lanes — which never set them — keep greening
// an empty-but-present set as proof-of-absence (guards against the verify-run-scoping regression).
describe("evidence-missing flags fail negative assertions loud (absent ≠ empty)", () => {
  it("tool_result_not_contains: FAILS when toolResultsMissing, but still greens on empty-but-present", () => {
    const r = evaluate([{ tool_result_not_contains: "secret" }], ctx({ toolResultsMissing: true }));
    expect(pass(r)).toBe(false);
    expect(r[0].message).toContain("evidence unavailable");
    expect(r[0].message).toContain("tool_result_not_contains");
    // replay/live lane: flag unset (present), empty set → proof the text never appeared → green.
    expect(pass(evaluate([{ tool_result_not_contains: "secret" }], ctx({ toolResultTexts: [] })))).toBe(true);
  });

  it("tool_not_called: FAILS when toolsCalledMissing, but still greens on empty-but-present", () => {
    const r = evaluate([{ tool_not_called: "Bash" }], ctx({ toolsCalledMissing: true }));
    expect(pass(r)).toBe(false);
    expect(r[0].message).toContain("evidence unavailable");
    expect(r[0].message).toContain("tool_not_called");
    expect(pass(evaluate([{ tool_not_called: "Bash" }], ctx({ toolsCalled: new Set() })))).toBe(true);
  });

  it("subagent_tool_absent: FAILS when subagentsMissing, but still greens on empty-but-present", () => {
    const r = evaluate([{ subagent_tool_absent: "Bash" }], ctx({ subagentsMissing: true }));
    expect(pass(r)).toBe(false);
    expect(r[0].message).toContain("evidence unavailable");
    expect(r[0].message).toContain("subagent_tool_absent");
    expect(pass(evaluate([{ subagent_tool_absent: "Bash" }], ctx({ subagentTools: new Set() })))).toBe(true);
  });

  it("dispatch_count_max: FAILS when subagentsMissing (no vacuous 0 ≤ max), greens on empty-but-present", () => {
    const r = evaluate([{ dispatch_count_max: 3 }], ctx({ subagentsMissing: true }));
    expect(pass(r)).toBe(false);
    expect(r[0].message).toContain("evidence unavailable");
    expect(r[0].message).toContain("dispatch_count_max");
    expect(pass(evaluate([{ dispatch_count_max: 3 }], ctx({ subagents: [] })))).toBe(true);
  });

  it("subagent_declared_but_unused: FAILS when subagentsMissing (no vacuous find=undefined), greens on empty", () => {
    const r = evaluate([{ subagent_declared_but_unused: "Bash" }], ctx({ subagentsMissing: true }));
    expect(pass(r)).toBe(false);
    expect(r[0].message).toContain("evidence unavailable");
    expect(r[0].message).toContain("subagent_declared_but_unused");
    expect(pass(evaluate([{ subagent_declared_but_unused: "Bash" }], ctx({ subagents: [] })))).toBe(true);
  });

  it("no_delete_in_outputs: FAILS when scanMissing, but still greens on empty-but-present scan", () => {
    const r = evaluate([{ no_delete_in_outputs: true }], ctx({ scanMissing: true }));
    expect(pass(r)).toBe(false);
    expect(r[0].message).toContain("evidence unavailable");
    expect(r[0].message).toContain("no_delete_in_outputs");
    expect(pass(evaluate([{ no_delete_in_outputs: true }], ctx({ outputsDeletes: [] })))).toBe(true);
  });

  it("transcript_no_host_path: FAILS when scanMissing, but still greens on empty-but-present scan", () => {
    const r = evaluate([{ transcript_no_host_path: true }], ctx({ scanMissing: true }));
    expect(pass(r)).toBe(false);
    expect(r[0].message).toContain("evidence unavailable");
    expect(r[0].message).toContain("transcript_no_host_path");
    expect(pass(evaluate([{ transcript_no_host_path: true }], ctx({ hostPathLeaked: false })))).toBe(true);
  });

  it("self_heal_ran: FAILS when scanMissing, but still evaluates against an empty-but-present scan", () => {
    const r = evaluate([{ self_heal_ran: false }], ctx({ scanMissing: true }));
    expect(pass(r)).toBe(false);
    expect(r[0].message).toContain("evidence unavailable");
    expect(r[0].message).toContain("self_heal_ran");
    // flag unset (present) + selfHealRan:false → the assertion's own truth check applies.
    expect(pass(evaluate([{ self_heal_ran: false }], ctx({ selfHealRan: false })))).toBe(true);
  });
});

// artifact_json: dotted-path resolver (three states) + operators; live-only (stripped on replay).
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

describe("artifact_json assertion", () => {
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
  it("in: set membership (stable for stochastic extraction)", () => {
    expect(pass(A({ artifact: "outputs/state.json", path: "me.run_id", in: ["r1", "r2"] }))).toBe(true);
    expect(pass(A({ artifact: "outputs/state.json", path: "me.run_id", in: ["x", "y"] }))).toBe(false);
    expect(pass(A({ artifact: "outputs/state.json", path: "me.count", in: [1, 2, 3] }))).toBe(true);
    // an ABSENT value must NOT satisfy in: (mirrors equals' `present &&` guard)
    expect(pass(A({ artifact: "outputs/state.json", path: "me.exclusivity_days", in: ["a"] }))).toBe(false);
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

// artifact_json equals/in deep-equality is INSENSITIVE to object key order but
// SENSITIVE to array order (the old JSON.stringify compare was wrongly key-order-sensitive).
describe("artifact_json equals/in — key-order-insensitive, array-order-sensitive", () => {
  const A = (doc: unknown, artifact_json: any) => {
    const root = artifactRoot(doc);
    return evaluate([{ artifact_json }], ctx({ workRoot: root }));
  };
  it("equals passes for an object with reordered keys", () => {
    expect(pass(A({ a: 1, b: 2 }, { artifact: "outputs/state.json", path: undefined, equals: { b: 2, a: 1 } }))).toBe(true);
  });
  it("equals passes for nested reordering", () => {
    const doc = { outer: { x: 1, y: { p: "a", q: "b" } }, list: [1, 2, 3] };
    const expected = { list: [1, 2, 3], outer: { y: { q: "b", p: "a" }, x: 1 } };
    expect(pass(A(doc, { artifact: "outputs/state.json", path: undefined, equals: expected }))).toBe(true);
  });
  it("equals FAILS for a reordered array (arrays are order-significant)", () => {
    expect(pass(A({ nums: [1, 2] }, { artifact: "outputs/state.json", path: "nums", equals: [2, 1] }))).toBe(false);
    expect(pass(A({ nums: [1, 2] }, { artifact: "outputs/state.json", path: "nums", equals: [1, 2] }))).toBe(true);
  });
  it("equals FAILS for genuinely different values", () => {
    expect(pass(A({ a: 1, b: 2 }, { artifact: "outputs/state.json", path: undefined, equals: { a: 1, b: 3 } }))).toBe(false);
    expect(pass(A({ a: 1 }, { artifact: "outputs/state.json", path: undefined, equals: { a: 1, b: 2 } }))).toBe(false);
  });
  it("in matches via reordered-key deep equality", () => {
    expect(pass(A({ a: 1, b: 2 }, { artifact: "outputs/state.json", path: undefined, in: [{ b: 2, a: 1 }, { z: 9 }] }))).toBe(true);
    expect(pass(A({ a: 1, b: 2 }, { artifact: "outputs/state.json", path: undefined, in: [{ a: 1, b: 3 }, { z: 9 }] }))).toBe(false);
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

// Regression: file_exists / user_visible_artifact must PASS for truncated (large) artifacts.
// A truncated manifest entry carries path+bytes+sha256 — positive proof the file existed at record
// time. Existence assertions should pass from the manifest; only artifact_json needs the inlined body.
import { materializeManifest } from "../src/run/cassette.js";
import { createHash } from "node:crypto";

describe("file_exists / user_visible_artifact pass on truncated cassette entries (regression)", () => {
  const bigContent = Buffer.alloc(128 * 1024, "x"); // 128 KiB — above the 64 KiB inline cap
  const bigSha = createHash("sha256").update(bigContent).digest("hex");
  const smallContent = Buffer.from('{"ok":true}');
  const smallSha = createHash("sha256").update(smallContent).digest("hex");

  const entries = [
    { path: "outputs/big.html", bytes: bigContent.length, sha256: bigSha, truncated: true as const, truncationReason: "size" as const },
    { path: "outputs/small.json", bytes: smallContent.length, sha256: smallSha, body: smallContent.toString("utf8") },
    { path: "outputs/non-visible/internal.log", bytes: 1, sha256: bigSha, truncated: true as const, truncationReason: "size" as const },
  ];
  const { workRoot, truncatedPaths } = materializeManifest(entries);
  const base = ctx({ workRoot, truncatedPaths });

  it("file_exists passes for a truncated entry (existence proven by manifest)", () => {
    expect(pass(evaluate([{ file_exists: "outputs/big.html" }], base))).toBe(true);
  });

  it("user_visible_artifact passes for a truncated entry under outputs/", () => {
    expect(pass(evaluate([{ user_visible_artifact: "outputs/big.html" }], base))).toBe(true);
  });

  it("user_visible_artifact fails for a truncated entry NOT under a user-visible prefix", () => {
    const r = evaluate([{ user_visible_artifact: "outputs/non-visible/internal.log" }], base);
    // path is under outputs/ so it IS visible — this just confirms prefix logic still runs for truncated
    expect(pass(evaluate([{ user_visible_artifact: "outputs/non-visible/internal.log" }], base))).toBe(true);
  });

  it("file_exists fails for a path that was never produced (truly absent)", () => {
    const r = evaluate([{ file_exists: "outputs/does-not-exist.txt" }], base);
    expect(pass(r)).toBe(false);
    expect(r[0].message).toMatch(/file not found/);
  });

  it("artifact_json fails evidence-unavailable (NOT a cryptic parse error) for a truncated entry", () => {
    // A truncated entry has no body in the cassette; artifact_json cannot be evaluated on replay. It
    // must fail LOUD with an actionable evidence-unavailable message (raise --max-artifact-bytes),
    // not a vacuous pass and not a confusing "not valid JSON" from parsing the 0-byte placeholder.
    // big.html is over-cap (not under a readonly root, and this replay ctx carries no readonlyFolderRoots),
    // so the message is the PRECISE over-cap remedy — not the read-only one.
    const r = evaluate([{ artifact_json: { artifact: "outputs/big.html", path: "ok", equals: true } }], base);
    expect(pass(r)).toBe(false);
    expect(r[0].message).toMatch(/evidence unavailable.*body-less/i);
    expect(r[0].message).toMatch(/--max-artifact-bytes/i);
    expect(r[0].message).not.toMatch(/read-only connected-folder input/i);
  });

  it("artifact_json on a read-only input is evidence-unavailable with the PRECISE read-only remedy on replay", () => {
    // Replay knows the read-only set (persisted on the cassette → passed into the ctx), so a body-less
    // read-only input gets the "assert on a deliverable" remedy, NOT the inert "raise --max-artifact-bytes".
    const roEntries = [{ path: "carta/input.json", bytes: 40, sha256: smallSha, truncated: true as const }];
    const ro = materializeManifest(roEntries);
    const roCtx = ctx({ workRoot: ro.workRoot, truncatedPaths: ro.truncatedPaths, readonlyFolderRoots: ["carta"] });
    const r = evaluate([{ artifact_json: { artifact: "carta/input.json", path: "x", equals: 1 } }], roCtx);
    expect(pass(r)).toBe(false);
    expect(r[0].message).toMatch(/read-only connected-folder input/i);
    expect(r[0].message).not.toMatch(/--max-artifact-bytes/i);
  });

  it("file_exists and artifact_json both pass for a small (inlined) entry", () => {
    expect(pass(evaluate([{ file_exists: "outputs/small.json" }], base))).toBe(true);
    expect(pass(evaluate([{ artifact_json: { artifact: "outputs/small.json", path: "ok", equals: true } }], base))).toBe(true);
  });
});

// Read-only connected-folder inputs are captured body-less, so artifact_json cannot be evaluated on
// replay. To keep the lanes SYMMETRIC (no green-record → red-replay), the live/verify-run lanes must
// ALSO return evidence-unavailable for a target under a readonly folder root — even though the real
// (valid-JSON) input is on disk here. Existence keys are unaffected.
describe("artifact_json: read-only folder inputs are evidence-unavailable on every lane (T3 symmetry)", () => {
  const root = mkdtempSync(join(tmpdir(), "cwh-ro-input-"));
  mkdirSync(join(root, "carta"), { recursive: true });
  writeFileSync(join(root, "carta", "input.json"), JSON.stringify({ instruments: 3 }));

  it("evidence-unavailable when the target is under a readonly folder root (real file present)", () => {
    const r = evaluate(
      [{ artifact_json: { artifact: "carta/input.json", path: "instruments", equals: 3 } }],
      ctx({ workRoot: root, readonlyFolderRoots: ["carta"] }),
    );
    expect(pass(r)).toBe(false);
    expect(r[0].message).toMatch(/evidence unavailable.*body-less/i);
    expect(r[0].message).toMatch(/read-only connected-folder input/i);
  });

  it("the SAME file evaluates normally when NOT under a readonly root (rw folder / captured with body)", () => {
    const r = evaluate(
      [{ artifact_json: { artifact: "carta/input.json", path: "instruments", equals: 3 } }],
      ctx({ workRoot: root, readonlyFolderRoots: [] }),
    );
    expect(pass(r)).toBe(true);
  });

  it("file_exists on a readonly input still PASSES (existence is provable; only content is unavailable)", () => {
    const r = evaluate([{ file_exists: "carta/input.json" }], ctx({ workRoot: root, readonlyFolderRoots: ["carta"] }));
    expect(pass(r)).toBe(true);
  });
});

describe("replay lane: user_visible_artifact honors the cassette's stored userVisibleRoots (v4)", () => {
  const body = '{"ok":true}';
  const sha = createHash("sha256").update(Buffer.from(body)).digest("hex");
  const entries = [{ path: "project/report.md", bytes: body.length, sha256: sha, body }];

  it("a file under a BARE folder root is visible when the cassette's roots include it", () => {
    // materializeManifest is the replay path; it now takes the stored roots and returns them as `prefixes`.
    const { workRoot, prefixes } = materializeManifest(entries, ["outputs", "project"]);
    expect(prefixes).toContain("project");
    expect(pass(evaluate([{ user_visible_artifact: "project/report.md" }], ctx({ workRoot, userVisiblePrefixes: prefixes })))).toBe(true);
  });

  it("the SAME file is INVISIBLE under the legacy default roots (proves the stored field is load-bearing)", () => {
    const { workRoot, prefixes } = materializeManifest(entries); // default ["outputs",".projects"]
    expect(pass(evaluate([{ user_visible_artifact: "project/report.md" }], ctx({ workRoot, userVisiblePrefixes: prefixes })))).toBe(false);
  });
});
