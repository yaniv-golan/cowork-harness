import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// The signal handler can only be exercised in a process that is allowed to die, so each case runs a small
// script against the REAL source (via tsx) in a child node process, the same way the --decider-cmd
// process-group test exercises its exit hook.

const POSIX = process.platform !== "win32";
const TERMINATION = JSON.stringify(resolve("src/termination.ts"));
const SIDECAR = JSON.stringify(resolve("src/egress/sidecar.ts"));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function runScript(body: string): { status: number | null; signal: NodeJS.Signals | null; stderr: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "termination-"));
  const script = join(dir, "harness.mts");
  writeFileSync(script, body.replaceAll("$DIR", JSON.stringify(dir)));
  const r = spawnSync(process.execPath, ["--import", "tsx", script], { encoding: "utf8", timeout: 20_000 });
  return { status: r.status, signal: r.signal as NodeJS.Signals | null, stderr: r.stderr, dir };
}

describe.runIf(POSIX)("termination handler", () => {
  it("SIGINT: helpers step, agent terminated, egress step, exit hooks run, exit 130", () => {
    const r = runScript(`
      import { installTerminationHandler, registerAgent, registerTerminationStep, childProcessAgent } from ${TERMINATION};
      import { spawn } from "node:child_process";
      import { appendFileSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const log = (s) => appendFileSync(join($DIR, "order"), s + "\\n");
      installTerminationHandler();
      const child = spawn("sleep", ["300"], { stdio: "ignore" });
      writeFileSync(join($DIR, "child.pid"), String(child.pid));
      child.on("exit", () => log("agent-exit"));
      registerAgent(() => childProcessAgent(child));
      registerTerminationStep("egress", () => log("egress"));
      registerTerminationStep("helpers", () => log("helpers"));
      process.on("exit", () => log("exit-hook"));
      setTimeout(() => process.kill(process.pid, "SIGINT"), 50);
      setTimeout(() => {}, 30_000);
    `);
    expect(r.status, r.stderr).toBe(130);
    expect(readFileSync(join(r.dir, "order"), "utf8").trim().split("\n")).toEqual(["helpers", "agent-exit", "egress", "exit-hook"]);
    const pid = Number(readFileSync(join(r.dir, "child.pid"), "utf8"));
    expect(alive(pid)).toBe(false);
  });

  it("SIGTERM exits 143", () => {
    const r = runScript(`
      import { installTerminationHandler } from ${TERMINATION};
      installTerminationHandler();
      setTimeout(() => process.kill(process.pid, "SIGTERM"), 50);
      setTimeout(() => {}, 30_000);
    `);
    expect(r.status, r.stderr).toBe(143);
  });

  it("with nothing to wait for, the exit is immediate (no grace delay)", () => {
    const r = runScript(`
      import { installTerminationHandler, registerTerminationStep } from ${TERMINATION};
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      installTerminationHandler();
      registerTerminationStep("egress", () => {});
      let sentAt = 0;
      process.on("exit", () => writeFileSync(join($DIR, "ms"), String(Date.now() - sentAt)));
      setTimeout(() => { sentAt = Date.now(); process.kill(process.pid, "SIGINT"); }, 50);
      setTimeout(() => {}, 30_000);
    `);
    expect(r.status, r.stderr).toBe(130);
    expect(Number(readFileSync(join(r.dir, "ms"), "utf8"))).toBeLessThan(200);
  });

  it("an agent that ignores SIGTERM is force-killed at the end of the grace period", () => {
    const r = runScript(`
      import { installTerminationHandler, registerAgent, childProcessAgent, TERMINATION_GRACE_MS } from ${TERMINATION};
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      installTerminationHandler();
      const child = spawn("sh", ["-c", "trap '' TERM; while :; do sleep 1; done"], { stdio: "ignore" });
      writeFileSync(join($DIR, "child.pid"), String(child.pid));
      registerAgent(() => childProcessAgent(child));
      let sentAt = 0;
      process.on("exit", () => writeFileSync(join($DIR, "ms"), String(Date.now() - sentAt) + " " + TERMINATION_GRACE_MS));
      setTimeout(() => { sentAt = Date.now(); process.kill(process.pid, "SIGINT"); }, 300);
      setTimeout(() => {}, 30_000);
    `);
    expect(r.status, r.stderr).toBe(130);
    const [ms, grace] = readFileSync(join(r.dir, "ms"), "utf8").split(" ").map(Number);
    expect(ms).toBeGreaterThanOrEqual(grace - 50);
    expect(ms).toBeLessThan(grace + 1500);
    expect(alive(Number(readFileSync(join(r.dir, "child.pid"), "utf8")))).toBe(false);
  });

  it("a second signal during the grace period exits at once", () => {
    const r = runScript(`
      import { installTerminationHandler, registerAgent, childProcessAgent } from ${TERMINATION};
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      installTerminationHandler();
      const child = spawn("sh", ["-c", "trap '' TERM; while :; do sleep 1; done"], { stdio: "ignore" });
      writeFileSync(join($DIR, "child.pid"), String(child.pid));
      registerAgent(() => childProcessAgent(child));
      let sentAt = 0;
      process.on("exit", () => writeFileSync(join($DIR, "ms"), String(Date.now() - sentAt)));
      setTimeout(() => { sentAt = Date.now(); process.kill(process.pid, "SIGINT"); }, 300);
      setTimeout(() => process.kill(process.pid, "SIGINT"), 500);
      setTimeout(() => {}, 30_000);
    `);
    expect(r.status, r.stderr).toBe(130);
    expect(Number(readFileSync(join(r.dir, "ms"), "utf8"))).toBeLessThan(1000);
    expect(alive(Number(readFileSync(join(r.dir, "child.pid"), "utf8")))).toBe(false);
  });

  it("the exit status stays 128+signo when normal flow calls process.exit during the grace period", () => {
    const r = runScript(`
      import { installTerminationHandler, registerAgent, childProcessAgent } from ${TERMINATION};
      import { spawn } from "node:child_process";
      installTerminationHandler();
      const child = spawn("sh", ["-c", "trap '' TERM; while :; do sleep 1; done"], { stdio: "ignore" });
      registerAgent(() => childProcessAgent(child));
      setTimeout(() => process.kill(process.pid, "SIGINT"), 300);
      setTimeout(() => { child.kill("SIGKILL"); process.exit(1); }, 600);
      setTimeout(() => {}, 30_000);
    `);
    expect(r.status, r.stderr).toBe(130);
  });

  it("the egress cleanup still reaps containers before networks when fired by a signal", () => {
    const r = runScript(`
      import { registerCleanup } from ${SIDECAR};
      import { appendFileSync } from "node:fs";
      import { join } from "node:path";
      const log = (s) => appendFileSync(join($DIR, "order"), s + "\\n");
      registerCleanup({ phase: "network", run: () => log("net") });
      registerCleanup({ phase: "container", run: () => log("con") });
      setTimeout(() => process.kill(process.pid, "SIGINT"), 50);
      setTimeout(() => {}, 30_000);
    `);
    expect(r.status, r.stderr).toBe(130);
    expect(readFileSync(join(r.dir, "order"), "utf8").trim().split("\n")).toEqual(["con", "net"]);
    expect(r.stderr).toContain("reaping 2 in-flight egress resource(s)");
  });

  it("parkIfTerminating is a no-op when no signal has arrived", async () => {
    const { parkIfTerminating } = await import("../src/termination.js");
    await expect(parkIfTerminating()).resolves.toBeUndefined();
  });
});
