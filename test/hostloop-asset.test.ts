import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BASELINES_DIR, loadBaseline, cmpVersionStrings } from "../src/baseline.js";

/** First Desktop release that builds the host-loop "## Shell access" section dynamically (mirrors
 *  HOSTLOOP_DYNAMIC_PROMPT_MIN_VERSION in src/runtime/hostloop.ts). At/above this version there is
 *  intentionally NO static host-loop-append.md — the section is generated from mount state and tested
 *  byte-for-byte in test/hostloop-prompt.test.ts. */
const DYNAMIC_MIN = "1.14271.0";
/** First release that modeled host-loop with a static prompt asset (the earliest baselines/prompts/
 *  desktop-* dir). Baselines older than this predate the convention — they ship no asset and, if pinned
 *  for host-loop, hit the deliberate missing-asset error (gated by COWORK_HARNESS_ALLOW_MISSING_PROMPT). */
const HOSTLOOP_ASSET_MIN = "1.12603.1";

const isLegacy = (appVersion: string) => cmpVersionStrings(appVersion, DYNAMIC_MIN) < 0;
const inStaticAssetRange = (appVersion: string) => cmpVersionStrings(appVersion, HOSTLOOP_ASSET_MIN) >= 0 && isLegacy(appVersion);

/** F-3: for static-asset-era baselines ([1.12603.1, 1.14271.0)) the host-loop shell-access section is
 *  read from baselines/prompts/desktop-<appVersion>/host-loop-append.md and appended to the system prompt
 *  in the host-loop tier. A missing asset means an EMPTY shell section — a silent fidelity gap. Guard it. */
describe("F-3: host-loop prompt asset for static-asset-era baselines", () => {
  const staticAssetBaselines = readdirSync(BASELINES_DIR)
    .filter((f) => f.startsWith("desktop-") && f.endsWith(".json"))
    .map((f) => f.replace(/^desktop-/, "").replace(/\.json$/, ""))
    .filter(inStaticAssetRange);

  it.each(staticAssetBaselines)("desktop-%s ships a non-empty host-loop-append.md with self-heal guidance", (appVersion) => {
    const asset = join(BASELINES_DIR, "prompts", `desktop-${appVersion}`, "host-loop-append.md");
    expect(existsSync(asset)).toBe(true);
    const body = readFileSync(asset, "utf8");
    expect(body.trim().length).toBeGreaterThan(0);
    expect(body).toContain("mcp__workspace__bash");
    expect(body).toContain("{{vmMnt}}");
    expect(body).toContain("CLAUDE_PLUGIN_ROOT");
  });
});

/** Generator era: the latest baseline must NOT depend on a static asset — it is rendered in code.
 *  This is the inverse invariant of the legacy guard above, keeping the version gate coherent. */
describe("generator-era host-loop section (>= 1.14271.0)", () => {
  it("the latest baseline is generator-era (no static asset required)", () => {
    const latest = loadBaseline("latest");
    expect(isLegacy(latest.appVersion)).toBe(false);
  });
});
