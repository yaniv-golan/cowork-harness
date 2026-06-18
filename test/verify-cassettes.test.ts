import { describe, it, expect } from "vitest";
import { scanCassette, checkStaleness } from "../src/run/cassette.js";

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
    const c: any = {
      scenario: scenario([{ result: "success" }]),
      events: [JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "mail eve@evil.com" }] } })],
      artifacts: [{ path: "outputs/x.json", bytes: 10, sha256: "x", body: JSON.stringify({ owner: "frank@corp.com" }) }],
    };
    const findings = scanCassette(c, []);
    expect(findings.some((f) => f.cls === "email" && /events/.test(f.where))).toBe(true);
    expect(findings.some((f) => f.cls === "email" && /outputs\/x\.json/.test(f.where))).toBe(true);
  });

  it("capability-manifest exclusion: domain/currency suppressed on the agent registry, but FLAGGED in agent reasoning", () => {
    // The two manifest forms: a system/init event (mcp_servers names) and the init-1 registry control_response
    // (slash-command descriptions naming docsend.com). Catalog noise → NOT flagged.
    const manifest: any = {
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
    };
    expect(scanCassette(manifest, []).some((f) => f.cls === "domain")).toBe(false);
    // But a domain in an ASSISTANT message (the agent's actual reasoning) IS flagged — full net off the manifest.
    const reasoning: any = {
      scenario: scenario([{ result: "success" }]),
      events: [JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "pulling the cap table from acme.co" }] } })],
    };
    expect(scanCassette(reasoning, []).some((f) => f.cls === "domain")).toBe(true);
  });

  it("email is scanned EVEN on the capability manifest (the registry `account` field can carry the dev's email)", () => {
    const c: any = {
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
    };
    expect(scanCassette(c, []).some((f) => f.cls === "email")).toBe(true);
  });

  it("a clean synthetic cassette → no findings", () => {
    const c: any = {
      scenario: scenario([{ result: "success" }], "run the cap table for Acme"),
      events: [JSON.stringify({ type: "result", subtype: "success" })],
    };
    expect(scanCassette(c, [])).toEqual([]);
  });

  it("allowlist suppresses a public/synthetic match", () => {
    const c: any = {
      scenario: scenario([{ result: "success" }]),
      events: [JSON.stringify({ text: "cite cooley.com for the SAFE" })],
    };
    expect(scanCassette(c, [/cooley\.com/i]).some((f) => f.cls === "domain")).toBe(false);
  });

  it("F-2: a domain allow does NOT silently clear an email finding (no cross-class bleed)", () => {
    const c: any = {
      scenario: scenario([{ result: "success" }]),
      events: [JSON.stringify({ text: "reach founder@startup.com or visit startup.com" })],
    };
    // A bare allow for the domain `startup\.com` used to substring-match (and suppress) the email
    // `founder@startup.com`. After anchoring it clears only the whole-token domain, never the email.
    const f = scanCassette(c, [/startup\.com/i]);
    expect(f.some((x) => x.cls === "email")).toBe(true); // email tripwire stays live
    expect(f.some((x) => x.cls === "domain")).toBe(false); // domain still allowed
  });

  it("F-2: a class-scoped --allow-domain leaves the email class untouched", () => {
    const c: any = {
      scenario: scenario([{ result: "success" }]),
      events: [JSON.stringify({ text: "reach founder@startup.com or visit startup.com" })],
    };
    const f = scanCassette(c, [{ cls: "domain", re: /startup\.com/i }]);
    expect(f.some((x) => x.cls === "domain")).toBe(false);
    expect(f.some((x) => x.cls === "email")).toBe(true);
  });

  it("flags PII in an artifact FILENAME / path (C1)", () => {
    const c: any = {
      scenario: scenario([{ result: "success" }]),
      events: [JSON.stringify({ type: "result", subtype: "success" })],
      artifacts: [{ path: "outputs/eve@evil.com-cap-table.json", bytes: 2, sha256: "x", body: "{}" }],
    };
    expect(scanCassette(c, []).some((f) => f.cls === "email" && /artifact path/.test(f.where))).toBe(true);
  });

  it("a truncated (uncommitted) artifact body is reported 'unscanned', not a silent pass", () => {
    const c: any = {
      scenario: scenario([{ result: "success" }]),
      events: [JSON.stringify({ type: "result", subtype: "success" })],
      artifacts: [{ path: "outputs/big.json", bytes: 999999, sha256: "x", truncated: true }],
    };
    const findings = scanCassette(c, []);
    expect(findings.some((f) => f.cls === "unscanned" && /big\.json/.test(f.where))).toBe(true);
  });
});

describe("checkStaleness — B3 gate", () => {
  it("flags a baseline-of-record that drifted from latest", () => {
    const c: any = { scenario: scenario([{ result: "success" }]), events: [], fingerprint: { baseline: "0.0.0-ancient" } };
    const msgs = checkStaleness(c, ".");
    expect(msgs.some((m) => /baseline/.test(m))).toBe(true);
  });

  it("FAILS (not warns) when a recorded skillHash can't be re-resolved from the cassette location", () => {
    // fingerprint claims a skillHash but the session is inline → live recompute yields no skillHash.
    const c: any = { scenario: scenario([{ result: "success" }]), events: [], fingerprint: { baseline: "latest", skillHash: "abc" } };
    const msgs = checkStaleness(c, ".");
    expect(msgs.some((m) => /resolv/i.test(m))).toBe(true);
  });

  it("no fingerprint → nothing to check (no false staleness)", () => {
    const c: any = { scenario: scenario([{ result: "success" }]), events: [] };
    expect(checkStaleness(c, ".")).toEqual([]);
  });
});
