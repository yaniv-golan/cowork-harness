import { readFileSync, statSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

// Foundations for the reflective skill-critique loop's UNCONTAMINATED, MECHANICALLY-GROUNDED evidence.
//
// Two properties the loop's safety claim depends on (and that a prompt instruction alone cannot give):
//  1. TURN-1-ONLY evidence. `events.jsonl` / `timeline.jsonl` are append-only with no turn markers, so a
//     resume (reflection) turn's own tool reads would otherwise pollute the "ground truth" the evaluator
//     checks the self-report against. We snapshot the byte boundary BEFORE the reflection turn and only
//     ever read `[0, boundary)` — the task turn's events. (JSONL appends whole lines, so a byte length is
//     always a clean line boundary.) `result.turn-1.json` (already archived by the run dir) is the turn-1
//     result.
//  2. MECHANICAL citation grounding. The evaluator is a tool-less model; its cited evidence is free text.
//     We VALIDATE each citation is a verbatim excerpt of the evidence package we handed it, and drop those
//     that don't resolve — so a hallucinated citation can't ship a recommendation.

/** Bytes of the stream's prefix hashed for the defense-in-depth integrity check (`verifyBoundaryIntegrity`).
 *  Small and fixed — this is NOT a full-slice content guarantee, just a cheap tripwire for "something
 *  rewrote the start of an append-only file," which a byte-length comparison alone cannot detect (a
 *  truncate-then-rewrite-to-the-same-length is invisible to a size check but not to a prefix hash). */
const PREFIX_HASH_BYTES = 4096;

function readPrefixBytes(path: string, n: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(n);
    const read = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function hashPrefix(buf: Buffer): string {
  return createHash("sha256")
    .update(buf.subarray(0, Math.min(buf.length, PREFIX_HASH_BYTES)))
    .digest("hex");
}

/** Per-stream boundary at capture time. `size: null` means the stat itself FAILED (ENOENT/EACCES/
 *  transient) — this must never be conflated with a genuine zero-byte file (`size: 0`), because a caller
 *  that treats the byte offset as "the turn-1 slice ends here" needs to know whether that offset is ground
 *  truth or simply unknown (F28). `prefixHash` is a cheap defense-in-depth tripwire (F29): re-verified by
 *  `verifyBoundaryIntegrity` at read time to catch the append-only invariant being violated
 *  (truncation/replacement of the already-captured region) between snapshot and packaging. */
export interface StreamBoundary {
  size: number | null;
  /** SHA-256 of the stream's first `PREFIX_HASH_BYTES` bytes at capture time. `undefined` when the stat
   *  failed (`size: null`) or the stream was empty at capture (nothing to hash). */
  prefixHash?: string;
}

/** Byte boundaries of the append-only streams at the moment this is called — the turn-1/turn-2 boundary
 *  when captured right before a resume (reflection) turn. */
export interface TurnBoundary {
  events: StreamBoundary;
  timeline: StreamBoundary;
}

function snapshotStream(outDir: string, f: string): StreamBoundary {
  const path = join(outDir, f);
  try {
    const st = statSync(path);
    if (st.size === 0) return { size: 0 };
    return { size: st.size, prefixHash: hashPrefix(readPrefixBytes(path, PREFIX_HASH_BYTES)) };
  } catch {
    return { size: null }; // stat/read failure — distinct from a real zero-byte boundary
  }
}

export function snapshotTurnBoundary(outDir: string): TurnBoundary {
  return { events: snapshotStream(outDir, "events.jsonl"), timeline: snapshotStream(outDir, "timeline.jsonl") };
}

function streamBoundary(boundary: TurnBoundary, file: "events.jsonl" | "timeline.jsonl"): StreamBoundary {
  return file === "events.jsonl" ? boundary.events : boundary.timeline;
}

/** The task-turn (turn-1) slice of an append-only stream: bytes `[0, boundary)`. Returns "" if the file is
 *  legitimately absent (not yet created). THROWS if the boundary for this stream was never established
 *  (`size: null`, i.e. the original `snapshotTurnBoundary` stat failed) — an unestablished required
 *  boundary must abort, not silently degrade to a zero-byte slice masquerading as ground truth (F28). */
export function readTurn1Slice(outDir: string, file: "events.jsonl" | "timeline.jsonl", boundary: TurnBoundary): string {
  const path = join(outDir, file);
  if (!existsSync(path)) return "";
  const sb = streamBoundary(boundary, file);
  if (sb.size === null) {
    throw new Error(
      `readTurn1Slice: the turn-1/turn-2 boundary for ${file} was never established (snapshotTurnBoundary's ` +
        `stat failed) — refusing to treat that as a zero-byte slice.`,
    );
  }
  const buf = readFileSync(path);
  return buf.subarray(0, Math.min(sb.size, buf.length)).toString("utf8");
}

export type BoundaryIntegrity = "ok" | "mismatch" | "unavailable";

/** Defense-in-depth (F29). The turn-1 slicing above assumes the streams are append-only by CONVENTION, not
 *  by a filesystem guarantee — nothing stops a truncate/replace of `[0, boundary)` between the boundary
 *  snapshot and packaging. Re-hash the same prefix captured at `snapshotTurnBoundary` time and compare: a
 *  mismatch means the bytes under the boundary changed, so the slice can no longer be trusted as ground
 *  truth (surfaced as a DEGRADED signal by the caller, not silently ignored). Returns `"unavailable"` when
 *  there is nothing to compare against (boundary unestablished, stream was empty at capture, or the file is
 *  now missing/unreadable) — that is a distinct state from a confirmed match.
 */
export function verifyBoundaryIntegrity(
  outDir: string,
  file: "events.jsonl" | "timeline.jsonl",
  boundary: TurnBoundary,
): BoundaryIntegrity {
  const sb = streamBoundary(boundary, file);
  if (sb.size === null || sb.prefixHash === undefined) return "unavailable";
  const path = join(outDir, file);
  if (!existsSync(path)) return "unavailable";
  let current: string;
  try {
    current = hashPrefix(readPrefixBytes(path, Math.min(sb.size, PREFIX_HASH_BYTES)));
  } catch {
    return "unavailable";
  }
  return current === sb.prefixHash ? "ok" : "mismatch";
}

export type Turn1ResultStatus = "ok" | "missing" | "corrupted";

/** Like `readTurn1Result`, but also reports WHY a null came back (F30): `"corrupted"` when the canonical
 *  turn-1 result file existed but failed to parse, vs. `"missing"` when neither `result.turn-1.json` nor
 *  `result.json` exists at all. Deliberately does NOT fall further down the preference list past a corrupt
 *  file — on a resumed session `result.json` is the TURN-2 result, and silently substituting it for a
 *  corrupt `result.turn-1.json` would contaminate turn-1 isolation. */
export function readTurn1ResultWithStatus(outDir: string): { value: unknown | null; status: Turn1ResultStatus } {
  for (const f of ["result.turn-1.json", "result.json"]) {
    const p = join(outDir, f);
    if (existsSync(p)) {
      try {
        return { value: JSON.parse(readFileSync(p, "utf8")), status: "ok" };
      } catch {
        return { value: null, status: "corrupted" };
      }
    }
  }
  return { value: null, status: "missing" };
}

/** The turn-1 result (falls back to the archived `result.turn-1.json`; if a run never resumed there is no
 *  archive and `result.json` IS turn 1). Returns the parsed object or null. See `readTurn1ResultWithStatus`
 *  for a version that distinguishes "corrupt" from "missing" (F30) — this wrapper preserves the original
 *  value-only contract for existing callers. */
export function readTurn1Result(outDir: string): unknown | null {
  return readTurn1ResultWithStatus(outDir).value;
}

/** Normalize whitespace for citation matching — models rarely reproduce exact spacing/newlines, so we
 *  compare on collapsed whitespace rather than byte-for-byte (still requires the literal token sequence). */
function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** A verbatim citation resolves iff its normalized text is a substring of the normalized evidence package.
 *  Short/empty citations (< `minLen` chars) never resolve — they'd match trivially and defeat the check. */
export function citationResolves(evidencePackage: string, citation: string, minLen = 12): boolean {
  const c = norm(citation);
  if (c.length < minLen) return false;
  return norm(evidencePackage).includes(c);
}

/** One triaged recommendation from the evaluator. */
export interface CritiqueItem {
  source: "self-report" | "evaluator";
  idea: string;
  classification: "grounded-and-actionable" | "grounded-but-not-worth-it" | "confabulated" | "already-covered" | "not-adjudicable";
  evidence: string; // the model's cited excerpt
  recommendedAction: string;
  citationResolved?: boolean; // set by validateItems
}

/** Mechanically validate each item's citation against the evidence package. An item whose citation doesn't
 *  resolve is FLAGGED (citationResolved:false) — the caller drops it from actionable output. A
 *  `not-adjudicable` item needs no citation (there is, by definition, no deciding evidence). */
export function validateCitations(items: CritiqueItem[], evidencePackage: string): CritiqueItem[] {
  return items.map((it) => ({
    ...it,
    citationResolved: it.classification === "not-adjudicable" ? true : citationResolves(evidencePackage, it.evidence),
  }));
}
