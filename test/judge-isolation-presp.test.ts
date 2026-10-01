import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { executeScenario, parseScenarioFile } from "../src/run/execute.js";
import { resetIsolationPreflight } from "../src/decide/llm-transport.js";
import { makeSemanticJudge } from "../src/decide/semantic-judge.js";
import { POSIX, makeStubFixture, type StubFixture } from "./helpers/stub-agent.js";

// A run that will call the host `claude` after the agent (the judge, the LLM decider) refuses an older CLI before the
// agent spends anything. The agent is a stub that records it started; the judge's CLI is a fake whose --help lacks
// the isolation flags.
let f: StubFixture;
let dir: string;
const saved: Record<string, string | undefined> = {};
const setEnv = (k: string, v: string): void => {
  if (!(k in saved)) saved[k] = process.env[k];
  process.env[k] = v;
};
beforeEach(() => {
  const line = (o: unknown) => `printf '%s\\n' '${JSON.stringify(o)}'`;
  f = makeStubFixture(
    [
      `echo started > "$STUB_PID"`,
      line({ type: "system", subtype: "init", session_id: "stub", model: "claude-sonnet-5", tools: [], cwd: "/tmp" }),
      line({
        type: "assistant",
        message: { id: "m1", role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "done" }] },
        session_id: "stub",
      }),
      line({ type: "result", subtype: "success", is_error: false, result: "done", session_id: "stub", num_turns: 1 }),
      "cat >/dev/null",
    ].join("\n"),
  );
  dir = mkdtempSync(join(tmpdir(), "iso-presp-"));
  const oldCli = join(dir, "old-claude");
  writeFileSync(
    oldCli,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.100 (Claude Code)"; exit 0; fi\necho "Usage: claude [options]"\necho "  --tools <tools...>"\nexit 0\n`,
  );
  chmodSync(oldCli, 0o755);
  setEnv("COWORK_HARNESS_FORBID_SPAWN", "0");
  setEnv("PATH", f.env.PATH!);
  setEnv("HOME", f.env.HOME!);
  setEnv("CLAUDE_CONFIG_DIR", f.env.CLAUDE_CONFIG_DIR!);
  setEnv("COWORK_HARNESS_RUNS_DIR", f.runsDir);
  setEnv("COWORK_HARNESS_MODEL", "claude-sonnet-5");
  setEnv("STUB_PID", f.stubPidFile);
  setEnv("STUB_ENV_DUMP", f.envDump);
  setEnv("COWORK_MANAGED_CONFIG", "1");
  setEnv("CLAUDE_CODE_OAUTH_TOKEN", "stub-not-a-real-token");
  setEnv("COWORK_HARNESS_CLAUDE_BIN", oldCli);
  // The enterprise-MCP check looks at a path that never exists: these tests are about the CLI version.
  resetIsolationPreflight(join(dir, "no-managed-mcp.json"));
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete saved[k];
  }
  resetIsolationPreflight();
  rmSync(dir, { recursive: true, force: true });
  f.cleanup();
});

function scenario(extra: string[]): ReturnType<typeof parseScenarioFile> {
  const file = join(dir, "iso.yaml");
  writeFileSync(file, ["baseline: latest", "session: (inline)", "fidelity: protocol", "prompt: hi", ...extra, ""].join("\n"));
  return parseScenarioFile(file);
}

describe.runIf(POSIX)("an older host claude is refused before the agent spends anything", () => {
  it("with a semantic_matches assert", async () => {
    await expect(executeScenario(scenario(["assert:", "  - semantic_matches:", "      rubric: ['x']"]))).rejects.toThrow(
      /2\.1\.197 or later/,
    );
    expect(existsSync(f.stubPidFile)).toBe(false);
  });
  it("with the LLM decider armed", async () => {
    await expect(executeScenario(scenario(["on_unanswered: llm", "assert:", "  - result: success"]))).rejects.toThrow(/2\.1\.197 or later/);
    expect(existsSync(f.stubPidFile)).toBe(false);
  });
  it("not for on_unanswered: llm behind an external channel, which replaces the LLM decider", async () => {
    const channel = { write: () => undefined, readLine: async () => null };
    await executeScenario(scenario(["on_unanswered: llm", "assert:", "  - result: success"]), { externalChannel: channel }).catch(
      () => undefined,
    );
    expect(existsSync(f.stubPidFile)).toBe(true);
  });
  it("not when nothing calls the host claude: no judge at all", async () => {
    await executeScenario(scenario(["assert:", "  - result: success"])).catch(() => undefined);
    expect(existsSync(f.stubPidFile)).toBe(true);
  });
  it("not when nothing calls the host claude: an injected judge", async () => {
    const judge = makeSemanticJudge({
      model: "m",
      complete: async () => ({ text: '{"results":[{"index":0,"pass":true}]}', model: "m" }),
    });
    await executeScenario(scenario(["assert:", "  - semantic_matches:", "      rubric: ['x']"]), { semanticJudge: judge }).catch(
      () => undefined,
    );
    expect(existsSync(f.stubPidFile)).toBe(true);
  });
});

describe("critique refuses an older host claude before its task turn", () => {
  it("exit 2 with the actionable message, and no run dir is created", () => {
    const d = mkdtempSync(join(tmpdir(), "iso-crit-"));
    try {
      const old = join(d, "old-claude");
      writeFileSync(
        old,
        `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.100 (Claude Code)"; exit 0; fi\necho "  --tools <tools...>"\nexit 0\n`,
      );
      chmodSync(old, 0o755);
      const r = spawnSync("node", [resolve("dist/cli.js"), "critique", resolve("examples/skills/csv-fx-normalize"), "--prompt", "hi"], {
        encoding: "utf8",
        env: {
          ...process.env,
          COWORK_HARNESS_FORBID_SPAWN: "0",
          COWORK_HARNESS_CLAUDE_BIN: old,
          COWORK_HARNESS_MODEL: "claude-sonnet-5",
          COWORK_HARNESS_RUNS_DIR: join(d, "runs"),
        },
      });
      expect(r.status).toBe(2);
      expect(r.stdout + r.stderr).toMatch(/2\.1\.100[\s\S]*does not accept --safe-mode[\s\S]*2\.1\.197 or later/);
      expect(existsSync(join(d, "runs"))).toBe(false);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

/** A CLI that predates the isolation flags, for the command-level refusals below. */
function oldCliIn(d: string): string {
  const old = join(d, "old-claude");
  writeFileSync(
    old,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.100 (Claude Code)"; exit 0; fi\necho "  --tools <tools...>"\nexit 0\n`,
  );
  chmodSync(old, 0o755);
  return old;
}

describe("decide --decider-llm refuses an older host claude (exit 2) before any model call", () => {
  for (const [name, argv] of [["decide --decider-llm", ["decide", "--decider-llm"]]] as const) {
    it(name, () => {
      const d = mkdtempSync(join(tmpdir(), "iso-cmd-"));
      try {
        const r = spawnSync("node", [resolve("dist/cli.js"), ...argv], {
          encoding: "utf8",
          cwd: d,
          env: { ...process.env, COWORK_HARNESS_FORBID_SPAWN: "0", COWORK_HARNESS_CLAUDE_BIN: oldCliIn(d) },
        });
        expect(r.status).toBe(2);
        expect(r.stdout + r.stderr).toMatch(/2\.1\.100[\s\S]*does not accept --safe-mode[\s\S]*2\.1\.197 or later/);
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    });
  }
});

// The test above passes through either layer: decide's explicit pre-check, or the backstop inside the shared spawn
// path (its error reaches decide's catch, which also exits 2). The category tells them apart — the pre-check is a
// `usage` refusal, the backstop a `runtime` decider error — so this pins the pre-check on its own.
describe("decide --decider-llm refuses at its own pre-check, not via the spawn-path backstop", () => {
  it("the JSON envelope is a usage refusal", () => {
    const d = mkdtempSync(join(tmpdir(), "iso-decide-"));
    try {
      const r = spawnSync("node", [resolve("dist/cli.js"), "decide", "--decider-llm", "--output-format", "json"], {
        encoding: "utf8",
        cwd: d,
        env: { ...process.env, COWORK_HARNESS_FORBID_SPAWN: "0", COWORK_HARNESS_CLAUDE_BIN: oldCliIn(d) },
      });
      expect(r.status).toBe(2);
      const env = JSON.parse(r.stdout.trim().split("\n").pop()!) as { error: { category: string; message: string } };
      expect(env.error.category).toBe("usage");
      expect(env.error.message).toMatch(/does not accept --safe-mode/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
