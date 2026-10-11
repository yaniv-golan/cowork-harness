import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageWorkspace } from "../src/runtime/stage.js";
import { workBaseOf, type LaunchPlan } from "../src/session.js";

// How a later leg of a multi-leg run stages its session tree. `persistent`: the same tree, nothing re-copied, config
// kept. `cowork-task`: a new tree staged fresh, each connected folder carried from the previous leg's post-state, and
// outputs not carried.

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ml-stage-"));
  const configDir = join(root, "config");
  mkdirSync(join(configDir, "skills"), { recursive: true });
  writeFileSync(join(configDir, "settings.json"), '{"v":1}');
  const folderSrc = join(root, "folder-src");
  mkdirSync(folderSrc, { recursive: true });
  writeFileSync(join(folderSrc, "doc.txt"), "ORIGINAL");
  const mcpSrc = join(root, "mcp.json");
  writeFileSync(mcpSrc, '{"mcpServers":{}}');
  const mounts = [{ hostPath: folderSrc, mountPath: "proj", mode: "rw", kind: "folder" }];
  const plan = (extra: Partial<LaunchPlan>) => ({ configDir, mcpConfig: mcpSrc, mounts, resume: false, ...extra }) as unknown as LaunchPlan;
  return { root, configDir, folderSrc, plan };
}
const roots = { sessionRoot: "/sessions/t", vmSessionRoot: "/sessions/t" };

describe("stageWorkspace: a later persistent leg", () => {
  it("reuses the tree: no re-copy of folders or config, and MCP follows the current plan", () => {
    const { root, configDir, plan } = fixture();
    const mnt = join(root, "work", "session", "mnt");
    stageWorkspace(plan({}), mnt, roots); // leg 1: fresh
    writeFileSync(join(mnt, "proj", "doc.txt"), "WRITTEN_BY_LEG_1");
    writeFileSync(join(mnt, "outputs", "status.json"), '{"status":"waiting"}');
    mkdirSync(join(mnt, ".claude", "projects"), { recursive: true });
    writeFileSync(join(mnt, ".claude", "projects", "memory.md"), "LEG_1_STATE");
    writeFileSync(join(configDir, "settings.json"), '{"v":2}'); // a (wrong) re-copy would show

    const res = stageWorkspace(plan({ legStage: { workdir: "persistent" } }), mnt, roots);
    expect(readFileSync(join(mnt, "proj", "doc.txt"), "utf8")).toBe("WRITTEN_BY_LEG_1");
    expect(readFileSync(join(mnt, "outputs", "status.json"), "utf8")).toContain("waiting");
    expect(readFileSync(join(mnt, ".claude", "projects", "memory.md"), "utf8")).toBe("LEG_1_STATE");
    expect(readFileSync(join(mnt, ".claude", "settings.json"), "utf8")).toBe('{"v":1}');
    expect(res.mcpStaged).toBe(true);
  });
});

describe("stageWorkspace: a later cowork-task leg", () => {
  it("stages fresh, carries each folder's post-state (mtimes kept), and does not carry outputs or config", () => {
    const { root, plan } = fixture();
    const mnt1 = join(root, "legs", "ask", "work", "session", "mnt");
    stageWorkspace(plan({}), mnt1, roots);
    writeFileSync(join(mnt1, "proj", "doc.txt"), "WRITTEN_BY_LEG_1");
    const old = new Date("2026-01-02T03:04:05Z");
    utimesSync(join(mnt1, "proj", "doc.txt"), old, old);
    writeFileSync(join(mnt1, "outputs", "status.json"), "{}");
    mkdirSync(join(mnt1, ".claude", "projects"), { recursive: true });
    writeFileSync(join(mnt1, ".claude", "projects", "memory.md"), "LEG_1_STATE");

    const mnt2 = join(root, "legs", "resume", "work", "session", "mnt");
    stageWorkspace(plan({ legStage: { workdir: "cowork-task", carryFromMnt: mnt1 } }), mnt2, roots);
    expect(readFileSync(join(mnt2, "proj", "doc.txt"), "utf8")).toBe("WRITTEN_BY_LEG_1");
    expect(statSync(join(mnt2, "proj", "doc.txt")).mtime.toISOString()).toBe(old.toISOString());
    expect(existsSync(join(mnt2, "outputs", "status.json"))).toBe(false);
    expect(existsSync(join(mnt2, ".claude", "projects", "memory.md"))).toBe(false);
    expect(existsSync(join(mnt2, ".claude", "settings.json"))).toBe(true);
  });

  it("refuses when the previous leg's folder is missing rather than staging the original source", () => {
    const { root, plan } = fixture();
    const empty = join(root, "nothing");
    mkdirSync(empty);
    expect(() => stageWorkspace(plan({ legStage: { workdir: "cowork-task", carryFromMnt: empty } }), join(root, "m2"), roots)).toThrow(
      /previous leg's proj is missing/,
    );
  });
});

describe("workBaseOf", () => {
  it("is the plan's workBase when set, else the run dir — resolved either way", () => {
    expect(workBaseOf({}, "rel/run")).toBe(join(process.cwd(), "rel/run"));
    expect(workBaseOf({ workBase: "/s/root" }, "/s/root/legs/a")).toBe("/s/root");
  });
});
