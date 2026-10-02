import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeSkillInvocationVerdict, gradedSkillNameFor } from "../src/critique/command.js";
import { snapshotTurnBoundary } from "../src/critique/evidence.js";
import { evidenceFacts } from "../src/eval/invocation.js";
import type { RunResult } from "../src/types.js";

// The agent registers a `skills/<dir>` skill as `<plugin>:<dir>` with every character outside [a-zA-Z0-9_-]
// rewritten to "-" (src/skill-id.ts). critique and eval select the skill by its DIRECTORY name, so a dir named
// `my.skill` or `other skill` is observed as `<plugin>:my-skill` / `<plugin>:other-skill`. Matching the raw dir
// name read every such run as "not invoked" — critique's verdict and eval's invocation column, both wrong.

const tmpDirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  tmpDirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function makePlugin(skillDir: string): string {
  const root = join(tmp("cwh-sanit-"), "plug");
  mkdirSync(join(root, "skills", skillDir), { recursive: true });
  writeFileSync(join(root, "skills", skillDir, "SKILL.md"), `---\nname: ${skillDir}\n---\n# ${skillDir}\n`);
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "plug" }));
  return root;
}

function makeRun(result: Record<string, unknown>): string {
  const outDir = tmp("cwh-sanit-run-");
  mkdirSync(join(outDir, "turns", "1"), { recursive: true });
  writeFileSync(join(outDir, "turns", "1", "result.json"), JSON.stringify(result));
  writeFileSync(join(outDir, "events.jsonl"), "");
  writeFileSync(join(outDir, "timeline.jsonl"), "");
  return outDir;
}

function critiqueVerdict(skillDir: string, observedId: string): boolean | undefined {
  const pluginRoot = makePlugin(skillDir);
  const result = { prompt: "prose", context: { availableSkills: [{ id: observedId }] }, skillActivity: [{ skillId: observedId }] };
  const outDir = makeRun(result);
  const resolved = { skillDir: join(pluginRoot, "skills", skillDir), pluginRoot, autoSelectedSkill: undefined, gradedSkillName: skillDir };
  return computeSkillInvocationVerdict({
    outDir,
    boundary: snapshotTurnBoundary(outDir),
    taskRaw: result,
    resolved,
    gradedSkillName: gradedSkillNameFor(skillDir, resolved),
  });
}

function evalInvoked(skillDir: string, observedId: string): EvidenceInvoked {
  const pluginRoot = makePlugin(skillDir);
  const result = { prompt: "prose", context: { availableSkills: [{ id: observedId }] }, skillActivity: [{ skillId: observedId }] };
  const outDir = makeRun(result);
  return evidenceFacts({ result: { ...result, outDir } as unknown as RunResult, skillName: skillDir, pluginRoot }).invoked;
}
type EvidenceInvoked = ReturnType<typeof evidenceFacts>["invoked"];

describe("critique: a skill dir whose name the agent rewrites", () => {
  it("a dotted dir name (my.skill) invoked as plug:my-skill reads as invoked", () => {
    expect(critiqueVerdict("my.skill", "plug:my-skill")).toBe(true);
  });
  it("a spaced dir name (other skill) invoked as plug:other-skill reads as invoked", () => {
    expect(critiqueVerdict("other skill", "plug:other-skill")).toBe(true);
  });
  it("a different skill whose id only extends the rewritten name still does not count", () => {
    expect(critiqueVerdict("my.skill", "plug:my-skill-lite")).toBe(false);
  });
});

describe("eval: the invocation column for a skill dir whose name the agent rewrites", () => {
  it("a dotted dir name (my.skill) invoked as plug:my-skill reads as invoked", () => {
    expect(evalInvoked("my.skill", "plug:my-skill")).toBe(true);
  });
  it("a spaced dir name (other skill) invoked as plug:other-skill reads as invoked", () => {
    expect(evalInvoked("other skill", "plug:other-skill")).toBe(true);
  });
  it("another plugin's skill with the rewritten name still does not count", () => {
    expect(evalInvoked("my.skill", "elsewhere:my-skill")).toBe(false);
  });
});
