// The hillclimb cost path: the billing basis a run's own credential frames record, and the per-variant spend summary.
//
// Frames come from test/fixtures/hillclimb-runs/account-frames.json: real frame shapes from kept runs, identity values
// replaced (see that directory's README). One billing case per row of the credential census of the kept runs.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { billingOf, costLine, costSummary, judgeSpendOf, otherModelShareWarning } from "../src/hillclimb/cost.js";

const FX = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "hillclimb-runs", "account-frames.json"), "utf8")) as Record<
  string,
  object
>;
const f = (...names: string[]) => names.map((n) => JSON.stringify(FX[n]));
const LOCAL = "local-agent";
const mu = (entries: Record<string, Record<string, unknown>>) => entries;
const listed = mu({ "claude-opus-5": { costUSD: 0.2, provider: "firstParty", costBasis: "list" } });

describe("billingOf: the basis rule, one case per census row", () => {
  it("hostloop/container/microvm, OAuth token only, rate-limited ⇒ subscription", () => {
    const b = billingOf({ events: f("init_none", "account_oauth", "rate_limit_five_hour"), modelUsage: listed, entrypoint: LOCAL });
    expect(b).toEqual({
      api_key_source: "none",
      token_source: "CLAUDE_CODE_OAUTH_TOKEN",
      provider: "firstParty",
      cost_basis: "list",
      basis: "subscription",
    });
  });

  it("OAuth token only, no rate-limit frame ⇒ still subscription (the token source decides)", () => {
    expect(billingOf({ events: f("init_none", "account_oauth"), modelUsage: listed, entrypoint: LOCAL })?.basis).toBe("subscription");
  });

  it("API key AND OAuth token under local-agent with a subscription rate limit ⇒ subscription", () => {
    for (const rl of ["rate_limit_five_hour", "rate_limit_seven_day"])
      expect(billingOf({ events: f("init_api_key", "account_oauth_and_key", rl), modelUsage: listed, entrypoint: LOCAL })?.basis).toBe(
        "subscription",
      );
  });

  it("API key AND OAuth token under local-agent with no rate-limit frame ⇒ ambiguous", () => {
    expect(billingOf({ events: f("init_api_key", "account_oauth_and_key"), modelUsage: listed, entrypoint: LOCAL })?.basis).toBe(
      "ambiguous",
    );
  });

  it("API key AND OAuth token without the local-agent entrypoint (protocol) ⇒ api_key: the key wins there", () => {
    expect(billingOf({ events: f("init_api_key", "account_oauth_and_key"), modelUsage: listed, entrypoint: undefined })?.basis).toBe(
      "api_key",
    );
  });

  it("protocol, API key, no token ⇒ api_key; microvm with the same frames ⇒ api_key", () => {
    for (const entrypoint of [undefined, LOCAL])
      expect(billingOf({ events: f("init_api_key", "account_key"), modelUsage: listed, entrypoint })).toEqual({
        api_key_source: "ANTHROPIC_API_KEY",
        token_source: "none",
        provider: "firstParty",
        cost_basis: "list",
        basis: "api_key",
      });
  });

  it("protocol on a claude.ai login (a subscriptionType key, no token source) ⇒ subscription, and no identity value is copied", () => {
    const b = billingOf({ events: f("init_none", "account_login", "rate_limit_seven_day"), modelUsage: listed, entrypoint: undefined });
    expect(b).toEqual({ api_key_source: "none", provider: "firstParty", cost_basis: "list", basis: "subscription" });
    const text = JSON.stringify(b);
    for (const leak of ["subscriptionType", "organization", "email", "user@example.invalid", "Example Org", "example-plan"])
      expect(text).not.toContain(leak);
  });

  it("no credential at all (none/none) ⇒ ambiguous", () => {
    expect(billingOf({ events: f("init_none", "account_none"), modelUsage: {}, entrypoint: LOCAL })?.basis).toBe("ambiguous");
  });

  it("ANTHROPIC_AUTH_TOKEN (a bearer token of unknown kind) ⇒ ambiguous", () => {
    expect(billingOf({ events: f("init_none", "account_auth_token"), modelUsage: listed, entrypoint: undefined })?.basis).toBe("ambiguous");
  });

  it("a provider other than firstParty ⇒ third_party, from the account frame or modelUsage", () => {
    expect(billingOf({ events: f("init_none", "account_bedrock"), modelUsage: {}, entrypoint: LOCAL })).toMatchObject({
      provider: "bedrock",
      basis: "third_party",
    });
    expect(
      billingOf({
        events: f("init_api_key", "account_key"),
        modelUsage: mu({ "claude-opus-5": { costUSD: 0.1, provider: "vertex" } }),
        entrypoint: undefined,
      }),
    ).toMatchObject({ provider: "vertex", basis: "third_party" });
  });

  it("two account frames that disagree ⇒ ambiguous", () => {
    expect(billingOf({ events: f("init_api_key", "account_key", "account_oauth"), modelUsage: listed, entrypoint: undefined })?.basis).toBe(
      "ambiguous",
    );
  });

  it("no account frame (a run that never initialized, an older binary) ⇒ absent, never guessed", () => {
    expect(billingOf({ events: f("init_api_key"), modelUsage: listed, entrypoint: undefined })).toBeUndefined();
    expect(billingOf({ events: [], modelUsage: undefined, entrypoint: LOCAL })).toBeUndefined();
  });

  it("cost_basis: absent ⇒ list; managed and unknown are kept, unknown first", () => {
    const cb = (m: Record<string, Record<string, unknown>>) =>
      billingOf({ events: f("init_api_key", "account_key"), modelUsage: m, entrypoint: undefined })?.cost_basis;
    expect(cb({ a: { costUSD: 1 } })).toBe("list");
    expect(cb({ a: { costUSD: 1, costBasis: "managed" }, b: { costUSD: 1, costBasis: "list" } })).toBe("managed");
    expect(cb({ a: { costUSD: 1, costBasis: "unknown" }, b: { costUSD: 1, costBasis: "managed" } })).toBe("unknown");
    expect(cb({})).toBeUndefined();
  });
});

describe("judgeSpendOf: only asserts that called the judge count", () => {
  it("sums judgeCostUsd and counts judged asserts with no cost; an unjudged assert (a neutral own-reference pairwise) is neither", () => {
    const grades = [
      { judgeModel: "claude-haiku-5", judgeCostUsd: 0.01 },
      { judgeModel: "claude-haiku-5", judgeCostUsd: 0.02 },
      { judgeModel: "claude-haiku-5" }, // judged, unpriced
      { pairwise: [{ ref: "baseline", status: "neutral", value: 0.5 }] }, // never judged
      {},
    ];
    expect(judgeSpendOf(grades as never)).toEqual({ judge_usd: 0.03, judge_unpriced: 1 });
  });
  it("nothing judged ⇒ neither key", () => {
    expect(judgeSpendOf([{ pairwise: [{ ref: "baseline", status: "neutral", value: 0.5 }] }, {}] as never)).toEqual({});
  });
  it("judged but no cost at all ⇒ judge_unpriced only, never a $0 judge_usd", () => {
    expect(judgeSpendOf([{ judgeModel: "m" }] as never)).toEqual({ judge_unpriced: 1 });
  });
});

const row = (o: Record<string, unknown>) => JSON.stringify(o);
const jsonl = (...rows: Array<Record<string, unknown>>) => rows.map(row).join("\n") + "\n";

describe("costSummary: the variant's spend over results.jsonl + errors.jsonl", () => {
  const results = jsonl(
    {
      prompt_id: "a",
      rep: 0,
      cost_usd: 0.2,
      judge_usd: 0.01,
      decider_usd: 0.001,
      meta: { run_id: "r1", billing: { basis: "subscription" } },
    },
    {
      prompt_id: "a",
      rep: 1,
      cost_usd: 0.4,
      meta: { run_id: "r2", billing: { basis: "subscription" }, judge_unpriced: 1, regrade_judge_usd: 0.05 },
    },
    { prompt_id: "b", rep: 0, meta: { run_id: "r3" } }, // no cost recorded
    { prompt_id: "a", rep: 1, cost_usd: 0.4, meta: { run_id: "r2", billing: { basis: "subscription" } } }, // the same run twice
  );
  const errors = jsonl({
    prompt_id: "b",
    rep: 1,
    failure_class: "error",
    meta: { run_id: "r4", cost_usd: 0.1, judge_usd: 0.02, billing: { basis: "subscription" } },
  });

  it("totals over every row, the mean over scored rows that record a cost; unrecorded rows are counted, never $0; one run counted once", () => {
    const s = costSummary(results, errors);
    // Rounded to 6 decimals at write: no 0.30000000000000004.
    expect(s.keys).toEqual({
      cost_usd_mean: 0.3,
      cost_usd_total: 0.7,
      cost_rows: 3,
      cost_rows_unrecorded: 1,
      // the same denominator as cost_usd_mean: 0.01 over the 2 scored rows with a cost
      judge_usd_mean: 0.005,
      judge_usd_total: 0.03,
      judge_rows_unpriced: 1,
      judge_rows_unrecorded: 0,
      regrade_judge_usd_total: 0.05,
      decider_usd_total: 0.001,
      billing_basis: "subscription",
      billing_rows_unrecorded: 1,
    });
    expect(s.scoredCostRows).toBe(2);
  });

  it("billing_basis: mixed when two recorded values differ; unrecorded when no row records one", () => {
    expect(
      costSummary(
        jsonl({ cost_usd: 1, meta: { billing: { basis: "api_key" } } }, { cost_usd: 1, meta: { billing: { basis: "subscription" } } }),
        null,
      ).keys.billing_basis,
    ).toBe("mixed");
    const none = costSummary(jsonl({ cost_usd: 1, meta: {} }), null).keys;
    expect(none.billing_basis).toBe("unrecorded");
    expect(none.billing_rows_unrecorded).toBe(1);
  });

  it("no cost anywhere ⇒ the sums are absent (undefined removes them), the counts are 0-based", () => {
    const s = costSummary(jsonl({ prompt_id: "a", rep: 0, meta: {} }), null).keys;
    expect(s.cost_usd_total).toBeUndefined();
    expect(s.cost_usd_mean).toBeUndefined();
    expect(s.judge_usd_total).toBeUndefined();
    expect(s.cost_rows).toBe(0);
    expect(s.cost_rows_unrecorded).toBe(1);
  });

  it("the end-of-run line names the basis, the totals and what is a floor", () => {
    expect(costLine("v1", costSummary(results, errors))).toBe(
      "[v1] cost (variant total; basis subscription — cost_usd is the agent's list-price estimate, not a charge; 1 row(s) record no basis): agent $0.7000 over 3 row(s) (1 without a cost — a floor), $0.3000/run over 2 scored row(s); judge $0.0300 (1 row(s) with an unpriced judge call — a floor); regrade judge $0.0500 (the last regrade per row — a floor); decider $0.0010",
    );
    expect(
      costLine("v2", costSummary(jsonl({ cost_usd: 0.5, meta: { billing: { basis: "api_key", cost_basis: "managed" } } }), null)),
    ).toBe(
      "[v2] cost (variant total; basis api_key; cost basis managed — an organization price table set cost_usd): agent $0.5000 over 1 row(s), $0.5000/run over 1 scored row(s)",
    );
  });
});

describe("costSummary: judge_usd_mean, judge_rows_unrecorded and the floor", () => {
  it("judge_usd_mean shares cost_usd_mean's denominator: 4 scored rows with a cost, 1 judged at 0.02 ⇒ 0.005", () => {
    const k = costSummary(
      jsonl(
        { cost_usd: 0.1, judge_usd: 0.02, meta: { run_id: "a" } },
        { cost_usd: 0.1, meta: { run_id: "b" } },
        { cost_usd: 0.1, meta: { run_id: "c" } },
        { cost_usd: 0.1, meta: { run_id: "d" } },
      ),
      null,
    ).keys;
    expect(k.judge_usd_mean).toBe(0.005);
    expect(k.cost_usd_mean).toBe(0.1);
  });

  it("every sum and mean is rounded to 6 decimals", () => {
    const k = costSummary(jsonl({ cost_usd: 0.1, meta: { run_id: "a" } }, { cost_usd: 0.2, meta: { run_id: "b" } }), null).keys;
    expect(k.cost_usd_total).toBe(0.3);
    expect(k.cost_usd_mean).toBe(0.15);
    expect(costSummary(jsonl({ cost_usd: 0.1234567891 }), null).keys.cost_usd_total).toBe(0.123457);
  });

  it("judge_rows_unrecorded: a judge that ran (judge_model or judge_usage) with no judge_usd, no judge_unpriced, no regrade spend", () => {
    const k = costSummary(
      jsonl(
        // old-shape rows, written before judge_usd existed: they count
        { cost_usd: 0.1, judge_model: "claude-haiku-5", judge_usage: { input_tokens: 1 }, meta: { run_id: "old1" } },
        { cost_usd: 0.1, judge_usage: { input_tokens: 1 }, meta: { run_id: "old2" } },
        // a baseline row neutral against its own reference: no judge ran, never counts
        { cost_usd: 0.1, meta: { run_id: "neutral" } },
        // a --fill-refs baseline row: its judge spend is the regrade's
        { cost_usd: 0.1, judge_model: "claude-haiku-5", meta: { run_id: "fill", regrade_judge_usd: 0.03 } },
        // priced, or marked unpriced: not unrecorded
        { cost_usd: 0.1, judge_model: "m", judge_usd: 0.01, meta: { run_id: "p" } },
        { cost_usd: 0.1, judge_model: "m", meta: { run_id: "u", judge_unpriced: 1 } },
      ),
      jsonl({ failure_class: "judge_invalid", judge_model: "m", meta: { run_id: "e" } }),
    ).keys;
    expect(k.judge_rows_unrecorded).toBe(3);
    expect(k.judge_rows_unpriced).toBe(1);
  });

  it("old-shape rows alone: the line names them and says the judge figure is a floor", () => {
    const line = costLine(
      "v1",
      costSummary(jsonl({ cost_usd: 0.1, judge_model: "m", judge_usage: { input_tokens: 1 }, meta: { run_id: "x" } }), null),
    );
    expect(line).toContain("judge $0 recorded (1 row(s) whose judge cost was not recorded — a floor)");
  });

  it("mixed: the line says to compare only rows of the same basis", () => {
    const line = costLine(
      "v1",
      costSummary(
        jsonl(
          { cost_usd: 1, meta: { run_id: "a", billing: { basis: "api_key" } } },
          { cost_usd: 1, meta: { run_id: "b", billing: { basis: "subscription" } } },
        ),
        null,
      ),
    );
    expect(line).toContain("basis mixed — compare cost only between rows of the same basis");
  });
});

describe("otherModelShareWarning: other models' share of the variant's cost_usd", () => {
  const r = (main: string, models: Record<string, number>) =>
    row({
      model: main,
      cost_usd: Object.values(models).reduce((s, x) => s + x, 0),
      meta: { models: Object.fromEntries(Object.entries(models).map(([m, c]) => [m, { cost_usd: c }])) },
    });
  it("warns above 25%, matching the main model with normalizeModelId ([1m] is the same model)", () => {
    const w = otherModelShareWarning("v1", [r("claude-opus-5", { "claude-opus-5[1m]": 0.5, "claude-sonnet-5": 0.5 })].join("\n"));
    expect(w).toBe(
      "[v1] warning: models other than the main loop's carry 50% of this variant's cost_usd (1 row(s)): `usage` covers the main model and its same-model sub-agents only; `cost_usd` covers every model — copy cost_usd, never derive cost from usage",
    );
  });
  it("is silent at or below 25% (the haiku helper's traffic)", () => {
    expect(otherModelShareWarning("v1", r("claude-opus-5", { "claude-opus-5": 0.8, "claude-haiku-4-5-20251001": 0.2 }))).toBeUndefined();
    expect(otherModelShareWarning("v1", "")).toBeUndefined();
  });
});
