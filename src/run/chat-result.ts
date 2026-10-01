import { existsSync } from "node:fs";
import { deriveModelProvenance } from "./model-provenance.js";
import { join } from "node:path";
import type { RunResult } from "../types.js";
import { infraErrorsForResult, evidenceErrorsForResult, type RunRecord } from "./run.js";
import { assembleRunResult } from "./assemble-run-result.js";
import { apiRetriesFrom } from "./api-retries.js";
import { classifyWorkspaceFilesWithHealth, deliverableArtifacts, trustedWorkspaceFiles } from "./artifacts.js";
import { readTimeline } from "../agent/timeline.js";
import { toolDurationFields, foldSkillActivity, attributeSubagentSkills } from "./timeline-fold.js";
import { foldResources, resolveIntervalMs } from "../runtime/resource-sampler.js";

const RUN_RESULT_SCHEMA_URL = "https://raw.githubusercontent.com/yaniv-golan/cowork-harness/main/schema/run-result.json";

export interface ChatResultOpts {
  scenario: string;
  prompt: string;
  fidelity: string;
  baseline: string;
  outDir: string;
  workRoot: string;
  userVisibleRoots: string[];
  readonlyFolderRoots: string[];
  egress: RunResult["egress"];
  durationMs: number;
  /** Which `turns/<N>/` chat's OWN artifacts (result.json/trace.json/resources.jsonl) live under, so
   *  `foldResources` below reads the same file `chat.ts`'s sampler wrote into. Chat never resumes (a fresh
   *  sessionId + a freshly mkdir'd outDir every invocation — see chat.ts), so this is always 1 in
   *  practice; threaded explicitly rather than hardcoded so a future multi-turn chat can't silently read
   *  the wrong turn's samples. Distinct from the `turn` FIELD on the assembled RunResult below, which
   *  stays `undefined` by contract — see that field's comment. */
  turn: number;
  /** The model this chat session pinned (`--model` or COWORK_HARNESS_MODEL). `chat` refuses a session that
   *  resolves none, so on the CLI path this is always set; it stays optional for a caller that builds a
   *  chat result directly, where `modelSource: "unresolved"` records the absence rather than papering over it. */
  pinnedModel?: string;
}

/**
 * Assemble the informational RunResult for an interactive chat session. A chat carries NO verdict:
 * `assertions` is empty, `mode` is "chat", and every verdict / capability / gate / staleness field is
 * `undefined`. Most informational fields (tool counts, models, thinking, tasks, timeline folds,
 * workspace files, resources) are populated the same way the run lane does, so `stats`/`trace`/`scaffold`
 * see a chat session. Resources are the one field with a fidelity-conditional exception: `chat.ts` starts
 * a real `ResourceSampler` (mirroring `execute.ts`) for the container and hostloop branches, so THOSE
 * chats fold real `resources.jsonl` samples here — but the protocol branch runs the host `claude` binary
 * directly with no container/process id to probe, so it legitimately has no sampler and `resources` stays
 * `undefined` for a protocol chat (an honest gap, not a bug: `foldResources` below returns `undefined`
 * when `resources.jsonl` was never written).
 * `context` carries the skill IDs the agent had available but NOT the `whenToUse`
 * enrichment the run lane adds by reading each skill's SKILL.md frontmatter (that enrichment needs
 * `configDir`, which isn't plumbed in here) — acceptable for an exploratory chat, where `whenToUse` is
 * unasserted. `nonReproducibleAnswers` and the other non-determinism/verdict signals are also left
 * `undefined`: a chat is deliberately verdict-less, so it declares no reproducibility outcome at all.
 * One deliberate exception: `execution.location` is descriptive provenance, not a verdict, so a chat
 * (a genuinely local interactive session) still gets `execution: { location: "local" }`.
 * Routed through `assembleRunResult` so the CompleteRunResult contract
 * forces every future field to be considered here too — chat cannot silently drift.
 */
export function buildChatResult(record: RunRecord, opts: ChatResultOpts): RunResult {
  const timelineRaw = readTimeline(opts.outDir);
  // Only trust a CLEAN timeline (parsed header, no malformed entry lines) — a corrupt/partial timeline is
  // evidence-unavailable, not present-empty, so derived tool-duration/skill-activity stay undefined. #43
  const timeline = timelineRaw && timelineRaw.malformedLines === 0 && !timelineRaw.headerCorrupt ? timelineRaw : undefined;
  // #52/#54: a missing workspace root OR a nested unreadable subtree is UNAVAILABLE (undefined, the replay
  // convention), not a false empty/partial [] — otherwise a microvm chat (outputs stage into the VM work
  // tree, not outDir) reads as "wrote nothing", or a partial walk reads as a complete list. The shared
  // `trustedWorkspaceFiles` gate is what the run success/partial lanes use too, so the three can't drift.
  const wfHealth = existsSync(opts.workRoot)
    ? classifyWorkspaceFilesWithHealth(opts.workRoot, opts.userVisibleRoots, opts.readonlyFolderRoots)
    : undefined;
  const workspaceFiles = wfHealth ? trustedWorkspaceFiles(wfHealth) : undefined;
  const resources = foldResources(opts.outDir, opts.fidelity, resolveIntervalMs(), undefined, opts.turn);
  return assembleRunResult({
    $schema: RUN_RESULT_SCHEMA_URL,
    generator: "cowork-harness",
    mode: "chat",
    lane: "local", // the chat lane is a local interactive session by construction
    scratchpadEvidenceComplete: false, // chat passes no scratchpad root — the walk never runs
    command: "chat", // #48
    // RunResult.turn documents "absent on replay/chat lanes" (types.ts) — kept undefined even though
    // chat's own artifacts now live under turns/1/ (opts.turn above): that addressing is an internal
    // write-path detail (where THIS session's files sit on disk), not the multi-SESSION resume-count this
    // field describes, and chat's own REPL turns aren't individually numbered/tracked at all.
    turn: undefined,
    ablated: undefined, // chat is exploratory, not an ablation control
    referencesRead: record.filesRead.length ? record.filesRead : undefined,
    referencesAccessed: record.referencesAccessed,
    finalMessage: record.resultText,
    // Deliberate exception to chat's usual "every verdict/capability field is undefined" convention:
    // execution.location is descriptive provenance, not a verdict, and a chat genuinely knows it ran locally.
    execution: { location: "local" },
    scenario: opts.scenario,
    prompt: opts.prompt,
    fidelity: opts.fidelity,
    baseline: opts.baseline,
    result: record.result,
    assertions: [],
    // ── informational (populated) ──
    decisions: record.decisions.map((d) => ({
      kind: d.kind,
      name: d.name,
      decision: d.decision,
      by: d.by,
      requestId: d.requestId,
      model: d.model,
      detail: d.detail,
      rationale: d.rationale,
      questions: d.questions,
    })),
    toolCounts: record.toolCounts,
    webSearches: record.webSearches.length ? record.webSearches : undefined,
    infraErrors: infraErrorsForResult(record),
    evidenceErrors: evidenceErrorsForResult(record),
    ...toolDurationFields(timeline?.events), // toolDurations + toolDurationsBasis, derived together
    skillActivity: timeline ? foldSkillActivity(timeline.events) : undefined,
    models: record.models.length ? record.models : undefined,
    ...deriveModelProvenance(opts.pinnedModel, record.models.length ? record.models : undefined, record.modelFallbacks, record.modelUsage),
    thinking: record.thinking.length ? record.thinking : undefined,
    thinkingElided: record.thinkingElided,
    toolErrors: record.toolErrors,
    modelUsage: record.modelUsage,
    redundantToolCalls: record.redundantToolCalls,
    tasks: Array.from(record.tasks.values()),
    context: record.context as RunResult["context"],
    gateDeliveries: record.gateDeliveries,
    toolResults: record.toolResults,
    subagents: timeline ? attributeSubagentSkills(record.subagents, timeline.events) : record.subagents,
    usage: record.usage,
    cost: record.cost,
    deciderCostUsd: undefined, // the chat lane has no decider — the human answers
    deciderUsage: undefined,
    authoredCapture: undefined, // chat runs no authored-file capture
    apiRetries: apiRetriesFrom(record),
    skillsInvoked: record.skillsInvoked,
    // Cannot tell: a chat records only its seed prompt, never the REPL messages that followed, and any of
    // those could have been a `/<skill>` command. Deriving from the seed alone would claim a negative.
    slashInvokedSkills: undefined,
    skillToolAvailable: record.initTools.includes("Skill"),
    durationMs: opts.durationMs,
    outDir: opts.outDir,
    workDir: opts.workRoot,
    outputsDir: join(opts.workRoot, "outputs"),
    userVisibleRoots: opts.userVisibleRoots,
    readonlyFolderRoots: opts.readonlyFolderRoots.length ? opts.readonlyFolderRoots : undefined,
    artifacts: deliverableArtifacts(workspaceFiles, undefined), // chat captures no pre-run manifest: nothing is marked preRun
    workspaceFixture: undefined, // a chat session has no scenario, so no workspace_fixture
    workspaceFiles,
    contextEvents: record.contextEvents,
    mcpErrors: record.mcpErrors,
    hookEvents: record.hookEvents,
    fileToolAttempts: record.fileToolAttempts,
    toolCalls: record.toolCalls,
    pathDenials: record.pathDenials,
    presentedFiles: record.presentedFiles,
    presentFilesCalls: record.presentFilesCalls,
    egress: opts.egress,
    resources,
    stderrLogPath: join(opts.outDir, "agent.stderr.log"),
    errorSource: record.errorSource,
    resultSubtype: record.resultSubtype,
    // ── verdict / capability / gate / staleness: a chat has none ──
    resultErrorKind: undefined,
    stalledOnQuestion: undefined,
    nonReproducibleAnswers: undefined,
    nonDeterministic: undefined,
    nonDeterministicTerminal: undefined,
    gateProvenance: undefined,
    permissiveAutoAllow: undefined,
    scan: undefined,
    fsDiff: undefined, // the outputs filesystem diff is live-only, like scan
    effectiveFidelity: opts.fidelity,
    fidelityWarnings: undefined,
    l0HostConfigContamination: undefined,
    missingCapabilityUse: undefined,
    capabilityProbe: undefined,
    requiresCapabilityUnmet: undefined,
    runLabel: undefined, // chat is interactive exploration, not the iterate/harvest loop — no --label, no skillHash
    skillCommit: undefined,
    fingerprint: undefined,
    preRunPaths: undefined,
    preRunLinkAware: undefined,
    preRunHashes: undefined,
    preRunOrigin: undefined,
    partial: undefined,
    unansweredGate: undefined,
    staleness: undefined,
    mutation: undefined, // replay --mutate only
    skippedAssertions: undefined,
    outcome: undefined, // rollup of `verdict`; chat has none, so this is absent too
    verdict: undefined, // chat carries NO verdict (no assertions were evaluated) — left absent, never a vacuous {pass:true,...}
  });
}
