import { warn } from "./io.js";
import { z } from "zod";
import { mkdirSync, writeFileSync, readFileSync, cpSync, existsSync, statSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, relative, basename, isAbsolute } from "node:path";
import { homedir } from "node:os";
import type { PlatformBaseline } from "./types.js";
import { safePathSegment, safeMountSegment, resolveDeclaredSource } from "./staging/resolve.js";
import { assignFolderMountNames, RESERVED_MOUNT_NAMES, type MountTier } from "./staging/mount-naming.js";
import { MOUNT_BARE_NAME_MIN_VERSION, cmpVersionStrings } from "./baseline.js";
import { containedRealPath } from "./boundary-paths.js";
import { gitModeEnabled, gitFilterFromSet, gitStageStats } from "./run/skill-files.js";
import { BoundaryError } from "./errors.js";
import type { PluginSkillRoot } from "./run/skill-metadata.js";

/** Expand a leading `~` the way a shell would for THE CURRENT user only, then resolve whatever's left
 *  against `base`. `~` and `~/x` become `homedir()` / `join(homedir(), "x")`; a bare absolute path is
 *  returned untouched; anything else is `resolve(base ?? process.cwd(), p)`. A path that starts with
 *  `~<user>` (someone ELSE's home directory) is not expandable without a passwd lookup this project
 *  doesn't do — throw instead of silently passing it through as a literal relative path (that literal
 *  would resolve under `${cwd}/~<user>/...`, a confusing folder easy to miss and easy to mistake for the
 *  real target). This is the single place path expansion lives — `src/session.ts` and
 *  `src/run/run-status.ts` both call it; `src/cli.ts`'s `--run-dir` handling should too (see cli.ts). */
export function expandUserPath(p: string, base?: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  if (p.startsWith("~")) throw new Error(`expandUserPath: "${p}" expands another user's home directory (~<user>), which is not supported`);
  if (isAbsolute(p)) return p;
  return resolve(base ?? process.cwd(), p);
}

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
  from: z.string().min(1), // host path; the mount name is ALWAYS derived (collision-resolved basename of the
  // canonical path), matching real Cowork — there is no author-chosen `to:` override (it has no Cowork
  // analog). For Desktop >= 1.14271.0 the folder mounts at `mnt/<name>`; below it at `mnt/.projects/<name>`.
  // Binary-verified default: Cowork mounts userSelectedFolders `rw` (delete DENIED until approved via
  // fileDeleteApprovedMounts; asar IX resolver). Set `rwd` explicitly to model a delete-approved folder.
  mode: z.enum(["r", "rw", "rwd"]).default("rw"),
});

export const SessionConfig = z.strictObject({
  // --- model & reasoning (Cowork model picker + toggles) ---
  model: z.string().optional(), // setModel
  // setEffort. Accepts the 6-token superset (the 5 real Cowork levels plus `extra`, the UI label for
  // `xhigh`) — the schema does ONLY the accept here (a Zod `.transform` can't be represented in the
  // generated JSON schema, so the `extra` -> `xhigh` wire normalization happens in `loadSession`, the
  // single entry point every session-loading call site funnels through). NO per-model check here: that
  // runs in `buildLaunchPlan` (see `validateEffort`), where the RESOLVED model is available
  // (`applySessionOverrides` rewrites `model` post-parse, so parse-time validation would check the wrong
  // model in a matrix run). Omitted -> resolved to the baseline's medium fallback at argv emission time
  // (real Cowork always emits `--effort`, never omits it).
  effort: z.enum(["low", "medium", "high", "xhigh", "max", "extra"]).optional(),
  // Rendered into the prompt append's <env> "User name:" line ({{accountName}}, >=1.18286.0
  // reconstruction). Real Cowork uses the signed-in account's name; default "User".
  account_name: z.string().optional(),
  // Extended thinking. Binary-verified against app.asar 1.19367.0: Cowork's real control is a BOOLEAN
  // toggle — `setExtendedThinking(sessionId, enabled: boolean)` — not a numeric budget. ON resolves to
  // the fixed `DEFAULT_MAX_THINKING_TOKENS` budget (31999); OFF disables thinking outright
  // (`--thinking disabled`). No code path in real Cowork ever produces an arbitrary N — it's always
  // 31999-or-0. Default ON (matches Cowork's own default). See `debug.max_thinking_tokens` below for a
  // fenced, non-Cowork way to emit an arbitrary budget.
  extended_thinking: z.boolean().default(true).describe("real Cowork on/off toggle for extended thinking; default true (ON)"),
  // Agent turn budget → the `--max-turns` CLI flag (verified supported by the staged agent binary:
  // "Maximum number of agentic turns in non-interactive mode"). RAISES the ceiling for a heavy
  // multi-step/subagent workflow. NAMED DISTINCTLY from the `max_turns` ASSERTION (a post-hoc upper-bound
  // CHECK under `assert:`) to avoid conflating raise-the-ceiling with check-the-ceiling. Omitted by default
  // → no flag passed → the agent inherits its own default (faithful: real Cowork passes no --max-turns for
  // an interactive session, only scheduled tasks default to 100).
  agent_max_turns: z.number().int().positive().optional(),
  permission_mode: z.enum(["default", "acceptEdits", "plan", "bypassPermissions"]).default("default"), // setPermissionMode
  // cowork = pre-approve built-ins (like real Cowork's allowedTools) + auto-allow unscripted
  // tools with a finding; strict = deny unmatched (for adversarial tests).
  permission_parity: z.enum(["cowork", "strict"]).default("cowork"),

  // --- work folders (Cowork "add folder" / Spaces) -> mnt/<name> (>=1.14271.0) or mnt/.projects/<name> (legacy) ---
  folders: z.array(Folder).default([]),
  trusted_folders: z.array(z.string().min(1)).default([]), // localAgentModeTrustedFolders
  auto_mount_folders: z.boolean().default(false), // autoMountFolders

  // --- files uploaded before first prompt -> mnt/uploads ---
  uploads: z.array(z.string().min(1)).default([]),

  // --- discovery: marketplaces / plugins / skills / mcp ---
  // Faithful default = same roots the in-VM claude-code agent uses; override for tests.
  plugins: z
    .object({
      config_dir: z.string().min(1).nullable().default(null), // CLAUDE_CONFIG_DIR; null = harness-managed clean dir
      marketplaces: z.array(z.string().min(1)).default([]), // plugin_marketplaces (git URLs / paths)
      local_marketplaces: z.array(z.string().min(1)).default([]), // LOCAL marketplace dirs -> registered via `claude plugin marketplace add`
      enabled: z.array(z.string().min(1)).default([]), // enabledPlugins (name@marketplace)
      local_plugins: z.array(z.string().min(1)).default([]), // host plugin dirs -> mnt/.local-plugins/marketplaces/<marketplace>/<plugin> (>=1.14271.0; older baselines: mnt/.local-plugins/cache) (--plugin-dir)
      remote_plugins: z.array(z.string().min(1)).default([]), // host plugin dirs -> mnt/.remote-plugins
    })
    .default({ config_dir: null, marketplaces: [], local_marketplaces: [], enabled: [], local_plugins: [], remote_plugins: [] }),

  skills: z
    .object({
      local: z.array(z.string().min(1)).default([]), // host skill dirs -> CLAUDE_CONFIG_DIR/skills
    })
    .default({ local: [] }),

  mcp: z
    .object({
      config: z.string().min(1).nullable().default(null), // --mcp-config file (mcpServers map); "" rejected at parse (was silently treated as "no config")
      enabled: z.array(z.string()).default([]), // enabledMcpjsonServers
    })
    .default({ config: null, enabled: [] }),

  // --- network (Cowork egress, pre-prompt) ---
  egress: z
    .object({
      extra_allow: z.array(z.string().min(1)).default([]), // coworkEgressAllowedHosts additions
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

  // --- staleness fingerprint scope ---
  // The cassette-staleness hash covers the mounted skill/plugin tree. The harness only hard-excludes what
  // is UNIVERSALLY non-runtime (VCS/caches/recorded cassettes); the runtime boundary of a SPECIFIC plugin
  // is the consumer's to declare. `hash_ignore` is a list of gitignore-style globs (matched against each
  // mounted dir's root-relative POSIX path) for paths that don't affect recorded behavior — e.g. `tests/`,
  // `docs/`, `**/*.md`. Composes with (and adds to) a plugin-local `.cowork-hashignore` file at a mount
  // root. Editing an ignored path no longer re-stales cassettes.
  staleness: z
    .object({
      hash_ignore: z.array(z.string().min(1)).default([]),
    })
    .default({ hash_ignore: [] }),

  // --- fenced debug escape hatches (NOT reachable via Cowork's UI) ---
  // A run authored with any `debug.*` field does NOT represent a real Cowork config — kept in its own
  // fenced, self-labeling group so it can never be mistaken for a faithful setting. Use only for targeted
  // local testing (e.g. probing an out-of-band thinking budget); prefer `extended_thinking` for anything
  // meant to model real Cowork behavior.
  debug: z
    .object({
      // Overrides the emitted `--max-thinking-tokens <N>` budget directly, bypassing `extended_thinking`'s
      // on(31999)/off boundary. Real Cowork never emits any budget besides 31999, or (via `--thinking
      // disabled`) none at all — this exists purely as a harness-only escape hatch. Rejects 0/negative
      // (a non-positive budget has no real meaning for the flag).
      max_thinking_tokens: z.number().int().positive().optional(),
    })
    .default({}),

  // --- tier-uniform agent-env knob ---
  // hostloop AND protocol spawn the agent over the OPERATOR's full shell env (`...process.env` /
  // `{...plan.baseEnv}`), while container/microvm build a constructed allowlist. So an operator-exported
  // CLAUDE_CODE_SUBAGENT_MODEL / ENABLE_TOOL_SEARCH / CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS silently
  // affects only the env-inheriting tiers. This field is the authored, uniform replacement: it applies
  // across ALL FOUR tiers, and the three keys are additionally SCRUBBED from the operator layer on
  // hostloop/protocol (the only tiers that inherit it) so an unset stray shell value can never leak
  // through. Precedence is TIER-QUALIFIED: hostloop/container/microvm layer a baseline `spawn.env`, so
  // it's knob > baseline spawn.env > operator env (scrubbed); protocol has no baseline-env overlay (it
  // spawns from `{...plan.baseEnv}` only), so it's the two-layer knob > operator env (scrubbed).
  // `tool_search` unset (key absent) = binary mode `tst` — ToolSearch ON first-party; the binary's
  // "standard" mode name means DISABLED (a naming trap) — `tool_search: "off"` emits
  // `ENABLE_TOOL_SEARCH="off"`, the binary's actual disable spelling.
  agent_env: z
    .strictObject({
      subagent_model: z.string().optional(), // -> CLAUDE_CODE_SUBAGENT_MODEL (binary precedence: env > dispatch param > frontmatter > inherit)
      tool_search: z.enum(["auto", "off"]).optional(), // -> ENABLE_TOOL_SEARCH
      disable_experimental_betas: z.boolean().optional(), // -> CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS="1" (also disables ToolSearch)
    })
    .default({}),
});

/** The three env keys that leak asymmetrically: hostloop/protocol inherit them from the operator's shell
 *  (`...process.env` / `{...plan.baseEnv}`); container/microvm never do (a constructed allowlist). Scrubbed
 *  from the OPERATOR layer alone (before any baseline/knob overlay) on the two inheriting tiers. */
export const SCRUBBED_AGENT_ENV_KEYS = [
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "ENABLE_TOOL_SEARCH",
  "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
] as const;

/** Map the authored `agent_env` knob to its exact env keys. An unset field emits NO key — never an empty
 *  string — so e.g. omitted `tool_search` leaves the binary at its own default (mode `tst`, ToolSearch ON
 *  first-party), rather than accidentally forcing some empty-string mode. */
export function agentEnvOverrides(cfg: {
  subagent_model?: string;
  tool_search?: "auto" | "off";
  disable_experimental_betas?: boolean;
}): Record<string, string> {
  const out: Record<string, string> = {};
  if (cfg.subagent_model !== undefined) out.CLAUDE_CODE_SUBAGENT_MODEL = cfg.subagent_model;
  if (cfg.tool_search !== undefined) out.ENABLE_TOOL_SEARCH = cfg.tool_search;
  if (cfg.disable_experimental_betas) out.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = "1";
  return out;
}

export type SessionConfig = z.infer<typeof SessionConfig> & {
  /** Resolved-only, never authored: a map from each RESOLVED `remote_plugins` path to the synthetic mount id
   *  derived from its DECLARED (pre-absolutization) source string. Populated by `resolveSessionPaths` so the
   *  `.remote-plugins/plugin_<id>` leaf stays relocatable — a relative YAML declaration yields the same id on
   *  any machine/checkout, instead of hashing a machine-specific absolute path. Absent on inline/CLI-arg
   *  sessions (which skip resolution); `buildLaunchPlan` then falls back to hashing the given string directly.
   *  Deliberately OUTSIDE the Zod strictObject schema so it can't be set from YAML and never enters the
   *  session fingerprint / origin-source set. */
  _remotePluginIds?: Record<string, string>;
};

/** A concrete mount the runtime should create (path relative to mnt cwd). */
export interface Mount {
  hostPath: string;
  mountPath: string;
  mode: "r" | "rw" | "rwd";
  /**
   * Structural discriminator so downstream code (host-loop prompt folder filter, artifact visibility,
   * chat labels) keys off the KIND rather than fragile `mountPath` string prefixes like `.projects/`.
   */
  kind: "folder" | "upload" | "local-plugin" | "remote-plugin" | "marketplace-plugin";
  /**
   * Precomputed staging copy filter. When set, the runtime copy sites use it verbatim instead of
   * re-deriving via `gitCpFilter` — so the file count reported at plan-build equals the delivered set
   * (no second `git ls-files`, no TOCTOU). Set for plugin-kind mounts under git mode; undefined for
   * folders/uploads (which keep the at-copy-time fallback).
   */
  stageFilter?: (src: string, dest: string) => boolean;
}

/**
 * Declarative launch plan — runtime-agnostic. Each runtime (host / container /
 * microvm) maps these host paths into its own world and assembles CLI args.
 */
export interface LaunchPlan {
  configDir: string; // materialized CLAUDE_CONFIG_DIR (host path)
  mcpConfig: string | null; // host path to --mcp-config file, if any
  model?: string;
  // Already validated against the resolved model's per-model config (see `validateEffort`) but NOT
  // yet resolved to the medium fallback — that resolution is the runtime layer's job (argv.ts/protocol.ts),
  // sourced from the baseline's `spawn.effortDefault`, so there is one fallback site, not one per plan field.
  effort?: string;
  // extended_thinking, resolved (schema defaults it true). Optional here (undefined ⇒ the runtime layer
  // treats it as ON, matching Cowork's own default) only so a LaunchPlan literal built directly in a test
  // doesn't need to set it — buildLaunchPlan always carries a concrete boolean from the session field.
  extendedThinking?: boolean;
  // The fenced, non-Cowork `debug.max_thinking_tokens` override. When set, ALWAYS wins over
  // `extendedThinking` and emits `--max-thinking-tokens <N>` verbatim — real Cowork has no such
  // per-run override; a plan carrying this does not represent a real Cowork config.
  debugMaxThinkingTokens?: number;
  agentMaxTurns?: number; // session turn budget → --max-turns (omitted ⇒ agent default; distinct from the max_turns assertion)
  // The tier-uniform agent-env knob (agentEnvOverrides(session.agent_env)) — each runtime layers this
  // LAST over its own env construction (knob wins), after scrubbing SCRUBBED_AGENT_ENV_KEYS from the
  // operator layer on the tiers that inherit one (hostloop/protocol). Optional (like extendedThinking
  // above) only so a LaunchPlan literal built directly in a test doesn't need to set it — every runtime
  // treats `plan.agentEnv ?? {}` as a no-op; buildLaunchPlan always carries a concrete (possibly empty)
  // object from the session field.
  agentEnv?: Record<string, string>;
  permissionMode: string;
  permissionParity: "cowork" | "strict";
  baseEnv: NodeJS.ProcessEnv; // Cowork bg-env-strip applied; CLAUDE_CONFIG_DIR set by the runtime
  mounts: Mount[]; // uploads + projects + plugin roots (mountPath relative to mnt)
  pluginDirs: string[]; // mnt-relative plugin roots for --plugin-dir (incl. marketplace-resolved)
  egressAllow: string[]; // baseline allowlist + session extra (or ["*"] if unrestricted)
  agentSessionId?: string; // the agent's native --session-id (pinned for resume); set by executeScenario
  resume?: boolean; // pass --resume <agentSessionId> instead of --session-id (continue a prior session)
  /** capture the `no_unexpected_files` pre-run baseline before spawning. Set by executeScenario when the
   *  scenario asserts the key (the walk has a real cost on big connected folders) or the run is a
   *  recording (cassettes always carry the baseline so a later assert-add replays without re-record). */
  capturePreRun?: boolean;
}

/** The user-visible roots derived from a plan: `outputs` + each connected folder's RESOLVED mount name.
 *  Single owner for the derivation — the pre-run baseline walk and the post-run artifact walk MUST
 *  enumerate the same root set, or the `no_unexpected_files` diff reports phantom "created" files. */
export function userVisibleRootsFromPlan(plan: LaunchPlan): string[] {
  return ["outputs", ...plan.mounts.filter((m) => m.kind === "folder").map((m) => m.mountPath)];
}

/** The mount prefixes of read-only (`mode: "r"`) connected folders — inputs, not deliverables. Used to
 *  strip captured BODIES from the cassette manifest (fidelity/no-bloat) and to exclude them from
 *  `RunResult.artifacts` (an input is not something `scaffold`/`file_exists` should treat as output).
 *  Does NOT change `userVisibleRootsFromPlan` — `no_unexpected_files` and `computer_links_resolve`
 *  still enumerate these roots; only their captured content changes shape. */
export function readonlyFolderRootsFromPlan(plan: LaunchPlan): string[] {
  return plan.mounts.filter((m) => m.kind === "folder" && m.mode === "r").map((m) => m.mountPath);
}

/** Plugin skill-source roots for `resolveAvailableSkills`'s whenToUse enrichment. Reads each
 *  staged plugin mount's `.claude-plugin/plugin.json` for the plugin `name` + `skills` subdir; best-effort,
 *  never throws (a missing/corrupt manifest falls back to the dir basename + a "skills" subdir). */
export function pluginSkillRootsFromPlan(plan: LaunchPlan): PluginSkillRoot[] {
  const out: PluginSkillRoot[] = [];
  for (const m of plan.mounts) {
    if (m.kind !== "local-plugin" && m.kind !== "remote-plugin" && m.kind !== "marketplace-plugin") continue;
    let name = basename(m.hostPath);
    let skillsSubdir = "skills";
    const pj = join(m.hostPath, ".claude-plugin", "plugin.json");
    try {
      const parsed = JSON.parse(readFileSync(pj, "utf8")) as { name?: unknown; skills?: unknown };
      if (typeof parsed.name === "string" && parsed.name) name = parsed.name;
      if (typeof parsed.skills === "string" && parsed.skills) skillsSubdir = parsed.skills.replace(/^\.\//, "");
    } catch {
      /* missing/corrupt manifest — best-effort fallback */
    }
    out.push({ pluginName: name, hostPath: m.hostPath, skillsSubdir });
  }
  return out;
}

/**
 * Read a plugin's declared version from its `.claude-plugin/plugin.json`.
 *
 * split missing-vs-malformed. A genuinely-absent manifest returns `null` (legitimately
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

/** Synthesize a migrated-Cowork remote-plugin mount id (`plugin_<24 base62>`) from a declared source
 *  string. Deterministic (same declared value → same id) and collision-safe across distinct values.
 *  base62-encodes a sha256 of the value and takes 24 chars — matching the observed opaque shape (mixed-case
 *  alnum), NOT a canonical uppercase ULID (no ULID library pulled in). */
function synthRemotePluginId(declaredSource: string): string {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let n = BigInt("0x" + createHash("sha256").update(declaredSource).digest("hex"));
  let out = "";
  while (out.length < 24) {
    out = alphabet[Number(n % 62n)] + out;
    n /= 62n;
  }
  return `plugin_${out}`;
}

/**
 * Validate an explicit `effort:` (already `extra`→`xhigh` normalized by Zod) against the RESOLVED
 * model's per-model config in the baseline's `spawn` map — fail loud, per Cowork's four model classes
 * (real Cowork ALWAYS emits `--effort`, falling back to `medium` when nothing is set; that fallback
 * resolution happens in the runtime layer, not here — this function only validates an EXPLICIT value):
 *
 *   1. In `effortByModel` WITH `effortLevels` (a picker model, e.g. claude-opus-4-8): an explicit
 *      `effort:` must be one of that model's offered levels, else throw naming them.
 *   2. In `effortByModel` with NO `effortLevels` (a no-effort model, e.g. claude-haiku-4-5/
 *      claude-sonnet-4-5 — no picker in the UI at all): an explicit `effort:` is itself the error.
 *   3. Not in the literal map but matching `effortRegexDefault.pattern` (the fable/mythos regex-default
 *      class): validate against its `effortLevels`.
 *   4. Unknown model id, or no model declared: no per-model set to validate against — any of the six
 *      accepted tokens (already normalized to five) passes through untouched.
 */
function validateEffort(effort: string | undefined, model: string | undefined, baseline: PlatformBaseline): void {
  const spawn = baseline.spawn;
  const entry = model !== undefined ? spawn?.effortByModel?.[model] : undefined;
  if (entry) {
    if (entry.effortLevels) {
      if (effort !== undefined && !entry.effortLevels.includes(effort))
        throw new Error(`effort "${effort}" is not offered by model "${model}" — supported levels: ${entry.effortLevels.join(", ")}`);
    } else if (effort !== undefined) {
      throw new Error(
        `model "${model}" has no effort selector — omit \`effort:\` (real Cowork always runs it at the medium fallback, with no UI picker)`,
      );
    }
    return;
  }
  const regexDefault = spawn?.effortRegexDefault;
  if (model !== undefined && regexDefault && new RegExp(regexDefault.pattern).test(model)) {
    if (effort !== undefined && !regexDefault.effortLevels.includes(effort))
      throw new Error(`effort "${effort}" is not offered by model "${model}" — supported levels: ${regexDefault.effortLevels.join(", ")}`);
  }
  // else: class 4 (unknown model id, or no model declared) — accept any of the six tokens, no throw.
}

/**
 * Materialize the session into a launch plan: builds a clean CLAUDE_CONFIG_DIR
 * (settings.json with enabledPlugins / enabledMcpjsonServers / plugin_marketplaces),
 * stages skills + plugins, and computes mounts + flags. Because the agent we run
 * is the same claude-code binary Cowork stages, this reproduces Cowork's discovery.
 */
export function buildLaunchPlan(
  session: SessionConfig,
  baseline: PlatformBaseline,
  outDir: string,
  tier: MountTier = "hostloop",
  // on resume the runtimes SKIP re-staging (the persisted tree survives), so the empty-mount guard
  // and the staged-set notices must not run — the sources may legitimately be gone. The caller threads
  // its resume flag here (set after the plan is built today, so it must be a param, not `plan.resume`).
  resume = false,
): LaunchPlan {
  // Fail loud before any staging side effect: an `effort:` the resolved model doesn't offer (or an
  // explicit `effort:` on a no-picker model) is a load-time config error, not a silent coercion.
  validateEffort(session.effort, session.model, baseline);

  // Launch-time `~` expansion ONLY — leaves relative/absolute paths untouched so downstream mount-name
  // derivation still sees the authored basename (e.g. a trailing `..` must stay `..` to be rejected).
  // (Distinct from expandUserPath, which also resolves relative paths against cwd — wrong here.)
  const expand = (p: string) => p.replace(/^~(?=$|\/)/, homedir());

  // A plugin/skill source in a git work tree delivers only its git-TRACKED files (the fidelity
  // boundary — real Cowork installs from a repo and sees only committed files). Make that VISIBLE in
  // both directions instead of silently surprising: hard-FAIL when it would mount empty, loud-NOTICE
  // when some files are excluded. Returns the cpSync filter built from the SAME tracked snapshot used
  // for the counts (no second `git ls-files` ⇒ counted == delivered). Skipped on resume.
  const stageFilterFor = (src: string, label: string): ((s: string, d: string) => boolean) | null => {
    if (resume || !gitModeEnabled()) return null; // resume re-stages nothing; gitMode off → raw copy
    const { tracked, untracked } = gitStageStats(src);
    if (!tracked) return null; // not a git work tree → raw copy (unchanged behavior)
    if (tracked.size === 0)
      throw new BoundaryError(
        `${label} has 0 git-tracked files — staging delivers tracked files only, so it would mount EMPTY and the skill would not load. ` +
          `Fix: 'git add' it, or set COWORK_HARNESS_GITSET=0 to copy untracked files.`,
      );
    if (untracked > 0)
      warn(
        `::notice:: [stage] ${label}: ${untracked} untracked file(s) excluded — real Cowork only sees committed files. ` +
          `'git add' them to test as-published, or COWORK_HARNESS_GITSET=0 to include them.\n`,
      );
    return gitFilterFromSet(src, tracked);
  };

  // 1. CLAUDE_CONFIG_DIR — clean managed dir unless the session pins one.
  const pinnedConfigDir = session.plugins.config_dir ? expand(session.plugins.config_dir) : undefined;
  // Writing settings.json/cowork_settings.json into a user-supplied EXISTING dir would clobber
  // their real Claude config. Require an explicit opt-in; a fresh/non-existent pinned dir is fine.
  if (pinnedConfigDir && existsSync(pinnedConfigDir) && (process.env.COWORK_HARNESS_ALLOW_CONFIG_DIR_WRITE ?? "") === "")
    throw new Error(
      `plugins.config_dir is an existing directory (${pinnedConfigDir}); the harness would overwrite its settings.json/cowork_settings.json. ` +
        `Set COWORK_HARNESS_ALLOW_CONFIG_DIR_WRITE=1 to allow, or use a managed dir (config_dir: null).`,
    );
  // A pinned config_dir that exists but is NOT a directory (e.g. a regular file) would otherwise fail
  // cryptically at the mkdirSync below with ENOTDIR — behind the write escape-hatch above. Fail clearly.
  if (pinnedConfigDir && existsSync(pinnedConfigDir) && !statSync(pinnedConfigDir).isDirectory())
    throw new Error(`plugins.config_dir exists but is not a directory: ${pinnedConfigDir}`);
  const configDir = pinnedConfigDir ?? join(resolve(outDir), "claude-config");
  mkdirSync(join(configDir, "skills"), { recursive: true });
  mkdirSync(join(configDir, "plugins"), { recursive: true });

  // 2. settings — the discovery knobs. Written to BOTH settings.json and
  // cowork_settings.json: the agent's userSettings filename is cowork_settings.json
  // whenever CLAUDE_CODE_USE_COWORK_PLUGINS is truthy (TSO() in the 2.1.170 ELF), and
  // settings.json otherwise — writing both makes either state behave. (Real Cowork
  // delivers plugins via --plugin-dir, not these knobs; kept mainly for L0.)
  // enabledPlugins: keyed object { "name@marketplace": true } — binary enforces object shape.
  // extraKnownMarketplaces: keyed by MARKETPLACE NAME (the @marketplace half of enabledPlugins entries),
  //   value { source: { source: <kind>, url } }. The binary verifies the key equals the @marketplace
  //   qualifier in enabledPlugins. Name is derived as basename(url).replace(/\.git$/, ""), so enabled[]
  //   qualifiers must reference this derived name (e.g. "foo@m" for url "https://host/m.git").
  const settings: Record<string, unknown> = {};
  if (session.plugins.enabled.length) settings.enabledPlugins = Object.fromEntries(session.plugins.enabled.map((e) => [e, true]));
  if (session.plugins.marketplaces.length)
    settings.extraKnownMarketplaces = Object.fromEntries(
      session.plugins.marketplaces.map((url) => {
        const name = basename(url).replace(/\.git$/, "");
        return [name, { source: { source: "git", url } }];
      }),
    );
  if (session.mcp.enabled.length) settings.enabledMcpjsonServers = session.mcp.enabled;
  settings.localAgentModeTrustedFolders = session.trusted_folders.map((p) => expand(p));
  settings.autoMountFolders = session.auto_mount_folders;
  const settingsJson = JSON.stringify(settings, null, 2);
  writeFileSync(join(configDir, "settings.json"), settingsJson);
  writeFileSync(join(configDir, "cowork_settings.json"), settingsJson);

  // Fail-loud is the only path for a declared source. A missing source FAILS by default (the
  // runtimes existsSync-skip the copy, so the agent silently gets a path that does not exist — a
  // confusing late failure, or a manufactured green). COWORK_HARNESS_SOFT_MISSING=1 downgrades every
  // such case to warn-and-exclude. Defined up here because skills (below) consult it too.
  const softMissing = (process.env.COWORK_HARNESS_SOFT_MISSING ?? "") !== "";

  // 3. stage local skills into CLAUDE_CONFIG_DIR/skills. A missing source fails (like a mount); two
  // skills with the same basename would copy to the same dest and silently clobber — fail on that too.
  // SKIP entirely on resume — the persisted configDir/skills survives, the sources may be gone, and
  // re-running the missing-source resolve below would otherwise false-fail a legitimate --resume.
  const skillDests = new Set<string>();
  if (!resume)
    for (const s of session.skills.local) {
      const src = expand(s);
      // A skill is staged IMMEDIATELY (cpSync'd recursively into CLAUDE_CONFIG_DIR/skills), not via the
      // mount list, so its missing decision is made here (not deferred to the post-loop batch check). The
      // resolver kind-checks a present source (a file source would copy as a lone file, diverging from
      // Cowork's skill-dir model) and honors softMissing: a missing source throws by default, or returns
      // null (skip) under softMissing.
      const resolved = resolveDeclaredSource(src, "", "r", "dir", { softMissing, deferMissing: false, what: "skill source" });
      if (!resolved) {
        warn(`::warning:: [skill] missing source excluded (COWORK_HARNESS_SOFT_MISSING): ${src}\n`);
        continue;
      }
      const dest = safePathSegment(basename(src), "skill basename");
      if (skillDests.has(dest))
        throw new Error(
          `duplicate skill destination "skills/${dest}" — two skills.local entries share a basename (they would overwrite). Rename or relocate one.`,
        );
      skillDests.add(dest);
      // deliver the git-tracked set (the fidelity boundary), but VISIBLY — hard-fail if it would be
      // empty, notice if files are excluded. Filter is built from the same snapshot used for those counts.
      const skillFilter = stageFilterFor(src, `skill '${basename(src)}'`);
      cpSync(src, join(configDir, "skills", dest), { recursive: true, ...(skillFilter ? { filter: skillFilter } : {}) });
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
    mounts.push({ hostPath: src, mountPath: `uploads/${safePathSegment(basename(src), "upload basename")}`, mode: "r", kind: "upload" });
  }
  // Work folders. Real Cowork (Desktop >= MIN) mounts each connected folder at `mnt/<name>` where
  // `<name>` is a collision-resolved BASENAME of the folder's CANONICAL path (no author override, no
  // `.projects/` parent). Below MIN we keep the legacy `.projects/<basename>` shape (unverified older
  // builds — gated, not churned). There is NO `to:` override: names are always derived (faithful).
  const bareNames = cmpVersionStrings(baseline.appVersion, MOUNT_BARE_NAME_MIN_VERSION) >= 0;
  // Canonicalize (realpath) to match real Cowork's `Os()`=canonical; fall back to the expanded path
  // when the source is missing (softMissing/deferred) so naming still works.
  const canon = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const folderCanon = session.folders.map((f) => canon(expand(f.from)));
  const nameByCanon = bareNames ? assignFolderMountNames(folderCanon, tier) : null;
  for (let i = 0; i < session.folders.length; i++) {
    const f = session.folders[i];
    const src = expand(f.from);
    // a folder models a workspace DIRECTORY; a file source would be copied as a lone file, diverging
    // from Cowork. The resolver kind-checks only when the source EXISTS — a missing source is deferred
    // to the post-loop missing-mount check (softMissing-aware).
    const mountPath = bareNames
      ? safePathSegment(nameByCanon!.get(folderCanon[i])!, "folder mount name")
      : `.projects/${safePathSegment(basename(src), "folder default id (from basename)")}`;
    mounts.push({
      ...resolveDeclaredSource(src, mountPath, f.mode, "dir", { softMissing, deferMissing: true, what: `folder "${f.from}"` })!,
      kind: "folder",
    });
  }
  for (const p of session.plugins.local_plugins) {
    const src = expand(p);
    // a plugin root is a DIRECTORY (mounted as a --plugin-dir); a file source would yield a
    // bogus --plugin-dir. Kind-check only when present (missing deferred to the post-loop check).
    // Real Cowork (>= MIN) mounts ALL local-class plugins under `.local-plugins/marketplaces/<mp>/<plugin>`;
    // a user-added local dir maps to the synthetic `local-desktop-app-uploads` marketplace. No `cache/`, no
    // version segment. Below MIN, keep the legacy `.local-plugins/cache/<base>` shape (gated, unverified).
    // NOTE: this is the LEGACY pre-migration / install-staging channel (`local-desktop-app-uploads` is a real
    // marketplace). To exercise an UPLOADED plugin the way a migrated Cowork install serves it, use
    // `remote_plugins` (→ `.remote-plugins/plugin_<id>`) below.
    const leaf = safePathSegment(basename(src), "local_plugin basename");
    const mountPath = bareNames ? `.local-plugins/marketplaces/local-desktop-app-uploads/${leaf}` : `.local-plugins/cache/${leaf}`;
    const stageFilter = existsSync(src) ? (stageFilterFor(src, `local_plugin '${leaf}'`) ?? undefined) : undefined;
    mounts.push({
      ...resolveDeclaredSource(src, mountPath, "r", "dir", { softMissing, deferMissing: true, what: `local_plugin "${p}"` })!,
      kind: "local-plugin",
      stageFilter,
    });
  }
  for (const p of session.plugins.remote_plugins) {
    const src = expand(p);
    // Real (migrated) Cowork serves UI-uploaded / org-remote plugins from `.remote-plugins/plugin_<ULID>`
    // (live probe + asar migration), NOT the basename. Synthesize a DETERMINISTIC id — not the content
    // (churns on every skill edit → kills the dev loop) and not a fresh random id (would break replay
    // determinism; real Cowork mints a per-upload ULID, but we need stability to re-derive the same layout
    // on replay). Hashing the whole source (not just the basename) fixes the pre-existing basename collision
    // (two remote_plugins sharing a basename now differ). Shape matches the observed opaque `plugin_` + 24
    // mixed-case base62 chars — NOT a canonical uppercase ULID (no lib).
    // For a FILE-loaded session the id is derived from the DECLARED (pre-resolution) string and carried in
    // `_remotePluginIds` (keyed by this resolved path), so it's relocatable across machines/checkouts. Inline
    // and CLI-arg sessions skip resolution → fall back to hashing the given string directly (there `p` IS the
    // declared string, so the behavior is identical).
    const remoteId = session._remotePluginIds?.[p] ?? synthRemotePluginId(p);
    const mountPath = `.remote-plugins/${remoteId}`;
    const stageFilter = existsSync(src) ? (stageFilterFor(src, `remote_plugin '${remoteId}'`) ?? undefined) : undefined;
    mounts.push({
      ...resolveDeclaredSource(src, mountPath, "r", "dir", { softMissing, deferMissing: true, what: `remote_plugin "${p}"` })!,
      kind: "remote-plugin",
      stageFilter,
    });
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
  const bareLocalSourceMissing = new Set<string>(); // bare enabled names found in a marketplace but with missing source
  // local_plugins and remote_plugins deliver plugins outside the marketplace loop. A bare `enabled` name
  // that matches one of these basenames must NOT error even if the marketplace entry has a missing source.
  const nonMarketplacePluginNames = new Set<string>([
    ...session.plugins.local_plugins.map((p) => basename(expand(p))),
    ...session.plugins.remote_plugins.map((p) => basename(expand(p))),
  ]);
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
    // Validate manifest shape to produce actionable errors instead of TypeErrors.
    // The plugins-array check is the direct TypeError fix (manifest.plugins.find at the loop below
    // throws when plugins is an object). The name/source/version string checks are defense-in-depth.
    if (manifest.plugins !== undefined && !Array.isArray(manifest.plugins)) {
      const msg = `local marketplace manifest has invalid shape: "plugins" must be an array (got ${typeof manifest.plugins}): ${manifestPath}`;
      if (!softMissing) throw new Error(msg + " Fix it, or set COWORK_HARNESS_SOFT_MISSING=1 to skip it.");
      warn(`::warning:: [marketplace] ${msg}, excluded (COWORK_HARNESS_SOFT_MISSING)\n`);
      continue;
    }
    if (manifest.name !== undefined && (typeof manifest.name !== "string" || manifest.name.length === 0)) {
      // An empty-string name is rejected here with a direct diagnostic rather than surviving the
      // `?? basename` fallback below (which `??` does NOT replace) and failing far downstream inside
      // `safeMountSegment` with a generic "unsafe marketplace name" error.
      const got = typeof manifest.name !== "string" ? typeof manifest.name : "empty string";
      const msg = `local marketplace manifest has invalid shape: "name" must be a non-empty string (got ${got}): ${manifestPath}`;
      if (!softMissing) throw new Error(msg + " Fix it, or set COWORK_HARNESS_SOFT_MISSING=1 to skip it.");
      warn(`::warning:: [marketplace] ${msg}, excluded (COWORK_HARNESS_SOFT_MISSING)\n`);
      continue;
    }
    let badEntry = false;
    for (const entry of manifest.plugins ?? []) {
      for (const field of ["name", "source", "version"] as const) {
        const val = (entry as any)[field];
        if (val !== undefined && typeof val !== "string") {
          const msg = `local marketplace manifest has invalid shape: plugin entry "${field}" must be a string (got ${typeof val}): ${manifestPath}`;
          if (!softMissing) throw new Error(msg + " Fix it, or set COWORK_HARNESS_SOFT_MISSING=1 to skip it.");
          warn(`::warning:: [marketplace] ${msg}, excluded (COWORK_HARNESS_SOFT_MISSING)\n`);
          badEntry = true;
          break;
        }
        // A plugin entry's `name` is used to derive its mount segment; an empty string yields the same
        // cryptic downstream `safeMountSegment` failure — reject it here with a direct diagnostic.
        if (field === "name" && typeof val === "string" && val.length === 0) {
          const msg = `local marketplace manifest has invalid shape: plugin entry "name" must be non-empty: ${manifestPath}`;
          if (!softMissing) throw new Error(msg + " Fix it, or set COWORK_HARNESS_SOFT_MISSING=1 to skip it.");
          warn(`::warning:: [marketplace] ${msg}, excluded (COWORK_HARNESS_SOFT_MISSING)\n`);
          badEntry = true;
          break;
        }
      }
      if (badEntry) break;
    }
    if (badEntry) continue;
    // a nameless manifest still has an effective marketplace name (derived from its dir
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
      // compare the qualifier against the DERIVED `mktName` unconditionally. The old `manifest.name &&`
      // guard skipped this filter for a nameless manifest, so `p@othermkt` would wrongly match it.
      if (pMkt && pMkt !== mktName) continue;
      const entry = (manifest.plugins ?? []).find((p) => p.name === pName);
      if (!entry) continue;
      const pluginSrc = resolve(mkRoot, entry.source ?? `./${pName}`);
      // reject entry.source values that escape the marketplace root (absolute paths or .. traversal),
      // OR that resolve to the marketplace root ITSELF. A present but degenerate source — "", ".", "./",
      // "./." — all `resolve(mkRoot, …) === mkRoot`, so `relative(mkRoot, pluginSrc) === ""` neither starts
      // with ".." nor is absolute, the realpath containment returns true on equality, and isDirectory()
      // passes → the WHOLE marketplace root would stage as one plugin. `rel === ""` catches them all.
      if (entry.source !== undefined) {
        const rel = relative(mkRoot, pluginSrc);
        if (rel === "")
          throw new Error(`cowork-harness: marketplace entry.source "${entry.source}" resolves to the marketplace root itself`);
        if (rel.startsWith("..") || isAbsolute(rel))
          throw new Error(`cowork-harness: marketplace entry.source "${entry.source}" escapes the marketplace root`);
      }
      if (!existsSync(pluginSrc)) {
        if (!pMkt) bareLocalSourceMissing.add(en); // bare name with missing source; post-loop decides
        continue; // unresolved here; post-loop reconciliation decides whether to throw
      }
      // the lexical `relative(mkRoot, pluginSrc)` guard above is NOT enough — `statSync` (and the
      // eventual `cpSync` mount) FOLLOW symlinks, so an in-root symlink `mkRoot/sub -> /etc` passes the
      // lexical check (rel = "sub") yet resolves outside the marketplace tree. Resolve BOTH sides with
      // realpath and require containment before mounting. (Runs only once the source exists, since
      // realpath requires it; the lexical guard already rejected absolute / `..` declared sources.)
      if (!containedRealPath(realpathSync(mkRoot), realpathSync(pluginSrc)))
        throw new Error(
          `cowork-harness: marketplace entry.source "${entry.source ?? `./${pName}`}" resolves outside the marketplace root (symlink escape)`,
        );
      // marketplace plugin sources must be directories (same kind-check as local_plugins / remote_plugins).
      if (!statSync(pluginSrc).isDirectory())
        throw new Error(`cowork-harness: marketplace entry.source "${entry.source ?? `./${pName}`}" is not a directory`);
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
      // Each component comes from marketplace/plugin metadata (untrusted) and is interpolated into the
      // cache path that becomes a Docker -v overlay arg — reject traversal AND ":"/control chars.
      // (pName may legitimately nest for a scoped name like "@scope/pkg", so nesting is allowed.)
      safeMountSegment(mktName, "marketplace name");
      safeMountSegment(pName, "plugin name");
      // Real Cowork (>= MIN): `.local-plugins/marketplaces/<marketplaceName>/<pluginName>` (NO `cache/`, NO
      // version segment — the `<mkt>/<plugin>` pair is the natural collision-free disambiguator). Legacy
      // keeps the harness's synthetic 3-level `cache/<mkt>/<plugin>/<version>` shape (gated).
      let mountPath: string;
      if (bareNames) {
        mountPath = `.local-plugins/marketplaces/${mktName}/${pName}`;
      } else {
        const version = entry.version ?? readPluginVersion(pluginSrc) ?? "0.0.0";
        safeMountSegment(version, "plugin version");
        mountPath = `.local-plugins/cache/${mktName}/${pName}/${version}`;
      }
      mounts.push({
        hostPath: pluginSrc,
        mountPath,
        mode: "r",
        kind: "marketplace-plugin",
        stageFilter: stageFilterFor(pluginSrc, `marketplace plugin '${pName}'`) ?? undefined,
      });
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
    if (at <= 0) {
      // Bare name: error only when it was found in a local marketplace but its source was missing,
      // AND it is not delivered via local_plugins/remote_plugins (which mount outside this loop).
      if (bareLocalSourceMissing.has(en) && !nonMarketplacePluginNames.has(en)) {
        if (!softMissing)
          throw new Error(
            `enabled plugin "${en}" was declared in a local marketplace but failed to mount (source directory missing). ` +
              `Fix the path, or set COWORK_HARNESS_SOFT_MISSING=1 to skip it.`,
          );
        warn(`::warning:: [plugins] enabled "${en}" declared in local marketplace but failed to mount (COWORK_HARNESS_SOFT_MISSING)\n`);
      }
      continue; // bare name → may be remote/git or local_plugins delivery
    }
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

  // Two sources mapping to the same destination would silently overwrite during staging. Fail
  // before staging, naming the collision, so a same-basename upload/plugin pair can't clobber.
  // Seed with the RESERVED special-dir names + the harness's fixed staged dirs (`.claude`): under the VM
  // tier `fy` does NOT reserve these, so a user folder literally named e.g. `outputs` resolves to bare
  // `outputs` and would otherwise shadow the fixed scratch dir. Seeding makes it trip this guard loudly
  // (stricter-than-real-Cowork, which silently shadows — documented divergence). Host-loop `hL` already
  // bumps such folders via the reserved seed, so they never collide there.
  const FIXED_MOUNT_DIRS = [...RESERVED_MOUNT_NAMES, ".claude"];
  const seenDest = new Set<string>(FIXED_MOUNT_DIRS);
  for (const m of presentMounts) {
    if (seenDest.has(m.mountPath)) {
      const reserved = (FIXED_MOUNT_DIRS as string[]).includes(m.mountPath);
      throw new Error(
        reserved
          ? `mount destination "${m.mountPath}" collides with a reserved Cowork mount — a connected folder resolved to a fixed special-dir name. Rename the folder.`
          : `duplicate mount destination "${m.mountPath}" — two sources map to it (they would overwrite). Rename or qualify one.`,
      );
    }
    seenDest.add(m.mountPath);
  }

  // 5. base env — L0 only. effort/thinking are passed as CLI FLAGS at L1/L2 (the
  // CLAUDE_EFFORT env var is a no-op; real Cowork uses --effort/--max-thinking-tokens),
  // so they are NOT set here as env.
  const baseEnv = strippedEnv(baseline);

  // 6. egress
  const egressAllow = session.egress.unrestricted ? ["*"] : [...baseline.network.allowDomains, ...session.egress.extra_allow];

  // 7. plugin roots (--plugin-dir) as guest-relative paths under mnt. Derive from PRESENT mounts
  // only, so a soft-missing (excluded) plugin source never yields a --plugin-dir to a non-existent path.
  const pluginDirs = presentMounts
    .filter((m) => m.kind === "local-plugin" || m.kind === "remote-plugin" || m.kind === "marketplace-plugin")
    .map((m) => m.mountPath);

  return {
    configDir,
    mcpConfig: session.mcp.config ? expand(session.mcp.config) : null,
    model: session.model,
    effort: session.effort,
    extendedThinking: session.extended_thinking,
    debugMaxThinkingTokens: session.debug.max_thinking_tokens,
    agentMaxTurns: session.agent_max_turns,
    agentEnv: agentEnvOverrides(session.agent_env),
    permissionMode: session.permission_mode,
    permissionParity: session.permission_parity,
    baseEnv,
    mounts: presentMounts,
    pluginDirs,
    egressAllow,
  };
}

/** Load + validate a session baseline from a YAML/JSON file. Normalizes `effort: extra` (the UI label
 *  for `xhigh`) to `xhigh` on the wire — done here rather than as a Zod `.transform` on the field itself
 *  because a transform can't be represented in the generated JSON schema (see the `effort` field comment). */
export function loadSession(parsed: unknown): SessionConfig {
  // A removed field surfaces only as `SessionConfig` (a `strictObject`) rejecting an unrecognized key —
  // an opaque generic error for a session YAML authored against an older schema. Give it a targeted,
  // actionable hint instead of letting the bare Zod error stand alone.
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && "max_thinking_tokens" in parsed) {
    throw new Error(
      "`max_thinking_tokens` removed — use `extended_thinking` (boolean; default true/ON) for the real Cowork " +
        "toggle, or the fenced `debug.max_thinking_tokens` escape hatch for a raw numeric override (not reachable " +
        "via Cowork's UI; a run authored with it does not represent a real Cowork config).",
    );
  }
  const session = SessionConfig.parse(parsed);
  if ((session.effort as string | undefined) === "extra") return { ...session, effort: "xhigh" };
  return session;
}

/**
 * The matrix runner's session-loading override seam. Pure: returns a new SessionConfig, never
 * mutates `session`. `model` is a plain scalar overwrite. `skillDirSubstitution: [from, to]` swaps ONE
 * `plugins.local_plugins` entry — chosen by exact match on `from` — for `to`, leaving every other entry
 * untouched.
 *
 * The mount name a plugin gets (`.local-plugins/.../<basename(src)>`, see the `local_plugins` mounting
 * loop above) is derived PURELY from the source directory's basename — there is no author-chosen name
 * override anywhere in this codebase. So substituting a directory with a DIFFERENT basename would silently
 * change the mount name the agent sees, invalidating any scenario assertion that references it (e.g. a
 * `skill_triggered` regex keyed on the old plugin id). Rather than build new plumbing to pin an arbitrary
 * mount name (real complexity that has no precedent in the codebase today), this enforces
 * same-basename substitution and fails loud otherwise — a `skill_dirs` matrix axis's candidate directories
 * must all share one basename (e.g. `variants/v1/my-pdf-skill/`, `variants/v2/my-pdf-skill/`).
 */
export function applySessionOverrides(
  session: SessionConfig,
  overrides: { model?: string; skillDirSubstitution?: [string, string] },
): SessionConfig {
  let next = session;
  if (overrides.model !== undefined) next = { ...next, model: overrides.model };
  if (overrides.skillDirSubstitution) {
    const [from, to] = overrides.skillDirSubstitution;
    const idx = next.plugins.local_plugins.indexOf(from);
    if (idx === -1)
      throw new Error(`skill_dirs substitution: the session's plugins.local_plugins does not contain "${from}" to substitute`);
    if (basename(to) !== basename(from))
      throw new Error(
        `skill_dirs substitution: "${to}" has a different directory basename than "${from}" — the mount name is derived from the ` +
          `basename and must stay stable for scenario assertions to remain valid across matrix cells; give the candidate the same basename`,
      );
    const local_plugins = [...next.plugins.local_plugins];
    local_plugins[idx] = to;
    next = { ...next, plugins: { ...next.plugins, local_plugins } };
  }
  return next;
}

/**
 * Resolve a session's relative host paths against `baseDir` (the session file's own
 * directory), so a scenario+session bundle is relocatable and `run` behaves the same
 * from any working directory. `~` and `~/x` pass through as literals (buildLaunchPlan
 * expands them at launch time, and a config_dir may be VM-relative), already-absolute
 * paths pass through untouched, and a `~<user>` path now THROWS instead of surviving as an
 * unexpanded literal (the finding this closes). Applied only when a session is loaded from a
 * FILE (the `run`/`record` path); CLI-arg paths (`skill --upload/--folder`) stay cwd-relative.
 */
export function resolveSessionPaths(session: SessionConfig, baseDir: string): SessionConfig {
  const r = (p: string) => {
    if (p === "~" || p.startsWith("~/")) return p; // literal ~ pass-through — expanded later by buildLaunchPlan
    if (p.startsWith("~")) throw new Error(`resolveSessionPaths: "${p}" is a ~<user> home path, which is not supported`);
    return isAbsolute(p) ? p : resolve(baseDir, p);
  };
  // `plugins.marketplaces` is mostly git URLs (left untouched); only a relative LOCAL path is resolved.
  const isUrl = (p: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(p) || p.startsWith("git@");
  // Derive each remote_plugin's mount id from its DECLARED (pre-resolution) source string, keyed by the
  // RESOLVED path buildLaunchPlan will iterate — so the id is relocatable (a relative YAML declaration →
  // same id on any checkout) rather than a hash of a machine-specific absolute path.
  const remotePluginIds: Record<string, string> = {};
  const remotePlugins = session.plugins.remote_plugins.map((declared) => {
    const resolved = r(declared);
    remotePluginIds[resolved] = synthRemotePluginId(declared);
    return resolved;
  });
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
      remote_plugins: remotePlugins,
    },
    _remotePluginIds: remotePluginIds,
  };
}
