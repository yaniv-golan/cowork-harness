import { describe, it, expect } from "vitest";
import { dockerRunArgv } from "../src/runtime/argv.js";
import { resolveHostLoopBindMounts } from "../src/runtime/hostloop-stage.js";
import { hostLoopSidecarEnv } from "../src/runtime/hostloop.js";
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

describe("dockerRunArgv builder — optional agent bind/argv", () => {
  // NOTE: this exercises the BUILDER's absent-agentHost branch, not host-loop's real input. The real
  // host-loop sidecar DOES bind the ELF (read-only, for parity — nothing spawned runs it) and omits only
  // `agentArgv`. SPEC and a doc comment both claimed otherwise for weeks; the shape that actually ships
  // is pinned by the "VM sidecar dockerRunArgv snapshot" case in golden.test.ts. Do not read this case
  // as a description of host-loop.
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

// The hostloop VM sidecar is bash's `docker exec` target. Its egress env is composed by
// `hostLoopSidecarEnv` — a named export precisely so the boundary probe can assert against the SAME
// value the runtime spawns with. Asserting on a hand-built env here would test a configuration nothing
// runs, which is how this regressed unnoticed in the first place.
describe("hostloop VM sidecar egress env", () => {
  it("routes bash through the run's egress proxy when one exists", () => {
    const env = hostLoopSidecarEnv("http://cowork-proxy-abc:8080");
    // Both cases are load-bearing: curl honours `http_proxy` in LOWER case only for http:// URLs.
    expect(env.HTTP_PROXY).toBe("http://cowork-proxy-abc:8080");
    expect(env.http_proxy).toBe("http://cowork-proxy-abc:8080");
    expect(env.HTTPS_PROXY).toBe("http://cowork-proxy-abc:8080");
    expect(env.https_proxy).toBe("http://cowork-proxy-abc:8080");
    // Loopback must not be diverted to a proxy living in a different container.
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1,::1");
    expect(env.no_proxy).toBe("localhost,127.0.0.1,::1");
  });

  it("leaves CLAUDE_PLUGIN_ROOT unset — real host-loop leaves it unset in the guest", () => {
    // A bare $CLAUDE_PLUGIN_ROOT is empty there, as in Cowork; a leaked host path here is the bug 87b4036 removed.
    // (A host plugin path the agent writes into a command is rewritten by the workspace handler instead.)
    expect(hostLoopSidecarEnv("http://p:8080")).not.toHaveProperty("CLAUDE_PLUGIN_ROOT");
  });

  it("adds nothing when there is no proxy — a bogus proxy is worse than none", () => {
    expect(hostLoopSidecarEnv(undefined)).toEqual({});
  });
});
