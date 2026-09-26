import type { EvidenceSection } from "./armor.js";
import type { ResolvedAgent } from "./resolve-agents.js";
import { listSkillFilesRecursive } from "./corpus-walk.js";
import { resolveRootReferences, type OmissionReason } from "./resolve-references.js";
import { flattenTitle } from "./armor.js";
import { readFileSync, readdirSync, existsSync, statSync, realpathSync, type Dirent } from "node:fs";
import { join, basename, relative, resolve, sep, isAbsolute } from "node:path";
import { warn } from "../io.js";
import { gitAccept, gitModeEnabled, gitTrackedSet } from "../run/skill-files.js";
import { turnArtifactPath } from "../run/turn-layout.js";
import { readTurn1ResultWithStatus, readTurn1Slice, verifyBoundaryIntegrity, type TurnBoundary } from "./evidence.js";
import { unionReferenceAccesses } from "../run/run.js";
import { loadVmPathContext } from "../run/vm-path-ctx-file.js";

// Assembles the TURN-1-ONLY evidence document a tool-less, one-shot evaluator model is graded against.
// This packager is a from-scratch, load-bearing build (this instrument's design): a tool-less
// evaluator can't grep the logs itself, so its recall is bounded by exactly what this function decides to
// include. Every source read here is scoped to turn 1 (via `readTurn1Result`/`readTurn1Slice`, both of
// which already guarantee the reflection turn's own reads never leak in) — this module adds no new
// contamination risk, it only selects and bounds what gets shown.

/** Read the ARCHIVED turn-1 transcript out of `run.turn-1.jsonl`'s `{t:"transcript"}` line — the exact
 *  text `execute.ts` records for the completed task turn. Present once a resume has archived turn 1
 *  under `turns/1/`; if for any reason that file isn't there yet, fall back to the turn-1 slice of
 *  `events.jsonl` (still turn-1-only, just a rawer view than the assembled transcript string).
 *
 *  The fallback slice depends on the byte boundary `snapshotTurnBoundary` captured before the reflection
 *  turn — `degraded: true` means that dependency broke (F28: the boundary was never established, so
 *  `readTurn1Slice` refused rather than returning a false zero-byte slice; F29: the append-only prefix the
 *  boundary relies on changed between capture and packaging) and the returned text must NOT be treated as
 *  reliable ground truth by the evaluator. */
function readTurn1Transcript(runDir: string, boundary: TurnBoundary): { text: string; degraded: boolean } {
  // Through the seam: the new layout writes turn 1's transcript to `turns/1/run.jsonl` and NEVER creates
  // `run.turn-1.jsonl`. Probing only the legacy name made every new critique fall back to the raw
  // events-slice transcript with `degraded: false` — i.e. the evaluator silently graded a rawer view,
  // unflagged, which is exactly the kind of quiet degradation this pipeline exists to surface.
  const archived = turnArtifactPath(runDir, 1, "run.jsonl");
  if (existsSync(archived)) {
    try {
      // Resilient BUT honest: skip malformed lines (one bad line must not sink the read) yet COUNT them,
      // and count transcript records. A partly-corrupt archive (a skipped malformed row) or an ambiguous
      // one (≠ 1 transcript record) means the transcript's completeness is UNKNOWN — returning it as
      // `degraded: false` would let the evaluator grade a silently-incomplete view as clean ground truth,
      // the exact quiet degradation `turn1SliceDegraded` exists to surface. The whole (turn-1-only) archive
      // is already read into memory, so scanning every line costs no extra I/O.
      let malformed = 0;
      let transcript: string | undefined;
      let transcriptCount = 0;
      for (const line of readFileSync(archived, "utf8").split("\n")) {
        if (!line.trim()) continue;
        let obj: unknown;
        try {
          obj = JSON.parse(line);
        } catch {
          malformed++;
          continue;
        }
        const rec = obj as { t?: unknown; text?: unknown };
        if (rec.t === "transcript" && typeof rec.text === "string") {
          transcriptCount++;
          if (transcript === undefined) transcript = rec.text;
        }
      }
      if (transcript !== undefined) return { text: transcript, degraded: malformed > 0 || transcriptCount !== 1 };
    } catch {
      /* fall through to the slice fallback below */
    }
  }
  try {
    const text = readTurn1Slice(runDir, "events.jsonl", boundary);
    const integrity = verifyBoundaryIntegrity(runDir, "events.jsonl", boundary);
    // "unavailable" is benign (no boundary, or genuinely empty at capture) and must NOT degrade; "mismatch"
    // and "unreadable" both mean a positive captured boundary can no longer be trusted (tampered vs.
    // vanished/unreadable, respectively) and must both degrade. In practice `readTurn1Slice` above already
    // throws for the "unreadable" case (landing in the catch below), but this keeps the mapping correct on
    // its own terms rather than relying on that ordering.
    return { text, degraded: integrity === "mismatch" || integrity === "unreadable" };
  } catch {
    // F28/F28-residual: the boundary for events.jsonl was never established, OR a positive captured boundary's
    // file is now missing/unreadable/short — none of these is a valid empty slice.
    return { text: "", degraded: true };
  }
}

/** List of what was ATTACHED to this run — upload filenames + byte sizes, and connected-folder mount names.
 *  NEVER file content: the evaluator needs to be able to tell "the agent said there was no file, and
 *  correctly so" apart from "the agent confabulated that", but packaging the bytes themselves would blow
 *  the package's byte budget and widen the prompt-injection surface the armor exists to contain (see this
 *  module's header and `armor.ts`'s header) — names and sizes are enough to answer "was anything attached."
 *
 *  Source of truth, with fallbacks, in order:
 *   1. `loadVmPathContext(runDir)` (`run/vm-path-ctx-file.ts`) — the recorded `uploadsHostDir` and
 *      `folders` map for THIS run. Already never throws (absent/corrupt `mounts.json` -> `null`).
 *   2. The fixed container layout `<runDir>/work/session/mnt/uploads` (mirrors the derivation in
 *      `run/display-translate.ts`'s `vmPathContextFromPlan`) — covers runs where `mounts.json` wasn't
 *      written or couldn't be parsed.
 *   3. `(none)` — via `sec()`'s empty-body fallback below. Every filesystem read here is try/catch-guarded
 *      so a missing/unreadable uploads dir degrades gracefully rather than throwing and sinking packaging. */
function listAttachedInputs(runDir: string): string {
  const loaded = loadVmPathContext(runDir);
  const uploadsDir = loaded?.ctx.uploadsHostDir ?? join(runDir, "work", "session", "mnt", "uploads");
  const folderNames = loaded ? Array.from(loaded.ctx.folders.keys()).sort() : [];
  // `loadVmPathContext` returns null for BOTH an absent mounts.json (legitimately no recorded mount
  // context — folders default to []) AND a present-but-corrupt one (the folder map is UNKNOWN, not empty).
  // Uploads has a fixed-layout fallback dir it can still probe; connected FOLDERS have none, so a corrupt
  // mounts.json would silently render "(none)" — telling the evaluator "the agent correctly saw no
  // connected folder" when the truth is UNKNOWN. That is the same confabulation-vs-correct false-clean the
  // uploads path guards against below (the ENOENT-vs-read-fault split); mirror it for folders. #14
  const mountsCorrupt = loaded === null && existsSync(join(runDir, "mounts.json"));

  const lines: string[] = [];
  try {
    const uploadNames = readdirSync(uploadsDir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
    for (const name of uploadNames) {
      let sizeNote: string;
      try {
        sizeNote = `${statSync(join(uploadsDir, name)).size} bytes`;
      } catch {
        sizeNote = "size unknown";
      }
      lines.push(`${name} (${sizeNote})`);
    }
  } catch (err) {
    // ENOENT = the uploads dir was never created (legitimately no uploads) → nothing to list. ANY OTHER
    // failure (EACCES / ENOTDIR / EIO / …) means we could NOT determine what was attached — rendering
    // "(none)" there would tell the evaluator "there was correctly no file" when the truth is UNKNOWN,
    // the exact conflation this section exists to prevent (see the header). Surface it loudly instead.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      lines.push(
        `(uploads directory could not be read: ${(err as NodeJS.ErrnoException).code ?? "error"} — ` +
          `attachment presence UNKNOWN, not confirmed absent)`,
      );
    }
  }
  for (const name of folderNames) lines.push(`${name} (connected folder)`);
  if (mountsCorrupt)
    lines.push(
      `(connected-folder context could not be read: mounts.json present but unparseable — ` +
        `folder attachment presence UNKNOWN, not confirmed absent)`,
    );

  return lines.join("\n");
}

/** Byte-bound a text section, appending a loud (never silent) truncation marker so the evaluator knows the
 *  section was cut rather than reading a suspiciously short document as "that's everything." Cuts on a
 *  UTF-8-safe boundary (Buffer, not string length, so a truncated multi-byte char can't corrupt the tail). */
/** The packager's OWN truncation marker. A copy of this string inside an untrusted body is a forgery: it
 *  would let hostile skill content fake truncation and weaponize the evaluator's truncation caveat, which
 *  routes claims to `not-adjudicable`. Redacted before the genuine marker can ever be appended. */
export const TRUNCATION_MARKER = "[truncated — exceeded the packager's per-section byte budget]";

function neutralizeForgedTruncationMarkers(s: string): string {
  return s
    .split(TRUNCATION_MARKER)
    .join("[truncation-marker-lookalike redacted]")
    .split(ELISION_MARKER)
    .join("[elision-marker-lookalike redacted]");
}

/** Slice a UTF-8 buffer at a byte offset WITHOUT splitting a code point. `Buffer.toString` replaces a
 *  partial sequence with U+FFFD, so a naive head slice ends in a replacement char and a naive tail slice
 *  BEGINS with one — both corrupt the text the evaluator quotes from and can break citation resolution on
 *  the boundary line. Continuation bytes are `10xxxxxx` (0x80..0xBF); walk off them to reach a real start. */
function codePointFloor(buf: Buffer, at: number): number {
  let i = Math.max(0, Math.min(at, buf.length));
  while (i > 0 && (buf[i]! & 0xc0) === 0x80) i--;
  return i;
}
function codePointCeil(buf: Buffer, at: number): number {
  let i = Math.max(0, Math.min(at, buf.length));
  while (i < buf.length && (buf[i]! & 0xc0) === 0x80) i++;
  return i;
}

/** The truncation marker's own byte length, and the trim loop's safety margin.
 *
 *  HISTORY, because the name misleads otherwise: `boundText` used to append the marker BEYOND `maxBytes`,
 *  so shaving a section by exactly `overflow` left the package `MARKER_BYTES` over; the loop then shaved
 *  the NEXT section by that amount and re-added the same marker — net zero, cascading through every section
 *  and exiting still over cap with the whole document mangled. `boundText` now fits the marker WITHIN
 *  `maxBytes`, so that cascade is impossible and the `- MARKER_BYTES` in `trimToPackageCap` is a
 *  conservative margin rather than the load-bearing correction it originally was. Kept deliberately: it
 *  costs ~67 bytes on a path that should never run, and it keeps the loop correct against either
 *  `boundText` contract. */
const MARKER_BYTES = Buffer.byteLength("\n…" + TRUNCATION_MARKER, "utf8");

function boundText(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  // A target below the marker's own length cannot be honoured by appending the marker — doing so GROWS the
  // body past its cap (a 6-byte "(none)" became ~67 bytes) and makes the caller's dropped-byte accounting
  // negative. Degrade to a bare cut: still a cut, still under cap, just unmarked because there is no room.
  const cut = buf.subarray(0, codePointFloor(buf, maxBytes)).toString("utf8");
  if (maxBytes <= MARKER_BYTES) return cut;
  return buf.subarray(0, codePointFloor(buf, maxBytes - MARKER_BYTES)).toString("utf8") + "\n…" + TRUNCATION_MARKER;
}

/** The packager's OWN middle-elision marker. Distinct string from `TRUNCATION_MARKER` (neither is a
 *  substring of the other, so neutralizing one can never mask the other) and redacted from untrusted bodies
 *  by the same forgery guard. */
export const ELISION_MARKER = "[middle elided — section exceeded its byte budget; head and tail retained]";

/** Head+tail bound for the TRANSCRIPT specifically. A tail-only cut is the worst possible shape for a
 *  procedural skill: setup comes first and the workflow steps come LAST, so cutting the tail removes exactly
 *  the part a behavioural finding concerns. Keeping both ends and eliding the middle preserves the run's
 *  opening AND its conclusions at the same budget. Both cut points are code-point aligned. */
function boundHeadTail(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  // Marker budget is reserved BEFORE any slicing, so head + marker + tail can never exceed `maxBytes`.
  const marker = `\n…${ELISION_MARKER}…\n`;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const budget = maxBytes - markerBytes;
  if (budget <= 0) return boundText(s, maxBytes); // degenerate budget — fall back to a plain head cut
  // Favour the tail slightly: the end of a run carries the conclusions a self-report is usually about.
  const headBytes = Math.floor(budget * 0.45);
  const head = buf.subarray(0, codePointFloor(buf, headBytes)).toString("utf8");
  const tail = buf.subarray(codePointCeil(buf, buf.length - (budget - headBytes))).toString("utf8");
  return head + marker + tail;
}

function sec(title: string, body: string): EvidenceSection {
  return { title, body: body.trim().length ? body.trim() : "(none)" };
}

/** The corpus the evaluator is shown must be the corpus the AGENT was given. Staging delivers git-TRACKED
 *  files only (`session.ts`'s `stageFilterFor`; untracked files are excluded with a notice, not a hard
 *  fail) while this packager reads the host source dir directly — so an UNCOMMITTED reference file was
 *  absent from the agent's mount and present in the evaluator's evidence. The agent says "the skill never
 *  explains X", the evaluator reads X in a file the agent never received, and returns `already-covered`:
 *  a true finding marked false, on exactly the axis (closed, deterministic evidence) this instrument
 *  exists to protect. The same unfiltered walk admits `.DS_Store` and `__pycache__/*.pyc` as "skill
 *  guidance".
 *
 *  Reuses staging's OWN selection helpers rather than reimplementing the rule — same tracked snapshot,
 *  same `COWORK_HARNESS_GITSET=0` escape hatch, same not-a-git-worktree fallback — so the two can never
 *  drift. Returns `null` when no filtering applies (gitMode off, or not a work tree), meaning "accept
 *  everything", which is exactly what staging does in those cases. */
function corpusAcceptFor(dir: string, quiet = false): ((rel: string) => boolean) | null {
  if (!gitModeEnabled()) return null;
  // `gitTrackedSet` THROWS on a listable-repo-but-failed-`ls-files` state. Packaging must never die there:
  // it runs after both graded turns have been paid for, and an exception escapes to `main` as exit 2 with
  // no report and no salvage. Degrade to "no filter" — the same posture staging itself takes for a
  // non-work-tree — rather than losing the critique.
  let tracked: Set<string> | null;
  try {
    tracked = gitTrackedSet(dir);
  } catch (err) {
    // Loud: this silently disables the corpus==mount guarantee, and a silent degradation of a correctness
    // guarantee is exactly what this instrument exists to surface.
    if (!quiet)
      warn(
        `::warning:: [critique] could not read the git-tracked set for ${dir} (${err instanceof Error ? err.message : String(err)}) — ` +
          `packaging every file found on the host, so the evidence may include files staging would not deliver.\n`,
      );
    return null;
  }
  // Not a work tree → staging copies raw. Empty → staging refuses to mount at all (`stageFilterFor`), which
  // critique's pre-spend check reports first; both callers pass the MOUNT root, so this is staging's
  // answer, not a guess about a subdirectory.
  if (!tracked || tracked.size === 0) return null;
  return gitAccept(tracked);
}

/** The ONE flat rendering of typed sections — used for `pkg` (logging/back-compat) and for the
 *  section-aware overall cap, so the two can never disagree. */
export function renderSections(sections: EvidenceSection[]): string {
  return sections.map((s) => `## ${s.title}\n${s.body}\n`).join("\n");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "(unserializable)";
  }
}

// Per-section byte budgets. These sum comfortably under the overall package cap so the labeled structure
// survives even before the final hard trim; the largest two (SKILL.md, transcript) get the most room since
// they carry the most evaluator-relevant signal (skill guidance text; what the agent actually did/said).
const FINAL_MESSAGE_CAP = 4 * 1024;
const STRUCTURED_CAP = 2 * 1024; // each of: result/toolCounts/skillActivity/subagents
// Read PATHS only. Same reasoning as REFERENCE_LIST_CAP below: a read-heavy skill (25-40 Reads of
// references/ or scripts/ is ordinary on a large reference tree) blew a 1 KiB cap, which set `truncated` and
// handed the evaluator a caveat steering claims to `not-adjudicable` on EVERY run — with `evidenceBudget`
// entirely clean and nothing anywhere to explain it. Pure text; free at this package size.
const REFERENCES_READ_CAP = 32 * 1024;
// Filenames only, but it must not be the thing that flags a package truncated: with content shipping whole
// and the walk now recursive (longer relative paths, more entries), a 1 KiB list cap cut the NAMES on
// ordinary reference-heavy skills — setting `truncated` and steering claims to `not-adjudicable` on every
// run, with nothing in corpusCuts/trimRecord to explain it. Pure text at this package size costs nothing.
const REFERENCE_LIST_CAP = 32 * 1024;
export const TRANSCRIPT_CAP = 128 * 1024; // the one PERMANENT content bound — see the doc comment below
const ATTACHED_INPUTS_CAP = 1 * 1024;
// Sub-agent WebSearch query+result (subagents[].webSearches, live-lane capture): the evidence an
// evaluator needs to ground a sub-agent's evidence_source:"researched" claim — previously invisible
// (agentType/description only), which made every such claim not-adjudicable.
export const SUBAGENT_RESEARCH_CAP = 8 * 1024;

/** SKILL-AUTHORED CONTENT IS NOT RATIONED. SKILL.md, every `references/**` file and every dispatchable
 *  `agents/**.md`
 *  ship WHOLE. The previous design capped SKILL.md at 64KB and shared 8KB across ALL references (filled in
 *  filename order, so the alphabetically-first file took everything) — measured across 9 real runs, 11 of 13
 *  distinct reference files had NEVER reached an evaluator, including the scoring rubric a sub-agent had
 *  opened to do the scoring. That was a rationing system for a famine that does not exist: the evaluator
 *  needs its corpus CLOSED, FROZEN and DETERMINISTIC — never SMALL. Citation validation, turn-1 slicing and
 *  the armor all work identically at 700KB, the model's window is 1M tokens, and evidence input is ~14% of
 *  an evaluator pass's cost.
 *
 *  This ceiling is a SANITY VALVE, not an allocation: ~2.3x the largest real skill observed (~230KB), and
 *  a breach is CUT LOUDLY (named file + bytes on stderr and in the report), never silently and never by
 *  refusing the run — refusing would turn a degraded grade into no grade, and this is a discovery
 *  instrument. Governs SKILL.md + references + every packaged agent md COMBINED. */
/** The section-title prefix for a packaged plugin-root reference. Exported and shared: `trimPriority`
 *  matches it, and `evaluator.ts` names it when telling the model which sections are authored guidance.
 *  A literal repeated in those places is a title/prompt mismatch waiting to happen — the packager would
 *  emit sections the prompt never mentions, and every test would still pass. */
export const ROOT_REFERENCE_SECTION_PREFIX = "plugin-root references/ content";

/** The section-title prefix for a packaged sub-agent body. Same contract as the constant above and for
 *  the same reason: `trimPriority` matches it and `evaluator.ts` names it when telling the model which
 *  sections are authored guidance. These bodies entered the corpus without the prompt ever being told,
 *  so the evaluator graded them while still being instructed that guidance lives in "SKILL.md and
 *  references" — a packaged section the rubric does not know about is evidence the model is told to
 *  ignore. */
export const AGENT_SECTION_PREFIX = "agents markdown";

export const SKILL_CORPUS_CEILING = 512 * 1024;
/** Minimum bytes any single corpus file keeps when the ceiling forces a cut. Below this a slice is not
 *  worth packaging (it would be a heading and an intro), so such a file is marked omitted instead — a
 *  DISTINCT fact from "budget exhausted", because it tells the author to split that file rather than that
 *  the corpus as a whole is too big. Only reachable above the ceiling, i.e. never on a real skill. */
const CORPUS_MIN_SLICE = 2 * 1024;

/** Overall hard cap — belt-and-suspenders only. The per-section budgets sum to 742,400 B worst case
 *  (corpus 524,288 + transcript 131,072 + refsRead list 32,768 + reference list 32,768 + sub-agent research
 *  8,192 + 4x structured 8,192 + final message 4,096 + attached inputs 1,024 = 742,400), so this sits ABOVE that sum
 *  and the final trim never fires on a merely fully-loaded package. The headroom covers section titles and
 *  degraded notes; armor markers (~60B/section) and the prompt instructions ride ON TOP of this figure and
 *  are the evaluator prompt's business, not the package's. `assertSectionBudgetsFitPackage` pins the
 *  relationship so a future budget change cannot silently invert it. */
export const MAX_PACKAGE_BYTES = 768 * 1024;

/** The per-section budget sum, as a function of the constants rather than a copied number — a test asserts
 *  it stays under `MAX_PACKAGE_BYTES` so the "sum is deliberately under the cap" invariant is CHECKED
 *  rather than merely commented (the previous design stated it in prose and nothing verified it). */
export function sectionBudgetSum(): number {
  return (
    SKILL_CORPUS_CEILING +
    TRANSCRIPT_CAP +
    SUBAGENT_RESEARCH_CAP +
    FINAL_MESSAGE_CAP +
    4 * STRUCTURED_CAP +
    REFERENCES_READ_CAP +
    REFERENCE_LIST_CAP +
    ATTACHED_INPUTS_CAP
  );
}

/** Readability of the skill's `SKILL.md` source (F31): distinguishes a legitimately-absent file (no
 *  `SKILL.md` at that path) from an unreadable one (exists, but a permission/OS error prevented reading
 *  it) — the previous prose-only fallback collapsed both into one indistinguishable "(no SKILL.md
 *  found...)" note. */
export type SkillMdStatus = "readable" | "missing" | "unreadable" | "untracked";

export interface PackageEvidenceResult {
  /** Flat rendering of `sections`. Kept for logging/back-compat — it is NO LONGER the citation corpus
   *  (armorEvidence's output is; see armor.ts). */
  pkg: string;
  /** Typed sections, trusted title separated from untrusted body, for the evaluator to armor. Never
   *  re-flatten these before armoring — the whole point is that the distinction survives assembly. */
  sections: EvidenceSection[];
  /** True if ANY section (or the overall document) hit its byte budget and was cut. The evaluator MUST be
   *  told this: a claim about something that fell outside a truncated window is `not-adjudicable`, NOT
   *  `confabulated` — absence from a truncated package is not proof the thing didn't happen. */
  truncated: boolean;
  /** F30 (+ residual): true when the canonical turn-1 result file (`turns/1/result.json`) either existed
   *  but failed to parse (corrupted), OR — on a validated resume (`isResume: true`) — never existed at all.
   *  The "Turn-1 outcome" / toolCounts / skillActivity / subagents / "Final answer" sections above are
   *  therefore EMPTY DEFAULTS, not a genuinely empty turn-1 result — the evaluator must treat their absence
   *  as UNKNOWN, never as evidence something didn't happen. This is a degradation signal only — never
   *  resolved by substituting a LATER turn's result (that would contaminate turn-1 isolation). */
  turn1ResultDegraded: boolean;
  /** F28/F29: true when the turn-1 transcript's `events.jsonl`-slice fallback could not be trusted as
   *  ground truth — either the byte boundary was never established (a `snapshotTurnBoundary` stat failure)
   *  or the append-only prefix it depends on changed between the boundary snapshot and packaging. The
   *  "Transcript" section is annotated inline for the same reason, but the evaluator prompt path also needs
   *  this as a typed flag. */
  turn1SliceDegraded: boolean;
  /** F31: see `SkillMdStatus`. */
  skillMdStatus: SkillMdStatus;
  /** Total bytes of skill-authored content found (SKILL.md + references + every packaged agent md), BEFORE any ceiling
   *  cut. With `corpusCeiling` this makes "how close is this skill to the valve" answerable without a run. */
  corpusBytes: number;
  /** The active `SKILL_CORPUS_CEILING`, reported so a consumer never has to read the source to learn it —
   *  the previous caps were discoverable only by inspecting `dist/`, which cost a real consumer hours. */
  corpusCeiling: number;
  /** Per-file record of what the ceiling actually cut. Empty on every real skill. `omitted: true` means the
   *  file's share fell below the minimum useful slice — a DIFFERENT instruction to the author ("split this
   *  file") than a partial cut ("the corpus as a whole is too big"), so the two are never collapsed. */
  corpusCuts: Array<{ name: string; keptBytes: number; totalBytes: number; omitted: boolean }>;
  /** Skill files present on the HOST but excluded from the corpus because staging would not deliver them
   *  (untracked, with git-mode on). These were never in the agent's mount, so grading against them would
   *  manufacture false `already-covered` verdicts — but the author must be TOLD, or their grade silently
   *  covers less than they believe. */
  corpusExcluded: string[];
  /** Every corpus file whose CONTENT shipped into the corpus sections, by the same key `corpusCuts` uses.
   *  `corpusCuts`/`corpusExcluded` name files only when something went wrong, so a reader could not
   *  otherwise tell which sub-agent bodies a grade rested on. Excludes a file the ceiling zeroed (it
   *  contributed nothing) and a placeholder for an unreadable file (never a corpus entry); a PARTIALLY cut
   *  file is listed, with its loss in `corpusCuts`. The later `trimToPackageCap` pass can still shave a
   *  section after this is computed — `trimRecord` reports that. */
  corpusPackaged: string[];
  /** Plugin-root `references/` files present in the MOUNT but not packaged, and why. This is what makes
   *  a narrow selection rule safe: an author who expected a shared file to be graded is told it was not,
   *  and which of the three reasons applied — rather than the omission being silent, which is the defect
   *  class this whole change exists to close. */
  corpusOmitted: Array<{ name: string; reason: OmissionReason; alsoUntracked?: boolean }>;
  /** True when the graded turn Read NO `references/` or `scripts/` file at all — neither the main agent nor
   *  any sub-agent — on a non-degraded result. Stated OBSERVATIONALLY, and consumers must render it that
   *  way: the underlying predicate matches `references/`+`scripts/` only (never `assets/`, never SKILL.md
   *  itself) and keys on the `Read` TOOL, so an agent that used `Grep`, or read from `assets/`, produces an
   *  empty set having demonstrably reached the material. "No file was Read" is a fact; "progressive
   *  disclosure never fired" would be an inference, and a false accusation about the consumer's skill.
   *  `undefined` when the turn-1 result was degraded — unknown, not zero. */
  noSkillFilesRead?: boolean;
  /** The run carried no reference-access list at all — see ReportState.referenceAccessUnobservable. */
  referenceAccessUnobservable?: boolean;
  /** True when ANY section was cut — most often the transcript's 128 KiB head+tail elision, which is the
   *  cut that actually happens on long runs. This is what adds the evaluator's truncation caveat, so a
   *  consumer reading DROPPED findings or a rise in `not-adjudicable` needs it: without it an elided
   *  package was indistinguishable from a clean one, and `corpusCuts` (empty in that case) implied nothing
   *  had been cut at all. */
  packageTruncated: boolean;
  /** Which sections the overall belt-and-suspenders trim shaved, and by how much. Previously the trim set
   *  a bare boolean, so a package that lost its transcript tail was indistinguishable from one that lost
   *  nothing — the failure was undetectable after the fact, including by the consumer. */
  trimRecord: Array<{ section: string; droppedBytes: number }>;
}

/** Assemble the evidence document for `runCritique`. `runDir` is the KEPT run dir of the task+reflection
 *  session (post-resume, so `turns/1/` and `turns/2/` both exist); `boundary` is the `snapshotTurnBoundary`
 *  captured right before the reflection turn; `skillDir` is the skill folder under test (containing
 *  `SKILL.md` and, optionally, a `references/` subdir). Pure and testable: every input is a path or an
 *  already-captured boundary, nothing here spawns a process or calls a model.
 *
 *  `isResume` (F30 residual): true when the CALLER has already validated this is a genuine resume (turn>1
 *  reflection) — the only case this function is actually invoked in today (`scripts/skill-critique.ts`
 *  calls this only after `validateReflectionTurn` succeeds). In that case `turns/1/result.json` MUST exist;
 *  a missing turn-1 result is treated exactly like a corrupted one (`turn1ResultDegraded: true`,
 *  empty-default sections), never silently read from a later turn. Defaults to `false` so a hypothetical
 *  future single-shot (never-resumed) caller does not flag an ordinary absent turn-1 result as degraded. */
export function packageEvidence(
  runDir: string,
  boundary: TurnBoundary,
  skillDir: string,
  isResume = false,
  opts: {
    /** EVERY sub-agent the invoked skill can dispatch (resolved by the caller — see
     *  `resolveDispatchableAgents`), each packaged as its own bounded, separately-keyed section. For
     *  sub-agent-heavy skills these files ARE most of the operative guidance.
     *
     *  This was a single `agents/<skill>.md` through 3.6.0. The graded turn mounts the whole plugin, so a
     *  second skill-scoped agent really ran while its authored body was structurally absent from the
     *  evidence — letting a critique report a guidance gap in an agent it never received. */
    agents?: ResolvedAgent[];
    /** The plugin ROOT. Agent files and the shared `references/` tree both sit OUTSIDE `skillDir`, so
     *  without it neither can be checked against the tracked set that decides what staging delivered.
     *  Named for what it is, not for its first consumer — an `agentsRoot` reused for references is how a
     *  single rule ends up with several derivations. */
    pluginRoot?: string;
    /** The folder the graded turn MOUNTED — the one staging read its git-tracked set from. Every corpus
     *  class is checked against THAT set, with keys relative to it. Required: keying each class on its own
     *  directory (`skillDir`, `pluginRoot`) is how a submodule's own index, or a plugin the mount never
     *  carried, put files in the evidence that the agent never received. `skillDir` and `pluginRoot` must
     *  lie inside it (lexically); anything else is a caller bug and throws. */
    mountRoot: string;
    /** `"preview"` when called by `critique --corpus-only` over an EMPTY run dir: the same corpus
     *  computation, no graded turn. Changes ONE thing — the tense of the over-ceiling warning ("would be
     *  cut", not "was cut before grading") — so a CI annotation never describes a grading that did not
     *  happen. `"preflight"` is critique's pre-spend check on the live path: the same computation, SILENT —
     *  the real packaging pass after the turns emits every warning once, in the right tense. Neither mode
     *  may change any corpus field: the preview's whole value is that it IS this function's answer, and a
     *  mode that computed differently would be a second derivation. */
    mode?: "preview" | "preflight";
  },
): PackageEvidenceResult {
  // Keys for the ONE tracked set staging read (see `mountRoot`). Lexical on both sides: `realpathSync` on
  // one side only would call a macOS tmpdir (`/var/…` vs `/private/var/…`) "outside".
  const mountRoot = resolve(opts.mountRoot);
  const prefixInsideMount = (label: string, p: string): string => {
    const r = relative(mountRoot, resolve(p));
    if (r.startsWith("..") || isAbsolute(r)) throw new Error(`packageEvidence: ${label} ${p} is not inside mountRoot ${opts.mountRoot}`);
    return r === "" ? "" : `${r.split(sep).join("/")}/`;
  };
  const skillPrefix = prefixInsideMount("skillDir", skillDir);
  const pluginPrefix = opts.pluginRoot !== undefined ? prefixInsideMount("pluginRoot", opts.pluginRoot) : "";
  const mountAccept = corpusAcceptFor(mountRoot, opts.mode === "preflight");
  // Track whether any budget was hit. `boundText` returns its input UNCHANGED when it fits, so `out !== s`
  // is an exact truncation signal — no separate length check that could drift from boundText's own cut rule.
  let truncated = false;
  const bound = (s: string, maxBytes: number): string => {
    const clean = neutralizeForgedTruncationMarkers(s);
    const out = boundText(clean, maxBytes);
    if (out !== clean) truncated = true;
    return out;
  };
  /** Head+tail variant of `bound`, for the transcript. It MUST route through the same two guarantees —
   *  forgery neutralization and the `truncated` signal — because the transcript is the most untrusted body
   *  in the package (agent prose plus raw tool output) and the elision is the cut that actually happens on
   *  real runs. Calling `boundHeadTail` directly skipped both: hostile run content could plant a verbatim
   *  truncation/elision marker to weaponize the evaluator's truncation caveat, and a genuinely elided
   *  transcript reported `truncated: false`, so the caveat that routes past-the-cut claims to
   *  `not-adjudicable` was never added to the prompt. */
  const boundEnds = (s: string, maxBytes: number): string => {
    const clean = neutralizeForgedTruncationMarkers(s);
    const out = boundHeadTail(clean, maxBytes);
    if (out !== clean) truncated = true;
    return out;
  };

  const turn1Result = readTurn1ResultWithStatus(runDir, isResume);
  // F30 residual: on a validated resume, "missing" is JUST as degraded as "corrupted" — a resumed session's
  // `turns/1/result.json` genuinely not existing must be surfaced the same way a corrupted one already was,
  // never treated as "no turn-1 result, nothing to show" (the pre-fix default for a status other than
  // "corrupted"). (`isResume` is passed through to `readTurn1ResultWithStatus` for its own inert
  // `requireArchive` parameter — see that function's doc comment — but the degraded computation below is
  // what actually consumes it.)
  const turn1ResultDegraded = turn1Result.status === "corrupted" || (isResume && turn1Result.status === "missing");
  const raw = turn1Result.value as Record<string, unknown> | null;

  const finalMessage = typeof raw?.finalMessage === "string" ? raw.finalMessage : "";
  // WIDE reference access: every channel (Read / Grep / Glob / a Bash command naming the path), not the
  // Read tool alone. The narrow `referencesRead` used to drive both the headline and the evaluator's
  // evidence section, and its absence was being read as "the agent opened no reference" — a claim about
  // reading that a one-channel count cannot support.
  // ONE derivation, shared with the assertion keys (`unionReferenceAccesses`, src/run/run.ts): main agent
  // ∪ sub-agents, defensive over raw JSON. A second copy here is how the report and an assertion end up
  // disagreeing about the same run.
  //
  // PRESENCE is the cannot-verify channel: `[]` means the drive ran and observed nothing, `undefined`
  // means there was no observable drive. Collapsing them would turn "we could not look" into a clean
  // negative — the exact failure this whole change exists to remove.
  const allAccesses = unionReferenceAccesses(raw ?? {});
  const accessObservable = allAccesses !== undefined;
  const referencesRead = Array.isArray(raw?.referencesRead)
    ? (raw!.referencesRead as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  // Union of main-agent + per-dispatch sub-agent reads. The top-level field is main-agent ONLY by contract
  // (`types.ts`), and a dispatcher-style skill does its reading a level down — so main-agent-empty says
  // nothing on its own. this keys off the DEGRADED flag, never off list-emptiness: an
  // absent top-level field is a deliberate encoding of "no qualifying reads", not an unknown.
  const subagentReads = Array.isArray(raw?.subagents)
    ? (raw.subagents as Array<{ referencesRead?: unknown }>).flatMap((sa) =>
        Array.isArray(sa?.referencesRead) ? (sa.referencesRead as unknown[]).filter((x): x is string => typeof x === "string") : [],
      )
    : [];
  const allReads = [...new Set([...referencesRead, ...subagentReads])];
  // `references/x.md (read, bash)` — channels merged per path by the shared helper above.
  const accessLines = (allAccesses ?? []).map((a) => `${a.path}${a.via.length ? ` (${a.via.join(", ")})` : ""}`);
  const skillActivity = raw?.skillActivity ?? [];
  const toolCounts = raw?.toolCounts ?? {};
  const outcome = typeof raw?.result === "string" ? raw.result : "unknown";
  const resultSubtype = typeof raw?.resultSubtype === "string" ? raw.resultSubtype : undefined;

  // Subagents: agentType/description ONLY (per the plan) — not the full dispatch prompt/output, which
  // would blow the byte budget and isn't needed for "was a sub-agent dispatched, and what kind."
  const subagentsRaw = Array.isArray(raw?.subagents) ? (raw!.subagents as Array<Record<string, unknown>>) : [];
  const subagents = subagentsRaw.map((s) => ({
    agentType: typeof s.agentType === "string" ? s.agentType : undefined,
    description: typeof s.description === "string" ? s.description : undefined,
  }));

  // Sub-agent research: each dispatch's own WebSearch query + (bounded) result text, from the live-lane
  // child-transcript capture. An empty assembly gets an explicit absence-is-not-evidence note — this
  // capture is live/record-only, so a missing section must never read as "no research happened".
  const researchParts: string[] = [];
  for (const s of subagentsRaw) {
    const ws = Array.isArray(s.webSearches) ? (s.webSearches as Array<Record<string, unknown>>) : [];
    if (!ws.length) continue;
    const label =
      typeof s.resolvedAgentType === "string"
        ? s.resolvedAgentType
        : typeof s.dispatchAgentType === "string"
          ? s.dispatchAgentType
          : typeof s.description === "string"
            ? s.description
            : "dispatch";
    for (const w of ws) {
      if (typeof w.query !== "string") continue;
      // A `viaAgentId` entry was made by a DESCENDANT dispatch and attributed up to this one (the
      // descendant never got its own subagents[] entry). Say so in the label: without it the evaluator
      // reads the search as this dispatch's own work and grounds a "researched" claim against the wrong
      // agent — the same mis-attribution the tag exists to prevent, one layer further out.
      const via =
        typeof w.viaAgentId === "string"
          ? ` ← via nested agent ${w.viaAgentId}${typeof w.viaSpawnDepth === "number" ? ` @depth ${w.viaSpawnDepth}` : ""}`
          : "";
      researchParts.push(
        `[${label}${via}] query: ${w.query}\nresult:\n${typeof w.resultText === "string" ? w.resultText : "(no result text captured)"}`,
      );
    }
  }
  const subagentResearch = researchParts.length
    ? researchParts.join("\n\n")
    : "(none captured — sub-agent WebSearch is recorded on the live lane only; absence here is NOT evidence no research happened)";

  const { text: transcript, degraded: turn1SliceDegraded } = readTurn1Transcript(runDir, boundary);

  // Skill source. SKILL.md is delivered whole to the agent and is NEVER captured by a Read event (see
  // referencesRead's own doc comment) — so it must be packaged verbatim here, or "did the agent already
  // have this guidance" is unanswerable for anything SKILL.md-resident (most of a skill's content).
  // existsSync/readFileSync are checked separately (F31) so a permission failure on a file that DOES exist
  // is never reported as if it were simply absent.
  const skillMdPath = join(skillDir, "SKILL.md");
  let skillMd = "";
  let skillMdStatus: SkillMdStatus;
  if (!existsSync(skillMdPath)) {
    skillMdStatus = "missing";
  } else {
    try {
      skillMd = neutralizeForgedTruncationMarkers(readFileSync(skillMdPath, "utf8"));
      skillMdStatus = "readable";
    } catch {
      skillMdStatus = "unreadable";
    }
  }
  // references/ — RECURSIVE and symlink-aware. The previous walk was a single non-recursive `readdirSync`
  // filtered by `isFile()`, which silently dropped BOTH subdirectories and symlinked files (a symlink dirent
  // is not `isFile()`) with no omission marker at all — "every reference ships" was false for any nested
  // layout and failed silently, which is the one thing this packager must never do. Names are
  // forward-slash-joined relative paths so a citation still identifies its source file.
  const referenceRoot = join(skillDir, "references");
  const accept = mountAccept ? (rel: string) => mountAccept(`${skillPrefix}${rel}`) : null;
  const allReferenceFiles = listSkillFilesRecursive(referenceRoot);
  const referenceFiles = accept ? allReferenceFiles.filter((rel) => accept(`references/${rel}`)) : allReferenceFiles;
  // Files on the host that the AGENT never received. Reported, never silently dropped: an author who left a
  // reference untracked must be told, because otherwise the grade silently covers less than they believe.
  const corpusExcluded = allReferenceFiles.filter((rel) => !referenceFiles.includes(rel)).map((rel) => `references/${rel}`);
  if (accept && !accept("SKILL.md") && skillMdStatus === "readable") {
    // A SKILL.md the mount would not deliver is not evidence about the graded run. `skillMdUntracked`
    // (not `missing`) so the report can name the real cause — the "you probably pointed at a multi-skill
    // plugin root" hint that `missing` triggers would be an actively wrong diagnosis here.
    corpusExcluded.unshift("SKILL.md");
    skillMd = "";
    skillMdStatus = "untracked";
  }

  // `scripts/` as the AGENT would have received it: same contained cycle-guarded walk, same tracked-set
  // filter. Probing the raw host dir instead let an UNTRACKED script — never delivered by staging — suppress
  // the no-reads signal, which is the corpus==mount rule this change exists to enforce, applied everywhere
  // except here.
  const allScriptFiles = listSkillFilesRecursive(join(skillDir, "scripts"));
  const deliveredScripts = accept ? allScriptFiles.filter((rel) => accept(`scripts/${rel}`)) : allScriptFiles;

  // references/ CONTENT — read WHOLE. Bodies are read here; the combined corpus ceiling is applied below,
  // across SKILL.md + references + every packaged agent md together, so no per-file rationing here.
  // Read failures degrade per-file to a loud inline note, never sink packaging.
  // Neutralized HERE, once. Everything downstream (ceiling measurement, per-file cuts, section assembly)
  // treats these as already-clean and must bound them with `boundText`, never `bound` — see `applyCorpus`.
  const referenceBodies: Array<{ name: string; body: string | null }> = referenceFiles.map((name) => {
    try {
      return { name, body: neutralizeForgedTruncationMarkers(readFileSync(join(referenceRoot, name), "utf8")) };
    } catch {
      return { name, body: null };
    }
  });

  // Sub-agent bodies — one section, one corpus key, one ceiling slice PER FILE. The bare `"agents"` key
  // this replaced was unambiguous only while exactly one agent could ever be packaged; at N>1 an
  // over-ceiling cut could not have named the file it cut, which is the whole point of "cut loudly".
  //
  // Same corpus==mount rule as SKILL.md/references, against the same mount-root tracked set; agent keys
  // carry the plugin root's prefix within the mount. The check is PER FILE — one agent being untracked must
  // not suppress the others.
  // Declared here, not beside the root-reference pass: an UNREADABLE AGENT is recorded into it below,
  // and a corpus file that reaches the evaluator as a placeholder must not be silent in every field.
  const corpusOmitted: Array<{ name: string; reason: OmissionReason; alsoUntracked?: boolean }> = [];
  const agentBodies: Array<{ key: string; title: string; body: string; isPlaceholder: boolean }> = [];
  {
    const rootAccept = opts.pluginRoot !== undefined && mountAccept ? (rel: string) => mountAccept(`${pluginPrefix}${rel}`) : null;
    for (const agent of opts.agents ?? []) {
      if (rootAccept && !rootAccept(agent.rel)) {
        corpusExcluded.push(agent.rel);
        continue;
      }
      let body: string;
      let isPlaceholder = false;
      if (!existsSync(agent.absPath)) {
        body = `(no file found at ${agent.absPath})`;
        isPlaceholder = true;
      } else {
        try {
          body = neutralizeForgedTruncationMarkers(readFileSync(agent.absPath, "utf8"));
        } catch {
          body = `(exists at ${agent.absPath} but could not be read)`;
          isPlaceholder = true;
        }
      }
      // `via` is load-bearing, not decoration: the `subagent_type` extraction has no context awareness, so
      // a literal that a reference doc merely MENTIONS (a template placeholder, a "never dispatch this"
      // example) pulls its agent in. Naming the file:line lets the evaluator weigh that itself rather than
      // reading a mentioned agent as operative guidance.
      // A resolved agent whose file cannot be read reaches the evaluator as a placeholder and is not a
      // corpus entry — so without this row it appears in NO evidenceBudget field at all. Before the
      // placeholder change it was at least visible in `corpusPackaged`, mislabelled; trading a wrong label
      // for total silence breaks this module's own rule that what is left out is REPORTED.
      if (isPlaceholder) corpusOmitted.push({ name: agent.rel, reason: "unreadable" });
      agentBodies.push({
        isPlaceholder,
        key: agent.rel,
        title: flattenTitle(
          `${AGENT_SECTION_PREFIX} (${neutralizeForgedTruncationMarkers(basename(agent.absPath))} — sub-agent system prompt / dispatch guidance for \`${neutralizeForgedTruncationMarkers(agent.name)}\`; in corpus via ${neutralizeForgedTruncationMarkers(agent.via)})`,
        ),
        body,
      });
    }
  }

  // ---- plugin-root references/ ----
  // A multi-skill plugin's SHARED references/ is mounted for the graded turn but was rooted at `skillDir`,
  // so a root file the skill's own SKILL.md points at was invisible to the evaluator. Only files the skill
  // (or one of its packaged agents, or the graded agent's own reads) actually points at are packaged:
  // the whole tree was measured and rejected — it cuts the graded SKILL.md, and `already-covered` judges
  // by PRESENCE with no notion of which skill authored a file, so another skill's docs silently excuse a
  // real gap. Files left out are REPORTED (`corpusOmitted`), which is what makes the narrow rule safe.
  const rootRefBodies: Array<{ key: string; title: string; body: string; isPlaceholder: boolean }> = [];
  if (opts.pluginRoot !== undefined) {
    const rootAccept = mountAccept ? (rel: string) => mountAccept(`${pluginPrefix}${rel}`) : null;
    const resolved = resolveRootReferences({
      pluginRoot: opts.pluginRoot,
      skillDir,
      agents: opts.agents ?? [],
      accesses: allAccesses,
      accept: rootAccept,
    });
    corpusOmitted.push(...resolved.omitted);
    for (const ref of resolved.packaged) {
      // TWO KEYS. `gitAccept` can only match the plugin-root-relative spelling; everything the reader
      // sees uses the display key, because `references/x.md` exists under BOTH roots and the two would
      // otherwise render indistinguishably — including in `corpusExcluded`, whose line says "git add them".
      if (rootAccept && !rootAccept(ref.rel)) {
        corpusExcluded.push(ref.displayKey);
        continue;
      }
      let body: string;
      let isPlaceholder = false;
      try {
        body = neutralizeForgedTruncationMarkers(readFileSync(ref.absPath, "utf8"));
      } catch {
        body = `(exists at ${ref.absPath} but could not be read)`;
        isPlaceholder = true;
      }
      rootRefBodies.push({
        isPlaceholder,
        key: ref.displayKey,
        title: flattenTitle(
          `${ROOT_REFERENCE_SECTION_PREFIX} (${neutralizeForgedTruncationMarkers(ref.displayKey)} — shared across the plugin, in corpus via ${neutralizeForgedTruncationMarkers(ref.via)}; a read of it appears in referencesAccessed as \`${neutralizeForgedTruncationMarkers(ref.rel)}\`)`,
        ),
        body,
      });
    }
  }

  // ---- combined skill-corpus ceiling (SANITY VALVE; see SKILL_CORPUS_CEILING) ----
  // File-aware BY CONSTRUCTION: applied here, where filenames are still known, rather than by the
  // section-level trim below — that trim sees `referencesContent` as one concatenated body and therefore
  // could not name the file it cut, which is the whole point of "cut loudly". A slice below CORPUS_MIN_SLICE
  // is marked omitted with a DISTINCT reason (split this file) rather than shipped as a useless sliver
  // (the corpus as a whole is too big) — the two tell an author to do opposite things.
  // `tag` is internal and is what reconciliation must match on: `name` is the DISPLAY key and is NOT
  // unique (see the collision note below), so filtering `corpusPackaged` by name would let one file's
  // zeroed row delete a DIFFERENT file's listing — the same false-negative the filter exists to remove.
  const corpusCuts: Array<{ tag: string; name: string; keptBytes: number; totalBytes: number; omitted: boolean }> = [];
  // TWO keys again, for a different reason than the accept/display split. `key` is the DISPLAY string —
  // what a reader, a citation and a remedy see — and it is NOT unique: a plugin named (or a plugin
  // DIRECTORY named, since `readPluginName` falls back to the basename) `agents` gives a root reference at
  // `references/x.md` the display key `agents/references/x.md`, identical to an agent at
  // `<root>/agents/references/x.md`. That collided in the allocator's Map: last-writer-wins on the
  // allowance while `remaining` was decremented for BOTH, measured at an 11,388 B ceiling overshoot.
  // `tag` disambiguates the allocator and the cut ledger ONLY — every rendered, cited and reported string
  // stays byte-identical, because a synthetic suffix in a display key hands the author a path that does
  // not exist on disk in the one field whose job is to be actionable.
  //
  // A placeholder body — `(no file found at …)`, `(exists at … but could not be read)` — is NOT an entry.
  // References already worked this way (`r.body !== null`); agents and root references counted their
  // placeholders, so phantom bytes consumed real ceiling allowance against `SKILL_CORPUS_CEILING`'s own
  // "budgets file CONTENT" contract, and the file was then reported as packaged.
  const corpusEntries: Array<{ tag: string; key: string; bytes: number }> = [
    ...(skillMdStatus === "readable" ? [{ tag: "skill\u0000SKILL.md", key: "SKILL.md", bytes: Buffer.byteLength(skillMd, "utf8") }] : []),
    ...referenceBodies
      .filter((r) => r.body !== null)
      .map((r) => ({ tag: `ref\u0000references/${r.name}`, key: `references/${r.name}`, bytes: Buffer.byteLength(r.body!, "utf8") })),
    ...agentBodies
      .filter((a) => !a.isPlaceholder)
      .map((a) => ({ tag: `agent\u0000${a.key}`, key: a.key, bytes: Buffer.byteLength(a.body, "utf8") })),
    ...rootRefBodies
      .filter((r) => !r.isPlaceholder)
      .map((r) => ({ tag: `rootref\u0000${r.key}`, key: r.key, bytes: Buffer.byteLength(r.body, "utf8") })),
  ];
  const corpusBytes = corpusEntries.reduce((a, e) => a + e.bytes, 0);
  const corpusAllowance = new Map<string, number>();
  if (corpusBytes > SKILL_CORPUS_CEILING) {
    let remaining = SKILL_CORPUS_CEILING;
    // SMALLEST first. This is water-filling: a file under the fair share takes only what it needs and its
    // SURPLUS flows to the files that are over. Iterating largest-first instead hands the biggest file
    // `floor(ceiling/n)` and never revisits it, so a 700 KB SKILL.md beside two 3 KB references was cut to
    // ~175 KB when ~518 KB was available — 343 KB of guidance discarded for nothing, on precisely the axis
    // this whole change exists to fix. Small files are protected either way (they always fit under the
    // fair share); only the large ones are affected, and only this order allocates them correctly.
    // Tiebreak on the DISPLAY key, deliberately, even though the allowance is looked up by tag: sorting
    // by tag silently reorders equal-sized files (`rootref\0…` collates after `ref\0…`, and `localeCompare`
    // ignores the NUL), which measurably flips WHICH equal-sized files get zeroed — and in the unfavourable
    // direction, zeroing the skill's OWN references before the shared plugin-root ones. The tag disambiguates
    // identity; it must not decide priority.
    const bySizeAsc = [...corpusEntries].sort((a, b) => a.bytes - b.bytes || a.key.localeCompare(b.key));
    let left = bySizeAsc.length;
    for (const e of bySizeAsc) {
      const fair = Math.floor(remaining / left);
      const give = Math.min(e.bytes, Math.max(0, fair));
      corpusAllowance.set(e.tag, give < CORPUS_MIN_SLICE && give < e.bytes ? 0 : give);
      remaining -= corpusAllowance.get(e.tag)!;
      left--;
    }
    truncated = true;
    if (opts.mode !== "preflight")
      warn(
        `::warning:: [critique] skill corpus is ${corpusBytes.toLocaleString()} B, over the ${SKILL_CORPUS_CEILING.toLocaleString()} B evidence ceiling — ` +
          (opts.mode === "preview"
            ? `content WOULD BE cut before grading; see corpusCuts in the preview for which files and how much.\n`
            : `content was cut before grading; see corpusCuts in the report for which files and how much.\n`),
      );
  }
  /** Apply the ceiling's per-file allowance, recording what each file actually contributed.
   *
   *  Cuts with `boundText`, NOT `bound`: corpus bodies are neutralized ONCE at read time (see
   *  the read-time neutralization above) and the section assembly bounds them with `boundText` too. Routing a cut
   *  body through `bound` a second time ran `neutralizeForgedTruncationMarkers` over the genuine marker
   *  this function had just appended and redacted it — so on the "cut loudly" path the evaluator saw
   *  `[truncation-marker-lookalike redacted]`, whose defined meaning is "hostile content forged a marker
   *  here", exactly where the packager had legitimately cut. */
  const applyCorpus = (tag: string, key: string, body: string): string => {
    const total = Buffer.byteLength(body, "utf8");
    const allowance = corpusAllowance.get(tag);
    if (allowance === undefined || allowance >= total) return body;
    if (allowance === 0) {
      corpusCuts.push({ tag, name: key, keptBytes: 0, totalBytes: total, omitted: true });
      return `(omitted — its share of the ${SKILL_CORPUS_CEILING.toLocaleString()} B corpus ceiling would be below the ${CORPUS_MIN_SLICE.toLocaleString()} B minimum useful slice; SPLIT THIS FILE rather than shrinking the others)`;
    }
    const cut = boundText(body, allowance);
    truncated = true;
    corpusCuts.push({ tag, name: key, keptBytes: Buffer.byteLength(cut, "utf8"), totalBytes: total, omitted: false });
    return cut;
  };
  if (skillMdStatus === "readable") skillMd = applyCorpus("skill\u0000SKILL.md", "SKILL.md", skillMd);
  for (const a of agentBodies) if (!a.isPlaceholder) a.body = applyCorpus(`agent\u0000${a.key}`, a.key, a.body);
  for (const r of rootRefBodies) if (!r.isPlaceholder) r.body = applyCorpus(`rootref\u0000${r.key}`, r.key, r.body);
  // Header/note overhead is NOT free: the allocator budgets file CONTENT, while the assembled section also
  // carries a `### <path>` line per file plus any omission notes. With hundreds of references that overhead
  // ran past the fixed slack and the section-level bound then chopped the tail — silently, with corpusCuts
  // reporting nothing cut. Measure the real overhead and size the section bound from it.
  // A reference filename is untrusted text: it can legally BE the truncation/elision marker, and the
  // `### <name>` header would then plant a verbatim marker in a body the assembled section deliberately no
  // longer re-neutralizes. Sanitize for DISPLAY only — the real path is still what we read and key on.
  const displayName = (rel: string): string => neutralizeForgedTruncationMarkers(rel);
  // Bytes that consumed ALLOCATOR ALLOWANCE — nothing else. Everything the packager itself writes (headers,
  // joiners, read-failure notes, omission notes) is OVERHEAD and must be excluded, because the ceiling
  // budgets file content only.
  let includedBodyBytes = 0;
  const referenceParts = referenceBodies.map(({ name, body }) => {
    if (body === null) return `### ${displayName(name)}\n(could not be read — presence known from the listing, content unavailable)`;
    const before = corpusCuts.length;
    const included = applyCorpus(`ref\u0000references/${name}`, `references/${name}`, body);
    // An OMITTED file's ~150-byte note is packager text the allocator budgeted ZERO for. Counting it as
    // body understated the overhead by that much per omission, so the section bound below cut the tail a
    // second time — files vanished header-and-all while `corpusCuts` still reported bytes shipped for them
    // and `trimRecord` stayed empty: the exact silent chop this accounting exists to prevent.
    const omitted = corpusCuts.length > before && corpusCuts[corpusCuts.length - 1]!.omitted;
    if (!omitted) includedBodyBytes += Buffer.byteLength(included, "utf8");
    return `### ${displayName(name)}\n${included}`;
  });
  const referencesContent = referenceParts.join("\n\n");
  // Derived from what was actually included, never a guessed constant: a fixed 4 KiB slack was blown by a
  // few hundred `### <path>` headers, and summing the PRE-cut originals instead made this collapse to 0 the
  // moment the ceiling cut anything.
  const referencesOverheadBytes = Math.max(0, Buffer.byteLength(referencesContent, "utf8") - includedBodyBytes);

  const turn1ResultDegradedNote = turn1ResultDegraded
    ? turn1Result.status === "corrupted"
      ? " [DEGRADED: the canonical turn-1 result file exists but failed to parse — this section is an empty default, NOT a genuinely empty turn-1 result; treat as unknown, not as evidence of absence]"
      : " [DEGRADED: this is a resumed session but result.turn-1.json was never archived — this section is an empty default (NEVER the turn-2 result.json substituted in its place); treat as unknown, not as evidence of absence]"
    : "";
  const skillMdSectionTitle =
    skillMdStatus === "readable"
      ? "SKILL.md (verbatim skill source, for presence checks the referencesRead list cannot make)"
      : skillMdStatus === "unreadable"
        ? "SKILL.md [DEGRADED: exists but could not be read — permission/OS error, NOT a legitimately absent file]"
        : skillMdStatus === "untracked"
          ? "SKILL.md [DEGRADED: exists on the host but was NOT delivered to the agent — staging ships git-tracked files only, so the agent never received it]"
          : "SKILL.md";
  const skillMdSectionBody =
    skillMdStatus === "readable"
      ? skillMd
      : skillMdStatus === "untracked"
        ? `(SKILL.md exists at ${skillMdPath} but is NOT git-tracked, so staging did not deliver it — the agent ran without it. Its CONTENT is deliberately withheld here: grading against text the agent never received manufactures false "already covered" verdicts.)`
        : skillMdStatus === "unreadable"
          ? `(SKILL.md exists at ${skillMdPath} but could not be read)`
          : `(no SKILL.md found at ${skillMdPath})`;

  const sections: EvidenceSection[] = [
    sec("Final answer (turn 1)" + turn1ResultDegradedNote, bound(finalMessage, FINAL_MESSAGE_CAP)),
    sec("Turn-1 outcome" + turn1ResultDegradedNote, bound(safeJson({ result: outcome, resultSubtype }), STRUCTURED_CAP)),
    sec("toolCounts (turn 1, top-level tool calls)" + turn1ResultDegradedNote, bound(safeJson(toolCounts), STRUCTURED_CAP)),
    sec("skillActivity (turn 1, per-invocation window rollups)" + turn1ResultDegradedNote, bound(safeJson(skillActivity), STRUCTURED_CAP)),
    sec("Sub-agents dispatched (turn 1; agentType/description only)" + turn1ResultDegradedNote, bound(safeJson(subagents), STRUCTURED_CAP)),
    sec(
      "Sub-agent research (each dispatch's own WebSearch query + bounded result; live-lane capture — absence is NOT evidence of no research)" +
        turn1ResultDegradedNote,
      bound(subagentResearch, SUBAGENT_RESEARCH_CAP),
    ),
    sec(
      "referencesAccessed (turn 1, MAIN AGENT + SUB-AGENTS, references/+scripts/ under the mounted skill, " +
        "with the tool channel each was reached through — NEVER includes SKILL.md itself, which is delivered " +
        "whole and never Read as a file. Under-approximates: a `cd` then a bare relative `cat`, a heredoc, or " +
        "a $VAR-built path is invisible, so absence is WEAK evidence and never proof the content went unread)" +
        turn1ResultDegradedNote,
      bound(
        !accessObservable
          ? "(unavailable — this run recorded no observable tool stream; absence here is NOT evidence of no access)"
          : accessLines.length
            ? accessLines.join("\n")
            : "(none observed)",
        REFERENCES_READ_CAP,
      ),
    ),
    // The NARROW Read-tool signal, kept as its own line rather than folded away. `read` is the strongest
    // channel — the agent opened the file through the file-reading tool — while a `bash` entry can be any
    // command that named the path. Collapsing them would cost the evaluator the one distinction that
    // separates "reached the content" from "referred to the file".
    sec(
      "referencesRead (turn 1, main agent + sub-agents, the Read-TOOL subset of the section above — the " +
        "strongest evidence of access; a path present above but absent here was reached some other way)" +
        turn1ResultDegradedNote,
      bound(allReads.length ? allReads.join("\n") : "(none)", REFERENCES_READ_CAP),
    ),
    // Corpus sections: the ceiling was already applied per-file above, so these are passed through the
    // forgery-neutralizing `bound` at their own (already-satisfied) size rather than re-rationed here.
    sec(skillMdSectionTitle, boundText(skillMdSectionBody, SKILL_CORPUS_CEILING)),
    ...agentBodies.map((a) => sec(a.title, boundText(a.body, SKILL_CORPUS_CEILING))),
    ...rootRefBodies.map((r) => sec(r.title, boundText(r.body, SKILL_CORPUS_CEILING))),
    sec(
      "references/ available (the SKILL's own, as paths relative to references/, recursive; a multi-skill plugin's SHARED references are listed separately below as their own content sections)",
      bound(referenceFiles.length ? referenceFiles.map(displayName).join("\n") : "(none)", REFERENCE_LIST_CAP),
    ),
    sec(
      "references/ content (each file WHOLE under a '### <path>' header; a cut or omitted file is marked with its reason, and absence past a cut is not evidence)",
      boundText(referencesContent, SKILL_CORPUS_CEILING + referencesOverheadBytes),
    ),
    sec(
      "Attached inputs (mnt/uploads filenames + sizes, and connected-folder mount names — NOT content)",
      bound(listAttachedInputs(runDir), ATTACHED_INPUTS_CAP),
    ),
    sec(
      "Transcript (turn 1 only — the reflection turn's own reads/output are excluded by construction)" +
        (turn1SliceDegraded
          ? " [DEGRADED: the turn-1/turn-2 boundary for this fallback slice could not be verified — treat gaps as unknown, not as evidence of absence]"
          : ""),
      boundEnds(transcript, TRANSCRIPT_CAP),
    ),
  ];

  // Section-aware overall cap (belt-and-suspenders; the per-section budgets sum under it, so this should
  // never fire — `sectionBudgetSum()` and its test pin that). Two corrections over the previous loop:
  //
  //  1. CONVERGENCE. `boundText` APPENDS a marker after cutting, so shaving a section by exactly
  //     `overflow` left the package MARKER_BYTES over; the loop then shaved the next section by that
  //     amount and re-added the same marker — net zero — cascading through every section and exiting
  //     STILL over cap with the whole document mangled and spuriously truncation-flagged. Subtracting
  //     MARKER_BYTES from the target makes one pass actually sufficient.
  //  2. ORDER. It shaved the LAST section first, which is the Transcript — so a breach caused by an
  //     oversized skill CORPUS was paid for by destroying the RUN RECORD, the only run-variant evidence
  //     in the package. Trim priority is now explicit and independent of render order: corpus content
  //     first (it caused the breach and has its own loud per-file accounting above), transcript last.
  const { pkg, trimRecord } = trimToPackageCap(sections, MAX_PACKAGE_BYTES);
  if (trimRecord.length) truncated = true;
  return {
    pkg,
    sections,
    truncated,
    turn1ResultDegraded,
    turn1SliceDegraded,
    skillMdStatus,
    corpusBytes,
    corpusCeiling: SKILL_CORPUS_CEILING,
    // `tag` is internal reconciliation state; the reported row keeps only what a consumer needs.
    corpusCuts: corpusCuts.map(({ name, keptBytes, totalBytes, omitted }) => ({ name, keptBytes, totalBytes, omitted })),
    corpusExcluded,
    // Entry keys MINUS anything the ceiling zeroed. A partially cut file stays listed: content did ship,
    // and `corpusCuts` already reports the byte loss, so dropping it would under-report the other way.
    // Placeholders never become entries at all (see `corpusEntries`), so they need no filtering here.
    corpusPackaged: corpusEntries.filter((e) => !corpusCuts.some((c) => c.omitted && c.tag === e.tag)).map((e) => e.key),
    corpusOmitted,
    trimRecord,
    packageTruncated: truncated,
    // `undefined` when the turn-1 result was degraded (unknown) OR when the skill ships no references at
    // all — "nothing was Read" is not a signal about a skill that has nothing to read, and emitting it
    // there is noise a consumer reads as a warning about material that does not exist.
    // Now keyed on the WIDE list. Also `undefined` when the run recorded no observable tool stream —
    // "we could not look" must never render as "nothing was opened".
    referenceAccessUnobservable: !accessObservable,
    noSkillFilesRead:
      // Packaged plugin-root references are readable material too: a skill with NO local references but a
      // linked shared tree has something to read, so the "nothing to read" suppression must account for
      // them or it reports a skill as having nothing when it has six files.
      turn1ResultDegraded ||
      !accessObservable ||
      (referenceFiles.length === 0 && deliveredScripts.length === 0 && rootRefBodies.length === 0)
        ? undefined
        : (allAccesses ?? []).length === 0,
  };
}

/** The belt-and-suspenders overall-cap trim. Exported so its convergence and ORDER can be tested directly:
 *  it is unreachable through `packageEvidence` while the per-section budgets sum under the cap, so a test
 *  that reimplements the loop would pin nothing. Mutates `sections` in place and returns the rendered
 *  package plus a record of what it shaved. */
export function trimToPackageCap(
  sections: EvidenceSection[],
  cap: number,
): { pkg: string; trimRecord: Array<{ section: string; droppedBytes: number }> } {
  const trimOrder = [...sections.keys()].sort((a, b) => trimPriority(sections[b]!.title) - trimPriority(sections[a]!.title));
  const trimRecord: Array<{ section: string; droppedBytes: number }> = [];
  let pkg = renderSections(sections);
  for (const i of trimOrder) {
    const over = Buffer.byteLength(pkg, "utf8") - cap;
    if (over <= 0) break;
    const bodyBytes = Buffer.byteLength(sections[i]!.body, "utf8");
    const target = Math.max(0, bodyBytes - over - MARKER_BYTES);
    if (target >= bodyBytes) continue; // nothing to gain from this section
    sections[i]!.body = boundText(sections[i]!.body, target);
    trimRecord.push({ section: sections[i]!.title, droppedBytes: bodyBytes - Buffer.byteLength(sections[i]!.body, "utf8") });
    pkg = renderSections(sections);
  }
  return { pkg, trimRecord };
}

/** Trim priority: HIGHER is shaved first. The transcript is the run record — the only evidence in the
 *  package that is specific to this run rather than derivable from the skill on disk — so it is shaved
 *  LAST, no matter where it sits in render order. Corpus content goes first: it is the only thing large
 *  enough to cause a breach, and its per-file cut is already accounted for and reported. */
function trimPriority(title: string): number {
  if (title.startsWith("references/ content") || title.startsWith(ROOT_REFERENCE_SECTION_PREFIX)) return 3;
  if (title.startsWith("SKILL.md") || title.startsWith(AGENT_SECTION_PREFIX)) return 2;
  if (title.startsWith("Transcript")) return 0;
  return 1;
}
