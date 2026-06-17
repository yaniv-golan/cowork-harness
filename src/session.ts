import { warn } from "./io.js";
import { z } from "zod";
import { mkdirSync, writeFileSync, readFileSync, cpSync, existsSync, statSync } from "node:fs";
import { join, resolve, basename, isAbsolute } from "node:path";
import { homedir } from "node:os";
import type { PlatformBaseline } from "./types.js";
import { safePathSegment, safeMountSegment, requireDir } from "./staging/resolve.js";

/** Clone process env with Cowork's bg-env-strip applied. */
function strippedEnv(baseline: PlatformBaseline): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const v of baseline.bgEnvStrip?.knownVars ?? []) delete env[v];
  return env;
}

/**
 * SessionConfig — everything a user configures in Cowork BEFORE the first prompt
 * of a new session. This is the file you author and maintain per project. It is
 * deliberately separate from the release-derived platform baseline (baselines/*.json):
 *   - platform baseline = what Cowork's runtime IS this release (auto-synced)
 *   - session (this)    = what YOU set up for this session (hand-authored)
 *
 * Field-by-field mapping to Cowork's pre-prompt controls is in the comments.
 */

const Folder = z.object({
  from: z.string(), // host path
  to: z.string().optional(), // project id under .projects/ (defaults to basename)
  // Binary-verified default: Cowork mounts userSelectedFolders `rw` (delete DENIED until approved via
  // fileDeleteApprovedMounts; asar IX resolver). Set `rwd` explicitly to model a delete-approved folder.
  mode: z.enum(["r", "rw", "rwd"]).default("rw"),
});

export const SessionConfig = z
  .object({
    // --- model & reasoning (Cowork model picker + toggles) ---
    model: z.string().optional(), // setModel
    effort: z.enum(["low", "medium", "high", "xhigh"]).optional(), // setEffort
    // Thinking budget. Binary-verified against app.asar 1.12603.1: Cowork's config field is
    // `maxThinkingTokens` — a flat NUMBER or a per-model map `{ default, <model>: <n> }` — resolved
    // per-model by f7e() and emitted on BOTH channels: the `--max-thinking-tokens` CLI flag (agentArgs)
    // and the `MAX_THINKING_TOKENS` env (spawnEnv). The ELF honors the env and env wins (V1), so the
    // two agree. There is NO "extended thinking" boolean; DEFAULT_MAX_THINKING_TOKENS (hre) = 31999.
    // #33: a positive integer (or a per-model map of them) — reject 0 / negative, which would
    // contradict the "never 0" budget invariant if it reached the CLI flag / env.
    max_thinking_tokens: z.union([z.number().int().positive(), z.record(z.string(), z.number().int().positive())]).optional(),
    extended_thinking: z.boolean().optional(), // DEPRECATED + inert: not a real Cowork toggle — use max_thinking_tokens.
    permission_mode: z.enum(["default", "acceptEdits", "plan", "bypassPermissions"]).default("default"), // setPermissionMode
    // cowork = pre-approve built-ins (like real Cowork's allowedTools) + auto-allow unscripted
    // tools with a finding; strict = deny unmatched (for adversarial tests).
    permission_parity: z.enum(["cowork", "strict"]).default("cowork"),

    // --- work folders / projects (Cowork "add folder" / Spaces) -> mnt/.projects/<id> ---
    folders: z.array(Folder).default([]),
    trusted_folders: z.array(z.string()).default([]), // localAgentModeTrustedFolders
    auto_mount_folders: z.boolean().default(false), // autoMountFolders

    // --- files uploaded before first prompt -> mnt/uploads ---
    uploads: z.array(z.string()).default([]),

    // --- discovery: marketplaces / plugins / skills / mcp ---
    // Faithful default = same roots the in-VM claude-code agent uses; override for tests.
    plugins: z
      .object({
        config_dir: z.string().nullable().default(null), // CLAUDE_CONFIG_DIR; null = harness-managed clean dir
        marketplaces: z.array(z.string()).default([]), // plugin_marketplaces (git URLs / paths)
        local_marketplaces: z.array(z.string()).default([]), // LOCAL marketplace dirs -> registered via `claude plugin marketplace add`
        enabled: z.array(z.string()).default([]), // enabledPlugins (name@marketplace)
        local_plugins: z.array(z.string()).default([]), // host plugin dirs -> mnt/.local-plugins/cache (--plugin-dir)
        remote_plugins: z.array(z.string()).default([]), // host plugin dirs -> mnt/.remote-plugins
      })
      .default({ config_dir: null, marketplaces: [], local_marketplaces: [], enabled: [], local_plugins: [], remote_plugins: [] }),

    skills: z
      .object({
        local: z.array(z.string()).default([]), // host skill dirs -> CLAUDE_CONFIG_DIR/skills
      })
      .default({ local: [] }),

    mcp: z
      .object({
        config: z.string().nullable().default(null), // --mcp-config file (mcpServers map)
        enabled: z.array(z.string()).default([]), // enabledMcpjsonServers
      })
      .default({ config: null, enabled: [] }),

    // --- network (Cowork egress, pre-prompt) ---
    egress: z
      .object({
        extra_allow: z.array(z.string()).default([]), // coworkEgressAllowedHosts additions
        unrestricted: z.boolean().default(false), // "*"
      })
      .default({ extra_allow: [], unrestricted: false }),
    web_fetch: z
      .object({
        // TEST CONVENIENCE (not a real Cowork setting): pre-approve these hosts for the run, as if the
        // user had clicked "Allow all for website" earlier this session. Seeds Run.approvedDomains so a
        // web_fetch to them raises no gate. Cowork has no persistent pre-approval — this is per-run only.
        approved_domains: z.array(z.string()).default([]),
      })
      .default({ approved_domains: [] }),
  })
  .strict();
export type SessionConfig = z.infer<typeof SessionConfig>;

/** A concrete mount the runtime should create (path relative to mnt cwd). */
export interface Mount {
  hostPath: string;
  mountPath: string;
  mode: "r" | "rw" | "rwd";
}

/**
 * Declarative launch plan — runtime-agnostic. Each runtime (host / container /
 * microvm) maps these host paths into its own world and assembles CLI args.
 */
export interface LaunchPlan {
  configDir: string; // materialized CLAUDE_CONFIG_DIR (host path)
  mcpConfig: string | null; // host path to --mcp-config file, if any
  model?: string;
  effort?: string;
  maxThinkingTokens?: number | Record<string, number>; // #23: session thinking budget (resolved per-model in spawnEnv)
  permissionMode: string;
  permissionParity: "cowork" | "strict";
  baseEnv: NodeJS.ProcessEnv; // Cowork bg-env-strip applied; CLAUDE_CONFIG_DIR set by the runtime
  mounts: Mount[]; // uploads + projects + plugin roots (mountPath relative to mnt)
  pluginDirs: string[]; // mnt-relative plugin roots for --plugin-dir (incl. marketplace-resolved)
  egressAllow: string[]; // baseline allowlist + session extra (or ["*"] if unrestricted)
  agentSessionId?: string; // the agent's native --session-id (pinned for resume); set by executeScenario
  resume?: boolean; // pass --resume <agentSessionId> instead of --session-id (continue a prior session)
}

/**
 * Read a plugin's declared version from its `.claude-plugin/plugin.json`.
 *
 * Bug 48: split missing-vs-malformed. A genuinely-absent manifest returns `null` (legitimately
 * versionless plugins fall back to the caller's default), but a PRESENT-but-corrupt manifest THROWS —
 * silently defaulting an unparseable plugin.json to "0.0.0" would mask a real authoring error and
 * stage the plugin at a wrong cache path. A present manifest with no/empty `version` is not corrupt:
 * it returns `null` (the version field is genuinely absent, same as a versionless plugin).
 */
function readPluginVersion(pluginRoot: string): string | null {
  const pj = join(pluginRoot, ".claude-plugin", "plugin.json");
  if (!existsSync(pj)) return null;
  let parsed: { version?: unknown };
  try {
    parsed = JSON.parse(readFileSync(pj, "utf8"));
  } catch (e) {
    throw new Error(`plugin manifest is not valid JSON: ${pj} (${(e as Error).message}). Fix it, or remove the plugin.`);
  }
  const v = parsed.version;
  return typeof v === "string" && v ? v : null;
}

/**
 * Materialize the session into a launch plan: builds a clean CLAUDE_CONFIG_DIR
 * (settings.json with enabledPlugins / enabledMcpjsonServers / plugin_marketplaces),
 * stages skills + plugins, and computes mounts + flags. Because the agent we run
 * is the same claude-code binary Cowork stages, this reproduces Cowork's discovery.
 */
export function buildLaunchPlan(session: SessionConfig, baseline: PlatformBaseline, outDir: string): LaunchPlan {
  const expand = (p: string) => p.replace(/^~(?=$|\/)/, homedir());

  // 1. CLAUDE_CONFIG_DIR — clean managed dir unless the session pins one.
  const pinnedConfigDir = session.plugins.config_dir ? expand(session.plugins.config_dir) : undefined;
  // #27: writing settings.json/cowork_settings.json into a user-supplied EXISTING dir would clobber
  // their real Claude config. Require an explicit opt-in; a fresh/non-existent pinned dir is fine.
  if (pinnedConfigDir && existsSync(pinnedConfigDir) && (process.env.COWORK_HARNESS_ALLOW_CONFIG_DIR_WRITE ?? "") === "")
    throw new Error(
      `plugins.config_dir is an existing directory (${pinnedConfigDir}); the harness would overwrite its settings.json/cowork_settings.json. ` +
        `Set COWORK_HARNESS_ALLOW_CONFIG_DIR_WRITE=1 to allow, or use a managed dir (config_dir: null).`,
    );
  const configDir = pinnedConfigDir ?? join(resolve(outDir), "claude-config");
  mkdirSync(join(configDir, "skills"), { recursive: true });
  mkdirSync(join(configDir, "plugins"), { recursive: true });

  // 2. settings — the discovery knobs. Written to BOTH settings.json and
  // cowork_settings.json: the agent's userSettings filename is cowork_settings.json
  // whenever CLAUDE_CODE_USE_COWORK_PLUGINS is truthy (TSO() in the 2.1.170 ELF), and
  // settings.json otherwise — writing both makes either state behave. (Real Cowork
  // delivers plugins via --plugin-dir, not these knobs; kept mainly for L0.)
  const settings: Record<string, unknown> = {};
  if (session.plugins.enabled.length) settings.enabledPlugins = session.plugins.enabled;
  if (session.plugins.marketplaces.length) settings.extraKnownMarketplaces = session.plugins.marketplaces;
  if (session.mcp.enabled.length) settings.enabledMcpjsonServers = session.mcp.enabled;
  settings.localAgentModeTrustedFolders = session.trusted_folders.map(expand);
  settings.autoMountFolders = session.auto_mount_folders;
  const settingsJson = JSON.stringify(settings, null, 2);
  writeFileSync(join(configDir, "settings.json"), settingsJson);
  writeFileSync(join(configDir, "cowork_settings.json"), settingsJson);

  // SEAM A — fail-loud is the only path for a declared source. A missing source FAILS by default (the
  // runtimes existsSync-skip the copy, so the agent silently gets a path that does not exist — a
  // confusing late failure, or a manufactured green). COWORK_HARNESS_SOFT_MISSING=1 downgrades every
  // such case to warn-and-exclude. Defined up here because skills (below) consult it too.
  const softMissing = (process.env.COWORK_HARNESS_SOFT_MISSING ?? "") !== "";

  // 3. stage local skills into CLAUDE_CONFIG_DIR/skills. A missing source fails (like a mount); two
  // skills with the same basename would copy to the same dest and silently clobber — fail on that too.
  const skillDests = new Set<string>();
  for (const s of session.skills.local) {
    const src = expand(s);
    if (!existsSync(src)) {
      if (!softMissing) throw new Error(`skill source not found: ${src}. Fix the path, or set COWORK_HARNESS_SOFT_MISSING=1 to skip it.`);
      warn(`::warning:: [skill] missing source excluded (COWORK_HARNESS_SOFT_MISSING): ${src}\n`);
      continue;
    }
    // Bug 43: a skill is a directory (it is cpSync'd recursively into CLAUDE_CONFIG_DIR/skills). A file
    // source would copy as a lone file, silently diverging from Cowork's skill-dir model. Kind-check
    // here, where the source is known to exist (missing already handled above, softMissing-aware).
    requireDir(src, "skill source");
    const dest = safePathSegment(basename(src), "skill basename");
    if (skillDests.has(dest))
      throw new Error(
        `duplicate skill destination "skills/${dest}" — two skills.local entries share a basename (they would overwrite). Rename or relocate one.`,
      );
    skillDests.add(dest);
    cpSync(src, join(configDir, "skills", dest), { recursive: true });
  }

  // 4. mounts: uploads + projects + plugin roots (Cowork mount model). Every basename-derived leaf
  // goes through safePathSegment — basename("..") is ".." (it does NOT collapse), so a `from: ".."`
  // would otherwise yield `.projects/..` and clobber the workspace root on staging.
  const mounts: Mount[] = [];
  for (const u of session.uploads) {
    const src = expand(u);
    // Uploads model attached FILES; a directory would be copied recursively, diverging from Cowork.
    if (existsSync(src) && !statSync(src).isFile())
      throw new Error(`upload "${src}" is a directory; uploads model attached files. Use folders: for a directory mount.`);
    mounts.push({ hostPath: src, mountPath: `uploads/${safePathSegment(basename(src), "upload basename")}`, mode: "r" });
  }
  for (const f of session.folders) {
    const src = expand(f.from);
    // Bug 42: a folder models a workspace DIRECTORY copied into `.projects/<id>`; a file source would
    // be copied as a lone file, diverging from Cowork. Mirror the upload `isFile` guard above, inverted
    // — kind-check only when the source EXISTS (a missing source stays on the post-loop missing-mount
    // check, softMissing-aware), so a wrong-kind source fails loud but a missing one is reconciled later.
    if (existsSync(src)) requireDir(src, `folder "${f.from}"`);
    // A folder `to` (or the default basename) is interpolated into `.projects/<id>` — validate it as a
    // single safe segment so neither `to: ../../x` nor a `from` whose basename is ".." escapes .projects.
    const id = f.to ? safePathSegment(f.to, "folder `to`") : safePathSegment(basename(src), "folder default id (from basename)");
    mounts.push({ hostPath: src, mountPath: `.projects/${id}`, mode: f.mode });
  }
  for (const p of session.plugins.local_plugins) {
    const src = expand(p);
    // Bug 41: a plugin root is a DIRECTORY (mounted as a --plugin-dir); a file source would yield a
    // bogus --plugin-dir. Kind-check only when present (missing stays on the post-loop check).
    if (existsSync(src)) requireDir(src, `local_plugin "${p}"`);
    mounts.push({ hostPath: src, mountPath: `.local-plugins/cache/${safePathSegment(basename(src), "local_plugin basename")}`, mode: "r" });
  }
  for (const p of session.plugins.remote_plugins) {
    const src = expand(p);
    // Bug 41: same as local_plugins — a remote-plugin root is a directory; kind-check when present.
    if (existsSync(src)) requireDir(src, `remote_plugin "${p}"`);
    mounts.push({ hostPath: src, mountPath: `.remote-plugins/${safePathSegment(basename(src), "remote_plugin basename")}`, mode: "r" });
  }
  // Local marketplaces: resolve enabled `name@marketplace` plugins to --plugin-dir.
  // The agent loads plugins via --plugin-dir, not the marketplace registry (inert in
  // cowork mode — SPEC §6), so we read marketplace.json and mount the referenced plugins.
  // Real Cowork stages each marketplace plugin at the THREE-level cache path
  // `.local-plugins/cache/<marketplace>/<plugin>/<version>` (verified 2026-06-13 from the
  // desktop spawn argv — `--plugin-dir …/cache/<mp>/<plugin>/<version>`); reproduce that
  // shape so `${CLAUDE_PLUGIN_ROOT}` and the layout match real sessions.
  const mountedBareNames = new Set<string>(); // across ALL marketplaces — dedupe bare `enabled` names
  const declaredLocalMktNames = new Set<string>(); // names of successfully-parsed local marketplaces
  const resolvedEnabled = new Set<string>(); // `enabled` entries that mounted (or hit the legit dedupe-skip)
  for (const mk of session.plugins.local_marketplaces) {
    const mkRoot = expand(mk);
    const manifestPath = join(mkRoot, ".claude-plugin", "marketplace.json");
    // A declared local marketplace whose manifest is absent or unparsable must FAIL (it silently
    // resolved nothing before) — softMissing downgrades to warn-and-skip.
    if (!existsSync(manifestPath)) {
      if (!softMissing)
        throw new Error(
          `local marketplace manifest not found: ${manifestPath}. Fix the path, or set COWORK_HARNESS_SOFT_MISSING=1 to skip it.`,
        );
      warn(`::warning:: [marketplace] manifest missing, excluded (COWORK_HARNESS_SOFT_MISSING): ${manifestPath}\n`);
      continue;
    }
    let manifest: { name?: string; plugins?: Array<{ name: string; source?: string; version?: string }> };
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (e) {
      if (!softMissing)
        throw new Error(
          `local marketplace manifest is not valid JSON: ${manifestPath} (${(e as Error).message}). ` +
            `Fix it, or set COWORK_HARNESS_SOFT_MISSING=1 to skip it.`,
        );
      warn(`::warning:: [marketplace] manifest unparsable, excluded (COWORK_HARNESS_SOFT_MISSING): ${manifestPath}\n`);
      continue;
    }
    // Bug 44: a nameless manifest still has an effective marketplace name (derived from its dir
    // basename) — `mktName` — and plugins resolve under it. Record the DERIVED name so the post-loop
    // typo check (declaredLocalMktNames) recognizes `plugin@<derived>` qualifiers, not only manifests
    // that carry an explicit `name`.
    const mktName = manifest.name ?? basename(mkRoot);
    declaredLocalMktNames.add(mktName);
    for (const en of session.plugins.enabled) {
      // Split on the LAST `@` so a scoped plugin name (@scope/pkg) or an embedded `@` keeps its name and
      // only the trailing `@marketplace` qualifier is peeled off. at>0 so a leading `@` isn't a separator.
      const at = en.lastIndexOf("@");
      const pName = at > 0 ? en.slice(0, at) : en;
      const pMkt = at > 0 ? en.slice(at + 1) : undefined;
      // Bug 45: compare the qualifier against the DERIVED `mktName` unconditionally. The old `manifest.name &&`
      // guard skipped this filter for a nameless manifest, so `p@othermkt` would wrongly match it.
      if (pMkt && pMkt !== mktName) continue;
      const entry = (manifest.plugins ?? []).find((p) => p.name === pName);
      if (!entry) continue;
      const pluginSrc = resolve(mkRoot, entry.source ?? `./${pName}`);
      if (!existsSync(pluginSrc)) continue; // unresolved here; post-loop reconciliation decides whether to throw
      // A bare `enabled` name (no @marketplace) matches EVERY marketplace defining it → duplicate mounts.
      // Dedupe bare names only; a qualified `foo@mkt` is already pinned to one marketplace by the guard above.
      if (!pMkt) {
        if (mountedBareNames.has(pName)) {
          warn(
            `::warning:: [plugins] "${pName}" is enabled without @marketplace and exists in multiple local_marketplaces — mounting only the first ("${mktName}"); qualify it as ${pName}@<marketplace> to pin one\n`,
          );
          resolvedEnabled.add(en); // a legit dedupe-skip is a resolution, not a failure
          continue;
        }
        mountedBareNames.add(pName);
      }
      const version = entry.version ?? readPluginVersion(pluginSrc) ?? "0.0.0";
      // Each component comes from marketplace/plugin metadata (untrusted) and is interpolated into the
      // cache path that becomes a Docker -v overlay arg — reject traversal AND ":"/control chars.
      // (pName may legitimately nest for a scoped name like "@scope/pkg", so nesting is allowed.)
      safeMountSegment(mktName, "marketplace name");
      safeMountSegment(pName, "plugin name");
      safeMountSegment(version, "plugin version");
      mounts.push({ hostPath: pluginSrc, mountPath: `.local-plugins/cache/${mktName}/${pName}/${version}`, mode: "r" });
      resolvedEnabled.add(en);
    }
  }
  // Post-loop reconciliation: an `enabled` entry's resolution is only known after ALL marketplaces are
  // tried (it may resolve on a later one). `enabled` is dual-role — also written verbatim to
  // enabledPlugins (settings.json) for remote/git marketplaces and paired with local_plugins delivery —
  // so fail ONLY when a `name@<mkt>` entry names a DECLARED local marketplace yet did not resolve there
  // (a within-marketplace plugin-name typo). A bare name, or a `@<mkt>` that names no declared local
  // marketplace (remote/git → enabledPlugins), must NOT throw.
  for (const en of session.plugins.enabled) {
    if (resolvedEnabled.has(en)) continue;
    const at = en.lastIndexOf("@");
    if (at <= 0) continue; // bare name → may be remote/git or local_plugins delivery
    const pName = en.slice(0, at);
    const pMkt = en.slice(at + 1);
    if (!declaredLocalMktNames.has(pMkt)) continue; // names a non-local (remote/git) or undeclared marketplace
    if (!softMissing)
      throw new Error(
        `enabled plugin "${en}" names local marketplace "${pMkt}", but plugin "${pName}" was not found or its source is missing there. ` +
          `Fix the name, or set COWORK_HARNESS_SOFT_MISSING=1 to skip it.`,
      );
    warn(`::warning:: [plugins] enabled "${en}" did not resolve in local marketplace "${pMkt}" (COWORK_HARNESS_SOFT_MISSING)\n`);
  }

  const missing = mounts.filter((mt) => !existsSync(mt.hostPath));
  if (missing.length) {
    const list = missing.map((m) => `${m.hostPath} → ${m.mountPath}`).join("; ");
    if (!softMissing)
      throw new Error(`mount source(s) not found: ${list}. Fix the path(s), or set COWORK_HARNESS_SOFT_MISSING=1 to skip them.`);
    warn(`::warning:: [mount] ${missing.length} missing source(s) excluded (COWORK_HARNESS_SOFT_MISSING): ${list}\n`);
  }
  const presentMounts = softMissing ? mounts.filter((mt) => existsSync(mt.hostPath)) : mounts;

  // #21: two sources mapping to the same destination would silently overwrite during staging. Fail
  // before staging, naming the collision, so a same-basename upload/plugin pair can't clobber.
  const seenDest = new Set<string>();
  for (const m of presentMounts) {
    if (seenDest.has(m.mountPath))
      throw new Error(
        `duplicate mount destination "${m.mountPath}" — two sources map to it (they would overwrite). Rename or qualify one.`,
      );
    seenDest.add(m.mountPath);
  }

  // 5. base env — L0 only. effort/thinking are passed as CLI FLAGS at L1/L2 (the
  // CLAUDE_EFFORT env var is a no-op; real Cowork uses --effort/--max-thinking-tokens),
  // so they are NOT set here as env.
  const baseEnv = strippedEnv(baseline);

  // 6. egress
  const egressAllow = session.egress.unrestricted ? ["*"] : [...baseline.network.allowDomains, ...session.egress.extra_allow];

  // 7. plugin roots (--plugin-dir) as guest-relative paths under mnt. #22: derive from PRESENT mounts
  // only, so a soft-missing (excluded) plugin source never yields a --plugin-dir to a non-existent path.
  const pluginDirs = presentMounts
    .filter((m) => m.mountPath.startsWith(".local-plugins/cache/") || m.mountPath.startsWith(".remote-plugins/"))
    .map((m) => m.mountPath);

  if (session.extended_thinking !== undefined) {
    warn(
      "::warning:: [session] `extended_thinking` is deprecated and inert — Cowork has no such toggle. " +
        "Use `max_thinking_tokens` (a number or per-model map; default 31999) instead.\n",
    );
  }

  return {
    configDir,
    mcpConfig: session.mcp.config ? expand(session.mcp.config) : null,
    model: session.model,
    effort: session.effort,
    maxThinkingTokens: session.max_thinking_tokens,
    permissionMode: session.permission_mode,
    permissionParity: session.permission_parity,
    baseEnv,
    mounts: presentMounts,
    pluginDirs,
    egressAllow,
  };
}

/** Load + validate a session baseline from a YAML/JSON file. */
export function loadSession(parsed: unknown): SessionConfig {
  return SessionConfig.parse(parsed);
}

/**
 * Resolve a session's relative host paths against `baseDir` (the session file's own
 * directory), so a scenario+session bundle is relocatable and `run` behaves the same
 * from any working directory. `~` and already-absolute paths pass through untouched.
 * Applied only when a session is loaded from a FILE (the `run`/`record` path); paths
 * supplied as CLI args (`skill --upload/--folder`) stay relative to the user's cwd.
 */
export function resolveSessionPaths(session: SessionConfig, baseDir: string): SessionConfig {
  const r = (p: string) => (p.startsWith("~") || isAbsolute(p) ? p : resolve(baseDir, p));
  // `plugins.marketplaces` is mostly git URLs (left untouched); only a relative LOCAL path is resolved.
  const isUrl = (p: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(p) || p.startsWith("git@");
  return {
    ...session,
    uploads: session.uploads.map(r),
    trusted_folders: session.trusted_folders.map(r),
    folders: session.folders.map((f) => ({ ...f, from: r(f.from) })),
    skills: { ...session.skills, local: session.skills.local.map(r) },
    mcp: { ...session.mcp, config: session.mcp.config ? r(session.mcp.config) : session.mcp.config },
    plugins: {
      ...session.plugins,
      config_dir: session.plugins.config_dir ? r(session.plugins.config_dir) : session.plugins.config_dir,
      marketplaces: session.plugins.marketplaces.map((p) => (isUrl(p) ? p : r(p))),
      local_plugins: session.plugins.local_plugins.map(r),
      local_marketplaces: session.plugins.local_marketplaces.map(r),
      remote_plugins: session.plugins.remote_plugins.map(r),
    },
  };
}
