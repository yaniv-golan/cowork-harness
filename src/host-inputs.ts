// `plugins.from_host`: the operator's installed plugins and skills as a recorded run input.
//
// Read-only on the host. `<config>` is `CLAUDE_CONFIG_DIR`, else `~/.claude`. Plugins come from
// `<config>/plugins/installed_plugins.json` (version 2: `{plugins: {"<name>@<marketplace>": [entry, …]}}`), one
// `scope: "user"` entry per key, delivered from that entry's `installPath`. Skills come from `<config>/skills/*`.
// `settings.json`'s `enabledPlugins` picks the set under `from_host: true`. Nothing else is read: no
// `projectPath`, no `known_marketplaces.json`, no MCP servers from `~/.claude.json`, no `settings.json` hooks.
//
// What the agent reads is a run-owned copy (the snapshot), hashed after it is copied, so the recorded hash is
// over the bytes delivered. A later leg of the same run reuses the snapshot and re-hashes it first.
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { UsageError } from "./errors.js";
import { safePathSegment } from "./staging/resolve.js";
import { hashHostTree } from "./run/skill-hash.js";

/** The session's `plugins.from_host`: everything enabled, or the named plugins and skills. */
export type FromHost = true | { plugins: string[]; skills: string[] };

/** Why an input `from_host: true` would have taken was left out. The closed set of skips; anything else refuses. */
export type HostSkipReason = "not-installed" | "not-user-scope";

/** What a run recorded about its host inputs (`RunResult.hostInputs`, and a cassette's frozen copy). */
export interface HostInputs {
  plugins: Array<{ key: string; version: string; gitCommitSha?: string; sha256: string }>;
  skills: Array<{ name: string; sha256: string }>;
  skipped?: Array<{ key: string; reason: HostSkipReason }>;
  /** Host inputs a scenario's own plugin or skill of the same name replaced: plugin keys, and skills as `skill:<name>`. */
  shadowed?: string[];
  /** sha256 over the delivered plugins and skills, sorted by (kind, key). `skipped` and `shadowed` do not enter it. */
  setHash: string;
}

const SHA256 = z.string().regex(/^[0-9a-f]{64}$/);
/** The shape a cassette may freeze. Strict at every level: names, versions and hashes only, so a cassette whose
 *  `hostInputs` carries anything else (a file body, a path) is refused at the read boundary. */
export const HostInputsShape = z.strictObject({
  plugins: z.array(
    z.strictObject({
      key: z.string(),
      version: z.string(),
      gitCommitSha: z
        .string()
        .regex(/^[0-9a-f]{7,64}$/)
        .optional(),
      sha256: SHA256,
    }),
  ),
  skills: z.array(z.strictObject({ name: z.string(), sha256: SHA256 })),
  skipped: z.array(z.strictObject({ key: z.string(), reason: z.enum(["not-installed", "not-user-scope"]) })).optional(),
  shadowed: z.array(z.string()).optional(),
  setHash: SHA256,
});

export interface HostPluginPick {
  key: string;
  name: string;
  marketplace: string;
  version: string;
  gitCommitSha?: string;
  /** The entry's `installPath`, realpath'd and checked to sit under `<config>/plugins`. */
  installPath: string;
}
export interface HostSkillPick {
  name: string;
  /** The skill dir, realpath'd (a symlinked skill is followed). */
  src: string;
}
export interface HostSelection {
  configDir: string;
  plugins: HostPluginPick[];
  skills: HostSkillPick[];
  skipped: Array<{ key: string; reason: HostSkipReason }>;
}

/** Never copied, so never hashed: the files Claude Code writes beside an installed plugin's content to track its use,
 *  and the OS metadata the OS rewrites on its own (a Finder visit must not move `setHash`). */
const HOST_MARKER_FILES = new Set([".in_use", ".orphaned_at", ".DS_Store", "Thumbs.db", "desktop.ini", ".AppleDouble", "__MACOSX"]);
/** The copy filter for a host input (cpSync's `filter(src, dest)`). The hash is taken over the copy, so it sees
 *  exactly what this filter lets through. */
export const hostStageFilter = (src: string): boolean => !HOST_MARKER_FILES.has(basename(src));

/** The operator's Claude config dir: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function hostConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const d = env.CLAUDE_CONFIG_DIR;
  return d ? resolve(d.replace(/^~(?=$|\/)/, homedir())) : join(homedir(), ".claude");
}

/** A plugin key is `<name>@<marketplace>`, with neither half empty and no second `@`. */
export function isQualifiedPluginKey(key: string): boolean {
  return /^[^@\s/]+@[^@\s/]+$/.test(key);
}

const refuse = (msg: string): never => {
  throw new UsageError(`plugins.from_host: ${msg}`);
};

function readJson(path: string, what: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    return refuse(`cannot read ${what} (${path}): ${(e as Error).message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    return refuse(`${what} (${path}) is not valid JSON: ${(e as Error).message}`);
  }
}

const inside = (root: string, p: string): boolean => p === root || p.startsWith(root + sep);

/** Refuses a tree holding a symlink whose target is absolute or resolves outside the tree: a copy would carry it as
 *  a pointer back into the host. Lexical, like the hash walk; nothing is followed. */
function refuseEscapingSymlinks(root: string, what: string): void {
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (e) {
      refuse(`cannot read ${what} (${dir}): ${(e as Error).message}`);
      return;
    }
    for (const n of names) {
      const abs = join(dir, n);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) {
        const t = readlinkSync(abs);
        if (isAbsolute(t) || !inside(root, resolve(dirname(abs), t)))
          refuse(
            `${what} holds a symlink that points outside it (${relative(root, abs)} -> ${t}); the harness will not copy a pointer into your host`,
          );
      } else if (st.isDirectory()) walk(abs);
    }
  };
  walk(root);
}

/**
 * Pick the host inputs `fromHost` names. No writes. Under `true`, a plugin that is enabled but not installed, or
 * installed only at a non-user scope, is skipped and listed; under an explicit list it is refused. Everything else
 * that is wrong refuses under both forms. `warn` gets one line per missing host file under `true`.
 */
export function selectHostInputs(fromHost: FromHost, configDir: string, warn: (line: string) => void): HostSelection {
  const all = fromHost === true;
  const wantPlugins = all ? undefined : fromHost.plugins;
  const wantSkills = all ? undefined : fromHost.skills;
  const skipped: HostSelection["skipped"] = [];

  // --- plugins ---
  const plugins: HostPluginPick[] = [];
  const installedPath = join(configDir, "plugins", "installed_plugins.json");
  const settingsPath = join(configDir, "settings.json");
  let keys: string[] = [];
  let installed: Record<string, unknown> | undefined;
  if (all) {
    if (!existsSync(settingsPath)) warn(`::warning:: [from_host] no ${settingsPath}: no plugins enabled on this host\n`);
    else {
      const s = readJson(settingsPath, "settings.json") as { enabledPlugins?: unknown } | null;
      const ep = s && typeof s === "object" ? s.enabledPlugins : undefined;
      if (ep !== undefined && (ep === null || typeof ep !== "object" || Array.isArray(ep)))
        refuse(`settings.json's enabledPlugins is not an object (${settingsPath})`);
      keys = Object.entries((ep ?? {}) as Record<string, unknown>)
        .filter(([, v]) => v === true)
        .map(([k]) => k)
        .sort();
    }
  } else keys = [...wantPlugins!];
  if (keys.length) {
    if (!existsSync(installedPath)) {
      if (!all) refuse(`no ${installedPath}: the named plugins are not installed on this host`);
      warn(`::warning:: [from_host] no ${installedPath}: ${keys.length} enabled plugin(s) are not installed\n`);
      for (const key of keys) skipped.push({ key, reason: "not-installed" });
      keys = [];
    } else {
      const ip = readJson(installedPath, "installed_plugins.json") as { version?: unknown; plugins?: unknown } | null;
      if (!ip || typeof ip !== "object") refuse(`installed_plugins.json is not an object (${installedPath})`);
      if (ip!.version !== 2)
        refuse(`installed_plugins.json has version ${JSON.stringify(ip!.version)}; this harness reads version 2 only (${installedPath})`);
      if (ip!.plugins === null || typeof ip!.plugins !== "object" || Array.isArray(ip!.plugins))
        refuse(`installed_plugins.json's plugins is not an object (${installedPath})`);
      installed = ip!.plugins as Record<string, unknown>;
    }
  }
  const pluginsRoot = (() => {
    try {
      return realpathSync(join(configDir, "plugins"));
    } catch {
      return resolve(configDir, "plugins");
    }
  })();
  const byName = new Map<string, string>();
  for (const key of keys) {
    if (!isQualifiedPluginKey(key))
      refuse(`plugin "${key}" is not <name>@<marketplace>; a bare name is ambiguous, since two marketplaces can each have one`);
    const entries = installed![key];
    const skip = (reason: HostSkipReason, why: string): void => {
      if (!all) refuse(`plugin "${key}" ${why}`);
      skipped.push({ key, reason });
    };
    if (!Array.isArray(entries) || entries.length === 0) {
      skip("not-installed", "is not installed on this host (no entry in installed_plugins.json)");
      continue;
    }
    const user = entries.filter((e) => (e as { scope?: unknown } | null)?.scope === "user");
    if (user.length === 0) {
      skip("not-user-scope", "has no user-scope install (only project or local scope)");
      continue;
    }
    if (user.length > 1)
      refuse(`plugin "${key}" has ${user.length} user-scope entries in installed_plugins.json; the harness will not guess`);
    const e = user[0] as { installPath?: unknown; version?: unknown; gitCommitSha?: unknown };
    if (typeof e.installPath !== "string" || e.installPath === "") refuse(`plugin "${key}" has no installPath`);
    let installPath: string;
    try {
      installPath = realpathSync(e.installPath as string);
    } catch {
      return refuse(`plugin "${key}": installPath ${e.installPath as string} does not exist`);
    }
    if (!statSync(installPath).isDirectory()) refuse(`plugin "${key}": installPath ${installPath} is not a directory`);
    if (!inside(pluginsRoot, installPath)) refuse(`plugin "${key}": installPath ${installPath} is outside ${pluginsRoot}`);
    const at = key.indexOf("@");
    const name = safePathSegment(key.slice(0, at), `from_host plugin name in "${key}"`);
    const marketplace = safePathSegment(key.slice(at + 1), `from_host marketplace in "${key}"`);
    const prior = byName.get(name);
    if (prior) refuse(`two plugins named "${name}" (${prior} and ${key}); name one of them in an explicit from_host.plugins list`);
    byName.set(name, key);
    refuseEscapingSymlinks(installPath, `plugin "${key}"`);
    plugins.push({
      key,
      name,
      marketplace,
      version: typeof e.version === "string" ? e.version : String(e.version ?? ""),
      ...(typeof e.gitCommitSha === "string" && /^[0-9a-f]{7,64}$/.test(e.gitCommitSha) ? { gitCommitSha: e.gitCommitSha } : {}),
      installPath,
    });
  }

  // --- skills ---
  const skills: HostSkillPick[] = [];
  const skillsDir = join(configDir, "skills");
  const names = all
    ? existsSync(skillsDir)
      ? readdirSync(skillsDir)
          .filter((n) => !n.startsWith("."))
          .sort()
      : []
    : [...wantSkills!];
  if (!all && names.length && !existsSync(skillsDir)) refuse(`no ${skillsDir}: the named skills are not installed on this host`);
  for (const name of names) {
    safePathSegment(name, "from_host skill name");
    const p = join(skillsDir, name);
    let lst;
    try {
      lst = lstatSync(p);
    } catch {
      if (all) continue;
      return refuse(`skill "${name}" is not in ${skillsDir}`);
    }
    let src: string;
    try {
      src = realpathSync(p);
    } catch {
      return refuse(`skill "${name}" is a symlink whose target does not exist (${readlinkSync(p)})`);
    }
    if (!statSync(src).isDirectory()) {
      if (all) continue; // a loose file in the skills dir is not a skill
      refuse(`skill "${name}" is not a directory`);
    }
    if (lst.isSymbolicLink() || lst.isDirectory()) {
      refuseEscapingSymlinks(src, `skill "${name}"`);
      skills.push({ name, src });
    }
  }
  return { configDir, plugins, skills, skipped };
}

/** The leaf a host plugin mounts at: `.local-plugins/marketplaces/<marketplace>/<name>` (the real Cowork shape), or
 *  `.local-plugins/cache/<marketplace>/<name>` below the bare-name baseline. Each segment already went through
 *  `safePathSegment` at the caller. */
export function hostPluginMountPath(marketplace: string, name: string, bareNames: boolean): string {
  return bareNames ? `.local-plugins/marketplaces/${marketplace}/${name}` : `.local-plugins/cache/${marketplace}/${name}`;
}

/** sha256 over the delivered entries, sorted by (kind, key). */
export function hostInputsSetHash(h: Pick<HostInputs, "plugins" | "skills">): string {
  const rows = [
    ...h.plugins.map((p) => ["plugin", p.key, p.sha256] as const),
    ...h.skills.map((s) => ["skill", s.name, s.sha256] as const),
  ].sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  const hash = createHash("sha256");
  for (const [k, key, sha] of rows) hash.update(`${k}\0${key}\0${sha}\n`);
  return hash.digest("hex");
}

/** The snapshot's own record: where each input was copied and its hash, so a later leg can re-check the copy. */
interface SnapshotRecord {
  hostInputs: HostInputs;
  plugins: Array<{ key: string; dir: string; mountPath: string }>;
  skills: Array<{ name: string; dir: string }>;
}
const SNAPSHOT_RECORD = "host-inputs.json";

/** The run-owned snapshot dir for a run root. */
export function hostSnapshotDir(runRoot: string): string {
  return join(resolve(runRoot), "host-inputs");
}

/** The run's snapshot record, when an earlier leg of the run wrote one. */
export function readHostSnapshot(
  runRoot: string,
): { hostInputs: HostInputs; plugins: Array<{ key: string; dir: string; mountPath: string }> } | undefined {
  const p = join(hostSnapshotDir(runRoot), SNAPSHOT_RECORD);
  if (!existsSync(p)) return undefined;
  const rec = JSON.parse(readFileSync(p, "utf8")) as SnapshotRecord;
  return { hostInputs: rec.hostInputs, plugins: rec.plugins };
}

function hashOrRefuse(dir: string, what: string): string {
  const { sha256, errors } = hashHostTree(dir);
  if (errors.length) refuse(`cannot hash the staged copy of ${what}: ${errors.join("; ")}`);
  return sha256;
}

export interface StagedHostInputs {
  hostInputs: HostInputs;
  /** Staged copy of each delivered plugin, by key. */
  pluginDirs: Map<string, string>;
  /** Staged copy of each delivered skill, by name. */
  skillDirs: Map<string, string>;
}

/**
 * Copy the selection into the run's snapshot and hash the copies. When the snapshot already exists (a later leg
 * of the same run) nothing is re-read from the host: each copy is re-hashed and a copy that changed is refused.
 */
export function stageHostInputs(
  selection: HostSelection | undefined,
  shadowed: string[],
  runRoot: string,
  mountPaths: ReadonlyMap<string, string> = new Map(),
): StagedHostInputs {
  const snap = hostSnapshotDir(runRoot);
  const recordPath = join(snap, SNAPSHOT_RECORD);
  if (existsSync(recordPath)) {
    const rec = JSON.parse(readFileSync(recordPath, "utf8")) as SnapshotRecord;
    const pluginDirs = new Map<string, string>();
    const skillDirs = new Map<string, string>();
    for (const p of rec.plugins) {
      const want = rec.hostInputs.plugins.find((x) => x.key === p.key)!.sha256;
      if (hashOrRefuse(p.dir, `plugin "${p.key}"`) !== want)
        refuse(`the staged copy of plugin "${p.key}" changed after an earlier leg of this run used it (${p.dir})`);
      pluginDirs.set(p.key, p.dir);
    }
    for (const s of rec.skills) {
      const want = rec.hostInputs.skills.find((x) => x.name === s.name)!.sha256;
      if (hashOrRefuse(s.dir, `skill "${s.name}"`) !== want)
        refuse(`the staged copy of skill "${s.name}" changed after an earlier leg of this run used it (${s.dir})`);
      skillDirs.set(s.name, s.dir);
    }
    return { hostInputs: rec.hostInputs, pluginDirs, skillDirs };
  }
  if (!selection) refuse(`no host selection and no snapshot under ${snap}`);
  mkdirSync(snap, { recursive: true });
  const pluginDirs = new Map<string, string>();
  const skillDirs = new Map<string, string>();
  const plugins: HostInputs["plugins"] = [];
  const skills: HostInputs["skills"] = [];
  const rec: SnapshotRecord = { hostInputs: undefined as unknown as HostInputs, plugins: [], skills: [] };
  for (const p of selection!.plugins) {
    if (shadowed.includes(p.key)) continue;
    const dir = join(snap, "plugins", p.marketplace, p.name);
    cpSync(p.installPath, dir, { recursive: true, dereference: false, verbatimSymlinks: true, filter: hostStageFilter });
    const sha256 = hashOrRefuse(dir, `plugin "${p.key}"`);
    plugins.push({ key: p.key, version: p.version, ...(p.gitCommitSha ? { gitCommitSha: p.gitCommitSha } : {}), sha256 });
    pluginDirs.set(p.key, dir);
    rec.plugins.push({ key: p.key, dir, mountPath: mountPaths.get(p.key) ?? "" });
  }
  for (const s of selection!.skills) {
    if (shadowed.includes(`skill:${s.name}`)) continue;
    const dir = join(snap, "skills", s.name);
    cpSync(s.src, dir, { recursive: true, dereference: false, verbatimSymlinks: true, filter: hostStageFilter });
    const sha256 = hashOrRefuse(dir, `skill "${s.name}"`);
    skills.push({ name: s.name, sha256 });
    skillDirs.set(s.name, dir);
    rec.skills.push({ name: s.name, dir });
  }
  const hostInputs: HostInputs = {
    plugins,
    skills,
    ...(selection!.skipped.length ? { skipped: selection!.skipped } : {}),
    ...(shadowed.length ? { shadowed: [...shadowed].sort() } : {}),
    setHash: hostInputsSetHash({ plugins, skills }),
  };
  rec.hostInputs = hostInputs;
  writeFileSync(recordPath, JSON.stringify(rec, null, 2));
  return { hostInputs, pluginDirs, skillDirs };
}

/** The set hash a run would record for this selection, hashed from the host sources as their copies would be
 *  (the copy filter's names left out), without copying. For a gate that must notice a host change before it runs. */
export function hostSelectionSetHash(selection: HostSelection, shadowed: readonly string[]): string {
  const sha = (dir: string, what: string): string => {
    const { sha256, errors } = hashHostTree(dir, HOST_MARKER_FILES);
    if (errors.length) refuse(`cannot hash ${what}: ${errors.join("; ")}`);
    return sha256;
  };
  return hostInputsSetHash({
    plugins: selection.plugins
      .filter((p) => !shadowed.includes(p.key))
      .map((p) => ({ key: p.key, version: p.version, sha256: sha(p.installPath, `plugin "${p.key}"`) })),
    skills: selection.skills
      .filter((s) => !shadowed.includes(`skill:${s.name}`))
      .map((s) => ({ name: s.name, sha256: sha(s.src, `skill "${s.name}"`) })),
  });
}

/** The one line a run prints about its host inputs: counts, the set hash, and every skip and shadow by name. */
export function hostInputsSummary(h: HostInputs): string {
  const parts = [`${h.plugins.length} plugin(s), ${h.skills.length} skill(s) from your host, setHash ${h.setHash.slice(0, 12)}`];
  if (h.skipped?.length) parts.push(`skipped ${h.skipped.length}: ${h.skipped.map((s) => `${s.key} (${s.reason})`).join(", ")}`);
  if (h.shadowed?.length) parts.push(`replaced by the scenario's own: ${h.shadowed.join(", ")}`);
  return `[from_host] ${parts.join("; ")}`;
}

/** Hash the host's CURRENT copy of each recorded input, for `verify-cassettes --host-inputs` (a local check: it reads
 *  this machine). Uses the same filter and walk as the run: each input is copied to `scratch` and hashed there. */
export function currentHostInputs(fromHost: FromHost, configDir: string, scratch: string, shadowed: readonly string[] = []): HostInputs {
  const sel = selectHostInputs(fromHost, configDir, () => {});
  return stageHostInputs(sel, [...shadowed], scratch).hostInputs;
}
