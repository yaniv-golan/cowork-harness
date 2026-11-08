// `hillclimb seed <target> --flow <dir> --from-eval <evalDir> --arm <label|A|B>`: start a flow's baseline from an
// eval arm the operator already paid for. No agent runs. The arm's snapshot becomes the baseline's snapshot, and each
// of the arm's reps becomes one baseline row, built from its kept run dir by the code a live pass uses.
//
// Everything that can refuse runs before the first write. The eval must measure what the flow measures: the same
// scenario files and assertions, tier, baseline, agent and judge pins, and plugin content. A refusal names the first
// field that differs. `_state.json` is never touched: seeding is not harness approval.

import { existsSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { UsageError } from "../errors.js";
import { tildeify } from "../io.js";
import { sha256File } from "../baseline.js";
import type { PlatformBaseline } from "../types.js";
import { buildFingerprint } from "../run/cassette.js";
import { effectiveTier, loadSessionFromFile } from "../run/execute.js";
import { applySessionOverrides, effortSelector, expandHome, pinnedConfigDirOf, resolveEffort, type SessionConfig } from "../session.js";
import { salvagedResult } from "../eval/job-runner.js";
import { readManifest, type EvalManifest } from "../eval/manifest.js";
import { readRunsLines, RUNS_FILE, type RunsLine } from "../eval/runs.js";
import { readStopped } from "../eval/stopped.js";
import { resolveJudgePins } from "../eval/pins.js";
import { evidenceFacts } from "../eval/invocation.js";
import { resolveHeadroomArm } from "../eval/headroom.js";
import { pkgVersion } from "../run/envelope.js";
import { readFileSync } from "node:fs";
import { loadCases, type HillclimbCase } from "./cases.js";
import { prepareCases } from "./command.js";
import { assertSig } from "./grade-keys.js";
import { FlowWriter, flowHashOf, liveLockHolder, lockHeldMessage } from "./flow.js";
import { normalizeRootArg } from "./fs.js";
import { flowMetricUnion, refuseChangedMetrics, staleAssertSigRows } from "./metric-keys.js";
import { CREDENTIAL_PRECEDENCE_ENV_KEYS } from "./cost.js";
import { trackedSkill } from "./skill.js";
import { installVariantSnapshot } from "./snapshot.js";
import { snapshotRootFrom } from "./run-command.js";
import { findMainTranscript, keptChildTranscripts, mainSystemTurn, sentSubagentAppend } from "./trace.js";
import {
  ablationMix,
  attemptContext,
  existingFlowSnapshot,
  NONE,
  recordAttempt,
  skillTrackedByVariant,
  trackedText,
  writeCostSummary,
  type JobReport,
} from "./runner.js";
import { BASELINE_REF } from "./pairwise.js";

export interface HillclimbSeedArgs {
  target: string;
  flow: string;
  fromEval: string;
  arm: string;
}

export interface SeedOutcome {
  exitCode: 0 | 1 | 2;
  error?: { category: "usage" | "runtime"; message: string };
  flow: string;
  variant: "baseline";
  seeded: number;
  errors: number;
  snapshot?: string;
}

const V = BASELINE_REF;
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const lines = (p: string): string[] =>
  existsSync(p)
    ? readFileSync(p, "utf8")
        .split("\n")
        .filter((l) => l.trim())
    : [];

/** The agent session's id: the last event that names one (the transcript's file name). */
function sessionIdOf(events: readonly string[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (!events[i].includes('"session_id"')) continue;
    try {
      const sid = (JSON.parse(events[i]) as { session_id?: unknown }).session_id;
      if (typeof sid === "string" && sid) return sid;
    } catch {
      /* not a frame */
    }
  }
  return undefined;
}

/** A kept eval rep as the runner's JobReport: what a live attempt hands the row builder. */
function reportFromRunDir(runDir: string, session: SessionConfig): JobReport {
  const result = salvagedResult(runDir);
  const events = lines(join(runDir, "events.jsonl"));
  const fidelity = result?.effectiveFidelity ?? result?.fidelity;
  const configDir = pinnedConfigDirOf(session);
  const kept = fidelity
    ? {
        outDir: runDir,
        fidelity,
        ...(result?.workDir ? { workDir: result.workDir } : {}),
        ...(configDir !== undefined ? { configDir } : {}),
      }
    : undefined;
  const sid = sessionIdOf(events);
  const found = kept ? findMainTranscript(kept, sid) : undefined;
  const subagentAppend = sentSubagentAppend(runDir);
  return {
    result,
    events,
    ...(found?.lines !== undefined ? { transcript: found.lines } : {}),
    ...(found !== undefined ? { transcriptWhere: found.where } : {}),
    children: kept ? keptChildTranscripts(kept, sid) : [],
    ...(subagentAppend !== undefined ? { subagentAppend } : {}),
    system: mainSystemTurn(runDir),
    attemptS: (result?.durationMs ?? 0) / 1000,
    runnerTimeout: false,
    runDir,
  };
}

export async function seedBaseline(
  args: HillclimbSeedArgs,
  deps: { cwd: string; env: NodeJS.ProcessEnv; secrets: readonly string[]; stderr: (line: string) => void; snapshotRoot?: string },
): Promise<SeedOutcome> {
  const say = deps.stderr;
  const flowArg = normalizeRootArg(args.flow);
  const base = { flow: flowArg, variant: V, seeded: 0, errors: 0 } as const;
  const refuse = (m: string): SeedOutcome => {
    const line = `refusing to seed: ${m}`;
    say(line);
    return { ...base, exitCode: 2, error: { category: "usage", message: line } };
  };

  // ---- everything that can refuse, before any write ----
  let plan: ReturnType<typeof planSeed>;
  try {
    plan = planSeed(args, deps, flowArg);
  } catch (e) {
    if (e instanceof UsageError) return refuse(e.message);
    throw e;
  }
  for (const w of plan.warnings) say(w);

  // ---- the writes, under the baseline's lock ----
  const writer = FlowWriter.open(flowArg, V, { cwd: deps.cwd, secrets: deps.secrets });
  const release = writer.lock();
  let installed: { dir: string; marker: string } | undefined;
  const cleanup = () => {
    if (installed) {
      rmSync(installed.marker, { force: true });
      rmSync(installed.dir, { recursive: true, force: true });
    }
    // Refused unless the baseline had no rows, so these files are this seed's own.
    for (const f of ["results.jsonl", "errors.jsonl", "summary.json"]) rmSync(writer.vpath(f), { force: true });
    rmSync(writer.vpath("traces"), { recursive: true, force: true });
    rmSync(writer.vpath("out"), { recursive: true, force: true });
  };
  try {
    try {
      installed = installVariantSnapshot(plan.armDir, {
        snapshotRoot: plan.snapshotRoot,
        flowHash: plan.flowHash,
        variant: V,
        name: basename(plan.lever),
      });
    } catch (e) {
      if (e instanceof UsageError) {
        release();
        return refuse(e.message);
      }
      throw e;
    }
    const pluginDir = installed.dir;
    // The installed copy must hash to what each of the arm's reps ran: the same fingerprint call a run makes.
    const sigs = new Map<string, string>();
    for (const c of plan.cases) {
      const sig = caseSig(c, plan.session(c), plan.baseline(c), plan.pin(c), pluginDir);
      const want = plan.manifest.arms[plan.armIndex].sigs[c.scenario.name];
      if (sig === undefined || sig !== want) {
        cleanup();
        release();
        return refuse(
          `case ${c.id}: the eval arm's snapshot hashes to ${sig?.slice(0, 12) ?? "nothing"} as installed, but its reps ran ${want?.slice(0, 12) ?? "(none recorded)"} — the content differs`,
        );
      }
      sigs.set(c.id, sig);
    }
    const tracked = trackedSkill(pluginDir, plan.manifest.skill ?? undefined);
    const skillName = tracked.name;
    let seeded = 0;
    let errors = 0;
    for (const c of plan.cases) {
      const session = plan.session(c);
      const baseline = plan.baseline(c);
      const declared = loadSessionFromFile(c.scenario.session);
      const selector = effortSelector(plan.pin(c), baseline);
      for (const line of plan.reps.get(c.id)!) {
        const runDir = resolve(expandHome(line.runDir!));
        const report = reportFromRunDir(runDir, session);
        if (report.result !== undefined && skillName !== undefined) {
          const invoked = evidenceFacts({ result: report.result, skillName, pluginRoot: pluginDir }).invoked;
          if (invoked !== "unobservable") report.skillInvoked = invoked;
        }
        const rep = line.rep - 1;
        const ctx = attemptContext(c, rep, report, {
          metrics: plan.metrics,
          flowHash: plan.flowHash,
          // The version that made the rows; the seeder's own is in meta.seeded_from.
          env: { harnessVersion: plan.manifest.harnessVersion, baselineId: plan.baselineIds },
          sig: sigs.get(c.id),
          pin: plan.pin(c),
          requestedEffort: { effort: resolveEffort({ session: declared.effort, baseline }), noSelector: selector === false },
          credentialEnv: Object.fromEntries(
            CREDENTIAL_PRECEDENCE_ENV_KEYS.flatMap((k) => (baseline.spawn?.env?.[k] ? [[k, baseline.spawn.env[k]!]] : [])),
          ),
          ...(tracked.name !== undefined ? { skillTracked: tracked.id } : {}),
          ablate: false,
          allowModelSplit: false,
        });
        const rec = recordAttempt({
          writer,
          variant: V,
          c,
          rep,
          report,
          ctx,
          secrets: deps.secrets,
          uploads: session.uploads.map((u) => resolve(expandHome(u))),
          noCopyInputs: false,
          metaExtra: {
            seeded_from: {
              eval_id: plan.manifest.evalId,
              arm: plan.manifest.arms[plan.armIndex].label,
              eval_rep: line.rep,
              run_id: line.runId,
              seeder_version: pkgVersion(),
            },
          },
        });
        if (rec.postWriteError !== undefined) throw rec.postWriteError;
        if (rec.dest === "results") seeded++;
        else errors++;
      }
    }
    for (const l of writeCostSummary(writer, V)) say(l);
    say(
      `[${V}] seeded ${seeded} row(s)${errors ? ` and ${errors} errors row(s)` : ""} from eval ${plan.manifest.evalId} arm ${plan.manifest.arms[plan.armIndex].label}; snapshot ${tildeify(pluginDir)}`,
    );
    say(
      `[${V}] the harness is not approved by seeding: review it, then \`hillclimb run ${args.target} --flow ${flowArg} --approve-harness --dry-run\``,
    );
    return { ...base, exitCode: 0, seeded, errors, snapshot: pluginDir };
  } catch (e) {
    cleanup();
    const m = `seeding failed after its first write, and what it wrote was removed: ${message(e)}`;
    say(m);
    return { ...base, exitCode: 1, error: { category: "runtime", message: m } };
  } finally {
    release();
  }
}

/** The arm snapshot's content signature for a case, over the session pointed at `pluginDir`. */
function caseSig(
  c: HillclimbCase,
  declared: SessionConfig,
  baseline: PlatformBaseline,
  pin: string,
  pluginDir: string,
): string | undefined {
  const sub = applySessionOverrides(declared, { model: pin, skillDirSubstitution: [declared.plugins.local_plugins[0], pluginDir] });
  return buildFingerprint(c.scenario.session, baseline.appVersion, undefined, c.scenario.skills, baseline, sub).contentSig;
}

function planSeed(args: HillclimbSeedArgs, deps: { cwd: string; env: NodeJS.ProcessEnv; snapshotRoot?: string }, flowArg: string) {
  const warnings: string[] = [];
  const evalDir = resolve(deps.cwd, args.fromEval);
  let manifest: EvalManifest;
  try {
    manifest = readManifest(evalDir);
  } catch (e) {
    throw new UsageError(`${tildeify(evalDir)} is not an eval dir this version reads: ${message(e)}`);
  }
  if (manifest.pins.searchCorpus)
    throw new UsageError(`eval ${manifest.evalId} ran on a frozen search corpus: its searches were not live, so it is not a live baseline`);
  let stopped;
  try {
    stopped = readStopped(evalDir);
  } catch (e) {
    throw new UsageError(`eval ${manifest.evalId}: ${message(e)}`);
  }
  if (stopped) throw new UsageError(`eval ${manifest.evalId} stopped early (stopped.json): it is incomplete`);
  const role = resolveHeadroomArm(manifest, args.arm);
  const armIndex = manifest.arms.findIndex((a) => a.role === role);
  const arm = manifest.arms[armIndex];

  const { cases } = loadCases(resolve(deps.cwd, args.target));
  const pairwise = cases.filter((c) => (c.scenario.assert ?? []).some((a) => a.semantic_pairwise !== undefined));
  if (pairwise.length)
    throw new UsageError(
      `case ${pairwise.map((c) => c.id).join(", ")} has a semantic_pairwise assert: pairwise flows start from a live baseline pass (it freezes the reference)`,
    );
  const prep = prepareCases(cases, { env: deps.env }, cases);
  const judgePins = resolveJudgePins(
    cases.map((c) => c.scenario),
    undefined,
  ).resolved;

  const { lines: runs } = readRunsLines(join(evalDir, RUNS_FILE));
  const reps = new Map<string, RunsLine[]>();
  for (const c of cases) {
    const name = c.scenario.name;
    const ms = manifest.scenarios.find((s) => s.name === name);
    if (!ms) throw new UsageError(`case ${c.id}: eval ${manifest.evalId} has no scenario named ${JSON.stringify(name)}`);
    const baseline = prep.baseline(c);
    if (effectiveTier(c.scenario.fidelity, baseline) === "protocol")
      throw new UsageError(`case ${c.id} runs at the protocol tier: its billing basis comes from this machine's env, so it is not seeded`);
    const diff = (field: string, eval_: unknown, flow: unknown) =>
      new UsageError(`case ${c.id}: ${field} differs — eval ${JSON.stringify(eval_)}, flow ${JSON.stringify(flow)}`);
    if (sha256File(c.file) !== ms.sha256) throw diff("the scenario file (sha256)", ms.sha256.slice(0, 12), sha256File(c.file).slice(0, 12));
    const evalSig = assertSig({ assert: ms.assertions });
    const flowSig = assertSig({ assert: c.scenario.assert ?? [] });
    if (evalSig !== flowSig) throw diff("assert_sig", evalSig.slice(0, 12), flowSig.slice(0, 12));
    const sessionFile = prep.sessionFile(c);
    if (sessionFile === undefined || sha256File(sessionFile) !== ms.sessionSha256)
      throw diff(
        "the session file (sha256)",
        ms.sessionSha256.slice(0, 12),
        sessionFile ? sha256File(sessionFile).slice(0, 12) : "(inline)",
      );
    if (ms.baseline !== baseline.appVersion) throw diff("the baseline", ms.baseline, baseline.appVersion);
    const agent = manifest.pins.agent.find((p) => p.scenario === name)?.model;
    if (agent !== prep.pin(c)) throw diff("the agent pin", agent, prep.pin(c));
    const evalJudges = manifest.pins.judge.resolved.filter((p) => p.scenario === name).map((p) => `${p.assertionIndex}:${p.model}`);
    const flowJudges = judgePins.filter((p) => p.scenario === name).map((p) => `${p.assertionIndex}:${p.model}`);
    if (evalJudges.join(",") !== flowJudges.join(",")) throw diff("the judge pins", evalJudges, flowJudges);

    // Every rep of the arm, 1..reps (eval numbers them from 1; a flow's slots from 0), each once and with its run dir
    // still on disk.
    const mine = runs.filter((l) => l.arm === arm.label && l.scenario === name).sort((a, b) => a.rep - b.rep);
    const n = manifest.settings.reps;
    const repsSeen = mine.map((l) => l.rep).join(",");
    if (mine.length !== n || mine.some((l, i) => l.rep !== i + 1))
      throw new UsageError(`case ${c.id}: eval arm ${arm.label} recorded reps [${repsSeen}] of ${n}: the eval is incomplete`);
    for (const l of mine) {
      if (l.runDir === null) throw new UsageError(`case ${c.id} rep ${l.rep}: the eval rep has no run dir to seed from`);
      if (!existsSync(resolve(expandHome(l.runDir))))
        throw new UsageError(`case ${c.id} rep ${l.rep}: its run dir ${l.runDir} is gone (pruned?): nothing to seed from`);
      if (l.hostInputs !== undefined)
        throw new UsageError(
          `case ${c.id}: the eval ran with plugins.from_host, whose host set a live pass re-measures; start this flow with a live baseline pass`,
        );
    }
    reps.set(c.id, mine);
  }

  // The flow: no baseline rows, no baseline snapshot, no live runner; and the checks a pass makes against what is there.
  const flowAbs = resolve(deps.cwd, flowArg);
  const existing = existingFlowSnapshot(flowArg, deps.cwd);
  const metrics = flowMetricUnion(cases);
  if (existing) {
    const b = existing.variants[V];
    if ((b?.results ?? "").trim() || (b?.errors ?? "").trim())
      throw new UsageError(`${flowArg}/${V} already has rows: seed only a flow whose baseline has never run`);
    refuseChangedMetrics(existing, metrics);
    const mixed = ablationMix(existing, false);
    if (mixed) throw new UsageError(`rows of a null (--ablate) run are in this flow (${mixed}): seed a scored flow`);
    const stale = staleAssertSigRows(existing, cases);
    if (stale.length)
      warnings.push(
        `warning: ${stale.length} row(s) in this flow were graded under another assertion set than their scenario's now: a comparison with the seeded baseline mixes two graders`,
      );
  }
  const holder = liveLockHolder(flowArg, V, deps.cwd);
  if (holder !== undefined) throw new UsageError(lockHeldMessage(holder, join(flowArg, V, ".lock")));
  const lever = prep.lever;
  if (basename(lever) !== basename(arm.snapshot))
    throw new UsageError(
      `the eval arm's snapshot dir is named ${basename(arm.snapshot)}, the flow's plugin ${basename(lever)}: a seeded snapshot must have the plugin's name`,
    );
  const tracked = trackedSkill(join(evalDir, arm.snapshot), manifest.skill ?? undefined);
  if (existing) {
    const byVariant = skillTrackedByVariant(existing);
    const mine = tracked.name !== undefined ? tracked.id : NONE;
    const all = [...byVariant.values()].map((s) => trackedText(s));
    if (all.some((t) => t !== trackedText(new Set([mine]))))
      warnings.push(
        `warning: the flow's variants track ${all.join("; ")} in skill_invoked, and the seeded baseline tracks ${trackedText(new Set([mine]))} — compare that column across them only knowingly`,
      );
  }
  return {
    manifest,
    armIndex,
    armDir: join(evalDir, arm.snapshot),
    cases,
    reps,
    metrics,
    lever,
    flowHash: flowHashOf(flowAbs),
    snapshotRoot: deps.snapshotRoot ?? snapshotRootFrom(deps.env),
    session: (c: HillclimbCase) => prep.session(c),
    baseline: (c: HillclimbCase) => prep.baseline(c),
    pin: (c: HillclimbCase) => prep.pin(c),
    baselineIds: [...new Set(cases.map((c) => prep.baseline(c).appVersion))].sort().join(","),
    warnings,
  };
}
