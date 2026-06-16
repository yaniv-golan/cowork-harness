import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGrantMap, verifyGrants } from "../src/canary/grants.js";

describe("B2 — sub-agent grant canary (runs in the failing `unit` CI lane)", () => {
  it("the committed grant map is well-formed; any drift is a red snapshot diff", () => {
    const map = loadGrantMap();
    expect(map && typeof map === "object").toBe(true);
    for (const [k, v] of Object.entries(map)) {
      expect(typeof k).toBe("string");
      expect(Array.isArray(v)).toBe(true);
    }
    expect(map).toMatchSnapshot(); // sync refreshes the committed map → this diff flags an RC grant change
  });

  it("verifyGrants flags a declared-tools drift and ignores unknown agentTypes", () => {
    const drift = verifyGrants([{ agentType: "researcher", declaredTools: ["Bash"] }], { researcher: ["Bash", "Read"] });
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ agentType: "researcher", expected: ["Bash", "Read"], actual: ["Bash"] });
    expect(verifyGrants([{ agentType: "unknown-x", declaredTools: [] }], { researcher: ["Bash"] })).toHaveLength(0);
  });

  it("#44 — loadGrantMap THROWS on a corrupt fixture instead of silently disabling drift detection", () => {
    const dir = mkdtempSync(join(tmpdir(), "grants-"));
    const bad = join(dir, "subagent-grants.json");
    writeFileSync(bad, "{ not valid json", "utf8");
    expect(() => loadGrantMap(bad)).toThrow(/corrupt subagent-grants fixture/);

    // A well-formed file missing the `.grants` object must also throw, not coerce to an empty map.
    const noGrants = join(dir, "no-grants.json");
    writeFileSync(noGrants, JSON.stringify({ other: 1 }), "utf8");
    expect(() => loadGrantMap(noGrants)).toThrow(/missing or non-object/);
  });
});
