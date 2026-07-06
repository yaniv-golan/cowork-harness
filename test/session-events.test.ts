import { describe, it, expect } from "vitest";
import { parseMessage } from "../src/agent/session.js";

describe("parseMessage system-subtype catch-all", () => {
  it("emits system_event for an unrecognized system subtype", () => {
    // A real compact_boundary carries its payload at the TOP LEVEL of the system message,
    // and systemEventData strips only the type/subtype envelope — so `data` is the top-level rest.
    const evs = parseMessage({ type: "system", subtype: "compact_boundary", trigger: "auto" });
    expect(evs).toContainEqual({ type: "system_event", subtype: "compact_boundary", data: { trigger: "auto" } });
  });

  it("does NOT emit system_event for init/api_metrics/thinking", () => {
    for (const subtype of ["init", "api_metrics", "thinking"]) {
      const evs = parseMessage({ type: "system", subtype, content: "x", tools: [], skills: [] });
      expect(evs.some((e) => e.type === "system_event")).toBe(false);
    }
  });
});
