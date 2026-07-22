import { describe, it, expect } from "vitest";
import { parseMessage, hookEventFrom } from "../src/agent/session.js";
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

  // WI-9 (docs/internal finding 3): the staged agent is 2.1.217, PAST the 2.1.216 VCS-event EMIT
  // floor, so a hostloop/cowork run now RECEIVES code_change_published / vcs_state_changed on the
  // stream. They are agent-side ungated and git-operation-driven (code_change_published fires on an
  // observed `gh pr create` PR URL; vcs_state_changed per commit/push/merge/rebase — independent
  // triggers). The harness is the consumer and models neither; this locks in that each degrades to a
  // recorded system_event and can NEVER be mistaken for a control_request (the only fail-closed path)
  // or dropped — so the run does not fail. NOTE: this is the deterministic HANDLING guarantee; a LIVE
  // scenario asserting emission must perform a real git action (a bare run emits nothing to degrade),
  // and must assert the two subtypes SEPARATELY because their triggers are independent.
  it("degrades code_change_published to a system_event (real wire shape), never a fail path", () => {
    const evs = parseMessage({
      type: "system",
      subtype: "code_change_published",
      url: "https://github.com/o/r/pull/1",
      provider: "github",
      repo: "o/r",
      identifier: "1",
    });
    expect(evs).toContainEqual({
      type: "system_event",
      subtype: "code_change_published",
      data: { url: "https://github.com/o/r/pull/1", provider: "github", repo: "o/r", identifier: "1" },
    });
    // never a control_request (the only subtype class that can hard-fail a run on non-recognition)
    expect(evs.every((e) => e.type !== "decision_request")).toBe(true);
  });

  it("degrades vcs_state_changed to a system_event (real wire shape), independently of the PR event", () => {
    const evs = parseMessage({ type: "system", subtype: "vcs_state_changed", kind: "commit", cwd: "/work/session" });
    expect(evs).toContainEqual({
      type: "system_event",
      subtype: "vcs_state_changed",
      data: { kind: "commit", cwd: "/work/session" },
    });
  });

  it("flags an assistant thinking block redacted when text is empty and a signature is present", () => {
    // The "omitted" display mode (API default on Opus 4.8 / Sonnet 5) returns empty thinking + signature.
    const evs = parseMessage({
      type: "assistant",
      message: { model: "claude-opus-4-8", content: [{ type: "thinking", thinking: "", signature: "sig-abc123" }] },
    });
    expect(evs).toContainEqual({ type: "thinking", text: "", model: "claude-opus-4-8", redacted: true });
  });

  it("does NOT flag a thinking block with real text, nor empty text without a signature", () => {
    const withText = parseMessage({
      type: "assistant",
      message: { model: "claude-sonnet-4-6", content: [{ type: "thinking", thinking: "a real thought", signature: "sig" }] },
    });
    expect(withText).toContainEqual({ type: "thinking", text: "a real thought", model: "claude-sonnet-4-6" });
    expect(withText.every((e) => !(e.type === "thinking" && "redacted" in e))).toBe(true);

    const emptyNoSig = parseMessage({
      type: "assistant",
      message: { model: "claude-sonnet-4-6", content: [{ type: "thinking", thinking: "" }] },
    });
    expect(emptyNoSig.every((e) => !(e.type === "thinking" && "redacted" in e))).toBe(true);
  });

  it("does NOT flag the system-subtype thinking event (no signature channel there)", () => {
    const evs = parseMessage({ type: "system", subtype: "thinking", content: "some system thinking" });
    expect(evs.every((e) => !(e.type === "thinking" && "redacted" in e))).toBe(true);
  });

  it("Item 1: parseMessage preserves api_error_status on a result event (so replay reclassifies usage_limit)", () => {
    // The replay re-drive re-parses the frozen raw events.jsonl through parseMessage, so api_error_status
    // must survive the parse for a recorded usage-limit run to re-classify identically on replay.
    const [ev] = parseMessage({
      type: "result",
      is_error: true,
      subtype: "success",
      api_error_status: 429,
      result: "You've hit your session limit · resets 4pm",
    });
    expect(ev).toMatchObject({ type: "result", isError: true, apiErrorStatus: 429, subtype: "success" });
    // a result with no api_error_status leaves it undefined (older binaries; not a spurious 0)
    const [ev2] = parseMessage({ type: "result", is_error: false });
    expect((ev2 as { apiErrorStatus?: number }).apiErrorStatus).toBeUndefined();
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
  respond(_id: string, _r: DecisionResponse) {
    return { delivered: true };
  }
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

// hookEventFrom is the single decision-reading rule shared by the live emit (translate()'s two
// hook_callback paths) and the replay reconstruction (replayCassette) — tested directly here so both
// callers are guaranteed to classify a block identically.
describe("hookEventFrom", () => {
  it("classifies the built-in Task hook's block reply as decision:block with the gated tool name", () => {
    const ev = hookEventFrom(
      "cowork-task-bg-block",
      { decision: "block", reason: "Background agents disabled" },
      { tool_name: "Task", tool_input: { run_in_background: true } },
    );
    expect(ev).toEqual({
      type: "hook_event",
      callbackId: "cowork-task-bg-block",
      decision: "block",
      reason: "Background agents disabled",
      tool: "Task",
    });
  });

  it("classifies an empty reply (allow) as decision:allow", () => {
    const ev = hookEventFrom("cowork-task-bg-block", {}, { tool_name: "Task" });
    expect(ev.decision).toBe("allow");
    expect(ev.reason).toBeUndefined();
  });

  it("classifies a custom hook's hookSpecificOutput.permissionDecision:deny as a block", () => {
    const ev = hookEventFrom(
      "custom-hook",
      { hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "path outside allowed roots" } },
      { tool_name: "Bash" },
    );
    expect(ev.decision).toBe("block");
    expect(ev.reason).toBe("path outside allowed roots");
    expect(ev.tool).toBe("Bash");
  });

  it("omits tool when input.tool_name is not a string", () => {
    const ev = hookEventFrom("x", {}, undefined);
    expect(ev.tool).toBeUndefined();
  });
});

describe("Run accumulates hook_event events", () => {
  it("folds a blocking hook_event AgentEvent into rec.hookEvents", async () => {
    const ev: AgentEvent[] = [
      { type: "hook_event", callbackId: "cowork-task-bg-block", decision: "block", reason: "Background agents disabled", tool: "Task" },
      { type: "result", isError: false },
    ];
    const rec = await new Run(new MockSession(ev), new ScriptedDecider([])).drive("go");
    expect(rec.hookEvents).toEqual([
      { callbackId: "cowork-task-bg-block", decision: "block", reason: "Background agents disabled", tool: "Task" },
    ]);
  });

  it("rec.hookEvents is empty when no hook_event was seen", async () => {
    const ev: AgentEvent[] = [{ type: "result", isError: false }];
    const rec = await new Run(new MockSession(ev), new ScriptedDecider([])).drive("go");
    expect(rec.hookEvents).toEqual([]);
  });
});
