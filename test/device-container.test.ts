// The device container behind `device_bridge: true`: a keep-alive container on the run's egress network that
// holds COPIES of the connected folders at $HOME/mnt/<folder-name>, where device_bash runs. The one invariant that
// keeps device_bash off the user's real files is that nothing the container binds is a mount's host path.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LaunchPlan, Mount } from "../src/session.js";
import {
  deviceContainerArgv,
  deviceFolders,
  deviceVmUser,
  agentPlanFor,
  makeDeviceExec,
  stageDeviceFolders,
  startDeviceBridge,
} from "../src/runtime/device-container.js";

const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), "device-ct-")));
function folder(root: string, name: string, mode: Mount["mode"] = "rw"): Mount {
  const hostPath = join(root, "user", name);
  mkdirSync(hostPath, { recursive: true });
  writeFileSync(join(hostPath, "a.txt"), "alpha\n");
  return { hostPath, mountPath: name, mode, kind: "folder" };
}
const binds = (argv: string[]) => argv.flatMap((a, i) => (argv[i - 1] === "-v" ? [a] : []));

describe("deviceVmUser", () => {
  it("names the per-task user the way production does (rcw-, lowercase alphanumerics, 32 chars at most)", () => {
    expect(deviceVmUser("session_ABC-123")).toBe("rcw-abc123");
    expect(deviceVmUser("cse_x")).toBe("rcw-x");
    expect(deviceVmUser("---")).toBe("rcw-shared");
    expect(deviceVmUser("a".repeat(60))).toHaveLength(32);
  });
});

describe("deviceFolders", () => {
  it("keeps only connected folders, named by their mount's last segment", () => {
    const mounts: Mount[] = [
      { hostPath: "/x/p", mountPath: ".projects/proj", mode: "rw", kind: "folder" },
      { hostPath: "/x/u", mountPath: "uploads/u.txt", mode: "r", kind: "upload" },
      { hostPath: "/x/n", mountPath: "notes", mode: "r", kind: "folder" },
    ];
    expect(deviceFolders(mounts).map((f) => [f.name, f.mode])).toEqual([
      ["proj", "rw"],
      ["notes", "r"],
    ]);
  });
});

describe("stageDeviceFolders", () => {
  it("copies each folder under the device tree; a write to the copy leaves the user's folder untouched", () => {
    const root = scratch();
    const f = folder(root, "proj");
    const deviceHost = join(root, "out", "work", "device");
    stageDeviceFolders(deviceFolders([f]), deviceHost);
    const copy = join(deviceHost, "mnt", "proj", "a.txt");
    expect(readFileSync(copy, "utf8")).toBe("alpha\n");
    writeFileSync(copy, "changed\n");
    expect(readFileSync(join(f.hostPath, "a.txt"), "utf8")).toBe("alpha\n");
  });
});

describe("deviceContainerArgv", () => {
  const root = scratch();
  const mounts = [folder(root, "proj"), folder(root, "ref", "r")];
  const deviceHost = join(root, "out", "work", "device");
  const argv = deviceContainerArgv({
    name: "cowork-dev-t",
    image: "img",
    network: "cowork-int-t",
    egressProxy: "http://proxy:8080",
    deviceHost,
    sessionId: "session_t1",
    folders: deviceFolders(mounts),
  });

  it("binds only paths under the run's device tree, never a mount's host path", () => {
    const sources = binds(argv).map((b) => b.split(":")[0]);
    expect(sources.length).toBeGreaterThan(0);
    for (const s of sources) {
      expect(s.startsWith(deviceHost), s).toBe(true);
      for (const m of mounts) expect(s.startsWith(m.hostPath), s).toBe(false);
    }
    expect(argv.join(" ")).not.toContain(join(root, "user"));
  });

  it("mounts the device tree as $HOME and each folder at $HOME/mnt/<name>, read-only folders :ro", () => {
    expect(binds(argv)).toEqual([`${deviceHost}:/sessions/rcw-t1`, `${deviceHost}/mnt/ref:/sessions/rcw-t1/mnt/ref:ro`]);
    expect(argv[argv.indexOf("-w") + 1]).toBe("/sessions/rcw-t1");
  });

  it("joins the run's egress network with the proxy env and HOME, hardened, running a keep-alive", () => {
    expect(argv[argv.indexOf("--network") + 1]).toBe("cowork-int-t");
    expect(argv).toContain("HTTPS_PROXY=http://proxy:8080");
    expect(argv).toContain("HOME=/sessions/rcw-t1");
    expect(argv).toContain("--cap-drop");
    expect(argv).toContain("--read-only");
    expect(argv.slice(-3)).toEqual(["img", "sleep", "infinity"]);
  });

  it("sets production's git env when a folder is writable, and not otherwise", () => {
    expect(argv).toContain("GIT_OPTIONAL_LOCKS=0");
    expect(argv).toContain("GIT_CONFIG_KEY_0=core.checkStat");
    const roOnly = deviceContainerArgv({
      name: "n",
      image: "img",
      network: "net",
      egressProxy: "http://proxy:8080",
      deviceHost,
      sessionId: "s",
      folders: deviceFolders([mounts[1]]),
    });
    expect(roOnly.some((a) => a.startsWith("GIT_"))).toBe(false);
  });
});

describe("makeDeviceExec", () => {
  // A stand-in for the container runtime: `<runner> exec -w <home> <name> bash -c <command>` runs the command
  // locally, and a container name of `gone` answers the way the Docker daemon does for a missing container.
  const root = scratch();
  const runner = join(root, "fake-runner.sh");
  writeFileSync(
    runner,
    '#!/bin/bash\n[ "$4" = gone ] && { echo "Error response from daemon: No such container: gone" >&2; exit 125; }\nshift 4\nexec "$@"\n',
    { mode: 0o755 },
  );

  it("returns the command's output and exit code, stdout then stderr", async () => {
    const exec = makeDeviceExec(runner, "ct", "/");
    expect(await exec("echo out; echo err >&2", 5000)).toEqual({ exitCode: 0, output: "out\nerr\n" });
    expect(await exec("echo nope; exit 3", 5000)).toEqual({ exitCode: 3, output: "nope\n" });
  });

  it("a daemon failure is an infra error, not an exit", async () => {
    const r = await makeDeviceExec(runner, "gone", "/")("ls", 5000);
    expect(r).toHaveProperty("infraError");
    expect((r as { infraError: string }).infraError).toContain("No such container");
  });

  it("a command that outlives its timeout reports the timeout, not an infra error", async () => {
    const r = await makeDeviceExec(runner, "ct", "/")("sleep 5", 300);
    expect(r).toMatchObject({ exitCode: 124 });
    expect((r as { output: string }).output).toContain("timed out");
  });
});

describe("startDeviceBridge", () => {
  // The stand-in runner plays both halves: `run …` stays alive like the keep-alive container, and `exec -w <home>
  // <name> bash -c <cmd>` runs the command in the staged device tree (standing in for $HOME).
  it("stages the copies, starts the container, and serves device_bash against them; teardown removes it", async () => {
    const root = scratch();
    const f = folder(root, "proj");
    const outDir = join(root, "out");
    const runner = join(root, "runner.sh");
    const deviceHost = join(outDir, "work", "device");
    writeFileSync(
      runner,
      `#!/bin/bash\ncase "$1" in run) exec sleep 30;; rm) echo "$3" >> "${root}/removed"; exit 0;; exec) shift 4; cd "${deviceHost}" && exec "$@";; esac\n`,
      { mode: 0o755 },
    );
    const bridge = startDeviceBridge({
      runner,
      image: "img",
      network: "net",
      egressProxy: "http://proxy:8080",
      outDir,
      sessionId: "session_t2",
      runToken: "tok",
      mounts: [f],
      appVersion: "2.31226.1",
      resume: false,
    });
    try {
      expect(bridge.containerName).toBe("cowork-dev-tok");
      expect(bridge.tools).toEqual(["mcp__remote-devices__device_bash", "mcp__remote-devices__get_device_info"]);
      const r = (await bridge.bundle.handle("remote-devices", {
        method: "tools/call",
        params: { name: "device_bash", arguments: { command: "cat mnt/proj/a.txt; echo x > mnt/proj/a.txt" } },
      })) as any;
      expect(r.result.content[0].text).toBe("alpha\n");
      expect(readFileSync(join(f.hostPath, "a.txt"), "utf8")).toBe("alpha\n");
    } finally {
      bridge.markTearingDown();
      expect(bridge.reapNow()).toBe(true);
    }
    expect(readFileSync(join(root, "removed"), "utf8")).toBe("cowork-dev-tok\n");
    expect(bridge.infraErrors).toEqual([]);
  });
});

describe("agentPlanFor", () => {
  const plan = {
    mounts: [
      { hostPath: "/x/p", mountPath: "proj", mode: "rw", kind: "folder" },
      { hostPath: "/x/u", mountPath: "uploads/u.txt", mode: "r", kind: "upload" },
    ],
  } as unknown as LaunchPlan;
  it("under device_bridge the agent's plan has no connected folder; every other mount stays", () => {
    expect(agentPlanFor({ device_bridge: true }, plan).mounts.map((m) => m.kind)).toEqual(["upload"]);
  });
  it("without it the plan is the same object", () => {
    expect(agentPlanFor({}, plan)).toBe(plan);
  });
});

// spawnContainer needs Docker and the staged agent binary, so its hand-off is pinned on the source: the agent's
// staging, binds and handlers read the filtered plan, and only the device bridge sees the launch plan's folders.
describe("wiring: spawnContainer", () => {
  const s = readFileSync(join(import.meta.dirname, "..", "src", "runtime", "container.ts"), "utf8");
  it("derives the agent plan through agentPlanFor and gives the launch plan's mounts only to the bridge", () => {
    expect(s).toMatch(/const plan: LaunchPlan = agentPlanFor\(scenario, launchPlan\);/);
    expect(s.match(/launchPlan\.mounts/g)).toEqual(["launchPlan.mounts"]);
    expect(s).toMatch(/startDeviceBridge\(\{[\s\S]{0,400}mounts: launchPlan\.mounts,/);
    expect(s).toMatch(/stageWorkspace\(plan, mntHost, /);
  });
  it("advertises, pre-approves and serves the bridge's tools", () => {
    expect(s).toMatch(/extraTools: \[[^\]]*\.\.\.\(device\?\.tools \?\? \[\]\)\]/);
    expect(s).toMatch(/extraAllowedTools: \[[^\]]*\.\.\.\(device\?\.tools \?\? \[\]\)\]/);
    expect(s).toMatch(/\.\.\.\(device \? \[device\.bundle\] : \[\]\)/);
  });
});

describe("wiring: execute.ts tears the device container down and keeps its infra errors", () => {
  const s = readFileSync(join(import.meta.dirname, "..", "src", "run", "execute.ts"), "utf8");
  it("marks, then removes it after the agent's container and before the egress network goes", () => {
    const agentRm = s.indexOf(
      "removeContainerThenRelease(runner, containerName, [deregisterContainerReap, deregisterHostLoopSidecarReap]);",
    );
    const mark = s.indexOf("deviceBridge.markTearingDown();");
    const rm = s.indexOf("removeContainerThenRelease(runner, deviceBridge.containerName, [deviceBridge.deregister]);");
    const network = s.indexOf("sidecar.teardown();");
    expect(agentRm).toBeGreaterThan(-1);
    expect(mark).toBeGreaterThan(agentRm);
    expect(rm).toBeGreaterThan(mark);
    expect(network).toBeGreaterThan(rm);
  });
  it("folds the device container's infra errors into the record", () => {
    expect(s).toMatch(/if \(deviceBridge\?\.infraErrors\.length\) record\.infraErrors\.push\(\.\.\.deviceBridge\.infraErrors\);/);
    expect(s).toMatch(/deviceBridge = ct\.device;/);
  });
});
