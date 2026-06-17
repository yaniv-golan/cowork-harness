import { describe, it, expect } from "vitest";
import { redactCassette, assertRedactionVerdictPreserved } from "../src/run/cassette.js";
import type { RedactionPolicy } from "../src/redact.js";

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const policy: RedactionPolicy = { patterns: [{ re: EMAIL, label: "email" }], keyNames: [] };

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

function cassetteWith(events: string[], assert: unknown[], prompt = "hi"): any {
  return { scenario: scenario(assert, prompt), events };
}

describe("redactCassette — whole-surface content redaction (C1)", () => {
  it("redacts events, artifact bodies, prompt, and skillSources; events still parse", () => {
    const events = [JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ping alice@acme.com" }] } })];
    const c: any = {
      scenario: scenario([{ result: "success" }], "email me at bob@acme.com"),
      events,
      artifacts: [{ path: "outputs/x.json", bytes: 10, sha256: "x", body: JSON.stringify({ owner: "carol@acme.com" }) }],
      fingerprint: { baseline: "1.0.0", skillSources: ["../skills/dave@acme.com-skill"] },
    };
    const red: any = redactCassette(c, policy);
    expect(JSON.stringify(red)).not.toContain("@acme.com");
    expect(() => JSON.parse(red.events[0])).not.toThrow(); // still valid JSON
    expect(JSON.parse(red.events[0]).type).toBe("assistant");
    expect(red.artifacts[0].body).not.toContain("@");
    expect(red.scenario.prompt).not.toContain("@");
    expect(red.fingerprint.skillSources[0]).not.toContain("@");
  });
});

describe("assertRedactionVerdictPreserved — A3 / C4 cardinal-sin guard", () => {
  const okEvents = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hello acme@x.com world" }] } }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false }),
  ];

  it("passes when redaction does not touch any asserted observable", async () => {
    // assertion checks for "hello", which redaction (email-only) never removes → verdict preserved.
    const base = cassetteWith(okEvents, [{ transcript_contains: "hello" }, { result: "success" }]);
    const red = redactCassette(base, policy);
    await expect(assertRedactionVerdictPreserved(base, red)).resolves.toBeUndefined();
  });

  it("FAILS LOUD when redaction flips a verdict (manufactured green)", async () => {
    // The author asserts the transcript does NOT match /acme/. Live: transcript has "acme@x.com" → FAILS.
    // Redacting the email removes "acme" from the transcript, but the regex literal "acme" isn't an email
    // (not redacted) → replay would PASS. Divergence ⇒ the guard must throw.
    const base = cassetteWith(okEvents, [{ transcript_not_matches: "acme" }]);
    const red = redactCassette(base, policy);
    await expect(assertRedactionVerdictPreserved(base, red)).rejects.toThrow(/verdict|redaction/i);
  });
});
