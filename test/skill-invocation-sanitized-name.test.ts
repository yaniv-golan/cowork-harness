import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeSkillInvocationVerdict, gradedSkillNameFor, resolveCritiquedSkillDir } from "../src/critique/command.js";
import { snapshotTurnBoundary } from "../src/critique/evidence.js";
import { evidenceFacts } from "../src/eval/invocation.js";
import type { RunResult } from "../src/types.js";

// The agent registers a `skills/<dir>` skill as `<plugin>:<dir>` with every character outside [a-zA-Z0-9_-]
// rewritten to "-" (src/skill-id.ts), and a root SKILL.md by its frontmatter `name`, rewritten the same way. A
// command file registers `<plugin>:<file stem>` as it is. critique and eval select the skill by its DIRECTORY
// name, so a dir named `my.skill` or `other skill` is observed as `<plugin>:my-skill` / `<plugin>:other-skill`.
// Matching the raw dir name read every such run as "not invoked" — critique's verdict and eval's invocation
// column, both wrong. Every case goes through the real resolver, as both commands do.

const tmpDirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  tmpDirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function makePlugin(skillDirs: string[], commands: string[] = []): string {
  const root = join(tmp("cwh-sanit-"), "plug");
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "plug" }));
  for (const d of skillDirs) {
    mkdirSync(join(root, "skills", d), { recursive: true });
    writeFileSync(join(root, "skills", d, "SKILL.md"), `---\nname: ${d}\n---\n# ${d}\n`);
  }
  for (const c of commands) {
    mkdirSync(join(root, "commands"), { recursive: true });
    writeFileSync(join(root, "commands", `${c}.md`), "# a command\n");
  }
  return root;
}

function makeRun(observedId: string): { outDir: string; result: Record<string, unknown> } {
  const outDir = tmp("cwh-sanit-run-");
  const result = { prompt: "prose", context: { availableSkills: [{ id: observedId }] }, skillActivity: [{ skillId: observedId }] };
  mkdirSync(join(outDir, "turns", "1"), { recursive: true });
  writeFileSync(join(outDir, "turns", "1", "result.json"), JSON.stringify(result));
  writeFileSync(join(outDir, "events.jsonl"), "");
  writeFileSync(join(outDir, "timeline.jsonl"), "");
  return { outDir, result };
}

function critiqueVerdict(folder: string, selector: string | undefined, observedId: string): boolean | undefined {
  const resolved = resolveCritiquedSkillDir(folder, selector);
  const { outDir, result } = makeRun(observedId);
  return computeSkillInvocationVerdict({
    outDir,
    boundary: snapshotTurnBoundary(outDir),
    taskRaw: result,
    resolved,
    gradedSkillName: gradedSkillNameFor(selector, resolved),
  });
}

/** eval's path: the skill name from the same resolver (eval/command.ts), then evidenceFacts over the run. */
function evalInvoked(pluginRoot: string, selector: string, observedId: string): ReturnType<typeof evidenceFacts>["invoked"] {
  const skillName = gradedSkillNameFor(selector, resolveCritiquedSkillDir(pluginRoot, selector));
  const { outDir, result } = makeRun(observedId);
  return evidenceFacts({ result: { ...result, outDir } as unknown as RunResult, skillName, pluginRoot }).invoked;
}

describe("critique: a skill dir whose name the agent rewrites", () => {
  it("a dotted dir name (my.skill) invoked as plug:my-skill reads as invoked", () => {
    expect(critiqueVerdict(makePlugin(["my.skill"]), "my.skill", "plug:my-skill")).toBe(true);
  });
  it("a spaced dir name (other skill) invoked as plug:other-skill reads as invoked", () => {
    expect(critiqueVerdict(makePlugin(["other skill"]), "other skill", "plug:other-skill")).toBe(true);
  });
  it("a different skill whose id only extends the rewritten name still does not count", () => {
    expect(critiqueVerdict(makePlugin(["my.skill"]), "my.skill", "plug:my-skill-lite")).toBe(false);
  });
  it("a bare id counts as written or as rewritten", () => {
    expect(critiqueVerdict(makePlugin(["my.skill"]), "my.skill", "my-skill")).toBe(true);
    expect(critiqueVerdict(makePlugin(["my.skill"]), "my.skill", "my.skill")).toBe(true);
  });
});

describe("critique: ids the rewrite makes ambiguous", () => {
  it("a command whose stem equals the rewritten name shadows the skill: undecidable, never true", () => {
    // commands/my-skill.md registers plug:my-skill as it is; skills/my.skill registers plug:my-skill too.
    expect(critiqueVerdict(makePlugin(["my.skill"], ["my-skill"]), "my.skill", "plug:my-skill")).toBe(undefined);
  });
  it("a command named like the RAW dir does not collide (plug:my.skill is a different id)", () => {
    expect(critiqueVerdict(makePlugin(["my.skill"], ["my.skill"]), "my.skill", "plug:my-skill")).toBe(true);
  });
  it("two skill dirs that rewrite to the same id: undecidable, never true", () => {
    expect(critiqueVerdict(makePlugin(["my.skill", "my-skill"]), "my.skill", "plug:my-skill")).toBe(undefined);
  });
  it("a symlinked skill dir that registers the same id counts as a second skill", () => {
    const root = makePlugin(["my.skill"]);
    const elsewhere = join(tmp("cwh-sanit-ext-"), "real");
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, "SKILL.md"), "---\nname: real\n---\n# real\n");
    symlinkSync(elsewhere, join(root, "skills", "my-skill"));
    expect(critiqueVerdict(root, "my.skill", "plug:my-skill")).toBe(undefined);
  });
  it("a skill in a manifest `skills` path that registers the same id counts as a second skill", () => {
    const root = makePlugin(["my.skill"]);
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "plug", skills: ["./skills", "./extra"] }));
    mkdirSync(join(root, "extra", "my-skill"), { recursive: true });
    writeFileSync(join(root, "extra", "my-skill", "SKILL.md"), "---\nname: my-skill\n---\n# my-skill\n");
    expect(critiqueVerdict(root, "my.skill", "plug:my-skill")).toBe(undefined);
  });
});

describe("critique: a root SKILL.md the plugin could not promote is named by its frontmatter", () => {
  it("frontmatter `name: fancy-name` in dir x registers x:fancy-name, and that is what counts", () => {
    const outer = join(tmp("cwh-sanit-"), "outer");
    mkdirSync(join(outer, ".claude-plugin"), { recursive: true });
    writeFileSync(join(outer, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "outer" }));
    const sk = join(outer, "other", "x");
    mkdirSync(sk, { recursive: true });
    writeFileSync(join(sk, "SKILL.md"), "---\nname: fancy-name\n---\nbody\n");
    expect(critiqueVerdict(sk, undefined, "x:fancy-name")).toBe(true);
    expect(critiqueVerdict(sk, undefined, "x:x")).toBe(false);
  });
});

describe("eval: the invocation column for a skill dir whose name the agent rewrites", () => {
  it("a dotted dir name (my.skill) invoked as plug:my-skill reads as invoked", () => {
    expect(evalInvoked(makePlugin(["my.skill"]), "my.skill", "plug:my-skill")).toBe(true);
  });
  it("a spaced dir name (other skill) invoked as plug:other-skill reads as invoked", () => {
    expect(evalInvoked(makePlugin(["other skill"]), "other skill", "plug:other-skill")).toBe(true);
  });
  it("another plugin's skill with the rewritten name still does not count", () => {
    expect(evalInvoked(makePlugin(["my.skill"]), "my.skill", "elsewhere:my-skill")).toBe(false);
  });
  it("two skill dirs that rewrite to the same id: unobservable, never true", () => {
    expect(evalInvoked(makePlugin(["my.skill", "my-skill"]), "my.skill", "plug:my-skill")).toBe("unobservable");
  });
});
