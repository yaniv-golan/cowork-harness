import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// spawnProtocol ultimately calls spawn("claude", ...) — mock node:child_process to prevent
// any real subprocess and capture whether the guard fires before the spawn.
const spawnMock = vi.fn(() => ({ stdin: null, stdout: null, stderr: null }));
vi.mock("node:child_process", () => ({ spawn: (...a: any[]) => (spawnMock as any)(...a) }));

import { spawnProtocol } from "../src/runtime/protocol.js";
import type { LaunchPlan } from "../src/session.js";
import type { Scenario, PlatformBaseline } from "../src/types.js";

function minimalPlan(mounts: { hostPath: string; mountPath: string }[], over: Partial<LaunchPlan> = {}): LaunchPlan {
  const root = mkdtempSync(join(tmpdir(), "proto-stage-"));
  const configDir = join(root, "config");
  mkdirSync(join(configDir, "skills"), { recursive: true });
  writeFileSync(join(configDir, "settings.json"), '{"v":1}');
  return {
    configDir,
    mcpConfig: null,
    mounts: mounts.map((m) => ({ ...m, mode: "rw" })),
    pluginDirs: [],
    resume: false,
    baseEnv: {},
    model: undefined,
    permissionMode: undefined,
    ...over,
  } as unknown as LaunchPlan;
}

const SCENARIO = { name: "test-scenario" } as unknown as Scenario;
const BASELINE = {} as unknown as PlatformBaseline;

describe("spawnProtocol — L0 mount staging symlink-escape guard (bug 19)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    spawnMock.mockClear();
    warnSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("rejects a mount whose parent is a symlink pointing OUTSIDE the work directory", () => {
    const root = mkdtempSync(join(tmpdir(), "proto-b19-"));
    const outDir = join(root, "out");
    const outside = mkdtempSync(join(tmpdir(), "proto-b19-outside-"));
    const mountSrc = join(root, "src");
    mkdirSync(mountSrc, { recursive: true });
    writeFileSync(join(mountSrc, "data.txt"), "data");

    // Pre-create work/uploads and work/outputs (spawnProtocol creates them) and then symlink
    // work/escape -> outside so dirname(dest) resolves outside work/.
    const workDir = join(outDir, "work");
    mkdirSync(join(workDir, "uploads"), { recursive: true });
    mkdirSync(join(workDir, "outputs"), { recursive: true });
    symlinkSync(outside, join(workDir, "escape"));

    const plan = minimalPlan([{ hostPath: mountSrc, mountPath: "escape/foo" }]);
    expect(() => spawnProtocol(SCENARIO, BASELINE, plan, outDir)).toThrow(/symlink escape/);
    // The spawn must NOT have been called (guard fires before any copy or spawn).
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("accepts a normal in-tree mount (no symlink escape)", () => {
    const root = mkdtempSync(join(tmpdir(), "proto-b19-ok-"));
    const outDir = join(root, "out");
    const mountSrc = join(root, "src");
    mkdirSync(mountSrc, { recursive: true });
    writeFileSync(join(mountSrc, "file.txt"), "hello");

    const plan = minimalPlan([{ hostPath: mountSrc, mountPath: "uploads/proj" }]);
    expect(() => spawnProtocol(SCENARIO, BASELINE, plan, outDir)).not.toThrow();
    expect(spawnMock).toHaveBeenCalledOnce();
  });
});

describe("spawnProtocol — L0 --effort emission (reasoning-config fidelity, Phase 1)", () => {
  beforeEach(() => spawnMock.mockClear());

  it("emits --effort, falling back to medium when the plan carries no effort and the baseline has no spawn.effortDefault", () => {
    const root = mkdtempSync(join(tmpdir(), "proto-effort-"));
    const outDir = join(root, "out");
    const plan = minimalPlan([]);
    spawnProtocol(SCENARIO, BASELINE, plan, outDir);
    const args = (spawnMock.mock.calls[0] as unknown as [string, string[]])[1];
    expect(args[args.indexOf("--effort") + 1]).toBe("medium");
  });

  it("emits the plan's resolved effort verbatim when set", () => {
    const root = mkdtempSync(join(tmpdir(), "proto-effort-"));
    const outDir = join(root, "out");
    const plan = minimalPlan([], { effort: "high" });
    spawnProtocol(SCENARIO, BASELINE, plan, outDir);
    const args = (spawnMock.mock.calls[0] as unknown as [string, string[]])[1];
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
  });
});
