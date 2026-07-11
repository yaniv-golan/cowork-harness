import { describe, it, expect } from "vitest";
import { matchesTerminalUsageLimitText, isUsageLimit } from "../src/usage-limit.js";

describe("matchesTerminalUsageLimitText — the curated TERMINAL family", () => {
  it("matches the terminal usage/quota-limit variants (session/weekly/model/spend/org/credits/seat)", () => {
    for (const t of [
      "You've hit your session limit · resets 4pm",
      "You've hit your weekly limit · resets Jul 13",
      "You've reached your Opus limit",
      "You've hit your Sonnet limit",
      "You've hit your Fable 5 limit",
      "You've hit your monthly spend limit",
      "You've hit your org's monthly usage limit",
      "You've used all your usage limit for this period",
      "You're out of usage credits",
      "Your org is out of usage — add funds to continue",
      "Fable 5 requires usage credits.",
      "This service is disabled for your org",
      "Your seat type doesn't include Opus",
    ])
      expect(matchesTerminalUsageLimitText(t)).toBe(true);
  });

  it("does NOT match advisory (non-terminal) strings or unrelated errors", () => {
    for (const t of [
      "You're close to your session limit", // advisory — emitted on a SUCCESSFUL turn
      "You're now using usage credits", // advisory
      "Overloaded, please retry", // transient
      "You've hit your rate limit, please try again shortly", // TRANSIENT rate limit (429 but retryable) — must NOT be quota
      "Rate limited — try again in a few seconds",
      "error_max_turns the model gave up", // a real agent failure
      "API Error: Connection closed", // transport
      "",
    ])
      expect(matchesTerminalUsageLimitText(t)).toBe(false);
  });
});

describe("isUsageLimit — conjunctive 429 AND terminal text (text-only fallback when status absent)", () => {
  const T = "You've hit your session limit · resets 4pm";
  it("429 + terminal text → true", () => expect(isUsageLimit(T, 429)).toBe(true));
  it("terminal text + NO status (older binary) → true (text fallback)", () => expect(isUsageLimit(T, undefined)).toBe(true));
  it("terminal text + a NON-429 status → false (status present and wrong)", () => expect(isUsageLimit(T, 500)).toBe(false));
  it("429 without terminal text (transient overload) → false", () => expect(isUsageLimit("Overloaded", 429)).toBe(false));
  it("a TRANSIENT rate-limit 429 (even with a 'You've hit your' opener) → false (retryable, not quota)", () =>
    expect(isUsageLimit("You've hit your rate limit, please try again", 429)).toBe(false));
  it("no text, no status → false", () => expect(isUsageLimit("", undefined)).toBe(false));
});
