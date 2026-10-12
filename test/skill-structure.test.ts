import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// Structural tripwire for the companion skill: .claude/skills/cowork-harness/SKILL.md (the entrypoint)
// and the references/ files its detail lives in.
//
// This is a TRIPWIRE, not a semantic gate: it checks a COUNT (are there still ~as many gotcha
// items as before) and the PRESENCE of a few load-bearing section markers, matched as substrings
// so a reorder that renumbers a heading ("## 6. Assertions..." -> "## 5. Assertions...") still
// passes. It cannot tell whether a gotcha's *content* is still accurate, or whether a section was
// reworded into nonsense — only that a restructure/edit pass didn't silently delete the section or
// drop items wholesale. A real content review still needs a human (or a semantic diff) on top of
// this.
const SKILL_DIR = ".claude/skills/cowork-harness";
const read = (rel: string) => readFileSync(resolve(SKILL_DIR, rel), "utf8");

/** The files the entrypoint was split into. Each must exist AND be linked from SKILL.md — a reference
 *  nothing routes to is one the agent never reads. */
const SPLIT_REFERENCES = [
  "references/authoring.md",
  "references/assertions-guide.md",
  "references/run-record-replay.md",
  "references/measurement.md",
  "references/debugging.md",
  "references/gotchas.md",
];

describe("cowork-harness SKILL.md structural tripwire", () => {
  const doc = read("SKILL.md");
  const gotchas = read("references/gotchas.md");

  it("has a Gotchas section (in references/gotchas.md)", () => {
    expect(gotchas).toContain("## Gotchas");
  });

  it("the Gotchas section still has all 27 numbered gotcha items", () => {
    const start = gotchas.indexOf("## Gotchas");
    expect(start).toBeGreaterThanOrEqual(0);
    const nextHeading = gotchas.indexOf("\n## ", start + 1);
    const section = gotchas.slice(start, nextHeading === -1 ? undefined : nextHeading);
    const items = section.match(/^\d+\. \*\*/gm) ?? [];
    // The floor was 21 while the list lived in SKILL.md; the split moved all 27 verbatim, so the floor is
    // now the real count — a move that dropped one would otherwise stay green.
    expect(items.length).toBeGreaterThanOrEqual(27);
  });

  it("the orientation router offers critique, and states the skill-vs-critique routing rule", () => {
    // Bounded by the NEXT `## ` heading, not by a named one: the slice used to end at "## Part I", and
    // indexOf returning -1 there (the heading moved out of SKILL.md) silently widened it to the rest of the
    // file — green, while checking the wrong region. Both ends are asserted found.
    const start = doc.indexOf("## Orient — the three loops");
    expect(start, "the Orient router heading is gone").toBeGreaterThan(-1);
    const end = doc.indexOf("\n## ", start + 1);
    expect(end, "no heading follows the Orient router, so its end is unbounded").toBeGreaterThan(start);
    const router = doc.slice(start, end);
    expect(router).toContain("cowork-harness critique");
    // \s+ not a literal space: the bullet wraps across lines at exactly this phrase.
    expect(router).toMatch(/what does this skill\s+\*\*DO\*\*/i);
    expect(router).toMatch(/use `skill`/i);
  });

  it("the debug routes tell the agent to READ references/debugging.md first, not a summary of it", () => {
    // A wording tripwire, not proof of behaviour: whether an agent actually opens the reference needs a
    // live run. It exists because a router bullet that carried its own inline procedure was acted on
    // without the reference ever being read, which skipped the triage split between "the skill misbehaved"
    // and "a green you don't trust". The "no verify-run before the Read" clause guards against someone
    // re-inlining the procedure ahead of the instruction.
    const start = doc.indexOf("## Orient — the three loops");
    const end = doc.indexOf("\n## ", start + 1);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const router = doc.slice(start, end);
    const bulletStart = router.indexOf("- **A run failed");
    expect(bulletStart, "the debug bullet is gone from the Orient router").toBeGreaterThan(-1);
    const nextBullet = router.indexOf("\n- ", bulletStart + 1);
    const bullet = router.slice(bulletStart, nextBullet === -1 ? undefined : nextBullet);
    const read = bullet.search(/\*\*Read\s+\[`references\/debugging\.md`\]\(references\/debugging\.md\)/);
    expect(read, "the debug bullet does not tell the agent to Read references/debugging.md").toBeGreaterThan(-1);
    const verifyRun = bullet.indexOf("verify-run");
    expect(verifyRun === -1 || verifyRun > read, "verify-run is named before the Read instruction").toBe(true);

    const debugLine = doc.split("\n").find((l) => l.startsWith("- **Debug:**"));
    expect(debugLine, "the Debug short workflow is gone").toBeDefined();
    expect(debugLine).toMatch(/^- \*\*Debug:\*\* Read `references\/debugging\.md` first/);
  });

  it("retains the two-axes assertions model marker (in references/assertions-guide.md)", () => {
    expect(read("references/assertions-guide.md")).toContain("Assertions: two orthogonal axes");
  });

  it("retains the web_fetch provenance section marker (in references/authoring.md)", () => {
    expect(read("references/authoring.md")).toContain("### web_fetch (never auto-allowed, two-path)");
  });

  it.each(SPLIT_REFERENCES)("%s exists and SKILL.md links it", (rel) => {
    expect(existsSync(resolve(SKILL_DIR, rel)), `${rel} is missing`).toBe(true);
    expect(doc, `SKILL.md does not link ${rel}`).toContain(`](${rel})`);
  });
});
