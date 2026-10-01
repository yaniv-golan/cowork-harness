import { collectSecrets, scrub } from "../secrets.js";

/**
 * Secret scrubbing for the files `critique` writes (`critique-report.json`, `critique-evidence-package.txt`,
 * `critique-salvage.json`, and the `--out` file) — the same redaction the run's own result.json, run.jsonl
 * and trace.json get. The evaluator's replies, the skill's self-report and the evidence excerpts are free
 * text the graded run produced, so they can carry a value every other artifact of that run shows as
 * `[REDACTED]`.
 *
 * JSON is scrubbed by VALUE, never as serialized text: a short scrub value, or one equal to a JSON token
 * (`true`, `1`), would otherwise rewrite JSON syntax and leave a file that no longer parses. Object keys,
 * numbers and booleans are never touched.
 *
 * A string is KEPT VERBATIM only at an exact path listed below — a join/pairing key or a closed enum a scrub
 * value could only corrupt. Paths, not key names: a field named `reason` or `source` anywhere else is
 * scrubbed, and no subtree is kept wholesale (`gradedModels[]` is a known array of model-id strings). Every
 * other string is scrubbed, so a new field is covered by default. That includes the corpus file-name lists
 * (`corpusPackaged`, `corpusExcluded`, `corpusCuts[].name`, …): display, not join keys, and the same names
 * appear as section headings in the (scrubbed) evidence package.
 *
 * `items[].findingFingerprint` is kept, and is safe to keep because it is hashed over the SCRUBBED idea and
 * action (see `findingFingerprint` in evidence.ts) — it cannot confirm a guessed value.
 *
 * `items[].evidence` stays a substring of the saved evidence package (both are scrubbed with the same forms)
 * except where an excerpt's edge cuts through a scrubbed value (documented in docs/critique.md).
 */
const REPORT_PATHS = [
  // identity / join keys — pair by (gradedSkillHash, gradedSkill)
  "sessionId",
  "outDir",
  "skillFolder",
  "skillDir",
  "gradedSkill",
  "gradedSkillHash",
  // model ids
  "gradedModels[]",
  "evaluatorModel",
  "requestedModel",
  // enums
  "fidelity",
  "requestedFidelity",
  "gradedEffectiveFidelity",
  "gradedBaseline",
  "taskResult",
  "gradedOutcome",
  "selfReportStatus",
  "skillMdStatus",
  "infraFailurePhase",
  "infraFailureKind",
  // a constant
  "verdictProvenance.kind",
  "verdictProvenance.caveat",
  // nested enums / keys
  "items[].source",
  "items[].classification",
  "items[].findingFingerprint",
  "gateAnswers[].answeredBy",
  "evidenceBudget.corpusOmitted[].reason",
];

/** Which critique JSON a value is, so the allowlist is applied at the right root. */
export type CritiqueJsonShape = "report" | "salvage" | "corpus-only";

const KEEP: Record<CritiqueJsonShape, Set<string>> = {
  report: new Set(REPORT_PATHS),
  // the salvage file's own top-level enums, plus the full report under `reportState`
  salvage: new Set(["infraFailurePhase", "infraFailureKind", ...REPORT_PATHS.map((p) => `reportState.${p}`)]),
  // `--corpus-only`'s payload (the envelope's `tool`/`version`/`command` are added after the scrub);
  // `skill` is the same resolved skills/<name> a report calls `gradedSkill`
  "corpus-only": new Set(["mode", "skillFolder", "skillDir", "skill", "corpus.corpusOmitted[].reason"]),
};

/** A deep copy of `value` with every string VALUE scrubbed, except at the exact paths kept for `shape`. */
export function scrubCritiqueJson<T>(value: T, shape: CritiqueJsonShape, secrets: string[] = collectSecrets()): T {
  if (!secrets.length) return value;
  const keep = KEEP[shape];
  const walk = (v: unknown, path: string): unknown => {
    if (typeof v === "string") return keep.has(path) ? v : scrub(v, secrets);
    if (Array.isArray(v)) return v.map((x) => walk(x, `${path}[]`));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) out[k] = walk(child, path ? `${path}.${k}` : k);
      return out;
    }
    return v;
  };
  return walk(value, "") as T;
}

/** What a critique file holds: a JSON value of a known shape (serialized here, after a by-value scrub) or
 *  free text. */
export type CritiqueFileContent = { json: unknown; shape: CritiqueJsonShape; indent?: number } | { text: string };

/** The scrubbed bytes of one critique file — the one place every critique file's content passes through. */
export function critiqueFileText(content: CritiqueFileContent, secrets: string[] = collectSecrets()): string {
  if ("text" in content) return secrets.length ? scrub(content.text, secrets) : content.text;
  return JSON.stringify(scrubCritiqueJson(content.json, content.shape, secrets), null, content.indent) + "\n";
}
