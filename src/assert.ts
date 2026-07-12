import { existsSync, readFileSync, statSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import type { Assertion, RunResult, UsageInfo, CostInfo } from "./types.js";
import { VERDICT_MODIFIER_KEYS } from "./types.js";
import { compileUserRegex } from "./regex.js";
import { normalizeHost } from "./boundary-paths.js";
import { extractComputerLinks, resolveComputerLink, type LinkResolutionContext } from "./run/computer-links.js";
import { scrub } from "./secrets.js";
import { warn } from "./io.js";
import { collectArtifactPathsWithHealth } from "./run/artifacts.js";
import { anyGlobMatches } from "./glob.js";

/** Derives the four AssertContext budget fields (costUsd/tokensTotal/toolCallsTotal/turns) uniformly from
 *  any RunResult/RunRecord-shaped source — live, replay, and verify-run all read the same shapes (the
 *  shared UsageInfo/CostInfo types), so this is one function, not four copies. Each field's own
 *  undefined-ness IS the evidence-unavailable signal (see AssertContext's doc comments); no separate
 *  `*Missing` booleans needed for scalars. `turns` is a pure passthrough of
 *  `usage.turns` — that extraction/fallback-counting work already happened at the source, so there
 *  is no re-derivation here, unlike the other three fields which are actually computed from raw parts. */
export function budgetFields(src: {
  usage?: UsageInfo;
  cost?: CostInfo;
  toolCounts?: Record<string, number>;
  toolErrors?: Record<string, { calls: number; errors: number }>;
  redundantToolCalls?: Array<{ name: string; argHash: string; count: number }>;
}): {
  costUsd?: number;
  tokensTotal?: number;
  toolCallsTotal?: number;
  turns?: number;
  toolErrorsTotal?: number;
  redundantCallsTotal?: number;
} {
  const inTok = src.usage?.input_tokens;
  const outTok = src.usage?.output_tokens;
  return {
    costUsd: src.cost?.usd,
    tokensTotal: typeof inTok === "number" && typeof outTok === "number" ? inTok + outTok : undefined,
    toolCallsTotal: src.toolCounts === undefined ? undefined : Object.values(src.toolCounts).reduce((a, b) => a + b, 0),
    turns: src.usage?.turns,
    toolErrorsTotal: src.toolErrors === undefined ? undefined : Object.values(src.toolErrors).reduce((sum, t) => sum + t.errors, 0),
    redundantCallsTotal:
      src.redundantToolCalls === undefined ? undefined : src.redundantToolCalls.reduce((sum, g) => sum + (g.count - 1), 0),
  };
}

/** Resolve a user-authored assertion path under `workRoot`, rejecting absolute paths and any `..` that
 *  escapes the root. Returns the absolute path, or null if it would leave `workRoot`. Assertion paths are
 *  author-controlled, not attacker input, but a `file_exists: "../../etc/passwd"` silently probing the host
 *  FS (or an `outputs/../../x` slipping past the user-visible prefix check) is a containment bug regardless. */
function containedPath(workRoot: string, p: string): string | null {
  if (isAbsolute(p)) return null;
  const root = resolve(workRoot);
  const abs = resolve(root, p);
  const rel = relative(root, abs);
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) return null;
  return abs;
}

/**
 * containedPath checks lexical traversal but not symlink targets. A symlink inside the workspace
 * root that points outside satisfies containedPath yet lets existsSync observe host files.
 * This helper resolves symlinks with realpathSync and verifies the real path is still under `root`.
 * Returns the absolute path when safe; returns null when:
 *  - the path escapes root after symlink resolution (containment violation), or
 *  - realpathSync throws ENOENT (file does not exist — treat as "not found", not a violation).
 * Other realpathSync errors (permission denied, etc.) are treated as containment failures (not found = safe
 * but conservative; the caller's existsSync will return false anyway).
 *
 * Note: workRoot itself is also resolved via realpathSync to handle platforms (macOS) where tmpdir()
 * returns a symlinked path (e.g. /var/folders/... → /private/var/folders/...). Without resolving
 * both sides, a legitimate file under a symlinked workRoot would be incorrectly flagged as escaping.
 */
function containedRealPath(workRoot: string, abs: string): string | null {
  // Resolve workRoot itself to its real path so comparisons are apples-to-apples.
  let realRoot: string;
  try {
    realRoot = realpathSync(resolve(workRoot));
  } catch {
    // workRoot doesn't exist (e.g. /nonexistent in tests) — fall back to lexical root.
    realRoot = resolve(workRoot);
  }
  let real: string;
  try {
    real = realpathSync(abs);
  } catch (e: any) {
    // ENOENT: path doesn't exist — not a containment violation, just absent.
    if (e?.code === "ENOENT") return abs; // return the original abs; existsSync will return false
    // Other errors (EPERM, dangling symlink pointing outside): treat conservatively as "not accessible".
    return null;
  }
  const rel = relative(realRoot, real);
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) return null;
  return real;
}

/**
 * Resolve a dotted path into a parsed JSON document with THREE distinct outcomes (conflating them
 * reintroduces a false-green at the field level):
 *  - `value`      — the path resolves to a present value (which may itself be JSON null);
 *  - `absent`     — the FINAL key is missing from a parent that DID resolve (the anti-hallucination case);
 *  - `unresolved` — an INTERMEDIATE segment is missing / not an object — the artifact is malformed for this
 *                   path, which must FAIL LOUD, never pass vacuously.
 * Array indices are addressed as numeric string segments (e.g. `items.0.id`).
 */
export type DotResolve = { state: "value"; value: unknown } | { state: "absent" } | { state: "unresolved"; at: string };
export function resolveDotPath(doc: unknown, path: string | undefined): DotResolve {
  if (!path) return { state: "value", value: doc };
  const segs = path.split(".");
  let cur: unknown = doc;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const last = i === segs.length - 1;
    if (cur === null || typeof cur !== "object") return { state: "unresolved", at: segs.slice(0, i).join(".") || "(root)" };
    const obj = cur as Record<string, unknown>;
    const has = Object.prototype.hasOwnProperty.call(obj, seg);
    if (last) return has ? { state: "value", value: obj[seg] } : { state: "absent" };
    if (!has) return { state: "unresolved", at: segs.slice(0, i + 1).join(".") };
    cur = obj[seg];
  }
  return { state: "value", value: cur };
}

/**
 * Recursive deep equality for parsed-JSON values, used by `artifact_json.equals` / `.in`.
 * Object key ORDER is irrelevant ({a:1,b:2} === {b:2,a:1}), but array ORDER is significant
 * ([1,2] !== [2,1]) — arrays carry meaning in their order, so we never sort them. The old
 * `JSON.stringify(a) === JSON.stringify(b)` was wrongly order-sensitive on object keys.
 */
const deepJsonEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true; // primitives + identity (JSON has no NaN, so no special-casing needed)
  if (a === null || b === null) return false; // one is null and they weren't ===
  if (typeof a !== "object" || typeof b !== "object") return false;
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr && bArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepJsonEqual(a[i], b[i])) return false; // order-sensitive
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  const bKeys = Object.keys(bo);
  if (aKeys.length !== bKeys.length) return false; // same set of keys (order-insensitive)
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepJsonEqual(ao[k], bo[k])) return false;
  }
  return true;
};

const jsonEq = (a: unknown, b: unknown): boolean => deepJsonEqual(a, b);

/**
 * Boundary-aware host matching: `host` must equal `needle` exactly or be a proper subdomain of it.
 * `evilanthropic.com` does NOT match `anthropic.com`; `x.anthropic.com` does.
 *
 * Both sides are normalized (lowercase + trailing-dot strip + IPv6 bracket strip) so an author needle
 * that differs from the recorded host only in case, a trailing dot, or brackets still matches the way
 * runtime egress matching does. Normalization is COMPOSED onto the existing subdomain semantics, not a
 * replacement — the `endsWith("." + needle)` proper-subdomain rule is preserved.
 *
 * A `*.suffix` needle is a proper-subdomain wildcard mirroring the egress proxy's `*.` semantics (matches
 * `sub.suffix`, NOT the apex `suffix`). This is ADDITIVE — a bare needle keeps its existing
 * subdomain-inclusive meaning (apex + subdomains); only an explicit `*.` prefix opts into subdomain-only.
 */
export function hostMatches(host: string, needle: string): boolean {
  const h = normalizeHost(host);
  const n = normalizeHost(needle);
  if (n.startsWith("*.")) {
    const suffix = n.slice(2);
    return h.endsWith("." + suffix);
  }
  return h === n || h.endsWith("." + n);
}

/** One graded rubric claim from the semantic judge. Results align to the rubric BY INDEX, not by claim
 *  text — the judge may reword a claim between calls, so text-keyed aggregation would misalign. */
export interface SemanticClaimResult {
  index: number;
  claim: string;
  pass: boolean;
}
/** The semantic judge: grade a fixed rubric against the run's answer. LIVE-ONLY (a real model call).
 *  Injectable so tests can stub it; the real judge is `makeSemanticJudge` in src/decide/. `model` is the
 *  resolved judge model id, recorded as provenance (`RunResult.assertions[].judgeModel`); a stub may omit it. */
export type SemanticJudge = ((rubric: string[], answer: string) => Promise<SemanticClaimResult[]>) & { model?: string };

export interface AssertContext {
  transcript: string;
  /** LIVE-ONLY, populated by runSemanticJudges (an async pre-pass) BEFORE the synchronous evaluate(),
   *  so check() reads judge results synchronously and evaluate() stays pure (replay determinism intact).
   *  Absent on replay (semantic_matches is stripped as live-only) or on a live run where the pre-pass
   *  wasn't run → semantic_matches then fails evidence-unavailable, never vacuous-passes. */
  semanticResults?: Map<Assertion, SemanticClaimResult[]>;
  /** Which judge model graded each `semantic_matches` assert (provenance) — populated by
   *  runSemanticJudges alongside semanticResults, surfaced as `RunResult.assertions[].judgeModel`. */
  judgeModels?: Map<Assertion, string>;
  /** `semantic_matches` asserts whose judge grade was INVALID (malformed/ambiguous after a retry) —
   *  populated by runSemanticJudges. Distinct from "not graded": the check surfaces `judgeInvalid:true` so
   *  a consumer counts the rep as invalid, never silently drops it (which would inflate the score). */
  judgeInvalid?: Set<Assertion>;
  /** The agent's final answer (SDK result text) — the first part of the judged document, so a
   *  correct *inline* answer is graded even when no file is written. */
  finalMessage?: string;
  /** Files the run authored (final on-disk content) — appended to the judged document so the judge grades
   *  what the skill PRODUCED, not only what it inlined. Populated live; absent on replay/microvm. */
  authoredFiles?: import("./run/artifacts.js").AuthoredFile[];
  /** Health of the authored-file capture (#14/#16): files dropped at the total-size cap (`omittedPaths`)
   *  or authored-but-unreadable at read-back (`readErrors`). When either is non-empty the judged document
   *  is INCOMPLETE, so `semantic_matches` fails evidence-unavailable rather than trusting a grade the judge
   *  made without the omitted content. Absent = capture was complete (or lane doesn't author files). */
  authoredFilesHealth?: import("./run/artifacts.js").AuthoredFilesHealth;
  /** Secret values to scrub from the judged document before it leaves for the judge. */
  secrets?: string[];
  toolsCalled: Set<string>;
  subagentTools: Set<string>;
  egress: RunResult["egress"];
  /** Set by verify-run only when `result.egress` is undefined in result.json (a run predating the egress
   *  field). Distinct from a legitimately-empty [] (a run that made zero egress attempts — the proxy
   *  writes the log lazily on the first decision, so absent ≠ missing evidence). egress_denied/allowed
   *  fail evidence-unavailable when set, rather than the misleading "expected egress denied". #5 */
  egressMissing?: boolean;
  result: "success" | "error";
  workRoot: string; // dir under which file_exists paths resolve (L0: work/, L1/L2: work/session/mnt)
  userVisiblePrefixes: string[]; // path prefixes promoted to the user (e.g. outputs, .projects)
  /** workRoot-relative paths under userVisiblePrefixes BEFORE the agent ran (RunResult.preRunPaths /
   *  cassette.preRunPaths). undefined = no pre-run manifest (older run/cassette, or microvm) —
   *  no_unexpected_files then fails evidence-unavailable, never vacuous-passes. */
  preRunPaths?: string[];
  /** True iff `preRunPaths` was captured link-aware (manifest v2+). When false/undefined (a pre-#38
   *  baseline, or a re-verified pre-upgrade run dir), `no_unexpected_files` excludes link entries from the
   *  post walk so a pre-existing symlink is not a false "created" stray. */
  preRunLinkAware?: boolean;
  /** Pre-run per-path sha256 (RunResult.preRunHashes / cassette.preRunHashes). undefined = no manifest —
   *  input_unmodified fails evidence-unavailable. */
  preRunHashes?: Record<string, string | null>;
  /** Manifest-local provenance (pre-run-manifest.ts's `readPreRunManifestOrigin`) — deliberately NOT a
   *  RunResult/Cassette field (no producer emits anything but "local-walk" today, so there is nothing to
   *  round-trip through a replay/verify lane yet). "remote-unavailable" is RESERVED for a future cloud
   *  run whose filesystem isn't locally observable: no_unexpected_files / input_unmodified must then fail
   *  evidence-unavailable — the same loud path taken when preRunPaths/preRunHashes are absent entirely —
   *  never a vacuous pass just because a (locally meaningless) preRunPaths/preRunHashes happens to be
   *  present. undefined today on every real caller; only a hand-constructed ctx sets this. */
  preRunOrigin?: "local-walk" | "remote-unavailable" | "local-unreadable";
  /** Replay-lane ONLY: authoritative post-run per-path sha256 from the cassette manifest
   *  (cassette.artifacts[].sha256). undefined on live/verify-run (there, input_unmodified re-hashes the
   *  real tree under workRoot). Needed because replay's materialized tree writes 0-byte placeholders for
   *  body-less entries, so re-hashing it would be wrong. */
  postRunHashes?: Record<string, string>;
  outputsDeletes: string[]; // delete ops that touched mnt/outputs (post-run scan)
  questions: string[]; // AskUserQuestion question texts asked
  hostPathLeaked: boolean; // a host path (/Users//opt) appeared in model-visible text
  selfHealRan: boolean; // a /sessions/<id>/mnt plugin script was invoked (plugin-root self-heal)
  subagents: {
    dispatchAgentType: string;
    resolvedAgentType?: string; // the BINARY-resolved child type from task_started — strictly better evidence than dispatchAgentType for a type-less dispatch
    declaredTools: string[];
    toolsUsed: Array<{ name: string; count: number }>;
    description?: string;
    output?: string;
    outputTruncated?: boolean; // #9: output was cut at the assert cap — a negative content check is unverifiable
  }[]; // dispatch tree (sub-agent assertions)
  gateDeliveries: {
    question: string;
    delivered: boolean | null;
    error?: string;
    reason?: "ok" | "errored" | "unobserved" | "no-pairing-metadata";
  }[]; // per-gate answer-delivery outcome
  toolResultTexts: string[]; // assertion-fidelity text for each tool result (assertText ?? text, 10 KB cap)
  /** Parallel to toolResultTexts; true for each entry that fell back to display text (assertText absent).
   *  Only relevant for old/partial cassettes — live/replay always capture assertText. */
  toolResultsTruncated?: boolean[];
  /** Set by verify-run only when run.jsonl is absent/unreadable. Prevents negative transcript assertions
   *  from passing vacuously on missing evidence (absent ≠ empty). Undefined/false on live and replay lanes. */
  transcriptMissing?: boolean;
  /** Set by verify-run only when trace.json is absent/unreadable. Prevents questions_count_max from
   *  passing vacuously on missing evidence (absent ≠ zero questions). Undefined/false on live/replay lanes. */
  questionsMissing?: boolean;
  /** Set by verify-run only when `result.toolResults` is undefined in result.json (partial/old run).
   *  Prevents tool_result_not_contains from passing vacuously (absent ≠ empty). Undefined/false on
   *  live/replay lanes, where the structure is always present (empty = proof-of-absence). */
  toolResultsMissing?: boolean;
  /** Set by verify-run only when `result.toolCounts` is undefined in result.json (partial/old run).
   *  Prevents tool_not_called from passing vacuously (absent ≠ empty). Undefined/false on live/replay. */
  toolsCalledMissing?: boolean;
  /** Set by verify-run only when `result.subagents` is undefined in result.json (partial/old run).
   *  Prevents subagent_tool_absent / subagent_declared_but_unused / dispatch_count_max from passing
   *  vacuously (absent ≠ no sub-agents). Undefined/false on live/replay. */
  subagentsMissing?: boolean;
  /** Set by verify-run only when `result.scan` is undefined in result.json (partial/old run).
   *  Prevents no_delete_in_outputs / transcript_no_host_path / self_heal_ran from passing vacuously
   *  on default-false/empty scan fields (absent ≠ clean scan). Undefined/false on live/replay, where
   *  the scan structure is always populated (empty = proof-of-absence). */
  scanMissing?: boolean;
  /** Set by verify-run only when `result.gateDeliveries` is undefined in result.json (partial/old run).
   *  Prevents gate_answers_delivered / gate_answer_count_min from passing vacuously on a collapsed-to-[]
   *  gateDeliveries; absent ≠ zero gates. Undefined/false on live/replay, where gateDeliveries is always
   *  populated (empty = genuine zero gates fired). */
  gateDeliveriesMissing?: boolean;
  /** Body-less artifact paths → WHY (from each entry's `truncationReason`). Set by the REPLAY lane from
   *  materializeManifest(); empty on live/verify-run. `.has(rel)` = "is body-less"; `.get(rel)` gives the
   *  reason ("readonly"/"size"/"unreadable", or undefined on a pre-v8 entry) so artifact_json's remedy is
   *  precise. */
  truncatedPaths?: Map<string, "size" | "readonly" | "unreadable" | "input" | undefined>;
  /** REPLAY-only: workRoot-relative paths that were a symlink/hardlink at record time (v10 `linkKind`
   *  entries). They materialize as placeholder files indistinguishable from real files, so existence
   *  assertions (file_exists / user_visible_artifact / computer_links_resolve) must treat them as
   *  evidence-unavailable — the cassette records that a link EXISTED, not that it RESOLVED. Undefined on
   *  live/verify-run (the real filesystem is checked directly there). */
  linkPaths?: Set<string>;
  /** workRoot-relative mount prefixes of read-only (`mode:r`) connected folders. Used ONLY by the
   *  LIVE/verify-run lanes (which have no cassette manifest at eval time) to know a target will be
   *  captured body-less, so artifact_json is evidence-unavailable there too (symmetry with replay, which
   *  instead reads `truncatedPaths.get(rel) === "readonly"`). Comes from `RunResult.readonlyFolderRoots`
   *  (NOT a cassette field — the cassette-level list was removed in v8 in favor of per-entry
   *  `truncationReason`). Empty on replay and when there is no read-only folder. */
  readonlyFolderRoots?: string[];
  /** Skill/plugin ids invoked via the Skill tool_use event, in call order (duplicates kept). */
  skillsInvoked: string[];
  /** Whether the agent's init tool list included "Skill". False/never-observed means
   *  skill_triggered/no_skill_triggered cannot be evaluated (agent-version tool-name drift) and must fail
   *  as evidence-unavailable rather than risk a false negative. */
  skillToolAvailable: boolean;
  /** Set by verify-run only when `result.skillsInvoked` is undefined in result.json (an older result.json
   *  that never captured this). Prevents no_skill_triggered from passing vacuously (absent ≠ no skills
   *  invoked). Undefined/false on live/replay. */
  skillsInvokedMissing?: boolean;
  /** RunResult.cost.usd — undefined when cost telemetry wasn't recorded for this run (an older run that
   *  never captured cost telemetry, or the SDK didn't report total_cost_usd for this invocation). Its own
   *  undefined-ness IS the evidence-unavailable signal for max_cost_usd — a real cost is always a defined
   *  number, including 0. */
  costUsd?: number;
  /** usage.input_tokens + usage.output_tokens — undefined when either isn't a number (an older run that
   *  never captured token usage, or a partial/old result.json). Own undefined-ness is the
   *  evidence-unavailable signal. */
  tokensTotal?: number;
  /** Sum of toolCounts values (top-level calls only) — undefined when result.toolCounts itself is
   *  undefined (partial/old result.json), never 0 in that case (0 = genuinely zero tool calls, a real
   *  value). Own undefined-ness is the evidence-unavailable signal. */
  toolCallsTotal?: number;
  /** usage.turns (the extraction/fallback-count) — undefined when an older run predates that mechanism or
   *  the SDK reported neither num_turns nor a countable fallback. Own undefined-ness is the
   *  evidence-unavailable signal for max_turns — 0 turns is a real, satisfying value. */
  turns?: number;
  /** Per-tool call/error rollup — undefined means no data was captured (old/partial run), the
   *  evidence-unavailable signal for tool_no_error/max_tool_errors (an empty `{}` is a valid "ran clean"
   *  state and is NOT the same as undefined). */
  toolErrors?: Record<string, { calls: number; errors: number }>;
  /** Sum of toolErrors[*].errors — undefined when result.toolErrors itself is undefined (partial/old
   *  result.json), never 0 in that case (0 = genuinely zero errors, a real value). Own undefined-ness is
   *  the evidence-unavailable signal for max_tool_errors. */
  toolErrorsTotal?: number;
  /** RunResult.skillActivity — skill-activation windows folded from the timeline (via foldSkillActivity),
   *  NOT a RunRecord field (unlike toolErrors/redundantToolCalls above, which are read
   *  straight off the record). Undefined means no timeline was available (old/partial run, or a lane that
   *  never wired the timeline read) — the evidence-unavailable signal for skill_tool_used; an empty `[]`
   *  is a valid "no skill windows" state and is NOT the same as undefined. */
  skillActivity?: Array<{
    skillId: string;
    invocationSeq: number;
    toolCounts: Record<string, number>;
    toolCallCount: number;
    dispatchCount: number;
    durationMs?: number;
  }>;
  /** Repeated identical tool calls, count>=2 groups only — undefined means no data was
   *  captured (old/partial run); an empty `[]` is a valid "no redundancy" state and is NOT the same as
   *  undefined. Not read directly by any `check()` branch today (mirrors toolErrors for parity/future use) —
   *  `redundantCallsTotal` is the derived scalar `max_redundant_tool_calls` actually evaluates. */
  redundantToolCalls?: Array<{ name: string; argHash: string; count: number }>;
  /** Sum of (count-1) across every group in redundantToolCalls — undefined when redundantToolCalls itself
   *  is undefined (partial/old result.json), never 0 in that case (0 = genuinely zero wasted calls, a real
   *  value). Own undefined-ness is the evidence-unavailable signal for max_redundant_tool_calls. */
  redundantCallsTotal?: number;
  /** The fidelity tier actually used this run (`RunResult.effectiveFidelity`) — used only to make
   *  `computer_links_resolve`'s failure message name the tier it checked against; no branching in
   *  `check()` reads this directly (the mode split lives in `linkResolution.mode`). Undefined on an
   *  old result/cassette that predates the field; the message just omits the tier then. */
  effectiveFidelity?: string;
  /** `computer_links_resolve` resolution context — see `src/run/computer-links.ts`. Undefined
   *  means the calling lane hasn't wired this: any `computer://` link found then fails as
   *  evidence-unavailable rather than silently passing (the evidence-missing convention this file
   *  follows everywhere else — e.g. `transcriptMissing`, `scanMissing`). */
  linkResolution?: LinkResolutionContext;
  /** RunResult.tasks[] — Progress panel tasks accumulated from TaskCreate/TaskUpdate.
   *  Undefined means no tasks telemetry was recorded for this run (an older run that never captured this
   *  field, or a run/cassette that never wired this field) — the evidence-unavailable signal for
   *  all_tasks_completed/task_status; an empty `[]` is a valid "no tasks" state and is NOT the same as
   *  undefined. */
  tasks?: Array<{ id: string; subject: string; status: string; description?: string; activeForm?: string }>;
  /** RunResult.context.availableSkills — the staged skill set read straight off disk at RunResult-assembly
   *  time. Undefined means this lane never wired the field (an older run that never captured this field,
   *  or the replay lane, which has no live filesystem to re-stage skills from) — the evidence-unavailable
   *  signal for skill_available; an empty `[]` is a valid "no skills staged" state and is NOT the same as
   *  undefined. */
  availableSkills?: Array<{ id: string; whenToUse?: string }>;
  /** RunResult.context.mcpServers — the SDK's init-event MCP server/connector list. Undefined means no
   *  context telemetry was recorded for this run (an older run that never captured this field) — the
   *  evidence-unavailable signal for connector_available; an empty `[]` is a valid "no connectors" state
   *  and is NOT the same as undefined. */
  mcpServers?: Array<{ name: string; status?: string; [k: string]: unknown }>;
  /** RunResult.context.tools — the SDK's init-event tool manifest. Undefined means no context telemetry
   *  was recorded for this run (an older run that never captured this field) — the evidence-unavailable
   *  signal for tool_available; an empty `[]` is a valid "no tools" state and is NOT the same as
   *  undefined. */
  availableTools?: string[];
  /** RunResult.contextEvents — `system` stream messages the harness doesn't special-case (e.g.
   *  `compact_boundary`). Undefined means no context-events telemetry was recorded for this run (an
   *  older run that never captured this field, or a lane without context events) — the
   *  evidence-unavailable signal for compaction_occurred; an empty `[]` is a valid "captured, saw
   *  nothing uncaught" state and is NOT the same as undefined. */
  contextEvents?: RunResult["contextEvents"];
  /** RunResult.mcpErrors — MCP round-trips the harness answered with a JSON-RPC error. Undefined means
   *  no mcp-error telemetry was recorded for this run (live-only — replay never reproduces it) — the
   *  evidence-unavailable signal for no_mcp_error; an empty `[]` is a valid "no MCP errors" state and
   *  is NOT the same as undefined. */
  mcpErrors?: RunResult["mcpErrors"];
  /** RunResult.hookEvents — PreToolUse hook fire/block events. Undefined means no hook telemetry was
   *  recorded for this run (an older run, or a replay whose cassette lacks `controlOut` — a custom
   *  hook's decision lives only there) — the evidence-unavailable signal for hook_blocked/
   *  no_hook_blocked; an empty `[]` is a valid "no hook fired" state and is NOT the same as undefined. */
  hookEvents?: RunResult["hookEvents"];
  /** RunResult.fileToolAttempts — gated-file-tool attempt telemetry. Undefined = evidence unavailable
   *  (older result) — dependent assertions fail "cannot verify" (excluded-loud), mirroring hookEvents. */
  fileToolAttempts?: RunResult["fileToolAttempts"];
  /** RunResult.pathDenials — decision-level path-denial telemetry (pretooluse/can_use_tool/
   *  permission_denied). Undefined = evidence unavailable — older result, or replay without controlOut
   *  (the can_use_tool source is reconstructible ONLY from controlOut). */
  pathDenials?: RunResult["pathDenials"];
  /** Minimal per-result pairing info (toolUseId/isError only, no text) for `subagent_file_write`'s
   *  causal pairing — the exact half `toolResultTexts` drops (it's `assertText ?? text`, no id/error).
   *  Sourced from `RunResult.toolResults` at all three ctx-construction sites (live/replay/verify).
   *  Undefined = evidence unavailable (older run/result.json); `subagent_file_write` fails cannot-verify
   *  rather than risk pairing an attempt with the wrong (or no) result. */
  toolResults?: { toolUseId?: string; isError: boolean }[];
  /** RunResult.presentedFiles — files delivered via `present_files`, each already classified
   *  promoted/leaked at derivation time (see RunResult's own doc comment). Undefined means no
   *  `present_files` telemetry was recorded for this run (an older run predating the feature) — the
   *  evidence-unavailable signal for no_scratchpad_leak; an empty `[]` is a valid "nothing presented"
   *  state (vacuous pass) and is NOT the same as undefined. */
  presentedFiles?: RunResult["presentedFiles"];
  /** RunResult.resources — resource-usage telemetry sampled while the run executed. Undefined means the
   *  tier never sampled (protocol/replay, a run shorter than one sample interval, or an unavailable probe
   *  tool) — the evidence-unavailable signal for max_peak_rss_bytes; never a vacuous pass. */
  resources?: RunResult["resources"];
  /** Companion malformed-telemetry counters (see RunResult.evidenceErrors). A >0 count makes the dependent
   *  assertion fail "malformed" instead of silently dropping the bad entries. */
  evidenceErrors?: RunResult["evidenceErrors"];
}

export function evaluate(assertions: Assertion[], ctx: AssertContext): RunResult["assertions"] {
  return assertions.map((a) => check(a, ctx));
}

/** LIVE-ONLY async pre-pass. Grade every `semantic_matches` assert (via the supplied judge) and stash
 *  per-claim results in `ctx.semanticResults`, so the SYNCHRONOUS evaluate()/check() can read them. Call
 *  BEFORE evaluate() on the LIVE lane only — the replay lane strips `semantic_matches` (LIVE_ONLY_KEYS)
 *  and must never reach a model. Keeping the only async/model code here is what preserves evaluate()'s
 *  synchronous, replay-deterministic contract. The judge is REQUIRED (no default) so a live run can't
 *  silently grade with a placeholder — the real judge is `makeSemanticJudge` in src/decide/. */
export async function runSemanticJudges(
  assertions: Assertion[],
  ctx: AssertContext,
  judge: SemanticJudge,
  /** Factory for a per-assert `judge_model` override — the run-level `judge` is used when an assert
   *  doesn't override, or when no factory is supplied (e.g. a test stub). */
  judgeFor?: (model: string) => SemanticJudge,
): Promise<void> {
  if (!ctx.semanticResults) ctx.semanticResults = new Map();
  if (!ctx.judgeModels) ctx.judgeModels = new Map();
  if (!ctx.judgeInvalid) ctx.judgeInvalid = new Set();
  const answer = buildJudgedDocument(ctx); // finalMessage + transcript + authored files, scrubbed
  for (const a of assertions) {
    if (a.semantic_matches === undefined) continue;
    const override = a.semantic_matches.judge_model;
    const j = override && judgeFor ? judgeFor(override) : judge;
    // Grade with ONE retry — a stochastic judge sometimes emits a malformed grade. If it still throws,
    // mark the rep INVALID (not absent): the check surfaces it so a consumer counts it, never drops it.
    let graded: SemanticClaimResult[] | undefined;
    for (let attempt = 0; attempt < 2 && graded === undefined; attempt++) {
      try {
        graded = await j(a.semantic_matches.rubric, answer);
      } catch (e) {
        if (attempt === 1) {
          ctx.judgeInvalid.add(a);
          warn(
            `::warning:: semantic judge grade invalid after retry (rep counts as invalid, not passed): ${(e as Error).message.split("\n")[0]}\n`,
          );
        }
      }
    }
    // Record provenance AFTER the call, not before: `j.model` may be a factory-time alias (e.g. "opus")
    // until the transport resolves it per-call to a concrete id (`makeSemanticJudge` mutates `.model` onto
    // the resolved value once its `complete()` call returns). Reading it before the call would stamp the
    // requested alias even when the transport actually resolved to a different concrete model (F11).
    ctx.judgeModels.set(a, j.model ?? override ?? "unknown");
    if (graded) ctx.semanticResults.set(a, graded);
  }
}

/** Compose the document the judge grades: the agent's final answer + the full transcript + the content of
 *  files the run authored (each headed), scrubbed of secrets. Grading the authored files (not only the
 *  inlined prose) is what makes a claim about a *written* artifact presentation-stable; keeping the
 *  finalMessage/transcript is what still grades a correct *inline* answer that wrote no file. */
// Per-section and aggregate character budgets for the judged document (#10). Authored files already carry
// their own caps (16 KiB/file, 64 KiB total, in captureAuthoredFiles), but finalMessage and the transcript
// were previously concatenated WHOLE — so a long run could overflow the model context or make grading cost
// and latency unbounded. Cap each section and the joined document with an explicit truncation marker, so the
// judge SEES that evidence was elided (never reads a truncated tail as "the requirement was not met").
const JUDGE_FINAL_CAP = 32 * 1024;
const JUDGE_TRANSCRIPT_CAP = 128 * 1024;
const JUDGE_DOC_CAP = 256 * 1024;
function capForJudge(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n…[${text.length - cap} chars truncated for the judge input budget — evidence beyond this point was NOT shown; do not infer absence from this cut]`;
}

function buildJudgedDocument(ctx: AssertContext): string {
  // SCRUB BEFORE CAP (#10): scrub is exact-string replacement, so a secret straddling a cap boundary would
  // be truncated mid-token and slip past scrub into the doc sent to the (external) judge. Scrub each raw
  // section FIRST, then cap the already-redacted text — capping redacted content can never re-expose a secret.
  const secrets = ctx.secrets ?? [];
  const s = (t: string): string => (secrets.length ? scrub(t, secrets) : t);
  const parts: string[] = [];
  if (ctx.finalMessage) parts.push(`## Final answer\n${capForJudge(s(ctx.finalMessage), JUDGE_FINAL_CAP)}`);
  parts.push(`## Transcript\n${capForJudge(s(ctx.transcript ?? ""), JUDGE_TRANSCRIPT_CAP)}`);
  for (const f of ctx.authoredFiles ?? [])
    parts.push(`## Authored file: ${s(f.path)}${f.truncated ? " (truncated)" : ""}\n${s(f.content)}`);
  // Surface authored-file incompleteness to the judge so it never reads an omitted/unreadable file's
  // ABSENCE as evidence the skill didn't produce it (#14/#16). The verdict is separately forced to
  // evidence-unavailable in the semantic_matches check; this note keeps a still-produced grade honest.
  const h = ctx.authoredFilesHealth;
  if (h && (h.omittedPaths.length || h.readErrors.length || h.scratchpadSkippedOnResume)) {
    const notes: string[] = [];
    if (h.omittedPaths.length)
      notes.push(`- ${h.omittedPaths.length} authored file(s) OMITTED (capture size budget exhausted): ${s(h.omittedPaths.join(", "))}`);
    if (h.readErrors.length)
      notes.push(`- ${h.readErrors.length} authored file(s) could NOT be read back: ${s(h.readErrors.map((e) => e.path).join(", "))}`);
    if (h.scratchpadSkippedOnResume) notes.push(`- scratchpad deliverables were not captured (this is a --resume turn; #17)`);
    parts.push(
      `## Evidence health (INCOMPLETE)\nThe authored-file evidence above is NOT complete — do NOT infer content is absent just because it is not shown here:\n${notes.join("\n")}`,
    );
  }
  return capForJudge(parts.join("\n\n"), JUDGE_DOC_CAP); // aggregate backstop, over already-scrubbed content
}

// A passing check may carry an optional `evidence` string — the concrete file/value/tool/link that
// satisfied it — surfaced by `replay --explain` so a green can be trusted, not assumed vacuous. Absent
// evidence is a clean opt-out (a check with nothing concrete to cite, e.g. a verdict modifier).
type KeyResult = { pass: true; evidence?: string } | { pass: false; message: string };

/**
 * Evaluate EVERY present key (AND semantics) — a multi-key assertion passes iff all of its
 * keys pass. (The previous first-key-wins `if (a.X) return …` chain silently ignored every key
 * after the first.) The per-key logic is unchanged; each branch now PUSHES its result instead of
 * returning. The first failing key supplies the surfaced message. On the replay lane, keys that
 * cannot be evaluated (filesystem/egress, or question/gate when controlOut is absent) are stripped
 * from the object BEFORE this runs (see replayCassette), so AND never straddles replay classes.
 */
function check(
  a: Assertion,
  ctx: AssertContext,
): {
  assertion: Assertion;
  pass: boolean;
  message?: string;
  evidence?: string;
  semanticClaims?: SemanticClaimResult[];
  judgeModel?: string;
  judgeInvalid?: boolean;
} {
  const results: KeyResult[] = [];
  const ok = (evidence?: string): KeyResult => ({ pass: true, evidence });
  const fail = (message: string): KeyResult => ({ pass: false, message });
  const truncated = ctx.truncatedPaths ?? new Map<string, "size" | "readonly" | "unreadable" | "input" | undefined>();

  // Tool-name matching for tool_called / tool_not_called / subagent_tool_used / subagent_tool_absent:
  // a GLOB over the closed set of literal tool identifiers (`*` any run, `?` one char; every other char
  // literal; anchored full-match, case-sensitive). A pattern with no metachar is an exact name — so all
  // existing exact asserts are unchanged — while `mcp__workspace__*` matches any workspace tool. Reuses the
  // path-glob engine; its `/`-segment / `**` handling is inert for tool names (they contain no `/`).
  const toolMatches = (pattern: string, name: string): boolean => anyGlobMatches([pattern], name);
  // These four keys are GLOB-matched, not regex. A pattern carrying a regex-only metacharacter is almost
  // always a regex-habit slip (`mcp__*.*`, `Bash|Read`) that would match NOTHING under glob — a silent
  // false-green for the `_not_`/`_absent` direction the failure message can't reach. Warn loudly.
  const warnIfRegexish = (key: string, pattern: string): void => {
    if (/\.\*|\.\+|[|()[\]+^$]|\\[dwsb]/.test(pattern))
      warn(
        `::warning:: ${key}: "${pattern}" looks like a regex, but this key is GLOB-matched (use * and ?, not .* or | []). ` +
          `A regex-only pattern matches no tool name and can silently pass a _not_/_absent assert.\n`,
      );
  };
  const toolSample = (s: Set<string>): string => {
    const arr = [...s];
    return arr.length ? arr.slice(0, 12).join(", ") + (arr.length > 12 ? `, …(+${arr.length - 12})` : "") : "(none called)";
  };

  if (a.transcript_contains !== undefined)
    results.push(
      ctx.transcriptMissing
        ? fail(`evidence unavailable: transcript sidecar (run.jsonl) absent — cannot evaluate transcript_contains`)
        : ctx.transcript.includes(a.transcript_contains)
          ? ok(`transcript_contains: found "${a.transcript_contains}"`)
          : fail(`transcript missing "${a.transcript_contains}"`),
    );
  if (a.transcript_not_contains !== undefined)
    results.push(
      ctx.transcriptMissing
        ? fail(`evidence unavailable: transcript sidecar (run.jsonl) absent — cannot evaluate transcript_not_contains`)
        : !ctx.transcript.includes(a.transcript_not_contains)
          ? ok()
          : fail(`transcript unexpectedly contains "${a.transcript_not_contains}"`),
    );
  if (a.semantic_matches !== undefined) {
    // LIVE-ONLY. Judge results are pre-computed by runSemanticJudges (async pre-pass) into
    // ctx.semanticResults; check() only reads them, so evaluate() stays synchronous. On replay the key
    // is stripped (LIVE_ONLY_KEYS) and never reaches here.
    const judged = ctx.semanticResults?.get(a);
    const ah = ctx.authoredFilesHealth;
    if (ctx.judgeInvalid?.has(a)) {
      results.push(fail("judge grade INVALID (malformed/ambiguous after retry) — rep counts as invalid, not a pass"));
    } else if (ah && (ah.omittedPaths.length || ah.readErrors.length)) {
      // #14/#16: the judge graded a document missing authored files (dropped at the size cap, or unreadable
      // at read-back), so a "claim not satisfied" could be a false absence. Refuse the verdict.
      results.push(
        fail(
          `evidence unavailable: authored-file evidence was incomplete (${ah.omittedPaths.length} omitted at the capture cap, ${ah.readErrors.length} unreadable) — the judge graded a partial document, cannot trust the semantic verdict`,
        ),
      );
    } else if (!judged) {
      results.push(fail("evidence unavailable: semantic judge not run (semantic_matches is live-only; skipped on replay)"));
    } else {
      const passed = judged.filter((c) => c.pass).length;
      const mp = a.semantic_matches.min_pass;
      const need = mp === undefined || mp === "all" ? a.semantic_matches.rubric.length : mp;
      const failedIdx = judged.filter((c) => !c.pass).map((c) => c.index);
      results.push(
        passed >= need
          ? ok(`semantic: ${passed}/${judged.length} rubric claims passed (need ${need})`)
          : fail(`semantic: ${passed}/${judged.length} rubric claims passed (need ${need}); failed claim indices: ${failedIdx.join(",")}`),
      );
    }
  }
  if (a.tool_result_contains !== undefined) {
    const needle = a.tool_result_contains;
    if (ctx.toolResultsMissing) {
      // Mirror tool_result_not_contains: when the channel is absent, say WHY (evidence unavailable)
      // instead of the misleading substantive "no tool result contained X". #1
      results.push(fail(`evidence unavailable: tool results absent from result.json — cannot evaluate tool_result_contains`));
    } else if (ctx.toolResultTexts.some((t) => t.includes(needle))) {
      results.push(ok());
    } else {
      // No match found — but a match could sit PAST the display cap of a truncated result (assertText
      // absent). Mirror the negative branch (tool_result_not_contains): the positive assertion still fails
      // closed (evidence can't confirm it), but say WHY honestly instead of claiming the string is absent.
      const anyTruncated =
        ctx.toolResultsTruncated !== undefined && ctx.toolResultTexts.some((_, i) => ctx.toolResultsTruncated![i] === true);
      results.push(
        anyTruncated
          ? fail(
              `evidence unavailable: no captured tool result contained "${needle}", but one or more results are display-truncated (no assertText) — a match may be past the cap`,
            )
          : fail(`no tool result contained "${needle}"`),
      );
    }
  }
  if (a.tool_result_not_contains !== undefined) {
    if (ctx.toolResultsMissing) {
      results.push(fail(`evidence unavailable: tool results absent from result.json — cannot evaluate tool_result_not_contains`));
    } else {
      const forbidden = a.tool_result_not_contains;
      const positiveHit = ctx.toolResultTexts.some((t) => t.includes(forbidden));
      if (positiveHit) {
        results.push(fail(`a tool result unexpectedly contained "${forbidden}"`));
      } else {
        const hasTruncatedAbsence =
          ctx.toolResultsTruncated !== undefined &&
          ctx.toolResultTexts.some((t, i) => !t.includes(forbidden) && ctx.toolResultsTruncated![i] === true);
        results.push(
          hasTruncatedAbsence
            ? fail(
                `evidence unavailable: one or more tool results are display-truncated (no assertText) — cannot rule out forbidden substring`,
              )
            : ok(),
        );
      }
    }
  }
  // Fuzzy content for stochastic prose. All regex-building assertions are try/catch-wrapped —
  // `evaluate()` is a bare `.map(check)` with no error boundary, so a malformed pattern must be a
  // clean assertion failure, not an uncaught throw. Case-insensitive ("i").
  if (a.transcript_matches !== undefined) {
    if (ctx.transcriptMissing) {
      results.push(fail(`evidence unavailable: transcript sidecar (run.jsonl) absent — cannot evaluate transcript_matches`));
    } else {
      const c = compileUserRegex(a.transcript_matches);
      if ("error" in c) results.push(fail(`transcript_matches: bad regex "${a.transcript_matches}": ${c.error}`));
      else results.push(c.re.test(ctx.transcript) ? ok() : fail(`transcript did not match /${a.transcript_matches}/i`));
    }
  }
  if (a.transcript_not_matches !== undefined) {
    if (ctx.transcriptMissing) {
      results.push(fail(`evidence unavailable: transcript sidecar (run.jsonl) absent — cannot evaluate transcript_not_matches`));
    } else {
      const c = compileUserRegex(a.transcript_not_matches);
      if ("error" in c) results.push(fail(`transcript_not_matches: bad regex "${a.transcript_not_matches}": ${c.error}`));
      else results.push(!c.re.test(ctx.transcript) ? ok() : fail(`transcript unexpectedly matched /${a.transcript_not_matches}/i`));
    }
  }
  if (a.file_exists !== undefined) {
    const abs = containedPath(ctx.workRoot, a.file_exists);
    if (!abs) results.push(fail(`unsafe file_exists path "${a.file_exists}" — must stay under the work root (no absolute paths or "..")`));
    else {
      const relPath = relative(resolve(ctx.workRoot), abs);
      if (ctx.linkPaths?.has(relPath)) {
        // REPLAY: this path was a symlink/hardlink at record time — it materializes as a placeholder that
        // proves NOTHING about resolution. Live could RED a dangling/escaping symlink; the cassette didn't
        // capture that, so fail CLOSED rather than pass on the placeholder.
        results.push(
          fail(
            `evidence unavailable: "${a.file_exists}" was a symlink/hardlink at record time — replay can't confirm it resolves to real in-root content; re-record or assert on the deliverable`,
          ),
        );
      } else if (truncated.has(relPath)) {
        // A truncated manifest entry carries path+bytes+sha256 — positive proof the file existed at
        // record time. Existence is provable without the inlined body; only content assertions need it.
        results.push(ok());
      } else {
        // verify the real path (after symlink resolution) is still under workRoot.
        const real = containedRealPath(ctx.workRoot, abs);
        if (!real) results.push(fail(`unsafe file_exists path "${a.file_exists}" — symlink target escapes the work root`));
        else
          results.push(
            existsSync(real)
              ? ok(`file_exists: "${a.file_exists}" present under ${ctx.workRoot}`)
              : fail(`file not found: ${a.file_exists} (under ${ctx.workRoot})`),
          );
      }
    }
  }
  if (a.user_visible_artifact !== undefined) {
    const p = a.user_visible_artifact;
    const abs = containedPath(ctx.workRoot, p);
    if (!abs) {
      // normalize/contain BEFORE the prefix test so `outputs/../../x` can't pass startsWith("outputs/")
      results.push(fail(`unsafe user_visible_artifact path "${p}" — must stay under the work root (no absolute paths or "..")`));
    } else {
      const rel = relative(resolve(ctx.workRoot), abs); // normalized, guaranteed under workRoot
      if (ctx.linkPaths?.has(rel)) {
        // REPLAY: a link entry's placeholder proves existence-of-a-link, not resolution — fail closed
        // (mirror file_exists). Live could RED a dangling/escaping symlink; the cassette didn't capture it.
        results.push(
          fail(
            `evidence unavailable: "${p}" was a symlink/hardlink at record time — replay can't confirm it resolves to real in-root content; re-record or assert on the deliverable`,
          ),
        );
      } else if (truncated.has(rel)) {
        // Truncated entry proves existence (path+bytes+sha256 recorded). Promotion is a path-prefix
        // property — also knowable without the body. Pass if under a user-visible prefix.
        const visible = ctx.userVisiblePrefixes.some((pre) => rel === pre || rel.startsWith(pre + "/"));
        results.push(
          visible
            ? ok()
            : fail(`"${p}" is not under a user-visible prefix (${ctx.userVisiblePrefixes.join(", ")}) — invisible to the user in Cowork`),
        );
      } else {
        const visible = ctx.userVisiblePrefixes.some((pre) => rel === pre || rel.startsWith(pre + "/"));
        if (!visible)
          results.push(
            fail(`"${p}" is not under a user-visible prefix (${ctx.userVisiblePrefixes.join(", ")}) — invisible to the user in Cowork`),
          );
        else {
          // verify the real path (after symlink resolution) is still under workRoot.
          const real = containedRealPath(ctx.workRoot, abs);
          if (!real) results.push(fail(`unsafe user_visible_artifact path "${p}" — symlink target escapes the work root`));
          else results.push(existsSync(real) ? ok() : fail(`user-visible artifact not found: ${p}`));
        }
      }
    }
  }
  if (a.tool_called !== undefined) {
    warnIfRegexish("tool_called", a.tool_called);
    const hit = [...ctx.toolsCalled].find((t) => toolMatches(a.tool_called!, t));
    results.push(
      ctx.toolsCalledMissing
        ? // Mirror tool_not_called: a missing tool-count channel is "cannot evaluate", not "not called". #2
          fail(`evidence unavailable: tool counts absent from result.json — cannot evaluate tool_called`)
        : hit !== undefined
          ? ok(`tool_called: "${a.tool_called}" matched ${hit}`)
          : fail(`tool not called: no called tool matched "${a.tool_called}" (called: ${toolSample(ctx.toolsCalled)})`),
    );
  }
  if (a.tool_not_called !== undefined) {
    warnIfRegexish("tool_not_called", a.tool_not_called);
    const hits = [...ctx.toolsCalled].filter((t) => toolMatches(a.tool_not_called!, t));
    results.push(
      ctx.toolsCalledMissing
        ? fail(`evidence unavailable: tool counts absent from result.json — cannot evaluate tool_not_called`)
        : hits.length === 0
          ? ok()
          : fail(`tool unexpectedly called: "${a.tool_not_called}" matched ${hits.join(", ")}`),
    );
  }
  if (a.subagent_tool_used !== undefined) {
    warnIfRegexish("subagent_tool_used", a.subagent_tool_used);
    const hit = [...ctx.subagentTools].find((t) => toolMatches(a.subagent_tool_used!, t));
    results.push(
      ctx.subagentsMissing
        ? // Mirror subagent_tool_absent: a missing dispatch tree is "cannot evaluate", not "did not use". #3
          fail(`evidence unavailable: sub-agent dispatch tree absent from result.json — cannot evaluate subagent_tool_used`)
        : hit !== undefined
          ? ok(`subagent_tool_used: "${a.subagent_tool_used}" matched ${hit}`)
          : fail(`sub-agent did not use: no sub-agent tool matched "${a.subagent_tool_used}" (used: ${toolSample(ctx.subagentTools)})`),
    );
  }
  if (a.subagent_tool_absent !== undefined) {
    warnIfRegexish("subagent_tool_absent", a.subagent_tool_absent);
    const hits = [...ctx.subagentTools].filter((t) => toolMatches(a.subagent_tool_absent!, t));
    results.push(
      ctx.subagentsMissing
        ? fail(`evidence unavailable: sub-agent dispatch tree absent from result.json — cannot evaluate subagent_tool_absent`)
        : hits.length === 0
          ? ok()
          : fail(`sub-agent unexpectedly used: "${a.subagent_tool_absent}" matched ${hits.join(", ")}`),
    );
  }
  if (a.subagent_dispatched !== undefined) {
    // Match dispatchAgentType OR resolvedAgentType OR the description — skills often dispatch with only
    // a `description` (no subagent_type → dispatchAgentType "unknown"), so name-matching alone would
    // miss those. resolvedAgentType (from task_started) is strictly better evidence than dispatchAgentType
    // for a type-less dispatch that RESOLVED to e.g. "general-purpose".
    const c = compileUserRegex(a.subagent_dispatched);
    if ("error" in c) results.push(fail(`subagent_dispatched: bad regex "${a.subagent_dispatched}": ${c.error}`));
    else if (ctx.subagentsMissing)
      // Mirror the sibling subagent assertions: a missing dispatch tree is "cannot evaluate". #4
      results.push(fail(`evidence unavailable: sub-agent dispatch tree absent from result.json — cannot evaluate subagent_dispatched`));
    else
      results.push(
        ctx.subagents.some(
          (s) =>
            c.re.test(s.dispatchAgentType) ||
            (s.resolvedAgentType !== undefined && c.re.test(s.resolvedAgentType)) ||
            c.re.test(s.description ?? ""),
        )
          ? ok()
          : fail(`no sub-agent matching "${a.subagent_dispatched}" was dispatched (by type or description)`),
      );
  }
  if (a.subagent_output_contains !== undefined) {
    const { match, contains } = a.subagent_output_contains;
    if (ctx.subagentsMissing) {
      results.push(
        fail(`evidence unavailable: sub-agent dispatch tree absent from result.json — cannot evaluate subagent_output_contains`),
      );
    } else if (match !== undefined) {
      const c = compileUserRegex(match);
      if ("error" in c) results.push(fail(`subagent_output_contains: bad regex "${match}": ${c.error}`));
      else {
        const candidates = ctx.subagents.filter((s) => c.re.test(s.dispatchAgentType) || c.re.test(s.description ?? ""));
        results.push(
          candidates.some((s) => s.output?.includes(contains))
            ? ok()
            : candidates.length === 0
              ? fail(`no sub-agent matching "${match}" was dispatched`)
              : // #9: a miss against a TRUNCATED output is unverifiable, not a proven absence — the substring
                // could lie past the assert-cap cut. Only claim absence when the searched output was complete.
                candidates.some((s) => s.outputTruncated)
                ? fail(
                    `evidence unavailable: a sub-agent matching "${match}" had its output truncated at the assert cap — cannot verify it does not contain "${contains}"`,
                  )
                : fail(`no sub-agent matching "${match}" had output containing "${contains}"`),
        );
      }
    } else {
      results.push(
        ctx.subagents.some((s) => s.output?.includes(contains))
          ? ok()
          : ctx.subagents.some((s) => s.outputTruncated)
            ? fail(
                `evidence unavailable: a sub-agent's output was truncated at the assert cap — cannot verify it does not contain "${contains}"`,
              )
            : fail(`no sub-agent's output contained "${contains}"`),
      );
    }
  }
  if (a.subagent_declared_but_unused !== undefined) {
    const t = a.subagent_declared_but_unused;
    // Declared a tool but never USED it — the observable proxy for the v0.3.0 fabrication
    // class. Previously also required `toolsUsed.length === 0`, which let "declared Bash, used Read"
    // pass; dropping that clause catches the broader declared-but-unused case.
    if (ctx.subagentsMissing) {
      // Fabrication-detection assertion: find(...) returns undefined on an absent dispatch tree, which
      // would pass vacuously. Absent evidence ≠ proof no sub-agent left a tool declared-but-unused.
      results.push(
        fail(`evidence unavailable: sub-agent dispatch tree absent from result.json — cannot evaluate subagent_declared_but_unused`),
      );
    } else {
      const culprit = ctx.subagents.find((s) => s.declaredTools.includes(t) && !s.toolsUsed.some((d) => d.name === t));
      results.push(
        culprit
          ? fail(
              `sub-agent "${culprit.dispatchAgentType}" declared "${t}" but never used it (used: ${culprit.toolsUsed.map((d) => d.name).join(", ") || "none"})`,
            )
          : ok(),
      );
    }
  }
  if (a.dispatch_count_max !== undefined)
    results.push(
      ctx.subagentsMissing
        ? fail(`evidence unavailable: sub-agent dispatch tree absent from result.json — cannot evaluate dispatch_count_max`)
        : ctx.subagents.length <= a.dispatch_count_max
          ? ok()
          : fail(
              `dispatched ${ctx.subagents.length} sub-agents, max ${a.dispatch_count_max} (author-chosen budget; Cowork imposes no in-conversation Task-dispatch cap — see SPEC §10)`,
            ),
    );
  if (a.skill_triggered !== undefined) {
    const c = compileUserRegex(a.skill_triggered);
    if ("error" in c) results.push(fail(`skill_triggered: bad regex "${a.skill_triggered}": ${c.error}`));
    else if (!ctx.skillToolAvailable)
      results.push(
        fail(
          `evidence unavailable: this agent's init tool list has no "Skill" tool — cannot evaluate skill_triggered (agent-version drift?)`,
        ),
      );
    else
      results.push(
        ctx.skillsInvoked.some((s) => c.re.test(s))
          ? ok()
          : fail(`no invoked skill matched "${a.skill_triggered}" (invoked: ${ctx.skillsInvoked.join(", ") || "none"})`),
      );
  }
  if (a.max_cost_usd !== undefined)
    results.push(
      ctx.costUsd === undefined
        ? fail(`evidence unavailable: cost telemetry absent — cannot evaluate max_cost_usd`)
        : ctx.costUsd <= a.max_cost_usd
          ? ok(`max_cost_usd: $${ctx.costUsd} ≤ $${a.max_cost_usd}`)
          : fail(`cost $${ctx.costUsd} exceeds max $${a.max_cost_usd}`),
    );
  if (a.max_tokens !== undefined)
    results.push(
      ctx.tokensTotal === undefined
        ? fail(`evidence unavailable: token telemetry absent — cannot evaluate max_tokens`)
        : ctx.tokensTotal <= a.max_tokens
          ? ok(`max_tokens: ${ctx.tokensTotal} ≤ ${a.max_tokens}`)
          : fail(`${ctx.tokensTotal} tokens exceeds max ${a.max_tokens}`),
    );
  if (a.tool_calls_max !== undefined)
    results.push(
      ctx.toolCallsTotal === undefined
        ? fail(`evidence unavailable: tool-count telemetry absent — cannot evaluate tool_calls_max`)
        : ctx.toolCallsTotal <= a.tool_calls_max
          ? ok()
          : fail(`${ctx.toolCallsTotal} tool calls exceeds max ${a.tool_calls_max}`),
    );
  const evalToolNoError = (pat: string, key: string, requirePresence: boolean) => {
    const c = compileUserRegex(pat);
    if ("error" in c) return fail(`${key}: bad regex "${pat}": ${c.error}`);
    if (ctx.toolErrors === undefined) return fail(`evidence unavailable: tool-error telemetry absent — cannot evaluate ${key}`);
    const matching = Object.entries(ctx.toolErrors).filter(([name]) => c.re.test(name));
    if (matching.length === 0)
      // A regex that matched no tool can't prove the tool ran error-free. Presence-required by default
      // (a typo'd regex must not silently pass); the _if_called variant opts into the lenient pass.
      return requirePresence
        ? fail(
            `${key}: no tool matching "${pat}" was called — cannot verify it ran error-free (use tool_no_error_if_called to pass when the tool may legitimately not run)`,
          )
        : ok();
    const errored = matching.filter(([, v]) => v.errors > 0);
    return errored.length === 0
      ? ok()
      : fail(`tool(s) matching "${pat}" had errors: ${errored.map(([n, v]) => `${n} (${v.errors})`).join(", ")}`);
  };
  if (a.tool_no_error !== undefined) results.push(evalToolNoError(a.tool_no_error, "tool_no_error", true));
  if (a.tool_no_error_if_called !== undefined) results.push(evalToolNoError(a.tool_no_error_if_called, "tool_no_error_if_called", false));
  if (a.max_tool_errors !== undefined)
    results.push(
      ctx.toolErrorsTotal === undefined
        ? fail(`evidence unavailable: tool-error telemetry absent — cannot evaluate max_tool_errors`)
        : ctx.toolErrorsTotal <= a.max_tool_errors
          ? ok()
          : fail(`${ctx.toolErrorsTotal} tool errors exceeds max ${a.max_tool_errors}`),
    );
  if (a.max_redundant_tool_calls !== undefined)
    results.push(
      ctx.redundantCallsTotal === undefined
        ? fail(`evidence unavailable: redundant-call telemetry absent — cannot evaluate max_redundant_tool_calls`)
        : ctx.redundantCallsTotal <= a.max_redundant_tool_calls
          ? ok()
          : fail(`${ctx.redundantCallsTotal} wasted redundant call(s) exceeds max ${a.max_redundant_tool_calls}`),
    );
  if (a.max_turns !== undefined)
    results.push(
      ctx.turns === undefined
        ? fail(`evidence unavailable: turn telemetry absent — cannot evaluate max_turns`)
        : ctx.turns <= a.max_turns
          ? ok()
          : fail(`${ctx.turns} turns exceeds max ${a.max_turns}`),
    );
  if (a.compaction_occurred !== undefined)
    results.push(
      ctx.contextEvents === undefined
        ? fail(`compaction_occurred: no context events captured (older run / lane without context events) — cannot verify`)
        : ctx.contextEvents.some((e) => e.subtype === "compact_boundary")
          ? ok()
          : fail(`compaction_occurred: no compact_boundary event was recorded`),
    );
  if (a.no_mcp_error !== undefined) {
    if (ctx.mcpErrors === undefined)
      results.push(fail(`no_mcp_error: live-only — mcp errors are not reconstructible on replay (re-record to check)`));
    else {
      const bad = ctx.mcpErrors[0];
      results.push(ctx.mcpErrors.length === 0 ? ok() : fail(`no_mcp_error: server "${bad!.server}" failed: ${bad!.message}`));
    }
  }
  if (a.max_peak_rss_bytes !== undefined) {
    if (ctx.resources === undefined)
      results.push(fail(`max_peak_rss_bytes: live-only — no resource sampling on this lane (replay/protocol) — cannot verify`));
    else if (ctx.resources.malformedLines)
      results.push(
        fail(
          `max_peak_rss_bytes: ${ctx.resources.malformedLines} malformed resource sample line(s) — telemetry is corrupt, cannot verify (malformed)`,
        ),
      );
    else if (ctx.resources.peakRssBytes === undefined)
      results.push(fail(`max_peak_rss_bytes: sampling captured no RSS value — cannot verify`));
    else if (ctx.resources.peakRssBytes <= a.max_peak_rss_bytes) results.push(ok());
    else results.push(fail(`max_peak_rss_bytes: peak RSS ${ctx.resources.peakRssBytes} > ${a.max_peak_rss_bytes}`));
  }
  if (a.hook_blocked !== undefined) {
    const c = compileUserRegex(a.hook_blocked);
    if ("error" in c) results.push(fail(`hook_blocked: bad regex "${a.hook_blocked}": ${c.error}`));
    else if (ctx.hookEvents === undefined)
      results.push(fail(`hook_blocked: no hook events (older run / replay without controlOut) — cannot verify`));
    else {
      const hit = ctx.hookEvents.find((h) => h.decision === "block" && h.tool !== undefined && c.re.test(h.tool));
      results.push(hit ? ok() : fail(`hook_blocked: no blocked tool matched "${a.hook_blocked}"`));
    }
  }
  if (a.no_hook_blocked !== undefined) {
    if (ctx.hookEvents === undefined)
      results.push(fail(`no_hook_blocked: no hook events (older run / replay without controlOut) — cannot verify`));
    else {
      const blk = ctx.hookEvents.find((h) => h.decision === "block");
      results.push(
        blk ? fail(`no_hook_blocked: "${blk.tool ?? blk.callbackId}" was blocked${blk.reason ? ` (${blk.reason})` : ""}`) : ok(),
      );
    }
  }
  if (a.no_scratchpad_leak !== undefined) {
    // present_files is served ONLY on the container tier (binary-verified against real Cowork: hostloop/
    // microvm/protocol don't advertise the tool, so `presentedFiles` is always [] there and the leak check
    // below would pass VACUOUSLY). Gate on the tier: anything but container is unsupported → can't-verify,
    // never a silent green. `effectiveFidelity` is populated on every lane's ctx (live/replay/verify-run).
    if (ctx.effectiveFidelity !== "container")
      results.push(
        fail(
          `no_scratchpad_leak: present_files is served only on the container tier (this run: ${ctx.effectiveFidelity ?? "unknown"}) — cannot verify; use fidelity: container for present_files-based delivery`,
        ),
      );
    else if (ctx.evidenceErrors?.presentFilesMalformed)
      results.push(
        fail(
          `no_scratchpad_leak: ${ctx.evidenceErrors.presentFilesMalformed} malformed/unclassifiable present_files call(s) — leak evidence is incomplete, cannot verify (e.g. malformed input, or no cwd to classify scratchpad membership)`,
        ),
      );
    else if (ctx.presentedFiles === undefined)
      results.push(fail(`no_scratchpad_leak: no present_files telemetry recorded for this run — cannot verify`));
    else {
      const leaked = ctx.presentedFiles.find((p) => p.leaked);
      results.push(leaked ? fail(`no_scratchpad_leak: "${leaked.from}" was presented but never left the scratchpad`) : ok());
    }
  }
  if (a.present_files_called !== undefined) {
    // The presence companion to no_scratchpad_leak (which is a vacuous pass when nothing was presented).
    // Same container-tier gate: present_files is only served there, so a missing delivery on another tier
    // is "cannot verify," never a false negative.
    if (ctx.effectiveFidelity !== "container")
      results.push(
        fail(
          `present_files_called: present_files is served only on the container tier (this run: ${ctx.effectiveFidelity ?? "unknown"}) — cannot verify; use fidelity: container for present_files-based delivery`,
        ),
      );
    else if (ctx.presentedFiles === undefined || ctx.presentedFiles.length === 0)
      results.push(fail(`present_files_called: no file was delivered via present_files (the tool was never called)`));
    else results.push(ok());
  }
  if (a.no_skill_triggered !== undefined) {
    const c = compileUserRegex(a.no_skill_triggered);
    if ("error" in c) results.push(fail(`no_skill_triggered: bad regex "${a.no_skill_triggered}": ${c.error}`));
    else if (!ctx.skillToolAvailable)
      results.push(
        fail(
          `evidence unavailable: this agent's init tool list has no "Skill" tool — cannot evaluate no_skill_triggered (agent-version drift?)`,
        ),
      );
    else if (ctx.skillsInvokedMissing)
      results.push(fail(`evidence unavailable: skill invocation list absent from result.json — cannot evaluate no_skill_triggered`));
    else
      results.push(
        !ctx.skillsInvoked.some((s) => c.re.test(s)) ? ok() : fail(`skill unexpectedly triggered matching "${a.no_skill_triggered}"`),
      );
  }
  if (a.skill_available !== undefined) {
    const c = compileUserRegex(a.skill_available);
    if ("error" in c) results.push(fail(`skill_available: bad regex "${a.skill_available}": ${c.error}`));
    else if (ctx.availableSkills === undefined)
      results.push(fail(`evidence unavailable: availableSkills absent from result.json — cannot evaluate skill_available`));
    else results.push(ctx.availableSkills.some((s) => c.re.test(s.id)) ? ok() : fail(`no staged skill matched "${a.skill_available}"`));
  }
  if (a.connector_available !== undefined) {
    const c = compileUserRegex(a.connector_available);
    if ("error" in c) results.push(fail(`connector_available: bad regex "${a.connector_available}": ${c.error}`));
    else if (ctx.mcpServers === undefined)
      results.push(fail(`evidence unavailable: mcpServers absent from result.json — cannot evaluate connector_available`));
    else
      results.push(ctx.mcpServers.some((s) => c.re.test(String(s.name))) ? ok() : fail(`no connector matched "${a.connector_available}"`));
  }
  if (a.tool_available !== undefined) {
    const c = compileUserRegex(a.tool_available);
    if ("error" in c) results.push(fail(`tool_available: bad regex "${a.tool_available}": ${c.error}`));
    else if (ctx.availableTools === undefined)
      results.push(fail(`evidence unavailable: availableTools absent from result.json — cannot evaluate tool_available`));
    else results.push(ctx.availableTools.some((t) => c.re.test(t)) ? ok() : fail(`no available tool matched "${a.tool_available}"`));
  }
  if (a.skill_tool_used !== undefined) {
    const { skill, tool } = a.skill_tool_used;
    if (ctx.skillActivity === undefined) {
      results.push(fail(`evidence unavailable: skill-activity telemetry absent from result.json — cannot evaluate skill_tool_used`));
    } else {
      const skillRe = compileUserRegex(skill);
      const toolRe = compileUserRegex(tool);
      if ("error" in skillRe) results.push(fail(`skill_tool_used: bad regex "${skill}": ${skillRe.error}`));
      else if ("error" in toolRe) results.push(fail(`skill_tool_used: bad regex "${tool}": ${toolRe.error}`));
      else {
        const matchingWindows = ctx.skillActivity.filter((w) => skillRe.re.test(w.skillId));
        const found = matchingWindows.some((w) => Object.keys(w.toolCounts).some((t) => toolRe.re.test(t)));
        results.push(
          found
            ? ok()
            : fail(
                matchingWindows.length === 0
                  ? `no skill-activation window matched "${skill}"`
                  : `no tool matching "${tool}" ran inside a window matching "${skill}"`,
              ),
        );
      }
    }
  }
  if (a.all_tasks_completed !== undefined) {
    if (ctx.tasks === undefined)
      results.push(fail(`evidence unavailable: tasks telemetry absent from result.json — cannot evaluate all_tasks_completed`));
    else if (ctx.evidenceErrors?.taskTracking)
      results.push(
        fail(
          `all_tasks_completed: ${ctx.evidenceErrors.taskTracking} TaskCreate result(s) were unparseable — task telemetry is incomplete, cannot verify (malformed)`,
        ),
      );
    else if (ctx.tasks.length === 0)
      // Presence-required: a run with zero tasks cannot have "completed them all". Assert task_count_min
      // (or drop this) if a task-free run is legitimate.
      results.push(
        fail(`all_tasks_completed: no tasks were created — cannot verify completion (assert task_count_min for presence, or drop this)`),
      );
    else
      results.push(
        ctx.tasks.every((t) => t.status === "completed")
          ? ok()
          : fail(
              `not all tasks are completed: ${ctx.tasks
                .filter((t) => t.status !== "completed")
                .map((t) => `${t.subject} (${t.status})`)
                .join(", ")}`,
            ),
      );
  }
  if (a.task_count_min !== undefined) {
    if (ctx.tasks === undefined)
      results.push(fail(`evidence unavailable: tasks telemetry absent from result.json — cannot evaluate task_count_min`));
    else if (ctx.evidenceErrors?.taskTracking)
      results.push(
        fail(
          `task_count_min: ${ctx.evidenceErrors.taskTracking} TaskCreate result(s) were unparseable — task count is under-reported, cannot verify (malformed)`,
        ),
      );
    else
      results.push(
        ctx.tasks.length >= a.task_count_min
          ? ok()
          : fail(`task_count_min: ${ctx.tasks.length} task(s) created, need ≥ ${a.task_count_min}`),
      );
  }
  if (a.task_status !== undefined) {
    const { match, status } = a.task_status;
    if (ctx.tasks === undefined)
      results.push(fail(`evidence unavailable: tasks telemetry absent from result.json — cannot evaluate task_status`));
    else if (ctx.evidenceErrors?.taskTracking)
      // Mirror all_tasks_completed / task_count_min: known-corrupt TaskCreate telemetry means the surviving
      // task subset is incomplete, so a status match against it could pass against demonstrably-partial
      // evidence. Refuse to evaluate rather than pass on a subset. #6
      results.push(
        fail(
          `task_status: ${ctx.evidenceErrors.taskTracking} TaskCreate result(s) were unparseable — task telemetry is incomplete, cannot verify (malformed)`,
        ),
      );
    else {
      const c = compileUserRegex(match);
      if ("error" in c) results.push(fail(`task_status: bad regex "${match}": ${c.error}`));
      else {
        const found = ctx.tasks.find((t) => c.re.test(t.subject) || c.re.test(t.id));
        results.push(
          found === undefined
            ? fail(`no task matched "${match}"`)
            : found.status === status
              ? ok()
              : fail(`task "${found.subject}" matched "${match}" but has status "${found.status}", expected "${status}"`),
        );
      }
    }
  }
  if (a.egress_denied !== undefined)
    results.push(
      ctx.egressMissing
        ? fail(`evidence unavailable: egress log absent from result.json — cannot evaluate egress_denied`)
        : ctx.egress.some((e) => hostMatches(e.host, a.egress_denied!) && e.decision === "deny")
          ? ok()
          : fail(`expected egress denied: ${a.egress_denied}`),
    );
  if (a.egress_allowed !== undefined)
    results.push(
      ctx.egressMissing
        ? fail(`evidence unavailable: egress log absent from result.json — cannot evaluate egress_allowed`)
        : ctx.egress.some((e) => hostMatches(e.host, a.egress_allowed!) && e.decision === "allow")
          ? ok()
          : fail(`expected egress allowed: ${a.egress_allowed}`),
    );
  if (a.no_delete_in_outputs !== undefined)
    results.push(
      ctx.scanMissing
        ? fail(`evidence unavailable: post-run scan absent from result.json — cannot evaluate no_delete_in_outputs`)
        : ctx.outputsDeletes.length === 0
          ? ok()
          : fail(`delete op(s) touched outputs (forbidden in Cowork): ${ctx.outputsDeletes.slice(0, 3).join("; ")}`),
    );
  if (a.no_unexpected_files !== undefined) {
    if (ctx.preRunOrigin === "remote-unavailable" || ctx.preRunOrigin === "local-unreadable") {
      results.push(
        fail(
          `evidence unavailable: pre-run manifest origin is ${ctx.preRunOrigin} (${ctx.preRunOrigin === "remote-unavailable" ? "a cloud run's filesystem is not locally observable" : "a connected-folder source was unreadable, so the baseline is incomplete"}) — cannot compute created files`,
        ),
      );
    } else if (ctx.preRunPaths === undefined) {
      results.push(
        fail(
          "evidence unavailable: no pre-run manifest for this run/cassette (predates 0.24 or tier cannot capture — microvm) — cannot compute created files; re-run/re-record on container/hostloop",
        ),
      );
    } else {
      const pre = new Set(ctx.preRunPaths.map((p) => p.replace(/\\/g, "/")));
      // Path-walk (not the content walk): it EMITS symlink/hardlink paths, so an agent-created link stray
      // is visible here. The pre-run baseline uses the same walk (see capturePreRunManifest), so a
      // pre-existing link is in `pre` and is not falsely flagged as created — BUT only if that baseline was
      // itself captured link-aware. On a re-verified PRE-#38 run dir (`preRunLinkAware` false) the baseline
      // never listed symlinks, so exclude link entries here too and compare on the same links-blind basis;
      // otherwise every pre-existing symlink would false-stray. (Moot on replay: the materialized tree has
      // no real symlinks.)
      const walk = collectArtifactPathsWithHealth(ctx.workRoot, ctx.userVisiblePrefixes);
      if (!walk.complete) {
        // #18: an incomplete walk (an unreadable subtree — EACCES, etc.) can HIDE a stray, so "no strays
        // found" would be a vacuous pass. Require a complete filesystem observation for this absence check.
        results.push(
          fail(
            `evidence unavailable: the post-run filesystem walk was incomplete (${walk.errors
              .map((e) => `${e.path || "<root>"}: ${e.error}`)
              .join("; ")}) — cannot prove no unexpected files were created`,
          ),
        );
      } else {
        const post = walk.entries.filter((e) => ctx.preRunLinkAware || !e.linkKind).map((e) => e.path);
        const created = post.filter((p) => !pre.has(p.replace(/\\/g, "/")));
        const stray = created.filter((p) => !anyGlobMatches(a.no_unexpected_files!, p));
        results.push(
          stray.length === 0
            ? ok()
            : fail(
                `unexpected file(s) created outside the allowlist: ${stray.join(", ")} (allow: ${a.no_unexpected_files!.join(", ") || "(none)"})`,
              ),
        );
      }
    }
  }
  if (a.input_unmodified !== undefined) {
    if (ctx.preRunOrigin === "remote-unavailable" || ctx.preRunOrigin === "local-unreadable") {
      results.push(
        fail(
          `evidence unavailable: pre-run manifest origin is ${ctx.preRunOrigin} (${ctx.preRunOrigin === "remote-unavailable" ? "a cloud run's filesystem is not locally observable" : "a connected-folder source was unreadable, so the baseline is incomplete"}) — cannot compare content`,
        ),
      );
    } else if (ctx.preRunHashes === undefined) {
      results.push(
        fail(
          "evidence unavailable: no pre-run hash manifest for this run/cassette (predates the fingerprinted manifest, or a tier that cannot capture — microvm) — cannot compare content; re-run/re-record on container/hostloop",
        ),
      );
    } else {
      const globs = Array.isArray(a.input_unmodified) ? a.input_unmodified : [a.input_unmodified]; // accept a bare string
      const matched = Object.keys(ctx.preRunHashes).filter((p) => anyGlobMatches(globs, p));
      const modified: string[] = []; // present post-run with a different hash
      const removed: string[] = []; // gone post-run (deletion is also a content change)
      const uncheckable: string[] = [];
      for (const p of matched) {
        const pre = ctx.preRunHashes[p];
        if (pre === null) {
          uncheckable.push(p);
          continue;
        }
        let post: string | null;
        if (ctx.postRunHashes !== undefined) {
          // Replay lane: authoritative post-run hash from the cassette manifest (the materialized tree
          // has 0-byte placeholders for body-less entries, so re-hashing it would be wrong). Absent ⇒
          // the file isn't in the post-run tree ⇒ removed.
          post = ctx.postRunHashes[p] ?? null;
        } else {
          // Live / verify-run: re-hash the real file. Throw (gone/unreadable) ⇒ removed.
          try {
            post = createHash("sha256")
              .update(readFileSync(join(ctx.workRoot, p)))
              .digest("hex");
          } catch {
            post = null;
          }
        }
        if (post === null) removed.push(p);
        else if (post !== pre) modified.push(p);
      }
      // uncheckable dominates: if any matched path is unmeasurable, don't imply the rest were fully
      // checked — surface evidence-unavailable rather than a clean verdict.
      if (uncheckable.length)
        results.push(
          fail(
            `evidence unavailable: pre-run hash missing (over size cap) for: ${uncheckable.slice(0, 5).join(", ")} — raise COWORK_HARNESS_PRERUN_HASH_CAP or narrow the glob`,
          ),
        );
      else if (modified.length || removed.length) {
        // A change under a READ-ONLY connected folder root can't be the agent's doing — the mount is bound
        // `:ro`, so the agent physically cannot write/delete there. Such a change is therefore EXTERNAL (a
        // user editing the live folder mid-run — the hostloop live-folder-window exposure) → evidence-
        // contaminated, NOT an agent violation. Only changes the agent COULD have made (writable roots) are
        // a real input_unmodified violation.
        const roRoots = ctx.readonlyFolderRoots ?? [];
        const underRo = (p: string) => roRoots.some((r) => p === r || p.startsWith(`${r}/`));
        const external = [...modified, ...removed].filter(underRo);
        const agentChanged = { modified: modified.filter((p) => !underRo(p)), removed: removed.filter((p) => !underRo(p)) };
        if (agentChanged.modified.length || agentChanged.removed.length) {
          const parts: string[] = [];
          if (agentChanged.modified.length) parts.push(`modified in place: ${agentChanged.modified.slice(0, 5).join(", ")}`);
          if (agentChanged.removed.length) parts.push(`removed: ${agentChanged.removed.slice(0, 5).join(", ")}`);
          results.push(fail(`pre-existing file(s) changed — ${parts.join("; ")}`));
        } else {
          // Every change was under a read-only root → external mutation, can't attribute to the agent.
          results.push(
            fail(
              `evidence contaminated: pre-existing file(s) under a read-only connected folder changed mid-run (${external
                .slice(0, 5)
                .join(", ")}) — the agent cannot write there, so this is an EXTERNAL edit; cannot verify input integrity`,
            ),
          );
        }
      } else results.push(ok());
    }
  }
  if (a.self_heal_ran !== undefined)
    results.push(
      ctx.scanMissing
        ? fail(`evidence unavailable: post-run scan absent from result.json — cannot evaluate self_heal_ran`)
        : ctx.selfHealRan === a.self_heal_ran
          ? ok()
          : fail(`self_heal_ran was ${ctx.selfHealRan}, expected ${a.self_heal_ran}`),
    );
  // Verdict modifiers (consumed by computeVerdict, not here) each always "pass" as an assertion, so a
  // standalone `{allow_*: true}` is a valid non-empty assertion, not "empty assertion". Derived from the
  // single VERDICT_MODIFIER_KEYS list so a newly-added modifier can never miss this branch again.
  for (const k of VERDICT_MODIFIER_KEYS) if (a[k] !== undefined) results.push(ok());
  if (a.transcript_no_host_path !== undefined)
    results.push(
      ctx.scanMissing
        ? fail(`evidence unavailable: post-run scan absent from result.json — cannot evaluate transcript_no_host_path`)
        : !ctx.hostPathLeaked === a.transcript_no_host_path
          ? ok()
          : fail(`host path leaked into model-visible text: ${ctx.hostPathLeaked}`),
    );
  const evalComputerLinks = (key: string, requirePresence: boolean) => {
    if (ctx.transcriptMissing) return fail(`evidence unavailable: transcript sidecar (run.jsonl) absent — cannot evaluate ${key}`);
    const links = extractComputerLinks(ctx.transcript);
    if (links.length === 0)
      // Presence-required by default: zero links can't prove a deliverable link resolves. The
      // _if_present variant opts into the lenient vacuous pass.
      return requirePresence
        ? fail(
            `${key}: no computer:// link in the transcript — cannot verify a deliverable link resolves (use computer_links_resolve_if_present to pass when no link is expected)`,
          )
        : ok(`${key}: no computer:// links in the transcript (vacuous pass — _if_present)`);
    if (!ctx.linkResolution)
      return fail(
        `evidence unavailable: no link-resolution context wired for this lane — cannot evaluate ${key} (${links.length} link(s) found)`,
      );
    const tierNote = ctx.effectiveFidelity ? ` (tier: ${ctx.effectiveFidelity})` : "";
    const dangling = links
      .map((link) => ({ link, outcome: resolveComputerLink(link, ctx.workRoot, ctx.linkResolution!) }))
      .filter(({ outcome }) => !outcome.resolved)
      .map(({ link, outcome }) => `computer://${link.raw} — checked ${outcome.checkedDescription}`);
    return dangling.length === 0
      ? ok(`${key}: ${links.length} computer:// link(s) all resolved${tierNote}`)
      : fail(`dangling computer:// link(s)${tierNote}: ${dangling.join("; ")}`);
  };
  if (a.computer_links_resolve !== undefined) results.push(evalComputerLinks("computer_links_resolve", true));
  if (a.computer_links_resolve_if_present !== undefined) results.push(evalComputerLinks("computer_links_resolve_if_present", false));
  if (a.question_asked !== undefined) {
    if (ctx.questionsMissing) {
      results.push(fail(`evidence unavailable: questions sidecar (trace.json) absent — cannot evaluate question_asked`));
    } else {
      const c = compileUserRegex(a.question_asked);
      if ("error" in c) results.push(fail(`question_asked: bad regex "${a.question_asked}": ${c.error}`));
      else results.push(ctx.questions.some((q) => c.re.test(q)) ? ok() : fail(`no question matched: ${a.question_asked}`));
    }
  }
  if (a.questions_count_max !== undefined)
    results.push(
      ctx.questionsMissing
        ? fail(`evidence unavailable: questions sidecar (trace.json) absent — cannot evaluate questions_count_max`)
        : ctx.questions.length <= a.questions_count_max
          ? ok()
          : fail(`asked ${ctx.questions.length} questions, max ${a.questions_count_max}`),
    );
  if (a.gate_answers_delivered !== undefined) {
    // Passes iff every answered gate's tool_result was OBSERVED and non-error. On a finished
    // run/cassette, an unobserved delivery (delivered=null) is NOT neutral — it is absence of the
    // evidence the assertion requires, so it fails loud ("no silent false-greens"). `delivered:
    // false` is a real errored tool_result; `null` is "no tool_result observed for this gate".
    // Zero gates fired passes vacuously (whether a gate fires is model-dependent) — pair with
    // gate_answer_count_min to also require presence. Missing telemetry (gateDeliveriesMissing)
    // is NOT the same as zero gates and must fail evidence-unavailable, not vacuous-pass.
    if (ctx.gateDeliveriesMissing) {
      results.push(fail(`evidence unavailable: gate-delivery telemetry absent from result.json — cannot evaluate gate_answers_delivered`));
    } else if (a.gate_answers_delivered) {
      const bad = ctx.gateDeliveries.filter((g) => g.delivered !== true);
      results.push(
        bad.length === 0
          ? ok()
          : fail(
              `gate answer(s) not confirmed delivered to the model: ${bad
                .map(
                  (g) =>
                    `"${g.question}" (${
                      g.delivered === false
                        ? (g.error ?? "tool error")
                        : g.reason === "no-pairing-metadata"
                          ? "no pairing metadata — gate had no toolUseId"
                          : "delivery unobserved — no tool_result for this gate"
                    })`,
                )
                .join("; ")}`,
            ),
      );
    } else {
      // inverse: expect a CONFIRMED delivery failure (a real errored tool_result), not merely unobserved.
      const failedConfirmed = ctx.gateDeliveries.filter((g) => g.delivered === false);
      results.push(failedConfirmed.length > 0 ? ok() : fail(`expected a confirmed gate-delivery failure but none was observed`));
    }
  }
  if (a.gate_answer_count_min !== undefined) {
    if (ctx.gateDeliveriesMissing) {
      results.push(fail(`evidence unavailable: gate-delivery telemetry absent from result.json — cannot evaluate gate_answer_count_min`));
    } else {
      const delivered = ctx.gateDeliveries.filter((g) => g.delivered === true).length;
      results.push(
        delivered >= a.gate_answer_count_min
          ? ok()
          : fail(`only ${delivered} gate answer(s) confirmed delivered, need ≥ ${a.gate_answer_count_min}`),
      );
    }
  }
  if (a.artifact_json !== undefined) {
    const aj = a.artifact_json;
    const file = containedPath(ctx.workRoot, aj.artifact);
    if (!file) results.push(fail(`unsafe artifact_json path "${aj.artifact}" — must stay under the work root (no absolute paths or "..")`));
    else {
      // verify the real path (after symlink resolution) is still under workRoot.
      const realFile = containedRealPath(ctx.workRoot, file);
      // A body-less manifest entry (a read-only connected-folder input, or an artifact over the body
      // cap) has no content in the cassette — artifact_json cannot be evaluated on replay (the 0-byte
      // placeholder isn't parseable). To keep record/verify-run/replay SYMMETRIC (no green-record →
      // red-replay), treat such a target as evidence-unavailable on EVERY lane: `truncatedPaths` flags
      // it on replay; `readonlyFolderRoots` flags the read-only-input case on the live/verify-run lanes
      // where the real file is still on disk. (Existence keys stay green — existence is provable from
      // the recorded hash — but content is genuinely absent, so this fails loud, never vacuous.)
      const rel = relative(resolve(ctx.workRoot), file);
      // Reason sources by lane: LIVE/verify-run derive read-only from `readonlyFolderRoots`
      // (no manifest exists at eval time); REPLAY reads the per-entry `truncationReason` off the
      // materialized manifest (`truncated.get(rel)`). Keeping both is complementary, not redundant.
      const liveReadonly = (ctx.readonlyFolderRoots ?? []).some((pre) => rel === pre || rel.startsWith(pre + "/"));
      const replayReason = truncated.get(rel); // undefined if not body-less on replay, or a pre-v8 entry with no reason
      const isReadonlyInput = liveReadonly || replayReason === "readonly";
      const isUploadInput = replayReason === "input"; // an uploaded file — captured hash-only, body deliberately absent
      const isOverCap = replayReason === "size";
      const bodyLess = truncated.has(rel) || liveReadonly;
      if (!realFile) {
        results.push(fail(`unsafe artifact_json path "${aj.artifact}" — symlink target escapes the work root`));
      } else if (!existsSync(realFile)) {
        results.push(fail(`artifact_json: file not found: ${aj.artifact} (under ${ctx.workRoot})`));
      } else if (bodyLess) {
        // Precise remedy when the cause is known (read-only ⇒ assert on a deliverable; over-cap ⇒ raise
        // the cap). A pre-v8 entry carries no reason ⇒ name both causes (we can't tell). "unreadable"
        // also falls here — it's a record-time read failure, so the both-causes text is the safe hint.
        const cause = isUploadInput
          ? `(an uploaded input — its content is captured hash-only, never inlined; assert artifact_json on a deliverable instead)`
          : isReadonlyInput
            ? `(read-only connected-folder input — its content is never captured; assert artifact_json on a deliverable instead)`
            : isOverCap
              ? `(larger than the artifact-body cap — raise --max-artifact-bytes to capture it)`
              : `(a read-only connected-folder input, or an artifact larger than the body cap — if an input, assert on a deliverable; if a large deliverable, raise --max-artifact-bytes)`;
        results.push(
          fail(
            `evidence unavailable: artifact_json target "${aj.artifact}" was captured body-less ` +
              cause +
              ` — content is not in the cassette, so it cannot be evaluated on replay`,
          ),
        );
      } else {
        let doc: unknown;
        let parsed = true;
        const fileSizeLimit = 10 * 1024 * 1024;
        // statSync must be inside the same guard as readFileSync: evaluate()/check() are synchronous with no
        // error boundary, so a TOCTOU/EACCES/IO error here (the file existed at existsSync but stat/read
        // throws) would crash verification instead of failing the assertion.
        try {
          const fileSize = statSync(realFile).size;
          if (fileSize > fileSizeLimit) {
            results.push(fail(`artifact_json: file too large to parse as JSON (${fileSize} bytes, limit 10 MiB)`));
            parsed = false;
          }
          if (parsed) doc = JSON.parse(readFileSync(realFile, "utf8"));
        } catch (e) {
          parsed = false;
          results.push(fail(`artifact_json: ${aj.artifact} could not be read/parsed as JSON: ${String((e as Error).message)}`));
        }
        if (parsed) {
          const r = resolveDotPath(doc, aj.path);
          if (r.state === "unresolved") {
            // Malformed/truncated artifact for this path — fail loud, NOT a vacuous "absent" pass (the
            // false-green at the field level).
            results.push(
              fail(`artifact_json: path "${aj.path}" unresolvable in ${aj.artifact} — intermediate "${r.at}" is missing or not an object`),
            );
          } else {
            const present = r.state === "value";
            const val = r.state === "value" ? r.value : undefined;
            let any = false;
            if (aj.exists !== undefined) {
              any = true;
              results.push(
                present === aj.exists ? ok() : fail(`artifact_json: "${aj.path ?? "(root)"}" exists=${present}, expected ${aj.exists}`),
              );
            }
            if (aj.absent !== undefined) {
              any = true;
              const absent = r.state === "absent";
              results.push(absent === aj.absent ? ok() : fail(`artifact_json: "${aj.path}" absent=${absent}, expected ${aj.absent}`));
            }
            if (aj.is_null !== undefined) {
              any = true;
              if (!present) {
                results.push(
                  fail(
                    `artifact_json: "${aj.path ?? "(root)"}" is_null: path is absent — cannot determine null-ness (use absent: true to assert absence)`,
                  ),
                );
              } else {
                const isNull = val === null;
                results.push(
                  isNull === aj.is_null ? ok() : fail(`artifact_json: "${aj.path ?? "(root)"}" is_null=${isNull}, expected ${aj.is_null}`),
                );
              }
            }
            if (aj.equals !== undefined) {
              any = true;
              results.push(
                present && jsonEq(val, aj.equals)
                  ? ok()
                  : fail(`artifact_json: "${aj.path}" = ${JSON.stringify(val)}, expected ${JSON.stringify(aj.equals)}`),
              );
            }
            if (aj.gt !== undefined) {
              any = true;
              results.push(
                typeof val === "number" && val > aj.gt
                  ? ok()
                  : fail(`artifact_json: "${aj.path}" = ${JSON.stringify(val)}, expected > ${aj.gt}`),
              );
            }
            // Set membership — the resolved value deep-equals one of a fixed set. Stable for stochastic
            // (LLM-extracted) values where `equals` would churn across re-records. `present &&` guard mirrors
            // `equals` so an absent value never vacuously satisfies it.
            if (aj.in !== undefined) {
              any = true;
              results.push(
                present && Array.isArray(aj.in) && aj.in.some((x) => jsonEq(val, x))
                  ? ok()
                  : fail(`artifact_json: "${aj.path}" = ${JSON.stringify(val)}, expected one of ${JSON.stringify(aj.in)}`),
              );
            }
            // No operator → an existence assertion (the value must be present).
            if (!any)
              results.push(
                present ? ok() : fail(`artifact_json: "${aj.path ?? "(root)"}" is not present (no operator given → existence check)`),
              );
          }
        }
      }
    }
  }
  // VM-path-boundary + path-denial assertions. `VM_PATH` is exact-or-prefix — NEVER a bare
  // `startsWith("/sessions")`, which would wrongly match "/sessionsfoo". `hostloopOnly` mirrors the
  // no_scratchpad_leak tier-gate precedent above: on a non-hostloop tier /sessions/... is a VALID VM
  // path (no path hook exists there), so excluding the key could green a wrong-tier scenario — it must
  // FAIL "cannot verify" instead.
  const VM_PATH = (p: string | undefined): boolean => p !== undefined && (p === "/sessions" || p.startsWith("/sessions/"));
  const hostloopOnly = (key: string): KeyResult | null =>
    ctx.effectiveFidelity !== "hostloop"
      ? fail(
          `${key}: hostloop-only — /sessions/... is valid and there is no path hook on tier "${ctx.effectiveFidelity ?? "unknown"}" — cannot verify; pin fidelity: hostloop`,
        )
      : null;

  if (a.no_vm_path_file_op !== undefined) {
    const gate = hostloopOnly("no_vm_path_file_op");
    if (gate) results.push(gate);
    else if (ctx.fileToolAttempts === undefined) results.push(fail("no_vm_path_file_op: no attempt telemetry (older run) — cannot verify"));
    else {
      const hit = ctx.fileToolAttempts.find((at) => VM_PATH(at.paths.file_path) || VM_PATH(at.paths.path));
      results.push(
        hit ? fail(`no_vm_path_file_op: ${hit.tool} (${hit.origin}) attempted VM path "${hit.paths.file_path ?? hit.paths.path}"`) : ok(),
      );
    }
  }
  if (a.vm_path_denied !== undefined) {
    const gate = hostloopOnly("vm_path_denied");
    if (gate) results.push(gate);
    else if (ctx.pathDenials === undefined)
      results.push(fail("vm_path_denied: no path-denial telemetry (older run / replay without controlOut) — cannot verify"));
    else results.push(ctx.pathDenials.some((d) => VM_PATH(d.path)) ? ok() : fail("vm_path_denied: no /sessions-targeted denial recorded"));
  }
  if (a.path_denied !== undefined) {
    const gate = hostloopOnly("path_denied");
    if (gate) results.push(gate);
    else if (ctx.pathDenials === undefined)
      results.push(fail("path_denied: no path-denial telemetry (older run / replay without controlOut) — cannot verify"));
    else {
      const q = a.path_denied;
      const re = q.path_matches ? compileUserRegex(q.path_matches) : undefined;
      if (re && "error" in re) results.push(fail(`path_denied: bad regex "${q.path_matches}": ${re.error}`));
      else {
        const hit = ctx.pathDenials.find(
          (d) =>
            (q.tool === undefined || toolMatches(q.tool, d.tool)) &&
            (q.source === undefined || d.source === q.source) &&
            (re === undefined || (d.path !== undefined && (re as { re: RegExp }).re.test(d.path))) &&
            (q.agent_scope === undefined || q.agent_scope === "any" || (q.agent_scope === "subagent") === (d.agentId !== undefined)),
        );
        results.push(
          hit ? ok(`${hit.source}: ${hit.tool} ${hit.path ?? ""}`) : fail("path_denied: no recorded denial matched all matchers"),
        );
      }
    }
  }
  if (a.no_path_denied !== undefined) {
    const gate = hostloopOnly("no_path_denied");
    if (gate) results.push(gate);
    else if (ctx.pathDenials === undefined)
      results.push(fail("no_path_denied: no path-denial telemetry (older run / replay without controlOut) — cannot verify"));
    else {
      const d = ctx.pathDenials[0];
      results.push(d ? fail(`no_path_denied: ${d.source} denied ${d.tool} on "${d.path ?? "?"}"`) : ok());
    }
  }
  if (a.subagent_file_write !== undefined) {
    if (ctx.fileToolAttempts === undefined || ctx.toolResults === undefined)
      results.push(fail("subagent_file_write: attempt/result telemetry unavailable (older run) — cannot verify"));
    else {
      const q = a.subagent_file_write;
      const writeTools = q.tool
        ? (n: string) => toolMatches(q.tool!, n)
        : (n: string) => n === "Write" || n === "Edit" || n === "MultiEdit";
      // exact when `path` is given, else suffix — `path` is deliberately the stronger match (a
      // foo/artifacts/probe.json write must not satisfy an `artifacts/probe.json` suffix query).
      const pathMatch = (gp: string | undefined): boolean =>
        gp !== undefined && (q.path !== undefined ? gp === q.path : gp.endsWith(q.path_suffix!));
      const chain = ctx.fileToolAttempts.find(
        (at) =>
          at.origin === "subagent" &&
          writeTools(at.tool) &&
          pathMatch(at.gatePath) &&
          at.toolUseId !== undefined &&
          ctx.toolResults!.some((r) => r.toolUseId === at.toolUseId && !r.isError),
      );
      const want = q.path !== undefined ? `== "${q.path}"` : `ending "${q.path_suffix}"`;
      results.push(
        chain
          ? ok(`${chain.tool} ${chain.gatePath}`)
          : fail(
              `subagent_file_write: no SUB-AGENT-origin ${q.tool ?? "Write/Edit/MultiEdit"} attempt with path ${want} and a non-error paired result`,
            ),
      );
    }
  }

  if (a.result !== undefined)
    results.push(ctx.result === a.result ? ok(`result: ${ctx.result}`) : fail(`result was ${ctx.result}, expected ${a.result}`));

  if (results.length === 0) return { assertion: a, pass: false, message: "empty assertion" };
  // Structured per-claim results for a semantic_matches assert (undefined for every other key) — so a
  // consumer gets the per-claim profile, not just the summary message. Attached to fail AND pass.
  const semanticClaims = a.semantic_matches !== undefined ? ctx.semanticResults?.get(a) : undefined;
  const judgeModel = a.semantic_matches !== undefined ? ctx.judgeModels?.get(a) : undefined;
  const judgeInvalid = a.semantic_matches !== undefined && ctx.judgeInvalid?.has(a) ? true : undefined;
  const withClaims = <T extends object>(r: T): T => ({
    ...r,
    ...(semanticClaims ? { semanticClaims } : {}),
    ...(judgeModel ? { judgeModel } : {}),
    ...(judgeInvalid ? { judgeInvalid } : {}),
  });
  const firstFail = results.find((r): r is { pass: false; message: string } => !r.pass);
  if (firstFail) return withClaims({ assertion: a, pass: false, message: firstFail.message });
  // All keys passed — gather the evidence each surfaced (AND-joined, one entry per key that cited something).
  const evidence = results
    .map((r) => (r as { evidence?: string }).evidence)
    .filter(Boolean)
    .join("; ");
  return withClaims(evidence ? { assertion: a, pass: true, evidence } : { assertion: a, pass: true });
}
