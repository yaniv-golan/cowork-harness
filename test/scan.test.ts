import { describe, it, expect } from "vitest";
import { scanText, DEFAULT_SCAN_PATTERNS } from "../src/scan.js";

describe("scanText — default PII heuristics (email + currency + domain)", () => {
  it("flags an email", () => {
    const f = scanText("reach alice@acme.com today", "transcript", []);
    expect(f.some((x) => x.cls === "email")).toBe(true);
  });
  it("flags a currency figure", () => {
    const f = scanText("raised $1,250,000 last round", "transcript", []);
    expect(f.some((x) => x.cls === "currency")).toBe(true);
  });
  it("flags a bare domain", () => {
    const f = scanText("see customer.io for details", "transcript", []);
    expect(f.some((x) => x.cls === "domain")).toBe(true);
  });
  it("clean synthetic text → no findings", () => {
    expect(scanText("the quick brown fox jumped", "transcript", [])).toEqual([]);
  });
  it("does NOT flag multi-word proper names (opt-in only, not a default class)", () => {
    const f = scanText("Jane Doe met Acme Corp", "transcript", []);
    expect(f).toEqual([]);
  });
  it("allowlist suppresses a WHOLE-TOKEN match (synthetic / public reference name)", () => {
    const f = scanText("contact us at hello@acme.com", "transcript", [/hello@acme\.com/i]);
    expect(f.some((x) => x.cls === "email")).toBe(false);
  });
  it("F-2: a bare-domain allow does NOT bleed into the email class (substring no longer suppresses)", () => {
    // `acme\.com` is a substring of the email token `hello@acme.com`; under the old substring matcher this
    // silently cleared the email finding. Anchored whole-token matching keeps the email tripwire live.
    const f = scanText("contact us at hello@acme.com and see acme.com", "transcript", [/acme\.com/i]);
    expect(f.some((x) => x.cls === "email")).toBe(true); // email survives
    expect(f.some((x) => x.cls === "domain")).toBe(false); // bare domain acme.com still suppressed (whole token)
  });
  it("class-scoped allow only suppresses its own class", () => {
    const text = "contact us at hello@acme.com and see acme.com";
    // domain-scoped allow clears the domain finding but leaves email
    const dom = scanText(text, "transcript", [{ cls: "domain", re: /acme\.com/i }]);
    expect(dom.some((x) => x.cls === "domain")).toBe(false);
    expect(dom.some((x) => x.cls === "email")).toBe(true);
    // email-scoped allow clears the email finding but leaves domain
    const eml = scanText(text, "transcript", [{ cls: "email", re: /hello@acme\.com/i }]);
    expect(eml.some((x) => x.cls === "email")).toBe(false);
    expect(eml.some((x) => x.cls === "domain")).toBe(true);
  });
  it("each default pattern carries a class label", () => {
    expect(DEFAULT_SCAN_PATTERNS.map((p) => p.cls).sort()).toEqual(["currency", "domain", "email"]);
  });
});
