// `hillclimb run --max-budget-usd`'s ledger: a slot starts while spend, plus in-flight estimates, plus its own estimate
// stays WITHIN the cap — a slot landing exactly on it starts.
import { describe, it, expect } from "vitest";
import { BudgetLedger } from "../src/hillclimb/budget.js";

const ledger = (cap: number, startUsd: number, worst: number | undefined) =>
  new BudgetLedger(cap, { startUsd, results: null, indexWorstUsd: () => worst }, () => {});

describe("BudgetLedger.admit", () => {
  it("admits a slot whose estimate lands exactly on the cap, and nothing after it", () => {
    const b = ledger(1, 0.5, 0.5);
    expect(b.admit("c")).toBe(0.5);
    expect(b.committed).toBe(1);
    expect(b.admit("c")).toBeUndefined();
  });

  it("refuses a slot whose estimate would cross the cap, counting the slots in flight", () => {
    const b = ledger(1, 0, 0.5);
    expect(b.admit("c")).toBe(0.5);
    expect(b.admit("c")).toBe(0.5);
    expect(b.admit("c")).toBeUndefined();
  });
});
