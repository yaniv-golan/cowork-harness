import { claudeCliComplete } from "./llm-transport.js";
import type { Complete } from "./decider.js";
import type { SemanticClaimResult, SemanticJudge } from "../assert.js";

// A semantic judge grades a FIXED, authored rubric against a run's answer, one claim at a time, by
// INDEX. It reuses the same host `claude -p --output-format json` transport as the LLM decider
// (`claudeCliComplete`): the harness process is not behind the egress proxy, so a direct API call would
// bypass the very allowlist the harness enforces — `claude -p` reuses the run's own auth and is
// egress-consistent. The rubric is given (never re-extracted per call) so results align across calls.

/** The judge model. A concrete/dated id (e.g. `claude-opus-4-8`) is preferable for a reproducible
 *  before/after comparison — a floating alias ("opus") resolves to whatever the latest is at call time.
 *  A strong grader is the right default: rubric grading needs reliability. Env-overridable; can also be
 *  set per-assert. */
export const DEFAULT_JUDGE_MODEL = process.env.COWORK_HARNESS_JUDGE_MODEL || "claude-opus-4-8";

/** Extract the first balanced top-level `{...}` object from a string, ignoring braces inside JSON string
 *  literals. Judge models frequently prepend a prose sentence ("I'll grade this answer…") before the
 *  JSON despite instructions, so a bare `JSON.parse` of the whole reply fails. Returns null if none. */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Grading prompt for a FIXED, authored rubric. The judge grades every numbered claim by its index and
 *  neither adds nor drops claims — that (plus index-keyed parsing) is what keeps results aligned across
 *  calls and reps. */
export function buildJudgePrompt(rubric: string[], answer: string): string {
  const numbered = rubric.map((c, i) => `${i}. ${c}`).join("\n");
  return `You are a strict, literal-minded grading judge. Given a candidate answer and a numbered rubric
of claims, decide for EACH claim whether the candidate answer satisfies it — pass (true) or fail (false).
Grade every claim by its index; do NOT add, drop, merge, or reorder claims.

## Rubric
${numbered}

## Candidate answer
${answer}

## Output
Return STRICT JSON ONLY — no markdown code fences, no prose before or after — in exactly this shape,
with exactly one entry per rubric index (0..${rubric.length - 1}):
{"results":[{"index":0,"pass":true},{"index":1,"pass":false}]}`;
}

/** Parse the judge's indexed JSON into per-claim results aligned to `rubric` BY INDEX. Tolerates a
 *  markdown code fence and a prose preamble/epilogue around the JSON. Throws a clear error — never
 *  guesses — when the output is malformed OR does not cover every rubric index exactly once: a
 *  malformed grade must fail loud (the caller marks the rep invalid), not manufacture a pass or fail. */
export function parseJudgeResults(raw: string, rubric: string[]): SemanticClaimResult[] {
  const text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonText = fenced ? fenced[1].trim() : text.startsWith("{") ? text : (extractJsonObject(text) ?? text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`semantic judge: response was not valid JSON (${(e as Error).message}).\n--- raw judge output ---\n${raw}`);
  }
  const results = (parsed as { results?: unknown }).results;
  if (!Array.isArray(results)) throw new Error(`semantic judge: JSON is missing a "results" array.\n--- raw judge output ---\n${raw}`);

  const byIndex = new Map<number, boolean>();
  for (const r of results) {
    const idx = (r as { index?: unknown }).index;
    const pass = (r as { pass?: unknown }).pass;
    if (typeof idx !== "number" || typeof pass !== "boolean")
      throw new Error(`semantic judge: each result must be {index:number, pass:boolean}; got ${JSON.stringify(r)}`);
    if (byIndex.has(idx)) throw new Error(`semantic judge: duplicate result for index ${idx}`);
    byIndex.set(idx, pass);
  }
  return rubric.map((claim, index) => {
    const pass = byIndex.get(index);
    if (pass === undefined)
      throw new Error(
        `semantic judge: no result for rubric index ${index} (need exactly one per index, got ${byIndex.size}/${rubric.length})`,
      );
    return { index, claim, pass };
  });
}

/** The real semantic judge. `complete` is injectable so tests exercise the parse/prompt logic without a
 *  model call; the default is the shared `claude -p` transport (`claudeCliComplete`, with its timeout /
 *  retry / bin-override). Pin the model to a dated id for a reproducible before/after gate. */
export function makeSemanticJudge(opts: { model?: string; complete?: Complete } = {}): SemanticJudge {
  const model = opts.model ?? DEFAULT_JUDGE_MODEL;
  const complete = opts.complete ?? claudeCliComplete;
  const judge: SemanticJudge = async (rubric, answer) => {
    const { text } = await complete(buildJudgePrompt(rubric, answer), model);
    return parseJudgeResults(text, rubric);
  };
  // Expose the RESOLVED judge model so the caller can record which model graded (provenance) —
  // read by runSemanticJudges into RunResult.assertions[].judgeModel.
  judge.model = model;
  return judge;
}
