import { describe, it, expect } from "vitest";
import { subagentSkillCalls } from "../src/critique/skill-invocation.js";

// A line of events.jsonl that parses to a JSON scalar (`null`, a number) is not an event. It must be skipped
// like a torn line, not crash the reader (`null.type` throws) and lose the whole invocation verdict.
describe("subagentSkillCalls tolerates non-object lines", () => {
  it("skips null / scalar lines and still reads a real sub-agent Skill call", () => {
    const call = JSON.stringify({
      type: "assistant",
      parent_tool_use_id: "toolu_1",
      message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "p:x" } }] },
    });
    expect(subagentSkillCalls(["null", "42", '"s"', call].join("\n"))).toEqual(["p:x"]);
  });
});
