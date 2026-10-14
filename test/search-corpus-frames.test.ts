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
const parse = (lines: string[]) => lines.map((l) => JSON.parse(l));

function setup() {
  const registry = new SearchRegistry();
  const frames = new ServeFrames({ registry, noRequest, pool, quiesce: async () => ({ abandoned: 0 }) });
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

  it("a parented (sub-agent) result carries its parent; the domain lists come from the tool_use input and key the take", () => {
    const { registry, frames } = setup();
    frames.observe(use("c1", "q", "task1", { allowed_domains: ["x.com"] }));
    registry.record(entry("q", { agentId: "ag1" }));
    registry.record(entry("q", { agentId: "ag2", allowedDomains: ["x.com"] }));
    const [f] = parse(frames.observe(result("c1", served("q"), "task1")));
    expect(f).toMatchObject({ parentToolUseId: "task1", allowedDomains: ["x.com"], query: "q" });
    expect(registry.unconsumed().map((e) => e.agentId)).toEqual(["ag1"]);
  });

  it("a miss and a refusal are framed like a serve", () => {
    const { registry, frames } = setup();
    frames.observe(use("m", "miss q"));
    frames.observe(use("r", "ref q"));
    registry.record(entry("miss q", { verdict: "miss", rounds: [] }));
    registry.record(entry("ref q", { verdict: "refused", rounds: [] }));
    expect(parse(frames.observe(result("m", served("miss q"))))[0]).toMatchObject({ verdict: "miss", rounds: [] });
    expect(parse(frames.observe(result("r", served("ref q"))))[0]).toMatchObject({ verdict: "refused" });
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
    expect(frames.counts()).toEqual({ toolUses: 1, noRequest: 1 });
  });

  it("a tool_result with no registry entry (not intercepted) gets no frame; a non-WebSearch result is ignored", () => {
    const { frames } = setup();
    frames.observe(use("t", "q"));
    expect(frames.observe(result("t", served("q")))).toEqual([]);
    expect(frames.observe(result("other", "x"))).toEqual([]);
  });

  it("at close: quiesces, then frames every untaken entry as unstreamed with its agent id; a keyless refusal included", async () => {
    const registry = new SearchRegistry();
    let quiesced = false;
    const frames = new ServeFrames({ registry, noRequest, pool, quiesce: async () => ((quiesced = true), { abandoned: 0 }) });
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
