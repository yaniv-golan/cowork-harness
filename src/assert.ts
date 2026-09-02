import { existsSync, readFileSync, statSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, relative, isAbsolute, sep, dirname, extname } from "node:path";
import type { Assertion, RunResult, UsageInfo, CostInfo } from "./types.js";
import { VERDICT_MODIFIER_KEYS } from "./types.js";
import { compileUserRegex } from "./regex.js";
import { normalizeHost } from "./boundary-paths.js";
import { extractComputerLinks, resolveComputerLink, type LinkResolutionContext } from "./run/computer-links.js";
import { scrub } from "./secrets.js";
import { warn } from "./io.js";
import { authoredTotalBytes, collectArtifactPathsWithHealth, isLosslessUtf8 } from "./run/artifacts.js";
import { analyzeArtifacts } from "./run/analyze-artifact.js";
import { anyGlobMatches } from "./glob.js";
import { toolNameSpellings } from "./run/tool-name-canonicalization.js";
import { isVmSessionsPath } from "./vm-paths.js";

/** Bytes cap for re-hashing a matched input file on the live / verify-run lane (`input_unmodified`).
 *  Mirrors the pre-run manifest's 50 MiB default and the same env override so the post-run re-hash is
 *  bounded exactly like the baseline it compares against — a file that grows huge DURING the run would
 *  otherwise be `readFileSync`'d whole here. Over-cap ⇒ evidence-unavailable, never a silent pass. */
function postRunHashCap(): number {
  const env = process.env.COWORK_HARNESS_PRERUN_HASH_CAP;
  if (env === undefined || env === "") return 50 * 1024 * 1024;
  const n = Number(env);
  return Number.isInteger(n) && n > 0 ? n : 50 * 1024 * 1024;
}

/** Resolve a manifest-supplied relative path against `workRoot`, rejecting anything that is not a
 *  normalized in-root relative path (absolute, `..` escape, or a NUL). Returns the absolute path when
 *  safe, else null. The manifest is trusted evidence in normal operation, but a hand-edited manifest, a
 *  future producer, or a hostile run dir handed to `verify-run` could carry a traversal key; this stops
 *  input hashing from reading OUTSIDE the retained workspace or comparing the wrong file. */
function resolveContainedManifestPath(workRoot: string, p: string): string | null {
  if (typeof p !== "string" || p.length === 0 || p.includes("\0")) return null;
  if (isAbsolute(p)) return null;
  const abs = resolve(workRoot, p);
  const rel = relative(workRoot, abs);
  if (rel === "" || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) return null;
  return abs;
}

/** The assertion keys that can ONLY be evaluated at `fidelity: hostloop` — on any other tier each one
 *  FAILS "cannot verify" rather than being skipped (see `hostloopOnly` in `check()`), because
 *  `/sessions/...` is a valid path there and no path hook exists, so a skip could green a wrong-tier
 *  scenario.
 *
 *  Exported because one caller outside the evaluator has to reason about the set: the host-inventory
 *  record refusal (`src/run/cassette.ts`) recommends re-recording at `container`, which is advice a
 *  scenario asserting any of these CANNOT take. A hand-copied list there would rot exactly the way the
 *  `--out`-outside-the-repo advice it replaces did. `test/hostloop-only-keys.test.ts` pins this array
 *  against the `hostloopOnly("…")` call sites by scanning this file's source. */
/** The founder-visible strings of one gate, as SEPARATE fields: its question label, then every option's
 *  label and description. The evidence behind `question_context`.
 *
 *  Sourced from RunRecord.gateOptions, i.e. the ASK-TIME AskUserQuestion payload the model emitted — never
 *  from a tool_result. That distinction is the key's whole value: a skill's producer script typically also
 *  writes the same sentence into its own gate-state file, so a `tool_result_matches` on that phrase grades
 *  true whether or not the model ever surfaced it. This function can only ever see what was actually
 *  offered.
 *
 *  RETURNS A LIST, and the evaluator tests each entry separately, so a pattern can never match text spanning
 *  two fields. An earlier version returned one newline-joined string and claimed the newline prevented that.
 *  It did not, and it was measured doing the opposite: on the committed multiselect example,
 *  `invoicing[\s\S]*Audit logging` stitched one option's DESCRIPTION to the next option's LABEL and passed —
 *  a "sentence" no one was ever shown. The neighbouring transcript keys' docs actively teach `[\s\S]` for
 *  spanning turns, so that is the habit an author brings to this key. Structure beats a documented caveat. */
export function gateVisibleFields(g: { question: string; options: { label: string; description?: string }[] }): string[] {
  const parts = [g.question];
  for (const o of g.options) {
    parts.push(o.label);
    if (o.description !== undefined) parts.push(o.description);
  }
  return parts;
}

/** Order-insensitive multiset equality over option labels — `question_options` with `order: "any"`.
 *  A multiset, not a Set: a gate that offered the same label twice is a different offer from one that
 *  offered it once, and collapsing them would green a duplicated option. */
function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const counts = new Map<string, number>();
  for (const x of a) counts.set(x, (counts.get(x) ?? 0) + 1);
  for (const y of b) {
    const n = counts.get(y);
    if (!n) return false;
    counts.set(y, n - 1);
  }
  return true;
}

export const HOSTLOOP_ONLY_KEYS: (keyof Assertion)[] = [
  "no_vm_path_file_op",
  "vm_path_denied",
  "path_denied",
  "no_path_denied",
  "subagent_dispatch_healthy",
];

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
/** WHY a `semantic_matches` assert refused, or WHAT a scoped one graded — the typed companion to the
 *  prose message, mirrored onto `RunResult.assertions[].semanticEvidence`. There are four distinct
 *  evidence-unavailable causes with four different fixes; a consumer (usually an agent iterating on a
 *  skill) must be able to tell them apart without regex-scraping English. Same rationale as `judgeInvalid`.
 *  Kept structurally identical to the `RunResult` field in types.ts — that is the persisted contract. */
export type SemanticEvidence = NonNullable<RunResult["assertions"][number]["semanticEvidence"]>;

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
  /** Per-assert facts about the DOCUMENT that was composed for a `semantic_matches` grade — populated by
   *  runSemanticJudges, which is the only place that knows them (composing is where the caps bite).
   *  `evidenceCut` is true when the aggregate `JUDGE_DOC_CAP` truncated the authored-file evidence (or the
   *  evidence-health note that tells the judge not to read an absence as a negative). Without this the
   *  raise-the-budget remedy would just move incompleteness from a loud refusal into a silent cut. */
  semanticDocInfo?: Map<Assertion, { evidenceCut: boolean; healthNoteCut: boolean; overflowSection?: string }>;
  /** The agent's final answer (SDK result text) — the first part of the judged document, so a
   *  correct *inline* answer is graded even when no file is written. */
  finalMessage?: string;
  /** Files the run authored (final on-disk content) — appended to the judged document so the judge grades
   *  what the skill PRODUCED, not only what it inlined. Populated on every live sandbox tier (microvm
   *  included — its session tree is snapshotted from the VM into the run dir); absent on replay. */
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
   *  fail evidence-unavailable when set, rather than the misleading "expected egress denied". */
  egressMissing?: boolean;
  result: "success" | "error";
  workRoot: string; // dir under which file_exists paths resolve (L0: work/, L1/L2: work/session/mnt)
  userVisiblePrefixes: string[]; // path prefixes promoted to the user (e.g. outputs, .projects)
  /** workRoot-relative paths under userVisiblePrefixes BEFORE the agent ran (RunResult.preRunPaths /
   *  cassette.preRunPaths). undefined = no pre-run manifest (a --resume run, or an older run/cassette) —
   *  no_unexpected_files then fails evidence-unavailable, never vacuous-passes. (microvm captures it now —
   *  its session tree is snapshotted from the VM into the run dir.) */
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
  /** Per-mount delete detections across every delete-denied mount, incl. outputs. Superset of
   *  `outputsDeletes`. OPTIONAL: a run recorded before this field existed simply has none, which is not
   *  the same as evidence-unavailable — that case is `scanMissing`, and it is handled separately. */
  mountDeletes?: { mount: string; command: string }[];
  /** Mount names waived by `allow_delete_in` across the WHOLE assert array. Resolved in `evaluate()`
   *  because `check()` only ever sees one assertion and the two keys can sit in separate entries. */
  deleteWaivedMounts?: string[];
  questions: string[]; // AskUserQuestion question texts asked
  /** Per sub-question, the option set the model OFFERED — the evidence behind `question_options`.
   *  Captured at ask time (RunRecord.gateOptions), so it includes a gate that was shown and then denied,
   *  stalled or left unanswered. Optional so hand-built test fixtures keep compiling; absent is treated
   *  as evidence-MISSING by the evaluator (never "no gates"), together with `gateOptionsMissing`. */
  gateOptions?: { question: string; options: { label: string; description?: string }[]; multiSelect?: boolean }[];
  /** Set when the lane could not read the gate-option evidence at all: a truncated-cassette replay, or a
   *  verify-run dir whose `events.jsonl` is absent or partly corrupt. Prevents question_options from
   *  passing over an empty list it never populated. */
  gateOptionsMissing?: boolean;
  hostPathLeaked: boolean; // a host path (/Users//opt) appeared in model-visible text
  selfHealRan: boolean; // a /sessions/<id>/mnt plugin script was invoked (plugin-root self-heal)
  subagents: {
    // Optional (not required) so existing hand-built test fixtures that omit it keep compiling — every
    // real construction site (live/replay/verify-run) passes RunResult.subagents through untouched, which
    // always carries it (types.ts, non-optional there). A dispatch missing it here can never correlate to
    // a fileToolAttempts entry (real "subagent"-origin attempts always carry a defined parentToolUseId
    // matching a real dispatch's toolUseId), so subagent_dispatch_healthy fails closed rather than mismatching.
    toolUseId?: string;
    dispatchAgentType: string;
    resolvedAgentType?: string; // the BINARY-resolved child type from task_started — strictly better evidence than dispatchAgentType for a type-less dispatch
    declaredTools: string[];
    toolsUsed: Array<{ name: string; count: number }>;
    description?: string;
    output?: string;
    outputTruncated?: boolean; // output was cut at the assert cap — a negative content check is unverifiable
    /** RunResult.subagents[].reasoning — the on-disk child-transcript channel. Read ONLY by
     *  `semantic_matches: {include_subagent_text: true}`, which folds the `kind:"text"` turns into the
     *  judged document. Undefined on replay (the child transcript exists only where the real agent ran). */
    reasoning?: Array<{ kind: "thinking" | "text"; text: string; redacted?: boolean }>;
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
  /** Every skill reference/script file the run OBSERVED being reached, with the channel(s) — the wide
   *  signal behind `reference_read` / `no_observed_reference_access`.
   *
   *  `undefined` means the run recorded no observable tool stream (a replay error result, a torn partial
   *  result, or a result.json written before the field existed) — NOT "no accesses". Both keys fail on
   *  `undefined`, including the negative one: that is the direction that would otherwise pass vacuously,
   *  and a vacuous pass here reads as a clean result. An empty array is the real negative. */
  referencesAccessed?: Array<{ path: string; via: string[] }>;
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
  /** The scenario's declared Cowork lane — which delivery contract this run is held to. Absent ⇒ local,
   *  so every pre-existing scenario keeps its meaning. See `Scenario.lane`. */
  lane?: "local" | "remote";
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
  /** RunResult.context.tools — the SDK's init-event tool manifest, i.e. the run's EAGERLY-LOADED tools.
   *  It is NOT the complete callable surface: a factory-DEFERRED tool (native or MCP) is loaded on demand
   *  via a ToolSearch `select:` round-trip and surfaces in a system-reminder, not in init.tools — so
   *  tool_available can false-NEGATIVE on a genuinely-available deferred tool. Capturing the deferred set
   *  is a known gap, not yet implemented. The skill/plugin discovery tools (`mcp__skills__list_skills`,
   *  `mcp__skills__suggest_skills`, `mcp__plugins__list_plugins`, `mcp__plugins__search_plugins`,
   *  `mcp__plugins__suggest_plugin_install`) are a PARTIAL exception: `container`/`hostloop` (and `cowork`,
   *  which resolves to one of those) now model them as `alwaysLoad` SDK-MCP tools (see
   *  `hostloop/skills-handler.ts`/`plugins-handler.ts`), so they DO appear here at those tiers — but
   *  `microvm`/`protocol` still declare no such server, so a miss on those tiers is still "not modeled",
   *  not "provably unavailable". Undefined means no context telemetry was recorded (an older run that
   *  never captured this field) — the evidence-unavailable signal for tool_available; an empty `[]` is a
   *  valid "no tools" state and is NOT the same as undefined. */
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
  /** RunResult.presentFilesCalls — the redaction-invariant PRESENCE count `present_files_called` reads
   *  (see RunResult's own doc comment). Undefined on a run predating the field; the assertion then falls
   *  back to `presentedFiles` being non-empty, which is what it always used to read. */
  presentFilesCalls?: RunResult["presentFilesCalls"];
  /** RunResult.resources — resource-usage telemetry sampled while the run executed. Undefined means the
   *  tier never sampled (protocol/replay, a run shorter than one sample interval, or an unavailable probe
   *  tool) — the evidence-unavailable signal for max_peak_rss_bytes; never a vacuous pass. */
  resources?: RunResult["resources"];
  /** Companion malformed-telemetry counters (see RunResult.evidenceErrors). A >0 count makes the dependent
   *  assertion fail "malformed" instead of silently dropping the bad entries. */
  evidenceErrors?: RunResult["evidenceErrors"];
}

/**
 * Expand `expect_denied:` into `egress_denied` assertions. Lives here, exported, because `evaluate()`
 * does not handle `expect_denied` and BOTH call sites (the live run and the verify path) previously
 * hand-rolled the same loop — so a fix to one silently missed the other.
 *
 * The three outcomes are deliberately distinct, and the third is the reason this exists. "Your host was
 * not denied" and "the proxy recorded nothing whatsoever" are very different diagnoses: the second means
 * the evidence channel itself produced nothing, so the assertion had nothing to evaluate rather than
 * evaluating to false. Collapsing them into one message is how a tier whose shell could reach no host at
 * all read the same as a tier that correctly denied the host you asked about.
 *
 * `egressMissing` is the stronger, *known*-absent signal (an old result.json with no `egress` field);
 * the empty-array case cannot distinguish "log never written" from "run made no network calls", so it
 * says only what is true — nothing was recorded.
 */
export function expandExpectDenied(
  hosts: string[],
  egress: { host: string; decision: string }[],
  egressMissing?: boolean,
): RunResult["assertions"] {
  return hosts.map((host) => {
    const assertion = { egress_denied: host };
    if (egressMissing)
      return {
        assertion,
        pass: false,
        message: `evidence unavailable: egress log absent from result.json — cannot evaluate egress_denied for ${host}`,
      };
    if (egress.length === 0)
      return {
        assertion,
        pass: false,
        message: `expected ${host} to be denied, but no egress decisions were recorded at all — the proxy evaluated nothing, so this is an absent evidence channel rather than an allowed host`,
      };
    return {
      assertion,
      pass: egress.some((e) => hostMatches(e.host, host) && e.decision === "deny"),
      message: `expected ${host} to be denied`,
    };
  });
}

export function evaluate(assertions: Assertion[], ctx: AssertContext): RunResult["assertions"] {
  // `allow_delete_in` waives per mount across the whole array; resolve it once here since `check()`
  // cannot see sibling entries.
  const deleteWaivedMounts = [...new Set(assertions.flatMap((a) => a.allow_delete_in ?? []))];
  const withWaivers = deleteWaivedMounts.length ? { ...ctx, deleteWaivedMounts } : ctx;
  // MIXING scoped and unscoped `semantic_matches` in one scenario is a cross-assert hazard `check()`
  // cannot see: `evidence_files` is collected scenario-wide into the capture's `priorityGlobs`, and the
  // per-file exemption that grants therefore applies to the SINGLE shared capture — so scoping assert A
  // changes which bytes assert B gets, while B still refuses on any omission. Warned once per evaluation,
  // here, because this is the only place that sees the whole array.
  const sem = assertions.filter((a) => a.semantic_matches !== undefined);
  const scopedCount = sem.filter((a) => (a.semantic_matches?.evidence_files?.length ?? 0) > 0).length;
  // Fires for ANY multi-assert scenario carrying a scope, not only a MIXED one. The interference comes from
  // `priorityGlobs` being the UNION across asserts plus the per-file-cap exemption, and neither cares whether
  // the other asserts are scoped — two SCOPED asserts collide harder (both files exempt, so the starvation is
  // larger), and a `scopedCount < sem.length` condition is silent on exactly that worse case.
  if (sem.length > 1 && scopedCount > 0)
    warn(
      `::warning:: this scenario has ${sem.length} semantic_matches asserts (${scopedCount} scoped) sharing ONE authored-file ` +
        `capture. An evidence_files scope exempts its files from the per-file cap, so it changes how many bytes the OTHER asserts' ` +
        `evidence gets — one assert can starve another into an omission that assert then refuses on, with nothing in its message ` +
        `pointing back here. Give each the narrowest scope covering its own rubric, and raise ` +
        `$COWORK_HARNESS_AUTHORED_TOTAL_BYTES so they all fit.\n`,
    );
  return assertions.map((a) => check(a, withWaivers));
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
  if (!ctx.semanticDocInfo) ctx.semanticDocInfo = new Map();
  // The judged document depends on TWO per-assert inputs — `include_subagent_text` and the
  // `evidence_files` scope — so the cache MUST be keyed on both. Keyed on the boolean alone (as it was
  // when the scope did not exist), two asserts with different scopes would silently share the first
  // one's document and grade against the wrong evidence. Memoize rather than rebuild per assert:
  // composing scrubs + caps every section, which is real work on a long run with many authored files.
  const docCache = new Map<string, ReturnType<typeof composeJudgedDocument>>();
  const judgedDocument = (withSubagents: boolean, scope: string[] | undefined): ReturnType<typeof composeJudgedDocument> => {
    const key = `${withSubagents ? 1 : 0}::${scope ? JSON.stringify(scope) : ""}`;
    let d = docCache.get(key);
    if (d === undefined) {
      d = composeJudgedDocument(ctx, withSubagents, scope); // finalMessage + transcript [+ sub-agent text] + authored files, scrubbed
      docCache.set(key, d);
    }
    return d;
  };
  for (const a of assertions) {
    if (a.semantic_matches === undefined) continue;
    const built = judgedDocument(a.semantic_matches.include_subagent_text === true, a.semantic_matches.evidence_files);
    const answer = built.doc;
    ctx.semanticDocInfo.set(a, {
      evidenceCut: built.evidenceCut,
      healthNoteCut: built.healthNoteCut,
      overflowSection: built.overflowSection,
    });
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
// Per-section and aggregate character budgets for the judged document. Authored files already carry
// their own caps (16 KiB/file, 64 KiB total, in captureAuthoredFiles), but finalMessage and the transcript
// were previously concatenated WHOLE — so a long run could overflow the model context or make grading cost
// and latency unbounded. Cap each section and the joined document with an explicit truncation marker, so the
// judge SEES that evidence was elided (never reads a truncated tail as "the requirement was not met").
const JUDGE_FINAL_CAP = 32 * 1024;
const JUDGE_TRANSCRIPT_CAP = 128 * 1024;
const JUDGE_DOC_CAP = 256 * 1024;
/** Per-dispatch cap for opt-in sub-agent text. Deliberately smaller than the transcript cap: a wide
 *  fan-out multiplies this by the dispatch count, and the aggregate JUDGE_DOC_CAP backstop would
 *  otherwise be spent entirely on sub-agent chatter, truncating the final answer out of the document. */
const JUDGE_SUBAGENT_CAP = 16 * 1024;
function capForJudge(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n…[${text.length - cap} chars truncated for the judge input budget — evidence beyond this point was NOT shown; do not infer absence from this cut]`;
}

/** Partition the run's authored-file evidence against a `semantic_matches.evidence_files` scope.
 *
 *  ONE definition, used by both the document composer and the check — if the two disagreed about what is
 *  in scope, the judge would grade one set while the refusal reasoned about another.
 *
 *  `matchedAny` is over authored ∪ omitted ∪ unreadable ON PURPOSE: a glob naming a file the run *tried*
 *  to author but dropped at the cap has matched something real, and must produce the specific
 *  "in-scope file omitted" refusal — not the generic "your glob matched nothing", which would send the
 *  author hunting for a typo that isn't there. */
export function scopeAuthoredEvidence(
  ctx: AssertContext,
  globs: string[] | undefined,
): { files: import("./run/artifacts.js").AuthoredFile[]; omitted: string[]; unreadable: string[]; matchedAny: boolean } {
  const all = ctx.authoredFiles ?? [];
  const h = ctx.authoredFilesHealth;
  if (!globs || globs.length === 0)
    return { files: all, omitted: h?.omittedPaths ?? [], unreadable: (h?.readErrors ?? []).map((e) => e.path), matchedAny: true };
  const hit = (p: string): boolean => anyGlobMatches(globs, p);
  const files = all.filter((f) => hit(f.path));
  const omitted = (h?.omittedPaths ?? []).filter(hit);
  const unreadable = (h?.readErrors ?? []).map((e) => e.path).filter(hit);
  return { files, omitted, unreadable, matchedAny: files.length + omitted.length + unreadable.length > 0 };
}

/** Every authored path the run produced or tried to produce, sorted — the list a `scope_matched_nothing`
 *  failure prints. Nothing else in the harness surfaces these (they never reach `trace`/`inspect`/`diff`),
 *  so an author or agent writing a glob has no other way to learn the `<root>/<rel>` key shape. Printing
 *  the list, not a count, is what makes the mistake self-correcting from the failure alone. */
export function allAuthoredPaths(ctx: AssertContext): string[] {
  const h = ctx.authoredFilesHealth;
  return [
    ...new Set([...(ctx.authoredFiles ?? []).map((f) => f.path), ...(h?.omittedPaths ?? []), ...(h?.readErrors ?? []).map((e) => e.path)]),
  ].sort();
}

export function buildJudgedDocument(ctx: AssertContext, includeSubagentText = false, scopeGlobs?: string[]): string {
  return composeJudgedDocument(ctx, includeSubagentText, scopeGlobs).doc;
}

/** `buildJudgedDocument` plus the one fact the caller cannot recover from the returned string: whether the
 *  aggregate cap ate into the authored evidence (or the health note that qualifies it). */
export function composeJudgedDocument(
  ctx: AssertContext,
  includeSubagentText = false,
  scopeGlobs?: string[],
): { doc: string; evidenceCut: boolean; healthNoteCut: boolean; overflowSection?: string } {
  // SCRUB BEFORE CAP: scrub is exact-string replacement, so a secret straddling a cap boundary would
  // be truncated mid-token and slip past scrub into the doc sent to the (external) judge. Scrub each raw
  // section FIRST, then cap the already-redacted text — capping redacted content can never re-expose a secret.
  const secrets = ctx.secrets ?? [];
  const s = (t: string): string => (secrets.length ? scrub(t, secrets) : t);
  const parts: string[] = [];
  if (ctx.finalMessage) parts.push(`## Final answer\n${capForJudge(s(ctx.finalMessage), JUDGE_FINAL_CAP)}`);
  parts.push(`## Transcript\n${capForJudge(s(ctx.transcript ?? ""), JUDGE_TRANSCRIPT_CAP)}`);
  // OPT-IN sub-agent text. `ctx.transcript` carries top-level assistant_text ONLY (run.ts drops any
  // event with a parentToolUseId), so for a fan-out skill the bulk of the actual work is invisible to
  // the judge. This folds it back in on request. Two deliberate constraints:
  //   - `kind:"text"` ONLY. A sub-agent THINKING turn arrives with an empty string and redacted:true
  //     (the SDK suppresses sub-agent thinking, leaving only a signature), so including those would pad
  //     the document with blank blocks a judge could misread as "the sub-agent did nothing".
  //   - Opt-in, never default. Enlarging the judged document can re-grade an existing rubric, and a
  //     silent grade change across an upgrade is exactly the kind of drift a gate must not have.
  // `reasoning` is undefined on replay (child transcripts exist only where the real agent ran); the
  // section is then simply absent, which is honest — semantic_matches is live-only anyway.
  if (includeSubagentText) {
    for (const [i, sa] of (ctx.subagents ?? []).entries()) {
      const text = (sa.reasoning ?? [])
        .filter((t) => t.kind === "text" && t.text)
        .map((t) => t.text)
        .join("\n\n");
      if (!text) continue;
      const label = sa.description ?? sa.resolvedAgentType ?? sa.dispatchAgentType ?? `#${i + 1}`;
      parts.push(`## Sub-agent output: ${s(label)}\n${capForJudge(s(text), JUDGE_SUBAGENT_CAP)}`);
    }
  }
  // AUTHORED is not DELIVERED. The capture deliberately includes the scratchpad (the run DID write those
  // files, and production's sandbox would too), but production DISCARDS anything outside `mnt/` — its own
  // sub-agent prompt: "never reaches the user or your file tools". Unlabelled, a rubric like "the report
  // was written" grades TRUE on a file the user never receives — the harness's own false-green, inside the
  // one evaluator that reads free-form prose and cannot infer the convention.
  //
  // The distinction is already carried in the path: the scratchpad walk emits a synthetic `scratchpad/`
  // prefix (run/artifacts.ts). This only makes it legible to the judge, rather than restructuring the set.
  // `scratchpad` is NOT in RESERVED_MOUNT_NAMES, so a user may connect a folder with that exact name.
  // Its files then arrive workRoot-relative as `scratchpad/…` — indistinguishable by prefix from the
  // synthetic walk. Labelling those would hand the judge a FALSE statement ("NOT delivered" about a file
  // the user does receive) and false-RED a "was the report delivered?" rubric. A wrong claim is worse
  // than a missing one, so the collision disables the label rather than guessing.
  // `?? []` because a partial AssertContext (tests, and any caller building one by hand) may omit this;
  // an absent prefix list means "nothing is user-visible", which keeps the label ON — the safe direction.
  const scratchIsUserVisible = (ctx.userVisiblePrefixes ?? []).some((p) => p === "scratchpad" || p === SCRATCHPAD_PREFIX);
  let sawScratch = false;
  let authoredCount = 0;
  // SCOPED (`semantic_matches.evidence_files`): only the named authored files reach the judge. The
  // evidence-health note below still reports EVERY omission — narrowing what is graded must not narrow
  // what the judge is told about the capture.
  for (const f of scopeAuthoredEvidence(ctx, scopeGlobs).files) {
    authoredCount++;
    const scratch = !scratchIsUserVisible && f.path.startsWith(SCRATCHPAD_PREFIX);
    sawScratch ||= scratch;
    const tag = scratch ? " — SCRATCH, NOT delivered to the user" : "";
    parts.push(`## Authored file: ${s(f.path)}${tag}${f.truncated ? " (truncated)" : ""}\n${s(f.content)}`);
  }
  if (sawScratch)
    parts.push(
      "## Note on scratch files\nFiles marked SCRATCH were written to the session's scratch area, which is " +
        "discarded and never reaches the user. Treat them as working intermediates: they are evidence of what " +
        "the run DID, and are NOT evidence that anything was delivered, saved, shared, or produced for the user.",
    );
  // End of the AUTHORED-EVIDENCE region (files + the SCRATCH qualifier). Everything the judge is asked to
  // grade lives at or before this index — the boundary the aggregate cap is measured against below.
  const authoredEnd = parts.length;
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
  // Did the aggregate cap eat into the evidence? Measured as the OFFSET AT WHICH each region ends, not as
  // "the document overflowed at all" — an earlier, blunter version of this compared `doc.length` to the cap
  // and refused whenever ANYTHING was trimmed. That false-failed the common shape where every graded byte
  // survived and only the trailing health note (which, under a scope, is entirely about files the scope
  // declared irrelevant) was clipped. Measured in chars to match `capForJudge`, over already-scrubbed text
  // — scrub changes lengths, and the capture budget's units are bytes, so the two must not be mixed.
  const lenUpTo = (n: number): number => parts.slice(0, n).join("\n\n").length;
  const doc = parts.join("\n\n");
  const overflowed = doc.length > JUDGE_DOC_CAP;
  // `authoredCount > 0` guard: with nothing authored there is no authored evidence TO cut, and reporting
  // one would be a refusal with no possible remedy.
  const evidenceCut = overflowed && authoredCount > 0 && lenUpTo(authoredEnd) > JUDGE_DOC_CAP;
  // Weaker, separate signal: the note telling the judge not to read an absence as a negative was clipped
  // while the graded evidence itself survived. Advisory, never a refusal — for an UNSCOPED assert a
  // non-empty health note already refuses on the capture side, and for a scoped one the note is about
  // out-of-scope files by construction.
  // `parts.length > authoredEnd` is the real condition — it asks whether a section EXISTS after the authored
  // region (the health note is the only one there). Comparing `lenUpTo(parts.length)` to the cap merely
  // restates `overflowed`, and warned about trimming a note that had never been composed.
  const healthNoteCut = overflowed && !evidenceCut && parts.length > authoredEnd;
  // Which section the cut landed in — so the refusal can name the cause instead of pointing at a lever
  // that cannot move it (a document overflowing on sub-agent text is not fixed by narrowing a file scope).
  let overflowSection: string | undefined;
  if (overflowed)
    for (let i = 0; i < parts.length; i++)
      if (lenUpTo(i + 1) > JUDGE_DOC_CAP) {
        overflowSection = parts[i].split("\n", 1)[0].replace(/^## /, "");
        break;
      }
  return { doc: capForJudge(doc, JUDGE_DOC_CAP), evidenceCut, healthNoteCut, overflowSection }; // aggregate backstop
}

// A passing check may carry an optional `evidence` string — the concrete file/value/tool/link that
// satisfied it — surfaced by `replay --explain` so a green can be trusted, not assumed vacuous. Absent
// evidence is a clean opt-out (a check with nothing concrete to cite, e.g. a verdict modifier).
type KeyResult = { pass: true; evidence?: string } | { pass: false; message: string };

// ------------------------------------------------------------------------------------------------- //
// no_lost_write_back — run the shipped static Tier A analyzer over the files this run authored, so a
// scenario can GATE on "the agent didn't emit an interactive artifact whose Submit is lost under Cowork".
// ------------------------------------------------------------------------------------------------- //

/** Tier A source extensions — a **superset** of `analyze-artifact.ts`'s `SOURCE_EXTS`, deliberately: this
 *  set PRE-filters the authored candidate set (so could-not-verify reasoning stays per-source), while
 *  `analyzeArtifacts` re-filters internally and drops `.ts`/`.jsx`/`.tsx` as out of scope (acorn cannot
 *  parse TS/JSX — see the note on `CODE_EXTS` there). Do **not** "sync" the two sets; they differ on purpose. */
const WRITE_BACK_SOURCE_EXTS = new Set([".html", ".htm", ".js", ".mjs", ".ts", ".jsx", ".tsx", ".py"]);
const SCRATCHPAD_PREFIX = "scratchpad/";

/**
 * Evaluate `no_lost_write_back`. Selects the files the run authored (from `ctx.authoredFiles`, plus the
 * capture-health `omittedPaths`/`readErrors` so a dropped/unreadable authored source is never treated as
 * clean), resolves each to its real on-disk absolute path (scratchpad entries carry a synthetic
 * `scratchpad/<rel>` prefix whose real path lives under `dirname(workRoot)`), and runs the deterministic
 * static analyzer `analyzeArtifacts` over them.
 *
 *  - Any `artifact-write-back-lost` finding on an agent-authored source (reserved root, or a newly ADDED
 *    file on a read-write connected mount) → FAIL.
 *  - A `-lost` finding on a MODIFIED file on a read-write connected mount (a user's pre-existing HTML the
 *    skill edited) is downgraded to advisory — not the skill's failure to own; surfaced, never a hard fail.
 *  - `-suspect` findings → PASS with the advisory surfaced.
 *  - Missing pre-run manifest (a `--resume` run, or a run predating the manifest seam), a scratchpad walk
 *    skipped on `--resume`, an unresolvable scratchpad path, or an `analysisFailure` on a produced
 *    candidate → could-not-verify (fail-closed), never a silent clean. (Every live sandbox tier captures
 *    a manifest now, microvm included — its session tree is snapshotted from the VM into the run dir.)
 */
function checkNoLostWriteBack(ctx: AssertContext): KeyResult {
  // No pre-run manifest → captureAuthoredFiles can't diff, so we cannot know what the run authored. This
  // is a `--resume` run (no fresh manifest) or a pre-seam run — evidence-unavailable, never a silent clean.
  if (ctx.preRunHashes === undefined) {
    return {
      pass: false,
      message:
        "evidence unavailable: no pre-run manifest for this run (a --resume run, or a run predating the manifest seam) — " +
        "cannot determine which files the run authored, so a lost interactive-artifact write-back cannot be ruled out",
    };
  }
  // The authored-file list must be wired by the lane (live/verify-run). Absent (a lane that never populated
  // it) is evidence-unavailable, NOT an empty authored set — an empty [] is a real "authored nothing".
  if (ctx.authoredFiles === undefined) {
    return {
      pass: false,
      message:
        "evidence unavailable: authored-file capture was not wired for this lane — cannot evaluate no_lost_write_back " +
        "(re-run live to check this)",
    };
  }

  const health = ctx.authoredFilesHealth;
  const workRootAbs = resolve(ctx.workRoot);
  // The scratchpad walk resolves relative to the session root (parent of `mnt`), the same guard the capture
  // uses (execute.ts). Only meaningful when workRoot is the `.../session/mnt` shape.
  const scratchpadRoot = ctx.workRoot.endsWith(`${sep}mnt`) ? dirname(workRootAbs) : undefined;

  // Selector: authored ∪ omitted-at-cap ∪ read-back-error, workRoot-relative (scratchpad entries synthetic).
  const relPaths = new Set<string>();
  for (const f of ctx.authoredFiles) relPaths.add(f.path);
  for (const p of health?.omittedPaths ?? []) relPaths.add(p);
  for (const e of health?.readErrors ?? []) relPaths.add(e.path);

  const absToRel = new Map<string, string>(); // resolved-abs → display rel, for finding-path readability
  const targets: string[] = [];
  const unresolvedScratchpad: string[] = []; // scratchpad source with no session root to resolve against
  for (const rel of relPaths) {
    if (!WRITE_BACK_SOURCE_EXTS.has(extname(rel).toLowerCase())) continue; // not a Tier A source
    let abs: string;
    if (rel.startsWith(SCRATCHPAD_PREFIX)) {
      if (!scratchpadRoot) {
        unresolvedScratchpad.push(rel);
        continue;
      }
      abs = resolve(join(scratchpadRoot, rel.slice(SCRATCHPAD_PREFIX.length)));
    } else {
      abs = resolve(join(workRootAbs, rel));
    }
    absToRel.set(abs, rel);
    targets.push(abs);
  }

  const { findings, analysisFailures } = analyzeArtifacts(targets);

  // Severity per finding: a `-lost` on an agent-authored source (reserved root, or an ADDED file on a rw
  // connected mount) is a hard FAIL; a `-lost` on a MODIFIED file on a rw connected mount (a user's own
  // pre-existing artifact the skill merely edited) is advisory. `-suspect` findings are always advisory.
  const displayOf = (findingPath: string): string => absToRel.get(resolve(findingPath)) ?? findingPath;
  const isReservedRoot = (rel: string): boolean => {
    if (rel.startsWith(SCRATCHPAD_PREFIX)) return true; // scratchpad is agent-authored by construction
    const root = ctx.userVisiblePrefixes.find((r) => rel === r || rel.startsWith(r + "/"));
    return root === "outputs"; // `outputs/` starts empty; everything else visible is a connected mount
  };
  const wasModified = (rel: string): boolean => {
    if (rel.startsWith(SCRATCHPAD_PREFIX)) return false; // scratchpad files aren't in the pre-run manifest
    const prior = ctx.preRunHashes?.[rel];
    return typeof prior === "string" || prior === null; // a prior entry (or unknown baseline) → pre-existing
  };

  const hardLost: { rel: string; line?: number; message: string }[] = [];
  const advisories: string[] = [];
  for (const f of findings) {
    const rel = displayOf(f.path);
    if (f.rule === "artifact-write-back-lost") {
      if (!isReservedRoot(rel) && wasModified(rel)) {
        advisories.push(
          `suspect: "${rel}"${f.line ? `:${f.line}` : ""} has a lost write-back but was a PRE-EXISTING file on a ` +
            `read-write connected mount that the skill only modified — not attributable to the skill; surfaced, not failed (${f.message})`,
        );
      } else {
        hardLost.push({ rel, line: f.line, message: f.message });
      }
    } else {
      // artifact-write-back-suspect (advisory)
      advisories.push(`suspect: "${rel}"${f.line ? `:${f.line}` : ""} — ${f.message}`);
    }
  }

  // A concrete lost write-back on an agent-authored source is the strongest signal — report it definitively,
  // ahead of any could-not-verify caveat about OTHER sources.
  if (hardLost.length) {
    const h = hardLost[0];
    const more = hardLost.length > 1 ? ` (+${hardLost.length - 1} more)` : "";
    return {
      pass: false,
      message: `lost interactive-artifact write-back in "${h.rel}"${h.line ? `:${h.line}` : ""}: ${h.message}${more}`,
    };
  }

  // Could-not-verify: a produced candidate we couldn't analyze (unreadable/parse/size/unsupported-guard/
  // .py-extract), a scratchpad walk skipped on resume, or a scratchpad path we couldn't resolve. Fail-closed
  // — a lost write-back could hide in the source we couldn't read.
  const cantVerify: string[] = [];
  if (analysisFailures.length) {
    const sample = analysisFailures
      .slice(0, 3)
      .map((af) => `${absToRel.get(resolve(af.path)) ?? af.path} (${af.stage}: ${af.reason})`)
      .join("; ");
    const more = analysisFailures.length > 3 ? ` (+${analysisFailures.length - 3} more)` : "";
    cantVerify.push(`${analysisFailures.length} authored source(s) could not be analyzed: ${sample}${more}`);
  }
  if (health?.scratchpadSkippedOnResume) {
    cantVerify.push("scratchpad deliverables were skipped on --resume (unattributable across turns) — that class is unchecked");
  }
  // an unreadable user-visible subtree means an authored file there was never enumerated — fail-closed.
  if (health?.workspaceWalkErrors.length) {
    const sample = health.workspaceWalkErrors
      .slice(0, 3)
      .map((e) => `${e.path}: ${e.error}`)
      .join("; ");
    cantVerify.push(
      `${health.workspaceWalkErrors.length} user-visible subtree(s) could not be walked (${sample}) — an authored file there is unobserved`,
    );
  }
  // an unreadable scratchpad subtree could hide a deliverable — fail-closed rather than a false clean.
  if (health?.scratchpadWalkErrors.length) {
    const sample = health.scratchpadWalkErrors
      .slice(0, 3)
      .map((e) => `${e.path}: ${e.error}`)
      .join("; ");
    cantVerify.push(
      `${health.scratchpadWalkErrors.length} scratchpad subtree(s) could not be walked (${sample}) — a deliverable there is unobserved`,
    );
  }
  // a scratchpad deliverable written through a symlink/hardlink is never followed; if it's a Tier A
  // write-back source (.html/.js/…) it could carry a lost write-back we never analyzed.
  const skippedTierALinks = (health?.scratchpadSkippedLinks ?? []).filter((p) => WRITE_BACK_SOURCE_EXTS.has(extname(p).toLowerCase()));
  if (skippedTierALinks.length) {
    cantVerify.push(
      `${skippedTierALinks.length} scratchpad deliverable(s) skipped as a symlink/hardlink (${skippedTierALinks
        .slice(0, 3)
        .join(", ")}) — not followed, so a write-back there is unchecked`,
    );
  }
  if (unresolvedScratchpad.length) {
    cantVerify.push(`${unresolvedScratchpad.length} scratchpad source(s) could not be resolved to a real on-disk path`);
  }
  if (cantVerify.length) {
    return { pass: false, message: `evidence unavailable: ${cantVerify.join("; ")} — cannot rule out a lost write-back` };
  }

  // No hard fail, nothing unverifiable. Surface any advisory (suspect / downgraded rw-mount finding) but pass.
  if (advisories.length) {
    return { pass: true, evidence: `no_lost_write_back: no lost write-back; ${advisories.length} advisory — ${advisories[0]}` };
  }
  const scanned = targets.length;
  return {
    pass: true,
    evidence: `no_lost_write_back: ${scanned} authored source(s) scanned, no lost interactive-artifact write-back`,
  };
}

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
  semanticEvidence?: SemanticEvidence;
} {
  const results: KeyResult[] = [];
  // WHY a semantic_matches assert refused (or what a scoped one graded), as a typed reason rather than
  // prose — set by the semantic_matches branch below, spread onto the result alongside judgeInvalid.
  let semanticEvidence: SemanticEvidence | undefined;
  const ok = (evidence?: string): KeyResult => ({ pass: true, evidence });
  const fail = (message: string): KeyResult => ({ pass: false, message });
  const truncated = ctx.truncatedPaths ?? new Map<string, "size" | "readonly" | "unreadable" | "input" | undefined>();

  // Tool-name matching for tool_called / tool_not_called / subagent_tool_used / subagent_tool_absent:
  // a GLOB over the closed set of literal tool identifiers (`*` any run, `?` one char; every other char
  // literal; anchored full-match, case-sensitive). A pattern with no metachar is an exact name — so all
  // existing exact asserts are unchanged — while `mcp__workspace__*` matches any workspace tool. Reuses the
  // path-glob engine; its `/`-segment / `**` handling is inert for tool names (they contain no `/`).
  //
  // ALIAS-AWARE. The agent binary canonicalizes a set of legacy tool names (`Task` → `Agent`, …) and the
  // baseline's `spawn.tools` still declares the LEGACY spelling, which the init inventory echoes back
  // while every actual call is emitted CANONICAL. Measured over 506 kept runs: `Task` offered 506 /
  // called 0, `Agent` offered 0 / called 188 — so a literal match made `tool_called: "Task"` impossible
  // and `tool_not_called: "Task"` a permanent vacuous pass. Expanding the RECORDED NAME (not the
  // pattern) is what makes this work for globs too: rewriting the pattern would fix `"Task"` and leave
  // `"Ta*"` and `"*"` broken. See src/run/tool-name-canonicalization.ts.
  const toolMatches = (pattern: string, name: string): boolean =>
    toolNameSpellings(name).some((spelling) => anyGlobMatches([pattern], spelling));
  // These keys are GLOB-matched, not regex. A pattern carrying a regex-only metacharacter is almost
  // always a regex-habit slip (`mcp__*.*`, `Bash|Read`) that would match NOTHING under glob — a silent
  // false-green for the `_not_`/`_absent` direction the failure message can't reach. Warn loudly.
  // `semantic_matches.evidence_files` joins them: a regex-habit path glob there lands in the
  // scope-matched-nothing refusal, and naming the cause up front beats making the author read it back
  // out of a failure.
  const warnIfRegexish = (
    key: string,
    pattern: string,
    subject = "tool name",
    consequence = "can silently pass a _not_/_absent assert",
  ): void => {
    if (/\.\*|\.\+|[|()[\]+^$]|\\[dwsb]/.test(pattern))
      warn(
        `::warning:: ${key}: "${pattern}" looks like a regex, but this key is GLOB-matched (use * and ?, not .* or | []). ` +
          `A regex-only pattern matches no ${subject} and ${consequence}.\n`,
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
    const scope = a.semantic_matches.evidence_files;
    const sc = scopeAuthoredEvidence(ctx, scope);
    const scoped = scope !== undefined && scope.length > 0;
    for (const g of scope ?? [])
      warnIfRegexish("semantic_matches.evidence_files", g, "authored path", "fails the assert evidence-unavailable");
    // A scope that keeps EVERY authored path narrows nothing — the author meant to select a deliverable
    // and instead re-selected the whole capture, so the omissions they were trying to make irrelevant
    // still refuse the verdict. Only worth saying when there ARE omissions; otherwise it is a no-op.
    if (scoped && sc.files.length === (ctx.authoredFiles ?? []).length && (ctx.authoredFilesHealth?.omittedPaths.length ?? 0) > 0)
      warn(
        `::warning:: semantic_matches.evidence_files ${JSON.stringify(scope)} matches EVERY authored file, so it narrows nothing ` +
          `while ${ctx.authoredFilesHealth?.omittedPaths.length} file(s) were dropped at the capture budget — name the deliverable ` +
          `(e.g. "outputs/report.md") rather than a root-wide "**".\n`,
      );
    // In-scope files are exempt from the per-file cap, so a `truncated` one means even the TOTAL budget
    // could not hold it — a partial deliverable, which is exactly what the judge must not grade.
    const truncatedInScope = sc.files.filter((f) => f.truncated).map((f) => f.path);
    const docInfo = ctx.semanticDocInfo?.get(a);
    const LEVERS = "scope it with semantic_matches.evidence_files, or raise $COWORK_HARNESS_AUTHORED_TOTAL_BYTES";
    // Everything missing from the in-scope evidence, in ONE report. These conditions are not mutually
    // exclusive — one oversized in-scope file can be TRUNCATED while simultaneously starving a sibling into
    // being OMITTED — and an earlier version's if/else chain surfaced only the first, naming the 100-byte
    // casualty while staying silent about the file that actually ate the budget.
    const missing = [...sc.omitted, ...sc.unreadable].sort();
    // `authoredTotalBytes()` THROWS on a malformed env value, and building a failure message must never be
    // what takes down the evaluation — that would lose every other assert's verdict to render one string.
    // `executeScenario` validates at entry so the CLI path already refuses a bad value; this covers a
    // library caller and any future lane that populates judge results without going through it.
    const currentBudget = (): number | string => {
      try {
        return authoredTotalBytes();
      } catch {
        return "unset/invalid";
      }
    };
    if (ctx.judgeInvalid?.has(a)) {
      results.push(fail("judge grade INVALID (malformed/ambiguous after retry) — rep counts as invalid, not a pass"));
    } else if (!judged) {
      // BEFORE the evidence branches: with no grade there is no verdict to protect, and the evidence-shaped
      // reasons are computed from an authored set this lane may never have captured. Reporting
      // `scope_matched_nothing` for a run that authored plenty (verify-run populates `authoredFiles` only
      // when `no_lost_write_back` is asserted) would send an author to fix a glob that is already correct.
      results.push(fail("evidence unavailable: semantic judge not run (semantic_matches is live-only; skipped on replay)"));
    } else if (scoped && !sc.matchedAny) {
      // A glob matching nothing would grade the rubric against ZERO authored evidence while the capture
      // reports clean — the vacuous pass `evidence_files: []` is banned for, reached by a typo or a
      // renamed mount instead. Fail loud, and PRINT THE PATHS: nothing else in the harness surfaces them,
      // so this message is the only place the author/agent can learn the `<root>/<rel>` key shape.
      const all = allAuthoredPaths(ctx);
      semanticEvidence = { reason: "scope_matched_nothing", paths: all };
      results.push(
        fail(
          `evidence unavailable: semantic_matches.evidence_files ${JSON.stringify(scope)} matched NONE of the ${all.length} path(s) this run authored — ` +
            `grading would have used zero authored evidence. Paths are <root>/<rel> (not a bare filename) and globs use */?/** (not regex). ` +
            `This run authored: ${all.length ? all.join(", ") : "(nothing)"}`,
        ),
      );
    } else if (scoped && (missing.length || truncatedInScope.length)) {
      const bits: string[] = [];
      if (missing.length) bits.push(`${missing.length} missing (${missing.join(", ")})`);
      if (truncatedInScope.length) bits.push(`${truncatedInScope.length} TRUNCATED at the total budget (${truncatedInScope.join(", ")})`);
      semanticEvidence = {
        reason: truncatedInScope.length && !missing.length ? "in_scope_truncated" : "in_scope_omitted",
        paths: [...new Set([...missing, ...truncatedInScope])].sort(),
      };
      results.push(
        fail(
          `evidence unavailable: the in-scope authored evidence is incomplete — ${bits.join("; ")}. A partial deliverable grades as a ` +
            `partial document. Raise $COWORK_HARNESS_AUTHORED_TOTAL_BYTES (currently ${currentBudget()} bytes), but keep the composed ` +
            `document under ${JUDGE_DOC_CAP} chars or it is cut at the other end`,
        ),
      );
    } else if (!scoped && ah && (ah.omittedPaths.length || ah.readErrors.length)) {
      // #14/#16: the judge graded a document missing authored files (dropped at the size cap, or unreadable
      // at read-back), so a "claim not satisfied" could be a false absence. Refuse the verdict. Distinct
      // reason from the scoped ones: the remedy here is to ADD a scope, not to fix an existing glob.
      semanticEvidence = { reason: "evidence_incomplete", paths: [...ah.omittedPaths, ...ah.readErrors.map((e) => e.path)].sort() };
      results.push(
        fail(
          `evidence unavailable: authored-file evidence was incomplete (${ah.omittedPaths.length} omitted at the capture cap, ${ah.readErrors.length} unreadable) — the judge graded a partial document, cannot trust the semantic verdict. To grade anyway, ${LEVERS}`,
        ),
      );
    } else if (docInfo?.evidenceCut) {
      // The remedy for every refusal above is "raise the budget" — which, past JUDGE_DOC_CAP, would
      // otherwise move the incompleteness from a loud refusal into a SILENT aggregate cut of the sections
      // that carry the evidence, so the fix would carry the bug it fixes. Deliberately NOT gated on
      // `scoped`: the env var that makes this reachable is available to every scenario, and an unscoped run
      // whose capture is clean has nothing else standing between it and a graded-but-truncated document.
      semanticEvidence = { reason: "authored_evidence_truncated" };
      // ONE lever, deliberately. LOWERING the capture budget cannot clear this: it shrinks the document only
      // by dropping or truncating authored bytes, which lands in an earlier refusal branch every time — it
      // converts one refusal into another rather than fixing either. And `narrow` names a key an UNSCOPED
      // assert does not have, so the verb follows the scope.
      results.push(
        fail(
          `evidence unavailable: the composed judge document exceeded its ${JUDGE_DOC_CAP}-char budget and the authored-file evidence was cut ` +
            `(the overflow lands in "${docInfo.overflowSection ?? "an unknown section"}") — ` +
            `${docInfo.overflowSection?.startsWith("Sub-agent output") ? "set include_subagent_text: false, or " : ""}` +
            `${scoped ? "narrow" : "add"} semantic_matches.evidence_files so only the files the rubric is about reach the judge. ` +
            `(Lowering $COWORK_HARNESS_AUTHORED_TOTAL_BYTES will NOT help — it only drops the evidence at the capture instead.)`,
        ),
      );
    } else {
      if (docInfo?.healthNoteCut)
        // Advisory, not a refusal: the graded evidence survived and only the "do not infer absence" note was
        // clipped. For an unscoped assert a non-empty health note has already refused above; for a scoped one
        // the note is about out-of-scope files by construction.
        warn(
          `::warning:: semantic_matches: the judge document hit its ${JUDGE_DOC_CAP}-char cap and the evidence-health note was trimmed. ` +
            `The graded evidence is intact, but the judge was not told which files the capture dropped.\n`,
        );
      const passed = judged.filter((c) => c.pass).length;
      const mp = a.semantic_matches.min_pass;
      const need = mp === undefined || mp === "all" ? a.semantic_matches.rubric.length : mp;
      const failedIdx = judged.filter((c) => !c.pass).map((c) => c.index);
      const gradedPaths = sc.files.map((f) => f.path);
      // Record the graded set on BOTH outcomes. A green needs it because scoping is a new way to make a
      // pass vacuous and `evidence` exists so a green can be checked rather than assumed; a RED needs it
      // just as much, because the bug this whole mechanism guards against (#14/#16) is a false ABSENCE —
      // "the claim failed" is only actionable next to "and here is what the judge was actually shown".
      semanticEvidence = { reason: "graded", paths: gradedPaths };
      const over = scoped ? `; graded authored files: ${gradedPaths.length ? gradedPaths.join(", ") : "(none)"}` : "";
      results.push(
        passed >= need
          ? ok(`semantic: ${passed}/${judged.length} rubric claims passed (need ${need})${over}`)
          : fail(
              `semantic: ${passed}/${judged.length} rubric claims passed (need ${need}); failed claim indices: ${failedIdx.join(",")}${over}`,
            ),
      );
    }
  }
  if (a.tool_result_contains !== undefined) {
    const needle = a.tool_result_contains;
    if (ctx.toolResultsMissing) {
      // Mirror tool_result_not_contains: when the channel is absent, say WHY (evidence unavailable)
      // instead of the misleading substantive "no tool result contained X".
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
  // Regex siblings of tool_result_contains/tool_result_not_contains — catch an error-signature FAMILY
  // (e.g. a script's non-zero exit swallowed by its wrapper, but the message still printed) that a
  // literal substring can't express. Same evidence-unavailable / truncation-fail wording as the _contains
  // pair above; compileUserRegex + try/catch discipline matches transcript_matches below.
  if (a.tool_result_matches !== undefined) {
    if (ctx.toolResultsMissing) {
      results.push(fail(`evidence unavailable: tool results absent from result.json — cannot evaluate tool_result_matches`));
    } else {
      const c = compileUserRegex(a.tool_result_matches);
      if ("error" in c) {
        results.push(fail(`tool_result_matches: bad regex "${a.tool_result_matches}": ${c.error}`));
      } else if (ctx.toolResultTexts.some((t) => c.re.test(t))) {
        results.push(ok());
      } else {
        // No match found — but a match could sit PAST the display cap of a truncated result (assertText
        // absent). Mirror tool_result_contains: fail closed, but say WHY honestly.
        const anyTruncated =
          ctx.toolResultsTruncated !== undefined && ctx.toolResultTexts.some((_, i) => ctx.toolResultsTruncated![i] === true);
        results.push(
          anyTruncated
            ? fail(
                `evidence unavailable: no captured tool result matched /${a.tool_result_matches}/i, but one or more results are display-truncated (no assertText) — a match may be past the cap`,
              )
            : fail(`no tool result matched /${a.tool_result_matches}/i`),
        );
      }
    }
  }
  if (a.tool_result_not_matches !== undefined) {
    if (ctx.toolResultsMissing) {
      results.push(fail(`evidence unavailable: tool results absent from result.json — cannot evaluate tool_result_not_matches`));
    } else {
      const c = compileUserRegex(a.tool_result_not_matches);
      if ("error" in c) {
        results.push(fail(`tool_result_not_matches: bad regex "${a.tool_result_not_matches}": ${c.error}`));
      } else {
        const positiveHit = ctx.toolResultTexts.some((t) => c.re.test(t));
        if (positiveHit) {
          results.push(fail(`a tool result matched forbidden /${a.tool_result_not_matches}/i`));
        } else {
          const hasTruncatedAbsence =
            ctx.toolResultsTruncated !== undefined &&
            ctx.toolResultTexts.some((t, i) => !c.re.test(t) && ctx.toolResultsTruncated![i] === true);
          results.push(
            hasTruncatedAbsence
              ? fail(
                  `evidence unavailable: one or more tool results are display-truncated (no assertText) — cannot rule out a forbidden regex match`,
                )
              : ok(),
          );
        }
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
  if (a.file_absent !== undefined) {
    const p = a.file_absent;
    // LANE FIRST. This is the dangerous inverse of file_exists: where the filesystem is not locally
    // observable, a missing snapshot is indistinguishable from a file that was never created, and the
    // assertion would PASS having proved nothing. `file_exists` fails safe in that situation (not found
    // ⇒ fail); this one does not, so it needs the guard `user_visible_artifact` already carries.
    if (ctx.lane === "remote") {
      results.push(
        fail(
          `file_absent cannot be verified on \`lane: remote\` — a remote container's filesystem is not locally observable, so "not found here" is not evidence the run did not create it. Assert on the delivered artifact instead, or use \`lane: local\``,
        ),
      );
    } else if (ctx.preRunOrigin === "remote-unavailable") {
      // Same physics, reached the other way: the run's tree was never local to begin with.
      results.push(
        fail(
          `evidence unavailable: pre-run manifest origin is remote-unavailable (a cloud run's filesystem is not locally observable) — cannot prove absence`,
        ),
      );
    } else {
      // NOTE: `local-unreadable` is deliberately NOT fatal here. It means the pre-run BASELINE is
      // incomplete, which matters to the exhaustive keys (no_unexpected_files) and not to a point query:
      // existsSync on the post-run tree still proves whether THIS path is there.
      const abs = containedPath(ctx.workRoot, p);
      if (!abs) results.push(fail(`unsafe file_absent path "${p}" — must stay under the work root (no absolute paths or "..")`));
      else {
        const real = containedRealPath(ctx.workRoot, abs);
        // An escaping symlink is not "absent" — it exists and points out of the root. Fail loud rather
        // than report a clean absence for a path that resolves somewhere unexpected.
        if (!real) results.push(fail(`unsafe file_absent path "${p}" — symlink target escapes the work root`));
        else
          results.push(
            existsSync(real)
              ? fail(`file exists but was asserted absent: ${p} (under ${ctx.workRoot})`)
              : ok(`file_absent: "${p}" is not present under ${ctx.workRoot}`),
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
      // LANE CHECK FIRST — before every location-based branch below. Placed after the truncated/link
      // branches originally, which let a replayed remote cassette green via the truncated path: the one
      // lane where location proves nothing was the one where the guard could be bypassed.
      //
      // The remedy deliberately does NOT say "assert the delivery itself": no remote delivery tool is
      // modeled (production's is the agent-native SendUserFile), so that advice pointed at a key that does
      // not exist. Offer the honest proxy instead. Keep in sync with the load-time twin in
      // src/run/execute.ts — both must retire together when a remote delivery tool ships.
      if (ctx.lane === "remote") {
        results.push(
          fail(
            `user_visible_artifact asserts LOCATION, which delivers nothing on \`lane: remote\` — a remote container has no auto-delivering outputs dir and is reclaimed at session end. Tool-level delivery is NOT YET ASSERTABLE on this lane (no remote delivery tool is modeled). Either assert the written path plus the agent's own statement of it (\`file_exists\` + \`transcript_matches\`), or use \`lane: local\` if this scenario models the desktop lane`,
          ),
        );
      } else if (ctx.linkPaths?.has(rel)) {
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
  if (a.no_lost_write_back !== undefined) {
    // Static Tier A analyzer over the files this run authored — see checkNoLostWriteBack. Live/verify-run
    // only (LIVE_ONLY_KEYS: stripped on replay, so it never reaches here on the replay lane).
    results.push(checkNoLostWriteBack(ctx));
  }
  if (a.tool_called !== undefined) {
    warnIfRegexish("tool_called", a.tool_called);
    const hit = [...ctx.toolsCalled].find((t) => toolMatches(a.tool_called!, t));
    results.push(
      ctx.toolsCalledMissing
        ? // Mirror tool_not_called: a missing tool-count channel is "cannot evaluate", not "not called".
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
  if (a.reference_read !== undefined || a.no_observed_reference_access !== undefined) {
    // One block for both keys: they read the same list through the same compiled regex, and splitting
    // them invites the two halves to drift on what counts as evidence-unavailable.
    const evaluate = (key: "reference_read" | "no_observed_reference_access", pattern: string, wantHit: boolean): void => {
      const compiled = compileUserRegex(pattern);
      if ("error" in compiled) {
        results.push(fail(`${key}: bad regex "${pattern}": ${compiled.error}`));
        return;
      }
      if (ctx.referencesAccessed === undefined) {
        // Evidence-unavailable, both directions. A negative assertion that passes because we could not
        // look is the false green this key exists to avoid producing.
        results.push(fail(`evidence unavailable: this run recorded no observable reference-access list — cannot evaluate ${key}`));
        return;
      }
      const hits = ctx.referencesAccessed.filter((e) => compiled.re.test(e.path));
      const shown = hits.map((h) => `${h.path}${h.via.length ? ` (${h.via.join(", ")})` : ""}`).join(", ");
      if (wantHit)
        results.push(
          hits.length
            ? ok(shown)
            : fail(
                `reference_read: no observed access matched /${pattern}/ (searched ${ctx.referencesAccessed.length} accessed file(s)). ` +
                  `Detection under-approximates — a 'cd' then a bare relative read, a heredoc, or a $VAR-built path is invisible`,
              ),
        );
      else
        results.push(
          hits.length === 0
            ? ok(`no observed access matched /${pattern}/`)
            : fail(`no_observed_reference_access: /${pattern}/ was accessed — ${shown}`),
        );
    };
    if (a.reference_read !== undefined) evaluate("reference_read", a.reference_read, true);
    if (a.no_observed_reference_access !== undefined) evaluate("no_observed_reference_access", a.no_observed_reference_access, false);
  }
  if (a.subagent_tool_used !== undefined) {
    warnIfRegexish("subagent_tool_used", a.subagent_tool_used);
    const hit = [...ctx.subagentTools].find((t) => toolMatches(a.subagent_tool_used!, t));
    results.push(
      ctx.subagentsMissing
        ? // Mirror subagent_tool_absent: a missing dispatch tree is "cannot evaluate", not "did not use".
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
      // Mirror the sibling subagent assertions: a missing dispatch tree is "cannot evaluate".
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
        // Match dispatchAgentType OR resolvedAgentType OR description — mirrors subagent_dispatched so a
        // type-less dispatch that RESOLVED to e.g. "general-purpose" is selectable here too.
        const candidates = ctx.subagents.filter(
          (s) =>
            c.re.test(s.dispatchAgentType) ||
            (s.resolvedAgentType !== undefined && c.re.test(s.resolvedAgentType)) ||
            c.re.test(s.description ?? ""),
        );
        results.push(
          candidates.some((s) => s.output?.includes(contains))
            ? ok()
            : candidates.length === 0
              ? fail(`no sub-agent matching "${match}" was dispatched`)
              : // a miss against a TRUNCATED output is unverifiable, not a proven absence — the substring
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
              `dispatched ${ctx.subagents.length} sub-agents, max ${a.dispatch_count_max} (author-chosen budget under Cowork's agent-side fan-out cap — see SPEC §10)`,
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
    // THE HARNESS now serves present_files at BOTH container and hostloop (closing the prior coverage
    // gap — see present_files_called below). But this key's promotion/leak semantics stay genuinely
    // container-shaped, not a harness gap: production's own
    // `isHostLoopMode` branch validates a path and passes it through WITHOUT promoting — the agent's cwd
    // at hostloop already IS the outputs dir, so there is no scratch→outputs copy that could ever leak.
    // So a hostloop run reports cannot-verify here, never a false claim that the tool is absent or that
    // nothing leaked.
    //
    // Gate anyway, because `presentedFiles` is always [] where the harness doesn't serve the tool and the
    // leak check below would then pass VACUOUSLY. `effectiveFidelity` is populated on every lane's ctx
    // (live/replay/verify-run).
    if (ctx.lane === "remote")
      results.push(
        fail(
          "no_scratchpad_leak: present_files is not served on `lane: remote` (a local MCP server cannot reach a remote Cowork session), so there is no promotion to leak — cannot verify. Without this gate the check would pass VACUOUSLY on an empty presentedFiles list",
        ),
      );
    else if (ctx.effectiveFidelity !== "container")
      results.push(
        fail(
          `no_scratchpad_leak: promotion/leak semantics apply only at the container tier (this run: ${ctx.effectiveFidelity ?? "unknown"}) — hostloop's present_files never promotes (production's host-loop branch passes a validated path through without copying, so there is no scratch→outputs copy to leak) — cannot verify; use fidelity: container for present_files-based delivery`,
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
    // The presence companion to no_scratchpad_leak (which is a vacuous pass when nothing was presented,
    // and stays container-only — see the note there). Unlike no_scratchpad_leak, nothing about THIS key
    // is container-shaped: it asserts the harness-side delivery record, which is equally meaningful at
    // hostloop now that present_files is served there too (closing the prior coverage gap). A missing
    // delivery on any OTHER tier is still "cannot verify," never a false negative.
    if (ctx.lane === "remote")
      results.push(
        fail(
          "present_files_called: present_files is not served on `lane: remote` — a local MCP server cannot reach a remote Cowork session, which delivers via the agent-native SendUserFile instead (not modeled; see docs/fidelity-gaps.md) — cannot verify",
        ),
      );
    else if (ctx.effectiveFidelity !== "container" && ctx.effectiveFidelity !== "hostloop")
      results.push(
        fail(
          `present_files_called: present_files is served only on the container/hostloop tiers (this run: ${ctx.effectiveFidelity ?? "unknown"}) — cannot verify; use fidelity: container or hostloop for present_files-based delivery`,
        ),
      );
    // PRESENCE comes from the invocation count, not from `presentedFiles`. The two answer different
    // questions, and only one of them survives redaction: `presentedFiles` entries are dropped when a
    // path can't be classified, which a host-path policy guarantees at hostloop (a real host path
    // redacts to `[REDACTED:…]/mnt/outputs/f`, and the classifier requires an absolute path). Reading
    // delivery off classification made a redacted recording report "the tool was never called" about a
    // run that called it three times — and, because record's redaction self-check replays both
    // cassettes and compares verdicts, no such cassette could be written at all.
    // `presentedFiles.length` stays as the fallback for a run recorded before the count existed.
    else if ((ctx.presentFilesCalls ?? 0) > 0 || (ctx.presentedFiles?.length ?? 0) > 0) results.push(ok());
    // Called, but every call's `files` was unusable — the tool WAS invoked, so "never called" would be a
    // factual claim the harness knows to be false. Mirrors no_scratchpad_leak's malformed branch above.
    // The count is deliberately NOT interpolated: record's self-check normalizes [REDACTED…] tokens out
    // of failing messages but not digits, so a count that differs between the base and redacted replays
    // would trip its message compare and refuse a record that is otherwise fine to write.
    else if (ctx.evidenceErrors?.presentFilesMalformed)
      results.push(
        fail(
          `present_files_called: present_files WAS called, but no call carried a usable file path (malformed input) — cannot verify delivery`,
        ),
      );
    else results.push(fail(`present_files_called: no file was delivered via present_files (the tool was never called)`));
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
    else if (ctx.availableTools.some((t) => c.re.test(t))) results.push(ok());
    else {
      // The general caveat applies to every miss; the discovery-server paragraph is appended ONLY when
      // the pattern actually concerns those tools, so an ordinary `tool_available: "Bash"` miss isn't
      // buried under ~450 characters about a surface it never mentioned.
      const discoveryRelevant = /mcp__(?:skills|plugins)/.test(a.tool_available);
      results.push(
        fail(
          `no tool in the init manifest matched "${a.tool_available}" — note context.tools is the EAGERLY-LOADED tool set; a factory-deferred tool (surfaced via a system-reminder) can be available yet absent here, so a miss is "not eagerly loaded", not "provably unavailable"` +
            (discoveryRelevant
              ? `. The mcp__skills__*/mcp__plugins__* discovery tools ARE modeled as alwaysLoad on container/hostloop (and cowork, which resolves to one of those) — a miss there is a real absence, but microvm/protocol still declare no such server, so a miss on those tiers means "not modeled at this tier", not "provably unavailable"`
              : ""),
        ),
      );
    }
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
      // evidence. Refuse to evaluate rather than pass on a subset.
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
  if (a.no_delete_in_mounts !== undefined) {
    // Waived mounts still get DETECTED and recorded — the waiver is a verdict decision, not a scan
    // suppression, exactly as allow_outputs_delete behaves.
    const waived = new Set(ctx.deleteWaivedMounts ?? []);
    const hits = (ctx.mountDeletes ?? []).filter((d) => !waived.has(d.mount));
    results.push(
      ctx.scanMissing
        ? fail(`evidence unavailable: post-run scan absent from result.json — cannot evaluate no_delete_in_mounts`)
        : hits.length === 0
          ? ok()
          : fail(
              `delete op(s) touched delete-denied mount(s) (production denies unlink/rmdir there until approved): ` +
                hits
                  .slice(0, 3)
                  .map((d) => `${d.mount}: ${d.command}`)
                  .join("; "),
            ),
    );
  }
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
          "evidence unavailable: no pre-run manifest for this run/cassette (a --resume run, or a run/cassette predating 0.24) — cannot compute created files; re-run without --resume, or re-record",
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
      if (walk.containmentSkips.length) {
        // a subtree under a user-visible prefix escaped containment (a symlink/bind-mount out of the
        // work root) and was excluded from the walk. "Security-skipped" is not "observed empty" — a stray
        // could hide there, so a "no unexpected files" verdict would be vacuous. Fail evidence-unavailable.
        results.push(
          fail(
            `evidence unavailable: ${walk.containmentSkips.length} subtree(s) under the user-visible roots were skipped for escaping the work root (${walk.containmentSkips
              .slice(0, 3)
              .join(", ")}) — cannot prove no unexpected files were created there`,
          ),
        );
      } else if (!walk.complete) {
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
          "evidence unavailable: no pre-run hash manifest for this run/cassette (a --resume run, or a run/cassette predating the fingerprinted manifest) — cannot compare content; re-run without --resume, or re-record",
        ),
      );
    } else {
      const globs = Array.isArray(a.input_unmodified) ? a.input_unmodified : [a.input_unmodified]; // accept a bare string
      const matched = Object.keys(ctx.preRunHashes).filter((p) => anyGlobMatches(globs, p));
      const modified: string[] = []; // present post-run with a different hash
      const removed: string[] = []; // gone post-run (deletion is also a content change)
      const uncheckable: string[] = [];
      const escaped: string[] = []; // a manifest key that is not a safe in-root relative path
      // a glob that matches ZERO pre-run paths verifies nothing — a typo, a renamed mount, or a stale
      // scenario glob would otherwise report input integrity as proven while checking no files at all.
      // Fail loud instead of a vacuous pass. (The verdict modifiers above still let a scenario that truly
      // expects no match fail explicitly rather than silently.)
      if (matched.length === 0) {
        results.push(
          fail(
            `input_unmodified matched no pre-run path(s): glob(s) ${globs.join(", ")} matched nothing in the pre-run manifest — nothing to verify; check the mount name/glob (a typo or renamed mount reads as a vacuous pass otherwise)`,
          ),
        );
      } else {
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
            // the file isn't in the post-run tree ⇒ removed. (Cassette keys are producer-controlled, not
            // re-read from disk, so no containment check is needed on this lane.)
            post = ctx.postRunHashes[p] ?? null;
          } else {
            // Live / verify-run: re-hash the real file. validate the manifest key stays inside
            // workRoot before touching disk. bound the read so a file that grew huge during the run
            // can't be materialized whole. Throw (gone/unreadable) ⇒ removed.
            const abs = resolveContainedManifestPath(ctx.workRoot, p);
            if (abs === null) {
              escaped.push(p);
              continue;
            }
            try {
              if (statSync(abs).size > postRunHashCap()) {
                uncheckable.push(p); // too large to bound-hash post-run — evidence-unavailable, not a pass
                continue;
              }
              post = createHash("sha256").update(readFileSync(abs)).digest("hex");
            } catch {
              post = null;
            }
          }
          if (post === null) removed.push(p);
          else if (post !== pre) modified.push(p);
        }
      }
      // a manifest path that escapes the workspace root is a malformed/incompatible manifest — dominates
      // every other outcome (we cannot trust ANY key from it) and fails evidence-unavailable.
      if (escaped.length)
        results.push(
          fail(
            `evidence unavailable: pre-run manifest contains path(s) that escape the workspace root: ${escaped
              .slice(0, 5)
              .join(", ")} — the manifest may be hand-edited or from an incompatible producer; cannot verify input integrity`,
          ),
        );
      // uncheckable dominates the remaining outcomes: if any matched path is unmeasurable, don't imply the
      // rest were fully checked — surface evidence-unavailable rather than a clean verdict.
      else if (matched.length === 0) {
        /* handled above (zero-match fail already pushed) */
      } else if (uncheckable.length)
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
  if (a.question_context !== undefined) {
    const qc = a.question_context;
    // Fail CLOSED on every "we cannot see the gates" path, exactly as question_options does: an absent or
    // partial gate payload must never satisfy a key whose whole job is to prove what a person was shown.
    if (ctx.gateOptionsMissing || ctx.gateOptions === undefined) {
      results.push(fail("evidence unavailable: gate-option evidence absent for this run — cannot evaluate question_context"));
    } else {
      const c = compileUserRegex(qc.matches);
      if ("error" in c) {
        results.push(fail(`question_context: bad regex "${qc.matches}": ${c.error}`));
      } else {
        const all = ctx.gateOptions;
        let pool = all;
        let selector = "";
        let badSelector = false;
        if (qc.when_question !== undefined) {
          const w = compileUserRegex(qc.when_question);
          if ("error" in w) {
            results.push(fail(`question_context: bad regex "${qc.when_question}": ${w.error}`));
            badSelector = true;
          } else {
            pool = all.filter((g) => w.re.test(g.question));
            selector = ` matching /${qc.when_question}/i`;
          }
        }
        // NOTE: deliberately NO ambiguity refusal here, unlike question_options. That key pins WHICH gate
        // offered WHICH set, so silently taking the first would make it depend on gate order. This key asks
        // whether the founder was shown a phrase at a decision point at all, for which "some selected gate's
        // payload matches" is the whole semantic — there is nothing to disambiguate. Mirroring the refusal
        // would red a multi-gate run on which the founder WAS told (measured: the deck-review fixture fires
        // 5 sub-questions across 2 gates).
        if (badSelector) {
          /* already reported */
        } else if (pool.length === 0) {
          results.push(fail(`question_context: no question${selector} was asked (${all.length} gate(s) recorded)`));
        } else {
          // The founder-visible payload, in the order it is presented: question label, then each option's
          // label and description. Joined with newlines so a regex cannot straddle two fields by accident.
          const hit = pool.find((g) => gateVisibleFields(g).some((f) => c.re.test(f)));
          results.push(
            hit
              ? ok(`question_context: gate ${JSON.stringify(hit.question)} showed text matching /${qc.matches}/i`)
              : fail(
                  `question_context: no gate${selector} showed text matching /${qc.matches}/i (searched ${pool.length} gate(s): ${pool
                    .map((g) => JSON.stringify(g.question))
                    .join(", ")})`,
                ),
          );
        }
      }
    }
  }
  if (a.question_options !== undefined) {
    const qo = a.question_options;
    // Fail CLOSED on every "we cannot see the gates" path. An empty/absent list must never satisfy a
    // negative-shaped read of this key: the whole point is to prove what a person was shown.
    if (ctx.gateOptionsMissing || ctx.gateOptions === undefined) {
      results.push(fail("evidence unavailable: gate-option evidence absent for this run — cannot evaluate question_options"));
    } else if ((qo.equals === undefined) === (qo.contains === undefined)) {
      // Both or neither. Rejected at load by the scenario schema; repeated here because `evaluate()` is
      // also called on hand-built contexts (tests, library callers) that never went through parse.
      results.push(fail("question_options: set exactly one of `equals` or `contains`"));
    } else {
      const all = ctx.gateOptions;
      let pool = all;
      let selector = "";
      if (qo.when_question !== undefined) {
        const c = compileUserRegex(qo.when_question);
        if ("error" in c) {
          results.push(fail(`question_options: bad regex "${qo.when_question}": ${c.error}`));
          pool = [];
          selector = "\u0000bad-regex";
        } else {
          pool = all.filter((g) => c.re.test(g.question));
          selector = ` matching /${qo.when_question}/i`;
        }
      }
      if (selector === "\u0000bad-regex") {
        /* already reported */
      } else if (pool.length === 0) {
        results.push(fail(`question_options: no question${selector} was asked (${all.length} gate(s) recorded)`));
      } else if (qo.when_question === undefined && all.length > 1) {
        // Silently taking the first would make the assertion depend on gate ORDER — the very thing this
        // key exists to pin. Ambiguity is an authoring error, not something to resolve by guessing.
        results.push(
          fail(
            `question_options: ${all.length} sub-questions were asked and no \`when_question\` selects one — add a selector (asked: ${all.map((g) => JSON.stringify(g.question)).join(", ")})`,
          ),
        );
      } else {
        const want = (qo.equals ?? qo.contains)!;
        const exact = (qo.order ?? "exact") === "exact";
        // "At least one selected gate satisfies it" — mirrors question_asked's any-match semantics.
        const why: string[] = [];
        const hit = pool.find((g) => {
          const got = g.options.map((o) => o.label);
          if (qo.equals !== undefined) {
            const ok2 = exact ? got.length === want.length && got.every((l, i) => l === want[i]) : sameSet(got, want);
            if (!ok2) why.push(`offered [${got.join(", ")}]`);
            return ok2;
          }
          const missing = want.filter((w) => !got.includes(w));
          if (missing.length) {
            why.push(`offered [${got.join(", ")}] (missing ${missing.join(", ")})`);
            return false;
          }
          if (!exact) return true;
          // Subsequence check: the wanted labels appear in this relative order among the offered ones.
          let i = 0;
          for (const l of got) if (i < want.length && l === want[i]) i++;
          if (i !== want.length) why.push(`offered [${got.join(", ")}] (present but out of order)`);
          return i === want.length;
        });
        const kind = qo.equals !== undefined ? "equals" : "contains";
        results.push(
          hit
            ? ok(`question_options: gate ${JSON.stringify(hit.question)} offered the expected options`)
            : fail(
                `question_options (${kind}${exact ? ", order exact" : ", order any"}): expected [${want.join(", ")}]; ${why.join("; ")}`,
              ),
        );
      }
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
  if (a.artifact_text !== undefined) {
    const at = a.artifact_text;
    const wantsAny = at.contains ?? at.not_contains ?? at.matches ?? at.not_matches;
    const file = containedPath(ctx.workRoot, at.artifact);
    if (wantsAny === undefined) {
      // Rejected by the schema too; repeated because evaluate() is also reached by hand-built contexts.
      results.push(fail("artifact_text: set at least one of contains / not_contains / matches / not_matches"));
    } else if (ctx.lane === "remote") {
      // `artifact_json` has no such branch and reds with a bare "file not found" here, which reads as
      // "the skill didn't write it" when the truth is "this lane has no locally observable filesystem".
      // Not a false green either way — a missing file fails both — but a misleading message on a lane
      // where the assertion can never be satisfied is worth one branch.
      results.push(
        fail(
          `artifact_text cannot be evaluated on \`lane: remote\` — a remote container's filesystem is not locally observable, so there is no body to scan. Assert on the agent's own statement of the content (\`transcript_matches\`), or use \`lane: local\``,
        ),
      );
    } else if (!file) {
      results.push(fail(`unsafe artifact_text path "${at.artifact}" — must stay under the work root (no absolute paths or "..")`));
    } else {
      const rel = relative(resolve(ctx.workRoot), file);
      const realFile = containedRealPath(ctx.workRoot, file);
      // Same evidence gates as artifact_json, in the same order and for the same reasons — see the
      // block below. Duplicated deliberately rather than abstracted: the two differ only in what they do
      // with the bytes, and a shared helper would have to thread five failure messages through.
      const liveReadonly = (ctx.readonlyFolderRoots ?? []).some((pre) => rel === pre || rel.startsWith(pre + "/"));
      const replayReason = truncated.get(rel);
      const bodyLess = truncated.has(rel) || liveReadonly;
      const isLink = ctx.linkPaths?.has(rel) === true;
      // NO `preRunOrigin` guard here, deliberately (the question `file_absent` had to answer). That flag
      // describes the pre-run BASELINE, and this key never consults it: it reads one named body from the
      // post-run tree. Every way that body can be unavailable already fails CLOSED below — absent (file
      // not found), body-less, link placeholder, non-UTF-8 for the negative forms. There is no path on
      // which a degraded baseline turns into a passing text match.
      if (isLink) {
        results.push(
          fail(
            `evidence unavailable: "${at.artifact}" was a symlink/hardlink at record time — its content is not in the cassette; re-record or assert on the deliverable`,
          ),
        );
      } else if (!realFile) {
        results.push(fail(`unsafe artifact_text path "${at.artifact}" — symlink target escapes the work root`));
      } else if (!existsSync(realFile)) {
        results.push(fail(`artifact_text: file not found: ${at.artifact} (under ${ctx.workRoot})`));
      } else if (bodyLess) {
        const cause =
          replayReason === "input"
            ? "(an uploaded input — captured hash-only, never inlined)"
            : replayReason === "readonly" || liveReadonly
              ? "(read-only connected-folder input — its content is never captured)"
              : replayReason === "size"
                ? "(larger than the artifact-body cap — raise --max-artifact-bytes to capture it)"
                : "(a read-only input, or an artifact larger than the body cap)";
        results.push(
          fail(
            `evidence unavailable: artifact_text target "${at.artifact}" was captured body-less ${cause} — content is not available to match against`,
          ),
        );
      } else {
        let buf: Buffer | undefined;
        try {
          const size = statSync(realFile).size;
          if (size > 10 * 1024 * 1024) results.push(fail(`artifact_text: file too large to scan (${size} bytes, limit 10 MiB)`));
          else buf = readFileSync(realFile);
        } catch (e) {
          results.push(fail(`artifact_text: ${at.artifact} could not be read: ${String((e as Error).message)}`));
        }
        if (buf !== undefined) {
          const negative = at.not_contains !== undefined || at.not_matches !== undefined;
          // A binary body decoded as UTF-8 becomes replacement characters. A POSITIVE match on that is
          // simply false (harmless); a NEGATIVE one would "pass" against bytes it never actually read,
          // which is the false-green this key must not ship.
          if (negative && !isLosslessUtf8(buf)) {
            results.push(
              fail(
                `evidence unavailable: "${at.artifact}" is not lossless UTF-8 (binary or invalid encoding) — a negative text assertion over it would pass without reading the real bytes`,
              ),
            );
          } else {
            const body = buf.toString("utf8");
            const missing = (at.contains ?? []).filter((n) => !body.includes(n));
            const present = (at.not_contains ?? []).filter((n) => body.includes(n));
            if (missing.length)
              results.push(fail(`artifact_text: ${at.artifact} does not contain ${missing.map((m) => JSON.stringify(m)).join(", ")}`));
            if (present.length)
              results.push(fail(`artifact_text: ${at.artifact} unexpectedly contains ${present.map((m) => JSON.stringify(m)).join(", ")}`));
            for (const [pat, want] of [
              [at.matches, true],
              [at.not_matches, false],
            ] as const) {
              if (pat === undefined) continue;
              const c = compileUserRegex(pat);
              if ("error" in c) results.push(fail(`artifact_text: bad regex "${pat}": ${c.error}`));
              else if (c.re.test(body) !== want)
                results.push(
                  fail(
                    want
                      ? `artifact_text: ${at.artifact} did not match /${pat}/i`
                      : `artifact_text: ${at.artifact} unexpectedly matched /${pat}/i`,
                  ),
                );
            }
            if (!missing.length && !present.length && !results.some((r) => !r.pass && r.message?.startsWith("artifact_text"))) {
              results.push(ok(`artifact_text: ${at.artifact} satisfied every matcher`));
            }
          }
        }
      }
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
      // A link entry travels a DIFFERENT channel from `truncated`: buildManifest emits it with
      // `linkKind` and no truncation flag, and materializeManifest writes a real 0-byte placeholder.
      // artifact_json survives that only by accident — JSON.parse("") throws. Any TEXT matcher over the
      // same block would read the placeholder and pass, so the guard belongs here, once, for every
      // body-reading key. (`file_exists`/`user_visible_artifact` each carry their own copy.)
      const isLink = ctx.linkPaths?.has(rel) === true;
      if (isLink) {
        results.push(
          fail(
            `evidence unavailable: "${aj.artifact}" was a symlink/hardlink at record time — its content is not in the cassette (replay materializes a 0-byte placeholder); re-record or assert on the deliverable`,
          ),
        );
      } else if (!realFile) {
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
  const VM_PATH = isVmSessionsPath;
  // Every key gated below is listed in HOSTLOOP_ONLY_KEYS (top of this file) — the exported set exists
  // so a caller OUTSIDE the evaluator can reason about "which scenarios cannot be re-recorded at
  // container fidelity" without hand-copying the list. test/hostloop-only-keys.test.ts pins the two
  // together by scanning the `hostloopOnly("…")` call sites in this file.
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

  if (a.subagent_dispatch_healthy !== undefined) {
    // hostloop-only: the no_vm_paths conjunct can't verify off hostloop (see the VM_PATH/hostloopOnly
    // comment above no_vm_path_file_op) — a delivered-only query would still be tier-agnostic in principle,
    // but the composite gates uniformly so a scenario can't accidentally get a partial, tier-dependent
    // verdict from one key.
    const gate = hostloopOnly("subagent_dispatch_healthy");
    if (gate) results.push(gate);
    else {
      const q = a.subagent_dispatch_healthy;
      const c = q.type !== undefined ? compileUserRegex(q.type) : undefined;
      if (c && "error" in c) results.push(fail(`subagent_dispatch_healthy: bad regex "${q.type}": ${c.error}`));
      else if (ctx.fileToolAttempts === undefined || ctx.toolResults === undefined)
        results.push(fail("subagent_dispatch_healthy: attempt/result telemetry unavailable (older run) — cannot verify"));
      else if (ctx.subagentsMissing)
        results.push(
          fail("evidence unavailable: sub-agent dispatch tree absent from result.json — cannot evaluate subagent_dispatch_healthy"),
        );
      else {
        // Match dispatchAgentType OR resolvedAgentType OR description — mirrors subagent_dispatched.
        const selected = c
          ? ctx.subagents.filter(
              (s) =>
                c.re.test(s.dispatchAgentType) ||
                (s.resolvedAgentType !== undefined && c.re.test(s.resolvedAgentType)) ||
                c.re.test(s.description ?? ""),
            )
          : ctx.subagents;
        if (q.type !== undefined && selected.length === 0) {
          results.push(fail(`subagent_dispatch_healthy: no sub-agent matching "${q.type}" was dispatched (by type or description)`));
        } else {
          const wantDelivered = q.delivered !== false; // default true
          const wantNoVm = q.no_vm_paths !== false; // default true
          const writeTools = (n: string): boolean => n === "Write" || n === "Edit" || n === "MultiEdit";
          // exact when `path` is given, else suffix, else any path — mirrors subagent_file_write's
          // pathMatch precedence (a foo/artifacts/probe.json must not satisfy an artifacts/probe.json suffix).
          const pathMatch = (gp: string | undefined): boolean => {
            if (q.path === undefined && q.path_suffix === undefined) return true;
            return gp !== undefined && (q.path !== undefined ? gp === q.path : gp.endsWith(q.path_suffix!));
          };
          const want = q.path !== undefined ? `== "${q.path}"` : q.path_suffix !== undefined ? `ending "${q.path_suffix}"` : "(any path)";
          let unhealthy: { s: (typeof selected)[number]; reason: string } | undefined;
          for (const s of selected) {
            if (wantDelivered) {
              // Scoped to THIS dispatch's own parentToolUseId — the correlation subagent_file_write lacks
              // (it matches ANY sub-agent-origin write, so a write delivered under a SIBLING dispatch would
              // wrongly satisfy that key but must NOT satisfy this one).
              const chain = ctx.fileToolAttempts.find(
                (at) =>
                  at.origin === "subagent" &&
                  at.parentToolUseId === s.toolUseId &&
                  writeTools(at.tool) &&
                  pathMatch(at.gatePath) &&
                  at.toolUseId !== undefined &&
                  ctx.toolResults!.some((r) => r.toolUseId === at.toolUseId && !r.isError),
              );
              if (!chain) {
                unhealthy = {
                  s,
                  reason: `delivered: no SUB-AGENT-origin write ${want} under its OWN dispatch with a non-error paired result`,
                };
                break;
              }
            }
            if (wantNoVm) {
              const vmHit = ctx.fileToolAttempts.find(
                (at) => at.parentToolUseId === s.toolUseId && (VM_PATH(at.paths.file_path) || VM_PATH(at.paths.path)),
              );
              if (vmHit) {
                unhealthy = { s, reason: `no_vm_paths: attempted VM path "${vmHit.paths.file_path ?? vmHit.paths.path}"` };
                break;
              }
            }
          }
          results.push(
            unhealthy
              ? fail(
                  `subagent_dispatch_healthy: dispatch "${unhealthy.s.dispatchAgentType}"${unhealthy.s.toolUseId ? ` (${unhealthy.s.toolUseId})` : ""} unhealthy — ${unhealthy.reason}`,
                )
              : ok(),
          );
        }
      }
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
    ...(semanticEvidence ? { semanticEvidence } : {}),
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
