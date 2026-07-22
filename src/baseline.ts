import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, isAbsolute, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PlatformBaseline } from "./types.js";
import { safeNamedBaseline } from "./boundary-paths.js";

/** SHA-256 (hex) of a file's bytes. Reads the whole file — fine for the ~240 MB agent ELF (a one-off at
 *  sync/verify time, never on the hot path). */
export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Count non-overlapping literal occurrences of `needle` in a file's bytes. Reads the whole file (same
 * one-off cost as `sha256File` — sync/verify time only, never the hot path), so a match anywhere in the
 * ~240 MB agent ELF is found with no chunk-boundary blind spot. Used for the agent-binary string
 * sentinels (e.g. `tengu_saddle_lantern`), whose runtime feature state the sync cannot see any other
 * way; a change in the committed count surfaces as a `sync --diff` line.
 */
export function countStringInFile(path: string, needle: string): number {
  const buf = readFileSync(path);
  const nb = Buffer.from(needle);
  if (nb.length === 0) return 0;
  let n = 0;
  let i = buf.indexOf(nb, 0);
  while (i !== -1) {
    n++;
    i = buf.indexOf(nb, i + nb.length);
  }
  return n;
}

/**
 * Point-of-use integrity check for the agent ELF against the baseline's recorded `sha256`. **On by
 * default** (opt out with `COWORK_HARNESS_VERIFY_AGENT_SHA=0`) — a recorded hash that is never enforced at
 * the point of use is decorative, and fidelity is the whole point. Cost is one ~240 MB hash per resolve
 * (once per run), negligible against a real run.
 *
 * HARD-FAILS only when ALL of: the path is the baseline's own `stagedPath` (not an intentional
 * substitution), the recorded hash is `measured-local` (trustworthy), and it mismatches — i.e. the binary
 * provably is not the one this baseline was synced against. Otherwise ADVISORY-WARNS: against an
 * `official-manifest` hash (staging-identity unverified — Desktop may repack what it stages), or on ANY
 * mismatch under an intentional substitution (`COWORK_AGENT_BINARY` override / newest-sibling fallback),
 * where the user deliberately chose a different binary and a hard stop would be hostile. No-op when opted
 * out, the baseline has no `sha256`, or the file is unreadable. ELF-only: `resolveHostAgentBinary` does NOT
 * verify — the signed native Mach-O has no trustworthy baseline hash (see the schema note on `nativeSha256`).
 */
function verifiedElf(path: string, baseline: PlatformBaseline, opts: { intentionalSubstitution?: boolean } = {}): string {
  const p = resolve(path);
  if (process.env.COWORK_HARNESS_VERIFY_AGENT_SHA === "0") return p;
  const expected = baseline.agentBinary?.sha256;
  if (!expected || !existsSync(p)) return p;
  const actual = sha256File(p);
  if (actual === expected) return p;
  const prov = baseline.agentBinary?.shaProvenance;
  const head = `cowork-harness: agent ELF sha256 mismatch\n  path     ${p}\n  expected ${expected} (${prov ?? "unknown provenance"})\n  actual   ${actual}`;
  if (prov === "measured-local" && !opts.intentionalSubstitution) {
    throw new Error(
      `${head}\n  measured-local baseline hash — hard fail: this is not the binary the baseline was synced against.\n  (Set COWORK_HARNESS_VERIFY_AGENT_SHA=0 to bypass.)`,
    );
  }
  const why = opts.intentionalSubstitution
    ? "you selected this binary explicitly (override/fallback) — advisory only."
    : "official-manifest hash — staging-identity unverified; advisory only (Desktop may repack the staged binary).";
  process.stderr.write(`${head}\n  ${why}\n`);
  return p;
}

export const BASELINES_DIR = join(fileURLToPath(new URL("..", import.meta.url)), "baselines");

/**
 * The Desktop release boundary at which Cowork's runtime switched to BOTH bare-name work-folder mounts
 * (`mnt/<name>` instead of `mnt/.projects/<id>`) AND the dynamically-generated host-loop "## Shell access"
 * prompt. These are the same binary's behavior, so they share ONE constant — host-loop prompt gating
 * (`hostloop.ts`) and mount-path gating (`session.ts`) both import this. Homed here in `baseline.ts` (a
 * near-leaf everyone imports) to stay cycle-free. For appVersion >= this, use the bare-name scheme + the
 * generated prompt; below it, the legacy `.projects/<id>` + static prompt. Bump only when a new Desktop
 * release changes that contract.
 */
export const MOUNT_BARE_NAME_MIN_VERSION = "1.14271.0";

/** True iff `found` is a same-major.minor, different-patch bump over `pinned` (both dotted version
 *  strings). The single definition of "patch-only" shared by the native-binary drift classifier and the
 *  VM-ELF parity-mount tolerance, so the two never diverge on what counts as a safe patch bump. */
export function isPatchBump(pinned: string | undefined, found: string | undefined): boolean {
  return (
    !!pinned &&
    !!found &&
    pinned.split(".")[0] === found.split(".")[0] &&
    pinned.split(".")[1] === found.split(".")[1] &&
    cmpVersionStrings(pinned, found) !== 0
  );
}

/**
 * Resolve the host path to the staged agent ELF (COWORK_AGENT_BINARY override > baseline.stagedPath).
 *
 * `opts.parityMount` is an opt-in used ONLY by the hostloop VM-ELF bind-mount — that ELF is mounted
 * read-only into the bash sidecar but is not run by any harness-spawned process there (the executed agent
 * on hostloop is the NATIVE binary via `resolveHostAgentBinary`; only a model-initiated bash command could
 * exec it inside the hardened, default-deny sidecar). When set, a pruned pin whose newest sibling is a
 * same-major.minor PATCH bump is auto-accepted (loud stderr note, advisory sha) instead of throwing —
 * mirroring `resolveHostAgentBinary`'s native-binary policy. Executed-agent callers (container/microvm/
 * chat-raw) never pass this option, so their strict, sha-hard-fail behavior is unchanged. Crucially, this
 * tolerance is reachable ONLY when the EXACT pinned path is absent — an existing pinned path is verified
 * via `verifiedElf(staged, baseline)` (no `intentionalSubstitution`) before this branch is ever reached, so
 * a `measured-local` sha mismatch on the pinned binary itself still hard-fails under `parityMount` too.
 */
export function resolveAgentBinary(baseline: PlatformBaseline, opts: { parityMount?: boolean } = {}): string {
  const override = process.env.COWORK_AGENT_BINARY;
  if (override) {
    if (!existsSync(override)) throw new Error(`COWORK_AGENT_BINARY not found: ${override}`);
    return verifiedElf(override, baseline, { intentionalSubstitution: true });
  }
  const staged = (baseline.agentBinary?.stagedPath ?? "").replace(/^~(?=$|\/)/, homedir());
  if (staged && existsSync(staged)) return verifiedElf(staged, baseline);
  // The baseline's exact version dir is gone (e.g. Claude Desktop updated).
  // By default this is a hard failure — a different agent version can silently change behavior.
  // Set COWORK_HARNESS_ALLOW_AGENT_FALLBACK=1 to opt in to using the newest sibling binary.
  const exactPath = staged || "(unknown)";
  const fallback = staged ? newestStagedBinary(staged) : undefined;
  if (opts.parityMount && fallback) {
    const pinnedVer = basename(dirname(staged)); // .../claude-code-vm/<ver>/claude
    const foundVer = basename(dirname(fallback));
    if (isPatchBump(pinnedVer, foundVer)) {
      process.stderr.write(
        `cowork-harness: staged VM ELF ${pinnedVer} pruned by a Desktop update; using patch-newer ${foundVer} ` +
          `for the hostloop parity mount (not run by any harness-spawned process) — behavior contract unchanged for a patch bump.\n`,
      );
      return verifiedElf(fallback, baseline, { intentionalSubstitution: true });
    }
  }
  if (fallback && process.env.COWORK_HARNESS_ALLOW_AGENT_FALLBACK === "1") {
    process.stderr.write(`cowork-harness: staged agent binary "${staged}" not found; ` + `falling back to newest sibling "${fallback}".\n`);
    return verifiedElf(fallback, baseline, { intentionalSubstitution: true });
  }
  if (fallback) {
    // A fallback exists but the opt-in env is not set — fail explicitly rather than silently using a
    // different agent version that could make the run appear green while running the wrong binary.
    throw new Error(
      `cowork-harness: baseline agent binary not found: ${exactPath}. Set COWORK_HARNESS_ALLOW_AGENT_FALLBACK=1 to use the newest available.`,
    );
  }
  throw new Error(
    `Staged agent binary not found at "${staged}". It is extracted from your Claude Desktop install ` +
      `(claude-code-vm/<ver>/claude). Open Cowork once to stage it, or set COWORK_AGENT_BINARY to its path.`,
  );
}

/**
 * Given a `.../claude-code-vm/<ver>/claude` staged path whose exact version dir is missing,
 * scan the `claude-code-vm/` root for `<ver>/claude` siblings and return the newest existing
 * binary by numeric version sort. Returns undefined if none exist.
 */
function newestStagedBinary(stagedPath: string): string | undefined {
  return newestStagedSibling(dirname(dirname(stagedPath)), "claude");
}

/**
 * Shared version-dir scanner behind both `newestStagedBinary` (VM ELF: `<versionRoot>/<ver>/claude`) and
 * `newestStagedHostBinary` (native Mach-O: `<versionRoot>/<ver>/claude.app/Contents/MacOS/claude`) — `leaf`
 * is the path segment(s) AFTER the version dir. Numeric/semver-aware sort matching compareBaselineVersions.
 */
export function newestStagedSibling(versionRoot: string, leaf: string): string | undefined {
  if (!existsSync(versionRoot)) return undefined;
  const seg = (v: string) =>
    v.split(".").map((s) => {
      const n = parseInt(s, 10);
      return Number.isNaN(n) ? 0 : n;
    });
  const cmp = (a: string, b: string) => {
    const segA = seg(a);
    const segB = seg(b);
    const len = Math.max(segA.length, segB.length);
    for (let i = 0; i < len; i++) {
      const diff = (segA[i] ?? 0) - (segB[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  };
  let dirs: string[];
  try {
    dirs = readdirSync(versionRoot);
  } catch {
    return undefined;
  }
  const versions = dirs.filter((d) => existsSync(join(versionRoot, d, leaf))).sort(cmp);
  if (versions.length === 0) return undefined;
  return resolve(join(versionRoot, versions[versions.length - 1], leaf));
}

/** Strip `n` trailing path segments via repeated `dirname`. */
function nthParentDir(p: string, n: number): string {
  let out = p;
  for (let i = 0; i < n; i++) out = dirname(out);
  return out;
}

/** `.../claude-code/<ver>/claude.app/Contents/MacOS/claude` — the leaf below the `<ver>` directory. */
const NATIVE_LEAF = "claude.app/Contents/MacOS/claude";
/** Number of path segments to strip off a full native binary path to reach its `<ver>` directory —
 *  the 4-segment `NATIVE_LEAF` plus the `<ver>` dir itself. */
const NATIVE_VERSION_ROOT_DEPTH = NATIVE_LEAF.split("/").length + 1;

/** Extract the `<ver>` directory name from a `.../claude-code/<ver>/claude.app/Contents/MacOS/claude`
 *  path. `NATIVE_LEAF` is 4 segments (`claude.app/Contents/MacOS/claude`), so the `<ver>` dir is 4
 *  `dirname` hops up from the leaf file. Returns undefined if the path is too shallow to contain one. */
function nativeVersionFromPath(path: string): string | undefined {
  const verDir = nthParentDir(path, NATIVE_LEAF.split("/").length);
  const ver = verDir.split("/").pop();
  return ver || undefined;
}

/**
 * Classification of the NATIVE agent binary's staging state against its baseline pin — the single
 * source of truth shared by `resolveHostAgentBinary` and `doctor`'s `hostAgent` check so the two never
 * disagree about whether a drift is patch-only (auto-tolerated) or major/minor (env-gated/hard-fail).
 *
 * - `exact` — the pinned path exists as-is.
 * - `patch` — the pinned path is gone, but a same-major.minor, different-patch sibling exists (safe:
 *   the native binary has no sha256 pin, so a patch bump is auto-tolerated).
 * - `major-minor` — the pinned path is gone and either no sibling version could be extracted, or the
 *   best sibling differs in major or minor (today's env-gated-fallback-or-throw behavior applies).
 * - `missing` — the pinned path is gone and no sibling binary exists at all.
 */
export interface NativeStagingDrift {
  kind: "exact" | "patch" | "major-minor" | "missing";
  /** The baseline's configured (possibly nonexistent) staged path, tilde-expanded. */
  stagedPath: string;
  /** The pinned version dir name, if extractable from `stagedPath`. */
  pinned?: string;
  /** The fallback sibling's version dir name, if one was found. */
  found?: string;
  /** The fallback sibling's resolved binary path, if one was found (kinds `patch`/`major-minor`). */
  fallbackPath?: string;
}

/** Classify the native agent binary's staging drift against `baseline.agentBinary.nativeStagedPath`.
 *  See `NativeStagingDrift` for the classification. Pure/read-only — does not touch env vars. */
export function classifyNativeStagingDrift(baseline: PlatformBaseline): NativeStagingDrift {
  const staged = (baseline.agentBinary?.nativeStagedPath ?? "").replace(/^~(?=$|\/)/, homedir());
  if (staged && existsSync(staged)) {
    const ver = nativeVersionFromPath(staged);
    return { kind: "exact", stagedPath: staged, pinned: ver, found: ver };
  }
  if (!staged) return { kind: "missing", stagedPath: staged };
  const fallback = newestStagedSibling(nthParentDir(staged, NATIVE_VERSION_ROOT_DEPTH), NATIVE_LEAF);
  if (!fallback) return { kind: "missing", stagedPath: staged, pinned: nativeVersionFromPath(staged) };
  const pinned = nativeVersionFromPath(staged);
  const found = nativeVersionFromPath(fallback);
  const patchOnly = isPatchBump(pinned, found);
  return { kind: patchOnly ? "patch" : "major-minor", stagedPath: staged, pinned, found, fallbackPath: fallback };
}

/**
 * Resolve the host path to the staged NATIVE macOS agent binary (COWORK_HOST_AGENT_BINARY override >
 * baseline.agentBinary.nativeStagedPath). Desktop stages a native macOS Mach-O binary alongside the
 * Linux/arm64 ELF — `claude-code/<ver>/claude.app/Contents/MacOS/claude`. This is what hostloop spawns
 * directly (no Docker) for the agent loop; the ELF (`resolveAgentBinary`) stays the source of truth for
 * container/microvm and for hostloop's bash/web_fetch VM sidecar image.
 *
 * A mid-session Claude Desktop auto-update prunes the pinned version and stages a newer one — since the
 * native binary carries NO sha256 pin (unlike the ELF), a same-major.minor PATCH bump is auto-tolerated
 * by default (loud stderr note, no env var needed): `verifiedElf`'s hard-fail-on-mismatch doesn't apply
 * here, so silently using a patch-newer binary can't downgrade an integrity check that doesn't exist. A
 * major/minor drift keeps today's behavior — env-gated fallback or a hard throw.
 */
export function resolveHostAgentBinary(baseline: PlatformBaseline): string {
  const override = process.env.COWORK_HOST_AGENT_BINARY;
  if (override) {
    if (!existsSync(override)) throw new Error(`COWORK_HOST_AGENT_BINARY not found: ${override}`);
    return resolve(override);
  }
  const drift = classifyNativeStagingDrift(baseline);
  if (drift.kind === "exact") return resolve(drift.stagedPath);
  const exactPath = drift.stagedPath || "(unknown)";
  if (drift.kind === "patch") {
    process.stderr.write(
      `cowork-harness: staged native agent ${drift.pinned} pruned by a Desktop update; using patch-newer ` +
        `${drift.found} — behavior contract unchanged for a patch bump.\n`,
    );
    return resolve(drift.fallbackPath!);
  }
  if (drift.kind === "major-minor") {
    if (process.env.COWORK_HARNESS_ALLOW_AGENT_FALLBACK === "1") {
      process.stderr.write(
        `cowork-harness: staged NATIVE agent binary "${exactPath}" not found; falling back to newest sibling "${drift.fallbackPath}".\n`,
      );
      return resolve(drift.fallbackPath!);
    }
    throw new Error(
      `cowork-harness: baseline NATIVE agent binary not found: ${exactPath}. Set COWORK_HARNESS_ALLOW_AGENT_FALLBACK=1 to use the newest available.`,
    );
  }
  throw new Error(
    `Staged NATIVE agent binary not found at "${exactPath}". It is extracted from your Claude Desktop install ` +
      `(claude-code/<ver>/claude.app/Contents/MacOS/claude). Open Cowork once to stage it, or set COWORK_HOST_AGENT_BINARY to its path.`,
  );
}

/**
 * Resolve a baseline by `latest`, an absolute path, or a name under `baselines/`. A non-absolute name
 * is treated as a BARE FILENAME resolved under BASELINES_DIR — both `desktop-x` and `desktop-x.json`
 * load from there regardless of cwd. A non-absolute name MUST NOT contain a path separator
 * (`safeNamedBaseline` rejects `../`, nested paths, and `../foo.json`). Use an absolute path for an
 * out-of-tree baseline (the explicit escape hatch).
 */
export function loadBaseline(name: string): PlatformBaseline {
  const file =
    name === "latest"
      ? latestBaselineFile()
      : isAbsolute(name)
        ? name
        : // A named (non-absolute) baseline is a BARE FILENAME under BASELINES_DIR. Reject path
          // separators first: a name like `../../etc/hosts` or `../foo.json` (whose `.json` suffix
          // skips the append below) would otherwise read an arbitrary out-of-tree `.json`. Absolute
          // paths remain the explicit escape hatch (handled above).
          join(BASELINES_DIR, withJsonSuffix(safeNamedBaseline(name)));
  const raw = JSON.parse(readFileSync(file, "utf8"));
  return PlatformBaseline.parse(raw);
}

/** Append `.json` to a baseline name unless it already carries the suffix. */
function withJsonSuffix(name: string): string {
  return name.endsWith(".json") ? name : `${name}.json`;
}

/**
 * Compare two `desktop-<version>.json` filenames numerically by version segment.
 * Returns negative if a < b, zero if equal, positive if a > b.
 * Example: compareBaselineVersions("desktop-1.9.json", "desktop-1.10.json") < 0
 */
export function compareBaselineVersions(a: string, b: string): number {
  // Strip the "desktop-" prefix and ".json" suffix to get the raw version string.
  const versionOf = (f: string) => f.replace(/^desktop-/, "").replace(/\.json$/, "");
  return cmpVersionStrings(versionOf(a), versionOf(b));
}

/**
 * Compare two RAW dotted version strings (e.g. "1.14271.0" vs "1.13576.1") numerically by segment.
 * Negative if a < b, zero if equal, positive if a > b. A non-numeric segment coerces to 0 so the
 * comparison stays total — a garbage/empty version compares as 0.0.0 (the safe low end).
 */
export function cmpVersionStrings(a: string, b: string): number {
  const seg = (v: string) =>
    v.split(".").map((s) => {
      const n = parseInt(s, 10);
      return Number.isNaN(n) ? 0 : n;
    });
  const segA = seg(a);
  const segB = seg(b);
  const len = Math.max(segA.length, segB.length);
  for (let i = 0; i < len; i++) {
    const diff = (segA[i] ?? 0) - (segB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function latestBaselineFile(): string {
  const files = readdirSync(BASELINES_DIR).filter((f) => f.startsWith("desktop-") && f.endsWith(".json"));
  if (files.length === 0) throw new Error(`No baselines in ${BASELINES_DIR}; run \`cowork-harness sync\` first.`);
  // Use numeric/semver-aware sort so desktop-1.10.json > desktop-1.9.json (not lexical).
  files.sort(compareBaselineVersions);
  return join(BASELINES_DIR, files[files.length - 1]);
}

/**
 * Expand the mount layout for a concrete session id.
 * cwd/sessionRoot = the session root (e.g. /sessions/<id>); mounts sit under mntRoot
 * (/sessions/<id>/mnt) and are returned as ABSOLUTE guest paths.
 */
export function resolveMounts(baseline: PlatformBaseline, sessionId: string, projectId = "proj1") {
  const subst = (s: string) => s.replace("{sessionId}", sessionId).replace("{projectId}", projectId);
  const cwd = subst(baseline.mountLayout.cwd);
  const sessionRoot = subst(baseline.mountLayout.sessionRoot);
  // TODO: container.ts:31 computes configGuest independently from sessionRoot and is NOT fixed here;
  // the legacy desktop-1.11847.5 baseline (sessionRoot ending in /mnt, no spawn block) still produces
  // a double-mnt configGuest path (/sessions/<id>/mnt/mnt/.claude) — that is a separate out-of-scope issue.
  const rawSessionRoot = baseline.mountLayout.sessionRoot;
  const mntRoot = subst(baseline.mountLayout.mntRoot ?? (rawSessionRoot.endsWith("/mnt") ? rawSessionRoot : `${rawSessionRoot}/mnt`));
  return {
    cwd,
    sessionRoot,
    mntRoot,
    configDir: `${mntRoot}/.claude`,
    mounts: baseline.mountLayout.mounts.map((m) => ({ ...m, mountPath: `${mntRoot}/${subst(m.mountPath)}` })),
  };
}
