import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadBaseline } from "../src/baseline.js";
import * as baselineMod from "../src/baseline.js";
import * as processCwdMod from "../src/hostloop/process-cwd.js";
import { hostLoopCwds, hostLoopProcessContract } from "../src/runtime/hostloop.js";

// From Desktop 2.7032.0 the host-loop agent process no longer runs at the outputs dir. Desktop spawns it at
// `/var/empty` when that passes a stat check (a directory, owned by root, not group- or world-writable),
// else at a per-session `host-cwd` dir, and hands it DENY rules for every spelling of that directory — so a
// relative Read/Write/Edit is refused by the agent itself. Before this, the harness ran the agent at
// outputs, where a bare relative write silently succeeded: a false green production does not share.

const tmpDirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  tmpDirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const MIN = (baselineMod as Record<string, unknown>).HOSTLOOP_SYSTEM_EMPTY_CWD_MIN_VERSION as string | undefined;
const pc = processCwdMod as Record<string, any>;

const statOf = (isDir: boolean, uid: number, mode: number) => ({ isDirectory: () => isDir, uid, mode });

describe("the version gate", () => {
  it("starts at 2.7032.0 — the first backed-up Desktop whose host loop runs the agent at /var/empty", () => {
    // Marker counts over every backed-up asar: /var/empty, host-cwd and getHostProcessCwd are absent
    // through 2.2553.1 and present from 2.7032.0; hostLoopCwd disappears in the same release.
    expect(MIN).toBe("2.7032.0");
  });

  it("real baselines on each side of the boundary, stated literally (not via the comparison under test)", () => {
    const expected: Record<string, boolean> = {
      "desktop-1.46388.4": false,
      "desktop-2.2553.1": false,
      "desktop-2.7032.0": true,
      "desktop-2.9939.2": true,
    };
    for (const [n, want] of Object.entries(expected)) expect(pc.hostLoopUsesSystemEmptyCwd(loadBaseline(n)), n).toBe(want);
    expect(pc.hostLoopUsesSystemEmptyCwd({ appVersion: "2.7031.99" } as never)).toBe(false);
    expect(pc.hostLoopUsesSystemEmptyCwd({ appVersion: undefined } as never)).toBe(false);
  });
});

describe("the process cwd", () => {
  it("is /var/empty when it passes Desktop's stat check", () => {
    const fb = tmp("cwh-hostcwd-");
    const cwd = pc.resolveHostProcessCwd({ fallbackDir: join(fb, "host-cwd"), stat: () => statOf(true, 0, 0o40755) });
    expect(cwd).toBe("/var/empty");
    expect(existsSync(join(fb, "host-cwd"))).toBe(false);
  });

  it.each([
    ["not a directory", statOf(false, 0, 0o100755)],
    ["not owned by root", statOf(true, 501, 0o40755)],
    ["group-writable", statOf(true, 0, 0o40775)],
    ["world-writable", statOf(true, 0, 0o40757)],
  ])("falls back to a per-session host-cwd dir when /var/empty is %s, created as Desktop creates it", (_label, st) => {
    const fb = join(tmp("cwh-hostcwd-"), "host-cwd");
    const cwd = pc.resolveHostProcessCwd({ fallbackDir: fb, stat: () => st });
    expect(cwd).toBe(fb);
    const pj = join(fb, "package.json");
    expect(readFileSync(pj, "utf8")).toBe('{"private": true}\n');
    expect(statSync(pj).mode & 0o777).toBe(0o600);
    // Created once, never overwritten.
    writeFileSync(pj, "edited");
    pc.resolveHostProcessCwd({ fallbackDir: fb, stat: () => st });
    expect(readFileSync(pj, "utf8")).toBe("edited");
  });

  it("falls back when /var/empty cannot be stat'ed at all", () => {
    const fb = join(tmp("cwh-hostcwd-"), "host-cwd");
    const cwd = pc.resolveHostProcessCwd({
      fallbackDir: fb,
      stat: () => {
        throw new Error("ENOENT");
      },
    });
    expect(cwd).toBe(fb);
  });

  it("hostLoopCwds keeps the three values together: process cwd, shell cwd, and the outputs dir relative paths resolve against", () => {
    const r = (hostLoopCwds as (...a: unknown[]) => Record<string, string>)("/S", "/S/mnt/outputs", "/var/empty");
    expect(r.agentProcessCwd).toBe("/var/empty");
    expect(r.workspaceBashCwd).toBe("/S");
    expect(r.pathResolverBase).toBe("/S/mnt/outputs");
    const old = (hostLoopCwds as (...a: unknown[]) => Record<string, string>)("/S", "/S/mnt/outputs");
    expect(old.agentProcessCwd).toBe("/S/mnt/outputs");
  });
});

describe("the deny rules Desktop hands the agent for its cwd", () => {
  const darwin = { platform: "darwin", realpath: (p: string) => (p === "/var/empty" ? "/private/var/empty" : p) };

  it("covers four spellings of /var/empty on darwin: itself, its realpath, and both Data-volume forms", () => {
    const { cwdSpellings } = pc.cwdDenyRules("/var/empty", darwin);
    expect([...cwdSpellings].sort()).toEqual(
      ["/System/Volumes/Data/private/var/empty", "/System/Volumes/Data/var/empty", "/private/var/empty", "/var/empty"].sort(),
    );
  });

  it("denies Edit/Write/MultiEdit and Read under each spelling, and nothing else", () => {
    const { rules } = pc.cwdDenyRules("/var/empty", darwin);
    const expected: string[] = [];
    for (const s of ["/var/empty", "/System/Volumes/Data/var/empty", "/private/var/empty", "/System/Volumes/Data/private/var/empty"])
      for (const t of ["Edit", "Write", "MultiEdit", "Read"]) expected.push(`${t}(/${s}/**)`);
    expect([...rules].sort()).toEqual(expected.sort());
  });

  it("on linux there is no Data-volume form", () => {
    const { cwdSpellings } = pc.cwdDenyRules("/tmp/x/host-cwd", { platform: "linux", realpath: (p: string) => p });
    expect(cwdSpellings).toEqual(["/tmp/x/host-cwd"]);
  });

  it("hostLoopPermissionArgs: post-gate, deny rules join --disallowedTools and outputs is added as a working directory", () => {
    const a = pc.hostLoopPermissionArgs({ processCwd: "/var/empty", hostOutputsDir: "/S/mnt/outputs", ...darwin });
    expect(a.disallowed).toEqual(expect.arrayContaining(["Read(//private/var/empty/**)", "Write(//var/empty/**)"]));
    expect(a.disallowed).not.toContain("PowerShell");
    const i = a.extraArgs.indexOf("--settings");
    expect(i).toBeGreaterThan(-1);
    expect(JSON.parse(a.extraArgs[i + 1])).toEqual({ permissions: { additionalDirectories: ["/S/mnt/outputs"] } });
  });
});

describe("the spawn contract, on both sides of the gate", () => {
  const stock = () => statOf(true, 0, 0o40755);

  it("2.2553.1: agent at outputs, no deny rules, no --settings", () => {
    const out = tmp("cwh-contract-");
    const c = hostLoopProcessContract(loadBaseline("desktop-2.2553.1"), out, "/S", "/S/mnt/outputs", { stat: stock });
    expect(c.processCwd).toBeUndefined();
    expect(c.permission).toBeUndefined();
    expect(c.cwds.agentProcessCwd).toBe("/S/mnt/outputs");
  });

  it("latest: agent at /var/empty, deny rules and outputs-as-working-directory in the argv", () => {
    const out = tmp("cwh-contract-");
    const c = hostLoopProcessContract(loadBaseline("latest"), out, "/S", "/S/mnt/outputs", { stat: stock });
    expect(c.processCwd).toBe("/var/empty");
    expect(c.cwds.agentProcessCwd).toBe("/var/empty");
    expect(c.permission?.disallowed).toContain("Write(//var/empty/**)");
    expect(c.permission?.extraArgs[0]).toBe("--settings");
  });

  it("latest on a Mac whose /var/empty fails the check: a per-run host-cwd dir outside the mounted session tree", () => {
    const out = tmp("cwh-contract-");
    const c = hostLoopProcessContract(loadBaseline("latest"), out, "/S", "/S/mnt/outputs", { stat: () => statOf(true, 0, 0o40777) });
    expect(c.processCwd).toBe(join(out, "work", "host-cwd"));
    expect(c.processCwd?.includes("/work/session")).toBe(false);
  });
});

describe("spawnHostLoop uses the contract for the spawn, the argv and the gate", () => {
  // The spawn itself starts real processes; this pins that it takes all three from the one contract.
  const SRC = readFileSync("src/runtime/hostloop.ts", "utf8")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
  it.each([
    "= hostLoopProcessContract(baseline, outDir, sessionRoot, hostOutputsDir)",
    "...(permission?.disallowed ?? [])",
    "extraArgs: permission.extraArgs",
    "processCwdSpellings: permission.cwdSpellings",
    "cwd: cwds.agentProcessCwd,",
    "pathGateCwdMismatch(input.cwd, cwds.agentProcessCwd)",
  ])("%s", (anchor) => expect(SRC.split(anchor).length - 1).toBe(1));
});
