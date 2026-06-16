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
