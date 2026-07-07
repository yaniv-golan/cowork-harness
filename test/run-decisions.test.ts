import { describe, it, expect } from "vitest";
import type { AgentEvent, AgentSession, DecisionResponse } from "../src/agent/session.js";
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
  respond(id: string, r: DecisionResponse) {
    this.responded.push({ id, r });
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
