import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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
