import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { spawnChannel } from "../src/decide/external-channel.js";
import { DeciderTimeoutError, UnansweredError } from "../src/errors.js";

// `--decider-cmd` runs under `shell: true`, so the pid we hold is the SHELL's, not the helper's. Killing
// only that pid leaves whatever the shell started running as an orphan: on Linux, where /bin/sh is dash,
// even a lone `sleep 30` outlives a SIGKILL of its shell. The helper here backgrounds its long-lived
// process on purpose, so the grandchild is separate from the shell on EVERY /bin/sh (dash and bash alike).
// That makes the test fail on the bug on any platform, not only on the Linux CI runners.

const POSIX = process.platform !== "win32";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

/** A helper whose real work runs in a grandchild; it records that grandchild's pid, then waits on it. */
function helperWithGrandchild(dir: string, tail = "wait"): { cmd: string; pidFile: string } {
  const pidFile = join(dir, "grandchild.pid");
  return { cmd: `sleep 30 & echo $! > '${pidFile}'; ${tail}`, pidFile };
}

async function grandchildPid(pidFile: string): Promise<number> {
  expect(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== ""), "helper never wrote its pid").toBe(true);
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  expect(alive(pid), "the grandchild must be running before the kill, or the test proves nothing").toBe(true);
  return pid;
}

describe.runIf(POSIX)("--decider-cmd: killing the helper kills everything it started", () => {
  it("a readLine timeout leaves no orphan behind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "decider-pgroup-"));
    const { cmd, pidFile } = helperWithGrandchild(dir);
    const prev = process.env.COWORK_HARNESS_DECIDER_CMD_TIMEOUT_MS;
    process.env.COWORK_HARNESS_DECIDER_CMD_TIMEOUT_MS = "300";
    const ch = spawnChannel(cmd);
    let pid = 0;
    try {
      pid = await grandchildPid(pidFile);
      const err = await ch.readLine().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(String(err)).toMatch(/timed out before answering/);
      // Typed, so the run loop salvages it as an unanswered gate (and labels it a decider timeout)
      // instead of letting a plain Error unwind to the top-level catch.
      expect(err).toBeInstanceOf(DeciderTimeoutError);
      expect(err).toBeInstanceOf(UnansweredError);
      expect(await waitFor(() => !alive(pid)), `grandchild ${pid} survived the timeout kill`).toBe(true);
    } finally {
      ch.close?.();
      if (prev === undefined) delete process.env.COWORK_HARNESS_DECIDER_CMD_TIMEOUT_MS;
      else process.env.COWORK_HARNESS_DECIDER_CMD_TIMEOUT_MS = prev;
      if (pid && alive(pid)) process.kill(pid, "SIGKILL"); // don't leak the orphan when the assertion fails
    }
  });

  it("close() on a helper that is still working leaves no orphan behind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "decider-pgroup-"));
    // `cat` keeps the shell itself alive and reading, as a real answering helper would be.
    const { cmd, pidFile } = helperWithGrandchild(dir, "cat");
    const ch = spawnChannel(cmd);
    let pid = 0;
    try {
      pid = await grandchildPid(pidFile);
      ch.close?.();
      expect(await waitFor(() => !alive(pid)), `grandchild ${pid} survived close()`).toBe(true);
    } finally {
      if (pid && alive(pid)) process.kill(pid, "SIGKILL");
    }
  });

  it("a harness that exits without close() still takes the helper's group down", async () => {
    // The exit path can't be exercised in-process, so a child node process runs the REAL source (via tsx),
    // opens a channel, and exits without closing it.
    const dir = mkdtempSync(join(tmpdir(), "decider-pgroup-"));
    const { cmd, pidFile } = helperWithGrandchild(dir);
    const script = join(dir, "harness.mts");
    writeFileSync(
      script,
      `import { spawnChannel } from ${JSON.stringify(resolve("src/decide/external-channel.ts"))};
       import { existsSync } from "node:fs";
       spawnChannel(${JSON.stringify(cmd)});
       const t0 = Date.now();
       while (!existsSync(${JSON.stringify(pidFile)}) && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 20));
       process.exit(0);`,
    );
    const r = spawnSync(process.execPath, ["--import", "tsx", script], { encoding: "utf8", timeout: 20_000 });
    expect(r.status, r.stderr).toBe(0);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    try {
      expect(await waitFor(() => !alive(pid)), `grandchild ${pid} outlived the harness process`).toBe(true);
    } finally {
      if (alive(pid)) process.kill(pid, "SIGKILL");
    }
  });
});
