// Which hook events a run may have a hook on that BLOCKS when it fails (agent 2.1.295+).
//
// A command hook (not `async` / `asyncRewake`) or an http hook that sets `onFailure: "block"` turns its own failure
// (an exit other than 0 and 2, an HTTP status outside 2xx) or its timeout into a block. The agent emits the hook's
// `hook_response` frame BEFORE that conversion, so the frame still reads `error` / `cancelled`, and nothing on it says
// the hook blocked. The hook keys therefore need to know, per event, whether such a hook could have run: this module
// reads every hook source the agent could load for the run and lists the events.
//
// Event-level only. A frame's `hook_name` is `<event>:<tool>`, which names no hook, and matchers / `if` conditions are
// not modelled, so one eligible hook on an event taints every failed frame of that event.
//
// Privacy: the result carries event names and counts, never a path, a server name or a hook command.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

/** `{events}` (sorted, often empty), or `{unknown}` when a hook source exists but could not be read or parsed. */
export type HookFailureBlocks = { events: string[] } | { unknown: true; why: string };

/** Events where the agent logs the failure and does not block (its exempt set). */
export const ONFAILURE_EXEMPT_EVENTS: ReadonlySet<string> = new Set(["Stop", "SubagentStop", "TaskCompleted", "TeammateIdle"]);

/** Events the agent runs through its outside-REPL runner, which streams NO `hook_response` frame at all: a block
 *  there (an exit 2, or a converted failure) is invisible on the stream. */
export const FRAMELESS_HOOK_EVENTS: ReadonlySet<string> = new Set([
  "PreCompact",
  "PostCompact",
  "ConfigChange",
  "DirectoryAdded",
  "Elicitation",
  "ElicitationResult",
  "InstructionsLoaded",
  "Notification",
  "SessionEnd",
  "StopFailure",
  "WorktreeCreate",
  "WorktreeRemove",
  "CwdChanged",
  "FileChanged",
]);

/** The events on which `CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG` makes the user's own sync hooks block on failure. */
const PERSONAL_BLOCK_EVENTS: ReadonlySet<string> = new Set([
  "PreToolUse",
  "PermissionRequest",
  "PreModelSwitch",
  "UserPromptSubmit",
  "UserPromptExpansion",
]);

/** The newest agent read and found to have no `onFailure` (0 occurrences in 2.1.293; 2 in 2.1.295). */
export const LAST_AGENT_WITHOUT_ONFAILURE = "2.1.293";

export interface HookConfigSources {
  /** Staged plugin roots (host paths). */
  pluginRoots?: readonly string[];
  /** Staged local skill directories (each holds a SKILL.md). */
  skillDirs?: readonly string[];
  /** Config dirs the agent read (its CLAUDE_CONFIG_DIR): user settings, its skills/agents, and the plugins it installed. */
  configDirs?: readonly string[];
  /** Host managed-settings dirs, at the tiers where the agent runs natively on this host. */
  managedSettingsDirs?: readonly string[];
  /** The agent's actual spawn env (for CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG). */
  spawnEnv?: Readonly<Record<string, string | undefined>>;
}

class Unreadable extends Error {}

const SYNC_TYPES = (h: Record<string, unknown>) =>
  (h.type === "command" && h.async !== true && h.asyncRewake !== true) || h.type === "http";

/** The agent's eligibility test, plus the personal-hook rule when it applies. */
function eligible(h: unknown, event: string, personal: boolean): boolean {
  if (!h || typeof h !== "object") return false;
  const o = h as Record<string, unknown>;
  if (o.onFailure === "block" && SYNC_TYPES(o)) return true;
  return personal && PERSONAL_BLOCK_EVENTS.has(event) && SYNC_TYPES(o);
}

/** Add the eligible events of an events map (`{Event: [{matcher?, hooks: [...]}]}`, optionally under `hooks`). */
function addEventsMap(doc: unknown, out: Set<string>, personal: boolean): void {
  if (doc === undefined || doc === null) return;
  if (typeof doc !== "object" || Array.isArray(doc)) throw new Unreadable("not an events map");
  const map =
    (doc as Record<string, unknown>).hooks !== undefined && typeof (doc as Record<string, unknown>).hooks === "object"
      ? (doc as Record<string, unknown>).hooks
      : doc;
  if (!map || typeof map !== "object" || Array.isArray(map)) throw new Unreadable("not an events map");
  for (const [event, groups] of Object.entries(map as Record<string, unknown>)) {
    if (!Array.isArray(groups)) throw new Unreadable("an event's value is not a list");
    for (const g of groups) {
      const hooks = g && typeof g === "object" ? (g as Record<string, unknown>).hooks : undefined;
      if (hooks === undefined) continue;
      if (!Array.isArray(hooks)) throw new Unreadable("a matcher's hooks is not a list");
      if (hooks.some((h) => eligible(h, event, personal))) out.add(event);
    }
  }
}

function readJson(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Unreadable("unreadable");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Unreadable("not JSON");
  }
}

/** A markdown file's frontmatter `hooks:`. A frontmatter that does not parse counts only if it mentions hooks. */
function addFrontmatter(file: string, out: Set<string>): void {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Unreadable("unreadable");
  }
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) return;
  let fm: unknown;
  try {
    fm = parseYaml(m[1]!);
  } catch {
    if (/hooks/i.test(m[1]!)) throw new Unreadable("frontmatter does not parse");
    return;
  }
  if (fm && typeof fm === "object" && !Array.isArray(fm) && "hooks" in fm) addEventsMap((fm as Record<string, unknown>).hooks, out, false);
}

const isFile = (p: string) => {
  try {
    return lstatSync(p).isFile();
  } catch {
    return false;
  }
};
const isDir = (p: string) => {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Markdown files at most `depth` levels under `dir` (no symlinks followed). */
function markdownUnder(dir: string, depth: number, budget: { left: number }): string[] {
  if (!isDir(dir)) return [];
  const out: string[] = [];
  const walk = (d: string, left: number): void => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      throw new Unreadable("unlistable");
    }
    for (const name of names) {
      if (--budget.left < 0) throw new Unreadable("too many files to inventory");
      const p = join(d, name);
      if (isDir(p)) {
        if (left > 0 && name !== "node_modules" && !name.startsWith(".git")) walk(p, left - 1);
      } else if (name.endsWith(".md") && isFile(p)) out.push(p);
    }
  };
  walk(dir, depth);
  return out;
}

/** One plugin root: hooks/hooks.json, its manifest's `hooks` (inline, a path, or a list of either), and the
 *  frontmatter of its skills, commands and agents. */
function addPluginRoot(root: string, out: Set<string>, budget: { left: number }): void {
  const hooksJson = join(root, "hooks", "hooks.json");
  if (isFile(hooksJson)) addEventsMap(readJson(hooksJson), out, false);
  for (const rel of [[".claude-plugin", "plugin.json"], ["plugin.json"]]) {
    const f = join(root, ...rel);
    if (!isFile(f)) continue;
    const doc = readJson(f);
    const h = doc && typeof doc === "object" ? (doc as Record<string, unknown>).hooks : undefined;
    for (const item of Array.isArray(h) ? h : h === undefined ? [] : [h]) {
      if (typeof item === "string") {
        const p = resolve(root, item);
        if (isFile(p)) addEventsMap(readJson(p), out, false);
        else throw new Unreadable("a manifest hooks path does not resolve");
      } else addEventsMap(item, out, false);
    }
    break;
  }
  for (const sub of ["skills", "commands", "agents"]) for (const md of markdownUnder(join(root, sub), 3, budget)) addFrontmatter(md, out);
}

/** Plugin roots under a config dir's `plugins/` (the agent's own install cache): any dir holding a manifest or
 *  `hooks/hooks.json`. */
function installedPluginRoots(pluginsDir: string, budget: { left: number }): string[] {
  if (!isDir(pluginsDir)) return [];
  const roots: string[] = [];
  const walk = (d: string, left: number): void => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      throw new Unreadable("unlistable");
    }
    if (names.includes(".claude-plugin") || isFile(join(d, "hooks", "hooks.json")) || names.includes("plugin.json")) {
      roots.push(d);
      return;
    }
    for (const name of names) {
      if (--budget.left < 0) throw new Unreadable("too many files to inventory");
      const p = join(d, name);
      if (left > 0 && isDir(p) && name !== "node_modules" && !name.startsWith(".git")) walk(p, left - 1);
    }
  };
  walk(pluginsDir, 8);
  return roots;
}

const truthyEnv = (v: string | undefined) => v !== undefined && v !== "" && !/^(0|false|no|off)$/i.test(v.trim());

/** Read every hook source the agent could load for the run, and list the events that may carry a hook that blocks
 *  when it fails. A source that is absent contributes nothing; one that exists but cannot be read or parsed makes the
 *  result unknown. */
export function scanHookFailureBlocks(sources: HookConfigSources): HookFailureBlocks {
  const out = new Set<string>();
  const budget = { left: 50_000 };
  const personal = truthyEnv(sources.spawnEnv?.CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG);
  let failed = 0;
  const attempt = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      if (e instanceof Unreadable) failed++;
      else throw e;
    }
  };
  for (const root of sources.pluginRoots ?? []) attempt(() => addPluginRoot(root, out, budget));
  for (const dir of sources.skillDirs ?? [])
    attempt(() => {
      const f = join(dir, "SKILL.md");
      if (isFile(f)) addFrontmatter(f, out);
    });
  for (const dir of sources.configDirs ?? []) {
    for (const name of ["settings.json", "cowork_settings.json"])
      attempt(() => {
        const f = join(dir, name);
        if (isFile(f)) addEventsMap((readJson(f) as Record<string, unknown> | null)?.hooks, out, personal);
      });
    for (const sub of ["skills", "agents", "commands"])
      attempt(() => {
        for (const md of markdownUnder(join(dir, sub), 3, budget)) addFrontmatter(md, out);
      });
    attempt(() => {
      for (const root of installedPluginRoots(join(dir, "plugins"), budget)) attempt(() => addPluginRoot(root, out, budget));
    });
  }
  for (const dir of sources.managedSettingsDirs ?? []) {
    attempt(() => {
      const f = join(dir, "managed-settings.json");
      if (isFile(f)) addEventsMap((readJson(f) as Record<string, unknown> | null)?.hooks, out, false);
    });
    attempt(() => {
      const d = join(dir, "managed-settings.d");
      if (!isDir(d)) return;
      for (const name of readdirSync(d)
        .filter((n) => n.endsWith(".json"))
        .sort())
        attempt(() => addEventsMap((readJson(join(d, name)) as Record<string, unknown> | null)?.hooks, out, false));
    });
  }
  if (failed > 0) return { unknown: true, why: `${failed} hook source(s) could not be read or parsed` };
  return { events: [...out].sort() };
}

/** The host dirs the agent reads managed settings from, where it runs natively on this host (hostloop, protocol). */
export function hostManagedSettingsDirs(platform: NodeJS.Platform = process.platform): string[] {
  return platform === "darwin" ? ["/Library/Application Support/ClaudeCode"] : platform === "linux" ? ["/etc/claude-code"] : [];
}

/** Compare dotted numeric versions; undefined when either does not parse. */
function compareVersions(a: string, b: string): number | undefined {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  if (pa.some((x) => !Number.isInteger(x)) || pb.some((x) => !Number.isInteger(x))) return undefined;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The inventory a recording carries, or — for one made before it was recorded — what can be said: an agent at or
 *  below the last one without `onFailure` cannot have such a hook; any other (or an unknown agent) is unknown. */
export function resolveHookFailureBlocks(recorded: HookFailureBlocks | undefined, agentVersion: string | undefined): HookFailureBlocks {
  if (recorded !== undefined) return recorded;
  const cmp = agentVersion === undefined ? undefined : compareVersions(agentVersion, LAST_AGENT_WITHOUT_ONFAILURE);
  if (cmp !== undefined && cmp <= 0) return { events: [] };
  return { unknown: true, why: `recorded before the inventory existed, by agent ${agentVersion ?? "(unknown)"}` };
}

/** May a failed frame of `event` be a block the frame does not show? */
export function mayBlockOnFailure(blocks: HookFailureBlocks | undefined, event: string): boolean {
  if (blocks === undefined || ONFAILURE_EXEMPT_EVENTS.has(event)) return false;
  return "unknown" in blocks || blocks.events.includes(event);
}

/** Is the inventory non-empty (an event listed, or unknown)? */
export function hasHookFailureBlocks(blocks: HookFailureBlocks | undefined): boolean {
  return blocks !== undefined && ("unknown" in blocks || blocks.events.length > 0);
}
