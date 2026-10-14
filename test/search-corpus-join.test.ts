import { describe, it, expect } from "vitest";
import { SearchRegistry, type RegistryInput, type FrameRound } from "../src/search-corpus/registry.js";
import { joinCalls, dispatchAgentIds } from "../src/search-corpus/join.js";
import { ServeFrames, type FramePairing } from "../src/search-corpus/frames.js";
import { renderWebSearchResult } from "../src/search-corpus/render.js";
import { readChildTranscripts, turnsFromEvents } from "../src/hillclimb/trace.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
    const j = joinCalls({ entries: r.all(), pairings: [pair("t1", e)], dispatchAgents: new Map(), miss: "empty" });
    expect(j.calls).toEqual([{ toolUseId: "t1", query: "q", verdict: "served", ordinal: 1, rounds: [round("r1")] }]);
    expect(j).toMatchObject({ reassigned: 0, unattributed: 0, unattributedExpected: 0, attributionUncertain: 0 });
  });

  it("a sub-agent's call carries its agent id; its pairing is confirmed when the dispatch's agent matches", () => {
    const r = new SearchRegistry();
    const e = r.record(input("ag1", "q"));
    const j = joinCalls({
      entries: r.all(),
      pairings: [pair("c1", e, "task1")],
      dispatchAgents: new Map([["task1", "ag1"]]),
      miss: "empty",
    });
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
      miss: "empty",
    });
    expect(j.calls.map((c) => [c.agentId, c.toolUseId, c.reassignedFrom])).toEqual([
      ["agA", "cA", { agentId: "agB", ordinal: 1 }],
      ["agB", "cB", { agentId: "agA", ordinal: 1 }],
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
      miss: "error",
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
    const lone = joinCalls({ entries: r.all(), pairings: [pair("c1", e, "task1")], dispatchAgents: new Map(), miss: "empty" });
    expect(lone.calls[0]).toMatchObject({ agentId: "ag1", toolUseId: "c1", provisional: true });
    expect(lone).toMatchObject({ unattributed: 1, attributionUncertain: 0 });
    // envelopes did resolve agents, yet none of them is this frame's: a renamed id would look like this
    const odd = joinCalls({
      entries: r.all(),
      pairings: [pair("c1", e, "task1")],
      dispatchAgents: new Map([["task9", "ag9"]]),
      miss: "empty",
    });
    expect(odd).toMatchObject({ unattributed: 1, attributionUncertain: 1 });
  });

  it("an unpaired result is its own call, unattributed; a keyless refusal is expected unattributed, never uncertain", () => {
    const r = new SearchRegistry();
    r.record(input("ag1", null, { verdict: "refused", rounds: [] }));
    const j = joinCalls({ entries: r.all(), pairings: [pair("x", undefined)], dispatchAgents: new Map(), miss: "empty" });
    expect(j.calls).toContainEqual({ toolUseId: "x", unpaired: true });
    expect(j.calls).toContainEqual({ agentId: "ag1", query: null, verdict: "refused", ordinal: 1, rounds: [] });
    expect(j).toMatchObject({ unattributed: 1, unattributedExpected: 1, attributionUncertain: 0 });
  });

  it("a request no result streamed for (a deeper sub-agent's) is a call with its agent and no tool_use; not unattributed", () => {
    const r = new SearchRegistry();
    r.record(input("ag2", "deep"));
    const j = joinCalls({ entries: r.all(), pairings: [], dispatchAgents: new Map(), miss: "empty" });
    expect(j.calls).toEqual([{ agentId: "ag2", query: "deep", verdict: "served", ordinal: 1, rounds: [round("r1")] }]);
    expect(j.unattributed).toBe(0);
  });
});

describe("joinCalls: no false moves, and no request left unmarked", () => {
  it("three sub-agents, same key, crossed by the stream: every request ends paired or marked provisional, never bare", () => {
    const r = new SearchRegistry();
    // one key serves one record; a refusal of it (a request that missed the predicate) differs by verdict
    const e = r.record(input("agX", "q"));
    const s = r.record(input("agZ", "q", { verdict: "refused", rounds: [] }));
    const t = r.record(input("agY", "q"));
    const dispatchAgents = new Map([
      ["tX", "agX"],
      ["tY", "agY"],
      ["tZ", "agZ"],
    ]);
    const j = joinCalls({
      entries: r.all(),
      pairings: [pair("cY", e, "tY", "unfenced"), pair("cX", s, "tX", "unfenced"), pair("cZ", t, "tZ", "unfenced")],
      dispatchAgents,
      miss: "empty",
    });
    for (const c of j.calls.filter((c) => c.query !== undefined))
      expect(c.toolUseId !== undefined || c.provisional === true, JSON.stringify(c)).toBe(true);
    // each tool_use is named at most once
    const ids = j.calls.map((c) => c.toolUseId).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
    expect(j.attributionUncertain).toBeGreaterThan(0);
    // unattributed counts exactly the calls marked provisional or unpaired
    expect(j.unattributed).toBe(j.calls.filter((c) => c.provisional || c.unpaired).length);
  });
  it("a stream pairing whose request cannot show the answer the result showed is not confirmed", () => {
    // The stream applies the same table, so this only guards the join against a pairing it did not make itself.
    const r = new SearchRegistry();
    const refused = r.record(input("ag1", "q", { verdict: "refused", rounds: [] }));
    r.record(input("ag1", "q", { verdict: "refused", rounds: [] }));
    const j = joinCalls({
      entries: r.all(),
      pairings: [pair("c1", refused, "t1", "served")],
      dispatchAgents: new Map([["t1", "ag1"]]),
      miss: "empty",
    });
    expect(j.calls.find((c) => c.toolUseId === "c1")?.provisional).toBe(true);
    expect(j).toMatchObject({ unattributed: 1, attributionUncertain: 1 });
  });

  it("one sub-agent: a stream pairing that is already right is confirmed, whatever the order of its requests", () => {
    const r = new SearchRegistry();
    const miss = r.record(input("ag1", "q", { verdict: "miss", rounds: [] }));
    const refused = r.record(input("ag1", "q", { verdict: "refused", rounds: [] }));
    // under --search-corpus-miss empty an error-shaped result can only be the refusal
    const j = joinCalls({
      entries: r.all(),
      pairings: [pair("c1", refused, "t1", "error"), pair("c2", miss, "t1", "empty")],
      dispatchAgents: new Map([["t1", "ag1"]]),
      miss: "empty",
    });
    expect(j).toMatchObject({ reassigned: 0, unattributed: 0, attributionUncertain: 0 });
    expect(j.calls.map((c) => c.toolUseId)).toEqual(["c2", "c1"]);
    // two served requests, one result read as unfenced: both stream pairings stand
    const r2 = new SearchRegistry();
    const a = r2.record(input("ag1", "q"));
    const b = r2.record(input("ag1", "q"));
    const j2 = joinCalls({
      entries: r2.all(),
      pairings: [pair("c1", a, "t1", "served"), pair("c2", b, "t1", "unfenced")],
      dispatchAgents: new Map([["t1", "ag1"]]),
      miss: "empty",
    });
    expect(j2).toMatchObject({ reassigned: 0, unattributed: 0, attributionUncertain: 0 });
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

describe("the join driven through the stream's own pairing", () => {
  it("two parallel sub-agents asking the same query: the stream crosses them, the join puts them back", () => {
    const r = new SearchRegistry();
    const frames = new ServeFrames({ registry: r, noRequest: undefined, pool, miss: "empty", quiesce: async () => ({ abandoned: 0 }) });
    // each sub-agent's request is intercepted (A first), then B's result streams first
    r.record(input("agA", "q"));
    r.record(input("agB", "q"));
    const served = renderWebSearchResult({
      query: "q",
      entries: [{ kind: "links", links: [{ title: "t", url: "https://r1" }] }],
      reminder: "REMINDER: x",
    });
    const use = (id: string, parent: string) => ({
      type: "assistant",
      parent_tool_use_id: parent,
      message: { content: [{ type: "tool_use", id, name: "WebSearch", input: { query: "q" } }] },
    });
    const res = (id: string, parent: string) => ({
      type: "user",
      parent_tool_use_id: parent,
      message: { content: [{ type: "tool_result", tool_use_id: id, content: served }] },
    });
    for (const m of [use("cA", "tA"), use("cB", "tB"), res("cB", "tB"), res("cA", "tA")]) frames.observe(m);
    const j = joinCalls({
      entries: r.all(),
      pairings: frames.pairings(),
      dispatchAgents: new Map([
        ["tA", "agA"],
        ["tB", "agB"],
      ]),
      miss: "empty",
    });
    expect(j.calls.map((c) => [c.agentId, c.toolUseId])).toEqual([
      ["agA", "cA"],
      ["agB", "cB"],
    ]);
    expect(j).toMatchObject({ reassigned: 2, unattributed: 0, attributionUncertain: 0 });
  });
});

describe("one derivation: the trace and the search join match a forked skill's transcript the same way", () => {
  it("the same parent stream and transcript give the trace's inlined fork and the join's dispatch agent", () => {
    const dir = join(import.meta.dirname, "fixtures", "hillclimb-runs", "forked-skill");
    const events = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n");
    const children = readChildTranscripts(join(dir, "subagents"));
    expect(children).toHaveLength(1);
    // the trace inlines the transcript under the Skill call
    const { turns } = turnsFromEvents({ events, prompt: "p", children, sidecarPrefix: "x/", redact: (t) => t });
    expect(turns.some((t) => t.role === "tool_call" && t.content.startsWith("[forked skill example-fork-skill#1] "))).toBe(true);
    // the join, with no envelope naming the agent, matches the same transcript to the same Skill call
    const m = dispatchAgentIds(events, [{ agentId: "synthetic0fork", lines: children[0]!.lines }]);
    expect([...m]).toEqual([["toolu_synthetic_skill_0001", "synthetic0fork"]]);
    // and with that transcript's tool ids gone, neither matches
    expect(dispatchAgentIds(events, [{ agentId: "synthetic0fork", lines: [] }]).size).toBe(0);
  });
});
