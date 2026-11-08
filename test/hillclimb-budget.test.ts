// `hillclimb run --max-budget-usd`'s ledger: a slot starts while spend, plus in-flight estimates, plus its own estimate
// stays WITHIN the cap — a slot landing exactly on it starts.
import { describe, it, expect } from "vitest";
import { BudgetLedger } from "../src/hillclimb/budget.js";

const ledger = (cap: number, startUsd: number, worst: number | undefined) =>
  new BudgetLedger(cap, { startUsd, results: null, indexWorstUsd: () => worst }, () => {});

describe("BudgetLedger.admit", () => {
  it("admits a slot whose estimate lands exactly on the cap, and nothing after it", () => {
    const b = ledger(1, 0.5, 0.5);
    expect(b.admit("c")).toEqual({ usd: 0.5, unestimated: false });
    expect(b.committed).toBe(1);
    expect(b.admit("c")).toBeUndefined();
  });

  it("refuses a slot whose estimate would cross the cap, counting the slots in flight", () => {
    const b = ledger(1, 0, 0.5);
    expect(b.admit("c")).toEqual({ usd: 0.5, unestimated: false });
    expect(b.admit("c")).toEqual({ usd: 0.5, unestimated: false });
    expect(b.admit("c")).toBeUndefined();
  });

  it("with no estimate, one slot at a time: a second waits until the first settles, then is priced by it", async () => {
    const b = ledger(10, 0, undefined);
    const first = b.admit("c");
    expect(first).toEqual({ usd: 0, unestimated: true });
    expect(b.admit("c")).toBe("wait");
    // Another case with history is not held back.
    const other = new BudgetLedger(10, { results: null, indexWorstUsd: (id) => (id === "d" ? 1 : undefined) }, () => {});
    other.admit("c");
    expect(other.admit("d")).toEqual({ usd: 1, unestimated: false });
    const next = b.settled();
    b.settle("c", first as { usd: number; unestimated: boolean }, { row: { prompt_id: "c", cost_usd: 2 }, scored: true });
    await next;
    expect(b.admit("c")).toEqual({ usd: 2, unestimated: false });
  });
});
