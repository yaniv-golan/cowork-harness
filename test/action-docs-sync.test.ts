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

// The documented `uses:` ref must be the CURRENT major's alias tag — `@v<major of package.json>`.
//
// This used to require `@main`, for a good reason at the time: no alias tag had ever been published, so a
// doc naming one would have sent a copy-pasting reader to a `uses:` that 404s. Its own note said to revisit
// "once 1.0.0 ships". Two things have since changed, and together they are what make an alias safe to
// recommend: `v2`/`v2.0` exist and point at a real release, and `release.yml` now MOVES them on every
// stable release instead of leaving it to a checklist — which is what had let `v1` sit at 1.24.0 for two
// releases. Recommending a floating tag nobody remembers to move is worse than recommending `@main`; that
// is no longer the situation.
//
// Derived from `package.json` rather than hardcoded, so the next major forces these docs to move with it
// instead of silently pointing a reader at the previous line. `@main` is deliberately NOT allowed here: a
// consumer-facing recipe should name a ref that is stable within a major, and permitting both would let the
// recommendation drift back without anything noticing.
describe("Action docs: yaniv-golan/cowork-harness ref policy", () => {
  const REF_RE = /yaniv-golan\/cowork-harness@([^\s`"']+)/g;
  const major = (JSON.parse(readFileSync(resolve("package.json"), "utf8")).version as string).split(".")[0];
  const expected = `v${major}`;

  it(`derives the expected ref from package.json (currently @${expected})`, () => {
    // Never go green because the version read produced junk and every ref "matched" nothing.
    expect(major).toMatch(/^\d+$/);
  });

  for (const file of DOC_FILES) {
    it(`${file} references only @${expected}`, () => {
      const text = readFileSync(resolve(file), "utf8");
      const refs = [...text.matchAll(REF_RE)].map((m) => m[1]);
      expect(refs.length, `${file} names the Action nowhere — the ref policy would be vacuous`).toBeGreaterThan(0);
      const bad = refs.filter((r) => r !== expected);
      expect(
        bad,
        `${file} references a yaniv-golan/cowork-harness ref other than "${expected}" (the current major's ` +
          `alias, moved automatically by release.yml): ${bad.join(", ")}`,
      ).toEqual([]);
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

// Every copy-pasteable Action step must PIN the CLI major via `version: "^<major>"`.
//
// The `version` input defaults to `latest`, so a step that omits it takes a CLI major the moment one is
// promoted — even though its `uses:` ref never changed. A release that bounded every published npm floor
// still shipped recipes with no `version:` at all, which left the one remaining unbounded form in the
// copy-paste path. Guarding the FORM of a floor (no bare `>=`) does not guarantee a floor is PRESENT;
// this pins the behaviour instead.
//
// A consumer reading these snippets copies them verbatim, so "the prose explains `^2` further down" is
// not sufficient — the snippet is the artifact.
describe("copy-pasteable Action steps pin the CLI major", () => {
  const major = JSON.parse(readFileSync(resolve("package.json"), "utf8")).version.split(".")[0];

  /** Steps = a `uses:` line inside a fenced block, i.e. YAML a reader copies. An inline prose mention
   *  (backticked, no `with:` block) is excluded: there is nothing to pin. */
  const steps = DOC_FILES.flatMap((f) => {
    const lines = readFileSync(resolve(f), "utf8").split("\n");
    return lines.flatMap((l, i) => {
      if (!l.includes("uses: yaniv-golan/cowork-harness@") || l.includes("`")) return [];
      const block: string[] = [];
      for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
        const s = lines[j];
        if (s.trim() === "" || s.trim().startsWith("```") || /^\s*-\s+(uses|name):/.test(s)) break;
        block.push(s);
      }
      return block.some((b) => b.trim().startsWith("with:")) ? [{ file: f, line: i + 1, block }] : [];
    });
  });

  it("found the steps (a parser that matches nothing would pass every assertion below)", () => {
    expect(steps.length).toBeGreaterThanOrEqual(5);
  });

  it.each(steps.map((s) => [`${s.file}:${s.line}`, s] as const))('%s pins version: "^%s"', (_label, s) => {
    const v = s.block.find((b) => b.trim().startsWith("version:"));
    expect(v, `no \`version:\` input — it would default to \`latest\` and take a CLI major unasked`).toBeTruthy();
    expect(v!.trim(), `must hold the current major`).toMatch(new RegExp(`^version:\\s*"\\^${major}"`));
  });
});
