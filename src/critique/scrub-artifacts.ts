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
 * The keys below are KEPT VERBATIM (the whole subtree under the key) because a consumer joins or pairs on
 * them, or they are a closed enum a scrub value could only corrupt:
 *   - identity / join keys: `sessionId`, `outDir`, `skillFolder`, `skillDir`, `gradedSkill`,
 *     `gradedSkillHash` (pair by `(gradedSkillHash, gradedSkill)`), `findingFingerprint`;
 *   - model ids: `gradedModels`, `evaluatorModel`, `requestedModel`;
 *   - enums and constants: `fidelity`, `requestedFidelity`, `gradedEffectiveFidelity`, `gradedBaseline`,
 *     `taskResult`, `gradedOutcome`, `selfReportStatus`, `skillMdStatus`, `infraFailurePhase`,
 *     `infraFailureKind`, `classification`, `source`, `answeredBy`, `reason`, `verdictProvenance`, and
 *     `--corpus-only`'s `mode` (the envelope's `tool`/`version`/`command` are added after the scrub).
 * Matched by key NAME at any depth, so a future free-text field reusing one of these names (`source`,
 * `reason`) would be kept too — name new free-text fields accordingly.
 * Everything else that is a string is scrubbed — new fields are covered by default. That includes the
 * corpus file-name lists (`corpusPackaged`, `corpusExcluded`, `corpusCuts[].name`, …): they are display,
 * not join keys, and the same names appear as section headings in the (scrubbed) evidence package.
 *
 * Two consequences, documented in docs/critique.md:
 *   - `findingFingerprint` is stamped over the UNSCRUBBED idea/recommendedAction, so it still clusters the
 *     same finding across runs but cannot be recomputed from a report whose text was scrubbed.
 *   - `items[].evidence` stays a substring of the saved evidence package (both are scrubbed with the same
 *     forms) except where an excerpt's edge cuts through a scrubbed value.
 */
const VERBATIM_KEYS = new Set([
  "sessionId",
  "outDir",
  "skillFolder",
  "skillDir",
  "gradedSkill",
  "gradedSkillHash",
  "findingFingerprint",
  "gradedModels",
  "evaluatorModel",
  "requestedModel",
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
  "classification",
  "source",
  "answeredBy",
  "reason",
  "verdictProvenance",
  "mode",
]);

/** A deep copy of `value` with every string VALUE scrubbed, except under {@link VERBATIM_KEYS}. */
export function scrubCritiqueJson<T>(value: T, secrets: string[] = collectSecrets()): T {
  if (!secrets.length) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return scrub(v, secrets);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) out[k] = VERBATIM_KEYS.has(k) ? child : walk(child);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/** What a critique file holds: a JSON value (serialized here, after a by-value scrub) or free text. */
export type CritiqueFileContent = { json: unknown; indent?: number } | { text: string };

/** The scrubbed bytes of one critique file — the one place every critique file's content passes through. */
export function critiqueFileText(content: CritiqueFileContent, secrets: string[] = collectSecrets()): string {
  if ("text" in content) return secrets.length ? scrub(content.text, secrets) : content.text;
  return JSON.stringify(scrubCritiqueJson(content.json, secrets), null, content.indent) + "\n";
}
