// `allow_max_turns` through the real path: the stub agent emits the SDK's `error_max_turns` result, the harness's run.ts
// classifies it, executeScenario records the session's cap from the launch plan, and the verdict and the result file
// are what a user sees. No hand-built RunResult.
import { describe, it, expect } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeStubFixture, spawnCli, exited, POSIX } from "./helpers/stub-agent.js";

const can = POSIX && existsSync(resolve("dist/cli.js"));
const out = (o: unknown) => `printf '%s\\n' '${JSON.stringify(o)}'`;
const CAPPED = [
  out({ type: "system", subtype: "init", session_id: "stub", model: "claude-sonnet-5", tools: [], cwd: "/tmp" }),
  out({ type: "result", subtype: "error_max_turns", is_error: true, num_turns: 1, session_id: "stub", total_cost_usd: 0.01 }),
  "cat >/dev/null",
].join("\n");

async function run(assertBlock: string) {
  const f = makeStubFixture(CAPPED);
  try {
    const session = join(f.cwd, "capped.session.yaml");
    writeFileSync(session, "model: claude-sonnet-5\npermission_parity: cowork\nagent_max_turns: 1\n");
    writeFileSync(f.scenario, `baseline: latest\nfidelity: protocol\nsession: ${session}\nprompt: say hi\nassert:\n${assertBlock}`);
    const c = spawnCli(f, ["run", f.scenario, "--output-format", "json"]);
    const { code } = await exited(c, 60_000);
    const env = JSON.parse(c.stdoutText());
    return { code, stderr: c.stderrText(), r: env.results[0] };
  } finally {
    f.cleanup();
  }
}

describe.runIf(can)("a session's turn cap, end to end (stub agent, protocol)", () => {
  it("allow_max_turns: the run completes; the result records the cap and is still error", async () => {
    const { code, stderr, r } = await run("  - allow_max_turns: true\n  - result: error\n");
    expect(code, stderr).toBe(0);
    expect(r.result).toBe("error");
    expect(r.turnCap).toEqual({ maxTurns: 1, source: "session" });
    expect(r.usage.turns).toBe(1);
    expect(r.verdict.pass).toBe(true);
    expect(r.verdict.signals.map((s: { code: string }) => s.code)).not.toContain("result_error");
  }, 90_000);

  it("without it: exit 1, result_error naming the cap and `assert allow_max_turns: true`", async () => {
    const { code, r } = await run("  - result: error\n");
    expect(code).toBe(1);
    const sig = r.verdict.signals.find((s: { code: string }) => s.code === "result_error");
    expect(sig.message).toContain("agent_max_turns: 1 cap was reached");
    expect(sig.message).toContain("assert allow_max_turns: true");
  }, 90_000);

  it("`result: success` beside it fails its own row with the completed-not-successful message", async () => {
    const { code, r } = await run("  - allow_max_turns: true\n  - result: success\n");
    expect(code).toBe(1);
    const row = r.assertions.find((a: { assertion: { result?: string } }) => a.assertion.result === "success");
    expect(row.pass).toBe(false);
    expect(row.message).toContain("allow_max_turns makes it a completed run, not a success");
    expect(r.verdict.signals.map((s: { code: string }) => s.code)).not.toContain("result_error");
  }, 90_000);
});
