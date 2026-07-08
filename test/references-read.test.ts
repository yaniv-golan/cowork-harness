import { describe, it, expect } from "vitest";
import { skillReferenceReadPath } from "../src/run/run";

// B4: classify a Read tool's file_path as a skill reference/script access (the referencesRead signal).
describe("skillReferenceReadPath (B4)", () => {
  it("captures a reference Read under a mounted plugin root (container path shape)", () => {
    expect(
      skillReferenceReadPath("/sessions/local_x/mnt/.local-plugins/marketplaces/local-desktop-app-uploads/cowork-harness/references/task-recipes.md"),
    ).toBe("references/task-recipes.md");
  });

  it("captures a scripts Read too", () => {
    expect(skillReferenceReadPath("/mnt/.local-plugins/cache/my-plugin/scripts/scenario.py")).toBe("scripts/scenario.py");
  });

  it("captures a remote-plugin reference", () => {
    expect(skillReferenceReadPath("/mnt/.remote-plugins/plugin_abc/references/deep/guide.md")).toBe("references/deep/guide.md");
  });

  it("ignores a Read that isn't under a plugin root (a user document, an output)", () => {
    expect(skillReferenceReadPath("/mnt/uploads/report.pdf")).toBeUndefined();
    expect(skillReferenceReadPath("/mnt/outputs/result.md")).toBeUndefined();
    expect(skillReferenceReadPath("references/foo.md")).toBeUndefined(); // no plugin-root marker → not attributable
  });

  it("ignores a plugin-root Read that isn't a reference/script (e.g. SKILL.md, which is delivered whole)", () => {
    expect(skillReferenceReadPath("/mnt/.local-plugins/cache/my-plugin/SKILL.md")).toBeUndefined();
  });

  it("is empty-safe", () => {
    expect(skillReferenceReadPath("")).toBeUndefined();
  });
});
