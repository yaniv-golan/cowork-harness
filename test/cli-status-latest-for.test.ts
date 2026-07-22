import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, utimesSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

// CLI-level coverage for `status --latest-for <scenario>`: arg wiring, exit codes, text/json shape,
// the no-runs case. The pure recency-resolution logic (createdAt-vs-mtime discrimination, the fallback
// chain) is unit-tested directly in test/latest-run.test.ts; this covers command wiring only.
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

function runsRoot() {
  return mkdtempSync(join(tmpdir(), "cli-latest-for-"));
}

function seedRun(root: string, slug: string, runId: string, opts: { originCreatedAt?: string; resultJson?: Record<string, unknown> } = {}) {
  const dir = join(root, slug, runId);
  mkdirSync(dir, { recursive: true });
  if (opts.originCreatedAt) {
    writeFileSync(join(dir, ".origin"), JSON.stringify({ originKey: "k", sourceHint: "h", createdAt: opts.originCreatedAt }));
  }
  if (opts.resultJson) {
    // turns/1/result.json — the single addressable shape; findLatestRunForScenario/readResultJson go
    // through the seam, so a root result.json (no compat copy exists anymore) wouldn't be found at all.
    const turn1 = join(dir, "turns", "1");
    mkdirSync(turn1, { recursive: true });
    writeFileSync(join(turn1, "result.json"), JSON.stringify(opts.resultJson));
  }
  return dir;
}

function run(args: string[], root: string) {
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8", env: { ...process.env, COWORK_HARNESS_RUNS_DIR: root } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, out: r.stdout + r.stderr };
}

describe.skipIf(!can)("cowork-harness status --latest-for", () => {
  it("resolves the newest run by `.origin` createdAt — the discriminating case: newest createdAt has an OLDER dir mtime, so a bare `ls -td` would pick wrong", () => {
    const root = runsRoot();
    // The OLDER-createdAt dir is created SECOND (so it naturally gets the NEWER directory mtime) — this
    // is the fail-on-break setup: reverting the resolver to mtime ordering flips this test.
    const newer = seedRun(root, "my-scenario", "sess-newer", {
      originCreatedAt: "2026-07-10T00:00:00.000Z",
      resultJson: { scenario: "my-scenario" },
    });
    const older = seedRun(root, "my-scenario", "sess-older", {
      originCreatedAt: "2026-07-01T00:00:00.000Z",
      resultJson: { scenario: "my-scenario" },
    });
    const future = new Date(Date.now() + 3600_000);
    utimesSync(older, future, future);
    expect(statSync(older).mtimeMs).toBeGreaterThan(statSync(newer).mtimeMs);

    const r = run(["status", "--latest-for", "my-scenario"], root);
    expect(r.code).toBe(0);
    expect(r.out).toContain(newer);
    expect(r.out).not.toContain(older);
  });

  it("--output-format json emits {scenario, outDir, createdAt}, verdict omitted when absent", () => {
    const root = runsRoot();
    const dir = seedRun(root, "s", "local_1", { originCreatedAt: "2026-07-01T00:00:00.000Z", resultJson: { scenario: "s" } });
    const r = run(["status", "--latest-for", "s", "--output-format", "json"], root);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed).toMatchObject({
      tool: "cowork-harness",
      command: "status",
      ok: true,
      scenario: "s",
      outDir: dir,
      createdAt: "2026-07-01T00:00:00.000Z",
    });
    expect(parsed.verdict).toBeUndefined();
  });

  it("--output-format json surfaces the persisted verdict when result.json carries one", () => {
    const root = runsRoot();
    seedRun(root, "s", "local_1", {
      originCreatedAt: "2026-07-01T00:00:00.000Z",
      resultJson: { scenario: "s", verdict: { pass: false, exitCode: 1, failures: [{ message: "boom" }] } },
    });
    const r = run(["status", "--latest-for", "s", "--output-format", "json"], root);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.verdict).toEqual({ pass: false, exitCode: 1, failures: [{ message: "boom" }] });
  });

  it("no runs for the scenario: clear message, exit 2 (not a crash)", () => {
    const root = runsRoot();
    const r = run(["status", "--latest-for", "nonexistent-scenario"], root);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/no runs found/);
    expect(r.stderr).toContain("nonexistent-scenario");
  });

  it("no runs for the scenario, json mode: clean error envelope, exit 2", () => {
    const root = runsRoot();
    const r = run(["status", "--latest-for", "nonexistent-scenario", "--output-format", "json"], root);
    expect(r.code).toBe(2);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.message).toMatch(/no runs found/);
  });

  it("rejects --latest-for combined with a positional <run-id | run-dir>", () => {
    const root = runsRoot();
    seedRun(root, "s", "local_1", { originCreatedAt: "2026-07-01T00:00:00.000Z", resultJson: { scenario: "s" } });
    const r = run(["status", "--latest-for", "s", "/some/dir"], root);
    expect(r.code).toBe(2);
  });

  it("rejects --latest-for combined with --follow", () => {
    const root = runsRoot();
    seedRun(root, "s", "local_1", { originCreatedAt: "2026-07-01T00:00:00.000Z", resultJson: { scenario: "s" } });
    const r = run(["status", "--latest-for", "s", "--follow"], root);
    expect(r.code).toBe(2);
  });

  it("`status --help` documents --latest-for", () => {
    const r = run(["status", "--help"], runsRoot());
    expect(r.code).toBe(0);
    expect(r.out).toContain("--latest-for");
  });
});
