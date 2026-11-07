// The protocol agent's argv, as the real CLI spawns it: the stub records its arguments, and these cases read them.
// This is an ARGV test. It shows the session's flags reach the protocol agent; that a resumed agent actually
// remembers its first turn is the release gate's live check (test/live-protocol-resume.test.ts).
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLI, POSIX, exited, makeStubFixture, spawnCli, type StubFixture } from "./helpers/stub-agent.js";

const can = POSIX && existsSync(CLI);
const out = (o: unknown) => `printf '%s\\n' '${JSON.stringify(o)}'`;
const STUB = [
  // One file per invocation, the argv NUL-separated (the prompt append holds newlines).
  `d="$(dirname "$0")"; n=$(ls "$d" | grep -c '^argv\\.'); printf '%s\\0' "$@" > "$d/argv.$n"`,
  out({ type: "system", subtype: "init", session_id: "stub", model: "claude-sonnet-5", tools: [], cwd: "/tmp" }),
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "ok",
    session_id: "stub",
    num_turns: 1,
    total_cost_usd: 0.01,
    usage: { input_tokens: 1, output_tokens: 1 },
  }),
  "cat >/dev/null",
].join("\n");

const argvs = (f: StubFixture): string[][] => {
  const bin = join(f.root, "bin");
  return (
    readdirSync(bin)
      .filter((n) => /^argv\.\d+$/.test(n))
      .sort((x, y) => Number(x.slice(5)) - Number(y.slice(5)))
      .map((n) => readFileSync(join(bin, n), "utf8").split("\0").slice(0, -1))
      // the stub may be probed with `--help` / `--version`; keep the agent runs
      .filter((a) => a[0] === "-p")
  );
};
const after = (argv: string[], flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);

async function cli(f: StubFixture, args: string[]) {
  const c = spawnCli(f, args);
  const { code } = await exited(c, 60_000);
  return { code, stdout: c.stdoutText(), stderr: c.stderrText() };
}

describe.runIf(can)("protocol argv carries the session's flags (stub agent)", () => {
  it("agent_max_turns and the thinking default reach the protocol agent", async () => {
    const f = makeStubFixture(STUB);
    try {
      const session = join(f.cwd, "t.session.yaml");
      writeFileSync(session, "model: claude-sonnet-5\npermission_parity: cowork\nagent_max_turns: 3\n");
      writeFileSync(f.scenario, `baseline: latest\nfidelity: protocol\nsession: ${session}\nprompt: say hi\n`);
      const r = await cli(f, ["run", f.scenario]);
      expect(r.code, r.stderr).toBe(0);
      const [argv] = argvs(f);
      expect(after(argv, "--max-turns")).toBe("3");
      expect(after(argv, "--max-thinking-tokens")).toBe("31999");
      expect(argv).not.toContain("--session-id");
    } finally {
      f.cleanup();
    }
  }, 90_000);

  it("skill --session-id then --resume: the first spawn pins the id, the second resumes the same one", async () => {
    const f = makeStubFixture(STUB);
    try {
      const dir = join(f.cwd, "demo");
      mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
      writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "demo" }));
      mkdirSync(join(dir, "skills", "demo"), { recursive: true });
      writeFileSync(join(dir, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: d\n---\nbody\n");
      const base = ["skill", dir, "--fidelity", "protocol", "--session-id", "argv-pair"];
      const one = await cli(f, [...base.slice(0, 2), "say hi", ...base.slice(2)]);
      expect(one.code, one.stderr).toBe(0);
      const two = await cli(f, [...base.slice(0, 2), "and again", ...base.slice(2), "--resume"]);
      expect(two.code, two.stderr).toBe(0);
      const [a, b] = argvs(f);
      const pinned = after(a, "--session-id");
      expect(pinned).toMatch(/^[0-9a-f-]{36}$/);
      expect(a).not.toContain("--resume");
      expect(after(b, "--resume")).toBe(pinned);
      expect(b).not.toContain("--session-id");
    } finally {
      f.cleanup();
    }
  }, 120_000);
});
