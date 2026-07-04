import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
  let paths: string[];
  if (tier === "hostloop") {
    paths = [
      ...collectArtifacts(workRoot, ["outputs"], WALK).map((a) => a.path),
      ...folderMounts.flatMap((m) => collectArtifactsAt(m.hostPath, m.mountPath, WALK)),
    ].sort();
  } else {
    paths = collectArtifacts(workRoot, userVisibleRootsFromPlan(plan), WALK)
      .map((a) => a.path)
      .sort();
  }
  writeFileSync(join(outDir, FILE), JSON.stringify({ paths }, null, 2));
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
