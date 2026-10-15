import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveAvailableSkills, listMountedSkills, type PluginSkillRoot } from "../src/run/skill-metadata.js";
import { mountedPluginsFromPlan } from "../src/session.js";
import { gitStageStats, gitFilterFromSet, gitEnvWithoutAmbientRepo } from "../src/run/skill-files.js";
import { spawnSync } from "node:child_process";

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

describe("resolveAvailableSkills (ids are the authoritative spine, disk only enriches whenToUse)", () => {
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

// --- staging truth: the discovery catalogs must report what the agent WILL RECEIVE ----------------
// Under git mode a plugin's UNTRACKED skill dir is excluded from the mount with only a notice (the
// hard-fail fires only when the WHOLE plugin has 0 tracked files). Enumerating the source tree would
// therefore advertise a skill the sandbox never got. Both catalogs must apply the same filter — they
// are read by two tools in the SAME run (`mcp__skills__list_skills` and `mcp__plugins__list_plugins`),
// so a divergence is self-contradictory output, not just a cosmetic miss.
describe("plugin skill catalogs honour the mount's staging filter", () => {
  /** A real git work tree: one committed skill, one untracked. Returns the plugin root. */
  function gitPluginFixture(): string {
    const root = mkdtempSync(join(tmpdir(), "stagefilter-"));
    // env: a git HOOK runs with GIT_DIR/GIT_INDEX_FILE pointing at the invoking repo; inherited, this
    // fixture's `add -A` would rewrite THAT repo's index (it removes entries, unlike the plain
    // `add <path>` the older fixtures use). Same helper the cassette path uses.
    const git = (...a: string[]) => spawnSync("git", a, { cwd: root, stdio: "ignore", env: gitEnvWithoutAmbientRepo() });
    stagePluginSkill(root, "skills", "tracked-skill", "---\nname: tracked-skill\ndescription: kept\n---\n");
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "myplugin" }));
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    git("add", "-A");
    git("commit", "-qm", "init");
    // Added AFTER the commit — tracked set does not contain it.
    stagePluginSkill(root, "skills", "untracked-skill", "---\nname: untracked-skill\ndescription: dropped\n---\n");
    return root;
  }

  it("listMountedSkills drops an untracked plugin skill dir, keeps the tracked one", () => {
    const root = gitPluginFixture();
    const { tracked } = gitStageStats(root);
    expect(tracked).toBeTruthy();
    const filter = gitFilterFromSet(root, tracked!);
    const roots: PluginSkillRoot[] = [{ pluginName: "myplugin", hostPath: root, skillsSubdir: "skills", stageFilter: filter }];
    const names = listMountedSkills(mkdtempSync(join(tmpdir(), "cfg-")), roots).map((s) => s.name);
    expect(names).toContain("myplugin:tracked-skill");
    expect(names).not.toContain("myplugin:untracked-skill");
  });

  it("GITSET=0 (raw copy) filters nothing, even for a git source", () => {
    const root = gitPluginFixture();
    const roots: PluginSkillRoot[] = [{ pluginName: "myplugin", hostPath: root, skillsSubdir: "skills" }];
    const prev = process.env.COWORK_HARNESS_GITSET;
    process.env.COWORK_HARNESS_GITSET = "0";
    try {
      const names = listMountedSkills(mkdtempSync(join(tmpdir(), "cfg-")), roots).map((s) => s.name);
      expect(names).toEqual(expect.arrayContaining(["myplugin:tracked-skill", "myplugin:untracked-skill"]));
    } finally {
      if (prev === undefined) delete process.env.COWORK_HARNESS_GITSET;
      else process.env.COWORK_HARNESS_GITSET = prev;
    }
  });

  // RESUME: buildLaunchPlan leaves `stageFilter` undefined (nothing is re-staged), but the persisted mnt
  // tree WAS filtered on the original run — so the catalog must still derive the filter, or it over-lists
  // a skill the sandbox does not have. This is the F2 regression.
  it("derives the filter when stageFilter is absent but git mode is on (the resume path)", () => {
    const root = gitPluginFixture();
    const roots: PluginSkillRoot[] = [{ pluginName: "myplugin", hostPath: root, skillsSubdir: "skills" }];
    const names = listMountedSkills(mkdtempSync(join(tmpdir(), "cfg-")), roots).map((s) => s.name);
    expect(names).toContain("myplugin:tracked-skill");
    expect(names).not.toContain("myplugin:untracked-skill");
  });

  it("mountedPluginsFromPlan derives it too when stageFilter is absent (resume parity)", () => {
    const root = gitPluginFixture();
    const plan = {
      mounts: [{ hostPath: root, mountPath: ".local-plugins/marketplaces/local/myplugin", mode: "r", kind: "local-plugin" }],
    } as unknown as Parameters<typeof mountedPluginsFromPlan>[0];
    const skills = mountedPluginsFromPlan(plan)[0].skills.map((s) => s.name);
    expect(skills).toContain("myplugin:tracked-skill");
    expect(skills).not.toContain("myplugin:untracked-skill");
  });

  it("mountedPluginsFromPlan agrees with listMountedSkills (no cross-tool contradiction)", () => {
    const root = gitPluginFixture();
    const { tracked } = gitStageStats(root);
    const filter = gitFilterFromSet(root, tracked!);
    const plan = {
      mounts: [
        { hostPath: root, mountPath: ".local-plugins/marketplaces/local/myplugin", mode: "r", kind: "local-plugin", stageFilter: filter },
      ],
    } as unknown as Parameters<typeof mountedPluginsFromPlan>[0];
    const skills = mountedPluginsFromPlan(plan)[0].skills.map((s) => s.name);
    expect(skills).toContain("myplugin:tracked-skill");
    expect(skills).not.toContain("myplugin:untracked-skill"); // the N1 regression
  });
});
