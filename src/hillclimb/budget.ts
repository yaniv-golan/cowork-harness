// `hillclimb run --max-budget-usd`: a per-pass spend cap, checked before each slot starts.
//
// A slot is admitted only when what the pass has already committed (spent, plus the estimate of every slot still in
// flight) plus its own estimate stays within the cap. A finished slot's reservation is replaced by its charge: its
// row's agent + judge + LLM-decider spend. A row with no agent cost (a timeout, a crash) is charged at least its
// estimate, so an unpriced slot never counts as free.
//
// The estimate for a case, in order:
//   1. the p95 of this variant's scored rows for the case (agent + judge + decider), this pass's included;
//   2. else the case's worst agent-only run on any baseline in the run index (the fallback excludes judge spend);
//   3. else 0 — then the cap is checked on what the slot actually spent, once it finishes. Such slots run one at a
//      time: while one is in flight no other unestimated slot starts, so the pass can pass the cap by at most one
//      slot's cost. Once a slot of the case is priced, the next one has an estimate. One that finishes with no price
//      leaves nothing to charge, so no further slot of the pass starts: the cap could no longer be enforced.

import { percentile } from "../run/run-index.js";
import { parseRows, type Row } from "./cost.js";

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** A row's spend: agent + judge + decider, read from where each file keeps it. `agentPriced` is false when the row has
 *  no agent cost. */
export function rowSpend(row: Row, scored: boolean): { usd: number; agentPriced: boolean } {
  const at = (k: string) => num(scored ? row[k] : row.meta?.[k]);
  const agent = at("cost_usd");
  return { usd: (agent ?? 0) + (at("judge_usd") ?? 0) + (at("decider_usd") ?? 0), agentPriced: agent !== undefined };
}

/** The scored spends of a variant's `results.jsonl`, per case id (rows with an agent cost only). */
export function scoredSpendByCase(results: string | null | undefined): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const r of parseRows(results)) {
    if (typeof r.prompt_id !== "string") continue;
    const s = rowSpend(r, true);
    if (!s.agentPriced) continue;
    out.set(r.prompt_id, [...(out.get(r.prompt_id) ?? []), s.usd]);
  }
  return out;
}

export type EstimateSource = "variant_p95" | "index_worst" | "none";

/** The ladder above for one case. */
export function caseEstimate(
  spends: readonly number[] | undefined,
  indexWorstUsd: number | undefined,
): { usd: number; source: EstimateSource } {
  if (spends?.length)
    return {
      usd: percentile(
        [...spends].sort((a, b) => a - b),
        0.95,
      ),
      source: "variant_p95",
    };
  if (indexWorstUsd !== undefined) return { usd: indexWorstUsd, source: "index_worst" };
  return { usd: 0, source: "none" };
}

const usd = (x: number): string => `$${x.toFixed(4)}`;

/** The pass's ledger. Single-threaded: every admit/settle runs to completion between awaits. */
/** An admitted slot's reservation: its estimate, and whether it had none (priced at $0). */
export interface Reservation {
  usd: number;
  unestimated: boolean;
}

export class BudgetLedger {
  spent: number;
  private inFlight = 0;
  /** Finished slots with no agent cost, each charged at least its estimate. */
  unpriced = 0;
  private readonly spends: Map<string, number[]>;
  private readonly unestimated = new Set<string>();
  private readonly indexWorst: (caseId: string) => number | undefined;
  private unestimatedInFlight = 0;
  private waiters: Array<() => void> = [];
  /** The case of an unestimated slot that finished with no agent cost: from here on the cap cannot be enforced. */
  uncharged: string | undefined;

  constructor(
    readonly capUsd: number,
    o: { startUsd?: number; results: string | null | undefined; indexWorstUsd: (caseId: string) => number | undefined },
    private readonly say: (line: string) => void,
  ) {
    this.spent = o.startUsd ?? 0;
    this.spends = scoredSpendByCase(o.results);
    this.indexWorst = o.indexWorstUsd;
  }

  get committed(): number {
    return this.spent + this.inFlight;
  }

  estimate(caseId: string): number {
    const e = caseEstimate(this.spends.get(caseId), this.indexWorst(caseId));
    if (e.source === "none" && !this.unestimated.has(caseId)) {
      this.unestimated.add(caseId);
      this.say(`budget: case ${caseId} has no cost history — its slots are estimated at $0, so the cap is checked on what each one spends`);
    }
    return e.usd;
  }

  /** Reserve the slot's estimate when it fits; undefined when it would cross the cap; "wait" when it has no estimate
   *  and another unestimated slot is in flight (await `settled()`, then ask again); "uncharged" once an unestimated slot
   *  finished with no price (no slot starts after that). */
  admit(caseId: string): Reservation | undefined | "wait" | "uncharged" {
    if (this.uncharged !== undefined) return "uncharged";
    const unestimated = caseEstimate(this.spends.get(caseId), this.indexWorst(caseId)).source === "none";
    if (unestimated && this.unestimatedInFlight > 0) return "wait";
    const est = this.estimate(caseId);
    if (this.committed + est > this.capUsd) return undefined;
    this.inFlight += est;
    if (unestimated) this.unestimatedInFlight++;
    return { usd: est, unestimated };
  }

  /** Resolves at the next `settle`. */
  settled(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** The slot finished: its reservation becomes its charge. `row` is what it wrote (undefined: nothing was written). */
  settle(caseId: string, reserved: Reservation, row: { row: Row; scored: boolean } | undefined): void {
    this.inFlight -= reserved.usd;
    if (reserved.unestimated) this.unestimatedInFlight--;
    const s = row ? rowSpend(row.row, row.scored) : { usd: 0, agentPriced: false };
    if (!s.agentPriced) {
      this.unpriced++;
      if (reserved.unestimated) this.uncharged ??= caseId;
    }
    this.spent += s.agentPriced ? s.usd : Math.max(s.usd, reserved.usd);
    if (row?.scored && s.agentPriced) this.spends.set(caseId, [...(this.spends.get(caseId) ?? []), s.usd]);
    for (const w of this.waiters.splice(0)) w();
  }

  /** `spent $x of the $cap cap (unpriced N)`. */
  text(): string {
    return `spent ${usd(this.spent)} of the ${usd(this.capUsd)} cap${this.unpriced ? ` (unpriced ${this.unpriced}: charged at their estimate)` : ""}`;
  }
}

export class BudgetStopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetStopError";
  }
}
