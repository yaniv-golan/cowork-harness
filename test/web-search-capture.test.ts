import { describe, it, expect } from "vitest";
import type { AgentEvent, AgentSession, DecisionResponse } from "../src/agent/session.js";
import { Run } from "../src/run/run.js";
import { ScriptedDecider } from "../src/decide/decider.js";

class MockSession implements AgentSession {
  constructor(private events: AgentEvent[]) {}
  async *start(): AsyncIterable<AgentEvent> {
    for (const e of this.events) yield e;
  }
  sendUserTurn() {}
  respond() {}
  close() {}
}

describe("Run — WebSearch capture", () => {
  it("captures the query and parses per-result title/url from the Links array", async () => {
    const ev: AgentEvent[] = [
      { type: "tool_use", name: "WebSearch", input: { query: "field service management software market size" }, toolUseId: "toolu_1" },
      {
        type: "tool_result",
        toolUseId: "toolu_1",
        isError: false,
        text:
          'Web search results for query: "field service management software market size"\n\n' +
          'Links: [{"title":"IBISWorld Report","url":"https://www.ibisworld.com/x"},{"title":"Statista","url":"https://www.statista.com/y"}]\n\n' +
          "Field service management software is projected to grow...",
      },
      { type: "result", isError: false },
    ];
    const rec = await new Run(new MockSession(ev), new ScriptedDecider([])).drive("go");

    expect(rec.webSearches).toEqual([
      {
        toolUseId: "toolu_1",
        query: "field service management software market size",
        results: [
          { title: "IBISWorld Report", url: "https://www.ibisworld.com/x" },
          { title: "Statista", url: "https://www.statista.com/y" },
        ],
      },
    ]);
  });

  it("handles a title containing a literal ']' without truncating the array (string-aware bracket matching)", async () => {
    const ev: AgentEvent[] = [
      { type: "tool_use", name: "WebSearch", input: { query: "q" }, toolUseId: "toolu_1" },
      {
        type: "tool_result",
        toolUseId: "toolu_1",
        isError: false,
        text: 'Web search results for query: "q"\n\nLinks: [{"title":"[2025] Market Report","url":"https://x.com"}]\n\nSummary.',
      },
    ];
    const rec = await new Run(new MockSession(ev), new ScriptedDecider([])).drive("go");
    expect(rec.webSearches).toEqual([
      { toolUseId: "toolu_1", query: "q", results: [{ title: "[2025] Market Report", url: "https://x.com" }] },
    ]);
  });

  it("handles a title containing an UNBALANCED literal ']' (no matching '[') — proves string-awareness, not just coincidentally-balanced brackets", async () => {
    // Unlike the "[2025] Market Report" case above (a balanced [/] pair inside the string, which a naive
    // bracket-depth counter would also get right by coincidence: depth goes 1->2->1->0), this title has a
    // LONE ']' with no matching '[' inside the string. A naive counter would decrement depth to 0 right
    // there and return a truncated, unparseable slice; only true string-awareness (ignoring brackets while
    // inString) gets this right.
    const ev: AgentEvent[] = [
      { type: "tool_use", name: "WebSearch", input: { query: "q" }, toolUseId: "toolu_1" },
      {
        type: "tool_result",
        toolUseId: "toolu_1",
        isError: false,
        text: 'Web search results for query: "q"\n\nLinks: [{"title":"Report ] final","url":"https://x.com"}]\n\nSummary.',
      },
    ];
    const rec = await new Run(new MockSession(ev), new ScriptedDecider([])).drive("go");
    expect(rec.webSearches).toEqual([{ toolUseId: "toolu_1", query: "q", results: [{ title: "Report ] final", url: "https://x.com" }] }]);
  });

  it("drops the entry (never crashes) when the tool_result text has no parseable Links array", async () => {
    const ev: AgentEvent[] = [
      { type: "tool_use", name: "WebSearch", input: { query: "q" }, toolUseId: "toolu_1" },
      { type: "tool_result", toolUseId: "toolu_1", isError: true, text: "Error: search failed" },
    ];
    const rec = await new Run(new MockSession(ev), new ScriptedDecider([])).drive("go");
    expect(rec.webSearches).toEqual([]);
  });

  it("does not affect non-WebSearch tool calls", async () => {
    const ev: AgentEvent[] = [
      { type: "tool_use", name: "Bash", input: { command: "ls" }, toolUseId: "toolu_1" },
      { type: "tool_result", toolUseId: "toolu_1", isError: false, text: "file1\nfile2" },
    ];
    const rec = await new Run(new MockSession(ev), new ScriptedDecider([])).drive("go");
    expect(rec.webSearches).toEqual([]);
  });
});
