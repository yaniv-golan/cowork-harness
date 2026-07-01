import { describe, it, expect } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

function run(args: string[]) {
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

// `updatedAt` MUST be computed at test-run time, not a hardcoded past string — with staleness detection
// in place (see the "STALE" tests below), a fixed-in-the-past `updatedAt` would itself read as stale by
// the time these tests actually run, silently flipping the "fresh running" tests' expected exit code
// from 0 to 1. Call `runningStatus()` fresh in each test that wants a NON-stale fixture.
function runningStatus() {
  return {
    schemaVersion: 1,
    state: "running",
    pid: 999,
    scenario: "demo",
    fidelity: "container",
    sessionId: "local_x",
    startedAt: new Date(Date.now() - 5000).toISOString(),
    updatedAt: new Date().toISOString(),
    elapsedMs: 5000,
    toolCounts: { Read: 3, Bash: 1 },
    subagentCount: 0,
  };
}
const RUNNING_STATUS = runningStatus(); // base template for tests that don't care about freshness (state:"error" overrides, or updatedAt overrides for the stale tests)

function fixtureDir(status: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "cwh-status-cli-"));
  writeFileSync(join(dir, "status.json"), JSON.stringify(status));
  return dir;
}

describe.skipIf(!can)("cowork-harness status", () => {
  it("--help prints usage and exits 0", () => {
    const { code, stderr } = run(["status", "--help"]);
    expect(code).toBe(0);
    expect(stderr).toMatch(/usage: status/);
  });

  it("prints a one-line human summary for a running status and exits 0", () => {
    // fresh runningStatus() each call — NOT the module-level RUNNING_STATUS constant — so this can never
    // flake from staleness even if the suite is slow (e.g. under CI load) by the time this test runs.
    const dir = fixtureDir(runningStatus());
    const { code, stdout, stderr } = run(["status", dir]);
    expect(code).toBe(0);
    const text = stdout + stderr;
    expect(text).toContain("running");
    expect(text).toContain("demo");
    expect(text).toContain("4 tools"); // 3 Read + 1 Bash
  });

  it("--output-format json emits the full RunStatus fields, exit 0 for done/success", () => {
    const dir = fixtureDir({ ...runningStatus(), state: "done", result: "success", durationMs: 12345 });
    const { code, stdout } = run(["status", dir, "--output-format", "json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toMatchObject({
      tool: "cowork-harness",
      command: "status",
      ok: true,
      stale: false,
      state: "done",
      result: "success",
      durationMs: 12345,
    });
  });

  it("exits 1 (not 0) for state:error", () => {
    const dir = fixtureDir({ ...RUNNING_STATUS, state: "error", result: "error", durationMs: 10 });
    const { code, stdout } = run(["status", dir, "--output-format", "json"]);
    expect(code).toBe(1);
    expect(JSON.parse(stdout).ok).toBe(false);
  });

  it("fails loud (exit 1, not a silent empty pass) when status.json doesn't exist yet", () => {
    const dir = mkdtempSync(join(tmpdir(), "cwh-status-cli-empty-"));
    const { code, stderr } = run(["status", dir]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/no status\.json/);
  });

  it("one-shot status on a MALFORMED status.json fails clean (exit 1, a message) — not a raw stack trace", () => {
    const dir = mkdtempSync(join(tmpdir(), "cwh-status-cli-corrupt-"));
    writeFileSync(join(dir, "status.json"), "{ this is not json");
    const { code, stderr } = run(["status", dir]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/unreadable|malformed/);
  });

  it("--follow on a dir with no status.json ever fails loud within the configured timeout (not a silent hang)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cwh-status-cli-nofile-"));
    // pollMs isn't CLI-exposed, so also shrink it via env — the deadline is only checked ON a poll tick,
    // so leaving pollMs at its 1000ms default would make this test take ~1s despite a 50ms timeout.
    const r = spawnSync("node", [CLI, "status", dir, "--follow"], {
      encoding: "utf8",
      env: { ...process.env, COWORK_HARNESS_STATUS_FIRST_SEEN_TIMEOUT_MS: "50", COWORK_HARNESS_STATUS_POLL_MS: "5" },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no status\.json/);
  });

  it("--follow on a dir with a STALE running status fails loud (exit 3, distinct from exit 1) instead of polling forever", () => {
    const dir = fixtureDir({ ...RUNNING_STATUS, updatedAt: new Date(0).toISOString() }); // epoch — always stale
    const r = spawnSync("node", [CLI, "status", dir, "--follow"], {
      encoding: "utf8",
      env: { ...process.env, COWORK_HARNESS_STATUS_POLL_MS: "5", COWORK_HARNESS_STATUS_STALE_MS: "1" },
    });
    expect(r.status).toBe(3); // distinct from exit 1 (a genuine state:"error") and exit 1 (dir never had status.json)
    expect(r.stderr).toMatch(/stopped updating/);
  });

  it("one-shot status on a STALE running status reports it as probably-dead and exits 3", () => {
    const dir = fixtureDir({ ...RUNNING_STATUS, updatedAt: new Date(0).toISOString() });
    const r = spawnSync("node", [CLI, "status", dir], { encoding: "utf8", env: { ...process.env, COWORK_HARNESS_STATUS_STALE_MS: "1" } });
    expect(r.status).toBe(3);
    const text = r.stdout + r.stderr;
    expect(text).toMatch(/stale|probably-dead/i);
  });

  it("one-shot status --output-format json on a STALE running status sets stale:true, ok:false, exits 3", () => {
    const dir = fixtureDir({ ...RUNNING_STATUS, updatedAt: new Date(0).toISOString() });
    const r = spawnSync("node", [CLI, "status", dir, "--output-format", "json"], {
      encoding: "utf8",
      env: { ...process.env, COWORK_HARNESS_STATUS_STALE_MS: "1" },
    });
    expect(r.status).toBe(3);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.stale).toBe(true);
    expect(parsed.ok).toBe(false);
  });

  it("usage error (exit 2) with no positional argument", () => {
    const { code } = run(["status"]);
    expect(code).toBe(2);
  });

  it("exits 2 for a genuinely unresolvable path (no such file/dir, and not a resolvable run-id fragment)", () => {
    const { code } = run(["status", "/some/genuinely/nonexistent/path-cwh-status-test"]);
    expect(code).toBe(2);
  });

  it('--follow reports the run\'s REAL terminal state: exits 1 (not 0) when the run ends in state:"error"', async () => {
    // Regression test: followRunStatus only distinguishes "still running" from "reached a terminal
    // state" — it does NOT distinguish done from error. Before the fix, cmdStatus's --follow branch
    // unconditionally exited 0 on resolve, so an errored run would falsely report success. Spawn a LIVE
    // child (spawnSync can't observe a mutation made mid-run) against a "running" fixture, let it observe
    // the initial line, then flip the fixture to state:"error" out from under it and confirm the exit
    // code + emitted line reflect the real terminal state.
    const dir = fixtureDir(runningStatus());
    const child = spawn("node", [CLI, "status", dir, "--follow"], {
      env: { ...process.env, COWORK_HARNESS_STATUS_POLL_MS: "5" }, // fast polling — don't wait out the 1000ms default
    });
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));

    // give the child a moment to tick at least once and observe the initial "running" status line.
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(join(dir, "status.json"), JSON.stringify({ ...runningStatus(), state: "error", result: "error", durationMs: 42 }));

    const code = await new Promise<number | null>((resolveExit) => child.on("exit", resolveExit));
    expect(code).toBe(1); // not 0 — the run actually errored
    expect(stdout).toContain('"state":"error"');
  });
});
