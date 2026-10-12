// The device container's delete refusal: a libc shim preloaded system-wide in the locally built device image. These
// run real commands in a real container, so they need Docker and the agent base image; they skip loudly without
// them, and fail instead where CWH_REQUIRE_DOCKER=1 (the arm64 boundary job). Production's answers, from a real
// session, are the oracle: a delete in a connected folder is refused ("Operation not permitted") until the user
// allows it; a rename, also over an existing file, works; deleting a missing file still reports it missing; git's
// second commit fails on the lock the first one could not remove.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureDeviceImage } from "../src/runtime/device-image.js";
import {
  DEVICE_CANARY_NAME,
  deviceContainerArgv,
  deviceFolders,
  deviceHome,
  deviceBridgeRecord,
  deviceTreeIdentityReliable,
  deviceTurnFindings,
  prepareDeviceControl,
  readDeviceAudit,
  recordDeviceTree,
  stageDeviceFolders,
  startDeviceBridge,
  writeDeviceGrant,
} from "../src/runtime/device-container.js";
import type { Mount } from "../src/session.js";
import { computeVerdict } from "../src/run/verdict.js";
import type { RunResult } from "../src/types.js";

const BASE = "cowork-agent-base:2";
const REQUIRE = process.env.CWH_REQUIRE_DOCKER === "1";
function haveBase(): boolean {
  try {
    execFileSync("docker", ["image", "inspect", BASE], { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}
const CAN = haveBase();
if (!CAN) {
  if (REQUIRE) throw new Error(`CWH_REQUIRE_DOCKER=1 but docker or ${BASE} is unavailable`);
  process.stderr.write(`::warning:: device-shim tests SKIPPED: no docker or no local ${BASE} image\n`);
}

const SESSION = "shimtest";
const HOME = deviceHome(SESSION);
let image = "";
let root = "";
let outDir = "";
let host = "";
let name = "";
let mounts: Mount[] = [];

function sh(cmd: string): { code: number; out: string } {
  const r = spawnSync("docker", ["exec", "-w", HOME, name, "bash", "-c", cmd], { encoding: "utf8", timeout: 30_000 });
  return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}
const grant = (folder: string) => writeDeviceGrant(outDir, [folder]);
const auditLines = () => readDeviceAudit(outDir).lines;

const mount = (name: string, mode: Mount["mode"]): Mount => {
  const hostPath = join(root, "user", name);
  mkdirSync(hostPath, { recursive: true });
  return { hostPath, mountPath: name, mode, kind: "folder" };
};

describe.skipIf(!CAN)("the device image's delete refusal", () => {
  beforeAll(() => {
    const built = ensureDeviceImage("docker", BASE);
    if ("error" in built) throw new Error(built.error);
    image = built.imageId;
    root = realpathSync(mkdtempSync(join(tmpdir(), "device-shim-")));
    mounts = [mount("proj", "rw"), mount("other", "rw"), mount("free", "rwd"), mount("ref", "r")];
    writeFileSync(join(root, "user", "proj", "keep.txt"), "keep\n");
    writeFileSync(join(root, "user", "proj", "existing.txt"), "one\n");
    writeFileSync(join(root, "user", "proj", "other.txt"), "two\n");
    writeFileSync(join(root, "user", "free", "f.txt"), "f\n");
    writeFileSync(join(root, "user", "other", "pre.txt"), "pre\n");
    outDir = join(root, "out");
    host = join(outDir, "work", "device");
    const folders = deviceFolders(mounts);
    stageDeviceFolders(folders, host);
    recordDeviceTree(outDir);
    const { uid, gid } = userInfo();
    prepareDeviceControl(outDir, SESSION, folders, { uid, gid });
    name = `cwh-shim-test-${process.pid}`;
    const argv = deviceContainerArgv({
      name,
      image,
      network: "none",
      egressProxy: "http://127.0.0.1:9",
      deviceHost: host,
      controlHost: outDir,
      sessionId: SESSION,
      folders,
      user: { uid, gid },
    });
    // The bridge runs the container attached (`-i`); a test detaches it.
    execFileSync(
      "docker",
      argv.map((a) => (a === "-i" ? "-d" : a)),
      { stdio: "ignore", timeout: 60_000 },
    );
  }, 600_000);
  afterAll(() => {
    if (name) spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("refuses rm of a staged file in a connected folder, keeps it, and logs the refusal", () => {
    const r = sh("rm mnt/proj/keep.txt");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Operation not permitted/);
    expect(existsSync(join(host, "mnt", "proj", "keep.txt"))).toBe(true);
    expect(auditLines()).toContainEqual(expect.objectContaining({ op: "unlinkat", folder: "proj", rel: "keep.txt", result: "refused" }));
  });

  it("refuses every libc delete path, for a file the session made too", () => {
    for (const cmd of [
      "touch mnt/proj/s1 && rm mnt/proj/s1",
      "touch mnt/proj/s2 && unlink mnt/proj/s2",
      "mkdir mnt/proj/d && rmdir mnt/proj/d",
      "mkdir -p mnt/proj/t/u && touch mnt/proj/t/u/x && rm -r mnt/proj/t",
      "touch mnt/proj/s3 && find mnt/proj -name s3 -delete",
      "touch mnt/proj/s4 && python3 -c 'import os; os.remove(\"mnt/proj/s4\")'",
      "mkdir -p mnt/proj/s5/x && python3 -c 'import shutil; shutil.rmtree(\"mnt/proj/s5\")'",
      'touch mnt/proj/s6 && node -e \'require("fs").unlinkSync("mnt/proj/s6")\'',
      "touch mnt/proj/s7 && perl -e 'unlink(\"mnt/proj/s7\") or exit 1'",
      "env -u LD_PRELOAD rm mnt/proj/keep.txt",
      "/lib/ld-linux-aarch64.so.1 /usr/bin/rm mnt/proj/keep.txt",
    ])
      expect(sh(cmd).code, cmd).not.toBe(0);
    for (const f of ["s1", "s2", "d", "t/u/x", "s3", "s4", "s5/x", "s6", "s7", "keep.txt"])
      expect(existsSync(join(host, "mnt", "proj", f)), f).toBe(true);
  });

  it("rm -f of a missing file still exits 0, and a missing file's rm says it is missing", () => {
    expect(sh("rm -f mnt/proj/does-not-exist; echo $?").out.trim()).toBe("0");
    expect(sh("rm mnt/proj/does-not-exist").out).toMatch(/No such file or directory/);
  });

  it("allows writes, sed -i, and a rename within a folder, also over an existing file", () => {
    expect(sh("echo x > mnt/proj/new.txt && sed -i 's/one/uno/' mnt/proj/existing.txt").code).toBe(0);
    expect(readFileSync(join(host, "mnt", "proj", "existing.txt"), "utf8")).toBe("uno\n");
    expect(sh("mv mnt/proj/new.txt mnt/proj/renamed.txt && mv mnt/proj/other.txt mnt/proj/existing.txt").code).toBe(0);
    expect(existsSync(join(host, "mnt", "proj", "other.txt"))).toBe(false);
    expect(readFileSync(join(host, "mnt", "proj", "existing.txt"), "utf8")).toBe("two\n");
  });

  it("a move out of a folder, into another folder or to the mnt root is cross-device: mv copies and cannot remove the source", () => {
    writeFileSync(join(host, "mnt", "proj", "m1"), "m1\n");
    for (const dest of ["mnt/other/", "mnt/free/", "mnt/"]) {
      const r = sh(`mv mnt/proj/m1 ${dest}`);
      expect(r.code, dest).not.toBe(0);
      expect(existsSync(join(host, "mnt", "proj", "m1")), dest).toBe(true);
    }
  });

  it("renaming a connected folder itself, or mnt, is refused", () => {
    expect(sh("mv mnt/proj mnt/proj2").code).not.toBe(0);
    expect(sh("mv mnt mnt2").code).not.toBe(0);
    expect(existsSync(join(host, "mnt", "proj"))).toBe(true);
  });

  it("a folder that allows deletes, $HOME and /tmp are never refused", () => {
    expect(sh("rm mnt/free/f.txt").code).toBe(0);
    expect(sh("touch h.txt && rm h.txt && touch /tmp/t && rm /tmp/t").code).toBe(0);
  });

  it("a prefix of another folder's name is not that folder", () => {
    // `proj` is denied; a sibling named `projx` is not a connected folder at all.
    mkdirSync(join(host, "mnt", "projx"), { recursive: true });
    writeFileSync(join(host, "mnt", "projx", "z"), "z");
    expect(sh("rm mnt/projx/z").code).toBe(0);
  });

  it("the preload file and the control directory cannot be changed by the device user", () => {
    expect(sh("echo > /etc/ld.so.preload").code).not.toBe(0);
    expect(sh("echo proj >> /run/cwh-device/ctl/grants").code).not.toBe(0);
    expect(sh("echo x > /etc/passwd").code).not.toBe(0);
    expect(sh("rm mnt/proj/keep.txt").code).toBe(1);
  });

  it("the device user has production's per-session name and home", () => {
    expect(sh("whoami").out.trim()).toBe(HOME.split("/").pop());
    expect(sh(`python3 -c 'import os,pwd; print(pwd.getpwuid(os.getuid()).pw_dir)'`).out.trim()).toBe(HOME);
  });

  it("git: the first commit lands and leaves its locks; the second fails on HEAD.lock (production's signature)", () => {
    const git = "git -c user.name=t -c user.email=t@t";
    expect(sh(`cd mnt/proj && git init -q r && cd r && echo a > a.txt && git add a.txt`).code).toBe(0);
    const c1 = sh(`cd mnt/proj/r && ${git} commit -q -m c1`);
    expect(c1.code, c1.out).toBe(0);
    expect(existsSync(join(host, "mnt", "proj", "r", ".git", "HEAD.lock"))).toBe(true);
    const c2 = sh(`cd mnt/proj/r && echo b > b.txt && git add b.txt; ${git} commit -q -m c2`);
    expect(c2.code).toBe(128);
    expect(c2.out).toMatch(/HEAD\.lock.*File exists|File exists/s);
  });

  it("after a grant for the folder, the next rm works and is logged as granted", () => {
    grant("proj");
    expect(sh("rm mnt/proj/keep.txt").code).toBe(0);
    expect(existsSync(join(host, "mnt", "proj", "keep.txt"))).toBe(false);
    expect(auditLines()).toContainEqual(expect.objectContaining({ folder: "proj", rel: "keep.txt", result: "granted" }));
    // Another folder stays denied.
    writeFileSync(join(host, "mnt", "other", "o"), "o");
    expect(sh("rm mnt/other/o").code).toBe(1);
  });

  it("a raw system call gets past the shim; the device tree catches it and the run fails (end to end)", () => {
    // aarch64 unlinkat is syscall 35; AT_FDCWD is -100.
    const r = sh(`python3 -c 'import ctypes; l=ctypes.CDLL(None); print(l.syscall(35, -100, b"mnt/other/pre.txt", 0))'`);
    expect(r.out.trim()).toBe("0");
    expect(existsSync(join(host, "mnt", "other", "pre.txt"))).toBe(false);
    const findings = deviceTurnFindings(outDir, mounts, { shimEnforced: () => true });
    expect(findings.bypassedDeletes).toContain("other/pre.txt");
    expect(findings.refusedDeletes).toBeGreaterThan(0);
    const reliable = deviceTreeIdentityReliable(outDir);
    const plan = { permissionMode: "acceptEdits", permissionModeSource: "bridge-default" as const, egressAllow: [] };
    const deviceBridge = deviceBridgeRecord(mounts, "included", plan, [], reliable, findings);
    const v = computeVerdict(
      {
        scenario: "t",
        fidelity: "container",
        baseline: "x",
        result: "success",
        decisions: [],
        egress: [],
        assertions: [],
        outDir,
        scan: { outputsDeletes: [], mountDeletes: findings.mountDeletes, hostPathLeaked: false, selfHealRan: false },
        deviceBridge,
      } as unknown as RunResult,
      "live",
    );
    const sig = v.signals.find((x) => x.code === "device_delete_bypassed");
    expect(sig?.severity).toBe(reliable === false ? "warn" : "fail");
    expect(v.pass).toBe(reliable === false);
  });

  it("the canary's control name can never be a connected folder's", () => {
    expect(DEVICE_CANARY_NAME.startsWith(".")).toBe(true);
  });
});

// The canary: before anything depends on it, the bridge proves the shim refuses a delete. A container whose image
// has no shim (the plain agent image), or whose preload names a library that does not load (glibc then skips it
// without a word), must fail the run as a device-shim infra error rather than run unenforced.
describe.skipIf(!CAN)("startDeviceBridge's canary", () => {
  async function start(ensureImage?: (runner: string, base: string) => { imageId: string } | { error: string }) {
    const r = realpathSync(mkdtempSync(join(tmpdir(), "device-canary-")));
    const hostPath = join(r, "user", "proj");
    mkdirSync(hostPath, { recursive: true });
    writeFileSync(join(hostPath, "a.txt"), "a\n");
    const outDir = join(r, "out");
    const bridge = startDeviceBridge({
      runner: "docker",
      image: BASE,
      network: "none",
      egressProxy: "http://127.0.0.1:9",
      outDir,
      sessionId: `canary${process.pid}${ensureImage ? "x" : ""}`,
      mounts: [{ hostPath, mountPath: "proj", mode: "rw", kind: "folder" }],
      appVersion: "2.31226.1",
      resume: false,
      ...(ensureImage ? { ensureImage } : {}),
    });
    const enforced = await bridge.shimCheck;
    return { r, outDir, bridge, enforced };
  }
  it("passes on the device image: the probe survives, the record will say enforced", async () => {
    const { r, outDir, bridge, enforced } = await start();
    try {
      expect(enforced).toBe(true);
      expect(bridge.infraErrors).toEqual([]);
      expect(existsSync(join(outDir, "device-canary", "probe"))).toBe(true);
    } finally {
      await bridge.teardown();
      rmSync(r, { recursive: true, force: true });
    }
  }, 600_000);
  it("fails as device-shim on an image without the shim", async () => {
    const { r, bridge, enforced } = await start(() => ({ imageId: BASE }));
    try {
      expect(enforced).toBe(false);
      expect(bridge.infraErrors).toEqual([expect.objectContaining({ source: "device-shim" })]);
    } finally {
      await bridge.teardown();
      rmSync(r, { recursive: true, force: true });
    }
  }, 600_000);
  it("fails as device-shim when the image cannot be built", async () => {
    const { r, bridge, enforced } = await start(() => ({ error: "no network" }));
    try {
      expect(enforced).toBe(false);
      expect(bridge.infraErrors.map((e) => e.source)).toContain("device-shim");
      expect(bridge.infraErrors.find((e) => e.source === "device-shim")?.message).toMatch(/no network/);
    } finally {
      await bridge.teardown();
      rmSync(r, { recursive: true, force: true });
    }
  }, 600_000);
});
