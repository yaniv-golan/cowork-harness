// `--timeout <ms>` on `run`, `record` and `skill` is the agent phase's budget, passed as an execute option: the
// scenario is never rewritten, and the result (and a recording's cassette) says which budget applied and where it
// came from (`timeout: {ms, source}`). Driven through the real CLI with a stub agent (protocol tier, no spend).
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLI, POSIX, QUESTION_FRAME, exited, makeStubFixture, runDir, spawnCli, type StubFixture } from "./helpers/stub-agent.js";

const can = POSIX && existsSync(CLI);
const out = (o: unknown) => `printf '%s\\n' '${JSON.stringify(o)}'`;
const frames = (pre = "") =>
  [
    pre,
    out({ type: "system", subtype: "init", session_id: "stub", model: "claude-sonnet-5", tools: [], cwd: "/tmp" }),
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hi" }] }, session_id: "stub" }),
    out({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "hi",
      session_id: "stub",
      num_turns: 1,
      total_cost_usd: 0.01,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    "cat >/dev/null",
  ]
    .filter(Boolean)
    .join("\n");
const QUICK = frames();
// Never answers within the budget: the run's own timer ends it.
const SLOW = frames("sleep 30");

function setUp(f: StubFixture, extra = ""): void {
  const session = join(f.cwd, "t.session.yaml");
  writeFileSync(session, "model: claude-sonnet-5\npermission_parity: cowork\n");
  writeFileSync(f.scenario, `baseline: latest\nfidelity: protocol\nsession: ${session}\nprompt: say hi\n${extra}`);
}

async function cli(f: StubFixture, args: string[]) {
  const c = spawnCli(f, args);
  const { code } = await exited(c, 90_000);
  return { code, stdout: c.stdoutText(), stderr: c.stderrText() };
}

async function withStub<T>(stub: string, fn: (f: StubFixture) => Promise<T>): Promise<T> {
  const f = makeStubFixture(stub);
  try {
    return await fn(f);
  } finally {
    f.cleanup();
  }
}

describe.runIf(can)("--timeout is the run's budget, recorded with its source", () => {
  it("run: both spellings record {ms, source: flag}; the scenario's own timeout_ms is overridden, not rewritten", async () => {
    await withStub(QUICK, async (f) => {
      setUp(f, "timeout_ms: 900000\n");
      for (const args of [["--timeout", "600000"], ["--timeout=600000"]]) {
        const r = await cli(f, ["run", f.scenario, ...args, "--output-format", "json"]);
        expect(r.code, r.stderr).toBe(0);
        expect(JSON.parse(r.stdout).results[0].timeout).toEqual({ ms: 600_000, source: "flag" });
        expect(r.stderr).toContain("[budget] timeout 600000 ms (flag)");
      }
      expect(readFileSync(f.scenario, "utf8")).toContain("timeout_ms: 900000");
    });
  }, 120_000);

  it("run: no flag ⇒ the scenario's timeout_ms, source scenario; neither ⇒ no timeout field", async () => {
    await withStub(QUICK, async (f) => {
      setUp(f, "timeout_ms: 900000\n");
      const own = await cli(f, ["run", f.scenario, "--output-format", "json"]);
      expect(JSON.parse(own.stdout).results[0].timeout).toEqual({ ms: 900_000, source: "scenario" });
      setUp(f);
      const none = await cli(f, ["run", f.scenario, "--output-format", "json"]);
      expect(JSON.parse(none.stdout).results[0].timeout).toBeUndefined();
    });
  }, 120_000);

  it("run and record: a bad value is a usage error (exit 2), before anything runs", async () => {
    await withStub(QUICK, async (f) => {
      setUp(f);
      for (const cmd of ["run", "record"]) {
        for (const bad of [["--timeout", "0"], ["--timeout=abc"], ["--timeout"]]) {
          const r = await cli(f, [cmd, f.scenario, ...bad]);
          expect(r.code, `${cmd} ${bad.join(" ")}: ${r.stderr}`).toBe(2);
          expect(r.stderr).toMatch(/--timeout/);
        }
      }
    });
  }, 120_000);

  it("the budget ends the run: result error, errorSource timeout, at the flag's value", async () => {
    await withStub(SLOW, async (f) => {
      setUp(f, "timeout_ms: 900000\n");
      const r = await cli(f, ["run", f.scenario, "--timeout", "2000", "--output-format", "json"]);
      expect(r.code).toBe(1);
      const res = JSON.parse(r.stdout).results[0];
      expect(res).toMatchObject({ result: "error", errorSource: "timeout", timeout: { ms: 2000, source: "flag" } });
    });
  }, 120_000);

  it("record: the frozen scenario is the authored one, the cassette carries the budget, and replay reports it", async () => {
    await withStub(QUICK, async (f) => {
      setUp(f, "timeout_ms: 900000\n");
      const plain = join(f.cwd, "plain.cassette.json");
      const flagged = join(f.cwd, "flagged.cassette.json");
      expect((await cli(f, ["record", f.scenario, "--out", plain])).code).toBe(0);
      const rec = await cli(f, ["record", f.scenario, "--out", flagged, "--timeout", "600000"]);
      expect(rec.code, rec.stderr).toBe(0);
      const a = JSON.parse(readFileSync(plain, "utf8"));
      const b = JSON.parse(readFileSync(flagged, "utf8"));
      expect(JSON.stringify(b.scenario)).toBe(JSON.stringify(a.scenario));
      expect(b.scenario.timeout_ms).toBe(900_000);
      expect(a.timeout).toEqual({ ms: 900_000, source: "scenario" });
      expect(b.timeout).toEqual({ ms: 600_000, source: "flag" });
      const rep = await cli(f, ["replay", flagged, "--output-format", "json"]);
      expect(rep.code, rep.stderr).toBe(0);
      expect(JSON.parse(rep.stdout).results[0].timeout).toEqual({ ms: 600_000, source: "flag" });
    });
  }, 180_000);

  it("record: a run the budget killed is refused without --allow-failing, and freezes with it", async () => {
    await withStub(SLOW, async (f) => {
      setUp(f);
      const cass = join(f.cwd, "slow.cassette.json");
      const refused = await cli(f, ["record", f.scenario, "--out", cass, "--timeout", "2000"]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toMatch(/refusing to freeze a failing run/);
      expect(existsSync(cass)).toBe(false);
      const kept = await cli(f, ["record", f.scenario, "--out", cass, "--timeout", "2000", "--allow-failing"]);
      expect(kept.code, kept.stderr).toBe(0);
      expect(JSON.parse(readFileSync(cass, "utf8")).timeout).toEqual({ ms: 2000, source: "flag" });
    });
  }, 180_000);

  it("two legs: the flag is each leg's budget", async () => {
    await withStub(QUICK, async (f) => {
      const session = join(f.cwd, "t.session.yaml");
      writeFileSync(session, "model: claude-sonnet-5\npermission_parity: cowork\n");
      const p = join(f.cwd, "legs.yaml");
      writeFileSync(
        p,
        [
          "name: two",
          "baseline: latest",
          `session: ${session}`,
          "fidelity: protocol",
          "workdir: persistent",
          "legs:",
          "  - id: one",
          "    prompt: say hi",
          "    timeout_ms: 900000",
          "  - id: two",
          "    prompt: say hi again",
        ].join("\n") + "\n",
      );
      const r = await cli(f, ["run", p, "--timeout", "600000", "--output-format", "json"]);
      expect(r.code, r.stderr + r.stdout).toBe(0);
      const env = JSON.parse(r.stdout);
      expect(env.results.map((x: { timeout?: unknown }) => x.timeout)).toEqual([
        { ms: 600_000, source: "flag" },
        { ms: 600_000, source: "flag" },
      ]);
      const without = JSON.parse((await cli(f, ["run", p, "--output-format", "json"])).stdout);
      expect(without.results.map((x: { timeout?: unknown }) => x.timeout)).toEqual([{ ms: 900_000, source: "scenario" }, undefined]);
    });
  }, 180_000);

  it("an unanswered-gate partial result keeps the budget and the session's turn cap", async () => {
    await withStub(`printf '%s\\n' '${QUESTION_FRAME}'\nexec sleep 300`, async (f) => {
      const session = join(f.cwd, "t.session.yaml");
      writeFileSync(session, "model: claude-sonnet-5\npermission_parity: cowork\nagent_max_turns: 3\n");
      writeFileSync(f.scenario, `baseline: latest\nfidelity: protocol\nsession: ${session}\nprompt: say hi\n`);
      const r = await cli(f, ["run", f.scenario, "--timeout", "600000", "--output-format", "json"]);
      expect(r.code, r.stderr).toBe(2);
      const d = runDir(f)!;
      const res = JSON.parse(readFileSync(join(d, "turns", "1", "result.json"), "utf8"));
      expect(res.partial).toBe(true);
      expect(res.turnCap).toEqual({ maxTurns: 3, source: "session" });
      expect(res.timeout).toEqual({ ms: 600_000, source: "flag" });
    });
  }, 120_000);

  it("skill: --timeout is the run's budget, source flag", async () => {
    await withStub(QUICK, async (f) => {
      const dir = join(f.cwd, "demo");
      mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
      writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "demo" }));
      mkdirSync(join(dir, "skills", "demo"), { recursive: true });
      writeFileSync(join(dir, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: d\n---\nbody\n");
      const r = await cli(f, ["skill", dir, "say hi", "--fidelity", "protocol", "--timeout", "600000", "--output-format", "json"]);
      expect(r.code, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout).results[0].timeout).toEqual({ ms: 600_000, source: "flag" });
    });
  }, 120_000);

  it("record --dry-run states the budget the recording would have", async () => {
    await withStub(QUICK, async (f) => {
      setUp(f, "timeout_ms: 900000\n");
      const own = await cli(f, ["record", f.scenario, "--dry-run", "--output-format", "json"]);
      expect(own.code, own.stderr).toBe(0);
      expect(JSON.parse(own.stdout).timeout).toEqual({ ms: 900_000, source: "scenario" });
      const flagged = await cli(f, ["record", f.scenario, "--dry-run", "--timeout", "5000"]);
      expect(flagged.code, flagged.stderr).toBe(0);
      expect(flagged.stderr + flagged.stdout).toContain("timeout:  5000 ms (flag)");
    });
  }, 120_000);

  it("skill --dry-run states the budget the same way, never as a scenario timeout_ms", async () => {
    await withStub(QUICK, async (f) => {
      const r = await cli(f, ["skill", f.cwd, "hi", "--dry-run", "--timeout", "5000", "--output-format", "json"]);
      expect(r.code, r.stderr).toBe(0);
      const p = JSON.parse(r.stdout);
      expect(p.timeout).toEqual({ ms: 5000, source: "flag" });
      expect(p).not.toHaveProperty("timeout_ms");
    });
  }, 120_000);
});
