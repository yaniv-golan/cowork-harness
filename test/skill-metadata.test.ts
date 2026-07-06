import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readAvailableSkills } from "../src/run/skill-metadata.js";

function stageSkill(root: string, name: string, frontmatter: string): void {
  const dir = join(root, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), frontmatter);
}

describe("readAvailableSkills", () => {
  it("reads name/description from a SKILL.md's YAML frontmatter", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-skillmeta-"));
    stageSkill(root, "my-skill", "---\nname: my-skill\ndescription: Use this when doing X.\n---\n\n# My Skill\n\nBody text.\n");
    const skills = readAvailableSkills(root);
    expect(skills).toEqual([{ id: "my-skill", whenToUse: "Use this when doing X." }]);
  });

  it("falls back to when_to_use if description is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-skillmeta-"));
    stageSkill(root, "my-skill", "---\nname: my-skill\nwhen_to_use: Use this for Y.\n---\n");
    const skills = readAvailableSkills(root);
    expect(skills).toEqual([{ id: "my-skill", whenToUse: "Use this for Y." }]);
  });

  it("uses the directory basename as id even if frontmatter's name differs", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-skillmeta-"));
    stageSkill(root, "dir-name", "---\nname: different-name\n---\n");
    const skills = readAvailableSkills(root);
    expect(skills[0].id).toBe("dir-name");
  });

  it("omits whenToUse when frontmatter has neither description nor when_to_use", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-skillmeta-"));
    stageSkill(root, "my-skill", "---\nname: my-skill\n---\n");
    const skills = readAvailableSkills(root);
    expect(skills).toEqual([{ id: "my-skill", whenToUse: undefined }]);
  });

  it("returns [] when no skills directory exists at all", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-skillmeta-"));
    expect(readAvailableSkills(root)).toEqual([]);
  });

  it("skips a skill directory with no SKILL.md, or one with malformed/no frontmatter, rather than throwing", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-skillmeta-"));
    mkdirSync(join(root, "skills", "no-manifest"), { recursive: true });
    stageSkill(root, "malformed", "not frontmatter at all, just prose\n");
    stageSkill(root, "good", "---\nname: good\ndescription: fine\n---\n");
    const skills = readAvailableSkills(root);
    expect(skills.map((s) => s.id)).toEqual(["good"]);
  });
});
