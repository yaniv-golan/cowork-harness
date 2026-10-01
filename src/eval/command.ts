// `cowork-harness eval`: paired A/B evaluation of a skill edit.
//
// Everything that can refuse happens before the first run: arguments, scenarios and sessions, pins, the
// eval dir, the snapshots and their signatures, the answer-key guard and a per-arm staging preflight. Then
// the schedule runs through an injected `runJob` (the CLI passes the same per-scenario runner `run` uses; the
// tests pass a fake), each finished job appends one runs.jsonl line, and the report is written by the same
// function `eval report` calls.
import { pairwiseRefsRefusal, scenarioPairwiseSetup } from "../refs/preflight.js";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import { basename, join, relative, resolve } from "node:path";
import type { FidelityTier, RunResult, Scenario } from "../types.js";
import type { DoctorCheck } from "../run/doctor.js";
import type { SessionConfig } from "../session.js";
import { BoundaryError, UsageError } from "../errors.js";
import { applySessionOverrides, expandHome } from "../session.js";
import { loadBaseline } from "../baseline.js";
import { parseScenarioFile, loadSessionFromFile, scenarioInputFindings, sessionOriginSources, effectiveTier } from "../run/execute.js";
import { buildFingerprint } from "../run/cassette.js";
import { resolveInputs } from "../run/inputs.js";
import { pMapBounded } from "../async-pool.js";
import { envOutputFormat, parseOutputFormat, pkgVersion } from "../run/envelope.js";
import { tildeify } from "../io.js";
import { installTerminationHandler } from "../termination.js";
import { readIndex, type RunIndexRow } from "../run/run-index.js";
import { runsRoot } from "../run/trace-view.js";
import { checkBatchBudget, noHistoryCauseText, runsDirInfo } from "../run/budget.js";
import { recordBudgetStatus, type BudgetStatus } from "../run/budget-status.js";
import { resolveCritiquedSkillDir, gradedSkillNameFor } from "../critique/command.js";
import { scenarioRows } from "./classify.js";
import { attainableFloor, minRowsToConfirm, type Correction } from "./stats.js";
import {
  parseArmSpec,
  snapshotDirArm,
  snapshotGitArm,
  isInsideGitWorkTree,
  answerKeyFindings,
  ANSWER_KEY_ADVICE,
  type ArmSpec,
  type SnapshotInfo,
} from "./snapshot.js";
import { resolveAgentPins, resolveJudgePins } from "./pins.js";
import { buildSchedule, type ScheduledJob } from "./schedule.js";
import { appendRunsLine, buildRunsLine, RUNS_FILE } from "./runs.js";
import { evidenceFacts } from "./invocation.js";
import { evalJobRunDir, salvagedResult, type EvalJobSpec } from "./job-runner.js";
import { MANIFEST_FILE, type EvalManifest, type ManifestArm, type ManifestScenario } from "./manifest.js";
import { writeEvalReport, REPORT_MD, type EvalReport } from "./report.js";
import { EVAL_BOOLEAN_FLAGS, EVAL_REPEATED_FLAGS, EVAL_VALUE_FLAGS } from "./usage.js";
import { loadCostHistory, loadRowHistory, type RowHistoryLoad } from "./plan-history.js";
import { scheduleCostLine } from "./planner.js";
import { planEval, type EvalPlan, type PlanScenarioInput } from "./plan.js";

/** BH's false-discovery rate for `confirmed`. Fixed; `--alpha` sets the per-row level and Holm's. */
export const BH_Q = 0.1;
export const DEFAULT_REPS = 5;
export const MIN_REPS = 4;
export const DEFAULT_CONCURRENCY = 2;
export const MAX_CONCURRENCY = 8;

/** A refusal of the eval's own snapshot staging, before any run: exit 3. */
export class EvalStagingError extends BoundaryError {
  constructor(message: string) {
    super(message);
    this.name = "EvalStagingError";
  }
}

export interface EvalArgs {
  target: string;
  arms: string[];
  reps: number;
  allowUnderpowered: boolean;
  model?: string;
  judgeModel?: string;
  concurrency: number;
  alpha: number;
  correction: Correction;
  holdout: string[];
  includeUntracked: boolean;
  allowIdenticalArms: boolean;
  /** Undefined: no gating — exit 0 whatever the eval found. */
  failOn?: "possible" | "confirmed";
  out?: string;
  output: "text" | "json";
  quiet: boolean;
  skill?: string;
  onUnanswered?: "fail" | "first";
  deciderCmd?: string;
  deciderDir?: string;
  /** `--dry-run`: plan only — print the cost and power plan, run nothing, create no eval dir. */
  dryRun: boolean;
  /** `--target-effect`, in percentage points (30 = a 30-point change). Only with `--dry-run`. */
  targetEffectPp?: number;
  /** `--max-budget-usd`: a pre-flight refusal from cost history, before any run (never a mid-run stop). */
  maxBudgetUsd?: number;
  /** `--dotenv` / `--run-dir` after the subcommand, for the caller to apply. */
  globals: Array<{ flag: "--dotenv" | "--run-dir"; value: string }>;
}

const VALUE = new Set<string>(EVAL_VALUE_FLAGS);
const REPEATED = new Set<string>(EVAL_REPEATED_FLAGS);
const BOOLEAN = new Set<string>(EVAL_BOOLEAN_FLAGS);

const num = (flag: string, v: string, ok: (n: number) => boolean, what: string): number => {
  const n = Number(v);
  if (v.trim() === "" || !Number.isFinite(n) || !ok(n)) throw new UsageError(`${flag} requires ${what} (got "${v}")`);
  return n;
};

/** `--target-effect`: `<number>pp` or a bare `<number>`, both in percentage points, in [1, 100]. A value
 *  below 1 is refused rather than read as a fraction, so `0.3` can never silently mean 0.3pp. */
function parseTargetEffect(v: string): number {
  const m = /^(\d+(?:\.\d+)?)(pp)?$/.exec(v.trim());
  const n = m ? Number(m[1]) : NaN;
  if (m && n > 0 && n < 1)
    throw new UsageError(
      `--target-effect ${v}: did you mean ${Math.round(n * 1000) / 10}pp? --target-effect is in percentage points (30pp = a 30-point change in a row's pass rate)`,
    );
  if (!m || !Number.isFinite(n) || n < 1 || n > 100)
    throw new UsageError(`--target-effect requires percentage points in [1, 100], as 30pp or 30 (got "${v}")`);
  return n;
}

/** Parse `eval` arguments. Throws UsageError; never exits. */
export function parseEvalArgs(argv: readonly string[]): EvalArgs {
  const positionals: string[] = [];
  const values: Record<string, string> = {};
  const repeated: Record<string, string[]> = { "--arm": [], "--holdout": [] };
  const booleans = new Set<string>();
  const globals: EvalArgs["globals"] = [];
  let explicitConcurrency = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("-") || a === "-") {
      positionals.push(a);
      continue;
    }
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const name = eq > 0 ? a.slice(0, eq) : a === "-q" ? "--quiet" : a;
    if (name === "--label")
      throw new UsageError("eval does not take --label: every run is labelled eval:<eval-id>:<arm> so the index keeps the arms apart");
    if (name === "--session-id") throw new UsageError("eval does not take --session-id: each job gets its own pre-assigned run id");
    if (BOOLEAN.has(name)) {
      if (eq > 0) throw new UsageError(`${name} takes no value`);
      booleans.add(name);
      continue;
    }
    if (!VALUE.has(name) && !REPEATED.has(name)) throw new UsageError(`unknown flag: ${a}`);
    let v: string | undefined;
    if (eq > 0) v = a.slice(eq + 1);
    else {
      v = argv[i + 1];
      if (v === undefined) throw new UsageError(`${name} requires a value (none provided)`);
      if (v.startsWith("-") && !/^-\d/.test(v)) throw new UsageError(`${name}: missing value (got flag-looking "${v}")`);
      i++;
    }
    if (v.trim() === "") throw new UsageError(`${name} requires a non-empty value`);
    if (name === "--dotenv" || name === "--run-dir") {
      if (globals.some((g) => g.flag === name)) throw new UsageError(`${name} given more than once`);
      globals.push({ flag: name, value: v });
    } else if (REPEATED.has(name)) repeated[name].push(v);
    else {
      if (name in values) throw new UsageError(`${name} given more than once`);
      values[name] = v;
      if (name === "--concurrency") explicitConcurrency = true;
    }
  }
  if (positionals.length !== 1)
    throw new UsageError(
      positionals.length === 0
        ? "eval needs one <scenario.yaml | dir/>"
        : `eval takes one <scenario.yaml | dir/> (got ${positionals.join(" ")})`,
    );
  const target = positionals[0];
  if (/\.cassette\.json$/i.test(target))
    throw new UsageError("eval runs live only — it does not take a cassette (replay cannot compare two arms)");
  if (repeated["--arm"].length !== 2) throw new UsageError(`eval needs exactly two --arm values (got ${repeated["--arm"].length})`);
  const reps =
    values["--reps"] !== undefined
      ? num("--reps", values["--reps"], (n) => Number.isInteger(n) && n >= 2 && n <= 100, "an integer 2..100")
      : DEFAULT_REPS;
  const allowUnderpowered = booleans.has("--allow-underpowered");
  if (reps < MIN_REPS && !allowUnderpowered)
    throw new UsageError(
      `--reps ${reps} is below ${MIN_REPS}: no exact test at that size can reach p <= 0.05 for a full collapse. Pass --allow-underpowered to run it anyway (rows are then labelled 'underpowered', not 'no detectable change').`,
    );
  const concurrency =
    values["--concurrency"] !== undefined
      ? num(
          "--concurrency",
          values["--concurrency"],
          (n) => Number.isInteger(n) && n >= 1 && n <= MAX_CONCURRENCY,
          `an integer 1..${MAX_CONCURRENCY}`,
        )
      : DEFAULT_CONCURRENCY;
  const alpha = values["--alpha"] !== undefined ? num("--alpha", values["--alpha"], (n) => n > 0 && n < 0.5, "a number in (0, 0.5)") : 0.05;
  const correction = values["--correction"] ?? "bh";
  if (correction !== "bh" && correction !== "holm") throw new UsageError(`--correction must be bh or holm (got "${correction}")`);
  const failOn = values["--fail-on"];
  if (failOn !== undefined && failOn !== "possible" && failOn !== "confirmed")
    throw new UsageError(`--fail-on must be possible or confirmed (got "${failOn}")`);
  let output: "text" | "json";
  try {
    // The shared resolver: an explicit flag, else COWORK_HARNESS_OUTPUT_FORMAT.
    output = "--output-format" in values ? parseOutputFormat([...argv]) : envOutputFormat();
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const onUnanswered = values["--on-unanswered"];
  if (onUnanswered !== undefined && onUnanswered !== "fail" && onUnanswered !== "first")
    throw new UsageError(`eval --on-unanswered must be fail or first (got "${onUnanswered}"; prompt would break the comparison)`);
  const dryRun = booleans.has("--dry-run");
  const targetEffectPp = values["--target-effect"] !== undefined ? parseTargetEffect(values["--target-effect"]) : undefined;
  if (targetEffectPp !== undefined && !dryRun)
    throw new UsageError("--target-effect requires --dry-run: it sizes a planned eval, and a real eval has nothing to do with it");
  const maxBudgetUsd =
    values["--max-budget-usd"] !== undefined
      ? num("--max-budget-usd", values["--max-budget-usd"], (n) => n > 0, "a positive number of USD")
      : undefined;
  const deciderCmd = values["--decider-cmd"];
  const deciderDir = values["--decider-dir"];
  if (deciderCmd !== undefined && deciderDir !== undefined)
    throw new UsageError("--decider-dir conflicts with --decider-cmd (one terminal channel).");
  if (onUnanswered !== undefined && (deciderCmd !== undefined || deciderDir !== undefined))
    throw new UsageError(`--on-unanswered ${onUnanswered} conflicts with --decider-dir/--decider-cmd (the channel is the terminal).`);
  if ((deciderCmd !== undefined || deciderDir !== undefined) && concurrency > 1)
    throw new UsageError(
      `--concurrency ${concurrency}${explicitConcurrency ? "" : " (the default)"} cannot be combined with --decider-dir/--decider-cmd: the channel is shared across jobs and is not safe for concurrent gate answers. Pass --concurrency 1.`,
    );
  return {
    target,
    arms: repeated["--arm"],
    reps,
    allowUnderpowered,
    ...(values["--model"] !== undefined ? { model: values["--model"] } : {}),
    ...(values["--judge-model"] !== undefined ? { judgeModel: values["--judge-model"] } : {}),
    concurrency,
    alpha,
    correction,
    holdout: repeated["--holdout"],
    includeUntracked: booleans.has("--include-untracked"),
    allowIdenticalArms: booleans.has("--allow-identical-arms"),
    ...(failOn !== undefined ? { failOn } : {}),
    ...(values["--out"] !== undefined ? { out: values["--out"] } : {}),
    output,
    quiet: booleans.has("--quiet"),
    ...(values["--skill"] !== undefined ? { skill: values["--skill"] } : {}),
    ...(onUnanswered !== undefined ? { onUnanswered } : {}),
    ...(deciderCmd !== undefined ? { deciderCmd } : {}),
    ...(deciderDir !== undefined ? { deciderDir } : {}),
    dryRun,
    ...(targetEffectPp !== undefined ? { targetEffectPp } : {}),
    ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
    globals,
  };
}

export type { EvalJobSpec } from "./job-runner.js";

export interface EvalDeps {
  runJob: (spec: EvalJobSpec) => Promise<RunResult>;
  /** Doctor's token check for a tier (`tokenCheck` in src/run/doctor.ts — the CLI passes it with the real
   *  probe). Required, so no caller can skip the preflight by omission. */
  tokenCheck: (tier: FidelityTier) => DoctorCheck;
  /** The host-`claude` isolation preflight (`isolationRefusal` in src/decide/llm-transport.ts — the CLI passes it):
   *  the refusal message, or undefined. Required, like `tokenCheck`, so no caller skips it by omission. */
  isolationCheck: () => string | undefined;
  log: (s: string) => void;
  /** Test seams. */
  evalId?: string;
  now?: () => Date;
  cwd?: string;
  /** The run index the plan and the budget gate read (default: the runs root's `index.jsonl`, read once). */
  readIndex?: () => RunIndexRow[];
  /** Where that index lives, and whether `--run-dir` / COWORK_HARNESS_RUNS_DIR moved it (default: `runsDirInfo()`). */
  runsDirInfo?: () => { runsDir: string; runsDirRedirected: boolean };
  /** Called with a dry run's temp snapshot root, before anything is written into it. */
  onSnapshotRoot?: (dir: string) => void;
  /** Called with the plan as soon as it is computed — before any later check can refuse. */
  onPlan?: (plan: EvalPlan) => void;
}

export interface EvalOutcome {
  evalDir: string;
  report: EvalReport;
  manifest: EvalManifest;
}

const sha256File = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const realOr = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

function newEvalId(now: Date): string {
  const iso = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `${iso.slice(0, 8)}-${iso.slice(9, 15)}-${randomBytes(3).toString("hex")}`;
}

interface LoadedScenario {
  file: string;
  scenario: Scenario;
  sessionFile: string;
  session: SessionConfig;
  heldOut: boolean;
}

function loadScenarios(args: EvalArgs, say: (s: string) => void): LoadedScenario[] {
  const inputs = resolveInputs(args.target, [".yaml", ".yml"]);
  if ("error" in inputs) throw new UsageError(`eval: ${inputs.error}`);
  // A scenario directory usually holds its session file too (`_session.yaml`). In a directory, a YAML
  // document with no `prompt:` is not a scenario (the loader's own rule) and is skipped, with a notice; a
  // single file named on the command line is always loaded, so a wrong file still fails loud.
  const skipped: string[] = [];
  const files = inputs.isDir
    ? inputs.files.filter((f) => {
        let doc: unknown;
        try {
          doc = parseYaml(readFileSync(f, "utf8"));
        } catch {
          return true; // unparseable: let the scenario loader report it
        }
        const isScenario = typeof doc === "object" && doc !== null && !Array.isArray(doc) && "prompt" in doc;
        if (!isScenario) skipped.push(basename(f));
        return isScenario;
      })
    : inputs.files;
  if (skipped.length) say(`[eval] skipped ${skipped.length} non-scenario file(s): ${skipped.join(", ")}`);
  if (files.length === 0) throw new UsageError(`eval: no scenario files under ${args.target}`);
  const resolved = { files };
  const holdReal = new Set<string>();
  const fileReal = resolved.files.map(realOr);
  for (const h of args.holdout) {
    if (!existsSync(h)) throw new UsageError(`--holdout ${h}: file not found`);
    const r = realOr(h);
    if (!fileReal.includes(r)) throw new UsageError(`--holdout ${h} is not one of this eval's scenarios`);
    holdReal.add(r);
  }
  const out: LoadedScenario[] = [];
  for (let i = 0; i < resolved.files.length; i++) {
    const file = resolved.files[i];
    let scenario: Scenario;
    try {
      scenario = parseScenarioFile(file);
    } catch (e) {
      throw new UsageError(`${file}: ${(e as Error).message}`);
    }
    if (scenario.on_unanswered === "prompt")
      throw new UsageError(`scenario "${scenario.name}" sets on_unanswered: prompt — refused on eval (breaks determinism)`);
    if (scenario.session === "(inline)")
      throw new UsageError(`scenario "${scenario.name}" has no session file; eval substitutes the session's plugins.local_plugins entry`);
    let session: SessionConfig;
    try {
      session = loadSessionFromFile(scenario.session);
    } catch (e) {
      throw new UsageError(`scenario "${scenario.name}": ${(e as Error).message}`);
    }
    if (session.plugins.local_plugins.length !== 1)
      throw new UsageError(
        `scenario "${scenario.name}": eval substitutes plugins.local_plugins only, and the session must declare exactly one entry (found ${session.plugins.local_plugins.length})`,
      );
    out.push({ file, scenario, sessionFile: resolve(expandHome(scenario.session)), session, heldOut: holdReal.has(fileReal[i]) });
  }
  const names = out.map((s) => s.scenario.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup !== undefined) throw new UsageError(`two scenarios are named "${dup}"; eval keys rows by scenario name`);
  const plugins = new Set(out.map((s) => realOr(expandHome(s.session.plugins.local_plugins[0]))));
  if (plugins.size > 1)
    throw new UsageError(
      `every scenario of an eval must declare the SAME plugins.local_plugins entry (found ${[...plugins].map(tildeify).join(", ")})`,
    );
  return out;
}

/** A `--max-budget-usd` refusal before any run. Thrown, never exited on: a dry run removes its temp snapshots in
 *  a `finally`, and a real eval removes the eval dir it made, so the caller maps this to the error envelope
 *  (`error.code: "budget_exceeded"`, `error.budget`). The marker is recorded before it is thrown. */
export class EvalBudgetRefusal extends Error {
  constructor(
    message: string,
    readonly hint: string,
    readonly status: BudgetStatus,
    readonly plan?: EvalPlan,
  ) {
    super(message);
    this.name = "EvalBudgetRefusal";
  }
}

/** Everything resolved before the eval dir: scenarios, pins, arms, and where the eval would live. */
interface EvalContext {
  now: Date;
  cwd: string;
  say: (s: string) => void;
  scenarios: LoadedScenario[];
  agentPins: ReturnType<typeof resolveAgentPins>;
  judgePins: ReturnType<typeof resolveJudgePins>;
  specs: ArmSpec[];
  evalId: string;
  evalDir: string;
}

function resolveEvalContext(args: EvalArgs, deps: EvalDeps): EvalContext {
  const now = deps.now?.() ?? new Date();
  const cwd = deps.cwd ?? process.cwd();
  const say = (s: string) => {
    if (!args.quiet) deps.log(s);
  };

  // Scenarios, sessions, rows.
  const scenarios = loadScenarios(args, say);
  let rowCount = 0;
  for (const s of scenarios) {
    try {
      rowCount += scenarioRows(s.scenario.name, s.scenario.assert ?? []).length;
    } catch (e) {
      throw new UsageError((e as Error).message);
    }
  }
  if (rowCount === 0) throw new UsageError("eval: no scenario has an assert: entry — there is nothing to compare");

  // Pins.
  const agentPins = resolveAgentPins(
    scenarios.map((s) => ({ scenario: s.scenario, sessionModel: s.session.model })),
    args.model,
  );
  const judgePins = resolveJudgePins(
    scenarios.map((s) => s.scenario),
    args.judgeModel,
  );

  // Arms.
  const specs: ArmSpec[] = args.arms.map((raw, i) => parseArmSpec(raw, i));
  if (specs[0].label === specs[1].label) throw new UsageError(`the two arms share the label "${specs[0].label}"`);
  if (args.includeUntracked && specs.some((s) => s.source.kind === "git"))
    throw new UsageError("--include-untracked has no meaning for a git: arm (its content is a commit); drop one");

  // Where the eval lives: outside every git work tree, or the stager would mount the snapshots empty. A dry
  // run checks the same two things and creates nothing, so it refuses exactly where the real eval would.
  const evalId = deps.evalId ?? newEvalId(now);
  const evalDir = resolve(args.out ?? join(homedir(), ".cowork-harness", "evals", evalId));
  if (isInsideGitWorkTree(evalDir))
    throw new UsageError(
      `eval dir ${tildeify(evalDir)} is inside a git work tree: the stager delivers a mount's git-tracked files only, so the arm snapshots would mount EMPTY. Pass --out <dir> outside any repository.`,
    );
  if (existsSync(evalDir) && (!statSync(evalDir).isDirectory() || readdirSync(evalDir).length > 0))
    throw new UsageError(`eval dir ${tildeify(evalDir)} already exists and is not empty`);
  return { now, cwd, say, scenarios, agentPins, judgePins, specs, evalId, evalDir };
}

/** What the checks after the eval dir produced: the snapshots, the substituted sessions and their
 *  signatures, the skill whose invocation reps record, and — on a dry run or under `--max-budget-usd` — the
 *  plan. */
interface PreparedArms {
  snaps: Array<SnapshotInfo & { spec: ArmSpec }>;
  sessions: Map<string, SessionConfig>;
  sigs: Array<Record<string, string>>;
  skill: string | null;
  evalFiles: string[];
  plan?: EvalPlan;
}

/** Everything that can refuse before the first run, with the arm snapshots under `armsRoot`. Never exits and
 *  never creates the eval dir: the caller owns where the snapshots live and what is removed on a refusal. */
function prepareArms(args: EvalArgs, deps: EvalDeps, ctx: EvalContext, armsRoot: string, mode: "run" | "plan"): PreparedArms {
  const { scenarios, specs, agentPins, judgePins, cwd, say } = ctx;
  // Snapshots.
  // Every scenario declares the same plugin dir (checked by realpath); each is substituted by its OWN
  // spelling. The snapshot takes the declared final directory name, which is the mount name the
  // scenarios' assertions see — so every spelling must end in the same name.
  const bases = [...new Set(scenarios.map((s) => basename(expandHome(s.session.plugins.local_plugins[0]))))];
  if (bases.length > 1)
    throw new UsageError(
      `the scenarios declare the plugin under different final directory names (${bases.join(", ")}); the mount name comes from that name, so declare it the same way in every session`,
    );
  const base = bases[0];
  const snaps: Array<SnapshotInfo & { spec: ArmSpec }> = specs.map((spec) => {
    const dest = join(armsRoot, "arms", spec.label, base);
    try {
      if (spec.source.kind === "dir") {
        const info = snapshotDirArm(resolve(cwd, spec.source.path), dest, args.includeUntracked, spec.raw);
        return { ...info, spec };
      }
      const info = snapshotGitArm(spec.source, dest, cwd, spec.raw);
      return { ...info, spec };
    } catch (e) {
      // A refusal about the source is usage; anything else (an unreadable file, a full disk, a git that
      // failed mid-extraction, a tracked set that cannot be listed) is the eval's own staging failing.
      if (e instanceof UsageError) throw e;
      throw new EvalStagingError(`arm ${spec.label}: snapshot failed: ${(e as Error).message}`);
    }
  });
  for (const s of snaps)
    say(
      `[eval] arm ${s.spec.label}: ${s.source} → ${s.fileCount} file(s)${s.untrackedExcluded ? `, ${s.untrackedExcluded} untracked excluded` : ""}`,
    );

  // Which skill's invocation the reps record: one derivation per arm, and the arms must agree.
  // Not a refusal: a plugin with several skills (and no --skill), or a skill the arms name differently,
  // only makes the per-rep invocation fact unobservable. It never affects a row.
  const skillNames = snaps.map((s) => {
    try {
      return gradedSkillNameFor(args.skill, resolveCritiquedSkillDir(s.dir, args.skill));
    } catch {
      return undefined;
    }
  });
  const skill = skillNames[0] !== undefined && skillNames[0] === skillNames[1] ? skillNames[0] : null;
  if (skill === null)
    say(
      `[eval] no single skill to record invocation for (${args.skill ? `--skill ${args.skill} is not in both arms` : "pass --skill <name> to pick one"}): the per-rep invocation fact is unobservable`,
    );

  // Answer-key guard — before the signatures, whose walk would otherwise warn about the very links it refuses.
  const evalFiles = [...new Set(scenarios.flatMap((s) => [resolve(s.file), s.sessionFile]))];
  const findings = answerKeyFindings(
    evalFiles,
    snaps.map((s) => ({ label: s.spec.label, snapshotDir: s.dir, ...(s.sourceDir ? { sourceDir: s.sourceDir } : {}) })),
  );
  if (findings.length)
    throw new UsageError(
      `answer-key guard: an arm could let the agent read this eval's own scenarios or evals — ` +
        findings.map((f) => `arm ${f.arm}: ${tildeify(f.file)} (${f.reason.replace(/_/g, " ")})`).join("; ") +
        `. To fix: ${[...new Set(findings.map((f) => ANSWER_KEY_ADVICE[f.reason]))].join("; ")}.`,
    );

  // Per arm x scenario: the substituted session, its signature from the SAME fingerprint call a rep makes,
  // and the staging preflight over the substituted session.
  const sessions = new Map<string, SessionConfig>();
  const sigs: Array<Record<string, string>> = [{}, {}];
  for (const [ai, snap] of snaps.entries()) {
    for (const [si, s] of scenarios.entries()) {
      const baseline = loadBaseline(s.scenario.baseline);
      let sub: SessionConfig;
      try {
        sub = applySessionOverrides(s.session, {
          model: agentPins[si].model,
          skillDirSubstitution: [s.session.plugins.local_plugins[0], snap.dir],
        });
      } catch (e) {
        throw new UsageError(`arm ${snap.spec.label}, scenario "${s.scenario.name}": ${(e as Error).message}`);
      }
      sessions.set(`${snap.spec.label}\0${s.scenario.name}`, sub);
      const sig = buildFingerprint(s.scenario.session, baseline.appVersion, undefined, s.scenario.skills, baseline, sub).contentSig;
      if (sig === undefined)
        throw new UsageError(
          `arm ${snap.spec.label}, scenario "${s.scenario.name}": the snapshot hashes to nothing (no files the fingerprint covers)`,
        );
      sigs[ai][s.scenario.name] = sig;
      try {
        // The same input checks a run makes before its run dir exists — the tier-vacuous refusal and every
        // input path — over the SUBSTITUTED session, so a bad input refuses the eval instead of failing
        // every job.
        const f = scenarioInputFindings(s.scenario, undefined, { quiet: true, session: sub, unloadableBaseline: "report" });
        const refusal = f.session ?? f.vacuity ?? f.inputs;
        if (refusal) throw refusal;
        // semantic_pairwise references: the same gate executeScenario applies before a run dir exists, run here
        // once per arm × scenario so a missing or damaged reference refuses the eval (exit 2) instead of failing
        // every job. Mount roots come from the SUBSTITUTED session the jobs will run.
        const pw = pairwiseRefsRefusal(s.scenario, scenarioPairwiseSetup(s.scenario), sessionOriginSources(sub, "(inline)"));
        if (pw) throw new UsageError(pw);
      } catch (e) {
        if (e instanceof BoundaryError)
          throw new EvalStagingError(`arm ${snap.spec.label}, scenario "${s.scenario.name}": ${(e as Error).message}`);
        if (e instanceof UsageError) throw new UsageError(`arm ${snap.spec.label}, scenario "${s.scenario.name}": ${e.message}`);
        throw e;
      }
    }
  }
  const identical = scenarios.every((s) => sigs[0][s.scenario.name] === sigs[1][s.scenario.name]);
  if (identical && !args.allowIdenticalArms)
    throw new UsageError(
      `the two arms are identical (same content signature) — nothing to compare. Pass --allow-identical-arms for an A/A noise run.`,
    );

  // The plan: computed here — it needs arm A's signatures and the pins — and BEFORE every later refusal, so
  // a refusal below still carries the numbers. One index read feeds both the plan and the budget gate, so
  // the plan's gate figure and the gate's own estimate come from the same rows.
  const wantPlan = mode === "plan" || args.maxBudgetUsd !== undefined;
  const indexRows = wantPlan ? (deps.readIndex?.() ?? readIndex(runsRoot())) : [];
  const runsDir = deps.runsDirInfo?.() ?? runsDirInfo();
  // A real eval needs only the cost (for its budget gate): it never reads the kept result.json files.
  const plan = wantPlan ? buildPlan(args, ctx, sigs[0], indexRows, runsDir, mode === "run") : undefined;
  if (plan) {
    deps.onPlan?.(plan);
    if (mode === "run") {
      say(`[eval] cost at --reps ${args.reps}: ${scheduleCostLine(plan.cost)}${plan.cost.lowerBound ? noHistoryCauseText(runsDir) : ""}`);
      say(
        `[eval] judge: p50 $${plan.cost.judgeP50Usd.toFixed(4)} for this schedule — NOT covered by --max-budget-usd, which counts the agent's cost only`,
      );
    }
  }

  // `--fail-on confirmed` must be able to fire.
  const floor = attainableFloor(args.reps, args.reps);
  const opts = { correction: args.correction, q: BH_Q, alpha: args.alpha };
  const familySize = (held: boolean) =>
    scenarios
      .filter((s) => s.heldOut === held)
      .reduce((n, s) => n + scenarioRows(s.scenario.name, s.scenario.assert ?? []).filter((r) => r.kind !== "semantic_rollup").length, 0);
  const sectionReach = [false, true]
    .map((held) => ({ held, m: familySize(held) }))
    .filter((x) => x.m > 0)
    .map((x) => ({ ...x, j: minRowsToConfirm(floor, x.m, opts) }));
  // A dry run's plan prints the same line beside its sequential preview; the real eval prints it here.
  if (mode === "run")
    for (const x of sectionReach)
      say(
        `[eval] ${x.held ? "held-out" : "tuned"} section: ${x.m} row(s) in the family; at --reps ${args.reps} ` +
          (x.j === null
            ? "`confirmed` is unreachable"
            : x.j === 1
              ? "one collapsed row can reach `confirmed`"
              : `\`confirmed\` needs >= ${x.j} collapsed rows — a single regression cannot reach it (it can still be 'possible')`),
      );
  if (args.failOn === "confirmed" && sectionReach.every((x) => x.j === null))
    throw new UsageError(
      `--fail-on confirmed can never fire at --reps ${args.reps} with ${sectionReach.map((x) => x.m).join("/")} row(s) under ${args.correction}: raise --reps, or use --fail-on possible`,
    );

  // Credentials: doctor's own token check for every tier the scenarios run at, before the manifest (so a
  // refusal leaves no eval dir) and before any spend. Without it an eval with no usable credential runs
  // every rep to "Not logged in" — each one a zero-cost error the agent reports like any other.
  const byTier = new Map<FidelityTier, string[]>();
  for (const s of scenarios) byTier.set(s.scenario.fidelity, [...(byTier.get(s.scenario.fidelity) ?? []), s.scenario.name]);
  for (const [tier, names] of byTier) {
    const c = deps.tokenCheck(tier);
    if (c.status === "fail")
      throw new UsageError(
        `no usable agent credential for fidelity ${tier} (scenario${names.length > 1 ? "s" : ""} ${names.join(", ")}): ${c.detail}` +
          (c.remedy ? `. Fix: ${c.remedy}` : "") +
          ` (the same check as \`cowork-harness doctor --tier ${tier}\`)`,
        c.remedy,
      );
  }

  // `--max-budget-usd`: the batch gate `record` uses, over this schedule (2 x reps runs of every scenario).
  if (args.maxBudgetUsd !== undefined) budgetGate(args, deps, indexRows, runsDir, plan!);

  return { snaps, sessions, sigs, skill, evalFiles, ...(plan ? { plan } : {}) };
}

/** The eval's `--max-budget-usd` pre-flight. Same decision as `record`'s batch gate (`checkBatchBudget`: the
 *  sum of each scenario's worst observed run times its jobs, strict `>`), same marker and `error.code`, but
 *  it throws instead of exiting, and its wording names the eval's own basis. */
function budgetGate(
  args: EvalArgs,
  deps: EvalDeps,
  indexRows: readonly RunIndexRow[],
  runsDir: { runsDir: string; runsDirRedirected: boolean },
  plan: EvalPlan,
): void {
  const cap = args.maxBudgetUsd!;
  // The schedule's jobs come from the plan, the one place they are computed, so the gate's estimate and
  // `plan.cost` can never count a different schedule.
  const items = plan.cost.items.map((i) => ({ scenario: i.scenario, jobs: i.jobs }));
  const c = checkBatchBudget(items, cap, { rows: indexRows, runsDir });
  // Recorded BEFORE any refusal, so the `budget` key is on the refusal's envelope too.
  recordBudgetStatus(c.status);
  if (c.noHistoryWarning !== undefined) deps.log(c.noHistoryWarning + noHistoryCauseText(runsDir));
  const basis =
    `${plan.cost.jobs} run(s) (2 arms × ${args.reps} reps × ${items.length} scenario(s)), each scenario at its worst observed run on ` +
    `a wider basis than the plan's worstObservedUsd (any tier, baseline or turn, hillclimb runs included), so it can be larger — `;
  const usd = (x: number) => `$${x.toFixed(4)}`;
  if (c.refuse)
    throw new EvalBudgetRefusal(
      `--max-budget-usd ${usd(cap)} refused before any run: this eval schedules ${basis}up to ${usd(c.estimate.known)} ` +
        `(plan.cost.budgetGateWorstUsd in the JSON envelope)${c.status.enforced === "lower_bound" ? `, and that is a LOWER BOUND: ${c.status.unpriced.length} scenario(s) have no priced run` : ""}.`,
      `Raise the cap, lower --reps, or drop --max-budget-usd to run anyway. This is a PRE-flight estimate from history: the eval is never stopped mid-way, and judge spend is not counted.`,
      c.status,
      plan,
    );
  deps.log(
    `::notice:: --max-budget-usd ${usd(cap)}: the gate's estimate is ${basis}${usd(c.estimate.known)}` +
      (c.status.enforced === "lower_bound" ? ` — a LOWER BOUND (${c.status.unpriced.length} scenario(s) contribute $0)` : ""),
  );
}

/** The rate history of a cost-only plan: nothing read, every row unknown. */
function noRates(): RowHistoryLoad {
  const zero = { notRun: 0, command: 0, tier: 0, baseline: 0, turn: 0, hillclimb: 0, ablated: 0, model: 0, pruned: 0, unreadable: 0 };
  return {
    rows: [],
    basis: "relaxed",
    reps: 0,
    validReps: 0,
    exactContentReps: 0,
    evalReps: 0,
    excludedByKey: zero,
    modelsExcluded: {},
    judgeModelDiffers: 0,
    verdictRate: { pass: 0, runs: 0, basis: "index" },
    reads: 0,
    readCapHit: false,
  };
}

/** The plan over the history the loaders select, for every scenario at its effective tier and baseline. */
function buildPlan(
  args: EvalArgs,
  ctx: EvalContext,
  armASigs: Record<string, string>,
  indexRows: readonly RunIndexRow[],
  runsDir: { runsDir: string; runsDirRedirected: boolean },
  costOnly: boolean,
): EvalPlan {
  const scenarios: PlanScenarioInput[] = ctx.scenarios.map((s, si) => {
    const name = s.scenario.name;
    const baseline = loadBaseline(s.scenario.baseline);
    // The tier history recorded: `cowork` resolves to a concrete tier, which is what `effectiveFidelity` holds.
    const filters = { scenario: name, baseline: baseline.appVersion, tier: effectiveTier(s.scenario.fidelity, baseline) };
    const assertions = s.scenario.assert ?? [];
    const judgeModelPins = new Map(ctx.judgePins.resolved.filter((p) => p.scenario === name).map((p) => [p.assertionIndex, p.model]));
    return {
      name,
      heldOut: s.heldOut,
      tier: filters.tier,
      baseline: filters.baseline,
      agentPin: ctx.agentPins[si].model,
      rows: scenarioRows(name, assertions),
      cost: loadCostHistory(indexRows, filters),
      rates: costOnly
        ? noRates()
        : loadRowHistory(indexRows, {
            ...filters,
            assertions,
            agentPin: ctx.agentPins[si].model,
            armASig: armASigs[name],
            judgePromptHash: ctx.judgePins.promptHash,
            judgeModelPins,
          }),
    };
  });
  return planEval({
    reps: args.reps,
    alpha: args.alpha,
    correction: args.correction,
    q: BH_Q,
    ...(args.targetEffectPp !== undefined ? { targetEffectPp: args.targetEffectPp } : {}),
    allowUnderpowered: args.allowUnderpowered,
    costOnly,
    history: { ...runsDir, indexRows: indexRows.length },
    scenarios,
  });
}

/** `eval --dry-run`: every check the real eval makes before its first run, then the plan — with no agent run,
 *  no eval dir, and the arm snapshots in a temp dir that is removed whatever happens. */
export async function planEvalDryRun(args: EvalArgs, deps: EvalDeps): Promise<{ plan: EvalPlan }> {
  const ctx = resolveEvalContext(args, deps);
  // A signal must not leave the snapshot behind. Without a handler the default action kills the process at
  // once; with it installed, a Ctrl-C is handled only after this preparation — synchronous throughout —
  // returns, by which time the `finally` below has removed the snapshot. (No cleanup step is registered:
  // there is no window in which the handler could run before the `finally`.)
  installTerminationHandler();
  const snapRoot = mkdtempSync(join(tmpdir(), "cwh-eval-plan-"));
  deps.onSnapshotRoot?.(snapRoot);
  try {
    // The snapshots must sit outside any work tree for the same reason the eval dir must (the signatures
    // hash what a run would stage).
    // The real eval snapshots into its eval dir, which `--out` places; the dry run's temp dir is placed by TMPDIR,
    // so that is the remedy both refusals name.
    let inside: boolean;
    try {
      inside = isInsideGitWorkTree(snapRoot);
    } catch (e) {
      throw new EvalStagingError(
        `could not tell whether the temp dir ${tildeify(snapRoot)} is inside a git work tree (${(e as Error).message.replace(/^could not tell whether .*? is inside a git work tree \((.*?)\);.*$/s, "$1")}): set TMPDIR to a directory git can answer for, outside any work tree`,
      );
    }
    if (inside)
      throw new EvalStagingError(
        `the temp dir ${tildeify(snapRoot)} is inside a git work tree, where the arm snapshots would hash as empty: set TMPDIR to a directory outside any git work tree`,
      );
    const prep = prepareArms(args, deps, ctx, snapRoot, "plan");
    return { plan: prep.plan! };
  } finally {
    rmSync(snapRoot, { recursive: true, force: true });
  }
}

/** Everything before the first run, then the schedule, then the report. */
export async function runEval(args: EvalArgs, deps: EvalDeps): Promise<EvalOutcome> {
  if (args.dryRun) throw new Error("runEval does not take a dry run: call planEvalDryRun");
  const ctx = resolveEvalContext(args, deps);
  const { now, scenarios, agentPins, judgePins, evalId, evalDir, say } = ctx;
  // Created now, or an existing EMPTY dir: either way, a refusal before the manifest removes what we made.
  const createdDir = !existsSync(evalDir);
  mkdirSync(evalDir, { recursive: true });
  try {
    return await afterEvalDir();
  } catch (e) {
    // A refusal after the dir was made (a bad snapshot, the guard, a preflight) leaves nothing behind, so the
    // same --out can be used again. Once the manifest exists the eval has started and the dir is kept.
    if (!existsSync(join(evalDir, MANIFEST_FILE))) {
      if (createdDir) rmSync(evalDir, { recursive: true, force: true });
      else for (const e of readdirSync(evalDir)) rmSync(join(evalDir, e), { recursive: true, force: true });
    }
    throw e;
  }

  async function afterEvalDir(): Promise<EvalOutcome> {
    const { snaps, sessions, sigs, skill, evalFiles } = prepareArms(args, deps, ctx, evalDir, "run");

    // The judge and the LLM decider run the host `claude` isolated and tool-less, which needs a CLI that accepts the
    // isolation flags: an older one refuses the eval here, once, instead of failing every rep after its agent spend.
    // A decider channel replaces the LLM decider as the terminal, so `on_unanswered: llm` then never calls it.
    const llmDecider = args.deciderCmd === undefined && args.deciderDir === undefined;
    if (
      scenarios.some(
        (s) =>
          (llmDecider && s.scenario.on_unanswered === "llm") ||
          s.scenario.assert.some((a) => a.semantic_matches !== undefined || a.semantic_pairwise !== undefined),
      )
    ) {
      const iso = deps.isolationCheck();
      if (iso) throw new UsageError(iso);
    }

    // Manifest.
    const manifestScenarios: ManifestScenario[] = scenarios.map((s) => ({
      name: s.scenario.name,
      file: tildeify(resolve(s.file)),
      sha256: sha256File(s.file),
      session: tildeify(s.sessionFile),
      sessionSha256: sha256File(s.sessionFile),
      baseline: loadBaseline(s.scenario.baseline).appVersion,
      heldOut: s.heldOut,
      assertions: s.scenario.assert ?? [],
    }));
    const arms = snaps.map((s, i): ManifestArm => ({
      label: s.spec.label,
      role: i === 0 ? "A" : "B",
      source: s.source,
      fileSet: s.fileSet,
      fileCount: s.fileCount,
      untrackedExcluded: s.untrackedExcluded,
      ...(s.commit !== undefined ? { commit: s.commit } : {}),
      ...(s.dirty !== undefined ? { dirty: s.dirty } : {}),
      snapshot: relative(evalDir, s.dir),
      sigs: sigs[i],
    })) as [ManifestArm, ManifestArm];
    const manifest: EvalManifest = {
      schemaVersion: 0,
      evalId,
      startedAt: now.toISOString(),
      harnessVersion: pkgVersion(),
      arms,
      scenarios: manifestScenarios,
      settings: {
        reps: args.reps,
        allowUnderpowered: args.allowUnderpowered,
        alpha: args.alpha,
        q: BH_Q,
        correction: args.correction,
        failOn: args.failOn ?? null,
        concurrency: args.concurrency,
        includeUntracked: args.includeUntracked,
        allowIdenticalArms: args.allowIdenticalArms,
      },
      pins: { agent: agentPins, judge: judgePins },
      skill,
      answerKeyGuard: { evalFiles: evalFiles.length, findings: 0 },
    };
    writeFileSync(join(evalDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + "\n");
    writeFileSync(join(evalDir, RUNS_FILE), "");

    // Schedule.
    const jobs = buildSchedule(
      evalId,
      [arms[0].label, arms[1].label],
      scenarios.map((s) => s.scenario.name),
      args.reps,
    );
    say(
      `[eval] ${evalId}: ${jobs.length} job(s) (${args.reps} reps × ${scenarios.length} scenario(s) × 2 arms), concurrency ${args.concurrency} → ${tildeify(evalDir)}`,
    );
    const runsFile = join(evalDir, RUNS_FILE);
    const snapByLabel = new Map(snaps.map((s) => [s.spec.label, s]));
    let done = 0;
    await pMapBounded(jobs, args.concurrency, async (job) => {
      const s = scenarios[job.scenarioIndex];
      const session = sessions.get(`${job.arm}\0${job.scenario}`)!;
      const expectedDir = evalJobRunDir({ scenario: s.scenario, job });
      let result: RunResult | undefined;
      let thrown: unknown;
      try {
        result = await deps.runJob({
          job,
          scenario: s.scenario,
          session,
          runLabel: `eval:${evalId}:${job.arm}`,
          ...(args.judgeModel !== undefined ? { judgeModelOverride: args.judgeModel } : {}),
        });
      } catch (e) {
        thrown = e;
        result = salvagedResult(expectedDir);
      }
      let evidence;
      try {
        evidence = result ? evidenceFacts({ result, skillName: skill ?? undefined, pluginRoot: snapByLabel.get(job.arm)!.dir }) : undefined;
      } catch {
        evidence = { invoked: "unobservable" as const, sourceRead: "unobservable" as const, neither: "unobservable" as const };
      }
      const runDir = result?.outDir ?? (existsSync(expectedDir) ? expectedDir : undefined);
      appendRunsLine(
        runsFile,
        buildRunsLine({
          index: job.index,
          arm: job.arm,
          scenario: job.scenario,
          rep: job.rep,
          runId: job.runId,
          runDir,
          result,
          thrown,
          evidence,
        }),
      );
      done++;
      say(
        `[eval] ${done}/${jobs.length} ${job.arm} ${job.scenario} r${job.rep}: ${thrown !== undefined ? `threw ${(thrown as Error)?.name ?? "error"}: ${String((thrown as Error)?.message ?? thrown).split("\n")[0]}` : `result ${result?.result}`}`,
      );
    });

    const report = writeEvalReport(evalDir);
    say(`[eval] report: ${tildeify(join(evalDir, REPORT_MD))}`);
    return { evalDir, report, manifest };
  }
}

/** `eval report <eval-dir>`: rebuild report.json / report.md from the dir alone ($0). */
export function parseEvalReportArgs(argv: readonly string[]): { evalDir: string; output: "text" | "json"; globals: EvalArgs["globals"] } {
  const pos: string[] = [];
  let output: "text" | "json" = envOutputFormat();
  const globals: EvalArgs["globals"] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (name === "--output-format" || name === "--dotenv" || name === "--run-dir") {
      const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (v === undefined || v.trim() === "" || (eq < 0 && v.startsWith("-"))) throw new UsageError(`${name} requires a value`);
      if (name === "--output-format") {
        if (v !== "text" && v !== "json") throw new UsageError(`--output-format must be "text" or "json" (got "${v}")`);
        output = v;
      } else globals.push({ flag: name, value: v });
    } else if (a.startsWith("-")) throw new UsageError(`unknown flag: ${a}`);
    else pos.push(a);
  }
  if (pos.length !== 1) throw new UsageError("usage: eval report <eval-dir>");
  const evalDir = resolve(pos[0]);
  if (!existsSync(join(evalDir, MANIFEST_FILE))) throw new UsageError(`${tildeify(evalDir)} is not an eval dir (no ${MANIFEST_FILE})`);
  return { evalDir, output, globals };
}

/** The JSON envelope payload shared by `eval` and `eval report`. `ok` ⇔ exit 0. */
export function evalEnvelopePayload(evalDir: string, report: EvalReport): Record<string, unknown> {
  return {
    evalDir,
    arms: report.arms,
    pins: report.pins,
    sections: report.sections,
    summary: report.summary,
    cost: report.cost,
    stoppedEarly: report.stoppedEarly,
  };
}
