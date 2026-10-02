import { describe, it, expect, afterEach } from "vitest";
import type { AgentEvent, AgentSession, DecisionResponse, DecisionDelivery } from "../src/agent/session.js";
import { Run } from "../src/run/run.js";
import { buildDecider, ScriptedDecider, UnansweredError, type PartlyScriptedGate, type RunContext } from "../src/decide/decider.js";
import { computeVerdict } from "../src/run/verdict.js";
import { replayCassette } from "../src/run/cassette.js";
import type { RunResult, AnswerRule } from "../src/types.js";

// A question batch the scripted `answers:` match only PART of goes WHOLE to the fallback (answers are
// delivered atomically). These tests pin that this is now a durable, report-only finding: recorded by the
// scripted decider on the branch where it abstains, persisted as `partlyScriptedGates`, surfaced as a
// warn-severity verdict signal — and that NOTHING about what is answered, delivered, or judged changes.

const origWrite = process.stderr.write.bind(process.stderr);
afterEach(() => {
  process.stderr.write = origWrite;
});
function muteStderr(): string[] {
  const lines: string[] = [];
  process.stderr.write = ((s: string | Uint8Array) => (lines.push(String(s)), true)) as typeof process.stderr.write;
  return lines;
}

class MockSession implements AgentSession {
  responded: { id: string; r: DecisionResponse }[] = [];
  constructor(private events: AgentEvent[]) {}
  async *start(): AsyncIterable<AgentEvent> {
    for (const e of this.events) yield e;
  }
  sendUserTurn() {}
  respond(id: string, r: DecisionResponse): DecisionDelivery {
    this.responded.push({ id, r });
    return { delivered: true };
  }
  close() {}
}

// The gate as a skill really batches it: two sub-questions in one AskUserQuestion.
const JURIS = "Which jurisdiction structure applies?";
const ROUND = "Which round are you raising?";
const batch = (id = "req-batch") =>
  ({
    type: "decision",
    request: {
      id,
      kind: "question",
      toolUseId: "toolu_batch",
      questions: [
        { question: JURIS, options: [{ label: "Israeli parent" }, { label: "Delaware (already flipped)" }] },
        { question: ROUND, options: [{ label: "Seed" }, { label: "Series A" }] },
      ],
    },
  }) as AgentEvent;
const done: AgentEvent = { type: "result", isError: false };
const partialRules: AnswerRule[] = [{ when_question: "jurisdiction structure", choose: "Delaware (already flipped)" }];

async function drive(rules: AnswerRule[], events: AgentEvent[], onUnanswered: "first" | "fail" = "first") {
  const session = new MockSession(events);
  const run = new Run(session, buildDecider({ rules, parity: "cowork", onUnanswered }));
  return { session, run, rec: await run.drive("go") };
}

describe("live path: a partly scripted batch is recorded by the scripted decider, behaviour unchanged", () => {
  it("records matched + unmatched with the gate's request id; the fallback's answer is what is delivered", async () => {
    const err = muteStderr();
    const { session, rec } = await drive(partialRules, [batch(), done]);
    expect(rec.partlyScriptedGates).toEqual([{ requestId: "req-batch", matched: [JURIS], unmatched: [ROUND] }]);
    // No behaviour change: the WHOLE batch went to `first` — the scripted Delaware answer was NOT delivered.
    expect(session.responded).toHaveLength(1);
    expect(session.responded[0].r).toEqual({ kind: "question", answers: { [JURIS]: "Israeli parent", [ROUND]: "Seed" } });
    expect(rec.decisions.find((d) => d.kind === "question")?.by).toBe("first");
    // The existing runtime warning is still emitted, unchanged.
    expect(err.join("")).toMatch(/answered 1\/2 sub-questions of this gate; UNMATCHED: "Which round are you raising\?"/);
  });

  it("with a `fail` fallback the run still ends on the gate, and the salvaged record keeps the finding", async () => {
    muteStderr();
    const session = new MockSession([batch(), done]);
    const run = new Run(session, buildDecider({ rules: partialRules, parity: "cowork", onUnanswered: "fail" }));
    await expect(run.drive("go")).rejects.toBeInstanceOf(UnansweredError);
    expect(session.responded).toHaveLength(0);
    expect(run.partial().partlyScriptedGates).toEqual([{ requestId: "req-batch", matched: [JURIS], unmatched: [ROUND] }]);
  });

  it("does NOT fire on a single-question gate whose when_question matches nothing (the existing unmatched case)", async () => {
    muteStderr();
    const single = {
      type: "decision",
      request: { id: "req-1", kind: "question", questions: [{ question: ROUND, options: [{ label: "Seed" }] }] },
    } as AgentEvent;
    const { rec } = await drive(partialRules, [single, done]);
    expect(rec.decisions.find((d) => d.kind === "question")?.by).toBe("first"); // it did fall through
    expect(rec.partlyScriptedGates).toEqual([]);
  });

  it("does NOT fire on a batch matching none, or one matching all, of its sub-questions", async () => {
    muteStderr();
    expect((await drive([{ when_question: "nothing-matches", choose: "x" }], [batch(), done])).rec.partlyScriptedGates).toEqual([]);
    const all = await drive([...partialRules, { when_question: "round", choose: "Series A" }], [batch(), done]);
    expect(all.rec.partlyScriptedGates).toEqual([]);
    expect(all.session.responded[0].r).toEqual({
      kind: "question",
      answers: { [JURIS]: "Delaware (already flipped)", [ROUND]: "Series A" },
    });
  });

  it("a rule that matches but sets neither choose nor answer counts as unmatched, as decide() treats it", async () => {
    muteStderr();
    const { rec } = await drive([...partialRules, { when_question: "round" } as AnswerRule], [batch(), done]);
    expect(rec.partlyScriptedGates).toEqual([{ requestId: "req-batch", matched: [JURIS], unmatched: [ROUND] }]);
  });
});

describe("partlyScripted() classifier shares decide()'s rule lookup", () => {
  const cases: AnswerRule[][] = [
    partialRules,
    [{ when_question: "nothing-matches", choose: "x" }],
    [...partialRules, { when_question: "round", choose: "Series A" }],
    [...partialRules, { when_question: "round" } as AnswerRule],
    [{ when_question: "round", answer: "pre-seed" }],
  ];
  it.each(cases.map((r, i) => [i, r] as const))("case %i: classifier agrees with the decide() sink", async (_i, rules) => {
    muteStderr();
    const req = (batch() as Extract<AgentEvent, { type: "decision" }>).request;
    const notes: PartlyScriptedGate[] = [];
    const ctx: RunContext = { task: "", transcript: () => "", toolLog: () => [], runId: "t", notePartlyScripted: (f) => notes.push(f) };
    const d = new ScriptedDecider(rules);
    await d.decide(req, ctx);
    const viaDecide = notes[0] ? { matched: notes[0].matched, unmatched: notes[0].unmatched } : null;
    expect(d.partlyScripted(req.kind === "question" ? req.questions : [])).toEqual(viaDecide);
  });
});

describe("verdict: a warn-severity finding that never moves pass/exit", () => {
  const base: RunResult = {
    scenario: "t",
    fidelity: "container",
    baseline: "x",
    result: "success",
    decisions: [{ kind: "question", name: "AskUserQuestion", decision: "answered", by: "first", requestId: "req-batch" }],
    egress: [],
    assertions: [],
    outDir: "/tmp/x",
  };
  it("emits partly_scripted_gate naming matched, unmatched and who answered; pass/exitCode identical to without it", () => {
    const without = computeVerdict(base, "live");
    const withF = computeVerdict(
      { ...base, partlyScriptedGates: [{ requestId: "req-batch", matched: [JURIS], unmatched: [ROUND] }] },
      "live",
    );
    const sig = withF.signals.filter((s) => s.code === "partly_scripted_gate");
    expect(sig).toHaveLength(1);
    expect(sig[0].severity).toBe("warn");
    expect(sig[0].message).toContain(JSON.stringify(JURIS));
    expect(sig[0].message).toContain(JSON.stringify(ROUND));
    expect(sig[0].message).toContain("answered by: first");
    expect(withF.pass).toBe(without.pass);
    expect(withF.exitCode).toBe(without.exitCode);
    expect(withF.failures).toEqual(without.failures);
    // …and on a run that is already failing, it adds no failure either.
    const red = { ...base, result: "error" as const };
    expect(computeVerdict({ ...red, partlyScriptedGates: [{ matched: [JURIS], unmatched: [ROUND] }] }, "live").failures).toEqual(
      computeVerdict(red, "live").failures,
    );
  });
});

describe("replay re-derives the finding from the cassette's frozen answers", () => {
  const questions = [
    { question: JURIS, options: [{ label: "Israeli parent" }, { label: "Delaware (already flipped)" }] },
    { question: ROUND, options: [{ label: "Seed" }, { label: "Series A" }] },
  ];
  const cassette = (answers: AnswerRule[]): any => ({
    scenario: {
      name: "c",
      baseline: "latest",
      session: "(inline)",
      fidelity: "container",
      prompt: "hi",
      answers,
      expect_denied: [],
      assert: [{ result: "success" }],
    },
    events: [
      JSON.stringify({ type: "system", subtype: "init", tools: ["AskUserQuestion"] }),
      JSON.stringify({
        type: "control_request",
        request_id: "req-batch",
        request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", tool_use_id: "toolu_q", input: { questions } },
      }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ],
    controlOut: [
      JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "req-batch",
          response: { behavior: "allow", updatedInput: { questions, answers: { [JURIS]: "Israeli parent", [ROUND]: "Seed" } } },
        },
      }),
    ],
  });

  it("a partly scripted frozen batch yields the field + warn signal; the replay verdict is unchanged", async () => {
    muteStderr();
    const partly = await replayCassette(cassette(partialRules));
    const full = await replayCassette(cassette([...partialRules, { when_question: "round", choose: "Seed" }]));
    expect(partly.partlyScriptedGates).toEqual([{ requestId: "req-batch", matched: [JURIS], unmatched: [ROUND] }]);
    expect(full.partlyScriptedGates).toBeUndefined();
    const v = computeVerdict(partly, "replay");
    const sig = v.signals.find((s) => s.code === "partly_scripted_gate");
    expect(sig?.severity).toBe("warn");
    // a replay cannot tell who answered live: it names the replayed answer, never "answered by: replay"
    expect(sig?.message).toMatch(/the recorded answer was replayed/);
    expect(v.pass).toBe(computeVerdict(full, "replay").pass);
    // the replayed answer is the recorded one, regardless of the frozen rules
    expect(partly.decisions.find((d) => d.kind === "question")?.detail).toEqual({ [JURIS]: "Israeli parent", [ROUND]: "Seed" });
  });
});
