// Which skill the rows' `skill_invoked` column tracks: a name the run's skill ids are matched against
// (`skillInvocationFromRecord`, which takes the `<plugin>` qualifier from the plugin root itself), resolved
// against the variant's snapshot — the plugin the runs mount — never the live plugin the loop edits.
//
// `--skill <name>` selects skills/<name>/ with critique's selector semantics and refusals (resolveCritiquedSkillDir).
// Without it: a SKILL.md at the plugin root the binary loads, or a plugin's only skills/<name>/, is tracked; a
// multi-skill plugin is not, and the note says to pass --skill.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { gradedSkillNameFor, resolveCritiquedSkillDir } from "../critique/command.js";
import { binaryPluginIdentity } from "../session.js";
import { readSkillFrontmatterName } from "../run/skill-metadata.js";

export type TrackedSkill = { name: string } | { name: undefined; note: string };

/** Does the manifest's `skills` field name the plugin root itself (`./`, as `claude plugin create` writes it)? */
function manifestSkills(pluginRoot: string): { declared: boolean; root: boolean } {
  let raw: unknown;
  try {
    raw = (JSON.parse(readFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8")) as { skills?: unknown }).skills;
  } catch {
    return { declared: false, root: false };
  }
  if (raw === undefined || raw === null) return { declared: false, root: false };
  const entries = (Array.isArray(raw) ? raw : [raw]).filter((e): e is string => typeof e === "string");
  const root = entries.some((e) => ["", "."].includes(e.replace(/^\.\//, "").replace(/\/+$/, "")));
  return { declared: true, root };
}

/** The id's skill half the agent binary registers for a SKILL.md at the plugin root, or undefined when the binary
 *  would not load it as a skill. Read from the shipped loader: the root is a skills path when the manifest has no
 *  `skills` field and there is no skills/ dir, or when `skills` names the root; the skill is then
 *  `<plugin>:<frontmatter name, minus a leading "<plugin>:", else the root's basename>`, with every character
 *  outside [a-zA-Z0-9_-] replaced by "-". */
export function rootSkillName(pluginRoot: string): string | undefined {
  const md = join(pluginRoot, "SKILL.md");
  if (!existsSync(md)) return undefined;
  const m = manifestSkills(pluginRoot);
  if (!(m.declared ? m.root : !existsSync(join(pluginRoot, "skills")))) return undefined;
  const plugin = binaryPluginIdentity(pluginRoot).name;
  const fm = readSkillFrontmatterName(md) ?? "";
  const name = (fm.startsWith(`${plugin}:`) ? fm.slice(plugin.length + 1) : fm) || basename(pluginRoot);
  return name.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function pluginSkills(pluginRoot: string): string[] {
  try {
    return readdirSync(join(pluginRoot, "skills"), { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(pluginRoot, "skills", e.name, "SKILL.md")))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** The skill the rows track for the plugin at `pluginRoot` (the variant's snapshot). An unknown `selector` throws
 *  critique's refusal, which names the plugin's skills. */
export function trackedSkill(pluginRoot: string, selector: string | undefined): TrackedSkill {
  if (selector !== undefined) return { name: gradedSkillNameFor(selector, resolveCritiquedSkillDir(pluginRoot, selector))! };
  const root = rootSkillName(pluginRoot);
  if (root !== undefined) return { name: root };
  // The binary loads skills/<dir>/ whenever that dir exists (a root SKILL.md beside it is not loaded), and names
  // each skill by its directory: a plugin's only skill is critique's auto-selection.
  const skills = pluginSkills(pluginRoot);
  if (skills.length === 1) return { name: skills[0]! };
  return skills.length > 1
    ? {
        name: undefined,
        note: `the plugin has several skills (${skills.join(", ")}): skill_invoked is omitted — pass --skill <name> to record one`,
      }
    : { name: undefined, note: "the plugin has no single skill to record invocation for: skill_invoked is omitted" };
}
