// The per-row judge fields a hillclimb row carries. ONE rule, shared by every grader that calls a judge
// (pointwise `semantic_matches`, pairwise `semantic_pairwise`).
//
// A row has a single `judge_model` and a single `judge_usage` (eval-hillclimb.md l.170: a viewer derives judge
// cost from `judge_model × judge_usage`), so a run graded by two judge models cannot be priced exactly from
// those two keys. The row's `cost_usd` stays the authoritative spend; `judge_models` carries the exact
// breakdown, and the dominant model (most input tokens) is named so a derived cost is as close as it can be.

import { addTokenUsage } from "../decide/usage.js";
import type { TokenUsage } from "../types.js";

export interface JudgedAssert {
  judgeModel?: string;
  judgeUsage?: TokenUsage;
}

export interface JudgeRollup {
  judge_model?: string;
  judge_usage?: TokenUsage;
  /** Present only when more than one judge model graded the run. */
  judge_models?: Record<string, TokenUsage>;
}

/** Combine the judge provenance of every judged assert in one run. No judged assert ⇒ `{}`: both keys absent,
 *  never zero (unpriced is not $0). Usage is summed token-wise over every assert (each already sums its own
 *  attempts). With several models the one with the most input tokens is named; a tie goes to the
 *  lexicographically first id, so the result never depends on assert order. */
export function combineJudges(asserts: readonly JudgedAssert[]): JudgeRollup {
  const byModel = new Map<string, TokenUsage | undefined>();
  let total: TokenUsage | undefined;
  for (const a of asserts) {
    if (a.judgeModel === undefined) continue;
    byModel.set(a.judgeModel, addTokenUsage(byModel.get(a.judgeModel), a.judgeUsage));
    total = addTokenUsage(total, a.judgeUsage);
  }
  if (byModel.size === 0) return {};
  const models = [...byModel.keys()].sort();
  const input = (m: string): number => byModel.get(m)?.input_tokens ?? 0;
  const judge_model = models.reduce((best, m) => (input(m) > input(best) ? m : best));
  const out: JudgeRollup = { judge_model };
  if (total !== undefined) out.judge_usage = total;
  if (models.length > 1) {
    const breakdown: Record<string, TokenUsage> = {};
    for (const m of models) {
      const usage = byModel.get(m);
      if (usage !== undefined) breakdown[m] = usage;
    }
    out.judge_models = breakdown;
  }
  return out;
}
