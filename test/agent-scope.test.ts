import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hashSkillDirs, hashSharedOnly } from "../src/run/skill-hash.js";
import { buildFingerprint, checkStaleness, CASSETTE_VERSION, type Cassette } from "../src/run/cassette.js";
import { loadBaseline } from "../src/baseline.js";

// Dynamic so a baseline bump keeps the green round-trip stable (checkStaleness compares the record's
// baseline to loadBaseline("latest").appVersion — record AT latest).
const LIVE_BASELINE = loadBaseline("latest").appVersion;

// Opt-in per-skill agent scoping (COWORK_HARNESS_AGENT_SCOPE=skill): a skill-named `agents/<n>.md` is treated
// as skill <n>'s private hash input rather than a fleet-wide shared root. OFF by default → byte-identical to
// the legacy behavior (covered by skill-hash*.test.ts). These tests cover the ON behavior.

/** Build a plugin-root: skills/cap-table, skills/other, and three agent contracts. */
function pluginRoot(agentBodies: { capTable: string; other: string; generic: string }): string {
  const root = mkdtempSync(join(tmpdir(), "as-"));
  for (const s of ["cap-table", "other"]) {
    mkdirSync(join(root, "skills", s), { recursive: true });
    writeFileSync(join(root, "skills", s, "SKILL.md"), `# ${s}\n`);
  }
  mkdirSync(join(root, "agents"), { recursive: true });
  writeFileSync(join(root, "agents", "cap-table.md"), agentBodies.capTable);
  writeFileSync(join(root, "agents", "other.md"), agentBodies.other);
  writeFileSync(join(root, "agents", "helper.md"), agentBodies.generic); // NOT a skill name → stays shared
  return root;
}

const base = { capTable: "cap v1\n", other: "other v1\n", generic: "helper v1\n" };

function scopedHash(root: string, skill: string): string {
  return hashSkillDirs([root], [skill]).hash;
}

afterEach(() => {
  delete process.env.COWORK_HARNESS_AGENT_SCOPE;
});

describe("agent scoping OFF (default) — agents/ is a fleet-wide shared root", () => {
  it("editing any agent re-stales EVERY scope (no marker)", () => {
    const a = pluginRoot(base);
    const b = pluginRoot({ ...base, capTable: "cap v2\n" });
    // cap-table's agent changed → BOTH scopes' hashes differ (shared root)
    expect(scopedHash(a, "cap-table")).not.toBe(scopedHash(b, "cap-table"));
    expect(scopedHash(a, "other")).not.toBe(scopedHash(b, "other"));
    expect(hashSkillDirs([a], ["cap-table"]).agentScoped).toBe(false);
  });
});

describe("agent scoping ON — a skill-named agent is private to its skill", () => {
  it("editing agents/cap-table.md re-stales ONLY the cap-table scope, not other", () => {
    process.env.COWORK_HARNESS_AGENT_SCOPE = "skill";
    const a = pluginRoot(base);
    const b = pluginRoot({ ...base, capTable: "cap v2\n" });
    expect(scopedHash(a, "cap-table")).not.toBe(scopedHash(b, "cap-table")); // its own skill: changed
    expect(scopedHash(a, "other")).toBe(scopedHash(b, "other")); // a DIFFERENT skill: unchanged ✓ the whole point
    expect(hashSkillDirs([a], ["cap-table"]).agentScoped).toBe(true);
  });

  it("editing agents/other.md re-stales ONLY the other scope, not cap-table", () => {
    process.env.COWORK_HARNESS_AGENT_SCOPE = "skill";
    const a = pluginRoot(base);
    const b = pluginRoot({ ...base, other: "other v2\n" });
    expect(scopedHash(a, "other")).not.toBe(scopedHash(b, "other"));
    expect(scopedHash(a, "cap-table")).toBe(scopedHash(b, "cap-table"));
  });

  it("a NON-skill-named agent (agents/helper.md) stays SHARED — re-stales every scope", () => {
    process.env.COWORK_HARNESS_AGENT_SCOPE = "skill";
    const a = pluginRoot(base);
    const b = pluginRoot({ ...base, generic: "helper v2\n" });
    expect(scopedHash(a, "cap-table")).not.toBe(scopedHash(b, "cap-table"));
    expect(scopedHash(a, "other")).not.toBe(scopedHash(b, "other"));
  });

  it("the shared-bucket (hashSharedOnly) EXCLUDES skill-named agents but keeps generic ones", () => {
    process.env.COWORK_HARNESS_AGENT_SCOPE = "skill";
    const a = pluginRoot(base);
    const editSkillAgent = pluginRoot({ ...base, capTable: "cap v2\n" });
    const editGenericAgent = pluginRoot({ ...base, generic: "helper v2\n" });
    // editing a skill-named agent must NOT move the shared bucket (it's attributed to the skill now)
    expect(hashSharedOnly([a])).toBe(hashSharedOnly([editSkillAgent]));
    // editing a generic agent DOES move the shared bucket (still shared)
    expect(hashSharedOnly([a])).not.toBe(hashSharedOnly([editGenericAgent]));
  });

  it("a non-scoped hash (no skills:) is unaffected by the env — agentScoped is false", () => {
    process.env.COWORK_HARNESS_AGENT_SCOPE = "skill";
    const a = pluginRoot(base);
    expect(hashSkillDirs([a]).agentScoped).toBe(false); // no scopeSkills → scoping doesn't apply
  });
});

// Migration safety: the fingerprint `agentScope` marker makes an env flip an HONEST re-record, and keeps
// existing (env-off) cassettes byte-clean.
function sessionTree(): { root: string; session: string } {
  const root = mkdtempSync(join(tmpdir(), "as-fp-"));
  const plugin = join(root, "plugin");
  mkdirSync(join(plugin, "skills", "cap-table"), { recursive: true });
  writeFileSync(join(plugin, "skills", "cap-table", "SKILL.md"), "# cap-table\n");
  mkdirSync(join(plugin, "agents"), { recursive: true });
  writeFileSync(join(plugin, "agents", "cap-table.md"), "cap agent v1\n");
  const session = join(root, "session.yaml");
  writeFileSync(session, "skills:\n  local: [./plugin]\n");
  return { root, session };
}
const cassetteFor = (fp: ReturnType<typeof buildFingerprint>): Cassette =>
  ({
    fingerprint: fp,
    cassetteVersion: 99,
    scenario: { session: "session.yaml", skills: ["cap-table"], name: "t" },
  }) as unknown as Cassette;

describe("agentScope fingerprint marker (migration)", () => {
  it("records the marker only when env-on (existing env-off cassettes stay byte-clean)", () => {
    const { root, session } = sessionTree();
    delete process.env.COWORK_HARNESS_AGENT_SCOPE;
    expect(buildFingerprint(session, LIVE_BASELINE, root, ["cap-table"]).agentScope).toBeUndefined();
    process.env.COWORK_HARNESS_AGENT_SCOPE = "skill";
    expect(buildFingerprint(session, LIVE_BASELINE, root, ["cap-table"]).agentScope).toBe("skill");
  });

  it("an env flip between record and verify is an honest re-record (not a misleading content diff)", () => {
    const { root, session } = sessionTree();
    process.env.COWORK_HARNESS_AGENT_SCOPE = "skill";
    const recorded = buildFingerprint(session, LIVE_BASELINE, root, ["cap-table"]); // record env-ON
    delete process.env.COWORK_HARNESS_AGENT_SCOPE; // verify env-OFF
    const msgs = checkStaleness(cassetteFor(recorded), root);
    expect(msgs.join(" ")).toMatch(/agent-scope .* re-record under the same setting/);
  });

  it("same env on both sides + unchanged tree ⇒ green", () => {
    const { root, session } = sessionTree();
    process.env.COWORK_HARNESS_AGENT_SCOPE = "skill";
    const fp = buildFingerprint(session, LIVE_BASELINE, root, ["cap-table"]);
    expect(checkStaleness(cassetteFor(fp), root)).toEqual([]);
  });
});

describe("directory agents/<name> is attributed without extension strip", () => {
  function pluginWithDirAgent(): string {
    const root = mkdtempSync(join(tmpdir(), "as-dir-"));
    for (const s of ["cap-table.v2", "other"]) {
      mkdirSync(join(root, "skills", s), { recursive: true });
      writeFileSync(join(root, "skills", s, "SKILL.md"), `# ${s}\n`);
    }
    mkdirSync(join(root, "agents", "cap-table.v2"), { recursive: true });
    writeFileSync(join(root, "agents", "cap-table.v2", "system.md"), "agent v1\n");
    mkdirSync(join(root, "agents", "other"), { recursive: true });
    writeFileSync(join(root, "agents", "other", "system.md"), "other agent v1\n");
    return root;
  }

  afterEach(() => {
    delete process.env.COWORK_HARNESS_AGENT_SCOPE;
  });

  it("with scoping ON, editing agents/cap-table.v2/ re-stales only cap-table.v2 scope, not other", () => {
    process.env.COWORK_HARNESS_AGENT_SCOPE = "skill";
    const a = pluginWithDirAgent();
    const b = pluginWithDirAgent();
    writeFileSync(join(b, "agents", "cap-table.v2", "system.md"), "agent v2\n");
    const hashA_ct = hashSkillDirs([a], ["cap-table.v2"]).hash;
    const hashB_ct = hashSkillDirs([b], ["cap-table.v2"]).hash;
    const hashA_other = hashSkillDirs([a], ["other"]).hash;
    const hashB_other = hashSkillDirs([b], ["other"]).hash;
    expect(hashA_ct).not.toBe(hashB_ct); // cap-table.v2 scope detects the change
    expect(hashA_other).toBe(hashB_other); // other scope is unaffected
  });

  it("a FILE agents/cap-table.md still maps to cap-table (no regression)", () => {
    process.env.COWORK_HARNESS_AGENT_SCOPE = "skill";
    const root = mkdtempSync(join(tmpdir(), "as-file-"));
    mkdirSync(join(root, "skills", "cap-table"), { recursive: true });
    writeFileSync(join(root, "skills", "cap-table", "SKILL.md"), "# cap-table\n");
    mkdirSync(join(root, "agents"), { recursive: true });
    writeFileSync(join(root, "agents", "cap-table.md"), "v1\n");

    const a = root;
    const b = mkdtempSync(join(tmpdir(), "as-file-b-"));
    mkdirSync(join(b, "skills", "cap-table"), { recursive: true });
    writeFileSync(join(b, "skills", "cap-table", "SKILL.md"), "# cap-table\n");
    mkdirSync(join(b, "agents"), { recursive: true });
    writeFileSync(join(b, "agents", "cap-table.md"), "v2\n");

    const hashA = hashSkillDirs([a], ["cap-table"]).hash;
    const hashB = hashSkillDirs([b], ["cap-table"]).hash;
    expect(hashA).not.toBe(hashB); // file agent still scoped to cap-table
  });
});

describe("v6 cassette with skillHash mismatch reports older-format message", () => {
  it("a v6 cassette with a mismatched skillHash surfaces the older-hash-format message, not content-changed", () => {
    const { root, session } = (() => {
      const r = mkdtempSync(join(tmpdir(), "v6-mig-"));
      const plugin = join(r, "plugin");
      mkdirSync(join(plugin, "skills", "cap-table"), { recursive: true });
      writeFileSync(join(plugin, "skills", "cap-table", "SKILL.md"), "# cap-table\n");
      const s = join(r, "session.yaml");
      writeFileSync(s, "skills:\n  local: [./plugin]\n");
      return { root: r, session: s };
    })();
    // Build a live fingerprint (v7 algo), then wrap it in a v6 cassette to simulate a pre-upgrade cassette.
    const liveFp = buildFingerprint(session, LIVE_BASELINE, root, ["cap-table"]);
    const v6Cassette: Cassette = {
      fingerprint: { ...liveFp, skillHash: "deadbeef00000000" }, // mismatched to trigger drift
      cassetteVersion: 6, // one version behind
      scenario: { session: "session.yaml", skills: ["cap-table"], name: "t" },
    } as unknown as Cassette;
    const msgs = checkStaleness(v6Cassette, root);
    // Must say "older hash format" referencing v6 → current, NOT "content changed"
    expect(msgs.join(" ")).toMatch(new RegExp("older hash format.*v6.*v" + String(CASSETTE_VERSION)));
  });
});
