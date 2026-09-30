// What a paired evaluation holds fixed, checked before any spend: the agent model and the judge model must
// each name exactly one model (a family alias floats to whatever the account's newest member is at call
// time, so two arms could be graded against different models), and the grading prompt's identity is
// recorded so a rep graded under another prompt is recognised.
import type { Scenario } from "../types.js";
import { UsageError } from "../errors.js";
import { isConcreteModelId, resolvePinnedModel, envModelDefault } from "../run/model-provenance.js";
import { defaultJudgeModel, JUDGE_PROMPT_HASH } from "../decide/semantic-judge.js";

export interface AgentPin {
  scenario: string;
  model: string;
}

export interface JudgePins {
  /** `override`: `--judge-model` grades every semantic_matches assert (a per-assert `judge_model` is inert).
   *  `per_assert`: each assert's `judge_model`, else COWORK_HARNESS_JUDGE_MODEL, else the default. */
  mode: "override" | "per_assert";
  /** Every resolved judge model, per (scenario, assertion index). Empty when no scenario has a semantic assert. */
  resolved: Array<{ scenario: string; assertionIndex: number; model: string }>;
  promptHash: string;
}

/** The agent model each scenario will run with — the same chain a run resolves (`--model`, the session's
 *  `model:`, then COWORK_HARNESS_MODEL) — refused unless every one is concrete. */
export function resolveAgentPins(
  scenarios: ReadonlyArray<{ scenario: Scenario; sessionModel: string | undefined }>,
  modelFlag: string | undefined,
): AgentPin[] {
  const pins = scenarios.map(({ scenario, sessionModel }) => ({
    scenario: scenario.name,
    model: resolvePinnedModel(modelFlag, sessionModel, envModelDefault()),
  }));
  const bad = pins.filter((p) => !isConcreteModelId(p.model));
  if (bad.length)
    throw new UsageError(
      `eval needs a CONCRETE agent model for every scenario, so both arms run the same model: ` +
        bad.map((p) => `${p.scenario}: ${p.model === undefined ? "no model resolves" : `"${p.model}" is an alias`}`).join("; ") +
        `. Pass --model <id> (e.g. claude-sonnet-5), or set a concrete \`model:\` in the session.`,
    );
  return pins as AgentPin[];
}

/** The judge model(s), refused unless every LIVE value is concrete. Under `--judge-model` only that value is
 *  live; without it every semantic assert's own `judge_model` and the env/default chain are. */
export function resolveJudgePins(scenarios: readonly Scenario[], judgeModelFlag: string | undefined): JudgePins {
  const resolved: JudgePins["resolved"] = [];
  if (judgeModelFlag !== undefined) {
    if (!isConcreteModelId(judgeModelFlag))
      throw new UsageError(`--judge-model "${judgeModelFlag}" is an alias; pass a concrete model id (e.g. claude-opus-4-8)`);
    for (const s of scenarios)
      (s.assert ?? []).forEach((a, i) => {
        if (a.semantic_matches) resolved.push({ scenario: s.name, assertionIndex: i, model: judgeModelFlag });
      });
    return { mode: "override", resolved, promptHash: JUDGE_PROMPT_HASH };
  }
  const bad: string[] = [];
  for (const s of scenarios)
    (s.assert ?? []).forEach((a, i) => {
      if (!a.semantic_matches) return;
      const model = a.semantic_matches.judge_model ?? defaultJudgeModel();
      if (!isConcreteModelId(model)) bad.push(`${s.name} assertion ${i}: "${model}"`);
      resolved.push({ scenario: s.name, assertionIndex: i, model });
    });
  if (bad.length)
    throw new UsageError(
      `eval needs a CONCRETE judge model for every semantic_matches assert: ${bad.join("; ")}. Pass --judge-model <id> to grade every assert with one model.`,
    );
  return { mode: "per_assert", resolved, promptHash: JUDGE_PROMPT_HASH };
}
