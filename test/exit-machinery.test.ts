import { describe, it, expect, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  EXIT_FALLBACK_LINE,
  ExitRequested,
  __resetExitLatch,
  exitWith,
  latchedExitCode,
  rethrowIfExit,
  settleExitCode,
} from "../src/run/exit.js";

// src/run/exit.ts: a command asks to exit by throwing ExitRequested; the top level settles the code and lets the
// event loop drain; a fallback timer exits only if something still holds the loop. The in-process tests cover the
// pure parts. Anything that ends a process, or depends on process-wide listeners, runs in a child process against
// the built module, so this worker's own state is never involved.

describe("exitWith and the latch (in-process)", () => {
  beforeEach(() => {
    __resetExitLatch();
    process.exitCode = undefined;
  });

  it("throws ExitRequested with the code and latches the FIRST code only", () => {
    expect(() => exitWith(3)).toThrow(ExitRequested);
    expect(latchedExitCode()).toBe(3);
    try {
      exitWith(0);
    } catch (e) {
      expect((e as ExitRequested).code).toBe(0);
    }
    expect(latchedExitCode()).toBe(3);
    expect(process.exitCode).toBe(3);
    process.exitCode = undefined;
  });

  it("rethrowIfExit rethrows only an exit request", () => {
    expect(() => rethrowIfExit(new Error("x"))).not.toThrow();
    expect(() => rethrowIfExit(new ExitRequested(2))).toThrow(ExitRequested);
  });

  it("settle: an arrived request matching the latch is silent; no request and no latch sets nothing", () => {
    const lines: string[] = [];
    expect(settleExitCode(undefined, (l) => lines.push(l))).toBeUndefined();
    try {
      exitWith(2);
    } catch {
      /* the request */
    }
    expect(settleExitCode(2, (l) => lines.push(l))).toBe(2);
    expect(lines).toEqual([]);
    process.exitCode = undefined;
  });

  it("settle: a swallowed request is named, and its code wins", () => {
    const lines: string[] = [];
    try {
      exitWith(4);
    } catch {
      /* swallowed */
    }
    expect(settleExitCode(undefined, (l) => lines.push(l))).toBe(4);
    expect(lines.join("")).toMatch(/an exit \(code 4\) was caught and dropped before it reached the top level/);
    process.exitCode = undefined;
  });

  it("settle: a later, different request names both codes and the first wins", () => {
    const lines: string[] = [];
    try {
      exitWith(3);
    } catch {
      /* swallowed */
    }
    try {
      exitWith(0);
    } catch (e) {
      expect(settleExitCode((e as ExitRequested).code, (l) => lines.push(l))).toBe(3);
    }
    expect(lines.join("")).toMatch(/code 3\) was caught and dropped .* exiting 3, not 0/);
    process.exitCode = undefined;
  });
});

const EXIT_JS = resolve("dist/run/exit.js");
const built = existsSync(EXIT_JS);

/** Run an ES module snippet in a fresh node process with `X` bound to dist/run/exit.js. */
function node(body: string, timeout = 20_000) {
  const t0 = Date.now();
  const r = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `import * as X from ${JSON.stringify(pathToFileURL(EXIT_JS).href)};\n${body}`],
    {
      encoding: "utf8",
      timeout,
    },
  );
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - t0 };
}

describe.skipIf(!built)("the top level in a real process", () => {
  it("a request from an event callback reaches the process-level handler: its code, no stack, no fallback", () => {
    const r = node(`
      X.installExitHandlers({ sweep() {}, warn: (l) => process.stderr.write(l) });
      setTimeout(() => X.exitWith(3), 10);
    `);
    expect(r.code, r.stderr).toBe(3);
    expect(r.stderr).not.toMatch(/ExitRequested|at /);
    expect(r.stderr).not.toContain(X_FALLBACK);
  });

  it("the fallback ends a process whose loop is still held, with the settled code, and names what held it", () => {
    const r = node(`
      setInterval(() => {}, 1000); // a ref'd handle the command forgot
      X.settleExitCode(5, (l) => process.stderr.write(l));
      X.armExitFallback((l) => process.stderr.write(l), 300);
    `);
    expect(r.code, r.stderr).toBe(5);
    expect(r.stderr).toContain(EXIT_FALLBACK_LINE);
    expect(r.stderr).toMatch(/Timeout×\d/);
  });

  it("a process with nothing left exits by itself; the unref'd fallback never fires", () => {
    const r = node(`
      X.settleExitCode(0, (l) => process.stderr.write(l));
      X.armExitFallback((l) => process.stderr.write(l), 3000);
    `);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain(EXIT_FALLBACK_LINE);
    expect(r.ms).toBeLessThan(2500);
  });

  it("a swallowed request still exits with its code, with the warning", () => {
    const r = node(`
      try { X.exitWith(4); } catch { /* a catch that forgot rethrowIfExit */ }
      X.settleExitCode(undefined, (l) => process.stderr.write(l));
    `);
    expect(r.code).toBe(4);
    expect(r.stderr).toMatch(/an exit \(code 4\) was caught and dropped/);
  });

  it("an uncaught error with no other listener: its stack and exit 1, as Node's default", () => {
    const r = node(`
      X.installExitHandlers({ sweep() {}, warn: (l) => process.stderr.write(l) });
      setTimeout(() => { throw new Error("boom-uncaught"); }, 10);
    `);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("boom-uncaught");
    expect(r.stderr).toMatch(/\n\s+at /);
  });

  it("an uncaught error while another listener is installed is left to that listener (a page-crash recorder)", () => {
    const r = node(`
      X.installExitHandlers({ sweep() {}, warn: (l) => process.stderr.write(l) });
      const crashes = [];
      const later = (e) => crashes.push(e.message);
      process.on("uncaughtException", later);
      setTimeout(() => { throw new Error("page-threw"); }, 10);
      setTimeout(() => { process.off("uncaughtException", later); process.stdout.write(JSON.stringify(crashes)); }, 100);
    `);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(["page-threw"]);
    expect(r.stderr).not.toContain("page-threw");
  });

  it("an unhandled rejection carrying a request exits with its code", () => {
    const r = node(`
      X.installExitHandlers({ sweep() {}, warn: (l) => process.stderr.write(l) });
      Promise.reject(new X.ExitRequested(2));
    `);
    expect(r.code, r.stderr).toBe(2);
  });

  it("the handlers run the sweep before arming the fallback", () => {
    const r = node(`
      X.installExitHandlers({ sweep() { process.stdout.write("swept"); }, warn: (l) => process.stderr.write(l) });
      setTimeout(() => X.exitWith(0), 10);
    `);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("swept");
  });
});

const X_FALLBACK = EXIT_FALLBACK_LINE;
