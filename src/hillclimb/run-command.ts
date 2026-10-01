// `hillclimb run`, composed: the cases' preparation (command.ts), the variant's plugin snapshot, each case's
// session pointed at that snapshot, eval's answer-key guard and staging preflight over the substituted session,
// and the job runner — then the runner core (runner.ts), which owns the flow dir, the gate and the rows.
//
// Everything refusable here runs before any spend and exits 2, the runner's code for a refusal. A plain
// --dry-run takes no snapshot: it checks the live plugin the pass would snapshot.

import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { UsageError } from "../errors.js";
import { tildeify } from "../io.js";
import { applySessionOverrides, type SessionConfig } from "../session.js";
import { buildFingerprint } from "../run/cassette.js";
import { effectiveTier, runOutDir, scenarioInputFindings } from "../run/execute.js";
import { readIndex, type RunIndexRow } from "../run/run-index.js";
import { runsWriteRoot } from "../run/trace-view.js";
import { HILLCLIMB_LABEL_PREFIX, loadCostHistory } from "../eval/plan-history.js";
import { estimateScheduleCost, scheduleCostJson, scheduleCostLine, type ScheduleCostJson } from "../eval/planner.js";
import { pkgVersion } from "../run/envelope.js";
import { ANSWER_KEY_ADVICE, answerKeyFindings } from "../eval/snapshot.js";
import { evidenceFacts } from "../eval/invocation.js";
import type { ScenarioRunner } from "../eval/job-runner.js";
import { gradedSkillNameFor, resolveCritiquedSkillDir } from "../critique/command.js";
import type { Scenario } from "../types.js";
import type { HillclimbRunArgs } from "./args.js";
import { loadCases } from "./cases.js";
import { prepareCases } from "./command.js";
import { flowHashOf, slotsIn } from "./flow.js";
import { normalizeRootArg } from "./fs.js";
import { makeHillclimbJobRunner } from "./job.js";
import { readVariantFileIfPresent, runHillclimb, termSafe, type RunOutcome } from "./runner.js";
import { variantSnapshot } from "./snapshot.js";

/** Where variant snapshots live: outside every git work tree, or the stager would mount them empty. */
export const defaultSnapshotRoot = (): string => join(homedir(), ".cowork-harness", "hillclimb-snapshots");

export interface RunCommandDeps<F extends { label?: string; ablateSkill?: boolean }> {
  cwd: string;
  env: NodeJS.ProcessEnv;
  snapshotRoot: string;
  secrets: readonly string[];
  stderr: (line: string) => void;
  flags: F;
  runScenario: ScenarioRunner<F>;
  harnessVersion?: string;
  /** Where a run with this id writes — `runOutDir` unless a test redirects it. */
  runDirFor?: (scenario: Scenario, runId: string) => string;
  now?: () => number;
  tickMs?: number;
  /** The run index the dry run prices from (this machine's `runs/index.jsonl`). */
  indexRows?: () => RunIndexRow[];
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function runHillclimbCommand<F extends { label?: string; ablateSkill?: boolean }>(
  args: HillclimbRunArgs,
  deps: RunCommandDeps<F>,
): Promise<RunOutcome & { cost?: ScheduleCostJson }> {
  const say = (line: string) => deps.stderr(termSafe(line));
  let runner: Parameters<typeof runHillclimb>[1];
  let price: Prepared["price"];
  try {
    ({ runner, price } = prepare(args, deps, say));
  } catch (e) {
    if (!(e instanceof Error)) throw e;
    const m = message(e);
    say(m.startsWith("refusing") ? m : `refusing to run: ${m}`);
    return { exitCode: 2, scheduled: 0, ok: 0, failed: 0 };
  }
  const outcome = await runHillclimb(args, runner);
  if (!args.dryRun || outcome.remaining === undefined) return outcome;
  const cost = price(outcome.remaining);
  say(`[${args.variant}] ${scheduleCostLine(cost)}`);
  return { ...outcome, cost: scheduleCostJson(cost) };
}

interface Prepared {
  runner: Parameters<typeof runHillclimb>[1];
  /** The dry run's estimate for the remaining slots (case id → count). */
  price: (remaining: Record<string, number>) => ReturnType<typeof estimateScheduleCost>;
}

function prepare<F extends { label?: string; ablateSkill?: boolean }>(
  args: HillclimbRunArgs,
  deps: RunCommandDeps<F>,
  say: (l: string) => void,
): Prepared {
  const v = args.variant;
  const { cases } = loadCases(resolve(deps.cwd, args.target));
  const prep = prepareCases(cases, {
    ...(args.model !== undefined ? { modelFlag: args.model } : {}),
    ...(args.judgeModel !== undefined ? { judgeModelFlag: args.judgeModel } : {}),
    env: deps.env,
  });
  const live = prep.lever;
  const flowArg = normalizeRootArg(args.flow);
  const flowHash = flowHashOf(resolve(deps.cwd, flowArg));

  // The plugin the variant runs. A variant with rows keeps the snapshot of its first run.
  let pluginDir = live;
  if (!args.dryRun) {
    const variantRan = ["results.jsonl", "errors.jsonl"].some((f) => slotsIn(readVariantFileIfPresent(flowArg, v, f, deps.cwd)).size > 0);
    const snap = variantSnapshot(live, { snapshotRoot: deps.snapshotRoot, flowHash, variant: v, variantRan });
    pluginDir = snap.dir;
    if (snap.created) say(`[${v}] plugin snapshot: ${tildeify(live)} → ${tildeify(snap.dir)}`);
    if (snap.liveDiffers)
      say(
        `[${v}] note: the live plugin ${tildeify(live)} differs from variant ${v}'s snapshot (taken on its first run); its reps run from the snapshot`,
      );
  }

  // Eval's answer-key guard: no scenario or session file of this flow may be readable through the plugin.
  const evalFiles = [...new Set(cases.flatMap((c) => [resolve(c.file), prep.sessionFile(c)]))];
  const findings = answerKeyFindings(evalFiles, [{ label: v, sourceDir: live, snapshotDir: pluginDir }]);
  if (findings.length)
    throw new UsageError(
      `answer-key guard: the plugin could let the agent read this flow's own scenarios — ` +
        findings.map((f) => `${tildeify(f.file)} (${f.reason.replace(/_/g, " ")})`).join("; ") +
        `. To fix: ${[...new Set(findings.map((f) => ANSWER_KEY_ADVICE[f.reason]))].join("; ")}.`,
    );

  // Per case: the session pointed at the variant's plugin, its signature from the same fingerprint call a run
  // makes, and the input checks a run makes before its run dir exists — over the SUBSTITUTED session.
  const sessions = new Map<string, SessionConfig>();
  const sigs = new Map<string, string>();
  for (const c of cases) {
    const declared = prep.session(c);
    let sub: SessionConfig;
    try {
      sub = applySessionOverrides(declared, { model: prep.pin(c), skillDirSubstitution: [declared.plugins.local_plugins[0], pluginDir] });
    } catch (e) {
      throw new UsageError(`case ${c.id}: ${message(e)}`);
    }
    sessions.set(c.id, sub);
    const baseline = prep.baseline(c);
    const sig = buildFingerprint(c.scenario.session, baseline.appVersion, undefined, c.scenario.skills, baseline, sub).contentSig;
    if (sig === undefined) throw new UsageError(`case ${c.id}: the plugin hashes to nothing (no files the fingerprint covers)`);
    sigs.set(c.id, sig);
    const f = scenarioInputFindings(c.scenario, undefined, { quiet: true, session: sub, unloadableBaseline: "report" });
    const refusal = f.session ?? f.vacuity ?? f.inputs;
    if (refusal) throw new UsageError(`case ${c.id}: ${refusal.message}`);
  }

  // Which skill's invocation the rows record (the `skill_invoked` column): one per plugin, or none.
  const skillName = (() => {
    try {
      return gradedSkillNameFor(undefined, resolveCritiquedSkillDir(pluginDir, undefined));
    } catch {
      return undefined;
    }
  })();
  if (skillName === undefined) say(`[${v}] the plugin has no single skill to record invocation for: skill_invoked is omitted`);

  const job = makeHillclimbJobRunner({
    runScenario: deps.runScenario,
    flags: deps.flags,
    runDirFor: deps.runDirFor ?? ((s, id) => runOutDir(s.name, id)),
    extra: (spec) => ({ session: sessions.get(spec.c.id)! }),
    ...(deps.now ? { now: deps.now } : {}),
  });
  const baselineIds = [...new Set(cases.map((c) => prep.baseline(c).appVersion))].sort();

  // The dry run's estimate: E1a's one cost function. A flow's own prior passes are the closest predictor of its
  // next one, so this flow's hillclimb runs count; another flow's never do — the index cannot tell an ablated
  // run apart, and a null run always lives in its own (sibling) flow.
  const ownLabel = `${HILLCLIMB_LABEL_PREFIX}${basename(flowArg)}:`;
  const price: Prepared["price"] = (remaining) => {
    const rows = (deps.indexRows ?? (() => readIndex(runsWriteRoot())))().filter(
      (r) => !r.runLabel?.startsWith(HILLCLIMB_LABEL_PREFIX) || r.runLabel.startsWith(ownLabel),
    );
    return estimateScheduleCost(
      cases
        .filter((c) => (remaining[c.id] ?? 0) > 0)
        .map((c) => {
          const baseline = prep.baseline(c);
          return {
            scenario: c.scenario.name,
            jobs: remaining[c.id],
            history: loadCostHistory(rows, {
              scenario: c.scenario.name,
              baseline: baseline.appVersion,
              tier: effectiveTier(c.scenario.fidelity, baseline),
              includeHillclimb: true,
            }),
          };
        }),
    );
  };

  const runner: Parameters<typeof runHillclimb>[1] = {
    cwd: deps.cwd,
    secrets: deps.secrets,
    stderr: deps.stderr,
    virtual: { harnessVersion: deps.harnessVersion ?? pkgVersion(), baselineId: baselineIds.join(",") },
    runJob: async (spec) => {
      const rep = await job(spec);
      if (rep.result !== undefined && skillName !== undefined) {
        const invoked = evidenceFacts({ result: rep.result, skillName, pluginRoot: pluginDir }).invoked;
        if (invoked !== "unobservable") rep.skillInvoked = invoked;
      }
      return rep;
    },
    pin: prep.pin,
    derivedPaths: prep.derivedPaths,
    // The declared mounts (the live plugin among them) and the snapshot the runs actually mount.
    mountRoots: (cs) => [...new Set([...prep.mountRoots(cs), pluginDir])],
    lever: live,
    expectedContentSig: (c) => sigs.get(c.id),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.tickMs !== undefined ? { tickMs: deps.tickMs } : {}),
  };
  return { runner, price };
}
