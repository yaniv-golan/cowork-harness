import { probeGraderCredential, type GraderProbeOutcome, type GraderRole } from "../decide/llm-transport.js";

// The pre-spend grader credential check that `eval` and `hillclimb run` make before any agent run. One real call per
// distinct (role, model) through the exact grader path. It checks only the credential the graders use: doctor's
// token check only asks whether some agent credential is set, and on the protocol tier (where the agent uses
// ANTHROPIC_API_KEY) neither proves the agent's own key valid; the agent's first call does that, at $0 on a 401.

/** One grader the run will call: its role (which sets `--effort`) and its model. */
export interface GraderProbeTarget {
  role: GraderRole;
  model: string;
}

/** The check's result: a refusal stops the command before any agent spend; `lines` are printed either way. */
export interface JudgeCheckOutcome {
  refusal?: string;
  lines: string[];
  /** What the probes that reported a cost spent, summed (absent when none did). */
  costUsd?: number;
}

export type JudgeCheck = (targets: readonly GraderProbeTarget[]) => Promise<JudgeCheckOutcome>;

/** `--no-judge-check`, or `COWORK_HARNESS_JUDGE_CHECK=0`. */
export function judgeCheckDisabled(flag: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  return flag || env.COWORK_HARNESS_JUDGE_CHECK === "0";
}

/** The model the LLM decider uses when no flag picks one: decider.ts's own default, re-exported for the callers. */
export { llmDeciderModel } from "../decide/decider.js";

const ROLE_NAME: Record<GraderRole, string> = { judge: "judge", decider: "LLM decider", evaluator: "critique evaluator" };

function role404Fix(role: GraderRole): string {
  return role === "decider"
    ? "the model is unknown or not available to this credential; set COWORK_HARNESS_DECIDER_MODEL to a model it can use"
    : "the model is unknown or not available to this credential; pass --judge-model, or fix the assert's judge_model / COWORK_HARNESS_JUDGE_MODEL";
}

function fmtCost(usd: number | undefined): string {
  return usd === undefined ? "probe cost not reported" : `probe cost $${usd.toFixed(usd < 0.01 ? 4 : 3)}`;
}

/** Probe each distinct (role, model) in order; stop at the first refusal. */
export async function runJudgeCheck(
  targets: readonly GraderProbeTarget[],
  probe: (model: string, role: GraderRole) => Promise<GraderProbeOutcome> = probeGraderCredential,
): Promise<JudgeCheckOutcome> {
  const lines: string[] = [];
  const seen = new Set<string>();
  let costUsd: number | undefined;
  const spent = () => (costUsd !== undefined ? { costUsd } : {});
  for (const t of targets) {
    const key = `${t.role}\u0000${t.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const o = await probe(t.model, t.role);
    const who = ROLE_NAME[t.role];
    if (o.status === "ok") {
      if (o.costUsd !== undefined) costUsd = (costUsd ?? 0) + o.costUsd;
      lines.push(`${who} credential: ${o.credential} works for ${o.model} (${fmtCost(o.costUsd)})`);
      continue;
    }
    if (o.status === "warn") {
      lines.push(
        `${who} credential: could not check ${t.model} with ${o.credential} (${o.message}); proceeding. If it is the ` +
          `credential, each grade fails as a judge call failure and the rep counts as invalid.`,
      );
      continue;
    }
    // The fix follows the status: a 404 is the model (measured: an unknown model id is an API 404 at $0, not a
    // start-up refusal), a 429 here is a spent quota, a 401/403 is the credential.
    const fix =
      o.apiStatus === 404
        ? role404Fix(t.role)
        : o.apiStatus === 429
          ? "the usage quota is spent: wait for it to reset, or give the graders another credential (COWORK_HARNESS_GRADER_AUTH)"
          : "check the credential with `cowork-harness doctor`; COWORK_HARNESS_GRADER_AUTH picks which credential the graders get";
    return {
      lines,
      ...spent(),
      refusal:
        `the ${who}'s call was refused before any agent run (${o.message}; model ${t.model}, credential ${o.credential}). ` +
        `Every grade would fail the same way, so nothing was run. Fix: ${fix}.`,
    };
  }
  return { lines, ...spent() };
}
