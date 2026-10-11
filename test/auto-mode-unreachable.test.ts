import { describe, it, expect } from "vitest";
import { agentArgs } from "../src/runtime/argv.js";
import { resolvePermissionMode, SessionConfig } from "../src/session.js";
import { loadBaseline } from "../src/baseline.js";
import type { LaunchPlan } from "../src/session.js";
import type { PlatformBaseline } from "../src/types.js";

/**
 * AUTO-MODE IS STRUCTURALLY UNREACHABLE — the load-bearing premise of the
 * "Auto-mode permission rubric is not modeled" gap (docs/fidelity-gaps.md).
 *
 * Why this needs a test rather than a doc sentence. The gap write-up rests the claim on "the harness
 * never constructs `settings.autoMode`". That is true but it is NOT the mechanism that makes the rubric
 * unreachable, and the weaker reading has a hole worth naming: the agent's
 * `AUTO_MODE_TRUSTED_SOURCES` is `["userSettings","flagSettings","policySettings"]` — **userSettings is
 * trusted** — and the harness passes `--setting-sources user`. So an operator's own settings ARE a
 * trusted source for auto-mode's allow/soft_deny/hard_deny/environment rules, and at protocol/hostloop
 * under OAuth the agent reads the operator's REAL config dir.
 *
 * What actually closes it (binary-verified, agent 2.1.237): auto-mode is entered on
 * `permissionMode === "auto"` alone —
 *
 *     if (e.permissionMode === "auto") r = fme(r)
 *
 * — so trusted SOURCES govern only where the rules would be read from, never whether the mode is on.
 * Two independent structural guards keep the harness out of it, and this file pins both, because each
 * is one edit away from silently disappearing:
 *
 *   1. the session schema's `permission_mode` enum has no "auto" member, so no scenario can ask for it;
 *   2. the argv builder's only sources for the flag are that session value and the baseline's pinned
 *      `spawn.permissionMode` — neither of which can be "auto".
 *
 * If a future release adds auto-mode support, these fail, and that is the point: the rubric's ~72 risk
 * categories (including the six `cowork_*` ones added in agent 2.1.237 — cowork_folder_access,
 * cowork_delete_grant, cowork_skill_persistence and the scheduled-task trio) become reachable the moment
 * the mode does, and the gap must be re-triaged before that ships rather than after.
 */

const PLAN = (permissionMode: string): LaunchPlan =>
  ({
    configDir: "/HOST/CFG",
    mcpConfig: null,
    permissionMode,
    permissionParity: "cowork",
    baseEnv: {},
    mounts: [],
    pluginDirs: [],
    egressAllow: [],
  }) as unknown as LaunchPlan;

const flagValue = (argv: string[]): string | undefined => argv[argv.indexOf("--permission-mode") + 1];

describe("auto-mode cannot be requested through the session schema", () => {
  it('rejects permission_mode: "auto" — the enum is the first guard', () => {
    const parsed = SessionConfig.safeParse({ permission_mode: "auto" });
    expect(parsed.success).toBe(false);
  });

  it("accepts exactly the four modeled modes, and auto is not among them", () => {
    // Spelled out rather than derived from the enum: deriving it from the schema would make the
    // assertion true by construction and it could never catch an added "auto".
    for (const mode of ["default", "acceptEdits", "plan", "bypassPermissions"])
      expect(SessionConfig.safeParse({ permission_mode: mode }).success, mode).toBe(true);
    expect(SessionConfig.safeParse({ permission_mode: "auto" }).success).toBe(false);
  });

  it("a session that says nothing resolves to `default` (acceptEdits under device_bridge), never auto", () => {
    const parsed = SessionConfig.parse({});
    expect(parsed.permission_mode).toBeUndefined();
    expect(resolvePermissionMode(parsed, false).permissionMode).toBe("default");
    expect(resolvePermissionMode(parsed, true).permissionMode).toBe("acceptEdits");
  });
});

describe("agentArgs never emits --permission-mode auto", () => {
  const baseline = loadBaseline("latest");

  it("the committed baseline pins spawn.permissionMode to a non-auto mode", () => {
    expect(baseline.spawn?.permissionMode).toBe("default");
  });

  it("passes the session mode through for every mode the schema admits — none of them auto", () => {
    for (const mode of ["default", "acceptEdits", "plan", "bypassPermissions"]) {
      const argv = agentArgs(baseline, PLAN(mode), { mntRoot: "/sessions/x/mnt" } as never);
      expect(flagValue(argv), mode).toBe(mode);
      expect(argv).not.toContain("auto");
    }
  });

  it("falls back to the baseline's pinned mode, not to auto, when the plan carries none", () => {
    const argv = agentArgs(baseline, PLAN(undefined as unknown as string), { mntRoot: "/sessions/x/mnt" } as never);
    expect(flagValue(argv)).toBe("default");
  });

  it("MUTATION: a baseline pinning auto would surface here rather than silently spawn auto-mode", () => {
    // Constructs the case where the claim WOULD be false: if spawn.permissionMode ever resolved to
    // "auto", the flag carries it straight through. Nothing downstream re-checks it, so the enum + the
    // baseline pin above are the whole guarantee — which is exactly why both are asserted.
    const rigged = { ...baseline, spawn: { ...baseline.spawn, permissionMode: "auto" } } as PlatformBaseline;
    const argv = agentArgs(rigged, PLAN(undefined as unknown as string), { mntRoot: "/sessions/x/mnt" } as never);
    expect(flagValue(argv)).toBe("auto");
  });
});
