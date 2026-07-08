import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Structural tripwire (7d) for .claude/skills/cowork-harness/SKILL.md.
//
// This is a TRIPWIRE, not a semantic gate: it checks a COUNT (are there still ~as many gotcha
// items as before) and the PRESENCE of a few load-bearing section markers, matched as substrings
// so a reorder that renumbers a heading ("## 6. Assertions..." -> "## 5. Assertions...") still
// passes. It cannot tell whether a gotcha's *content* is still accurate, or whether a section was
// reworded into nonsense — only that a restructure/edit pass didn't silently delete the section or
// drop items wholesale. A real content review still needs a human (or a semantic diff) on top of
// this.
const SKILL_PATH = resolve(".claude/skills/cowork-harness/SKILL.md");

describe("cowork-harness SKILL.md structural tripwire", () => {
  const doc = readFileSync(SKILL_PATH, "utf8");

  it("has a Gotchas section", () => {
    expect(doc).toContain("## Gotchas");
  });

  it("the Gotchas section still has at least 21 numbered gotcha items", () => {
    const start = doc.indexOf("## Gotchas");
    expect(start).toBeGreaterThanOrEqual(0);
    const nextHeading = doc.indexOf("\n## ", start + 1);
    const section = doc.slice(start, nextHeading === -1 ? undefined : nextHeading);
    const items = section.match(/^\d+\. \*\*/gm) ?? [];
    expect(items.length).toBeGreaterThanOrEqual(21);
  });

  it("retains the two-axes assertions model marker", () => {
    expect(doc).toContain("Assertions: two orthogonal axes");
  });

  it("retains the web_fetch provenance section marker", () => {
    expect(doc).toContain("web_fetch");
  });
});
