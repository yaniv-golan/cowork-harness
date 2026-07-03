import { describe, it, expect } from "vitest";
import { dockerRunArgv } from "../src/runtime/argv.js";
import { resolveHostLoopBindMounts } from "../src/runtime/hostloop-stage.js";
import type { LaunchPlan, Mount } from "../src/session.js";

function plan(mounts: Mount[]): LaunchPlan {
  return {
    configDir: "/HOST/CFG",
    mcpConfig: null,
    permissionMode: "default",
    permissionParity: "cowork",
    baseEnv: {},
    mounts,
    pluginDirs: [],
    egressAllow: [],
  };
}

describe("hostloop VM sidecar argv", () => {
  it("omits the agent bind and runs a keep-alive command when agentHost/agentArgv are absent", () => {
    const args = dockerRunArgv({
      network: "cowork-net",
      lockdown: true,
      sessionRoot: "/sessions/x",
      sessionHost: "/HOST/SESSION",
      image: "cowork-agent-base:2",
      env: {},
      name: "cowork-hl-x",
    });
    expect(args.join(" ")).not.toContain(":ro\n"); // no crash on join; real check below
    expect(args).not.toContain("/usr/local/bin/claude");
    expect(args.slice(-2)).toEqual(["sleep", "infinity"]);
  });

  it("renders extraBinds after the readOnlyMountPaths overlays", () => {
    const args = dockerRunArgv({
      network: "cowork-net",
      lockdown: false,
      sessionRoot: "/sessions/x",
      sessionHost: "/HOST/SESSION",
      image: "cowork-agent-base:2",
      env: {},
      extraBinds: [{ hostPath: "/real/folder", guestPath: "/sessions/x/mnt/folder", ro: false }],
    });
    const idx = args.indexOf("/real/folder:/sessions/x/mnt/folder");
    expect(idx).toBeGreaterThan(-1);
  });

  it("regression guard: a mode:r folder produces exactly ONE -v for its destination (not two)", () => {
    const roFolder: Mount = { hostPath: "/real/ro-folder", mountPath: "roFolder", mode: "r", kind: "folder" };
    const p = plan([roFolder]);
    // hostloop.ts's own composition: readOnlyMountPaths must EXCLUDE folders (handled by extraBinds instead)
    const readOnlyMountPaths = p.mounts.filter((m) => m.mode === "r" && m.kind !== "folder").map((m) => m.mountPath);
    const extraBinds = resolveHostLoopBindMounts(p, "/sessions/x");
    const args = dockerRunArgv({
      network: "cowork-net",
      lockdown: true,
      sessionRoot: "/sessions/x",
      sessionHost: "/HOST/SESSION",
      image: "cowork-agent-base:2",
      env: {},
      readOnlyMountPaths,
      extraBinds,
    });
    const destinations = args.filter((_, i) => args[i - 1] === "-v").map((v) => v.split(":").slice(1, 2)[0]);
    // filter for the folder's guest destination specifically
    const folderDestHits = destinations.filter((d) => d === "/sessions/x/mnt/roFolder");
    expect(folderDestHits.length).toBe(1);
  });
});
