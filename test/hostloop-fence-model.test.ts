// The host-loop outside-folder fence as the harness emits it (Desktop >=4.16336.0): the predicate, the exact
// members of the one --settings object, and the three-set invariant over real directories.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { loadBaseline, resolveHostAgentBinary } from "../src/baseline.js";
import {
  agentVersionOfBinary,
  hostLoopFenceApplies,
  hostLoopFencePermissions,
  hostLoopPermissionArgs,
} from "../src/hostloop/process-cwd.js";
import { pluginDirArgs } from "../src/runtime/argv.js";
import { hostLoopAppRoots, hostLoopProcessContract } from "../src/runtime/hostloop.js";
import { stageHostLoopWorkspace } from "../src/runtime/hostloop-stage.js";
import { buildLaunchPlan, loadSession } from "../src/session.js";

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
    expect(agentVersionOfBinary(`/A/claude-code/2.1.317/${app}`, (m) => warns.push(m), ask)).toBe("2.1.317");
    expect(agentVersionOfBinary(`/A/claude-code/2.1.317/abcdef123456/${app}`, (m) => warns.push(m), ask)).toBe("2.1.317");
    expect(warns).toEqual([]);
  });
  it("asks any other binary for its version: a version-shaped directory elsewhere is not the agent's", () => {
    const warns: string[] = [];
    const asked: string[] = [];
    const ask = (p: string) => (asked.push(p), "2.1.300 (Claude Code)\n");
    expect(agentVersionOfBinary("/opt/homebrew/Cellar/node/25.2.1/bin/claude", (m) => warns.push(m), ask)).toBe("2.1.300");
    expect(agentVersionOfBinary("/A/claude-code/2.1.317/claude", (m) => warns.push(m), ask)).toBe("2.1.300");
    expect(asked).toHaveLength(2);
    expect(warns).toEqual([]);
  });
  it("refuses the fence, loudly, when the binary cannot say (no fallback to the baseline's version)", () => {
    const warns: string[] = [];
    const fail = () => {
      throw new Error("ENOENT");
    };
    expect(agentVersionOfBinary("/opt/bin/claude", (m) => warns.push(m), fail)).toBeUndefined();
    expect(
      agentVersionOfBinary(
        "/opt/bin/claude",
        (m) => warns.push(m),
        () => "garbage",
      ),
    ).toBeUndefined();
    expect(warns).toHaveLength(2);
    expect(warns[0]).toMatch(/--version failed \(ENOENT\).*fence is not sent/);
    expect(warns[1]).toMatch(/printed no version.*fence is not sent/);
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
      expect(agentVersionOfBinary(link, (m) => warns.push(m))).toBe(loadBaseline("latest").agentVersion);
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

describe("hostLoopProcessContract: a baseline without a fence never asks the binary for its version", () => {
  const out = mkdtempSync(join(tmpdir(), "cwh-fence-prefence-"));
  afterAll(() => rmSync(out, { recursive: true, force: true }));
  const stat = () => ({ isDirectory: () => true, uid: 0, mode: 0o40755 });
  const unversioned = { roots: { folders: ["/U/rw"], readOnlyRoots: ["/S/mnt/uploads"] }, agentBinary: "/saved/copy/claude" };
  const run = (baseline: ReturnType<typeof loadBaseline>) => {
    const asked: string[] = [];
    const err: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => (err.push(String(c)), true));
    try {
      const c = hostLoopProcessContract(baseline, out, "/S", "/S/mnt/outputs", {
        stat,
        fence: unversioned,
        askAgentVersion: (p) => (asked.push(p), "2.1.317 (Claude Code)"),
      });
      return { fenced: "blockReadsOutsideWorkingDirectories" in settingsOf(c.permission!.extraArgs).permissions, asked, err };
    } finally {
      spy.mockRestore();
    }
  };
  it("pre-fence baseline: no --version, no warning, no fence", () => {
    const r = run(loadBaseline("desktop-4.4212.0"));
    expect(r).toEqual({ fenced: false, asked: [], err: [] });
  });
  it("fenced baseline: the same override is asked once, and its answer decides", () => {
    const r = run({ ...loadBaseline("desktop-4.4212.0"), appVersion: "4.16336.0", hostLoopFence: { minCli: "2.1.315" } });
    expect(r.fenced).toBe(true);
    expect(r.asked).toEqual(["/saved/copy/claude"]);
  });
});

// The invariant over what the harness REALLY stages: a plan built from a session (two folders, an upload, a local and a
// remote plugin) is staged by stageHostLoopWorkspace, and every place the agent's tools can be pointed at — each
// entry under mnt (a parent of per-mount dirs counts through its children), each --plugin-dir, the spool and
// skills — lands in exactly one of {working directories, read exemptions}. The roots come from hostLoopAppRoots, the
// function the spawn uses, so a new stager root or a --plugin-dir that drifts from the fence's filter goes red here.
describe("fence invariant over the real stager's layout", () => {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "cwh-fence-inv-")));
  afterAll(() => rmSync(top, { recursive: true, force: true }));
  const d = (...p: string[]) => {
    const x = join(top, ...p);
    mkdirSync(x, { recursive: true });
    return x;
  };
  const rw = d("user", "rw-folder");
  const ro = d("user", "ro-folder");
  const upload = join(d("user", "inbox"), "report.txt");
  writeFileSync(upload, "x");
  const local = d("user", "local-plugin");
  mkdirSync(join(local, ".claude-plugin"), { recursive: true });
  writeFileSync(join(local, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "local-p" }));
  const remote = d("user", "remote-plugin");
  const plan = buildLaunchPlan(
    loadSession({
      folders: [{ from: rw }, { from: ro, mode: "r" }],
      uploads: [upload],
      plugins: { local_plugins: [local], remote_plugins: [remote] },
    }),
    loadBaseline("latest"),
    d("out"),
  );
  const mntHost = join(top, "session", "mnt");
  mkdirSync(mntHost, { recursive: true });
  stageHostLoopWorkspace(plan, mntHost, { sessionRoot: join(top, "session"), vmSessionRoot: "/sessions/t" });
  const outputs = join(mntHost, "outputs");
  const perms = hostLoopFencePermissions(outputs, hostLoopAppRoots(plan, mntHost).fence);
  const wd = (perms.additionalDirectories as string[]).map((p) => realpathSync(p));
  const ex = (perms.blockReadsExemptPaths as string[]).filter((p) => existsSync(p)).map((p) => realpathSync(p));
  const under = (p: string, roots: string[]) => roots.some((r) => p === r || p.startsWith(r + sep));
  /** Which sets cover `p` (by real path): "wd", "ex", or both/neither. */
  const sets = (p: string) => {
    const r = realpathSync(p);
    return [under(r, wd) && "wd", under(r, ex) && "ex"].filter(Boolean);
  };

  it("the plan exercises every mount kind the fence filters on", () => {
    const kinds = new Set(plan.mounts.map((m) => m.kind));
    expect([...kinds].sort()).toEqual(expect.arrayContaining(["folder", "upload"]));
    expect(plan.pluginDirs.length).toBeGreaterThanOrEqual(2);
  });
  it("everything the stager made under mnt is covered by exactly one set (a parent of per-mount dirs through its children)", () => {
    expect(readdirSync(mntHost)).toEqual(expect.arrayContaining(["outputs", "uploads", ".local-plugins", ".remote-plugins"]));
    const walk = (p: string, rel: string) => {
      const own = sets(p);
      if (own.length === 1) return;
      expect(own, `${rel} is in both sets`).toEqual([]);
      const kids = statSync(p).isDirectory() ? readdirSync(p) : [];
      expect(kids.length, `${rel} is covered by neither set and holds no covered per-mount dir`).toBeGreaterThan(0);
      for (const k of kids) walk(join(p, k), `${rel}/${k}`);
    };
    for (const e of readdirSync(mntHost)) walk(join(mntHost, e), e);
  });
  it("every --plugin-dir the agent is given is a read exemption", () => {
    const dirs = pluginDirArgs(plan, mntHost).filter((_, i) => i % 2 === 1);
    expect(dirs).toHaveLength(plan.pluginDirs.length);
    for (const p of dirs) expect(sets(p), p).toEqual(["ex"]);
  });
  it("the spool and skills are read exemptions; outputs and the folders are working directories", () => {
    mkdirSync(join(plan.configDir, "skills"), { recursive: true });
    const again = hostLoopFencePermissions(outputs, hostLoopAppRoots(plan, mntHost).fence);
    const ex2 = (again.blockReadsExemptPaths as string[]).filter((p) => existsSync(p)).map((p) => realpathSync(p));
    for (const p of [join(plan.configDir, "projects"), join(plan.configDir, "skills")]) expect(under(realpathSync(p), ex2), p).toBe(true);
    for (const p of [outputs, rw, ro]) expect(sets(p), p).toEqual(["wd"]);
  });
  it("the working directories and the exemptions are disjoint", () => {
    expect(wd.filter((w) => ex.includes(w))).toEqual([]);
  });
});
