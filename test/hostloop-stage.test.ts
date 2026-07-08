import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, realpathSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHostLoopBindMounts, stageHostLoopWorkspace, snapshotHostLoopWorkspace } from "../src/runtime/hostloop-stage.js";
import { BoundaryError } from "../src/errors.js";
import type { LaunchPlan, Mount } from "../src/session.js";

function makePlan(overrides: Partial<LaunchPlan> = {}, configDir: string): LaunchPlan {
  return {
    configDir,
    mcpConfig: null,
    permissionMode: "default",
    permissionParity: "cowork",
    baseEnv: {},
    mounts: [],
    pluginDirs: [],
    egressAllow: [],
    ...overrides,
  };
}

describe("hostloop-stage", () => {
  let base: string;
  let mntHost: string;
  let configDir: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "hlstage-")));
    mntHost = join(base, "mnt");
    configDir = join(base, "config");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(join(configDir, "skills"), { recursive: true });
    mkdirSync(join(configDir, "projects"), { recursive: true });
  });

  describe("resolveHostLoopBindMounts", () => {
    it("emits one bind per folder mount plus the two .claude ro binds, no full .claude bind", () => {
      const folderMount: Mount = { hostPath: join(base, "proj"), mountPath: "proj", mode: "rw", kind: "folder" };
      const roFolder: Mount = { hostPath: join(base, "roproj"), mountPath: "roproj", mode: "r", kind: "folder" };
      const uploadMount: Mount = { hostPath: join(base, "u.txt"), mountPath: "uploads/u.txt", mode: "r", kind: "upload" };
      const plan = makePlan({ mounts: [folderMount, roFolder, uploadMount] }, configDir);
      const binds = resolveHostLoopBindMounts(plan, "/sessions/x");
      expect(binds).toEqual([
        { hostPath: folderMount.hostPath, guestPath: "/sessions/x/mnt/proj", ro: false },
        { hostPath: roFolder.hostPath, guestPath: "/sessions/x/mnt/roproj", ro: true },
        { hostPath: join(configDir, "skills"), guestPath: "/sessions/x/mnt/.claude/skills", ro: true },
        { hostPath: join(configDir, "projects"), guestPath: "/sessions/x/mnt/.claude/projects", ro: true },
      ]);
      expect(binds.some((b) => b.guestPath === "/sessions/x/mnt/.claude")).toBe(false);
    });
  });

  describe("stageHostLoopWorkspace", () => {
    it("creates bare dirs and does NOT copy folder mounts", () => {
      const folderSrc = join(base, "folder-src");
      mkdirSync(folderSrc, { recursive: true });
      writeFileSync(join(folderSrc, "f.txt"), "hi");
      const folderMount: Mount = { hostPath: folderSrc, mountPath: "myfolder", mode: "rw", kind: "folder" };
      const plan = makePlan({ mounts: [folderMount] }, configDir);
      stageHostLoopWorkspace(plan, mntHost);
      for (const d of ["uploads", "outputs", ".local-plugins", ".remote-plugins"]) expect(existsSync(join(mntHost, d))).toBe(true);
      expect(existsSync(join(mntHost, "myfolder"))).toBe(false); // never copied
    });

    it("stages non-folder mounts (uploads/plugins) as real copies", () => {
      const uploadSrc = join(base, "u.txt");
      writeFileSync(uploadSrc, "payload");
      const uploadMount: Mount = { hostPath: uploadSrc, mountPath: "uploads/u.txt", mode: "r", kind: "upload" };
      const plan = makePlan({ mounts: [uploadMount] }, configDir);
      stageHostLoopWorkspace(plan, mntHost);
      expect(readFileSync(join(mntHost, "uploads", "u.txt"), "utf8")).toBe("payload");
    });

    it("throws (not silent skip) when a non-folder mount source vanished after plan validation (#24)", () => {
      const uploadMount: Mount = { hostPath: join(base, "gone.txt"), mountPath: "uploads/gone.txt", mode: "r", kind: "upload" };
      const plan = makePlan({ mounts: [uploadMount] }, configDir);
      expect(() => stageHostLoopWorkspace(plan, mntHost)).toThrow(/mount source vanished/);
    });

    it("throws BoundaryError when a staged mount path resolves outside the session tree via a symlinked parent", () => {
      mkdirSync(mntHost, { recursive: true });
      const outside = join(base, "outside");
      mkdirSync(outside, { recursive: true });
      symlinkSync(outside, join(mntHost, "escaped-parent"));
      const src = join(base, "plugin-src");
      mkdirSync(src, { recursive: true });
      const pluginMount: Mount = { hostPath: src, mountPath: "escaped-parent/plugin", mode: "r", kind: "local-plugin" };
      const plan = makePlan({ mounts: [pluginMount] }, configDir);
      expect(() => stageHostLoopWorkspace(plan, mntHost)).toThrow(BoundaryError);
    });

    it("resume skips re-staging entirely", () => {
      mkdirSync(mntHost, { recursive: true });
      const uploadSrc = join(base, "u2.txt");
      writeFileSync(uploadSrc, "payload2");
      const uploadMount: Mount = { hostPath: uploadSrc, mountPath: "uploads/u2.txt", mode: "r", kind: "upload" };
      const plan = makePlan({ mounts: [uploadMount], resume: true }, configDir);
      stageHostLoopWorkspace(plan, mntHost);
      expect(existsSync(join(mntHost, "uploads", "u2.txt"))).toBe(false);
    });
  });

  describe("snapshotHostLoopWorkspace", () => {
    it("materializes a folder mount's current real content into the mnt tree", () => {
      mkdirSync(mntHost, { recursive: true });
      const folderSrc = join(base, "live-folder");
      mkdirSync(folderSrc, { recursive: true });
      writeFileSync(join(folderSrc, "agent-output.txt"), "written by agent");
      const folderMount: Mount = { hostPath: folderSrc, mountPath: "myfolder", mode: "rw", kind: "folder" };
      const plan = makePlan({ mounts: [folderMount] }, configDir);
      snapshotHostLoopWorkspace(plan, mntHost);
      expect(readFileSync(join(mntHost, "myfolder", "agent-output.txt"), "utf8")).toBe("written by agent");
    });

    it("rm-before-copy: a file deleted from the real folder is absent post-snapshot (no stale survival)", () => {
      mkdirSync(mntHost, { recursive: true });
      const folderSrc = join(base, "live-folder2");
      mkdirSync(folderSrc, { recursive: true });
      const folderMount: Mount = { hostPath: folderSrc, mountPath: "myfolder2", mode: "rw", kind: "folder" };
      const plan = makePlan({ mounts: [folderMount] }, configDir);
      // simulate a stale snapshot from a prior run containing a file the agent has since deleted
      mkdirSync(join(mntHost, "myfolder2"), { recursive: true });
      writeFileSync(join(mntHost, "myfolder2", "stale.txt"), "should not survive");
      snapshotHostLoopWorkspace(plan, mntHost);
      expect(existsSync(join(mntHost, "myfolder2", "stale.txt"))).toBe(false);
    });

    it("source vanished (TOCTOU): prior snapshot is PRESERVED, not erased (#25)", () => {
      mkdirSync(mntHost, { recursive: true });
      const folderSrc = join(base, "vanished-folder");
      // deliberately DO NOT create folderSrc — simulate a source that vanished after plan validation
      const folderMount: Mount = { hostPath: folderSrc, mountPath: "vfolder", mode: "rw", kind: "folder" };
      const plan = makePlan({ mounts: [folderMount] }, configDir);
      // a prior run's snapshot exists at dest
      mkdirSync(join(mntHost, "vfolder"), { recursive: true });
      writeFileSync(join(mntHost, "vfolder", "prior.txt"), "prior evidence");
      snapshotHostLoopWorkspace(plan, mntHost);
      // the old rm-then-skip order would have deleted this; the fix preserves it
      expect(existsSync(join(mntHost, "vfolder", "prior.txt"))).toBe(true);
    });

    it("no stage filter: an untracked agent-written file IS captured", () => {
      mkdirSync(mntHost, { recursive: true });
      const folderSrc = join(base, "live-folder3");
      mkdirSync(folderSrc, { recursive: true });
      writeFileSync(join(folderSrc, "untracked.txt"), "new file, never git-added");
      const folderMount: Mount = {
        hostPath: folderSrc,
        mountPath: "myfolder3",
        mode: "rw",
        kind: "folder",
        stageFilter: () => false, // even if a stageFilter were present, the snapshot must ignore it
      };
      const plan = makePlan({ mounts: [folderMount] }, configDir);
      snapshotHostLoopWorkspace(plan, mntHost);
      expect(existsSync(join(mntHost, "myfolder3", "untracked.txt"))).toBe(true);
    });

    it("guard-before-destruction: a symlink-escape destination is rejected WITHOUT deleting the out-of-tree target first", () => {
      mkdirSync(mntHost, { recursive: true });
      const outsideTarget = join(base, "precious-outside-dir");
      mkdirSync(outsideTarget, { recursive: true });
      writeFileSync(join(outsideTarget, "must-survive.txt"), "do not delete me");
      symlinkSync(outsideTarget, join(mntHost, "escaped"));
      const folderSrc = join(base, "folder-src2");
      mkdirSync(folderSrc, { recursive: true });
      const folderMount: Mount = { hostPath: folderSrc, mountPath: "escaped/sub", mode: "rw", kind: "folder" };
      const plan = makePlan({ mounts: [folderMount] }, configDir);
      expect(() => snapshotHostLoopWorkspace(plan, mntHost)).toThrow(BoundaryError);
      // the critical regression guard: the out-of-tree target must be UNTOUCHED, not just "an error was thrown"
      expect(existsSync(join(outsideTarget, "must-survive.txt"))).toBe(true);
    });

    it("only kind:folder is snapshotted — uploads/plugins are left alone", () => {
      mkdirSync(mntHost, { recursive: true });
      const uploadSrc = join(base, "u3.txt");
      writeFileSync(uploadSrc, "should not be touched by snapshot");
      const uploadMount: Mount = { hostPath: uploadSrc, mountPath: "uploads/u3.txt", mode: "r", kind: "upload" };
      const plan = makePlan({ mounts: [uploadMount] }, configDir);
      snapshotHostLoopWorkspace(plan, mntHost); // should be a no-op for uploads
      expect(existsSync(join(mntHost, "uploads", "u3.txt"))).toBe(false);
    });
  });
});
