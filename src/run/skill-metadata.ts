import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

/** Splits a SKILL.md's leading `---\n...\n---` YAML frontmatter block from the rest of the file.
 *  Returns `undefined` if the file doesn't start with a frontmatter block at all (no crash — a
 *  malformed/missing frontmatter is just "no metadata available for this skill", not fatal). */
function parseFrontmatter(content: string): Record<string, unknown> | undefined {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) return undefined;
  const end = content.indexOf("\n---", 4);
  if (end === -1) return undefined;
  const yamlBlock = content.slice(content.indexOf("\n") + 1, end);
  try {
    const parsed = parse(yamlBlock);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads every staged skill's `SKILL.md` frontmatter under `<workRoot>/.claude/skills/*` (§6.2, O1).
 * `id` is the skill's DIRECTORY basename (not the frontmatter's own `name:` key, which may differ or
 * be absent) — this matches how the skill is actually addressed elsewhere (e.g. the `Skill` tool's
 * `input.skill` value, which the harness's staging step names after the source directory).
 * `whenToUse` prefers `description`, falls back to `when_to_use`, omitted if neither is present.
 * Never throws: a missing `.claude/skills` directory, a skill with no `SKILL.md`, or a `SKILL.md`
 * with no/malformed frontmatter are all silently skipped — this is a best-effort listing, not a
 * validation pass (the scenario linter is responsible for validating a skill's own frontmatter).
 */
export function readAvailableSkills(workRoot: string): Array<{ id: string; whenToUse?: string }> {
  const skillsDir = join(workRoot, ".claude", "skills");
  let entries: string[];
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const out: Array<{ id: string; whenToUse?: string }> = [];
  for (const id of entries) {
    let content: string;
    try {
      content = readFileSync(join(skillsDir, id, "SKILL.md"), "utf8");
    } catch {
      continue;
    }
    const fm = parseFrontmatter(content);
    if (!fm) continue;
    const whenToUse = typeof fm.description === "string" ? fm.description : typeof fm.when_to_use === "string" ? fm.when_to_use : undefined;
    out.push({ id, whenToUse });
  }
  return out;
}
