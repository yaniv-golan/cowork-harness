import { describe, it, expect } from "vitest";
import { redactText, redactStructural, redactJsonLine, type RedactionPolicy } from "../src/redact.js";

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const policy: RedactionPolicy = { patterns: [{ re: EMAIL, label: "email" }], keyNames: [] };

describe("redactText — deterministic, collision-safe text redaction", () => {
  it("replaces a match with a stable token and leaves non-matches untouched", () => {
    const out = redactText("ping alice@acme.com now", policy);
    expect(out).not.toContain("alice@acme.com");
    expect(out).toContain("ping ");
    expect(out).toContain(" now");
  });
  it("is deterministic — same input → identical output (no churn across re-records)", () => {
    const t = "mail alice@acme.com";
    expect(redactText(t, policy)).toBe(redactText(t, policy));
  });
  it("gives DISTINCT tokens to distinct matches (injective — no silent collapse)", () => {
    const out = redactText("a alice@acme.com b bob@acme.com", policy);
    const tokens = out.match(/\[REDACTED:[^\]]+\]/g) ?? [];
    expect(tokens.length).toBe(2);
    expect(new Set(tokens).size).toBe(2); // two different emails → two different tokens
  });
  it("empty policy is a no-op", () => {
    expect(redactText("alice@acme.com", { patterns: [], keyNames: [] })).toBe("alice@acme.com");
  });
  it("the token is the LABELED+HASHED form [REDACTED:label:hash] (not a bare [REDACTED]) — the contract the verdict normalizer must tolerate", () => {
    const out = redactText("mail alice@acme.com", policy);
    expect(out).toMatch(/\[REDACTED:email:[0-9a-f]{12}\]/);
    expect(out).not.toMatch(/\[REDACTED\](?!:)/); // never the bare form
  });
});

describe("redactStructural — string LEAVES and object KEYS", () => {
  it("redacts string leaf values, deep, leaving non-strings intact", () => {
    const out = redactStructural({ a: "alice@acme.com", n: 3, nested: { b: ["x", "bob@acme.com"] } }, policy) as any;
    expect(out.a).not.toContain("@");
    expect(out.n).toBe(3);
    expect(out.nested.b[1]).not.toContain("@");
    expect(out.nested.b[0]).toBe("x");
  });
  it("redacts object KEYS without collapsing distinct keys into one", () => {
    const out = redactStructural({ "alice@acme.com": 1, "bob@acme.com": 2 }, policy) as Record<string, number>;
    const keys = Object.keys(out);
    expect(keys.length).toBe(2); // distinct emails stay distinct keys
    expect(keys.every((k) => !k.includes("@"))).toBe(true);
  });

  it("redacts a value under a configured KEY regardless of TYPE (string, number, object)", () => {
    const p: RedactionPolicy = { patterns: [], keyNames: ["ssn", "amount", "owner"] };
    const out = redactStructural({ ssn: "123-45-6789", amount: 1250000, owner: { name: "Eve" }, note: "fine" }, p) as any;
    expect(out.ssn).toMatch(/REDACTED/);
    expect(out.amount).toMatch(/REDACTED/); // a NUMBER under a sensitive key leaks just like a string
    expect(out.owner).toMatch(/REDACTED/); // an OBJECT under a sensitive key, too
    expect(out.note).toBe("fine");
  });
});

describe("redactJsonLine — structural for JSON protocol lines", () => {
  it("redacts inside a JSON line and the result still parses", () => {
    const line = JSON.stringify({ type: "assistant", message: { text: "contact alice@acme.com" } });
    const out = redactJsonLine(line, policy);
    expect(() => JSON.parse(out)).not.toThrow();
    expect(out).not.toContain("alice@acme.com");
    expect(JSON.parse(out).type).toBe("assistant");
  });
  it("a non-JSON line falls back to text redaction (no crash)", () => {
    const out = redactJsonLine("plain alice@acme.com line", policy);
    expect(out).not.toContain("alice@acme.com");
  });
});
