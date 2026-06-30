import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { buildFingerprint } from "../src/run/cassette.js";

/** Build a session dir with a relative-path local skill, returns the session-file path. */
function sessionWithSkill(): { sessionPath: string; skillFile: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "cwh-fp-"));
  const skillDir = join(root, "myskill");
  mkdirSync(skillDir, { recursive: true });
  const skillFile = join(skillDir, "SKILL.md");
  writeFileSync(skillFile, "# myskill\noriginal content\n");
  const sessionPath = join(root, "session.yaml");
  // Relative skill path — must resolve against the SESSION-FILE dir, not cwd.
  writeFileSync(sessionPath, "skills:\n  local:\n    - ./myskill\n");
  return { sessionPath, skillFile, root };
}

describe("buildFingerprint skillHash", () => {
  it("computes a non-empty skillHash for a file-based session with a local skill dir", () => {
    const { sessionPath } = sessionWithSkill();
    const fp = buildFingerprint(sessionPath, "1.0.0");
    expect(fp.skillHash).toBeDefined();
    expect(fp.skillHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes the skillHash when a skill file's CONTENT changes", () => {
    const { sessionPath, skillFile } = sessionWithSkill();
    const before = buildFingerprint(sessionPath, "1.0.0").skillHash;
    writeFileSync(skillFile, "# myskill\nEDITED content\n");
    const after = buildFingerprint(sessionPath, "1.0.0").skillHash;
    expect(after).not.toBe(before);
  });

  it("changes the skillHash when a skill file MOVES to a subdir (relative path, not basename)", () => {
    const { sessionPath, root } = sessionWithSkill();
    const skillDir = join(root, "myskill");
    writeFileSync(join(skillDir, "config.json"), '{"k":1}');
    const before = buildFingerprint(sessionPath, "1.0.0").skillHash;
    // Move config.json into a subdir with IDENTICAL content + basename.
    rmSync(join(skillDir, "config.json"));
    mkdirSync(join(skillDir, "sub"), { recursive: true });
    writeFileSync(join(skillDir, "sub", "config.json"), '{"k":1}');
    const after = buildFingerprint(sessionPath, "1.0.0").skillHash;
    expect(after).not.toBe(before);
  });

  it("writes skillSources RELATIVE, never absolute host paths", () => {
    const { sessionPath } = sessionWithSkill();
    const fp = buildFingerprint(sessionPath, "1.0.0");
    expect(fp.skillSources).toBeDefined();
    expect(fp.skillSources!.length).toBeGreaterThan(0);
    for (const s of fp.skillSources!) expect(isAbsolute(s)).toBe(false);
  });
});
