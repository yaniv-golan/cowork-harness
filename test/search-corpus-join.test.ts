import { describe, it, expect } from "vitest";
import { SearchRegistry, type RegistryInput, type FrameRound } from "../src/search-corpus/registry.js";
import { joinCalls, dispatchAgentIds } from "../src/search-corpus/join.js";
import type { FramePairing } from "../src/search-corpus/frames.js";

// The post-run join: one call per intercepted request, with the tool_use that asked for it. A main-loop pairing is
// final; a parented one is re-paired within its resolved agent, by key and the answer it shows, in result order.
const pool = { poolId: "p", sha256: "a".repeat(64) };
const round = (recordId: string, nscore = 1): FrameRound => ({
  match: "exact",
  nscore,
  sourceQuery: "q",
  recordId,
  sourceSkill: null,
  urls: [`https://${recordId}`],
});
const input = (agentId: string | null, query: string | null, o: Partial<RegistryInput> = {}): RegistryInput => ({
  agentId,
  route: "messages",
  verdict: "served",
  query,
  rounds: [round("r1")],
  retryKey: null,
  ...o,
});
const pair = (
  toolUseId: string,
  entry: ReturnType<SearchRegistry["record"]> | undefined,
  parent?: string,
  shape: FramePairing["shape"] = "served",
): FramePairing => ({
  toolUseId,
  ...(parent ? { parentToolUseId: parent } : {}),
  shape,
  ...(entry ? { entry } : {}),
});

describe("joinCalls", () => {
  it("one call per request; a main-loop pairing is final and names its tool_use", () => {
    const r = new SearchRegistry();
    const e = r.record(input(null, "q"));
    const j = joinCalls({ entries: r.all(), pairings: [pair("t1", e)], dispatchAgents: new Map() });
    expect(j.calls).toEqual([{ toolUseId: "t1", query: "q", verdict: "served", ordinal: 1, rounds: [round("r1")] }]);
    expect(j).toMatchObject({ reassigned: 0, unattributed: 0, unattributedExpected: 0, attributionUncertain: 0 });
  });

  it("a sub-agent's call carries its agent id; its pairing is confirmed when the dispatch's agent matches", () => {
    const r = new SearchRegistry();
    const e = r.record(input("ag1", "q"));
    const j = joinCalls({ entries: r.all(), pairings: [pair("c1", e, "task1")], dispatchAgents: new Map([["task1", "ag1"]]) });
    expect(j.calls[0]).toMatchObject({ agentId: "ag1", toolUseId: "c1", verdict: "served" });
    expect(j.calls[0]).not.toHaveProperty("provisional");
    expect(j.reassigned).toBe(0);
  });

  it("two parallel sub-agents with the same key: a crossed stream pairing is reassigned, counted, and never rewrites the frame", () => {
    const r = new SearchRegistry();
    const a = r.record(input("agA", "q"));
    const b = r.record(input("agB", "q"));
    // the stream gave A's result B's entry and B's result A's entry
    const j = joinCalls({
      entries: r.all(),
      pairings: [pair("cA", b, "taskA"), pair("cB", a, "taskB")],
      dispatchAgents: new Map([
        ["taskA", "agA"],
        ["taskB", "agB"],
      ]),
    });
    expect(j.calls.map((c) => [c.agentId, c.toolUseId, c.reassignedFrom])).toEqual([
      ["agA", "cA", 1],
      ["agB", "cB", 1],
    ]);
    expect(j).toMatchObject({ reassigned: 2, unattributed: 0, attributionUncertain: 0 });
  });

  it("the guard: a move between entries whose serve records differ is refused, counted unattributed and uncertain", () => {
    const r = new SearchRegistry();
    // under --search-corpus-miss error, a refusal and a miss for one key both show the error answer
    const a = r.record(input("agA", "q", { verdict: "miss", rounds: [] }));
    const b = r.record(input("agB", "q", { verdict: "refused", rounds: [] }));
    const j = joinCalls({
      entries: r.all(),
      pairings: [pair("cA", b, "taskA", "error"), pair("cB", a, "taskB", "error")],
      dispatchAgents: new Map([
        ["taskA", "agA"],
        ["taskB", "agB"],
      ]),
    });
    expect(j).toMatchObject({ reassigned: 0, unattributed: 2, attributionUncertain: 2 });
    // nothing moved: each entry keeps the stream's tool_use, marked provisional
    expect(j.calls.map((c) => [c.agentId, c.toolUseId, c.provisional])).toEqual([
      ["agA", "cB", true],
      ["agB", "cA", true],
    ]);
  });

  it("a parented pairing whose dispatch names no agent stays provisional and unattributed; with others resolved and none re-paired, uncertain", () => {
    const r = new SearchRegistry();
    const e = r.record(input("ag1", "q"));
    const lone = joinCalls({ entries: r.all(), pairings: [pair("c1", e, "task1")], dispatchAgents: new Map() });
    expect(lone.calls[0]).toMatchObject({ agentId: "ag1", toolUseId: "c1", provisional: true });
    expect(lone).toMatchObject({ unattributed: 1, attributionUncertain: 0 });
    // envelopes did resolve agents, yet none of them is this frame's: a renamed id would look like this
    const odd = joinCalls({ entries: r.all(), pairings: [pair("c1", e, "task1")], dispatchAgents: new Map([["task9", "ag9"]]) });
    expect(odd).toMatchObject({ unattributed: 1, attributionUncertain: 1 });
  });

  it("an unpaired result is its own call, unattributed; a keyless refusal is expected unattributed, never uncertain", () => {
    const r = new SearchRegistry();
    r.record(input("ag1", null, { verdict: "refused", rounds: [] }));
    const j = joinCalls({ entries: r.all(), pairings: [pair("x", undefined)], dispatchAgents: new Map() });
    expect(j.calls).toContainEqual({ toolUseId: "x", unpaired: true });
    expect(j.calls).toContainEqual({ agentId: "ag1", query: null, verdict: "refused", ordinal: 1, rounds: [] });
    expect(j).toMatchObject({ unattributed: 1, unattributedExpected: 1, attributionUncertain: 0 });
  });

  it("a request no result streamed for (a deeper sub-agent's) is a call with its agent and no tool_use; not unattributed", () => {
    const r = new SearchRegistry();
    r.record(input("ag2", "deep"));
    const j = joinCalls({ entries: r.all(), pairings: [], dispatchAgents: new Map() });
    expect(j.calls).toEqual([{ agentId: "ag2", query: "deep", verdict: "served", ordinal: 1, rounds: [round("r1")] }]);
    expect(j.unattributed).toBe(0);
  });
});

describe("dispatchAgentIds: the agent behind each dispatch, from the harness's own stream parser", () => {
  const env = (toolUseId: string, e: Record<string, unknown>) =>
    JSON.stringify({
      type: "user",
      tool_use_result: e,
      message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: "x" }] },
    });
  it("reads the dispatch result's agent id, an envelope carrying only that included (a forked skill's)", () => {
    const m = dispatchAgentIds([env("task1", { agentId: "ag1", status: "completed" }), env("skill1", { agentId: "ag2" }), "not json"], []);
    expect([...m]).toEqual([
      ["task1", "ag1"],
      ["skill1", "ag2"],
    ]);
  });
  it("falls back to the transcript that shares a tool id with the dispatch's parented events", () => {
    const parented = JSON.stringify({
      type: "assistant",
      parent_tool_use_id: "skill1",
      message: { content: [{ type: "tool_use", id: "w1", name: "WebSearch", input: {} }] },
    });
    const child = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "w1", name: "WebSearch", input: {} }] } }),
    ];
    expect([...dispatchAgentIds([parented], [{ agentId: "ag7", lines: child }])]).toEqual([["skill1", "ag7"]]);
    // an envelope wins over the fallback
    expect(dispatchAgentIds([parented, env("skill1", { agentId: "ag1" })], [{ agentId: "ag7", lines: child }]).get("skill1")).toBe("ag1");
  });
});
