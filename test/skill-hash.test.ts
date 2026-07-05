import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashSkillDirs, skillHashEntries, OS_JUNK_PATTERN, compileIgnore, agentSkillName } from "../src/run/skill-hash.js";
import { createHash } from "node:crypto";

function skillDir(): string {
  const d = mkdtempSync(join(tmpdir(), "skill-"));
  mkdirSync(join(d, "skills"), { recursive: true });
  writeFileSync(join(d, "skills", "SKILL.md"), "# real skill content\n");
  return d;
}

describe("skill-hash — v8 framing closes the unframed-concatenation collision", () => {
  // Pre-v8, skillHash folded RAW content after `F:<relPath>\0`, so a two-file tree {p:"A", q:"B"}
  // folded the identical byte stream as a single file p whose content embeds the q boundary
  // (`A` + `F:skills/q\0` + `B`) — a staleness FALSE-NEGATIVE. v8 folds the fixed-length content SHA
  // instead (self-delimiting; sha charset is disjoint from the `F:`/`L:` prefixes), so they differ.
  // This test FAILS on the old algorithm (identical hashes) and passes on v8.
  it("a file whose content embeds a fake entry boundary does NOT collide with a two-file tree", () => {
    const twoFiles = mkdtempSync(join(tmpdir(), "skill-collA-"));
    mkdirSync(join(twoFiles, "skills"), { recursive: true });
    writeFileSync(join(twoFiles, "skills", "p"), "A");
    writeFileSync(join(twoFiles, "skills", "q"), "B");

    const oneFile = mkdtempSync(join(tmpdir(), "skill-collB-"));
    mkdirSync(join(oneFile, "skills"), { recursive: true });
    writeFileSync(join(oneFile, "skills", "p"), "A" + "F:skills/q\0" + "B"); // embeds the old boundary marker

    expect(hashSkillDirs([twoFiles]).hash).not.toBe(hashSkillDirs([oneFile]).hash);
  });
});

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

describe("skillHashEntries diagnostics (dump what the hash sees)", () => {
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

  it("(v5) OS-junk is EXCLUDED from the hash, so an out-of-band touch can't re-stale", () => {
    const d = skillDir();
    const before = hashSkillDirs([d]).hash;
    // a .DS_Store appearing (or being rewritten by Finder) must NOT change the skill hash.
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

describe("(v6) in-tree symlinks are hashed by target; escaping symlinks are skipped", () => {
  it("an in-tree symlink contributes (and a RE-POINT to a different in-tree file drifts the hash)", () => {
    const d = skillDir(); // skills/SKILL.md
    writeFileSync(join(d, "skills", "OTHER.md"), "# other\n");
    const baseline = hashSkillDirs([d]).hash;
    symlinkSync("SKILL.md", join(d, "skills", "link.md")); // in-tree relative symlink
    const withLink = hashSkillDirs([d]).hash;
    expect(withLink).not.toBe(baseline); // the symlink is hashed (by target), not silently skipped
    // re-point to a DIFFERENT in-tree file (same symlink name) → must drift even though no file content changed
    const d2 = skillDir();
    writeFileSync(join(d2, "skills", "OTHER.md"), "# other\n");
    symlinkSync("OTHER.md", join(d2, "skills", "link.md"));
    expect(hashSkillDirs([d2]).hash).not.toBe(withLink); // a re-point is detected
  });

  it("an ESCAPING symlink (target outside the tree) is skipped (not followed)", () => {
    const d = skillDir();
    const before = hashSkillDirs([d]).hash;
    symlinkSync("/etc/hosts", join(d, "skills", "escape.md")); // out-of-tree
    expect(hashSkillDirs([d]).hash).toBe(before); // escaping symlink excluded → no out-of-tree content
    expect(skillHashEntries([d]).some((e) => e.path.includes("escape.md"))).toBe(false);
  });
});

describe(".AppleDouble and __MACOSX directory subtrees are excluded", () => {
  it("a .AppleDouble directory added inside skills does not change the hash", () => {
    const d = skillDir();
    const before = hashSkillDirs([d]).hash;
    mkdirSync(join(d, "skills", ".AppleDouble"), { recursive: true });
    writeFileSync(join(d, "skills", ".AppleDouble", "SKILL.md"), "resource fork");
    expect(hashSkillDirs([d]).hash).toBe(before);
  });

  it("adding a file inside .AppleDouble after the dir exists still does not change the hash", () => {
    const d = skillDir();
    mkdirSync(join(d, "skills", ".AppleDouble"), { recursive: true });
    writeFileSync(join(d, "skills", ".AppleDouble", "x"), "a");
    const before = hashSkillDirs([d]).hash;
    writeFileSync(join(d, "skills", ".AppleDouble", "y"), "b");
    expect(hashSkillDirs([d]).hash).toBe(before);
  });

  it("a __MACOSX directory at the root does not change the hash", () => {
    const d = skillDir();
    const before = hashSkillDirs([d]).hash;
    mkdirSync(join(d, "__MACOSX"), { recursive: true });
    writeFileSync(join(d, "__MACOSX", "._skills"), "appledouble header");
    expect(hashSkillDirs([d]).hash).toBe(before);
  });

  it("real skill content still changes the hash (no false negative)", () => {
    const d = skillDir();
    mkdirSync(join(d, "skills", ".AppleDouble"), { recursive: true });
    writeFileSync(join(d, "skills", ".AppleDouble", "x"), "junk");
    const before = hashSkillDirs([d]).hash;
    writeFileSync(join(d, "skills", "SKILL.md"), "# changed\n");
    expect(hashSkillDirs([d]).hash).not.toBe(before);
  });
});

describe("compileIgnore handles /**/foo prefix", () => {
  it("/**/foo compiles to the same regex source as **/foo", () => {
    const a = compileIgnore("/**/foo");
    const b = compileIgnore("**/foo");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.source).toBe(b!.source);
  });

  it("/**/foo matches foo at any depth", () => {
    const re = compileIgnore("/**/foo")!;
    expect(re.test("foo")).toBe(true);
    expect(re.test("a/foo")).toBe(true);
    expect(re.test("a/b/foo")).toBe(true);
  });

  it("/**/foo does NOT match foobar", () => {
    const re = compileIgnore("/**/foo")!;
    expect(re.test("foobar")).toBe(false);
  });

  it("/**/foo/bar matches foo/bar and a/foo/bar", () => {
    const re = compileIgnore("/**/foo/bar")!;
    expect(re.test("foo/bar")).toBe(true);
    expect(re.test("a/foo/bar")).toBe(true);
    expect(re.test("foo/barbaz")).toBe(false);
  });

  it("/docs/api remains anchored to the root", () => {
    const re = compileIgnore("/docs/api")!;
    expect(re.test("docs/api")).toBe(true);
    expect(re.test("a/docs/api")).toBe(false);
  });
});

describe("agentSkillName respects isDirectory for dotted names", () => {
  it("a FILE agents/cap-table.v2 strips extension to cap-table.v2... wait, it strips only the last ext", () => {
    expect(agentSkillName(["agents", "cap-table.v2"], false)).toBe("cap-table");
  });

  it("a DIRECTORY agents/cap-table.v2 is used as-is (no extension strip)", () => {
    expect(agentSkillName(["agents", "cap-table.v2"], true)).toBe("cap-table.v2");
  });

  it("a FILE agents/cap-table.md strips extension to cap-table", () => {
    expect(agentSkillName(["agents", "cap-table.md"], false)).toBe("cap-table");
  });

  it("a multi-segment path agents/cap-table/x.md gives cap-table regardless of isDirectory", () => {
    expect(agentSkillName(["agents", "cap-table", "x.md"], false)).toBe("cap-table");
    expect(agentSkillName(["agents", "cap-table", "x.md"], true)).toBe("cap-table");
  });

  it("non-agents path returns null", () => {
    expect(agentSkillName(["skills", "cap-table"], false)).toBeNull();
  });
});

describe("NUL separator prevents newline-in-filename hash collisions", () => {
  it("two trees with different file counts hash differently (structural collision test)", () => {
    // Under \n separator, a file named "a\nF:b" with empty content and a tree with files "a" and "b"
    // (both empty) could collide: "F:a\nF:b\n" == "F:a\nF:b\n". Under \0 they are distinct.
    // We verify the simpler invariant: a single-file tree vs a two-file tree with same total content
    // must produce different hashes.
    const d1 = mkdtempSync(join(tmpdir(), "nul-sep-"));
    writeFileSync(join(d1, "a"), "hello");
    const d2 = mkdtempSync(join(tmpdir(), "nul-sep-"));
    writeFileSync(join(d2, "a"), "hello");
    writeFileSync(join(d2, "b"), "");
    expect(hashSkillDirs([d1]).hash).not.toBe(hashSkillDirs([d2]).hash);
  });
});
