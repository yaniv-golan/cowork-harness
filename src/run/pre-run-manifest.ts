import { writeFileSync, readFileSync, statSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { userVisibleRootsFromPlan, type LaunchPlan } from "../session.js";
import { collectArtifactPaths, collectArtifactPathsAt } from "./artifacts.js";

// Written at outDir/ — ABOVE workRoot (work/ at protocol, work/session/mnt elsewhere), the same
// placement rule as the `.origin` marker, so it is structurally invisible to collectArtifacts /
// file_exists / user_visible_artifact and can never contaminate its own diff.
const FILE = "pre-run-manifest.json";

// The baseline uses the PATHS+LINK-KIND walk (collectArtifactPaths): it emits symlink and hardlink
// paths (the content walk skips them), so a pre-existing link appears in the baseline and is not later
// flagged as an agent-"created" stray by no_unexpected_files. Link entries are path-only — never hashed
// or dereferenced — so a symlink/hardlink target's (possibly out-of-root) content is never read.

/** Per-file size cap for pre-run hashing: files larger than this record sha256:null (evidence-
 *  unavailable for that path under input_unmodified), keeping the pre-run walk bounded on big
 *  connected folders. Default 50 MiB; override with COWORK_HARNESS_PRERUN_HASH_CAP (positive int bytes).
 *  Deliberately separate from the artifact BODY cap (COWORK_HARNESS_MAX_ARTIFACT_BYTES) — different concern. */
function preRunHashCap(): number {
  const env = process.env.COWORK_HARNESS_PRERUN_HASH_CAP;
  if (env === undefined || env === "") return 50 * 1024 * 1024;
  const n = Number(env);
  if (!Number.isInteger(n) || n <= 0)
    throw new Error(`COWORK_HARNESS_PRERUN_HASH_CAP must be a positive integer (got ${JSON.stringify(env)})`);
  return n;
}

/** Hash one captured file relative to its base dir. Returns null over the cap (recorded, not hashed);
 *  null on an unreadable file too (loud evidence-unavailable downstream, never a silent pass). The size
 *  is checked with statSync BEFORE reading, so an over-cap file is never loaded into memory — that is
 *  what actually bounds the walk on big connected folders (a post-read length check would still read
 *  the whole file first). */
function hashFileCapped(baseDir: string, relPath: string, cap: number): string | null {
  const abs = join(baseDir, relPath);
  try {
    if (statSync(abs).size > cap) return null;
    return createHash("sha256").update(readFileSync(abs)).digest("hex");
  } catch {
    return null;
  }
}

/** Per-file mtime+size at capture time — metadata-only (no content read, no cap needed: statSync is
 *  O(1) regardless of file size). This is what lets a later diff distinguish "the agent wrote this" from
 *  "something external touched it between capture and the post-run read" for the SAME path — the hash
 *  alone can't do that (a hash mismatch says content changed, not who/when). Null on an unreadable file
 *  (race with a delete mid-walk, or a permissions error) — absence, not a fabricated zero. */
function statCapture(baseDir: string, relPath: string): { mtimeMs: number; size: number } | null {
  try {
    const st = statSync(join(baseDir, relPath));
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

/** Snapshot the user-visible roots' file paths AFTER staging, BEFORE the agent spawns — the
 *  baseline `no_unexpected_files` diffs against (new-files-only semantic). Hostloop folders are
 *  bind-mounted live host paths (never staged): walk each folder SOURCE mapped to its mountPath,
 *  mirroring snapshotHostLoopWorkspace's post-run copy so pre/post path spaces line up. NOTE the
 *  hostloop residual: the walk reads the LIVE folder at spawn time, so a user mutating the folder
 *  mid-run shifts the diff — the same exposure the post-run snapshot already has.
 *
 *  Runs only when `plan.capturePreRun` is set (the scenario asserts the key, or the run is a
 *  recording) — the walk has a real cost on big connected folders, and a run that never consumes
 *  the baseline shouldn't pay it. Absence stays loud: the assertion fails evidence-unavailable.
 *
 *  NEVER captures on `--resume`: the persisted tree already contains the PRIOR turn's outputs, so a
 *  late capture would absorb run-1's files (strays included) into the baseline. If run 1 wrote a
 *  manifest it stays authoritative ("state before run 1"); if it didn't (run 1 predates the seam),
 *  the manifest stays absent and the key fails loud evidence-unavailable — never a shifted baseline.
 *
 *  microvm does NOT call this: it stages into VM_WORK_HOST/<id>/mnt, a different tree from the
 *  outDir/work/session/mnt the post-run walk reads (a pre-existing artifact-collection gap), so a
 *  pre/post diff there would be vacuously empty — a silent false-green. No manifest ⇒ the
 *  assertion fails LOUD as evidence-unavailable at that tier instead. */
export function capturePreRunManifest(plan: LaunchPlan, workRoot: string, outDir: string, tier: string): void {
  if (!plan.capturePreRun || plan.resume) return;
  const folderMounts = plan.mounts.filter((m) => m.kind === "folder");
  const cap = preRunHashCap();
  const paths: string[] = [];
  const hashes: Record<string, string | null> = {};
  const stats: Record<string, { mtimeMs: number; size: number } | null> = {};
  // SYMLINK entries are recorded path-only: they go into `paths` (so no_unexpected_files's baseline
  // includes them) but NOT into `hashes`/`stats` — a symlink has no protectable content and hashing would
  // DEREFERENCE the target (potentially reading out-of-root content). HARDLINK entries ARE hashed like a
  // regular file: a hardlink is a real inode with content at an in-root path (readFileSync reads it
  // directly, no symlink following), so dropping it would silently strip a pre-existing hardlinked input
  // (e.g. pnpm / `cp -l` trees on a hostloop folder mount) from input_unmodified's coverage — a vacuous
  // pass where a real content check belongs.
  const add = (relPath: string, baseDir: string, linkKind?: "symlink" | "hardlink") => {
    paths.push(relPath);
    if (linkKind === "symlink") return;
    hashes[relPath] = hashFileCapped(baseDir, relPath, cap);
    stats[relPath] = statCapture(baseDir, relPath);
  };
  // Tracks whether any connected-folder source was unreadable during the walk (its baseline entries are
  // then silently absent). Surfaced via the manifest `origin` so no_unexpected_files / input_unmodified
  // fail evidence-unavailable rather than diffing against a false-empty baseline. #38
  let baselineUnreadable = false;
  if (tier === "hostloop") {
    for (const e of collectArtifactPaths(workRoot, ["outputs"])) add(e.path, workRoot, e.linkKind);
    for (const m of folderMounts) {
      try {
        realpathSync(m.hostPath);
      } catch {
        // The connected-folder source vanished/became unreadable — collectArtifactPathsAt would return
        // [] silently, yielding a false-empty baseline for this mount. Mark it and skip. #38
        baselineUnreadable = true;
        continue;
      }
      // collectArtifactPathsAt returns mountPath-prefixed paths; the real bytes live under hostPath at the
      // path with the mountPath prefix stripped (leading "<mountPath>/" removed).
      for (const e of collectArtifactPathsAt(m.hostPath, m.mountPath)) {
        paths.push(e.path);
        if (e.linkKind === "symlink") continue; // symlink: path-only, never hashed/dereferenced (hardlink IS hashed)
        const rel = e.path === m.mountPath ? "" : e.path.slice(m.mountPath.length + 1);
        hashes[e.path] = hashFileCapped(m.hostPath, rel, cap);
        stats[e.path] = statCapture(m.hostPath, rel);
      }
    }
    paths.sort();
  } else {
    for (const e of collectArtifactPaths(workRoot, userVisibleRootsFromPlan(plan))) add(e.path, workRoot, e.linkKind);
    paths.sort();
  }
  // origin of the pre-run baseline. "local-walk" = the filesystem was walked locally by this function.
  // "local-unreadable" = a connected-folder source was unreadable so the baseline is incomplete.
  // "remote-unavailable" is RESERVED for a future cloud run whose filesystem is not locally observable.
  // Both non-"local-walk" values make no_unexpected_files / input_unmodified fail EVIDENCE-UNAVAILABLE
  // (see the assert.ts guard clauses) — never a vacuous pass on an incomplete/unwalkable tree.
  const origin = baselineUnreadable ? "local-unreadable" : "local-walk";
  writeFileSync(
    join(outDir, FILE),
    JSON.stringify({ version: MANIFEST_VERSION, origin, paths, hashes, stats }, null, 2),
  );
}

// Pre-run manifest format version. v2 = the LINK-AWARE walk (paths includes symlink/hardlink entries).
// ABSENT (or < 2) = a pre-#38 manifest captured with the symlink-skipping content walk. `no_unexpected_files`
// on `verify-run`/`--resume` of such an old run dir must NOT flag its pre-existing symlinks as strays (the
// baseline never listed them) — it compares on the same links-blind basis. See `readPreRunManifestLinkAware`.
const MANIFEST_VERSION = 2;

/** True iff the on-disk pre-run manifest was captured with the link-aware walk (v2+). Absent/older ⇒ false
 *  ⇒ `no_unexpected_files` excludes link entries from the post walk so a pre-existing symlink on a
 *  pre-upgrade run dir is not a false stray. */
export function readPreRunManifestLinkAware(outDir: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(join(outDir, FILE), "utf8")) as { version?: unknown };
    return typeof parsed.version === "number" && parsed.version >= 2;
  } catch {
    return false;
  }
}

/** undefined = no manifest (an older kept run, a run that didn't capture, or a tier that can't —
 *  microvm) — the assertion then fails evidence-unavailable rather than vacuously passing. */
export function readPreRunManifest(outDir: string): string[] | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(outDir, FILE), "utf8")) as { paths?: unknown };
    return Array.isArray(parsed.paths) && parsed.paths.every((p) => typeof p === "string") ? parsed.paths : undefined;
  } catch {
    return undefined;
  }
}

/** The per-path sha256 map from the pre-run manifest (value null = over-cap / unreadable at capture).
 *  undefined = no manifest, or a manifest with no hashes field (an older run) — input_unmodified then
 *  fails evidence-unavailable rather than vacuously passing. */
export function readPreRunManifestHashes(outDir: string): Record<string, string | null> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(outDir, FILE), "utf8")) as { hashes?: unknown };
    if (parsed.hashes === null || typeof parsed.hashes !== "object" || Array.isArray(parsed.hashes)) return undefined;
    const h = parsed.hashes as Record<string, unknown>;
    for (const v of Object.values(h)) if (v !== null && typeof v !== "string") return undefined;
    return h as Record<string, string | null>;
  } catch {
    return undefined;
  }
}

/** The per-path {mtimeMs, size} map from the pre-run manifest (value null = unreadable at capture).
 *  undefined = no manifest, or a manifest predating this field (an older run) — a caller that needs it to
 *  distinguish an agent write from an externally-mutated path must treat undefined as evidence-unavailable
 *  for that distinction, same convention as `readPreRunManifestHashes`. */
export function readPreRunManifestStats(outDir: string): Record<string, { mtimeMs: number; size: number } | null> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(outDir, FILE), "utf8")) as { stats?: unknown };
    if (parsed.stats === null || typeof parsed.stats !== "object" || Array.isArray(parsed.stats)) return undefined;
    const s = parsed.stats as Record<string, unknown>;
    for (const v of Object.values(s)) {
      if (v === null) continue;
      if (typeof v !== "object" || typeof (v as any).mtimeMs !== "number" || typeof (v as any).size !== "number") return undefined;
    }
    return s as Record<string, { mtimeMs: number; size: number } | null>;
  } catch {
    return undefined;
  }
}

/** The manifest's provenance ("local-walk" today; "remote-unavailable" is RESERVED for a future cloud
 *  producer — see the write-site comment in capturePreRunManifest). undefined = no manifest, an older
 *  manifest predating this field, or a value that isn't one of the two known literals — callers must
 *  NOT treat undefined as "local-walk"; forward-compat callers should treat an unrecognized value the
 *  same conservative way they treat an absent manifest (evidence-unavailable), never assume it's safe. */
export function readPreRunManifestOrigin(outDir: string): "local-walk" | "remote-unavailable" | "local-unreadable" | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(outDir, FILE), "utf8")) as { origin?: unknown };
    return parsed.origin === "local-walk" || parsed.origin === "remote-unavailable" || parsed.origin === "local-unreadable"
      ? parsed.origin
      : undefined;
  } catch {
    return undefined;
  }
}
