import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashSkillDirs, hashSharedOnly, compileIgnore } from "../src/run/skill-hash.js";

/** A plugin-root with two skills + shared roots (scripts/, .claude-plugin/plugin.json) — the
 *  multi-skill plugin-repo shape that shared-root hash scoping targets. */
function pluginRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "plugin-"));
  mkdirSync(join(d, "skills", "alpha"), { recursive: true });
  mkdirSync(join(d, "skills", "beta"), { recursive: true });
  mkdirSync(join(d, "scripts"), { recursive: true });
  mkdirSync(join(d, ".claude-plugin"), { recursive: true });
  writeFileSync(join(d, "skills", "alpha", "SKILL.md"), "# alpha v1\n");
  writeFileSync(join(d, "skills", "beta", "SKILL.md"), "# beta v1\n");
  writeFileSync(join(d, "scripts", "shared.py"), "x = 1\n");
  writeFileSync(join(d, ".claude-plugin", "plugin.json"), '{"name":"p","version":"1"}');
  return d;
}

describe("scoped skill hashing", () => {
  it("default (no scope) is byte-identical to an explicitly-empty scope (whole tree)", () => {
    const d = pluginRoot();
    expect(hashSkillDirs([d]).hash).toBe(hashSkillDirs([d], []).hash);
  });

  it("whole-tree (default) re-stales on ANY skill edit — the over-staling problem scoping fixes", () => {
    const d = pluginRoot();
    const before = hashSkillDirs([d]).hash;
    writeFileSync(join(d, "skills", "beta", "SKILL.md"), "# beta v2\n");
    expect(hashSkillDirs([d]).hash).not.toBe(before); // unrelated skill edit changes the whole-tree hash
  });

  it("scoped to [alpha]: editing an UNLISTED skill does NOT change the hash", () => {
    const d = pluginRoot();
    const before = hashSkillDirs([d], ["alpha"]).hash;
    writeFileSync(join(d, "skills", "beta", "SKILL.md"), "# beta v2 (unrelated)\n");
    expect(hashSkillDirs([d], ["alpha"]).hash).toBe(before); // beta is out of scope
  });

  it("scoped to [alpha]: editing the LISTED skill DOES change the hash", () => {
    const d = pluginRoot();
    const before = hashSkillDirs([d], ["alpha"]).hash;
    writeFileSync(join(d, "skills", "alpha", "SKILL.md"), "# alpha v2\n");
    expect(hashSkillDirs([d], ["alpha"]).hash).not.toBe(before);
  });

  it("scoped to [alpha]: editing a SHARED root STILL changes the hash (no false-fresh)", () => {
    const d = pluginRoot();
    const before = hashSkillDirs([d], ["alpha"]).hash;
    writeFileSync(join(d, "scripts", "shared.py"), "x = 2\n");
    expect(hashSkillDirs([d], ["alpha"]).hash).not.toBe(before);
    const before2 = hashSkillDirs([d], ["alpha"]).hash;
    // a NON-version plugin.json change (version bumps are exempt — covered separately below)
    writeFileSync(join(d, ".claude-plugin", "plugin.json"), '{"name":"renamed","version":"1"}');
    expect(hashSkillDirs([d], ["alpha"]).hash).not.toBe(before2);
  });

  it("fail-closed: a typo'd/absent skill name falls back to whole-tree (no silent narrowing)", () => {
    const d = pluginRoot();
    const scoped = hashSkillDirs([d], ["typo-not-a-skill"]);
    expect(scoped.hash).toBe(hashSkillDirs([d]).hash); // == whole-tree
    expect(scoped.scoped).toBe(false); // diagnostic: fallback was used
    expect(scoped.missedSkills).toContain("typo-not-a-skill");
    // and because it's whole-tree, an unrelated skill edit DOES re-stale (gate stays safe)
    writeFileSync(join(d, "skills", "beta", "SKILL.md"), "# beta v2\n");
    expect(hashSkillDirs([d], ["typo-not-a-skill"]).hash).not.toBe(scoped.hash);
  });

  it("a root WITHOUT a top-level skills/ (individual mount) hashes whole even when scoped", () => {
    const d = mkdtempSync(join(tmpdir(), "indiv-"));
    writeFileSync(join(d, "SKILL.md"), "# standalone\n");
    expect(hashSkillDirs([d], ["alpha"]).hash).toBe(hashSkillDirs([d]).hash); // structural rule degenerates safely
  });

  it("a plugin.json VERSION bump alone does NOT change the hash (metadata, no behavior impact)", () => {
    const d = pluginRoot();
    const before = hashSkillDirs([d]).hash;
    writeFileSync(join(d, ".claude-plugin", "plugin.json"), '{"name":"p","version":"9.9.9"}');
    expect(hashSkillDirs([d]).hash).toBe(before); // version bump is ignored
  });

  it("a plugin.json change OTHER than version STILL changes the hash (behavior-bearing fields count)", () => {
    const d = pluginRoot();
    const before = hashSkillDirs([d]).hash;
    writeFileSync(join(d, ".claude-plugin", "plugin.json"), '{"name":"p","version":"1","mcpServers":{"x":{}}}');
    expect(hashSkillDirs([d]).hash).not.toBe(before); // adding mcpServers re-stales
  });

  it("the version-bump exemption holds under scoping too (plugin.json is a shared root)", () => {
    const d = pluginRoot();
    const before = hashSkillDirs([d], ["alpha"]).hash;
    writeFileSync(join(d, ".claude-plugin", "plugin.json"), '{"name":"p","version":"2.0.0"}');
    expect(hashSkillDirs([d], ["alpha"]).hash).toBe(before);
  });

  it("scoped=true when scope was applied, scoped=false when falling back", () => {
    const d = pluginRoot();
    expect(hashSkillDirs([d], ["alpha"]).scoped).toBe(true); // alpha exists → scoped
    expect(hashSkillDirs([d]).scoped).toBe(false); // no scopeSkills → whole-tree
    expect(hashSkillDirs([d], []).scoped).toBe(false); // empty array → whole-tree
    expect(hashSkillDirs([d], ["missing"]).scoped).toBe(false); // typo → fallback
  });
});

describe("consumer-declared hash_ignore (session globs + plugin-local .cowork-hashignore)", () => {
  it("a session-level ignore glob drops a non-runtime dir from the hash", () => {
    const d = pluginRoot();
    mkdirSync(join(d, "tests"), { recursive: true });
    writeFileSync(join(d, "tests", "test_x.py"), "x = 1\n");
    const before = hashSkillDirs([d], undefined, ["tests/"]).hash;
    writeFileSync(join(d, "tests", "test_x.py"), "x = 2\n");
    expect(hashSkillDirs([d], undefined, ["tests/"]).hash).toBe(before); // tests/ edit ignored
    // ...but a runtime file still re-stales even with tests/ ignored
    const before2 = hashSkillDirs([d], undefined, ["tests/"]).hash;
    writeFileSync(join(d, "skills", "alpha", "SKILL.md"), "# alpha v2\n");
    expect(hashSkillDirs([d], undefined, ["tests/"]).hash).not.toBe(before2);
  });

  it("a plugin-local .cowork-hashignore is honored, and the ignore file itself is not hashed", () => {
    const d = pluginRoot();
    mkdirSync(join(d, "docs"), { recursive: true });
    writeFileSync(join(d, "docs", "guide.md"), "v1\n");
    writeFileSync(join(d, ".cowork-hashignore"), "# non-runtime\ndocs/\n");
    const before = hashSkillDirs([d]).hash;
    writeFileSync(join(d, "docs", "guide.md"), "v2 — docs changed\n");
    expect(hashSkillDirs([d]).hash).toBe(before); // docs/ ignored via the plugin-local file
    // editing the ignore file itself does not change the hash (it's harness metadata, not hashed)
    writeFileSync(join(d, ".cowork-hashignore"), "# non-runtime\ndocs/\n# touched\n");
    expect(hashSkillDirs([d]).hash).toBe(before);
  });

  it("session globs and the plugin-local file COMPOSE (union)", () => {
    const d = pluginRoot();
    mkdirSync(join(d, "tests"), { recursive: true });
    mkdirSync(join(d, "docs"), { recursive: true });
    writeFileSync(join(d, "tests", "t.py"), "1\n");
    writeFileSync(join(d, "docs", "d.md"), "1\n");
    writeFileSync(join(d, ".cowork-hashignore"), "docs/\n");
    const before = hashSkillDirs([d], undefined, ["tests/"]).hash;
    writeFileSync(join(d, "tests", "t.py"), "2\n"); // ignored via session glob
    writeFileSync(join(d, "docs", "d.md"), "2\n"); // ignored via plugin-local file
    expect(hashSkillDirs([d], undefined, ["tests/"]).hash).toBe(before);
  });

  it("ignore composes with skill scoping", () => {
    const d = pluginRoot();
    mkdirSync(join(d, "skills", "alpha", "tests"), { recursive: true });
    writeFileSync(join(d, "skills", "alpha", "tests", "t.py"), "1\n");
    const before = hashSkillDirs([d], ["alpha"], ["tests/"]).hash;
    writeFileSync(join(d, "skills", "alpha", "tests", "t.py"), "2\n"); // a tests/ dir nested under the scoped skill
    expect(hashSkillDirs([d], ["alpha"], ["tests/"]).hash).toBe(before); // slash-free `tests` matches at any depth
  });
});

describe("hashSharedOnly — shared-roots-only hash", () => {
  it("returns null when the dir has no skills/ layout (individual-skill mount)", () => {
    const d = mkdtempSync(join(tmpdir(), "no-layout-"));
    writeFileSync(join(d, "SKILL.md"), "# direct mount\n");
    expect(hashSharedOnly([d])).toBeNull();
  });

  it("returns a hex string for a plugin-root with a skills/ dir", () => {
    const d = pluginRoot();
    const h = hashSharedOnly([d]);
    expect(h).not.toBeNull();
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when a shared-root file changes", () => {
    const d = pluginRoot();
    const before = hashSharedOnly([d]);
    writeFileSync(join(d, "scripts", "shared.py"), "x = 99\n");
    expect(hashSharedOnly([d])).not.toBe(before);
  });

  it("does NOT change when a skills/<name> file changes (skills are excluded)", () => {
    const d = pluginRoot();
    const before = hashSharedOnly([d]);
    writeFileSync(join(d, "skills", "alpha", "SKILL.md"), "# alpha edited\n");
    expect(hashSharedOnly([d])).toBe(before);
  });
});

describe("compileIgnore — glob semantics", () => {
  const m = (pat: string, path: string) => {
    const re = compileIgnore(pat);
    return re ? re.test(path) : false;
  };
  it("slash-free name matches at any depth + its subtree", () => {
    expect(m("tests/", "tests")).toBe(true);
    expect(m("tests", "a/tests")).toBe(true);
    expect(m("tests", "a/tests/b.py")).toBe(true);
    expect(m("tests", "a/contests")).toBe(false); // whole-segment, not substring
  });
  it("`*` is within-segment; `*.md` matches any .md basename at any depth", () => {
    expect(m("*.md", "README.md")).toBe(true);
    expect(m("*.md", "docs/x.md")).toBe(true);
    expect(m("*.md", "x.mdx")).toBe(false);
  });
  it("a slashed pattern is anchored to the mount root", () => {
    expect(m("docs/api", "docs/api")).toBe(true);
    expect(m("docs/api", "docs/api/v1.json")).toBe(true);
    expect(m("docs/api", "skills/docs/api")).toBe(false); // not anchored at depth
  });
  it("a leading globstar segment matches at any depth", () => {
    expect(m("**/fixtures", "fixtures")).toBe(true);
    expect(m("**/fixtures", "skills/alpha/fixtures")).toBe(true);
  });
  it("comments and blanks compile to null", () => {
    expect(compileIgnore("# a comment")).toBeNull();
    expect(compileIgnore("   ")).toBeNull();
  });
  it("`?` is a literal, not a quantifier (only * / ** are wildcards)", () => {
    expect(m("a?b", "a?b")).toBe(true);
    expect(m("a?b", "ab")).toBe(false); // would be true if `?` acted as the optional quantifier
  });
});

describe("compileIgnore — glob form matrix", () => {
  it("/tests (leading slash) anchors to the mount root only", () => {
    const re = compileIgnore("/tests");
    expect(re).not.toBeNull();
    expect(re!.test("tests")).toBe(true);
    expect(re!.test("tests/foo")).toBe(true);
    expect(re!.test("deep/tests")).toBe(false);
    expect(re!.test("deep/tests/foo")).toBe(false);
  });

  it("tests/ (trailing slash, no leading slash) matches at ANY depth", () => {
    const re = compileIgnore("tests/");
    expect(re).not.toBeNull();
    expect(re!.test("tests")).toBe(true);
    expect(re!.test("tests/foo")).toBe(true);
    expect(re!.test("deep/tests")).toBe(true);
    expect(re!.test("deep/tests/foo")).toBe(true);
  });

  it("tests (bare, no slashes) matches at any depth — same as trailing-slash form", () => {
    const re = compileIgnore("tests");
    expect(re).not.toBeNull();
    expect(re!.test("tests")).toBe(true);
    expect(re!.test("deep/tests")).toBe(true);
  });

  it("docs/api (has internal slash, no leading slash) anchors to mount root", () => {
    const re = compileIgnore("docs/api");
    expect(re).not.toBeNull();
    expect(re!.test("docs/api")).toBe(true);
    expect(re!.test("docs/api/foo")).toBe(true);
    expect(re!.test("src/docs/api")).toBe(false);
  });

  it("# comment compiles to null", () => {
    expect(compileIgnore("# ignore me")).toBeNull();
    expect(compileIgnore("")).toBeNull();
  });
});
