import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageWorkspace } from "../src/runtime/stage.js";
import type { LaunchPlan } from "../src/session.js";

/** Build a minimal LaunchPlan with a fresh temp configDir + one rw mount + optional mcpConfig. */
function fixture(resume: boolean) {
  const root = mkdtempSync(join(tmpdir(), "stage-"));
  const configDir = join(root, "config");
  mkdirSync(join(configDir, "skills"), { recursive: true });
  writeFileSync(join(configDir, "settings.json"), '{"v":1}');

  const mountSrc = join(root, "proj-src");
  mkdirSync(mountSrc, { recursive: true });
  writeFileSync(join(mountSrc, "file.txt"), "ORIGINAL");

  const mcpSrc = join(root, "mcp.json");
  writeFileSync(mcpSrc, '{"mcpServers":{}}');

  const mntHost = join(root, "work", "session", "mnt");
  const plan = {
    configDir,
    mcpConfig: mcpSrc,
    mounts: [{ hostPath: mountSrc, mountPath: ".projects/proj1", mode: "rw" }],
    resume,
  } as unknown as LaunchPlan;
  return { root, configDir, mountSrc, mntHost, plan };
}

describe("stageWorkspace — resume staging (fidelity guard)", () => {
  it("fresh run (!resume) copies .claude, mounts, and mcp.json", () => {
    const { mntHost, plan } = fixture(false);
    const res = stageWorkspace(plan, mntHost);
    expect(existsSync(join(mntHost, ".claude", "settings.json"))).toBe(true);
    expect(readFileSync(join(mntHost, ".projects/proj1/file.txt"), "utf8")).toBe("ORIGINAL");
    expect(existsSync(join(mntHost, ".claude", "mcp.json"))).toBe(true);
    expect(res.mcpStaged).toBe(true);
  });

  it("resume PRESERVES the persisted tree — no re-copy of .claude or mounts (Cowork same-VM behavior)", () => {
    const { configDir, mntHost, plan } = fixture(true);
    // simulate a prior run: stage the tree, then have the agent/skill write in-session state.
    mkdirSync(join(mntHost, ".claude", "projects"), { recursive: true });
    writeFileSync(join(mntHost, ".claude", "projects", "sess.jsonl"), "AGENT_SESSION"); // resumable session file
    mkdirSync(join(mntHost, ".projects/proj1"), { recursive: true });
    writeFileSync(join(mntHost, ".projects/proj1/file.txt"), "EDITED_IN_SESSION"); // skill edited the rw mount
    writeFileSync(join(mntHost, ".claude", "mcp.json"), '{"mcpServers":{"x":1}}');

    // mutate the host SOURCES so a (wrong) re-copy would be detectable
    writeFileSync(join(configDir, "settings.json"), '{"v":999}');

    const res = stageWorkspace(plan, mntHost);

    // the agent's session file survives, and the in-session mount edit is NOT reverted
    expect(readFileSync(join(mntHost, ".claude", "projects", "sess.jsonl"), "utf8")).toBe("AGENT_SESSION");
    expect(readFileSync(join(mntHost, ".projects/proj1/file.txt"), "utf8")).toBe("EDITED_IN_SESSION");
    // mcp.json present in the preserved tree → still advertised to the guest
    expect(res.mcpStaged).toBe(true);
  });

  it("fresh rerun on a reused outDir does NOT advertise a stale mcp.json when the plan has none", () => {
    // prior run staged a config; this (fresh, non-resume) run has plan.mcpConfig = null but the
    // stale mnt/.claude/mcp.json still sits in the reused outDir.
    const { mntHost, plan } = fixture(false);
    mkdirSync(join(mntHost, ".claude"), { recursive: true });
    writeFileSync(join(mntHost, ".claude", "mcp.json"), '{"mcpServers":{"old":1}}'); // stale leftover
    (plan as { mcpConfig: string | null }).mcpConfig = null; // current plan declares no MCP
    const res = stageWorkspace(plan, mntHost);
    expect(res.mcpStaged).toBe(false); // must NOT leak the removed MCP servers into the new run
  });

  it("fresh run with a declared-but-missing mcp.config throws (no silent drop)", () => {
    const { mntHost, plan } = fixture(false);
    (plan as { mcpConfig: string | null }).mcpConfig = join(mntHost, "..", "nope-mcp.json"); // does not exist
    expect(() => stageWorkspace(plan, mntHost)).toThrow(/mcp.config not found/);
  });

  it("resume does NOT throw on a missing mcp.config source (the staged copy persists)", () => {
    const { mntHost, plan } = fixture(true);
    (plan as { mcpConfig: string | null }).mcpConfig = join(mntHost, "..", "nope-mcp.json");
    expect(() => stageWorkspace(plan, mntHost)).not.toThrow();
  });

  it("a fresh-run mcp.config pointing at a DIRECTORY fails loud (not an opaque cpSync EISDIR)", () => {
    const { root, mntHost, plan } = fixture(false);
    const dir = join(root, "mcp-as-dir");
    mkdirSync(dir, { recursive: true });
    (plan as { mcpConfig: string | null }).mcpConfig = dir; // present, but wrong kind
    expect(() => stageWorkspace(plan, mntHost)).toThrow(/mcp.config must be a file/);
  });

  it("a directory mcp.config fails even under COWORK_HARNESS_SOFT_MISSING (wrong-kind, not missing)", () => {
    const { root, mntHost, plan } = fixture(false);
    const dir = join(root, "mcp-as-dir2");
    mkdirSync(dir, { recursive: true });
    (plan as { mcpConfig: string | null }).mcpConfig = dir;
    const prev = process.env.COWORK_HARNESS_SOFT_MISSING;
    process.env.COWORK_HARNESS_SOFT_MISSING = "1";
    try {
      // softMissing downgrades MISSING sources, but a present-but-wrong-kind source is malformed: still loud.
      expect(() => stageWorkspace(plan, mntHost)).toThrow(/mcp.config must be a file/);
    } finally {
      if (prev === undefined) delete process.env.COWORK_HARNESS_SOFT_MISSING;
      else process.env.COWORK_HARNESS_SOFT_MISSING = prev;
    }
  });

  it("bare dirs are always created (idempotent), even on resume", () => {
    const { mntHost, plan } = fixture(true);
    const res = stageWorkspace(plan, mntHost);
    for (const d of ["uploads", "outputs", ".projects", ".claude"]) {
      expect(existsSync(join(mntHost, d))).toBe(true);
    }
    // resume with no pre-existing mcp.json in the tree → not advertised
    expect(res.mcpStaged).toBe(false);
  });

  // a staged mount destination whose parent resolves (via a pre-existing symlink in the tree)
  // OUTSIDE mntHost must be rejected — `cpSync`/Docker bind follow symlinks at access time, so a copy
  // could otherwise land off-tree. The mount path here is `.projects/proj1`; pre-symlinking `.projects`
  // out of tree makes `dirname(dest)` realpath outside mntHost.
  it("rejects a fresh-run mount whose destination parent is a symlink pointing OUTSIDE the session tree", () => {
    const { mntHost, plan } = fixture(false);
    const outside = mkdtempSync(join(tmpdir(), "stage-b26-outside-"));
    // pre-create mntHost (and .claude so the config copy succeeds) then symlink .projects out of tree.
    mkdirSync(join(mntHost, ".claude"), { recursive: true });
    symlinkSync(outside, join(mntHost, ".projects")); // dest parent now resolves outside mntHost
    expect(() => stageWorkspace(plan, mntHost)).toThrow(/resolves outside the session tree/);
  });
});
