// The reflective skill-critique loop's command: task run -> resume for a self-report -> evaluate the
// self-report against turn-1-only evidence -> print a triaged, human-adjudicated report.
//
//   cowork-harness critique <skill-folder> --prompt "<probe>" [--dotenv <path>]
//                                 [--fidelity container] [--evaluator-model <id>] [--output-format json|text]
//
// This is a DISCOVERY instrument, not a gate: it never fails CI and it never edits the skill. FINDINGS never gate — any classification exits 0, including when the graded task
// run itself errored (that is a finding about the skill). Exit 2 means NO CRITIQUE WAS PRODUCED: a usage
// error, or an instrument failure (turn killed, reflection protocol broke, evaluator never invoked or threw) .
// Container tier only: the resume-continuity behavior this loop depends on (the reflection turn seeing the
// SAME mounted skill + session as the task turn) is verified for the container fidelity tier specifically,
// so the tier is pinned rather than left to the caller. That pin is `unverified`, NOT `structural` — see
// ./limitations.ts, which records what would lift it (a live proof at hostloop against its NATIVE agent
// binary, which the container ELF's proof does not cover). A consumer read this pin as permanent and built
// a second test lane around it; the provenance tags exist so that misreading is not available.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { lookupSkillFlag } from "../run/skill-flag-surface.js";
import { gradedAliasPath, turnArtifactPath } from "../run/turn-layout.js";
import { renderKnownLimitations } from "./limitations.js";
import { existsSync, readFileSync, copyFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { basename, join } from "node:path";
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
  /** argv fragments for BOTH spawned turns — session SOURCES, which must match or the resume throws. */
  forwardBoth: string[];
  /** argv fragments for the GRADED turn only. */
  forwardTask: string[];
  /** Parsed from a forwarded --timeout so critique's own spawn kill-switch can stretch past it. */
  taskTimeoutMs?: number;
}

function usage(): string {
  return `cowork-harness critique <skill-folder> --prompt "<probe>" | --prompt-file <path>

  EXPERIMENTAL. Runs the skill, asks the agent what confused it, then does NOT believe the answer:
  a blinded evaluator grades the self-report against a frozen record of what actually happened, and
  drops any claim whose citation is not verbatim in that evidence. Discovery instrument, not a gate.

Probe (one required):
  --prompt "<probe>"        the task to run the skill against
  --prompt-file <path>      read the probe verbatim from a file (no shell parsing)

Files and sources (forwarded to the graded run — REQUIRED for "analyze this document" skills):
  --upload <path>           mount a file at mnt/uploads/<name> (repeatable)
  --folder <dir>            connect a folder at mnt/<name> (repeatable)
  --plugin <dir> | --marketplace <dir> --enable <name@mkt>   extra skill sources

Graded-run tuning (shapes the run being graded):
  --model <id>              session model for the agent doing the work AND reflecting
  --timeout <ms>            wall-clock budget for the task turn
  --label <tag>             generation tag in the run index (pair critiques across fixes)
  --allow-missing-capability   don't fail EITHER turn on a lean-image capability gap (both turns)
  --answer "<q-regex>=<choice>" | --answer-policy <yaml>   pre-answer the skill's gates (repeatable)
  --on-unanswered fail|first   unscripted-gate policy ('prompt' is refused: no TTY inside the spawn)
  --decider-llm [--intent "<line>"] [--decider-model <id>] | --decider-cmd '<helper>' | --decider-dir <dir>
                            answer LIVE gates in the graded run (see 'skill --help')

Critique's own:
  --evaluator-model <id>    the grading model (env: COWORK_HARNESS_EVALUATOR_MODEL)
  --output-format json|text critique's REPORT format (inner turns always speak json internally)
  --fidelity container      container tier only
  --keep                    accepted as a no-op — runs are always kept
  --dotenv <path>           credentials
  Global --run-dir <path>   must PRECEDE the subcommand

Not accepted (each errors with its reason rather than being silently ignored):
  --session-id / --resume   critique mints and manages its own session internally
  --repeat + companions     fixed two-turn protocol — loop critique itself; pair by fingerprint.skillHash
  --ablate-skill            grading a skill you removed is incoherent
  --quiet/--verbose/--compact/--demo/--dry-run   inner-turn rendering or preview — no effect on the report

Repeating a flag: --upload/--folder/--plugin/--marketplace/--enable/--answer accumulate (that is how you
  pass several). Every other value-taking flag is single-valued and repeating it is a USAGE ERROR rather
  than a silent last-wins — '--prompt a --prompt b' would otherwise discard a probe you typed. Boolean
  flags may be repeated harmlessly.

COST AND PREREQUISITES — read before running:
  * Each critique is FOUR model workloads: two container runs (task + reflection) and two evaluator
    passes over an evidence package of up to 48KB.
  * The evaluator defaults to ${DEFAULT_EVALUATOR_MODEL} — the most expensive tier. Override it if
    that is not what you want.
  * Requires the container tier (Docker/Lima) and an authenticated \`claude\` CLI on PATH.

EXIT CODES: 0 = the critique ran (ANY findings, including a task run that itself errored — that is a
  finding about the skill, not a broken instrument). 2 = usage error, or an instrument failure (turn
  killed, reflection protocol broke, evaluator never invoked or threw) — no critique was produced. Findings
  NEVER gate.

${renderKnownLimitations()}

  On a third-party skill, note that fencing separates the instruction plane from evidence but cannot
  stop hostile content that merely ARGUES — see docs/critique.md.`;
}

/** Reads a value-flag that may appear as EITHER `--flag value` (space form) OR `--flag=value` (equals
 *  form). critique's argv parsing runs in a separate process from cli.ts's `flagValue`/`flagValueEitherForm`
 *  helpers (a process-boundary-separated CLI — see the plan's Option (c) rejection), so it gets its own
 *  small copy rather than importing those private helpers. Returns `[value, extraTokensConsumed]` — 0 for
 *  the equals form (the value is inline in `a`), 1 for the space form (the value is the NEXT token) — so
 *  the caller's `i += extraTokensConsumed` advances the loop exactly like the old `argv[++i]` did. */
/** Returns [value, indexAdvance] and whether the EQUALS form was used (the child's escape hatch for a
 *  value starting with `-`, which its spaced-form parser rejects).
 *
 *  The empty/missing check lives HERE, not at the call sites: it was previously applied only in the
 *  spec-forwarding branch, so `critique … --dotenv` with a forgotten path was ACCEPTED and ran a full
 *  four-workload critique without loading env — a silent no-op on the flag this branch made reachable. */
function flagVal(argv: string[], i: number, flag: string): { value: string; adv: number; equalsForm: boolean } {
  const a = argv[i]!;
  if (a.startsWith(`${flag}=`)) {
    const value = a.slice(flag.length + 1);
    if (value.trim() === "") throw new Error(`${flag} requires a non-empty value\n${usage()}`);
    return { value, adv: 0, equalsForm: true };
  }
  const value = argv[i + 1];
  // trim(), matching the child's own value checks — otherwise `--label " "` passes here and dies
  // one layer later, which is the failure shape this check exists to prevent.
  if (value === undefined || value.trim() === "") throw new Error(`${flag} requires a value\n${usage()}`);
  return { value, adv: 1, equalsForm: false };
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  let prompt: string | undefined;
  let dotenv: string | undefined;
  let fidelity = "container";
  let evaluatorModel: string | undefined;
  let outputFormat: "json" | "text" = "text";
  let promptFile: string | undefined;
  let taskTimeoutMs: number | undefined;
  const forwardBoth: string[] = [];
  const forwardTask: string[] = [];
  const seen = new Set<string>();
  /** A repeat of a non-repeatable flag silently discards the earlier value — the exact no-op this
   *  command's refusal design exists to prevent. Applied to critique's OWN flags too: an earlier version
   *  guarded only the forwarded branch, so `--prompt a --prompt b` quietly dropped a probe the user typed.
   *  Arity-0 flags are exempt: there is no value to lose, and the child accepts them idempotently. */
  const once = (flag: string, arity: 0 | 1 = 1) => {
    if (arity === 0) return;
    if (seen.has(flag)) throw new Error(`${flag} given more than once (it is not repeatable)\n${usage()}`);
    seen.add(flag);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--prompt" || a.startsWith("--prompt=")) {
      once("--prompt");
      const { value: v, adv } = flagVal(argv, i, "--prompt");
      prompt = v;
      i += adv;
    } else if (a === "--dotenv" || a.startsWith("--dotenv=")) {
      once("--dotenv");
      const { value: v, adv } = flagVal(argv, i, "--dotenv");
      dotenv = v;
      i += adv;
    } else if (a === "--fidelity" || a.startsWith("--fidelity=")) {
      once("--fidelity");
      const { value: v, adv } = flagVal(argv, i, "--fidelity");
      fidelity = v;
      i += adv;
    } else if (a === "--evaluator-model" || a.startsWith("--evaluator-model=")) {
      once("--evaluator-model");
      const { value: v, adv } = flagVal(argv, i, "--evaluator-model");
      evaluatorModel = v;
      i += adv;
    } else if (a === "--output-format" || a.startsWith("--output-format=")) {
      once("--output-format");
      const { value: v, adv } = flagVal(argv, i, "--output-format");
      outputFormat = v as "json" | "text";
      i += adv;
    } else if (a === "--prompt-file" || a.startsWith("--prompt-file=")) {
      once("--prompt-file");
      const { value: v, adv } = flagVal(argv, i, "--prompt-file");
      promptFile = v;
      i += adv;
    } else if (a === "--keep" || a.startsWith("--keep=")) {
      // Match the equals form too so it errors as "takes no value" rather than falling through to the
      // owned-flag branch's "unknown flag: --keep=x", which misdescribes the mistake.
      if (a.includes("=")) throw new Error(`--keep takes no value (got "${a}")\n${usage()}`);
      // accepted no-op: critique always keeps its runs, so the flag's promise already holds. Erroring on
      // an already-satisfied request is hostile; silently ignoring an UNsatisfied one is this repo's
      // anti-pattern — this is the former.
    } else if (a.startsWith("-")) {
      // Not critique-owned: consult THE shared spec rather than a hand-mirrored list here. A skill flag
      // with no disposition is impossible — the parity test makes that red CI.
      const name = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
      const spec = lookupSkillFlag(name);
      if (!spec) throw new Error(`unknown flag: ${a}\n${usage()}`);
      // `repeatable` is enforced, not decorative — see `once()`.
      if (!spec.repeatable) once(name, spec.arity);
      if (spec.critique.kind === "reject") throw new Error(`${name} is not accepted by critique: ${spec.critique.reason}\n${usage()}`);
      if (spec.critique.kind === "owned") throw new Error(`unknown flag: ${a}\n${usage()}`); // owned => handled above
      let value: string | undefined;
      let eq = false;
      if (spec.arity === 1) {
        const { value: v, adv, equalsForm } = flagVal(argv, i, name);
        eq = equalsForm;
        value = v;
        i += adv;
      } else if (a.includes("=")) {
        // The child rejects `--boolean=x` outright ("takes no value"). Accepting it here and forwarding a
        // BARE flag would silently invert intent — `--allow-missing-capability=false` would enable it.
        throw new Error(`${name} takes no value (got "${a}")\n${usage()}`);
      }
      // --on-unanswered prompt would resolve differently than the caller expects: there is no TTY inside
      // the spawn, so it cannot actually prompt anyone.
      if (name === "--on-unanswered" && value !== "fail" && value !== "first")
        throw new Error(
          `--on-unanswered must be "fail" or "first" for critique (got "${value}") — there is no TTY inside the spawned turn\n${usage()}`,
        );
      if (name === "--timeout") {
        const n = Number(value);
        if (!Number.isInteger(n) || n <= 0) throw new Error(`--timeout requires a positive integer (ms), got "${value}"`);
        taskTimeoutMs = n;
      }
      // Preserve the EQUALS form when that is how it arrived: the child's spaced-form parser rejects a
      // value starting with `-`, so normalising `--intent=-terse` to two argv entries would kill a valid
      // input one layer later with a wrong diagnosis.
      const fragment = spec.arity === 1 ? (eq ? [`${name}=${value!}`] : [name, value!]) : [name];
      // EXCLUSIVE buckets. `buildTaskTurnArgs` spreads BOTH arrays, so a "both" flag pushed into both
      // would be emitted TWICE on the task turn — which is not a no-op for repeatable flags like
      // --upload (it mounts the file twice). Sources go to forwardBoth ONLY; the task builder picks
      // them up from there.
      if (spec.critique.turns === "both") forwardBoth.push(...fragment);
      else forwardTask.push(...fragment);
    } else positional.push(a);
  }
  if (positional.length !== 1) throw new Error(usage());
  if (prompt !== undefined && promptFile !== undefined) throw new Error(`--prompt and --prompt-file are mutually exclusive\n${usage()}`);
  if (promptFile !== undefined) {
    if (!existsSync(promptFile)) throw new Error(`--prompt-file not found: ${promptFile}`);
    prompt = readFileSync(promptFile, "utf8");
  }
  if (!prompt || !prompt.trim()) throw new Error(`--prompt "<probe>" or --prompt-file <path> is required\n${usage()}`);
  if (fidelity !== "container")
    throw new Error(
      `skill-critique is container-tier only (the resume-continuity behavior it relies on is only verified there); got --fidelity ${fidelity}`,
    );
  if (outputFormat !== "json" && outputFormat !== "text")
    throw new Error(`--output-format must be "text" or "json" (got "${outputFormat}")`);
  // Fail fast with critique's OWN clear error (mirroring cli.ts's global --dotenv existence check,
  // ~line 627) rather than letting an absent file surface later as a generic instrument-failure
  // diagnostic from the child `skill` invocation's own (differently-worded) rejection.
  if (dotenv !== undefined && !existsSync(dotenv)) throw new Error(`--dotenv file not found: ${dotenv}\n${usage()}`);
  return { skillFolder: positional[0], prompt, dotenv, fidelity, evaluatorModel, outputFormat, forwardBoth, forwardTask, taskTimeoutMs };
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
  // Resolve the sibling CLI relative to THIS module — `../cli.js` from src/critique/ or dist/critique/.
  // (A string .replace() on the href was fragile: first-occurrence, and it mangles any install path that
  // happens to contain "/critique/cli.js".)
  const self = fileURLToPath(new URL("../cli.js", import.meta.url));
  // Under tsx, import.meta.url is the .ts SOURCE, so the sibling is src/cli.ts and no built cli.js exists
  // — spawn the source through the same loader instead of a nonexistent .js.
  return existsSync(self)
    ? boundedSpawn(process.execPath, [self, ...args], timeoutMs, maxBytes)
    : boundedSpawn("npx", ["tsx", fileURLToPath(new URL("../cli.ts", import.meta.url)), ...args], timeoutMs, maxBytes);
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
    /** Surfaced in the report so a harvester never has to open a turn file. See `gradedOutcome`. */
    outcome?: string;
    fingerprint?: { skillHash?: string; skillCommit?: string | null };
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
  /** The GRADED (task) turn's `outcome` and `skillHash`, lifted into the report so a consumer never opens
   *  a turn file to get them.
   *
   *  WHY THIS EXISTS. critique runs two turns into ONE outDir. After the resume, `result.json` is the
   *  REFLECTION turn's; the graded turn is archived as `result.turn-1.json`. So the correct file to read
   *  is the LOWER-numbered one — the opposite of every other multi-run convention — and a harvester that
   *  reads `result.json` silently ingests the reflection turn's outcome: a valid-looking wrong number with
   *  nothing to signal it. Documenting that only helps someone who already knows to look, in a tool whose
   *  whole purpose is killing silent wrong answers. Surfacing it here removes the need to know. */
  gradedOutcome?: string;
  gradedSkillHash?: string;
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
  /** Mechanical integrity signal from the evaluator's trusted canary — false means that pass stopped
   *  following trusted instructions, so an empty critique may be adversarial silencing, not a clean skill. */
  evaluatorIntegrity?: { pass1Canary: boolean; pass2Canary?: boolean };
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
    gradedOutcome,
    gradedSkillHash,
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
  // The GRADED turn's facts, so a consumer never opens result.turn-1.json (and never mistakes the
  // reflection turn's result.json for them).
  if (gradedOutcome) out.push(`  graded outcome: ${gradedOutcome}`);
  if (gradedSkillHash) out.push(`  graded skillHash: ${gradedSkillHash.slice(0, 12)}`);
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

  const integ = state.evaluatorIntegrity;
  if (integ && (integ.pass1Canary === false || integ.pass2Canary === false)) {
    const missing = [integ.pass1Canary === false ? "pass 1" : null, integ.pass2Canary === false ? "pass 2" : null].filter(Boolean);
    const which = missing.join(" and ");
    out.push(
      `  evaluator integrity: CANARY MISSING (${which}) — the evaluator ignored a trusted instruction. ` +
        `An empty or short critique in this state may be adversarial silencing by the skill under review, NOT a clean skill.`,
    );
  }
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
    prompt,
    evaluatorIntegrity,
    sessionId,
    outDir,
    taskResult,
    gradedOutcome,
    gradedSkillHash,
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
  // evaluatorIntegrity rides on EVERY branch: a silenced pass is exactly the case where the other fields
  // look clean, so omitting it from the infra/error branches would hide it when it matters most.
  const base = {
    skillFolder,
    prompt,
    sessionId,
    outDir,
    taskResult,
    // On `base`, not a branch: a harvester reads these on EVERY outcome, including the infra-failure
    // paths where knowing which skill generation was graded matters most.
    gradedOutcome,
    gradedSkillHash,
    selfReportStatus,
    evaluatorIntegrity,
    turn1ResultDegraded,
    turn1SliceDegraded,
    skillMdStatus,
  };
  if (infraFailure) return { ...base, infraFailure, items: [] };
  if (evaluatorError) return { ...base, evaluatorError, items: [] };
  return { ...base, evaluatorModel, items };
}

/** Instrument failure: the critique could not be produced (turn killed, protocol break, evaluator never
 *  invoked, unexpected throw). Distinct from FINDINGS, which never gate. Matches SPEC's exit 2
 *  (usage/runtime) rather than inventing a new code. */
const EXIT_INSTRUMENT_FAILURE = 2;

/** Argv for the GRADED turn. Forwarded fragments come BEFORE critique's pinned flags so a pinned value
 *  always wins (value flags are last-wins in the skill lane's parser). Exported for unit tests — the
 *  forwarding invariants are the kind that fail every run when wrong, so they are worth testing without
 *  paying for a spawn. */
/** Role-stable copies of the GRADED turn's artifacts, taken while `result.json`/`trace.json` are STILL
 *  turn 1's — before the reflection turn's resume renames the result and overwrites the trace.
 *
 *  Why `*.graded.json` and not the `*.turn-1.*` archives: an archive name only exists once a LATER turn
 *  has run, so it depends on the future. These names are true the moment they are written and survive a
 *  reflection turn that never completes.
 *
 *  Extracted so it can be tested BEHAVIORALLY. The first version of this lived inline and was "guarded"
 *  by source-text greps, which passed 6/6 against a tree where the copy could never produce a file.
 *
 *  Best-effort by design: a missing or unreadable source must never fail a critique that otherwise ran. */
export function writeGradedAliases(outDir: string): void {
  for (const artifact of ["result.json", "trace.json"] as const) {
    try {
      // The graded turn's files live in `turns/1/` — there is no root compat copy of either artifact
      // anymore. Resolving through the seam keeps this correct regardless: this copy swallows its errors,
      // so a stale root reference here would have silently stopped producing `result.graded.json`/
      // `trace.graded.json` for the one active consumer, rather than failing loud.
      const src = turnArtifactPath(outDir, 1, artifact);
      if (existsSync(src)) copyFileSync(src, gradedAliasPath(outDir, artifact));
    } catch {
      /* best-effort convenience copy — never fail the run for it */
    }
  }
}

export function buildTaskTurnArgs(opts: ParsedArgs, sessionId: string): string[] {
  const dotenvArgs = opts.dotenv ? ["--dotenv", opts.dotenv] : [];
  return [
    ...dotenvArgs,
    "skill",
    opts.skillFolder,
    opts.prompt,
    ...opts.forwardBoth,
    ...opts.forwardTask,
    "--fidelity",
    "container",
    "--session-id",
    sessionId,
    "--keep",
    "--output-format",
    "json",
  ];
}

/** Argv for the REFLECTION turn — a resume of the same session.
 *
 *  Only `forwardBoth` is replayed here, and it MUST be: session sources are part of the origin key, so a
 *  reflection turn that omits them computes a different identity and the resume throws fail-closed.
 *  `forwardTask` is deliberately absent — `--decider-dir` in particular requires a fresh empty dir per run
 *  and would break on turn 2, and gates belong to the graded run, not to critique's own protocol turn. */
export function buildReflectionTurnArgs(opts: ParsedArgs, sessionId: string): string[] {
  const dotenvArgs = opts.dotenv ? ["--dotenv", opts.dotenv] : [];
  return [
    ...dotenvArgs,
    "skill",
    opts.skillFolder,
    REFLECTION_PROMPT,
    ...opts.forwardBoth,
    "--session-id",
    sessionId,
    "--resume",
    "--fidelity",
    "container",
    "--on-unanswered",
    "first",
    "--output-format",
    "json",
  ];
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

  const sessionId = `crit-${randomUUID()}`;

  try {
    // 1. Task turn.
    // Stretch critique's own kill-switch past a forwarded --timeout: otherwise a longer budget would be
    // killed by the INSTRUMENT and misreported as an infra failure rather than a gradeable timeout. The
    // +60s covers staging and container start — not principled, and a cold image pull can exceed it.
    const task = await runSkillTurn(
      buildTaskTurnArgs(opts, sessionId),
      opts.taskTimeoutMs ? Math.max(TURN_TIMEOUT_MS, opts.taskTimeoutMs + 60_000) : TURN_TIMEOUT_MS,
    );
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
      process.exit(EXIT_INSTRUMENT_FAILURE);
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
      // The INSTRUMENT failed at the TASK turn (killed by the timeout or the byte cap) — no critique was
      // produced. Findings never gate, but this is not a finding. The other instrument causes exit
      // elsewhere: a reflection-protocol break or an evaluator throw routes through the report path below.
      process.exit(EXIT_INSTRUMENT_FAILURE);
      return;
    }
    // NOTE: `taskResult` ("success" | "error") is a GRADEABLE outcome of the task itself — a task that ended
    // in error is still valid input to the critique (the evaluator can reason about what happened before the
    // failure); it is deliberately NOT treated as an infrastructure failure the way a broken reflection is
    // below (F37).
    const taskResult = extractResult(task);
    const taskRow = parseEnvelope(task.stdout)?.results?.[0];
    const gradedOutcome = taskRow?.outcome;
    const gradedSkillHash = taskRow?.fingerprint?.skillHash;

    // Stable-named copy of the GRADED turn's result, written HERE — while `result.json` is still turn 1
    // and before the reflection turn's resume renames it to `result.turn-1.json`. Writing it at this point
    // (rather than copying the archived file afterwards) also means it survives a reflection turn that
    // never completes. Best-effort: a missing/unreadable result must never fail a critique that otherwise
    // ran, so this is deliberately swallowed.
    writeGradedAliases(outDir);

    // 2. Snapshot the turn-1/turn-2 boundary BEFORE the reflection turn touches anything.
    const boundary = snapshotTurnBoundary(outDir);

    // 3. Reflection turn: resume the SAME session.
    const reflect = await runSkillTurn(buildReflectionTurnArgs(opts, sessionId));

    // F37: validate the reflection turn at the PROTOCOL level — exit code, envelope shape, and
    // session/turn continuity (turn>1 AND outDir/sessionId match the task turn's) — BEFORE trusting its
    // `finalMessage` as a self-report or handing anything to the evaluator. A failed reflection (crash, bad
    // envelope, a resume that silently didn't resume, or a resume of the WRONG session) must be reported as
    // an infrastructure/protocol defect, never fall through to "the agent had nothing to say."
    const reflectionValidation = validateReflectionTurn(reflect, sessionId, outDir);

    const requestedModel = opts.evaluatorModel ?? DEFAULT_EVALUATOR_MODEL;
    let items: CritiqueItem[] = [];
    let evaluatorIntegrity: { pass1Canary: boolean; pass2Canary?: boolean } | undefined;
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
      // main() then exits 2 (no critique was produced). The evaluator is deliberately never invoked.
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
          onEvaluatorIntegrity: (i) => {
            evaluatorIntegrity = i;
          },
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
      gradedOutcome,
      gradedSkillHash,
      selfReportStatus,
      items,
      evaluatorModel,
      requestedModel,
      evaluatorError,
      infraFailure,
      evaluatorIntegrity,
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
    // A reflection-protocol break or an evaluator failure reaches HERE, not the early returns above —
    // the report is still printed (it carries the diagnosis), but no critique was produced, so this is an
    // instrument failure, not a finding. Missing this path is what made the documented exit contract
    // false in practice even after the other three were routed.
    if (state.infraFailure || state.evaluatorError) process.exit(EXIT_INSTRUMENT_FAILURE);
  } catch (e) {
    process.stderr.write(`skill-critique: unexpected failure: ${(e as Error).stack ?? String(e)}\n`);
    process.exit(EXIT_INSTRUMENT_FAILURE); // an unexpected throw means no critique was produced
  }
  // FINDINGS never gate: any classification — including a task run that ERRORED, which is itself a
  // legitimate discovery outcome about the skill — exits 0. Only instrument failures above exit non-zero.
  process.exit(0);
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
