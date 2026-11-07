import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The spawn guard must cover every place the harness launches a model, not just executeScenario:
// `chat --raw`'s docker run of the agent, and the `--decider-llm` transport's `claude -p`. `spawn` is
// MOCKED here, so a missing guard shows up as a recorded spawn call — nothing is ever launched.
const spawned: string[] = [];
vi.mock("node:child_process", async (orig) => {
  const real = await orig<typeof import("node:child_process")>();
  return {
    ...real,
    spawn: (cmd: string, args: string[]) => {
      spawned.push([cmd, ...(args ?? [])].join(" "));
      throw new Error("MOCK spawn reached — the guard did not stop it");
    },
  };
});

beforeEach(() => {
  spawned.length = 0;
  process.env.COWORK_HARNESS_FORBID_SPAWN = "1";
  // A stand-in credential (never sent), so chat's protocol credential pre-flight does not answer before the guard.
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "stub-not-a-real-token");
});

describe("the spawn guard covers every model launch", () => {
  it("the --decider-llm transport refuses under the flag, before spawning", async () => {
    const { claudeCliComplete } = await import("../src/decide/llm-transport.js");
    const dir = mkdtempSync(join(tmpdir(), "cwh-fs-"));
    const bin = join(dir, "claude");
    writeFileSync(bin, "#!/bin/sh\necho '{}'\n");
    chmodSync(bin, 0o755);
    process.env.COWORK_HARNESS_CLAUDE_BIN = bin;
    try {
      await expect(claudeCliComplete("q", "m")).rejects.toThrow(/COWORK_HARNESS_FORBID_SPAWN/);
    } finally {
      delete process.env.COWORK_HARNESS_CLAUDE_BIN;
    }
    expect(spawned).toEqual([]);
  });

  it("chat --raw refuses under the flag, before the docker run", async () => {
    const { cmdChat } = await import("../src/run/chat.js");
    const dir = mkdtempSync(join(tmpdir(), "cwh-fs-chat-"));
    await expect(cmdChat([dir, "--raw", "--model", "claude-sonnet-5"])).rejects.toThrow(/COWORK_HARNESS_FORBID_SPAWN/);
    expect(spawned).toEqual([]);
  });

  it("interactive chat refuses under the flag, before the egress sidecar or the agent spawn", async () => {
    const { cmdChat } = await import("../src/run/chat.js");
    for (const tier of ["protocol", "hostloop"]) {
      const dir = mkdtempSync(join(tmpdir(), "cwh-fs-chat-"));
      await expect(cmdChat([dir, "--fidelity", tier, "--model", "claude-sonnet-5"])).rejects.toThrow(/COWORK_HARNESS_FORBID_SPAWN/);
    }
    expect(spawned).toEqual([]);
  });
});
