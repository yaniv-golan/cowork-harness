import { describe, expect, it } from "vitest";
import { manifestNameAccepted } from "../src/session.js";

// The agent refuses a plugin name containing "@", ":", whitespace, path separators, or invisible/control characters.
describe("manifestNameAccepted", () => {
  it.each(["my-skills-repo", "my_skills_repo", "MySkills", "skills.repo"])("accepts %s", (n) => {
    expect(manifestNameAccepted(n)).toBe(true);
  });
  it.each(["", "My Skills", "@scope", "a:b", "a/b", "a\\b", "a\u0007b", "a​b", "a­b"])("refuses %j", (n) => {
    expect(manifestNameAccepted(n)).toBe(false);
  });
});
