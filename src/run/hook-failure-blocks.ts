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

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
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
  /** Plugin roots whose hooks the agent treats as the user's own (plugins carrying claude.ai uploads — the harness's
   *  remote-plugin mounts): under CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG their sync hooks block on failure too. */
  personalPluginRoots?: readonly string[];
  /** Config dirs the agent read (its CLAUDE_CONFIG_DIR): user settings, its skills/agents, and the plugins it installed. */
  configDirs?: readonly string[];
  /** Project `.claude` dirs whose settings the agent loads (protocol reads project and local settings from its cwd). */
  projectClaudeDirs?: readonly string[];
  /** Host managed-settings dirs, at the tiers where the agent runs natively on this host. */
  managedSettingsDirs?: readonly string[];
  /** The agent's actual spawn env (for CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG). */
  spawnEnv?: Readonly<Record<string, string | undefined>>;
  /** The hook event names the agent accepts. A key outside it is skipped, as the agent skips it, so a stray settings key
   *  never reaches the inventory. Omitted: every key counts. */
  knownEvents?: ReadonlySet<string>;
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

interface Scan {
  out: Set<string>;
  budget: { left: number };
  /** CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG is on. */
  restrict: boolean;
  known?: ReadonlySet<string>;
  /** Real paths already read: a symlink loop or a doubly reached file is read once. */
  seen: Set<string>;
}

/** Add the eligible events of an events map (`{Event: [{matcher?, hooks: [...]}]}`, optionally under `hooks`). */
function addEventsMap(doc: unknown, s: Scan, personal: boolean): void {
  if (doc === undefined || doc === null) return;
  if (typeof doc !== "object" || Array.isArray(doc)) throw new Unreadable("not an events map");
  const inner = (doc as Record<string, unknown>).hooks;
  const map = inner !== undefined && typeof inner === "object" ? inner : doc;
  if (!map || typeof map !== "object" || Array.isArray(map)) throw new Unreadable("not an events map");
  for (const [event, groups] of Object.entries(map as Record<string, unknown>)) {
    if (s.known !== undefined && !s.known.has(event)) continue; // the agent skips an event it does not know
    if (!Array.isArray(groups)) throw new Unreadable("an event's value is not a list");
    for (const g of groups) {
      const hooks = g && typeof g === "object" ? (g as Record<string, unknown>).hooks : undefined;
      if (hooks === undefined) continue;
      if (!Array.isArray(hooks)) throw new Unreadable("a matcher's hooks is not a list");
      if (hooks.some((h) => eligible(h, event, personal && s.restrict))) s.out.add(event);
    }
  }
}

const statOrNull = (p: string) => {
  try {
    return statSync(p); // follows symlinks, as the agent does
  } catch {
    return null;
  }
};
const isFile = (p: string) => statOrNull(p)?.isFile() === true;
const isDir = (p: string) => statOrNull(p)?.isDirectory() === true;

/** First visit of a path's real location? */
function firstVisit(p: string, s: Scan): boolean {
  let real: string;
  try {
    real = realpathSync(p);
  } catch {
    return true;
  }
  if (s.seen.has(real)) return false;
  s.seen.add(real);
  return true;
}

function readText(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    throw new Unreadable("unreadable");
  }
}

function readJson(file: string): unknown {
  const text = readText(file);
  try {
    return JSON.parse(text);
  } catch {
    throw new Unreadable("not JSON");
  }
}

/** A markdown file's frontmatter `hooks:`. A frontmatter that does not parse counts only if it mentions hooks. */
function addFrontmatter(file: string, s: Scan, personal: boolean): void {
  if (!firstVisit(file, s)) return;
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(readText(file));
  if (!m) return;
  let fm: unknown;
  try {
    fm = parseYaml(m[1]!);
  } catch {
    // Only a frontmatter that declares a `hooks:` key could carry one; a description that merely mentions hooks (a
    // common YAML colon slip the agent's own loader tolerates) does not make the inventory unknown.
    if (/^\s*hooks\s*:/m.test(m[1]!)) throw new Unreadable("frontmatter does not parse");
    return;
  }
  if (fm && typeof fm === "object" && !Array.isArray(fm) && "hooks" in fm) addEventsMap((fm as Record<string, unknown>).hooks, s, personal);
}

/** Markdown files at most `depth` levels under `dir` (a file path is itself), following symlinks once. */
function markdownUnder(dir: string, depth: number, s: Scan): string[] {
  if (isFile(dir)) return dir.endsWith(".md") ? [dir] : [];
  if (!isDir(dir)) return [];
  const out: string[] = [];
  const walk = (d: string, left: number): void => {
    if (!firstVisit(d, s)) return;
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      throw new Unreadable("unlistable");
    }
    for (const name of names) {
      if (--s.budget.left < 0) throw new Unreadable("too many files to inventory");
      const p = join(d, name);
      if (isDir(p)) {
        if (left > 0 && name !== "node_modules" && !name.startsWith(".git")) walk(p, left - 1);
      } else if (name.endsWith(".md") && isFile(p)) out.push(p);
    }
  };
  walk(dir, depth);
  return out;
}

/** A settings file's `hooks` (and, already applied by the caller, its `env`). */
function addSettings(file: string, s: Scan, personal: boolean): void {
  if (!isFile(file) || !firstVisit(file, s)) return;
  addEventsMap((readJson(file) as Record<string, unknown> | null)?.hooks, s, personal);
}

/** Does a settings file's `env` turn CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG on? */
function settingsRestrict(file: string): boolean {
  if (!isFile(file)) return false;
  try {
    const env = (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> | null)?.env;
    return (
      !!env && typeof env === "object" && truthyEnv(String((env as Record<string, unknown>).CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG ?? ""))
    );
  } catch {
    return false; // the hooks pass reports an unreadable file
  }
}

/** The manifest paths a field names (a string or a list of strings), resolved against the plugin root. */
const manifestPaths = (root: string, v: unknown): string[] =>
  (Array.isArray(v) ? v : v === undefined ? [] : [v]).filter((x): x is string => typeof x === "string").map((x) => resolve(root, x));

/** One plugin root: hooks/hooks.json, its manifest's `hooks` (inline, a path, or a list of either), and the
 *  frontmatter of its skills, commands and agents — the default dirs and any the manifest names. */
function addPluginRoot(root: string, s: Scan, personal: boolean): void {
  if (!firstVisit(root, s)) return;
  const hooksJson = join(root, "hooks", "hooks.json");
  if (isFile(hooksJson) && firstVisit(hooksJson, s)) addEventsMap(readJson(hooksJson), s, personal);
  let manifest: Record<string, unknown> | undefined;
  for (const rel of [[".claude-plugin", "plugin.json"], ["plugin.json"]]) {
    const f = join(root, ...rel);
    if (!isFile(f)) continue;
    const doc = readJson(f);
    manifest = doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>) : undefined;
    break;
  }
  const h = manifest?.hooks;
  for (const item of Array.isArray(h) ? h : h === undefined ? [] : [h]) {
    if (typeof item === "string") {
      const p = resolve(root, item);
      if (!isFile(p)) throw new Unreadable("a manifest hooks path does not resolve");
      if (firstVisit(p, s)) addEventsMap(readJson(p), s, personal);
    } else addEventsMap(item, s, personal);
  }
  for (const sub of ["skills", "commands", "agents"])
    for (const dir of [join(root, sub), ...manifestPaths(root, manifest?.[sub])])
      for (const md of markdownUnder(dir, 3, s)) addFrontmatter(md, s, personal);
}

/** Plugin roots under a config dir's `plugins/` (the agent's own install cache). Its `installed_plugins.json` names
 *  them when it reads; otherwise any dir holding a manifest or `hooks/hooks.json` counts. */
function installedPluginRoots(pluginsDir: string, s: Scan): string[] {
  if (!isDir(pluginsDir)) return [];
  const index = join(pluginsDir, "installed_plugins.json");
  if (isFile(index)) {
    try {
      const doc = JSON.parse(readFileSync(index, "utf8")) as { plugins?: Record<string, unknown> };
      if (doc?.plugins && typeof doc.plugins === "object") {
        const roots = Object.values(doc.plugins)
          .flatMap((v) => (Array.isArray(v) ? v : [v]))
          .map((e) => (e && typeof e === "object" ? (e as Record<string, unknown>).installPath : undefined))
          .filter((p): p is string => typeof p === "string" && isDir(p));
        return [...new Set(roots)];
      }
    } catch {
      /* fall back to the walk */
    }
  }
  const roots: string[] = [];
  const walk = (d: string, left: number): void => {
    if (!firstVisit(d, s)) return;
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      throw new Unreadable("unlistable");
    }
    if (names.includes(".claude-plugin") || isFile(join(d, "hooks", "hooks.json")) || names.includes("plugin.json")) {
      s.seen.delete(realpathSync(d)); // addPluginRoot visits it
      roots.push(d);
      return;
    }
    for (const name of names) {
      if (--s.budget.left < 0) throw new Unreadable("too many files to inventory");
      const p = join(d, name);
      if (left > 0 && isDir(p) && name !== "node_modules" && !name.startsWith(".git")) walk(p, left - 1);
    }
  };
  walk(pluginsDir, 8);
  return roots;
}

const truthyEnv = (v: string | undefined) => v !== undefined && v !== "" && !/^(0|false|no|off)$/i.test(v.trim());

const SETTINGS_FILES = ["settings.json", "settings.local.json", "cowork_settings.json"];

/** Read every hook source the agent could load for the run, and list the events that may carry a hook that blocks
 *  when it fails. A source that is absent contributes nothing; one that exists but cannot be read or parsed makes the
 *  result unknown. */
export function scanHookFailureBlocks(sources: HookConfigSources): HookFailureBlocks {
  const managedFiles = (sources.managedSettingsDirs ?? []).flatMap((dir) => {
    const d = join(dir, "managed-settings.d");
    let extra: string[] = [];
    try {
      extra = isDir(d)
        ? readdirSync(d)
            .filter((n) => n.endsWith(".json"))
            .sort()
            .map((n) => join(d, n))
        : [];
    } catch {
      extra = [d]; // reported as unreadable below
    }
    return [join(dir, "managed-settings.json"), ...extra];
  });
  const userSettings = (sources.configDirs ?? []).flatMap((dir) => SETTINGS_FILES.map((f) => join(dir, f)));
  const projectSettings = (sources.projectClaudeDirs ?? []).flatMap((dir) => SETTINGS_FILES.map((f) => join(dir, f)));
  const restrict =
    truthyEnv(sources.spawnEnv?.CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG) ||
    [...managedFiles, ...userSettings, ...projectSettings].some(settingsRestrict);
  const s: Scan = { out: new Set(), budget: { left: 50_000 }, restrict, known: sources.knownEvents, seen: new Set() };
  let failed = 0;
  const attempt = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      if (e instanceof Unreadable) failed++;
      else throw e;
    }
  };
  const personalRoots = new Set(sources.personalPluginRoots ?? []);
  for (const root of [...(sources.pluginRoots ?? []), ...personalRoots]) attempt(() => addPluginRoot(root, s, personalRoots.has(root)));
  // The user's own settings, skills and agents are personal hooks; project and managed settings are not.
  for (const f of userSettings) attempt(() => addSettings(f, s, true));
  for (const f of projectSettings) attempt(() => addSettings(f, s, false));
  for (const dir of sources.configDirs ?? []) {
    for (const sub of ["skills", "agents", "commands"])
      attempt(() => {
        for (const md of markdownUnder(join(dir, sub), 3, s)) addFrontmatter(md, s, true);
      });
    attempt(() => {
      for (const root of installedPluginRoots(join(dir, "plugins"), s)) attempt(() => addPluginRoot(root, s, false));
    });
  }
  for (const f of managedFiles) attempt(() => addSettings(f, s, false));
  if (failed > 0) return { unknown: true, why: `${failed} hook source(s) could not be read or parsed` };
  return { events: [...s.out].sort() };
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

/** Did every agent that ran predate `onFailure` (at or below the last one without it)? A turn can hold more than one
 *  init frame, so every one must be old; none reported, or one unparseable or missing, is not old — a missing version
 *  is never read as an old one. */
export function allAgentsPredateOnFailure(agentVersion: string | undefined | ReadonlyArray<string | undefined>): boolean {
  const versions = typeof agentVersion === "string" || agentVersion === undefined ? [agentVersion] : agentVersion;
  return (
    versions.length > 0 &&
    versions.every((v) => {
      const cmp = v === undefined ? undefined : compareVersions(v, LAST_AGENT_WITHOUT_ONFAILURE);
      return cmp !== undefined && cmp <= 0;
    })
  );
}

/** A run's inventory, gated by the agent that ran it (its init frames' versions): an agent at or below the last one
 *  without `onFailure` cannot turn a failure into a block, so it has nothing to taint and nothing to stamp, whatever
 *  its hook sources say — and they are not read. Any newer agent, or a run whose stream reports no version (one that
 *  crashed before init), keeps the scan. */
export function hookFailureBlocksForAgent(
  agentVersion: string | undefined | ReadonlyArray<string | undefined>,
  scan: () => HookFailureBlocks,
): HookFailureBlocks {
  return allAgentsPredateOnFailure(agentVersion) ? { events: [] } : scan();
}

/** Is `v` a well-formed inventory? A recording is a plain file anyone can edit. */
export function isHookFailureBlocks(v: unknown): v is HookFailureBlocks {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if ("unknown" in o) return o.unknown === true && typeof o.why === "string";
  return Array.isArray(o.events) && o.events.every((e) => typeof e === "string");
}

/** The inventory a recording carries, or — for one made before it was recorded — what can be said: if every agent its
 *  stream reports is at or below the last one without `onFailure`, none can have such a hook; otherwise (a newer agent,
 *  or none reported) it is unknown. `agentVersions`: every init frame's version in the recording, in order. */
export function resolveHookFailureBlocks(recorded: unknown, agentVersions: ReadonlyArray<string | undefined>): HookFailureBlocks {
  if (recorded !== undefined)
    return isHookFailureBlocks(recorded) ? recorded : { unknown: true, why: "the recorded inventory is malformed" };
  if (allAgentsPredateOnFailure(agentVersions)) return { events: [] };
  const named = agentVersions.length ? agentVersions.map((v) => v ?? "(unknown)").join(", ") : "(unknown)";
  return { unknown: true, why: `recorded before the inventory existed, by agent ${named}` };
}

/** May a failed frame of `event` be a block the frame does not show? */
export function mayBlockOnFailure(blocks: HookFailureBlocks | undefined, event: string): boolean {
  if (blocks === undefined || ONFAILURE_EXEMPT_EVENTS.has(event)) return false;
  return "unknown" in blocks || blocks.events.includes(event);
}

/** Is the inventory non-empty (an event listed, or unknown)? */
export function hasHookFailureBlocks(blocks: unknown): boolean {
  if (blocks === undefined) return false;
  // A malformed value is treated as unknown, which needs a v16 reader too.
  return !isHookFailureBlocks(blocks) || "unknown" in blocks || blocks.events.length > 0;
}
