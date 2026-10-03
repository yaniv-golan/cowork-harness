// The one requested-effort resolver (`--effort` → the session's `effort:` → the baseline's `effortDefault` → medium),
// the effort override seam, and the before-spend refusals over a session's effort and thinking settings.

import { describe, it, expect } from "vitest";
import { applySessionOverrides, effortSelector, loadSession, resolveEffort, thinkingEffortRefusal } from "../src/session.js";
import { loadBaseline } from "../src/baseline.js";
import type { PlatformBaseline } from "../src/types.js";

const baseline = loadBaseline("desktop-2.19675.0");
const withDefault = (d: string | undefined): PlatformBaseline =>
  ({ ...baseline, spawn: { ...baseline.spawn, effortDefault: d } }) as PlatformBaseline;
const session = (extra: Record<string, unknown> = {}) => loadSession({ plugins: { local_plugins: ["/p/plug"] }, ...extra });

describe("resolveEffort", () => {
  it("takes the flag over the session, the session over the baseline default, the default over medium", () => {
    expect(resolveEffort({ flag: "max", session: "low", baseline: withDefault("high") })).toBe("max");
    expect(resolveEffort({ session: "low", baseline: withDefault("high") })).toBe("low");
    expect(resolveEffort({ baseline: withDefault("high") })).toBe("high");
    expect(resolveEffort({ baseline: withDefault(undefined) })).toBe("medium");
    expect(resolveEffort({})).toBe("medium");
  });
});

describe("applySessionOverrides effort", () => {
  it("overwrites the session's effort, and leaves it alone when none is given", () => {
    const s = session({ effort: "low" });
    expect(applySessionOverrides(s, { effort: "high" }).effort).toBe("high");
    expect(applySessionOverrides(s, {}).effort).toBe("low");
    expect(s.effort).toBe("low"); // pure
  });
});

describe("effortSelector", () => {
  it("is false for a model the baseline lists with no levels, its levels for one with them, undefined when unknown", () => {
    expect(effortSelector("claude-haiku-4-5", baseline)).toBe(false);
    expect(effortSelector("claude-sonnet-4-6", baseline)).toEqual(["low", "medium", "high", "max"]);
    expect(effortSelector("claude-fable-1", baseline)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortSelector("claude-opus-5-5", baseline)).toBeUndefined();
  });
});

describe("effortSelector: dated ids, and the agent's own no-effort models", () => {
  it("looks a dated id up undated", () => {
    expect(effortSelector("claude-haiku-4-5-20251001", baseline)).toBe(false);
    expect(effortSelector("claude-sonnet-4-6-20260101", baseline)).toEqual(["low", "medium", "high", "max"]);
  });
  it("treats the models the agent never sends an effort for as having no selector, though the baseline omits them", () => {
    for (const m of ["claude-opus-4-1", "claude-opus-4-0", "claude-sonnet-4-0", "claude-3-5-haiku-20241022", "claude-opus-4-1-20250805"])
      expect(effortSelector(m, baseline), m).toBe(false);
  });
});

describe("thinkingEffortRefusal", () => {
  it("refuses xhigh or max with extended_thinking off", () => {
    for (const effort of ["xhigh", "max"]) {
      const m = thinkingEffortRefusal(session({ model: "claude-opus-4-8", effort, extended_thinking: false }), baseline);
      expect(m).toContain(`effort ${effort}`);
      expect(m).toContain("extended_thinking: false");
    }
  });
  it("refuses thinking off on a model whose baseline entry disallows it", () => {
    const m = thinkingEffortRefusal(session({ model: "claude-opus-5", extended_thinking: false }), baseline);
    expect(m).toContain("claude-opus-5");
    expect(m).toContain("disallowThinkingDisabled");
    // the regex-default class carries it too
    expect(thinkingEffortRefusal(session({ model: "claude-fable-1", extended_thinking: false }), baseline)).toContain(
      "disallowThinkingDisabled",
    );
  });
  it("passes high with thinking off on a model that allows it, and anything with thinking on", () => {
    expect(
      thinkingEffortRefusal(session({ model: "claude-opus-4-8", effort: "high", extended_thinking: false }), baseline),
    ).toBeUndefined();
    expect(thinkingEffortRefusal(session({ model: "claude-opus-5", effort: "max" }), baseline)).toBeUndefined();
  });
});
