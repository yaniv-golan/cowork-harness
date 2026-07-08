// Scores the cowork-harness skill's evals against the skill's ACTUAL bundled content (SKILL.md +
// references/*.md + each eval's evals/files/*), so a skill-content edit that guts or drifts an
// answer becomes visible as a claim-passCount regression instead of silently shipping.
//
//   npx tsx scripts/run-evals.ts --dry-run     # validate + assemble prompts, zero model calls
//   npm run evals -- --out report.json         # live run, also writes the graded report to a file
//
// Env overrides: COWORK_EVAL_ANSWER_MODEL, COWORK_EVAL_JUDGE_MODEL, COWORK_EVAL_REPS.
//
// LIVE PATH IS UNVALIDATED IN THIS COMMIT. defaultCallModel() shells out to the `claude` CLI and
// has not been exercised end-to-end against real models — treat any live run's numbers as needing
// a live smoke test before trusting them for a real before/after diff.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SKILL_DIR = join(REPO_ROOT, ".claude/skills/cowork-harness");
export const EVALS_DIR = join(SKILL_DIR, "evals");
export const EVALS_JSON_PATH = join(EVALS_DIR, "evals.json");
export const REFERENCES_DIR = join(SKILL_DIR, "references");

/** The answering model — PINNED, not "whatever is strongest available".
 *  Deliberately a MID tier: a too-strong answerer can reconstruct gutted/edited skill content from
 *  its own pretraining knowledge of what a good cowork-harness answer "should" look like, which
 *  would mask a real regression in SKILL.md/references content. A weaker/mid answerer is forced to
 *  actually rely on the supplied context, which makes it a MORE SENSITIVE regression detector. */
export const DEFAULT_ANSWER_MODEL = "claude-sonnet-5";
/** The judge model — PINNED to a strong tier so rubric-point grading is trustworthy. */
export const DEFAULT_JUDGE_MODEL = "claude-opus-4-8";
export const DEFAULT_REPS = 3;

export const ANSWER_MODEL = process.env.COWORK_EVAL_ANSWER_MODEL || DEFAULT_ANSWER_MODEL;
export const JUDGE_MODEL = process.env.COWORK_EVAL_JUDGE_MODEL || DEFAULT_JUDGE_MODEL;
export const REPS = Number(process.env.COWORK_EVAL_REPS) || DEFAULT_REPS;

const JUDGE_SYSTEM =
  "You are a strict, literal-minded grading judge. Follow the rubric-point instructions exactly and " +
  "respond with STRICT JSON only — no markdown code fences, no prose outside the JSON object.";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EvalCase {
  id: number;
  name: string;
  prompt: string;
  expected_output: string;
  files: string[];
}

interface EvalsFile {
  skill_name: string;
  evals: EvalCase[];
}

export interface FileContent {
  path: string;
  content: string;
}

export interface JudgeClaim {
  claim: string;
  pass: boolean;
}

export interface JudgeResult {
  claims: JudgeClaim[];
  notes: string;
}

export interface AggregatedClaim {
  claim: string;
  passCount: number;
  reps: number;
}

export interface EvalReport {
  id: number;
  name: string;
  claims: AggregatedClaim[];
  claimsPassedAllReps: number;
  claimsTotal: number;
}

export interface Report {
  model: { answer: string; judge: string; reps: number };
  evals: EvalReport[];
}

/** Single injectable seam for every model call — the entire live/stub boundary. */
export type CallModel = (model: string, system: string, user: string) => Promise<string>;

export interface RunOptions {
  answerModel: string;
  judgeModel: string;
  reps: number;
  callModel: CallModel;
}

// ---------------------------------------------------------------------------
// Pure logic (testable without any model calls)
// ---------------------------------------------------------------------------

/** Load + validate evals.json. Throws a clear error on any eval missing a required non-empty field. */
export function loadEvals(evalsJsonPath: string = EVALS_JSON_PATH): EvalCase[] {
  const raw = JSON.parse(readFileSync(evalsJsonPath, "utf8")) as EvalsFile;
  const evals = raw.evals ?? [];
  for (const e of evals) {
    if (typeof e.id !== "number") {
      throw new Error(`loadEvals: eval missing a numeric "id": ${JSON.stringify(e)}`);
    }
    for (const key of ["name", "prompt", "expected_output"] as const) {
      if (typeof e[key] !== "string" || e[key].trim() === "") {
        throw new Error(`loadEvals: eval id=${e.id} missing a non-empty "${key}"`);
      }
    }
    if (!Array.isArray(e.files)) {
      throw new Error(`loadEvals: eval id=${e.id} "files" must be an array`);
    }
  }
  return evals;
}

/** Read SKILL.md + every references/*.md — the exact payload a real skill install delivers to the
 *  answering model. Sorted so the assembled context is stable across filesystem readdir order. */
export function loadSkillPayload(
  skillDir: string = SKILL_DIR,
  referencesDir: string = REFERENCES_DIR,
): { skillMd: string; references: FileContent[] } {
  const skillMd = readFileSync(join(skillDir, "SKILL.md"), "utf8");
  const refFiles = readdirSync(referencesDir)
    .filter((f) => f.endsWith(".md"))
    .sort();
  const references = refFiles.map((f) => ({
    path: `references/${f}`,
    content: readFileSync(join(referencesDir, f), "utf8"),
  }));
  return { skillMd, references };
}

/** Resolve + read an eval's declared `files` entries (paths are relative to evals/, e.g.
 *  "files/report-check.cassette.json") — kept RELATIVE in the label so the assembled prompt is
 *  stable across checkouts. */
export function loadEvalFiles(evalCase: EvalCase, evalsDir: string = EVALS_DIR): FileContent[] {
  return evalCase.files.map((f) => ({ path: f, content: readFileSync(join(evalsDir, f), "utf8") }));
}

/** Concatenate SKILL.md + references + this eval's files into the answering model's system/context
 *  message. This IS the install payload — the whole point is that a content edit anywhere in it
 *  becomes visible in eval scores, so nothing here should be summarized or truncated. */
export function buildAnswerContext(skillMd: string, references: FileContent[], evalFiles: FileContent[]): string {
  const parts = [`=== SKILL.md ===\n${skillMd}`];
  for (const r of references) parts.push(`=== ${r.path} ===\n${r.content}`);
  for (const f of evalFiles) parts.push(`=== evals/${f.path} ===\n${f.content}`);
  return parts.join("\n\n");
}

/** Build the judge's rubric-point grading prompt: (a) extract checkable claims from expected_output,
 *  (b) decide pass/fail per claim against the candidate answer, (c) return strict JSON. */
export function buildJudgePrompt(evalCase: EvalCase, candidateAnswer: string): string {
  return `You are grading a candidate answer produced by another model for eval "${evalCase.name}" (id ${evalCase.id}).

## Original user prompt given to the candidate
${evalCase.prompt}

## Expected-output description (this is your grading rubric source — NOT the literal expected text)
${evalCase.expected_output}

## Candidate answer to grade
${candidateAnswer}

## Your task
1. Extract the key checkable claims from the "Expected-output description" above. Each claim should
   be a single, independently-verifiable statement (a fact, a recommendation, a distinction the
   answer must draw, something the answer must NOT claim, etc).
2. For each claim, decide whether the candidate answer satisfies it: true (pass) or false (fail).
3. Return STRICT JSON ONLY — no markdown code fences, no prose before or after — in exactly this shape:

{"claims":[{"claim":"...","pass":true},{"claim":"...","pass":false}],"notes":"..."}

Return ONLY the JSON object.`;
}

/** Extract the first balanced top-level `{...}` object from a string, ignoring braces inside JSON
 *  string literals. Returns null if none is found. Needed because a real judge model frequently emits
 *  a prose preamble ("I'll grade this answer...") before the JSON despite instructions — validated
 *  live: claude-opus-4-8 does exactly this. */
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

/** Parse the judge's response into { claims, notes }. Tolerates a markdown code fence AND a prose
 *  preamble/epilogue around the JSON (both observed from real judge models); otherwise throws a clear,
 *  actionable error — it never silently returns an empty/best-effort result for malformed output. */
export function parseJudge(raw: string): JudgeResult {
  const text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  // Prefer a fenced block; else the raw text if it is already a clean object; else the first balanced
  // {...} object embedded in prose.
  const jsonText = fenced
    ? fenced[1].trim()
    : text.startsWith("{")
      ? text
      : (extractJsonObject(text) ?? text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(
      `parseJudge: judge response was not valid JSON (${(err as Error).message}).\n--- raw response ---\n${raw}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { claims?: unknown }).claims)) {
    throw new Error(`parseJudge: judge JSON is missing a "claims" array.\n--- raw response ---\n${raw}`);
  }

  const claimsRaw = (parsed as { claims: unknown[] }).claims;
  const claims: JudgeClaim[] = claimsRaw.map((c, i) => {
    const claim = (c as { claim?: unknown }).claim;
    const pass = (c as { pass?: unknown }).pass;
    if (typeof claim !== "string" || typeof pass !== "boolean") {
      throw new Error(
        `parseJudge: claims[${i}] is malformed — expected {"claim": string, "pass": boolean}, got ${JSON.stringify(c)}.\n--- raw response ---\n${raw}`,
      );
    }
    return { claim, pass };
  });

  const notesRaw = (parsed as { notes?: unknown }).notes;
  const notes = typeof notesRaw === "string" ? notesRaw : "";

  return { claims, notes };
}

/** Aggregate N reps' judge results into per-claim pass counts. Claims are keyed by their exact text
 *  in first-seen order across reps.
 *  KNOWN LIMITATION: this assumes the judge phrases the same rubric claim consistently across reps
 *  (reasonable for a low-temperature strict-JSON grading prompt against a fixed expected_output). If
 *  the judge paraphrases a claim differently rep-to-rep, it is counted as two distinct claims each
 *  seen once rather than one claim seen twice — this shows up as `reps` < the configured rep count
 *  for that claim, which is itself a visible signal in the report rather than a silent miscount. */
export function aggregate(repResults: JudgeResult[]): AggregatedClaim[] {
  const order: string[] = [];
  const counts = new Map<string, { passCount: number; reps: number }>();
  for (const rep of repResults) {
    for (const c of rep.claims) {
      if (!counts.has(c.claim)) {
        counts.set(c.claim, { passCount: 0, reps: 0 });
        order.push(c.claim);
      }
      const entry = counts.get(c.claim)!;
      entry.reps += 1;
      if (c.pass) entry.passCount += 1;
    }
  }
  return order.map((claim) => ({ claim, ...counts.get(claim)! }));
}

// ---------------------------------------------------------------------------
// Orchestration (uses the injected callModel — testable with a stub)
// ---------------------------------------------------------------------------

/** Run one eval for `reps` repetitions: answer -> judge -> parse, then aggregate. */
export async function runEvalCase(evalCase: EvalCase, systemContext: string, opts: RunOptions): Promise<EvalReport> {
  const repResults: JudgeResult[] = [];
  for (let i = 0; i < opts.reps; i++) {
    const answer = await opts.callModel(opts.answerModel, systemContext, evalCase.prompt);
    const judgeRaw = await opts.callModel(opts.judgeModel, JUDGE_SYSTEM, buildJudgePrompt(evalCase, answer));
    repResults.push(parseJudge(judgeRaw));
  }
  const claims = aggregate(repResults);
  return {
    id: evalCase.id,
    name: evalCase.name,
    claims,
    claimsPassedAllReps: claims.filter((c) => c.passCount === opts.reps).length,
    claimsTotal: claims.length,
  };
}

/** Run every eval and assemble the final report. */
export async function runAll(
  evals: EvalCase[],
  skillMd: string,
  references: FileContent[],
  evalsDir: string = EVALS_DIR,
  opts: RunOptions,
): Promise<Report> {
  const evalReports: EvalReport[] = [];
  for (const evalCase of evals) {
    const evalFiles = loadEvalFiles(evalCase, evalsDir);
    const systemContext = buildAnswerContext(skillMd, references, evalFiles);
    evalReports.push(await runEvalCase(evalCase, systemContext, opts));
  }
  return { model: { answer: opts.answerModel, judge: opts.judgeModel, reps: opts.reps }, evals: evalReports };
}

// ---------------------------------------------------------------------------
// Model transport (the one non-pure piece — shells out to the `claude` CLI)
// ---------------------------------------------------------------------------

/** Default callModel: shells out to `claude -p --model <model>`, piping system+user on stdin (mirrors
 *  how this repo invokes the agent elsewhere via spawnSync — see src/egress/sidecar.ts, src/boundary.ts).
 *  Fails with a clear, actionable message if the `claude` CLI isn't on PATH. */
export const defaultCallModel: CallModel = async (model, system, user) => {
  const combined = system ? `${system}\n\n---\n\n${user}` : user;
  try {
    return execFileSync("claude", ["-p", "--model", model], {
      input: combined,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new Error(
        `run-evals: the "claude" CLI was not found on PATH. This runner shells out to ` +
          `\`claude -p --model ${model}\` for every model call (see defaultCallModel in scripts/run-evals.ts) — ` +
          `install and authenticate the Claude Code CLI before running evals live.`,
      );
    }
    throw new Error(`run-evals: "claude -p --model ${model}" failed: ${e.message}`);
  }
};

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const outIdx = args.indexOf("--out");
  const outPath = outIdx !== -1 ? args[outIdx + 1] : undefined;

  process.stderr.write(
    "run-evals: NOTE — the live model-calling path (defaultCallModel shelling out to `claude -p`) is " +
      "UNVALIDATED in this commit; it has not been exercised end-to-end against real models. Treat any " +
      "live run's numbers with caution until a live smoke test has been run.\n",
  );

  const evals = loadEvals();
  const { skillMd, references } = loadSkillPayload();

  if (dryRun) {
    const refBytes = references.reduce((s, r) => s + r.content.length, 0);
    process.stdout.write(`dry-run: loaded ${evals.length} evals from ${EVALS_JSON_PATH}\n`);
    process.stdout.write(
      `dry-run: SKILL.md ${skillMd.length} bytes; ${references.length} reference file(s) ` +
        `(${references.map((r) => r.path).join(", ")}), ${refBytes} total reference bytes\n`,
    );
    process.stdout.write(`dry-run: model config — answer=${ANSWER_MODEL} judge=${JUDGE_MODEL} reps=${REPS}\n`);

    const first = evals[0];
    const firstFiles = loadEvalFiles(first, EVALS_DIR);
    const firstContext = buildAnswerContext(skillMd, references, firstFiles);
    process.stdout.write(
      `dry-run: eval[0] id=${first.id} name=${first.name} — assembled system context ${firstContext.length} bytes, ` +
        `prompt ${first.prompt.length} bytes, files=[${first.files.join(", ")}]\n`,
    );
    process.stdout.write("dry-run: --- eval[0] assembled system context ---\n");
    process.stdout.write(firstContext + "\n");
    process.stdout.write("dry-run: --- eval[0] user prompt ---\n");
    process.stdout.write(first.prompt + "\n");
    process.stdout.write("dry-run: zero model calls made. exiting 0.\n");
    return;
  }

  const report = await runAll(evals, skillMd, references, EVALS_DIR, {
    answerModel: ANSWER_MODEL,
    judgeModel: JUDGE_MODEL,
    reps: REPS,
    callModel: defaultCallModel,
  });

  const json = JSON.stringify(report, null, 2);
  process.stdout.write(json + "\n");
  for (const e of report.evals) {
    process.stdout.write(
      `eval ${e.id} (${e.name}): ${e.claimsPassedAllReps}/${e.claimsTotal} claims passed all ${report.model.reps} reps\n`,
    );
  }
  if (outPath) {
    writeFileSync(outPath, json + "\n");
    process.stderr.write(`wrote report to ${outPath}\n`);
  }
}

// Run only when invoked directly (so a test can import the pure functions without side effects).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    process.stderr.write(`run-evals: fatal: ${err?.stack ?? err}\n`);
    process.exitCode = 1;
  });
}
