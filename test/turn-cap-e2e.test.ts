// `allow_max_turns` through the real path: the stub agent emits the SDK's `error_max_turns` result, the harness's run.ts
// classifies it, executeScenario records the session's cap from the launch plan, and the verdict and the result file
// are what a user sees. No hand-built RunResult.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeStubFixture, spawnCli, exited, POSIX } from "./helpers/stub-agent.js";

const can = POSIX && existsSync(resolve("dist/cli.js"));
const out = (o: unknown) => `printf '%s\\n' '${JSON.stringify(o)}'`;
const CAPPED = [
  out({ type: "system", subtype: "init", session_id: "stub", model: "claude-sonnet-5", tools: [], cwd: "/tmp" }),
  out({ type: "result", subtype: "error_max_turns", is_error: true, num_turns: 1, session_id: "stub", total_cost_usd: 0.01 }),
  "cat >/dev/null",
].join("\n");
// The agent's own sign-in failure at the cap: a `<synthetic>` reply and a result the agent marks `success` but
// `is_error`. Same result fields the cap gives (error, kind agent, num_turns == cap), so only the subtype and the
// synthetic reply tell them apart.
const syntheticAuth = (subtype: string) =>
  [
    out({ type: "system", subtype: "init", session_id: "stub", model: "claude-sonnet-5", tools: [], cwd: "/tmp" }),
    out({
      type: "assistant",
      session_id: "stub",
      message: {
        model: "<synthetic>",
        role: "assistant",
        content: [{ type: "text", text: "Authentication required · Sign in again to continue" }],
      },
    }),
    out({
      type: "result",
      subtype,
      is_error: true,
      num_turns: 1,
      result: "Authentication required · Sign in again to continue",
      session_id: "stub",
      total_cost_usd: 0,
    }),
    "cat >/dev/null",
  ].join("\n");
const SYNTHETIC_AUTH = syntheticAuth("success");
// The same reply under a cap-stop subtype: only the `<synthetic>` reading (agent-infra-end.ts) can tell it from the cap.
const SYNTHETIC_AUTH_CAP_SUBTYPE = syntheticAuth("error_during_execution");

function setUp(f: ReturnType<typeof makeStubFixture>, assertBlock: string): void {
  const session = join(f.cwd, "capped.session.yaml");
  writeFileSync(session, "model: claude-sonnet-5\npermission_parity: cowork\nagent_max_turns: 1\n");
  writeFileSync(f.scenario, `baseline: latest\nfidelity: protocol\nsession: ${session}\nprompt: say hi\nassert:\n${assertBlock}`);
}

async function cli(f: ReturnType<typeof makeStubFixture>, args: string[]) {
  const c = spawnCli(f, args);
  const { code } = await exited(c, 60_000);
  return { code, stdout: c.stdoutText(), stderr: c.stderrText() };
}

async function run(assertBlock: string, script = CAPPED) {
  const f = makeStubFixture(script);
  try {
    setUp(f, assertBlock);
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

  it("a recording freezes the cap, stamps v19, and replays to the same verdict", async () => {
    const f = makeStubFixture(CAPPED);
    try {
      setUp(f, "  - allow_max_turns: true\n  - result: error\n");
      const cass = join(f.cwd, "capped.cassette.json");
      const rec = await cli(f, ["record", f.scenario, "--out", cass]);
      expect(rec.code, rec.stderr).toBe(0);
      const c = JSON.parse(readFileSync(cass, "utf8"));
      expect(c.cassetteVersion).toBe(19);
      expect(c.turnCap).toEqual({ maxTurns: 1, source: "session" });
      const rep = await cli(f, ["replay", cass, "--output-format", "json"]);
      expect(rep.code, rep.stderr).toBe(0);
      const r = JSON.parse(rep.stdout).results[0];
      expect(r.turnCap).toEqual({ maxTurns: 1, source: "session" });
      expect(r.verdict.pass).toBe(true);
      // Without the frozen cap (a cassette from before it was recorded) the modifier has nothing to read: the replayed
      // run fails as the live one would have without a cap.
      delete c.turnCap;
      writeFileSync(cass, JSON.stringify(c));
      const old = await cli(f, ["replay", cass, "--output-format", "json"]);
      expect(old.code).toBe(1);
      expect(JSON.parse(old.stdout).results[0].verdict.signals.map((s: { code: string }) => s.code)).toContain("result_error");
    } finally {
      f.cleanup();
    }
  }, 120_000);

  it.each([
    ["subtype success", SYNTHETIC_AUTH],
    ["subtype error_during_execution", SYNTHETIC_AUTH_CAP_SUBTYPE],
  ])(
    "the agent's own sign-in failure at the cap (%s) is not the cap: exit 1, result_error, live and on replay",
    async (_, script) => {
      const { code, r } = await run("  - allow_max_turns: true\n  - result: error\n", script);
      expect(code).toBe(1);
      expect(r.usage.turns).toBe(1);
      expect(r.verdict.signals.map((s: { code: string }) => s.code)).toContain("result_error");
      const f = makeStubFixture(script);
      try {
        setUp(f, "  - allow_max_turns: true\n  - result: error\n");
        const cass = join(f.cwd, "auth.cassette.json");
        // The live verdict fails, so record refuses unless told to freeze it anyway.
        const rec = await cli(f, ["record", f.scenario, "--out", cass, "--allow-failing"]);
        expect(rec.code, rec.stderr).toBe(0);
        const rep = await cli(f, ["replay", cass, "--output-format", "json"]);
        expect(rep.code, rep.stderr).toBe(1);
        expect(JSON.parse(rep.stdout).results[0].verdict.signals.map((s: { code: string }) => s.code)).toContain("result_error");
      } finally {
        f.cleanup();
      }
    },
    120_000,
  );

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
