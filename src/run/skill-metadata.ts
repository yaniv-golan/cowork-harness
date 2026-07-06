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

/** A staged plugin's skill-source root, for whenToUse enrichment of `<plugin>:<skill>` ids. */
export interface PluginSkillRoot {
  pluginName: string; // the plugin's `.claude-plugin/plugin.json` `name` (the `<plugin>` half of `<plugin>:<skill>`)
  hostPath: string; // host dir of the plugin root (contains `.claude-plugin/` and the skills subdir)
  skillsSubdir: string; // relative subdir holding the skill dirs (from plugin.json `skills`, default "skills")
}

/**
 * Resolves the Context/Connectors panel's available-skill listing (§6.2, O1). The SPINE is `ids` — the
 * authoritative skill-id list from the agent's `init` event (bare `<skill>` for `skills.local`,
 * `<plugin>:<skill>` for plugin/marketplace skills). Each id is enriched with `whenToUse` read from its
 * staged `SKILL.md` frontmatter where findable — local skills at `<configDir>/skills/<id>/SKILL.md`,
 * plugin skills at `<pluginRoot.hostPath>/<skillsSubdir>/<skill>/SKILL.md`. An id whose SKILL.md can't be
 * found (or has no/malformed frontmatter) still appears, id-only — the init event, not the disk, is the
 * source of truth for WHICH skills are available; the disk is only consulted to enrich the description.
 * Never throws (best-effort enrichment). Preserves `ids` order.
 */
export function resolveAvailableSkills(
  ids: string[],
  configDir: string,
  pluginRoots: PluginSkillRoot[],
): Array<{ id: string; whenToUse?: string }> {
  const whenToUseById = new Map<string, string>();
  const readWhenToUse = (skillMdPath: string): string | undefined => {
    let content: string;
    try {
      content = readFileSync(skillMdPath, "utf8");
    } catch {
      return undefined;
    }
    const fm = parseFrontmatter(content);
    if (!fm) return undefined;
    return typeof fm.description === "string" ? fm.description : typeof fm.when_to_use === "string" ? fm.when_to_use : undefined;
  };
  // Local skills.local: <configDir>/skills/<dir>/SKILL.md, keyed by bare <dir>.
  try {
    for (const e of readdirSync(join(configDir, "skills"), { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const w = readWhenToUse(join(configDir, "skills", e.name, "SKILL.md"));
      if (w !== undefined) whenToUseById.set(e.name, w);
    }
  } catch {
    /* no configDir/skills — fine */
  }
  // Plugin skills: <hostPath>/<skillsSubdir>/<dir>/SKILL.md, keyed by <pluginName>:<dir>.
  for (const root of pluginRoots) {
    const skillsDir = join(root.hostPath, root.skillsSubdir);
    let dirs: string[];
    try {
      dirs = readdirSync(skillsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const dir of dirs) {
      const w = readWhenToUse(join(skillsDir, dir, "SKILL.md"));
      if (w !== undefined) whenToUseById.set(`${root.pluginName}:${dir}`, w);
    }
  }
  return ids.map((id) => {
    const w = whenToUseById.get(id);
    return w !== undefined ? { id, whenToUse: w } : { id };
  });
}
