import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv from "ajv";
import { buildJsonReport } from "../src/critique/command";

// Pins `schema/critique-report.json` (EXPERIMENTAL, descriptive — deliberately NOT a §12-frozen surface;
// see the schema's own description) against the ACTUAL buildJsonReport output. Same two-way drift
// tripwire as run-result-schema.test.ts:
//  - a FULLY POPULATED report validated against the published schema catches a declared property whose
//    shape drifted;
//  - the same report against a deep-STRICTENED clone (additionalProperties:false is already set at every
//    level in this schema) catches an EMITTED field the schema never declares — the exact gap this
//    schema exists to close (field names/shapes living only in prose and feedback channels).
// All three outcome branches (findings / infraFailure / evaluatorError) are validated: each returns a
// different top-level shape.

const schema = JSON.parse(readFileSync(resolve(__dirname, "..", "schema", "critique-report.json"), "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

/** Every optional field populated, so a schema that under-declares any of them fails loud. */
const FULL_STATE = {
  skillFolder: "./plugin",
  prompt: "probe",
  sessionId: "crit-x",
  outDir: "/runs/skill-plugin/sess-crit-x",
  fidelity: "hostloop",
  gradedEffectiveFidelity: "hostloop",
  gradedBaseline: "1.24012.1",
  costUsd: {
    taskTurnUsd: 0.09,
    reflectionTurnUsd: 0.2,
    evaluatorPass1Usd: 0.45,
    evaluatorPass2Usd: 0.5,
    totalUsd: 1.24,
    complete: true,
  },
  gradedSkill: "demo-analyze",
  skillInvocationObserved: true,
  gateAnswers: [{ question: "Which format?", answer: "Markdown", answeredBy: "scripted" }],
  taskResult: "success" as const,
  gradedOutcome: "delivered_clean",
  gradedSkillHash: "abc123def4567890",
  selfReportStatus: "captured" as const,
  evaluatorIntegrity: { pass1Canary: true, pass2Canary: true },
  droppedEvaluatorItems: { pass1: 1, pass2: 0 },
  turn1ResultDegraded: false,
  turn1SliceDegraded: false,
  skillMdStatus: "readable" as const,
  skillMdTruncated: true,
  evaluatorModel: "claude-opus-4-8-20260115",
  requestedModel: "claude-opus-4-8",
  items: [
    {
      source: "evaluator" as const,
      idea: "add a tier table",
      classification: "grounded-and-actionable" as const,
      evidence: "the agent guessed the tier",
      recommendedAction: "document it",
      citationResolved: true,
      findingFingerprint: "0123456789abcdef",
    },
  ],
};

function assertValid(report: Record<string, unknown>, label: string): void {
  const ok = validate(report);
  expect(ok, `${label}: ${JSON.stringify(validate.errors, null, 2)}\nreport: ${JSON.stringify(report, null, 2)}`).toBe(true);
}

describe("critique-report.json schema ↔ buildJsonReport", () => {
  it("a fully-populated FINDINGS report validates (and every emitted field is declared — additionalProperties:false)", () => {
    assertValid(buildJsonReport(FULL_STATE), "findings branch");
  });

  it("the infraFailure branch validates", () => {
    assertValid(buildJsonReport({ ...FULL_STATE, evaluatorModel: undefined, infraFailure: "reflection turn exited 1" }), "infra branch");
  });

  it("the evaluatorError branch validates", () => {
    assertValid(
      buildJsonReport({ ...FULL_STATE, evaluatorModel: undefined, evaluatorError: "pass 2: no valid items" }),
      "evaluator-error branch",
    );
  });

  it("a minimal report (plain skill folder, nothing optional) validates", () => {
    assertValid(
      buildJsonReport({
        skillFolder: "./s",
        prompt: "p",
        sessionId: "crit-y",
        outDir: "/runs/x",
        fidelity: "container",
        taskResult: undefined,
        selfReportStatus: "unavailable",
        items: [],
        requestedModel: "m",
      }),
      "minimal",
    );
  });

  it("the schema self-declares as experimental, not §12-frozen (the deliberate contrast with doctor.json)", () => {
    expect(schema.description).toMatch(/NOT a SPEC §12-frozen surface/);
  });
});
