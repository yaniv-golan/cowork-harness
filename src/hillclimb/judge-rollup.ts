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
  /** Present only when more than one judge model graded the run: every model, `null` for one that reported no
   *  tokens. Usage from an assert with no recorded model appears only in `judge_usage`. */
  judge_models?: Record<string, TokenUsage | null>;
}

/** Combine the judge provenance of every judged assert in one run. No judged assert ⇒ `{}`: both keys absent,
 *  never zero (unpriced is not $0). Usage is summed token-wise over every assert (each already sums its own
 *  attempts) — including an assert that recorded tokens but no model, so no spend drops out of the total. The
 *  named model is the one with the most input tokens counting cache reads and writes (with prompt caching,
 *  `input_tokens` alone can be tiny); a tie goes to the lexicographically first id, so the result never depends on
 *  assert order. `"unknown"` (a transport that reported no model) is never named while a real model is present,
 *  and alone it names none. `judge_models` — present only with more than one model — belongs under the row's
 *  `meta`; the caller places it there. Usage from an assert with no recorded model is in `judge_usage` only, so the
 *  breakdown can sum to less than the total. */
export function combineJudges(asserts: readonly JudgedAssert[]): JudgeRollup {
  const byModel = new Map<string, TokenUsage | undefined>();
  let total: TokenUsage | undefined;
  for (const a of asserts) {
    total = addTokenUsage(total, a.judgeUsage);
    if (a.judgeModel === undefined) continue;
    byModel.set(a.judgeModel, addTokenUsage(byModel.get(a.judgeModel), a.judgeUsage));
  }
  const out: JudgeRollup = {};
  if (total !== undefined) out.judge_usage = total;
  const named = [...byModel.keys()].filter((m) => m !== "unknown").sort();
  if (named.length > 0) {
    const input = (m: string): number => {
      const u = byModel.get(m);
      return u ? u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens : 0;
    };
    out.judge_model = named.reduce((best, m) => (input(m) > input(best) ? m : best));
  }
  if (byModel.size > 1) {
    const breakdown: Record<string, TokenUsage | null> = {};
    for (const m of [...byModel.keys()].sort()) breakdown[m] = byModel.get(m) ?? null;
    out.judge_models = breakdown;
  }
  return out;
}
