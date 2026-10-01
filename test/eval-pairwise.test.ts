import { describe, it, expect } from "vitest";
import { classifyRep, semanticRefusalReason, type ClassifiableResult } from "../src/eval/classify.js";
import { resolveJudgePins } from "../src/eval/pins.js";
import { JUDGE_PROMPT_HASH } from "../src/decide/semantic-judge.js";
import { PAIRWISE_PROMPT_HASH } from "../src/decide/pairwise-judge.js";
import type { Assertion, Scenario } from "../src/types.js";

const pw = { semantic_pairwise: { rubric: ["x"], refs: ["/r"] } } as Assertion;
const sc = (a: Assertion[]): Scenario => ({ name: "s", assert: a }) as unknown as Scenario;
type G = NonNullable<ClassifiableResult["assertions"]>[number];

describe("eval: semantic_pairwise", () => {
  it("requires a concrete judge model, and --judge-model pins pairwise asserts too", () => {
    expect(() => resolveJudgePins([sc([{ semantic_pairwise: { judge_model: "opus" } } as Assertion])], undefined)).toThrow(
      /CONCRETE judge model/,
    );
    expect(resolveJudgePins([sc([pw])], "claude-opus-4-8").resolved).toEqual([
      { scenario: "s", assertionIndex: 0, model: "claude-opus-4-8" },
    ]);
  });

  it("a reference that could not be read is a refusal (reference_unavailable), never a fail", () => {
    const g: G = { assertion: pw, pass: false, pairwise: [{ ref: "r", status: "missing" }] };
    expect(semanticRefusalReason(g)).toBe("reference_unavailable");
    expect(
      semanticRefusalReason({ assertion: pw, pass: false, pairwise: [{ ref: "r", status: "graded", outcome: "loss" }] }),
    ).toBeUndefined();
    expect(semanticRefusalReason({ assertion: pw, pass: false, semanticEvidence: { reason: "evidence_incomplete" } })).toBe(
      "evidence_incomplete",
    );
    expect(
      semanticRefusalReason({ assertion: pw, pass: false, judgeInvalid: true, pairwise: [{ ref: "r", status: "missing" }] }),
    ).toBeUndefined();
  });

  it("a pairwise grade is held to the pairwise prompt hash, not the pointwise one", () => {
    const base: ClassifiableResult = { result: "success", modelPinHonored: true, fingerprint: { contentSig: "sig" } } as ClassifiableResult;
    const ok = { ...base, assertions: [{ assertion: pw, pass: true, judgePromptHash: PAIRWISE_PROMPT_HASH }] };
    const bad = { ...base, assertions: [{ assertion: pw, pass: true, judgePromptHash: "0000000000000000" }] };
    const expected = { contentSig: "sig", judgePromptHash: JUDGE_PROMPT_HASH };
    expect(classifyRep({ result: ok }, expected).bucket).toBe("valid");
    expect(classifyRep({ result: bad }, expected).bucket).toBe("judge_prompt_mismatch");
  });
});
