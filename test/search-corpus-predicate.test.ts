import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { classifyRequest } from "../src/search-corpus/predicate.js";
import type { SearchAnchors } from "../src/types.js";

// The predicate table. The sentence and prefix are invented; the shape follows the agent's nested request.
const SENTENCE = "You are a pretend assistant that searches.";
const PREFIX = "Look this up on the web please: ";
const h = (t: string) => ({ sha256: createHash("sha256").update(t, "utf8").digest("hex"), bytes: Buffer.byteLength(t) });
const anchors: SearchAnchors = {
  toolType: "web_search_20250305",
  systemSentence: h(SENTENCE),
  userPrefix: h(PREFIX),
  ccr: { sessionsPath: "/v1/code/sessions/", workerPath: "/worker/", searchRoute: "web-search" },
};
const nested = (o: Record<string, unknown> = {}) => ({
  model: "claude-sonnet-5",
  max_tokens: 64000,
  stream: true,
  system: [{ type: "text", text: `Preamble. ${SENTENCE}` }],
  messages: [{ role: "user", content: [{ type: "text", text: `${PREFIX}ev market size 2026` }] }],
  tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8, allowed_domains: ["a.com"] }],
  tool_choice: { type: "tool", name: "web_search" },
  thinking: { type: "disabled" },
  ...o,
});
const req = (body: unknown, o: { path?: string; method?: string; headers?: Record<string, string>; raw?: Buffer } = {}) =>
  classifyRequest(
    {
      method: o.method ?? "POST",
      path: o.path ?? "/v1/messages?beta=true",
      headers: o.headers ?? {},
      body: o.raw ?? Buffer.from(JSON.stringify(body)),
    },
    anchors,
  );

describe("classifyRequest", () => {
  it("the canonical nested body is a search, with its query, domains, model and agent", () => {
    const c = req(nested(), { headers: { "x-claude-code-agent-id": "ag1" } });
    expect(c).toMatchObject({
      kind: "search",
      query: "ev market size 2026",
      allowedDomains: ["a.com"],
      model: "claude-sonnet-5",
      stream: true,
      agentId: "ag1",
    });
  });

  it("does not depend on tool_choice, thinking, the model or the query string", () => {
    expect(req(nested({ tool_choice: { type: "auto" }, thinking: undefined, model: "claude-opus-5-5" })).kind).toBe("search");
    expect(req(nested(), { path: "/v1/messages" }).kind).toBe("search");
    expect(req(nested({ system: `${SENTENCE}` })).kind).toBe("search"); // a string system prompt
    expect(req(nested({ messages: [{ role: "user", content: `${PREFIX}q` }] }))).toMatchObject({ kind: "search", query: "q" });
  });

  it("no search tool anywhere passes through (main loop, sub-agent, compaction)", () => {
    expect(req(nested({ tools: [{ name: "Bash", input_schema: {} }] })).kind).toBe("pass");
    expect(req(nested({ tools: undefined })).kind).toBe("pass");
    expect(req(nested(), { path: "/v1/messages/count_tokens" }).kind).toBe("pass");
    expect(req(nested(), { method: "GET" }).kind).toBe("pass");
    expect(req(null, { path: "/api/oauth/profile", raw: Buffer.from("not json") }).kind).toBe("pass");
  });

  it("a search tool with any mandatory field off is refused, never passed", () => {
    const refused = (b: unknown) => req(b).kind;
    expect(refused(nested({ tools: [...nested().tools, { name: "advisor", input_schema: {} }] }))).toBe("refuse"); // extra tool
    expect(refused(nested({ tools: [nested().tools[0], nested().tools[0]] }))).toBe("refuse"); // two search tools
    expect(refused(nested({ tools: [{ ...nested().tools[0], type: "web_search_29990101" }] }))).toBe("refuse"); // another type
    expect(refused(nested({ system: "You are a different assistant." }))).toBe("refuse");
    expect(refused(nested({ messages: [{ role: "user", content: "Search for: q" }] }))).toBe("refuse");
    expect(refused(nested({ messages: [...nested().messages, { role: "assistant", content: "x" }] }))).toBe("refuse");
    expect(refused(nested({ messages: [{ role: "assistant", content: `${PREFIX}q` }] }))).toBe("refuse");
  });

  it("a refusal keeps what it could read: the model and stream flag for the 200 shape, the query when known", () => {
    expect(req(nested({ system: "other" }))).toMatchObject({
      kind: "refuse",
      status: 200,
      model: "claude-sonnet-5",
      stream: true,
      query: "ev market size 2026",
    });
    expect(req(nested({ messages: [{ role: "user", content: "no prefix" }] }))).toMatchObject({ kind: "refuse", status: 200, query: null });
  });

  it("inflates a gzipped body to classify it, and refuses one it cannot decode with the neutral 400", () => {
    const gz = gzipSync(Buffer.from(JSON.stringify(nested())));
    expect(req(null, { raw: gz, headers: { "content-encoding": "gzip" } })).toMatchObject({ kind: "search", query: "ev market size 2026" });
    expect(req(null, { raw: Buffer.from("garbage"), headers: { "content-encoding": "gzip" } })).toMatchObject({
      kind: "refuse",
      status: 400,
      query: null,
    });
    expect(req(null, { raw: gz, headers: { "content-encoding": "br" } })).toMatchObject({ kind: "refuse", status: 400 });
    expect(req(null, { raw: Buffer.from("{not json") })).toMatchObject({ kind: "refuse", status: 400 });
  });

  it("a gzipped main-loop body passes through (classified, not refused)", () => {
    const gz = gzipSync(Buffer.from(JSON.stringify(nested({ tools: [{ name: "Bash", input_schema: {} }] }))));
    expect(req(null, { raw: gz, headers: { "Content-Encoding": "gzip" } }).kind).toBe("pass");
  });

  it("a retry key: the search's model, message and tools; a per-request system line (the billing hash) does not change it", () => {
    const k = (b: unknown) => (req(b) as { retryKey: string }).retryKey;
    expect(k(nested({ stream: false }))).toBe(k(nested({ stream: true })));
    // the agent's system carries a per-request hash that differs between a stream and its fallback retry
    const billed = (h: string) =>
      nested({
        system: [
          { type: "text", text: `x-billing: cch=${h};` },
          { type: "text", text: SENTENCE },
        ],
      });
    expect(k(billed("aaaa"))).toBe(k(billed("bbbb")));
    expect(k(nested({ messages: [{ role: "user", content: `${PREFIX}another query` }] }))).not.toBe(k(nested()));
    expect(k(nested({ model: "claude-opus-5-5" }))).not.toBe(k(nested()));
  });

  it("without anchors a search-tool request is refused, never served or passed", () => {
    expect(
      classifyRequest({ method: "POST", path: "/v1/messages", headers: {}, body: Buffer.from(JSON.stringify(nested())) }, undefined),
    ).toMatchObject({
      kind: "refuse",
    });
  });
});
