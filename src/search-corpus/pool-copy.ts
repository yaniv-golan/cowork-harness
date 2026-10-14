/**
 * The private copy of a pinned pool that eval and hillclimb serve every rep from, so an edit to the source pool
 * mid-run cannot reach a later rep. Written through a no-follow root: a temp dir beside the destination, both files
 * created new, the copy verified, then renamed into place without replacing anything. Concurrent passes on one pool
 * share one copy: the loser of the rename verifies and reuses the winner's. An existing copy is verified before
 * reuse and never rewritten.
 */

import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { NoFollowRoot } from "../hillclimb/fs.js";
import { effectivePool, PoolBuildError, readPool, type PoolManifest } from "./pool.js";

export interface PoolCopy {
  dir: string;
  manifest: PoolManifest;
  /** The effective hash a rep is pinned to (`--search-corpus-min-score` included). */
  sha256: string;
  /** False when an existing copy (another pass's, or an earlier one) was verified and reused. */
  created: boolean;
}

/** Test seam: runs between the temp copy's verification and its rename, the window two passes race in. */
export const poolCopyHooks: { beforeRename?: (dest: string) => void } = {};

function verified(dir: string, minScore: number | undefined, want: string): { manifest: PoolManifest; sha256: string } {
  const p = effectivePool(dir, minScore);
  if (p.sha256 !== want)
    throw new PoolBuildError(
      `the search pool copy at ${dir} does not match its source (found ${p.sha256.slice(0, 8)}, expected ${want.slice(0, 8)}); delete it and re-run`,
    );
  return { manifest: p.manifest, sha256: p.sha256 };
}

/** Copy the pool at `src` to `dest` (a dir named for the pool's identity hash) under `root`. */
export function copyPinnedPool(root: NoFollowRoot, src: string, dest: string, minScore: number | undefined): PoolCopy {
  const source = effectivePool(src, minScore);
  const reuse = (): PoolCopy => {
    root.assertIn(dest, "reuse search pool copy");
    try {
      return { dir: dest, ...verified(dest, minScore, source.sha256), created: false };
    } catch (e) {
      throw new PoolBuildError(`the existing search pool copy at ${dest} cannot be used: ${(e as Error).message}; delete it and re-run`);
    }
  };
  root.mkdir(dirname(dest));
  try {
    root.assertIn(dest, "reuse search pool copy");
    return reuse();
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
  }
  const tmp = `${dest}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  root.mkdir(tmp);
  try {
    const raw = readPool(src);
    root.createFile(join(tmp, "records.jsonl"), raw.records.map((r) => JSON.stringify(r)).join("\n") + "\n", 0o600);
    root.createFile(join(tmp, "pool.json"), JSON.stringify(raw.manifest, null, 2) + "\n", 0o600);
    verified(tmp, minScore, source.sha256);
    poolCopyHooks.beforeRename?.(dest);
    if (root.renameNoFollow(tmp, dest, { replace: false }) === "exists") return reuse();
    return { dir: dest, manifest: source.manifest, sha256: source.sha256, created: true };
  } finally {
    root.assertIn(dirname(tmp), "remove a temp search pool copy");
    rmSync(tmp, { recursive: true, force: true });
  }
}
