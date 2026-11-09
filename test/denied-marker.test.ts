import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentSession, DecisionRequest, DecisionResponse } from "../src/agent/session.js";
import { ABSTAIN, type Decider } from "../src/decide/decider.js";
import { replayCassette } from "../src/run/cassette.js";
import { makeRenderer, renderFooter, type RenderPlan } from "../src/run/renderer.js";
import { decisionRows, Run } from "../src/run/run.js";
import type { RunResult } from "../src/types.js";
import { withReplayContract } from "./helpers/minimal-cassette.js";

class MockSession implements AgentSession {
  undeliveredIds = new Set<string>();
  deliver = true;
  constructor(private events: AgentEvent[]) {}
  async *start(): AsyncIterable<AgentEvent> {
    for (const e of this.events) yield e;
  }
  sendUserTurn() {}
  respond(_id: string, _r: DecisionResponse) {
    return this.deliver ? { delivered: true } : { delivered: false, reason: "session-closing" as const };
  }
  hasUndeliveredReconciliation(id: string) {
    return this.undeliveredIds.has(id);
  }
  close() {}
}

const deny: DecisionResponse = { kind: "permission", behavior: "deny", message: "no" };
const decider = (r: DecisionResponse | typeof ABSTAIN): Decider => ({
  decide: async () => (r === ABSTAIN ? ABSTAIN : { response: r, by: "scripted" }),
});
const write = (toolUseId?: string): DecisionRequest => ({
  id: "req-1",
  kind: "permission",
  tool: "Write",
  input: { file_path: "/x" },
  toolUseId,
});
const stream = (req: DecisionRequest): AgentEvent[] => [
  { type: "tool_use", name: "Write", input: { file_path: "/x" }, toolUseId: "tu-1" },
  { type: "decision", request: req },
  { type: "result", isError: false },
];
const drive = (s: MockSession, d: Decider) => new Run(s, d).drive("go");

function footer(r: { decisions: RunResult["decisions"] }): string {
  const plan: RenderPlan = { live: false, progress: false, verbose: false, color: false, compact: false };
  let out = "";
  const result = { ...r, result: "success", fidelity: "protocol", assertions: [] } as unknown as RunResult;
  renderFooter(result, plan, { write: (s: string) => (out += s), renderer: makeRenderer(plan, () => {}) });
  return out;
}

describe("toolCalls[].denied and the summary's denied count", () => {
  it("a delivered deny marks its call, carries the tool id, and is counted", async () => {
    const r = await drive(new MockSession(stream(write("tu-1"))), decider(deny));
    expect(r.toolCalls[0]!.denied).toBe(true);
    expect(r.decisions[0]).toMatchObject({ decision: "deny", toolUseId: "tu-1" });
    expect(footer(r)).toContain("denied: 1");
  });

  it("the fail-closed deny of an unanswered ask marks its call", async () => {
    const r = await drive(new MockSession(stream(write("tu-1"))), decider(ABSTAIN));
    expect(r.decisions[0]!.decision).toBe("abstain→deny");
    expect(r.toolCalls[0]!.denied).toBe(true);
    expect(footer(r)).toContain("denied: 1");
  });

  it("a mismatched decider response, which the agent receives as a deny, marks its call", async () => {
    const r = await drive(new MockSession(stream(write("tu-1"))), decider({ kind: "question", answers: {} }));
    expect(r.decisions[0]).toMatchObject({ decision: "mismatch→deny", toolUseId: "tu-1" });
    expect(r.toolCalls[0]!.denied).toBe(true);
  });

  it("a deny whose frame later failed to write is reconciled to undelivered and leaves no mark", async () => {
    const s = new MockSession(stream(write("tu-1")));
    s.undeliveredIds.add("req-1");
    const r = await drive(s, decider(deny));
    expect(r.decisions[0]!.decision).toBe("undelivered");
    expect(r.toolCalls[0]!.denied).toBeUndefined();
    expect(footer(r)).not.toContain("denied:");
  });

  it("a mismatch deny can be reconciled too", async () => {
    const s = new MockSession(stream(write("tu-1")));
    s.undeliveredIds.add("req-1");
    const r = await drive(s, decider({ kind: "question", answers: {} }));
    expect(r.decisions[0]!.decision).toBe("undelivered");
    expect(r.toolCalls[0]!.denied).toBeUndefined();
  });

  it("a deny that could not be sent leaves no mark", async () => {
    const s = new MockSession(stream(write("tu-1")));
    s.deliver = false;
    const r = await drive(s, decider(deny));
    expect(r.decisions[0]).toMatchObject({ decision: "undelivered", toolUseId: "tu-1" });
    expect(r.toolCalls[0]!.denied).toBeUndefined();
    expect(footer(r)).not.toContain("denied:");
  });

  it("a request with no tool id cannot mark a call, and is still counted", async () => {
    const r = await drive(new MockSession(stream(write(undefined))), decider(deny));
    expect(r.toolCalls[0]!.denied).toBeUndefined();
    expect(footer(r)).toContain("denied: 1");
  });

  it("an allowed call stays unmarked, and the summary says nothing", async () => {
    const r = await drive(new MockSession(stream(write("tu-1"))), decider({ kind: "permission", behavior: "allow", updatedInput: {} }));
    expect(r.toolCalls[0]!.denied).toBeUndefined();
    expect(footer(r)).not.toContain("denied:");
  });

  it("a fail-closed answer to a request that is not a permission is not counted", async () => {
    const dialog: DecisionRequest = { id: "req-2", kind: "dialog", dialogKind: "x", payload: {} };
    const r = await drive(
      new MockSession([
        { type: "decision", request: dialog },
        { type: "result", isError: false },
      ]),
      decider(ABSTAIN),
    );
    expect(r.decisions[0]!.decision).toBe("abstain→deny");
    expect(footer(r)).not.toContain("denied:");
  });

  it("the rows a result carries keep the tool id", () => {
    expect(decisionRows([{ kind: "tool", name: "Write", decision: "deny", by: "scripted", toolUseId: "tu-1" }])[0]).toMatchObject({
      toolUseId: "tu-1",
    });
  });

  it("the replay lane marks and counts the same deny", async () => {
    const events = [
      JSON.stringify({ type: "system", subtype: "init", tools: ["Write"] }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "tu-1", name: "Write", input: { file_path: "/x" } }] },
      }),
      JSON.stringify({
        type: "control_request",
        request_id: "req-1",
        request: { subtype: "can_use_tool", tool_name: "Write", tool_use_id: "tu-1", input: { file_path: "/x" } },
      }),
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "tu-1", is_error: true, content: "denied" }] },
      }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ];
    const controlOut = [
      JSON.stringify({
        type: "control_response",
        response: { subtype: "success", request_id: "req-1", response: { behavior: "deny", message: "no" } },
      }),
    ];
    const cassette = {
      scenario: {
        name: "d",
        baseline: "latest",
        session: "(inline)",
        fidelity: "protocol" as const,
        prompt: "hi",
        answers: [],
        expect_denied: [],
        assert: [{ result: "success" }],
      },
      events,
      controlOut,
      preRunPaths: [],
      artifacts: [],
    } as any;
    const r = await replayCassette(withReplayContract(cassette), [], { notesSink: () => {} });
    expect(r.toolCalls?.[0]!.denied).toBe(true);
    expect(r.decisions[0]).toMatchObject({ decision: "deny", toolUseId: "tu-1" });
    expect(footer(r)).toContain("denied: 1");
  });
});
