import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Anti-drift guard: the three docs that show a copy-pasteable `uses: yaniv-golan/cowork-harness@…`
// snippet must stay truthful against action.yml — the actual contract. Source of truth = action.yml's
// `inputs:` block (parsed below, not hardcoded), so a new/renamed/removed input can't silently drift
// the docs out of sync. Token-free: pure text parsing, no CLI invocation.
const DOC_FILES = ["README.md", ".claude/skills/cowork-harness/SKILL.md", ".claude/skills/cowork-harness/references/ci-recipe.md"];

const actionYml = readFileSync(resolve("action.yml"), "utf8");
const inputsIdx = actionYml.indexOf("\ninputs:");
const outputsIdx = actionYml.indexOf("\noutputs:", inputsIdx);
const inputsBlock = actionYml.slice(inputsIdx, outputsIdx === -1 ? undefined : outputsIdx);
// Top-level input names are 2-space-indented `<name>:` lines with nothing else on the line (the nested
// description/required/default fields are indented 4+ spaces, so they don't match).
const inputNames = [...inputsBlock.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9_-]*):\s*$/gm)].map((m) => m[1]);

// `command`'s description prose enumerates the valid subcommands as `a | b | c` up to the first
// period ("...subcommand to run: replay | lint | ... | run. `lint` and..."). `[^.]+` spans the line
// wrap inside the YAML `>-` block scalar; trim() below drops the wrap's leading newline/indent.
const commandEnumMatch = inputsBlock.match(/subcommand to run:\s*([^.]+)\./);
const validCommands = (commandEnumMatch?.[1] ?? "")
  .split("|")
  .map((s) => s.trim())
  .filter(Boolean);

it("parsed a sane action.yml input/command set", () => {
  // sanity: catches a parser that silently resolved to an empty set on an action.yml reformat
  expect(inputNames.length).toBeGreaterThan(5);
  expect(inputNames).toContain("command");
  expect(inputNames).toContain("anthropic-api-key");
  expect(validCommands.length).toBeGreaterThan(3);
  expect(validCommands).toContain("replay");
  expect(validCommands).toContain("run");
});

// No `v1` (or any) tag has been published for this repo's GitHub Action — a doc referencing an
// unpublished tag would send a copy-pasting reader to a `uses:` that 404s. `main` is the only ref
// that's actually resolvable today; revisit pinning a moving major-version tag once 1.0.0 ships.
describe("Action docs: yaniv-golan/cowork-harness ref policy", () => {
  const REF_RE = /yaniv-golan\/cowork-harness@([^\s`"']+)/g;

  for (const file of DOC_FILES) {
    it(`${file} only references @main`, () => {
      const text = readFileSync(resolve(file), "utf8");
      const refs = [...text.matchAll(REF_RE)].map((m) => m[1]);
      const bad = refs.filter((r) => r !== "main");
      expect(bad, `${file} references a yaniv-golan/cowork-harness ref other than "main": ${bad.join(", ")}`).toEqual([]);
    });
  }
});

// Pragmatic, line-based YAML extraction (no new dependency): within a fenced ```yaml block, find every
// `uses: yaniv-golan/cowork-harness@…` step, then collect its `with:` mapping — the immediate next
// non-blank line if it's `with:`, then every following line more indented than `with:` until dedent.
interface UsesBlock {
  commandValue: string | null;
  withKeys: string[];
}

function extractUsesBlocks(text: string): UsesBlock[] {
  const blocks: UsesBlock[] = [];
  for (const fence of text.matchAll(/```yaml\n([\s\S]*?)```/g)) {
    const lines = fence[1].split("\n");
    for (let i = 0; i < lines.length; i++) {
      const usesMatch = lines[i].match(/^(\s*)-?\s*uses:\s*yaniv-golan\/cowork-harness@/);
      if (!usesMatch) continue;
      const usesIndent = usesMatch[1].length;

      let withIndent = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === "") continue;
        const indent = lines[j].match(/^(\s*)/)![1].length;
        if (indent > usesIndent) {
          const withMatch = lines[j].match(/^\s*with:\s*$/);
          if (withMatch) withIndent = indent;
        }
        break; // only the immediate next non-blank line can be `with:` in this step layout
      }
      if (withIndent === -1) {
        blocks.push({ commandValue: null, withKeys: [] });
        continue;
      }

      const withKeys: string[] = [];
      let commandValue: string | null = null;
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j];
        if (line.trim() === "") continue;
        const indent = line.match(/^(\s*)/)![1].length;
        if (indent <= withIndent) break;
        const kv = line.match(/^\s*([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/);
        if (!kv) continue;
        withKeys.push(kv[1]);
        if (kv[1] === "command") commandValue = kv[2].replace(/#.*$/, "").trim();
      }
      blocks.push({ commandValue, withKeys });
    }
  }
  return blocks;
}

describe("Action docs: `with:` blocks match action.yml's inputs and command enum", () => {
  const perFile = DOC_FILES.map((file) => ({
    file,
    blocks: extractUsesBlocks(readFileSync(resolve(file), "utf8")),
  }));
  const totalBlocks = perFile.reduce((n, f) => n + f.blocks.length, 0);

  it("found at least one fenced `uses: yaniv-golan/cowork-harness@` block across the docs", () => {
    // Fail loudly (not a silent vacuous pass) if the fence format changed and the extractor stopped
    // matching anything — same anti-false-pass discipline the other docs-sync tests use for their anchors.
    expect(totalBlocks, "no fenced yaml `uses: yaniv-golan/cowork-harness@` block was found in any doc file").toBeGreaterThan(0);
  });

  for (const { file, blocks } of perFile) {
    if (blocks.length === 0) continue; // this file has no fenced uses: block (e.g. only inline prose)

    it(`${file}: every \`with:\` key is a real action.yml input`, () => {
      const badKeys = blocks.flatMap((b) => b.withKeys.filter((k) => !inputNames.includes(k)));
      expect(badKeys, `${file} has a with: key not in action.yml's inputs: ${badKeys.join(", ")}`).toEqual([]);
    });

    it(`${file}: every \`command:\` value is one of action.yml's documented subcommands`, () => {
      const badCommands = blocks.map((b) => b.commandValue).filter((c): c is string => c !== null && !validCommands.includes(c));
      expect(badCommands, `${file} sets command: to a value not in action.yml's enum: ${badCommands.join(", ")}`).toEqual([]);
    });
  }
});
