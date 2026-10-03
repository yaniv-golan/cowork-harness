import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import {
  claudeCliComplete,
  claudeCliCompleteStructured,
  defaultManagedMcpPath,
  helpDeclaresFlag,
  isolationRefusal,
  resetIsolationPreflight as resetPreflight,
  transportIdentity,
} from "../src/decide/llm-transport.js";
import { makeSemanticJudge } from "../src/decide/semantic-judge.js";
import { PAIRWISE_JSON_SCHEMA } from "../src/decide/pairwise-judge.js";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Drive the transport through a FAKE `claude` bin (via COWORK_HARNESS_CLAUDE_BIN) so the retry loop is
// exercised without a real model call. The fake's behavior is steered by env vars it reads at runtime; it
// records its invocation count to a counter file so a test can assert exactly how many times it was spawned.
let dir: string;
let binPath: string;
let counterPath: string;

const FAKE = `#!/bin/sh
# The isolation preflight probes --help / --version: answer without counting a model call.
if [ "$1" = "--version" ]; then echo "9.9.9 (Claude Code)"; exit 0; fi
if [ "$1" = "--help" ]; then
  if [ "$FAKE_HELP_MODE" = "crash" ]; then exit 3; fi
  if [ -n "$FAKE_HELP_COUNTER" ]; then h=$(cat "$FAKE_HELP_COUNTER" 2>/dev/null || echo 0); echo $((h + 1)) > "$FAKE_HELP_COUNTER"; fi
  echo "Usage: claude [options]"
  if [ "$FAKE_HELP_MODE" = "unknown" ]; then
    # Some other help layout: every flag is named, but none as a two-space option line.
    printf '\\t--safe-mode\\n\\t--strict-mcp-config\\n\\t--no-session-persistence\\n\\t--setting-sources\\n\\t--tools\\n'
    exit 0
  fi
  if [ "$FAKE_HELP_MODE" = "described-only" ]; then
    # The flags appear only inside another option's wrapped description (as --tools and --strict-mcp-config do in
    # the real 2.1.286 help) — the old unanchored match counted these.
    echo "  --mcp-config <configs...>             Load MCP servers; --safe-mode ignores user ones, add"
    echo "                                        --strict-mcp-config to skip them, --no-session-persistence"
    echo "                                        --setting-sources and --tools still apply"
    exit 0
  fi
  if [ "$FAKE_HELP_MODE" != "old" ]; then
    echo "  --safe-mode                           Start with all customizations disabled"
    echo "  --strict-mcp-config                   Only use MCP servers from --mcp-config"
    echo "  --no-session-persistence              Disable session persistence"
    echo "  --effort <level>                      Effort level for the current session"
  fi
  echo "  --setting-sources <sources>           Comma-separated list of setting sources"
  echo "  --tools <tools...>                    Specify the list of available tools"
  exit 0
fi
n=$(cat "$FAKE_COUNTER" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "$FAKE_COUNTER"
# Dump argv and stdin so a test can assert WHERE the prompt travels (stdin, never argv — a ps-readable
# argv leaks the prompt for the life of the child). Consume stdin unconditionally (even when no dump file
# is requested) so the parent's write+end never blocks on an unread pipe.
if [ -n "$FAKE_ARGV_FILE" ]; then printf '%s\\n' "$@" > "$FAKE_ARGV_FILE"; fi
if [ -n "$FAKE_ENV_FILE" ]; then env > "$FAKE_ENV_FILE"; fi
if [ -n "$FAKE_STDIN_FILE" ]; then cat > "$FAKE_STDIN_FILE"; else cat > /dev/null; fi
case "$FAKE_MODE" in
  always-fail)
    echo '{"type":"result","is_error":true,"result":"fake operational error (on stdout, like claude -p)","modelUsage":{}}'
    exit 1 ;;
  succeed-after-1)
    if [ "$n" -le 1 ]; then echo '{"type":"result","is_error":true,"result":"transient blip","modelUsage":{}}'; exit 1; fi
    echo '{"type":"result","is_error":false,"result":"OK-ANSWER","modelUsage":{"claude-sonnet-5":{}}}'; exit 0 ;;
  timeout)
    sleep 30
    echo '{"type":"result","is_error":false,"result":"late","modelUsage":{"claude-sonnet-5":{}}}'; exit 0 ;;
  spew)
    yes 0123456789 | head -c 1000000 2>/dev/null
    exit 0 ;;
  malformed)
    echo 'not valid json'
    exit 0 ;;
  zero-models)
    echo '{"type":"result","is_error":false,"result":"OK-ANSWER","modelUsage":{}}'
    exit 0 ;;
  aux-model)
    # The REAL agent 2.1.275 shape for --model sonnet: an auxiliary haiku call beside the requested turn.
    echo '{"type":"result","is_error":false,"result":"OK-ANSWER","modelUsage":{"claude-haiku-4-5-20251001":{"inputTokens":897,"outputTokens":8},"claude-sonnet-5":{"inputTokens":2,"outputTokens":4}}}'
    exit 0 ;;
  aux-ambiguous)
    echo '{"type":"result","is_error":false,"result":"OK-ANSWER","modelUsage":{"claude-sonnet-5":{},"claude-sonnet-5[1m]":{}}}'
    exit 0 ;;
  enterprise-mcp)
    # A managed config the harness did not find: the real CLI refuses --strict-mcp-config, and runs without it.
    case " $* " in *" --strict-mcp-config "*)
      echo "Error: You cannot use --strict-mcp-config when an enterprise MCP config is present" >&2
      exit 1 ;;
    esac
    echo '{"type":"result","is_error":false,"result":"OK-ANSWER","modelUsage":{"claude-sonnet-5":{}}}'; exit 0 ;;
  aux-none)
    echo '{"type":"result","is_error":false,"result":"OK-ANSWER","modelUsage":{"claude-haiku-4-5-20251001":{},"claude-opus-5":{}}}'
    exit 0 ;;
  *)
    echo '{"type":"result","is_error":false,"result":"OK-ANSWER","modelUsage":{"claude-sonnet-5":{}}}'; exit 0 ;;
esac
`;

function invocations(): number {
  return existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8").trim()) || 0 : 0;
}

/** Forget the cached probes; the enterprise-MCP check looks at a path that never exists, so the argv the suite
 *  expects does not depend on whether this machine has a real managed MCP config. */
function resetIsolationPreflight(managedMcpPath = join(dir, "no-managed-mcp.json")): void {
  resetPreflight(managedMcpPath);
}

let prevForbid: string | undefined;
beforeAll(() => {
  // Opt out of the unit lane's spawn guard (test/setup/forbid-spawn.ts) for THIS file only: every spawn
  // here is the fake bin below, never a real `claude`. Opting the file out, rather than exempting "any
  // explicit COWORK_HARNESS_CLAUDE_BIN" in the guard, keeps the guard on for an env var pointed at a real
  // binary.
  prevForbid = process.env.COWORK_HARNESS_FORBID_SPAWN;
  process.env.COWORK_HARNESS_FORBID_SPAWN = "0";
  dir = mkdtempSync(join(tmpdir(), "cowork-llm-transport-"));
  binPath = join(dir, "fake-claude.sh");
  counterPath = join(dir, "counter");
  writeFileSync(binPath, FAKE, { mode: 0o755 });
  process.env.COWORK_HARNESS_CLAUDE_BIN = binPath;
  resetIsolationPreflight();
});

afterEach(() => {
  if (existsSync(counterPath)) rmSync(counterPath);
  delete process.env.FAKE_MODE;
  delete process.env.FAKE_COUNTER;
  delete process.env.FAKE_ARGV_FILE;
  delete process.env.FAKE_STDIN_FILE;
  delete process.env.FAKE_ENV_FILE;
  vi.unstubAllEnvs();
  delete process.env.COWORK_HARNESS_LLM_RETRIES;
  delete process.env.COWORK_HARNESS_LLM_TIMEOUT_MS;
  delete process.env.COWORK_HARNESS_LLM_MAX_BYTES;
  // The ENOENT test clobbers the bin path; restore it so later tests still spawn the fake.
  process.env.COWORK_HARNESS_CLAUDE_BIN = binPath;
});

afterAll(() => {
  if (prevForbid === undefined) delete process.env.COWORK_HARNESS_FORBID_SPAWN;
  else process.env.COWORK_HARNESS_FORBID_SPAWN = prevForbid;
  delete process.env.COWORK_HARNESS_CLAUDE_BIN;
  resetPreflight();
  rmSync(dir, { recursive: true, force: true });
});

describe("claudeCliComplete — retry transport", () => {
  it("retries a non-zero exit and resolves once the spawn succeeds", async () => {
    process.env.FAKE_MODE = "succeed-after-1";
    process.env.FAKE_COUNTER = counterPath;
    const out = await claudeCliComplete("q", "m");
    expect(out.text.trim()).toBe("OK-ANSWER");
    expect(out.model).toBe("claude-sonnet-5");
    expect(invocations()).toBe(2); // 1 transient failure + 1 success
  });

  it("propagates the resolved model from --output-format json's modelUsage (not the requested alias)", async () => {
    process.env.FAKE_COUNTER = counterPath;
    const out = await claudeCliComplete("q", "sonnet");
    expect(out.model).toBe("claude-sonnet-5");
  });

  it("a malformed JSON envelope on a clean exit fails loud (never silently swallowed)", async () => {
    process.env.FAKE_MODE = "malformed";
    process.env.FAKE_COUNTER = counterPath;
    await expect(claudeCliComplete("q", "m")).rejects.toThrow(/unparseable envelope/);
  });

  it("a clean exit with zero resolved models fails loud (never records an unknown/empty model)", async () => {
    process.env.FAKE_MODE = "zero-models";
    process.env.FAKE_COUNTER = counterPath;
    await expect(claudeCliComplete("q", "m")).rejects.toThrow(/modelUsage is empty/);
  });

  // Agent 2.1.275 (Desktop 2.2553.1) added an AUXILIARY haiku call in `-p` mode, so `modelUsage` carries
  // two keys where 2.1.260 carried one — bracketed live against both native binaries with the same prompt
  // and flags. The old "exactly 1 key" contract turned every critique evaluator pass and every
  // --decider-llm gate into an instrument failure on the new agent. The primary model is now the key that
  // RESOLVES the requested model; ambiguity still fails closed.
  describe("agent 2.1.275: an auxiliary model beside the requested one", () => {
    it("resolves a floating alias to the concrete id that carries it, and keeps the whole usage map", async () => {
      process.env.FAKE_MODE = "aux-model";
      process.env.FAKE_COUNTER = counterPath;
      const r = await claudeCliComplete("q", "sonnet");
      expect(r.text).toBe("OK-ANSWER");
      expect(r.model).toBe("claude-sonnet-5"); // never the haiku side-call, never the alias
      // The auxiliary call is real spend — it must not vanish from cost accounting.
      expect(Object.keys(r.usage ?? {}).sort()).toEqual(["claude-haiku-4-5-20251001", "claude-sonnet-5"]);
    });

    it("resolves an exact concrete id the same way", async () => {
      process.env.FAKE_MODE = "aux-model";
      process.env.FAKE_COUNTER = counterPath;
      expect((await claudeCliComplete("q", "claude-sonnet-5")).model).toBe("claude-sonnet-5");
    });

    it("two keys that BOTH resolve the request is still a contract break (fails closed)", async () => {
      process.env.FAKE_MODE = "aux-ambiguous";
      process.env.FAKE_COUNTER = counterPath;
      await expect(claudeCliComplete("q", "sonnet")).rejects.toThrow(/2 of them resolve the requested model "sonnet"/);
    });

    it("two keys and NEITHER resolves the request is a contract break (the requested model is not what ran)", async () => {
      process.env.FAKE_MODE = "aux-none";
      process.env.FAKE_COUNTER = counterPath;
      await expect(claudeCliComplete("q", "sonnet")).rejects.toThrow(/0 of them resolve the requested model "sonnet"/);
    });

    it("alias matching is by dash-segment, not substring", async () => {
      process.env.FAKE_MODE = "aux-none"; // keys: claude-haiku-4-5-20251001, claude-opus-5
      process.env.FAKE_COUNTER = counterPath;
      // "opus" is a segment of claude-opus-5 → resolves; "op" is a substring only → must NOT.
      expect((await claudeCliComplete("q", "opus")).model).toBe("claude-opus-5");
      await expect(claudeCliComplete("q", "op")).rejects.toThrow(/0 of them resolve/);
    });
  });

  it("exhausts the bounded retries then fails loud, with the child's STDOUT folded into the message", async () => {
    process.env.FAKE_MODE = "always-fail";
    process.env.FAKE_COUNTER = counterPath;
    process.env.COWORK_HARNESS_LLM_RETRIES = "2";
    await expect(claudeCliComplete("q", "m")).rejects.toThrow(/exited 1.*stdout: fake operational error/s);
    expect(invocations()).toBe(3); // 1 initial + 2 retries
  });

  it("COWORK_HARNESS_LLM_RETRIES=0 disables retry (single attempt)", async () => {
    process.env.FAKE_MODE = "always-fail";
    process.env.FAKE_COUNTER = counterPath;
    process.env.COWORK_HARNESS_LLM_RETRIES = "0";
    await expect(claudeCliComplete("q", "m")).rejects.toThrow(/exited 1/);
    expect(invocations()).toBe(1);
  });

  it("an unparseable retry count falls back to the default (does NOT silently disable)", async () => {
    process.env.FAKE_MODE = "always-fail";
    process.env.FAKE_COUNTER = counterPath;
    process.env.COWORK_HARNESS_LLM_RETRIES = "not-a-number";
    await expect(claudeCliComplete("q", "m")).rejects.toThrow(/exited 1/);
    expect(invocations()).toBe(3); // default 2 retries, not 0
  });

  it("does NOT retry a timeout (a hung child that ate the budget is not a quick transient)", async () => {
    process.env.FAKE_MODE = "timeout";
    process.env.FAKE_COUNTER = counterPath;
    process.env.COWORK_HARNESS_LLM_RETRIES = "2";
    // The fake sleeps 30s; the timeout trips at 1s (wide margin so a slow/loaded CI box still records the
    // counter write — the fake's first action — before SIGKILL). The kill ends the test in ~1s, not 30s.
    process.env.COWORK_HARNESS_LLM_TIMEOUT_MS = "1000";
    await expect(claudeCliComplete("q", "m")).rejects.toThrow(/timed out/);
    expect(invocations()).toBe(1); // spawned once, NOT retried
  });

  it("a timeout error names COWORK_HARNESS_LLM_TIMEOUT_MS as the mitigation", async () => {
    process.env.FAKE_MODE = "timeout";
    process.env.FAKE_COUNTER = counterPath;
    process.env.COWORK_HARNESS_LLM_TIMEOUT_MS = "1000";
    await expect(claudeCliComplete("q", "m")).rejects.toThrow(/COWORK_HARNESS_LLM_TIMEOUT_MS/);
  });

  it("a maxBytes overflow names COWORK_HARNESS_LLM_MAX_BYTES as the mitigation", async () => {
    process.env.FAKE_MODE = "spew";
    process.env.FAKE_COUNTER = counterPath;
    process.env.COWORK_HARNESS_LLM_MAX_BYTES = "1000";
    await expect(claudeCliComplete("q", "m")).rejects.toThrow(/COWORK_HARNESS_LLM_MAX_BYTES/);
  });

  it("a spawn ENOENT names the PATH / COWORK_HARNESS_CLAUDE_BIN mitigation", async () => {
    process.env.COWORK_HARNESS_CLAUDE_BIN = join(dir, "does-not-exist");
    await expect(claudeCliComplete("q", "m")).rejects.toThrow(/PATH|COWORK_HARNESS_CLAUDE_BIN/);
  });

  it("delivers the prompt on STDIN, never on argv (argv is world-readable via `ps`)", async () => {
    process.env.FAKE_COUNTER = counterPath;
    const argvFile = join(dir, "argv.out");
    const stdinFile = join(dir, "stdin.out");
    process.env.FAKE_ARGV_FILE = argvFile;
    process.env.FAKE_STDIN_FILE = stdinFile;
    const secret = "SECRET-PROMPT-CONTENTS-9f3a";
    await claudeCliComplete(secret, "m");
    const argv = readFileSync(argvFile, "utf8");
    const stdin = readFileSync(stdinFile, "utf8");
    expect(stdin).toContain(secret);
    expect(argv).not.toContain(secret);
  });

  it("every call runs the host claude isolated: no tools, safe mode, no MCP, no saved session, user settings only", async () => {
    process.env.FAKE_COUNTER = counterPath;
    const argvFile = join(dir, "argv-iso.out");
    process.env.FAKE_ARGV_FILE = argvFile;
    await claudeCliComplete("q", "m");
    // One argv element per line; the trailing newline of the last (empty) `--tools` value leaves one more "".
    const argv = readFileSync(argvFile, "utf8").split("\n").slice(0, -1);
    // The whole argv, in order: every isolation flag arrives as its OWN element (nothing swallowed by the
    // empty --tools value), and the variadic --tools comes last.
    expect(argv).toEqual([
      "-p",
      "--model",
      "m",
      "--effort",
      "high",
      "--output-format",
      "json",
      "--safe-mode",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--setting-sources",
      "user",
      "--tools",
      "",
    ]);
  });

  it("the call does not inherit an exported effort/thinking setting, and keeps the rest of the environment", async () => {
    // The host CLI reads CLAUDE_CODE_EFFORT_LEVEL ahead of --effort; CLAUDE_CODE_DISABLE_THINKING turns thinking off and
    // CLAUDE_CODE_ALWAYS_ENABLE_EFFORT sends an effort where none would go. None of them may reach a grader.
    process.env.FAKE_COUNTER = counterPath;
    const envFile = join(dir, "env-effort.out");
    process.env.FAKE_ENV_FILE = envFile;
    vi.stubEnv("CLAUDE_CODE_EFFORT_LEVEL", "low");
    vi.stubEnv("CLAUDE_CODE_DISABLE_THINKING", "1");
    vi.stubEnv("CLAUDE_CODE_ALWAYS_ENABLE_EFFORT", "1");
    vi.stubEnv("COWORK_TEST_KEEP_ME", "kept");
    await claudeCliComplete("q", "m");
    const keys = new Map(
      readFileSync(envFile, "utf8")
        .split("\n")
        .filter((l) => l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)] as const),
    );
    expect(keys.get("COWORK_TEST_KEEP_ME")).toBe("kept"); // the environment did reach the child: the absences are real
    expect(keys.has("CLAUDE_CODE_EFFORT_LEVEL")).toBe(false);
    expect(keys.has("CLAUDE_CODE_DISABLE_THINKING")).toBe(false);
    expect(keys.has("CLAUDE_CODE_ALWAYS_ENABLE_EFFORT")).toBe(false);
  });

  it("the structured (pairwise judge) call pins the same effort and scrubs the same keys", async () => {
    process.env.FAKE_COUNTER = counterPath;
    const argvFile = join(dir, "argv-structured.out");
    const envFile = join(dir, "env-structured.out");
    process.env.FAKE_ARGV_FILE = argvFile;
    process.env.FAKE_ENV_FILE = envFile;
    vi.stubEnv("CLAUDE_CODE_EFFORT_LEVEL", "low");
    await claudeCliCompleteStructured({ system: "s", user: "u", schema: PAIRWISE_JSON_SCHEMA, model: "m" }).catch(() => undefined);
    const argv = readFileSync(argvFile, "utf8").split("\n");
    expect(argv[argv.indexOf("--effort") + 1]).toBe("high");
    expect(readFileSync(envFile, "utf8")).not.toMatch(/^CLAUDE_CODE_EFFORT_LEVEL=/m);
  });

  it("an older host claude without the isolation flags is refused with an actionable message, before any model call", async () => {
    resetIsolationPreflight();
    process.env.FAKE_COUNTER = counterPath;
    process.env.FAKE_HELP_MODE = "old";
    try {
      await expect(claudeCliComplete("q", "m")).rejects.toThrow(/--safe-mode[\s\S]*--strict-mcp-config[\s\S]*upgrade/);
      expect(invocations()).toBe(0); // no model call was spawned
    } finally {
      delete process.env.FAKE_HELP_MODE;
      resetIsolationPreflight();
    }
  });

  it("the --help probe runs once per binary, not once per call", async () => {
    resetIsolationPreflight();
    const helpCounter = join(dir, "help-counter");
    process.env.FAKE_HELP_COUNTER = helpCounter;
    process.env.FAKE_COUNTER = counterPath;
    try {
      await claudeCliComplete("q", "m");
      await claudeCliComplete("q", "m");
      expect(Number(readFileSync(helpCounter, "utf8").trim())).toBe(1);
    } finally {
      delete process.env.FAKE_HELP_COUNTER;
    }
  });

  for (const mode of ["unknown", "described-only"]) {
    it(`an unrecognised --help layout (${mode}) fails CLOSED: refused, no model call`, async () => {
      resetIsolationPreflight();
      process.env.FAKE_COUNTER = counterPath;
      process.env.FAKE_HELP_MODE = mode;
      try {
        await expect(claudeCliComplete("q", "m")).rejects.toThrow(
          /does not accept --safe-mode, --strict-mcp-config, --no-session-persistence, --setting-sources, --tools/,
        );
        expect(invocations()).toBe(0);
      } finally {
        delete process.env.FAKE_HELP_MODE;
        resetIsolationPreflight();
      }
    });
  }

  it("a probe that could not run is not remembered: the binary appearing later is accepted", async () => {
    resetIsolationPreflight();
    const later = join(dir, "later-claude.sh");
    process.env.COWORK_HARNESS_CLAUDE_BIN = later;
    process.env.FAKE_COUNTER = counterPath;
    await expect(claudeCliComplete("q", "m")).rejects.toThrow(/failed to spawn/);
    writeFileSync(later, FAKE, { mode: 0o755 });
    await expect(claudeCliComplete("q", "m")).resolves.toMatchObject({ text: "OK-ANSWER" });
  });

  it("with an enterprise managed-mcp.json, the call leaves out only --strict-mcp-config and still runs", async () => {
    const managed = join(dir, "managed-mcp.json");
    writeFileSync(managed, "{}");
    resetIsolationPreflight(managed);
    process.env.FAKE_COUNTER = counterPath;
    const argvFile = join(dir, "argv-managed.out");
    process.env.FAKE_ARGV_FILE = argvFile;
    try {
      expect(isolationRefusal()).toBeUndefined();
      await expect(claudeCliComplete("q", "m")).resolves.toMatchObject({ text: "OK-ANSWER" });
      const argv = readFileSync(argvFile, "utf8").split("\n").slice(0, -1);
      expect(argv).toEqual([
        "-p",
        "--model",
        "m",
        "--effort",
        "high",
        "--output-format",
        "json",
        "--safe-mode",
        "--no-session-persistence",
        "--setting-sources",
        "user",
        "--tools",
        "",
      ]);
    } finally {
      rmSync(managed);
      resetIsolationPreflight();
    }
  });

  it("the CLI's own enterprise-MCP refusal (a managed config elsewhere) is retried once without --strict-mcp-config, then remembered", async () => {
    process.env.FAKE_MODE = "enterprise-mcp";
    process.env.FAKE_COUNTER = counterPath;
    process.env.COWORK_HARNESS_LLM_RETRIES = "0"; // the retry is not one of the transient-exit retries
    const argvFile = join(dir, "argv-relocated.out");
    process.env.FAKE_ARGV_FILE = argvFile;
    resetIsolationPreflight();
    try {
      await expect(claudeCliComplete("q", "m")).resolves.toMatchObject({ text: "OK-ANSWER" });
      expect(invocations()).toBe(2);
      const argv = readFileSync(argvFile, "utf8").split("\n");
      expect(argv).not.toContain("--strict-mcp-config");
      expect(argv).toContain("--safe-mode");
      await expect(claudeCliComplete("q", "m")).resolves.toMatchObject({ text: "OK-ANSWER" });
      expect(invocations()).toBe(3); // straight through, no refused attempt first
    } finally {
      resetIsolationPreflight();
    }
  });

  it("a --help that crashes with no output is refused, and not remembered as an old CLI", async () => {
    resetIsolationPreflight();
    process.env.FAKE_COUNTER = counterPath;
    process.env.FAKE_HELP_MODE = "crash";
    try {
      await expect(claudeCliComplete("q", "m")).rejects.toThrow(/printed nothing for `--help` \(exit 3\)/);
      expect(invocations()).toBe(0);
    } finally {
      delete process.env.FAKE_HELP_MODE;
    }
    await expect(claudeCliComplete("q", "m")).resolves.toMatchObject({ text: "OK-ANSWER" });
  });

  it("a malformed COWORK_HARNESS_LLM_TIMEOUT_MS is rejected loud, not silently reverted", async () => {
    process.env.FAKE_COUNTER = counterPath;
    process.env.COWORK_HARNESS_LLM_TIMEOUT_MS = "5m";
    const warnings: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      warnings.push(String(chunk));
      return true;
    });
    try {
      await claudeCliComplete("q", "m");
    } finally {
      spy.mockRestore();
    }
    expect(warnings.join("")).toMatch(/COWORK_HARNESS_LLM_TIMEOUT_MS.*not a positive number/s);
  });

  it("a malformed COWORK_HARNESS_LLM_MAX_BYTES (explicit 0) is rejected loud, not silently reverted", async () => {
    process.env.FAKE_COUNTER = counterPath;
    process.env.COWORK_HARNESS_LLM_MAX_BYTES = "0";
    const warnings: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      warnings.push(String(chunk));
      return true;
    });
    try {
      await claudeCliComplete("q", "m");
    } finally {
      spy.mockRestore();
    }
    expect(warnings.join("")).toMatch(/COWORK_HARNESS_LLM_MAX_BYTES.*not a positive number/s);
  });
});

describe("isolationRefusal — the pre-spend form of the preflight", () => {
  it("returns the actionable message for an older CLI, undefined for a current one, and never throws", () => {
    resetIsolationPreflight();
    process.env.FAKE_HELP_MODE = "old";
    try {
      expect(isolationRefusal()).toMatch(/does not accept --safe-mode.*2\.1\.197 or later/s);
    } finally {
      delete process.env.FAKE_HELP_MODE;
      resetIsolationPreflight();
    }
    expect(isolationRefusal()).toBeUndefined();
  });
});

describe("transport identity", () => {
  it("records the isolation level and the host CLI version, probed once", async () => {
    resetIsolationPreflight();
    expect(transportIdentity()).toEqual({ isolation: "1", cliVersion: "9.9.9", effort: "high" });
  });
  it("records strictMcp: false when the call leaves out --strict-mcp-config for an enterprise MCP config", () => {
    const managed = join(dir, "managed-mcp-identity.json");
    writeFileSync(managed, "{}");
    resetIsolationPreflight(managed);
    try {
      expect(transportIdentity()).toEqual({ isolation: "1", cliVersion: "9.9.9", effort: "high", strictMcp: false });
    } finally {
      rmSync(managed);
      resetIsolationPreflight();
    }
  });
  it("launches nothing under the spawn guard: the version is then unrecorded", () => {
    resetIsolationPreflight();
    const prev = process.env.COWORK_HARNESS_FORBID_SPAWN;
    process.env.COWORK_HARNESS_FORBID_SPAWN = "1";
    try {
      expect(transportIdentity()).toEqual({ isolation: "1", effort: "high" });
    } finally {
      process.env.COWORK_HARNESS_FORBID_SPAWN = prev;
      resetIsolationPreflight();
    }
  });
  it("the real-transport judge records it on every call; an injected one does not", async () => {
    resetIsolationPreflight();
    process.env.FAKE_COUNTER = counterPath;
    const real = makeSemanticJudge({ model: "m" });
    await real(["c"], "doc").catch(() => undefined); // the fake's reply is not a grade; the identity is set before parsing
    expect(real.transport).toEqual({ isolation: "1", cliVersion: "9.9.9", effort: "high" });
    const stub = makeSemanticJudge({ model: "m", complete: async () => ({ text: '{"results":[{"index":0,"pass":true}]}', model: "m" }) });
    await stub(["c"], "doc");
    expect(stub.transport).toBeUndefined();
  });
});

describe("helpDeclaresFlag / defaultManagedMcpPath", () => {
  it("matches an option line only: two-space indent, the flag, then a separator", () => {
    expect(helpDeclaresFlag("  --tools <tools...>   Specify", "--tools")).toBe(true);
    expect(helpDeclaresFlag("  --safe-mode", "--safe-mode")).toBe(true);
    expect(helpDeclaresFlag("                    --tools names them", "--tools")).toBe(false);
    expect(helpDeclaresFlag("  --tools-extra <x>", "--tools")).toBe(false);
    expect(helpDeclaresFlag("\t--tools", "--tools")).toBe(false);
    // The flag is matched literally, never as a pattern: "." does not stand for any character.
    expect(helpDeclaresFlag("  --a.b <x>", "--a.b")).toBe(true);
    expect(helpDeclaresFlag("  --aXb <x>", "--a.b")).toBe(false);
    expect(helpDeclaresFlag("  --tools\r", "--tools")).toBe(true);
  });
  it("names Claude Code's managed-settings directory per platform", () => {
    expect(defaultManagedMcpPath("darwin")).toBe("/Library/Application Support/ClaudeCode/managed-mcp.json");
    expect(defaultManagedMcpPath("linux")).toBe("/etc/claude-code/managed-mcp.json");
    expect(defaultManagedMcpPath("win32")).toBe("C:\\Program Files\\ClaudeCode\\managed-mcp.json");
  });
});
