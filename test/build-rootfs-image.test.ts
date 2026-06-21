import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { hashFile, runPipeline } from "../scripts/build-rootfs-image.js";

describe("rootfs tag is content-addressed, not size+mtime", () => {
  it("changes the hash when content changes even if size is preserved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rootfs-hash-"));
    try {
      const a = join(dir, "a.img");
      const b = join(dir, "b.img");
      // Same byte length, different content — the OLD size+mtime tag could collide; the hash must not.
      writeFileSync(a, Buffer.from("AAAA"));
      writeFileSync(b, Buffer.from("AAAB"));
      const ha = await hashFile(a);
      const hb = await hashFile(b);
      expect(ha).not.toBe(hb);
      expect(ha).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is stable for identical content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rootfs-hash-"));
    try {
      const a = join(dir, "a.img");
      const b = join(dir, "b.img");
      writeFileSync(a, Buffer.from("hello world"));
      writeFileSync(b, Buffer.from("hello world"));
      expect(await hashFile(a)).toBe(await hashFile(b));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Minimal fake child process: an EventEmitter with kill()/exitCode/killed, like ChildProcess. */
class FakeProc extends EventEmitter {
  exitCode: number | null = null;
  killed = false;
  killSignal: string | null = null;
  kill(sig?: string): boolean {
    this.killed = true;
    this.killSignal = sig ?? "SIGTERM";
    // A killed process then closes.
    queueMicrotask(() => this.close(137));
    return true;
  }
  close(code: number): void {
    this.exitCode = code;
    this.emit("close", code);
  }
}

describe("pipeline cross-kills the sibling on failure", () => {
  it("resolves cleanly when both sides exit 0", async () => {
    const producer = new FakeProc();
    const consumer = new FakeProc();
    const p = runPipeline({ proc: producer as never, label: "producer" }, { proc: consumer as never, label: "consumer" });
    producer.close(0);
    consumer.close(0);
    await expect(p).resolves.toBeUndefined();
  });

  it("kills the consumer when the producer exits non-zero, then rejects", async () => {
    const producer = new FakeProc();
    const consumer = new FakeProc();
    const p = runPipeline({ proc: producer as never, label: "producer" }, { proc: consumer as never, label: "consumer" });
    producer.close(3); // producer fails; consumer is hung until killed
    await expect(p).rejects.toThrow(/producer failed \(exit 3\)/);
    expect(consumer.killed).toBe(true);
  });

  it("kills the producer when the consumer errors", async () => {
    const producer = new FakeProc();
    const consumer = new FakeProc();
    const p = runPipeline({ proc: producer as never, label: "producer" }, { proc: consumer as never, label: "consumer" });
    consumer.emit("error", new Error("spawn EACCES"));
    // The error handler kills the producer (→ close 137), consumer then closes non-zero.
    consumer.close(1);
    await expect(p).rejects.toThrow();
    expect(producer.killed).toBe(true);
  });
});
