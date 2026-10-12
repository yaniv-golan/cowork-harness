// The device container behind `device_bridge: true`: a keep-alive container on the run's egress network that
// holds COPIES of the connected folders at $HOME/mnt/<folder-name>, where device_bash runs. The one invariant that
// keeps device_bash off the user's real files is that nothing the container binds is a mount's host path.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LaunchPlan, Mount } from "../src/session.js";
import {
  deviceContainerArgv,
  deviceFolders,
  deviceVmUser,
  agentPlanFor,
  deniedDeviceFolders,
  deviceTreeDeletes,
  deviceTreeIdentityReliable,
  makeDeviceExec,
  recordDeviceTree,
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
    controlHost: join(root, "out"),
    sessionId: "session_t1",
    folders: deviceFolders(mounts),
    user: { uid: 501, gid: 20 },
  });

  it("binds only paths under the run directory, never a mount's host path", () => {
    const sources = binds(argv).map((b) => b.split(":")[0]);
    expect(sources.length).toBeGreaterThan(0);
    for (const s of sources) {
      expect(s.startsWith(join(root, "out")), s).toBe(true);
      for (const m of mounts) expect(s.startsWith(m.hostPath), s).toBe(false);
    }
    expect(argv.join(" ")).not.toContain(join(root, "user"));
  });

  it("mounts the device tree as $HOME and each folder at $HOME/mnt/<name>, read-only folders :ro", () => {
    // mnt is a mount point of its own, so a command cannot rename or replace it (and with it a read-only folder's
    // bind source) for a later turn to bind.
    expect(binds(argv).slice(0, 3)).toEqual([
      `${deviceHost}:/sessions/rcw-t1`,
      `${deviceHost}/mnt:/sessions/rcw-t1/mnt`,
      `${deviceHost}/mnt/ref:/sessions/rcw-t1/mnt/ref:ro`,
    ]);
    // The rest are the shim's control files (device-control.test.ts).
    expect(
      binds(argv)
        .slice(3)
        .every((b) => b.startsWith(join(root, "out", "device-"))),
    ).toBe(true);
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
      controlHost: join(root, "out"),
      sessionId: "s",
      folders: deviceFolders([mounts[1]]),
      user: { uid: 501, gid: 20 },
    });
    expect(roOnly.some((a) => a.startsWith("GIT_"))).toBe(false);
  });
});

// A stand-in for the container runtime, shaped like real Docker: `<runner> exec -w <home> <name> timeout -k 2 <secs>
// bash -c <command>` runs the command locally (in `cwd`, standing in for $HOME), with `timeout`'s own exit 124 when it
// outlives its limit; a missing container answers as the daemon does (exit 1). `run` stays alive like the keep-alive
// container and `rm` records the name it removed.
/** The stand-in runner has no images: the device image is the agent image as given. */
const STAND_IN_IMAGE = (_runner: string, base: string) => ({ imageId: base });

function standInRunner(root: string, cwd = "/"): string {
  const runner = join(root, "runner.sh");
  writeFileSync(
    runner,
    [
      "#!/bin/bash",
      // The canary's rm, answered as the shim answers it.
      'if [ "$1" = exec ] && [ "$3" = rm ]; then echo "rm: cannot remove \'$4\': Operation not permitted" >&2; exit 1; fi',
      'case "$1" in',
      "  run) exec sleep 30;;",
      `  rm) echo "$3" >> "${root}/removed"; exit 0;;`,
      "  inspect) echo true; exit 0;;",
      "esac",
      '[ "$4" = gone ] && { echo "Error response from daemon: No such container: gone" >&2; exit 1; }',
      "shift 4",
      `cd "${cwd}" || exit 1`,
      'if [ "$1" = timeout ]; then',
      "  shift 3; secs=$1; shift",
      '  "$@" & p=$!',
      '  ( sleep "$secs"; kill -9 $p 2>/dev/null ) >/dev/null 2>&1 & k=$!',
      "  wait $p 2>/dev/null; rc=$?; kill $k 2>/dev/null",
      "  [ $rc -eq 137 ] && exit 124; exit $rc",
      "fi",
      'exec "$@"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return runner;
}

describe("makeDeviceExec", () => {
  const root = scratch();
  const runner = standInRunner(root);

  it("runs the command under an in-container timeout, so a timed-out command is stopped inside the container", async () => {
    const calls = join(root, "argv");
    const spy = join(root, "spy.sh");
    writeFileSync(spy, `#!/bin/bash\necho "$@" > "${calls}"\n`, { mode: 0o755 });
    await makeDeviceExec(spy, "ct", "/h")("echo hi", 45000);
    expect(readFileSync(calls, "utf8").trim()).toBe("exec -w /h ct timeout -k 2 45 bash -c echo hi");
  });

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

  it("a command that outlives its timeout reports the timeout on its own line", async () => {
    const r = await makeDeviceExec(runner, "ct", "/")("echo started; sleep 5", 1000);
    expect(r).toEqual({ exitCode: 124, output: "started\nCommand timed out after 1s" });
  });

  it("output past the read buffer comes back cut, as output, never as an infra error", async () => {
    const r = await makeDeviceExec(runner, "ct", "/")("head -c 9000000 /dev/zero | tr '\\0' a", 20000);
    expect(r).not.toHaveProperty("infraError");
    expect((r as { output: string }).output.length).toBeGreaterThan(262_144);
  });
});

describe("startDeviceBridge", () => {
  it("stages the copies, starts the container, and serves device_bash against them; teardown removes it", async () => {
    const root = scratch();
    const f = folder(root, "proj");
    const outDir = join(root, "out");
    const runner = standInRunner(root, join(outDir, "work", "device"));
    const bridge = startDeviceBridge({
      ensureImage: STAND_IN_IMAGE,
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
      expect(bridge.inputRoots).toEqual([join(outDir, "work", "device", "mnt", "proj")]);
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
    // Once before the start (a stale container of that name), once at teardown.
    expect(readFileSync(join(root, "removed"), "utf8")).toBe("cowork-dev-tok\ncowork-dev-tok\n");
    expect(bridge.infraErrors).toEqual([]);
  });
});

describe("startDeviceBridge: teardown", () => {
  // A teardown can run before `docker run` has created the container. The create request is already with the daemon,
  // so the container can appear after the client is stopped, and after a removal. Teardown therefore waits for the
  // client to exit, removes, waits, and removes again, and reports the container gone only after that.
  it("removes a container whose create lands after the client was stopped", async () => {
    const root = scratch();
    const f = folder(root, "proj");
    const outDir = join(root, "out");
    const exists = join(root, "exists");
    const runner = join(root, "runner.sh");
    // `run` hands the create to a detached "daemon" that makes the container 300 ms later, whatever happens to the
    // client; `rm` removes it if it exists.
    writeFileSync(
      runner,
      [
        "#!/bin/bash",
        // The canary's rm, answered as the shim answers it.
        'if [ "$1" = exec ] && [ "$3" = rm ]; then echo "rm: cannot remove \'$4\': Operation not permitted" >&2; exit 1; fi',
        'case "$1" in',
        `  run) ( sleep 0.3; echo created > "${exists}" ) >/dev/null 2>&1 & disown; exec sleep 30;;`,
        `  rm) rm -f "${exists}"; echo rm >> "${root}/removed"; exit 0;;`,
        "  inspect) echo true; exit 0;;",
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const b = startDeviceBridge({
      ensureImage: STAND_IN_IMAGE,
      runner,
      image: "img",
      network: "net",
      egressProxy: "http://p:1",
      outDir,
      sessionId: "s",
      runToken: "td",
      mounts: [f],
      appVersion: "2.31226.1",
      resume: false,
    });
    expect(await b.teardown()).toBe(true);
    await new Promise((r) => setTimeout(r, 600));
    expect(existsSync(exists), "a container created after teardown was left behind").toBe(false);
    expect(b.infraErrors).toEqual([]);
  });
});

describe("startDeviceBridge: a container that is slow to come up", () => {
  // Under load `docker run` can take seconds to create the container. The first device_bash must wait for it rather
  // than fail as "No such container", and a leftover container of the same name is cleared before the start.
  it("waits until the container runs before the first command, and clears a stale one first", async () => {
    const root = scratch();
    const f = folder(root, "proj");
    const outDir = join(root, "out");
    const deviceHost = join(outDir, "work", "device");
    const log = join(root, "log");
    const runner = join(root, "runner.sh");
    // `inspect` reports not-running for the first three polls; `exec` fails as the daemon does until then.
    writeFileSync(
      runner,
      [
        "#!/bin/bash",
        // The canary's rm, answered as the shim answers it.
        'if [ "$1" = exec ] && [ "$3" = rm ]; then echo "rm: cannot remove \'$4\': Operation not permitted" >&2; exit 1; fi',
        `echo "$1" >> "${log}"`,
        'case "$1" in',
        "  run) exec sleep 30;;",
        "  rm) exit 0;;",
        `  inspect) n=$(grep -c '^inspect$' "${log}"); [ "$n" -gt 3 ] && echo true || echo false; exit 0;;`,
        "esac",
        `n=$(grep -c '^inspect$' "${log}"); [ "$n" -le 3 ] && { echo "Error response from daemon: No such container: x" >&2; exit 1; }`,
        `shift 4; cd "${deviceHost}"; shift 3; shift; exec "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const bridge = startDeviceBridge({
      ensureImage: STAND_IN_IMAGE,
      runner,
      image: "img",
      network: "net",
      egressProxy: "http://proxy:8080",
      outDir,
      sessionId: "s",
      runToken: "slow",
      mounts: [f],
      appVersion: "2.31226.1",
      resume: false,
    });
    try {
      const r = (await bridge.bundle.handle("remote-devices", {
        method: "tools/call",
        params: { name: "device_bash", arguments: { command: "cat mnt/proj/a.txt" } },
      })) as any;
      expect(r.result.content[0].text).toBe("alpha\n");
      expect(bridge.infraErrors).toEqual([]);
      expect(readFileSync(log, "utf8").split("\n")[0]).toBe("rm");
    } finally {
      bridge.markTearingDown();
      bridge.reapNow();
    }
  });
});

describe("stageDeviceFolders: a symlinked folder source", () => {
  it("copies the folder it points at, so the device tree holds no link back to the user's files", () => {
    const root = scratch();
    const real = folder(root, "real");
    const link = join(root, "user", "linked");
    symlinkSync(real.hostPath, link);
    const deviceHost = join(root, "out", "work", "device");
    stageDeviceFolders(deviceFolders([{ hostPath: link, mountPath: "linked", mode: "r", kind: "folder" }]), deviceHost);
    const copy = join(deviceHost, "mnt", "linked");
    expect(lstatSync(copy).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(copy, "a.txt"), "utf8")).toBe("alpha\n");
  });
});

describe("startDeviceBridge: a resumed turn never binds what a command left behind", () => {
  // Docker resolves a bind source on the HOST. A read-only folder is bound by its path in the device tree, so if a
  // previous turn's command had replaced that copy with a symlink, the next turn would bind the link's target, any
  // host path. Every bind source is checked to be a real directory inside the device tree before the start.
  it("refuses to start when a read-only folder's copy is a symlink, and binds nothing", () => {
    const root = scratch();
    const ref = folder(root, "ref", "r");
    const outDir = join(root, "out");
    const runner = standInRunner(root, join(outDir, "work", "device"));
    const start = (resume: boolean) =>
      startDeviceBridge({
        ensureImage: STAND_IN_IMAGE,
        runner,
        image: "img",
        network: "net",
        egressProxy: "http://p:1",
        outDir,
        sessionId: "s",
        runToken: `r${resume}`,
        mounts: [ref],
        appVersion: "2.31226.1",
        resume,
      });
    const t1 = start(false);
    t1.markTearingDown();
    t1.reapNow();
    const copy = join(outDir, "work", "device", "mnt", "ref");
    rmSync(copy, { recursive: true });
    mkdirSync(join(root, "secret"));
    symlinkSync(join(root, "secret"), copy);
    expect(() => start(true)).toThrow(/device_bridge.*ref.*not a directory inside the device tree/);
    // nothing was started: no `run` reached the runtime after the refusal
    expect(readFileSync(join(root, "removed"), "utf8").trim().split("\n")).toHaveLength(2);
  });
  it("a refused start writes nothing about the link's target", () => {
    const root = scratch();
    const ref = folder(root, "ref", "r");
    const outDir = join(root, "out");
    const deviceHost = join(outDir, "work", "device");
    mkdirSync(deviceHost, { recursive: true });
    mkdirSync(join(root, "secret"));
    writeFileSync(join(root, "secret", "id_rsa"), "x");
    symlinkSync(join(root, "secret"), join(deviceHost, "mnt"));
    const runner = standInRunner(root, deviceHost);
    expect(() =>
      startDeviceBridge({
        ensureImage: STAND_IN_IMAGE,
        runner,
        image: "img",
        network: "net",
        egressProxy: "http://p:1",
        outDir,
        sessionId: "s",
        runToken: "n1",
        mounts: [ref],
        appVersion: "2.31226.1",
        resume: true,
      }),
    ).toThrow(/not a directory inside the device tree/);
    expect(existsSync(join(outDir, "device-tree-pre-run.json"))).toBe(false);
  });
  it("refuses when mnt itself was replaced by a link", () => {
    const root = scratch();
    const ref = folder(root, "ref", "r");
    const outDir = join(root, "out");
    const runner = standInRunner(root, join(outDir, "work", "device"));
    const start = (resume: boolean) =>
      startDeviceBridge({
        ensureImage: STAND_IN_IMAGE,
        runner,
        image: "img",
        network: "net",
        egressProxy: "http://p:1",
        outDir,
        sessionId: "s",
        runToken: `m${resume}`,
        mounts: [ref],
        appVersion: "2.31226.1",
        resume,
      });
    const t1 = start(false);
    t1.markTearingDown();
    t1.reapNow();
    const mnt = join(outDir, "work", "device", "mnt");
    renameSync(mnt, `${mnt}.old`);
    symlinkSync(`${mnt}.old`, mnt);
    expect(() => start(true)).toThrow(/device_bridge.*not a directory inside the device tree/);
  });
});

describe("stageDeviceFolders: special files in a folder", () => {
  // A FIFO or a socket in a connected folder is not copied into the device tree, so nothing there can block a reader
  // and hang the run; staging neither throws nor waits on it, and every regular file still arrives.
  it("skips a FIFO and a socket, copies the rest, and returns promptly", () => {
    const root = scratch();
    const f = folder(root, "proj");
    execFileSync("mkfifo", [join(f.hostPath, "pipe")]);
    execFileSync("python3", ["-c", "import socket,sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])", join(f.hostPath, "sock")]);
    expect(lstatSync(join(f.hostPath, "pipe")).isFIFO()).toBe(true);
    expect(lstatSync(join(f.hostPath, "sock")).isSocket()).toBe(true);
    {
      const deviceHost = join(root, "out", "work", "device");
      const t0 = Date.now();
      stageDeviceFolders(deviceFolders([f]), deviceHost);
      expect(Date.now() - t0).toBeLessThan(5000);
      const copy = join(deviceHost, "mnt", "proj");
      expect(readdirSync(copy).sort()).toEqual(["a.txt"]);
    }
  });
});

const PROJ = [{ name: "proj", mountPath: "proj" }];

describe("deviceTreeDeletes", () => {
  // The text scan cannot see every way a command deletes (`find -delete`, a glob, a script), so the device tree is
  // compared before and after the run. A rename inside the tree keeps its inode and is not a delete.
  function staged() {
    const root = scratch();
    const f = folder(root, "proj");
    writeFileSync(join(f.hostPath, "b.txt"), "beta\n");
    const outDir = join(root, "out");
    const deviceHost = join(outDir, "work", "device");
    stageDeviceFolders(deviceFolders([f]), deviceHost);
    recordDeviceTree(outDir);
    return { outDir, copy: join(deviceHost, "mnt", "proj") };
  }
  it("reports a file removed from a folder copy by any means", () => {
    const { outDir, copy } = staged();
    rmSync(join(copy, "a.txt"));
    expect(deviceTreeDeletes(outDir, PROJ)).toEqual([{ mount: "proj", command: "(removed from the device copy) proj/a.txt" }]);
  });
  it("a rename is not a delete; an untouched tree reports nothing", () => {
    const { outDir, copy } = staged();
    expect(deviceTreeDeletes(outDir, PROJ)).toEqual([]);
    renameSync(join(copy, "a.txt"), join(copy, "moved.txt"));
    expect(deviceTreeDeletes(outDir, PROJ)).toEqual([]);
  });
  it("a resumed turn compares against the tree as that turn found it, not as the first turn staged it", async () => {
    const root = scratch();
    const f = folder(root, "proj");
    writeFileSync(join(f.hostPath, "b.txt"), "beta\n");
    const outDir = join(root, "out");
    const runner = standInRunner(root, join(outDir, "work", "device"));
    const start = (resume: boolean) =>
      startDeviceBridge({
        ensureImage: STAND_IN_IMAGE,
        runner,
        image: "img",
        network: "net",
        egressProxy: "http://p:1",
        outDir,
        sessionId: "s",
        runToken: `t${resume}`,
        mounts: [f],
        appVersion: "2.31226.1",
        resume,
      });
    const turn1 = start(false);
    turn1.markTearingDown();
    turn1.reapNow();
    rmSync(join(outDir, "work", "device", "mnt", "proj", "a.txt")); // turn 1 deleted a.txt
    expect(deviceTreeDeletes(outDir, PROJ).map((d) => d.command)).toEqual(["(removed from the device copy) proj/a.txt"]);
    const turn2 = start(true);
    turn2.markTearingDown();
    turn2.reapNow();
    expect(deviceTreeDeletes(outDir, PROJ)).toEqual([]); // turn 2 deleted nothing
    rmSync(join(outDir, "work", "device", "mnt", "proj", "b.txt"));
    expect(deviceTreeDeletes(outDir, PROJ).map((d) => d.command)).toEqual(["(removed from the device copy) proj/b.txt"]);
  });
  it("counts only the delete-denied folders it is given, and names each by its mount path", () => {
    const root = scratch();
    const rw = folder(root, "proj");
    const rwd = folder(root, "scratch", "rwd");
    const outDir = join(root, "out");
    const deviceHost = join(outDir, "work", "device");
    stageDeviceFolders(deviceFolders([rw, rwd]), deviceHost);
    recordDeviceTree(outDir);
    rmSync(join(deviceHost, "mnt", "proj", "a.txt"));
    rmSync(join(deviceHost, "mnt", "scratch", "a.txt"));
    // `scratch` allows deletes (rwd): not given, not counted. `proj` is reported under its legacy mount path.
    expect(deviceTreeDeletes(outDir, [{ name: "proj", mountPath: ".projects/proj" }])).toEqual([
      { mount: ".projects/proj", command: "(removed from the device copy) proj/a.txt" },
    ]);
  });
  it("deniedDeviceFolders picks the rw folders, with their mount paths", () => {
    const mounts = [
      { hostPath: "/x/a", mountPath: ".projects/a", mode: "rw", kind: "folder" },
      { hostPath: "/x/b", mountPath: "b", mode: "rwd", kind: "folder" },
      { hostPath: "/x/c", mountPath: "c", mode: "r", kind: "folder" },
    ] as Mount[];
    expect(deniedDeviceFolders(mounts)).toEqual([{ name: "a", mountPath: ".projects/a" }]);
  });
  it("a reused inode with a different birth time is a new file, so the old path's removal is a delete (Linux reuses inodes)", () => {
    const { outDir, copy } = staged();
    const listing = join(outDir, "device-tree-pre-run.json");
    const recorded = JSON.parse(readFileSync(listing, "utf8")) as { entries: Record<string, { id: string }> };
    // As if a.txt had been deleted and the new b.txt had been given a.txt's inode: same inode, other birth time.
    const bIdentity = recorded.entries["proj/b.txt"]!.id;
    recorded.entries["proj/a.txt"]!.id = `${bIdentity.split(":")[0]}:1`;
    writeFileSync(listing, JSON.stringify(recorded));
    rmSync(join(copy, "a.txt"));
    expect(deviceTreeDeletes(outDir, PROJ).map((d) => d.command)).toEqual(["(removed from the device copy) proj/a.txt"]);
  });
  it("a rename followed by an edit: a rename where the filesystem keeps identities apart, a delete where it does not", () => {
    const { outDir, copy } = staged();
    const { identityReliable } = JSON.parse(readFileSync(join(outDir, "device-tree-pre-run.json"), "utf8"));
    expect(typeof identityReliable).toBe("boolean");
    renameSync(join(copy, "a.txt"), join(copy, "moved.txt"));
    writeFileSync(join(copy, "moved.txt"), "edited, longer than before\n");
    expect(deviceTreeDeletes(outDir, PROJ).map((d) => d.command)).toEqual(
      identityReliable ? [] : ["(removed from the device copy) proj/a.txt"],
    );
  });
  it("without a recorded listing it reports nothing (no evidence, no claim)", () => {
    expect(deviceTreeDeletes(scratch(), PROJ)).toEqual([]);
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
    // What each list holds is deviceToolSurface's (delete-grant-serving.test.ts); here, that both lists use it.
    expect(s).toMatch(/const deviceSurface = deviceToolSurface\(device\);/);
    expect(s).toMatch(/extraTools: \[[^\]]*\.\.\.deviceSurface\.advertised\]/);
    expect(s).toMatch(/extraAllowedTools: \[[^\]]*\.\.\.deviceSurface\.preApproved\]/);
    expect(s).toMatch(/\.\.\.\(device \? \[device\.bundle\] : \[\]\)/);
  });
});

describe("wiring: execute.ts tears the device container down and keeps its infra errors", () => {
  const s = readFileSync(join(import.meta.dirname, "..", "src", "run", "execute.ts"), "utf8");
  it("tears it down (mark, remove, stop the client, remove again) after the agent's container and before the network", () => {
    const agentRm = s.indexOf(
      "removeContainerThenRelease(runner, containerName, [deregisterContainerReap, deregisterHostLoopSidecarReap]);",
    );
    const teardown = s.indexOf("!(await deviceBridge.teardown())");
    const network = s.indexOf("sidecar.teardown();");
    expect(agentRm).toBeGreaterThan(-1);
    expect(teardown).toBeGreaterThan(agentRm);
    expect(network).toBeGreaterThan(teardown);
  });
  it("folds the device container's infra errors into the record", () => {
    expect(s).toMatch(/if \(deviceBridge\?\.infraErrors\.length\) record\.infraErrors\.push\(\.\.\.deviceBridge\.infraErrors\);/);
    expect(s).toMatch(/onDeviceStarted: \(d\) => \(deviceBridge = d\)/);
  });
});

describe("wiring: the review fixes reach the run", () => {
  const read = (p: string) => readFileSync(join(import.meta.dirname, "..", "src", p), "utf8");
  it("container.ts hands the device over at once and feeds its folder copies to the input corpus", () => {
    const s = read("runtime/container.ts");
    expect(s).toMatch(
      /if \(device\) opts\.onDeviceStarted\?\.\(device\);\s*\n(\s*\/\/[^\n]*\n)*\s*captureInputHostPathCorpus\(plan, mntHost, outDir, device\?\.inputRoots\);/,
    );
  });
  it("execute.ts adds device-tree deletes to the scan and refuses folder-path file assertions", () => {
    const s = read("run/execute.ts");
    expect(s).toMatch(/if \(scenario\.device_bridge === true\) scan\.mountDeletes\.push\(\.\.\.bridgeFindings\(\)\.mountDeletes\);/);
    expect(s).toMatch(/deviceBridgeFolderAssertRefusal\(\s*scenario,\s*deviceFolders\(plan\.mounts\)/);
  });
});

describe("deviceTreeDeletes: the recorded listing", () => {
  // The listing records each file's size and sha256 and the probe's verdict on its filesystem (the rule itself is
  // tested in device-tree.test.ts). Directories are listed too.
  function staged(setup: (hostDir: string) => void = () => {}) {
    const root = scratch();
    const f = folder(root, "proj");
    setup(f.hostPath);
    const outDir = join(root, "out");
    const deviceHost = join(outDir, "work", "device");
    stageDeviceFolders(deviceFolders([f]), deviceHost);
    recordDeviceTree(outDir);
    return { outDir, copy: join(deviceHost, "mnt", "proj") };
  }
  it("a removed empty directory is a delete", () => {
    const { outDir, copy } = staged((h) => mkdirSync(join(h, "empty")));
    rmdirSync(join(copy, "empty"));
    expect(deviceTreeDeletes(outDir, PROJ)).toEqual([{ mount: "proj", command: "(removed from the device copy) proj/empty/" }]);
  });
  it("a renamed directory, contents and all, is not a delete", () => {
    const { outDir, copy } = staged((h) => {
      mkdirSync(join(h, "sub"));
      writeFileSync(join(h, "sub", "x.txt"), "x\n");
    });
    renameSync(join(copy, "sub"), join(copy, "sub2"));
    expect(deviceTreeDeletes(outDir, PROJ)).toEqual([]);
  });
  it("a listing whose filesystem the probe found unreliable needs matching bytes: a rename then an edit reads as a delete", () => {
    const { outDir, copy } = staged();
    const file = join(outDir, "device-tree-pre-run.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), identityReliable: false }));
    renameSync(join(copy, "a.txt"), join(copy, "moved.txt"));
    expect(deviceTreeDeletes(outDir, PROJ)).toEqual([]);
    writeFileSync(join(copy, "moved.txt"), "edited\n");
    expect(deviceTreeDeletes(outDir, PROJ).map((d) => d.command)).toEqual(["(removed from the device copy) proj/a.txt"]);
  });
  it("deviceTreeIdentityReliable reads the recorded verdict; a flat listing is unreliable, no listing is unknown", () => {
    const { outDir } = staged();
    const file = join(outDir, "device-tree-pre-run.json");
    const recorded = JSON.parse(readFileSync(file, "utf8"));
    expect(deviceTreeIdentityReliable(outDir)).toBe(recorded.identityReliable);
    writeFileSync(file, JSON.stringify({ ...recorded, identityReliable: false }));
    expect(deviceTreeIdentityReliable(outDir)).toBe(false);
    writeFileSync(file, JSON.stringify({ ...recorded, identityReliable: true }));
    expect(deviceTreeIdentityReliable(outDir)).toBe(true);
    writeFileSync(file, JSON.stringify(recorded.entries));
    expect(deviceTreeIdentityReliable(outDir)).toBe(false);
    expect(deviceTreeIdentityReliable(scratch())).toBeUndefined();
  });
  it("a listing written before the probe (a flat map) counts as unreliable", () => {
    const { outDir, copy } = staged();
    const file = join(outDir, "device-tree-pre-run.json");
    writeFileSync(file, JSON.stringify(JSON.parse(readFileSync(file, "utf8")).entries));
    renameSync(join(copy, "a.txt"), join(copy, "moved.txt"));
    expect(deviceTreeDeletes(outDir, PROJ)).toEqual([]);
    writeFileSync(join(copy, "moved.txt"), "edited\n");
    expect(deviceTreeDeletes(outDir, PROJ).map((d) => d.command)).toEqual(["(removed from the device copy) proj/a.txt"]);
  });
  it("a listing that records no bytes (written before this check) cannot prove a rename: the move reads as a delete", () => {
    const { outDir, copy } = staged();
    const { entries } = JSON.parse(readFileSync(join(outDir, "device-tree-pre-run.json"), "utf8")) as {
      entries: Record<string, { id: string }>;
    };
    writeFileSync(
      join(outDir, "device-tree-pre-run.json"),
      JSON.stringify(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, v.id]))),
    );
    renameSync(join(copy, "a.txt"), join(copy, "moved.txt"));
    expect(deviceTreeDeletes(outDir, PROJ).map((d) => d.command)).toEqual(["(removed from the device copy) proj/a.txt"]);
  });
});
