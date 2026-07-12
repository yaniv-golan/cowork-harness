import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findLatestRunForScenario } from "../src/run/latest-run.js";

// Unit coverage for the pure resolution logic: the CLI-level wiring (`status --latest-for`) is
// covered in test/cli-status-latest-for.test.ts. This file exercises `findLatestRunForScenario` directly
// against a synthetic runs tree — no CLI spawn needed.

function runsRoot() {
  return mkdtempSync(join(tmpdir(), "latest-run-"));
}

function seedRun(
  root: string,
  slug: string,
  runId: string,
  opts: { originCreatedAt?: string; resultJson?: Record<string, unknown>; statusStartedAt?: string } = {},
) {
  const dir = join(root, slug, runId);
  mkdirSync(dir, { recursive: true });
  if (opts.originCreatedAt) {
    writeFileSync(join(dir, ".origin"), JSON.stringify({ originKey: "k", sourceHint: "h", createdAt: opts.originCreatedAt }));
  }
  if (opts.resultJson) {
    writeFileSync(join(dir, "result.json"), JSON.stringify(opts.resultJson));
  }
  if (opts.statusStartedAt) {
    writeFileSync(join(dir, "status.json"), JSON.stringify({ schemaVersion: 1, state: "done", startedAt: opts.statusStartedAt }));
  }
  return dir;
}

describe("findLatestRunForScenario", () => {
  it("picks the run with the newest `.origin` createdAt — NOT bare directory mtime", () => {
    const root = runsRoot();
    // Create the OLDER-createdAt run dir SECOND (so its directory mtime is naturally the NEWEST) — this
    // is the discriminating setup: a bare `ls -td` (mtime ordering) would wrongly pick this one.
    const newer = seedRun(root, "my-scenario", "sess-newer", {
      originCreatedAt: "2026-07-10T00:00:00.000Z",
      resultJson: { scenario: "my-scenario", outDir: join(root, "my-scenario", "sess-newer") },
    });
    const older = seedRun(root, "my-scenario", "sess-older", {
      originCreatedAt: "2026-07-01T00:00:00.000Z",
      resultJson: { scenario: "my-scenario", outDir: join(root, "my-scenario", "sess-older") },
    });
    // Force the OLDER-createdAt dir's mtime to be strictly newer than the NEWER-createdAt dir's mtime —
    // proves the resolver isn't secretly falling back to filesystem mtime ordering.
    const future = new Date(Date.now() + 3600_000);
    utimesSync(older, future, future);
    expect(statSync(older).mtimeMs).toBeGreaterThan(statSync(newer).mtimeMs);

    const result = findLatestRunForScenario(root, "my-scenario");
    expect(result?.outDir).toBe(newer);
    expect(result?.createdAt).toBe("2026-07-10T00:00:00.000Z");
  });

  it("falls back to result.json mtime when no `.origin` marker exists (ephemeral local_* runs)", () => {
    const root = runsRoot();
    const dir1 = seedRun(root, "s", "local_1", { resultJson: { scenario: "s" } });
    // ensure a distinguishable mtime ordering between the two result.json writes
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(dir1, "result.json"), past, past);
    const dir2 = seedRun(root, "s", "local_2", { resultJson: { scenario: "s" } });

    const result = findLatestRunForScenario(root, "s");
    expect(result?.outDir).toBe(dir2);
  });

  it("falls back to status.json startedAt when neither `.origin` nor result.json exist", () => {
    const root = runsRoot();
    seedRun(root, "s", "local_1", { statusStartedAt: "2026-07-01T00:00:00.000Z" });
    const dir2 = seedRun(root, "s", "local_2", { statusStartedAt: "2026-07-05T00:00:00.000Z" });

    const result = findLatestRunForScenario(root, "s");
    expect(result?.outDir).toBe(dir2);
  });

  it("skips a run dir with no usable recency signal at all", () => {
    const root = runsRoot();
    mkdirSync(join(root, "s", "empty-dir"), { recursive: true }); // no .origin, no result.json, no status.json
    const dir2 = seedRun(root, "s", "local_2", { resultJson: { scenario: "s" } });

    const result = findLatestRunForScenario(root, "s");
    expect(result?.outDir).toBe(dir2);
  });

  it("resolves a scenario name via slugForPath even when the on-disk slug differs cosmetically", () => {
    const root = runsRoot();
    // slugForPath("My Scenario!") — spaces/punctuation pass through unchanged (only path separators and
    // leading dots/dashes are stripped), so the slug dir name equals the raw name here; assert the
    // resolver still finds it via the slugified path, not a literal string match.
    const dir = seedRun(root, "My Scenario!", "local_1", { resultJson: { scenario: "My Scenario!" } });
    const result = findLatestRunForScenario(root, "My Scenario!");
    expect(result?.outDir).toBe(dir);
  });

  it("returns undefined when the scenario has no run dir at all", () => {
    const root = runsRoot();
    expect(findLatestRunForScenario(root, "nonexistent")).toBeUndefined();
  });

  it("returns undefined when the scenario dir exists but is empty", () => {
    const root = runsRoot();
    mkdirSync(join(root, "s"), { recursive: true });
    expect(findLatestRunForScenario(root, "s")).toBeUndefined();
  });

  it("opportunistically surfaces the persisted verdict when result.json carries one, omits it otherwise", () => {
    const root = runsRoot();
    seedRun(root, "s", "local_1", {
      originCreatedAt: "2026-07-01T00:00:00.000Z",
      resultJson: { scenario: "s", verdict: { pass: true, exitCode: 0, failures: [] } },
    });
    const withVerdict = findLatestRunForScenario(root, "s");
    expect(withVerdict?.verdict).toEqual({ pass: true, exitCode: 0, failures: [] });

    const root2 = runsRoot();
    seedRun(root2, "t", "local_1", { originCreatedAt: "2026-07-01T00:00:00.000Z", resultJson: { scenario: "t" } });
    const withoutVerdict = findLatestRunForScenario(root2, "t");
    expect(withoutVerdict?.verdict).toBeUndefined();
  });

  it("prefers result.json's own `scenario` field over the caller-supplied arg (name vs slug mismatch)", () => {
    const root = runsRoot();
    seedRun(root, "sluggy-name", "local_1", {
      originCreatedAt: "2026-07-01T00:00:00.000Z",
      resultJson: { scenario: "Sluggy Name (display)" },
    });
    const result = findLatestRunForScenario(root, "sluggy-name");
    expect(result?.scenario).toBe("Sluggy Name (display)");
  });
});
