import { describe, it, expect } from "vitest";
import { REFLECTION_PROMPT, REFLECTION_PROMPT_VERSION } from "../src/critique/command.js";
import { buildPass2Prompt, SELF_REPORT_MAX_CHARS } from "../src/critique/evaluator.js";
import { armorEvidence } from "../src/critique/armor.js";

describe("reflection prompt v2", () => {
  it("is versioned 2", () => {
    expect(REFLECTION_PROMPT_VERSION).toBe(2);
  });

  it("asks about sub-agents", () => {
    expect(REFLECTION_PROMPT).toMatch(/sub-agent/i);
  });

  it("solicits every change, not a single one", () => {
    // The "ONE thing" cap loses signal: a separate evaluator already triages and drops ungrounded
    // findings, so capping at the source buys no quality.
    expect(REFLECTION_PROMPT).not.toMatch(/ONE thing/);
    expect(REFLECTION_PROMPT).toMatch(/EVERY change|every change/);
  });

  it("does not use cowork-harness vocabulary a third-party skill's agent never saw", () => {
    // "fidelity tier" is ours, not the reflecting agent's — and the acceptance fixture's own
    // confabulation seed is a fidelity-tier claim, i.e. the phrase attracts fabrication.
    expect(REFLECTION_PROMPT).not.toMatch(/fidelity tier/i);
  });
});

describe("pass 2 self-report bounding", () => {
  it("truncates an oversized self-report and marks the truncation", () => {
    const huge = "x".repeat(SELF_REPORT_MAX_CHARS + 5_000);
    const prompt = buildPass2Prompt(
      armorEvidence([{ title: "Evidence", body: "evidence pkg" }], "0123456789abcdef"),
      [],
      huge,
      false,
      false,
    );
    expect(prompt.length).toBeLessThan(huge.length);
    expect(prompt).toMatch(/self-report truncated/i);
  });

  it("leaves a normal-sized self-report intact", () => {
    const normal = "The skill was unclear about output formatting.";
    const prompt = buildPass2Prompt(
      armorEvidence([{ title: "Evidence", body: "evidence pkg" }], "0123456789abcdef"),
      [],
      normal,
      false,
      false,
    );
    expect(prompt).toContain("output formatting");
    expect(prompt).not.toMatch(/self-report truncated/i);
  });
});
