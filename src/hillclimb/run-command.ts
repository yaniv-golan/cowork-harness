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
import { effectiveTier, loadSessionFromFile, runOutDir, scenarioInputFindings, sessionOriginSources } from "../run/execute.js";
import { pairwiseRefsRefusal } from "../refs/preflight.js";
import { BASELINE_REF, discoverFlowRefs, flowPairwiseOptions, metricRefNames } from "./pairwise.js";
import { freezeCaseRef } from "./freeze-ref.js";
import { readRefDoc, readRefEntry } from "../refs/store.js";
import { pairwiseComposeKey } from "../run/pairwise-prepass.js";
import { createHash } from "node:crypto";
import { flowHasPairwise, metricUnion } from "./grade-keys.js";
import { readIndex, type RunIndexRow } from "../run/run-index.js";
import { runsWriteRoot } from "../run/trace-view.js";
import { loadCostHistory } from "../eval/plan-history.js";
import { estimateScheduleCost, scheduleCostJson, scheduleCostLine, type ScheduleCostJson } from "../eval/planner.js";
import { pkgVersion } from "../run/envelope.js";
import { ANSWER_KEY_ADVICE, answerKeyFindings } from "../eval/snapshot.js";
import { evidenceFacts } from "../eval/invocation.js";
import type { ScenarioRunner } from "../eval/job-runner.js";
import type { Scenario } from "../types.js";
import type { HillclimbRunArgs } from "./args.js";
import { loadCases, selectCases, type HillclimbCase } from "./cases.js";
import { refuseChangedMetrics } from "./metric-keys.js";
import { prepareCases } from "./command.js";
import { flowHashOf, liveLockHolder, lockHeldMessage, slotsIn } from "./flow.js";
import { NoFollowRoot, normalizeRootArg } from "./fs.js";
import { makeHillclimbJobRunner } from "./job.js";
import { existingFlowSnapshot, readVariantFileIfPresent, runHillclimb, termSafe, type RunOutcome } from "./runner.js";
import { trackedSkill } from "./skill.js";
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
  let skill: string | undefined;
  try {
    ({ runner, price, skill } = prepare(args, deps, say));
  } catch (e) {
    if (!(e instanceof Error)) throw e;
    const m = message(e);
    const line = m.startsWith("refusing") ? m : `refusing to run: ${m}`;
    say(line);
    return { exitCode: 2, scheduled: 0, ok: 0, failed: 0, error: { category: "usage", message: line } };
  }
  // --skill by any spelling it accepts is one selection: the gate and `harness_skill` see its registered name.
  const outcome = await runHillclimb(skill !== undefined ? { ...args, skill } : args, runner);
  if (!args.dryRun || outcome.remaining === undefined) return outcome;
  const cost = price(outcome.remaining);
  say(`[${args.variant}] ${scheduleCostLine(cost)}`);
  return { ...outcome, cost: scheduleCostJson(cost) };
}

interface Prepared {
  runner: Parameters<typeof runHillclimb>[1];
  /** The dry run's estimate for the remaining slots (case id → count). */
  price: (remaining: Record<string, number>) => ReturnType<typeof estimateScheduleCost>;
  /** `--skill` as the registered name it selects; undefined without --skill. */
  skill: string | undefined;
}

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

function prepare<F extends { label?: string; ablateSkill?: boolean }>(
  args: HillclimbRunArgs,
  deps: RunCommandDeps<F>,
  say: (l: string) => void,
): Prepared {
  const v = args.variant;
  // The case list is the flow's (every scenario loads); the per-case checks below cover the --case selection only —
  // an unselected case does not run in this pass. The gate, the hidden files and the one-plugin rule cover every case.
  const { cases } = loadCases(resolve(deps.cwd, args.target));
  // One metric id declared two ways is refused before the snapshot below is taken (the runner recomputes the union).
  const union = metricUnion(cases.map((c) => ({ name: c.id, metrics: c.scenario.metrics })));
  // ...and a metric re-declared since the flow's rows were written (the runner repeats this too).
  const existing = existingFlowSnapshot(normalizeRootArg(args.flow), deps.cwd);
  if (existing) refuseChangedMetrics(existing, union);
  const selected = selectCases(cases, args.cases);
  const prep = prepareCases(
    cases,
    {
      ...(args.model !== undefined ? { modelFlag: args.model } : {}),
      ...(args.judgeModel !== undefined ? { judgeModelFlag: args.judgeModel } : {}),
      env: deps.env,
    },
    selected,
  );
  for (const n of prep.notes) say(`[${v}] ${n}`);
  const live = prep.lever;

  // The judges (semantic_matches, semantic_pairwise) and the LLM decider run the host `claude` isolated and tool-less (eval's rule): a CLI that cannot is
  // refused here, once, instead of failing every rep after its agent spend. A decider channel replaces the LLM
  // decider, so `on_unanswered: llm` then never calls it.
  const llmDecider = args.deciderCmd === undefined && args.deciderDir === undefined;
  if (
    selected.some(
      (c) =>
        (llmDecider && c.scenario.on_unanswered === "llm") ||
        (c.scenario.assert ?? []).some((a) => a.semantic_matches !== undefined || a.semantic_pairwise !== undefined),
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
  // A dry run makes the same checks read-only, and takes no snapshot.
  let pluginDir = live;
  {
    const variantRan = ["results.jsonl", "errors.jsonl"].some((f) => slotsIn(readVariantFileIfPresent(flowArg, v, f, deps.cwd)).size > 0);
    // A live runner of this variant may be mounting its snapshot: never re-take it under that runner.
    const holder = liveLockHolder(flowArg, v, deps.cwd);
    if (holder !== undefined) throw new UsageError(lockHeldMessage(holder, join(flowArg, v, ".lock")));
    if (!args.dryRun) NoFollowRoot.open(snapshotRoot); // created no-follow: a planted link on its path is refused
    const snap = variantSnapshot(live, { snapshotRoot, flowHash, variant: v, variantRan, checkOnly: args.dryRun });
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
  const evalFiles = [...new Set(cases.flatMap((c) => [resolve(c.file), prep.sessionFile(c)]))].filter((p): p is string => p !== undefined);
  const findings = answerKeyFindings(evalFiles, [{ label: v, sourceDir: live, snapshotDir: pluginDir }]);
  if (findings.length)
    throw new UsageError(
      `answer-key guard: the plugin could let the agent read this flow's own scenarios — ` +
        findings.map((f) => `${tildeify(f.file)} (${f.reason.replace(/_/g, " ")})`).join("; ") +
        `. To fix: ${[...new Set(findings.map((f) => ANSWER_KEY_ADVICE[f.reason]))].join("; ")}.`,
    );

  // semantic_pairwise: the flow's own references, found once per pass. Every pairwise assert is judged against all
  // of them (the scenario's `refs:` is ignored here); the baseline's decides the verdict, a later variant's is a
  // metric. The pre-spend check below and every run of the pass use this one setup. Whether the flow judges pairwise
  // is a property of every case (it decides the rows' column set, which a --case pass must not change); the checks and
  // the judge-call count below cover the selected cases.
  const flowPairwise = flowHasPairwise(cases.map((c) => ({ assertions: c.scenario.assert ?? [] })));
  const refs = flowPairwise ? discoverFlowRefs(resolve(deps.cwd, flowArg)) : [];
  if (flowPairwise) {
    const ignored = selected.filter((c) => (c.scenario.assert ?? []).some((a) => a.semantic_pairwise?.refs?.length)).map((c) => c.id);
    say(
      `[${v}] pairwise refs: ${refs.map((r) => r.name).join(", ")} (stores: ${refs.map((r) => tildeify(r.store)).join(", ")})` +
        (ignored.length ? `; the scenario \`refs:\` of ${ignored.join(", ")} is ignored under hillclimb` : ""),
    );
  }
  const pairwiseFor = (c: HillclimbCase) => flowPairwiseOptions(c.id, v, refs);
  if (flowPairwise && args.dryRun) {
    // The judge's spend is not in plan.cost (agent spend only): say how many calls a rep makes, at most.
    const judged = refs.filter((r) => r.name !== v).length;
    const calls = selected.reduce(
      (n, c) =>
        n +
        (c.scenario.assert ?? []).reduce(
          (k, a) => k + (a.semantic_pairwise ? judged * (a.semantic_pairwise.order === "both" ? 2 : 1) : 0),
          0,
        ),
      0,
    );
    say(
      `[${v}] pairwise judging (experimental; not in the estimate, which covers agent spend only): up to ${calls} judge call(s) per rep over the cases, plus a retry each when a reply is invalid — unpriced`,
    );
  }

  // Per case: the session pointed at the variant's plugin, its signature from the same fingerprint call a run
  // makes, and the input checks a run makes before its run dir exists — over the SUBSTITUTED session. Selected cases
  // only; an unselected case whose session loads still records its signature, so the variant's source_sig is the
  // same under any --case selection WHEN every unselected case's session loads. One that does not (or an inline
  // session) records no signature: a --case pass then records a source_sig a full pass would not, and summary.json
  // keeps the first writer's.
  const sessions = new Map<string, SessionConfig>();
  const sigs = new Map<string, string>();
  const chosen = new Set(selected.map((c) => c.id));
  for (const c of cases) {
    if (chosen.has(c.id)) continue;
    try {
      const declared = loadSessionFromFile(c.scenario.session);
      const sub = applySessionOverrides(declared, { skillDirSubstitution: [declared.plugins.local_plugins[0], pluginDir] });
      const baseline = prep.baseline(c);
      const sig = buildFingerprint(c.scenario.session, baseline.appVersion, undefined, c.scenario.skills, baseline, sub).contentSig;
      if (sig !== undefined) sigs.set(c.id, sig);
    } catch {
      /* not run in this pass: its refusal is a pass that selects it */
    }
  }
  for (const c of selected) {
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
    // semantic_pairwise references: the gate a run applies before its run dir exists, once per case, over the
    // substituted session and with the flow's setup — a missing or damaged baseline reference, or a store a mount
    // exposes, refuses up front. A later variant's reference is a metric: unreadable, it blanks its own column.
    if (flowPairwise) {
      const o = pairwiseFor(c);
      const pw = pairwiseRefsRefusal(
        c.scenario,
        { caseId: o.caseId, refsFor: () => o.refs, neutralRefs: new Set(o.neutralRefs), gateRefs: new Set(o.gateRefs) },
        sessionOriginSources(sub, "(inline)"),
      );
      if (pw) {
        // The repair depends on WHY: an absent entry, or a sound one for this prompt that lacks a compose key, can be
        // frozen; a damaged entry or document, or one frozen for another prompt, never is — the flow restarts. Any
        // other refusal (a store a mount exposes) names its own fix.
        const store = join(resolve(deps.cwd, flowArg), BASELINE_REF, "ref");
        const e = readRefEntry(store, c.id);
        const keys = (c.scenario.assert ?? []).filter((a) => a.semantic_pairwise !== undefined).map(pairwiseComposeKey);
        const docs = e.status === "ok" ? keys.map((k) => readRefDoc(store, c.id, k).status) : [];
        const samePrompt = e.status === "ok" && e.taskSha256 === sha256(c.scenario.prompt);
        // Only a refusal about the baseline reference itself gets a reference repair.
        const aboutRef = pw.includes(`reference "${BASELINE_REF}"`);
        const hint = !aboutRef
          ? undefined
          : e.status === "missing" || (samePrompt && docs.includes("missing") && !docs.includes("integrity"))
            ? `the baseline reference is frozen by a baseline pass from its lowest-rep good row, or now with \`hillclimb freeze-ref ${args.target} --flow ${flowArg} --variant baseline --case ${c.id}\``
            : e.status === "integrity" || (e.status === "ok" && (!samePrompt || docs.includes("integrity")))
              ? `a frozen reference is never repaired in place: start a fresh flow dir`
              : undefined;
        throw new UsageError(`case ${c.id}: ${pw}${hint ? `\n  ${hint}` : ""}`);
      }
    }
  }

  // Which skill's invocation the rows record (the `skill_invoked` column), resolved against the snapshot the runs
  // mount (a dry run: the live plugin's tracked files, which a pass would snapshot). An unknown --skill refuses
  // here, before any spend.
  const tracked = trackedSkill(pluginDir, args.skill);
  const skillName = tracked.name;
  say(tracked.name === undefined ? `[${v}] ${tracked.note}` : `[${v}] skill_invoked tracks ${tracked.id}`);

  const job = makeHillclimbJobRunner({
    runScenario: deps.runScenario,
    flags: deps.flags,
    runDirFor: deps.runDirFor ?? ((s, id) => runOutDir(s.name, id)),
    // Under --judge-model only that model is live (eval's rule, resolveJudgePins): every run grades with it.
    extra: (spec) => ({
      session: sessions.get(spec.c.id)!,
      ...(args.judgeModel !== undefined ? { judgeModelOverride: args.judgeModel } : {}),
      ...(flowPairwise ? { pairwise: pairwiseFor(spec.c) } : {}),
    }),
    ...(deps.now ? { now: deps.now } : {}),
  });
  const baselineIds = [...new Set(cases.map((c) => prep.baseline(c).appVersion))].sort();

  // The dry run's estimate: eval's cost function on eval's basis exactly (hillclimb runs excluded), so every
  // covered key means the same on both commands.
  // This machine's run index, read once: the dry run's estimate and the ceiling warning below.
  let indexCache: RunIndexRow[] | undefined;
  const indexRows = (): RunIndexRow[] => (indexCache ??= (deps.indexRows ?? (() => readIndex(runsWriteRoot())))());

  // A scenario whose longest recorded run outlasts the ceiling would end every rep as a timeout row: say so first.
  if (args.timeoutS > 0)
    for (const c of selected) {
      const longest = Math.max(
        0,
        ...indexRows()
          .filter((r) => r.scenario === c.scenario.name && typeof r.durationMs === "number")
          .map((r) => r.durationMs!),
      );
      if (longest > args.timeoutS * 1000)
        say(
          `[${v}] warning: ${c.scenario.name}'s longest recorded run took ${Math.round(longest / 1000)}s, over --timeout-s ${args.timeoutS}: its reps may end as timeout rows — raise --timeout-s`,
        );
    }

  const price: Prepared["price"] = (remaining) => {
    const rows = indexRows();
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
    derivedValues: prep.derivedValues,
    hiddenPaths: (cs) => [...prep.hiddenPaths(cs), runsRoot],
    // The declared mounts (the live plugin among them) and the snapshot the runs actually mount.
    mountRoots: (cs) => [...new Set([...prep.mountRoots(cs), pluginDir])],
    lever: live,
    ...(flowPairwise ? { pairwise: { metricRefs: metricRefNames(refs) } } : {}),
    // A baseline pass freezes the flow's baseline reference for every selected pairwise case that has none, from the
    // case's LOWEST-REP good row — the rule `hillclimb freeze-ref` applies. A resumed pass with no new rows repairs
    // a missing one the same way. Only "no good row" (or a refused freeze) is a failure.
    ...(flowPairwise && v === BASELINE_REF
      ? {
          afterPass: ({ flowAbs, cases: selected, results }) => {
            const lines: string[] = [];
            let failures = 0;
            for (const c of selected) {
              if (!(c.scenario.assert ?? []).some((a) => a.semantic_pairwise !== undefined)) continue;
              const o = freezeCaseRef({
                flowAbs,
                variant: BASELINE_REF,
                caseId: c.id,
                scenarioFile: c.file,
                assertions: c.scenario.assert,
                prompt: c.scenario.prompt,
                results,
                secrets: [...deps.secrets],
                command: "hillclimb run",
              });
              if (o.status === "exists") continue;
              if (o.status === "refused") {
                failures++;
                lines.push(
                  `  [${v}] ${c.id}: the baseline reference was not frozen — ${o.message}` +
                    (o.restart
                      ? ""
                      : `; repair with \`hillclimb freeze-ref ${args.target} --flow ${flowArg} --variant baseline --case ${c.id}\``),
                );
              } else lines.push(`  [${v}] ${c.id}: froze the baseline reference from rep ${o.rep}`);
            }
            return { lines, failures };
          },
        }
      : {}),
    expectedContentSig: (c) => sigs.get(c.id),
    ...(tracked.name !== undefined ? { skillTracked: tracked.id } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.tickMs !== undefined ? { tickMs: deps.tickMs } : {}),
  };
  return { runner, price, skill: args.skill !== undefined ? tracked.name : undefined };
}
