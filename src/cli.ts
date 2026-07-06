#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, writeSync, existsSync, copyFileSync } from "node:fs";
import { join, basename, resolve, isAbsolute, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { Scenario, AnswerRule, Assertion, type RunResult, type RunStatus, type PlatformBaseline } from "./types.js";
import { loadBaseline, BASELINES_DIR, cmpVersionStrings, sha256File } from "./baseline.js";
import { loadSession, resolveSessionPaths, applySessionOverrides } from "./session.js";
import {
  executeScenario,
  parseScenarioFile,
  loadSessionFromFile,
  UnansweredError,
  BoundaryError,
  UsageError,
  type ExecuteOptions,
} from "./run/execute.js";
import {
  ScriptedDecider,
  ExternalDecider,
  LlmDecider,
  ABSTAIN,
  coerceLabel,
  type OnUnanswered,
  type RunContext,
} from "./decide/decider.js";
import { claudeCliComplete } from "./decide/llm-transport.js";
import { toDecisionRequest, type DecisionRequest } from "./agent/session.js";
import { vmInit, vmDelete, vmStatus, vmPrune, instanceName } from "./runtime/lima.js";
import { sync, canonicalizeEnv } from "./sync/cowork-sync.js";
import { diffBaselines, formatDiffLines, renderChangelog } from "./sync/baseline-diff.js";
import { runBoundaryChecks, formatBoundary } from "./boundary.js";
import { cmdChat } from "./run/chat.js";
import { cmdRecord, cmdReplay, cmdVerifyCassettes, cmdRehash, buildFingerprint, fingerprintSkillDrift } from "./run/cassette.js";
import { cmdRunsGc } from "./run/runs-gc.js";
import { resolveInputs } from "./run/inputs.js";
import { cmdLint } from "./run/scenario-tool.js";
import { cmdDoctor } from "./run/doctor.js";
import { readRunStatus, hasRunStatus, followRunStatus, resolveStatusDir, isStatusStale } from "./run/run-status.js";
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
  buildToolDurations,
  formatToolDurations,
  noteRunsLocation,
  eventsFromLines,
  runsRoot,
} from "./run/trace-view.js";
import { loadVmPathContext } from "./run/vm-path-ctx-file.js";
import { makeDisplayTranslator, linkifyForTerminal, shouldLinkify } from "./run/display-translate.js";
import { readIndex, reindexFromRunsTree, buildStats, resolveRunsFromIndex, type RunIndexRow, type StatsSummary } from "./run/run-index.js";
import {
  canonicalizeInput,
  diffToolSequence,
  diffTranscript,
  diffMeta,
  diffArtifacts,
  type NormalizedToolRow,
  type DiffMetaSummary,
  type ToolDiffOp,
  type TranscriptDiffLine,
  type MetaDiffEntry,
} from "./run/diff.js";
import type { Cassette } from "./run/cassette.js";
import { buildScaffold } from "./run/scaffold.js";
import { buildInspectView } from "./run/inspect-view.js";
import { pkgVersion, jsonEnvelope, jsonError, parseOutputFormat, fail, isJsonOutput, type ErrCategory } from "./run/envelope.js";
import { buildRepeatRollup, rollupPasses, type RepeatRollup } from "./run/repeat.js";
import {
  MatrixFile,
  expandMatrix,
  buildMatrixRollup,
  formatMatrixRollup,
  matrixCellResultFromRun,
  axesLabel,
  buildMatrixRepeatRollup,
  formatMatrixRepeatRollup,
  type MatrixCellResult,
  type MatrixCellRepeatResult,
  type MatrixCell,
} from "./run/matrix.js";
import { pMapBounded } from "./async-pool.js";
import { computeVerdict } from "./run/verdict.js";
import { evaluate, hostMatches, budgetFields, type AssertContext } from "./assert.js";
import { spawnChannel, fileChannel, streamGates, answerGate, readGate, type DecisionChannel } from "./decide/external-channel.js";

// Synchronous writes (fd 1/2): `process.stdout.write` + `process.exit()` truncates on a PIPE, which
// would lose the json envelope for any agent/CI that pipes us. writeSync flushes before exit.
const out = (s: string) => writeSync(1, s + "\n"); // machine (stdout)
const log = (s: string) => writeSync(2, s + "\n"); // human (stderr)

// E3 (matrix runner) — mirrors record's own MAX_RECORD_CONCURRENCY bound (cassette.ts): above a handful,
// concurrent runs exhaust Docker's default address pool / model API rate limits.
const MAX_MATRIX_CONCURRENCY = 8;

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
      [--upload <file>]… [--folder <dir>]…   attach files / connect folders (mnt/uploads, mnt/<folder-name>)
      [--session-id <id> [--resume]]   pin + resume a session (for gated, checkpoint-and-resume skills)
      [--output-format text|json] [--quiet|-q] [--verbose] [--model <id>] [--keep] [--dry-run]
      (run 'skill --help' for the full flag reference)

  chat <folder>                interactive multi-turn REPL against a skill (TTY); --raw for native cowork
                               (--fidelity protocol|container|hostloop, default container; --model <id>)

── Automated scenarios ────────────────────────────────────────────────────────
  run <scenario.yaml | dir/>   run one scenario or every *.yaml in a dir (CI-ready exit code)
      [--on-unanswered fail|first]   ('prompt' rejected — breaks determinism)
      [--decider-cmd '<helper>']   answer live questions via a spawned helper
      [--decider-dir <dir>]   answer live questions in-band; then use 'gates'/'answer' to stream/respond
      [--output-format text|json] [--quiet|-q] [--verbose]
      (run 'run --help' for the full flag reference)

── Cassette lifecycle ─────────────────────────────────────────────────────────
  record <scenario.yaml>       run + save a control-protocol cassette
      [--out <file>]           cassette path (default: cassettes/<scenario-name>.cassette.json)
      [--max-artifact-bytes <n>]  inline-body cap (default 65536 / $COWORK_HARNESS_MAX_ARTIFACT_BYTES)
      [--concurrency <N>]      record a dir/ batch (or --rerecord-stale) N at a time (default 1; runs are
                               fully isolated, so this only bounds Docker address-pool / API-rate pressure)
      [--decider-dir <dir>]    answer gates LIVE in-band during the recording (single scenario; then use
                               'gates'/'answer' to stream/respond) — one pass, no scripted-answer guesswork
      [--decider-llm [--intent "…"]] | [--on-unanswered fail|first]   answer live via a model / auto-pick
                               (a live decider flags the cassette non-deterministic; it still replays deterministically)
      [--decider-model <name>]  override the decider's model (requires --decider-llm)
  replay <file|dir>            deterministic protocol-replay of a cassette or a dir of them (no token, no Docker)
                               (--assert-from <scenario.yaml> / --reassert: opt-in token-free re-check against on-disk assert:)
      [--strict]               fail (exit 1) on ANY stale cassette instead of warning
      [--fail-on-skill-drift]  fail only on skill-source drift (skill/shared-root); baseline drift stays a warning
      [--output-format json]
  verify-cassettes <file|dir>  CI gate (no token): privacy scan + staleness — exit 1 on finding or drift
      [--skip-privacy|--skip-staleness]  skip one check
      [--allow <regex>]... [--allow-domain <regex>]... [--allow-email <regex>]... [--allow-path <regex>]... [--allow-machine-inventory <regex>]... [--allow-patterns-file <path>]... [--output-format json]
      --allow <regex> is a PATTERN (matched against a finding); --allow-patterns-file <path> is a FILE of patterns, one regex per line — not a path to allow
  rehash <dir/>                migrate cassette fingerprints to current version when content is provably unchanged (requires contentSig from v3+)
  init-redact [--force]        copy the packaged reference .cowork-redact.json into the cwd (redaction starter
                               for hostloop/protocol recordings; review + tailor the patterns before recording)
  prune [--keep-last <n>]      prune accumulated run dirs, keeping N most recent per scenario (default: 5)

── CI lint + assertion reference ──────────────────────────────────────────────
  lint <scenario.yaml | dir/>…  check scenarios for silent false-greens (bundled scenario.py; needs python3 — PyYAML is bundled)
      [--strict]               escalate cassette-staleness warning to failure
      NOTE: exit 127 means python3 itself is missing — treat any non-zero exit as a CI failure, do not swallow it.
  assertions --list            list available scenario assertions (generated from Zod schema)
      [--output-format json]

── Debugging / inspection ─────────────────────────────────────────────────────
  trace <run-id | dir | path>  digest a run's events.jsonl (tools+result status, dispatches, decisions)
      [--view tools|questions|dispatches]   focus on one view (default: all); see 'trace --help'
      [--output-format json]   structured rows
  verify-run <run-dir> <scenario.yaml>   re-evaluate assert: against a kept run dir (no live agent, ~1s)
      [--output-format json]
  inspect <run-id | run-dir>   show what a run produced: artifacts + a shallow field preview of each JSON artifact
      [--output-format json]   structured digest
  diff <a> <b>                 compare two baselines, two runs, two cassettes, or a run+cassette (kind auto-detected by content)
      [--changelog]            baseline mode: render known-field prose instead of the raw path-diff
      [--view tools|transcript|artifacts|meta|all] [--no-normalize]   run/cassette mode (see 'diff --help')
      [--output-format json]   exit codes: 0 identical · 1 differing · 2 usage
  scaffold <run-id | run-dir>  turn a kept run into a starter scenario YAML (gates→answers, artifacts→file_exists)
      [--out <file.yaml>]      write to a file (default: stdout)
  status <run-id | run-dir>    check whether a background run is alive (state/elapsed/tool counts) — no ps aux needed
      [--follow]               stream one line per status change until done/error; arm a Monitor here
      [--output-format json]   structured status (--follow always emits raw JSON lines, format flag N/A there)
      exit codes: 0 healthy · 1 resolved dir has no/malformed status.json, or the run errored · 2 unresolvable <run-id | run-dir> · 3 stale
  stats [<scenario>]           queryable summary over indexed runs: count, pass rate, cost/duration/token/turn p50/p95
      [--since <date>] [--baseline <b>] [--branch <b>] [--metric pass-rate|cost|tokens|duration|turns|cache-tokens|model-cost] [--last <n>] [--reindex]
      (run 'stats --help' for the full flag reference)

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
  --version, -v                print version        --help, -h    print this help

  Env-var defaults (CLI flags take precedence):
    COWORK_HARNESS_FIDELITY        default --fidelity tier (skill/chat; run takes fidelity from the scenario)
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
  --folder <dir>                   connect a folder (mounts at mnt/<folder-name>, derived) — a repo/space (repeatable)

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
  --decider-llm [--intent "<one line>"]   answer LIVE questions with a model (Sonnet default; the ergonomic
                                   default for agent-driven runs: state the test's intent once instead of
                                   writing a helper). The model replies with the option NUMBER (code maps it
                                   to the exact label); an out-of-set answer FAILS LOUD. NON-deterministic —
                                   the footer flags the run so a green isn't mistaken for a scripted pass;
                                   pin with --answer for CI.
  --decider-model <id>             override the --decider-llm answering model (flag > env
                                   COWORK_HARNESS_DECIDER_MODEL > Sonnet default). Pin a cheaper model
                                   (e.g. a Haiku id) for simple gates to cut cost; it won't make an
                                   under-specified gate deterministic. Requires --decider-llm.
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
  --quiet, -q                      verdict footer only            --verbose       + thinking/tool inputs/sub-agent tree
  --compact                        drop the informational capability ::notice:: lines (the probe + hard-fail stay)
  --demo                           shareable output: --compact + suppress the "runs →" header (runs stay durable)
  --keep                           print the run dir + deliverable path (runs are always kept on disk)
  --run-dir <path>                 GLOBAL flag — must PRECEDE the subcommand (cowork-harness --run-dir <path> skill …);
                                   relocates runs/ output (default ~/.cowork-harness/runs) out of the working tree.
                                   flag > COWORK_HARNESS_RUNS_DIR > default. (placed after the subcommand it is rejected.)
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
  --decider-model <id>             override the answering model for 'on_unanswered: llm' scenarios
                                   (flag > env COWORK_HARNESS_DECIDER_MODEL > Sonnet default); no-op for
                                   scenarios that don't use the model terminal.
  (per-scenario answers/on_unanswered in the YAML take precedence where set)

Repeat / flakiness measurement (E1):
  --repeat <N>                     run each resolved scenario N times (int, 2-100) and aggregate a variance
                                   rollup (pass rate, per-assertion attribution, signal histogram). results[]
                                   still holds every raw run; only the batch verdict (ok/exit code) changes
                                   for this mode — see --min-pass-rate. Rejects --decider-dir (an interactive
                                   driving agent × N runs is not a measurement).
  --min-pass-rate <0..1>           the repeat batch's pass threshold (default 1.0 = no flakiness tolerance).
                                   Requires --repeat.
  --stop-on-diverge                stop the repeat loop as soon as BOTH a pass and a fail have been observed
                                   (saves paid runs once flakiness is proven) — that batch always FAILS
                                   (divergence observed = flaky = what this flag exists to catch). Requires --repeat.
  --max-budget-usd <x>             stop the repeat loop once cumulative cost would exceed x. An incomplete-
                                   but-clean stop is a warning, not a failure by itself; degrades LOUDLY
                                   (never silently runs all N) if a run reports no cost telemetry. Requires --repeat.

Matrix testing (E3) — one scenario × a cross-product of axes, in one run:
  --matrix <matrix.yaml>           run <scenario.yaml> across the cross-product of a matrix file's axes
                                   (baselines/models/skill_dirs — see docs/scenario.md). Requires exactly
                                   one scenario file (not a dir). Cannot combine with --repeat. Exit 1 if
                                   any cell fails (assertion OR a cell-level infra error, e.g. the pinned
                                   baseline's agent binary isn't staged) — a matrix is a compatibility gate,
                                   not a survey. The JSON envelope gains an additive "matrix: {cells[]}" field.
  --max-cells <n>                  cap the cross-product (default 16); over the cap warns and runs only the
                                   first n. Requires --matrix.
  --concurrency <n>                run cells N at a time (default 1, max 8 — each run is fully isolated, the
                                   bound is for Docker address pool / model API rate limits). Requires --matrix.
                                   Rejected together with --decider-dir/--decider-cmd when > 1 (the external
                                   decider channel is shared across cells, not safe for concurrent gate answers).
  matrix.yaml:
    baselines: [desktop-1.17377.2, desktop-1.18286.0]   # optional axis; each value must resolve via loadBaseline
    models: [claude-sonnet-4-6, claude-opus-4-8]         # optional axis; overrides the session model per cell
    skill_dirs: [../variants/v1/my-skill, ../variants/v2/my-skill]  # optional axis; substitutes the session's
                                                          # single plugins.local_plugins entry — candidates MUST
                                                          # share one basename (the mount name derives from it;
                                                          # a mismatched basename is rejected, not silently renamed)

Output:
  --output-format text|json        text = verdict + failing transcript (default); json = stdout envelope
  --quiet, -q                      verdict only            --verbose       live stream + per-tool markers
  --compact                        drop the informational capability ::notice:: lines (the probe + hard-fail stay)
  --demo                           shareable output: --compact + suppress the "runs →" header (runs stay durable)
  --run-dir <path>                 GLOBAL flag — must PRECEDE the subcommand (cowork-harness --run-dir <path> run …);
                                   relocates runs/ output (default ~/.cowork-harness/runs) out of the working tree.
                                   flag > COWORK_HARNESS_RUNS_DIR > default. (placed after the subcommand it is rejected.)
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

// Per-subcommand `--help`. `run`/`skill` already print their own help via hasHelp(); `lint` delegates
// to the Python argparse path (which has its own --help). Every OTHER subcommand goes straight to parseArgs,
// where `--help` was an "unknown flag" error — so you could only discover flags by triggering a bad
// invocation. Intercept `--help`/`-h` at dispatch and print the command's usage (exit 0). One concise line
// per command, kept in sync with each command's own bad-invocation `usage:` string.
const SUBCOMMAND_USAGE: Record<string, string> = {
  sync: "usage: sync [--diff] [--allow-empty|--force]   (re-sync the platform baseline from the installed Cowork app; macOS only)\n       --allow-empty (alias --force): write even when the derived egress allowlist is empty",
  list: "usage: list [--output-format text|json]   (list available platform baselines)",
  "boundary-check": "usage: boundary-check [<baseline>] [--session <file>] [--output-format text|json]",
  vm: "usage: vm <init|status|delete|prune> [--output-format text|json]   (macOS arm64 only)\n  init    create the L2 Apple-VZ microVM\n  status  show running VM state\n  delete  remove a named VM\n  prune   drop all orphaned VMs",
  chat: "usage: chat <skill-folder> [prompt] [--fidelity protocol|container|hostloop] [--model <id>]\n              [--upload <file>]... [--folder <dir>]... [--plugin <dir>]... [--verbose] [--raw]\n       --raw: native cowork mode via docker run -it; egress sandbox NOT applied; rejects --upload/--folder/--plugin/--fidelity (only --model applies)\n       --fidelity: protocol/container/hostloop only (no microvm/cowork); protocol = no Docker, no sandbox",
  record:
    "usage: record <scenario.yaml | dir/> [--out <file>] [--output-format text|json] [--rerecord-stale] [--no-redact] [--allow-failing] [--max-artifact-bytes <n>] [--dry-run] [--concurrency <N>]\n" +
    "       --concurrency <N>: record a dir/ batch (or --rerecord-stale) N at a time (default 1, max 8). Runs are fully isolated; the bound is for Docker address pool + API rate limits.\n" +
    '       answer gates LIVE: [--decider-dir <dir>] (single scenario only) | [--decider-llm [--intent "<one line>"]] | [--on-unanswered fail|first]\n' +
    "       (a live decider flags the cassette non-deterministic — re-recording may drift; replay stays deterministic. --rerecord-stale rejects these flags.)\n" +
    "       NOTE: --allow-failing only relaxes the post-run VERDICT gate; it does NOT salvage an unanswered gate (that throws before any cassette is written — use --on-unanswered first / a decider).",
  replay:
    "usage: replay <file.cassette.json | dir/> [--strict] [--fail-on-skill-drift] [--assert-from <scenario.yaml> | --reassert] [--output-format text|json]\n" +
    "       by default the assertions FROZEN in the cassette drive the verdict (deterministic); a sibling scenario whose assert: differs only prints a notice.\n" +
    "       --assert-from <file> / --reassert: token-free re-check against the on-disk assert:/expect_denied: — recording-shaping drift (prompt/answers/baseline/skills) and skill staleness HARD-FAIL.",
  "verify-cassettes":
    "usage: verify-cassettes <file|dir> [--skip-privacy|--skip-staleness] [--allow <regex>]... [--allow-domain <regex>]... [--allow-email <regex>]... [--allow-path <regex>]... [--allow-machine-inventory <regex>]... [--allow-patterns-file <path>]... [--output-format json]\n" +
    "       --allow <regex> is a PATTERN (matched against a finding); --allow-patterns-file <path> is a FILE of patterns, one regex per line — not a path to allow.",
  trace:
    "usage: trace <run-id | run-dir | events.jsonl> [--view tools|questions|dispatches|tool-durations] [--translate-paths] [--output-format json]\n       --view tools           tool call / result rows\n       --view questions       gate lifecycle (question → answer → delivered)\n       --view dispatches      sub-agent dispatch tree + dispatch_count_max\n       --view tool-durations  per-tool call-count/timing table, folded from the sibling timeline.jsonl (M1; {} for a pre-M1 run)\n       --translate-paths  rewrite VM paths to host paths in the tools/default TEXT views only (needs a sibling mounts.json + an effective hostloop run; questions/dispatches views and --output-format json are unaffected)\n       (default: all views)\n       (for what the run PRODUCED — artifacts — use `inspect`)",
  assertions: "usage: assertions --list [--output-format json]",
  scaffold:
    "usage: scaffold <run-id | run-dir> [--out <file.yaml>] [--output-format text|json]\n       Turns a kept run into a starter scenario YAML (gates→answers, artifacts→file_exists).\n       Positional <run-id | run-dir> is the canonical form.",
  status:
    'usage: status <run-id | run-dir> [--follow] [--output-format text|json]   (check whether a background run is alive, without ps aux — see docs/run-status.md)\n       --follow: stream one line per status change until the run reaches a terminal state (done/error); arm a Monitor here\n       exit codes: 0 healthy (running/done) · 1 the dir resolved but has no status.json yet (or a malformed one), or the run itself ended in state:"error" · 2 usage error, including an unresolvable <run-id | run-dir> (matches trace/inspect/scaffold) · 3 stale (probably dead — no exit handler can catch SIGKILL)',
  stats:
    "usage: stats [<scenario>] [--since <ISO date>] [--baseline <b>] [--branch <b>] [--metric pass-rate|cost|tokens|duration|turns|cache-tokens|model-cost] [--last <n>] [--reindex] [--output-format text|json]\n" +
    "       queryable summary over <runsRoot>/index.jsonl (E4) — per-scenario run count, pass rate, cost/duration/token/turn p50/p95, last-green timestamp.\n" +
    "       --reindex rebuilds the index from the physical run-dir tree first (one-time migration for pre-index runs, or if index.jsonl is lost/corrupted beyond its own per-line tolerance).\n" +
    "       --last <n>: the N most recent runs PER SCENARIO (not globally — a global cut would starve a low-frequency scenario out of the window).\n" +
    "       --metric narrows the TEXT line to one view; --output-format json always returns every field regardless (same convention as --quiet/--verbose — machine output stays full, only the human render narrows).\n" +
    "       `run`/`skill` invocations are indexed automatically at every result.json write (live + partial); `record`'s live execution is indexed too, tagged command:\"record\"; replay results are never indexed (they're re-checks, not new evidence).",
  decide:
    'usage: decide [--question <q>] [--option <o>]... [--decider-cmd <cmd> | --decider-llm [--intent <s>] [--decider-model <id>]] [--answer "<q>=<label>"]... [--answer-policy <p>] [--output-format json]',
  gates:
    "usage: gates <dir> [--follow] [--output-format text|json]   (stream pending in-band gates as JSON lines; pair with --decider-dir)",
  answer:
    'usage: answer <dir> --gate <N> (--choose <label> [--choose <label>…] | --answer "<q>=<label>") [--output-format text|json]   (write an in-band gate reply atomically; repeat --choose for a multiSelect gate)',
  "verify-run":
    "usage: verify-run <run-dir> <scenario.yaml> [--output-format json]   (re-evaluate a scenario's assert: against a kept run dir; no live agent)",
  inspect:
    "usage: inspect <run-id | run-dir> [--output-format json]   (show what a run PRODUCED: artifacts + a shallow preview of each JSON artifact's fields; for what HAPPENED — tools/decisions — use `trace`)",
  diff:
    "usage: diff <a> <b> [--changelog] [--view tools|transcript|artifacts|meta|all] [--no-normalize] [--output-format text|json]\n" +
    "       kind is auto-detected by CONTENT (not filename): two baselines (loadBaseline: `latest`, a bare name under baselines/, or an absolute path) | two runs (run-id/run-dir/events.jsonl) | two cassettes (*.cassette.json) | one run + one cassette (cross-comparable).\n" +
    "       baselines only pair with baselines; mixing a baseline with a run/cassette is a usage error. Comparing runs of two DIFFERENT scenarios is allowed (skill-variant comparison) but warns on stderr.\n" +
    "       --changelog: BASELINE MODE ONLY — render known-field prose (agent/Desktop version bumps, egress allowlist changes, gate flips) instead of the raw path-diff; unmapped paths still render, generically, never silently dropped.\n" +
    "       --view: RUN/CASSETTE MODE ONLY — restrict text output to one view (default: all). Normalization masks tool-use ids, UUIDs, session-dir markers, timestamps, and host paths so two runs of the SAME scenario diff as identical despite per-run noise; --no-normalize compares raw values (forensics).\n" +
    "       transcript is advisory (model-stochastic prose differs across live re-records no matter what) — tools/artifacts/meta are the gateable signal.\n" +
    "       runs anywhere (reads committed JSON / cassette files only — no live Desktop install needed for baseline mode, unlike `sync --diff`; no Docker/token needed for run/cassette mode).\n" +
    "       exit codes: 0 identical · 1 differing · 2 usage (e.g. an unresolvable baseline name, or a run/cassette with no matching side).",
  doctor: "usage: doctor [--tier protocol|container|microvm|hostloop|cowork] [--output-format json]   (read-only prerequisite check)",
  rehash:
    "usage: rehash <dir/> [--dry-run] [--output-format text|json]   (migrate cassettes across format bumps using contentSig verification; no re-record needed)",
  prune: "usage: prune [--keep-last <n>] [--dry-run] [<runs-dir>]   (prune accumulated run dirs; default --keep-last 5)",
  "init-redact":
    "usage: init-redact [--force] [--output-format json]   (copy the packaged reference .cowork-redact.json into the cwd; refuses to overwrite an existing one without --force)",
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
  "inspect",
  "diff",
  "assertions",
  "scaffold",
  "status",
  "stats",
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
  "init-redact",
  "prune",
];

// --dotenv / --run-dir are GLOBAL flags honored ONLY in leading position (before the subcommand),
// so a per-command value beginning with `--dotenv=`/`--run-dir=` (e.g. `skill ./s "p" --answer
// "--dotenv=x=foo"`) is never hijacked by the pre-dispatch scan. Walk from the front consuming only
// leading global-flag tokens (and their space-form values); stop at the first token that isn't one —
// that token is the subcommand. Returns the count of leading tokens; the scans slice argv to it. Because
// the region is a prefix, an index found within it is the same index into argv (so the later splice/value
// reads against argv stay aligned). MUST be recomputed after a splice mutates argv.
function leadingGlobalCount(av: string[]): number {
  let i = 0;
  while (i < av.length) {
    const t = av[i];
    if (t === "--dotenv" || t === "--run-dir")
      i += 2; // flag + space-form value
    else if (t.startsWith("--dotenv=") || t.startsWith("--run-dir="))
      i += 1; // equals form
    else break; // first non-global token = subcommand
  }
  return i;
}

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
  // Scan only the leading global-flag region (computed over the not-yet-mutated argv), so a `--dotenv=…`
  // token sitting AFTER the subcommand (as a per-command flag value) is left for the command parser.
  const dotenvLead = argv.slice(0, leadingGlobalCount(argv));
  const eqIdx = dotenvLead.findIndex((a) => a.startsWith("--dotenv="));
  const spaceIdx = dotenvLead.indexOf("--dotenv");
  const envFileIdx = spaceIdx >= 0 ? spaceIdx : eqIdx;
  const isEquals = spaceIdx < 0 && eqIdx >= 0;
  const explicitEnvFile = isEquals ? argv[eqIdx].slice("--dotenv=".length) : envFileIdx >= 0 ? argv[envFileIdx + 1] : undefined;
  // bounds-check the value, reject a command name mistaken as the path (`--dotenv run x.yaml`
  // would treat `run` as the dotenv path and dispatch `x.yaml`), and FAIL when an explicitly named
  // file is absent — an explicitly-requested credential file silently ignored is a footgun.
  if (envFileIdx >= 0) {
    // The space form needs a following token; the equals form carries its value inline (so an empty
    // `--dotenv=` is also "no path provided").
    if (explicitEnvFile === undefined || explicitEnvFile === "") {
      fail("cowork-harness", "usage", "--dotenv requires a path (none provided)", undefined, isJsonOutput(argv));
    }
    // The command-name footgun only applies to the space form (the equals form can't swallow the next
    // token as its value), but checking both is harmless and keeps the guard uniform.
    if (!isEquals && COMMANDS.includes(explicitEnvFile)) {
      fail(
        "cowork-harness",
        "usage",
        `--dotenv requires a path but got the command "${explicitEnvFile}" — write \`--dotenv <path> ${explicitEnvFile} …\``,
        undefined,
        isJsonOutput(argv),
      );
    }
    // Equals form is a single token; space form is the flag + its value.
    argv.splice(envFileIdx, isEquals ? 1 : 2);
    if (!existsSync(explicitEnvFile)) {
      fail("cowork-harness", "usage", `--dotenv file not found: ${explicitEnvFile}`, undefined, isJsonOutput(argv));
    }
  }

  // `--run-dir <path>` is a GLOBAL flag (parsed + stripped before dispatch, like --dotenv) that relocates
  // the runs/ output root so sensitive skill inputs/outputs never land in a working tree. It is a thin
  // shim over COWORK_HARNESS_RUNS_DIR: setting it here makes runsWriteRoot()/runsRoot() pick it up with no
  // writer/reader changes. Precedence: flag > COWORK_HARNESS_RUNS_DIR > ~/.cowork-harness/runs. Unlike
  // --dotenv it does NOT require the path to exist (it's an output dir, created on first write).
  // Recompute the leading region over the CURRENT (post-dotenv-splice) argv — the --dotenv strip above may
  // have shifted token positions, so a lead captured before it would be stale and misalign the indices the
  // splice below relies on.
  const runDirLead = argv.slice(0, leadingGlobalCount(argv));
  const rdEq = runDirLead.findIndex((a) => a.startsWith("--run-dir="));
  const rdSpace = runDirLead.indexOf("--run-dir");
  const rdIdx = rdSpace >= 0 ? rdSpace : rdEq;
  const rdIsEquals = rdSpace < 0 && rdEq >= 0;
  const runDirVal = rdIsEquals ? argv[rdEq].slice("--run-dir=".length) : rdIdx >= 0 ? argv[rdIdx + 1] : undefined;
  if (rdIdx >= 0) {
    if (runDirVal === undefined || runDirVal === "") {
      fail("cowork-harness", "usage", "--run-dir requires a path (none provided)", undefined, isJsonOutput(argv));
    }
    if (!rdIsEquals && COMMANDS.includes(runDirVal)) {
      fail(
        "cowork-harness",
        "usage",
        `--run-dir requires a path but got the command "${runDirVal}" — write \`--run-dir <path> ${runDirVal} …\``,
        undefined,
        isJsonOutput(argv),
      );
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
  // Per-subcommand --help for the parseArgs-direct commands (run/skill/lint self-handle, so they're
  // absent from the map and fall through to their own handling).
  if (hasHelp(rest) && cmd in SUBCOMMAND_USAGE) return void log(SUBCOMMAND_USAGE[cmd]);
  // validate COWORK_HARNESS_OUTPUT_FORMAT here — AFTER the --version/--help/per-subcommand-help
  // short-circuits above (so `COWORK_HARNESS_OUTPUT_FORMAT=garbage cowork-harness --version|--help` is NOT
  // a regression-causing usage error, matching the --output-format flag which never blocks --version) and
  // BEFORE dispatch (so every dispatched command sees a validated env, and the env fallback only ever
  // reads text|json|unset). The --output-format flag rejects an invalid value with exit 2; the env form
  // silently degraded to text — bring it to parity. An explicit --output-format=json flag still selects the
  // json error envelope via isJsonOutput (the garbage env value falls back to text there).
  const envOutFmt = process.env.COWORK_HARNESS_OUTPUT_FORMAT;
  if (envOutFmt !== undefined && envOutFmt !== "text" && envOutFmt !== "json")
    fail(cmd, "usage", `COWORK_HARNESS_OUTPUT_FORMAT must be "text" or "json" (got "${envOutFmt}")`, undefined, isJsonOutput(rest));
  // `--dotenv` / `--run-dir` are GLOBAL flags, honored ONLY in leading position (both stripped above before
  // dispatch). An exact `--dotenv` / `--run-dir` token surviving in `rest` sits AFTER the subcommand — a
  // misplaced global, the #1 footgun: the bare per-command "unknown flag: --dotenv" (or, for run/assertions,
  // an unrelated positional / "unexpected argument" error) sent users hunting for a per-command flag that
  // doesn't exist (campaign-2 H-2/H-4 — `--dotenv` where the pre-0.17.0 docs put it). Reject with a position
  // hint. Placed here — AFTER the --version/--help short-circuits (so a `--help`/`-h` request still wins,
  // matching the precedent above) and routed through fail() so the json envelope + exit-2 path match
  // every other usage error. Gated on a KNOWN `cmd`, so a junk subcommand (`frobnicate --dotenv x`) falls
  // through to the more accurate "unknown command" path below rather than getting a hint that implies it was
  // valid. EXACT-token match only: the `--flag=value` form is intentionally NOT matched, so a per-command
  // value like `--answer "--dotenv=x=foo"` is never hijacked (a misplaced `--dotenv=x` then falls through to
  // the command's own unknown-flag rejection). KNOWN trade-off: a bare token used as another flag's value
  // (e.g. `decide --question --dotenv`, omitting the value) is pre-empted here — it would otherwise get a
  // more specific "<flag> requires a value" error; both exit 2, and the input is rare (value omitted AND
  // literally equal to the token).
  if (!hasHelp(rest) && COMMANDS.includes(cmd)) {
    const misplacedGlobal = rest.find((t) => t === "--dotenv" || t === "--run-dir");
    if (misplacedGlobal)
      fail(
        cmd,
        "usage",
        `${misplacedGlobal} is a GLOBAL flag and must come BEFORE the subcommand (e.g. \`cowork-harness ${misplacedGlobal} <path> ${cmd} …\`)`,
        undefined,
        isJsonOutput(rest),
      );
  }
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
    case "init-redact":
      return cmdInitRedact(rest);
    case "verify-run":
      return cmdVerifyRun(rest);
    case "trace":
      return cmdTrace(rest);
    case "inspect":
      return cmdInspect(rest);
    case "diff":
      return cmdDiff(rest);
    case "assertions":
      return cmdAssert(rest);
    case "scaffold":
      return cmdScaffold(rest);
    case "status":
      return cmdStatus(rest);
    case "stats":
      return cmdStats(rest);
    case "decide":
      return cmdDecide(rest);
    case "gates":
      return cmdGates(rest);
    case "answer":
      return cmdAnswer(rest);
    case "prune":
      return cmdRunsGc(rest); // top-level: no `gc` token to strip, so pass `rest` whole (NOT rest.slice(1))
    default: {
      const jsonOut = isJsonOutput(argv);
      if (!jsonOut) printHelp(); // full help is stderr-only human context; skip it for a clean json envelope
      fail("cowork-harness", "usage", `unknown command: ${cmd}`, undefined, jsonOut);
    }
  }
}

interface CommonFlags {
  onUnanswered?: OnUnanswered;
  output: "text" | "json";
  quiet: boolean;
  verbose: boolean;
  compact?: boolean; // --compact: drop informational capability ::notice:: lines (safety net stays)
  demo?: boolean; // --demo: shareable output — compact + suppress the runs-location header (runs stay durable)
  deciderCmd?: string; // --decider-cmd: spawn a helper that answers each decision (external channel B)
  deciderDir?: string; // --decider-dir: file-rendezvous for a driving agent's Monitor (external channel C)
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
 * bounds-checked reader for value-taking flags. `args[++i]` with no following token silently
 * yields `undefined` (e.g. a trailing `--decider-cmd` at the end of argv), which then becomes a
 * broken flag value. Read the next token explicitly and, when it's absent, fail with the established
 * usage-error exit code (2). takeCommonFlags can run before --output-format json is resolved, so the error
 * goes to stderr unconditionally (machine callers piping us still see a non-zero exit).
 */
function flagValue(command: string, args: string[], i: number, flag: string, json: boolean): string {
  const v = args[i + 1];
  if (v === undefined) fail(command, "usage", `${flag} requires a value (none provided)`, undefined, json);
  if (v.trim() === "") fail(command, "usage", `${flag} requires a non-empty value`, undefined, json);
  return v;
}

/**
 * variant of flagValue that additionally rejects values that look like flags (start with "-",
 * excluding negative numbers like "-1"). Use this at call sites that do NOT have a downstream explicit
 * flag-like check. Name the flag and suspicious value in the error.
 */
function flagValueStrict(command: string, args: string[], i: number, flag: string, json: boolean): string {
  const v = flagValue(command, args, i, flag, json);
  if (v.startsWith("-") && !/^-\d/.test(v))
    fail(command, "usage", `${flag} requires a value but got a flag-looking token "${v}" — did you forget the value?`, undefined, json);
  return v;
}

/**
 * Reads a value-flag that may appear as EITHER `--flag value` OR `--flag=value` — unlike `flagValue`
 * (spaced form only), used at call sites (`stats`) that don't pre-extract flags the way `cmdRun`'s pre-args
 * loop does. `rejectUnknownFlags` already strips `=value` before its allowlist check (its own comment says
 * so), so an equals-form token silently PASSES that check — if the value-read here only looked for the
 * exact spaced-form token, the flag would be silently accepted-but-ignored, not a "unknown flag" usage
 * error. Returns `undefined` when the flag isn't present at all (never for a present-but-empty value —
 * that's a usage error via the delegated `flagValue` call, or an explicit empty-value check for the
 * equals form).
 */
function readValueFlag(command: string, args: string[], flag: string, json: boolean): string | undefined {
  const eqPrefix = flag + "=";
  const eqToken = args.find((a) => a.startsWith(eqPrefix));
  if (eqToken !== undefined) {
    const v = eqToken.slice(eqPrefix.length);
    if (v.trim() === "") fail(command, "usage", `${flag} requires a non-empty value`, undefined, json);
    return v;
  }
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  return flagValue(command, args, i, flag, json);
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
 * also rejects single-dash flags (e.g. `-x`, `-abc`) that aren't in knownFlags.
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

/**
 * Common flags shared by `run` and `skill`. Each value-flag accepts BOTH the spaced (`--flag v`) and the
 * equals (`--flag=v`) form — the hand-rolled loop previously only special-cased
 * `--output-format=json|text`, so e.g. `--on-unanswered=fail` or `--decider-cmd=cat` were not stripped
 * and fell through to the per-command unknown-flag guard. Booleans (`--quiet`/`--verbose`) reject an
 * equals value the way parseArgs does.
 */
function takeCommonFlags(args: string[], commandName: string = "skill"): { rest: string[]; flags: CommonFlags } {
  const rest: string[] = [];
  const envOutputFormat = process.env.COWORK_HARNESS_OUTPUT_FORMAT;
  const defaultOutput: "text" | "json" = envOutputFormat === "json" ? "json" : "text";
  const flags: CommonFlags = { output: defaultOutput, quiet: false, verbose: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    // resolve the equals form generically so every common value-flag accepts `--flag=value`, not
    // just the two `--output-format=` literals. `name` is the flag before `=`; `eqVal` its inline value.
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const name = eq > 0 ? a.slice(0, eq) : a;
    const eqVal = eq > 0 ? a.slice(eq + 1) : undefined;
    // Read a value (equals-form inline, else the next token), applying the same non-empty bounds-check
    // flagValue uses for the spaced form.
    const readVal = (): string => {
      if (eqVal !== undefined) {
        if (eqVal.trim() === "") fail(commandName, "usage", `${name} requires a non-empty value`, undefined, isJsonOutput(args));
        return eqVal;
      }
      return flagValue(commandName, args, i++, name, isJsonOutput(args));
    };
    // A boolean common flag given an equals value (e.g. `--quiet=1`) is a usage error, mirroring parseArgs.
    if (eq > 0 && (name === "--quiet" || name === "--verbose" || name === "--compact" || name === "--demo")) {
      fail(commandName, "usage", `${name} takes no value`, undefined, isJsonOutput(args));
    }
    if (name === "--on-unanswered") flags.onUnanswered = readVal() as OnUnanswered;
    else if (name === "--output-format") {
      // validate the enum (and bounds-check the value). An invalid/missing value previously fell
      // back to "text" silently (`--output-format xml` behaved as text; a trailing `--output-format` too).
      const v = readVal();
      if (v !== "text" && v !== "json")
        fail(commandName, "usage", `--output-format must be "text" or "json" (got "${v}")`, undefined, isJsonOutput(args));
      flags.output = v;
    } else if (a === "--quiet" || a === "-q") flags.quiet = true;
    else if (a === "--verbose") flags.verbose = true;
    else if (a === "--compact") flags.compact = true;
    else if (a === "--demo") flags.demo = true;
    else if (name === "--decider-cmd") {
      const v = readVal();
      if (eqVal === undefined && v.startsWith("-"))
        fail(commandName, "usage", `--decider-cmd: missing value (got flag-looking "${v}")`, undefined, flags.output === "json");
      flags.deciderCmd = v;
    } else if (name === "--decider-dir") {
      const v = readVal();
      if (eqVal === undefined && v.startsWith("-"))
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
  const compact = !!(flags.compact || flags.demo); // --demo implies --compact
  if (flags.output === "json")
    return { json: true, render: false, footer: false, plan: { live: false, progress: false, verbose: false, color: false, compact } };
  if (flags.quiet)
    return { json: false, render: false, footer: true, plan: { live: false, progress: false, verbose: false, color, compact } };
  const verbose = flags.verbose;
  // skill renders live ("show me what it did"); run is verdict-first (renderer buffers for the
  // failure transcript; live/per-tool only under --verbose).
  const live = command === "skill" ? true : verbose;
  const progress = command === "skill" ? true : verbose;
  return { json: false, render: true, footer: true, plan: { live, progress, verbose, color, compact } };
}

/** Resolve the on_unanswered default for a command. This is the choke
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
    // validate the accepted set. `external`/`llm` are rejected above with redirect messages (the
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
      fail(command, "usage", "run rejects --on-unanswered prompt (would break determinism). Use fail|first.", undefined, json);
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
  // validate EACH rule against the AnswerRule schema instead of a blind cast. A malformed rule
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
  /** E3: --matrix drives N cells from ONE process — a single cell's UnansweredError must never
   *  process.exit() the whole matrix (the default `fail()` mapping below does exactly that). When true,
   *  re-throw UnansweredError like any other error instead, so the matrix cell loop's own per-cell catch
   *  can convert it into a distinct `cell error` — same shape as an agent-binary-unavailable failure,
   *  never silently conflated with a real assertion failure. */
  rethrowUnanswered?: boolean;
}): Promise<RunResult> {
  const { command, scenario, label, flags, policy, externalChannel, o, keep, extra, rethrowUnanswered } = p;
  // The display translator needs the run's LaunchPlan (mount host paths) + resolved fidelity, both of
  // which are only known INSIDE executeScenario (buildLaunchPlan runs there) — well after this renderer
  // is constructed. A mutable ref (same pattern as execute.ts's own provenanceRef) lets executeScenario
  // fill it in once ctx is known, before any AgentEvent can arrive; the renderer reads translateRef.current
  // fresh on every event via this wrapper closure, so the late assignment is visible without needing to
  // share the RenderPlan object itself. Default: identity (matches today's behavior at every non-hostloop
  // tier, and if executeScenario never gets a chance to fill it in).
  const translateRef: { current: (s: string) => string } = { current: (s) => s };
  // OSC 8 hyperlink decoration gate: decided HERE, at plan construction — not inside makeRenderer,
  // whose Sink is injectable and shouldn't sniff process.* itself. `process.stderr.isTTY` mirrors the
  // renderer's own sink target; `!process.env.CI` mirrors the existing TTY gate at the
  // --on-unanswered default just above (~line 914); `COWORK_HARNESS_NO_HYPERLINKS` is an explicit
  // opt-out (same naming precedent as `COWORK_HARNESS_NO_HEARTBEAT`, renderer.ts); `o.plan.compact`
  // covers --compact/--demo (shareable output stays escape-free, same leg `shouldLinkify` documents).
  const linkify = o.render && shouldLinkify(process.env, process.stderr.isTTY === true, o.plan.compact) ? linkifyForTerminal : undefined;
  const renderer = o.render ? makeRenderer({ ...o.plan, translate: (s: string) => translateRef.current(s), linkify }) : undefined;
  if (!o.json && !flags.quiet) renderStart(label, scenario.fidelity, o.plan);
  const start = Date.now();
  const stopHeartbeat = o.json || externalChannel ? () => {} : startHeartbeat(renderer, o.plan, start);
  let result: RunResult;
  try {
    result = await executeScenario(scenario, {
      ...extra,
      command,
      onUnanswered: policy,
      externalChannel,
      hooks: renderer ? [renderer] : [],
      compact: !!(flags.compact || flags.demo), // --demo implies --compact
      translateRef,
    });
  } catch (e) {
    if (e instanceof UnansweredError && !rethrowUnanswered) {
      const chan = flags.deciderDir ? "decider-dir" : flags.deciderCmd ? "decider-cmd" : policy;
      const prefix = command === "run" ? `${scenario.name}: ` : ""; // run names the scenario; skill is single
      fail(command, "unanswered", `${prefix}unanswered question (on_unanswered=${chan})`, e.hint, o.json);
    }
    throw e; // BoundaryError + generic → top-level catch (categorized there); also UnansweredError when rethrowUnanswered
  } finally {
    stopHeartbeat();
  }
  // footer (stderr) and the json envelope (stdout, emitted by the caller) are mutually exclusive —
  // resolveOutput makes `footer` false under --output-format json — so their relative order never matters.
  if (o.footer) renderFooter(result, o.plan, { durationMs: Date.now() - start, renderer, keep, scaffoldTip: command === "skill" });
  return result;
}

/** E1: compact text-mode rollup table after a `--repeat N` batch. Renders pass rate, early-stop reason,
 *  the signal histogram, per-assertion attribution (only rows with at least one failure — an all-passing
 *  assertion across every iteration doesn't need a line), and cost/token/non-determinism totals when
 *  present. */
function formatRepeatRollup(r: RepeatRollup, minPassRate: number): string {
  const lines: string[] = [];
  const verdict = rollupPasses(r, minPassRate) ? "PASS" : "FAIL";
  const stopNote = r.stoppedEarly ? ` (stopped early: ${r.stoppedEarly}, ${r.completed}/${r.requested} completed)` : "";
  lines.push(`repeat "${r.scenario}": ${verdict} — ${r.passes}/${r.completed} passed (${(r.passRate * 100).toFixed(0)}%)${stopNote}`);
  const signals = Object.entries(r.signalHistogram);
  if (signals.length) lines.push(`  signals: ${signals.map(([code, n]) => `${code}×${n}`).join(", ")}`);
  const failingAssertions = r.perAssertion.filter((a) => a.fails > 0);
  for (const a of failingAssertions) {
    lines.push(
      `  assertion[${a.index}] (${a.key}): ${a.fails} fail / ${a.passes} pass${a.sampleFailure ? ` — e.g. "${a.sampleFailure}"` : ""}`,
    );
  }
  if (r.totalCostUsd !== undefined || r.totalTokens !== undefined) {
    const parts = [
      r.totalCostUsd !== undefined ? `$${r.totalCostUsd.toFixed(4)} total` : null,
      r.totalTokens !== undefined ? `${r.totalTokens} tokens total` : null,
    ].filter(Boolean);
    lines.push(`  cost: ${parts.join(", ")}`);
  }
  if (r.nonDeterministicRuns > 0)
    lines.push(
      `  ⚠ ${r.nonDeterministicRuns}/${r.completed} run(s) had a non-deterministic (llm/first/external) decision — flakiness attribution downstream of those is confounded`,
    );
  return lines.join("\n");
}

/**
 * Runs a repeat batch (N iterations of the SAME scenario/session), catching an unanswered gate — or any
 * other thrown error — PER ITERATION instead of letting it crash the whole batch. Found and fixed while
 * composing `--matrix` + `--repeat`: the matrix runner's own per-cell catch already did this for a
 * different failure class (an unavailable agent binary), and repeat batches had the exact same class of
 * bug the matrix runner had before its own fix — `runOneScenario`'s default UnansweredError handling calls
 * `fail()`/`process.exit()`, which on iteration 3 of a `--repeat 10` would silently discard the 2
 * completed iterations' rollup data and exit the whole process instead of recording "the scenario isn't
 * fully scripted for deterministic repetition" as the real, measurable failure it is. Shared by the
 * standalone `--repeat` path (one call per scenario) and each matrix cell's own internal repeat loop when
 * `--matrix`/`--repeat` compose (one call per cell) — the exact same early-stop/budget-cap/error-handling
 * logic, not reimplemented twice.
 */
async function runRepeatBatch(opts: {
  scenarioName: string;
  repeatN: number;
  stopOnDiverge: boolean;
  maxBudgetUsd: number | undefined;
  makeLabel: (n: number) => string;
  runOnce: (label: string) => Promise<RunResult>;
  onResult: (r: RunResult) => void; // called for every COMPLETED iteration (push into results[] etc.)
}): Promise<{ iterationResults: RunResult[]; rollup: RepeatRollup }> {
  const iterationResults: RunResult[] = [];
  let cumulativeCostUsd = 0;
  let costTelemetryMissing = false;
  let costTelemetryMissingWarned = false;
  let stoppedEarly: "budget" | "diverged" | "unanswered" | "error" | undefined;
  let sawPass = false;
  let sawFail = false;
  for (let n = 0; n < opts.repeatN; n++) {
    let r: RunResult;
    try {
      r = await opts.runOnce(opts.makeLabel(n));
    } catch (e) {
      if (e instanceof UnansweredError) {
        stoppedEarly = "unanswered";
        log(
          `::warning:: "${opts.scenarioName}": repeat batch stopped — run ${n + 1} hit an unanswered question (${e.message}) — the scenario isn't fully scripted for deterministic repetition, which is the real failure here.`,
        );
      } else {
        stoppedEarly = "error";
        log(`::warning:: "${opts.scenarioName}": repeat batch stopped — run ${n + 1} threw: ${(e as Error).message}`);
      }
      break;
    }
    iterationResults.push(r);
    opts.onResult(r);
    if (computeVerdict(r, "live").pass) sawPass = true;
    else sawFail = true;
    if (opts.stopOnDiverge && sawPass && sawFail) {
      stoppedEarly = "diverged";
      break;
    }
    if (opts.maxBudgetUsd !== undefined) {
      const b = budgetFields(r);
      if (b.costUsd === undefined) costTelemetryMissing = true;
      else cumulativeCostUsd += b.costUsd;
      if (costTelemetryMissing) {
        // degrade LOUDLY, never silently run all N as if the cap didn't exist (§4/E1 risk) — but
        // only ONCE per batch, not once per remaining iteration (costTelemetryMissing never resets).
        if (!costTelemetryMissingWarned) {
          log(
            `::warning:: --max-budget-usd unenforceable: run ${n + 1} reported no cost telemetry — continuing without a budget cap for "${opts.scenarioName}"`,
          );
          costTelemetryMissingWarned = true;
        }
      } else if (n + 1 < opts.repeatN && cumulativeCostUsd >= opts.maxBudgetUsd) {
        stoppedEarly = "budget";
        break;
      }
    }
  }
  if (stoppedEarly === "budget" && iterationResults.length < opts.repeatN)
    log(
      `::warning:: "${opts.scenarioName}": --max-budget-usd stopped the repeat batch early (${iterationResults.length}/${opts.repeatN} completed) — measurement incomplete, not a failure by itself`,
    );
  const rollup = buildRepeatRollup(opts.scenarioName, opts.repeatN, iterationResults, stoppedEarly);
  return { iterationResults, rollup };
}

async function cmdRun(rawArgs: string[]) {
  if (hasHelp(rawArgs)) return void log(RUN_HELP);
  // --decider-model overrides the LLM decider's answering model for scenarios that use `on_unanswered: llm`
  // (flag > env COWORK_HARNESS_DECIDER_MODEL > Sonnet default). `takeCommonFlags` doesn't know it (it's not a
  // common flag), so pull it out of argv first — otherwise it would land as an "unexpected argument".
  // E1: --repeat/--max-budget-usd/--stop-on-diverge/--min-pass-rate are `run`-only the same way — not common
  // flags, pre-extracted here exactly like --decider-model, cli.ts:897-911 in the plan's own citation.
  let deciderModel: string | undefined;
  let repeatN: number | undefined;
  let maxBudgetUsd: number | undefined;
  let stopOnDiverge = false;
  let minPassRate = 1.0;
  let matrixFile: string | undefined;
  let maxCells = 16;
  let matrixConcurrency = 1;
  const preArgs: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    const jsonOut = isJsonOutput(rawArgs);
    if (a === "--decider-model") {
      deciderModel = rawArgs[++i];
      // reject "" too — the equals branch below rejects an empty value, so the spaced form must match
      // (otherwise `--decider-model ""` forwards an empty model id and fails obscurely later).
      if (deciderModel === undefined || deciderModel === "" || deciderModel.startsWith("-"))
        fail("run", "usage", "--decider-model requires a value (a model id)", undefined, jsonOut);
    } else if (a.startsWith("--decider-model=")) {
      deciderModel = a.slice("--decider-model=".length);
      if (deciderModel === "") fail("run", "usage", "--decider-model requires a non-empty value", undefined, jsonOut);
    } else if (a === "--repeat" || a.startsWith("--repeat=")) {
      const v = a === "--repeat" ? rawArgs[++i] : a.slice("--repeat=".length);
      const n = v === undefined ? NaN : Number(v);
      if (!Number.isInteger(n) || n < 2 || n > 100)
        fail(
          "run",
          "usage",
          `--repeat requires an integer between 2 and 100 (got ${v === undefined ? "nothing" : `"${v}"`})`,
          undefined,
          jsonOut,
        );
      repeatN = n;
    } else if (a === "--max-budget-usd" || a.startsWith("--max-budget-usd=")) {
      const v = a === "--max-budget-usd" ? rawArgs[++i] : a.slice("--max-budget-usd=".length);
      const n = v === undefined ? NaN : Number(v);
      if (!Number.isFinite(n) || n <= 0)
        fail(
          "run",
          "usage",
          `--max-budget-usd requires a positive number (got ${v === undefined ? "nothing" : `"${v}"`})`,
          undefined,
          jsonOut,
        );
      maxBudgetUsd = n;
    } else if (a === "--stop-on-diverge") {
      stopOnDiverge = true;
    } else if (a === "--min-pass-rate" || a.startsWith("--min-pass-rate=")) {
      const v = a === "--min-pass-rate" ? rawArgs[++i] : a.slice("--min-pass-rate=".length);
      const n = v === undefined ? NaN : Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 1)
        fail(
          "run",
          "usage",
          `--min-pass-rate requires a number between 0 and 1 (got ${v === undefined ? "nothing" : `"${v}"`})`,
          undefined,
          jsonOut,
        );
      minPassRate = n;
    } else if (a === "--matrix" || a.startsWith("--matrix=")) {
      const v = a === "--matrix" ? rawArgs[++i] : a.slice("--matrix=".length);
      if (v === undefined || v === "" || v.startsWith("-"))
        fail("run", "usage", "--matrix requires a value (a matrix.yaml path)", undefined, jsonOut);
      matrixFile = v;
    } else if (a === "--max-cells" || a.startsWith("--max-cells=")) {
      const v = a === "--max-cells" ? rawArgs[++i] : a.slice("--max-cells=".length);
      const n = v === undefined ? NaN : Number(v);
      if (!Number.isInteger(n) || n < 1)
        fail("run", "usage", `--max-cells requires a positive integer (got ${v === undefined ? "nothing" : `"${v}"`})`, undefined, jsonOut);
      maxCells = n;
    } else if (a === "--concurrency" || a.startsWith("--concurrency=")) {
      const v = a === "--concurrency" ? rawArgs[++i] : a.slice("--concurrency=".length);
      const n = v === undefined ? NaN : Number(v);
      if (!Number.isInteger(n) || n < 1 || n > MAX_MATRIX_CONCURRENCY)
        fail(
          "run",
          "usage",
          `--concurrency requires an integer 1..${MAX_MATRIX_CONCURRENCY} (got ${v === undefined ? "nothing" : `"${v}"`})`,
          undefined,
          jsonOut,
        );
      matrixConcurrency = n;
    } else preArgs.push(a);
  }
  if (maxBudgetUsd !== undefined && repeatN === undefined)
    fail("run", "usage", "--max-budget-usd requires --repeat", undefined, isJsonOutput(rawArgs));
  if (stopOnDiverge && repeatN === undefined) fail("run", "usage", "--stop-on-diverge requires --repeat", undefined, isJsonOutput(rawArgs));
  if (minPassRate !== 1.0 && repeatN === undefined)
    fail("run", "usage", "--min-pass-rate requires --repeat", undefined, isJsonOutput(rawArgs));
  if (maxCells !== 16 && matrixFile === undefined) fail("run", "usage", "--max-cells requires --matrix", undefined, isJsonOutput(rawArgs));
  if (matrixConcurrency !== 1 && matrixFile === undefined)
    fail("run", "usage", "--concurrency requires --matrix", undefined, isJsonOutput(rawArgs));
  const { rest: rawRest, flags } = takeCommonFlags(preArgs, "run");
  // An interactive driving agent × N runs is not a measurement — --decider-dir/--decider-cmd both answer
  // gates LIVE (this codebase's own "LIVE questions: --decider-llm / --decider-cmd / --decider-dir"
  // grouping, RUN_HELP above), which defeats the point of repeating the SAME scenario deterministically N
  // times — a spawned --decider-cmd helper COULD be internally deterministic, but the harness has no way
  // to know that, and this fixed guard was previously asymmetric (deciderDir only) — a real gap, closed here.
  if (repeatN !== undefined && (flags.deciderDir || flags.deciderCmd))
    fail(
      "run",
      "usage",
      "--repeat cannot be combined with --decider-dir/--decider-cmd (an interactive driving agent × N runs is not a measurement)",
      undefined,
      flags.output === "json",
    );
  // A single external channel (--decider-dir/--decider-cmd) is ONE shared object, reused across every
  // matrix cell (cli.ts creates it once, before the cell loop) — and every channel implementation
  // (fileChannel/spawnChannel, src/decide/external-channel.ts) is documented as "strictly serial: write
  // req-N, block for resp-N" over SHARED mutable state (a `seq` counter / a single stdout read queue),
  // never designed for concurrent callers. Concurrent cells sharing it would race: cell A's write() could
  // be followed by cell B's write() before cell A's matching readLine() runs, so cell A reads cell B's
  // answer — silently steering the wrong gate to the wrong cell, the exact class of bug this codebase
  // treats as its most important invariant. --concurrency 1 (the default) is genuinely serial and safe;
  // only the combination with an active external channel is rejected.
  if (matrixFile !== undefined && matrixConcurrency > 1 && (flags.deciderDir || flags.deciderCmd))
    fail(
      "run",
      "usage",
      "--matrix --concurrency > 1 cannot be combined with --decider-dir/--decider-cmd (the channel is shared across cells and is not safe for concurrent gate answers — use --concurrency 1, or drop the external decider)",
      undefined,
      flags.output === "json",
    );
  // `--keep` is meaningful on `skill` (runs are otherwise discarded) but `run` ALWAYS keeps runs.
  // Accept it as an explicit no-op (EXACT-token only — it takes no value, so an exact match can't
  // swallow a real arg) instead of the loud reject below, so muscle memory from `skill` doesn't error.
  // Note it so the no-effect is visible.
  const keepRequested = rawRest.includes("--keep");
  const args = rawRest.filter((a) => a !== "--keep");
  if (keepRequested) log("note: `run` always keeps runs (under the runs root); --keep is a no-op here.");
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
  noteRunsLocation({ json: o.json, quiet: !!flags.quiet, suppress: !!flags.demo });

  // E3: --matrix is a completely separate mode from the per-file/--repeat loop below — one scenario, N
  // cells, not "N files each run once or N times" — so it's handled as its own early branch and exits.
  if (matrixFile !== undefined) {
    if (files.length !== 1)
      fail(
        "run",
        "usage",
        `--matrix requires exactly one scenario file (got ${files.length}) — matrix a single <scenario.yaml>, not a dir`,
        undefined,
        o.json,
      );
    if (!existsSync(matrixFile)) fail("run", "usage", `matrix file not found: ${matrixFile}`, undefined, o.json);
    const scenario = parseScenarioFile(files[0]);
    if (scenario.on_unanswered === "prompt")
      fail(
        "run",
        "usage",
        `scenario "${scenario.name}" sets on_unanswered: prompt — rejected on \`run\` (breaks determinism / hangs in CI).`,
        undefined,
        o.json,
      );
    let matrixDoc: MatrixFile;
    try {
      matrixDoc = MatrixFile.parse(parseYaml(readFileSync(matrixFile, "utf8")));
    } catch (e) {
      fail("run", "usage", `invalid matrix file: ${(e as Error).message}`, undefined, o.json);
    }
    const { cells, totalBeforeCap, truncated } = expandMatrix(matrixDoc!, maxCells);
    if (truncated)
      log(`::warning:: matrix: ${totalBeforeCap} cells before capping — only the first ${maxCells} ran (raise with --max-cells)`);
    let baseSession: ReturnType<typeof loadSessionFromFile>;
    try {
      baseSession = loadSessionFromFile(scenario.session);
    } catch (e) {
      // A bad session ref (missing file, invalid YAML) must read as a clean usage error, matching the
      // scenario-path check above — not a raw ENOENT + stack trace.
      fail("run", "usage", `failed to load session "${scenario.session}": ${(e as Error).message}`, undefined, o.json);
    }
    // skill_dirs candidates are resolved relative to the MATRIX FILE's own directory (the same
    // relocatability convention resolveSessionPaths already applies to a session file's own paths — a
    // matrix.yaml checked into a repo alongside its scenario must not depend on the invoker's cwd) and
    // existence-checked up front — fail loud before spending a single live run, not per-cell as a
    // confusing runtime "cell error" for what's actually a typo in the matrix file.
    const matrixBaseDir = dirname(resolve(matrixFile));
    const skillDirAxis = matrixDoc!.skill_dirs;
    const resolvedSkillDirs = new Map<string, string>(); // declared value -> resolved absolute path
    if (skillDirAxis) {
      for (const d of skillDirAxis) {
        const resolved = d.startsWith("~") || isAbsolute(d) ? d : resolve(matrixBaseDir, d);
        if (!existsSync(resolved))
          fail("run", "usage", `matrix skill_dirs: "${d}" (resolved: ${resolved}) does not exist`, undefined, o.json);
        resolvedSkillDirs.set(d, resolved);
      }
      if (baseSession.plugins.local_plugins.length !== 1)
        fail(
          "run",
          "usage",
          `matrix skill_dirs axis requires the session to declare exactly one plugins.local_plugins entry to substitute (found ${baseSession.plugins.local_plugins.length})`,
          undefined,
          o.json,
        );
    }
    const results: RunResult[] = [];
    // Every cell resolves its own overridden scenario/session first (shared by both branches below) —
    // an error here (a bad skill_dirs substitution, an unresolvable overridden baseline) is a
    // PRE-EXECUTION cell error either way, never a rollup.
    const resolveCell = (
      cell: MatrixCell,
    ): { cellScenario: Scenario; session: ReturnType<typeof loadSessionFromFile> } | { error: string } => {
      const cellScenario = cell.axes.baseline !== undefined ? { ...scenario, baseline: cell.axes.baseline } : scenario;
      try {
        const session = applySessionOverrides(baseSession, {
          model: cell.axes.model,
          skillDirSubstitution:
            cell.axes.skillDir !== undefined
              ? [baseSession.plugins.local_plugins[0], resolvedSkillDirs.get(cell.axes.skillDir)!]
              : undefined,
        });
        return { cellScenario, session };
      } catch (e) {
        return { error: (e as Error).message };
      }
    };

    if (repeatN !== undefined) {
      // --matrix + --repeat composed: each cell is its OWN repeat batch (N iterations of that cell's
      // axes-overridden scenario/session), not a single run — reuses the exact same runRepeatBatch helper
      // (and therefore the exact same unanswered-gate/error/budget-cap robustness) as standalone --repeat.
      let cellResults: MatrixCellRepeatResult[];
      try {
        cellResults = await pMapBounded(cells, matrixConcurrency, async (cell): Promise<MatrixCellRepeatResult> => {
          const resolved = resolveCell(cell);
          if ("error" in resolved) return { index: cell.index, axes: cell.axes, error: resolved.error };
          const { cellScenario, session } = resolved;
          const { rollup } = await runRepeatBatch({
            scenarioName: `${scenario.name} [${axesLabel(cell.axes)}]`,
            repeatN,
            stopOnDiverge,
            maxBudgetUsd,
            makeLabel: (n) =>
              `${scenario.name} [${axesLabel(cell.axes)}] (cell ${cell.index + 1}/${cells.length}, repeat ${n + 1}/${repeatN})`,
            runOnce: (label) =>
              runOneScenario({
                command: "run",
                scenario: cellScenario,
                label,
                flags,
                policy,
                externalChannel,
                o,
                extra: { session, llmModel: deciderModel },
                rethrowUnanswered: true,
              }),
            onResult: (r) => results.push(r),
          });
          return { index: cell.index, axes: cell.axes, rollup };
        });
      } finally {
        externalChannel?.close?.();
      }
      const matrixRepeat = buildMatrixRepeatRollup(cellResults, totalBeforeCap, truncated, minPassRate);
      if (o.json) out(jsonEnvelope("run", results, { matrixRepeat }));
      else for (const line of formatMatrixRepeatRollup(matrixRepeat, minPassRate)) log(line);
      process.exit(matrixRepeat.anyFail ? 1 : 0);
    }

    let cellResults: MatrixCellResult[];
    try {
      cellResults = await pMapBounded(cells, matrixConcurrency, async (cell): Promise<MatrixCellResult> => {
        const resolved = resolveCell(cell);
        if ("error" in resolved)
          return { index: cell.index, axes: cell.axes, pass: false, failedAssertions: [], signals: [], error: resolved.error };
        const { cellScenario, session } = resolved;
        const label = `${scenario.name} [${axesLabel(cell.axes)}] (cell ${cell.index + 1}/${cells.length})`;
        try {
          const result = await runOneScenario({
            command: "run",
            scenario: cellScenario,
            label,
            flags,
            policy,
            externalChannel,
            o,
            extra: { session, llmModel: deciderModel },
            rethrowUnanswered: true,
          });
          results.push(result);
          return matrixCellResultFromRun(cell, result);
        } catch (e) {
          // A cell-level failure — an infra problem (e.g. the pinned baseline's agent binary isn't
          // staged) OR an unanswered gate (rethrowUnanswered above) — must never crash the whole matrix;
          // render it as a distinct "cell error", never conflated with a real assertion failure.
          const message = e instanceof UnansweredError ? `unanswered question: ${e.message}` : (e as Error).message;
          return { index: cell.index, axes: cell.axes, pass: false, failedAssertions: [], signals: [], error: message };
        }
      });
    } finally {
      externalChannel?.close?.();
    }
    const matrix = buildMatrixRollup(cellResults, totalBeforeCap, truncated);
    if (o.json) out(jsonEnvelope("run", results, { matrix }));
    else for (const line of formatMatrixRollup(matrix)) log(line);
    process.exit(matrix.anyFail ? 1 : 0);
  }

  const results: RunResult[] = [];
  const rollups: RepeatRollup[] = [];
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

      if (repeatN === undefined) {
        const label = files.length > 1 ? `[${i + 1}/${files.length}] ${scenario.name}` : scenario.name;
        results.push(
          await runOneScenario({
            command: "run",
            scenario,
            label,
            flags,
            policy,
            externalChannel,
            o,
            extra: deciderModel ? { llmModel: deciderModel } : undefined,
          }),
        );
        continue;
      }

      // E1: --repeat N — run the SAME scenario N times, coexisting via local_<hrtime> run dirs
      // (execute.ts:177-180, no collision), aggregate into a RepeatRollup. results[] still gets every
      // raw RunResult (nothing hidden) — only the exit-code/`ok` formula changes for this mode (§8).
      const { rollup } = await runRepeatBatch({
        scenarioName: scenario.name,
        repeatN,
        stopOnDiverge,
        maxBudgetUsd,
        makeLabel: (n) => `${files.length > 1 ? `[${i + 1}/${files.length}] ` : ""}${scenario.name} (repeat ${n + 1}/${repeatN})`,
        runOnce: (label) =>
          runOneScenario({
            command: "run",
            scenario,
            label,
            flags,
            policy,
            externalChannel,
            o,
            extra: deciderModel ? { llmModel: deciderModel } : undefined,
            rethrowUnanswered: true,
          }),
        onResult: (r) => results.push(r),
      });
      rollups.push(rollup);
    }
  } finally {
    externalChannel?.close?.(); // ONE channel reused across the loop — close after ALL scenarios (not per-run)
  }
  // All channels keep stdout free → the normal output path (envelope under --output-format json, nothing
  // otherwise). No terminal {type:"result"} line — `--decider-cmd`/`--decider-dir` compose with json.
  // The rollup table is human output like every other per-run footer (renderFooter), so it goes to
  // stderr via log() — NOT out()/stdout, which text mode reserves for staying quiet (only json mode uses it).
  const usingRepeat = repeatN !== undefined;
  if (o.json) out(jsonEnvelope("run", results, usingRepeat ? { rollups, minPassRate } : {}));
  else if (usingRepeat) for (const r of rollups) log(formatRepeatRollup(r, minPassRate));
  const ok = usingRepeat ? rollups.every((r) => rollupPasses(r, minPassRate)) : results.every((r) => computeVerdict(r, "live").pass);
  process.exit(ok ? 0 : 1);
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
  let deciderModel: string | undefined;
  let deciderLlm = false;
  let resume = false;
  let dryRun = false;
  let keep = false;
  const isJson0 = flags.output === "json";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    // accept BOTH `--flag value` and `--flag=value` for every skill value-flag (the old loop matched
    // by exact `a === "--flag"`, so `--fidelity=container` fell through to the unknown-flag guard). `name`
    // is the flag before `=`; when an inline `=value` is present, consume it instead of the next token.
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const name = eq > 0 ? a.slice(0, eq) : a;
    const eqVal = eq > 0 ? a.slice(eq + 1) : undefined;
    // value reader: equals-inline value (non-empty checked) else the next token (via flagValue/Strict).
    const nextVal = (): string => {
      if (eqVal !== undefined) {
        if (eqVal.trim() === "") fail("skill", "usage", `${name} requires a non-empty value`, undefined, isJson0);
        return eqVal;
      }
      return flagValue("skill", args, i++, name, isJson0);
    };
    // strict variant additionally rejects a SPACED flag-looking value (the equals form is the escape).
    const nextValStrict = (): string => {
      const v = nextVal();
      if (eqVal === undefined && v.startsWith("-") && !/^-\d/.test(v))
        fail(
          "skill",
          "usage",
          `${name} requires a value but got a flag-looking token "${v}" — did you forget the value?`,
          undefined,
          isJson0,
        );
      return v;
    };
    // booleans reject an equals value, mirroring parseArgs.
    if (eq > 0 && (name === "--resume" || name === "--decider-llm" || name === "--dry-run" || name === "--keep")) {
      fail("skill", "usage", `${name} takes no value`, undefined, isJson0);
    }
    if (name === "--fidelity") {
      fidelity = nextVal() as typeof fidelity; // bounds-checked
      // validate at parse time → category `usage`. Previously an invalid value was only rejected
      // later by Scenario.parse (a Zod throw), which the top-level catch mapped to `internal` — a user
      // mistake masquerading as a harness bug.
      const FID = ["protocol", "container", "microvm", "hostloop", "cowork"];
      if (!FID.includes(fidelity))
        fail("skill", "usage", `--fidelity must be one of ${FID.join("|")} (got "${fidelity}")`, undefined, isJson0);
    } else if (name === "--model") model = nextValStrict();
    else if (name === "--prompt-file") promptFile = nextValStrict();
    else if (name === "--upload") uploads.push(nextValStrict());
    else if (name === "--folder") folders.push(nextValStrict());
    else if (name === "--session-id") sessionId = nextValStrict();
    else if (a === "--resume") resume = true;
    else if (a === "--decider-llm") deciderLlm = true;
    else if (name === "--intent") intent = nextValStrict();
    else if (name === "--decider-model") deciderModel = nextValStrict();
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--keep") keep = true;
    else if (name === "--plugin") extraPlugins.push(nextValStrict());
    else if (name === "--marketplace") marketplaces.push(nextValStrict());
    else if (name === "--enable") enables.push(nextValStrict());
    else if (name === "--answer") {
      const raw = nextValStrict();
      const parts = splitEq(raw);
      if (!parts)
        fail(
          "skill",
          "usage",
          `--answer requires "question-regex=choice" (got "${raw}" — both sides must be non-empty)`,
          undefined,
          isJson0,
        );
      const [q, choose] = parts!;
      answers.push({ when_question: q, choose });
    } else if (name === "--answer-policy") answerPolicy = nextValStrict();
    // reject unknown flags (any token starting with - or -- that wasn't consumed above)
    else if (a.startsWith("-")) fail("skill", "usage", `unknown flag: ${a}`, undefined, isJson0);
    else positional.push(a);
  }
  const isJson = flags.output === "json";
  if (resume && !sessionId) fail("skill", "usage", "--resume requires --session-id <id> (the session to resume)", undefined, isJson);

  // reject extra positionals so a shell-quoting slip (an unquoted multi-word prompt) can't silently
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

  // All semantic validation must happen BEFORE the dry-run return so --dry-run doesn't bypass
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
  // --decider-model only feeds the LLM decider (it picks the answering model); reject it without --decider-llm.
  if (deciderModel !== undefined && !useLlm)
    fail("skill", "usage", "--decider-model requires --decider-llm (it sets the model that answers live questions).", undefined, isJson);
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
      folders: folders.map((from) => ({ from, mode: "rw" as const })), // --folder <dir> → mnt/<derived-name> (asar: rw, delete denied by default)
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
  noteRunsLocation({ json: o.json, quiet: !!flags.quiet, suppress: !!flags.demo });
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
        llmModel: deciderModel,
        nonDeterministicHint: flags.deciderDir != null || flags.deciderCmd != null, // driving agent / helper answers → not reproducible
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

/** All fidelity tiers the harness understands (the canonical Scenario `fidelity:` enum), surfaced so a
 *  JSON caller of `vm status` sees the same set the CLI validates. `container` is the default tier. */
const FIDELITY_TIERS = ["protocol", "container", "microvm", "hostloop", "cowork"] as const;

/** Resolve the on-disk file a named baseline loads from (mirrors loadBaseline's resolution) so the JSON
 *  envelope can report it. `latest` resolves to its concrete file; an absolute name is itself. */
function baselineFilePath(name: string): string {
  if (name === "latest") {
    const files = readdirSync(BASELINES_DIR)
      .filter((f) => f.startsWith("desktop-") && f.endsWith(".json"))
      .sort((a, b) =>
        cmpVersionStrings(a.replace(/^desktop-/, "").replace(/\.json$/, ""), b.replace(/^desktop-/, "").replace(/\.json$/, "")),
      );
    return files.length ? join(BASELINES_DIR, files[files.length - 1]) : join(BASELINES_DIR, "latest");
  }
  if (isAbsolute(name)) return name;
  return join(BASELINES_DIR, name.endsWith(".json") ? name : `${name}.json`);
}

/** stable JSON envelope for `vm status`. Surfaces baseline path/version, the fidelity tiers the
 *  harness understands, guest-image hints, the resolved VM instance + its current status, and any
 *  warnings (e.g. status the VM tooling could not determine). Keep the shape additive — JSON callers
 *  pin field names, so add fields rather than rename/remove. */
// Shared vm JSON envelope shell. Every subcommand (init/delete/prune too, not just status) emits the
// same tool/command/instance/baseline/image block under a per-subcommand discriminator, with the
// subcommand-specific outcome spread in by the caller.
function vmEnvelopeBase(subcommand: string, baselineName: string, baseline: PlatformBaseline, instance: string, warnings: string[]) {
  return {
    tool: "cowork-harness",
    command: "vm",
    subcommand,
    instance,
    baseline: {
      name: baselineName,
      path: baselineFilePath(baselineName),
      appVersion: baseline.appVersion,
      agentVersion: baseline.agentVersion,
      baselineVersion: baseline.baselineVersion,
    },
    fidelity: { tiers: [...FIDELITY_TIERS], default: "container" },
    image: {
      guestOs: baseline.guest.os,
      guestArch: baseline.guest.arch,
      baseImage: baseline.guest.baseImage ?? null,
    },
    warnings,
  };
}

function vmStatusEnvelope(baselineName: string, baseline: PlatformBaseline, instance: string, status: string) {
  const warnings: string[] = [];
  // vmStatus returns "Absent" when no Lima VM exists for this config hash (see lima.ts) — surface that
  // as a warning so a JSON caller doesn't read "Absent" as a running VM.
  if (status === "Absent") warnings.push(`no VM exists for ${instance} (run \`vm init\` to create it)`);
  return { ...vmEnvelopeBase("status", baselineName, baseline, instance, warnings), status };
}

const VM_SUB_HELP: Record<string, string> = {
  init: "usage: vm init [<baseline>] [--output-format text|json]   — create the L2 Apple-VZ microVM",
  status: "usage: vm status [<baseline>] [--output-format text|json] — show running VM state",
  delete: "usage: vm delete [<baseline>] [--output-format text|json] — remove the named VM",
  prune: "usage: vm prune [<baseline>] [--output-format text|json]  — drop all orphaned VMs except the current one",
};

function cmdVm(args: string[]) {
  // macOS arm64 guard — Lima VMs are macOS-only.
  if (process.platform !== "darwin") {
    fail(
      "vm",
      "usage",
      "vm is only supported on macOS arm64 (requires Lima + Apple Virtualization Framework)",
      undefined,
      isJsonOutput(args),
    );
  }

  const sub = args[0];
  const VM_SUBS = Object.keys(VM_SUB_HELP);

  // per-subcommand --help (e.g. `vm init --help`).
  if (sub && VM_SUBS.includes(sub) && (args.includes("--help") || args.includes("-h"))) {
    log(VM_SUB_HELP[sub]);
    process.exit(0);
  }

  // validate the subcommand BEFORE loadBaseline(args[1]) — a bad subcommand (e.g. `vm typo`)
  // otherwise surfaced as a baseline-load error (or, with a stray arg, a confusing baseline message)
  // instead of the clear `usage: vm …`. (A bare `log` then exit-0 was the older footgun, now exit 2.)
  if (!VM_SUBS.includes(sub ?? "")) {
    fail("vm", "usage", SUBCOMMAND_USAGE["vm"] ?? "usage: vm <init|status|delete|prune>", undefined, isJsonOutput(args));
  }
  // parse the subcommand args through the shared spec so `--output-format` (and any
  // unknown flag) is handled structurally — NOT peeked positionally. was `loadBaseline(args[1])`
  // resolving `loadBaseline("--output-format")` for `vm status --output-format json`; the optional
  // baseline is now the (single) positional, parsed independently of the flag.
  const subArgs = args.slice(1); // drop the subcommand token
  let vmParsed;
  try {
    vmParsed = parseArgs(subArgs, {
      values: ["--output-format"],
      enums: { "--output-format": ["text", "json"] },
    });
  } catch (e) {
    return fail("vm", "usage", String((e as Error).message), undefined, isJsonOutput(args));
  }
  const vmJson = vmParsed.options["--output-format"] === "json";
  if (vmParsed.positionals.length > 1) {
    return fail(
      "vm",
      "usage",
      `vm ${sub} takes at most one baseline (got ${vmParsed.positionals.length}: ${vmParsed.positionals.join(", ")})`,
      undefined,
      vmJson,
    );
  }
  const baselineName = vmParsed.positionals[0] ?? "latest";
  const baseline = loadBaseline(baselineName);
  // the instance name is derived from the config hash (see lima.ts instanceName) — a config
  // change yields a new name, so a stale VM is never silently reused.
  const instance = instanceName(baseline);
  if (sub === "status") {
    const status = vmStatus(instance);
    // honor --output-format json (the flag was advertised but every branch printed text).
    if (vmJson) out(JSON.stringify(vmStatusEnvelope(baselineName, baseline, instance, status)));
    else log(`${instance}: ${status}`);
  } else if (sub === "init") {
    const { status } = vmInit(baseline);
    // honor --output-format json (init/delete/prune printed text unconditionally; only status did).
    if (vmJson) out(JSON.stringify({ ...vmEnvelopeBase("init", baselineName, baseline, instance, []), status }));
    else log(`${instance}: ${status}`);
  } else if (sub === "delete") {
    vmDelete(instance);
    if (vmJson) out(JSON.stringify({ ...vmEnvelopeBase("delete", baselineName, baseline, instance, []), deleted: true }));
    else log(`${instance} deleted`);
  } else if (sub === "prune") {
    const pruned = vmPrune(instance);
    if (vmJson) out(JSON.stringify({ ...vmEnvelopeBase("prune", baselineName, baseline, instance, []), pruned }));
    else log(pruned.length ? `pruned ${pruned.length} orphaned VM(s): ${pruned.join(", ")}` : `no orphaned VMs (current: ${instance})`);
  } else {
    // an invalid/absent subcommand must exit non-zero — a bare `log` exits 0, so a CI script
    // running `vm typo` would read it as success.
    fail("vm", "usage", "usage: vm <init|status|delete|prune>", undefined, isJsonOutput(subArgs));
  }
}

function cmdBoundary(args: string[]) {
  // Optional --session <file>: fold that session's egress additions into the boundary allowlist so the
  // self-test exercises the same boundary the session's runs would (not just baseline invariants).
  // accept --output-format so the advertised flag isn't rejected at runtime.
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
    return fail("boundary-check", "usage", (e as Error).message, undefined, json);
  }
  const sessionPath = p.options["--session"];
  // Reject extra baseline positionals rather than silently using only the first.
  if (p.positionals.length > 1) {
    return fail(
      "boundary-check",
      "usage",
      `boundary-check takes at most one baseline (got ${p.positionals.length}: ${p.positionals.join(", ")})`,
      undefined,
      json,
    );
  }
  const baseline = loadBaseline(p.positionals[0] ?? "latest");
  let sessionEgress: { extraAllow?: string[]; unrestricted?: boolean } | undefined;
  if (sessionPath) {
    // read + parse + load the session inside the command's usage-error path. Previously these ran
    // OUTSIDE the `fail(...,json)` path, so a missing file (ENOENT) or malformed YAML surfaced as a
    // top-level INTERNAL error with the JSON envelope never emitted. A bad --session is a usage error.
    if (!existsSync(sessionPath)) fail("boundary-check", "usage", `--session file not found: ${sessionPath}`, undefined, json);
    let s;
    try {
      s = loadSession(parseYaml(readFileSync(sessionPath, "utf8")));
    } catch (e) {
      return fail("boundary-check", "usage", `cannot parse --session ${sessionPath}: ${String((e as Error).message)}`, undefined, json);
    }
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

/** Best-effort fetch of the official per-version linux-arm64 release checksum from Anthropic's release
 *  channel. Returns undefined on ANY network/parse error so `sync` stays offline-capable (a missing
 *  manifest never fails the sync — the sha fields just fall back to measured-local or are omitted). */
async function fetchOfficialElfChecksum(version: string): Promise<string | undefined> {
  try {
    const r = await fetch(`https://downloads.claude.ai/claude-code-releases/${version}/manifest.json`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return undefined;
    const j = (await r.json()) as { platforms?: Record<string, { checksum?: string }> };
    return j?.platforms?.["linux-arm64"]?.checksum;
  } catch {
    return undefined;
  }
}

async function cmdSync(args: string[]) {
  // platform guard fires before arg parsing — wrong platform is an environment error, not a usage error.
  if (process.platform !== "darwin") {
    return fail("sync", "usage", "sync requires macOS (the Cowork Desktop app is macOS-only).", undefined, isJsonOutput(args));
  }
  // use parseArgs to reject unknown flags and positionals.
  // accept --force as a canonical alias for --allow-empty; normalize before parsing.
  const normalizedArgs = args.map((a) => (a === "--force" ? "--allow-empty" : a));
  let syncParsed;
  try {
    syncParsed = parseArgs(normalizedArgs, { booleans: ["--diff", "--allow-empty"] });
  } catch (e) {
    return fail("sync", "usage", (e as Error).message, undefined, isJsonOutput(normalizedArgs));
  }
  if (syncParsed.positionals.length > 0) {
    return fail(
      "sync",
      "usage",
      `sync takes no positional arguments (got: ${syncParsed.positionals.join(", ")})`,
      undefined,
      isJsonOutput(normalizedArgs),
    );
  }
  const allowEmpty = !!syncParsed.flags["--allow-empty"];
  const res = sync();

  // refuse to write a baseline with empty version fields. An empty appVersion would produce
  // `desktop-.json` (invalid filename); an empty agentVersion means resolveAgentBinary will fail.
  const versionErrors: string[] = [];
  if (!res.appVersion) versionErrors.push("appVersion (Desktop not found or Info.plist unreadable — install/open Claude Desktop)");
  if (!res.agentVersion) versionErrors.push("agentVersion (.sdk-version missing — open Cowork once to stage the agent binary)");
  if (versionErrors.length) {
    fail(
      "sync",
      "runtime",
      `ERROR: sync could not resolve required version fields — refusing to write baseline:\n${versionErrors.map((e) => `  - ${e}`).join("\n")}`,
      "Fix the above, then re-run `cowork-harness sync`.",
      isJsonOutput(normalizedArgs),
      1,
    );
  }

  // refuse to write a baseline with an empty allowlist unless --allow-empty is passed.
  // An empty allowDomains = default-deny on ALL egress, which silently breaks every scenario.
  if (res.allowDomains.length === 0) {
    log("WARNING: sync produced an empty allowDomains list (asar domain regex matched nothing — asar layout moved).");
    if (!allowEmpty) {
      fail(
        "sync",
        "runtime",
        "Refusing to write baseline with allowDomains: []. Fix the regex in cowork-sync.ts,\nor hand-edit network.allowDomains in an existing baseline, then re-run.",
        "Pass --allow-empty to force-write anyway (use only if you understand the egress impact).",
        isJsonOutput(normalizedArgs),
        1,
      );
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

  // recompute agentBinary.stagedPath when agentVersion changes.
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
  // Same convention-derivation for the NATIVE macOS binary hostloop spawns directly for the agent loop:
  //   ~/Library/Application Support/Claude/claude-code/<agentVersion>/claude.app/Contents/MacOS/claude
  const oldNativeStagedPath = (baseAgentBinary.nativeStagedPath as string) ?? "";
  const nativeVersionRe = /claude-code\/[^/]+\/claude\.app\/Contents\/MacOS\/claude$/;
  let derivedNativeStagedPath: string;
  if (nativeVersionRe.test(oldNativeStagedPath)) {
    derivedNativeStagedPath = oldNativeStagedPath.replace(
      nativeVersionRe,
      `claude-code/${res.agentVersion}/claude.app/Contents/MacOS/claude`,
    );
  } else {
    derivedNativeStagedPath = `~/Library/Application Support/Claude/claude-code/${res.agentVersion}/claude.app/Contents/MacOS/claude`;
    if (oldNativeStagedPath)
      log(
        `WARNING: agentBinary.nativeStagedPath layout was unexpected ("${oldNativeStagedPath}") — rewrote to the canonical path for ${res.agentVersion}.`,
      );
  }
  const resolvedNativeDerived = derivedNativeStagedPath.replace(/^~(?=$|\/)/, join(process.env.HOME ?? "~"));
  if (!existsSync(resolvedNativeDerived)) {
    log(`WARNING: derived agentBinary.nativeStagedPath does not exist on this machine: ${derivedNativeStagedPath}`);
    log(`  (The new agentVersion is ${res.agentVersion}. Open Cowork once to stage the binary, then re-run sync.)`);
    log(`  resolveHostAgentBinary will fail until the file is present or COWORK_HOST_AGENT_BINARY is set.`);
  }
  // Agent-binary provenance (shared, non-secret): record the ELF sha256 + how we know it. Prefer a
  // measured-local hash of the staged binary (the point-of-truth) + cross-check against the official
  // release manifest; if the binary isn't staged on this machine, fall back to the official-manifest hash
  // (staging-identity unverified); if offline AND this is a re-sync of the SAME version, keep the base's
  // recorded hash; otherwise drop the fields rather than carry a stale hash from a different version.
  const officialElfChecksum = await fetchOfficialElfChecksum(res.agentVersion);
  let shaFields: { sha256?: string; shaProvenance?: string; manifestChecksumMatch?: boolean | "unknown" } = {};
  if (existsSync(resolvedDerived)) {
    const measured = sha256File(resolvedDerived);
    shaFields = {
      sha256: measured,
      shaProvenance: "measured-local",
      manifestChecksumMatch: officialElfChecksum === undefined ? "unknown" : measured === officialElfChecksum,
    };
    if (officialElfChecksum !== undefined && measured !== officialElfChecksum) {
      log(
        `WARNING: staged agent ELF sha256 (${measured}) != official linux-arm64 manifest checksum (${officialElfChecksum}) for ${res.agentVersion} — the staged binary is NOT the stock release; fidelity may be affected.`,
      );
    }
  } else if (officialElfChecksum !== undefined) {
    shaFields = { sha256: officialElfChecksum, shaProvenance: "official-manifest" };
  } else if ((base.agentVersion as string | undefined) === res.agentVersion) {
    // offline re-sync of the same version — keep what the base recorded rather than dropping it.
    shaFields = {
      sha256: baseAgentBinary.sha256 as string | undefined,
      shaProvenance: baseAgentBinary.shaProvenance as string | undefined,
      manifestChecksumMatch: baseAgentBinary.manifestChecksumMatch as boolean | "unknown" | undefined,
    };
  }
  // Spread base first, then explicitly set the sha fields (undefined values are dropped by JSON.stringify,
  // so a version bump we couldn't hash writes no stale sha256/shaProvenance/manifestChecksumMatch).
  const nextAgentBinary = {
    ...baseAgentBinary,
    stagedPath: derivedStagedPath,
    nativeStagedPath: derivedNativeStagedPath,
    sha256: shaFields.sha256,
    shaProvenance: shaFields.shaProvenance,
    manifestChecksumMatch: shaFields.manifestChecksumMatch,
  };

  // re-sync GrowthBook gate states from the decoded fcache (was: stale-carry + blanket warning).
  // Gates drive the cowork loop decision (decideLoopFromBaseline) and the dispatch cap; decoding the
  // fcache here makes a re-sync refresh them and surfaces real drift instead of silently carrying stale.
  const baseProvenance = (base.provenance ?? {}) as Record<string, unknown>;
  const baseGates = (baseProvenance.gates ?? {}) as Record<string, unknown>;
  let nextGates: Record<string, unknown> = baseGates;
  if (res.gates) {
    nextGates = {};
    // Preserve authored $comment / any non-pinned keys from the base.
    for (const [k, v] of Object.entries(baseGates)) if (k.startsWith("$")) nextGates[k] = v;
    // Gate keys are `name:id` (legacy bases may use a bare id). The id is the stable half — the name
    // comes from PINNED_GATES and can be renamed (e.g. a mislabel corrected), so the previous entry is
    // looked up by id when the exact key misses; its note/on-state carry across the rename instead of
    // being lost, and the carry-forward loop below must not resurrect the old key as a duplicate.
    const idOf = (k: string): string => (k.includes(":") ? k.slice(k.lastIndexOf(":") + 1) : k);
    for (const g of Object.values(res.gates)) {
      const key = `${g.name}:${g.id}`;
      const prevKey = key in baseGates ? key : Object.keys(baseGates).find((k) => !k.startsWith("$") && idOf(k) === g.id);
      const prev = prevKey !== undefined ? baseGates[prevKey] : undefined;
      if (prevKey !== undefined && prevKey !== key)
        log(`note: gate ${g.id} renamed in PINNED_GATES: ${prevKey} → ${key} (note/state carried over).`);
      // for a legacy prose entry the authoritative state is the LEADING `on(...)`/`off(...)` token
      // (the note stripper just below anchors on the same pattern) — a bare substring scan of the whole
      // string would let a human note containing "on"/"force" mask a real off→on flip.
      const prevOn = typeof prev === "string" ? /^\s*on\(/i.test(prev) : !!(prev as { on?: boolean } | undefined)?.on;
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
    // Match by gate ID, not exact key — after a PINNED_GATES rename the fresh entry lives under the
    // new `name:id` key, and an exact-key check would resurrect the old-named entry as a duplicate.
    const nextIds = new Set(
      Object.keys(nextGates)
        .filter((k) => !k.startsWith("$"))
        .map(idOf),
    );
    for (const [k, v] of Object.entries(baseGates)) {
      if (k.startsWith("$") || nextIds.has(idOf(k))) continue;
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

  const capturedAt = new Date().toISOString().slice(0, 10);
  const next = {
    ...base,
    $comment: `Platform baseline auto-derived by \`cowork-harness sync\` from a live Claude Desktop install + app.asar. VOLATILE per-release facts only. Regenerate per release; review the diff. Captured ${capturedAt} on macOS arm64.`,
    baselineVersion: 1,
    appVersion: res.appVersion,
    capturedAt,
    agentVersion: res.agentVersion,
    agentBinary: nextAgentBinary,
    network: { ...(base.network as object), mode: res.networkMode ?? "gvisor", allowKind: "allowlist", allowDomains: res.allowDomains },
    requireFullVmSandbox: res.requireFullVmSandbox,
    // spawn.env is the GENERATED tier: re-derived from the asar each sync, canonically
    // ordered so a benign source-reorder is a zero-line diff. All the hand-curated spawn fields (tools,
    // allowedTools, scalars, prompt pointers, $comment*) carry forward from base untouched. On a hard-fail
    // deriveSpawnEnv returns null and the base env is preserved (the all-or-nothing contract).
    spawn: {
      ...(base.spawn as object),
      env: canonicalizeEnv(
        res.spawnEnv ?? (base.spawn as { env?: Record<string, string> })?.env,
        (base.spawn as { env?: Record<string, string> })?.env,
      ),
    },
    provenance: { ...baseProvenance, gates: nextGates, asarFingerprint: res.asarFingerprint },
  };
  const diffFlag = !!syncParsed.flags["--diff"];
  if (diffFlag) {
    // Diff against `base` (the latest committed baseline `next` was merged onto), NOT a separate read of
    // `baselinePath`. On a genuine version bump `baselinePath` (desktop-<NEW version>.json) doesn't exist
    // yet, so reading it here used to always miss and print "no committed baseline yet" instead of the
    // appVersion/agentVersion/etc. diff docs/maintenance.md documents — going silent on exactly the
    // release-bump preview it exists for. `base` already holds the right comparison in both cases: on a
    // bump it's the previous version (the "old" side of the diff); on a same-version re-sync `baselinePath`
    // would just be re-reading the same file `base` came from. `base` is a fresh deep clone (`JSON.parse(
    // JSON.stringify(loadBaseline("latest")))` above) that nothing between here and there mutates in
    // place, so this surfaces real gate/content drift, not a diff against an already-updated copy.
    log(`=== diff vs latest committed baseline (desktop-${(base as { appVersion?: string }).appVersion}) ===`);
    // E7: structured recursive diff, replacing the one-level diff() that printed a whole subtree on
    // any nested change (e.g. a single gate flip three levels deep used to dump all of `provenance`).
    for (const line of formatDiffLines(diffBaselines(base, next))) log(`  ${line}`);
  }
  // Non-blocking informational hints (e.g. stale SPAWN_ENV_ALLOWLIST prune NOTEs): surfaced so they
  // get acted on, but they are NOT deltas and never block the write.
  if (res.notes.length) {
    log("\nℹ notes (non-blocking):");
    for (const n of res.notes) log("   - " + n);
  }
  if (res.unknownDeltas.length) {
    log("\n⚠ unknown deltas (extend src/sync/cowork-sync.ts):");
    for (const d of res.unknownDeltas) log("   - " + d);
    // unknown deltas block the write unless --diff (diagnosis mode) is active.
    if (!diffFlag && !allowEmpty) {
      fail(
        "sync",
        "runtime",
        "Refusing to write baseline with unknown deltas. Fix src/sync/cowork-sync.ts or pass --allow-empty to force-write.",
        undefined,
        isJsonOutput(normalizedArgs),
        1,
      );
    }
  }
  if (!diffFlag) {
    mkdirSync(BASELINES_DIR, { recursive: true });
    writeFileSync(baselinePath, JSON.stringify(next, null, 2));
    log(`wrote ${baselinePath}`);
    // The host-loop prompt asset is hand-authored (not extracted), so a new LEGACY baseline silently
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

/** `cowork-harness init-redact [--force]` — copy the packaged reference `.cowork-redact.json` into the
 *  cwd. The copy is load-bearing: `loadRedactionPolicy` searches cwd/scenario-dir/cassette-dir and
 *  never the package dir, so shipping the template alone does nothing until it's copied next to the
 *  scenarios. The reference policy is generic (host-path prefixes + a generic email regex) — a starting
 *  point to review and tailor, not a guarantee. Refuses to overwrite an existing policy without --force
 *  (silently replacing a tailored policy would be an under-redaction hazard). */
function cmdInitRedact(args: string[]) {
  const json = isJsonOutput(args);
  let p;
  try {
    p = parseArgs(args, { booleans: ["--force"], values: ["--output-format"], enums: { "--output-format": ["text", "json"] } });
  } catch (e) {
    return fail("init-redact", "usage", (e as Error).message, SUBCOMMAND_USAGE["init-redact"], json);
  }
  if (p.positionals.length > 0) {
    return fail("init-redact", "usage", `init-redact takes no positional arguments (got: ${p.positionals.join(", ")})`, undefined, json);
  }
  // dist/cli.js → <install>/.cowork-redact.json (shipped in the npm package "files").
  const src = fileURLToPath(new URL("../.cowork-redact.json", import.meta.url));
  const dest = resolve(process.cwd(), ".cowork-redact.json");
  if (!existsSync(src)) {
    // A missing template is a packaging bug — fail loud, never a vacuous "nothing to copy" success.
    return fail("init-redact", "runtime", `packaged redaction template not found at ${src} — reinstall cowork-harness`, undefined, json);
  }
  if (existsSync(dest) && !p.flags["--force"]) {
    return fail(
      "init-redact",
      "usage",
      `.cowork-redact.json already exists in ${process.cwd()} — refusing to overwrite a possibly-tailored policy`,
      "Pass --force to overwrite, or edit the existing file.",
      json,
    );
  }
  copyFileSync(src, dest);
  if (json) out(JSON.stringify({ command: "init-redact", ok: true, path: dest }));
  else {
    out(`✓ wrote ${dest} (reference template: local-path prefixes + a generic email regex)`);
    out("  Review and tailor the patterns before recording — the template is a starting point, not a guarantee.");
    out("  Policy search set at record time: cwd → the scenario's dir → the cassette's dir (+ COWORK_HARNESS_REDACT_* env).");
  }
}

function cmdList(args: string[] = []) {
  // reject unknown flags and positionals.
  // accept --output-format with enum validation so the advertised flag isn't rejected.
  ensureOutputFormat("list", args);
  const json = isJsonOutput(args);
  let listParsed;
  try {
    listParsed = parseArgs(args, { values: ["--output-format"], enums: { "--output-format": ["text", "json"] } });
  } catch (e) {
    return fail("list", "usage", (e as Error).message, undefined, json);
  }
  if (listParsed.positionals.length > 0) {
    return fail("list", "usage", `list takes no positional arguments (got: ${listParsed.positionals.join(", ")})`, undefined, json);
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

/** E4: one text-mode line per scenario. `--metric` narrows to a single focused view; omitted shows
 *  everything the row has (a metric with no telemetry in the group is simply absent, not "0"). */
function formatStatsLine(s: StatsSummary, metric?: string): string {
  const base = `${s.scenario}: ${s.runs} run(s), ${(s.passRate * 100).toFixed(0)}% pass`;
  const fmtCost = (v?: number) => (v !== undefined ? `$${v.toFixed(4)}` : "n/a");
  const fmtMs = (v?: number) => (v !== undefined ? `${(v / 1000).toFixed(1)}s` : "n/a");
  if (metric === "pass-rate") return base;
  if (metric === "cost") return `${base} — cost p50=${fmtCost(s.p50CostUsd)} p95=${fmtCost(s.p95CostUsd)}`;
  if (metric === "duration") return `${base} — duration p50=${fmtMs(s.p50DurationMs)} p95=${fmtMs(s.p95DurationMs)}`;
  if (metric === "tokens") return `${base} — tokens p50=${s.p50Tokens ?? "n/a"} p95=${s.p95Tokens ?? "n/a"}`;
  if (metric === "turns") return `${base} — turns p50=${s.p50Turns ?? "n/a"} p95=${s.p95Turns ?? "n/a"}`;
  if (metric === "cache-tokens")
    return `${base} — cache-read-tokens p50=${s.p50CacheReadTokens ?? "n/a"} p95=${s.p95CacheReadTokens ?? "n/a"}`;
  if (metric === "model-cost") return `${base} — model-cost p50=${fmtCost(s.p50ModelCostUsd)} p95=${fmtCost(s.p95ModelCostUsd)}`;
  const parts = [
    s.p50CostUsd !== undefined ? `cost p50=${fmtCost(s.p50CostUsd)} p95=${fmtCost(s.p95CostUsd)}` : null,
    s.p50DurationMs !== undefined ? `duration p50=${fmtMs(s.p50DurationMs)} p95=${fmtMs(s.p95DurationMs)}` : null,
    s.lastGreenTs ? `last green ${s.lastGreenTs}` : "never green",
    s.prunedRuns > 0 ? `${s.prunedRuns} pruned` : null,
  ].filter(Boolean);
  return `${base}${parts.length ? " — " + parts.join(", ") : ""}`;
}

/** `stats [<scenario>]` — a queryable summary over the run index (E4): per-scenario run count, pass rate,
 *  cost/duration/token/turn percentiles, last-green timestamp. Reads `<runsRoot>/index.jsonl`; `--reindex`
 *  rebuilds it from the physical run-dir tree first (the one-time local migration path for runs that
 *  predate the index, or if index.jsonl was ever lost/corrupted beyond its own per-line tolerance). */
function cmdStats(args: string[]) {
  if (hasHelp(args)) return void log(SUBCOMMAND_USAGE.stats);
  ensureOutputFormat("stats", args);
  const json = isJsonOutput(args);
  rejectUnknownFlags(
    "stats",
    args,
    [
      "--since",
      "--baseline",
      "--branch",
      "--metric",
      "--last",
      "--reindex",
      "--output-format",
      "--output-format=json",
      "--output-format=text",
    ],
    json,
  );
  const reindex = args.includes("--reindex");
  const since = readValueFlag("stats", args, "--since", json);
  const baseline = readValueFlag("stats", args, "--baseline", json);
  const branch = readValueFlag("stats", args, "--branch", json);
  const metric = readValueFlag("stats", args, "--metric", json);
  if (metric !== undefined && !["pass-rate", "cost", "tokens", "duration", "turns", "cache-tokens", "model-cost"].includes(metric))
    return void fail(
      "stats",
      "usage",
      `--metric must be one of pass-rate|cost|tokens|duration|turns|cache-tokens|model-cost (got "${metric}")`,
      undefined,
      json,
    );
  const lastRaw = readValueFlag("stats", args, "--last", json);
  let last: number | undefined;
  if (lastRaw !== undefined) {
    const n = Number(lastRaw);
    if (!Number.isInteger(n) || n < 1)
      return void fail("stats", "usage", `--last requires a positive integer (got "${lastRaw}")`, undefined, json);
    last = n;
  }
  const allPositionals = positionals(args, ["--output-format", "--since", "--baseline", "--branch", "--metric", "--last"]);
  if (allPositionals.length > 1) return void fail("stats", "usage", SUBCOMMAND_USAGE.stats, undefined, json);
  const scenario = allPositionals[0];

  const root = runsRoot();
  if (reindex) {
    const { written, skipped } = reindexFromRunsTree(root);
    log(`stats: reindexed ${written} run(s) from ${root}${skipped ? ` (${skipped} skipped — missing/corrupt result.json)` : ""}`);
  }
  const rows = readIndex(root);
  const stats = buildStats(rows, { scenario, since, baseline, branch, last });
  if (json) return void out(JSON.stringify({ tool: "cowork-harness", command: "stats", ok: true, stats }));
  if (stats.length === 0) return void log("stats: no indexed runs match the given filters.");
  for (const s of stats) log(formatStatsLine(s, metric));
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
  let deciderModel: string | undefined;
  const rules: AnswerRule[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--question")
      question = flagValueStrict("decide", args, i++, a, json); // bounds-checked; rejects flag-looking values
    else if (a === "--option") options.push(flagValueStrict("decide", args, i++, a, json));
    else if (a === "--decider-cmd") {
      deciderCmd = flagValue("decide", args, i++, a, json);
      // The helper command is never a flag — reject a flag-looking value so `--decider-cmd --question`
      // doesn't silently swallow the next flag as the command.
      if (deciderCmd.startsWith("-"))
        fail("decide", "usage", `--decider-cmd: missing value (got flag-looking "${deciderCmd}")`, undefined, json);
    } else if (a === "--decider-llm") deciderLlm = true;
    else if (a === "--intent") intent = flagValueStrict("decide", args, i++, a, json);
    else if (a === "--decider-model") deciderModel = flagValueStrict("decide", args, i++, a, json);
    else if (a === "--answer-policy") policy = flagValueStrict("decide", args, i++, a, json);
    else if (a === "--answer") {
      const raw = flagValueStrict("decide", args, i++, a, json);
      const parts = splitEq(raw);
      if (!parts)
        fail("decide", "usage", `--answer requires "question-regex=choice" (got "${raw}" — both sides must be non-empty)`, undefined, json);
      const [q, choose] = parts!;
      rules.push({ when_question: q, choose });
    }
    // --output-format consumes a value in the equals-free form; skip it so its value isn't read as a
    // stray positional (isJsonOutput/ensureOutputFormat handle the actual parsing).
    else if (a === "--output-format") i++;
    // the equals form is fully supported by the parser; recognize it here as a no-op (it carries its
    // own value) so it doesn't fall through to the unknown-flag guard below and exit 2 like an outlier.
    else if (a === "--output-format=json" || a === "--output-format=text") {
      /* recognized; parsed by isJsonOutput/ensureOutputFormat */
    }
    // --decider-dir is rejected explicitly below with a redirect message; consume its value here so the
    // value isn't flagged as a stray positional before that guard fires.
    // check that the next token exists and doesn't look like a flag before consuming it.
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
    } else if (a === "--quiet" || a === "-q" || a === "--verbose") {
      /* accepted but currently a no-op in decide — wired for flag consistency */
    }
    // an unrecognized `--`-prefixed token used to be silently ignored (the loop had no else).
    else if (a.startsWith("--") && a !== "--output-format=json" && a !== "--output-format=text")
      fail("decide", "usage", `unknown flag: ${a}`, undefined, json);
    // single-dash flags other than -q are unknown; reject them explicitly (don't silently swallow -x etc.)
    else if (a.startsWith("-")) fail("decide", "usage", `unknown flag: ${a}`, undefined, json);
    // decide takes NO positionals (the sample question comes from --question, not a positional).
    else fail("decide", "usage", `decide takes no positional arguments (got: ${a})`, undefined, json);
  }
  // `decide` does not implement the file-rendezvous channel — reject `--decider-dir` loudly
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
  if (deciderModel !== undefined && !deciderLlm)
    fail("decide", "usage", "--decider-model requires --decider-llm (it sets the model that answers the question).", undefined, json);
  // pre-flight — exit 2 (usage error) when no decider is configured at all. Previously this
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
  // reject conflicting terminal deciders — both set, the LLM branch would silently win and the
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
      const d = await new LlmDecider(claudeCliComplete, intent, deciderModel || undefined).decide(req, ctx);
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
        process.exit(1); // cli-error-envelope-exempt: emits its own {matched:false} shape above, not jsonError
      }
      const answer = (d as { response: { answers?: Record<string, string> } }).response.answers?.[question];
      if (json) out(JSON.stringify({ tool: "cowork-harness", command: "decide", ok: true, matched: true, answer }));
      else log(`✓ rule matched: "${question}" → "${answer}"`);
    }
  } catch (e) {
    if (json) out(jsonError("decide", "runtime", String((e as Error).message)));
    else log(`✗ decider error: ${String((e as Error).message)}`);
    // Runtime failure → exit 2, matching the global "usage/runtime → 2" contract (SPEC §11). The JSON
    // envelope already tags this category "runtime"; the exit code now agrees. No-match/ABSTAIN stays 1.
    process.exit(2); // cli-error-envelope-exempt: emits its own custom envelope shape above, not jsonError
  }
}

/** `cowork-harness status <run-id | run-dir> [--follow] [--output-format json]` — read-only check of
 *  whether a background run is still alive (state/elapsed/tool counts), without relying on `ps aux`
 *  (unreliable across sandbox/PID-namespace boundaries — see docs/run-status.md). */
async function cmdStatus(args: string[]) {
  let p;
  try {
    p = parseArgs(args, { booleans: ["--follow"], values: ["--output-format"], enums: { "--output-format": ["text", "json"] } });
  } catch (e) {
    return fail("status", "usage", (e as Error).message, undefined, isJsonOutput(args));
  }
  if (p.positionals.length !== 1) {
    return fail("status", "usage", SUBCOMMAND_USAGE.status, undefined, isJsonOutput(args));
  }
  const json = p.options["--output-format"] === "json";
  let dir: string;
  try {
    dir = resolveStatusDir(p.positionals[0]);
  } catch (e) {
    return fail("status", "usage", (e as Error).message, undefined, isJsonOutput(args));
  }
  if (p.flags["--follow"]) {
    let lastLine: string | undefined;
    try {
      await followRunStatus(dir, (line) => {
        lastLine = line;
        out(line);
      });
    } catch (e) {
      // followRunStatus rejects for two distinct reasons — distinguish them by exit code so a script
      // doesn't have to string-match: exit 3 for "found it, but it's gone stale" (probably a SIGKILL'd
      // process — see isStatusStale in run-status.ts), exit 1 for "never found status.json at all"
      // (wrong dir, or the run genuinely never started). Neither is a silent hang.
      const err = e as Error & { stale?: boolean };
      log(err.message);
      return process.exit(err.stale ? 3 : 1);
    }
    // followRunStatus resolved — it only distinguishes "still running" from "reached a terminal state,"
    // not WHICH terminal state. The last line it wrote via the callback is always the JSON-serialized
    // RunStatus that made it resolve (the write always precedes the resolve — see followRunStatus's
    // `tick()`), so parse it to tell "done" from "error" and exit accordingly — matching the one-shot
    // (non---follow) branch below, which already exits 1 for `state:"error"`. A --follow run that ended
    // in error must not report a healthy exit 0.
    let terminalState: RunStatus["state"] | undefined;
    if (lastLine) {
      try {
        terminalState = (JSON.parse(lastLine) as RunStatus).state;
      } catch {
        /* malformed last line (shouldn't happen — followRunStatus only ever writes JSON.stringify(status))
         * — fall through to the healthy default rather than crash the CLI on exit. */
      }
    }
    return process.exit(terminalState === "error" ? 1 : 0);
  }
  if (!hasRunStatus(dir)) {
    return fail(
      "status",
      "runtime",
      `no status.json at ${dir} — the run may not have reached its status-writing point yet, or this isn't a cowork-harness run dir`,
      undefined,
      isJsonOutput(args),
      1,
    );
  }
  let status: RunStatus;
  try {
    status = readRunStatus(dir);
  } catch (e) {
    // readRunStatus's own contract (see run-status.ts) is "throws on missing/malformed — the CLI
    // translates that into a usage-style message" — this is that translation. writeJsonAtomic makes a
    // genuinely malformed file rare (a reader can never observe a half-write), but a hand-edited or
    // externally-corrupted file must still fail clean, not with a raw stack trace.
    return fail(
      "status",
      "runtime",
      `status.json at ${dir} is unreadable/malformed: ${(e as Error).message}`,
      undefined,
      isJsonOutput(args),
      1,
    );
  }
  // A "running" status that's gone STALE means the writer stopped updating altogether — the SIGKILL/OOM
  // case the crash-safety net (execute.ts's exit handler) structurally cannot catch. Without this check
  // a hard-killed run would read as alive FOREVER on a one-shot `status` call — the exact false-liveness
  // conclusion this feature exists to prevent (see docs/run-status.md).
  const stale = isStatusStale(status);
  if (json) {
    out(
      JSON.stringify({
        tool: "cowork-harness",
        version: pkgVersion(),
        command: "status",
        ok: status.state !== "error" && !stale,
        stale,
        ...status,
      }),
    );
  } else {
    const totalTools = Object.values(status.toolCounts).reduce((a, b) => a + b, 0);
    const label = stale ? "probably-dead (stale)" : status.state;
    const glyph = stale ? "?" : status.state === "running" ? "●" : status.state === "done" ? "✓" : "✗";
    const staleNote = stale
      ? ` — no update in ${Math.round((Date.now() - Date.parse(status.updatedAt)) / 1000)}s; the process likely died without a clean exit (e.g. SIGKILL/OOM)`
      : "";
    log(
      `${glyph} ${label} — ${status.scenario} [${status.fidelity}] · pid ${status.pid} · ` +
        `${Math.round(status.elapsedMs / 1000)}s · ${totalTools} tools · ${status.subagentCount} sub-agents${staleNote}`,
    );
  }
  // Exit codes: 0 healthy (running/done, not stale) · 1 the run itself errored · 2 usage error (thrown
  // earlier) · 3 stale/probably-dead — distinct from 1 so a script can tell "it failed" from "can't
  // confirm it's alive" without parsing text.
  return process.exit(stale ? 3 : status.state === "error" ? 1 : 0);
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
  // validate --output-format before isJsonOutput so an unrecognized value is a usage error.
  ensureOutputFormat("answer", args);
  const json = isJsonOutput(args);
  // skip flag values so `answer --gate 1 --choose Yes <dir>` doesn't read `1` as the directory.
  const answerPositionals = positionals(args, ["--gate", "--choose", "--answer", "--output-format"]);
  // reject extra positionals rather than silently writing to the first dir (mirrors `gates`).
  if (answerPositionals.length > 1) return void fail("answer", "usage", "answer takes one <dir>", undefined, json);
  const dir = answerPositionals[0];
  let seq: number | undefined;
  // --choose accumulates: a single value answers a single-select gate; multiple values answer a
  // multiSelect gate (validated once the gate is read — a multi --choose on a single-select gate is
  // rejected below, preserving the old "only one allowed" rule for that case).
  const chooses: string[] = [];
  const pairs: { q: string; label: string }[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--gate")
      seq = Number(flagValue("answer", args, i++, a, json)); // bounds-checked
    else if (a === "--choose") {
      chooses.push(flagValueStrict("answer", args, i++, a, json));
    } else if (a === "--answer") {
      const raw = flagValueStrict("answer", args, i++, a, json);
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
      // reject unknown flags
      return void fail("answer", "usage", `unknown flag: ${a}`, undefined, json);
    }
    // positionals already handled above via positionals() helper
  }
  // reject conflicting --choose and --answer
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

/** `scaffold <run-id | run-dir>` — turn a kept run into a starter scenario YAML (observed gates → answers,
 *  artifacts → file_exists, the prompt). Authoring becomes explore→lock instead of guess-and-re-run. */
function cmdScaffold(args: string[]) {
  const json = isJsonOutput(args);
  // validate --output-format is text|json — an invalid value was a silent text degrade (only
  // isJsonOutput was consulted), unlike decide/gates/trace.
  ensureOutputFormat("scaffold", args);
  // The retired `--from-run` alias gets a targeted hint (it had users pre-1.0); any other unknown
  // flag falls through to the generic loud rejection below.
  if (args.some((a) => a === "--from-run" || a.startsWith("--from-run=")))
    fail("scaffold", "usage", "unknown flag: --from-run (removed — use the positional form)", SUBCOMMAND_USAGE.scaffold, json);
  // Reject unknown flags rather than silently ignoring a typo (e.g. `--form-run`).
  rejectUnknownFlags("scaffold", args, ["--out", "--output-format", "--output-format=json", "--output-format=text"], json);

  // Validate --out FIRST (flag-looking value is a usage error).
  // honor BOTH the spaced (`--out foo`) and equals (`--out=foo`) forms — indexOf("--out") missed the
  // equals token, so `--out=foo.yaml` was accepted by rejectUnknownFlags then silently ignored (output went
  // to stdout). The equals value also gets the same flag-looking guard the spaced form has.
  const outSpaceIdx = args.indexOf("--out");
  const outEqIdx = args.findIndex((a) => a.startsWith("--out="));
  let outPath: string | undefined;
  if (outSpaceIdx >= 0) outPath = flagValue("scaffold", args, outSpaceIdx, "--out", json);
  else if (outEqIdx >= 0) outPath = args[outEqIdx].slice("--out=".length);
  if (outPath !== undefined && (outPath === "" || outPath.startsWith("-")))
    return void fail(
      "scaffold",
      "usage",
      `--out requires a file path${outPath === "" ? " (got empty)" : `, got a flag: ${outPath}`}`,
      undefined,
      json,
    );

  // Positional is the only (canonical) form for the run id/dir.
  const target = positionals(args, ["--out", "--output-format"])[0];
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

/** Reconstruct the AskUserQuestion gates (WITH their offered options) a kept run actually fired,
 *  from its `events.jsonl` (the verbatim child→driver stream — the only sidecar that retains options; the
 *  distilled trace.json drops them). Returns the question-kind DecisionRequests, or `null` if events.jsonl is
 *  absent/unreadable (distinct from "present but zero gates" → `[]`). A malformed frame is skipped, not fatal —
 *  these are harness-written and should be well-formed; `toDecisionRequest` throws on a bad frame, so guard it. */
function parseGatesFromEvents(file: string): DecisionRequest[] | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const gates: DecisionRequest[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(t);
    } catch {
      continue;
    }
    if ((msg as { type?: string })?.type !== "control_request") continue;
    let req: DecisionRequest | null = null;
    try {
      req = toDecisionRequest(msg);
    } catch {
      continue; // malformed AskUserQuestion frame — not the linter's job to fail on; skip
    }
    if (req && req.kind === "question") gates.push(req);
  }
  return gates;
}

/** The question text used to label a gate in answer-coverage output. */
function gateQuestionLabel(req: DecisionRequest): string {
  if (req.kind !== "question") return "(gate)";
  const q0 = req.questions[0];
  return q0?.question ?? q0?.header ?? "(question)";
}

/**
 * `verify-run <run-dir> <scenario.yaml>` — re-evaluate a scenario's `assert:` block against an
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
async function cmdVerifyRun(args: string[]) {
  let p;
  try {
    p = parseArgs(args, { values: ["--output-format"], enums: { "--output-format": ["text", "json"] } });
  } catch (e) {
    return fail("verify-run", "usage", (e as Error).message, undefined, isJsonOutput(args));
  }
  const json = p.options["--output-format"] === "json";
  const [runDir, scenarioFile] = p.positionals;
  if (!runDir || !scenarioFile) {
    return fail("verify-run", "usage", "usage: verify-run <run-dir> <scenario.yaml> [--output-format json]", undefined, isJsonOutput(args));
  }
  if (p.positionals.length > 2) {
    return fail(
      "verify-run",
      "usage",
      `verify-run takes <run-dir> <scenario.yaml> (got ${p.positionals.length}: ${p.positionals.join(", ")})`,
      undefined,
      isJsonOutput(args),
    );
  }
  const resultPath = join(runDir, "result.json");
  if (!existsSync(resultPath)) {
    return fail(
      "verify-run",
      "runtime",
      `verify-run: no result.json under ${runDir} (is this a kept run dir? e.g. runs/<scenario>/<sessionId>/)`,
      undefined,
      isJsonOutput(args),
    );
  }
  let result: RunResult;
  try {
    result = JSON.parse(readFileSync(resultPath, "utf8")) as RunResult;
  } catch (e) {
    return fail("verify-run", "runtime", `verify-run: cannot read ${resultPath}: ${(e as Error).message}`, undefined, isJsonOutput(args));
  }
  // A partial run did NOT complete (it exited on an unanswered gate). Its assertion outcome is empty and its
  // artifacts are pre-failure, so re-evaluating asserts against it would vouch for a run that never finished.
  // Refuse rather than false-fail or false-pass.
  if (result.partial) {
    return fail(
      "verify-run",
      "runtime",
      `verify-run: ${runDir} is a PARTIAL run — it did not complete (exited on an unanswered gate). ` +
        `Re-run to completion before verifying. (can't verify ⇒ not green)`,
      undefined,
      isJsonOutput(args),
    );
  }
  let scenario;
  try {
    scenario = parseScenarioFile(scenarioFile);
  } catch (e) {
    return fail(
      "verify-run",
      "runtime",
      `verify-run: cannot load scenario ${scenarioFile}: ${(e as Error).message}`,
      undefined,
      isJsonOutput(args),
    );
  }

  const workRoot = result.workDir ?? "";
  const scan = result.scan ?? { outputsDeletes: [], hostPathLeaked: false, selfHealRan: false };
  // FS-class assertions resolve under workRoot; if it's gone we can't faithfully re-check them — refuse
  // rather than report a false fail. Content-only re-asserts stay valid without it. no_unexpected_files
  // belongs here too: on a missing workRoot its post-run walk returns [] → zero created files → a vacuous
  // PASS (the other FS keys false-FAIL safe-direction; this one false-GREENS, the worse failure mode).
  const FS_KEYS: (keyof Assertion)[] = ["file_exists", "user_visible_artifact", "artifact_json", "no_unexpected_files"];
  const hasFsAssert = scenario.assert.some((a) => FS_KEYS.some((k) => a[k] !== undefined));
  if (hasFsAssert && !existsSync(workRoot)) {
    return fail(
      "verify-run",
      "runtime",
      `verify-run: work dir not found (${workRoot || "<unset>"}) — filesystem assertions ` +
        `(file_exists/artifact_json/user_visible_artifact/no_unexpected_files) cannot be re-evaluated from this run dir; re-record. (can't verify ⇒ not green)`,
      undefined,
      isJsonOutput(args),
    );
  }

  const sidecarTranscript = readTranscriptSidecar(join(runDir, "run.jsonl"));
  const sidecarQuestions = readQuestionsSidecar(join(runDir, "trace.json"));
  const ctx: AssertContext = {
    transcript: sidecarTranscript ?? "",
    toolsCalled: new Set(Object.keys(result.toolCounts ?? {})),
    subagentTools: new Set((result.subagents ?? []).flatMap((s) => (s.toolsUsed ?? []).map((d) => d.name))),
    egress: result.egress ?? [],
    result: result.result === "error" ? "error" : "success",
    workRoot,
    // Read the roots persisted at run time (folder mount names are dynamic/gated, not a fixed prefix).
    // Fall back to the legacy prefix for old result.json that predates the field.
    userVisiblePrefixes: result.userVisibleRoots ?? ["outputs", ".projects"],
    // Read-only folder inputs are captured body-less; keep artifact_json's verdict identical to the
    // replay lane (evidence-unavailable) instead of parsing the real on-disk input here.
    readonlyFolderRoots: result.readonlyFolderRoots ?? [],
    // result.json is the single source: every writer populates the field from the run's own
    // pre-run-manifest.json, so a missing field means the baseline genuinely doesn't exist
    // (pre-field run, or the run never captured) — evidence-unavailable, loud.
    preRunPaths: result.preRunPaths,
    outputsDeletes: scan.outputsDeletes,
    questions: sidecarQuestions ?? [],
    hostPathLeaked: scan.hostPathLeaked,
    selfHealRan: scan.selfHealRan,
    subagents: result.subagents ?? [],
    gateDeliveries: result.gateDeliveries ?? [],
    gateDeliveriesMissing: result.gateDeliveries === undefined,
    toolResultTexts: (result.toolResults ?? []).map((r) => r.assertText ?? r.text),
    toolResultsTruncated: (result.toolResults ?? []).map((r) => r.assertText === undefined),
    toolErrors: result.toolErrors,
    transcriptMissing: sidecarTranscript === null,
    questionsMissing: sidecarQuestions === null,
    // Evidence-missing flags: set ONLY when the underlying field is undefined (partial/old result.json),
    // not when it is a legitimately-empty {}/[]. The producer serializes these unconditionally
    // (execute.ts), so in the verify-run lane `undefined` reliably means the evidence is absent — not
    // that the run produced none. Negative/absence assertions then fail loud instead of vacuously green.
    toolResultsMissing: result.toolResults === undefined,
    toolsCalledMissing: result.toolCounts === undefined,
    subagentsMissing: result.subagents === undefined,
    // Derive from `result.scan` directly — NOT the `scan` local, which already collapsed undefined into
    // the `{outputsDeletes:[],hostPathLeaked:false,selfHealRan:false}` default above.
    scanMissing: result.scan === undefined,
    skillsInvoked: result.skillsInvoked ?? [],
    skillsInvokedMissing: result.skillsInvoked === undefined,
    // `skillToolAvailable` predates being persisted on older result.json too; default true rather than
    // false so an old run's skill_triggered doesn't spuriously read as evidence-unavailable for the WRONG
    // reason (agent-tool-drift) when the real reason is just "this field didn't exist yet".
    skillToolAvailable: result.skillToolAvailable ?? true,
    skillActivity: result.skillActivity,
    tasks: result.tasks,
    // Context/Connectors panel (§6.2, M6) — backs skill_available/connector_available/tool_available.
    // result.json's own `context` was fully populated at RunResult-assembly time, so this is a
    // straight read-through (no timing gap unlike the live evaluate() ctx in execute.ts).
    availableSkills: result.context?.availableSkills,
    mcpServers: result.context?.mcpServers,
    availableTools: result.context?.tools,
    effectiveFidelity: result.effectiveFidelity,
    // verify-run re-checks a kept run dir on the SAME machine that ran it — the plan groups this
    // with the live execute.ts lane (both check a host-shaped computer:// link's path directly).
    linkResolution: { mode: "live" },
    ...budgetFields(result),
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

  // Answer-COVERAGE check — does the scenario's scripted `answers` actually match the gates the
  // run fired? This is invisible to the assert-only path, so a fragile answer (label/question drift) only
  // surfaced on a paid record. PRECONDITION: gated on `scenario.answers.length` — an answer-less scenario
  // behaves EXACTLY as before (assert-only; events.jsonl irrelevant; no refusal), preserving existing runs.
  let answerCoverage: { matched: number; total: number } | undefined;
  if (scenario.answers.length > 0) {
    // CURRENCY: answer-coverage validates against the kept run's gate SNAPSHOT (its events.jsonl). If the skill
    // changed since the run was kept, those gates are stale and a green here is false confidence — the real
    // gates moved. Refuse rather than vouch (can't verify ⇒ not green). Every run as of this version persists a
    // fingerprint; an older run without one → warn (can't check). A run with no skill dirs → nothing to drift.
    const recFp = result.fingerprint;
    if (recFp === undefined) {
      log(
        `verify-run: ::warning:: this kept run carries no skill fingerprint (recorded by an older harness) — ` +
          `cannot confirm it is current vs the skill; re-keep a fresh run to be sure answer-coverage is against live gates.`,
      );
    } else if (recFp.skillHash !== undefined) {
      const liveFp = buildFingerprint(scenario.session, recFp.baseline, undefined, scenario.skills);
      const drift = fingerprintSkillDrift(recFp, liveFp);
      if (drift) {
        return fail(
          "verify-run",
          "runtime",
          `verify-run: the kept run predates the current skill — ${drift}. Its gate snapshot is stale, so ` +
            `answer-coverage can't be trusted; re-keep a fresh run (or re-record). (can't verify ⇒ not green)`,
          undefined,
          isJsonOutput(args),
        );
      }
    }
    const gates = parseGatesFromEvents(join(runDir, "events.jsonl"));
    if (gates === null) {
      return fail(
        "verify-run",
        "runtime",
        `verify-run: scenario declares answers but ${runDir} has no events.jsonl — cannot verify answer coverage ` +
          `(re-keep the run with the gates, or drop answers). (can't verify ⇒ not green)`,
        undefined,
        isJsonOutput(args),
      );
    }
    const decider = new ScriptedDecider(scenario.answers);
    const stubCtx: RunContext = {
      task: scenario.prompt ?? "",
      transcript: () => sidecarTranscript ?? "",
      toolLog: () => [],
      runId: "verify-run",
    };
    const softFallback = scenario.on_unanswered === "first" || scenario.on_unanswered === "llm";
    let matched = 0;
    for (const gate of gates) {
      const q = gateQuestionLabel(gate);
      try {
        const d = await decider.decide(gate, stubCtx);
        if (d === ABSTAIN) {
          // No scripted rule matched this gate. If on_unanswered would auto-answer (first/llm), it's not a
          // coverage failure; otherwise the live run would fall to fail — flag it (the false-green we guard).
          if (!softFallback)
            assertions.push({
              assertion: { answer_coverage: q } as unknown as Assertion,
              pass: false,
              message: `no answer rule matched gate "${q}" (on_unanswered=${scenario.on_unanswered ?? "fail"})`,
            });
        } else {
          matched++;
        }
      } catch (e) {
        // ScriptedDecider throws (UnansweredError) when a `choose:` label matches no offered option, or the
        // single/multi shape is wrong — the answer is INVALID against what the run actually offered. A miss.
        assertions.push({
          assertion: { answer_coverage: q } as unknown as Assertion,
          pass: false,
          message: `answer for gate "${q}" is invalid against the offered options: ${(e as Error).message}`,
        });
      }
    }
    answerCoverage = { matched, total: gates.length };
  }

  // Verdict via the SAME path as a live record (the run dir is a live run, so the "live" lane honors the
  // scan/parity signals already persisted in result.json). Synthetic answer_coverage failures (above) flow
  // through here as `code:"assertion"` fails — so verify-run can now exit 1 on an answer miss, not just an
  // assert miss. Answer-less scenarios never add any, so their exit code is unchanged.
  const verdict = computeVerdict({ ...result, assertions }, "live");
  const failed = assertions.filter((a) => !a.pass);

  if (json) {
    out(
      JSON.stringify({
        command: "verify-run",
        pass: verdict.pass,
        assertions: assertions.map((a) => ({ assertion: a.assertion, pass: a.pass, message: a.message })),
        signals: verdict.signals,
        answerCoverage,
      }),
    );
  } else {
    for (const a of assertions)
      log(`${a.pass ? "✓" : "✗"} ${Object.keys(a.assertion).join("+") || "(assertion)"}${a.message ? ` — ${a.message}` : ""}`);
    for (const s of verdict.signals.filter((s) => s.code !== "assertion"))
      log(`${s.severity === "fail" ? "✗" : "·"} ${s.code}: ${s.message}`);
    if (answerCoverage) log(`· answer coverage: ${answerCoverage.matched}/${answerCoverage.total} gate(s) matched a scripted answer`);
    log(
      verdict.pass
        ? `✓ verify-run: all ${assertions.length} assertion(s) pass (no live agent)`
        : `✗ verify-run: ${failed.length}/${assertions.length} assertion(s) failed`,
    );
  }
  return process.exit(verdict.exitCode);
}

/** `assertions --list` — enumerate the available assertion keys + one-line semantics, generated from the
 *  Zod `Assertion` schema (`Assertion.shape[k].description`) so the list can NEVER drift from the schema. */
function cmdAssert(args: string[]) {
  const json = isJsonOutput(args);
  // validate --output-format is text|json (an invalid value was a silent text degrade).
  ensureOutputFormat("assertions", args);
  if (!args.includes("--list")) return void fail("assertions", "usage", "usage: assertions --list [--output-format json]", undefined, json);
  // `assertions --list` takes no positionals and no other flags; reject stray ones rather than
  // silently ignoring them (e.g. `assertions --list extra` or `assertions --list --bogus`).
  const stray = positionals(args, ["--output-format"]);
  if (stray.length)
    return void fail("assertions", "usage", `assertions --list takes no positional arguments (got: ${stray.join(", ")})`, undefined, json);
  rejectUnknownFlags("assertions", args, ["--list", "--output-format", "--output-format=json", "--output-format=text"], json);
  const shape = Assertion.shape as Record<string, { description?: string }>;
  const keys = Object.keys(shape).map((k) => ({ key: k, description: shape[k].description ?? "" }));
  if (json) return void out(JSON.stringify({ tool: "cowork-harness", command: "assertions", assertions: keys }));
  const width = Math.max(...keys.map((k) => k.key.length));
  out(`available assertions (${keys.length}) — use under a scenario's \`assert:\` list:\n`);
  for (const { key, description } of keys) out(`  ${key.padEnd(width)}  ${description}`);
}

function cmdTrace(args: string[]) {
  ensureOutputFormat("trace", args);
  const json = isJsonOutput(args);

  // --view tools|questions|dispatches replaces the three boolean flags. Legacy flags kept as aliases.
  const viewIdx = args.indexOf("--view");
  const viewEqMatch = args.find((a) => a.startsWith("--view="));
  let viewArg: string | undefined = viewEqMatch ? viewEqMatch.slice("--view=".length) : viewIdx >= 0 ? args[viewIdx + 1] : undefined;

  const VIEWS = ["tools", "questions", "dispatches", "tool-durations"] as const;
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

  // --translate-paths (Item 2's trace consumer): rewrite VM paths to host paths in TEXT output only —
  // `--output-format json` stays the raw machine record (see cli.ts's gating below and
  // vm-path-ctx-file.ts's module header for the full rationale).
  const translatePaths = args.includes("--translate-paths");

  // reject unknown flags (typos like --ouput-format silently fell through before).
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
      "--translate-paths",
    ],
    json,
  );

  // skip the `--output-format` and `--view` values so they don't get treated as the target path.
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
      "usage: trace <run-id | run-dir | events.jsonl> [--view tools|questions|dispatches|tool-durations] [--translate-paths] [--output-format json]",
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
    // questions view: question → injected answer → delivered result, the full gate lifecycle.
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
  if (view === "tool-durations") {
    // tool-durations view: per-tool call-count/timing aggregate, folded from the sibling timeline.jsonl.
    const durations = buildToolDurations(file);
    if (json) out(JSON.stringify({ tool: "cowork-harness", command: "trace", file, durations }));
    else out(formatToolDurations(durations));
    return;
  }
  // Build the translator, if any, ONLY for text output — json is the raw machine record and must stay
  // untranslated. Gate (all three must hold): the flag was passed, a sibling mounts.json exists and
  // parses as a recognized (v1) ctx, and the run's EFFECTIVE fidelity was "hostloop" — the one tier
  // where the resolved host path is production-identical (see display-translate.ts's module header).
  let translate: ((text: string) => string) | undefined;
  if (translatePaths && !json) {
    const loaded = loadVmPathContext(dirname(file));
    if (loaded && loaded.effectiveFidelity === "hostloop") {
      translate = makeDisplayTranslator({ ctx: loaded.ctx, effectiveFidelity: loaded.effectiveFidelity, shareable: false });
    }
  }
  const rows = buildTrace(file, { tools: view === "tools", translate });
  if (json) out(JSON.stringify({ tool: "cowork-harness", command: "trace", file, rows }));
  else {
    // cache-read-ratio footer (§4.7, M3): best-effort read of the sibling result.json, same
    // "if absent, just omit" tolerance buildGateTrace already uses for gate provenance.
    let modelUsage: RunResult["modelUsage"] | undefined;
    const resultPath = join(dirname(file), "result.json");
    if (existsSync(resultPath)) {
      try {
        modelUsage = (JSON.parse(readFileSync(resultPath, "utf8")) as RunResult).modelUsage;
      } catch (e) {
        log(`::warning:: trace: skipping unparseable ${resultPath}: ${String((e as Error).message)}`);
      }
    }
    out(formatTrace(rows, { modelUsage }));
  }
}

type DiffKind = "baseline" | "run" | "cassette";

// Every message type parseMessage/the SDK stream can emit at top level — used only to recognize a
// single-line events.jsonl (see detectDiffKind); not a schema, just a disambiguation signal.
const SDK_MESSAGE_TYPES = new Set(["system", "assistant", "user", "result", "control_request", "control_response"]);

/** Kind detection by CONTENT, not filename or `resolveEventsFile` alone. Two real bugs, found only by
 *  actually running the command against real files (not synthetic unit tests — §9 lesson 1/2), forced
 *  this design:
 *  1. A first attempt checked `arg.endsWith(".cassette.json")` for cassette, else `resolveEventsFile`
 *     for run. `resolveEventsFile` accepts ANY existing file path UNCONDITIONALLY (it's built for
 *     `trace`, which assumes its argument already IS an events.jsonl) — so a cassette file not literally
 *     named `*.cassette.json` silently became "run": the whole cassette object, read as one "event
 *     line", matched no known message type and produced a SILENTLY EMPTY tool list instead of an error.
 *  2. The fix (content-sniff for `scenario`+`events` before falling to `resolveEventsFile`) then broke
 *     the SAME way in the other direction: a baseline JSON file is *also* an existing file
 *     `resolveEventsFile` accepts unconditionally, so it fell through to "run" instead of "baseline"
 *     the moment cassette-sniffing said no.
 *  The fix for both: for any existing FILE (baselines/cassettes/events.jsonl are all single files —
 *  directories and run-ids/fragments have no such ambiguity, `resolveEventsFile`'s own directory-walk
 *  and fragment-matching handle those safely), decide purely from content: cassette-shaped (has
 *  `scenario`+`events`) → cassette; a single JSON object whose `type` is a real SDK message type → run
 *  (a single-line events.jsonl); any other single JSON document → baseline (PlatformBaseline.parse is
 *  the real validator at load time); doesn't parse as ONE JSON document at all → genuine multi-line
 *  NDJSON → run. */
function detectDiffKind(arg: string): DiffKind {
  if (existsSync(arg) && statSync(arg).isFile()) {
    let whole: unknown;
    try {
      whole = JSON.parse(readFileSync(arg, "utf8"));
    } catch {
      whole = undefined; // not a single JSON document — genuine multi-line NDJSON
    }
    if (whole && typeof whole === "object") {
      const w = whole as Record<string, unknown>;
      if (Array.isArray(w.events) && w.scenario) return "cassette";
      if (typeof w.type === "string" && SDK_MESSAGE_TYPES.has(w.type)) return "run";
      return "baseline";
    }
    return "run";
  }
  try {
    resolveEventsFile(arg);
    return "run";
  } catch {
    /* not a resolvable run either — fall through */
  }
  return "baseline"; // validated for real by loadBaseline() at load time; unresolvable throws there
}

interface DiffSide {
  tools: NormalizedToolRow[];
  transcript: string;
  artifacts?: Array<[string, string]>; // undefined = no manifest available for this side
  meta: Partial<DiffMetaSummary>;
  // Identity metadata, NOT diffed content: used only for the cross-scenario warning (the plan's
  // "allow + warn" resolution — comparing two different scenarios is legitimate for skill-variant
  // comparison, but must be flagged, since the meta view doesn't surface scenario identity).
  scenarioName?: string;
}

/** Top-level (non-sub-agent, non-synthetic) tool_use events, canonicalized — the same shape both a run
 *  dir's events.jsonl and a cassette's events[] reduce to. */
function topLevelToolRows(lines: string[], source: string, normalize: boolean): NormalizedToolRow[] {
  return eventsFromLines(lines, source)
    .filter((e): e is Extract<typeof e, { type: "tool_use" }> => e.type === "tool_use" && !e.parentToolUseId && !e.synthetic)
    .map((e) => ({ name: e.name, canon: canonicalizeInput(e.input, normalize) }));
}

function loadRunSide(arg: string, normalize: boolean): DiffSide {
  const eventsFile = resolveEventsFile(arg);
  const runDir = dirname(eventsFile);
  const lines = readFileSync(eventsFile, "utf8").split("\n");
  const tools = topLevelToolRows(lines, eventsFile, normalize);
  const transcript = readTranscriptSidecar(join(runDir, "run.jsonl")) ?? "";
  let meta: Partial<DiffMetaSummary> = {};
  let artifacts: Array<[string, string]> | undefined;
  let scenarioName: string | undefined;
  const resultPath = join(runDir, "result.json");
  if (existsSync(resultPath)) {
    const result = JSON.parse(readFileSync(resultPath, "utf8")) as RunResult;
    scenarioName = result.scenario;
    meta = {
      result: result.result,
      effectiveFidelity: result.effectiveFidelity,
      baseline: result.baseline,
      assertionsPassed: (result.assertions ?? []).every((a) => a.pass),
    };
    // Hash on-disk if the workDir is still there (fresh/kept run); degrade to a size-based pseudo-hash,
    // clearly distinguishable ("size:N"), when it's torn down — never silently claim byte-verified
    // equality we can't back. A real cassette-side manifest always has a genuine sha256 (below).
    if (result.artifacts && result.workDir) {
      artifacts = result.artifacts.map(({ path, bytes }) => {
        const abs = join(result.workDir!, path);
        try {
          return [path, sha256File(abs)] as [string, string];
        } catch {
          return [path, `size:${bytes}`] as [string, string];
        }
      });
    }
  }
  return { tools, transcript, artifacts, meta, scenarioName };
}

function loadCassetteSide(file: string, normalize: boolean): DiffSide {
  const cassette = JSON.parse(readFileSync(file, "utf8")) as Cassette;
  const events = eventsFromLines(cassette.events, file);
  const tools = events
    .filter((e): e is Extract<typeof e, { type: "tool_use" }> => e.type === "tool_use" && !e.parentToolUseId && !e.synthetic)
    .map((e) => ({ name: e.name, canon: canonicalizeInput(e.input, normalize) }));
  // Mirror Run.drive()'s own transcript construction (non-parented assistant_text, joined) rather than
  // invoking the full replay engine just to get a transcript — replay's staleness/controlOut machinery
  // is unrelated overhead for a diff.
  const transcript = events
    .filter((e): e is Extract<typeof e, { type: "assistant_text" }> => e.type === "assistant_text" && !e.parentToolUseId)
    .map((e) => e.text)
    .join("\n");
  // Mirror Run.drive()'s own result classification (the last "result" event's isError) — same reasoning.
  const resultEvents = events.filter((e): e is Extract<typeof e, { type: "result" }> => e.type === "result");
  const lastResult = resultEvents[resultEvents.length - 1];
  const meta: Partial<DiffMetaSummary> = {
    result: lastResult ? (lastResult.isError ? "error" : "success") : undefined,
    effectiveFidelity: cassette.effectiveFidelity,
    baseline: cassette.scenario?.baseline,
    // assertionsPassed intentionally omitted: comparing frozen-vs-frozen assertion pass/fail needs a real
    // replay (staleness/controlOut-aware), out of scope for a structural diff — diffMeta skips a field
    // when BOTH sides omit it, so this degrades cleanly rather than comparing undefined to a run's real value.
  };
  const artifacts: Array<[string, string]> | undefined = cassette.artifacts?.map((m) => [m.path, m.sha256]);
  return { tools, transcript, artifacts, meta, scenarioName: cassette.scenario?.name };
}

function loadDiffSide(kind: DiffKind, arg: string, normalize: boolean): DiffSide {
  return kind === "cassette" ? loadCassetteSide(arg, normalize) : loadRunSide(arg, normalize);
}

interface DiffViewResult {
  tools: ToolDiffOp[];
  transcript: TranscriptDiffLine[];
  artifacts?: import("./run/cassette.js").FileSigDiff;
  meta: MetaDiffEntry[];
  identical: boolean;
}

function compareDiffSides(a: DiffSide, b: DiffSide, normalize: boolean): DiffViewResult {
  const tools = diffToolSequence(a.tools, b.tools);
  const transcript = diffTranscript(a.transcript, b.transcript, normalize);
  const artifacts = a.artifacts && b.artifacts ? diffArtifacts(a.artifacts, b.artifacts) : undefined;
  const meta = diffMeta(a.meta, b.meta);
  const identical =
    tools.every((o) => o.op === "same") &&
    transcript.every((o) => o.op === "same") &&
    (!artifacts || (artifacts.added.length === 0 && artifacts.removed.length === 0 && artifacts.changed.length === 0)) &&
    meta.length === 0;
  return { tools, transcript, artifacts, meta, identical };
}

function renderDiffText(r: DiffViewResult, view: string): string[] {
  const lines: string[] = [];
  if (view === "tools" || view === "all") {
    const changed = r.tools.filter((o) => o.op !== "same");
    if (changed.length === 0) lines.push("tools: identical");
    else {
      lines.push("tools:");
      for (const op of changed) {
        if (op.op === "added") lines.push(`  + ${op.b.name} ${op.b.canon}`);
        else if (op.op === "removed") lines.push(`  - ${op.a.name} ${op.a.canon}`);
        else lines.push(`  ~ ${op.a.name}: ${op.a.canon} -> ${op.b.canon}`);
      }
    }
  }
  if (view === "transcript" || view === "all") {
    const changed = r.transcript.filter((o) => o.op !== "same");
    if (changed.length === 0) lines.push("transcript: identical");
    else {
      lines.push("transcript:");
      for (const op of changed) lines.push(`  ${op.op === "added" ? "+" : "-"} ${op.text}`);
    }
  }
  if (view === "artifacts" || view === "all") {
    if (!r.artifacts) lines.push("artifacts: no manifest on one or both sides — not compared");
    else if (r.artifacts.added.length === 0 && r.artifacts.removed.length === 0 && r.artifacts.changed.length === 0)
      lines.push("artifacts: identical");
    else {
      lines.push("artifacts:");
      for (const p of r.artifacts.added) lines.push(`  + ${p}`);
      for (const p of r.artifacts.removed) lines.push(`  - ${p}`);
      for (const p of r.artifacts.changed) lines.push(`  ~ ${p}`);
    }
  }
  if (view === "meta" || view === "all") {
    if (r.meta.length === 0) lines.push("meta: identical");
    else {
      lines.push("meta:");
      for (const e of r.meta) lines.push(`  ${e.field}: ${JSON.stringify(e.from)} -> ${JSON.stringify(e.to)}`);
    }
  }
  return lines;
}

/** E7 (baseline) + E2 (run/cassette, cross-comparable; baselines only pair with baselines). */
function cmdDiff(args: string[]) {
  if (hasHelp(args)) return void log(SUBCOMMAND_USAGE.diff);
  ensureOutputFormat("diff", args);
  const json = isJsonOutput(args);
  rejectUnknownFlags(
    "diff",
    args,
    ["--changelog", "--view", "--no-normalize", "--output-format", "--output-format=json", "--output-format=text"],
    json,
  );
  const changelog = args.includes("--changelog");
  const viewIdx = args.indexOf("--view");
  const view = viewIdx >= 0 ? flagValue("diff", args, viewIdx, "--view", json) : "all";
  if (!["tools", "transcript", "artifacts", "meta", "all"].includes(view))
    return void fail("diff", "usage", `--view must be one of tools|transcript|artifacts|meta|all (got "${view}")`, undefined, json);
  const allPositionals = positionals(args, ["--output-format", "--view"]);
  if (allPositionals.length !== 2) return void fail("diff", "usage", SUBCOMMAND_USAGE.diff, undefined, json);
  const [aName, bName] = allPositionals;

  const aKind = detectDiffKind(aName);
  const bKind = detectDiffKind(bName);
  if (aKind === "baseline" || bKind === "baseline") {
    if (aKind !== bKind)
      return void fail(
        "diff",
        "usage",
        `cannot compare a baseline against a ${aKind === "baseline" ? bKind : aKind} — baselines only pair with baselines`,
        undefined,
        json,
      );
    let a: PlatformBaseline, b: PlatformBaseline;
    try {
      a = loadBaseline(aName);
      b = loadBaseline(bName);
    } catch (e) {
      return void fail("diff", "usage", String((e as Error).message), undefined, json);
    }
    const entries = diffBaselines(a, b);
    const identical = entries.length === 0;
    if (json) out(JSON.stringify({ tool: "cowork-harness", command: "diff", kind: "baseline", a: aName, b: bName, identical, entries }));
    else if (changelog) out(renderChangelog(entries));
    else if (identical) out("No differences.");
    else for (const line of formatDiffLines(entries)) out(line);
    process.exit(identical ? 0 : 1);
  }

  // run/cassette — cross-comparable
  if (changelog) return void fail("diff", "usage", "--changelog is baseline-mode only", undefined, json);
  const normalize = !args.includes("--no-normalize");
  let a: DiffSide, b: DiffSide;
  try {
    a = loadDiffSide(aKind, aName, normalize);
    b = loadDiffSide(bKind, bName, normalize);
  } catch (e) {
    return void fail("diff", "usage", String((e as Error).message), undefined, json);
  }
  // Allow + warn on a cross-scenario comparison (the plan's recommended resolution of its own open
  // question): comparing runs of two DIFFERENT scenarios is legitimate (skill-variant comparison), but
  // the meta view doesn't surface scenario identity, so an unflagged mismatch would read as drift.
  // stderr only — stdout stays machine-clean in both output formats.
  if (a.scenarioName !== undefined && b.scenarioName !== undefined && a.scenarioName !== b.scenarioName)
    log(
      `::warning:: comparing runs of two different scenarios ("${a.scenarioName}" vs "${b.scenarioName}") — allowed, but added/removed rows may reflect scenario differences, not drift`,
    );
  const result = compareDiffSides(a, b, normalize);
  if (json) {
    out(
      JSON.stringify({
        tool: "cowork-harness",
        command: "diff",
        kinds: [aKind, bKind],
        a: aName,
        b: bName,
        identical: result.identical,
        views: { tools: result.tools, transcript: result.transcript, artifacts: result.artifacts, meta: result.meta },
      }),
    );
  } else if (result.identical) {
    out("identical");
  } else {
    for (const line of renderDiffText(result, view)) out(line);
  }
  process.exit(result.identical ? 0 : 1);
}

function cmdInspect(args: string[]) {
  if (hasHelp(args)) return void log(SUBCOMMAND_USAGE.inspect);
  ensureOutputFormat("inspect", args);
  const json = isJsonOutput(args);
  rejectUnknownFlags("inspect", args, ["--output-format", "--output-format=json", "--output-format=text"], json);
  const allPositionals = positionals(args, ["--output-format"]);
  if (allPositionals.length !== 1) return void fail("inspect", "usage", SUBCOMMAND_USAGE.inspect, undefined, json);
  // Resolve a run-id or run-dir to its dir. A run dir already holding result.json is used directly; otherwise
  // reuse trace's resolver (run-id → events.jsonl) and take the parent.
  const target = allPositionals[0];
  let runDir: string;
  try {
    runDir = existsSync(join(target, "result.json")) ? target : dirname(resolveEventsFile(target));
  } catch (e) {
    return void fail("inspect", "usage", String((e as Error).message), undefined, json);
  }
  try {
    out(buildInspectView(runDir, { json }));
  } catch (e) {
    return void fail("inspect", "usage", String((e as Error).message), undefined, json);
  }
}

main().catch((e) => {
  const command = process.argv[2] ?? "";
  const json = isJsonOutput(process.argv.slice(2));
  if (e instanceof UnansweredError) fail(command, "unanswered", e.message, e.hint, json);
  if (e instanceof BoundaryError) fail(command, "boundary", e.message, undefined, json);
  if (e instanceof UsageError) fail(command, "usage", e.message, undefined, json);
  // runtime/unexpected: keep the stack on stderr for humans; a structured envelope on stdout for json.
  if (json) out(jsonError(command, "internal", String(e?.message ?? e)));
  else log(String(e?.stack ?? e));
  process.exit(2); // cli-error-envelope-exempt: emits its own jsonError(...) call above (full stack on stderr for text mode), not a fail() plain-message shape
});
