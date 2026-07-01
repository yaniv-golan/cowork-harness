import { describe, it, expect } from "vitest";
import { summarizeGateProvenance, labelSource, formatGateProvenanceLine } from "../src/run/gate-provenance.js";
import type { RunResult } from "../src/types.js";

type Decisions = RunResult["decisions"];

describe("summarizeGateProvenance", () => {
  it("ignores non-question decisions and rolls up question gates by source", () => {
    const decisions: Decisions = [
      { kind: "tool", name: "Bash", decision: "allow", by: "cowork" },
      { kind: "question", name: "AskUserQuestion", decision: "answered", by: "scripted", detail: { "Proceed?": "Yes" } },
      { kind: "question", name: "AskUserQuestion", decision: "answered", by: "llm", model: "claude-sonnet-4-5", detail: { "Stage?": "Series B+" } },
      { kind: "dialog", name: "dialog", decision: "accept", by: "cowork" },
    ];
    const s = summarizeGateProvenance(decisions);
    expect(s.total).toBe(2);
    expect(s.bySource).toEqual({ scripted: 1, llm: 1 });
    expect(s.gates).toEqual([
      { question: "Proceed?", answeredBy: "scripted", answer: "Proceed?=Yes", model: undefined },
      { question: "Stage?", answeredBy: "llm", answer: "Stage?=Series B+", model: "claude-sonnet-4-5" },
    ]);
  });

  it("flattens a multi-question gate into one entry with joined question + answer", () => {
    const decisions: Decisions = [
      { kind: "question", name: "AskUserQuestion", decision: "answered", by: "first", detail: { "A?": "x", "B?": "y" } },
    ];
    const s = summarizeGateProvenance(decisions);
    expect(s.gates[0]).toEqual({ question: "A? / B?", answeredBy: "first", answer: "A?=x; B?=y", model: undefined });
  });

  it("counts a missing `by` as \"unknown\" rather than dropping the gate", () => {
    const decisions: Decisions = [{ kind: "question", name: "AskUserQuestion", decision: "answered", by: undefined, detail: {} }];
    const s = summarizeGateProvenance(decisions);
    expect(s.total).toBe(1);
    expect(s.bySource).toEqual({ unknown: 1 });
  });

  it("skips a non-answered question decision (mismatch→deny / abstain→deny carry no answers)", () => {
    const decisions: Decisions = [
      { kind: "question", name: "AskUserQuestion", decision: "mismatch→deny", by: "strict" },
      { kind: "question", name: "AskUserQuestion", decision: "abstain→deny", by: "none" },
      { kind: "question", name: "AskUserQuestion", decision: "answered", by: "scripted", detail: { "Ok?": "Yes" } },
    ];
    const s = summarizeGateProvenance(decisions);
    expect(s.total).toBe(1);
    expect(s.bySource).toEqual({ scripted: 1 });
  });

  it("returns an empty summary for a run with no gates", () => {
    expect(summarizeGateProvenance([])).toEqual({ total: 0, bySource: {}, gates: [] });
  });
});

describe("labelSource", () => {
  it("maps known sources to friendly labels and passes unknowns through verbatim", () => {
    expect(labelSource("scripted")).toBe("scripted");
    expect(labelSource("first")).toBe("first-option");
    expect(labelSource("llm")).toBe("decided(llm)");
    expect(labelSource("external")).toBe("decided(external)");
    expect(labelSource("human")).toBe("prompt");
    expect(labelSource("some-future-source")).toBe("some-future-source");
  });
});

describe("formatGateProvenanceLine", () => {
  it("returns a counts-only one-liner, most-frequent source first", () => {
    const line = formatGateProvenanceLine({ total: 3, bySource: { scripted: 1, llm: 2 }, gates: [] });
    expect(line).toBe("gates: 3 · 2 decided(llm), 1 scripted");
  });

  it("returns null when there are no gates (nothing to say)", () => {
    expect(formatGateProvenanceLine({ total: 0, bySource: {}, gates: [] })).toBeNull();
  });
});
