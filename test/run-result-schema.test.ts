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
  turn: 1,
  referencesRead: ["references/task-recipes.md", "scripts/scenario.py"],
  ablated: false,
  mode: "run",
  execution: { location: "local" },
  scenario: "example",
  prompt: "do the thing",
  fidelity: "container",
  baseline: "1.18286.0",
  result: "success",
  resultErrorKind: "transport",
  errorSource: "no_result",
  resultSubtype: "error_max_turns",
  stderrLogPath: "/runs/example/local_abc/agent.stderr.log",
  stalledOnQuestion: false,
  capabilityProbe: "definitive",
  requiresCapabilityUnmet: { caps: ["office_convert"], reason: "omitted" },
  decisions: [
    { kind: "question", name: "AskUserQuestion", decision: "answered", by: "scripted", model: undefined, detail: {}, rationale: undefined },
  ],
  toolCounts: { Bash: 1 },
  infraErrors: [{ source: "egress-sidecar", message: "sidecar exited 1" }],
  evidenceErrors: { taskTracking: 1, webSearchParse: 0, presentFilesMalformed: 0 },
  webSearches: [{ toolUseId: "toolu_1", query: "market size", results: [{ title: "Example Report", url: "https://example.com" }] }],
  toolDurations: { Bash: { calls: 1, totalMs: 240, maxMs: 240 } },
  models: ["claude-sonnet-4-5"],
  thinking: [{ text: "considering the approach" }],
  thinkingElided: 2,
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
      dispatchAgentType: "unknown",
      resolvedAgentType: "general-purpose",
      dispatchTypeOmitted: true,
      declaredTools: ["Read"],
      toolsUsed: [{ name: "Read", count: 1 }],
      referencesRead: ["references/sub-agent-notes.md"],
      description: "explore",
      dispatchModel: "claude-sonnet-4-5",
      resolvedModel: "claude-haiku-x",
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
    promptAssetsHash: "a1b2c3d4e5f60718",
  },
  outDir: "/runs/example/local_abc",
  workDir: "/runs/example/local_abc/work/session/mnt",
  outputsDir: "/runs/example/local_abc/work/session/mnt/outputs",
  userVisibleRoots: ["outputs", "project"],
  readonlyFolderRoots: ["project"],
  artifacts: [{ path: "outputs/report.pdf", bytes: 42 }],
  workspaceFiles: [
    { path: "outputs/report.pdf", bytes: 42, sha256: "e".repeat(64), class: "output" },
    { path: "project/notes.md", bytes: 10, sha256: "f".repeat(64), class: "mount" },
    { path: "reference/doc.md", bytes: 5, sha256: "0".repeat(64), class: "input" },
  ],
  preRunPaths: ["project/existing.txt"],
  preRunHashes: { "outputs/a.md": "a".repeat(64), "outputs/over-cap.bin": null },
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
  context: {
    tools: ["Read", "Bash"],
    mcpServers: [{ name: "my-server", status: "connected" }],
    availableSkills: [{ id: "my-plugin:my-skill", whenToUse: "Use for X" }],
  },
  fileToolAttempts: [
    { tool: "Read", paths: { file_path: "outputs/report.pdf" }, gatePath: "outputs/report.pdf", origin: "main", toolUseId: "tu_1" },
  ],
  pathDenials: [
    {
      source: "can_use_tool",
      tool: "Edit",
      path: "/sessions/x",
      callbackId: undefined,
      decisionReasonType: "workingDir",
      agentId: "agent_1",
      decision: "deny",
      reason: "blocked",
      toolUseId: "tu_1",
    },
  ],
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
