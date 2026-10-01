// A recorded transcript's non-assistant/user lines are never committed. Real runs' transcripts carry agent-binary
// text that is not ours to publish: the built-in sub-agent prompt (a `prompt_snapshot` attachment), the tool and
// agent listings, and the frame the binary wraps around a sub-agent's report. This guard covers every committed
// transcript (.jsonl under test/fixtures/ and examples/); the pre-commit hook stops a new one at the door.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const jsonl = (d: string): string[] =>
  readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? jsonl(p) : n.endsWith(".jsonl") ? [p] : [];
  });

const SENTINELS = [
  "You are an agent for Claude Code",
  "Anthropic's official CLI",
  "prompt_snapshot",
  "[Subagent hand-back]",
  "use SendMessage with to:",
];

const files = [...jsonl(join(REPO, "test", "fixtures")), ...jsonl(join(REPO, "examples"))];

describe("committed transcripts carry no agent-binary text", () => {
  it("there are transcripts to check (the guard is not vacuous)", () => {
    expect(files.length).toBeGreaterThan(0);
  });
  for (const f of files)
    it(relative(REPO, f), () => {
      const text = readFileSync(f, "utf8");
      expect(/"type":\s*"attachment"/.test(text), `${relative(REPO, f)} has an attachment line`).toBe(false);
      for (const s of SENTINELS) expect(text.includes(s), `${relative(REPO, f)} contains ${s}`).toBe(false);
    });
});

// Tests that build SYNTHETIC transcript lines in code (not a .jsonl fixture). They must carry the frame SHAPES
// only: "prompt_snapshot" is allowed as the shape's type name, but the withheld built-in parts stay placeholder
// strings, so a re-capture from a real run can never bring the built-in prompt back in through a test file.
const SYNTHETIC_SHAPE_TESTS: Array<{ file: string; placeholder: string }> = [
  {
    file: "test/hillclimb-subagent-system.test.ts",
    placeholder: 'const BUILTIN = ["BUILTIN-PART-0", "BUILTIN-PART-1", "BUILTIN-PART-2", "BUILTIN-PART-3"];',
  },
];

describe("in-code synthetic transcript lines carry shapes, never agent-binary text", () => {
  for (const { file, placeholder } of SYNTHETIC_SHAPE_TESTS)
    it(file, () => {
      const text = readFileSync(join(REPO, file), "utf8");
      for (const s of SENTINELS.filter((x) => x !== "prompt_snapshot")) expect(text.includes(s), `${file} contains ${s}`).toBe(false);
      expect(text.includes(placeholder), `${file}: the withheld parts must stay the literal placeholders`).toBe(true);
      // the placeholder array is the only systemPrompt source
      expect(text.match(/systemPrompt:/g)?.length, `${file}: one systemPrompt literal`).toBe(1);
    });
});
