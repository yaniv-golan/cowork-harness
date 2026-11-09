import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveMounts, recordedLayoutDivergence, GUEST_MNT_SEGMENT, loadBaseline } from "../src/baseline.js";
import { baseAgentArgs, dockerRunArgv } from "../src/runtime/argv.js";
import { VM_GUEST_SESSIONS_ROOT } from "../src/runtime/lima.js";
import { microvmGuestSessionRoot } from "../src/runtime/microvm.js";
import type { LaunchPlan } from "../src/session.js";
import type { PlatformBaseline } from "../src/types.js";

// Every guest path the harness hands the agent must land inside the tree its stagers actually create.
// The ORACLE here is deliberately taken from the staging side, never from resolveMounts: the staged tree
// is `<bind target>/mnt/...` because `dockerRunArgv` binds `sessionHost:sessionRoot` and nests its `:ro`
// binds at `${sessionRoot}/mnt/${mountPath}`, and `stageWorkspace` builds `<sessionHost>/mnt`. Asserting
// against resolveMounts instead would be a tautology that passes with the fix reverted.
//
// The defect this pins: a baseline whose recorded mnt root is NOT `<sessionRoot>/mnt` used to be honoured
// verbatim, so `--plugin-dir` pointed one directory above the staged plugin tree and the plugin under
// test never loaded.

const BASELINES = join(__dirname, "..", "baselines");
const files = readdirSync(BASELINES)
  .filter((f) => f.startsWith("desktop-") && f.endsWith(".json"))
  .sort();

const SESSION = "sess-1";
const PLUGIN_REL = ".local-plugins/cache/skill-under-test";

const planWith = (): LaunchPlan =>
  ({
    effort: "medium",
    pluginDirs: [PLUGIN_REL],
    mounts: [],
    baseEnv: {},
  }) as unknown as LaunchPlan;

/** The one true guest mnt tree, composed the way the stagers/binds do — not via resolveMounts. */
const stagedMntTree = (bindTarget: string) => `${bindTarget}/${GUEST_MNT_SEGMENT}`;

const argOf = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

describe("every shipped baseline emits guest paths inside the staged tree", () => {
  it("there is at least one baseline to check (the table is not vacuously empty)", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  for (const file of files) {
    const baseline = JSON.parse(readFileSync(join(BASELINES, file), "utf8")) as PlatformBaseline;
    const spawnable = baseline.spawn !== undefined;

    describe(file, () => {
      if (!spawnable) {
        // A baseline with no `spawn` block cannot be spawned at a sandbox tier at all — its toolset,
        // pre-approvals and config-dir location are exactly what that block carries. It must REFUSE,
        // not emit an agent with no file/bash tools.
        it("is refused at the sandbox tiers rather than emitting a toolless agent", () => {
          expect(() => baseAgentArgs(baseline, planWith(), { mntRoot: "/sessions/sess-1/mnt" })).toThrow(/no `spawn` block/);
        });
        return;
      }

      it("container: --plugin-dir, config dir and nested binds all sit inside the staged mnt tree", () => {
        const m = resolveMounts(baseline, SESSION);
        // container binds sessionHost at sessionRoot (argv.ts) — that is the bind target.
        const staged = stagedMntTree(m.sessionRoot);
        const argv = baseAgentArgs(baseline, planWith(), { mntRoot: m.mntRoot });
        expect(argOf(argv, "--plugin-dir")).toBe(`${staged}/${PLUGIN_REL}`);

        const configGuest = `${m.sessionRoot}/${baseline.spawn?.configDirInGuest ?? "mnt/.claude"}`;
        expect(configGuest.startsWith(`${staged}/`)).toBe(true);

        const docker = dockerRunArgv({
          network: "n",
          lockdown: false,
          sessionRoot: m.sessionRoot,
          agentCwd: m.cwd,
          sessionHost: "/host/work/session",
          image: "img",
          env: {},
          readOnlyMountPaths: ["uploads"],
        });
        const bind = docker[docker.indexOf("-v") + 1];
        expect(bind).toBe(`/host/work/session:${m.sessionRoot}`);
        expect(docker.join(" ")).toContain(`${staged}/uploads:ro`);
        // The agent's cwd is at or inside the bind target — the invariant present_files' classification
        // relies on (see test/session-root-path-space.test.ts).
        const cwd = argOf(docker, "-w");
        expect(cwd === m.sessionRoot || cwd.startsWith(`${m.sessionRoot}/`)).toBe(true);
      });

      it("microvm: the guest session root is lima's mount point, so its config path is staged", () => {
        const sessionVm = microvmGuestSessionRoot(baseline, SESSION);
        expect(sessionVm).toBe(`${VM_GUEST_SESSIONS_ROOT}/${SESSION}`);
        const configVm = `${sessionVm}/${baseline.spawn?.configDirInGuest ?? "mnt/.claude"}`;
        expect(configVm.startsWith(`${stagedMntTree(sessionVm)}/`)).toBe(true);
      });

      it("the recorded layout is reproducible (no fidelity divergence warning)", () => {
        expect(recordedLayoutDivergence(baseline)).toBeUndefined();
      });
    });
  }
});

const divergent = (): PlatformBaseline => {
  const b = JSON.parse(JSON.stringify(loadBaseline("desktop-1.19367.0"))) as PlatformBaseline;
  // Exactly the legacy shape, on a baseline that can spawn: session root already ends in the mnt
  // segment, and the recorded mnt root claims to be that same dir.
  b.mountLayout.sessionRoot = "/sessions/{sessionId}/mnt";
  b.mountLayout.cwd = "/sessions/{sessionId}/mnt";
  b.mountLayout.mntRoot = "/sessions/{sessionId}/mnt";
  return b;
};

describe("the divergence tripwire fires on exactly the un-stageable recording", () => {
  it("no shipped baseline is flagged", () => {
    const flagged = files.filter((f) => recordedLayoutDivergence(JSON.parse(readFileSync(join(BASELINES, f), "utf8")) as PlatformBaseline));
    expect(flagged).toEqual([]);
  });

  it("its recorded mnt root really is one level above what would be staged", () => {
    const b = divergent();
    const d = recordedLayoutDivergence(b)!;
    expect(d.staged).toBe(`${d.recorded}/${GUEST_MNT_SEGMENT}`);
    // And resolveMounts now reports the STAGED tree, not the recorded one.
    expect(resolveMounts(b, SESSION).mntRoot).toBe(`/sessions/${SESSION}/mnt/mnt`);
  });
});

// The shipped table above cannot exercise the defect on real data: no committed baseline has a divergent recorded
// layout. This synthetic case is the one that would have caught the original bug — a divergent recording that IS spawnable.
describe("a spawnable baseline with an un-stageable recorded layout still emits staged paths", () => {
  it("--plugin-dir lands on the staged tree, not on the recorded mnt root", () => {
    const b = divergent();
    const m = resolveMounts(b, SESSION);
    const argv = baseAgentArgs(b, planWith(), { mntRoot: m.mntRoot });
    // Staged: the bind target plus one mnt segment. Honouring the recording would drop the second one
    // and point one directory above the plugin tree.
    expect(argOf(argv, "--plugin-dir")).toBe(`/sessions/${SESSION}/mnt/mnt/${PLUGIN_REL}`);
    expect(argOf(argv, "--plugin-dir")).not.toBe(`/sessions/${SESSION}/mnt/${PLUGIN_REL}`);
  });

  it("the nested :ro bind and the plugin dir agree on the same tree", () => {
    const m = resolveMounts(divergent(), SESSION);
    const docker = dockerRunArgv({
      network: "n",
      lockdown: false,
      sessionRoot: m.sessionRoot,
      agentCwd: m.cwd,
      sessionHost: "/host/work/session",
      image: "img",
      env: {},
      readOnlyMountPaths: [PLUGIN_REL],
    });
    expect(docker.join(" ")).toContain(`/sessions/${SESSION}/mnt/mnt/${PLUGIN_REL}:ro`);
  });

  it("microvm REFUSES it outright — lima cannot place the agent at the recorded cwd", () => {
    // Warning is not enough at this tier: the guest `cd` would succeed at the wrong directory.
    expect(() => microvmGuestSessionRoot(divergent(), SESSION)).toThrow(/cannot place the agent anywhere else/);
  });

  it("and the divergence is reported, so the approximation is never silent", () => {
    expect(recordedLayoutDivergence(divergent())).toEqual({
      recorded: "/sessions/{sessionId}/mnt",
      staged: "/sessions/{sessionId}/mnt/mnt",
    });
  });
});
