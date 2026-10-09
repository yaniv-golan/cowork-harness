// `hillclimb run`: the runner-scaffold.mjs contract (bundle 2.1.285) over the harness's own job runner.
//
// The order of the scaffold's main() is kept: refuse everything refusable before any spend (flags, id space, flow-dir
// hygiene, `_state.json`, the harness gate, split ids), then run every missing (case, rep) through a bounded
// pool, appending each row as it completes, and exit 0 (every attempt scored) / 1 (any failed attempt, or a
// mid-run stop) / 2 (refused before spending). stdout stays silent; every line goes to stderr, stripped of
// terminal escapes (model-influenced text reaches it).
//
// The job runner is injected: this module never spawns an agent. The CLI's real runner builds each JobReport
// from a kept run dir; tests pass recorded excerpts.

import { basename, dirname, join, resolve } from "node:path";
import { InterruptedError } from "../termination.js";
import { createHash } from "node:crypto";
import { UsageError } from "../errors.js";
import { pMapBounded } from "../async-pool.js";
import type { RunResult } from "../types.js";
import type { HillclimbRunArgs } from "./args.js";
import { loadCases, selectCases, splitIdNotes, type HillclimbCase } from "./cases.js";
import type { PairwiseDecls } from "./grade-keys.js";
import { FlowWriter, flowHashOf, redactDeep, slotsIn } from "./flow.js";
import { FsRefusal, NoFollowRoot, lexists, normalizeRootArg } from "./fs.js";
import { approvedHarnessSkill, flowHarnessDigest, gateDecision, harnessChangeText, listedInside } from "./gate.js";
import { attemptRow, type AttemptContext } from "./rows.js";
import { flowMetricUnion, refuseChangedMetrics, removedMetrics, staleAssertSigRows, undeclaredRowMetrics } from "./metric-keys.js";
import { turnsFromEvents, type ChildTranscript } from "./trace.js";
import { pathsInsideMounts } from "./answer-key.js";
import { asFlowData, attachmentKind, authoredOutputs, planInputCopy, planOutputCopy } from "./outputs.js";
import { headroom, pairwiseHints } from "./check.js";
import { loadFlowSnapshot } from "./schema-check.js";
import { hillclimbRunLabel } from "../run/run-labels.js";
import { normalizeModelId } from "../run/model-provenance.js";
import { servedModelMismatch } from "./served-model.js";
import { billingOf, costLine, costSummary, otherModelShareWarning, type Billing } from "./cost.js";

/** What one job hands back. */
export interface JobReport {
  result?: RunResult;
  thrown?: unknown;
  /** The run's events.jsonl lines. */
  events: string[];
  /** The agent's own main session transcript lines (the effort each main-loop call was sent with); absent when the
   *  run kept none. */
  transcript?: string[];
  /** The transcript file read, or where it was looked for when none was found. */
  transcriptWhere?: string;
  children: ChildTranscript[];
  /** The trace's system turn (marker + the append as sent); absent ⇒ no system turn. */
  system?: string;
  /** The sub-agent append the session sent; absent ⇒ none was sent. */
  subagentAppend?: string;
  attemptS: number;
  runnerTimeout: boolean;
  runDir?: string;
  skillInvoked?: boolean;
}

export interface JobSpec {
  c: HillclimbCase;
  rep: number;
  variant: string;
  runLabel: string;
  timeoutS: number;
  /** The null run: the skill removed. */
  ablate: boolean;
}

export interface RunnerDeps {
  cwd: string;
  secrets: readonly string[];
  stderr: (line: string) => void;
  virtual: { harnessVersion: string; baselineId: string };
  runJob: (job: JobSpec) => Promise<JobReport>;
  /** The concrete model a case's main loop must be served by. */
  pin: (c: HillclimbCase) => string | undefined;
  /** The effort a case's agent is asked for (the resolved `--effort` / session `effort:` / baseline default), and
   *  whether its model has no effort selector (then the agent may send none). Required, so no caller skips the
   *  requested-vs-sent check by omission. */
  requestedEffort: (c: HillclimbCase) => { effort: string; noSelector: boolean };
  /** The credential-precedence keys (CREDENTIAL_PRECEDENCE_ENV_KEYS) a case's tier spawns the agent with: its
   *  baseline's spawn env, or the operator's env at protocol. Required: the row's billing basis depends on them. */
  credentialEnv: (c: HillclimbCase) => Readonly<Record<string, string>>;
  /** Every file that defines the measurement (scenario, session, answers, uploads) — the gate's derived set. */
  derivedPaths: (cases: readonly HillclimbCase[]) => string[];
  /** Named values the gate hashes beside the derived files: what a file's bytes leave out (a fixture's exec bits). */
  derivedValues?: (cases: readonly HillclimbCase[]) => Record<string, string>;
  /** The files the agent must not read (scenarios, session files); `derivedPaths` when absent. Uploads are in the
   *  gate's set but are inputs: an upload is a mount by design. */
  hiddenPaths?: (cases: readonly HillclimbCase[]) => string[];
  /** Host roots the agent can read through a mount (folders, projects, uploads, plugins, skills). */
  mountRoots: (cases: readonly HillclimbCase[]) => string[];
  /** A case's session uploads (absolute host paths), copied under `<flow>/inputs/` and attached to its rows. */
  inputs?: (c: HillclimbCase) => string[];
  /** The live plugin dir the loop edits; a `harness_paths` entry inside it is refused. */
  lever?: string;
  /** The variant snapshot's content signature for a case (each scenario's session fingerprints apart). */
  expectedContentSig?: (c: HillclimbCase) => string | undefined;
  /** The registered skill id this pass's `skill_invoked` is measured against (`<plugin>:<name>`), recorded on every
   *  scored row as `meta.skill_tracked`; absent when the column is omitted. */
  skillTracked?: string;
  /** Set when any case has `semantic_pairwise`: the later variants' references this pass judges against, so every
   *  row carries one win column per reference. */
  pairwise?: PairwiseDecls;
  /** Printed once per pass, after the first attempt the agent could not authenticate (failure rule `auth`): where
   *  credentials come from at that case's tier and how to check them. */
  authHint?: (c: HillclimbCase) => string;
  /** After the pool, before the summary: work over the pass's written rows (a baseline pass freezes the flow's
   *  pairwise references). Returns the lines to print and how many of them are failures — a step's failure, not a
   *  slot's: it fails the pass (exit 1) but is never counted in `failed`, which counts (case, rep) slots. Not called
   *  on a dry run. */
  afterPass?: (pass: { variant: string; flowAbs: string; cases: readonly HillclimbCase[]; results: string | null }) => {
    lines: string[];
    failures: number;
  };
  /** Progress interval; the scaffold uses 30 s. */
  tickMs?: number;
  now?: () => number;
}

export interface RunOutcome {
  exitCode: 0 | 1 | 2;
  scheduled: number;
  ok: number;
  /** Failed (case, rep) slots: an error row, or a scored row whose later writes failed. A failed step after the pool
   *  (the reference freeze, summary.json) exits 1 without counting here. */
  failed: number;
  /** Rows appended to results.jsonl this pass — an attempt whose later writes failed is still scored. */
  scored?: number;
  /** Why the pass refused (exit 2) or stopped mid-run (exit 1): the JSON envelope's `error.message`. */
  error?: { category: "usage" | "runtime"; message: string };
  /** A dry run's remaining (case, rep) slots per case id — what the pass would run. */
  remaining?: Record<string, number>;
}

// runner-scaffold.mjs l.46-53: strip escape sequences and control characters from anything printed — case ids and error text
// can carry model output.
const ESC_SEQ = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]/g;
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;
export const termSafe = (s: string): string => s.replace(ESC_SEQ, "").replace(CONTROL, "");

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Output-copy caps: one file, and every file of one rep. */
const OUTPUT_CAPS = { perFileBytes: 2 * 1024 * 1024, totalBytes: 20 * 1024 * 1024 };

export async function runHillclimb(args: HillclimbRunArgs, deps: RunnerDeps): Promise<RunOutcome> {
  const say = (line: string) => deps.stderr(termSafe(line));
  const now = deps.now ?? Date.now;
  let started = false;
  try {
    return await run(args, deps, say, now, () => {
      started = true;
    });
  } catch (e) {
    if (e instanceof InterruptedError) throw e; // the operator's interrupt, learned from a probe: exit as interrupted
    // runner-scaffold.mjs l.591-602: before the workers start, anything thrown is a refusal (exit 2); after, a mid-run stop.
    if (started) {
      const m = `stopped mid-run (rows already written are kept; re-run to resume): ${message(e)}`;
      say(m);
      return { exitCode: 1, scheduled: 0, ok: 0, failed: 0, error: { category: "runtime", message: m } };
    }
    if (e instanceof UsageError || e instanceof FsRefusal || e instanceof Error) {
      const m = message(e);
      const line = m.startsWith("refusing") ? m : `refusing to run: ${m}`;
      say(line);
      return { exitCode: 2, scheduled: 0, ok: 0, failed: 0, error: { category: "usage", message: line } };
    }
    throw e;
  }
}

async function run(
  args: HillclimbRunArgs,
  deps: RunnerDeps,
  say: (l: string) => void,
  now: () => number,
  markStarted: () => void,
): Promise<RunOutcome> {
  const v = args.variant;
  const flowArg = normalizeRootArg(args.flow);
  // resolve, never join: an absolute --flow or target is supported (runner-scaffold.mjs l.365-371) and join would graft it onto cwd.
  const flowAbs = resolve(deps.cwd, flowArg);
  const statePathShown = join(flowArg, "_state.json");

  // The whole case set: the id space, the split ids and the gate are judged on it, whatever --case selects.
  const { cases: all, skipped } = loadCases(resolve(deps.cwd, args.target));
  if (skipped.length) say(`[${v}] skipped ${skipped.length} non-scenario file(s): ${skipped.join(", ")}`);
  // The flow's metric columns: the union over every case, refused here — before any write — when one id is declared two ways.
  const metrics = flowMetricUnion(all);
  // ...and against the rows already in the flow, in every variant, before the gate can record an approval.
  const existing = existingFlowSnapshot(flowArg, deps.cwd);
  if (existing) refuseChangedMetrics(existing, metrics);

  // Writes only when this run may write: a pass, or the human's --approve-harness. A plain --dry-run
  // creates nothing.
  const writes = !args.dryRun || args.approveHarness;
  const w = writes ? FlowWriter.open(flowArg, v, { cwd: deps.cwd, secrets: deps.secrets }) : undefined;
  const state = w ? w.state() : readStateIfPresent(flowArg, deps.cwd);

  for (const note of splitIdNotes(
    state,
    all.map((c) => c.id),
  ))
    say(note);

  if (existing)
    for (const [id, vs] of removedMetrics(existing, metrics))
      say(
        `warning: metric ${id} is no longer declared by any scenario: the rows in ${vs.join(", ")} keep its values, but new rows will not carry it — remove its entries (${id} and ${id}_present) from _state.json's metrics (declaring it again with a different declaration is refused while any row still carries the old declaration)`,
      );
  if (existing)
    for (const [id, vs] of undeclaredRowMetrics(existing, state.metrics))
      say(
        `warning: rows in ${vs.join(", ")} carry metric ${id}, which _state.json's metrics does not declare — re-run \`hillclimb state-template\` and merge its new metrics entries, or the report cannot show it`,
      );

  const cases = selectCases(all, args.cases);
  // Rows graded under another assertion set than the scenario's now (an approved scenario edit): a resumed pass writes new
  // rows beside them, so warn — never refuse: a row whose run dir is gone could never be brought current.
  const stale = existing ? staleAssertSigRows(existing, cases) : [];
  if (stale.length) {
    const ids = [...new Set(stale.map((r) => r.promptId))];
    const shown = stale.slice(0, 5).map((r) => `${r.variant} ${r.promptId} rep${r.rep}`);
    say(
      `warning: ${stale.length} row(s) were graded under another assertion set than their scenario's now (${shown.join(", ")}${stale.length > shown.length ? `, and ${stale.length - shown.length} more` : ""}): a comparison over them and this pass's rows mixes two graders — run \`hillclimb regrade ${args.target} --flow ${flowArg}${ids.map((id) => ` --case ${id}`).join("")}\` to re-evaluate them (a scenario edited since the flow's last approval also needs --approve-harness on it, which is the user's to give, as on run)`,
    );
  }
  const sigOf = (c: HillclimbCase) => deps.expectedContentSig?.(c);
  // One signature for the variant: over every case's (all cases, so a --case subset records the same one).
  const caseSigs = all.map((c) => `${c.id}\0${sigOf(c) ?? ""}`).sort();
  const variantSig = all.some((c) => sigOf(c) !== undefined) ? createHash("sha256").update(caseSigs.join("\n")).digest("hex") : undefined;

  // Everything that can refuse runs before --approve-harness writes anything: a refused run records no approval.
  // Ground truth must be unreachable from the agent (eval-hillclimb.md l.215): no mount may expose the flow dir (prior grades,
  // judge rationales) or a file that defines the answer.
  const listedRaw = Array.isArray(state.harness_paths) ? state.harness_paths.map(String) : [];
  // The loop edits the plugin by design: a harness path inside it would stop every round for approval.
  const inLever = deps.lever !== undefined ? listedInside(deps.cwd, listedRaw, deps.lever) : [];
  if (inLever.length)
    throw new UsageError(
      `${statePathShown} harness_paths lists ${inLever.join(", ")}, inside the plugin the loop edits (${deps.lever}) — every round would change the harness sha; list only files that define the measurement`,
    );
  // A listed entry the agent is MEANT to read (an upload, a fixture file: derived, not hidden — state-template lists
  // them) is no exposure, and nor is one that no longer exists (the digest skips it); every other listed file is.
  const hidden = (deps.hiddenPaths ?? deps.derivedPaths)(all);
  const hiddenSet = new Set(hidden.map((p) => resolve(p)));
  const inputs = new Set(
    deps
      .derivedPaths(all)
      .map((p) => resolve(p))
      .filter((p) => !hiddenSet.has(p)),
  );
  const listed = listedRaw.map((p) => resolve(deps.cwd, p)).filter((p) => !inputs.has(p) && lexists(p));
  // The hidden files are EVERY case's, whatever --case selects: a sibling scenario reachable through a selected case's
  // mount is still the flow's answer key. The mounts are the selected cases': only theirs exist in this pass.
  const exposed = pathsInsideMounts([flowAbs, ...hidden, ...listed], deps.mountRoots(cases));
  if (exposed.length)
    throw new UsageError(
      `refusing to run: the agent could read ${exposed.map((x) => `${x.path} (through the mount ${x.mount})`).join("; ")} — prior rounds' grades, judge rationales and the rubric must stay outside every folder the session mounts`,
    );

  // A null (--ablate) run belongs in its own flow: mixed into a scored flow it would enter the trajectory.
  // The rows read once, before any write (a flow dir created since has no rows).
  if (existing) {
    const mixed = ablationMix(existing, args.ablate);
    if (mixed)
      throw new UsageError(
        `--ablate ${args.ablate ? "into a flow that holds scored rows" : "rows are in this flow"}: ${mixed} — run the null baseline into a sibling flow (e.g. <flow>-null)`,
      );
    // skill_invoked means "invoked the tracked skill": within a variant, every row must mean the same skill. Across
    // variants a switch is allowed (re-approved through the gate) but said, as the report puts them in one column.
    // A row with no `meta.skill_tracked` does not say what it tracked (none, or a row written before the field
    // existed, whose skill_invoked was measured): only a recorded skill is held against this pass.
    const tracked = skillTrackedByVariant(existing);
    const mine: Tracked = deps.skillTracked ?? NONE;
    const own = tracked.get(v);
    if (own !== undefined && [...own].some((t) => t !== UNRECORDED && t !== mine))
      throw new UsageError(
        `variant ${v}'s rows track ${trackedText(new Set([...own].filter((t) => t !== UNRECORDED)))}, and this pass would track ${trackedText(new Set([mine]))}: one column would mix two skills — run the switch as a new variant, or keep the --skill the rows were run with`,
      );
    if (own?.has(UNRECORDED) && mine !== NONE)
      say(
        `warning: variant ${v}'s earlier rows don't record which skill they tracked, and this pass tracks ${mine} — its skill_invoked column may mix measurements; compare it only knowingly`,
      );
    tracked.set(v, new Set([...(own ?? []), mine]));
    // Per variant, what its column measured: the skills its rows (and this pass) name, else none. Unrecorded rows
    // name no skill a recorded one could disagree with, so they add nothing to a variant that names one.
    const measured = (s: ReadonlySet<Tracked>): string =>
      [...s]
        .filter((t) => t !== NONE && t !== UNRECORDED)
        .sort()
        .join("\0");
    if (new Set([...tracked.values()].map(measured)).size > 1)
      say(
        `warning: the flow's variants track different skills in skill_invoked (${[...tracked]
          .sort(([a], [b]) => variantOrder(a) - variantOrder(b))
          .map(([name, s]) => `${name}: ${trackedText(s)}`)
          .join("; ")}) — compare that column across them only knowingly`,
      );
  }

  // One variant, one requested model and effort per case: a resumed pass that would ask for another fills the case's
  // remaining slots with a different setting. Refused before spend; across variants a change is the lever, unsaid.
  if (existing) {
    const mix = requestedMix(
      existing,
      v,
      cases,
      (c) => ({ model: deps.pin(c), effort: deps.requestedEffort(c).effort, noSelector: deps.requestedEffort(c).noSelector }),
      {
        effortFlag: args.effort !== undefined,
        modelFlag: args.model !== undefined,
      },
    );
    if (mix.refusals.length)
      throw new UsageError(
        `${mix.refusals.join("; ")} — one variant would mix two settings: run the change as a new variant (--variant v<N>), or keep the setting the rows ran with`,
      );
    for (const w of mix.warnings) say(w);
  }

  // The harness gate (runner-scaffold.mjs l.238-277). A --skill selection joins the digest as `skill:<name>`: it
  // decides what skill_invoked means, so changing it is a harness change. Without one nothing is added and the sha
  // is the one a flow approved before --skill existed.
  const digestFor = (skill: string | undefined) =>
    flowHarnessDigest({
      cwd: deps.cwd,
      state,
      derived: deps.derivedPaths(all),
      ...(deps.derivedValues ? { derivedValues: deps.derivedValues(all) } : {}),
      harnessVersion: deps.virtual.harnessVersion,
      baselineId: deps.virtual.baselineId,
      ...(skill !== undefined ? { skill } : {}),
    });
  const digest = digestFor(args.skill);
  for (const s of digest.skipped) say(`warning: harness path '${s.path}' not readable (${s.code}) - skipped`);
  const decision = gateDecision(state, digest.sha, args.approveHarness);
  // The sha alone cannot name the skill it was approved with: `harness_skill`, recorded beside it on approval,
  // can. Re-hashing under that selection tells a selection-only change from one where the files moved too.
  const approvedSkill = approvedHarnessSkill(state);
  const skillChange = (): { cause: string; filesToo: boolean } | undefined => {
    if (approvedSkill === args.skill) return undefined;
    const cause =
      approvedSkill === undefined
        ? `--skill added (${args.skill})`
        : args.skill === undefined
          ? `--skill removed (was ${approvedSkill})`
          : `tracked skill ${approvedSkill} → ${args.skill}`;
    return { cause, filesToo: digestFor(approvedSkill).sha !== state.harness_sha };
  };
  if (args.dryRun && !args.approveHarness) {
    const change = decision.kind === "mismatch" ? skillChange() : undefined;
    const why = change ? `: ${change.cause}${change.filesToo ? ", and the hashed files changed too" : ""}` : "";
    // A mismatch names what changed first (as the refusal does); approved or absent shows everything the sha covers.
    const detail =
      decision.kind === "mismatch"
        ? `${harnessChangeText(state, digest)}; sha256 ${digest.sha.slice(0, 12)}`
        : `sha256 ${digest.sha.slice(0, 12)} over: ${digest.hashed.join(", ")}`;
    say(`harness gate: ${decision.kind === "ok" ? "approved" : decision.kind}${why} (${detail})`);
  } else if (decision.kind !== "ok") {
    if (!digest.lockfiles.length) say("note: no lockfile in the current directory - dependency changes are outside the harness sha");
    if (decision.kind === "approve") {
      w!.approveHarness(digest.sha, { skill: args.skill, files: digest.entries });
      say(`harness approved: sha256 ${digest.sha.slice(0, 12)} over ${digest.hashed.length} file(s) recorded in ${statePathShown}`);
    } else if (decision.kind === "absent") {
      const m = `no approved harness sha in ${statePathShown} (computed ${digest.sha.slice(0, 12)} over: ${digest.hashed.join(", ")}).`;
      const fix = "Review the harness, then run once with --approve-harness to record it.";
      say(m);
      say(fix);
      return { exitCode: 2, scheduled: 0, ok: 0, failed: 0, error: { category: "usage", message: `${m} ${fix}` } };
    } else {
      const shas = `approved ${String(state.harness_sha).slice(0, 12)}, now ${digest.sha.slice(0, 12)}`;
      const files = harnessChangeText(state, digest);
      let m: string;
      let fix = "Re-run with --approve-harness after reviewing the diff.";
      const change = skillChange();
      if (change === undefined) m = `harness changed since last approved run (${files}); ${shas}.`;
      else if (!change.filesToo) {
        m = `harness changed since last approved run: ${change.cause}; ${shas}.`;
        fix = "Re-run with --approve-harness if intended.";
      } else m = `harness changed since last approved run: ${change.cause}, and the hashed files changed too (${files}); ${shas}.`;
      say(m);
      say(fix);
      return { exitCode: 2, scheduled: 0, ok: 0, failed: 0, error: { category: "usage", message: `${m} ${fix}` } };
    }
  }

  // The lock is taken BEFORE the resume set is read: two runners must not both see a slot as free.
  const release = args.dryRun ? () => {} : w!.lock();
  try {
    // A dry run reads the same rows a pass would (read-only), so its scope matches what the pass will run.
    const results = w ? w.readVariantFile("results.jsonl") : readVariantFileIfPresent(flowArg, v, "results.jsonl", deps.cwd);
    const errors = w ? w.readVariantFile("errors.jsonl") : readVariantFileIfPresent(flowArg, v, "errors.jsonl", deps.cwd);
    const done = slotsIn(results);
    const tasks: Array<{ c: HillclimbCase; rep: number }> = [];
    for (const c of cases) for (let rep = 0; rep < args.reps; rep++) if (!done.has(`${c.id}\0${rep}`)) tasks.push({ c, rep });
    say(`[${v}] ${tasks.length} of ${cases.length * args.reps} (id,rep) to run`);
    // Error slots re-run on every pass (the scaffold's semantics); a permanent infra fault re-runs forever, so name them.
    const failedBefore = slotsIn(errors);
    const rerun = tasks.filter((t) => failedBefore.has(`${t.c.id}\0${t.rep}`));
    if (rerun.length)
      say(`[${v}] ${rerun.length} slot(s) re-run after a failed attempt: ${rerun.map((t) => `${t.c.id} rep${t.rep}`).join(", ")}`);
    if (args.dryRun) {
      const remaining: Record<string, number> = {};
      for (const t of tasks) remaining[t.c.id] = (remaining[t.c.id] ?? 0) + 1;
      return { exitCode: 0, scheduled: tasks.length, ok: 0, failed: 0, remaining };
    }

    const writer = w!;
    let ok = 0;
    let scored = 0;
    // `fail` counts failed slots only; a step after the pool that fails (the reference freeze, summary.json) fails the
    // pass through `stepFailures`, reported on its own line, so one failed slot never reads as two.
    let fail = 0;
    let stepFailures = 0;
    let authHinted = false;
    const t0 = now();
    const progress = () => {
      const n = ok + fail;
      const el = (now() - t0) / 1000;
      const eta = n ? Math.round((el / n) * (tasks.length - n)) : null;
      const line = `[${v}] ${n}/${tasks.length} done (${ok} ok, ${fail} failed), ${Math.round(el)}s elapsed${eta !== null ? `, ~${eta}s left` : ""}`;
      say(line);
      try {
        writer.writeProgress(line);
      } catch {
        /* runner-scaffold.mjs l.581: progress is best-effort */
      }
    };
    const tick = setInterval(progress, deps.tickMs ?? 30_000);
    const runLabel = hillclimbRunLabel(flowArg, v);
    const flowHash = flowHashOf(flowAbs);
    const models = new Set<string>();
    markStarted();
    // A failure to WRITE (a row, an error row) stops the pass: the scaffold's process exits there (l.597-599). Here the
    // pool cannot be killed, so a stop flag keeps every later task from starting, and the pool is awaited —
    // in-flight jobs finish — before the lock is released. Nothing else escapes a task.
    let stopError: unknown;
    try {
      await pMapBounded(tasks, args.concurrency, async ({ c, rep }) => {
        if (stopError !== undefined) return;
        try {
          await oneTask(c, rep);
        } catch (e) {
          stopError ??= e;
        }
      });
    } finally {
      clearInterval(tick);
    }
    // The operator's interrupt, learned from a probe inside a job: in-flight jobs have finished; exit as interrupted.
    if (stopError instanceof InterruptedError) {
      progress();
      throw stopError;
    }
    if (stopError !== undefined) {
      progress();
      const m = `stopped mid-run (rows already written are kept; re-run to resume): ${message(stopError)}`;
      say(m);
      return { exitCode: 1, scheduled: tasks.length, ok, failed: fail, scored, error: { category: "runtime", message: m } };
    }
    async function oneTask(c: HillclimbCase, rep: number): Promise<void> {
      const tStart = now();
      let report: JobReport;
      try {
        report = await deps.runJob({ c, rep, variant: v, runLabel, timeoutS: args.timeoutS, ablate: args.ablate });
      } catch (e) {
        // An interrupt stops the whole run; it is not this attempt's failure.
        if (e instanceof InterruptedError) throw e;
        report = { thrown: e, events: [], children: [], attemptS: (now() - tStart) / 1000, runnerTimeout: false };
      }
      const ctx: AttemptContext = {
        caseId: c.id,
        ...(c.originalId !== undefined ? { originalId: c.originalId } : {}),
        scenarioName: c.name,
        prompt: c.scenario.prompt,
        assertions: c.scenario.assert,
        expectDenied: c.scenario.expect_denied ?? [],
        metrics,
        ...(deps.pairwise ? { pairwise: deps.pairwise } : {}),
        rep,
        pin: deps.pin(c),
        requestedEffort: deps.requestedEffort(c),
        credentialEnv: deps.credentialEnv(c),
        ...(sigOf(c) !== undefined ? { expectedContentSig: sigOf(c)! } : {}),
        events: report.events,
        ...(report.transcript !== undefined ? { transcript: report.transcript } : {}),
        ...(report.transcriptWhere !== undefined ? { transcriptWhere: report.transcriptWhere } : {}),
        attemptS: report.attemptS,
        runnerTimeout: report.runnerTimeout,
        tags: [basename(dirname(c.file))],
        ...(report.skillInvoked !== undefined ? { skillInvoked: report.skillInvoked } : {}),
        meta: {
          flowHash,
          env: deps.virtual,
          ...(report.runDir !== undefined ? { runDir: report.runDir } : {}),
          ...(sigOf(c) !== undefined ? { contentSig: sigOf(c)! } : {}),
          // The skill hash the run itself staged (evidence), not one recomputed here.
          ...(typeof report.result?.fingerprint?.skillHash === "string" ? { skillHash: report.result.fingerprint.skillHash } : {}),
          ...(deps.skillTracked !== undefined ? { skillTracked: deps.skillTracked } : {}),
          ...(args.ablate ? { ablated: true } : {}),
          ...(c.scenario.on_unanswered === "llm" ? { nonDeterministic: true } : {}),
        },
      };
      let out: ReturnType<typeof attemptRow>;
      try {
        out = attemptRow(
          { ...(report.result ? { result: report.result } : {}), ...(report.thrown !== undefined ? { thrown: report.thrown } : {}) },
          ctx,
        );
      } catch (e) {
        // A row that cannot be built is this attempt's failure, not the pass's.
        out = {
          dest: "errors",
          row: {
            prompt_id: c.id,
            rep,
            ...(c.originalId !== undefined ? { original_id: c.originalId } : {}),
            failure_class: "error",
            error: `could not build the row: ${message(e)}`,
            retries: 0,
            judge_retries: 0,
            latency_s: report.attemptS,
            // The attempt's spend stays countable; counters it could not report are said, not zeroed.
            meta: {
              failure_rule: "row_build",
              // What the attempt asked for, as on every other error row.
              ...(ctx.pin !== undefined ? { model_requested: ctx.pin } : {}),
              ...(ctx.requestedEffort !== undefined ? { effort: ctx.requestedEffort.effort } : {}),
              ...(ctx.requestedEffort?.noSelector ? { effort_selector: false } : {}),
              retries_unrecorded: true,
              judge_retries_unrecorded: true,
              ...(typeof report.result?.cost?.usd === "number" ? { cost_usd: report.result.cost.usd } : {}),
              ...(typeof report.result?.deciderCostUsd === "number" ? { decider_usd: report.result.deciderCostUsd } : {}),
              ...fallbackBilling(report, ctx),
              ...(report.runDir !== undefined ? { run_dir: report.runDir, run_id: basename(report.runDir) } : {}),
            },
          },
        };
      }
      if (out.dest === "errors") {
        fail++;
        writer.appendError(out.row);
        say(`  [${v}] ${c.stem} rep${rep} FAILED: ${String(out.row.error)}`);
        if (!authHinted && deps.authHint && (out.row.meta as Record<string, unknown> | undefined)?.failure_rule === "auth") {
          authHinted = true;
          say(`  [${v}] ${deps.authHint(c)}`);
        }
        return;
      }
      // The session's uploads: attached to the row now, copied after it (unless --no-copy-inputs).
      const uploads = deps.inputs?.(c) ?? [];
      let inputs: ReturnType<typeof planInputCopy> | undefined;
      if (uploads.length && args.noCopyInputs) (out.row.meta as Record<string, unknown>).inputs_not_copied = true;
      else if (uploads.length) {
        inputs = planInputCopy(uploads, OUTPUT_CAPS);
        if (inputs.copy.length) out.row.attachments = inputs.copy.map((i) => ({ kind: attachmentKind(i.name), ref: `inputs/${i.name}` }));
        if (inputs.skipped.length) (out.row.meta as Record<string, unknown>).inputs_skipped = inputs.skipped;
      }
      // The trace is built (pure) BEFORE the row, so the row can say how complete it is; only the writes
      // come after the row (runner-scaffold.mjs l.529-547).
      const prefix = `${v}/out/${c.id}_rep${rep}/blobs/`;
      let trace: ReturnType<typeof turnsFromEvents> | undefined;
      let traceError: unknown;
      let outputs: ReturnType<typeof planOutputCopy> | undefined;
      try {
        trace = turnsFromEvents({
          events: report.events,
          prompt: c.scenario.prompt,
          system: report.system,
          ...(report.subagentAppend !== undefined ? { subagentAppend: report.subagentAppend } : {}),
          children: report.children,
          sidecarPrefix: prefix,
          redact: (t) => redactDeep(t, deps.secrets),
        });
        (out.row.meta as Record<string, unknown>).subagent_turns = trace.subagentTurns;
        // The files the run authored: attached to the final assistant turn now, copied after the row.
        if (report.result?.workDir) {
          outputs = planOutputCopy(report.result.workDir, authoredOutputs(report.result), OUTPUT_CAPS);
          const filesPrefix = `${v}/out/${c.id}_rep${rep}/files/`;
          const last = [...trace.turns].reverse().find((t) => t.role === "assistant");
          if (last && outputs.copy.length)
            last.attachments = outputs.copy.map((o) => ({ kind: attachmentKind(o.rel), ref: filesPrefix + o.rel }));
          if (outputs.skipped.length) (out.row.meta as Record<string, unknown>).outputs_skipped = outputs.skipped;
        }
      } catch (e) {
        traceError = e;
      }
      writer.appendResult(out.row);
      scored++;
      if (typeof out.row.model === "string") models.add(out.row.model);
      // Past this point the attempt is scored: a failed post-row write counts as failed but writes no error
      // row, which would double-count its spend (runner-scaffold.mjs l.529, 541-548).
      try {
        if (traceError !== undefined) throw traceError;
        for (const s of trace!.sidecars) writer.writeUnderFlow(prefix + s.name, s.data);
        for (const i of inputs?.copy ?? []) writer.writeUnderFlow(`inputs/${i.name}`, asFlowData(i.data));
        // Text is redacted like every other byte in the flow; a binary is copied as it is.
        for (const o of outputs?.copy ?? []) writer.writeUnderFlow(`${v}/out/${c.id}_rep${rep}/files/${o.rel}`, asFlowData(o.data));
        writer.writeTrace(c.id, rep, trace!.turns);
        ok++;
      } catch (e) {
        fail++;
        say(`  [${v}] ${c.stem} rep${rep} scored, but a post-row write failed: ${message(e)}`);
      }
    }
    progress();
    // After the pool the rows are on disk: a failure here is reported but never loses the pass's counts.
    if (deps.afterPass && w)
      try {
        const r = deps.afterPass({ variant: v, flowAbs, cases, results: w.readVariantFile("results.jsonl") });
        for (const line of r.lines) say(line);
        stepFailures += r.failures;
      } catch (e) {
        stepFailures++;
        say(`[${v}] the pass finished, but its post-pass step failed: ${message(e)}`);
      }
    try {
      writer.mergeSummary({
        ...(models.size === 1 ? { model: [...models][0] } : {}),
        ...(variantSig !== undefined ? { source_sig: variantSig } : {}),
      });
      // What the variant's rows asked for and were sent, over its whole results.jsonl (a --case pass adds to it).
      writer.setSummaryKeys(requestedSummary(writer.readVariantFile("results.jsonl")));
      // The variant's spend: printed before the `done` line, which stays the pass's last line (the scaffold's).
      for (const line of writeCostSummary(writer, v)) say(line);
      if (v === "baseline") for (const line of headroom(loadFlowSnapshot(flowAbs), all).warnings) say(line);
    } catch (e) {
      stepFailures++;
      say(`[${v}] the pass finished, but writing summary.json or the headroom report failed: ${message(e)}`);
    }
    // The second-reference hint is advice: a flow read it cannot make (a concurrent freeze's temp dir vanishing
    // mid-walk) is never a failed pass.
    try {
      for (const line of pairwiseHints(loadFlowSnapshot(flowAbs), flowArg, args.target)) say(line);
    } catch {
      /* warn-only */
    }
    say(`[${v}] done - ${ok} ok, ${fail} failed -> ${join(flowArg, v, "results.jsonl")}`);
    return { exitCode: fail || stepFailures ? 1 : 0, scheduled: tasks.length, ok, failed: fail, scored };
  } finally {
    release();
  }
}

/** The billing of an attempt whose row could not be built: read from its own frames, which do not depend on what threw;
 *  nothing when they cannot be read either. */
function fallbackBilling(report: JobReport, ctx: AttemptContext): { billing?: Billing } {
  try {
    const billing = billingOf({ events: report.events, modelUsage: report.result?.modelUsage, credentialEnv: ctx.credentialEnv });
    return billing !== undefined ? { billing } : {};
  } catch {
    return {};
  }
}

/** Recompute the variant's spend keys in summary.json over its whole results.jsonl + errors.jsonl, and return the lines a
 *  pass prints: the cost line, and the different-model warning when it fires. `hillclimb regrade` calls it too. */
export function writeCostSummary(writer: FlowWriter, variant: string): string[] {
  const results = writer.readVariantFile("results.jsonl");
  const s = costSummary(results, writer.readVariantFile("errors.jsonl"));
  writer.setSummaryKeys(s.keys);
  const warning = otherModelShareWarning(variant, results);
  return [costLine(variant, s), ...(warning !== undefined ? [warning] : [])];
}

/** The flow's files as they stand, read without following a link (undefined when there is no flow dir yet). The
 *  root goes through the same hygiene every flow reader applies, so a planted link there is refused, not entered. */
export function existingFlowSnapshot(flowArg: string, cwd: string): ReturnType<typeof loadFlowSnapshot> | undefined {
  if (!lexists(resolve(cwd, flowArg))) return undefined;
  return loadFlowSnapshot(NoFollowRoot.existing(flowArg, { cwd }).root);
}

export function readStateIfPresent(flowArg: string, cwd: string): Record<string, unknown> {
  if (!lexists(resolve(cwd, flowArg))) return {};
  const r = NoFollowRoot.existing(flowArg, { cwd });
  const text = r.readIfPresent(join(r.root, "_state.json"));
  if (text === null) return {};
  try {
    const st = JSON.parse(text);
    if (st === null || typeof st !== "object" || Array.isArray(st))
      throw new UsageError(`${join(flowArg, "_state.json")} must hold a JSON object`);
    return st;
  } catch (e) {
    if (e instanceof UsageError) throw e;
    throw new UsageError(`${join(flowArg, "_state.json")} exists but is not valid JSON - fix it before spending a pass`);
  }
}

/** What a variant's rows say they tracked: a registered id, NONE (this pass tracks no skill), or UNRECORDED (a row with
 *  no `meta.skill_tracked`: one that tracked none, or one written before the field existed). */
type Tracked = string;
const NONE: Tracked = "";
const UNRECORDED: Tracked = "\0unrecorded";

/** Per variant with scored rows: what its rows' `meta.skill_tracked` says. */
function skillTrackedByVariant(snap: ReturnType<typeof loadFlowSnapshot>): Map<string, Set<Tracked>> {
  const out = new Map<string, Set<Tracked>>();
  for (const [variant, vs] of Object.entries(snap.variants))
    for (const line of (vs.results ?? "").split("\n")) {
      if (!line.trim()) continue;
      try {
        const t = (JSON.parse(line) as { meta?: { skill_tracked?: unknown } }).meta?.skill_tracked;
        const set = out.get(variant) ?? new Set<Tracked>();
        set.add(typeof t === "string" && t !== NONE ? t : UNRECORDED);
        out.set(variant, set);
      } catch {
        /* schema-check reports malformed lines */
      }
    }
  return out;
}

const trackedText = (s: ReadonlySet<Tracked>): string =>
  [...s]
    .sort()
    .map((t) => (t === NONE ? "no skill" : t === UNRECORDED ? "unrecorded" : t))
    .join(" and ");

/** baseline first, then v1, v2, … */
const variantOrder = (v: string): number => (v === "baseline" ? 0 : Number(v.slice(1)));

/** summary.json's `model_requested`, `effort` and `effort_sent` over a variant's scored rows: the one value its rows
 *  carry, `"mixed"` when they carry several, absent when none carries it. `effort_selector: false` when every row's
 *  model has no effort selector (its `effort` was passed but not sent), `"mixed"` when only some do. */
export function requestedSummary(results: string | null): Record<string, string | false | undefined> {
  const seen = { model_requested: new Set<string>(), effort: new Set<string>(), effort_sent: new Set<string>() };
  let rows = 0;
  let noSelector = 0;
  const lacking = { model_requested: 0, effort: 0, effort_sent: 0 };
  for (const line of (results ?? "").split("\n")) {
    if (!line.trim()) continue;
    let meta: Record<string, unknown> | undefined;
    try {
      meta = (JSON.parse(line) as { meta?: Record<string, unknown> }).meta;
    } catch {
      continue; // schema-check reports malformed lines
    }
    rows++;
    if (meta?.effort_selector === false) noSelector++;
    for (const k of Object.keys(seen) as Array<keyof typeof seen>)
      if (typeof meta?.[k] === "string") seen[k].add(meta[k] as string);
      else lacking[k]++;
  }
  // One value over every row; "mixed" when rows carry several, or some carry it and some do not.
  const one = (k: keyof typeof seen) =>
    seen[k].size === 0 ? undefined : seen[k].size === 1 && lacking[k] === 0 ? [...seen[k]][0] : "mixed";
  return {
    model_requested: one("model_requested"),
    effort: one("effort"),
    effort_sent: one("effort_sent"),
    effort_selector: noSelector === 0 ? undefined : noSelector === rows ? false : "mixed",
  };
}

/** The resume guard over one variant's `results.jsonl` and `errors.jsonl` rows, keyed by (variant, prompt_id): pins and sessions are per
 *  case. A row records what it asked for (`meta.model_requested`, `meta.effort`); one that differs from what this pass
 *  asks for its case is a refusal. A row written before those fields existed is held to its SERVED model (a dated
 *  snapshot of the pin is the pin), and warns when it has none; its effort is unknown, which always warns (a
 *  re-approved session file may have changed its `effort:` since). A flag value that differs
 *  from what the variant's OTHER cases ran warns: the variant's cases then ran different settings. */
function requestedMix(
  snap: ReturnType<typeof loadFlowSnapshot>,
  variant: string,
  cases: readonly HillclimbCase[],
  want: (c: HillclimbCase) => { model: string | undefined; effort: string; noSelector: boolean },
  flags: { effortFlag: boolean; modelFlag: boolean },
): { refusals: string[]; warnings: string[] } {
  const byId = new Map(cases.map((c) => [c.id, want(c)]));
  const refusals = new Set<string>();
  const noModel = new Set<string>();
  const noEffort = new Set<string>();
  const others = { model: new Map<string, Set<string>>(), effort: new Map<string, Set<string>>() };
  // errors.jsonl rows count too: a pass whose attempts all failed still asked for its model and effort. Only what a row
  // RECORDS it asked for is held against this pass there — an error row's served model is often the very substitution
  // it reports, and an error row that records nothing says nothing.
  const lines = [
    ...(snap.variants[variant]?.results ?? "").split("\n").map((l) => ({ l, scored: true })),
    ...(snap.variants[variant]?.errors ?? "").split("\n").map((l) => ({ l, scored: false })),
  ];
  for (const { l: line, scored } of lines) {
    if (!line.trim()) continue;
    let r: { prompt_id?: unknown; model?: unknown; meta?: { model_requested?: unknown; effort?: unknown; effort_selector?: unknown } };
    try {
      r = JSON.parse(line);
    } catch {
      continue; // schema-check reports malformed lines
    }
    const id = String(r.prompt_id);
    const mr = typeof r.meta?.model_requested === "string" ? r.meta.model_requested : undefined;
    const ef = typeof r.meta?.effort === "string" ? r.meta.effort : undefined;
    const w = byId.get(id);
    if (w === undefined) {
      // Another case of this variant, not run in this pass.
      if (mr !== undefined) others.model.set(mr, (others.model.get(mr) ?? new Set()).add(id));
      if (ef !== undefined) others.effort.set(ef, (others.effort.get(ef) ?? new Set()).add(id));
      continue;
    }
    if (w.model !== undefined) {
      if (mr !== undefined) {
        if (normalizeModelId(mr) !== normalizeModelId(w.model))
          refusals.add(`variant ${variant}'s rows for case ${id} ran model ${mr}, and this pass would run model ${w.model}`);
      } else if (!scored) {
        /* an error row that records no requested model */
      } else if (typeof r.model === "string") {
        if (servedModelMismatch(w.model, [r.model]) !== undefined)
          refusals.add(`variant ${variant}'s rows for case ${id} ran model ${r.model} (served), and this pass would run model ${w.model}`);
      } else noModel.add(id);
    }
    // A model with no effort selector sends none: its rows' effort is only the baseline default (a sync may move it),
    // so it is not held against a pass whose case has no selector either.
    if (w.noSelector && r.meta?.effort_selector === false) continue;
    if (ef !== undefined) {
      if (ef !== w.effort)
        refusals.add(`variant ${variant}'s rows for case ${id} ran effort ${ef}, and this pass would run effort ${w.effort}`);
    } else if (scored) noEffort.add(id);
  }
  const named = (ids: Iterable<string>) => {
    const xs = [...new Set(ids)].sort();
    return `case${xs.length > 1 ? "s" : ""} ${xs.join(", ")}`;
  };
  const warnings: string[] = [];
  const pinsOf = (ids: Set<string>) => [...new Set([...ids].map((id) => byId.get(id)!.model))].join(", ");
  const effortsOf = (ids: Iterable<string>) => [...new Set([...ids].map((id) => byId.get(id)!.effort))].join(", ");
  if (noModel.size)
    warnings.push(
      `warning: variant ${variant}'s earlier rows for ${named(noModel)} record neither the requested nor the served model; this pass requests ${pinsOf(noModel)} — compare them only knowingly`,
    );
  if (noEffort.size)
    warnings.push(
      `warning: variant ${variant}'s earlier rows for ${named(noEffort)} don't record the requested effort (written before it was recorded): their effort is unknown, and this pass requests ${effortsOf(noEffort)} — compare them only knowingly`,
    );
  // A flag sets every selected case alike: say when the variant's other cases ran something else.
  for (const [what, flag, mine] of [
    ["effort", flags.effortFlag, (c: string) => byId.get(c)!.effort],
    ["model", flags.modelFlag, (c: string) => byId.get(c)!.model ?? ""],
  ] as const) {
    if (!flag) continue;
    const thisPass = new Set([...byId.keys()].map(mine));
    for (const [value, ids] of others[what])
      if (!thisPass.has(value))
        warnings.push(
          `warning: variant ${variant}'s rows for ${named(ids)} ran ${what} ${value}, and this pass runs ${what} ${[...thisPass].join(", ")} for ${named(byId.keys())}: the variant's cases ran different settings — compare across them only knowingly`,
        );
  }
  return { refusals: [...refusals], warnings };
}

/** A row in the flow whose `meta.ablated` disagrees with this run, named as `<variant>/<prompt_id>`. */
function ablationMix(snap: ReturnType<typeof loadFlowSnapshot>, ablate: boolean): string | undefined {
  for (const [variant, vs] of Object.entries(snap.variants))
    for (const line of (vs.results ?? "").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as { prompt_id?: unknown; meta?: { ablated?: unknown } };
        if ((r.meta?.ablated === true) !== ablate) return `${variant}/${String(r.prompt_id)}`;
      } catch {
        /* schema-check reports malformed lines */
      }
    }
  return undefined;
}

export function readVariantFileIfPresent(flowArg: string, variant: string, file: string, cwd: string): string | null {
  if (!lexists(resolve(cwd, flowArg, variant))) return null;
  const r = NoFollowRoot.existing(flowArg, { cwd });
  return r.readIfPresent(join(r.root, variant, file));
}
