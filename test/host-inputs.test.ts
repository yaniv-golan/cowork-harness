// plugins.from_host: what is picked from the host, what is refused, what is skipped, and how the picked set is
// copied, hashed, mounted and recorded. Every host here is a synthetic config dir (test/helpers/fake-host-config.ts).
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBaseline } from "../src/baseline.js";
import { buildLaunchPlan, loadSession, resolveLaunchSources, type SessionConfig } from "../src/session.js";
import {
  hostPluginMountPath,
  hostSnapshotDir,
  hostSelectionSetHash,
  selectHostInputs,
  stageHostInputs,
  hostInputsSetHash,
} from "../src/host-inputs.js";
import { hashHostTree } from "../src/run/skill-hash.js";
import { stageWorkspace } from "../src/runtime/stage.js";
import { stageHostLoopWorkspace } from "../src/runtime/hostloop-stage.js";
import { stageProtocolMounts } from "../src/runtime/protocol.js";
import { fakeHostConfig, makeExecutable } from "./helpers/fake-host-config.js";

const latest = loadBaseline("latest");
const quiet = () => {};
afterEach(() => vi.unstubAllEnvs());

function session(fromHost: unknown, extra: Record<string, unknown> = {}): SessionConfig {
  const { plugins, ...rest } = extra as { plugins?: Record<string, unknown> };
  return loadSession({ plugins: { from_host: fromHost, ...(plugins ?? {}) }, ...rest });
}
function plan(
  s: SessionConfig,
  runRoot = mkdtempSync(join(tmpdir(), "fh-run-")),
  tier: "container" | "hostloop" | "protocol" = "container",
) {
  const sources = resolveLaunchSources(s, latest, tier, false, { quiet: true, runRoot });
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const p = buildLaunchPlan(s, latest, runRoot, tier, false, "local", sources, { runRoot });
  vi.restoreAllMocks();
  return { plan: p, runRoot };
}

describe("selectHostInputs", () => {
  it("true: every enabled user-scope plugin; a not-installed and a project-only key are skipped and listed; a disabled one is not read", () => {
    const cfg = fakeHostConfig([
      { key: "alpha@mk1" },
      { key: "beta@mk2", scope: "project", extra: [] },
      { key: "gamma@mk1", notInstalled: true },
      { key: "delta@mk1", enabled: false },
      { key: "eps@mk1", extra: [{ scope: "local", installPath: "/nonexistent", projectPath: "/also-not-read" }] },
    ]);
    const s = selectHostInputs(true, cfg, quiet);
    expect(s.plugins.map((p) => p.key)).toEqual(["alpha@mk1", "eps@mk1"]);
    expect(s.skipped).toEqual([
      { key: "beta@mk2", reason: "not-user-scope" },
      { key: "gamma@mk1", reason: "not-installed" },
    ]);
    expect(s.plugins[0]).toMatchObject({ name: "alpha", marketplace: "mk1", version: "1.0.0", gitCommitSha: "abc1234" });
  });

  it("an explicit list refuses what true would skip", () => {
    const cfg = fakeHostConfig([
      { key: "beta@mk2", scope: "project" },
      { key: "gamma@mk1", notInstalled: true },
    ]);
    expect(() => selectHostInputs({ plugins: ["gamma@mk1"], skills: [] }, cfg, quiet)).toThrow(/"gamma@mk1" is not installed/);
    expect(() => selectHostInputs({ plugins: ["beta@mk2"], skills: [] }, cfg, quiet)).toThrow(/"beta@mk2" has no user-scope install/);
  });

  it("two user-scope entries for one key are refused under both forms", () => {
    const cfg = fakeHostConfig([{ key: "alpha@mk1", extra: [{ scope: "user", installPath: "/x" }] }]);
    expect(() => selectHostInputs(true, cfg, quiet)).toThrow(/2 user-scope entries/);
    expect(() => selectHostInputs({ plugins: ["alpha@mk1"], skills: [] }, cfg, quiet)).toThrow(/2 user-scope entries/);
  });

  it("refuses an unknown installed_plugins.json version, a file that is not JSON, and a bare name", () => {
    const cfg = fakeHostConfig([{ key: "alpha@mk1" }]);
    const ip = join(cfg, "plugins", "installed_plugins.json");
    writeFileSync(ip, JSON.stringify({ version: 3, plugins: {} }));
    expect(() => selectHostInputs(true, cfg, quiet)).toThrow(/version 3; this harness reads version 2 only/);
    writeFileSync(ip, "{not json");
    expect(() => selectHostInputs(true, cfg, quiet)).toThrow(/installed_plugins.json .* is not valid JSON/);
    expect(() => session({ plugins: ["alpha"] })).toThrow(/bare name is ambiguous/);
  });

  it("missing host files: true yields an empty set with a warning; an explicit list refuses", () => {
    const cfg = mkdtempSync(join(tmpdir(), "empty-host-"));
    const warned: string[] = [];
    expect(selectHostInputs(true, cfg, (l) => warned.push(l))).toEqual({ configDir: cfg, plugins: [], skills: [], skipped: [] });
    expect(warned.join("")).toMatch(/no .*settings\.json/);
    writeFileSync(join(cfg, "settings.json"), JSON.stringify({ enabledPlugins: { "a@m": true } }));
    const s = selectHostInputs(true, cfg, (l) => warned.push(l));
    expect(s.skipped).toEqual([{ key: "a@m", reason: "not-installed" }]);
    expect(() => selectHostInputs({ plugins: ["a@m"], skills: [] }, cfg, quiet)).toThrow(/no .*installed_plugins\.json/);
    expect(() => selectHostInputs({ plugins: [], skills: ["s"] }, cfg, quiet)).toThrow(/no .*skills: the named skills/);
  });

  it("refuses an installPath outside <config>/plugins, or one that does not exist", () => {
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    expect(() => selectHostInputs(true, fakeHostConfig([{ key: "a@m", installPath: outside }]), quiet)).toThrow(/is outside/);
    expect(() => selectHostInputs(true, fakeHostConfig([{ key: "a@m", installPath: "/does/not/exist" }]), quiet)).toThrow(/does not exist/);
  });

  it("refuses two plugins with one name from different marketplaces", () => {
    expect(() => selectHostInputs(true, fakeHostConfig([{ key: "a@m1" }, { key: "a@m2" }]), quiet)).toThrow(/two plugins named "a"/);
  });

  it("refuses an escaping symlink inside a plugin tree or a skill tree; an in-tree relative one is fine", () => {
    const cfg = fakeHostConfig([{ key: "a@m" }], { sk: { "SKILL.md": "x" } });
    const root = selectHostInputs(true, cfg, quiet).plugins[0]!.installPath;
    symlinkSync("README.md", join(root, "inner-link"));
    expect(() => selectHostInputs(true, cfg, quiet)).not.toThrow();
    symlinkSync("/etc/hosts", join(root, "out-link"));
    expect(() => selectHostInputs(true, cfg, quiet)).toThrow(/plugin "a@m" holds a symlink that points outside it/);
    rmSync(join(root, "out-link"));
    symlinkSync("../../..", join(cfg, "skills", "sk", "up"));
    expect(() => selectHostInputs(true, cfg, quiet)).toThrow(/skill "sk" holds a symlink that points outside it/);
  });

  it("a symlinked skill is followed; a dangling one is refused; a loose file is not a skill", () => {
    const cfg = fakeHostConfig([], { real: { "SKILL.md": "r" } });
    const elsewhere = mkdtempSync(join(tmpdir(), "skill-elsewhere-"));
    writeFileSync(join(elsewhere, "SKILL.md"), "linked");
    symlinkSync(elsewhere, join(cfg, "skills", "linked"));
    writeFileSync(join(cfg, "skills", "notes.txt"), "loose");
    const s = selectHostInputs(true, cfg, quiet);
    expect(s.skills.map((k) => k.name)).toEqual(["linked", "real"]);
    symlinkSync(join(elsewhere, "gone"), join(cfg, "skills", "dangling"));
    expect(() => selectHostInputs(true, cfg, quiet)).toThrow(/"dangling" is a symlink whose target does not exist/);
  });
});

describe("plugins.from_host: launch plan", () => {
  it("mounts each plugin at .local-plugins/marketplaces/<marketplace>/<name> from the run's copy, as a local-plugin", () => {
    const cfg = fakeHostConfig([{ key: "a@m1" }, { key: "b@m2" }], { sk: { "SKILL.md": "skill" } });
    vi.stubEnv("CLAUDE_CONFIG_DIR", cfg);
    const { plan: p, runRoot } = plan(session(true));
    const host = p.mounts.filter((m) => m.hostInputKey);
    expect(host.map((m) => [m.mountPath, m.kind])).toEqual([
      [".local-plugins/marketplaces/m1/a", "local-plugin"],
      [".local-plugins/marketplaces/m2/b", "local-plugin"],
    ]);
    for (const m of host) expect(m.hostPath.startsWith(join(runRoot, "host-inputs"))).toBe(true);
    expect(p.pluginDirs).toEqual(expect.arrayContaining([".local-plugins/marketplaces/m1/a", ".local-plugins/marketplaces/m2/b"]));
    // the marker files are never copied
    expect(existsSync(join(host[0]!.hostPath, ".in_use"))).toBe(false);
    // a host skill is staged into the run's config dir as a real directory
    expect(lstatSync(join(p.configDir, "skills", "sk")).isDirectory()).toBe(true);
    expect(p.hostInputs!.plugins.map((x) => x.key)).toEqual(["a@m1", "b@m2"]);
    expect(p.hostInputs!.skills.map((x) => x.name)).toEqual(["sk"]);
  });

  it("two plugins at the same version in different marketplaces do not collide", () => {
    const cfg = fakeHostConfig([
      { key: "a@m1", version: "2.0.0" },
      { key: "c@m2", version: "2.0.0" },
    ]);
    vi.stubEnv("CLAUDE_CONFIG_DIR", cfg);
    const { plan: p } = plan(session(true));
    expect(new Set(p.mounts.map((m) => m.mountPath)).size).toBe(p.mounts.length);
  });

  it("a symlinked skill is staged dereferenced: the run gets a copy, not a pointer into the host", () => {
    const cfg = fakeHostConfig([]);
    const elsewhere = mkdtempSync(join(tmpdir(), "skill-src-"));
    writeFileSync(join(elsewhere, "SKILL.md"), "linked");
    mkdirSync(join(cfg, "skills"), { recursive: true });
    symlinkSync(elsewhere, join(cfg, "skills", "linked"));
    vi.stubEnv("CLAUDE_CONFIG_DIR", cfg);
    const { plan: p } = plan(session(true));
    const staged = join(p.configDir, "skills", "linked");
    expect(lstatSync(staged).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(staged, "SKILL.md"), "utf8")).toBe("linked");
  });

  it("a scenario plugin or skill of the same name replaces the host's, which is not delivered and is recorded as shadowed", () => {
    const cfg = fakeHostConfig([{ key: "dup@m" }, { key: "keep@m" }], { s1: { "SKILL.md": "host" } });
    vi.stubEnv("CLAUDE_CONFIG_DIR", cfg);
    const own = mkdtempSync(join(tmpdir(), "own-"));
    mkdirSync(join(own, "dup", ".claude-plugin"), { recursive: true });
    writeFileSync(join(own, "dup", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "dup" }));
    mkdirSync(join(own, "s1"));
    writeFileSync(join(own, "s1", "SKILL.md"), "scenario");
    const { plan: p } = plan(session(true, { plugins: { local_plugins: [join(own, "dup")] }, skills: { local: [join(own, "s1")] } }));
    expect(p.mounts.filter((m) => m.hostInputKey).map((m) => m.hostInputKey)).toEqual(["keep@m"]);
    expect(p.pluginDirs.filter((d) => d.endsWith("/dup"))).toEqual([".local-plugins/marketplaces/local-desktop-app-uploads/dup"]);
    expect(readFileSync(join(p.configDir, "skills", "s1", "SKILL.md"), "utf8")).toBe("scenario");
    expect(p.hostInputs!.shadowed).toEqual(["dup@m", "skill:s1"]);
    expect(p.hostInputs!.plugins.map((x) => x.key)).toEqual(["keep@m"]);
    expect(p.hostInputs!.skills).toEqual([]);
  });

  it("a host plugin whose manifest name differs from its key is shadowed by a scenario plugin of the manifest name", () => {
    const cfg = fakeHostConfig([
      { key: "repo-name@m", files: { ".claude-plugin/plugin.json": JSON.stringify({ name: "brand" }), "README.md": "r" } },
    ]);
    vi.stubEnv("CLAUDE_CONFIG_DIR", cfg);
    const own = mkdtempSync(join(tmpdir(), "own-"));
    mkdirSync(join(own, "brand", ".claude-plugin"), { recursive: true });
    writeFileSync(join(own, "brand", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "brand" }));
    const { plan: p } = plan(session(true, { plugins: { local_plugins: [join(own, "brand")] } }));
    expect(p.hostInputs!.shadowed).toEqual(["repo-name@m"]);
    expect(p.mounts.filter((m) => m.hostInputKey)).toEqual([]);
  });

  it("below the bare-names baseline a host plugin mounts at the legacy cache/ leaf", () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", fakeHostConfig([{ key: "a@m" }]));
    const legacy = loadBaseline("desktop-1.13576.1");
    const runRoot = mkdtempSync(join(tmpdir(), "fh-legacy-"));
    const s = session(true);
    const sources = resolveLaunchSources(s, legacy, "container", false, { quiet: true, runRoot });
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const p = buildLaunchPlan(s, legacy, runRoot, "container", false, "local", sources, { runRoot });
    vi.restoreAllMocks();
    expect(p.mounts.filter((m) => m.hostInputKey).map((m) => m.mountPath)).toEqual([".local-plugins/cache/m/a"]);
    expect(hostPluginMountPath("m", "a", true)).toBe(".local-plugins/marketplaces/m/a");
  });

  it("is refused with a pinned config_dir, and on --resume", () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", fakeHostConfig([]));
    const pinned = join(mkdtempSync(join(tmpdir(), "pin-")), "cfg");
    expect(() =>
      resolveLaunchSources(session(true, { plugins: { config_dir: pinned } }), latest, "container", false, { quiet: true }),
    ).toThrow(/cannot be combined with plugins.config_dir/);
    expect(() => resolveLaunchSources(session(true), latest, "container", true, { quiet: true })).toThrow(/does not support --resume/);
  });

  it("prints one loud line naming the counts, the set hash and every skip", () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", fakeHostConfig([{ key: "a@m" }, { key: "g@m", notInstalled: true }]));
    const s = session(true);
    const runRoot = mkdtempSync(join(tmpdir(), "fh-run-"));
    const sources = resolveLaunchSources(s, latest, "container", false, { quiet: true, runRoot });
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((c) => (lines.push(String(c)), true));
    const p = buildLaunchPlan(s, latest, runRoot, "container", false, "local", sources, { runRoot });
    spy.mockRestore();
    expect(lines.join("")).toContain(
      `[from_host] 1 plugin(s), 0 skill(s) from your host, setHash ${p.hostInputs!.setHash.slice(0, 12)}; skipped 1: g@m (not-installed)`,
    );
  });
});

describe("plugins.from_host: hashes", () => {
  it("setHash is stable across runs, moves on a skill edit and on a hand edit under the cache, and ignores the markers", () => {
    const cfg = fakeHostConfig([{ key: "a@m" }], { sk: { "SKILL.md": "v1" } });
    vi.stubEnv("CLAUDE_CONFIG_DIR", cfg);
    const h1 = plan(session(true)).plan.hostInputs!.setHash;
    expect(plan(session(true)).plan.hostInputs!.setHash).toBe(h1);
    const install = selectHostInputs(true, cfg, quiet).plugins[0]!.installPath;
    writeFileSync(join(install, ".in_use"), "touched");
    writeFileSync(join(install, ".DS_Store"), "finder");
    expect(plan(session(true)).plan.hostInputs!.setHash).toBe(h1);
    writeFileSync(join(cfg, "skills", "sk", "SKILL.md"), "v2");
    const h2 = plan(session(true)).plan.hostInputs!.setHash;
    expect(h2).not.toBe(h1);
    appendFileSync(join(install, "README.md"), "hand edit\n");
    expect(plan(session(true)).plan.hostInputs!.setHash).not.toBe(h2);
  });

  it("a file's executable bit is part of its hash", () => {
    const cfg = fakeHostConfig([{ key: "a@m", files: { "bin/run.sh": "#!/bin/sh\n" } }]);
    vi.stubEnv("CLAUDE_CONFIG_DIR", cfg);
    const h1 = plan(session(true)).plan.hostInputs!.setHash;
    makeExecutable(join(selectHostInputs(true, cfg, quiet).plugins[0]!.installPath, "bin", "run.sh"));
    expect(plan(session(true)).plan.hostInputs!.setHash).not.toBe(h1);
  });

  it("the source hash (hillclimb's gate) equals the copy hash, on a git work tree with untracked files, an executable, an in-tree symlink and an empty dir", () => {
    const cfg = fakeHostConfig([{ key: "a@m", files: { "bin/run.sh": "#!/bin/sh\n", "tracked.md": "t" } }], { sk: { "SKILL.md": "s" } });
    const sel = selectHostInputs(true, cfg, quiet);
    const root = sel.plugins[0]!.installPath;
    makeExecutable(join(root, "bin", "run.sh"));
    symlinkSync("tracked.md", join(root, "alias.md"));
    mkdirSync(join(root, "empty"));
    const git = (...a: string[]) => spawnSync("git", ["-C", root, ...a], { encoding: "utf8" });
    git("init", "-q");
    git("add", "tracked.md");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "t");
    writeFileSync(join(root, "untracked.md"), "u");
    const sourceHash = hostSelectionSetHash(sel, []);
    const staged = stageHostInputs(sel, [], mkdtempSync(join(tmpdir(), "fh-snap-")));
    expect(staged.hostInputs.setHash).toBe(sourceHash);
    // the copy kept what git does not track: the bytes Claude Code itself would load
    expect(existsSync(join(staged.pluginDirs.get("a@m")!, "untracked.md"))).toBe(true);
    expect(hostInputsSetHash(staged.hostInputs)).toBe(staged.hostInputs.setHash);
  });

  it("OS junk in a plugin or a skill is neither copied nor hashed: the source hash still equals the copy hash", () => {
    const cfg = fakeHostConfig([{ key: "a@m", files: { "README.md": "r", ".DS_Store": "x" } }], {
      sk: { "SKILL.md": "s", ".DS_Store": "x" },
    });
    const sel = selectHostInputs(true, cfg, quiet);
    const staged = stageHostInputs(sel, [], mkdtempSync(join(tmpdir(), "fh-junk-")));
    expect(staged.hostInputs.setHash).toBe(hostSelectionSetHash(sel, []));
    expect(existsSync(join(staged.pluginDirs.get("a@m")!, ".DS_Store"))).toBe(false);
    expect(existsSync(join(staged.skillDirs.get("sk")!, ".DS_Store"))).toBe(false);
    expect(existsSync(join(staged.skillDirs.get("sk")!, "SKILL.md"))).toBe(true);
  });
});

describe("plugins.from_host: every tier stages the hashed copy as it is", () => {
  function gitPlugin() {
    const cfg = fakeHostConfig([{ key: "a@m", files: { "tracked.md": "t" } }], { sk: { "SKILL.md": "s" } });
    symlinkSync("SKILL.md", join(cfg, "skills", "sk", "alias.md")); // and in a skill
    const root = selectHostInputs(true, cfg, quiet).plugins[0]!.installPath;
    const git = (...a: string[]) => spawnSync("git", ["-C", root, ...a], { encoding: "utf8" });
    git("init", "-q");
    git("add", "tracked.md");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "t");
    writeFileSync(join(root, "untracked.md"), "u");
    symlinkSync("tracked.md", join(root, "alias.md")); // an in-tree relative link: must stay relative when staged
    vi.stubEnv("CLAUDE_CONFIG_DIR", cfg);
    return cfg;
  }
  const roots = { sessionRoot: "/sessions/t", vmSessionRoot: "/sessions/t" };

  it("container / microvm, hostloop and protocol: the staged plugin hashes to the recorded sha, its relative link intact", () => {
    gitPlugin();
    for (const tier of ["container", "hostloop", "protocol"] as const) {
      const { plan: p, runRoot } = plan(session(true), undefined, tier);
      const mnt = join(runRoot, "mnt");
      mkdirSync(mnt, { recursive: true });
      if (tier === "container") stageWorkspace(p, mnt, roots);
      else if (tier === "hostloop") stageHostLoopWorkspace(p, mnt, roots);
      else stageProtocolMounts(p, mnt);
      const staged = join(mnt, ".local-plugins", "marketplaces", "m", "a");
      expect(readdirSync(staged).sort(), tier).toContain("untracked.md");
      expect(readlinkSync(join(staged, "alias.md")), tier).toBe("tracked.md");
      expect(hashHostTree(staged).sha256, tier).toBe(p.hostInputs!.plugins[0]!.sha256);
      // the skill, where this tier's agent reads it: mnt/.claude at container, the run's config dir otherwise
      const skill = tier === "container" ? join(mnt, ".claude", "skills", "sk") : join(p.configDir, "skills", "sk");
      expect(readlinkSync(join(skill, "alias.md")), tier).toBe("SKILL.md");
      expect(hashHostTree(skill).sha256, tier).toBe(p.hostInputs!.skills[0]!.sha256);
    }
  });
});

describe("plugins.local_plugins: every tier keeps an in-tree link as written", () => {
  it("container / microvm, hostloop and protocol: a relative link in a scenario plugin stays relative when staged", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "local-plugin-link-")), "linked");
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "linked", version: "1.0.0" }));
    writeFileSync(join(dir, "target.md"), "t");
    symlinkSync("target.md", join(dir, "alias.md"));
    const roots = { sessionRoot: "/sessions/t", vmSessionRoot: "/sessions/t" };
    for (const tier of ["container", "hostloop", "protocol"] as const) {
      const { plan: p, runRoot } = plan(session(undefined, { plugins: { local_plugins: [dir] } }), undefined, tier);
      const mnt = join(runRoot, "mnt");
      mkdirSync(mnt, { recursive: true });
      if (tier === "container") stageWorkspace(p, mnt, roots);
      else if (tier === "hostloop") stageHostLoopWorkspace(p, mnt, roots);
      else stageProtocolMounts(p, mnt);
      const pluginMount = p.mounts.find((m) => m.hostPath === dir);
      expect(pluginMount?.hostInputKey, tier).toBeUndefined();
      expect(readlinkSync(join(mnt, pluginMount!.mountPath, "alias.md")), tier).toBe("target.md");
    }
  });
});

describe("plugins.from_host: a later leg stages the snapshot as it is too", () => {
  it("a second leg's plan, staged at container and hostloop, still hashes to the recorded sha on a git tree", () => {
    const cfg = fakeHostConfig([{ key: "a@m", files: { "tracked.md": "t" } }]);
    const root = selectHostInputs(true, cfg, quiet).plugins[0]!.installPath;
    const git = (...a: string[]) => spawnSync("git", ["-C", root, ...a], { encoding: "utf8" });
    git("init", "-q");
    git("add", "tracked.md");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "t");
    writeFileSync(join(root, "untracked.md"), "u");
    symlinkSync("tracked.md", join(root, "alias.md"));
    vi.stubEnv("CLAUDE_CONFIG_DIR", cfg);
    const { runRoot } = plan(session(true));
    for (const tier of ["container", "hostloop", "protocol"] as const) {
      const leg2 = plan(session(true), runRoot, tier).plan;
      const mnt = mkdtempSync(join(tmpdir(), "fh-leg2-mnt-"));
      if (tier === "container") stageWorkspace(leg2, mnt, { sessionRoot: "/sessions/t", vmSessionRoot: "/sessions/t" });
      else if (tier === "hostloop") stageHostLoopWorkspace(leg2, mnt, { sessionRoot: "/sessions/t", vmSessionRoot: "/sessions/t" });
      else stageProtocolMounts(leg2, mnt);
      const staged = join(mnt, ".local-plugins", "marketplaces", "m", "a");
      expect(readdirSync(staged).sort(), tier).toContain("untracked.md");
      expect(hashHostTree(staged).sha256, tier).toBe(leg2.hostInputs!.plugins[0]!.sha256);
    }
  });
});

describe("plugins.from_host: a `workdir: persistent` later leg re-hashes what it reuses", () => {
  type Tier = "container" | "hostloop" | "protocol";
  const r = { sessionRoot: "/sessions/t", vmSessionRoot: "/sessions/t" };
  const stageAt = (tier: Tier, p: ReturnType<typeof plan>["plan"], tree: string) =>
    tier === "container"
      ? stageWorkspace(p, tree, r)
      : tier === "hostloop"
        ? stageHostLoopWorkspace(p, tree, r)
        : stageProtocolMounts(p, tree);
  function persistentLeg(tier: Tier, between: (runRoot: string, tree: string) => void = () => {}) {
    const cfg = fakeHostConfig([{ key: "a@m" }], { sk: { "SKILL.md": "s" } });
    // in-tree relative links in both: an untouched tree must still pass on the next leg
    symlinkSync("README.md", join(selectHostInputs(true, cfg, quiet).plugins[0]!.installPath, "alias.md"));
    symlinkSync("SKILL.md", join(cfg, "skills", "sk", "alias.md"));
    vi.stubEnv("CLAUDE_CONFIG_DIR", cfg);
    const runRoot = mkdtempSync(join(tmpdir(), "fh-pers-"));
    const s = session(true);
    const leg1 = plan(s, runRoot, tier).plan;
    const tree = join(runRoot, "tree");
    mkdirSync(tree, { recursive: true });
    stageAt(tier, leg1, tree);
    between(runRoot, tree);
    const sources = resolveLaunchSources(s, latest, tier, false, { quiet: true, runRoot });
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const leg2 = buildLaunchPlan(s, latest, runRoot, tier, false, "local", sources, { runRoot, legStage: { workdir: "persistent" } });
    vi.restoreAllMocks();
    const stage2 = () => stageAt(tier, leg2, tree);
    const skillsDir = tier === "container" ? join(tree, ".claude", "skills") : join(leg2.configDir, "skills");
    return { tree, stage2, skillsDir };
  }

  for (const tier of ["container", "hostloop", "protocol"] as const) {
    it(`${tier}: OS metadata appearing in the staged tree or in the run's snapshot is not a change`, () => {
      const a = persistentLeg(tier, (runRoot, tree) => {
        writeFileSync(join(tree, ".local-plugins", "marketplaces", "m", "a", ".DS_Store"), "x");
        writeFileSync(join(hostSnapshotDir(runRoot), "plugins", "m", "a", ".DS_Store"), "x");
        writeFileSync(join(hostSnapshotDir(runRoot), "skills", "sk", ".DS_Store"), "x");
      });
      expect(() => a.stage2()).not.toThrow();
    });

    it(`${tier}: an untouched tree passes; a plugin or a skill an earlier leg edited is refused`, () => {
      const a = persistentLeg(tier);
      expect(() => a.stage2()).not.toThrow();
      appendFileSync(join(a.tree, ".local-plugins", "marketplaces", "m", "a", "README.md"), "edit\n");
      expect(() => a.stage2()).toThrow(/plugin "a@m" was changed by an earlier leg/);
      const b = persistentLeg(tier);
      writeFileSync(join(b.skillsDir, "sk", "notes.md"), "added by leg 1");
      expect(() => b.stage2()).toThrow(/skill "sk" was changed by an earlier leg/);
    });
  }
});

describe("hashHostTree", () => {
  it("reports a symlink that points outside the tree as an error, not a silent skip", () => {
    const dir = mkdtempSync(join(tmpdir(), "fh-hash-"));
    writeFileSync(join(dir, "a.md"), "a");
    symlinkSync(join(tmpdir()), join(dir, "out"));
    expect(hashHostTree(dir).errors.join("\n")).toMatch(/points outside the tree/);
    symlinkSync("a.md", join(dir, "in"));
    expect(hashHostTree(mkdtempSync(join(tmpdir(), "fh-hash-ok-"))).errors).toEqual([]);
  });
});

describe("plugins.from_host: a later leg of the same run", () => {
  it("reuses the snapshot without reading the host, and refuses a copy that changed", () => {
    const cfg = fakeHostConfig([{ key: "a@m" }]);
    vi.stubEnv("CLAUDE_CONFIG_DIR", cfg);
    const { plan: leg1, runRoot } = plan(session(true));
    // the host moves between legs: leg 2 still gets leg 1's bytes
    appendFileSync(join(selectHostInputs(true, cfg, quiet).plugins[0]!.installPath, "README.md"), "moved\n");
    const { plan: leg2 } = plan(session(true), runRoot);
    expect(leg2.hostInputs).toEqual(leg1.hostInputs);
    expect(leg2.mounts.find((m) => m.hostInputKey)!.hostPath).toBe(leg1.mounts.find((m) => m.hostInputKey)!.hostPath);
    appendFileSync(join(leg1.mounts.find((m) => m.hostInputKey)!.hostPath, "README.md"), "tampered\n");
    expect(() => plan(session(true), runRoot)).toThrow(/staged copy of plugin "a@m" changed after an earlier leg/);
  });
});
