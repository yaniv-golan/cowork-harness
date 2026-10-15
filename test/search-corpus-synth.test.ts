import { describe, it, expect } from "vitest";
import { synthResponse, synthBadRequest, type SynthOutcome } from "../src/search-corpus/synth.js";
import { renderWebSearchResult, type SearchEntry } from "../src/search-corpus/render.js";

const seed = { agentId: null, ordinal: 1, query: "ev market", allowedDomains: undefined, blockedDomains: undefined };
const rounds = [
  { query: "ev market", links: [{ title: "A", url: "https://a/1" }], text: "Round one prose." },
  { query: "ev market size", links: [{ title: "B", url: "https://b/1" }], text: "Round two prose." },
];

type Ev = { event: string; data: Record<string, any> };
function sse(body: string): Ev[] {
  return body
    .split("\n\n")
    .filter(Boolean)
    .map((chunk) => {
      const ev = /^event: (.+)$/m.exec(chunk)![1]!;
      const data = JSON.parse(/^data: (.+)$/m.exec(chunk)![1]!);
      expect(data.type).toBe(ev);
      return { event: ev, data };
    });
}

/** The client's stream rules (as the consumer reads them): message_start first; every block event carries
 *  an index; a block starts once, receives deltas only while open, and stops once; message_delta carries usage. */
function assemble(evs: Ev[]): any[] {
  expect(evs[0]!.event).toBe("message_start");
  expect(evs.at(-1)!.event).toBe("message_stop");
  const blocks: any[] = [];
  const open = new Set<number>();
  for (const { event, data } of evs) {
    if (event === "content_block_start") {
      expect(data.index).toBe(blocks.length);
      blocks.push(structuredClone(data.content_block));
      open.add(data.index);
    } else if (event === "content_block_delta") {
      expect(open.has(data.index)).toBe(true);
      const b = blocks[data.index];
      if (data.delta.type === "input_json_delta") b._json = (b._json ?? "") + data.delta.partial_json;
      else if (data.delta.type === "text_delta") b.text += data.delta.text;
      else throw new Error(`delta ${data.delta.type}`);
    } else if (event === "content_block_stop") {
      expect(open.delete(data.index)).toBe(true);
      const b = blocks[data.index];
      if (b.type === "server_tool_use") {
        b.input = JSON.parse(b._json);
        delete b._json;
      }
    } else if (event === "message_delta") {
      expect(data.usage).toBeDefined();
      expect(data.delta.stop_reason).toBe("end_turn");
    }
  }
  expect(open.size).toBe(0);
  return blocks;
}

/** A port of the agent's result builder: text before each search flushed, each result's {title,url}, trailing text. */
function toToolResultText(query: string, content: any[]): string {
  const entries: SearchEntry[] = [];
  let pending = "";
  for (const b of content) {
    if (b.type === "text") pending += b.text;
    else if (b.type === "server_tool_use") {
      if (pending) entries.push({ kind: "text", text: pending });
      pending = "";
    } else if (b.type === "web_search_tool_result") {
      if (Array.isArray(b.content)) entries.push({ kind: "links", links: b.content.map((r: any) => ({ title: r.title, url: r.url })) });
      else entries.push({ kind: "text", text: `Web search error: ${b.content.error_code}` });
    }
  }
  if (pending) entries.push({ kind: "text", text: pending });
  return renderWebSearchResult({ query, entries, reminder: "REMINDER: x" });
}

const served: SynthOutcome = { kind: "served", rounds };

describe("synthResponse", () => {
  it("SSE: a valid stream whose tool_result renders the served records exactly", () => {
    const r = synthResponse({ model: "claude-sonnet-5", stream: true, outcome: served, seed });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("text/event-stream");
    const evs = sse(r.body);
    expect(evs[0]!.data.message).toMatchObject({ model: "claude-sonnet-5", role: "assistant", content: [] });
    const content = assemble(evs);
    expect(content.map((b) => b.type)).toEqual([
      "server_tool_use",
      "web_search_tool_result",
      "text",
      "server_tool_use",
      "web_search_tool_result",
      "text",
    ]);
    // round 1 asks the agent's query, later rounds their record's own query
    expect(content[0].input).toEqual({ query: "ev market" });
    expect(content[3].input).toEqual({ query: "ev market size" });
    expect(content[1].tool_use_id).toBe(content[0].id);
    expect(content[1].content).toEqual([
      { type: "web_search_result", url: "https://a/1", title: "A", encrypted_content: "", page_age: null },
    ]);
    expect(toToolResultText("ev market", content)).toBe(
      renderWebSearchResult({
        query: "ev market",
        entries: [
          { kind: "links", links: rounds[0]!.links },
          { kind: "text", text: rounds[0]!.text },
          { kind: "links", links: rounds[1]!.links },
          { kind: "text", text: rounds[1]!.text },
        ],
        reminder: "REMINDER: x",
      }),
    );
  });

  it("usage is zero everywhere, including web_search_requests (searches are not billed)", () => {
    const evs = sse(synthResponse({ model: "m", stream: true, outcome: served, seed }).body);
    const zero = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: { web_search_requests: 0 },
    };
    expect(evs[0]!.data.message.usage).toEqual(zero);
    expect(evs.find((e) => e.event === "message_delta")!.data.usage).toEqual({
      output_tokens: 0,
      server_tool_use: { web_search_requests: 0 },
    });
  });

  it("JSON (stream:false) carries the same content as the stream", () => {
    const sseContent = assemble(sse(synthResponse({ model: "m", stream: true, outcome: served, seed }).body));
    const j = synthResponse({ model: "m", stream: false, outcome: served, seed });
    expect(j.headers["content-type"]).toBe("application/json");
    const msg = JSON.parse(j.body);
    expect(msg).toMatchObject({ type: "message", role: "assistant", model: "m", stop_reason: "end_turn", stop_sequence: null });
    expect(msg.content).toEqual(sseContent);
  });

  it("a miss is one search with no results and no text; miss=error and a refusal are the error object", () => {
    const empty = assemble(sse(synthResponse({ model: "m", stream: true, outcome: { kind: "empty" }, seed }).body));
    expect(empty.map((b) => b.type)).toEqual(["server_tool_use", "web_search_tool_result"]);
    expect(empty[1].content).toEqual([]);
    expect(toToolResultText("ev market", empty)).toContain("No links found.");
    const err = assemble(sse(synthResponse({ model: "m", stream: true, outcome: { kind: "error" }, seed }).body));
    expect(err[1].content).toEqual({ type: "web_search_tool_result_error", error_code: "unavailable" });
    expect(toToolResultText("ev market", err)).toContain("Web search error: unavailable");
  });

  it("ids and the request id are deterministic per (agent, ordinal, query, domains) and differ otherwise", () => {
    const a = synthResponse({ model: "m", stream: true, outcome: served, seed });
    expect(synthResponse({ model: "m", stream: true, outcome: served, seed }).body).toBe(a.body);
    expect(a.headers["request-id"]).toMatch(/^req_[0-9A-Za-z]{24}$/);
    const ids = (s: typeof seed) => assemble(sse(synthResponse({ model: "m", stream: true, outcome: served, seed: s }).body))[0].id;
    expect(ids(seed)).toMatch(/^srvtoolu_[0-9A-Za-z]{24}$/);
    for (const other of [
      { ...seed, ordinal: 2 },
      { ...seed, agentId: "ag1" },
      { ...seed, query: "x" },
      { ...seed, allowedDomains: ["a.com"] },
    ])
      expect(ids(other as typeof seed)).not.toBe(ids(seed));
  });

  it("never names the harness, and the 400 is neutral", () => {
    for (const outcome of [served, { kind: "empty" } as const, { kind: "error" } as const])
      expect(synthResponse({ model: "m", stream: true, outcome, seed }).body).not.toMatch(/harness|cowork|frozen|corpus/i);
    const bad = synthBadRequest(seed);
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body)).toEqual({ type: "error", error: { type: "invalid_request_error", message: "web search is unavailable" } });
    expect(bad.headers["request-id"]).toMatch(/^req_[0-9A-Za-z]{24}$/);
  });
});
