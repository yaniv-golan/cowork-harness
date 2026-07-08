import { describe, it, expect } from "vitest";
import { Run } from "../src/run/run.js";
import type { AgentEvent, AgentSession, DecisionResponse } from "../src/agent/session.js";
import { ScriptedDecider } from "../src/decide/decider.js";

// Minimal in-memory session that yields a scripted event sequence (mirrors classify-result-error.test.ts).
class MockSession implements AgentSession {
  constructor(private events: AgentEvent[]) {}
  async *start(): AsyncIterable<AgentEvent> {
    for (const e of this.events) yield e;
  }
  sendUserTurn() {}
  respond(_id: string, _r: DecisionResponse) { return { delivered: true }; }
  close() {}
}

// A live-faithful AskUserQuestion gate arrives on TWO channels: (1) an assistant `tool_use` block named
// AskUserQuestion (which populates toolLog), and (2) a can_use_tool control_request (the `decision` event the
// decider answers). Tests MUST inject BOTH — injecting only the decision leaves toolLog empty and exercises a
// different code path than production.
const gateToolUse = (toolUseId = "toolu_g"): AgentEvent => ({
  type: "tool_use",
  name: "AskUserQuestion",
  input: { questions: [{ question: "What are the two founders' names?", options: [{ label: "Use anonymized names" }] }] },
  toolUseId,
});
const gateDecision = (toolUseId = "toolu_g"): AgentEvent => ({
  type: "decision",
  request: {
    id: "g1",
    kind: "question",
    questions: [{ question: "What are the two founders' names?", options: [{ label: "Use anonymized names" }] }],
    toolUseId,
  },
});
// A scripted decider that answers the founders gate so the run is genuinely "gate answered" (not unanswered →
// on_unanswered, a different axis).
const decider = () => new ScriptedDecider([{ when_question: "founders", choose: "Use anonymized names" }]);
const drive = (events: AgentEvent[]) => new Run(new MockSession(events), decider()).drive("go");

describe("stall-on-question detector", () => {
  it("answered a gate, did productive work BEFORE it, then re-asked in plain text → stalled", async () => {
    const rec = await drive([
      { type: "tool_use", name: "Read", input: {} }, // productive work BEFORE the gate
      gateToolUse(),
      gateDecision(),
      { type: "assistant_text", text: "The notes field didn't come through — could you type the two founders' names here?" },
      { type: "result", isError: false },
    ]);
    expect(rec.result).toBe("success");
    expect(rec.stalledOnQuestion).toBe(true);
    // Lock the load-bearing premise: the gate entered the tool_use path (→ toolLog), so it is not the absence
    // of the gate that makes productiveAfterGate 0 — it is the absence of productive work AFTER it.
    expect(rec.toolCounts["AskUserQuestion"]).toBe(1);
  });

  it("legit gated completion: answered a gate, then did productive work AFTER it, ends on a question → NOT stalled", async () => {
    const rec = await drive([
      gateToolUse(),
      gateDecision(),
      { type: "tool_use", name: "Write", input: {} }, // productive work AFTER the gate
      { type: "assistant_text", text: "Done — anything else you'd like me to cover?" },
      { type: "result", isError: false },
    ]);
    expect(rec.result).toBe("success");
    expect(rec.stalledOnQuestion).toBeFalsy();
  });

  it("unchanged: no gate, no tools, ends on a question → stalled", async () => {
    const rec = await drive([
      { type: "assistant_text", text: "Which file did you mean?" },
      { type: "result", isError: false },
    ]);
    expect(rec.result).toBe("success");
    expect(rec.stalledOnQuestion).toBe(true);
  });

  it("subagent post-gate work does NOT false-flag: gate → top-level Agent + parented tool → ends on a question → NOT stalled", async () => {
    const rec = await drive([
      gateToolUse(),
      gateDecision(),
      { type: "tool_use", name: "Agent", input: { subagent_type: "researcher" }, toolUseId: "tu-agent" }, // top-level dispatch AFTER the gate
      { type: "tool_use", name: "Edit", input: {}, parentToolUseId: "tu-agent" }, // work inside the subagent
      { type: "assistant_text", text: "Finished the analysis — want a deeper pass?" },
      { type: "result", isError: false },
    ]);
    expect(rec.result).toBe("success");
    expect(rec.stalledOnQuestion).toBeFalsy();
  });

  it("gate-only run that ends on a question with no productive work → stalled (the intended new behavior)", async () => {
    const rec = await drive([
      gateToolUse(),
      gateDecision(),
      { type: "assistant_text", text: "Anything else I should clarify before I start?" },
      { type: "result", isError: false },
    ]);
    expect(rec.result).toBe("success");
    expect(rec.stalledOnQuestion).toBe(true);
  });

  it("a run that ends on a NON-question after a gate is never flagged", async () => {
    const rec = await drive([
      gateToolUse(),
      gateDecision(),
      { type: "assistant_text", text: "All set — the report is written." },
      { type: "result", isError: false },
    ]);
    expect(rec.stalledOnQuestion).toBeFalsy();
  });

  // KNOWN LIMIT (documented false positive): the detector is a tool-POSITION heuristic, not deliverable
  // detection. A deliverable produced BEFORE a final confirmation gate is not credited (it's not "after the
  // last gate"), so a write-then-confirm-then-question run IS flagged. Pinned so the behavior is intentional
  // and any future change is deliberate; the escape is `allow_stall` / a deliverable assertion.
  it("KNOWN FALSE POSITIVE: deliverable written BEFORE a final confirm gate, ends on a question → flagged", async () => {
    const rec = await drive([
      { type: "tool_use", name: "Write", input: {} }, // deliverable produced BEFORE the gate
      gateToolUse(),
      gateDecision(),
      { type: "assistant_text", text: "Done — want me to tweak anything else?" },
      { type: "result", isError: false },
    ]);
    expect(rec.result).toBe("success");
    expect(rec.stalledOnQuestion).toBe(true); // documented limitation, not a bug to "fix" by weakening the trigger
  });

  // A gate that arrives ONLY via the decision channel (no assistant tool_use block) is NOT in toolLog, so
  // lastIndexOf === -1 and the run is treated as the no-gate case. Live runs always emit BOTH channels paired,
  // so this shape is decision-only fixtures/cassettes; pinned so the no-gate reduction is intentional.
  it("decision-only gate (no tool_use block) ending on a question → treated as no-gate → flagged", async () => {
    const rec = await drive([
      gateDecision(), // decision channel only; no gateToolUse() → nothing in toolLog
      { type: "assistant_text", text: "Which founders did you mean?" },
      { type: "result", isError: false },
    ]);
    expect(rec.result).toBe("success");
    expect(rec.stalledOnQuestion).toBe(true);
  });

  // Isolates the safety claim: a PARENTED (subagent) tool entry after the gate, with no top-level tool
  // after it, still raises productiveAfterGate (run.ts pushes to toolLog unconditionally) → NOT flagged.
  it("a parented (subagent) tool after the gate alone clears the flag → NOT stalled", async () => {
    const rec = await drive([
      gateToolUse(),
      gateDecision(),
      { type: "tool_use", name: "Edit", input: {}, parentToolUseId: "tu-some-dispatch" }, // parented entry only
      { type: "assistant_text", text: "Updated — anything else?" },
      { type: "result", isError: false },
    ]);
    expect(rec.stalledOnQuestion).toBeFalsy();
  });
});
