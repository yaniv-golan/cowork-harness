import { describe, it, expect } from "vitest";
import { redactCassette, assertRedactionVerdictPreserved, replayCassette } from "../src/run/cassette.js";
import { redactText, type RedactionPolicy } from "../src/redact.js";

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
    expect(red.artifacts[0].path).not.toContain("@"); // C1: artifact FILENAME redacted too
    expect(red.scenario.prompt).not.toContain("@");
    expect(red.fingerprint.skillSources[0]).not.toContain("@");
  });

  it("redacts an artifact filename that names a customer (C1)", () => {
    const c: any = {
      scenario: scenario([{ result: "success" }]),
      events: [JSON.stringify({ type: "result", subtype: "success" })],
      artifacts: [{ path: "outputs/dave@acme.com-cap-table.json", bytes: 2, sha256: "x", body: "{}" }],
    };
    const red: any = redactCassette(c, policy);
    expect(red.artifacts[0].path).not.toContain("@acme.com");
  });
});

describe("O7-preservation — redacting a gated cassette must NOT break the replay protocol-fidelity guard", () => {
  // Full-fidelity gated cassette: the AskUserQuestion question text carries PII (an email), which appears in
  // THREE places — the events question, the controlOut `questions` copy, and the controlOut `answers` map KEY.
  // Structural + per-match-text-deterministic redaction must rewrite all three identically so serializeDecision
  // re-serialization still equals the recorded controlOut (no replay_protocol_fidelity failure).
  const q = "Send the deck to alice@acme.com?";
  const events = [
    JSON.stringify({ type: "system", subtype: "init", tools: ["AskUserQuestion"] }),
    JSON.stringify({
      type: "control_request",
      request_id: "req-q1",
      request: {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        tool_use_id: "toolu_G",
        input: { questions: [{ question: q, header: "Recipient", options: [{ label: "Yes" }, { label: "No" }] }] },
      },
    }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false }),
  ];
  const controlOut = [
    JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "req-q1",
        response: {
          behavior: "allow",
          updatedInput: {
            questions: [{ question: q, header: "Recipient", options: [{ label: "Yes" }, { label: "No" }] }],
            answers: { [q]: "Yes" },
          },
        },
      },
    }),
  ];
  const o7Fails = (r: Awaited<ReturnType<typeof replayCassette>>) =>
    r.assertions.filter((a) => (a.assertion as any).replay_protocol_fidelity && !a.pass);
  const cassette = (): any => ({ scenario: scenario([{ question_asked: "Send the deck" }, { result: "success" }]), events, controlOut });

  it("redaction of the question text preserves O7 (no replay_protocol_fidelity failure) and keeps JSON valid", async () => {
    const red: any = redactCassette(cassette(), policy);
    expect(JSON.stringify(red)).not.toContain("alice@acme.com"); // the email is gone everywhere
    red.events.forEach((l: string) => expect(() => JSON.parse(l)).not.toThrow());
    const r = await replayCassette(red);
    expect(o7Fails(r)).toHaveLength(0); // structural+deterministic redaction kept events/controlOut in sync
    expect(r.assertions.filter((a) => !a.pass)).toHaveLength(0); // question_asked / result green
  });

  it("CONTROL: the un-redacted gated cassette passes O7 (the cassette really drives the gate)", async () => {
    expect(o7Fails(await replayCassette(cassette()))).toHaveLength(0);
  });

  it("GUARD-SENSITIVITY: a DESYNCED redaction (events redacted, controlOut not) FAILS O7 — the test isn't vacuous", async () => {
    // Redact ONLY the events lines (text-level) → the events question diverges from the controlOut copy +
    // answers key. serializeDecision re-serialization must now mismatch the recorded controlOut → O7 fails.
    const desynced: any = { ...cassette(), events: events.map((l) => redactText(l, policy)) };
    expect(o7Fails(await replayCassette(desynced)).length).toBeGreaterThan(0);
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
