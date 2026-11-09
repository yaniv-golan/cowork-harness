import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBaseline } from "../src/baseline.js";
import { loadSession, buildLaunchPlan } from "../src/session.js";

/** Build a local marketplace dir with one plugin `<name>` and return its path. */
function makeMarketplace(mktName: string, pluginName: string): string {
  const mk = mkdtempSync(join(tmpdir(), `cwh-mkt-${mktName}-`));
  mkdirSync(join(mk, ".claude-plugin"), { recursive: true });
  mkdirSync(join(mk, pluginName, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(mk, ".claude-plugin", "marketplace.json"),
    JSON.stringify({ name: mktName, plugins: [{ name: pluginName, source: `./${pluginName}` }] }),
  );
  writeFileSync(join(mk, pluginName, ".claude-plugin", "plugin.json"), JSON.stringify({ name: pluginName, version: "1.2.3" }));
  return mk;
}

/**
 * Tier-accurate work-folder mount naming, on the oldest supported baseline.
 */
const gated = loadBaseline("desktop-1.14271.0");

const folderMount = (sessionObj: unknown, baseline: ReturnType<typeof loadBaseline>, tier: any) => {
  const out = mkdtempSync(join(tmpdir(), "cwh-gate-"));
  const plan = buildLaunchPlan(loadSession(sessionObj), baseline, out, tier);
  return plan.mounts.filter((m) => m.kind === "folder").map((m) => m.mountPath);
};

describe("work-folder mount naming", () => {
  it("a folder mounts at the BARE basename, not .projects/", () => {
    const paths = folderMount({ folders: [{ from: "./examples/data/project" }] }, gated, "hostloop");
    expect(paths).toEqual(["project"]);
  });
});

describe("tier-accurate naming", () => {
  it("two distinct-basename folders both mount bare", () => {
    const paths = folderMount({ folders: [{ from: "./examples/data" }, { from: "./examples/skills" }] }, gated, "hostloop");
    expect(paths).toEqual(["data", "skills"]);
  });
});

describe("plugin mount paths", () => {
  it("a local plugin mounts under marketplaces/local-desktop-app-uploads/<name> (no cache/)", () => {
    const base = mkdtempSync(join(tmpdir(), "cwh-plug-"));
    const pluginDir = join(base, "my-skill");
    mkdirSync(pluginDir);
    const out = mkdtempSync(join(tmpdir(), "cwh-po-"));
    const plan = buildLaunchPlan(loadSession({ plugins: { local_plugins: [pluginDir] } }), gated, out, "container");
    const p = plan.mounts.find((m) => m.kind === "local-plugin")!.mountPath;
    expect(p).toBe(".local-plugins/marketplaces/local-desktop-app-uploads/my-skill");
    expect(p).not.toContain("/cache/");
    // pluginDirs (--plugin-dir) tracks it via kind, not the old cache/ prefix
    expect(plan.pluginDirs).toContain(p);
  });

  it("a marketplace plugin → marketplaces/<mkt>/<plugin> (no cache/, no version)", () => {
    const mk = makeMarketplace("mymkt", "withver");
    const out = mkdtempSync(join(tmpdir(), "cwh-mp-"));
    const plan = buildLaunchPlan(
      loadSession({ plugins: { local_marketplaces: [mk], enabled: ["withver@mymkt"] } }),
      gated,
      out,
      "container",
    );
    expect(plan.pluginDirs).toContain(".local-plugins/marketplaces/mymkt/withver");
    expect(plan.pluginDirs.some((p) => p.includes("/cache/") || p.endsWith("/1.2.3"))).toBe(false);
  });

  it("same plugin name across two marketplaces → DISTINCT dests (no duplicate-dest throw)", () => {
    const mk1 = makeMarketplace("mkt1", "foo");
    const mk2 = makeMarketplace("mkt2", "foo");
    const out = mkdtempSync(join(tmpdir(), "cwh-mp2-"));
    const plan = buildLaunchPlan(
      loadSession({ plugins: { local_marketplaces: [mk1, mk2], enabled: ["foo@mkt1", "foo@mkt2"] } }),
      gated,
      out,
      "container",
    );
    expect(plan.pluginDirs).toContain(".local-plugins/marketplaces/mkt1/foo");
    expect(plan.pluginDirs).toContain(".local-plugins/marketplaces/mkt2/foo");
  });
});

describe("guard-seeding — folder named like a reserved dir trips the dup-dest guard", () => {
  it("a VM-tier (fy, no reserved seed) folder resolving to a fixed name throws instead of shadowing", () => {
    // craft a folder whose basename is `outputs` by pointing at examples/data/... is impossible without such a
    // dir; instead rely on the seeded guard: a folder named `outputs` would resolve to bare `outputs` (fy) and
    // collide with the reserved set. We can't easily create an `outputs`-named dir in the repo, so this is a
    // unit-level guard assertion via a temp dir.
    const base = mkdtempSync(join(tmpdir(), "cwh-resv-"));
    const outputsDir = join(base, "outputs");
    mkdirSync(outputsDir);
    expect(() =>
      buildLaunchPlan(loadSession({ folders: [{ from: outputsDir }] }), gated, mkdtempSync(join(tmpdir(), "cwh-o-")), "container"),
    ).toThrow(/reserved Cowork mount/);
  });
});
