import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAgentSearchGates, AGENT_SEARCH_GATE_KEYS } from "../src/sync/agent-search-gates.js";
import { AgentSearchGates } from "../src/types.js";

function sessionsDir(files: { org: string; session: string; features: Record<string, unknown>; mtime: number }[]): string {
  const root = mkdtempSync(join(tmpdir(), "cwh-gb-"));
  for (const f of files) {
    const d = join(root, f.org, f.session);
    mkdirSync(d, { recursive: true });
    const p = join(d, "cowork-gb-cache.json");
    writeFileSync(p, JSON.stringify({ claudeJsonFilename: ".claude.json", cachedGrowthBookFeatures: { other_flag: 1, ...f.features } }));
    utimesSync(p, f.mtime, f.mtime);
  }
  return root;
}

describe("readAgentSearchGates", () => {
  it("records the four keys' raw values from the newest cache file, and nothing else", () => {
    const dir = sessionsDir([
      { org: "o1", session: "s1", mtime: 1000, features: { tengu_plum_vx3: false } },
      {
        org: "o1",
        session: "s2",
        mtime: 2000,
        features: { tengu_plum_vx3: true, tengu_sleepy_shore: { enabled: true }, tengu_buzzing_pike: 0 },
      },
    ]);
    const r = readAgentSearchGates(dir);
    expect(r).toEqual({
      observed: true,
      files: 2,
      newestDate: new Date(2000 * 1000).toISOString().slice(0, 10),
      values: { tengu_plum_vx3: true, tengu_sleepy_shore: { enabled: true }, tengu_buzzing_pike: 0 },
      absent: ["tengu_gzip_request_bodies"],
      disagreeing: ["tengu_plum_vx3"],
    });
    expect(AgentSearchGates.safeParse(r).success).toBe(true);
    expect(JSON.stringify(r)).not.toContain("other_flag");
    expect(JSON.stringify(r)).not.toMatch(/o1|s1|s2/); // no session or org identifiers
  });

  it("names exactly the four search gates", () => {
    expect([...AGENT_SEARCH_GATE_KEYS].sort()).toEqual(
      ["tengu_buzzing_pike", "tengu_gzip_request_bodies", "tengu_plum_vx3", "tengu_sleepy_shore"].sort(),
    );
  });

  it("is unobserved when no cache file exists", () => {
    expect(readAgentSearchGates(mkdtempSync(join(tmpdir(), "cwh-gb-")))).toEqual({ observed: false });
    expect(readAgentSearchGates(join(tmpdir(), "cwh-gb-does-not-exist"))).toEqual({ observed: false });
  });

  it("skips an unreadable cache file and counts only the readable ones", () => {
    const dir = sessionsDir([{ org: "o", session: "s", mtime: 1000, features: { tengu_plum_vx3: true } }]);
    mkdirSync(join(dir, "o", "bad"), { recursive: true });
    writeFileSync(join(dir, "o", "bad", "cowork-gb-cache.json"), "{not json");
    const r = readAgentSearchGates(dir);
    expect(r.observed && r.files).toBe(1);
  });

  it("withholds an oversized value rather than publishing it", () => {
    const dir = sessionsDir([{ org: "o", session: "s", mtime: 1000, features: { tengu_sleepy_shore: { blob: "x".repeat(2000) } } }]);
    const r = readAgentSearchGates(dir);
    expect(r.observed && r.values).not.toHaveProperty("tengu_sleepy_shore");
    expect(r.observed && r.withheld).toEqual(["tengu_sleepy_shore"]);
    expect(AgentSearchGates.safeParse(r).success).toBe(true);
  });

  it("withholds a string value, and an object holding a string, since either could carry an identifier", () => {
    const dir = sessionsDir([
      {
        org: "o",
        session: "s",
        mtime: 1000,
        features: { tengu_plum_vx3: "org-1234", tengu_sleepy_shore: { id: "abc" }, tengu_buzzing_pike: 3 },
      },
    ]);
    const r = readAgentSearchGates(dir);
    expect(r.observed && r.values).toEqual({ tengu_buzzing_pike: 3 });
    expect(r.observed && r.withheld).toEqual(["tengu_plum_vx3", "tengu_sleepy_shore"]);
    expect(AgentSearchGates.safeParse(r).success).toBe(true);
    expect(AgentSearchGates.safeParse({ ...r, values: { tengu_plum_vx3: "org-1234" } }).success).toBe(false);
  });

  it("does not call a key disagreeing when the newest file lacks it", () => {
    const dir = sessionsDir([
      { org: "o", session: "old", mtime: 1000, features: { tengu_plum_vx3: true } },
      { org: "o", session: "new", mtime: 2000, features: {} },
    ]);
    const r = readAgentSearchGates(dir);
    expect(r.observed && r.disagreeing).toBeUndefined();
    expect(r.observed && r.absent).toContain("tengu_plum_vx3");
  });
});
