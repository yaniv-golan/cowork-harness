import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFingerprint, skillCommit } from "../src/run/cassette.js";
import { loadSession, resolveSessionPaths } from "../src/session.js";

/** The `skill` lane mounts its skill via an in-memory session object and passes the sentinel
 *  string "(inline)" as the session PATH — so the fingerprint had no file to read and emitted no
 *  skillHash. These cover threading the already-resolved session object through instead. */
function inlineSessionWithSkill(): { session: ReturnType<typeof loadSession>; root: string; skillFile: string } {
  const root = mkdtempSync(join(tmpdir(), "cwh-inline-fp-"));
  const skillDir = join(root, "myskill");
  mkdirSync(skillDir, { recursive: true });
  const skillFile = join(skillDir, "SKILL.md");
  writeFileSync(skillFile, "# myskill\noriginal content\n");
  const session = resolveSessionPaths(loadSession({ skills: { local: ["./myskill"] } }), root);
  return { session, root, skillFile };
}

describe("buildFingerprint on an inline session (the `skill` lane)", () => {
  it("computes a skillHash from the resolved inline session object", () => {
    const { session } = inlineSessionWithSkill();
    const fp = buildFingerprint("(inline)", "1.0.0", undefined, undefined, undefined, session);
    expect(fp.skillHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes the skillHash when a mounted skill file's content changes", () => {
    const { session, skillFile } = inlineSessionWithSkill();
    const before = buildFingerprint("(inline)", "1.0.0", undefined, undefined, undefined, session).skillHash;
    writeFileSync(skillFile, "# myskill\nEDITED\n");
    const after = buildFingerprint("(inline)", "1.0.0", undefined, undefined, undefined, session).skillHash;
    expect(before).toBeDefined();
    expect(after).not.toBe(before);
  });

  it("still emits no skillHash for an inline session that mounts nothing", () => {
    // A session-less scenario mounts no skill dirs — there is nothing to hash, so the early
    // return still applies. Threading the object must not invent a hash from absent inputs.
    const session = resolveSessionPaths(loadSession({}), mkdtempSync(join(tmpdir(), "cwh-inline-empty-")));
    const fp = buildFingerprint("(inline)", "1.0.0", undefined, undefined, undefined, session);
    expect(fp.skillHash).toBeUndefined();
  });

  it("emits no skillHash when no inline session is supplied (unchanged behaviour)", () => {
    const fp = buildFingerprint("(inline)", "1.0.0");
    expect(fp.skillHash).toBeUndefined();
  });
});

describe("skillCommit on an inline session", () => {
  it("returns null for an inline session whose skill dirs are not in a git repo", () => {
    const { session } = inlineSessionWithSkill();
    expect(skillCommit("(inline)", session)).toBeNull();
  });

  // `git -C <dir>` sets the working directory, but an ambient GIT_DIR OVERRIDES it — so under the env a
  // git hook exports, every skill dir resolves to the same foreign repo: the recorded provenance is that
  // repo's HEAD rather than the skill's, and dirs genuinely in different repos stop looking different.
  it("resolves the skill dir's own repo even when a foreign GIT_DIR is in the environment", () => {
    const mkRepo = (marker: string): { root: string; head: string } => {
      const root = mkdtempSync(join(tmpdir(), "cwh-skillcommit-"));
      const run = (...a: string[]) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
      run("init", "-q");
      run("config", "user.email", "t@t.test");
      run("config", "user.name", "t");
      mkdirSync(join(root, "myskill"), { recursive: true });
      writeFileSync(join(root, "myskill", "SKILL.md"), `# ${marker}\n`);
      run("add", "-A");
      run("commit", "-q", "-m", marker);
      return { root, head: run("rev-parse", "HEAD").stdout.trim() };
    };
    const skillRepo = mkRepo("the-skill");
    const foreign = mkRepo("unrelated");
    expect(skillRepo.head).not.toBe(foreign.head); // distinct fixtures, or the test proves nothing

    const session = resolveSessionPaths(loadSession({ skills: { local: ["./myskill"] } }), skillRepo.root);
    const prev = process.env.GIT_DIR;
    process.env.GIT_DIR = join(foreign.root, ".git");
    try {
      expect(skillCommit("(inline)", session)).toBe(skillRepo.head);
    } finally {
      if (prev === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = prev;
    }
  });

  it("resolves the git HEAD of an inline session's skill dirs when they are in a repo", () => {
    // This repo itself is the fixture: mount a tracked dir and expect its HEAD.
    const repoRoot = new URL("..", import.meta.url).pathname;
    const session = resolveSessionPaths(loadSession({ skills: { local: ["./src"] } }), repoRoot);
    expect(skillCommit("(inline)", session)).toMatch(/^[0-9a-f]{40}$/);
  });
});
