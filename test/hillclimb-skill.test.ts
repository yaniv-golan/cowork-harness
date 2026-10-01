// Which skill `hillclimb run`'s skill_invoked column tracks, per plugin shape. The expected names are the ones the
// agent binary's plugin loader registers (read from the shipped loader): skills/<dir>/ registers `<plugin>:<dir>`
// whenever skills/ exists; a SKILL.md at the plugin root is loaded only when the manifest has no `skills` field and
// there is no skills/ dir, or when `skills` names the root, and registers `<plugin>:<frontmatter name minus a
// leading "<plugin>:", else the root's basename>`, every character outside [a-zA-Z0-9_-] replaced by "-".
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootSkillName, trackedSkill } from "../src/hillclimb/skill.js";

let base: string;
let root: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "hc-skill-")));
  root = join(base, "plug-dir");
  mkdirSync(root);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const manifest = (m: Record<string, unknown>) => {
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify(m));
};
const rootMd = (name?: string) =>
  writeFileSync(join(root, "SKILL.md"), `---\n${name !== undefined ? `name: "${name}"\n` : ""}description: d\n---\nbody\n`);
const skill = (n: string) => {
  mkdirSync(join(root, "skills", n), { recursive: true });
  writeFileSync(join(root, "skills", n, "SKILL.md"), `---\nname: other-${n}\n---\n`);
};

describe("rootSkillName", () => {
  it("is the frontmatter name; a leading '<plugin>:' is dropped; characters outside [a-zA-Z0-9_-] become '-'", () => {
    manifest({ name: "plug" });
    rootMd("coach");
    expect(rootSkillName(root)).toBe("coach");
    rootMd("plug:coach");
    expect(rootSkillName(root)).toBe("coach");
    rootMd("Deck Review!");
    expect(rootSkillName(root)).toBe("Deck-Review-");
  });

  it("falls back to the root's basename when the frontmatter has no name; no manifest is fine", () => {
    rootMd();
    expect(rootSkillName(root)).toBe("plug-dir");
  });

  it("is undefined when a skills/ dir exists beside it: the binary loads skills/ and not the root", () => {
    manifest({ name: "plug" });
    rootMd("coach");
    skill("x");
    expect(rootSkillName(root)).toBeUndefined();
  });

  it("follows a manifest `skills` field: the root only when it names the root", () => {
    rootMd("coach");
    manifest({ name: "plug", skills: ["./"] });
    expect(rootSkillName(root)).toBe("coach");
    manifest({ name: "plug", skills: "./" });
    expect(rootSkillName(root)).toBe("coach");
    manifest({ name: "plug", skills: ["./custom"] });
    expect(rootSkillName(root)).toBeUndefined();
  });

  it("is undefined with no root SKILL.md", () => {
    manifest({ name: "plug" });
    expect(rootSkillName(root)).toBeUndefined();
  });
});

describe("trackedSkill", () => {
  it("a root SKILL.md beside a one-skill skills/ dir tracks the skill the binary loads: skills/<dir>, by its directory", () => {
    manifest({ name: "plug" });
    rootMd("coach");
    skill("x");
    expect(trackedSkill(root, undefined)).toEqual({ name: "x" });
  });

  it("a manifest `skills` path the resolver does not follow leaves the column omitted, never guessed", () => {
    manifest({ name: "plug", skills: ["./custom"] });
    rootMd("coach");
    const t = trackedSkill(root, undefined);
    expect(t.name).toBeUndefined();
  });

  it("--skill on a multi-skill plugin returns the selector; an unknown one throws naming the skills", () => {
    skill("a");
    skill("b");
    expect(trackedSkill(root, "b")).toEqual({ name: "b" });
    expect(() => trackedSkill(root, "c")).toThrow(/--skill c: no skills\/c\/SKILL\.md under .* — available skills: a, b/);
    expect(() => trackedSkill(root, "../a")).toThrow();
  });
});
