import { describe, expect, it } from "vitest";
import {
  diffSemanticClaims,
  formatReport,
  type ResultInput,
  type RunResultLike,
  type SemanticClaim,
} from "../scripts/eval-gate-diff.js";

/** Build a minimal result.json-like object with a single `semantic_matches` assertion whose
 *  `semanticClaims` are as given. `rubric` defaults to the claim texts (in index order) so the
 *  rubricKey match works the same way it would for a hand-authored fixture that only bothered to
 *  populate `semanticClaims`. */
function makeResult(claims: SemanticClaim[], rubric?: string[]): ResultInput {
  const rubricArr = rubric ?? claims.slice().sort((a, b) => a.index - b.index).map((c) => c.claim);
  return {
    assertions: [
      {
        assertion: { semantic_matches: { rubric: rubricArr } },
        pass: claims.every((c) => c.pass),
        semanticClaims: claims,
      },
    ],
  };
}

describe("diffSemanticClaims", () => {
  it("detects a regression (pass -> fail) and reports the claim text", () => {
    const baseline = makeResult([
      { index: 0, claim: "mentions the refund policy", pass: true },
      { index: 1, claim: "includes a next-step CTA", pass: true },
    ]);
    const candidate = makeResult([
      { index: 0, claim: "mentions the refund policy", pass: false },
      { index: 1, claim: "includes a next-step CTA", pass: true },
    ]);
    const report = diffSemanticClaims(baseline, candidate);
    expect(report.regressions).toEqual([{ rubricKey: expect.any(String), index: 0, claim: "mentions the refund policy" }]);
    expect(report.improvements).toEqual([]);
    expect(report.unchanged).toBe(1);
    expect(report.unmatched.baselineOnly).toEqual([]);
    expect(report.unmatched.candidateOnly).toEqual([]);

    const text = formatReport(report);
    expect(text).toContain("1 regression");
    expect(text).toContain("mentions the refund policy");
  });

  it("does not count an improvement (fail -> pass) as a regression", () => {
    const baseline = makeResult([{ index: 0, claim: "greets the customer by name", pass: false }]);
    const candidate = makeResult([{ index: 0, claim: "greets the customer by name", pass: true }]);
    const report = diffSemanticClaims(baseline, candidate);
    expect(report.regressions).toEqual([]);
    expect(report.improvements).toEqual([{ rubricKey: expect.any(String), index: 0, claim: "greets the customer by name" }]);
    expect(report.unchanged).toBe(0);

    const text = formatReport(report);
    expect(text).toContain("no regressions");
    expect(text).toContain("1 improvement");
  });

  it("counts claims that hold the same pass/fail value on both sides as unchanged", () => {
    const baseline = makeResult([
      { index: 0, claim: "states the price", pass: true },
      { index: 1, claim: "states a shipping estimate", pass: false },
    ]);
    const candidate = makeResult([
      { index: 0, claim: "states the price", pass: true },
      { index: 1, claim: "states a shipping estimate", pass: false },
    ]);
    const report = diffSemanticClaims(baseline, candidate);
    expect(report.regressions).toEqual([]);
    expect(report.improvements).toEqual([]);
    expect(report.unchanged).toBe(2);
  });

  it("puts an assert present in only one run under unmatched, never as a false regression", () => {
    const baseline = makeResult([{ index: 0, claim: "only in baseline", pass: true }]);
    const candidate = makeResult([{ index: 0, claim: "only in candidate", pass: true }]);
    const report = diffSemanticClaims(baseline, candidate);
    expect(report.regressions).toEqual([]);
    expect(report.improvements).toEqual([]);
    expect(report.unchanged).toBe(0);
    expect(report.unmatched.baselineOnly).toHaveLength(1);
    expect(report.unmatched.baselineOnly[0].claims).toEqual([{ index: 0, claim: "only in baseline", pass: true }]);
    expect(report.unmatched.candidateOnly).toHaveLength(1);
    expect(report.unmatched.candidateOnly[0].claims).toEqual([{ index: 0, claim: "only in candidate", pass: true }]);

    const text = formatReport(report);
    expect(text).toContain("present only in baseline");
    expect(text).toContain("present only in candidate");
  });

  it("unwraps the --output-format json envelope ({results:[RunResult]}) the same as a raw RunResult", () => {
    const rawBaseline = makeResult([{ index: 0, claim: "has a subject line", pass: true }]);
    const rawCandidate = makeResult([{ index: 0, claim: "has a subject line", pass: false }]);
    const envelopeBaseline: ResultInput = { results: [rawBaseline as any] };
    const envelopeCandidate: ResultInput = { results: [rawCandidate as any] };

    const reportFromEnvelope = diffSemanticClaims(envelopeBaseline, envelopeCandidate);
    const reportFromRaw = diffSemanticClaims(rawBaseline, rawCandidate);
    expect(reportFromEnvelope.regressions).toEqual(reportFromRaw.regressions);
    expect(reportFromEnvelope.regressions).toHaveLength(1);
  });

  it("returns an empty report and does not crash for a run with no semantic asserts", () => {
    const baseline: RunResultLike = {
      assertions: [{ assertion: { file_exists: "outputs/report.pdf" } as any, pass: true }],
    };
    const candidate: RunResultLike = { assertions: [] };
    const report = diffSemanticClaims(baseline, candidate);
    expect(report).toEqual({
      regressions: [],
      improvements: [],
      unchanged: 0,
      unmatched: { baselineOnly: [], candidateOnly: [] },
    });

    const text = formatReport(report);
    expect(text).toContain("no regressions");
    expect(text).not.toContain("regression(s)"); // no false "N regression(s)" line when N is 0

    // Also exercise a fully empty / missing-assertions shape (no `assertions` key at all).
    const empty = diffSemanticClaims({} as ResultInput, {} as ResultInput);
    expect(empty.regressions).toEqual([]);
    expect(empty.unchanged).toBe(0);
  });
});
