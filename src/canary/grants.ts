import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * B2 — per-version sub-agent grant canary. A committed `{agentType → declaredTools}` map is the
 * baseline; `cowork-harness sync` refreshes it on an agent-version bump. `verifyGrants` reports
 * drift, and `test/canary.test.ts` snapshots the map so any change is a RED diff in the failing
 * `unit` CI lane — "the new RC changed sub-agent grants" surfaces as a test failure, not a surprise.
 */
export interface SubagentLike {
  agentType: string;
  declaredTools: string[];
}
export type GrantMap = Record<string, string[]>;

export function loadGrantMap(path?: string): GrantMap {
  const p = path ?? join(fileURLToPath(new URL("../..", import.meta.url)), "fixtures", "subagent-grants.json");
  // #44: a read/parse failure previously `catch { return {} }`, silently disabling drift
  // detection — corruption is exactly when the B2 canary must fire, so THROW loud instead.
  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`corrupt subagent-grants fixture at ${p}: ${(e as Error).message} — run 'cowork-harness sync' to regenerate`);
  }
  // #44: `.grants ?? {}` previously coerced a missing/non-object key to an empty map (silent
  // empty drift). Validate it instead so a malformed fixture is a loud error, not a no-op.
  const grants = parsed?.grants;
  if (grants === null || typeof grants !== "object" || Array.isArray(grants)) {
    throw new Error(`corrupt subagent-grants fixture at ${p}: missing or non-object ".grants" — run 'cowork-harness sync' to regenerate`);
  }
  return grants as GrantMap;
}

/** Verify dispatched sub-agents against the committed map. Unknown agentTypes are NOT asserted
 *  (recorded as `unknown` upstream) so we never assert a false invariant. */
export function verifyGrants(subagents: SubagentLike[], map: GrantMap): { agentType: string; expected: string[]; actual: string[] }[] {
  const drift: { agentType: string; expected: string[]; actual: string[] }[] = [];
  for (const s of subagents) {
    const expected = map[s.agentType];
    if (expected === undefined) continue;
    const a = [...s.declaredTools].sort();
    const e = [...expected].sort();
    if (JSON.stringify(a) !== JSON.stringify(e)) drift.push({ agentType: s.agentType, expected: e, actual: a });
  }
  return drift;
}
