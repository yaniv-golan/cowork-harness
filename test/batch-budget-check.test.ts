import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendIndexRow, type RunIndexRow } from "../src/run/run-index.js";
import { batchCostEstimateLine, checkBatchBudget, estimateBatchCost, noHistoryCauseText } from "../src/run/budget.js";
import { budgetStatus, resetBudgetStatus } from "../src/run/budget-status.js";

// The batch budget estimate gained a per-scenario multiplicity (an eval schedules 2 x reps runs of every
// scenario) and a non-exiting check beside the exiting `record` pre-flight. Both must leave `record`'s
// existing behaviour byte-identical: the string-only calls below were pinned against the code BEFORE the
// multiplicity existed, and pass on it unchanged.

let root: string;
let savedRunsDir: string | undefined;

function row(scenario: string, costUsd: number | undefined, i: number): RunIndexRow {
  return {
    v: 1,
    ts: `2026-09-${String(10 + i).padStart(2, "0")}T00:00:00.000Z`,
    command: "run",
    scenario,
    slug: scenario,
    runId: `local_${scenario}_${i}`,
    fidelity: "container",
    baseline: "desktop-1.0.0",
    result: "success",
    pass: true,
    signals: [],
    ...(costUsd !== undefined ? { costUsd } : {}),
    partial: false,
    nonDeterministic: false,
    outDir: join(root, scenario, `local_${i}`),
    git: { branch: null, sha: null },
  };
}

beforeEach(() => {
  resetBudgetStatus();
  savedRunsDir = process.env.COWORK_HARNESS_RUNS_DIR;
  root = mkdtempSync(join(tmpdir(), "batch-budget-check-"));
  process.env.COWORK_HARNESS_RUNS_DIR = root;
  // a: worst 1.5 over 3 priced runs; b: worst 0.25 over 1; c: one UNPRICED row only (no history).
  appendIndexRow(root, row("a", 1, 1));
  appendIndexRow(root, row("a", 1.5, 2));
  appendIndexRow(root, row("a", 0.5, 3));
  appendIndexRow(root, row("b", 0.25, 4));
  appendIndexRow(root, row("c", undefined, 5));
});

afterEach(() => {
  if (savedRunsDir === undefined) delete process.env.COWORK_HARNESS_RUNS_DIR;
  else process.env.COWORK_HARNESS_RUNS_DIR = savedRunsDir;
  vi.restoreAllMocks();
});

describe("estimateBatchCost — string items (record's call, regression pin)", () => {
  it("sums ONE worst per scenario and names the unpriced ones", () => {
    expect(estimateBatchCost(["a", "b", "c"])).toEqual({ known: 1.75, unpriced: ["c"], pricedRuns: 4, thinnest: 1 });
  });

  it("the estimate line is unchanged for record", () => {
    const est = estimateBatchCost(["a", "b", "c"]);
    expect(batchCostEstimateLine(["a", "b", "c"], est)).toBe(
      "estimated batch cost: $1.7500 — LOWER BOUND (1/3 scenario(s) have no priced run history and contribute $0: c) — " +
        "basis: 4 prior run(s) on THIS machine, thinnest scenario has 1; a max over that history, NOT a bound",
    );
  });
});

describe("estimateBatchCost — multiplicity", () => {
  it("multiplies each scenario's worst by its job count; strings keep jobs = 1", () => {
    const est = estimateBatchCost([{ scenario: "a", jobs: 10 }, "b", { scenario: "c", jobs: 4 }]);
    expect(est.known).toBeCloseTo(15.25, 12);
    expect(est.unpriced).toEqual(["c"]);
    // History counts are about the BASIS, not the schedule: they are not multiplied.
    expect(est.pricedRuns).toBe(4);
    expect(est.thinnest).toBe(1);
  });
});

describe("checkBatchBudget — the non-exiting gate", () => {
  it("refuses with a typed result and never exits the process", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    // a: worst $1.5 x 10 jobs = $15 > $9.
    const c = checkBatchBudget([{ scenario: "a", jobs: 10 }], 9);
    expect(exit).not.toHaveBeenCalled();
    expect(c.refuse).toBe(true);
    expect(c.status).toMatchObject({ capUsd: 9, basis: "batch", enforced: true, estimateUsd: 15, unpriced: [] });
    expect(c.status.runsDir).toBe(root);
    expect(c.refusal?.message).toMatch(/refused before spending/);
    // Pure: recording the marker is the caller's job, so a check alone leaves the invocation state untouched.
    expect(budgetStatus()).toBeUndefined();
  });

  it("proceeds at exactly the cap (strict >)", () => {
    const c = checkBatchBudget([{ scenario: "a", jobs: 10 }], 15);
    expect(c.refuse).toBe(false);
    expect(c.refusal).toBeUndefined();
    expect(c.notice).toMatch(/estimated batch cost: \$15\.0000/);
  });

  it("an unpriced scenario makes the status a lower bound with no_history, and a warning without the cause clause", () => {
    const c = checkBatchBudget([{ scenario: "c", jobs: 6 }], 5);
    expect(c.refuse).toBe(false);
    expect(c.status).toMatchObject({ enforced: "lower_bound", reason: "no_history", unpriced: ["c"] });
    expect(c.status.estimateUsd).toBeUndefined();
    expect(c.noHistoryWarning).toMatch(/1\/1 scenario\(s\) have no priced run history/);
  });

  it("the cause text names the redirect and can be read any number of times", () => {
    // The runs root is redirected to the temp dir here, so the cause is non-empty — and asking twice does
    // not consume the once-per-process note the exiting pre-flights use.
    const a = noHistoryCauseText();
    expect(a).toMatch(/--run-dir \/ COWORK_HARNESS_RUNS_DIR/);
    expect(noHistoryCauseText()).toBe(a);
  });
});

describe("the history seam: rows and runs dir passed in, instead of read from the runs root", () => {
  it("prices from the rows given (not the runs root's index) and reports the runs dir given", () => {
    // The runs root above has a/b/c; the rows passed in price only "z", at $2, so the result can only come from them.
    const rows = [{ ...row("z", 2, 1) }, { ...row("z", 1, 2) }];
    const src = { rows, runsDir: { runsDir: "/elsewhere/runs", runsDirRedirected: true } };
    expect(estimateBatchCost([{ scenario: "z", jobs: 3 }, "a"], src)).toEqual({ known: 6, unpriced: ["a"], pricedRuns: 2, thinnest: 2 });
    const c = checkBatchBudget([{ scenario: "z", jobs: 3 }], 5, src);
    expect(c.refuse).toBe(true);
    expect(c.status).toMatchObject({ estimateUsd: 6, runsDir: "/elsewhere/runs", runsDirRedirected: true, enforced: true });
    // Without the seam the same call reads the runs root, where "z" has never run.
    expect(checkBatchBudget([{ scenario: "z", jobs: 3 }], 5).status.unpriced).toEqual(["z"]);
  });
});
