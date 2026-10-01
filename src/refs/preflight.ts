// Checks that run before any spend for a scenario carrying `semantic_pairwise`. Pure over the filesystem:
// nothing here creates, writes or calls a model.

import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { containedRealPath } from "../boundary-paths.js";
import { readRefDoc } from "./store.js";

/** Reference stores the agent under test could read: each one that resolves inside a user-visible mount root.
 *  A frozen reference is the baseline's answer, so a run that can see it can copy it. A store that does not
 *  exist yet (a baseline about to freeze into it) is judged by its nearest existing ancestor. */
export function storesInsideMounts(stores: readonly string[], mountRoots: readonly string[]): Array<{ store: string; mount: string }> {
  const nearest = (p: string): string => {
    let cur = p;
    while (!existsSync(cur) && dirname(cur) !== cur) cur = dirname(cur);
    return cur;
  };
  const out: Array<{ store: string; mount: string }> = [];
  for (const store of stores) {
    const at = nearest(store);
    const mount = mountRoots.find((m) => existsSync(m) && containedRealPath(m, at));
    if (mount !== undefined) out.push({ store, mount });
  }
  return out;
}

export interface RefRequirement {
  caseId: string;
  assertIndex: number;
  refName: string;
  store: string;
  composeKey: string;
}

/** Every (case, assert, reference) a run will judge against must already resolve, with integrity, to a document
 *  for its compose key. Returns the misses — empty means the run may spend. Never reads a document's text out. */
export function checkRefsBeforeSpend(
  reqs: readonly RefRequirement[],
): Array<RefRequirement & { status: "missing" | "integrity"; message: string }> {
  const out: Array<RefRequirement & { status: "missing" | "integrity"; message: string }> = [];
  for (const r of reqs) {
    const got = readRefDoc(r.store, r.caseId, r.composeKey);
    if (got.status === "ok") continue;
    const remedy =
      got.status === "missing"
        ? "freeze one from a kept run with `ref freeze` (or, in a hillclimb flow, `hillclimb freeze-ref`)"
        : "a frozen reference is never repaired in place: freeze into a new store with `ref freeze` (or `hillclimb freeze-ref`)";
    out.push({
      ...r,
      status: got.status,
      message: `case ${r.caseId}, assert ${r.assertIndex}, reference "${r.refName}": ${got.why} — ${remedy}`,
    });
  }
  return out;
}
