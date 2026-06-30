import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBaseline } from "../src/baseline.js";
import { loadSession, buildLaunchPlan } from "../src/session.js";
import { gitStageStats, GITSET_ENV } from "../src/run/skill-files.js";
import { BoundaryError } from "../src/errors.js";

// A plugin source that is inside a git work tree delivers only its git-TRACKED files. An ALL-untracked
// source would mount EMPTY and the skill would not load — that must HARD-FAIL (BoundaryError), not stage
// silently. A partially-tracked source stages, but emits a loud notice. A non-repo dir copies raw (no
// guard). Resume re-stages nothing, so the guard must not fire.

const baseline = loadBaseline("desktop-1.14271.0");

/** A temp git repo holding one plugin dir. `track`: "none" | "all" | "partial". */
function gitPlugin(track: "none" | "all" | "partial"): string {
  const dir = mkdtempSync(join(tmpdir(), "f1-"));
  const git = (...a: string[]) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@t.test");
  git("config", "user.name", "t");
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "demo", version: "0.1.0" }));
  mkdirSync(join(dir, "skills", "demo"), { recursive: true });
  writeFileSync(join(dir, "skills", "demo", "SKILL.md"), "# demo\n");
  if (track === "all") {
    git("add", "-A");
    git("commit", "-q", "-m", "init");
  } else if (track === "partial") {
    // commit only plugin.json; leave SKILL.md untracked
    git("add", ".claude-plugin/plugin.json");
    git("commit", "-q", "-m", "partial");
  } // "none" → nothing added
  return dir;
}

const out = () => mkdtempSync(join(tmpdir(), "f1-out-"));
const planFor = (pluginDir: string, resume = false) =>
  buildLaunchPlan(loadSession({ plugins: { local_plugins: [pluginDir] } }), baseline, out(), "container", resume);

afterEach(() => {
  delete process.env[GITSET_ENV];
  vi.restoreAllMocks();
});

describe("gitStageStats", () => {
  it("counts tracked + untracked; null tracked for a non-repo dir", () => {
    expect(gitStageStats(gitPlugin("all")).tracked!.size).toBeGreaterThan(0);
    const none = gitStageStats(gitPlugin("none"));
    expect(none.tracked!.size).toBe(0);
    expect(none.untracked).toBeGreaterThan(0);
    const partial = gitStageStats(gitPlugin("partial"));
    expect(partial.tracked!.size).toBe(1); // plugin.json only
    expect(partial.untracked).toBeGreaterThan(0); // SKILL.md
    expect(gitStageStats(mkdtempSync(join(tmpdir(), "f1-norepo-"))).tracked).toBeNull();
  });
});

describe("buildLaunchPlan empty-mount guard", () => {
  it("HARD-FAILS (BoundaryError) when a plugin would mount empty (all untracked)", () => {
    expect(() => planFor(gitPlugin("none"))).toThrow(BoundaryError);
    expect(() => planFor(gitPlugin("none"))).toThrow(/0 git-tracked files|mount EMPTY/);
  });

  it("does NOT fail when the plugin is git-tracked", () => {
    expect(() => planFor(gitPlugin("all"))).not.toThrow();
  });

  it("does NOT fail for a plugin dir outside any git repo (raw copy)", () => {
    const plain = mkdtempSync(join(tmpdir(), "f1-plain-"));
    mkdirSync(join(plain, ".claude-plugin"), { recursive: true });
    writeFileSync(join(plain, ".claude-plugin", "plugin.json"), "{}");
    expect(() => planFor(plain)).not.toThrow();
  });

  it("does NOT fail on resume even when all-untracked (resume re-stages nothing)", () => {
    expect(() => planFor(gitPlugin("none"), /* resume */ true)).not.toThrow();
  });

  it("partial tracking: stages (no throw) but emits a loud ::notice:: about excluded files", () => {
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(() => planFor(gitPlugin("partial"))).not.toThrow();
    const out = spy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toMatch(/::notice:: \[stage\].*untracked file\(s\) excluded/);
  });

  it("opt-out COWORK_HARNESS_GITSET=0 → raw copy, no guard (all-untracked does not fail)", () => {
    process.env[GITSET_ENV] = "0";
    expect(() => planFor(gitPlugin("none"))).not.toThrow();
  });
});
