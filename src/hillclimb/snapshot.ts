// The plugin a variant runs, frozen on the variant's first run. The loop edits the live plugin every round, so
// a variant's later runs — a resume after an interruption, reps appended to tighten its interval
// (eval-hillclimb.md l.275) — must run from what the variant WAS, never from the live dir.
//
// Snapshots live outside any git work tree: the stager delivers a mount's git-tracked files only, so a copy
// inside a work tree would mount empty (eval's rule, src/eval/snapshot.ts). The copy is written to a temp
// dir, renamed into place and then marked complete, so an interrupted copy is never used.

import { randomBytes, createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { UsageError } from "../errors.js";
import { tildeify } from "../io.js";
import { isInsideGitWorkTree, snapshotDirArm } from "../eval/snapshot.js";

export interface VariantSnapshot {
  dir: string;
  created: boolean;
  /** The live plugin no longer matches the snapshot (a file changed or went away). */
  liveDiffers: boolean;
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
  opts: { snapshotRoot: string; flowHash: string; variant: string; variantRan?: boolean },
): VariantSnapshot {
  if (isInsideGitWorkTree(opts.snapshotRoot))
    throw new UsageError(
      `the snapshot dir ${tildeify(opts.snapshotRoot)} is inside a git work tree: the stager delivers a mount's git-tracked files only, so the variant's plugin would mount EMPTY`,
    );
  const dir = join(opts.snapshotRoot, opts.flowHash, opts.variant, basename(live));
  const marker = `${dir}.complete`;
  if (existsSync(dir) && existsSync(marker)) {
    const rels = files(dir);
    return { dir, created: false, liveDiffers: digest(dir, rels) !== digest(live, rels) };
  }
  if (opts.variantRan) {
    if (existsSync(dir))
      throw new UsageError(
        `variant ${opts.variant}'s plugin snapshot at ${tildeify(dir)} is incomplete (an interrupted copy): it cannot be trusted, and the live plugin may already hold a later round — re-run this variant into a fresh flow`,
      );
    throw new UsageError(
      `variant ${opts.variant} already has rows, but its plugin snapshot ${tildeify(dir)} is missing: running it now would measure the live plugin, which may hold a later round — restore the snapshot or re-run this variant into a fresh flow`,
    );
  }
  rmSync(dir, { recursive: true, force: true }); // an interrupted copy of a variant that never ran
  const tmp = `${dir}.tmp-${randomBytes(6).toString("hex")}`;
  try {
    snapshotDirArm(live, tmp, false, `variant ${opts.variant}`);
    renameSync(tmp, dir);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  writeFileSync(marker, new Date().toISOString() + "\n");
  return { dir, created: true, liveDiffers: false };
}
