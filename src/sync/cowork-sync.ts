import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { BASELINES_DIR, cmpVersionStrings } from "../baseline.js";
import { MODELED_PLACEHOLDER_NAMES, INTENTIONALLY_UNMODELED_PLACEHOLDERS } from "../prompt.js";

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
  // per-model effort/regex-default config (the literal map + the fable|mythos regex-default class); null =
  // a hard-fail flag blocked it (carry the base baseline's spawn.effortByModel/effortRegexDefault forward).
  modelEffortConfig: ModelEffortConfig | null;
  // Cowork system-prompt content fingerprint (H1-H3 prompt-drift guard) — null when the consumption
  // site / constant definition couldn't be found in the asar (itself an unknownDeltas entry).
  promptFingerprint: PromptFingerprint | null;
  unknownDeltas: string[];
  notes: string[]; // non-blocking informational hints (e.g. stale SPAWN_ENV_ALLOWLIST prune NOTEs) — surfaced by the CLI, never a delta
}

/**
 * Behavior-affecting + provenance GrowthBook gates the harness pins (feature id → human name).
 * The ids are the numeric feature keys in the fcache; the names mirror provenance.gates in the baselines.
 */
export const PINNED_GATES: Record<string, string> = {
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
  // Sub-agent append server override: gates ONLY whether a server-delivered spSectionPrompts entry
  // replaces the hardcoded subagent_env_hl / subagent_env_vm fallback texts (resolveSection). OFF live
  // (source defaultValue) -> the hardcoded texts are the wire text the committed paraphrase assets
  // model. An ON flip is invisible to the text sentinel (the hardcoded template is unchanged), so
  // checkSubagentOverrideGate additionally emits a HARD-STOP unknown delta on ON — a pinned drift
  // alone is a non-blocking warning.
  "124685897": "subagentPromptServerOverride",
  // Spawn-env conditional gates: each controls a key in the Desktop→agent spawn env
  // (SPAWN_GATES). Pinned so a production flip surfaces BOTH as a provenance.gates diff AND as the
  // corresponding spawn.env value diff (deriveSpawnEnv resolves the pin from the same decoded state).
  "434204418": "mcpConnectionNonblockingOff", // gate on → MCP_CONNECTION_NONBLOCKING:"0" + MCP_CONNECT_TIMEOUT_MS:"10000"
  "66187241": "emitToolUseSummaries", // CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES "true" vs "" (off → "")
  "714014285": "fineGrainedToolStreaming", // CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING:"1" (force-ON live)
  "1936081873": "oauthScopesEnv", // CLAUDE_CODE_OAUTH_SCOPES (value host-derived; allowlisted)
  "4153934152": "skipPrecompactLoad", // CLAUDE_CODE_SKIP_PRECOMPACT_LOAD:"1"
  "1129419822": "enableToolSearchAuto", // ENABLE_TOOL_SEARCH:"auto" — dark (see DARK_GATES)
  // Dormant drift-sentinels (Desktop 1.22209.0): tool-approval auto-mode gates. Neither is behaviorally
  // modeled — this harness has no persistent per-tool "always allow" concept to model against (no
  // updatedPermissions analog anywhere in src/decide/ or src/session.ts). Pinned so a live flip from
  // off to on surfaces as a provenance.gates diff, which is the trigger to revisit modeling this.
  "4200321681": "autoModeOverridesAlwaysAllow", // auto mode: force re-prompt (not silent-allow) for destructiveHint MCP tools
  "1447478638": "scheduledTaskToolsApprovableByAutoMode", // auto mode: scheduled-task tools auto-approvable (unless MDM workspace.autoModeEnabled=false)
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
  "4200321681", // autoModeOverridesAlwaysAllow — absent from a standard 1.22209.0 fcache at pin time (dark);
  //                pinned so a rollout (absent→present) surfaces as a visible diff.
  "1447478638", // scheduledTaskToolsApprovableByAutoMode — same rationale.
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

/** Gate 124685897 ON = a server-delivered subagent-append override is active; the harness has no
 *  captured override text, so proceeding would emit the committed fallback assets as if verified.
 *  Hard-stop via unknownDeltas (a PINNED_GATES drift alone only WARNS and still writes the baseline). */
export function checkSubagentOverrideGate(gates: Record<string, GateState> | null): string[] {
  if (!gates?.["124685897"]?.on) return [];
  return [
    "gate subagentPromptServerOverride:124685897 reads ON — a server-delivered spSectionPrompts override " +
      "is active for the sub-agent append; the harness has no captured override text, so the committed " +
      "fallback assets would ship as if verified. Capture the override text, update the subagent-append " +
      "assets + fingerprints, then re-sync.",
  ];
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
  const { domains, fingerprint, spawnEnv, modelEffortConfig, promptFingerprint, notes } = extractFromAsar(unknown, gates);
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

  for (const f of checkSubagentOverrideGate(gates)) flag(unknown, f);

  return {
    appVersion,
    agentVersion,
    allowDomains,
    networkMode,
    requireFullVmSandbox,
    asarFingerprint: fingerprint,
    gates,
    spawnEnv,
    modelEffortConfig,
    promptFingerprint,
    unknownDeltas: unknown,
    notes,
  };
}

// Some Vite/electron-builder releases emit `.vite/build/index.js` as a small entry stub that
// `require()`s the real code from a content-hashed sibling chunk (e.g. `index.chunk-XXXX.js`)
// instead of one monolithic file. Follow local relative requires transitively (BFS, deduped) so
// every fact-checker below sees the real bundle content regardless of which layout Desktop ships —
// a stub-only read would silently report every anchor as missing, not that the contract changed.
export function readMainBundleFiles(dir: string): Map<string, string> {
  const entryPath = join(dir, ".vite/build/index.js");
  const visited = new Set<string>();
  const queue = [entryPath];
  const out = new Map<string, string>();
  const localRequireRe = /require\(["']\.\/([^"']+)["']\)/g;
  while (queue.length > 0) {
    const p = queue.shift() as string;
    if (visited.has(p) || !existsSync(p)) continue;
    visited.add(p);
    const content = readFileSync(p, "utf8");
    out.set(p.slice(p.lastIndexOf("/") + 1), content);
    for (const m of content.matchAll(localRequireRe)) {
      queue.push(join(dirname(p), m[1]));
    }
  }
  return out;
}
export function readMainBundle(dir: string): string {
  return [...readMainBundleFiles(dir).values()].join("");
}

/** Extract domains + fingerprint + spawn.env + model-effort-config from the asar main bundle without
 *  keeping it unpacked. */
function extractFromAsar(
  unknown: string[],
  gates: Record<string, GateState> | null,
): {
  domains: string[];
  fingerprint: string;
  spawnEnv: Record<string, string> | null;
  modelEffortConfig: ModelEffortConfig | null;
  promptFingerprint: PromptFingerprint | null;
  notes: string[];
} {
  if (!existsSync(ASAR)) {
    flag(unknown, `asar not found at ${ASAR} — install/open Claude Desktop once, or fix ASAR in cowork-sync.ts`);
    return { domains: [], fingerprint: "", spawnEnv: null, modelEffortConfig: null, promptFingerprint: null, notes: [] };
  }
  const tmp = mkdtempSync(join(tmpdir(), "cowork-sync-"));
  try {
    execFileSync("npx", ["--yes", "@electron/asar", "extract", ASAR, tmp], { stdio: "ignore" });
    const bundleFiles = readMainBundleFiles(tmp);
    const bundle = [...bundleFiles.values()].join("");
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
    for (const f of checkPathHookFacts(bundleFiles)) flag(unknown, f);
    // Spawn contract: S-tier structural sentinels + the generated spawn.env. Non-NOTE flags
    // become unknown deltas (hard-fail); NOTEs (stale-allowlist prune hints) are collected into
    // `notes` and printed by the sync CLI as informational lines — never a delta, never write-blocking.
    for (const f of checkSpawnContractFacts(bundle)) flag(unknown, f);
    const subagentFps = readSubagentFingerprints();
    for (const f of checkSubagentPromptFacts(bundleFiles, subagentFps)) flag(unknown, f);
    const spawn = deriveSpawnEnv(bundle, gates);
    const { deltas: spawnDeltas, notes } = partitionSpawnFlags(spawn.flags);
    for (const f of spawnDeltas) flag(unknown, f);
    // Per-model effort/regex-default config: same all-or-nothing contract as spawn.env — any anchor
    // miss hard-fails (config:null) rather than reaching the baseline as a silent partial map.
    const { config: modelEffortConfig, flags: modelEffortFlags } = extractModelEffortConfig(bundle);
    for (const f of modelEffortFlags) flag(unknown, f);
    // Fingerprint over the cowork-relevant slices for "unknown delta" detection.
    const slice = sliceCowork(bundle);
    const fingerprint = createHash("sha256").update(slice).digest("hex").slice(0, 16);
    // H1-H3 prompt-drift guard: extract the raw system-prompt content fingerprint and diff it against
    // the committed baselines/prompts/cowork-system-prompt-fingerprints.json (sha drift = hard-fail,
    // placeholder/section inventory diff = informational, unmodeled placeholder = hard-fail).
    const promptFingerprint = extractPromptFingerprint(bundle);
    const fingerprintsFile = readPromptFingerprintsFile();
    const promptDrift = checkPromptDrift(
      promptFingerprint,
      fingerprintsFile,
      MODELED_PLACEHOLDER_NAMES,
      INTENTIONALLY_UNMODELED_PLACEHOLDERS,
    );
    for (const d of promptDrift.unknownDeltas) flag(unknown, d);
    return { domains, fingerprint, spawnEnv: spawn.env, modelEffortConfig, promptFingerprint, notes: [...notes, ...promptDrift.notes] };
  } catch (e) {
    flag(unknown, `asar extract failed (npx @electron/asar): ${(e as Error).message} — check network/npx, or unpack ${ASAR} manually`);
    return { domains: [], fingerprint: "", spawnEnv: null, modelEffortConfig: null, promptFingerprint: null, notes: [] };
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

/** Path-gate sentinel (1.20186.1 shapes). Module-bounded: anchors run against the CORRECT chunk only
 *  — the DEFINING chunk (found by the HOST_LOOP_PATH_GATED_BUILTIN_TOOLS export) for set contents, the
 *  CONSUMING chunk (found by the matcher install site) for the hook body, deny texts, topology,
 *  ordering, and the canUseTool chain. Each tool-set array is bound to its EXPORT NAME (not "some
 *  matching array exists"), and the install site must reference the same export property. */
export function checkPathHookFacts(files: Map<string, string>): string[] {
  const flags: string[] = [];
  const miss = (what: string, why: string) => flags.push(`path-hook: ${what} anchor missing — ${why}`);
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // --- defining chunk: the one that EXPORTS the name (alias or property form), not merely mentions
  //     it as a namespace-property consumer (the hostloop chunk references `.HOST_LOOP_…` too) ---
  const definesExport = /[\w$]+\s+as\s+HOST_LOOP_PATH_GATED_BUILTIN_TOOLS\b|\bHOST_LOOP_PATH_GATED_BUILTIN_TOOLS[:=][\w$]/;
  const defining = [...files.values()].find((c) => definesExport.test(c));
  if (!defining) miss("defining chunk", "no chunk exports HOST_LOOP_PATH_GATED_BUILTIN_TOOLS");
  else {
    const hop = (exportName: string, arrayRe: RegExp, label: string) => {
      // Resolve the LOCAL bound to this export: ESM `<local> as ExportName`, OR the object-property /
      // alias forms `ExportName:<local>` / `ExportName=<local>`. Then require `<local>=<exact array>`.
      // Binding to the export (not a free array search) is what makes a decoy array fail.
      const alias =
        defining.match(new RegExp(`([\\w$]+)\\s+as\\s+${exportName}\\b`)) ?? defining.match(new RegExp(`\\b${exportName}[:=]([\\w$]+)`));
      const local = alias?.[1];
      if (!local) {
        miss(label, `could not resolve the local bound to the ${exportName} export`);
        return;
      }
      if (!new RegExp(`(?<![\\w$])${esc(local)}=${arrayRe.source}`).test(defining))
        miss(label, `the ${exportName} export's local (${local}) is not bound to its exact array literal`);
    };
    hop("HOST_LOOP_PATH_GATED_BUILTIN_TOOLS", /\["Read","Write","Edit","Glob","Grep"\]/, "gated 5-set");
    hop("HOST_LOOP_EXCLUDED_BUILTIN_TOOLS", /\["Bash","NotebookEdit","REPL","JavaScript","WebFetch"\]/, "excluded set");
    if (!/REQUEST_COWORK_DIRECTORY/.test(defining) || !/"request_cowork_directory"/.test(defining))
      miss("REQUEST_COWORK_DIRECTORY", "the export or its literal is gone");
    if (!/SESSION_TYPE_CHAT/.test(defining) || !/"chat"/.test(defining)) miss("SESSION_TYPE_CHAT", "the export or its literal is gone");
  }

  // --- consuming chunk: located by the install site (namespace-property connectivity) ---
  const consuming = [...files.values()].find((c) => /\.HOST_LOOP_PATH_GATED_BUILTIN_TOOLS,"MultiEdit"\]\.join\("\|"\)/.test(c));
  if (!consuming) {
    miss("install site", 'no chunk contains [...NS.HOST_LOOP_PATH_GATED_BUILTIN_TOOLS,"MultiEdit"].join("|")');
    return flags; // everything below is scoped to this chunk
  }
  const inHook = (re: RegExp, label: string, why: string) => {
    if (!re.test(consuming)) miss(label, why);
  };
  inHook(/=\["Write","Edit","MultiEdit"\]/, "mutating set", "the Write/Edit/MultiEdit literal moved");
  inHook(
    /is a VM path\. In this session the \$\{[^}]+\} tool runs on the host filesystem/,
    "VM-path deny",
    "the /sessions guard text changed",
  );
  // resolveFilePath's two hard-block strings live in the DEFINING/shared chunk, not the consumer.
  if (!defining || !/Refusing to resolve non-regular file/.test(defining))
    miss("resolver hard-block", "the non-regular-file branch is gone from the shared resolver");
  if (!defining || !/Failed to resolve path/.test(defining))
    miss("resolver failure text", "the resolve-failure branch is gone from the shared resolver");
  inHook(/could not be safely resolved/, "resolver caller block", "the active non-ENOENT block branch is gone from the hook"); // caller-side text — stays in the consumer
  inHook(/is outside this session's scratch directory, so \$\{/, "scratch deny", "the scratch directory deny-variant text changed");
  inHook(/is outside this session's connected folders, so \$\{/, "connected deny", "the connected folders deny-variant text changed");
  inHook(/hardlink to the user's original file/, "uploads-task deny", "the hardlink category text changed");
  inHook(/\(spooled tool results\)/, "spool deny", "the spooled-projects category text changed");
  inHook(/\(plugin, skill, or knowledge content\)/, "plugin deny", "the plugin category text changed");
  inHook(/"Path is outside allowed working directories"/, "SDK deny const", "the workingDir constant changed");
  inHook(/\["file_path","path"\]/, "path key pair", "the file_path/path key array is gone");
  // First-string extraction over the path keys: `<keys>.map(k=>o[k]).find(v=>typeof v=="string")`.
  // The keys are bound to a local (real: `pe=["file_path","path"]`, used as `pe.map(…)`) rather than
  // inlined, so anchor the map/find/typeof-string SHAPE (both proven by the separate path-key anchor).
  inHook(
    /\.map\([\w$]+=>[\w$]+\[[\w$]+\]\)\.find\([\w$]+=>typeof [\w$]+=="string"\)/,
    "first-match extraction",
    "the .map().find() extraction shape is gone",
  );
  inHook(/spooledProjectsReadOnlyRoots/, "spool roots identifier", "spooledProjectsReadOnlyRoots is gone");
  inHook(/getMidSessionReadOnlyPaths/, "mid-session roots", "getMidSessionReadOnlyPaths is no longer wired");
  inHook(
    /\?\[\]:\([\w$]+==null\?void 0:[\w$]+\(\)\)\?\?\[\]/,
    "readOnly-tail rule",
    "the ...ie||ct?[]:(ne?.())??[] per-call assembly shape is gone",
  );
  inHook(/===[\w$]+\.SESSION_TYPE_CHAT/, "chat-type connectivity", "the sessionType===SESSION_TYPE_CHAT comparison is gone");
  inHook(/=[\w$]+\?\[\.\.\.[\w$]+,\.\.\.[\w$]+\]:\[/, "root topology ternary", "the chat/task st root-assembly ternary is gone");
  inHook(
    /const [\w$]+=[\w$]+\.canUseTool;[\w$]+&&\([\w$]+\.canUseTool=async\(/,
    "conditional canUseTool install",
    "the Se&&(e.canUseTool=…) conditional install is gone",
  );
  inHook(
    /canUseTool=async\([^)]*\)=>[\w$]+\([^)]*\)\?\?[\w$]+\([^)]*\)\?\?[\w$]+\(/,
    "canUseTool ?? chain",
    "the xe ?? Qt ?? original ordering is gone",
  );

  // qt-before-containment ORDER + removed-exemption ABSENCE: inside the hook body slice, the category
  // guard's function must be referenced BEFORE any containment-helper call, and NO containment call may
  // precede it (a blanket early-allow shape).
  const qtDef = consuming.match(/function ([\w$]+)\([\w$]+\)\{[\s\S]{0,2000}?hardlink to the user's original file/);
  const installAt = consuming.search(/\.HOST_LOOP_PATH_GATED_BUILTIN_TOOLS,"MultiEdit"\]\.join\("\|"\)/);
  if (!qtDef) miss("qt definition", "no function contains the hardlink category text");
  else if (installAt >= 0) {
    const hookSlice = consuming.slice(installAt, installAt + 6000);
    const qtCallAt = hookSlice.indexOf(`${qtDef[1]}(`);
    if (qtCallAt < 0) miss("qt call in hook", "the category guard is not invoked from the hook body");
    else {
      const containAt = hookSlice.search(/\.isPathContainedInFolders\(|isContained\(/);
      if (containAt >= 0 && containAt < qtCallAt)
        miss("qt-before-containment order", "a containment call precedes the category guard — an early-allow/blanket-exemption shape");
    }
  }
  return flags;
}

// ==========================================================================================
// Prompt-drift guard (H1-H3): the Cowork system-prompt raw content is a hand-maintained
// side-artifact (baselines/prompts/cowork-system-prompt-fingerprints.json) that `sync` previously
// never touched — this section folds a fingerprint-vs-committed-baseline check into `sync` itself
// so a prompt-content change (or a newly-added, unmodeled {{placeholder}}) surfaces as a loud
// unknown delta rather than requiring a human to notice by hand. The committed fingerprints live in
// baselines/prompts/cowork-system-prompt-fingerprints.json; the drift signal complements the coarse
// asarFingerprint (which flips on any minifier rename) with the minifier-independent content hash.
// ==========================================================================================

export interface PromptFingerprint {
  constantId: string;
  codePoints: number;
  sectionTags: number;
  sha256: string;
  placeholders: string[]; // sorted unique {{name}} names
  sectionTagNames: string[]; // sorted unique <name> open-tag names
}

/**
 * Extract the raw Cowork system-prompt constant's content fingerprint from the asar main bundle.
 * Mirrors the method documented in baselines/prompts/cowork-system-prompt-fingerprints.json
 * (`extractionMethod`): find the single `cowork_system_prompt:{value:{prompt:<id>}` consumption
 * site, capture `<id>` (minifier-assigned, varies per build), then find `<id>=` followed by a
 * backtick and read the backtick-template body char-by-char — preserving `\`-escapes intact (a
 * `\` consumes the next char too, so an escaped backtick inside the template never ends the scan
 * early) — stopping at the first UNescaped backtick. Returns null if either anchor is missing (the
 * prompt-asset layout moved — the caller turns that into a hard-fail unknown delta, never a silent
 * skip).
 */
export function extractPromptFingerprint(bundle: string): PromptFingerprint | null {
  const consumptionM = bundle.match(/cowork_system_prompt:\{value:\{prompt:([A-Za-z_$][\w$]*)/);
  if (!consumptionM) return null;
  const id = consumptionM[1];
  const idEsc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const defM = bundle.match(new RegExp(`(?:[,;{(]|\\b(?:const|let|var)\\s+)${idEsc}=\``));
  if (!defM || defM.index == null) return null;
  const bodyStart = defM.index + defM[0].length; // index of the char right after the opening backtick
  let body = "";
  let i = bodyStart;
  let closed = false;
  for (; i < bundle.length; i++) {
    const c = bundle[i];
    if (c === "\\") {
      // Preserve the escape AND the escaped char intact (raw template source, not a decoded string).
      body += c + (bundle[i + 1] ?? "");
      i++; // skip the escaped char too (loop's i++ advances past the backslash)
      continue;
    }
    if (c === "`") {
      closed = true;
      break;
    }
    body += c;
  }
  if (!closed) return null;

  const sha256 = createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex");
  const codePoints = [...body].length;
  const sectionTags = [...body.matchAll(/<[a-z_]+>/g)].length;
  const placeholders = dedupe([...body.matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g)].map((m) => m[1])).sort();
  const sectionTagNames = dedupe([...body.matchAll(/<([a-z_]+)>/g)].map((m) => m[1])).sort();
  return { constantId: id, codePoints, sectionTags, sha256, placeholders, sectionTagNames };
}

interface PromptFingerprintsFile {
  versions: Record<string, { sha256?: string | null; placeholders?: string[]; sectionTagNames?: string[] }>;
}

/** Load baselines/prompts/cowork-system-prompt-fingerprints.json; null on any read/parse failure
 *  (missing file, corrupt JSON, or no `versions` map) — treated as "cannot check", not a hard-fail
 *  (see checkPromptDrift). */
function readPromptFingerprintsFile(): PromptFingerprintsFile | null {
  try {
    const raw = readFileSync(join(BASELINES_DIR, "prompts", "cowork-system-prompt-fingerprints.json"), "utf8");
    const parsed = JSON.parse(raw) as PromptFingerprintsFile;
    if (!parsed || typeof parsed !== "object" || !parsed.versions) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** subagentAppendVersions map from cowork-system-prompt-fingerprints.json; null = unreadable/absent
 *  (checkSubagentPromptFacts turns that into a hard-fail flag — never a silent skip). */
function readSubagentFingerprints(): { versions: Record<string, { hl: string; vm: string }> } | null {
  try {
    const raw = readFileSync(join(BASELINES_DIR, "prompts", "cowork-system-prompt-fingerprints.json"), "utf8");
    const parsed = JSON.parse(raw) as { subagentAppendVersions?: Record<string, { hl: string; vm: string }> };
    if (!parsed?.subagentAppendVersions) return null;
    return { versions: parsed.subagentAppendVersions };
  } catch {
    return null;
  }
}

/**
 * H1 (sha drift -> BLOCK) + H2 (placeholder/section inventory diff -> informational) + H3 (unmodeled
 * placeholder -> BLOCK). Pure over its inputs so it's token-free unit-testable without a real asar.
 * Drift key is content-hash-vs-newest-committed-entry, NOT appVersion — a byte-identical prompt on a
 * new Desktop version must pass silently (matches the plan's "1.19367.0 needs no new baseline").
 */
export function checkPromptDrift(
  fp: PromptFingerprint | null,
  fingerprintsFile: { versions: Record<string, { sha256?: string | null; placeholders?: string[]; sectionTagNames?: string[] }> } | null,
  modeled: ReadonlySet<string>,
  allowlisted: ReadonlySet<string>,
): { unknownDeltas: string[]; notes: string[] } {
  const unknownDeltas: string[] = [];
  const notes: string[] = [];
  if (!fp) {
    unknownDeltas.push(
      "prompt fingerprint: the cowork_system_prompt consumption site or its constant definition was not found — the prompt-asset layout moved; re-verify extractPromptFingerprint",
    );
    return { unknownDeltas, notes };
  }
  const versions = fingerprintsFile ? Object.keys(fingerprintsFile.versions) : [];
  if (!fingerprintsFile || versions.length === 0) {
    notes.push("prompt fingerprint: cowork-system-prompt-fingerprints.json missing/unreadable — cannot check prompt drift");
  } else {
    let newestVer = versions[0];
    for (const v of versions) if (cmpVersionStrings(v, newestVer) > 0) newestVer = v;
    const entry = fingerprintsFile.versions[newestVer];

    // H1 — sha drift vs the newest committed entry (BLOCK).
    if (entry.sha256 && fp.sha256 !== entry.sha256) {
      unknownDeltas.push(
        `prompt content drifted vs the newest committed fingerprint (${newestVer}): sha ${entry.sha256.slice(0, 12)}… -> ${fp.sha256.slice(0, 12)}… (codePoints -> ${fp.codePoints}, sectionTags -> ${fp.sectionTags}). Confirm the RENDERED-prompt impact (a placeholder may be deployment-gated/stripped like {{modelIdentity}}), then add a new version entry to baselines/prompts/cowork-system-prompt-fingerprints.json.`,
      );
    }

    // H2 — placeholder/section inventory diff (informational; appended to notes).
    if (entry.placeholders) {
      const before = new Set(entry.placeholders);
      const after = new Set(fp.placeholders);
      for (const p of after) if (!before.has(p)) notes.push(`prompt inventory: NEW placeholder {{${p}}}`);
      for (const p of before) if (!after.has(p)) notes.push(`prompt inventory: REMOVED placeholder {{${p}}}`);
    }
    if (entry.sectionTagNames) {
      const before = new Set(entry.sectionTagNames);
      const after = new Set(fp.sectionTagNames);
      for (const t of after) if (!before.has(t)) notes.push(`prompt inventory: NEW section <${t}>`);
      for (const t of before) if (!after.has(t)) notes.push(`prompt inventory: REMOVED section <${t}>`);
    }
  }

  // H3 — unmodeled placeholder guard (BLOCK): every {{placeholder}} in the extracted prompt must be
  // either substituted by the renderer or explicitly allowlisted as intentionally out-of-band.
  for (const p of fp.placeholders) {
    if (!modeled.has(p) && !allowlisted.has(p)) {
      unknownDeltas.push(
        `unmodeled placeholder {{${p}}}: not in the renderer substitution set (src/prompt.ts MODELED_PLACEHOLDER_NAMES) nor the intentional-inline allowlist (INTENTIONALLY_UNMODELED_PLACEHOLDERS) — model it or allowlist it, else the harness would render it literally.`,
      );
    }
  }

  return { unknownDeltas, notes };
}

// ==========================================================================================
// Sub-agent append sentinel (hl/vm branches). Complements S16 (which pins only that a
// generator CALL exists) with: the SP_SECTION_KEYS pair, the hostLoopMode branch ternary, the two
// branch templates sliced from the ONE module that defines the generator, a normalized two-branch
// content fingerprint (BOTH mandatory), the substitution-map keys AND VALUES (a host/VM cwd swap AND
// a same-side root/mount binding mismatch fail), the resolveSection gate shape, and the delivery-call
// argument list. All anchors MANDATORY. Scope note: this proves the PRODUCT still has the modeled
// shape; harness-side delivery (per-tier selection, chat lane, {{vmCwd}} rendering) is guarded by
// vitest regression tests, not by sync.
// ==========================================================================================

/** Return the decoded body of the backtick template that ENCLOSES `at`, scanning a single module
 *  string. Backward: the opening delimiter is the nearest UNESCAPED backtick before `at` (escaped
 *  backticks `\`` are literal code-span backticks inside the body, not delimiters). Forward: escaped
 *  backticks are DECODED to a bare backtick (so the returned slice reads like the rendered template
 *  and the value-proof regexes can match), every other escape is preserved verbatim (keeps the
 *  fingerprint stable), and the first UNESCAPED backtick terminates the body. Operates per-module
 *  (never the concatenated bundle) so an unrelated template can't be captured. */
function templateBodyAt(module: string, at: number): string | null {
  if (at < 0) return null;
  let open = -1;
  for (let i = at; i >= 0; i--) {
    if (module[i] === "`" && module[i - 1] !== "\\") {
      open = i;
      break;
    }
  }
  if (open < 0) return null;
  let out = "";
  for (let i = open + 1; i < module.length; i++) {
    const c = module[i];
    if (c === "\\") {
      const next = module[i + 1] ?? "";
      if (next === "`") {
        // Escaped backtick = a literal code-span backtick in the body, not the terminator. Decode it.
        out += "`";
        i++;
        continue;
      }
      // Any other escape (\n, \\, …) is preserved as-is so the normalized fingerprint stays stable.
      out += c + next;
      i++;
      continue;
    }
    if (c === "`") return out; // a truly UNescaped backtick is the template's real closing delimiter.
    out += c;
  }
  return null;
}

/** Extract the two raw branch template bodies from the SINGLE module that defines the generator.
 *  Module-scoped, not whole-bundle: the defining module is the one that references
 *  buildSubagentEnvironmentPrompt AND contains BOTH short discriminator fragments (hl: "on the user's
 *  machine"; vm: "exist only in the sandbox" — both verbatim production substrings). The vm
 *  discriminator is unique; the hl fragment also occurs in unrelated prose, so the hl branch is
 *  anchored to the occurrence immediately preceding the vm branch (the hostLoopMode ternary's true
 *  arm). Each body is sliced by backtick scanning from its discriminator — no function-body brace
 *  matching, which the old draft got wrong (it grabbed the destructured-param `{` of `zo({…})`). */
export function extractSubagentBranchSlices(files: Map<string, string>): { module: string; hl: string; vm: string } | null {
  const module = [...files.values()].find(
    (c) => c.includes("buildSubagentEnvironmentPrompt") && c.includes("on the user's machine") && c.includes("exist only in the sandbox"),
  );
  if (!module) return null;
  const vmAt = module.indexOf("exist only in the sandbox");
  const hlAt = module.lastIndexOf("on the user's machine", vmAt);
  if (vmAt < 0 || hlAt < 0) return null;
  const hl = templateBodyAt(module, hlAt);
  const vm = templateBodyAt(module, vmAt);
  if (!hl || !vm) return null;
  return { module, hl, vm };
}

/** sha16 of a branch text after minifier-identifier normalization: every ${...} interpolation is
 *  replaced by the canonical token `${}` so a minifier rename never moves the hash, while any
 *  body-text edit does. */
export function subagentBranchFingerprint(branchText: string): string {
  const normalized = branchText.replace(/\$\{[^{}]*\}/g, "${}");
  return createHash("sha256").update(Buffer.from(normalized, "utf8")).digest("hex").slice(0, 16);
}

export function checkSubagentPromptFacts(
  files: Map<string, string>,
  committed: { versions: Record<string, { hl: string; vm: string }> } | null,
): string[] {
  const flags: string[] = [];
  const bundle = [...files.values()].join(""); // literal anchors below span 3 modules (SP_SECTION_KEYS, generator, delivery) — check them against the join; branch-TEXT slicing is module-scoped
  const miss = (what: string, why: string) => flags.push(`subagent-append: ${what} anchor missing — ${why}`);

  // (1) key-pair literal (verbatim in all backed-up asars).
  if (!/subagentEnvHostLoop:"subagent_env_hl",subagentEnvVm:"subagent_env_vm"/.test(bundle))
    miss("SP_SECTION_KEYS pair", "the subagent_env_hl/subagent_env_vm key pair moved or was renamed");
  // (2) branch ternary — hl-first on the hostLoopMode boolean (receiver admits bare-local and NS. forms).
  if (!/\?[\w$.]*\.?subagentEnvHostLoop:[\w$.]*\.?subagentEnvVm/.test(bundle))
    miss("branch ternary", "the hostLoopMode ? subagentEnvHostLoop : subagentEnvVm selection is gone (or inverted)");
  // (3) module-scoped branch texts + MANDATORY two-branch fingerprints + VALUE proofs.
  const slices = extractSubagentBranchSlices(files);
  if (!slices) {
    miss("generator branch texts", "the module defining buildSubagentEnvironmentPrompt with both branch discriminators could not be found");
  } else {
    // Substitution-VALUE proofs — a host/VM cwd swap must fail. Prove the SAME binding is used for
    // root AND mount on EACH side:
    //   hl: working directory `${host??vmRoot}`; mounts `${vmRoot}/mnt/` — mount binding MUST equal the
    //       ?? FALLBACK binding (the vm root), never the host binding.
    //   vm: rooted at `${vmRoot}`; mounts `${vmRoot}/mnt/` — root binding MUST equal the mount binding.
    const hlWd = slices.hl.match(/working directory `\$\{([\w$]+)\?\?([\w$]+)\}`/);
    const hlMnt = slices.hl.match(/mounted under `?\$\{([\w$]+)\}\/mnt\//);
    if (!hlWd) miss("hl working-directory interpolation", "expected the `${hostCwd??vmRoot}` shape");
    if (!hlMnt) miss("hl mounts interpolation", "expected `${vmRoot}/mnt/`");
    if (hlWd && hlMnt && hlWd[2] !== hlMnt[1])
      miss(
        "hl substitution values",
        `hl mounts bind ${hlMnt[1]} but the working-directory ?? fallback (vm root) is ${hlWd[2]} — host/VM swap?`,
      );
    const vmRoot = slices.vm.match(/rooted at `?\$\{([\w$]+)\}`?/);
    const vmMnt = slices.vm.match(/mounted under `?\$\{([\w$]+)\}\/mnt\//);
    if (!vmRoot) miss("vm root interpolation", "expected `rooted at ${vmRoot}`");
    if (!vmMnt) miss("vm mounts interpolation", "expected `${vmRoot}/mnt/`");
    if (vmRoot && vmMnt && vmRoot[1] !== vmMnt[1])
      miss(
        "vm substitution values",
        `vm root binds ${vmRoot[1]} but mounts bind ${vmMnt[1]} — the two must be the same session-root binding`,
      );
    if (!/mcp__\$\{[^}]+\}__\$\{[^}]+\}/.test(slices.hl))
      miss("hl workspace-bash interpolation", "expected mcp__${…WORKSPACE_MCP_SERVER}__${…WORKSPACE_BASH}");
    // BOTH fingerprints MANDATORY — no per-branch `if (want.x)` skip (a missing committed value must
    // not silently disable a branch). A partial committed entry is itself a hard-fail.
    const hlFp = subagentBranchFingerprint(slices.hl);
    const vmFp = subagentBranchFingerprint(slices.vm);
    const versions = committed ? Object.keys(committed.versions) : [];
    if (!committed || versions.length === 0) {
      flags.push(
        "subagent-append: no committed subagentAppendVersions fingerprints — cannot verify branch-text drift (add them to baselines/prompts/cowork-system-prompt-fingerprints.json)",
      );
    } else {
      let newest = versions[0];
      for (const v of versions) if (cmpVersionStrings(v, newest) > 0) newest = v;
      const want = committed.versions[newest];
      if (typeof want.hl !== "string" || typeof want.vm !== "string")
        flags.push(
          `subagent-append: committed entry ${newest} is missing an hl or vm fingerprint — both are mandatory (a partial entry silently disables a branch)`,
        );
      if (typeof want.hl === "string" && want.hl !== hlFp)
        flags.push(
          `subagent-append: hl branch text fingerprint drifted vs ${newest} (${want.hl} -> ${hlFp}) — re-derive, update the paraphrase asset if semantics moved, then add a new version entry`,
        );
      if (typeof want.vm === "string" && want.vm !== vmFp)
        flags.push(
          `subagent-append: vm branch text fingerprint drifted vs ${newest} (${want.vm} -> ${vmFp}) — re-derive, update the paraphrase asset if semantics moved, then add a new version entry`,
        );
    }
  }
  // (4) resolveSection gate shape: if(!<eval>("124685897"))return <fallback>.
  if (!/if\(!\s*[\w$.]+\("124685897"\)\)return [\w$]+/.test(bundle))
    miss("resolveSection gate", 'the if(!gate("124685897"))return fallback shape is gone');
  // (5) substitution-map keys at the generator call. workspaceBash binds either a bare identifier or the
  //     inline mcp__${…}__${…} template literal that the release actually ships.
  if (!/\{vmCwd:[\w$]+,hostCwd:[\w$]+\?\?[\w$]+,workspaceBash:(?:[\w$]+|`mcp__\$\{[^}]+\}__\$\{[^}]+\}`)\}/.test(bundle))
    miss("substitution map", "the {vmCwd, hostCwd: hostCwd??vmRoot, workspaceBash} map keys/values moved");
  // (6) delivery-call argument-list connectivity at the appendSubagentSystemPrompt: site (S16 proves
  //     only that SOME call exists).
  if (
    !/appendSubagentSystemPrompt:(?:[\w$]+\.)?[\w$]+\(\{vmProcessName[\s\S]{0,80}hostLoopMode[\s\S]{0,80}hostCwd[\s\S]{0,80}spSectionPrompts/.test(
      bundle,
    )
  )
    miss(
      "delivery argument list",
      "the {vmProcessName, hostLoopMode, hostCwd, spSectionPrompts} argument list at the delivery site changed",
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
 * GrowthBook gate ids allowed to appear in W1's `<helper>("…")` conditionals — the CLOSED set. (The
 * gate-check helper's minified name varies per Desktop build: `At` in 1.18286.0, `et` in 1.18286.2; the
 * extractor matches it by shape, not by name.) A gate id in
 * the env windows but NOT here means a NEW gate-conditional env var was introduced: hard-fail so it gets
 * classified before the gate ever flips. Value = the env key it controls + disposition.
 */
const SPAWN_GATES: Record<string, string> = {
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
const SPAWN_ENV_ALLOWLIST: Record<string, string> = {
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
const SPAWN_PIN_KEYS: readonly string[] = [
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
    // B2: `arg` may now be a dotted member call (`o.getMcpToolTimeout`) rather than a bare hoisted
    // helper name. A dotted arg is itself an export alias — resolve `<lastSegment>[:=]<alias>` first
    // (identifier-shaped capture only, so it can't land on a `:0`-style decoy), then look up the
    // function body under the resolved alias, exactly as the bare-name path already did.
    let fnName = arg;
    if (fnName.includes(".")) {
      const last = fnName.slice(fnName.lastIndexOf(".") + 1);
      const escLast = last.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const aliasM = bundle.match(new RegExp(`${escLast}[:=]([A-Za-z_$][\\w$]*)`));
      if (!aliasM) return null;
      fnName = aliasM[1];
    }
    const esc = fnName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
 * (`<helper>("id")?"a":"b"`, helper name minifier-assigned); `String(<const|call>)`; and the modeled-session ternaries the standard 1p prod
 * chat localAgent session pins deterministically (disableCron→"1", oauth-env prod→"", 3p-entrypoint→1p).
 * Anything else → `{ unknown: true }` (never a silent partial substitution).
 */
function resolveSpawnValue(bundle: string, expr: string, gates: Record<string, GateState>): { value: string } | { unknown: true } {
  const e = expr.trim();
  let m: RegExpMatchArray | null;
  if ((m = e.match(/^"([^"]*)"$/)) || (m = e.match(/^'([^']*)'$/))) return { value: m[1] };
  if ((m = e.match(/^`([^`$]*)\$\{[^}]*\?\?"([^"]*)"\}`$/))) return { value: m[1] + m[2] };
  // B1: the gate helper may now be reached via a namespace-method receiver (`o.isFeatureEnabled(...)`)
  // instead of a bare hoisted call; the optional `(?:[A-Za-z_$][\w$]*\.)?` prefix admits both, and the
  // gate-id capture (still `m[1]`) is unaffected either way.
  if ((m = e.match(/^(?:[A-Za-z_$][\w$]*\.)?[A-Za-z_$][\w$]*\("(\d+)"\)\?"([^"]*)":"([^"]*)"$/))) {
    const id = m[1];
    if (!(id in SPAWN_GATES)) return { unknown: true };
    return { value: gates[id]?.on ? m[2] : m[3] };
  }
  // B2: the `String()` argument may now be a dotted member call (`o.getMcpToolTimeout()`); widen the
  // capture to admit `.` and let resolveStringArg follow the export-alias hop.
  if ((m = e.match(/^String\(([\w$.]+)(\(\))?\)$/))) {
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

  // Gate enumeration (W1 only — the sole window using gate-check conditionals): every referenced gate id
  // must be known. The helper name is minifier-assigned (At/et/…); match by shape. The `(?<![\w$])`
  // lookbehind keeps the match anchored to a full identifier so it can't start mid-token.
  for (const gm of (w1 as string).matchAll(/(?<![\w$])[A-Za-z_$][\w$]*\("(\d+)"\)/g)) {
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

  // A window's non-gate-spread keys. Gate-conditional spreads (…<helper>("id")&&{…}) are handled first
  // (they must be resolved against gate STATE, not read as plain literals — an off-gate NONBLOCKING:"0"
  // must not override W2's "true"), then blanked so the generic pass never sees them. Helper name is
  // minifier-assigned (At/et/…); the leading `...` bounds the identifier start.
  const applyWindow = (text: string, target: Record<string, string>, isW1: boolean) => {
    let work = text;
    if (isW1) {
      // B6: the gate helper acquired an `o.`-style receiver here too (`...o.isFeatureEnabled("id")&&{…}`);
      // without this widening the block is never blanked and the generic pass below reads its inner keys
      // (e.g. MCP_CONNECTION_NONBLOCKING:"0") as unconditional literals, silently corrupting a pinned value.
      for (const sm of text.matchAll(/\.\.\.(?:[\w$]+\.)?[A-Za-z_$][\w$]*\("(\d+)"\)&&\{([^{}]*)\}/g)) {
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
    // The `?<const>:0}` max-thinking pin appears in two build shapes: inline at the `maxThinkingTokens:`
    // key (older monolithic builds) OR hoisted into a small helper `return e??t??!r?<const>:0}` (the
    // ternary was extracted into a named function, so the value expression at the key is now a call with
    // commas and no longer matches an inline capture). Either branch captures the value-holding const,
    // which must still resolve to 31999 — a mis-capture fails that check loudly rather than false-greening.
    // B3: the ternary arm may now be a member expression (`o.DEFAULT_MAX_THINKING_TOKENS`) instead of a
    // bare const — the body-shape anchor (branch 2) stays the disambiguator (globally unique, shape- not
    // name-keyed); only the arm capture widens to admit a dot, then a dotted arm is resolved through the
    // export-alias hop before the 31999 assertion.
    const m = bundle.match(/(?:maxThinkingTokens:[^,}]{0,60}|return [\w$]+\?\?[\w$]+\?\?![\w$]+)\?([\w$.]+):0\}/);
    if (!m) miss("S4 maxThinkingTokens", "the maxThinkingTokens capture is gone");
    else {
      let armId: string | null = m[1];
      if (armId.includes(".")) {
        const last = armId.slice(armId.lastIndexOf(".") + 1);
        const escLast = last.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const aliasM = bundle.match(new RegExp(`${escLast}[:=]([A-Za-z_$][\\w$]*)`));
        armId = aliasM ? aliasM[1] : null;
      }
      const resolved = armId ? resolveConst(bundle, armId) : null;
      if (resolved !== "31999") miss("S4 maxThinkingTokens", `resolved to ${resolved} not 31999`);
    }
  }
  if (!has(/\.effort\b.{0,60}:"medium"/)) miss("S5 effortDefault", 'the .effort … :"medium" default is gone');
  if (!has(/\/sessions\/\$\{[^}]+\}\/mnt\/\.claude/)) miss("S1 configDirInGuest", "the mnt/.claude session-path template is gone");

  // A1: the spread target may now be a member expression (`...o.TASK_TOOL_NAMES`) instead of a bare
  // hoisted local const; widen the capture to admit `.`/`$` while the literal head+tail stay the anchor.
  // A4 (Desktop 1.21459.0): an INERT design-tools spread `...o.CLAUDE_DESIGN_TOOLS` may now sit between
  // "Task" and "Bash". It resolves to an EMPTY array on first-party (deployment-gated off, like the
  // {{modelIdentity}} placeholder / the S17 negative invariant), so the rendered tools[] is unchanged and
  // the hand-pinned spawn.tools stays 20 entries. Admit the spread OPTIONALLY (older asars lack it);
  // S6b below resolves it and REQUIRES it empty — if a future build populates it, S6b fails loud (a real
  // spawn tool set to model), never silently absorbed. Capture groups: s6[1]=optional design-tools spread
  // id (undefined on older asars), s6[2]=TASK_TOOL_NAMES spread id.
  const s6 = bundle.match(
    /tools:\["Task",(?:\.\.\.([\w.$]+),)?"Bash","Glob","Grep","Read","Edit","Write","NotebookEdit","WebFetch",\.\.\.([\w.$]+),"WebSearch","Skill","REPL","JavaScript","AskUserQuestion","ToolSearch"/,
  );
  if (!s6) miss("S6 tools head", "the tools[] head list moved");
  else {
    // S6b: the optional `...CLAUDE_DESIGN_TOOLS` head spread must resolve to an EMPTY array. A dotted id
    // (`o.CLAUDE_DESIGN_TOOLS`) is an export-alias hop (`CLAUDE_DESIGN_TOOLS:Cde` / `=Cde`) to the real
    // array site (`,Cde=[]`) — follow it exactly as S7 does below. Fail loud if the spread is present but
    // unresolvable, or resolves to a non-empty array (a new design tool set that must be modeled).
    const designId = s6[1];
    if (designId !== undefined) {
      const requireEmpty = (id: string): boolean => {
        const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return has(new RegExp(`(?<![\\w$])${esc}=\\[\\]`));
      };
      if (designId.includes(".")) {
        const last = designId.slice(designId.lastIndexOf(".") + 1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const aliasM = bundle.match(new RegExp(`${last}[:=]([A-Za-z_$][\\w$]*)`));
        if (!aliasM) miss("S6b design-tools", "the CLAUDE_DESIGN_TOOLS export alias could not be resolved");
        else if (!requireEmpty(aliasM[1]))
          miss("S6b design-tools", "CLAUDE_DESIGN_TOOLS is no longer empty — a new spawn tool set to model");
      } else if (!requireEmpty(designId)) {
        miss("S6b design-tools", "CLAUDE_DESIGN_TOOLS is no longer empty — a new spawn tool set to model");
      }
    }
    // A2: a dotted id (`o.TASK_TOOL_NAMES`) is not a local-const definition — it is an export-alias hop
    // (`TASK_TOOL_NAMES:uae` / `TASK_TOOL_NAMES=uae`) to the real array site (`,uae=[...]`). Follow the
    // hop (identifier-shaped capture only, so a `:0`-style decoy can't be captured) and require the exact
    // five-name array at the resolved alias — never resolveConst, whose 40-char/no-comma value budget
    // can't hold the array literal. A bare id keeps the original local-const lookup.
    const rawId = s6[2];
    const taskArray = `\\["TaskCreate","TaskUpdate","TaskGet","TaskList","TaskStop"\\]`;
    if (rawId.includes(".")) {
      const last = rawId.slice(rawId.lastIndexOf(".") + 1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const aliasM = bundle.match(new RegExp(`${last}[:=]([A-Za-z_$][\\w$]*)`));
      if (!aliasM) miss("S7 Task-tools spread", "the TASK_TOOL_NAMES export alias could not be resolved");
      else {
        const alias = aliasM[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (!has(new RegExp(`(?<![\\w$])${alias}=${taskArray}`)))
          miss("S7 Task-tools spread", "the TaskCreate…TaskStop spread that tools[] injects moved");
      }
    } else {
      const id = rawId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (!has(new RegExp(`\\b${id}=${taskArray}`)))
        miss("S7 Task-tools spread", "the TaskCreate…TaskStop spread that tools[] injects moved");
    }
  }
  if (!has(/"ToolSearch",\.\.\.\w+\.sessionType===/)) miss("S8 tools tail-guard", "a tool appended after ToolSearch would evade S6");
  // A3: same member-expression spread widening as S6.
  if (
    !has(
      /allowedTools:\["Task","Bash","Glob","Grep","Read","Edit","Write","NotebookEdit","WebFetch",\.\.\.[\w.$]+,"WebSearch","Skill","REPL","JavaScript","ToolSearch"/,
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
  // The blank-empties helper must be CALLED on the same env object that just received ANTHROPIC_CUSTOM_HEADERS
  // (…},helper(X.env)). The sdkOptions var name is minifier-assigned (V→F across builds); capture it and
  // backreference so the guarantee "blank runs on THIS env" survives the rename without hardcoding the name.
  // B5: both env helper calls may now carry a namespace-method receiver (`o.appendCoworkTelemetryHeaders`
  // / `o.dropEmptyAuthEnvSentinels`); the `(\w+\$?)\.env … \1\.env` backreference — the guarantee that the
  // blank-sentinel helper runs on the SAME env object — is untouched by the added optional receivers.
  if (!has(/ANTHROPIC_CUSTOM_HEADERS:(?:[\w$]+\.)?\w+\((\w+\$?)\.env[\s\S]{0,40}\},(?:[\w$]+\.)?\w+\(\1\.env\)/))
    miss(
      "S14b FnA application",
      "the empty-ANTHROPIC_* blank helper no longer runs on the spawn env — the '' blanks would leak into production",
    );
  if (!has(/preset:"claude_code"/)) miss("S15 promptTemplate delivery", "the claude_code preset-append delivery site is gone");
  // B4: the generator call may now carry a namespace-method receiver (`I.buildSubagentEnvironmentPrompt`);
  // the object-literal first-arg `{` survived live, so it stays part of the anchor (stronger than a bare call).
  if (!has(/appendSubagentSystemPrompt:(?:[\w$]+\.)?[\w$]+\(\{/))
    miss("S16 subagentAppend generator", "the per-session subagent-append generator call shape is gone");
  // Negative invariant: the spawn env must never CONSTRUCT this key (it would flip the agent to
  // cowork_settings.json/cowork_plugins). The bundled SDK's typed env-var registry legitimately DECLARES
  // the key as a lazy module-export getter (`CLAUDE_CODE_USE_COWORK_PLUGINS:()=>…`); that declaration is
  // not a spawn-env construction, so exclude the `:()=>` getter shape. A real construction
  // (`KEY:"1"`, `KEY:gate?"1":""`, `…cond&&{KEY:…}`) still matches and fires.
  if (has(/CLAUDE_CODE_USE_COWORK_PLUGINS\s*:(?!\(\)=>)/))
    flags.push(
      `spawn: NEGATIVE INVARIANT S17 broken — CLAUDE_CODE_USE_COWORK_PLUGINS is now SET; it would flip the agent to cowork_settings.json/cowork_plugins; ${SPAWN_NO_BYPASS}`,
    );
  // B1: same optional namespace-method receiver on the gate helper as the resolveSpawnValue recognizer.
  if (!w1 || !has(/CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES:(?:[A-Za-z_$][\w$]*\.)?[A-Za-z_$][\w$]*\("66187241"\)\?"true":""/, w1))
    miss("S18 EMIT_TOOL_USE_SUMMARIES gate-ternary", "the gate-id↔key association changed");
  if (!w1 || !has(/CLAUDE_CODE_TAGS:`lam_session_type:\$\{/, w1))
    miss("S19 CLAUDE_CODE_TAGS template", "the lam_session_type template shape changed");
  // S20: the per-model effort/regex-default config (extractModelEffortConfig) is a structural drift
  // anchor, not a hand-pinned fact — re-run the extractor and confirm its own anchors still resolve AND
  // that the four model classes documented alongside it (two literal-with-picker, two no-picker, the
  // fable|mythos regex-default) are still shaped as expected. A miss here means the model-config moved
  // and the synced spawn.effortByModel/effortRegexDefault would silently go stale.
  {
    const { config } = extractModelEffortConfig(bundle);
    if (!config) miss("S20 modelEffortConfig", "extractModelEffortConfig could not resolve the per-model config (see its own flags)");
    else {
      const withPicker = ["claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6"];
      const noPicker = ["claude-haiku-4-5", "claude-sonnet-4-5"];
      for (const m of withPicker)
        if (!config.effortByModel[m]?.effortLevels?.length)
          miss("S20 modelEffortConfig", `expected class-1 (picker) model ${m} is missing or has no effortLevels`);
      for (const m of noPicker)
        if (config.effortByModel[m] === undefined || config.effortByModel[m].effortLevels !== undefined)
          miss("S20 modelEffortConfig", `expected class-2 (no-picker) model ${m} is missing or unexpectedly has effortLevels`);
      if (!config.effortRegexDefault.pattern.includes("fable") || !config.effortRegexDefault.pattern.includes("mythos"))
        miss("S20 modelEffortConfig", "the fable|mythos class regex pattern is gone from the regex-default entry");
    }
  }
  return flags;
}

// ==========================================================================================
// Per-model effort config extraction (Phase 0 of the reasoning-config fidelity work): the literal
// per-model map (each entry's {effortLevels?, recommended?, modes?}) and the regex-default entry +
// class regex that applies to ids not in the literal map (e.g. fable/mythos-family ids). Located by
// CONTENT — the regex-default entry's exact literal shape and the class regex's own source — never by
// the minified identifier, which is minifier-assigned and not asserted to stay stable across builds.
// ==========================================================================================

interface ModelEffortEntry {
  effortLevels?: string[];
  recommended?: string;
  modes?: string[];
}

interface EffortRegexDefault {
  /** The class regex's SOURCE (RegExp.prototype.source form, no delimiters) — the pattern selecting this
   *  entry for a model id not present in the literal per-model map. */
  pattern: string;
  effortLevels: string[];
  recommended: string;
  modes: string[];
  disallowThinkingDisabled: boolean;
}

export interface ModelEffortConfig {
  effortByModel: Record<string, ModelEffortEntry>;
  effortRegexDefault: EffortRegexDefault;
}

/** Balanced-brace scan starting AT an opening `{` (index `open`). String-aware (skips "…"/'…' spans —
 *  the model-config object literals contain no template strings). Returns the index just past the
 *  matching closing `}`, or -1 if the braces never balance before the bundle ends. */
function scanBalancedObject(text: string, open: number): number {
  let depth = 0;
  let q: string | null = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === "\\") i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Parse a `["a","b",...]` array-literal body (the text between the brackets) into a string array. */
function parseQuotedArray(inner: string): string[] {
  return [...inner.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
}

/** Parse one model/regex-default entry's `{...}` body text for the three fields the config carries. */
function parseModelEntryBody(body: string): ModelEffortEntry {
  const entry: ModelEffortEntry = {};
  const el = body.match(/effortLevels:\[([^\]]*)\]/);
  if (el) entry.effortLevels = parseQuotedArray(el[1]);
  const rec = body.match(/recommended:"([^"]*)"/);
  if (rec) entry.recommended = rec[1];
  const modes = body.match(/modes:\[([^\]]*)\]/);
  if (modes) entry.modes = parseQuotedArray(modes[1]);
  return entry;
}

/**
 * Extract Cowork's per-model effort config: the literal per-model map (each id's {effortLevels?,
 * recommended?, modes?}), the regex-default entry (the config used for an id not in the literal map but
 * matching the class regex), and the class regex's own source. All three are declared back-to-back in the
 * asar as one `const <a>={...regex-default...},<b>={...literal map...},<c>=/<class regex>/` statement;
 * located here by the regex-default entry's exact literal shape (content-anchored, minifier-name-proof),
 * then the literal map by balanced-brace scan, then the class regex by its own known source. Any anchor
 * miss returns `config:null` + a flag naming what moved — mirrors deriveSpawnEnv's all-or-nothing contract
 * (never a partial/guessed map reaching the baseline).
 */
export function extractModelEffortConfig(bundle: string): { config: ModelEffortConfig | null; flags: string[] } {
  const flags: string[] = [];
  const fail = (msg: string): { config: null; flags: string[] } => {
    flags.push(`modelEffortConfig: ${msg}`);
    return { config: null, flags };
  };

  // Anchor 1: the regex-default entry's exact literal content (fixed key order: effortLevels, recommended,
  // modes, disallowThinkingDisabled) — this IS the content anchor, not a name.
  const marker =
    /\{effortLevels:\["low","medium","high","xhigh","max"\],recommended:"high",modes:\["auto"\],disallowThinkingDisabled:(!0|!1|true|false)\}/;
  const mm = marker.exec(bundle);
  if (!mm || mm.index == null)
    return fail(
      "regex-default entry (effortLevels/recommended/modes/disallowThinkingDisabled literal) not found — the model-config shape moved",
    );
  const markerEnd = mm.index + mm[0].length;

  // Anchor 2: immediately after the regex-default entry, `,<ident>={` opens the literal per-model map.
  const afterMarker = bundle.slice(markerEnd);
  const mapOpen = afterMarker.match(/^,[A-Za-z_$][\w$]*=\{/);
  if (!mapOpen) return fail("literal per-model map does not immediately follow the regex-default entry — declaration order changed");
  const mapBraceIdx = markerEnd + mapOpen[0].length - 1; // index of the map's opening "{"
  const mapCloseIdx = scanBalancedObject(bundle, mapBraceIdx);
  if (mapCloseIdx < 0) return fail("literal per-model map brace scan did not balance");
  const mapBody = bundle.slice(mapBraceIdx + 1, mapCloseIdx - 1); // strip the outer { }

  // Anchor 3: immediately after the literal map, `,<ident>=<regex-literal>` — the class regex (asserted by
  // its known fable|mythos source, not by identifier name).
  const afterMap = bundle.slice(mapCloseIdx);
  const regexClass = afterMap.match(/^,[A-Za-z_$][\w$]*=\/(\^\(\?:claude-\)\?\(\?:fable\|mythos\)\(\?:-\|\$\))\//);
  if (!regexClass)
    return fail("class regex (fable|mythos) does not immediately follow the literal per-model map — declaration order changed");

  // Parse the literal map's top-level `"id":{...}` entries. No entry body nests a `{`, so a non-brace
  // char-class body match is safe (a future nested-object entry would fail this scan, not silently truncate).
  const effortByModel: Record<string, ModelEffortEntry> = {};
  for (const em of mapBody.matchAll(/"([\w.-]+)":\{([^{}]*)\}/g)) effortByModel[em[1]] = parseModelEntryBody(em[2]);
  if (Object.keys(effortByModel).length === 0) return fail("literal per-model map parsed to zero entries — parser or shape drifted");

  const regexDefaultEntry = parseModelEntryBody(mm[0]);
  if (!regexDefaultEntry.effortLevels || !regexDefaultEntry.recommended || !regexDefaultEntry.modes)
    return fail("regex-default entry parsed with a missing field (effortLevels/recommended/modes) — parser or shape drifted");

  return {
    config: {
      effortByModel,
      effortRegexDefault: {
        pattern: regexClass[1],
        effortLevels: regexDefaultEntry.effortLevels,
        recommended: regexDefaultEntry.recommended,
        modes: regexDefaultEntry.modes,
        disallowThinkingDisabled: mm[1] === "!0" || mm[1] === "true",
      },
    },
    flags,
  };
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
