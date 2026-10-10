// A sub-agent that hits the account's usage limit: the main loop narrates it and ends its turn `success`, so before
// 4.7.1 the run graded `delivered_clean`. The frames below are synthetic, built from the SHAPES the agent emits
// (`task_started` → `task_updated{patch:{status:"failed", error}}` → `task_notification{status:"failed", summary}` →
// the Task tool_result → main-loop prose → `result success`).
import { describe, it, expect } from "vitest";
import { Run } from "../src/run/run.js";
import { parseMessage, type AgentEvent, type AgentSession, type DecisionResponse } from "../src/agent/session.js";
import { ScriptedDecider } from "../src/decide/decider.js";
import { computeVerdict } from "../src/run/verdict.js";
import { deriveOutcome } from "../src/run/outcome.js";
import { classifyTermination } from "../src/eval/classify.js";
import { SUBAGENT_USAGE_LIMIT } from "../src/usage-limit.js";
import type { RunResult } from "../src/types.js";

class MockSession implements AgentSession {
  constructor(private events: AgentEvent[]) {}
  async *start(): AsyncIterable<AgentEvent> {
    for (const e of this.events) yield e;
  }
  sendUserTurn() {}
  respond(_id: string, _r: DecisionResponse) {
    return { delivered: true };
  }
  close() {}
}

// The agent's wrapper around a sub-agent's API error, with a generic terminal-limit sentence inside. `rate_limit`
// (the error type) must not read as the transient "rate limit" wording the matcher excludes.
const LIMIT = "You've hit your org's monthly usage limit";
const WRAPPED = `Agent terminated early due to an API error: ${LIMIT} (error type rate_limit, HTTP 429, request id req_test)`;

const sys = (subtype: string, data: Record<string, unknown>): AgentEvent => ({ type: "system_event", subtype, data });
const dispatch = (toolUseId: string, type = "research"): AgentEvent[] => [
  { type: "tool_use", name: "Agent", input: { subagent_type: type, description: "d", prompt: "p" }, toolUseId },
  { type: "subagent_dispatch", toolUseId, dispatchAgentType: type, typeOmitted: false, declaredTools: [] },
  sys("task_started", { task_id: `task-${toolUseId}`, tool_use_id: toolUseId, subagent_type: type, task_type: "local_agent" }),
];
const failed = (toolUseId: string, error = WRAPPED, summary = error, isError = true): AgentEvent[] => [
  sys("task_updated", { task_id: `task-${toolUseId}`, patch: { status: "failed", end_time: 1, error } }),
  sys("task_notification", { task_id: `task-${toolUseId}`, tool_use_id: toolUseId, status: "failed", output_file: "", summary }),
  { type: "tool_result", toolUseId, isError, text: error },
];
const completed = (toolUseId: string, text = "done"): AgentEvent[] => [
  sys("task_updated", { task_id: `task-${toolUseId}`, patch: { status: "completed", end_time: 1 } }),
  sys("task_notification", { task_id: `task-${toolUseId}`, tool_use_id: toolUseId, status: "completed", output_file: "", summary: text }),
  { type: "tool_result", toolUseId, isError: false, text },
];
const narrate: AgentEvent = { type: "assistant_text", text: `The research step stopped: "${LIMIT}". I finished the summary myself.` };
const success: AgentEvent = { type: "result", isError: false, subtype: "success" };

const drive = (events: AgentEvent[]) => new Run(new MockSession(events), new ScriptedDecider([])).drive("go");

/** The graded view of a drive: the fields verdict/outcome/eval read, on a minimal RunResult. */
async function graded(events: AgentEvent[]) {
  const rec = await drive(events);
  const r: RunResult = {
    scenario: "t",
    fidelity: "container",
    baseline: "x",
    result: rec.result,
    resultErrorKind: rec.resultErrorKind,
    errorSource: rec.errorSource,
    decisions: rec.decisions,
    egress: [],
    assertions: [],
    outDir: "/tmp/x",
  } as RunResult;
  const verdict = computeVerdict(r, "live");
  return { rec, r, verdict, outcome: deriveOutcome({ ...r, verdict }) };
}

describe("a sub-agent that hits the usage limit fails the run (usage_limit), whatever the main loop did", () => {
  it("main loop ends success after a sub-agent's quota failure → error / usage_limit / agent, outcome errored", async () => {
    const { rec, verdict, outcome } = await graded([...dispatch("toolu_a"), ...failed("toolu_a"), narrate, success]);
    expect(rec.result).toBe("error");
    expect(rec.resultErrorKind).toBe("usage_limit");
    expect(rec.errorSource).toBe("agent");
    expect(outcome).toBe("errored");
    expect(verdict.pass).toBe(false); // the predicate `record` refuses on (without --allow-failing)
    const sig = verdict.signals.find((s) => s.code === "usage_limit");
    expect(sig?.severity).toBe("fail");
    // The source (`agent`) does not say where it came from; the message does.
    expect(sig?.message).toContain(`a sub-agent (toolu_a, research) hit a usage/quota limit: ${WRAPPED}`);
    const row = rec.decisions.find((d) => d.name === SUBAGENT_USAGE_LIMIT);
    expect(row).toMatchObject({
      kind: "tool",
      decision: "error",
      by: "agent",
      detail: { toolUseId: "toolu_a", subagentType: "research", taskId: "task-toolu_a" },
    });
  });

  it("the Task tool_result reads is_error:false (partial output salvaged) — still flagged: the carrier is the task update", async () => {
    const { rec } = await graded([...dispatch("toolu_a"), ...failed("toolu_a", WRAPPED, WRAPPED, false), narrate, success]);
    expect([rec.result, rec.resultErrorKind]).toEqual(["error", "usage_limit"]);
  });

  it("recovery: a later sub-agent completes and the main loop delivers — still usage_limit (the lost work is unproven)", async () => {
    const { rec, outcome } = await graded([
      ...dispatch("toolu_a"),
      ...failed("toolu_a"),
      ...dispatch("toolu_b"),
      ...completed("toolu_b"),
      narrate,
      success,
    ]);
    expect([rec.result, rec.resultErrorKind, rec.errorSource]).toEqual(["error", "usage_limit", "agent"]);
    expect(outcome).toBe("errored");
  });

  it("sticky across turns: a clean second turn does not clear a first turn's sub-agent quota failure", async () => {
    const turns = (async function* () {
      yield "turn 1";
      yield "turn 2";
    })();
    const rec = await new Run(
      new MockSession([...dispatch("toolu_a"), ...failed("toolu_a"), success, { type: "assistant_text", text: "ok" }, success]),
      new ScriptedDecider([]),
    ).drive(turns);
    expect([rec.result, rec.resultErrorKind]).toEqual(["error", "usage_limit"]);
  });

  it("an already-errored run keeps its source and gains the kind; the prior label is kept on the row", async () => {
    const { rec } = await graded([
      ...dispatch("toolu_a"),
      ...failed("toolu_a"),
      { type: "result", isError: true, subtype: "error_max_turns", resultText: "Reached maximum number of turns" },
    ]);
    expect([rec.result, rec.resultErrorKind, rec.errorSource]).toEqual(["error", "usage_limit", "result"]);
    const row = rec.decisions.find((d) => d.name === SUBAGENT_USAGE_LIMIT);
    expect((row?.detail as { prior?: string }).prior).toBe("agent / result / error_max_turns");
  });

  it("the main loop's own 429 usage_limit is unchanged (source result)", async () => {
    const { rec } = await graded([
      ...dispatch("toolu_a"),
      ...failed("toolu_a"),
      { type: "result", isError: true, subtype: "success", resultText: LIMIT, apiErrorStatus: 429 },
    ]);
    expect([rec.result, rec.resultErrorKind, rec.errorSource]).toEqual(["error", "usage_limit", "result"]);
  });

  it("eval buckets it errored_infra (kind_usage_limit), not as the skill's pass or failure", async () => {
    const { r } = await graded([...dispatch("toolu_a"), ...failed("toolu_a"), narrate, success]);
    const c = classifyTermination({ result: r });
    expect([c.bucket, c.rule]).toEqual(["errored_infra", "kind_usage_limit"]);
  });
});

describe("not flagged: the limit text anywhere but a sub-agent task's failure error", () => {
  it("model prose, a WebSearch tool_result and a COMPLETED sub-agent quoting the limit → success, delivered_clean", async () => {
    const { rec, outcome } = await graded([
      { type: "tool_use", name: "WebSearch", input: { query: "q" }, toolUseId: "toolu_w" },
      { type: "tool_result", toolUseId: "toolu_w", isError: true, text: LIMIT },
      ...dispatch("toolu_b"),
      ...completed("toolu_b", `The page said: ${LIMIT}`),
      narrate,
      success,
    ]);
    expect([rec.result, rec.resultErrorKind]).toEqual(["success", undefined]);
    expect(outcome).toBe("delivered_clean");
  });

  it("a failed sub-agent with a non-limit error, or a transient rate-limit wording → not flagged", async () => {
    for (const error of [
      "Agent terminated early due to an API error: Internal server error",
      "You've hit a rate limit, please try again",
    ]) {
      const { rec } = await graded([...dispatch("toolu_a"), ...failed("toolu_a", error), success]);
      expect([rec.result, rec.resultErrorKind], error).toEqual(["success", undefined]);
    }
  });

  it("a failed notification whose summary (the model-written description) quotes the limit, with a non-limit error → not flagged", async () => {
    const { rec } = await graded([
      ...dispatch("toolu_a"),
      ...failed("toolu_a", "Agent stopped: tool crashed", `retry after ${LIMIT}`),
      success,
    ]);
    expect(rec.result).toBe("success");
  });

  it("a failed background SHELL task whose error carries the text → not flagged (not an agent)", async () => {
    const { rec } = await graded([
      sys("task_started", { task_id: "task-sh", tool_use_id: "toolu_sh", task_type: "local_bash" }),
      sys("task_updated", { task_id: "task-sh", patch: { status: "failed", error: WRAPPED } }),
      success,
    ]);
    expect(rec.result).toBe("success");
  });
});

describe("the raw stream frame reaches the detector", () => {
  it("parseMessage passes a task_updated failure through as a system_event carrying patch.error", () => {
    const evs = parseMessage({
      type: "system",
      subtype: "task_updated",
      task_id: "t1",
      patch: { status: "failed", end_time: 1, error: WRAPPED },
    });
    expect(evs).toEqual([
      { type: "system_event", subtype: "task_updated", data: { task_id: "t1", patch: { status: "failed", end_time: 1, error: WRAPPED } } },
    ]);
  });

  it("drives end to end from raw frames", async () => {
    const raw = [
      {
        type: "system",
        subtype: "task_started",
        task_id: "t1",
        tool_use_id: "toolu_r",
        subagent_type: "research",
        task_type: "local_agent",
      },
      { type: "system", subtype: "task_updated", task_id: "t1", patch: { status: "failed", end_time: 1, error: WRAPPED } },
      { type: "result", subtype: "success", is_error: false, num_turns: 3 },
    ].flatMap((m) => parseMessage(m));
    const rec = await drive(raw);
    expect([rec.result, rec.resultErrorKind, rec.errorSource]).toEqual(["error", "usage_limit", "agent"]);
  });
});
