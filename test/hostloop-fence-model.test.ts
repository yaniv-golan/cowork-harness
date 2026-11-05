// The host-loop outside-folder fence as the harness emits it (Desktop >=4.16336.0): the predicate, the exact
// members of the one --settings object, and the three-set invariant over real directories.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadBaseline, resolveHostAgentBinary } from "../src/baseline.js";
import {
  agentVersionOfBinary,
  hostLoopFenceApplies,
  hostLoopFencePermissions,
  hostLoopPermissionArgs,
} from "../src/hostloop/process-cwd.js";
import { hostLoopProcessContract } from "../src/runtime/hostloop.js";

const settingsOf = (extraArgs: string[]) =>
  JSON.parse(extraArgs[extraArgs.indexOf("--settings") + 1]!) as { permissions: Record<string, unknown> };
const id = (p: string) => p;

describe("hostLoopFenceApplies", () => {
  const b = { hostLoopFence: { minCli: "2.1.315" } };
  it("on at and above the floor, off below it and with no fence recorded", () => {
    expect(hostLoopFenceApplies(b, "2.1.315")).toBe(true);
    expect(hostLoopFenceApplies(b, "2.1.317")).toBe(true);
    expect(hostLoopFenceApplies(b, "2.1.314")).toBe(false);
    expect(hostLoopFenceApplies({ hostLoopFence: null }, "2.1.317")).toBe(false);
    expect(hostLoopFenceApplies({}, "2.1.317")).toBe(false);
    expect(hostLoopFenceApplies(b, undefined)).toBe(false);
  });
  it("reads the version from Desktop's staging layout, in either form, without running the binary", () => {
    const warns: string[] = [];
    const ask = () => {
      throw new Error("must not run");
    };
    const app = "claude.app/Contents/MacOS/claude";
    expect(agentVersionOfBinary(`/A/claude-code/2.1.317/${app}`, "x", (m) => warns.push(m), ask)).toBe("2.1.317");
    expect(agentVersionOfBinary(`/A/claude-code/2.1.317/abcdef123456/${app}`, "x", (m) => warns.push(m), ask)).toBe("2.1.317");
    expect(warns).toEqual([]);
  });
  it("asks any other binary for its version: a version-shaped directory elsewhere is not the agent's", () => {
    const warns: string[] = [];
    const asked: string[] = [];
    const ask = (p: string) => (asked.push(p), "2.1.300 (Claude Code)\n");
    expect(agentVersionOfBinary("/opt/homebrew/Cellar/node/25.2.1/bin/claude", "2.1.317", (m) => warns.push(m), ask)).toBe("2.1.300");
    expect(agentVersionOfBinary("/A/claude-code/2.1.317/claude", "2.1.317", (m) => warns.push(m), ask)).toBe("2.1.300");
    expect(asked).toHaveLength(2);
    expect(warns).toEqual([]);
  });
  it("falls back to the baseline's version, loudly, when the binary cannot say", () => {
    const warns: string[] = [];
    const fail = () => {
      throw new Error("ENOENT");
    };
    expect(agentVersionOfBinary("/opt/bin/claude", "2.1.309", (m) => warns.push(m), fail)).toBe("2.1.309");
    expect(
      agentVersionOfBinary(
        "/opt/bin/claude",
        "2.1.309",
        (m) => warns.push(m),
        () => "garbage",
      ),
    ).toBe("2.1.309");
    expect(warns).toHaveLength(2);
    expect(warns[0]).toMatch(/--version failed \(ENOENT\)/);
    expect(warns[1]).toMatch(/printed no version/);
  });
  it.skipIf(process.platform !== "darwin")("runs --version on a real staged agent reached through an unversioned path", () => {
    let native: string;
    try {
      native = resolveHostAgentBinary(loadBaseline("latest"));
    } catch {
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "cwh-agent-link-"));
    try {
      const link = join(dir, "claude");
      symlinkSync(native, link);
      const warns: string[] = [];
      expect(agentVersionOfBinary(link, "0.0.0", (m) => warns.push(m))).toBe(loadBaseline("latest").agentVersion);
      expect(warns).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("hostLoopFencePermissions (exact members)", () => {
  const roots = { folders: ["/U/rw", "/U/ro/"], readOnlyRoots: ["/S/mnt/uploads", "/C/projects", "/", "/C/skills"] };
  const real = (p: string) => (p === "/C/projects" ? "/private/C/projects" : p);
  const perms = hostLoopFencePermissions("/S/mnt/outputs", roots, real);
  it("the two booleans, outputs + every folder as working directories, the same strings as given, no trailing separator", () => {
    expect(perms).toEqual({
      additionalDirectories: ["/S/mnt/outputs", "/U/rw", "/U/ro"],
      blockReadsOutsideWorkingDirectories: true,
      blockWritesOutsideWorkingDirectories: true,
      blockReadsExemptPaths: ["/S/mnt/uploads", "/C/projects", "/private/C/projects", "/C/skills"],
      workingDirectoriesAsGiven: ["/U/rw", "/U/ro"],
    });
  });
  it("never exempts outputs, a filesystem root, or a working directory", () => {
    const ex = perms.blockReadsExemptPaths as string[];
    expect(ex).not.toContain("/");
    expect(ex).not.toContain("/S/mnt/outputs");
    for (const w of perms.workingDirectoriesAsGiven as string[]) expect(ex).not.toContain(w);
  });
  it("a root not created yet is exempt under its given spelling only", () => {
    const p = hostLoopFencePermissions("/O", { folders: [], readOnlyRoots: ["/C/projects"] }, () => {
      throw new Error("ENOENT");
    });
    expect(p.blockReadsExemptPaths).toEqual(["/C/projects"]);
  });
});

describe("hostLoopPermissionArgs: one --settings, fenced or not", () => {
  const base = { processCwd: "/var/empty", hostOutputsDir: "/S/mnt/outputs", platform: "darwin", realpath: id };
  it("without the fence, today's object exactly", () => {
    expect(settingsOf(hostLoopPermissionArgs(base).extraArgs)).toEqual({ permissions: { additionalDirectories: ["/S/mnt/outputs"] } });
  });
  it("with it, still a single --settings, carrying the fence", () => {
    const a = hostLoopPermissionArgs({ ...base, fence: { folders: ["/U/rw"], readOnlyRoots: ["/S/mnt/uploads"] } });
    expect(a.extraArgs.filter((x) => x === "--settings")).toHaveLength(1);
    expect(settingsOf(a.extraArgs).permissions).toMatchObject({
      blockReadsOutsideWorkingDirectories: true,
      workingDirectoriesAsGiven: ["/U/rw"],
      blockReadsExemptPaths: ["/S/mnt/uploads"],
    });
  });
});

describe("hostLoopProcessContract: the fence follows the baseline and the binary's version", () => {
  const out = mkdtempSync(join(tmpdir(), "cwh-fence-contract-"));
  afterAll(() => rmSync(out, { recursive: true, force: true }));
  const stat = () => ({ isDirectory: () => true, uid: 0, mode: 0o40755 });
  const fence = (agentBinary: string) => ({ roots: { folders: ["/U/rw"], readOnlyRoots: ["/S/mnt/uploads"] }, agentBinary });
  const withFence = { ...loadBaseline("desktop-4.4212.0"), appVersion: "4.16336.0", hostLoopFence: { minCli: "2.1.315" } };
  const fenced = (c: ReturnType<typeof hostLoopProcessContract>) =>
    "blockReadsOutsideWorkingDirectories" in settingsOf(c.permission!.extraArgs).permissions;
  it("fenced at/above the floor", () => {
    expect(
      fenced(
        hostLoopProcessContract(withFence, out, "/S", "/S/mnt/outputs", {
          stat,
          fence: fence("/A/claude-code/2.1.317/claude.app/Contents/MacOS/claude"),
        }),
      ),
    ).toBe(true);
  });
  it("unfenced below the floor, with no recorded fence, or with no fence roots passed", () => {
    expect(
      fenced(
        hostLoopProcessContract(withFence, out, "/S", "/S/mnt/outputs", {
          stat,
          fence: fence("/A/claude-code/2.1.309/claude.app/Contents/MacOS/claude"),
        }),
      ),
    ).toBe(false);
    const older = loadBaseline("desktop-4.4212.0");
    expect(
      fenced(
        hostLoopProcessContract(older, out, "/S", "/S/mnt/outputs", {
          stat,
          fence: fence("/A/claude-code/2.1.317/claude.app/Contents/MacOS/claude"),
        }),
      ),
    ).toBe(false);
    expect(fenced(hostLoopProcessContract(withFence, out, "/S", "/S/mnt/outputs", { stat }))).toBe(false);
  });
});

// Every root the host-loop stager writes lands in exactly one of {process cwd, working directories, read
// exemptions} — or in none, for the roots production leaves out (none here). Real directories under os.tmpdir(), so
// on macOS the /private realpath spelling is exercised.
describe("fence invariant over a staged layout", () => {
  const top = mkdtempSync(join(tmpdir(), "cwh-fence-inv-"));
  afterAll(() => rmSync(top, { recursive: true, force: true }));
  const d = (...p: string[]) => {
    const x = join(top, ...p);
    mkdirSync(x, { recursive: true });
    return x;
  };
  const outputs = d("session", "mnt", "outputs");
  const uploads = d("session", "mnt", "uploads");
  const plugin = d("session", "mnt", "plugin-a");
  const spool = d("config", "projects");
  const skills = d("config", "skills");
  const rw = d("user", "rw-folder");
  const ro = d("user", "ro-folder");
  const processCwd = d("work", "host-cwd");
  const perms = hostLoopFencePermissions(outputs, { folders: [rw, ro], readOnlyRoots: [uploads, spool, skills, plugin] });
  const wd = perms.additionalDirectories as string[];
  const ex = perms.blockReadsExemptPaths as string[];

  it("is exercised: tmpdir realpaths differ from their given spelling on this machine, or the test says so", () => {
    if (process.platform === "darwin") expect(realpathSync(uploads)).not.toBe(uploads);
  });
  it.each([
    ["outputs", outputs, "wd"],
    ["rw folder", rw, "wd"],
    ["ro folder", ro, "wd"],
    ["uploads", uploads, "ex"],
    ["spool", spool, "ex"],
    ["skills", skills, "ex"],
    ["plugin", plugin, "ex"],
  ])("%s is in exactly one set", (_n, root, where) => {
    const inWd = wd.includes(root);
    const inEx = ex.includes(root);
    expect([inWd, inEx, root === processCwd].filter(Boolean)).toHaveLength(1);
    expect(where === "wd" ? inWd : inEx).toBe(true);
    if (where === "ex") expect(ex).toContain(realpathSync(root));
  });
  it("the process cwd is in neither list", () => {
    expect(wd).not.toContain(processCwd);
    expect(ex).not.toContain(processCwd);
  });
  it("the three sets are disjoint", () => {
    expect(wd.filter((w) => ex.includes(w))).toEqual([]);
  });
});
