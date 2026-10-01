import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { gitCpFilter, gitModeEnabled } from "./skill-files.js";

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
  /** The mount's precomputed staging filter (git mode), or undefined for a raw copy. Applied when
   *  enumerating skill dirs so the catalog reports what the agent WILL RECEIVE, not what the source tree
   *  happens to contain — a fully-untracked skill folder is excluded from staging with only a notice
   *  (the hard-fail fires only when the whole plugin has 0 tracked files), so without this the handler
   *  would advertise a skill the agent never got. */
  stageFilter?: (src: string, dest: string) => boolean;
}

/** Read a SKILL.md's frontmatter `description` (falling back to `when_to_use`). Best-effort: a missing
 *  file, unreadable file, or malformed/absent frontmatter all just return `undefined` — never throws.
 *  Shared by `resolveAvailableSkills` (RunResult.context.availableSkills) and `listMountedSkills` (the
 *  A2 skills SDK-MCP handler's mounted-skill catalog) so both read the exact same two frontmatter keys. */
export function readSkillDescription(skillMdPath: string): string | undefined {
  let content: string;
  try {
    content = readFileSync(skillMdPath, "utf8");
  } catch {
    return undefined;
  }
  const fm = parseFrontmatter(content);
  if (!fm) return undefined;
  return typeof fm.description === "string" ? fm.description : typeof fm.when_to_use === "string" ? fm.when_to_use : undefined;
}

/** Read a SKILL.md's frontmatter `name`, trimmed; `undefined` when the file, the frontmatter or a non-empty
 *  string `name` is missing. Best-effort like `readSkillDescription`, over the same frontmatter split. */
export function readSkillFrontmatterName(skillMdPath: string): string | undefined {
  let content: string;
  try {
    content = readFileSync(skillMdPath, "utf8");
  } catch {
    return undefined;
  }
  const n = parseFrontmatter(content)?.name;
  return typeof n === "string" && n.trim() !== "" ? n.trim() : undefined;
}

/** A mounted skill, as the skills SDK-MCP server's stub sees it: `name` is the bare skill-dir name for a
 *  `skills.local` entry, or `<pluginName>:<dir>` for a plugin-provided one (same id scheme
 *  `resolveAvailableSkills` uses for `<plugin>:<skill>` ids). `isUserCreated` mirrors the real handler's
 *  `is_user_created` field on `suggest_skills.resolved_skills` — modeled here as "staged via
 *  `skills.local`" vs. "came from a plugin", the closest analog the harness can observe. */
export interface MountedSkill {
  name: string;
  description?: string;
  isUserCreated: boolean;
}

/**
 * Enumerate every skill actually staged for this session — the skills SDK-MCP server's "installed"
 * catalog (`list_skills`'s `resolved_skills` / `installed_plugins` are built from this, and the same
 * install set backs `suggest_skills`'s echo). Local skills are read straight off `<configDir>/skills/*`;
 * plugin skills off each `pluginRoots` entry's `<hostPath>/<skillsSubdir>/*`. Best-effort throughout: a
 * missing/unreadable directory yields no entries for that source rather than throwing.
 */
export function listMountedSkills(configDir: string, pluginRoots: PluginSkillRoot[]): MountedSkill[] {
  const out: MountedSkill[] = [];
  try {
    for (const e of readdirSync(join(configDir, "skills"), { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      out.push({
        name: e.name,
        description: readSkillDescription(join(configDir, "skills", e.name, "SKILL.md")),
        isUserCreated: true,
      });
    }
  } catch {
    /* no configDir/skills — fine */
  }
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
    // Mirror `runtime/stage.ts`'s own precedence exactly: prefer the plan-build filter, else derive one
    // when git mode is on. `stageFilter` is undefined on RESUME (buildLaunchPlan skips it because nothing
    // is re-staged) — but the persisted mnt tree WAS filtered on the original run, so without this
    // fallback a resumed run's catalog over-lists a skill the sandbox does not have. Derived once per
    // plugin root, not per skill dir.
    const filter = root.stageFilter ?? (gitModeEnabled() ? gitCpFilter(root.hostPath) : null);
    for (const dir of dirs) {
      if (filter && !filter(join(skillsDir, dir), "")) continue;
      out.push({
        name: `${root.pluginName}:${dir}`,
        description: readSkillDescription(join(skillsDir, dir, "SKILL.md")),
        isUserCreated: false,
      });
    }
  }
  return out;
}

/**
 * Resolves the Context/Connectors panel's available-skill listing. The SPINE is `ids` — the
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
  // Local skills.local: <configDir>/skills/<dir>/SKILL.md, keyed by bare <dir>.
  try {
    for (const e of readdirSync(join(configDir, "skills"), { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const w = readSkillDescription(join(configDir, "skills", e.name, "SKILL.md"));
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
      const w = readSkillDescription(join(skillsDir, dir, "SKILL.md"));
      if (w !== undefined) whenToUseById.set(`${root.pluginName}:${dir}`, w);
    }
  }
  return ids.map((id) => {
    const w = whenToUseById.get(id);
    return w !== undefined ? { id, whenToUse: w } : { id };
  });
}
