import { spawnSync } from "node:child_process";
import { relative, sep } from "node:path";

/**
 * Git-tracked file-set resolver (staleness redesign, default-ON).
 *
 * The durable boundary for "what is a skill" is the **git-tracked** set: files committed/staged in the repo,
 * which is exactly what ships to other consumers and to real Cowork. Untracked files (OS-junk, build outputs,
 * scratch, not-yet-`git add`-ed) are excluded — eliminating this drift class at the source.
 *
 * SAFETY: excluding untracked files from the HASH is only safe if every DELIVERY path also
 * excludes them (else a delivered-but-unhashed file is a false-negative). So the SAME resolver feeds both
 * the hash (skill-hash.ts) and the mount-copy filters (session.ts / stage.ts / protocol.ts).
 * Enabled by default; opt out with COWORK_HARNESS_GITSET=0.
 */
export const GITSET_ENV = "COWORK_HARNESS_GITSET";

/** v6: git-tracked mode is the DEFAULT (the portable boundary). A dir that isn't a usable git work tree
 *  falls back to raw automatically (gitTrackedSet → null), so non-repo skills are unaffected. Opt OUT with
 *  COWORK_HARNESS_GITSET=0 (legacy raw walk for every dir). Read at the seam so tests can toggle it. */
export function gitModeEnabled(): boolean {
  return process.env[GITSET_ENV] !== "0";
}

function git(args: string[], cwd: string): { ok: boolean; stdout: string } {
  try {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    // Non-zero exit OR any spawn error (missing git, corrupt .git, perms) ⇒ not usable → caller falls to raw.
    if (r.status !== 0 || r.error) return { ok: false, stdout: "" };
    return { ok: true, stdout: r.stdout ?? "" };
  } catch {
    return { ok: false, stdout: "" };
  }
}

/**
 * The set of git-TRACKED files under `dir`, as `dir`-relative POSIX paths, or `null` when `dir` is not in a
 * usable git work tree (not a repo, no git binary, corrupt/locked .git) — in which case the caller MUST fall
 * back to the raw walk (today's behavior). Tracked = in the index (committed or `git add`-staged); content is
 * still read from the working tree by the caller, so a tracked file with uncommitted edits still counts.
 */
export function gitTrackedSet(dir: string): Set<string> | null {
  const top = git(["rev-parse", "--show-toplevel"], dir);
  if (!top.ok) return null; // not a repo / no git binary → raw fallback (legitimate, unchanged)
  const ls = git(["ls-files", "-z", "--", "."], dir);
  if (!ls.ok)
    // `rev-parse --show-toplevel` SUCCEEDED, so this dir IS inside a git work tree — but `ls-files`
    // failed. That is NOT a non-repo (the first check handles those); it's a repo whose tracked set
    // can't be listed (corrupt/locked index, or a permissions problem). Silently raw-copying here would
    // change the delivered/hashed boundary with no signal — and this set feeds BOTH the hash walk
    // (skill-hash.ts) and the mount-copy filter, so a silent fallback could desync them. Fail loud. #34
    throw new Error(
      `cowork-harness: git work tree at "${top.stdout.trim() || dir}" is present but 'git ls-files' failed — the tracked-file boundary cannot be computed (corrupt/locked .git or a permissions problem). Fix the repo, or set ${GITSET_ENV}=0 to force the raw-walk boundary.`,
    );
  const set = new Set<string>();
  for (const f of ls.stdout.split("\0")) {
    if (!f) continue;
    // `ls-files -- .` from cwd=dir already yields dir-relative paths; normalize separators to POSIX.
    set.add(f.split(sep).join("/"));
  }
  return set;
}

/**
 * An accept predicate over a `dir`-relative POSIX path that admits a tracked FILE and any ANCESTOR DIRECTORY
 * of a tracked file (so a recursive walk/copy descends into it), and rejects everything else (untracked files
 * + dirs that hold nothing tracked). Shared by the hash walk (skill-hash.ts) and the mount-copy filter so the
 * hashed set and the delivered set are identical under git mode.
 */
export function gitAccept(tracked: Set<string>): (rel: string) => boolean {
  return (rel: string) => {
    if (rel === "" || tracked.has(rel)) return true; // root, or a tracked file
    const prefix = rel + "/";
    for (const t of tracked) if (t.startsWith(prefix)) return true; // an ancestor dir of a tracked file
    return false;
  };
}

/**
 * A `cpSync` `filter` (Node ≥16.7) that admits only git-tracked files under `srcRoot` (plus the ancestor dirs
 * needed to reach them), or `null` when `srcRoot` isn't a usable repo (caller copies raw). Used at the
 * mount-copy sites so the delivered set matches the hashed set under git mode — closing the
 * false-negative. Symlinks/escaping are handled by the existing containment checks at the call sites.
 */
/**
 * Build a `cpSync` filter from an ALREADY-RESOLVED tracked set — so a caller that already paid for
 * `gitTrackedSet`/`gitStageStats` reuses that one snapshot. This is what keeps the staged-set count
 * equal to the delivered set: no second `git ls-files`, no TOCTOU between "what we counted" and "what we
 * copied".
 */
export function gitFilterFromSet(srcRoot: string, tracked: Set<string>): (src: string, dest: string) => boolean {
  const accept = gitAccept(tracked);
  return (src: string) => {
    if (src === srcRoot) return true;
    const rel = relative(srcRoot, src).split(sep).join("/");
    if (!rel || rel.startsWith("..")) return true; // defensive: never exclude something outside our reckoning
    return accept(rel);
  };
}

export function gitCpFilter(srcRoot: string): ((src: string, dest: string) => boolean) | null {
  const tracked = gitTrackedSet(srcRoot);
  if (!tracked) return null;
  return gitFilterFromSet(srcRoot, tracked);
}

/**
 * The git-tracked set under `dir` PLUS the count of untracked (excluded) files — both from one pair of
 * `git` calls. Returns `{tracked:null, untracked:0}` when `dir` is not a usable git work tree (caller
 * falls back to a raw copy). Feeds the empty-mount staging guard: `tracked.size === 0` ⇒ the plugin/skill would
 * mount EMPTY (hard-fail); `untracked > 0` ⇒ files excluded that real Cowork won't see (loud notice).
 */
export function gitStageStats(dir: string): { tracked: Set<string> | null; untracked: number } {
  const tracked = gitTrackedSet(dir);
  if (!tracked) return { tracked: null, untracked: 0 };
  const others = git(["ls-files", "-z", "--others", "--exclude-standard", "--", "."], dir);
  const untracked = others.ok ? others.stdout.split("\0").filter(Boolean).length : 0;
  return { tracked, untracked };
}
