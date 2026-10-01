import { describe, it, expect } from "vitest";
import { parseMessage, type AgentEvent, type AgentSession, type DecisionResponse, type DecisionDelivery } from "../src/agent/session.js";
import { Run } from "../src/run/run.js";
import { ScriptedDecider } from "../src/decide/decider.js";
import { evaluate, runSemanticJudges, toolResultEvidence, type AssertContext, type SemanticJudge } from "../src/assert.js";
import { SKILL_RESULT_ASSERT_CAP, type Assertion } from "../src/types.js";

// A main-agent `Skill` result — where a foreground `context: fork` skill's WHOLE answer arrives — is captured
// at SKILL_RESULT_ASSERT_CAP; every other tool result keeps the 10,240-char assert cap. Driven through the REAL
// stream-json parser and the real Run, so the cap is tested where it is applied, not on a hand-built record.

class MockSession implements AgentSession {
  constructor(private events: AgentEvent[]) {}
  async *start(): AsyncIterable<AgentEvent> {
    for (const e of this.events) yield e;
  }
  sendUserTurn() {}
  respond(_id: string, _r: DecisionResponse): DecisionDelivery {
    return { delivered: true };
  }
  close() {}
}

const ASSERT_CAP = 10_240;
const toolUse = (id: string, name: string, input: Record<string, unknown>, parent?: string) => ({
  type: "assistant",
  ...(parent ? { parent_tool_use_id: parent } : {}),
  message: { content: [{ type: "tool_use", id, name, input }] },
});
const toolResult = (id: string, content: string) => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: id, content }] },
});
const forkAnswer = (skill: string, chars: number): string => {
  const head = `Skill "${skill}" completed (forked execution).\n\nResult:\nHEAD-SENTINEL `;
  const tail = " TAIL-SENTINEL";
  return head + "a".repeat(chars - head.length - tail.length) + tail;
};

async function drive(frames: unknown[]) {
  const events = [...frames.flatMap((f) => parseMessage(f)), { type: "result", isError: false } as AgentEvent];
  return new Run(new MockSession(events), new ScriptedDecider([])).drive("go");
}

describe("capture cap for main-agent Skill results", () => {
  it("the cap is larger than the generic assert cap and fits the judged document's per-answer budget", () => {
    expect(SKILL_RESULT_ASSERT_CAP).toBe(32_768);
    expect(SKILL_RESULT_ASSERT_CAP).toBeGreaterThan(ASSERT_CAP);
  });

  it("a Skill result between 10,240 and the Skill cap is kept WHOLE and grades without refusal", async () => {
    const text = forkAnswer("plug:long", 20_000);
    const rec = await drive([toolUse("s1", "Skill", { skill: "plug:long" }), toolResult("s1", text)]);
    const tr = rec.toolResults.find((r) => r.toolUseId === "s1")!;
    expect(tr.assertText).toBe(text);
    expect(tr.assertTextTruncated).toBe(false);

    const judge: SemanticJudge = async (rubric, answer) => rubric.map((claim, index) => ({ index, claim, pass: answer.includes(claim) }));
    const a: Assertion = { semantic_matches: { rubric: ["HEAD-SENTINEL", "TAIL-SENTINEL"], include_fork_results: true } };
    const ctx = {
      transcript: "",
      toolsCalled: new Set<string>(),
      subagentTools: new Set<string>(),
      egress: [],
      result: "success",
      workRoot: "/nonexistent",
      userVisiblePrefixes: ["outputs"],
      outputsDeletes: [],
      questions: [],
      hostPathLeaked: false,
      selfHealRan: false,
      subagents: [],
      gateDeliveries: [],
      toolResultTexts: [],
      skillsInvoked: [],
      skillToolAvailable: true,
      slashInvokedSkills: [],
      toolCalls: rec.toolCalls,
      toolResults: rec.toolResults.map(toolResultEvidence),
    } as AssertContext;
    await runSemanticJudges([a], ctx, judge);
    const r = evaluate([a], ctx)[0];
    expect(r.pass).toBe(true);
    expect(r.semanticEvidence?.reason).toBe("graded");
  });

  it("a Skill result ABOVE the Skill cap is cut there and flagged — include_fork_results then refuses fork_result_truncated", async () => {
    const text = forkAnswer("plug:huge", SKILL_RESULT_ASSERT_CAP + 500);
    const rec = await drive([toolUse("s1", "Skill", { skill: "plug:huge" }), toolResult("s1", text)]);
    const tr = rec.toolResults.find((r) => r.toolUseId === "s1")!;
    expect(tr.assertText).toHaveLength(SKILL_RESULT_ASSERT_CAP);
    expect(tr.assertTextTruncated).toBe(true);
    expect(tr.text).toHaveLength(500); // the display value is untouched
  });

  it("a non-Skill tool result is still capped at 10,240 — including a fork's own child call", async () => {
    const long = "b".repeat(20_000);
    const rec = await drive([
      toolUse("s1", "Skill", { skill: "plug:x" }),
      toolUse("r1", "Read", { file_path: "/x" }, "s1"), // a fork child — main-agent flow, but not a Skill call
      toolResult("r1", long),
      toolUse("b1", "Bash", { command: "cat" }),
      toolResult("b1", long),
      toolResult("s1", forkAnswer("plug:x", 200)),
    ]);
    for (const id of ["r1", "b1"]) {
      const tr = rec.toolResults.find((r) => r.toolUseId === id)!;
      expect(tr.assertText).toHaveLength(ASSERT_CAP);
      expect(tr.assertTextTruncated).toBe(true);
    }
  });

  it("a Skill call made INSIDE a sub-agent keeps the 10,240 cap (only the main agent's Skill results widen)", async () => {
    const rec = await drive([
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "d1", name: "Agent", input: { subagent_type: "worker", prompt: "p", description: "w" } }],
        },
      },
      toolUse("s2", "Skill", { skill: "plug:inner" }, "d1"),
      toolResult("s2", forkAnswer("plug:inner", 20_000)),
    ]);
    const call = rec.toolCalls.find((c) => c.toolUseId === "s2")!;
    expect(call.origin).toBe("subagent");
    const tr = rec.toolResults.find((r) => r.toolUseId === "s2")!;
    expect(tr.assertText).toHaveLength(ASSERT_CAP);
    expect(tr.assertTextTruncated).toBe(true);
  });
});

describe("a Skill invoked INSIDE a fork is not the run's answer", () => {
  it("keeps the 10,240 cap at capture, although its origin is main (a fork's children inherit the main context)", async () => {
    const rec = await drive([
      toolUse("s1", "Skill", { skill: "plug:outer" }),
      toolUse("s2", "Skill", { skill: "plug:inner" }, "s1"), // parented under the outer fork
      toolResult("s2", forkAnswer("plug:inner", 15_000)),
      toolResult("s1", forkAnswer("plug:outer", 200)),
    ]);
    const inner = rec.toolCalls.find((c) => c.toolUseId === "s2")!;
    expect(inner.origin).toBe("main");
    expect(inner.parentToolUseId).toBe("s1");
    const tr = rec.toolResults.find((r) => r.toolUseId === "s2")!;
    expect(tr.assertText).toHaveLength(ASSERT_CAP);
    expect(tr.assertTextTruncated).toBe(true);
    expect(rec.toolResults.find((r) => r.toolUseId === "s1")!.assertTextTruncated).toBe(false);
  });
});

describe("the Skill-result cap holds on replay too (replay re-drives the frozen stream through the same parser)", () => {
  it("a 20,000-char main-agent Skill result is whole on replay; a same-size Bash result is cut at 10,240", async () => {
    const { replayCassette, CASSETTE_VERSION } = await import("../src/run/cassette.js");
    const { loadBaseline } = await import("../src/baseline.js");
    const skillText = forkAnswer("plug:long", 20_000);
    const bashText = "c".repeat(19_000) + " BASH-TAIL";
    const events = [
      { type: "system", subtype: "init", tools: [], skills: [] },
      toolUse("s1", "Skill", { skill: "plug:long" }),
      toolResult("s1", skillText),
      toolUse("b1", "Bash", { command: "cat" }),
      toolResult("b1", bashText),
      { type: "result", subtype: "success", is_error: false },
    ].map((f) => JSON.stringify(f));
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const r = await replayCassette({
        scenario: {
          name: "cap",
          baseline: "latest",
          session: "(inline)",
          fidelity: "container",
          prompt: "hi",
          answers: [],
          expect_denied: [],
          assert: [{ tool_result_contains: "TAIL-SENTINEL" }, { tool_result_contains: "BASH-TAIL" }],
        },
        events,
        controlOut: [],
        cassetteVersion: CASSETTE_VERSION,
        userVisibleRoots: ["outputs"],
        fingerprint: { baseline: loadBaseline("latest").appVersion },
      } as never);
      const s1 = r.toolResults!.find((t) => t.toolUseId === "s1")!;
      expect(s1.assertText).toBe(skillText);
      expect(s1.assertTextTruncated).toBe(false);
      expect(r.toolResults!.find((t) => t.toolUseId === "b1")!.assertText).toHaveLength(ASSERT_CAP);
      // Past 10,240 in the Skill result: seen on replay. Past 10,240 in the Bash result: not.
      expect(r.assertions!.map((a) => a.pass)).toEqual([true, false]);
    } finally {
      process.stderr.write = orig;
    }
  });
});
