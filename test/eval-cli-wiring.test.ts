// The `eval` command through its REAL wiring — cmdEval → the job runner → runOneScenario → executeScenario —
// with only the agent itself replaced: a stub `claude` on PATH (test/helpers/stub-agent.ts) answers one
// clean protocol-tier turn, and answers the semantic judge's `claude -p` call too. No agent, no spend.
//
// What only this path can show: each job's run label, pre-assigned run id, substituted session and judge
// model reach executeScenario (the in-process tests use a fake runner and never cross that seam), and the
// model pin is checked by deriveModelProvenance over what the agent reported, not by a flag a test set.
import { describe, it, expect } from "vitest";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";
import { CLI, POSIX, exited, makeStubFixture, spawnCli, type StubFixture } from "./helpers/stub-agent.js";
import { jobRunId } from "../src/eval/schedule.js";
import { appendIndexRow, type RunIndexRow } from "../src/run/run-index.js";
import { loadBaseline } from "../src/baseline.js";

const can = POSIX && existsSync(CLI);

// eval refuses before its first run unless doctor's token check passes for the scenario's tier. The fixture
// blanks every credential variable, so each test that is meant to RUN sets this made-up value (it is never
// sent anywhere: the stub is the agent).
const FAKE_TOKEN = "stub-not-a-real-token";

// The first two stream lines of a REAL kept run whose agent had no usable login (hostloop, agent 2.1.x):
// the synthetic assistant reply and the is_error result, verbatim except the session/uuid/timestamp ids
// (set to "stub") and the result's subagent_stats (dropped). The agent then exits 1.
const AUTH_STREAM = join(import.meta.dirname, "fixtures", "eval-classify", "auth-agent-stream.jsonl");
const AUTH_STUB = [
  `echo "$*" >> "$STUB_ARGV_LOG"`,
  `case " $* " in *" --output-format json "*)`,
  `  printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"{\\"results\\":[{\\"index\\":0,\\"pass\\":false}]}","total_cost_usd":0.001,"modelUsage":{"claude-judge-stub-1":{"inputTokens":1,"outputTokens":1,"costUSD":0.001}}}'`,
  `  exit 0;;`,
  `esac`,
  `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"stub","model":"claude-sonnet-5","tools":[],"cwd":"/tmp"}'`,
  `cat "${AUTH_STREAM}"`,
  "cat >/dev/null",
  "exit 1",
].join("\n");

// The agent turn reports model claude-sonnet-5 (on its assistant message, where the run reads it). The judge's
// call (`-p --output-format json`; the agent's own is stream-json) answers the one rubric claim.
const STUB = [
  `echo "$*" >> "$STUB_ARGV_LOG"`,
  `case " $* " in *" --output-format json "*)`,
  `  printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"{\\"results\\":[{\\"index\\":0,\\"pass\\":true}]}","total_cost_usd":0.001,"modelUsage":{"claude-judge-stub-1":{"inputTokens":1,"outputTokens":1,"costUSD":0.001}}}'`,
  `  exit 0;;`,
  `esac`,
  `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"stub","model":"claude-sonnet-5","tools":[],"cwd":"/tmp"}'`,
  `printf '%s\\n' '{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-5","content":[{"type":"text","text":"the answer is 42"}]},"session_id":"stub"}'`,
  `printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"the answer is 42","session_id":"stub","num_turns":1,"total_cost_usd":0.0123,"usage":{"input_tokens":1,"output_tokens":1}}'`,
  "cat >/dev/null",
].join("\n");

function writePlugin(dir: string, body: string): void {
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "demo" }));
  mkdirSync(join(dir, "skills", "demo"), { recursive: true });
  writeFileSync(join(dir, "skills", "demo", "SKILL.md"), `---\nname: demo\ndescription: d\n---\n${body}\n`);
}

function setup(f: StubFixture) {
  writePlugin(join(f.cwd, "declared", "demo"), "declared");
  writePlugin(join(f.cwd, "a", "demo"), "version A");
  writePlugin(join(f.cwd, "b", "demo"), "version B");
  writeFileSync(join(f.cwd, "session.yaml"), "model: claude-sonnet-5\nplugins:\n  local_plugins:\n    - ./declared/demo\n");
  writeFileSync(
    join(f.cwd, "q.yaml"),
    "baseline: latest\nsession: ./session.yaml\nfidelity: protocol\nprompt: what is the answer?\nassert:\n" +
      "  - result: success\n  - semantic_matches:\n      rubric:\n        - The answer is 42.\n",
  );
}

async function evalRun(f: StubFixture, extra: string[]) {
  const out = join(f.root, "eval");
  const cli = spawnCli(f, [
    "eval",
    "q.yaml",
    "--arm",
    "a=./a/demo",
    "--arm",
    "b=./b/demo",
    "--reps",
    "4",
    "--concurrency",
    "2",
    "--judge-model",
    "claude-judge-stub-1",
    "--out",
    out,
    "--output-format",
    "json",
    ...extra,
  ]);
  const r = await exited(cli, 120_000);
  return { ...r, out, stdout: cli.stdoutText(), stderr: cli.stderrText() };
}

describe.runIf(can)("eval through the real job wiring (stub agent)", () => {
  it("each run carries its arm's label, its pre-assigned run id, the arm's snapshot, and the judge override", async () => {
    const argvLog = "argv.log";
    const f = makeStubFixture(STUB, { STUB_ARGV_LOG: "" });
    try {
      f.env.STUB_ARGV_LOG = join(f.root, argvLog);
      f.env.CLAUDE_CODE_OAUTH_TOKEN = FAKE_TOKEN;
      setup(f);
      const r = await evalRun(f, []);
      const env = JSON.parse(r.stdout);
      expect(
        r.code,
        JSON.stringify({
          summary: env.summary,
          arms: env.arms?.map((a: { buckets: unknown }) => a.buckets),
          judge: env.judgeDisagreements,
        }),
      ).toBe(0);
      expect(env.arms.map((a: { buckets: unknown }) => a.buckets)).toEqual([{ valid: 4 }, { valid: 4 }]);
      const manifest = JSON.parse(readFileSync(join(r.out, "manifest.json"), "utf8"));
      const lines = readFileSync(join(r.out, "runs.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(lines).toHaveLength(8);
      for (const line of lines) {
        const dir = line.runDir.replace(/^~/, f.env.HOME!);
        const result = JSON.parse(readFileSync(join(dir, "turns", "1", "result.json"), "utf8"));
        // The label reached the run through the per-job flag copy (concurrency 2: a shared object would mix them).
        expect(result.runLabel).toBe(`eval:${manifest.evalId}:${line.arm}`);
        // The run dir is the pre-assigned id, recomputable from the schedule.
        expect(basename(dir)).toBe(jobRunId(manifest.evalId, line.arm, 0, line.rep));
        // The run fingerprinted its arm's SNAPSHOT (else every rep would be arm_source_drift).
        const arm = manifest.arms.find((a: { label: string }) => a.label === line.arm);
        expect(result.fingerprint.contentSig).toBe(arm.sigs.q);
        expect(result.modelPinHonored).toBe(true);
      }
      // The judge ran with the override (a per-assert default would name another model).
      const judgeCalls = readFileSync(f.env.STUB_ARGV_LOG, "utf8")
        .split("\n")
        .filter((l) => l.includes("--output-format json"));
      expect(judgeCalls.length).toBeGreaterThan(0);
      for (const c of judgeCalls) expect(c).toContain("--model claude-judge-stub-1");
    } finally {
      f.cleanup();
    }
  }, 180_000);

  it("a pin the agent did not honour is model_mismatch, via the model the agent reported", async () => {
    const f = makeStubFixture(STUB, { STUB_ARGV_LOG: "" });
    try {
      f.env.STUB_ARGV_LOG = join(f.root, "argv.log");
      f.env.CLAUDE_CODE_OAUTH_TOKEN = FAKE_TOKEN;
      setup(f);
      // Pin opus; the stub agent reports claude-sonnet-5.
      const r = await evalRun(f, ["--model", "claude-opus-4-8"]);
      const env = JSON.parse(r.stdout);
      expect(env.arms.map((a: { buckets: unknown }) => a.buckets)).toEqual([{ model_mismatch: 4 }, { model_mismatch: 4 }]);
      expect(env.summary.allInsufficient).toBe(true);
      expect(r.code).toBe(1);
    } finally {
      f.cleanup();
    }
  }, 180_000);

  it("an agent that answers 'Not logged in' in every rep is never a green: infrastructure, insufficient, exit 1", async () => {
    const f = makeStubFixture(AUTH_STUB, { STUB_ARGV_LOG: "" });
    try {
      f.env.STUB_ARGV_LOG = join(f.root, "argv.log");
      f.env.CLAUDE_CODE_OAUTH_TOKEN = FAKE_TOKEN;
      setup(f);
      const r = await evalRun(f, []);
      const env = JSON.parse(r.stdout);
      expect(r.code, r.stderr).toBe(1);
      expect(env.ok).toBe(false);
      expect(env.arms.map((a: { buckets: unknown }) => a.buckets)).toEqual([{ errored_infra: 4 }, { errored_infra: 4 }]);
      expect(env.summary.erroredArms.map((e: { dominant: { rule: string } }) => e.dominant.rule)).toEqual(["auth", "auth"]);
      const md = readFileSync(join(r.out, "report.md"), "utf8");
      expect(md).toMatch(/Every rep of arm a in q errored.*\(auth\) 4\/4/);
      expect(md).not.toMatch(/\*\*no detectable change\*\*/);
    } finally {
      f.cleanup();
    }
  }, 180_000);

  it("no credential for the scenario's tier refuses before any run (exit 2, doctor's message), leaving no eval dir", async () => {
    const f = makeStubFixture(AUTH_STUB, { STUB_ARGV_LOG: "" });
    try {
      f.env.STUB_ARGV_LOG = join(f.root, "argv.log");
      setup(f);
      // hostloop: doctor fails a missing env token there whether or not a Keychain login exists.
      writeFileSync(join(f.cwd, "q.yaml"), readFileSync(join(f.cwd, "q.yaml"), "utf8").replace("fidelity: protocol", "fidelity: hostloop"));
      const r = await evalRun(f, []);
      expect(r.code, r.stdout + r.stderr).toBe(2);
      const env = JSON.parse(r.stdout);
      expect(env.ok).toBe(false);
      expect(env.error.message).toMatch(/no usable agent credential for fidelity hostloop/);
      expect(env.error.message).toMatch(/doctor --tier hostloop/);
      expect(existsSync(r.out)).toBe(false);
      expect(existsSync(f.stubPidFile)).toBe(false); // the agent was never started
    } finally {
      f.cleanup();
    }
  }, 180_000);
});

// `eval --dry-run` and `--max-budget-usd` through the real CLI: the stub agent is on PATH, and the tests assert
// it was never started (no pid file, no argv log) — the dry run spawns no agent and no decider channel.
async function dryRun(f: StubFixture, extra: string[]) {
  const out = join(f.root, "eval");
  const cli = spawnCli(f, ["eval", "q.yaml", "--arm", "a=./a/demo", "--arm", "b=./b/demo", "--reps", "4", "--out", out, ...extra]);
  const r = await exited(cli, 120_000);
  return { ...r, out, stdout: cli.stdoutText(), stderr: cli.stderrText() };
}

/** A priced history run of scenario q, on its tier and baseline, in the fixture's runs root (index only). */
function pricedHistory(f: StubFixture, costUsd: number, i: number): void {
  const row: RunIndexRow = {
    v: 1,
    ts: `2026-09-${String(10 + i).padStart(2, "0")}T00:00:00.000Z`,
    command: "run",
    scenario: "q",
    slug: "q",
    runId: `local_hist${i}`,
    fidelity: "protocol",
    effectiveFidelity: "protocol",
    baseline: loadBaseline("latest").appVersion,
    result: "success",
    pass: true,
    signals: [],
    costUsd,
    turn: 1,
    partial: false,
    nonDeterministic: false,
    outDir: join(f.runsDir, "q", `local_hist${i}`),
    git: { branch: null, sha: null },
  };
  appendIndexRow(f.runsDir, row);
}

const COVERED_COST_KEYS = ["jobs", "meanUsd", "p50Usd", "p95Usd", "worstObservedUsd", "lowerBound", "unpriced", "pricedRuns", "thinnest"];

describe.runIf(can)("eval --dry-run through the real CLI (stub agent never started)", () => {
  const fixture = () => {
    const f = makeStubFixture(STUB, { STUB_ARGV_LOG: "" });
    f.env.STUB_ARGV_LOG = join(f.root, "argv.log");
    f.env.CLAUDE_CODE_OAUTH_TOKEN = FAKE_TOKEN;
    setup(f);
    return f;
  };
  const neverStarted = (f: StubFixture) => {
    expect(existsSync(f.stubPidFile)).toBe(false);
    expect(existsSync(f.env.STUB_ARGV_LOG!)).toBe(false);
  };

  it("exit 0 with the plan payload; no agent, no eval dir", async () => {
    const f = fixture();
    try {
      pricedHistory(f, 0.5, 1);
      pricedHistory(f, 1, 2);
      const r = await dryRun(f, ["--dry-run", "--output-format", "json"]);
      expect(r.code, r.stderr).toBe(0);
      const env = JSON.parse(r.stdout);
      expect(env).toMatchObject({ command: "eval", ok: true, dryRun: true, error: null });
      expect(env.evalDir).toBeUndefined();
      expect(env.budget).toBeUndefined(); // no cap given
      for (const k of COVERED_COST_KEYS) expect(env.plan.cost, k).toHaveProperty(k);
      expect(env.plan.cost).toMatchObject({ jobs: 8, p50Usd: 8, worstObservedUsd: 8, pricedRuns: 2, lowerBound: false });
      expect(existsSync(r.out)).toBe(false);
      neverStarted(f);
    } finally {
      f.cleanup();
    }
  }, 180_000);

  it("text mode prints the plan and the caveat on stderr, and nothing on stdout", async () => {
    const f = fixture();
    try {
      const r = await dryRun(f, ["--dry-run", "--target-effect", "30pp"]);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toBe("");
      expect(r.stderr).toMatch(/DRY RUN/);
      expect(r.stderr).toMatch(/LOWER BOUND/);
      expect(r.stderr).toMatch(/Detectable = an observed difference this large reaches p ≤ alpha/);
      // No history in this runs root: every row is unknown, so the plan shows the rate-free best case only.
      expect(r.stderr).toMatch(/rate unknown · best case at --reps 4/);
      expect(r.stderr).toMatch(/sequential, tuned section/);
      expect(r.stderr).toMatch(/fixed design \(what eval runs today\), tuned section/);
      neverStarted(f);
    } finally {
      f.cleanup();
    }
  }, 180_000);

  it("--decider-cmd is never spawned and --decider-dir never created under --dry-run", async () => {
    const f = fixture();
    try {
      const marker = join(f.root, "decider-ran");
      const a = await dryRun(f, ["--dry-run", "--concurrency", "1", "--decider-cmd", `touch ${marker}`]);
      expect(a.code, a.stderr).toBe(0);
      expect(existsSync(marker)).toBe(false);
      const dir = join(f.root, "decider-dir");
      const b = await dryRun(f, ["--dry-run", "--concurrency", "1", "--decider-dir", dir]);
      expect(b.code, b.stderr).toBe(0);
      expect(existsSync(dir)).toBe(false);
      neverStarted(f);
    } finally {
      f.cleanup();
    }
  }, 180_000);

  it("a fresh run dir: the budget marker says lower_bound / no_history / redirected, and stderr names the cause", async () => {
    const f = fixture();
    try {
      const fresh = join(f.root, "fresh-runs");
      const r = await dryRun(f, ["--dry-run", "--max-budget-usd", "5", "--output-format", "json", "--run-dir", fresh]);
      expect(r.code, r.stderr).toBe(0);
      const env = JSON.parse(r.stdout);
      expect(env.budget).toMatchObject({ enforced: "lower_bound", reason: "no_history", runsDirRedirected: true, basis: "batch" });
      expect(env.plan.cost.lowerBound).toBe(true);
      expect(env.plan.scenarios[0].rows.every((x: { rate: unknown }) => x.rate === "unknown")).toBe(true);
      expect(r.stderr).toMatch(/--run-dir \/ COWORK_HARNESS_RUNS_DIR/);
      neverStarted(f);
    } finally {
      f.cleanup();
    }
  }, 180_000);

  it("over the cap: exit 2, budget_exceeded, the marker and the plan on the error envelope — dry run and real run alike", async () => {
    const f = fixture();
    try {
      pricedHistory(f, 1, 1); // worst $1 x 8 jobs = $8
      const d = await dryRun(f, ["--dry-run", "--max-budget-usd", "7", "--output-format", "json"]);
      expect(d.code, d.stderr).toBe(2);
      const env = JSON.parse(d.stdout);
      expect(env).toMatchObject({ ok: false, dryRun: true });
      expect(env.error).toMatchObject({
        category: "runtime",
        code: "budget_exceeded",
        budget: { basis: "batch", estimateUsd: 8, capUsd: 7 },
      });
      expect(env.budget).toMatchObject({ estimateUsd: 8, enforced: true });
      expect(env.plan.cost.budgetGateWorstUsd).toBe(8);
      // A cap equal to the estimate proceeds.
      const eq = await dryRun(f, ["--dry-run", "--max-budget-usd", "8", "--output-format", "json"]);
      expect(eq.code, eq.stderr).toBe(0);
      // The real eval refuses identically, before any run, and leaves no eval dir.
      const real = await dryRun(f, ["--max-budget-usd", "7", "--output-format", "json"]);
      expect(real.code, real.stderr).toBe(2);
      const renv = JSON.parse(real.stdout);
      expect(renv.error).toMatchObject({ code: "budget_exceeded", budget: { estimateUsd: 8 } });
      expect(renv.dryRun).toBeUndefined();
      expect(existsSync(real.out)).toBe(false);
      neverStarted(f);
    } finally {
      f.cleanup();
    }
  }, 180_000);

  it("every dry-run refusal says dryRun: true, with or without a plan (identical arms: before any plan)", async () => {
    const f = fixture();
    try {
      const cli = spawnCli(f, [
        "eval",
        "q.yaml",
        "--arm",
        "a=./a/demo",
        "--arm",
        "b=./a/demo",
        "--out",
        join(f.root, "eval"),
        "--dry-run",
        "--output-format",
        "json",
      ]);
      const r = await exited(cli, 120_000);
      expect(r.code, cli.stderrText()).toBe(2);
      const env = JSON.parse(cli.stdoutText());
      expect(env).toMatchObject({ ok: false, dryRun: true, error: { category: "usage" } });
      expect(env.error.message).toMatch(/the two arms are identical/);
      expect(env.plan).toBeUndefined();
      neverStarted(f);
    } finally {
      f.cleanup();
    }
  }, 180_000);

  it("a refusal after the plan carries plan + dryRun in JSON, and in text prints the plan before the refusal", async () => {
    const f = fixture();
    try {
      // q has 2 rows in the family; at --reps 4 holm cannot confirm (floor 0.0286 > 0.05/2).
      const unreachable = ["--dry-run", "--correction", "holm", "--fail-on", "confirmed"];
      const j = await dryRun(f, [...unreachable, "--output-format", "json"]);
      expect(j.code, j.stderr).toBe(2);
      const env = JSON.parse(j.stdout);
      expect(env).toMatchObject({ ok: false, dryRun: true, error: { category: "usage" } });
      expect(env.error.message).toMatch(/can never fire/);
      expect(env.plan.cost).toHaveProperty("jobs", 8);
      const t = await dryRun(f, unreachable);
      expect(t.code).toBe(2);
      const planAt = t.stderr.indexOf("[eval] DRY RUN");
      expect(planAt).toBeGreaterThanOrEqual(0);
      expect(t.stderr.indexOf("can never fire")).toBeGreaterThan(planAt);
      neverStarted(f);
    } finally {
      f.cleanup();
    }
  }, 180_000);

  it("an argument error carries no plan", async () => {
    const f = fixture();
    try {
      const r = await dryRun(f, ["--dry-run", "--reps", "1", "--output-format", "json"]);
      expect(r.code).toBe(2);
      const env = JSON.parse(r.stdout);
      expect(env.error.category).toBe("usage");
      expect(env.plan).toBeUndefined();
      neverStarted(f);
    } finally {
      f.cleanup();
    }
  }, 180_000);

  it("without --out, the default eval dir is never created", async () => {
    const f = fixture();
    try {
      const cli = spawnCli(f, [
        "eval",
        "q.yaml",
        "--arm",
        "a=./a/demo",
        "--arm",
        "b=./b/demo",
        "--reps",
        "4",
        "--dry-run",
        "--output-format",
        "json",
      ]);
      const r = await exited(cli, 120_000);
      expect(r.code, cli.stderrText()).toBe(0);
      expect(existsSync(join(f.env.HOME!, ".cowork-harness", "evals"))).toBe(false);
      neverStarted(f);
    } finally {
      f.cleanup();
    }
  }, 180_000);

  it("a Ctrl-C that also kills a git the dry run is waiting on exits 130, not a misleading staging error", async () => {
    const f = fixture();
    try {
      // A git shim ahead of the real one on PATH: when asked about the dry run's temp dir, it does what a
      // terminal Ctrl-C does to the whole foreground group — signal the harness — and dies itself. Every other
      // call goes to the real git.
      const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
      writeFileSync(
        join(f.root, "bin", "git"),
        `#!/bin/sh\ncase "$*" in *cwh-eval-plan-*) kill -INT $PPID; exit 130;; esac\nexec ${realGit} "$@"\n`,
      );
      chmodSync(join(f.root, "bin", "git"), 0o755);
      const r = await dryRun(f, ["--dry-run", "--output-format", "json"]);
      expect(r.signal, r.stderr).toBeNull();
      expect(r.code, r.stderr + r.stdout).toBe(130);
      neverStarted(f);
    } finally {
      f.cleanup();
    }
  }, 180_000);

  it("a host claude too old to run the judge isolated refuses the dry run (exit 2, dryRun + plan), as it refuses the eval", async () => {
    const f = fixture();
    try {
      // The judge's transport probes `claude --help` for its isolation flags: this one lists none.
      writeFileSync(
        join(f.root, "bin", "claude"),
        `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.100 (Claude Code)"; exit 0; fi\nif [ "$1" = "--help" ]; then exit 0; fi\necho $$ > "$STUB_PID"\nexit 1\n`,
      );
      const r = await dryRun(f, ["--dry-run", "--output-format", "json"]);
      expect(r.code, r.stderr).toBe(2);
      const env = JSON.parse(r.stdout);
      expect(env).toMatchObject({ ok: false, dryRun: true, error: { category: "usage" } });
      expect(env.plan.cost).toHaveProperty("jobs", 8);
      expect(existsSync(f.stubPidFile)).toBe(false);
    } finally {
      f.cleanup();
    }
  }, 180_000);

  it("a Ctrl-C queued during a dry run that otherwise succeeds exits 130, not 0", async () => {
    const f = fixture();
    try {
      // The shim signals the harness when asked about the temp dir, then answers like the real git: the dry
      // run succeeds, with a Ctrl-C waiting.
      const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
      writeFileSync(join(f.root, "bin", "git"), `#!/bin/sh\ncase "$*" in *cwh-eval-plan-*) kill -INT $PPID;; esac\nexec ${realGit} "$@"\n`);
      chmodSync(join(f.root, "bin", "git"), 0o755);
      const r = await dryRun(f, ["--dry-run", "--output-format", "json"]);
      expect(r.signal, r.stderr).toBeNull();
      expect(r.code, r.stderr + r.stdout).toBe(130);
      neverStarted(f);
    } finally {
      f.cleanup();
    }
  }, 180_000);

  it("--target-effect without --dry-run is a usage error (exit 2)", async () => {
    const f = fixture();
    try {
      const r = await dryRun(f, ["--target-effect", "30pp", "--output-format", "json"]);
      expect(r.code).toBe(2);
      expect(JSON.parse(r.stdout).error).toMatchObject({ category: "usage" });
      expect(JSON.parse(r.stdout).error.message).toMatch(/requires --dry-run/);
      neverStarted(f);
    } finally {
      f.cleanup();
    }
  }, 180_000);
});
