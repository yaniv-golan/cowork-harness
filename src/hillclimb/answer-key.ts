// The answer-key rule: anything that defines or answers the measurement — a hillclimb flow dir, a scenario or
// answers file, a frozen pairwise reference store — must not be readable by the agent under test. A run that can
// read the frozen baseline output, or the rubric, can copy it. ONE copy, used by the hillclimb runner and by every
// command that judges against a frozen reference; each refuses (exit 2) before spend on any hit.

import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { containedRealPath } from "../boundary-paths.js";

/** Every path that resolves inside one of the user-visible mount roots, with the first mount it is under. Paths
 *  are compared by real path, so a symlink alias into a mount is caught. A path that does not exist yet (a
 *  reference store a baseline is about to create) is judged by its nearest existing ancestor; a mount root that
 *  does not exist exposes nothing. */
export function pathsInsideMounts(paths: readonly string[], mountRoots: readonly string[]): Array<{ path: string; mount: string }> {
  const nearestExisting = (p: string): string => {
    let cur = p;
    while (!existsSync(cur) && dirname(cur) !== cur) cur = dirname(cur);
    return cur;
  };
  const mounts = mountRoots.filter((m) => existsSync(m));
  const out: Array<{ path: string; mount: string }> = [];
  for (const path of paths) {
    const at = nearestExisting(path);
    const mount = mounts.find((m) => containedRealPath(m, at));
    if (mount !== undefined) out.push({ path, mount });
  }
  return out;
}
