import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { childInterruptSignal, InterruptedError } from "../src/termination.js";

// A terminal Ctrl-C signals the whole foreground group, so a child the CLI is blocked on can die of it before the
// CLI's own handler has run. Its failure is then the interrupt, and the CLI must exit as interrupted (128 + signo),
// not report the child's failure as an error of its own.

describe("childInterruptSignal", () => {
  it("names the interrupt a child was killed by, or the shell's 128 + signo for one", () => {
    expect(childInterruptSignal({ status: null, signal: "SIGINT" })).toBe("SIGINT");
    expect(childInterruptSignal({ status: null, signal: "SIGTERM" })).toBe("SIGTERM");
    expect(childInterruptSignal({ status: null, signal: "SIGHUP" })).toBe("SIGHUP");
    expect(childInterruptSignal({ status: 130, signal: null })).toBe("SIGINT");
    expect(childInterruptSignal({ status: 143, signal: null })).toBe("SIGTERM");
  });

  it("is undefined for an ordinary failure, a success, or a signal that is not an interrupt", () => {
    expect(childInterruptSignal({ status: 0, signal: null })).toBeUndefined();
    expect(childInterruptSignal({ status: 1, signal: null })).toBeUndefined();
    expect(childInterruptSignal({ status: 128, signal: null })).toBeUndefined();
    expect(childInterruptSignal({ status: null, signal: "SIGKILL" })).toBeUndefined();
    expect(childInterruptSignal({ status: null, signal: "SIGSEGV" })).toBeUndefined();
  });

  it("a child killed by its own timeout is not an interrupt (spawnSync kills it with SIGTERM and sets ETIMEDOUT)", () => {
    const timedOut = Object.assign(new Error("spawnSync claude ETIMEDOUT"), { code: "ETIMEDOUT" });
    expect(childInterruptSignal({ status: null, signal: "SIGTERM", error: timedOut })).toBeUndefined();
    // execFileSync throws that error itself, with the status and signal on it.
    expect(childInterruptSignal(Object.assign(timedOut, { status: null, signal: "SIGTERM" as const }))).toBeUndefined();
  });

  it("a child Node killed for overflowing its output buffer (ENOBUFS) is not an interrupt either", () => {
    const overflow = Object.assign(new Error("spawnSync git ENOBUFS"), { code: "ENOBUFS" });
    expect(childInterruptSignal({ status: null, signal: "SIGTERM", error: overflow })).toBeUndefined();
    expect(childInterruptSignal(Object.assign(overflow, { status: null, signal: "SIGTERM" as const }))).toBeUndefined();
  });

  it("exit 129 is not read as SIGHUP: git exits 129 on a usage error, and a real SIGHUP kills by signal", () => {
    expect(childInterruptSignal({ status: 129, signal: null })).toBeUndefined();
  });

  it("InterruptedError carries the signal", () => {
    const e = new InterruptedError("SIGINT", "git");
    expect(e.signal).toBe("SIGINT");
    expect(e.message).toMatch(/git was interrupted \(SIGINT\)/);
  });
});

// Once a signal has been handled, the handler's exit hook makes every exit report it (`process.exitCode` set in an
// "exit" listener wins over the code passed to process.exit), so an error path needs no check of its own. What it
// cannot see is a signal not handled yet: the child-status mapping above covers that.
describe.runIf(process.platform !== "win32")("an error exit after a handled interrupt reports the interrupt", () => {
  const run = (body: string) => {
    const dir = mkdtempSync(join(tmpdir(), "interrupt-exit-"));
    const script = join(dir, "s.mts");
    writeFileSync(script, body);
    return spawnSync(process.execPath, ["--import", "tsx", script], { encoding: "utf8", timeout: 20_000 });
  };
  const TERMINATION = JSON.stringify(resolve("src/termination.ts"));
  const ENVELOPE = JSON.stringify(resolve("src/run/envelope.ts"));

  it("a boundary error raised while SIGINT is held exits 130, not 3", () => {
    // The hold keeps the handler from exiting first, as a step finishing its result would: the error that step then
    // raises is a consequence of the interrupt.
    const r = run(`
      import { installTerminationHandler, holdExit, interrupt } from ${TERMINATION};
      import { fail } from ${ENVELOPE};
      installTerminationHandler();
      holdExit();
      interrupt("SIGINT");
      fail("eval", "boundary", "a child the stop killed failed", undefined, false);
    `);
    expect(r.status, r.stderr).toBe(130);
  });

  it("with no interrupt, the same error keeps its own exit status", () => {
    const r = run(`
      import { fail } from ${ENVELOPE};
      fail("eval", "boundary", "a real boundary error", undefined, false);
    `);
    expect(r.status, r.stderr).toBe(3);
  });
});
