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
  unknownDeltas: string[];
}

/**
 * Behavior-affecting + provenance GrowthBook gates the harness pins (feature id → human name).
 * The ids are the numeric feature keys in the fcache; the names mirror provenance.gates in the baselines.
 */
const PINNED_GATES: Record<string, string> = {
  "1143815894": "hostLoop", // loop decision (decideLoopFromBaseline)
  "1648655587": "taskDispatchLimiter", // sub-task dispatch cap (perTask/global)
  "1978029737": "coworkRuntimeConfig", // web_fetch routing + workspace knobs
  "583857784": "bridgeSdkTransport", // SDK control-protocol transport
  "2340532315": "pluginSyncSparkplug", // startup syncPlugins()
  "2307090146": "cliPlugin", // CLI-plugin credential broker (dark)
};

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
    if (!f) continue;
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

  // 4. Egress allowlist from the asar (vmAllowedDomains + firewallAlso), merged with user hosts.
  const { domains, fingerprint } = extractFromAsar(unknown);
  const allowDomains = dedupe([...domains, ...userAllow]);

  // 5. GrowthBook gate states, decoded from the live fcache (no longer a manual step).
  const gates = decodeFcacheGates();
  if (!gates) {
    flag(unknown, "gates: fcache missing/unreadable — provenance.gates NOT re-synced");
  } else if (Object.keys(gates).length === 0) {
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
    unknownDeltas: unknown,
  };
}

/** Extract domains + fingerprint from the asar main bundle without keeping it unpacked. */
function extractFromAsar(unknown: string[]): { domains: string[]; fingerprint: string } {
  if (!existsSync(ASAR)) {
    flag(unknown, `asar not found at ${ASAR} — install/open Claude Desktop once, or fix ASAR in cowork-sync.ts`);
    return { domains: [], fingerprint: "" };
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
    // Fingerprint over the cowork-relevant slices for "unknown delta" detection.
    const slice = sliceCowork(bundle);
    const fingerprint = createHash("sha256").update(slice).digest("hex").slice(0, 16);
    return { domains, fingerprint };
  } catch (e) {
    flag(unknown, `asar extract failed (npx @electron/asar): ${(e as Error).message} — check network/npx, or unpack ${ASAR} manually`);
    return { domains: [], fingerprint: "" };
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
