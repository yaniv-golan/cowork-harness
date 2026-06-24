import { describe, it, expect } from "vitest";
import { ScriptedDecider, UnansweredError } from "../src/decide/decider.js";
import { recordErrorText } from "../src/run/cassette.js";
import type { DecisionRequest } from "../src/agent/session.js";
import type { RunContext } from "../src/decide/decider.js";

const ctx: RunContext = { task: "", transcript: () => "", toolLog: () => [], runId: "t" };
const gate = (question: string, options: string[]): DecisionRequest => ({
  id: "g1",
  kind: "question",
  questions: [{ question, options: options.map((label) => ({ label })) }],
});

describe("scripted-answer mismatch surfaces the offered labels (+ closest match)", () => {
  it("a choose: matching no offered option throws an UnansweredError whose hint lists the valid labels", async () => {
    const d = new ScriptedDecider([{ when_question: "model", choose: "Yes — ~10% of cap table" }]);
    let err: unknown;
    try {
      await d.decide(gate("Which scenarios should I model?", ["Yes — I'll provide counts", "Yes — 1,500,000 authorized"]), ctx);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UnansweredError);
    const hint = (err as UnansweredError).hint;
    expect(hint).toMatch(/valid labels:/);
    expect(hint).toContain("Yes — I'll provide counts");
    expect(hint).toContain("Yes — 1,500,000 authorized");
  });

  it("suggests the closest offered option when the answer is a near-miss", async () => {
    const d = new ScriptedDecider([{ when_question: "confirm", choose: "Confirmd" }]); // typo of "Confirmed"
    let err: unknown;
    try {
      await d.decide(gate("Confirm the snapshot?", ["Confirmed", "Different"]), ctx);
    } catch (e) {
      err = e;
    }
    expect((err as UnansweredError).hint).toMatch(/closest: "Confirmed"/);
  });

  it("does NOT mis-suggest when nothing is close", async () => {
    const d = new ScriptedDecider([{ when_question: "confirm", choose: "totally unrelated string" }]);
    let err: unknown;
    try {
      await d.decide(gate("Confirm?", ["Confirmed", "Different"]), ctx);
    } catch (e) {
      err = e;
    }
    expect((err as UnansweredError).hint).not.toMatch(/closest:/);
  });
});

describe("recordErrorText — surfaces the hint with a double-print guard", () => {
  it("appends the hint when the message does NOT already contain it (the mismatch case)", () => {
    const e = new UnansweredError('scripted answer "X" matched no offered option', 'valid labels: "A", "B"');
    expect(recordErrorText(e)).toBe('scripted answer "X" matched no offered option\n    valid labels: "A", "B"');
  });

  it("does NOT double-print when the hint is already a substring of the message (the on_unanswered:fail case)", () => {
    const lines = "  • Q\n    options: A | B";
    const e = new UnansweredError(`unscripted AskUserQuestion (on_unanswered=fail):\n${lines}`, lines);
    expect(recordErrorText(e)).toBe(`unscripted AskUserQuestion (on_unanswered=fail):\n${lines}`); // hint suppressed
  });

  it("a plain Error is unchanged", () => {
    expect(recordErrorText(new Error("boom"))).toBe("boom");
  });
});
