import { readFileSync, statSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { turnArtifactPath } from "../run/turn-layout.js";

// Foundations for the reflective skill-critique loop's UNCONTAMINATED, MECHANICALLY-GROUNDED evidence.
//
// Two properties the loop's safety claim depends on (and that a prompt instruction alone cannot give):
//  1. TURN-1-ONLY evidence. `events.jsonl` / `timeline.jsonl` are append-only with no turn markers, so a
//     resume (reflection) turn's own tool reads would otherwise pollute the "ground truth" the evaluator
//     checks the self-report against. We snapshot the byte boundary BEFORE the reflection turn and only
//     ever read `[0, boundary)` — the task turn's events. (JSONL appends whole lines, so a byte length is
//     always a clean line boundary.) `turns/1/result.json` is the turn-1 result.
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
interface StreamBoundary {
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
 *  legitimately absent (not yet created) — i.e. the boundary itself was never established (`size: null`)
 *  AND the file still doesn't exist, the ordinary "this stream was never written" case. THROWS if:
 *   - the boundary was never established (`size: null`) but the file DOES exist now (a stat failure at
 *     capture time on a file that turns out to be there is unavailable, not a zero-byte slice); or
 *   - the boundary was POSITIVE (non-zero bytes were captured) and the file is now missing or unreadable —
 *     genuine captured content must never be reported back as an empty slice (F28 residual: the original
 *     check order tested existence BEFORE inspecting the boundary, so a captured, non-empty stream that was
 *     deleted before packaging slipped past as "" instead of aborting).
 *  A boundary of exactly 0 bytes (the stream was genuinely empty at capture) always returns "" without even
 *  touching the file's current state — the captured slice is definitionally empty regardless of what
 *  happens to the file afterward, so that case must never be treated as an integrity failure. */
export function readTurn1Slice(outDir: string, file: "events.jsonl" | "timeline.jsonl", boundary: TurnBoundary): string {
  const path = join(outDir, file);
  const sb = streamBoundary(boundary, file);
  const exists = existsSync(path);

  if (sb.size === null) {
    if (!exists) return ""; // legitimately never created — orthogonal to a stat ERROR on a file that exists
    throw new Error(
      `readTurn1Slice: the turn-1/turn-2 boundary for ${file} was never established (snapshotTurnBoundary's ` +
        `stat failed) — refusing to treat that as a zero-byte slice.`,
    );
  }

  if (sb.size === 0) return ""; // captured empty at boundary time; nothing to read regardless of current state

  // sb.size > 0: a non-empty turn-1 region was captured. The file must still be present and readable, or
  // the slice we'd hand back would misrepresent genuine captured content as "nothing happened here."
  if (!exists) {
    throw new Error(
      `readTurn1Slice: ${file} had a captured turn-1 boundary of ${sb.size} bytes but the file is now missing — ` +
        `refusing to treat captured content as an empty slice.`,
    );
  }
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch (err) {
    throw new Error(
      `readTurn1Slice: ${file} had a captured turn-1 boundary of ${sb.size} bytes but could not be read ` +
        `(${(err as Error).message}) — refusing to treat captured content as an empty slice.`,
    );
  }
  // F29 residual: a stream truncated BELOW its captured boundary (e.g. 50KB→10KB) must not silently hand
  // back a SHORT slice as if it were the full turn-1 region — that is exactly the "looks like ok, isn't"
  // shape this whole module exists to prevent. A short read is therefore its own abort condition, distinct
  // from (and checked in addition to) `verifyBoundaryIntegrity`'s prefix-hash tripwire.
  if (buf.length < sb.size) {
    throw new Error(
      `readTurn1Slice: ${file} is now ${buf.length} bytes, SHORTER than its captured turn-1 boundary (${sb.size}) — ` +
        `the stream was truncated below the already-captured boundary; refusing to silently return a short slice as if it were the full turn-1 region.`,
    );
  }
  return buf.subarray(0, sb.size).toString("utf8");
}

export type BoundaryIntegrity = "ok" | "mismatch" | "unavailable" | "unreadable";

/** Defense-in-depth (F29). The turn-1 slicing above assumes the streams are append-only by CONVENTION, not
 *  by a filesystem guarantee — nothing stops a truncate/replace of `[0, boundary)` between the boundary
 *  snapshot and packaging. Re-hash the same prefix captured at `snapshotTurnBoundary` time and compare: a
 *  mismatch means the bytes under the boundary changed, so the slice can no longer be trusted as ground
 *  truth (surfaced as a DEGRADED signal by the caller, not silently ignored).
 *
 *  Returns `"unavailable"` when there is BENIGNLY nothing to compare against — the boundary was never
 *  established, or the stream was genuinely empty (`size: 0`) at capture time — neither of which implies
 *  anything went wrong. Returns the DISTINCT `"unreadable"` when a POSITIVE boundary was captured (there was
 *  something to compare against) but the file is now missing or its prefix can no longer be read — that is
 *  itself an integrity failure (captured content can't be verified, not "nothing captured"), so callers must
 *  not fold it into the benign `"unavailable"` case. */
export function verifyBoundaryIntegrity(
  outDir: string,
  file: "events.jsonl" | "timeline.jsonl",
  boundary: TurnBoundary,
): BoundaryIntegrity {
  const sb = streamBoundary(boundary, file);
  if (sb.size === null || sb.prefixHash === undefined) return "unavailable";
  const path = join(outDir, file);
  if (!existsSync(path)) return "unreadable";
  let currentSize: number;
  try {
    currentSize = statSync(path).size;
  } catch {
    return "unreadable";
  }
  // F29 residual: a stream truncated BELOW its captured boundary (e.g. 50KB→10KB) keeps its first
  // PREFIX_HASH_BYTES bytes byte-for-byte intact — the prefix-hash compare alone would report "ok" even
  // though everything from the new (smaller) EOF up to the captured boundary is now GONE, and
  // `readTurn1Slice` would silently hand back a short slice instead of the full turn-1 region. A byte-length
  // regression below the captured boundary is therefore its own mismatch condition, checked BEFORE (and
  // independent of) the prefix-hash compare below — a plain "did the length shrink" check the hash alone
  // cannot express.
  if (currentSize < sb.size) return "mismatch";
  let current: string;
  try {
    current = hashPrefix(readPrefixBytes(path, Math.min(sb.size, PREFIX_HASH_BYTES)));
  } catch {
    return "unreadable";
  }
  return current === sb.prefixHash ? "ok" : "mismatch";
}

export type Turn1ResultStatus = "ok" | "missing" | "corrupted";

/** Like `readTurn1Result`, but also reports WHY a null came back (F30): `"corrupted"` when turn 1's
 *  `result.json` (`turns/1/result.json` — see `turn-layout.ts`) existed but failed to parse, vs.
 *  `"missing"` when it doesn't exist at all.
 *
 *  `requireArchive` PREDATES the per-turn `turns/<N>/` layout, from when an un-resumed run's turn 1 lived
 *  at the run-dir root and a resumed run's turn 1 was archived to `result.turn-1.json` — two different
 *  files, and this flag chose which one was authoritative. Under the single shape `turnArtifactPath`
 *  always resolves turn 1 to the same file (`turns/1/result.json`) regardless of resume history, so the
 *  flag no longer changes what gets READ here. It is kept — inert — because its CALLER
 *  (`package-evidence.ts`) still uses the boolean it's passed (`isResume`) to decide whether a "missing"
 *  status counts as degraded, which is an orthogonal, still-meaningful question. Left for the sweep that
 *  simplifies all three degraded-status call sites together, not as a drive-by here. */
export function readTurn1ResultWithStatus(outDir: string, requireArchive = false): { value: unknown | null; status: Turn1ResultStatus } {
  void requireArchive; // see doc comment — inert until the degraded-status sweep
  const p = turnArtifactPath(outDir, 1, "result.json");
  if (existsSync(p)) {
    try {
      return { value: JSON.parse(readFileSync(p, "utf8")), status: "ok" };
    } catch {
      return { value: null, status: "corrupted" };
    }
  }
  return { value: null, status: "missing" };
}

/** The turn-1 result (`turns/1/result.json`). Returns the parsed object or null. See
 *  `readTurn1ResultWithStatus` for a version that distinguishes "corrupt" from "missing" (F30) — this
 *  wrapper preserves the original value-only contract for existing callers. */
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
