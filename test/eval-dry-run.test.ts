// `eval --dry-run`: the cost and power plan, printed before any spend, and `eval --max-budget-usd`. Driven
// in-process with a runner that throws if it is ever called — nothing here runs an agent or spends a token.
//
// History fixtures: each history run's result.json is an EDITED COPY of a committed excerpt of a real kept run
// in test/fixtures/eval-classify/ (read at test time, never built from scratch):
//   - public-scenario-pinned.json (a csv-metrics run). Edits: `models` set to the eval's agent pin
//     (claude-sonnet-5; the excerpt ran claude-opus-4-8), and named assertion grades flipped to fail where a
//     test needs a rate below 100%.
//   - public-scenario-aligned.json (the semantic scenario). Edit: a `judgeModel` on its semantic grade.
// Each history run's index row is the shape `indexRowFromResult` writes, with its cost, tier and baseline set
// per test.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { COMPOSER_ID } from "../src/assert.js";
import { composeKey, freezeRef } from "../src/refs/store.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageError } from "../src/errors.js";
import type { RunResult } from "../src/types.js";
import { loadBaseline } from "../src/baseline.js";
import { effectiveTier } from "../src/run/execute.js";
import type { RunIndexRow } from "../src/run/run-index.js";
import { budgetStatus, resetBudgetStatus } from "../src/run/budget-status.js";
import { EvalBudgetRefusal, EvalStagingError, parseEvalArgs, planEvalDryRun, runEval, type EvalJobSpec } from "../src/eval/command.js";
import { planText, type EvalPlan } from "../src/eval/plan.js";
import { EVAL_BOOLEAN_FLAGS, EVAL_VALUE_FLAGS } from "../src/eval/usage.js";
import type { DoctorCheck } from "../src/run/doctor.js";

describe("eval --dry-run: flags", () => {
  const base = ["s.yaml", "--arm", "x", "--arm", "y"];
  it("--dry-run is a boolean flag; --target-effect and --max-budget-usd take values", () => {
    expect(EVAL_BOOLEAN_FLAGS).toContain("--dry-run");
    expect(EVAL_VALUE_FLAGS).toContain("--target-effect");
    expect(EVAL_VALUE_FLAGS).toContain("--max-budget-usd");
    expect(parseEvalArgs(base).dryRun).toBe(false);
    expect(parseEvalArgs([...base, "--dry-run"]).dryRun).toBe(true);
    expect(() => parseEvalArgs([...base, "--dry-run=yes"])).toThrow(/takes no value/);
  });

  it("--target-effect is in percentage points: 30pp, 30 and 12.5pp parse", () => {
    expect(parseEvalArgs([...base, "--dry-run", "--target-effect", "30pp"]).targetEffectPp).toBe(30);
    expect(parseEvalArgs([...base, "--dry-run", "--target-effect", "30"]).targetEffectPp).toBe(30);
    expect(parseEvalArgs([...base, "--dry-run", "--target-effect=12.5pp"]).targetEffectPp).toBe(12.5);
    expect(parseEvalArgs([...base, "--dry-run", "--target-effect", "100pp"]).targetEffectPp).toBe(100);
    expect(parseEvalArgs([...base, "--dry-run", "--target-effect", "1"]).targetEffectPp).toBe(1);
    expect(parseEvalArgs([...base, "--dry-run"]).targetEffectPp).toBeUndefined();
  });

  it("a fraction is refused with the percentage-points hint", () => {
    expect(() => parseEvalArgs([...base, "--dry-run", "--target-effect", "0.3"])).toThrow(/did you mean 30pp\?.*percentage points/);
    expect(() => parseEvalArgs([...base, "--dry-run", "--target-effect", "0.125"])).toThrow(/did you mean 12\.5pp\?/);
  });

  it("--target-effect outside [1, 100] or malformed is refused", () => {
    for (const v of ["0", "101", "150pp", "-5", "abc", "30%", "pp", "30 pp", "1e1"])
      expect(() => parseEvalArgs([...base, "--dry-run", `--target-effect=${v}`]), v).toThrow(/--target-effect/);
  });

  it("--target-effect requires --dry-run", () => {
    expect(() => parseEvalArgs([...base, "--target-effect", "30pp"])).toThrow(/--target-effect requires --dry-run/);
  });

  it("--max-budget-usd takes a positive number, with or without --dry-run", () => {
    expect(parseEvalArgs([...base, "--max-budget-usd", "9"]).maxBudgetUsd).toBe(9);
    expect(parseEvalArgs([...base, "--dry-run", "--max-budget-usd", "0.5"]).maxBudgetUsd).toBe(0.5);
    expect(parseEvalArgs(base).maxBudgetUsd).toBeUndefined();
    for (const v of ["0", "-1", "abc", "Infinity"])
      expect(() => parseEvalArgs([...base, `--max-budget-usd=${v}`]), v).toThrow(/--max-budget-usd requires a positive number/);
  });
});

// ---- in-process: the dry-run path through the command -------------------------------------------------

const FX = join(import.meta.dirname, "fixtures", "eval-classify");
const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(FX, `${name}.json`), "utf8"));
const CSV_ASSERTS = `assert:
  - result: success
  - tool_called: Skill
  - tool_called: Bash
  - user_visible_artifact: outputs/metrics.json
  - user_visible_artifact: outputs/summary.md
  - transcript_matches: 'metrics\\.json'
  - no_delete_in_outputs: true
`;
const SEM_ASSERTS = `assert:
  - result: success
  - user_visible_artifact: outputs/report.md
  - user_visible_artifact: outputs/_work/f6.md
  - semantic_matches:
      rubric:
        - The document reports that six filler files were created under a _work directory.
        - The document states that all six writes completed without error.
      evidence_files:
        - outputs/report.md
`;
const PIN = "claude-sonnet-5";
const APP = loadBaseline("latest").appVersion;

let root: string;
let seq = 0;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "eval-plan-")));
  resetBudgetStatus();
  for (const k of ["COWORK_HARNESS_RUNS_DIR", "COWORK_HARNESS_MODEL", "COWORK_HARNESS_JUDGE_MODEL", "COWORK_HARNESS_GITSET"])
    saved[k] = process.env[k];
  // A runs root no test writes: every history below arrives through the `readIndex` seam.
  process.env.COWORK_HARNESS_RUNS_DIR = join(root, "runs-unused");
  delete process.env.COWORK_HARNESS_MODEL;
  delete process.env.COWORK_HARNESS_JUDGE_MODEL;
  delete process.env.COWORK_HARNESS_GITSET;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function writePlugin(dir: string, body: string): void {
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "csv-metrics" }));
  mkdirSync(join(dir, "skills", "csv-metrics"), { recursive: true });
  writeFileSync(join(dir, "skills", "csv-metrics", "SKILL.md"), `---\nname: csv-metrics\ndescription: d\n---\n${body}\n`);
}

function setup(o: { semantic?: boolean; fidelity?: string } = {}) {
  const scen = join(root, "scenarios");
  mkdirSync(scen, { recursive: true });
  writePlugin(join(root, "declared", "csv-metrics"), "declared");
  writePlugin(join(root, "a", "csv-metrics"), "version A");
  writePlugin(join(root, "b", "csv-metrics"), "version B");
  writeFileSync(join(root, "session.yaml"), `model: ${PIN}\nplugins:\n  local_plugins:\n    - ./declared/csv-metrics\n`);
  writeFileSync(
    join(scen, "csv-metrics.yaml"),
    `baseline: latest\nsession: ../session.yaml\nfidelity: ${o.fidelity ?? "container"}\nprompt: analyze\n${CSV_ASSERTS}`,
  );
  if (o.semantic)
    writeFileSync(
      join(scen, "smoke-semantic-evidence-files.yaml"),
      `baseline: latest\nsession: ../session.yaml\nfidelity: container\nprompt: write\n${SEM_ASSERTS}`,
    );
  return { scen, a: join(root, "a", "csv-metrics"), b: join(root, "b", "csv-metrics") };
}

/** One history run: its result.json (an edited fixture copy) under a run dir, and its index row. */
function historyRun(
  scenario: "csv-metrics" | "smoke-semantic-evidence-files",
  o: { costUsd?: number; tier?: string; baseline?: string; fail?: number[]; edit?: (r: Record<string, unknown>) => void } = {},
): RunIndexRow {
  const i = ++seq;
  const outDir = join(root, "history", scenario, `local_${i}`);
  const r = fixture(scenario === "csv-metrics" ? "public-scenario-pinned" : "public-scenario-aligned");
  r.models = [PIN];
  for (const f of o.fail ?? []) (r.assertions as Array<{ pass: boolean }>)[f].pass = false;
  o.edit?.(r);
  mkdirSync(join(outDir, "turns", "1"), { recursive: true });
  writeFileSync(join(outDir, "turns", "1", "result.json"), JSON.stringify(r));
  return {
    v: 1,
    ts: new Date(Date.UTC(2026, 8, 1) + i * 60_000).toISOString(),
    command: "run",
    scenario,
    slug: scenario,
    runId: `local_${i}`,
    fidelity: o.tier ?? "container",
    effectiveFidelity: o.tier ?? "container",
    baseline: o.baseline ?? APP,
    result: "success",
    pass: (o.fail ?? []).length === 0,
    signals: [],
    ...(o.costUsd !== undefined ? { costUsd: o.costUsd } : {}),
    turn: 1,
    partial: false,
    nonDeterministic: false,
    outDir,
    git: { branch: null, sha: null },
  };
}

const TOKEN_OK = (): DoctorCheck => ({ id: "token", title: "Auth token", status: "ok", detail: "found", required: true });
const NO_RUN = async (_s: EvalJobSpec): Promise<RunResult> => {
  throw new Error("a dry run must never call runJob");
};

function planDeps(rows: RunIndexRow[], extra: { log?: string[]; snapRoots?: string[]; plans?: EvalPlan[]; redirected?: boolean } = {}) {
  return {
    runJob: NO_RUN,
    tokenCheck: TOKEN_OK,
    isolationCheck: (): string | undefined => undefined,
    log: (s: string) => extra.log?.push(s),
    evalId: "plan1",
    now: () => new Date("2026-10-01T00:00:00Z"),
    readIndex: () => rows,
    runsDirInfo: () => ({ runsDir: join(root, "runs"), runsDirRedirected: extra.redirected ?? false }),
    onSnapshotRoot: (d: string) => extra.snapRoots?.push(d),
    onPlan: (p: EvalPlan) => extra.plans?.push(p),
  };
}

const dry = (scen: string, a: string, b: string, extra: string[] = []) =>
  parseEvalArgs([scen, "--arm", `before=${a}`, "--arm", `after=${b}`, "--out", join(root, "eval"), "--quiet", "--dry-run", ...extra]);

const COVERED = ["jobs", "meanUsd", "p50Usd", "p95Usd", "worstObservedUsd", "lowerBound", "unpriced", "pricedRuns", "thinnest"];

describe("eval --dry-run: nothing runs, nothing is created", () => {
  it("returns a plan without calling runJob, creates no eval dir, and removes its temp snapshots", async () => {
    const { scen, a, b } = setup();
    const snapRoots: string[] = [];
    const rows = [historyRun("csv-metrics", { costUsd: 1 }), historyRun("csv-metrics", { costUsd: 3 })];
    const { plan } = await planEvalDryRun(dry(scen, a, b), planDeps(rows, { snapRoots }));
    expect(existsSync(join(root, "eval"))).toBe(false);
    expect(snapRoots).toHaveLength(1);
    expect(snapRoots[0]).toMatch(/cwh-eval-plan-/);
    expect(existsSync(snapRoots[0])).toBe(false);
    for (const k of COVERED) expect(plan.cost, k).toHaveProperty(k);
    // 2 arms x 5 reps of one scenario, priced from 2 runs at $1 and $3.
    expect(plan.cost).toMatchObject({ jobs: 10, p50Usd: 30, meanUsd: 20, p95Usd: 30, worstObservedUsd: 30, pricedRuns: 2, thinnest: 2 });
    expect(plan.cost.lowerBound).toBe(false);
    expect(plan.schemaVersion).toBe(0);
  });

  it("an --out that exists and is empty stays empty", async () => {
    const { scen, a, b } = setup();
    mkdirSync(join(root, "eval"));
    await planEvalDryRun(dry(scen, a, b), planDeps([]));
    expect(readdirSync(join(root, "eval"))).toEqual([]);
  });

  it("the temp snapshots are removed when a later check refuses", async () => {
    const { scen, a } = setup();
    const snapRoots: string[] = [];
    await expect(planEvalDryRun(dry(scen, a, a), planDeps([], { snapRoots }))).rejects.toThrow(/identical/);
    expect(snapRoots).toHaveLength(1);
    expect(existsSync(snapRoots[0])).toBe(false);
  });
});

describe("eval --dry-run: a temp dir inside a git work tree", () => {
  it("is refused as a staging failure (exit 3), and nothing is left in it", async () => {
    const { scen, a, b } = setup();
    const repo = join(root, "tmp-repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const savedTmp = process.env.TMPDIR;
    process.env.TMPDIR = repo; // os.tmpdir() reads it on every call
    const snapRoots: string[] = [];
    try {
      await expect(planEvalDryRun(dry(scen, a, b), planDeps([], { snapRoots }))).rejects.toThrow(EvalStagingError);
    } finally {
      if (savedTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = savedTmp;
    }
    expect(snapRoots[0].startsWith(repo)).toBe(true);
    expect(existsSync(snapRoots[0])).toBe(false);
  });

  it("the refusal names TMPDIR as the remedy", async () => {
    const { scen, a, b } = setup();
    const repo = join(root, "tmp-repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const savedTmp = process.env.TMPDIR;
    process.env.TMPDIR = repo;
    try {
      await expect(planEvalDryRun(dry(scen, a, b), planDeps([]))).rejects.toThrow(/set TMPDIR to a directory outside any git work tree/);
    } finally {
      if (savedTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = savedTmp;
    }
  });

  it("when git cannot answer for the temp dir, the refusal points at TMPDIR, not --out", async () => {
    const { scen, a, b } = setup();
    const repo = join(root, "odd-repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    writeFileSync(join(repo, ".git", "config"), "[core]\n\trepositoryformatversion = 99\n"); // git refuses to read it
    const savedTmp = process.env.TMPDIR;
    process.env.TMPDIR = repo;
    try {
      const err = (await planEvalDryRun(dry(scen, a, b), planDeps([])).catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(EvalStagingError);
      expect(err.message).toMatch(/could not tell whether the temp dir .* is inside a git work tree/);
      expect(err.message).toMatch(/set TMPDIR/);
      expect(err.message).not.toMatch(/--out/);
    } finally {
      if (savedTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = savedTmp;
    }
  });
});

describe("eval --dry-run: the real eval's refusals, unchanged", () => {
  it("an --out inside a git work tree", async () => {
    const { scen, a, b } = setup();
    const repo = join(root, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const p = parseEvalArgs([scen, "--arm", a, "--arm", b, "--out", join(repo, "e"), "--quiet", "--dry-run"]);
    await expect(planEvalDryRun(p, planDeps([]))).rejects.toThrow(/inside a git work tree/);
    expect(existsSync(join(repo, "e"))).toBe(false);
  });

  it("an existing non-empty --out", async () => {
    const { scen, a, b } = setup();
    mkdirSync(join(root, "eval"));
    writeFileSync(join(root, "eval", "x"), "");
    await expect(planEvalDryRun(dry(scen, a, b), planDeps([]))).rejects.toThrow(/already exists and is not empty/);
  });

  it("identical arms, with the real run's message", async () => {
    const { scen, a } = setup();
    await expect(planEvalDryRun(dry(scen, a, a), planDeps([]))).rejects.toThrow(/the two arms are identical/);
  });

  it("the answer-key guard", async () => {
    const { scen, a, b } = setup();
    writeFileSync(join(b, "evals.json"), "{}");
    await expect(planEvalDryRun(dry(scen, a, b), planDeps([]))).rejects.toThrow(/answer-key guard.*evals json/);
  });

  it("an alias pin, before any plan is computed", async () => {
    const { scen, a, b } = setup();
    const plans: EvalPlan[] = [];
    await expect(planEvalDryRun(dry(scen, a, b, ["--model", "opus"]), planDeps([], { plans }))).rejects.toThrow(/CONCRETE agent model/);
    expect(plans).toHaveLength(0);
  });

  it("an unreachable --fail-on confirmed — and the refusal still carries the plan", async () => {
    const { scen, a, b } = setup();
    const plans: EvalPlan[] = [];
    await expect(
      planEvalDryRun(dry(scen, a, b, ["--reps", "4", "--correction", "holm", "--fail-on", "confirmed"]), planDeps([], { plans })),
    ).rejects.toThrow(/can never fire/);
    expect(plans).toHaveLength(1);
    expect(plans[0].sections.tuned).toMatchObject({ m: 7, fixed: { minRowsToConfirm: null } });
  });

  it("no usable credential", async () => {
    const { scen, a, b } = setup();
    const deps = {
      ...planDeps([]),
      tokenCheck: (): DoctorCheck => ({ id: "token", title: "t", status: "fail", detail: "none", required: true }),
    };
    await expect(planEvalDryRun(dry(scen, a, b), deps)).rejects.toThrow(/no usable agent credential/);
  });
});

describe("eval --dry-run: the plan's numbers", () => {
  it("per-row rates come from history through the eval's own classifier; MDD at --reps is the report's", async () => {
    const { scen, a, b } = setup();
    // 14 reps: tool_called Bash (index 2) passes in 4 of them.
    const rows = Array.from({ length: 14 }, (_, i) => historyRun("csv-metrics", { costUsd: 1, fail: i < 10 ? [2] : [] }));
    const { plan } = await planEvalDryRun(dry(scen, a, b, ["--correction", "holm", "--target-effect", "50pp"]), planDeps(rows));
    const s = plan.scenarios[0];
    expect(s).toMatchObject({ name: "csv-metrics", tier: "container", baseline: APP, agentPin: PIN, heldOut: false });
    expect(s.rateHistory).toMatchObject({ reps: 14, validReps: 14, basis: "relaxed", exactContentReps: 0 });
    const bash = s.rows.find((r) => r.assertionIndex === 2)!;
    expect(bash.rate).toMatchObject({ k: 4, n: 14 });
    // The plan's pinned example (4/14, 50pp rise, holm m = 7): possible at N = 12, confirmed at N = 18.
    expect(bash.target!.effectPp).toBe(50);
    expect(bash.target!.rise.possible).toMatchObject({ n: 12, stableFrom: 12 });
    expect(bash.target!.rise.confirmedSingleRow).toMatchObject({ n: 18, stableFrom: 20 });
    // Cost at that N: 2 x N x the per-run p50 ($1), for the scenario and the whole eval.
    expect(bash.target!.rise.possible.cost).toMatchObject({ reps: 12, scenarioP50Usd: 24, evalP50Usd: 24, lowerBound: false });
    expect(plan.targetEffectPp).toBe(50);
    const result = s.rows.find((r) => r.assertionIndex === 0)!;
    expect(result.rate).toMatchObject({ k: 14, n: 14 });
    expect(result.mddAtReps!.rise).toBe("n/a");
    expect(result.target!.rise.possible.n).toBe("impossible");
    // The text is drawn from the payload: the same N, its power, and the cost at that N.
    const text = planText(plan).join("\n");
    expect(text).toMatch(/row \[2\] tool_called: rate 29% \(4\/14, 95% CI 12%–55%\)/);
    expect(text).toMatch(
      /50pp rise: possible N=12 \(power ≈ 61%; \$24\.0000 p50 \/ \$24\.0000 p95 this scenario, \$24\.0000 p50 \/ \$24\.0000 p95 whole eval\)/,
    );
    expect(text).toMatch(/confirmed \(single row\) N=18 \(stable from 20; power ≈ 59%/);
    expect(text).toMatch(/fixed design \(what eval runs today\), tuned section: 7 row\(s\) in the family/);
    expect(text).toMatch(/ceiling: a rise is undetectable at any N at the point estimate/);
  });

  it("the target effect in percentage points is never a fraction multiplied back", async () => {
    const { scen, a, b } = setup();
    const { plan } = await planEvalDryRun(
      dry(scen, a, b, ["--target-effect", "30pp"]),
      planDeps([historyRun("csv-metrics", { costUsd: 1 })]),
    );
    expect(plan.targetEffectPp).toBe(30);
    for (const r of plan.scenarios[0].rows) if (r.target) expect(r.target.effectPp).toBe(30);
  });

  it("the cost basis is the eval's effective tier and baseline; the budget gate's wider figure is apart", async () => {
    const { scen, a, b } = setup();
    const rows = [
      historyRun("csv-metrics", { costUsd: 1 }),
      historyRun("csv-metrics", { costUsd: 9, tier: "hostloop" }), // another tier: gate basis only
      historyRun("csv-metrics", { costUsd: 7, baseline: "0.0.1" }), // another baseline: gate basis only
    ];
    const { plan } = await planEvalDryRun(dry(scen, a, b), planDeps(rows));
    expect(plan.cost).toMatchObject({ p50Usd: 10, worstObservedUsd: 10, pricedRuns: 1, budgetGateWorstUsd: 90 });
    expect(plan.scenarios[0].cost.excluded).toMatchObject({ tier: 1, baseline: 1 });
  });

  it("a `fidelity: cowork` scenario is priced from history under the tier cowork resolves to", async () => {
    const { scen, a, b } = setup({ fidelity: "cowork" });
    const tier = effectiveTier("cowork", loadBaseline("latest"));
    const rows = [historyRun("csv-metrics", { costUsd: 2, tier })];
    const { plan } = await planEvalDryRun(dry(scen, a, b), planDeps(rows));
    expect(plan.scenarios[0].tier).toBe(tier);
    expect(plan.cost).toMatchObject({ lowerBound: false, p50Usd: 20 });
    expect(plan.scenarios[0].rateHistory.reps).toBe(1);
  });

  it("each semantic assertion's history is checked against the eval's judge pin for it", async () => {
    const { scen, a, b } = setup({ semantic: true });
    const judged = (m: string) => (r: Record<string, unknown>) => {
      (r.assertions as Array<Record<string, unknown>>)[3].judgeModel = m;
    };
    const rows = [
      historyRun("smoke-semantic-evidence-files", { costUsd: 1, edit: judged("claude-opus-4-8") }),
      historyRun("smoke-semantic-evidence-files", { costUsd: 1, edit: judged("claude-haiku-4-5") }),
    ];
    const { plan } = await planEvalDryRun(dry(scen, a, b, ["--judge-model", "claude-opus-4-8"]), planDeps(rows));
    const sem = plan.scenarios.find((s) => s.name === "smoke-semantic-evidence-files")!;
    expect(sem.rateHistory.judgeModelDiffers).toBe(1);
    expect(sem.rows.find((r) => r.kind === "semantic_rollup")!.rate).toMatchObject({ k: 1, n: 1 });
    expect(sem.rows.find((r) => r.assertionIndex === 0)!.rate).toMatchObject({ k: 2, n: 2 });
  });

  it("sections: m excludes roll-up rows; the fixed design and the sequential preview sit side by side", async () => {
    const { scen, a, b } = setup({ semantic: true });
    const { plan } = await planEvalDryRun(dry(scen, a, b, ["--holdout", join(scen, "smoke-semantic-evidence-files.yaml")]), planDeps([]));
    // csv: 7 rows (tuned). semantic: 3 assertion rows + 2 claims (held out); its roll-up is outside the family.
    expect(plan.sections.tuned!.m).toBe(7);
    expect(plan.sections.heldOut!.m).toBe(5);
    expect(plan.sections.tuned!.fixed).toHaveProperty("minRowsToConfirm");
    expect(plan.sections.tuned!.sequential.scheme).toMatchObject({ implemented: false, lookEveryReps: 2, looks: 2 });
    const rollup = plan.scenarios[1].rows.find((r) => r.kind === "semantic_rollup")!;
    expect(rollup.inFamily).toBe(false);
  });

  it("a fresh run dir: every row unknown, the cost a LOWER BOUND, and the text names the redirect", async () => {
    const { scen, a, b } = setup();
    const log: string[] = [];
    const { plan } = await planEvalDryRun(dry(scen, a, b), planDeps([], { log, redirected: true }));
    expect(plan.cost.lowerBound).toBe(true);
    expect(plan.cost.unpriced).toEqual(["csv-metrics"]);
    expect(plan.history).toMatchObject({ runsDirRedirected: true, indexRows: 0, rateWindow: 50 });
    expect(plan.scenarios[0].rows.every((r) => r.rate === "unknown")).toBe(true);
    expect(plan.caveats).toContain("detectable-is-not-power");
    const text = planText(plan).join("\n");
    expect(text).toMatch(/redirected by --run-dir \/ COWORK_HARNESS_RUNS_DIR/);
    expect(text).toMatch(/LOWER BOUND/);
    expect(text).toMatch(/rate unknown · best case at --reps 5/);
  });
});

describe("eval --dry-run: the host-claude isolation check", () => {
  it("refuses a dry run whose scenarios call the judge, as the real eval does, before the budget gate and carrying the plan", async () => {
    const { scen, a, b } = setup({ semantic: true });
    const plans: EvalPlan[] = [];
    const deps = { ...planDeps([], { plans }), isolationCheck: () => "OLD-CLI-REFUSAL" };
    const err = await planEvalDryRun(dry(scen, a, b, ["--judge-model", "claude-opus-4-8", "--max-budget-usd", "5"]), deps).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UsageError);
    expect((err as Error).message).toMatch(/OLD-CLI-REFUSAL/);
    expect(plans).toHaveLength(1);
    expect(budgetStatus()).toBeUndefined(); // refused before the budget gate ran
  });

  it("refuses a dry run whose only judged assert is semantic_pairwise", async () => {
    const { scen, a, b } = setup();
    const key = composeKey(COMPOSER_ID, { includeSubagentText: false, includeForkResults: false, evidenceFiles: undefined });
    freezeRef(
      join(root, "refs"),
      "pairwise",
      { command: "ref freeze", runDir: "~/r", resultSha256: "a".repeat(64) },
      { [key]: "a reference answer" },
      {
        harnessVersion: "t",
        composerId: COMPOSER_ID,
        scenario: "pairwise",
        taskSha256: createHash("sha256").update("write", "utf8").digest("hex"),
      },
    );
    // Only the pairwise scenario: the csv one has no judged assert.
    rmSync(join(scen, "csv-metrics.yaml"));
    writeFileSync(
      join(scen, "pairwise.yaml"),
      `baseline: latest\nsession: ../session.yaml\nfidelity: container\nprompt: write\nassert:\n  - semantic_pairwise:\n      judge_model: claude-opus-4-8\n      refs: [../refs]\n`,
    );
    let asked = 0;
    const deps = { ...planDeps([]), isolationCheck: () => (asked++, "OLD-CLI-REFUSAL") };
    await expect(planEvalDryRun(dry(scen, a, b), deps)).rejects.toThrow(/OLD-CLI-REFUSAL/);
    expect(asked).toBe(1);
  });

  it("does not consult it when no scenario calls the judge or the LLM decider", async () => {
    const { scen, a, b } = setup();
    let asked = 0;
    await planEvalDryRun(dry(scen, a, b), { ...planDeps([]), isolationCheck: () => (asked++, undefined) });
    expect(asked).toBe(0);
  });
});

describe("eval --max-budget-usd: a pre-flight refusal, on the dry run and the real run alike", () => {
  // Worst run $1, one scenario, --reps 5: 10 jobs, so the gate's estimate is $10.
  const priced = () => [historyRun("csv-metrics", { costUsd: 0.5 }), historyRun("csv-metrics", { costUsd: 1 })];

  it("refuses over the cap with a typed refusal carrying the marker and the plan, and records the marker first", async () => {
    const { scen, a, b } = setup();
    const err = await planEvalDryRun(dry(scen, a, b, ["--max-budget-usd", "9"]), planDeps(priced())).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EvalBudgetRefusal);
    const r = err as EvalBudgetRefusal;
    expect(r.status).toMatchObject({ capUsd: 9, basis: "batch", enforced: true, estimateUsd: 10, unpriced: [] });
    expect(r.plan?.cost.budgetGateWorstUsd).toBe(10);
    expect(budgetStatus()).toEqual(r.status);
    expect(r.message).toMatch(/refused before any run/);
    expect(r.message).toMatch(/10 run\(s\)/);
  });

  it("a cap equal to the estimate proceeds (strict >), and the marker is recorded", async () => {
    const { scen, a, b } = setup();
    const log: string[] = [];
    const { plan } = await planEvalDryRun(dry(scen, a, b, ["--max-budget-usd", "10"]), planDeps(priced(), { log }));
    expect(plan.cost.jobs).toBe(10);
    expect(budgetStatus()).toMatchObject({ capUsd: 10, enforced: true, estimateUsd: 10 });
    expect(log.join("\n")).toMatch(/--max-budget-usd \$10\.0000/);
  });

  it("no priced history: a lower bound, not a refusal, and the warning names the redirect", async () => {
    const { scen, a, b } = setup();
    const log: string[] = [];
    await planEvalDryRun(dry(scen, a, b, ["--max-budget-usd", "5"]), planDeps([], { log, redirected: true }));
    expect(budgetStatus()).toMatchObject({
      enforced: "lower_bound",
      reason: "no_history",
      runsDirRedirected: true,
      unpriced: ["csv-metrics"],
    });
    expect(budgetStatus()!.estimateUsd).toBeUndefined();
    expect(log.join("\n")).toMatch(/LOWER BOUND/);
    expect(log.join("\n")).toMatch(/--run-dir \/ COWORK_HARNESS_RUNS_DIR/);
  });

  it("the real eval refuses the same way before any run, and leaves no eval dir", async () => {
    const { scen, a, b } = setup();
    const p = parseEvalArgs([
      scen,
      "--arm",
      `before=${a}`,
      "--arm",
      `after=${b}`,
      "--out",
      join(root, "eval"),
      "--quiet",
      "--max-budget-usd",
      "9",
    ]);
    const err = await runEval(p, planDeps(priced())).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EvalBudgetRefusal);
    expect((err as EvalBudgetRefusal).status.estimateUsd).toBe(10);
    expect(existsSync(join(root, "eval"))).toBe(false);
  });

  it("the real eval prints the cost and the uncovered judge spend beside the gate", async () => {
    const { scen, a, b } = setup();
    const log: string[] = [];
    const p = parseEvalArgs([scen, "--arm", `before=${a}`, "--arm", `after=${b}`, "--out", join(root, "eval"), "--max-budget-usd", "9"]);
    await runEval(p, planDeps(priced(), { log })).catch(() => undefined);
    expect(log.join("\n")).toMatch(/\[eval\] cost at --reps 5: estimated cost of 10 run\(s\)/);
    expect(log.join("\n")).toMatch(/\[eval\] judge: .*NOT covered by --max-budget-usd/);
  });

  it("a capped real eval prices from the index only: no result.json is read, and its plan is cost-only", async () => {
    const { scen, a, b } = setup();
    const p = parseEvalArgs([
      scen,
      "--arm",
      `before=${a}`,
      "--arm",
      `after=${b}`,
      "--out",
      join(root, "eval"),
      "--quiet",
      "--max-budget-usd",
      "9",
    ]);
    const err = (await runEval(p, planDeps(priced())).catch((e: unknown) => e)) as EvalBudgetRefusal;
    expect(err).toBeInstanceOf(EvalBudgetRefusal);
    expect(err.plan!.costOnly).toBe(true);
    expect(err.plan!.scenarios[0].rateHistory.reads).toBe(0);
    expect(err.plan!.scenarios[0].rows.every((r) => r.rate === "unknown")).toBe(true);
    expect(err.plan!.cost.budgetGateWorstUsd).toBe(10);
    // The same history on a dry run is read.
    const { plan } = await planEvalDryRun(dry(scen, a, b), planDeps(priced()));
    expect(plan.costOnly).toBe(false);
    expect(plan.scenarios[0].rateHistory.reads).toBe(2);
  });

  it("a usage error is not a budget refusal", async () => {
    const { scen, a } = setup();
    const err = await planEvalDryRun(dry(scen, a, a, ["--max-budget-usd", "9"]), planDeps(priced())).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect(err).not.toBeInstanceOf(EvalBudgetRefusal);
  });
});

describe("eval flags are documented where a consumer reads them", () => {
  const doc = (p: string) => readFileSync(join(import.meta.dirname, "..", p), "utf8");
  it("every eval flag is in docs/eval.md (--quiet and --dotenv are the global ones it does not repeat)", () => {
    const eval_ = doc("docs/eval.md");
    for (const f of [...EVAL_BOOLEAN_FLAGS, ...EVAL_VALUE_FLAGS].filter((x) => x !== "--quiet" && x !== "--dotenv"))
      expect(eval_, f).toContain(`\`${f}`);
  });
  it("the planner's flags are in docs/cli.md, the skill reference and the usage text", () => {
    const cli = doc("docs/cli.md");
    const ref = doc(".claude/skills/cowork-harness/references/eval.md");
    for (const f of ["--dry-run", "--target-effect", "--max-budget-usd"]) {
      expect(cli, f).toMatch(new RegExp(`eval[^\\n]*\`${f}`));
      expect(ref, f).toContain(f);
    }
    expect(ref).not.toMatch(/No budget flag/);
  });
  it("the docs state the dry run's own behaviours and where the budget rules now reach eval", () => {
    const flat = (p: string) => doc(p).replace(/\s+/g, " ");
    const evalDoc = flat("docs/eval.md");
    expect(evalDoc).toMatch(/set TMPDIR/); // the dry run's own exit-3 refusal and its remedy
    expect(evalDoc).toMatch(/--quiet` does not mute the plan/);
    expect(evalDoc).toMatch(/reads the run index only/); // a capped real eval, cost-only
    expect(evalDoc).toMatch(/any tier, baseline or turn of the scenario's name, hillclimb runs included/);
    const spec = flat("SPEC.md");
    expect(spec).toMatch(/inside a git work tree or git cannot tell whether it is \(set TMPDIR\)/);
    expect(evalDoc).toMatch(/or git cannot tell whether it is \(set TMPDIR\)/);
    expect(flat("CHANGELOG.md")).toMatch(/except the dry run's own temp-dir check: .* exits 3/);
    expect(spec).toMatch(/carries the `plan` when one was computed before it/);
    const cliTableRow = doc("docs/cli.md")
      .split("\n")
      .find((l) => l.startsWith("| `eval <scenario.yaml"))!;
    expect(cliTableRow).toMatch(/--dry-run/);
    expect(flat("docs/cli.md")).toMatch(/"lower_bound"` for a `record` batch or an `eval`/);
    expect(flat(".claude/skills/cowork-harness/references/task-recipes.md")).toMatch(/--dry-run --target-effect/);
    expect(doc("docs/eval.md")).not.toMatch(/There is no budget flag/);
  });
});

// A signal during a dry run must not leave the temp snapshot behind. The handler can only be exercised in a
// process that is allowed to die, so this runs a script against the REAL source (via tsx) in a child node,
// the way test/termination-handler.test.ts does: the script raises SIGINT on itself the moment the snapshot
// root exists, and the test checks the exit code and that the root is gone.
describe.runIf(process.platform !== "win32")("eval --dry-run: a signal mid-plan", () => {
  it("SIGINT removes the temp snapshot root and exits 130", async () => {
    const { scen, a, b } = setup();
    const marker = join(root, "snap-root.txt");
    const script = join(root, "dry.mts");
    const cmd = JSON.stringify(join(import.meta.dirname, "..", "src", "eval", "command.ts"));
    writeFileSync(
      script,
      `import { writeFileSync } from "node:fs";
       import { parseEvalArgs, planEvalDryRun } from ${cmd};
       const args = parseEvalArgs([${JSON.stringify(scen)}, "--arm", ${JSON.stringify(`before=${a}`)}, "--arm", ${JSON.stringify(`after=${b}`)},
         "--out", ${JSON.stringify(join(root, "eval"))}, "--quiet", "--dry-run"]);
       await planEvalDryRun(args, {
         runJob: async () => { throw new Error("never"); },
         tokenCheck: () => ({ id: "token", title: "t", status: "ok", detail: "ok", required: true }),
         log: () => {},
         readIndex: () => [],
         onSnapshotRoot: (d) => { writeFileSync(${JSON.stringify(marker)}, d); process.kill(process.pid, "SIGINT"); },
       });
       setTimeout(() => {}, 30_000);`,
    );
    const { spawn } = await import("node:child_process");
    const proc = spawn(process.execPath, ["--import", "tsx", script], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, COWORK_HARNESS_RUNS_DIR: join(root, "runs-unused") },
    });
    let stderr = "";
    proc.stderr!.on("data", (d) => (stderr += d));
    const killer = setTimeout(() => proc.kill("SIGKILL"), 30_000);
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((res) => proc.on("exit", (c, s) => res([c, s])));
    clearTimeout(killer);
    expect(signal, stderr).toBeNull();
    expect(code, stderr).toBe(130);
    const snapRoot = readFileSync(marker, "utf8");
    expect(snapRoot).toMatch(/cwh-eval-plan-/);
    expect(existsSync(snapRoot)).toBe(false);
  }, 60_000);
});

describe("eval --dry-run: the plan's text", () => {
  it("a 3/3 ceiling: the rise is impossible at the point estimate, and the N at the interval's lower end is printed", async () => {
    const { scen, a, b } = setup();
    const rows = [1, 2, 3].map(() => historyRun("csv-metrics", { costUsd: 1 }));
    const { plan } = await planEvalDryRun(dry(scen, a, b, ["--target-effect", "30pp"]), planDeps(rows));
    const text = planText(plan).join("\n");
    expect(text).toMatch(/row \[0\] result: rate 100% \(3\/3, 95% CI 44%–100%, THIN\)/);
    expect(text).toMatch(/30pp rise: impossible at the point estimate \(the effect leaves 0–100%\)/);
    expect(text).toMatch(
      /if the true rate is 44% \(the interval's lower end\), a 30pp rise: possible N=\d+ .*; confirmed \(single row\) .*; 80% power: possible .*, confirmed /,
    );
    expect(text).not.toMatch(/possible impossible/);
    expect(text).not.toMatch(/to n\/a/);
  });

  it("each target N prints its p50 and p95 cost, for the scenario and the whole eval", async () => {
    const { scen, a, b } = setup();
    const rows = Array.from({ length: 14 }, (_, i) => historyRun("csv-metrics", { costUsd: 1 + (i % 2), fail: i < 10 ? [2] : [] }));
    const { plan } = await planEvalDryRun(dry(scen, a, b, ["--target-effect", "50pp"]), planDeps(rows));
    // N=12, per-run p50 $2 (floor index of 7 x $1, 7 x $2) and p95 $2: 2 x 12 x $2 = $48 for both.
    expect(planText(plan).join("\n")).toMatch(
      /50pp rise: possible N=12 \(power ≈ 61%; \$48\.0000 p50 \/ \$48\.0000 p95 this scenario, \$48\.0000 p50 \/ \$48\.0000 p95 whole eval\)/,
    );
  });

  it("the sequential preview states its spacing caveat, and under bh that bh is not sequentially valid", async () => {
    const { scen, a, b } = setup();
    const bh = planText((await planEvalDryRun(dry(scen, a, b), planDeps([]))).plan).join("\n");
    expect(bh).toMatch(/A look every block is the most conservative spacing/);
    expect(bh).toMatch(/bh is not sequentially valid: the preview uses holm within a look/);
    const holm = planText((await planEvalDryRun(dry(scen, a, b, ["--correction", "holm"]), planDeps([]))).plan).join("\n");
    expect(holm).not.toMatch(/not sequentially valid/);
  });

  it("history on other tiers or baselines is named as left out of the cost basis; the gate basis says it includes hillclimb runs", async () => {
    const { scen, a, b } = setup();
    const rows = [
      historyRun("csv-metrics", { costUsd: 1 }),
      historyRun("csv-metrics", { costUsd: 9, tier: "hostloop" }),
      historyRun("csv-metrics", { costUsd: 7, baseline: "0.0.1" }),
    ];
    const { plan } = await planEvalDryRun(dry(scen, a, b), planDeps(rows));
    const text = planText(plan).join("\n");
    expect(text).toMatch(/left out of the cost basis: 1 run\(s\) on other tiers, 1 on other baselines/);
    expect(text).toMatch(/on ANY tier, baseline or turn, hillclimb runs included/);
    expect(plan.scenarios[0].cost).not.toHaveProperty("distinctTiers");
  });

  it("the gate notice says its BASIS is wider, not its figure", async () => {
    const { scen, a, b } = setup();
    const log: string[] = [];
    await planEvalDryRun(dry(scen, a, b, ["--max-budget-usd", "20"]), planDeps([historyRun("csv-metrics", { costUsd: 1 })], { log }));
    expect(log.join("\n")).toMatch(
      /on a wider basis than the plan's worstObservedUsd \(any tier, baseline or turn, hillclimb runs included\), so it can be larger/,
    );
  });

  it("a real eval's refusal text names the JSON field it can be read from, not a plan it does not print", async () => {
    const { scen, a, b } = setup();
    const p = parseEvalArgs([
      scen,
      "--arm",
      `before=${a}`,
      "--arm",
      `after=${b}`,
      "--out",
      join(root, "eval"),
      "--quiet",
      "--max-budget-usd",
      "1",
    ]);
    const err = (await runEval(p, planDeps([historyRun("csv-metrics", { costUsd: 1 })])).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/plan\.cost\.budgetGateWorstUsd in the JSON envelope/);
    expect(err.message).not.toMatch(/the plan's budgetGateWorstUsd/);
  });
});
