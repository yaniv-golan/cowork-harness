import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Cassette, computeStaleness, buildFingerprint, replayCassette, CASSETTE_VERSION } from "../src/run/cassette.js";
import { loadBaseline } from "../src/baseline.js";
import type { Fingerprint } from "../src/types.js";

// Coverage for the staleness UNIFICATION (computeStaleness): the gaps the plan called out that the first
// implementation pass left untested — replay carries the per-file detail, a GITSET / agent-scope FLIP is
// classed `format` (not misattributed to skill/shared), non-scoped replay names changed files, and the
// defensive guard for a corrupt fingerprint. The both-buckets masking fix + agentScope path attribution live
// in verify-cassettes.test.ts.

const LIVE = loadBaseline("latest").appVersion;

const origWrite = process.stderr.write.bind(process.stderr);
afterEach(() => {
  process.stderr.write = origWrite;
});
function mute(): void {
  process.stderr.write = (() => true) as typeof process.stderr.write;
}

const okEvents = () => [
  JSON.stringify({ type: "system", subtype: "init", tools: [] }),
  JSON.stringify({ type: "result", subtype: "success", is_error: false }),
];

function scopedRoot(): { root: string; sessionPath: string } {
  const root = mkdtempSync(join(tmpdir(), "cwh-unify-"));
  mkdirSync(join(root, "plugin", "skills", "alpha"), { recursive: true });
  mkdirSync(join(root, "plugin", "scripts"), { recursive: true });
  writeFileSync(join(root, "plugin", "skills", "alpha", "SKILL.md"), "# alpha v1\n");
  writeFileSync(join(root, "plugin", "scripts", "shared.py"), "x = 1\n");
  const sessionPath = join(root, "session.yaml");
  writeFileSync(sessionPath, `skills:\n  local:\n    - ./plugin\n`);
  return { root, sessionPath };
}

function cassetteFor(sessionPath: string, fp: Fingerprint, skills?: string[]): Cassette {
  return {
    cassetteVersion: CASSETTE_VERSION,
    scenario: {
      name: "a",
      baseline: LIVE,
      session: sessionPath,
      fidelity: "container" as const,
      prompt: "hi",
      answers: [],
      expect_denied: [],
      assert: [{ result: "success" }],
      ...(skills ? { skills } : {}),
    },
    events: okEvents(),
    controlOut: [],
    fingerprint: fp,
  } as unknown as Cassette;
}

describe("staleness unification — replay lane inherits the per-file detail", () => {
  it("a scoped replay surfaces the `[N changed (paths)]` detail (not just a bucket label)", async () => {
    mute();
    const { root, sessionPath } = scopedRoot();
    const fp = buildFingerprint(sessionPath, LIVE, root, ["alpha"]);
    writeFileSync(join(root, "plugin", "skills", "alpha", "SKILL.md"), "# alpha v2\n");
    const r = await replayCassette(cassetteFor(sessionPath, fp, ["alpha"]), [], { cassetteDir: root });
    const skillMsg = r.staleness?.find((s) => s.class === "skill");
    expect(skillMsg).toBeDefined();
    expect(skillMsg!.message).toMatch(/\[\d+ changed/); // detail present on the replay lane
    expect(skillMsg!.message).toMatch(/SKILL\.md/);
  });

  it("a NON-scoped replay names the changed files (on the replay lane)", async () => {
    mute();
    const { root, sessionPath } = scopedRoot();
    // No `skills:` ⇒ whole-tree (non-scoped) fingerprint.
    const fp = buildFingerprint(sessionPath, LIVE, root);
    writeFileSync(join(root, "plugin", "skills", "alpha", "SKILL.md"), "# alpha v2\n");
    const r = await replayCassette(cassetteFor(sessionPath, fp), [], { cassetteDir: root });
    const skillMsg = r.staleness?.find((s) => s.class === "skill");
    expect(skillMsg).toBeDefined();
    expect(skillMsg!.message).toMatch(/skill files changed since record/);
    expect(skillMsg!.message).toMatch(/SKILL\.md/); // named, not the generic no-names fallback
  });
});

describe("staleness unification — flips are classed `format`, not skill drift", () => {
  it("an agent-scope FLIP yields a `format` finding, never shared-root/skill", () => {
    const prev = process.env.COWORK_HARNESS_AGENT_SCOPE;
    delete process.env.COWORK_HARNESS_AGENT_SCOPE; // record with agent-scope OFF
    try {
      const { root, sessionPath } = scopedRoot();
      const fp = buildFingerprint(sessionPath, LIVE, root, ["alpha"]);
      process.env.COWORK_HARNESS_AGENT_SCOPE = "skill"; // verify with agent-scope ON ⇒ flip
      const { findings } = computeStaleness(cassetteFor(sessionPath, fp, ["alpha"]), root);
      expect(findings.some((f) => f.class === "format" && /agent-scope/.test(f.message))).toBe(true);
      // regression guard: the flip is NOT misattributed to a skill-source class.
      expect(findings.some((f) => f.class === "shared-root" || f.class === "skill")).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.COWORK_HARNESS_AGENT_SCOPE;
      else process.env.COWORK_HARNESS_AGENT_SCOPE = prev;
    }
    // (The GITSET mode flip takes the identical `format` code path; it needs a real git work-tree to exercise,
    // so the agent-scope axis is the representative regression guard here.)
  });
});

describe("staleness unification — defensive guard", () => {
  it("a corrupt fingerprint (sharedHash set, skillScope missing) does not throw", () => {
    mute();
    const { root, sessionPath } = scopedRoot();
    const fp = buildFingerprint(sessionPath, LIVE, root, ["alpha"]) as Fingerprint & { skillScope?: string[] };
    expect(fp.sharedHash).toBeDefined();
    expect(fp.skillScope).toBeDefined();
    // Simulate a hand-corrupted on-disk cassette: sharedHash present, skillScope absent (the unreachable
    // shape). The `?? []` guard must keep the non-null access sound rather than NPE.
    delete fp.skillScope;
    writeFileSync(join(root, "plugin", "skills", "alpha", "SKILL.md"), "# alpha v2\n"); // force a skillHash diff
    expect(() => computeStaleness(cassetteFor(sessionPath, fp, ["alpha"]), root)).not.toThrow();
  });
});
