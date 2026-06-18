import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BASELINES_DIR, loadBaseline } from "../src/baseline.js";

/** F-3: the host-loop shell-access section is read from baselines/prompts/desktop-<appVersion>/host-loop-append.md
 *  and is appended to the system prompt in the host-loop fidelity tier. If the asset is missing for the ACTIVE
 *  (latest) baseline, every host-loop record runs with an EMPTY shell section — a silent fidelity gap. Guard it:
 *  the latest baseline must ship its asset, and the asset must carry the load-bearing self-heal guidance. */
describe("F-3: host-loop prompt asset for the active baseline", () => {
  const latest = loadBaseline("latest");

  it("the latest baseline ships a non-empty host-loop-append.md", () => {
    const asset = join(BASELINES_DIR, "prompts", `desktop-${latest.appVersion}`, "host-loop-append.md");
    expect(existsSync(asset)).toBe(true);
    const body = readFileSync(asset, "utf8");
    expect(body.trim().length).toBeGreaterThan(0);
  });

  it("the asset carries the path-translation / unmounted-CLAUDE_PLUGIN_ROOT self-heal guidance", () => {
    const asset = join(BASELINES_DIR, "prompts", `desktop-${latest.appVersion}`, "host-loop-append.md");
    const body = readFileSync(asset, "utf8");
    expect(body).toContain("mcp__workspace__bash");
    expect(body).toContain("{{vmMnt}}");
    expect(body).toContain("CLAUDE_PLUGIN_ROOT");
  });
});
