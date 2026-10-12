// The files the device container's shim reads and writes, from the host side: the folder list it enforces, the
// grants it honours, the per-session user it runs as, and the audit log it appends to. Pure file tests; the shim's
// behaviour over them is in device-shim.test.ts.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEVICE_CANARY_NAME,
  deviceContainerArgv,
  deviceFolders,
  deviceHome,
  prepareDeviceControl,
  readDeviceAudit,
  readDeviceGrants,
  writeDeviceGrant,
} from "../src/runtime/device-container.js";
import type { Mount } from "../src/session.js";

const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), "device-ctl-")));
const mounts: Mount[] = [
  { hostPath: "/x/p", mountPath: ".projects/proj", mode: "rw", kind: "folder" },
  { hostPath: "/x/f", mountPath: "free", mode: "rwd", kind: "folder" },
  { hostPath: "/x/r", mountPath: "ref", mode: "r", kind: "folder" },
];
const user = { uid: 1001, gid: 121 };

describe("prepareDeviceControl", () => {
  it("lists every connected folder by name, mode and its path in the container, plus the canary", () => {
    const out = scratch();
    prepareDeviceControl(out, "cse_ABC", deviceFolders(mounts), user);
    const home = deviceHome("cse_ABC");
    expect(readFileSync(join(out, "device-ctl", "folders"), "utf8")).toBe(
      [
        `@mnt\t-\t${home}/mnt`,
        `proj\trw\t${home}/mnt/proj`,
        `free\trwd\t${home}/mnt/free`,
        `ref\tr\t${home}/mnt/ref`,
        `${DEVICE_CANARY_NAME}\trw\t/run/cwh-device/canary`,
        "",
      ].join("\n"),
    );
  });
  it("creates the canary's probe file host-side, an empty grants file, and production's per-session user", () => {
    const out = scratch();
    prepareDeviceControl(out, "cse_ABC", deviceFolders(mounts), user);
    expect(existsSync(join(out, "device-canary", "probe"))).toBe(true);
    expect(readFileSync(join(out, "device-ctl", "grants"), "utf8")).toBe("");
    expect(readFileSync(join(out, "device-etc", "passwd"), "utf8")).toContain(`rcw-abc:x:1001:121::${deviceHome("cse_ABC")}:/bin/bash\n`);
    expect(readFileSync(join(out, "device-etc", "group"), "utf8")).toContain("rcw-abc:x:121:\n");
  });
  it("a resumed turn keeps the grants an earlier turn wrote", () => {
    const out = scratch();
    prepareDeviceControl(out, "s", deviceFolders(mounts), user);
    writeDeviceGrant(out, ["proj"]);
    prepareDeviceControl(out, "s", deviceFolders(mounts), user);
    expect(readDeviceGrants(out)).toEqual(["proj"]);
  });
  it("no connected folder can take the canary's name", () => {
    expect(DEVICE_CANARY_NAME).toMatch(/^\./);
  });
});

describe("writeDeviceGrant appends, so two cards answered together both land", () => {
  it("each grant is one append; the reader de-duplicates in order", () => {
    const out = scratch();
    writeDeviceGrant(out, ["proj"]);
    writeDeviceGrant(out, ["free", "proj"]);
    expect(readFileSync(join(out, "device-ctl", "grants"), "utf8")).toBe("proj\nfree\nproj\n");
    expect(readDeviceGrants(out)).toEqual(["proj", "free"]);
  });
});

describe("deviceContainerArgv: the shim's binds", () => {
  const argv = deviceContainerArgv({
    name: "c",
    image: "sha256:abc",
    network: "n",
    egressProxy: "http://p:1",
    deviceHost: "/run/o/work/device",
    controlHost: "/run/o",
    sessionId: "s",
    folders: deviceFolders(mounts),
    user,
  });
  const binds = argv.flatMap((a, i) => (argv[i - 1] === "-v" ? [a] : []));
  it("runs as the host user, the control dir read-only, the audit and canary dirs writable, the user files read-only", () => {
    expect(argv.slice(argv.indexOf("--user"), argv.indexOf("--user") + 2)).toEqual(["--user", "1001:121"]);
    expect(binds).toContain("/run/o/device-ctl:/run/cwh-device/ctl:ro");
    expect(binds).toContain("/run/o/device-audit:/run/cwh-device/audit");
    expect(binds).toContain("/run/o/device-canary:/run/cwh-device/canary");
    expect(binds).toContain("/run/o/device-etc/passwd:/etc/passwd:ro");
    expect(binds).toContain("/run/o/device-etc/group:/etc/group:ro");
  });
});

describe("readDeviceAudit: the device user can write the log, so it is read with care", () => {
  it("parses one JSON line per entry and skips a malformed one", () => {
    const out = scratch();
    mkdirSync(join(out, "device-audit"));
    writeFileSync(
      join(out, "device-audit", "audit.jsonl"),
      '{"op":"unlinkat","folder":"proj","rel":"a","result":"refused","pid":1}\nnot json\n',
    );
    expect(readDeviceAudit(out)).toEqual({
      lines: [{ op: "unlinkat", folder: "proj", rel: "a", result: "refused", pid: 1 }],
      malformed: 1,
    });
  });
  it("a log replaced by a symlink is not followed", () => {
    const out = scratch();
    mkdirSync(join(out, "device-audit"));
    const secret = join(out, "secret");
    writeFileSync(secret, '{"op":"unlinkat","folder":"proj","rel":"x","result":"granted","pid":1}\n');
    symlinkSync(secret, join(out, "device-audit", "audit.jsonl"));
    expect(readDeviceAudit(out)).toEqual({ lines: [], malformed: 0, refusedReason: "not a regular file" });
  });
  it("no log is no lines", () => {
    expect(readDeviceAudit(scratch())).toEqual({ lines: [], malformed: 0 });
  });
});
