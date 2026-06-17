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
  it("allowlist suppresses a match (synthetic / public reference name)", () => {
    const f = scanText("contact us at hello@acme.com", "transcript", [/acme\.com/i]);
    expect(f.some((x) => x.cls === "email")).toBe(false);
  });
  it("each default pattern carries a class label", () => {
    expect(DEFAULT_SCAN_PATTERNS.map((p) => p.cls).sort()).toEqual(["currency", "domain", "email"]);
  });
});
