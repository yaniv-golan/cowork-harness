import * as cpNs from "node:child_process";
import { execFileSync as namedExecFileSync, execSync as namedExecSync, spawnSync as namedSpawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { CALL_START, CALL_TIMEOUT, wrapSync } from "./setup/sync-child-wrap.js";

// The sync-child watchdog (test/setup/sync-child-watchdog.ts) replaces spawnSync, execFileSync and execSync for every
// test in the unit lane. That is only safe if the replacement is invisible: same return value, same thrown error,
// same options honoured. This file compares each wrapped function against the unwrapped original, call for call,
// across success, a non-zero exit, a timeout and a missing binary.

type Fn = (...a: never[]) => unknown;
const cjs = createRequire(import.meta.url)("node:child_process") as Record<string, Fn>;
const wd = (globalThis as Record<symbol, unknown>)[Symbol.for("cowork-harness.sync-child-watchdog")] as
  { originals: Record<"spawnSync" | "execFileSync" | "execSync", Fn> } | undefined;
// With the watchdog off (COWORK_TEST_WATCHDOG=0) nothing is wrapped and the module's own functions are the originals.
const orig = wd?.originals ?? { spawnSync: cjs.spawnSync!, execFileSync: cjs.execFileSync!, execSync: cjs.execSync! };

const NODE = process.execPath;
const MISSING = "/nonexistent/cowork-wrap-test-binary";

/** Everything observable about a call's outcome, with every `pid` (different on each run) removed. */
function outcome(f: Fn, args: unknown[]): unknown {
  try {
    return { returned: plain((f as (...a: unknown[]) => unknown)(...args)) };
  } catch (e) {
    return { threw: plain(e) };
  }
}

/** A comparable copy: own enumerable fields, plus an Error's name, message and class; `pid` dropped at any depth. */
function plain(v: unknown, path: object[] = []): unknown {
  if (v === null || typeof v !== "object" || Buffer.isBuffer(v)) return v;
  // Node's sync errors can refer to themselves (an execFileSync error's `error` field is the error); keep the shape.
  const back = path.indexOf(v);
  if (back >= 0) return `[cycle ${path.length - back}]`;
  const inner = [...path, v];
  if (Array.isArray(v)) return v.map((x) => plain(x, inner));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) if (k !== "pid") out[k] = plain(x, inner);
  if (v instanceof Error) Object.assign(out, { name: v.name, message: v.message, ctor: v.constructor?.name });
  return out;
}

const cases: [string, "spawnSync" | "execFileSync" | "execSync", unknown[]][] = [
  ["spawnSync success", "spawnSync", [NODE, ["-e", "process.stdout.write('out'); process.stderr.write('err')"]]],
  ["spawnSync success, utf8", "spawnSync", [NODE, ["-e", "process.stdout.write('out')"], { encoding: "utf8" }]],
  ["spawnSync non-zero exit", "spawnSync", [NODE, ["-e", "process.stderr.write('bad'); process.exit(3)"], { encoding: "utf8" }]],
  ["spawnSync timeout", "spawnSync", [NODE, ["-e", "setTimeout(() => {}, 60000)"], { timeout: 300 }]],
  ["spawnSync missing binary", "spawnSync", [MISSING, ["x"]]],
  ["spawnSync with input", "spawnSync", [NODE, ["-e", "process.stdin.pipe(process.stdout)"], { input: "piped", encoding: "utf8" }]],
  ["execFileSync success", "execFileSync", [NODE, ["-e", "process.stdout.write('out')"], { encoding: "utf8" }]],
  ["execFileSync success, buffer", "execFileSync", [NODE, ["-e", "process.stdout.write('out')"]]],
  [
    "execFileSync non-zero exit",
    "execFileSync",
    [NODE, ["-e", "process.stderr.write('bad'); process.exit(3)"], { encoding: "utf8", stdio: "pipe" }],
  ],
  ["execFileSync timeout", "execFileSync", [NODE, ["-e", "setTimeout(() => {}, 60000)"], { timeout: 300, stdio: "pipe" }]],
  ["execFileSync missing binary", "execFileSync", [MISSING, ["x"], { stdio: "pipe" }]],
  ["execSync success", "execSync", ["echo out", { encoding: "utf8" }]],
  ["execSync non-zero exit", "execSync", ["echo bad >&2; exit 3", { encoding: "utf8", stdio: "pipe" }]],
  ["execSync timeout", "execSync", ["sleep 60", { timeout: 300, stdio: "pipe" }]],
  ["execSync missing binary", "execSync", [`${MISSING} x`, { stdio: "pipe" }]],
];

describe("the sync-child watchdog's child_process wrapper is behaviour-transparent", () => {
  it.each(cases)("%s: wrapped and unwrapped give the same outcome", (_label, name, args) => {
    const slots = new BigInt64Array(new SharedArrayBuffer(6 * 8));
    const wrapped = wrapSync(orig[name], slots);
    const a = outcome(orig[name], args);
    const b = outcome(wrapped, args);
    expect(b).toEqual(a);
    // The wrapper leaves nothing behind once the call returns or throws.
    expect(Atomics.load(slots, CALL_TIMEOUT)).toBe(0n);
    expect(Atomics.load(slots, CALL_START)).toBe(0n);
  });

  it("the timeout and missing-binary cases really exercised those paths", () => {
    // Guards the table above against comparing two identical successes.
    expect((outcome(orig.spawnSync, cases[3]![2]) as { returned: { error: { code: string } } }).returned.error.code).toBe("ETIMEDOUT");
    expect((outcome(orig.spawnSync, cases[4]![2]) as { returned: { error: { code: string } } }).returned.error.code).toBe("ENOENT");
    expect((outcome(orig.execFileSync, cases[8]![2]) as { threw: { status: number } }).threw.status).toBe(3);
  });

  it("records the declared timeout and start while the call runs", () => {
    const slots = new BigInt64Array(new SharedArrayBuffer(6 * 8));
    let seen: [bigint, bigint] = [0n, 0n];
    const probe = function (this: unknown, ..._a: unknown[]) {
      seen = [Atomics.load(slots, CALL_TIMEOUT), Atomics.load(slots, CALL_START)];
      return this;
    };
    const ctx = { me: 1 };
    expect(wrapSync(probe as Fn, slots).call(ctx as never, "cmd" as never, [] as never, { timeout: 1234.5 } as never)).toBe(ctx);
    expect(seen[0]).toBe(1235n);
    expect(seen[1]).toBeGreaterThan(0n);
    wrapSync(probe as Fn, slots).call(null as never, "cmd" as never, { timeout: 0 } as never);
    expect(seen[0]).toBe(0n);
  });

  it("keeps the original's name and arity", () => {
    for (const name of ["spawnSync", "execFileSync", "execSync"] as const) {
      const w = wrapSync(orig[name], new BigInt64Array(new SharedArrayBuffer(48)));
      expect(w.name).toBe(orig[name].name);
      expect(w.length).toBe(orig[name].length);
    }
  });

  it.skipIf(!wd)("is what a test file's own imports of node:child_process resolve to", () => {
    // Named ESM imports, the namespace and require() must all see the wrapped function; otherwise a test's hung
    // child would never have its declared timeout recorded (and the watchdog would fire early on it).
    for (const [name, named] of [
      ["spawnSync", namedSpawnSync],
      ["execFileSync", namedExecFileSync],
      ["execSync", namedExecSync],
    ] as const) {
      expect(named).not.toBe(orig[name]);
      expect(named).toBe(cjs[name]);
      expect((cpNs as unknown as Record<string, unknown>)[name]).toBe(cjs[name]);
    }
  });
});
