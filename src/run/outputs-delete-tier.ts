import type { OutputsFsDiff } from "../types.js";

/** The outputs-delete evidence a tier decision reads — exactly what `result.json` persists, so the live
 *  verdict, `verify-run` and the authored assertion reach the same answer without recomputing anything. */
export interface OutputsDeleteEvidence {
  outputsDeletes: string[];
  outputsDeleteBasis?: ("fs-diff" | "named" | "inferred")[];
}

export type OutputsDeleteTier = "none" | "warn" | "fail";

/**
 * How much authority the run's outputs-delete evidence carries.
 *
 * `fail` when:
 *   - the filesystem diff proved a deletion (a path present at turn start is gone); or
 *   - a flagged delete statement itself names an outputs path, or moves something out of outputs
 *     (`named` — covers a file the turn created and deleted, which the diff cannot see); or
 *   - the diff did not run or could not verify (`unavailable`, or absent — every result written before
 *     it existed), so a text hit is all there is; or
 *   - the per-entry basis is absent or does not line up with the entries — then nothing says a hit is
 *     merely inferred.
 * `warn` only when EVERY text hit is `inferred` AND the diff ran on complete walks and found nothing.
 * That is a positive state, not "could not verify": both detectors ran, and the only evidence is the
 * detector's inference (an unprovable target such as a Python variable named `rm`, or a relative `cd`
 * into outputs). Real deletes can land here too — in a loop, after a `cd`, through a chained or computed
 * variable — which is why it warns rather than going silent.
 */
export function outputsDeleteTier(scan: OutputsDeleteEvidence | undefined, fsDiff: OutputsFsDiff | undefined): OutputsDeleteTier {
  if (fsDiff?.findings.length) return "fail";
  const entries = scan?.outputsDeletes ?? [];
  if (entries.length === 0) return "none";
  const basis = scan?.outputsDeleteBasis;
  if (!basis || basis.length !== entries.length) return "fail";
  if (basis.some((b) => b !== "inferred")) return "fail";
  if (fsDiff?.status !== "clean") return "fail";
  return "warn";
}

/** The evidence strings behind a tier, fs-diff findings first, de-duplicated (a finding is also merged
 *  into `scan.outputsDeletes` when the scan exists). */
export function outputsDeleteEntries(scan: OutputsDeleteEvidence | undefined, fsDiff: OutputsFsDiff | undefined): string[] {
  return [...new Set([...(fsDiff?.findings ?? []), ...(scan?.outputsDeletes ?? [])])];
}
