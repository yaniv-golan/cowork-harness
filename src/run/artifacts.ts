import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { warn } from "../io.js";

/** ENV-MANIFEST: recursively list files under each user-visible prefix (relative path + byte size).
 *  Paths only — NO content snapshot (that is the cassette manifest).
 *
 *  use `lstatSync` (does NOT follow symlinks) and SKIP any symlink entry — a symlink could point out
 *  of `workRoot` (inlining out-of-tree content into a committed cassette) or form a cycle. A `visited` set of
 *  resolved real directory paths breaks cycles among real directories too. Only regular files are recorded.
 *
 *  Moved here from execute.ts (and re-exported there) so `assert.ts` can evaluate
 *  `no_unexpected_files` without an assert→execute import cycle. */
export function collectArtifacts(workRoot: string, prefixes: string[]): { path: string; bytes: number }[] {
  const out: { path: string; bytes: number }[] = [];
  const visited = new Set<string>();
  // Resolve workRoot once — used in the containment assertion inside walk().
  let workRootReal: string;
  try {
    workRootReal = realpathSync(workRoot);
  } catch {
    return out; // workRoot itself absent/unreadable
  }
  for (const prefix of prefixes) walkInto(join(workRoot, prefix), prefix, workRootReal, visited, out);
  return out;
}

/** Walk an ARBITRARY directory (containment-rooted at itself), emitting `prefix/<rel>` paths — the
 *  hostloop pre-run variant of collectArtifacts: connected folders are bind-mounted live host paths
 *  (never staged), so the pre-run snapshot walks each folder SOURCE mapped to its mountPath, mirroring
 *  the path space snapshotHostLoopWorkspace's post-run copy produces. Same symlink-skip /
 *  hardlink-reject / realpath-containment guards. */
export function collectArtifactsAt(dir: string, prefix: string): string[] {
  const out: { path: string; bytes: number }[] = [];
  let dirReal: string;
  try {
    dirReal = realpathSync(dir);
  } catch {
    return []; // source dir absent/unreadable — nothing pre-existing
  }
  walkInto(dir, prefix, dirReal, new Set<string>(), out);
  return out.map((f) => f.path);
}

/** The shared walk. `containReal` is the realpath every visited directory must stay under;
 *  `visited` is caller-owned so collectArtifacts shares one cycle-set across all its prefixes
 *  (identical to the pre-move behavior). */
function walkInto(startAbs: string, startRel: string, containReal: string, visited: Set<string>, out: { path: string; bytes: number }[]): void {
  const walk = (abs: string, rel: string) => {
    // Cycle guard: resolve the real path of this directory; if we've already walked it, stop.
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      return; // prefix dir absent / unreadable — not an error
    }
    // Containment: reject any entry whose realpath escapes the containment root. Catches prefix-level
    // symlinks (not caught by the child lstatSync below) and any other realpath-diverging construct.
    if (real !== containReal && !real.startsWith(containReal + sep)) {
      warn(`::warning:: collectArtifacts: skipping "${rel}" — real path escapes work root\n`);
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);
    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch {
      return; // prefix dir absent (skill wrote nothing there) — not an error
    }
    for (const name of entries.sort()) {
      const childAbs = join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = lstatSync(childAbs); // lstat: does NOT follow symlinks
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        // Skip symlinks: they can escape workRoot or cycle. (Recording-side; the agent's own outputs are
        // real files, so this loses nothing in practice while closing the escape/cycle hole.)
        warn(`::warning:: collectArtifacts: skipping symlink ${childRel} (not followed)\n`);
        continue;
      }
      if (st.isDirectory()) walk(childAbs, childRel);
      else if (st.isFile()) {
        // a HARDLINK to an out-of-root host file reads as an ordinary regular file (the symlink
        // and realpath-containment guards above CANNOT catch it — a hardlink is a second name for an
        // inode, not path indirection, so `realpathSync` returns the path unchanged inside workRoot).
        // Reject any file with nlink > 1 so a hardlinked out-of-root file's content can't be read into a
        // committed cassette. Residual fidelity tradeoff: legitimate in-root hardlinks (cp -l / git / build
        // tooling) are conservatively dropped — enumerating all links of an inode is not feasible from
        // artifact-walk state, so reject + warn + document is the only correct posture.
        if (st.nlink > 1) {
          warn(`::warning:: collectArtifacts: skipping ${childRel} (hardlink, nlink=${st.nlink}) — may reference out-of-root content\n`);
          continue;
        }
        out.push({ path: childRel, bytes: st.size });
      }
    }
  };
  walk(startAbs, startRel);
}
