// `fidelity:` is required in every scenario (since 4.0.0). A doc snippet that shows a scenario without it
// teaches readers to write a file the loader refuses. This walks every fenced ```yaml block in the user
// docs and the skill's references, and requires each block with a TOP-LEVEL `prompt:` (a scenario, not a
// session or matrix file) to name a tier at top level too.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const ROOTS = ["README.md", "SPEC.md", "docs", ".claude/skills/cowork-harness"];

// Tracked files only: a gitignored local file (e.g. private notes under docs/) must not change the verdict
// between a developer's machine and CI.
function markdownFiles(): string[] {
  const tracked = execFileSync("git", ["ls-files", "-z", "--", ...ROOTS], { encoding: "utf8" })
    .split("\0")
    .filter((p) => p.endsWith(".md") && !p.includes("/_vendor/"));
  return tracked;
}

/** Fenced ```yaml / ```yml blocks, with the 1-based line the block opens on. */
function yamlBlocks(text: string): { line: number; body: string[] }[] {
  const lines = text.split("\n");
  const blocks: { line: number; body: string[] }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^(\s*)```ya?ml\s*$/.exec(lines[i]);
    if (!open) continue;
    const indent = open[1].length;
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length && !/^\s*```\s*$/.test(lines[j]); j++) body.push(lines[j].slice(indent));
    blocks.push({ line: i + 1, body });
    i = j;
  }
  return blocks;
}

describe("doc snippets that show a scenario name its `fidelity:`", () => {
  it("every fenced yaml block with a top-level `prompt:` also has a top-level `fidelity:`", () => {
    const offenders: string[] = [];
    let scenarios = 0;
    for (const f of markdownFiles()) {
      for (const b of yamlBlocks(readFileSync(f, "utf8"))) {
        if (!b.body.some((l) => /^prompt:/.test(l))) continue;
        scenarios++;
        if (!b.body.some((l) => /^fidelity:/.test(l))) offenders.push(`${f}:${b.line}`);
      }
    }
    // The walk must be seeing scenarios at all, or an empty offender list proves nothing.
    expect(scenarios).toBeGreaterThan(5);
    expect(offenders, "add `fidelity: <tier>` to each snippet (it is required since 4.0.0)").toEqual([]);
  });
});
