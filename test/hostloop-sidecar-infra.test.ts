import { makeInfraEmitters } from "../src/runtime/hostloop.js";
import type { InfraErrorSource } from "../src/types.js";
import { describe, it, expect } from "vitest";

describe("makeInfraEmitters — a dead supervisor and a failed exec are different events", () => {
  it("tags a workspace exec failure distinctly from a sidecar death", () => {
    const sink: Array<{ source: InfraErrorSource; message: string }> = [];
    // an unwritable outDir is fine: the events.jsonl append is best-effort, the sink is the contract
    const { logSidecarInfra, logExecInfra } = makeInfraEmitters("/nonexistent-outdir-for-test", sink);
    logSidecarInfra("sidecar exited unexpectedly (code=1 signal=null): boom");
    logExecInfra("docker exec failed: no such container");
    expect(sink.map((e) => e.source)).toEqual(["hostloop-sidecar", "hostloop-exec"]);
    expect(sink[1].message).toContain("no such container");
  });
});
import { EventEmitter } from "node:events";
import { watchHostLoopSidecar, type SidecarWatchTarget } from "../src/runtime/hostloop.js";

/** A fake `docker run` sidecar child: a plain EventEmitter with an EventEmitter `stderr`, matching just
 *  enough of node:child_process's ChildProcess shape for `watchHostLoopSidecar` — no real spawn needed. */
function fakeSidecar(): SidecarWatchTarget & {
  stderr: EventEmitter;
  emitExit: (code: number | null, signal: NodeJS.Signals | null) => void;
} {
  const emitter = new EventEmitter() as unknown as SidecarWatchTarget & {
    stderr: EventEmitter;
    emitExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  };
  emitter.stderr = new EventEmitter();
  emitter.emitExit = (code, signal) => (emitter as unknown as EventEmitter).emit("exit", code, signal);
  return emitter;
}

describe("watchHostLoopSidecar — mid-run failures reach logInfra", () => {
  it("a non-zero exit code is reported", () => {
    const sidecar = fakeSidecar();
    const messages: string[] = [];
    watchHostLoopSidecar(sidecar, (m) => messages.push(m));
    sidecar.emitExit(1, null);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/exited unexpectedly/);
    expect(messages[0]).toMatch(/code=1/);
  });

  it("a signal-only kill (code null, signal set — e.g. SIGKILL/OOM) is reported — this is the prior blind spot", () => {
    const sidecar = fakeSidecar();
    const messages: string[] = [];
    watchHostLoopSidecar(sidecar, (m) => messages.push(m));
    sidecar.emitExit(null, "SIGKILL");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/signal=SIGKILL/);
  });

  it("a spawn failure ('error' event) is reported", () => {
    const sidecar = fakeSidecar();
    const messages: string[] = [];
    watchHostLoopSidecar(sidecar, (m) => messages.push(m));
    (sidecar as unknown as EventEmitter).emit("error", new Error("ENOENT: docker not found"));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/failed to spawn/);
  });

  it("includes the collected stderr tail in the exit message", () => {
    const sidecar = fakeSidecar();
    const messages: string[] = [];
    watchHostLoopSidecar(sidecar, (m) => messages.push(m));
    sidecar.stderr.emit("data", Buffer.from("oom-killer invoked"));
    sidecar.emitExit(137, null);
    expect(messages[0]).toContain("oom-killer invoked");
  });
});

describe("watchHostLoopSidecar — teardown-initiated exits are suppressed (the naive-fix gotcha)", () => {
  it("an exit AFTER markTearingDown() is NOT reported, regardless of code/signal", () => {
    const sidecar = fakeSidecar();
    const messages: string[] = [];
    const { markTearingDown } = watchHostLoopSidecar(sidecar, (m) => messages.push(m));
    markTearingDown();
    sidecar.emitExit(null, "SIGKILL"); // what `docker rm -f` typically produces
    sidecar.emitExit(1, null);
    expect(messages).toHaveLength(0);
  });

  it("an 'error' event AFTER markTearingDown() is NOT reported", () => {
    const sidecar = fakeSidecar();
    const messages: string[] = [];
    const { markTearingDown } = watchHostLoopSidecar(sidecar, (m) => messages.push(m));
    markTearingDown();
    (sidecar as unknown as EventEmitter).emit("error", new Error("some teardown-adjacent error"));
    expect(messages).toHaveLength(0);
  });

  it("an exit BEFORE markTearingDown() IS reported — the flag only suppresses what follows it", () => {
    const sidecar = fakeSidecar();
    const messages: string[] = [];
    const { markTearingDown } = watchHostLoopSidecar(sidecar, (m) => messages.push(m));
    sidecar.emitExit(1, null);
    markTearingDown();
    expect(messages).toHaveLength(1);
  });
});
