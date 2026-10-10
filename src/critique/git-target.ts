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
import { mkdtempSync, mkdirSync, readdirSync, lstatSync, rmSync, realpathSync, existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, basename, sep, posix, isAbsolute } from "node:path";
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
  /** Removes the snapshot whatever `keep` says: for a refusal before the graded run starts, which leaves nothing that
   *  needs the snapshot. */
  discard: () => void;
}

const FLAG = "critique";

function git(args: string[], cwd: string): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: gitEnvWithoutAmbientRepo(), maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? "" };
}

/** Where kept snapshots live: `~/.cowork-harness/critique-snapshots`, or `COWORK_HARNESS_CRITIQUE_SNAPSHOTS_DIR`.
 *  Never under the runs root, so `prune` and the runs walk never read a snapshot as a run. Nothing removes a kept
 *  snapshot: delete one once the runs that mounted it are gone. */
export function critiqueSnapshotsRoot(): string {
  const env = process.env.COWORK_HARNESS_CRITIQUE_SNAPSHOTS_DIR;
  if (env !== undefined && env !== "") return resolve(env);
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
  // A `filter=` on a line that is not a comment. An attribute line is `<pattern> <attr>…`; `-filter` / `!filter`
  // unset it and do not count.
  const setsFilter = (body: string): boolean => body.split("\n").some((l) => !/^\s*#/.test(l) && /(^|\s)filter=/.test(l));
  const refuse = (where: string) => {
    throw new Error(
      `${FLAG} ${raw}: ${where} sets a git filter (e.g. LFS); a snapshot holds the stored content, not what a checkout would give the agent. Critique the working tree instead.`,
    );
  };
  // Attributes outside the commit apply too: the repository's own info/attributes and the user's core.attributesFile.
  const gitDir = git(["rev-parse", "--absolute-git-dir"], top).out.trim();
  const local = gitDir ? join(gitDir, "info", "attributes") : "";
  if (local && existsSync(local) && setsFilter(readFileSync(local, "utf8"))) refuse(".git/info/attributes");
  const cfg = git(["config", "--get", "core.attributesFile"], top).out.trim();
  if (cfg) {
    const f = cfg.startsWith("~/") ? join(homedir(), cfg.slice(2)) : isAbsolute(cfg) ? cfg : join(top, cfg);
    if (existsSync(f) && setsFilter(readFileSync(f, "utf8"))) refuse(`core.attributesFile (${cfg})`);
  }
  const ls = git(["ls-tree", "-r", "-z", "--name-only", "--full-tree", commit], top);
  // Fail closed: a listing we could not read is not evidence that no filter applies.
  if (!ls.ok) throw new Error(`${FLAG} ${raw}: could not list ${commit.slice(0, 12)} to check its .gitattributes`);
  const listing = ls.out.split("\0").filter(Boolean);
  // An attributes file applies to its own directory and below: in scope when it sits under `path`, or in `path`
  // itself or any directory above it.
  const inScope = (f: string): boolean => {
    const d = posix.dirname(f);
    return path === "." || d === "." || f.startsWith(`${path}/`) || path === d || path.startsWith(`${d}/`);
  };
  for (const f of listing.filter((x) => posix.basename(x) === ".gitattributes" && inScope(x))) {
    const body = git(["show", `${commit}:${f}`], top);
    if (!body.ok) throw new Error(`${FLAG} ${raw}: could not read ${f} at ${commit.slice(0, 12)}`);
    if (setsFilter(body.out)) refuse(`${f} at ${commit.slice(0, 12)}`);
  }
}

/** Refuse a committed symlink whose REAL path (every link in the chain followed) is outside the snapshot, or that
 *  points at nothing: it would hand the agent whatever is at that path on this machine, or a broken link. A lexical
 *  check is not enough — `a -> b/../..` through another link can climb out while reading as inside. */
function refuseEscapingSymlinks(root: string, raw: string): void {
  const rootReal = realpathSync(root);
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) {
        const rel = p.slice(resolve(root).length + 1);
        let real: string;
        try {
          real = realpathSync(p);
        } catch {
          throw new Error(`${FLAG} ${raw}: ${rel} is a symlink that points at nothing at this commit`);
        }
        if (real !== rootReal && !real.startsWith(rootReal + sep))
          throw new Error(`${FLAG} ${raw}: ${rel} is a symlink that points outside ${posix.basename(root)} at this commit`);
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
  if (opts.keep) mkdirSync(parent, { recursive: true });
  // The stager resolves the tracked set by walking up from a mount, so a snapshot inside ANY work tree would be
  // delivered as that tree's tracked subset: nothing.
  if (isInsideGitWorkTree(parent)) {
    rmSync(parent, { recursive: true, force: true });
    throw new Error(
      `${FLAG} ${arg}: the snapshot directory ${parent} is inside a git work tree; ` +
        (opts.keep
          ? "set COWORK_HARNESS_CRITIQUE_SNAPSHOTS_DIR to a directory outside any repository"
          : "set TMPDIR to a directory outside any repository"),
    );
  }
  const discard = () => rmSync(parent, { recursive: true, force: true });
  const cleanup = () => {
    if (!opts.keep) discard();
  };
  try {
    const info = snapshotGitArm({ ref: commit, path: snapPath }, dest, top, arg, FLAG);
    refuseEscapingSymlinks(dest, arg);
    return {
      skillFolder: dest,
      ...(selector !== undefined ? { skillSelector: selector } : {}),
      source: { kind: "git", ref: src.ref, path: snapPath, commit: info.commit! },
      cleanup,
      discard,
    };
  } catch (e) {
    rmSync(parent, { recursive: true, force: true });
    throw e;
  }
}

/** True when a positional names a git target. */
export const isGitTarget = (arg: string): boolean => arg.startsWith("git:");
