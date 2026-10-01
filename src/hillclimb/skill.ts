// Which skill the rows' `skill_invoked` column tracks: the id the agent binary registers it under, matched against the
// run's observed skill ids (`skillInvocationFromRecord`, which takes the `<plugin>` qualifier from the plugin root
// itself). Resolved against the variant's snapshot — the plugin the runs mount — never the live plugin the loop
// edits; a dry run and state-template, which have no snapshot, read the live plugin's git-tracked files, the set a
// snapshot would copy.
//
// The skills a plugin registers follow the plugin skill loader of the staged agent (2.1.284):
//  - skills paths, in order: skills/ whenever it exists; then each entry of the manifest's `skills` field (a string or
//    an array of paths relative to the plugin root; an entry must be an existing directory inside the plugin, and
//    skills/ itself is dropped); the plugin root only when the manifest has no `skills` field and there is no skills/;
//  - per path: a SKILL.md directly in it that is a regular file of at most 1 MiB is ONE skill, named by its
//    frontmatter `name` (minus a leading "<plugin>:") or else the path's basename; otherwise (no SKILL.md, or one the
//    loader skips) every directory or symlink in the path holding such a SKILL.md is a skill named by its directory;
//  - a SKILL.md reached twice (by real path) registers once, the first time;
//  - the id is `registeredSkillId(<plugin>, <name>)`, which rewrites the name's characters outside [a-zA-Z0-9_-].
//
// `--skill <name>` selects among those skills by a skill directory's name (critique's selector semantics), by the
// registered name, or by a manifest path's basename. Without it, a plugin's only skill is tracked; a plugin with
// several is not, and the note lists them and says to pass --skill.

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { registeredSkillId, sanitizeSkillName } from "../skill-id.js";
import { gitAccept, gitModeEnabled, gitTrackedSet } from "../run/skill-files.js";
import { readSkillFrontmatterName, SKILL_MD_MAX_BYTES } from "../run/skill-metadata.js";

export type TrackedSkill =
  | {
      /** The registered name (the id's half after `<plugin>:`). */
      name: string;
      /** The full registered id, `<plugin>:<name>`: what `meta.skill_tracked` records. */
      id: string;
    }
  | { name: undefined; note: string };

export interface RegisteredSkill {
  /** The registered name: the id's half after `<plugin>:`. */
  id: string;
  /** The skill's directory, plugin-root-relative POSIX (`.` for the root). */
  dir: string;
  /** What `--skill` accepts for it. */
  selectableAs: string[];
  /** The SKILL.md is directly in a skills path (the root, or a manifest path naming one skill). */
  direct: boolean;
}

/** The plugin's deliverable files: its git-tracked set (the stager's delivery rule, as a snapshot applies it), or
 *  null for every file (not a work tree, or `COWORK_HARNESS_GITSET=0`). A snapshot sits outside every work tree,
 *  so a pass reads every file of it — the tracked files it was copied from. */
function deliverable(pluginRoot: string): ((rel: string) => boolean) | null {
  if (!gitModeEnabled()) return null;
  const tracked = gitTrackedSet(pluginRoot);
  return tracked ? gitAccept(tracked) : null;
}

const posix = (p: string): string => p.split(sep).join("/");

interface Ctx {
  root: string;
  accept: ((rel: string) => boolean) | null;
}

const rel = (c: Ctx, p: string): string => posix(relative(c.root, p)) || ".";
/** Delivered: on disk and, in git mode, tracked (a file) or holding a tracked file (a directory). A path through a
 *  tracked symlink counts through that link. */
function delivered(c: Ctx, p: string): boolean {
  if (c.accept === null) return true;
  const r = rel(c, p);
  if (r === "." || c.accept(r)) return true;
  const parts = r.split("/");
  for (let i = 1; i < parts.length; i++) {
    const anc = parts.slice(0, i).join("/");
    if (c.accept(anc) && lstatSync(join(c.root, anc), { throwIfNoEntry: false })?.isSymbolicLink()) return true;
  }
  return false;
}

/** The loader's read of a SKILL.md: a regular file (symlinks followed) of at most 1 MiB, and delivered. */
function loadableSkillMd(c: Ctx, md: string): boolean {
  try {
    const st = statSync(md);
    return st.isFile() && st.size <= SKILL_MD_MAX_BYTES && delivered(c, md);
  } catch {
    return false;
  }
}

function isDir(c: Ctx, p: string): boolean {
  try {
    return statSync(p).isDirectory() && delivered(c, p);
  } catch {
    return false;
  }
}

function manifestOf(c: Ctx): { name?: unknown; skills?: unknown } | undefined {
  const p = join(c.root, ".claude-plugin", "plugin.json");
  if (!loadableFile(c, p)) return undefined;
  try {
    const m = JSON.parse(readFileSync(p, "utf8")) as unknown;
    return m !== null && typeof m === "object" && !Array.isArray(m) ? (m as { name?: unknown; skills?: unknown }) : undefined;
  } catch {
    return undefined;
  }
}

function loadableFile(c: Ctx, p: string): boolean {
  try {
    return statSync(p).isFile() && delivered(c, p);
  } catch {
    return false;
  }
}

/** The plugin name the binary qualifies its skills with: the manifest `name`, else the root's basename. */
function pluginNameOf(c: Ctx): string {
  const n = manifestOf(c)?.name;
  return typeof n === "string" && n ? n : basename(c.root);
}

function inside(child: string, parent: string): boolean {
  const r = relative(parent, child);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

/** The skills path list, in the loader's order. */
function skillsPaths(c: Ctx): string[] {
  const skillsDir = join(c.root, "skills");
  const paths: string[] = [];
  const hasSkillsDir = isDir(c, skillsDir);
  if (hasSkillsDir) paths.push(skillsDir);
  const raw = manifestOf(c)?.skills;
  if (raw !== undefined && raw !== null && raw !== "" && !(Array.isArray(raw) && raw.length === 0)) {
    let realRoot: string;
    try {
      realRoot = realpathSync(c.root);
    } catch {
      return paths;
    }
    for (const e of Array.isArray(raw) ? raw : [raw]) {
      if (typeof e !== "string") continue;
      const p = resolve(c.root, e);
      if (!inside(p, c.root)) continue;
      let real: string;
      try {
        real = realpathSync(p);
      } catch {
        continue;
      }
      if (!inside(real, realRoot) || !isDir(c, p)) continue;
      if (resolve(p) === resolve(skillsDir)) continue;
      paths.push(p);
    }
  } else if (!hasSkillsDir) paths.push(c.root);
  return paths;
}

/** Every skill the binary registers for the plugin at `pluginRoot`, in load order. */
export function registeredSkills(pluginRoot: string): RegisteredSkill[] {
  const c: Ctx = { root: pluginRoot, accept: deliverable(pluginRoot) };
  const plugin = pluginNameOf(c);
  const seen = new Set<string>();
  const out: RegisteredSkill[] = [];
  const add = (md: string, s: RegisteredSkill) => {
    let real: string;
    try {
      real = realpathSync(md);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    out.push(s);
  };
  for (const p of skillsPaths(c)) {
    const md = join(p, "SKILL.md");
    if (loadableSkillMd(c, md)) {
      const fm = readSkillFrontmatterName(md) ?? "";
      const name = sanitizeSkillName((fm.startsWith(`${plugin}:`) ? fm.slice(plugin.length + 1) : fm) || basename(p));
      const dir = rel(c, p);
      add(md, { id: name, dir, selectableAs: dir === "." ? [name] : [name, basename(p)], direct: true });
      continue;
    }
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(p, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const sub = join(p, e.name);
      const smd = join(sub, "SKILL.md");
      if (!loadableSkillMd(c, smd)) continue;
      const name = sanitizeSkillName(e.name);
      add(smd, { id: name, dir: rel(c, sub), selectableAs: [e.name, name], direct: false });
    }
  }
  return out;
}

/** The skill the rows track for the plugin at `pluginRoot` (the variant's snapshot, or the live plugin's tracked
 *  files under a dry run). A `selector` that names no registered skill, or one whose id another skill shares,
 *  throws a refusal naming the plugin's skills. */
export function trackedSkill(pluginRoot: string, selector: string | undefined): TrackedSkill {
  const skills = registeredSkills(pluginRoot);
  const plugin = pluginNameOf({ root: pluginRoot, accept: deliverable(pluginRoot) });
  const names = [...new Set(skills.map((s) => s.id))].sort();
  const pick = (s: RegisteredSkill): TrackedSkill => {
    const sharing = skills.filter((o) => o.id === s.id);
    if (sharing.length > 1)
      throw new Error(
        `--skill ${selector ?? s.id}: ${registeredSkillId(plugin, s.id)} is registered by both ${sharing.map((o) => o.dir).join(" and ")}, so skill_invoked could not tell them apart — rename one`,
      );
    return { name: s.id, id: registeredSkillId(plugin, s.id) };
  };
  if (selector !== undefined) {
    if (selector === "" || selector === "." || selector === ".." || /[/\\:]/.test(selector))
      throw new Error(
        `--skill ${selector}: a skill name, not a path or a qualified id — the plugin's skills: ${names.join(", ") || "none"}`,
      );
    const matched = skills.filter((s) => s.selectableAs.includes(selector));
    if (matched.length > 1 && new Set(matched.map((s) => s.id)).size > 1)
      throw new Error(
        `--skill ${selector}: names more than one skill (${matched.map((s) => s.dir).join(", ")}) — pass a registered name: ${names.join(", ")}`,
      );
    if (matched.length) return pick(matched[0]!);
    if (skills.length === 1 && skills[0]!.direct && skills[0]!.dir === ".")
      throw new Error(
        `--skill ${selector}: this plugin has one skill, ${skills[0]!.id}, tracked without --skill; pass --skill ${skills[0]!.id} or drop it`,
      );
    const c: Ctx = { root: pluginRoot, accept: deliverable(pluginRoot) };
    const md = join(pluginRoot, "skills", selector, "SKILL.md");
    const untracked = c.accept !== null && existsSync(md) && !delivered(c, md);
    throw new Error(
      untracked
        ? `--skill ${selector}: skills/${selector}/SKILL.md is untracked — the stager delivers git-tracked files only, so the runs would not see it; 'git add' it`
        : `--skill ${selector}: ${pluginRoot} registers no skill ${selector} — ${names.length ? `its skills: ${names.join(", ")}` : "it registers no skill at all"}`,
    );
  }
  if (skills.length === 1) return pick(skills[0]!);
  return skills.length > 1
    ? {
        name: undefined,
        note: `the plugin registers several skills (${names.join(", ")}): skill_invoked is omitted — pass --skill <name> to record one`,
      }
    : { name: undefined, note: "the plugin registers no skill: skill_invoked is omitted" };
}
