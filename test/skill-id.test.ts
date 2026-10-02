// The id the agent binary registers a plugin skill under: `<plugin>:<name>`, the name with every character outside
// [a-zA-Z0-9_-] replaced by "-" (the plugin skill loader of the staged agent, 2.1.284).
import { describe, it, expect } from "vitest";
import { registeredSkillId, sanitizeSkillName } from "../src/skill-id.js";

describe("sanitizeSkillName", () => {
  it("keeps an already-clean name byte for byte", () => {
    expect(sanitizeSkillName("deck-review_2")).toBe("deck-review_2");
  });
  it("rewrites dots and spaces, one '-' per character", () => {
    expect(sanitizeSkillName("my.skill")).toBe("my-skill");
    expect(sanitizeSkillName("v2.0")).toBe("v2-0");
    expect(sanitizeSkillName("deck review")).toBe("deck-review");
    expect(sanitizeSkillName("Deck Review!")).toBe("Deck-Review-");
    expect(sanitizeSkillName("a  b")).toBe("a--b");
  });
  it("rewrites every UTF-16 code unit outside the class: a non-ASCII letter, an astral character", () => {
    expect(sanitizeSkillName("café")).toBe("caf-");
    expect(sanitizeSkillName("skill😀")).toBe("skill--");
  });
});

describe("registeredSkillId", () => {
  it("qualifies the sanitized name with the plugin name, which is not rewritten", () => {
    expect(registeredSkillId("plug", "my.skill")).toBe("plug:my-skill");
    expect(registeredSkillId("plug", "coach")).toBe("plug:coach");
    expect(registeredSkillId("my.plug", "x y")).toBe("my.plug:x-y");
  });
});
