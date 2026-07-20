// The reflective skill-critique loop's command: task run -> resume for a self-report -> evaluate the
// self-report against turn-1-only evidence -> print a triaged, human-adjudicated report.
//
//   tsx scripts/skill-critique.ts <skill-folder> --prompt "<probe>" [--dotenv <path>]
//                                 [--fidelity container] [--evaluator-model <id>] [--output-format json|text]
//
// This is a DISCOVERY instrument, not a gate: it never fails CI and it never edits the skill. It always
// exits 0 — including when the task run itself errors — because the point is to surface improvement ideas
// for a human to read, not to render a pass/fail verdict .
// Container tier only: the resume-continuity behavior this loop depends on (the reflection turn seeing the
// SAME mounted skill + session as the task turn) is verified for the container fidelity tier specifically,
// so the tier is pinned rather than left to the caller.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { basename } from "node:path";
import { packageEvidence } from "./package-evidence.js";
import type { SkillMdStatus } from "./package-evidence.js";
import { snapshotTurnBoundary } from "./evidence.js";
import { runCritique, DEFAULT_EVALUATOR_MODEL } from "./evaluator.js";
import type { CritiqueItem } from "./evidence.js";

const REFLECTION_PROMPT_VERSION = 2;

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
2. Did you have to GUESS at anything (a file path, a format, a parameter value, an ordering) because the
   guidance didn't say? What did you guess, and what would have told you the right answer instead?
3. Did you read something (a reference, a script) and then find it didn't actually help, or find the
   guidance elsewhere contradicted it?
4. Did you dispatch any sub-agents during the task? If you did: was the skill's guidance clear about WHEN
   to dispatch one, WHAT instructions and context to hand it, and what to expect back — or did you have to
   improvise the dispatch prompt, or leave out context the sub-agent turned out to need? Name the specific
   dispatch and exactly what was unclear or under-specified about it. If you dispatched none, say so, and
   note whether the skill left you unsure about whether you should have.
5. List EVERY change to this skill that would have made your job easier this time — do not stop at one.
   Be exhaustive, but keep each entry concrete: name the file or section it belongs in, state the change in
   a sentence or two, and point to the specific moment in THIS run where it would have helped. Order the
   list most impactful first. Leave off anything you cannot tie to something that actually happened in
   this run.

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
  return `cowork-harness critique <skill-folder> --prompt "<probe>"

  EXPERIMENTAL. Runs the skill, asks the agent what confused it, then does NOT believe the answer:
  a blinded evaluator grades the self-report against a frozen record of what actually happened, and
  drops any claim whose citation is not verbatim in that evidence. Discovery instrument, not a gate.

  --prompt "<probe>"        the task to run the skill against (required)
  --evaluator-model <id>    override the evaluator model (env: COWORK_HARNESS_EVALUATOR_MODEL)
  --dotenv <path>           load credentials from a dotenv file
  --fidelity container      container tier only — the resume-continuity this loop depends on is
                            verified there and nowhere else
  --output-format json|text

COST AND PREREQUISITES — read before running:
  * Each critique is FOUR model workloads: two container runs (task + reflection) and two evaluator
    passes over an evidence package of up to 48KB.
  * The evaluator defaults to ${DEFAULT_EVALUATOR_MODEL} — the most expensive tier. Override it if
    that is not what you want.
  * Requires the container tier (Docker/Lima) and an authenticated \`claude\` CLI on PATH.

EXIT CODES: findings NEVER gate — any classification exits 0. Usage errors and infra/protocol
  failures exit non-zero, because a broken instrument is not a discovery outcome.

KNOWN LIMITATIONS: container tier only; SKILL.md is capped at 16KB (a larger one degrades toward
  "not adjudicable"); prompts are English-only. On a third-party skill, note that fencing separates
  the instruction plane from evidence but cannot stop hostile content that merely ARGUES — see
  docs/critique.md.`;
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
  /** F36: the wall-clock timeout fired and the process GROUP was SIGKILLed before it closed on its own. */
  timedOut: boolean;
  /** F36: stdout or stderr exceeded the byte cap and the process GROUP was SIGKILLed. */
  truncated: boolean;
}

// F36: a hung reflection (stuck container, network stall, a `claude` process that never returns) must not
// block the whole discovery command forever, and a spewing/looping child must not grow the buffer
// unbounded. Mirrors `eval-gate.ts`'s `boundedSpawnJson` (wall-clock timeout + byte cap, both killing the
// whole process GROUP so `npx` → `tsx` → `node` all die together — killing only the `npx` pid can leave the
// real runner alive and hung) — a self-contained copy here rather than importing that gate-only helper,
// since this script isn't the eval-gate and shouldn't couple to it.
const TURN_TIMEOUT_MS = 10 * 60_000;
const TURN_MAX_BYTES = 16 * 1024 * 1024;

// F23/F36 residual: `detached: true` (below) makes each spawned child its OWN process-group leader — which
// is exactly why `killGroup` can `process.kill(-pid, ...)` to take `npx`→`tsx`→`node` down together on a
// timeout/byte-cap. The SAME detachment means a SIGINT/SIGTERM delivered to THIS process (an operator's
// Ctrl-C) does NOT propagate to an already-running child's group — an interrupted capture leaks a running
// container run for up to TURN_TIMEOUT_MS. Track every outstanding child's pid (its own group id) so an
// entry-path signal handler can kill them all before this process actually exits. Exported for a unit test
// of the tracking set itself — reliably simulating a real SIGINT/SIGTERM against a live child in a test
// harness is environment-dependent, so the set's add/remove lifecycle is what's verified directly.
export const outstandingChildPids = new Set<number>();

function killAllOutstandingChildGroups(): void {
  for (const pid of outstandingChildPids) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  outstandingChildPids.clear();
}

let orphanCleanupHandlersInstalled = false;
/** Idempotent (F23/F36 residual): installs the Ctrl-C/SIGTERM cleanup at most once no matter how many times
 *  it's called (a test calling it repeatedly, or a future second entry path) — repeat calls are a no-op.
 *  Exported for the unit test to verify idempotency directly; the real entry path below always calls it. */
export function installOrphanCleanupHandlers(): void {
  if (orphanCleanupHandlersInstalled) return;
  orphanCleanupHandlersInstalled = true;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      killAllOutstandingChildGroups();
      process.exit(1);
    });
  }
}

/** Generic bounded spawn: any `cmd args...`, captured, bounded by a wall-clock TIMEOUT and a BYTE CAP on
 *  stdout+stderr (F36) — both kill the whole process GROUP (the child is `detached`, so e.g. `npx` → `tsx` →
 *  `node` all die together; killing only the top pid can leave the real runner alive and hung) and resolve
 *  with `code: null` plus the relevant typed flag set, rather than hanging or growing memory unboundedly.
 *  Never lets a non-zero exit throw — the caller decides what a failed run means. Exported (and generic over
 *  `cmd`/`args`) so the unit test can drive the REAL timeout/byte-cap kill mechanism against a trivial
 *  `node -e ...` child in milliseconds, instead of only exercising it indirectly through a slow real CLI
 *  spawn or a fake 10-minute hang. */
export function boundedSpawn(cmd: string, args: string[], timeoutMs: number, maxBytes: number): Promise<TurnOutcome> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
    if (child.pid) outstandingChildPids.add(child.pid); // F23/F36 residual: tracked until settled, below
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let truncated = false;
    let settled = false;

    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL"); // fallback: not our own group leader (e.g. already reaped, or non-POSIX)
        } catch {
          /* already gone */
        }
      }
    };
    const finish = (code: number | null) => {
      if (settled) return; // a killed child can still emit a trailing close/error; only the first result counts
      settled = true;
      clearTimeout(timer);
      if (child.pid) outstandingChildPids.delete(child.pid);
      resolvePromise({ stdout, stderr, code, timedOut, truncated });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
      finish(null);
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      stdoutBytes += d.length;
      if (stdoutBytes > maxBytes) {
        truncated = true;
        killGroup();
        finish(null);
        return;
      }
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderrBytes += d.length;
      if (stderrBytes > maxBytes) {
        truncated = true;
        killGroup();
        finish(null);
        return;
      }
      stderr += d.toString();
    });
    child.on("close", (code) => finish(code));
    child.on("error", (e) => {
      stderr += `\n[spawn error] ${String(e)}`;
      finish(null);
    });
  });
}

/** One `npx tsx src/cli.ts skill ...` spawn — this script's actual use of `boundedSpawn` above. */
function runSkillTurn(args: string[], timeoutMs = TURN_TIMEOUT_MS, maxBytes = TURN_MAX_BYTES): Promise<TurnOutcome> {
  // Self-spawn the INSTALLED cli next to this module rather than `npx tsx src/cli.ts` from cwd: the old
  // form only worked from a repo checkout (src/ is not published, and the path resolved against cwd), so
  // from an npm install the task turn failed while the always-exit-0 contract made it look like success.
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url).href.replace("/critique/cli.js", "/cli.js"));
  return boundedSpawn(process.execPath, [cli, ...args], timeoutMs, maxBytes);
}

interface SkillEnvelope {
  ok?: boolean;
  error?: { category?: string; message?: string } | null;
  results?: Array<{
    outDir?: string;
    finalMessage?: string;
    result?: "success" | "error";
    resultSubtype?: string;
    /** 1-based turn number within a `--session-id`+`--resume` session (see src/types.ts's `RunResult.turn`).
     *  1 for a fresh/single-shot run; >1 only for a genuine resume. F37 uses this as the mechanical proof
     *  that the reflection turn actually continued the SAME session rather than silently starting fresh. */
    turn?: number;
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

/** F37: the reflection turn (turn 2) validated at the PROTOCOL level, before its `finalMessage` is trusted
 *  as a self-report and before any evidence is packaged / handed to the evaluator. Distinct from the TASK
 *  turn's own success/error, which is a GRADEABLE outcome (a legitimate input to the critique, not an infra
 *  problem) — the reflection turn has no "task" to grade, so anything short of a clean protocol turn here
 *  (nonzero exit, no parseable envelope, `ok !== true`, or a `turn` that doesn't actually show a resume) is
 *  an infrastructure/protocol failure, never a "the agent had nothing to say" self-report.
 *
 *  F37 residual: `turn > 1` alone is NOT proof this resumed the RIGHT session — a resume that (via some bug
 *  or stale on-disk state) silently picked up a DIFFERENT, unrelated session would also show `turn > 1`,
 *  and everything downstream (evidence packaging, the critique) would then be built from the wrong run
 *  entirely. `execute.ts` computes a run's `outDir` as `join(runsWriteRoot(), slug(scenario), sessionId)` —
 *  the session id IS the outDir's own last path segment — so an EXACT `outDir` match against the task
 *  turn's own `outDir` (`expectedOutDir`) is a mechanical, available proof of session continuity that needs
 *  no new field: same `outDir` can only happen if it's the same session directory. The session id is also
 *  checked independently via that same `outDir`'s basename against `expectedSessionId`, for defense in
 *  depth (redundant when the outDir check already passed, but cheap and catches the two checks disagreeing
 *  under any future change to how `outDir` is derived). Exported for the unit test. */
export function validateReflectionTurn(
  turn: TurnOutcome,
  expectedSessionId: string,
  expectedOutDir: string,
): { ok: true; envelope: SkillEnvelope } | { ok: false; reason: string } {
  if (turn.timedOut) return { ok: false, reason: "reflection turn timed out and was killed before it could complete" };
  if (turn.truncated) return { ok: false, reason: "reflection turn's output exceeded the byte cap and was killed" };
  if (turn.code !== 0) return { ok: false, reason: `reflection turn exited with code ${turn.code ?? "null"} (expected 0)` };
  const env = parseEnvelope(turn.stdout);
  if (!env) return { ok: false, reason: "reflection turn produced no parseable --output-format json envelope on stdout" };
  if (env.ok !== true) {
    const msg = env.error && typeof env.error === "object" && typeof env.error.message === "string" ? `: ${env.error.message}` : "";
    return { ok: false, reason: `reflection turn envelope reported ok:${String(env.ok)}${msg}` };
  }
  const r0 = env.results?.[0];
  if (!r0) return { ok: false, reason: "reflection turn envelope has no results[0]" };
  if (typeof r0.turn !== "number" || r0.turn <= 1)
    return {
      ok: false,
      reason: `reflection turn's result.turn is ${r0.turn ?? "missing"} (expected >1 — a genuine resume of session ${expectedSessionId}, not a fresh session)`,
    };
  if (typeof r0.outDir !== "string" || !r0.outDir)
    return { ok: false, reason: "reflection turn envelope's results[0] has no outDir (cannot verify session/outDir continuity)" };
  if (r0.outDir !== expectedOutDir)
    return {
      ok: false,
      reason:
        `reflection turn's outDir (${r0.outDir}) does not match the task turn's outDir (${expectedOutDir}) — ` +
        `this shows turn>1 but looks like a resume of a DIFFERENT session, not session ${expectedSessionId}`,
    };
  // A session-pinned run dir is named `sess-<id>` (execute.ts's `local_<hrtime> | sess-<id>` convention),
  // so the basename carries a prefix the caller's `--session-id` value does not. Accept EITHER form
  // rather than stripping: a blind strip would corrupt a session id that itself begins with "sess-".
  // Without this, every reflection turn read as a resume of a DIFFERENT session and the evaluator was
  // never invoked — a live smoke of `cowork-harness critique` failed on exactly that.
  const reflectedSessionId = basename(r0.outDir);
  if (reflectedSessionId !== expectedSessionId && reflectedSessionId !== `sess-${expectedSessionId}`)
    return {
      ok: false,
      reason: `reflection turn's outDir implies session id "${reflectedSessionId}", expected "${expectedSessionId}"`,
    };
  return { ok: true, envelope: env };
}

/** F37 (part 2): a byte-capped or timed-out TASK turn produced an incomplete/unreliable run — even when an
 *  `outDir` was extractable (e.g. via the `[status]` stderr line written before the kill), the task's own
 *  `result`/`finalMessage` must not be trusted as a legitimate gradeable outcome, and the reflection turn
 *  must never even be attempted against a task that was killed mid-run. Returns the infra-failure reason, or
 *  `undefined` for a task turn that completed (cleanly OR with a genuine `result:"error"` — that remains a
 *  gradeable outcome, not an infra failure). `main()` itself spawns real processes and isn't directly
 *  testable, so this decision is factored out and exported for the unit test. */
export function taskTurnInfraFailure(task: TurnOutcome): string | undefined {
  if (task.timedOut) return "task turn timed out and was killed before it could complete";
  if (task.truncated) return "task turn's output exceeded the byte cap and was killed";
  return undefined;
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

/** F38: whether a self-report was ever captured — a typed marker (not just "selfReport is undefined") so
 *  BOTH output formats can say explicitly "pass 2 was skipped, this is pass-1-only" rather than leaving a
 *  reader to infer it from an empty-looking findings list. */
type SelfReportStatus = "captured" | "unavailable";

interface ReportState {
  skillFolder: string;
  prompt: string;
  sessionId: string;
  outDir: string;
  taskResult: "success" | "error" | undefined;
  selfReportStatus: SelfReportStatus;
  items: CritiqueItem[];
  /** F35: the TRANSPORT-RESOLVED evaluator model, present only when the evaluator actually completed and
   *  every pass that ran agreed on it. Never the requested alias/default. */
  evaluatorModel?: string;
  /** The requested model (opts.evaluatorModel ?? DEFAULT_EVALUATOR_MODEL) — shown ONLY as unresolved
   *  debugging context when the evaluator never completed (infra failure or evaluator error), clearly
   *  labeled as such; never presented as if it were the resolved provenance value. */
  requestedModel: string;
  evaluatorError?: string;
  /** F37: the reflection turn failed at the protocol level (nonzero exit, unparseable/`ok:false` envelope,
   *  or broken session/turn continuity) — the evaluator was never invoked at all, distinct from a gradeable
   *  task failure or an evaluator-side parse error. */
  infraFailure?: string;
  /** F28/F30 (thread-through, D): `packageEvidence`'s `turn1ResultDegraded` — true when the canonical
   *  turn-1 result was corrupted, or (on a validated resume) its archive was simply never written. `undefined`
   *  when packaging never ran (an infra failure short-circuited before it). */
  turn1ResultDegraded?: boolean;
  /** F29 (thread-through, D): `packageEvidence`'s `turn1SliceDegraded` — true when the turn-1 transcript's
   *  `events.jsonl`-slice fallback could not be trusted (boundary never established, or the append-only
   *  prefix it depends on changed/truncated under it). */
  turn1SliceDegraded?: boolean;
  /** F31 (thread-through, D): `packageEvidence`'s `skillMdStatus` — readability of the packaged SKILL.md
   *  source; a non-`"readable"` value means presence/coverage classification was refused (see
   *  `runCritique`'s `skillMdUnreadable` option). */
  skillMdStatus?: SkillMdStatus;
}

/** Pure report-text builder (no I/O) so it's directly unit-testable. `printTextReport` below just flushes
 *  this to fd 1. */
export function buildTextReport(state: ReportState): string {
  const {
    skillFolder,
    prompt,
    sessionId,
    outDir,
    taskResult,
    selfReportStatus,
    items,
    evaluatorModel,
    requestedModel,
    evaluatorError,
    infraFailure,
    turn1ResultDegraded,
    turn1SliceDegraded,
    skillMdStatus,
  } = state;
  const out: string[] = [];
  out.push(`skill-critique: ${skillFolder}`);
  out.push(`  probe: ${prompt}`);
  out.push(`  session: ${sessionId}`);
  out.push(`  run dir: ${outDir}`);
  out.push(`  task run result: ${taskResult ?? "unknown (envelope unavailable)"}`);
  if (evaluatorModel) out.push(`  evaluator model (resolved): ${evaluatorModel}`);
  else if (infraFailure || evaluatorError)
    out.push(`  evaluator model (requested, NOT resolved — evaluator did not complete): ${requestedModel}`);
  if (taskResult === "error")
    out.push(`  NOTE: the task run ended in error — recommendations below reflect whatever happened before the failure.`);
  out.push(`  self-report: ${selfReportStatus}`);
  if (selfReportStatus === "unavailable")
    out.push(
      `  NOTE: no self-report was captured — pass 2 (self-report verification) was skipped; findings below are pass 1 (independent) only.`,
    );
  // F28/F30/F31 (D): the typed degradation flags packageEvidence produces, surfaced as machine-readable
  // report state — not just the inline "[DEGRADED: ...]" prose already embedded in the evidence package.
  if (turn1ResultDegraded)
    out.push(
      `  turn-1 result: DEGRADED (corrupted, or a validated resume's result.turn-1.json archive was never written — see the evidence package)`,
    );
  if (turn1SliceDegraded)
    out.push(
      `  turn-1 transcript slice: DEGRADED (boundary never established, or the append-only prefix it depends on changed/truncated under it)`,
    );
  if (skillMdStatus && skillMdStatus !== "readable")
    out.push(`  SKILL.md: ${skillMdStatus} — coverage claims were downgraded to "not adjudicable" because SKILL.md could not be read`);
  out.push("");

  if (infraFailure) {
    out.push(`INFRASTRUCTURE/PROTOCOL FAILURE (reflection turn): ${infraFailure}`);
    out.push(`The evaluator was NOT invoked — this is a broken discovery run, not a critique. Re-run, or inspect ${outDir} directly.`);
    return out.join("\n");
  }

  if (evaluatorError) {
    out.push(`EVALUATOR FAILED: ${evaluatorError}`);
    out.push(`No critique items were produced. Re-run, or inspect ${outDir} directly.`);
    return out.join("\n");
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
  return out.join("\n");
}

function printTextReport(state: ReportState): void {
  // writeSync: flush before the hard exit(0) (async stdout truncates a long report on a pipe past ~64KB)
  writeSync(1, buildTextReport(state) + "\n");
}

/** Pure JSON-report builder (no I/O), mirroring `buildTextReport` — directly unit-testable. F38's typed
 *  `selfReportStatus` marker is carried in BOTH output formats (this one and the text report above). */
export function buildJsonReport(state: ReportState): Record<string, unknown> {
  const {
    skillFolder,
    sessionId,
    outDir,
    taskResult,
    selfReportStatus,
    items,
    evaluatorModel,
    evaluatorError,
    infraFailure,
    turn1ResultDegraded,
    turn1SliceDegraded,
    skillMdStatus,
  } = state;
  // F28/F30/F31 (D): threaded into `base` (not appended per-branch) so every return path below — infra
  // failure, evaluator error, or a normal critique — carries the same machine-readable degradation state.
  const base = { skillFolder, sessionId, outDir, taskResult, selfReportStatus, turn1ResultDegraded, turn1SliceDegraded, skillMdStatus };
  if (infraFailure) return { ...base, infraFailure, items: [] };
  if (evaluatorError) return { ...base, evaluatorError, items: [] };
  return { ...base, evaluatorModel, items };
}

async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    writeSync(1, usage() + "\n");
    return;
  }
  let opts: ParsedArgs;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    // Exit taxonomy: FINDINGS never gate (always 0), but a usage error or an infra/protocol failure is
    // not a discovery outcome — exiting 0 there made a broken run look like a clean one.
    process.exit(2);
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
      // F36: surface WHY there's no envelope/status line when it was the bounded spawn itself that gave up.
      const diag = [task.timedOut && "task turn timed out", task.truncated && "task turn output exceeded the byte cap"]
        .filter(Boolean)
        .join("; ");
      process.stderr.write(
        `skill-critique: could not determine the task run's directory (no envelope outDir and no [status] line)${diag ? ` [${diag}]` : ""}.\n` +
          `--- task stdout ---\n${task.stdout}\n--- task stderr (tail) ---\n${task.stderr.slice(-4000)}\n`,
      );
      process.exit(0);
      return;
    }

    // F37 (part 2): a byte-capped or timed-out TASK turn is unreliable EVEN when an outDir was extractable
    // (e.g. via the `[status]` stderr line written before the kill) — its result/finalMessage must not be
    // trusted as a legitimate gradeable outcome, and the reflection turn must never be attempted against a
    // task that was killed mid-run. Reported via the SAME ReportState/infraFailure shape as a broken
    // reflection turn below, rather than silently proceeding to package evidence from a killed run.
    const taskInfra = taskTurnInfraFailure(task);
    if (taskInfra) {
      const state: ReportState = {
        skillFolder: opts.skillFolder,
        prompt: opts.prompt,
        sessionId,
        outDir,
        taskResult: undefined,
        selfReportStatus: "unavailable",
        items: [],
        requestedModel: opts.evaluatorModel ?? DEFAULT_EVALUATOR_MODEL,
        infraFailure: taskInfra,
      };
      if (opts.outputFormat === "json") writeSync(1, JSON.stringify(buildJsonReport(state)) + "\n");
      else printTextReport(state);
      process.exit(0);
      return;
    }
    // NOTE: `taskResult` ("success" | "error") is a GRADEABLE outcome of the task itself — a task that ended
    // in error is still valid input to the critique (the evaluator can reason about what happened before the
    // failure); it is deliberately NOT treated as an infrastructure failure the way a broken reflection is
    // below (F37).
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

    // F37: validate the reflection turn at the PROTOCOL level — exit code, envelope shape, and
    // session/turn continuity (turn>1 AND outDir/sessionId match the task turn's) — BEFORE trusting its
    // `finalMessage` as a self-report or handing anything to the evaluator. A failed reflection (crash, bad
    // envelope, a resume that silently didn't resume, or a resume of the WRONG session) must be reported as
    // an infrastructure/protocol defect, never fall through to "the agent had nothing to say."
    const reflectionValidation = validateReflectionTurn(reflect, sessionId, outDir);

    const requestedModel = opts.evaluatorModel ?? DEFAULT_EVALUATOR_MODEL;
    let items: CritiqueItem[] = [];
    let evaluatorError: string | undefined;
    let infraFailure: string | undefined;
    let evaluatorModel: string | undefined;
    let selfReportStatus: SelfReportStatus = "unavailable";
    let turn1ResultDegraded: boolean | undefined;
    let turn1SliceDegraded: boolean | undefined;
    let skillMdStatus: SkillMdStatus | undefined;

    if (!reflectionValidation.ok) {
      infraFailure = reflectionValidation.reason;
      // Per this tool's contract (a discovery instrument, never a gate) the defect is REPORTED, not thrown —
      // the process still exits 0 at the bottom of main(). The evaluator is deliberately never invoked.
    } else {
      // F38: `selfReport` is `undefined` (never a placeholder string) when the reflection turn produced no
      // finalMessage — `runCritique` skips pass 2 entirely in that case; the typed `selfReportStatus` below
      // is what carries "no self-report" into both output formats.
      const selfReport = extractFinalMessage(reflect);
      selfReportStatus = selfReport !== undefined ? "captured" : "unavailable";

      // 4. Package the TURN-1-ONLY evidence and run the critique. `isResume: true` (F30 residual) — we are
      // only ever here after `validateReflectionTurn` confirmed a genuine, continuity-checked resume, so a
      // missing `result.turn-1.json` archive must be treated as degraded, never silently backfilled from the
      // turn-2 `result.json`.
      const {
        pkg,
        sections,
        truncated,
        turn1ResultDegraded: trd,
        turn1SliceDegraded: tsd,
        skillMdStatus: sms,
      } = packageEvidence(outDir, boundary, opts.skillFolder, true);
      turn1ResultDegraded = trd;
      turn1SliceDegraded = tsd;
      skillMdStatus = sms;
      try {
        items = await runCritique(sections, selfReport, {
          model: requestedModel,
          packageTruncated: truncated,
          // F31: SKILL.md not confirmed readable → refuse presence/coverage classification (both a soft
          // prompt caveat and a mechanical "already-covered" → "not-adjudicable" downgrade inside runCritique).
          skillMdUnreadable: sms !== "readable",
          onResolvedModel: (m) => {
            evaluatorModel = m;
          },
        });
      } catch (e) {
        evaluatorError = (e as Error).message;
      }
    }

    // 5. Report.
    const state: ReportState = {
      skillFolder: opts.skillFolder,
      prompt: opts.prompt,
      sessionId,
      outDir,
      taskResult,
      selfReportStatus,
      items,
      evaluatorModel,
      requestedModel,
      evaluatorError,
      infraFailure,
      turn1ResultDegraded,
      turn1SliceDegraded,
      skillMdStatus,
    };
    if (opts.outputFormat === "json") {
      // writeSync: a long JSON report piped to `jq` truncates past the ~64KB buffer with async write + exit(0)
      writeSync(1, JSON.stringify(buildJsonReport(state)) + "\n");
    } else {
      printTextReport(state);
    }
  } catch (e) {
    process.stderr.write(`skill-critique: unexpected failure: ${(e as Error).stack ?? String(e)}\n`);
  }
  process.exit(0); // ALWAYS 0 — this is a discovery instrument, never a gate; the caller owns this exit code
}

/** CLI entry for `cowork-harness critique`. Exported so src/cli.ts can dispatch to it — the direct-exec
 *  guard below stays for `tsx src/critique/command.ts` during development. */
export async function cmdCritique(argv: string[]): Promise<void> {
  installOrphanCleanupHandlers(); // a Ctrl-C must kill any outstanding bounded-spawn child group
  await main(argv);
}

import { pathToFileURL } from "node:url";
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  installOrphanCleanupHandlers();
  void main();
}

// Exported for the reflection-prompt version to be inspectable/testable without spawning anything.
export { REFLECTION_PROMPT, REFLECTION_PROMPT_VERSION, parseArgs };
