import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveAgentSession } from "../src/agent/session.js";
import { scrubRawRunLogs } from "../src/run/execute.js";

/**
 * #60: the `agent.stderr.log` sink was piped fire-and-forget and never awaited, so bytes still buffered
 * when `scrubRawRunLogs` read the file could land raw AFTERWARDS — a persisted-secret leak. The fix pipes
 * it with `{ end: false }` and ends+awaits it in `start()`'s teardown drain, so the session generator
 * resolves only after the sink is fully flushed. These tests lock that flush-before-resolve guarantee.
 */

/** A minimal fake ChildProcessByStdio: EventEmitter + stdin/stdout/stderr PassThroughs (mirrors the
 *  helper in test/session-parse-guards.test.ts). Exits 0 so no typed error event is emitted. */
function fakeProc() {
  const proc = new EventEmitter() as any;
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.exitCode = 0;
  proc.signalCode = null;
  return proc;
}

async function driveToCompletion(session: ReturnType<typeof newSession>["session"], proc: ReturnType<typeof fakeProc>) {
  const gen = session.start();
  proc.stdout.end(); // ending stdout terminates the readline loop → the finally-drain runs
  for await (const _ev of gen) {
    /* consume every event until the generator resolves (drain awaited inside) */
  }
}

function newSession() {
  const proc = fakeProc();
  const outDir = mkdtempSync(join(tmpdir(), "stderr-flush-"));
  const session = new LiveAgentSession(proc as any, outDir);
  return { proc, outDir, session };
}

describe("#60: agent.stderr.log is flushed before scrubRawRunLogs can read it", () => {
  it("stderr bytes written during the run are fully on disk by the time the session generator resolves", async () => {
    const { proc, outDir, session } = newSession();
    // Large enough to sit in the stream's internal buffer rather than flush synchronously.
    const secret = "sk-ant-SECRET-" + "x".repeat(8000);
    proc.stderr.write(secret + "\n");
    proc.stderr.end(); // source ends; with `{ end: false }` the sink stays open until the drain ends it

    await driveToCompletion(session, proc);

    // DETERMINISTIC GUARANTEE (the actual fix): the sink stream is ENDED + flushed to fd ('finish' fired)
    // by the time the generator resolves — so a scrub running next can't miss bytes still in the stream's
    // internal buffer. Piped with `{ end: false }`, this is true ONLY because the teardown drain awaits
    // `errLog.end()`; drop that and `writableFinished` stays false here.
    expect((session as unknown as { errLog: { writableFinished: boolean } }).errLog.writableFinished).toBe(true);

    // ...and every byte is therefore on disk.
    const raw = readFileSync(join(outDir, "agent.stderr.log"), "utf8");
    expect(raw).toContain(secret);
  });

  it("so the teardown scrub actually catches those bytes — no raw secret survives after the scrub", async () => {
    const { proc, outDir, session } = newSession();
    const secret = "ghp_SECRETTOKEN_" + "y".repeat(8000);
    proc.stderr.write("agent stderr line with " + secret + " embedded\n");
    proc.stderr.end();

    await driveToCompletion(session, proc);

    // executeScenario's teardown runs this AFTER the generator resolves; the flush above means it sees
    // the secret and redacts it, instead of the bytes landing raw a moment later.
    scrubRawRunLogs(outDir, [secret]);

    const scrubbed = readFileSync(join(outDir, "agent.stderr.log"), "utf8");
    expect(scrubbed).not.toContain(secret); // the raw secret is gone
    expect(scrubbed).toContain("agent stderr line with"); // ...but the surrounding log is preserved
  });
});
