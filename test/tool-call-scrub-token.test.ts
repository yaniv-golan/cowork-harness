import { describe, it, expect } from "vitest";
import { evaluate, type AssertContext } from "../src/assert.js";
import { scrub, scrubField } from "../src/secrets.js";

// The operator-secret scrubber (src/secrets.ts) runs over result.json and events.jsonl — the files every
// cassette and every verify-run is built from — and writes `[REDACTED]` (no colon), `[REDACTED:base64]` and
// `[REDACTED:uri]`. A negative tool-call check must treat those exactly like a policy token: bytes it
// cannot see, never a proven absence. Built from REAL scrub() output, not a hand-typed token.

const SECRET = "sk-ant-api03-EXAMPLEEXAMPLEEXAMPLE";
const SECRETS = [SECRET, "Bearer " + SECRET];

function ctx(command: string, resultText: string): AssertContext {
  return {
    transcript: "",
    toolsCalled: new Set(["Bash"]),
    subagentTools: new Set(),
    egress: [],
    result: "success",
    workRoot: "/nonexistent",
    userVisiblePrefixes: ["outputs"],
    outputsDeletes: [],
    mountDeletes: [],
    questions: [],
    hostPathLeaked: false,
    selfHealRan: false,
    subagents: [],
    gateDeliveries: [],
    toolResultTexts: [resultText],
    skillsInvoked: [],
    skillToolAvailable: true,
    slashInvokedSkills: [],
    toolCalls: [{ toolUseId: "b1", name: "Bash", input: { command: { text: command } }, origin: "main" }],
    toolResults: [{ toolUseId: "b1", isError: false, text: resultText }],
  };
}

describe("the secret scrubber's tokens are redaction tokens too", () => {
  const command = scrub(`curl -H "Authorization: Bearer ${SECRET}" https://api.example.com`, SECRETS);
  const result = scrub(`echo ${SECRET}\n${SECRET}`, SECRETS);

  it("sanity: scrub() writes the colon-less [REDACTED]", () => {
    expect(command).toContain("[REDACTED]");
    expect(command).not.toContain("sk-ant-");
  });

  it("case 1: tool_not_called input regex over a scrubbed command is evidence-unavailable, not a pass", () => {
    const [r] = evaluate([{ tool_not_called: { tool: "Bash", input: { command: "sk-ant-" } } }], ctx(command, "ok"));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/evidence unavailable/);
  });

  it("case 2: tool_not_called result.matches over a scrubbed result is evidence-unavailable, not a pass", () => {
    const [r] = evaluate([{ tool_not_called: { tool: "Bash", result: { matches: "sk-ant-" } } }], ctx("echo", result));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/evidence unavailable/);
  });

  it("the whole-field forms ([REDACTED:base64]) count as well", () => {
    const b64 = scrubField(Buffer.from(`x-${SECRET}-y`).toString("base64"), SECRETS);
    expect(b64).toBe("[REDACTED:base64]");
    const [r] = evaluate([{ tool_not_called: { tool: "Bash", input: { command: "sk-ant-" } } }], ctx(`echo ${b64}`, "ok"));
    expect(r.pass).toBe(false);
  });

  it("a frozen regex carrying a colon-less [REDACTED] is evidence-unavailable", () => {
    const [r] = evaluate([{ tool_not_called: { tool: "Bash", input: { command: scrub(`Bearer ${SECRET}`, SECRETS) } } }], ctx("ls", "ok"));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/evidence unavailable/);
  });

  it("a passing evidence line masks a colon-less [REDACTED] too", () => {
    const [r] = evaluate([{ tool_called: { tool: "Bash", input: { command: "^curl" } } }], ctx(command, "ok"));
    expect(r.pass).toBe(true);
    expect((r as { evidence?: string }).evidence ?? "").not.toContain("[REDACTED");
  });
});

// ---- a HIT must never come from a token's own text --------------------------------------------------
import { redactText } from "../src/redact.js";

describe("a regex hit on a redaction token's own text is not evidence", () => {
  const keyTok = redactText("deploy AcmeCorp now", { patterns: [{ re: /AcmeCorp/g, label: "key" }], keyNames: [] });
  const emailTok = redactText("mailed alice@example.com", { patterns: [{ re: /\S+@\S+/g, label: "email" }], keyNames: [] });

  it("sanity: the tokens are real redactText output", () => {
    expect(keyTok).toMatch(/\[REDACTED:key:[0-9a-f]{12}\]/);
    expect(emailTok).toMatch(/\[REDACTED:email:[0-9a-f]{12}\]/);
  });

  it.each([["key"], ["\\b[0-9a-f]{12}\\b"], ["REDACTED"]])("tool_called input %s does not pass on the token's text", (rx) => {
    const [r] = evaluate([{ tool_called: { tool: "Bash", input: { command: rx } } }], ctx(keyTok, "ok"));
    expect(r.pass).toBe(false);
  });

  it("tool_called result.matches 'email' does not pass on [REDACTED:email:…]", () => {
    const [r] = evaluate([{ tool_called: { tool: "Bash", result: { matches: "email" } } }], ctx("echo", emailTok));
    expect(r.pass).toBe(false);
  });

  it("a hit on the UNREDACTED part still passes", () => {
    const [r] = evaluate([{ tool_called: { tool: "Bash", input: { command: "^deploy\\s" } } }], ctx(keyTok, "ok"));
    expect(r.pass).toBe(true);
  });
});
