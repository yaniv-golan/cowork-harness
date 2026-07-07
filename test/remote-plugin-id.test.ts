import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBaseline } from "../src/baseline.js";
import { loadSession, buildLaunchPlan, resolveSessionPaths } from "../src/session.js";

// Migrated Cowork serves UI-uploaded plugins from `.remote-plugins/plugin_<ULID>` (live probe + asar
// migration), NOT `.remote-plugins/<basename>`. The mount leaf is a stable synthetic id derived from the
// DECLARED source string (pre-absolutization), carried through `resolveSessionPaths` so it stays relocatable
// across machines/checkouts; unique per distinct source.
const baseline = loadBaseline("desktop-1.11847.5");

// Inline session (no resolveSessionPaths) — the id falls back to hashing the given string directly.
function remoteMount(declared: string) {
  const out = mkdtempSync(join(tmpdir(), "cowork-rp-out-"));
  const plan = buildLaunchPlan(loadSession({ plugins: { remote_plugins: [declared] } }), baseline, out);
  return plan.mounts.find((m) => m.mountPath.startsWith(".remote-plugins/"));
}

// File-loaded session — declared paths are absolutized against `root`, but the id must still derive from the
// declared string (via `_remotePluginIds`), so it's relocatable.
function remoteMountResolvedFrom(root: string, declared: string) {
  const out = mkdtempSync(join(tmpdir(), "cowork-rp-out-"));
  const session = resolveSessionPaths(loadSession({ plugins: { remote_plugins: [declared] } }), root);
  const plan = buildLaunchPlan(session, baseline, out);
  return plan.mounts.find((m) => m.mountPath.startsWith(".remote-plugins/"));
}

describe("remote_plugins → .remote-plugins/plugin_<synthID>", () => {
  it("mounts under plugin_<24 base62 chars>, matching the observed opaque shape (not a canonical ULID)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cowork-rp-"));
    const m = remoteMount(dir);
    expect(m).toBeTruthy();
    expect(m!.mountPath).toMatch(/^\.remote-plugins\/plugin_[0-9A-Za-z]{24}$/);
  });

  it("the id is DETERMINISTIC in the declared source string (stable across builds)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cowork-rp-"));
    expect(remoteMount(dir)!.mountPath).toBe(remoteMount(dir)!.mountPath);
  });

  it("two DIFFERENT declared sources sharing a basename get DIFFERENT ids (fixes the basename collision)", () => {
    const base = mkdtempSync(join(tmpdir(), "cowork-rp-"));
    const p1 = join(base, "a", "plug");
    const p2 = join(base, "b", "plug"); // same basename `plug`, different declared string
    mkdirSync(p1, { recursive: true });
    mkdirSync(p2, { recursive: true });
    expect(remoteMount(p1)!.mountPath).not.toBe(remoteMount(p2)!.mountPath);
  });

  it("is RELOCATABLE — the SAME relative declaration resolved under two different roots yields the SAME id", () => {
    // Pre-fix this failed: the id hashed the absolutized path (rootA/plug vs rootB/plug → different ids).
    // The declared string `./plug` is identical in both, so a relocatable id must match.
    const rootA = mkdtempSync(join(tmpdir(), "cowork-rp-rootA-"));
    const rootB = mkdtempSync(join(tmpdir(), "cowork-rp-rootB-"));
    mkdirSync(join(rootA, "plug"), { recursive: true });
    mkdirSync(join(rootB, "plug"), { recursive: true });
    const a = remoteMountResolvedFrom(rootA, "./plug");
    const b = remoteMountResolvedFrom(rootB, "./plug");
    expect(a!.mountPath).toMatch(/^\.remote-plugins\/plugin_[0-9A-Za-z]{24}$/);
    expect(a!.mountPath).toBe(b!.mountPath);
  });

  it("the mount is exposed as a --plugin-dir (plan.pluginDirs carries the same leaf)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cowork-rp-"));
    const out = mkdtempSync(join(tmpdir(), "cowork-rp-out-"));
    const plan = buildLaunchPlan(loadSession({ plugins: { remote_plugins: [dir] } }), baseline, out);
    const m = plan.mounts.find((x) => x.mountPath.startsWith(".remote-plugins/"));
    expect(m).toBeTruthy();
    expect(plan.pluginDirs).toContain(m!.mountPath);
  });
});
