/**
 * Which `api.anthropic.com` requests are the agent's nested web search. Three facts, all required, on a
 * `POST /v1/messages` (any query string):
 *  1. `tools` is exactly one entry, of the recorded server search type;
 *  2. the system prompt (a string, or its text blocks joined) contains the recorded system sentence;
 *  3. `messages` is exactly one user message whose text starts with the recorded prefix; the query is the rest.
 * The sentence and prefix are known only as sha256 + byte length (`agentBinary.searchAnchors`), so "contains" is a
 * sliding window of that length and "starts with" is a hash of the first bytes.
 *
 * Fail-closed: a request with no search tool passes through; one with a search tool that misses any fact is refused,
 * never passed (no request carrying a server search tool reaches upstream while a corpus is active). A body is inflated
 * (gzip) before it is classified; a body that cannot be decoded is refused with a neutral 400, never passed unread.
 */

import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { SearchAnchors } from "../types.js";

export interface InterceptedRequest {
  method: string;
  /** Path and query string. */
  path: string;
  /** Header names in any case. */
  headers: Record<string, string>;
  body: Buffer;
}

export type Classification =
  | { kind: "pass" }
  | {
      kind: "search";
      query: string;
      allowedDomains?: string[];
      blockedDomains?: string[];
      model: string;
      stream: boolean;
      agentId: string | null;
      retryKey: string;
      toolChoice?: unknown;
      thinking?: unknown;
    }
  | {
      kind: "refuse";
      /** 200 with the error-object shape when the body could be read; 400 when it could not. */
      status: 200 | 400;
      why: string;
      query: string | null;
      /** The search tool's domain lists, when the body could be read: they key the refusal's frame like a search's. */
      allowedDomains?: string[];
      blockedDomains?: string[];
      model?: string;
      stream?: boolean;
      agentId: string | null;
      retryKey: string | null;
    };

type Hashed = { sha256: string; bytes: number };
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function header(h: Record<string, string>, name: string): string | undefined {
  const k = Object.keys(h).find((x) => x.toLowerCase() === name);
  return k === undefined ? undefined : h[k];
}

function startsWithHashed(text: string, h: Hashed): string | null {
  const b = Buffer.from(text, "utf8");
  if (b.length < h.bytes || sha(b.subarray(0, h.bytes)) !== h.sha256) return null;
  return b.subarray(h.bytes).toString("utf8");
}

function containsHashed(text: string, h: Hashed): boolean {
  const b = Buffer.from(text, "utf8");
  for (let i = 0; i + h.bytes <= b.length; i++) if (sha(b.subarray(i, i + h.bytes)) === h.sha256) return true;
  return false;
}

/** A string, or the text of its text blocks joined; null for any other shape. */
function textOf(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (!Array.isArray(v)) return null;
  let out = "";
  for (const b of v as { type?: unknown; text?: unknown }[]) {
    if (b?.type !== "text" || typeof b.text !== "string") return null;
    out += b.text;
  }
  return out;
}

const isSearchTool = (t: unknown) =>
  typeof (t as { type?: unknown })?.type === "string" && (t as { type: string }).type.startsWith("web_search_");
const strings = (v: unknown) => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined);

export function classifyRequest(r: InterceptedRequest, anchors: SearchAnchors | undefined): Classification {
  const path = r.path.split("?")[0];
  if (r.method.toUpperCase() !== "POST" || path !== "/v1/messages") return { kind: "pass" };
  const agentId = header(r.headers, "x-claude-code-agent-id") ?? null;
  const undecodable = (why: string): Classification => ({ kind: "refuse", status: 400, why, query: null, agentId, retryKey: null });

  const encoding = (header(r.headers, "content-encoding") ?? "identity").trim().toLowerCase();
  let raw: Buffer;
  if (encoding === "identity" || encoding === "") raw = r.body;
  else if (encoding === "gzip" || encoding === "x-gzip") {
    try {
      raw = gunzipSync(r.body);
    } catch {
      return undecodable("a gzip body that does not inflate");
    }
  } else return undecodable(`a body in an encoding it cannot read (${encoding})`);
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undecodable("a body that is not a JSON object");
    body = parsed as Record<string, unknown>;
  } catch {
    return undecodable("a body that is not JSON");
  }

  const tools = Array.isArray(body.tools) ? (body.tools as unknown[]) : [];
  if (!tools.some(isSearchTool)) return { kind: "pass" };

  const model = typeof body.model === "string" ? body.model : undefined;
  const stream = body.stream === true;
  // What identifies the search, for folding the pipeline's non-streaming retry into it: not the whole body, whose system
  // prompt carries a per-request hash line that differs between a stream and its retry.
  const retryKey = sha(Buffer.from(JSON.stringify([body.model, body.messages, body.tools])));
  const tool = tools[0] as Record<string, unknown>;
  const allowedDomains = strings(tool.allowed_domains);
  const blockedDomains = strings(tool.blocked_domains);
  const messages = Array.isArray(body.messages) ? (body.messages as { role?: unknown; content?: unknown }[]) : [];
  const userText = messages.length === 1 && messages[0]!.role === "user" ? textOf(messages[0]!.content) : null;
  const query = anchors && userText !== null ? startsWithHashed(userText, anchors.userPrefix) : null;
  const refuse = (why: string): Classification => ({
    kind: "refuse",
    status: 200,
    why,
    query,
    ...(allowedDomains ? { allowedDomains } : {}),
    ...(blockedDomains ? { blockedDomains } : {}),
    model,
    stream,
    agentId,
    retryKey,
  });

  if (!anchors) return refuse("no recorded search anchors");
  if (tools.length !== 1) return refuse("the search tool is not the only tool");
  if (tool.type !== anchors.toolType) return refuse("a search tool of another type");
  if (model === undefined) return refuse("no model");
  const system = textOf(body.system);
  if (system === null || !containsHashed(system, anchors.systemSentence)) return refuse("the system prompt is not the search assistant's");
  if (query === null) return refuse("the message is not the search request");
  return {
    kind: "search",
    query,
    ...(allowedDomains ? { allowedDomains } : {}),
    ...(blockedDomains ? { blockedDomains } : {}),
    model,
    stream,
    agentId,
    retryKey,
    ...(body.tool_choice !== undefined ? { toolChoice: body.tool_choice } : {}),
    ...(body.thinking !== undefined ? { thinking: body.thinking } : {}),
  };
}
