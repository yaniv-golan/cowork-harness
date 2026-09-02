import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { anyGlobMatches } from "../glob.js";
import { warn } from "../io.js";

/** A buffer round-trips losslessly through UTF-8 only if re-encoding the decoded string reproduces the
 *  exact bytes. Binary content (and lone surrogates / invalid sequences) fail this.
 *
 *  Lives HERE, in a leaf module, for the same reason `collectArtifacts` does: `assert.ts` needs it (a
 *  text matcher over an artifact body must fail closed on bytes that are not text, or a `not_contains`
 *  "passes" against replacement characters it never actually read), and `src/run/cassette.ts` already
 *  imports FROM assert.ts — so exporting it there would close an import cycle. Re-exported from
 *  cassette.ts for its existing callers. */
export function isLosslessUtf8(buf: Buffer): boolean {
  return Buffer.from(buf.toString("utf8"), "utf8").equals(buf);
}

/** Short, stable reason string for a caught fs error: the errno code when available, else the raw
 *  message. Shared by every health/error-recording path in this file so a consumer sees one convention. */
function errMsg(err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code ?? (err instanceof Error ? err.message : String(err));
}

/** True for an errno that means "this path legitimately doesn't exist" (a prefix root the skill never
 *  wrote to, a file raced out from under a directory listing) — NOT an evidence gap. Any other error
 *  (permission denied, I/O error, …) means the subtree exists but couldn't be observed, which IS an
 *  evidence gap and must be recorded as walk incompleteness (F18) rather than silently skipped. */
function isMissingErr(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** F18: completeness signal for a filesystem walk. `complete: false` means some part of the tree could
 *  NOT be observed (root missing/unreadable, a subdir unreadable, a path escaped containment isn't
 *  included here — that's an intentional security-skip, not an observation gap). Lets an
 *  absence-sensitive caller (no_unexpected_files, input_unmodified) tell a genuinely empty tree apart
 *  from an incomplete one instead of collapsing both to `[]`. Additive/opt-in: the plain `collectArtifacts`/
 *  `collectArtifactPaths` entry points keep returning a bare array for existing callers; the `*WithHealth`
 *  siblings expose this signal for a caller that wants it. */
export interface WalkHealth {
  complete: boolean;
  /** path-scoped errors encountered during the walk (relative path — "" for a root-level failure — plus a
   *  short reason). */
  errors: { path: string; error: string }[];
  /** subtrees skipped because their realpath escaped the containment root (a symlink/bind-mount out of
   *  the work root). This is an intentional SECURITY skip, NOT a read error, so it does not set
   *  `complete: false` — but "security-skipped" is not the same as "observed empty": a subtree excluded
   *  here is unobserved, so an assertion that requires EXHAUSTIVE coverage (no_unexpected_files) must treat
   *  a skip at/under one of its prefix roots as evidence-unavailable rather than "no strays found". */
  containmentSkips: string[];
}

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
  return collectArtifactsWithHealth(workRoot, prefixes, opts).files;
}

/** F18: like `collectArtifacts`, but also reports whether the walk was complete and any path-scoped
 *  errors encountered. `collectArtifacts` is a thin wrapper around this that discards the health half
 *  (kept as the stable, unchanged entry point every existing caller already uses). */
export function collectArtifactsWithHealth(
  workRoot: string,
  prefixes: string[],
  opts?: WalkOpts,
): { files: { path: string; bytes: number }[] } & WalkHealth {
  const out: { path: string; bytes: number }[] = [];
  const visited = new Set<string>();
  const health: WalkHealth = { complete: true, errors: [], containmentSkips: [] };
  // Resolve workRoot once — used in the containment assertion inside walk().
  let workRootReal: string;
  try {
    workRootReal = realpathSync(workRoot);
  } catch (err) {
    // workRoot itself absent/unreadable — nothing under any prefix could be observed.
    health.complete = false;
    health.errors.push({ path: "", error: errMsg(err) });
    return { files: out, ...health };
  }
  for (const prefix of prefixes) walkInto(join(workRoot, prefix), prefix, workRootReal, visited, out, opts, health);
  return { files: out, ...health };
}

/** A link-kind for a path-walk entry. Absent (regular file) is the default; directories are
 *  traversal-only and never emitted. */
type ArtifactLinkKind = "symlink" | "hardlink";

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
  return collectArtifactPathsWithHealth(workRoot, prefixes).entries;
}

/** F18: like `collectArtifactPaths`, but also reports walk completeness + path-scoped errors. See
 *  `collectArtifactsWithHealth`'s doc comment — same additive convention. */
export function collectArtifactPathsWithHealth(workRoot: string, prefixes: string[]): { entries: ArtifactPathEntry[] } & WalkHealth {
  const out: ArtifactPathEntry[] = [];
  const visited = new Set<string>();
  const health: WalkHealth = { complete: true, errors: [], containmentSkips: [] };
  let workRootReal: string;
  try {
    workRootReal = realpathSync(workRoot);
  } catch (err) {
    health.complete = false;
    health.errors.push({ path: "", error: errMsg(err) });
    return { entries: out, ...health };
  }
  for (const prefix of prefixes) walkPaths(join(workRoot, prefix), prefix, workRootReal, visited, out, health);
  return { entries: out, ...health };
}

/** Like `collectArtifactPaths` but rooted at an ARBITRARY directory mapped to `prefix` (the hostloop
 *  pre-run variant). Returns `prefix/<rel>` entries with link-kind. */
export function collectArtifactPathsAt(dir: string, prefix: string): ArtifactPathEntry[] {
  return collectArtifactPathsAtWithHealth(dir, prefix).entries;
}

/** F18: like `collectArtifactPathsAt`, but also reports walk completeness + path-scoped errors so the
 *  pre-run baseline (`capturePreRunManifest`) can mark its `origin` `local-unreadable` when a nested
 *  connected-folder subtree is unreadable, instead of silently narrowing the baseline. `collectArtifactPathsAt`
 *  is the thin, behavior-preserving wrapper that discards the health half. */
export function collectArtifactPathsAtWithHealth(dir: string, prefix: string): { entries: ArtifactPathEntry[] } & WalkHealth {
  const out: ArtifactPathEntry[] = [];
  const health: WalkHealth = { complete: true, errors: [], containmentSkips: [] };
  let dirReal: string;
  try {
    dirReal = realpathSync(dir);
  } catch (err) {
    // Root missing/unreadable: caller (capturePreRunManifest) already guards the whole-source case with an
    // explicit realpathSync, but record it here too so this entry point is honest on its own.
    if (!isMissingErr(err)) {
      health.complete = false;
      health.errors.push({ path: "", error: errMsg(err) });
    }
    return { entries: out, ...health };
  }
  walkPaths(dir, prefix, dirReal, new Set<string>(), out, health);
  return { entries: out, ...health };
}

function walkPaths(
  startAbs: string,
  startRel: string,
  containReal: string,
  visited: Set<string>,
  out: ArtifactPathEntry[],
  health?: WalkHealth,
): void {
  const walk = (abs: string, rel: string) => {
    let real: string;
    try {
      real = realpathSync(abs); // only reached for real (non-symlink) directories — see the loop below
    } catch (err) {
      if (health && !isMissingErr(err)) {
        health.complete = false;
        health.errors.push({ path: rel, error: errMsg(err) });
      }
      return;
    }
    // A real directory whose realpath escapes the containment root (e.g. a bind mount) — skip the subtree.
    // Intentional security-skip, not an observation gap: does NOT mark health incomplete — but record
    // it so an exhaustive-coverage assertion knows this subtree was unobserved (not proven empty).
    if (real !== containReal && !real.startsWith(containReal + sep)) {
      if (health) health.containmentSkips.push(rel);
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);
    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch (err) {
      if (health && !isMissingErr(err)) {
        health.complete = false;
        health.errors.push({ path: rel, error: errMsg(err) });
      }
      return;
    }
    for (const name of entries.sort()) {
      const childAbs = join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = lstatSync(childAbs); // lstat: does NOT follow symlinks
      } catch (err) {
        if (health && !isMissingErr(err)) {
          health.complete = false;
          health.errors.push({ path: childRel, error: errMsg(err) });
        }
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

/** `scratchpad` = the agent's working area OUTSIDE every user-visible root — files it produced that the
 *  user never sees unless they are explicitly delivered. Added so the canonical file model can answer
 *  "was this deliverable actually delivered?", which needs the undelivered side of the ledger. */
type WorkspaceFileClass = "output" | "mount" | "input" | "scratchpad";

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
 * The Working folder panel's canonical file model, INCLUDING the `"scratchpad"` class — files the agent
 * wrote outside every user-visible root. Those are enumerated by a second, separate walk
 * (`walkScratchpadFiles`) shared with authored-file capture, never by widening the visible-root walk:
 * `no_unexpected_files` runs its own walk over the same visible prefixes, and widening this one would
 * have changed that assertion's verdict as a side effect.
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
/** F12 default per-file hash cap for `classifyWorkspaceFiles`: above this, a file is recorded with
 *  `hashError: "over-cap"` instead of being read into memory whole. A large connected-folder file (a
 *  multi-GB export, say) would otherwise spike memory on every `classifyWorkspaceFiles` call (chat,
 *  execute.ts's success path, execute.ts's partial-persist path) — none of which bound the read today.
 *  Same 50 MiB default as the pre-run manifest's `preRunHashCap` (see pre-run-manifest.ts) for one
 *  consistent "how big is too big to hash" answer across the pre-run and post-run walks. */
const DEFAULT_WORKSPACE_HASH_CAP = 50 * 1024 * 1024;

export interface ClassifyWorkspaceFilesOpts {
  /** Override the per-file hash cap (bytes). Defaults to `DEFAULT_WORKSPACE_HASH_CAP`. */
  hashCapBytes?: number;
  /** The session root (PARENT of the `mnt` workspace). Supplied ⇒ files the agent wrote outside every
   *  user-visible root are enumerated as `class:"scratchpad"`. Omitted ⇒ they are not enumerated at all,
   *  which is evidence-UNAVAILABLE rather than "none existed" — a caller that needs to tell those apart
   *  must check `scratchpadScanned`. */
  scratchpadRoot?: string;
}

export interface ClassifyWorkspaceFilesResult {
  files: WorkspaceFile[];
  /** False ⇒ no scratchpad walk ran (no `scratchpadRoot` supplied — e.g. a tier with no such layout), so
   *  the ABSENCE of `class:"scratchpad"` entries proves nothing. Distinguishing this from a genuine
   *  "nothing left behind" is the difference between an honest signal and a vacuous green. */
  scratchpadScanned: boolean;
  /** Walk errors / skipped links from the scratchpad pass — an incomplete walk can HIDE an undelivered
   *  file, so a consumer asserting absence must degrade on these. */
  scratchpadWalkErrors: Array<{ path: string; error: string }>;
  scratchpadSkippedLinks: string[];
  /** True when the workspace ROOT ITSELF could not be resolved (`realpathSync(workRoot)` threw) — the walk
   *  observed nothing, so an empty `files` here means "unavailable", NOT "the agent wrote nothing". The
   *  canonical case is a microvm run whose outputs stage into the VM work tree, never into
   *  `outDir/work/session/mnt` (#52); the persisted `workspaceFiles: []` was then indistinguishable from a
   *  genuinely-empty run — a silent false-green. A caller persisting workspaceFiles/artifacts must record
   *  UNAVAILABLE (`undefined`, the replay convention) instead of a false empty when this is set.
   *  Precise: only `collectArtifactsWithHealth`'s root-resolution catch pushes an errors entry with an
   *  empty `path`; a missing *prefix* subdir (e.g. no `outputs/` on a normal empty run) pushes the prefix
   *  name, so it does NOT set `rootAbsent`. */
  rootAbsent: boolean;
  /** false when SOME part of the user-visible tree could not be observed — a nested unreadable subdir
   *  (EACCES/EIO), not just the root. Previously only `rootAbsent` survived, collapsing a partial list into
   *  a complete-looking one: an authored file inside an unreadable subtree vanished with no signal. */
  walkComplete: boolean;
  /** the path-scoped walk errors behind `walkComplete === false` (relative path + short reason). */
  walkErrors: { path: string; error: string }[];
}

/** F18 consumption: like `classifyWorkspaceFiles`, but also reports whether the workspace root was
 *  observable at all (`rootAbsent`). `classifyWorkspaceFiles` is the thin, behavior-preserving wrapper
 *  every existing caller keeps using (it discards `rootAbsent`, exactly as before). */
export function classifyWorkspaceFilesWithHealth(
  workRoot: string,
  userVisibleRoots: string[],
  readonlyFolderRoots: string[],
  opts: ClassifyWorkspaceFilesOpts = {},
): ClassifyWorkspaceFilesResult {
  const cap = opts.hashCapBytes ?? DEFAULT_WORKSPACE_HASH_CAP;
  // On a read/hash failure (INCLUDING an over-cap file) returns `{ hashError }` instead of a `sha256` —
  // an empty-string hash would otherwise be indistinguishable from a legitimately-hashed empty file.
  // F12: `statSync` runs BEFORE any read, same precedent as pre-run-manifest.ts's `hashFileCapped` — an
  // over-cap file is never loaded into memory; a post-read length check would still read the whole file
  // first, which is exactly the memory spike this guards against.
  const hashFile = (relPath: string): { sha256: string } | { hashError: string } => {
    const abs = join(workRoot, relPath);
    try {
      if (statSync(abs).size > cap) return { hashError: "over-cap" };
      return {
        sha256: createHash("sha256").update(readFileSync(abs)).digest("hex"),
      };
    } catch (err) {
      return { hashError: errMsg(err) };
    }
  };
  const rootOf = (path: string): string | undefined => userVisibleRoots.find((r) => path === r || path.startsWith(r + "/"));
  const out: WorkspaceFile[] = [];
  const walk = collectArtifactsWithHealth(workRoot, userVisibleRoots);
  for (const { path, bytes } of walk.files) {
    const root = rootOf(path);
    const cls: WorkspaceFileClass =
      root !== undefined && readonlyFolderRoots.includes(root) ? "input" : root === "outputs" ? "output" : "mount";
    out.push({ path, bytes, ...hashFile(path), class: cls });
  }
  // Second, SEPARATE walk — never a widening of the visible-root walk above (see this function's doc).
  const scratch = opts.scratchpadRoot ? walkScratchpadFiles(opts.scratchpadRoot) : undefined;
  if (scratch)
    for (const { absPath, relPath } of scratch.files) {
      let bytes = 0;
      try {
        bytes = statSync(absPath).size;
      } catch {
        /* hashFile below records the read failure; bytes stays 0 */
      }
      out.push({ path: relPath, bytes, ...hashFile(absPath), class: "scratchpad" });
    }
  return {
    files: out,
    scratchpadScanned: scratch !== undefined,
    scratchpadWalkErrors: scratch?.errors ?? [],
    scratchpadSkippedLinks: scratch?.skippedLinks ?? [],
    rootAbsent: walk.errors.some((e) => e.path === ""),
    walkComplete: walk.complete,
    // the nested (non-root) errors — a caller diffing against this list (authored-file capture) can now
    // fail evidence-unavailable instead of treating a partial enumeration as a complete one.
    walkErrors: walk.errors.filter((e) => e.path !== ""),
  };
}

export function classifyWorkspaceFiles(
  workRoot: string,
  userVisibleRoots: string[],
  readonlyFolderRoots: string[],
  opts: ClassifyWorkspaceFilesOpts = {},
): WorkspaceFile[] {
  return classifyWorkspaceFilesWithHealth(workRoot, userVisibleRoots, readonlyFolderRoots, opts).files;
}

/** #54: the SINGLE gate every RunResult producer (run success, run partial, chat) uses to decide whether a
 *  workspace walk is trustworthy enough to persist as the canonical `workspaceFiles`/`artifacts` list.
 *  Returns the files ONLY when the WHOLE user-visible tree was observed. A missing root (`rootAbsent`, #52)
 *  OR any nested unreadable subtree (`!walkComplete` — an EACCES/EIO on a subdir) collapses to `undefined`,
 *  the repo-wide evidence-unavailable convention, so an absence-sensitive consumer (`delivered_clean` /
 *  `ended_with_question` in verdict.ts, the replay `diff`, `scaffold`, `file_exists`) fails cannot-verify
 *  instead of trusting a PARTIAL enumeration as complete. Previously the producers gated on `rootAbsent`
 *  alone, so a partial list read as complete — an authored file inside an unreadable subtree vanished with
 *  no signal (the #54 silent false-clean). One helper so a producer can't silently regress to that. */
export function trustedWorkspaceFiles(health: ClassifyWorkspaceFilesResult): WorkspaceFile[] | undefined {
  return health.rootAbsent || !health.walkComplete ? undefined : health.files;
}

/** Did a scratchpad walk actually observe this run, completely?
 *
 *  This is the difference between "nothing was left undelivered" and "we cannot tell" — and it must be
 *  PERSISTED, because the verdict is computed from `RunResult` alone. Without it, a tier that runs no
 *  scratchpad walk (protocol has no session-root layout; chat passes no root) is indistinguishable from a
 *  clean run, and silence reads as a pass. False iff the walk never ran, or ran incompletely (an
 *  unreadable subtree can hide the very file the signal exists to name). */
export function scratchpadEvidenceComplete(health: ClassifyWorkspaceFilesResult): boolean {
  return health.scratchpadScanned && health.scratchpadWalkErrors.length === 0;
}

/** Walk options. `includeHardlinkPaths` lifts the nlink>1 rejection for PATHS-ONLY walks (the
 *  `no_unexpected_files` pre-run baseline): the guard exists to keep hardlinked out-of-root CONTENT out
 *  of committed cassettes, which a path listing never reads. The baseline must include them — the
 *  post-run side walks a cpSync copy where every file is nlink=1 (the guard can't fire), so skipping
 *  them pre-run would report a pre-existing hardlinked file as agent-"created" (false stray). */
export interface WalkOpts {
  includeHardlinkPaths?: boolean;
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
  health?: WalkHealth,
): void {
  const walk = (abs: string, rel: string) => {
    // Cycle guard: resolve the real path of this directory; if we've already walked it, stop.
    let real: string;
    try {
      real = realpathSync(abs);
    } catch (err) {
      // ENOENT (prefix dir never created — the skill wrote nothing there) is a legitimate empty case, NOT
      // an evidence gap. Any other error (EACCES, EIO, …) means the subtree exists but couldn't be
      // observed — F18: record it so an absence-sensitive caller can tell the difference.
      if (health && !isMissingErr(err)) {
        health.complete = false;
        health.errors.push({ path: rel, error: errMsg(err) });
      }
      return;
    }
    // Containment: reject any entry whose realpath escapes the containment root. Catches prefix-level
    // symlinks (not caught by the child lstatSync below) and any other realpath-diverging construct.
    // Intentional security-skip, not an observation gap: does NOT mark health incomplete.
    if (real !== containReal && !real.startsWith(containReal + sep)) {
      warn(`::warning:: collectArtifacts: skipping "${rel}" — real path escapes work root\n`);
      if (health) health.containmentSkips.push(rel); // unobserved subtree, not proven empty
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);
    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch (err) {
      // prefix dir absent (skill wrote nothing there) — not an error; anything else IS (F18).
      if (health && !isMissingErr(err)) {
        health.complete = false;
        health.errors.push({ path: rel, error: errMsg(err) });
      }
      return;
    }
    for (const name of entries.sort()) {
      const childAbs = join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = lstatSync(childAbs); // lstat: does NOT follow symlinks
      } catch (err) {
        if (health && !isMissingErr(err)) {
          health.complete = false;
          health.errors.push({ path: childRel, error: errMsg(err) });
        }
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

/** F14/F16: package-level evidence-health for `captureAuthoredFilesWithHealth`, additive alongside the
 *  plain `AuthoredFile[]` list `captureAuthoredFiles` still returns. */
export interface AuthoredFilesHealth {
  /** Paths that WOULD have been captured (they passed the authored check) but were skipped because the
   *  total capture-size budget (`totalBytes`) was already exhausted — distinguishes "nothing else was
   *  authored" from "the list is truncated". */
  omittedPaths: string[];
  /** true iff `omittedPaths` is non-empty, i.e. the total cap was hit before every authored candidate
   *  could be captured. */
  totalCapExhausted: boolean;
  /** Per-path errors encountered reading back an authored file's final on-disk content. Distinguishes
   *  "this run authored no such file" from "it existed and was authored, but became unreadable at
   *  read-back time" (F16) — previously a bare `catch {}` with no trace either way. */
  readErrors: { path: string; error: string }[];
  /** PRE-EXISTING files whose POST-run hash could not be computed (over-cap or unreadable), so whether
   *  the agent modified them is UNKNOWN. Previously these were silently classified "not authored" and
   *  dropped — hiding a modified-then-unreadable/over-cap artifact from `no_lost_write_back` and the judge.
   *  They are now captured (content bounded-read via `pushFile`) and listed here so authorship reads as
   *  unknown, not false; the dependent assertions still analyze the captured content. */
  hashUnknownPaths: string[];
  /** per-path errors from the SCRATCHPAD deliverable walk (realpath/readdir/lstat failures). An
   *  unreadable scratchpad subtree no longer vanishes silently — an absence-sensitive assertion can treat
   *  it as evidence-unavailable rather than "nothing was authored there". */
  scratchpadWalkErrors: { path: string; error: string }[];
  /** scratchpad deliverables SKIPPED because they are a symlink/hardlink (never followed — escape/cycle
   *  guard, mirroring the artifact walk). A skill can write a deliverable through such a link; recording it
   *  lets a dependent assertion avoid a false clean over an artifact it never observed. */
  scratchpadSkippedLinks: string[];
  /** path-scoped errors from the user-visible-roots walk that produced the authored set (an unreadable
   *  subtree, EACCES/EIO). An authored file inside such a subtree is never enumerated, so a dependent
   *  absence-sensitive assertion must treat this as evidence-unavailable, not "nothing authored there". */
  workspaceWalkErrors: { path: string; error: string }[];
  /** F17: true when the scratchpad walk was skipped because this is a `--resume` (the reused session root
   *  makes prior-turn scratchpad files unattributable). Scratchpad deliverables are absent-by-policy, not
   *  absent-in-fact — informational (does NOT force a semantic verdict to evidence-unavailable). */
  scratchpadSkippedOnResume?: boolean;
}

export interface CaptureAuthoredFilesResult {
  files: AuthoredFile[];
  health: AuthoredFilesHealth;
}

/** True iff any evidence-health signal is set — i.e. the capture was NOT fully clean. The lanes persist
 *  `health` only when this holds (an all-clean capture stays `undefined`, the "nothing to report" signal
 *  every consumer already expects). One helper so a newly-added health field can't be forgotten at a
 *  persistence site (execute.ts / cli.ts verify-run) and silently dropped. */
export function authoredFilesHealthNonEmpty(h: AuthoredFilesHealth): boolean {
  return Boolean(
    h.omittedPaths.length ||
    h.readErrors.length ||
    h.hashUnknownPaths.length ||
    h.scratchpadWalkErrors.length ||
    h.scratchpadSkippedLinks.length ||
    h.workspaceWalkErrors.length ||
    h.scratchpadSkippedOnResume,
  );
}

/** Default TOTAL authored-file capture budget. Deliberately small: this content is composed into a
 *  document sent to an EXTERNAL judge model, so it is a cost, latency and disclosure surface, not just a
 *  memory bound. A run whose deliverable legitimately exceeds it raises the budget explicitly. */
export const DEFAULT_AUTHORED_TOTAL_BYTES = 64 * 1024;
/** Default PER-FILE cap. Internal only — no flag. Once an `evidence_files` scope exists, the file a
 *  rubric is about is exempt from this cap anyway (see `priorityGlobs`), and tuning the bound on files
 *  nobody is grading has no use case. */
export const DEFAULT_AUTHORED_PER_FILE_BYTES = 16 * 1024;

/** Shared positive-integer validator for the authored-file capture budget, used by BOTH the
 *  `--authored-total-bytes` flag and `COWORK_HARNESS_AUTHORED_TOTAL_BYTES` so the two cannot diverge —
 *  same shape as `parseMaxArtifactBytes` for the artifact-body cap. Returns null when invalid. */
export function parseAuthoredTotalBytes(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/** The effective total capture budget. THROWS on a malformed env value rather than warning and falling
 *  back (which is what `envPositiveNumber` does): a silently-defaulted EVIDENCE budget resurfaces much
 *  later as an unexplained "evidence unavailable" refusal, with nothing pointing at the typo that caused
 *  it. Mirrors `defaultBodyCap`'s posture for the artifact-body cap. */
export function authoredTotalBytes(): number {
  const env = process.env.COWORK_HARNESS_AUTHORED_TOTAL_BYTES;
  if (env !== undefined && env.trim() !== "") {
    const n = parseAuthoredTotalBytes(env);
    if (n === null) throw new Error(`COWORK_HARNESS_AUTHORED_TOTAL_BYTES must be a positive integer (got ${JSON.stringify(env)})`);
    return n;
  }
  return DEFAULT_AUTHORED_TOTAL_BYTES;
}

export interface CaptureAuthoredFilesOpts {
  perFileBytes?: number;
  totalBytes?: number;
  /** Globs (full authored-path form, `<root>/<rel>` or `scratchpad/<rel>`) naming the files a
   *  `semantic_matches.evidence_files` scope will actually grade. Two effects, both only on the size
   *  budget — NEVER on which files are classified authored:
   *    1. matching candidates are captured FIRST, so the budget is spent on the evidence the scenario
   *       asserts over instead of on whatever the walk reaches first (the walk is prefix-major then
   *       alphabetical, so an `_work/`-style intermediates dir otherwise starves the deliverable);
   *    2. matching candidates are EXEMPT from `perFileBytes`, bounded only by the remaining total — a
   *       16 KiB slice of an 87 KB report is not gradable evidence, and capturing a truncated prefix
   *       while reporting a clean capture is a false green (the judge would grade the tail's absence).
   *  A matching file that still doesn't fit the TOTAL is captured truncated and flagged `truncated`, which
   *  the scoped assert treats as evidence-unavailable. Omitted/empty leaves the capture unchanged — but the
   *  capture is SHARED across a scenario's asserts, so globs contributed by one assert change the byte
   *  budget every other assert's evidence is drawn from (`evaluate` warns on a mixed scenario). */
  priorityGlobs?: string[];
  scratchpadRoot?: string;
  /** F17: true when this run is a `--resume`. A resumed session reuses the PRIOR turn's session root with
   *  no per-turn scratchpad manifest, so a scratchpad file from an earlier turn is indistinguishable from
   *  one this turn wrote — classifying it as authored would misattribute it to the current turn. When
   *  true, the scratchpad walk is skipped entirely (evidence-unavailable is safer than misattribution);
   *  the `userVisibleRoots` capture above is unaffected (that side already diffs against the pre-run
   *  manifest, which correctly stays as-of the FIRST turn on resume — see capturePreRunManifest). */
  resume?: boolean;
  /** F15: per-path mtime+size captured in the pre-run manifest (`readPreRunManifestStats`). Lets a
   *  `preRunHashes[path] === null` entry (the pre-run capture couldn't hash this path — over-cap or
   *  unreadable) still be disambiguated: an exact post-run stat match proves "unchanged" even without a
   *  comparable hash. Omitted/absent-for-a-path → that path's authorship is judged with no stat signal
   *  at all (see the F15 branch below). */
  preRunStats?: Record<string, { mtimeMs: number; size: number } | null>;
}

/** Files the run CREATED or MODIFIED under user-visible roots (added/modified vs the pre-run manifest),
 *  read back at their final on-disk content. Excludes read-only inputs (unchanged mounts). Size-bounded:
 *  a per-file cap and a total cap; over-cap content is truncated and flagged. Returns `[]` when there is
 *  no pre-run manifest (e.g. a --resume run) — no diff is possible, so the caller notes evidence-unavailable
 *  rather than dumping the whole workspace. Must be called AFTER the run completes (files finalized).
 *
 *  `scratchpadRoot` (the session root, i.e. the PARENT of the `mnt` workspace) closes a real coin-flip: at
 *  container/hostloop fidelity the agent's cwd is the session root, NOT `mnt`, so a relative `Write
 *  outputs/x` lands in the scratchpad — outside `workRoot`/`userVisibleRoots` and thus previously uncaptured
 *  (SPEC/plan §R2 H2). When provided, we also capture non-dotfile deliverables directly under it. The
 *  scratchpad is staged empty except `mnt/`, so a non-dot file there was authored this run; dot-prefixed
 *  entries (`.claude`, `.cache`, XDG state — the agent's $HOME runtime noise) and the `mnt` subtree
 *  (already captured above) are excluded. Everything is scrubbed downstream before it reaches a judge.
 *
 *  Thin wrapper around `captureAuthoredFilesWithHealth` that keeps the original `AuthoredFile[]` return
 *  shape — the stable entry point every existing caller already uses. */
export function captureAuthoredFiles(
  workRoot: string,
  userVisibleRoots: string[],
  readonlyFolderRoots: string[],
  preRunHashes: Record<string, string | null> | undefined,
  opts: CaptureAuthoredFilesOpts = {},
): AuthoredFile[] {
  return captureAuthoredFilesWithHealth(workRoot, userVisibleRoots, readonlyFolderRoots, preRunHashes, opts).files;
}

/** Like `captureAuthoredFiles`, but also returns the F14/F16 evidence-health object (omitted-file
 *  bookkeeping + per-path read-back errors) alongside the file list. See `captureAuthoredFiles`'s doc
 *  comment for the full behavior; this is the same walk with richer bookkeeping. */
export function captureAuthoredFilesWithHealth(
  workRoot: string,
  userVisibleRoots: string[],
  readonlyFolderRoots: string[],
  preRunHashes: Record<string, string | null> | undefined,
  opts: CaptureAuthoredFilesOpts = {},
): CaptureAuthoredFilesResult {
  const health: AuthoredFilesHealth = {
    omittedPaths: [],
    totalCapExhausted: false,
    readErrors: [],
    hashUnknownPaths: [],
    scratchpadWalkErrors: [],
    scratchpadSkippedLinks: [],
    workspaceWalkErrors: [],
  };
  if (preRunHashes === undefined) return { files: [], health }; // no pre-run manifest → can't diff → no capture
  const perFile = opts.perFileBytes ?? DEFAULT_AUTHORED_PER_FILE_BYTES;
  const total = opts.totalBytes ?? DEFAULT_AUTHORED_TOTAL_BYTES;
  const out: AuthoredFile[] = [];
  let used = 0;

  // F13: bounded read — stat first, then read only the allowed prefix via a capped fd read. Previously
  // this `readFileSync`'d the WHOLE file before slicing to the cap: the cap bounded only the RETAINED
  // evidence, not the memory spent producing it, so a huge authored file still spiked memory just to keep
  // 16 KiB of it.
  const pushFile = (absPath: string, relPath: string, exemptPerFile = false): void => {
    if (used >= total) {
      // F14: record what got skipped once the total budget is gone, instead of a silent drop.
      health.omittedPaths.push(relPath);
      health.totalCapExhausted = true;
      return;
    }
    // A priority (in-scope) file is bounded by the REMAINING TOTAL only — see `priorityGlobs`. The
    // per-file cap exists to bound memory on an incidental large file; for the one file a rubric is
    // actually about, a 16 KiB prefix is worse than useless (it grades as a partial document).
    const allowed = exemptPerFile ? total - used : Math.min(perFile, total - used);
    let fd: number | undefined;
    try {
      const size = statSync(absPath).size;
      const toRead = Math.min(allowed, size);
      const buf = Buffer.alloc(toRead);
      let bytesRead = 0;
      if (toRead > 0) {
        fd = openSync(absPath, "r");
        bytesRead = readSync(fd, buf, 0, toRead, 0);
      }
      const truncated = size > bytesRead;
      out.push({ path: relPath, content: buf.subarray(0, bytesRead).toString("utf8"), ...(truncated ? { truncated: true } : {}) });
      used += bytesRead;
    } catch (err) {
      // F16: unreadable at read-back → record it (distinguishes "no such authored file" from "existed but
      // became unreadable") instead of a silent `catch {}` omission.
      health.readErrors.push({ path: relPath, error: errMsg(err) });
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          /* best-effort close — the read already happened (or failed) above */
        }
      }
    }
  };

  // ONE ordered candidate list, workspace THEN scratchpad, built before any byte of budget is spent.
  // Classification runs exactly once per file (below); this list only decides the ORDER `pushFile` is
  // called in. Collecting the scratchpad into the same list is what lets a session-root deliverable be
  // prioritised at all — it is walked last, so a two-pass over the workspace list alone could never
  // reach it.
  const candidates: Array<{ absPath: string; relPath: string }> = [];

  // health-aware classify — a nested unreadable subtree records walkErrors (an authored file there is
  // never enumerated), so no_lost_write_back fails evidence-unavailable rather than a false clean.
  const classified = classifyWorkspaceFilesWithHealth(workRoot, userVisibleRoots, readonlyFolderRoots);
  for (const e of classified.walkErrors) health.workspaceWalkErrors.push(e);
  for (const f of classified.files) {
    if (f.class === "input") continue; // read-only mount — not authored by this run
    const sha = (f as { sha256?: string }).sha256;
    const prior = preRunHashes[f.path]; // undefined = new file; null = unavailable pre-run; string = prior hash
    let authored: boolean;
    if (prior === undefined) {
      authored = true; // no pre-run entry at all → genuinely new path
    } else if (prior !== null) {
      if (sha === undefined) {
        // the POST-run hash failed (over-cap or unreadable) for a PRE-EXISTING file, so whether the
        // agent modified it is UNKNOWN. The old `sha !== undefined && ...` classified it "not authored" and
        // dropped it — hiding a modified-then-unreadable/over-cap artifact from no_lost_write_back and the
        // judge. Treat authorship as unknown: record it and capture it (bounded read below) so downstream
        // analysis still sees the changed content, instead of a false "not authored".
        health.hashUnknownPaths.push(f.path);
        authored = true;
      } else {
        authored = sha !== prior; // normal before/after hash compare
      }
    } else {
      // F15: prior === null means the pre-run capture couldn't hash this path (over-cap or unreadable) —
      // an UNKNOWN baseline, not a "no file existed" signal. Blindly treating it as authored (the prior
      // behavior) misattributes an unchanged large/unreadable input to this run. Disambiguate with the
      // pre-run mtime+size when the caller supplied it (`opts.preRunStats`, sourced from
      // `readPreRunManifestStats`): an EXACT post-run match proves "unchanged" even without a hash. With
      // no comparable signal at all, the conservative call is "not authored" — evidence-unavailable is
      // safer than a false claim of authorship.
      const preStat = opts.preRunStats?.[f.path];
      if (preStat) {
        let postStat: { mtimeMs: number; size: number } | undefined;
        try {
          const st = statSync(join(workRoot, f.path));
          postStat = { mtimeMs: st.mtimeMs, size: st.size };
        } catch {
          postStat = undefined;
        }
        authored = postStat === undefined || postStat.mtimeMs !== preStat.mtimeMs || postStat.size !== preStat.size;
      } else {
        authored = false;
      }
    }
    if (!authored) continue;
    candidates.push({ absPath: join(workRoot, f.path), relPath: f.path });
  }

  // Scratchpad deliverables (cwd-relative writes outside mnt). Walk the session root, skipping dot-entries
  // (runtime $HOME state) and the `mnt` subtree; symlinks/hardlinks are not followed (escape/cycle guard,
  // mirroring collectArtifactPaths).
  // F17: skip entirely on resume — see `CaptureAuthoredFilesOpts.resume`'s doc comment. Record the skip in
  // health so a consumer knows scratchpad deliverables are absent-by-policy (not absent-in-fact).
  if (opts.scratchpadRoot && opts.resume) health.scratchpadSkippedOnResume = true;
  if (opts.scratchpadRoot && !opts.resume) {
    const found = walkScratchpadFiles(opts.scratchpadRoot);
    health.scratchpadWalkErrors.push(...found.errors);
    health.scratchpadSkippedLinks.push(...found.skippedLinks);
    for (const f of found.files) candidates.push({ absPath: f.absPath, relPath: f.relPath });
  }

  // TWO PASSES over the ONE candidate list — in-scope files first (exempt from the per-file cap), then
  // everything else. Deliberately two passes over an already-built list rather than re-running the
  // classification loop with a filter: re-running it would re-execute the F15 stat branch and
  // double-push `health.hashUnknownPaths`, inflating the count the judge's evidence-health note and the
  // refusal message report.
  const priority = opts.priorityGlobs ?? [];
  const inScope = (relPath: string): boolean => priority.length > 0 && anyGlobMatches(priority, relPath);
  for (const c of candidates) if (inScope(c.relPath)) pushFile(c.absPath, c.relPath, true);
  for (const c of candidates) if (!inScope(c.relPath)) pushFile(c.absPath, c.relPath, false);
  // Stable, order-independent bookkeeping: `omittedPaths` is reported to the judge and quoted in the
  // refusal message, so it must not depend on which pass a file happened to be dropped in.
  health.omittedPaths.sort();
  return { files: out, health };
}

/** ONE traversal of the scratchpad (the session root outside `mnt`), shared by authored-file capture
 *  (which reads content) and workspace classification (which hashes metadata). Extracted rather than
 *  duplicated: the dotfile skip, the `mnt` exclusion, and the symlink/hardlink escape guards are the
 *  security-relevant part, and two copies would drift.
 *
 *  Emits `scratchpad/<rel>` paths — the same synthetic prefix authored-file capture has always used, so
 *  a path means the same thing in both places. */
export function walkScratchpadFiles(scratchpadRoot: string): {
  files: Array<{ absPath: string; relPath: string }>;
  errors: Array<{ path: string; error: string }>;
  skippedLinks: string[];
} {
  const files: Array<{ absPath: string; relPath: string }> = [];
  const errors: Array<{ path: string; error: string }> = [];
  const skippedLinks: string[] = [];
  {
    const visited = new Set<string>();
    const walk = (absDir: string, relDir: string): void => {
      let real: string;
      try {
        real = realpathSync(absDir);
      } catch (err) {
        // a directory that exists but can't be resolved (EACCES, EIO) is an evidence gap, not "empty".
        // ENOENT (the scratchpad root simply has nothing) is a legitimate empty case — don't record it.
        if (!isMissingErr(err)) errors.push({ path: relDir || ".", error: errMsg(err) });
        return;
      }
      if (visited.has(real)) return;
      visited.add(real);
      let entries: string[];
      try {
        entries = readdirSync(absDir).sort();
      } catch (err) {
        if (!isMissingErr(err)) errors.push({ path: relDir || ".", error: errMsg(err) });
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
        } catch (err) {
          if (!isMissingErr(err)) errors.push({ path: childRel, error: errMsg(err) });
          continue;
        }
        if (st.isSymbolicLink()) {
          skippedLinks.push(`scratchpad/${childRel}`); // not followed (may escape/cycle) — but recorded
          continue;
        }
        if (st.isDirectory()) walk(childAbs, childRel);
        else if (st.isFile()) {
          if (st.nlink > 1) {
            skippedLinks.push(`scratchpad/${childRel}`); // hardlink → may reference out-of-root content
            continue;
          }
          files.push({ absPath: childAbs, relPath: `scratchpad/${childRel}` });
        }
      }
    };
    walk(scratchpadRoot, "");
  }
  return { files, errors, skippedLinks };
}
