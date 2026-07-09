import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Single-source guard for the debug triage block.
//
// The triage decision-table is authored ONCE and must stay byte-identical between the shipping skill
// (.claude/skills/cowork-harness/SKILL.md, Debug part) and the human doc (docs/debugging.md), so the
// two surfaces cannot drift. Same contract as test/schema.test.ts: divergence fails CI and the author
// reconciles by copy — no generator writes into either hand-authored file.
//
// The block is kept link-free and cross-ref-free precisely so byte-identity is coherent across two
// surfaces that resolve relative links and section numbers differently.
const BEGIN = "<!-- BEGIN triage-canonical -->";
const END = "<!-- END triage-canonical -->";

function extractBlock(relPath: string): string {
  const text = readFileSync(resolve(relPath), "utf8");
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start === -1) throw new Error(`${BEGIN} not found in ${relPath}`);
  if (end === -1) throw new Error(`${END} not found in ${relPath}`);
  if (end < start) throw new Error(`markers out of order in ${relPath}`);
  return text.slice(start + BEGIN.length, end);
}

describe("debug triage block is single-sourced", () => {
  const skill = extractBlock(".claude/skills/cowork-harness/SKILL.md");
  const docs = extractBlock("docs/debugging.md");

  it("the triage-canonical block is byte-identical in SKILL.md and docs/debugging.md", () => {
    expect(skill).toEqual(docs);
  });

  it("the block carries no relative markdown links or section-number cross-refs (kept portable)", () => {
    expect(skill).not.toMatch(/\]\((?!#)[^)]*\)/); // no `](target)` except pure anchors
    expect(skill).not.toMatch(/§\d/);
  });
});
