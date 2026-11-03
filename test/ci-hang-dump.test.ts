import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

// scripts/ci/hang-dump.sh is CI's job-level hang evidence: armed before a long test step, it records every node
// process's state if the step is still running near its limit. It only ever runs when something has already gone
// wrong, so a silent breakage would surface only as an empty artifact on the one run that needed it. This runs it
// for real (with no delay) against a live node process. Linux only: the script reads /proc.

const run = promisify(execFile);
const out = mkdtempSync(join(tmpdir(), "cwh-hang-dump-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe.skipIf(process.platform !== "linux")("scripts/ci/hang-dump.sh", () => {
  it("records the process tree and a per-process dump for a running node process", async () => {
    const target = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    try {
      // No gdb: attaching pauses each target, and every vitest process on this runner is a target.
      const r = await run("bash", [resolve("scripts/ci/hang-dump.sh"), "0", out], {
        timeout: 120_000,
        env: { ...process.env, HANG_DUMP_NO_GDB: "1" },
      });
      expect(r.stdout).toMatch(/dumped [1-9]\d* processes to /);
      const [job] = readdirSync(out).filter((d) => d.startsWith("job-"));
      expect(job).toBeDefined();
      const dir = join(out, job!);
      const files = readdirSync(dir);
      expect(files).toEqual(expect.arrayContaining(["host.txt", "ps-forest.txt", "ps-ef-forest.txt", `pid-${target.pid}.txt`]));
      const dump = readFileSync(join(dir, `pid-${target.pid}.txt`), "utf8");
      expect(dump).toContain("setTimeout");
      expect(dump).toContain("(skipped: HANG_DUMP_NO_GDB is set)");
      expect(dump).toMatch(/=== status\nName:/);
      expect(dump).toMatch(/=== tasks \(tid comm wchan state\)\n\d+ /);
      expect(readFileSync(join(dir, "ps-forest.txt"), "utf8")).toContain(String(target.pid));
    } finally {
      target.kill("SIGKILL");
    }
  }, 150_000);

  // The gdb branch, aimed at one process so nothing else on the runner is paused. CI installs gdb; if that install
  // failed, say so loudly instead of passing silently.
  it("records all-thread backtraces with gdb, where gdb is installed", async (ctx) => {
    if (!existsSync("/usr/bin/gdb")) {
      if (process.env.CI) process.stdout.write("::warning::gdb is not installed on this runner: hang dumps here carry no backtraces\n");
      ctx.skip();
    }
    const target = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    const dir = mkdtempSync(join(tmpdir(), "cwh-hang-dump-gdb-"));
    try {
      await run("bash", [resolve("scripts/ci/hang-dump.sh"), "0", dir], {
        timeout: 120_000,
        env: { ...process.env, HANG_DUMP_PIDS: String(target.pid) },
      });
      const [job] = readdirSync(dir).filter((d) => d.startsWith("job-"));
      const dump = readFileSync(join(dir, job!, `pid-${target.pid}.txt`), "utf8");
      // gdb exits 0 even when it cannot attach: check for frames, not the exit code.
      expect(dump).toMatch(/^Thread \d+ \(/m);
    } finally {
      target.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 150_000);
});
