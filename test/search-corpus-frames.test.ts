import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { ServeFrames } from "../src/search-corpus/frames.js";
import { SearchRegistry, type RegistryInput } from "../src/search-corpus/registry.js";
import { renderWebSearchResult } from "../src/search-corpus/render.js";

const h = (t: string) => ({ sha256: createHash("sha256").update(t, "utf8").digest("hex"), bytes: Buffer.byteLength(t) });
const MISSING = "Error: nothing to look up";
const noRequest = {
  missingQuery: h(MISSING),
  bothDomainLists: h("Error: both"),
  budgetPrefix: h("Search skipped: this "),
  budgetFragment: h(" is spent ("),
  inputValidationPrefix: h("Bad tool input here: "),
};
const IVE = "Bad tool input here: ";
const pool = { poolId: "p", sha256: "a".repeat(64) };
const round = { match: "nearby" as const, nscore: 0.7, sourceQuery: "src q", recordId: "r1", sourceSkill: "ms", urls: ["https://a"] };
const entry = (query: string, o: Partial<RegistryInput> = {}): RegistryInput => ({
  agentId: null,
  route: "messages",
  verdict: "served",
  query,
  rounds: [round],
  retryKey: `k:${query}`,
  ...o,
});

const use = (id: string, query: string, parent?: string, input: Record<string, unknown> = {}) => ({
  type: "assistant",
  ...(parent ? { parent_tool_use_id: parent } : {}),
  message: { content: [{ type: "tool_use", id, name: "WebSearch", input: { query, ...input } }] },
});
const result = (id: string, content: unknown, parent?: string, isError = false) => ({
  type: "user",
  ...(parent ? { parent_tool_use_id: parent } : {}),
  message: { content: [{ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] },
});
const served = (q: string) =>
  renderWebSearchResult({ query: q, entries: [{ kind: "links", links: [{ title: "t", url: "https://a" }] }], reminder: "REMINDER: x" });
const empty = (q: string) => renderWebSearchResult({ query: q, entries: [{ kind: "links", links: [] }], reminder: "REMINDER: x" });
// The agent's rendering of the harness's error answer (a miss under --search-corpus-miss error, or a refusal).
const errored = (q: string) =>
  renderWebSearchResult({ query: q, entries: [{ kind: "text", text: "Web search error: unavailable" }], reminder: "REMINDER: x" });
const parse = (lines: string[]) => lines.map((l) => JSON.parse(l));

function setup(miss: "empty" | "error" = "empty") {
  const registry = new SearchRegistry();
  const frames = new ServeFrames({ registry, noRequest, pool, miss, quiesce: async () => ({ abandoned: 0 }) });
  return { registry, frames };
}

describe("ServeFrames: one frame per intercepted request, written by the session stream", () => {
  it("frames a main-loop serve right after its tool_result, with the design's fields", () => {
    const { registry, frames } = setup();
    expect(frames.observe(use("t1", "ev market"))).toEqual([]);
    registry.record(entry("ev market"));
    const out = parse(frames.observe(result("t1", served("ev market"))));
    expect(out).toEqual([
      {
        _emu: "search_corpus_serve",
        streamed: true,
        toolUseId: "t1",
        query: "ev market",
        ordinal: 1,
        pool,
        verdict: "served",
        rounds: [round],
      },
    ]);
  });

  it("a parented (sub-agent) result carries its parent and is provisional (its agent is resolved after the run); the domain lists key the take", () => {
    const { registry, frames } = setup();
    frames.observe(use("c1", "q", "task1", { allowed_domains: ["x.com"] }));
    registry.record(entry("q", { agentId: "ag1" }));
    registry.record(entry("q", { agentId: "ag2", allowedDomains: ["x.com"] }));
    const [f] = parse(frames.observe(result("c1", served("q"), "task1")));
    expect(f).toMatchObject({ parentToolUseId: "task1", attribution: "provisional", allowedDomains: ["x.com"], query: "q" });
    expect(f).not.toHaveProperty("agentId");
    expect(registry.unconsumed().map((e) => e.agentId)).toEqual(["ag1"]);
  });

  it("a miss and a refusal are framed like a serve, each from the answer the agent shows", () => {
    const { registry, frames } = setup();
    frames.observe(use("m", "miss q"));
    frames.observe(use("r", "ref q"));
    registry.record(entry("miss q", { verdict: "miss", rounds: [] }));
    registry.record(entry("ref q", { verdict: "refused", rounds: [] }));
    expect(parse(frames.observe(result("m", empty("miss q"))))[0]).toMatchObject({ verdict: "miss", rounds: [] });
    expect(parse(frames.observe(result("r", errored("ref q"))))[0]).toMatchObject({ verdict: "refused" });
  });

  it("the fence: an unparented result takes only a main-loop entry, a parented one only a sub-agent's", () => {
    const { registry, frames } = setup();
    registry.record(entry("q", { agentId: "ag1" }));
    registry.record(entry("q"));
    frames.observe(use("m1", "q"));
    expect(parse(frames.observe(result("m1", served("q"))))[0]).toMatchObject({ ordinal: 1, verdict: "served" });
    expect(registry.unconsumed().map((e) => e.agentId)).toEqual(["ag1"]);
    // a second main-loop result with only a sub-agent's entry left is unpaired, never given that entry
    frames.observe(use("m2", "q"));
    expect(parse(frames.observe(result("m2", served("q"))))[0]).toEqual({
      _emu: "search_corpus_serve",
      streamed: true,
      toolUseId: "m2",
      query: "q",
      unpaired: true,
    });
    expect(registry.unconsumed().map((e) => e.agentId)).toEqual(["ag1"]);
    // and a parented result with only a main-loop entry left is unpaired too
    const b = setup();
    b.registry.record(entry("q"));
    b.frames.observe(use("c1", "q", "task1"));
    expect(parse(b.frames.observe(result("c1", served("q"), "task1")))[0]).toMatchObject({ unpaired: true, parentToolUseId: "task1" });
    expect(b.frames.counts()).toMatchObject({ unpaired: 1 });
  });

  it("the fence: the answer the agent shows picks the verdict (served, empty miss, error)", () => {
    const { registry, frames } = setup();
    registry.record(entry("q", { verdict: "refused", rounds: [] }));
    registry.record(entry("q", { verdict: "served" }));
    frames.observe(use("a", "q"));
    frames.observe(use("b", "q"));
    // the served result skips the earlier refused entry for the same key
    expect(parse(frames.observe(result("a", served("q"))))[0]).toMatchObject({ verdict: "served", ordinal: 2 });
    expect(parse(frames.observe(result("b", errored("q"))))[0]).toMatchObject({ verdict: "refused", ordinal: 1 });
    // an empty result never takes a refusal; an error result takes a miss only under --search-corpus-miss error
    const e = setup("empty");
    e.registry.record(entry("q", { verdict: "miss", rounds: [] }));
    e.frames.observe(use("x", "q"));
    expect(parse(e.frames.observe(result("x", errored("q"))))[0]).toMatchObject({ unpaired: true });
    const er = setup("error");
    er.registry.record(entry("q", { verdict: "miss", rounds: [] }));
    er.frames.observe(use("x", "q"));
    expect(parse(er.frames.observe(result("x", errored("q"))))[0]).toMatchObject({ verdict: "miss" });
  });

  it("a result whose answer cannot be read is fenced by key alone, and counted", () => {
    const { registry, frames } = setup();
    registry.record(entry("q", { verdict: "miss", rounds: [] }));
    frames.observe(use("x", "q"));
    expect(parse(frames.observe(result("x", "something the renderer never writes")))[0]).toMatchObject({ verdict: "miss" });
    expect(frames.counts()).toMatchObject({ shapeUnfenced: 1 });
  });

  it("a refused domain-filtered query is taken by its own key, so its result gets a streamed frame", () => {
    const { registry, frames } = setup();
    registry.record(entry("q", { verdict: "refused", rounds: [], allowedDomains: ["x.com"] }));
    frames.observe(use("r", "q", undefined, { allowed_domains: ["x.com"] }));
    expect(parse(frames.observe(result("r", errored("q"))))[0]).toMatchObject({
      streamed: true,
      verdict: "refused",
      allowedDomains: ["x.com"],
    });
    expect(registry.unconsumed()).toEqual([]);
  });

  it("counts every WebSearch tool_use, a query-less one included; only a result with a query can take an entry", () => {
    const { frames } = setup();
    frames.observe({ type: "assistant", message: { content: [{ type: "tool_use", id: "nq", name: "WebSearch", input: {} }] } });
    expect(frames.counts()).toMatchObject({ toolUses: 1 });
    expect(frames.observe(result("nq", "x"))).toEqual([]);
  });

  it("keeps each streamed frame's pairing for the post-run join", () => {
    const { registry, frames } = setup();
    registry.record(entry("q", { agentId: "ag1" }));
    frames.observe(use("c1", "q", "task1"));
    frames.observe(result("c1", served("q"), "task1"));
    const p = frames.pairings();
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ toolUseId: "c1", parentToolUseId: "task1", shape: "served", entry: { agentId: "ag1", ordinal: 1 } });
  });

  it("a no-request result (validation, harness denial) never takes an entry: the order case frames both serves", () => {
    const { registry, frames } = setup();
    for (const [id, q] of [
      ["s1", "q"],
      ["d", "q"],
      ["s2", "q"],
      ["v", "q"],
    ] as const)
      frames.observe(use(id, q));
    registry.record(entry("q"));
    registry.record(entry("q"));
    frames.denied("d");
    expect(frames.observe(result("s1", served("q")))).toHaveLength(1);
    expect(frames.observe(result("d", "<tool_use_error>The user declined.</tool_use_error>", undefined, true))).toEqual([]);
    expect(frames.observe(result("s2", served("q")))).toHaveLength(1);
    expect(frames.observe(result("v", `<tool_use_error>${MISSING}</tool_use_error>`, undefined, true))).toEqual([]);
    expect(registry.unconsumed()).toEqual([]);
    expect(frames.counts()).toMatchObject({ toolUses: 4, noRequest: 2 });
  });

  it("the schema-failure prefix on another tool's result is not a WebSearch no-request result: only WebSearch tool_uses count", () => {
    const { frames } = setup();
    frames.observe({ type: "assistant", message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "x" } }] } });
    frames.observe(result("b1", `<tool_use_error>${IVE}[]</tool_use_error>`, undefined, true));
    frames.observe(use("w1", "q"));
    frames.observe(result("w1", `<tool_use_error>${IVE}[]</tool_use_error>`, undefined, true));
    expect(frames.counts()).toMatchObject({ toolUses: 1, noRequest: 1 });
  });

  it("a tool_result with no registry entry (not intercepted) gets an unpaired frame; a non-WebSearch result is ignored", () => {
    const { frames } = setup();
    frames.observe(use("t", "q"));
    expect(parse(frames.observe(result("t", served("q"))))).toEqual([
      { _emu: "search_corpus_serve", streamed: true, toolUseId: "t", query: "q", unpaired: true },
    ]);
    expect(frames.observe(result("other", "x"))).toEqual([]);
  });

  it("at close: quiesces, then frames every untaken entry as unstreamed with its agent id; a keyless refusal included", async () => {
    const registry = new SearchRegistry();
    let quiesced = false;
    const frames = new ServeFrames({
      registry,
      noRequest,
      pool,
      miss: "empty",
      quiesce: async () => ((quiesced = true), { abandoned: 0 }),
    });
    registry.record(entry("depth two", { agentId: "ag9" }));
    registry.record({ agentId: "ag3", route: "messages", verdict: "refused", query: null, rounds: [], retryKey: null });
    const out = parse(await frames.finish());
    expect(quiesced).toBe(true);
    expect(out).toEqual([
      {
        _emu: "search_corpus_serve",
        streamed: false,
        agentId: "ag9",
        query: "depth two",
        ordinal: 1,
        pool,
        verdict: "served",
        rounds: [round],
      },
      { _emu: "search_corpus_serve", streamed: false, agentId: "ag3", query: null, ordinal: 1, pool, verdict: "refused", rounds: [] },
    ]);
    expect(out.every((f) => !("toolUseId" in f) && !("parentToolUseId" in f))).toBe(true);
  });

  it("frames carry no credential, header or host path", async () => {
    const { registry, frames } = setup();
    frames.observe(use("t", "q"));
    registry.record(entry("q"));
    const all = [...frames.observe(result("t", served("q"))), ...(await frames.finish())].join("\n");
    expect(all).not.toMatch(/authorization|x-api-key|Bearer|\/Users\/|\/home\//i);
  });
});
