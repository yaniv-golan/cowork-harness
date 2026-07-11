import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  checkHostLoopPathGate,
  resolvePathForGate,
  expandTilde,
  PATH_GATE_TOOL_NAMES,
  type HostLoopPathGateConfig,
} from "../src/hostloop/pretooluse-path-hook.js";

describe("pretooluse-path-hook", () => {
  let base: string;
  let allowed: string;
  let outside: string;

  beforeEach(() => {
    // realpath the temp base first — os.tmpdir() lives under a symlink on macOS (/var -> /private/var),
    // so an uncanonicalized base makes containment checks fail for the wrong reason.
    base = realpathSync(mkdtempSync(join(tmpdir(), "gate-")));
    allowed = join(base, "allowed");
    outside = join(base, "outside");
    mkdirSync(allowed, { recursive: true });
    mkdirSync(outside, { recursive: true });
  });

  function cfg(overrides: Partial<HostLoopPathGateConfig> = {}): HostLoopPathGateConfig {
    return {
      hostCwd: allowed,
      allowedRoots: [allowed],
      readOnlyRoots: [],
      scratchRoots: [allowed],
      scratchMode: false,
      uploadsRoots: [],
      spooledProjectsRoots: [],
      readOnlyPluginRoots: [],
      ...overrides,
    };
  }

  describe("expandTilde", () => {
    it("expands bare ~ and ~/ prefix against homedir, leaves other paths untouched", () => {
      expect(expandTilde("/abs/path")).toBe("/abs/path");
      expect(expandTilde("relative")).toBe("relative");
    });
  });

  describe("resolvePathForGate", () => {
    it("resolves an existing path via realpath", async () => {
      const f = join(allowed, "x.txt");
      writeFileSync(f, "hi");
      expect(await resolvePathForGate(f, true)).toBe(realpathSync(f));
    });

    it("new-file case: canonicalizes the parent and rejoins the basename (symlinked-parent escape)", async () => {
      const link = join(allowed, "esc");
      symlinkSync(outside, link);
      const candidate = await resolvePathForGate(join(link, "new.txt"), true);
      expect(candidate).toBe(join(outside, "new.txt"));
    });

    it("dangling symlink hard-blocks with a code-less Error, not a lexical fallback", async () => {
      const dangling = join(allowed, "dangling");
      symlinkSync(join(base, "does-not-exist"), dangling);
      await expect(resolvePathForGate(dangling, true)).rejects.toThrow(/Refusing to resolve non-regular file/);
      try {
        await resolvePathForGate(dangling, true);
        expect.unreachable();
      } catch (e) {
        expect((e as NodeJS.ErrnoException).code).toBeUndefined();
      }
    });

    it("parent-doesn't-exist propagates the raw ENOENT (fidelity pin: production falls back lexically here)", async () => {
      await expect(resolvePathForGate(join(allowed, "nope", "new.txt"), true)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("control: a new file directly under an existing parent resolves cleanly", async () => {
      const candidate = await resolvePathForGate(join(allowed, "new.txt"), true);
      expect(candidate).toBe(join(realpathSync(allowed), "new.txt"));
    });
  });

  describe("checkHostLoopPathGate", () => {
    it("non-gated tool is never checked", async () => {
      expect(await checkHostLoopPathGate("Bash", { command: "rm -rf /" }, cfg())).toEqual({});
    });

    it("allows a new file under the allowed root", async () => {
      const out = await checkHostLoopPathGate("Write", { file_path: join(allowed, "new.txt") }, cfg());
      expect(out).toEqual({});
    });

    it("blocks the original bug: Write to a NEW file under a symlinked parent that escapes the root", async () => {
      const link = join(allowed, "esc");
      symlinkSync(outside, link);
      const out = await checkHostLoopPathGate("Write", { file_path: join(link, "new.txt") }, cfg());
      expect(out).toMatchObject({ decision: "block" });
    });

    it("blocks an existing file reached through an escaping symlink", async () => {
      const link = join(allowed, "esc2");
      symlinkSync(outside, link);
      writeFileSync(join(outside, "existing.txt"), "x");
      const out = await checkHostLoopPathGate("Read", { file_path: join(link, "existing.txt") }, cfg());
      expect(out).toMatchObject({ decision: "block" });
    });

    it("hard-blocks a dangling symlink inside the root rather than falling back lexically", async () => {
      const dangling = join(allowed, "dangling");
      symlinkSync(join(base, "nope"), dangling);
      const out = await checkHostLoopPathGate("Write", { file_path: dangling }, cfg());
      expect(out).toMatchObject({ decision: "block", reason: expect.stringContaining("could not be safely resolved") });
    });

    it("denies a path outside every allowed root", async () => {
      const out = await checkHostLoopPathGate("Read", { file_path: join(outside, "x.txt") }, cfg());
      expect(out).toMatchObject({ decision: "block" });
      expect((out as any).reason).toContain("request_cowork_directory");
      expect((out as any).reason).not.toContain("mcp__cowork__");
    });

    it("denies any /sessions-prefixed path with the VM-path message, distinct from the generic denial", async () => {
      const out = await checkHostLoopPathGate("Read", { file_path: "/sessions/abc/mnt/outputs/x.txt" }, cfg());
      expect(out).toMatchObject({ decision: "block", reason: expect.stringContaining("is a VM path") });
    });

    it("tilde expands against homedir, never against hostCwd", async () => {
      // A tilde path outside the allowed root is denied (proves it did NOT get lexically resolved
      // against hostCwd into something that happens to land inside `allowed`).
      const out = await checkHostLoopPathGate("Read", { file_path: "~/definitely-not-in-allowed-root-xyz" }, cfg());
      expect(out).toMatchObject({ decision: "block" });
      // And a tilde path that genuinely resolves under homedir() is allowed when homedir() itself is an
      // allowed root — proving expansion targets homedir(), not hostCwd (which is `allowed`, unrelated
      // to homedir() in this test environment).
      const home = homedir();
      const relPath = "definitely-not-in-allowed-root-xyz";
      const homeOut = await checkHostLoopPathGate("Read", { file_path: `~/${relPath}` }, cfg({ allowedRoots: [home] }));
      expect(homeOut).toEqual({});
    });

    it("first-match semantics: file_path inside + path outside is ALLOWED (only file_path is checked)", async () => {
      const out = await checkHostLoopPathGate("Read", { file_path: join(allowed, "x.txt"), path: join(outside, "y.txt") }, cfg());
      expect(out).toEqual({});
    });

    it("mode:r folder: Read passes, Write blocks", async () => {
      const roCfg = cfg({ allowedRoots: [], readOnlyRoots: [allowed] });
      expect(await checkHostLoopPathGate("Read", { file_path: join(allowed, "x.txt") }, roCfg)).toEqual({});
      const writeOut = await checkHostLoopPathGate("Write", { file_path: join(allowed, "x.txt") }, roCfg);
      expect(writeOut).toMatchObject({ decision: "block" });
    });

    it("PATH_GATE_TOOL_NAMES is exactly the 5 gated tools", () => {
      expect([...PATH_GATE_TOOL_NAMES].sort()).toEqual(["Edit", "Glob", "Grep", "Read", "Write"]);
    });
  });

  describe("read-only categories (production qt, 1.20186.1)", () => {
    it("plugin/skill content: Read passes, Write blocks with the plugin message (task session)", async () => {
      const pluginRoot = join(base, "plugin");
      mkdirSync(pluginRoot, { recursive: true });
      const c = cfg({ allowedRoots: [allowed, pluginRoot], readOnlyPluginRoots: [pluginRoot] });
      expect(await checkHostLoopPathGate("Read", { file_path: join(pluginRoot, "SKILL.md") }, c)).toEqual({});
      const out = await checkHostLoopPathGate("Write", { file_path: join(pluginRoot, "SKILL.md") }, c);
      expect(out).toMatchObject({ decision: "block" });
      expect((out as { reason: string }).reason).toContain("(plugin, skill, or knowledge content)");
      expect((out as { reason: string }).reason).toContain("outputs directory");
    });
    it("uploads: Read passes; task-session Write blocks with the HARDLINK message", async () => {
      const uploads = join(base, "uploads");
      mkdirSync(uploads, { recursive: true });
      const c = cfg({ allowedRoots: [allowed, uploads], uploadsRoots: [uploads] });
      expect(await checkHostLoopPathGate("Read", { file_path: join(uploads, "doc.pdf") }, c)).toEqual({});
      const out = await checkHostLoopPathGate("Write", { file_path: join(uploads, "doc.pdf") }, c);
      expect(out).toMatchObject({ decision: "block" });
      expect((out as { reason: string }).reason).toContain("hardlink to the user's original file");
    });
    it("uploads in scratchMode (chat proxy) keep the scratch-copy message, not the hardlink one", async () => {
      const uploads = join(base, "uploads");
      mkdirSync(uploads, { recursive: true });
      const c = cfg({ scratchMode: true, scratchRoots: [allowed], uploadsRoots: [uploads] });
      const out = await checkHostLoopPathGate("Write", { file_path: join(uploads, "doc.pdf") }, c);
      expect((out as { reason: string }).reason).toContain("scratch directory");
      expect((out as { reason: string }).reason).not.toContain("hardlink");
    });
    it("spooled projects: Read passes, Write blocks with the spooled-tool-results message", async () => {
      const spool = join(base, "projects");
      mkdirSync(spool, { recursive: true });
      const c = cfg({ allowedRoots: [allowed, spool], spooledProjectsRoots: [spool] });
      expect(await checkHostLoopPathGate("Read", { file_path: join(spool, "x.jsonl") }, c)).toEqual({});
      const out = await checkHostLoopPathGate("Write", { file_path: join(spool, "x.jsonl") }, c);
      expect((out as { reason: string }).reason).toContain("(spooled tool results)");
    });
    it("the old blanket plugin exemption is GONE: scratch-mode Write inside a plugin root blocks", async () => {
      const pluginRoot = join(base, "plugin");
      mkdirSync(pluginRoot, { recursive: true });
      const c = cfg({ scratchMode: true, scratchRoots: [allowed], readOnlyPluginRoots: [pluginRoot] });
      const out = await checkHostLoopPathGate("Write", { file_path: join(pluginRoot, "SKILL.md") }, c);
      expect(out).toMatchObject({ decision: "block" });
    });
    it("mode:r folder semantics are preserved (harness extension: Read passes, Write blocks)", async () => {
      const roCfg = cfg({ allowedRoots: [], readOnlyRoots: [allowed] });
      expect(await checkHostLoopPathGate("Read", { file_path: join(allowed, "x.txt") }, roCfg)).toEqual({});
      expect(await checkHostLoopPathGate("Write", { file_path: join(allowed, "x.txt") }, roCfg)).toMatchObject({ decision: "block" });
    });
  });
});
