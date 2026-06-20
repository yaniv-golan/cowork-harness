#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, writeSync, existsSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { Scenario, AnswerRule, Assertion, type RunResult } from "./types.js";
import { loadBaseline, BASELINES_DIR, cmpVersionStrings } from "./baseline.js";
import { loadSession, resolveSessionPaths } from "./session.js";
import { executeScenario, parseScenarioFile, UnansweredError, BoundaryError, type ExecuteOptions } from "./run/execute.js";
import { ScriptedDecider, ExternalDecider, LlmDecider, ABSTAIN, coerceLabel, type OnUnanswered } from "./decide/decider.js";
import { claudeCliComplete } from "./decide/llm-transport.js";
import type { DecisionRequest } from "./agent/session.js";
import { vmInit, vmDelete, vmStatus, vmPrune, instanceName } from "./runtime/lima.js";
import { sync } from "./sync/cowork-sync.js";
import { runBoundaryChecks, formatBoundary } from "./boundary.js";
import { cmdChat } from "./run/chat.js";
import { cmdRecord, cmdReplay, cmdVerifyCassettes, cmdRehash } from "./run/cassette.js";
import { cmdRunsGc } from "./run/runs-gc.js";
import { resolveInputs } from "./run/inputs.js";
import { cmdLint } from "./run/scenario-tool.js";
import { cmdDoctor } from "./run/doctor.js";
import { parseArgs } from "./cli-args.js";
import { loadDotenv } from "./dotenv.js";
import { makeRenderer, renderStart, renderFooter, startHeartbeat, type RenderPlan } from "./run/renderer.js";
import {
  resolveEventsFile,
  buildTrace,
  formatTrace,
  buildGateTrace,
  formatGateTrace,
  buildDispatchTree,
  formatDispatchTree,
  noteRunsLocation,
} from "./run/trace-view.js";
import { buildScaffold } from "./run/scaffold.js";
import { pkgVersion, jsonEnvelope, jsonError, parseOutputFormat, type ErrCategory } from "./run/envelope.js";
import { computeVerdict } from "./run/verdict.js";
import { evaluate, hostMatches, type AssertContext } from "./assert.js";
import { spawnChannel, fileChannel, streamGates, answerGate, readGate, type DecisionChannel } from "./decide/external-channel.js";

// Synchronous writes (fd 1/2): `process.stdout.write` + `process.exit()` truncates on a PIPE, which
// would lose the json envelope for any agent/CI that pipes us. writeSync flushes before exit.
const out = (s: string) => writeSync(1, s + "\n"); // machine (stdout)
const log = (s: string) => writeSync(2, s + "\n"); // human (stderr)

const HELP = `cowork-harness <command>   (v${"$VERSION"})

── Interactive / exploratory ──────────────────────────────────────────────────
  skill <folder> "<prompt>"    test a LOCAL skill folder directly (copied fresh each run)
      [--prompt-file <path>]   read the prompt verbatim from a file (bypasses the shell — no $-expansion)
      [--fidelity protocol|container|microvm|hostloop|cowork]  (default: container; $COWORK_HARNESS_FIDELITY)
      [--plugin <dir>]… [--marketplace <dir> --enable name@mkt]   extra plugin/marketplace sources
      [--answer "<question-regex>=<choice>"]   scripted AskUserQuestion answer (repeatable)
      [--on-unanswered fail|prompt|first]  policy for unscripted questions (default: adaptive — prompt on TTY, fail in CI)
      [--decider-llm [--intent "…"]]   answer LIVE questions with a model (state test intent in one line)
      [--decider-cmd '<helper>']   …or via a spawned helper; see 'skill --help'
      [--decider-dir <dir>]   …or in-band from the driving agent; then use 'gates'/'answer' to stream/respond
      [--upload <file>]… [--folder <dir>]…   attach files / connect folders (mnt/uploads, mnt/.projects)
      [--session-id <id> [--resume]]   pin + resume a session (for gated, checkpoint-and-resume skills)
      [--output-format text|json] [--quiet|-q] [--verbose|-V] [--model <id>] [--keep] [--dry-run]
      (run 'skill --help' for the full flag reference)

  chat <folder>                interactive multi-turn REPL against a skill (TTY); --raw for native cowork
                               (--fidelity container|hostloop only, default container; --model <id>)

── Automated scenarios ────────────────────────────────────────────────────────
  run <scenario.yaml | dir/>   run one scenario or every *.yaml in a dir (CI-ready exit code)
      [--on-unanswered fail|first]   ('prompt' rejected — breaks determinism)
      [--decider-cmd '<helper>']   answer live questions via a spawned helper
      [--decider-dir <dir>]   answer live questions in-band; then use 'gates'/'answer' to stream/respond
      [--output-format text|json] [--quiet|-q] [--verbose|-V]
      (run 'run --help' for the full flag reference)

── Cassette lifecycle ─────────────────────────────────────────────────────────
  record <scenario.yaml>       run + save a control-protocol cassette
      [--out <file>]           cassette path (default: cassettes/<scenario-name>.cassette.json)
      [--max-artifact-bytes <n>]  inline-body cap (default 65536 / $COWORK_HARNESS_MAX_ARTIFACT_BYTES)
  replay <file|dir>            deterministic protocol-replay of a cassette or a dir of them (no token, no Docker)
      [--strict]               fail (exit 1) on a stale cassette instead of warning
      [--output-format json]
  verify-cassettes <file|dir>  CI gate (no token): privacy scan + staleness — exit 1 on finding or drift
      [--skip-privacy|--skip-staleness]  skip one check
      [--allow <regex>]... [--allow-domain/-email <regex>]... [--allow-file <path>]... [--output-format json]
  rehash <dir/>                migrate cassette fingerprints to current version when content is provably unchanged (requires contentSig from v3+)
  runs gc [--keep-last <n>]    prune accumulated run dirs, keeping N most recent per scenario (default: 5)

── CI lint + assertion reference ──────────────────────────────────────────────
  lint <scenario.yaml>…        check scenarios for silent false-greens (bundled scenario.py; needs python3 + PyYAML)
      [--strict]               escalate cassette-staleness warning to failure
      NOTE: exit 127 (python3/PyYAML missing) must be treated as failure in CI — do not swallow it.
  assertions --list            list available scenario assertions (generated from Zod schema)
      [--output-format json]

── Debugging / inspection ─────────────────────────────────────────────────────
  trace <run-id | dir | path>  digest a run's events.jsonl (tools+result status, dispatches, decisions)
      [--view tools|questions|dispatches]   focus on one view (default: all); see 'trace --help'
      [--output-format json]   structured rows
  verify-run <run-dir> <scenario.yaml>   re-evaluate assert: against a kept run dir (no live agent, ~1s)
      [--output-format json]
  scaffold <run-id | run-dir>  turn a kept run into a starter scenario YAML (gates→answers, artifacts→file_exists)
      [--out <file.yaml>]      write to a file (default: stdout)

── In-band gate plumbing (for --decider-dir) ─────────────────────────────────
  gates <dir> [--follow]       stream pending gates as JSON lines + terminal {"done":true}; arm a Monitor here
  answer <dir> --gate <N>      answer an in-band gate (atomic write): --choose <label> | --answer "q=c"
                               (repeat --choose for a multiSelect gate)

── Decider testing ────────────────────────────────────────────────────────────
  decide                       fire a sample question through your configured decider (~2s, no run)
      (--decider-cmd '<helper>' | --decider-llm [--intent …] | --answer "rx=c" | --answer-policy <yaml>)
      [--question "<text>"] [--option <label>]…   override the sample question

── Platform admin ─────────────────────────────────────────────────────────────
  sync [--diff] [--allow-empty|--force]  derive/refresh a platform baseline from the live Desktop install (macOS only)
  list                         list available platform baselines
  boundary-check [baseline]    prove the sandbox enforces Cowork's limitations
  vm <init|status|delete|prune>  manage the L2 Apple-VZ microVM (fidelity: microvm); macOS arm64 only
  doctor [--tier <tier>]       read-only prerequisite check (Docker, staged agent, token, baseline)

  Global:  --dotenv <path>     load a .env before the command (host-side creds; never mounted).
           Auth resolves from process.env > --dotenv > ./.env > <install>/.env.
           Run 'doctor' to diagnose auth failures.
  Global:  --run-dir <path>    write runs/ output under <path> instead of the default ~/.cowork-harness/runs
           (keeps sensitive inputs/outputs out of the working tree). flag > COWORK_HARNESS_RUNS_DIR > default.
  --version                    print version        --help, -h    print this help

  Env-var defaults (CLI flags take precedence):
    COWORK_HARNESS_FIDELITY        default --fidelity tier (skill/run/chat)
    COWORK_HARNESS_OUTPUT_FORMAT   default --output-format (text|json)
    COWORK_HARNESS_MODEL           default --model
    NO_COLOR=1                     disable ANSI output`;

const SKILL_HELP = `cowork-harness skill <plugin-folder> "<prompt>"

  Run a LOCAL skill/plugin folder against the staged Cowork agent. The folder is copied fresh into the
  session on every run — no install, marketplace registration, or version bump.

Source (at least one):
  <plugin-folder>                  dir containing .claude-plugin/plugin.json
  --plugin <dir>                   extra plugin source (repeatable)
  --marketplace <dir> --enable name@mkt    load skills via a marketplace.json

Files (for skills that need an attached file, e.g. deck-review):
  --upload <path>                  mount a file at mnt/uploads/<name> — the "attach a file" path (repeatable)
  --folder <dir>                   mount a folder at mnt/.projects/<id> — a connected repo/space (repeatable)

Session persistence (for gated skills that checkpoint + resume):
  --session-id <id>                pin a stable session (persists the work dir + the agent's session)
  --resume                         continue a prior --session-id session (reuses its work dir, so any
                                   skill-written checkpoint state + outputs survive; passes the agent's
                                   native --resume so it reloads the conversation)

Prompt (one of):
  "<prompt>"                       inline — MIND SHELL EXPANSION: a literal $ in double quotes is
                                   eaten by the shell. Single-quote it, or use --prompt-file.
  --prompt-file <path>             read the prompt verbatim from a file (raw bytes; no shell parsing)

Fidelity  --fidelity <tier>       (default: container)
  protocol    L0 — no sandbox, control protocol only
  container   L1 — Docker + per-run default-deny egress proxy (CI-native; fast)
  microvm     L2 — Apple-VZ Lima microVM + guest firewall
  hostloop    Cowork's production split-execution (file tools on host, shell/web via the workspace MCP)
  cowork      auto-pick host-loop vs container the way real Cowork does (via the synced gate)

Questions:
  --answer "<q-regex>=<choice>"    pre-answer a matching AskUserQuestion (repeatable)
  --answer-policy <yaml>           a reusable file of the same regex→choice rules (a bare list, or an
                                   {answers: [...]} doc) — for skills with several known gates
  --on-unanswered <policy>         what to do with an UNscripted question (default: adaptive)
      fail     error + print the exact --answer to add (default when piped / CI)
      prompt   ask at the TTY (default when a human is attached)
      first    pick option 1, loudly warn — then the footer prints the --answer to lock it in
      (the footer always echoes auto-answered questions as copy-pasteable --answer lines)
      (to answer LIVE questions, use --decider-llm / --decider-cmd / --decider-dir below)
  --decider-llm [--intent "<one line>"]   answer LIVE questions with a small model (the ergonomic
                                   default for agent-driven runs: state the test's intent once instead of
                                   writing a helper). Picks an option by label per question; an out-of-set
                                   answer FAILS LOUD. NON-deterministic — the footer flags the run so a
                                   green isn't mistaken for a scripted pass; pin with --answer for CI.
                                   (Uses the host 'claude -p' on a small model — COWORK_HARNESS_DECIDER_MODEL.)
  --decider-cmd '<helper>'         answer the LIVE question via a spawned helper (for custom logic). The
                                   helper reads a {"type":"decision_request",…} line on stdin and writes
                                   back {"answers":{"<q>":"<label or 1-based index>"}} (MUST flush per
                                   line). Carries a reply_with template + a scrubbed transcript context.
                                   The helper owns its own pipes → the CLI's stdout stays free, so this
                                   composes with --output-format json.
  --decider-dir <dir>              answer LIVE questions IN-BAND from the DRIVING agent (run the harness
                                   in the background; arm a Monitor on <dir>). Each gate is written to
                                   <dir>/req-N.json; write the answer to <dir>/resp-N.json (temp+rename).
                                   stdout stays free → composes with --output-format json. The run is marked
                                   non-deterministic. Use a FRESH empty dir per run. (See docs/decider-dir.md.)
                                   Plumbing: 'gates <dir> [--follow]' streams pending gates as JSON lines;
                                   'answer <dir> --gate N --choose <label>' writes the reply atomically.

Output:
  --output-format text|json        text = live stream + footer (default); json = one stdout envelope
  --quiet, -q                      verdict footer only            --verbose, -V   + thinking/tool inputs/sub-agent tree
  --keep                           print the run dir + deliverable path (runs are always kept on disk)
  --run-dir <path>                 write runs/ under <path> (default ~/.cowork-harness/runs) — keeps sensitive
                                   artifacts out of the working tree. flag > COWORK_HARNESS_RUNS_DIR > default.
  --model <id>                     override the session model
  --dry-run                        preview scenarios, token and binary checks, without recording     NO_COLOR=1   disable ANSI

Long runs:  an idle "still running" heartbeat prints on stderr after ~30s of silence.
            COWORK_HARNESS_NO_HEARTBEAT=1 disables it; COWORK_HARNESS_HEARTBEAT_MS tunes the interval.

Auth:  CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY) from process.env > --dotenv <path> > ./.env >
       <install>/.env. So you can run from any directory and still pick up the install's credentials.

Auth:  Run 'doctor' to check auth. CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY) from process.env >
       --dotenv <path> > ./.env > <install>/.env.

Exit codes:  0 pass · 1 assertion/agent failure · 2 usage / unanswered-under-fail / runtime · 3 boundary/integrity.`;

const RUN_HELP = `cowork-harness run <scenario.yaml | dir/>

  Run one authored scenario, or every *.yaml/*.yml in a directory, with assertions and a CI-ready exit
  code. Verdict-first: on FAIL the failing transcript is printed inline (no spelunking runs/…).

Input policy:
  --on-unanswered fail|first       policy for an unscripted question (default: fail — deterministic).
                                   'prompt' is rejected (it would break reproducibility).
      fail     error + the exact --answer to add (the CI default)
      first    pick option 1, loudly warn; the footer echoes it as a --answer line to lock in
  --decider-cmd '<helper>'         answer live questions via a spawned helper (see 'skill --help')
  --decider-dir <dir>              answer live questions in-band from the driving agent (see 'skill --help').
                                   Plumbing: 'gates <dir> [--follow]' streams pending gates as JSON lines;
                                   'answer <dir> --gate N --choose <label>' writes the reply atomically.
  (run omits --decider-llm by design — scenarios pin answers for reproducibility; a scenario may still
   opt into the model with 'on_unanswered: llm' in its YAML, which flags the run non-deterministic)
  (per-scenario answers/on_unanswered in the YAML take precedence where set)

Output:
  --output-format text|json        text = verdict + failing transcript (default); json = stdout envelope
  --quiet, -q                      verdict only            --verbose, -V   live stream + per-tool markers
  --run-dir <path>                 write runs/ under <path> (default ~/.cowork-harness/runs); keeps sensitive
                                   artifacts out of the working tree. flag > COWORK_HARNESS_RUNS_DIR > default.
  NO_COLOR=1                       disable ANSI on stderr

Long runs:  an idle "still running" heartbeat prints on stderr after ~30s of silence
            (COWORK_HARNESS_NO_HEARTBEAT=1 / COWORK_HARNESS_HEARTBEAT_MS to disable/tune).

Auth:  Run 'doctor' to diagnose auth failures. CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY) from
       process.env > --dotenv <path> > ./.env > <install>/.env.

Exit codes:  0 all pass · 1 any assertion/agent failure · 2 usage / unanswered-under-fail / runtime · 3 boundary/integrity.`;

function printHelp() {
  log(HELP.replace("$VERSION", pkgVersion()));
}
function hasHelp(args: string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

// F-7: per-subcommand `--help`. `run`/`skill` already print their own help via hasHelp(); `lint` delegates
// to the Python argparse path (which has its own --help). Every OTHER subcommand goes straight to parseArgs,
// where `--help` was an "unknown flag" error — so you could only discover flags by triggering a bad
// invocation. Intercept `--help`/`-h` at dispatch and print the command's usage (exit 0). One concise line
// per command, kept in sync with each command's own bad-invocation `usage:` string.
const SUBCOMMAND_USAGE: Record<string, string> = {
  sync: "usage: sync [--diff] [--allow-empty|--force]   (re-sync the platform baseline from the installed Cowork app; macOS only)\n       --allow-empty (alias --force): write even when the derived egress allowlist is empty",
  list: "usage: list [--output-format text|json]   (list available platform baselines)",
  "boundary-check": "usage: boundary-check [<baseline>] [--session <file>] [--output-format text|json]",
  vm: "usage: vm <init|status|delete|prune> [--output-format text|json]   (macOS arm64 only)\n  init    create the L2 Apple-VZ microVM\n  status  show running VM state\n  delete  remove a named VM\n  prune   drop all orphaned VMs",
  chat: "usage: chat <skill-folder> [prompt] [--fidelity protocol|container|hostloop] [--model <id>]\n              [--upload <file>]... [--folder <dir>]... [--plugin <dir>]... [--verbose] [--raw]\n       --raw: native cowork mode via docker run -it; egress sandbox NOT applied; --model/--fidelity ignored\n       --fidelity: protocol/container/hostloop only (no microvm/cowork); protocol = no Docker, no sandbox",
  record:
    "usage: record <scenario.yaml | dir/> [--out <file>] [--output-format text|json] [--rerecord-stale] [--no-redact] [--allow-failing] [--max-artifact-bytes <n>] [--dry-run]",
  replay:
    "usage: replay <file.cassette.json | dir/> [--strict] [--output-format text|json]\n       Positional path is the canonical form. --cassette <file> is a legacy alias (providing both is an error).",
  "verify-cassettes":
    "usage: verify-cassettes <file|dir> [--skip-privacy|--skip-staleness] [--allow <regex>]... [--allow-domain <regex>]... [--allow-email <regex>]... [--allow-file <path>]... [--output-format json]",
  trace:
    "usage: trace <run-id | run-dir | events.jsonl> [--view tools|questions|dispatches] [--output-format json]\n       --view tools       tool call / result rows\n       --view questions   gate lifecycle (question → answer → delivered)\n       --view dispatches  sub-agent dispatch tree + dispatch_count_max\n       (default: all views)",
  assertions: "usage: assertions --list [--output-format json]",
  assert: "usage: assertions --list [--output-format json]   (use 'assertions' — 'assert' is the legacy name)",
  scaffold:
    "usage: scaffold <run-id | run-dir> [--out <file.yaml>]\n       Turns a kept run into a starter scenario YAML (gates→answers, artifacts→file_exists).\n       Positional <run-id | run-dir> is the canonical form.",
  decide:
    'usage: decide [--question <q>] [--option <o>]... [--decider-cmd <cmd> | --decider-llm] [--answer "<q>=<label>"]... [--answer-policy <p>] [--intent <s>] [--output-format json]',
  gates: "usage: gates <dir> [--follow]   (stream pending in-band gates as JSON lines; pair with --decider-dir)",
  answer:
    'usage: answer <dir> --gate <N> (--choose <label> [--choose <label>…] | --answer "<q>=<label>")   (write an in-band gate reply atomically; repeat --choose for a multiSelect gate)',
  "verify-run":
    "usage: verify-run <run-dir> <scenario.yaml> [--output-format json]   (re-evaluate a scenario's assert: against a kept run dir; no live agent)",
  doctor: "usage: doctor [--tier protocol|container|microvm|hostloop|cowork] [--output-format json]   (read-only prerequisite check)",
  rehash:
    "usage: rehash <dir/> [--dry-run] [--output-format text|json]   (migrate cassettes across format bumps using contentSig verification; no re-record needed)",
  runs: "usage: runs gc [--keep-last <n>] [--dry-run] [<runs-dir>]   (prune accumulated run dirs; default --keep-last 5)",
};

// Known subcommands — used by the global value-flag parsers (`--dotenv`, `--run-dir`) to reject a command
// name mistaken as the flag's value (`--dotenv run x.yaml` would otherwise swallow `run`).
const COMMANDS = [
  "skill",
  "run",
  "chat",
  "record",
  "replay",
  "verify-cassettes",
  "verify-run",
  "trace",
  "assertions",
  "assert",
  "scaffold",
  "decide",
  "gates",
  "answer",
  "sync",
  "list",
  "boundary-check",
  "vm",
  "lint",
  "doctor",
  "rehash",
  "runs",
];

async function main() {
  const argv = process.argv.slice(2);

  // `--dotenv <path>` is a GLOBAL flag — parse + strip it before command dispatch so a skill run from
  // any directory can point at the install's credentials. Credentials then resolve in priority order:
  // process.env (exported wins) > --dotenv > ./.env (cwd) > <install>/.env (package root). loadDotenv
  // only fills UNDEFINED keys, so calling it in this order yields exactly that precedence.
  // (NOT `--env-file`: Node reserves that name and consumes it before this code runs.)
  // accept BOTH `--dotenv <path>` (space form) and `--dotenv=<path>` (equals form). The equals
  // form was missed by indexOf("--dotenv") → the whole `--dotenv=...` token fell through to dispatch as
  // the command name ("unknown command"). Find either spelling and apply the SAME existence + command-
  // name guards.
  const eqIdx = argv.findIndex((a) => a.startsWith("--dotenv="));
  const spaceIdx = argv.indexOf("--dotenv");
  const envFileIdx = spaceIdx >= 0 ? spaceIdx : eqIdx;
  const isEquals = spaceIdx < 0 && eqIdx >= 0;
  const explicitEnvFile = isEquals ? argv[eqIdx].slice("--dotenv=".length) : envFileIdx >= 0 ? argv[envFileIdx + 1] : undefined;
  // #4: bounds-check the value, reject a command name mistaken as the path (`--dotenv run x.yaml`
  // would treat `run` as the dotenv path and dispatch `x.yaml`), and FAIL when an explicitly named
  // file is absent — an explicitly-requested credential file silently ignored is a footgun.
  if (envFileIdx >= 0) {
    // The space form needs a following token; the equals form carries its value inline (so an empty
    // `--dotenv=` is also "no path provided").
    if (explicitEnvFile === undefined || explicitEnvFile === "") {
      log("--dotenv requires a path (none provided)");
      process.exit(2);
    }
    // The command-name footgun only applies to the space form (the equals form can't swallow the next
    // token as its value), but checking both is harmless and keeps the guard uniform.
    if (!isEquals && COMMANDS.includes(explicitEnvFile)) {
      log(`--dotenv requires a path but got the command "${explicitEnvFile}" — write \`--dotenv <path> ${explicitEnvFile} …\``);
      process.exit(2);
    }
    // Equals form is a single token; space form is the flag + its value.
    argv.splice(envFileIdx, isEquals ? 1 : 2);
    if (!existsSync(explicitEnvFile)) {
      log(`--dotenv file not found: ${explicitEnvFile}`);
      process.exit(2);
    }
  }

  // `--run-dir <path>` is a GLOBAL flag (parsed + stripped before dispatch, like --dotenv) that relocates
  // the runs/ output root so sensitive skill inputs/outputs never land in a working tree. It is a thin
  // shim over COWORK_HARNESS_RUNS_DIR: setting it here makes runsWriteRoot()/runsRoot() pick it up with no
  // writer/reader changes. Precedence: flag > COWORK_HARNESS_RUNS_DIR > ~/.cowork-harness/runs. Unlike
  // --dotenv it does NOT require the path to exist (it's an output dir, created on first write).
  const rdEq = argv.findIndex((a) => a.startsWith("--run-dir="));
  const rdSpace = argv.indexOf("--run-dir");
  const rdIdx = rdSpace >= 0 ? rdSpace : rdEq;
  const rdIsEquals = rdSpace < 0 && rdEq >= 0;
  const runDirVal = rdIsEquals ? argv[rdEq].slice("--run-dir=".length) : rdIdx >= 0 ? argv[rdIdx + 1] : undefined;
  if (rdIdx >= 0) {
    if (runDirVal === undefined || runDirVal === "") {
      log("--run-dir requires a path (none provided)");
      process.exit(2);
    }
    if (!rdIsEquals && COMMANDS.includes(runDirVal)) {
      log(`--run-dir requires a path but got the command "${runDirVal}" — write \`--run-dir <path> ${runDirVal} …\``);
      process.exit(2);
    }
    argv.splice(rdIdx, rdIsEquals ? 1 : 2);
    process.env.COWORK_HARNESS_RUNS_DIR = resolve(process.cwd(), runDirVal);
  }

  const packageRootEnv = fileURLToPath(new URL("../.env", import.meta.url)); // dist/cli.js → <install>/.env
  const sources = [...(explicitEnvFile ? [explicitEnvFile] : []), resolve(process.cwd(), ".env"), packageRootEnv];
  const loadedEnv: string[] = [];
  const seenSources = new Set<string>();
  for (const f of sources) {
    const key = resolve(f);
    if (seenSources.has(key)) continue; // don't double-load when cwd === install dir
    seenSources.add(key);
    loadedEnv.push(...loadDotenv(f));
  }
  // Only surface env-loading when it's non-obvious — an explicit --dotenv, or debug. The common
  // auto-load (./.env / install .env) stays silent: auth either works or fails loudly. (Feedback: the
  // line was repetitive noise across many invocations.)
  if (loadedEnv.length && (explicitEnvFile || process.env.COWORK_HARNESS_DEBUG))
    log(`[env] loaded ${loadedEnv.length} var(s): ${loadedEnv.join(", ")}`);

  const [cmd, ...rest] = argv;
  if (cmd === "--version" || cmd === "-v") return void out(pkgVersion());
  if (cmd === undefined || cmd === "--help" || cmd === "-h" || cmd === "help") return printHelp();
  // F-7: per-subcommand --help for the parseArgs-direct commands (run/skill/lint self-handle, so they're
  // absent from the map and fall through to their own handling).
  if (hasHelp(rest) && cmd in SUBCOMMAND_USAGE) return void log(SUBCOMMAND_USAGE[cmd]);
  switch (cmd) {
    case "run":
      return cmdRun(rest);
    case "sync":
      return cmdSync(rest);
    case "list":
      return cmdList(rest);
    case "doctor":
      return cmdDoctor(rest);
    case "boundary-check":
      return cmdBoundary(rest);
    case "vm":
      return cmdVm(rest);
    case "skill":
      return cmdSkill(rest);
    case "chat":
      return cmdChat(rest);
    case "record":
      return cmdRecord(rest);
    case "replay":
      return cmdReplay(rest);
    case "lint":
      return cmdLint(rest);
    case "verify-cassettes":
      return cmdVerifyCassettes(rest);
    case "rehash":
      return cmdRehash(rest);
    case "verify-run":
      return cmdVerifyRun(rest);
    case "trace":
      return cmdTrace(rest);
    case "assertions":
      return cmdAssert(rest);
    case "assert": // legacy alias — keep working, show deprecation notice
      log("note: 'assert' has been renamed to 'assertions'; please update your scripts.\n");
      return cmdAssert(rest);
    case "scaffold":
      return cmdScaffold(rest);
    case "decide":
      return cmdDecide(rest);
    case "gates":
      return cmdGates(rest);
    case "answer":
      return cmdAnswer(rest);
    case "runs": {
      const sub = rest[0];
      if (sub === "gc") return cmdRunsGc(rest.slice(1));
      log(`runs: unknown subcommand "${sub ?? ""}" — available: gc`);
      return process.exit(2);
    }
    default:
      log(`unknown command: ${cmd}\n`);
      printHelp();
      process.exit(2);
  }
}

interface CommonFlags {
  onUnanswered?: OnUnanswered;
  output: "text" | "json";
  quiet: boolean;
  verbose: boolean;
  deciderCmd?: string; // --decider-cmd: spawn a helper that answers each decision (external channel B)
  deciderDir?: string; // --decider-dir: file-rendezvous for a driving agent's Monitor (external channel C)
}
/** Shared json-output predicate so the parser and the top-level catch can never drift. */
function isJsonOutput(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output-format" && args[i + 1] === "json") return true;
    if (args[i] === "--output-format=json") return true;
  }
  return false;
}
/** Validate `--output-format` is text|json for the ad-hoc commands (trace/decide/gates) the way the
 *  common parser already does for run/skill — an invalid value is a usage error, not a silent text degrade. */
function ensureOutputFormat(command: string, args: string[]): void {
  try {
    parseOutputFormat(args);
  } catch (e) {
    fail(command, "usage", String((e as Error).message), undefined, isJsonOutput(args));
  }
}
/**
 * #58: bounds-checked reader for value-taking flags. `args[++i]` with no following token silently
 * yields `undefined` (e.g. a trailing `--decider-cmd` at the end of argv), which then becomes a
 * broken flag value. Read the next token explicitly and, when it's absent, fail with the established
 * usage-error exit code (2). takeCommonFlags can run before --output-format json is resolved, so the error
 * goes to stderr unconditionally (machine callers piping us still see a non-zero exit).
 */
function flagValue(args: string[], i: number, flag: string): string {
  const v = args[i + 1];
  if (v === undefined) {
    log(`${flag} requires a value (none provided)`); // stderr usage error
    process.exit(2);
  }
  if (v.trim() === "") {
    log(`${flag} requires a non-empty value`);
    process.exit(2);
  }
  return v;
}

/**
 * Bug 30: variant of flagValue that additionally rejects values that look like flags (start with "-",
 * excluding negative numbers like "-1"). Use this at call sites that do NOT have a downstream explicit
 * flag-like check. Name the flag and suspicious value in the error.
 */
function flagValueStrict(args: string[], i: number, flag: string): string {
  const v = flagValue(args, i, flag);
  if (v.startsWith("-") && !/^-\d/.test(v)) {
    log(`${flag} requires a value but got a flag-looking token "${v}" — did you forget the value?`);
    process.exit(2);
  }
  return v;
}

/**
 * Extract true positionals — args that are neither a flag nor the value consumed by a known
 * value-taking flag. Replaces the naive first-non-dash-token scan, which mistook a flag's value
 * (e.g. the `1` in `--gate 1`, the `json` in `--output-format json`) for the positional.
 * `valueFlags` lists the value-taking flags whose following token must be skipped.
 */
function positionals(args: string[], valueFlags: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (valueFlags.includes(a)) {
      i++; // skip the flag AND its value
      continue;
    }
    if (a.startsWith("-")) continue; // any other (boolean) flag — skip just the flag
    out.push(a);
  }
  return out;
}

/**
 * Reject any `--`-prefixed or `-`-prefixed token not in `knownFlags`. The positional-filter idiom silently DROPS an
 * unknown flag (a typo'd `--ouput-format`, a misremembered flag) — a no-op that reads as success. After
 * a command has parsed its recognized flags, run this so an unrecognized flag fails LOUD (exit 2) the
 * same way every other usage error does. `knownFlags` lists the flag spellings the command accepts
 * (include the `--output-format=json`/`=text` equals forms where the command honors them).
 * Bug 14: also rejects single-dash flags (e.g. `-x`, `-abc`) that aren't in knownFlags.
 */
function rejectUnknownFlags(command: string, args: string[], knownFlags: string[], json: boolean): void {
  for (const a of args) {
    if (!a.startsWith("-")) continue;
    // Honor the `--flag=value` equals form: compare on the flag name before `=`.
    const name = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    if (knownFlags.includes(a) || knownFlags.includes(name)) continue;
    fail(command, "usage", `unknown flag: ${a}`, undefined, json);
  }
}

function takeCommonFlags(args: string[], commandName: string = "skill"): { rest: string[]; flags: CommonFlags } {
  const rest: string[] = [];
  const envOutputFormat = process.env.COWORK_HARNESS_OUTPUT_FORMAT;
  const defaultOutput: "text" | "json" = envOutputFormat === "json" ? "json" : "text";
  const flags: CommonFlags = { output: defaultOutput, quiet: false, verbose: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--on-unanswered") flags.onUnanswered = flagValue(args, i++, a) as OnUnanswered;
    else if (a === "--output-format") {
      // #2: validate the enum (and bounds-check the value). An invalid/missing value previously fell
      // back to "text" silently (`--output-format xml` behaved as text; a trailing `--output-format` too).
      const v = flagValue(args, i++, a);
      if (v !== "text" && v !== "json") {
        log(`--output-format must be "text" or "json" (got "${v}")`);
        process.exit(2);
      }
      flags.output = v;
    } else if (a === "--output-format=json") flags.output = "json";
    else if (a === "--output-format=text") flags.output = "text";
    else if (a === "--quiet" || a === "-q") flags.quiet = true;
    else if (a === "--verbose" || a === "-V") flags.verbose = true;
    else if (a === "--decider-cmd") {
      const v = flagValue(args, i++, a);
      if (v.startsWith("-"))
        fail(commandName, "usage", `--decider-cmd: missing value (got flag-looking "${v}")`, undefined, flags.output === "json");
      flags.deciderCmd = v;
    } else if (a === "--decider-dir") {
      const v = flagValue(args, i++, a);
      if (v.startsWith("-"))
        fail(commandName, "usage", `--decider-dir: missing value (got flag-looking "${v}")`, undefined, flags.output === "json");
      flags.deciderDir = v;
    } else rest.push(a);
  }
  return { rest, flags };
}

/** Resolve the output/render plan for a command (unified output model). */
function resolveOutput(
  command: "run" | "skill",
  flags: CommonFlags,
): { json: boolean; render: boolean; footer: boolean; plan: RenderPlan } {
  const color = process.stderr.isTTY === true && !process.env.NO_COLOR;
  if (flags.output === "json")
    return { json: true, render: false, footer: false, plan: { live: false, progress: false, verbose: false, color: false } };
  if (flags.quiet) return { json: false, render: false, footer: true, plan: { live: false, progress: false, verbose: false, color } };
  const verbose = flags.verbose;
  // skill renders live ("show me what it did"); run is verdict-first (renderer buffers for the
  // failure transcript; live/per-tool only under --verbose).
  const live = command === "skill" ? true : verbose;
  const progress = command === "skill" ? true : verbose;
  return { json: false, render: true, footer: true, plan: { live, progress, verbose, color } };
}

/** Resolve the on_unanswered default for a command (input-and-interactivity plan §3). This is the choke
 *  point BOTH run and skill pass through, so the removed/internal policy values are rejected here — they
 *  can't silently degrade to `fail` (which would pass a no-gate run green under a bogus policy). */
function resolvePolicy(command: "run" | "skill", flags: CommonFlags): OnUnanswered {
  const json = flags.output === "json";
  // `external` (the removed stdio channel) → `--decider-dir`/`--decider-cmd` subsume it.
  if ((flags.onUnanswered as string) === "external")
    fail(
      command,
      "usage",
      "--on-unanswered external was removed. Use --decider-dir <dir> (the in-band file channel for a driving agent) or --decider-cmd '<helper>'.",
      undefined,
      json,
    );
  // The LLM decider's CLI spelling is --decider-llm; we reject the raw policy value on the CLI to keep deciders in the --decider-* family (the scenario-YAML spelling is on_unanswered: llm).
  if ((flags.onUnanswered as string) === "llm")
    fail(
      command,
      "usage",
      '--on-unanswered llm is not a user flag. Use --decider-llm [--intent "<one line>"] to answer live questions with a model.',
      undefined,
      json,
    );
  if (flags.onUnanswered) {
    // #3: validate the accepted set. `external`/`llm` are rejected above with redirect messages (the
    // decider-orthogonality invariant); any OTHER bogus value (e.g. "banana") used to fall through here
    // and pass unvalidated, with audit metadata reporting a nonsensical policy. Reject it loudly.
    if (flags.onUnanswered !== "fail" && flags.onUnanswered !== "prompt" && flags.onUnanswered !== "first")
      fail(
        command,
        "usage",
        `--on-unanswered must be fail|prompt|first (got "${flags.onUnanswered}")`,
        "for a model/external decider use --decider-llm, --decider-dir, or --decider-cmd",
        json,
      );
    if (command === "run" && flags.onUnanswered === "prompt") {
      log("run rejects --on-unanswered prompt (would break determinism). Use fail|first.");
      process.exit(2);
    }
    return flags.onUnanswered;
  }
  if (command === "run") return "fail"; // scenarios are reproducible regression tests
  // skill: adaptive — prompt if a human is at the TTY, else fail (CI/agent)
  return process.stdin.isTTY && !process.env.CI ? "prompt" : "fail";
}

/** Resolve the external decider channel, if requested: `--decider-cmd` → a spawned helper, or
 *  `--decider-dir` → a file rendezvous (the driving agent answers in-band). BOTH keep the CLI's stdout
 *  FREE (the protocol is on the helper's pipes / on disk), so they compose with `--output-format json`.
 *  Returns undefined when neither is set. */
function resolveExternal(command: string, flags: CommonFlags): DecisionChannel | undefined {
  if (flags.deciderDir != null && flags.deciderCmd != null)
    fail(command, "usage", "--decider-dir conflicts with --decider-cmd (one terminal channel).", undefined, flags.output === "json");
  if (flags.deciderDir != null) {
    try {
      return fileChannel(flags.deciderDir);
    } catch (e) {
      return fail(command, "usage", String((e as Error).message), undefined, flags.output === "json");
    }
  }
  return flags.deciderCmd != null ? spawnChannel(flags.deciderCmd) : undefined;
}

/** The single error exit used by commands + the top-level catch. Every category → exit 2. */
function fail(command: string, category: ErrCategory, message: string, hint: string | undefined, json: boolean): never {
  if (json) out(jsonError(command, category, message, hint));
  else {
    log(message);
    if (hint) log(hint);
  }
  process.exit(category === "boundary" ? 3 : 2);
}

/** Split a `--answer "<key>=<value>"` arg; the value rejoins on "=" so a choice may itself contain "=".
 *  Returns null when either side is empty (e.g. "=choice" or "question="). */
function splitEq(s: string | undefined): [string, string] | null {
  const [k, ...r] = (s ?? "").split("=");
  const v = r.join("=");
  if (!k || !v) return null;
  return [k, v];
}

/** Load an `--answer-policy <yaml>` file → scripted rules. Same shape as a scenario `answers:` block (a
 *  bare list, or an `{answers: [...]}` doc). Fails LOUD on a missing / unparseable / non-list file — a
 *  malformed policy must NOT validate as "0 rules" (the user would discover it only when a gate goes
 *  unanswered mid-run). */
function loadAnswerPolicy(command: string, path: string, json: boolean): AnswerRule[] {
  if (!existsSync(path)) fail(command, "usage", `--answer-policy file not found: ${path}`, undefined, json);
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, "utf8"));
  } catch (e) {
    return fail(command, "usage", `cannot parse --answer-policy ${path}: ${String((e as Error).message)}`, undefined, json);
  }
  const rules = Array.isArray(parsed) ? parsed : ((parsed as { answers?: unknown })?.answers ?? []);
  if (!Array.isArray(rules))
    fail(command, "usage", `--answer-policy must be a list of rules (or an {answers: [...]} doc)`, undefined, json);
  // #7: validate EACH rule against the AnswerRule schema instead of a blind cast. A malformed rule
  // (non-object, wrong field types) must fail loud here, not silently validate as a rule that never
  // matches and surfaces only as an unanswered gate mid-run.
  const out: AnswerRule[] = [];
  for (const [idx, raw] of (rules as unknown[]).entries()) {
    const r = AnswerRule.safeParse(raw);
    if (!r.success)
      fail(
        command,
        "usage",
        `--answer-policy rule #${idx + 1} is malformed: ${r.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}`,
        undefined,
        json,
      );
    out.push(r.data);
  }
  return out;
}

/**
 * The per-scenario run lifecycle shared by `cmdRun` and `cmdSkill` (they had drifted while hand-kept in
 * sync). Owns ONLY the per-scenario spine: renderer + renderStart, the idle heartbeat (disabled under
 * --output-format json OR an external channel), `executeScenario`, the `UnansweredError → fail` mapping, and the
 * footer. The CALLER keeps everything that differs: the external channel's create/close (run reuses ONE
 * across the file loop), the `--output-format json` envelope, and the exit code.
 */
async function runOneScenario(p: {
  command: "run" | "skill";
  scenario: Scenario;
  label: string;
  flags: CommonFlags;
  policy: OnUnanswered;
  externalChannel: DecisionChannel | undefined;
  o: ReturnType<typeof resolveOutput>;
  keep?: boolean;
  extra?: Partial<ExecuteOptions>; // skill-only opts: session/sessionId/resume/llmIntent/nonDeterministicHint
}): Promise<RunResult> {
  const { command, scenario, label, flags, policy, externalChannel, o, keep, extra } = p;
  const renderer = o.render ? makeRenderer(o.plan) : undefined;
  if (!o.json && !flags.quiet) renderStart(label, scenario.fidelity, o.plan);
  const start = Date.now();
  const stopHeartbeat = o.json || externalChannel ? () => {} : startHeartbeat(renderer, o.plan, start);
  let result: RunResult;
  try {
    result = await executeScenario(scenario, { ...extra, onUnanswered: policy, externalChannel, hooks: renderer ? [renderer] : [] });
  } catch (e) {
    if (e instanceof UnansweredError) {
      const chan = flags.deciderDir ? "decider-dir" : flags.deciderCmd ? "decider-cmd" : policy;
      const prefix = command === "run" ? `${scenario.name}: ` : ""; // run names the scenario; skill is single
      fail(command, "unanswered", `${prefix}unanswered question (on_unanswered=${chan})`, e.hint, o.json);
    }
    throw e; // BoundaryError + generic → top-level catch (categorized there)
  } finally {
    stopHeartbeat();
  }
  // footer (stderr) and the json envelope (stdout, emitted by the caller) are mutually exclusive —
  // resolveOutput makes `footer` false under --output-format json — so their relative order never matters.
  if (o.footer) renderFooter(result, o.plan, { durationMs: Date.now() - start, renderer, keep, scaffoldTip: command === "skill" });
  return result;
}

async function cmdRun(rawArgs: string[]) {
  if (hasHelp(rawArgs)) return void log(RUN_HELP);
  const { rest: args, flags } = takeCommonFlags(rawArgs, "run");
  const target = args[0];
  if (!target) fail("run", "usage", "usage: run <scenario.yaml | dir/>", undefined, flags.output === "json");
  // `takeCommonFlags` strips known flags; `run` takes exactly one positional (a scenario file or a
  // dir), so anything left over is unexpected. Reject it LOUDLY instead of silently dropping it —
  // e.g. `--fidelity microvm` was a silent no-op (fidelity comes from the scenario's `fidelity:`
  // field, not a flag). Runs before existsSync so the message is precise even for a bogus path.
  const extra = args.slice(1);
  if (extra.length)
    fail(
      "run",
      "usage",
      `unexpected argument(s): ${extra.join(" ")} — \`run\` takes one <scenario.yaml | dir/> plus common flags. Fidelity is set by the scenario's \`fidelity:\` field, not a flag.`,
      undefined,
      flags.output === "json",
    );
  // A non-existent path threw a raw ENOENT (exit 2 + stack) instead of a clean usage message.
  if (!existsSync(target)) fail("run", "usage", `scenario path not found: ${target}`, undefined, flags.output === "json");
  // an empty directory (no *.yaml/*.yml) must be a LOUD non-zero, not a vacuous exit-0 pass.
  // resolveInputs centralizes the file-or-dir + empty-dir-is-loud rule (shared with replay/verify).
  const resolved = resolveInputs(target, [".yaml", ".yml"]);
  if ("error" in resolved) fail("run", "usage", `run: ${resolved.error}`, undefined, flags.output === "json");
  const files = resolved.files;

  const externalChannel = resolveExternal("run", flags); // created once; reused across scenarios
  const policy = externalChannel ? "fail" : resolvePolicy("run", flags);
  const o = resolveOutput("run", flags);
  noteRunsLocation({ json: o.json, quiet: !!flags.quiet });
  const results: RunResult[] = [];
  try {
    for (let i = 0; i < files.length; i++) {
      const scenario = parseScenarioFile(files[i]);
      // The CLI flag guard (resolvePolicy) rejects --on-unanswered prompt on `run`, but a committed
      // scenario could smuggle it via its YAML and silently block/hang in non-TTY CI. Reject it here too.
      if (scenario.on_unanswered === "prompt")
        fail(
          "run",
          "usage",
          `scenario "${scenario.name}" sets on_unanswered: prompt — rejected on \`run\` (breaks determinism / hangs in CI). Use fail|first, or --decider-dir/--decider-cmd.`,
          undefined,
          o.json,
        );
      const label = files.length > 1 ? `[${i + 1}/${files.length}] ${scenario.name}` : scenario.name;
      results.push(await runOneScenario({ command: "run", scenario, label, flags, policy, externalChannel, o }));
    }
  } finally {
    externalChannel?.close?.(); // ONE channel reused across the loop — close after ALL scenarios (not per-run)
  }
  // All channels keep stdout free → the normal output path (envelope under --output-format json, nothing
  // otherwise). No terminal {type:"result"} line — `--decider-cmd`/`--decider-dir` compose with json.
  if (o.json) out(jsonEnvelope("run", results));
  const anyFail = results.some((r) => !computeVerdict(r, "live").pass);
  process.exit(anyFail ? 1 : 0);
}

async function cmdSkill(rawArgs: string[]) {
  if (hasHelp(rawArgs)) return void log(SKILL_HELP);
  const { rest: args, flags } = takeCommonFlags(rawArgs, "skill");
  const positional: string[] = [];
  const answers: AnswerRule[] = [];
  const extraPlugins: string[] = [];
  const marketplaces: string[] = [];
  const enables: string[] = [];
  const uploads: string[] = [];
  const folders: string[] = [];
  const envFidelity = process.env.COWORK_HARNESS_FIDELITY;
  const FID_VALUES = ["protocol", "container", "microvm", "hostloop", "cowork"];
  if (envFidelity && !FID_VALUES.includes(envFidelity))
    fail(
      "skill",
      "usage",
      `COWORK_HARNESS_FIDELITY must be one of ${FID_VALUES.join("|")} (got "${envFidelity}")`,
      undefined,
      flags.output === "json",
    );
  let fidelity: "protocol" | "container" | "microvm" | "hostloop" | "cowork" =
    (envFidelity as "protocol" | "container" | "microvm" | "hostloop" | "cowork" | undefined) ?? "container";
  let model: string | undefined = process.env.COWORK_HARNESS_MODEL;
  let promptFile: string | undefined;
  let sessionId: string | undefined;
  let answerPolicy: string | undefined;
  let intent: string | undefined;
  let deciderLlm = false;
  let resume = false;
  let dryRun = false;
  let keep = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--fidelity") {
      fidelity = flagValue(args, i++, a) as typeof fidelity; // #58: bounds-checked
      // #6: validate at parse time → category `usage`. Previously an invalid value was only rejected
      // later by Scenario.parse (a Zod throw), which the top-level catch mapped to `internal` — a user
      // mistake masquerading as a harness bug.
      const FID = ["protocol", "container", "microvm", "hostloop", "cowork"];
      if (!FID.includes(fidelity))
        fail("skill", "usage", `--fidelity must be one of ${FID.join("|")} (got "${fidelity}")`, undefined, flags.output === "json");
    } else if (a === "--model") model = flagValueStrict(args, i++, a);
    else if (a === "--prompt-file") promptFile = flagValueStrict(args, i++, a);
    else if (a === "--upload") uploads.push(flagValueStrict(args, i++, a));
    else if (a === "--folder") folders.push(flagValueStrict(args, i++, a));
    else if (a === "--session-id") sessionId = flagValueStrict(args, i++, a);
    else if (a === "--resume") resume = true;
    else if (a === "--decider-llm") deciderLlm = true;
    else if (a === "--intent") intent = flagValueStrict(args, i++, a);
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--keep") keep = true;
    else if (a === "--plugin") extraPlugins.push(flagValueStrict(args, i++, a));
    else if (a === "--marketplace") marketplaces.push(flagValueStrict(args, i++, a));
    else if (a === "--enable") enables.push(flagValueStrict(args, i++, a));
    else if (a === "--answer") {
      const raw = flagValueStrict(args, i++, a);
      const parts = splitEq(raw);
      if (!parts)
        fail(
          "skill",
          "usage",
          `--answer requires "question-regex=choice" (got "${raw}" — both sides must be non-empty)`,
          undefined,
          flags.output === "json",
        );
      const [q, choose] = parts!;
      answers.push({ when_question: q, choose });
    } else if (a === "--answer-policy") answerPolicy = flagValueStrict(args, i++, a);
    // Bug 1: reject unknown flags (any token starting with - or -- that wasn't consumed above)
    else if (a.startsWith("-")) fail("skill", "usage", `unknown flag: ${a}`, undefined, flags.output === "json");
    else positional.push(a);
  }
  const isJson = flags.output === "json";
  if (resume && !sessionId) fail("skill", "usage", "--resume requires --session-id <id> (the session to resume)", undefined, isJson);

  // #5: reject extra positionals so a shell-quoting slip (an unquoted multi-word prompt) can't silently
  // drop part of the intended prompt. With --prompt-file the only positional is the plugin folder (1);
  // without it, <plugin-folder> "<prompt>" (2). Anything beyond is unexpected.
  const maxPositional = promptFile !== undefined ? 1 : 2;
  if (positional.length > maxPositional)
    fail(
      "skill",
      "usage",
      `unexpected extra argument(s): ${positional.slice(maxPositional).join(" ")} — ${
        promptFile !== undefined
          ? "with --prompt-file, skill takes at most one positional (the plugin folder)"
          : 'skill takes <plugin-folder> "<prompt>" — quote a prompt that contains spaces'
      }`,
      undefined,
      isJson,
    );

  // --answer-policy <yaml>: a reusable file of regex→choice rules (same shape as a scenario `answers:`
  // block), so the common "answer known gates, zero JS" case needs no --decider-cmd helper. Rules from
  // the file resolve first (ScriptedDecider); anything unmatched still follows --on-unanswered.
  if (answerPolicy) answers.push(...loadAnswerPolicy("skill", answerPolicy, isJson));

  // --prompt-file reads the prompt verbatim (raw bytes, no shell parsing) — the robust way to pass a
  // prompt containing $, backticks, or newlines. When given, the folder is positional[0] (no inline
  // prompt positional is consumed for the prompt).
  let filePrompt: string | undefined;
  if (promptFile !== undefined) {
    if (!existsSync(promptFile)) fail("skill", "usage", `--prompt-file not found: ${promptFile}`, undefined, isJson);
    try {
      filePrompt = readFileSync(promptFile, "utf8");
    } catch (e) {
      fail("skill", "usage", `cannot read --prompt-file ${promptFile}: ${String((e as Error).message)}`, undefined, isJson);
    }
    if (!filePrompt.trim()) fail("skill", "usage", `--prompt-file is empty: ${promptFile}`, undefined, isJson);
  }

  // With --prompt-file, every positional is a source (folder); without it, the LAST positional is the
  // inline prompt and earlier positionals (if any) are the folder.
  const haveSource =
    (filePrompt !== undefined ? positional.length >= 1 : positional.length >= 2) || marketplaces.length || extraPlugins.length;
  const folder = filePrompt !== undefined ? positional[0] : positional.length >= 2 ? positional[0] : undefined;
  const prompt = filePrompt ?? positional[positional.length >= 2 ? 1 : 0];
  if (!haveSource || !prompt) {
    fail(
      "skill",
      "usage",
      'usage: cowork-harness skill <plugin-folder> "<prompt>" [--prompt-file <path>] [--marketplace <dir> --enable name@mkt] [--plugin <dir>]… [--fidelity …] [--answer "q=choice"]  (skill --help for all flags)',
      undefined,
      isJson,
    );
  }
  // A marketplace dir is only a real source if something is enabled from it. With --marketplace but no
  // --enable (and no plugin folder / --plugin), nothing is loaded, yet the scenario asserts success — a
  // vacuous green. Require an --enable when a marketplace is the only source.
  if (marketplaces.length && enables.length === 0 && !folder && extraPlugins.length === 0)
    fail(
      "skill",
      "usage",
      "--marketplace requires at least one --enable <name@marketplace> — nothing would be loaded otherwise.",
      undefined,
      isJson,
    );
  const localPlugins = [...(folder ? [folder] : []), ...extraPlugins];

  // Bug 13: All semantic validation must happen BEFORE the dry-run return so --dry-run doesn't bypass
  // conflict guards. The dry-run only skips side effects (actually running), not validation.

  // `--decider-llm` is the ONLY user-facing way to select the LLM terminal (it maps to the `llm`
  // policy below; the bare `--on-unanswered llm` CLI flag is rejected at resolvePolicy). (Issue 2)
  const useLlm = deciderLlm;
  // Resolve external channel for validation (we pass flags, which have deciderCmd/deciderDir)
  const externalChannelForValidation = flags.deciderDir != null || flags.deciderCmd != null;
  if (useLlm && externalChannelForValidation)
    fail("skill", "usage", "--decider-llm conflicts with --decider-cmd/--decider-dir (two terminals).", undefined, isJson);
  // --intent only feeds the LLM decider; without --decider-llm it is silently ignored.
  if (intent !== undefined && !useLlm)
    fail(
      "skill",
      "usage",
      "--intent requires --decider-llm (it states the test intent for the model answering live questions).",
      undefined,
      isJson,
    );
  // --decider-llm forces the `llm` terminal; an explicit --on-unanswered would be silently overridden — reject the conflict.
  if (useLlm && flags.onUnanswered !== undefined)
    fail(
      "skill",
      "usage",
      `--decider-llm conflicts with --on-unanswered ${flags.onUnanswered} (it forces the model terminal). Drop one.`,
      undefined,
      isJson,
    );

  if (dryRun) {
    out(JSON.stringify({ fidelity, prompt, localPlugins, marketplaces, enabled: enables, answers }, null, 2));
    return;
  }

  // Resolve the inline session's relative paths against cwd (consistent with `run`'s file path, which
  // goes through resolveSessionPaths) so uploads/folders/plugins are cwd-independent for the skill path.
  const session = resolveSessionPaths(
    loadSession({
      model,
      permission_parity: "cowork",
      plugins: { local_plugins: localPlugins, local_marketplaces: marketplaces, enabled: enables },
      uploads, // --upload <file> → mnt/uploads/<basename> (the "attach a file" path; ad-hoc parity with session.uploads)
      folders: folders.map((from) => ({ from, mode: "rw" as const })), // --folder <dir> → mnt/.projects/<id> (asar: rw, delete denied by default)
    }),
    process.cwd(),
  );
  // Name the run after the skill folder's BASENAME (not the whole dashified path → "skill-ill-…").
  const sourceName = basename((folder ?? marketplaces[0] ?? extraPlugins[0] ?? "test").replace(/\/+$/, "")) || "test";
  const scenario = Scenario.parse({
    name: `skill-${sourceName
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)}`,
    baseline: "latest",
    session: "(inline)",
    fidelity,
    prompt,
    answers,
    assert: [{ result: "success" }],
  });

  const externalChannel = resolveExternal("skill", flags);
  // base policy; an external channel or the LLM decider overrides the terminal in execute.ts
  const policy: OnUnanswered = externalChannel ? "fail" : useLlm ? "llm" : resolvePolicy("skill", flags);
  const o = resolveOutput("skill", flags);
  noteRunsLocation({ json: o.json, quiet: !!flags.quiet });
  let result: RunResult;
  try {
    result = await runOneScenario({
      command: "skill",
      scenario,
      label: scenario.name,
      flags,
      policy,
      externalChannel,
      o,
      keep,
      extra: {
        session,
        sessionId,
        resume,
        llmIntent: intent,
        nonDeterministicHint: flags.deciderDir != null || flags.deciderCmd != null, // driving agent / helper answers → not reproducible (M4; #48)
      },
    });
  } finally {
    externalChannel?.close?.();
  }
  // All channels keep stdout free → the json envelope is the only stdout (footer goes to stderr, and is
  // mutually exclusive with --output-format json). The footer itself is emitted inside runOneScenario.
  if (o.json) out(jsonEnvelope("skill", [result]));
  process.exit(computeVerdict(result, "live").pass ? 0 : 1);
}

const VM_SUB_HELP: Record<string, string> = {
  init: "usage: vm init [<baseline>] [--output-format text|json]   — create the L2 Apple-VZ microVM",
  status: "usage: vm status [<baseline>] [--output-format text|json] — show running VM state",
  delete: "usage: vm delete [<baseline>] [--output-format text|json] — remove the named VM",
  prune: "usage: vm prune [<baseline>] [--output-format text|json]  — drop all orphaned VMs except the current one",
};

function cmdVm(args: string[]) {
  // R3: macOS arm64 guard — Lima VMs are macOS-only.
  if (process.platform !== "darwin") {
    log("vm is only supported on macOS arm64 (requires Lima + Apple Virtualization Framework)\n");
    process.exit(2);
  }

  const sub = args[0];
  const VM_SUBS = Object.keys(VM_SUB_HELP);

  // R3: per-subcommand --help (e.g. `vm init --help`).
  if (sub && VM_SUBS.includes(sub) && (args.includes("--help") || args.includes("-h"))) {
    log(VM_SUB_HELP[sub]);
    process.exit(0);
  }

  // validate the subcommand BEFORE loadBaseline(args[1]) — a bad subcommand (e.g. `vm typo`)
  // otherwise surfaced as a baseline-load error (or, with a stray arg, a confusing baseline message)
  // instead of the clear `usage: vm …`. (A bare `log` then exit-0 was the older footgun, now exit 2.)
  if (!VM_SUBS.includes(sub ?? "")) {
    log(SUBCOMMAND_USAGE["vm"] ?? "usage: vm <init|status|delete|prune>");
    process.exit(2);
  }
  // Bug 25: reject unknown flags so a typo (e.g. `--coonfigure`) fails fast instead of being silently
  // passed to loadBaseline as a positional. Known flags: --output-format (+ equals forms), --help, -h.
  const knownVmFlags = ["--output-format", "--output-format=json", "--output-format=text", "--help", "-h"];
  rejectUnknownFlags("vm", args, knownVmFlags, isJsonOutput(args));
  const baseline = loadBaseline(args[1] ?? "latest");
  // #62/#63: the instance name is derived from the config hash (see lima.ts instanceName) — a config
  // change yields a new name, so a stale VM is never silently reused.
  const instance = instanceName(baseline);
  if (sub === "status") log(`${instance}: ${vmStatus(instance)}`);
  else if (sub === "init") {
    const { status } = vmInit(baseline);
    log(`${instance}: ${status}`);
  } else if (sub === "delete") {
    vmDelete(instance);
    log(`${instance} deleted`);
  } else if (sub === "prune") {
    const pruned = vmPrune(instance);
    log(pruned.length ? `pruned ${pruned.length} orphaned VM(s): ${pruned.join(", ")}` : `no orphaned VMs (current: ${instance})`);
  } else {
    // #11: an invalid/absent subcommand must exit non-zero — a bare `log` exits 0, so a CI script
    // running `vm typo` would read it as success.
    log("usage: vm <init|status|delete|prune>");
    process.exit(2);
  }
}

function cmdBoundary(args: string[]) {
  // Optional --session <file>: fold that session's egress additions into the boundary allowlist so the
  // self-test exercises the same boundary the session's runs would (not just baseline invariants).
  // Bug 24: accept --output-format so the advertised flag isn't rejected at runtime.
  ensureOutputFormat("boundary-check", args);
  const json = isJsonOutput(args);
  let p;
  try {
    // --session and --output-format are the known flags; parseArgs rejects any other.
    p = parseArgs(args, {
      values: ["--session", "--output-format"],
      enums: { "--output-format": ["text", "json"] },
      noDashValue: ["--session"],
    });
  } catch (e) {
    log((e as Error).message);
    return process.exit(2);
  }
  const sessionPath = p.options["--session"];
  // Reject extra baseline positionals rather than silently using only the first.
  if (p.positionals.length > 1) {
    log(`boundary-check takes at most one baseline (got ${p.positionals.length}: ${p.positionals.join(", ")})`);
    return process.exit(2);
  }
  const baseline = loadBaseline(p.positionals[0] ?? "latest");
  let sessionEgress: { extraAllow?: string[]; unrestricted?: boolean } | undefined;
  if (sessionPath) {
    const s = loadSession(parseYaml(readFileSync(sessionPath, "utf8")));
    sessionEgress = { extraAllow: s.egress.extra_allow, unrestricted: s.egress.unrestricted };
  }
  const results = runBoundaryChecks(baseline, sessionEgress);
  if (json) {
    out(JSON.stringify({ tool: "cowork-harness", command: "boundary-check", pass: results.every((r) => r.pass), results }));
  } else {
    log(formatBoundary(results));
  }
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}

function cmdSync(args: string[]) {
  // Q3: platform guard fires before arg parsing — wrong platform is an environment error, not a usage error.
  if (process.platform !== "darwin") {
    log("sync requires macOS (the Cowork Desktop app is macOS-only).");
    return process.exit(2);
  }
  // Bug 6: use parseArgs to reject unknown flags and positionals.
  // Bug 26: accept --force as a canonical alias for --allow-empty; normalize before parsing.
  const normalizedArgs = args.map((a) => (a === "--force" ? "--allow-empty" : a));
  let syncParsed;
  try {
    syncParsed = parseArgs(normalizedArgs, { booleans: ["--diff", "--allow-empty"] });
  } catch (e) {
    log((e as Error).message);
    return process.exit(2);
  }
  if (syncParsed.positionals.length > 0) {
    log(`sync takes no positional arguments (got: ${syncParsed.positionals.join(", ")})`);
    return process.exit(2);
  }
  const allowEmpty = !!syncParsed.flags["--allow-empty"];
  const res = sync();

  // #37 — refuse to write a baseline with empty version fields. An empty appVersion would produce
  // `desktop-.json` (invalid filename); an empty agentVersion means resolveAgentBinary will fail.
  const versionErrors: string[] = [];
  if (!res.appVersion) versionErrors.push("appVersion (Desktop not found or Info.plist unreadable — install/open Claude Desktop)");
  if (!res.agentVersion) versionErrors.push("agentVersion (.sdk-version missing — open Cowork once to stage the agent binary)");
  if (versionErrors.length) {
    log("ERROR: sync could not resolve required version fields — refusing to write baseline:");
    for (const e of versionErrors) log(`  - ${e}`);
    log("Fix the above, then re-run `cowork-harness sync`.");
    process.exit(1);
  }

  // #41 — refuse to write a baseline with an empty allowlist unless --allow-empty is passed.
  // An empty allowDomains = default-deny on ALL egress, which silently breaks every scenario.
  if (res.allowDomains.length === 0) {
    log("WARNING: sync produced an empty allowDomains list (asar domain regex matched nothing — asar layout moved).");
    if (!allowEmpty) {
      log("Refusing to write baseline with allowDomains: []. Fix the regex in cowork-sync.ts,");
      log("or hand-edit network.allowDomains in an existing baseline, then re-run.");
      log("Pass --allow-empty to force-write anyway (use only if you understand the egress impact).");
      process.exit(1);
    }
    log("--allow-empty passed: proceeding with empty allowDomains (egress will be default-deny for ALL domains).");
  }

  const baselinePath = join(BASELINES_DIR, `desktop-${res.appVersion}.json`);
  let base: Record<string, unknown>;
  try {
    base = JSON.parse(JSON.stringify(loadBaseline("latest")));
  } catch {
    throw new Error("No base baseline in baselines/. Commit one (e.g. desktop-<ver>.json) before sync can merge onto it.");
  }

  // #38 — recompute agentBinary.stagedPath when agentVersion changes.
  // Strategy: derive the path by convention (same layout as in the committed baselines:
  //   ~/Library/Application Support/Claude/claude-code-vm/<agentVersion>/claude)
  // then VERIFY the derived path exists, because resolveAgentBinary (baseline.ts:16) will fail
  // on a stale path. We warn loudly rather than blocking — the file may not be staged yet on this
  // machine, but the path is the correct convention for the new version.
  const baseAgentBinary = (base.agentBinary ?? {}) as Record<string, unknown>;
  const oldStagedPath = (baseAgentBinary.stagedPath as string) ?? "";
  // Replace the version segment in the staged path with the new agentVersion. Gate on whether the regex
  // actually MATCHED (not result==input) — an unchanged-version re-sync produces result==input and must NOT
  // warn; an empty/non-standard layout falls back to the canonical Desktop path so the pointer isn't stale.
  const versionRe = /claude-code-vm\/[^/]+\/claude$/;
  let derivedStagedPath: string;
  if (versionRe.test(oldStagedPath)) {
    derivedStagedPath = oldStagedPath.replace(versionRe, `claude-code-vm/${res.agentVersion}/claude`);
  } else {
    derivedStagedPath = `~/Library/Application Support/Claude/claude-code-vm/${res.agentVersion}/claude`;
    if (oldStagedPath)
      log(
        `WARNING: agentBinary.stagedPath layout was unexpected ("${oldStagedPath}") — rewrote to the canonical path for ${res.agentVersion}.`,
      );
  }
  const resolvedDerived = derivedStagedPath.replace(/^~(?=$|\/)/, join(process.env.HOME ?? "~"));
  if (!existsSync(resolvedDerived)) {
    log(`WARNING: derived agentBinary.stagedPath does not exist on this machine: ${derivedStagedPath}`);
    log(`  (The new agentVersion is ${res.agentVersion}. Open Cowork once to stage the binary, then re-run sync.)`);
    log(`  resolveAgentBinary will fail until the file is present or COWORK_AGENT_BINARY is set.`);
  }
  const nextAgentBinary = { ...baseAgentBinary, stagedPath: derivedStagedPath };

  // #39 — re-sync GrowthBook gate states from the decoded fcache (was: stale-carry + blanket warning).
  // Gates drive the cowork loop decision (decideLoopFromBaseline) and the dispatch cap; decoding the
  // fcache here makes a re-sync refresh them and surfaces real drift instead of silently carrying stale.
  const baseProvenance = (base.provenance ?? {}) as Record<string, unknown>;
  const baseGates = (baseProvenance.gates ?? {}) as Record<string, unknown>;
  let nextGates: Record<string, unknown> = baseGates;
  if (res.gates) {
    nextGates = {};
    // Preserve authored $comment / any non-pinned keys from the base.
    for (const [k, v] of Object.entries(baseGates)) if (k.startsWith("$")) nextGates[k] = v;
    for (const g of Object.values(res.gates)) {
      const key = `${g.name}:${g.id}`;
      const prev = baseGates[key];
      const prevOn = typeof prev === "string" ? /on|true|force/i.test(prev) : !!(prev as { on?: boolean } | undefined)?.on;
      // Preserve the human annotation: from a prose string, drop the leading "on(force) " token; from
      // a structured entry, keep its `note`.
      const prevNote =
        typeof prev === "string"
          ? prev.replace(/^(on|off)\([^)]*\)\s*/i, "").trim()
          : ((prev as { note?: string } | undefined)?.note ?? "").trim();
      nextGates[key] = { on: g.on, source: g.source, value: g.value, ...(prevNote ? { note: prevNote } : {}) };
      if (prev !== undefined && prevOn !== g.on) {
        log(
          `WARNING: gate ${key} DRIFTED: ${prevOn ? "on" : "off"} → ${g.on ? "on" : "off"} (source=${g.source}). Loop/dispatch behavior may change — review carefully.`,
        );
      }
    }
    // A pinned gate absent from THIS fcache (partial cache) would otherwise vanish from provenance,
    // silently dropping a loop/dispatch-driving gate. Carry it forward from the base and flag it.
    for (const [k, v] of Object.entries(baseGates)) {
      if (k.startsWith("$") || k in nextGates) continue;
      nextGates[k] = v;
      log(`WARNING: gate ${k} not present in fcache this sync — carried forward from base (may be stale).`);
    }
    log(`gates: re-synced ${Object.values(res.gates).length} pinned gate states from fcache.`);
  } else {
    log("WARNING: fcache unreadable — provenance.gates carried over from base (may be stale).");
  }
  const prevFingerprint = baseProvenance.asarFingerprint as string | undefined;
  if (prevFingerprint && prevFingerprint !== res.asarFingerprint) {
    log(`note: asarFingerprint changed (${prevFingerprint} → ${res.asarFingerprint}); gates re-synced above.`);
  }

  const next = {
    ...base,
    baselineVersion: 1,
    appVersion: res.appVersion,
    capturedAt: new Date().toISOString().slice(0, 10),
    agentVersion: res.agentVersion,
    agentBinary: nextAgentBinary,
    network: { ...(base.network as object), mode: res.networkMode ?? "gvisor", allowKind: "allowlist", allowDomains: res.allowDomains },
    requireFullVmSandbox: res.requireFullVmSandbox,
    provenance: { ...baseProvenance, gates: nextGates, asarFingerprint: res.asarFingerprint },
  };
  const diffFlag = !!syncParsed.flags["--diff"];
  if (diffFlag) {
    try {
      const prev = JSON.parse(readFileSync(baselinePath, "utf8"));
      log("=== diff vs committed baseline ===");
      diff(prev, next, "");
    } catch {
      log(`(no committed ${baselinePath} yet — this would be the first)`);
    }
  }
  if (res.unknownDeltas.length) {
    log("\n⚠ unknown deltas (extend src/sync/cowork-sync.ts):");
    for (const d of res.unknownDeltas) log("   - " + d);
    // Bug 23: unknown deltas block the write unless --diff (diagnosis mode) is active.
    if (!diffFlag && !allowEmpty) {
      log("Refusing to write baseline with unknown deltas. Fix src/sync/cowork-sync.ts or pass --allow-empty to force-write.");
      process.exit(1);
    }
  }
  if (!diffFlag) {
    mkdirSync(BASELINES_DIR, { recursive: true });
    writeFileSync(baselinePath, JSON.stringify(next, null, 2));
    log(`wrote ${baselinePath}`);
    // F-3: the host-loop prompt asset is hand-authored (not extracted), so a new LEGACY baseline silently
    // lands WITHOUT it — and every host-loop record then runs with an EMPTY shell-access section. Warn loudly
    // here, tying the missing asset to the baseline just synced (mirrors the agentBinary.stagedPath warn).
    // Generator-era versions (>= 1.14271.0) build the section dynamically from mount state and ship NO static
    // asset, so the warning must be version-scoped — otherwise sync nags forever for a file we don't want.
    if (cmpVersionStrings(res.appVersion, "1.14271.0") < 0) {
      const hostLoopAsset = join(BASELINES_DIR, "prompts", `desktop-${res.appVersion}`, "host-loop-append.md");
      if (!existsSync(hostLoopAsset)) {
        log(
          `WARNING: host-loop prompt asset missing for the synced baseline: ${hostLoopAsset} — host-loop records will run with an EMPTY shell-access section. ` +
            `Author it (carry forward baselines/prompts/desktop-1.12603.1/host-loop-append.md and verify against the desktop-${res.appVersion} asar).`,
        );
      }
    }
  }
}

function cmdList(args: string[] = []) {
  // Bug 7: reject unknown flags and positionals.
  // Bug 23: accept --output-format with enum validation so the advertised flag isn't rejected.
  ensureOutputFormat("list", args);
  const json = isJsonOutput(args);
  let listParsed;
  try {
    listParsed = parseArgs(args, { values: ["--output-format"], enums: { "--output-format": ["text", "json"] } });
  } catch (e) {
    log((e as Error).message);
    return process.exit(2);
  }
  if (listParsed.positionals.length > 0) {
    log(`list takes no positional arguments (got: ${listParsed.positionals.join(", ")})`);
    return process.exit(2);
  }
  const files = readdirSync(BASELINES_DIR).filter((f) => f.endsWith(".json"));
  if (json) {
    // emit a JSON array of objects (filename + name stem) to stdout
    out(
      JSON.stringify(
        files.map((f) => ({ file: f, name: f.replace(/\.json$/, "") })),
        null,
        2,
      ),
    );
  } else {
    for (const f of files) out(f);
  }
}

/** `decide` — validate a decider (helper OR policy) against a sample question in ~2s, so you don't
 *  discover a wire-protocol bug 12 minutes into a live run. Shows the exact request a `--decider-cmd`
 *  helper receives and the answer it produced (or the protocol error); for `--answer`/`--answer-policy`
 *  it shows which rule matched. */
async function cmdDecide(args: string[]) {
  ensureOutputFormat("decide", args);
  const json = isJsonOutput(args);
  let question = "Confirm the detected stage before proceeding?";
  const options: string[] = [];
  let deciderCmd: string | undefined;
  let policy: string | undefined;
  let deciderLlm = false;
  let intent: string | undefined;
  const rules: AnswerRule[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--question")
      question = flagValueStrict(args, i++, a); // #58: bounds-checked; Bug 30: rejects flag-looking values
    else if (a === "--option") options.push(flagValueStrict(args, i++, a));
    else if (a === "--decider-cmd") {
      deciderCmd = flagValue(args, i++, a);
      // The helper command is never a flag — reject a flag-looking value so `--decider-cmd --question`
      // doesn't silently swallow the next flag as the command.
      if (deciderCmd.startsWith("-"))
        fail("decide", "usage", `--decider-cmd: missing value (got flag-looking "${deciderCmd}")`, undefined, json);
    } else if (a === "--decider-llm") deciderLlm = true;
    else if (a === "--intent") intent = flagValueStrict(args, i++, a);
    else if (a === "--answer-policy") policy = flagValueStrict(args, i++, a);
    else if (a === "--answer") {
      const raw = flagValueStrict(args, i++, a);
      const parts = splitEq(raw);
      if (!parts)
        fail("decide", "usage", `--answer requires "question-regex=choice" (got "${raw}" — both sides must be non-empty)`, undefined, json);
      const [q, choose] = parts!;
      rules.push({ when_question: q, choose });
    }
    // --output-format consumes a value in the equals-free form; skip it so its value isn't read as a
    // stray positional (isJsonOutput/ensureOutputFormat handle the actual parsing).
    else if (a === "--output-format") i++;
    // --decider-dir is rejected explicitly below with a redirect message; consume its value here so the
    // value isn't flagged as a stray positional before that guard fires.
    // Bug 12: check that the next token exists and doesn't look like a flag before consuming it.
    else if (a === "--decider-dir") {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("-"))
        fail(
          "decide",
          "usage",
          `--decider-dir: missing value (got ${v === undefined ? "nothing" : `flag-looking "${v}"`})`,
          undefined,
          json,
        );
      i++;
    } else if (a === "--quiet" || a === "-q" || a === "--verbose" || a === "-V") {
      /* accepted but currently a no-op in decide — wired for flag consistency (§2.1) */
    }
    // an unrecognized `--`-prefixed token used to be silently ignored (the loop had no else).
    else if (a.startsWith("--") && a !== "--output-format=json" && a !== "--output-format=text")
      fail("decide", "usage", `unknown flag: ${a}`, undefined, json);
    // single-dash flags other than -q/-V are unknown; reject them explicitly (don't silently swallow -x etc.)
    else if (a.startsWith("-")) fail("decide", "usage", `unknown flag: ${a}`, undefined, json);
    // decide takes NO positionals (the sample question comes from --question, not a positional).
    else fail("decide", "usage", `decide takes no positional arguments (got: ${a})`, undefined, json);
  }
  // #13: `decide` does not implement the file-rendezvous channel — reject `--decider-dir` loudly
  // instead of silently ignoring a first-class runtime path.
  if (args.includes("--decider-dir"))
    fail(
      "decide",
      "usage",
      "decide does not support --decider-dir (the file-rendezvous channel); validate that path by running a scenario with --decider-dir. Use --decider-cmd '<helper>' to check a spawned helper here.",
      undefined,
      json,
    );
  // --intent only feeds the LLM decider; check this before the no-decider guard so the error is
  // specific ("--intent requires --decider-llm") rather than the generic "no decider configured".
  if (intent !== undefined && !deciderLlm)
    fail(
      "decide",
      "usage",
      "--intent requires --decider-llm (it states the test intent for the model answering the question).",
      undefined,
      json,
    );
  // Q5/§8.5: pre-flight — exit 2 (usage error) when no decider is configured at all. Previously this
  // fell through to ScriptedDecider([]).decide() → ABSTAIN → exit 1 "no rule matched", which implies
  // the user wrote a rule that failed to match rather than that they forgot to configure anything.
  if (!deciderLlm && !deciderCmd && rules.length === 0 && !policy)
    fail(
      "decide",
      "usage",
      "no decider configured — pass --decider-cmd '<helper>', --decider-llm, --answer \"<rx>=<label>\", or --answer-policy <yaml>.",
      undefined,
      json,
    );
  // #14: reject conflicting terminal deciders — both set, the LLM branch would silently win and the
  // helper would never be exercised. Mirrors cmdSkill/resolveExternal's conflict guards.
  if (deciderLlm && deciderCmd)
    fail("decide", "usage", "--decider-llm conflicts with --decider-cmd (one terminal decider).", undefined, json);
  // --decider-llm is a terminal decider; combining it with the scripted --answer/--answer-policy
  // rules is contradictory (the LLM branch wins, the rules are never exercised). Reject the conflict the
  // same way --decider-llm + --decider-cmd is rejected above.
  if (deciderLlm && (rules.length || policy))
    fail(
      "decide",
      "usage",
      "--decider-llm conflicts with --answer/--answer-policy (one terminal decider — the scripted rules would never be used).",
      undefined,
      json,
    );
  if (policy) rules.push(...loadAnswerPolicy("decide", policy, json));
  const opts = options.length ? options : ["Looks right", "Change it", "Correct or add data"];
  const req: DecisionRequest = { id: "check", kind: "question", questions: [{ question, options: opts.map((label) => ({ label })) }] };
  const ctx = { task: "", transcript: () => "(sample transcript context)", toolLog: () => [], runId: "decide-check" };

  log(`sample question: "${question}"  options: [${opts.join(" | ")}]`);
  try {
    if (deciderLlm) {
      const d = await new LlmDecider(claudeCliComplete, intent).decide(req, ctx);
      const answer = (d as { response: { answers?: Record<string, string> }; model?: string }).response.answers?.[question];
      if (json) out(JSON.stringify({ tool: "cowork-harness", command: "decide", ok: true, answer, by: "llm" }));
      else log(`✓ LLM decider answered: "${question}" → "${answer}"  (non-deterministic)`);
    } else if (deciderCmd) {
      const inner = spawnChannel(deciderCmd);
      let sent = "";
      const channel = {
        write: (l: string) => ((sent = l), inner.write(l)),
        readLine: () => inner.readLine(),
        close: () => inner.close?.(),
      };
      try {
        const d = await new ExternalDecider(channel).decide(req, ctx);
        const answer = (d as { response: { answers?: Record<string, string> } }).response.answers?.[question];
        log(`helper received: ${sent}`);
        if (json) out(JSON.stringify({ tool: "cowork-harness", command: "decide", ok: true, answer }));
        else log(`✓ helper answered: "${question}" → "${answer}"`);
      } finally {
        channel.close();
      }
    } else {
      const d = await new ScriptedDecider(rules).decide(req, ctx);
      if (d === ABSTAIN) {
        if (json) out(JSON.stringify({ tool: "cowork-harness", command: "decide", ok: false, matched: false }));
        else log(`✗ no rule matched — this question would fall to --on-unanswered (add an --answer/--answer-policy rule)`);
        process.exit(1);
      }
      const answer = (d as { response: { answers?: Record<string, string> } }).response.answers?.[question];
      if (json) out(JSON.stringify({ tool: "cowork-harness", command: "decide", ok: true, matched: true, answer }));
      else log(`✓ rule matched: "${question}" → "${answer}"`);
    }
  } catch (e) {
    if (json) out(jsonError("decide", "runtime", String((e as Error).message)));
    else log(`✗ decider error: ${String((e as Error).message)}`);
    process.exit(1);
  }
}

/** `gates <dir> [--follow]` — the gate stream for the in-band `--decider-dir` path. Emits one clean
 *  JSON line per pending gate (`{seq, …decision_request}`) + a terminal `{"done":true}`. Point ONE
 *  Monitor at this (no hand-written zsh/find/seen-set loop). */
async function cmdGates(args: string[]) {
  ensureOutputFormat("gates", args);
  // Reject unknown flags rather than silently ignoring a typo.
  rejectUnknownFlags("gates", args, ["--follow", "--output-format", "--output-format=json", "--output-format=text"], isJsonOutput(args));
  const follow = args.includes("--follow");
  // skip the `--output-format` value so `gates --output-format json <dir>` doesn't read `json`
  // as the directory.
  const dir = positionals(args, ["--output-format"])[0];
  if (!dir) return void fail("gates", "usage", "usage: gates <dir> [--follow]", undefined, isJsonOutput(args));
  // Reject extra positionals rather than silently using the first.
  if (positionals(args, ["--output-format"]).length > 1)
    return void fail("gates", "usage", "gates takes one <dir>", undefined, isJsonOutput(args));
  await streamGates(dir, (line) => out(line), { once: !follow });
}

/** `answer <dir> --gate <N> (--choose <label> | --answer "<q>=<label>"…)` — write a gate answer
 *  atomically with the right wire shape (hides the temp+rename + `{id, answers}` the driver had to build). */
function cmdAnswer(args: string[]) {
  // Bug 29: validate --output-format before isJsonOutput so an unrecognized value is a usage error.
  ensureOutputFormat("answer", args);
  const json = isJsonOutput(args);
  // #15: skip flag values so `answer --gate 1 --choose Yes <dir>` doesn't read `1` as the directory.
  const dir = positionals(args, ["--gate", "--choose", "--answer", "--output-format"])[0];
  let seq: number | undefined;
  // --choose accumulates: a single value answers a single-select gate; multiple values answer a
  // multiSelect gate (validated once the gate is read — a multi --choose on a single-select gate is
  // rejected below, preserving the old "only one allowed" rule for that case).
  const chooses: string[] = [];
  const pairs: { q: string; label: string }[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--gate")
      seq = Number(flagValue(args, i++, a)); // #58: bounds-checked
    else if (a === "--choose") {
      chooses.push(flagValueStrict(args, i++, a));
    } else if (a === "--answer") {
      const raw = flagValueStrict(args, i++, a);
      const parts = splitEq(raw);
      if (!parts)
        return void fail(
          "answer",
          "usage",
          `--answer requires "question=choice" (got "${raw}" — both sides must be non-empty)`,
          undefined,
          json,
        );
      const [q, label] = parts;
      pairs.push({ q, label });
    } else if (a === "--output-format") {
      i++; // skip value — already parsed by isJsonOutput above
    } else if (a === "--output-format=json" || a === "--output-format=text") {
      // no-op — already handled by isJsonOutput
    } else if (a.startsWith("-")) {
      // Bug 10: reject unknown flags
      return void fail("answer", "usage", `unknown flag: ${a}`, undefined, json);
    }
    // positionals already handled above via positionals() helper
  }
  // Bug 11: reject conflicting --choose and --answer
  if (chooses.length > 0 && pairs.length > 0) return void fail("answer", "usage", "cannot use both --choose and --answer", undefined, json);
  if (!dir)
    return void fail("answer", "usage", 'usage: answer <dir> --gate <N> (--choose <label> | --answer "<q>=<label>")', undefined, json);
  // A gate sequence is a positive integer; `!seq` alone admitted negatives/fractions, which then built
  // odd gate file names. Require a safe positive integer.
  if (seq === undefined || !Number.isSafeInteger(seq) || seq <= 0)
    return void fail(
      "answer",
      "usage",
      `--gate must be a positive integer (got ${seq === undefined ? "nothing" : `"${seq}"`})`,
      undefined,
      json,
    );
  const answers: Record<string, string | string[]> = {};
  if (pairs.length) for (const p of pairs) answers[p.q] = p.label;
  else if (chooses.length) {
    let g: ReturnType<typeof readGate>;
    try {
      g = readGate(dir, seq);
    } catch (e) {
      return void fail("answer", "usage", `cannot read gate ${seq} in ${dir}: ${String((e as Error).message)}`, undefined, json);
    }
    const q0 = g.questions?.[0];
    // A multi --choose answers a multiSelect gate; on a single-select gate it's the old "only one
    // allowed" error (now deferred to here, where we know the gate's kind).
    if (chooses.length > 1 && !q0?.multiSelect)
      return void fail(
        "answer",
        "usage",
        `--choose may only be specified once for gate ${seq} (it is not a multiSelect gate)`,
        undefined,
        json,
      );
    // Validate each chosen label at write time so a typo fails HERE (located, immediate) instead of only
    // later when the run consumes the answer. Use the decider's own coerceLabel so the CLI accepts
    // exactly what the run would (exact / case-insensitive / 1-based index). An options-less (free-text)
    // gate skips the check; an "Other" free-text reply should use --answer, not --choose.
    const labels = (q0?.options ?? []).map((o) => o.label).filter((l): l is string => typeof l === "string");
    if (labels.length)
      for (const c of chooses)
        if (!coerceLabel(c, labels).matched)
          return void fail(
            "answer",
            "usage",
            `--choose "${c}" is not an option for gate ${seq}. Options: ${labels.join(", ")}. (Use --answer "<q>=<text>" for a free-text "Other" reply.)`,
            undefined,
            json,
          );
    const key = q0?.question ?? q0?.header ?? "";
    // multiSelect → write the ARRAY (the on-wire shape normalize expects); single-select → the scalar.
    answers[key] = q0?.multiSelect ? chooses : chooses[0];
  } else return void fail("answer", "usage", 'answer needs --choose <label> or --answer "<q>=<label>"', undefined, json);
  answerGate(dir, seq, answers);
  if (json) out(JSON.stringify({ tool: "cowork-harness", command: "answer", ok: true, gate: seq, answers }));
  else log(`✓ answered gate ${seq}: ${JSON.stringify(answers)}`);
}

/** `scaffold --from-run <id>` — turn a kept run into a starter scenario YAML (observed gates → answers,
 *  artifacts → file_exists, the prompt). Authoring becomes explore→lock instead of guess-and-re-run. */
function cmdScaffold(args: string[]) {
  const json = isJsonOutput(args);
  // validate --output-format is text|json — an invalid value was a silent text degrade (only
  // isJsonOutput was consulted), unlike decide/gates/trace.
  ensureOutputFormat("scaffold", args);
  // Reject unknown flags rather than silently ignoring a typo (e.g. `--form-run`).
  rejectUnknownFlags("scaffold", args, ["--from-run", "--out", "--output-format", "--output-format=json", "--output-format=text"], json);

  // Validate --out FIRST (flag-looking value is a usage error regardless of --from-run presence).
  const outIdx = args.indexOf("--out");
  let outPath: string | undefined;
  if (outIdx >= 0) {
    outPath = flagValue(args, outIdx, "--out");
    if (outPath.startsWith("-"))
      return void fail("scaffold", "usage", `--out requires a file path, got a flag: ${outPath}`, undefined, json);
  }

  // Validate --from-run flag-looking value before computing positionals (so the error is specific).
  const fromIdx = args.indexOf("--from-run");
  let fromRunVal: string | undefined;
  if (fromIdx >= 0) {
    fromRunVal = flagValue(args, fromIdx, "--from-run");
    if (fromRunVal.startsWith("-"))
      return void fail("scaffold", "usage", `--from-run requires a run id/dir, got a flag: ${fromRunVal}`, undefined, json);
    log("note: --from-run is deprecated; prefer: scaffold <run-id | run-dir>\n");
  }

  // Positional is canonical; --from-run is a backward-compatible alias.
  const positional = positionals(args, ["--from-run", "--out", "--output-format"])[0];
  if (positional && fromRunVal && positional !== fromRunVal)
    return void fail("scaffold", "usage", "provide the run id as a positional OR via --from-run, not both", undefined, json);
  const target = positional ?? fromRunVal;
  if (!target) return void fail("scaffold", "usage", "usage: scaffold <run-id | run-dir> [--out <file.yaml>]", undefined, json);
  let file: string;
  try {
    file = resolveEventsFile(target);
  } catch (e) {
    return void fail("scaffold", "usage", String((e as Error).message), undefined, json);
  }
  const yaml = buildScaffold(file);
  if (outPath !== undefined) {
    writeFileSync(outPath, yaml);
    log(`✓ scaffolded scenario → ${outPath}`);
  } else out(yaml);
}

/** Read the persisted transcript from a kept run's `run.jsonl` (the `{t:"transcript"}` line).
 *  Returns `null` when the sidecar is absent or unreadable — distinct from an empty-but-present transcript.
 *  Returns `""` when the file is readable but contains no transcript line (run produced no model output). */
function readTranscriptSidecar(file: string): string | null {
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const o = JSON.parse(line);
      if (o && o.t === "transcript") return String(o.text ?? "");
    }
    return ""; // file readable but no transcript line — empty transcript (not missing)
  } catch {
    return null;
  }
}

/** Read the AskUserQuestion question texts from a kept run's `trace.json` (`questions` array).
 *  Returns `null` when the sidecar is absent or unreadable — distinct from a run with zero questions. */
function readQuestionsSidecar(file: string): string[] | null {
  try {
    const t = JSON.parse(readFileSync(file, "utf8"));
    if (Array.isArray(t.questions)) return t.questions.map(String);
    return null;
  } catch {
    return null;
  }
}

/**
 * F-1: `verify-run <run-dir> <scenario.yaml>` — re-evaluate a scenario's `assert:` block against an
 * already-kept run dir, WITHOUT a live agent (no tokens, no Docker). Fixing a wrong assertion was previously
 * a full live re-record (~17 min); this turns it into ~1s. Reconstructs the AssertContext from the run dir's
 * persisted `result.json` + the `run.jsonl`/`trace.json` sidecars (transcript + questions live there, not in
 * result.json), reproduces the `expect_denied` expansion that `evaluate()` doesn't do, and routes the verdict
 * through the same `computeVerdict(…, "live")` as a real record.
 *
 * Limits (vs a fresh live record): sidecars are SCRUBBED at record time, so an assertion over a redacted
 * secret value is not faithfully re-checkable; and filesystem assertions (`file_exists`/`artifact_json`/
 * `user_visible_artifact`) need the run's `workDir` to still exist on disk — if it's gone (container/microvm
 * teardown), verify-run refuses rather than false-failing them.
 */
function cmdVerifyRun(args: string[]) {
  let p;
  try {
    p = parseArgs(args, { values: ["--output-format"], enums: { "--output-format": ["text", "json"] } });
  } catch (e) {
    log((e as Error).message);
    return process.exit(2);
  }
  const json = p.options["--output-format"] === "json";
  const [runDir, scenarioFile] = p.positionals;
  if (!runDir || !scenarioFile) {
    log("usage: verify-run <run-dir> <scenario.yaml> [--output-format json]");
    return process.exit(2);
  }
  if (p.positionals.length > 2) {
    log(`verify-run takes <run-dir> <scenario.yaml> (got ${p.positionals.length}: ${p.positionals.join(", ")})`);
    return process.exit(2);
  }
  const resultPath = join(runDir, "result.json");
  if (!existsSync(resultPath)) {
    log(`verify-run: no result.json under ${runDir} (is this a kept run dir? e.g. runs/<scenario>/<sessionId>/)`);
    return process.exit(2);
  }
  let result: RunResult;
  try {
    result = JSON.parse(readFileSync(resultPath, "utf8")) as RunResult;
  } catch (e) {
    log(`verify-run: cannot read ${resultPath}: ${(e as Error).message}`);
    return process.exit(2);
  }
  let scenario;
  try {
    scenario = parseScenarioFile(scenarioFile);
  } catch (e) {
    log(`verify-run: cannot load scenario ${scenarioFile}: ${(e as Error).message}`);
    return process.exit(2);
  }

  const workRoot = result.workDir ?? "";
  const scan = result.scan ?? { outputsDeletes: [], hostPathLeaked: false, selfHealRan: false };
  // FS-class assertions resolve under workRoot; if it's gone we can't faithfully re-check them — refuse
  // rather than report a false fail. Content-only re-asserts stay valid without it.
  const FS_KEYS: (keyof Assertion)[] = ["file_exists", "user_visible_artifact", "artifact_json"];
  const hasFsAssert = scenario.assert.some((a) => FS_KEYS.some((k) => a[k] !== undefined));
  if (hasFsAssert && !existsSync(workRoot)) {
    log(
      `verify-run: work dir not found (${workRoot || "<unset>"}) — filesystem assertions ` +
        `(file_exists/artifact_json/user_visible_artifact) cannot be re-evaluated from this run dir; re-record. (can't verify ⇒ not green)`,
    );
    return process.exit(2);
  }

  const sidecarTranscript = readTranscriptSidecar(join(runDir, "run.jsonl"));
  const sidecarQuestions = readQuestionsSidecar(join(runDir, "trace.json"));
  const ctx: AssertContext = {
    transcript: sidecarTranscript ?? "",
    toolsCalled: new Set(Object.keys(result.toolCounts ?? {})),
    subagentTools: new Set((result.subagents ?? []).flatMap((s) => s.toolsUsed ?? [])),
    egress: result.egress ?? [],
    result: result.result === "error" ? "error" : "success",
    workRoot,
    userVisiblePrefixes: ["outputs", ".projects"],
    outputsDeletes: scan.outputsDeletes,
    questions: sidecarQuestions ?? [],
    hostPathLeaked: scan.hostPathLeaked,
    selfHealRan: scan.selfHealRan,
    subagents: result.subagents ?? [],
    gateDeliveries: result.gateDeliveries ?? [],
    toolResultTexts: (result.toolResults ?? []).map((r) => r.assertText ?? r.text),
    transcriptMissing: sidecarTranscript === null,
    questionsMissing: sidecarQuestions === null,
  };

  const assertions = evaluate(scenario.assert, ctx);
  // Reproduce execute.ts's expect_denied → egress_denied expansion (evaluate() does not handle it).
  for (const host of scenario.expect_denied) {
    assertions.push({
      assertion: { egress_denied: host },
      pass: ctx.egress.some((e) => hostMatches(e.host, host) && e.decision === "deny"),
      message: `expected ${host} to be denied`,
    });
  }

  // Verdict via the SAME path as a live record (the run dir is a live run, so the "live" lane honors the
  // scan/parity signals already persisted in result.json).
  const verdict = computeVerdict({ ...result, assertions }, "live");
  const failed = assertions.filter((a) => !a.pass);

  if (json) {
    out(
      JSON.stringify({
        command: "verify-run",
        pass: verdict.pass,
        assertions: assertions.map((a) => ({ assertion: a.assertion, pass: a.pass, message: a.message })),
        signals: verdict.signals,
      }),
    );
  } else {
    for (const a of assertions)
      log(`${a.pass ? "✓" : "✗"} ${Object.keys(a.assertion).join("+") || "(assertion)"}${a.message ? ` — ${a.message}` : ""}`);
    for (const s of verdict.signals.filter((s) => s.code !== "assertion"))
      log(`${s.severity === "fail" ? "✗" : "·"} ${s.code}: ${s.message}`);
    log(
      verdict.pass
        ? `✓ verify-run: all ${assertions.length} assertion(s) pass (no live agent)`
        : `✗ verify-run: ${failed.length}/${assertions.length} assertion(s) failed`,
    );
  }
  return process.exit(verdict.exitCode);
}

/** `assert --list` (#8) — enumerate the available assertion keys + one-line semantics, generated from the
 *  Zod `Assertion` schema (`Assertion.shape[k].description`) so the list can NEVER drift from the schema. */
function cmdAssert(args: string[]) {
  const json = isJsonOutput(args);
  // validate --output-format is text|json (an invalid value was a silent text degrade).
  ensureOutputFormat("assert", args);
  if (!args.includes("--list")) return void fail("assert", "usage", "usage: assert --list [--output-format json]", undefined, json);
  // `assert --list` takes no positionals and no other flags; reject stray ones rather than
  // silently ignoring them (e.g. `assert --list extra` or `assert --list --bogus`).
  const stray = positionals(args, ["--output-format"]);
  if (stray.length)
    return void fail("assert", "usage", `assert --list takes no positional arguments (got: ${stray.join(", ")})`, undefined, json);
  rejectUnknownFlags("assert", args, ["--list", "--output-format", "--output-format=json", "--output-format=text"], json);
  const shape = Assertion.shape as Record<string, { description?: string }>;
  const keys = Object.keys(shape).map((k) => ({ key: k, description: shape[k].description ?? "" }));
  if (json) return void out(JSON.stringify({ tool: "cowork-harness", command: "assert", assertions: keys }));
  const width = Math.max(...keys.map((k) => k.key.length));
  out(`available assertions (${keys.length}) — use under a scenario's \`assert:\` list:\n`);
  for (const { key, description } of keys) out(`  ${key.padEnd(width)}  ${description}`);
}

function cmdTrace(args: string[]) {
  ensureOutputFormat("trace", args);
  const json = isJsonOutput(args);

  // R8: --view tools|questions|dispatches replaces the three boolean flags. Legacy flags kept as aliases.
  const viewIdx = args.indexOf("--view");
  const viewEqMatch = args.find((a) => a.startsWith("--view="));
  let viewArg: string | undefined = viewEqMatch ? viewEqMatch.slice("--view=".length) : viewIdx >= 0 ? args[viewIdx + 1] : undefined;

  const VIEWS = ["tools", "questions", "dispatches"] as const;
  type View = (typeof VIEWS)[number];
  if (viewArg !== undefined && !VIEWS.includes(viewArg as View)) {
    fail("trace", "usage", `--view: expected one of ${VIEWS.join("|")}, got "${viewArg}"`, undefined, json);
    return;
  }

  // Legacy flag aliases: --tools → tools, --gates → questions (renamed; old --gates still accepted),
  // --dispatches → dispatches.
  const legacyTools = args.includes("--tools");
  const legacyGates = args.includes("--gates");
  const legacyDispatches = args.includes("--dispatches");
  const legacyCount = [legacyTools, legacyGates, legacyDispatches].filter(Boolean).length;
  if (viewArg !== undefined && legacyCount > 0)
    fail("trace", "usage", "--view and legacy flags (--tools/--gates/--dispatches) are mutually exclusive", undefined, json);
  if (legacyCount > 1) fail("trace", "usage", "trace --tools/--gates/--dispatches are mutually exclusive (prefer --view)", undefined, json);
  if (legacyTools) viewArg = "tools";
  if (legacyGates) viewArg = "questions";
  if (legacyDispatches) viewArg = "dispatches";

  const view = viewArg as View | undefined;

  // Bug 28: reject unknown flags (typos like --ouput-format silently fell through before).
  rejectUnknownFlags(
    "trace",
    args,
    [
      "--view",
      "--output-format",
      "--output-format=json",
      "--output-format=text",
      "--tools",
      "--gates",
      "--dispatches", // legacy aliases
    ],
    json,
  );

  // #16: skip the `--output-format` and `--view` values so they don't get treated as the target path.
  const allPositionals = positionals(args, ["--output-format", "--view"]);
  const target = allPositionals[0];
  // trace takes exactly one target; reject stray positionals rather than silently using the first.
  if (allPositionals.length > 1)
    fail(
      "trace",
      "usage",
      `trace takes a single <run-id | run-dir | events.jsonl> (got ${allPositionals.length}: ${allPositionals.join(", ")})`,
      undefined,
      json,
    );
  if (!target)
    fail(
      "trace",
      "usage",
      "usage: trace <run-id | run-dir | events.jsonl> [--view tools|questions|dispatches] [--output-format json]",
      undefined,
      json,
    );
  let file: string;
  try {
    file = resolveEventsFile(target!);
  } catch (e) {
    return fail("trace", "usage", String((e as Error).message), undefined, json);
  }
  if (view === "questions") {
    // questions view: question → injected answer → delivered result, the full gate lifecycle (Part 4).
    const rows = buildGateTrace(file);
    if (json) out(JSON.stringify({ tool: "cowork-harness", command: "trace", file, gates: rows }));
    else out(formatGateTrace(rows));
    return;
  }
  if (view === "dispatches") {
    // dispatches view: the sub-agent dispatch tree + the real total (read off dispatch_count_max).
    const tree = buildDispatchTree(file);
    if (json) out(JSON.stringify({ tool: "cowork-harness", command: "trace", file, dispatches: tree.nodes, total: tree.total }));
    else out(formatDispatchTree(tree));
    return;
  }
  const rows = buildTrace(file, { tools: view === "tools" });
  if (json) out(JSON.stringify({ tool: "cowork-harness", command: "trace", file, rows }));
  else out(formatTrace(rows));
}

function diff(a: any, b: any, path: string) {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const k of keys) {
    const pa = JSON.stringify(a?.[k]);
    const pb = JSON.stringify(b?.[k]);
    if (pa !== pb) log(`  ${path}${k}: ${pa} -> ${pb}`);
  }
}

main().catch((e) => {
  const command = process.argv[2] ?? "";
  const json = isJsonOutput(process.argv.slice(2));
  if (e instanceof UnansweredError) fail(command, "unanswered", e.message, e.hint, json);
  if (e instanceof BoundaryError) fail(command, "boundary", e.message, undefined, json);
  // runtime/unexpected: keep the stack on stderr for humans; a structured envelope on stdout for json.
  if (json) out(jsonError(command, "internal", String(e?.message ?? e)));
  else log(String(e?.stack ?? e));
  process.exit(2);
});
