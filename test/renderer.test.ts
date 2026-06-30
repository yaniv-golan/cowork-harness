import { describe, it, expect } from "vitest";
import type { AgentEvent } from "../src/agent/session.js";
import { makeRenderer, renderFooter, startHeartbeat, type RenderPlan } from "../src/run/renderer.js";
import type { RunResult } from "../src/types.js";

const plan = (over: Partial<RenderPlan> = {}): RenderPlan => ({
  live: true,
  progress: true,
  verbose: false,
  color: false,
  compact: false,
  ...over,
});
function sink() {
  const out: string[] = [];
  return { write: (s: string) => out.push(s), text: () => out.join("") };
}

const events: AgentEvent[] = [
  { type: "init", tools: ["Bash"], mcpServers: [], cwd: "/sessions/x" },
  { type: "thinking", text: "let me think" },
  { type: "assistant_text", text: "I will search" },
  { type: "tool_use", name: "Bash", input: { command: "grep x" } },
  { type: "tool_use", name: "Read", input: {}, parentToolUseId: "tu1" }, // sub-agent tool: not a top-level tool
  { type: "subagent_dispatch", toolUseId: "tu1", agentType: "researcher", declaredTools: ["Read"] },
  { type: "assistant_text", text: "found it" },
  { type: "result", isError: false },
];

describe("renderer — makeRenderer", () => {
  it("skill-normal: streams assistant text + tool markers (not thinking/sub-agent); buffers transcript", () => {
    const s = sink();
    const r = makeRenderer(plan(), s.write);
    for (const e of events) r.onEvent!(e);
    const t = s.text();
    expect(t).toContain("claude›");
    expect(t).toContain("I will search");
    expect(t).toContain("· Bash");
    expect(t).not.toContain("thinking");
    expect(t).not.toContain("sub-agent");
    expect(r.summary()).toEqual({ tools: 1, subagents: 1 }); // Bash is the only top-level tool; Read is sub-agent
    expect(r.dump()).toBe("I will search\nfound it");
  });

  it("verbose: adds thinking, tool input summary, sub-agent tree", () => {
    const s = sink();
    const r = makeRenderer(plan({ verbose: true }), s.write);
    for (const e of events) r.onEvent!(e);
    const t = s.text();
    expect(t).toContain("(thinking…)");
    expect(t).toContain("sub-agent: researcher");
    expect(t).toContain("command"); // tool input summary
  });

  it("no ANSI codes when color:false; errors always print", () => {
    const s = sink();
    const r = makeRenderer(plan(), s.write);
    r.onEvent!({ type: "assistant_text", text: "hi" });
    r.onEvent!({ type: "error", source: "agent", message: "boom" });
    expect(s.text()).not.toContain("\x1b[");
    expect(s.text()).toContain("! agent: boom");
  });
});

describe("renderer — renderFooter", () => {
  const base: RunResult = {
    scenario: "s",
    fidelity: "container",
    baseline: "p",
    result: "success",
    decisions: [],
    egress: [],
    assertions: [],
    outDir: "runs/s/x",
  };

  it("pass footer: ✓ + meta + duration", () => {
    const s = sink();
    renderFooter({ ...base, assertions: [{ assertion: {}, pass: true }] }, plan({ color: false }), { durationMs: 1500, write: s.write });
    expect(s.text()).toContain("✓ success");
    expect(s.text()).toContain("1.5s");
  });

  it("fail footer: ✗ + failing assertion + the failing transcript (the debug win)", () => {
    const s = sink();
    const r = makeRenderer(plan({ live: false }), () => {});
    r.onEvent!({ type: "assistant_text", text: "what the agent said" });
    renderFooter(
      { ...base, assertions: [{ assertion: { transcript_contains: "X" }, pass: false, message: "transcript missing X" }] },
      plan({ color: false }),
      { renderer: r, write: s.write },
    );
    const t = s.text();
    expect(t).toContain("✗ FAIL");
    expect(t).toContain("transcript missing X");
    expect(t).toContain("── transcript ──");
    expect(t).toContain("what the agent said");
    expect(t).toContain("run.jsonl");
  });

  it("surfaces unscripted answers as copy-pasteable --answer lines (run-once-then-script)", () => {
    const s = sink();
    renderFooter(
      {
        ...base,
        assertions: [{ assertion: {}, pass: true }],
        unanswered: [
          { question: "Which format?", chosen: "Markdown", by: "first" },
          { question: "How deep?", chosen: "Thorough", by: "first" },
        ],
      },
      plan({ color: false }),
      { write: s.write },
    );
    const t = s.text();
    expect(t).toContain("✓ success");
    expect(t).toContain("2 question(s) were auto-answered");
    expect(t).toContain('--answer "Which format?=Markdown"');
    expect(t).toContain('--answer "How deep?=Thorough"');
  });

  it("no --answer block when nothing was auto-answered (scripted run)", () => {
    const s = sink();
    renderFooter({ ...base, assertions: [{ assertion: {}, pass: true }] }, plan({ color: false }), { write: s.write });
    expect(s.text()).not.toContain("--answer");
  });

  it("prints the deep mnt/outputs path on --keep (item 7)", () => {
    const s = sink();
    renderFooter(
      { ...base, assertions: [{ assertion: {}, pass: true }], outputsDir: "runs/s/x/work/session/mnt/outputs" },
      plan({ color: false }),
      { keep: true, write: s.write },
    );
    expect(s.text()).toContain("→ outputs: runs/s/x/work/session/mnt/outputs");
  });

  it("points at outputs on FAIL too (item 7)", () => {
    const s = sink();
    const r = makeRenderer(plan({ live: false }), () => {});
    r.onEvent!({ type: "assistant_text", text: "did stuff" });
    renderFooter(
      {
        ...base,
        assertions: [{ assertion: { file_exists: "x" }, pass: false, message: "missing" }],
        outputsDir: "runs/s/x/work/session/mnt/outputs",
      },
      plan({ color: false }),
      { renderer: r, write: s.write },
    );
    expect(s.text()).toContain("→ outputs:  runs/s/x/work/session/mnt/outputs");
  });
});

describe("renderer — startHeartbeat", () => {
  it("fires an idle 'still running' line on stderr after the idle window, then stops", async () => {
    const s = sink();
    process.env.COWORK_HARNESS_HEARTBEAT_MS = "10";
    delete process.env.COWORK_HARNESS_NO_HEARTBEAT;
    const r = makeRenderer(plan({ live: false }), () => {}); // no activity → idle from start
    const stop = startHeartbeat(r, plan({ color: false }), Date.now(), s.write);
    await new Promise((res) => setTimeout(res, 35));
    stop();
    const after = s.text();
    expect(after).toMatch(/still running/);
    await new Promise((res) => setTimeout(res, 25)); // nothing more after stop()
    expect(s.text()).toBe(after);
    delete process.env.COWORK_HARNESS_HEARTBEAT_MS;
  });

  it("disabled by COWORK_HARNESS_NO_HEARTBEAT", async () => {
    const s = sink();
    process.env.COWORK_HARNESS_NO_HEARTBEAT = "1";
    process.env.COWORK_HARNESS_HEARTBEAT_MS = "10";
    const stop = startHeartbeat(undefined, plan({ color: false }), Date.now(), s.write);
    await new Promise((res) => setTimeout(res, 35));
    stop();
    expect(s.text()).toBe("");
    delete process.env.COWORK_HARNESS_NO_HEARTBEAT;
    delete process.env.COWORK_HARNESS_HEARTBEAT_MS;
  });
});
