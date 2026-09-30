// Arm sources and their snapshots for the paired evaluation.
//
// An arm is a plugin directory, taken either from the working tree (`<dir>`) or from a commit
// (`git:<ref>:<path>`). Each is COPIED once, before any spend, into `<eval-dir>/arms/<label>/<basename>/`, and
// every rep of that arm mounts the copy — so an edit to the source mid-eval cannot leak into later reps, and
// what was measured is on disk next to the report.
//
// The copy is the git-tracked set the stager would deliver (a source outside a work tree is copied whole),
// so the snapshot — which lives outside any work tree by refusal — is delivered and hashed by the raw walk
// over exactly the files the stager would have delivered from the source.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { UsageError } from "../errors.js";
import { gitEnvWithoutAmbientRepo, gitFilterFromSet, gitModeEnabled, gitStageStats } from "../run/skill-files.js";
import { tildeify } from "../io.js";

export const ARM_LABEL_RE = /^[a-z0-9_-]{1,32}$/;
const DEFAULT_LABELS = ["before", "after"] as const;

export type ArmSource = { kind: "dir"; path: string } | { kind: "git"; ref: string; path: string };

export interface ArmSpec {
  label: string;
  source: ArmSource;
  /** The `--arm` value as given. */
  raw: string;
}

/** Parse one `--arm` value: `<label>=<source>` or a bare `<source>` (labelled `before`/`after` by position).
 *  A `<source>` is a directory or `git:<ref>:<path>`. A prefix before `=` that is not a valid label is part
 *  of the source (a path may contain `=`). */
export function parseArmSpec(raw: string, position: number): ArmSpec {
  if (raw.trim() === "") throw new UsageError("--arm requires a value: <label>=<source>, or a bare <source>");
  const eq = raw.indexOf("=");
  let label: string | undefined;
  let src = raw;
  if (eq > 0 && ARM_LABEL_RE.test(raw.slice(0, eq))) {
    label = raw.slice(0, eq);
    src = raw.slice(eq + 1);
  } else if (eq > 0 && /^[A-Za-z0-9_-]+$/.test(raw.slice(0, eq)) && !raw.startsWith("git:")) {
    // Looks like a label, but not a valid one (uppercase, too long): say so rather than treat `Before=x` as a path.
    throw new UsageError(`--arm ${raw}: label "${raw.slice(0, eq)}" must match [a-z0-9_-]{1,32}`);
  }
  if (src === "") throw new UsageError(`--arm ${raw}: the source is empty`);
  return { label: label ?? DEFAULT_LABELS[position] ?? `arm${position + 1}`, source: parseSource(src, raw), raw };
}

function parseSource(src: string, raw: string): ArmSource {
  if (!src.startsWith("git:")) return { kind: "dir", path: src };
  const rest = src.slice("git:".length);
  const colon = rest.indexOf(":");
  if (colon <= 0) throw new UsageError(`--arm ${raw}: a git source is git:<ref>:<path> (e.g. git:HEAD:plugins/my-skill)`);
  const ref = rest.slice(0, colon);
  const path = rest.slice(colon + 1);
  validateGitRef(ref, raw);
  return { kind: "git", ref, path: normalizeRepoPath(path, raw) };
}

/** A ref is passed to git as an argv element, never through a shell; a leading `-` is still refused so it can
 *  never be read as an option, and `--end-of-options` backs that up where git accepts it. */
export function validateGitRef(ref: string, raw: string): void {
  if (ref.startsWith("-")) throw new UsageError(`--arm ${raw}: a git ref may not start with "-" (got "${ref}")`);
  // Control characters (NUL, newline) can never be part of a ref and would confuse the argv consumer.
  if (/[\x00-\x1f\x7f]/.test(ref)) throw new UsageError(`--arm ${raw}: the git ref contains a control character`);
}

/** A repo-relative path: no absolute path, no `..` segment, no leading `-`. `.` means the repo root. */
export function normalizeRepoPath(path: string, raw: string): string {
  if (path === "") throw new UsageError(`--arm ${raw}: the git source path is empty (use "." for the repository root)`);
  if (isAbsolute(path) || path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path))
    throw new UsageError(`--arm ${raw}: the git source path must be relative to the repository root (got "${path}")`);
  const segments = path.split(/[\\/]+/);
  if (segments.includes("..")) throw new UsageError(`--arm ${raw}: the git source path may not contain ".." (got "${path}")`);
  if (/[\x00-\x1f\x7f]/.test(path)) throw new UsageError(`--arm ${raw}: the git source path contains a control character`);
  const norm = posix.normalize(segments.join("/")).replace(/\/+$/, "");
  if (norm.startsWith("-")) throw new UsageError(`--arm ${raw}: the git source path may not start with "-"`);
  return norm === "" ? "." : norm;
}

/** Is `p` (or its nearest existing ancestor) inside a git work tree — ignored or not? The stager resolves the
 *  tracked set by walking up from a mount source, so a snapshot inside ANY work tree (a gitignored dir
 *  included) would deliver its tracked subset of the snapshot: nothing. Fails CLOSED: a git that cannot be
 *  spawned is not evidence the path is safe. */
export function isInsideGitWorkTree(p: string): boolean {
  let dir = resolve(p);
  while (!existsSync(dir)) {
    const up = dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
  if (!statSync(dir).isDirectory()) dir = dirname(dir);
  const r = spawnSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8", env: gitEnvWithoutAmbientRepo() });
  if (r.status === null || r.error) return true;
  if (r.status === 0) return r.stdout.trim() === "true";
  // Only git's own "not a repository" answer clears the path. Any other failure (a repository git refuses
  // to read, a corrupt one) says nothing about where the snapshots would land: refuse, with git's reason.
  if (/not a git repository/i.test(r.stderr ?? "")) return false;
  throw new UsageError(
    `could not tell whether ${tildeify(dir)} is inside a git work tree (git: ${(r.stderr ?? "").trim().split("\n")[0] || `exit ${r.status}`}); pass --out <dir> somewhere git can answer for`,
  );
}

export interface SnapshotInfo {
  /** Absolute path of the snapshot directory. */
  dir: string;
  /** Files copied into the snapshot. */
  fileCount: number;
  /** Untracked files left out (dir arms in a work tree, without `--include-untracked`). */
  untrackedExcluded: number;
  /** How the file set was chosen. */
  fileSet: "git-tracked" | "raw-walk" | "git-commit";
  /** The commit the content came from: `rev-parse <ref>` for a git arm, the work tree's HEAD for a dir arm
   *  in a repo (with `dirty`), absent otherwise. */
  commit?: string;
  dirty?: boolean;
  /** The source, `~`-relative for display and the manifest. */
  source: string;
  /** The on-disk directory the answer-key guard's location check runs against (a git arm: `<toplevel>/<path>`). */
  sourceDir?: string;
}

function countFiles(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(join(dir, e.name));
    else n += 1;
  }
  return n;
}

function gitOut(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: gitEnvWithoutAmbientRepo(),
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
}

function gitTry(args: string[], cwd: string): string | undefined {
  try {
    return gitOut(args, cwd);
  } catch {
    return undefined;
  }
}

/** Copy a directory arm. Without `includeUntracked`, a source inside a work tree contributes its git-tracked
 *  files only (the stager's delivery rule); outside a work tree, or with `includeUntracked`, the whole tree
 *  minus `.git` is copied (the raw walk). */
export function snapshotDirArm(srcPath: string, dest: string, includeUntracked: boolean, raw: string): SnapshotInfo {
  const src = resolve(srcPath);
  if (!existsSync(src)) throw new UsageError(`--arm ${raw}: source directory not found: ${tildeify(src)}`);
  if (!statSync(src).isDirectory()) throw new UsageError(`--arm ${raw}: source is not a directory: ${tildeify(src)}`);
  mkdirSync(dirname(dest), { recursive: true });
  const head = gitTry(["rev-parse", "HEAD"], src)?.trim();
  const dirty = head !== undefined ? (gitTry(["status", "--porcelain", "--", "."], src) ?? "").trim() !== "" : undefined;
  const commitFields = head ? { commit: head, dirty } : {};
  const noGitDir = (s: string) => !s.split(sep).includes(".git");
  if (!includeUntracked && gitModeEnabled()) {
    const { tracked, untracked } = gitStageStats(src);
    if (tracked) {
      if (tracked.size === 0)
        throw new UsageError(
          `--arm ${raw}: ${tildeify(src)} has 0 git-tracked files — the stager delivers tracked files only, so this arm would mount EMPTY. 'git add' it, or pass --include-untracked.`,
        );
      // verbatimSymlinks: a relative link stays relative (as a git: arm recreates it), so it cannot point back
      // into the live source; the answer-key guard refuses any link that resolves outside the snapshot.
      cpSync(src, dest, { recursive: true, verbatimSymlinks: true, filter: gitFilterFromSet(src, tracked) });
      return {
        dir: dest,
        fileCount: countFiles(dest),
        untrackedExcluded: untracked,
        fileSet: "git-tracked",
        source: tildeify(src),
        sourceDir: src,
        ...commitFields,
      };
    }
  }
  cpSync(src, dest, { recursive: true, verbatimSymlinks: true, filter: (s) => noGitDir(relative(src, s)) });
  return {
    dir: dest,
    fileCount: countFiles(dest),
    untrackedExcluded: 0,
    fileSet: "raw-walk",
    source: tildeify(src),
    sourceDir: src,
    ...commitFields,
  };
}

/** Extract `git:<ref>:<path>` from the repository containing `cwd`. Git runs from argv (no shell) with the
 *  ambient repo variables removed; the ref is resolved to a commit id first and only that id is used after.
 *  Files are listed with `ls-tree` and read with `show` — not `git archive`, which applies `export-ignore`
 *  and would drop files the stager delivers. */
export function snapshotGitArm(source: { ref: string; path: string }, dest: string, cwd: string, raw: string): SnapshotInfo {
  validateGitRef(source.ref, raw);
  const top = gitTry(["rev-parse", "--show-toplevel"], cwd)?.trim();
  if (!top) throw new UsageError(`--arm ${raw}: a git: source needs the current directory to be inside a git work tree`);
  const commit = gitTry(["rev-parse", "--verify", "--quiet", "--end-of-options", `${source.ref}^{commit}`], top)?.trim();
  if (!commit || !/^[0-9a-f]{40,64}$/.test(commit))
    throw new UsageError(`--arm ${raw}: "${source.ref}" does not name a commit in ${tildeify(top)}`);
  const path = source.path;
  const kind = path === "." ? "tree" : gitTry(["cat-file", "-t", `${commit}:${path}`], top)?.trim();
  if (kind !== "tree") throw new UsageError(`--arm ${raw}: "${path}" is not a directory at ${source.ref} (${commit.slice(0, 12)})`);
  const listing = gitOut(["ls-tree", "-r", "-z", "--full-tree", commit, "--", path === "." ? "." : path], top);
  const entries = listing.split("\0").filter(Boolean);
  const prefix = path === "." ? "" : path + "/";
  mkdirSync(dest, { recursive: true });
  let fileCount = 0;
  for (const entry of entries) {
    const tab = entry.indexOf("\t");
    const [mode, type] = entry.slice(0, tab).split(" ");
    const file = entry.slice(tab + 1);
    if (!file.startsWith(prefix)) continue;
    const rel = file.slice(prefix.length);
    if (type === "commit")
      throw new UsageError(`--arm ${raw}: ${file} is a submodule at ${source.ref}; a git: arm cannot snapshot submodule content`);
    if (type !== "blob") continue;
    const target = join(dest, ...rel.split("/"));
    if (!resolve(target).startsWith(resolve(dest) + sep))
      throw new UsageError(`--arm ${raw}: refusing a path that escapes the snapshot: ${file}`);
    mkdirSync(dirname(target), { recursive: true });
    const content = execFileSync("git", ["show", `${commit}:${file}`], {
      cwd: top,
      env: gitEnvWithoutAmbientRepo(),
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 256 * 1024 * 1024,
    });
    if (mode === "120000") symlinkSync(content.toString("utf8"), target);
    else {
      writeFileSync(target, content);
      if (mode === "100755") chmodSync(target, 0o755);
    }
    fileCount++;
  }
  if (fileCount === 0) throw new UsageError(`--arm ${raw}: no files under "${path}" at ${source.ref}`);
  return {
    dir: dest,
    fileCount,
    untrackedExcluded: 0,
    fileSet: "git-commit",
    commit,
    source: `git:${source.ref}:${path}`,
    // The working-tree directory the path names: the answer-key guard's location check runs against it too
    // (a scenario kept inside the plugin in the work tree is very likely committed there as well).
    sourceDir: path === "." ? top : join(top, ...path.split("/")),
  };
}

// ---- answer-key guard ------------------------------------------------------------------------------------

/** What to do about each kind of finding, for the refusal message. */
export const ANSWER_KEY_ADVICE: Record<AnswerKeyFinding["reason"], string> = {
  inside_source: "move the scenarios out of the plugin",
  content_copy: "remove the copy from the plugin",
  evals_json: "drop evals.json from the plugin",
  symlink_outside: "replace the link with the files, or point it inside the plugin",
};

export interface AnswerKeyFinding {
  arm: string;
  file: string;
  reason: "inside_source" | "content_copy" | "evals_json" | "symlink_outside";
}

const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

/** Every entry under `dir`: regular files, and symlinks (not descended — a link into the snapshot reaches
 *  a path the walk visits anyway, and one out of it is refused). */
function walkEntries(dir: string, out: Array<{ path: string; link: boolean }> = []): Array<{ path: string; link: boolean }> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) out.push({ path: p, link: true });
    else if (e.isDirectory()) walkEntries(p, out);
    else if (e.isFile()) out.push({ path: p, link: false });
  }
  return out;
}

/** Where a link points: its realpath when the target exists, else its lexical resolution. */
function linkTarget(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(dirname(p), readlinkSync(p));
  }
}

const realOr = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** Refuse an eval whose arm could carry the answer key: any scenario or session file of this eval, or any
 *  `evals.json`, reachable by the agent through an arm. Three checks, because a snapshot is a COPY and a git
 *  arm has no host path:
 *   (a) realpath containment of each eval file in an arm's SOURCE directory (for a git arm, the working-tree
 *       directory its path names);
 *   (b) content identity — a snapshot file byte-equal to an eval file (a renamed copy, or a git arm);
 *   (c) any file named `evals.json` in a snapshot. */
export function answerKeyFindings(
  evalFiles: readonly string[],
  arms: ReadonlyArray<{ label: string; sourceDir?: string; snapshotDir: string }>,
): AnswerKeyFinding[] {
  const findings: AnswerKeyFinding[] = [];
  const evalReal = evalFiles.map((f) => ({ file: f, real: realOr(f), sha: existsSync(f) ? sha256(readFileSync(f)) : undefined }));
  const byHash = new Map(evalReal.filter((e) => e.sha !== undefined).map((e) => [e.sha!, e.file]));
  for (const arm of arms) {
    if (arm.sourceDir !== undefined) {
      const root = realOr(arm.sourceDir);
      for (const e of evalReal)
        if (e.real === root || e.real.startsWith(root + sep)) findings.push({ arm: arm.label, file: e.file, reason: "inside_source" });
    }
    const snapRoot = realOr(arm.snapshotDir);
    for (const { path: f, link } of walkEntries(arm.snapshotDir)) {
      const rel = relative(arm.snapshotDir, f);
      if (f.split(sep).pop() === "evals.json") findings.push({ arm: arm.label, file: rel, reason: "evals_json" });
      if (link) {
        const target = linkTarget(f);
        if (target !== snapRoot && !target.startsWith(snapRoot + sep)) {
          // Name the target as the arm's SOURCE sees it: the snapshot is removed when the eval is refused, so a
          // path into it would point at nothing the user can open.
          const raw = readlinkSync(f);
          const shown = isAbsolute(raw) || arm.sourceDir === undefined ? raw : resolve(arm.sourceDir, dirname(rel), raw);
          findings.push({ arm: arm.label, file: `${rel} -> ${tildeify(shown)}`, reason: "symlink_outside" });
        }
        const isFile = (() => {
          try {
            return statSync(f).isFile();
          } catch {
            return false;
          }
        })();
        if (!isFile) continue;
      }
      const hit = byHash.get(sha256(readFileSync(f)));
      if (hit !== undefined) findings.push({ arm: arm.label, file: `${rel} (a copy of ${tildeify(hit)})`, reason: "content_copy" });
    }
  }
  return findings;
}
