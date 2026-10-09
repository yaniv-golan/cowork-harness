import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { recordBudgetStatus, budgetStatus, resetBudgetStatus, type BudgetStatus } from "../src/run/budget-status.js";
import { jsonEnvelope, jsonError, jsonPayloadEnvelope } from "../src/run/envelope.js";

// `--max-budget-usd` in the JSON channel: an UNCAPPED run is marked in the envelope (top-level `budget`),
// and a budget REFUSAL is told apart from a load failure by `error.code: "budget_exceeded"` + `error.budget`.
//
// Everything here is TOKEN-FREE, behind TWO independent guards on every spawned CLI:
//  1. COWORK_HARNESS_FORBID_SPAWN=1 (set explicitly in `cli()`): the harness refuses to stage or launch an
//     agent at all, so no test here can reach a paid run even if a gate under test lets it through.
//  2. For the uncapped `run`/`skill` cases, a malformed COWORK_HARNESS_AUTHORED_TOTAL_BYTES, which
//     `executeScenario` rejects after the budget pre-flight but before it creates a run dir or reaches a
//     spawn — so the envelope under test is the real CLI's, with the marker the real pre-flight armed.
// The refusals fire before any spawn by construction.
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

const PINNED = { COWORK_HARNESS_MODEL: "claude-sonnet-5" };
/** Stops `run`/`skill` after the budget pre-flight and before any spawn or run dir (see header). */
const STOP_BEFORE_SPAWN = { COWORK_HARNESS_AUTHORED_TOTAL_BYTES: "garbage" };

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

function seedRun(root: string, scenario: string, runId: string, costUsd: number) {
  const dir = join(root, scenario, runId);
  mkdirSync(join(dir, "turns", "1"), { recursive: true });
  writeFileSync(
    join(dir, "turns", "1", "result.json"),
    JSON.stringify({
      scenario,
      fidelity: "container",
      baseline: "desktop-1.18286.0",
      result: "success",
      decisions: [],
      egress: [],
      assertions: [],
      outDir: dir,
      cost: { usd: costUsd },
    }),
  );
}

function scenarioYaml(name: string): string {
  return `name: ${name}\nprompt: "do the thing"\nfidelity: protocol\nassert:\n  - result: success\n`;
}

/** Spawn the CLI against an explicit runs root (`COWORK_HARNESS_RUNS_DIR`), or — with `root: null` — the
 *  DEFAULT runs root under a throwaway HOME, so the developer's real `~/.cowork-harness/runs` is never read
 *  or written. */
/** Under vitest's 30 s test timeout, so a CLI that hangs fails here, with its pid and stderr, instead. */
const CLI_TIMEOUT_MS = 20_000;

function cli(args: string[], root: string | null, extraEnv: Record<string, string> = {}) {
  // FORBID_SPAWN is set explicitly rather than inherited from the unit-lane setup file, so this file stays
  // spawn-safe however it is run.
  const env: Record<string, string | undefined> = { ...process.env, ...PINNED, ...extraEnv, COWORK_HARNESS_FORBID_SPAWN: "1" };
  delete env.COWORK_HARNESS_RUNS_DIR;
  delete env.COWORK_HARNESS_OUTPUT_FORMAT;
  if (root === null) env.HOME = tmp("budget-home-");
  else env.COWORK_HARNESS_RUNS_DIR = root;
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8", env, input: "", timeout: CLI_TIMEOUT_MS, killSignal: "SIGKILL" });
  // spawnSync blocks the worker, so vitest's own test timeout cannot end a CLI that never exits: without this the
  // file hung for over an hour once (a Node exit-time deadlock). Fail with what the next occurrence needs.
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT")
    throw new Error(
      `cowork-harness ${args.join(" ")} did not exit within ${CLI_TIMEOUT_MS} ms (pid ${r.pid}, killed)\n--- stderr ---\n${r.stderr}`,
    );
  let json: Record<string, any> | undefined;
  try {
    json = JSON.parse(r.stdout.trim().split("\n").pop() ?? "");
  } catch {
    json = undefined;
  }
  return { code: r.status, out: r.stdout, err: r.stderr, json, home: env.HOME };
}

function reindex(root: string) {
  cli(["stats", "--reindex"], root);
}

/** `skill` names its scenario `skill-<dir basename>`, so the plugin lives in a fixed-name dir. */
function makePlugin(): string {
  const dir = join(tmp("budget-plug-"), "budgetplug");
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  mkdirSync(join(dir, "skills", "demo"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "budgetplug", version: "0.0.1" }));
  writeFileSync(join(dir, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: demo skill\n---\nhi\n");
  return dir;
}

describe.skipIf(!can)("--max-budget-usd uncapped marker (top-level `budget`)", () => {
  it("fresh --run-dir: marks the run uncapped AND the warning names the redirect as the cause", () => {
    const work = tmp("budget-work-");
    writeFileSync(join(work, "fresh.yaml"), scenarioYaml("fresh"));
    const runs = tmp("budget-runs-");
    const r = cli(["record", join(work, "fresh.yaml"), "--max-budget-usd", "5", "--dry-run", "--output-format", "json"], runs);
    expect(r.code).toBe(0);
    expect(r.json?.ok).toBe(true);
    expect(r.json?.budget).toEqual({
      capUsd: 5,
      basis: "single",
      enforced: false,
      reason: "no_history",
      unpriced: ["fresh"],
      runsDir: runs,
      runsDirRedirected: true,
    });
    expect(r.err).toMatch(/proceeding UNCAPPED/);
    expect(r.err).toMatch(/--run-dir \/ COWORK_HARNESS_RUNS_DIR/);
    expect(r.err).toMatch(/reuse one runs dir across invocations/);
  });

  it("default runs dir with no history: marker present, the old wording (no redirect cause), nothing written", () => {
    const work = tmp("budget-work-");
    writeFileSync(join(work, "fresh.yaml"), scenarioYaml("fresh"));
    const r = cli(["record", join(work, "fresh.yaml"), "--max-budget-usd", "5", "--dry-run", "--output-format", "json"], null);
    expect(r.code).toBe(0);
    expect(r.json?.budget).toMatchObject({ enforced: false, reason: "no_history", unpriced: ["fresh"], runsDirRedirected: false });
    expect(r.json?.budget.runsDir).toBe(join(r.home!, ".cowork-harness", "runs"));
    expect(r.err).toMatch(/no priced run history for "fresh" — cannot pre-flight this run, proceeding UNCAPPED/);
    expect(r.err).not.toMatch(/redirected/);
    expect(r.err).not.toMatch(/COWORK_HARNESS_RUNS_DIR/);
    // A read-only gate: the throwaway HOME stays empty.
    expect(readdirSync(r.home!)).toEqual([]);
  });

  it("priced under the cap: `enforced: true` with the estimate it was checked against", () => {
    const runs = tmp("budget-runs-");
    const work = tmp("budget-work-");
    seedRun(runs, "cheap", "local_1", 0.01);
    seedRun(runs, "cheap", "local_2", 0.03);
    reindex(runs);
    writeFileSync(join(work, "cheap.yaml"), scenarioYaml("cheap"));
    const r = cli(["record", join(work, "cheap.yaml"), "--max-budget-usd", "5", "--dry-run", "--output-format", "json"], runs);
    expect(r.code).toBe(0);
    expect(r.json?.budget).toEqual({
      capUsd: 5,
      basis: "single",
      enforced: true,
      estimateUsd: 0.03,
      unpriced: [],
      runsDir: runs,
      runsDirRedirected: true,
    });
  });

  it("absent when --max-budget-usd was not passed", () => {
    const work = tmp("budget-work-");
    writeFileSync(join(work, "fresh.yaml"), scenarioYaml("fresh"));
    const r = cli(["record", join(work, "fresh.yaml"), "--dry-run", "--output-format", "json"], tmp("budget-runs-"));
    expect(r.code).toBe(0);
    expect(r.json).toBeDefined();
    expect("budget" in r.json!).toBe(false);
  });

  it('record <dir/> batch with unpriced scenarios: `enforced: "lower_bound"` on the dry-run payload', () => {
    const runs = tmp("budget-runs-");
    const work = tmp("budget-work-");
    seedRun(runs, "priced", "local_1", 0.02);
    reindex(runs);
    writeFileSync(join(work, "priced.yaml"), scenarioYaml("priced"));
    writeFileSync(join(work, "unpriced.yaml"), scenarioYaml("unpriced"));
    const r = cli(["record", work, "--max-budget-usd", "5", "--dry-run", "--output-format", "json"], runs);
    expect(r.code).toBe(0);
    expect(r.json?.budget).toEqual({
      capUsd: 5,
      basis: "batch",
      enforced: "lower_bound",
      reason: "no_history",
      estimateUsd: 0.02,
      unpriced: ["unpriced"],
      runsDir: runs,
      runsDirRedirected: true,
    });
  });

  it("run (real CLI, stopped before spawn): the envelope that ends the run carries the marker", () => {
    const work = tmp("budget-work-");
    writeFileSync(join(work, "fresh.yaml"), scenarioYaml("fresh"));
    const runs = join(tmp("budget-runs-"), "fresh-dir");
    const r = cli(["run", join(work, "fresh.yaml"), "--max-budget-usd", "5", "--output-format", "json"], runs, STOP_BEFORE_SPAWN);
    expect(r.json?.command).toBe("run");
    expect(r.json?.error?.message).toMatch(/COWORK_HARNESS_AUTHORED_TOTAL_BYTES/);
    expect(r.json?.budget).toMatchObject({ basis: "single", enforced: false, unpriced: ["fresh"], runsDirRedirected: true });
    // Nothing ran: no run dir was created.
    expect(existsSync(runs)).toBe(false);
  });

  it("run <dir/>: one marker for every scenario, and the redirect cause is stated ONCE, not per scenario", () => {
    const work = tmp("budget-work-");
    writeFileSync(join(work, "a.yaml"), scenarioYaml("a"));
    writeFileSync(join(work, "b.yaml"), scenarioYaml("b"));
    const r = cli(["run", work, "--max-budget-usd", "5", "--output-format", "json"], tmp("budget-runs-"), STOP_BEFORE_SPAWN);
    expect(r.json?.budget).toMatchObject({ basis: "single", enforced: false, unpriced: ["a", "b"] });
    expect(r.err.match(/proceeding UNCAPPED/g)).toHaveLength(2);
    expect(r.err.match(/--run-dir \/ COWORK_HARNESS_RUNS_DIR/g)).toHaveLength(1);
  });

  it("skill (real CLI, stopped before spawn): the envelope carries the marker", () => {
    const r = cli(
      ["skill", makePlugin(), "hello", "--max-budget-usd", "5", "--output-format", "json"],
      tmp("budget-runs-"),
      STOP_BEFORE_SPAWN,
    );
    expect(r.json?.command).toBe("skill");
    expect(r.json?.budget).toMatchObject({ basis: "single", enforced: false, unpriced: ["skill-budgetplug"] });
  });
});

describe.skipIf(!can)("--max-budget-usd refusal is distinguishable in JSON (`error.code`)", () => {
  function pricey() {
    const runs = tmp("budget-runs-");
    const work = tmp("budget-work-");
    seedRun(runs, "pricey", "local_1", 0.5);
    seedRun(runs, "pricey", "local_2", 0.2);
    reindex(runs);
    writeFileSync(join(work, "pricey.yaml"), scenarioYaml("pricey"));
    return { runs, work };
  }

  it("record: budget-only refusal → error.code budget_exceeded + the numbers, category runtime, exit 1", () => {
    const { runs, work } = pricey();
    const r = cli(["record", join(work, "pricey.yaml"), "--max-budget-usd", "0.1", "--dry-run", "--output-format", "json"], runs);
    expect(r.code).toBe(1);
    expect(r.json?.ok).toBe(false);
    expect(r.json?.error).toMatchObject({
      category: "runtime",
      code: "budget_exceeded",
      budget: { capUsd: 0.1, estimateUsd: 0.5, basis: "single", enforced: true, unpriced: [], runsDir: runs, runsDirRedirected: true },
    });
    expect(r.json?.error.message).toMatch(/refused before spending/);
    expect(r.json?.budget).toEqual(r.json?.error.budget);
    // The single dry-run's input findings survive the refusal on the envelope.
    expect(r.json?.inputErrors).toEqual([]);
  });

  it("run: the same refusal keeps run's exit 2, now with error.code", () => {
    const { runs, work } = pricey();
    // STOP_BEFORE_SPAWN is a safety net only: were the gate to let this through, the run still spawns nothing.
    const r = cli(["run", join(work, "pricey.yaml"), "--max-budget-usd", "0.1", "--output-format", "json"], runs, STOP_BEFORE_SPAWN);
    expect(r.code).toBe(2);
    expect(r.json?.error).toMatchObject({ category: "runtime", code: "budget_exceeded", budget: { basis: "single", estimateUsd: 0.5 } });
    // The top-level marker is on the refusal's envelope too, and agrees with error.budget.
    expect(r.json?.budget).toEqual(r.json?.error.budget);
  });

  it("skill: the same refusal keeps skill's exit 2, now with error.code", () => {
    const runs = tmp("budget-runs-");
    seedRun(runs, "skill-budgetplug", "local_1", 0.5);
    reindex(runs);
    const r = cli(["skill", makePlugin(), "hello", "--max-budget-usd", "0.1", "--output-format", "json"], runs, STOP_BEFORE_SPAWN);
    expect(r.code).toBe(2);
    expect(r.json?.error).toMatchObject({ category: "runtime", code: "budget_exceeded", budget: { capUsd: 0.1, estimateUsd: 0.5 } });
  });

  it("record <dir/> batch refusal: basis batch, the summed estimate, the unpriced names", () => {
    const { runs, work } = pricey();
    writeFileSync(join(work, "unpriced.yaml"), scenarioYaml("unpriced"));
    const r = cli(["record", work, "--max-budget-usd", "0.1", "--dry-run", "--output-format", "json"], runs);
    expect(r.code).toBe(1);
    expect(r.json?.error).toMatchObject({
      code: "budget_exceeded",
      budget: { basis: "batch", estimateUsd: 0.5, enforced: "lower_bound", unpriced: ["unpriced"] },
    });
  });

  it("load-only failure carries NO error.code (single file that does not parse)", () => {
    const work = tmp("budget-work-");
    writeFileSync(join(work, "bad.yaml"), "name: [broken\n");
    const r = cli(
      ["record", join(work, "bad.yaml"), "--max-budget-usd", "0.1", "--dry-run", "--output-format", "json"],
      tmp("budget-runs-"),
    );
    expect(r.code).toBe(2);
    expect(r.json?.error?.category).toBe("usage");
    expect("code" in r.json!.error).toBe(false);
    expect("budget" in r.json!.error).toBe(false);
  });

  it("load-only failure in a dir dry-run: payload envelope, no error.code, broken[] present", () => {
    const work = tmp("budget-work-");
    writeFileSync(join(work, "bad.yaml"), "name: [broken\nprompt: x\n");
    const r = cli(["record", work, "--max-budget-usd", "0.1", "--dry-run", "--output-format", "json"], tmp("budget-runs-"));
    expect(r.code).toBe(1);
    expect(r.json?.error).toBeNull();
    expect(r.json?.broken).toHaveLength(1);
  });

  it("budget refusal AND load failures together (dir dry-run): error.code AND broken[] both on the envelope", () => {
    const { runs, work } = pricey();
    writeFileSync(join(work, "bad.yaml"), "name: [broken\nprompt: x\n");
    const r = cli(["record", work, "--max-budget-usd", "0.1", "--dry-run", "--output-format", "json"], runs);
    expect(r.code).toBe(1);
    expect(r.json?.ok).toBe(false);
    expect(r.json?.error?.code).toBe("budget_exceeded");
    expect(r.json?.broken).toHaveLength(1);
    expect(r.json?.broken[0].file).toMatch(/bad\.yaml$/);
    expect(r.json?.scenarios).toHaveLength(1);
    expect(r.json?.inputErrors).toEqual([]);
    expect(r.json?.refusals).toEqual([]);
    expect(r.json?.dryRun).toBe(true);
  });
});

describe("recordBudgetStatus — merging per-scenario pre-flights", () => {
  beforeEach(() => resetBudgetStatus());
  afterEach(() => resetBudgetStatus());
  const base = { capUsd: 1, runsDir: "/r", runsDirRedirected: false };

  it("stays enforced while every scenario is priced, keeping the largest estimate", () => {
    recordBudgetStatus({ ...base, basis: "single", enforced: true, estimateUsd: 0.2, unpriced: [] });
    recordBudgetStatus({ ...base, basis: "single", enforced: true, estimateUsd: 0.4, unpriced: [] });
    expect(budgetStatus()).toEqual({ ...base, basis: "single", enforced: true, estimateUsd: 0.4, unpriced: [] });
  });

  it("one unpriced scenario makes the whole invocation `enforced: false` and is named", () => {
    recordBudgetStatus({ ...base, basis: "single", enforced: true, estimateUsd: 0.2, unpriced: [] });
    recordBudgetStatus({ ...base, basis: "single", enforced: false, reason: "no_history", unpriced: ["x"] });
    recordBudgetStatus({ ...base, basis: "single", enforced: false, reason: "no_history", unpriced: ["x"] });
    expect(budgetStatus()).toEqual({ ...base, basis: "single", enforced: false, reason: "no_history", estimateUsd: 0.2, unpriced: ["x"] });
  });

  it("is undefined until a pre-flight records something", () => {
    expect(budgetStatus()).toBeUndefined();
  });
});

describe("the shared envelope builders publish the recorded status", () => {
  beforeEach(() => resetBudgetStatus());
  afterEach(() => resetBudgetStatus());
  const status: BudgetStatus = {
    capUsd: 2,
    basis: "single",
    enforced: false,
    reason: "no_history",
    unpriced: ["s"],
    runsDir: "/r",
    runsDirRedirected: true,
  };

  it("results[] envelope (`jsonEnvelope`): `budget` equals the status, and is absent after a reset", () => {
    recordBudgetStatus(status);
    expect(JSON.parse(jsonEnvelope("run", [], {})).budget).toEqual(status);
    resetBudgetStatus();
    expect("budget" in JSON.parse(jsonEnvelope("run", [], {}))).toBe(false);
  });

  it("payload envelope: a payload's own `budget` key survives when no status exists, and loses to one that does", () => {
    expect(JSON.parse(jsonPayloadEnvelope("x", true, { budget: "payload" })).budget).toBe("payload");
    recordBudgetStatus(status);
    expect(JSON.parse(jsonPayloadEnvelope("x", true, { budget: "payload" })).budget).toEqual(status);
  });

  it("error envelope: payload findings cannot overwrite a frame key", () => {
    const e = JSON.parse(jsonError("record", "runtime", "m", undefined, [], { payload: { ok: true, results: ["x"], broken: [1] } }));
    expect(e.ok).toBe(false);
    expect(e.results).toEqual([]);
    expect(e.broken).toEqual([1]);
  });
});
