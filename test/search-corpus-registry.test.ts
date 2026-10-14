import { describe, it, expect } from "vitest";
import { SearchRegistry, type RegistryInput } from "../src/search-corpus/registry.js";

const served = (query: string, o: Partial<RegistryInput> = {}): RegistryInput => ({
  agentId: null,
  route: "messages",
  verdict: "served",
  query,
  rounds: [{ match: "nearby", nscore: 0.6, sourceQuery: `${query} src`, recordId: "r1", sourceSkill: "s", urls: ["https://a"] }],
  retryKey: `k:${query}`,
  ...o,
});

describe("SearchRegistry: the interceptor's synchronous record of every intercepted request", () => {
  it("numbers logical requests per agent, from 1", () => {
    const r = new SearchRegistry();
    expect(r.record(served("a")).ordinal).toBe(1);
    expect(r.record(served("b", { agentId: "ag1" })).ordinal).toBe(1);
    expect(r.record(served("c")).ordinal).toBe(2);
    expect(r.record(served("d", { agentId: "ag1" })).ordinal).toBe(2);
  });

  it("the stream takes an entry by (query, domains): the earliest unconsumed one, once", () => {
    const r = new SearchRegistry();
    const a1 = r.record(served("a"));
    const a2 = r.record(served("a"));
    expect(r.take({ query: "a" })).toBe(a1);
    expect(r.take({ query: "a" })).toBe(a2);
    expect(r.take({ query: "a" })).toBeUndefined();
    expect(r.take({ query: "never asked" })).toBeUndefined();
  });

  it("the domain lists are part of the key; absent and empty are the same list", () => {
    const r = new SearchRegistry();
    const scoped = r.record(served("a", { allowedDomains: ["x.com"] }));
    const plain = r.record(served("a", { allowedDomains: [] }));
    expect(r.take({ query: "a" })).toBe(plain);
    expect(r.take({ query: "a", allowedDomains: ["y.com"] })).toBeUndefined();
    expect(r.take({ query: "a", allowedDomains: ["x.com"] })).toBe(scoped);
  });

  it("a miss and a refusal are entries like a serve; a keyless refusal is never taken by key", () => {
    const r = new SearchRegistry();
    const miss = r.record(served("m", { verdict: "miss", rounds: [] }));
    const keyless = r.record({ agentId: "ag1", route: "messages", verdict: "refused", query: null, rounds: [], retryKey: null });
    expect(r.take({ query: "m" })).toBe(miss);
    expect(r.unconsumed()).toEqual([keyless]);
  });

  it("folds a stream:false retry of the agent's previous request into it, and counts it", () => {
    const r = new SearchRegistry();
    const first = r.record(served("a", { retryKey: "same" }));
    expect(r.retryOf(null, "same")).toBe(first);
    expect(r.retryOf("ag1", "same")).toBeUndefined(); // another agent's request is never folded in
    expect(r.retryOf(null, "unseen")).toBeUndefined(); // a key the agent never sent is not a retry
    expect(r.counts().retriesFolded).toBe(1);
  });

  it("folds a retry into the agent's latest request with the same key, even with another request in flight between", () => {
    const r = new SearchRegistry();
    const a = r.record(served("a", { retryKey: "ka" }));
    r.record(served("b", { retryKey: "kb" }));
    expect(r.retryOf(null, "ka")).toBe(a);
  });

  it("records nothing after it is closed", () => {
    const r = new SearchRegistry();
    r.close();
    expect(r.closed).toBe(true);
    expect(() => r.record(served("late"))).toThrow(/closed/);
  });

  it("counts served, miss and refused per agent, never a folded retry twice", () => {
    const r = new SearchRegistry();
    r.record(served("a"));
    r.record(served("b", { verdict: "miss", rounds: [] }));
    r.record(served("c", { agentId: "ag1", verdict: "refused", rounds: [] }));
    r.retryOf(null, "k:b");
    expect(r.counts()).toEqual({
      requests: 3,
      served: 1,
      miss: 1,
      refused: 1,
      retriesFolded: 1,
      unfinished: 0,
      byAgent: { main: { served: 1, miss: 1, refused: 0 }, ag1: { served: 0, miss: 0, refused: 1 } },
    });
  });

  it("tracks requests still classifying, so quiesce can wait for them, and names the unfinished", () => {
    const r = new SearchRegistry();
    const t1 = r.begin();
    const t2 = r.begin();
    expect(r.pending()).toBe(2);
    r.end(t1);
    expect(r.pending()).toBe(1);
    const unfinished = r.abandonPending();
    expect(unfinished).toBe(1);
    expect(r.pending()).toBe(0);
    r.end(t2); // a late end after abandoning is harmless
    expect(r.counts()).toMatchObject({ requests: 1, unfinished: 1, served: 0, miss: 0, refused: 0 });
  });

  it("returns entries in record order and never hands out a mutable copy of the input", () => {
    const r = new SearchRegistry();
    const input = served("a");
    const e = r.record(input);
    input.query = "changed";
    expect(e.query).toBe("a");
    expect(r.all().map((x) => x.query)).toEqual(["a"]);
  });
});
