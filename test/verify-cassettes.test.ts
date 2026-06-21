import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Cassette, scanCassette, checkStaleness, buildFingerprint, CASSETTE_VERSION } from "../src/run/cassette.js";

const scenario = (assert: unknown[], prompt = "hi") => ({
  name: "c",
  baseline: "latest",
  session: "(inline)",
  fidelity: "container" as const,
  prompt,
  answers: [],
  expect_denied: [],
  assert,
});

describe("scanCassette — whole-surface privacy scan (A2)", () => {
  it("flags a planted email in events and in an artifact body", () => {
    const c = {
      scenario: scenario([{ result: "success" }]),
      events: [JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "mail eve@evil.com" }] } })],
      artifacts: [{ path: "outputs/x.json", bytes: 10, sha256: "x", body: JSON.stringify({ owner: "frank@corp.com" }) }],
    } as unknown as Cassette;
    const findings = scanCassette(c, []);
    expect(findings.some((f) => f.cls === "email" && /events/.test(f.where))).toBe(true);
    expect(findings.some((f) => f.cls === "email" && /outputs\/x\.json/.test(f.where))).toBe(true);
  });

  it("capability-manifest exclusion: domain/currency suppressed on the agent registry, but FLAGGED in agent reasoning", () => {
    // The two manifest forms: a system/init event (mcp_servers names) and the init-1 registry control_response
    // (slash-command descriptions naming docsend.com). Catalog noise → NOT flagged.
    const manifest = {
      scenario: scenario([{ result: "success" }]),
      events: [
        JSON.stringify({ type: "system", subtype: "init", tools: [], mcp_servers: [{ name: "claude.ai Gmail" }], cwd: "/x" }),
        JSON.stringify({
          type: "control_response",
          response: {
            request_id: "init-1",
            subtype: "success",
            response: { commands: [{ description: "download from docsend.com" }], agents: [] },
          },
        }),
      ],
    } as unknown as Cassette;
    expect(scanCassette(manifest, []).some((f) => f.cls === "domain")).toBe(false);
    // But a domain in an ASSISTANT message (the agent's actual reasoning) IS flagged — full net off the manifest.
    const reasoning = {
      scenario: scenario([{ result: "success" }]),
      events: [JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "pulling the cap table from acme.co" }] } })],
    } as unknown as Cassette;
    expect(scanCassette(reasoning, []).some((f) => f.cls === "domain")).toBe(true);
  });

  it("email is scanned EVEN on the capability manifest (the registry `account` field can carry the dev's email)", () => {
    const c = {
      scenario: scenario([{ result: "success" }]),
      events: [
        JSON.stringify({
          type: "control_response",
          response: {
            request_id: "init-1",
            subtype: "success",
            response: { commands: [], agents: [], account: { email: "dev@company.com" } },
          },
        }),
      ],
    } as unknown as Cassette;
    expect(scanCassette(c, []).some((f) => f.cls === "email")).toBe(true);
  });

  it("a customer folder mount name in userVisibleRoots is scanned and flagged (metadata-marked)", () => {
    const c = {
      scenario: scenario([{ result: "success" }]),
      events: [JSON.stringify({ type: "result", subtype: "success" })],
      // A connected folder's resolved mount name carrying a customer email — never scanned before.
      userVisibleRoots: ["outputs", ".projects/contact-jane@acme.com"],
    } as unknown as Cassette;
    const findings = scanCassette(c, []);
    const hit = findings.find((f) => f.cls === "email" && /metadata:userVisibleRoots/.test(f.where));
    expect(hit).toBeDefined();
  });

  it("the scenario name and session path metadata are scanned", () => {
    const c = {
      scenario: { ...scenario([{ result: "success" }]), name: "run for boss@corp.com", session: "sessions/owner@corp.com.yaml" },
      events: [JSON.stringify({ type: "result", subtype: "success" })],
    } as unknown as Cassette;
    const findings = scanCassette(c, []);
    expect(findings.some((f) => f.cls === "email" && /metadata:scenario\.name/.test(f.where))).toBe(true);
    expect(findings.some((f) => f.cls === "email" && /metadata:scenario\.session/.test(f.where))).toBe(true);
  });

  it("a clean synthetic cassette → no findings", () => {
    const c = {
      scenario: scenario([{ result: "success" }], "run the cap table for Acme"),
      events: [JSON.stringify({ type: "result", subtype: "success" })],
    } as unknown as Cassette;
    expect(scanCassette(c, [])).toEqual([]);
  });

  it("allowlist suppresses a public/synthetic match", () => {
    const c = {
      scenario: scenario([{ result: "success" }]),
      events: [JSON.stringify({ text: "cite cooley.com for the SAFE" })],
    } as unknown as Cassette;
    expect(scanCassette(c, [/cooley\.com/i]).some((f) => f.cls === "domain")).toBe(false);
  });

  it("F-2: a domain allow does NOT silently clear an email finding (no cross-class bleed)", () => {
    const c = {
      scenario: scenario([{ result: "success" }]),
      events: [JSON.stringify({ text: "reach founder@startup.com or visit startup.com" })],
    } as unknown as Cassette;
    // A bare allow for the domain `startup\.com` used to substring-match (and suppress) the email
    // `founder@startup.com`. After anchoring it clears only the whole-token domain, never the email.
    const f = scanCassette(c, [/startup\.com/i]);
    expect(f.some((x) => x.cls === "email")).toBe(true); // email tripwire stays live
    expect(f.some((x) => x.cls === "domain")).toBe(false); // domain still allowed
  });

  it("F-2: a class-scoped --allow-domain leaves the email class untouched", () => {
    const c = {
      scenario: scenario([{ result: "success" }]),
      events: [JSON.stringify({ text: "reach founder@startup.com or visit startup.com" })],
    } as unknown as Cassette;
    const f = scanCassette(c, [{ cls: "domain", re: /startup\.com/i }]);
    expect(f.some((x) => x.cls === "domain")).toBe(false);
    expect(f.some((x) => x.cls === "email")).toBe(true);
  });

  it("flags PII in an artifact FILENAME / path (C1)", () => {
    const c = {
      scenario: scenario([{ result: "success" }]),
      events: [JSON.stringify({ type: "result", subtype: "success" })],
      artifacts: [{ path: "outputs/eve@evil.com-cap-table.json", bytes: 2, sha256: "x", body: "{}" }],
    } as unknown as Cassette;
    expect(scanCassette(c, []).some((f) => f.cls === "email" && /artifact path/.test(f.where))).toBe(true);
  });

  it("a truncated (uncommitted) artifact body is reported 'unscanned', not a silent pass", () => {
    const c = {
      scenario: scenario([{ result: "success" }]),
      events: [JSON.stringify({ type: "result", subtype: "success" })],
      artifacts: [{ path: "outputs/big.json", bytes: 999999, sha256: "x", truncated: true }],
    } as unknown as Cassette;
    const findings = scanCassette(c, []);
    expect(findings.some((f) => f.cls === "unscanned" && /big\.json/.test(f.where))).toBe(true);
  });
});

describe("checkStaleness — B3 gate", () => {
  it("flags a baseline-of-record that drifted from latest", () => {
    const c = {
      scenario: scenario([{ result: "success" }]),
      events: [],
      fingerprint: { baseline: "0.0.0-ancient" },
    } as unknown as Cassette;
    const msgs = checkStaleness(c, ".");
    expect(msgs.some((m) => /baseline/.test(m))).toBe(true);
  });

  it("FAILS (not warns) when a recorded skillHash can't be re-resolved from the cassette location", () => {
    // fingerprint claims a skillHash but the session is inline → live recompute yields no skillHash.
    const c = {
      scenario: scenario([{ result: "success" }]),
      events: [],
      fingerprint: { baseline: "latest", skillHash: "abc" },
    } as unknown as Cassette;
    const msgs = checkStaleness(c, ".");
    expect(msgs.some((m) => /resolv/i.test(m))).toBe(true);
  });

  it("no fingerprint → nothing to check (no false staleness)", () => {
    const c = { scenario: scenario([{ result: "success" }]), events: [] } as unknown as Cassette;
    expect(checkStaleness(c, ".")).toEqual([]);
  });
});

describe("checkStaleness — staleness message variants", () => {
  it("emits 'older hash format' message when cassette v < current and skillHash mismatches", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-g2-"));
    const skillDir = join(root, "skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# s\n");
    const sessionPath = join(root, "session.yaml");
    writeFileSync(sessionPath, `skills:\n  local:\n    - ./skill\n`);

    const c = {
      cassetteVersion: 1, // older format — should trigger format-version message
      scenario: {
        name: "s",
        baseline: "latest",
        session: sessionPath,
        fidelity: "container" as const,
        prompt: "hi",
        answers: [],
        expect_denied: [],
        assert: [],
      },
      events: [],
      fingerprint: {
        baseline: "99.0.0",
        skillHash: "0000000000000000000000000000000000000000000000000000000000000000",
      },
    } as unknown as Cassette;

    const msgs = checkStaleness(c, root);
    const skillMsg = msgs.find((m) => /hash format|older/.test(m));
    expect(skillMsg).toBeDefined();
    expect(skillMsg).toMatch(/v1.*v2|older hash format/i);
    expect(skillMsg).not.toMatch(/contents changed/);
  });

  it("emits 'contents changed' message when cassette version is current and skillHash mismatches", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-g2b-"));
    const skillDir = join(root, "skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# s\n");
    const sessionPath = join(root, "session.yaml");
    writeFileSync(sessionPath, `skills:\n  local:\n    - ./skill\n`);

    const c = {
      cassetteVersion: CASSETTE_VERSION, // current format — should get the generic contents-changed message
      scenario: {
        name: "s",
        baseline: "latest",
        session: sessionPath,
        fidelity: "container" as const,
        prompt: "hi",
        answers: [],
        expect_denied: [],
        assert: [],
      },
      events: [],
      fingerprint: {
        baseline: "99.0.0",
        skillHash: "0000000000000000000000000000000000000000000000000000000000000000",
      },
    } as unknown as Cassette;

    const msgs = checkStaleness(c, root);
    const skillMsg = msgs.find((m) => /contents changed|changed since/.test(m));
    expect(skillMsg).toBeDefined();
    expect(skillMsg).not.toMatch(/hash format|older/i);
  });
});

describe("checkStaleness — bucket-named messages (G-4)", () => {
  function pluginSessionRoot(): { root: string; sessionPath: string } {
    const root = mkdtempSync(join(tmpdir(), "cwh-g4-"));
    mkdirSync(join(root, "plugin", "skills", "alpha"), { recursive: true });
    mkdirSync(join(root, "plugin", "scripts"), { recursive: true });
    writeFileSync(join(root, "plugin", "skills", "alpha", "SKILL.md"), "# alpha v1\n");
    writeFileSync(join(root, "plugin", "scripts", "shared.py"), "x = 1\n");
    const sessionPath = join(root, "session.yaml");
    writeFileSync(sessionPath, `skills:\n  local:\n    - ./plugin\n`);
    return { root, sessionPath };
  }

  it("names the skill dir when only the skill changed (not shared root)", () => {
    const { root, sessionPath } = pluginSessionRoot();
    const fp = buildFingerprint(sessionPath, "99.0.0", root, ["alpha"]);
    writeFileSync(join(root, "plugin", "skills", "alpha", "SKILL.md"), "# alpha v2\n");
    const c = {
      cassetteVersion: CASSETTE_VERSION,
      scenario: {
        name: "alpha-smoke",
        baseline: "99.0.0",
        session: sessionPath,
        fidelity: "container" as const,
        prompt: "hi",
        answers: [],
        expect_denied: [],
        assert: [],
        skills: ["alpha"],
      },
      events: [],
      fingerprint: fp,
    } as unknown as Cassette;
    const msgs = checkStaleness(c, root);
    const skillMsg = msgs.find((m) => /skills\/alpha/.test(m));
    expect(skillMsg).toBeDefined();
    expect(skillMsg).not.toMatch(/shared root/);
  });

  it("names the shared root when only shared content changed (not the scoped skill)", () => {
    const { root, sessionPath } = pluginSessionRoot();
    const fp = buildFingerprint(sessionPath, "99.0.0", root, ["alpha"]);
    writeFileSync(join(root, "plugin", "scripts", "shared.py"), "x = 99\n");
    const c = {
      cassetteVersion: CASSETTE_VERSION,
      scenario: {
        name: "alpha-smoke",
        baseline: "99.0.0",
        session: sessionPath,
        fidelity: "container" as const,
        prompt: "hi",
        answers: [],
        expect_denied: [],
        assert: [],
        skills: ["alpha"],
      },
      events: [],
      fingerprint: fp,
    } as unknown as Cassette;
    const msgs = checkStaleness(c, root);
    const sharedMsg = msgs.find((m) => /shared root/.test(m));
    expect(sharedMsg).toBeDefined();
    expect(sharedMsg).toMatch(/scope: skills\/alpha/);
  });
});

describe("checkStaleness — mixed-mount falls back to generic message", () => {
  it("does not emit a bucket-named message when the session mixes plugin-root and individual-skill-mount dirs", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-mixed-"));
    // Plugin-root (has skills/)
    mkdirSync(join(root, "plugin", "skills", "alpha"), { recursive: true });
    mkdirSync(join(root, "plugin", "scripts"), { recursive: true });
    writeFileSync(join(root, "plugin", "skills", "alpha", "SKILL.md"), "# alpha\n");
    writeFileSync(join(root, "plugin", "scripts", "shared.py"), "x = 1\n");
    // Individual-skill-mount (no skills/ dir — a direct single-skill dir)
    mkdirSync(join(root, "extra-skill"), { recursive: true });
    writeFileSync(join(root, "extra-skill", "SKILL.md"), "# extra\n");
    // Session mounts both
    const sessionPath = join(root, "session.yaml");
    writeFileSync(sessionPath, `skills:\n  local:\n    - ./plugin\n    - ./extra-skill\n`);

    const fp = buildFingerprint(sessionPath, "99.0.0", root, ["alpha"]);
    // With the fix, fp.sharedHash must be absent (mixed dirs → no bucket diagnosis)
    expect(fp.sharedHash).toBeUndefined();

    // Now change the individual-skill-mount
    writeFileSync(join(root, "extra-skill", "SKILL.md"), "# extra edited\n");

    const c = {
      cassetteVersion: CASSETTE_VERSION,
      scenario: {
        name: "alpha-smoke",
        baseline: "99.0.0",
        session: sessionPath,
        fidelity: "container" as const,
        prompt: "hi",
        answers: [],
        expect_denied: [],
        assert: [],
        skills: ["alpha"],
      },
      events: [],
      fingerprint: fp,
    } as unknown as Cassette;
    const msgs = checkStaleness(c, root);
    const staleMsg = msgs.find((m) => /skill|plugin dir/.test(m));
    expect(staleMsg).toBeDefined();
    // Must not name a specific bucket — the mixed layout makes that unreliable
    expect(staleMsg).not.toMatch(/skills\/alpha/);
    expect(staleMsg).not.toMatch(/shared root/);
    expect(staleMsg).toMatch(/local skill\/plugin dir contents changed/);
  });
});
