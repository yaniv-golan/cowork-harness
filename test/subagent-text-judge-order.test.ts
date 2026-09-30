import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureSubagentReasoningThenJudge } from "../src/run/execute.js";
import { evaluate, type AssertContext, type SemanticJudge } from "../src/assert.js";
import { attributeSubagentSkills } from "../src/run/timeline-fold.js";
import type { Assertion, RunResult } from "../src/types.js";

// `semantic_matches: {include_subagent_text: true}` folds sub-agent `reasoning[]` text turns into the judged
// document. That channel is filled from the child transcripts on disk, so it has to be captured BEFORE the
// judge runs, onto the same objects the judge's ctx reads and the result persists. The tests in
// semantic-assert.test.ts hand the judge a ctx with `reasoning` already filled, so they could not see a
// capture that ran after the judge — which is how every live run graded without the sub-agent text.

type SubagentEntry = NonNullable<RunResult["subagents"]>[number];

function stageChild(configDirRoot: string, agentId: string, toolUseId: string, lines: unknown[]): void {
  const dir = join(configDirRoot, "projects", "-proj", "parent-session-uuid", "subagents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `agent-${agentId}.meta.json`),
    JSON.stringify({ agentType: "general-purpose", description: "worker", toolUseId, spawnDepth: 1 }),
  );
  writeFileSync(join(dir, `agent-${agentId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

const assistant = (content: unknown[]) => ({ type: "assistant", message: { role: "assistant", content } });

function capturingJudge(): { judge: SemanticJudge; received: string[] } {
  const received: string[] = [];
  const judge = (async (rubric: string[], answer: string) => {
    received.push(answer);
    return rubric.map((_, i) => ({ index: i, pass: answer.includes("SUBAGENT-FINDING") }));
  }) as SemanticJudge;
  return { judge, received };
}

function stagedRun() {
  const configRoot = mkdtempSync(join(tmpdir(), "cwh-subagent-judge-order-"));
  stageChild(configRoot, "a1", "toolu_worker", [
    assistant([{ type: "thinking", thinking: "", signature: "sig" }]),
    assistant([{ type: "tool_use", id: "ws1", name: "WebSearch", input: { query: "q" } }]),
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "ws1", content: "hit" }] } },
    assistant([{ type: "text", text: "SUBAGENT-FINDING: the answer is 42." }]),
  ]);
  // The run record's array — the very array the live assert ctx is built over.
  const subagents: SubagentEntry[] = [
    { toolUseId: "toolu_worker", dispatchAgentType: "general-purpose", declaredTools: [], toolsUsed: [], description: "worker" },
  ];
  const ctx = {
    transcript: "main loop said nothing about it",
    finalMessage: "done",
    subagents,
  } as unknown as AssertContext;
  return { configRoot, subagents, ctx };
}

describe("live grading: sub-agent reasoning is captured before the judge runs", () => {
  it("include_subagent_text: the judge receives the sub-agent's text, and the fingerprint records it", async () => {
    const { configRoot, subagents, ctx } = stagedRun();
    const { judge, received } = capturingJudge();
    const a: Assertion = { semantic_matches: { rubric: ["the sub-agent found the answer"], include_subagent_text: true } };
    await captureSubagentReasoningThenJudge({
      subagentConfigRoot: configRoot,
      subagents,
      asserts: [a],
      ctx,
      judges: () => ({ judge }),
    });
    expect(received).toHaveLength(1);
    expect(received[0]).toContain("## Sub-agent output: worker");
    expect(received[0]).toContain("SUBAGENT-FINDING");
    const [r] = evaluate([a], ctx);
    expect(r.pass).toBe(true);
    expect(r.judgedDoc?.sections.map((s) => s.kind)).toEqual(["final", "transcript", "subagent"]);
  });

  it("the captured reasoning is what the result persists — once, and by reference through skill attribution", async () => {
    const { configRoot, subagents, ctx } = stagedRun();
    await captureSubagentReasoningThenJudge({
      subagentConfigRoot: configRoot,
      subagents,
      asserts: [],
      ctx,
      judges: () => {
        throw new Error("no semantic_matches assert — the judge must not be built (it can spend)");
      },
    });
    // Captured even with no semantic assert: result.json carries reasoning on every live run.
    expect(subagents[0].reasoning?.map((t) => t.kind)).toEqual(["thinking", "text"]);
    expect(subagents[0].webSearches).toHaveLength(1);
    // result.subagents is attributeSubagentSkills' shallow copy when a timeline exists; it must carry the
    // same capture, not a second one.
    const persisted = attributeSubagentSkills(subagents, [
      { type: "subagent_dispatch", toolUseId: "toolu_worker", skillScope: "demo" } as never,
    ]);
    expect(persisted[0].reasoning).toBe(subagents[0].reasoning);
    expect(persisted[0].webSearches).toHaveLength(1);
  });

  it("no config root (protocol tier / replay): no capture, the judge still runs, the section is absent", async () => {
    const { subagents, ctx } = stagedRun();
    const { judge, received } = capturingJudge();
    const a: Assertion = { semantic_matches: { rubric: ["x"], include_subagent_text: true } };
    await captureSubagentReasoningThenJudge({ subagentConfigRoot: undefined, subagents, asserts: [a], ctx, judges: () => ({ judge }) });
    expect(subagents[0].reasoning).toBeUndefined();
    expect(received[0]).not.toContain("Sub-agent output");
  });
});

// executeScenario itself needs a real agent spawn to drive, so its use of the helper is pinned on the
// source — same approach as the beginTurn wiring guard. Anchored to statements at line start, so a
// commented-out call does not satisfy it.
describe("executeScenario wiring", () => {
  const SRC = readFileSync(join(import.meta.dirname, "..", "src", "run", "execute.ts"), "utf8");
  const statement = (re: string) => new RegExp(`^\\s*(?:await )?${re}`, "gm");

  it("the success path grades through the capture-then-judge helper, before evaluate()", () => {
    const call = SRC.search(statement("captureSubagentReasoningThenJudge\\(\\{"));
    const evalCall = SRC.search(/^\s*const assertions = evaluate\(scenario\.assert, assertCtx\);/m);
    expect(call, "executeScenario no longer calls captureSubagentReasoningThenJudge").toBeGreaterThan(-1);
    expect(evalCall, "the evaluate() call moved — re-anchor this guard").toBeGreaterThan(-1);
    expect(call).toBeLessThan(evalCall);
  });

  it("the only runSemanticJudges call is inside the helper", () => {
    // A direct call from executeScenario would bypass the capture and grade without sub-agent text again.
    const calls = [...SRC.matchAll(statement("runSemanticJudges\\("))];
    const helperStart = SRC.indexOf("export async function captureSubagentReasoningThenJudge(");
    const helperEnd = SRC.indexOf("/** Groups of assertions that cannot all hold.");
    expect(helperStart, "the helper moved or was renamed — re-anchor this guard").toBeGreaterThan(-1);
    expect(helperEnd, "the marker after the helper moved — re-anchor this guard").toBeGreaterThan(helperStart);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.index).toBeGreaterThan(helperStart);
    expect(calls[0]!.index).toBeLessThan(helperEnd);
  });

  it("captureSubagentReasoning runs exactly twice: in the helper, and on the partial (no-judge) path", () => {
    // A third call — e.g. the old one after assembleRunResult — would append each sub-agent's webSearches twice.
    const calls = [...SRC.matchAll(statement("(?:if \\([\\w.]+\\) )?captureSubagentReasoning\\("))];
    expect(calls).toHaveLength(2);
  });
});
