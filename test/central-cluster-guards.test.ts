import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, runSemanticJudges, type AssertContext, type SemanticJudge } from "../src/assert.js";
import { parseScenarioFile } from "../src/run/execute.js";
import { parseEgressLine } from "../src/egress/sidecar.js";
import { Run, evidenceErrorsForResult } from "../src/run/run.js";
import { ScriptedDecider } from "../src/decide/decider.js";
import { ABSTAIN, type Decider } from "../src/decide/decider.js";
import type { AgentEvent, AgentSession, DecisionRequest, DecisionResponse, DecisionDelivery } from "../src/agent/session.js";

/** Minimal scripted AgentSession (mirrors the MockSession in run-decisions.test.ts) for driving a Run. */
class MockSession implements AgentSession {
  constructor(private events: AgentEvent[]) {}
  async *start(): AsyncIterable<AgentEvent> {
    for (const e of this.events) yield e;
  }
  sendUserTurn() {}
  respond(_id: string, _r: DecisionResponse): DecisionDelivery {
    return { delivered: true };
  }
  close() {}
}

// Regression tests for the coupled central-cluster fixes implemented directly (findings #6, #7, #8, #9,
// #10, #39). The per-module fixes (samplers, eval-gate, critique, artifacts, session, cassette, …) carry
// their own regression suites; this file pins the ones that span assert.ts / execute.ts / sidecar.ts.

function ctx(over: Partial<AssertContext> = {}): AssertContext {
  return {
    transcript: "",
    toolsCalled: new Set(),
    subagentTools: new Set(),
    egress: [],
    result: "success",
    workRoot: "/nonexistent",
    userVisiblePrefixes: ["outputs", ".projects"],
    outputsDeletes: [],
    questions: [],
    hostPathLeaked: false,
    selfHealRan: false,
    subagents: [],
    gateDeliveries: [],
    toolResultTexts: [],
    skillsInvoked: [],
    skillToolAvailable: true,
    ...over,
  };
}

describe("#5 unpaired TaskCreate / WebSearch calls are reconciled at stream end", () => {
  it("a TaskCreate tool_use whose paired tool_result never arrives bumps evidenceErrors.taskTracking", async () => {
    const ev: AgentEvent[] = [
      { type: "tool_use", name: "TaskCreate", toolUseId: "t1", input: { subject: "deploy" } },
      { type: "result", isError: false },
    ];
    const rec = await new Run(new MockSession(ev), new ScriptedDecider([])).drive("go");
    expect(rec.evidenceErrors.taskTracking).toBeGreaterThan(0);
  });

  it("a WebSearch tool_use whose paired tool_result never arrives bumps evidenceErrors.webSearchParse", async () => {
    const ev: AgentEvent[] = [
      { type: "tool_use", name: "WebSearch", toolUseId: "w1", input: { query: "x" } },
      { type: "result", isError: false },
    ];
    const rec = await new Run(new MockSession(ev), new ScriptedDecider([])).drive("go");
    expect(rec.evidenceErrors.webSearchParse).toBeGreaterThan(0);
  });

  it("a TaskCreate WITH its paired tool_result does not bump taskTracking (no false positive)", async () => {
    const ev: AgentEvent[] = [
      { type: "tool_use", name: "TaskCreate", toolUseId: "t1", input: { subject: "deploy" } },
      { type: "tool_result", toolUseId: "t1", isError: false, text: "Task #5 created successfully: deploy" },
      { type: "result", isError: false },
    ];
    const rec = await new Run(new MockSession(ev), new ScriptedDecider([])).drive("go");
    expect(rec.evidenceErrors.taskTracking).toBe(0);
  });

  it("an unpaired present_files call bumps presentFilesMalformed (no_scratchpad_leak gates on it)", async () => {
    const ev: AgentEvent[] = [
      { type: "tool_use", name: "mcp__cowork__present_files", toolUseId: "p1", input: { files: ["/outputs/a"] } },
      { type: "result", isError: false },
    ];
    const rec = await new Run(new MockSession(ev), new ScriptedDecider([])).drive("go");
    expect(rec.evidenceErrors.presentFilesMalformed).toBeGreaterThan(0);
  });
});

describe("#14/#16 semantic_matches refuses a grade made over incomplete authored evidence", () => {
  it("fails evidence-unavailable when authored files were omitted at the capture cap", () => {
    const a = { semantic_matches: { rubric: ["the skill wrote a valid report"] } };
    const [r] = evaluate(
      [a],
      ctx({
        semanticResults: new Map([[a, [{ index: 0, claim: "the skill wrote a valid report", pass: false }]]]),
        authoredFilesHealth: {
          omittedPaths: ["outputs/report.bin"],
          totalCapExhausted: true,
          readErrors: [],
          hashUnknownPaths: [],
          scratchpadWalkErrors: [],
          scratchpadSkippedLinks: [],
          workspaceWalkErrors: [],
        },
      }),
    );
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/evidence unavailable/);
    expect(r.message).toMatch(/incomplete/);
  });

  it("fails evidence-unavailable when an authored file was unreadable at read-back", () => {
    const a = { semantic_matches: { rubric: ["c"] } };
    const [r] = evaluate(
      [a],
      ctx({
        semanticResults: new Map([[a, [{ index: 0, claim: "c", pass: true }]]]),
        authoredFilesHealth: {
          omittedPaths: [],
          totalCapExhausted: false,
          readErrors: [{ path: "outputs/x", error: "EACCES" }],
          hashUnknownPaths: [],
          scratchpadWalkErrors: [],
          scratchpadSkippedLinks: [],
          workspaceWalkErrors: [],
        },
      }),
    );
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/evidence unavailable/);
  });

  it("grades normally when authored evidence is complete (a resume-only skip does NOT block the verdict)", () => {
    const a = { semantic_matches: { rubric: ["c"] } };
    const passing = new Map([[a, [{ index: 0, claim: "c", pass: true }]]]);
    // complete capture:
    const [ok1] = evaluate([a], ctx({ semanticResults: passing }));
    expect(ok1.pass).toBe(true);
    // scratchpad skipped on resume is informational only (#17) — must NOT force evidence-unavailable:
    const [ok2] = evaluate(
      [a],
      ctx({
        semanticResults: passing,
        authoredFilesHealth: {
          omittedPaths: [],
          totalCapExhausted: false,
          readErrors: [],
          hashUnknownPaths: [],
          scratchpadWalkErrors: [],
          scratchpadSkippedLinks: [],
          workspaceWalkErrors: [],
          scratchpadSkippedOnResume: true,
        },
      }),
    );
    expect(ok2.pass).toBe(true);
  });
});

describe("#39 egressParse reaches result.json (presence-gate fix, not just parseEgressLine)", () => {
  it("a run whose ONLY evidence problem is dropped egress lines still serializes evidenceErrors", () => {
    const e = evidenceErrorsForResult({ evidenceErrors: { taskTracking: 0, webSearchParse: 0, presentFilesMalformed: 0, egressParse: 2 } });
    expect(e).toBeDefined();
    expect(e?.egressParse).toBe(2);
  });

  it("all-zero evidence errors still serialize undefined (no spurious object)", () => {
    expect(
      evidenceErrorsForResult({ evidenceErrors: { taskTracking: 0, webSearchParse: 0, presentFilesMalformed: 0, egressParse: 0 } }),
    ).toBeUndefined();
  });
});

describe("#6 task_status honors known task-telemetry corruption", () => {
  it("fails 'cannot verify (malformed)' when evidenceErrors.taskTracking > 0", () => {
    const [r] = evaluate(
      [{ task_status: { match: "deploy", status: "completed" } }],
      ctx({ tasks: [{ id: "1", subject: "deploy", status: "completed" }], evidenceErrors: { taskTracking: 1 } }),
    );
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/incomplete, cannot verify \(malformed\)/);
  });

  it("evaluates normally when task telemetry is clean (taskTracking absent)", () => {
    const [r] = evaluate(
      [{ task_status: { match: "deploy", status: "completed" } }],
      ctx({ tasks: [{ id: "1", subject: "deploy", status: "completed" }] }),
    );
    expect(r.pass).toBe(true);
  });
});

describe("#9 subagent_output_contains distinguishes a truncated output from an absent substring", () => {
  it("a miss against a TRUNCATED sub-agent output is evidence-unavailable, not a proven absence", () => {
    const [r] = evaluate(
      [{ subagent_output_contains: { match: "researcher", contains: "SECRET" } }],
      ctx({
        subagents: [{ dispatchAgentType: "researcher", declaredTools: [], toolsUsed: [], output: "head only", outputTruncated: true }],
      }),
    );
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/evidence unavailable/);
    expect(r.message).toMatch(/truncated/);
  });

  it("a miss against a COMPLETE sub-agent output is a plain absence (no truncation caveat)", () => {
    const [r] = evaluate(
      [{ subagent_output_contains: { match: "researcher", contains: "SECRET" } }],
      ctx({ subagents: [{ dispatchAgentType: "researcher", declaredTools: [], toolsUsed: [], output: "head only" }] }),
    );
    expect(r.pass).toBe(false);
    expect(r.message).not.toMatch(/evidence unavailable/);
  });
});

describe("#7/#8 tool-glob validation rejects vacuous negatives at scenario load", () => {
  const writeScenario = (assertLine: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "glob-guard-"));
    const p = join(dir, "s.yaml");
    writeFileSync(p, `name: s\nprompt: hi\nassert:\n${assertLine}\n`);
    return p;
  };

  it("rejects an empty tool_not_called glob (#8)", () => {
    expect(() => parseScenarioFile(writeScenario(`  - tool_not_called: ""`))).toThrow(/empty/i);
  });

  it("rejects a regex-habit tool_not_called glob like `Bash|Read` (#7)", () => {
    expect(() => parseScenarioFile(writeScenario(`  - tool_not_called: "Bash|Read"`))).toThrow(/regex or brace-expansion/);
  });

  it("rejects a minimatch brace-expansion glob like `{Bash,Read}` (#7/#8)", () => {
    expect(() => parseScenarioFile(writeScenario(`  - tool_not_called: "{Bash,Read}"`))).toThrow(/regex or brace-expansion/);
  });

  it("accepts a literal tool glob unchanged", () => {
    expect(() => parseScenarioFile(writeScenario(`  - tool_not_called: "WebFetch"`))).not.toThrow();
  });

  it("rejects a bad tool_result_matches regex at scenario load", () => {
    expect(() => parseScenarioFile(writeScenario(`  - tool_result_matches: "("`))).toThrow(/regex/i);
  });

  it("rejects a bad tool_result_not_matches regex at scenario load", () => {
    expect(() => parseScenarioFile(writeScenario(`  - tool_result_not_matches: "("`))).toThrow(/regex/i);
  });
});

describe("#10 the judged document is budget-capped with a truncation marker", () => {
  it("a huge transcript is truncated (bounded input) and marked so the judge can't read the cut as absence", async () => {
    let captured = "";
    const judge: SemanticJudge = async (_rubric, answer) => {
      captured = answer;
      return [{ index: 0, claim: "c", pass: true }];
    };
    const c = ctx({ transcript: "x".repeat(500_000) });
    await runSemanticJudges([{ semantic_matches: { rubric: ["c"] } }], c, judge);
    expect(captured.length).toBeLessThan(300_000); // capped well below the raw 500k
    expect(captured).toMatch(/truncated for the judge input budget/);
    expect(captured).toMatch(/do not infer absence from this cut/);
  });

  it("a secret straddling a cap boundary is fully redacted, not truncated mid-token into the judge input (scrub-before-cap)", async () => {
    let captured = "";
    const judge: SemanticJudge = async (_rubric, answer) => {
      captured = answer;
      return [{ index: 0, claim: "c", pass: true }];
    };
    const SECRET = "SUPERSECRET_TOKEN_ABCDEFGHIJKLMNOP";
    // 40 copies spread across ~200 KB guarantees at least one straddles the (128 KB) transcript cap.
    let transcript = "";
    for (let i = 0; i < 40; i++) transcript += "x".repeat(5000) + SECRET;
    const c = ctx({ transcript, secrets: [SECRET] });
    await runSemanticJudges([{ semantic_matches: { rubric: ["c"] } }], c, judge);
    // With cap-before-scrub, the straddling copy leaks its prefix; scrub-before-cap redacts every copy first.
    expect(captured).not.toContain(SECRET.slice(0, 15));
  });
});

describe("#39 egress parsing drops malformed/unknown-decision lines (health signal source)", () => {
  it("a bare `null`, a scalar, and an unknown decision all drop; a valid deny survives", () => {
    expect(parseEgressLine("null")).toBeNull();
    expect(parseEgressLine("123")).toBeNull();
    expect(parseEgressLine(JSON.stringify({ host: "x", decision: "maybe" }))).toBeNull();
    expect(parseEgressLine(JSON.stringify({ host: "x", decision: "deny" }))).toEqual({ host: "x", decision: "deny" });
  });
});

/** Synthetic `tool_use` AgentEvent builder for driving a Run over a scripted event list. */
function toolUse(
  name: string,
  input: unknown,
  opts: { toolUseId?: string; parentToolUseId?: string; synthetic?: boolean } = {},
): AgentEvent {
  return {
    type: "tool_use",
    name,
    input,
    toolUseId: opts.toolUseId,
    parentToolUseId: opts.parentToolUseId,
    synthetic: opts.synthetic,
  };
}

/** Synthetic `subagent_dispatch` AgentEvent builder — registers a RECOGNIZED dispatch under `toolUseId`.
 *  `opts.typeOmitted` defaults false (an explicit dispatch-input type, the common case in these fixtures). */
function dispatch(toolUseId: string, dispatchAgentType: string, opts: { typeOmitted?: boolean } = {}): AgentEvent {
  return { type: "subagent_dispatch", toolUseId, dispatchAgentType, declaredTools: [], typeOmitted: opts.typeOmitted ?? false };
}

/** Drive a `Run` over a scripted event list (via `MockSession`), auto-appending a terminal `result` event
 *  when the caller's list doesn't already end the stream, and return the finished `RunRecord`. */
async function driveRunOverEvents(events: AgentEvent[]) {
  const withResult = events.some((e) => e.type === "result") ? events : [...events, { type: "result", isError: false } as AgentEvent];
  return new Run(new MockSession(withResult), new ScriptedDecider([])).drive("go");
}

describe("fileToolAttempts — attempt-level path telemetry for gated file tools", () => {
  it("records raw paths (both keys), gatePath = first match, and skips synthetic MCP echoes", async () => {
    const rec = await driveRunOverEvents([
      toolUse("Read", { file_path: "/sessions/x/mnt/outputs/a", path: "/elsewhere" }, { toolUseId: "t1" }),
      toolUse("Grep", { pattern: "x" }, { toolUseId: "t2" }), // pathless — still an entry
      toolUse("Write", { file_path: "/tmp/echo" }, { toolUseId: "t3", synthetic: true }), // NOT recorded
      toolUse("Bash", { command: "ls" }, { toolUseId: "t4" }), // not a gated file tool — NOT recorded
    ]);
    expect(rec.fileToolAttempts).toEqual([
      {
        tool: "Read",
        paths: { file_path: "/sessions/x/mnt/outputs/a", path: "/elsewhere" },
        gatePath: "/sessions/x/mnt/outputs/a",
        origin: "main",
        parentToolUseId: undefined,
        toolUseId: "t1",
      },
      { tool: "Grep", paths: {}, gatePath: undefined, origin: "main", parentToolUseId: undefined, toolUseId: "t2" },
    ]);
  });

  it("origin follows the recognized-dispatch/fork rules, not bare parent-id presence", async () => {
    const rec = await driveRunOverEvents([
      dispatch("d1", "founder-skills:ic-sim"),
      toolUse("Write", { file_path: "artifacts/x.json" }, { toolUseId: "t5", parentToolUseId: "d1" }), // recognized dispatch -> subagent
      toolUse("Skill", { skill: "s" }, { toolUseId: "sk1" }), // fork-scoped parent
      toolUse("Edit", { file_path: "y" }, { toolUseId: "t6", parentToolUseId: "sk1" }), // fork-scoped -> MAIN
      toolUse("Write", { file_path: "z" }, { toolUseId: "t7", parentToolUseId: "not-a-dispatch" }), // unrecognized parent -> unknown, NEVER subagent
    ]);
    expect(rec.fileToolAttempts.find((a) => a.toolUseId === "t5")?.origin).toBe("subagent");
    expect(rec.fileToolAttempts.find((a) => a.toolUseId === "t6")?.origin).toBe("main");
    expect(rec.fileToolAttempts.find((a) => a.toolUseId === "t7")?.origin).toBe("unknown");
  });
});

/** Synthetic `hook_event` AgentEvent builder for driving a Run over a scripted event list — `path`
 *  populates the `path` key of the paired `paths` bag, `filePath` (added for the dual-key regression
 *  coverage below) populates the `file_path` key. Either, both, or neither may be set. */
function hookEvent(opts: {
  callbackId: string;
  decision: "block" | "allow";
  reason?: string;
  tool?: string;
  path?: string;
  filePath?: string;
  toolUseId?: string;
  agentId?: string;
}): AgentEvent {
  return {
    type: "hook_event",
    callbackId: opts.callbackId,
    decision: opts.decision,
    reason: opts.reason,
    tool: opts.tool,
    paths: opts.path !== undefined || opts.filePath !== undefined ? { file_path: opts.filePath, path: opts.path } : undefined,
    toolUseId: opts.toolUseId,
    agentId: opts.agentId,
  };
}

/** Synthetic `system_event` AgentEvent builder. */
function systemEvent(subtype: string, data: Record<string, unknown>): AgentEvent {
  return { type: "system_event", subtype, data };
}

/** Synthetic `subagent_result_meta` AgentEvent builder — the dispatch's paired `tool_use_result` envelope. */
function subagentResultMeta(opts: {
  toolUseId: string;
  resolvedModel?: string;
  agentId?: string;
  agentType?: string;
  status?: string;
}): AgentEvent {
  return { type: "subagent_result_meta", ...opts };
}

describe("subagent_result_meta consumption — resolved child model from the dispatch's envelope", () => {
  it("a tool-free child still gets resolvedModel (envelope-sourced, not parented-assistant-sourced)", async () => {
    const rec = await driveRunOverEvents([
      dispatch("t1", "founder-skills:ic-sim"),
      subagentResultMeta({ toolUseId: "t1", resolvedModel: "claude-haiku-x", agentType: "founder-skills:ic-sim", status: "completed" }),
    ]);
    const sa = rec.subagents.find((s) => s.toolUseId === "t1")!;
    expect(sa.resolvedModel).toBe("claude-haiku-x");
    expect(sa.dispatchModel).toBeUndefined(); // the dispatching-message field is a separate channel, never repurposed
  });
});

describe("task_started family consumption (resolved child type + omission note)", () => {
  it("joins task_started to the dispatch by tool_use_id and records the RESOLVED type", async () => {
    const rec = await driveRunOverEvents([
      dispatch("t1", "unknown", { typeOmitted: true }),
      systemEvent("task_started", { tool_use_id: "t1", subagent_type: "general-purpose", task_type: "local_agent" }),
    ]);
    const sa = rec.subagents.find((s) => s.toolUseId === "t1")!;
    expect(sa.resolvedAgentType).toBe("general-purpose");
    expect(sa.dispatchAgentType).toBe("unknown"); // dispatch-input semantics stay on their own field — never overwritten by the resolved type
    expect(sa.dispatchTypeOmitted).toBe(true);
  });
  it("a task_started with only task_id (no tool_use_id) does NOT join — task_id can't match toolUseId", async () => {
    const rec = await driveRunOverEvents([
      dispatch("t1", "unknown", { typeOmitted: true }),
      systemEvent("task_started", { task_id: "task_99", subagent_type: "general-purpose" }), // task_id ≠ dispatch toolUseId
    ]);
    expect(rec.subagents[0].resolvedAgentType).toBeUndefined();
  });
});

describe("wildcard-fallback-trap warning — emitted ONLY on an omitted dispatch, never on a deliberate choice", () => {
  it("OMITTED subagent_type resolving (via task_started) to general-purpose emits the ::warning:: fallback-trap line", async () => {
    const warnings: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((l: unknown) => (warnings.push(String(l)), true));
    try {
      await driveRunOverEvents([
        dispatch("t1", "unknown", { typeOmitted: true }),
        systemEvent("task_started", { tool_use_id: "t1", subagent_type: "general-purpose", task_type: "local_agent" }),
      ]);
    } finally {
      spy.mockRestore();
    }
    expect(warnings.some((w) => w.includes("::warning::") && w.includes("OMITTED subagent_type"))).toBe(true);
  });

  it('an EXPLICIT subagent_type:"general-purpose" dispatch (deliberate, not omitted) resolving to general-purpose does NOT warn', async () => {
    const warnings: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((l: unknown) => (warnings.push(String(l)), true));
    try {
      await driveRunOverEvents([
        dispatch("t1", "general-purpose", { typeOmitted: false }),
        systemEvent("task_started", { tool_use_id: "t1", subagent_type: "general-purpose", task_type: "local_agent" }),
      ]);
    } finally {
      spy.mockRestore();
    }
    expect(warnings.some((w) => w.includes("OMITTED subagent_type"))).toBe(false);
  });
});

let reqCounter = 0;
/** Synthetic `permission` DecisionRequest builder for driving a Run over a scripted decision list. */
function permissionReq(
  tool: string,
  input: unknown,
  opts: { toolUseId?: string; decisionReasonType?: string; agentId?: string } = {},
): DecisionRequest {
  return {
    id: `req-${++reqCounter}`,
    kind: "permission",
    tool,
    input: input as Record<string, unknown>,
    toolUseId: opts.toolUseId,
    decisionReasonType: opts.decisionReasonType,
    agentId: opts.agentId,
  };
}

/** Synthetic deny `DecisionResponse` builder. */
function deny(message: string): DecisionResponse {
  return { kind: "permission", behavior: "deny", message };
}

/** Drive a `Run` over a scripted `{req, answer}` decision list — a tiny by-id `Decider` answers each
 *  `permissionReq` with its paired `answer`, mirroring `driveRunOverEvents`' auto-appended terminal
 *  `result` event. */
async function driveRunOverDecisions(items: { req: DecisionRequest; answer: DecisionResponse }[]) {
  const events: AgentEvent[] = [
    ...items.map((i) => ({ type: "decision", request: i.req }) as AgentEvent),
    { type: "result", isError: false },
  ];
  const byId = new Map(items.map((i) => [i.req.id, i.answer]));
  const decider: Decider = {
    async decide(req) {
      const answer = byId.get(req.id);
      return answer ? { response: answer, by: "scripted" } : ABSTAIN;
    },
  };
  return new Run(new MockSession(events), decider).drive("go");
}

describe("pathDenials — decision-level path-denial telemetry (three filtered producers)", () => {
  it("pretooluse: ingests ONLY the hostloop path gate's callbackId (custom-hook denials excluded)", async () => {
    const rec = await driveRunOverEvents([
      hookEvent({
        callbackId: "hostloop-path-gate",
        decision: "block",
        reason: "…is a VM path…",
        tool: "Write",
        path: "/sessions/x/y",
        toolUseId: "t1",
        agentId: "agent_7",
      }),
      hookEvent({ callbackId: "my-custom-hook", decision: "block", reason: "nope", tool: "Write", path: "/x" }),
    ]);
    expect(rec.pathDenials).toEqual([
      {
        source: "pretooluse",
        tool: "Write",
        path: "/sessions/x/y",
        callbackId: "hostloop-path-gate",
        decisionReasonType: undefined,
        agentId: "agent_7",
        decision: "deny",
        reason: "…is a VM path…",
        toolUseId: "t1",
      },
    ]);
  });

  it("can_use_tool: a DENIED gated-file-tool permission with a path attempt is ingested; pathless or non-gated denials are not", async () => {
    const rec = await driveRunOverDecisions([
      {
        req: permissionReq("Edit", { file_path: "/sessions/x" }, { toolUseId: "t2", decisionReasonType: "workingDir" }),
        answer: deny("blocked"),
      },
      { req: permissionReq("mcp__workspace__bash", { command: "ls" }), answer: deny("no") }, // not gated — excluded
      { req: permissionReq("Grep", { pattern: "q" }), answer: deny("no") }, // no path — excluded
    ]);
    expect(rec.pathDenials).toEqual([
      {
        source: "can_use_tool",
        tool: "Edit",
        path: "/sessions/x",
        callbackId: undefined,
        decisionReasonType: "workingDir",
        agentId: undefined,
        decision: "deny",
        reason: "blocked",
        toolUseId: "t2",
      },
    ]);
  });

  it("permission_denied: ingested ONLY when correlated (by tool_use_id) to a recorded gated attempt with a path", async () => {
    const rec = await driveRunOverEvents([
      toolUse("Write", { file_path: "/sessions/x/z" }, { toolUseId: "t3" }),
      systemEvent("permission_denied", {
        tool_name: "Write",
        tool_use_id: "t3",
        agent_id: "agent_9",
        decision_reason_type: "workingDir",
        decision_reason: "denied pre-ask",
      }),
      systemEvent("permission_denied", { tool_name: "mcp__cowork__present_files", tool_use_id: "t9" }), // uncorrelated/non-path — excluded
    ]);
    expect(rec.pathDenials).toEqual([
      {
        source: "permission_denied",
        tool: "Write",
        path: "/sessions/x/z",
        callbackId: undefined,
        decisionReasonType: "workingDir",
        agentId: "agent_9",
        decision: "deny",
        reason: "denied pre-ask",
        toolUseId: "t3",
      },
    ]);
  });

  it("permission_denied: falls back to `message` when `decision_reason` is absent (production-observed shape)", async () => {
    const rec = await driveRunOverEvents([
      toolUse("Write", { file_path: "/sessions/x/m" }, { toolUseId: "t10" }),
      systemEvent("permission_denied", { tool_name: "Write", tool_use_id: "t10", message: "denied via message field" }),
    ]);
    expect(rec.pathDenials).toEqual([
      expect.objectContaining({
        source: "permission_denied",
        path: "/sessions/x/m",
        reason: "denied via message field",
      }),
    ]);
  });
});

// Regression coverage for a review finding: for a DUAL-KEY denial (`{file_path:"/allowed",
// path:"/sessions/x"}`), all three pathDenials producers must record the SAME /sessions-preferring
// value. Before the fix, producers (1)/(2) picked "/sessions/x" (via the shared /sessions-preferring
// scan) while producer (3) picked "/allowed" (via `attempt.gatePath`, a first-key-wins value) — a
// source-dependent `path` for what is really the same denied event. Producer (3) now derives its
// path with `deniedPathFrom(attempt.paths)`, the SAME selection producers (1)/(2) use.
describe("pathDenials — dual-key selection is consistent across all three producers (/sessions wins over file_path)", () => {
  const filePath = "/allowed";
  const sessionsPath = "/sessions/x";

  it("pretooluse: a dual-key hook block records the /sessions path, not file_path", async () => {
    const rec = await driveRunOverEvents([
      hookEvent({
        callbackId: "hostloop-path-gate",
        decision: "block",
        tool: "Write",
        filePath,
        path: sessionsPath,
        toolUseId: "dk1",
      }),
    ]);
    expect(rec.pathDenials).toHaveLength(1);
    expect(rec.pathDenials[0].path).toBe(sessionsPath);
  });

  it("can_use_tool: a dual-key denied permission input records the /sessions path, not file_path", async () => {
    const rec = await driveRunOverDecisions([
      { req: permissionReq("Edit", { file_path: filePath, path: sessionsPath }, { toolUseId: "dk2" }), answer: deny("blocked") },
    ]);
    expect(rec.pathDenials).toHaveLength(1);
    expect(rec.pathDenials[0].path).toBe(sessionsPath);
  });

  it("permission_denied: a dual-key correlated attempt records the /sessions path, not file_path (matches producers 1/2)", async () => {
    const rec = await driveRunOverEvents([
      toolUse("Write", { file_path: filePath, path: sessionsPath }, { toolUseId: "dk3" }),
      systemEvent("permission_denied", { tool_name: "Write", tool_use_id: "dk3" }),
    ]);
    expect(rec.pathDenials).toHaveLength(1);
    expect(rec.pathDenials[0].path).toBe(sessionsPath);
  });
});
