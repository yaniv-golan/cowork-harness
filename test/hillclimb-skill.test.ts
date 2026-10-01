// Which skill `hillclimb run`'s skill_invoked column tracks, per plugin shape. The expected ids are the ones the
// agent binary's plugin skill loader registers (read from the staged agent, 2.1.284):
//  - the skills paths, in order: skills/ whenever it exists; each manifest `skills` entry (a string or an array of
//    paths relative to the plugin root, each an existing directory, skills/ itself dropped); the plugin root only
//    when the manifest has no `skills` field and there is no skills/ dir;
//  - per path: a SKILL.md directly in it (a regular file of at most 1 MiB) is one skill, named by its frontmatter
//    `name` minus a leading "<plugin>:", else the path's basename; otherwise every directory in it holding such a
//    SKILL.md is a skill named by the DIRECTORY (its frontmatter name is not read);
//  - a SKILL.md reached twice (by real path) registers once, the first time;
//  - the name half of `<plugin>:<name>` has every character outside [a-zA-Z0-9_-] replaced by "-".
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registeredSkills, trackedSkill } from "../src/hillclimb/skill.js";

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
/** A skill directory at `rel` (default under skills/); its frontmatter name differs from the directory on purpose. */
const skill = (n: string, parent = "skills", fmName = `other-${n}`) => {
  mkdirSync(join(root, parent, n), { recursive: true });
  writeFileSync(join(root, parent, n, "SKILL.md"), `---\nname: ${fmName}\n---\n`);
};
const ids = () => registeredSkills(root).map((s) => s.id);

describe("registeredSkills: the root SKILL.md", () => {
  it("is named by the frontmatter name; a leading '<plugin>:' is dropped; characters outside [a-zA-Z0-9_-] become '-'", () => {
    manifest({ name: "plug" });
    rootMd("coach");
    expect(ids()).toEqual(["coach"]);
    rootMd("plug:coach");
    expect(ids()).toEqual(["coach"]);
    rootMd("Deck Review!");
    expect(ids()).toEqual(["Deck-Review-"]);
  });

  it("falls back to the root's basename when the frontmatter has no name; no manifest is fine", () => {
    rootMd();
    expect(ids()).toEqual(["plug-dir"]);
  });

  it("is not loaded when a skills/ dir exists beside it: the binary loads skills/ and not the root", () => {
    manifest({ name: "plug" });
    rootMd("coach");
    skill("x");
    expect(ids()).toEqual(["x"]);
  });

  it("follows a manifest `skills` field: the root only when it names the root", () => {
    rootMd("coach");
    manifest({ name: "plug", skills: ["./"] });
    expect(ids()).toEqual(["coach"]);
    manifest({ name: "plug", skills: "./" });
    expect(ids()).toEqual(["coach"]);
    manifest({ name: "plug", skills: ["./custom"] });
    expect(ids()).toEqual([]);
  });

  it("a SKILL.md that is not a regular file is skipped, as the loader skips it", () => {
    manifest({ name: "plug" });
    mkdirSync(join(root, "SKILL.md"));
    expect(ids()).toEqual([]);
  });

  it("a SKILL.md over the loader's 1 MiB cap is skipped; one at the cap loads", () => {
    manifest({ name: "plug" });
    const head = `---\nname: coach\n---\n`;
    writeFileSync(join(root, "SKILL.md"), head + "x".repeat(1048576 - head.length));
    expect(ids()).toEqual(["coach"]);
    writeFileSync(join(root, "SKILL.md"), head + "x".repeat(1048577 - head.length));
    expect(ids()).toEqual([]);
  });
});

describe("registeredSkills: skill directories and manifest paths", () => {
  it("names a skill directory by the directory, rewritten as the loader rewrites it — never by its frontmatter", () => {
    manifest({ name: "plug" });
    skill("my.skill");
    skill("other skill");
    expect(ids().sort()).toEqual(["my-skill", "other-skill"]);
  });

  it("loads a manifest path that holds skill directories (string or array form)", () => {
    manifest({ name: "plug", skills: ["./custom"] });
    skill("a", "custom");
    skill("b", "custom");
    expect(ids().sort()).toEqual(["a", "b"]);
    manifest({ name: "plug", skills: "./custom" });
    expect(ids().sort()).toEqual(["a", "b"]);
  });

  it("loads skills/ AND the manifest paths: a manifest `skills` field does not stop skills/ loading", () => {
    manifest({ name: "plug", skills: ["./custom"] });
    skill("a", "custom");
    skill("x");
    expect(ids().sort()).toEqual(["a", "x"]);
  });

  it("a manifest path that IS a skill (SKILL.md directly in it) is named by its frontmatter, else its basename", () => {
    manifest({ name: "plug", skills: ["./custom/a"] });
    skill("a", "custom", "coach");
    expect(ids()).toEqual(["coach"]);
  });

  it("a manifest `./` beside skills/ loads both the root and skills/*", () => {
    manifest({ name: "plug", skills: ["./"] });
    rootMd("coach");
    skill("x");
    expect(ids().sort()).toEqual(["coach", "x"]);
  });

  it("a SKILL.md reached by two paths registers once, under the first path's name", () => {
    manifest({ name: "plug", skills: ["./skills/a"] });
    skill("a", "skills", "zed");
    expect(ids()).toEqual(["a"]);
  });

  it("a manifest path that escapes the plugin or does not exist loads nothing", () => {
    mkdirSync(join(base, "outside", "e"), { recursive: true });
    writeFileSync(join(base, "outside", "e", "SKILL.md"), "---\nname: e\n---\n");
    manifest({ name: "plug", skills: ["../outside", "./nope"] });
    expect(ids()).toEqual([]);
  });
});

describe("trackedSkill", () => {
  it("tracks a single skill directory by the id the loader registers, so a renamed directory still matches", () => {
    manifest({ name: "plug" });
    skill("my.skill");
    expect(trackedSkill(root, undefined)).toEqual({ name: "my-skill", id: "plug:my-skill" });
  });

  it("--skill takes the directory name or the registered name, both resolving to the registered id", () => {
    manifest({ name: "plug" });
    skill("my.skill");
    skill("other skill");
    expect(trackedSkill(root, "my.skill")).toEqual({ name: "my-skill", id: "plug:my-skill" });
    expect(trackedSkill(root, "my-skill")).toEqual({ name: "my-skill", id: "plug:my-skill" });
    expect(trackedSkill(root, "other skill")).toEqual({ name: "other-skill", id: "plug:other-skill" });
  });

  it("refuses a --skill whose registered id two directories share, naming both", () => {
    manifest({ name: "plug" });
    skill("my.skill");
    skill("my-skill");
    for (const sel of ["my-skill", "my.skill"])
      expect(() => trackedSkill(root, sel)).toThrow(/plug:my-skill is registered by both skills\/my-skill and skills\/my\.skill/);
  });

  it("a root SKILL.md beside a one-skill skills/ dir tracks the skill the binary loads: skills/<dir>", () => {
    manifest({ name: "plug" });
    rootMd("coach");
    skill("x");
    expect(trackedSkill(root, undefined)).toEqual({ name: "x", id: "plug:x" });
  });

  it("a plugin registering several skills omits the column, the note listing every registered name", () => {
    manifest({ name: "plug", skills: ["./"] });
    rootMd("coach");
    skill("x");
    const t = trackedSkill(root, undefined);
    expect(t.name).toBeUndefined();
    expect(t).toMatchObject({ note: expect.stringMatching(/several skills \(coach, x\).*pass --skill/) });
    expect(trackedSkill(root, "coach")).toEqual({ name: "coach", id: "plug:coach" });
    expect(trackedSkill(root, "x")).toEqual({ name: "x", id: "plug:x" });
  });

  it("manifest-path skills are selectable and listed", () => {
    manifest({ name: "plug", skills: ["./custom"] });
    skill("a", "custom");
    skill("x");
    expect(trackedSkill(root, undefined)).toMatchObject({ note: expect.stringMatching(/several skills \(a, x\)/) });
    expect(trackedSkill(root, "a")).toEqual({ name: "a", id: "plug:a" });
  });

  it("a plugin with no skill omits the column and says so", () => {
    manifest({ name: "plug", skills: ["./custom"] });
    rootMd("coach");
    const t = trackedSkill(root, undefined);
    expect(t.name).toBeUndefined();
    expect(t).toMatchObject({ note: expect.stringMatching(/registers no skill/) });
  });

  it("an unknown --skill throws naming the registered skills; a path-shaped one is refused", () => {
    skill("a");
    skill("b");
    expect(() => trackedSkill(root, "c")).toThrow(/--skill c: .* registers no skill c — its skills: a, b/);
    expect(() => trackedSkill(root, "../a")).toThrow(/--skill \.\.\/a/);
    expect(() => trackedSkill(root, "plug:a")).toThrow(/--skill plug:a/);
  });

  it("on a plugin whose one skill is its root SKILL.md, --skill takes its registered name and words a miss in hillclimb's terms", () => {
    manifest({ name: "plug" });
    rootMd("coach");
    expect(trackedSkill(root, "coach")).toEqual({ name: "coach", id: "plug:coach" });
    expect(() => trackedSkill(root, "plug-dir")).toThrow(
      "--skill plug-dir: this plugin has one skill, coach, tracked without --skill; pass --skill coach or drop it",
    );
  });
});

describe("trackedSkill against the git-tracked set (the files a pass snapshots)", () => {
  const git = (...a: string[]) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
  const prev = process.env.COWORK_HARNESS_GITSET;
  afterEach(() => {
    if (prev === undefined) delete process.env.COWORK_HARNESS_GITSET;
    else process.env.COWORK_HARNESS_GITSET = prev;
  });

  it("leaves an untracked skill out, and an untracked --skill says to git add it; COWORK_HARNESS_GITSET=0 opts out", () => {
    manifest({ name: "plug" });
    skill("a");
    skill("b");
    git("init", "-q");
    git("add", ".claude-plugin", "skills/a");
    delete process.env.COWORK_HARNESS_GITSET;
    expect(ids()).toEqual(["a"]);
    expect(trackedSkill(root, undefined)).toEqual({ name: "a", id: "plug:a" });
    expect(() => trackedSkill(root, "b")).toThrow(/--skill b: .*untracked.*git add/);
    process.env.COWORK_HARNESS_GITSET = "0";
    expect(ids().sort()).toEqual(["a", "b"]);
  });
});
