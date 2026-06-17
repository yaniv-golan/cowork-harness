import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashSkillDirs } from "../src/run/skill-hash.js";

function skillDir(): string {
  const d = mkdtempSync(join(tmpdir(), "skill-"));
  mkdirSync(join(d, "skills"), { recursive: true });
  writeFileSync(join(d, "skills", "SKILL.md"), "# real skill content\n");
  return d;
}

describe("skill-hash — excludes cassettes/VCS, keeps real source (H-B)", () => {
  it("is unchanged when a recorded cassette is written into an existing cassettes dir (self-invalidation fix)", () => {
    const d = skillDir();
    // The real scenario: the cassettes dir already exists in the tree; recording writes a *.cassette.json
    // into it. The file is excluded by extension, so the fingerprint it just recorded does not change.
    mkdirSync(join(d, "tests", "cowork", "cassettes"), { recursive: true });
    const before = hashSkillDirs([d]);
    writeFileSync(join(d, "tests", "cowork", "cassettes", "a.cassette.json"), "{}");
    expect(hashSkillDirs([d])).toBe(before); // a cassette is output, not skill source
    writeFileSync(join(d, "tests", "cowork", "cassettes", "b.cassette.json"), '{"x":1}');
    expect(hashSkillDirs([d])).toBe(before); // and a second one
  });

  it("is unchanged when a VCS/cache dir changes", () => {
    const d = skillDir();
    const before = hashSkillDirs([d]);
    mkdirSync(join(d, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(d, "node_modules", "pkg", "index.js"), "x");
    mkdirSync(join(d, ".git"), { recursive: true });
    writeFileSync(join(d, ".git", "HEAD"), "ref: x");
    expect(hashSkillDirs([d])).toBe(before);
  });

  it("STILL changes when real skill source changes (no false negative)", () => {
    const d = skillDir();
    const before = hashSkillDirs([d]);
    writeFileSync(join(d, "skills", "SKILL.md"), "# v2 — behavior changed\n");
    expect(hashSkillDirs([d])).not.toBe(before);
  });

  it("STILL changes when a non-cassette file under tests/ changes (tests/ is NOT excluded by name)", () => {
    const d = skillDir();
    mkdirSync(join(d, "tests"), { recursive: true });
    writeFileSync(join(d, "tests", "helper.py"), "x = 1\n");
    const before = hashSkillDirs([d]);
    writeFileSync(join(d, "tests", "helper.py"), "x = 2\n");
    expect(hashSkillDirs([d])).not.toBe(before); // conservative: a code edit under tests/ still counts
  });
});
