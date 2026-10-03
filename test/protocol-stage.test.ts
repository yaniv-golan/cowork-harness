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

  it("an operator-exported CLAUDE_CODE_EFFORT_LEVEL does not reach the spawned agent; the plan's effort still rides --effort", () => {
    // The agent reads that env key ABOVE --effort, so leaking it would silently replace the scenario's effort.
    const root = mkdtempSync(join(tmpdir(), "proto-effort-env-"));
    const plan = minimalPlan([], { effort: "high", baseEnv: { CLAUDE_CODE_EFFORT_LEVEL: "low", PATH: "/usr/bin" } });
    spawnProtocol(SCENARIO, BASELINE, plan, join(root, "out"));
    const [, args, opts] = spawnMock.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
    expect(opts.env.PATH).toBe("/usr/bin"); // the operator layer did reach the spawn — the absence below is not vacuous
    expect(opts.env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
  });
});

// Hook lifecycle frames at L0, on the same rule as the other tiers: only when a staged plugin declares hooks.
describe("spawnProtocol — --include-hook-events follows plan.includeHookEvents", () => {
  beforeEach(() => spawnMock.mockClear());
  const argsFor = (over: Partial<LaunchPlan>) => {
    spawnProtocol(SCENARIO, BASELINE, minimalPlan([], over), join(mkdtempSync(join(tmpdir(), "proto-hooks-")), "out"));
    return (spawnMock.mock.calls[0] as unknown as [string, string[]])[1];
  };
  it("emits it when the plan says a staged plugin declares hooks", () =>
    expect(argsFor({ includeHookEvents: true })).toContain("--include-hook-events"));
  it("omits it otherwise", () => {
    expect(argsFor({ includeHookEvents: false })).not.toContain("--include-hook-events");
    spawnMock.mockClear();
    expect(argsFor({})).not.toContain("--include-hook-events");
  });
});

// The sub-agent reasoning capture walks whatever root spawnProtocol reports. Under managed config that is the
// run's own config dir (the agent's CLAUDE_CONFIG_DIR). Off it — or when the "managed" dir IS the operator's
// real one — the agent reads the operator's config, which holds every session they ever ran: no root.
describe("spawnProtocol — the config root it reports for the sub-agent reasoning capture", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    spawnMock.mockClear();
    warnSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    for (const k of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"]) vi.stubEnv(k, "");
    vi.stubEnv("CLAUDE_CONFIG_DIR", mkdtempSync(join(tmpdir(), "proto-operator-config-")));
  });
  afterEach(() => {
    warnSpy.mockRestore();
    vi.unstubAllEnvs();
  });
  const run = (plan: LaunchPlan) => spawnProtocol(SCENARIO, BASELINE, plan, join(mkdtempSync(join(tmpdir(), "proto-root-")), "out"));

  it("managed config: the plan's config dir", () => {
    vi.stubEnv("COWORK_MANAGED_CONFIG", "1");
    const plan = minimalPlan([]);
    expect(run(plan).subagentConfigRoot).toBe(plan.configDir);
  });

  it("not managed: none — the operator's real config dir is never walked", () => {
    vi.stubEnv("COWORK_MANAGED_CONFIG", "0");
    expect(run(minimalPlan([])).subagentConfigRoot).toBeUndefined();
  });

  it("managed, but the config dir IS the operator's: none", () => {
    vi.stubEnv("COWORK_MANAGED_CONFIG", "1");
    const plan = minimalPlan([]);
    vi.stubEnv("CLAUDE_CONFIG_DIR", plan.configDir);
    expect(run(plan).subagentConfigRoot).toBeUndefined();
  });
});
