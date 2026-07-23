import { describe, it, expect } from "vitest";
import { buildJsonReport, buildTextReport, VERDICT_PROVENANCE } from "../src/critique/command.js";

// critique's verdict is a SELF-RUN over author-trusted input, graded by a blinded evaluator — NOT an
// independent attestation. A skill author controls the SKILL.md that enters the evaluator's prompt, so a
// crafted one can steer the grade; that is acceptable ONLY because the verdict is advisory and the person
// running it is the person relying on it. This stamp is what stops a downstream harvester from promoting an
// advisory self-critique into an attestation. It is DISTINCT from "never a gate / findings exit 0".
const state = {
  skillFolder: "./s",
  prompt: "p",
  sessionId: "sess-1",
  outDir: "/runs/x",
  fidelity: "container",
  taskResult: "success" as const,
  gradedOutcome: "delivered_clean",
  gradedSkillHash: "abcdef0123456789",
  selfReportStatus: "captured" as const,
  items: [],
  requestedModel: "m",
};

describe("verdict provenance is stamped on every report", () => {
  it("the constant declares an advisory, non-attestation self-run with an actionable caveat", () => {
    expect(VERDICT_PROVENANCE.kind).toBe("self-run");
    expect(VERDICT_PROVENANCE.advisory).toBe(true);
    expect(VERDICT_PROVENANCE.caveat).toMatch(/not an independent attestation/i);
    expect(VERDICT_PROVENANCE.caveat).toMatch(/steer/i);
  });

  it("the JSON report carries verdictProvenance on the success path", () => {
    const j = buildJsonReport(state);
    expect(j.verdictProvenance).toEqual(VERDICT_PROVENANCE);
  });

  it("it rides the infra-failure branch too — where a consumer is MOST likely to misread a partial result", () => {
    const j = buildJsonReport({ ...state, infraFailure: "reflection protocol broke", items: [] });
    expect(j.verdictProvenance, "verdictProvenance vanished on the infra-failure branch").toEqual(VERDICT_PROVENANCE);
  });

  it("it rides the evaluator-error branch too", () => {
    const j = buildJsonReport({ ...state, evaluatorError: "evaluator threw", items: [] });
    expect(j.verdictProvenance).toEqual(VERDICT_PROVENANCE);
  });

  it("the text report shows the advisory scope in its header", () => {
    const t = buildTextReport(state);
    expect(t).toMatch(/verdict scope: advisory self-run/i);
    expect(t).toMatch(/not an independent attestation/i);
  });
});
