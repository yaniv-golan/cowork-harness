// The answer-key rule: anything that defines or answers the measurement — a hillclimb flow dir, a scenario or
// answers file, a frozen pairwise reference store — must not be readable by the agent under test. A run that can
// read the frozen baseline output, or the rubric, can copy it. ONE copy, used by the hillclimb runner and by every
// command that judges against a frozen reference; each refuses (exit 2) before spend on any hit.

import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isUnderRealRoot } from "../boundary-paths.js";

/** The real path of `p` (`exact: true`), or of its nearest existing ancestor when `p` does not exist yet. `null`
 *  when the walk meets a dangling symlink: where it points cannot be proven to lie outside every mount. */
function realOrNearest(p: string): { real: string; exact: boolean } | null {
  let cur = resolve(p);
  const exact = (c: string): boolean => c === resolve(p);
  for (;;) {
    let isLink = false;
    try {
      isLink = lstatSync(cur).isSymbolicLink();
    } catch {
      // absent: try the parent
      if (dirname(cur) === cur) return { real: cur, exact: false };
      cur = dirname(cur);
      continue;
    }
    if (isLink && !existsSync(cur)) return null;
    return { real: realpathSync.native(cur), exact: exact(cur) };
  }
}

/** Every protected path a mount exposes, with the first such mount. Exposure is checked BOTH ways, by real path
 *  (symlink aliases caught): a path inside a mount is readable, and a mount nested inside a path exposes that part
 *  of it (mounting `<store>/case_1` hands the agent case_1's frozen reference). A path that does not exist yet (a
 *  store a baseline is about to create) is judged by its nearest existing ancestor; a dangling symlink on the way
 *  fails closed. A mount root that does not exist exposes nothing. */
export function pathsInsideMounts(paths: readonly string[], mountRoots: readonly string[]): Array<{ path: string; mount: string }> {
  const mounts = mountRoots.filter((m) => existsSync(m)).map((m) => ({ mount: m, real: realpathSync.native(m) }));
  const out: Array<{ path: string; mount: string }> = [];
  for (const path of paths) {
    const r = realOrNearest(path);
    // The reverse direction (a mount nested inside the path) needs the path itself: a path that does not exist yet
    // contains nothing, and its ANCESTOR containing a mount says nothing about it.
    const hit = mounts.find((m) => r === null || isUnderRealRoot(m.real, r.real) || (r.exact && isUnderRealRoot(r.real, m.real)));
    if (hit !== undefined) out.push({ path, mount: hit.mount });
  }
  return out;
}
