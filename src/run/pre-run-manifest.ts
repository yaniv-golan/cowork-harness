import { writeFileSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { userVisibleRootsFromPlan, type LaunchPlan } from "../session.js";
import { collectArtifacts, collectArtifactsAt } from "./artifacts.js";

// Written at outDir/ — ABOVE workRoot (work/ at protocol, work/session/mnt elsewhere), the same
// placement rule as the `.origin` marker, so it is structurally invisible to collectArtifacts /
// file_exists / user_visible_artifact and can never contaminate its own diff.
const FILE = "pre-run-manifest.json";

// The baseline is paths-only (no content is ever read into it), so the hardlink content-escape
// guard doesn't apply — and MUST be lifted: the post-run side walks a cpSync copy where every file
// is nlink=1, so a pre-existing hardlinked file skipped here would diff as agent-"created".
const WALK: { includeHardlinkPaths: true } = { includeHardlinkPaths: true };

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
  const add = (relPath: string, baseDir: string) => {
    paths.push(relPath);
    hashes[relPath] = hashFileCapped(baseDir, relPath, cap);
  };
  if (tier === "hostloop") {
    for (const a of collectArtifacts(workRoot, ["outputs"], WALK)) add(a.path, workRoot);
    for (const m of folderMounts) {
      // collectArtifactsAt returns mountPath-prefixed paths; the real bytes live under hostPath at the
      // path with the mountPath prefix stripped (leading "<mountPath>/" removed).
      for (const p of collectArtifactsAt(m.hostPath, m.mountPath, WALK)) {
        const rel = p === m.mountPath ? "" : p.slice(m.mountPath.length + 1);
        paths.push(p);
        hashes[p] = hashFileCapped(m.hostPath, rel, cap);
      }
    }
    paths.sort();
  } else {
    for (const a of collectArtifacts(workRoot, userVisibleRootsFromPlan(plan), WALK)) add(a.path, workRoot);
    paths.sort();
  }
  writeFileSync(join(outDir, FILE), JSON.stringify({ paths, hashes }, null, 2));
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
