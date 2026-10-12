// A metric declaration's signature: what its column means. Stamped on every hillclimb row (`meta.metric_sigs`),
// recorded with every command-metric measurement, and frozen in an eval's manifest, so a column can never silently
// change meaning.
import { createHash } from "node:crypto";
import type { ScenarioMetric } from "./types.js";
import { DEFAULT_COMMAND_TIMEOUT_MS, resolvedCommand } from "./metric-command/resolve.js";

/** The canonical declaration tuple. The id is folded to lower case (ids compare case-insensitively), an absent `min`
 *  is its schema default 0, and any other absent field is `null`, so key order and an explicit `undefined` never
 *  change it. An artifact metric's tuple is exactly what it was before command metrics existed (so every existing
 *  flow keeps its sigs); a command metric appends `["command", scriptRel, args, depsRel, timeout_ms, scriptSha256]` —
 *  the script by its ROOT-relative path (two scenarios in different directories naming the same script agree), the
 *  literal args, the deps by root-relative path in declaration order, the timeout, and the content hash.
 *  `withContent: false` drops the hash (replay compares declarations without reading disk) — and needs no resolution
 *  for the paths: it uses the paths as written. */
export function declTuple(m: ScenarioMetric, o: { withContent?: boolean } = {}): string {
  const base: unknown[] = [m.id.toLowerCase(), m.artifact, m.path, m.better, m.scale ?? null, m.unbounded ?? null, m.min ?? 0];
  if (m.command === undefined) return JSON.stringify(base);
  const timeout = m.timeout_ms ?? DEFAULT_COMMAND_TIMEOUT_MS;
  if (o.withContent === false) return JSON.stringify([...base, "command", m.command, m.deps ?? [], timeout]);
  const r = resolvedCommand(m);
  if (r === undefined)
    throw new Error(`metric "${m.id}": a command metric's signature needs its files resolved first (resolveCommandMetrics)`);
  return JSON.stringify([...base, "command", r.scriptRel, m.command.slice(1), r.depsRel, timeout, r.scriptSha256]);
}

/** The first 16 hex chars of the sha256 of the canonical tuple. Throws for an unresolved command metric — a sig that
 *  silently went missing would let a changed scorer write into an old column. */
export const metricSig = (m: ScenarioMetric): string => createHash("sha256").update(declTuple(m)).digest("hex").slice(0, 16);
