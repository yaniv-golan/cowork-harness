import { dirname, sep } from "node:path";
import type { CaptureAuthoredFilesOpts } from "./artifacts.js";
import { readPreRunManifestStats } from "./pre-run-manifest.js";

/**
 * The option set for the authored-file capture a semantic judge grades — ONE derivation shared by the live
 * run (execute.ts) and the kept-run context builder (verify-context.ts), so a re-grade walks the same tree
 * with the same budget the live judge's capture did.
 *
 * `scratchpadRoot` is the parent of a `…/mnt` work root (the session root, where a relative shell write
 * lands); `preRunStats` is read from the run dir's pre-run manifest. The remaining fields are passed only
 * when given (`priorityGlobs` only when non-empty), so an absent one leaves the capture's own default.
 */
export function authoredCaptureOpts(a: {
  workRoot: string;
  /** The run dir holding `pre-run-manifest.json`. */
  runDir: string;
  resume?: boolean;
  priorityGlobs?: string[];
  totalBytes?: number;
  perFileBytes?: number;
}): CaptureAuthoredFilesOpts {
  return {
    scratchpadRoot: a.workRoot.endsWith(`${sep}mnt`) ? dirname(a.workRoot) : undefined,
    ...(a.resume !== undefined ? { resume: a.resume } : {}),
    // Pre-run mtime/size lets an over-cap/unreadable prior file (hash === null) be positively confirmed
    // UNCHANGED rather than either mis-attributed as authored or silently dropped from evidence.
    preRunStats: readPreRunManifestStats(a.runDir),
    ...(a.priorityGlobs?.length ? { priorityGlobs: a.priorityGlobs } : {}),
    ...(a.totalBytes !== undefined ? { totalBytes: a.totalBytes } : {}),
    ...(a.perFileBytes !== undefined ? { perFileBytes: a.perFileBytes } : {}),
  };
}
