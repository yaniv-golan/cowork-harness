// The reflective skill-critique loop's command: task run -> resume for a self-report -> evaluate the
// self-report against turn-1-only evidence -> print a triaged, human-adjudicated report.
//
//   cowork-harness critique <skill-folder> --prompt "<probe>" [--dotenv <path>]
//                                 [--fidelity container|hostloop] [--evaluator-model <id>] [--output-format json|text]
//
// This is a DISCOVERY instrument, not a gate: it never fails CI and it never edits the skill. FINDINGS never gate — any classification exits 0, including when the graded task
// run itself errored (that is a finding about the skill). Exit 2 means NO CRITIQUE WAS PRODUCED: a usage
// error, or an instrument failure (turn killed, reflection protocol broke, evaluator never invoked or threw) .
// Container OR hostloop tier: the reflection turn RESUMES the task turn's mounted skill + conversation, and
// that resume-continuity is proven for BOTH — container (Linux ELF) and hostloop (native binary; see
// test/live-contract.test.ts). `--fidelity cowork` is accepted too, but is not a third environment: it
// resolves to one of those two at parse time, once, and both turns get the resolved literal.
// microvm/protocol stay refused (see ./limitations.ts for why each).
// A cross-tier resume is blocked fail-loud by the session-manifest fidelity stamp (src/run/execute.ts),
// and at hostloop a writable connected folder requires --allow-host-writes (forwarded to both turns).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { lookupSkillFlag } from "../run/skill-flag-surface.js";
import { gradedAliasPath, turnArtifactPath } from "../run/turn-layout.js";
import { renderKnownLimitations } from "./limitations.js";
import { observedSkillInvocation, slashCommandSkillInvocation, subagentSkillCalls } from "./skill-invocation.js";
import { tildeify, warn, writeAllSync } from "../io.js";
import { existsSync, readFileSync, copyFileSync, writeFileSync, readdirSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { packageEvidence, MAX_PACKAGE_BYTES } from "./package-evidence.js";
import { appendCritiqueRollupRow, CRITIQUE_SESSION_PREFIX } from "../run/run-index.js";
import { jsonPayloadEnvelope } from "../run/envelope.js";
import { checkMountDelivers } from "./mount-check.js";
import { binaryPluginIdentity } from "../session.js";
import { runsWriteRoot } from "../run/trace-view.js";
import type { SkillMdStatus } from "./package-evidence.js";
import { resolveDispatchableAgents, readPluginName, type ResolvedAgent } from "./resolve-agents.js";
import { findEnclosingPluginDir } from "../run/analyze-skill.js";
import { safePathSegment } from "../staging/resolve.js";
import { snapshotTurnBoundary, readTurn1Result, readTurn1Slice, type TurnBoundary } from "./evidence.js";
import { runCritique, DEFAULT_EVALUATOR_MODEL } from "./evaluator.js";
import { loadBaseline } from "../baseline.js";
import type { PlatformBaseline } from "../types.js";
import { isLiveModelId } from "../types.js";
import { decideLoopFromBaseline } from "../loop-decision.js";
import { parseDotenv } from "../dotenv.js";
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

export interface ParsedArgs {
  skillFolder: string;
  /** The probe. Present on every spending invocation — parseArgs enforces it — and absent ONLY under
   *  `--corpus-only`, where no turn runs and a prompt would be a value with nothing to consume it. */
  prompt?: string;
  /** `--corpus-only`: package the skill corpus over an EMPTY run dir and stop — no session, no spawn, no
   *  spend. The answer to "how close is this skill to the evidence ceiling" BEFORE paying for a critique. */
  corpusOnly: boolean;
  /** Under `--corpus-only`, every flag that was validated but shapes a RUN that will not happen (`--prompt`,
   *  `--upload`, `--model`, …). Carried into the JSON payload as `ignoredFlags` so a machine consumer sees
   *  the no-op — stderr text is not a contract, and silently accepting an unsatisfied flag is this repo's
   *  anti-pattern. Empty when not in corpus-only mode. */
  ignoredFlags: string[];
  dotenv?: string;
  /** The tier BOTH turns run at. Always a concrete tier — `--fidelity cowork` is resolved at parse time,
   *  never forwarded as-is. */
  fidelity: "container" | "hostloop";
  /** What the caller ASKED for, when that differs from what they got — i.e. `"cowork"`, or absent. Kept
   *  separate so the report never claims the user named the tier that ran. */
  requestedFidelity?: "cowork";
  evaluatorModel?: string;
  outputFormat: "json" | "text";
  /** ALSO write the selected-format report to this file (stdout unchanged). */
  out?: string;
  /** For a MULTI-SKILL PLUGIN target: which `skills/<name>` the packager should grade. Selection only —
   *  the positional folder is still what both turns mount (session identity must not change). */
  skillSelector?: string;
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
  --timeout <ms>            wall-clock budget for the task turn (default 30 min)
  --label <tag>             generation tag in the run index (pair critiques across fixes)
  --allow-missing-capability   don't fail EITHER turn on a lean-image capability gap (both turns)
  --answer "<q-regex>=<choice>" | --answer-policy <yaml>   pre-answer the skill's gates (repeatable)
  --on-unanswered fail|first   unscripted-gate policy ('prompt' is refused: no TTY inside the spawn)
  --decider-llm [--intent "<line>"] [--decider-model <id>] | --decider-cmd '<helper>' | --decider-dir <dir>
                            answer LIVE gates in the graded run (see 'skill --help')

Critique's own:
  --evaluator-model <id>    the grading model (env: COWORK_HARNESS_EVALUATOR_MODEL)
  --output-format json|text critique's REPORT format (inner turns always speak json internally)
  --out <path>              ALSO write the selected-format report to this file (stdout unchanged)
  --skill <name>            multi-skill PLUGIN target: grade skills/<name>/SKILL.md (+ every agents/**.md it dispatches,
                            + the plugin-root references/ files it points at)
                            instead of a missing plugin-root SKILL.md. Selection only — the positional
                            folder is still what both turns mount, and fingerprint.skillHash is unchanged
                            (it keys the mounted folder: per-plugin, not per-skill). A multi-skill root
                            with no --skill is REFUSED before any model spend.
                            <plugin>/skills/<name> as the positional IS <plugin> --skill <name>: critique
                            mounts the plugin (as Cowork does) and grades <name>, with a notice. It mounts
                            the skill folder alone only when --skill cannot reach it (not at skills/<name>,
                            a submodule, or a case mismatch), and says why.
  --fidelity <tier>         container (default), hostloop, or cowork — which resolves via the baseline's
                            loop gate to one of the two and pins BOTH turns to it; microvm/protocol refused
  --keep                    accepted as a no-op — runs are always kept
  --corpus-only             NO SPEND: package the skill corpus with the packager a critique uses (same
                            code, same git-tracked filter, same ceiling) over an EMPTY run and print the six
                            corpus fields — corpusBytes / corpusCeiling / corpusCuts / corpusExcluded /
                            corpusPackaged / corpusOmitted — then exit. --prompt becomes optional. The number
                            is a FLOOR: plugin-root references the agent READS during the graded turn are
                            added at critique time, so a paid run's corpusBytes is >= this. Every other flag
                            is still parsed and type-checked as a critique line, but a run-shaping one is not
                            acted on and is named in ignoredFlags — a PATH value (--upload, --folder,
                            --plugin) is only checked when a turn stages, so a missing one does not fail here. Applies staging's git rules: a work
                            tree with 0 tracked files, a --skill subdirectory with nothing tracked under it,
                            or no readable tracked SKILL.md is refused in staging's terms — and a paid
                            critique refuses the same targets before any spend; a non-git folder is measured
                            raw, as staging copies it.
  --dotenv <path>           credentials
  Global --run-dir <path>   must PRECEDE the subcommand

Not accepted (each errors with its reason rather than being silently ignored):
  --session-id / --resume   critique mints and manages its own session internally
  --repeat + companions     fixed two-turn protocol — loop critique itself; pair by fingerprint.skillHash
  --ablate-skill            grading a skill you removed is incoherent
  --quiet/--verbose/--compact/--demo/--dry-run   inner-turn rendering or preview — no effect on the report
                                                 (which already collapses host paths to ~)

Repeating a flag: --upload/--folder/--plugin/--marketplace/--enable/--answer accumulate (that is how you
  pass several). Every other value-taking flag is single-valued and repeating it is a USAGE ERROR rather
  than a silent last-wins — '--prompt a --prompt b' would otherwise discard a probe you typed. Boolean
  flags may be repeated harmlessly.

COST AND PREREQUISITES — read before running:
  * Each critique is FOUR model workloads: two graded runs (task + reflection) at the chosen tier and two
    evaluator passes over an evidence package of up to ${MAX_PACKAGE_BYTES / 1024}KB.
  * The evaluator defaults to ${DEFAULT_EVALUATOR_MODEL} — the most expensive tier. WHICH workload
    dominates depends on the skill: evaluator cost is roughly FIXED (bounded by the evidence package),
    while the graded task turn is UNBOUNDED. On a trivial probe the two evaluator passes are ~3/4 of the
    total; on a real document-analysis run the ratio INVERTS (measured: task turn ~61%, evaluator ~30%).
    Read the per-run split off the cost line / costUsd rather than assuming either — a cheaper
    --evaluator-model buys you at most the evaluator's share, and it voids the armor's
    injection-resistance verification, which covers the DEFAULT evaluator only. When the task turn
    dominates, the levers are --model, --timeout and probe scope.
  * container needs Docker/Lima; hostloop needs Docker (the bash/web_fetch sidecar) PLUS the staged native
    agent binary, and writes to the real host FS (a writable --folder requires --allow-host-writes). Both
    tiers need CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY as a CI fallback) in the env or .env — the
    graded turns self-spawn the installed CLI, which runs the staged agent binary, not the host \`claude\`.
    The two evaluator passes need an authenticated \`claude\` CLI on PATH, overridable via
    COWORK_HARNESS_CLAUDE_BIN.

RUN-DIR ARTIFACTS (written best-effort alongside turns/):
  critique-report.json           the machine-readable report, every outcome
  critique-evidence-package.txt  the ARMORED corpus the evaluator graded against (when it ran)
  critique-salvage.json          on exit 2 only: self-report + each pass's RAW reply, pre-parse

EXIT CODES: 0 = the critique ran (ANY findings, including a task run that itself errored — that is a
  finding about the skill, not a broken instrument). 2 = usage error, or an instrument failure (turn
  killed, reflection protocol broke, evaluator never invoked or threw) — no critique was produced. Findings
  NEVER gate. --corpus-only: 0 = measured (even over the ceiling — it is a measurement, not a gate; gate on
  corpusBytes <= corpusCeiling yourself), 2 = usage error, unresolvable target, or 0 git-tracked files.

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
  // No silent positional-grab (the idiom cli.ts's parser and the CI guard ban): a flag-looking NEXT token
  // in the SPACE form means the value was forgotten — `--prompt --output-format json` would otherwise
  // swallow `--output-format` as the prompt AND drop the real flag, then run a four-workload critique on the
  // wrong input. A value that genuinely starts with `-` must use the equals form (this branch's escape hatch).
  if (value.startsWith("-"))
    throw new Error(
      `${flag} looks like it's missing a value — the next token is the flag "${value}". ` +
        `For a value that intentionally starts with "-", use the equals form: ${flag}=<value>\n${usage()}`,
    );
  return { value, adv: 1, equalsForm: false };
}

/** The effective `CLAUDE_FORCE_HOST_LOOP` a CHILD turn will see: the ambient env if it defines the var,
 *  else whatever `--dotenv` contributes (the child loads that file, and `loadDotenv` lets an existing
 *  env value win — so this mirrors the child's own precedence). Read WITHOUT applying the file: pulling
 *  the whole `.env` into critique's env would also hand it to the evaluator's spawned CLI, a side effect
 *  far outside a tier decision. Unreadable/absent file ⇒ `false`, matching `loadDotenv`'s best-effort
 *  posture; `parseArgs` has already failed loud on a missing path by this point. Exported for unit
 *  tests. */
export function childForcesHostLoop(dotenvPath: string | undefined): boolean {
  if (process.env.CLAUDE_FORCE_HOST_LOOP !== undefined) return process.env.CLAUDE_FORCE_HOST_LOOP === "1";
  if (dotenvPath === undefined) return false;
  try {
    return parseDotenv(readFileSync(dotenvPath, "utf8")).get("CLAUDE_FORCE_HOST_LOOP") === "1";
  } catch {
    return false;
  }
}

/** Resolve `--fidelity cowork` to the tier real Cowork would use, exactly as `executeScenario` does:
 *  the pinned baseline's loop gate, with the same dev override honoured. The child `skill` turns
 *  synthesize their scenario with `baseline: "latest"` and are spawned from this same install with an
 *  inherited env, so resolving here yields the tier the child would have computed for itself.
 *
 *  A baseline that cannot be read is rewrapped: the bare `readFileSync` ENOENT underneath would be a
 *  WORSE diagnostic than the blanket refusal this replaced, which is the one way this change could be a
 *  net regression for the person hitting it.
 *
 *  Exported for unit tests — `parseArgs` takes this as an injectable default, and a suite that only ever
 *  passes a fake would be testing the fake. */
export function resolveCoworkTier(
  dotenvPath: string | undefined,
  load: () => PlatformBaseline = () => loadBaseline("latest"),
): "container" | "hostloop" {
  let baseline: PlatformBaseline;
  try {
    baseline = load();
  } catch (e) {
    throw new Error(
      `--fidelity cowork could not be resolved: no readable platform baseline (${e instanceof Error ? e.message : String(e)}). ` +
        `cowork means "whichever tier real Cowork would use here", which is read from the baseline's loop gate — ` +
        `run \`cowork-harness sync\`, or pass --fidelity container|hostloop explicitly.`,
    );
  }
  return decideLoopFromBaseline(baseline, { devForceHostLoop: childForcesHostLoop(dotenvPath) }) === "host" ? "hostloop" : "container";
}

function parseArgs(
  argv: string[],
  resolveCowork: (dotenvPath: string | undefined) => "container" | "hostloop" = resolveCoworkTier,
): ParsedArgs {
  const positional: string[] = [];
  let prompt: string | undefined;
  let dotenv: string | undefined;
  let fidelity = "container";
  let evaluatorModel: string | undefined;
  let outputFormat: "json" | "text" = "text";
  let out: string | undefined;
  let skillSelector: string | undefined;
  let promptFile: string | undefined;
  let taskTimeoutMs: number | undefined;
  let corpusOnly = false;
  const forwardBoth: string[] = [];
  const forwardTask: string[] = [];
  const seen = new Set<string>();
  /** Every flag that shapes the RUN, in arrival order, deduped — the set `--corpus-only` reports as
   *  `ignoredFlags`. Recorded for critique-owned flags and forwarded ones alike; `--skill`, `--out`,
   *  `--output-format` and `--keep` are NOT run-shaping (they select, format or are already satisfied). */
  const runShaping: string[] = [];
  const shapes = (flag: string) => {
    if (!runShaping.includes(flag)) runShaping.push(flag);
  };
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
      shapes("--prompt");
      i += adv;
    } else if (a === "--dotenv" || a.startsWith("--dotenv=")) {
      once("--dotenv");
      const { value: v, adv } = flagVal(argv, i, "--dotenv");
      dotenv = v;
      shapes("--dotenv");
      i += adv;
    } else if (a === "--fidelity" || a.startsWith("--fidelity=")) {
      once("--fidelity");
      const { value: v, adv } = flagVal(argv, i, "--fidelity");
      fidelity = v;
      shapes("--fidelity");
      i += adv;
    } else if (a === "--evaluator-model" || a.startsWith("--evaluator-model=")) {
      once("--evaluator-model");
      const { value: v, adv } = flagVal(argv, i, "--evaluator-model");
      evaluatorModel = v;
      shapes("--evaluator-model");
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
      shapes("--prompt-file");
      i += adv;
    } else if (a === "--out" || a.startsWith("--out=")) {
      once("--out");
      const { value: v, adv } = flagVal(argv, i, "--out");
      out = v;
      i += adv;
    } else if (a === "--skill" || a.startsWith("--skill=")) {
      once("--skill");
      const { value: v, adv } = flagVal(argv, i, "--skill");
      skillSelector = v;
      i += adv;
    } else if (a === "--keep" || a.startsWith("--keep=")) {
      // Match the equals form too so it errors as "takes no value" rather than falling through to the
      // owned-flag branch's "unknown flag: --keep=x", which misdescribes the mistake.
      if (a.includes("=")) throw new Error(`--keep takes no value (got "${a}")\n${usage()}`);
      // accepted no-op: critique always keeps its runs, so the flag's promise already holds. Erroring on
      // an already-satisfied request is hostile; silently ignoring an UNsatisfied one is this repo's
      // anti-pattern — this is the former.
    } else if (a === "--corpus-only" || a.startsWith("--corpus-only=")) {
      if (a.includes("=")) throw new Error(`--corpus-only takes no value (got "${a}")\n${usage()}`);
      corpusOnly = true; // arity 0, idempotent on repeat — same exemption `once()` gives every boolean
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
      shapes(name);
    } else positional.push(a);
  }
  if (positional.length !== 1) throw new Error(usage());
  if (prompt !== undefined && promptFile !== undefined) throw new Error(`--prompt and --prompt-file are mutually exclusive\n${usage()}`);
  if (promptFile !== undefined) {
    if (!existsSync(promptFile)) throw new Error(`--prompt-file not found: ${promptFile}`);
    prompt = readFileSync(promptFile, "utf8");
  }
  // `--corpus-only` runs no turn, so a probe has nothing to consume it — the ONLY invocation that may omit
  // one. Every other line keeps the requirement, and a prompt that IS given under --corpus-only is still
  // validated (mutual exclusion above, file existence) and then listed as ignored: the drop-in property is
  // that an existing critique line gains the flag without being rewritten, not that its flags stop meaning
  // anything.
  if (!corpusOnly && (!prompt || !prompt.trim())) throw new Error(`--prompt "<probe>" or --prompt-file <path> is required\n${usage()}`);
  if (fidelity !== "container" && fidelity !== "hostloop" && fidelity !== "cowork") {
    // Two proven tiers, plus `cowork` which RESOLVES to one of them below. Each refusal states its OWN
    // reason rather than a generic "unknown tier": the reflection turn RESUMES the task turn's mounted
    // skill + conversation, and that continuity is proven only for container (Linux ELF) and hostloop
    // (native binary).
    const reason =
      fidelity === "microvm"
        ? "resume-continuity is unproven for the microVM guest (a different guest and session-store location than container/hostloop)"
        : fidelity === "protocol"
          ? "the protocol tier never plumbs a session id or --resume, so the reflection turn cannot resume the task turn at all"
          : "it is not a fidelity tier";
    throw new Error(`skill-critique runs at the container or hostloop tier only; --fidelity ${fidelity} is refused: ${reason}`);
  }
  if (outputFormat !== "json" && outputFormat !== "text")
    throw new Error(`--output-format must be "text" or "json" (got "${outputFormat}")`);
  // `--out foo.json` writes whatever `--output-format` says, and that defaults to TEXT — so a scripted
  // `json.load()` fails with "Expecting value: line 1 column 1", which reads as a corrupt or missing
  // report rather than a format mismatch. Warn HERE, at parse time, rather than inferring the format
  // from the filename: a name is not proof of intent, and silently changing what an existing
  // `--out foo.json` writes would break a script that already parses the text. Parse time is also the
  // point that matters — the reported cost of this footgun was a four-workload run discovered to be
  // unparseable AFTER it was paid for; a warning here fires before the spawn.
  if (out !== undefined) {
    const ext = extname(out).toLowerCase();
    const wanted = ext === ".json" ? "json" : ext === ".txt" || ext === ".md" ? "text" : undefined;
    if (wanted !== undefined && wanted !== outputFormat) {
      warn(
        `::warning:: [critique] --out ${out} looks like ${wanted}, but --output-format is "${outputFormat}"` +
          `${seen.has("--output-format") ? "" : " (the default)"} — the file will contain ${outputFormat}. ` +
          `Pass --output-format ${wanted} if that is not what you meant.\n`,
      );
    }
  }
  // Fail fast with critique's OWN clear error (mirroring cli.ts's global --dotenv existence check,
  // ~line 627) rather than letting an absent file surface later as a generic instrument-failure
  // diagnostic from the child `skill` invocation's own (differently-worded) rejection.
  if (dotenv !== undefined && !existsSync(dotenv)) throw new Error(`--dotenv file not found: ${dotenv}\n${usage()}`);
  // `cowork` names "whatever real Cowork does here" rather than a tier, so resolve it ONCE, now — before
  // either turn is spawned — and hand both turns the resolved literal. That is what makes it safe: the
  // refusal this replaces existed to protect a within-critique invariant (both turns at the SAME tier,
  // because a cross-tier resume fails loud on the session-manifest fidelity stamp), and one resolution
  // shared by both spawns preserves it exactly. Resolving per-turn would not.
  //
  // AFTER the --dotenv existence check on purpose: the child CLI loads that file into its own env before
  // deciding, so the file is part of the input to a decision we are making on the child's behalf.
  const requestedFidelity = fidelity === "cowork" ? "cowork" : undefined;
  if (fidelity === "cowork") fidelity = resolveCowork(dotenv);
  // The allowlist guard above proves fidelity is one of the two members; TS can't narrow a `let string`
  // across a throwing branch, so assert the type the guard guarantees.
  return {
    skillFolder: positional[0],
    prompt,
    corpusOnly,
    ignoredFlags: corpusOnly ? runShaping : [],
    dotenv,
    fidelity: fidelity as ParsedArgs["fidelity"],
    requestedFidelity,
    evaluatorModel,
    outputFormat,
    out,
    skillSelector,
    forwardBoth,
    forwardTask,
    taskTimeoutMs,
  };
}

/** How a skill-dir positional inside a plugin is treated. `null` when the positional is not that shape (a
 *  plugin root, a plain skill folder with no enclosing manifest, or `--skill` was passed). */
export type TargetPromotion =
  { kind: "promoted"; enclosing: string; name: string } | { kind: "fallback"; enclosing: string; name: string; reason: string };

/** `critique <plugin>/skills/<name>` IS `critique <plugin> --skill <name>`: Cowork installs plugins, never a
 *  bare skill folder, so the faithful mount for a skill inside a plugin is the plugin. Promoted whenever
 *  `--skill` could address the skill and staging would deliver it from the plugin's mount — regardless of
 *  whether the plugin contributes anything the skill uses, so the two spellings are the same run (same
 *  mount, corpus, `skillHash`, graded skill) rather than two runs that agree only sometimes.
 *
 *  Falls back to mounting the positional alone when `--skill` cannot reach the skill from the plugin:
 *   - it is not at exactly `skills/<name>` (`findEnclosingPluginDir` is a plain walk-up, so `tools/x` or
 *     `skills/group/x` inside a plugin land here too, and `--skill x` would grade a DIFFERENT skill);
 *   - the plugin's mount would not deliver it (a submodule or nested repo — the plugin's index never
 *     descends into it — a path whose case differs from the tracked one, or an unreadable index).
 *  The reason is staging's own diagnosis, not a guess. */
export function promoteSkillDirTarget(skillFolder: string, skillSelector: string | undefined): TargetPromotion | null {
  if (skillSelector !== undefined || !existsSync(join(skillFolder, "SKILL.md"))) return null;
  const positional = resolve(skillFolder);
  const enclosing = findEnclosingPluginDir(positional);
  if (enclosing === null || enclosing === positional) return null;
  const rel = relative(enclosing, positional).split(sep).join("/");
  const at = /^skills\/([^/]+)$/.exec(rel);
  // The name comes from the path RELATIVE to the plugin, never from `basename(skillFolder)` — that is "."
  // for a spelling like `p/skills/x/.`.
  const name = at ? at[1]! : basename(positional);
  if (!at) return { kind: "fallback", enclosing, name, reason: `--skill addresses only skills/<name>/; this skill lives at ${rel}` };
  const delivered = checkMountDelivers(enclosing, join(enclosing, "skills", name));
  if (!delivered.ok) return { kind: "fallback", enclosing, name, reason: delivered.diagnosis };
  return { kind: "promoted", enclosing, name };
}

/** Apply `promoteSkillDirTarget` to the ONE `opts` binding `main` hands to every consumer — the resolver,
 *  the preview, both turns' argv (and so the mount, the resume identity and `skillHash`), and every report
 *  field. Written as a reassignment on purpose: a second binding would let the preview show the promotion
 *  while a paid turn mounted the original folder. Announces the decision on stderr. */
export function applyTargetPromotion(opts: ParsedArgs): ParsedArgs {
  const p = promoteSkillDirTarget(opts.skillFolder, opts.skillSelector);
  if (p === null) return opts;
  if (p.kind === "promoted") {
    process.stderr.write(
      `::notice:: [critique] ${p.name} is a skill inside plugin ${tildeify(p.enclosing)} — mounting the plugin as Cowork does, grading skill '${p.name}'\n`,
    );
    return { ...opts, skillFolder: p.enclosing, skillSelector: p.name };
  }
  process.stderr.write(
    `::notice:: [critique] ${tildeify(opts.skillFolder)} is skill '${p.name}' inside plugin ${tildeify(p.enclosing)}, but critique ${tildeify(p.enclosing)} --skill ${p.name} is not available: ${p.reason} — ` +
      `mounting only this folder, so anything the plugin provides outside it (agents, shared references) is absent from the graded run\n`,
  );
  return opts;
}

/** The pre-spend check, shared by `--corpus-only` and a paid critique so both refuse the same targets:
 *  staging would not deliver the skill from this mount, or there is no readable SKILL.md to grade. Runs
 *  the same `packageEvidence` call the graded run makes, over an EMPTY run dir (measured: ~40 ms, no
 *  writes) — `"preview"` mode for `--corpus-only`, which then renders that result; `"preflight"` (silent)
 *  on the live path, whose real packaging pass after the turns emits every warning once. */
export function preflightCritique(
  resolved: ResolvedCritiqueTarget,
  mode: "preview" | "preflight",
): { ok: true; pkg: ReturnType<typeof packageEvidence> } | { ok: false; message: string } {
  const delivered = checkMountDelivers(resolved.mountRoot, resolved.skillDir);
  if (!delivered.ok) return { ok: false, message: `${delivered.diagnosis}.${delivered.action ? ` ${delivered.action}` : ""}` };
  const runDir = mkdtempSync(join(tmpdir(), "cwh-critique-corpus-"));
  let pkg: ReturnType<typeof packageEvidence>;
  try {
    pkg = packageEvidence(runDir, { events: { size: 0 }, timeline: { size: 0 } }, resolved.skillDir, false, {
      agents: resolved.agents,
      pluginRoot: resolved.pluginRoot,
      mountRoot: resolved.mountRoot,
      mode,
    });
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
  if (pkg.skillMdStatus !== "readable") {
    const hint =
      pkg.skillMdStatus === "untracked"
        ? "It is on the host but not git-tracked, so staging would never deliver it: 'git add' it."
        : pkg.skillMdStatus === "missing"
          ? "A multi-skill plugin root needs --skill <name>; a plain skill folder needs a root SKILL.md."
          : "It exists but could not be read — check permissions, or whether SKILL.md is a regular file.";
    return {
      ok: false,
      message: `no readable SKILL.md at ${tildeify(resolved.skillDir)} (${pkg.skillMdStatus}) — nothing to ${mode === "preview" ? "measure" : "grade"}. ${hint}`,
    };
  }
  return { ok: true, pkg };
}

/** Resolve WHICH folder the packager grades (and, for a plugin, every `agents/**.md` the invoked skill
 *  can dispatch).
 *
 *  `skillFolder` is what both turns MOUNT — already promoted by `applyTargetPromotion` when it named a
 *  skill inside a plugin — and nothing here changes it (the reflection turn's resume recomputes session
 *  identity from the same sources). This resolves only the PACKAGER's view, and only from content that
 *  mount carries:
 *   - a plain skill folder (root `SKILL.md`) → itself;
 *   - a multi-skill plugin + `--skill <name>` → `skills/<name>/` (fail loud if absent, naming what exists);
 *   - a multi-skill plugin, no `--skill`, exactly ONE skill → auto-selected with a stderr notice;
 *   - a multi-skill plugin, no `--skill`, several skills → REFUSED loud before any model spend — grading
 *     a plugin root with no SKILL.md silently downgraded every coverage finding to "not adjudicable"
 *     (observed in the field as a 100% not-adjudicable critique).
 *  `fingerprint.skillHash` is computed over the MOUNTED folder and is unchanged by `--skill` — same
 *  folder → same hash — so generation pairing keeps working; it is a per-plugin key, not per-skill.
 *  Exported for unit tests. */
export interface ResolvedCritiqueTarget {
  skillDir: string;
  agents: ResolvedAgent[];
  /** The folder both turns MOUNT (the positional, after any promotion). The packager keys every corpus
   *  class on its git-tracked set — the one staging reads. */
  mountRoot: string;
  /** Always the mount root: the packager may only resolve agents / shared references from content the
   *  mount carries. */
  pluginRoot: string;
  autoSelectedSkill?: string;
  /** The skill whose invocation the advisory checks, or undefined for a plain skill folder. */
  gradedSkillName?: string;
}

export function resolveCritiquedSkillDir(skillFolder: string, skillSelector: string | undefined): ResolvedCritiqueTarget {
  // Fail-fast on a typo'd / absent path BEFORE the caller mints a session and spawns the task turn — a
  // missing folder otherwise only surfaces as a mid-run mount failure that leaves a stray run dir behind.
  // This lives here (not in parseArgs) on purpose: parseArgs is unit-tested with fictitious paths, whereas
  // this resolver is only ever called with a real folder. One statSync in a try/catch also covers a broken
  // symlink; the existsSync guard just gives the common typo the clearer "not found" message.
  if (!existsSync(skillFolder)) throw new Error(`skill folder not found: ${tildeify(skillFolder)}`);
  let stat;
  try {
    stat = statSync(skillFolder);
  } catch {
    throw new Error(`skill folder not found: ${tildeify(skillFolder)}`);
  }
  if (!stat.isDirectory()) throw new Error(`not a directory: ${tildeify(skillFolder)}`);
  // Agent files are tracked relative to the PLUGIN ROOT, not to skillDir (they live at
  // <root>/agents/**.md while skillDir is <root>/skills/<name>), so the packager needs the root to check
  // each one against the same tracked set staging used.
  const mountRoot = resolve(skillFolder);
  const agentsFor = (pluginRoot: string, skillDir: string, name: string | undefined) => ({
    agents: resolveDispatchableAgents(pluginRoot, skillDir, name),
    pluginRoot,
    mountRoot,
  });
  const listPluginSkills = (): string[] => {
    try {
      return readdirSync(join(skillFolder, "skills"), { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(skillFolder, "skills", e.name, "SKILL.md")))
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
  };
  if (skillSelector !== undefined) {
    // A NAME, not a path: `--skill ../../elsewhere` joined blindly resolved to a directory the mount can
    // never contain and was graded (measured: exit 0, `skillDir` outside the plugin) — and the same string
    // was then used as the agent-match name, so no agent could ever match it. The staging layer already
    // owns the single-segment rule; reuse it rather than mint a second one.
    safePathSegment(skillSelector, "--skill name");
    const candidate = join(skillFolder, "skills", skillSelector);
    if (!existsSync(join(candidate, "SKILL.md"))) {
      const available = listPluginSkills();
      throw new Error(
        `--skill ${skillSelector}: no skills/${skillSelector}/SKILL.md under ${tildeify(skillFolder)}` +
          (available.length ? ` — available skills: ${available.join(", ")}` : ` — no skills/<name>/SKILL.md found at all`),
      );
    }
    return { skillDir: candidate, ...agentsFor(skillFolder, candidate, skillSelector), gradedSkillName: skillSelector };
  }
  // A plain skill folder. Two shapes hide here:
  //   1. the dir IS the plugin root (manifest + top-level SKILL.md; this repo's own
  //      .claude/skills/cowork-harness/ is one) — the skill's name is the manifest name; or
  //   2. the dir is a skill INSIDE a plugin that `applyTargetPromotion` could not promote. Detected with the
  //      same `findEnclosingPluginDir` analyze-skill uses — REUSED, not re-derived.
  if (existsSync(join(skillFolder, "SKILL.md"))) {
    const enclosing = findEnclosingPluginDir(skillFolder);
    // `findEnclosingPluginDir` is INCLUSIVE of its start, so an equal path is shape 1, not shape 2.
    // Shape 2 reaches here only when `applyTargetPromotion` could NOT promote it to the enclosing plugin
    // (see there): the mount is this folder alone, so the plugin's agents and shared references are not in
    // it and must not be in the corpus. The skill still has a name — its directory's.
    if (enclosing !== null && enclosing !== mountRoot)
      return { skillDir: skillFolder, ...agentsFor(skillFolder, skillFolder, basename(mountRoot)), gradedSkillName: basename(mountRoot) };
    return { skillDir: skillFolder, ...agentsFor(skillFolder, skillFolder, readPluginName(skillFolder)) };
  }
  const skills = listPluginSkills();
  if (skills.length === 1)
    return {
      skillDir: join(skillFolder, "skills", skills[0]!),
      ...agentsFor(skillFolder, join(skillFolder, "skills", skills[0]!), skills[0]!),
      autoSelectedSkill: skills[0]!,
      gradedSkillName: skills[0]!,
    };
  if (skills.length > 1)
    throw new Error(
      `${tildeify(skillFolder)} is a multi-skill plugin root (no root SKILL.md; skills: ${skills.join(", ")}) — ` +
        `pass --skill <name> so critique grades the INVOKED skill's SKILL.md instead of a missing root one`,
    );
  // no SKILL.md anywhere — the packager's existing missing/degraded flow reports it. No skill to resolve
  // dispatches FOR, so no agents either.
  return { skillDir: skillFolder, agents: [], mountRoot, pluginRoot: mountRoot };
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
/** Wall-clock kill for a spawned turn. THIRTY minutes, not ten.
 *
 *  Ten was sized for a quick single-agent run. A sub-agent-dispatching skill routinely exceeds it, and the
 *  failure is the most expensive one this tool has: the task turn is killed AFTER its model spend, so the
 *  consumer pays for a graded run and receives an instrument failure instead of a critique. A reported case
 *  burned $11.05 that way. Being killed too late costs waiting; being killed too early costs the money AND
 *  the result, so the asymmetry says err long. `--timeout` still raises it further, and the byte cap plus
 *  the process-group kill below remain the real runaway guards. Matches the evaluator transport's own
 *  30-minute floor so neither end of the pipeline is the surprise one. */
const TURN_TIMEOUT_MS = 30 * 60_000;
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
    // ONE combined stdout+stderr byte budget — the cap the comment above promises. Previously two
    // independent per-stream counters, so a child splitting output across both streams could buffer
    // ~2x `maxBytes` before either tripped (F4: the documented memory bound on a looping/hostile child).
    let outBytes = 0;
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

    // Charge every chunk against the SHARED budget; on overflow keep exactly the bytes that still fit
    // (slice the terminal chunk to the remaining room) so the captured output never exceeds `maxBytes`.
    const onChunk = (d: Buffer, append: (s: string) => void) => {
      if (settled) return;
      const before = outBytes;
      outBytes += d.length;
      if (outBytes > maxBytes) {
        const room = maxBytes - before; // bytes from THIS chunk that still fit under the combined cap
        if (room > 0) append(d.subarray(0, room).toString());
        truncated = true;
        killGroup();
        finish(null);
        return;
      }
      append(d.toString());
    };
    child.stdout.on("data", (d: Buffer) => onChunk(d, (s) => (stdout += s)));
    child.stderr.on("data", (d: Buffer) => onChunk(d, (s) => (stderr += s)));
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
  error?: { category?: string; message?: string; hint?: string } | null;
  results?: Array<{
    outDir?: string;
    finalMessage?: string;
    result?: "success" | "error";
    resultSubtype?: string;
    /** Why an errored run errored. `resultErrorKind` is the harness's own classification (a tail-end
     *  transport drop / a genuine agent failure / an exhausted quota); `errorSource` is the finer
     *  termination source. Both ride in the envelope because it spreads the whole `RunResult`. */
    resultErrorKind?: "transport" | "agent" | "usage_limit";
    errorSource?: string;
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
 *  — so a run whose stdout envelope didn't parse (e.g. it crashed before ever writing one) can still be
 *  located via `--keep`.
 *
 *  The fallback is sound here because the `[status]` line is written regardless of `--output-format` AND
 *  the only thing that suppresses it — `--compact`/`--demo` (see `statusLine`, run/run-status.ts) —
 *  `critique` REJECTS outright (run/skill-flag-surface.ts). If that rejection is ever relaxed, this
 *  fallback silently stops finding killed task turns. */
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

/** The graded turn's own recorded model ids — the provenance question a reader of a critique must be able
 *  to answer without opening a turn file, and the one the report used to leave blank.
 *
 *  `taskRaw` is passed in on the normal path (already read there); the task-turn FAILURE path has no such
 *  read yet, so it is re-read here rather than skipped — a failure report is exactly where "which model
 *  was this?" is asked, and it is the branch that used to name no model at all. Every step is defensive:
 *  an absent, unreadable or shapeless result.json yields `undefined`, never a throw. */
export function readGradedModels(outDir: string, taskRaw?: Record<string, unknown> | null): string[] | undefined {
  const raw = taskRaw === undefined ? (readTurn1Result(outDir) as Record<string, unknown> | null) : taskRaw;
  const models = raw?.models;
  if (!Array.isArray(models)) return undefined;
  const live = models.filter(isLiveModelId);
  return live.length ? [...new Set(live)] : undefined;
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
): { ok: true; envelope: SkillEnvelope } | ({ ok: false } & TurnFailure) {
  if (turn.timedOut) return { ok: false, reason: "reflection turn timed out and was killed before it could complete" };
  if (turn.truncated) return { ok: false, reason: "reflection turn's output exceeded the byte cap and was killed" };
  if (turn.code !== 0) {
    // Same rule as the task turn's (see `taskTurnInfraFailure`): a nonzero exit usually arrives WITH the
    // harness's own structured diagnosis, and reporting only the exit code throws it away — leaving a
    // reader to guess between a crashed instrument and an ordinary usage/boundary error the harness
    // already named.
    // `fail()`'s error envelope first (exit 2/3), then the result row of a turn that RAN and errored
    // (exit 1, `error: null`) — the path that used to report a bare exit code and nothing else.
    const diag = envelopeDiagnosis(turn) ?? resultRowDiagnosis(turn);
    return {
      ok: false,
      reason: `reflection turn exited with code ${turn.code ?? "null"} (expected 0)${diag ? ` — ${diag.text}` : ""}`,
      kind: diag?.kind,
    };
  }
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
/** A turn that produced no gradeable outcome: the human-readable `reason`, plus the harness error
 *  `kind` (an `ErrCategory`) when the failed turn printed a structured error envelope. */
export interface TurnFailure {
  reason: string;
  kind?: string;
}

/** The error categories that are the CALLER's problem — a scenario or an invocation to fix, with a
 *  healthy instrument underneath.
 *
 *  The complement matters more than the list. `src/cli.ts`'s top-level catch funnels EVERY unexpected
 *  throw into `jsonError(command, "internal", …)`, and `LegacyRunDirError` into `"runtime"` — so a
 *  Docker daemon that is down, a container that fails to start, a missing staged agent, a vanished mount
 *  and an outright harness bug all arrive as a well-formed error envelope with a category. "It has a
 *  category, therefore it is ordinary" is exactly wrong for those, and wrong in the dangerous direction:
 *  it tells a reader the instrument is healthy while it is not. Only these three are ordinary; anything
 *  else — including a category added later that this list has not been taught — stays INFRASTRUCTURE. */
const ORDINARY_ERROR_KINDS = new Set([
  // Harness `ErrCategory` values (from a `fail()` error envelope).
  "unanswered",
  "usage",
  "boundary",
  // `RunResult.resultErrorKind` values, from a turn that RAN and reported an errored result. Both
  // taxonomies answer the same question — why did this turn fail — and both land in `infraFailureKind`.
  // `usage_limit` (quota exhausted, retry after reset) and `transport` (a tail-end connection drop) leave
  // a healthy instrument behind. `agent` deliberately does NOT: for critique's own protocol turn, an
  // agent-level failure IS the instrument breaking.
  "usage_limit",
  "transport",
]);

export function isOrdinaryFailureKind(kind: string | undefined): boolean {
  return kind !== undefined && ORDINARY_ERROR_KINDS.has(kind);
}

/** Render a failed turn's own structured diagnosis, or `undefined` when it printed none.
 *
 *  The hint is appended ONLY when the message does not already contain it. `UnansweredError` is thrown
 *  as `new UnansweredError(\`unscripted AskUserQuestion…:\n${body}\`, body)` — the message CONTAINS the
 *  hint — so an unconditional append printed the whole question, its options and its four-line remedy tip
 *  twice, on the single most common failure this reporting exists to serve.
 *
 *  Deliberately NO remedy text of our own on top. There are 36 `UnansweredError` sites and only ONE is
 *  "the skill asked a question the graded run had no answer for"; the rest are a mis-typed `--answer`
 *  label, malformed `--answer-policy` YAML, a crashed `--decider-cmd` helper, an out-of-set
 *  `--decider-llm` reply, an unanswered dialog/elicit, even a self-declared harness bug. Advice keyed on
 *  the CATEGORY is wrong for nearly all of them, and each site already carries a hint written for its own
 *  case. Carry that hint; do not re-derive it from the category. */
/** Why a turn that RAN reported an errored result — read off its envelope's result row.
 *
 *  Distinct from `envelopeDiagnosis`: that reads the top-level `error` object, which only `fail()` writes
 *  (exit 2/3). A turn that completed a run and errored exits 1 with `error: null` and a full result row,
 *  so the exit-code-only report said "exited with code 1 (expected 0)" and stopped — the reader learned
 *  nothing about a quota exhaustion, a transport drop or a turn-limit. Every field here already existed
 *  and was already rendered this way by the run renderer; critique simply never read them.
 *
 *  Subtype precedence matches `src/run/renderer.ts`: prefer the SDK subtype ONLY when the terminal error
 *  actually came from a result event, so a stale subtype from an earlier turn cannot mislabel a later
 *  exit/timeout/no_result error. */
function resultRowDiagnosis(turn: TurnOutcome): { text: string; kind?: string } | undefined {
  const r0 = parseEnvelope(turn.stdout)?.results?.[0];
  if (!r0 || r0.result !== "error") return undefined;
  const subtype = r0.errorSource === "result" && r0.resultSubtype && r0.resultSubtype !== "success" ? r0.resultSubtype : undefined;
  const detail = [subtype ?? r0.errorSource].filter(Boolean).join("");
  const label =
    r0.resultErrorKind === "usage_limit"
      ? "usage-limit — the account's quota is exhausted; retry after the reset. This is NOT a harness or skill defect"
      : r0.resultErrorKind === "transport"
        ? "transport error — a tail-end connection drop, not a skill defect; retry"
        : r0.resultErrorKind === "agent"
          ? "agent error"
          : "error";
  // The bare reason, with no framing of its own — the two callers wrap it differently (a failed turn's
  // sentence vs. a parenthetical on the graded run's NOTE), and a shared prefix that one of them stripped
  // back off with a regex would couple them through a string shape.
  return { kind: r0.resultErrorKind, text: `${label}${detail ? ` (${detail})` : ""}` };
}

function envelopeDiagnosis(turn: TurnOutcome): { text: string; kind?: string } | undefined {
  const err = parseEnvelope(turn.stdout)?.error;
  if (!err || typeof err.message !== "string" || !err.message) return undefined;
  const hint = typeof err.hint === "string" && err.hint ? err.hint : undefined;
  const kind = typeof err.category === "string" && err.category ? err.category : undefined;
  return {
    kind,
    text: `${kind ?? "error"}: ${err.message}` + (hint && !err.message.includes(hint) ? `\n${hint}` : ""),
  };
}

export function taskTurnInfraFailure(task: TurnOutcome): TurnFailure | undefined {
  if (task.timedOut)
    return {
      reason:
        "task turn timed out and was killed before it could complete — raise the wall-clock budget with " +
        "--timeout <ms> (default 30 min). The turn is killed AFTER its model spend, so this run cost you the " +
        "graded turn and produced no critique",
    };
  if (task.truncated) return { reason: "task turn's output exceeded the byte cap and was killed" };
  // A task that exited NONZERO without ever printing a parseable result envelope (a `results[0]` with an
  // outDir) crashed before it completed. The task turn is spawned `--output-format json`, so a run that
  // actually finished always prints one; when it didn't, `extractOutDir` recovers the dir only from the
  // early `[status]` line, and there is no trustworthy result/finalMessage to reflect on and grade.
  //
  // Deliberately NARROW — this does NOT protocol-validate a COMPLETED task the way the reflection turn is
  // validated. A task that RAN and reported a failing verdict (a nonzero exit carrying a VALID envelope —
  // `ok:false` or `results[0].result:"error"`) is a genuine, GRADEABLE outcome the skill produced, the
  // whole point of the critique. So this fires ONLY on the crash-with-no-envelope case, never on a
  // completed run's success/verdict.
  if (task.code !== 0 && !parseEnvelope(task.stdout)?.results?.[0]?.outDir) {
    // A nonzero exit is not automatically a CRASH. `fail()` (run/envelope.ts) prints a fully-formed
    // `{ok:false, results:[], error:{category,message,hint}}` envelope on the way out, so the harness has
    // usually already said WHY in machine-readable form — an unanswered gate, a usage error, a boundary
    // refusal. Reading only `results[0].outDir` threw all of that away and answered "it crashed" for every
    // one of them, which points a reader at Docker and the staged agent when the real cause was a gate
    // with no scripted answer. Prefer the envelope's own diagnosis; keep the crash wording strictly for
    // the case where there is genuinely no envelope to read.
    const diag = envelopeDiagnosis(task);
    if (diag) return { kind: diag.kind, reason: `task turn exited ${task.code} — ${diag.text}` };
    return {
      reason:
        "task turn exited nonzero without a parseable result envelope — it crashed before completing a gradeable task, so its evidence cannot be trusted",
    };
  }
  return undefined;
}

type Bucket = "actionable" | "other" | "not-adjudicable" | "dropped";

/** Does this finding's text point at a skill SCRIPT? Matches a `scripts/` path or a bare source
 *  filename — deliberately loose, because it only ever adds an explanatory note to an already-issued
 *  `not-adjudicable` verdict. A false positive costs one sentence; a false negative leaves a consumer
 *  reading "unproven" where the truth is "unseen". */
const SCRIPT_MENTION = /\bscripts\/|\b[\w.-]+\.(?:py|sh|js|mjs|ts)\b/;

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

/** Per-critique cost rollup: the four model workloads, each priced from its own usage record when
 *  available. `complete` is true ONLY when all four are priced — a partial total must never present
 *  itself as the full spend. */
/** NOT the same number as a run's `RunResult.cost.usd` (src/types.ts), which is ONE invocation's
 *  SDK-reported `total_cost_usd`. `totalUsd` here aggregates the task turn, the reflection turn and both
 *  evaluator passes. Reading the wrong key returns `undefined`/`None` rather than erroring, which reads as
 *  "no cost recorded"; the two shapes are deliberately kept distinct because the per-phase split is the
 *  reason this report exists. */
export interface CritiqueCost {
  taskTurnUsd?: number;
  reflectionTurnUsd?: number;
  evaluatorPass1Usd?: number;
  evaluatorPass2Usd?: number;
  totalUsd: number;
  complete: boolean;
  /** Token split for each evaluator pass. The transport hands us the full usage object and we previously
   *  summed it to a dollar figure and discarded the rest — so the report said what a pass COST and never
   *  why, and "is the money evidence or thinking?" was unanswerable from any artifact the tool produced.
   *  That is the question that decides whether sending more evidence is cheap, and it was being thrown
   *  away on every run. `cacheRead` is separated because it prices at a tenth of fresh input. */
  evaluatorPass1Tokens?: EvaluatorTokens;
  evaluatorPass2Tokens?: EvaluatorTokens;
}

export interface EvaluatorTokens {
  input: number;
  output: number;
  cacheRead: number;
}

/** Sum the token counters across a `modelUsage` map — the sibling of `sumCostUsd` over the same shape.
 *  `undefined` when the map is absent or carries no numeric counter at all (unpriced/unreported), which is
 *  DIFFERENT from a genuine zero. */
export function sumTokens(modelUsage: unknown): EvaluatorTokens | undefined {
  if (!modelUsage || typeof modelUsage !== "object") return undefined;
  let input = 0,
    output = 0,
    cacheRead = 0,
    seen = false;
  for (const v of Object.values(modelUsage as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const m = v as { inputTokens?: unknown; outputTokens?: unknown; cacheReadInputTokens?: unknown };
    if (typeof m.inputTokens === "number") ((input += m.inputTokens), (seen = true));
    if (typeof m.outputTokens === "number") ((output += m.outputTokens), (seen = true));
    if (typeof m.cacheReadInputTokens === "number") ((cacheRead += m.cacheReadInputTokens), (seen = true));
  }
  return seen ? { input, output, cacheRead } : undefined;
}

/** Sum `costUSD` across a result/envelope `modelUsage` map. `undefined` when the map is absent or
 *  carries no numeric costUSD at all — "unpriced", which is DIFFERENT from a genuine $0. */
export function sumCostUsd(modelUsage: unknown): number | undefined {
  if (!modelUsage || typeof modelUsage !== "object") return undefined;
  let total = 0;
  let priced = false;
  for (const v of Object.values(modelUsage as Record<string, unknown>)) {
    const c = v && typeof v === "object" ? (v as { costUSD?: unknown }).costUSD : undefined;
    if (typeof c === "number") {
      total += c;
      priced = true;
    }
  }
  return priced ? total : undefined;
}

interface ReportState {
  skillFolder: string;
  prompt: string;
  sessionId: string;
  outDir: string;
  /** The tier critique pinned for BOTH turns. */
  fidelity: string;
  /** Set only when the caller passed `--fidelity cowork` and this is what it resolved to — so the report
   *  distinguishes "you asked for hostloop" from "you asked for cowork and got hostloop". Absent when the
   *  caller named a concrete tier, which is the common case. */
  requestedFidelity?: string;
  /** Best-effort from the graded turn's own result.json — which tier/baseline that run RECORDS itself
   *  as (should equal `fidelity`; surfacing both makes a mismatch visible instead of assumed away). */
  gradedEffectiveFidelity?: string;
  gradedBaseline?: string;
  /** Per-critique cost across all four workloads — see CritiqueCost. Absent when nothing was priceable. */
  costUsd?: CritiqueCost;
  /** The resolved skills/<name> the PACKAGER graded — `--skill` or the single-skill auto-selection;
   *  absent for a plain skill folder. LOAD-BEARING for multi-skill-plugin pairing: `fingerprint.skillHash`
   *  keys the MOUNTED folder (per-plugin), so pairing critiques by skillHash alone cross-pairs different
   *  skills of the same plugin — pair by (gradedSkillHash, gradedSkill). */
  gradedSkill?: string;
  /** Advisory graded-run validity: when a plugin skill was selected (--skill / auto), whether an
   *  OBSERVABLE channel named it — a `Skill` tool call, or a leading staged-skill slash command.
   *  `false` = both channels were observable and neither fired, so the critique may be grading a run
   *  that never invoked the selected skill. `undefined` = not applicable, or a channel could not be
   *  observed at all (absent prompt/inventory, a same-named command shadowing the skill, or an
   *  unnameable sub-agent `Skill` call). Absent is never a synonym for `false`. */
  skillInvocationObserved?: boolean;
  /** The plugin ships BOTH `commands/<skill>.md` and `skills/<skill>/SKILL.md`, so the one registered
   *  slash command is ambiguous and the run does not say which ran. Surfaced so *absent* is an
   *  actionable outcome rather than a dead end. */
  commandShadowsSkill?: boolean;
  /** The graded run's resolved gate answers (from its result.json's gateProvenance), lifted so a
   *  follow-up run can be made deterministic — the text report echoes them as copy-pasteable --answer
   *  lines, mirroring the `skill` lane's footer. */
  gateAnswers?: Array<{ question: string; answer: string; answeredBy: string }>;
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
  /** The model ids the GRADED turn actually ran on, read back from its own `result.json` (`models`) and
   *  filtered through `isLiveModelId`. The report already named the EVALUATOR's resolved model and named
   *  no other, so the one number a reader must not get wrong — which model produced the behaviour being
   *  graded — was absent from every critique. It cannot be inferred from the caller's context either: the
   *  turns are a SUBPROCESS and inherit nothing from the session that invoked `critique`, so an omitted
   *  `--model` grades whatever the spawned agent defaults to, silently and without a trace in the report.
   *  Absent when no result.json was readable or it recorded no live id. */
  gradedModels?: string[];
  /** WHY a graded turn that ended in `result:"error"` errored — the run's own `resultErrorKind` plus its
   *  finer termination source. An errored task turn is a GRADEABLE outcome (the critique proceeds), but
   *  the report said only "ended in error", so a reader could not tell a skill defect from an exhausted
   *  quota or a dropped connection without opening a turn file — and would read the findings as being
   *  about the skill either way. Absent when the run did not error, or recorded no classification. */
  gradedErrorReason?: string;
  /** The graded run carried no reference-access list at all — a run kept before the signal existed, or
   *  one with no observable tool stream. DISTINCT from `noSkillFilesRead === undefined` alone, which is
   *  also how "the skill ships nothing to read" and "the turn-1 result was degraded" are encoded: without
   *  this, a historical `result.json` rendered NO line at all and the reader was left to infer from
   *  silence — the same absence-vs-unknown conflation, one level up. */
  referenceAccessUnobservable?: boolean;
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
  /** WHICH turn failed. The header used to hardcode "(reflection turn)" while the same field also carried
   *  TASK-turn failures — so a task that never ran was reported as a broken reflection, sending a reader
   *  to the wrong turn's artifacts before they had read a word of the reason. Required in practice
   *  wherever `infraFailure` is set. */
  infraFailurePhase?: "task turn" | "reflection turn";
  /** The harness error category (`ErrCategory`) when the failed turn printed a structured error envelope —
   *  "unanswered", "usage", "boundary", … Absent for a genuine crash/kill with no envelope to classify
   *  from, which is the only case that still reads as an infrastructure fault. */
  infraFailureKind?: string;
  /** Mechanical integrity signal from the evaluator's trusted canary — false means that pass stopped
   *  following trusted instructions, so an empty critique may be adversarial silencing, not a clean skill. */
  evaluatorIntegrity?: { pass1Canary: boolean; pass2Canary?: boolean };
  /** Per-pass count of malformed items the evaluator's PER-ITEM-tolerant parse dropped (see
   *  `parseCritiqueItems`). Surfaced in BOTH output formats whenever non-zero — a dropped finding the
   *  report never mentions would be a silent recall loss, the exact shape this tool exists to kill. */
  droppedEvaluatorItems?: { pass1: number; pass2?: number };
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
  /** Evidence-budget accounting. Skill-authored content (SKILL.md + references + every packaged agent md) ships WHOLE;
   *  these fields exist so the consumer never has to read `dist/` to learn what the evaluator was shown —
   *  the previous per-file caps were discoverable only by inspecting compiled source, which cost a real
   *  consumer hours and let 11 of 13 reference files go permanently ungraded without a signal.
   *
   *  `corpusCuts` is empty on every real skill (the ceiling is a sanity valve at ~2.3x the largest observed
   *  skill). `corpusExcluded` names files present on the host that STAGING would not deliver — never in the
   *  agent's mount, therefore never valid evidence, but the author must be told. `trimRecord` names any
   *  section the overall belt-and-suspenders trim shaved, replacing a bare boolean that made transcript
   *  loss undetectable after the fact. */
  /** See `packageEvidence`'s `noSkillFilesRead`. Rendered as an OBSERVATION, never as a verdict. */
  noSkillFilesRead?: boolean;
  evidenceBudget?: {
    corpusBytes: number;
    corpusCeiling: number;
    corpusCuts: Array<{ name: string; keptBytes: number; totalBytes: number; omitted: boolean }>;
    corpusExcluded: string[];
    corpusPackaged?: string[];
    corpusOmitted?: Array<{ name: string; reason: "not-linked" | "not-utf8" | "ambiguous-read" | "unreadable"; alsoUntracked?: boolean }>;
    trimRecord: Array<{ section: string; droppedBytes: number }>;
    packageTruncated: boolean;
  };
}

/** critique's verdict is a SELF-RUN graded by a structurally blinded evaluator — a discovery LEAD, NOT an
 *  independent attestation. The skill under review controls text (its SKILL.md) that enters the evaluator's
 *  prompt, so a crafted skill can steer the grade. That is why the output is a lead to investigate, never
 *  trustworthy proof of a skill's quality or safety — and why it must not gate any skill (this holds whether
 *  you authored the skill or are probing one you did not; see docs/critique.md "Running it on a skill you did
 *  not write"). Stamped on EVERY report so a downstream harvester cannot promote it into an attestation.
 *  DISTINCT from "never a gate / findings exit 0" (that is about not blocking CI on findings; this is about
 *  whether the verdict may be TRUSTED as proof). */
export const VERDICT_PROVENANCE = {
  kind: "self-run",
  advisory: true,
  caveat:
    "Advisory self-critique — a discovery lead, NOT an independent attestation. The skill under review controls text that enters the evaluator's prompt, so a crafted skill can steer the grade; treat the verdict as a lead to investigate, never as trustworthy proof of a skill's quality or safety.",
} as const;

/** Pure report-text builder (no I/O) so it's directly unit-testable. `printTextReport` below just flushes
 *  this to fd 1. */
/** The six corpus fields of `evidenceBudget` — what the packager knows about the SKILL'S OWN text, independent
 *  of any run. `trimRecord` and `packageTruncated` are deliberately NOT here: they describe the package a
 *  graded run produced, and `critique --corpus-only` has no run to describe. */
type CorpusFields = Pick<
  NonNullable<ReportState["evidenceBudget"]>,
  "corpusBytes" | "corpusCeiling" | "corpusCuts" | "corpusExcluded" | "corpusPackaged" | "corpusOmitted"
>;

/** The text lines for the corpus fields, shared by the full report and `--corpus-only`. ONE renderer on
 *  purpose: the preview's promise is "the same answer a critique would give", and two copies of these lines
 *  would let that promise drift silently. The caller supplies the headline because it is the one line whose
 *  tense differs — "packaged WHOLE" on a report, "pre-run floor" on a preview. */
function renderCorpusLines(eb: CorpusFields, headline: string): string[] {
  const out: string[] = [headline];
  for (const c of eb.corpusCuts)
    out.push(
      c.omitted
        ? `  corpus OMITTED ${c.name} (${c.totalBytes.toLocaleString()} B) — its share would be below the minimum useful slice; SPLIT this file`
        : `  corpus CUT ${c.name}: kept ${c.keptBytes.toLocaleString()} of ${c.totalBytes.toLocaleString()} B — the corpus as a whole exceeds the ceiling`,
    );
  // Plugin-root references present in the mount but not packaged. A SEPARATE line from corpusExcluded:
  // these files ARE tracked and WERE delivered, so the "git add them" remedy would be a lie. Rendering
  // them at all is the point of the narrow selection rule — an author who expected a shared file to be
  // graded is told it was not, and why, rather than the omission being silent.
  if (eb.corpusOmitted?.length) {
    const byReason = new Map<string, string[]>();
    for (const o of eb.corpusOmitted) byReason.set(o.reason, [...(byReason.get(o.reason) ?? []), o.name]);
    const explain: Record<string, string> = {
      "not-linked": "this skill's SKILL.md, references/ and sub-agents never point at them",
      "not-utf8": "not valid UTF-8 (a binary asset), so never shown to a text evaluator",
      "ambiguous-read": "read during the run, but the access path cannot distinguish them from a same-named skill-local file",
      unreadable: "resolved but could not be read, so the evaluator got a placeholder instead of the content",
    };
    for (const [reason, names] of [...byReason].sort())
      out.push(`  plugin-root references NOT graded (${explain[reason] ?? reason}): ${names.join(", ")}`);
    // Only files we actually EVALUATED for trackedness. `alsoUntracked` is absent when the tracked set
    // could not be read at all, and printing "also untracked" — or silently not printing it — for an
    // unevaluated file would state a fact nothing established.
    // ONLY the not-linked rows. "git add them as well as linking them" is wrong advice for a `not-utf8`
    // binary (no amount of linking packages it) and for an `ambiguous-read` file (the agent already
    // reached it) — the flag is computed on every reason for the JSON consumer, but this sentence is not
    // true of every reason.
    const alsoUntracked = eb.corpusOmitted.filter((o) => o.reason === "not-linked" && o.alsoUntracked === true).map((o) => o.name);
    if (alsoUntracked.length)
      out.push(
        `  ...and staging would not deliver these anyway (untracked): ${alsoUntracked.join(", ")} — 'git add' them as well as linking them`,
      );
  }
  if (eb.corpusExcluded.length)
    out.push(
      `  NOT graded (staging would not deliver them — untracked): ${eb.corpusExcluded.join(", ")} — 'git add' them to grade as-published`,
    );
  return out;
}

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
  out.push(`critique: ${tildeify(skillFolder)}`);
  out.push(`  probe: ${prompt}`);
  out.push(`  session: ${sessionId}`);
  out.push(`  run dir: ${tildeify(outDir)}`);
  out.push(
    `  fidelity: ${state.fidelity}` +
      (state.requestedFidelity ? ` (resolved from --fidelity ${state.requestedFidelity})` : "") +
      (state.gradedEffectiveFidelity
        ? ` (graded turn recorded ${state.gradedEffectiveFidelity}${state.gradedBaseline ? `, baseline ${state.gradedBaseline}` : ""})`
        : ""),
  );
  const cost = state.costUsd;
  if (cost) {
    const part = (v: number | undefined) => (v === undefined ? "unpriced" : `$${v.toFixed(4)}`);
    // The evaluator SHARE, not just the four parts. Which workload dominates is skill-dependent
    // (evaluator cost is bounded by the evidence package; the task turn is not), and guidance that
    // states one ratio unconditionally misdirects the optimization — so let each run say its own.
    // Only when both passes are priced AND the total is non-zero: a share computed from a partial
    // total would understate it, which is the same misdirection in the other direction.
    const evalUsd =
      cost.evaluatorPass1Usd !== undefined && cost.evaluatorPass2Usd !== undefined
        ? cost.evaluatorPass1Usd + cost.evaluatorPass2Usd
        : undefined;
    const share =
      evalUsd !== undefined && cost.complete && cost.totalUsd > 0 ? ` = ${Math.round((evalUsd / cost.totalUsd) * 100)}% of total` : "";
    out.push(
      `  cost: $${cost.totalUsd.toFixed(4)}${cost.complete ? "" : " (INCOMPLETE — one or more workloads unpriced)"} — ` +
        `task ${part(cost.taskTurnUsd)}, reflection ${part(cost.reflectionTurnUsd)}, ` +
        `evaluator ${part(cost.evaluatorPass1Usd)} + ${part(cost.evaluatorPass2Usd)}${share}`,
    );
  }
  out.push(`  task run result: ${taskResult ?? "unknown (envelope unavailable)"}`);
  // The GRADED turn's facts, so a consumer never opens result.turn-1.json (and never mistakes the
  // reflection turn's result.json for them).
  if (gradedOutcome) out.push(`  graded outcome: ${gradedOutcome}`);
  if (state.gradedSkill)
    out.push(`  graded skill: ${state.gradedSkill} (pair by skillHash + this name — skillHash keys the whole mounted plugin)`);
  if (gradedSkillHash) out.push(`  graded skillHash: ${gradedSkillHash.slice(0, 12)}`);
  // The GRADED turn's model, beside the evaluator's — never one without the other. Naming only the
  // evaluator invited exactly the wrong reading: that the critique was produced under the model the
  // caller had in mind, when the turns are a subprocess that inherits no model from their caller.
  if (state.gradedModels?.length) out.push(`  graded model(s): ${state.gradedModels.join(", ")} (from the graded turn's own result.json)`);
  // No `--model` remediation here: `models` is populated from the model ids on ASSISTANT MESSAGES
  // (run.ts's noteModel), never from the flag. Every case that lands on "unknown" — no result.json at
  // all, no assistant message, marker-only — is unchanged by passing --model, so naming it would send a
  // reader to a lever that cannot move this line.
  else out.push(`  graded model(s): unknown (the graded turn recorded no live model id — no assistant message reached it)`);
  if (evaluatorModel) out.push(`  evaluator model (resolved): ${evaluatorModel}`);
  else if (infraFailure || evaluatorError)
    out.push(`  evaluator model (requested, NOT resolved — evaluator did not complete): ${requestedModel}`);
  if (taskResult === "error")
    out.push(
      `  NOTE: the task run ended in error${state.gradedErrorReason ? ` (${state.gradedErrorReason})` : ""} — ` +
        `recommendations below reflect whatever happened before the failure.`,
    );
  if (state.skillInvocationObserved === false)
    out.push(
      `  NOTE: no observable invocation channel (the main agent's Skill tool calls, a sub-agent's Skill calls, or a staged-skill slash token leading the prompt) names the selected skill — this critique may be grading a run that did not actually invoke it.`,
    );
  if (state.commandShadowsSkill && state.skillInvocationObserved === undefined)
    // Only when the shadow is what withheld the verdict. A `false` alongside a shadow is sound — nothing
    // named the skill by ANY channel — and printing "not decidable" next to "none named it" contradicts.
    out.push(
      `  NOTE: this plugin ships BOTH commands/${state.gradedSkill}.md and skills/${state.gradedSkill}/SKILL.md. They register one identical slash command, the Skill tool launches either through the same registry, and the run does not record which ran — so a positive invocation verdict is not decidable here. Rename one of the two to make it observable.`,
    );
  else if (state.gradedSkill !== undefined && state.skillInvocationObserved === undefined)
    // Absence is a real outcome and must be SAID: without this line "could not observe" read exactly
    // like "not applicable", and a --skill user could not tell which they had. One generic line: the
    // report does not carry WHICH of the five routes to absent fired, so it lists them rather than
    // pretend to know. (Printed on an instrument failure too — the field is absent there for the same
    // reason, no observable record.)
    out.push(
      `  NOTE: whether the graded run invoked ${state.gradedSkill} could NOT be observed — no graded result, or one with no prompt/skill inventory; an unreadable events slice; a top-level Skill call whose id the record could not read; a sub-agent Skill call it cannot name; or a bare slash token more than one staged skill answers to. Not evidence either way.`,
    );
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
  if (skillMdStatus === "untracked")
    out.push(
      `  SKILL.md: present on the host but NOT git-tracked, so staging never delivered it — the agent ran without it. Coverage claims are downgraded to "not adjudicable"; 'git add' it to grade as-published`,
    );
  else if (skillMdStatus && skillMdStatus !== "readable")
    out.push(`  SKILL.md: ${skillMdStatus} — coverage claims were downgraded to "not adjudicable" because SKILL.md could not be read`);
  // Evidence budget. Skill content ships whole, so on a normal run this is one reassuring line; the other
  // branches only fire on a genuinely pathological skill or an untracked-file mistake, and both tell the
  // author what to DO rather than only what happened.
  const eb = state.evidenceBudget;
  if (eb)
    out.push(
      ...renderCorpusLines(
        eb,
        `  evidence corpus: ${eb.corpusBytes.toLocaleString()} B of skill content packaged WHOLE (ceiling ${eb.corpusCeiling.toLocaleString()} B)`,
      ),
    );
  // Three states, and the report must not collapse them: `true` = nothing was Read, `false` = something
  // was, `undefined` = we could not tell (a degraded turn-1 result) or there was nothing to read. Printing
  // a line only for `true` left "could not tell" indistinguishable from "reads happened" — the exact
  // absence-vs-unknown conflation this instrument exists to surface.
  if (state.noSkillFilesRead === undefined && state.turn1ResultDegraded)
    out.push(
      `  whether any references/ or scripts/ file was ACCESSED is UNKNOWN — the graded turn's result was degraded, so treat this as unknown, never as "nothing was read"`,
    );
  else if (state.noSkillFilesRead === undefined && state.referenceAccessUnobservable)
    out.push(
      `  whether any references/ or scripts/ file was ACCESSED is UNKNOWN — this run recorded no reference-access list (a run kept before the signal existed, or one with no observable tool stream), so treat this as unknown, never as "nothing was read"`,
    );
  if (state.noSkillFilesRead) {
    // Says what was OBSERVED, and names the channels it observed. The previous wording ("was Read …
    // counts the Read tool only") invited the reader to conclude the agent opened no reference, when a
    // `Bash cat` or a `Grep` of one was simply invisible to the field it was computed from — and that
    // conclusion is the one a reader acts on. The residual caveat is now short and true rather than
    // load-bearing: a `cd` then a bare relative `cat`, a heredoc, or a $VAR-built path stays invisible
    // by design, so this is weak evidence, never proof the content went unread.
    out.push(
      `  no references/ or scripts/ file was ACCESSED through any observed tool channel during the graded turn — ` +
        `main agent and sub-agents, via Read, Grep, or a Bash command naming the path under the mounted plugin. ` +
        `Under-approximates (a 'cd' then a bare relative cat, a heredoc, or a $VAR-built path is invisible), so treat ` +
        `this as weak evidence of non-use, never proof the content went unread`,
    );
  }
  if (eb) {
    for (const t of eb.trimRecord) out.push(`  overall-cap trim shaved ${t.droppedBytes.toLocaleString()} B from "${t.section}"`);
    // Most often the transcript's head+tail elision — and in that common case `corpusCuts` and `trimRecord`
    // are BOTH empty, so without this line the text report showed only the reassuring "packaged WHOLE" line
    // and an elided package was indistinguishable from a clean one: exactly the gap this flag was added for.
    if (eb.packageTruncated && !eb.corpusCuts.length && !eb.trimRecord.length)
      out.push(
        `  a bounded section was cut (most likely the transcript's head+tail elision) — claims about content past a cut are steered to "not adjudicable", and a finding quoting past-cut text lands in DROPPED`,
      );
  }
  // The dominant real-world cause of a "missing" SKILL.md is pointing critique at a MULTI-SKILL PLUGIN
  // root (skills/<name>/SKILL.md, no root SKILL.md) — name the cause and the fix, not just the symptom.
  if (skillMdStatus === "missing")
    out.push(
      `  NOTE: if ${tildeify(skillFolder)} is a multi-skill plugin root, pass --skill <name> (or, equivalently, point critique at <plugin>/skills/<name>) so the invoked skill's SKILL.md is graded.`,
    );
  out.push(`  verdict scope: advisory self-run — NOT an independent attestation (never gate a skill on it)`);
  out.push("");

  const dropped = state.droppedEvaluatorItems;
  const droppedTotal = dropped ? dropped.pass1 + (dropped.pass2 ?? 0) : 0;
  if (droppedTotal > 0)
    out.push(
      `  evaluator reply: ${droppedTotal} malformed item(s) DROPPED by the per-item-tolerant parse` +
        ` (pass 1: ${dropped!.pass1}${dropped!.pass2 !== undefined ? `, pass 2: ${dropped!.pass2}` : ""}) — ` +
        `the findings below are the surviving items, not necessarily the complete reply.`,
    );

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
    // Two things this header used to get wrong at once, and both sent a reader to the wrong subsystem:
    // the PHASE was hardcoded to "reflection turn" even for task-turn failures, and the CAUSE was
    // "INFRASTRUCTURE/PROTOCOL" even when the harness had already reported an ordinary scenario problem
    // (an unanswered gate, a usage error). Say which turn, and reserve the infrastructure wording for a
    // failure that actually had no structured diagnosis of its own.
    const phase = state.infraFailurePhase ?? "reflection turn";
    const kind = state.infraFailureKind;
    // Gated on WHICH category, never on merely having one: `internal`/`runtime` are the harness's own
    // catch-all for an unexpected throw (Docker down, container start failure, missing staged agent, a
    // harness bug), so treating any category as "ordinary" claims a healthy instrument over a broken one.
    const ordinary = isOrdinaryFailureKind(kind);
    out.push(ordinary ? `RUN FAILED (${phase}, ${kind}): ${infraFailure}` : `INFRASTRUCTURE/PROTOCOL FAILURE (${phase}): ${infraFailure}`);
    out.push(
      `The evaluator was NOT invoked — this is a broken discovery run, not a critique. ` +
        (ordinary ? `Fix the cause named above and re-run` : `Re-run, or inspect ${tildeify(outDir)} directly`) +
        `${ordinary ? `, or inspect ${tildeify(outDir)} directly` : ""}.`,
    );
    return out.join("\n");
  }

  if (evaluatorError) {
    out.push(`EVALUATOR FAILED: ${evaluatorError}`);
    out.push(`No critique items were produced. Re-run, or inspect ${tildeify(outDir)} directly.`);
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
  // WHY the evidence couldn't decide, when the reason is structural rather than genuinely ambiguous.
  // `scripts/` is outside the evaluator's corpus BY DESIGN (it grades authored guidance, not
  // implementation — docs/critique.md), so a claim about a script's behaviour can only ever land here.
  // Without this line the verdict reads as "unproven", and a consumer acted on that reading: a VERIFIED
  // product bug in their own `gate_state.py` was dismissed because the evaluator said not-adjudicable,
  // when what it meant was "I was never shown the file". Names the documented remedy, not just the gap.
  const scriptish = (byBucket.get("not-adjudicable") ?? []).filter(
    (i) => SCRIPT_MENTION.test(i.idea) || SCRIPT_MENTION.test(i.evidence ?? ""),
  );
  if (scriptish.length) {
    out.push(
      `  note: ${scriptish.length} of these reference \`scripts/\` — those files are OUTSIDE the evaluator's corpus by design ` +
        `(it grades authored guidance: SKILL.md, references/**, every agents/**.md the skill dispatches, and the plugin-root references/ files it points at). "not adjudicable" there means the evaluator ` +
        `could not SEE the code, NOT that the claim is false — settle it by reading the script. If a script's contract matters ` +
        `to how the skill is USED, state it in SKILL.md or a references/ file, where the evaluator can grade it.`,
      "",
    );
  }
  section(
    "DROPPED (citation did not resolve)",
    "dropped",
    "NOT validated against the evidence package — shown for transparency only, do not act on these as-is",
  );

  if (items.length === 0) out.push("No findings from either pass.");

  // G2: echo the graded run's resolved gate answers as copy-pasteable flags, so a follow-up run can be
  // made deterministic without digging them out of result.json (mirrors the `skill` lane's footer).
  if (state.gateAnswers?.length) {
    out.push("");
    out.push("To reproduce the graded run's gates deterministically, pass:");
    for (const g of state.gateAnswers)
      out.push(`  --answer ${JSON.stringify(`${g.question}=${g.answer}`)}  # was answered by: ${g.answeredBy}`);
  }
  return out.join("\n");
}

function printTextReport(state: ReportState): void {
  // writeAllSync: flush before the hard exit(0) (async stdout truncates a long report on a pipe past ~64KB)
  writeAllSync(1, buildTextReport(state) + "\n");
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
    fidelity: state.fidelity,
    requestedFidelity: state.requestedFidelity,
    gradedEffectiveFidelity: state.gradedEffectiveFidelity,
    gradedBaseline: state.gradedBaseline,
    costUsd: state.costUsd,
    gradedSkill: state.gradedSkill,
    skillInvocationObserved: state.skillInvocationObserved,
    commandShadowsSkill: state.commandShadowsSkill,
    gateAnswers: state.gateAnswers,
    taskResult,
    // On `base`, not a branch: a harvester reads these on EVERY outcome, including the infra-failure
    // paths where knowing which skill generation was graded matters most.
    gradedOutcome,
    gradedSkillHash,
    gradedModels: state.gradedModels,
    gradedErrorReason: state.gradedErrorReason,
    selfReportStatus,
    evaluatorIntegrity,
    // On `base` for the same reason as evaluatorIntegrity: a reply with dropped items is exactly where
    // the surviving findings under-represent the full reply — every branch must carry the count.
    droppedEvaluatorItems: state.droppedEvaluatorItems,
    turn1ResultDegraded,
    turn1SliceDegraded,
    skillMdStatus,
    evidenceBudget: state.evidenceBudget,
    noSkillFilesRead: state.noSkillFilesRead,
    referenceAccessUnobservable: state.referenceAccessUnobservable || undefined,
    verdictProvenance: VERDICT_PROVENANCE,
  };
  // The phase/kind ride WITH the reason, never separately: a consumer that reads `infraFailure` and not
  // these two gets the same wrong-subsystem diagnosis the text header used to hand a human.
  if (infraFailure)
    return { ...base, infraFailure, infraFailurePhase: state.infraFailurePhase, infraFailureKind: state.infraFailureKind, items: [] };
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

/** Best-effort write of one critique run-dir artifact. Warns on stderr rather than failing the
 *  critique — these are durable convenience copies; stdout remains the authoritative report. */
function writeRunArtifact(outDir: string, name: string, content: string): void {
  try {
    writeFileSync(join(outDir, name), content);
  } catch (e) {
    process.stderr.write(`critique: could not write ${name} under ${tildeify(outDir)}: ${String(e)}\n`);
  }
}

/** Persist the run-dir artifacts every critique leaves behind (all best-effort):
 *   - `critique-report.json` — the machine-readable report, ALWAYS (harvesters read the run dir, not
 *     a shell redirect);
 *   - `critique-evidence-package.txt` — the ARMORED corpus the evaluator graded against, when the
 *     evaluator ran (a disputed finding is re-gradeable offline against the exact record);
 *   - `critique-salvage.json` — on an instrument failure only: the self-report + each pass's RAW reply
 *     (captured pre-parse), so salvage is a file read, not console scraping. */
export function persistCritiqueArtifacts(
  outDir: string,
  state: ReportState,
  evidenceText: string | undefined,
  salvage: { selfReport?: string; rawEvaluatorReplies: Array<{ pass: 1 | 2; raw: string }> },
): void {
  writeRunArtifact(outDir, "critique-report.json", JSON.stringify(buildJsonReport(state), null, 2) + "\n");
  if (evidenceText !== undefined) writeRunArtifact(outDir, "critique-evidence-package.txt", evidenceText);
  if (state.infraFailure || state.evaluatorError)
    writeRunArtifact(
      outDir,
      "critique-salvage.json",
      JSON.stringify(
        {
          infraFailure: state.infraFailure,
          // The phase and kind ride WITH the reason here too. A salvage consumer reading the top-level
          // `infraFailure` and nothing else would otherwise get the bare reason — the same wrong-subsystem
          // reading the report header was fixed for.
          infraFailurePhase: state.infraFailurePhase,
          infraFailureKind: state.infraFailureKind,
          evaluatorError: state.evaluatorError,
          selfReport: salvage.selfReport,
          rawEvaluatorReplies: salvage.rawEvaluatorReplies,
          reportState: buildJsonReport(state),
        },
        null,
        2,
      ) + "\n",
    );
}

/** `--out`: ALSO write the selected-format report to an explicit file. Loud on failure (the user asked
 *  for this file by name) but never changes the exit taxonomy — the stdout report already shipped. */
function writeOutFile(outPath: string, state: ReportState, outputFormat: "json" | "text"): void {
  const content = outputFormat === "json" ? JSON.stringify(buildJsonReport(state)) + "\n" : buildTextReport(state) + "\n";
  try {
    writeFileSync(outPath, content);
  } catch (e) {
    process.stderr.write(`critique: --out ${tildeify(outPath)} could not be written: ${String(e)}\n`);
  }
}

/** A task turn cannot be built without a probe. The only invocation that lacks one (`--corpus-only`)
 *  returns from `main` before this is reached, so a missing prompt here is an internal error — thrown,
 *  not typed away: an intersection type on the parameter made every existing caller that passes a bare
 *  `parseArgs()` result fail to compile, for an invariant the runtime already holds. */
export function buildTaskTurnArgs(opts: ParsedArgs, sessionId: string): string[] {
  if (opts.prompt === undefined || !opts.prompt.trim()) throw new Error("critique: internal — buildTaskTurnArgs called with no probe");
  const dotenvArgs = opts.dotenv ? ["--dotenv", opts.dotenv] : [];
  return [
    ...dotenvArgs,
    "skill",
    opts.skillFolder,
    opts.prompt,
    ...opts.forwardBoth,
    ...opts.forwardTask,
    "--fidelity",
    opts.fidelity,
    "--session-id",
    sessionId,
    "--keep",
    "--output-format",
    "json",
  ];
}

/** Phase progress. Four model calls over 10-20 minutes previously produced ZERO output until the whole
 *  report appeared at once — a working run and a hung one were indistinguishable, and the runs are paid.
 *  stderr ONLY: stdout is the machine channel (`--output-format json`) and must stay parseable. */
function progress(step: 1 | 2 | 3 | 4, what: string): void {
  warn(`::notice:: [critique] ${step}/4 ${what}\n`);
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
    opts.fidelity,
    "--on-unanswered",
    "first",
    "--output-format",
    "json",
  ];
}

/** `critique --corpus-only`: the packager's answer for a skill, with no run behind it.
 *
 *  WHY THE REAL PACKAGER AND NOT A STATIC COUNT. `lint-skill`'s corpus check is a static approximation that
 *  diverges from what a critique actually packages on four measured axes (untracked files it counts and
 *  staging drops; symlinks out of the tree it counts and the walk refuses; `st_size` vs decoded UTF-8
 *  length; and plugin-root references read at run time). It also emits NOTHING below 80% of the ceiling,
 *  so a consumer below that band could not get a number without paying for a critique. This is the same
 *  `packageEvidence` call the graded run makes, over an EMPTY run dir — the packager was built to degrade,
 *  not throw, on missing run artifacts (measured: no writes, no stderr, ~40 ms) — so there is exactly one
 *  derivation of the number, and it is the one the evaluator sees.
 *
 *  WHAT IT CANNOT KNOW. A plugin-root reference the agent READS during the graded turn is added to the corpus
 *  at critique time (resolve-references clause 3). No pre-run instrument can see that read, so the preview's
 *  `corpusBytes` is a FLOOR: a paid run's is equal or larger, and a `corpusOmitted` reason can change
 *  (`not-linked` → `ambiguous-read`). Said in the output rather than left for the reader to discover.
 *
 *  WHAT IT REFUSES — nothing itself: `preflightCritique` has already refused, with a paid critique's own
 *  pre-spend check, every target staging would not deliver or that has no readable SKILL.md, so a preview
 *  that prints a number is a promise the paid run will not die on the target. This renders that check's
 *  packaged result. */
function runCorpusPreview(opts: ParsedArgs, resolved: ResolvedCritiqueTarget, pkg: ReturnType<typeof packageEvidence>): number {
  const corpus: CorpusFields = {
    corpusBytes: pkg.corpusBytes,
    corpusCeiling: pkg.corpusCeiling,
    corpusCuts: pkg.corpusCuts,
    corpusExcluded: pkg.corpusExcluded,
    corpusPackaged: pkg.corpusPackaged,
    corpusOmitted: pkg.corpusOmitted,
  };
  const skill = gradedSkillNameFor(opts.skillSelector, resolved) ?? null;
  const note =
    "lower bound — plugin-root references the agent READS during the graded turn are added at critique time, so a paid run's corpusBytes is >= this";
  if (opts.ignoredFlags.length)
    process.stderr.write(
      `[critique] --corpus-only: ${opts.ignoredFlags.length} run-shaping flag(s) validated but not acted on: ${opts.ignoredFlags.join(", ")}\n`,
    );
  let content: string;
  if (opts.outputFormat === "json") {
    // The standard envelope, not the critique REPORT shape: `tool`/`command` are the discriminator (a
    // report carries neither), and the six-field `corpus` object is a documented SUBSET of a report's
    // `evidenceBudget` — same field names, so a consumer reading `evidenceBudget.corpusBytes` off a report
    // reads `corpus.corpusBytes` here with the same code and the same meaning.
    content =
      jsonPayloadEnvelope("critique", true, {
        mode: "corpus-only",
        // Raw paths by machine-capture contract — the full JSON report keeps `skillFolder` raw too, and a
        // consumer resolving `~/…` gets `<cwd>/~/…`. `tildeify` is a display formatter for text and stderr.
        skillFolder: opts.skillFolder,
        skillDir: resolved.skillDir,
        skill,
        corpus,
        ignoredFlags: opts.ignoredFlags,
        note,
      }) + "\n";
  } else {
    const pct = ((corpus.corpusBytes * 100) / corpus.corpusCeiling).toFixed(1);
    content =
      [
        `critique --corpus-only  ${tildeify(resolved.skillDir)}${skill ? `  (--skill ${skill})` : ""}`,
        ...renderCorpusLines(
          corpus,
          `  evidence corpus (pre-run FLOOR): ${corpus.corpusBytes.toLocaleString()} B = ${pct}% of the ${corpus.corpusCeiling.toLocaleString()} B ceiling`,
        ),
        `  packaged: ${corpus.corpusPackaged?.length ?? 0} file(s)`,
        `  ${note}`,
      ].join("\n") + "\n";
  }
  writeAllSync(1, content);
  if (opts.out) {
    try {
      writeFileSync(opts.out, content);
    } catch (e) {
      process.stderr.write(`critique: --out ${tildeify(opts.out)} could not be written: ${String(e)}\n`);
    }
  }
  return 0;
}

/** The skill whose invocation the advisory checks, or undefined when there is no single named skill to
 *  check (a plain skill folder). `--skill` wins; otherwise the resolver's own answer — ONE derivation,
 *  shared with the `--corpus-only` preview's `skill` field. Inferring it here from `pluginRoot !==
 *  skillDir` stopped working the moment the fallback shape-2 mount made the two equal. */
export function gradedSkillNameFor(
  skillSelector: string | undefined,
  resolved: Pick<ResolvedCritiqueTarget, "gradedSkillName">,
): string | undefined {
  return skillSelector ?? resolved.gradedSkillName;
}

/** A plugin shipping BOTH commands/<n>.md and skills/<n>/SKILL.md registers ONE identical slash command,
 *  and the `Skill` tool launches either through the same registry; the run records the name, not the
 *  kind (vercel@0.48.0 does exactly this). That makes EVERY channel undecidable for this skill — a match
 *  is reported absent, never true. */
export function commandShadowsSkillFor(
  gradedSkillName: string | undefined,
  resolved: Pick<ReturnType<typeof resolveCritiquedSkillDir>, "pluginRoot">,
): boolean {
  return (
    gradedSkillName !== undefined &&
    resolved.pluginRoot !== undefined &&
    existsSync(join(resolved.pluginRoot, "commands", `${gradedSkillName}.md`))
  );
}

/** critique's `skillInvocationObserved`, computed from a graded run's on-disk record. Extracted from
 *  `main` so it can be exercised over a real result.json + events.jsonl + plugin tree without a run —
 *  every earlier test sat at the function boundary below this, and the defect that motivated the
 *  extraction (the qualifier read from the wrong manifest) lived exactly in this wiring. */
export function computeSkillInvocationVerdict(args: {
  outDir: string;
  boundary: TurnBoundary;
  taskRaw: Record<string, unknown> | null;
  resolved: Pick<ReturnType<typeof resolveCritiquedSkillDir>, "skillDir" | "pluginRoot" | "autoSelectedSkill">;
  gradedSkillName: string | undefined;
}): boolean | undefined {
  const { outDir, boundary, taskRaw, resolved, gradedSkillName } = args;
  if (gradedSkillName === undefined) return undefined;
  // The qualifier a plugin-qualified observed id must carry to count — derived the way the BINARY
  // derives it (`.claude-plugin/plugin.json#name`, else the directory basename; a root `plugin.json` is
  // ignored), not via `readPluginName`, whose root-`plugin.json` leniency made a fully-invoked
  // `rootpj-dir:qux` run read as never invoked. Without the qualifier a same-named skill from ANOTHER
  // installed plugin (present in the inventory at hostloop/protocol) would satisfy the match.
  const gradedPluginName = resolved.pluginRoot !== undefined ? binaryPluginIdentity(resolved.pluginRoot).name : undefined;
  const subagentSkills = (() => {
    try {
      return subagentSkillCalls(readTurn1Slice(outDir, "events.jsonl", boundary));
    } catch {
      return undefined; // unreadable = unobservable, never "no sub-agent ran a skill"
    }
  })();
  return observedSkillInvocation(
    gradedSkillName,
    gradedPluginName,
    taskRaw?.skillActivity as Array<{ skillId?: unknown }> | undefined,
    subagentSkills,
    slashCommandSkillInvocation(
      typeof taskRaw?.prompt === "string" ? taskRaw.prompt : undefined,
      (taskRaw?.context as { availableSkills?: Array<{ id: string }> } | undefined)?.availableSkills,
    ),
    commandShadowsSkillFor(gradedSkillName, resolved),
  );
}

async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    writeAllSync(1, usage() + "\n");
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
  // Announce a resolved `cowork` the same way `executeScenario` does, in the same shape and to the same
  // stream, so an operator reading a critique's stderr sees the tier decision in the form they already
  // know from a plain run — and so the resolution is on the record when the report is read later.
  // A bare stderr line, NOT `warn()`: that helper prefixes `::warning::`, which would annotate every
  // cowork critique in CI as a problem. This is a routine resolution, not a fault.
  if (opts.requestedFidelity === "cowork" && !opts.corpusOnly)
    process.stderr.write(`[loop] cowork → ${opts.fidelity} (per gate 1143815894)\n`);

  // A skill inside a plugin is critiqued the way Cowork runs it: as part of its plugin. Reassigns `opts`
  // itself — every consumer below reads this one binding.
  opts = applyTargetPromotion(opts);

  // Resolve which folder the PACKAGER grades — fail-fast (usage error, exit 2) BEFORE any model spend:
  // a multi-skill plugin root with no --skill would burn four workloads to produce a critique whose every
  // coverage finding is "not adjudicable".
  let resolvedSkill: ReturnType<typeof resolveCritiquedSkillDir>;
  try {
    resolvedSkill = resolveCritiquedSkillDir(opts.skillFolder, opts.skillSelector);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(2);
    return;
  }
  if (resolvedSkill.autoSelectedSkill)
    process.stderr.write(
      `::notice:: [critique] ${tildeify(opts.skillFolder)} is a single-skill plugin — ${opts.corpusOnly ? "measuring" : "grading"} skills/${resolvedSkill.autoSelectedSkill}/SKILL.md (pass --skill to be explicit)\n`,
    );

  // Refuse, before any spend, a target staging would not deliver or that has no readable SKILL.md — the
  // same check for the preview and a paid run, so `--corpus-only` greening a target means a critique of it
  // will not die on it after paying for two turns.
  const preflight = preflightCritique(resolvedSkill, opts.corpusOnly ? "preview" : "preflight");
  if (!preflight.ok) {
    process.stderr.write(`critique${opts.corpusOnly ? " --corpus-only" : ""}: ${preflight.message}\n`);
    process.exit(2);
    return;
  }

  // --corpus-only stops HERE: after target resolution and the pre-spend check, and before a session id is
  // minted — nothing under --run-dir, no index row, no spawn.
  if (opts.corpusOnly) {
    process.exit(runCorpusPreview(opts, resolvedSkill, preflight.pkg));
    return;
  }
  // Past this point a turn WILL run. parseArgs guarantees a probe on every non-corpus-only line; the
  // narrowing is for the type, not a second validation.
  const prompt = opts.prompt;
  if (prompt === undefined || !prompt.trim()) {
    process.stderr.write(`critique: internal — no probe on a spending invocation\n`);
    process.exit(2);
    return;
  }

  // Minted from the SHARED constant the index detector matches on — see `critiqueRoleFor`.
  const sessionId = `${CRITIQUE_SESSION_PREFIX}${randomUUID()}`;

  try {
    // 1. Task turn.
    // Stretch critique's own kill-switch past a forwarded --timeout: otherwise a longer budget would be
    // killed by the INSTRUMENT and misreported as an infra failure rather than a gradeable timeout. The
    // +60s covers staging and container start — not principled, and a cold image pull can exceed it.
    progress(1, "task turn (running the skill under test — this is the graded run)");
    const task = await runSkillTurn(
      buildTaskTurnArgs(opts, sessionId),
      opts.taskTimeoutMs ? Math.max(TURN_TIMEOUT_MS, opts.taskTimeoutMs + 60_000) : TURN_TIMEOUT_MS,
    );
    const outDir = extractOutDir(task);
    if (!outDir) {
      // F36: surface WHY there's no envelope/status line when it was the bounded spawn itself that gave up.
      const diag = [
        task.timedOut && "task turn timed out (pass --timeout <ms> to raise the budget)",
        task.truncated && "task turn output exceeded the byte cap",
      ]
        .filter(Boolean)
        .join("; ");
      process.stderr.write(
        `critique: could not determine the task run's directory (no envelope outDir and no [status] line)${diag ? ` [${diag}]` : ""}.\n` +
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
        prompt,
        sessionId,
        outDir,
        fidelity: opts.fidelity,
        requestedFidelity: opts.requestedFidelity,
        taskResult: undefined,
        selfReportStatus: "unavailable",
        items: [],
        requestedModel: opts.evaluatorModel ?? DEFAULT_EVALUATOR_MODEL,
        infraFailure: taskInfra.reason,
        infraFailurePhase: "task turn",
        infraFailureKind: taskInfra.kind,
        gradedModels: readGradedModels(outDir),
      };
      if (opts.outputFormat === "json") writeAllSync(1, JSON.stringify(buildJsonReport(state)) + "\n");
      else printTextReport(state);
      // Salvage what exists even for a killed task turn: the report itself, structurally on disk.
      persistCritiqueArtifacts(outDir, state, undefined, { rawEvaluatorReplies: [] });
      if (opts.out) writeOutFile(opts.out, state, opts.outputFormat);
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

    // Best-effort lift of the graded turn's own recorded tier/baseline/cost from turns/1/result.json —
    // written by the time the task turn's envelope printed, same source writeGradedAliases copies. Every
    // field defensive: an absent/odd result degrades to "unknown"/unpriced, never a throw.
    const taskRaw = readTurn1Result(outDir) as Record<string, unknown> | null;
    const gradedEffectiveFidelity = typeof taskRaw?.effectiveFidelity === "string" ? taskRaw.effectiveFidelity : undefined;
    const taskFp = taskRaw?.fingerprint as { baseline?: unknown } | undefined;
    const gradedBaseline = typeof taskFp?.baseline === "string" ? taskFp.baseline : undefined;
    const taskTurnUsd = sumCostUsd(taskRaw?.modelUsage);
    // WHICH model produced the graded behaviour — read back from the run's own record, never assumed from
    // the caller's context. `<…>`-wrapped entries are the agent's locally-fabricated turns, not answerers.
    const gradedModels = readGradedModels(outDir, taskRaw);
    // Why an errored graded turn errored — same helper as the reflection turn's, read off the same
    // envelope. A quota exhaustion and a skill defect both render as `result:"error"` otherwise.
    const gradedErrorReason = taskResult === "error" ? resultRowDiagnosis(task)?.text : undefined;
    // Graded-run validity (advisory): when a specific plugin skill was selected, check the run's own
    // skillActivity actually names it — packaging can be perfectly plugin-aware and still be grading a
    // run that never invoked the selected skill. `undefined` = not applicable (plain skill folder) or
    // no evidence either way (absent result).
    const gradedSkillName = gradedSkillNameFor(opts.skillSelector, resolvedSkill);
    const commandShadowsSkill = commandShadowsSkillFor(gradedSkillName, resolvedSkill);
    // NOTE: the verdict itself is computed after `snapshotTurnBoundary` below — it needs the turn-1
    // events slice, which does not exist until the boundary is captured.
    // Resolved gate answers, lifted for the reproduce-deterministically echo (the `skill` lane already
    // does this in its footer; critique's report gets the same courtesy). Defensive over the raw shape.
    const gpGates = (taskRaw?.gateProvenance as { gates?: unknown } | undefined)?.gates;
    const gateAnswers = Array.isArray(gpGates)
      ? gpGates
          .filter(
            (g): g is { question: string; answer: string; answeredBy: string } =>
              !!g &&
              typeof g === "object" &&
              typeof (g as Record<string, unknown>).question === "string" &&
              typeof (g as Record<string, unknown>).answer === "string" &&
              typeof (g as Record<string, unknown>).answeredBy === "string",
          )
          .map((g) => ({ question: g.question, answer: g.answer, answeredBy: g.answeredBy }))
      : undefined;

    // Stable-named copy of the GRADED turn's result, written HERE — while `result.json` is still turn 1
    // and before the reflection turn's resume renames it to `result.turn-1.json`. Writing it at this point
    // (rather than copying the archived file afterwards) also means it survives a reflection turn that
    // never completes. Best-effort: a missing/unreadable result must never fail a critique that otherwise
    // ran, so this is deliberately swallowed.
    writeGradedAliases(outDir);

    // 2. Snapshot the turn-1/turn-2 boundary BEFORE the reflection turn touches anything.
    const boundary = snapshotTurnBoundary(outDir);

    // Graded-run validity (advisory), now that the turn-1 timeline slice is available. Three channels,
    // and the ABSENCE of a verdict is a real outcome: a run whose invocation we cannot observe must
    // never be reported as one that did not invoke.
    const skillInvocationObserved = computeSkillInvocationVerdict({ outDir, boundary, taskRaw, resolved: resolvedSkill, gradedSkillName });

    // 3. Reflection turn: resume the SAME session.
    // The reflection turn keeps the FIXED default budget deliberately (a forwarded --timeout stretches
    // only the task turn): it is a single Q&A resume with no tool fan-out, so a reflection that needs
    // more than the default is itself an anomaly worth failing loud on, not accommodating.
    progress(2, "reflection turn (resuming the graded session to collect the agent's self-report)");
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
    let droppedEvaluatorItems: { pass1: number; pass2?: number } | undefined;
    let evaluatorError: string | undefined;
    let infraFailure: string | undefined;
    let infraFailurePhase: "task turn" | "reflection turn" | undefined;
    let infraFailureKind: string | undefined;
    let evaluatorModel: string | undefined;
    let selfReportStatus: SelfReportStatus = "unavailable";
    let turn1ResultDegraded: boolean | undefined;
    let turn1SliceDegraded: boolean | undefined;
    let skillMdStatus: SkillMdStatus | undefined;
    let evidenceBudget: ReportState["evidenceBudget"];
    let noSkillFilesRead: boolean | undefined;
    let referenceAccessUnobservable: boolean | undefined;
    // Salvage/cost/evidence capture — populated by the evaluator's callbacks (raw replies land here
    // BEFORE parsing, so a parse throw cannot lose them) and by the per-turn result reads.
    let evidenceText: string | undefined;
    const rawEvaluatorReplies: Array<{ pass: 1 | 2; raw: string }> = [];
    let evaluatorPass1Usd: number | undefined;
    let evaluatorPass2Usd: number | undefined;
    let evaluatorPass1Tokens: EvaluatorTokens | undefined;
    let evaluatorPass2Tokens: EvaluatorTokens | undefined;
    let reflectionTurnUsd: number | undefined;
    let salvageSelfReport: string | undefined;

    if (!reflectionValidation.ok) {
      infraFailure = reflectionValidation.reason;
      infraFailurePhase = "reflection turn";
      infraFailureKind = reflectionValidation.kind;
      // Per this tool's contract (a discovery instrument, never a gate) the defect is REPORTED, not thrown —
      // main() then exits 2 (no critique was produced). The evaluator is deliberately never invoked.
    } else {
      // Reflection turn cost (best-effort, same posture as the task turn's read above).
      try {
        const r2 = JSON.parse(readFileSync(turnArtifactPath(outDir, 2, "result.json"), "utf8")) as Record<string, unknown>;
        reflectionTurnUsd = sumCostUsd(r2.modelUsage);
      } catch {
        /* unpriced */
      }
      // F38: `selfReport` is `undefined` (never a placeholder string) when the reflection turn produced no
      // finalMessage — `runCritique` skips pass 2 entirely in that case; the typed `selfReportStatus` below
      // is what carries "no self-report" into both output formats.
      const selfReport = extractFinalMessage(reflect);
      salvageSelfReport = selfReport;
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
        corpusBytes: cb,
        corpusCeiling: cc,
        corpusCuts: ccuts,
        corpusExcluded: cex,
        corpusPackaged: cpk,
        corpusOmitted: com,
        trimRecord: tr,
        packageTruncated: pt,
        noSkillFilesRead: nofr,
        referenceAccessUnobservable: rau,
      } = packageEvidence(outDir, boundary, resolvedSkill.skillDir, true, {
        agents: resolvedSkill.agents,
        pluginRoot: resolvedSkill.pluginRoot,
        mountRoot: resolvedSkill.mountRoot,
      });
      turn1ResultDegraded = trd;
      turn1SliceDegraded = tsd;
      skillMdStatus = sms;
      evidenceBudget = {
        corpusBytes: cb,
        corpusCeiling: cc,
        corpusCuts: ccuts,
        corpusExcluded: cex,
        corpusPackaged: cpk,
        corpusOmitted: com,
        trimRecord: tr,
        packageTruncated: pt,
      };
      noSkillFilesRead = nofr;
      referenceAccessUnobservable = rau;
      // The agent was never given these, so the evaluator must not be either — but silence would let an
      // author believe their grade covered a file it never saw.
      if (cex.length)
        warn(
          `::warning:: [critique] ${cex.length} skill file(s) excluded from the evidence because staging would not deliver them ` +
            `(untracked; real Cowork sees committed files only): ${cex.join(", ")}. 'git add' them to grade as-published.\n`,
        );
      progress(3, "evaluator pass 1 (blinded: grades the run record with no sight of the self-report)");
      try {
        items = await runCritique(sections, selfReport, {
          onEvaluatorIntegrity: (i) => {
            evaluatorIntegrity = i;
          },
          onDroppedItems: (d) => {
            droppedEvaluatorItems = d;
          },
          onArmoredEvidence: (t) => {
            evidenceText = t;
          },
          onRawReply: (pass, raw) => {
            rawEvaluatorReplies.push({ pass, raw });
          },
          onPass2Start: () => progress(4, "evaluator pass 2 (grades the self-report against pass 1's findings)"),
          onUsage: (pass, usage) => {
            if (pass === 1) {
              evaluatorPass1Usd = sumCostUsd(usage);
              evaluatorPass1Tokens = sumTokens(usage);
            } else {
              evaluatorPass2Usd = sumCostUsd(usage);
              evaluatorPass2Tokens = sumTokens(usage);
            }
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

    // 5. Report. Cost rollup first: total over whatever workloads were priceable, with `complete`
    // marking whether that is genuinely all four — a partial sum must never masquerade as the full spend.
    const costParts = [taskTurnUsd, reflectionTurnUsd, evaluatorPass1Usd, evaluatorPass2Usd];
    const priced = costParts.filter((p): p is number => p !== undefined);
    const costUsd: CritiqueCost | undefined = priced.length
      ? {
          taskTurnUsd,
          reflectionTurnUsd,
          evaluatorPass1Usd,
          evaluatorPass2Usd,
          evaluatorPass1Tokens,
          evaluatorPass2Tokens,
          totalUsd: priced.reduce((a, b) => a + b, 0),
          complete: priced.length === costParts.length,
        }
      : undefined;
    // One roll-up row carrying the WHOLE critique's spend. The two graded turns each wrote their own row via
    // the inner `skill` runs, but the two evaluator passes are direct API calls that produce no run and
    // therefore no row — so anything summing the index missed them entirely (~39% light, measured). Written
    // best-effort: an index-write failure must never sink a critique that otherwise completed and whose
    // report is about to be printed.
    try {
      appendCritiqueRollupRow(runsWriteRoot(), {
        outDir,
        // Both from the GRADED turn's own result, not re-derived: `runLabel` in particular is not on
        // critique's ParsedArgs at all (`--label` is forwarded to the task turn, deliberately not to the
        // reflection turn), so the turn-1 result is the only place its resolved value exists.
        scenario: typeof taskRaw?.scenario === "string" ? taskRaw.scenario : `skill-${basename(opts.skillFolder)}`,
        fidelity: opts.fidelity,
        effectiveFidelity: gradedEffectiveFidelity,
        baseline: gradedBaseline ?? "unknown",
        totalUsd: costUsd?.totalUsd,
        evaluatorUsd:
          evaluatorPass1Usd !== undefined || evaluatorPass2Usd !== undefined
            ? (evaluatorPass1Usd ?? 0) + (evaluatorPass2Usd ?? 0)
            : undefined,
        complete: costUsd?.complete ?? false,
        runLabel: typeof taskRaw?.runLabel === "string" ? taskRaw.runLabel : undefined,
        skill: gradedSkillName,
        skillHash: gradedSkillHash,
      });
    } catch (err) {
      warn(
        `::warning:: [critique] could not append the cost roll-up row to the run index: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    const state: ReportState = {
      skillFolder: opts.skillFolder,
      prompt,
      sessionId,
      outDir,
      fidelity: opts.fidelity,
      requestedFidelity: opts.requestedFidelity,
      gradedEffectiveFidelity,
      gradedBaseline,
      costUsd,
      gradedSkill: gradedSkillName,
      skillInvocationObserved,
      commandShadowsSkill: commandShadowsSkill || undefined,
      gateAnswers: gateAnswers?.length ? gateAnswers : undefined,
      taskResult,
      gradedOutcome,
      gradedSkillHash,
      gradedModels,
      gradedErrorReason,
      selfReportStatus,
      items,
      evaluatorModel,
      requestedModel,
      evaluatorError,
      infraFailure,
      infraFailurePhase,
      infraFailureKind,
      evaluatorIntegrity,
      droppedEvaluatorItems,
      turn1ResultDegraded,
      turn1SliceDegraded,
      skillMdStatus,
      evidenceBudget,
      noSkillFilesRead,
      referenceAccessUnobservable,
    };
    if (opts.outputFormat === "json") {
      // writeAllSync: a long JSON report piped to `jq` truncates past the ~64KB buffer with async write + exit(0)
      writeAllSync(1, JSON.stringify(buildJsonReport(state)) + "\n");
    } else {
      printTextReport(state);
    }
    // Durable run-dir artifacts on EVERY outcome (report always; evidence when the evaluator ran;
    // salvage on instrument failure), plus the explicit --out copy when requested.
    persistCritiqueArtifacts(outDir, state, evidenceText, { selfReport: salvageSelfReport, rawEvaluatorReplies });
    if (opts.out) writeOutFile(opts.out, state, opts.outputFormat);
    // A reflection-protocol break or an evaluator failure reaches HERE, not the early returns above —
    // the report is still printed (it carries the diagnosis), but no critique was produced, so this is an
    // instrument failure, not a finding. Missing this path is what made the documented exit contract
    // false in practice even after the other three were routed.
    if (state.infraFailure || state.evaluatorError) process.exit(EXIT_INSTRUMENT_FAILURE);
  } catch (e) {
    process.stderr.write(`critique: unexpected failure: ${(e as Error).stack ?? String(e)}\n`);
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
