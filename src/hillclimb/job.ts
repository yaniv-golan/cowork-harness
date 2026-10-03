// One hillclimb job → one scenario run through the CLI's per-scenario runner, turned into the JobReport the
// runner core consumes. The eval job pattern (src/eval/job-runner.ts): a per-job COPY of the flags (the runner
// reads label/ablateSkill from its flags, and jobs run concurrently), a pre-assigned run id, an unanswered gate
// rethrown and its run dir salvaged.
//
// The wall-clock ceiling: the agent phase is bounded by lowering the scenario's own `timeout_ms` to the
// runner's `--timeout-s`, so the run's own timer kills the session and no VM is orphaned. A timeout that fired
// at the runner's value is the runner's (an errors row); one at the scenario's own shorter value is the skill's
// (a scored row). A tie goes to the runner.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunResult, Scenario } from "../types.js";
import type { ExecuteOptions } from "../run/execute.js";
import { salvagedResult, type ScenarioRunner } from "../eval/job-runner.js";
import type { JobReport, JobSpec } from "./runner.js";
import { keptChildTranscripts, keptMainTranscript, mainSystemTurn, sentSubagentAppend } from "./trace.js";

export interface JobDeps<F extends { label?: string; ablateSkill?: boolean }> {
  runScenario: ScenarioRunner<F>;
  /** The command's flags; each job runs with its own copy. */
  flags: F;
  /** Where a run with this id writes — `runOutDir` in production. */
  runDirFor: (scenario: Scenario, runId: string) => string;
  /** Per-job ExecuteOptions beyond the run id (the variant's session, a judge override). */
  extra?: (spec: HillclimbJobSpec) => Partial<ExecuteOptions>;
  now?: () => number;
}

export type HillclimbJobSpec = JobSpec;

/** A fresh run id per ATTEMPT: a resumed error slot re-runs the same (case, rep), and a deterministic id
 *  would put the new attempt into the old attempt's run dir. */
function attemptRunId(spec: HillclimbJobSpec): string {
  const h = createHash("sha256")
    .update([spec.runLabel, spec.c.id, String(spec.rep), randomBytes(8).toString("hex")].join("\0"))
    .digest("hex");
  return `local_${BigInt(`0x${h.slice(0, 16)}`)
    .toString(36)
    .padStart(13, "0")}`;
}

/** The agent session's id: the last event that names one (the result frame, else an earlier one on a run that ended
 *  without it). It names the session's transcript file. */
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

const lines = (p: string): string[] =>
  existsSync(p)
    ? readFileSync(p, "utf8")
        .split("\n")
        .filter((l) => l.trim())
    : [];

export function makeHillclimbJobRunner<F extends { label?: string; ablateSkill?: boolean }>(
  deps: JobDeps<F>,
): (spec: HillclimbJobSpec) => Promise<JobReport> {
  const now = deps.now ?? Date.now;
  return async (spec) => {
    const ceilingMs = spec.timeoutS > 0 ? spec.timeoutS * 1000 : undefined;
    const own = spec.c.scenario.timeout_ms;
    const runnerBound = ceilingMs !== undefined && (own === undefined || ceilingMs <= own);
    const scenario: Scenario = runnerBound ? { ...spec.c.scenario, timeout_ms: ceilingMs } : spec.c.scenario;
    const runId = attemptRunId(spec);
    const expectedDir = deps.runDirFor(scenario, runId);
    const t0 = now();
    // The runner's ceiling covers the whole attempt: `timeout_ms` bounds the agent, and this deadline keeps a
    // judge from starting after it (executeScenario then ends the run as a timeout).
    const deadline = ceilingMs !== undefined ? t0 + ceilingMs : undefined;
    let result: RunResult | undefined;
    let thrown: unknown;
    try {
      result = await deps.runScenario({
        scenario,
        label: `${spec.variant} ${spec.c.id} r${spec.rep}`,
        flags: { ...deps.flags, label: spec.runLabel, ablateSkill: spec.ablate },
        // Every attempt records the pre-run manifest, whatever its scenario asserts now: a metric or an authorship
        // assert added later in the loop is decided against it when `hillclimb regrade` re-measures the kept run.
        extra: { runId, ...(deadline !== undefined ? { deadline } : {}), ...(deps.extra?.(spec) ?? {}), armPreRunManifest: true },
        rethrowUnanswered: true,
      });
    } catch (e) {
      thrown = e;
      result = salvagedResult(expectedDir);
    }
    const attemptS = (now() - t0) / 1000;
    const outDir = result?.outDir ?? (existsSync(expectedDir) ? expectedDir : undefined);
    const fidelity = result?.effectiveFidelity ?? result?.fidelity;
    const subagentAppend = outDir ? sentSubagentAppend(outDir) : undefined;
    const events = outDir ? lines(join(outDir, "events.jsonl")) : [];
    const kept = outDir && fidelity ? { outDir, fidelity, ...(result?.workDir ? { workDir: result.workDir } : {}) } : undefined;
    const transcript = kept ? keptMainTranscript(kept, sessionIdOf(events)) : undefined;
    return {
      ...(result !== undefined ? { result } : { result: undefined }),
      ...(thrown !== undefined ? { thrown } : {}),
      events,
      ...(transcript !== undefined ? { transcript } : {}),
      children: kept ? keptChildTranscripts(kept) : [],
      ...(subagentAppend !== undefined ? { subagentAppend } : {}),
      ...(outDir !== undefined ? { system: mainSystemTurn(outDir) } : {}),
      attemptS,
      // The runner's when its own value bound the agent, or when its deadline had passed (a judge skipped, or a
      // scenario timeout that ran past the ceiling). A tie goes to the runner.
      runnerTimeout: result?.errorSource === "timeout" && (runnerBound || (deadline !== undefined && now() >= deadline)),
      ...(outDir !== undefined ? { runDir: outDir } : {}),
    };
  };
}
