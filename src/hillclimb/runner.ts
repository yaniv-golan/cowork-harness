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
import { createHash } from "node:crypto";
import { UsageError } from "../errors.js";
import { pMapBounded } from "../async-pool.js";
import type { RunResult } from "../types.js";
import type { HillclimbRunArgs } from "./args.js";
import { loadCases, selectCases, splitIdNotes, type HillclimbCase } from "./cases.js";
import type { PairwiseDecls } from "./grade-keys.js";
import { FlowWriter, flowHashOf, redactDeep, slotsIn } from "./flow.js";
import { FsRefusal, NoFollowRoot, lexists, normalizeRootArg } from "./fs.js";
import { approvedHarnessSkill, flowHarnessDigest, gateDecision, listedInside } from "./gate.js";
import { attemptRow, type AttemptContext } from "./rows.js";
import { flowMetricUnion, refuseChangedMetrics, removedMetrics, undeclaredRowMetrics } from "./metric-keys.js";
import { turnsFromEvents, type ChildTranscript } from "./trace.js";
import { pathsInsideMounts } from "./answer-key.js";
import { asFlowData, attachmentKind, authoredOutputs, planInputCopy, planOutputCopy } from "./outputs.js";
import { headroom, pairwiseHints } from "./check.js";
import { loadFlowSnapshot } from "./schema-check.js";
import { hillclimbRunLabel } from "../run/run-labels.js";

/** What one job hands back. */
export interface JobReport {
  result?: RunResult;
  thrown?: unknown;
  /** The run's events.jsonl lines. */
  events: string[];
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
  /** After the pool, before the summary: work over the pass's written rows (a baseline pass freezes the flow's
   *  pairwise references). Returns the lines to print and how many of them are failures — counted like a failed
   *  post-row write: no error row, `scored` unchanged. Not called on a dry run. */
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
    say(
      `harness gate: ${decision.kind === "ok" ? "approved" : decision.kind}${why} (sha256 ${digest.sha.slice(0, 12)} over: ${digest.hashed.join(", ")})`,
    );
  } else if (decision.kind !== "ok") {
    if (!digest.lockfiles.length) say("note: no lockfile in the current directory - dependency changes are outside the harness sha");
    if (decision.kind === "approve") {
      w!.approveHarness(digest.sha, args.skill);
      say(`harness approved: sha256 ${digest.sha.slice(0, 12)} over ${digest.hashed.length} file(s) recorded in ${statePathShown}`);
    } else if (decision.kind === "absent") {
      const m = `no approved harness sha in ${statePathShown} (computed ${digest.sha.slice(0, 12)} over: ${digest.hashed.join(", ")}).`;
      const fix = "Review the harness, then run once with --approve-harness to record it.";
      say(m);
      say(fix);
      return { exitCode: 2, scheduled: 0, ok: 0, failed: 0, error: { category: "usage", message: `${m} ${fix}` } };
    } else {
      const shas = `approved ${String(state.harness_sha).slice(0, 12)}, now ${digest.sha.slice(0, 12)}`;
      const files = `files: ${digest.hashed.join(", ")}`;
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
    let fail = 0;
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
        report = { thrown: e, events: [], children: [], attemptS: (now() - tStart) / 1000, runnerTimeout: false };
      }
      const ctx: AttemptContext = {
        caseId: c.id,
        ...(c.originalId !== undefined ? { originalId: c.originalId } : {}),
        scenarioName: c.name,
        prompt: c.scenario.prompt,
        assertions: c.scenario.assert,
        metrics,
        ...(deps.pairwise ? { pairwise: deps.pairwise } : {}),
        rep,
        pin: deps.pin(c),
        ...(sigOf(c) !== undefined ? { expectedContentSig: sigOf(c)! } : {}),
        events: report.events,
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
              retries_unrecorded: true,
              judge_retries_unrecorded: true,
              ...(typeof report.result?.cost?.usd === "number" ? { cost_usd: report.result.cost.usd } : {}),
              ...(report.runDir !== undefined ? { run_dir: report.runDir, run_id: basename(report.runDir) } : {}),
            },
          },
        };
      }
      if (out.dest === "errors") {
        fail++;
        writer.appendError(out.row);
        say(`  [${v}] ${c.stem} rep${rep} FAILED: ${String(out.row.error)}`);
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
        fail += r.failures;
      } catch (e) {
        fail++;
        say(`[${v}] the pass finished, but its post-pass step failed: ${message(e)}`);
      }
    try {
      writer.mergeSummary({
        ...(models.size === 1 ? { model: [...models][0] } : {}),
        ...(variantSig !== undefined ? { source_sig: variantSig } : {}),
      });
      if (v === "baseline") for (const line of headroom(loadFlowSnapshot(flowAbs)).warnings) say(line);
    } catch (e) {
      fail++;
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
    return { exitCode: fail ? 1 : 0, scheduled: tasks.length, ok, failed: fail, scored };
  } finally {
    release();
  }
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
