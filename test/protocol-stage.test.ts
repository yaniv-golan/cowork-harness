import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// spawnProtocol ultimately calls spawn("claude", ...) — mock node:child_process to prevent
// any real subprocess and capture whether the guard fires before the spawn.
const spawnMock = vi.fn(() => ({ stdin: null, stdout: null, stderr: null }));
// spawnSync: doctor's Keychain presence probe, reached on the no-credential refusal — reports no entry.
vi.mock("node:child_process", () => ({ spawn: (...a: any[]) => (spawnMock as any)(...a), spawnSync: () => ({ status: 1 }) }));

import { spawnProtocol } from "../src/runtime/protocol.js";
import { BoundaryError, UsageError } from "../src/errors.js";
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

// spawnProtocol refuses without a credential in the environment (doctor's tokenCheck): every block here that is not
// about that refusal runs with a fake token, and a temp operator config dir so the seal assertion never compares
// against the developer's real one.
beforeEach(() => {
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "stub-not-a-real-token");
  vi.stubEnv("CLAUDE_CONFIG_DIR", mkdtempSync(join(tmpdir(), "proto-operator-default-")));
});
afterEach(() => vi.unstubAllEnvs());
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

// The protocol agent always reads the run's managed config dir: it is CLAUDE_CONFIG_DIR, it is the root the sub-agent
// reasoning capture walks, and no `--settings` flag points anywhere else. Two refusals guard it before any spawn: no
// credential in the environment (a Keychain or /login session cannot authenticate a managed dir), and a config dir that
// IS the operator's own.
describe("spawnProtocol — the sealed config dir and the credential it needs", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    spawnMock.mockClear();
    warnSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) vi.stubEnv(k, "");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "stub-not-a-real-token");
    vi.stubEnv("CLAUDE_CONFIG_DIR", mkdtempSync(join(tmpdir(), "proto-operator-config-")));
  });
  afterEach(() => {
    warnSpy.mockRestore();
    vi.unstubAllEnvs();
  });
  const run = (plan: LaunchPlan) => spawnProtocol(SCENARIO, BASELINE, plan, join(mkdtempSync(join(tmpdir(), "proto-root-")), "out"));
  const spawned = () => spawnMock.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }];

  it.each(["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"])(
    "with %s: the plan's config dir is CLAUDE_CONFIG_DIR and the capture root, and argv has no --settings",
    (key) => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
      vi.stubEnv(key, "stub-not-a-real-credential");
      const plan = minimalPlan([]);
      expect(run(plan).subagentConfigRoot).toBe(plan.configDir);
      const [, args, opts] = spawned();
      expect(opts.env.CLAUDE_CONFIG_DIR).toBe(plan.configDir);
      expect(args).not.toContain("--settings");
    },
  );

  it("the config dir IS the operator's own: a BoundaryError, and no spawn", () => {
    const plan = minimalPlan([]);
    vi.stubEnv("CLAUDE_CONFIG_DIR", plan.configDir);
    expect(() => run(plan)).toThrow(BoundaryError);
    expect(() => run(plan)).toThrow(/is your own config dir/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("no credential in the environment: refused with doctor's own row, and no spawn", () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
    expect(() => run(minimalPlan([]))).toThrow(UsageError);
    expect(() => run(minimalPlan([]))).toThrow(
      /^test-scenario: fidelity protocol needs a credential in the environment \(env \/ \.env\) — .* Fix: .*\. The agent runs with a managed config dir, so a Keychain or \/login session is not used\.$/,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("spawnProtocol — answer_channel: none and agent_env.artifacts_root", () => {
  beforeEach(() => spawnMock.mockClear());
  const run = (over: Partial<LaunchPlan>) => {
    const root = mkdtempSync(join(tmpdir(), "proto-answer-"));
    const outDir = join(root, "out");
    spawnProtocol(SCENARIO, BASELINE, minimalPlan([], over), outDir);
    const [, args, opts] = spawnMock.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
    return { args, env: opts.env, outDir };
  };

  it("absent key: the stdio tool, and no --permission-prompts", () => {
    const { args } = run({});
    expect(args[args.indexOf("--permission-prompt-tool") + 1]).toBe("stdio");
    expect(args).not.toContain("--permission-prompts");
  });

  it("none: removes exactly the stdio pair and adds --permission-prompts none", () => {
    // Each run stages its own config dir, so its --settings path differs; nothing else may.
    const norm = (a: string[]) => a.map((x) => (x.endsWith("settings.json") ? "<settings>" : x));
    const before = norm(run({}).args);
    spawnMock.mockClear();
    const after = norm(run({ answerChannel: "none" }).args);
    expect(after).not.toContain("--permission-prompt-tool");
    expect(after[after.indexOf("--permission-prompts") + 1]).toBe("none");
    const i = before.indexOf("--permission-prompt-tool");
    expect([...before.slice(0, i), "--permission-prompts", "none", ...before.slice(i + 2)]).toEqual(after);
  });

  it("artifacts_root resolves against the HOST outputs dir; an operator export does not leak", () => {
    const { env, outDir } = run({ artifactsRoot: "artifacts", baseEnv: { COWORK_ARTIFACTS_ROOT: "/stray" } });
    expect(env.COWORK_ARTIFACTS_ROOT).toBe(join(outDir, "work", "outputs", "artifacts"));
  });

  it("no artifacts_root: the operator's export is scrubbed and nothing is set", () => {
    const { env } = run({ baseEnv: { COWORK_ARTIFACTS_ROOT: "/stray", PATH: "/usr/bin" } });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.COWORK_ARTIFACTS_ROOT).toBeUndefined();
  });
});

// Cowork's background-tasks switch reaches the spawned agent at L0, from the baseline's spawn.env, and an operator
// export does not replace it. Asserted at the spawn call, so a regression between buildProtocolEnv and spawn is red.
describe("spawnProtocol — CLAUDE_CODE_DISABLE_BACKGROUND_TASKS reaches the spawn", () => {
  beforeEach(() => spawnMock.mockClear());
  const envFor = (baseline: PlatformBaseline, baseEnv: NodeJS.ProcessEnv) => {
    spawnProtocol(SCENARIO, baseline, minimalPlan([], { baseEnv }), join(mkdtempSync(join(tmpdir(), "proto-bg-")), "out"));
    return (spawnMock.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }])[2].env;
  };
  const PINNED = { spawn: { env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" } } } as unknown as PlatformBaseline;
  it("the baseline's pinned value, over an operator export", () => {
    const env = envFor(PINNED, { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "0", PATH: "/usr/bin" });
    expect(env.PATH).toBe("/usr/bin"); // the operator layer reached the spawn
    expect(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe("1");
  });
  it("a baseline that pins none: no key, the operator's export dropped too", () => {
    expect(envFor(BASELINE, { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "0" }).CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBeUndefined();
  });
});
