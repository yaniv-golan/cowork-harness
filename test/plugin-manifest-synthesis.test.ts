// A plugin delivered with no `.claude-plugin/plugin.json`. Claude Desktop writes one (`{name}`) into every plugin it
// syncs without one, and never overwrites an existing one; the harness does the same in its STAGED copy of a
// `remote_plugins` or local-marketplace mount, never in the author's folder. Afterwards the name the agent derives from
// the staged tree (`binaryPluginIdentity` over the staged path) and the name the harness's own readers derive from the
// plan (`pluginSkillRootsFromPlan`, `mountedPluginsFromPlan`) must be the same name, on every tier's stager.
import { describe, it, expect, vi, afterEach } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBaseline } from "../src/baseline.js";
import {
  binaryPluginIdentity,
  buildLaunchPlan,
  loadSession,
  mountedPluginsFromPlan,
  pluginSkillRootsFromPlan,
  resolveLaunchSources,
  type LaunchPlan,
} from "../src/session.js";
import { stageWorkspace } from "../src/runtime/stage.js";
import { stageHostLoopWorkspace } from "../src/runtime/hostloop-stage.js";
import { stageProtocolMounts } from "../src/runtime/protocol.js";

const latest = loadBaseline("latest");
const roots = { sessionRoot: "/sessions/t", vmSessionRoot: "/sessions/t" };
const TIERS = ["container", "hostloop", "protocol"] as const;
type Tier = (typeof TIERS)[number];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function write(root: string, files: Record<string, string>): string {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

/** A skills repo laid out as `skills/<name>/SKILL.md`, with no plugin manifest. */
function skillsRepo(parent: string, dirName = "my-skills-repo", extra: Record<string, string> = {}): string {
  return write(join(parent, dirName), {
    "README.md": "# my skills\n",
    "skills/demo-skill/SKILL.md": "---\nname: demo-skill\ndescription: Use when asked for a demo checklist.\n---\nbody\n",
    ...extra,
  });
}

function planFor(plugins: Record<string, unknown>, tier: Tier): LaunchPlan {
  // Untracked fixture dirs: copy them raw rather than through a git tracked set.
  vi.stubEnv("COWORK_HARNESS_GITSET", "0");
  const runRoot = mkdtempSync(join(tmpdir(), "pms-run-"));
  const s = loadSession({ plugins });
  const sources = resolveLaunchSources(s, latest, tier, false, { quiet: true, runRoot });
  const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const p = buildLaunchPlan(s, latest, runRoot, tier, false, "local", sources, { runRoot });
  err.mockRestore();
  return p;
}

/** Stage `p` with this tier's own stager; returns the mnt root and everything the stager wrote to stderr. */
function stage(p: LaunchPlan, tier: Tier): { mnt: string; stderr: string } {
  const mnt = mkdtempSync(join(tmpdir(), "pms-mnt-"));
  let stderr = "";
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });
  try {
    if (tier === "container") stageWorkspace(p, mnt, roots);
    else if (tier === "hostloop") stageHostLoopWorkspace(p, mnt, roots);
    else stageProtocolMounts(p, mnt);
  } finally {
    spy.mockRestore();
  }
  return { mnt, stderr };
}

function pluginMount(p: LaunchPlan) {
  const m = p.mounts.filter((x) => x.kind === "local-plugin" || x.kind === "remote-plugin" || x.kind === "marketplace-plugin");
  expect(m).toHaveLength(1);
  return m[0]!;
}

function readersAgree(p: LaunchPlan, staged: string): string {
  const agent = binaryPluginIdentity(staged).name;
  expect(pluginSkillRootsFromPlan(p).map((r) => r.pluginName)).toEqual([agent]);
  const listed = mountedPluginsFromPlan(p);
  expect(listed.map((x) => x.pluginName)).toEqual([agent]);
  expect(listed[0]!.skills.map((s) => s.name)).toEqual([`${agent}:demo-skill`]);
  return agent;
}

describe("a manifest-less remote plugin: the staged copy gets a manifest named after the source folder", () => {
  for (const tier of TIERS) {
    it(`${tier}: written into the staged copy only, and every reader names the plugin the way the agent will`, () => {
      const src = skillsRepo(mkdtempSync(join(tmpdir(), "pms-src-")));
      const p = planFor({ remote_plugins: [src] }, tier);
      const m = pluginMount(p);
      expect(m.mountPath).toMatch(/^\.remote-plugins\/plugin_/);
      const { mnt, stderr } = stage(p, tier);
      const staged = join(mnt, m.mountPath);
      const pj = join(staged, ".claude-plugin", "plugin.json");
      expect(existsSync(pj)).toBe(true);
      expect(JSON.parse(readFileSync(pj, "utf8"))).toEqual({ name: "my-skills-repo" });
      expect(existsSync(join(src, ".claude-plugin"))).toBe(false); // the author's folder is untouched
      expect(readersAgree(p, staged)).toBe("my-skills-repo");
      expect(stderr).toMatch(/::notice::.*plugin\.json.*my-skills-repo/);
    });
  }

  it("a stager that re-copies onto an existing staged tree writes nothing and says nothing the second time", () => {
    const src = skillsRepo(mkdtempSync(join(tmpdir(), "pms-src-")));
    const p = planFor({ remote_plugins: [src] }, "protocol");
    const m = pluginMount(p);
    const { mnt } = stage(p, "protocol");
    let again = "";
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      again += String(chunk);
      return true;
    });
    stageProtocolMounts(p, mnt);
    spy.mockRestore();
    expect(again).not.toMatch(/plugin\.json/);
    expect(JSON.parse(readFileSync(join(mnt, m.mountPath, ".claude-plugin", "plugin.json"), "utf8"))).toEqual({ name: "my-skills-repo" });
  });
});

describe("a manifest-less local-marketplace plugin: the manifest carries the marketplace ENTRY name", () => {
  function marketplace(): string {
    const mk = mkdtempSync(join(tmpdir(), "pms-mk-"));
    write(mk, {
      ".claude-plugin/marketplace.json": JSON.stringify({ name: "mymkt", plugins: [{ name: "demo-plugin", source: "./src-dir" }] }),
    });
    skillsRepo(mk, "src-dir");
    return mk;
  }
  for (const tier of TIERS) {
    it(`${tier}: the entry name, not the source directory's name`, () => {
      const mk = marketplace();
      const p = planFor({ local_marketplaces: [mk], enabled: ["demo-plugin@mymkt"] }, tier);
      const m = pluginMount(p);
      expect(m.mountPath).toBe(".local-plugins/marketplaces/mymkt/demo-plugin");
      const { mnt } = stage(p, tier);
      const staged = join(mnt, m.mountPath);
      expect(JSON.parse(readFileSync(join(staged, ".claude-plugin", "plugin.json"), "utf8"))).toEqual({ name: "demo-plugin" });
      expect(existsSync(join(mk, "src-dir", ".claude-plugin"))).toBe(false);
      expect(readersAgree(p, staged)).toBe("demo-plugin");
    });
  }
});

describe("controls: what must NOT change", () => {
  for (const tier of TIERS) {
    it(`${tier}: a remote plugin WITH a manifest is staged byte-for-byte, and its declared name wins`, () => {
      const body = '{\n  "name": "declared-name",\n  "description": "kept as written"\n}\n';
      const src = skillsRepo(mkdtempSync(join(tmpdir(), "pms-src-")), "my-skills-repo", { ".claude-plugin/plugin.json": body });
      const p = planFor({ remote_plugins: [src] }, tier);
      const m = pluginMount(p);
      const { mnt, stderr } = stage(p, tier);
      const staged = join(mnt, m.mountPath);
      expect(readFileSync(join(staged, ".claude-plugin", "plugin.json"), "utf8")).toBe(body);
      expect(readersAgree(p, staged)).toBe("declared-name");
      expect(stderr).not.toMatch(/plugin\.json/);
    });

    it(`${tier}: a manifest-less local_plugins mount gets nothing written (its staged leaf already is its name)`, () => {
      const src = skillsRepo(mkdtempSync(join(tmpdir(), "pms-src-")));
      const p = planFor({ local_plugins: [src] }, tier);
      const m = pluginMount(p);
      const { mnt, stderr } = stage(p, tier);
      const staged = join(mnt, m.mountPath);
      expect(readdirSync(staged).sort()).toEqual(["README.md", "skills"]);
      expect(readersAgree(p, staged)).toBe("my-skills-repo");
      expect(stderr).not.toMatch(/plugin\.json/);
    });
  }

  it("a staged `.claude-plugin` that is a symlink is never written through", () => {
    const parent = mkdtempSync(join(tmpdir(), "pms-src-"));
    const outside = mkdtempSync(join(tmpdir(), "pms-outside-"));
    const src = skillsRepo(parent);
    symlinkSync(outside, join(src, ".claude-plugin"));
    const p = planFor({ remote_plugins: [src] }, "container");
    const m = pluginMount(p);
    const { mnt } = stage(p, "container");
    expect(lstatSync(join(mnt, m.mountPath, ".claude-plugin")).isSymbolicLink()).toBe(true);
    expect(readdirSync(outside)).toEqual([]);
  });
});
