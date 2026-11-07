// An unanswered gate inside an eval job is that job's error row, not an exit: eval's job runner passes
// `rethrowUnanswered`, so the job's run never reaches fail() (src/eval/job-runner.ts). That is why no pool function can
// raise an exit request today, and the pool's drain-on-exit path (pMapBounded, unit-tested in
// record-concurrency.test.ts) is a net for a future one. This pins the claim through the real CLI with a stub agent:
// if a job could ask to exit, this eval would stop after two agent runs with exit 2 instead of running all eight.
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLI, POSIX, QUESTION_FRAME, exited, makeStubFixture, spawnCli, type StubFixture } from "./helpers/stub-agent.js";
import { EXIT_FALLBACK_LINE } from "../src/run/exit.js";

const can = POSIX && existsSync(CLI);

// One script for every invocation. The judge's `-p --output-format json` call gets a passing grade. Of the agent
// runs, the FIRST to arrive (an atomic `mkdir`) asks a question nobody answers; every other one answers after a
// delay, so with --concurrency 2 the second job is still running when the first one's exit request arrives.
const STUB = [
  `case " $* " in *" --output-format json "*)`,
  `  printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"{\\"results\\":[{\\"index\\":0,\\"pass\\":true}]}","total_cost_usd":0.001,"modelUsage":{"claude-judge-stub-1":{"inputTokens":1,"outputTokens":1,"costUSD":0.001}}}'`,
  `  exit 0;;`,
  `esac`,
  `echo $$ >> "$STUB_AGENT_LOG"`,
  `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"stub","model":"claude-sonnet-5","tools":[],"cwd":"/tmp"}'`,
  `if mkdir "$STUB_AGENT_LOG.first" 2>/dev/null; then`,
  `  printf '%s\\n' '${QUESTION_FRAME}'`,
  `  cat >/dev/null`,
  `  exit 0`,
  `fi`,
  `sleep 2`,
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

describe.runIf(can)("an unanswered gate in an eval job is a job error, not an exit", () => {
  it("one job of eight asks a question nobody answers: every job still runs and writes its row, and the process ends by itself", async () => {
    const f = makeStubFixture(STUB);
    try {
      const agentLog = join(f.root, "agents.log");
      f.env.STUB_AGENT_LOG = agentLog;
      setup(f);
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
      ]);
      const r = await exited(cli, 120_000);
      const stderr = cli.stderrText();
      // Not the unanswered refusal (exit 2): the eval ran to its report.
      expect(r.code, stderr).not.toBe(2);
      expect(JSON.parse(cli.stdoutText().trim().split("\n").pop()!).command).toBe("eval");
      expect(stderr).toMatch(/threw UnansweredError/);
      expect(readFileSync(agentLog, "utf8").trim().split("\n"), stderr).toHaveLength(8);
      expect(readFileSync(join(out, "runs.jsonl"), "utf8").trim().split("\n").filter(Boolean), stderr).toHaveLength(8);
      expect(stderr).not.toContain("stopping: waiting for");
      expect(stderr).not.toContain(EXIT_FALLBACK_LINE);
    } finally {
      f.cleanup();
    }
  }, 180_000);
});
