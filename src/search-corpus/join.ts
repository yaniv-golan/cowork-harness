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
import type { FramePairing } from "./frames.js";
import type { RegistryEntry } from "./registry.js";
import type { SearchCorpusCall } from "../types.js";

export type SearchCall = SearchCorpusCall;

export interface JoinResult {
  calls: SearchCall[];
  /** Pairings the join moved to another request with an equal serve record. */
  reassigned: number;
  /** Results whose request could not be confirmed: unpaired, unresolved, or a move the guard refused. */
  unattributed: number;
  /** Refusals whose body could not be read: they can never be taken by a result, by design. */
  unattributedExpected: number;
  /** Pairings the harness could not settle (a refused move, no request left, or dispatches that resolved to other agents). */
  attributionUncertain: number;
}

type Verdicts = readonly RegistryEntry["verdict"][];
const VERDICTS: Record<FramePairing["shape"], Verdicts> = {
  served: ["served"],
  empty: ["miss"],
  error: ["refused", "miss"],
  unfenced: ["served", "miss", "refused"],
};

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
}): JoinResult {
  const toolUseOf = new Map<RegistryEntry, { toolUseId: string; provisional?: true; reassignedFrom?: number }>();
  const extra: SearchCall[] = [];
  let reassigned = 0;
  let unattributed = 0;
  let uncertain = 0;
  let unresolved = 0;
  let resolved = 0;

  // A parented pairing's group: its resolved agent, its key and the answer it showed.
  const groups = new Map<string, FramePairing[]>();
  for (const p of o.pairings) {
    if (!p.entry) {
      extra.push({ toolUseId: p.toolUseId, unpaired: true });
      unattributed++;
      continue;
    }
    if (p.parentToolUseId === undefined) {
      toolUseOf.set(p.entry, { toolUseId: p.toolUseId });
      continue;
    }
    const agent = o.dispatchAgents.get(p.parentToolUseId);
    if (agent === undefined) {
      toolUseOf.set(p.entry, { toolUseId: p.toolUseId, provisional: true });
      unattributed++;
      unresolved++;
      continue;
    }
    resolved++;
    const g = `${agent}\0${keyOf(p.entry)}\0${p.shape}`;
    (groups.get(g) ?? groups.set(g, []).get(g)!).push(p);
  }
  for (const [g, ps] of groups) {
    const [agent, , shape] = g.split("\0") as [string, string, FramePairing["shape"]];
    const key = keyOf(ps[0]!.entry!);
    const candidates = o.entries.filter((e) => e.agentId === agent && keyOf(e) === key && VERDICTS[shape].includes(e.verdict));
    ps.forEach((p, i) => {
      const streamed = p.entry!;
      const target = candidates[i];
      if (target === streamed && !toolUseOf.has(target)) {
        toolUseOf.set(target, { toolUseId: p.toolUseId });
        return;
      }
      if (target && !toolUseOf.has(target) && serveRecord(target) === serveRecord(streamed)) {
        toolUseOf.set(target, { toolUseId: p.toolUseId, reassignedFrom: streamed.ordinal });
        reassigned++;
        return;
      }
      // Not moved: the stream's pairing stays, unconfirmed.
      if (!toolUseOf.has(streamed)) toolUseOf.set(streamed, { toolUseId: p.toolUseId, provisional: true });
      else extra.push({ toolUseId: p.toolUseId, provisional: true });
      unattributed++;
      uncertain++;
    });
  }
  // Dispatches resolved to agents, yet none of the parented results resolved: a renamed id would look like this.
  if (unresolved > 0 && resolved === 0 && o.dispatchAgents.size > 0) uncertain += unresolved;

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
      ...(t?.provisional ? { provisional: true as const } : {}),
      ...(t?.reassignedFrom !== undefined ? { reassignedFrom: t.reassignedFrom } : {}),
    };
  });
  return { calls: [...calls, ...extra], reassigned, unattributed, unattributedExpected, attributionUncertain: uncertain };
}
