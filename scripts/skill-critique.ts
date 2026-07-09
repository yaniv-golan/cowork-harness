// The reflective skill-critique loop's command: task run -> resume for a self-report -> evaluate the
// self-report against turn-1-only evidence -> print a triaged, human-adjudicated report.
//
//   tsx scripts/skill-critique.ts <skill-folder> --prompt "<probe>" [--dotenv <path>]
//                                 [--fidelity container] [--evaluator-model <id>] [--output-format json|text]
//
// This is a DISCOVERY instrument, not a gate: it never fails CI and it never edits the skill. It always
// exits 0 — including when the task run itself errors — because the point is to surface improvement ideas
// for a human to read, not to render a pass/fail verdict (see docs/internal's reflective-critique plan).
// Container tier only: the resume-continuity behavior this loop depends on (the reflection turn seeing the
// SAME mounted skill + session as the task turn) is verified for the container fidelity tier specifically,
// so the tier is pinned rather than left to the caller.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { packageEvidence } from "../src/critique/package-evidence.js";
import { snapshotTurnBoundary } from "../src/critique/evidence.js";
import { runCritique, DEFAULT_EVALUATOR_MODEL } from "../src/critique/evaluator.js";
import type { CritiqueItem } from "../src/critique/evidence.js";

const REFLECTION_PROMPT_VERSION = 1;

/** The fixed, versioned reflection-turn prompt. Asks for the agent's SUBJECTIVE experience (unreliable but
 *  valuable — the whole point of this loop) plus concrete improvement ideas, framed so it names specifics
 *  (files, sections, moments of confusion) rather than generic praise/complaint. Dev-only asset: this is a
 *  maintainer instrument, never shipped as part of any skill payload. */
const REFLECTION_PROMPT = `The task you just completed is done — this is a separate follow-up question about
your OWN experience using the skill, not a continuation of the task itself.

Reflect honestly on how the skill's guidance (SKILL.md and anything under references/ or scripts/) served
you while you worked:

1. Was anything in the skill's guidance UNCLEAR, MISSING, or MISLEADING? Be specific — name the file or
   section if you can, and describe exactly what confused you or what you looked for and could not find.
2. Did you have to GUESS at anything (a fidelity tier, a file path, a format, an ordering) because the
   guidance didn't say? What did you guess, and what would have told you the right answer instead?
3. Did you read something (a reference, a script) and then find it didn't actually help, or find the
   guidance elsewhere contradicted it?
4. If you could change ONE thing about this skill to make your job easier next time, what would it be, and
   why?

Answer plainly, in prose. Do not restate the task's final answer.`;

interface ParsedArgs {
  skillFolder: string;
  prompt: string;
  dotenv?: string;
  fidelity: string;
  evaluatorModel?: string;
  outputFormat: "json" | "text";
}

function usage(): string {
  return (
    'usage: tsx scripts/skill-critique.ts <skill-folder> --prompt "<probe>" [--dotenv <path>] ' +
    "[--fidelity container] [--evaluator-model <id>] [--output-format json|text]"
  );
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  let prompt: string | undefined;
  let dotenv: string | undefined;
  let fidelity = "container";
  let evaluatorModel: string | undefined;
  let outputFormat: "json" | "text" = "text";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--prompt") prompt = argv[++i];
    else if (a === "--dotenv") dotenv = argv[++i];
    else if (a === "--fidelity") fidelity = argv[++i];
    else if (a === "--evaluator-model") evaluatorModel = argv[++i];
    else if (a === "--output-format") outputFormat = argv[++i] as "json" | "text";
    else if (a.startsWith("-")) throw new Error(`unknown flag: ${a}\n${usage()}`);
    else positional.push(a);
  }
  if (positional.length !== 1) throw new Error(usage());
  if (!prompt || !prompt.trim()) throw new Error(`--prompt "<probe>" is required\n${usage()}`);
  if (fidelity !== "container")
    throw new Error(
      `skill-critique is container-tier only (the resume-continuity behavior it relies on is only verified there); got --fidelity ${fidelity}`,
    );
  if (outputFormat !== "json" && outputFormat !== "text")
    throw new Error(`--output-format must be "text" or "json" (got "${outputFormat}")`);
  return { skillFolder: positional[0], prompt, dotenv, fidelity, evaluatorModel, outputFormat };
}

interface TurnOutcome {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** One `npx tsx src/cli.ts skill ...` spawn, captured (never lets a non-zero exit throw — the caller
 *  decides what a failed turn means for the report). */
function runSkillTurn(args: string[]): Promise<TurnOutcome> {
  return new Promise((resolvePromise) => {
    const child = spawn("npx", ["tsx", "src/cli.ts", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => resolvePromise({ stdout, stderr, code }));
    child.on("error", (e) => resolvePromise({ stdout, stderr: stderr + `\n[spawn error] ${String(e)}`, code: null }));
  });
}

interface SkillEnvelope {
  ok?: boolean;
  results?: Array<{
    outDir?: string;
    finalMessage?: string;
    result?: "success" | "error";
    resultSubtype?: string;
  }>;
}

/** Best-effort parse of the `skill --output-format json` envelope (one compact line on stdout). Returns
 *  null rather than throwing — a usage/transport failure before any envelope was ever printed is a
 *  legitimate, reportable outcome, not a bug in this parser. */
function parseEnvelope(stdout: string): SkillEnvelope | null {
  const line = stdout.trim();
  if (!line) return null;
  try {
    return JSON.parse(line) as SkillEnvelope;
  } catch {
    return null;
  }
}

/** The run dir, preferring the envelope's `outDir` and falling back to the `[status] <path>` stderr line
 *  (written unconditionally by the harness regardless of `--output-format`) — so a run whose stdout
 *  envelope didn't parse (e.g. it crashed before ever writing one) can still be located via `--keep`. */
function extractOutDir(turn: TurnOutcome): string | undefined {
  const env = parseEnvelope(turn.stdout);
  const fromEnvelope = env?.results?.[0]?.outDir;
  if (typeof fromEnvelope === "string" && fromEnvelope) return fromEnvelope;
  const m = turn.stderr.match(/^\[status\] (.+)$/m);
  return m?.[1];
}

function extractFinalMessage(turn: TurnOutcome): string | undefined {
  const fm = parseEnvelope(turn.stdout)?.results?.[0]?.finalMessage;
  return typeof fm === "string" ? fm : undefined;
}

function extractResult(turn: TurnOutcome): "success" | "error" | undefined {
  return parseEnvelope(turn.stdout)?.results?.[0]?.result;
}

type Bucket = "actionable" | "other" | "not-adjudicable" | "dropped";

function bucketOf(item: CritiqueItem): Bucket {
  if (item.citationResolved === false) return "dropped";
  if (item.classification === "not-adjudicable") return "not-adjudicable";
  if (item.classification === "grounded-and-actionable") return "actionable";
  return "other";
}

function formatItem(item: CritiqueItem): string {
  const excerpt = item.evidence.length > 220 ? item.evidence.slice(0, 220) + "…" : item.evidence;
  const lines = [`  [${item.source}] (${item.classification}) ${item.idea}`, `    recommended action: ${item.recommendedAction}`];
  if (excerpt) lines.push(`    evidence: "${excerpt}"`);
  return lines.join("\n");
}

function printTextReport(args: {
  skillFolder: string;
  prompt: string;
  sessionId: string;
  outDir: string;
  taskResult: "success" | "error" | undefined;
  selfReport: string | undefined;
  items: CritiqueItem[];
  evaluatorModel: string;
  evaluatorError?: string;
}): void {
  const { skillFolder, prompt, sessionId, outDir, taskResult, selfReport, items, evaluatorModel, evaluatorError } = args;
  const out: string[] = [];
  out.push(`skill-critique: ${skillFolder}`);
  out.push(`  probe: ${prompt}`);
  out.push(`  session: ${sessionId}`);
  out.push(`  run dir: ${outDir}`);
  out.push(`  task run result: ${taskResult ?? "unknown (envelope unavailable)"}`);
  out.push(`  evaluator model: ${evaluatorModel}`);
  if (taskResult === "error")
    out.push(`  NOTE: the task run ended in error — recommendations below reflect whatever happened before the failure.`);
  if (selfReport === undefined) out.push(`  NOTE: no self-report was captured (the reflection turn produced no finalMessage).`);
  out.push("");

  if (evaluatorError) {
    out.push(`EVALUATOR FAILED: ${evaluatorError}`);
    out.push(`No critique items were produced. Re-run, or inspect ${outDir} directly.`);
    process.stdout.write(out.join("\n") + "\n");
    return;
  }

  const byBucket = new Map<Bucket, CritiqueItem[]>();
  for (const item of items) {
    const b = bucketOf(item);
    (byBucket.get(b) ?? byBucket.set(b, []).get(b)!).push(item);
  }

  const section = (title: string, bucket: Bucket, note?: string) => {
    const bucketItems = byBucket.get(bucket) ?? [];
    out.push(`${title} (${bucketItems.length})${note ? ` — ${note}` : ""}`);
    if (bucketItems.length === 0) out.push("  (none)");
    else for (const item of bucketItems) out.push(formatItem(item));
    out.push("");
  };

  section("ACTIONABLE", "actionable", "grounded, worth doing");
  section("OTHER CLASSIFIED FINDINGS", "other", "grounded-but-not-worth-it / already-covered / confabulated");
  section("NOT ADJUDICABLE", "not-adjudicable", "evidence can't decide — human judgment call");
  section(
    "DROPPED (citation did not resolve)",
    "dropped",
    "NOT validated against the evidence package — shown for transparency only, do not act on these as-is",
  );

  if (items.length === 0) out.push("No findings from either pass.");
  process.stdout.write(out.join("\n") + "\n");
}

async function main(): Promise<void> {
  let opts: ParsedArgs;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(0); // this command owns exit 0 — even a usage mistake must not fail a caller's pipeline
    return;
  }

  const dotenvArgs = opts.dotenv ? ["--dotenv", opts.dotenv] : [];
  const sessionId = `crit-${randomUUID()}`;

  try {
    // 1. Task turn.
    const task = await runSkillTurn([
      ...dotenvArgs,
      "skill",
      opts.skillFolder,
      opts.prompt,
      "--fidelity",
      "container",
      "--session-id",
      sessionId,
      "--keep",
      "--output-format",
      "json",
    ]);
    const outDir = extractOutDir(task);
    if (!outDir) {
      process.stderr.write(
        `skill-critique: could not determine the task run's directory (no envelope outDir and no [status] line).\n` +
          `--- task stdout ---\n${task.stdout}\n--- task stderr (tail) ---\n${task.stderr.slice(-4000)}\n`,
      );
      process.exit(0);
      return;
    }
    const taskResult = extractResult(task);

    // 2. Snapshot the turn-1/turn-2 boundary BEFORE the reflection turn touches anything.
    const boundary = snapshotTurnBoundary(outDir);

    // 3. Reflection turn: resume the SAME session.
    const reflect = await runSkillTurn([
      ...dotenvArgs,
      "skill",
      opts.skillFolder,
      REFLECTION_PROMPT,
      "--session-id",
      sessionId,
      "--resume",
      "--fidelity",
      "container",
      "--on-unanswered",
      "first",
      "--output-format",
      "json",
    ]);
    const selfReport = extractFinalMessage(reflect);

    // 4. Package the TURN-1-ONLY evidence and run the two-pass evaluator.
    const { pkg, truncated } = packageEvidence(outDir, boundary, opts.skillFolder);
    let items: CritiqueItem[] = [];
    let evaluatorError: string | undefined;
    try {
      items = await runCritique(pkg, selfReport ?? "(no self-report captured — the reflection turn produced no finalMessage)", {
        ...(opts.evaluatorModel ? { model: opts.evaluatorModel } : {}),
        packageTruncated: truncated,
      });
    } catch (e) {
      evaluatorError = (e as Error).message;
    }

    // 5. Report.
    if (opts.outputFormat === "json") {
      process.stdout.write(
        JSON.stringify(
          evaluatorError
            ? { skillFolder: opts.skillFolder, sessionId, outDir, taskResult, evaluatorError, items: [] }
            : { skillFolder: opts.skillFolder, sessionId, outDir, taskResult, items },
        ) + "\n",
      );
    } else {
      printTextReport({
        skillFolder: opts.skillFolder,
        prompt: opts.prompt,
        sessionId,
        outDir,
        taskResult,
        selfReport,
        items,
        evaluatorModel: opts.evaluatorModel ?? DEFAULT_EVALUATOR_MODEL,
        evaluatorError,
      });
    }
  } catch (e) {
    process.stderr.write(`skill-critique: unexpected failure: ${(e as Error).stack ?? String(e)}\n`);
  }
  process.exit(0); // ALWAYS 0 — this is a discovery instrument, never a gate; the caller owns this exit code
}

import { pathToFileURL } from "node:url";
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) void main();

// Exported for the reflection-prompt version to be inspectable/testable without spawning anything.
export { REFLECTION_PROMPT, REFLECTION_PROMPT_VERSION, parseArgs };
