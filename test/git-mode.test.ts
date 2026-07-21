import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitTrackedSet, gitCpFilter, GITSET_ENV } from "../src/run/skill-files.js";
import { hashSkillDirs, skillHashEntries } from "../src/run/skill-hash.js";

// git-tracked file-set mode (COWORK_HARNESS_GITSET=1). A repo with a tracked file + an untracked
// file + OS-junk; the tracked set is the durable boundary.

function gitRepo(): { dir: string; tracked: string } {
  const dir = mkdtempSync(join(tmpdir(), "gitmode-"));
  const run = (...a: string[]) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
  run("init", "-q");
  run("config", "user.email", "t@t.test");
  run("config", "user.name", "t");
  mkdirSync(join(dir, "skills", "cap-table"), { recursive: true });
  const tracked = join(dir, "skills", "cap-table", "SKILL.md");
  writeFileSync(tracked, "# tracked skill\n");
  run("add", "skills/cap-table/SKILL.md");
  run("commit", "-q", "-m", "init");
  // now add untracked noise
  writeFileSync(join(dir, "skills", "cap-table", "scratch.tmp"), "untracked\n");
  writeFileSync(join(dir, ".DS_Store"), "\x00junk");
  return { dir, tracked };
}

const withGit = (fn: () => void) => {
  const prev = process.env[GITSET_ENV];
  process.env[GITSET_ENV] = "1";
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[GITSET_ENV];
    else process.env[GITSET_ENV] = prev;
  }
};

afterEach(() => {
  delete process.env[GITSET_ENV];
});

describe("gitTrackedSet / gitCpFilter", () => {
  it("lists only tracked files (untracked + OS-junk excluded); null for a non-repo dir", () => {
    const { dir } = gitRepo();
    const set = gitTrackedSet(dir)!;
    expect(set.has("skills/cap-table/SKILL.md")).toBe(true);
    expect(set.has("skills/cap-table/scratch.tmp")).toBe(false); // untracked
    expect(set.has(".DS_Store")).toBe(false);
    // a plain temp dir (not a repo) → null → caller falls back to raw
    expect(gitTrackedSet(mkdtempSync(join(tmpdir(), "norepo-")))).toBeNull();
  });

  it("throws (not silent raw-fallback) when in a repo but the index is corrupt — ls-files fails (#34)", () => {
    withGit(() => {
      const { dir } = gitRepo();
      // Corrupt the index: rev-parse --show-toplevel still succeeds (doesn't read the index), but
      // ls-files fails — the "in a repo, can't list tracked set" case that must fail loud, not raw-fallback.
      writeFileSync(join(dir, ".git", "index"), "\x00not a valid git index\x00");
      expect(() => gitTrackedSet(dir)).toThrow(/ls-files failed|cannot be computed/);
    });
  });

  // A git hook exports GIT_DIR (and GIT_INDEX_FILE) into every child process. With GIT_DIR set and no
  // GIT_WORK_TREE, git stops inferring the work tree from cwd and treats cwd AS the root — so
  // `rev-parse --show-toplevel` succeeds (the non-repo fallback never fires) while `ls-files -- .`
  // returns the WHOLE index as root-relative paths instead of the dir-relative ones. The tracked set
  // then silently describes the wrong files: every real skill file reads as removed. This set feeds
  // both skillHash and the mount-copy filter, so it must not depend on ambient git env.
  it("is immune to an inherited GIT_DIR (the env a git hook exports)", () => {
    const { dir } = gitRepo();
    const skillDir = join(dir, "skills", "cap-table");
    const prev = process.env.GIT_DIR;
    process.env.GIT_DIR = join(dir, ".git");
    try {
      const set = gitTrackedSet(skillDir)!;
      expect(set.has("SKILL.md")).toBe(true); // dir-relative, as when GIT_DIR is unset
      expect(set.has("skills/cap-table/SKILL.md")).toBe(false); // not the repo-root-relative index
    } finally {
      if (prev === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = prev;
    }
  });

  it("gitCpFilter admits tracked files + dirs-on-the-path, rejects untracked", () => {
    const { dir } = gitRepo();
    const f = gitCpFilter(dir)!;
    expect(f(dir, "")).toBe(true); // root
    expect(f(join(dir, "skills"), "")).toBe(true); // dir leading to a tracked file
    expect(f(join(dir, "skills", "cap-table", "SKILL.md"), "")).toBe(true); // tracked
    expect(f(join(dir, "skills", "cap-table", "scratch.tmp"), "")).toBe(false); // untracked
    expect(f(join(dir, ".DS_Store"), "")).toBe(false); // untracked junk
  });
});

describe("hashSkillDirs in git mode", () => {
  it("hashes ONLY tracked files (an untracked change doesn't drift; a tracked change does)", () => {
    const { dir, tracked } = gitRepo();
    withGit(() => {
      const r = hashSkillDirs([dir]);
      expect(r.mode).toBe("git");
      expect(skillHashEntries([dir]).map((e) => e.path)).toEqual(["skills/cap-table/SKILL.md"]); // untracked + junk gone
      const before = hashSkillDirs([dir]).hash;
      // touch an UNTRACKED file → no drift
      writeFileSync(join(dir, "skills", "cap-table", "scratch.tmp"), "changed untracked\n");
      expect(hashSkillDirs([dir]).hash).toBe(before);
      // touch the TRACKED file → drift
      writeFileSync(tracked, "# tracked v2\n");
      expect(hashSkillDirs([dir]).hash).not.toBe(before);
    });
  });

  it("mode is 'raw' for a non-repo dir even with the flag on (fail-safe fallback)", () => {
    const plain = mkdtempSync(join(tmpdir(), "plain-"));
    mkdirSync(join(plain, "skills"), { recursive: true });
    writeFileSync(join(plain, "skills", "SKILL.md"), "x\n");
    withGit(() => {
      expect(hashSkillDirs([plain]).mode).toBe("raw"); // not a repo → raw, never throws
    });
  });

  it("git mode is ON by DEFAULT (v6) — a repo dir hashes tracked-only with no flag set", () => {
    const { dir } = gitRepo();
    delete process.env[GITSET_ENV]; // no flag → default git mode
    const r = hashSkillDirs([dir]);
    expect(r.mode).toBe("git");
    expect(skillHashEntries([dir]).map((e) => e.path)).toEqual(["skills/cap-table/SKILL.md"]);
  });

  it("OPT-OUT with COWORK_HARNESS_GITSET=0 → raw walk (untracked files ARE hashed)", () => {
    const { dir } = gitRepo();
    const prev = process.env[GITSET_ENV];
    process.env[GITSET_ENV] = "0";
    try {
      const r = hashSkillDirs([dir]);
      expect(r.mode).toBe("raw");
      expect(skillHashEntries([dir]).map((e) => e.path)).toContain("skills/cap-table/scratch.tmp"); // untracked hashed in raw
    } finally {
      if (prev === undefined) delete process.env[GITSET_ENV];
      else process.env[GITSET_ENV] = prev;
    }
  });
});
