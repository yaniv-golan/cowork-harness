// The agent's own report that no model did the work: a sign-in failure, a terminal usage limit, or a run whose only
// "model" was the agent's local `<synthetic>` marker at zero spend. The agent writes these as an ordinary `result`
// error of kind `agent`, so the result fields alone blame the skill. One reading, shared by the eval classifier
// (eval/classify.ts, which buckets them `errored_infra`) and the turn-cap predicate (turn-cap.ts, which must never
// read one as the cap having stopped the agent).
import { isLiveModelId } from "../types.js";
import { matchesTerminalUsageLimitText } from "../usage-limit.js";

/** The agent's own text when it could not authenticate — the whole reply, fabricated locally (model
 *  `<synthetic>`, the assistant event's `error: "authentication_failed"`), surfaced as the result's
 *  `finalMessage`. The two spellings are the ones kept runs hold (searched 2026-09-30): `Not logged in ·
 *  Please run /login` and `Authentication required · Sign in again to continue`. No kept run shows an
 *  invalid-API-key or 401 text, so none is guessed here; such a rep still lands in `no_model_answered`. */
export const AUTH_FAILURE_SIGNATURE = /\bNot logged in\b.*\/login\b|\bAuthentication required\b.*\bSign in again\b/;

export interface AgentEndEvidence {
  models?: readonly unknown[];
  finalMessage?: string;
  cost?: { usd?: number };
}

/** Which of the agent's own no-work ends this is, if any. The sign-in and limit texts count only beside a
 *  `<synthetic>` turn (every kept run with such text has one), so a skill's own message that merely reads like a
 *  limit or a login prompt stays the skill's. `no_model_answered` is positive evidence only: models reported, every
 *  one a local marker, and zero spend (an absent `models` is no evidence; spend separates a slash-command run). */
export function agentInfraEnd(r: AgentEndEvidence): "auth" | "usage_limit" | "no_model_answered" | undefined {
  const models = Array.isArray(r.models) ? r.models : [];
  const agentWrote = typeof r.finalMessage === "string" && models.some((m) => !isLiveModelId(m));
  if (agentWrote && AUTH_FAILURE_SIGNATURE.test(r.finalMessage!)) return "auth";
  // The account's quota, never the skill: the shared terminal-limit matcher (transient rate limits excluded).
  if (agentWrote && matchesTerminalUsageLimitText(r.finalMessage!)) return "usage_limit";
  if (models.length > 0 && !models.some(isLiveModelId) && r.cost?.usd === 0) return "no_model_answered";
  return undefined;
}
