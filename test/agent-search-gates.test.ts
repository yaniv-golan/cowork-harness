import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAgentSearchGates, AGENT_SEARCH_GATE_KEYS } from "../src/sync/agent-search-gates.js";
import { AgentSearchGates } from "../src/types.js";

const ORG = "11111111-2222-3333-4444-555555555555";
const OTHER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

// Desktop keeps one cache per account and organisation: <sessions>/<account>/<org>/cowork-gb-cache.json.
function sessionsDir(files: { account: string; org: string; features: Record<string, unknown>; mtime: number }[]): string {
  const root = mkdtempSync(join(tmpdir(), "cwh-gb-"));
  for (const f of files) {
    const d = join(root, f.account, f.org);
    mkdirSync(d, { recursive: true });
    const p = join(d, "cowork-gb-cache.json");
    writeFileSync(p, JSON.stringify({ claudeJsonFilename: ".claude.json", cachedGrowthBookFeatures: { other_flag: 1, ...f.features } }));
    utimesSync(p, f.mtime, f.mtime);
  }
  return root;
}

describe("readAgentSearchGates", () => {
  it("reads only the capture organisation's cache, even when another organisation's is newer", () => {
    const dir = sessionsDir([
      {
        account: "acct",
        org: ORG,
        mtime: 1000,
        features: { tengu_plum_vx3: true, tengu_sleepy_shore: { enabled: true }, tengu_buzzing_pike: 0 },
      },
      { account: "acct", org: OTHER, mtime: 5000, features: { tengu_plum_vx3: false } },
    ]);
    const r = readAgentSearchGates(dir, ORG);
    expect(r).toEqual({
      observed: true,
      files: 1,
      newestDate: new Date(1000 * 1000).toISOString().slice(0, 10),
      values: { tengu_plum_vx3: true, tengu_sleepy_shore: { enabled: true }, tengu_buzzing_pike: 0 },
      absent: ["tengu_gzip_request_bodies"],
    });
    expect(AgentSearchGates.safeParse(r).success).toBe(true);
    expect(JSON.stringify(r)).not.toContain("other_flag");
    expect(JSON.stringify(r)).not.toMatch(/acct|1111|aaaa/); // no account or organisation identifiers
  });

  it("is unobserved when the capture organisation is unknown, or has no cache", () => {
    const dir = sessionsDir([{ account: "acct", org: OTHER, mtime: 1000, features: { tengu_plum_vx3: true } }]);
    expect(readAgentSearchGates(dir, null)).toEqual({ observed: false });
    expect(readAgentSearchGates(dir, ORG)).toEqual({ observed: false });
    expect(readAgentSearchGates(join(tmpdir(), "cwh-gb-does-not-exist"), ORG)).toEqual({ observed: false });
  });

  it("lists a key two accounts' caches for the organisation hold with different values", () => {
    const dir = sessionsDir([
      { account: "a1", org: ORG, mtime: 1000, features: { tengu_plum_vx3: false } },
      { account: "a2", org: ORG, mtime: 2000, features: { tengu_plum_vx3: true } },
    ]);
    const r = readAgentSearchGates(dir, ORG);
    expect(r.observed && r.values).toEqual({ tengu_plum_vx3: true });
    expect(r.observed && r.disagreeing).toEqual(["tengu_plum_vx3"]);
    expect(r.observed && r.files).toBe(2);
  });

  it("does not call a key disagreeing when the newest cache lacks it", () => {
    const dir = sessionsDir([
      { account: "a1", org: ORG, mtime: 1000, features: { tengu_plum_vx3: true } },
      { account: "a2", org: ORG, mtime: 2000, features: {} },
    ]);
    const r = readAgentSearchGates(dir, ORG);
    expect(r.observed && r.disagreeing).toBeUndefined();
    expect(r.observed && r.absent).toContain("tengu_plum_vx3");
  });

  it("names exactly the four search gates", () => {
    expect([...AGENT_SEARCH_GATE_KEYS].sort()).toEqual(
      ["tengu_buzzing_pike", "tengu_gzip_request_bodies", "tengu_plum_vx3", "tengu_sleepy_shore"].sort(),
    );
  });

  it("skips an unreadable cache and counts only the readable ones", () => {
    const dir = sessionsDir([{ account: "a1", org: ORG, mtime: 1000, features: { tengu_plum_vx3: true } }]);
    mkdirSync(join(dir, "a2", ORG), { recursive: true });
    writeFileSync(join(dir, "a2", ORG, "cowork-gb-cache.json"), "{not json");
    const r = readAgentSearchGates(dir, ORG);
    expect(r.observed && r.files).toBe(1);
  });

  it("withholds an oversized value, a string, and an object holding a string", () => {
    const dir = sessionsDir([
      {
        account: "a",
        org: ORG,
        mtime: 1000,
        features: {
          tengu_plum_vx3: "org-1234",
          tengu_sleepy_shore: { id: "abc" },
          tengu_gzip_request_bodies: { n: 1, big: "x".repeat(400) },
          tengu_buzzing_pike: 3,
        },
      },
    ]);
    const r = readAgentSearchGates(dir, ORG);
    expect(r.observed && r.values).toEqual({ tengu_buzzing_pike: 3 });
    expect(r.observed && r.withheld).toEqual(["tengu_plum_vx3", "tengu_sleepy_shore", "tengu_gzip_request_bodies"]);
    expect(AgentSearchGates.safeParse(r).success).toBe(true);
    expect(AgentSearchGates.safeParse({ ...r, values: { tengu_plum_vx3: "org-1234" } }).success).toBe(false);
  });
});
