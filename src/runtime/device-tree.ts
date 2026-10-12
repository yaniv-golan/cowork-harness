import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync, type BigIntStats } from "node:fs";
import { join, relative, sep } from "node:path";

// The device tree's before/after diff behind deviceTreeDeletes. Node builtins only, so a test can run it unchanged
// on another filesystem.

/** One entry of a device-tree listing, keyed `<folder>/<path>` (a directory with a trailing `/`). `id` is
 *  identityOf's `<inode>:<birth time>`. `o` is any other type (FIFO, socket, device), never opened. A file also
 *  carries its size and sha256, and a link the hash of its target (never followed), for the filesystems where an identity can be reused (probeIdentityReliable). */
export type TreeEntry = { id: string; type: "f" | "d" | "l" | "o"; size?: number; sha256?: string };

/** A file's identity: its inode and nanosecond birth time. An inode alone is not one: Linux reuses a freed inode
 *  for the next file created. */
export function identityOf(st: BigIntStats): string {
  return `${st.ino}:${st.birthtimeNs}`;
}

const PROBE_TRIALS = 5;

/** Whether identityOf tells a deleted file from the next one created at the same path, on the filesystem holding
 *  `dir`. Measured: APFS never collided in 200 delete-recreate cycles; Linux overlayfs collided in 171 of 200, at
 *  nanosecond resolution, and one trial misreported it as distinguishing in 2 of 50 runs. So every one of
 *  PROBE_TRIALS trials must distinguish. Anything that fails (an unwritable `dir`) is unreliable. */
export function probeIdentityReliable(
  dir: string,
  idAt: (path: string) => string = (path) => identityOf(lstatSync(path, { bigint: true })),
): boolean {
  const p = join(dir, `.cwh-identity-probe-${process.pid}`);
  try {
    for (let i = 0; i < PROBE_TRIALS; i++) {
      writeFileSync(p, "a");
      const first = idAt(p);
      rmSync(p);
      writeFileSync(p, "b");
      const second = idAt(p);
      rmSync(p);
      if (first === second) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    rmSync(p, { force: true });
  }
}

/** Every entry under `<deviceHost>/mnt`, the folder roots themselves excepted (removing one is not something the
 *  device shell can do). Hashed now, so the comparison is with the tree as this listing found it. */
export function deviceTreeListing(deviceHost: string): Record<string, TreeEntry> {
  const mnt = join(deviceHost, "mnt");
  const out: Record<string, TreeEntry> = {};
  const visit = (p: string, top: boolean): void => {
    let st;
    try {
      st = lstatSync(p, { bigint: true });
    } catch {
      return;
    }
    const rel = relative(mnt, p).split(sep).join("/");
    const id = identityOf(st);
    if (st.isDirectory()) {
      if (!top) out[`${rel}/`] = { id, type: "d" };
      let names: string[] = [];
      try {
        names = readdirSync(p);
      } catch {
        return;
      }
      for (const n of names) visit(join(p, n), false);
      return;
    }
    if (st.isSymbolicLink()) {
      let target = "";
      try {
        target = readlinkSync(p);
      } catch {
        /* unreadable: hashed as empty */
      }
      out[rel] = { id, type: "l", sha256: createHash("sha256").update(target).digest("hex") };
      return;
    }
    // A FIFO, socket or device file: listed by identity and type, never opened (opening a FIFO blocks until a
    // writer comes, which would hang the run).
    if (!st.isFile()) {
      out[rel] = { id, type: "o" };
      return;
    }
    let sha256: string | undefined;
    try {
      sha256 = createHash("sha256").update(readFileSync(p)).digest("hex");
    } catch {
      sha256 = undefined; // unreadable: no rename can be proven for it where identity is unreliable
    }
    out[rel] = { id, type: "f", size: Number(st.size), ...(sha256 ? { sha256 } : {}) };
  };
  if (existsSync(mnt)) for (const n of readdirSync(mnt)) visit(join(mnt, n), true);
  return out;
}

type Before = Readonly<Record<string, TreeEntry | string>>;
type After = Readonly<Record<string, TreeEntry>>;

const sameBytes = (a: TreeEntry, b: TreeEntry) => a.type === b.type && a.size === b.size && a.sha256 !== undefined && a.sha256 === b.sha256;

/** Whether the staged entry at `path` reappears after the run as a rename. Where identity is reliable, the same
 *  identity and type is a rename, so an edit after a rename is still a rename. Where it is not, a file or link needs
 *  matching bytes too, and a directory needs a file beneath it that reappears, bytes and all, beneath the candidate:
 *  a removed entry then never passes as a rename, and an edit after a rename (or an empty directory's rename) reads
 *  as a delete, the safe side. A listing written before entries carried bytes proves no rename. */
function renamedAfter(path: string, before: Before, after: After, afterById: ReadonlyMap<string, string[]>, reliable: boolean): boolean {
  const b = before[path]!;
  if (typeof b === "string") return false;
  return (afterById.get(b.id) ?? []).some((q) => {
    const a = after[q]!;
    if (a.type !== b.type) return false;
    if (reliable) return true;
    if (b.type !== "d") return sameBytes(a, b);
    return Object.entries(before).some(
      ([k, e]) =>
        k.startsWith(path) &&
        typeof e !== "string" &&
        e.type !== "d" &&
        (afterById.get(e.id) ?? []).some((k2) => k2.startsWith(q) && sameBytes(after[k2]!, e)),
    );
  });
}

/** The staged entries gone after the run and not renamed (`renamedAfter`), in the delete-denied folders, named by
 *  mount path. Pure: the listings and the probe's verdict in, the deletes out. */
export function treeDeletes(
  before: Before,
  after: After,
  denied: ReadonlyArray<{ name: string; mountPath: string }>,
  identityReliable: boolean,
): { mount: string; command: string }[] {
  // Named by mount path, as the command-text scan names a mount, so allow_delete_in waives both alike.
  const mountOf = new Map(denied.map((f) => [f.name, f.mountPath]));
  return treeLosses(before, after, denied, identityReliable).map((path) => ({
    mount: mountOf.get(path.split("/")[0]!)!,
    command: `(removed from the device copy) ${path}`,
  }));
}

/** treeDeletes' entries as `<folder>/<path>`, sorted. */
export function treeLosses(before: Before, after: After, denied: ReadonlyArray<{ name: string }>, identityReliable: boolean): string[] {
  const afterById = new Map<string, string[]>();
  for (const [k, e] of Object.entries(after)) afterById.set(e.id, [...(afterById.get(e.id) ?? []), k]);
  const names = new Set(denied.map((f) => f.name));
  return Object.keys(before)
    .filter((path) => names.has(path.split("/")[0]!) && !(path in after) && !renamedAfter(path, before, after, afterById, identityReliable))
    .sort();
}
