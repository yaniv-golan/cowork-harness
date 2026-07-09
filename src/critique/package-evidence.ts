import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readTurn1Result, readTurn1Slice, type TurnBoundary } from "./evidence.js";

// Assembles the TURN-1-ONLY evidence document a tool-less, one-shot evaluator model is graded against.
// This packager is a from-scratch, load-bearing build (§R of the reflective-critique plan): a tool-less
// evaluator can't grep the logs itself, so its recall is bounded by exactly what this function decides to
// include. Every source read here is scoped to turn 1 (via `readTurn1Result`/`readTurn1Slice`, both of
// which already guarantee the reflection turn's own reads never leak in) — this module adds no new
// contamination risk, it only selects and bounds what gets shown.

/** Read the ARCHIVED turn-1 transcript out of `run.turn-1.jsonl`'s `{t:"transcript"}` line — the exact
 *  text `execute.ts` records for the completed task turn. Present once a resume has archived turn 1
 *  (`archivePriorTurnFiles`); if for any reason that file isn't there yet, fall back to the turn-1 slice of
 *  `events.jsonl` (still turn-1-only, just a rawer view than the assembled transcript string). */
function readTurn1Transcript(runDir: string, boundary: TurnBoundary): string {
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
        if (rec.t === "transcript" && typeof rec.text === "string") return rec.text;
      }
    } catch {
      /* fall through to the slice fallback below */
    }
  }
  return readTurn1Slice(runDir, "events.jsonl", boundary);
}

/** Byte-bound a text section, appending a loud (never silent) truncation marker so the evaluator knows the
 *  section was cut rather than reading a suspiciously short document as "that's everything." Cuts on a
 *  UTF-8-safe boundary (Buffer, not string length, so a truncated multi-byte char can't corrupt the tail). */
function boundText(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  return buf.subarray(0, maxBytes).toString("utf8") + "\n…[truncated — exceeded the packager's per-section byte budget]";
}

function section(title: string, body: string): string {
  return `## ${title}\n${body.trim().length ? body.trim() : "(none)"}\n`;
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

/** The overall package hard cap — the whole assembled document is trimmed to this even if every
 *  per-section budget above was individually respected (their sum is deliberately a bit under this, but a
 *  belt-and-suspenders final trim means a future per-section budget change can never silently blow the
 *  evaluator's effective context). */
const MAX_PACKAGE_BYTES = 48 * 1024;

export interface PackageEvidenceResult {
  pkg: string;
  /** True if ANY section (or the overall document) hit its byte budget and was cut. The evaluator MUST be
   *  told this: a claim about something that fell outside a truncated window is `not-adjudicable`, NOT
   *  `confabulated` — absence from a truncated package is not proof the thing didn't happen. */
  truncated: boolean;
}

/** Assemble the evidence document for `runCritique`. `runDir` is the KEPT run dir of the task+reflection
 *  session (post-resume, so `run.turn-1.jsonl`/`result.turn-1.json` are archived); `boundary` is the
 *  `snapshotTurnBoundary` captured right before the reflection turn; `skillDir` is the skill folder under
 *  test (containing `SKILL.md` and, optionally, a `references/` subdir). Pure and testable: every input is
 *  a path or an already-captured boundary, nothing here spawns a process or calls a model. */
export function packageEvidence(runDir: string, boundary: TurnBoundary, skillDir: string): PackageEvidenceResult {
  // Track whether any budget was hit. `boundText` returns its input UNCHANGED when it fits, so `out !== s`
  // is an exact truncation signal — no separate length check that could drift from boundText's own cut rule.
  let truncated = false;
  const bound = (s: string, maxBytes: number): string => {
    const out = boundText(s, maxBytes);
    if (out !== s) truncated = true;
    return out;
  };

  const raw = readTurn1Result(runDir) as Record<string, unknown> | null;

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

  const transcript = readTurn1Transcript(runDir, boundary);

  // Skill source. SKILL.md is delivered whole to the agent and is NEVER captured by a Read event (see
  // referencesRead's own doc comment) — so it must be packaged verbatim here, or "did the agent already
  // have this guidance" is unanswerable for anything SKILL.md-resident (most of a skill's content).
  let skillMd = "";
  let skillMdFound = true;
  try {
    skillMd = readFileSync(join(skillDir, "SKILL.md"), "utf8");
  } catch {
    skillMdFound = false;
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

  const sections = [
    section("Final answer (turn 1)", bound(finalMessage, FINAL_MESSAGE_CAP)),
    section("Turn-1 outcome", bound(safeJson({ result: outcome, resultSubtype }), STRUCTURED_CAP)),
    section("toolCounts (turn 1, top-level tool calls)", bound(safeJson(toolCounts), STRUCTURED_CAP)),
    section("skillActivity (turn 1, per-invocation window rollups)", bound(safeJson(skillActivity), STRUCTURED_CAP)),
    section("Sub-agents dispatched (turn 1; agentType/description only)", bound(safeJson(subagents), STRUCTURED_CAP)),
    section(
      "referencesRead (turn 1, main-agent Reads only, references/+scripts/ under the mounted skill — " +
        "NEVER includes SKILL.md itself, which is delivered whole and never Read as a file)",
      bound(referencesRead.length ? referencesRead.join("\n") : "(none)", REFERENCES_READ_CAP),
    ),
    section(
      skillMdFound ? "SKILL.md (verbatim skill source, for presence checks the referencesRead list cannot make)" : "SKILL.md",
      bound(skillMdFound ? skillMd : `(no SKILL.md found at ${join(skillDir, "SKILL.md")})`, SKILL_MD_CAP),
    ),
    section(
      "references/ available (filenames only, NOT content — presence, not coverage)",
      bound(referenceFiles.length ? referenceFiles.join("\n") : "(none)", REFERENCE_LIST_CAP),
    ),
    section(
      "Transcript (turn 1 only — the reflection turn's own reads/output are excluded by construction)",
      bound(transcript, TRANSCRIPT_CAP),
    ),
  ];

  let pkg = sections.join("\n");
  pkg = bound(pkg, MAX_PACKAGE_BYTES); // belt-and-suspenders: the whole document, even if every section individually fit
  return { pkg, truncated };
}
