import { describe, it, expect } from "vitest";
import type { AgentEvent } from "../src/agent/session.js";
import { makeRenderer, renderFooter, startHeartbeat, inputSummary, toolMarker, type RenderPlan } from "../src/run/renderer.js";
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
    expect(t).toContain("! Bash");
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

describe("renderer — turn separator", () => {
  it("prints an elapsed-time separator line when a turn's result event arrives (live mode)", () => {
    const s = sink();
    const r = makeRenderer(plan(), s.write); // plan() defaults live:true
    r.onEvent!({ type: "assistant_text", text: "turn one" });
    r.onEvent!({ type: "result", isError: false });
    r.onEvent!({ type: "assistant_text", text: "turn two" });
    const t = s.text();
    expect(t).toMatch(/── \+\d+(\.\d+)?s ──/);
    // the separator sits between the two turns' text
    expect(t.indexOf("turn one")).toBeLessThan(t.indexOf("── +"));
    expect(t.indexOf("── +")).toBeLessThan(t.indexOf("turn two"));
  });

  it("stays silent when live is false (buffered/quiet modes)", () => {
    const s = sink();
    const r = makeRenderer(plan({ live: false }), s.write);
    r.onEvent!({ type: "result", isError: false });
    expect(s.text()).not.toContain("──");
  });
});

describe("renderer — tool_result outcomes", () => {
  it("renders a one-line outcome for a top-level tool's result (success and error)", () => {
    const s = sink();
    const r = makeRenderer(plan(), s.write);
    r.onEvent!({ type: "tool_use", name: "Bash", input: {}, toolUseId: "tu1" });
    r.onEvent!({ type: "tool_result", toolUseId: "tu1", isError: false, text: "3 files\nmore output" });
    r.onEvent!({ type: "tool_use", name: "Bash", input: {}, toolUseId: "tu2" });
    r.onEvent!({ type: "tool_result", toolUseId: "tu2", isError: true, text: "permission denied" });
    const t = s.text();
    expect(t).toContain("→ 3 files");
    expect(t).toContain("✗ permission denied");
    expect(t).not.toContain("more output"); // first line only
  });

  it("does not render a result for a NESTED (sub-agent) tool call — matches tool_use's own visibility rule", () => {
    const s = sink();
    const r = makeRenderer(plan(), s.write);
    r.onEvent!({ type: "tool_use", name: "Read", input: {}, toolUseId: "tu3", parentToolUseId: "parentAgent" });
    r.onEvent!({ type: "tool_result", toolUseId: "tu3", isError: false, text: "file contents here" });
    expect(s.text()).not.toContain("file contents here");
  });

  it("does not render a result when progress is off", () => {
    const s = sink();
    const r = makeRenderer(plan({ progress: false }), s.write);
    r.onEvent!({ type: "tool_use", name: "Bash", input: {}, toolUseId: "tu4" });
    r.onEvent!({ type: "tool_result", toolUseId: "tu4", isError: false, text: "ok" });
    expect(s.text()).not.toContain("ok");
  });
});

describe("renderer — sub-agent dispatch nesting", () => {
  it("indents a nested sub-agent dispatch deeper than its parent", () => {
    const s = sink();
    const r = makeRenderer(plan({ verbose: true }), s.write);
    r.onEvent!({ type: "subagent_dispatch", toolUseId: "a1", agentType: "outer", declaredTools: [] });
    r.onEvent!({ type: "subagent_dispatch", toolUseId: "a2", parentToolUseId: "a1", agentType: "inner", declaredTools: [] });
    const dispatchLines = s
      .text()
      .split("\n")
      .filter((l) => l.includes("sub-agent:"));
    expect(dispatchLines).toHaveLength(2);
    expect(dispatchLines[1].indexOf("└")).toBeGreaterThan(dispatchLines[0].indexOf("└"));
  });

  it("a top-level dispatch renders exactly as before (regression guard)", () => {
    const s = sink();
    const r = makeRenderer(plan({ verbose: true }), s.write);
    r.onEvent!({ type: "subagent_dispatch", toolUseId: "a1", agentType: "researcher", declaredTools: ["Read"] });
    expect(s.text()).toContain("  └ sub-agent: researcher [Read]");
  });
});

describe("toolMarker", () => {
  it("categorizes read/mutate/shell/network tools distinctly", () => {
    expect(toolMarker("Read")).toBe("@");
    expect(toolMarker("Glob")).toBe("@");
    expect(toolMarker("Write")).toBe("#");
    expect(toolMarker("Edit")).toBe("#");
    expect(toolMarker("Bash")).toBe("!");
    expect(toolMarker("WebFetch")).toBe("?");
  });
  it("falls back to the plain dot for anything uncategorized", () => {
    expect(toolMarker("Agent")).toBe("·");
    expect(toolMarker("mcp__workspace__bash")).toBe("·");
  });
});

describe("inputSummary — truncation hint", () => {
  it("adds no hint when the input fits in 80 chars", () => {
    const out = inputSummary({ command: "grep x" });
    expect(out).not.toContain("chars]");
  });

  it("appends how many chars were cut when the input is truncated", () => {
    const input = { text: "x".repeat(200) };
    const full = JSON.stringify(input);
    const out = inputSummary(input);
    const omitted = full.length - 80;
    expect(out).toContain(`[+${omitted} chars]`);
    expect(out.startsWith(full.slice(0, 80))).toBe(true);
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
        nonReproducibleAnswers: [
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

describe("renderFooter — gate provenance line", () => {
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

  it("prints a counts-only gates line on a passing run", () => {
    const s = sink();
    renderFooter({ ...base, gateProvenance: { total: 3, bySource: { scripted: 1, llm: 2 }, gates: [] } }, plan({ color: false }), {
      write: s.write,
    });
    expect(s.text()).toContain("gates: 3 · 2 decided(llm), 1 scripted");
    // smoke check (not a proof): the line is counts + labels only, so no "=" from answer text leaks in.
    expect(s.text()).not.toContain("=");
  });

  it("prints the gates line on a failing run too", () => {
    const s = sink();
    renderFooter({ ...base, result: "error", gateProvenance: { total: 1, bySource: { llm: 1 }, gates: [] } }, plan({ color: false }), {
      write: s.write,
    });
    expect(s.text()).toContain("gates: 1 · 1 decided(llm)");
  });

  it("prints no gates line when the run had none", () => {
    const s = sink();
    renderFooter({ ...base }, plan({ color: false }), { write: s.write });
    expect(s.text()).not.toContain("gates:");
  });
});
