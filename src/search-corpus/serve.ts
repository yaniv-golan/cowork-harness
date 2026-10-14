/**
 * The interceptor's decision for one complete `api.anthropic.com` request, with no network: forward it untouched, or
 * answer it locally. A nested search (`POST /v1/messages`, classified by the predicate) is served from the pool, or
 * answered as a miss or a refusal; the CCR worker search route is served as `{results:[…]}`. Every answered search is
 * recorded in the registry before the answer is returned, and logged as one line with no header, credential or body.
 *
 * No request carrying a server search tool is ever forwarded. The forward log checks that on its own, from each
 * forwarded body's parsed `tools`, so a forwarding bug shows up as `passedThroughWithSearchTool > 0`; a classifier bug
 * is caught by the agent-side count instead, which shares nothing with this module.
 */

import { performance } from "node:perf_hooks";
import { gunzipSync } from "node:zlib";
import type { SearchAnchors } from "../types.js";
import { classifyRequest, type InterceptedRequest } from "./predicate.js";
import type { FrameRound, RegistryEntry, SearchRegistry } from "./registry.js";
import { maxScore, select, type PoolIndex } from "./retrieval.js";
import { synthBadRequest, synthResponse, type SynthHttp, type SynthOutcome, type SynthSeed } from "./synth.js";

export interface SearchLogLine {
  ts: string;
  ordinal: number;
  agentId?: string;
  route: "messages" | "ccr";
  verdict: "served" | "miss" | "refused" | "unfinished";
  query: string | null;
  model?: string;
  toolChoice?: unknown;
  thinking?: unknown;
  candidates: { id: string; score: number }[];
  served: string[];
  linksServed: number;
  latencyMs: number;
  /** The ordinal of the request this one retried (a `stream: false` retry, folded into it). */
  retryOf?: number;
}

export interface ServeContext {
  index: PoolIndex;
  anchors: SearchAnchors | undefined;
  registry: SearchRegistry;
  miss: "empty" | "error";
  log: (line: SearchLogLine) => void;
  /** Test seam: replaces the classifier (the agent-level test mutates it to prove the agent-side check can fail). */
  classify?: typeof classifyRequest;
  /** Requests forwarded upstream, and how many of them carried a server search tool (must stay 0). */
  forwarded?: number;
  passedThroughWithSearchTool?: number;
}

export type ServeDecision = { kind: "forward" } | { kind: "respond"; http: SynthHttp };

/** What each recorded request was answered with, so a folded retry gets the same answer. */
const answers = new WeakMap<RegistryEntry, SynthOutcome>();

function servedOutcome(ctx: ServeContext, query: string, domains: { allowed?: string[]; blocked?: string[] }) {
  const sel = select(ctx.index, query, domains);
  const max = maxScore(ctx.index, query);
  const rounds: FrameRound[] = sel.rounds.map((r) => ({
    match: r.match,
    nscore: max > 0 ? r.score / max : 0,
    sourceQuery: r.record.query,
    recordId: r.record.id,
    sourceSkill: r.record.source.skill,
    urls: r.links.map((l) => l.url),
  }));
  const outcome: SynthOutcome =
    sel.verdict === "served"
      ? { kind: "served", rounds: sel.rounds.map((r) => ({ query: r.record.query, links: r.links, text: r.record.text })) }
      : { kind: ctx.miss };
  return { sel, rounds, outcome };
}

function searchToolForwarded(r: InterceptedRequest): boolean {
  try {
    const enc = Object.entries(r.headers)
      .find(([k]) => k.toLowerCase() === "content-encoding")?.[1]
      ?.toLowerCase();
    const raw = enc === "gzip" || enc === "x-gzip" ? gunzipSync(r.body) : r.body;
    const tools = (JSON.parse(raw.toString("utf8")) as { tools?: unknown }).tools;
    return (
      Array.isArray(tools) &&
      tools.some((t) => typeof (t as { type?: unknown })?.type === "string" && (t as { type: string }).type.startsWith("web_search_"))
    );
  } catch {
    return false;
  }
}

function forward(r: InterceptedRequest, ctx: ServeContext): ServeDecision {
  ctx.forwarded = (ctx.forwarded ?? 0) + 1;
  // Only a model request runs a search; the same path test as the classifier's (a token count carries tools too).
  if (r.method.toUpperCase() === "POST" && r.path.split("?")[0] === "/v1/messages" && searchToolForwarded(r))
    ctx.passedThroughWithSearchTool = (ctx.passedThroughWithSearchTool ?? 0) + 1;
  else ctx.passedThroughWithSearchTool ??= 0;
  return { kind: "forward" };
}

function ccrPath(path: string, anchors: SearchAnchors | undefined): boolean {
  const c = anchors?.ccr;
  if (!c) return false; // without anchors a run is refused at load
  const p = path.split("?")[0]!;
  if (!p.startsWith(c.sessionsPath)) return false;
  const rest = p.slice(c.sessionsPath.length);
  const slash = rest.indexOf("/");
  return slash > 0 && rest.slice(slash) === `${c.workerPath}${c.searchRoute}`;
}

export function serveRequest(r: InterceptedRequest, ctx: ServeContext): ServeDecision {
  const t0 = performance.now();
  const line = (l: Omit<SearchLogLine, "ts" | "latencyMs">) =>
    ctx.log({ ts: new Date().toISOString(), ...l, latencyMs: Math.round((performance.now() - t0) * 1000) / 1000 });

  // After the session has framed what was recorded, a search can no longer be recorded or framed: refuse it, unrecorded.
  const late = (): ServeDecision => ({ kind: "respond", http: synthBadRequest({ agentId: null, ordinal: 0, query: null }) });
  if (r.method.toUpperCase() === "POST" && ccrPath(r.path, ctx.anchors)) return ctx.registry.closed ? late() : serveCcr(r, ctx, line);

  const c = (ctx.classify ?? classifyRequest)(r, ctx.anchors);
  if (c.kind === "pass") return forward(r, ctx);
  if (ctx.registry.closed) return late();
  const seed = (e: RegistryEntry): SynthSeed => ({
    agentId: e.agentId,
    ordinal: e.ordinal,
    query: e.query,
    ...(e.allowedDomains ? { allowedDomains: e.allowedDomains } : {}),
    ...(e.blockedDomains ? { blockedDomains: e.blockedDomains } : {}),
  });

  if (c.kind === "search") {
    // Only a non-streaming request can be the pipeline's fallback retry; a streaming repeat is a new search.
    const prev = c.stream ? undefined : ctx.registry.retryOf(c.agentId, c.retryKey);
    if (prev) {
      line({
        ordinal: prev.ordinal,
        ...(c.agentId ? { agentId: c.agentId } : {}),
        route: "messages",
        verdict: prev.verdict,
        query: c.query,
        model: c.model,
        candidates: [],
        served: prev.rounds.map((x) => x.recordId),
        linksServed: prev.rounds.reduce((n, x) => n + x.urls.length, 0),
        retryOf: prev.ordinal,
      });
      return { kind: "respond", http: synthResponse({ model: c.model, stream: c.stream, outcome: answers.get(prev)!, seed: seed(prev) }) };
    }
    const { sel, rounds, outcome } = servedOutcome(ctx, c.query, { allowed: c.allowedDomains, blocked: c.blockedDomains });
    const e = ctx.registry.record({
      agentId: c.agentId,
      route: "messages",
      verdict: sel.verdict,
      query: c.query,
      ...(c.allowedDomains ? { allowedDomains: c.allowedDomains } : {}),
      ...(c.blockedDomains ? { blockedDomains: c.blockedDomains } : {}),
      rounds,
      retryKey: c.retryKey,
    });
    answers.set(e, outcome);
    line({
      ordinal: e.ordinal,
      ...(c.agentId ? { agentId: c.agentId } : {}),
      route: "messages",
      verdict: e.verdict,
      query: c.query,
      model: c.model,
      ...(c.toolChoice !== undefined ? { toolChoice: c.toolChoice } : {}),
      ...(c.thinking !== undefined ? { thinking: c.thinking } : {}),
      candidates: sel.candidates,
      served: rounds.map((x) => x.recordId),
      linksServed: rounds.reduce((n, x) => n + x.urls.length, 0),
    });
    return { kind: "respond", http: synthResponse({ model: c.model, stream: c.stream, outcome, seed: seed(e) }) };
  }

  // A refusal: a search tool that misses the predicate, or a body that could not be read.
  const e = ctx.registry.record({
    agentId: c.agentId,
    route: "messages",
    verdict: "refused",
    query: c.query,
    ...(c.allowedDomains ? { allowedDomains: c.allowedDomains } : {}),
    ...(c.blockedDomains ? { blockedDomains: c.blockedDomains } : {}),
    rounds: [],
    retryKey: c.retryKey,
  });
  answers.set(e, { kind: "error" });
  line({
    ordinal: e.ordinal,
    ...(c.agentId ? { agentId: c.agentId } : {}),
    route: "messages",
    verdict: "refused",
    query: c.query,
    ...(c.model ? { model: c.model } : {}),
    candidates: [],
    served: [],
    linksServed: 0,
  });
  const http =
    c.status === 200 && c.model !== undefined
      ? synthResponse({ model: c.model, stream: c.stream ?? true, outcome: { kind: "error" }, seed: seed(e) })
      : synthBadRequest(seed(e));
  return { kind: "respond", http };
}

function serveCcr(r: InterceptedRequest, ctx: ServeContext, line: (l: Omit<SearchLogLine, "ts" | "latencyMs">) => void): ServeDecision {
  let body: { query?: unknown; allowed_domains?: unknown; blocked_domains?: unknown };
  try {
    body = JSON.parse(r.body.toString("utf8"));
    if (!body || typeof body !== "object" || typeof body.query !== "string") throw new Error("shape");
  } catch {
    const e = ctx.registry.record({ agentId: null, route: "ccr", verdict: "refused", query: null, rounds: [], retryKey: null });
    line({ ordinal: e.ordinal, route: "ccr", verdict: "refused", query: null, candidates: [], served: [], linksServed: 0 });
    return { kind: "respond", http: synthBadRequest({ agentId: null, ordinal: e.ordinal, query: null }) };
  }
  const query = body.query as string;
  const strs = (v: unknown) => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined);
  const allowed = strs(body.allowed_domains);
  const blocked = strs(body.blocked_domains);
  const { sel, rounds, outcome } = servedOutcome(ctx, query, { allowed, blocked });
  const e = ctx.registry.record({
    agentId: null,
    route: "ccr",
    verdict: sel.verdict,
    query,
    ...(allowed ? { allowedDomains: allowed } : {}),
    ...(blocked ? { blockedDomains: blocked } : {}),
    rounds,
    retryKey: null,
  });
  line({
    ordinal: e.ordinal,
    route: "ccr",
    verdict: e.verdict,
    query,
    candidates: sel.candidates,
    served: rounds.map((x) => x.recordId),
    linksServed: rounds.reduce((n, x) => n + x.urls.length, 0),
  });
  const results =
    outcome.kind === "served"
      ? outcome.rounds.flatMap((rd) => rd.links.map((l) => ({ title: l.title, url: l.url, snippet: rd.text })))
      : [];
  const payload =
    outcome.kind === "error" ? { results, error: { error_type: "unavailable", error_message: "web search is unavailable" } } : { results };
  return { kind: "respond", http: { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) } };
}
