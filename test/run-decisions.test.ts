import { describe, it, expect } from "vitest";
import type { AgentEvent, AgentSession, DecisionResponse, DecisionDelivery } from "../src/agent/session.js";
import { Run } from "../src/run/run.js";
import { ScriptedDecider } from "../src/decide/decider.js";

// Minimal in-memory AgentSession that replays a scripted event list (mirrors the MockSession
// pattern used to drive a Run over scripted decisions elsewhere in the test suite).
class MockSession implements AgentSession {
  responded: { id: string; r: DecisionResponse }[] = [];
  constructor(private events: AgentEvent[]) {}
  async *start(): AsyncIterable<AgentEvent> {
    for (const e of this.events) yield e;
  }
  sendUserTurn() {}
  respond(id: string, r: DecisionResponse): DecisionDelivery {
    this.responded.push({ id, r });
    return { delivered: true };
  }
  close() {}
}

describe("recordDecision — denied permission input", () => {
  it("a denied permission records the tool input in decisions[].detail", async () => {
    const ev: AgentEvent[] = [
      { type: "decision", request: { id: "d1", kind: "permission", tool: "Bash", input: { command: "rm -rf /outputs/secret" } } },
      { type: "result", isError: false },
    ];
    const rec = await new Run(new MockSession(ev), new ScriptedDecider([{ when_tool: "Bash", decide: "deny" }])).drive("go");

    const denied = rec.decisions.find((d) => d.kind === "tool" && d.decision === "deny");
    expect(denied).toBeDefined();
    expect(denied!.detail).toMatchObject({ input: expect.objectContaining({ command: "rm -rf /outputs/secret" }) });
  });

  it("an allowed permission leaves detail unset", async () => {
    const ev: AgentEvent[] = [
      { type: "decision", request: { id: "d1", kind: "permission", tool: "Write", input: { path: "out.txt" } } },
      { type: "result", isError: false },
    ];
    const rec = await new Run(new MockSession(ev), new ScriptedDecider([{ when_tool: "Write", decide: "allow" }])).drive("go");

    const allowed = rec.decisions.find((d) => d.kind === "tool" && d.decision === "allow");
    expect(allowed).toBeDefined();
    expect(allowed!.detail).toBeUndefined();
  });
});

describe("recordDecision — AskUserQuestion full option set", () => {
  it("records the full offered options (with descriptions) alongside the chosen answer", async () => {
    const ev: AgentEvent[] = [
      {
        type: "decision",
        request: {
          id: "d1",
          kind: "question",
          toolUseId: "toolu_q1",
          questions: [
            {
              question: "Which analyses should I run on this startup?",
              options: [
                { label: "Competitive positioning", description: "Map competitors and moat strength" },
                { label: "Market sizing", description: "TAM/SAM/SOM estimate" },
                { label: "IC simulation", description: "Simulate an investment committee debate" },
              ],
            },
          ],
        },
      },
      { type: "result", isError: false },
    ];
    const rec = await new Run(
      new MockSession(ev),
      new ScriptedDecider([{ when_question: "Which analyses", choose: "Market sizing" }]),
    ).drive("go");

    const answered = rec.decisions.find((d) => d.kind === "question");
    expect(answered).toBeDefined();
    expect(answered!.detail).toMatchObject({ "Which analyses should I run on this startup?": "Market sizing" });
    expect(answered!.questions).toEqual([
      {
        question: "Which analyses should I run on this startup?",
        options: [
          { label: "Competitive positioning", description: "Map competitors and moat strength" },
          { label: "Market sizing", description: "TAM/SAM/SOM estimate" },
          { label: "IC simulation", description: "Simulate an investment committee debate" },
        ],
      },
    ]);
  });
});

describe("recordDecision — undelivered answer (#20)", () => {
  // A session that reports the answer did NOT reach the agent (the live session was draining when
  // respond() ran). The run must record the truth ("undelivered"), never a false "answered".
  class ClosingSession extends MockSession {
    respond(_id: string, _r: DecisionResponse): DecisionDelivery {
      return { delivered: false, reason: "session-closing" };
    }
  }

  it("records 'undelivered', not 'answered', when respond() reports non-delivery", async () => {
    const ev: AgentEvent[] = [
      {
        type: "decision",
        request: { id: "d1", kind: "question", toolUseId: "toolu_q1", questions: [{ question: "Proceed?", options: [{ label: "Yes" }] }] },
      },
      { type: "result", isError: false },
    ];
    const rec = await new Run(new ClosingSession(ev), new ScriptedDecider([{ when_question: "Proceed", choose: "Yes" }])).drive("go");
    const q = rec.decisions.find((d) => d.kind === "question");
    expect(q).toBeDefined();
    expect(q!.decision).toBe("undelivered");
    expect(rec.decisions.some((d) => d.decision === "answered")).toBe(false);
  });
});

describe("F4 — gate-delivery reconciliation (respond()'s optimistic delivered:true vs. a later EPIPE)", () => {
  // Mirrors LiveAgentSession's real contract: respond() reports the control_response frame QUEUED
  // (`delivered:true`) synchronously, exactly like the real optimistic return — but the async stdin
  // write for it is later discovered to have failed (EPIPE), which `hasUndeliveredReconciliation`
  // reports for that decisionId once the stream has settled. `Run.drive()` must consult that ground
  // truth post-loop and flip the optimistic "answered"/`gateDeliveries[].delivered:true` down to
  // "undelivered"/`false` — never leave the optimistic claim standing.
  class EpipeSession extends MockSession {
    constructor(
      events: AgentEvent[],
      private undeliveredIds: Set<string>,
    ) {
      super(events);
    }
    respond(id: string, r: DecisionResponse): DecisionDelivery {
      this.responded.push({ id, r });
      return { delivered: true }; // optimistic — mirrors LiveAgentSession.respond()'s queued-not-confirmed contract
    }
    hasUndeliveredReconciliation(decisionId: string): boolean {
      return this.undeliveredIds.has(decisionId);
    }
  }

  it("flips a reconciled-undelivered gate's DecisionRecord to 'undelivered' and gateDeliveries[].delivered to false", async () => {
    const ev: AgentEvent[] = [
      {
        type: "decision",
        request: { id: "d1", kind: "question", toolUseId: "toolu_q1", questions: [{ question: "Proceed?", options: [{ label: "Yes" }] }] },
      },
      { type: "result", isError: false },
    ];
    const rec = await new Run(
      new EpipeSession(ev, new Set(["d1"])),
      new ScriptedDecider([{ when_question: "Proceed", choose: "Yes" }]),
    ).drive("go");

    // respond() reported delivered:true, so recordDecision() ran and initially pushed "answered" — the
    // post-loop reconciliation must have overridden it, not left the optimistic value standing.
    const q = rec.decisions.find((d) => d.kind === "question");
    expect(q).toBeDefined();
    expect(q!.decision).toBe("undelivered");
    expect(q!.rationale).toMatch(/epipe/i);

    const delivery = rec.gateDeliveries.find((g) => g.question === "Proceed?");
    expect(delivery).toBeDefined();
    expect(delivery!.delivered).toBe(false);
    expect(delivery!.reason).toBe("errored");
    expect(delivery!.error).toMatch(/epipe/i);
  });

  it("a clean (non-reconciled) delivery keeps 'answered' and gateDeliveries[].delivered:true", async () => {
    const ev: AgentEvent[] = [
      {
        type: "decision",
        request: { id: "d1", kind: "question", toolUseId: "toolu_q1", questions: [{ question: "Proceed?", options: [{ label: "Yes" }] }] },
      },
      { type: "tool_result", toolUseId: "toolu_q1", isError: false, text: "ok" },
      { type: "result", isError: false },
    ];
    // No ids in the undelivered set — hasUndeliveredReconciliation("d1") reports false, same as a real
    // write that never failed.
    const rec = await new Run(new EpipeSession(ev, new Set()), new ScriptedDecider([{ when_question: "Proceed", choose: "Yes" }])).drive(
      "go",
    );

    const q = rec.decisions.find((d) => d.kind === "question");
    expect(q).toBeDefined();
    expect(q!.decision).toBe("answered");

    const delivery = rec.gateDeliveries.find((g) => g.question === "Proceed?");
    expect(delivery).toBeDefined();
    expect(delivery!.delivered).toBe(true);
    expect(delivery!.reason).toBe("ok");
  });

  it("a MockSession with no hasUndeliveredReconciliation at all (replay/cassette shape) reconciles nothing", async () => {
    const ev: AgentEvent[] = [
      {
        type: "decision",
        request: { id: "d1", kind: "question", toolUseId: "toolu_q1", questions: [{ question: "Proceed?", options: [{ label: "Yes" }] }] },
      },
      { type: "tool_result", toolUseId: "toolu_q1", isError: false, text: "ok" },
      { type: "result", isError: false },
    ];
    const rec = await new Run(new MockSession(ev), new ScriptedDecider([{ when_question: "Proceed", choose: "Yes" }])).drive("go");
    const q = rec.decisions.find((d) => d.kind === "question");
    expect(q!.decision).toBe("answered");
    expect(rec.gateDeliveries.find((g) => g.question === "Proceed?")!.delivered).toBe(true);
  });
});
