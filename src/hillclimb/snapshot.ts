// The plugin a variant runs, frozen on the variant's first run. The loop edits the live plugin every round, so
// a variant's later runs — a resume after an interruption, reps appended to tighten its interval
// (eval-hillclimb.md l.275) — must run from what the variant WAS, never from the live dir.
//
// Snapshots live outside any git work tree: the stager delivers a mount's git-tracked files only, so a copy
// inside a work tree would mount empty (eval's rule, src/eval/snapshot.ts). The copy is written to a temp
// dir, renamed into place and then marked complete, so an interrupted copy is never used.

import { randomBytes, createHash } from "node:crypto";
import { InterruptedError } from "../termination.js";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { UsageError } from "../errors.js";
import { tildeify } from "../io.js";
import { isInsideGitWorkTree, snapshotDirArm } from "../eval/snapshot.js";
import { gitModeEnabled, gitStageStats } from "../run/skill-files.js";

/** Relocates the snapshot root (default `~/.cowork-harness/hillclimb-snapshots`); an absolute path. */
export const SNAPSHOT_ROOT_ENV = "COWORK_HARNESS_HILLCLIMB_SNAPSHOTS";

export interface VariantSnapshot {
  dir: string;
  created: boolean;
  /** The live plugin no longer matches the snapshot (a file a new snapshot would copy changed, came or went). */
  liveDiffers: boolean;
  /** On a snapshot taken now: untracked files of the live plugin left out (the stager delivers tracked files only). */
  untrackedExcluded?: number;
}

function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

/** The files a snapshot taken now would copy: the git-tracked set inside a work tree (the stager's delivery rule,
 *  as snapshotDirArm applies it), every file otherwise. Comparing a raw walk with a tracked-only snapshot would
 *  call any untracked or ignored file a difference. */
function deliverable(live: string): string[] {
  if (gitModeEnabled()) {
    const { tracked } = gitStageStats(live);
    if (tracked) return [...tracked];
  }
  return files(live);
}

const digest = (dir: string, rels: readonly string[]): string => {
  const h = createHash("sha256");
  for (const r of rels) {
    h.update(r).update("\0");
    const p = join(dir, r);
    h.update(existsSync(p) && statSync(p).isFile() ? readFileSync(p) : "<absent>").update("\0");
  }
  return h.digest("hex");
};

export function variantSnapshot(
  live: string,
  opts: { snapshotRoot: string; flowHash: string; variant: string; variantRan?: boolean; checkOnly?: boolean },
): VariantSnapshot {
  let inGit: boolean;
  try {
    inGit = isInsideGitWorkTree(opts.snapshotRoot);
  } catch (e) {
    if (e instanceof InterruptedError) throw e;
    // eval's message names eval's --out; here the root comes from the environment.
    throw new UsageError(
      `${(e as Error).message.replace(/; pass --out <dir> .*$/, "")}; set ${SNAPSHOT_ROOT_ENV} to an absolute directory git can answer for`,
    );
  }
  if (inGit)
    throw new UsageError(
      `the snapshot dir ${tildeify(opts.snapshotRoot)} is inside a git work tree: the stager delivers a mount's git-tracked files only, so the variant's plugin would mount EMPTY; set ${SNAPSHOT_ROOT_ENV} to an absolute directory outside any git work tree`,
    );
  const dir = join(opts.snapshotRoot, opts.flowHash, opts.variant, basename(live));
  const marker = `${dir}.complete`;
  if (existsSync(dir) && existsSync(marker)) {
    // Over both trees, so a file added to the live plugin counts as a difference too.
    const rels = [...new Set([...files(dir), ...deliverable(live)])].sort();
    const liveDiffers = digest(dir, rels) !== digest(live, rels);
    // A variant with no rows has measured nothing yet: its snapshot (left by a refused run) is re-taken
    // when the live plugin moved on, or the pass would measure an older round under this variant's name (a dry run
    // falls through to check the live plugin that pass would copy).
    if (opts.variantRan || !liveDiffers) return { dir, created: false, liveDiffers };
  }
  if (opts.variantRan) {
    if (existsSync(dir))
      throw new UsageError(
        `variant ${opts.variant}'s plugin snapshot at ${tildeify(dir)} is incomplete (an interrupted copy): it cannot be trusted, and the live plugin may already hold a later round — re-run this variant into a fresh flow`,
      );
    throw new UsageError(
      `variant ${opts.variant} already has rows, but its plugin snapshot ${tildeify(dir)} is missing: running it now would measure the live plugin, which may hold a later round. Snapshots are kept per flow dir path, so a flow dir copied or moved keeps its rows but not its snapshots. Restore the snapshot, re-run this variant into a fresh flow, or run a new variant instead (approve the harness through it: \`--dry-run --approve-harness --variant v<N>\`)`,
    );
  }
  // A dry run checks what a pass would refuse, and stops before writing: the pass would take (or re-take) a snapshot
  // of the live plugin, so the dry run checks that plugin.
  if (opts.checkOnly) return { dir: live, created: false, liveDiffers: false };
  rmSync(marker, { force: true }); // first: a crash mid-replace must not leave a marker vouching for it
  rmSync(dir, { recursive: true, force: true }); // an interrupted or outdated copy of a variant that never ran
  const tmp = `${dir}.tmp-${randomBytes(6).toString("hex")}`;
  let untrackedExcluded = 0;
  try {
    try {
      untrackedExcluded = snapshotDirArm(live, tmp, false, `variant ${opts.variant}`).untrackedExcluded;
    } catch (e) {
      // eval's refusal names eval's flags (--arm, --include-untracked); say it in this command's terms.
      if (e instanceof UsageError)
        throw new UsageError(
          e.message
            .replace(/^--arm [^:]*: /, `variant ${opts.variant}'s plugin: `)
            .replace(/, or pass --include-untracked/, "")
            .replace(/this arm/, "the plugin"),
          e.hint,
        );
      throw e;
    }
    renameSync(tmp, dir);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  writeFileSync(marker, new Date().toISOString() + "\n");
  return { dir, created: true, liveDiffers: false, untrackedExcluded };
}
