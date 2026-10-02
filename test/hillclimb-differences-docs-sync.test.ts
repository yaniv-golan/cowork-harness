// docs/hillclimb.md owns the list of differences between `hillclimb run` and the `/claude-api hillclimb` guide's
// own runner. The loop agent never reads docs/: it reads the companion skill's references/hillclimb-recipe.md. So
// every difference must also have its "what to do" line in the recipe. Both lists open each entry with a bold
// lead; this test pairs them through the table below, so a difference added to one page without the other fails
// here, by name.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** The bold leads of the top-level bullets under the first `## <heading>` that starts with `heading`. */
function leads(text: string, heading: string): string[] {
  const start = text.indexOf(`\n## ${heading}`);
  expect(start, `no "## ${heading}" section`).toBeGreaterThan(-1);
  const rest = text.slice(start + 1);
  const next = rest.indexOf("\n## ");
  const section = next === -1 ? rest : rest.slice(0, next);
  return [...section.matchAll(/^- \*\*(.+?)\*\*/gm)].map((m) => m[1].replace(/[.:]$/, ""));
}

/** docs/hillclimb.md lead → recipe lead. */
const PAIRS: Record<string, string> = {
  "Scenarios are single-prompt": "Single-prompt scenarios",
  "Anthropic's built-in system prompt is withheld": "System prompt withheld",
  "The full report viewer is untested": "Full report viewer untested",
  "`cost_usd` is the agent's reported total, not a derivation": "`cost_usd` is the reported total",
  "The kept runs and snapshots live outside the flow dir": "Kept runs and snapshots outside the flow dir",
  "Each variant runs a snapshot of the plugin's git-tracked files": "Git-tracked snapshot",
  "The lever is the plugin": "The lever is the plugin",
  "A missing reference is refused before spending": "Missing reference refused",
  Timeouts: "Timeouts",
  "A workspace fixture starts with a fresh conversation": "Workspace fixture, fresh conversation",
  "`_state.json` gains `harness_skill`": "`harness_skill` in `_state.json`",
  "`tags`": "`tags` = the scenario's directory name",
  "No refusal class": "No refusal class",
};

describe("every difference from the guide's runner has its line in the loop's recipe", () => {
  const docs = leads(read("docs/hillclimb.md"), "Differences from the loop's own runner");
  const recipe = leads(read(".claude/skills/cowork-harness/references/hillclimb-recipe.md"), "Differences from the guide's own runner");

  it("reads a non-empty list from both pages", () => {
    expect(docs.length).toBeGreaterThan(5);
    expect(recipe.length).toBeGreaterThan(5);
  });

  it("pairs every difference in docs/hillclimb.md with a recipe line", () => {
    expect(
      docs.filter((d) => !(d in PAIRS)),
      "a difference with no entry in PAIRS: add it, and its recipe line",
    ).toEqual([]);
    expect(
      docs.filter((d) => !recipe.includes(PAIRS[d]!)),
      "a paired recipe line is missing",
    ).toEqual([]);
  });

  it("has no recipe line without a difference behind it", () => {
    const paired = new Set(docs.map((d) => PAIRS[d]));
    expect(recipe.filter((r) => !paired.has(r))).toEqual([]);
  });
});
