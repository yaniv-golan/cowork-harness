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
  harnessVersion: "4.8.0",
  evaluatorRepair: [{ pass: 2 as const, appended: "}" }],
  summaryIdentity: { name: "demo-analyze", kind: "plugin_skill" as const },
  label: "v1.2.3-rc1",
  source: { kind: "git" as const, ref: "main", path: "plugins/p", commit: "cccccccccccccccccccccccccccccccccccccccc" },
  corpus: {
    corpusHashScheme: 1,
    hashBasis: "git-tracked" as const,
    corpusHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    packagedCorpusHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    skillTreeHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    corpusManifest: [
      {
        origin: "skill_md" as const,
        key: "skills/x/SKILL.md",
        status: "ok" as const,
        sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        bytes: 10,
        keptBytes: 5,
      },
      { origin: "reference" as const, key: "skills/x/references/r.md", status: "unreadable" as const },
      { origin: "agent" as const, key: "agents/gone.md", status: "missing" as const },
    ],
    skillTreeUntracked: ["scripts/scratch.py"],
    skillTreeUntrackedCount: 1,
    corpusDrift: {
      preflightCorpusHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      preflightSkillTreeHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      changed: ["skills/x/SKILL.md"],
    },
  },
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
    evaluatorPass1Tokens: { input: 29_034, output: 36_193, cacheRead: 0 },
    evaluatorPass2Tokens: { input: 31_002, output: 12_500, cacheRead: 0 },
    totalUsd: 1.24,
    complete: true,
  },
  gradedSkill: "demo-analyze",
  skillInvocationObserved: true,
  commandShadowsSkill: true,
  referenceAccessUnobservable: true,
  gateAnswers: [{ question: "Which format?", answer: "Markdown", answeredBy: "scripted" }],
  taskResult: "success" as const,
  gradedOutcome: "delivered_clean",
  gradedSkillHash: "abc123def4567890",
  gradedModels: ["claude-opus-5"],
  gradedErrorReason: "usage-limit — the account's quota is exhausted; retry after the reset",
  selfReportStatus: "captured" as const,
  evaluatorIntegrity: { pass1Canary: true, pass2Canary: true },
  droppedEvaluatorItems: { pass1: 1, pass2: 0 },
  turn1ResultDegraded: false,
  turn1SliceDegraded: false,
  skillMdStatus: "readable" as const,
  evidenceBudget: {
    corpusBytes: 12_345,
    corpusCeiling: 524_288,
    corpusCuts: [{ name: "references/big.md", keptBytes: 100, totalBytes: 900, omitted: false }],
    corpusExcluded: ["references/untracked.md"],
    // Both of these must be EMITTED here, not merely declared in the schema: the test strictens a clone of
    // the schema and validates this fixture against it, so a field the fixture never produces leaves the
    // schema under-declared with the test green. `corpusPackaged` shipped without a fixture entry for
    // exactly that reason.
    corpusPackaged: ["SKILL.md", "references/big.md", "agents/x.md", "plug/references/shared.md"],
    corpusOmitted: [
      { name: "plug/references/other-skill.md", reason: "not-linked" as const },
      { name: "plug/references/brand/font.woff2", reason: "not-utf8" as const },
      { name: "plug/references/dup.md", reason: "ambiguous-read" as const, alsoUntracked: true },
    ],
    trimRecord: [{ section: "Transcript (turn 1 only …)", droppedBytes: 42 }],
    packageTruncated: true,
  },
  noSkillFilesRead: true,
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

/** What a CONSUMER actually parses. `buildJsonReport` leaves optional keys present with an `undefined`
 *  value; `JSON.stringify` drops them. Validating the in-memory object therefore tests a shape nobody
 *  ever receives — and ajv skips both type checks and `dependentRequired` for a present-but-undefined
 *  key, so a missing required companion field read as satisfied. Round-trip first. */
function asEmitted(report: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
}

function assertValid(report: Record<string, unknown>, label: string): void {
  const ok = validate(asEmitted(report));
  expect(ok, `${label}: ${JSON.stringify(validate.errors, null, 2)}\nreport: ${JSON.stringify(report, null, 2)}`).toBe(true);
}

describe("critique-report.json schema ↔ buildJsonReport", () => {
  it("a fully-populated FINDINGS report validates (and every emitted field is declared — additionalProperties:false)", () => {
    assertValid(buildJsonReport(FULL_STATE), "findings branch");
  });

  it("the infraFailure branch validates", () => {
    assertValid(
      buildJsonReport({
        ...FULL_STATE,
        evaluatorModel: undefined,
        infraFailure: "reflection turn exited 1",
        infraFailurePhase: "reflection turn",
      }),
      "infra branch",
    );
  });

  it("REFUSES an infraFailure with no phase — the shape that falls back to the old hardcoded wrong label", () => {
    // buildJsonReport is exported, so an external caller can construct this; the text renderer then
    // defaults the phase to "reflection turn" and can name the wrong turn. The schema is where that
    // pairing is stated, so it must actually be enforced rather than only described in prose.
    expect(validate(asEmitted(buildJsonReport({ ...FULL_STATE, evaluatorModel: undefined, infraFailure: "exited 1" })))).toBe(false);
  });

  it("the infraFailure branch validates WITH its phase/kind — the fields that say which turn failed and why", () => {
    assertValid(
      buildJsonReport({
        ...FULL_STATE,
        evaluatorModel: undefined,
        infraFailure: "task turn exited 2 reporting unanswered: unanswered question",
        infraFailurePhase: "task turn",
        infraFailureKind: "unanswered",
      }),
      "infra branch (phase + kind)",
    );
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
