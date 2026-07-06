import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv from "ajv";
import type { RunResult } from "../src/types.js";

// Pins `schema/run-result.json` (a §12-covered 1.0 surface) against the ACTUAL `RunResult` shape.
// Before this test, the schema was only weakly checked: `verify-envelope-schema.test.ts` pins a
// DIFFERENT file (schema/verify-cassettes.json), and `gate-provenance.test.ts` merely asserts 3 named
// props exist on the schema. Neither catches a RunResult field that's emitted but undeclared in the
// schema, or a schema property that no longer corresponds to anything the type emits.
//
// Strategy (mirrors verify-envelope-schema.test.ts's two-way drift tripwire): validate a FULLY
// POPULATED, type-checked `RunResult` literal against the schema TWICE —
//  - once against the published (permissive) schema — catches a MISSING declared property
//    (required-shape drift), and
//  - once against a deep-STRICTENED clone (additionalProperties:false injected at every object level
//    that declares `properties`) — catches an EMITTED field the schema never declares at all, which is
//    exactly the M2 gap (the run-result schema wasn't test-enforced).
// The literal is declared `: RunResult` so a future field added to the interface but forgotten here is
// itself a compile error (tsc -p tsconfig.test.json), not just a silent schema gap.

const schema = JSON.parse(readFileSync(resolve("schema/run-result.json"), "utf8"));

/** Deep-copy the schema with additionalProperties:false on every object node that declares properties. */
function stricten(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stricten);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = stricten(v);
    if (out.type === "object" && out.properties) out.additionalProperties = false;
    return out;
  }
  return node;
}

const ajv = new Ajv({ strict: true });
const validatePublished = ajv.compile(schema);
const strict = stricten(schema) as Record<string, unknown>;
delete strict.$id; // ajv rejects two compilations under one $id
const validateStrict = ajv.compile(strict);

// Every field `RunResult` (src/types.ts) can emit, populated with a representative value. Kept in one
// literal (rather than per-test partials) so both validations exercise the full envelope at once.
const full: RunResult = {
  $schema: "https://raw.githubusercontent.com/yaniv-golan/cowork-harness/main/schema/run-result.json",
  generator: "cowork-harness",
  scenario: "example",
  prompt: "do the thing",
  fidelity: "container",
  baseline: "1.18286.0",
  result: "success",
  resultErrorKind: "transport",
  stalledOnQuestion: false,
  capabilityProbe: "definitive",
  requiresCapabilityUnmet: { caps: ["office_convert"], reason: "omitted" },
  decisions: [
    { kind: "question", name: "AskUserQuestion", decision: "answered", by: "scripted", model: undefined, detail: {}, rationale: undefined },
  ],
  toolCounts: { Bash: 1 },
  toolDurations: { Bash: { calls: 1, totalMs: 240, maxMs: 240 } },
  models: ["claude-sonnet-4-5"],
  thinking: [{ text: "considering the approach" }],
  toolErrors: { Bash: { calls: 2, errors: 1 } },
  modelUsage: { "claude-opus-4-8": { inputTokens: 100, outputTokens: 50, costUSD: 0.01, cacheReadInputTokens: 200 } },
  redundantToolCalls: [{ name: "Bash", argHash: "a".repeat(16), count: 3 }],
  skillActivity: [
    { skillId: "my-plugin:my-skill", invocationSeq: 3, toolCounts: { Bash: 1 }, toolCallCount: 1, dispatchCount: 0, durationMs: 120 },
  ],
  gateDeliveries: [{ question: "Proceed?", delivered: true, error: undefined, reason: "ok" }],
  egress: [{ host: "api.anthropic.com", decision: "allow" }],
  assertions: [{ assertion: { result: "success" }, pass: true, message: undefined }],
  subagents: [
    {
      toolUseId: "tu_1",
      parentToolUseId: undefined,
      agentType: "general-purpose",
      declaredTools: ["Read"],
      toolsUsed: [{ name: "Read", count: 1 }],
      description: "explore",
      attributedSkillId: "my-plugin:my-skill",
    },
  ],
  nonReproducibleAnswers: [{ question: "Format?", chosen: "PDF", by: "llm", rationale: "best fit", model: "claude-sonnet-4-5" }],
  // Only the documented `turns` key — `usage` is otherwise an intentional open SDK pass-through
  // (`UsageInfo = Record<string, unknown> & { turns?: number }`), so its schema node declares just
  // `turns` and correctly stays permissive under the strictened pass too.
  usage: { turns: 3 },
  cost: { usd: 0.01, raw: { total_cost_usd: 0.01 } },
  durationMs: 1234,
  fingerprint: {
    baseline: "1.18286.0",
    skillHash: "a".repeat(64),
    skillSources: ["skills/my-skill"],
    skillScope: ["my-skill"],
    sharedHash: "b".repeat(64),
    contentSig: "c".repeat(64),
    fileSigs: [["skills/my-skill/SKILL.md", "d".repeat(64)]],
    fileSigsOmitted: false,
    mode: "git",
    agentScope: "skill",
  },
  outDir: "/runs/example/local_abc",
  workDir: "/runs/example/local_abc/work/session/mnt",
  outputsDir: "/runs/example/local_abc/work/session/mnt/outputs",
  userVisibleRoots: ["outputs", "project"],
  readonlyFolderRoots: ["project"],
  artifacts: [{ path: "outputs/report.pdf", bytes: 42 }],
  preRunPaths: ["project/existing.txt"],
  partial: false,
  unansweredGate: { message: "no rule matched", hint: "add a --answer rule" },
  nonDeterministic: true,
  nonDeterministicTerminal: true,
  permissiveAutoAllow: ["Bash"],
  scan: { outputsDeletes: [], hostPathLeaked: false, selfHealRan: false },
  effectiveFidelity: "container",
  fidelityWarnings: ["referenced asset not found"],
  l0PluginDivergence: false,
  missingCapabilityUse: ["office_convert"],
  gateProvenance: {
    total: 1,
    bySource: { scripted: 1 },
    gates: [{ question: "Proceed?", answeredBy: "scripted", answer: "Proceed?=Yes", model: undefined }],
  },
  skillsInvoked: ["my-plugin:my-skill"],
  skillToolAvailable: true,
  staleness: [{ class: "skill", message: "skill content changed since record" }],
  skippedAssertions: { full: 1, partial: 0 },
  toolResults: [{ toolUseId: "tu_1", isError: false, text: "ok", assertText: "ok" }],
  tasks: [{ id: "1", subject: "step one", status: "completed", description: "d1", activeForm: "doing step one" }],
  context: { tools: ["Read", "Bash"], mcpServers: [{ name: "my-server", status: "connected" }] },
};

describe("schema/run-result.json", () => {
  it("ajv strict-compiles (draft-07, no unknown keywords)", () => {
    expect(typeof validatePublished).toBe("function");
  });

  it("a fully-populated RunResult (every field the type can emit) validates against the published schema", () => {
    expect(validatePublished(full), ajv.errorsText(validatePublished.errors)).toBe(true);
  });

  it("the SAME fully-populated RunResult validates against the STRICTENED schema (catches an emitted-but-undeclared field)", () => {
    expect(validateStrict(full), ajv.errorsText(validateStrict.errors)).toBe(true);
  });

  it("regression guard: an undeclared top-level field is rejected by the strictened schema", () => {
    const withExtra = { ...full, notARealRunResultField: true };
    expect(validateStrict(withExtra)).toBe(false);
    // the published (permissive) schema does NOT catch this — that's exactly the gap the strict pass closes
    expect(validatePublished(withExtra)).toBe(true);
  });
});
