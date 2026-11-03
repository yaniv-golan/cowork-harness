import { readFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, expect } from "vitest";
import { BEAT, realNow, wrapSync } from "./sync-child-wrap.js";

// The sync-child watchdog. A test that calls spawnSync / execFileSync / execSync blocks its whole vitest fork until
// the child exits; vitest's testTimeout is a timer on that same blocked event loop, so it can never fire. A child
// that never exits therefore hangs the run until the CI job's time limit, and the job log, which held the only clue,
// is lost with it. Node itself has such a bug: on Node 24+ a process can deadlock inside process.exit() (a
// background Sparkplug compile waits for a GC the exiting main thread will never run), and the CLI under test
// exits that way.
//
// The fix here is diagnostic, not a cure. A worker thread watches a heartbeat this thread writes every 250 ms. When
// the heartbeat has been silent longer than any legitimate wait could take, the worker records stack dumps of the
// fork's children and of the fork, kills the children so the blocked call returns, and counts the event. This
// thread's afterEach then fails the test that hung, naming the command and the dump directory. A hang outside a test
// (a hook, module load) has no afterEach to fail, so test/setup/hang-dir.ts fails the whole run whenever a dump
// exists.
//
// Silence is measured from the later of the last heartbeat and the start of the sync call now running, so a hook or
// test that makes many sync calls back to back is judged call by call, not as one long block. The limit is the
// largest of: COWORK_TEST_HANG_T_MS (default 90 s; the slowest sync call measured in the suite under full load took
// ~20 s); the running test's own timeout + 30 s; and, during a sync call that declares `timeout`, that timeout + 30 s.
// So a call or test given a generous budget keeps it, and a call's own timeout always fires first. Hooks get no floor
// of their own: a hook's single sync call needs a `timeout` if it can legitimately take longer than T.
//
// Transparency: the wrapper only records the call's declared timeout around the original function, then returns its
// result or rethrows its error unchanged. It must be the first setup file, so a module that binds these functions
// at import time binds the wrapped ones. COWORK_TEST_WATCHDOG=0 turns it off.

const TEST_FLOOR = 2,
  EVENTS = 3,
  FILE_LEN = 4;
const SLOTS = 6; // 5 = CALL_START, written by sync-child-wrap.ts
const FILE_BYTES = 4096;
// The margin added to a declared timeout. COWORK_TEST_HANG_GRACE_MS exists for the watchdog's own tests.
const graceRaw = Number(process.env.COWORK_TEST_HANG_GRACE_MS);
const GRACE_MS = Number.isFinite(graceRaw) && graceRaw >= 0 ? graceRaw : 30_000;

export const WATCHDOG_KEY = Symbol.for("cowork-harness.sync-child-watchdog");

export interface Watchdog {
  slots: BigInt64Array;
  /** The unwrapped child_process functions, for the transparency test. */
  originals: Record<"spawnSync" | "execFileSync" | "execSync", (...a: never[]) => unknown>;
  file: Uint8Array;
  runDir: string;
  seen: bigint;
}

const KEY = WATCHDOG_KEY;
type G = typeof globalThis & { [KEY]?: Watchdog };

function start(): Watchdog {
  const env = process.env.COWORK_TEST_HANG_RUN_DIR;
  const runDir = env || join(tmpdir(), "cowork-test-hangs", `orphan-${process.pid}`);
  if (!env)
    process.stderr.write(
      `sync-child watchdog: COWORK_TEST_HANG_RUN_DIR is unset (test/setup/hang-dir.ts not loaded?); dumps go to ${runDir}\n`,
    );
  const baseRaw = Number(process.env.COWORK_TEST_HANG_T_MS);
  const baseMs = Number.isFinite(baseRaw) && baseRaw > 0 ? baseRaw : 90_000;
  const sab = new SharedArrayBuffer(SLOTS * 8);
  const fileSab = new SharedArrayBuffer(FILE_BYTES);
  const slots = new BigInt64Array(sab);
  Atomics.store(slots, BEAT, BigInt(realNow()));
  setInterval(() => Atomics.store(slots, BEAT, BigInt(realNow())), 250).unref();
  const worker = new Worker(new URL("./sync-child-watchdog-worker.mjs", import.meta.url), {
    workerData: {
      sab,
      fileSab,
      pid: process.pid,
      runDir,
      baseMs,
      pollMs: Math.min(1000, Math.max(100, baseMs / 10)),
      graceMs: GRACE_MS,
      // Test-only: see test/sync-child-watchdog.test.ts.
      failFirstListing: process.env.COWORK_TEST_HANG_FAIL_FIRST_LISTING === "1",
    },
  });
  // Never keep the fork alive, and never delay its exit: vitest ends a fork by terminating it.
  worker.unref();
  worker.on("error", (e: Error) => process.stderr.write(`sync-child watchdog: worker failed: ${e?.stack ?? e}\n`));
  // The CommonJS exports object, which is mutable; the ESM namespace object is not.
  const cp = createRequire(import.meta.url)("node:child_process") as Record<string, (...a: never[]) => unknown>;
  const originals = { spawnSync: cp.spawnSync!, execFileSync: cp.execFileSync!, execSync: cp.execSync! };
  for (const name of ["spawnSync", "execFileSync", "execSync"] as const) cp[name] = wrapSync(originals[name], slots);
  // Refresh the named ESM exports (`import { spawnSync } from "node:child_process"`) to the wrapped functions.
  syncBuiltinESMExports();
  return { slots, originals, file: new Uint8Array(fileSab), runDir, seen: 0n };
}

function setFile(w: Watchdog, path: string): void {
  const bytes = new TextEncoder().encode(path).subarray(0, FILE_BYTES);
  w.file.set(bytes);
  Atomics.store(w.slots, FILE_LEN, BigInt(bytes.length));
}

const g = globalThis as G;
// One watchdog per fork. Setup files re-run for every test file in a fork; the worker and the wrapping must not.
const wd: Watchdog | undefined = process.env.COWORK_TEST_WATCHDOG === "0" ? undefined : (g[KEY] ??= start());

if (wd) {
  // This file's path, for a hang in its hooks or at load (setup files run once per test file).
  setFile(wd, expect.getState().testPath ?? "?");
  beforeEach((ctx) => {
    // Blame this test only for events during it; one in a hook or at load is hang-dir.ts's to report.
    wd.seen = Atomics.load(wd.slots, EVENTS);
    setFile(wd, ctx.task.file?.filepath ?? "?");
    const t = ctx.task.timeout;
    Atomics.store(wd.slots, TEST_FLOOR, typeof t === "number" && t > 0 ? BigInt(t + GRACE_MS) : 0n);
  });
  afterEach(() => {
    Atomics.store(wd.slots, TEST_FLOOR, 0n);
    const n = Atomics.load(wd.slots, EVENTS);
    if (n <= wd.seen) return;
    const first = wd.seen + 1n;
    wd.seen = n;
    const dir = join(wd.runDir, `pid${process.pid}-ev${first}`);
    let what = "";
    try {
      const s = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")) as { children?: { command: string }[]; silentMs?: number };
      what = s.children?.length
        ? `${s.children.map((c) => c.command).join(" | ")} (killed after ${Math.round((s.silentMs ?? 0) / 1000)}s)`
        : "no child process: this test's own thread was blocked";
    } catch {
      what = "(summary.json unreadable)";
    }
    throw new Error(`this test blocked its process past the sync-child watchdog's limit: ${what}. Stack dumps: ${dir}`);
  });
}
