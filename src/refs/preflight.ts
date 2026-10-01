// Checks that run before any spend for a scenario carrying `semantic_pairwise`. Pure over the filesystem:
// nothing here creates, writes or calls a model.

// The answer-key check (a reference store a mount exposes) is the shared `pathsInsideMounts`
// (src/hillclimb/answer-key.ts); callers pass every store a run will read.
import { readRefDoc } from "./store.js";

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
