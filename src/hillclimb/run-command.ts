// `hillclimb run`, composed: the cases' preparation (command.ts), the variant's plugin snapshot, each case's
// session pointed at that snapshot, eval's answer-key guard and staging preflight over the substituted session,
// and the job runner — then the runner core (runner.ts), which owns the flow dir, the gate and the rows.
//
// Everything refusable here runs before any spend and exits 2, the runner's code for a refusal. A plain
// --dry-run takes no snapshot: it checks the live plugin the pass would snapshot.

import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { UsageError } from "../errors.js";
import { tildeify } from "../io.js";
import { applySessionOverrides, expandHome, type SessionConfig } from "../session.js";
import { buildFingerprint } from "../run/cassette.js";
import { effectiveTier, runOutDir, scenarioInputFindings } from "../run/execute.js";
import { readIndex, type RunIndexRow } from "../run/run-index.js";
import { runsWriteRoot } from "../run/trace-view.js";
import { loadCostHistory } from "../eval/plan-history.js";
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
import { flowHashOf, liveLockHolder, lockHeldMessage, slotsIn } from "./flow.js";
import { NoFollowRoot, normalizeRootArg } from "./fs.js";
import { makeHillclimbJobRunner } from "./job.js";
import { readVariantFileIfPresent, runHillclimb, termSafe, type RunOutcome } from "./runner.js";
import { SNAPSHOT_ROOT_ENV, variantSnapshot } from "./snapshot.js";

/** Where variant snapshots live: outside every git work tree, or the stager would mount them empty. */
export const defaultSnapshotRoot = (): string => join(homedir(), ".cowork-harness", "hillclimb-snapshots");

/** The snapshot root: `$COWORK_HARNESS_HILLCLIMB_SNAPSHOTS` when set (absolute only — a relative value would move
 *  with the cwd, and a variant's snapshot must be found again on every later run), else the default. */
export function snapshotRootFrom(env: NodeJS.ProcessEnv): string {
  const v = env[SNAPSHOT_ROOT_ENV];
  if (v === undefined || v === "") return defaultSnapshotRoot();
  if (!isAbsolute(v)) throw new UsageError(`${SNAPSHOT_ROOT_ENV} must be an absolute path (got "${v}")`);
  return resolve(v);
}

/** `p`'s real path, or its nearest existing ancestor's real path joined with the rest. */
function realNearest(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(cur), ...tail.reverse());
    } catch {
      if (dirname(cur) === cur) return resolve(p);
      tail.push(basename(cur));
      cur = dirname(cur);
    }
  }
}
const inside = (child: string, parent: string): boolean => {
  const c = realNearest(child);
  const p = realNearest(parent);
  return c === p || c.startsWith(p + sep);
};

export interface RunCommandDeps<F extends { label?: string; ablateSkill?: boolean } = { label?: string; ablateSkill?: boolean }> {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Default: `snapshotRootFrom(env)`. */
  snapshotRoot?: string;
  secrets: readonly string[];
  stderr: (line: string) => void;
  flags: F;
  runScenario: ScenarioRunner<F>;
  /** The host-`claude` isolation preflight (`isolationRefusal`, src/decide/llm-transport.ts): the refusal message, or
   *  undefined. Required, as on eval, so no caller skips it by omission. */
  isolationCheck: () => string | undefined;
  harnessVersion?: string;
  /** Where a run with this id writes — `runOutDir` unless a test redirects it. */
  runDirFor?: (scenario: Scenario, runId: string) => string;
  now?: () => number;
  tickMs?: number;
  /** Where kept runs live (their result.json holds grades and the rubric): hidden from every mount. */
  runsRoot?: string;
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

  // The judge and the LLM decider run the host `claude` isolated and tool-less (eval's rule): a CLI that cannot is
  // refused here, once, instead of failing every rep after its agent spend. A decider channel replaces the LLM
  // decider, so `on_unanswered: llm` then never calls it.
  const llmDecider = args.deciderCmd === undefined && args.deciderDir === undefined;
  if (
    cases.some(
      (c) => (llmDecider && c.scenario.on_unanswered === "llm") || (c.scenario.assert ?? []).some((a) => a.semantic_matches !== undefined),
    )
  ) {
    const iso = deps.isolationCheck();
    if (iso) throw new UsageError(iso);
  }
  const flowArg = normalizeRootArg(args.flow);
  const flowHash = flowHashOf(resolve(deps.cwd, flowArg));
  const runsRoot = deps.runsRoot ?? runsWriteRoot();

  // The snapshot root, default or override, must sit apart from what it copies and what judges it.
  const snapshotRoot = deps.snapshotRoot ?? snapshotRootFrom(deps.env);
  for (const [what, dir] of [
    ["the plugin the loop edits", live],
    ["the flow dir", resolve(deps.cwd, flowArg)],
    ["the runs root", runsRoot],
  ] as const)
    if (inside(snapshotRoot, dir))
      throw new UsageError(
        `the snapshot root ${tildeify(snapshotRoot)} is inside ${what} (${tildeify(dir)}); set ${SNAPSHOT_ROOT_ENV} to a directory apart from it`,
      );

  // The plugin the variant runs. A variant with rows keeps the snapshot of its first run.
  let pluginDir = live;
  if (!args.dryRun) {
    const variantRan = ["results.jsonl", "errors.jsonl"].some((f) => slotsIn(readVariantFileIfPresent(flowArg, v, f, deps.cwd)).size > 0);
    // A live runner of this variant may be mounting its snapshot: never re-take it under that runner.
    const holder = liveLockHolder(flowArg, v, deps.cwd);
    if (holder !== undefined) throw new UsageError(lockHeldMessage(holder, join(flowArg, v, ".lock")));
    NoFollowRoot.open(snapshotRoot); // created no-follow: a planted link on its path is refused
    const snap = variantSnapshot(live, { snapshotRoot, flowHash, variant: v, variantRan });
    pluginDir = snap.dir;
    if (snap.created) say(`[${v}] plugin snapshot: ${tildeify(live)} → ${tildeify(snap.dir)}`);
    if (snap.untrackedExcluded)
      say(
        `[${v}] ${snap.untrackedExcluded} untracked file(s) in the plugin were left out — the stager delivers git-tracked files only, as real Cowork does; 'git add' a file the skill needs`,
      );
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
    // Under --judge-model only that model is live (eval's rule, resolveJudgePins): every run grades with it.
    extra: (spec) => ({
      session: sessions.get(spec.c.id)!,
      ...(args.judgeModel !== undefined ? { judgeModelOverride: args.judgeModel } : {}),
    }),
    ...(deps.now ? { now: deps.now } : {}),
  });
  const baselineIds = [...new Set(cases.map((c) => prep.baseline(c).appVersion))].sort();

  // The dry run's estimate: eval's cost function on eval's basis exactly (hillclimb runs excluded), so every
  // covered key means the same on both commands.
  const price: Prepared["price"] = (remaining) => {
    const rows = (deps.indexRows ?? (() => readIndex(runsWriteRoot())))();
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
    inputs: (c) => prep.session(c).uploads.map((u) => resolve(expandHome(u))),
    derivedPaths: prep.derivedPaths,
    hiddenPaths: (cs) => [...prep.hiddenPaths(cs), runsRoot],
    // The declared mounts (the live plugin among them) and the snapshot the runs actually mount.
    mountRoots: (cs) => [...new Set([...prep.mountRoots(cs), pluginDir])],
    lever: live,
    expectedContentSig: (c) => sigs.get(c.id),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.tickMs !== undefined ? { tickMs: deps.tickMs } : {}),
  };
  return { runner, price };
}
