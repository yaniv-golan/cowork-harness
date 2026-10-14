/**
 * The post-run join: one call per intercepted search request, with the tool_use that asked for it.
 *
 * A request's agent is known from the interceptor (its `x-claude-code-agent-id`); which tool_use it answered is what the
 * stream had to guess for a sub-agent, since the dispatch's result, which names the sub-agent, arrives after the
 * sub-agent's own results. So a main-loop pairing is final, and a parented one is re-paired here: within the agent its
 * dispatch resolved to, by key and by the answer the result showed, in result order. A move is allowed only between
 * requests whose whole serve record is equal, so it can change who asked, never what was served. The streamed frames
 * are never rewritten; a call records where it moved from.
 */

import { parseMessage } from "../agent/session.js";
import { sharesToolId, toolIds } from "../hillclimb/trace.js";
import { shapeVerdicts, type FramePairing } from "./frames.js";
import type { RegistryEntry } from "./registry.js";
import type { SearchCorpusCall } from "../types.js";

export type SearchCall = SearchCorpusCall;

export interface JoinResult {
  calls: SearchCall[];
  /** Pairings the join moved to another request with an equal serve record. */
  reassigned: number;
  /** Calls whose pairing is not confirmed: a provisional result or request, or an unpaired result. */
  unattributed: number;
  /** Refusals whose body could not be read: they can never be taken by a result, by design. */
  unattributedExpected: number;
  /** Pairings the harness could not settle (a refused move, no request left, or dispatches that resolved to other agents). */
  attributionUncertain: number;
}

const list = (xs: string[] | undefined) => JSON.stringify(xs ?? []);
const keyOf = (e: { query: string | null; allowedDomains?: string[]; blockedDomains?: string[] }) =>
  `${JSON.stringify(e.query)}|${list(e.allowedDomains)}|${list(e.blockedDomains)}`;
/** Everything a frame shows of what was served, except who asked and its number. */
const serveRecord = (e: RegistryEntry) => JSON.stringify([e.query, e.allowedDomains ?? [], e.blockedDomains ?? [], e.verdict, e.rounds]);

/** The agent behind each dispatch: the dispatch result's agent id, read with the harness's own stream parser (one
 *  carrying only that id included: a forked skill's); else the transcript that shares a tool call with the dispatch's
 *  parented events. */
export function dispatchAgentIds(
  events: readonly string[],
  transcripts: readonly { agentId: string; lines: readonly string[] }[],
): Map<string, string> {
  const out = new Map<string, string>();
  const parented = new Map<string, string[]>();
  for (const line of events) {
    let msg: { parent_tool_use_id?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof msg?.parent_tool_use_id === "string")
      (parented.get(msg.parent_tool_use_id) ?? parented.set(msg.parent_tool_use_id, []).get(msg.parent_tool_use_id)!).push(line);
    let evs: ReturnType<typeof parseMessage>;
    try {
      evs = parseMessage(msg);
    } catch {
      continue;
    }
    for (const ev of evs) if (ev.type === "subagent_result_meta" && ev.agentId) out.set(ev.toolUseId, ev.agentId);
  }
  const unnamed = transcripts.map((t) => ({ agentId: t.agentId, ids: toolIds(t.lines), used: [...out.values()].includes(t.agentId) }));
  for (const [dispatch, lines] of parented) {
    if (out.has(dispatch)) continue;
    const mine = toolIds(lines);
    const hit = unnamed.find((u) => !u.used && sharesToolId(mine, u.ids));
    if (hit) {
      hit.used = true;
      out.set(dispatch, hit.agentId);
    }
  }
  return out;
}

export function joinCalls(o: {
  entries: readonly RegistryEntry[];
  pairings: readonly FramePairing[];
  dispatchAgents: ReadonlyMap<string, string>;
  /** The run's miss mode: which verdicts an error-shaped or empty result can be. */
  miss: "empty" | "error";
}): JoinResult {
  const toolUseOf = new Map<
    RegistryEntry,
    { toolUseId: string; provisional?: true; reassignedFrom?: { agentId?: string; ordinal: number } }
  >();
  const extra: SearchCall[] = [];
  let reassigned = 0;
  let uncertain = 0;
  const allowed = (p: FramePairing, e: RegistryEntry) => shapeVerdicts(p.shape, o.miss)?.includes(e.verdict) ?? true;
  const resolvedPairs: { p: FramePairing; agent: string }[] = [];
  const unresolvedPairs: FramePairing[] = [];

  for (const p of o.pairings) {
    if (!p.entry) {
      extra.push({ toolUseId: p.toolUseId, unpaired: true });
    } else if (p.parentToolUseId === undefined) toolUseOf.set(p.entry, { toolUseId: p.toolUseId });
    else {
      const agent = o.dispatchAgents.get(p.parentToolUseId);
      if (agent === undefined) unresolvedPairs.push(p);
      else resolvedPairs.push({ p, agent });
    }
  }
  // First, every stream pairing that is already right (the entry is its resolved agent's, and free) is confirmed.
  const pending: { p: FramePairing; agent: string }[] = [];
  for (const r of resolvedPairs) {
    const e = r.p.entry!;
    if (e.agentId === r.agent && !toolUseOf.has(e) && allowed(r.p, e)) toolUseOf.set(e, { toolUseId: r.p.toolUseId });
    else pending.push(r);
  }
  // Then each other one moves, in result order, to its agent's earliest free request with the same key, an answer it
  // can be, and the same serve record. One that cannot move stays unconfirmed.
  const failed: FramePairing[] = [];
  for (const { p, agent } of pending) {
    const streamed = p.entry!;
    const target = o.entries.find(
      (e) =>
        e.agentId === agent &&
        !toolUseOf.has(e) &&
        keyOf(e) === keyOf(streamed) &&
        allowed(p, e) &&
        serveRecord(e) === serveRecord(streamed),
    );
    if (target) {
      toolUseOf.set(target, {
        toolUseId: p.toolUseId,
        reassignedFrom: { ...(streamed.agentId ? { agentId: streamed.agentId } : {}), ordinal: streamed.ordinal },
      });
      reassigned++;
    } else {
      failed.push(p);
      uncertain++;
    }
  }
  // Dispatches resolved to agents, yet none of the parented results resolved: a renamed id would look like this.
  if (unresolvedPairs.length > 0 && resolvedPairs.length === 0 && o.dispatchAgents.size > 0) uncertain += unresolvedPairs.length;
  // What could not be confirmed keeps the stream's pairing, marked; where that request is now another result's, the
  // result is its own call.
  for (const p of [...failed, ...unresolvedPairs]) {
    if (!toolUseOf.has(p.entry!)) toolUseOf.set(p.entry!, { toolUseId: p.toolUseId, provisional: true });
    else extra.push({ toolUseId: p.toolUseId, provisional: true });
  }
  // A request the stream gave a result to, left with none by a move: its result is uncertain, so it is marked.
  const leftBare = new Set(o.pairings.map((p) => p.entry).filter((e): e is RegistryEntry => !!e && !toolUseOf.has(e)));

  let unattributedExpected = 0;
  const calls: SearchCall[] = o.entries.map((e) => {
    if (e.query === null) unattributedExpected++;
    const t = toolUseOf.get(e);
    return {
      ...(e.agentId ? { agentId: e.agentId } : {}),
      ...(t ? { toolUseId: t.toolUseId } : {}),
      query: e.query,
      ...(e.allowedDomains?.length ? { allowedDomains: [...e.allowedDomains] } : {}),
      ...(e.blockedDomains?.length ? { blockedDomains: [...e.blockedDomains] } : {}),
      verdict: e.verdict,
      ordinal: e.ordinal,
      rounds: e.rounds.map((r) => ({ ...r, urls: [...r.urls] })),
      ...(e.exactUrls?.length ? { exactUrls: [...e.exactUrls] } : {}),
      ...(t?.provisional || leftBare.has(e) ? { provisional: true as const } : {}),
      ...(t?.reassignedFrom !== undefined ? { reassignedFrom: t.reassignedFrom } : {}),
    };
  });
  const all = [...calls, ...extra];
  // Every call whose pairing is not confirmed: a provisional one (a result, or a request a move left without one) or an
  // unpaired result.
  const unattributed = all.filter((c) => c.provisional || c.unpaired).length;
  return { calls: all, reassigned, unattributed, unattributedExpected, attributionUncertain: uncertain };
}
