import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { toDecisionRequest, type AgentEvent, type AgentSession, type DecisionResponse } from "../src/agent/session.js";
import { PermissionDefaultDecider } from "../src/decide/decider.js";
import { decisionRows, permissiveAutoAllowWarning, Run } from "../src/run/run.js";
import { computeVerdict } from "../src/run/verdict.js";
import { replayCassette, type Cassette } from "../src/run/cassette.js";
import { buildJsonReport, buildTextReport, gradedSignalsFrom } from "../src/critique/command.js";
import type { RunResult } from "../src/types.js";
import { withReplayContract } from "./helpers/minimal-cassette.js";

// The permissive auto-allow guard has to say WHY the agent CLI asked, not only which tool. These tests enter at the
// raw control_request frame (the same field names the CLI sends), go through toDecisionRequest → Run → decisionRows →
// computeVerdict, so dropping the reason at any of those seams turns the message test red. All paths and reason text
// here are synthetic.

class MockSession implements AgentSession {
  constructor(private events: AgentEvent[]) {}
  async *start(): AsyncIterable<AgentEvent> {
    for (const e of this.events) yield e;
  }
  sendUserTurn() {}
  respond(_id: string, _r: DecisionResponse) {
    return { delivered: true as const };
  }
  close() {}
}

const DIR = "/sessions/sess-test/mnt/.claude/projects/my proj/tool-results";
const reasonFor = (file: string) => `Asked to modify ${DIR}/${file} which is a protected location.`;

/** A raw can_use_tool control_request, shaped like the CLI's own. `reason` undefined ⇒ the frame carries none. */
function frame(id: string, tool: string, reason?: string, type?: string): unknown {
  return {
    type: "control_request",
    request_id: id,
    request: {
      subtype: "can_use_tool",
      tool_name: tool,
      input: { command: "true" },
      tool_use_id: `tu-${id}`,
      ...(reason !== undefined ? { decision_reason: reason } : {}),
      ...(type !== undefined ? { decision_reason_type: type } : {}),
    },
  };
}

async function resultFrom(frames: unknown[], over: Partial<RunResult> = {}): Promise<RunResult> {
  const events: AgentEvent[] = [
    ...frames.map((f) => ({ type: "decision" as const, request: toDecisionRequest(f)! })),
    { type: "result", isError: false },
  ];
  const rec = await new Run(new MockSession(events), new PermissionDefaultDecider("cowork")).drive("go");
  return {
    scenario: "t",
    fidelity: "container",
    effectiveFidelity: "container",
    baseline: "x",
    result: "success",
    decisions: decisionRows(rec.decisions),
    permissiveAutoAllow: rec.permissiveAutoAllow.length ? rec.permissiveAutoAllow : undefined,
    egress: [],
    assertions: [],
    outDir: "/tmp/x",
    ...over,
  };
}

const signalOf = (r: RunResult) => computeVerdict(r, "live").signals.find((s) => s.code === "permissive_auto_allow");
const THREE = () => [
  frame("r1", "Bash", reasonFor("a.txt"), "subcommandResults"),
  frame("r2", "Bash", reasonFor("b c.txt"), "subcommandResults"),
  frame("r3", "Bash", reasonFor("d.txt"), "subcommandResults"),
];

describe("permissive_auto_allow explains the ask", () => {
  it("(a) carries the CLI's reason verbatim and the de-duplicated count; severity stays fail", async () => {
    const r = await resultFrom([frame("r1", "Bash", reasonFor("a.txt"), "safetyCheck")]);
    expect(r.decisions[0]).toMatchObject({ decisionReason: reasonFor("a.txt"), decisionReasonType: "safetyCheck" });
    const s = signalOf(r)!;
    expect(s.severity).toBe("fail");
    expect(s.message).toContain(`"${reasonFor("a.txt")}"`);
    expect(s.message).toContain("1× Bash");
    expect(s.message).toContain("safetyCheck");
    // the array stays the gate and keeps its shape
    expect(r.permissiveAutoAllow).toEqual(["Bash"]);
    expect(computeVerdict(r, "live").pass).toBe(false);
  });

  it("(f) three reasons differing only by file name (one with a space in the name, all with a space in the dir) are ONE group of 3", async () => {
    const s = signalOf(await resultFrom(THREE()))!;
    expect(s.message).toContain("3× Bash");
    expect(s.message).not.toContain("1× Bash");
    // one example, verbatim — the first
    expect(s.message).toContain(`"${reasonFor("a.txt")}"`);
    expect(s.message).not.toContain("b c.txt");
    expect(s.message).not.toContain("d.txt");
  });

  it("(f) a different type or a different directory is a separate group", async () => {
    const s = signalOf(
      await resultFrom([
        ...THREE(),
        frame("r4", "Bash", reasonFor("e.txt"), "safetyCheck"),
        frame("r5", "Bash", "Asked to modify /elsewhere/x.txt which is a protected location.", "subcommandResults"),
      ]),
    )!;
    expect(s.message).toContain("3× Bash");
    expect(s.message.match(/1× Bash/g)).toHaveLength(2);
  });

  it("(e) a frame with no decision_reason falls back to the tool-name list", async () => {
    const r = await resultFrom([frame("r1", "Write"), frame("r2", "Bash")]);
    expect(r.decisions[0]).not.toHaveProperty("decisionReason");
    const s = signalOf(r)!;
    expect(s.message).toContain("Write, Bash");
    expect(s.message).not.toContain('"');
  });

  it("(e) a reasoned and an unreasoned ask: the reasoned one is grouped, the other listed by name — none dropped", async () => {
    const s = signalOf(await resultFrom([frame("r1", "Bash", reasonFor("a.txt"), "safetyCheck"), frame("r2", "Write")]))!;
    expect(s.message).toContain("1× Bash");
    expect(s.message).toContain("Write");
  });

  it("(e) an older result with the array but no matching decision rows still names every tool", () => {
    const r: RunResult = {
      scenario: "t",
      fidelity: "container",
      baseline: "x",
      result: "success",
      decisions: [],
      permissiveAutoAllow: ["Bash", "Bash"],
      egress: [],
      assertions: [],
      outDir: "/tmp/x",
    };
    expect(signalOf(r)!.message).toContain("Bash, Bash");
  });

  it("(g) container, lane local, no taskKind: only the conditional Cowork claim", async () => {
    const s = signalOf(await resultFrom(THREE(), { lane: "local" }))!;
    expect(s.message).toMatch(
      /an attended Cowork task would show a permission card for this; a scheduled one would decline it after a timeout/i,
    );
    expect(s.message).not.toMatch(/would BLOCK/i);
  });

  it("(g) hostloop also makes the conditional claim; lane remote, protocol, microvm and answer_channel none make none", async () => {
    expect(signalOf(await resultFrom(THREE(), { effectiveFidelity: "hostloop", fidelity: "hostloop" }))!.message).toMatch(
      /attended Cowork task/,
    );
    for (const over of [
      { lane: "remote" as const },
      { effectiveFidelity: "protocol", fidelity: "protocol" },
      { effectiveFidelity: "microvm", fidelity: "microvm" },
      { answerChannel: "none" as const },
    ]) {
      const m = signalOf(await resultFrom(THREE(), over))!.message;
      expect(m, JSON.stringify(over)).not.toMatch(/Cowork task|real Cowork|permission card/i);
    }
  });

  it("(h) the remedy follows the command", async () => {
    const run = signalOf(await resultFrom(THREE(), { command: "run" }))!.message;
    const missing = signalOf(await resultFrom(THREE()))!.message;
    const skill = signalOf(await resultFrom(THREE(), { command: "skill" }))!.message;
    const probe = signalOf(await resultFrom(THREE(), { command: "skill", scenario: "probe-dispatch-my-skill" }))!.message;
    for (const m of [run, missing]) {
      expect(m).toContain("when_tool");
      expect(m).toContain("answers:");
      expect(m).toContain("permission_parity: strict");
      expect(m).toContain("allow_permissive_auto_allow: true");
      expect(m).not.toContain("--answer-policy");
    }
    expect(skill).toContain("--answer-policy");
    expect(skill).toContain("when_tool");
    expect(skill).not.toContain("permission_parity: strict");
    expect(skill).not.toContain("allow_permissive_auto_allow");
    expect(probe).toMatch(/re-run .*`skill`/);
    expect(probe).toContain("--answer-policy");
    // `--answer` cannot answer a tool permission: no message names it as a remedy
    for (const m of [run, skill, probe]) expect(m).not.toMatch(/--answer(?!-policy)/);
  });

  it("the stderr twin is command-neutral: tool, the CLI's reason, auto-allowed under cowork parity, no Cowork claim, no remedy", () => {
    const w = permissiveAutoAllowWarning("Bash", "safetyCheck", reasonFor("a.txt"));
    expect(w).toContain('"Bash"');
    expect(w).toContain(reasonFor("a.txt"));
    expect(w).toContain("safetyCheck");
    expect(w).toContain("auto-allowed under cowork parity");
    expect(w).not.toMatch(/Cowork task|real Cowork|would BLOCK|--answer|answers:|permission_parity|when_tool/i);
    const bare = permissiveAutoAllowWarning("Write", undefined, undefined);
    expect(bare).toContain('"Write"');
    expect(bare).toContain("auto-allowed under cowork parity");
  });
});

describe("(d2) replay re-derives decisionReason through the real re-drive", () => {
  it("a constructed cassette's can_use_tool frame yields decisions[].decisionReason on replay", async () => {
    const f = frame("req-1", "Bash", reasonFor("a.txt"), "subcommandResults") as Record<string, unknown>;
    const events = [
      JSON.stringify({ type: "system", subtype: "init", tools: ["Bash"] }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "tu-req-1", name: "Bash", input: { command: "true" } }] },
      }),
      JSON.stringify(f),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu-req-1", content: "ok" }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ];
    const controlOut = [
      JSON.stringify({
        type: "control_response",
        response: { subtype: "success", request_id: "req-1", response: { behavior: "allow", updatedInput: { command: "true" } } },
      }),
    ];
    const cassette = {
      scenario: {
        name: "d2",
        baseline: "latest",
        session: "(inline)",
        fidelity: "protocol" as const,
        prompt: "hi",
        answers: [],
        expect_denied: [],
        assert: [{ result: "success" }],
      },
      events,
      controlOut,
      preRunPaths: [],
      artifacts: [],
    } as any;
    const r = await replayCassette(withReplayContract(cassette), [], { notesSink: () => {} });
    expect(r.decisions[0]).toMatchObject({ name: "Bash", decisionReason: reasonFor("a.txt"), decisionReasonType: "subcommandResults" });
  });
});

describe("(d) no regression on the committed cassettes", () => {
  const CASSETTES = [
    "examples/replays/example-multiselect-gate.cassette.json",
    "examples/replays/example-pdf-skill.cassette.json",
    "examples/replays/hostloop-computer-links.cassette.json",
    "test/fixtures/tool-call-dispatch/dispatch-shell.cassette.json",
  ];
  it.each(CASSETTES)("%s: carries no decision_reason, and its replayed decisions gain no new key", async (path) => {
    const text = readFileSync(path, "utf8");
    // Precondition: if a cassette ever carries the field, this test no longer says what it claims.
    expect(text).not.toContain("decision_reason");
    const c = JSON.parse(text) as Cassette;
    const r = await replayCassette(c, [], { cassetteDir: resolve(path, ".."), notesSink: () => {} });
    const json = JSON.stringify(r.decisions);
    expect(json).not.toContain("decisionReason");
  });
});

describe("(c) critique shows the graded run's failing signals under `graded outcome:`", () => {
  const envelope = JSON.stringify({
    tool: "cowork-harness",
    command: "skill",
    ok: false,
    results: [
      {
        outcome: "delivered_clean",
        verdict: {
          pass: false,
          signals: [
            { code: "permissive_auto_allow", severity: "fail", message: "the agent CLI asked …\nsecond line" },
            { code: "nondeterministic", severity: "warn", message: "a warning" },
          ],
        },
      },
    ],
  });
  const STATE = {
    skillFolder: "./s",
    prompt: "p",
    sessionId: "sess-x",
    outDir: "/tmp/ignored",
    fidelity: "container",
    taskResult: "success" as const,
    selfReportStatus: "captured" as const,
    items: [],
    requestedModel: "m",
    gradedOutcome: "delivered_clean",
  };

  it("lifts only the failing signals, first line only", () => {
    expect(gradedSignalsFrom(envelope)).toEqual([{ code: "permissive_auto_allow", message: "the agent CLI asked …" }]);
    expect(gradedSignalsFrom("not json")).toBeUndefined();
    expect(gradedSignalsFrom(JSON.stringify({ results: [{ verdict: { pass: true, signals: [] } }] }))).toBeUndefined();
  });

  it("text: the signal line sits under `graded outcome:`, labelled as concerning the graded run", () => {
    const t = buildTextReport({ ...STATE, gradedSignals: gradedSignalsFrom(envelope) });
    const lines = t.split("\n");
    const at = lines.findIndex((l) => l.includes("graded outcome: delivered_clean"));
    expect(at).toBeGreaterThan(-1);
    expect(lines[at + 1]).toMatch(/graded run.*permissive_auto_allow: the agent CLI asked …$/);
    expect(t).not.toContain("second line");
    expect(t).not.toContain("nondeterministic");
  });

  it("json: gradedSignals mirrors it", () => {
    const j = buildJsonReport({ ...STATE, gradedSignals: gradedSignalsFrom(envelope) });
    expect(j.gradedSignals).toEqual([{ code: "permissive_auto_allow", message: "the agent CLI asked …" }]);
  });
});
