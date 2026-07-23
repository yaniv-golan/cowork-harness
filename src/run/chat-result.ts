import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RunResult } from "../types.js";
import { infraErrorsForResult, evidenceErrorsForResult, type RunRecord } from "./run.js";
import { assembleRunResult } from "./assemble-run-result.js";
import { classifyWorkspaceFilesWithHealth, trustedWorkspaceFiles } from "./artifacts.js";
import { readTimeline } from "../agent/timeline.js";
import { foldToolDurations, foldSkillActivity, attributeSubagentSkills } from "./timeline-fold.js";
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
    command: "chat", // #48
    // RunResult.turn documents "absent on replay/chat lanes" (types.ts) — kept undefined even though
    // chat's own artifacts now live under turns/1/ (opts.turn above): that addressing is an internal
    // write-path detail (where THIS session's files sit on disk), not the multi-SESSION resume-count this
    // field describes, and chat's own REPL turns aren't individually numbered/tracked at all.
    turn: undefined,
    ablated: undefined, // chat is exploratory, not an ablation control
    referencesRead: record.filesRead.length ? record.filesRead : undefined,
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
    toolDurations: timeline ? foldToolDurations(timeline.events) : undefined,
    skillActivity: timeline ? foldSkillActivity(timeline.events) : undefined,
    models: record.models.length ? record.models : undefined,
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
    skillsInvoked: record.skillsInvoked,
    skillToolAvailable: record.initTools.includes("Skill"),
    durationMs: opts.durationMs,
    outDir: opts.outDir,
    workDir: opts.workRoot,
    outputsDir: join(opts.workRoot, "outputs"),
    userVisibleRoots: opts.userVisibleRoots,
    readonlyFolderRoots: opts.readonlyFolderRoots.length ? opts.readonlyFolderRoots : undefined,
    artifacts: workspaceFiles?.filter((f) => f.class === "output" || f.class === "mount").map((f) => ({ path: f.path, bytes: f.bytes })),
    workspaceFiles,
    contextEvents: record.contextEvents,
    mcpErrors: record.mcpErrors,
    hookEvents: record.hookEvents,
    fileToolAttempts: record.fileToolAttempts,
    pathDenials: record.pathDenials,
    presentedFiles: record.presentedFiles,
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
    effectiveFidelity: opts.fidelity,
    fidelityWarnings: undefined,
    l0PluginDivergence: undefined,
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
    skippedAssertions: undefined,
    outcome: undefined, // rollup of `verdict`; chat has none, so this is absent too
    verdict: undefined, // chat carries NO verdict (no assertions were evaluated) — left absent, never a vacuous {pass:true,...}
  });
}
