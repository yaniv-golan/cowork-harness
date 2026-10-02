import { readFileSync, readdirSync, existsSync, statSync, lstatSync, realpathSync } from "node:fs";
import { join, resolve, isAbsolute, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PlatformBaseline } from "./types.js";
import { safeNamedBaseline } from "./boundary-paths.js";
import { UnknownBaselineError, BaselineFileError, compactSchemaError } from "./errors.js";
import { ZodError } from "zod";

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

/** The Desktop version the shipped rootfs provisioning manifest was captured from
 *  (`baselines/provisioning/rootfs-provisioning.json`), or `undefined` when the file is absent or undated.
 *  It is the dated evidence behind every "real Cowork ships them" sentence the harness prints, so the
 *  sentence can carry its date instead of asking the reader to trust an unstamped claim. Never throws:
 *  a verdict must not fail because a provenance footnote could not be read. */
export function rootfsManifestDesktopVersion(): string | undefined {
  try {
    const m = JSON.parse(readFileSync(join(BASELINES_DIR, "provisioning", "rootfs-provisioning.json"), "utf8")) as {
      desktopVersion?: unknown;
    };
    return typeof m.desktopVersion === "string" && /^\d+\.\d+\.\d+$/.test(m.desktopVersion) ? m.desktopVersion : undefined;
  } catch {
    return undefined;
  }
}

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

/** First Desktop that constructs CLAUDE_CODE_DESKTOP_APP_VERSION in the spawn env (W2, unconditional on
 *  first-party). Verified ABSENT from 1.46388.4, 1.46388.3, 1.44121.1, 1.40609.1 and 1.32885.1, and
 *  present in 2.2553.1 — so injecting it on an older baseline would hand the agent a key that baseline's
 *  Desktop never set. Not symmetric with CLAUDE_CODE_HOST_PLATFORM, which every asar on record sets. */
export const DESKTOP_APP_VERSION_MIN_VERSION = "2.2553.1";

/** First Desktop whose host loop runs the agent process OFF the outputs dir: at `/var/empty` when that
 *  passes a stat check, else a per-session `host-cwd` dir, with deny rules for every spelling of it. Every
 *  marker of the rule (`/var/empty`, `host-cwd`, `getHostProcessCwd`) is absent from every backed-up asar
 *  through 2.2553.1 and present from 2.7032.0, where `hostLoopCwd` disappears. Below it the agent runs at
 *  outputs, as those releases did. */
export const HOSTLOOP_SYSTEM_EMPTY_CWD_MIN_VERSION = "2.7032.0";

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
    if (!existsSync(override)) throw new AgentBinaryError(`COWORK_AGENT_BINARY not found: ${override}`, "override");
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
    // The only remedy that keeps the exact pin is recovering that version from the release channel — so it
    // comes first, on the one line doctor shows. COWORK_AGENT_BINARY downgrades the sha check to advisory,
    // hence "sha-verify": the runbook's own step, which the harness cannot enforce on an override.
    throw new AgentBinaryError(
      `cowork-harness: baseline agent binary not found: ${exactPath}. Recover and sha-verify the pinned ` +
        `${basename(dirname(staged))} ELF, then set COWORK_AGENT_BINARY=<path> to it (docs/maintenance.md#recovering-an-old-agent-version), ` +
        `or set COWORK_HARNESS_ALLOW_AGENT_FALLBACK=1 to use the newest available.`,
      "pruned",
    );
  }
  throw new AgentBinaryError(
    `Staged agent binary not found at "${staged}". Claude Desktop stages it on macOS (claude-code-vm/<ver>/claude); ` +
      `otherwise set COWORK_AGENT_BINARY to a Linux ELF (docs/maintenance.md#recovering-an-old-agent-version).`,
    "missing",
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

// ── Native macOS agent staging ────────────────────────────────────────────────────────────────────────
//
// Two layouts exist under `<userData>/claude-code/`:
//   - flat (Desktop 2.16120.0 and earlier):   `<ver>/claude.app/Contents/MacOS/claude`
//   - per-build (Desktop 2.19675.0):          `<ver>/<build>/claude.app/Contents/MacOS/claude`
// Binary-verified in the 2.19675.0 asar: the build dir is `Vdr(checksum)` = the first 12 hex characters of
// the manifest checksum, lowercased, and a dir counts as a build only if its name matches `/^[0-9a-f]{12}$/`
// (`Udr`). On darwin the checksum is the BUNDLE archive's (`platforms[darwin-<arch>].bundle.checksum`), not
// the inner Mach-O's, so a build can never be identified by hashing the binary — the 12-hex segment of the
// pinned path is the only build identity a baseline carries. `<build>/.verified` holds the full checksum and
// is written last (after extract-to-temp + rename). `moveLegacyInstallNow` migrates an existing flat install
// into its build dir on first touch (the VM ELF under `claude-code-vm/` is never moved); when that move fails,
// Desktop adds the version to `legacyMovesGivenUp` — held in memory for that process only, so the move is
// retried on the next launch — and meanwhile the flat root joins the fallback order below.
//
// Which build Desktop runs: its PRIMARY path runs the dir its current manifest names, and only when `.verified`
// equals that manifest checksum exactly (else it re-downloads). Its FALLBACK (`publishedInstallDirs`) takes
// any 12-hex dir that merely HAS a `.verified`, newest `.verified` mtime first. The harness cannot know the
// manifest at run time, so its rule sits between the two: a build counts when its `.verified` holds a 64-hex
// checksum whose first 12 characters (lowercased) equal the dir name. That is stricter than Desktop's
// fallback — a dir whose marker names another build is skipped here, where Desktop's offline fallback could
// still consider it — and looser than its primary path, which also needs the checksum to match the manifest.

/** The leaf below a version dir (flat) or a build dir (per-build). */
const NATIVE_LEAF = "claude.app/Contents/MacOS/claude";
/** Desktop's build-dir rule (`Bdr`). */
const NATIVE_BUILD_RE = /^[0-9a-f]{12}$/;
/** Desktop's checksum rule (`zdr`) for the `.verified` marker. */
const NATIVE_CHECKSUM_RE = /^[0-9a-fA-F]{64}$/;
/** Lazy root: the version is the segment right after the SHORTEST root that leaves a valid tail, so a
 *  per-build path never reads its build as the version. The build segment is matched case-insensitively and
 *  lowercased, as Desktop's `Vdr` lowercases the checksum it names the dir after. */
const NATIVE_PATH_RE = /^(.*?)\/([^/]+)\/(?:([0-9a-fA-F]{12})\/)?claude\.app\/Contents\/MacOS\/claude$/;

export interface NativeStagedPath {
  /** The `claude-code` dir the version dirs live in. */
  root: string;
  version: string;
  /** The 12-hex build dir (lower case), for a per-build path. */
  build?: string;
}

/** Parse a native agent path in either layout. Pure. */
export function parseNativeStagedPath(p: string): NativeStagedPath | undefined {
  const m = NATIVE_PATH_RE.exec(p);
  if (!m) return undefined;
  return m[3] ? { root: m[1], version: m[2], build: m[3].toLowerCase() } : { root: m[1], version: m[2] };
}

/** The native agent version a baseline pins, read from the `<ver>` directory of
 *  `agentBinary.nativeStagedPath` in either layout. This is the agent hostloop executes, and it versions
 *  independently of `agentVersion` (the VM ELF). `undefined` when the baseline pins no native binary or the
 *  path does not sit under a `claude-code/` dir. Pure; never touches the filesystem. */
export function pinnedNativeAgentVersion(baseline: PlatformBaseline): string | undefined {
  const p = parseNativeStagedPath(baseline.agentBinary?.nativeStagedPath ?? "");
  return p && /(^|\/)claude-code$/.test(p.root) ? p.version : undefined;
}

/** The build a `.verified` marker names, or undefined when the marker is absent or not a checksum. */
function markerBuild(dir: string): { build: string; publishedMs: number } | undefined {
  const f = join(dir, ".verified");
  let text: string;
  let mtimeMs: number;
  try {
    text = readFileSync(f, "utf8").trim();
    mtimeMs = statSync(f).mtimeMs;
  } catch {
    return undefined;
  }
  return NATIVE_CHECKSUM_RE.test(text) ? { build: text.slice(0, 12).toLowerCase(), publishedMs: mtimeMs } : undefined;
}

/** The basename a version dir's symlink resolves to, or undefined when it is not a symlink. */
function pinnedVersionLinkTarget(vdir: string): string | undefined {
  try {
    return lstatSync(vdir).isSymbolicLink() ? basename(realpathSync(vdir)) : undefined;
  } catch {
    return undefined;
  }
}

/** A real directory, not a symlink to one. */
function isRealDir(p: string): boolean {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

interface NativeCandidate {
  path: string;
  version: string;
  layout: "nested" | "flat";
  /** The build the candidate's marker names (always set for nested; set for a flat one with a marker). */
  build?: string;
  publishedMs?: number;
}

/** A 12-hex dir that is not a runnable build, and why. `unmarked` is the only reason Desktop itself leaves
 *  behind mid-staging; the others are a dir in some other state. */
interface UnusableBuild {
  entry: string;
  reason: "unmarked" | "names-other" | "no-binary" | "bare-binary";
  /** For `names-other`: the build its marker names. */
  names?: string;
}

interface NativeVersionScan {
  /** Runnable candidates, in choice order (see `scanNativeVersion`). */
  candidates: NativeCandidate[];
  /** 12-hex dirs that are not runnable builds — never chosen. */
  unusable: UnusableBuild[];
  /** `<ver>/<entry>` entries that fit neither layout (dot-entries such as `.extract-*` are Desktop's own). */
  unknown: string[];
}

/**
 * Scan one version dir for runnable native binaries in both layouts, in choice order:
 *  1. builds (`<ver>/<12hex>/`, a real directory — a symlink is skipped, as Desktop's `Dirent.isDirectory()`
 *     skips it — whose `.verified` names that same build) and a flat install that has a valid marker, sorted
 *     by `compareNativeCandidates`;
 *  2. a flat install with no marker, only when nothing in (1) exists. That is the pre-2.19675.0 shape the
 *     harness always accepted, kept so an older Desktop resolves exactly as before. Desktop 2.19675.0 itself
 *     would not run it (no `.verified`, so neither its primary path nor `publishedInstallDirs` lists it).
 * The version dir itself is followed through a symlink, as Desktop follows it (it joins storageDir and the
 * version; only build dirs are filtered with `isDirectory()`).
 */
function scanNativeVersion(root: string, version: string): NativeVersionScan {
  const vdir = join(root, version);
  const out: NativeVersionScan = { candidates: [], unusable: [], unknown: [] };
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = readdirSync(vdir, { withFileTypes: true });
  } catch {
    /* unreadable version dir */
  }
  const ranked: NativeCandidate[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "claude.app" || e.name === "claude") continue;
    if (NATIVE_BUILD_RE.test(e.name)) {
      if (!e.isDirectory()) continue;
      const bdir = join(vdir, e.name);
      const bin = join(bdir, NATIVE_LEAF);
      const m = markerBuild(bdir);
      const entry = `${version}/${e.name}`;
      if (!m) out.unusable.push({ entry, reason: "unmarked" });
      else if (m.build !== e.name) out.unusable.push({ entry, reason: "names-other", names: m.build });
      else if (existsSync(bin)) ranked.push({ path: bin, version, layout: "nested", build: e.name, publishedMs: m.publishedMs });
      else out.unusable.push({ entry, reason: existsSync(join(bdir, "claude")) ? "bare-binary" : "no-binary" });
      continue;
    }
    out.unknown.push(`${version}/${e.name}`);
  }
  const flatBin = join(vdir, NATIVE_LEAF);
  let flatUnverified: NativeCandidate | undefined;
  if (existsSync(flatBin)) {
    const m = markerBuild(vdir);
    if (m) ranked.push({ path: flatBin, version, layout: "flat", build: m.build, publishedMs: m.publishedMs });
    else flatUnverified = { path: flatBin, version, layout: "flat" };
  }
  ranked.sort(compareNativeCandidates);
  out.candidates = ranked.length ? ranked : flatUnverified ? [flatUnverified] : [];
  return out;
}

const describeUnusable = (u: UnusableBuild) =>
  u.reason === "unmarked"
    ? `${u.entry} has no .verified marker (Desktop writes it last, so it has not finished staging that build)`
    : u.reason === "names-other"
      ? `${u.entry}'s .verified names build ${u.names}, not this dir`
      : u.reason === "bare-binary"
        ? `${u.entry} holds a bare claude binary, not claude.app (a non-bundle install this harness does not run)`
        : `${u.entry} is marked verified but has no claude.app binary`;

/** Choice order among verified candidates of one version: newest `.verified` mtime first, then per-build
 *  before flat, then build name ascending. Desktop's own sort is stable, so on a tie it keeps readdir order,
 *  which is filesystem-dependent; the name key makes the harness's choice total. Exported for tests (APFS
 *  returns names sorted, so a tie on disk cannot tell the name key from readdir order). */
export function compareNativeCandidates(
  a: { publishedMs?: number; layout: "nested" | "flat"; build?: string },
  b: { publishedMs?: number; layout: "nested" | "flat"; build?: string },
): number {
  return (
    (b.publishedMs ?? 0) - (a.publishedMs ?? 0) ||
    (a.layout === b.layout ? 0 : a.layout === "nested" ? -1 : 1) ||
    (a.build ?? "").localeCompare(b.build ?? "")
  );
}

/** Every version dir under `root` for the FALLBACK search, newest version first. A symlinked version dir is
 *  skipped: a harness rule, not Desktop's (Desktop never enumerates versions this way), so a link such as
 *  2.1.299 -> 2.1.286 cannot report one version's binary under another's name. */
function stagedNativeVersions(root: string): { version: string; scan: NativeVersionScan }[] {
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names
    .filter((n) => !n.startsWith(".") && isRealDir(join(root, n)))
    .map((version) => ({ version, scan: scanNativeVersion(root, version) }))
    .sort((a, b) => cmpVersionStrings(b.version, a.version));
}

const buildLabel = (c: NativeCandidate) => (c.layout === "nested" ? c.build! : "the flat install");

/**
 * Classification of the NATIVE agent binary's staging state against its baseline pin — the single
 * source of truth shared by `resolveHostAgentBinary` and `doctor`'s `hostAgent` check so the two never
 * disagree.
 *
 * - `exact` — the pinned version is staged. For a per-build pin, it is the pinned build; for a flat pin
 *   (which names no build) it is the first candidate in choice order, with `relocated` when Desktop moved it
 *   into a build dir and `others` when more than one build of that version is staged.
 * - `build` — the pin names a build, that build is not staged, and another install of the SAME version is.
 *   A different build is a different binary, so it is gated like `major-minor`. A flat pin never yields it.
 * - `patch` — the pinned version has nothing runnable; the newest staged one differs only in patch
 *   (auto-tolerated: the native binary has no sha256 pin). It may be older than the pin.
 * - `major-minor` — the newest staged version differs in major or minor (env-gated fallback or throw).
 * - `missing` — nothing runnable under either layout; `cause` says why.
 */
export interface NativeStagingDrift {
  kind: "exact" | "build" | "patch" | "major-minor" | "missing";
  /** The baseline's configured (possibly nonexistent) staged path, tilde-expanded. */
  stagedPath: string;
  /** The pinned version, if extractable from `stagedPath`. */
  pinned?: string;
  /** The build the pin names (per-build pins only). */
  pinnedBuild?: string;
  /** The baseline pins builds per arch (`nativeBuilds`) but none for this host's arch, so the version alone
   *  was matched. Set only on a resolved kind. */
  hostArchUnpinned?: { arch: string; pinnedArchs: string[] };
  /** The chosen version, when something was found. */
  found?: string;
  /** The chosen build (per-build candidates, or a flat one with a marker). */
  foundBuild?: string;
  /** The binary the resolver would run (every kind but `missing`). */
  path?: string;
  /** Same as `path` for the substitution kinds (`build`/`patch`/`major-minor`). */
  fallbackPath?: string;
  /** Layout of the chosen candidate. */
  layout?: "nested" | "flat";
  /** The chosen candidate's layout differs from the pin's (Desktop migrated it). */
  relocated?: boolean;
  /** A flat pin was relocated to a build, and the pinned flat file is still on disk (the two can differ). */
  pinnedFilePresent?: boolean;
  /** The pinned version dir is a symlink to a dir of ANOTHER name (that name, e.g. the version it links to). */
  pinnedLinkTarget?: string;
  /** Other builds of the chosen version that were NOT chosen (only for a choice the pin did not decide). */
  others?: string[];
  /** Descriptions of the pinned version's 12-hex dirs that are not runnable (kinds `patch`/`major-minor`). */
  pinnedUnusable?: string[];
  /** Why nothing was found (`missing` only). */
  cause?: "missing-root" | "missing" | "unfinished" | "unusable-build" | "unknown-layout";
  /** The `claude-code` dir scanned. */
  root?: string;
  /** Descriptions of every 12-hex dir that is not a runnable build (`missing` only). */
  unusable?: string[];
  unknownEntries?: string[];
}

/** Classify the native agent binary's staging drift against `baseline.agentBinary.nativeStagedPath`.
 *  See `NativeStagingDrift`. Read-only — does not touch env vars. */
export function classifyNativeStagingDrift(baseline: PlatformBaseline): NativeStagingDrift {
  const staged = (baseline.agentBinary?.nativeStagedPath ?? "").replace(/^~(?=$|\/)/, homedir());
  if (!staged) return { kind: "missing", cause: "missing", stagedPath: staged };
  const pin = parseNativeStagedPath(staged);
  if (!pin) {
    // Not a path in either layout (a hand-edited baseline): exact if it exists, nothing to scan otherwise.
    return existsSync(staged)
      ? { kind: "exact", stagedPath: staged, path: staged }
      : { kind: "missing", cause: "missing", stagedPath: staged };
  }
  const { root, version: pinned } = pin;
  // The build to hold the staged binary to. With a per-arch map (`nativeBuilds`), ONLY the host arch's entry
  // counts — the build in nativeStagedPath is the SYNCING machine's arch, which another arch never stages. No entry
  // for this arch: match by version, and say so. No map at all (every baseline before it existed): the build in
  // the path, as before.
  const hostArch = process.arch === "arm64" ? "arm64" : "x64";
  const builds = baseline.agentBinary?.nativeBuilds;
  const archs = builds ? (Object.keys(builds) as Array<"arm64" | "x64">).filter((k) => builds[k]) : [];
  const pinnedBuild = archs.length ? builds![hostArch] : pin.build;
  const hostArchUnpinned = archs.length && !pinnedBuild ? { hostArchUnpinned: { arch: hostArch, pinnedArchs: archs } } : {};
  const base = { stagedPath: staged, pinned, ...(pinnedBuild ? { pinnedBuild } : {}), root };
  const pinLayout = pin.build ? "nested" : "flat";
  const describe = (c: NativeCandidate, rest: NativeCandidate[]) => ({
    found: c.version,
    ...(c.build ? { foundBuild: c.build } : {}),
    path: c.path,
    layout: c.layout,
    ...(c.layout !== pinLayout ? { relocated: true } : {}),
    ...(rest.length ? { others: rest.map(buildLabel) } : {}),
  });

  const own = scanNativeVersion(root, pinned);
  // The pinned version dir is followed through a symlink, as Desktop follows it. When the link points at a
  // dir of another name, the binary that runs belongs to that version, so record it for the resolver's note.
  const linkTarget = pinnedVersionLinkTarget(join(root, pinned));
  const link = linkTarget && linkTarget !== pinned ? { pinnedLinkTarget: linkTarget } : {};
  if (own.candidates.length) {
    if (pinnedBuild) {
      const match =
        own.candidates.find((c) => c.layout === "nested" && c.build === pinnedBuild) ?? own.candidates.find((c) => c.build === pinnedBuild);
      if (match) return { kind: "exact", ...base, ...describe(match, []), ...link };
      const c = own.candidates[0];
      return { kind: "build", ...base, ...describe(c, own.candidates.slice(1)), fallbackPath: c.path };
    }
    const [c, ...rest] = own.candidates;
    const stillThere = c.layout === "nested" && pinLayout === "flat" && existsSync(staged);
    return {
      kind: "exact",
      ...base,
      ...describe(c, rest),
      ...(stillThere ? { pinnedFilePresent: true } : {}),
      ...link,
      ...hostArchUnpinned,
    };
  }

  if (!existsSync(root)) return { kind: "missing", cause: "missing-root", ...base };
  const all = stagedNativeVersions(root);
  const newest = all.find((v) => v.version !== pinned && v.scan.candidates.length);
  if (newest) {
    const [c, ...rest] = newest.scan.candidates;
    return {
      kind: isPatchBump(pinned, newest.version) ? "patch" : "major-minor",
      ...base,
      ...describe(c, rest),
      fallbackPath: c.path,
      ...(own.unusable.length ? { pinnedUnusable: own.unusable.map(describeUnusable) } : {}),
    };
  }
  // The pinned version's own scan counts too: when its dir is a symlink, the fallback list skips it.
  const others = all.filter((v) => v.version !== pinned);
  const unusable = [...own.unusable, ...others.flatMap((v) => v.scan.unusable)];
  const unknownEntries = [...own.unknown, ...others.flatMap((v) => v.scan.unknown)];
  const cause = unusable.length
    ? unusable.every((u) => u.reason === "unmarked")
      ? "unfinished"
      : "unusable-build"
    : unknownEntries.length
      ? "unknown-layout"
      : "missing";
  return {
    kind: "missing",
    cause,
    ...base,
    ...(unusable.length ? { unusable: unusable.map(describeUnusable) } : {}),
    ...(unknownEntries.length ? { unknownEntries } : {}),
  };
}

/** A resolver failure that carries WHY, so `doctor` can give the remedy for that cause. */
export class AgentBinaryError extends Error {
  constructor(
    message: string,
    readonly kind: string,
  ) {
    super(message);
    this.name = "AgentBinaryError";
  }
}

const ambiguityNote = (d: NativeStagingDrift) =>
  d.others?.length
    ? `${d.others.length + 1} builds of native agent ${d.found} are staged; the baseline does not pin one, so using ` +
      `${d.foundBuild ?? "the flat install"} (newest .verified, Desktop's own fallback order) over ${d.others.join(", ")}`
    : "";

/**
 * Resolve the host path to the staged NATIVE macOS agent binary (COWORK_HOST_AGENT_BINARY override >
 * baseline.agentBinary.nativeStagedPath, in either staging layout — see `classifyNativeStagingDrift`). This
 * is what hostloop spawns directly (no Docker) for the agent loop; the ELF (`resolveAgentBinary`) stays the
 * source of truth for container/microvm and for hostloop's bash/web_fetch VM sidecar image.
 *
 * A Claude Desktop update replaces the pinned version with another — since the native binary carries NO
 * sha256 pin (unlike the ELF), a same-major.minor PATCH difference is auto-tolerated by default (loud stderr
 * note, no env var needed). A major/minor drift, or a different build of a pinned build, needs
 * COWORK_HARNESS_ALLOW_AGENT_FALLBACK=1 or throws.
 */
export function resolveHostAgentBinary(baseline: PlatformBaseline): string {
  const override = process.env.COWORK_HOST_AGENT_BINARY;
  if (override) {
    if (!existsSync(override)) throw new AgentBinaryError(`COWORK_HOST_AGENT_BINARY not found: ${override}`, "override");
    return resolve(override);
  }
  const d = classifyNativeStagingDrift(baseline);
  const exactPath = d.stagedPath || "(unknown)";
  if (d.kind === "exact") {
    // The pinned flat file is still on disk, but a verified build of the same version wins (as it does for
    // Desktop, which does not run an unmarked flat install). The two files can differ, so say which one runs.
    if (d.pinnedLinkTarget)
      process.stderr.write(
        `cowork-harness: the pinned native agent version dir "${join(d.root!, d.pinned!)}" is a symlink to ${d.pinnedLinkTarget}; ` +
          `running the binary it holds, "${d.path}".\n`,
      );
    if (d.pinnedFilePresent)
      process.stderr.write(
        `cowork-harness: the pinned native agent "${d.stagedPath}" is present, but a verified build of ${d.found} is staged; ` +
          `running that build, "${d.path}".\n`,
      );
    if (d.hostArchUnpinned)
      process.stderr.write(
        `cowork-harness: the baseline pins no native build for ${d.hostArchUnpinned.arch} (only ${d.hostArchUnpinned.pinnedArchs.join(", ")}); ` +
          `matching ${d.found} by version — running build ${d.foundBuild ?? "(flat install)"}.\n`,
      );
    const amb = ambiguityNote(d);
    if (amb) process.stderr.write(`cowork-harness: ${amb}.\n`);
    return resolve(d.path!);
  }
  if (d.kind === "patch") {
    const amb = ambiguityNote(d);
    const why = d.pinnedUnusable?.length
      ? `${d.pinned} is staged but not runnable (${d.pinnedUnusable.join("; ")})`
      : `${d.pinned} is not staged`;
    const dir = cmpVersionStrings(d.found!, d.pinned!) > 0 ? "newer" : "older";
    process.stderr.write(
      `cowork-harness: pinned native agent ${why}; using patch-${dir} ` +
        `${d.found}${d.foundBuild && d.layout === "nested" ? ` (build ${d.foundBuild})` : ""} — behavior contract unchanged for a patch difference` +
        `${amb ? `; ${amb}` : ""}.\n`,
    );
    return resolve(d.path!);
  }
  if (d.kind === "build" || d.kind === "major-minor") {
    const what =
      d.kind === "build"
        ? d.foundBuild
          ? `baseline NATIVE agent ${d.pinned} build ${d.pinnedBuild} is not staged; ${d.found} is staged as build ${d.foundBuild} at "${d.path}" ` +
            `(a different build is a different binary — so is the same version's build for another CPU architecture)`
          : `baseline NATIVE agent ${d.pinned} build ${d.pinnedBuild} is not staged; ${d.found} is staged only as a flat install with no .verified ` +
            `marker at "${d.path}", so its build cannot be confirmed`
        : `baseline NATIVE agent binary not found: ${exactPath}; newest staged is ${d.found} at "${d.path}" (major/minor differs)`;
    if (process.env.COWORK_HARNESS_ALLOW_AGENT_FALLBACK === "1") {
      process.stderr.write(`cowork-harness: ${what}; COWORK_HARNESS_ALLOW_AGENT_FALLBACK=1 — falling back to "${d.path}".\n`);
      return resolve(d.path!);
    }
    throw new AgentBinaryError(
      `cowork-harness: ${what}. Set COWORK_HARNESS_ALLOW_AGENT_FALLBACK=1 to use the newest available, or COWORK_HOST_AGENT_BINARY=<path>.`,
      d.kind,
    );
  }
  const root = d.root ?? "(unknown)";
  const why =
    d.cause === "missing-root"
      ? `${root} does not exist, so no native agent is staged on this machine`
      : `no version under ${root} holds a binary at <ver>/claude.app/Contents/MacOS/claude or <ver>/<build>/claude.app/Contents/MacOS/claude` +
        (d.cause === "unfinished" || d.cause === "unusable-build"
          ? `; ${d.unusable!.join("; ")}`
          : d.cause === "unknown-layout"
            ? `; found ${d.unknownEntries!.join(", ")} — a staging layout this harness does not recognise`
            : "");
  throw new AgentBinaryError(
    `Staged NATIVE agent binary not found at "${exactPath}": ${why}. Set COWORK_HOST_AGENT_BINARY to the binary's path.`,
    d.cause ?? "missing",
  );
}

/** The build the asar's own SDK descriptor names for this host's native agent — Desktop's PRIMARY choice
 *  among several staged builds (`installDirFor(target, ver, expectedChecksum)`). Only meaningful for
 *  `version`: after an auto-update Desktop runs a fetched manifest the asar does not carry. */
export function nativeManifestBuild(
  channel: { baseUrl?: string; sdkVersion: string; nativeBuilds?: Partial<Record<string, string>> } | null | undefined,
  arch: string,
): { version: string; build: string } | undefined {
  const build = channel?.nativeBuilds?.[arch === "arm64" ? "darwin-arm64" : "darwin-x64"];
  return channel && build ? { version: channel.sdkVersion, build } : undefined;
}

/** `sync`'s next `agentBinary`: the base's hand-authored fields, overridden by what this sync re-derived. Two of the
 *  overrides are NEVER carried from the base and must be computed fresh every time: `nativeBuilds` (the native build
 *  per CPU arch, from this asar's SDK descriptor — a carried map would pin the previous version's builds beside a new
 *  path, and every hostloop host would then fail on `kind:"build"`) and `releaseBaseUrl` (a carried channel would hide
 *  a stable<->RC flip from `sync --diff`). `undefined` values are dropped by JSON.stringify, so a field this sync could
 *  not derive is absent from the written file rather than stale. Pure. */
export function buildNextAgentBinary(
  base: Record<string, unknown>,
  d: {
    stagedPath: string;
    nativeStagedPath: string;
    channel: { sdkVersion: string; nativeBuilds?: Partial<Record<string, string>> } | null | undefined;
    releaseBaseUrl: string | null | undefined;
    sha256?: string;
    shaProvenance?: string;
    manifestChecksumMatch?: boolean | "unknown";
    stringSentinels?: Record<string, number>;
  },
): Record<string, unknown> {
  return {
    ...base,
    stagedPath: d.stagedPath,
    nativeStagedPath: d.nativeStagedPath,
    nativeBuilds: nativeBuildsForPin(d.channel, d.nativeStagedPath),
    releaseBaseUrl: d.releaseBaseUrl ?? undefined,
    sha256: d.sha256,
    shaProvenance: d.shaProvenance,
    manifestChecksumMatch: d.manifestChecksumMatch,
    stringSentinels: d.stringSentinels,
  };
}

/** `sync`'s `agentBinary.nativeBuilds`: the asar SDK descriptor's darwin build per arch, recorded only when the
 *  descriptor is for the version `nativeStagedPath` pins (after an auto-update Desktop can run a version the asar
 *  does not describe, and another version's builds would be wrong for it). Undefined otherwise. Pure. */
export function nativeBuildsForPin(
  channel: { sdkVersion: string; nativeBuilds?: Partial<Record<string, string>> } | null | undefined,
  nativeStagedPath: string,
): { arm64?: string; x64?: string } | undefined {
  const version = parseNativeStagedPath(nativeStagedPath)?.version;
  if (!channel || !version || channel.sdkVersion !== version) return undefined;
  const out: { arm64?: string; x64?: string } = {};
  if (channel.nativeBuilds?.["darwin-arm64"]) out.arm64 = channel.nativeBuilds["darwin-arm64"];
  if (channel.nativeBuilds?.["darwin-x64"]) out.x64 = channel.nativeBuilds["darwin-x64"];
  return Object.keys(out).length ? out : undefined;
}

/**
 * `sync`'s derivation of `agentBinary.nativeStagedPath`. The native .app and the VM ELF version
 * INDEPENDENTLY (Desktop stages them on separate cadences), so this scans `claude-code/` for its OWN newest
 * staged version rather than reusing `agentVersion`, and writes the full path of the chosen candidate — in
 * whichever layout it is staged, so the path exists. Among several builds of that version it pins the one
 * the asar manifest names when the manifest is for that version, else the first in Desktop's fallback order.
 * Only when nothing is staged does it fall back to the `agentVersion`-derived flat-shape path (it cannot
 * invent a build) and warn. Pure apart from the read-only scan.
 */
export function deriveNativeStagedPath(a: {
  nativeRoot: string;
  homeDir: string;
  oldNativeStagedPath: string;
  agentVersion: string;
  manifestBuild?: { version: string; build: string };
}): { path: string; warnings: string[] } {
  const warnings: string[] = [];
  const tilde = (p: string) => (p.startsWith(a.homeDir) ? `~${p.slice(a.homeDir.length)}` : p);
  const versions = stagedNativeVersions(a.nativeRoot);
  const newest = versions.find((v) => v.scan.candidates.length);
  if (newest) {
    const cands = newest.scan.candidates;
    let chosen = cands[0];
    if (a.manifestBuild && a.manifestBuild.version === newest.version) {
      const named = cands.find((c) => c.build === a.manifestBuild!.build);
      if (named) chosen = named;
      else if (cands.length === 1 && chosen.build === undefined)
        // An unmarked flat install: its build is unknown, not different — nothing to warn about.
        warnings.push(
          `NOTE: the only staged install of native agent ${newest.version} is a flat install with no .verified marker, so its build is unknown ` +
            `(the asar manifest names ${a.manifestBuild.build}); pinning it.`,
        );
      else
        warnings.push(
          `WARNING: the asar manifest names native build ${a.manifestBuild.build} of ${newest.version}, which is not staged; ` +
            `pinning ${buildLabel(chosen)} (newest .verified).`,
        );
    } else if (cands.length > 1) {
      warnings.push(
        `NOTE: ${cands.length} builds of native agent ${newest.version} are staged; pinning ${buildLabel(chosen)} (newest .verified) ` +
          `over ${cands.slice(1).map(buildLabel).join(", ")}.`,
      );
    }
    return { path: tilde(resolve(chosen.path)), warnings };
  }
  const re = /claude-code\/[^/]+\/(?:[0-9a-fA-F]{12}\/)?claude\.app\/Contents\/MacOS\/claude$/;
  let path: string;
  if (re.test(a.oldNativeStagedPath)) {
    path = a.oldNativeStagedPath.replace(re, `claude-code/${a.agentVersion}/${NATIVE_LEAF}`);
  } else {
    path = `~/Library/Application Support/Claude/claude-code/${a.agentVersion}/${NATIVE_LEAF}`;
    if (a.oldNativeStagedPath)
      warnings.push(
        `WARNING: agentBinary.nativeStagedPath layout was unexpected ("${a.oldNativeStagedPath}") — rewrote to the canonical path for ${a.agentVersion}.`,
      );
  }
  const unusable = versions.flatMap((v) => v.scan.unusable).map(describeUnusable);
  warnings.push(
    `WARNING: derived agentBinary.nativeStagedPath does not exist on this machine: ${path}`,
    `  (No runnable native .app is staged under claude-code/ in either layout, <ver>/claude.app or <ver>/<build>/claude.app` +
      `${unusable.length ? `; ${unusable.join("; ")}` : ""}. Set COWORK_HOST_AGENT_BINARY=<path> to a staged binary or a saved copy of the .app.)`,
    `  resolveHostAgentBinary will fail until the file is present or COWORK_HOST_AGENT_BINARY is set.`,
  );
  return { path, warnings };
}

/**
 * Resolve a baseline by `latest`, an absolute path, or a name under `baselines/`. A non-absolute name
 * is treated as a BARE FILENAME resolved under BASELINES_DIR — both `desktop-x` and `desktop-x.json`
 * load from there regardless of cwd. A non-absolute name MUST NOT contain a path separator
 * (`safeNamedBaseline` rejects `../`, nested paths, and `../foo.json`). Use an absolute path for an
 * out-of-tree baseline (the explicit escape hatch).
 */
export function loadBaseline(name: string): PlatformBaseline {
  let file: string;
  if (name === "latest") file = latestBaselineFile();
  else {
    // A user-supplied name reaches here from every entry point (a CLI positional, a scenario's
    // `baseline:`, a matrix axis). One that names no baseline is the caller's mistake, so it throws a
    // UsageError listing the real ones rather than letting readFileSync's ENOENT escape as a stack trace.
    try {
      file = isAbsolute(name)
        ? name
        : // A named (non-absolute) baseline is a BARE FILENAME under BASELINES_DIR. Reject path
          // separators first: a name like `../../etc/hosts` or `../foo.json` (whose `.json` suffix
          // skips the append below) would otherwise read an arbitrary out-of-tree `.json`. Absolute
          // paths remain the explicit escape hatch (handled above).
          join(BASELINES_DIR, withJsonSuffix(safeNamedBaseline(name)));
    } catch (e) {
      throw unknownBaseline(name, (e as Error).message);
    }
    if (!existsSync(file)) throw unknownBaseline(name);
    // An absolute path is a file the USER supplied: every way it fails to load is their input error, stated
    // in one line. A committed NAME that fails to load is a packaging bug and keeps failing as one (below).
    if (isAbsolute(name)) return loadBaselineFile(file);
  }
  const raw = JSON.parse(readFileSync(file, "utf8"));
  return PlatformBaseline.parse(raw);
}

function loadBaselineFile(file: string): PlatformBaseline {
  const bad = (why: string) =>
    new BaselineFileError(
      file,
      `baseline file at "${file}" ${why} — a baseline is \`latest\`, a committed name like desktop-<version>, or an absolute path to a baseline file`,
    );
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw bad(
      code === "EISDIR" ? "is a directory" : code === "EACCES" || code === "EPERM" ? "is not readable" : `cannot be read (${code})`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw bad(`does not load: not valid JSON (${(e as Error).message.split("\n")[0]})`);
  }
  try {
    return PlatformBaseline.parse(raw);
  } catch (e) {
    if (e instanceof ZodError) throw bad(`does not load: not a platform baseline (${compactSchemaError(e.issues)})`);
    throw e;
  }
}

function unknownBaseline(name: string, reason?: string): UnknownBaselineError {
  let names: string[] = [];
  try {
    names = listBaselineNames();
  } catch {
    /* no baselines dir: the hint says so */
  }
  const what = isAbsolute(name) ? `no baseline file at "${name}"` : `no baseline named "${name}"`;
  return new UnknownBaselineError(
    name,
    `${what}${reason ? ` (${reason})` : ""} — a baseline is \`latest\`, a committed name like desktop-<version>, or an absolute path to a baseline file`,
    names.length ? `valid baselines (newest first): ${names.join(", ")}` : `no committed baselines in ${BASELINES_DIR}`,
  );
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

/** The committed platform baselines by name (`desktop-<version>`, no `.json`), newest first. */
export function listBaselineNames(): string[] {
  return readdirSync(BASELINES_DIR)
    .filter((f) => f.startsWith("desktop-") && f.endsWith(".json"))
    .sort(compareBaselineVersions)
    .reverse()
    .map((f) => f.replace(/\.json$/, ""));
}

function latestBaselineFile(): string {
  const files = readdirSync(BASELINES_DIR).filter((f) => f.startsWith("desktop-") && f.endsWith(".json"));
  if (files.length === 0) throw new Error(`No baselines in ${BASELINES_DIR}; run \`cowork-harness sync\` first.`);
  // Use numeric/semver-aware sort so desktop-1.10.json > desktop-1.9.json (not lexical).
  files.sort(compareBaselineVersions);
  return join(BASELINES_DIR, files[files.length - 1]);
}

/** The one segment the harness's staged session tree always adds under the session root. Every stager
 *  and every argv builder composes guest paths with it (`stage.ts`/`hostloop-stage.ts` create
 *  `<sessionHost>/mnt`, `dockerRunArgv` nests `:ro` binds at `<sessionRoot>/mnt/<mountPath>`), so a
 *  guest mnt root that is anything OTHER than `<sessionRoot>/mnt` cannot be produced. */
export const GUEST_MNT_SEGMENT = "mnt";

/**
 * Expand the mount layout for a concrete session id — the layout of the tree THIS HARNESS stages, which
 * is what every guest path must be built from.
 *
 * `mntRoot` is DERIVED as `<sessionRoot>/mnt`, not read from `mountLayout.mntRoot`: the staged tree can
 * only ever be there (see GUEST_MNT_SEGMENT), so honouring a recorded value that says otherwise emits
 * guest paths pointing at directories no stager creates. A baseline recording a different mnt root is a
 * FIDELITY divergence, surfaced by `recordedLayoutDivergence` at spawn, never a path this builds.
 *
 * Guest paths anchor on `sessionRoot` (the bind target), never on `cwd`: production's own working dir is
 * a folder mount or `outputs` rather than the bare session root, so the two are not interchangeable even
 * though every synced baseline currently records them equal. `cwd` is the agent's working directory and
 * nothing else.
 */
export function resolveMounts(baseline: PlatformBaseline, sessionId: string, projectId = "proj1") {
  const subst = (s: string) => s.replace("{sessionId}", sessionId).replace("{projectId}", projectId);
  const cwd = subst(baseline.mountLayout.cwd);
  const sessionRoot = subst(baseline.mountLayout.sessionRoot);
  const mntRoot = `${sessionRoot}/${GUEST_MNT_SEGMENT}`;
  return { cwd, sessionRoot, mntRoot };
}

/** Does this baseline RECORD a guest layout the harness cannot stage? Reads the recorded fields only
 *  (never the derived ones), so it stays a statement about the data: a `mntRoot` that is not
 *  `<sessionRoot>/mnt`, or a `sessionRoot` that already ends in the mnt segment — the shape that made
 *  `resolveMounts` return a root one level above the staged tree. Returns the divergence for the caller
 *  to surface, or undefined when the recording is reproducible. */
export function recordedLayoutDivergence(baseline: PlatformBaseline): { recorded: string; staged: string } | undefined {
  // Read STRUCTURALLY: a partially-constructed baseline (`{ spawn: {} }`) is normal at the argv seam, and
  // this check must never be the thing that throws there. No recorded layout ⇒ nothing to diverge from.
  const { sessionRoot, mntRoot } = (baseline as Partial<PlatformBaseline>).mountLayout ?? {};
  if (typeof sessionRoot !== "string") return undefined;
  const staged = `${sessionRoot}/${GUEST_MNT_SEGMENT}`;
  if (mntRoot !== undefined && mntRoot !== staged) return { recorded: mntRoot, staged };
  if (sessionRoot.endsWith(`/${GUEST_MNT_SEGMENT}`)) return { recorded: sessionRoot, staged };
  return undefined;
}

export const PLUGIN_PATH_VM_REWRITE_MIN_VERSION = "";
