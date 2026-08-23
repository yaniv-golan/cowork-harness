import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSessionFingerprint, sessionFingerprintDrift, CASSETTE_VERSION, type Cassette } from "../src/run/cassette.js";

// Finding 23: a session-SHAPE fingerprint (connected folders/plugin/skill/mcp discovery config/egress
// allowlist), distinct from `fingerprint.skillHash` (skill/plugin FILE content). Checked ONLY by
// `verify-cassettes`, never the default replay verdict — see cmdVerifyCassettes' own wiring.

describe("buildSessionFingerprint (function-level)", () => {
  it("undefined for an inline scenario — nothing to hash, never a false mismatch", () => {
    expect(buildSessionFingerprint("(inline)")).toBeUndefined();
  });

  it("undefined when the session file can't be resolved", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-sfp-"));
    expect(buildSessionFingerprint("nope.yaml", d)).toBeUndefined();
  });

  it("undefined on unparsable session YAML — never throws", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-sfp-"));
    writeFileSync(join(d, "s.yaml"), "folders: [unterminated\n");
    expect(() => buildSessionFingerprint("s.yaml", d)).not.toThrow();
    expect(buildSessionFingerprint("s.yaml", d)).toBeUndefined();
  });

  it("is deterministic — two identical session files (same folder) hash the same", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-sfp-det-"));
    const folder = join(d, "proj");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(d, "s1.yaml"), `folders:\n  - from: ${folder}\n`);
    writeFileSync(join(d, "s2.yaml"), `folders:\n  - from: ${folder}\n`);
    const a = buildSessionFingerprint("s1.yaml", d);
    const b = buildSessionFingerprint("s2.yaml", d);
    expect(a).toBeDefined();
    expect(a).toEqual(b);
  });

  it("array authoring ORDER doesn't move the hash (sorted before hashing)", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-sfp-order-"));
    const fa = join(d, "a");
    const fb = join(d, "b");
    mkdirSync(fa, { recursive: true });
    mkdirSync(fb, { recursive: true });
    writeFileSync(join(d, "s1.yaml"), `folders:\n  - from: ${fa}\n  - from: ${fb}\n`);
    writeFileSync(join(d, "s2.yaml"), `folders:\n  - from: ${fb}\n  - from: ${fa}\n`);
    expect(buildSessionFingerprint("s1.yaml", d)).toEqual(buildSessionFingerprint("s2.yaml", d));
  });

  it("a changed folder set changes the hash", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-sfp-change-"));
    const fa = join(d, "a");
    const fb = join(d, "b");
    mkdirSync(fa, { recursive: true });
    mkdirSync(fb, { recursive: true });
    writeFileSync(join(d, "s1.yaml"), `folders:\n  - from: ${fa}\n`);
    writeFileSync(join(d, "s2.yaml"), `folders:\n  - from: ${fb}\n`);
    expect(buildSessionFingerprint("s1.yaml", d)).not.toEqual(buildSessionFingerprint("s2.yaml", d));
  });

  it("an egress-allowlist widening changes the hash even with an unchanged folder set", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-sfp-egress-"));
    const fa = join(d, "a");
    mkdirSync(fa, { recursive: true });
    writeFileSync(join(d, "s1.yaml"), `folders:\n  - from: ${fa}\n`);
    writeFileSync(join(d, "s2.yaml"), `folders:\n  - from: ${fa}\negress:\n  unrestricted: true\n`);
    expect(buildSessionFingerprint("s1.yaml", d)).not.toEqual(buildSessionFingerprint("s2.yaml", d));
  });

  it("is RELOCATABLE — a relative path hashes identically from two different checkout dirs (dev ≠ CI)", () => {
    // The regression this guards: hashing the RESOLVED (absolutized) shape baked the checkout prefix into
    // the digest, so a cassette recorded under /Users/… could never match the same session verified under
    // a git worktree or CI's /home/runner/…. The authored relative shape must be prefix-independent.
    const yaml = `folders:\n  - from: ./proj\nplugins:\n  local_plugins:\n    - ./skills/x\n`;
    const d1 = mkdtempSync(join(tmpdir(), "cwh-sfp-reloc-a-"));
    const d2 = mkdtempSync(join(tmpdir(), "cwh-sfp-reloc-b-"));
    writeFileSync(join(d1, "s.yaml"), yaml);
    writeFileSync(join(d2, "s.yaml"), yaml);
    const a = buildSessionFingerprint("s.yaml", d1);
    const b = buildSessionFingerprint("s.yaml", d2);
    expect(a).toBeDefined();
    expect(a).toEqual(b); // identical authored shape at two different absolute prefixes ⇒ identical hash
  });

  it("a default session (no agent_env) hashes IDENTICALLY to one authored before the field existed", () => {
    // `agent_env` is folded into the shape ONLY when non-default, so every existing session's fingerprint
    // stays byte-stable across this change — a knob-less session must not move.
    const d = mkdtempSync(join(tmpdir(), "cwh-sfp-agentenv-default-"));
    const folder = join(d, "proj");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(d, "s1.yaml"), `folders:\n  - from: ${folder}\n`);
    writeFileSync(join(d, "s2.yaml"), `folders:\n  - from: ${folder}\nagent_env: {}\n`);
    expect(buildSessionFingerprint("s1.yaml", d)).toEqual(buildSessionFingerprint("s2.yaml", d));
  });

  it("a knob-bearing session's hash DIFFERS from the same session without agent_env", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-sfp-agentenv-diff-"));
    const folder = join(d, "proj");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(d, "s1.yaml"), `folders:\n  - from: ${folder}\n`);
    writeFileSync(join(d, "s2.yaml"), `folders:\n  - from: ${folder}\nagent_env:\n  subagent_model: claude-haiku-x\n`);
    expect(buildSessionFingerprint("s1.yaml", d)).not.toEqual(buildSessionFingerprint("s2.yaml", d));
  });
});

const baseScenario = (session: string) => ({
  name: "t",
  baseline: "latest",
  session,
  fidelity: "container" as const,
  prompt: "hi",
  answers: [],
  expect_denied: [],
  assert: [],
});

describe("sessionFingerprintDrift (function-level)", () => {
  it("a pre-v9 cassette (no sessionFingerprint) is NOT checked — backward-compat", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-sfd-"));
    const cassette = { scenario: baseScenario("(inline)") } as unknown as Cassette;
    expect(sessionFingerprintDrift(cassette, d)).toEqual({ drifted: false });
  });

  it("matching session ⇒ not drifted", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-sfd-match-"));
    const folder = join(d, "proj");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(d, "s.yaml"), `folders:\n  - from: ${folder}\n`);
    const fp = buildSessionFingerprint("s.yaml", d);
    const cassette = { sessionFingerprint: fp, scenario: baseScenario("s.yaml") } as unknown as Cassette;
    expect(sessionFingerprintDrift(cassette, d)).toEqual({ drifted: false });
  });

  it("a changed session (folder swapped, count unchanged) ⇒ drifted", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-sfd-drift-"));
    const folderA = join(d, "a");
    const folderB = join(d, "b");
    mkdirSync(folderA, { recursive: true });
    mkdirSync(folderB, { recursive: true });
    writeFileSync(join(d, "s.yaml"), `folders:\n  - from: ${folderA}\n`);
    const fp = buildSessionFingerprint("s.yaml", d);
    // session changed since record — same folder COUNT, different path.
    writeFileSync(join(d, "s.yaml"), `folders:\n  - from: ${folderB}\n`);
    const cassette = { sessionFingerprint: fp, scenario: baseScenario("s.yaml") } as unknown as Cassette;
    expect(sessionFingerprintDrift(cassette, d)).toEqual({ drifted: true });
  });

  it("current session unresolvable ⇒ can't verify (non-failing note, never a false mismatch)", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-sfd-unres-"));
    const cassette = { sessionFingerprint: "deadbeef", scenario: baseScenario("gone.yaml") } as unknown as Cassette;
    const r = sessionFingerprintDrift(cassette, d);
    expect(r.drifted).toBe(false);
    expect(r.note).toBeDefined();
  });
});

// End-to-end: verify-cassettes hard-fails a v9 session-fingerprint mismatch, and does NOT check a v9
// cassette that simply lacks the (optional) sessionFingerprint field — mirrors
// verify-scenario-drift.test.ts's CLI-level pattern for prompt drift.
const CLI = resolve("dist/cli.js");
function envelope(args: string[], cwd: string): any {
  const r = spawnSync("node", [CLI, ...args, "--output-format", "json"], { encoding: "utf8", cwd });
  return JSON.parse(r.stdout);
}

describe.skipIf(!existsSync(CLI))("verify-cassettes gates on session-fingerprint drift (end-to-end)", () => {
  it("v9 cassette: matching session ⇒ ok:true; changed session ⇒ ok:false (staleness)", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-sfd-e2e-"));
    const folder = join(d, "proj");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(d, "s.yaml"), `folders:\n  - from: ${folder}\n`);
    const fp = buildSessionFingerprint("s.yaml", d);

    const cassettePath = join(d, "c.cassette.json");
    const cassette = {
      cassetteVersion: CASSETTE_VERSION,
      sessionFingerprint: fp,
      scenario: {
        name: "c",
        baseline: "latest",
        session: "s.yaml",
        fidelity: "container",
        prompt: "hi",
        answers: [],
        expect_denied: [],
        assert: [{ result: "success" }],
      },
      events: [JSON.stringify({ type: "result", subtype: "success" })],
    };
    writeFileSync(cassettePath, JSON.stringify(cassette));

    const clean = envelope(["verify-cassettes", cassettePath], d);
    expect(clean.ok).toBe(true);

    // The session drifts (folder swapped) since record — session.yaml still declares exactly one folder.
    const folder2 = join(d, "proj2");
    mkdirSync(folder2, { recursive: true });
    writeFileSync(join(d, "s.yaml"), `folders:\n  - from: ${folder2}\n`);
    const drifted = envelope(["verify-cassettes", cassettePath], d);
    expect(drifted.ok).toBe(false);
    expect(drifted.results[0].staleness.some((s: string) => /session-shape fingerprint/.test(s))).toBe(true);
  });

  it("v9 cassette (no sessionFingerprint) is NOT checked even though the session drifted", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-sfd-e2e-v9-"));
    const folder = join(d, "proj");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(d, "s.yaml"), `folders:\n  - from: ${folder}\n`);

    const cassettePath = join(d, "c.cassette.json");
    const cassette = {
      cassetteVersion: 9,
      // no sessionFingerprint — optional field, absent even at the v9 floor (backward-compat within v9+)
      scenario: {
        name: "c",
        baseline: "latest",
        session: "s.yaml",
        fidelity: "container",
        prompt: "hi",
        answers: [],
        expect_denied: [],
        assert: [{ result: "success" }],
      },
      events: [JSON.stringify({ type: "result", subtype: "success" })],
    };
    writeFileSync(cassettePath, JSON.stringify(cassette));

    // Session drifts since record.
    const folder2 = join(d, "proj2");
    mkdirSync(folder2, { recursive: true });
    writeFileSync(join(d, "s.yaml"), `folders:\n  - from: ${folder2}\n`);
    const result = envelope(["verify-cassettes", cassettePath], d);
    expect(result.ok).toBe(true); // never checked — backward-compat
  });
});

// ── O3 / DA#33: `projects[]` is part of the session shape ────────────────────────────────────────────
//
// Two defects, in two different files. `projects[].from` is a host path exactly like `folders[].from`,
// and it was:
//
//   1. the one path field `resolveSessionPaths` skipped — so a RELATIVE project path resolved against the
//      process CWD, not the session file, and the same session mounted different content depending on
//      which directory you invoked from; and
//   2. absent from the session fingerprint — so swapping which directory is mounted at
//      `.projects/<uuid>` changed the run's inputs and `verify-cassettes` reported nothing. A false green
//      in the gate whose entire job is to notice that inputs moved.
//
// Folded in on the same NON-EMPTY-ONLY terms as `agent_env`, so a session without `projects:` hashes
// byte-identically to before. That bound is what keeps the blast radius to sessions that use the feature.

describe("buildSessionFingerprint — projects[] (O3)", () => {
  const w = (dir: string, name: string, body: string) => {
    writeFileSync(join(dir, name), body);
    return dir;
  };

  it("a session with NO projects hashes exactly as it did before the field was folded in", () => {
    // The non-empty bound, stated as a test: this is why the committed corpus and the vast majority of
    // user cassettes do not move. A regression here is a false-stale wave for everyone.
    const d = mkdtempSync(join(tmpdir(), "cwh-sfp-p-"));
    w(d, "s1.yaml", "model: claude-opus-4-8\n");
    w(d, "s2.yaml", "model: claude-opus-4-8\nprojects: []\n");
    // An explicitly-empty `projects: []` must also be a no-op, not a distinct shape.
    expect(buildSessionFingerprint("s1.yaml", d)).toEqual(buildSessionFingerprint("s2.yaml", d));
  });

  it("changing projects[].FROM moves the hash — the false green this closes", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-sfp-p-"));
    w(d, "a.yaml", "model: m\nprojects:\n  - uuid: u1\n    from: ./one\n");
    w(d, "b.yaml", "model: m\nprojects:\n  - uuid: u1\n    from: ./two\n");
    const a = buildSessionFingerprint("a.yaml", d);
    const b = buildSessionFingerprint("b.yaml", d);
    expect(a).toBeDefined();
    expect(a).not.toEqual(b);
  });

  it("changing projects[].UUID moves the hash too — it is the mount path", () => {
    // The AC names both fields deliberately: `uuid` becomes `.projects/<uuid>`, so a change to it
    // relocates the mount even when the content path is untouched.
    const d = mkdtempSync(join(tmpdir(), "cwh-sfp-p-"));
    w(d, "a.yaml", "model: m\nprojects:\n  - uuid: u1\n    from: ./same\n");
    w(d, "b.yaml", "model: m\nprojects:\n  - uuid: u2\n    from: ./same\n");
    expect(buildSessionFingerprint("a.yaml", d)).not.toEqual(buildSessionFingerprint("b.yaml", d));
  });

  it("project ORDER does not move the hash — declaration order is not shape", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-sfp-p-"));
    w(d, "a.yaml", "model: m\nprojects:\n  - uuid: u1\n    from: ./one\n  - uuid: u2\n    from: ./two\n");
    w(d, "b.yaml", "model: m\nprojects:\n  - uuid: u2\n    from: ./two\n  - uuid: u1\n    from: ./one\n");
    expect(buildSessionFingerprint("a.yaml", d)).toEqual(buildSessionFingerprint("b.yaml", d));
  });

  it("the hash stays relocatable — the same session under a different dir hashes equal", () => {
    // Guards the property the function's own comment is built on: authored relative paths are hashed,
    // never absolutized, so a different checkout of the same config still matches.
    const body = "model: m\nprojects:\n  - uuid: u1\n    from: ./one\n";
    const d1 = mkdtempSync(join(tmpdir(), "cwh-sfp-p1-"));
    const d2 = mkdtempSync(join(tmpdir(), "cwh-sfp-p2-"));
    w(d1, "s.yaml", body);
    w(d2, "s.yaml", body);
    expect(buildSessionFingerprint("s.yaml", d1)).toEqual(buildSessionFingerprint("s.yaml", d2));
  });
});

describe("sessionFingerprintDrift — a pre-`projects` recording is UNVERIFIABLE, not clean (O3)", () => {
  const mk = (dir: string, body: string, fp: string): { cassette: Pick<Cassette, "sessionFingerprint" | "scenario">; dir: string } => {
    writeFileSync(join(dir, "s.yaml"), body);
    return { cassette: { sessionFingerprint: fp, scenario: { session: "s.yaml" } as Cassette["scenario"] }, dir };
  };

  it("reports unverifiable — NOT drifted, and NOT a silent all-clear", () => {
    // The subtle part. A hash recorded before `projects` was covered contains nothing about `projects`,
    // so it cannot distinguish "never covered" from "the mount changed since". Reporting `drifted:false`
    // with no signal would put the false green back in the remedy; `unverifiable` says what is true.
    const d = mkdtempSync(join(tmpdir(), "cwh-sfp-mig-"));
    const legacy = buildSessionFingerprint("s.yaml", d, undefined, { omitProjects: true });
    writeFileSync(join(d, "s.yaml"), "model: m\nprojects:\n  - uuid: u1\n    from: ./one\n");
    const legacyOfProjectSession = buildSessionFingerprint("s.yaml", d, undefined, { omitProjects: true });
    expect(legacyOfProjectSession, "the legacy shape must ignore projects entirely").toBeDefined();
    void legacy;

    const { cassette } = mk(d, "model: m\nprojects:\n  - uuid: u1\n    from: ./one\n", legacyOfProjectSession!);
    const r = sessionFingerprintDrift(cassette, d);
    expect(r.drifted, "a coverage gap is not drift").toBe(false);
    expect(r.unverifiable, "and it must not read as verified-clean").toBe(true);
    expect(r.note).toMatch(/recorded before `projects`/);
  });

  it("a REAL change outside projects is still hard drift, not excused by the new branch", () => {
    // The counterweight: the unverifiable branch must not become a blanket amnesty. If the pre-projects
    // shape ALSO mismatches, something covered actually changed.
    const d = mkdtempSync(join(tmpdir(), "cwh-sfp-mig-"));
    writeFileSync(join(d, "s.yaml"), "model: m\nprojects:\n  - uuid: u1\n    from: ./one\n");
    const { cassette } = mk(d, "model: m\nprojects:\n  - uuid: u1\n    from: ./one\negress:\n  unrestricted: true\n", "0".repeat(64));
    const r = sessionFingerprintDrift(cassette, d);
    expect(r.drifted).toBe(true);
    expect(r.unverifiable).toBeFalsy();
  });

  it("a post-`projects` recording that still matches is plain clean", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-sfp-mig-"));
    writeFileSync(join(d, "s.yaml"), "model: m\nprojects:\n  - uuid: u1\n    from: ./one\n");
    const fp = buildSessionFingerprint("s.yaml", d)!;
    const r = sessionFingerprintDrift({ sessionFingerprint: fp, scenario: { session: "s.yaml" } as Cassette["scenario"] }, d);
    expect(r).toEqual({ drifted: false });
  });
});

describe("the staleness message and the doc that quotes it", () => {
  /**
   * `docs/cassette.md` quotes this message verbatim, and the two had drifted: the doc listed `projects`
   * while the message did not, so the most user-visible enumeration of the fingerprint's field set was
   * wrong in one place and misquoted in the other. Human-readable text is explicitly NOT a compatibility
   * surface (SPEC §12), so this pins the doc to the code for the repo's own sake — not as a contract.
   */
  it("docs/cassette.md quotes the message the code actually emits", () => {
    const flat = (s: string) => s.replace(/\s+/g, " ");
    const src = readFileSync(join(process.cwd(), "src/run/cassette.ts"), "utf8");
    const msg = /"(session-shape fingerprint differs[^"]*)"/.exec(src)?.[1];
    expect(msg, "the staleness message moved or was reworded — update this extractor").toBeTruthy();
    const doc = flat(readFileSync(join(process.cwd(), "docs/cassette.md"), "utf8"));
    expect(doc).toContain(flat(msg!));
  });
});
