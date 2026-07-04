import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Gate-id drift tripwire (the cassette-docs-sync pattern): scenario.py's `host-path-assert-cowork`
// WARN embeds the host-loop gate id in offline Python — the linter never reads a baseline, so the
// message carries the gate fact. If Desktop re-keys the gate, PINNED_GATES in cowork-sync.ts is the
// binary-verified pin that gets updated; this test forces the Python copy to move with it instead of
// silently rotting.
describe("scenario.py ↔ cowork-sync.ts host-loop gate-id sync", () => {
  const syncSrc = readFileSync(resolve("src/sync/cowork-sync.ts"), "utf8");
  const lintSrc = readFileSync(resolve(".claude/skills/cowork-harness/scripts/scenario.py"), "utf8");

  it("cowork-sync.ts still pins a hostLoop gate id (sanity — pattern didn't silently stop matching)", () => {
    expect(syncSrc).toMatch(/"\d+":\s*"hostLoop"/);
  });

  it("scenario.py's HOST_LOOP_GATE_ID equals the PINNED_GATES hostLoop id", () => {
    const pinned = syncSrc.match(/"(\d+)":\s*"hostLoop"/)?.[1];
    expect(pinned).toBeDefined();
    const python = lintSrc.match(/HOST_LOOP_GATE_ID\s*=\s*"(\d+)"/)?.[1];
    expect(python, "scenario.py lost its HOST_LOOP_GATE_ID constant").toBeDefined();
    expect(python).toBe(pinned);
  });
});
