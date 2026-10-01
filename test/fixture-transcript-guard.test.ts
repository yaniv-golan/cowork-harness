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
