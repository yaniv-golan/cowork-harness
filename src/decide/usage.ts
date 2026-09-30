/** Folds over a transport usage map — the `modelUsage` VALUE a `claude -p --output-format json` envelope
 *  carries (`{ "<model>": { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens,
 *  costUSD, … } }`). Shared by the LLM decider and the semantic judge so the two cannot count differently.
 *
 *  Every model key is summed: the transport can make an auxiliary call under a second model key, and that
 *  call is real spend. Both folds return `undefined` when nothing countable was seen — unpriced (or
 *  unreported) is never $0 / zero tokens. */

import type { TokenUsage } from "../types.js";

export type { TokenUsage };

const entries = (usage: Record<string, unknown> | undefined): Record<string, unknown>[] =>
  Object.values(usage ?? {}).filter((m): m is Record<string, unknown> => !!m && typeof m === "object");

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Total `costUSD` across every per-model entry. `undefined` when no entry is priced. */
export function usageCostUsd(usage: Record<string, unknown> | undefined): number | undefined {
  let total: number | undefined;
  for (const m of entries(usage)) if (finite(m.costUSD)) total = (total ?? 0) + m.costUSD;
  return total;
}

/** Token counters summed across every per-model entry. `undefined` when no entry carries a numeric counter. */
export function usageTokens(usage: Record<string, unknown> | undefined): TokenUsage | undefined {
  const t: TokenUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  let seen = false;
  const add = (k: keyof TokenUsage, v: unknown): void => {
    if (!finite(v)) return;
    t[k] += v;
    seen = true;
  };
  for (const m of entries(usage)) {
    add("input_tokens", m.inputTokens);
    add("output_tokens", m.outputTokens);
    add("cache_read_input_tokens", m.cacheReadInputTokens);
    add("cache_creation_input_tokens", m.cacheCreationInputTokens);
  }
  return seen ? t : undefined;
}

/** Sum two optional token tallies; `undefined` only when both are. */
export function addTokenUsage(a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage | undefined {
  if (!a) return b ? { ...b } : undefined;
  if (!b) return { ...a };
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
  };
}

/** Sum two optional dollar figures; `undefined` only when both are. */
export function addCost(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined ? b : b === undefined ? a : a + b;
}
