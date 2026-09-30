// `cowork-harness eval`: paired A/B evaluation of a skill edit.
//
// Everything that can refuse happens before the first run: arguments, scenarios and sessions, pins, the
// eval dir, the snapshots and their signatures, the answer-key guard and a per-arm staging preflight. Then
// the schedule runs through an injected `runJob` (the CLI passes the same per-scenario runner `run` uses; the
// tests pass a fake), each finished job appends one runs.jsonl line, and the report is written by the same
// function `eval report` calls.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import type { RunResult, Scenario } from "../types.js";
import type { SessionConfig } from "../session.js";
import { BoundaryError, UsageError } from "../errors.js";
import { applySessionOverrides, expandHome } from "../session.js";
import { loadBaseline } from "../baseline.js";
import { parseScenarioFile, loadSessionFromFile, launchSourcesPreflight, slugForPath } from "../run/execute.js";
import { buildFingerprint } from "../run/cassette.js";
import { resolveInputs } from "../run/inputs.js";
import { runsWriteRoot } from "../run/trace-view.js";
import { latestTurn, turnArtifactPath } from "../run/turn-layout.js";
import { pMapBounded } from "../async-pool.js";
import { envOutputFormat, parseOutputFormat, pkgVersion } from "../run/envelope.js";
import { tildeify } from "../io.js";
import { resolveCritiquedSkillDir, gradedSkillNameFor } from "../critique/command.js";
import { scenarioRows } from "./classify.js";
import { attainableFloor, minRowsToConfirm, type Correction } from "./stats.js";
import {
  parseArmSpec,
  snapshotDirArm,
  snapshotGitArm,
  isInsideGitWorkTree,
  answerKeyFindings,
  type ArmSpec,
  type SnapshotInfo,
} from "./snapshot.js";
import { resolveAgentPins, resolveJudgePins } from "./pins.js";
import { buildSchedule, type ScheduledJob } from "./schedule.js";
import { appendRunsLine, buildRunsLine, RUNS_FILE } from "./runs.js";
import { evidenceFacts } from "./invocation.js";
import { MANIFEST_FILE, type EvalManifest, type ManifestArm, type ManifestScenario } from "./manifest.js";
import { writeEvalReport, REPORT_MD, type EvalReport } from "./report.js";
import { EVAL_BOOLEAN_FLAGS, EVAL_REPEATED_FLAGS, EVAL_VALUE_FLAGS } from "./usage.js";

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
  failOn: "possible" | "confirmed";
  out?: string;
  output: "text" | "json";
  quiet: boolean;
  skill?: string;
  onUnanswered?: "fail" | "first";
  deciderCmd?: string;
  deciderDir?: string;
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
    if (name === "--session-id") throw new UsageError("eval does not take --session-id: each job gets its own pre-assigned session id");
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
  const failOn = values["--fail-on"] ?? "possible";
  if (failOn !== "possible" && failOn !== "confirmed") throw new UsageError(`--fail-on must be possible or confirmed (got "${failOn}")`);
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
    failOn,
    ...(values["--out"] !== undefined ? { out: values["--out"] } : {}),
    output,
    quiet: booleans.has("--quiet"),
    ...(values["--skill"] !== undefined ? { skill: values["--skill"] } : {}),
    ...(onUnanswered !== undefined ? { onUnanswered } : {}),
    ...(deciderCmd !== undefined ? { deciderCmd } : {}),
    ...(deciderDir !== undefined ? { deciderDir } : {}),
    globals,
  };
}

/** One job handed to the runner. */
export interface EvalJobSpec {
  job: ScheduledJob;
  scenario: Scenario;
  /** The arm's session: the snapshot in place of the declared plugin, the pinned model baked in. */
  session: SessionConfig;
  /** `eval:<eval-id>:<arm>`. */
  runLabel: string;
  judgeModelOverride?: string;
}

export interface EvalDeps {
  runJob: (spec: EvalJobSpec) => Promise<RunResult>;
  log: (s: string) => void;
  /** Test seams. */
  evalId?: string;
  now?: () => Date;
  cwd?: string;
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

function loadScenarios(args: EvalArgs): LoadedScenario[] {
  const resolved = resolveInputs(args.target, [".yaml", ".yml"]);
  if ("error" in resolved) throw new UsageError(`eval: ${resolved.error}`);
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

/** Everything before the first run, then the schedule, then the report. */
export async function runEval(args: EvalArgs, deps: EvalDeps): Promise<EvalOutcome> {
  const now = deps.now?.() ?? new Date();
  const cwd = deps.cwd ?? process.cwd();
  const say = (s: string) => {
    if (!args.quiet) deps.log(s);
  };

  // Scenarios, sessions, rows.
  const scenarios = loadScenarios(args);
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

  // Where the eval lives: outside every git work tree, or the stager would mount the snapshots empty.
  const evalId = deps.evalId ?? newEvalId(now);
  const evalDir = resolve(args.out ?? join(homedir(), ".cowork-harness", "evals", evalId));
  if (isInsideGitWorkTree(evalDir))
    throw new UsageError(
      `eval dir ${tildeify(evalDir)} is inside a git work tree: the stager delivers a mount's git-tracked files only, so the arm snapshots would mount EMPTY. Pass --out <dir> outside any repository.`,
    );
  if (existsSync(evalDir) && (!statSync(evalDir).isDirectory() || readdirSync(evalDir).length > 0))
    throw new UsageError(`eval dir ${tildeify(evalDir)} already exists and is not empty`);
  const createdDir = !existsSync(evalDir);
  mkdirSync(evalDir, { recursive: true });
  try {
    return await afterEvalDir();
  } catch (e) {
    // A refusal after the dir was made (a bad snapshot, the guard, a preflight) leaves nothing behind, so the
    // same --out can be used again. Once the manifest exists the eval has started and the dir is kept.
    if (createdDir && !existsSync(join(evalDir, MANIFEST_FILE))) rmSync(evalDir, { recursive: true, force: true });
    throw e;
  }

  async function afterEvalDir(): Promise<EvalOutcome> {
    // Snapshots.
    const pluginDecl = scenarios[0].session.plugins.local_plugins[0];
    const base = basename(expandHome(pluginDecl));
    const snaps: Array<SnapshotInfo & { spec: ArmSpec; sourceDir?: string }> = specs.map((spec) => {
      const dest = join(evalDir, "arms", spec.label, base);
      try {
        if (spec.source.kind === "dir") {
          const info = snapshotDirArm(resolve(cwd, spec.source.path), dest, args.includeUntracked, spec.raw);
          return { ...info, spec, sourceDir: resolve(cwd, spec.source.path) };
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
    const skillNames = snaps.map((s) => {
      try {
        return gradedSkillNameFor(args.skill, resolveCritiquedSkillDir(s.dir, args.skill));
      } catch (e) {
        throw new UsageError(`arm ${s.spec.label}: ${(e as Error).message}`);
      }
    });
    if (skillNames[0] !== skillNames[1])
      throw new UsageError(`the arms resolve different skills (${skillNames.map(String).join(" vs ")}); pass --skill <name>`);
    const skill = skillNames[0] ?? null;

    // Per arm x scenario: the substituted session, its signature from the SAME fingerprint call a rep makes,
    // and the staging preflight over the substituted session.
    const sessions = new Map<string, SessionConfig>();
    const sigs: Array<Record<string, string>> = [{}, {}];
    for (const [ai, snap] of snaps.entries()) {
      for (const [si, s] of scenarios.entries()) {
        const baseline = loadBaseline(s.scenario.baseline);
        let sub: SessionConfig;
        try {
          sub = applySessionOverrides(s.session, { model: agentPins[si].model, skillDirSubstitution: [pluginDecl, snap.dir] });
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
          launchSourcesPreflight(s.scenario, undefined, { quiet: true, baseline, session: sub });
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

    // Answer-key guard.
    const evalFiles = [...new Set(scenarios.flatMap((s) => [resolve(s.file), s.sessionFile]))];
    const findings = answerKeyFindings(
      evalFiles,
      snaps.map((s) => ({ label: s.spec.label, snapshotDir: s.dir, ...(s.sourceDir ? { sourceDir: s.sourceDir } : {}) })),
    );
    if (findings.length)
      throw new UsageError(
        `answer-key guard: an arm could let the agent read this eval's own scenarios or evals — ` +
          findings.map((f) => `arm ${f.arm}: ${tildeify(f.file)} (${f.reason.replace(/_/g, " ")})`).join("; ") +
          `. Move the scenarios out of the plugin (or drop evals.json from it).`,
      );

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
        failOn: args.failOn,
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
      const expectedDir = join(runsWriteRoot(), slugForPath(s.scenario.name), `sess-${job.sessionId}`);
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
          sessionId: job.sessionId,
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

/** The result.json a job left in its pre-assigned dir before throwing (an unanswered gate's salvaged partial). */
function salvagedResult(dir: string): RunResult | undefined {
  const t = latestTurn(dir);
  if (t === undefined) return undefined;
  const p = turnArtifactPath(dir, t, "result.json");
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as RunResult;
  } catch {
    return undefined;
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
