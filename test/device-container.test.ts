// The device container behind `device_bridge: true`: a keep-alive container on the run's egress network that
// holds COPIES of the connected folders at $HOME/mnt/<folder-name>, where device_bash runs. The one invariant that
// keeps device_bash off the user's real files is that nothing the container binds is a mount's host path.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Mount } from "../src/session.js";
import { deviceContainerArgv, deviceFolders, deviceVmUser, makeDeviceExec, stageDeviceFolders } from "../src/runtime/device-container.js";

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
