import { describe, it, expect } from "vitest";
import { evaluate, type AssertContext } from "../src/assert.js";
import { Assertion as AssertionSchema } from "../src/types.js";
import { Run } from "../src/run/run.js";
import type { AgentEvent, AgentSession, DecisionResponse } from "../src/agent/session.js";
import { ScriptedDecider } from "../src/decide/decider.js";

// The structured (object) form of `tool_called` / `tool_not_called`: a claim about WHAT a tool call
// carried (its input), WHERE it ran (main agent vs sub-agent), and what its PAIRED result said — none of
// which the string glob form, nor any `transcript_*` key, can see. Every scope case below runs on a
// SYNTHETIC stream: it pins the classifier's output for a shape, and is not a claim about what the agent
// binary emits.

type ToolCall = NonNullable<AssertContext["toolCalls"]>[number];

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
    mountDeletes: [],
    questions: [],
    hostPathLeaked: false,
    selfHealRan: false,
    subagents: [],
    gateDeliveries: [],
    toolResultTexts: [],
    skillsInvoked: [],
    skillToolAvailable: true,
    slashInvokedSkills: [],
    toolCalls: [],
    toolResults: [],
    ...over,
  };
}

const call = (
  toolUseId: string,
  name: string,
  input: Record<string, string>,
  origin: ToolCall["origin"] = "main",
  parentToolUseId?: string,
): ToolCall => ({
  toolUseId,
  name,
  input: Object.fromEntries(Object.entries(input).map(([k, v]) => [k, { text: v }])),
  origin,
  parentToolUseId,
});

const one = (a: unknown, c: AssertContext) => {
  const r = evaluate([a as never], c);
  expect(r).toHaveLength(1);
  return r[0];
};

describe("schema: the object form parses, the string form is unchanged", () => {
  it("accepts every documented sub-field", () => {
    const r = AssertionSchema.safeParse({
      tool_called: {
        tool: ["Bash", "mcp__workspace__bash"],
        input: { command: "fetch-lesson\\.js\\s+129" },
        input_any: "SKILL\\.md",
        result: { matches: "^OK", not_matches: "Traceback", is_error: false },
        scope: "subagent",
        subagent_type: "researcher",
        count: { min: 1, max: 3 },
      },
    });
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
    expect(AssertionSchema.safeParse({ tool_not_called: { tool: "Bash", input: { command: "rm\\s+-rf" }, scope: "any" } }).success).toBe(
      true,
    );
    expect(AssertionSchema.safeParse({ tool_called: "Bash" }).success).toBe(true);
  });

  it("rejects an unknown sub-field, an empty tool list, count on the negative form, and subagent_type outside scope: subagent", () => {
    expect(AssertionSchema.safeParse({ tool_called: { tool: "Bash", inputs: {} } }).success).toBe(false);
    expect(AssertionSchema.safeParse({ tool_called: { tool: [] } }).success).toBe(false);
    expect(AssertionSchema.safeParse({ tool_not_called: { tool: "Bash", count: { max: 1 } } }).success).toBe(false);
    expect(AssertionSchema.safeParse({ tool_called: { tool: "Bash", subagent_type: "x" } }).success).toBe(false);
  });
});

describe("mention vs execution — the false green the object form closes", () => {
  // The model SAYS it ran lesson 129; the Bash call actually ran 128.
  const c = ctx({
    transcript: "Done — I ran fetch-lesson.js 129 and it printed the lesson.",
    toolsCalled: new Set(["Bash"]),
    toolCalls: [call("b1", "Bash", { command: "node scripts/fetch-lesson.js 128" })],
    toolResults: [{ toolUseId: "b1", isError: false, text: "lesson 128 ok" }],
  });

  it("the object form FAILS: no Bash call's command matched", () => {
    const r = one({ tool_called: { tool: "Bash", input: { command: "fetch-lesson\\.js\\s+129" } } }, c);
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/no .*call/i);
    expect(r.message).toContain("fetch-lesson.js 128"); // the candidate list shows what DID run
  });

  it("the object form passes on the command that actually ran", () => {
    expect(one({ tool_called: { tool: "Bash", input: { command: "fetch-lesson\\.js\\s+128" } } }, c).pass).toBe(true);
  });

  it("documents the false green: transcript_matches passes on the mention alone", () => {
    expect(one({ transcript_matches: "fetch-lesson\\.js 129" }, c).pass).toBe(true);
  });

  it("tool_not_called with an input regex fails on a real match and passes on no match", () => {
    expect(one({ tool_not_called: { tool: "Bash", input: { command: "fetch-lesson\\.js\\s+128" } } }, c).pass).toBe(false);
    expect(one({ tool_not_called: { tool: "Bash", input: { command: "rm\\s+-rf" } } }, c).pass).toBe(true);
  });

  it("a missing input field is no match; a list of tool globs is any-of; input_any scans every top-level field", () => {
    expect(one({ tool_called: { tool: "Bash", input: { description: "." } } }, c).pass).toBe(false);
    expect(one({ tool_called: { tool: ["mcp__workspace__bash", "Bash"], input: { command: "128" } } }, c).pass).toBe(true);
    expect(one({ tool_called: { tool: "*", input_any: "scripts/fetch" } }, c).pass).toBe(true);
  });

  it("count bounds the number of satisfying calls", () => {
    const c2 = ctx({
      toolCalls: [call("b1", "Bash", { command: "ls" }), call("b2", "Bash", { command: "ls -la" })],
      toolResults: [
        { toolUseId: "b1", isError: false, text: "" },
        { toolUseId: "b2", isError: false, text: "" },
      ],
    });
    expect(one({ tool_called: { tool: "Bash", input: { command: "^ls" }, count: { min: 2 } } }, c2).pass).toBe(true);
    expect(one({ tool_called: { tool: "Bash", input: { command: "^ls" }, count: { max: 1 } } }, c2).pass).toBe(false);
  });
});

describe("result pairing (by toolUseId)", () => {
  const base = { toolCalls: [call("b1", "Bash", { command: "python3 build.py" })] };

  it("is_error:false against an errored paired result fails", () => {
    const r = one(
      { tool_called: { tool: "Bash", result: { is_error: false } } },
      ctx({ ...base, toolResults: [{ toolUseId: "b1", isError: true, text: "boom" }] }),
    );
    expect(r.pass).toBe(false);
  });

  it("matches / not_matches read the paired result's text", () => {
    const c = ctx({ ...base, toolResults: [{ toolUseId: "b1", isError: false, text: "OK wrote 3 files" }] });
    expect(one({ tool_called: { tool: "Bash", result: { matches: "^OK", not_matches: "Traceback" } } }, c).pass).toBe(true);
    expect(one({ tool_called: { tool: "Bash", result: { matches: "Traceback" } } }, c).pass).toBe(false);
  });

  it("an UNPAIRED candidate never satisfies a result predicate — positive → evidence unavailable, not 'not called'", () => {
    const r = one({ tool_called: { tool: "Bash", result: { is_error: false } } }, ctx({ ...base, toolResults: [] }));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/evidence unavailable/);
  });

  it("a negative with an unpaired candidate → evidence unavailable, never a pass", () => {
    const r = one({ tool_not_called: { tool: "Bash", result: { is_error: true } } }, ctx({ ...base, toolResults: [] }));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/evidence unavailable/);
  });
});

describe("truncation fails closed", () => {
  const base = { toolCalls: [call("b1", "Bash", { command: "python3 build.py" })] };
  const truncated = [{ toolUseId: "b1", isError: false, text: "x".repeat(100), assertTextTruncated: true }];

  it("a positive not_matches over a TRUNCATED paired result → evidence unavailable (the match may sit past the cut)", () => {
    const r = one({ tool_called: { tool: "Bash", result: { not_matches: "Traceback" } } }, ctx({ ...base, toolResults: truncated }));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/evidence unavailable/);
  });

  it("a negative whose result predicate missed on a TRUNCATED result → evidence unavailable", () => {
    const r = one({ tool_not_called: { tool: "Bash", result: { matches: "Traceback" } } }, ctx({ ...base, toolResults: truncated }));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/evidence unavailable/);
  });

  it("a positive matches MISS on a truncated result → evidence unavailable; a HIT still passes", () => {
    const miss = one({ tool_called: { tool: "Bash", result: { matches: "Traceback" } } }, ctx({ ...base, toolResults: truncated }));
    expect(miss.message).toMatch(/evidence unavailable/);
    expect(one({ tool_called: { tool: "Bash", result: { matches: "^x+$" } } }, ctx({ ...base, toolResults: truncated })).pass).toBe(true);
  });

  it("a negative input regex that misses a TRUNCATED input field → evidence unavailable", () => {
    const c = ctx({
      toolCalls: [{ toolUseId: "w1", name: "Write", input: { content: { text: "a".repeat(50), truncated: true } }, origin: "main" }],
      toolResults: [{ toolUseId: "w1", isError: false, text: "" }],
    });
    const r = one({ tool_not_called: { tool: "Write", input: { content: "SECRET" } } }, c);
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/evidence unavailable/);
  });
});

describe("missing evidence (old result.json / hand-built ctx) fails closed", () => {
  it("toolCallsMissing → evidence unavailable for both directions of the object form", () => {
    const c = ctx({ toolCalls: undefined, toolCallsMissing: true, toolsCalled: new Set(["Bash"]) });
    for (const a of [
      { tool_called: { tool: "Bash", input: { command: "x" } } },
      { tool_not_called: { tool: "Bash", input: { command: "x" } } },
    ]) {
      const r = one(a, c);
      expect(r.pass).toBe(false);
      expect(r.message).toMatch(/evidence unavailable/);
    }
  });

  it("equivalence: {tool: X} is routed to the string evaluator, so it still works without toolCalls", () => {
    const c = ctx({ toolCalls: undefined, toolCallsMissing: true, toolsCalled: new Set(["Bash"]) });
    expect(one({ tool_called: { tool: "Bash" } }, c).pass).toBe(one({ tool_called: "Bash" }, c).pass);
    expect(one({ tool_called: { tool: "Bash" } }, c).pass).toBe(true);
    expect(one({ tool_not_called: { tool: "Write" } }, c).pass).toBe(one({ tool_not_called: "Write" }, c).pass);
    expect(one({ tool_not_called: { tool: ["Write", "Bash"] } }, c).pass).toBe(false);
  });
});

// ---- scope: the classifier's output on synthetic streams -------------------------------------------

class MockSession implements AgentSession {
  constructor(private events: AgentEvent[]) {}
  async *start(): AsyncIterable<AgentEvent> {
    for (const e of this.events) yield e;
  }
  sendUserTurn() {}
  respond(_id: string, _r: DecisionResponse) {
    return { delivered: true };
  }
  close() {}
}
const drive = (events: AgentEvent[]) => new Run(new MockSession(events), new ScriptedDecider([])).drive("go");

const bash = (id: string, command: string, parent?: string): AgentEvent => ({
  type: "tool_use",
  name: "Bash",
  input: { command },
  toolUseId: id,
  ...(parent ? { parentToolUseId: parent } : {}),
});
const ok = (id: string): AgentEvent => ({ type: "tool_result", toolUseId: id, isError: false, text: "ok" });
const dispatch = (id: string, type: string, parent?: string): AgentEvent[] => [
  {
    type: "tool_use",
    name: "Agent",
    input: { subagent_type: type, prompt: "p" },
    toolUseId: id,
    ...(parent ? { parentToolUseId: parent } : {}),
  },
  { type: "subagent_dispatch", toolUseId: id, parentToolUseId: parent, dispatchAgentType: type, declaredTools: [], typeOmitted: false },
];

describe("scope classifier (synthetic streams — pins the classifier, not the binary)", () => {
  const stream: AgentEvent[] = [
    bash("M1", "echo main-call"),
    ok("M1"),
    ...dispatch("A1", "researcher"),
    bash("S1", "echo child-call", "A1"),
    ok("S1"),
    ...dispatch("A2", "nested-writer", "A1"),
    bash("G1", "echo grandchild-call", "A2"),
    ok("G1"),
    bash("U1", "echo orphan-call", "NOT-A-DISPATCH"),
    ok("U1"),
    { type: "tool_use", name: "Skill", input: { skill: "inner" }, toolUseId: "K", parentToolUseId: "A1" },
    bash("KS", "echo skill-in-subagent-call", "K"),
    ok("KS"),
    { type: "tool_use", name: "Skill", input: { skill: "fork" }, toolUseId: "F" },
    bash("FB", "echo fork-call", "F"),
    ok("FB"),
  ];

  it("records every call once, with the one shared origin classifier", async () => {
    const rec = await drive(stream);
    const origin = Object.fromEntries(rec.toolCalls.map((t) => [t.toolUseId, t.origin]));
    expect(origin).toEqual({
      M1: "main",
      A1: "main",
      S1: "subagent",
      A2: "subagent",
      G1: "subagent", // a grandchild: its parent (A2) IS a dispatch this run recorded
      U1: "unknown", // parent is not a recorded dispatch
      K: "subagent",
      KS: "unknown", // a Skill invoked inside a sub-agent is not a dispatch — its children are unknown
      F: "main",
      FB: "main", // fork-scoped: a top-level Skill's children are main-agent flow
    });
    expect(rec.toolCalls.find((t) => t.toolUseId === "G1")?.parentToolUseId).toBe("A2");
  });

  it("fileToolAttempts and toolCalls agree on origin for every gated file-tool call (one classifier)", async () => {
    const read = (id: string, parent?: string): AgentEvent => ({
      type: "tool_use",
      name: "Read",
      input: { file_path: `outputs/${id}.md` },
      toolUseId: id,
      ...(parent ? { parentToolUseId: parent } : {}),
    });
    const rec = await drive([
      read("RM"), // main
      ...dispatch("A1", "researcher"),
      read("RS", "A1"), // subagent
      ...dispatch("A2", "nested", "A1"),
      read("RG", "A2"), // grandchild → subagent
      read("RU", "NOT-A-DISPATCH"), // unknown
      { type: "tool_use", name: "Skill", input: { skill: "fork" }, toolUseId: "F" },
      read("RF", "F"), // fork-scoped → main
    ]);
    const attempts = new Map(rec.fileToolAttempts.map((a) => [a.toolUseId, a.origin]));
    const calls = new Map(rec.toolCalls.filter((c) => c.name === "Read").map((c) => [c.toolUseId, c.origin]));
    expect([...attempts.keys()].sort()).toEqual(["RF", "RG", "RM", "RS", "RU"]);
    expect(Object.fromEntries(attempts)).toEqual(Object.fromEntries(calls));
    expect(Object.fromEntries(calls)).toEqual({ RM: "main", RS: "subagent", RG: "subagent", RU: "unknown", RF: "main" });
  });

  it("scope: main / subagent / any select the right calls; subagent_type matches the IMMEDIATE (nested) dispatch", async () => {
    const rec = await drive(stream);
    const c = ctx({
      toolCalls: rec.toolCalls,
      toolResults: rec.toolResults,
      subagents: rec.subagents,
      toolsCalled: rec.toolsCalled,
    });
    expect(one({ tool_called: { tool: "Bash", input: { command: "main-call" } } }, c).pass).toBe(true);
    expect(one({ tool_called: { tool: "Bash", input: { command: "fork-call" } } }, c).pass).toBe(true);
    expect(one({ tool_called: { tool: "Bash", input: { command: "child-call" }, scope: "subagent" } }, c).pass).toBe(true);
    expect(one({ tool_called: { tool: "Bash", input: { command: "grandchild-call" }, scope: "subagent" } }, c).pass).toBe(true);
    expect(
      one({ tool_called: { tool: "Bash", input: { command: "grandchild-call" }, scope: "subagent", subagent_type: "nested-writer" } }, c)
        .pass,
    ).toBe(true);
    expect(
      one({ tool_called: { tool: "Bash", input: { command: "grandchild-call" }, scope: "subagent", subagent_type: "researcher" } }, c).pass,
    ).toBe(false);
    // unknown origin is reachable only under `any`
    expect(one({ tool_called: { tool: "Bash", input: { command: "orphan-call" }, scope: "subagent" } }, c).pass).toBe(false);
    expect(one({ tool_called: { tool: "Bash", input: { command: "orphan-call" }, scope: "any" } }, c).pass).toBe(true);
    expect(one({ tool_called: { tool: "Bash", input: { command: "skill-in-subagent-call" }, scope: "any" } }, c).pass).toBe(true);
  });

  it("a sub-agent call under the default scope fails and NAMES the out-of-scope match", async () => {
    const rec = await drive(stream);
    const c = ctx({ toolCalls: rec.toolCalls, toolResults: rec.toolResults, subagents: rec.subagents });
    const r = one({ tool_called: { tool: "Bash", input: { command: "echo child-call" } } }, c);
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/1 matching call in scope subagent/);
    expect(r.message).toMatch(/scope: any/);
    // and the negative form at default scope does NOT see it (documented surprise, named in docs)
    expect(one({ tool_not_called: { tool: "Bash", input: { command: "echo child-call" } } }, c).pass).toBe(true);
    expect(one({ tool_not_called: { tool: "Bash", input: { command: "echo child-call" }, scope: "any" } }, c).pass).toBe(false);
  });

  it("the synthetic MCP echo is excluded", async () => {
    const rec = await drive([{ type: "tool_use", name: "mcp__x__y", input: { a: "1" }, toolUseId: "E", synthetic: true }]);
    expect(rec.toolCalls).toEqual([]);
  });

  it("input fields are capped at 10 KB with a truncated flag; non-string fields are JSON-stringified", async () => {
    const rec = await drive([
      { type: "tool_use", name: "Write", input: { file_path: "outputs/a.md", content: "z".repeat(20_000), n: 3 }, toolUseId: "W" },
    ]);
    const w = rec.toolCalls[0];
    expect(w.input.file_path).toEqual({ text: "outputs/a.md" });
    expect(w.input.content.truncated).toBe(true);
    expect(w.input.content.text.length).toBe(10_240);
    expect(w.input.n).toEqual({ text: "3" });
  });
});

describe("empty predicates are no predicates", () => {
  // `input: {}` / `result: {}` / `count: {}` constrain nothing — an empty conjunction is true — so the
  // form is `{tool: X}` and is routed to the string evaluator, which works on every lane (including a
  // result.json that predates toolCalls).
  const c = ctx({ toolCalls: undefined, toolCallsMissing: true, toolsCalled: new Set(["Bash"]) });
  it.each([
    [{ tool_called: { tool: "Bash", input: {} } }, true],
    [{ tool_called: { tool: "Bash", result: {} } }, true],
    [{ tool_called: { tool: "Bash", count: {} } }, true],
    [{ tool_called: { tool: "Bash", input: {}, result: {}, scope: "main" } }, true],
    [{ tool_not_called: { tool: "Bash", input: {} } }, false],
  ])("%j routes to the string evaluator", (a, expected) => {
    expect(one(a, c).pass).toBe(expected);
  });
});

describe("count: {min: 0} evidence", () => {
  it("says what satisfied the check when nothing had to", () => {
    const r = one(
      { tool_called: { tool: "Bash", input: { command: "nope" }, count: { min: 0 } } },
      ctx({ toolCalls: [call("b1", "Bash", { command: "ls" })] }),
    );
    expect(r.pass).toBe(true);
    expect((r as { evidence?: string }).evidence).toMatch(/0 .*count\.min 0.*1 name-matching call/);
  });
});

describe("negative pass evidence separates what was checked from what was not", () => {
  it("reports in-scope and out-of-scope counts, and how to include the rest", () => {
    const c = ctx({
      toolCalls: [call("m1", "Bash", { command: "ls" }), call("s1", "Bash", { command: "rm -rf x" }, "subagent", "A")],
      toolResults: [],
    });
    const r = one({ tool_not_called: { tool: "Bash", input: { command: "rm\\s+-rf" } } }, c);
    expect(r.pass).toBe(true);
    const ev = (r as { evidence?: string }).evidence ?? "";
    expect(ev).toMatch(/1 in scope main/);
    expect(ev).toMatch(/1 sub-?agent call not checked/);
    expect(ev).toMatch(/scope: any/);
  });
});

describe("count: min > max is refused at load", () => {
  it("rejects min > max, accepts min == max", () => {
    expect(AssertionSchema.safeParse({ tool_called: { tool: "Bash", count: { min: 3, max: 1 } } }).success).toBe(false);
    expect(AssertionSchema.safeParse({ tool_called: { tool: "Bash", count: { min: 2, max: 2 } } }).success).toBe(true);
  });
});
