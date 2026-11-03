import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import config from "../vitest.config.js";

// Guards for the sync-child watchdog (test/setup/sync-child-watchdog.ts) and its run-level backstop
// (test/setup/hang-dir.ts). Each case runs a child vitest over a one-file fixture with a short limit, and asserts on
// what a developer or CI would see: the exit code, the failing test's message, and the dump directory.
//
// The child gets its own hang base and never the parent's COWORK_TEST_HANG_RUN_DIR, so a dump a fixture is
// supposed to produce can never fail this run.

const REPO = resolve(".");
const VITEST = join(REPO, "node_modules", "vitest", "vitest.mjs");
const work = mkdtempSync(join(tmpdir(), "cwh-watchdog-test-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

interface Outcome {
  code: number | null;
  out: string;
  hangBase: string;
  events: { dir: string; summary: { file: string; children: { command: string }[]; killed: boolean } }[];
  runDirs: string[];
  ms: number;
}

let n = 0;
/** Run one fixture test file under the real setup files, with a T of `tMs`, a grace of 1 s and a test timeout of `testTimeoutMs`. */
function runFixture(body: string, opts: { tMs?: number; testTimeoutMs?: number; env?: Record<string, string> } = {}): Promise<Outcome> {
  const dir = join(work, `case-${++n}`);
  mkdirSync(dir);
  const file = join(dir, "fixture.test.ts");
  writeFileSync(file, body);
  // No import from "vitest/config": this file lives outside the repo, where that cannot resolve.
  writeFileSync(
    join(dir, "vitest.config.mjs"),
    `export default ${JSON.stringify({
      test: {
        root: dir,
        include: ["fixture.test.ts"],
        setupFiles: [config.test!.setupFiles!].flat().map((f) => join(REPO, f)),
        globalSetup: [join(REPO, "test/setup/hang-dir.ts")],
        testTimeout: opts.testTimeoutMs ?? 500,
      },
    })};\n`,
  );
  const hangBase = join(dir, "hangs");
  const env: Record<string, string | undefined> = {
    ...process.env,
    COWORK_TEST_HANG_DIR: hangBase,
    COWORK_TEST_HANG_T_MS: String(opts.tMs ?? 1500),
    COWORK_TEST_HANG_GRACE_MS: "1000",
    ...opts.env,
  };
  delete env.COWORK_TEST_HANG_RUN_DIR;
  const t0 = Date.now();
  return new Promise((done, fail) => {
    // Async on purpose: this test's own heartbeat keeps running while the fixture is stuck.
    const child = spawn(process.execPath, [VITEST, "run", "--config", join(dir, "vitest.config.mjs")], {
      cwd: dir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    // gdb attaches (Linux CI) can take tens of seconds per process; this only bounds a broken watchdog.
    const guard = setTimeout(() => child.kill("SIGKILL"), 150_000);
    child.on("error", fail);
    child.on("close", (code) => {
      clearTimeout(guard);
      const runDirs = existsSync(hangBase) ? readdirSync(hangBase) : [];
      const events = runDirs.flatMap((r) =>
        readdirSync(join(hangBase, r)).map((e) => ({
          dir: join(hangBase, r, e),
          summary: JSON.parse(readFileSync(join(hangBase, r, e, "summary.json"), "utf8")),
        })),
      );
      done({ code, out, hangBase, events, runDirs, ms: Date.now() - t0 });
    });
  });
}

const IMPORTS = `import { spawnSync } from "node:child_process";\nimport { beforeAll, expect, it } from "vitest";\n`;

describe("the sync-child watchdog", () => {
  it("is the first setup file, and the run has its dump directory and backstop", () => {
    // First, so every later module that binds spawnSync/execFileSync/execSync binds the wrapped ones.
    expect(config.test?.setupFiles?.[0]).toBe("test/setup/sync-child-watchdog.ts");
    expect(config.test?.globalSetup).toContain("test/setup/hang-dir.ts");
  });

  it("kills a hung sync child, dumps its stacks, fails the test that hung, and fails the run", async () => {
    const r = await runFixture(
      `${IMPORTS}it("hangs", () => { const s = spawnSync("sh", ["-c", "sleep 600"]); expect(s.signal).toBe("SIGKILL"); });\nit("runs after", () => { expect(1).toBe(1); });\n`,
    );
    expect(r.code, r.out).not.toBe(0);
    expect(r.out).toMatch(/this test blocked its process past the sync-child watchdog's limit: .*sleep 600/);
    expect(r.out).toMatch(/1 failed \| 1 passed/);
    expect(r.events).toHaveLength(1);
    const ev = r.events[0]!;
    expect(ev.summary.file).toMatch(/fixture\.test\.ts$/);
    expect(ev.summary.killed).toBe(true);
    expect(ev.summary.children.map((c) => c.command)).toContain("sleep 600");
    // The watchdog's own diagnostic processes are not reported as the hung child.
    expect(ev.summary.children.map((c) => c.command).join("\n")).not.toMatch(/^ps |\/sample /m);
    const stacks = readdirSync(ev.dir).filter((f) => f.startsWith("stacks-"));
    expect(stacks.length).toBeGreaterThanOrEqual(2); // the child and the fork itself
    const forkStacks = readFileSync(
      join(
        ev.dir,
        stacks.find((f) => f.endsWith("-fork.txt"))!,
      ),
      "utf8",
    );
    if (process.platform === "darwin") expect(forkStacks).toMatch(/Call graph/);
    // Where gdb can attach (CI installs it; GitHub's runner user has passwordless sudo), the dump has real backtraces.
    // gdb exits 0 even when it cannot attach, so this checks for frames, not the exit code.
    if (process.platform === "linux" && existsSync("/usr/bin/gdb") && process.env.CI) expect(forkStacks).toMatch(/^Thread \d+ \(/m);
    // Well before the 600 s the child would have taken.
    expect(r.ms).toBeLessThan(150_000);
  }, 180_000);

  it("leaves a call that declares its own timeout alone, so that timeout fires first", async () => {
    // In a hook, so no test floor applies: the limit is T (1.5 s) unless the call declares more. The call declares
    // 3 s. Only the wrapped spawnSync tells the watchdog about the 3 s; unwrapped, it would kill the child at ~1.5 s
    // and record an event.
    const r = await runFixture(
      `${IMPORTS}let code: string | undefined;\nbeforeAll(() => { code = (spawnSync("sleep", ["60"], { timeout: 3000 }).error as NodeJS.ErrnoException)?.code; }, 20_000);\nit("timed out on its own", () => { expect(code).toBe("ETIMEDOUT"); });\n`,
    );
    expect(r.code, r.out).toBe(0);
    expect(r.events).toEqual([]);
  }, 180_000);

  it("leaves a clean run green and removes its dump directory", async () => {
    const r = await runFixture(`${IMPORTS}it("quick child", () => { expect(spawnSync("true").status).toBe(0); });\n`);
    expect(r.code, r.out).toBe(0);
    expect(r.runDirs).toEqual([]);
  }, 180_000);

  it("reports a test whose own thread is blocked with no child, and kills nothing", async () => {
    const r = await runFixture(`${IMPORTS}it("spins", () => { const end = Date.now() + 4000; while (Date.now() < end); });\n`);
    expect(r.code, r.out).not.toBe(0);
    expect(r.out).toMatch(/no child process: this test's own thread was blocked/);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]!.summary.killed).toBe(false);
    expect(r.events[0]!.summary.children).toEqual([]);
  }, 180_000);

  it("fails the run for a hang in a hook, where no test fails", async () => {
    const r = await runFixture(
      `${IMPORTS}beforeAll(() => { spawnSync("sh", ["-c", "sleep 600"]); }, 60_000);\nit("passes", () => { expect(1).toBe(1); });\n`,
    );
    expect(r.code, r.out).not.toBe(0);
    expect(r.out).toMatch(/1 passed/);
    expect(r.out).not.toMatch(/Tests\s+\d+ failed/);
    expect(r.out).toMatch(/a test process was blocked past the sync-child watchdog's limit/);
    expect(r.events).toHaveLength(1);
    // Named by the file even though no test was running.
    expect(r.events[0]!.summary.file).toMatch(/fixture\.test\.ts$/);
  }, 180_000);

  it("does nothing when turned off", async () => {
    const r = await runFixture(`${IMPORTS}it("spins", () => { const end = Date.now() + 4000; while (Date.now() < end); });\n`, {
      env: { COWORK_TEST_WATCHDOG: "0" },
      testTimeoutMs: 10_000,
    });
    expect(r.code, r.out).toBe(0);
    expect(r.events).toEqual([]);
  }, 180_000);
});
