// A real `eval` interrupted while it snapshots the arms — before its manifest exists — must not leave the
// snapshots behind. The preparation is synchronous, so without a signal handler Node dies by the signal
// mid-copy and the `catch` that discards an unstarted eval never runs.
//
// Drives the BUILT CLI. The pause is a `git` shim on PATH: the dir-arm snapshot asks git about each source
// after the eval dir's `arms/` exists, and the shim blocks that first call until the test releases it, so the
// signal provably lands mid-snapshot. Only the harness pid is signalled (a terminal Ctrl-C would also hit the
// shim). No agent runs: the stub `claude` is never reached.
import { describe, it, expect } from "vitest";
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { CLI, POSIX, exited, makeStubFixture, spawnCli, waitFor } from "./helpers/stub-agent.js";

const can = POSIX && existsSync(CLI);

function writePlugin(dir: string, body: string): void {
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "demo" }));
  mkdirSync(join(dir, "skills", "demo"), { recursive: true });
  writeFileSync(join(dir, "skills", "demo", "SKILL.md"), `---\nname: demo\ndescription: d\n---\n${body}\n`);
}

describe.runIf(can)("eval: a signal before the manifest leaves no eval dir", () => {
  it("SIGINT mid-snapshot: exit 130, the eval dir and its arm snapshots are gone", async () => {
    const f = makeStubFixture("exec sleep 300");
    const out = join(f.root, "eval");
    const mark = join(f.root, "git-paused");
    const release = join(f.root, "git-release");
    try {
      // The real git, resolved before the shim exists on the same PATH.
      const realGit = execFileSync("sh", ["-c", "command -v git"], { env: { PATH: f.env.PATH }, encoding: "utf8" }).trim();
      expect(realGit).not.toBe("");
      writeFileSync(
        join(f.root, "bin", "git"),
        [
          "#!/bin/sh",
          `if [ -d "${out}/arms" ] && [ ! -e "${mark}" ]; then`,
          `  : > "${mark}"`,
          `  while [ ! -e "${release}" ]; do sleep 0.05; done`,
          "fi",
          `exec "${realGit}" "$@"`,
        ].join("\n") + "\n",
      );
      chmodSync(join(f.root, "bin", "git"), 0o755);
      writePlugin(join(f.cwd, "declared", "demo"), "declared");
      writePlugin(join(f.cwd, "a", "demo"), "version A");
      writePlugin(join(f.cwd, "b", "demo"), "version B");
      writeFileSync(join(f.cwd, "session.yaml"), "model: claude-sonnet-5\nplugins:\n  local_plugins:\n    - ./declared/demo\n");
      writeFileSync(
        join(f.cwd, "q.yaml"),
        "baseline: latest\nsession: ./session.yaml\nfidelity: protocol\nprompt: what is the answer?\nassert:\n  - result: success\n",
      );
      // eval refuses before its first run unless doctor's token check passes; the value is never sent anywhere.
      f.env.CLAUDE_CODE_OAUTH_TOKEN = "stub-not-a-real-token";

      const cli = spawnCli(f, ["eval", "q.yaml", "--arm", "a=./a/demo", "--arm", "b=./b/demo", "--reps", "4", "--out", out]);
      const paused = (await waitFor(() => existsSync(mark) || cli.exitCode !== null, 60_000)) && existsSync(mark);
      expect(paused, `the snapshot never reached the git shim. stderr:\n${cli.stderrText()}`).toBe(true);
      // Mid-snapshot, before the manifest: the arms dir exists, the manifest does not.
      expect(existsSync(join(out, "arms"))).toBe(true);
      expect(existsSync(join(out, "manifest.json"))).toBe(false);

      process.kill(cli.pid!, "SIGINT");
      // Let the signal reach the CLI while it is still blocked in the shim, then let the snapshot go on.
      await new Promise((r) => setTimeout(r, 300));
      writeFileSync(release, "");
      const r = await exited(cli, 60_000);

      expect(r, cli.stderrText()).toEqual({ code: 130, signal: null });
      expect(existsSync(out), `left behind: ${existsSync(out) ? readdirSync(out).join(", ") : ""}`).toBe(false);
      expect(existsSync(f.stubPidFile)).toBe(false); // no agent was started
    } finally {
      writeFileSync(release, "");
      f.cleanup();
    }
  }, 120_000);
});
