import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { nestedRegexLeaves } from "../src/run/execute.js";

// A bad regex used to reach the evaluator, i.e. AFTER the paid spawn, whenever it lived one level down in an
// assertion object. The first fix for that was a hand-written list of three leaves under a comment claiming
// to cover "nested regex leaves" — it covered 3 of 11. This file exists so the list can never be a list
// again: the leaves are derived from the zod schema, and the derivation is pinned against the evaluator.

/** Every leaf assert.ts actually compiles with compileUserRegex, read out of its source. Deliberately not a
 *  hand list — that is the failure being guarded. */
function leavesTheEvaluatorCompiles(): Set<string> {
  const src = readFileSync("src/assert.ts", "utf8");
  const out = new Set<string>();
  // `compileUserRegex(q.path_matches)` / `compileUserRegex(qc.matches)` — a destructured or aliased holder.
  for (const m of src.matchAll(/compileUserRegex\(\s*([A-Za-z_$][\w$]*)\.([\w$]+)\s*\)/g)) {
    if (m[1] === "a") continue; // `a.<key>` is a TOP-level key, handled by the flat loop
    out.add(m[2]);
  }
  return out;
}

describe("nested regex leaves are validated at LOAD, and the table is guarded against the evaluator", () => {
  const derived = nestedRegexLeaves({
    // One value per nested object in the schema. Anything the derivation finds must appear here or the
    // test below reports it — which is the point: a NEW nested regex field fails this until it is covered.
    artifact_text: { artifact: "x", matches: "a", not_matches: "b" },
    path_denied: { path_matches: "c" },
    question_context: { matches: "d", when_question: "e" },
    question_options: { when_question: "f", equals: [] },
    question_option_count: { matches: "m", when_question: "n", exactly: 1 },
    subagent_dispatch_healthy: { type: "g" },
    subagent_output_contains: { match: "h", contains: "i" },
    skill_tool_used: { skill: "j", tool: "k" },
    task_status: { match: "l", status: "completed" },
  } as unknown as Parameters<typeof nestedRegexLeaves>[0]);

  const labels = derived.map(([l]) => l).sort();

  it("carries every nested regex field in the schema", () => {
    expect(labels).toEqual(
      [
        "artifact_text.matches",
        "artifact_text.not_matches",
        "path_denied.path_matches",
        "question_context.matches",
        "question_context.when_question",
        "question_option_count.matches",
        "question_option_count.when_question",
        "question_options.when_question",
        "skill_tool_used.skill",
        "skill_tool_used.tool",
        "subagent_dispatch_healthy.type",
        "subagent_output_contains.match",
        "task_status.match",
      ].sort(),
    );
  });

  // THE GUARD. If assert.ts compiles a nested field as a regex and the load-time walk does not see it, a bad
  // pattern in that field still costs a spawn before it is reported. That is the defect this file exists for.
  it("covers every nested leaf the evaluator compiles as a regex", () => {
    const covered = new Set(labels.map((l) => l.split(".")[1]));
    const missing = [...leavesTheEvaluatorCompiles()].filter((child) => !covered.has(child));
    expect(
      missing,
      `assert.ts compiles these nested leaves as regexes but load-time validation misses them: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("returns nothing for an assertion with no nested objects, and skips absent leaves", () => {
    expect(nestedRegexLeaves({ transcript_matches: "x" } as Parameters<typeof nestedRegexLeaves>[0])).toEqual([]);
    expect(nestedRegexLeaves({ question_context: { matches: "x" } } as Parameters<typeof nestedRegexLeaves>[0])).toEqual([
      ["question_context.matches", "x"],
    ]);
  });

  // The extractor must be able to SEE something, or the coverage test above passes because it read nothing.
  // A regex that silently stops matching assert.ts turns this file into decoration.
  it("the evaluator-source extractor actually finds leaves (it cannot vacuously pass)", () => {
    const found = leavesTheEvaluatorCompiles();
    expect(found.size).toBeGreaterThan(3);
    expect([...found]).toContain("matches");
    expect([...found]).toContain("path_matches");
  });
});
