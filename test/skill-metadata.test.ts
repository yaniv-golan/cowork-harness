import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveAvailableSkills, type PluginSkillRoot } from "../src/run/skill-metadata.js";

function stageLocalSkill(configDir: string, name: string, frontmatter: string): void {
  const dir = join(configDir, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), frontmatter);
}

function stagePluginSkill(pluginRoot: string, skillsSubdir: string, name: string, frontmatter: string): void {
  const dir = join(pluginRoot, skillsSubdir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), frontmatter);
}

describe("resolveAvailableSkills (§6.2, O1 fix — ids are the authoritative spine, disk only enriches whenToUse)", () => {
  it("enriches a local skills.local id with whenToUse read from <configDir>/skills/<id>/SKILL.md", () => {
    const configDir = mkdtempSync(join(tmpdir(), "cwh-skillmeta-"));
    stageLocalSkill(configDir, "my-skill", "---\nname: my-skill\ndescription: Use this when doing X.\n---\n\n# My Skill\n");
    const result = resolveAvailableSkills(["my-skill"], configDir, []);
    expect(result).toEqual([{ id: "my-skill", whenToUse: "Use this when doing X." }]);
  });

  it("enriches a plugin id `my-plugin:foo` from its PluginSkillRoot's staged SKILL.md", () => {
    const configDir = mkdtempSync(join(tmpdir(), "cwh-skillmeta-"));
    const pluginHost = mkdtempSync(join(tmpdir(), "cwh-plugin-"));
    stagePluginSkill(pluginHost, "skills", "foo", "---\nname: foo\ndescription: Does foo things.\n---\n");
    const pluginRoots: PluginSkillRoot[] = [{ pluginName: "my-plugin", hostPath: pluginHost, skillsSubdir: "skills" }];
    const result = resolveAvailableSkills(["my-plugin:foo"], configDir, pluginRoots);
    expect(result).toEqual([{ id: "my-plugin:foo", whenToUse: "Does foo things." }]);
  });

  it("keeps an id with NO backing SKILL.md anywhere, id-only (the authoritative-list guarantee)", () => {
    const configDir = mkdtempSync(join(tmpdir(), "cwh-skillmeta-"));
    const result = resolveAvailableSkills(["ghost-skill"], configDir, []);
    expect(result).toEqual([{ id: "ghost-skill" }]);
  });

  it("prefers description, falls back to when_to_use, omits whenToUse if neither is present", () => {
    const configDir = mkdtempSync(join(tmpdir(), "cwh-skillmeta-"));
    stageLocalSkill(configDir, "has-desc", "---\nname: has-desc\ndescription: D.\nwhen_to_use: W.\n---\n");
    stageLocalSkill(configDir, "has-wtu", "---\nname: has-wtu\nwhen_to_use: Use for Y.\n---\n");
    stageLocalSkill(configDir, "has-neither", "---\nname: has-neither\n---\n");
    const result = resolveAvailableSkills(["has-desc", "has-wtu", "has-neither"], configDir, []);
    expect(result).toEqual([{ id: "has-desc", whenToUse: "D." }, { id: "has-wtu", whenToUse: "Use for Y." }, { id: "has-neither" }]);
  });

  it("preserves the ids input order in the returned array", () => {
    const configDir = mkdtempSync(join(tmpdir(), "cwh-skillmeta-"));
    stageLocalSkill(configDir, "b", "---\nname: b\ndescription: B.\n---\n");
    stageLocalSkill(configDir, "a", "---\nname: a\ndescription: A.\n---\n");
    const result = resolveAvailableSkills(["z", "b", "a"], configDir, []);
    expect(result.map((r) => r.id)).toEqual(["z", "b", "a"]);
  });

  it("a SKILL.md with malformed/missing frontmatter leaves the id present with no whenToUse (no throw)", () => {
    const configDir = mkdtempSync(join(tmpdir(), "cwh-skillmeta-"));
    stageLocalSkill(configDir, "malformed", "not frontmatter at all, just prose\n");
    expect(() => resolveAvailableSkills(["malformed"], configDir, [])).not.toThrow();
    expect(resolveAvailableSkills(["malformed"], configDir, [])).toEqual([{ id: "malformed" }]);
  });

  it("never throws when configDir/skills or a plugin's skillsSubdir is entirely absent", () => {
    const configDir = mkdtempSync(join(tmpdir(), "cwh-skillmeta-"));
    const pluginRoots: PluginSkillRoot[] = [
      { pluginName: "gone", hostPath: join(configDir, "nonexistent-plugin"), skillsSubdir: "skills" },
    ];
    expect(() => resolveAvailableSkills(["local-ghost", "gone:foo"], configDir, pluginRoots)).not.toThrow();
    expect(resolveAvailableSkills(["local-ghost", "gone:foo"], configDir, pluginRoots)).toEqual([
      { id: "local-ghost" },
      { id: "gone:foo" },
    ]);
  });
});
