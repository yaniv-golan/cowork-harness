import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, isAbsolute, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { PlatformBaseline } from "./types.js";
import { safeNamedBaseline } from "./boundary-paths.js";

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

/** Resolve the host path to the staged agent ELF (COWORK_AGENT_BINARY override > baseline.stagedPath). */
export function resolveAgentBinary(baseline: PlatformBaseline): string {
  const override = process.env.COWORK_AGENT_BINARY;
  if (override) {
    if (!existsSync(override)) throw new Error(`COWORK_AGENT_BINARY not found: ${override}`);
    return resolve(override);
  }
  const staged = (baseline.agentBinary?.stagedPath ?? "").replace(/^~(?=$|\/)/, homedir());
  if (staged && existsSync(staged)) return resolve(staged);
  // The baseline's exact version dir is gone (e.g. Claude Desktop updated).
  // By default this is a hard failure — a different agent version can silently change behavior.
  // Set COWORK_HARNESS_ALLOW_AGENT_FALLBACK=1 to opt in to using the newest sibling binary.
  const exactPath = staged || "(unknown)";
  const fallback = staged ? newestStagedBinary(staged) : undefined;
  if (fallback && process.env.COWORK_HARNESS_ALLOW_AGENT_FALLBACK === "1") {
    process.stderr.write(`cowork-harness: staged agent binary "${staged}" not found; ` + `falling back to newest sibling "${fallback}".\n`);
    return fallback;
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
  const root = dirname(dirname(stagedPath)); // .../claude-code-vm
  if (!existsSync(root)) return undefined;
  // Numeric/semver-aware sort matching compareBaselineVersions: parseInt each dot-segment, NaN→0.
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
    dirs = readdirSync(root);
  } catch {
    return undefined;
  }
  const versions = dirs.filter((d) => existsSync(join(root, d, "claude"))).sort(cmp);
  if (versions.length === 0) return undefined;
  return resolve(join(root, versions[versions.length - 1], "claude"));
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
