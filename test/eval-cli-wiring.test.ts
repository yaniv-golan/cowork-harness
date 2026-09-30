// The `eval` command through its REAL wiring — cmdEval → the job runner → runOneScenario → executeScenario —
// with only the agent itself replaced: a stub `claude` on PATH (test/helpers/stub-agent.ts) answers one
// clean protocol-tier turn, and answers the semantic judge's `claude -p` call too. No agent, no spend.
//
// What only this path can show: each job's run label, pre-assigned run id, substituted session and judge
// model reach executeScenario (the in-process tests use a fake runner and never cross that seam), and the
// model pin is checked by deriveModelProvenance over what the agent reported, not by a flag a test set.
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { CLI, POSIX, exited, makeStubFixture, spawnCli, type StubFixture } from "./helpers/stub-agent.js";
import { jobRunId } from "../src/eval/schedule.js";

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
