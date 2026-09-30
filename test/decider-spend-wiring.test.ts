import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { join } from "node:path";
import {
  CLI,
  POSIX,
  QUESTION_FRAME,
  credentialLeaks,
  exited,
  makeStubFixture,
  runDir,
  spawnCli,
  type StubFixture,
} from "./helpers/stub-agent.js";

// The LLM decider's spend has to travel from the decider instance `executeScenario` builds to BOTH result
// lanes. A unit test of `LlmDecider` cannot see that wiring, so this drives a real `run` against the stub
// agent (no agent, no spend). The same stub stands in for the decider transport: `claudeCliComplete`
// spawns `claude -p … --output-format json`, which resolves to the stub on PATH, and the stub answers that
// invocation with a priced envelope. The agent invocation raises one AskUserQuestion gate, waits for the
// harness's answer, then finishes successfully.

const can = POSIX && existsSync(CLI);

const envelope = (reply: string) =>
  JSON.stringify({
    result: reply,
    modelUsage: {
      "claude-sonnet-5": { inputTokens: 1200, outputTokens: 3, cacheReadInputTokens: 40, cacheCreationInputTokens: 7, costUSD: 0.0125 },
    },
  });
// A real agent opens its stream with system/init; apiRetries is only reported once a stream was observed.
const INIT = JSON.stringify({ type: "system", subtype: "init", tools: [], skills: [] });
const RESULT = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", num_turns: 1 });

function stub(reply: string, preamble = ""): string {
  return [
    preamble,
    `case " $* " in *" --output-format json "*) cat >/dev/null; printf '%s\\n' '${envelope(reply)}'; exit 0;; esac`,
    `printf '%s\\n' '${QUESTION_FRAME}'`,
    `while IFS= read -r line; do case "$line" in *'"q-1"'*) printf '%s\\n' '${RESULT}'; exit 0;; esac; done`,
  ].join("\n");
}

function scenario(f: StubFixture, extra: string): void {
  // The stub reads no config dir, so the L0 host-config guard is opted out (a verdict modifier): that keeps the exit code a
  // real signal for this lane instead of a guaranteed 1.
  writeFileSync(
    f.scenario,
    `baseline: latest\nfidelity: protocol\nprompt: say hi\n${extra}assert:\n  - result: success\n  - allow_l0_host_config_contamination: true\n`,
  );
}

function result(f: StubFixture): any {
  const d = runDir(f);
  const p = d && join(d, "turns", "1", "result.json");
  return p && existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : undefined;
}

async function run(f: StubFixture) {
  const cli = spawnCli(f, ["run", f.scenario, "--output-format", "json"]);
  const r = await exited(cli, 30_000);
  expect(credentialLeaks(f.envDump)).toEqual([]);
  return { ...r, stderr: cli.stderrText() };
}

describe.runIf(can)("the LLM decider's spend reaches result.json on both lanes", () => {
  it("an agent that dies before any stream arrives reports apiRetries absent, not zeros", async () => {
    // The stub consumes the harness's writes up to and including the user turn, then exits 1 without
    // emitting a single frame. A bare `exit 1` races the harness's first stdin write: on Linux the child is
    // usually gone before `initialize` is written, the write fails, and the run aborts as an internal error
    // with no result.json at all — a different path from the one under test (the agent died, the harness
    // salvaged a result). Waiting for the user turn removes the race without giving the harness a stream.
    const f = makeStubFixture(`while IFS= read -r line; do case "$line" in *'"type":"user"'*) exit 1;; esac; done; exit 1`);
    try {
      scenario(f, "");
      const r = await run(f);
      const res = result(f);
      expect(res, r.stderr).toBeDefined();
      expect(res.result).toBe("error");
      expect(res).not.toHaveProperty("apiRetries");
    } finally {
      f.cleanup();
    }
  });

  it("success lane: a gate the LLM decider answered records its cost and tokens", async () => {
    const f = makeStubFixture(stub("A"), { COWORK_HARNESS_LLM_RETRIES: "0" });
    try {
      scenario(f, "on_unanswered: llm\n");
      const r = await run(f);
      const res = result(f);
      expect(res, r.stderr).toBeDefined();
      expect(res.partial).toBeFalsy();
      expect(res.decisions.some((d: { by: string }) => d.by === "llm")).toBe(true);
      expect(res.deciderCostUsd).toBeCloseTo(0.0125, 10);
      expect(res.deciderUsage).toEqual({
        input_tokens: 1200,
        output_tokens: 3,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 7,
      });
      expect(res.result, r.stderr).toBe("success");
      expect(r.code, r.stderr).toBe(0);
    } finally {
      f.cleanup();
    }
  });

  it("salvage lane: the call on the gate that then failed to bind is still recorded on the partial result", async () => {
    const f = makeStubFixture(stub("I would rather not choose"), { COWORK_HARNESS_LLM_RETRIES: "0" });
    try {
      scenario(f, "on_unanswered: llm\n");
      const r = await run(f);
      expect(r.code, r.stderr).toBe(2);
      const res = result(f);
      expect(res?.partial, r.stderr).toBe(true);
      expect(res.deciderCostUsd).toBeCloseTo(0.0125, 10);
      expect(res.deciderUsage?.input_tokens).toBe(1200);
    } finally {
      f.cleanup();
    }
  });

  it("a scripted answer spends nothing on a decider: both fields are absent, not zero", async () => {
    // The agent's side of this run replays the real retry frames from the api-retry fixture, so the live
    // lane's apiRetries wiring is exercised too (1 main-loop retry of 537 ms; 19 sub-agent retries).
    const f = makeStubFixture(
      stub("A", `printf '%s\\n' '${INIT}'; cat '${resolve("test/fixtures/api-retry/subagent-retry.events.jsonl")}'`),
    );
    try {
      scenario(f, "answers:\n  - when_question: Pick\n    choose: A\n");
      const r = await run(f);
      const res = result(f);
      expect(res, r.stderr).toBeDefined();
      expect(res.decisions.some((d: { by: string }) => d.by === "scripted")).toBe(true);
      expect(res).not.toHaveProperty("deciderCostUsd");
      expect(res).not.toHaveProperty("deciderUsage");
      expect(res.apiRetries).toEqual({ count: 1, delayMs: 537, subagentCount: 19, subagentDelayMs: 244519 });
      expect(res.result, r.stderr).toBe("success");
      expect(r.code, r.stderr).toBe(0);
    } finally {
      f.cleanup();
    }
  });
});
