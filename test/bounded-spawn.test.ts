// The lifted bounded spawn, in the command-metric mode: stdout has its own cap, stderr is drained and never kills,
// argv is literal (no shell), the env is exactly what the caller passes.
import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundedSpawnBuffers } from "../src/bounded-spawn.js";

const node = process.execPath;

describe("boundedSpawnBuffers: separate stdout cap, drained stderr", () => {
  it("a 1 MiB stderr writer with a valid stdout keeps its stdout (stderr never kills)", async () => {
    const r = await boundedSpawnBuffers(node, ["-e", "process.stderr.write('x'.repeat(1<<20)); process.stdout.write('42')"], {
      timeoutMs: 10_000,
      stdoutMax: 4096,
      stderrDrainMax: 4096,
    });
    expect(r.code).toBe(0);
    expect(r.truncated).toBe(false);
    expect(r.stdout.toString()).toBe("42");
    expect(r.stderr.length).toBe(4096);
  });

  it("a 1 MiB stdout writer is killed at the stdout cap", async () => {
    const r = await boundedSpawnBuffers(node, ["-e", "process.stdout.write('1'.repeat(1<<20)); setTimeout(()=>{}, 5000)"], {
      timeoutMs: 10_000,
      stdoutMax: 4096,
      stderrDrainMax: 4096,
    });
    expect(r.truncated).toBe("stdout");
    expect(r.code).toBeNull();
    expect(r.stdout.length).toBeLessThanOrEqual(4096);
  });

  it("a sleeping child and its grandchild in the group are killed at the timeout", async () => {
    const r = await boundedSpawnBuffers(
      node,
      [
        "-e",
        "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], {stdio:'ignore'}); setTimeout(()=>{}, 60000)",
      ],
      { timeoutMs: 300, stdoutMax: 4096 },
    );
    expect(r.timedOut).toBe(true);
    expect(r.code).toBeNull();
  });

  it("argv arrives literal: no shell expansion, no command substitution", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "bs-")));
    const r = await boundedSpawnBuffers(
      node,
      ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "$(touch pwned)", "*"],
      {
        timeoutMs: 10_000,
        cwd: dir,
        stdoutMax: 4096,
      },
    );
    expect(JSON.parse(r.stdout.toString())).toEqual(["$(touch pwned)", "*"]);
    expect(existsSync(join(dir, "pwned"))).toBe(false);
  });

  it("the env is exactly what the caller passes, and cwd is honoured", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "bs-")));
    const r = await boundedSpawnBuffers(
      node,
      ["-e", "process.stdout.write(JSON.stringify({k: Object.keys(process.env).sort(), cwd: process.cwd()}))"],
      {
        timeoutMs: 10_000,
        cwd: dir,
        env: { PATH: "/usr/bin:/bin", ONLY: "1" },
        stdoutMax: 4096,
      },
    );
    const o = JSON.parse(r.stdout.toString());
    expect(o.k.filter((k: string) => k !== "__CF_USER_TEXT_ENCODING")).toEqual(["ONLY", "PATH"]);
    expect(realpathSync(o.cwd)).toBe(dir);
  });

  it("a missing binary is a spawn error, never a throw", async () => {
    const r = await boundedSpawnBuffers("/nonexistent/bin", [], { timeoutMs: 1000, stdoutMax: 10 });
    expect(r.spawnError).toMatch(/ENOENT/);
    expect(r.code).toBeNull();
  });
});
