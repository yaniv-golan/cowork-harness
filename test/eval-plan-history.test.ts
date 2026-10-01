// The eval planner's history loader: which index rows and result.json files feed the cost and rate bases.
//
// Fixture provenance: every result below is an EDITED COPY of a committed excerpt of a real kept run in
// test/fixtures/eval-classify/ (read at test time, never rebuilt from scratch), so every field the real
// producer stamps or omits is the producer's. The edits, per use:
//   - success-semantic.json: the passing multi-assertion base. Edits: `models` / `modelPinHonored` (pin
//     cases), `fingerprint.contentSig` (exact-content cases), `ablated: true`, one grade's `pass` flipped
//     (rate cases), a `judgePromptHash` on the semantic grade (prompt-mismatch case).
//   - exit-agent.json: an agent-error rep. Edits: `models` set to the pin (so only the termination
//     differs), to another live model, or emptied with `modelUsage` removed (a crash before any model
//     answered).
//   - auth-exit.json: an infrastructure (sign-in) failure, used as is.
//   - slash-success-synthetic.json: a `/plugin:skill` run whose main loop reports only `<synthetic>`, so
//     only `modelUsage` vouches for the model. Used as is.
//   - success-semantic.json also gets a `judgeModel` on its semantic grade (judge-model cases), and the
//     run fields `indexRowFromResult` reads (`outDir`, `fidelity`, `baseline`, `turn`) for the producer case.
// Every copy also has its `scenario` renamed to the test scenario.
import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Assertion, RunResult } from "../src/types.js";
import { buildStats, indexRowFromResult, type RunIndexRow } from "../src/run/run-index.js";
import { HILLCLIMB_LABEL_PREFIX, loadCostHistory, loadRowHistory, type RowHistoryOptions } from "../src/eval/plan-history.js";
import { estimateScheduleCost, perRepCost } from "../src/eval/planner.js";

const FX = join(import.meta.dirname, "fixtures", "eval-classify");
const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(FX, name), "utf8"));

const PIN = "claude-sonnet-5";
const SCEN = "plan-scen";
const BASELINE = "desktop-1.0.0";
const SIG_A = "a".repeat(64);
const SIG_OTHER = "b".repeat(64);

/** The frozen scenario's assertions: exactly the base fixture's own grades' assertions. */
const ASSERTIONS = (fixture("success-semantic.json").assertions as Array<{ assertion: Assertion }>).map((g) => g.assertion);
const SEMANTIC_INDEX = ASSERTIONS.findIndex((a) => a.semantic_matches !== undefined);

let root: string;
let seq: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "plan-history-"));
  seq = 0;
});

type Edit = (r: Record<string, unknown>) => void;

function passing(edit?: Edit): Record<string, unknown> {
  const r = fixture("success-semantic.json");
  r.scenario = SCEN;
  (r.fingerprint as Record<string, unknown>).contentSig = SIG_OTHER;
  edit?.(r);
  return r;
}

/** Fail one structural assertion (index 0) — a rate the tests can count. */
const failRow0: Edit = (r) => {
  (r.assertions as Array<{ pass: boolean }>)[0].pass = false;
};

/** Write a run dir with turns/1/result.json (unless `result` is undefined = pruned) and return its index row. */
function run(result: Record<string, unknown> | undefined | "garbage", row: Partial<RunIndexRow> = {}): RunIndexRow {
  const i = ++seq;
  const outDir = join(root, SCEN, `local_${i}`);
  if (result !== undefined) {
    mkdirSync(join(outDir, "turns", String(row.turn ?? 1)), { recursive: true });
    writeFileSync(join(outDir, "turns", String(row.turn ?? 1), "result.json"), result === "garbage" ? "{not json" : JSON.stringify(result));
  }
  return {
    v: 1,
    // Newer runs get later timestamps; the order rows are passed in is irrelevant.
    ts: new Date(Date.UTC(2026, 8, 1) + i * 60_000).toISOString(),
    command: "run",
    scenario: SCEN,
    slug: SCEN,
    runId: `local_${i}`,
    fidelity: "container",
    baseline: BASELINE,
    result: "success",
    pass: true,
    signals: [],
    costUsd: 1,
    turn: 1,
    partial: false,
    nonDeterministic: false,
    outDir,
    git: { branch: null, sha: null },
    ...row,
  };
}

const opts = (o: Partial<RowHistoryOptions> = {}): RowHistoryOptions => ({
  scenario: SCEN,
  baseline: BASELINE,
  tier: "container",
  assertions: ASSERTIONS,
  agentPin: PIN,
  ...o,
});

const rowById = (h: ReturnType<typeof loadRowHistory>, assertionIndex: number, kind = "assertion") =>
  h.rows.find((r) => r.row.assertionIndex === assertionIndex && r.row.kind === kind)!.history;

describe("loadRowHistory — the eval's own classifier over history", () => {
  it("a valid passing rep scores 1 on every row", () => {
    const h = loadRowHistory([run(passing())], opts());
    expect(h.reps).toBe(1);
    expect(h.rows.every((r) => r.history.k === 1 && r.history.n === 1)).toBe(true);
  });

  it("an agent-error rep is 0 on every row (intention to treat)", () => {
    const err = fixture("exit-agent.json");
    err.scenario = SCEN;
    err.models = [PIN, "<synthetic>"];
    const h = loadRowHistory([run(err)], opts());
    expect(h.rows.every((r) => r.history.k === 0 && r.history.n === 1)).toBe(true);
    expect(h.validReps).toBe(1);
  });

  it("an auth-failure rep is excluded as infrastructure — not as a model mismatch", () => {
    const auth = fixture("auth-exit.json");
    auth.scenario = SCEN;
    const h = loadRowHistory([run(auth)], opts());
    expect(h.excludedByKey.model).toBe(0);
    expect(h.reps).toBe(1);
    expect(h.validReps).toBe(0);
    expect(h.rows.every((r) => r.history.n === 0 && r.history.excluded?.errored_infra === 1)).toBe(true);
  });

  it("a changed assertion is grade_misaligned for that row only", () => {
    const changed = ASSERTIONS.map((a, i) => (i === 1 ? ({ ...a, extra_key_for_test: true } as unknown as Assertion) : a));
    const h = loadRowHistory([run(passing())], opts({ assertions: changed }));
    expect(rowById(h, 1).excluded?.grade_misaligned).toBe(1);
    expect(rowById(h, 0)).toMatchObject({ k: 1, n: 1 });
  });

  it("a run on a different model is excluded by the model key, counted by model", () => {
    const h = loadRowHistory(
      [
        run(
          passing((r) => {
            r.models = ["claude-opus-5"];
          }),
        ),
        run(passing()),
      ],
      opts(),
    );
    expect(h.excludedByKey.model).toBe(1);
    expect(h.modelsExcluded).toEqual({ "claude-opus-5": 1 });
    expect(h.reps).toBe(1);
  });

  it("the pin is re-derived against the eval's pin, not read from the run's own stamp", () => {
    // A run whose own pin was an alias persisted `modelPinHonored` as unverifiable; against a concrete eval
    // pin its live model is checkable and matches. It must count, not fall to `model_mismatch`.
    const h = loadRowHistory(
      [
        run(
          passing((r) => {
            delete r.modelPinHonored;
          }),
        ),
      ],
      opts(),
    );
    expect(h.excludedByKey.model).toBe(0);
    expect(h.rows.every((r) => r.history.k === 1 && r.history.n === 1)).toBe(true);
  });

  it("a prompt-hash mismatch drops only the semantic rows of that rep", () => {
    const r = passing((x) => {
      (x.assertions as Array<Record<string, unknown>>)[SEMANTIC_INDEX].judgePromptHash = "old-prompt";
    });
    const h = loadRowHistory([run(r)], opts({ judgePromptHash: "new-prompt" }));
    expect(rowById(h, 0)).toMatchObject({ k: 1, n: 1 });
    expect(rowById(h, SEMANTIC_INDEX, "semantic_rollup").excluded?.judge_prompt_mismatch).toBe(1);
    expect(h.rows.filter((x) => x.row.kind === "claim").every((x) => x.history.excluded?.judge_prompt_mismatch === 1)).toBe(true);
  });

  it("counts exact-content and earlier-eval reps", () => {
    const h = loadRowHistory(
      [
        run(
          passing((r) => {
            (r.fingerprint as Record<string, unknown>).contentSig = SIG_A;
          }),
          { runLabel: "eval:abc:a" },
        ),
        run(passing()),
      ],
      opts({ armASig: SIG_A }),
    );
    expect(h.exactContentReps).toBe(1);
    expect(h.evalReps).toBe(1);
  });
});

describe("loadRowHistory — hard keys, each exclusion counted", () => {
  it("tier, baseline, command, turn, hillclimb, ablated, pruned, unreadable", () => {
    const rows = [
      run(passing()), // kept
      run(passing(), { fidelity: "hostloop" }), // tier
      run(passing(), { baseline: "desktop-0.9.0" }), // baseline
      run(passing(), { command: "chat" }), // command
      run(passing(), { turn: 2 }), // turn
      run(passing(), { runLabel: `${HILLCLIMB_LABEL_PREFIX}flow:v1` }), // hillclimb
      run(
        passing((r) => {
          r.ablated = true;
        }),
      ), // ablated
      run(undefined), // pruned
      run("garbage"), // unreadable
      run(passing(), { critiqueRole: "rollup" }), // not a run at all
    ];
    const h = loadRowHistory(rows, opts());
    expect(h.reps).toBe(1);
    expect(h.excludedByKey).toEqual({
      notRun: 1,
      command: 1,
      tier: 1,
      baseline: 1,
      turn: 1,
      hillclimb: 1,
      ablated: 1,
      model: 0,
      pruned: 1,
      unreadable: 1,
    });
  });

  it("an over-size result.json is unreadable, never guessed", () => {
    const h = loadRowHistory([run(passing())], opts({ maxResultBytes: 100 }));
    expect(h.excludedByKey.unreadable).toBe(1);
    expect(h.reps).toBe(0);
  });

  it("hillclimb runs can be included behind the option (default: excluded)", () => {
    const rows = [run(passing(), { runLabel: `${HILLCLIMB_LABEL_PREFIX}flow:v1` })];
    expect(loadRowHistory(rows, opts()).reps).toBe(0);
    expect(loadRowHistory(rows, opts({ includeHillclimb: true })).reps).toBe(1);
  });

  it("a cowork scenario matches history under its resolved (effective) tier", () => {
    const rows = [run(passing(), { fidelity: "cowork", effectiveFidelity: "hostloop" })];
    expect(loadRowHistory(rows, opts({ tier: "hostloop" })).reps).toBe(1);
    expect(loadRowHistory(rows, opts({ tier: "cowork" })).reps).toBe(0);
    const cost = loadCostHistory(rows, { scenario: SCEN, baseline: BASELINE, tier: "hostloop" });
    expect(perRepCost(cost).pricedRuns).toBe(1);
  });
});

describe("loadRowHistory — the window", () => {
  it("60 qualifying runs: only the newest 50 by ts are used", () => {
    // The 10 OLDEST fail row 0; the newest 50 pass. Passed in shuffled order.
    const rows: RunIndexRow[] = [];
    for (let i = 0; i < 60; i++) rows.push(run(i < 10 ? passing(failRow0) : passing()));
    const shuffled = [...rows.slice(30), ...rows.slice(0, 30)];
    const h = loadRowHistory(shuffled, opts());
    expect(h.reps).toBe(50);
    expect(rowById(h, 0)).toMatchObject({ k: 50, n: 50 });
  });

  it("the window counts only runs that pass every hard key", () => {
    const rows: RunIndexRow[] = [];
    for (let i = 0; i < 5; i++) rows.push(run(passing(failRow0))); // older, qualifying
    for (let i = 0; i < 5; i++) rows.push(run(undefined)); // newer, pruned
    const h = loadRowHistory(rows, opts({ window: 5 }));
    expect(h.reps).toBe(5);
    expect(h.excludedByKey.pruned).toBe(5);
  });

  it("stops at the read cap and says so", () => {
    const rows: RunIndexRow[] = [];
    for (let i = 0; i < 10; i++) rows.push(run(undefined));
    const h = loadRowHistory(rows, opts({ maxReads: 4 }));
    expect(h.reads).toBe(4);
    expect(h.readCapHit).toBe(true);
  });
});

describe("loadRowHistory — exact-content preference", () => {
  function mixed(exact: number) {
    const rows: RunIndexRow[] = [];
    for (let i = 0; i < 6; i++) rows.push(run(passing(failRow0))); // other content, row 0 fails
    for (let i = 0; i < exact; i++)
      rows.push(
        run(
          passing((r) => {
            (r.fingerprint as Record<string, unknown>).contentSig = SIG_A;
          }),
        ),
      );
    return loadRowHistory(rows, opts({ armASig: SIG_A }));
  }

  it("with 4 exact-content reps the relaxed rates are used, the exact count reported", () => {
    const h = mixed(4);
    expect(h.basis).toBe("relaxed");
    expect(h.exactContentReps).toBe(4);
    expect(rowById(h, 0)).toMatchObject({ k: 4, n: 10 });
    expect(h.relaxedRows).toBeUndefined();
  });

  it("with 5 the rates come from arm A's exact content, the relaxed ones beside them", () => {
    const h = mixed(5);
    expect(h.basis).toBe("exact_content");
    expect(rowById(h, 0)).toMatchObject({ k: 5, n: 5 });
    const relaxed = h.relaxedRows!.find((r) => r.row.assertionIndex === 0 && r.row.kind === "assertion")!.history;
    expect(relaxed).toMatchObject({ k: 5, n: 11 });
  });
});

describe("loadRowHistory — verdict rate is context only", () => {
  it("all-pruned history at a 100% verdict rate: rows unknown, the verdict rate reported", () => {
    const rows = [run(undefined), run(undefined), run(undefined)];
    const h = loadRowHistory(rows, opts());
    expect(h.rows.every((r) => r.history.n === 0)).toBe(true);
    expect(h.verdictRate).toEqual({ pass: 3, runs: 3, basis: "index" });
  });

  it("all-pruned at 60%: still unknown rows", () => {
    const rows = [run(undefined), run(undefined), run(undefined, { pass: false }), run(undefined, { pass: false }), run(undefined)];
    const h = loadRowHistory(rows, opts());
    expect(h.rows.every((r) => r.history.n === 0)).toBe(true);
    expect(h.verdictRate).toEqual({ pass: 3, runs: 5, basis: "index" });
  });
});

describe("loadCostHistory — the cost basis", () => {
  it("equals what `stats <name> --baseline <b> --group-by fidelity` prints for the tier", () => {
    const rows = [1.2, 0.4, 3.1, 0.9, 2.2, 0.7].map((c) => run(undefined, { costUsd: c }));
    rows.push(run(undefined, { costUsd: 9, fidelity: "hostloop" })); // other tier
    rows.push(run(undefined, { costUsd: 9, baseline: "desktop-0.9.0" })); // other baseline
    rows.push(run(undefined, { costUsd: undefined })); // unpriced
    const cost = perRepCost(loadCostHistory(rows, { scenario: SCEN, baseline: BASELINE, tier: "container" }));
    const stats = buildStats(rows, { scenario: SCEN, baseline: BASELINE, groupBy: "fidelity" }).summaries.find(
      (s) => s.fidelity === "container",
    )!;
    expect(cost.p50Usd).toBe(stats.p50CostUsd);
    expect(cost.p95Usd).toBe(stats.p95CostUsd);
    expect(cost.pricedRuns).toBe(6);
  });

  it("drops turn > 1 and hillclimb rows, which `stats` keeps — a planned divergence", () => {
    // An eval rep is turn 1 of a fresh run; a resumed turn or a hillclimb variant is not the plugin under eval.
    const rows = [1, 2, 3].map((c) => run(undefined, { costUsd: c }));
    rows.push(run(undefined, { costUsd: 50, turn: 2 }));
    rows.push(run(undefined, { costUsd: 60, runLabel: `${HILLCLIMB_LABEL_PREFIX}flow:v2` }));
    const h = loadCostHistory(rows, { scenario: SCEN, baseline: BASELINE, tier: "container" });
    expect(perRepCost(h).pricedRuns).toBe(3);
    expect(buildStats(rows, { scenario: SCEN, baseline: BASELINE }).summaries[0].runs).toBe(5);
  });

  it("the worst-observed figure is the budget gate's own basis: scenario name only, unfiltered", () => {
    const rows = [run(undefined, { costUsd: 1 }), run(undefined, { costUsd: 7, fidelity: "hostloop", baseline: "desktop-0.9.0" })];
    rows.push(run(undefined, { costUsd: 5, critiqueRole: "rollup" })); // a roll-up is not a run: never in either basis
    const h = loadCostHistory(rows, { scenario: SCEN, baseline: BASELINE, tier: "container" });
    expect(h.budgetGateWorstUsd).toBe(7);
    expect(h.budgetGatePricedRuns).toBe(2);
    expect(perRepCost(h).p95Usd).toBe(1);
  });

  it("judge and decider spend come from the same rows; absent is not zero", () => {
    const rows = [run(undefined, { costUsd: 1, judgeCostUsd: 0.1 }), run(undefined, { costUsd: 2, deciderCostUsd: 0.05 })];
    const h = loadCostHistory(rows, { scenario: SCEN, baseline: BASELINE, tier: "container" });
    expect(h.samples).toEqual([
      { agentUsd: 1, judgeUsd: 0.1 },
      { agentUsd: 2, deciderUsd: 0.05 },
    ]);
  });
});

describe("loadRowHistory — a crash before any model answered (intention to treat)", () => {
  /** exit-agent.json with no model evidence at all: the agent failed before its first model call. */
  const crashNoModel = () => {
    const err = fixture("exit-agent.json");
    err.scenario = SCEN;
    err.models = [];
    delete err.modelUsage;
    delete err.modelPinHonored;
    return err;
  };

  it("scores 0 on every row, as the eval would: 9 passing + 1 crash is 9/10, not 9/9", () => {
    const rows = Array.from({ length: 9 }, () => run(passing()));
    rows.push(run(crashNoModel()));
    const h = loadRowHistory(rows, opts());
    expect(h.excludedByKey.model).toBe(0);
    expect(h.reps).toBe(10);
    expect(h.rows.every((r) => r.history.n === 10)).toBe(true);
    expect(rowById(h, 0)).toMatchObject({ k: 9, n: 10 });
  });

  it("a crash that DID report a different live model is still excluded by the model key", () => {
    const err = fixture("exit-agent.json"); // reports claude-opus-5; the pin is claude-sonnet-5
    err.scenario = SCEN;
    const h = loadRowHistory([run(err)], opts());
    expect(h.excludedByKey.model).toBe(1);
    expect(h.modelsExcluded).toEqual({ "claude-opus-5": 1 });
  });

  it("a SUCCESS with no model evidence cannot vouch for the pin and is excluded", () => {
    const h = loadRowHistory(
      [
        run(
          passing((r) => {
            r.models = [];
            delete r.modelPinHonored;
          }),
        ),
      ],
      opts(),
    );
    expect(h.excludedByKey.model).toBe(1);
    expect(h.modelsExcluded).toEqual({ "(no live model)": 1 });
  });
});

describe("loadRowHistory — a /plugin:skill run vouched for by modelUsage only", () => {
  it("counts: the main loop reports only <synthetic>, the billed model is the pin", () => {
    const slash = fixture("slash-success-synthetic.json");
    slash.scenario = SCEN;
    const assertions = (slash.assertions as Array<{ assertion: Assertion }>).map((g) => g.assertion);
    const h = loadRowHistory([run(slash)], opts({ assertions }));
    expect(h.excludedByKey.model).toBe(0);
    expect(h.reps).toBe(1);
    expect(h.rows.every((r) => r.history.k === 0 && r.history.n === 1)).toBe(true); // both asserts failed in that run
  });
});

describe("loadRowHistory — the judge model", () => {
  const judgedBy =
    (model: string): Edit =>
    (r) => {
      (r.assertions as Array<Record<string, unknown>>)[SEMANTIC_INDEX].judgeModel = model;
    };

  it("a different judge model excludes only the claim and rollup rows of that run, and is counted", () => {
    const h = loadRowHistory(
      [run(passing(judgedBy("claude-haiku-4-5"))), run(passing(judgedBy("claude-opus-5")))],
      opts({ judgeModelPin: "claude-opus-5" }),
    );
    expect(h.judgeModelDiffers).toBe(1);
    expect(rowById(h, 0)).toMatchObject({ k: 2, n: 2 });
    const rollup = rowById(h, SEMANTIC_INDEX, "semantic_rollup");
    expect(rollup).toMatchObject({ k: 1, n: 1 });
    expect(rollup.excluded?.judge_model_differs).toBe(1);
    const claims = h.rows.filter((x) => x.row.kind === "claim");
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.every((x) => x.history.n === 1 && x.history.excluded?.judge_model_differs === 1)).toBe(true);
  });

  it("no judge pin: the judge model is not checked", () => {
    const h = loadRowHistory([run(passing(judgedBy("claude-haiku-4-5")))], opts());
    expect(h.judgeModelDiffers).toBe(0);
    expect(rowById(h, SEMANTIC_INDEX, "semantic_rollup")).toMatchObject({ k: 1, n: 1 });
  });
});

describe("loadRowHistory — exclusions that do not take a window slot", () => {
  it("model and ablated exclusions are skipped, and older qualifying runs fill the window", () => {
    const rows: RunIndexRow[] = [];
    for (let i = 0; i < 3; i++) rows.push(run(passing(failRow0))); // oldest, qualifying
    rows.push(
      run(
        passing((r) => {
          r.models = ["claude-opus-5"];
        }),
      ),
    );
    rows.push(
      run(
        passing((r) => {
          r.ablated = true;
        }),
      ),
    );
    const h = loadRowHistory(rows, opts({ window: 3 }));
    expect(h.reps).toBe(3);
    expect(h.reads).toBe(5);
    expect(h.excludedByKey).toMatchObject({ model: 1, ablated: 1 });
    expect(rowById(h, 0)).toMatchObject({ k: 0, n: 3 });
  });

  it("the 60-run window reads exactly 50 files", () => {
    const rows: RunIndexRow[] = [];
    for (let i = 0; i < 60; i++) rows.push(run(passing()));
    const h = loadRowHistory(rows, opts());
    expect(h.reads).toBe(50);
    expect(h.validFraction).toBe(1);
  });
});

describe("loadRowHistory — malformed and non-regular result files are unreadable, never guessed", () => {
  it("valid JSON of the wrong shape", () => {
    const rows = [
      run(passing((r) => void (r.models = "claude-sonnet-5"))),
      run(passing((r) => void (r.assertions = "nope"))),
      run(passing((r) => void delete r.result)),
    ];
    const h = loadRowHistory(rows, opts());
    expect(h.excludedByKey.unreadable).toBe(3);
    expect(h.reps).toBe(0);
  });

  it.skipIf(process.platform === "win32")("a FIFO is not opened for reading, and a symlinked result is refused", () => {
    const fifoRow = run(undefined);
    mkdirSync(join(fifoRow.outDir, "turns", "1"), { recursive: true });
    execFileSync("mkfifo", [join(fifoRow.outDir, "turns", "1", "result.json")]);
    const linkRow = run(undefined);
    const target = join(root, "elsewhere.json");
    writeFileSync(target, JSON.stringify(passing()));
    mkdirSync(join(linkRow.outDir, "turns", "1"), { recursive: true });
    symlinkSync(target, join(linkRow.outDir, "turns", "1", "result.json"));
    const h = loadRowHistory([fifoRow, linkRow], opts());
    expect(h.excludedByKey.unreadable).toBe(2);
  });
});

describe("loadRowHistory — index rows built by the real producer", () => {
  it("a row from indexRowFromResult passes every hard key", () => {
    const i = ++seq;
    const outDir = join(root, SCEN, `local_${i}`);
    const r = passing((x) => {
      x.outDir = outDir;
      x.fidelity = "container";
      x.baseline = BASELINE;
      x.turn = 1;
      x.runLabel = "eval:e1:a";
      x.cost = { usd: 0.4 };
    });
    mkdirSync(join(outDir, "turns", "1"), { recursive: true });
    writeFileSync(join(outDir, "turns", "1", "result.json"), JSON.stringify(r));
    const row = indexRowFromResult(r as unknown as RunResult, {
      command: "run",
      partial: false,
      ts: "2026-09-02T00:00:00.000Z",
      git: { branch: null, sha: null },
    });
    const h = loadRowHistory([row], opts());
    expect(h.reps).toBe(1);
    expect(h.evalReps).toBe(1);
    expect(perRepCost(loadCostHistory([row], { scenario: SCEN, baseline: BASELINE, tier: "container" })).pricedRuns).toBe(1);
  });
});

describe("loadCostHistory — exclusion counts and the hillclimb seam", () => {
  it("counts each filtered key, and includes hillclimb runs behind the option", () => {
    const rows = [
      run(undefined, { costUsd: 1 }),
      run(undefined, { costUsd: 2, fidelity: "hostloop" }),
      run(undefined, { costUsd: 3, baseline: "desktop-0.9.0" }),
      run(undefined, { costUsd: 4, turn: 2 }),
      run(undefined, { costUsd: 5, runLabel: `${HILLCLIMB_LABEL_PREFIX}flow:v1` }),
      run(undefined, { costUsd: 6, critiqueRole: "rollup" }),
    ];
    const f = { scenario: SCEN, baseline: BASELINE, tier: "container" };
    const h = loadCostHistory(rows, f);
    expect(h.excluded).toEqual({ notRun: 1, tier: 1, baseline: 1, turn: 1, hillclimb: 1 });
    expect(perRepCost(h).pricedRuns).toBe(1);
    const withHc = loadCostHistory(rows, { ...f, includeHillclimb: true });
    expect(withHc.excluded?.hillclimb).toBe(0);
    expect(perRepCost(withHc).pricedRuns).toBe(2);
  });
});

describe("cost at a target N matches `stats`", () => {
  it("estimateScheduleCost at jobs = 2N has p50 = the stats p50 x 2N for the same rows", () => {
    const rows = [1.2, 0.4, 3.1, 0.9, 2.2, 0.7].map((c) => run(undefined, { costUsd: c }));
    const N = 12;
    const stats = buildStats(rows, { scenario: SCEN, baseline: BASELINE, groupBy: "fidelity" }).summaries.find(
      (s) => s.fidelity === "container",
    )!;
    const est = estimateScheduleCost([
      { scenario: SCEN, jobs: 2 * N, history: loadCostHistory(rows, { scenario: SCEN, baseline: BASELINE, tier: "container" }) },
    ]);
    expect(est.p50Usd).toBe(stats.p50CostUsd! * 2 * N);
    expect(est.p95Usd).toBe(stats.p95CostUsd! * 2 * N);
  });
});
