import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
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
export function collectArtifacts(workRoot: string, prefixes: string[], opts?: WalkOpts): { path: string; bytes: number }[] {
  const out: { path: string; bytes: number }[] = [];
  const visited = new Set<string>();
  // Resolve workRoot once — used in the containment assertion inside walk().
  let workRootReal: string;
  try {
    workRootReal = realpathSync(workRoot);
  } catch {
    return out; // workRoot itself absent/unreadable
  }
  for (const prefix of prefixes) walkInto(join(workRoot, prefix), prefix, workRootReal, visited, out, opts);
  return out;
}

/** A link-kind for a path-walk entry. Absent (regular file) is the default; directories are
 *  traversal-only and never emitted. */
export type ArtifactLinkKind = "symlink" | "hardlink";

export interface ArtifactPathEntry {
  path: string;
  /** absent = regular file. */
  linkKind?: ArtifactLinkKind;
}

/**
 * PATHS + LINK-KIND walk for the filesystem-coverage assertions (`no_unexpected_files`, and the pre-run
 * baseline it diffs against). Unlike `collectArtifacts` (the CONTENT walk, which SKIPS symlinks and
 * hardlinks so out-of-tree content can't be inlined into a committed cassette), this EMITS symlink and
 * hardlink entries — tagged with `linkKind` — so an agent-created symlink/hardlink stray is visible to
 * `no_unexpected_files`. It never reads or dereferences a target (no content is inlined; cycle-safe), so
 * recording link identity is safe even for a symlink that points out of the work root. Directories are
 * traversal-only (recursed, never emitted), matching `collectArtifacts`.
 */
export function collectArtifactPaths(workRoot: string, prefixes: string[]): ArtifactPathEntry[] {
  const out: ArtifactPathEntry[] = [];
  const visited = new Set<string>();
  let workRootReal: string;
  try {
    workRootReal = realpathSync(workRoot);
  } catch {
    return out; // workRoot itself absent/unreadable
  }
  for (const prefix of prefixes) walkPaths(join(workRoot, prefix), prefix, workRootReal, visited, out);
  return out;
}

/** Like `collectArtifactPaths` but rooted at an ARBITRARY directory mapped to `prefix` (the hostloop
 *  pre-run variant, mirroring `collectArtifactsAt`). Returns `prefix/<rel>` entries with link-kind. */
export function collectArtifactPathsAt(dir: string, prefix: string): ArtifactPathEntry[] {
  const out: ArtifactPathEntry[] = [];
  let dirReal: string;
  try {
    dirReal = realpathSync(dir);
  } catch {
    return out;
  }
  walkPaths(dir, prefix, dirReal, new Set<string>(), out);
  return out;
}

function walkPaths(startAbs: string, startRel: string, containReal: string, visited: Set<string>, out: ArtifactPathEntry[]): void {
  const walk = (abs: string, rel: string) => {
    let real: string;
    try {
      real = realpathSync(abs); // only reached for real (non-symlink) directories — see the loop below
    } catch {
      return;
    }
    // A real directory whose realpath escapes the containment root (e.g. a bind mount) — skip the subtree.
    if (real !== containReal && !real.startsWith(containReal + sep)) return;
    if (visited.has(real)) return;
    visited.add(real);
    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch {
      return;
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
      // EMIT a symlink as a link entry (never follow it — no escape/cycle, no target read).
      if (st.isSymbolicLink()) {
        out.push({ path: childRel, linkKind: "symlink" });
        continue;
      }
      if (st.isDirectory())
        walk(childAbs, childRel); // traversal-only, never emitted
      else if (st.isFile()) out.push(st.nlink > 1 ? { path: childRel, linkKind: "hardlink" } : { path: childRel });
    }
  };
  walk(startAbs, startRel);
}

export type WorkspaceFileClass = "output" | "mount" | "input";

export interface WorkspaceFile {
  path: string;
  bytes: number;
  /** Absent (with `hashError` set instead) when the file could not be read/hashed — an empty
   *  string would silently read as a legitimate hash of empty content. */
  sha256?: string;
  /** Short reason the file couldn't be hashed (e.g. an fs error code). Only present when `sha256` is absent. */
  hashError?: string;
  class: WorkspaceFileClass;
}

/**
 * The Working folder panel's canonical file model (the Scratch pad's `"scratchpad"` class
 * is deliberately NOT implemented here; that remains out of scope).
 * Classifies every file under the user-visible roots, reusing the SAME `collectArtifacts` walk
 * `artifacts` already used before this view existed — no second directory-walk implementation. Fingerprints mirror
 * `cassette.ts`'s `buildManifest`'s sha256 approach; this file does its OWN read+hash rather than
 * importing from `cassette.ts` (which already imports FROM `execute.ts`, and `execute.ts` imports
 * this file's `collectArtifacts` — importing `cassette.ts` here would close a cycle; the hash itself
 * is 2 lines of stdlib `crypto`, cheap enough to duplicate rather than restructure module boundaries).
 *
 * Classification matches each path against the FULL root string (not a first-path-segment split) —
 * `userVisibleRoots`/`readonlyFolderRoots` entries can be multi-segment (e.g. `.projects/myfolder` on
 * pre-1.14271.0 baselines), mirroring the exact full-string-equality convention the pre-existing
 * `captureRoots` filter (`execute.ts:689`) already uses.
 */
export function classifyWorkspaceFiles(workRoot: string, userVisibleRoots: string[], readonlyFolderRoots: string[]): WorkspaceFile[] {
  // On a read/hash failure returns `{ hashError }` instead of a `sha256` — an empty-string hash would
  // otherwise be indistinguishable from a legitimately-hashed empty file.
  const hashFile = (relPath: string): { sha256: string } | { hashError: string } => {
    try {
      return {
        sha256: createHash("sha256")
          .update(readFileSync(join(workRoot, relPath)))
          .digest("hex"),
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      return { hashError: code ?? (err instanceof Error ? err.message : String(err)) };
    }
  };
  const rootOf = (path: string): string | undefined => userVisibleRoots.find((r) => path === r || path.startsWith(r + "/"));
  const out: WorkspaceFile[] = [];
  for (const { path, bytes } of collectArtifacts(workRoot, userVisibleRoots)) {
    const root = rootOf(path);
    const cls: WorkspaceFileClass =
      root !== undefined && readonlyFolderRoots.includes(root) ? "input" : root === "outputs" ? "output" : "mount";
    out.push({ path, bytes, ...hashFile(path), class: cls });
  }
  return out;
}

/** Walk options. `includeHardlinkPaths` lifts the nlink>1 rejection for PATHS-ONLY walks (the
 *  `no_unexpected_files` pre-run baseline): the guard exists to keep hardlinked out-of-root CONTENT out
 *  of committed cassettes, which a path listing never reads. The baseline must include them — the
 *  post-run side walks a cpSync copy where every file is nlink=1 (the guard can't fire), so skipping
 *  them pre-run would report a pre-existing hardlinked file as agent-"created" (false stray). */
export interface WalkOpts {
  includeHardlinkPaths?: boolean;
}

/** Walk an ARBITRARY directory (containment-rooted at itself), emitting `prefix/<rel>` paths — the
 *  hostloop pre-run variant of collectArtifacts: connected folders are bind-mounted live host paths
 *  (never staged), so the pre-run snapshot walks each folder SOURCE mapped to its mountPath, mirroring
 *  the path space snapshotHostLoopWorkspace's post-run copy produces. Same symlink-skip /
 *  hardlink-reject / realpath-containment guards. */
export function collectArtifactsAt(dir: string, prefix: string, opts?: WalkOpts): string[] {
  const out: { path: string; bytes: number }[] = [];
  let dirReal: string;
  try {
    dirReal = realpathSync(dir);
  } catch {
    return []; // source dir absent/unreadable — nothing pre-existing
  }
  walkInto(dir, prefix, dirReal, new Set<string>(), out, opts);
  return out.map((f) => f.path);
}

/** The shared walk. `containReal` is the realpath every visited directory must stay under;
 *  `visited` is caller-owned so collectArtifacts shares one cycle-set across all its prefixes
 *  (identical to the pre-move behavior). */
function walkInto(
  startAbs: string,
  startRel: string,
  containReal: string,
  visited: Set<string>,
  out: { path: string; bytes: number }[],
  opts?: WalkOpts,
): void {
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
        if (st.nlink > 1 && !opts?.includeHardlinkPaths) {
          warn(`::warning:: collectArtifacts: skipping ${childRel} (hardlink, nlink=${st.nlink}) — may reference out-of-root content\n`);
          continue;
        }
        out.push({ path: childRel, bytes: st.size });
      }
    }
  };
  walk(startAbs, startRel);
}

/** One file the run authored (created or modified), with its final on-disk content — the judge's evidence
 *  for "what the skill produced", independent of whether the agent also inlined it in prose. */
export interface AuthoredFile {
  path: string;
  content: string;
  truncated?: boolean;
}

/** Files the run CREATED or MODIFIED under user-visible roots (added/modified vs the pre-run manifest),
 *  read back at their final on-disk content. Excludes read-only inputs (unchanged mounts). Size-bounded:
 *  a per-file cap and a total cap; over-cap content is truncated and flagged. Returns `[]` when there is
 *  no pre-run manifest (e.g. microvm) — no diff is possible, so the caller notes evidence-unavailable
 *  rather than dumping the whole workspace. Must be called AFTER the run completes (files finalized).
 *
 *  `scratchpadRoot` (the session root, i.e. the PARENT of the `mnt` workspace) closes a real coin-flip: at
 *  container/hostloop fidelity the agent's cwd is the session root, NOT `mnt`, so a relative `Write
 *  outputs/x` lands in the scratchpad — outside `workRoot`/`userVisibleRoots` and thus previously uncaptured
 *  (SPEC/plan §R2 H2). When provided, we also capture non-dotfile deliverables directly under it. The
 *  scratchpad is staged empty except `mnt/`, so a non-dot file there was authored this run; dot-prefixed
 *  entries (`.claude`, `.cache`, XDG state — the agent's $HOME runtime noise) and the `mnt` subtree
 *  (already captured above) are excluded. Everything is scrubbed downstream before it reaches a judge. */
export function captureAuthoredFiles(
  workRoot: string,
  userVisibleRoots: string[],
  readonlyFolderRoots: string[],
  preRunHashes: Record<string, string | null> | undefined,
  opts: { perFileBytes?: number; totalBytes?: number; scratchpadRoot?: string } = {},
): AuthoredFile[] {
  if (preRunHashes === undefined) return []; // no pre-run manifest → can't diff added/modified → no capture
  const perFile = opts.perFileBytes ?? 16 * 1024;
  const total = opts.totalBytes ?? 64 * 1024;
  const out: AuthoredFile[] = [];
  let used = 0;
  const pushFile = (absPath: string, relPath: string): void => {
    if (used >= total) return;
    try {
      const buf = readFileSync(absPath);
      const slice = buf.subarray(0, Math.min(perFile, total - used));
      const truncated = buf.length > slice.length;
      out.push({ path: relPath, content: slice.toString("utf8"), ...(truncated ? { truncated: true } : {}) });
      used += slice.length;
    } catch {
      /* unreadable at read-back → evidence-honest omission */
    }
  };
  for (const f of classifyWorkspaceFiles(workRoot, userVisibleRoots, readonlyFolderRoots)) {
    if (f.class === "input") continue; // read-only mount — not authored by this run
    const sha = (f as { sha256?: string }).sha256;
    const prior = preRunHashes[f.path]; // undefined = new file; null = unreadable pre-run; string = prior hash
    const authored = prior === undefined || prior === null || (sha !== undefined && sha !== prior);
    if (!authored) continue;
    if (used >= total) break;
    pushFile(join(workRoot, f.path), f.path);
  }
  // Scratchpad deliverables (cwd-relative writes outside mnt). Walk the session root, skipping dot-entries
  // (runtime $HOME state) and the `mnt` subtree; symlinks/hardlinks are not followed (escape/cycle guard,
  // mirroring collectArtifactPaths).
  if (opts.scratchpadRoot) {
    const visited = new Set<string>();
    const walk = (absDir: string, relDir: string): void => {
      if (used >= total) return;
      let real: string;
      try {
        real = realpathSync(absDir);
      } catch {
        return;
      }
      if (visited.has(real)) return;
      visited.add(real);
      let entries: string[];
      try {
        entries = readdirSync(absDir).sort();
      } catch {
        return;
      }
      for (const name of entries) {
        if (name.startsWith(".")) continue; // $HOME runtime noise (.claude/.cache/XDG state)
        if (relDir === "" && name === "mnt") continue; // captured via userVisibleRoots above
        const childAbs = join(absDir, name);
        const childRel = relDir ? `${relDir}/${name}` : name;
        let st;
        try {
          st = lstatSync(childAbs);
        } catch {
          continue;
        }
        if (st.isSymbolicLink()) continue; // not followed (may escape/cycle)
        if (st.isDirectory()) walk(childAbs, childRel);
        else if (st.isFile()) {
          if (st.nlink > 1) continue; // hardlink → may reference out-of-root content
          if (used >= total) return;
          pushFile(childAbs, `scratchpad/${childRel}`);
        }
      }
    };
    walk(opts.scratchpadRoot, "");
  }
  return out;
}
