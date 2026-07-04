import { basename, sep } from "node:path";

/**
 * Faithful ports of Claude Cowork's work-folder mount-name resolution (binary-verified against
 * app.asar 1.14271.0, function cluster at offset ~9569303). Real Cowork mounts each connected work
 * folder at `/sessions/<id>/mnt/<name>` where `<name>` is a collision-resolved BASENAME — NOT under a
 * `.projects/` subdir. Two algorithms exist, selected by tier:
 *
 *   - host-loop  → `hL(folders, RESERVED)` — single-pass sequential; the first of a basename collision
 *     keeps the bare name, later ones get a `--`-prefixed parent. Seeds the reserved special-dir names.
 *   - VM / container → `fy(folders)` — iterative (≤20-round) group-rebalance; EVERY member of a
 *     collision group escalates each round, so two `work` folders both become `a--work`/`b--work`.
 *     Does NOT seed the reserved set.
 *
 * Pure (string in/out, no fs) so it can be asserted byte-for-byte against asar-verified fixtures.
 */

/** Collision separator (`qqA="--"`). */
const SEP = "--";

/**
 * Reserved special-dir names (`bZ`) seeded into the host-loop namer so a user folder named e.g.
 * `outputs` can't collide with a fixed mount. (VM-tier `fy` deliberately does NOT seed these.)
 */
export const RESERVED_MOUNT_NAMES = [
  "outputs",
  "uploads",
  ".host-home",
  ".auto-memory",
  ".remote-plugins",
  ".local-plugins",
  ".projects",
] as const;

export type MountTier = "hostloop" | "container" | "microvm" | "protocol";

/** Path → reversed non-empty segments (deepest first), e.g. `/a/b/c` → `["c","b","a"]`. */
function reversedSegments(p: string): string[] {
  return p
    .split(sep)
    .filter((s) => s.length > 0)
    .reverse();
}

/**
 * `Wie` — name a single path by its basename, prepending parent segments (joined by `--`) while the
 * candidate collides with the `taken` set, until a free name is found or parents are exhausted (in
 * which case the fully-prefixed name is returned even if still colliding).
 */
export function wie(path: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  const segs = reversedSegments(path);
  let name = segs[0];
  let n = 1;
  while (set.has(name) && n < segs.length) {
    name = segs[n] + SEP + name;
    n++;
  }
  return name;
}

/**
 * `hL` — host-loop namer. Sequential: each folder is named via `wie` against the reserved set PLUS
 * every name already assigned in this batch (so the first of a collision keeps the bare name).
 */
export function hL(paths: string[], reserved: readonly string[] = []): Map<string, string> {
  const out = new Map<string, string>();
  const taken = [...reserved];
  for (const p of paths) {
    const name = wie(p, taken);
    taken.push(name);
    out.set(p, name);
  }
  return out;
}

/**
 * `fy` — VM/container namer. Starts everyone at their bare basename, then runs ≤20 rounds of
 * group-rebalance: any name shared by >1 folder makes EVERY member escalate one more parent segment
 * (gated so a folder already at full path depth stops escalating). No reserved seeding.
 */
export function fy(paths: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (paths.length === 0) return out;
  const segsByPath = new Map<string, string[]>();
  for (const p of paths) {
    segsByPath.set(p, reversedSegments(p));
    out.set(p, basename(p));
  }
  for (let i = 20; i-- > 0;) {
    const byName = new Map<string, string[]>();
    for (const [p, name] of out) {
      const group = byName.get(name);
      if (group) group.push(p);
      else byName.set(name, [p]);
    }
    let collided = false;
    for (const group of byName.values()) {
      if (group.length <= 1) continue;
      collided = true;
      for (const p of group) {
        const segs = segsByPath.get(p)!;
        const current = out.get(p)!;
        const depth = current.split(SEP).length;
        if (depth < segs.length) out.set(p, segs[depth] + SEP + current);
      }
    }
    if (!collided) break;
  }
  return out;
}

/**
 * High-level: assign a mount subdir name to each folder host path for the given tier.
 * Callers MUST pass canonicalized (realpath-resolved) paths to match real Cowork's `Os()`=canonical.
 *   - hostloop / protocol → `hL(paths, RESERVED)` (protocol has no real analog; hL is the safe choice).
 *   - container / microvm → `fy(paths)`.
 */
export function assignFolderMountNames(paths: string[], tier: MountTier): Map<string, string> {
  switch (tier) {
    case "container":
    case "microvm":
      return fy(paths);
    case "hostloop":
    case "protocol":
      return hL(paths, RESERVED_MOUNT_NAMES);
  }
}
