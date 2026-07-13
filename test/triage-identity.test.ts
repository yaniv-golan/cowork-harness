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

// The canonical table's "The skill misbehaved" row and docs/debugging.md's prose walkthrough
// (`## The skill misbehaved`, OUTSIDE the triage-canonical block) list the same five tools — they must
// stay in the same order, or a reader following the numbered prose ends up contradicting the table.
describe("debug-triage tool order: canonical table row ↔ numbered prose section", () => {
  const debuggingText = readFileSync(resolve("docs/debugging.md"), "utf8");

  it("the numbered `## The skill misbehaved` walkthrough matches the canonical table row's tool order", () => {
    const skillRow = debuggingText.split("\n").find((l) => l.includes("The skill misbehaved"));
    expect(skillRow, "canonical table row for 'The skill misbehaved' not found").toBeTruthy();
    // Backtick-opened tokens only — canonical cells carry trailing args (`trace <run-dir> --view <view>`),
    // so a closing-backtick-anchored regex would silently drop them.
    const canonicalOrder = [...skillRow!.matchAll(/`([a-z-]+)/g)].map((m) => m[1]);

    const numberedOrder = [...debuggingText.matchAll(/^\d+\.\s+\*\*`([a-z-]+)`/gm)].map((m) => m[1]);

    expect(numberedOrder).toEqual(canonicalOrder);
  });

  it("README.md and docs/README.md debugging blurbs mention all five tools, in canonical order", () => {
    const skillRow = debuggingText.split("\n").find((l) => l.includes("The skill misbehaved"));
    const canonicalOrder = [...skillRow!.matchAll(/`([a-z-]+)/g)].map((m) => m[1]);

    const readme = readFileSync(resolve("README.md"), "utf8");
    const docsIndex = readFileSync(resolve("docs/README.md"), "utf8");
    const llmsTxt = readFileSync(resolve("llms.txt"), "utf8");

    // Scope each check to its specific blurb line (not the whole file — all five names appear dozens
    // of times repo-wide, so a whole-file membership check would be vacuous).
    const proseBlurb = readme.split("\n").find((l) => l.includes("**Debugging a run**"));
    const tableBlurb = readme.split("\n").find((l) => l.startsWith("| [docs/debugging.md](./docs/debugging.md)"));
    const indexBlurb = docsIndex.split("\n").find((l) => l.startsWith("| [debugging.md](./debugging.md)"));
    const llmsBlurb = llmsTxt.split("\n").find((l) => l.startsWith("- [docs/debugging.md]"));
    for (const [label, blurb] of [
      ["README.md prose blurb", proseBlurb],
      ["README.md docs-table row", tableBlurb],
      ["docs/README.md index row", indexBlurb],
      ["llms.txt index row", llmsBlurb],
    ] as const) {
      expect(blurb, `${label} not found`).toBeTruthy();
      const order = [...blurb!.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]).filter((t) => canonicalOrder.includes(t));
      expect(order, label).toEqual(canonicalOrder);
    }
  });
});
