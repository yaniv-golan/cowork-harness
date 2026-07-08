import { describe, it, expect } from "vitest";
import { Run, classifyResultError } from "../src/run/run.js";
import type { AgentEvent, AgentSession, DecisionResponse } from "../src/agent/session.js";
import { ScriptedDecider } from "../src/decide/decider.js";

// Minimal in-memory session that yields a scripted event sequence (mirrors seams.test.ts MockSession).
class MockSession implements AgentSession {
  constructor(private events: AgentEvent[]) {}
  async *start(): AsyncIterable<AgentEvent> {
    for (const e of this.events) yield e;
  }
  sendUserTurn() {}
  respond(_id: string, _r: DecisionResponse) { return { delivered: true }; }
  close() {}
}

describe("classifyResultError (transport vs agent)", () => {
  it("result-is_error path: transport iff the signature matches, NO prior-result gate", () => {
    expect(classifyResultError("result", "error_during_execution API Error: Connection closed", false)).toBe("transport");
    expect(classifyResultError("result", "socket hang up", false)).toBe("transport");
    // a genuine skill/agent error string is NOT transport
    expect(classifyResultError("result", "error_max_turns the model gave up", true)).toBe("agent");
  });

  it("exit path: transport ONLY after a clean result AND a transport stderr tail (else agent crash)", () => {
    expect(classifyResultError("exit", "agent process exited with code 1 — stderr tail: Connection closed", true)).toBe("transport");
    // nonzero exit with a transport tail but NO prior success → a crash, not a tail-end drop
    expect(classifyResultError("exit", "Connection closed", false)).toBe("agent");
    // nonzero exit after success but a non-transport crash tail → agent (preserve crash-is-failure)
    expect(classifyResultError("exit", "agent process exited with code 139 — stderr tail: segfault", true)).toBe("agent");
  });

  it("spawn/protocol are always agent (a real fault), even with a transport-looking message", () => {
    expect(classifyResultError("spawn", "fetch failed", true)).toBe("agent");
    expect(classifyResultError("protocol", "connection closed", true)).toBe("agent");
  });
});

describe("Run.drive sets rec.resultErrorKind end-to-end", () => {
  const drive = (events: AgentEvent[]) => new Run(new MockSession(events), new ScriptedDecider([])).drive("go");

  it("a transport-signatured is_error result → result:error + resultErrorKind:transport", async () => {
    const rec = await drive([
      { type: "result", isError: true, subtype: "error_during_execution", resultText: "API Error: Connection closed" },
    ]);
    expect(rec.result).toBe("error");
    expect(rec.resultErrorKind).toBe("transport");
  });

  it("a clean success result leaves resultErrorKind undefined", async () => {
    const rec = await drive([{ type: "result", isError: false }]);
    expect(rec.result).toBe("success");
    expect(rec.resultErrorKind).toBeUndefined();
  });

  it("multi-turn: turn-1 success, turn-2 transport is_error → transport (no prior-result gate on path a)", async () => {
    const turns = (async function* () {
      yield "turn 1";
      yield "turn 2";
    })();
    const rec = await new Run(
      new MockSession([
        { type: "result", isError: false },
        { type: "result", isError: true, resultText: "Connection closed mid-response" },
      ]),
      new ScriptedDecider([]),
    ).drive(turns);
    expect(rec.result).toBe("error");
    expect(rec.resultErrorKind).toBe("transport");
  });

  it("a nonzero exit AFTER a success result with a transport tail → transport (the issue's actual case)", async () => {
    const rec = await drive([
      { type: "result", isError: false },
      { type: "error", source: "exit", message: "agent process exited with code 1 — stderr tail: API Error: Connection closed" },
    ]);
    expect(rec.result).toBe("error");
    expect(rec.resultErrorKind).toBe("transport");
  });

  it("a nonzero exit WITHOUT a prior success → agent (a crash, not a tail-end drop)", async () => {
    const rec = await drive([
      { type: "error", source: "exit", message: "agent process exited with code 1 — stderr tail: Connection closed" },
    ]);
    expect(rec.result).toBe("error");
    expect(rec.resultErrorKind).toBe("agent");
  });

  it("captures errorSource from a fatal spawn error", async () => {
    const rec = await drive([{ type: "error", source: "spawn", message: "spawn failed" }]);
    expect(rec.errorSource).toBe("spawn");
  });

  it("captures errorSource from an is_error result (SDK-wrapped transport)", async () => {
    const rec = await drive([{ type: "result", isError: true, subtype: "error_during_execution", resultText: "connection closed" }]);
    expect(rec.errorSource).toBe("result");
  });
});

describe("WS-B: terminal-reason taxonomy (resultSubtype pass-through + no_result)", () => {
  const drive = (events: AgentEvent[]) => new Run(new MockSession(events), new ScriptedDecider([])).drive("go");

  it("no terminal event at all (turn/time exhaustion) → errorSource:'no_result'", async () => {
    // Empty stream: no result event, no error event. result stays the ctor default 'error'.
    const rec = await drive([]);
    expect(rec.result).toBe("error");
    expect(rec.errorSource).toBe("no_result");
  });

  it("passes through the SDK subtype on an is_error result (error_max_turns is now legible)", async () => {
    const rec = await drive([{ type: "result", isError: true, subtype: "error_max_turns", resultText: "the model gave up" }]);
    expect(rec.result).toBe("error");
    expect(rec.errorSource).toBe("result");
    expect(rec.resultSubtype).toBe("error_max_turns");
  });

  it("passes through the SDK subtype on a clean success result too", async () => {
    const rec = await drive([{ type: "result", isError: false, subtype: "success" }]);
    expect(rec.result).toBe("success");
    expect(rec.resultSubtype).toBe("success");
  });

  it("does NOT relabel a real error event as no_result (a fatal spawn keeps its source)", async () => {
    const rec = await drive([{ type: "error", source: "spawn", message: "spawn failed" }]);
    expect(rec.result).toBe("error");
    expect(rec.errorSource).toBe("spawn"); // not overwritten to no_result
  });
});
