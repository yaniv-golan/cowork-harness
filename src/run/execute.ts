import { warn, writeTextAtomic } from "../io.js";
import { BoundaryError, UsageError, LegacyRunDirError, compactSchemaError } from "../errors.js";
import { ZodError } from "zod";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, rmSync, readdirSync, renameSync, realpathSync } from "node:fs";
import { currentTurnEventLines, TURN_START_MARKER } from "./turn-events.js";
import { hasTurnDirs, currentTurnFromDirs, turnWriteDir, classifyRunDir, preLayoutMessage } from "./turn-layout.js";
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname, resolve, basename, isAbsolute, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { Scenario } from "../types.js";
import type { RunResult, InfraErrorSource, Assertion } from "../types.js";
import { writeRunningStatus, startStatusTicker, registerRunForCrashSafety, statusLine, type RunStatusMeta } from "./run-status.js";
import { deriveModelProvenance, unpinnedModelWarning, resolvePinnedModel } from "./model-provenance.js";
// Runtime-only circular import: cassette.ts imports executeScenario from here, and we import buildFingerprint
// from there. Both bindings are used only inside function bodies (call time), never at module load, so the
// ESM live-binding cycle is safe. buildFingerprint's deps (skillSourceDirs → parseSessionFile) live here, so
// the cycle is intrinsic — kept runtime-only rather than refactored.
import { buildFingerprint, skillCommit } from "./cassette.js";
import { assembleRunResult } from "./assemble-run-result.js";
import { deriveOutcome } from "./outcome.js";
import { loadBaseline } from "../baseline.js";
import {
  loadSession,
  resolveSessionPaths,
  buildLaunchPlan,
  userVisibleRootsFromPlan,
  readonlyFolderRootsFromPlan,
  deleteDeniedRootsFromPlan,
  pluginSkillRootsFromPlan,
  isConnectedContent,
  applySessionOverrides,
} from "../session.js";
import { spawnProtocol } from "../runtime/protocol.js";
import { spawnContainer } from "../runtime/container.js";
import { spawnHostLoop, WORKSPACE_TOOL_ALIASES, VM_LOOP_TOOL_ALIASES } from "../runtime/hostloop.js";
import { snapshotHostLoopWorkspace } from "../runtime/hostloop-stage.js";
import { checkHostLoopWriteConsent, logHostWriteNotice } from "../hostloop/safety.js";
import { warnUnservedHookEvents, checkHostHookConsent, logHostHookNotice } from "./hook-events.js";
import { makeHostLoopCanUseToolGate } from "../hostloop/canusetool-gate.js";
import { spawnMicroVm, snapshotMicroVmWorkspace } from "../runtime/microvm.js";
import {
  probeImageOmitted,
  probeMicrovmOmitted,
  detectCapabilityUse,
  capabilityPreflightDecision,
  CAPABILITY_FAMILIES,
} from "../runtime/image-capabilities.js";
import { instanceName, VM_WORK_HOST } from "../runtime/lima.js";
import { ResourceSampler, makeSampleOnce, foldResources, resolveIntervalMs } from "../runtime/resource-sampler.js";
import { tierVacuousTool, tierVacuousMessage } from "./tier-vacuous-tools.js";
import { decideLoopFromBaseline, readGateFlag, readGateNumber, resolveSkillDiscoveryGates } from "../loop-decision.js";
import { makeWebFetchDedupCache } from "../hostloop/webfetch-dedup.js";
import type { WebFetchProvenance } from "../hostloop/workspace-handler.js";
import { startEgressSidecar, registerCleanup, type EgressSidecar } from "../egress/sidecar.js";
import { startEgressProxy } from "../egress/proxy.js";
import {
  evaluate,
  hostMatches,
  budgetFields,
  runSemanticJudges,
  type AssertContext,
  type SemanticJudge,
  expandExpectDenied,
} from "../assert.js";
import { makeSemanticJudge } from "../decide/semantic-judge.js";
import { compileUserRegex } from "../regex.js";
import { renderPrompts } from "../prompt.js";
import { makeDisplayTranslator, vmPathContextFromPlan } from "./display-translate.js";
import { writeVmPathContextFile } from "./vm-path-ctx-file.js";
import { LiveAgentSession, type SdkMcp, type HookBundle } from "../agent/session.js";
import { readTimeline } from "../agent/timeline.js";
import { foldToolDurations, foldSkillActivity, attributeSubagentSkills } from "./timeline-fold.js";
import { captureSubagentReasoning } from "./subagent-reasoning.js";
import { buildDecider, Chain, ExternalDecider, LlmDecider, type Decider, type OnUnanswered, UnansweredError } from "../decide/decider.js";
import { type DecisionChannel } from "../decide/external-channel.js";
import { claudeCliComplete } from "../decide/llm-transport.js";
import { Run, infraErrorsForResult, evidenceErrorsForResult, type RunRecord, type RunHooks, unionReferenceAccesses } from "./run.js";
import { runsWriteRoot } from "./trace-view.js";
import { summarizeGateProvenance } from "./gate-provenance.js";
import { collectSecrets, scrub } from "../secrets.js";
import { indexRowFromResult, appendIndexRow } from "./run-index.js";
import {
  classifyWorkspaceFilesWithHealth,
  trustedWorkspaceFiles,
  scratchpadEvidenceComplete,
  collectArtifactPaths,
  captureAuthoredFilesWithHealth,
  authoredFilesHealthNonEmpty,
  authoredTotalBytes,
} from "./artifacts.js";
import {
  readPreRunManifest,
  readPreRunManifestHashes,
  readPreRunManifestLinkAware,
  readPreRunManifestOrigin,
  readPreRunManifestStats,
} from "./pre-run-manifest.js";
import { resolveAvailableSkills, type PluginSkillRoot } from "./skill-metadata.js";
import { computeVerdict } from "./verdict.js";
import { resolveAgentImage, resolveContainerRuntime } from "../runtime/agent-image.js";

// Moved to ./artifacts.ts so assert.ts can use it without an assert→execute import cycle;
// re-exported here for the existing importers (cassette.ts, tests).
export { collectArtifacts, collectArtifactPaths } from "./artifacts.js";

const RUN_RESULT_SCHEMA_URL = "https://raw.githubusercontent.com/yaniv-golan/cowork-harness/main/schema/run-result.json";

export interface ExecuteOptions {
  session?: ReturnType<typeof loadSession>;
  /** `--model <id>`: a one-off pin that overrides the session file's `model:`. Applied to whichever
   *  session this run ends up using, so `run`/`record` gain the flag the `skill`/`chat` lanes already had.
   *  A caller that passes an explicit `session` with its own model (a matrix cell axis) has already made
   *  the more specific choice — it resolves the axis before calling, so nothing here can outrank it. */
  modelOverride?: string;
  /** input policy for unscripted questions/dialogs. Default: scenario.on_unanswered ?? "fail". */
  onUnanswered?: OnUnanswered;
  /** The user's EXPLICIT `--on-unanswered`, or undefined when they passed none — distinct from
   *  `onUnanswered` above, which callers may fill with a resolved default. Carried solely so the
   *  scenario-overrides-flag warning can tell "the user asked for this" from "this is the default". */
  onUnansweredFlag?: OnUnanswered;
  /** override the whole decider (replaces scripted + parity + terminal). */
  decider?: Decider;
  /** wire an ExternalDecider TERMINAL over this channel (scripted `--answer` + parity still apply first). */
  externalChannel?: DecisionChannel;
  /** stable session handle: pins the run dir + the agent's native session id (so it can be resumed). */
  sessionId?: string;
  /** resume a prior session of this id — reuse its persisted work dir + pass the agent's `--resume`. */
  resume?: boolean;
  /** --compact: suppress the INFORMATIONAL capability `::notice::` lines for shareable output. The
   *  capability probe still runs and the false-negative hard-fail still fires — only the notices go. */
  compact?: boolean;
  /** steering for the LLM decider (`on_unanswered: llm` / `--decider-llm`) — one-line test intent. */
  llmIntent?: string;
  /** override the LLM decider's answering model (`--decider-model`); falls back to env then the Sonnet default. */
  llmModel?: string;
  /** override the `semantic_matches` judge — mainly so tests inject a stub in place of the live LLM
   *  judge. Default: makeSemanticJudge() (the real judge, via the shared claude -p transport). */
  semanticJudge?: SemanticJudge;
  /** ABLATION (`--ablate-skill`): run the SAME prompt with the skill(s)-under-test removed — a
   *  deterministic negative control for skill-lift measurement (with-skill vs without). All plugin/skill
   *  discovery is stripped so nothing mounts and the agent answers from its own priors; the result is
   *  stamped `ablated:true` so a consumer never reads it as a real run. */
  ablateSkill?: boolean;
  /** `--label` generation tag for the iterate-across-fixes loop (skill/run lanes). Surfaced in RunResult +
   *  the run-index row + `inspect`; undefined when not passed. Ergonomics only — see RunResult.runLabel. */
  runLabel?: string;
  /** mark the run non-deterministic even if no `by:"llm"` decision (e.g. a driving agent answers via `--decider-dir`). */
  nonDeterministicHint?: boolean;
  hooks?: RunHooks[];
  /** Tags the run-index row this execution writes. Default "run" — the `run`/`skill` CLI commands pass
   *  their own command name through; `record`'s live execution (cassette.ts) passes "record" explicitly so
   *  a recording session isn't misread as a `run` invocation in `stats`. */
  command?: "run" | "skill" | "record";
  /** Display-translator wiring for a renderer built BEFORE this scenario's LaunchPlan/effective fidelity
   *  exist (cli.ts's `run`/`skill` renderer is constructed ahead of `executeScenario`, unlike chat.ts's,
   *  which builds its own plan first and can call makeDisplayTranslator directly). Same mutable-ref
   *  pattern as `provenanceRef` below: the caller passes a ref holding the identity function; once `plan`
   *  and `effectiveFidelity` are known (right after buildLaunchPlan, well before the child spawns or any
   *  AgentEvent can arrive), this function overwrites `.current` with the real translator. The renderer
   *  reads `translateRef.current` fresh on every event, so the late assignment is visible without needing
   *  the RenderPlan object itself to be shared. */
  translateRef?: { current: (s: string) => string };
}

/**
 * The library API: run one scenario end-to-end and return a RunResult. `cli.ts` is a
 * thin wrapper over this; the pytest `cowork` lane drives it too. Owns the run boundary
 * (egress sidecar/proxy start+teardown, env mutation, post-run scan, artifact write).
 */
/** turn a scenario name into a SAFE single directory segment — neutralize path separators and
 *  ".." so a YAML/filename-derived name can't escape `runs/`. Otherwise human-readable; the display
 *  name (scenario.name) is kept separate and unchanged.
 *
 *  Length bound: the full sanitized slug is truncated to 128 chars and a collision-avoidance suffix
 *  is appended: "-" + the first 8 hex chars of SHA-256(full-slug). This caps the segment at 137 chars
 *  (128 + 1 + 8) and prevents names that share a 128-char prefix from colliding in the filesystem.
 *  Format: <up-to-128-char-prefix>-<8-hex-chars>
 */
export function slugForPath(name: string): string {
  const full =
    name
      .split(/[/\\]/)
      .join("-")
      .replace(/\.{2,}/g, ".")
      .replace(/^[.\-]+/, "") || "scenario";
  if (full.length <= 128) return full;
  const hash = createHash("sha256").update(full).digest("hex").slice(0, 8);
  return `${full.slice(0, 128)}-${hash}`;
}

/** The SOURCE host paths a session stages (skills/uploads/folders/plugins, plus the session file itself).
 *  realpath-canonicalized + deduped + sorted, so the set identifies WHICH project a pinned session belongs
 *  to, invariant to launch cwd and symlinks. Used by the cross-project overwrite guard below — cwd is the
 *  wrong axis (it false-negatives when two checkouts launch from the same dir, e.g. CI / $HOME). */
export function sessionOriginSources(session: ReturnType<typeof loadSession>, sessionRef: string): string[] {
  const expand = (p: string) => p.replace(/^~(?=$|\/)/, homedir()); // match buildLaunchPlan's ~ handling
  const raw = [
    ...(sessionRef && sessionRef !== "(inline)" ? [sessionRef] : []),
    ...session.uploads,
    ...session.folders.map((f) => f.from),
    ...session.skills.local,
    ...session.plugins.local_plugins,
    ...session.plugins.remote_plugins,
    ...session.plugins.local_marketplaces,
  ].map(expand);
  // Identity is the DECLARED source set — do NOT drop missing paths. Filtering by existence would make the
  // key depend on transient filesystem state (and would diverge from buildLaunchPlan, which only drops
  // missing sources under COWORK_HARNESS_SOFT_MISSING), so a legit same-project refresh could be mis-keyed
  // as "another project" when an optional source flips presence between runs. Canonicalize a present path
  // via realpath (collapses symlinks/cwd); fall back to the lexical absolute for a not-yet-present one.
  const canon = raw.map((p) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  });
  return Array.from(new Set(canon)).sort();
}

/** A short, deterministic identity hash for a pinned run's source set. With no on-disk sources (inline/
 *  empty session) it falls back to a cwd-derived basis — but the guard treats an EMPTY source set as
 *  UNCONFIRMABLE and never deletes on it (cwd is the false-negative axis), so this fallback is only ever a
 *  stable id for the marker, never trusted to authorize an overwrite. */
export function sessionOriginKey(sources: string[], sessionRef: string): string {
  const basis = sources.length ? sources.join("\n") : `ref:${sessionRef === "(inline)" ? resolve(".") : resolve(sessionRef)}`;
  return createHash("sha256").update(basis).digest("hex").slice(0, 16);
}

interface OriginMarker {
  originKey: string;
  sourceHint: string;
  createdAt: string;
}

/** Read a pinned run dir's `.origin` marker, or null if absent/malformed (→ the caller fails CLOSED:
 *  an unconfirmable origin is never deleted). */
function readOriginMarker(path: string): OriginMarker | null {
  try {
    const m = JSON.parse(readFileSync(path, "utf8"));
    if (m && typeof m.originKey === "string") return m as OriginMarker;
  } catch {
    /* missing or malformed */
  }
  return null;
}

/** Resolve the config-dir ROOT the sub-agent reasoning capture (`captureSubagentReasoning`) should glob
 *  under, per tier — mirrors how `CLAUDE_CONFIG_DIR` itself is set per tier (src/runtime/argv.ts +
 *  src/runtime/{hostloop,container,microvm}.ts), but the three real-agent tiers do NOT share one host
 *  tree:
 *    - hostloop spawns the native process directly with `CLAUDE_CONFIG_DIR=plan.configDir` (already a
 *      host path) — root is `configDir` as-is.
 *    - container spawns IN the sandbox with a GUEST `CLAUDE_CONFIG_DIR=mnt/.claude`, which
 *      `stageWorkspace` (src/runtime/stage.ts) cp's `plan.configDir` INTO at `<workRoot>/.claude` —
 *      host-visible there via the docker bind mount, and `workRoot` (`outDir/work/session/mnt`) IS that
 *      host tree — root is `join(workRoot, ".claude")`.
 *    - microvm ALSO spawns with a guest `CLAUDE_CONFIG_DIR=mnt/.claude`, but it stages into a
 *      SEPARATE host tree: `VM_WORK_HOST/<sessionId>/mnt` (src/runtime/lima.ts's `VM_WORK_HOST`,
 *      `join(homedir(), ".cowork-harness", "vm-work")` — see src/runtime/microvm.ts's `sessionHost` /
 *      `mntHost`), NOT `outDir/work/session/mnt` — root is `join(VM_WORK_HOST, sessionId, "mnt",
 *      ".claude")`. Using the container root here would glob an empty (non-existent) dir and silently
 *      leave `reasoning` undefined on every microvm run.
 *  Other tiers (protocol — no real agent binary spawns) return `undefined`: there is no child
 *  transcript to read, so the caller skips the capture entirely. */
export function resolveSubagentConfigRoot(
  effectiveFidelity: string,
  ctx: { configDir: string; workRoot: string; sessionId?: string },
): string | undefined {
  if (effectiveFidelity === "hostloop") return ctx.configDir;
  if (effectiveFidelity === "container") return join(ctx.workRoot, ".claude");
  if (effectiveFidelity === "microvm") {
    // sessionId should always be available from the real call sites (executeScenario's local
    // `sessionId`, threaded into buildPartialResult) — undefined only in a hypothetical caller that
    // omits it, in which case there is no way to derive the per-session VM_WORK_HOST subtree, so
    // capture is skipped rather than globbing the wrong (or a nonexistent) directory.
    if (!ctx.sessionId) return undefined;
    return join(VM_WORK_HOST, ctx.sessionId, "mnt", ".claude");
  }
  return undefined;
}

/** Groups of assertions that cannot all hold. Each group pairs ONE assertion demanding that a record
 *  NOT exist with the assertions demanding that the same record DOES exist, on a single evidence channel.
 *
 *  Verified against the assertion implementations, not the schema prose — a scope split (one side
 *  counting only main-agent records, say) would make a pair satisfiable after all. There is none: both
 *  halves of each group read one list, and where that list is missing BOTH fail evidence-unavailable
 *  rather than passing. On a tier where a key is not served, both halves fail too (the denial keys are
 *  hostloop-only), so a wrong tier never produces a both-pass either. */
const CONTRADICTION_GROUPS: {
  absence: { label: string; test: (a: Assertion) => boolean };
  presences: { label: string; test: (a: Assertion) => boolean }[];
  why: string;
}[] = [
  {
    // `questions_count_max: 0` says no sub-question was ever asked. Any DELIVERED gate records at least
    // one — `handleDecision` pushes one entry per sub-question BEFORE answering, and a gate carrying
    // zero questions throws.
    absence: { label: "`questions_count_max: 0`", test: (a) => a.questions_count_max === 0 },
    presences: [
      { label: "`gate_answer_count_min: >= 1`", test: (a) => a.gate_answer_count_min !== undefined && a.gate_answer_count_min >= 1 },
      { label: "`question_asked`", test: (a) => a.question_asked !== undefined },
      // Same reasoning as question_asked: asserting WHICH options a gate offered requires a gate to have
      // fired, which contradicts requiring zero sub-questions.
      { label: "`question_options`", test: (a) => a.question_options !== undefined },
      // Same again: matching text a gate SHOWED requires a gate to have fired.
      { label: "`question_context`", test: (a) => a.question_context !== undefined },
      // `: false` asserts a CONFIRMED delivery failure, which needs a gate to have fired — a presence
      // requirement in disguise. `: true` is NOT one: it passes vacuously at zero gates, so it is merely
      // inert alongside the declaration (lint says so; not worth refusing a run over).
      { label: "`gate_answers_delivered: false`", test: (a) => a.gate_answers_delivered === false },
    ],
    why: "a delivered gate records at least one question, so requiring a gate to be present contradicts requiring zero questions",
  },
  {
    absence: { label: "`no_hook_blocked: true`", test: (a) => a.no_hook_blocked === true },
    presences: [{ label: "`hook_blocked`", test: (a) => a.hook_blocked !== undefined }],
    why: "both read the same hook-event list — the block `hook_blocked` requires is the one `no_hook_blocked` requires not to exist",
  },
  {
    absence: { label: "`no_path_denied: true`", test: (a) => a.no_path_denied === true },
    presences: [
      { label: "`path_denied`", test: (a) => a.path_denied !== undefined },
      { label: "`vm_path_denied: true`", test: (a) => a.vm_path_denied === true },
    ],
    why: "both read the same path-denial list — the denial the positive key requires is one `no_path_denied` requires not to exist",
  },
];

/** Every statically unsatisfiable assertion pairing in the scenario, or `undefined` when it is runnable.
 *
 *  The two halves of a pair can sit in SEPARATE `assert:` entries, so the check is over the whole array —
 *  an entry-level check could never see them.
 *
 *  Refused rather than merely warned because such a scenario is a guaranteed waste of a paid run, and
 *  `lint` (which reports the same thing as `assert-contradiction`) is opt-in — the consumer report behind
 *  this check had not run it.
 *
 *  WHY HERE AND NOT IN THE SCHEMA. Its sibling contradiction (`no_delete_in_outputs` +
 *  `allow_outputs_delete`) lives in `Scenario.superRefine`, which is the more consistent home. It is not
 *  available: `schema/scenario.schema.json` is a covered surface and SPEC.md §12 makes tightening
 *  validation on a previously-valid document a MAJOR bump. This follows `promptPolicyRejection`
 *  (cassette.ts) instead — a command-level refusal of something the schema still accepts. Move it into
 *  `superRefine` at the next major.
 *
 *  DELIBERATELY EXCLUDES `tool_called` + `tool_not_called` on the same glob. That pair IS unsatisfiable
 *  on one channel, but it is a different feature with its own glob-overlap semantics (two globs can
 *  partially overlap, which none of these boolean pairs can) — it deserves its own design, not a row here.
 *  Also excludes `tool_not_called` as a gate-contradiction witness: it reads the tool log while the gate
 *  keys read the control channel, and a fixture-driven `protocol` run can gate on the control channel
 *  alone, so that cross-channel contradiction is not provable from the YAML.
 *
 *  ONE STATED LIMIT, so the proof does not read as unconditional. It holds for any run dir the harness
 *  produced: both sides derive from one `rec`, and on the lanes where they arrive via separate sidecars
 *  (`verify-run` reads `questions` from trace.json and `gateDeliveries` from result.json) an absent
 *  sidecar fails evidence-unavailable rather than passing. A HAND-EDITED run dir can still defeat the
 *  gate group — `questions: []` in trace.json alongside a delivered gate in result.json would pass both
 *  halves — and verify-run's existing skew guard (cli.ts, `gateQuestionCount < sidecarQuestions.length`)
 *  is one-directional: it catches trace-records-MORE, not trace-records-FEWER. A hand-edited run dir is
 *  not a supported input, so this is a note, not a hole to plug here.
 *
 *  Pure → unit-testable without a spawn. */
export function assertContradiction(scenario: Scenario): string | undefined {
  const asserts = scenario.assert ?? [];
  const clauses: string[] = [];
  for (const g of CONTRADICTION_GROUPS) {
    if (!asserts.some((a) => g.absence.test(a))) continue;
    const hits = g.presences.filter((pres) => asserts.some((a) => pres.test(a))).map((pres) => pres.label);
    // Report EVERY contradictory group, not just the first — a scenario can carry more than one, and
    // fixing them one refusal at a time costs a round trip each.
    if (hits.length) clauses.push(`${g.absence.label} alongside ${hits.join(" and ")} (${g.why})`);
  }
  if (!clauses.length) return undefined;
  // "both" is wrong once a scenario carries more than one contradictory group — and a scenario that
  // carries two is exactly the one whose message gets read carefully.
  const closing = clauses.length === 1 ? "no run can satisfy both" : "no run can satisfy all of them";
  return (
    `scenario "${scenario.name}" asserts ${clauses.join("; and ")} — ${closing}, so this would spend a run to fail. ` +
    `Keep the negative assertion and drop the positive one, or drop the negative if the scenario really does expect the record.`
  );
}

export async function executeScenario(scenario: Scenario, opts: ExecuteOptions = {}): Promise<RunResult> {
  // Refuse a scenario no run can satisfy BEFORE the spawn — the whole point is not to pay for it.
  // Sited here rather than in each command because every lane funnels through executeScenario
  // (`run`/`skill` via cli.ts, `record` via cassette.ts), and a library caller gets it too.
  const contradiction = assertContradiction(scenario);
  if (contradiction) throw new UsageError(contradiction);
  // Validate the authored-evidence budget HERE, not at capture time. `authoredTotalBytes()` throws on a
  // malformed value and is otherwise first called after the agent has finished — so a typo would cost a
  // full live run and then lose its result. Same posture as the contradiction check above: fail before
  // anything is paid for.
  authoredTotalBytes();
  // mirror the CLI guard (cli.ts:488) — a library caller skipping the CLI would otherwise get
  // a confusing `cannot resume "undefined"` error deep inside the resume branch.
  if (opts.resume && !opts.sessionId) throw new Error("resume requires sessionId (--session-id was not provided)");
  // Ablation + resume is incoherent: a resumed session skips re-staging and reuses the prior turn's
  // already-mounted skill files, so the skill would NOT actually be removed — a green ablation run that
  // silently still had the skill. Reject rather than stamp a misleading `ablated:true`.
  if (opts.ablateSkill && opts.resume)
    throw new UsageError(
      "--ablate-skill cannot be combined with --resume (a resumed session reuses the prior turn's staged skill, so ablation would not take effect)",
    );

  const baseline = loadBaseline(scenario.baseline);
  const loadedSession = opts.session ?? loadSessionFromFile(scenario.session);
  // Ablation: strip ALL skill/plugin discovery so no skill-under-test mounts — the agent answers the
  // same prompt from its own priors (a deterministic negative control for skill-lift). An empty
  // local_plugins means no mount is attempted, so the empty-mount hard-fail guard never fires.
  // Precedence, and the reason it is written out rather than collapsed into a `??` chain: an EXPLICIT
  // `--model` (or matrix axis, already applied into `opts.session`) outranks the session file, because the
  // author stated it for this invocation. `COWORK_HARNESS_MODEL` is a machine-scoped DEFAULT and must only
  // fill a gap — letting it outrank a declared `model:` would make the run's model a property of the shell
  // it was launched from, which is the exact defect this field exists to prevent.
  const resolvedModel = resolvePinnedModel(opts.modelOverride, loadedSession.model, process.env.COWORK_HARNESS_MODEL || undefined);
  const withModel =
    resolvedModel !== undefined && resolvedModel !== loadedSession.model
      ? applySessionOverrides(loadedSession, { model: resolvedModel })
      : loadedSession;
  const session = opts.ablateSkill ? ablateSession(withModel) : withModel;

  // Session identity. Without a stable handle: a fresh ephemeral id (current behavior). WITH one
  // (--session-id / resume): a STABLE cwd id + run dir, so the agent's native sessionFile persists and
  // can be resumed. The agent's own session uses a UUID, persisted in a per-session manifest.
  // reject a --session-id outside the safe charset rather than collapsing it — distinct ids like
  // "a/b" and "a-b" used to map onto the SAME persisted directory (a silent collision).
  if (opts.sessionId !== undefined && !/^[A-Za-z0-9_-]+$/.test(opts.sessionId))
    throw new Error(
      `--session-id "${opts.sessionId}" may contain only letters, digits, "_" or "-" (no path separators or other characters)`,
    );
  const stable = opts.sessionId ? `sess-${opts.sessionId}` : undefined;
  const sessionId = stable ?? `local_${process.hrtime.bigint().toString(36)}`;
  // the scenario name (YAML or filename-derived) is a PATH component — slugify so a name like
  // "../x" can't place run artifacts outside runs/. The display name (scenario.name) is unchanged.
  const outDir = join(runsWriteRoot(), slugForPath(scenario.name), sessionId);
  // The marker lives at outDir/.origin — ABOVE workRoot (outDir/work/...), so it's invisible to
  // collectArtifacts / file_exists / user_visible_artifact / the trace events.jsonl scan, and untouched
  // by cpSync staging. It MUST stay here; moving it into the staged tree would surface it as an artifact.
  const originPath = join(outDir, ".origin");

  if (opts.sessionId) {
    // Pinned (`sess-<id>`) run dirs are DETERMINISTIC, so on the shared (flat) runs root two different
    // projects can resolve to the same path. Identify the run by its SOURCE content (sessionOriginSources)
    // and refuse to touch a dir that belongs to a different project — replacing the old blind rmSync,
    // which silently destroyed a colliding peer's persisted, resumable session.
    const sources = sessionOriginSources(session, scenario.session);
    const myOrigin = sessionOriginKey(sources, scenario.session);
    // A session that mounts NO source (a bare inline scenario) has no content to identify which project it
    // belongs to — its only fallback anchor is cwd, which false-negatives when two projects share a cwd.
    // Treat that identity as UNCONFIRMABLE: never auto-delete or silently resume it (fail closed). `skill`
    // runs always mount the skill dir, so the common pinned-session workflow stays confirmable.
    const confirmable = sources.length > 0;
    if (existsSync(outDir)) {
      const prior = readOriginMarker(originPath);
      // Same origin requires a CONFIRMABLE identity AND a matching marker; a missing/partial marker or an
      // unconfirmable (sourceless) identity is never "same" → fail CLOSED (throw, never rm).
      const sameOrigin = confirmable && prior?.originKey === myOrigin;
      const where = prior?.sourceHint ?? "(unknown — partial or foreign run dir)";
      if (opts.resume) {
        // --resume reuses the tree IN PLACE; doing so onto another project's (or an unconfirmable) session
        // bleeds across projects. Block unless explicitly allowed.
        if (!sameOrigin && process.env.COWORK_HARNESS_ALLOW_FOREIGN_RESUME !== "1")
          throw new Error(
            `cannot resume "${opts.sessionId}": session dir ${outDir} ` +
              (confirmable
                ? `belongs to another project at ${where}`
                : `can't be confirmed as this project's (the session mounts no source to identify it)`) +
              ` — set COWORK_HARNESS_ALLOW_FOREIGN_RESUME=1 to override, or use --run-dir`,
          );
        // Refuse to resume onto a pre-layout/mixed shape. `turnArtifactPath` addresses ONLY `turns/<N>/`
        // (no legacy fallback), so resuming one of these writes `turns/<currentTurn>/` next to a root/
        // name-mangled turn 1 that becomes permanently unaddressable the moment this returns — reintroducing
        // the exact "turn 1 invisible on a mixed dir" defect this layout removal exists to eliminate, on a
        // dir mutated AFTER the fix. Gated here (dir-open time), not inside `beginTurn`, so it fires before
        // any turn-start bookkeeping touches the dir. classifyRunDir is a DETECTOR, never a resolver — see
        // turn-layout.ts's module doc comment.
        const resumeShape = classifyRunDir(outDir);
        if (resumeShape.kind === "legacy" || resumeShape.kind === "mixed")
          throw new LegacyRunDirError(`--resume: ${preLayoutMessage(resumeShape, outDir)}`);
      } else if (sameOrigin) {
        // a same-project non-resume run must be FRESH — the prior staged tree (uploads, plugins,
        // mnt/.claude agent state, outputs) would otherwise leak in via cpSync's merge semantics, and a
        // new agentSessionId would be written over stale native session files. Clear it first.
        rmSync(outDir, { recursive: true, force: true });
      } else {
        // FAIL CLOSED: never delete a dir whose origin can't be confirmed as ours (different project,
        // missing marker, or an unconfirmable sourceless identity).
        throw new Error(
          !confirmable
            ? `session id "${opts.sessionId}" has an existing run dir at ${outDir}, but this session mounts no source ` +
                `to identify it as yours — pass --run-dir, use a different --session-id, or delete ${outDir} to reset`
            : `session id "${opts.sessionId}" is already in use by another project at ${where} — ` +
                `pass --run-dir, or a different --session-id` +
                (prior ? "" : ` (or delete ${outDir} to reset)`),
        );
      }
    }
    mkdirSync(outDir, { recursive: true });
    // Write the origin marker FIRST (before session.json) to minimize the post-mkdir crash window where a
    // dir exists with no marker (which would fail closed on the next run).
    const sourceHint = sources[0] ?? (scenario.session === "(inline)" ? "(inline session)" : resolve(scenario.session));
    writeFileSync(originPath, JSON.stringify({ originKey: myOrigin, sourceHint, createdAt: new Date().toISOString() }, null, 2));
  } else {
    mkdirSync(outDir, { recursive: true });
  }

  // status.json: writable/discoverable from the EARLIEST possible moment (right after outDir exists,
  // before any container/VM spawn), so `cowork-harness status <dir>` works even in the pre-events.jsonl
  // window `resolveStatusDir` special-cases. Printed to stderr (unconditional — matches the existing
  // `[loop] cowork → …` precedent a few lines below) so a driving agent capturing this run's stderr can
  // grab the exact dir without knowing the session id ahead of time.
  const runStatusMeta: RunStatusMeta = {
    pid: process.pid,
    scenario: scenario.name,
    fidelity: scenario.fidelity,
    sessionId,
    startedAt: Date.now(),
    runLabel: opts.runLabel, // --label generation tag, surfaced in status.json for `status` watchers
  };
  writeRunningStatus(outDir, runStatusMeta);
  // Raw absolute path by machine-capture contract, but suppressed under --compact/--demo so the
  // shareable "no host paths" mode doesn't leak one. status.json is still written either way — see
  // statusLine's contract note. (`--keep`/footer paths elsewhere are human-facing and DO tildeify.)
  const sLine = statusLine(outDir, !!opts.compact);
  if (sLine) process.stderr.write(sLine);

  // Crash-safety net: WITHOUT this, a throw that unwinds past executeScenario without ever reaching
  // either RunResult assembler (buildPartialResult's call site, or the success-path result below) —
  // e.g. a plain `throw new Error(...)`/BoundaryError earlier in this function, not the recoverable
  // UnansweredError path — leaves status.json frozen at "running" forever: a false "still alive" signal,
  // exactly the failure mode this feature exists to eliminate. `runCrashSafety.finalize(...)` (called at
  // both normal finalize sites in Step 4) removes this run from tracking so a clean finish is never
  // double-written; a run that's still tracked when the process actually exits gets swept to "error" by
  // the ONE shared exit listener `registerRunForCrashSafety` owns (module-level, not per-call — this is
  // what keeps `record --concurrency` batches safe: a per-call `process.on`/`process.off` pair would leak
  // a listener for every crashed-but-not-finalized scenario in the batch, since the crash path by
  // definition never reaches a `.finalize()` call to remove it). Mirrors `writeDoneMarker`'s exit-handler
  // precedent (`src/decide/external-channel.ts:58-64`); `writeJsonAtomic`'s fs calls are synchronous,
  // which a Node `"exit"` handler requires.
  const runCrashSafety = registerRunForCrashSafety(outDir, runStatusMeta);

  // Resolve the effective tier early — it is needed BOTH to stamp the session manifest below (so a
  // --resume at a different tier fails loud; the agent's native conversation store is tier-local) AND,
  // later, before buildLaunchPlan so mount naming is tier-accurate (host-loop folders use hL, VM/container
  // use fy). `cowork` resolves to hostloop|container via the loop-decision gate. Depends only on
  // scenario.fidelity + baseline (both resolved above); nothing between here and its former site read it.
  const effectiveFidelity =
    scenario.fidelity === "cowork" ? (decideLoopFromBaseline(baseline) === "host" ? "hostloop" : "container") : scenario.fidelity;
  if (scenario.fidelity === "cowork") process.stderr.write(`[loop] cowork → ${effectiveFidelity} (per gate 1143815894)\n`);

  // Refuse a `tool_not_called` naming a tool this tier provably does not serve. Placed HERE, not in the
  // schema or validateScenarioRegexes, because both run before the baseline and the tier exist — and a
  // `fidelity: cowork` scenario has no tier at all until the line above resolves it, which is the tier
  // most authors actually write. Still ahead of every spawn, staging and image pull, so no model spend is
  // wasted on an assertion that could never have been violated. (A same-origin `--session-id` re-run has
  // already cleared the prior outDir by this point — pre-spend for tokens, not for that.)
  //
  // UsageError, not a plain throw: parseScenarioFile wraps only ZodError, so a bare Error here would be
  // categorized `internal` — an authoring mistake reported as a harness bug.
  const viaApiForVacuity = readGateFlag(baseline, "1978029737", "coworkWebFetchViaApi", false);
  for (const a of scenario.assert) {
    // BOTH negative tool keys. `subagent_tool_absent` reads the tools sub-agents actually USED
    // (assert.ts's `ctx.subagentTools`), not a per-dispatch declared list, so the same tier table applies
    // — covering one and not the other would refuse `tool_not_called: "Bash"` at hostloop while silently
    // greening the sub-agent form of the identical claim.
    for (const key of ["tool_not_called", "subagent_tool_absent"] as const) {
      const pattern = a[key];
      if (typeof pattern !== "string") continue;
      const finding = tierVacuousTool(pattern, effectiveFidelity, viaApiForVacuity);
      if (finding) throw new UsageError(tierVacuousMessage(finding, key, scenario.name));
    }
  }

  let agentSessionId: string | undefined;
  if (opts.sessionId || opts.resume) {
    const manifestPath = join(outDir, "session.json");
    if (opts.resume) {
      if (!existsSync(manifestPath))
        throw new Error(`cannot resume "${opts.sessionId}": no prior session at ${outDir} (run it once with --session-id first)`);
      // validate the manifest rather than silently degrading to a fresh session on a corrupt
      // or older-format file — a missing agentSessionId on the resume path is a hard error.
      agentSessionId = readSessionManifest(manifestPath, opts.sessionId ?? "", effectiveFidelity);
    } else {
      agentSessionId = randomUUID(); // fresh pinned session
      // `scenario`/`prompt` are IDENTITY, not resume machinery — `readSessionManifest` never reads them and
      // must not: they are additive-optional, so an older manifest without them still resumes. They are
      // here because this file's NAME makes it the first thing anyone opens in a run dir, and a manifest
      // holding only opaque ids answered nothing — a consumer running three concurrent critiques could not
      // tell which was which without opening each turn's result.json. `result.json` remains authoritative
      // (it is written at completion, with the resolved values); this is a signpost, not a second source.
      writeFileSync(
        manifestPath,
        JSON.stringify(
          {
            sessionId: opts.sessionId,
            agentSessionId,
            fidelity: effectiveFidelity,
            createdAt: new Date().toISOString(),
            scenario: scenario.name,
            prompt: scenario.prompt,
          },
          null,
          2,
        ),
      );
    }
  }

  // Safety design layer 1 (the load-bearing layer): hostloop with a writable connected folder gives the
  // native agent process genuine, software-checked-only host filesystem access — no container sandbox.
  // Refuse LOUD, before any spawn, unless the scenario opts in via `allow_host_writes: true`.
  if (effectiveFidelity === "hostloop") checkHostLoopWriteConsent(session, scenario.allow_host_writes ?? false);

  // Turn-start bookkeeping for the APPEND-THROUGH-THE-TURN streams, BEFORE anything can write to them:
  // before the resource sampler opens resources.jsonl and before the agent session starts. Deliberately
  // deliberately at turn START: the post-run path has already let `foldResources` read.
  const turnNumber = beginTurn(outDir);

  const plan = buildLaunchPlan(session, baseline, outDir, effectiveFidelity, !!opts.resume, scenario.lane);
  // Ship 1: warn (not fail) on an unpinned model. Placed HERE, at the caller, rather than inside
  // buildLaunchPlan — that function receives no command identity, so it cannot tell a verdict-bearing
  // run from an exploratory chat and would have to warn identically for both.
  if (plan.model === undefined) warn(unpinnedModelWarning("verdict") + "\n");

  // Same layer, protocol's own hazard: this tier passes --plugin-dir, so a staged plugin's hooks execute
  // as native host processes. Gate only when a plugin actually declares runnable hooks.
  if (effectiveFidelity === "protocol") {
    const roots = plan.mounts
      .filter((m) => m.kind === "local-plugin" || m.kind === "remote-plugin" || m.kind === "marketplace-plugin")
      .map((m) => m.hostPath);
    checkHostHookConsent(roots, scenario.allow_host_hooks ?? false);
    logHostHookNotice(roots, warn);
  }
  if (agentSessionId) {
    plan.agentSessionId = agentSessionId;
    plan.resume = !!opts.resume;
  }
  // A mounted plugin can declare hook events this harness does not serve (it installs PreToolUse only,
  // while real Cowork installs three). Before this warning, such a declaration mounted and ran with no
  // comment at all, and the gap was discoverable only by reading the harness's compiled output. Scans the
  // HOST sources (pre-stage) so it reports a real path the author can open. Tier-independent by design —
  // the served set is a property of the harness, not of the fidelity tier. Suppressed under --compact
  // alongside the other informational notices.
  if (!opts.compact)
    warnUnservedHookEvents(
      plan.mounts
        .filter((mt) => mt.kind === "local-plugin" || mt.kind === "remote-plugin" || mt.kind === "marketplace-plugin")
        .map((mt) => mt.hostPath),
      warn,
    );
  // Pre-run baseline capture: only when something will consume it — the scenario asserts
  // no_unexpected_files, input_unmodified, or no_delete_in_outputs (the filesystem pre/post outputs
  // diff below needs this SAME baseline to catch a delete that never shows up as a Bash/mcp__workspace__bash
  // command in events.jsonl — a script file, a renamed binary, a non-bash tool), or this is a recording
  // (cassettes always carry the baseline so a later assert-add stays replayable without re-record).
  // Skipping keeps the pre-spawn walk (potentially a large live connected folder on hostloop) off runs
  // that never look at it; absence stays loud.
  plan.capturePreRun =
    scenario.assert.some(
      (a) =>
        a.no_unexpected_files !== undefined ||
        a.input_unmodified !== undefined ||
        a.no_delete_in_outputs !== undefined ||
        // Without this the fs-diff backstop never arms for the mount-wide key and it would silently
        // degrade to regex-only — weaker than its outputs-scoped sibling, with nothing saying so.
        a.no_delete_in_mounts !== undefined ||
        // no_lost_write_back derives the authored-file set by diffing against the pre-run manifest, and
        // uses preRunHashes to tell an ADDED artifact from a merely-modified pre-existing one. Without the
        // baseline it can only report evidence-unavailable every run.
        a.no_lost_write_back !== undefined,
    ) || opts.command === "record";

  // Fill in the caller's display-translate ref (see ExecuteOptions.translateRef) now that plan +
  // effectiveFidelity exist — well before the child spawns, so the renderer never sees a stale identity
  // translator once events start flowing. The translator itself gates on effectiveFidelity/shareable, so
  // this always resolves ctx unconditionally (harmless at non-hostloop tiers — the closure no-ops there).
  //
  // mounts.json (see vm-path-ctx-file.ts's header): persist this SAME ctx to <outDir>/mounts.json,
  // unconditionally and for EVERY tier/lane (not gated on opts.translateRef — `record` calls executeScenario
  // directly with no translateRef, and still needs a ctx file for a later `trace --translate-paths`/replay
  // reader). Reusing this one `vmPathContextFromPlan(...)` call (rather than a second, independent one)
  // guarantees the write-site and the live-translator derivations can never drift apart.
  const vmPathCtx = vmPathContextFromPlan(sessionId, plan, outDir);
  writeVmPathContextFile(outDir, vmPathCtx, effectiveFidelity);
  if (opts.translateRef) {
    opts.translateRef.current = makeDisplayTranslator({
      ctx: vmPathCtx,
      effectiveFidelity,
      shareable: !!opts.compact,
    });
  }

  const startedAt = Date.now();
  const boundaryDeps = scenario.assert.some((a) => a.egress_denied || a.egress_allowed) || scenario.expect_denied.length > 0;
  if (scenario.fidelity === "protocol" && boundaryDeps) {
    throw new BoundaryError(
      `scenario "${scenario.name}" asserts boundary behavior (egress/expect_denied) but fidelity is "protocol" (no sandbox). ` +
        `Use a sandboxed fidelity (container, microvm, or hostloop) so the limitation is actually enforced — otherwise the result is a false pass.`,
    );
  }

  const overrideWarning = onUnansweredOverrideWarning(scenario.on_unanswered, opts.onUnansweredFlag);
  if (overrideWarning) warn(overrideWarning);
  const onUnanswered: OnUnanswered = scenario.on_unanswered ?? opts.onUnanswered ?? "fail";
  // This is a POLICY line (what happens IF an unscripted question arrives), not an outcome — the old
  // `unanswered questions → fail` wording read as a failure on clean runs. State it as policy + source.
  process.stderr.write(
    opts.externalChannel
      ? `[input] unscripted-question policy: live decider channel\n`
      : `[input] unscripted-question policy: ${onUnanswered} (${scenario.on_unanswered ? "scenario" : opts.onUnanswered ? "flag" : "default"})\n`,
  );

  // Secrets are needed BEFORE the decider is built — the external channel emits live, ahead of the
  // post-run file scrub. Same set is reused for the file scrub at the end.
  const secrets = collectSecrets();
  // Dialog auto-cancel: faithful 6s by default; relaxed (∞) under the external decider since the
  // caller is authoritative; `COWORK_HARNESS_DIALOG_TIMEOUT_MS` overrides either way.
  // parse the dialog timeout env var. The special values "inf", "infinite", and "-1" mean Infinity
  // (no timeout), so fail/first policies can also opt out of the 6s auto-cancel. A positive number
  // overrides the policy-based default. 0 or absent → fall through to the policy default below.
  const envDialogMsRaw = process.env.COWORK_HARNESS_DIALOG_TIMEOUT_MS ?? "";
  const envDialogMs = parseDialogTimeout(envDialogMsRaw);
  // Relax the 6s dialog auto-cancel under any deliberate, authoritative terminal: an external channel, the
  // LLM decider (a `claude -p` call would lose the 6s race), or `prompt` (a human can't answer in 6s — the
  // faithful auto-cancel would make PromptDecider's dialog branch unreachable). fail/first keep 6s.
  const dialogTimeoutMs =
    envDialogMs !== undefined
      ? envDialogMs
      : opts.externalChannel || onUnanswered === "llm" || onUnanswered === "prompt"
        ? Infinity
        : undefined;
  // A finite env-override combined with an authoritative async answerer (external channel, LLM, prompt)
  // makes withDialogTimeout() race a never-settling decider promise — on timeout the channel desyncs
  // because the late reply consumes the NEXT gate's readLine slot. There is no valid use case for this
  // combination; reject it early so the desync is impossible, not just serial-gate-guarded.
  if (envDialogMs !== undefined && isFinite(envDialogMs) && (opts.externalChannel || onUnanswered === "llm" || onUnanswered === "prompt")) {
    throw new Error(
      `COWORK_HARNESS_DIALOG_TIMEOUT_MS: cannot use a finite timeout with --decider-cmd/--decider-dir/--on-unanswered=llm/prompt — those are authoritative answerers (set to 'inf' or remove the env var)`,
    );
  }

  // Docker resources (sidecar networks/proxy + the host-loop container) are EPHEMERAL per run — name
  // them by a unique per-invocation token, NOT the (now-stable) sessionId, so a `--resume` after a
  // failed run can't collide with the prior run's leftovers. The persistent state is the work dir.
  const runToken = `r${process.hrtime.bigint().toString(36)}`;
  const runner = resolveContainerRuntime();

  const containerLike = effectiveFidelity === "container" || effectiveFidelity === "hostloop";
  let egress: RunResult["egress"] = [];
  let egressMalformedLines = 0; // dropped proxy-log lines, surfaced into record.evidenceErrors.egressParse once `record` is assigned (#39)
  let sidecar: EgressSidecar | undefined;
  let hostProxy: ReturnType<typeof startEgressProxy> | undefined;
  let resourceSampler: ResourceSampler | undefined;
  let microvmProxyPort: number | undefined;
  let record: RunRecord;
  let unansweredErr: UnansweredError | undefined; // set when a gate whiffs — drives the salvage branch below
  let child: { kill?: (s?: NodeJS.Signals) => void } | undefined; // hoisted so the finally can reap a crashed/orphaned container
  let containerName: string | undefined;
  let deregisterContainerReap: (() => void) | undefined; // Ctrl-C cleanup for the agent container
  let hostEgress: { host: string; decision: "allow" | "deny" }[] | undefined; // host-routed web_fetch egress
  // Container's web_fetch is host-routed too, so its decisions cannot come from the proxy log and must
  // survive the `egress = eg.entries` teardown assignment. Kept separate for exactly that reason.
  const containerWebFetchEgress: { host: string; decision: "allow" | "deny" }[] = [];
  let hostloopHooks: HookBundle | undefined; // hostloop's PreToolUse path-gate bundle
  let hostloopPathGateFired: Set<string> | undefined; // tool_use_ids the path gate actually saw
  let hostloopInfraErrors: { source: InfraErrorSource; message: string }[] | undefined; // spawnHostLoop's live infra sink (sidecar crash + failed execs, tagged by origin) — folded into record.infraErrors below
  let hostloopMarkTearingDown: (() => void) | undefined; // call BEFORE this run's own `docker rm -f` so that forced exit isn't misreported as a crash
  let l0HostConfigContamination = false; // set when protocol mode runs with plugins (failing fidelity signal)
  let promptFidelityWarnings: string[] | undefined; // structured prompt warnings collected by renderPrompts
  // web_fetch provenance is gate-driven (coworkWebFetchViaApi) and host-loop only. The ref is
  // created HERE (before spawnHostLoop builds the handler) and filled with a Run-backed bundle after
  // the Run exists — the handler reads ref.current at call time (strictly after the stream starts).
  const viaApiOn = readGateFlag(baseline, "1978029737", "coworkWebFetchViaApi", false);
  const promptGateOn = readGateFlag(baseline, "1978029737", "coworkWebFetchPrompt", false);
  const provenanceRef: { current?: WebFetchProvenance } = {};
  // coworkWebFetchDedup (host-API path only): a per-session negative-work cache. Built only when the gate is
  // on (an older baseline that lacks it ⇒ undefined ⇒ no behavior change); 100/900000 come from the baseline.
  const dedup =
    viaApiOn && readGateFlag(baseline, "1978029737", "coworkWebFetchDedup", false)
      ? makeWebFetchDedupCache({
          ttlMs: readGateNumber(baseline, "1978029737", "coworkWebFetchDedupTtlMs") ?? 900000,
          maxEntries: readGateNumber(baseline, "1978029737", "coworkWebFetchDedupMaxEntries") ?? 100,
        })
      : undefined;
  // Skills/plugins discovery gates (A2 — see docs/fidelity-gaps.md "Skill/plugin discovery SDK-MCP
  // servers"). Precedence: explicit session knob ▸ readGateBool (bare-boolean gate, NOT readGateFlag —
  // these two gates carry their truth in the top-level `.on`, not a named sub-flag) ▸ documented default.
  // Resolved HERE (session is in scope) and threaded into spawnContainer/spawnHostLoop via `opts` below —
  // neither spawn function receives `session` itself.
  const { suggestSkillsEnabled, proactiveSkillSuggestEnabled } = resolveSkillDiscoveryGates(baseline, session.skills);

  // Pre-flight: if the skill DECLARES required capabilities and the image provably omits one, FAIL FAST here
  // — before any paid agent run — instead of burning ~12 min to reach a verdict the post-run guard already
  // knows. The author can opt out with `allow_missing_capability: true` (the fallback is equivalent), which
  // downgrades to a notice. The image probe is digest-cached, so it's shared with the post-run check (no
  // second container spawn), and it spawns a throwaway `--network none` container with no model — zero tokens.
  const declaredCaps = scenario.requires_capabilities ?? [];
  if (
    declaredCaps.length &&
    (effectiveFidelity === "container" || effectiveFidelity === "hostloop" || effectiveFidelity === "microvm") &&
    process.env.COWORK_SKIP_CAPABILITY_PROBE !== "1"
  ) {
    // microvm: `probeMicrovmOmitted` returns null (not an omitted-set) whenever the guest isn't
    // already `Running` (cold run — nothing to `limactl shell` into yet). `capabilityPreflightDecision`
    // treats a null probe as "indefinite" and always no-ops (`abort: false, message: null`) — so a
    // declared-capability skill on a not-yet-running microvm silently SKIPS this pre-flight rather than
    // false-failing; the post-run probe (after the guest is up) is what actually gates that tier.
    // Pinned in test/capability-microvm.test.ts.
    const omitted =
      effectiveFidelity === "microvm"
        ? probeMicrovmOmitted(instanceName(baseline))
        : probeImageOmitted({
            runtime: resolveContainerRuntime(),
            image: resolveAgentImage(),
            tier: effectiveFidelity,
          });
    const allowMissing = scenario.assert.some((a) => a.allow_missing_capability === true);
    const { abort, message } = capabilityPreflightDecision(declaredCaps, omitted, allowMissing);
    if (abort) throw new BoundaryError(`[capability] ${message}`); // never gated — the safety net
    if (message && !opts.compact)
      warn(`::notice:: [capability] (pre-flight) ${message} (allow_missing_capability asserted — proceeding)\n`);
  }
  // EVERY exit path from here down must leave the raw streamed logs scrubbed on disk — success, the
  // unanswered-gate salvage rethrow, and any fault rethrown mid-run (agent crash, infra error, hostloop
  // snapshot failure). The `finally` at the very bottom of this function owns that; nothing else in
  // between may scrub events.jsonl earlier, because the post-run readers (scanEvents,
  // findUngatedPathToolCalls, detectCapabilityUse) must see the RAW stream — a user-registered scrub
  // value (COWORK_HARNESS_SCRUB_VALUES) that overlaps a host path or a script path would otherwise
  // false-green leak/capability detection.
  try {
    try {
      // acquire the egress sidecar / host proxy INSIDE the protected try so a throw in resource
      // acquisition OR in renderPrompts below can't leak a Docker network / a bound proxy port — the `finally`
      // tears down whatever was assigned to sidecar/hostProxy. (Previously these were acquired before the try,
      // so a renderPrompts throw skipped teardown and orphaned the resource.)
      if (containerLike) {
        // thread proxy/network EXPLICITLY into spawn opts — no process.env mutation so
        // concurrent executeScenario calls don't stomp each other's values.
        sidecar = startEgressSidecar(plan.egressAllow, outDir, runToken);
        // on Ctrl-C, reap the agent container in the "container" PHASE so it runs BEFORE the sidecar's
        // network teardown (network rm fails while the container is still attached). The thunk reads `child`/
        // `containerName` at call time (assigned below). De-registered in the finally so a clean exit doesn't
        // double-run it (and the reap is idempotent regardless).
        deregisterContainerReap = registerCleanup({
          phase: "container",
          run: () => {
            try {
              child?.kill?.("SIGKILL");
            } catch {
              /* already gone */
            }
            // mark BEFORE the forced removal below — a Ctrl-C reap kills the hostloop sidecar exactly
            // like the normal-path teardown does, and that forced exit must not be misreported as a
            // mid-run infra failure (see watchHostLoopSidecar's doc comment).
            hostloopMarkTearingDown?.();
            if (containerName) spawnSync(runner, ["rm", "-f", containerName], { stdio: "ignore" });
          },
        });
      } else if (effectiveFidelity === "microvm") {
        // Bind the proxy first (port 0 → OS assigns), then read the actual port back from the live socket.
        // The firewall rule and HTTP(S)_PROXY (written in spawnMicroVm below) just need the port before the
        // agent spawns, not before the proxy binds — so proxy-first eliminates the freePort() TOCTOU window.
        hostProxy = startEgressProxy({
          allow: plan.egressAllow,
          // NON-loopback on purpose: the guest reaches this proxy at `gatewayIp:port` over a real
          // interface (see spawnMicroVm's vmGatewayIp), so a loopback-only bind would be unreachable.
          // Everywhere else the default loopback bind applies — see ProxyOptions.host.
          host: "0.0.0.0",
          port: process.env.COWORK_VM_PROXY_PORT ? parseEnvPort("COWORK_VM_PROXY_PORT", 0) : 0,
          logPath: join(outDir, "egress.log"),
          onDecision: (host, decision) => egress.push({ host, decision }),
        });
        await hostProxy.ready; // don't spawn the agent until the proxy is accepting (or fail loud on a bind error)
        microvmProxyPort = hostProxy.actualPort; // read from the live, still-bound socket — no TOCTOU gap
      }

      // Host-loop prompt-token substitution (P2a): renderPrompts runs BEFORE spawnHostLoop below, so these
      // host dirs are recomputed here via the SAME pure joins hostloop's own runtime uses, rather than
      // restructuring the call order. hostCwd/hostUploadsDir mirror hostOutputsDir's derivation
      // (src/runtime/hostloop.ts: `mntHost = join(resolve(outDir), "work", "session", "mnt")`) and the
      // sibling uploads dir stageHostLoopWorkspace creates there (src/runtime/hostloop-stage.ts:39).
      // hostSkillsDir mirrors hostLoopShellSection's own staged-skills check (same file) — plan.configDir's
      // skills copy is already materialized by buildLaunchPlan above, so this is a plain existence check,
      // not a restructuring; undefined (skills absent/unstaged) lets renderPrompts' fallback string stand.
      const hostLoopOpts =
        effectiveFidelity === "hostloop"
          ? (() => {
              const hostMnt = join(resolve(outDir), "work", "session", "mnt");
              const skillsDir = join(plan.configDir, "skills");
              const skillsStaged = existsSync(skillsDir) && readdirSync(skillsDir).length > 0;
              return {
                effectiveFidelity,
                hostCwd: join(hostMnt, "outputs"),
                hostUploadsDir: join(hostMnt, "uploads"),
                hostWorkspaceFolder: plan.mounts.find((m) => m.kind === "folder")?.hostPath,
                hostSkillsDir: skillsStaged ? skillsDir : undefined,
              };
            })()
          : { effectiveFidelity };
      const prompts = renderPrompts(baseline, session, sessionId, plan.mounts.find((m) => m.kind === "folder")?.mountPath, hostLoopOpts);
      promptFidelityWarnings = prompts.fidelityWarnings; // hoist out so RunResult construction (after try) can access it
      let sdkMcp: SdkMcp | undefined;
      // The session root as reported BY THE SPAWN that just happened — the dir whose `mnt/` is the
      // user-visible workspace, in the same path space the agent reports its own paths in. Only the two
      // tiers that serve present_files supply one; the others keep the cwd fallback (see setSessionRoot).
      let spawnedSessionRoot: string | undefined;
      if (effectiveFidelity === "hostloop") {
        const hl = spawnHostLoop(scenario, baseline, plan, outDir, sessionId, {
          systemPromptAppend: prompts.systemPromptAppend,
          runToken,
          egressProxy: sidecar?.proxyUrl,
          dockerNetwork: sidecar?.network,
          provenanceRef,
          webFetchViaApi: viaApiOn,
          dedup,
          suggestSkillsEnabled,
          proactiveSkillSuggestEnabled,
        });
        child = hl.child;
        sdkMcp = hl.sdkMcp;
        containerName = hl.containerName;
        hostEgress = hl.hostEgress;
        hostloopHooks = hl.hooks;
        hostloopPathGateFired = hl.pathGateFired;
        hostloopInfraErrors = hl.infraErrors;
        hostloopMarkTearingDown = hl.markTearingDown;
        spawnedSessionRoot = hl.sessionRoot; // HOST tree — the native agent runs there
        logHostWriteNotice(
          plan.mounts.filter((mt) => mt.kind === "folder").map((mt) => ({ from: mt.hostPath, mode: mt.mode })),
          warn,
        );
        if (scenario.assert.some((a) => a.transcript_no_host_path === true) && !opts.compact)
          warn(
            `::warning:: [hostloop] scenario asserts transcript_no_host_path — hostloop's native file tools legitimately ` +
              `expose real host paths to the model, so this assertion will FAIL by design at this fidelity.\n`,
          );
      } else if (effectiveFidelity === "container") {
        const ct = spawnContainer(scenario, baseline, plan, outDir, sessionId, {
          systemPromptAppend: prompts.systemPromptAppend,
          egressProxy: sidecar?.proxyUrl,
          dockerNetwork: sidecar?.network,
          runToken,
          suggestSkillsEnabled,
          proactiveSkillSuggestEnabled,
          // Same gate production reads for its VM-loop web_fetch registration. Read once above and shared
          // with the hostloop branch so the two tiers cannot drift apart on it.
          webFetchViaApi: viaApiOn,
          provenanceRef,
          dedup,
          onEgress: (e) => containerWebFetchEgress.push(e),
        });
        child = ct.child;
        containerName = ct.containerName; // so the Ctrl-C / finally reap removes the agent container by name
        sdkMcp = ct.sdkMcp; // cowork/present_files + the skills/plugins discovery servers (combineSdkMcp)
        spawnedSessionRoot = ct.sessionRoot; // VM path (`/sessions/<id>`) — what the agent inside reports
      } else if (effectiveFidelity === "microvm") {
        child = spawnMicroVm(scenario, baseline, plan, outDir, sessionId, {
          systemPromptAppend: prompts.systemPromptAppend,
          proxyPort: microvmProxyPort,
        });
      } else {
        // pass systemPromptAppend so L0 records carry Cowork framing (matches container/microvm/host-loop).
        // capture l0HostConfigContamination so computeVerdict can fail the run when plugins are configured.
        const proto = spawnProtocol(scenario, baseline, plan, outDir, { systemPromptAppend: prompts.systemPromptAppend });
        child = proto.child;
        l0HostConfigContamination = proto.l0HostConfigContamination;
        if (scenario.assert.some((a) => a.transcript_no_host_path === true) && !opts.compact)
          warn(
            `::warning:: [protocol] scenario asserts transcript_no_host_path — protocol (L0) runs the agent's file tools ` +
              `on the real host cwd with no sealed filesystem, so this assertion will FAIL by design at this fidelity.\n`,
          );
      }

      if (effectiveFidelity === "container" || effectiveFidelity === "hostloop" || effectiveFidelity === "microvm") {
        // Sample the agent sandbox on an interval. Async probes only (shares the agent's event loop).
        // hostloop samples the native agent process (child.pid); container samples the container by name;
        // microvm reads /proc via limactl. A missing id / unavailable tool yields no samples (resources → undefined).
        const sampleOnce = makeSampleOnce({
          tier: effectiveFidelity,
          runner,
          containerName: effectiveFidelity === "container" ? containerName : undefined,
          pid: effectiveFidelity === "hostloop" ? (child as { pid?: number } | undefined)?.pid : undefined,
          instance: effectiveFidelity === "microvm" ? instanceName(baseline) : undefined,
        });
        resourceSampler = new ResourceSampler(outDir, effectiveFidelity, sampleOnce, resolveIntervalMs(), turnNumber);
        resourceSampler.start();
      }

      const sessionT = new LiveAgentSession(child as any, outDir);
      // Terminal decider: an explicit external channel, else the LLM decider when `agent` is selected.
      const llmTerminal =
        onUnanswered === "llm" ? new LlmDecider(claudeCliComplete, opts.llmIntent, opts.llmModel || undefined, secrets) : undefined;
      const externalTerminal = opts.externalChannel ? new ExternalDecider(opts.externalChannel, secrets) : llmTerminal;
      const policyDecider =
        opts.decider ?? buildDecider({ rules: scenario.answers, parity: plan.permissionParity, onUnanswered, external: externalTerminal });
      // Production interposes the canUseTool path gate BEFORE the user-facing callback (xe ?? Qt ?? Se);
      // the harness analog is FIRST in the Chain — Chain stops at the first non-abstain, so any later
      // placement would let a scripted/default answer preempt a production-shaped deny.
      const decider = effectiveFidelity === "hostloop" ? Chain(makeHostLoopCanUseToolGate(), policyDecider) : policyDecider;
      const run = new Run(sessionT, decider, opts.hooks ?? [], sessionId, dialogTimeoutMs ?? undefined, scenario.timeout_ms);
      run.seedApprovedDomains(session.web_fetch.approved_domains); // test convenience: pre-approved web_fetch hosts
      // The session root — the dir whose `mnt/` IS the user-visible workspace, and what present_files'
      // promoted/leaked classification is measured from. Taken from the SPAWN, never re-derived here: the
      // root and the agent's reported paths must be in the SAME path space, and they are not the same space
      // on every tier. A host path was passed unconditionally once; at container the agent reports VM paths
      // (`/sessions/<id>/…`), so nothing was ever inside the root, every presented file classified
      // `leaked: false`, and `no_scratchpad_leak` — which evaluates at container and nowhere else — passed
      // vacuously over a real copy-failure leak.
      //
      // Unset on the tiers that serve no present_files (`protocol`, `microvm`), where the cwd fallback is
      // already the session root and there is no delivery to classify.
      if (spawnedSessionRoot !== undefined) run.setSessionRoot(spawnedSessionRoot);
      // fill the provenance bundle (backed by Run's tracker + recorded approval) BEFORE drive().
      // Host-loop only, and only when the web_fetch-via-API gate is on; otherwise the handler stays
      // allowlist-only (ref.current undefined). Run seeds the set from turns + tool_results.
      // BOTH loops, not just host-loop: production's VM-loop factory calls the provenance path
      // unconditionally and has no allowlist fallback in it at all. Leaving `ref.current` undefined at
      // container drops the handler onto PATH B — the gate-OFF path — even though the tool exists only
      // BECAUSE the gate is on, which is the inverse of production.
      if ((effectiveFidelity === "hostloop" || effectiveFidelity === "container") && viaApiOn) {
        run.enableWebFetchGate();
        provenanceRef.current = {
          isAllowed: (u) => run.provenanceHas(u),
          markAllowed: (u) => run.provenanceAdd(u),
          requestApproval: undefined, // gated at can_use_tool — the handler must not self-approve (was the 2nd record)
          promptGateOn,
          permissiveMode: plan.permissionMode === "bypassPermissions",
        };
      }
      const stopStatusTicker = startStatusTicker(outDir, runStatusMeta, () => run.partial());
      try {
        try {
          record = await run.drive(scenario.prompt, {
            subagentAppend: prompts.subagentAppend,
            sdkMcp,
            hooks: hostloopHooks,
            // Host-loop aliases Bash+WebFetch; the VM loop aliases WebFetch alone, and only when the
            // gate that put the workspace server there is on. Tied to the SAME `viaApiOn` that drives the
            // disallow in spawnContainer — an alias to a server this run never registered would resolve a
            // bare WebFetch onto nothing.
            ...(effectiveFidelity === "hostloop"
              ? { toolAliases: WORKSPACE_TOOL_ALIASES }
              : effectiveFidelity === "container" && viaApiOn
                ? { toolAliases: VM_LOOP_TOOL_ALIASES }
                : {}),
          });
        } catch (e) {
          // An unanswered gate is recoverable: grab the in-progress record so the work done before the whiff can
          // be salvaged to disk below. Any other error is a genuine fault — keep today's fail-fast behavior.
          if (e instanceof UnansweredError) {
            unansweredErr = e;
            record = run.partial();
          } else throw e;
        }
      } finally {
        stopStatusTicker();
      }
    } finally {
      // Stop sampling FIRST — before the container/process teardown below — so a final in-flight probe
      // can't race (and fail against) a container that's already being removed. `stop()` is async (it awaits
      // the in-flight tick, bounded) so a run shorter than one interval still has its immediate sample land
      // before `foldResources` reads resources.jsonl below. #40
      await resourceSampler?.stop();
      // Reap the agent container FIRST (before the sidecar networks), so a crashed/unanswered run can't
      // orphan a running container holding the network. On the success path the child has already
      // exited (--rm), so these are no-ops.
      deregisterContainerReap?.(); // normal path owns the reap below; drop the signal-time thunk
      try {
        child?.kill?.("SIGKILL");
      } catch {
        /* already gone */
      }
      // mark BEFORE the forced removal below — this run's own `docker rm -f` makes the hostloop sidecar
      // exit too, and that intentional-shutdown exit must not be misreported as a mid-run infra failure
      // (see watchHostLoopSidecar's doc comment — a naive fix that skips this reds every hostloop run).
      hostloopMarkTearingDown?.();
      if (containerName) spawnSync(runner, ["rm", "-f", containerName], { stdio: "ignore" });
      if (sidecar) {
        const eg = sidecar.collect();
        egress = eg.entries;
        egressMalformedLines += eg.malformedLines; // applied to record.evidenceErrors after the finally, where `record` is assigned (#39)
        sidecar.teardown();
      }
      // merge host-routed web_fetch decisions so they're visible to egress assertions. This MUST come
      // after the `egress = eg.entries` above, which replaces the array wholesale with the proxy log —
      // a log that can never contain a host-side fetch. Both loops route web_fetch off-container, so
      // both need the merge; container's decisions were being discarded by that assignment.
      if (hostEgress?.length) egress = [...egress, ...hostEgress];
      if (containerWebFetchEgress.length) egress = [...egress, ...containerWebFetchEgress];
      hostProxy?.close();
    }

    // A post-listen egress-sidecar crash (container topology) surfaces as `fatalError` after teardown —
    // fold it into infraErrors so computeVerdict hard-fails the run (evidence contaminated).
    if (sidecar?.fatalError) record.infraErrors.push({ source: "egress-sidecar", message: sidecar.fatalError });
    // The hostloop VM sidecar's own crash is folded the SAME way, via `hostloopInfraErrors`
    // (spawnHostLoop's live sink — populated by watchHostLoopSidecar as errors happen). This is NOT
    // redundant with `case "infra_error"` in run.ts's event loop: that case exists to re-derive an
    // `infra_error` row on CASSETTE REPLAY (where events.jsonl IS the transcript source), but a LIVE
    // drive only ever sees events parsed from the agent's own stdout — it never re-reads the
    // out-of-band row spawnHostLoop appends to events.jsonl. Without this fold, a live sidecar crash
    // would reach the raw log but never `result.json`'s infraErrors, leaving the verdict green.
    if (hostloopInfraErrors?.length) record.infraErrors.push(...hostloopInfraErrors);

    // snapshot the gate rendezvous wire shapes (req/resp/.done) into the run dir BEFORE the caller
    // closes (and wipes) the channel — the forensic evidence you want after a gate bug survives --keep.
    opts.externalChannel?.snapshot?.(join(outDir, "gates"));

    // hostloop never copies connected folders into the run dir while the agent runs (they're bind-mounted
    // real host paths) — snapshot them NOW so every post-run consumer below (evaluate ctx, collectArtifacts,
    // verify-run, cassette record, detectCapabilityUse) keeps reading the same frozen tree the copy-based
    // tiers have always produced. Must run before `workRoot`-relative code below.
    if (effectiveFidelity === "hostloop") {
      try {
        snapshotHostLoopWorkspace(plan, join(outDir, "work", "session", "mnt"));
      } catch (err) {
        // On the unanswered-gate salvage path, a snapshot failure here must not replace the original
        // UnansweredError and skip partial persistence entirely — that would be worse than the folder
        // artifacts simply being incomplete. Best-effort + loud there; still hard-fail on the success path,
        // where nothing more important is being masked by throwing.
        if (unansweredErr) {
          warn(
            `::warning:: [hostloop] snapshot failed during salvage — folder artifacts may be missing from this partial result: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        } else {
          throw err;
        }
      }
    }

    // #52: microvm outputs live on the host at VM_WORK_HOST/<id> (the /sessions mount), NOT in the run
    // dir the post-run pipeline walks. Snapshot the SESSION ROOT into outDir/work/session NOW — before any
    // workRoot-relative code below — so collectArtifacts / captureAuthoredFiles / the fs-diff / cassette
    // record see the deliverables. UNCONDITIONAL (independent of capturePreRun): this fixes the
    // workspaceFiles/artifacts observability even when no manifest-triggering key is asserted. Same
    // salvage semantics as hostloop above.
    if (effectiveFidelity === "microvm") {
      try {
        snapshotMicroVmWorkspace(sessionId, join(outDir, "work", "session"));
      } catch (err) {
        if (unansweredErr) {
          warn(
            `::warning:: [microvm] workspace snapshot failed during salvage — artifacts may be missing from this partial result: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        } else {
          throw err;
        }
      }
    }

    // Detect deletes across every DELETE-DENIED mount, not just outputs — production's denial is a
    // property of the mount class, so a connected `rw` folder is in scope too.
    const scan = scanEvents(join(outDir, "events.jsonl"), deleteDeniedRootsFromPlan(plan));
    // A missing or corrupt events.jsonl means the post-run scan (host-path-leak / delete-in-outputs /
    // self-heal) has no trustworthy evidence — treat it as unavailable, never as a clean scan.
    const scanUnavailable = scan.sidecarMissing || scan.malformedLines > 0;
    // A delete outside `outputs` used to produce NO signal whatsoever, because detection was scoped to
    // the literal `outputs`. Production denies unlink/rmdir on every delete-denied mount, so this is a
    // real divergence: the agent proceeded where production would have returned EPERM. Reported as a
    // warning rather than a verdict signal — the harness DETECTS what production ENFORCES, and promoting
    // it to a failure would silently re-verdict existing runs.
    if (!scanUnavailable) {
      const nonOutputs = scan.mountDeletes.filter((d) => d.mount !== "outputs");
      for (const d of nonOutputs)
        warn(
          `::warning:: [scan] delete detected in mount "${d.mount}" — production denies unlink/rmdir there until approved: ${d.command}\n`,
        );
    }
    if (scan.sidecarMissing)
      warn(
        `::warning:: [scan] events.jsonl missing — post-run scan evidence unavailable (host-path-leak / delete-in-outputs / self-heal cannot be verified)\n`,
      );
    else if (scan.malformedLines > 0)
      warn(
        `::warning:: [scan] ${scan.malformedLines} malformed line(s) in events.jsonl — scan evidence unreliable, treated as unavailable\n`,
      );
    const workRoot = effectiveFidelity === "protocol" ? join(outDir, "work") : join(outDir, "work", "session", "mnt");

    // The runtime tripwire: if a gated tool call completed successfully with no evidence the path-containment
    // gate ever ran on it, the run's real-filesystem safety is unverified — hard-fail rather than pass silently.
    if (effectiveFidelity === "hostloop" && hostloopPathGateFired) {
      const ungated = findUngatedPathToolCalls(join(outDir, "events.jsonl"), hostloopPathGateFired);
      if (ungated.length) {
        warn(
          `::warning:: [hostloop] path-containment gate did not fire for: ${ungated.join(", ")} — real filesystem access is UNVERIFIED for this run.\n`,
        );
        record.result = "error";
      }
    }

    // User-visible roots = outputs + each connected work folder's RESOLVED mount name (derived from the
    // actual mount set, NOT a hardcoded `.projects/` prefix — folder names are now dynamic/gated). Plugins
    // are read-only inputs and are NOT visible roots. Persisted to RunResult so the plan-less lanes
    // (verify reads result.json; replay reads the cassette) match this without rebuilding a LaunchPlan.
    // Shared with the pre-run baseline walk (userVisibleRootsFromPlan) — pre and post MUST agree.
    const userVisibleRoots = userVisibleRootsFromPlan(plan);
    // Read-only (`mode: "r"`) connected-folder roots — inputs, not deliverables. Persisted so the cassette
    // recorder strips their captured BODIES (fidelity/no-bloat) and `RunResult.artifacts` excludes them
    // outright (an input is not a `file_exists` target). Does NOT change `userVisibleRoots` above.
    const readonlyFolderRoots = readonlyFolderRootsFromPlan(plan);
    // Read the pre-run baseline ONCE: the evaluate ctx and the persisted RunResult must see the same
    // value — two reads could disagree if the file were touched mid-run.
    const preRunPaths = readPreRunManifest(outDir);
    const preRunLinkAware = readPreRunManifestLinkAware(outDir);
    const preRunHashes = readPreRunManifestHashes(outDir);
    // the baseline's PROVENANCE — "local-unreadable" when a connected-folder source couldn't be
    // walked, so the path/hash maps are partial. Persisted to RunResult and threaded into the assert ctx
    // so no_unexpected_files / input_unmodified fail evidence-unavailable instead of diffing an
    // incomplete baseline. Read from the SAME single manifest read the paths/hashes came from.
    const preRunOrigin = readPreRunManifestOrigin(outDir);

    // Filesystem pre/post diff of outputs/ — a backstop for `no_delete_in_outputs` INDEPENDENT of
    // scanEvents' regex (which only inspects Bash/mcp__workspace__bash tool_use commands and so misses a
    // delete via a script file, a renamed binary, or any non-bash tool). If the pre-run baseline captured
    // outputs (it always does when captured at all — see pre-run-manifest.ts), any path recorded there
    // under outputs/ that is no longer present in the post-run walk is a real deletion regardless of HOW
    // it happened. Fed into the SAME `scan.outputsDeletes` array the regex populates — one signal, two
    // detectors — so `no_delete_in_outputs` (src/assert.ts) needs no changes to see it. Skipped when there
    // is no baseline (preRunPaths undefined — the scenario asserted neither key that triggers capture, or a
    // tier that can't capture); the regex backstop still runs in that case, same as before this change.
    if (preRunPaths) {
      // Path walk (matching the pre-run baseline): it emits symlink/hardlink paths too, so a pre-existing
      // link under outputs that survives is present on BOTH sides and is not falsely reported as removed.
      const postOutputs = collectArtifactPaths(workRoot, ["outputs"]).map((e) => e.path);
      scan.outputsDeletes.push(
        ...outputsRemovedByFsDiff(preRunPaths, postOutputs, {
          preRunHashes,
          // sha256 hex, matching the pre-run manifest's format so the two sides are comparable. Only
          // called for paths that are NEW under outputs, and only when something actually vanished, so
          // the ordinary run pays nothing. Unreadable ⇒ null ⇒ no rename proven ⇒ the removal reports.
          hashPostPath: (rel) => {
            try {
              return createHash("sha256")
                .update(readFileSync(join(workRoot, rel)))
                .digest("hex");
            } catch {
              return null;
            }
          },
        }),
      );
    }

    // Salvage path: the run exited on an unanswered gate. Persist a PARTIAL result.json (+ run.jsonl/trace) so
    // the artifacts the agent wrote before the whiff survive for inspection, then re-throw so the CLI still
    // exits 2. Skip assertion eval and the capability probe (a real container spawn) — a partial run has no
    // meaningful assertion or verdict outcome.
    if (unansweredErr) {
      const turn = currentTurn(outDir);
      const partialResult = buildPartialResult({
        turn,
        // Without this the salvage lane reported `modelSource: "unresolved"` on a run that WAS pinned —
        // a positive false statement, and one `CompleteRunResult` cannot catch (it guards the result's
        // fields, not the assembler's inputs, so the spread satisfied it with a lie).
        pinnedModel: plan.model,
        ablated: opts.ablateSkill,
        runLabel: opts.runLabel, // run-identity: a salvaged partial is still a labeled generation
        skillCommit: skillCommit(scenario.session, loadedSession),
        scenarioName: scenario.name,
        lane: scenario.lane, // a salvaged partial keeps the contract it was run under
        prompt: scenario.prompt,
        fidelity: scenario.fidelity,
        baseline: baseline.appVersion,
        record,
        outDir,
        workRoot,
        configDir: plan.configDir,
        sessionId,
        pluginSkillRoots: pluginSkillRootsFromPlan(plan),
        userVisibleRoots,
        readonlyFolderRoots,
        effectiveFidelity,
        egress,
        durationMs: Date.now() - startedAt,
        unanswered: { message: unansweredErr.message, hint: unansweredErr.hint },
        fingerprint: buildFingerprint(scenario.session, baseline.appVersion, undefined, scenario.skills, baseline, loadedSession),
        onUnanswered,
        nonDeterministicHint: opts.nonDeterministicHint,
        externalChannel: !!opts.externalChannel,
      });
      // Non-null: `durationMs` is set unconditionally just above (`Date.now() - startedAt`) — the field is
      // typed optional on RunResult/PartialResult for OTHER (non-execute.ts) producers, not this call site.
      runCrashSafety.finalize(record, "error", partialResult.durationMs!);
      // run.jsonl before result.json — see the ordering rationale on the success path below.
      const tDirPartial = turnWriteDir(outDir, turn);
      writeRunJsonl(tDirPartial, scenario, effectiveFidelity, record, egress, secrets, turn);
      // Atomic: a crash mid-write must never leave a torn result.json — see writeTextAtomic's doc comment.
      const partialText = scrub(JSON.stringify(partialResult, null, 2), secrets);
      writeTextAtomic(join(tDirPartial, "result.json"), partialText);

      appendIndexRow(runsWriteRoot(), indexRowFromResult(partialResult, { command: opts.command ?? "run", partial: true }));
      writeTrace(tDirPartial, record, egress, secrets, partialResult.durationMs);
      // Loud PARTIAL marker so the populated artifacts are never misread as success (the no-false-green rule).
      warn(
        `::notice:: [partial] run did NOT complete (unanswered gate) — salvaged the pre-failure work to:\n` +
          `  ${outDir}\n  inspect it: cowork-harness inspect ${outDir}\n`,
      );
      throw unansweredErr;
    }

    // The session's TimelineWriter (src/agent/timeline.ts) flushes timeline.jsonl in its `finally` block
    // during session.start(), which has already fully returned by this point (run.drive() awaited it above) —
    // same guarantee scanEvents(join(outDir, "events.jsonl")) already relies on a few lines above. Read ONCE
    // and reuse for both the evaluate ctx (skill_tool_used) and the later assembleRunResult call
    // (toolDurations/skillActivity/subagents) below — two reads could disagree if the file were touched mid-run.
    const timelineData = readTimeline(outDir);
    if (timelineData && (timelineData.malformedLines > 0 || timelineData.headerCorrupt))
      warn(
        `::warning:: [timeline] ${timelineData.malformedLines} malformed line(s) in timeline.jsonl — skill-activity/tool-duration telemetry is incomplete, treated as unavailable\n`,
      );
    // A partially-corrupt timeline (valid header, dropped event lines) yields an INCOMPLETE fold — a dropped
    // line could be a skill/tool window — so treat it as unavailable rather than silently incomplete (mirrors
    // the scan missing/malformed handling; skill_tool_used then fails evidence-unavailable, never a false green). #35
    const timelineEvents =
      timelineData && timelineData.malformedLines === 0 && !timelineData.headerCorrupt ? timelineData.events : undefined;

    // Context/Connectors panel: the SPINE is the id-only list run.ts's init handler already seeded
    // onto record.context.availableSkills from the agent's own init event (authoritative — covers plugin/
    // marketplace skills, which the disk scan never saw). Here we enrich each id with whenToUse read off
    // disk, across BOTH delivery trees (skills.local under plan.configDir, plugin skills under each staged
    // plugin mount). Populated HERE (before the evaluate() ctx below, which needs it for skill_available)
    // rather than only later before assembleRunResult — reading it twice would be wasteful and out of order;
    // this single assignment feeds both.
    // `initSkills` is the id-only list run.ts seeded from the agent's init event — undefined if init never
    // delivered an inventory (a pre-init crash / an agent version that didn't emit it). PRESERVE that
    // undefined: collapsing it to a defined [] (the old `?? []` + unconditional enrich) made skill_available
    // report "no staged skill matched" (false-absent) instead of tripping its evidence-unavailable guard. #16
    const initSkills = record.context?.availableSkills;
    const availableSkillIds = initSkills?.map((s) => s.id) ?? [];
    record.context = {
      ...record.context,
      availableSkills:
        initSkills === undefined ? undefined : resolveAvailableSkills(availableSkillIds, plan.configDir, pluginSkillRootsFromPlan(plan)),
    };

    // Surface dropped egress proxy-log lines as evidence health (collected in the finally above; applied here
    // where `record` is definitely assigned). #39
    if (egressMalformedLines > 0) record.evidenceErrors.egressParse = (record.evidenceErrors.egressParse ?? 0) + egressMalformedLines;

    // Fold resources.jsonl ONCE — reused by both the evaluate() ctx below (max_peak_rss_bytes) and the
    // assembleRunResult call further down. A second read could disagree if the sampler wrote between them.
    // Thread the sampler's probe-failure count so the summary can distinguish "sampling failed" from
    // "sampling unsupported / never ran". #41
    const resources = foldResources(outDir, effectiveFidelity, resolveIntervalMs(), resourceSampler?.probeFailures, turnNumber);

    // D1: the judge grades the union of the final answer + transcript + the files the run AUTHORED (final
    // on-disk content), so a claim about a written artifact is presentation-stable (not a paste-vs-write
    // coin-flip). Captured here — BEFORE the semantic pre-pass below — using the pre-run manifest to diff
    // added/modified files. (`[]` when there's no manifest, e.g. a --resume run.)
    // F12, CORRECTED 2026-08-27: the old text said "at container/hostloop the agent's cwd is the SESSION
    // ROOT". True at CONTAINER only. At hostloop the agent process sits at `mnt/outputs` (see
    // `hostLoopCwds` in src/runtime/hostloop.ts), so a bare `Write` there lands INSIDE `workRoot` and needs
    // no scratchpad walk to be seen. The branch is still right, but for two different reasons per tier:
    //   container — agent cwd IS the session root, so a relative `Write` lands outside `workRoot`;
    //   hostloop  — the agent writes inside `mnt`, but `mcp__workspace__bash` starts at the session root,
    //               so a relative SHELL write lands outside `workRoot`.
    // Either way `workRoot` ends `/session/mnt` and its parent is the root, so passing it captures what the
    // run actually authored.
    //
    // KNOWN FALSE-GREEN, deliberately not fixed here (see docs/fidelity-gaps.md, "Path resolution"):
    // production DISCARDS anything written outside `mnt/` — "never reaches the user or your file tools" —
    // while the harness bind-mounts the whole session dir, so these files persist and can be graded as
    // authored. That is correct for the semantic judge (the run did write them) and wrong as a model of
    // delivery. `user_visible_artifact` is unaffected: it checks user-visible ROOTS, not this set.
    const scratchpadRoot = workRoot.endsWith(`${sep}mnt`) ? dirname(workRoot) : undefined;
    // On a resume the session root is REUSED, so the scratchpad no longer starts empty — a prior turn's files
    // would be mis-attributed as this turn's authorship. Skip the scratchpad walk in that case (evidence-
    // unavailable is safer than misattribution). #17
    // Spend the capture's size budget on the files the scenario's judges actually grade. The walk is
    // prefix-major then alphabetical, so without this an intermediates dir sorting early (`_work/`…)
    // drains the whole budget before the deliverable is reached — and the judge is then refused over
    // files no rubric mentions. The union across every `semantic_matches`: one capture serves them all.
    const priorityGlobs = [...new Set(scenario.assert.flatMap((a) => a.semantic_matches?.evidence_files ?? []))];
    const authored = captureAuthoredFilesWithHealth(workRoot, userVisibleRoots, readonlyFolderRoots, preRunHashes, {
      scratchpadRoot,
      resume: plan.resume,
      // Pre-run mtime/size lets an over-cap/unreadable prior file (hash === null) be positively confirmed
      // UNCHANGED rather than either mis-attributed as authored or silently dropped from evidence. #15/#12
      preRunStats: readPreRunManifestStats(outDir),
      ...(priorityGlobs.length ? { priorityGlobs } : {}),
      totalBytes: authoredTotalBytes(),
    });

    const assertCtx: AssertContext = {
      transcript: record.transcript,
      finalMessage: record.resultText,
      authoredFiles: authored.files,
      // #14/#16: carry capture health (omitted-at-cap / unreadable files) so a semantic grade over an
      // incomplete authored document is refused, not trusted. Undefined when the capture was complete.
      authoredFilesHealth: authoredFilesHealthNonEmpty(authored.health) ? authored.health : undefined,
      secrets,
      toolsCalled: record.toolsCalled,
      referencesAccessed: unionReferenceAccesses(record),
      subagentTools: record.subagentTools,
      egress,
      result: record.result,
      workRoot,
      userVisiblePrefixes: userVisibleRoots,
      lane: scenario.lane,
      // Read-only folder inputs are captured body-less; artifact_json must reach the same
      // evidence-unavailable verdict here as on replay (see AssertContext.readonlyFolderRoots).
      readonlyFolderRoots,
      preRunPaths,
      preRunLinkAware,
      preRunHashes,
      preRunOrigin,
      outputsDeletes: scan.outputsDeletes,
      mountDeletes: scan.mountDeletes,
      questions: record.questions,
      gateOptions: record.gateOptions,
      hostPathLeaked: scan.hostPathLeaked,
      selfHealRan: scan.selfHealRan,
      // Missing/corrupt events.jsonl → the scan-dependent assertions (no_delete_in_outputs /
      // transcript_no_host_path / self_heal_ran) fail "evidence unavailable" instead of vacuously green.
      scanMissing: scanUnavailable,
      subagents: record.subagents,
      gateDeliveries: record.gateDeliveries,
      toolResultTexts: record.toolResults.map((r) => r.assertText ?? r.text),
      toolResultsTruncated: record.toolResults.map((r) => r.assertText === undefined),
      // Minimal pairing info (toolUseId/isError, no text) for subagent_file_write's causal pairing
      // against fileToolAttempts. Always defined live — an empty array is a real "no tool results" signal.
      toolResults: record.toolResults.map((r) => ({ toolUseId: r.toolUseId, isError: r.isError })),
      toolErrors: record.toolErrors,
      redundantToolCalls: record.redundantToolCalls,
      skillsInvoked: record.skillsInvoked,
      skillToolAvailable: record.initTools.includes("Skill"),
      skillActivity: timelineEvents ? foldSkillActivity(timelineEvents) : undefined,
      tasks: Array.from(record.tasks.values()),
      // Context/Connectors panel — backs skill_available/connector_available/tool_available.
      // record.context is populated above (availableSkills merged in before this ctx literal; tools/mcpServers
      // set at init time in run.ts), so these are already live by the time evaluate() runs.
      availableSkills: record.context?.availableSkills,
      // mcpServers is unknown[] on the RunRecord (verbatim from the SDK's init event) — cast, not a
      // transformation, matching the same pass-through cast assembleRunResult uses below.
      mcpServers: record.context?.mcpServers as AssertContext["mcpServers"],
      availableTools: record.context?.tools,
      contextEvents: record.contextEvents,
      // Always defined live — an empty array is a real "no MCP errors" signal, distinct from replay's
      // undefined (mcp round-trips are harness-computed, not in the cassette's frozen stdout stream).
      mcpErrors: record.mcpErrors,
      // Always defined live — the built-in Task hook only fires on a dispatched background Task, so an
      // empty array on a no-Task scenario is the real "nothing hook-blocked" signal no_hook_blocked needs.
      hookEvents: record.hookEvents,
      // Always defined live — an empty array is the real "no gated attempts" signal, matching hookEvents/
      // presentedFiles' own uncollapsed convention.
      fileToolAttempts: record.fileToolAttempts,
      // Always defined live — an empty array is the real "no path denials" signal, matching
      // fileToolAttempts/hookEvents' own uncollapsed convention.
      pathDenials: record.pathDenials,
      // Always defined live — an empty array is the real "nothing presented" signal no_scratchpad_leak's
      // vacuous pass needs, distinct from replay's evidence-unavailable undefined on an older cassette.
      presentedFiles: record.presentedFiles,
      presentFilesCalls: record.presentFilesCalls,
      evidenceErrors: record.evidenceErrors,
      effectiveFidelity,
      // Live lane (this run's own machine) — host-shaped computer:// links (hostloop) are checked
      // DIRECTLY on the filesystem, contained to the run's real workspace roots; verify-run shares
      // this same "live" mode without hostRoots (see cli.ts's cmdVerifyRun).
      linkResolution: {
        mode: "live",
        hostRoots: [join(resolve(outDir), "work", "session", "mnt"), ...plan.mounts.filter(isConnectedContent).map((m) => m.hostPath)],
      },
      ...budgetFields(record),
      resources,
    };

    // LIVE lane: grade any `semantic_matches` asserts with the LLM judge BEFORE the synchronous
    // evaluate() reads the per-claim results into check(). Gated so a scenario with no such assert never
    // spends a model call. (Replay strips `semantic_matches` as live-only, so it never reaches here.)
    if (scenario.assert.some((a) => a.semantic_matches !== undefined)) {
      await runSemanticJudges(
        scenario.assert,
        assertCtx,
        opts.semanticJudge ?? makeSemanticJudge(),
        (model) => makeSemanticJudge({ model }), // honor a per-assert judge_model override
      );
    }
    const assertions = evaluate(scenario.assert, assertCtx);

    if (scenario.fidelity === "protocol" && (record.toolsCalled.has("WebFetch") || record.toolsCalled.has("WebSearch"))) {
      warn(`::warning:: ${scenario.name}: a network tool ran at L0 (protocol) — egress is NOT enforced here.\n`);
    }

    // Shared with the verify path so the two cannot report differently on the same evidence.
    assertions.push(...expandExpectDenied(scenario.expect_denied, egress));

    // Capability fidelity: on a live sandboxed tier, probe what the runtime OMITS vs the real
    // Cowork rootfs, then detect whether the skill USED an omitted family. A non-empty intersection on an
    // otherwise-green run is a likely FALSE NEGATIVE → computeVerdict fails it (unless allow_missing_capability).
    // Probing is structural (the runtime is the source of truth), so an old `:1` / custom image can't silently
    // fail-open. container/hostloop → Docker image probe; microvm → `limactl shell` guest probe. Skipped on
    // protocol/replay (no live runtime to probe) and via COWORK_SKIP_CAPABILITY_PROBE.
    let missingCapabilityUse: string[] | undefined;
    let capabilityProbe: RunResult["capabilityProbe"] = "skipped"; // default — probe didn't run this tier/lane
    let omittedFamilies: string[] | null = null; // the probe's omitted-set (null = not run / unverified)
    // Hoisted above the probe block (not declared at its original use site below) so the events-scan health
    // check can also populate it for UNDECLARED omitted-capability use — `scenario.requires_capabilities`
    // covers only the declared half; an unreadable/degraded events.jsonl threatens the undeclared half too.
    let requiresCapabilityUnmet: RunResult["requiresCapabilityUnmet"];
    if (
      (effectiveFidelity === "container" || effectiveFidelity === "hostloop" || effectiveFidelity === "microvm") &&
      process.env.COWORK_SKIP_CAPABILITY_PROBE !== "1"
    ) {
      const omitted =
        effectiveFidelity === "microvm"
          ? probeMicrovmOmitted(instanceName(baseline))
          : probeImageOmitted({
              runtime: resolveContainerRuntime(),
              image: resolveAgentImage(),
              tier: effectiveFidelity,
            });
      omittedFamilies = omitted;
      capabilityProbe = omitted === null ? "unverified" : "definitive"; // ran → definitive; failed → unverified
      if (omitted === null) {
        const w =
          "agent runtime could not be probed for capabilities — capability fidelity unverified (capability false-negatives won't be caught this run)";
        warn(`::warning:: [capability] (informational, unverified) ${w}\n`);
        promptFidelityWarnings = [...(promptFidelityWarnings ?? []), w];
      } else if (omitted.length) {
        // state the safety net the notice is otherwise silent about — an omitted family that the skill
        // actually USES hard-fails the run below (no silent false-pass). Tag the verdict impact so an observer
        // never reads an informational line as a failure cause (or vice-versa).
        if (!opts.compact)
          warn(
            `::notice:: [capability] (informational, guarded) this image omits: ${omitted.join(", ")} — ` +
              `if a skill actually USES one, this run HARD-FAILS (no silent false-pass). ` +
              `Only rebuild full parity (--build-arg COWORK_FULL_PARITY=1) if your skill needs them.\n`,
          );
        // The probe + hard-fail safety net runs regardless of --compact (only the informational notice above is gated).
        const scanned = detectCapabilityUse(join(outDir, "events.jsonl"), omitted, workRoot);
        if (scanned.used.length) {
          missingCapabilityUse = scanned.used;
          warn(
            `::warning:: [capability] (FAILED THIS RUN) the skill USED omitted capabilit(ies) [${scanned.used.join(", ")}] — likely a FALSE NEGATIVE, ` +
              `not a skill bug. Rebuild full parity (--build-arg COWORK_FULL_PARITY=1), or assert allow_missing_capability: true if the fallback is equivalent.\n`,
          );
        }
        if (scanned.health !== "complete") {
          // The scan itself is health-blind evidence: an unreadable/degraded events.jsonl means an empty
          // `used` is NOT "scanned clean" — it's "couldn't verify". Downgrade the probe outcome (guard
          // roster stops reading it as a false "ok") and hard-fail via the SAME evidence-unavailable path
          // `requires_capabilities` already uses, for whichever omitted families this scan couldn't confirm
          // clean — closing the false-green even when the skill declared no requires_capabilities at all.
          capabilityProbe = "unverified";
          const unresolved = omitted.filter((f) => !scanned.used.includes(f));
          if (unresolved.length)
            requiresCapabilityUnmet = {
              caps: [...new Set([...(requiresCapabilityUnmet?.caps ?? []), ...unresolved])],
              reason: "unverifiable",
            };
          const reasonDetail =
            scanned.health === "missing" ? "events.jsonl unreadable" : `${scanned.malformedLines} malformed line(s) in events.jsonl`;
          warn(
            `::warning:: [capability] (FAILED THIS RUN) capability-use scan could not complete (${reasonDetail}) — cannot verify ` +
              `whether omitted capabilit(ies) [${unresolved.length ? unresolved.join(", ") : omitted.join(", ")}] were used; ` +
              `treating as evidence-unavailable rather than a silent pass. Assert allow_missing_capability: true if intended.\n`,
          );
        } else if (!scanned.used.length) {
          // close the loop — the bare omits-notice + a green run reads as a false-green RISK unless we say
          // the guard ran and found nothing. Emit ONLY here (probe ran clean, families omitted), never in the
          // omitted===null unverified branch (which has no basis to claim "not used") nor when health degraded.
          if (!opts.compact)
            warn(`::notice:: [capability] (informational, guarded) omitted families were not used this run → no false-negative.\n`);
        }
      }
    }

    // a skill can DECLARE the capability families its core path needs. If the running tier omits one
    // (clause a) or can't verify them — protocol/replay/skip (clause b) — the run hard-fails (computeVerdict),
    // closing the false-green for extraction-heavy skills. Computed at run time so verify-run/replay honor the
    // recorded outcome (a clean full-parity run records nothing → no false-fail on later verify-run).
    // (`requiresCapabilityUnmet` itself is declared above, before the probe block — the events-scan health
    // check may already have populated it for the UNDECLARED-capability half.)
    const requiredCaps = scenario.requires_capabilities ?? [];
    if (requiredCaps.length) {
      const known = new Set(Object.keys(CAPABILITY_FAMILIES));
      const unknown = requiredCaps.filter((c) => !known.has(c));
      if (unknown.length)
        warn(
          `::warning:: [capability] requires_capabilities lists unknown famil(ies): ${unknown.join(", ")} — known: ${[...known].join(", ")}\n`,
        );
      if (unknown.length) {
        // An unknown family (typo) can NEVER appear in omittedFamilies (which lists only real families), so
        // the definitive-lane `missing` filter below would silently drop it → false-green. Fold it into the
        // unmet set so it hard-fails as an authoring error regardless of lane. MERGE (not overwrite) with
        // any caps the events-scan health check already recorded, so that signal isn't silently dropped.
        requiresCapabilityUnmet = {
          caps: [...new Set([...(requiresCapabilityUnmet?.caps ?? []), ...unknown])],
          reason: "unknown",
        };
      }
      if (capabilityProbe === "definitive") {
        const missing = requiredCaps.filter((c) => known.has(c) && omittedFamilies?.includes(c));
        if (missing.length)
          requiresCapabilityUnmet = {
            caps: [...new Set([...(requiresCapabilityUnmet?.caps ?? []), ...missing])],
            reason: unknown.length ? "unknown" : "omitted",
          };
      } else if (!unknown.length) {
        // skipped/unverified (protocol/replay/skip-env, OR the events-scan health check above downgraded a
        // definitive probe to unverified) — cannot confirm the declared caps are present. MERGE with any
        // caps already recorded rather than overwrite, so an undeclared-capability scan-health finding
        // survives alongside the declared one.
        requiresCapabilityUnmet = {
          caps: [...new Set([...(requiresCapabilityUnmet?.caps ?? []), ...requiredCaps])],
          reason: "unverifiable",
        };
        warn(
          `::warning:: [capability] (FAILED THIS RUN) skill declares requires_capabilities [${requiredCaps.join(", ")}] but this tier ` +
            `cannot verify them (${capabilityProbe}) — run on a live built-image tier, or assert allow_missing_capability: true.\n`,
        );
      }
    }

    // Gate provenance: how each AskUserQuestion gate was answered (scripted / decided / first / prompt).
    // Derived from the same decision log the envelope persists; `undefined` when the run had no gates so
    // the field self-suppresses. Informational — never affects the verdict. `record.decisions`
    // (DecisionRecord[], `by: string`) is assignable to the summarizer's `by?: string` param — no re-map.
    const gateProvenance = summarizeGateProvenance(record.decisions);

    // Working folder panel's file model: classify+fingerprint every file under the
    // user-visible roots (output/mount/input). Reuses the same walk `artifacts` derives from below, over
    // ALL userVisibleRoots — read-only inputs are still enumerated here, just tagged "input" instead of
    // excluded outright.
    const wfHealth = classifyWorkspaceFilesWithHealth(workRoot, userVisibleRoots, readonlyFolderRoots, {
      // Same derivation authored-file capture uses (above): the session root is the PARENT of `mnt`.
      // Undefined on a tier with no such layout (protocol) — then `scratchpadScanned` is false and the
      // absence of scratchpad entries means UNKNOWN, not none.
      scratchpadRoot: workRoot.endsWith(`${sep}mnt`) ? dirname(workRoot) : undefined,
    });
    if (wfHealth.rootAbsent)
      warn(
        `::warning:: [artifacts] workspace root not found (${workRoot}) — the run's outputs were not staged into the run dir ` +
          `(known on microvm: the agent's files land in the VM work tree, not outDir). Recording workspaceFiles/artifacts as ` +
          `UNAVAILABLE (undefined), not empty, so a consumer can't mistake it for a zero-artifact run (#52).\n`,
      );
    else if (!wfHealth.walkComplete)
      warn(
        `::warning:: [artifacts] workspace walk incomplete — ${wfHealth.walkErrors.length} unreadable subtree(s) ` +
          `[${wfHealth.walkErrors.map((e) => `${e.path} (${e.error})`).join(", ")}]. Recording workspaceFiles/artifacts as ` +
          `UNAVAILABLE (undefined), not a partial list, so an absence-sensitive assertion can't read a file inside the ` +
          `unobserved subtree as absent (#54).\n`,
      );
    // #52/#54 false-green fix: a missing root OR a nested unreadable subtree means the enumeration is not
    // trustworthy — record UNAVAILABLE (`undefined`, the replay convention), never a false-empty/partial
    // `[]` that reads as "wrote nothing" or as a complete list. `trustedWorkspaceFiles` is the shared gate.
    const workspaceFiles = trustedWorkspaceFiles(wfHealth);

    // Multi-turn: archive the prior turn's run.jsonl/result.json (if this is a --resume) and get THIS
    // turn's number, so the RunResult and run.jsonl agree and each turn's result stays recoverable.
    const turn = currentTurn(outDir);

    const result: RunResult = assembleRunResult({
      $schema: RUN_RESULT_SCHEMA_URL,
      generator: "cowork-harness",
      mode: "run",
      lane: scenario.lane,
      scratchpadEvidenceComplete: scratchpadEvidenceComplete(wfHealth),
      command: opts.command ?? "run", // #48: persist the originating command (skill/record share mode:"run")
      runLabel: opts.runLabel, // run-identity: user --label tag (undefined if not passed)
      skillCommit: skillCommit(scenario.session, loadedSession), // best-effort git HEAD of the skill dirs (same set as fingerprint.skillHash)
      turn,
      ablated: opts.ablateSkill || undefined,
      referencesRead: record.filesRead.length ? record.filesRead : undefined,
      referencesAccessed: record.referencesAccessed,
      finalMessage: record.resultText,
      execution: { location: "local" }, // live local run — no scheduled-trigger lane exists yet (no taskKind)
      scenario: scenario.name,
      prompt: scenario.prompt, // persisted for `scaffold <run-dir>`
      fidelity: scenario.fidelity,
      baseline: baseline.appVersion,
      result: record.result,
      resultErrorKind: record.resultErrorKind, // transport vs agent classification of a result:"error"
      errorSource: record.errorSource, // finer error-event source, alongside the coarse resultErrorKind
      resultSubtype: record.resultSubtype, // SDK result subtype pass-through (error_max_turns / …)
      stderrLogPath: join(outDir, "agent.stderr.log"), // always written by the live agent process
      stalledOnQuestion: record.stalledOnQuestion, // run ended on an unanswered plain-text question
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
      toolDurations: timelineEvents ? foldToolDurations(timelineEvents) : undefined,
      skillActivity: timelineEvents ? foldSkillActivity(timelineEvents) : undefined,
      models: record.models.length ? record.models : undefined,
      ...deriveModelProvenance(plan.model, record.models.length ? record.models : undefined, record.modelFallbacks),
      thinking: record.thinking.length ? record.thinking : undefined,
      thinkingElided: record.thinkingElided,
      toolErrors: record.toolErrors,
      modelUsage: record.modelUsage,
      redundantToolCalls: record.redundantToolCalls,
      tasks: Array.from(record.tasks.values()),
      // mcpServers is unknown[] on the RunRecord (verbatim from the SDK's init event) but RunResult
      // documents its loose per-server shape ({name, status?, ...}) for consumers — cast, not a
      // transformation; the underlying array is passed through unchanged.
      context: record.context as RunResult["context"],
      gateDeliveries: record.gateDeliveries,
      egress,
      assertions,
      toolResults: record.toolResults,
      subagents: timelineEvents ? attributeSubagentSkills(record.subagents, timelineEvents) : record.subagents,
      nonReproducibleAnswers: record.unanswered,
      usage: record.usage,
      cost: record.cost,
      skillsInvoked: record.skillsInvoked,
      skillToolAvailable: record.initTools.includes("Skill"),
      durationMs: Date.now() - startedAt,
      outDir,
      workDir: workRoot,
      outputsDir: join(workRoot, "outputs"),
      userVisibleRoots,
      readonlyFolderRoots,
      // artifacts is a DERIVED VIEW of workspaceFiles — same collectArtifacts walk,
      // filtered to the deliverable classes (excludes class:"input" read-only mounts). No second walk.
      artifacts: workspaceFiles?.filter((f) => f.class === "output" || f.class === "mount").map((f) => ({ path: f.path, bytes: f.bytes })),
      workspaceFiles, // Working folder panel's canonical file model (output/mount/input) — see comment above
      contextEvents: record.contextEvents, // system events we don't special-case — powers compaction_occurred
      mcpErrors: record.mcpErrors, // uncollapsed — an empty [] is the real "no MCP errors" signal no_mcp_error needs
      hookEvents: record.hookEvents, // uncollapsed — an empty [] on a no-Task scenario is the real "nothing hook-blocked" signal no_hook_blocked needs
      fileToolAttempts: record.fileToolAttempts, // uncollapsed — content-class, same as toolResults/decisions above
      pathDenials: record.pathDenials, // uncollapsed — content-class, same as fileToolAttempts above
      presentedFiles: record.presentedFiles, // uncollapsed — an empty [] is the real "nothing presented" signal no_scratchpad_leak's vacuous pass needs
      presentFilesCalls: record.presentFilesCalls,
      // The pre-spawn baseline no_unexpected_files diffs against (same single read the evaluate ctx got).
      // undefined = the run didn't capture (key not asserted, microvm, pre-seam) — the assertion then
      // fails evidence-unavailable, loud.
      preRunPaths,
      preRunLinkAware,
      preRunHashes,
      preRunOrigin,
      nonDeterministic:
        // LLM-, external-, human-, or first-option-decided → not reproducible. `first` picks options[0] and
        // option order can vary run-to-run; it's already pushed to unanswered[], so include it here to agree.
        record.decisions.some((d) => d.by === "llm" || d.by === "external" || d.by === "human" || d.by === "first") ||
        !!opts.nonDeterministicHint,
      nonDeterministicTerminal: onUnanswered === "llm" || onUnanswered === "prompt" || !!opts.externalChannel,
      gateProvenance: gateProvenance.total ? gateProvenance : undefined,
      permissiveAutoAllow: record.permissiveAutoAllow.length ? record.permissiveAutoAllow : undefined, // cowork-parity off-registry auto-allows (real Cowork blocks) — non-empty ⇒ NOT a faithful pass
      // post-run scan signals (delete-in-outputs / host-path-leak / self-heal) — computeVerdict default-fails
      // when unasserted. `undefined` (NOT an all-false object) when events.jsonl was missing/corrupt, so
      // verify-run's `scanMissing = result.scan === undefined` fires and the dependent assertions fail loud.
      scan: scanUnavailable
        ? undefined
        : {
            outputsDeletes: scan.outputsDeletes,
            // Omitted when empty so an unchanged run's result.json is byte-identical to before.
            ...(scan.mountDeletes.length ? { mountDeletes: scan.mountDeletes } : {}),
            hostPathLeaked: scan.hostPathLeaked,
            selfHealRan: scan.selfHealRan,
          },
      effectiveFidelity, // The tier actually used — differs from fidelity when fidelity:"cowork"
      fidelityWarnings: promptFidelityWarnings, // structured prompt warnings visible to JSON callers
      l0HostConfigContamination: l0HostConfigContamination || undefined, // failing fidelity signal for protocol+plugins
      missingCapabilityUse, // capability fidelity: omitted-capability families the skill used (live built-image tiers) — computeVerdict fails unless allow_missing_capability
      capabilityProbe, // probe outcome (definitive | unverified | skipped) for the guard roster
      requiresCapabilityUnmet, // declared requires_capabilities the tier couldn't satisfy → computeVerdict fails unless allow_missing_capability
      // Skill staleness fingerprint, persisted on EVERY run (runs are always kept on disk) so `verify-run` can
      // detect a kept run that predates a skill change and refuse to vouch for answer-coverage. Same call the
      // record path uses for the cassette (cassette.ts) — `(inline)`/no-skill sessions yield a {baseline}-only fp.
      fingerprint: buildFingerprint(scenario.session, baseline.appVersion, undefined, scenario.skills, baseline, loadedSession),
      resources, // same single fold as the evaluate() ctx above — not re-read
      // Fields this lane has NEVER set (were implicitly `undefined` before this refactor; now explicit
      // per assembleRunResult's contract — this line makes the omission a reviewable, greppable fact
      // instead of an invisible one):
      partial: undefined,
      unansweredGate: undefined,
      staleness: undefined,
      mutation: undefined, // replay --mutate only
      skippedAssertions: undefined,
      outcome: undefined, // stamped alongside the verdict just below (derived from it)
      verdict: undefined, // computed just below (after assertions are evaluated / the object is fully assembled) and stored — see the comment there
    });

    // Sub-agent reasoning (thinking + text turns), read from each dispatch's on-disk child session
    // transcript (LIVE/record only — see resolveSubagentConfigRoot's doc comment for the per-tier root
    // and captureSubagentReasoning's for the join). Mutates `result.subagents[].reasoning` in place; a
    // `undefined` root (e.g. protocol tier) or a capture-internal failure is a silent no-op — reasoning
    // just stays absent, never a run failure.
    const subagentConfigRoot = resolveSubagentConfigRoot(effectiveFidelity, { configDir: plan.configDir, workRoot, sessionId });
    if (subagentConfigRoot) captureSubagentReasoning(subagentConfigRoot, result.subagents);

    // THE verdict-persist point: `computeVerdict` is downstream of assembling `result` (it reads
    // `result.assertions`, `result.scan`, `result.permissiveAutoAllow`, …), so it can only run here, after
    // the assembler call above — never inside it. Stored verbatim on `result` before it's written to
    // result.json (below) — the SAME `Verdict` shape (`{pass, exitCode, signals, guards, failures}`) the
    // `--output-format json` stdout envelope attaches (envelope.ts calls `computeVerdict` too), so the two
    // channels can never diverge in shape or value.
    result.verdict = computeVerdict(result, "live");
    result.outcome = deriveOutcome(result);

    // Non-null: see the matching comment at the partial-result finalize call above.
    runCrashSafety.finalize(record, result.result, result.durationMs!);

    // Artifacts: the harness-observability log `run.jsonl` REPLACES transcript.json/decisions.jsonl.
    // Write run.jsonl BEFORE result.json: a crash between the two then leaves run.jsonl present (so the
    // next resume computes turn N+1 and archives this orphan as run.turn-<N>.jsonl) rather than result.json
    // present with run.jsonl absent (which would recompute the SAME turn N and overwrite the already-archived
    // result.turn-<N-1>.json). Order matters — do not swap.
    const tDir = turnWriteDir(outDir, turn);
    writeRunJsonl(tDir, scenario, effectiveFidelity, record, egress, secrets, turn);
    // Atomic: a crash mid-write must never leave a torn result.json — see writeTextAtomic's doc comment.
    const resultText = scrub(JSON.stringify(result, null, 2), secrets);
    writeTextAtomic(join(tDir, "result.json"), resultText);
    appendIndexRow(runsWriteRoot(), indexRowFromResult(result, { command: opts.command ?? "run", partial: false }));
    writeTrace(tDir, record, egress, secrets, result.durationMs);
    return result;
  } finally {
    // LAST on purpose: the raw-stream readers above ran on the unscrubbed files — see the comment at
    // the matching `try`. A finally runs on return AND on every throw, so the only in-process exits
    // that skip this are ones where no raw log exists yet (throws before the try).
    scrubRawRunLogs(outDir, secrets);
  }
}

export function parseSessionFile(path: string): unknown {
  if (path === "(inline)") return {};
  return parseYaml(readFileSync(path, "utf8"));
}

const isFileRelative = (p: string) => p !== "(inline)" && !isAbsolute(p) && !p.startsWith("~");

/**
 * Parse a scenario file and resolve its `session:` reference relative to the SCENARIO
 * file's directory (not the cwd), so a scenario+session bundle is self-contained and
 * relocatable. Use this everywhere a scenario is read from disk (`run`, `record`).
 */
/** True when the YAML did not name a tier, so `fidelity` came from the schema default.
 *
 *  Must be read from the RAW document: Zod's `.default("container")` makes the parsed object
 *  indistinguishable from one that said `fidelity: container` on purpose, and those two cases deserve
 *  different treatment — an author who chose the tier has made the choice, one who omitted it has not.
 *
 *  Why anyone cares: the default models the VM-LOOP lane, and production runs HOST-LOOP (gate 1143815894
 *  is force-ON in every shipped baseline). So a scenario that omits the key is measured against the lane
 *  real users are not on — silently. Measured 2026-08-27; see docs/fidelity-gaps.md, "Path resolution". */
/** Scenario names already warned about a defaulted `fidelity:` in THIS process — see the emission site
 *  below for why de-duplication is needed at all (one command parses a file up to three times). */
const FIDELITY_NOTICE_SEEN = new Set<string>();

export function fidelityWasDefaulted(raw: unknown): boolean {
  return typeof raw === "object" && raw !== null && !("fidelity" in (raw as Record<string, unknown>));
}

/** The deprecation notice for a defaulted tier. `fidelity` becomes REQUIRED in the next major; until
 *  then this warns rather than failing, so consumers get told before they get an error. */
export function defaultedFidelityNotice(name: string): string {
  return (
    `::warning:: [scenario] ${name}: no \`fidelity:\` — defaulting to \`container\`, which models the ` +
    `VM-LOOP lane. Production runs HOST-LOOP by default (gate 1143815894), so this scenario is likely ` +
    `measured against a lane your users are not on: the file tools resolve a bare relative path ` +
    `differently, the shell starts somewhere else, and the offered tool set differs. Name a tier ` +
    `explicitly — \`fidelity: hostloop\` to match production, \`fidelity: cowork\` to auto-pick the way ` +
    `Cowork does, or \`fidelity: container\` to keep today's behaviour deliberately. Switching tiers can ` +
    `COST you assertions: \`no_scratchpad_leak\` is container-only (a lint error elsewhere) and ` +
    `\`transcript_no_host_path\` fails by design at hostloop/protocol. ` +
    `DEPRECATION: the default is being removed — \`fidelity:\` becomes REQUIRED in the next major.`
  );
}

export function parseScenarioFile(path: string): Scenario {
  let scenario: Scenario;
  let rawDoc: unknown;
  try {
    rawDoc = parseYaml(readFileSync(path, "utf8"));
    scenario = Scenario.parse(rawDoc);
  } catch (e) {
    // A schema violation is a USER mistake (a typo'd/retired key like `profile:`, a bad enum value),
    // not a harness bug — rethrow as UsageError so main().catch maps it to category `usage`, not
    // `internal`. The Zod issue list stays in the message (it names the offending key/value).
    // COMPACT in the message, the full issue array in `hint`. The dump used to BE the message, which
    // made a batch listing unreadable (one file = 13-16 lines of JSON punctuation) and, at
    // `verify-cassettes`, embedded a multi-line blob mid-sentence inside a schema-covered `notes[]`
    // string. Nothing is lost: `hint` is a contracted envelope field, so the issues stay machine-
    // reachable. SPEC.md explicitly disclaims grep-stability of error prose, so the compact form is
    // free to be the message.
    if (e instanceof ZodError) throw new UsageError(`invalid scenario ${path}: ${compactSchemaError(e.issues)}`, e.message);
    throw e;
  }
  // `name` defaults to the filename (sans extension) — the file is the identity.
  if (!scenario.name) scenario.name = basename(path).replace(/\.ya?ml$/i, "");
  // Warn, do not fail: this is the deprecation window before `fidelity` becomes required.
  // ONCE PER SCENARIO NAME, not once per parse. `record <dir> --dry-run` parses each file THREE times
  // (discovery, the duplicate-target scan, the preview loop), so a 35-file corpus with no `fidelity:` —
  // the deprecation-window default, i.e. most corpora — emitted 105 copies of an 812-char notice, and
  // `--quiet` suppresses none of it. That was larger than the broken-file dump it sat next to, and it
  // fires when NOTHING is wrong. The set is process-lifetime: one warning per scenario per invocation.
  if (fidelityWasDefaulted(rawDoc) && !FIDELITY_NOTICE_SEEN.has(scenario.name)) {
    FIDELITY_NOTICE_SEEN.add(scenario.name);
    process.stderr.write(defaultedFidelityNotice(scenario.name) + "\n");
  }
  if (isFileRelative(scenario.session)) scenario.session = resolve(dirname(path), scenario.session);
  // Load-time regex validation: fail fast with a clear message rather than letting a malformed pattern
  // crash the run at evaluate() time. NOTE: CLI-supplied rules (--answer/--answer-policy) do NOT
  // pass through here — the runtime try/catch in assert.ts and decider.ts is their safety net.
  validateScenarioRegexes(scenario, path);
  return scenario;
}

/** Every nested `{ …: <regex> }` leaf in the Assertion schema, derived from zod rather than enumerated.
 *
 *  A leaf qualifies when it is a string field of a nested object whose own `.describe()` says "regex" — the
 *  same declaration the docs and JSON schema are generated from, so a new nested regex field is covered the
 *  moment it is declared. `test/nested-regex-leaves.test.ts` pins the derivation against the evaluator: every
 *  leaf `assert.ts` compiles with `compileUserRegex` must appear here, so a load-time gap cannot reopen.
 *
 *  Computed once — walking the schema per assertion per run would be pointless work on a hot path. */
/** Every nested `{ …: <regex> }` leaf in the Assertion schema.
 *
 *  It is an explicit table on purpose, after a derivation from zod internals was tried and rejected: the
 *  `.describe()` text is not reachable the same way across the src and dist builds, so the walk silently
 *  returned ZERO leaves under one of them — validation that looks present and checks nothing, which is
 *  strictly worse than the hand list it replaced.
 *
 *  What makes the table safe is not how it was written but `test/nested-regex-leaves.test.ts`, which reads
 *  `assert.ts` and fails if the evaluator compiles a nested leaf this table does not carry. The previous
 *  version of this code was a hand list of THREE under a comment claiming to cover them all, with no guard —
 *  the list was not the defect; the missing guard was.
 *
 *  A bad regex in any of these used to surface inside the evaluator, i.e. after the paid spawn. */
const NESTED_REGEX_LEAVES: [parent: keyof Assertion, child: string][] = [
  ["artifact_text", "matches"],
  ["artifact_text", "not_matches"],
  ["path_denied", "path_matches"],
  ["question_context", "matches"],
  ["question_context", "when_question"],
  ["question_options", "when_question"],
  ["skill_tool_used", "skill"],
  ["skill_tool_used", "tool"],
  ["subagent_dispatch_healthy", "type"],
  ["subagent_output_contains", "match"],
  ["task_status", "match"],
];

/** The `[label, pattern]` pairs to validate for one authored assertion. Exported for the coverage test. */
export function nestedRegexLeaves(a: Assertion): [label: string, pattern: string][] {
  const out: [string, string][] = [];
  for (const [parent, child] of NESTED_REGEX_LEAVES) {
    const holder = (a as Record<string, unknown>)[parent];
    if (holder === undefined || holder === null || typeof holder !== "object") continue;
    const v = (holder as Record<string, unknown>)[child];
    if (typeof v === "string") out.push([`${parent}.${child}`, v]);
  }
  return out;
}

/** Validate all user-supplied regex patterns in a scenario at load time. Throws on the first bad pattern. */
function validateScenarioRegexes(scenario: Scenario, scenarioPath: string): void {
  const context = `scenario "${scenario.name ?? scenarioPath}"`;
  // `replay_protocol_fidelity` is synthesized by the replay lane only — authored in a live scenario it
  // has no check() branch and always evaluates to "empty assertion". Reject it at load (loud footgun fix).
  for (const a of scenario.assert) {
    if (a.replay_protocol_fidelity !== undefined)
      throw new Error(
        `${context}: \`replay_protocol_fidelity\` is synthesized by the replay lane and cannot be authored in a scenario — remove it (it would evaluate as "empty assertion" on a live run).`,
      );
  }
  // `execution: cloud-describe` is RESERVED — no runner exists yet. An inert-but-accepted mode would be
  // the same "silently never matches" footgun the AnswerRule.superRefine block exists to prevent
  // elsewhere in this schema, so reject it loud at load time instead of silently no-opping.
  if (scenario.execution === "cloud-describe")
    throw new Error(
      `${context}: \`execution: cloud-describe\` is reserved — no runner exists yet, so authoring it is a load-time error rather than a silent no-op. Remove it (or use the default \`execution: local\`) until a cloud runner ships.`,
    );
  // `lane: remote` + a present_files-shaped assertion is incoherent by construction: that lane serves no
  // cowork MCP server, so those keys can only ever report can't-verify. Rejecting at LOAD time follows the
  // `cloud-describe` precedent above — an authored assertion that CANNOT pass should cost a config error,
  // not a paid run that fails at assertion time.
  //
  // The remedy this message offers is deliberately NOT "assert the delivery itself": the harness models no
  // remote delivery tool at all (production's is the agent-native `SendUserFile`), so there is currently
  // NOTHING on this lane to assert a delivery against. Advising it sent a consumer looking for a key that
  // does not exist. Until a remote delivery tool is served, the honest remedies are the weaker
  // path-plus-statement proxy or switching lanes — say exactly that.
  if (scenario.lane === "remote") {
    const LANE_INCOMPATIBLE = ["present_files_called", "no_scratchpad_leak", "user_visible_artifact"] as const;
    for (const a of scenario.assert)
      for (const key of LANE_INCOMPATIBLE)
        if (a[key] !== undefined)
          throw new Error(
            `${context}: \`${key}\` cannot pass on \`lane: remote\` — that lane serves no present_files and delivers nothing by location, so the key can only report "cannot verify". Tool-level delivery is NOT YET ASSERTABLE on this lane (the harness models no remote delivery tool; production uses the agent-native SendUserFile). Either assert the written path plus the agent's own statement of it (\`file_exists\` + \`transcript_matches\` — a weaker proxy, since the semantic judge cannot see tool calls), or set \`lane: local\` if this scenario models the desktop lane.`,
          );
  }
  // assert[] patterns
  for (const a of scenario.assert) {
    for (const key of [
      "transcript_matches",
      "transcript_not_matches",
      "question_asked",
      "subagent_dispatched",
      "tool_result_matches",
      "tool_result_not_matches",
      "reference_read",
      "no_observed_reference_access",
    ] as const) {
      const pattern = a[key];
      if (pattern !== undefined) {
        const c = compileUserRegex(pattern);
        if ("error" in c) throw new Error(`bad regex in ${key} in ${context}: ${c.error}`);
      }
    }
    // Nested regex leaves — DERIVED from the schema, never hand-listed. The flat `a[key]` loop above
    // reaches only top-level string keys, so every regex that lives one level down (`artifact_text.matches`,
    // `path_denied.path_matches`, `question_context.matches`, …) was compiled for the first time inside the
    // evaluator, i.e. AFTER the paid spawn. A hand list is how the previous version of this got it wrong: it
    // covered 3 of the 11 leaves while its comment claimed to cover them all.
    for (const [label, pattern] of nestedRegexLeaves(a)) {
      const c = compileUserRegex(pattern);
      if ("error" in c) throw new Error(`bad regex in ${label} in ${context}: ${c.error}`);
    }
    // (Empty / regex-ish / brace-expansion tool globs are rejected by the `toolGlob` schema in types.ts —
    // enforced on EVERY parse path including a recorded cassette's frozen asserts, not just here. )
  }
  // answers[].when_question patterns (ScriptedDecider uses these)
  for (const rule of scenario.answers) {
    if (rule.when_question !== undefined) {
      const c = compileUserRegex(rule.when_question);
      if ("error" in c) throw new Error(`bad regex in when_question in ${context}: ${c.error}`);
    }
  }
}

/** ABLATION helper: return a clone of `session` with EVERY skill/plugin discovery source emptied, so a
 *  run mounts no skill-under-test and the agent answers from its own priors. Clones (never mutates) the
 *  loaded/injected session so a matrix or repeat run reusing the object is unaffected. Model/folders/
 *  egress are preserved — only skill discovery is removed, which is what makes it a clean with-vs-without
 *  control. */
export function ablateSession<T extends { plugins: Record<string, unknown>; skills: Record<string, unknown> }>(session: T): T {
  return {
    ...session,
    plugins: { ...session.plugins, local_plugins: [], remote_plugins: [], local_marketplaces: [], marketplaces: [], enabled: [] },
    skills: { ...session.skills, local: [] },
  };
}

/** Load a session from a file and resolve its internal host paths relative to the session
 * file's own directory (see {@link resolveSessionPaths}). Exported for the matrix runner — cli.ts loads
 * the base session ONCE per matrix run, then applies per-cell overrides (applySessionOverrides,
 * session.ts) on top of the SAME loaded+resolved object, rather than re-resolving paths per cell. */
export function loadSessionFromFile(sessionRef: string): ReturnType<typeof loadSession> {
  const baseDir = sessionRef === "(inline)" ? process.cwd() : dirname(resolve(sessionRef));
  return resolveSessionPaths(loadSession(parseSessionFile(sessionRef)), baseDir);
}

/** THIS write's 1-based turn number, derived from how many prior turns are already archived. Pure — no
 *  side effects, so it can be read before the result is assembled (to stamp `RunResult.turn`). */

/** Turn-start bookkeeping for the two APPEND-THROUGH-THE-TURN streams. Must run BEFORE the resource
 *  sampler opens its file and BEFORE the agent session starts.
 *
 *  Deliberately at turn START, not post-run: the post-run path runs after `foldResources` has
 *  already read), so an archive there fixes nothing and would mislabel a two-turn file as turn 1.
 *
 *  Nothing happens on turn 1, so a single-turn run's `events.jsonl` stays BYTE-IDENTICAL — which is what
 *  keeps cassettes (whose `events` array is this file verbatim) unaffected. */
export function beginTurn(outDir: string): number {
  const turn = currentTurn(outDir);
  // Create the turn dir HERE, at turn start. The resource sampler opens
  // `turns/<N>/resources.jsonl` as soon as the run starts, but `turnWriteDir` only runs POST-run — so
  // without this every sample throws ENOENT, swallowed into a per-tick "sample failed" warning, and
  // `RunResult.resources` came back undefined on EVERY container/hostloop/microvm run. Turn-aware
  // addressing without a directory to write into is structural and nonfunctional.
  turnWriteDir(outDir, turn);
  if (turn > 1) {
    // The harness is the sole writer of events.jsonl (agent stdout is persisted only inside the session
    // read loop), so appending here cannot be preceded by any event of this turn.
    try {
      appendFileSync(join(outDir, "events.jsonl"), JSON.stringify({ _emu: "turn_start", turn }) + "\n");
    } catch {
      /* best-effort: a missing marker degrades to the fail-closed whole-file scan */
    }
    // (A legacy resources rename used to live here for pre-layout dirs; it is gone with them.) Each turn writes
    // its own `turns/<N>/resources.jsonl`, so there is nothing to rename — the scoping is structural.
    // Legacy dirs still share one root file and need it. `chat` now goes through this same `beginTurn` too,
    // but its turn is always 1 (fresh sessionId, fresh dir, never resumed — see chat.ts), so it never
    // reaches this `turn > 1` branch at all.
  }
  return turn;
}

export function currentTurn(outDir: string): number {
  // One past the highest turn that has a `run.jsonl` — see currentTurnFromDirs for why the key is the
  // transcript and not the result.
  //
  // This used to MAX that against an archive-counting "legacy rule", because a pre-layout dir resumed
  // under the new code was MIXED (turn 1 a root archive, turn 2 a turn dir) and switching on `hasTurnDirs`
  // made each rule blind to the other's turns — the number went BACKWARDS on the next resume, overwriting
  // a completed turn. That union is gone with the legacy layer: a pre-layout dir is now refused at
  // dir-open, so no mixed dir can reach here and there is only one rule to apply.
  return currentTurnFromDirs(outDir);
}

/** the harness-observability JSONL — lifecycle + decisions(by) + subagents + egress + cost. `turn` is
 *  computed once by the caller (via {@link currentTurn}) so it matches `result.json`'s. */
function writeRunJsonl(
  outDir: string,
  scenario: Scenario,
  fidelity: string,
  rec: RunRecord,
  egress: RunResult["egress"],
  secrets: string[],
  turn: number,
) {
  const lines = [
    { t: "run", scenario: scenario.name, fidelity, runId: rec.runId, result: rec.result, cwd: rec.cwd, turn },
    { t: "init", tools: rec.initTools.length },
    ...rec.decisions.map((d) => ({ t: "decision", ...d })),
    ...rec.subagents.map((s) => ({ t: "subagent", ...s })),
    ...rec.unanswered.map((u) => ({ t: "unanswered", ...u })),
    ...rec.gateDeliveries.map((g) => ({ t: "gate_delivery", ...g })),
    ...egress.map((e) => ({ t: "egress", ...e })),
    { t: "transcript", text: rec.transcript },
    { t: "tool_counts", counts: rec.toolCounts },
    { t: "cost", usage: rec.usage, metrics: rec.cost },
  ];
  writeFileSync(join(outDir, "run.jsonl"), scrub(lines.map((l) => JSON.stringify(l)).join("\n"), secrets));
}

/** Assemble a RunResult for a run that did NOT complete — it exited on an unanswered gate. The work the
 *  agent did before the whiff (artifacts on disk, the partial transcript, decisions/tool counts so far) is
 *  salvaged so the paid run is still inspectable instead of vanishing. Deliberately reduced: no assertion
 *  outcome (a partial run has none — `assertions: []`) and no capability-probe fields (those would need a
 *  probe we skip). It DOES still carry a `verdict` — `result:"error"` on the unanswered gate is itself a
 *  hard fail, computed and stored at the end of this function (see the comment there). `partial:true` is
 *  the signal that lets consumers (verify-run, scaffold, the footer) refuse to read its populated
 *  `artifacts[]` as a passing run. */
export function buildPartialResult(args: {
  /** This turn's 1-based number (multi-turn attribution); undefined for callers that don't track it. */
  turn?: number;
  /** True when this partial run was ablated (--ablate-skill). */
  ablated?: boolean;
  scenarioName: string;
  /** The scenario's declared Cowork lane — see `Scenario.lane`. Absent ⇒ local. */
  lane?: "local" | "remote";
  prompt: string;
  fidelity: string;
  baseline: string;
  record: RunRecord;
  outDir: string;
  workRoot: string;
  configDir: string;
  /** This run's session ID — needed (microvm tier only) to derive the per-session VM_WORK_HOST subtree
   *  for the sub-agent reasoning capture (see `resolveSubagentConfigRoot`'s doc comment). Optional so
   *  pre-existing callers (e.g. tests exercising non-microvm tiers) still compile without it; the real
   *  `executeScenario` call site always passes it. Omitting it on a microvm partial just leaves
   *  `reasoning` absent for that salvage run, same as any other capture-unavailable case. */
  sessionId?: string;
  pluginSkillRoots: PluginSkillRoot[];
  userVisibleRoots: string[];
  readonlyFolderRoots: string[];
  effectiveFidelity: string;
  egress: { host: string; decision: "allow" | "deny" }[];
  durationMs: number;
  unanswered: { message: string; hint?: string };
  /** The model the scenario/session pinned, if any — threaded in so a salvaged run reports the same model
   *  provenance a complete one does. Undefined means nothing pinned it (modelSource "unresolved"). */
  pinnedModel?: string;
  fingerprint?: RunResult["fingerprint"];
  /** Run-identity metadata — threaded from `executeScenario` so a salvaged PARTIAL run is still a labeled,
   *  identifiable generation (same basis as the success path). See RunResult.runLabel/skillCommit. */
  runLabel?: string;
  skillCommit?: string | null;
  /** Same three signals the success-path result derives `nonDeterministic`/`nonDeterministicTerminal`
   *  from (see the `assembleRunResult` call below in `executeScenario`). Optional so pre-existing
   *  callers that don't pass them (e.g. tests) still compile — they just get the decisions-only
   *  derivation (record.decisions.some(...)), not the previous hardcoded `undefined`. */
  onUnanswered?: OnUnanswered;
  nonDeterministicHint?: boolean;
  externalChannel?: boolean;
}): RunResult {
  const { record } = args;
  const gp = summarizeGateProvenance(record.decisions);
  // Same derivation the success path uses (see the `assembleRunResult` call in `executeScenario`) — a
  // gate-caused partial run still reports whether EARLIER gates (before the whiff) were answered
  // non-deterministically, instead of erasing that signal to `undefined`.
  const nonDeterministic =
    record.decisions.some((d) => d.by === "llm" || d.by === "external" || d.by === "human" || d.by === "first") ||
    !!args.nonDeterministicHint;
  const nonDeterministicTerminal = args.onUnanswered === "llm" || args.onUnanswered === "prompt" || !!args.externalChannel;
  const timelineData = readTimeline(args.outDir);
  if (timelineData && (timelineData.malformedLines > 0 || timelineData.headerCorrupt))
    warn(
      `::warning:: [timeline] ${timelineData.malformedLines} malformed line(s) in timeline.jsonl — skill-activity/tool-duration telemetry is incomplete, treated as unavailable\n`,
    );
  // Partially-corrupt timeline → incomplete fold; treat as unavailable (see the #35 note on the live path). #35
  const timelineEvents = timelineData && timelineData.malformedLines === 0 && !timelineData.headerCorrupt ? timelineData.events : undefined;
  // Context/Connectors panel: the SPINE is the id-only list run.ts's init handler already seeded
  // (authoritative — covers plugin/marketplace skills). Enrich with whenToUse read off disk across both
  // delivery trees. Own wiring, independent of executeScenario's (this function's own args.configDir /
  // args.pluginSkillRoots).
  const availableSkillIds = args.record.context?.availableSkills?.map((s) => s.id) ?? [];
  args.record.context = {
    ...args.record.context,
    availableSkills: resolveAvailableSkills(availableSkillIds, args.configDir, args.pluginSkillRoots),
  };
  // Working folder panel's file model — same walk `artifacts` below derives from. #52/#54: a missing
  // workspace root (microvm partial: outputs stage into the VM work tree, not outDir) OR a nested unreadable
  // subtree records UNAVAILABLE (undefined) via the shared `trustedWorkspaceFiles` gate — never a false
  // empty/partial [] — same honest marker as the success path above.
  const wfHealth = classifyWorkspaceFilesWithHealth(args.workRoot, args.userVisibleRoots, args.readonlyFolderRoots, {
    scratchpadRoot: args.workRoot.endsWith(`${sep}mnt`) ? dirname(args.workRoot) : undefined,
  });
  if (!wfHealth.rootAbsent && !wfHealth.walkComplete)
    warn(
      `::warning:: [artifacts] workspace walk incomplete — ${wfHealth.walkErrors.length} unreadable subtree(s) ` +
        `[${wfHealth.walkErrors.map((e) => `${e.path} (${e.error})`).join(", ")}]. Recording workspaceFiles/artifacts as ` +
        `UNAVAILABLE (undefined), not a partial list (#54).\n`,
    );
  const workspaceFiles = trustedWorkspaceFiles(wfHealth);
  const built = assembleRunResult({
    $schema: RUN_RESULT_SCHEMA_URL,
    generator: "cowork-harness",
    mode: "run",
    command: undefined, // #48: reconstruction lane — the originating command isn't in `args`; reindex falls back to the prior index row
    lane: args.lane, // the scenario's declared Cowork lane, threaded so a salvaged partial keeps its contract
    scratchpadEvidenceComplete: scratchpadEvidenceComplete(wfHealth),
    runLabel: args.runLabel, // run-identity: threaded through so a salvaged partial keeps its generation label
    skillCommit: args.skillCommit,
    turn: args.turn,
    ablated: args.ablated || undefined,
    referencesRead: args.record.filesRead.length ? args.record.filesRead : undefined,
    referencesAccessed: args.record.referencesAccessed,
    finalMessage: args.record.resultText,
    execution: { location: "local" }, // live local run (salvaged partial) — same basis as the success path
    scenario: args.scenarioName,
    prompt: args.prompt,
    fidelity: args.fidelity,
    baseline: args.baseline,
    result: "error",
    partial: true,
    unansweredGate: { message: args.unanswered.message, ...(args.unanswered.hint ? { hint: args.unanswered.hint } : {}) },
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
    toolDurations: timelineEvents ? foldToolDurations(timelineEvents) : undefined,
    skillActivity: timelineEvents ? foldSkillActivity(timelineEvents) : undefined,
    models: record.models.length ? record.models : undefined,
    ...deriveModelProvenance(args.pinnedModel, record.models.length ? record.models : undefined, record.modelFallbacks),
    thinking: record.thinking.length ? record.thinking : undefined,
    thinkingElided: record.thinkingElided,
    toolErrors: record.toolErrors,
    modelUsage: record.modelUsage,
    redundantToolCalls: record.redundantToolCalls,
    tasks: Array.from(record.tasks.values()),
    // mcpServers is unknown[] on the RunRecord (verbatim from the SDK's init event) but RunResult
    // documents its loose per-server shape ({name, status?, ...}) for consumers — cast, not a
    // transformation; the underlying array is passed through unchanged.
    context: record.context as RunResult["context"],
    gateDeliveries: record.gateDeliveries,
    egress: args.egress,
    assertions: [],
    toolResults: record.toolResults,
    subagents: timelineEvents ? attributeSubagentSkills(record.subagents, timelineEvents) : record.subagents,
    nonReproducibleAnswers: record.unanswered,
    usage: record.usage,
    cost: record.cost,
    skillsInvoked: record.skillsInvoked,
    skillToolAvailable: record.initTools.includes("Skill"),
    durationMs: args.durationMs,
    outDir: args.outDir,
    workDir: args.workRoot,
    outputsDir: join(args.workRoot, "outputs"),
    userVisibleRoots: args.userVisibleRoots,
    readonlyFolderRoots: args.readonlyFolderRoots,
    // artifacts is a DERIVED VIEW of workspaceFiles — same collectArtifacts walk,
    // filtered to the deliverable classes (excludes class:"input" read-only mounts). No second walk.
    artifacts: workspaceFiles?.filter((f) => f.class === "output" || f.class === "mount").map((f) => ({ path: f.path, bytes: f.bytes })),
    workspaceFiles, // Working folder panel's canonical file model
    contextEvents: record.contextEvents, // system events we don't special-case — powers compaction_occurred
    mcpErrors: record.mcpErrors, // uncollapsed — an empty [] is the real "no MCP errors" signal no_mcp_error needs
    hookEvents: record.hookEvents, // uncollapsed — an empty [] on a no-Task scenario is the real "nothing hook-blocked" signal no_hook_blocked needs
    fileToolAttempts: record.fileToolAttempts, // uncollapsed — content-class, same as toolResults/decisions above
    pathDenials: record.pathDenials, // uncollapsed — content-class, same as fileToolAttempts above
    presentedFiles: record.presentedFiles, // uncollapsed — an empty [] is the real "nothing presented" signal no_scratchpad_leak's vacuous pass needs
    presentFilesCalls: record.presentFilesCalls,
    preRunPaths: readPreRunManifest(args.outDir),
    preRunLinkAware: readPreRunManifestLinkAware(args.outDir),
    preRunHashes: readPreRunManifestHashes(args.outDir),
    preRunOrigin: readPreRunManifestOrigin(args.outDir),
    effectiveFidelity: args.effectiveFidelity,
    gateProvenance: gp.total ? gp : undefined,
    fingerprint: args.fingerprint,
    errorSource: record.errorSource, // finer error-event source, alongside the coarse resultErrorKind
    resultSubtype: record.resultSubtype, // SDK result subtype pass-through (error_max_turns / …)
    stderrLogPath: join(args.outDir, "agent.stderr.log"), // always written by the live agent process
    resources: foldResources(args.outDir, args.effectiveFidelity, resolveIntervalMs(), undefined, args.turn),
    // Fields this lane deliberately never sets (per this function's own doc comment: "no capability
    // probe fields") — now explicit instead of implicit:
    resultErrorKind: undefined,
    stalledOnQuestion: undefined,
    capabilityProbe: undefined,
    requiresCapabilityUnmet: undefined,
    // Derived above from the same decision log / policy the success path uses — NOT hardcoded to
    // undefined: a gate-caused partial run still reports whether earlier gates were non-deterministic.
    nonDeterministic,
    nonDeterministicTerminal,
    permissiveAutoAllow: undefined,
    scan: undefined,
    fidelityWarnings: undefined,
    l0HostConfigContamination: undefined,
    missingCapabilityUse: undefined,
    staleness: undefined,
    mutation: undefined, // replay --mutate only
    skippedAssertions: undefined,
    outcome: undefined, // stamped alongside the verdict just below (derived from it)
    verdict: undefined, // computed just below (after every other field is assembled) and stored — see the comment there
  });
  // Same sub-agent reasoning capture the success path runs (see resolveSubagentConfigRoot's doc
  // comment) — a salvaged partial run is still LIVE, and a dispatch may have completed (and thought)
  // before the gate that ended the run. Silent no-op on a tier with no child transcript, or a capture
  // failure.
  const subagentConfigRoot = resolveSubagentConfigRoot(args.effectiveFidelity, {
    configDir: args.configDir,
    workRoot: args.workRoot,
    sessionId: args.sessionId,
  });
  if (subagentConfigRoot) captureSubagentReasoning(subagentConfigRoot, built.subagents);

  // A partial run still has a verdict — it failed on the unanswered gate (`result:"error"`), not on an
  // assertion (there are none to evaluate here). Compute it from the just-assembled object (computeVerdict
  // reads result.assertions/unansweredGate/etc. off it) and store the result, same as the success path above.
  built.verdict = computeVerdict(built, "live");
  built.outcome = deriveOutcome(built);
  return built;
}

/** the structured run trace. */

export function writeTrace(outDir: string, rec: RunRecord, egress: RunResult["egress"], secrets: string[], durationMs?: number) {
  const trace = {
    steps: [...rec.toolsCalled],
    toolCounts: rec.toolCounts, // truthful per-tool call counts (host-routed WebSearch shows here, not usage.server_tool_use)
    questions: rec.questions,
    subagents: rec.subagents,
    gateDeliveries: rec.gateDeliveries, // per-gate answer delivery
    egress,
    decisions: rec.decisions,
    durationMs,
    cost: rec.cost ?? rec.usage ?? null, // cost comes from api_metrics/usage, not just `result`
  };
  writeFileSync(join(outDir, "trace.json"), scrub(JSON.stringify(trace, null, 2), secrets));
}

function scrubFileInPlace(path: string, secrets: string[]) {
  if (!secrets.length) return;
  try {
    const content = readFileSync(path, "utf8");
    const scrubbed = scrub(content, secrets);
    if (scrubbed !== content) writeFileSync(path, scrubbed);
  } catch {
    /* file may not exist (e.g. no control-out at protocol fidelity) */
  }
}

/** Scrub the raw streamed run logs in place: events.jsonl, control-out.jsonl, agent.stderr.log
 *  (timeline.jsonl is deliberately not scrubbed — it carries tool names/durations only). Called from
 *  executeScenario's outermost `finally` (and the chat lane's teardown) so every exit path AFTER the
 *  agent session exists scrubs — success, the unanswered-gate salvage rethrow, and any rethrown fault
 *  (agent crash, infra error, hostloop snapshot failure). Deliberately NOT total coverage: a throw
 *  before that try has no raw logs yet, and a SIGKILL of the harness process skips any finally. #60: the
 *  agent.stderr.log sink IS now flushed before this runs — `LiveAgentSession` pipes it with `{ end: false }`
 *  and ends+awaits it in `start()`'s drain, so no buffered stderr byte lands raw after the scrub reads the
 *  file (the session generator resolves only after that flush, and this runs after it resolves). Exported
 *  for tests. */
export function scrubRawRunLogs(outDir: string, secrets: string[]): void {
  scrubFileInPlace(join(outDir, "events.jsonl"), secrets);
  scrubFileInPlace(join(outDir, "control-out.jsonl"), secrets);
  scrubFileInPlace(join(outDir, "agent.stderr.log"), secrets);
}

/**
 * detect a host filesystem path leaking into agent-visible text. The original regex was
 * macOS-centric (`/Users/`, `/opt/cowork/`) and false-passed `transcript_no_host_path` on Linux CI
 * where host paths are under `/home/` or `/root/`.
 *
 * Anchoring: each host root is preceded by a boundary char `(^|[\s"'(=:])` — start-of-string or a
 * whitespace/quote/paren/equals/colon — to limit false positives (e.g. a substring like
 * `whatever/home/x` won't match, only a path-like `/home/...`). The legitimate in-VM path
 * `/sessions/<id>/mnt/...` is NOT a host root, and the in-VM HOME is `/tmp`, so `/home/`//`/root/`
 * do not normally appear there.
 *
 * The boundary also allows a `file://[authority]` prefix so file-URI leaks are caught: in
 * `file:///Users/alice` the char before `/Users/` is the path's own `/`, which is NOT in the class,
 * so the bare anchor would miss it. `file:\/\/[^\s\/]*` consumes the optional authority (empty or a
 * host like `localhost`) and lets the path root match. URL-encoded (`%2FUsers`) and backslash
 * (`file:\\host\Users`) forms ARE now covered (see the decode+normalize pass in the body); the Windows
 * `file:///C:/Users/` form is caught incidentally via the drive-letter `:` boundary.
 */
export function hostPathLeaked(text: string): boolean {
  // macOS temp/volume roots are host paths too: `/var/folders/…` (the OS temp dir, and the realpath
  // target of `/private/var/…`) and `/Volumes/…` (mounted disks). `/tmp` is deliberately NOT here — it is
  // the in-VM HOME, so it legitimately appears in agent-visible text and would false-positive.
  const re = /(^|[\s"'(=:]|file:\/\/[^\s\/]*)(\/Users\/|\/opt\/cowork\/|\/home\/|\/root\/|\/private\/var\/|\/var\/folders\/|\/Volumes\/)/;
  if (re.test(text)) return true;
  // also catch URL-encoded (%2FUsers%2F) and backslash (file:\\host\Users) forms by testing a
  // decoded + backslash-normalized copy. Decode each `%`-escape RUN independently rather than the
  // whole string: decodeURIComponent over the entire text throws on ANY stray `%` (e.g. `build 100%
  // done`), which would silently disable the encoded re-test even when a genuine `%2Fhome%2Fvictim`
  // is also present. An undecodable run is left verbatim.
  const decoded = text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => {
    try {
      return decodeURIComponent(m);
    } catch {
      return m;
    }
  });
  const normalized = decoded.replace(/\\/g, "/");
  return normalized !== text && re.test(normalized);
}

// Operations that UNLINK a name. Scoped to match the real product's enforcement, which was measured
// directly against the outputs mount with raw syscalls (not shell commands, which mask the syscall
// behind fallbacks): `unlink` and `rmdir` fail EPERM; every other operation succeeds, including
// content destruction and renames. So the token set here is deliberately NARROW.
//
// Deliberately NOT delete tokens, because the product permits them:
//   - `truncate -s 0 f` / `open(f,"w")` / a statement-leading `> f` — these EMPTY a file without
//     unlinking it. Verified permitted. (They were flagged here previously, which made the harness
//     STRICTER than the product it emulates — the reverse of a sandbox-escape risk, but still an
//     infidelity, and a large false-positive source since `truncate` is ordinary prose in a comment.)
//   - `shred f` WITHOUT `-u`/`--remove` — overwrites in place, never unlinks. `shred -u` does unlink,
//     so it stays a delete and needs the flag shape to be told apart.
//   - `mv` within outputs, and `mv` onto an existing destination — both permitted; `mv` direction is
//     handled separately by `mvDeletesOutputs` (a move OUT of outputs fails, so it stays flagged).
// A skill that empties a deliverable is a content bug, catchable with content assertions — not a
// containment violation, and asserting it here would red runs the real product would allow.
const DELETE_TOKEN =
  /\b(rm|unlink|rmdir)\b|\bshred\b[^\n;|&]*[ \t](?:-[a-zA-Z]*u\b|--remove\b)|\bfind\b[^\n]*-delete\b|\bos\.(remove|unlink|rmdir)\b|\bshutil\.rmtree\b|\.unlink\(/;
/** Per-mount matchers. Production denies `unlink`/`rmdir` on EVERY writable Cowork FUSE mount, not just
 *  `outputs` — a connected folder shows the identical default, and approval is strictly per-mount. So the
 *  three matchers below are built per mount NAME rather than hardcoding the literal `outputs`.
 *
 *  The mount name is regex-escaped: names come from user-connected folder basenames and can contain `.`,
 *  `+`, `(` and friends. The right boundary `(?![\w.])` is kept exactly as-is and is correct for dotted
 *  names in BOTH directions: for a mount `v1.2`, `v1.2/x` matches (next char `/`) while `v1.2.3` does not
 *  (next char `.`, a different path); for a mount `data`, `data.json` correctly does not match. */
type MountMatchers = { touches: RegExp; under: RegExp; cdInto: RegExp };
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const MOUNT_MATCHERS = new Map<string, MountMatchers>();
function mountMatchers(name: string): MountMatchers {
  const hit = MOUNT_MATCHERS.get(name);
  if (hit) return hit;
  const n = escapeRe(name);
  const m: MountMatchers = {
    // MENTIONED as a path segment — broad, used for the conservative rm co-occurrence + ambiguous-mv
    // branch. The negative lookahead avoids `outputs.txt` / `myoutputs`.
    touches: new RegExp(`(^|[\\s"'\`(/])(mnt/)?${n}(?![\\w.])`),
    // A real path COMPONENT (preceded by start/`/`, followed by `/` or end) — used for mv direction so a
    // dst like `/tmp/outputs-backup` is NOT mistaken for being inside outputs/.
    under: new RegExp(`(^|/)(mnt/)?${n}(/|$)`),
    cdInto: new RegExp(`\\b(cd|pushd)\\s+["']?(mnt/)?${n}(?![\\w.])`),
  };
  MOUNT_MATCHERS.set(name, m);
  return m;
}

/** Default safe-staging prefixes, always active. Real Cowork denies an outputs-delete STRUCTURALLY at the
 *  resolved target's mount — outputs is a FUSE mount that fails `unlink`/`rmdir` with EPERM — a delete whose target
 *  provably lands under `/tmp` (or the literal, unexpanded `$TMPDIR`/`${TMPDIR}` idiom) is genuinely never
 *  an outputs delete in production, so treating it as scratch here is MORE faithful, not less safe. (Prior
 *  rationale for leaving this opt-in — "`/tmp` is NOT assumed scratch" — predated that binary finding.) */
function defaultSafePrefixes(): string[] {
  return ["/tmp/", "$TMPDIR/", "${TMPDIR}/"];
}

/** Additional operator-configured safe-staging prefixes, unioned with `defaultSafePrefixes()`. Set
 *  COWORK_HARNESS_SAFE_STAGING_PREFIX to a comma-separated list to extend rm-suppression to other
 *  provably-scratch prefixes (e.g. a skill's own `/scratch` convention). */
function safePrefixes(): string[] {
  return (process.env.COWORK_HARNESS_SAFE_STAGING_PREFIX ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => (p.endsWith("/") ? p : p + "/"));
}

/** Collapse bash backslash-newline line continuations (`\` immediately followed by a newline, plus any
 *  following indentation) into a single space, so a line-wrapped statement is one logical line before any
 *  splitting/scanning happens. Without this, `splitStatements` (which splits on bare `\n`) shreds a
 *  line-continued `mv \` / `outputs/a.txt \` / `/tmp/b.txt` into fragments too small for `mvDeletesOutputs`
 *  to see both operands — an UNDER-detection (false negative), not a false positive. Applied inside
 *  `expandSimpleVars` (the single entry point both the mv scan and the rm scan run through) so every caller
 *  gets joined statements for free. */
function joinLineContinuations(cmd: string): string {
  return cmd.replace(/\\\r?\n[ \t]*/g, " ");
}

/** Drop whole-line `#` comments, so prose can never be read as an executable delete. `splitStatements`
 *  is quote-blind, so the body of a `python3 -c "…"` / `perl -e '…'` program string is shredded into
 *  pseudo-statements and scanned as shell — which turned an English comment mentioning a delete word
 *  into "evidence" of a delete. A `#`-leading line is non-executable in sh AND is a comment in
 *  python/perl/awk/ruby, i.e. every `-c`/`-e` context the splitter shreds, so dropping it cannot hide a
 *  real command.
 *
 *  MUST run BEFORE `joinLineContinuations`, and must be continuation-aware, because the two interact in
 *  both directions:
 *    `# note \` + `rm outputs/x`  — bash does NOT treat a backslash inside a comment as a continuation;
 *        the comment ends at the newline and the `rm` RUNS. Joining first would fuse them into one
 *        `#`-leading pseudo-statement and drop the real delete — a false negative.
 *    `rm \` + `# outputs/x`       — here the backslash DOES continue, so `# outputs/x` is an argument to
 *        `rm`, not a comment, and the delete is real. Hence a `#` line is only dropped when the previous
 *        kept line did not end in a continuation. */
function stripCommentLines(cmd: string): string {
  const kept: string[] = [];
  let prevContinues = false;
  for (const line of cmd.split(/\r?\n/)) {
    if (/^[ \t]*#/.test(line) && !prevContinues) {
      prevContinues = false; // a comment ends the logical line; the next line starts fresh
      continue;
    }
    kept.push(line);
    prevContinues = /\\$/.test(line);
  }
  return kept.join("\n");
}

/** Substitute simple `NAME=VALUE` assignments into later `$NAME`/`${NAME}` uses. Conservative: skips
 *  command-substituted values (`$(...)`/backticks) so an unresolved indirect target is never treated as
 *  resolved (and therefore never "provably safe"). */
function expandSimpleVars(rawCmd: string): string {
  const cmd = joinLineContinuations(rawCmd);
  const vars = new Map<string, string>();
  const assign = /(^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s;&|]+)/g;
  const record = (part: string): void => {
    assign.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = assign.exec(part))) {
      const v = m[3].replace(/^['"]|['"]$/g, "");
      if (/\$\(|`/.test(v)) continue;
      vars.set(m[2], v);
    }
  };
  const expand = (part: string): string => {
    let s = part;
    // `() => v` (function replacer) inserts the value literally — a raw `String.replace` string would
    // treat `$&`/`$1` in an agent-controlled value as special and corrupt the expansion.
    for (const [k, v] of vars) s = s.replace(new RegExp(`\\$\\{${k}\\}|\\$${k}\\b`, "g"), () => v);
    return s;
  };
  // Expand in SOURCE ORDER so a later reassignment cannot retroactively change an earlier `$NAME`
  // use (`D=outputs; rm "$D/x"; D=/sandbox` must expand the rm to `outputs/x`, not `/sandbox/x`).
  // Capturing-split keeps the separators verbatim, so concatenation round-trips byte-identically.
  // Each segment is expanded against the vars known so far, then its OWN assignments are recorded
  // from the ORIGINAL (un-expanded) text — preserving the single-pass, non-chaining semantics.
  const parts = cmd.split(/(\n|;|&&|\|\|)/);
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      out += parts[i]; // separator — emit verbatim
      continue;
    }
    out += expand(parts[i]);
    record(parts[i]);
  }
  return out;
}

const MKTEMP_ASSIGN = /(^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)=\$\(\s*mktemp\b([^)]*)\)/g;
const ANY_ASSIGN = /(^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)=/g;
const MKTEMP_SAFE_PLACEHOLDER = "/tmp/.mktemp-safe";

/** True when a `mktemp` invocation's argument string DIRECTS the created file/dir at a specific directory
 *  rather than letting it fall under the system temp dir: `-p DIR` / `-pDIR`, `--tmpdir` / `--tmpdir=DIR`,
 *  or a positional TEMPLATE argument containing a `/` (e.g. `mktemp mnt/outputs/tmp.XXXXXX`). Any of these
 *  means the resulting path is NOT provably under `/tmp` — `mktemp -p mnt/outputs`, `mktemp
 *  --tmpdir=mnt/outputs xx.XXXX`, and `mktemp mnt/outputs/tmp.XXXXXX` can all place the file inside
 *  outputs. Lightweight whitespace tokenizer (consistent with `nonFlagArgs` elsewhere in this file) — never
 *  under-detects a dir-directing arg, which is what matters for the "prefer false positive" invariant. */
function mktempIsDirDirected(args: string): boolean {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  for (const t of tokens) {
    if (t === "-p" || t.startsWith("-p") /* combined -pDIR */) return true;
    if (t === "--tmpdir" || t.startsWith("--tmpdir=")) return true;
    if (!t.startsWith("-") && t.includes("/")) return true; // positional TEMPLATE naming a directory
  }
  return false;
}

/** A NARROW, separate pass (run AFTER `expandSimpleVars`, which deliberately SKIPS `$(...)`-valued
 *  assignments as unresolved): recognizes the `VAR=$(mktemp …)` idiom — a `$(...)` value, but one that is
 *  known by construction to always resolve under the system temp directory — and substitutes later
 *  `$VAR`/`${VAR}` uses with a literal `/tmp`-scoped placeholder so the target-safety check in
 *  `isOutputsDelete` treats them as provably outside outputs. Only applies when the mktemp call has NO
 *  directory-directing argument (see `mktempIsDirDirected`); `mktemp -p mnt/outputs`, `mktemp
 *  --tmpdir=mnt/outputs …`, and `mktemp mnt/outputs/tmp.XXXXXX` can all place the created path inside
 *  outputs, so those are deliberately left UNRESOLVED rather than marked safe — an unresolved `$VAR` is
 *  never "provably safe" downstream, so the later `rm "$VAR"` still flags (matches "prefer a false
 *  positive over a false negative"). Source-order aware, mirroring `expandSimpleVars`'s non-retroactive
 *  semantics: a later reassignment of VAR to anything else (mktemp or not) removes the safe marking for
 *  subsequent uses within that same reassignment, then re-establishes it only if the NEW assignment is
 *  itself a directory-free `mktemp` call. */
function resolveMktempVars(cmd: string): string {
  const safeVars = new Set<string>();
  const parts = cmd.split(/(\n|;|&&|\|\|)/);
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      out += parts[i];
      continue;
    }
    let part = parts[i];
    for (const v of safeVars) {
      part = part.replace(new RegExp(`\\$\\{${v}\\}|\\$${v}\\b`, "g"), () => MKTEMP_SAFE_PLACEHOLDER);
    }
    MKTEMP_ASSIGN.lastIndex = 0;
    const mktempHere = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = MKTEMP_ASSIGN.exec(part))) if (!mktempIsDirDirected(m[3])) mktempHere.add(m[2]);
    ANY_ASSIGN.lastIndex = 0;
    while ((m = ANY_ASSIGN.exec(part))) {
      if (mktempHere.has(m[2])) safeVars.add(m[2]);
      else safeVars.delete(m[2]);
    }
    out += part;
  }
  return out;
}

function splitStatements(cmd: string): string[] {
  return cmd
    .split(/\n|;|&&|\|\|/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Non-flag argument tokens of a statement (lightweight word split — NOT a full shell tokenizer; a quoted
 *  path with spaces mis-splits toward MORE matches, never fewer, so it cannot cause a false negative). */
function nonFlagArgs(stmt: string): string[] {
  return stmt
    .split(/\s+/)
    .slice(1)
    .filter((t) => t && !t.startsWith("-"))
    .map((t) => t.replace(/^['"]|['"]$/g, ""));
}

/** An `mv` statement is a delete-from-outputs when it moves a file OUT of outputs (src UNDER outputs, dst
 *  NOT under outputs). Moving INTO outputs is not a delete. Ambiguous mv (`-t`/`--target-directory`, ≠2
 *  operands) → flag only if it mentions outputs (conservative — never a false negative). */
function mvDeletesOutputs(stmt: string, mm: MountMatchers): boolean {
  if (!/\bmv\b/.test(stmt)) return false;
  if (/(^|\s)(-t|--target-directory)\b/.test(stmt)) return mm.touches.test(stmt);
  const ops = nonFlagArgs(stmt);
  if (ops.length < 2) return mm.touches.test(stmt);
  // N-ary `mv src… dst`: the last operand is the destination, the rest are sources. A delete-from-
  // outputs is when some source is UNDER outputs and the destination is NOT (reduces to the src/dst
  // logic at length 2). `mv a.pdf b.pdf outputs/` (moving INTO outputs) is therefore not a delete.
  const dst = ops[ops.length - 1];
  const sources = ops.slice(0, -1);
  return sources.some((src) => mm.under.test(src)) && !mm.under.test(dst);
}

/**
 * A bash command deletes in outputs when (a) an `mv` moves a file OUT of outputs, or (b) an unlinking
 * delete (`rm/unlink/rmdir`, `shred -u`, `find … -delete`, python os.remove/unlink/rmdir/shutil.rmtree,
 * pathlib `.unlink()`) targets something under outputs. Emptying a file in place is NOT a delete — see
 * DELETE_TOKEN for which operations the real product permits and why. mv-direction is always evaluated (fixes the
 * move-INTO false positive without losing the move-OUT true positive). For the rm family this mirrors real
 * Cowork's own enforcement, which is STRUCTURAL (a delete syscall's resolved target's mount), not
 * command-text co-occurrence: BY DEFAULT, each rm-family delete statement's own target(s) are inspected —
 * a delete is suppressed only when EVERY target is provably outside outputs (an absolute/relative path not
 * under outputs, or a path under a safe prefix: `/tmp/`, the literal `$TMPDIR`/`${TMPDIR}` idiom, a
 * `VAR=$(mktemp …)`-sourced `$VAR`, or an operator-configured COWORK_HARNESS_SAFE_STAGING_PREFIX entry).
 * Unresolved/command-substituted targets (other than the recognized `mktemp` idiom) are never "provably
 * safe" — the guiding invariant is "prefer a false positive over a false negative when a target is
 * genuinely unprovable", so those, and a delete statement that itself names outputs, still flag. Pure +
 * exported so the rule is directly unit-testable. RESIDUAL GAP: a delete via a script file / renamed binary
 * / non-bash tool still evades this post-hoc scan — real enforcement is the deferred FUSE/MCP sub-project.
 * Also out of scope: the harness has no counterpart to production's `allow_cowork_file_delete` escalation
 * tool (a sub-agent that hits a real outputs-delete EPERM should call that, not silently fail) — this scan
 * only feeds the `no_delete_in_outputs` assertion, it never blocks execution.
 */
/** The SECOND outputs-delete detector: a pre/post path diff, independent of the command scanner.
 *  Any path the pre-run manifest recorded under `outputs/` that is absent from the post-run walk is
 *  reported as removed — regardless of HOW it went, which is the point: this one sees a delete via a
 *  script file, a renamed binary, or any non-bash tool that `scanEvents` structurally cannot.
 *
 *  Pure and exported so its semantics are testable without an agent run; `executeScenario` supplies the
 *  two walks. Both inputs are workRoot-relative paths.
 *
 *  A vanished PATH is not the same as a deletion. Production permits a rename WITHIN outputs (measured:
 *  only `unlink`/`rmdir` fail EPERM; renames succeed), so treating "this path is gone" as a delete would
 *  be stricter than the product — the same defect the command scanner had. The predicate is therefore:
 *  absent post-run AND its content does not reappear at a path that is NEW under outputs.
 *
 *  "New" is load-bearing. Matching content anywhere would let an unrelated pre-existing file with
 *  identical bytes mask a real delete; only a path that did not exist before can be the rename's
 *  destination.
 *
 *  Overwrite and truncate never reach the rename check at all — the path is still present, so it is
 *  never a candidate. That matters because in-place rewriting is the most common thing a skill does.
 *
 *  Hashing is LAZY: with no vanished paths (the overwhelmingly common case) `hashPostPath` is never
 *  called. Fail-safe throughout — a missing pre-run hash, an unhashable candidate, or absent hashing
 *  support all fall back to reporting the removal, because a rename cannot then be proven.
 *
 *  Residual, accepted: a rename FOLLOWED BY a content edit (`mv a b && echo x >> b`) leaves no matching
 *  content, so it still reports. Production permits that sequence, so this stays marginally strict —
 *  narrow, and it errs toward flagging rather than missing a delete. */
export function outputsRemovedByFsDiff(
  preRunPaths: string[],
  postOutputsPaths: string[],
  opts?: { preRunHashes?: Record<string, string | null>; hashPostPath?: (relPath: string) => string | null },
): string[] {
  const post = new Set(postOutputsPaths);
  const preOutputs = preRunPaths.filter((p) => p === "outputs" || p.startsWith("outputs/"));
  const vanished = preOutputs.filter((p) => !post.has(p));
  const say = (p: string): string => `[fs-diff] output file removed post-run: ${p}`;
  if (vanished.length === 0) return [];
  const { preRunHashes, hashPostPath } = opts ?? {};
  if (!preRunHashes || !hashPostPath) return vanished.map(say); // can't prove a rename ⇒ report

  // Only paths that did NOT exist pre-run can be a rename destination.
  const preSet = new Set(preOutputs);
  const newContent = new Set<string>();
  for (const p of postOutputsPaths) {
    if (preSet.has(p)) continue;
    const h = hashPostPath(p);
    if (h) newContent.add(h);
  }
  return vanished.filter((p) => !(preRunHashes[p] && newContent.has(preRunHashes[p] as string))).map(say);
}

/** Which of `mounts` a command deletes in. Same logic per mount as the original outputs-only detector —
 *  `detectMountDeletes(cmd, ["outputs"])` is byte-equivalent to the old `isOutputsDelete(cmd)`, pinned by
 *  test. Returns the matching mount NAMES so a finding can say which mount, since production's approval
 *  is per-mount and a caller needs to distinguish `outputs` from a connected folder. */
export function detectMountDeletes(cmd: string, mounts: string[]): string[] {
  // TWO views on purpose. `expanded` keeps comments and is used ONLY for the co-occurrence fast path,
  // which is a gate rather than a finding: that preserves the prefer-a-false-positive case where the
  // mount reference lives in a comment but the delete target is genuinely unprovable
  // (`# stage to outputs` + `rm -rf "$UNRESOLVED"` still flags, on the rm's own unprovable target).
  // `code` has comments removed and is what every statement-level DECISION reads, so prose can never
  // itself be the operative delete.
  const expanded = resolveMktempVars(expandSimpleVars(cmd));
  const code = resolveMktempVars(expandSimpleVars(stripCommentLines(cmd)));
  // Mount-independent, so hoisted out of the per-mount loop rather than recomputed per mount. Both are
  // pure, so this is a cost change only — the per-mount decisions below are byte-identical to the
  // original outputs-only detector.
  const stmts = splitStatements(code);
  const prefixes = [...defaultSafePrefixes(), ...safePrefixes()];

  const deletesIn = (mount: string): boolean => {
    const mm = mountMatchers(mount);
    for (const stmt of stmts) if (mvDeletesOutputs(stmt, mm)) return true; // mv: always-on, direction-aware
    if (!DELETE_TOKEN.test(expanded) || !mm.touches.test(expanded)) return false; // rm-family fast path
    // per-statement, on `code`: a COMMENTED `# cd outputs` must not short-circuit past a statement whose
    // own target is provably safe (`# cd outputs` + `rm /tmp/x` is not a delete).
    if (stmts.some((st) => mm.cdInto.test(st))) return true; // a cwd-relative delete could hit the mount
    for (const stmt of stmts) {
      if (!DELETE_TOKEN.test(stmt)) continue;
      if (mm.touches.test(stmt)) return true; // a delete statement itself names the mount
      const targets = nonFlagArgs(stmt);
      // A prefix match only PROVES safety if the remainder after the prefix is itself inert: no `..`
      // path segment (could walk back out of the safe root, e.g. `/tmp/a/../b` → `/tmp/b`... or worse,
      // `/tmp/../outputs/x`) and no unexpanded `$` (an unresolved var/command-subst suffix, e.g.
      // `/tmp/${TARGET}` or `/tmp/$(get)`, whose real resolved path is unknown). Either makes the
      // remainder itself unprovable, so the whole target falls through to the "unprovable → flag" path
      // below rather than being cleared by the prefix match.
      const isProvablySafe = (t: string): boolean =>
        prefixes.some((pre) => {
          if (!t.startsWith(pre)) return false;
          const remainder = t.slice(pre.length);
          if (/(^|\/)\.\.(\/|$)/.test(remainder)) return false;
          if (remainder.includes("$")) return false;
          return true;
        });
      const allSafe = targets.length > 0 && targets.every(isProvablySafe);
      if (!allSafe) return true; // unprovable (incl. unexpanded/command-subst vars, `..` traversal) → flag
    }
    return false; // every rm delete is provably under a safe prefix; the mount ref was non-delete only
  };

  return mounts.filter(deletesIn);
}

/** The original outputs-only predicate, preserved verbatim in behaviour as the single-mount case. Kept
 *  because `no_delete_in_outputs`, its verdict signal and every committed cassette are defined in terms
 *  of it — widening detection must not move any of them. */
export function isOutputsDelete(cmd: string): boolean {
  return detectMountDeletes(cmd, ["outputs"]).length > 0;
}

/** the operative delete statement(s) within a command that `isOutputsDelete` flagged — for a readable
 *  finding. The raw `cmd.slice(0,120)` truncated away the actual `rm` when a long `VAR=…` assignment prefix
 *  preceded it (the finding then showed only the assignment block). This surfaces the delete/mv itself, with
 *  simple `VAR=literal` assignments resolved so the real target path is visible. Falls back to the whole
 *  (expanded) command if no single statement isolates the delete. Bounded length for the stored finding. */
function outputsDeleteSnippet(cmd: string, mount = "outputs"): string {
  // Iterate var expansion to a fixed point so CHAINED assignments (ARTIFACTS_ROOT → ANALYSIS_DIR → rm) fully
  // resolve in the displayed path. (Detection keeps the single-pass `expandSimpleVars` — its semantics are
  // pinned by tests; multi-pass here only sharpens the finding, never changes what gets flagged.)
  // Comments stripped FIRST (see stripCommentLines): a comment is never the operative delete, so it must
  // not be displayed as one — in the ops-found path OR in the whole-command fallback below, which would
  // otherwise print comment prose as the finding when the flag came from the co-occurrence fast path.
  let expanded = stripCommentLines(cmd);
  for (let i = 0; i < 5; i++) {
    const next = expandSimpleVars(expanded);
    if (next === expanded) break;
    expanded = next;
  }
  const mm = mountMatchers(mount);
  const ops = splitStatements(expanded).filter((s) => mvDeletesOutputs(s, mm) || DELETE_TOKEN.test(s));
  return (ops.length ? ops.join("; ") : expanded).trim().slice(0, 160);
}

/** Scan a run's events.jsonl for limitation-fidelity signals (moved from cli.ts). */
export function scanEvents(
  file: string,
  /** Writable (`rw`) user-visible mount names to attribute deletes to. Production denies unlink/rmdir on
   *  EVERY such mount, not just `outputs`. Defaults to outputs-only so existing callers are unchanged. */
  rwMounts: string[] = ["outputs"],
): {
  outputsDeletes: string[];
  /** Per-mount delete detections across ALL writable mounts, including `outputs`. A superset of
   *  `outputsDeletes`, which stays exactly as it was because `no_delete_in_outputs`, its verdict signal
   *  and every committed cassette are defined in terms of it. */
  mountDeletes: { mount: string; command: string }[];
  hostPathLeaked: boolean;
  selfHealRan: boolean;
  // events.jsonl was absent/unreadable — the scan produced NO evidence. Distinct from a clean scan:
  // callers must NOT persist an all-false scan for this case (that reads as "scanned, found nothing").
  sidecarMissing: boolean;
  // count of events.jsonl lines that failed JSON.parse — a corrupt/truncated log where a leak-bearing
  // line could have been silently dropped. >0 makes the scan untrustworthy, treated as evidence-unavailable.
  malformedLines: number;
} {
  const mounts = rwMounts.includes("outputs") ? rwMounts : ["outputs", ...rwMounts];
  const out = {
    outputsDeletes: [] as string[],
    mountDeletes: [] as { mount: string; command: string }[],
    hostPathLeaked: false,
    selfHealRan: false,
    sidecarMissing: false,
    malformedLines: 0,
  };
  let lines: string[] = [];
  try {
    // CURRENT TURN ONLY. Whole-file scanning made a turn-1 delete fail turn 2's verdict on every
    // `--resume`.
    //
    // NOTE the empty-FILE case is deliberately left alone: `"".trim().split("\n")` is `[""]`, one
    // malformed line, i.e. evidence-unavailable. `scanEvents` runs POST-run, so a completed turn with an
    // empty stream is evidence LOSS and must keep failing closed. An earlier version of this fix
    // special-cased it to `[]` — silently flipping that to a clean PASS on single-turn runs, while the
    // commit claimed turn 1 was untouched. The case that actually needed handling (an empty segment
    // AFTER a marker) is already `[]` via the slice below, and on turn >= 2 the file is never empty.
    lines = currentTurnEventLines(readFileSync(file, "utf8").trim().split("\n"));
  } catch {
    out.sidecarMissing = true;
    return out;
  }
  const selfHealRe = /\/sessions\/[^\s"]*\/mnt\/\.local-plugins/;
  for (const l of lines) {
    let msg: any;
    try {
      msg = JSON.parse(l);
    } catch {
      out.malformedLines++;
      continue;
    }
    // host-path leaks can appear in tool_result blocks (Bash stdout/stderr) and user messages,
    // not just assistant text. Scan both assistant and user messages; keep the Bash delete/self-heal
    // detection assistant-only (those are tool_use blocks the agent emits).
    if (msg.type !== "assistant" && msg.type !== "user" && msg.type !== "system") continue;
    // A standalone `system` message carries top-level string content (no message.content array).
    if (msg.type === "system" && typeof msg.content === "string" && hostPathLeaked(msg.content)) out.hostPathLeaked = true;
    for (const block of msg.message?.content ?? []) {
      // A `thinking` block can leak a host path in the reasoning text (e.g. quoting an absolute path).
      if (block.type === "thinking") {
        const t = block.thinking ?? block.text;
        if (typeof t === "string" && hostPathLeaked(t)) out.hostPathLeaked = true;
      }
      // delete/self-heal detection must cover BOTH bash surfaces — native `Bash` (container/microvm
      // tiers) AND `mcp__workspace__bash` (host-loop, where native Bash is disabled). Same `command`
      // input shape. Missing the MCP name was a host-loop blind-spot in the post-hoc backstop.
      if (block.type === "tool_use" && (block.name === "Bash" || block.name === "mcp__workspace__bash") && msg.type === "assistant") {
        const cmd = String(block.input?.command ?? "");
        // One detection pass over every writable mount; `outputsDeletes` is then the `outputs` slice of
        // it, so the two can never disagree about outputs the way two separate passes could.
        const hits = detectMountDeletes(cmd, mounts);
        for (const m of hits) out.mountDeletes.push({ mount: m, command: outputsDeleteSnippet(cmd, m) });
        // `outputsDeletes` is the `outputs` slice of THIS command's hits — one detection pass feeds both,
        // so they cannot disagree about outputs the way two separate passes could.
        if (hits.includes("outputs")) out.outputsDeletes.push(outputsDeleteSnippet(cmd));
        if (selfHealRe.test(cmd)) out.selfHealRan = true;
      }
      if (block.type === "text" && typeof block.text === "string" && hostPathLeaked(block.text)) out.hostPathLeaked = true;
      if (block.type === "tool_result") {
        // tool_result.content is a string or an array of {type:"text", text} blocks (Bash output, etc.)
        const c = block.content;
        if (typeof c === "string") {
          if (hostPathLeaked(c)) out.hostPathLeaked = true;
        } else if (Array.isArray(c)) {
          for (const sub of c) if (typeof sub?.text === "string" && hostPathLeaked(sub.text)) out.hostPathLeaked = true;
        }
      }
    }
  }
  return out;
}

/**
 * The hostloop runtime tripwire: a working PreToolUse path gate produces an observable hook callback for
 * every gated tool_use. Walk `events.jsonl`'s assistant tool_use blocks whose name is gated (Read/Write/
 * Edit/Glob/Grep/MultiEdit); any block whose id is absent from `gateFired` AND whose matching tool_result
 * was observed non-error means the call completed with NO evidence the gate ever ran on it. This turns a
 * hypothetical future binary version that silently stops firing hooks for pre-approved tools into a hard
 * run failure instead of a silent, unverifiable pass — the same check the chat lane's tripwireHook runs
 * live, applied here to the recorded event stream. Returns the ungated tool names, for the caller's message.
 */
export function findUngatedPathToolCalls(file: string, gateFired: Set<string>): string[] {
  const GATED = new Set(["Read", "Write", "Edit", "Glob", "Grep", "MultiEdit"]);
  const toolUseIdToName = new Map<string, string>();
  const toolResultIsError = new Map<string, boolean>();
  let lines: string[] = [];
  try {
    // Current turn only: turn 1's own successfully-gated tool calls were erroring turn 2, because the
    // gate-fired set holds only THIS process's hook callbacks.
    lines = currentTurnEventLines(readFileSync(file, "utf8").trim().split("\n"));
  } catch {
    return [];
  }
  for (const l of lines) {
    let msg: any;
    try {
      msg = JSON.parse(l);
    } catch {
      continue;
    }
    if (msg.type !== "assistant" && msg.type !== "user") continue;
    for (const block of msg.message?.content ?? []) {
      if (msg.type === "assistant" && block.type === "tool_use" && block.id && GATED.has(block.name)) {
        toolUseIdToName.set(String(block.id), block.name);
      }
      if (msg.type === "user" && block.type === "tool_result" && block.tool_use_id) {
        toolResultIsError.set(String(block.tool_use_id), !!block.is_error);
      }
    }
  }
  const ungated: string[] = [];
  for (const [id, name] of toolUseIdToName) {
    if (gateFired.has(id)) continue;
    const isError = toolResultIsError.get(id);
    if (isError === false) ungated.push(`${name} (${id})`);
  }
  return ungated;
}

/**
 * parse `COWORK_HARNESS_DIALOG_TIMEOUT_MS`. Returns:
 *  - `Infinity` for "inf", "infinite", or "-1" (explicit no-timeout sentinel)
 *  - a positive integer (milliseconds) for a valid numeric string in 1..3_600_000
 *  - `undefined` for absent / "0" / empty (→ policy-based default applies)
 * Rejects decimals, NaN, negative values, zero, and values exceeding 3_600_000 ms (1 hour).
 */
/** A scenario's `on_unanswered:` outranks an explicit `--on-unanswered` — deliberately, and documented
 *  in `run --help` ("per-scenario answers/on_unanswered in the YAML take precedence where set"), because
 *  a committed scenario is the reproducible definition of its own test. The precedence is a covered
 *  surface and stays; what was wrong is that it applied in SILENCE, so a user who passed the flag saw no
 *  sign their value had been dropped and the run answered gates by the policy they were replacing.
 *
 *  Returns the warning text, or undefined when nothing is actually discarded. Deliberately silent when
 *  the two agree: nothing is lost, and `run dir/ --on-unanswered first` over a tree where most scenarios
 *  already declare `first` would otherwise emit one line per scenario and train the reader to skip it. */
export function onUnansweredOverrideWarning(scenarioValue?: OnUnanswered, flagValue?: OnUnanswered): string | undefined {
  if (scenarioValue === undefined || flagValue === undefined || scenarioValue === flagValue) return undefined;
  return (
    `::warning:: [input] the scenario sets \`on_unanswered: ${scenarioValue}\`, which takes precedence over ` +
    `\`--on-unanswered ${flagValue}\` — the run answers unscripted gates by \`${scenarioValue}\`. ` +
    `Edit the scenario's YAML to change it.\n`
  );
}

export function parseDialogTimeout(raw: string): number | undefined {
  const s = raw.trim().toLowerCase();
  if (!s || s === "0") return undefined;
  if (s === "inf" || s === "infinite" || s === "-1") return Infinity;
  const n = parseInt(s, 10);
  if (!Number.isSafeInteger(n)) throw new Error(`cowork-harness: COWORK_HARNESS_DIALOG_TIMEOUT_MS=${raw.trim()} is not a safe integer`);
  if (String(n) !== s) throw new Error(`cowork-harness: COWORK_HARNESS_DIALOG_TIMEOUT_MS=${raw.trim()} must be an integer (no decimals)`);
  if (n <= 0) throw new Error(`cowork-harness: COWORK_HARNESS_DIALOG_TIMEOUT_MS=${raw.trim()} must be > 0`);
  const MAX_MS = 3_600_000;
  if (n > MAX_MS)
    throw new Error(`cowork-harness: COWORK_HARNESS_DIALOG_TIMEOUT_MS=${raw.trim()} exceeds maximum of ${MAX_MS} ms (1 hour)`);
  return n;
}

/**
 * Parse an environment variable as a TCP port (integer in 1..65535).
 * Returns `defaultValue` when the variable is absent or empty.
 * Throws with a descriptive message if the value is present but not a valid port.
 */
export function parseEnvPort(name: string, defaultValue: number): number {
  const val = process.env[name];
  if (!val) return defaultValue;
  const n = parseInt(val, 10);
  if (!Number.isFinite(n) || n < 1 || n > 65535 || String(n) !== val.trim())
    throw new Error(`cowork-harness: ${name}=${val} must be an integer in 1..65535`);
  return n;
}

/**
 * read + validate the resume manifest. Converts a raw JSON `SyntaxError` into a friendly
 * "corrupt manifest" error, and on the resume path throws a clear error when `agentSessionId` is
 * missing or not a string (corrupt or older-format file) instead of silently degrading to a fresh
 * session. Extracted so it's unit-testable without spawning a run.
 */
export function readSessionManifest(path: string, sessionId: string, expectedFidelity: string): string {
  const raw = readFileSync(path, "utf8");
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`corrupt manifest at ${path}: not valid JSON`);
  }
  // if the manifest records a sessionId, verify it matches the requested one so a copied or
  // stale manifest cannot resume the wrong native agent conversation. Legacy manifests without a
  // sessionId field are allowed through for backward compatibility.
  if (parsed?.sessionId !== undefined && sessionId && parsed.sessionId !== sessionId) {
    throw new Error(`cowork-harness: manifest session ID mismatch: manifest has ${parsed.sessionId}, expected ${sessionId}`);
  }
  // Verify the fidelity tier matches. The agent's native conversation store is tier-LOCAL — container
  // persists it under the work tree, hostloop under the host config dir, microvm inside the guest — so a
  // resume at a different tier hands the agent a `--resume <uuid>` for a conversation its store has never
  // seen (it would error late in the spawn, or silently mint fresh history). Fail closed, up front, with
  // an actionable message. Legacy manifests written before the stamp have no `fidelity` field and are let
  // through (mirrors the sessionId tolerance above) with a warning — every manifest written from now on
  // carries the stamp, so this hole self-closes.
  if (parsed?.fidelity !== undefined) {
    if (expectedFidelity && parsed.fidelity !== expectedFidelity) {
      throw new Error(
        `cannot resume "${sessionId}": session was created at fidelity "${parsed.fidelity}" but this resume is ` +
          `"${expectedFidelity}" — the agent's conversation store is tier-local; re-run at --fidelity ${parsed.fidelity}, ` +
          `or start a fresh session`,
      );
    }
  } else {
    process.stderr.write(
      `::warning:: [resume] session manifest at ${path} predates the fidelity stamp — ` +
        `a cross-tier resume cannot be checked for this pre-existing session\n`,
    );
  }
  const id = parsed?.agentSessionId;
  if (typeof id !== "string" || !id) {
    throw new Error(
      `cannot resume "${sessionId}": manifest at ${path} is missing agentSessionId (corrupt or older format) — ` +
        `delete the run dir and re-run to recreate`,
    );
  }
  return id;
}

export { UnansweredError, BoundaryError, UsageError, LegacyRunDirError };
