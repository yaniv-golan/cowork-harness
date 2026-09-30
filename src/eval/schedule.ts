// The eval schedule: reps x scenarios x arms jobs, with the arm order alternating per rep (ABBA). Fixed, not
// seeded: rep 1 runs A then B for each scenario, rep 2 runs B then A, and so on, with the scenarios in the
// order the eval resolved them. A slow drift over the eval's wall time then lands on both arms alike; at
// --concurrency 2 the pair of one rep is typically in flight together.
import { createHash } from "node:crypto";

export interface ScheduledJob {
  /** Position in the schedule (0-based); the runs.jsonl lines are ordered by it. */
  index: number;
  arm: string;
  /** Index into the eval's scenarios. */
  scenarioIndex: number;
  scenario: string;
  /** 1-based. */
  rep: number;
  /** Pre-assigned, so the run dir is known before the run (`runOutDir(scenario, runId)`). Shaped like any
   *  ordinary run's id — `local_` + 13 base36 characters — and derived from a hash, so it names neither
   *  the eval nor the arm: it becomes the agent's working directory, and a label there would be the one
   *  token that differs between arms. Recomputable from (evalId, arm, scenario index, rep). */
  runId: string;
}

export function jobRunId(evalId: string, arm: string, scenarioIndex: number, rep: number): string {
  const h = createHash("sha256")
    .update([evalId, arm, String(scenarioIndex), String(rep)].join("\0"))
    .digest("hex");
  return `local_${BigInt(`0x${h.slice(0, 16)}`)
    .toString(36)
    .padStart(13, "0")}`;
}

export function buildSchedule(evalId: string, arms: readonly [string, string], scenarios: readonly string[], reps: number): ScheduledJob[] {
  const jobs: ScheduledJob[] = [];
  for (let rep = 1; rep <= reps; rep++) {
    const order = rep % 2 === 1 ? [arms[0], arms[1]] : [arms[1], arms[0]];
    scenarios.forEach((scenario, scenarioIndex) => {
      for (const arm of order)
        jobs.push({
          index: jobs.length,
          arm,
          scenarioIndex,
          scenario,
          rep,
          runId: jobRunId(evalId, arm, scenarioIndex, rep),
        });
    });
  }
  return jobs;
}
