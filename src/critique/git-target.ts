// `critique git:<ref>:<path>`: critique the skill as it was at a commit, not as the working tree is now. The
// commit's files are written to a snapshot directory (eval's `snapshotGitArm`) and critique runs on that, so an
// edit, a `git add` or a moved HEAD during the run cannot change what is graded, and two critiques of the same
// commit grade the same files.
//
// A skill inside a plugin is resolved IN THE COMMIT'S TREE the way the folder form resolves it on disk: a path at
// `<plugin>/skills/<name>` snapshots the whole plugin and grades skill `<name>` — the same mount, corpus and graded
// skill as `critique <plugin> --skill <name>`. Snapshotting the skill folder alone would lose the plugin's agents and
// shared references, and grade a different thing from the folder form of the same commit.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readlinkSync, lstatSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, dirname, basename, sep, posix } from "node:path";
import { randomUUID } from "node:crypto";
import { parseSource, snapshotGitArm, isInsideGitWorkTree } from "../eval/snapshot.js";
import { gitEnvWithoutAmbientRepo } from "../run/skill-files.js";

export interface GitTargetSource {
  kind: "git";
  ref: string;
  /** The repo-relative path that was snapshotted (the plugin root when the argument named a skill in it). */
  path: string;
  /** The resolved commit id. */
  commit: string;
}

export interface StagedGitTarget {
  /** The snapshot directory critique runs on (the plugin root, or the plain skill folder). */
  skillFolder: string;
  /** Set when the argument named `<plugin>/skills/<name>`: the skill to grade inside the snapshotted plugin. */
  skillSelector?: string;
  source: GitTargetSource;
  /** Removes a throwaway snapshot (`--corpus-only`); a no-op for a kept one. */
  cleanup: () => void;
}

const FLAG = "critique";

function git(args: string[], cwd: string): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: gitEnvWithoutAmbientRepo(), maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? "" };
}

/** Where kept snapshots live: beside the runs root, never inside it, so `prune` and the runs walk never read a
 *  snapshot as a run. */
export function critiqueSnapshotsRoot(): string {
  return join(homedir(), ".cowork-harness", "critique-snapshots");
}

const hasManifest = (commit: string, dir: string, top: string): boolean =>
  [".claude-plugin/plugin.json", "plugin.json"].some(
    (m) => git(["cat-file", "-e", `${commit}:${dir === "." ? m : `${dir}/${m}`}`], top).ok,
  );

/** The nearest directory at or above `path`, in the commit's tree, that carries a plugin manifest. */
function enclosingPluginInCommit(commit: string, path: string, top: string): string | null {
  let dir = path;
  for (;;) {
    if (hasManifest(commit, dir, top)) return dir;
    if (dir === ".") return null;
    const up = posix.dirname(dir);
    dir = up === "" ? "." : up;
  }
}

/** Refuse a commit whose files under `path` would not be the bytes the working tree gives: a `.gitattributes`
 *  filter (Git LFS and similar) stores a pointer in the commit and the real content only after a smudge, which a
 *  snapshot does not run — the agent would be handed pointer files. */
function refuseFilteredContent(commit: string, path: string, top: string, raw: string): void {
  const listing = git(["ls-tree", "-r", "-z", "--name-only", "--full-tree", commit], top).out.split("\0").filter(Boolean);
  // An attributes file applies to its own directory and below: in scope when it sits under `path`, or in `path`
  // itself or any directory above it.
  const inScope = (f: string): boolean => {
    const d = posix.dirname(f);
    return path === "." || d === "." || f.startsWith(`${path}/`) || path === d || path.startsWith(`${d}/`);
  };
  for (const f of listing.filter((x) => posix.basename(x) === ".gitattributes" && inScope(x))) {
    const body = git(["show", `${commit}:${f}`], top).out;
    if (/(^|\s)filter=/m.test(body))
      throw new Error(
        `${FLAG} ${raw}: ${f} at ${commit.slice(0, 12)} sets a git filter (e.g. LFS); a snapshot holds the stored pointer, not the content the agent would get. Critique the working tree instead.`,
      );
  }
}

/** Refuse a committed symlink that points outside the snapshot: it would hand the agent whatever is at that path on
 *  this machine, or nothing. */
function refuseEscapingSymlinks(root: string, raw: string): void {
  const rootAbs = resolve(root);
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) {
        const target = resolve(dirname(p), readlinkSync(p));
        if (target !== rootAbs && !target.startsWith(rootAbs + sep))
          throw new Error(
            `${FLAG} ${raw}: ${p.slice(rootAbs.length + 1)} is a symlink that points outside ${posix.basename(rootAbs)} at this commit`,
          );
      } else if (st.isDirectory()) walk(p);
    }
  };
  walk(root);
}

/** Snapshot a `git:<ref>:<path>` target. `keep: false` (for `--corpus-only`) writes to a temp dir the caller
 *  removes; otherwise the snapshot is kept under `critiqueSnapshotsRoot()` so the run's mount still resolves later.
 *  Throws an Error whose message is a usage refusal. */
export function stageGitTarget(arg: string, skillSelector: string | undefined, opts: { keep: boolean; cwd?: string }): StagedGitTarget {
  const cwd = opts.cwd ?? process.cwd();
  const src = parseSource(arg, arg, FLAG);
  if (src.kind !== "git") throw new Error(`${FLAG} ${arg}: not a git: target`);
  const top = git(["rev-parse", "--show-toplevel"], cwd).out.trim();
  if (!top) throw new Error(`${FLAG} ${arg}: a git: target needs the current directory to be inside a git work tree`);
  const commit = git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${src.ref}^{commit}`], top).out.trim();
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error(`${FLAG} ${arg}: "${src.ref}" does not name a commit in ${top}`);

  // Resolve the plugin in the COMMIT, the way the folder form resolves it on disk.
  let snapPath = src.path;
  let selector = skillSelector;
  const plugin = enclosingPluginInCommit(commit, src.path, top);
  if (plugin !== null && plugin !== src.path) {
    const rel = plugin === "." ? src.path : src.path.slice(plugin.length + 1);
    const at = /^skills\/([^/]+)$/.exec(rel);
    if (!at)
      throw new Error(
        `${FLAG} ${arg}: ${src.path} is inside plugin ${plugin} at ${commit.slice(0, 12)} but not at skills/<name>; critique the plugin with --skill: ${FLAG} git:${src.ref}:${plugin} --skill <name>`,
      );
    if (selector !== undefined && selector !== at[1])
      throw new Error(`${FLAG} ${arg}: --skill ${selector} disagrees with the skill the path names (${at[1]})`);
    snapPath = plugin;
    selector = at[1];
  }
  refuseFilteredContent(commit, snapPath, top, arg);

  const name = snapPath === "." ? basename(top) : posix.basename(snapPath);
  const parent = opts.keep ? join(critiqueSnapshotsRoot(), `crit-snap-${randomUUID()}`) : mkdtempSync(join(tmpdir(), "cwh-critique-snap-"));
  const dest = join(parent, name);
  if (opts.keep) {
    mkdirSync(parent, { recursive: true });
    // The stager resolves the tracked set by walking up from a mount, so a snapshot inside ANY work tree would be
    // delivered as that tree's tracked subset: nothing.
    if (isInsideGitWorkTree(parent)) {
      rmSync(parent, { recursive: true, force: true });
      throw new Error(`${FLAG} ${arg}: the snapshot directory ${parent} is inside a git work tree; move HOME's .cowork-harness out of it`);
    }
  }
  const cleanup = () => {
    if (!opts.keep) rmSync(parent, { recursive: true, force: true });
  };
  try {
    const info = snapshotGitArm({ ref: commit, path: snapPath }, dest, top, arg, FLAG);
    refuseEscapingSymlinks(dest, arg);
    return {
      skillFolder: dest,
      ...(selector !== undefined ? { skillSelector: selector } : {}),
      source: { kind: "git", ref: src.ref, path: snapPath, commit: info.commit! },
      cleanup,
    };
  } catch (e) {
    rmSync(parent, { recursive: true, force: true });
    throw e;
  }
}

/** True when a positional names a git target. */
export const isGitTarget = (arg: string): boolean => arg.startsWith("git:");
