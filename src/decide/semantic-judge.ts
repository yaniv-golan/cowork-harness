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
const DEFAULT_JUDGE_MODEL = process.env.COWORK_HARNESS_JUDGE_MODEL || "claude-opus-4-8";

/** Extract EVERY balanced top-level `{...}` object from a string, ignoring braces inside JSON string
 *  literals. Judge models routinely wrap the JSON in prose, restate it fenced + unfenced, or echo the
 *  prompt's own example — so there can be several top-level groups. Returned in source order. */
export function extractAllJsonObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) out.push(text.slice(start, i + 1));
      }
    }
  }
  return out;
}

/** First balanced top-level `{...}` (back-compat for non-judge callers). */
export function extractJsonObject(text: string): string | null {
  return extractAllJsonObjects(text)[0] ?? null;
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
Return STRICT JSON ONLY — no markdown code fences, no prose before or after. Emit one result object per
rubric index (0..${rubric.length - 1}), in this SHAPE — a template: replace each <…> placeholder with a
real value; do NOT copy the placeholders verbatim:
{"results":[{"index":<claim number>,"pass":<true or false>}, …]}`;
}

/** Try to read one balanced `{...}` group as a FULL-COVERAGE grade: a `results` array with exactly one
 *  `{index:number,pass:boolean}` per rubric index `0..n-1`. Returns the ordered pass map, or null if this
 *  group isn't a valid full grade (so the prompt's own embedded EXAMPLE, a partial restatement, or a prose
 *  brace group is simply skipped rather than mistaken for the grade). */
function tryParseGrade(group: string, rubric: string[]): boolean[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(group);
  } catch {
    return null;
  }
  const results = (parsed as { results?: unknown }).results;
  if (!Array.isArray(results)) return null;
  const byIndex = new Map<number, boolean>();
  for (const r of results) {
    const idx = (r as { index?: unknown }).index;
    const pass = (r as { pass?: unknown }).pass;
    if (typeof idx !== "number" || typeof pass !== "boolean") return null;
    if (byIndex.has(idx)) return null; // duplicate index within one group
    byIndex.set(idx, pass);
  }
  if (byIndex.size !== rubric.length) return null;
  const grade: boolean[] = [];
  for (let i = 0; i < rubric.length; i++) {
    const p = byIndex.get(i);
    if (p === undefined) return null; // not exactly 0..n-1
    grade.push(p);
  }
  return grade;
}

/** Parse the judge's indexed JSON into per-claim results aligned to `rubric` BY INDEX. Scans EVERY
 *  top-level `{...}` group (handles fenced/unfenced restatements and a leading prose brace), keeps those
 *  that are a valid full-coverage grade, **dedupes structurally-identical grades** (a judge that restates
 *  its own JSON must not self-invalidate), and requires **exactly one distinct** grade. Zero (malformed /
 *  partial) or more than one *distinct* grade throws — a malformed/ambiguous grade must fail loud so the
 *  caller marks the rep INVALID, never manufacturing a pass/fail (and never silently grabbing the prompt's
 *  embedded example). */
export function parseJudgeResults(raw: string, rubric: string[]): SemanticClaimResult[] {
  const groups = extractAllJsonObjects(raw);
  const distinct = new Map<string, boolean[]>();
  for (const g of groups) {
    const grade = tryParseGrade(g, rubric);
    if (grade) distinct.set(grade.join(","), grade); // dedupe identical grades
  }
  if (distinct.size === 0)
    throw new Error(
      `semantic judge: no valid full-coverage {results:[…]} grade for a ${rubric.length}-claim rubric.\n--- raw judge output ---\n${raw}`,
    );
  if (distinct.size > 1)
    throw new Error(
      `semantic judge: ${distinct.size} DIFFERENT full-coverage grades in one reply (ambiguous).\n--- raw judge output ---\n${raw}`,
    );
  const grade = [...distinct.values()][0];
  return rubric.map((claim, index) => ({ index, claim, pass: grade[index] }));
}

/** The real semantic judge. `complete` is injectable so tests exercise the parse/prompt logic without a
 *  model call; the default is the shared `claude -p` transport (`claudeCliComplete`, with its timeout /
 *  retry / bin-override). Pin the model to a dated id for a reproducible before/after gate. */
export function makeSemanticJudge(opts: { model?: string; complete?: Complete } = {}): SemanticJudge {
  // The REQUESTED model/alias (e.g. "opus") — only ever used to make the call. Never read back for
  // provenance: `complete()` (the transport, e.g. `claudeCliComplete`) resolves an alias to a concrete,
  // dated model id per call (see llm-transport.ts's `parseEnvelope` / `CompleteResult.model`), and a
  // floating alias can resolve to a DIFFERENT concrete model between calls (F11) — so the requested alias
  // alone is not a truthful "which model graded" record.
  const requestedModel = opts.model ?? DEFAULT_JUDGE_MODEL;
  const complete = opts.complete ?? claudeCliComplete;
  const judge: SemanticJudge = async (rubric, answer) => {
    const { text, model: resolvedModel } = await complete(buildJudgePrompt(rubric, answer), requestedModel);
    // Stash the per-call RESOLVED model onto the judge (mutated synchronously before this async fn
    // resolves) so a caller reading `judge.model` AFTER awaiting this call sees what actually graded,
    // not the factory-time alias. This is the only way to thread a per-call, async-resolved value out of
    // this closure onto the (necessarily synchronous, factory-time) `.model` property.
    judge.model = resolvedModel;
    return parseJudgeResults(text, rubric);
  };
  // Seed with the requested alias so a caller reading `.model` BEFORE any call still gets something
  // (e.g. logging) — overwritten with the resolved model as soon as a call completes, above.
  judge.model = requestedModel;
  return judge;
}
