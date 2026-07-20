import type { EvidenceSection } from "./armor.js";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { readTurn1ResultWithStatus, readTurn1Slice, verifyBoundaryIntegrity, type TurnBoundary } from "./evidence.js";
import { loadVmPathContext } from "../run/vm-path-ctx-file.js";

// Assembles the TURN-1-ONLY evidence document a tool-less, one-shot evaluator model is graded against.
// This packager is a from-scratch, load-bearing build (this instrument's design): a tool-less
// evaluator can't grep the logs itself, so its recall is bounded by exactly what this function decides to
// include. Every source read here is scoped to turn 1 (via `readTurn1Result`/`readTurn1Slice`, both of
// which already guarantee the reflection turn's own reads never leak in) — this module adds no new
// contamination risk, it only selects and bounds what gets shown.

/** Read the ARCHIVED turn-1 transcript out of `run.turn-1.jsonl`'s `{t:"transcript"}` line — the exact
 *  text `execute.ts` records for the completed task turn. Present once a resume has archived turn 1
 *  (`archivePriorTurnFiles`); if for any reason that file isn't there yet, fall back to the turn-1 slice of
 *  `events.jsonl` (still turn-1-only, just a rawer view than the assembled transcript string).
 *
 *  The fallback slice depends on the byte boundary `snapshotTurnBoundary` captured before the reflection
 *  turn — `degraded: true` means that dependency broke (F28: the boundary was never established, so
 *  `readTurn1Slice` refused rather than returning a false zero-byte slice; F29: the append-only prefix the
 *  boundary relies on changed between capture and packaging) and the returned text must NOT be treated as
 *  reliable ground truth by the evaluator. */
function readTurn1Transcript(runDir: string, boundary: TurnBoundary): { text: string; degraded: boolean } {
  const archived = join(runDir, "run.turn-1.jsonl");
  if (existsSync(archived)) {
    try {
      for (const line of readFileSync(archived, "utf8").split("\n")) {
        if (!line.trim()) continue;
        let obj: unknown;
        try {
          obj = JSON.parse(line);
        } catch {
          continue; // one malformed line must not sink the whole read
        }
        const rec = obj as { t?: unknown; text?: unknown };
        if (rec.t === "transcript" && typeof rec.text === "string") return { text: rec.text, degraded: false };
      }
    } catch {
      /* fall through to the slice fallback below */
    }
  }
  try {
    const text = readTurn1Slice(runDir, "events.jsonl", boundary);
    const integrity = verifyBoundaryIntegrity(runDir, "events.jsonl", boundary);
    return { text, degraded: integrity === "mismatch" };
  } catch {
    // F28: the boundary for events.jsonl was never established — an error, not a valid empty slice.
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
  } catch {
    /* uploads dir absent/unreadable — no uploads to list, not an error */
  }
  for (const name of folderNames) lines.push(`${name} (connected folder)`);

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
  return s.split(TRUNCATION_MARKER).join("[truncation-marker-lookalike redacted]");
}

function boundText(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  return buf.subarray(0, maxBytes).toString("utf8") + "\n…" + TRUNCATION_MARKER;
}

function sec(title: string, body: string): EvidenceSection {
  return { title, body: body.trim().length ? body.trim() : "(none)" };
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
const REFERENCES_READ_CAP = 1 * 1024;
const SKILL_MD_CAP = 16 * 1024;
const REFERENCE_LIST_CAP = 1 * 1024;
const TRANSCRIPT_CAP = 16 * 1024;
const ATTACHED_INPUTS_CAP = 1 * 1024;

/** The overall package hard cap — the whole assembled document is trimmed to this even if every
 *  per-section budget above was individually respected (their sum is deliberately a bit under this, but a
 *  belt-and-suspenders final trim means a future per-section budget change can never silently blow the
 *  evaluator's effective context). */
const MAX_PACKAGE_BYTES = 48 * 1024;

/** Readability of the skill's `SKILL.md` source (F31): distinguishes a legitimately-absent file (no
 *  `SKILL.md` at that path) from an unreadable one (exists, but a permission/OS error prevented reading
 *  it) — the previous prose-only fallback collapsed both into one indistinguishable "(no SKILL.md
 *  found...)" note. */
export type SkillMdStatus = "readable" | "missing" | "unreadable";

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
  /** F30 (+ residual): true when the canonical turn-1 result file (`result.turn-1.json`) either existed but
   *  failed to parse (corrupted), OR — on a validated resume (`isResume: true`) — never existed at all
   *  (missing archive). The "Turn-1 outcome" / toolCounts / skillActivity / subagents / "Final answer"
   *  sections above are therefore EMPTY DEFAULTS, not a genuinely empty turn-1 result — the evaluator must
   *  treat their absence as UNKNOWN, never as evidence something didn't happen. This is never resolved by
   *  falling back to `result.json`'s turn-2 data (that would contaminate turn-1 isolation) — it is a
   *  degradation signal only. (On a non-resumed run, a missing archive is NOT degraded — `result.json`
   *  genuinely IS turn 1 there, per `readTurn1ResultWithStatus`'s `requireArchive:false` default.) */
  turn1ResultDegraded: boolean;
  /** F28/F29: true when the turn-1 transcript's `events.jsonl`-slice fallback could not be trusted as
   *  ground truth — either the byte boundary was never established (a `snapshotTurnBoundary` stat failure)
   *  or the append-only prefix it depends on changed between the boundary snapshot and packaging. The
   *  "Transcript" section is annotated inline for the same reason, but the evaluator prompt path also needs
   *  this as a typed flag. */
  turn1SliceDegraded: boolean;
  /** F31: see `SkillMdStatus`. */
  skillMdStatus: SkillMdStatus;
}

/** Assemble the evidence document for `runCritique`. `runDir` is the KEPT run dir of the task+reflection
 *  session (post-resume, so `run.turn-1.jsonl`/`result.turn-1.json` are archived); `boundary` is the
 *  `snapshotTurnBoundary` captured right before the reflection turn; `skillDir` is the skill folder under
 *  test (containing `SKILL.md` and, optionally, a `references/` subdir). Pure and testable: every input is
 *  a path or an already-captured boundary, nothing here spawns a process or calls a model.
 *
 *  `isResume` (F30 residual): true when the CALLER has already validated this is a genuine resume (turn>1
 *  reflection) — the only case this function is actually invoked in today (`scripts/skill-critique.ts`
 *  calls this only after `validateReflectionTurn` succeeds). In that case `result.turn-1.json` MUST have
 *  been archived by the resume; a missing archive is never papered over by falling back to `result.json`
 *  (which would be TURN-2 data at that point) — it is instead treated exactly like a corrupted archive
 *  (`turn1ResultDegraded: true`, empty-default sections). Defaults to `false` so a hypothetical future
 *  single-shot (never-resumed) caller keeps the original "no archive → `result.json` IS turn 1" behavior. */
export function packageEvidence(runDir: string, boundary: TurnBoundary, skillDir: string, isResume = false): PackageEvidenceResult {
  // Track whether any budget was hit. `boundText` returns its input UNCHANGED when it fits, so `out !== s`
  // is an exact truncation signal — no separate length check that could drift from boundText's own cut rule.
  let truncated = false;
  const bound = (s: string, maxBytes: number): string => {
    const clean = neutralizeForgedTruncationMarkers(s);
    const out = boundText(clean, maxBytes);
    if (out !== clean) truncated = true;
    return out;
  };

  const turn1Result = readTurn1ResultWithStatus(runDir, isResume);
  // F30 residual: on a validated resume, "missing" is JUST as degraded as "corrupted" — `readTurn1ResultWithStatus`
  // was called with `requireArchive: isResume` above, so a "missing" status here means the archive genuinely
  // never existed (result.json was NOT silently substituted); that must be surfaced the same way a corrupt
  // archive already was, never treated as "no turn-1 result, nothing to show" (the pre-fix default for a
  // status other than "corrupted").
  const turn1ResultDegraded = turn1Result.status === "corrupted" || (isResume && turn1Result.status === "missing");
  const raw = turn1Result.value as Record<string, unknown> | null;

  const finalMessage = typeof raw?.finalMessage === "string" ? raw.finalMessage : "";
  const referencesRead = Array.isArray(raw?.referencesRead)
    ? (raw!.referencesRead as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
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
      skillMd = readFileSync(skillMdPath, "utf8");
      skillMdStatus = "readable";
    } catch {
      skillMdStatus = "unreadable";
    }
  }
  let referenceFiles: string[] = [];
  try {
    referenceFiles = readdirSync(join(skillDir, "references"), { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
  } catch {
    /* no references/ subdir — an empty list is a legitimate answer, not an error */
  }

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
        : "SKILL.md";
  const skillMdSectionBody =
    skillMdStatus === "readable"
      ? skillMd
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
      "referencesRead (turn 1, main-agent Reads only, references/+scripts/ under the mounted skill — " +
        "NEVER includes SKILL.md itself, which is delivered whole and never Read as a file)" +
        turn1ResultDegradedNote,
      bound(referencesRead.length ? referencesRead.join("\n") : "(none)", REFERENCES_READ_CAP),
    ),
    sec(skillMdSectionTitle, bound(skillMdSectionBody, SKILL_MD_CAP)),
    sec(
      "references/ available (filenames only, NOT content — presence, not coverage)",
      bound(referenceFiles.length ? referenceFiles.join("\n") : "(none)", REFERENCE_LIST_CAP),
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
      bound(transcript, TRANSCRIPT_CAP),
    ),
  ];

  // Section-aware overall cap. The previous belt-and-suspenders trim cut the FLAT string; with typed
  // sections that would leave the rendered document and the typed sections disagreeing. Shave from the
  // LAST section backwards, re-rendering each time, so they can never diverge.
  let pkg = renderSections(sections);
  for (let i = sections.length - 1; i >= 0 && Buffer.byteLength(pkg, "utf8") > MAX_PACKAGE_BYTES; i--) {
    const overflow = Buffer.byteLength(pkg, "utf8") - MAX_PACKAGE_BYTES;
    const bodyBytes = Buffer.byteLength(sections[i]!.body, "utf8");
    sections[i]!.body = boundText(sections[i]!.body, Math.max(0, bodyBytes - overflow));
    truncated = true;
    pkg = renderSections(sections);
  }
  return { pkg, sections, truncated, turn1ResultDegraded, turn1SliceDegraded, skillMdStatus };
}
