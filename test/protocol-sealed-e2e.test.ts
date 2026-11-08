// The protocol tier end to end through `run`, over a stub agent (no model call): every credential kind reaches a
// sealed agent (the run's own config dir as CLAUDE_CONFIG_DIR, no `--settings` pointing anywhere else), a run with no
// credential is refused before any spawn, and the two removed environment variables refuse at startup. Synthetic data
// only.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { CLI, POSIX, exited, makeStubFixture, spawnCli, type StubFixture } from "./helpers/stub-agent.js";

const can = POSIX && existsSync(CLI);
const out = (o: unknown) => `printf '%s\\n' '${JSON.stringify(o)}'`;
const STUB = [
  `printf '%s\\n' "$@" > "$STUB_ARGV"`,
  out({ type: "system", subtype: "init", session_id: "stub", model: "claude-sonnet-5", tools: [], cwd: "/tmp" }),
  out({ type: "result", subtype: "success", is_error: false, result: "hi", session_id: "stub", num_turns: 1, total_cost_usd: 0 }),
  "cat >/dev/null",
].join("\n");

function fixture(): StubFixture & { argv: string } {
  const f = makeStubFixture(STUB);
  const argv = join(f.root, "stub.argv");
  f.env.STUB_ARGV = argv;
  return Object.assign(f, { argv });
}

/** The env the stub received, as name → value. */
function dumped(f: StubFixture): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(f.envDump, "utf8").split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return env;
}

/** Every `claude-config` dir under the runs dir (one per run). */
function runConfigDirs(dir: string): string[] {
  const found: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (!statSync(p).isDirectory()) continue;
    if (e === "claude-config") found.push(realpathSync(p));
    else found.push(...runConfigDirs(p));
  }
  return found;
}

const CREDENTIALS = [
  ["CLAUDE_CODE_OAUTH_TOKEN", { CLAUDE_CODE_OAUTH_TOKEN: "stub-oauth-not-real" }],
  ["ANTHROPIC_API_KEY", { CLAUDE_CODE_OAUTH_TOKEN: "", ANTHROPIC_API_KEY: "stub-key-not-real" }],
  ["ANTHROPIC_AUTH_TOKEN", { CLAUDE_CODE_OAUTH_TOKEN: "", ANTHROPIC_AUTH_TOKEN: "stub-bearer-not-real" }],
] as const;

describe.skipIf(!can)("protocol: sealed for every credential kind, refused without one", () => {
  it.each(CREDENTIALS)("%s: the agent's CLAUDE_CONFIG_DIR is the run's own config dir, and argv has no --settings", async (key, env) => {
    const f = fixture();
    try {
      const child = spawnCli(f, ["run", f.scenario], env);
      const { code } = await exited(child, 60_000);
      expect(code, child.stderrText()).toBe(0);
      const got = dumped(f);
      const dirs = runConfigDirs(f.runsDir);
      expect(dirs).toHaveLength(1);
      expect(realpathSync(got.CLAUDE_CONFIG_DIR!)).toBe(dirs[0]);
      expect(readFileSync(f.argv, "utf8").split("\n")).not.toContain("--settings");
      // The credential reaches the agent under its own name only: ANTHROPIC_AUTH_TOKEN is never copied into the OAuth
      // variable (read from the dump directly: credentialLeaks would flag the bearer itself).
      expect(got[key]).toBe(env[key as keyof typeof env]);
      if (key === "ANTHROPIC_AUTH_TOKEN") expect(got.CLAUDE_CODE_OAUTH_TOKEN ?? "").toBe("");
    } finally {
      f.cleanup();
    }
  });

  it("no credential: exit 2 with the refusal, and the agent never starts", async () => {
    const f = fixture();
    try {
      const child = spawnCli(f, ["run", f.scenario], { CLAUDE_CODE_OAUTH_TOKEN: "" });
      const { code } = await exited(child, 60_000);
      expect(code).toBe(2);
      expect(child.stderrText()).toContain("fidelity protocol needs a credential in the environment (env / .env)");
      expect(child.stderrText()).toContain("a Keychain or /login session is not used");
      expect(existsSync(f.envDump)).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  it.each(["COWORK_MANAGED_CONFIG", "COWORK_HARNESS_ALLOW_CONFIG_DIR_WRITE"])(
    "%s set: refused at startup (exit 2), naming its removal; empty counts as unset",
    async (name) => {
      const f = fixture();
      try {
        const refused = spawnCli(f, ["run", f.scenario], { [name]: "1" });
        expect((await exited(refused, 60_000)).code).toBe(2);
        expect(refused.stderrText()).toContain(`${name} was removed in 5.0.0 — `);
        expect(existsSync(f.envDump)).toBe(false);
        const empty = spawnCli(f, ["run", f.scenario], { [name]: "" });
        expect((await exited(empty, 60_000)).code, empty.stderrText()).toBe(0);
      } finally {
        f.cleanup();
      }
    },
  );

  it.each(["COWORK_LOCKDOWN", "COWORK_SKIP_CAPABILITY_PROBE"])(
    "%s set: refused at startup (exit 2), naming its COWORK_HARNESS_ replacement; empty counts as unset",
    async (name) => {
      const f = fixture();
      try {
        const refused = spawnCli(f, ["run", f.scenario], { [name]: "1" });
        expect((await exited(refused, 60_000)).code).toBe(2);
        expect(refused.stderrText()).toContain(`${name} was renamed in 5.0.0 to ${name.replace("COWORK_", "COWORK_HARNESS_")}. `);
        expect(existsSync(f.envDump)).toBe(false);
        const empty = spawnCli(f, ["run", f.scenario], { [name]: "" });
        expect((await exited(empty, 60_000)).code, empty.stderrText()).toBe(0);
      } finally {
        f.cleanup();
      }
    },
  );
});
