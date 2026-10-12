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
  chmodSync,
  copyFileSync,
  lstatSync,
  realpathSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, sep } from "node:path";
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
  /** How the files were copied: all cloned, all plain copies, some of each (one root cloned, another copied), or none. */
  method: "clone" | "copy" | "mixed" | "none";
  cloned: number;
  copied: number;
  /** Why a root that could have been cloned whole was copied file by file instead (macOS), one entry per root. */
  fallback?: string[];
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
/** Clone a whole directory tree at `src` to the absent `dest`. `ok` only for a clone; otherwise why not. A seam for
 *  tests. */
export type TreeCloner = (src: string, dest: string) => { ok: true } | { ok: false; why: string };

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

/** The filesystem type name `mount` reports for the volume holding `path` (macOS), or undefined. Node's statfs `type`
 *  is a per-boot index on macOS, not a stable id, so the name is read from mount's own listing. */
function darwinFsType(path: string): string | undefined {
  let real: string;
  let out: string;
  try {
    real = realpathSync(path);
    out = execFileSync("/sbin/mount", { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined;
  }
  let best: { at: string; type: string } | undefined;
  for (const line of out.split("\n")) {
    const m = /^.+? on (.+) \(([^,)]+)/.exec(line);
    if (!m) continue;
    const at = m[1]!;
    const inside = real === at || real.startsWith(at.endsWith("/") ? at : at + "/");
    if (inside && (!best || at.length > best.at.length)) best = { at, type: m[2]! };
  }
  return best?.type;
}

/** macOS: clone a tree with one `/bin/cp -cpR` (clonefile; mtimes kept). `cp -c` does NOT fail when it cannot clone —
 *  it falls back to an ordinary copy across volumes or on a filesystem that cannot clone — so a clone is claimed only
 *  when the source and the snapshot share a device AND that volume is APFS; anything else is refused here and copied
 *  file by file (and recorded as a copy). `cp -R` also carries FIFOs and empty directories, which the per-file path
 *  does not: a difference in what a snapshot holds, never in a verdict (only regular files are graded). Directory modes
 *  `-p` kept are made owner-writable afterwards, so the snapshot can always be removed. */
export const darwinTreeCloner: TreeCloner | undefined =
  process.platform === "darwin"
    ? (src, dest) => {
        try {
          const srcDev = statSync(src).dev;
          const destDev = statSync(dirname(dest)).dev;
          if (srcDev !== destDev) return { ok: false, why: `${src} is on another device than the snapshot` };
          const type = darwinFsType(dirname(dest));
          if (type !== "apfs") return { ok: false, why: `the snapshot's volume is ${type ?? "of an unknown type"}, not apfs` };
        } catch (e) {
          return { ok: false, why: (e as Error).message };
        }
        try {
          execFileSync("/bin/cp", ["-cpR", "--", src, dest], { stdio: ["ignore", "ignore", "pipe"], timeout: 600_000 });
        } catch (e) {
          const err = (e as { stderr?: Buffer }).stderr?.toString().trim();
          return { ok: false, why: `cp -c failed: ${err || (e as Error).message}` };
        }
        ownerWritableDirs(dest);
        return { ok: true };
      }
    : undefined;

/** Make every directory under `root` owner-writable (and searchable), so the tree can be removed. */
function ownerWritableDirs(root: string): void {
  let st;
  try {
    st = lstatSync(root);
  } catch {
    return;
  }
  if (!st.isDirectory()) return;
  if ((st.mode & 0o700) !== 0o700) chmodSync(root, st.mode | 0o700);
  for (const e of readdirSync(root)) ownerWritableDirs(join(root, e));
}

/** Remove `path` whatever its directory modes; never throws. */
function removeTree(path: string): void {
  try {
    ownerWritableDirs(path);
  } catch {
    /* removal below still tries */
  }
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    /* a snapshot that cannot be removed is left; its meta says it is not complete */
  }
}

/** Remove one symlink (to a file or a directory); a missing one is fine. */
function removeLink(path: string): void {
  try {
    unlinkSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

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
    removeTree(dest);
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
    const fallback: string[] = [];
    const under = (r: string) => (f: string) => f === r || f.startsWith(r + sep);
    for (const r of roots) {
      const rootFiles = files.filter(under(r));
      const target = join(dest, r);
      mkdirSync(join(target, ".."), { recursive: true });
      // One whole-tree clone where the platform has one; symlinks it carried are removed (a snapshot never holds one).
      if (rootFiles.length && cloneTree) {
        const c = cloneTree(join(workRoot, r), target);
        if (c.ok) {
          for (const l of links.filter(under(r))) removeLink(join(dest, l));
          n.clone += rootFiles.length;
          continue;
        }
        fallback.push(`${r}: ${c.why}`);
      }
      removeTree(target);
      for (const f of rootFiles) {
        mkdirSync(join(dest, f, ".."), { recursive: true });
        n[cloneFile(join(workRoot, f), join(dest, f), copy)]++;
      }
      mkdirSync(target, { recursive: true }); // an empty root is still a root
    }
    const kinds = (Object.keys(n) as CopyMethod[]).filter((k) => n[k] > 0);
    const method = kinds.length === 0 ? "none" : kinds.length === 1 ? kinds[0]! : "mixed";
    write({
      complete: true,
      roots: [...roots],
      bytes,
      links,
      method,
      cloned: n.clone,
      copied: n.copy,
      ...(fallback.length ? { fallback } : {}),
    });
  } catch (e) {
    removeTree(dest);
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
