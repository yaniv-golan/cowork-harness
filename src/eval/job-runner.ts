// One eval job → one scenario run: the mapping from a scheduled job to the options the per-scenario runner
// takes, and the recovery of a job that threw. Exported so every caller that drives eval jobs (the `eval`
// command, and any later runner over the same schedule) maps them the same way.
import { existsSync, readFileSync } from "node:fs";
import type { RunResult, Scenario } from "../types.js";
import type { SessionConfig } from "../session.js";
import { runOutDir, type ExecuteOptions } from "../run/execute.js";
import { latestTurn, turnArtifactPath } from "../run/turn-layout.js";
import type { ScheduledJob } from "./schedule.js";

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

/** The ExecuteOptions a job's run takes: the arm's session, the pre-assigned run id, and the judge override. */
export function evalJobExecuteOptions(spec: EvalJobSpec): Pick<ExecuteOptions, "session" | "runId" | "judgeModelOverride"> {
  return {
    session: spec.session,
    runId: spec.job.runId,
    ...(spec.judgeModelOverride !== undefined ? { judgeModelOverride: spec.judgeModelOverride } : {}),
  };
}

/** A per-job COPY of the command's flags with the job's run label and no ablation. The scenario runner reads
 *  `label`/`ablateSkill` from its flags (over any per-call option), and jobs run concurrently, so a shared
 *  object would be clobbered by whichever job started last. */
export function evalJobFlags<F extends { label?: string; ablateSkill?: boolean }>(flags: F, spec: EvalJobSpec): F {
  return { ...flags, label: spec.runLabel, ablateSkill: undefined };
}

/** The runner signature `run` uses for one scenario (the CLI's `runOneScenario`, minus the fixed fields). */
export type ScenarioRunner<F> = (a: {
  scenario: Scenario;
  label: string;
  flags: F;
  extra: Partial<ExecuteOptions>;
  rethrowUnanswered: true;
}) => Promise<RunResult>;

/** Build the `runJob` an eval drives: each job runs through `runScenario` with its own flag copy and the
 *  job's options; an unanswered gate is rethrown (the eval records it and recovers the dir). */
export function makeEvalJobRunner<F extends { label?: string; ablateSkill?: boolean }>(
  runScenario: ScenarioRunner<F>,
  flags: F,
): (spec: EvalJobSpec) => Promise<RunResult> {
  return (spec) =>
    runScenario({
      scenario: spec.scenario,
      label: `${spec.job.arm} ${spec.scenario.name} r${spec.job.rep}`,
      flags: evalJobFlags(flags, spec),
      extra: evalJobExecuteOptions(spec),
      rethrowUnanswered: true,
    });
}

/** Where the job's run writes — the same derivation `executeScenario` uses. */
export function evalJobRunDir(spec: Pick<EvalJobSpec, "scenario" | "job">): string {
  return runOutDir(spec.scenario.name, spec.job.runId);
}

/** The result.json a job left in its run dir before throwing (an unanswered gate's salvaged partial). */
export function salvagedResult(dir: string): RunResult | undefined {
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
