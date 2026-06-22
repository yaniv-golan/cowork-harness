import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashSkillDirs, skillHashEntries, OS_JUNK_PATTERN } from "../src/run/skill-hash.js";
import { createHash } from "node:crypto";

function skillDir(): string {
  const d = mkdtempSync(join(tmpdir(), "skill-"));
  mkdirSync(join(d, "skills"), { recursive: true });
  writeFileSync(join(d, "skills", "SKILL.md"), "# real skill content\n");
  return d;
}

describe("skill-hash — excludes cassettes/VCS, keeps real source", () => {
  it("is unchanged when a recorded cassette is written into an existing cassettes dir (self-invalidation fix)", () => {
    const d = skillDir();
    // The real scenario: the cassettes dir already exists in the tree; recording writes a *.cassette.json
    // into it. The file is excluded by extension, so the fingerprint it just recorded does not change.
    mkdirSync(join(d, "tests", "cowork", "cassettes"), { recursive: true });
    const before = hashSkillDirs([d]).hash;
    writeFileSync(join(d, "tests", "cowork", "cassettes", "a.cassette.json"), "{}");
    expect(hashSkillDirs([d]).hash).toBe(before); // a cassette is output, not skill source
    writeFileSync(join(d, "tests", "cowork", "cassettes", "b.cassette.json"), '{"x":1}');
    expect(hashSkillDirs([d]).hash).toBe(before); // and a second one
  });

  it("is unchanged when a VCS/cache dir changes", () => {
    const d = skillDir();
    const before = hashSkillDirs([d]).hash;
    mkdirSync(join(d, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(d, "node_modules", "pkg", "index.js"), "x");
    mkdirSync(join(d, ".git"), { recursive: true });
    writeFileSync(join(d, ".git", "HEAD"), "ref: x");
    expect(hashSkillDirs([d]).hash).toBe(before);
  });

  it("STILL changes when real skill source changes (no false negative)", () => {
    const d = skillDir();
    const before = hashSkillDirs([d]).hash;
    writeFileSync(join(d, "skills", "SKILL.md"), "# v2 — behavior changed\n");
    expect(hashSkillDirs([d]).hash).not.toBe(before);
  });

  it("STILL changes when a non-cassette file under tests/ changes (tests/ is NOT excluded by name)", () => {
    const d = skillDir();
    mkdirSync(join(d, "tests"), { recursive: true });
    writeFileSync(join(d, "tests", "helper.py"), "x = 1\n");
    const before = hashSkillDirs([d]).hash;
    writeFileSync(join(d, "tests", "helper.py"), "x = 2\n");
    expect(hashSkillDirs([d]).hash).not.toBe(before); // conservative: a code edit under tests/ still counts
  });
});

describe("H9 — skillHashEntries diagnostics (dump what the hash sees)", () => {
  it("lists exactly the files the hash folds in, with a content sha that matches per-file", () => {
    const d = skillDir();
    writeFileSync(join(d, "skills", "extra.md"), "more\n");
    const entries = skillHashEntries([d]);
    const paths = entries.map((e) => e.path);
    expect(paths).toEqual(["skills/SKILL.md", "skills/extra.md"]); // sorted, scoped to the hashed set
    // the reported sha is the sha256 of the file content the hash used (raw bytes here)
    const sha = createHash("sha256").update("# real skill content\n").digest("hex");
    expect(entries.find((e) => e.path === "skills/SKILL.md")!.sha).toBe(sha);
  });

  it("excludes the same files the hash excludes (cassettes, VCS dirs, hashignore file)", () => {
    const d = skillDir();
    mkdirSync(join(d, ".git"), { recursive: true });
    writeFileSync(join(d, ".git", "HEAD"), "ref: x");
    writeFileSync(join(d, "a.cassette.json"), "{}");
    writeFileSync(join(d, ".cowork-hashignore"), "junk\n");
    const paths = skillHashEntries([d]).map((e) => e.path);
    expect(paths).toEqual(["skills/SKILL.md"]); // no .git, no cassette, no hashignore file
  });

  it("H9 fix (v5) — OS-junk is EXCLUDED from the hash, so an out-of-band touch can't re-stale", () => {
    const d = skillDir();
    const before = hashSkillDirs([d]).hash;
    // a .DS_Store appearing (or being rewritten by Finder) must NOT change the skill hash — the H9 fix.
    writeFileSync(join(d, "skills", ".DS_Store"), "\x00\x01finder-state");
    expect(hashSkillDirs([d]).hash).toBe(before); // excluded → no drift
    writeFileSync(join(d, "skills", ".DS_Store"), "\x00\x02finder-moved-an-icon");
    expect(hashSkillDirs([d]).hash).toBe(before); // a subsequent rewrite still doesn't drift
    writeFileSync(join(d, "Thumbs.db"), "x");
    writeFileSync(join(d, "desktop.ini"), "x");
    expect(hashSkillDirs([d]).hash).toBe(before); // other OS-junk too
    // …and it's not in the hashed file set, while a real skill file is
    const paths = skillHashEntries([d]).map((e) => e.path);
    expect(paths).toEqual(["skills/SKILL.md"]);
    expect(OS_JUNK_PATTERN.test("skills/.DS_Store")).toBe(true);
    expect(OS_JUNK_PATTERN.test("skills/SKILL.md")).toBe(false); // a real skill file is NOT junk
  });

  it("STILL changes when a real source file changes (OS-junk exclusion didn't weaken detection)", () => {
    const d = skillDir();
    writeFileSync(join(d, "skills", ".DS_Store"), "junk");
    const before = hashSkillDirs([d]).hash;
    writeFileSync(join(d, "skills", "SKILL.md"), "# changed\n");
    expect(hashSkillDirs([d]).hash).not.toBe(before); // real change still detected
  });
});
