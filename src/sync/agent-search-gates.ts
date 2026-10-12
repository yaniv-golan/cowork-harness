/**
 * The agent-side feature values that shape a live WebSearch, read from Desktop's GrowthBook cache for the organisation
 * the gate cache was captured under.
 *
 * These are the agent's own `tengu_*` features, not Desktop gates, so they are not in the fcache `sync` decodes.
 * Desktop writes them to `local-agent-mode-sessions/<account>/<org>/cowork-gb-cache.json` (`cachedGrowthBookFeatures`),
 * one file per account and organisation (MEASURED 2026-10-12: the second path level is the organisation id). Recorded
 * so a frozen-versus-live comparison knows what live search did:
 * - `tengu_plum_vx3`: the nested search runs on the small/fast model instead of the main-loop model;
 * - `tengu_sleepy_shore`: the fast search profile;
 * - `tengu_gzip_request_bodies`, `tengu_buzzing_pike`: request-body compression, which a proxy env turns off.
 *
 * Values are recorded raw (their shapes differ). The newest of the organisation's files is the source; a key whose
 * value differs in another of its files that also has it is listed in `disagreeing`; a value that is not a boolean,
 * a number or a flat object of them is `withheld`. Nothing that identifies an account or an organisation is recorded,
 * because the baseline is public.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { AGENT_SEARCH_GATE_KEYS, AgentSearchGates } from "../types.js";

export { AGENT_SEARCH_GATE_KEYS };

/** A value larger than this, as canonical JSON, is withheld rather than published. */
export const AGENT_SEARCH_GATE_MAX_JSON = 256;

const FILE = "cowork-gb-cache.json";

/** The schema's per-value shape, so the reader withholds exactly what the schema would refuse. */
const valueSchema = AgentSearchGates.options[0].shape.values.valueType;

/** The organisation's caches: `<sessionsDir>/<account>/<orgId>/cowork-gb-cache.json`, one per account. */
function cacheFiles(dir: string, orgId: string): { path: string; mtimeMs: number }[] {
  const out: { path: string; mtimeMs: number }[] = [];
  let accounts: string[];
  try {
    accounts = readdirSync(dir);
  } catch {
    return out;
  }
  for (const account of accounts) {
    const p = join(dir, account, orgId, FILE);
    try {
      out.push({ path: p, mtimeMs: statSync(p).mtimeMs });
    } catch {
      // this account has no cache for the organisation
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

/** Read the four keys from the capture organisation's `cowork-gb-cache.json` under `sessionsDir` (Desktop's
 *  `local-agent-mode-sessions`). `orgId` null (the organisation could not be told) records `observed: false`: another
 *  organisation's values would be the wrong ones. */
export function readAgentSearchGates(sessionsDir: string, orgId: string | null): AgentSearchGates {
  if (orgId === null) return { observed: false };
  const read = cacheFiles(sessionsDir, orgId)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((f) => ({ mtimeMs: f.mtimeMs, features: features(f.path) }))
    .filter((f): f is { mtimeMs: number; features: Record<string, unknown> } => f.features !== null);
  if (read.length === 0) return { observed: false };
  const newest = read[0]!.features;
  const others = read.slice(1).map((f) => f.features);
  const values: Record<string, unknown> = {};
  type Key = (typeof AGENT_SEARCH_GATE_KEYS)[number];
  const absent: Key[] = [];
  const withheld: Key[] = [];
  const disagreeing: Key[] = [];
  for (const k of AGENT_SEARCH_GATE_KEYS) {
    const v = newest[k];
    if (v === undefined) absent.push(k);
    // Published only as a boolean, a number or a flat object of them (the schema's shape): a payload string could
    // carry an identifier, and the baseline is public.
    else if (JSON.stringify(v).length > AGENT_SEARCH_GATE_MAX_JSON || !valueSchema.safeParse(v).success) withheld.push(k);
    else values[k] = v;
    // A key absent from either file predates that file's fetch; only two different values present in both disagree.
    if (v !== undefined && others.some((o) => o[k] !== undefined && JSON.stringify(o[k]) !== JSON.stringify(v))) disagreeing.push(k);
  }
  return {
    observed: true,
    files: read.length,
    newestDate: new Date(read[0]!.mtimeMs).toISOString().slice(0, 10),
    values,
    ...(absent.length ? { absent } : {}),
    ...(withheld.length ? { withheld } : {}),
    ...(disagreeing.length ? { disagreeing } : {}),
  };
}
