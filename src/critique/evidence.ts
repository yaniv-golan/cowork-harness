import { readFileSync, statSync, existsSync } from "node:fs";
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

/** Byte lengths of the append-only streams at the moment this is called — the turn-1/turn-2 boundary when
 *  captured right before a resume (reflection) turn. */
export interface TurnBoundary {
  events: number;
  timeline: number;
}

export function snapshotTurnBoundary(outDir: string): TurnBoundary {
  const size = (f: string): number => {
    try {
      return statSync(join(outDir, f)).size;
    } catch {
      return 0;
    }
  };
  return { events: size("events.jsonl"), timeline: size("timeline.jsonl") };
}

/** The task-turn (turn-1) slice of an append-only stream: bytes `[0, boundary)`. Returns "" if absent. */
export function readTurn1Slice(outDir: string, file: "events.jsonl" | "timeline.jsonl", boundary: TurnBoundary): string {
  const path = join(outDir, file);
  if (!existsSync(path)) return "";
  const end = file === "events.jsonl" ? boundary.events : boundary.timeline;
  const buf = readFileSync(path);
  return buf.subarray(0, Math.min(end, buf.length)).toString("utf8");
}

/** The turn-1 result (falls back to the archived `result.turn-1.json`; if a run never resumed there is no
 *  archive and `result.json` IS turn 1). Returns the parsed object or null. */
export function readTurn1Result(outDir: string): unknown | null {
  for (const f of ["result.turn-1.json", "result.json"]) {
    const p = join(outDir, f);
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, "utf8"));
      } catch {
        return null;
      }
    }
  }
  return null;
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
