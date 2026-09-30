import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

// The signal handler can only be exercised in a process that is allowed to die, so each case runs a small
// script against the REAL source (via tsx) in a child node process, the same way the --decider-cmd
// process-group test exercises its exit hook.
//
// A child the script spawns inherits fd 3, a pipe back to this test (`stdio: ["ignore", "ignore", "ignore", 3]`).
// "The child died" is observed as EOF on that pipe once the script has exited: fds close at death, zombie or
// not, so this holds in a container without an init process and needs no pid polling.

const POSIX = process.platform !== "win32";
const TERMINATION = JSON.stringify(resolve("src/termination.ts"));
const SIDECAR = JSON.stringify(resolve("src/egress/sidecar.ts"));

async function runScript(
  body: string,
): Promise<{ status: number | null; signal: NodeJS.Signals | null; stderr: string; dir: string; eof: () => Promise<boolean> }> {
  const dir = mkdtempSync(join(tmpdir(), "termination-"));
  const script = join(dir, "harness.mts");
  writeFileSync(script, body.replaceAll("$DIR", JSON.stringify(dir)));
  const proc = spawn(process.execPath, ["--import", "tsx", script], { stdio: ["ignore", "ignore", "pipe", "pipe"] });
  let stderr = "";
  proc.stderr!.on("data", (d) => (stderr += d));
  const fd3 = proc.stdio[3] as Readable;
  let ended = false;
  fd3.on("data", () => {});
  fd3.on("end", () => (ended = true));
  const killer = setTimeout(() => proc.kill("SIGKILL"), 20_000);
  const [status, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((res) => proc.on("exit", (c, s) => res([c, s])));
  clearTimeout(killer);
  const eof = (ms = 3000) =>
    new Promise<boolean>((res) => {
      if (ended) return res(true);
      const t = setTimeout(() => res(false), ms);
      fd3.once("end", () => {
        clearTimeout(t);
        res(true);
      });
    });
  return { status, signal, stderr, dir, eof };
}

/** A child that survived the handler is killed here by the pid its script wrote, so a red test leaks nothing. */
function reap(dir: string): void {
  try {
    process.kill(Number(readFileSync(join(dir, "child.pid"), "utf8")), "SIGKILL");
  } catch {
    /* gone, as it should be */
  }
}

describe.runIf(POSIX)("termination handler", () => {
  it("SIGINT: helpers step, agent terminated, egress step, exit hooks run, exit 130", async () => {
    const r = await runScript(`
      import { installTerminationHandler, registerAgent, registerTerminationStep, childProcessAgent } from ${TERMINATION};
      import { spawn } from "node:child_process";
      import { appendFileSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const log = (s) => appendFileSync(join($DIR, "order"), s + "\\n");
      installTerminationHandler();
      const child = spawn("sleep", ["300"], { stdio: ["ignore", "ignore", "ignore", 3] });
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
    const died = await r.eof();
    reap(r.dir);
    expect(died).toBe(true);
  });

  it("SIGTERM exits 143", async () => {
    const r = await runScript(`
      import { installTerminationHandler } from ${TERMINATION};
      installTerminationHandler();
      setTimeout(() => process.kill(process.pid, "SIGTERM"), 50);
      setTimeout(() => {}, 30_000);
    `);
    expect(r.status, r.stderr).toBe(143);
  });

  it("with nothing to wait for, the exit is immediate (no grace delay)", async () => {
    const r = await runScript(`
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
    // Well under the 2000ms grace period, so it still proves there was no grace wait, with headroom for a
    // loaded CI shard (the exit itself is a few ms).
    expect(Number(readFileSync(join(r.dir, "ms"), "utf8"))).toBeLessThan(1000);
  });

  it("an agent that ignores SIGTERM is force-killed at the end of the grace period", async () => {
    const r = await runScript(`
      import { installTerminationHandler, registerAgent, childProcessAgent, TERMINATION_GRACE_MS } from ${TERMINATION};
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      installTerminationHandler();
      const child = spawn("sh", ["-c", "trap '' TERM; while :; do sleep 1; done"], { stdio: ["ignore", "ignore", "ignore", 3] });
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
    const died = await r.eof();
    reap(r.dir);
    expect(died).toBe(true);
  });

  it("the grace period is the longest a pending agent asks for (hostloop's is 5 s, as Desktop's)", async () => {
    const r = await runScript(`
      import { installTerminationHandler, registerAgent } from ${TERMINATION};
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      installTerminationHandler();
      registerAgent(() => ({ graceMs: 3200, alive: () => true, terminate: () => {}, forceKill: () => {}, exited: () => new Promise(() => {}) }));
      let sentAt = 0;
      process.on("exit", () => writeFileSync(join($DIR, "ms"), String(Date.now() - sentAt)));
      setTimeout(() => { sentAt = Date.now(); process.kill(process.pid, "SIGINT"); }, 50);
      setTimeout(() => {}, 30_000);
    `);
    expect(r.status, r.stderr).toBe(130);
    const ms = Number(readFileSync(join(r.dir, "ms"), "utf8"));
    expect(ms).toBeGreaterThanOrEqual(3150);
    expect(ms).toBeLessThan(4700);
  });

  it("a second signal during the grace period exits at once", async () => {
    const r = await runScript(`
      import { installTerminationHandler, registerAgent, childProcessAgent } from ${TERMINATION};
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      installTerminationHandler();
      const child = spawn("sh", ["-c", "trap '' TERM; while :; do sleep 1; done"], { stdio: ["ignore", "ignore", "ignore", 3] });
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
    const died = await r.eof();
    reap(r.dir);
    expect(died).toBe(true);
  });

  it("the exit status stays 128+signo when normal flow calls process.exit during the grace period", async () => {
    const r = await runScript(`
      import { installTerminationHandler, registerAgent, childProcessAgent } from ${TERMINATION};
      import { spawn } from "node:child_process";
      installTerminationHandler();
      const child = spawn("sh", ["-c", "trap '' TERM; while :; do sleep 1; done"], { stdio: ["ignore", "ignore", "ignore", 3] });
      registerAgent(() => childProcessAgent(child));
      setTimeout(() => process.kill(process.pid, "SIGINT"), 300);
      setTimeout(() => { child.kill("SIGKILL"); process.exit(1); }, 600);
      setTimeout(() => {}, 30_000);
    `);
    expect(r.status, r.stderr).toBe(130);
  });

  it("the egress cleanup still reaps containers before networks when fired by a signal", async () => {
    const r = await runScript(`
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

  it("force-kill reaches a tree agent whose leader already exited; a guest (microvm-style) agent keeps its alive() gate", async () => {
    const r = await runScript(`
      import { installTerminationHandler, registerAgent } from ${TERMINATION};
      import { appendFileSync } from "node:fs";
      import { join } from "node:path";
      const log = (s) => appendFileSync(join($DIR, "order"), s + "\\n");
      installTerminationHandler();
      const done = Promise.resolve();
      registerAgent(() => ({ unconditionalForceKill: true, alive: () => false, terminate: () => log("tree-terminate"),
        forceKill: (o) => log("tree-forceKill " + JSON.stringify(o ?? {})), exited: () => done }));
      registerAgent(() => ({ alive: () => false, terminate: () => log("guest-terminate"),
        forceKill: () => log("guest-forceKill"), exited: () => done }));
      setTimeout(() => process.kill(process.pid, "SIGINT"), 50);
      setTimeout(() => {}, 30_000);
    `);
    expect(r.status, r.stderr).toBe(130);
    expect(readFileSync(join(r.dir, "order"), "utf8").trim().split("\n")).toEqual(["tree-forceKill {}"]);
  });

  it("a second signal force-kills with { fast: true } (no fresh process listing)", async () => {
    const r = await runScript(`
      import { installTerminationHandler, registerAgent } from ${TERMINATION};
      import { appendFileSync } from "node:fs";
      import { join } from "node:path";
      const log = (s) => appendFileSync(join($DIR, "order"), s + "\\n");
      installTerminationHandler();
      let alive = true;
      registerAgent(() => ({ unconditionalForceKill: true, alive: () => alive, terminate: () => log("terminate"),
        forceKill: (o) => { log("forceKill " + JSON.stringify(o ?? {})); alive = false; }, exited: () => new Promise(() => {}) }));
      setTimeout(() => process.kill(process.pid, "SIGINT"), 50);
      setTimeout(() => process.kill(process.pid, "SIGINT"), 250);
      setTimeout(() => {}, 30_000);
    `);
    expect(r.status, r.stderr).toBe(130);
    expect(readFileSync(join(r.dir, "order"), "utf8").trim().split("\n")).toEqual(["terminate", 'forceKill {"fast":true}']);
  });

  it("parkIfTerminating is a no-op when no signal has arrived", async () => {
    const { parkIfTerminating } = await import("../src/termination.js");
    await expect(parkIfTerminating()).resolves.toBeUndefined();
  });
});
