// Case ids for hillclimb flows and frozen pairwise references. ONE copy: the runner, the ref store and
// `record --case` all key on these, so a second implementation would let a row, its trace and its frozen
// reference disagree about which case they belong to.
//
// Behaviour is the scaffold's (runner-scaffold.mjs, bundle 2.1.285, l.325-339 and l.415-423), pinned by
// test/hillclimb-ids.test.ts.

import { createHash } from "node:crypto";

/** The path-safe form of a case id. An id that is already path-safe and at most 129 chars passes through
 *  unchanged (so this is idempotent); anything else is cleaned to `[\w.-]`, cut to 120 chars and suffixed
 *  with 8 hex of sha256(original), which keeps `case/1` and `case_1` distinct. */
export function pathSafeId(id: string): string {
  const raw = String(id);
  const cleaned = raw.replace(/[^\w.-]/g, "_");
  // The scaffold's exact test, not isPathSafeId: they differ on the empty id, which the scaffold passes through.
  if (cleaned === raw && raw.length <= 129) return raw;
  return `${cleaned.slice(0, 120)}-${createHash("sha256").update(raw).digest("hex").slice(0, 8)}`;
}

/** Ids whose path-safe forms collide case-insensitively — macOS and Windows filesystems fold case, so two
 *  such cases would overwrite each other's traces and frozen references. Each entry names the later id and
 *  the earlier one it collides with. Empty when the id space is clean. */
export function findDuplicateCaseIds(ids: readonly string[]): Array<{ id: string; collidesWith: string }> {
  const seen = new Map<string, string>();
  const out: Array<{ id: string; collidesWith: string }> = [];
  for (const id of ids) {
    const k = pathSafeId(id).toLowerCase();
    const prev = seen.get(k);
    if (prev !== undefined) out.push({ id, collidesWith: prev });
    else seen.set(k, id);
  }
  return out;
}
