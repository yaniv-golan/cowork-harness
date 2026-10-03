// The hillclimb cost path: numbers the loop copies rather than derives.
//
// A row's `usage` is the main model's (and its same-model sub-agents'); its `cost_usd` is the agent's own
// `total_cost_usd` — every model, cache, geo and web-search pricing included, the judge excluded. Deriving spend from
// `model × usage` undercounts. So each variant's `summary.json` carries the spend summed from the rows, and each row says
// which credential the agent billed (`meta.billing`), read from the agent's OWN frames, never the harness's env view.
//
// Billing basis, in order (agent 2.1.286: under CLAUDE_CODE_ENTRYPOINT=local-agent an OAuth token wins over an API
// key; CLAUDE_CODE_REMOTE and CLAUDE_CODE_HOST_AUTH_ENV_VAR change the choice too; with none of the three the key wins):
//   1. a provider other than firstParty                        → third_party
//   2. an API-key source AND an OAuth token source            → subscription when a five_hour/seven_day rate limit
//      was reported (any tier); else api_key when the spawn env carries none of the three keys; else ambiguous
//   3. an OAuth token source, or a claude.ai login (the PRESENCE of the account's `subscriptionType` key; its value is
//      never read)                                             → subscription
//   4. an API-key source and no token (`none`, or `apiKeyHelper`: the key's own helper) → api_key
//   5. anything else (a bearer ANTHROPIC_AUTH_TOKEN, none/none, account frames that disagree) → ambiguous
// The account's identity fields (`email`, `organization`, `subscriptionType`'s value) are never copied.

import { normalizeModelId } from "../run/model-provenance.js";
import type { FlowSnapshot } from "./schema-check.js";

export type BillingBasis = "api_key" | "subscription" | "third_party" | "ambiguous";
export type CostBasis = "list" | "managed" | "unknown";

/** A row's `meta.billing`: credential source NAMES only, and the basis they imply. */
export interface Billing {
  api_key_source?: string;
  token_source?: string;
  provider?: string;
  cost_basis?: CostBasis;
  basis: BillingBasis;
}

/** The agent's token sources that are an OAuth (subscription) credential. */
const OAUTH_TOKEN_SOURCES = new Set([
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CCR_OAUTH_TOKEN_FILE",
  // a claude.ai (Keychain) login the agent reports by name when an API key shadows it
  "claude.ai",
]);
/** Token sources that are no token: none, or the API key's own helper (an apiKeyHelper-only run reports it as both). */
const NOT_A_TOKEN = new Set(["none", "apiKeyHelper"]);
/** Spawn-env keys the agent reads when it picks between an API key and an OAuth token. With none set, the key wins. */
export const CREDENTIAL_PRECEDENCE_ENV_KEYS = ["CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_REMOTE", "CLAUDE_CODE_HOST_AUTH_ENV_VAR"] as const;
/** Rate-limit windows only a subscription has. */
const SUBSCRIPTION_LIMITS = ["five_hour", "seven_day"];

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const credential = (v: string | undefined): string | undefined => (v === undefined || v === "none" ? undefined : v);

/** The four account fields the basis reads — never the object itself, which carries the operator's identity. */
interface AccountSignals {
  tokenSource?: string;
  apiKeySource?: string;
  apiProvider?: string;
  login: boolean;
}

const accountSignals = (a: Record<string, unknown>): AccountSignals => ({
  ...(str(a.tokenSource) !== undefined ? { tokenSource: str(a.tokenSource) } : {}),
  ...(str(a.apiKeySource) !== undefined ? { apiKeySource: str(a.apiKeySource) } : {}),
  ...(str(a.apiProvider) !== undefined ? { apiProvider: str(a.apiProvider) } : {}),
  login: "subscriptionType" in a,
});

/** `modelUsage` entries' `costBasis`: absent ⇒ list (the agent's own rule); the most cautionary value wins. */
function costBasisOf(modelUsage: Record<string, unknown> | undefined): CostBasis | undefined {
  const entries = Object.values(modelUsage ?? {}).filter(isObj);
  if (!entries.length) return undefined;
  const seen = new Set(
    entries.map((e) =>
      e.costBasis === undefined ? "list" : e.costBasis === "list" || e.costBasis === "managed" ? e.costBasis : "unknown",
    ),
  );
  return seen.has("unknown") ? "unknown" : seen.has("managed") ? "managed" : "list";
}

/** A run's billing, from its `events.jsonl` (the `system/init` frame, the `init-1` control_response's `account`, any
 *  `rate_limit_event`) and its result's `modelUsage`. `credentialEnv` holds the CREDENTIAL_PRECEDENCE_ENV_KEYS the run's
 *  TIER spawns the agent with (the baseline's spawn env; the operator's env at protocol). Undefined when the run recorded
 *  no account frame. */
export function billingOf(input: {
  events: readonly string[];
  modelUsage: Record<string, unknown> | undefined;
  credentialEnv: Readonly<Record<string, string | undefined>>;
}): Billing | undefined {
  const accounts: AccountSignals[] = [];
  let initKeySource: string | undefined;
  let subscriptionLimit = false;
  for (const line of input.events) {
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(o)) continue;
    if (o.type === "system" && o.subtype === "init") initKeySource ??= str(o.apiKeySource);
    else if (o.type === "control_response") {
      const inner = isObj(o.response) && isObj(o.response.response) ? o.response.response : undefined;
      if (inner && isObj(inner.account)) accounts.push(accountSignals(inner.account));
    } else if (o.type === "rate_limit_event") {
      const t = isObj(o.rate_limit_info) ? str(o.rate_limit_info.rateLimitType) : undefined;
      if (t !== undefined && SUBSCRIPTION_LIMITS.some((w) => t === w || t.startsWith(`${w}_`))) subscriptionLimit = true;
    }
  }
  if (!accounts.length) return undefined;
  const distinct = new Set(accounts.map((a) => JSON.stringify(a)));
  const acct = accounts[0]!;
  const providers = new Set<string>();
  if (acct.apiProvider !== undefined) providers.add(acct.apiProvider);
  for (const e of Object.values(input.modelUsage ?? {})) if (isObj(e) && str(e.provider) !== undefined) providers.add(str(e.provider)!);
  const thirdParty = [...providers].find((p) => p !== "firstParty");
  const provider = thirdParty ?? [...providers][0];
  const apiKeySource = initKeySource ?? acct.apiKeySource;
  const keySource = credential(initKeySource) ?? credential(acct.apiKeySource);
  const token = acct.tokenSource !== undefined && !NOT_A_TOKEN.has(acct.tokenSource) ? acct.tokenSource : undefined;
  const keyWins = !CREDENTIAL_PRECEDENCE_ENV_KEYS.some((k) => input.credentialEnv[k]);
  const oauth = token !== undefined && OAUTH_TOKEN_SOURCES.has(token);
  const basis: BillingBasis =
    thirdParty !== undefined
      ? "third_party"
      : distinct.size > 1
        ? "ambiguous"
        : keySource !== undefined && oauth
          ? subscriptionLimit
            ? "subscription"
            : keyWins
              ? "api_key"
              : "ambiguous"
          : oauth || acct.login
            ? "subscription"
            : keySource !== undefined && token === undefined
              ? "api_key"
              : "ambiguous";
  const costBasis = costBasisOf(input.modelUsage);
  return {
    ...(apiKeySource !== undefined ? { api_key_source: apiKeySource } : {}),
    ...(acct.tokenSource !== undefined ? { token_source: acct.tokenSource } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(costBasis !== undefined ? { cost_basis: costBasis } : {}),
    basis,
  };
}

/** A row's judge spend over its authored asserts: `judge_usd` sums the recorded `judgeCostUsd` of the asserts that
 *  CALLED the judge (`judgeModel` set — a pairwise assert whose every comparison was neutral never did), absent when
 *  none recorded one; `judge_unpriced` counts the judged asserts that recorded no cost (unpriced is never $0). */
export function judgeSpendOf(grades: ReadonlyArray<{ judgeModel?: string; judgeCostUsd?: number }>): {
  judge_usd?: number;
  judge_unpriced?: number;
} {
  const judged = grades.filter((g) => g.judgeModel !== undefined);
  const priced = judged.flatMap((g) => (typeof g.judgeCostUsd === "number" && Number.isFinite(g.judgeCostUsd) ? [g.judgeCostUsd] : []));
  const unpriced = judged.length - priced.length;
  return {
    ...(priced.length ? { judge_usd: priced.reduce((s, x) => s + x, 0) } : {}),
    ...(unpriced ? { judge_unpriced: unpriced } : {}),
  };
}

export interface CostSummary {
  /** summary.json's cost keys; a sum with nothing to sum is undefined (removed), never 0. */
  keys: {
    cost_usd_mean?: number;
    cost_usd_total?: number;
    cost_rows: number;
    cost_rows_unrecorded: number;
    judge_usd_mean?: number;
    judge_usd_total?: number;
    judge_rows_unpriced: number;
    judge_rows_unrecorded: number;
    regrade_judge_usd_total?: number;
    decider_usd_total?: number;
    billing_basis: BillingBasis | "mixed" | "unrecorded";
    billing_rows_unrecorded: number;
  };
  /** Scored rows behind `cost_usd_mean`. */
  scoredCostRows: number;
  /** Every `meta.billing.cost_basis` the rows record. */
  costBases: Set<string>;
}

type Row = Record<string, unknown> & { meta?: Record<string, unknown> };

function parseRows(text: string | null | undefined): Row[] {
  const out: Row[] = [];
  for (const line of (text ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (isObj(r)) out.push(r as Row);
    } catch {
      /* schema-check reports malformed lines */
    }
  }
  return out;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
/** Every sum and mean is written rounded to 6 decimals (a millionth of a dollar), never with float noise. */
const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;
const sum = (xs: number[]): number | undefined => (xs.length ? round6(xs.reduce((s, x) => s + x, 0)) : undefined);
const mean = (xs: number[]): number | undefined => (xs.length ? round6(xs.reduce((s, x) => s + x, 0) / xs.length) : undefined);

/** A row whose judge ran (`judge_model` or `judge_usage`) but that records none of its spend: no `judge_usd`, no
 *  `meta.judge_unpriced`, no `meta.regrade_judge_usd` — a row written before the spend was recorded. A row no judge
 *  read (a baseline row neutral against its own reference) has no `judge_model` and never counts. */
const judgeUnrecorded = (x: { r: Row; judge: number | undefined }): boolean =>
  (x.r.judge_model !== undefined || x.r.judge_usage !== undefined) &&
  x.judge === undefined &&
  x.r.meta?.judge_unpriced === undefined &&
  x.r.meta?.regrade_judge_usd === undefined;

/** A row filter that keeps one row per run (`meta.run_id`, never redacted); a row without one is its own run. */
function oncePerRun(): (r: Row) => boolean {
  const seen = new Set<string>();
  return (r) => {
    const id = typeof r.meta?.run_id === "string" ? r.meta.run_id : undefined;
    if (id === undefined) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  };
}

/** A variant's spend over its whole `results.jsonl` (scored rows) and `errors.jsonl` (failed attempts, whose spend sits
 *  in `meta`). One run is counted once (by `meta.run_id`, never redacted; a row without one is its own run). */
export function costSummary(results: string | null | undefined, errors: string | null | undefined): CostSummary {
  const once = oncePerRun();
  const rows = [
    ...parseRows(results)
      .filter(once)
      .map((r) => ({ r, scored: true, cost: num(r.cost_usd), judge: num(r.judge_usd), decider: num(r.decider_usd) })),
    ...parseRows(errors)
      .filter(once)
      .map((r) => ({ r, scored: false, cost: num(r.meta?.cost_usd), judge: num(r.meta?.judge_usd), decider: num(r.meta?.decider_usd) })),
  ];
  const costs = rows.flatMap((x) => (x.cost !== undefined ? [x.cost] : []));
  const scoredCosts = rows.flatMap((x) => (x.scored && x.cost !== undefined ? [x.cost] : []));
  const bases = new Set<string>();
  const costBases = new Set<string>();
  let billingUnrecorded = 0;
  for (const { r } of rows) {
    const b = isObj(r.meta?.billing) ? r.meta.billing : undefined;
    if (typeof b?.basis === "string") bases.add(b.basis);
    else billingUnrecorded++;
    if (typeof b?.cost_basis === "string") costBases.add(b.cost_basis);
  }
  return {
    keys: {
      cost_usd_mean: mean(scoredCosts),
      cost_usd_total: sum(costs),
      cost_rows: costs.length,
      cost_rows_unrecorded: rows.length - costs.length,
      // The same rows as cost_usd_mean (scored, with a cost); one with no judge_usd adds 0, so the two means add up to $/run.
      judge_usd_mean: mean(rows.flatMap((x) => (x.scored && x.cost !== undefined ? [x.judge ?? 0] : []))),
      judge_usd_total: sum(rows.flatMap((x) => (x.judge !== undefined ? [x.judge] : []))),
      judge_rows_unpriced: rows.filter((x) => (num(x.r.meta?.judge_unpriced) ?? 0) > 0).length,
      judge_rows_unrecorded: rows.filter(judgeUnrecorded).length,
      regrade_judge_usd_total: sum(
        rows.flatMap((x) => (x.scored && num(x.r.meta?.regrade_judge_usd) !== undefined ? [num(x.r.meta!.regrade_judge_usd)!] : [])),
      ),
      decider_usd_total: sum(rows.flatMap((x) => (x.decider !== undefined ? [x.decider] : []))),
      billing_basis: bases.size === 0 ? "unrecorded" : bases.size === 1 ? ([...bases][0] as BillingBasis) : "mixed",
      billing_rows_unrecorded: billingUnrecorded,
    },
    scoredCostRows: scoredCosts.length,
    costBases,
  };
}

const usd = (x: number): string => `$${x.toFixed(4)}`;

/** The pass's end-of-run cost line for a variant. */
export function costLine(variant: string, s: CostSummary): string {
  const k = s.keys;
  const basis =
    `basis ${k.billing_basis}` +
    (k.billing_basis === "subscription" ? " — cost_usd is the agent's list-price estimate, not a charge" : "") +
    (k.billing_basis === "mixed" ? " — compare cost only between rows of the same basis" : "") +
    (k.billing_rows_unrecorded && k.billing_basis !== "unrecorded" ? `; ${k.billing_rows_unrecorded} row(s) record no basis` : "") +
    (s.costBases.has("unknown")
      ? "; cost basis unknown — the agent had no price for a model and guessed cost_usd"
      : s.costBases.has("managed")
        ? "; cost basis managed — an organization price table set cost_usd"
        : "");
  const agent =
    k.cost_usd_total === undefined
      ? `agent cost not recorded on ${k.cost_rows_unrecorded} row(s)`
      : `agent ${usd(k.cost_usd_total)} over ${k.cost_rows} row(s)${k.cost_rows_unrecorded ? ` (${k.cost_rows_unrecorded} without a cost — a floor)` : ""}` +
        (k.cost_usd_mean !== undefined ? `, ${usd(k.cost_usd_mean)}/run over ${s.scoredCostRows} scored row(s)` : "");
  const parts = [agent];
  const judgeGaps = [
    ...(k.judge_rows_unpriced ? [`${k.judge_rows_unpriced} row(s) with an unpriced judge call`] : []),
    ...(k.judge_rows_unrecorded ? [`${k.judge_rows_unrecorded} row(s) whose judge cost was not recorded`] : []),
  ];
  if (k.judge_usd_total !== undefined || judgeGaps.length)
    parts.push(
      `judge ${k.judge_usd_total !== undefined ? usd(k.judge_usd_total) : "$0 recorded"}` +
        (judgeGaps.length ? ` (${judgeGaps.join(", ")} — a floor)` : ""),
    );
  if (k.regrade_judge_usd_total !== undefined)
    parts.push(`regrade judge ${usd(k.regrade_judge_usd_total)} (the last regrade per row — a floor)`);
  // A decider call that threw is never priced (RunResult.deciderCostUsd), so this is always a floor.
  if (k.decider_usd_total !== undefined) parts.push(`decider ${usd(k.decider_usd_total)} (a floor)`);
  return `[${variant}] cost (variant total; ${basis}): ${parts.join("; ")}`;
}

/** Above this share of a variant's `cost_usd`, models other than the main loop's are worth a warning: above the haiku
 *  helper's ceiling on kept runs (~20%), below the smallest real different-model sub-agent share (~48%). */
export const OTHER_MODEL_SHARE = 0.25;

/** Models other than each row's main-loop model, as a share of the variant's Σ`cost_usd` (rows that record a cost, a
 *  model and `meta.models`; one run counted once, as in `costSummary`). Undefined when there is nothing to measure. */
export function otherModelShare(results: string | null | undefined): { share: number; rows: number } | undefined {
  let total = 0;
  let other = 0;
  let n = 0;
  for (const r of parseRows(results).filter(oncePerRun())) {
    const cost = num(r.cost_usd);
    const models = isObj(r.meta?.models) ? r.meta.models : undefined;
    if (cost === undefined || typeof r.model !== "string" || models === undefined) continue;
    const main = normalizeModelId(r.model);
    n++;
    total += cost;
    for (const [m, e] of Object.entries(models)) if (normalizeModelId(m) !== main && isObj(e)) other += num(e.cost_usd) ?? 0;
  }
  return total > 0 ? { share: other / total, rows: n } : undefined;
}

const shareText = (s: { share: number; rows: number }) =>
  `models other than the main loop's carry ${Math.round(s.share * 100)}% of this variant's cost_usd (${s.rows} row(s)): \`usage\` covers the main model and its same-model sub-agents only; \`cost_usd\` covers every model — copy cost_usd, never derive cost from usage`;

/** The pass's warning when other models carry more than OTHER_MODEL_SHARE of the variant's cost. */
export function otherModelShareWarning(variant: string, results: string | null | undefined): string | undefined {
  const s = otherModelShare(results);
  return s !== undefined && s.share > OTHER_MODEL_SHARE ? `[${variant}] warning: ${shareText(s)}` : undefined;
}

/** `hillclimb check`'s note: the same measure, per variant. */
export function otherModelShareNotes(snap: FlowSnapshot): string[] {
  const out: string[] = [];
  for (const [v, vs] of Object.entries(snap.variants)) {
    const s = otherModelShare(vs.results);
    if (s !== undefined && s.share > OTHER_MODEL_SHARE) out.push(`note: ${v}: ${shareText(s)}`);
  }
  return out;
}
