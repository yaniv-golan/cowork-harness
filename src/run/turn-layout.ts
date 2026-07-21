// Addressing the PER-TURN artifacts of a run directory: `result.json`, `run.jsonl`, `trace.json`,
// `resources.jsonl`.
//
// A LEAF module (like `turn-events.ts`): imported by cli.ts, run/*, critique/*, runtime/*, so it must not
// import back into any of them.
//
// WHY THIS EXISTS. A run directory can hold several turns (any `--resume`, and every `critique` = task
// turn + reflection turn). Today a turn is addressed three different ways depending on which turn it is:
// the LATEST lives at the root under its plain name, earlier ones are name-mangled archives
// (`result.turn-1.json`), and `critique` writes role aliases (`result.graded.json`). Every reader
// re-derived that mapping, and most of them got it wrong at least once — a wrong-turn read, a destroyed
// trace, a dropped index row.
//
// This module is the ONE place that knows the mapping. It is deliberately introduced BEFORE any layout
// change, over today's on-disk shape, so the layout flip becomes a change to this file rather than a
// change to twenty call sites.
//
// It must keep resolving the legacy shape PERMANENTLY, not transitionally: `chat` writes a root
// `result.json` and never participates in turn bookkeeping, so freshly created chat run dirs are
// legacy-shaped forever.

import { existsSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** The four artifacts written once per turn. Anything else in a run dir is cumulative or session state. */
export const PER_TURN_ARTIFACTS = ["result.json", "run.jsonl", "trace.json", "resources.jsonl"] as const;
export type PerTurnArtifact = (typeof PER_TURN_ARTIFACTS)[number];

/** `result.json` -> `result`, `run.jsonl` -> `run` — the stem used by the legacy archive names. */
function stemAndExt(artifact: PerTurnArtifact): { stem: string; ext: string } {
  const i = artifact.indexOf(".");
  return { stem: artifact.slice(0, i), ext: artifact.slice(i) };
}

/** Turn numbers present in `turns/`, ascending.
 *
 *  ANCHORED match on purpose: a `parseInt`-style scan happily reads `2junk` as turn 2, which would let a
 *  stray directory shift every turn number in the run dir. */
function turnsDirNumbers(outDir: string): number[] {
  try {
    return readdirSync(join(outDir, "turns"))
      .filter((e) => /^\d+$/.test(e))
      .map(Number)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/** Legacy archive numbers, from `result.turn-<N>.json` at the run-dir root. */
function legacyArchiveNumbers(outDir: string): number[] {
  try {
    return readdirSync(outDir)
      .map((e) => /^result\.turn-(\d+)\.json$/.exec(e)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/** Does this run dir use the per-turn directory layout? */
export function hasTurnDirs(outDir: string): boolean {
  return turnsDirNumbers(outDir).length > 0;
}

/** Every turn number addressable in this run dir, ascending. A single-turn dir is `[1]`. */
export function listTurns(outDir: string): number[] {
  const dirs = turnsDirNumbers(outDir);
  // A MIXED dir carries both, so union them — see turnArtifactPath. Sorted+deduped so a turn present in
  // both shapes is listed once.
  if (dirs.length) return [...new Set([...legacyArchiveNumbers(outDir), ...dirs])].sort((a, b) => a - b);
  const legacy = legacyArchiveNumbers(outDir);
  // The root file is the LATEST turn, so it is one past the highest archive (or turn 1 when there are none).
  if (existsSync(join(outDir, "result.json"))) return [...legacy, (legacy[legacy.length - 1] ?? 0) + 1];
  return legacy;
}

export function latestTurn(outDir: string): number | undefined {
  const all = listTurns(outDir);
  return all.length ? all[all.length - 1] : undefined;
}

/** Absolute path to one artifact of one turn — the accessor every reader should use.
 *
 *  Per-ARTIFACT rather than per-directory because the legacy shape has no per-turn directory: earlier
 *  turns are name-mangled at the root (`run.turn-1.jsonl`), so a `turnDir()`-only API could not address
 *  them at all. Returns a path whether or not the file exists; callers test existence as they do today. */
export function turnArtifactPath(outDir: string, turn: number, artifact: PerTurnArtifact): string {
  if (hasTurnDirs(outDir)) {
    const inTurnDir = join(outDir, "turns", String(turn), artifact);
    if (existsSync(inTurnDir)) return inTurnDir;
    // MIXED dir: a legacy dir resumed under the new code has turn 1 as a root archive and turn 2 in
    // `turns/`. Treating `hasTurnDirs` as all-or-nothing made the archived turn UNADDRESSABLE — and a
    // scratch reindex then dropped its row, reintroducing the dropped-turn defect for the whole upgrade
    // cohort. Fall back to the legacy name before giving up.
    const { stem, ext } = stemAndExt(artifact);
    const archived = join(outDir, `${stem}.turn-${turn}${ext}`);
    if (existsSync(archived)) return archived;
    return inTurnDir; // nothing on disk — return the canonical path so callers report the right miss
  }
  const latest = latestTurn(outDir);
  if (turn === latest) return join(outDir, artifact); // the root file IS the latest turn
  // A legacy dir with NO archives is single-turn by definition, so turn 1 is the root — even when
  // `result.json` is absent and `latestTurn` therefore could not infer it. Without this, addressing
  // `trace.json` in a run whose result assembly never completed silently resolved to a nonexistent
  // `trace.turn-1.json`. Caught by an existing guard, not by inspection.
  if (turn === 1 && legacyArchiveNumbers(outDir).length === 0) return join(outDir, artifact);
  const { stem, ext } = stemAndExt(artifact);
  return join(outDir, `${stem}.turn-${turn}${ext}`);
}

/** A turn's parsed `result.json`, or undefined when absent/unreadable.
 *
 *  `strict` refuses to fall back to the root file. `critique`'s turn-1 isolation depends on reading the
 *  ARCHIVED turn-1 result specifically: when a resume is known to have happened, the root file is turn 2,
 *  and silently substituting it would contaminate turn-1-only evidence. */
export function readTurnResult(outDir: string, turn: number, opts: { strict?: boolean } = {}): unknown | undefined {
  const p = turnArtifactPath(outDir, turn, "result.json");
  if (opts.strict && !hasTurnDirs(outDir) && turn === latestTurn(outDir) && legacyArchiveNumbers(outDir).length === 0) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return undefined;
  }
}

/** The GRADED turn's artifact for a `critique` run dir.
 *
 *  Role, not number: a consumer asks "which turn was graded?", never "which number was it?". Prefers the
 *  stable `*.graded.json` alias `critique` writes, because it is correct the moment it is written and
 *  survives a reflection turn that never completed; falls back to turn 1. */
export function resolveGraded(outDir: string, artifact: "result.json" | "trace.json"): string | undefined {
  const { stem, ext } = stemAndExt(artifact);
  const alias = join(outDir, `${stem}.graded${ext}`);
  if (existsSync(alias)) return alias;
  const byTurn = turnArtifactPath(outDir, 1, artifact);
  return existsSync(byTurn) ? byTurn : undefined;
}

/** The directory this turn's artifacts are WRITTEN to, created if needed.
 *
 *  Writers use this; readers use `turnArtifactPath`. Separate because a writer always knows its own turn
 *  number and always uses the new layout, while a reader must also resolve legacy dirs. */
export function turnWriteDir(outDir: string, turn: number): string {
  const d = join(outDir, "turns", String(turn));
  mkdirSync(d, { recursive: true });
  return d;
}

/** Turn detection: one past the highest turn that has a `run.jsonl`.
 *
 *  KEYED ON `run.jsonl`, NOT `result.json`, and that is the whole crash contract. The writer emits
 *  `run.jsonl` BEFORE `result.json` (see execute.ts's ordering comment — "Order matters, do not swap"), so
 *  a crash between the two leaves a turn whose transcript is COMPLETE and whose result assembly failed.
 *  That is a real, paid, history-advancing turn: the model produced it and the session moved on. Counting
 *  it as done is what stops a retry from overwriting it.
 *
 *  An earlier draft of this keyed on `result.json` and would have called that shape incomplete — letting
 *  the retry clobber a completed transcript, and (on a retried turn 1, which gets no events marker) fusing
 *  two attempts' events into one verdict. An adversarial review caught it by prototype.
 *
 *  `mkdir` without a `run.jsonl` is therefore NOT a turn: a crash right after creating the directory
 *  leaves it reusable rather than inflating every later turn number. */
export function currentTurnFromDirs(outDir: string): number {
  const withTranscript = turnsDirNumbers(outDir).filter((n) => existsSync(join(outDir, "turns", String(n), "run.jsonl")));
  // MIXED dirs: a legacy dir resumed under the new code has turn 1 as a ROOT archive and turn 2 as a turn
  // dir. Counting only turn dirs made the number go BACKWARDS (2 -> 1) on the next resume, because the
  // archived turn is invisible to this rule — and a turn number that decreases would overwrite a
  // completed turn. Take the highest turn either shape knows about.
  const legacy = legacyArchiveNumbers(outDir);
  const highest = Math.max(withTranscript[withTranscript.length - 1] ?? 0, legacy[legacy.length - 1] ?? 0);
  return highest + 1;
}
