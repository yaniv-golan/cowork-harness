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
  /** Pre-assigned, so the run dir is known before the run: `<runs-root>/<slug>/sess-<sessionId>`. */
  sessionId: string;
}

/** A scenario name reduced to the session-id charset, with a short hash when that changed or truncated it
 *  (so two names that reduce alike still get distinct ids). */
export function scenarioToken(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "scenario";
  if (cleaned === name && cleaned.length <= 40) return cleaned;
  return `${cleaned.slice(0, 40)}-${createHash("sha256").update(name).digest("hex").slice(0, 6)}`;
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
          sessionId: `eval-${evalId}-${arm}-${scenarioToken(scenario)}-r${rep}`,
        });
    });
  }
  return jobs;
}
