// No-follow file I/O for directories the model under test can influence: a hillclimb flow dir and a frozen
// pairwise reference store. ONE copy, shared by the runner and the ref store.
//
// The threat is a planted entry, not a racing writer. A prompt-injected round can leave
// `results.jsonl -> ~/.bashrc` where the next unattended run appends, `baseline/ref/<id> -> ~/.ssh/id_rsa` where
// the next judge call reads its reference, or a FIFO that blocks the next run forever. Every operation therefore:
//   - refuses any `.`/`..` path segment: the kernel resolves `link/..` to the parent of the link's TARGET, while
//     path arithmetic (and Node's JS realpath) collapses it lexically, so a containment check can pass on a path
//     the open then resolves elsewhere;
//   - refuses a symlinked leaf (O_NOFOLLOW) and a symlinked parent directory;
//   - opens O_NONBLOCK and refuses anything but a regular file, so a planted FIFO or device cannot block;
//   - refuses a regular file with a second hard link (O_NOFOLLOW and lstat cannot see one);
//   - is bound to the root's native realpath, captured once, so an intermediate directory swapped for a link is
//     refused when the check sees it.
// Every such refusal is an `FsRefusal` (callers map it to exit 2); a missing file stays a raw ENOENT, and an
// existing one under `createFile` a raw EEXIST.
// Residual, as in the scaffold: the check and the open are separate lookups (Node's sync fs has no openat), so a
// directory swapped in between is still followed.
//
// POSIX only: the harness runs on macOS and Linux, so the scaffold's Windows paths (lstat-before-open in place of
// O_NOFOLLOW, positional appends, `\` separators) are not carried. Otherwise the behaviour follows
// runner-scaffold.mjs (bundle 2.1.285, l.34-131, l.340-385, l.452-455); pinned by test/hillclimb-fs.test.ts.

import {
  closeSync,
  constants as FS,
  linkSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isUnderRealRoot } from "../boundary-paths.js";

/** A refusal the caller reports and exits 2 on, before any spend. */
export class FsRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FsRefusal";
  }
}

const NOFOLLOW = FS.O_NOFOLLOW;
const NONBLOCK = FS.O_NONBLOCK;

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

/** Why a METHOD path is unusable, or undefined. Method paths are built by the caller from `root.root`, so they
 *  must be absolute, and must carry no `.`/`..` segment and no trailing separator: `lstat("link/")` and
 *  `lstat("link/.")` both follow the final link, which blinds every leaf check, and the kernel resolves `link/..` to
 *  the parent of the link's TARGET. */
function badMethodPath(p: string): string | undefined {
  if (!isAbsolute(p)) return "a method path must be absolute (build it from root.root)";
  if (p.length > 1 && p.endsWith("/")) return "trailing '/'";
  if (p.split("/").some((seg) => seg === "." || seg === "..")) return "'.' or '..' segment";
  return undefined;
}

/** Normalize a ROOT argument (a user-typed `--flow`/store path): strip trailing separators and `.` segments (`./flow`
 *  is a common spelling; a lexical `.` names the same entry), refuse `..` segments. */
export function normalizeRootArg(arg: string): string {
  const parts = arg.split("/");
  if (parts.some((seg) => seg === "..")) throw new FsRefusal(`refusing: ${JSON.stringify(arg)} must not contain '..' segments`);
  const kept = parts.filter((seg, i) => seg !== "." && (seg !== "" || i === 0));
  const out = kept.join("/");
  return out === "" ? (arg.startsWith("/") ? "/" : ".") : out;
}

/** Before any spend: refuse a symlink at the root or at any listed path, and — for a RELATIVE root — at every
 *  ancestor component from `cwd`. An absolute root is the caller's own trust decision and is not walked (an
 *  absolute ancestor link can be legitimate: /tmp on macOS). Listed paths are normalized like the root. */
export function preflightRoot(rootArg: string, paths: readonly string[], cwd: string = process.cwd()): void {
  const root = normalizeRootArg(rootArg);
  const at = (p: string): string => (isAbsolute(p) ? p : join(cwd, p));
  for (const p of [root, ...paths.map(normalizeRootArg)])
    if (isSymlink(at(p))) throw new FsRefusal(`refusing: ${p} is a symlink (this directory must hold regular files)`);
  if (!isAbsolute(root)) {
    let walk = "";
    for (const part of root.split("/").filter(Boolean).slice(0, -1)) {
      walk = walk ? join(walk, part) : part;
      if (isSymlink(at(walk))) throw new FsRefusal(`refusing: ${walk} is a symlink (an ancestor of ${root})`);
    }
  }
}

/** Map the errno an open gives on a planted entry to a refusal; leave everything else (ENOENT above all) raw. */
function asRefusal(e: unknown, p: string): unknown {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === "ELOOP" || code === "EMLINK" || code === "EFTYPE") return new FsRefusal(`refusing to open through symlink: ${p}`);
  if (code === "EISDIR" || code === "ENXIO" || code === "EOPNOTSUPP" || code === "ENOTSUP" || code === "ENOTDIR")
    return new FsRefusal(`refusing to use non-regular file: ${p}`);
  // A socket's open fails with an errno libuv may not name; decide from what is actually there.
  if (code !== "ENOENT" && code !== "EEXIST" && code !== "EACCES") {
    const st = lstatOrNull(p);
    if (st !== null && !st.isFile()) return new FsRefusal(`refusing to use non-regular file: ${p}`);
  }
  return e;
}

/** A directory every read and write is confined to. Obtain one with `open` (creates the root) or `existing`
 *  (readers: never creates); both run `preflightRoot` themselves and bind an ABSOLUTE root. */
export class NoFollowRoot {
  private constructor(
    readonly root: string,
    readonly realRoot: string,
  ) {}

  /** Bind to a root that must ALREADY exist as a real directory. */
  static existing(rootArg: string, opts: { cwd?: string } = {}): NoFollowRoot {
    const cwd = opts.cwd ?? process.cwd();
    preflightRoot(rootArg, [], cwd);
    const root = resolve(cwd, normalizeRootArg(rootArg));
    const st = lstatOrNull(root);
    if (st === null) throw new FsRefusal(`refusing: ${root} does not exist`);
    if (!st.isDirectory()) throw new FsRefusal(`refusing: ${root} is not a directory`);
    return new NoFollowRoot(root, realpathSync.native(root));
  }

  /** Create the root when absent, then capture where it really resolves. */
  static open(rootArg: string, opts: { cwd?: string } = {}): NoFollowRoot {
    const cwd = opts.cwd ?? process.cwd();
    preflightRoot(rootArg, [], cwd);
    const root = resolve(cwd, normalizeRootArg(rootArg));
    mkdirSync(root, { recursive: true });
    return NoFollowRoot.existing(root);
  }

  /** Throw unless `dir` resolves to the root or under it. */
  assertIn(dir: string, what: string): void {
    if (!isUnderRealRoot(this.realRoot, realpathSync.native(dir)))
      throw new FsRefusal(`refusing to ${what}: ${dir} resolves outside ${this.root}`);
  }

  /** The shared path checks: absolute, no dot segment, no trailing slash, no symlinked parent, parent inside the root. */
  private checkPath(p: string, what: string): void {
    const bad = badMethodPath(p);
    if (bad !== undefined) throw new FsRefusal(`refusing to ${what} ${JSON.stringify(p)}: ${bad}`);
    const dir = dirname(p);
    if (isSymlink(dir)) throw new FsRefusal(`refusing to ${what} through symlinked directory: ${dir}`);
    this.assertIn(dir, what);
  }

  private openNoFollow(p: string, flags: number): number {
    this.checkPath(p, "open");
    let fd: number;
    try {
      fd = openSync(p, flags | NOFOLLOW | NONBLOCK, 0o644);
    } catch (e) {
      throw asRefusal(e, p);
    }
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

  /** Create a NEW file. An existing entry of any kind (a planted link included) fails with a raw EEXIST and is
   *  left untouched: the intended "already there" signal for append-only stores. */
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

  /** Append one JSON value as a line. A crash can leave a torn final line with no newline; the next append would
   *  merge two rows into one permanently unparseable line, so a missing trailing newline is added first
   *  (runner-scaffold.mjs l.452-455, checked per append rather than once per run). */
  appendJsonl(p: string, value: unknown): void {
    if (typeof JSON.stringify(value) !== "string") throw new TypeError(`appendJsonl: ${String(value)} has no JSON encoding`);
    const fd = this.openNoFollow(p, FS.O_RDWR | FS.O_CREAT | FS.O_APPEND);
    try {
      const size = fstatSync(fd).size;
      let torn = false;
      if (size > 0) {
        const last = Buffer.alloc(1);
        readSync(fd, last, 0, 1, size - 1);
        torn = last[0] !== 0x0a;
      }
      const line = JSON.stringify(value);
      if (typeof line !== "string") throw new TypeError(`appendJsonl: ${String(value)} has no JSON encoding`);
      writeFileSync(fd, `${torn ? "\n" : ""}${line}\n`);
    } finally {
      closeSync(fd);
    }
  }

  /** `mkdir -p` one component at a time from the root, refusing a symlink at any component — so, unlike a
   *  recursive mkdir, nothing is ever created outside the root. */
  mkdir(dir: string): void {
    const bad = badMethodPath(dir);
    if (bad !== undefined) throw new FsRefusal(`refusing to create directory ${JSON.stringify(dir)}: ${bad}`);
    // Lexical against the bound root: a path spelled through a different alias of the root (/tmp vs /private/tmp on
    // macOS) is refused rather than resolved — fail closed.
    const rel = relative(this.root, dir);
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel))
      throw new FsRefusal(`refusing to create directory: ${dir} is outside ${this.root}`);
    let cur = this.root;
    for (const part of rel.split("/").filter(Boolean)) {
      cur = join(cur, part);
      const st = lstatOrNull(cur);
      if (st === null) mkdirSync(cur);
      else if (st.isSymbolicLink()) throw new FsRefusal(`refusing to use symlinked directory: ${cur}`);
      else if (!st.isDirectory()) throw new FsRefusal(`refusing: ${cur} is not a directory`);
    }
    this.assertIn(dir, "create directory");
  }

  /** List a directory's entries WITHOUT following them: a symlinked entry is reported as a link. Refuses a
   *  symlinked or out-of-root directory. */
  readdirNoFollow(dir: string): Dirent[] {
    const bad = badMethodPath(dir);
    if (bad !== undefined) throw new FsRefusal(`refusing to list ${JSON.stringify(dir)}: ${bad}`);
    const st = lstatOrNull(dir);
    if (st?.isSymbolicLink()) throw new FsRefusal(`refusing to list symlinked directory: ${dir}`);
    if (st !== null && !st.isDirectory()) throw new FsRefusal(`refusing to list ${dir}: not a directory`);
    this.assertIn(dir, "list");
    return readdirSync(dir, { withFileTypes: true });
  }

  /** Atomic rename inside the root. The source must not be a link.
   *  - `replace: false` returns `exists` when any entry (a planted link included) is at the destination, and moves
   *    nothing. For a regular-file source this is atomic (`link` then `unlink`: the kernel refuses an existing name).
   *    For a DIRECTORY source it is checked, then renamed: an entry that appears in between is caught only when it is
   *    a non-empty directory (EEXIST/ENOTEMPTY); a file or EMPTY directory planted in that window is replaced.
   *  - `replace: true` needs a regular-file source and replaces only a plain regular file with a single link — a
   *    link, a hard-linked file or a directory there is refused. */
  renameNoFollow(from: string, to: string, opts: { replace: boolean }): "renamed" | "exists" {
    this.checkPath(from, "rename from");
    this.checkPath(to, "rename to");
    const src = lstatOrNull(from);
    if (src === null) throw Object.assign(new Error(`ENOENT: no such file or directory, rename '${from}'`), { code: "ENOENT" });
    if (src.isSymbolicLink()) throw new FsRefusal(`refusing to rename a symlink: ${from}`);
    if (opts.replace && !src.isFile()) throw new FsRefusal(`refusing to replace with a non-regular file: ${from}`);
    const dst = lstatOrNull(to);
    if (dst !== null) {
      if (!opts.replace) return "exists";
      if (dst.isSymbolicLink()) throw new FsRefusal(`refusing to replace a symlink: ${to}`);
      if (!dst.isFile()) throw new FsRefusal(`refusing to replace a non-regular file: ${to}`);
      if (dst.nlink > 1) throw new FsRefusal(`refusing to replace ${to}: it has a second hard link`);
    }
    if (!opts.replace && src.isFile()) {
      try {
        linkSync(from, to);
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === "EEXIST") return "exists";
        throw e;
      }
      unlinkSync(from);
      return "renamed";
    }
    try {
      renameSync(from, to);
    } catch (e) {
      // A concurrent writer won: POSIX refuses a directory rename onto a non-empty directory.
      const code = (e as NodeJS.ErrnoException)?.code;
      if (!opts.replace && (code === "EEXIST" || code === "ENOTEMPTY")) return "exists";
      throw e;
    }
    return "renamed";
  }
}
