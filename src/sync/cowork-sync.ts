import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

/**
 * cowork-sync — derive a VOLATILE parity baseline from the live Claude Desktop
 * install + app.asar. This is the maintenance contract: re-run per release,
 * review the diff, commit. Fields the extractor can't resolve are flagged so
 * parity rot becomes a visible diff, not silent drift.
 *
 * macOS-only today: `sync()` throws a clear error on other platforms. Windows/Linux
 * Desktop paths are TODO branches (needs those install layouts to verify).
 */
const SUPPORT = join(homedir(), "Library/Application Support/Claude");
const ASAR = "/Applications/Claude.app/Contents/Resources/app.asar";

export interface GateState {
  id: string;
  name: string;
  on: boolean;
  source: string; // "force" | "defaultValue" | "experiment" | ...
  value: unknown;
}

export interface SyncResult {
  appVersion: string;
  agentVersion: string;
  allowDomains: string[];
  networkMode: string | null;
  requireFullVmSandbox: unknown;
  asarFingerprint: string;
  gates: Record<string, GateState> | null; // decoded GrowthBook gate states (null = fcache absent/unreadable)
  spawnEnv: Record<string, string> | null; // derived spawn.env; null = a hard-fail flag blocked it (carry base env forward)
  unknownDeltas: string[];
  notes: string[]; // non-blocking informational hints (e.g. stale SPAWN_ENV_ALLOWLIST prune NOTEs) — surfaced by the CLI, never a delta
}

/**
 * Behavior-affecting + provenance GrowthBook gates the harness pins (feature id → human name).
 * The ids are the numeric feature keys in the fcache; the names mirror provenance.gates in the baselines.
 */
const PINNED_GATES: Record<string, string> = {
  "1143815894": "hostLoop", // loop decision (decideLoopFromBaseline)
  // Binary-verified 2026-07-04 (asar 1.18286.0, class L9t "[ScheduledTasks]"): the SCHEDULED-TASK
  // (cron) session limiter (<=1 concurrent session per scheduled task, <=3 concurrent scheduled-task
  // sessions globally), NOT an in-conversation Task-tool dispatch cap; the Desktop imposes no cap on
  // Task-tool fan-out at all. Formerly mislabeled `taskDispatchLimiter` — baselines captured before
  // the rename keep the old label in their provenance.gates as a historical release fact.
  "1648655587": "scheduledTaskSessionLimiter",
  "1978029737": "coworkRuntimeConfig", // web_fetch routing + workspace knobs
  "583857784": "bridgeSdkTransport", // SDK control-protocol transport
  "2340532315": "pluginSyncSparkplug", // startup syncPlugins()
  "2307090146": "cliPlugin", // CLI-plugin credential broker (dark)
  // Dormant drift-sentinels: the harness models these as OFF or inert-default for a
  // standard interactive cowork session; pinned so a production flip surfaces as a sync diff.
  "2614807392": "skeletonHome", // mnt/.host-home discovery index — absent from fcache (dark, default false)
  "123929380": "autoMemoryStandardSessions", // auto-memory dir for a plain (non-Spaces) cowork session (off)
  "1696890383": "memoryGuidelinesEnv", // CLAUDE_COWORK_MEMORY_GUIDELINES env for auto-memory (off)
  "2860753854": "memoryExtraGuidelines", // CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES PII block (on, but inert-default)
  // Spawn-env conditional gates: each controls a key in the Desktop→agent spawn env
  // (SPAWN_GATES). Pinned so a production flip surfaces BOTH as a provenance.gates diff AND as the
  // corresponding spawn.env value diff (deriveSpawnEnv resolves the pin from the same decoded state).
  "434204418": "mcpConnectionNonblockingOff", // gate on → MCP_CONNECTION_NONBLOCKING:"0" + MCP_CONNECT_TIMEOUT_MS:"10000"
  "66187241": "emitToolUseSummaries", // CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES "true" vs "" (off → "")
  "714014285": "fineGrainedToolStreaming", // CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING:"1" (force-ON live)
  "1936081873": "oauthScopesEnv", // CLAUDE_CODE_OAUTH_SCOPES (value host-derived; allowlisted)
  "4153934152": "skipPrecompactLoad", // CLAUDE_CODE_SKIP_PRECOMPACT_LOAD:"1"
  "1129419822": "enableToolSearchAuto", // ENABLE_TOOL_SEARCH:"auto" — dark (see DARK_GATES)
};

/**
 * Gate ids that are DARK for a standard account — absent from the fcache entirely, not merely
 * off. `decodeFcacheGates` normally skips ids missing from `features` (they're not gates it can
 * report a state for); for this allowlist it instead emits an explicit `source:"absent"` marker
 * so the pin round-trips through sync/baseline and an absent→present flip becomes a visible diff.
 * The re-key guard below excludes `source:"absent"` entries from its "did anything match" count,
 * so this marker can't mask a wholesale GrowthBook id re-key (see test/baseline.test.ts).
 */
const DARK_GATES = new Set([
  "2614807392",
  "1129419822", // enableToolSearchAuto — a spawn-env gate absent from a standard fcache (dark); pinned so an
  //                absent→present flip on the ENABLE_TOOL_SEARCH conditional surfaces as a visible diff.
]);

/**
 * Decode the Claude Desktop GrowthBook feature cache (`~/Library/Application Support/Claude/fcache`).
 * Binary-verified format (app.asar 1.12603.1): bytes 0..2 = "CLF" magic, byte 3 = version (0x01),
 * bytes 4..7 = a length/checksum field, bytes 8.. = a gzip stream that inflates to JSON
 * `{ timestamp, features: { <id>: { value, on, off, source, ruleId } } }`.
 * Returns the pinned gates' states, or null if the cache is absent/unreadable (caller flags it).
 */
export function decodeFcacheGates(path = join(SUPPORT, "fcache")): Record<string, GateState> | null {
  if (!existsSync(path)) return null;
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch {
    return null;
  }
  // Require the CLF magic + at least the 8-byte header before the gzip stream.
  if (buf.length < 9 || buf.subarray(0, 3).toString("latin1") !== "CLF") return null;
  let parsed: { features?: Record<string, { on?: boolean; source?: string; value?: unknown }> };
  try {
    parsed = JSON.parse(gunzipSync(buf.subarray(8)).toString("utf8"));
  } catch {
    return null;
  }
  const feats = parsed?.features ?? {};
  const out: Record<string, GateState> = {};
  for (const [id, name] of Object.entries(PINNED_GATES)) {
    const f = feats[id];
    if (!f) {
      // Dark gates are pinned even when absent (see DARK_GATES doc comment); everything else
      // absent from this fcache is skipped, same as always.
      if (DARK_GATES.has(id)) out[id] = { id, name, on: false, source: "absent", value: undefined };
      continue;
    }
    out[id] = { id, name, on: !!f.on, source: String(f.source ?? "defaultValue"), value: f.value };
  }
  return out;
}

export function sync(): SyncResult {
  // defensive platform guard. The paths above (SUPPORT/ASAR/Info.plist) are macOS-only; on
  // Windows/Linux they don't exist, so the extractor would return EMPTY version/allowlist/gate fields
  // and (without the write guards) could persist a garbage baseline. Fail LOUD instead of
  // silently returning a hollow result. Full Windows/Linux support needs those Desktop install layouts
  // (a separate, non-binary task — see webfetch/maintenance docs).
  if (process.platform !== "darwin") {
    throw new Error(
      `cowork-sync is currently macOS-only (detected platform "${process.platform}"). ` +
        `It reads the Claude Desktop install at ${ASAR} and ${SUPPORT}, whose Windows/Linux layouts are not yet implemented. ` +
        `Run sync on macOS, or commit a baseline produced there.`,
    );
  }

  const unknown: string[] = [];

  // 1. Agent version (the single most important pin).
  const agentVersion = readIf(join(SUPPORT, "claude-code-vm/.sdk-version"))?.trim() ?? flag(unknown, "agentVersion");

  // 2. App version.
  const appVersion = readDesktopAppVersion() ?? flag(unknown, "appVersion");

  // 3. Cowork settings from config.json. — distinguish a MISSING config (allowed: a fresh install
  // simply has no user overrides) from a CORRUPT/unreadable one (records an unknown delta so the emptied
  // allowlist is a visible "sync incomplete" signal, not silent drift).
  const config = readConfigJson(join(SUPPORT, "config.json"), unknown);
  const networkMode = (config["coworkNetworkMode"] as string) ?? null;
  const requireFullVmSandbox = config["lastSeenRequireCoworkFullVmSandbox"] ?? null;
  const userAllow = parseEgressAllowedHosts(config["coworkEgressAllowedHosts"], unknown);

  // 4. GrowthBook gate states, decoded from the live fcache (no longer a manual step). Decoded BEFORE the
  // asar step so the spawn-env generator can resolve gate-conditional pins against the ACTUAL gate state
  // — a production flip then shows up coherently as both a provenance.gates diff and the
  // corresponding spawn.env value diff.
  const gates = decodeFcacheGates();

  // 5. Egress allowlist + spawn contract from the asar (vmAllowedDomains + firewallAlso + spawn.env),
  // merged with user hosts.
  const { domains, fingerprint, spawnEnv, notes } = extractFromAsar(unknown, gates);
  const allowDomains = dedupe([...domains, ...userAllow]);

  if (!gates) {
    flag(unknown, "gates: fcache missing/unreadable — provenance.gates NOT re-synced");
  } else if (Object.values(gates).filter((g) => g.source !== "absent").length === 0) {
    // DARK_GATES markers (source:"absent") are always present and must not mask a real re-key —
    // only count gates that actually matched a live fcache feature.
    flag(
      unknown,
      "gates: fcache decoded but NONE of the pinned gate IDs matched — gate IDs may have been re-keyed; update PINNED_GATES in cowork-sync.ts",
    );
  }

  return {
    appVersion,
    agentVersion,
    allowDomains,
    networkMode,
    requireFullVmSandbox,
    asarFingerprint: fingerprint,
    gates,
    spawnEnv,
    unknownDeltas: unknown,
    notes,
  };
}

/** Extract domains + fingerprint + spawn.env from the asar main bundle without keeping it unpacked. */
function extractFromAsar(
  unknown: string[],
  gates: Record<string, GateState> | null,
): { domains: string[]; fingerprint: string; spawnEnv: Record<string, string> | null; notes: string[] } {
  if (!existsSync(ASAR)) {
    flag(unknown, `asar not found at ${ASAR} — install/open Claude Desktop once, or fix ASAR in cowork-sync.ts`);
    return { domains: [], fingerprint: "", spawnEnv: null, notes: [] };
  }
  const tmp = mkdtempSync(join(tmpdir(), "cowork-sync-"));
  try {
    execFileSync("npx", ["--yes", "@electron/asar", "extract", ASAR, tmp], { stdio: "ignore" });
    const bundle = readIf(join(tmp, ".vite/build/index.js")) ?? "";
    // Domains: anthropic.com / claude.ai / sentry.io / statsig hosts referenced in the bundle.
    const re = /[a-z0-9.-]+\.(?:anthropic\.com|claude\.ai)|sentry\.io|statsig[a-z.]*\.[a-z]+/g;
    const domains = dedupe([...bundle.matchAll(re)].map((m) => m[0]));
    if (domains.length === 0)
      flag(
        unknown,
        "egress.allowDomains: the domain regex in extractFromAsar() matched nothing — the asar layout moved, so the synced allowlist is EMPTY. Fix the regex (maintainer), or hand-edit network.allowDomains in the written baseline (bridge)",
      );
    // drift guard: mountLayout modes are hand-authored (not synced) — verify the binary-verified
    // mode FACTS still hold so a policy change is a loud flag, not silent baseline rot.
    for (const f of checkMountModeFacts(bundle)) flag(unknown, f);
    for (const f of checkWebFetchFacts(bundle)) flag(unknown, f);
    // Spawn contract: S-tier structural sentinels + the generated spawn.env. Non-NOTE flags
    // become unknown deltas (hard-fail); NOTEs (stale-allowlist prune hints) are collected into
    // `notes` and printed by the sync CLI as informational lines — never a delta, never write-blocking.
    for (const f of checkSpawnContractFacts(bundle)) flag(unknown, f);
    const spawn = deriveSpawnEnv(bundle, gates);
    const { deltas: spawnDeltas, notes } = partitionSpawnFlags(spawn.flags);
    for (const f of spawnDeltas) flag(unknown, f);
    // Fingerprint over the cowork-relevant slices for "unknown delta" detection.
    const slice = sliceCowork(bundle);
    const fingerprint = createHash("sha256").update(slice).digest("hex").slice(0, 16);
    return { domains, fingerprint, spawnEnv: spawn.env, notes };
  } catch (e) {
    flag(unknown, `asar extract failed (npx @electron/asar): ${(e as Error).message} — check network/npx, or unpack ${ASAR} manually`);
    return { domains: [], fingerprint: "", spawnEnv: null, notes: [] };
  } finally {
    // mkdtempSync extraction dir is otherwise leaked under $TMPDIR on every invocation.
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * drift guard. The baseline's `mountLayout.mounts[].mode` is HAND-AUTHORED — `sync` does not
 * extract mountLayout — so a Cowork mount-policy change would silently rot the baseline. This verifies
 * the binary-verified mode FACTS still hold in the asar; any miss is flagged loudly (re-derive by hand,
 * see the baselines' `$comment_modes`). Pure over the bundle string → token-free unit-testable.
 *
 * Facts (app.asar 1.12603.1): uploads is mounted read-only (`mode:"ro"`); outputs + projects default to
 * `"rw"` (delete DENIED) via the `IX` resolver, whose delete-approved branch is `…?"rwd":"rw"`.
 */
export function checkMountModeFacts(bundle: string): string[] {
  const flags: string[] = [];
  if (!/\?"rwd":"rw"/.test(bundle))
    flags.push(
      'mountLayout: the delete-deny resolver (IX `…?"rwd":"rw"`) is gone from the asar — outputs/projects default mode may have changed; re-derive mountLayout.mounts[].mode (see baselines $comment_modes)',
    );
  if (!/\("uploads"\)\][^}]{0,90}mode:\s*"ro"/.test(bundle))
    flags.push(
      'mountLayout: the uploads read-only ("ro") mount is gone from the asar — uploads mode may have changed; re-derive mountLayout.mounts[name=uploads].mode',
    );
  return flags;
}

/**
 * Drift guard for the web_fetch model the harness ports (two-path G1t/U1t, app.asar 1.12603.1). The
 * load-bearing facts are hand-derived (not extracted), so flag loudly if the asar's web_fetch primitives
 * vanish — a sign Cowork's web_fetch mechanism changed and the harness port needs re-verification.
 */
export function checkWebFetchFacts(bundle: string): string[] {
  const flags: string[] = [];
  const facts: [string, RegExp][] = [
    ["the per-domain approval (buildRequestWebFetchApproval)", /buildRequestWebFetchApproval/],
    ["the provenance URL set (getWebFetchAllowedUrls)", /getWebFetchAllowedUrls/],
    ["the coworkWebFetchViaApi / coworkWebFetchPrompt gates", /coworkWebFetchViaApi[\s\S]{0,200}coworkWebFetchPrompt/],
  ];
  for (const [what, re] of facts)
    if (!re.test(bundle))
      flags.push(
        `web_fetch: ${what} is gone from the asar — Cowork's web_fetch mechanism may have changed; re-verify the two-path port (see webfetch-high-fidelity-plan)`,
      );
  return flags;
}

// ==========================================================================================
// Spawn-contract verification + spawn.env generation.
//
// The Desktop→agent spawn env is constructed in the asar across THREE windows (W1 the inline spawn
// literal, W2 the OnA base-env helper, W3 the Zrn shared-env helper OnA spreads). Every ALL-CAPS key
// those windows construct must be classifiable as a PINNED value we generate, or an ALLOWLISTED key we
// deliberately don't pin (host-derived / session-conditional / settings- or 3p-conditional / deleted).
// An unclassifiable key, an unknown gate id, a missing REQUIRED key, a degenerate window, or an
// unresolvable const chain HARD-FAILS the sync (→ unknownDeltas) and forces deriveSpawnEnv to return
// env:null so the previous complete baseline env is carried forward (never a truncated partial).
//
// Values that hide behind minified symbols are RESOLVED (never asserted by name): gate conditionals
// against the decoded fcache state, `String(<id>)` timeouts against the const table. Everything asserted
// is a minifier-invariant literal (env key names, SDK property names, string constants).
// ==========================================================================================

/**
 * GrowthBook gate ids allowed to appear in W1's `At("…")` conditionals — the CLOSED set. A gate id in
 * the env windows but NOT here means a NEW gate-conditional env var was introduced: hard-fail so it gets
 * classified before the gate ever flips. Value = the env key it controls + disposition.
 */
export const SPAWN_GATES: Record<string, string> = {
  "434204418": "on → MCP_CONNECTION_NONBLOCKING:'0' + MCP_CONNECT_TIMEOUT_MS:'10000' (pinned gate)",
  "66187241": "CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES 'true' vs '' (pinned gate)",
  "1936081873": "CLAUDE_CODE_OAUTH_SCOPES (value host-derived → allowlisted; pinned gate)",
  "1129419822": "ENABLE_TOOL_SEARCH:'auto' (dark; pinned via DARK_GATES)",
  "714014285": "CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING:'1' (pinned gate; force-ON live)",
  "4153934152": "CLAUDE_CODE_SKIP_PRECOMPACT_LOAD:'1' (pinned gate)",
  "451382573": "DISABLE_BRIEF_MODE_STOP_HOOK:'1' — brief (non-chat) sessions only; NOT pinned (harness models chat)",
};

/**
 * Env keys the generator deliberately does NOT pin, each with WHY. Checked before value resolution, so a
 * key here is skipped regardless of its construct shape (this is what keeps the messy host-derived / 3p /
 * session ternaries out of the generated env). A stale entry (allowlisted but no longer constructed
 * anywhere) emits a non-blocking NOTE for pruning, surfaced as SyncResult.notes in the sync output.
 */
export const SPAWN_ENV_ALLOWLIST: Record<string, string> = {
  CLAUDE_CONFIG_DIR: "modeled as spawn.configDirInGuest; injected per-session by spawnEnv() (src/runtime/argv.ts)",
  TZ: "host-derived (Intl timezone)",
  CLAUDE_CODE_HOST_PLATFORM: "host-derived; runtime-injected (src/runtime/argv.ts)",
  CLAUDE_CODE_OAUTH_TOKEN: "host auth",
  ANTHROPIC_BASE_URL: "host-derived (apiHost)",
  ANTHROPIC_CUSTOM_HEADERS: "host-derived (jXe client headers; re-set non-empty so it survives FnA)",
  ANTHROPIC_API_KEY: "constructed '' then deleted by FnA — absent from the final env",
  ANTHROPIC_AUTH_TOKEN: "constructed '' then deleted by FnA — absent from the final env",
  CLAUDE_CODE_OAUTH_SCOPES: "gate 1936081873 force-ON but value = the account's live OAuth scope (host-derived)",
  CLAUDE_CODE_SUBSCRIPTION_TYPE: "host account state",
  CLAUDE_CODE_RATE_LIMIT_TIER: "host account state",
  CLAUDE_CODE_ACCOUNT_UUID: "account-identity block; conditional on live login state",
  CLAUDE_CODE_USER_EMAIL: "account-identity block; conditional on live login state",
  CLAUDE_CODE_ORGANIZATION_UUID: "account-identity block; conditional on live login state",
  CLAUDE_CODE_ACCOUNT_TAGGED_ID: "account-identity block; conditional on live login state",
  CLAUDE_CODE_WORKSPACE_HOST_PATHS: "connected-folder list; runtime-derived per session",
  CLAUDE_PROJECT_UUID: "project-session-conditional (absent for the modeled standard chat session)",
  CLAUDE_PROJECT_TOOL: "project-session-conditional (absent for the modeled standard chat session)",
  MCP_CONNECT_TIMEOUT_MS: "gate 434204418-conditional (off; arrives with MCP_CONNECTION_NONBLOCKING:'0')",
  ENABLE_TOOL_SEARCH: "gate 1129419822-conditional (dark)",
  CLAUDE_CODE_SKIP_PRECOMPACT_LOAD: "gate 4153934152-conditional (off)",
  CLAUDE_CODE_BRIEF_UPLOAD: "non-chat (agent) sessionType branch; harness models chat sessions",
  CLAUDE_CODE_BRIEF: "non-chat (agent) sessionType branch; harness models chat sessions",
  DISABLE_BRIEF_MODE_STOP_HOOK: "non-chat sessionType + gate 451382573; harness models chat sessions",
  CLAUDE_CODE_SUBAGENT_MODEL: "user-settings-conditional (default absent)",
  CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "user-settings-conditional (default absent)",
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: "user-settings-conditional (default absent)",
  CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "user-settings-conditional (default absent)",
  CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: "server-pushed per-account map (default absent)",
  CLAUDE_CODE_ATTRIBUTION_HEADER: "3p-provider-only branch; harness models 1p",
  CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "3p-provider-only branch; harness models 1p",
  DISABLE_GROWTHBOOK: "3p-provider-only branch; harness models 1p",
  DISABLE_TELEMETRY: "3p-provider-only branch; harness models 1p",
  DISABLE_FEEDBACK_COMMAND: "3p-provider-only branch; harness models 1p",
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "3p-provider-only branch; harness models 1p",
  DISABLE_ERROR_REPORTING: "3p-provider-only branch; harness models 1p",
  CLAUDE_CODE_ENABLE_AUTO_MODE: "3p-provider-only branch; harness models 1p",
  CLAUDE_CODE_HOST_AUTH_ENV_VAR: "3p-provider-only branch; harness models 1p",
};

/**
 * The keys deriveSpawnEnv generates. A constructed key that is neither here nor in SPAWN_ENV_ALLOWLIST is
 * an ADDITION to the spawn contract → hard-fail (classify it: add here to pin, or allowlist with a
 * reason). This explicit set is what makes an injected literal a LOUD signal rather than a silent auto-pin
 * (the drift class this whole check exists to kill). Value resolution is structural (from the asar
 * window), so a value CHANGE on any pinned key still shows as a --diff line.
 */
export const SPAWN_PIN_KEYS: readonly string[] = [
  "CLAUDE_CODE_IS_COWORK",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_TAGS",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL",
  "CLAUDE_CODE_DISABLE_CRON",
  "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS",
  "CLAUDE_CODE_DISABLE_AGENTS_FLEET",
  "CLAUDE_CODE_ENABLE_APPEND_SUBAGENT_PROMPT",
  "CLAUDE_CODE_ENABLE_TASKS",
  "CLAUDE_CODE_DISABLE_TERMINAL_TITLE",
  "ENABLE_PROMPT_CACHING_1H",
  "DISABLE_MICROCOMPACT",
  "MCP_CONNECTION_NONBLOCKING",
  "API_TIMEOUT_MS",
  "CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES",
  "CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING",
  "DISABLE_AUTOUPDATER",
  "MCP_TOOL_TIMEOUT",
  "USE_LOCAL_OAUTH",
  "USE_STAGING_OAUTH",
];

/**
 * Env keys whose DISAPPEARANCE from the constructed union (W1∪W2∪W3) is an identity-level break, not a
 * peripheral drop — hard-fail rather than a silent --diff removal. These are the keys the emulator's own
 * runtime semantics depend on.
 */
export const REQUIRED_SPAWN_KEYS: readonly string[] = [
  "CLAUDE_CODE_IS_COWORK",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL",
  "CLAUDE_CODE_ENABLE_APPEND_SUBAGENT_PROMPT",
  "CLAUDE_CODE_DISABLE_CRON",
];

const SPAWN_ADVICE =
  "classify the key (pin via SPAWN_PIN_KEYS or allowlist with a reason via SPAWN_ENV_ALLOWLIST) — do NOT bypass with --allow-empty, which would commit a baseline that no longer matches the live spawn contract";
// The --allow-empty footgun: --allow-empty force-writes past ALL tripwires, so every spawn flag
// ends with this explicit anti-instruction, not just the classify-the-key ones.
const SPAWN_NO_BYPASS = "do NOT bypass with --allow-empty (it would commit a baseline that no longer matches the live spawn contract)";

/** Key-position enumeration: an ALL-CAPS key (or the sole sub-3-char key `TZ`) preceded by `{` or `,`. */
const SPAWN_KEY_RE = /[{,](TZ|[A-Z][A-Z0-9_]{2,}):/g;

/**
 * Two-step identifier resolver. Finds `<id>`'s definition and returns its literal value, following
 * identifier→identifier aliases up to 3 hops. The declaration-preamble class admits `,;{(` AND
 * `const|let|var ` (`kGt`/`Sde` are `const `-preceded live, which the narrower `[,;{(]` form
 * would miss and hard-fail on). Returns null on: not found, >3 hops, or a non-literal terminal.
 */
export function resolveConst(bundle: string, id: string, hops = 0): string | null {
  if (hops > 3) return null;
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = bundle.match(new RegExp(`(?:[,;{(]|\\b(?:const|let|var)\\s+)${esc}=([^,;)]{1,40})`));
  if (!m) return null;
  const v = m[1].trim();
  if (/^[A-Za-z_$][\w$]*$/.test(v)) return resolveConst(bundle, v, hops + 1); // alias → follow
  return v;
}

/**
 * Resolve `String(<arg>)` env values to their concrete default string. `<arg>` is either a bare const
 * (`Sde` → `resolveConst`) or a settings-getter call (`Zv()` → the function's `??<id>` fallback default,
 * then `resolveConst`). Exponential literals (`6e4`,`9e5`) are Number-normalized to `"60000"`/`"900000"`.
 */
function resolveStringArg(bundle: string, arg: string, isCall: boolean): string | null {
  let constId = arg;
  if (isCall) {
    const esc = arg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const fm = bundle.match(new RegExp(`function ${esc}\\([^)]*\\)\\{[^{}]*\\?\\?(\\w+)`));
    if (!fm) return null;
    constId = fm[1];
  }
  const v = resolveConst(bundle, constId);
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return String(n);
}

/**
 * Resolve one `KEY:<expr>` value expression to a concrete string, or report it unresolvable. Recognized
 * shapes: string literal; template-with-default (`` `pfx${field??"def"}` `` → `pfx`+`def`); gate-ternary
 * (`At("id")?"a":"b"`); `String(<const|call>)`; and the modeled-session ternaries the standard 1p prod
 * chat localAgent session pins deterministically (disableCron→"1", oauth-env prod→"", 3p-entrypoint→1p).
 * Anything else → `{ unknown: true }` (never a silent partial substitution).
 */
function resolveSpawnValue(bundle: string, expr: string, gates: Record<string, GateState>): { value: string } | { unknown: true } {
  const e = expr.trim();
  let m: RegExpMatchArray | null;
  if ((m = e.match(/^"([^"]*)"$/)) || (m = e.match(/^'([^']*)'$/))) return { value: m[1] };
  if ((m = e.match(/^`([^`$]*)\$\{[^}]*\?\?"([^"]*)"\}`$/))) return { value: m[1] + m[2] };
  if ((m = e.match(/^At\("(\d+)"\)\?"([^"]*)":"([^"]*)"$/))) {
    const id = m[1];
    if (!(id in SPAWN_GATES)) return { unknown: true };
    return { value: gates[id]?.on ? m[2] : m[3] };
  }
  if ((m = e.match(/^String\((\w+)(\(\))?\)$/))) {
    const v = resolveStringArg(bundle, m[1], !!m[2]);
    return v == null ? { unknown: true } : { value: v };
  }
  // Modeled-session ternaries (matched on stable property/literal tokens, minified object id = \w+).
  if (/^\w+\.disableCron\?"1":""$/.test(e)) return { value: "1" };
  if (/^\w+\.type!=="3p"&&\w+==="staging"\?"1":""$/.test(e)) return { value: "" };
  if (/^\w+\.type!=="3p"&&\w+==="local"\?"1":""$/.test(e)) return { value: "" };
  if ((m = e.match(/^\w+\.type==="3p"\?"[^"]*":"([^"]*)"$/))) return { value: m[1] };
  return { unknown: true };
}

/** Slice the balanced value expression starting at `i` (char after `KEY:`), stopping at a top-level `,`/`}`. */
function sliceSpawnValue(text: string, i: number): string {
  const start = i;
  let depth = 0;
  let q: string | null = null;
  for (; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === "\\") i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      q = c;
      continue;
    }
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") {
      if (depth === 0) break;
      depth--;
    } else if (c === "," && depth === 0) break;
  }
  return text.slice(start, i);
}

/** Two-anchor window: `[startAnchor … before first endAnchor after it]` (endAnchor NOT included). */
function twoAnchorWindow(bundle: string, startAnchor: string, endAnchor: string): string | null {
  const s = bundle.indexOf(startAnchor);
  if (s < 0) return null;
  const e = bundle.indexOf(endAnchor, s);
  if (e < 0) return null;
  return bundle.slice(s, e);
}

/**
 * W3 (the Zrn helper body): open at the `return{` before the DISABLE_AUTOUPDATER anchor, close on the
 * balanced `}` via a string-aware brace scanner (skips "…"/'…'/`…` spans). A nested template `${…}` inside
 * the object → return null (flagged, never guessed — none today).
 */
function braceScanWindow(bundle: string, anchor: string): string | null {
  const a = bundle.indexOf(anchor);
  if (a < 0) return null;
  const rs = bundle.lastIndexOf("return{", a);
  if (rs < 0) return null;
  let i = rs + "return".length; // at "{"
  let depth = 0;
  let q: string | null = null;
  for (; i < bundle.length; i++) {
    const c = bundle[i];
    if (q) {
      if (c === "\\") i++;
      else if (c === q) q = null;
      else if (q === "`" && c === "$" && bundle[i + 1] === "{") return null; // nested template — flag, don't guess
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      q = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return bundle.slice(rs, i + 1);
    }
  }
  return null;
}

/** Parse `K:"v"`-style inner pairs of a `{…}` object body (used for gate-conditional spread inners). */
function enumSpawnKeys(text: string): { key: string; valueStart: number }[] {
  const out: { key: string; valueStart: number }[] = [];
  SPAWN_KEY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SPAWN_KEY_RE.exec(text))) out.push({ key: m[1], valueStart: m.index + m[0].length });
  return out;
}

/**
 * Derive the Desktop→agent spawn env (the generated tier). Pure over the bundle string +
 * decoded gate states. Returns the merged env map, or `env:null` whenever ANY hard-fail flag is pushed
 * (unknown key, unknown spawn gate, missing REQUIRED key, degenerate/unfound window, unresolvable value)
 * — the all-or-nothing contract that keeps a truncated partial from ever reaching the baseline.
 */
export function deriveSpawnEnv(
  bundle: string,
  gates: Record<string, GateState> | null,
): { env: Record<string, string> | null; flags: string[] } {
  const flags: string[] = [];
  // If the fcache is unreadable the caller already flags it; emit no spurious spawn flags, no partial env.
  if (!gates) return { env: null, flags: [] };

  const w1 = twoAnchorWindow(bundle, "env:{CLAUDE_CONFIG_DIR", ",systemPrompt:");
  const w2 = twoAnchorWindow(bundle, "return{CLAUDE_CODE_ENTRYPOINT", ".sessionEnvVars()}");
  const w3 = braceScanWindow(bundle, 'DISABLE_AUTOUPDATER:"1"');
  const named: [string, string | null][] = [
    ["W1 (spawn env literal)", w1],
    ["W2 (OnA base-env helper)", w2],
    ["W3 (Zrn shared-env helper)", w3],
  ];
  let degenerate = false;
  for (const [name, w] of named) {
    if (w == null) {
      flags.push(
        `spawn.env: ${name} window not found (start/end anchor missing or W3 brace/nested-template scan failed) — the env construction moved; re-derive its anchors; ${SPAWN_NO_BYPASS}`,
      );
      degenerate = true;
    } else if (w.length < 200 || w.length > 20000) {
      flags.push(
        `spawn.env: ${name} window length ${w.length} is outside the 200–20000 sanity band — likely a mis-anchored slice; re-derive; ${SPAWN_NO_BYPASS}`,
      );
      degenerate = true;
    }
  }
  if (degenerate) return { env: null, flags };

  const env: Record<string, string> = {};
  const enumerated = new Set<string>();
  let hardFail = false;

  // Gate enumeration (W1 only — the sole window using At(…)): every referenced gate id must be known.
  for (const gm of (w1 as string).matchAll(/At\("(\d+)"\)/g)) {
    if (!(gm[1] in SPAWN_GATES)) {
      flags.push(
        `spawn.env: unknown gate id ${gm[1]} in a W1 env conditional — a NEW gate-conditional env var was introduced; ${SPAWN_ADVICE}`,
      );
      hardFail = true;
    }
  }

  const flagUnresolvable = (rawKey: string, expr: string) => {
    flags.push(
      `spawn.env: pinned key ${rawKey} has an unrecognized value expression \`${expr.slice(0, 60)}\` — its construction changed; re-derive its resolution; ${SPAWN_NO_BYPASS}`,
    );
    hardFail = true;
  };
  // Top-level / non-gate-spread key: allowlist-first, then it MUST be a registered pin (an unregistered
  // key here is an ADDITION → hard-fail so it is classified, never silently auto-pinned).
  const resolveInto = (rawKey: string, expr: string, target: Record<string, string>) => {
    if (SPAWN_ENV_ALLOWLIST[rawKey] !== undefined) return; // deliberately not pinned
    if ((SPAWN_PIN_KEYS as readonly string[]).includes(rawKey)) {
      const r = resolveSpawnValue(bundle, expr, gates);
      if ("unknown" in r) flagUnresolvable(rawKey, expr);
      else target[rawKey] = r.value;
      return;
    }
    flags.push(`spawn.env: unknown key ${rawKey} constructed in the asar — ${SPAWN_ADVICE}`);
    hardFail = true;
  };
  // Inner key of an ON gate-conditional spread: the gate IS the classifier, so resolve first — a literal
  // value auto-pins (e.g. gate 434204418 on → MCP_CONNECT_TIMEOUT_MS:"10000"), a non-literal host value
  // (e.g. OAUTH_SCOPES:o.scope) stays allowlisted, anything else is unknown.
  const resolveGateInner = (rawKey: string, expr: string, target: Record<string, string>) => {
    const r = resolveSpawnValue(bundle, expr, gates);
    if (!("unknown" in r)) target[rawKey] = r.value;
    else if (SPAWN_ENV_ALLOWLIST[rawKey] !== undefined) return;
    else {
      flags.push(`spawn.env: unknown key ${rawKey} constructed in a gate-ON conditional — ${SPAWN_ADVICE}`);
      hardFail = true;
    }
  };

  // A window's non-gate-spread keys. Gate-conditional spreads (…At("id")&&{…}) are handled first (they
  // must be resolved against gate STATE, not read as plain literals — an off-gate NONBLOCKING:"0" must
  // not override W2's "true"), then blanked so the generic pass never sees them.
  const applyWindow = (text: string, target: Record<string, string>, isW1: boolean) => {
    let work = text;
    if (isW1) {
      for (const sm of text.matchAll(/\.\.\.At\("(\d+)"\)&&\{([^{}]*)\}/g)) {
        const id = sm[1];
        const inner = sm[2];
        for (const k of enumSpawnKeys("{" + inner)) enumerated.add(k.key);
        if (id in SPAWN_GATES && gates[id]?.on) {
          for (const k of enumSpawnKeys("{" + inner)) resolveGateInner(k.key, sliceSpawnValue("{" + inner, k.valueStart), target);
        }
        work = work.replace(sm[0], "");
      }
    }
    for (const k of enumSpawnKeys(work)) {
      enumerated.add(k.key);
      resolveInto(k.key, sliceSpawnValue(work, k.valueStart), target);
    }
  };

  // Construction order (later wins): W3 (Zrn, spread early by OnA) → W2 (OnA literals) → W1 (the inline
  // literals) so W1 overrides every key it sets — e.g. ENTRYPOINT W2 "claude-desktop" → W1 "local-agent".
  applyWindow(w3 as string, env, false);
  applyWindow(w2 as string, env, false);
  applyWindow(w1 as string, env, true);

  for (const req of REQUIRED_SPAWN_KEYS) {
    if (!enumerated.has(req)) {
      flags.push(
        `spawn.env: REQUIRED key ${req} is no longer constructed in W1∪W2∪W3 — the extraction seam broke or Cowork changed fundamentally; re-derive; ${SPAWN_NO_BYPASS}`,
      );
      hardFail = true;
    }
  }

  // Non-blocking: allowlist entries that no longer appear anywhere (prune candidates).
  for (const k of Object.keys(SPAWN_ENV_ALLOWLIST)) {
    if (!enumerated.has(k))
      flags.push(`NOTE: spawn.env allowlist entry ${k} is no longer constructed in the asar — prune it from SPAWN_ENV_ALLOWLIST`);
  }

  if (hardFail) return { env: null, flags };
  return { env, flags };
}

/**
 * Split deriveSpawnEnv flags into the two severities: "NOTE:"-prefixed prune hints become non-blocking
 * `notes` (prefix stripped; surfaced as SyncResult.notes in the sync output), everything else is a
 * hard-fail `delta` (→ unknownDeltas, blocking the baseline write).
 */
export function partitionSpawnFlags(flags: string[]): { deltas: string[]; notes: string[] } {
  const deltas: string[] = [];
  const notes: string[] = [];
  for (const f of flags) {
    if (f.startsWith("NOTE:")) notes.push(f.replace(/^NOTE:\s*/, ""));
    else deltas.push(f);
  }
  return { deltas, notes };
}

/**
 * S-tier sentinel: the structural/curated spawn facts the generator does NOT produce (scalar options,
 * tools/allowedTools heads + tail-guards, the FnA delete def+application, the negative invariant, the
 * two prompt-asset delivery shapes). Any anchor miss → a flag naming the field (re-derive the anchor).
 * Pure over the bundle string, mirroring checkMountModeFacts.
 */
export function checkSpawnContractFacts(bundle: string): string[] {
  const flags: string[] = [];
  const w1 = twoAnchorWindow(bundle, "env:{CLAUDE_CONFIG_DIR", ",systemPrompt:");
  const w2 = twoAnchorWindow(bundle, "return{CLAUDE_CODE_ENTRYPOINT", ".sessionEnvVars()}");
  const has = (re: RegExp, s = bundle) => re.test(s);
  const miss = (field: string, why: string) => flags.push(`spawn: ${field} anchor missing — ${why}; ${SPAWN_NO_BYPASS}`);

  if (!has(/settingSources:\["user"\]/)) miss("S2 settingSources", 'settingSources:["user"] is gone');
  if (!has(/permissionMode:.{0,24}\?"default"/)) miss("S3 permissionMode", "the default-permissionMode ternary is gone");
  {
    const m = bundle.match(/maxThinkingTokens:[^,}]{0,60}\?(\w+\$?):0\}/);
    if (!m) miss("S4 maxThinkingTokens", "the maxThinkingTokens capture is gone");
    else if (resolveConst(bundle, m[1]) !== "31999") miss("S4 maxThinkingTokens", `resolved to ${resolveConst(bundle, m[1])} not 31999`);
  }
  if (!has(/\.effort\b.{0,60}:"medium"/)) miss("S5 effortDefault", 'the .effort … :"medium" default is gone');
  if (!has(/\/sessions\/\$\{[^}]+\}\/mnt\/\.claude/)) miss("S1 configDirInGuest", "the mnt/.claude session-path template is gone");

  const s6 = bundle.match(
    /tools:\["Task","Bash","Glob","Grep","Read","Edit","Write","NotebookEdit","WebFetch",\.\.\.(\w+),"WebSearch","Skill","REPL","JavaScript","AskUserQuestion","ToolSearch"/,
  );
  if (!s6) miss("S6 tools head", "the tools[] head list moved");
  else {
    const id = s6[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!has(new RegExp(`\\b${id}=\\["TaskCreate","TaskUpdate","TaskGet","TaskList","TaskStop"\\]`)))
      miss("S7 Task-tools spread", "the TaskCreate…TaskStop spread that tools[] injects moved");
  }
  if (!has(/"ToolSearch",\.\.\.\w+\.sessionType===/)) miss("S8 tools tail-guard", "a tool appended after ToolSearch would evade S6");
  if (
    !has(
      /allowedTools:\["Task","Bash","Glob","Grep","Read","Edit","Write","NotebookEdit","WebFetch",\.\.\.\w+,"WebSearch","Skill","REPL","JavaScript","ToolSearch"/,
    )
  )
    miss("S9 allowedTools head", "the allowedTools[] head list moved (AskUserQuestion is tools-only)");
  if (!has(/allowedTools:\[[^\]]{0,400}"ToolSearch","mcp__/)) miss("S10 allowedTools tail-guard", "the built-in→mcp__ boundary moved");

  // S11/S12 scoped to W1; S13 scoped to W2 — the earn-the-pin assertions for local-agent / cron / provider.
  if (!w1 || !has(/CLAUDE_CODE_ENTRYPOINT:"local-agent"/, w1))
    miss("S11 ENTRYPOINT local-agent", "the W1 local-agent entrypoint literal is gone");
  if (!w1 || !has(/disableCron:!0/, w1) || !has(/localAgent:!0/, w1))
    miss("S12 OnA call args", "disableCron:!0 / localAgent:!0 no longer earn the DISABLE_CRON / PROVIDER_MANAGED_BY_HOST pins");
  if (!w2 || !has(/CLAUDE_CODE_DISABLE_CRON:\w+\.disableCron\?"1":""/, w2))
    miss("S13 DISABLE_CRON ternary", "the disableCron?'1':'' shape changed");
  if (!has(/for\(const \w+ of\s*\[?"ANTHROPIC_API_KEY","ANTHROPIC_AUTH_TOKEN","ANTHROPIC_CUSTOM_HEADERS"\]/))
    miss("S14a FnA definition", "the empty-ANTHROPIC_* delete helper is gone");
  if (!has(/ANTHROPIC_CUSTOM_HEADERS:\w+\(V\.env[\s\S]{0,40}\},\w+\(V\.env\)/))
    miss("S14b FnA application", "FnA(V.env) no longer runs on the spawn env — the '' blanks would leak into production");
  if (!has(/preset:"claude_code"/)) miss("S15 promptTemplate delivery", "the claude_code preset-append delivery site is gone");
  if (!has(/appendSubagentSystemPrompt:\w+\(\{/))
    miss("S16 subagentAppend generator", "the per-session subagent-append generator call shape is gone");
  if (has(/CLAUDE_CODE_USE_COWORK_PLUGINS\s*:/))
    flags.push(
      `spawn: NEGATIVE INVARIANT S17 broken — CLAUDE_CODE_USE_COWORK_PLUGINS is now SET; it would flip the agent to cowork_settings.json/cowork_plugins; ${SPAWN_NO_BYPASS}`,
    );
  if (!w1 || !has(/CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES:At\("66187241"\)\?"true":""/, w1))
    miss("S18 EMIT_TOOL_USE_SUMMARIES gate-ternary", "the gate-id↔key association changed");
  if (!w1 || !has(/CLAUDE_CODE_TAGS:`lam_session_type:\$\{/, w1))
    miss("S19 CLAUDE_CODE_TAGS template", "the lam_session_type template shape changed");
  return flags;
}

/**
 * Canonical env key order: keys present in the previous baseline keep their base order; genuinely new
 * keys are appended alphabetically after them. A pure Cowork source-reorder then yields a zero-line git
 * diff, an added key is one clean +line at a deterministic spot, and a value change is a single -/+ pair.
 */
export function canonicalizeEnv(
  next: Record<string, string> | undefined,
  base: Record<string, string> | undefined,
): Record<string, string> {
  const src = next ?? base ?? {};
  const baseOrder = Object.keys(base ?? {});
  const out: Record<string, string> = {};
  for (const k of baseOrder) if (k in src) out[k] = src[k];
  const added = Object.keys(src)
    .filter((k) => !(k in out))
    .sort();
  for (const k of added) out[k] = src[k];
  return out;
}

function sliceCowork(bundle: string): string {
  // Concatenate windows around cowork-defining tokens; if these vanish, fingerprint
  // shifts and the runbook tells you to re-derive the extractor.
  const tokens = [
    "vmAllowedDomains",
    "vm_network_mode",
    "buildArgs",
    "/sessions/",
    "mnt/uploads",
    "coworkEgressAllowedHosts",
    '?"rwd":"rw"',
  ];
  let acc = "";
  for (const t of tokens) {
    const i = bundle.indexOf(t);
    if (i >= 0) acc += bundle.slice(i, i + 200);
  }
  return acc;
}

function readDesktopAppVersion(): string | null {
  // Info.plist CFBundleShortVersionString.
  try {
    const plist = readFileSync("/Applications/Claude.app/Contents/Info.plist", "utf8");
    const m = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

const readIf = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : null);

/**
 * read a user config JSON, distinguishing the three states a try/catch-to-null would collapse:
 *  - MISSING  → return {} silently (a fresh install legitimately has no overrides);
 *  - VALID    → return the parsed object;
 *  - CORRUPT / unreadable → return {} BUT push an unknown delta so the (now-emptied) allowlist surfaces
 *               as an incomplete sync instead of silently dropping `coworkEgressAllowedHosts`.
 */
export function readConfigJson(p: string, unknown: string[]): Record<string, unknown> {
  if (!existsSync(p)) return {};
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch (e) {
    flag(unknown, `config.json: unreadable at ${p} (${(e as Error).message}) — coworkEgressAllowedHosts NOT synced`);
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch (e) {
    flag(unknown, `config.json: corrupt JSON at ${p} (${(e as Error).message}) — coworkEgressAllowedHosts NOT synced`);
    return {};
  }
}

/** Parse the `coworkEgressAllowedHosts` value from the user config.
 *  - array   → pass through as-is (normal user overrides)
 *  - absent (undefined) → empty; normal for a fresh install, NOT an unknown delta
 *  - any other type → empty + unknown delta (misconfiguration the user should see) */
export function parseEgressAllowedHosts(raw: unknown, unknownDeltas: string[]): string[] {
  if (Array.isArray(raw)) return raw as string[];
  if (raw === undefined) return [];
  flag(unknownDeltas, `coworkEgressAllowedHosts: expected an array but got ${typeof raw} — user allow-list ignored`);
  return [];
}

const dedupe = <T>(a: T[]) => [...new Set(a)];
const flag = (acc: string[], what: string) => {
  acc.push(what);
  return "";
};
