/**
 * The agent-side feature values that shape a live WebSearch, read from Desktop's per-session GrowthBook cache.
 *
 * These are the agent's own `tengu_*` features, not Desktop gates, so they are not in the fcache `sync` decodes.
 * Desktop writes them to `local-agent-mode-sessions/<org>/<session>/cowork-gb-cache.json`
 * (`cachedGrowthBookFeatures`). Recorded so a frozen-versus-live comparison knows what live search did:
 * - `tengu_plum_vx3`: the nested search runs on the small/fast model instead of the main-loop model;
 * - `tengu_sleepy_shore`: the fast search profile;
 * - `tengu_gzip_request_bodies`, `tengu_buzzing_pike`: request-body compression, which a proxy env turns off.
 *
 * Values are recorded raw (their shapes differ: a boolean, an object, a number). The newest file is the source; a
 * key whose value differs in another file that also has it is listed in `disagreeing` (several orgs or a mid-rollout refetch).
 * Nothing that identifies an org or a session is recorded, because the baseline is public.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentSearchGates } from "../types.js";

export const AGENT_SEARCH_GATE_KEYS = ["tengu_plum_vx3", "tengu_sleepy_shore", "tengu_gzip_request_bodies", "tengu_buzzing_pike"] as const;

/** A value larger than this, as canonical JSON, is withheld rather than published. */
export const AGENT_SEARCH_GATE_MAX_JSON = 256;

const FILE = "cowork-gb-cache.json";

function cacheFiles(dir: string): { path: string; mtimeMs: number }[] {
  const out: { path: string; mtimeMs: number }[] = [];
  let orgs: string[];
  try {
    orgs = readdirSync(dir);
  } catch {
    return out;
  }
  for (const org of orgs) {
    let sessions: string[];
    try {
      sessions = readdirSync(join(dir, org));
    } catch {
      continue;
    }
    for (const s of sessions) {
      const p = join(dir, org, s, FILE);
      try {
        out.push({ path: p, mtimeMs: statSync(p).mtimeMs });
      } catch {
        // no cache file in this session dir
      }
    }
  }
  return out;
}

function features(path: string): Record<string, unknown> | null {
  try {
    const f = (JSON.parse(readFileSync(path, "utf8")) as { cachedGrowthBookFeatures?: unknown }).cachedGrowthBookFeatures;
    return f && typeof f === "object" && !Array.isArray(f) ? (f as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Read the four keys from every `cowork-gb-cache.json` under `sessionsDir` (Desktop's `local-agent-mode-sessions`). */
export function readAgentSearchGates(sessionsDir: string): AgentSearchGates {
  const read = cacheFiles(sessionsDir)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((f) => features(f.path))
    .filter((f): f is Record<string, unknown> => f !== null);
  if (read.length === 0) return { observed: false };
  const [newest, ...others] = read;
  const values: Record<string, unknown> = {};
  type Key = (typeof AGENT_SEARCH_GATE_KEYS)[number];
  const absent: Key[] = [];
  const withheld: Key[] = [];
  const disagreeing: Key[] = [];
  for (const k of AGENT_SEARCH_GATE_KEYS) {
    const v = newest![k];
    if (v === undefined) absent.push(k);
    else if (JSON.stringify(v).length > AGENT_SEARCH_GATE_MAX_JSON) withheld.push(k);
    else values[k] = v;
    // A file without the key predates the feature's fetch; only a different value present in both disagrees.
    if (others.some((o) => o[k] !== undefined && JSON.stringify(o[k]) !== JSON.stringify(v))) disagreeing.push(k);
  }
  return {
    observed: true,
    files: read.length,
    values,
    ...(absent.length ? { absent } : {}),
    ...(withheld.length ? { withheld } : {}),
    ...(disagreeing.length ? { disagreeing } : {}),
  };
}
