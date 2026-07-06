import { describe, it, expect } from "vitest";
import { parseMessage } from "../src/agent/session.js";
import type { AgentEvent, AgentSession, DecisionResponse } from "../src/agent/session.js";
import { Run } from "../src/run/run.js";
import { ScriptedDecider } from "../src/decide/decider.js";

describe("parseMessage system-subtype catch-all", () => {
  it("emits system_event for an unrecognized system subtype", () => {
    // A real compact_boundary carries its payload at the TOP LEVEL of the system message,
    // and systemEventData strips only the type/subtype envelope — so `data` is the top-level rest.
    const evs = parseMessage({ type: "system", subtype: "compact_boundary", trigger: "auto" });
    expect(evs).toContainEqual({ type: "system_event", subtype: "compact_boundary", data: { trigger: "auto" } });
  });

  it("does NOT emit system_event for init/api_metrics/thinking", () => {
    for (const subtype of ["init", "api_metrics", "thinking"]) {
      const evs = parseMessage({ type: "system", subtype, content: "x", tools: [], skills: [] });
      expect(evs.some((e) => e.type === "system_event")).toBe(false);
    }
  });
});

// `translate()` is a private method on LiveAgentSession, so its two mcp_error emission paths
// (handler-threw, no-handler-configured) are exercised there directly. What's tested here is the
// ACCUMULATION side: a Run driven over a session that yields an mcp_error AgentEvent must fold it
// into rec.mcpErrors (mirrors the MockSession pattern used for decisions elsewhere in the suite).
class MockSession implements AgentSession {
  constructor(private events: AgentEvent[]) {}
  async *start(): AsyncIterable<AgentEvent> {
    for (const e of this.events) yield e;
  }
  sendUserTurn() {}
  respond(_id: string, _r: DecisionResponse) {}
  close() {}
}

describe("Run accumulates mcp_error events", () => {
  it("folds an mcp_error AgentEvent into rec.mcpErrors", async () => {
    const ev: AgentEvent[] = [
      { type: "mcp_error", server: "workspace", code: -32601, message: "no sdkMcp handler configured" },
      { type: "result", isError: false },
    ];
    const rec = await new Run(new MockSession(ev), new ScriptedDecider([])).drive("go");
    expect(rec.mcpErrors).toEqual([{ server: "workspace", code: -32601, message: "no sdkMcp handler configured" }]);
  });

  it("rec.mcpErrors is empty when no mcp_error event was seen", async () => {
    const ev: AgentEvent[] = [{ type: "result", isError: false }];
    const rec = await new Run(new MockSession(ev), new ScriptedDecider([])).drive("go");
    expect(rec.mcpErrors).toEqual([]);
  });
});
