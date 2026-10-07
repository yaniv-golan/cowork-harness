import { describe, it, expect } from "vitest";
import { Run } from "../src/run/run.js";
import { ScriptedDecider, ABSTAIN, type Decider } from "../src/decide/decider.js";
import type { AgentEvent, AgentSession, DecisionRequest, DecisionResponse, DecisionDelivery } from "../src/agent/session.js";

/** A scripted AgentSession that records every reply it is sent. */
class MockSession implements AgentSession {
  replies: Array<{ id: string; r: DecisionResponse }> = [];
  constructor(private events: AgentEvent[]) {}
  async *start(): AsyncIterable<AgentEvent> {
    for (const e of this.events) yield e;
  }
  sendUserTurn() {}
  respond(id: string, r: DecisionResponse): DecisionDelivery {
    this.replies.push({ id, r });
    return { delivered: true };
  }
  close() {}
}

const question: DecisionRequest = {
  id: "q1",
  kind: "question",
  questions: [{ question: "Proceed?", options: [{ label: "yes" }, { label: "no" }] }],
} as DecisionRequest;
const permission: DecisionRequest = { id: "p1", kind: "permission", tool: "Write", input: { file_path: "/x" } };
const elicit = { id: "e1", kind: "elicit", message: "x" } as unknown as DecisionRequest;

// A decider that would answer anything — proves the run never consults it under answer_channel: none.
const eager: Decider = {
  async decide(req) {
    if (req.kind === "question") return { response: { kind: "question", answers: { "Proceed?": "yes" } }, by: "scripted" };
    return { response: { kind: "permission", behavior: "allow" }, by: "scripted" };
  },
} as Decider;

describe("Run under answer_channel: none — a request that arrives anyway", () => {
  it.each([question, permission, elicit])("is refused, never decided, and ends the run in error (%s)", async (req) => {
    const s = new MockSession([{ type: "decision", request: req } as AgentEvent, { type: "result", isError: false } as AgentEvent]);
    const run = new Run(s, eager);
    run.disableAnswerChannel();
    const rec = await run.drive("go");
    expect(rec.decisions).toEqual([]);
    expect(rec.answerChannelViolations).toEqual([{ kind: req.kind, name: expect.any(String) }]);
    expect(rec.result).toBe("error");
    expect(rec.errorSource).toBe("answer_channel_violation");
    expect(s.replies).toHaveLength(1);
    const r = s.replies[0].r;
    // Fail-closed: never an allow, never a question answer.
    expect(r.kind === "question").toBe(false);
    if (r.kind === "permission") expect(r.behavior).toBe("deny");
    if (r.kind === "elicit") expect(r.action).toBe("decline");
  });

  it("with no request, the run ends as the agent ended it", async () => {
    const s = new MockSession([{ type: "result", isError: false } as AgentEvent]);
    const run = new Run(s, new ScriptedDecider([]));
    run.disableAnswerChannel();
    const rec = await run.drive("go");
    expect(rec.result).toBe("success");
    expect(rec.answerChannelViolations).toBeUndefined();
  });

  it("without disableAnswerChannel the same question is decided as today", async () => {
    const s = new MockSession([{ type: "decision", request: question } as AgentEvent, { type: "result", isError: false } as AgentEvent]);
    const rec = await new Run(s, eager).drive("go");
    expect(rec.answerChannelViolations).toBeUndefined();
    expect(rec.decisions).toHaveLength(1);
  });
});
void ABSTAIN;
