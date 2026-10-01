// `hillclimb run`: the runner-scaffold.mjs contract (bundle 2.1.285) over the harness's own job runner.
//
// The order of S's main() is kept: refuse everything refusable before any spend (flags, id space, flow-dir
// hygiene, `_state.json`, the harness gate, split ids), then run every missing (case, rep) through a bounded
// pool, appending each row as it completes, and exit 0 (every attempt scored) / 1 (any failed attempt, or a
// mid-run stop) / 2 (refused before spending). stdout stays silent; every line goes to stderr, stripped of
// terminal escapes (model-influenced text reaches it).
//
// The job runner is injected: this module never spawns an agent. H4b's real runner builds each JobReport
// from a kept run dir; tests pass recorded excerpts.

import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { UsageError } from "../errors.js";
import { pMapBounded } from "../async-pool.js";
import type { RunResult } from "../types.js";
import type { HillclimbRunArgs } from "./args.js";
import { loadCases, selectCases, splitIdNotes, type HillclimbCase } from "./cases.js";
import { FlowWriter } from "./flow.js";
import { FsRefusal, NoFollowRoot, lexists, normalizeRootArg } from "./fs.js";
import { gateDecision, harnessDigest } from "./gate.js";
import { attemptRow, type AttemptContext } from "./rows.js";
import { turnsFromEvents, type ChildTranscript } from "./trace.js";
import { pathsInsideMounts } from "./answer-key.js";
import { headroom } from "./check.js";
import { loadFlowSnapshot } from "./schema-check.js";

/** What one job hands back. */
export interface JobReport {
  result?: RunResult;
  thrown?: unknown;
  /** The run's events.jsonl lines. */
  events: string[];
  children: ChildTranscript[];
  /** The trace's system turn (marker + the append as sent); absent ⇒ no system turn. */
  system?: string;
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
  /** Host roots the agent can read through a mount (folders, projects, uploads, plugins, skills). */
  mountRoots: (cases: readonly HillclimbCase[]) => string[];
  /** The variant snapshot's content signature, when the variant has one. */
  expectedContentSig?: string;
  /** Progress interval; S uses 30 s. */
  tickMs?: number;
  now?: () => number;
}

export interface RunOutcome {
  exitCode: 0 | 1 | 2;
  scheduled: number;
  ok: number;
  failed: number;
}

// S l.46-53: strip escape sequences and control characters from anything printed — case ids and error text
// can carry model output.
const ESC_SEQ = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]/g;
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;
export const termSafe = (s: string): string => s.replace(ESC_SEQ, "").replace(CONTROL, "");

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function runHillclimb(args: HillclimbRunArgs, deps: RunnerDeps): Promise<RunOutcome> {
  const say = (line: string) => deps.stderr(termSafe(line));
  const now = deps.now ?? Date.now;
  let started = false;
  try {
    return await run(args, deps, say, now, () => {
      started = true;
    });
  } catch (e) {
    // S l.591-602: before the workers start, anything thrown is a refusal (exit 2); after, a mid-run stop.
    if (started) {
      say(`stopped mid-run (rows already written are kept; re-run to resume): ${message(e)}`);
      return { exitCode: 1, scheduled: 0, ok: 0, failed: 0 };
    }
    if (e instanceof UsageError || e instanceof FsRefusal || e instanceof Error) {
      const m = message(e);
      say(m.startsWith("refusing") ? m : `refusing to run: ${m}`);
      return { exitCode: 2, scheduled: 0, ok: 0, failed: 0 };
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
  const flowAbs = join(deps.cwd, flowArg);
  const statePathShown = join(flowArg, "_state.json");

  // The whole case set: the id space, the split ids and the gate are judged on it, whatever --case selects.
  const { cases: all, skipped } = loadCases(join(deps.cwd, args.target));
  if (skipped.length) say(`[${v}] skipped ${skipped.length} non-scenario file(s): ${skipped.join(", ")}`);

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

  // The harness gate (S l.238-277).
  const digest = harnessDigest({
    cwd: deps.cwd,
    listed: Array.isArray(state.harness_paths) ? state.harness_paths.map(String) : [],
    derived: deps.derivedPaths(all),
    virtual: { "cowork-harness-version": deps.virtual.harnessVersion, baseline: deps.virtual.baselineId },
  });
  for (const s of digest.skipped) say(`warning: harness path '${s.path}' not readable (${s.code}) - skipped`);
  const decision = gateDecision(state, digest.sha, args.approveHarness);
  if (args.dryRun && !args.approveHarness)
    say(
      `harness gate: ${decision.kind === "ok" ? "approved" : decision.kind} (sha256 ${digest.sha.slice(0, 12)} over: ${digest.hashed.join(", ")})`,
    );
  else if (decision.kind !== "ok") {
    if (!digest.lockfiles.length) say("note: no lockfile in the current directory - dependency changes are outside the harness sha");
    if (decision.kind === "approve") {
      w!.approveHarness(digest.sha);
      say(`harness approved: sha256 ${digest.sha.slice(0, 12)} over ${digest.hashed.length} file(s) recorded in ${statePathShown}`);
    } else if (decision.kind === "absent") {
      say(`no approved harness sha in ${statePathShown} (computed ${digest.sha.slice(0, 12)} over: ${digest.hashed.join(", ")}).`);
      say("Review the harness, then run once with --approve-harness to record it.");
      return { exitCode: 2, scheduled: 0, ok: 0, failed: 0 };
    } else {
      say(
        `harness changed since last approved run (files: ${digest.hashed.join(", ")}); approved ${String(state.harness_sha).slice(0, 12)}, now ${digest.sha.slice(0, 12)}.`,
      );
      say("Re-run with --approve-harness after reviewing the diff.");
      return { exitCode: 2, scheduled: 0, ok: 0, failed: 0 };
    }
  }

  const cases = selectCases(all, args.cases);

  // Ground truth must be unreachable from the agent (H l.215): no mount may expose the flow dir (prior grades,
  // judge rationales) or a file that defines the answer.
  const exposed = pathsInsideMounts([flowAbs, ...deps.derivedPaths(cases)], deps.mountRoots(cases));
  if (exposed.length)
    throw new UsageError(
      `refusing to run: the agent could read ${exposed.map((x) => `${x.path} (through the mount ${x.mount})`).join("; ")} — prior rounds' grades, judge rationales and the rubric must stay outside every folder the session mounts`,
    );

  // A null (--ablate) run belongs in its own flow: mixed into a scored flow it would enter the trajectory.
  if (lexists(flowAbs)) {
    const mixed = ablationMix(flowAbs, args.ablate);
    if (mixed)
      throw new UsageError(
        `--ablate ${args.ablate ? "into a flow that holds scored rows" : "rows are in this flow"}: ${mixed} — run the null baseline into a sibling flow (e.g. <flow>-null)`,
      );
  }

  const done = w ? w.resumeSet() : new Set<string>();
  const tasks: Array<{ c: HillclimbCase; rep: number }> = [];
  for (const c of cases) for (let rep = 0; rep < args.reps; rep++) if (!done.has(`${c.id}\0${rep}`)) tasks.push({ c, rep });
  say(`[${v}] ${tasks.length} of ${cases.length * args.reps} (id,rep) to run`);
  if (args.dryRun) return { exitCode: 0, scheduled: tasks.length, ok: 0, failed: 0 };

  const release = w!.lock();
  const writer = w!;
  try {
    let ok = 0;
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
        /* S l.581: progress is best-effort */
      }
    };
    const tick = setInterval(progress, deps.tickMs ?? 30_000);
    const runLabel = `hillclimb:${basename(flowArg)}:${v}`;
    const flowHash = createHash("sha256").update(flowAbs).digest("hex").slice(0, 16);
    const models = new Set<string>();
    markStarted();
    try {
      await pMapBounded(tasks, args.concurrency, async ({ c, rep }) => {
        const tStart = now();
        let report: JobReport;
        try {
          report = await deps.runJob({ c, rep, variant: v, runLabel, timeoutS: args.timeoutS });
        } catch (e) {
          report = { thrown: e, events: [], children: [], attemptS: (now() - tStart) / 1000, runnerTimeout: false };
        }
        const ctx: AttemptContext = {
          caseId: c.id,
          ...(c.originalId !== undefined ? { originalId: c.originalId } : {}),
          scenarioName: c.name,
          prompt: c.scenario.prompt,
          assertions: c.scenario.assert,
          rep,
          pin: deps.pin(c),
          ...(deps.expectedContentSig !== undefined ? { expectedContentSig: deps.expectedContentSig } : {}),
          events: report.events,
          attemptS: report.attemptS,
          runnerTimeout: report.runnerTimeout,
          tags: [basename(dirname(c.file))],
          ...(report.skillInvoked !== undefined ? { skillInvoked: report.skillInvoked } : {}),
          meta: {
            flowHash,
            env: deps.virtual,
            ...(report.runDir !== undefined ? { runDir: report.runDir } : {}),
            ...(deps.expectedContentSig !== undefined ? { contentSig: deps.expectedContentSig } : {}),
            ...(args.ablate ? { ablated: true } : {}),
            ...(args.deciderLlm ? { nonDeterministic: true } : {}),
          },
        };
        const out = attemptRow(
          { ...(report.result ? { result: report.result } : {}), ...(report.thrown !== undefined ? { thrown: report.thrown } : {}) },
          ctx,
        );
        if (out.dest === "errors") {
          fail++;
          writer.appendError(out.row);
          say(`  [${v}] ${c.stem} rep${rep} FAILED: ${String(out.row.error)}`);
          return;
        }
        writer.appendResult(out.row);
        if (typeof out.row.model === "string") models.add(out.row.model);
        // Past this point the attempt is scored: a failed post-row write counts as failed but writes no error
        // row, which would double-count its spend (S l.529, 541-548).
        try {
          const prefix = `${v}/out/${c.id}_rep${rep}/blobs/`;
          const trace = turnsFromEvents({
            events: report.events,
            prompt: c.scenario.prompt,
            system: report.system,
            children: report.children,
            sidecarPrefix: prefix,
          });
          for (const s of trace.sidecars) writer.writeUnderFlow(prefix + s.name, s.data);
          writer.writeTrace(c.id, rep, trace.turns);
          ok++;
        } catch (e) {
          fail++;
          say(`  [${v}] ${c.stem} rep${rep} scored, but a post-row write failed: ${message(e)}`);
        }
      });
    } finally {
      clearInterval(tick);
    }
    progress();
    writer.mergeSummary({
      ...(models.size === 1 ? { model: [...models][0] } : {}),
      ...(deps.expectedContentSig !== undefined ? { source_sig: deps.expectedContentSig } : {}),
    });
    if (v === "baseline") for (const line of headroom(loadFlowSnapshot(flowAbs)).warnings) say(line);
    say(`[${v}] done - ${ok} ok, ${fail} failed -> ${join(flowArg, v, "results.jsonl")}`);
    return { exitCode: fail ? 1 : 0, scheduled: tasks.length, ok, failed: fail };
  } finally {
    release();
  }
}

function readStateIfPresent(flowArg: string, cwd: string): Record<string, unknown> {
  if (!lexists(join(cwd, flowArg))) return {};
  const r = NoFollowRoot.existing(flowArg, { cwd });
  const text = r.readIfPresent(join(r.root, "_state.json"));
  if (text === null) return {};
  try {
    const st = JSON.parse(text);
    return st && typeof st === "object" && !Array.isArray(st) ? st : {};
  } catch {
    throw new UsageError(`${join(flowArg, "_state.json")} exists but is not valid JSON - fix it before spending a pass`);
  }
}

/** A row in the flow whose `meta.ablated` disagrees with this run, named as `<variant>/<prompt_id>`. */
function ablationMix(flowAbs: string, ablate: boolean): string | undefined {
  const snap = loadFlowSnapshot(flowAbs);
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
