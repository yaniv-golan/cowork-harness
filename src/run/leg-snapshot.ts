// A multi-leg leg's SNAPSHOT: its user-visible files (outputs, connected folders) as they stood when the leg ended,
// cloned into `legs/<id>/snapshot/<same relative paths>`. Re-grading a leg later (`verify-run --leg`, `regrade --leg`,
// `fixture export`, `inspect`) reads the snapshot, never the session tree, which a later leg or host action may have
// changed. So every leg of a kept run stays re-gradable at no cost, under `workdir: persistent` too.
//
// The copy is a copy-on-write CLONE where the filesystem supports one, so it shares blocks with the tree until a later
// leg rewrites a file: on macOS (APFS) through `cp -c` (clonefile), since Node's own copy does not clone there (a
// measured full copy); on Linux btrfs and XFS-with-reflink through a forced FICLONE. Elsewhere (ext4, most Linux and CI
// machines) it is a FULL copy and costs its size in disk. snapshot.json records which (`method`), so that is visible. A total
// over the cap is not snapshotted at all (the leg then falls back to the live-tree rules, refused where they refuse).
// The leg's post-run manifest (leg-manifest.ts) is what proves a snapshot is the leg's own: a reader checks the
// snapshot against it before trusting it.

import {
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join, sep } from "node:path";
import { UsageError } from "../errors.js";
import { legTreeDrift } from "./leg-manifest.js";

export const LEG_SNAPSHOT_DIR = "snapshot";
const META = "snapshot.json";

const CAP_ENV = "COWORK_HARNESS_LEG_SNAPSHOT_MAX_BYTES";

/** Bytes a leg's snapshot may hold (COWORK_HARNESS_LEG_SNAPSHOT_MAX_BYTES; default 512 MiB). Over it, no snapshot.
 *  A malformed value is refused, not ignored: a run checks it before it starts (executeMultiLeg). */
export function legSnapshotCap(): number {
  const raw = process.env[CAP_ENV];
  if (raw === undefined || raw.trim() === "") return 512 * 1024 * 1024;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`${CAP_ENV} must be a whole number of bytes >= 1 (got ${JSON.stringify(raw)})`);
  return n;
}

interface SnapshotMeta {
  complete: boolean;
  roots: string[];
  bytes: number;
  /** Symlinks under the roots are not followed or copied; they are listed. */
  links: string[];
  /** How the files were copied: all cloned, all plain copies, some of each (a root on another device), or none. */
  method: "clone" | "copy" | "mixed" | "none";
  cloned: number;
  copied: number;
  /** Why there is no complete snapshot, when there is not. */
  reason?: string;
}

/** Regular files and symlinks under `root/rel`, recursively, as root-relative paths. Directories are walked. */
function walk(root: string, rel: string, files: string[], links: string[]): void {
  let st;
  try {
    st = lstatSync(join(root, rel));
  } catch {
    return;
  }
  if (st.isSymbolicLink()) links.push(rel);
  else if (st.isFile()) files.push(rel);
  else if (st.isDirectory()) for (const e of readdirSync(join(root, rel))) walk(root, join(rel, e), files, links);
}

/** What a FORCED clone answers where it cannot clone: copy plainly. Linux: the FICLONE ioctl's error. macOS: ENOSYS (a
 *  forced clone is not implemented there; the snapshot clones a macOS tree with `cp -c` instead). */
export const CLONE_FALLBACK_CODES = ["ENOTSUP", "EXDEV", "EINVAL", "ENOTTY", "ENOSYS"] as const;

type CopyFn = (src: string, dest: string, mode?: number) => void;
export type CopyMethod = "clone" | "copy";
/** Clone a whole directory tree at `src` to the absent `dest`; true when it did. A seam for tests. */
export type TreeCloner = (src: string, dest: string) => boolean;

/** Clone one file, or, where the filesystem cannot, copy it plainly; keep its mtime. Says which it did. `copy` is a
 *  seam for tests. */
export function cloneFile(src: string, dest: string, copy: CopyFn = copyFileSync): CopyMethod {
  let method: CopyMethod = "clone";
  try {
    copy(src, dest, constants.COPYFILE_FICLONE_FORCE);
  } catch (e) {
    if (!(CLONE_FALLBACK_CODES as readonly string[]).includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
    copy(src, dest);
    method = "copy";
  }
  const st = statSync(src);
  utimesSync(dest, st.atime, st.mtime);
  return method;
}

/** macOS: clone a tree with `cp -cpR` (clonefile, mtimes kept). cp fails rather than copying when it cannot clone, so
 *  success is a clone. Elsewhere there is no tree cloner. */
export const darwinTreeCloner: TreeCloner | undefined =
  process.platform === "darwin"
    ? (src, dest) => {
        try {
          execFileSync("cp", ["-cpR", "--", src, dest], { stdio: "ignore" });
          return true;
        } catch {
          return false;
        }
      }
    : undefined;

/** Take the leg's snapshot of `roots` under `workRoot`. Never throws: a snapshot that could not be taken leaves the
 *  leg on the live-tree rules (refused where those refuse), never wrongly re-gradable. */
export function snapshotLegTree(
  legDir: string,
  workRoot: string,
  roots: readonly string[],
  copy: CopyFn = copyFileSync,
  cloneTree: TreeCloner | null = darwinTreeCloner ?? null, // null: no whole-tree cloner (per-file only)
): void {
  const dest = join(legDir, LEG_SNAPSHOT_DIR);
  const write = (m: SnapshotMeta) => writeFileSync(join(legDir, META), JSON.stringify(m, null, 2) + "\n");
  try {
    rmSync(dest, { recursive: true, force: true });
    const files: string[] = [];
    const links: string[] = [];
    for (const r of roots) walk(workRoot, r, files, links);
    const bytes = files.reduce((n, f) => n + statSync(join(workRoot, f)).size, 0);
    if (bytes > legSnapshotCap()) {
      write({
        complete: false,
        roots: [...roots],
        bytes,
        links,
        method: "none",
        cloned: 0,
        copied: 0,
        reason: `${bytes} bytes is over the ${legSnapshotCap()}-byte snapshot cap`,
      });
      return;
    }
    const n = { clone: 0, copy: 0 };
    const under = (r: string) => (f: string) => f === r || f.startsWith(r + sep);
    for (const r of roots) {
      const rootFiles = files.filter(under(r));
      const target = join(dest, r);
      mkdirSync(join(target, ".."), { recursive: true });
      // One whole-tree clone where the platform has one; symlinks it carried are removed (a snapshot never holds one).
      if (rootFiles.length && cloneTree?.(join(workRoot, r), target)) {
        for (const l of links.filter(under(r))) rmSync(join(dest, l), { force: true });
        n.clone += rootFiles.length;
        continue;
      }
      rmSync(target, { recursive: true, force: true });
      for (const f of rootFiles) {
        mkdirSync(join(dest, f, ".."), { recursive: true });
        n[cloneFile(join(workRoot, f), join(dest, f), copy)]++;
      }
      mkdirSync(target, { recursive: true }); // an empty root is still a root
    }
    const kinds = (Object.keys(n) as CopyMethod[]).filter((k) => n[k] > 0);
    const method = kinds.length === 0 ? "none" : kinds.length === 1 ? kinds[0]! : "mixed";
    write({ complete: true, roots: [...roots], bytes, links, method, cloned: n.clone, copied: n.copy });
  } catch (e) {
    rmSync(dest, { recursive: true, force: true });
    try {
      write({
        complete: false,
        roots: [...roots],
        bytes: 0,
        links: [],
        method: "none",
        cloned: 0,
        copied: 0,
        reason: (e as Error).message,
      });
    } catch {
      /* see above */
    }
  }
}

/** The work root to re-grade a leg from: its snapshot, when complete AND it matches the leg's own post-run manifest.
 *  `undefined` when there is no usable snapshot (the caller falls back to the live-tree rules). */
export function legSnapshotRoot(legDir: string): string | undefined {
  let m: SnapshotMeta;
  try {
    m = JSON.parse(readFileSync(join(legDir, META), "utf8")) as SnapshotMeta;
  } catch {
    return undefined;
  }
  if (!m.complete) return undefined;
  const root = join(legDir, LEG_SNAPSHOT_DIR);
  const drift = legTreeDrift(legDir, root);
  // A symlink is listed in the manifest but never copied: drop those from the comparison, nothing else.
  const real = drift?.filter((d) => !m.links.some((l) => d === `removed ${l}`));
  return real !== undefined && real.length === 0 ? root : undefined;
}
