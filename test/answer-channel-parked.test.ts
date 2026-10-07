import { describe, it, expect } from "vitest";
import { Run } from "../src/run/run.js";
import { ScriptedDecider } from "../src/decide/decider.js";
import { computeVerdict } from "../src/run/verdict.js";
import { classifyTermination } from "../src/eval/classify.js";
import { buildRunsLine } from "../src/eval/runs.js";
import { erroredHint } from "../src/eval/report.js";
import type { AgentEvent, AgentSession, DecisionResponse } from "../src/agent/session.js";
import type { RunResult } from "../src/types.js";

/**
 * Under `answer_channel: none` the agent is offered no question tool (the flag removes AskUserQuestion), so a gated
 * skill runs its script, then asks in prose and ends its turn. The ordinary stall rule needs no tool after the last
 * gate, which such a run never meets, so it passed with no signal. Under no channel, a closing `?` alone parks it.
 * Each final message below is copied from a kept live run.
 */
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

const drive = (events: AgentEvent[], noChannel: boolean) => {
  const run = new Run(new MockSession(events), new ScriptedDecider([]));
  if (noChannel) run.disableAnswerChannel();
  return run.drive("go");
};
const tool = (name: string): AgentEvent => ({ type: "tool_use", name, input: {} });
const ending = (tools: string[], text: string): AgentEvent[] => [
  ...tools.map(tool),
  { type: "assistant_text", text },
  { type: "result", isError: false },
];

// gated-probe-headless (container, agent 2.1.293): the skill's script ran, then the question in prose.
const GATED = ending(
  ["Skill", "Bash"],
  "The probe has recorded that it's waiting at gate `g1`. Which option would you like to continue with, **a** or **b**?",
);
// senduserfile-alias: the work is done and the run ends on an offer. A known false positive: it warns.
const OFFER = ending(
  ["Write"],
  "NO SENDUSERFILE\n\nI wrote the file, but there is no tool named `SendUserFile` available to me. The delivery-related tool I do have is:\n\n- `mcp__cowork__present_files` — delivers a file to you so you can open it on your computer.\n\nWant me to deliver `probe.md` using that tool instead?",
);
// sc-control-regions: a finished run that delivered its brief and ends on a full stop.
const DONE = ending(
  ["Skill", "Bash", "Read", "Write", "mcp__cowork__present_files"],
  "[View your sales brief](computer:///sessions/x/mnt/outputs/brief.md)\n\nNorth leads by a wide margin ($11,500 revenue from 7 orders), with South and West mid-pack and East trailing noticeably. I also caught and corrected a duplicated row (order 1017) before computing totals; details are in the brief.",
);
// cap-table-carta-folder: a request for input phrased without `?`. A known miss: it does not fire.
const REQUEST = ending(
  ["Skill", "Read", "Write"],
  "Please share your pre-money valuation and the total amount you're raising so I can run the numbers.",
);

describe("the stall detector under answer_channel: none", () => {
  it("a gated skill that ran its script, then asked in prose, is parked", async () => {
    expect((await drive(GATED, true)).stalledOnQuestion).toBe(true);
  });
  it("the same run with the ordinary channel is unchanged: tools ran, so it is not stalled", async () => {
    expect((await drive(GATED, false)).stalledOnQuestion).toBeFalsy();
  });
  it("a finished run ending on an offer is parked too (a documented false positive; it only warns)", async () => {
    expect((await drive(OFFER, true)).stalledOnQuestion).toBe(true);
  });
  it("a finished run ending on a full stop is not", async () => {
    expect((await drive(DONE, true)).stalledOnQuestion).toBeFalsy();
  });
  it("a request for input with no `?` is not (a documented miss)", async () => {
    expect((await drive(REQUEST, true)).stalledOnQuestion).toBeFalsy();
  });
  it("a run that ended in error is never parked", async () => {
    const events: AgentEvent[] = [tool("Bash"), { type: "assistant_text", text: "Which one?" }, { type: "result", isError: true }];
    expect((await drive(events, true)).stalledOnQuestion).toBeFalsy();
  });
});

describe("the parked warning never changes the verdict", () => {
  const parked = (fileAssertPass: boolean): RunResult =>
    ({
      scenario: "t",
      fidelity: "container",
      baseline: "x",
      decisions: [],
      egress: [],
      outDir: "/tmp/x",
      result: "success",
      stalledOnQuestion: true,
      answerChannel: "none",
      assertions: [
        {
          assertion: { artifact_json: { artifact: "outputs/artifacts/runs/r1/run_status.json", path: "status", equals: "waiting" } },
          pass: fileAssertPass,
        },
      ],
    }) as RunResult;

  it("with a passing file assertion: pass, exit 0, and the warning present", () => {
    for (const lane of ["live", "replay"] as const) {
      const v = computeVerdict(parked(true), lane);
      expect({ pass: v.pass, exitCode: v.exitCode }).toEqual({ pass: true, exitCode: 0 });
      expect(v.signals.filter((s) => s.code === "parked_at_question").map((s) => s.severity)).toEqual(["warn"]);
      expect(v.signals.some((s) => s.code === "stalled")).toBe(false);
    }
  });
  it("with a failing file assertion: fail, exit 1 — from the assertion, not the warning", () => {
    const v = computeVerdict(parked(false), "live");
    expect({ pass: v.pass, exitCode: v.exitCode }).toEqual({ pass: false, exitCode: 1 });
    expect(v.signals.filter((s) => s.severity === "fail").map((s) => s.code)).not.toContain("parked_at_question");
  });
  it("eval counts a parked rep as completed, as run does", () => {
    const r = parked(true);
    expect(classifyTermination({ result: r })).toMatchObject({ bucket: "valid", rule: "parked_at_question", unclassified: false });
  });
  // `eval report` re-classifies from runs.jsonl; a line that dropped the channel would turn the rep into the agent's
  // own failure on re-render.
  it("and keeps that through the runs.jsonl line", () => {
    const line = JSON.parse(
      JSON.stringify(
        buildRunsLine({
          index: 0,
          arm: "A",
          scenario: "s",
          rep: 0,
          runId: "r0",
          runDir: undefined,
          result: parked(true),
          thrown: undefined,
          evidence: undefined,
        }),
      ),
    );
    expect(classifyTermination({ result: line.result })).toMatchObject({ bucket: "valid", rule: "parked_at_question" });
  });
});

describe("advice under answer_channel: none never names a remedy the key refuses", () => {
  it("ended_with_question points at the status file, not at scripting an answer", () => {
    const base = { scenario: "t", fidelity: "container", baseline: "x", decisions: [], egress: [], outDir: "/tmp/x", assertions: [] };
    const r = { ...base, result: "success", finalMessage: "Done? Mostly. See the notes.", workspaceFiles: [] } as unknown as RunResult;
    const msg = (x: RunResult) => computeVerdict(x, "live").signals.find((s) => s.code === "ended_with_question")?.message ?? "";
    expect(msg(r)).toMatch(/Script the answer/);
    const none = msg({ ...r, answerChannel: "none" });
    expect(none).toMatch(/status file/);
    expect(none).not.toMatch(/answer:|decider/);
  });
  it("eval names the agent version when every rep was a violation", () => {
    expect(erroredHint({ bucket: "errored_infra", rule: "source_answer_channel_violation" })).toMatch(/--permission-prompts none/);
  });
});
