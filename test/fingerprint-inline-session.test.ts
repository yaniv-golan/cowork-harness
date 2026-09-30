import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFingerprint, skillCommit } from "../src/run/cassette.js";
import { applySessionOverrides, loadSession, resolveSessionPaths } from "../src/session.js";

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

/** A `--matrix` `skill_dirs` cell runs with a SUBSTITUTED session object while `scenario.session` still
 *  names the original FILE. The fingerprint must describe what was actually mounted — the substituted
 *  dir — not the file's own `local_plugins` entry, or every cell records the same (wrong) skillHash. */
describe("buildFingerprint on a file session with a substituted session object (matrix skill_dirs)", () => {
  function fixture(): { sessionFile: string; original: ReturnType<typeof loadSession>; substituted: ReturnType<typeof loadSession> } {
    const root = mkdtempSync(join(tmpdir(), "cwh-subst-fp-"));
    for (const [variant, body] of [
      ["orig", "original"],
      ["v2", "EDITED variant"],
    ] as const) {
      const skillDir = join(root, variant, "my-plugin", "skills", "s");
      mkdirSync(join(root, variant, "my-plugin", ".claude-plugin"), { recursive: true });
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(root, variant, "my-plugin", ".claude-plugin", "plugin.json"), `{"name":"my-plugin"}\n`);
      writeFileSync(join(skillDir, "SKILL.md"), `---\nname: s\ndescription: d\n---\n${body}\n`);
    }
    const sessionFile = join(root, "session.yaml");
    writeFileSync(sessionFile, "plugins:\n  local_plugins: [./orig/my-plugin]\n");
    const original = resolveSessionPaths(loadSession({ plugins: { local_plugins: ["./orig/my-plugin"] } }), root);
    const substituted = applySessionOverrides(original, {
      skillDirSubstitution: [original.plugins.local_plugins[0]!, join(root, "v2", "my-plugin")],
    });
    return { sessionFile, original, substituted };
  }

  it("hashes the SUBSTITUTED dir, not the dir the session file declares", () => {
    const { sessionFile, substituted } = fixture();
    const fileOnly = buildFingerprint(sessionFile, "1.0.0");
    const withSubst = buildFingerprint(sessionFile, "1.0.0", undefined, undefined, undefined, substituted);
    const inlineSubst = buildFingerprint("(inline)", "1.0.0", undefined, undefined, undefined, substituted);
    expect(fileOnly.skillHash).toMatch(/^[0-9a-f]{64}$/);
    expect(withSubst.skillHash).toBe(inlineSubst.skillHash);
    expect(withSubst.skillHash).not.toBe(fileOnly.skillHash);
    expect(withSubst.contentSig).toBe(inlineSubst.contentSig);
  });

  it("keeps skillSources relative to the session file's dir (no absolute host path)", () => {
    const { sessionFile, substituted } = fixture();
    const fp = buildFingerprint(sessionFile, "1.0.0", undefined, undefined, undefined, substituted);
    expect(fp.skillSources).toEqual([join("v2", "my-plugin")]);
  });

  it("an explicit session override wins over the session object", () => {
    const { sessionFile, substituted } = fixture();
    const viaOverride = buildFingerprint(sessionFile, "1.0.0", undefined, undefined, undefined, undefined, sessionFile);
    expect(buildFingerprint(sessionFile, "1.0.0", undefined, undefined, undefined, substituted, sessionFile)).toEqual(viaOverride);
  });

  it("is byte-identical to the file-only fingerprint when the session object is NOT substituted", () => {
    const { sessionFile, original } = fixture();
    expect(buildFingerprint(sessionFile, "1.0.0", undefined, undefined, undefined, original)).toEqual(
      buildFingerprint(sessionFile, "1.0.0"),
    );
  });
});
