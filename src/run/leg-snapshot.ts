// A multi-leg leg's SNAPSHOT: its user-visible files (outputs, connected folders) as they stood when the leg ended,
// cloned into `legs/<id>/snapshot/<same relative paths>`. Re-grading a leg later (`verify-run --leg`, `regrade --leg`,
// `fixture export`, `inspect`) reads the snapshot, never the session tree, which a later leg or host action may have
// changed. So every leg of a kept run stays re-gradable at no cost, under `workdir: persistent` too.
//
// The copy is a copy-on-write CLONE where the filesystem supports one (APFS, btrfs, XFS: COPYFILE_FICLONE), so it
// shares blocks with the tree until a later leg rewrites a file; elsewhere it falls back to an ordinary copy. A total
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
import { join } from "node:path";
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

/** Clone (or, where the filesystem cannot, copy) one file, keeping its mtime. */
export function cloneFile(src: string, dest: string): void {
  copyFileSync(src, dest, constants.COPYFILE_FICLONE);
  const st = statSync(src);
  utimesSync(dest, st.atime, st.mtime);
}

/** Take the leg's snapshot of `roots` under `workRoot`. Never throws: a snapshot that could not be taken leaves the
 *  leg on the live-tree rules (refused where those refuse), never wrongly re-gradable. */
export function snapshotLegTree(legDir: string, workRoot: string, roots: readonly string[]): void {
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
        reason: `${bytes} bytes is over the ${legSnapshotCap()}-byte snapshot cap`,
      });
      return;
    }
    for (const f of files) {
      mkdirSync(join(dest, f, ".."), { recursive: true });
      cloneFile(join(workRoot, f), join(dest, f));
    }
    for (const r of roots) mkdirSync(join(dest, r), { recursive: true }); // an empty root is still a root
    write({ complete: true, roots: [...roots], bytes, links });
  } catch (e) {
    rmSync(dest, { recursive: true, force: true });
    try {
      write({ complete: false, roots: [...roots], bytes: 0, links: [], reason: (e as Error).message });
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
