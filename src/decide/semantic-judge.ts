import { createHash } from "node:crypto";
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
const JUDGE_MODEL_FALLBACK = "claude-opus-4-8";
/** Read at USE, never at import: main() loads `.env` files (and a --dotenv) after the modules are imported,
 *  so an import-time read could never see a value set there. */
function defaultJudgeModel(): string {
  return process.env.COWORK_HARNESS_JUDGE_MODEL || JUDGE_MODEL_FALLBACK;
}

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

/** Identity of the grading-prompt TEMPLATE (placeholder rubric + answer), not of any one filled prompt —
 *  so two runs graded under different prompt wording are distinguishable even when rubric and answer match.
 *  A change here can shift every pass rate; a before/after comparison must refuse to mix hashes. */
export const JUDGE_PROMPT_HASH = createHash("sha256")
  .update(buildJudgePrompt(["<c0>", "<c1>", "<c2>"], "<ANSWER>"))
  .digest("hex")
  .slice(0, 16);

/** Total `costUSD` across every per-model entry of a transport usage map (the transport can make an
 *  auxiliary call under a second model key — that is real spend). `undefined` when no entry is priced:
 *  unpriced is not $0. */
function usageCostUsd(usage: Record<string, unknown> | undefined): number | undefined {
  let total: number | undefined;
  for (const m of Object.values(usage ?? {})) {
    const c = (m as { costUSD?: unknown } | null)?.costUSD;
    if (typeof c === "number" && Number.isFinite(c)) total = (total ?? 0) + c;
  }
  return total;
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
  const requestedModel = opts.model ?? defaultJudgeModel();
  const complete = opts.complete ?? claudeCliComplete;
  const judge: SemanticJudge = async (rubric, answer) => {
    // Cleared before the await so a transport throw never leaves the PREVIOUS call's cost behind; set
    // before parsing so a call whose grade then fails to parse still reports what it spent.
    judge.lastCostUsd = undefined;
    const { text, model: resolvedModel, usage } = await complete(buildJudgePrompt(rubric, answer), requestedModel);
    judge.lastCostUsd = usageCostUsd(usage);
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
  judge.promptHash = JUDGE_PROMPT_HASH;
  return judge;
}

/** The judges a live run grades with. `modelOverride` (a caller that must hold the judge constant, e.g. a
 *  paired comparison) grades EVERY `semantic_matches` assert with that model — a per-assert `judge_model`
 *  included — so no `judgeFor` factory is returned and runSemanticJudges uses the run-level judge
 *  throughout. Without it, a per-assert `judge_model` is honoured, as before. An injected `judge` (the
 *  test seam) is the run-level judge either way. */
export function judgesForRun(
  opts: { judge?: SemanticJudge; modelOverride?: string },
  make: (o?: { model?: string }) => SemanticJudge = makeSemanticJudge,
): { judge: SemanticJudge; judgeFor?: (model: string) => SemanticJudge } {
  if (opts.modelOverride !== undefined) return { judge: opts.judge ?? make({ model: opts.modelOverride }) };
  return { judge: opts.judge ?? make(), judgeFor: (model) => make({ model }) };
}
