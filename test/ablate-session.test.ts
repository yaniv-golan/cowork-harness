import { describe, it, expect } from "vitest";
import { ablateSession } from "../src/run/execute";

// C2: --ablate-skill strips ALL skill/plugin discovery so the same prompt runs with no skill (a
// deterministic negative control), while preserving model/folders/egress.
describe("ablateSession (C2)", () => {
  const base = {
    model: "claude-opus-4-8",
    folders: [{ from: "/x", mode: "rw" }],
    plugins: {
      local_plugins: ["./skills/my-skill"],
      remote_plugins: ["r1"],
      local_marketplaces: ["./mp"],
      marketplaces: ["https://github.com/x/y.git"],
      enabled: ["my-skill@local"],
    },
    skills: { local: ["./extra-skill"] },
    egress: { extra_allow: ["api.example.com"], unrestricted: false },
  };

  it("empties every skill/plugin discovery source", () => {
    const a = ablateSession(base);
    expect(a.plugins.local_plugins).toEqual([]);
    expect(a.plugins.remote_plugins).toEqual([]);
    expect(a.plugins.local_marketplaces).toEqual([]);
    expect(a.plugins.marketplaces).toEqual([]);
    expect(a.plugins.enabled).toEqual([]);
    expect(a.skills.local).toEqual([]);
  });

  it("preserves non-discovery setup (model, folders, egress)", () => {
    const a = ablateSession(base);
    expect(a.model).toBe("claude-opus-4-8");
    expect(a.folders).toEqual([{ from: "/x", mode: "rw" }]);
    expect(a.egress).toEqual({ extra_allow: ["api.example.com"], unrestricted: false });
  });

  it("does not mutate the input (safe for a reused matrix/repeat session)", () => {
    ablateSession(base);
    expect(base.plugins.local_plugins).toEqual(["./skills/my-skill"]); // original untouched
    expect(base.skills.local).toEqual(["./extra-skill"]);
  });
});
