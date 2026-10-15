/**
 * The local answer to an intercepted nested search, in the shape a live multi-search response has: per
 * served round a `server_tool_use` (with its query as an input delta), a `web_search_tool_result` with the round's
 * links, and a text block with the record's prose. A miss is one search with no results; `miss=error` and a refusal
 * are the API's error object. SSE when the request streamed, JSON otherwise, with the same content.
 *
 * Usage is zero everywhere, `web_search_requests` included: a served search was not bought, so the agent's own cost
 * and search count leave it out. Ids are deterministic per (agent, logical ordinal, query, domain lists, round), so
 * the same request gets the same bytes on any machine. Nothing in a response names the harness.
 */

import { createHash } from "node:crypto";
import type { SearchLink } from "./render.js";

export interface SynthRound {
  query: string;
  links: SearchLink[];
  text: string;
}

export type SynthOutcome = { kind: "served"; rounds: SynthRound[] } | { kind: "empty" } | { kind: "error" };

export interface SynthSeed {
  agentId: string | null;
  ordinal: number;
  query: string | null;
  allowedDomains?: string[];
  blockedDomains?: string[];
}

export interface SynthHttp {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** 24 base62 characters from the seed and a purpose tag. */
function detId(seed: SynthSeed, tag: string): string {
  const d = createHash("sha256")
    .update(JSON.stringify([seed.agentId, seed.ordinal, seed.query, seed.allowedDomains ?? [], seed.blockedDomains ?? [], tag]))
    .digest();
  let out = "";
  for (let i = 0; out.length < 24; i++) out += B62[d[i % d.length]! % 62];
  return out;
}

const ZERO_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  server_tool_use: { web_search_requests: 0 },
};

type Block =
  | { type: "server_tool_use"; id: string; name: "web_search"; input: { query: string } }
  | { type: "web_search_tool_result"; tool_use_id: string; content: unknown }
  | { type: "text"; text: string };

function blocksFor(outcome: SynthOutcome, seed: SynthSeed): Block[] {
  const searches: { query: string; result: unknown; text?: string }[] =
    outcome.kind === "served"
      ? outcome.rounds.map((r, i) => ({
          query: i === 0 ? (seed.query ?? r.query) : r.query,
          result: r.links.map((l) => ({ type: "web_search_result", url: l.url, title: l.title, encrypted_content: "", page_age: null })),
          text: r.text,
        }))
      : [
          {
            query: seed.query ?? "",
            result: outcome.kind === "empty" ? [] : { type: "web_search_tool_result_error", error_code: "unavailable" },
          },
        ];
  const out: Block[] = [];
  searches.forEach((s, i) => {
    const id = `srvtoolu_${detId(seed, `tool:${i}`)}`;
    out.push({ type: "server_tool_use", id, name: "web_search", input: { query: s.query } });
    out.push({ type: "web_search_tool_result", tool_use_id: id, content: s.result });
    if (s.text) out.push({ type: "text", text: s.text });
  });
  return out;
}

const event = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

function sse(model: string, blocks: Block[], seed: SynthSeed): string {
  let s = event("message_start", {
    message: {
      id: `msg_${detId(seed, "msg")}`,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: ZERO_USAGE,
    },
  });
  blocks.forEach((b, index) => {
    if (b.type === "server_tool_use") {
      s += event("content_block_start", { index, content_block: { ...b, input: {} } });
      s += event("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    } else if (b.type === "text") {
      s += event("content_block_start", { index, content_block: { type: "text", text: "" } });
      s += event("content_block_delta", { index, delta: { type: "text_delta", text: b.text } });
    } else s += event("content_block_start", { index, content_block: b });
    s += event("content_block_stop", { index });
  });
  s += event("message_delta", {
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 0, server_tool_use: { web_search_requests: 0 } },
  });
  s += event("message_stop", {});
  return s;
}

export function synthResponse(a: { model: string; stream: boolean; outcome: SynthOutcome; seed: SynthSeed }): SynthHttp {
  const blocks = blocksFor(a.outcome, a.seed);
  const requestId = `req_${detId(a.seed, "request")}`;
  if (a.stream)
    return {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "request-id": requestId },
      body: sse(a.model, blocks, a.seed),
    };
  return {
    status: 200,
    headers: { "content-type": "application/json", "request-id": requestId },
    body: JSON.stringify({
      id: `msg_${detId(a.seed, "msg")}`,
      type: "message",
      role: "assistant",
      model: a.model,
      content: blocks,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: ZERO_USAGE,
    }),
  };
}

/** The neutral 400 for a body that could not be read. */
export function synthBadRequest(seed: SynthSeed): SynthHttp {
  return {
    status: 400,
    headers: { "content-type": "application/json", "request-id": `req_${detId(seed, "request")}` },
    body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "web search is unavailable" } }),
  };
}
