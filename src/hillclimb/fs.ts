// No-follow file I/O for directories the model under test can influence: a hillclimb flow dir and a frozen
// pairwise reference store. ONE copy, shared by the runner and the ref store.
//
// The threat is a planted link, not a racing writer. A prompt-injected round can leave
// `results.jsonl -> ~/.bashrc` where the next unattended run appends, or `baseline/ref/<id> -> ~/.ssh/id_rsa`
// where the next judge call reads its reference. Every open therefore:
//   - refuses a symlinked leaf (O_NOFOLLOW) and a symlinked parent directory,
//   - refuses a regular file with a second hard link (O_NOFOLLOW and lstat cannot see one),
//   - is bound to the root's realpath, captured once, so an intermediate directory swapped for a link is
//     refused when the check sees it.
// Residual, as in the scaffold: the check and the open are separate lookups (Node's sync fs has no openat),
// so a directory swapped in between is still followed.
//
// Behaviour follows runner-scaffold.mjs (bundle 2.1.285, l.34-131 and l.340-385); pinned by
// test/hillclimb-fs.test.ts.

import {
  closeSync,
  constants as FS,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** A refusal the caller reports and exits 2 on, before any spend. */
export class FsRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FsRefusal";
  }
}

// POSIX only defines O_NOFOLLOW; where it is absent the lstat checks below still refuse a planted leaf.
const NOFOLLOW = FS.O_NOFOLLOW ?? 0;

/** lstat, or null when the entry does not exist. Any other failure is rethrown: a guard that cannot tell
 *  must refuse, so EACCES never reads as "absent". */
export function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw e;
  }
}

export const isSymlink = (p: string): boolean => lstatOrNull(p)?.isSymbolicLink() === true;

/** Present under lstat — a planted symlink counts as present, so a freeze-once guard never overwrites (or
 *  follows) it. */
export const lexists = (p: string): boolean => lstatOrNull(p) !== null;

/** Strip trailing separators (`lstat("link/")` follows the final link, which would blind every leaf check) and
 *  refuse `.`/`..` segments (they make the leaf check resolve a different component than the named dir). */
export function normalizeRootArg(arg: string): string {
  const stripped = arg.replace(/(.)\/+$/, "$1");
  if (stripped.split("/").some((seg) => seg === "." || seg === ".."))
    throw new FsRefusal(`refusing: ${JSON.stringify(arg)} must not contain '.' or '..' segments`);
  return stripped;
}

/** Before any spend: refuse a symlink at the root or at any listed path, and — for a RELATIVE root — at every
 *  ancestor component from `cwd`. An absolute root is the caller's own trust decision and is not walked (an
 *  absolute ancestor link can be legitimate: /tmp on macOS). */
export function preflightRoot(rootArg: string, paths: readonly string[], cwd: string = process.cwd()): void {
  const root = normalizeRootArg(rootArg);
  const at = (p: string): string => (isAbsolute(p) ? p : join(cwd, p));
  for (const p of [root, ...paths])
    if (isSymlink(at(p))) throw new FsRefusal(`refusing: ${p} is a symlink (this directory must hold regular files)`);
  if (!isAbsolute(root)) {
    let walk = "";
    for (const part of root.split("/").filter(Boolean).slice(0, -1)) {
      walk = walk ? join(walk, part) : part;
      if (isSymlink(at(walk))) throw new FsRefusal(`refusing: ${walk} is a symlink (an ancestor of ${root})`);
    }
  }
}

/** A directory every read and write is confined to. */
export class NoFollowRoot {
  private constructor(
    readonly root: string,
    readonly realRoot: string,
  ) {}

  /** Bind to a root that must ALREADY exist as a real directory — for readers, which must never create one. */
  static existing(rootArg: string): NoFollowRoot {
    const root = normalizeRootArg(rootArg);
    const st = lstatOrNull(root);
    if (st === null) throw new FsRefusal(`refusing: ${root} does not exist`);
    if (st.isSymbolicLink()) throw new FsRefusal(`refusing: ${root} is a symlink`);
    if (!st.isDirectory()) throw new FsRefusal(`refusing: ${root} is not a directory`);
    return new NoFollowRoot(root, realpathSync(root));
  }

  /** Create the root when absent (refusing a symlink at it), then capture where it really resolves. */
  static open(rootArg: string): NoFollowRoot {
    const root = normalizeRootArg(rootArg);
    if (isSymlink(root)) throw new FsRefusal(`refusing: ${root} is a symlink`);
    mkdirSync(root, { recursive: true });
    return new NoFollowRoot(root, realpathSync(root));
  }

  /** Throw unless `dir` resolves to the root or under it. */
  assertIn(dir: string, what: string): void {
    const real = realpathSync(dir);
    const rel = relative(this.realRoot, real);
    if (real !== this.realRoot && (rel === "" || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)))
      throw new FsRefusal(`refusing to ${what}: ${dir} resolves outside ${this.root}`);
  }

  private openNoFollow(p: string, flags: number): number {
    const dir = dirname(resolve(p));
    if (isSymlink(dir)) throw new FsRefusal(`refusing to open through symlinked directory: ${dir}`);
    this.assertIn(dir, "open");
    if (NOFOLLOW === 0 && isSymlink(p)) throw new FsRefusal(`refusing to open through symlink: ${p}`);
    const fd = openSync(p, flags | NOFOLLOW, 0o644);
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) throw new FsRefusal(`refusing to use non-regular file: ${p}`);
      if (st.nlink > 1)
        throw new FsRefusal(
          `refusing to use ${p}: it has a second hard link (another name for the same file); replace it with a plain copy if it is yours`,
        );
    } catch (e) {
      closeSync(fd);
      throw e;
    }
    return fd;
  }

  readFile(p: string): string {
    const fd = this.openNoFollow(p, FS.O_RDONLY);
    try {
      return readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  }

  /** null when the file is absent; any other failure — a planted link included — throws. */
  readIfPresent(p: string): string | null {
    try {
      return this.readFile(p);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw e;
    }
  }

  /** Opened without O_TRUNC and truncated only after the checks, so a refused file keeps its bytes. */
  writeFile(p: string, data: string | Uint8Array): void {
    const fd = this.openNoFollow(p, FS.O_WRONLY | FS.O_CREAT);
    try {
      ftruncateSync(fd, 0);
      writeFileSync(fd, data);
    } finally {
      closeSync(fd);
    }
  }

  /** Create a NEW file; an existing entry of any kind (a planted link included) fails with EEXIST and is
   *  left untouched. For append-only stores whose files must never be rewritten. */
  createFile(p: string, data: string | Uint8Array): void {
    const fd = this.openNoFollow(p, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL);
    try {
      writeFileSync(fd, data);
    } finally {
      closeSync(fd);
    }
  }

  /** POSIX O_APPEND with no position: each append lands whole at the end. */
  appendFile(p: string, data: string | Uint8Array): void {
    const fd = this.openNoFollow(p, FS.O_WRONLY | FS.O_CREAT | FS.O_APPEND);
    try {
      writeFileSync(fd, data);
    } finally {
      closeSync(fd);
    }
  }

  /** `mkdir -p`, refusing a symlink at the leaf; checked AFTER creating, because a recursive mkdir follows
   *  symlinked ancestors and a dir minted through one must be refused before any file lands in it. */
  mkdir(dir: string): void {
    if (isSymlink(dir)) throw new FsRefusal(`refusing to use symlinked directory: ${dir}`);
    mkdirSync(dir, { recursive: true });
    this.assertIn(dir, "create directory");
  }
}
