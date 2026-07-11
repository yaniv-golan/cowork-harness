import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, runSemanticJudges, type AssertContext, type SemanticJudge } from "../src/assert.js";
import { parseScenarioFile } from "../src/run/execute.js";
import { parseEgressLine } from "../src/egress/sidecar.js";
import { Run, evidenceErrorsForResult } from "../src/run/run.js";
import { ScriptedDecider } from "../src/decide/decider.js";
import type { AgentEvent, AgentSession, DecisionResponse, DecisionDelivery } from "../src/agent/session.js";

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
        authoredFilesHealth: { omittedPaths: ["outputs/report.bin"], totalCapExhausted: true, readErrors: [] },
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
        authoredFilesHealth: { omittedPaths: [], totalCapExhausted: false, readErrors: [{ path: "outputs/x", error: "EACCES" }] },
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
        authoredFilesHealth: { omittedPaths: [], totalCapExhausted: false, readErrors: [], scratchpadSkippedOnResume: true },
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
      ctx({ subagents: [{ agentType: "researcher", declaredTools: [], toolsUsed: [], output: "head only", outputTruncated: true }] }),
    );
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/evidence unavailable/);
    expect(r.message).toMatch(/truncated/);
  });

  it("a miss against a COMPLETE sub-agent output is a plain absence (no truncation caveat)", () => {
    const [r] = evaluate(
      [{ subagent_output_contains: { match: "researcher", contains: "SECRET" } }],
      ctx({ subagents: [{ agentType: "researcher", declaredTools: [], toolsUsed: [], output: "head only" }] }),
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
