import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, statSync, utimesSync, symlinkSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  snapshotLegTree,
  legSnapshotRoot,
  legSnapshotCap,
  cloneFile,
  CLONE_FALLBACK_CODES,
  darwinTreeCloner,
} from "../src/run/leg-snapshot.js";
import { constants, copyFileSync, existsSync, chmodSync, lstatSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { writeLegPostManifest } from "../src/run/leg-manifest.js";

// A leg's snapshot: its user-visible files cloned when it ended, trusted only while it matches the leg's own post-run
// manifest, and absent (so the leg falls back to the live-tree rules) when over the cap.
let dir: string;
let prev: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ml-snap-"));
  prev = process.env.COWORK_HARNESS_LEG_SNAPSHOT_MAX_BYTES;
});
afterEach(() => {
  if (prev === undefined) delete process.env.COWORK_HARNESS_LEG_SNAPSHOT_MAX_BYTES;
  else process.env.COWORK_HARNESS_LEG_SNAPSHOT_MAX_BYTES = prev;
  rmSync(dir, { recursive: true, force: true });
});

function tree() {
  const work = join(dir, "work");
  const leg = join(dir, "legs", "ask");
  mkdirSync(join(work, "outputs", "runs"), { recursive: true });
  mkdirSync(join(work, "proj"), { recursive: true });
  mkdirSync(leg, { recursive: true });
  writeFileSync(join(work, "outputs", "runs", "status.json"), '{"status":"waiting"}');
  writeFileSync(join(work, "proj", "doc.txt"), "folder file");
  const old = new Date("2026-01-02T03:04:05Z");
  utimesSync(join(work, "proj", "doc.txt"), old, old);
  return { work, leg, roots: ["outputs", "proj"] };
}

describe("leg snapshot", () => {
  it("clones the leg's files with their mtimes, and survives a later change to the tree", () => {
    const { work, leg, roots } = tree();
    symlinkSync("/etc/hosts", join(work, "outputs", "link"));
    writeLegPostManifest(leg, work, roots);
    snapshotLegTree(leg, work, roots);
    writeFileSync(join(work, "outputs", "runs", "status.json"), '{"status":"complete"}'); // a later leg
    const snap = legSnapshotRoot(leg);
    expect(snap).toBe(join(leg, "snapshot"));
    expect(readFileSync(join(snap!, "outputs", "runs", "status.json"), "utf8")).toContain("waiting");
    expect(statSync(join(snap!, "proj", "doc.txt")).mtime.toISOString()).toBe("2026-01-02T03:04:05.000Z");
  });
  it("is not trusted once it differs from the leg's post-run manifest", () => {
    const { work, leg, roots } = tree();
    writeLegPostManifest(leg, work, roots);
    snapshotLegTree(leg, work, roots);
    writeFileSync(join(leg, "snapshot", "outputs", "runs", "status.json"), '{"status":"complete"}');
    expect(legSnapshotRoot(leg)).toBeUndefined();
  });
  it("is not taken over the cap (the leg then falls back to the live-tree rules)", () => {
    const { work, leg, roots } = tree();
    process.env.COWORK_HARNESS_LEG_SNAPSHOT_MAX_BYTES = "5";
    writeLegPostManifest(leg, work, roots);
    snapshotLegTree(leg, work, roots);
    expect(JSON.parse(readFileSync(join(leg, "snapshot.json"), "utf8"))).toMatchObject({
      complete: false,
      reason: /over the 5-byte snapshot cap/,
    });
    expect(legSnapshotRoot(leg)).toBeUndefined();
  });
  it("a malformed cap is refused, not read as the default", () => {
    delete process.env.COWORK_HARNESS_LEG_SNAPSHOT_MAX_BYTES;
    expect(legSnapshotCap()).toBe(512 * 1024 * 1024);
    for (const bad of ["512MiB", "-1", "0", "1.5"]) {
      process.env.COWORK_HARNESS_LEG_SNAPSHOT_MAX_BYTES = bad;
      expect(() => legSnapshotCap(), bad).toThrow(/must be a whole number of bytes >= 1/);
    }
  });
  it("a hard-linked file makes the snapshot untrusted (fails safe: the leg falls back to the live-tree rules)", () => {
    const { work, leg, roots } = tree();
    linkSync(join(work, "proj", "doc.txt"), join(dir, "elsewhere.txt"));
    writeLegPostManifest(leg, work, roots);
    snapshotLegTree(leg, work, roots);
    expect(legSnapshotRoot(leg)).toBeUndefined();
  });
});

/** Can THIS machine's temp filesystem clone, by the route the snapshot takes (macOS: `cp -c`; elsewhere: a forced
 *  FICLONE)? Probed, never assumed; the real-filesystem test below asserts exactly what this predicts. */
const cloneProbe = ((): { ok: true } | { ok: false; code: string } => {
  const d = mkdtempSync(join(tmpdir(), "ml-clone-probe-"));
  try {
    writeFileSync(join(d, "a"), "probe");
    if (darwinTreeCloner) {
      const c = darwinTreeCloner(join(d, "a"), join(d, "b"));
      return c.ok ? { ok: true } : { ok: false, code: "cp -c failed" };
    }
    copyFileSync(join(d, "a"), join(d, "b"), constants.COPYFILE_FICLONE_FORCE);
    return { ok: true };
  } catch (e) {
    return { ok: false, code: (e as NodeJS.ErrnoException).code ?? String(e) };
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
})();
const expectedMethod = cloneProbe.ok
  ? "clone"
  : (CLONE_FALLBACK_CODES as readonly string[]).includes(cloneProbe.code) || cloneProbe.code === "cp -c failed"
    ? "copy"
    : undefined;

type CopyFn = (src: string, dest: string, mode?: number) => void;
const errno = (code: string) => Object.assign(new Error(code), { code });
const forced = (mode?: number) => mode !== undefined && (mode & constants.COPYFILE_FICLONE_FORCE) === constants.COPYFILE_FICLONE_FORCE;
/** A copier that refuses a forced clone with `code` and copies otherwise, recording the mode of each call. */
const noClone =
  (code: string, modes: Array<number | undefined> = []): CopyFn =>
  (src, dest, mode) => {
    modes.push(mode);
    if (forced(mode)) throw errno(code);
    copyFileSync(src, dest);
  };
/** A tree cloner that "clones" by a recursive plain copy keeping modes (`cp -pR`, as the macOS cloner's `-p` does),
 *  or refuses; `okFor` picks which sources it accepts. */
const fakeTree =
  (okFor: boolean | ((src: string) => boolean), calls: string[] = []) =>
  (src: string, dest: string): { ok: true } | { ok: false; why: string } => {
    calls.push(src);
    if (!(typeof okFor === "function" ? okFor(src) : okFor)) return { ok: false, why: "refused by the test" };
    execFileSync("cp", ["-pR", src, dest]);
    return { ok: true };
  };

describe("leg snapshot: clone or copy, recorded", () => {
  it(`a filesystem that cannot clone (${CLONE_FALLBACK_CODES.join(", ")}) gets a plain copy, reported as one`, () => {
    for (const code of CLONE_FALLBACK_CODES) {
      const src = join(dir, `s-${code}`);
      writeFileSync(src, "x");
      const modes: Array<number | undefined> = [];
      expect(cloneFile(src, join(dir, `d-${code}`), noClone(code, modes)), code).toBe("copy");
      expect(modes[1], code).toBeUndefined(); // the retry is a plain copy
      expect(readFileSync(join(dir, `d-${code}`), "utf8")).toBe("x");
    }
  });
  it("any other error from the clone is not a fallback: it throws", () => {
    const src = join(dir, "s");
    writeFileSync(src, "x");
    expect(() => cloneFile(src, join(dir, "d"), noClone("EACCES"))).toThrow(/EACCES/);
  });
  it("a whole-tree clone (macOS) counts every file of the root as cloned, and leaves no symlink in the snapshot", () => {
    const { work, leg, roots } = tree();
    symlinkSync("/etc/hosts", join(work, "outputs", "link"));
    writeLegPostManifest(leg, work, roots);
    const calls: string[] = [];
    snapshotLegTree(leg, work, roots, noClone("ENOTSUP"), fakeTree(true, calls));
    expect(calls).toEqual([join(work, "outputs"), join(work, "proj")]); // one call per root
    expect(JSON.parse(readFileSync(join(leg, "snapshot.json"), "utf8"))).toMatchObject({ method: "clone", cloned: 2, copied: 0 });
    expect(existsSync(join(leg, "snapshot", "outputs", "link"))).toBe(false);
    expect(legSnapshotRoot(leg)).toBe(join(leg, "snapshot"));
  });
  it("a tree clone that fails falls back to the per-file path for that root", () => {
    const { work, leg, roots } = tree();
    writeLegPostManifest(leg, work, roots);
    snapshotLegTree(leg, work, roots, noClone("ENOTSUP"), fakeTree(false));
    expect(JSON.parse(readFileSync(join(leg, "snapshot.json"), "utf8"))).toMatchObject({
      method: "copy",
      cloned: 0,
      copied: 2,
      fallback: ["outputs: refused by the test", "proj: refused by the test"],
    });
    expect(legSnapshotRoot(leg)).toBe(join(leg, "snapshot"));
  });
  it("a read-only directory kept by the tree clone never makes the snapshot throw, and the next snapshot replaces it", () => {
    const { work, leg, roots } = tree();
    mkdirSync(join(work, "outputs", "ro"));
    writeFileSync(join(work, "outputs", "ro", "f.txt"), "x");
    chmodSync(join(work, "outputs", "ro"), 0o555);
    try {
      writeLegPostManifest(leg, work, roots);
      // root 1 clones (keeping the 0555 dir); root 2 then fails with a real error: the catch must clean up, not throw
      expect(() =>
        snapshotLegTree(
          leg,
          work,
          roots,
          noClone("EACCES"),
          fakeTree((src) => src.endsWith("outputs")),
        ),
      ).not.toThrow();
      expect(JSON.parse(readFileSync(join(leg, "snapshot.json"), "utf8"))).toMatchObject({ complete: false });
      // a later snapshot over a kept read-only tree replaces it
      snapshotLegTree(leg, work, roots, noClone("ENOTSUP"), fakeTree(true));
      expect(JSON.parse(readFileSync(join(leg, "snapshot.json"), "utf8"))).toMatchObject({ complete: true, method: "clone" });
      expect(() => snapshotLegTree(leg, work, roots, noClone("ENOTSUP"), fakeTree(true))).not.toThrow();
      expect(JSON.parse(readFileSync(join(leg, "snapshot.json"), "utf8"))).toMatchObject({ complete: true });
    } finally {
      chmodSync(join(work, "outputs", "ro"), 0o755);
      const kept = join(leg, "snapshot", "outputs", "ro");
      if (existsSync(kept)) chmodSync(kept, 0o755);
    }
  });
  it("snapshot.json records the method: copy, mixed (one root cloned, another copied), none with no files", () => {
    const { work, leg, roots } = tree();
    writeLegPostManifest(leg, work, roots);
    snapshotLegTree(leg, work, roots, noClone("ENOTSUP"), null);
    expect(JSON.parse(readFileSync(join(leg, "snapshot.json"), "utf8"))).toMatchObject({
      complete: true,
      method: "copy",
      cloned: 0,
      copied: 2,
    });

    let n = 0; // the first file "clones" (a plain copy reported as one); the next cannot
    const half: CopyFn = (src, dest, mode) => {
      if (forced(mode) && n++ > 0) throw errno("EXDEV");
      copyFileSync(src, dest);
    };
    snapshotLegTree(leg, work, roots, half, null);
    expect(JSON.parse(readFileSync(join(leg, "snapshot.json"), "utf8"))).toMatchObject({ method: "mixed", cloned: 1, copied: 1 });

    const empty = join(dir, "empty");
    mkdirSync(join(empty, "outputs"), { recursive: true });
    const leg2 = join(dir, "legs", "b");
    mkdirSync(leg2, { recursive: true });
    snapshotLegTree(leg2, empty, ["outputs"]);
    expect(JSON.parse(readFileSync(join(leg2, "snapshot.json"), "utf8"))).toMatchObject({ complete: true, method: "none" });
    expect(existsSync(join(leg2, "snapshot", "outputs"))).toBe(true);
  });
  it(`on this machine's real filesystem the recorded method is what the clone probe predicts (${cloneProbe.ok ? "clones" : cloneProbe.code} → ${expectedMethod ?? "unknown"})`, () => {
    // Runs everywhere and cannot pass vacuously: it asserts the method the probe predicts, whatever this disk is.
    expect(expectedMethod, `unexpected probe answer ${JSON.stringify(cloneProbe)}`).toBeDefined();
    const { work, leg, roots } = tree();
    writeLegPostManifest(leg, work, roots);
    snapshotLegTree(leg, work, roots);
    const meta = JSON.parse(readFileSync(join(leg, "snapshot.json"), "utf8"));
    expect(meta.method).toBe(expectedMethod);
    expect(legSnapshotRoot(leg)).toBe(join(leg, "snapshot")); // a clone or a copy, the snapshot is trusted
    expect(statSync(join(leg, "snapshot", "proj", "doc.txt")).mtime.toISOString()).toBe("2026-01-02T03:04:05.000Z");
  });
});

// The real macOS cloner, on real volumes. CI has no macOS runner, so these run on a maintainer's Mac only; elsewhere
// they skip with that reason. The probe above uses the same `cp -c` as the snapshot, so on macOS the generic
// real-filesystem test cannot tell a clone from cp's silent fallback copy; the disk-image cases here can.
const onMac = process.platform === "darwin" && existsSync("/usr/bin/hdiutil");
describe.skipIf(!onMac)(`leg snapshot on macOS volumes${onMac ? "" : " (SKIPPED: needs macOS with hdiutil)"}`, () => {
  const images: string[] = [];
  const attach = (fs: "HFS+" | "APFS", name: string): string => {
    const img = join(dir, `${name}.dmg`);
    execFileSync("/usr/bin/hdiutil", ["create", "-size", "20m", "-fs", fs, "-volname", name, img], { stdio: "ignore" });
    const out = execFileSync("/usr/bin/hdiutil", ["attach", "-nobrowse", img], { encoding: "utf8" });
    const mount = out.trim().split("\n").pop()!.split("\t").pop()!.trim();
    images.push(mount);
    return mount;
  };
  afterEach(() => {
    for (const m of images.splice(0)) execFileSync("/usr/bin/hdiutil", ["detach", "-force", m], { stdio: "ignore" });
  });
  const treeAt = (base: string) => {
    const work = join(base, "work");
    mkdirSync(join(work, "outputs", "runs"), { recursive: true });
    writeFileSync(join(work, "outputs", "runs", "status.json"), '{"status":"waiting"}');
    return { work, roots: ["outputs"] };
  };
  const snap = (legBase: string, work: string, roots: string[]) => {
    const leg = join(legBase, "legs", "ask");
    mkdirSync(leg, { recursive: true });
    writeLegPostManifest(leg, work, roots);
    snapshotLegTree(leg, work, roots);
    return { leg, meta: JSON.parse(readFileSync(join(leg, "snapshot.json"), "utf8")) };
  };

  it("the same APFS volume clones; a symlink to a DIRECTORY in the tree is removed, not fatal (it threw on Node 25)", () => {
    const { work, roots } = treeAt(dir);
    mkdirSync(join(dir, "elsewhere"));
    symlinkSync(join(dir, "elsewhere"), join(work, "outputs", "dirlink"));
    const { leg, meta } = snap(dir, work, roots);
    expect(meta).toMatchObject({ complete: true, method: "clone", cloned: 1 });
    expect(existsSync(join(leg, "snapshot", "outputs", "dirlink"))).toBe(false);
    expect(lstatSync(join(work, "outputs", "dirlink")).isSymbolicLink()).toBe(true); // the source is untouched
  });
  it("a tree on another device is copied file by file and recorded as a copy, with the reason", () => {
    const vol = attach("APFS", "cwhapfs2");
    const { work, roots } = treeAt(vol);
    const { meta } = snap(dir, work, roots);
    expect(meta).toMatchObject({ complete: true, method: "copy", cloned: 0, copied: 1 });
    expect(meta.fallback.join(" ")).toMatch(/another device/);
  });
  it("a tree and snapshot both on HFS+ (no clone) are recorded as a copy, with the reason", () => {
    const vol = attach("HFS+", "cwhhfs");
    const { work, roots } = treeAt(vol);
    const { meta } = snap(vol, work, roots);
    expect(meta).toMatchObject({ complete: true, method: "copy", copied: 1 });
    expect(meta.fallback.join(" ")).toMatch(/not apfs/);
  });
});
