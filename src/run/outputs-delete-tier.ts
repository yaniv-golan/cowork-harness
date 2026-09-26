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
 *   - a delete in command/call position has an outputs path as its own operand, or something is moved out of outputs
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
  // A persisted diff without a findings array (a hand-edited or truncated result.json) proves nothing
  // either way: read it as "did not verify" rather than throwing.
  const wellFormed = fsDiff !== undefined && Array.isArray(fsDiff.findings);
  if (wellFormed && fsDiff.findings.length) return "fail";
  const entries = scan?.outputsDeletes ?? [];
  if (entries.length === 0) return "none";
  if (!wellFormed) return "fail";
  const basis = scan?.outputsDeleteBasis;
  if (!basis || basis.length !== entries.length) return "fail";
  if (basis.some((b) => b !== "inferred")) return "fail";
  if (fsDiff?.status !== "clean") return "fail";
  return "warn";
}

/** True when a PRESENT diff could not verify the turn: the producer said `unavailable`, or the persisted
 *  object contradicts itself (no findings array, an unknown status, `findings` with nothing in it) — a
 *  hand-edited or truncated result.json. An ABSENT diff (legacy results, replay, chat) is not "unverified"
 *  here: those results keep the verdict they always had. Drives the `outputs_diff_unavailable` warn and the
 *  roster's `unverified`, so a diff that proves nothing is never read as a clean one. */
export function outputsDiffUnverified(fsDiff: OutputsFsDiff | undefined): boolean {
  if (fsDiff === undefined) return false;
  if (!Array.isArray(fsDiff.findings)) return true;
  if (fsDiff.status === "clean") return false;
  if (fsDiff.status === "findings") return fsDiff.findings.length === 0;
  return true;
}

/** The evidence strings behind a tier, fs-diff findings first, de-duplicated (a finding is also merged
 *  into `scan.outputsDeletes` when the scan exists). */
export function outputsDeleteEntries(scan: OutputsDeleteEvidence | undefined, fsDiff: OutputsFsDiff | undefined): string[] {
  const findings = Array.isArray(fsDiff?.findings) ? fsDiff.findings : [];
  return [...new Set([...findings, ...(scan?.outputsDeletes ?? [])])];
}
