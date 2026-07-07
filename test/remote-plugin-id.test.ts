import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBaseline } from "../src/baseline.js";
import { loadSession, buildLaunchPlan } from "../src/session.js";

// Migrated Cowork serves UI-uploaded plugins from `.remote-plugins/plugin_<ULID>` (live probe + asar
// migration), NOT `.remote-plugins/<basename>`. The mount leaf is a stable synthetic id derived from the
// DECLARED source string (relocatable across machines; unique per distinct source).
const baseline = loadBaseline("desktop-1.11847.5");
function remoteMount(declared: string) {
  const out = mkdtempSync(join(tmpdir(), "cowork-rp-out-"));
  const plan = buildLaunchPlan(loadSession({ plugins: { remote_plugins: [declared] } }), baseline, out);
  return plan.mounts.find((m) => m.mountPath.startsWith(".remote-plugins/"));
}

describe("remote_plugins → .remote-plugins/plugin_<synthID>", () => {
  it("mounts under plugin_<24 base62 chars>, matching the observed opaque shape (not a canonical ULID)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cowork-rp-"));
    const m = remoteMount(dir);
    expect(m).toBeTruthy();
    expect(m!.mountPath).toMatch(/^\.remote-plugins\/plugin_[0-9A-Za-z]{24}$/);
  });

  it("the id is DETERMINISTIC in the declared source string (stable across builds → relocatable cassettes)", () => {
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
});
