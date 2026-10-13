import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Closing the terminal: the harness runs on a real pty, the pty's master is closed, and the kernel sends SIGHUP
// to the harness. Every write to the hung-up terminal then fails (EIO). The stop sequence must still complete —
// SIGTERM, grace, SIGKILL of the agent (which ignores SIGTERM), exit 129 — instead of dying on the first
// warning line. Driven by python3's pty.fork (no extra dependency); skipped, loudly, where python3 is absent.

const TERMINATION = JSON.stringify(resolve("src/termination.ts"));
const PY = spawnSync("python3", ["-c", "import pty"], { stdio: "ignore" }).status === 0;
const POSIX = process.platform !== "win32";
if (POSIX && !PY) console.warn("::warning:: termination-hangup.test.ts SKIPPED: python3 with the pty module is not available");

const DRIVER = `
import os, pty, sys, time
script, log = sys.argv[1], sys.argv[2]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[3], [sys.argv[3], "--import", "tsx", script, log])
for _ in range(300):
    time.sleep(0.05)
    try:
        if "ready" in open(log).read(): break
    except FileNotFoundError: pass
os.close(fd)
_, st = os.waitpid(pid, 0)
print("exited" if os.WIFEXITED(st) else "signaled", os.WEXITSTATUS(st) if os.WIFEXITED(st) else os.WTERMSIG(st))
`;

function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  // Reparented to an init that has not reaped it yet: a zombie is dead.
  const st = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  return st === "" || st.startsWith("Z");
}

function hangUp(body: string): { outcome: string; log: string[]; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "hangup-"));
  const script = join(dir, "harness.mts");
  writeFileSync(script, body.replaceAll("$DIR", JSON.stringify(dir)));
  writeFileSync(join(dir, "driver.py"), DRIVER);
  const log = join(dir, "log");
  const r = spawnSync("python3", [join(dir, "driver.py"), script, log, process.execPath], { encoding: "utf8", timeout: 30_000 });
  let lines: string[] = [];
  try {
    lines = readFileSync(log, "utf8").trim().split("\n");
  } catch {
    /* nothing logged */
  }
  return { outcome: r.stdout.trim(), log: lines, dir };
}

function childOf(log: string[]): number {
  return Number(log.find((l) => l.startsWith("child "))?.split(" ")[1]);
}

function killIfAlive(pid: number): void {
  try {
    if (pid > 0) process.kill(pid, "SIGKILL");
  } catch {
    /* gone */
  }
}

async function waitGone(pid: number, ms = 3000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (gone(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return gone(pid);
}

describe.runIf(POSIX && PY)("a closed terminal (SIGHUP on a real pty)", () => {
  it("still runs the whole stop sequence — SIGTERM, grace, SIGKILL — and exits 129, though every write to the terminal fails", async () => {
    const r = hangUp(`
      import { installTerminationHandler, registerAgent, childProcessAgent } from ${TERMINATION};
      import { spawn } from "node:child_process";
      import { appendFileSync, existsSync } from "node:fs";
      import { join } from "node:path";
      const L = (s) => appendFileSync(process.argv[2], s + "\\n");
      // Diagnostics, filtered out of the sequence below: when this fails, the log says how the child ended and when.
      const t0 = Date.now();
      const D = (s) => L("diag " + s + " t=" + (Date.now() - t0));
      process.on("SIGHUP", () => D("sighup"));
      installTerminationHandler();
      // The child must be IGNORING SIGTERM before the hangup, or a SIGTERM that lands first kills it and the stop
      // sequence rightly skips the SIGKILL. It writes a marker once its trap is set, and "ready" waits for it. The
      // sleep before the trap holds that window open on every run, so a test that stopped waiting fails every time
      // rather than only under load.
      const trapped = join($DIR, "trapped"); // a mkdtemp path: no spaces, so the shell needs no quoting
      const child = spawn("sh", ["-c", "sleep 0.3; trap '' TERM; : > $1; while :; do sleep 1; done", "sh", trapped], { stdio: "ignore", detached: true });
      L("child " + child.pid);
      child.on("exit", (code, signal) => D("child-exit code=" + code + " signal=" + signal));
      for (const until = Date.now() + 10_000; !existsSync(trapped); ) {
        if (Date.now() > until) throw new Error("the child never set its SIGTERM trap");
        await new Promise((r) => setTimeout(r, 20));
      }
      const orig = child.kill.bind(child);
      child.kill = (s) => { D("kill-call " + s + " alive=" + (child.exitCode === null && child.signalCode === null)); L("kill " + s); return orig(s); };
      registerAgent(() => childProcessAgent(child));
      process.on("exit", (c) => { D("exit-hook"); L("exit " + c); });
      L("ready");
      setInterval(() => {}, 1000);
    `);
    const pid = childOf(r.log);
    const diag = r.log.filter((l) => l.startsWith("diag ")).join("; ");
    if (process.env.CWH_HANGUP_DIAG) process.stderr.write(`[hangup-diag] ${r.outcome} | ${diag}\n`);
    const died = await waitGone(pid);
    killIfAlive(pid);
    expect(
      r.log.filter((l) => !l.startsWith("child ") && !l.startsWith("diag ") && l !== "ready"),
      `${r.outcome} | ${diag}`,
    ).toEqual(["kill SIGTERM", "kill SIGKILL", "exit 129"]);
    expect(r.outcome).toBe("exited 129");
    expect(died).toBe(true);
  }, 30_000);

  it("a chat-style exit hold still finishes its result write, then exits 129", () => {
    const r = hangUp(`
      import { installTerminationHandler, holdExit } from ${TERMINATION};
      import { appendFileSync } from "node:fs";
      const L = (s) => appendFileSync(process.argv[2], s + "\\n");
      installTerminationHandler();
      const release = holdExit();
      process.on("SIGHUP", () => setTimeout(() => { L("result written"); release(); }, 300));
      process.on("exit", (c) => L("exit " + c));
      L("ready");
      setInterval(() => {}, 1000);
    `);
    expect(
      r.log.filter((l) => l !== "ready"),
      r.outcome,
    ).toEqual(["result written", "exit 129"]);
    expect(r.outcome).toBe("exited 129");
  }, 30_000);
});
