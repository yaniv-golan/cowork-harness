import { z } from "zod";
import { warn, writeAllSync, tildeify } from "../io.js";
import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  mkdtempSync,
  existsSync,
  readdirSync,
  statSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { runsWriteRoot } from "./trace-view.js";
import { join, dirname, relative, isAbsolute, resolve, sep, extname } from "node:path";
import {
  type Scenario,
  type RunResult,
  type Assertion,
  type Fingerprint,
  type StalenessFinding,
  type PlatformBaseline,
  Assertion as AssertionSchema,
  ScenarioObject,
  VERDICT_MODIFIER_KEYS,
  FIDELITY_TIERS,
} from "../types.js";
import { executeScenario, assertContradiction, parseScenarioFile, collectArtifactPaths, parseSessionFile, slugForPath } from "./execute.js";
import { UsageError } from "../errors.js";
import { preflightBudget, preflightBatchBudget, batchBudgetTracker, estimateBatchCost, batchCostEstimateLine } from "./budget.js";

/** One wording for the `--max-budget-usd` × `--concurrency` degradation, emitted from the dry-run preview
 *  AND both real batch paths — a caveat that differs between the preview and the run would be its own bug. */
const CONCURRENCY_BUDGET_CAVEAT = (n: number) =>
  `::warning:: --max-budget-usd with --concurrency ${n}: the running-total stop is DISABLED (with ${n} runs in flight the total is only known after an overshoot is already paid for). ` +
  `The cap is a pre-flight estimate only here. Use --concurrency 1 for a running total.\n`;
import { gitEnvWithoutAmbientRepo } from "./skill-files.js";
// Re-exported (not re-defined): moved to the leaf module so assert.ts can use it without closing an
// assert → cassette import cycle. Existing importers keep their path.
export { isLosslessUtf8 } from "./artifacts.js";
import { isLosslessUtf8 } from "./artifacts.js";
import { assembleRunResult } from "./assemble-run-result.js";
import { loadSession, resolveSessionPaths, agentEnvOverrides, expandUserPath, type SessionConfig } from "../session.js";
import { loadBaseline, BASELINES_DIR } from "../baseline.js";
import { stripComments } from "../prompt.js";
import { decideLoopFromBaseline } from "../loop-decision.js";
import {
  Run,
  infraErrorsForResult,
  evidenceErrorsForResult,
  FILE_ATTEMPT_TOOLS,
  deniedPathFrom,
  type RunHooks,
  type RunRecord,
} from "./run.js";
import {
  parseMessage,
  serializeDecision,
  deserializeDecision,
  toDecisionRequest,
  canon,
  hookEventFrom,
  type AgentSession,
  type AgentEvent,
  type DecisionRequest,
} from "../agent/session.js";
import { HOSTLOOP_PATH_GATE_ID } from "../runtime/hostloop.js";
import { resolveAgentImageProvenance, type AgentImageProvenance } from "../runtime/image-capabilities.js";
import { resolveAgentImage, resolveContainerRuntime } from "../runtime/agent-image.js";
import { readTimeline, type TimelineHeader, type TimelineEvent } from "../agent/timeline.js";
import { foldToolDurations, foldSkillActivity, attributeSubagentSkills } from "./timeline-fold.js";
import { ABSTAIN, UnansweredError, type Decider, type OnUnanswered } from "../decide/decider.js";
import { fileChannel, type DecisionChannel } from "../decide/external-channel.js";
import { pMapBounded } from "../async-pool.js";
import { isVmSessionsPath } from "../vm-paths.js";

/** Upper bound for `record --concurrency`. Above a handful, concurrent runs exhaust Docker's default address
 *  pool (each run creates two networks) and press model API rate limits — both surface as actionable errors. */
const MAX_RECORD_CONCURRENCY = 8;
import { evaluate, budgetFields, HOSTLOOP_ONLY_KEYS, type AssertContext } from "../assert.js";
import {
  planMutationsWithStats,
  summarizeMutationPlan,
  matchesAnyGlob,
  applyMutation,
  explainNoMutations,
  type MutationCoverage,
} from "./mutate.js";
import { anyGlobMatches } from "../glob.js";
import { extractComputerLinks } from "./computer-links.js";
import { makeRenderer, renderFooter, type RenderPlan } from "./renderer.js";
import { jsonEnvelope, jsonPayloadEnvelope, fail, isJsonOutput, pkgVersion } from "./envelope.js";
import { parseArgs } from "../cli-args.js";
import { resolveInputs } from "./inputs.js";
import { realProbe } from "./doctor.js";
import {
  hashSkillDirs,
  hashSharedOnly,
  computeContentSig,
  skillHashEntries,
  OS_JUNK_PATTERN,
  agentSkillName,
  ACTIVE_HASH_ALGO,
  foldSnapshot,
  renderWireEntries,
  contentSigFromSnapshot,
} from "./skill-hash.js";

/** What NEW fingerprints record. Absent on a fingerprint means the legacy transform, so only the post-epoch
 *  algorithm is ever written out. */
const ACTIVE_HASH_FORMAT: "jcs1" | undefined = ACTIVE_HASH_ALGO === "jcs1" ? "jcs1" : undefined;
import { computeVerdict } from "./verdict.js";
import { redactJsonLine, redactText, redactStructural, loadRedactionPolicy, type RedactionPolicy } from "../redact.js";
import { collectSecrets, scrubField } from "../secrets.js";
import {
  scanText,
  scanHostInventory,
  DEFAULT_SCAN_PATTERNS,
  MANIFEST_SCAN_PATTERNS,
  HOST_INVENTORY_CLS,
  type ScanFinding,
  type AllowInput,
  type AllowPattern,
} from "../scan.js";
import { parse as parseYaml } from "yaml";

// Synchronous fd writes (match cli.ts): a `process.stdout.write` + `process.exit()` pair truncates the
// machine envelope on a PIPE (fd 1 goes non-blocking once the stream is touched; the async tail is dropped
// at exit past the ~64KB buffer). writeAllSync retries EAGAIN and loops on short writes (see src/io.ts) —
// a bare writeSync does NOT block until drained once the fd is non-blocking.
const out = (s: string) => writeAllSync(1, s + "\n");
const log = (s: string) => writeAllSync(2, s + "\n");

/** Format a record error for the user. An `UnansweredError` carries the offered labels (and a closest-match
 *  suggestion) in `.hint`; the record catch sites historically printed only `.message`, so a scripted-answer
 *  mismatch hid what WAS offered. Surface the hint — guarded by `!message.includes(hint)` so the
 *  `on_unanswered: fail` terminal (which duplicates its option lines into BOTH message and hint) doesn't
 *  double-print. The mismatch throw keeps the labels solely in the hint, so they get appended. Exported for
 *  tests. */
export function recordErrorText(e: unknown): string {
  const msg = (e as Error).message;
  if (e instanceof UnansweredError && e.hint && !msg.includes(e.hint)) return `${msg}\n    ${e.hint}`;
  return msg;
}

/**
 * Build the cassette's `environment` provenance block. Pure and exported ONLY so it is unit- and
 * mutation-testable OFFLINE: `recordScenarioObject` needs a live agent spawn, so an inline stamp could be
 * asserted only on the live lane (see the standing notes in test/cli-json.test.ts and siblings). Same
 * reason `defaultCassettePath` is exported.
 */
export function buildEnvironmentProvenance(
  tier: string | undefined,
  agentBinaryFormat: string | undefined,
  agentImage?: AgentImageProvenance,
): {
  location: "local";
  tier?: string;
  agentBinaryFormat?: string;
  harnessVersion: string;
  agentImage?: AgentImageProvenance;
} {
  // Spread rather than `agentImage,`: a non-container tier ran no image, and an explicit
  // `agentImage: undefined` would both dirty every protocol cassette and break the schema's
  // "absence is meaningful" contract, which readers rely on to tell "no image" from "field predates
  // this harness". Pinned by a `"agentImage" in …` assertion, not a toEqual.
  return { location: "local", tier, agentBinaryFormat, harnessVersion: pkgVersion(), ...(agentImage ? { agentImage } : {}) };
}

/** Compare a cassette's recorded image identity against the one about to be replayed. Returns a warning
 *  string, or null when there is nothing trustworthy to compare.
 *
 *  Compares `registryDigest` FIRST because it is the only identity stable across machines, which is the
 *  whole motivating case (record on A, replay on B). `configId` is a fallback used only when NEITHER
 *  side has a registry digest: two local builds of the same recipe differ by construction, so a
 *  configId-first comparison would warn on every cross-machine replay. That fallback is deliberately
 *  conservative — a local rebuild genuinely may not match the recording.
 *
 *  Advisory only, never a replay failure: a legitimately re-pulled image is the common case, and a hard
 *  failure would make the field a liability rather than information. */
export function imageProvenanceMismatch(recorded: AgentImageProvenance | undefined, current: AgentImageProvenance): string | null {
  if (!recorded) return null; // recorded before the field existed — absence is meaningful, not drift
  const note = (what: string) =>
    `[image] this cassette was recorded against ${recorded.ref} (${what}) but the current ${current.ref} differs — ` +
    `capability probes, and any verdict depending on missingCapabilityUse, may differ from the recording.`;

  if (recorded.registryDigest && current.registryDigest)
    return recorded.registryDigest === current.registryDigest ? null : note(recorded.registryDigest.slice(0, 19) + "…");
  // Pulled on one side, locally built on the other: that IS drift, and no same-field comparison sees it.
  if (recorded.registryDigest && current.configId) return note("a pulled image; the current one is locally built");
  if (recorded.configId && current.configId)
    return recorded.configId === current.configId ? null : note(recorded.configId.slice(0, 19) + "…");
  return null; // current image unidentifiable (daemon down) — nothing to compare
}

/** Write a committed cassette atomically — a mid-write crash must never leave a partial/corrupt file at
 *  the real path. Write to a same-dir temp (pid-suffixed so two concurrent writers can't collide) then
 *  `renameSync` over the target (atomic on POSIX). Mirrors the external-channel.ts temp+rename pattern. */
function writeFileAtomic(path: string, data: string): void {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/** A snapshotted artifact — relative path + size + content hash, plus an inlined raw body for small
 *  files (so `artifact_json`/`file_exists`/`user_visible_artifact` survive token-free replay). A file too
 *  big to inline is hash-only with `truncated:true` (a loud marker — silent truncation reads as "covered"). */
export interface ManifestEntry {
  path: string; // relative to the work root, e.g. "outputs/cap_state.json"
  bytes: number;
  sha256: string;
  body?: string; // inlined small-file body (≤ cap) — materialized on replay so JSON asserts work
  /** how `body` is encoded. "utf8" (default/absent) for text; "base64" for non-UTF-8/binary
   *  bodies, which would otherwise corrupt on a `toString("utf8")` round-trip (and then false-fail the
   *  sha256 verify, since the hash is over the RAW bytes). */
  encoding?: "utf8" | "base64";
  truncated?: boolean; // too big to inline → hash-only (file_exists/user_visible_artifact PASS — existence proven by path+sha; artifact_json cannot run)
  /** WHY the body is absent, when `truncated` — so replay gives the precise artifact_json remedy without a
   *  cassette-level roots list. "size" = over the body cap (raise --max-artifact-bytes); "readonly" = a
   *  mode:r connected-folder input (assert on a deliverable instead); "input" = an UPLOADED file (captured
   *  hash-only — a user's private upload is never inlined into a committed cassette; input_unmodified still
   *  guards it via the sha256, and a change IS attributable to the agent, unlike "readonly"); "unreadable" =
   *  a read/containment failure at record time (sha256 is ""). ABSENT on pre-v8 cassettes → replay falls
   *  back to naming both size/readonly causes. v8+. */
  truncationReason?: "size" | "readonly" | "unreadable" | "input";
  /** v10: this entry is a symlink or hardlink, NOT a regular file. Recorded path+kind only (body-less,
   *  sha256 ""), never dereferenced — so an agent-created link stray is visible to `no_unexpected_files`
   *  on replay (materializes as an empty placeholder, counted by the path walk), without inlining any
   *  out-of-root target content into the committed cassette. ABSENT = regular file (all pre-v10 entries). */
  linkKind?: "symlink" | "hardlink";
}

/** A staleness tripwire over the inputs that determine the recording — mirrors `asarFingerprint`
 *  (warn-don't-fail; `--strict` hardens). `baseline` is the canonical staleness cause (a Cowork bump);
 *  `skillHash` covers local skill/plugin edits (the dev-loop case). */
// Cap the per-file manifest so a huge plugin tree doesn't bloat a committed cassette; above this, omit it
// (fileSigsOmitted:true) and degrade to the bucket-level message — loudly, never silently.
const MANIFEST_MAX_FILES = 2000;

export interface Cassette {
  $schema?: string; // provenance: schema URL for this cassette format version
  generator?: string; // provenance: tool that produced this file ("cowork-harness")
  // Schema version of the cassette FORMAT (not the package). Bump when the structure changes in a way a
  // reader must branch on (a new manifest-entry shape, a fingerprint-algorithm change, a2's nonDeterministic
  // provenance, …). ABSENT = pre-versioning legacy (treated as 0). Stamping it now — while ~no cassettes
  // exist in the wild — lets future evolution branch cleanly instead of guessing a cassette's age.
  cassetteVersion?: number;
  scenario: Scenario;
  events: string[]; // recorded child→driver stdout (events.jsonl) — the cassette source
  controlOut?: string[]; // driver→child control_responses (control-out.jsonl) — for full-fidelity replay
  effectiveFidelity?: string; // the tier the live record actually resolved to (e.g. cowork → hostloop)
  artifacts?: ManifestEntry[]; // user-visible-roots snapshot (paths + hashes + small JSON bodies)
  fingerprint?: Fingerprint; // cassette→skill/baseline staleness tripwire
  // v4: the user-visible mount roots captured at record time (`outputs` + each connected folder's resolved
  // mount name). Replay reads THIS instead of a hardcoded `["outputs",".projects"]` prefix — folder mount
  // names are dynamic/gated. ABSENT on pre-v4 cassettes → replay falls back to the legacy prefix.
  userVisibleRoots?: string[];
  // (v8 removed the cassette-level `readonlyFolderRoots` list — replay now reads WHY a body-less entry
  // is body-less from each `ManifestEntry.truncationReason`, which is self-describing and redaction-immune.)
  // the authored scenario SOURCE file this cassette was recorded from, RELATIVE to the cassette dir
  // (relocatable, no absolute host path). `record --rerecord-stale` prefers this over a `slugForPath(name)`
  // guess so an authored `name:` that differs from the filename still re-records from the edited YAML rather
  // than silently re-recording the embedded snapshot. ABSENT when recorded from an in-memory/inline scenario.
  scenarioSource?: string;
  // workRoot-relative paths that existed under the user-visible roots BEFORE the agent ran — the baseline
  // `no_unexpected_files` diffs against on replay. Optional metadata following the `authoring` precedent:
  // NO cassetteVersion bump (CassetteShape is a looseObject and cassette.v7.json has no
  // additionalProperties:false, so older readers pass it through; readers here branch LOUDLY on absence —
  // a pre-field cassette EXCLUDES the key from replay with a warning, never a vacuous pass). Always
  // co-present with `userVisibleRoots` (both written by the same record assembly below), so the legacy
  // `["outputs",".projects"]` replay-roots fallback can never apply to a cassette that carries this field.
  preRunPaths?: string[];
  // Per-path sha256 of the user-visible tree BEFORE the agent ran (RunResult.preRunHashes). Powers
  // `input_unmodified` on replay. Nulled out (see buildCassette's post-scrub pass below) for any path
  // whose recorded artifact body was secret-scrubbed at record time — a scrubbed body's committed
  // sha256 no longer matches the raw pre-run hash, so a false "modified in place" would otherwise fire on
  // replay; nulling makes that path report evidence-unavailable instead (loud, never a false verdict).
  preRunHashes?: Record<string, string | null>;
  // provenance of the pre-run baseline (RunResult.preRunOrigin). A cassette recorded from a run whose
  // connected-folder source was unreadable carries `local-unreadable` here, so replay makes
  // no_unexpected_files / input_unmodified fail evidence-unavailable rather than diffing an incomplete
  // baseline — the same verdict the live lane reaches. Optional metadata (same looseObject precedent as
  // preRunPaths above): NO cassetteVersion bump; absent on a pre-field cassette ⇒ the replay ctx falls
  // back to the preRunPaths/preRunHashes presence check, never assuming local-walk.
  preRunOrigin?: "local-walk" | "remote-unavailable" | "local-unreadable";
  // provenance: how this cassette's gate answers were authored. PRESENT with nonDeterministic:true means a
  // live decider actually answered ≥1 gate during recording (a driving agent via `--decider-dir`, a model
  // via `--decider-llm`, or an `--on-unanswered first` auto-pick) — so RE-recording may drift. The cassette
  // itself still REPLAYS deterministically (the answers are frozen). ABSENT = fully scripted/deterministic
  // authoring. Pure metadata: readers (replay/verify-cassettes) ignore it; no cassetteVersion bump needed.
  authoring?: { nonDeterministic: boolean; channel?: "decider-dir" | "decider-llm" };
  // The recorded timeline (see src/agent/timeline.ts) — harness-observation timestamps for every
  // meaningful in-run event, in total order. `ts` values are wall-clock-observation-time and are
  // NOT reproducible on a replay re-drive (like `usage`/`cost`, they are frozen, not recomputed), so
  // they are persisted here rather than regenerated. ABSENT on a cassette recorded before this field
  // existed, or in the rare case `timeline.jsonl` was empty/unreadable at record time — timing folds
  // that read this are informational only (no verdict impact), so absence needs no loud warning,
  // unlike the manifest/gate keys. Additive: CassetteShape is a looseObject, so no version bump.
  timeline?: TimelineEvent[];
  timelineHeader?: TimelineHeader;
  // v9: session-SHAPE fingerprint (Finding 23) — a stable hash of the resolved session's content-
  // relevant fields (connected folders + mode, plugin/skill/mcp discovery config, egress allowlist) at
  // record time (see `buildSessionFingerprint`). Distinct from `fingerprint.skillHash` (skill/plugin
  // FILE content): the session can drift — a folder swapped, egress widened — with the skill tree
  // completely untouched, invisible to `fingerprint`. Recomputed and compared ONLY by `verify-cassettes`
  // (see `sessionFingerprintDrift`) — deliberately NOT folded into `computeStaleness`/`checkStaleness`,
  // so it never changes the default `replay` verdict (not even under `--strict`). ABSENT on a pre-v9
  // cassette → not checked (backward-compat: an existing committed cassette never goes stale from this).
  sessionFingerprint?: string;
  // v9: the record-time connected-folder host-path -> resolved-mount-name correspondence (Finding 24),
  // persisted so `computer_links_resolve` on replay normalizes a host-shaped link against THIS
  // (guaranteed record-time-accurate) map instead of re-deriving it from the session file on disk AT
  // REPLAY TIME — the prior approach (still used for a pre-v9 cassette, see `buildFolderPrefixMap`),
  // which can silently zip against the WRONG host paths when the session changed since record but
  // happens to still declare the same folder COUNT. ABSENT on a pre-v9 cassette → replay keeps the
  // legacy current-session reconstruction (backward-compat). ABSENT on a v9+ cassette (unexpected —
  // record always sets this when the folder count is derivable) → replay refuses to fall back to the
  // current session and instead treats every host-shaped folder link as evidence-unavailable (Finding 25).
  folderPrefixMap?: Array<{ from: string; mount: string }>;
  // Recording ENVIRONMENT provenance — the location + tier this cassette was recorded under. Stamped
  // `location:"local"` on every recording (this harness records only local runs), so a hypothetical
  // future cloud-recorded cassette is positively distinguishable. `tier` is the resolved effective
  // fidelity; `agentBinaryFormat` mirrors baseline.agentBinary.format; `harnessVersion` is the CLI that
  // RECORDED it — the one fidelity input with no other trace, since a harness-code change (e.g. a new
  // declared tool surface) can shift recorded behavior at an UNCHANGED baseline, which no staleness class
  // keys off. Additive, looseObject → no CASSETTE_VERSION bump. Readers that don't know it ignore it, and
  // its ABSENCE positively means "recorded before 1.11.0" (never backfill it).
  environment?: {
    location: "local" | "cloud";
    tier?: string;
    agentBinaryFormat?: string;
    harnessVersion?: string;
    agentImage?: AgentImageProvenance;
  };
}

/** Current cassette format version. Readers tolerate a FUTURE version (warn) but REFUSE anything below
 *  MIN_SUPPORTED_CASSETTE_VERSION (see readCassette) — pre-1.0, no legacy-format compatibility is
 *  maintained. Historical summary of the now-unreadable v2-v8 evolution (fingerprint scoping in v2,
 *  algorithm-independent contentSig in v3, userVisibleRoots persistence in v4 — never published — OS-junk
 *  exclusion + per-file manifest in v5, the git-tracked-file-set staleness redesign in v6, NUL-byte entry
 *  separators in v7, the folded-content-sha manifest format in v8): these are why the number is 10, but
 *  their branch-by-branch behavior no longer exists in this codebase.
 */
// v9: two OPTIONAL fields, neither touching skillHash/contentSig (CONTENTSIG_ALGO stays 4 — a v8
// cassette's skill fingerprint remains directly comparable, no re-record forced by this bump alone):
//  `sessionFingerprint` — a hash of the session's content-relevant SHAPE (connected folders, plugin/
//  skill/mcp discovery config, egress allowlist), checked ONLY by `verify-cassettes` (never the default
//  replay verdict — see `sessionFingerprintDrift`); and `folderPrefixMap` — the record-time
//  connected-folder host-path → resolved-mount-name correspondence, persisted so replay's
//  `computer_links_resolve` stops re-deriving that map from the CURRENT (possibly since-changed)
//  session file (see `buildFolderPrefixMap`). Both ABSENT on a pre-v9 cassette → the legacy behavior
//  applies unchanged (no session-fingerprint check; folder links reconstruct from the current session).
// v10: ManifestEntry.linkKind (#38). buildManifest now records symlink/hardlink entries (body-less,
//  path+kind only, never dereferenced) so an agent-created link stray materializes on replay and is seen
//  by no_unexpected_files — closing a live/replay false-green. CONTENTSIG_ALGO is unchanged (a manifest-
//  SHAPE change, not a fingerprint-algorithm change), so a v9 cassette's skill fingerprint stays directly
//  comparable and this bump alone forces no re-record. ABSENT linkKind on a pre-v10 entry = regular file
//  (the pre-fix behavior — such a cassette simply never captured links; safe because it can't have
//  recorded a link stray in the first place). `rehash` cannot synthesize link entries from an old
//  manifest, so it routes a v9→v10 bump to a re-record (see cmdRehash).
// v11 (P8): `cassetteVersion` stops meaning "which recorder wrote this" and starts meaning "the minimum
//  format version a reader needs to INTERPRET this cassette correctly" — see requiredVersionFor below.
//  The only value that currently needs v11 is `lane: "remote"` (changes replay-verdict semantics a
//  pre-lane reader doesn't know about); `lane: "local"`/omitted — nearly every existing scenario — still
//  stamps v10, unchanged. No hashing or manifest-shape change; HASH_FORMAT_EPOCH stays at v8.
export const CASSETTE_VERSION = 12;

/** Minimum cassette format version this build will read. Pre-1.0.0: no legacy-format compatibility is
 *  maintained below this floor — an older cassette must be re-recorded, not silently tolerated. Raising
 *  this floor is how the pre-v9 legacy-reconstruction branches (buildFolderPrefixMap, cmdRehash's
 *  pre-v3/pre-v6 checks, contentSigAlgoOf) became dead code and were deleted. */
export const MIN_SUPPORTED_CASSETTE_VERSION = 9;

// The contentSig algorithm version: every v9+ cassette (the read floor) was recorded under this same
// algorithm — skillHash folds fixed-length content shas and contentSig/link entries are type-prefixed &
// NUL-framed (closes unframed-concatenation collisions). Kept as documentation of which algorithm
// version is now implicitly guaranteed by the read floor; no code branches on it anymore (the classifier
// that once compared a per-cassette algorithm version against this constant was deleted with the floor).
const CONTENTSIG_ALGO = 5;

/** The last cassette format version that actually changed HASHING (skillHash/contentSig framing or
 *  algorithm) — v7→v8 bumped CONTENTSIG_ALGO 3→4 to fix the two framing collisions (see CHANGELOG). v9
 *  and v10 both changed the cassette SHAPE (sessionFingerprint/folderPrefixMap; ManifestEntry.linkKind)
 *  without touching skillHash/contentSig — their own comments above say so explicitly — and v11 (P8)
 *  changes neither; it's a per-scenario interpretation floor, not a hash-format change. computeStaleness's
 *  "recorded under an older hash format" classification keys off THIS constant, not CASSETTE_VERSION —
 *  otherwise a correctly-current v9/v10/v11 cassette with genuine skill drift would get a false "older
 *  format" finding and lose its per-bucket drift attribution. */
const HASH_FORMAT_EPOCH = 12;

/** Canonical URL of the JSON Schema for a given STAMPED cassette version.
 *  Appears in every written cassette as `$schema` so editors and unfamiliar readers can discover what
 *  tool produced the file and what the format means. A function, not a module-level constant derived from
 *  CASSETTE_VERSION: P8 stamps a version PER SCENARIO (see requiredVersionFor), so a v10-stamped cassette
 *  must carry the v10 URL even while this build's max is v11. */
export function cassetteSchemaUrl(version: number): string {
  return `https://raw.githubusercontent.com/yaniv-golan/cowork-harness/main/schema/cassette.v${version}.json`;
}

/** For each `ScenarioObject` key: the minimum cassette format an OLDER reader needs to interpret THIS
 *  VALUE correctly. Value-aware ON PURPOSE, NOT key-presence: `lane` carries a Zod `.default("local")`
 *  (src/types.ts), so EVERY parsed scenario carries the key — a presence-based map would stamp v11 on
 *  every cassette, exactly the unconditional bump this mechanism exists to avoid (the falsified v1
 *  design). Returning 0 means "any supported reader interprets this value the same way" — the BASE=10
 *  floor in requiredVersionFor still applies via Math.max, so 0 is not "no version".
 *  MUST carry one entry per ScenarioObject.shape key (15 today) — enforced by a coverage test in
 *  test/cassette-version-stamp.test.ts. Adding a scenario key without deciding its cassette-version
 *  impact must red CI, not silently default to 0. */
export const KEY_REQUIRED_VERSION: Record<string, (v: unknown) => number> = {
  name: () => 0,
  baseline: () => 0,
  session: () => 0,
  fidelity: () => 0,
  execution: () => 0,
  // `lane: "remote"` changes what a replay verdict MEANS (location delivers nothing; present_files is not
  // served) — a pre-lane reader doesn't know that and would misread it. `lane: "local"` (the default, and
  // the only behavior a pre-lane reader has ever had) needs no bump.
  lane: (v) => (v === "remote" ? 11 : 0),
  prompt: () => 0,
  timeout_ms: () => 0,
  answers: () => 0,
  on_unanswered: () => 0,
  expect_denied: () => 0,
  assert: () => 0,
  skills: () => 0,
  requires_capabilities: () => 0,
  allow_host_writes: () => 0,
};

/** The minimum cassette format version a reader needs to correctly interpret this scenario — what gets
 *  STAMPED at every write site (record, rehash). NOT "which recorder wrote it" (see the CASSETTE_VERSION
 *  doc comment). BASE=10 is the format floor from before `lane` existed. `scenario` is `unknown` because
 *  callers hold values of different strictness — `record` has a parsed `Scenario`, `rehash` has an
 *  on-disk cassette's frozen scenario read through CassetteShape's loose passthrough, not the strict
 *  schema. */
export function requiredVersionFor(scenario: unknown): number {
  const s = (scenario ?? {}) as Record<string, unknown>;
  // Derived, never hard-coded: this is what actually gets STAMPED at both write sites, so a hash-format
  // bump that moved only CASSETTE_VERSION/HASH_FORMAT_EPOCH would write new-algorithm digests into
  // cassettes stamped with an old version — permanently mislabelled, and unprovable at the next epoch.
  const BASE = HASH_FORMAT_EPOCH;
  return Math.max(BASE, ...Object.entries(KEY_REQUIRED_VERSION).map(([key, required]) => required(s[key])));
}

const DEFAULT_MANIFEST_BODY_CAP = 64 * 1024; // inline JSON/text bodies ≤ 64 KiB; larger → hash-only + truncated marker

/** Shared positive-integer validator for the artifact-body cap. Used by BOTH the `--max-artifact-bytes`
 *  CLI flag and the `COWORK_HARNESS_MAX_ARTIFACT_BYTES` env var so the two can't diverge. Returns
 *  the floored value or null when invalid/non-positive — the caller decides how to fail loudly. */
export function parseMaxArtifactBytes(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/** The effective inline-body cap. Overridable so a large structured deliverable can opt into inlining
 *  rather than silently truncating — which would pass `artifact_json` at record (on-disk) but fail at replay
 *  (no body). Env `COWORK_HARNESS_MAX_ARTIFACT_BYTES`; `record --max-artifact-bytes` takes precedence via the
 *  explicit `cap` argument to buildManifest. An INVALID/non-positive env value now THROWS (fail loud,
 *  matching the `--max-artifact-bytes` flag) instead of silently falling back to the default. */
function defaultBodyCap(): number {
  const env = process.env.COWORK_HARNESS_MAX_ARTIFACT_BYTES;
  if (env !== undefined) {
    const n = parseMaxArtifactBytes(env);
    if (n === null) throw new Error(`COWORK_HARNESS_MAX_ARTIFACT_BYTES must be a positive integer (got ${JSON.stringify(env)})`);
    return n;
  }
  return DEFAULT_MANIFEST_BODY_CAP;
}

/** Resolve `rel` against `root` and confirm it stays inside `root`. Returns the absolute path on success;
 *  throws on an absolute path, a `..` escape, or anything that resolves outside the root.
 *  Used both at record time (containment before reading an artifact body) and at replay time
 *  (containment before writing a materialized entry). */
function containedPath(root: string, rel: string): string {
  if (isAbsolute(rel)) throw new Error(`artifact path "${rel}" is absolute — refusing (must be relative to the work root)`);
  const rootResolved = resolve(root);
  const abs = resolve(rootResolved, rel);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + sep))
    throw new Error(`artifact path "${rel}" escapes the work root — refusing (path traversal)`);
  return abs;
}

/** Snapshot the user-visible artifacts under `workRoot` into manifest entries.
 *  Exported for token-free record→replay round-trip tests. */
/** Roots holding UPLOADED inputs. Walked separately from `roots`, so by construction they never enter
 *  `recordRoots` / `cassette.userVisibleRoots` — adding them there would misalign
 *  `buildRecordTimeFolderPrefixMap`'s positional zip against `session.folders` and would wrongly make
 *  `user_visible_artifact: uploads/x` pass. Exported because `redactCassette`'s artifact↔root check must
 *  accept these paths too: an upload artifact is never under a user-visible root, so measuring it against
 *  that set reports a redaction fault that did not happen. Both sides must read this one constant. */
export const INPUT_ROOTS = ["uploads"] as const;

export function buildManifest(
  workRoot: string,
  cap?: number,
  roots: string[] = ["outputs", ".projects"],
  bodyLessPrefixes: string[] = [],
  inputRoots: string[] = [...INPUT_ROOTS],
): ManifestEntry[] {
  const limit = cap ?? defaultBodyCap();
  // Read-only connected-folder inputs (`bodyLessPrefixes`) are captured path+bytes+sha256 only, same as
  // an over-cap entry — no body, so no bloat and no `binary` privacy finding (cassette.ts binary scan
  // only fires on a committed base64 body). The manifest entry SURVIVES (unlike full exclusion) so
  // `materializeManifest` writes a 0-byte placeholder and `computer_links_resolve` resolves identically
  // on live and replay (see T3 in the pre-1.0 fix plan).
  const isBodyLess = (path: string): boolean => bodyLessPrefixes.some((prefix) => path === prefix || path.startsWith(prefix + "/"));
  // Path+link-kind walk (v10): it EMITS symlink/hardlink entries the content walk skipped, so a link
  // stray survives into the manifest → materializes as a placeholder → is seen by no_unexpected_files on
  // replay, matching live. Link entries are path+kind only (never dereferenced/read), so no out-of-root
  // target content is inlined into the committed cassette.
  // Uploaded inputs (`inputRoots`, default "uploads") are captured HASH-ONLY, always body-less with reason
  // "input" — a user's private upload is never inlined into a committed cassette, yet input_unmodified can
  // still guard it (the sha256 survives) AND a change is correctly attributed to the agent (unlike a
  // "readonly" connected folder, which the assert layer excuses as external). Walked separately from `roots`
  // so they never enter recordRoots / cassette.userVisibleRoots (which drive materialize prefixes + the
  // folder-prefix zip). Prefixes are disjoint (uploads/ vs outputs/ vs folders), so no dedup is needed. #Item2
  const readEntry = (e: { path: string; linkKind?: "symlink" | "hardlink" }, forceBodyLessReason?: "input"): ManifestEntry => {
    const { path, linkKind } = e;
    if (linkKind) return { path, bytes: 0, sha256: "", linkKind }; // body-less; never read the target
    // Regular file: re-confirm containment before reading the body (never inline out-of-work-root content).
    let abs: string;
    try {
      abs = containedPath(workRoot, path);
    } catch {
      return { path, bytes: 0, sha256: "", truncated: true, truncationReason: "unreadable" };
    }
    let buf: Buffer;
    try {
      buf = readFileSync(abs);
    } catch {
      return { path, bytes: 0, sha256: "", truncated: true, truncationReason: "unreadable" };
    }
    const bytes = buf.length;
    const sha256 = createHash("sha256").update(buf).digest("hex");
    // truncationReason names WHY the body is absent so replay can give the precise remedy without a
    // cassette-level roots list: "input" (an uploaded file — hash-only), "readonly" (a mode:r connected
    // folder input), "size" (over the body cap — raise --max-artifact-bytes). "unreadable" is the catches above.
    if (forceBodyLessReason) return { path, bytes, sha256, truncated: true, truncationReason: forceBodyLessReason };
    if (isBodyLess(path)) return { path, bytes, sha256, truncated: true, truncationReason: "readonly" };
    if (buf.length > limit) return { path, bytes, sha256, truncated: true, truncationReason: "size" };
    // store an encoding marker. UTF-8-safe bodies stay text (readable cassettes); binary bodies go
    // base64 so the record→replay round-trip is byte-exact and the sha256 verify stays valid.
    if (isLosslessUtf8(buf)) return { path, bytes, sha256, body: buf.toString("utf8") };
    return { path, bytes, sha256, body: buf.toString("base64"), encoding: "base64" };
  };
  const userVisible = collectArtifactPaths(workRoot, roots).map((e) => readEntry(e));
  const inputs = inputRoots.length ? collectArtifactPaths(workRoot, inputRoots).map((e) => readEntry(e, "input")) : [];
  return [...userVisible, ...inputs];
}

/** decode an entry's body to its RAW bytes per the encoding marker (default utf8). */
function decodeBody(e: ManifestEntry): Buffer {
  if (e.body === undefined) return Buffer.alloc(0);
  return Buffer.from(e.body, e.encoding === "base64" ? "base64" : "utf8");
}

/** Materialize a manifest into a temp work root so replay can run the filesystem assertions against it.
 *  Small files get their inlined body (decoded per its encoding marker); hash-only (truncated)
 *  files get an empty placeholder. A truncated entry carries path+bytes+sha256 — positive proof the
 *  file existed at record time — so file_exists and user_visible_artifact PASS from the manifest;
 *  only artifact_json fails loud (it needs the inlined body). each path is containment-checked before
 *  writing so a hostile cassette entry can't escape the temp root. every non-truncated body is verified
 *  against its recorded sha256 (over the decoded RAW bytes) — a mismatch fails replay (throws). */
export function materializeManifest(
  entries: ManifestEntry[],
  roots: string[] = ["outputs", ".projects"],
): { workRoot: string; prefixes: string[]; truncatedPaths: Map<string, ManifestEntry["truncationReason"]>; linkPaths: Set<string> } {
  const workRoot = mkdtempSync(join(tmpdir(), "cwh-replay-"));
  // path → why the body is absent (from the entry's truncationReason; `undefined` on a pre-v8 entry that
  // had no reason). `.has()` still means "is body-less"; `.get()` gives the reason for the precise remedy.
  const truncatedPaths = new Map<string, ManifestEntry["truncationReason"]>();
  // v10 link entries (symlink/hardlink) materialize as a placeholder file that is INDISTINGUISHABLE from a
  // real file — so existence assertions (file_exists / user_visible_artifact / computer_links_resolve) would
  // PASS on replay where live could RED a dangling/escaping symlink (a false-green). The cassette records
  // only that a link EXISTED at the path, not that it RESOLVED, so replay must fail those checks CLOSED
  // (evidence-unavailable). This set carries the link paths to the assertion layer.
  const linkPaths = new Set<string>();
  for (const e of entries) {
    const abs = containedPath(workRoot, e.path); // reject absolute / `..` / out-of-root before writing
    const raw = decodeBody(e); // decode per the encoding marker
    // verify the non-truncated body against its recorded hash (over the RAW bytes). A truncated entry
    // carries no body (hash-only) — nothing to verify. Mismatch ⇒ a tampered/corrupt cassette ⇒ fail replay.
    if (!e.truncated && e.body !== undefined && e.sha256) {
      const got = createHash("sha256").update(raw).digest("hex");
      if (got !== e.sha256)
        throw new Error(
          `cassette artifact "${e.path}" body does not match its recorded sha256 (expected ${e.sha256}, got ${got}) — ` +
            `the cassette is corrupt or tampered; refusing to replay`,
        );
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, raw);
    if (e.truncated) truncatedPaths.set(relative(resolve(workRoot), abs), e.truncationReason);
    if (e.linkKind) linkPaths.add(relative(resolve(workRoot), abs));
  }
  return { workRoot, prefixes: roots, truncatedPaths, linkPaths };
}

/** The local skill/plugin/marketplace source dirs a session mounts — the "skill dir" hash unit.
 *  Returns ABSOLUTE dirs (for hashing/reading) plus `baseDir`, the session-file dir the relative
 *  `skillSources` are stored against (so the committed fingerprint carries no absolute host path). */
/** The declared-dir set a session contributes to the fingerprint, filtered to what exists on disk.
 *  Shared by the file-based and inline paths so both cover the SAME mount kinds. */
function declaredSkillDirs(cfg: SessionConfig): string[] {
  const allDeclared = [...cfg.skills.local, ...cfg.plugins.local_plugins, ...cfg.plugins.remote_plugins, ...cfg.plugins.local_marketplaces];
  return allDeclared.filter((d) => {
    if (existsSync(d)) return true;
    process.stderr.write(`cowork-harness: skill source dir declared in session does not exist: ${d} — skipping from fingerprint\n`);
    return false;
  });
}

/** Where a cassette's session path came from. Surfaced so an explicit override is never silent — a
 *  `--session` that pins the wrong tree would manufacture false greens, which is worse than an honest
 *  "cannot verify". */
export type SessionPathSource = "override" | "cassette-relative" | "as-given" | "inline";

/** Why a resolution produced no skill dirs. ABSENT means "resolved fine, the session simply declares
 *  none" — a distinction the call sites below could not previously make, because every failure path
 *  returned a bare `[]`. An empty `dirs` therefore meant *anything*: missing file, unparseable YAML, or
 *  a perfectly good session with no mounts. `buildFingerprint` then dropped `skillHash` either way. */
export type SessionResolutionFailure =
  | { kind: "inline-without-config" }
  | { kind: "not-found"; path: string }
  | { kind: "unreadable"; path: string; message: string }
  /** The session parsed, but EVERY declared skill root was filtered as non-existent by
   *  `declaredSkillDirs`. The most likely outcome of a WRONG `--session`: a session's mounts are relative
   *  to ITS OWN directory, so a correct session file copied or symlinked elsewhere declares real mounts
   *  that resolve to nothing. Distinct from "declares no mounts at all", which is not a failure. */
  | { kind: "declared-dirs-missing"; path: string; declared: number };

/** THE single cassette-relative join.
 *
 *  It was previously duplicated BYTE-IDENTICALLY in three different functions — `skillSourceDirs`,
 *  `buildSessionFingerprint` and `loadCassetteSessionFolders`. An override landing on only one of them
 *  produces a split-brain cassette: skill staleness resolves against the override while session-shape or
 *  folder resolution still resolves against the cassette dir. That failure is QUIET — a green replay with
 *  a sessionFingerprint note, or skills resolved against unresolved folders, and nothing names the
 *  inconsistency. Route every consumer through here. */
export function resolveCassetteSessionPath(
  sessionPath: string,
  cassetteDir?: string,
  override?: string,
): { path: string; source: SessionPathSource } {
  // Inline scenarios have no session FILE, so there is nothing an override could point at.
  if (sessionPath === "(inline)") return { path: sessionPath, source: "inline" };
  if (override) return { path: override, source: "override" };
  if (cassetteDir && !isAbsolute(sessionPath)) return { path: join(cassetteDir, sessionPath), source: "cassette-relative" };
  return { path: sessionPath, source: "as-given" };
}

function skillSourceDirs(
  sessionPath: string,
  cassetteDir?: string,
  inlineSession?: SessionConfig,
  override?: string,
): { dirs: string[]; baseDir: string; hashIgnore: string[]; source: SessionPathSource; failure?: SessionResolutionFailure } {
  const { path: resolved, source } = resolveCassetteSessionPath(sessionPath, cassetteDir, override);
  const baseDir = dirname(resolved);
  // The `skill`/`probe-dispatch` lanes mount via an in-memory session and pass the "(inline)" sentinel as
  // the path — there is no file to read, but the resolved session object carries the same mounts a session
  // FILE would. Use it when supplied; without it the sentinel still yields no dirs (unchanged behaviour).
  // Its paths are already absolute (resolveSessionPaths at the call site), so `skillSources` is stored
  // relative to cwd — the base those paths were resolved against — to avoid leaking an absolute host path.
  if (sessionPath === "(inline)") {
    if (!inlineSession) return { dirs: [], baseDir, hashIgnore: [], source, failure: { kind: "inline-without-config" } };
    return { dirs: declaredSkillDirs(inlineSession), baseDir: process.cwd(), hashIgnore: inlineSession.staleness.hash_ignore, source };
  }
  if (!existsSync(resolved)) return { dirs: [], baseDir, hashIgnore: [], source, failure: { kind: "not-found", path: resolved } };
  let cfg;
  try {
    // Mirror loadSessionFromFile (execute.ts): parse the YAML, then RESOLVE its relative skill/plugin
    // paths against the session-file dir (`baseDir` — the post-cassetteDir-join location, so this works for
    // both the record call (no cassetteDir) and the replay call (cassetteDir set)). Passing the raw path
    // string to loadSession() throws (it wants parsed YAML) — the swallowed throw is why skillHash was
    // silently never computed.
    cfg = resolveSessionPaths(loadSession(parseSessionFile(resolved)), baseDir);
  } catch (e) {
    // Previously a bare `return { dirs: [] }` — the swallowed throw is why skillHash was silently never
    // computed, per the comment above. Keep the same control flow; stop discarding the reason.
    return {
      dirs: [],
      baseDir,
      hashIgnore: [],
      source,
      failure: { kind: "unreadable", path: resolved, message: String((e as Error)?.message ?? e) },
    };
  }
  // session-declared ignore globs (added to any plugin-local .cowork-hashignore inside hashSkillDirs).
  const dirs = declaredSkillDirs(cfg);
  const declared = [...cfg.skills.local, ...cfg.plugins.local_plugins, ...cfg.plugins.remote_plugins, ...cfg.plugins.local_marketplaces]
    .length;
  // Declared > 0 but resolved 0 is a FAILURE, not an empty session — and reporting "this session mounts
  // none" for it states the opposite of the truth.
  const failure: SessionResolutionFailure | undefined =
    dirs.length === 0 && declared > 0 ? { kind: "declared-dirs-missing", path: resolved, declared } : undefined;
  return { dirs, baseDir, hashIgnore: cfg.staleness.hash_ignore, source, ...(failure ? { failure } : {}) };
}

/** Best-effort git commit provenance for the skill dirs a session mounts — the human-readable "which
 *  commit" correlate for the iterate-across-fixes loop. SECONDARY to the content-exact
 *  `fingerprint.skillHash` (which is the authoritative version key). Resolves over the SAME dir set that
 *  feeds skillHash (`skillSourceDirs`), so it covers plugin-mounted skills too. Returns the single `HEAD`
 *  shared by all those dirs, or `null` when they span more than one repo, any dir is not a git work tree
 *  (or has an unborn HEAD), git is absent, or the session mounts no skill dirs. Never throws. */
export function skillCommit(sessionPath: string, inlineSession?: SessionConfig): string | null {
  const { dirs } = skillSourceDirs(sessionPath, undefined, inlineSession);
  if (dirs.length === 0) return null;
  const commits = new Set<string>();
  for (const d of dirs) {
    try {
      const sha = execFileSync("git", ["-C", d, "rev-parse", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        // `-C` alone is not enough: an ambient GIT_DIR overrides it and every dir would resolve to
        // that repo's HEAD instead of its own.
        env: gitEnvWithoutAmbientRepo(),
      }).trim();
      if (!sha) return null;
      commits.add(sha);
    } catch {
      return null; // non-git dir, unborn HEAD, or git not on PATH
    }
  }
  return commits.size === 1 ? [...commits][0] : null;
}

// Takes the RESOLVED baseline OBJECT (never re-resolves by appVersion — that could hash a different
// committed baseline than a supported absolute custom baseline). Undefined = no prompt pointers, or a
// dangling pointer (evidence-unavailable, never a fabricated hash). Hashes the COMMENT-STRIPPED
// template (what renderPrompts actually renders — prompt.ts strips HTML comments before
// substitution), so a comment-only edit doesn't produce false staleness; {{tokens}} are left intact
// (they're deterministic pre-substitution).
type PromptAssetKey = "promptTemplate" | "subagentAppend" | "subagentAppendHostLoop";
export function hashBaselinePromptAssets(baseline: PlatformBaseline): string | undefined {
  const spawn = (baseline.spawn ?? {}) as Record<string, unknown>;
  const entries = (["promptTemplate", "subagentAppend", "subagentAppendHostLoop"] as const satisfies readonly PromptAssetKey[])
    .map((k) => [k, spawn[k]] as const)
    .filter((e): e is readonly [PromptAssetKey, string] => typeof e[1] === "string");
  if (entries.length === 0) return undefined;
  const h = createHash("sha256");
  for (const [key, rel] of entries) {
    const p = join(BASELINES_DIR, rel);
    if (!existsSync(p)) return undefined; // a dangling pointer already fails test/prompt-assets.test.ts
    h.update(key)
      .update("\0")
      .update(stripComments(readFileSync(p, "utf8")).trim())
      .update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

/** Prose files a gate option label could plausibly be authored in. Deliberately narrow: this scan reads
 *  every file under every mounted skill dir, so it must not walk node_modules-sized trees or binaries. */
const LABEL_PROSE_EXTS = new Set([".md", ".markdown", ".txt", ".yaml", ".yml", ".json"]);
/** Per-file cap on stamped labels, and total. A pathological catalog must not bloat every cassette. */
const LABEL_STAMP_MAX = 100;

/** Extract every AskUserQuestion option label a recorded run emitted, from the decision stream.
 *
 *  Sourced from `controlOut` because that is where the ANSWERED gate's full payload lands — a
 *  `control_response` whose `updatedInput.questions[].options[].label` echoes exactly what the model
 *  offered. Never grep the raw text for `"label"`: MCP tool SCHEMAS contain that key too, and the noise
 *  would swamp the signal. */
export function recordedGateLabels(controlOut: readonly (string | object)[] | undefined): string[] {
  const labels: string[] = [];
  for (const raw of controlOut ?? []) {
    try {
      const e = (typeof raw === "string" ? JSON.parse(raw) : raw) as {
        response?: { response?: { updatedInput?: { questions?: { options?: { label?: unknown }[] }[] } } };
      };
      for (const q of e?.response?.response?.updatedInput?.questions ?? [])
        for (const o of q?.options ?? []) if (typeof o?.label === "string" && o.label.trim()) labels.push(o.label);
    } catch {
      /* a malformed controlOut line is another check's finding */
    }
  }
  return [...new Set(labels)];
}

/** Stamp which emitted labels were VERBATIM in the skill's own prose, per file, ordered by where they
 *  appear in that file.
 *
 *  Scans the DELIVERED dirs and deliberately does NOT apply `hashIgnore` — that asymmetry is the point.
 *  Hash-ignored prose is mounted and readable by the agent while being invisible to `skillHash`, so it is
 *  exactly the class no other check can see. Applying the ignore list here would reproduce the blind spot
 *  this exists to close.
 *
 *  Only verbatim matches are stamped. A model-paraphrased label was never in the prose, so it cannot
 *  regress from absent to absent — checking it would fire on every run and train people to ignore this. */
export function stampLabelProvenance(labels: string[], dirs: string[]): Fingerprint["labelProvenance"] {
  if (!labels.length || !dirs.length) return undefined;
  const out: { file: string; labels: string[] }[] = [];
  let stamped = 0;
  for (const dir of [...dirs].sort()) {
    for (const abs of walkProseFiles(dir)) {
      if (stamped >= LABEL_STAMP_MAX) break;
      let text: string;
      try {
        text = readFileSync(abs, "utf8");
      } catch {
        continue; // unreadable prose is not a finding here; the hash path already reports read errors
      }
      // Order BY POSITION IN THE FILE, not by emission order — a catalog reorder changes this sequence
      // while leaving every label present, which is the case an existence-only check cannot detect.
      const found = labels
        .map((l) => ({ l, at: text.indexOf(l) }))
        .filter((x) => x.at >= 0)
        .sort((a, b) => a.at - b.at)
        .map((x) => x.l);
      if (!found.length) continue;
      const slice = found.slice(0, Math.max(0, LABEL_STAMP_MAX - stamped));
      stamped += slice.length;
      out.push({ file: relative(dir, abs), labels: slice });
    }
    if (stamped >= LABEL_STAMP_MAX) break;
  }
  return out.length ? out.sort((a, b) => (a.file < b.file ? -1 : 1)) : undefined;
}

/** Depth-bounded walk for prose files — bounded because this runs on every record over every mounted dir. */
function walkProseFiles(dir: string, depth = 0): string[] {
  if (depth > 6) return [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "dist") continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) files.push(...walkProseFiles(abs, depth + 1));
    else if (LABEL_PROSE_EXTS.has(extname(e.name).toLowerCase())) files.push(abs);
  }
  return files;
}

/** Re-check a stamped provenance against the CURRENT prose. Returns human-readable drift descriptions.
 *  Two drift kinds, both real regressions for a scenario whose `choose:`/`answers:` anchor a label:
 *    · vanished — the label is gone from the file it was authored in
 *    · reordered — every label still exists, but their order in the file changed (the catalog case) */
export function checkLabelProvenance(stamp: Fingerprint["labelProvenance"], dirs: string[]): string[] {
  if (!stamp?.length || !dirs.length) return [];
  const drift: string[] = [];
  for (const { file, labels } of stamp) {
    let text: string | undefined;
    for (const dir of dirs) {
      try {
        text = readFileSync(join(dir, file), "utf8");
        break;
      } catch {
        /* try the next mounted dir — `file` is dir-relative and dirs may overlap */
      }
    }
    if (text === undefined) continue; // the file itself is gone: skillHash/fileSigs already reports that
    const missing = labels.filter((l) => !text!.includes(l));
    if (missing.length) {
      drift.push(`gate option label(s) no longer in ${file}: ${missing.map((m) => `"${m}"`).join(", ")}`);
      continue; // an order claim over a changed set would be noise on top of a real finding
    }
    const now = labels
      .map((l) => ({ l, at: text!.indexOf(l) }))
      .sort((a, b) => a.at - b.at)
      .map((x) => x.l);
    // Element-wise, not a joined-string compare: a label may contain any character, so ANY separator
    // could collide with content (and a literal control byte as separator makes the file grep-hostile).
    if (now.length !== labels.length || now.some((l, i) => l !== labels[i]))
      drift.push(`gate option labels reordered in ${file}: recorded [${labels.join(", ")}], now [${now.join(", ")}]`);
  }
  return drift;
}

/**
 * Recompute a cassette's digests from ONE walk, under BOTH algorithms.
 *
 * The migration proof needs the LEGACY digest (to show a pre-epoch recording is unchanged) and the new
 * one (to write). Two separate walks would let a concurrent edit pass the proof and then migrate different
 * content, so both are folded from a single snapshot.
 *
 * `contentSig` is deliberately NOT the proof. It is algorithm-DEPENDENT (the manifest transform feeds it)
 * and, worse, it is blind to `D:` directory markers pre-v5 — an added empty directory moves `skillHash`
 * and leaves `contentSig` identical, so a contentSig-only proof would vouch for genuinely drifted content.
 */
export function recomputeBothAlgos(
  sessionPath: string,
  cassetteDir: string | undefined,
  scopeSkills: string[] | undefined,
  baselineAppVersion: string,
): {
  legacyHash: string;
  legacySigs: [string, string][];
  live: Fingerprint;
  mode: "git" | "raw";
  agentScoped: boolean;
  readErrors?: string[];
} | null {
  const { dirs, baseDir, hashIgnore } = skillSourceDirs(sessionPath, cassetteDir);
  if (dirs.length === 0) return null;
  const res = hashSkillDirs(dirs, scopeSkills, hashIgnore); // ONE walk — everything below folds from res.snapshot
  const entries = renderWireEntries(res.snapshot);
  const live: Fingerprint = {
    baseline: baselineAppVersion,
    hashFormat: ACTIVE_HASH_FORMAT,
    skillHash: res.hash,
    contentSig: contentSigFromSnapshot(res.snapshot),
    skillSources: dirs.sort().map((d) => relative(baseDir, d)),
    // Scoped cassettes carry `sharedHash` so `computeStaleness` can name WHICH bucket drifted. Three
    // constraints, and only one implementation satisfies all of them:
    //   - it must be RECOMPUTED, not carried over — `.claude-plugin/plugin.json` lives in the shared root,
    //     so its digest moves under jcs1 for any unsorted manifest;
    //   - it must not be DROPPED — `computeStaleness` splits buckets only when BOTH sides carry it, so
    //     losing it silently costs attribution forever;
    //   - it must be the value LIVE VERIFY will recompute. That rules out folding a filtered snapshot: the
    //     snapshot is git-tracked-filtered and agent-scope-blind, while `hashSharedOnly` does a raw walk and
    //     drops skill-named agents under COWORK_HARNESS_AGENT_SCOPE=skill. Either divergence produces a
    //     migrated value that can never match, so every later bucket split would report a false
    //     `shared-root`. Call the SAME function `buildFingerprint` calls, guard included.
    ...sharedHashFor(dirs, hashIgnore, scopeSkills),
    ...(res.mode === "git" ? { mode: "git" as const } : {}),
    ...(res.agentScoped ? { agentScope: "skill" as const } : {}),
    ...(entries.length > MANIFEST_MAX_FILES
      ? { fileSigsOmitted: true }
      : { fileSigs: entries.map((e) => [e.path, e.sha] as [string, string]) }),
  };
  return {
    legacyHash: foldSnapshot(res.snapshot, "legacy"),
    // The pre-epoch per-file manifest, for the alignment proof. `live.fileSigs` is already jcs1, so it
    // cannot be compared against what a pre-epoch cassette actually recorded.
    legacySigs: renderWireEntries(res.snapshot, "legacy").map((e) => [e.path, e.sha] as [string, string]),
    live,
    mode: res.mode,
    agentScoped: res.agentScoped,
    ...(res.readErrors ? { readErrors: res.readErrors } : {}),
  };
}

/**
 * Migrate a fingerprint across a hash-format bump: replace ONLY the algorithm-derived values, carry
 * everything else through from the RECORDING.
 *
 * A `{ ...liveFingerprint }` spread looks equivalent and is not. `buildFingerprint` cannot produce
 * `promptAssetsHash` unless it is handed a baseline object (rehash does not hand it one), and it never
 * produces `labelProvenance` at all — so the spread silently DELETED both provenance guards on every
 * migration. Measured: a recorded `promptAssetsHash` of 491afe2862dc67ea became absent.
 *
 * `fileSigs` keeps its RECORDED paths and takes only the new digests, index-aligned. Cassette paths are
 * redacted before writing, so rebuilding the list from a live walk would write unredacted source paths
 * back into a redacted cassette — a privacy regression. Alignment is validated first (an aggregate digest
 * proof says nothing about whether the array is well-formed), and absence is preserved rather than
 * materialised into a fresh live list.
 */
export function migrateFingerprint(
  recorded: Fingerprint,
  live: Fingerprint,
  legacySigs?: [string, string][],
): { fingerprint: Fingerprint } | { error: string } {
  // ALIGNMENT IS A PRECONDITION, not a best-effort. An aggregate digest proof says nothing about whether
  // the recorded manifest array is well-formed, and silently keeping OLD per-file digests beside a NEW
  // `skillHash` + `hashFormat: jcs1` would stamp a fingerprint that contradicts itself — every later
  // drift attribution would then name the wrong file while the cassette claimed to be current.
  if (recorded.fileSigs && live.fileSigs) {
    if (recorded.fileSigs.length !== live.fileSigs.length)
      return {
        error: `fileSigs entry count differs (recorded ${recorded.fileSigs.length}, live ${live.fileSigs.length}) — cannot migrate`,
      };
    for (let i = 0; i < recorded.fileSigs.length; i++) {
      const recIsLink = recorded.fileSigs[i][1].startsWith("lnk:");
      const liveIsLink = live.fileSigs[i][1].startsWith("lnk:");
      if (recIsLink !== liveIsLink) return { error: `fileSigs entry ${i} changed kind (file <-> link) — cannot migrate` };
    }
    // THE SEQUENCE PROOF. Count and kind do not establish that entry i is the SAME file on both sides: a
    // sort change, or two roots sharing a root-relative path, would pair a redacted path with another
    // file's digest while `rehash` still reported "migrated". Compare against the LEGACY manifest
    // recomputed from the proof snapshot — `live.fileSigs` is already jcs1 and cannot be compared to what
    // a pre-epoch cassette recorded.
    // MANDATORY, not opportunistic. Absence of the legacy recompute is a REFUSAL, not a skip: without it
    // count and kind would stamp `hashFormat: "jcs1"` beside index-aligned swaps that were never shown to
    // pair the same files. `migrateFingerprint` is exported, so a caller that omits it must not get a
    // weaker guarantee than `rehash` does.
    if (!legacySigs) return { error: "no legacy manifest to compare against — cannot prove fileSigs alignment; cannot migrate" };
    {
      if (legacySigs.length !== recorded.fileSigs.length)
        return {
          error: `fileSigs count differs from the legacy recompute (recorded ${recorded.fileSigs.length}, legacy ${legacySigs.length}) — cannot migrate`,
        };
      for (let i = 0; i < recorded.fileSigs.length; i++) {
        if (recorded.fileSigs[i][1] !== legacySigs[i][1])
          return { error: `fileSigs entry ${i} does not match the legacy recompute — order or content differs; cannot migrate` };
      }
    }
  } else if (recorded.fileSigs && !live.fileSigs) {
    // Recorded a manifest, cannot rebuild one: refuse rather than leave stale per-file digests beside a
    // new aggregate. The reverse is FINE — a cassette that never recorded `fileSigs` (pre-v5, or
    // `fileSigsOmitted` above the cap) keeps its absence; materialising a fresh live list would both
    // invent data the recording never had and write unredacted paths.
    return { error: "recorded fileSigs cannot be rebuilt from the current tree — cannot migrate" };
  }
  const out: Fingerprint = { ...recorded };
  out.skillHash = live.skillHash;
  out.hashFormat = live.hashFormat;
  if (live.contentSig !== undefined) out.contentSig = live.contentSig;
  else delete out.contentSig;
  if (live.sharedHash !== undefined) out.sharedHash = live.sharedHash;
  else delete out.sharedHash;
  out.mode = live.mode;
  // Index-aligned digest swap, RECORDED paths preserved (they are redacted; a live rebuild would write
  // unredacted source paths back into a redacted cassette). Absence is preserved, never materialised.
  if (recorded.fileSigs && live.fileSigs) {
    out.fileSigs = recorded.fileSigs.map(([p], i) => [p, live.fileSigs![i][1]] as [string, string]);
  }
  return { fingerprint: out };
}

/** The `sharedHash` rule, in ONE place. Both `buildFingerprint` and the migration must produce the same
 *  number or bucket attribution reports drift that is not there — so neither may reimplement the filter.
 *  Only set when every dir is a plugin-root: a mix including individual-skill mounts makes the split
 *  unreliable, since those dirs feed `skillHash` but not `sharedHash`. */
function sharedHashFor(dirs: string[], hashIgnore: string[], scopeSkills: string[] | undefined): { sharedHash?: string } {
  if (!scopeSkills || scopeSkills.length === 0) return {};
  const allPluginRoots = dirs.every((d) => {
    try {
      return statSync(join(d, "skills")).isDirectory();
    } catch {
      return false;
    }
  });
  if (!allPluginRoots) return {};
  const sh = hashSharedOnly(dirs, hashIgnore);
  return sh !== null ? { sharedHash: sh } : {};
}

/** Attach `labelProvenance` to an already-built fingerprint. Separate from `buildFingerprint` because the
 *  labels come from `controlOut`, which exists only after the run — and best-effort throughout: a stamp is
 *  a diagnostic bonus, so any failure to resolve the session or read prose yields no stamp rather than
 *  failing a record that otherwise succeeded. */
function withLabelProvenance(fp: Fingerprint, controlOut: readonly (string | object)[] | undefined, sessionPath: string): Fingerprint {
  try {
    const labels = recordedGateLabels(controlOut);
    if (!labels.length) return fp;
    const { dirs } = skillSourceDirs(sessionPath);
    const labelProvenance = stampLabelProvenance(labels, dirs);
    return labelProvenance ? { ...fp, labelProvenance } : fp;
  } catch {
    return fp;
  }
}

export function buildFingerprint(
  sessionPath: string,
  baselineAppVersion: string,
  cassetteDir?: string,
  scopeSkills?: string[],
  baseline?: PlatformBaseline,
  inlineSession?: SessionConfig,
  sessionOverride?: string,
): Fingerprint {
  const promptAssetsHash = baseline ? hashBaselinePromptAssets(baseline) : undefined;
  const { dirs, baseDir, hashIgnore } = skillSourceDirs(sessionPath, cassetteDir, inlineSession, sessionOverride);
  // `hashFormat` is stamped on EVERY return path, including the two early ones. A v12 fingerprint that
  // omits it violates the load-time invariant and would fail its own validation — so a baseline-only or
  // read-error recording must carry it just like a full one.
  if (dirs.length === 0)
    return { baseline: baselineAppVersion, hashFormat: ACTIVE_HASH_FORMAT, ...(promptAssetsHash ? { promptAssetsHash } : {}) };
  // hashSkillDirs excludes recorded cassettes (*.cassette.json) + VCS/cache dirs so a committed cassette
  // and unrelated VCS noise don't self-invalidate the fingerprint they were recorded under. When
  // scopeSkills is set, the hash is scoped to those skills' dirs + the plugin's shared roots (fail-closed);
  // hashIgnore (session globs + each mount's .cowork-hashignore) drops consumer-declared non-runtime paths.
  const hashResult = hashSkillDirs(dirs, scopeSkills, hashIgnore);
  if (!hashResult.scoped && hashResult.missedSkills && hashResult.missedSkills.length) {
    process.stderr.write(
      `cowork-harness: skill-hash: scopeSkills fallback to whole-tree — skills not found in any plugin-root: ${hashResult.missedSkills.join(", ")}\n`,
    );
  }
  // unreadable files produce a partial (unreliable) hash — treat as "can't verify" by omitting
  // skillHash. checkStaleness already treats a missing live.skillHash as a gate failure. Errors are already
  // written to stderr inside hashSkillDirs/hashDir.
  if (hashResult.readErrors && hashResult.readErrors.length > 0) {
    return {
      baseline: baselineAppVersion,
      hashFormat: ACTIVE_HASH_FORMAT,
      skillSources: dirs.sort().map((d) => relative(baseDir, d)),
      ...(promptAssetsHash ? { promptAssetsHash } : {}),
    };
  }
  // Store skillSources RELATIVE to the session-file dir — diagnostics only (the replay recompute re-derives
  // the dirs from the session), so a relative path is enough and never leaks an absolute `/Users/...` path.
  const fp: Fingerprint = {
    baseline: baselineAppVersion,
    hashFormat: ACTIVE_HASH_FORMAT,
    skillHash: hashResult.hash,
    ...(promptAssetsHash ? { promptAssetsHash } : {}),
    contentSig: computeContentSig(dirs, scopeSkills, hashIgnore), // v6: unified onto the skillHash walk (same set)
    skillSources: dirs.sort().map((d) => relative(baseDir, d)),
  };
  // Record the boundary mode only when git (the default raw needs no marker → keeps v<5 cassettes and
  // raw-mode v5 cassettes byte-clean). A recorded "git" vs a live "raw" (or vice-versa) is a mode flip.
  if (hashResult.mode === "git") fp.mode = "git";
  // Agent scoping marker — recorded only when active (the default OFF needs no marker → existing cassettes stay
  // byte-clean). A record-vs-verify mismatch is detected in checkStaleness as an honest re-record (like `mode`).
  if (hashResult.agentScoped) fp.agentScope = "skill";
  // v5: per-file manifest for exact-diff staleness reporting. Reuses the same walk/scope/ignore/OS-junk set as
  // skillHash (skillHashEntries → hashSkillDirs), so the manifest names exactly what the hash covers. Capped.
  const entries = skillHashEntries(dirs, scopeSkills, hashIgnore);
  if (entries.length > MANIFEST_MAX_FILES) fp.fileSigsOmitted = true;
  else fp.fileSigs = entries.map((e) => [e.path, e.sha] as [string, string]);
  if (scopeSkills && scopeSkills.length) fp.skillScope = [...scopeSkills].sort();
  // Scoped cassettes carry the shared-root hash so checkStaleness can name the changed bucket. The
  // rule lives in `sharedHashFor` because the MIGRATION must produce the identical number — two
  // implementations of this filter is how a scoped rehash starts reporting a false `shared-root`.
  Object.assign(fp, sharedHashFor(dirs, hashIgnore, scopeSkills));
  return fp;
}

/** Compare a fingerprint recorded at run time (`rec`) against a freshly-recomputed live one (`live`). Returns
 *  a re-record reason if the skill state drifted or is no longer comparable (a `mode`/`agentScope` flip), else
 *  null. A focused mirror of `checkStaleness`'s skillHash comparison, for `verify-run` to detect a kept run
 *  that predates a skill change (so it won't vouch for answer-coverage against stale gate labels). Compares
 *  skillHash only — `baseline` drift is intentionally NOT a reason here (it doesn't move skillHash). */
export function fingerprintSkillDrift(rec: Fingerprint, live: Fingerprint): string | null {
  if (rec.skillHash === undefined) return null; // the recorded run had no skill dirs → nothing to re-verify
  if (live.skillHash === undefined) return "skill dirs are no longer resolvable from the run's session";
  const recMode = rec.mode ?? "raw";
  const liveMode = live.mode ?? "raw";
  if (recMode !== liveMode) return `recorded in '${recMode}' file-set mode, now '${liveMode}' (COWORK_HARNESS_GITSET)`;
  if ((rec.agentScope ?? "off") !== (live.agentScope ?? "off")) return "agent-scope changed (COWORK_HARNESS_AGENT_SCOPE)";
  // HASH FORMAT, before the digest comparison. A kept RunResult carries NO version — unlike a cassette,
  // there is no `cassetteVersion` to route it to the epoch branch — so without this check every run kept
  // before the epoch reports "the skill/plugin source changed", which is false and gives the operator no
  // idea what to do. Same shape as the two config discriminators above it: name the real cause instead of
  // letting an incomparable digest masquerade as drift.
  //
  // ABSENT means the LEGACY transform, never "raw" — a pre-epoch run's manifest digests are already
  // version-stripped. An UNKNOWN id is reported loudly rather than coerced to either format: silently
  // treating a future `jcs2` as legacy would compare across algorithms and call it source drift again.
  const recFormat = rec.hashFormat ?? "legacy";
  const liveFormat = live.hashFormat ?? "legacy";
  if (recFormat !== liveFormat) {
    if (recFormat !== "legacy" && recFormat !== "jcs1")
      return `recorded under an unrecognized hash format '${recFormat}' — this build cannot verify it; re-record`;
    return `recorded under hash format '${recFormat}', this build hashes '${liveFormat}' — digests are not comparable; re-record`;
  }
  if (live.skillHash !== rec.skillHash) return "the skill/plugin source changed since this run was recorded";
  return null;
}

/** Session-SHAPE fingerprint (Finding 23) — a stable hash of the resolved session's content-relevant
 *  fields: connected folders (+ mode), plugin/skill/mcp discovery config, and the egress allowlist.
 *  Distinct from `buildFingerprint`'s skillHash (skill/plugin FILE content) — this covers what mounts/
 *  discovery/network the recorded run SAW, which can drift (a folder swapped, a plugin added, egress
 *  widened) with the skill tree itself completely unchanged, invisible to `fingerprint`. Mirrors
 *  `buildFingerprint`'s hashing approach (read the authored session, hash a canonical JSON shape) but over
 *  session shape rather than file content — so no raw host path is stored OR hashed (the shape is the
 *  authored, relocatable form; see the note in the body), only the digest. Returns
 *  undefined ("can't verify", never a false mismatch) for an inline scenario or when the session file
 *  can't be read/parsed from `sessionPath` (resolved against `cassetteDir` exactly like
 *  `skillSourceDirs`). Arrays are sorted before hashing so authoring order can't spuriously move the hash. */
export function buildSessionFingerprint(
  sessionPath: string,
  cassetteDir?: string,
  override?: string,
  /** `omitProjects` reproduces the PRE-`projects` shape. Only `sessionFingerprintDrift` passes it, to tell
   *  "this recording predates `projects` coverage" apart from "your session changed" — see there. */
  opts?: { omitProjects?: boolean },
): string | undefined {
  if (sessionPath === "(inline)") return undefined;
  // Same resolver as skillSourceDirs: an override that reached only ONE of them would verify skill
  // staleness against the override while hashing session SHAPE from the old location.
  const { path: resolved } = resolveCassetteSessionPath(sessionPath, cassetteDir, override);
  if (!existsSync(resolved)) return undefined;
  let cfg;
  try {
    // Hash the AUTHORED (pre-resolution) session shape — do NOT run resolveSessionPaths here. Resolution
    // absolutizes every path field (folders[].from, local_plugins, skills.local, mcp.config, …) against
    // the session dir, which bakes the machine/checkout-specific prefix into the digest so it can never
    // match on a different clone (CI, a git worktree, another dev's tree) even when nothing about the
    // session actually changed. The authored relative paths ARE the relocatable shape: a genuine config
    // edit (a swapped folder, an added plugin) still moves the hash; a bare relocation does not.
    cfg = loadSession(parseSessionFile(resolved));
  } catch {
    return undefined;
  }
  const agentEnv = agentEnvOverrides(cfg.agent_env);
  const shape = {
    folders: [...cfg.folders].map((f) => ({ from: f.from, mode: f.mode })).sort((a, b) => a.from.localeCompare(b.from)),
    plugins: {
      config_dir: cfg.plugins.config_dir,
      marketplaces: [...cfg.plugins.marketplaces].sort(),
      local_marketplaces: [...cfg.plugins.local_marketplaces].sort(),
      enabled: [...cfg.plugins.enabled].sort(),
      local_plugins: [...cfg.plugins.local_plugins].sort(),
      remote_plugins: [...cfg.plugins.remote_plugins].sort(),
    },
    skills: { local: [...cfg.skills.local].sort() },
    mcp: { config: cfg.mcp.config, enabled: [...cfg.mcp.enabled].sort() },
    egress: { extra_allow: [...cfg.egress.extra_allow].sort(), unrestricted: cfg.egress.unrestricted },
    web_fetch: { approved_domains: [...cfg.web_fetch.approved_domains].sort() },
    // Only when NON-DEFAULT, so every existing session's fingerprint stays byte-stable across this
    // field's introduction — a knob-less session's hash doesn't move. A knob change (which silently
    // affects only hostloop/protocol replay behavior — see agent_env's doc comment) moves the hash so
    // `verify-cassettes` surfaces the drift instead of a cassette quietly replaying stale env behavior.
    ...(Object.keys(agentEnv).length ? { agent_env: agentEnv } : {}),
    // Connected PROJECTS, on the same NON-EMPTY-ONLY terms as `agent_env` above: a session with no
    // `projects:` hashes byte-identically to before, so the overwhelming majority of cassettes do not
    // move. Unlike `agent_env` (a brand-new field nobody had), `projects` is an EXISTING field, so a
    // project-bearing session's hash DOES move once — which is why `sessionFingerprintDrift` reports that
    // case as unverifiable rather than as drift. Omitting it was a false green: swapping which directory
    // is mounted at `.projects/<uuid>` changed the run's inputs and `verify-cassettes` said nothing.
    ...(!opts?.omitProjects && cfg.projects.length
      ? { projects: [...cfg.projects].map((pr) => ({ uuid: pr.uuid, from: pr.from })).sort((a, b) => a.uuid.localeCompare(b.uuid)) }
      : {}),
  };
  return createHash("sha256")
    .update(Buffer.from(JSON.stringify(shape), "utf8"))
    .digest("hex");
}

/** Scan the WHOLE cassette surface for PII (default classes: email/currency/domain). A `truncated`
 *  artifact has NO committed body (hash-only) — nothing to leak — but is reported as `unscanned` so coverage
 *  is never silently implied. Real-class findings fail the gate; `unscanned` is informational. */
/** The agent's CAPABILITY MANIFEST — environment boilerplate, never user data, and the sole concentrated
 *  source of `domain`/`currency` scan noise (tool/skill catalog descriptions + MCP-server names a regex
 *  can't tell apart from customer data). Four stable structural forms, split across two trust levels:
 *   - the `system/init` event (tools/mcp_servers/skills/cwd registry) — Claude-Code-owned, and
 *   - the `initialize` `control_response` (`request_id: "init-1"`; body = commands/agents/models/account)
 *     — third-party plugin/command prose, and
 *   - the MCP `initialize` `control_request` (`clientInfo.name/version/websiteUrl`) — Claude Code's own
 *     fixed handshake identity, same trust level as `system/init`, and
 *   - the MCP `initialize` `control_response` (`mcp_response.result.serverInfo`) — SERVER-authored (the
 *     configured MCP server's own name/version), same trust level as the third-party `init-1` prose.
 *  Detection for the last form is a shape match (`protocolVersion`+`capabilities`+`serverInfo` all present
 *  in the result), not a verified request/response pairing — `isCapabilityManifest` is deliberately
 *  line-scoped (one string in, one boolean out), so a genuinely adversarial MCP server that echoed all
 *  three keys in an unrelated result would also get suppressed here; no standard MCP method other than
 *  `initialize` returns `protocolVersion` at the result's top level today, so this is an accepted residual,
 *  not a gap to close with a cross-array request_id correlation (a larger refactor this bug doesn't warrant).
 *  All four get `email` + `path` + `machine-inventory` scanning (email is universal — the `account` field
 *  can carry the dev's own email; path is universal too — these messages' own structural fields,
 *  `cwd`/`plugins[].path`/`memory_paths`, are exactly where a real local filesystem path lives;
 *  machine-inventory is universal too — a live-enumerated app/process inventory sentinel is never
 *  legitimate manifest boilerplate, unlike the noisy classes which are suppressed only here). */
function isCapabilityManifest(line: string): boolean {
  let m: {
    type?: string;
    subtype?: string;
    response?: { request_id?: string; response?: Record<string, unknown> };
    request?: { subtype?: string; message?: { method?: string } };
  };
  try {
    m = JSON.parse(line);
  } catch {
    return false;
  }
  if (m?.type === "system" && m?.subtype === "init") return true;
  // Claude Code's own MCP client handshake — clientInfo.name/version/websiteUrl is fixed boilerplate,
  // identical in every real recording, never user data.
  if (m?.type === "control_request" && m.request?.subtype === "mcp_message" && m.request?.message?.method === "initialize") return true;
  if (m?.type === "control_response") {
    const r = m.response ?? {};
    if (r.request_id === "init-1") return true;
    const body = r.response;
    if (body && typeof body === "object" && "commands" in body && "agents" in body) return true; // shape fallback
    // The MCP server's initialize response — server-authored, shape-matched (see doc comment above).
    const mcpResult = (
      body as { mcp_response?: { result?: { protocolVersion?: unknown; capabilities?: unknown; serverInfo?: unknown } } } | undefined
    )?.mcp_response?.result;
    if (
      mcpResult &&
      typeof mcpResult === "object" &&
      "protocolVersion" in mcpResult &&
      "capabilities" in mcpResult &&
      "serverInfo" in mcpResult
    )
      return true;
  }
  return false;
}

/** Tiers whose recordings inherit the host environment, so their transcripts can carry the recording
 *  machine's own inventory. `cowork` is included because it resolves to container OR hostloop via a baseline
 *  gate — the privacy scan fails closed rather than loading a baseline to find out. */
const HOST_INHERITING_TIERS: ReadonlySet<string> = new Set(["protocol", "hostloop", "cowork"]);

/** Every tier name this build understands. Used ONLY by `readCassetteForScan`, to refuse to pass an
 *  unrecognized tier through to the scan's set-membership gate — see the fail-closed note there.
 *  Derived from the canonical `FIDELITY_TIERS`, never spelled out: a second literal tier list is what
 *  `test/fidelity-tiers-single-source.test.ts` exists to stop, and it caught this one. */
const KNOWN_TIERS: ReadonlySet<string> = new Set<string>(FIDELITY_TIERS);

/** Plugin names the scenario mounted, harvested from anywhere in the event stream.
 *
 *  `system/init` carries `plugins[]` beside `agents[]`, so that surface is self-sufficient — but the
 *  registry `control_response` lists agents with NO plugin array of its own. Collecting once over the
 *  whole stream and passing the result into every scan covers both, and keeps `scanHostInventory` a pure
 *  function of one payload plus explicit context. Tolerant by construction: a non-JSON line, a missing
 *  `plugins`, or a bare-string entry are all normal, not errors. */
export function collectDeclaredPlugins(events: string[] | undefined): string[] {
  const names = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const v of node) visit(v);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    if (Array.isArray(o.plugins))
      for (const p of o.plugins) {
        const n = typeof p === "string" ? p : (p as Record<string, unknown> | null)?.name;
        if (typeof n === "string" && n) names.add(n);
      }
    for (const v of Object.values(o)) visit(v);
  };
  for (const line of events ?? []) {
    try {
      visit(JSON.parse(line));
    } catch {
      continue; // a non-JSON transcript line declares no plugins
    }
  }
  return [...names];
}

/**
 * The EXACT subset of a cassette the privacy scan reads — and the point of the read-boundary split.
 *
 * WHY THIS TYPE EXISTS. `verify-cassettes` does two independent jobs: a privacy scan ("does this
 * recording carry the recording machine's MCP servers / agents / account org?") and a staleness check
 * ("is it out of date?"). Both used to sit behind one `readCassette`, so a document that failed SHAPE
 * validation was never privacy-scanned at all — `verifyOneCassette` returned early and `scanCassette` on
 * the next line never ran. That is backwards: shape validity is what REPLAY needs, and a file too broken
 * to replay is exactly the kind of file a leak arrives in. Whether a transcript can be READ and whether a
 * cassette is VALID are different questions, and only the first one gates a privacy scan.
 *
 * Narrowing the parameter type is what makes the split safe rather than merely convenient: the compiler
 * now guarantees the scan cannot reach for a field `readCassetteForScan`'s projection does not supply.
 * Adding a new scan axis that reads some other field is a TYPE ERROR here until the projection carries it
 * — which is the whole guard against a future axis silently reading `undefined` off a partial document.
 *
 * `Cassette` is structurally assignable to this, so every existing caller is unaffected.
 */
export interface ScannableCassette {
  events: string[];
  controlOut?: string[];
  effectiveFidelity?: string;
  artifacts?: Cassette["artifacts"];
  fingerprint?: { skillSources?: string[]; fileSigs?: Array<[string, string]> };
  // Structural METADATA — a customer folder mount name, a scenario name, a private-registry image ref.
  // These are name fields, invisible to a net aimed at transcript text, and are exactly the shape of the
  // inventory leak this repo already shipped, so the projection must carry them.
  userVisibleRoots?: string[];
  scenarioSource?: string;
  environment?: { agentImage?: { ref?: string } };
  // `folderPrefixMap[].from` is the RECORD-TIME connected-folder HOST path (`/Users/<name>/...`), persisted
  // by `buildRecordTimeFolderPrefixMap`. It is a path field like `userVisibleRoots`, and it was invisible to
  // both privacy layers: `scanCassette` never read it and `redactCassette` passed it through the `...cassette`
  // spread, so a committed fixture leaked a username + private directory structure while `verify-cassettes`
  // reported `ok:true`/`privacyScanned:true`. Carried here so the malformed-document lane sees it too — the
  // VALID lane gets it free (it passes the whole `Cassette`), which is exactly why a valid-only regression
  // passes with half the fix missing.
  folderPrefixMap?: Array<{ from?: string; mount?: string }>;
  // `fidelity` is a plain string here, NOT the Scenario literal union — a malformed document can carry
  // anything, and the projection is responsible for refusing to pass through a value it cannot vouch for
  // (see `knownTier` in `readCassetteForScan`). `answers`/`assert` are only ever JSON.stringify'd by the
  // scan, so their precise Scenario types buy nothing and would force a cast at the projection.
  scenario: Partial<Pick<Cassette["scenario"], "prompt" | "name" | "session">> & {
    fidelity?: string;
    answers?: unknown;
    assert?: unknown[];
  };
}

export function scanCassette(cassette: ScannableCassette, allow: AllowInput[]): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const FULL = DEFAULT_SCAN_PATTERNS; // email + currency + domain + path + machine-inventory
  const MANIFEST = MANIFEST_SCAN_PATTERNS; // email + path + machine-inventory — for the capability-manifest messages
  // Whole-token allowlist check against an arbitrary string (the artifact PATH), mirroring scan.ts's
  // `allowed`: an unscoped `--allow` (or one scoped to `cls`) whose regex matches the ENTIRE path
  // clears the finding. Used to give a committed-but-unscannable binary deliverable a documented
  // recourse — `--allow <path-regex>` after a manual review — since its body isn't text-matchable.
  const pathAllowed = (path: string, cls: string): boolean =>
    allow.some((a) => {
      const p: AllowPattern = a instanceof RegExp ? { re: a } : a;
      if (p.cls !== undefined && p.cls !== cls) return false;
      return new RegExp(`^(?:${p.re.source})$`, p.re.flags.replace("g", "")).test(path);
    });
  // Transcript: full net EXCEPT the capability-manifest messages (catalog noise), where only
  // email + path + machine-inventory run.
  cassette.events.forEach((l, i) => findings.push(...scanText(l, `events[${i}]`, allow, isCapabilityManifest(l) ? MANIFEST : FULL)));
  cassette.controlOut?.forEach((l, i) =>
    findings.push(...scanText(l, `controlOut[${i}]`, allow, isCapabilityManifest(l) ? MANIFEST : FULL)),
  );
  // Structural host-inventory scan — the text net above cannot see this class. A recording made at a
  // host-inheriting tier freezes the recording MACHINE's inventory (its MCP servers, agents, account org)
  // into the init + command-registry events; committed to a public repo that publishes the operator's tool
  // stack. It escaped the text net because an unconnected server declares no tools, so no `mcp__*` token is
  // ever written and a `grep mcp__` reads clean — the inventory lives in NAME fields.
  //
  // TIER-GATED, and that gate is load-bearing: `mcp.config`/`mcp.enabled` is a documented, supported way to
  // attach an MCP server to a session under test, and the cassette freezes only the session PATH, so the
  // scan cannot subtract what a scenario declared on purpose. At `container` the agent is sealed and no host
  // inventory can reach it, so a foreign server name there is necessarily scenario-declared and must not be
  // flagged. `cowork` is treated as host-inheriting because it resolves to container OR hostloop via a
  // baseline gate — fail closed rather than resolve a baseline inside the privacy scan.
  // An UNKNOWN tier scans too. `fidelity` is not required by the cassette shape (scenario is a looseObject
  // over prompt/session/assert), so a cassette that simply omits it would otherwise skip this check
  // entirely — a silent fail-open on exactly the file a leak would arrive in. Only a tier we can positively
  // identify as sealed (`container`, `microvm`) is exempt. Same fail-closed reasoning as `cowork`.
  const tier = (cassette.effectiveFidelity ?? cassette.scenario.fidelity) as string | undefined;
  if (tier === undefined || HOST_INHERITING_TIERS.has(tier)) {
    // Harvest the plugin names the SCENARIO mounted, once, across the whole event stream — then hand them
    // to every scan. `system/init` carries `plugins[]` beside `agents[]` so it is self-sufficient, but the
    // registry `control_response` lists agents with no plugin array of its own; without this pre-pass that
    // surface keeps flagging the scenario's own plugin agents. See scanHostInventory's A4.
    const declaredPlugins = collectDeclaredPlugins(cassette.events);
    const structural = (lines: string[] | undefined, key: string) =>
      lines?.forEach((l, i) => {
        let decoded: unknown;
        try {
          decoded = JSON.parse(l);
        } catch {
          return; // a non-JSON transcript line has no name fields to read
        }
        findings.push(...scanHostInventory(decoded, `${key}[${i}]`, allow, declaredPlugins));
      });
    structural(cassette.events, "events");
    structural(cassette.controlOut, "controlOut");
  }
  // Record-time connected-folder host paths. Same class as `userVisibleRoots` above: a structural path
  // field the transcript net cannot see, because it never appears in transcript text.
  cassette.folderPrefixMap?.forEach((e, i) => {
    if (typeof e?.from === "string") findings.push(...scanText(e.from, `folderPrefixMap[${i}].from`, allow, FULL));
  });
  // Deliverable + author-written fields — full net (a real cap table's figures/domains live here).
  for (const a of cassette.artifacts ?? []) {
    findings.push(...scanText(a.path, `artifact path ${a.path}`, allow, FULL)); // a filename can name a customer
    if (a.body !== undefined) {
      if (a.encoding === "base64") {
        const decoded = Buffer.from(a.body, "base64");
        const asUtf8 = decoded.toString("utf8");
        const isText = Buffer.from(asUtf8, "utf8").equals(decoded);
        if (isText) {
          findings.push(...scanText(asUtf8, `artifact ${a.path}`, allow, FULL));
        } else if (!pathAllowed(a.path, "binary")) {
          // The body IS committed (base64, ≤ cap) but isn't UTF-8 text, so the scanner can't read it —
          // yet binary office deliverables (.xlsx/.docx/.pdf) embed customer names/emails in their
          // zip/DEFLATE streams. Count a COMMITTED binary body as a real finding (cls "binary", NOT the
          // benign "unscanned" used for a TRUNCATED/uncommitted entry below) so the gate can't greenlight
          // raw recoverable PII. Recourse: after reviewing the deliverable, clear it with
          // `--allow <path-regex>` (a PATTERN matched on the artifact path above, since the body is
          // unreadable) — NOT `--allow-patterns-file`, which loads a FILE of patterns, not a path to allow.
          findings.push({
            where: `artifact ${a.path}`,
            cls: "binary",
            sample: `(committed binary body — not text-scannable; review and clear with --allow ${a.path} (a pattern matched on this path); note --allow-patterns-file is a FILE of patterns, not this path)`,
          });
        }
      } else {
        findings.push(...scanText(a.body, `artifact ${a.path}`, allow, FULL));
      }
    } else if (a.truncated)
      findings.push({ where: `artifact ${a.path}`, cls: "unscanned", sample: "(body not committed — too large or unreadable)" });
  }
  findings.push(...scanText(cassette.scenario.prompt ?? "", "scenario.prompt", allow, FULL));
  findings.push(...scanText(JSON.stringify(cassette.scenario.answers ?? null), "scenario.answers", allow, FULL));
  findings.push(...scanText(JSON.stringify(cassette.scenario.assert ?? null), "scenario.assert", allow, FULL));
  for (const s of cassette.fingerprint?.skillSources ?? []) findings.push(...scanText(s, "fingerprint.skillSources", allow, FULL));
  // v5: per-file manifest paths are a committed surface — scan them like skillSources (a path can name a customer).
  for (const [p] of cassette.fingerprint?.fileSigs ?? []) findings.push(...scanText(p, "fingerprint.fileSigs", allow, FULL));
  // human-authored / structural METADATA fields were never scanned, so a customer folder mount name
  // in userVisibleRoots (or a customer name in the scenario name / session path) could leak through `verify-
  // cassettes`. Scan them too, prefixed `metadata:` so a reviewer knows redaction here ALSO rewrites
  // structural paths, distinct from free-text findings in the transcript/deliverable.
  (cassette.userVisibleRoots ?? []).forEach((r, i) => findings.push(...scanText(r, `metadata:userVisibleRoots[${i}]`, allow, FULL)));
  findings.push(...scanText(cassette.scenario.name ?? "", "metadata:scenario.name", allow, FULL));
  findings.push(...scanText(cassette.scenario.session ?? "", "metadata:scenario.session", allow, FULL));
  if (cassette.scenarioSource) findings.push(...scanText(cassette.scenarioSource, "metadata:scenarioSource", allow, FULL));
  // `environment.agentImage.ref` is a VERBATIM COWORK_AGENT_IMAGE value, so a private-registry ref
  // (`ghcr.io/acme-internal/agent:2`, `registry.customer.corp/cowork:2`) is committed straight into a
  // public fixture. `environment` had never been scanned at all — the same shape as the inventory leak
  // this repo already shipped: a name field is invisible to a net aimed at transcript text.
  // The digests are content hashes, not user-controlled, so only `ref` is scanned.
  if (cassette.environment?.agentImage?.ref)
    findings.push(...scanText(cassette.environment.agentImage.ref, "metadata:environment.agentImage.ref", allow, FULL));
  return findings;
}

const DEBUG_SKILLHASH_ENV = "COWORK_HARNESS_DEBUG_SKILLHASH";

/** Debug: dump the per-file entries currently feeding the skill hash for a session (same resolution as
 *  `buildFingerprint`), so a staleness mismatch shows WHICH files are in the hash — incl. unexpected
 *  OS-junk / run-generated files that are the usual "stale immediately after record" cause. */
function explainSkillHash(
  sessionPath: string,
  cassetteDir: string | undefined,
  scopeSkills?: string[],
  sessionOverride?: string,
): { path: string; sha: string }[] {
  const { dirs, hashIgnore } = skillSourceDirs(sessionPath, cassetteDir, undefined, sessionOverride);
  if (dirs.length === 0) return [];
  return skillHashEntries(dirs, scopeSkills, hashIgnore);
}

/** Debug: on a skillHash mismatch, if COWORK_HARNESS_DEBUG_SKILLHASH=1, write the file set the hash sees
 *  to stderr (flagging OS-junk) plus whether contentSig also drifted. When the flag
 *  is OFF, write a one-line hint so the affordance is discoverable. Diagnostics only — never affects the gate. */
/** The discoverability hint is a CONSTANT string, so repeating it once per drifting cassette is pure
 *  noise (a 16-cassette fleet replay printed it 16x). Once per process is the whole affordance. Only the
 *  HINT is suppressed — the `=1` dump below stays per-cassette, since per-cassette drift attribution is
 *  the entire point of the flag. */
let skillHashHintShown = false;

function debugSkillHashMismatch(
  cassette: Cassette,
  cassetteDir: string,
  fp: Fingerprint,
  live: Fingerprint,
  sessionOverride?: string,
): void {
  if (process.env[DEBUG_SKILLHASH_ENV] !== "1") {
    if (!skillHashHintShown) {
      skillHashHintShown = true;
      process.stderr.write(
        `cowork-harness: skill-hash: set ${DEBUG_SKILLHASH_ENV}=1 to list the files feeding the hash (find the drift source)\n`,
      );
    }
    return;
  }
  const scope = cassette.scenario.skills?.length ? cassette.scenario.skills.join(", ") : "whole-tree";
  let entries: { path: string; sha: string }[] = [];
  try {
    // Must carry the override: without it the dump enumerates the RECORDED location, which under
    // `--session` no longer resolves — an empty or wrong file list exactly when it is most needed.
    entries = explainSkillHash(cassette.scenario.session, cassetteDir, cassette.scenario.skills, sessionOverride);
  } catch (e) {
    process.stderr.write(`cowork-harness: skill-hash debug: could not enumerate files: ${String((e as Error)?.message ?? e)}\n`);
    return;
  }
  process.stderr.write(`cowork-harness: skill-hash debug — ${entries.length} file(s) feeding the hash (scope: ${scope}):\n`);
  let junk = 0;
  for (const e of entries) {
    const isJunk = OS_JUNK_PATTERN.test(e.path);
    if (isJunk) junk++;
    process.stderr.write(
      `  ${e.sha.slice(0, 12)}  ${e.path}${isJunk ? "   ⚠ OS-junk / non-runtime — add to .cowork-hashignore (or it will keep re-staling)" : ""}\n`,
    );
  }
  const sigVerdict =
    fp.contentSig === undefined || live.contentSig === undefined ? "n/a" : fp.contentSig === live.contentSig ? "MATCHES" : "DIFFERS";
  process.stderr.write(
    `cowork-harness: skill-hash debug — skillHash recorded ${String(fp.skillHash).slice(0, 12)} vs live ${String(live.skillHash).slice(0, 12)}; ` +
      `contentSig ${sigVerdict}${junk ? ` · ${junk} OS-junk file(s) flagged above` : ""}. ` +
      `Note: this lists the CURRENT tree; a true per-file diff vs record needs the record-time set (re-record after excluding junk, then compare).\n`,
  );
}

/** A per-file manifest diff split into the three change categories (paths only, unsampled). */
export interface FileSigDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

/** v5: diff two per-file manifests (recorded vs live) into the exact changed/added/removed path lists.
 *  Exported for the diff engine (artifacts view) — the exact same [path, sha256] shape it needs. */
/** Root-relative `fileSigs` paths are NOT unique across mounts: two roots can each hold
 *  `skills/x/SKILL.md`, and the manifest then carries two entries with the same path and different shas.
 *  Every consumer keys that manifest by path (`diffFileSigsPaths` builds `new Map(recorded)`), so
 *  duplicates collapse to the last occurrence and the reported file list can name the wrong file or none.
 *
 *  This does NOT make drift undetectable — `skillHash` folds every entry, so the gate still fires. What it
 *  breaks is ATTRIBUTION, and exact attribution is impossible without stored per-root identity: a multiset
 *  diff cannot say WHICH root a changed `SKILL.md` came from, and swapping two roots' contents leaves the
 *  sha multiset identical while the digest moves. So the honest report is "attribution unavailable", not a
 *  guess. A real fix needs framed root IDs and namespaced manifest paths — a hash-format epoch change. */
export function duplicateManifestPaths(sigs: ReadonlyArray<readonly [string, string]> | undefined): string[] {
  if (!sigs) return [];
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const [path] of sigs) {
    if (seen.has(path)) dupes.add(path);
    else seen.add(path);
  }
  return [...dupes].sort();
}

export function diffFileSigsPaths(recorded: Array<[string, string]>, live: Array<[string, string]>): FileSigDiff {
  const rec = new Map(recorded);
  const liv = new Map(live);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [p, h] of liv) {
    if (!rec.has(p)) added.push(p);
    else if (rec.get(p) !== h) changed.push(p);
  }
  for (const [p] of rec) if (!liv.has(p)) removed.push(p);
  return { added, removed, changed };
}

/** Format a {@link FileSigDiff} into an actionable summary (samples up to 3 paths per category). Null when
 *  the diff is empty (hashes differ but files don't — a structure-only change; caller falls back to its
 *  bucket message). */
function summarizeFileSigDiff(diff: FileSigDiff): string | null {
  if (!diff.added.length && !diff.removed.length && !diff.changed.length) return null;
  const sample = (a: string[]) => `${a.slice(0, 3).join(", ")}${a.length > 3 ? `, +${a.length - 3} more` : ""}`;
  const parts: string[] = [];
  if (diff.changed.length) parts.push(`${diff.changed.length} changed (${sample(diff.changed)})`);
  if (diff.added.length) parts.push(`${diff.added.length} added (${sample(diff.added)})`);
  if (diff.removed.length) parts.push(`${diff.removed.length} removed (${sample(diff.removed)})`);
  return parts.join("; ");
}

/** Convenience: diff + summarize in one call (the non-scoped/whole-tree caller wants only the summary). */
function diffFileSigs(recorded: Array<[string, string]>, live: Array<[string, string]>): string | null {
  return summarizeFileSigDiff(diffFileSigsPaths(recorded, live));
}

/** Partition a manifest diff into the shared-root bucket vs the
 *  skill-private bucket, EXACTLY mirroring `scopedAccept`/`sharedOnlyAccept` in skill-hash.ts so attribution
 *  matches the hash boundary. A path under `skills/<name>/` is skill-private when `<name>` is in scope; with
 *  agent-scoping ON, a skill-named `agents/<name>.md` is also skill-private. Everything else is shared. This
 *  lets `computeStaleness` emit a `skill` finding AND a `shared-root` finding when BOTH buckets drift, so a
 *  co-occurring shared change can no longer mask the skill's own drift (the original bug). */
function partitionDriftBuckets(diff: FileSigDiff, scope: Set<string>, scopeAgents: boolean): { shared: FileSigDiff; skill: FileSigDiff } {
  const shared: FileSigDiff = { added: [], removed: [], changed: [] };
  const skill: FileSigDiff = { added: [], removed: [], changed: [] };
  const isSkillPrivate = (relPath: string): boolean => {
    const parts = relPath.split("/");
    if (parts[0] === "skills" && parts.length >= 2) return scope.has(parts[1]);
    if (scopeAgents) {
      const an = agentSkillName(parts);
      if (an !== null && scope.has(an)) return true;
    }
    return false;
  };
  for (const cat of ["added", "removed", "changed"] as const) for (const p of diff[cat]) (isSkillPrivate(p) ? skill : shared)[cat].push(p);
  return { shared, skill };
}

/** Resolved-tier check: does a `fidelity: cowork` cassette's recorded `effectiveFidelity` still match
 *  the tier the scenario's baseline resolves to TODAY? Baseline-only inputs — the env override
 *  (`CLAUDE_FORCE_HOST_LOOP`) is suppressed via `decideLoopFromBaseline`'s `over` param so verify results
 *  can't differ across machines. Resolution consults the scenario's pinned `baseline:` when present
 *  (`latest` otherwise); a `cowork` scenario whose baseline fails to load yields a LOUD `unverifiable-tier`
 *  finding, never a throw (a bad pin must not abort a verify sweep). An explicit-tier scenario never
 *  consults the baseline for its tier, so it can only produce the informational pre-field NOTE — findings
 *  are reserved for the baseline-dependent case, where a silent skip could hide real drift. */
function computeTierStaleness(cassette: Cassette): { findings: StalenessFinding[]; notes: string[] } {
  const authored = cassette.scenario.fidelity;
  const eff = cassette.effectiveFidelity;
  if (authored !== "cowork") {
    // Statically knowable from the embedded scenario — a pre-effectiveFidelity cassette passes the tier
    // check with a non-failing informational note (never a silent skip, never a spurious red).
    if (eff === undefined)
      return {
        findings: [],
        notes: [
          `resolved-tier: cassette predates effectiveFidelity, but the scenario pins an explicit tier ('${authored}') — tier statically knowable; nothing baseline-dependent to verify`,
        ],
      };
    return { findings: [], notes: [] };
  }
  if (eff === undefined)
    return {
      findings: [
        {
          class: "unverifiable-tier",
          message: "fidelity: cowork cassette predates effectiveFidelity — cannot verify tier stability; re-record",
        },
      ],
      notes: [],
    };
  const baselineName = cassette.scenario.baseline ?? "latest";
  let baseline;
  try {
    baseline = loadBaseline(baselineName);
  } catch (e) {
    return {
      findings: [
        {
          class: "unverifiable-tier",
          message: `fidelity: cowork cassette's baseline '${baselineName}' failed to load (${(e as Error).message}) — cannot verify tier stability (can't verify ⇒ not green)`,
        },
      ],
      notes: [],
    };
  }
  // Mirrors execute.ts's live resolution (cowork → hostloop|container) with the env input pinned off.
  const resolved = decideLoopFromBaseline(baseline, { devForceHostLoop: false }) === "host" ? "hostloop" : "container";
  if (resolved !== eff)
    return {
      findings: [
        {
          class: "resolved-tier",
          message: `fidelity: cowork now resolves to '${resolved}' (baseline ${baseline.appVersion}, gate 1143815894) but the cassette was recorded at '${eff}' — the recording exercises the wrong tier; re-record`,
        },
      ],
      notes: [],
    };
  return { findings: [], notes: [] };
}

/** Prompt-asset drift for one fingerprint vs the LIVE baseline OBJECT (never a re-resolve of
 *  fp.baseline). Gated on appVersion match — a version bump already fires the `baseline` finding, so
 *  comparing across versions would double-flag. Returns a finding, a legacy note, or null. */
export function promptAssetStaleness(
  fp: Fingerprint,
  liveBaselineObj: PlatformBaseline | undefined,
): StalenessFinding | { note: string } | null {
  if (fp.promptAssetsHash === undefined)
    return {
      note: "prompt-assets: cassette predates prompt-asset fingerprinting — a prompt-asset edit since record would be invisible; re-record to adopt the guard",
    };
  if (liveBaselineObj === undefined || liveBaselineObj.appVersion !== fp.baseline) return null; // baseline finding handles the version mismatch
  const liveAssets = hashBaselinePromptAssets(liveBaselineObj);
  if (liveAssets === undefined)
    return {
      class: "unverifiable-prompt-assets",
      message:
        "cassette recorded a prompt-asset fingerprint but the live baseline's prompt assets can't be hashed (a pointer moved or the asset is absent) — can't verify prompt drift ⇒ not green",
    };
  if (liveAssets !== fp.promptAssetsHash)
    return {
      class: "prompt-assets",
      message:
        "the baseline's committed prompt assets changed since this cassette was recorded (same appVersion) — the recorded model saw a different rendered prompt; re-record",
    };
  return null;
}

/** The SINGLE staleness diagnosis (unifies what used to be two divergent copies: `checkStaleness` and the
 *  inline block in `replayCassette`). Recompute the fingerprint and report drift as class-tagged findings;
 *  each CALLER applies its own gate-vs-warn policy:
 *   - `verify-cassettes` / the re-record work-list go through the `checkStaleness` string adapter and treat
 *     ANY finding as "stale ⇒ re-record" (so `unverifiable-*` stays a hard fail there — can't verify ⇒ not
 *     green). The adapter MUST be class-blind (forward every finding) or that gate false-greens.
 *   - `replayCassette` consumes the findings directly: warn by default, `--strict` fails on all,
 *     `--fail-on-skill-drift` fails only on `SKILL_DRIFT_CLASSES`.
 *  Returns `{ findings, notes }`: findings gate; `notes` is the NON-failing informational channel (today:
 *  the pre-effectiveFidelity explicit-tier note) — it must never red a gate, and must never be dropped
 *  silently (verify-cassettes surfaces it in the envelope + a `·` text row).
 *  The tier check runs BEFORE the fingerprint guard on purpose: it needs only the embedded scenario +
 *  `effectiveFidelity`, and the oldest cassettes (no fingerprint, no effectiveFidelity, `fidelity: cowork`)
 *  must NOT get a silent legacy-skip. No fingerprint → no further (fingerprint-based) checks. */
/** Tiers whose cowork lane declares the skills/plugins SDK-MCP discovery servers (added 1.10.0).
 *  `cowork` is deliberately ABSENT: execute.ts resolves it to hostloop|container BEFORE the tier is
 *  stamped, so no recorded tier can ever be "cowork" — listing it would be dead code. It appears only as
 *  the `!== "cowork"` exclusion on the scenario.fidelity fallback below. */
const DISCOVERY_TIERS = new Set(["container", "hostloop"]);
const DISCOVERY_TOOL_RE = /^mcp__(?:skills|plugins)__/;

/** The tool inventory the agent reported in `system/init`, or `undefined` when this cassette does not
 *  carry one. `undefined` and `[]` are BOTH "no evidence" for the caller — a hand-written fixture has an
 *  init event with no `tools` key at all (test/evals/files/report-check.cassette.json), and treating that
 *  as "the tools are missing" would advise re-recording a synthetic fixture. Breaks on the first init
 *  (it is events[0] in every real cassette); events are JSON strings, so parse per line and skip garbage. */
function recordedInitTools(cassette: Cassette): string[] | undefined {
  // `events` is TYPED as required, but partially-constructed cassettes reach computeStaleness from
  // several callers (checkStaleness in the staleness/agent-scope suites builds one without it), so the
  // type is a lie at this seam. An absent events array is "no evidence", same as an absent tools key.
  if (!Array.isArray(cassette.events)) return undefined;
  for (const line of cassette.events) {
    let m: { type?: string; subtype?: string; tools?: unknown };
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m?.type !== "system" || m?.subtype !== "init") continue;
    return Array.isArray(m.tools) ? (m.tools as unknown[]).filter((t): t is string => typeof t === "string") : undefined;
  }
  return undefined;
}

/** NOTE (never a finding): this cassette froze a tool inventory from before the skills/plugins discovery
 *  servers existed at its tier. Answers the question a `harnessVersion` field cannot answer retroactively
 *  ("which of my cassettes predate the discovery surface?") by reading what the agent ACTUALLY reported,
 *  so it works on cassettes recorded long before this code existed.
 *  Deliberately silent when: the init inventory is absent/empty (no evidence — see recordedInitTools), the
 *  tier is microvm/protocol (re-recording there would NEVER produce these tools, so the advice would be a
 *  dead end), or no tier resolves at all (never guess a tier into an advisory).
 *  It DOES fire on a pre-1.10.0 container/hostloop cassette whose scenario never mentions the discovery
 *  tools. That is accepted: the note is accurate, it is a `·` row and not a gate, and it self-clears on
 *  re-record. Narrowing it by introspecting `assert:` would be gold-plating. */
function computeDiscoverySurfaceNote(cassette: Cassette): string[] {
  const tools = recordedInitTools(cassette);
  if (!tools || tools.length === 0) return []; // no evidence — NOT "the tools are missing"
  if (tools.some((t) => DISCOVERY_TOOL_RE.test(t))) return [];
  // Tier, in order of authority. scenario.fidelity is the third source because the OLDEST cassettes (the
  // ones this note most wants to reach) predate `effectiveFidelity` AND `environment` — the same reason
  // computeTierStaleness treats a non-cowork authored fidelity as statically knowable.
  const authored = cassette.scenario.fidelity;
  const tier = cassette.environment?.tier ?? cassette.effectiveFidelity ?? (authored !== "cowork" ? authored : undefined);
  if (!tier || !DISCOVERY_TIERS.has(tier)) return [];
  return [
    `discovery-surface: recorded before the skills/plugins SDK-MCP discovery servers existed at this tier ` +
      `(${tier}, added in 1.10.0) — its ${tools.length}-tool init inventory declares no mcp__skills__*/mcp__plugins__*. ` +
      `Re-record if this scenario asserts on those tools; harmless otherwise.`,
  ];
}

export function computeStaleness(
  cassette: Cassette,
  cassetteDir: string | undefined,
  sessionOverride?: string,
): { findings: StalenessFinding[]; notes: string[] } {
  const tier = computeTierStaleness(cassette);
  const findings: StalenessFinding[] = [...tier.findings];
  const notes: string[] = [...tier.notes, ...computeDiscoverySurfaceNote(cassette)];
  const fp = cassette.fingerprint;
  // BEFORE the fingerprint guard on purpose — same rationale as the tier check above: fingerprint-less
  // cassettes are the OLDEST, i.e. exactly the population the discovery-surface note targets.
  if (!fp) return { findings, notes };
  let liveBaselineObj: PlatformBaseline | undefined;
  try {
    liveBaselineObj = loadBaseline("latest");
  } catch {
    /* baseline not loadable */
  }
  const liveBaseline = liveBaselineObj?.appVersion;
  // The cassette carries a baseline-of-record but we can't load the current one to compare. Surfaced as
  // `unverifiable-baseline` (env/platform, not skill drift): a non-failing warning on the default replay gate,
  // but a hard fail for `verify-cassettes`/the work-list via the class-blind string adapter (can't verify ⇒
  // not green). baselines ship with the package, so this is rare.
  if (liveBaseline === undefined)
    findings.push({
      class: "unverifiable-baseline",
      message:
        "cannot load the latest baseline to verify staleness — run `cowork-harness sync` or ship baselines/ (env/platform, not skill drift; can't verify ⇒ not green)",
    });
  else if (liveBaseline !== fp.baseline)
    findings.push({ class: "baseline", message: `baseline moved ${fp.baseline} → ${liveBaseline} since record — re-record` });
  const pa = promptAssetStaleness(fp, liveBaselineObj);
  if (pa) {
    if ("note" in pa) notes.push(pa.note);
    else findings.push(pa);
  }
  if (fp.skillHash) {
    // positions matter: (sessionPath, baselineAppVersion, cassetteDir, scopeSkills, baseline, inlineSession, sessionOverride)
    const live = buildFingerprint(
      cassette.scenario.session,
      fp.baseline,
      cassetteDir,
      cassette.scenario.skills,
      undefined,
      undefined,
      sessionOverride,
    );
    const recMode = fp.mode ?? "raw";
    const liveMode = live.mode ?? "raw";
    // EPOCH FIRST — before mode, agent scope and equality. All three of those compare values produced by
    // two different algorithms, so reaching them first is meaningless. Concretely: a pre-epoch cassette
    // that ALSO has a git/raw mode flip would take the mode branch, be classed `format` (waivable, warns,
    // exits 0) and never reach here — a false green across the entire pre-epoch corpus.
    //
    // Class is `unverifiable-skill`, NOT `format`. `format` sits outside SKILL_DRIFT_CLASSES and outside
    // the default replay gate, so it warns while exiting 0 — which on the day of an epoch bump is EVERY
    // cassette in existence. `unverifiable-skill` already means "these two numbers cannot be compared, so
    // this is not verified": it fails a bare replay, and it ESCALATES under an explicit `--session` rather
    // than being quietened by it, which is correct — an override cannot make incomparable digests
    // comparable.
    const recordedVersion = cassette.cassetteVersion ?? 0;
    if (live.skillHash === undefined) {
      // Name WHY. Every failure path used to collapse into this one message, so "missing session file",
      // "unparseable YAML" and "the session declares no mounts" were indistinguishable — and the first two
      // point at completely different fixes (`--session <file>` vs repair the file). Re-resolving costs one
      // YAML parse and only happens on a path that is already failing.
      const why = skillSourceDirs(cassette.scenario.session, cassetteDir, undefined, sessionOverride).failure;
      const detail =
        why === undefined
          ? ""
          : why.kind === "not-found"
            ? ` — no session file at ${why.path}${sessionOverride === undefined ? " (if the cassette moved, point at its session with --session <file>)" : ""}`
            : why.kind === "unreadable"
              ? ` — the session at ${why.path} could not be read or parsed: ${why.message}`
              : why.kind === "declared-dirs-missing"
                ? ` — the session at ${why.path} declares ${why.declared} skill dir(s) and none exist (mounts are relative to the session's OWN directory, so a session copied or symlinked elsewhere resolves to nothing)`
                : " — an inline scenario carries no session file to resolve";
      const where =
        sessionOverride === undefined ? "from the cassette location" : `from the session given with --session (${sessionOverride})`;
      findings.push({
        class: "unverifiable-skill",
        message: `skill dirs not resolvable ${where}${detail || (why === undefined ? (fp.skillHash !== undefined ? " — the session resolved and its dirs exist, but some could not be READ, so the hash was dropped as unreliable" : " — the session resolved but declares no skill dirs to hash") : "")} — cannot verify skill staleness (can't verify ⇒ not green)`,
      });
    } else if (fp.skillHash !== undefined && recordedVersion < HASH_FORMAT_EPOCH) {
      // EPOCH, ahead of every WAIVABLE branch. Mode and agent-scope compare values produced by two
      // different algorithms, so reaching them first is meaningless — and worse, both are classed
      // `format`, which sits outside SKILL_DRIFT_CLASSES and outside the default replay gate. A pre-epoch
      // cassette that ALSO had a mode flip would warn and exit 0: a false green across the whole
      // pre-epoch corpus, on the exact day the epoch lands.
      //
      // It sits BELOW the unresolvable branch on purpose. That one is already a hard `unverifiable-skill`
      // too, and "the skill dirs cannot be found" is the more specific, more actionable diagnosis — the
      // operator's real problem is the session path, not the hash format.
      //
      // Class is `unverifiable-skill`, NOT `format`: it already means "these two numbers cannot be
      // compared, so this is not verified". It fails a bare replay, and it ESCALATES under an explicit
      // `--session` rather than being quietened by it, which is right — an override cannot make
      // incomparable digests comparable.
      findings.push({
        class: "unverifiable-skill",
        message:
          `recorded under hash format v${recordedVersion} (now v${HASH_FORMAT_EPOCH}) — digests are not comparable across the change. ` +
          `Run \`cowork-harness rehash <dir>\` to migrate, or \`rehash <file> --session <session>\` if the cassette has moved, or re-record`,
      });
    } else if (recMode !== liveMode)
      // A hash from a different boundary mode is not comparable — re-record, don't emit a misleading
      // content diff. Classed `format` (not skill drift): a mode flip is an env/config mismatch, not source drift.
      findings.push({
        class: "format",
        message: `recorded in '${recMode}' file-set mode, verifying in '${liveMode}' (COWORK_HARNESS_GITSET) — re-record under the same mode`,
      });
    else if ((fp.agentScope ?? "off") !== (live.agentScope ?? "off"))
      // Agent-scoping flip (COWORK_HARNESS_AGENT_SCOPE): the scoped hash covers a different file set, so it's
      // not comparable — re-record under the same setting (mirrors the GITSET mode flip above).
      findings.push({
        class: "format",
        message: `recorded with agent-scope '${fp.agentScope ?? "off"}', verifying with '${live.agentScope ?? "off"}' (COWORK_HARNESS_AGENT_SCOPE) — re-record under the same setting`,
      });
    else if (live.skillHash !== fp.skillHash) {
      debugSkillHashMismatch(cassette, cassetteDir ?? "", fp, live, sessionOverride); // surface WHICH files drifted
      if (fp.sharedHash !== undefined && live.sharedHash !== undefined) {
        // attribute drift to the shared and/or skill bucket(s). `skillScope` is always
        // non-empty when `sharedHash` is set (single assignment site under the same guard in buildFingerprint);
        // the `?? []` is a defensive guard only — the on-disk cassette shape is not schema-validated.
        const scopeArr = fp.skillScope ?? [];
        const scopeLabel = scopeArr.map((s) => `skills/${s}`).join(", ") || "skill";
        const scopeSet = new Set(scopeArr);
        const scopeAgents = (live.agentScope ?? "off") === "skill";
        const dup = [...new Set([...duplicateManifestPaths(fp.fileSigs), ...duplicateManifestPaths(live.fileSigs)])];
        if (dup.length)
          findings.push({
            // Bucket it like every other scoped finding: a duplicate under `skills/<x>/` is skill-private,
            // anything else (a plugin manifest, a shared root file) belongs to the shared bucket. Hard-coding
            // `skill` told a JSON gate filtering on class that shared-only drift was skill drift.
            class: dup.every((p) => scopeArr.some((sk) => p.startsWith(`skills/${sk}/`))) ? "skill" : "shared-root",
            message: `ambiguous duplicate manifest path(s) across mounts (${dup.slice(0, 3).join(", ")}${dup.length > 3 ? `, +${dup.length - 3} more` : ""}) — drift attribution is unavailable for them; the hash difference is still real`,
          });
        if (fp.fileSigs && live.fileSigs) {
          // Path-accurate: emit a finding per bucket that ACTUALLY changed, so a co-occurring shared change can
          // never mask the skill's own drift (the original bug) and vice-versa.
          const { shared, skill } = partitionDriftBuckets(diffFileSigsPaths(fp.fileSigs, live.fileSigs), scopeSet, scopeAgents);
          const sharedSummary = summarizeFileSigDiff(shared);
          const skillSummary = summarizeFileSigDiff(skill);
          if (sharedSummary)
            findings.push({
              class: "shared-root",
              message: `shared root changed since record (scope: ${scopeLabel}) [${sharedSummary}] — re-record`,
            });
          if (skillSummary) findings.push({ class: "skill", message: `${scopeLabel} changed since record [${skillSummary}] — re-record` });
          if (!sharedSummary && !skillSummary) {
            // Hashes differ but the per-file manifest shows no path change (structure-only: an empty dir or a
            // symlink re-point). Fall back to the hash buckets; emit BOTH classes if the shared hash moved so
            // neither bucket is masked.
            if (live.sharedHash !== fp.sharedHash)
              findings.push({ class: "shared-root", message: `shared root changed since record (scope: ${scopeLabel}) — re-record` });
            findings.push({ class: "skill", message: `${scopeLabel} changed since record — re-record` });
          }
        } else {
          // Pre-detail cassette (no per-file manifest, e.g. > MANIFEST_MAX_FILES): can't isolate the bucket.
          // Emit BOTH classes when the shared hash moved so the skill's own drift is never masked (over-warns,
          // but the gate is already red and both classes are in the fail set).
          if (live.sharedHash !== fp.sharedHash) {
            findings.push({ class: "shared-root", message: `shared root changed since record (scope: ${scopeLabel}) — re-record` });
            findings.push({
              class: "skill",
              message: `${scopeLabel} may also have changed since record (no per-file manifest to isolate) — re-record`,
            });
          } else {
            findings.push({ class: "skill", message: `${scopeLabel} changed since record — re-record` });
          }
        }
      } else {
        // Non-scoped (whole-tree) cassette: name the changed files when the per-file manifest is present,
        // else the generic fallback.
        const dup = [...new Set([...duplicateManifestPaths(fp.fileSigs), ...duplicateManifestPaths(live.fileSigs)])];
        if (dup.length)
          findings.push({
            class: "skill",
            message: `ambiguous duplicate manifest path(s) across mounts (${dup.slice(0, 3).join(", ")}${dup.length > 3 ? `, +${dup.length - 3} more` : ""}) — drift attribution is unavailable for them; the hash difference is still real`,
          });
        const summary = fp.fileSigs && live.fileSigs ? diffFileSigs(fp.fileSigs, live.fileSigs) : null;
        if (summary) findings.push({ class: "skill", message: `skill files changed since record — ${summary} — re-record` });
        else findings.push({ class: "skill", message: "local skill/plugin dir contents changed since record — re-record" });
      }
    }
  }

  // Gate-option label drift. Two things this catches that the hash above cannot:
  //   1. a catalog REORDER — every label still exists, so a hash diff names the file but nothing explains
  //      WHY it matters; the recorded order does. A scenario whose `choose:` anchors a label by position
  //      is broken by this and by nothing else visible here.
  //   2. prose that is DELIVERED but hash-ignored (`.cowork-hashignore` / session `staleness.hash_ignore`)
  //      — outside `skillHash` entirely, so on that path this is the ONLY signal that exists.
  // Classed `skill` so it rides the existing `--fail-on-skill-drift` / `--strict` gates rather than adding
  // a fourth severity nobody configured. Cassettes recorded before the stamp existed simply skip it.
  if (fp.labelProvenance?.length) {
    try {
      const { dirs } = skillSourceDirs(cassette.scenario.session, cassetteDir, undefined, sessionOverride);
      for (const d of checkLabelProvenance(fp.labelProvenance, dirs)) findings.push({ class: "skill", message: `${d} — re-record` });
    } catch {
      /* an unresolvable session is already reported by the hash path above; don't double-report it here */
    }
  }
  // Multi-root cassettes carry a limitation the digest cannot express: the roots fold into ONE hash with
  // no root-boundary marker, so a file MOVED BETWEEN roots is invisible (a false green), and the roots'
  // fold order comes from their absolute paths (false drift on a rename). Keyed on the RECORDED
  // skillSources count, never on live resolved dirs — `declaredSkillDirs` filters roots that no longer
  // exist, so a recorded two-root cassette with one root missing would look single-root and slip past.
  // A NOTE, not a finding: it is a property of the recording's shape, not evidence anything drifted.
  if ((cassette.fingerprint?.skillSources?.length ?? 0) >= 2)
    notes.push(
      `multi-root: cassette records ${cassette.fingerprint?.skillSources?.length} skill roots — skillHash cannot distinguish a file MOVED between roots, and root fold order follows absolute paths — a rename can read as drift. See docs/cassette.md.`,
    );
  return { findings, notes };
}

/** Staleness GATE adapter for the string consumers (`verify-cassettes`, the re-record work-list). Returns
 *  the unified FINDINGS as plain reason strings. MUST stay class-blind (forward EVERY finding) so an
 *  `unverifiable-baseline` / `unverifiable-skill` / `unverifiable-tier` still reds those gates — filtering
 *  a class here would false-green `verify-cassettes` on a cassette it can't verify. Notes (the non-failing
 *  channel) deliberately do NOT travel through this adapter — a note explicitly means "nothing to
 *  re-record"; consumers that surface notes (`cmdVerifyCassettes`) call `computeStaleness` directly. */
export function checkStaleness(cassette: Cassette, cassetteDir: string): string[] {
  return computeStaleness(cassette, cassetteDir).findings.map((f) => f.message);
}

/** A minimal RunRecord for a truncated-cassette replay — empty collections so downstream evaluate()/the
 *  mismatch loops don't NPE; result:"error" because the cassette could not be driven to completion. */
function minimalRec(): RunRecord {
  return {
    runId: "replay",
    result: "error",
    initTools: [],
    transcript: "",
    toolsCalled: new Set(),
    toolCounts: {},
    filesRead: [],
    subagentTools: new Set(),
    subagents: [],
    questions: [],
    // A truncated cassette could not be driven, so it observed NO gates. [] here is not "zero gates
    // fired" — the replay ctx flags it `gateOptionsMissing`, so question_options fails
    // evidence-unavailable rather than passing over an empty list it never populated.
    gateOptions: [],
    decisions: [],
    permissiveAutoAllow: [],
    unanswered: [],
    toolResults: [],
    gateAnswers: [],
    gateDeliveries: [],
    skillsInvoked: [],
    models: [],
    thinking: [],
    thinkingElided: 0,
    toolErrors: {},
    redundantToolCalls: [],
    tasks: new Map(),
    context: { tools: [], mcpServers: [] },
    contextEvents: [],
    mcpErrors: [],
    hookEvents: [],
    fileToolAttempts: [],
    pathDenials: [],
    presentedFiles: [],
    webSearches: [],
    infraErrors: [],
    evidenceErrors: { taskTracking: 0, webSearchParse: 0, presentFilesMalformed: 0 },
  };
}

/**
 * CassetteAgentSession: replays a recorded control-protocol cassette deterministically —
 * no token, no model, no flakiness.
 *
 * When `controlOut` is present (full-fidelity mode): decision events are yielded so Run drives
 * the decision pipeline; respond() re-serializes and compares to the frozen recording (re-serialization guard).
 *
 * When `controlOut` is absent/empty (legacy events-only mode): decision events are skipped
 * (the decider does not run) — a backward-compat warning is emitted and question/gate assertions
 * are excluded from evaluation (not vacuously passed) to honour "no silent false-greens".
 */
class CassetteAgentSession implements AgentSession {
  /** Indexed by decision req.id; populated during start() for use in respond(). */
  private reqById = new Map<string, DecisionRequest>();
  /** re-serialize mismatches (request_id → {expected, actual}) — surfaced as failing assertions. */
  readonly mismatches: { id: string; expected: string; actual: string }[] = [];
  /** decision ids that were yielded (and reached respond) but have NO recorded control_response
   *  in a full-fidelity cassette — a truncated recording. Surfaced as failing replay_protocol_fidelity
   *  (instead of silently replaying a recorded allow as abstain→deny with no fidelity signal). */
  readonly missingControlOut: string[] = [];
  /** indices of malformed (non-JSON) event lines; surfaced as replay_protocol_error results. */
  readonly malformedEventLines: number[] = [];
  /** per-line PROTOCOL validation failures (valid JSON but a malformed control frame — e.g. a bad
   *  request_id or malformed AskUserQuestion body that throws in toDecisionRequest). Caught per-line so one
   *  corrupt cassette cannot abort the whole replay batch; surfaced as failing replay_protocol_fidelity. */
  readonly protocolErrorLines: { line: number; message: string }[] = [];
  /** duplicate request_ids in controlOut with DIFFERING bodies — contradictory protocol data,
   *  surfaced as UNCONDITIONAL replay_protocol_fidelity failures (no longer strict-only). */
  readonly duplicateControlOutIds: string[] = [];
  /** malformed (non-JSON) controlOut line indices — cassette corruption, surfaced as
   *  UNCONDITIONAL replay_protocol_fidelity failures (no longer warn-and-skip). */
  readonly malformedControlOutLines: number[] = [];
  /** controlOut index: request_id → recorded response body (only control_response success envelopes
   *  whose request_id matches a known decision req.id — skips init-1 and mcp_response lines).
   *  Exposed (readonly) so replayCassette can hand it to the ReplayDecider without re-parsing. */
  readonly controlOutIndex: Map<string, Record<string, unknown>>;
  /** true when controlOut was present and non-empty */
  readonly hasControlOut: boolean;

  constructor(
    private readonly events: string[],
    controlOut: string[] | undefined,
  ) {
    this.hasControlOut = !!(controlOut && controlOut.length > 0);
    const { index, differingDuplicates, malformedLines } = buildControlOutIndex(controlOut ?? []);
    this.controlOutIndex = index;
    this.duplicateControlOutIds.push(...differingDuplicates);
    this.malformedControlOutLines.push(...malformedLines);
  }

  async *start(): AsyncIterable<AgentEvent> {
    for (let i = 0; i < this.events.length; i++) {
      const line = this.events[i];
      if (!line.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        // record the malformed line index so replayCassette can surface it as a
        // replay_protocol_error assertion failure — a malformed line could conceal a failed
        // assertion, so a silent skip risks a false-green.
        warn(`::warning:: [replay] cassette events line ${i} is not valid JSON — recording as replay_protocol_error\n`);
        this.malformedEventLines.push(i);
        continue;
      }
      // parseMessage → toDecisionRequest THROWS on a malformed control frame (bad request_id /
      // malformed AskUserQuestion body). On the LIVE path the throw is caught by LiveAgentSession.start()
      // and surfaced as a typed {type:"error",source:"protocol"} event. On the REPLAY path cassette.start()
      // calls parseMessage() directly (bypassing that catch), so the throw propagates — re-thrown by
      // replayCassette — and aborts the entire batch (one bad cassette poisons every later file). Catch it
      // per-line, record a typed protocol error so replayCassette surfaces a failing
      // replay_protocol_fidelity assertion, and CONTINUE.
      let parsed: AgentEvent[];
      try {
        parsed = parseMessage(msg);
      } catch (e) {
        const message = (e as Error)?.message ?? String(e);
        warn(
          `::warning:: [replay] cassette events line ${i} is a malformed control frame — recording as replay_protocol_fidelity failure: ${message}\n`,
        );
        this.protocolErrorLines.push({ line: i, message });
        continue;
      }
      for (const ev of parsed) {
        if (ev.type === "decision") {
          // Track the request for respond() (mirrors LiveAgentSession behaviour)
          this.reqById.set(ev.request.id, ev.request);
          if (!this.hasControlOut) continue; // legacy: skip decision events
        }
        yield ev;
      }
    }
  }

  sendUserTurn(): void {}

  respond(id: string, r: import("../agent/session.js").DecisionResponse): import("../agent/session.js").DecisionDelivery {
    // Replay never re-sends to a live process — the answer is "delivered" to the recording by
    // definition. Always report delivered:true so run.ts records "answered" exactly as before on this
    // lane; the delivered:false path is a LIVE-only session-teardown condition (#20).
    if (!this.hasControlOut) return { delivered: true }; // no-op in legacy mode
    const req = this.reqById.get(id);
    if (!req) return { delivered: true };
    // Re-serialize the response through serializeDecision (the live path) and compare to the
    // frozen recording — this is the re-serialization guard: if serializeDecision regresses (e.g. drops
    // `questions` from the AskUserQuestion updatedInput), the mismatch fires token-free.
    const reserializedEnvelope = serializeDecision(req, r);
    const reserializedBody = (reserializedEnvelope as any)?.response?.response ?? reserializedEnvelope;
    const recordedBody = this.controlOutIndex.get(id);
    if (recordedBody !== undefined) {
      const actual = canon(reserializedBody);
      const expected = canon(recordedBody);
      if (actual !== expected) {
        this.mismatches.push({ id, expected, actual });
      }
    } else if (!this.missingControlOut.includes(id)) {
      // a decision was yielded in full-fidelity mode but has no recorded control_response —
      // the cassette is truncated. Record it so replayCassette fails loud (a recorded `allow` would
      // otherwise replay as a silent abstain→deny with no fidelity failure).
      this.missingControlOut.push(id);
    }
    return { delivered: true };
  }

  close(): void {}
}

/**
 * Build the controlOut index: request_id → response body.
 * Index only `control_response` success envelopes; skip init-1 and mcp_response lines
 * (mirrors trace-view.ts:142-155 which uses the same filter for consistency).
 * The "known decision req.id" filter is applied later in replayCassette after parsing events
 * (we don't have the decision IDs yet at index-build time), so we index all control_response
 * success envelopes here and let respond() silently ignore non-decision ones.
 */
/** Returns the index AND two corruption signals:
 *  - `differingDuplicates` — request_ids that appeared with DIFFERENT bodies. Byte-identical duplicates are
 *    silently de-duplicated (no-op); differing duplicates are CONTRADICTORY protocol data → an unconditional
 *    corruption failure (first-wins for the index so replay still uses the originally-recorded envelope).
 *  - `malformedLines` — controlOut lines that are not valid JSON. controlOut is part of the replay contract,
 *    so a malformed line is an unconditional corruption failure (no longer warn-and-skip / strict-only).
 *  replayCassette surfaces BOTH as failing replay_protocol_fidelity assertions, fail-closed (not --strict). */
function buildControlOutIndex(controlOut: string[]): {
  index: Map<string, Record<string, unknown>>;
  differingDuplicates: string[];
  malformedLines: number[];
} {
  const index = new Map<string, Record<string, unknown>>();
  const differingDuplicates: string[] = [];
  const malformedLines: number[] = [];
  for (let i = 0; i < controlOut.length; i++) {
    const line = controlOut[i];
    if (!line.trim()) continue;
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      // a malformed controlOut line is cassette corruption, not a skippable nuisance. Track it so
      // replayCassette fails replay protocol fidelity unconditionally (a dropped non-decision envelope used
      // to let a corrupt cassette green if the line wasn't referenced).
      warn(`::warning:: [replay] control-out.jsonl line ${i} is not valid JSON — recording as cassette corruption\n`);
      malformedLines.push(i);
      continue;
    }
    // Only control_response success envelopes (not init-1 control_requests or mcp_response envelopes)
    if (m?.type !== "control_response") continue;
    const sub = m?.response?.subtype;
    if (sub !== "success") continue;
    const rid = m?.response?.request_id;
    const body = m?.response?.response;
    // Skip mcp_response envelopes: they carry { mcp_response: { jsonrpc, id, ... } } not a decision body.
    if (body && typeof body === "object" && "mcp_response" in body) continue;
    if (rid && body && typeof body === "object") {
      const ridStr = String(rid);
      // detect duplicate request_id entries before overwriting.
      if (index.has(ridStr)) {
        const existing = index.get(ridStr)!;
        if (canon(existing) !== canon(body as Record<string, unknown>)) {
          // Differing bodies: warn loudly and record for strict-mode failure; first-wins so replay
          // uses the originally-recorded envelope rather than a potentially corrupt later duplicate.
          warn(
            `::warning:: [replay] control-out.jsonl line ${i}: duplicate request_id "${ridStr}" with DIFFERENT body — keeping first entry; cassette may be corrupt\n`,
          );
          if (!differingDuplicates.includes(ridStr)) differingDuplicates.push(ridStr);
        }
        // byte-identical duplicate: silent no-op (de-duplicate)
      } else {
        index.set(ridStr, body as Record<string, unknown>);
      }
    }
  }
  return { index, differingDuplicates, malformedLines };
}

/**
 * Build a ReplayDecider from the CassetteAgentSession's controlOut index.
 * Looks up the recorded envelope for each decision req.id, deserializes it, and returns it.
 * If no recorded envelope exists → ABSTAIN (lets Run's fail-loud-on-unanswered-question fire).
 */
function buildReplayDecider(_session: CassetteAgentSession, controlOutIndex: Map<string, Record<string, unknown>>): Decider {
  return {
    async decide(req: DecisionRequest) {
      const body = controlOutIndex.get(req.id);
      if (body === undefined) return ABSTAIN;
      return {
        response: deserializeDecision(req, body),
        by: "replay",
        rationale: "recorded",
      };
    },
  };
}

const NOOP_DECIDER: Decider = {
  async decide() {
    return ABSTAIN;
  },
};

/** Apply CONTENT redaction (the opt-in policy) across the WHOLE cassette surface: events/controlOut
 *  protocol lines (structurally — string leaves AND object keys, keeping JSON valid + the question/answer
 *  strings in sync), artifact bodies, the scenario prompt/answers/assert metadata, and the diagnostic
 *  skillSources. Identity fields (name/session/fidelity/baseline) are left intact so replay still resolves.
 *  Pure — returns a new cassette. Distinct from secret-scrub (`scrub`), which runs first. */
export function redactCassette(cassette: Cassette, policy: RedactionPolicy): Cassette {
  const scenario = {
    ...cassette.scenario,
    prompt: redactText(cassette.scenario.prompt, policy),
    answers: redactStructural(cassette.scenario.answers, policy),
    assert: redactStructural(cassette.scenario.assert, policy),
  } as Scenario;
  // redact the user-visible mount roots STRUCTURALLY with the same policy. Previously the roots were
  // spread through unredacted while artifact paths WERE redacted — so a customer folder root (e.g.
  // `.projects/Acme`) leaked AND, worse, the redacted artifact path (`.projects/[REDACTED]/file`) no longer
  // started with the unredacted root, breaking materializeManifest's prefix match (cassette.ts ~1692) at
  // replay. `redactText` is context-free (same input → same token), so the SAME substring redacts identically
  // in both the root and the path, keeping the prefix relationship intact.
  const redactedRoots = cassette.userVisibleRoots?.map((r) => redactText(r, policy));
  // Upload roots are redacted with the SAME policy before comparing, so a rule that rewrites `uploads`
  // rewrites it identically on both sides (the context-free property the paragraph above relies on).
  // A cassette does not persist which input roots produced it, so this reads the shared default.
  const redactedInputRoots = INPUT_ROOTS.map((r) => redactText(r, policy));
  const redactedArtifacts = cassette.artifacts?.map((a) => {
    const out: ManifestEntry = { ...a, path: redactText(a.path, policy) }; // a filename can name a customer (outputs/Acme-cap-table.json)
    // a base64 (binary) body has no text PII to redact, and redacting it would corrupt the bytes
    // and then false-fail the replay-time sha256 verify — leave binary bodies untouched.
    // Also skip bodies that are already secret-scrub redaction markers ([REDACTED:*]): rewriting
    // them without recomputing sha256 would produce a misleading "corrupt cassette" error at replay.
    if (a.body !== undefined && a.encoding !== "base64" && !a.body.startsWith("[REDACTED")) {
      // Redact the body as TEXT, not via redactJsonLine. A deliverable artifact is a plain file with
      // no replay protocol coupling, and redactText preserves bytes EXACTLY when nothing matches —
      // redactJsonLine compact-reserializes (JSON.stringify∘JSON.parse), so a pretty-printed or
      // newline-terminated JSON body changed bytes even on a no-match policy while the spread `...a`
      // kept the stale sha256, crashing replay's materializeManifest verify.
      const body = redactText(a.body, policy);
      if (body !== a.body) {
        out.body = body;
        // Recompute sha256 over the redacted utf8 bytes so the replay-time verify passes. When nothing
        // matched, body === a.body and the spread-in sha256 is still correct — base and redacted stay
        // byte-identical (no hash-changed-on-a-no-op false-failure).
        out.sha256 = createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex");
      }
    }
    return out;
  });
  // Structural consistency check: every redacted artifact path must still map under one of the
  // redacted roots. If a redaction rule rewrote a path but not its containing root (or vice versa), the
  // prefix relationship is broken and replay's user_visible_artifact/materialize would silently mismatch —
  // fail LOUD here rather than write an inconsistent cassette. (Only checked when roots are present.)
  if (redactedRoots && redactedRoots.length && redactedArtifacts) {
    // A path maps under a root when it equals the root or sits under it (root + "/"). Roots may be
    // multi-segment (e.g. `.projects/<folder>`), so compare on the full normalized prefix — not just the
    // first path segment. Normalize separators so a `\`-vs-`/` cassette doesn't false-trip the check.
    const norm = (p: string) => p.replace(/\\/g, "/");
    // Inputs are matched by PATH PREFIX, not by `truncationReason: "input"`: a SYMLINKED upload short-
    // circuits in readEntry (linkKind returns before the reason is applied), so it carries no reason and a
    // reason-keyed exemption would miss exactly the case it needs to cover.
    const normRoots = [...redactedRoots, ...redactedInputRoots].map(norm);
    for (const a of redactedArtifacts) {
      const p = norm(a.path);
      const mapped = normRoots.some((r) => p === r || p.startsWith(r + "/"));
      if (!mapped)
        throw new Error(
          `redaction broke artifact↔root consistency: artifact path "${a.path}" no longer maps under any redacted userVisibleRoot [${redactedRoots.join(", ")}] — ` +
            `redact the root and the path with the same rule (a path component was rewritten but its root was not)`,
        );
    }
  }
  // Same context-free `redactText` as `userVisibleRoots`: identical input redacts identically on both
  // sides, so a `from` that also appears in a root stays consistent with it.
  const redactedFolderPrefixMap = cassette.folderPrefixMap?.map((e) => ({ ...e, from: redactText(e.from, policy) }));
  const redactedPreRunPaths = cassette.preRunPaths?.map((p) => redactText(p, policy));
  // preRunHashes VALUES are hex sha256 (or null) — no secrets, never redacted. The KEYS are paths (same
  // privacy surface as preRunPaths entries), so redact each key and keep the value as-is.
  const redactedPreRunHashes =
    cassette.preRunHashes && Object.fromEntries(Object.entries(cassette.preRunHashes).map(([k, v]) => [redactText(k, policy), v]));
  return {
    ...cassette,
    scenario,
    userVisibleRoots: redactedRoots,
    folderPrefixMap: redactedFolderPrefixMap,
    artifacts: redactedArtifacts,
    preRunPaths: redactedPreRunPaths,
    preRunHashes: redactedPreRunHashes,
    events: cassette.events.map((l) => redactJsonLine(l, policy)),
    controlOut: cassette.controlOut?.map((l) => redactJsonLine(l, policy)),
    fingerprint: cassette.fingerprint
      ? {
          ...cassette.fingerprint,
          skillSources: cassette.fingerprint.skillSources?.map((s) => redactText(s, policy)),
          // v5: redact the manifest's paths too (a path component can carry a customer name); keep the sha.
          fileSigs: cassette.fingerprint.fileSigs?.map(([p, h]) => [redactText(p, policy), h] as [string, string]),
        }
      : undefined,
    // Mirror of the scan above: `ref` is user-controlled, so a policy that rewrites a private registry
    // host must rewrite it here too, or `scanCassette` keeps finding what `redactCassette` cannot fix.
    // The digests are content hashes with no PII and are deliberately left intact — rewriting them would
    // destroy the only identity Task 6's comparison can use.
    environment: cassette.environment?.agentImage
      ? {
          ...cassette.environment,
          agentImage: { ...cassette.environment.agentImage, ref: redactText(cassette.environment.agentImage.ref, policy) },
        }
      : cassette.environment,
  };
}

/** The model-visible TEXT surfaces of a cassette's raw event lines: assistant text blocks + the final
 *  `result` string. Used ONLY for base-vs-redacted comparison in the guard below, so it needn't replicate
 *  run.ts's exact transcript assembly (e.g. subagent filtering) — both sides go through the SAME
 *  extraction and only the DIFFERENCE matters. */
function modelVisibleText(events: string[]): string {
  const parts: string[] = [];
  for (const line of events) {
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof e !== "object" || e === null) continue;
    const ev = e as { type?: string; result?: unknown; message?: { content?: unknown } };
    if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
      for (const b of ev.message.content as { type?: string; text?: unknown }[])
        if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
    } else if (ev.type === "result" && typeof ev.result === "string") {
      parts.push(ev.result);
    }
  }
  return parts.join("\n");
}

/** Cardinal-sin guard: redaction must be VERDICT-PRESERVING. Replay both the pre-redaction and the
 *  redacted cassette (token-free) and compare verdicts; if redaction flipped any replay-checkable assertion
 *  (e.g. stripped a value a `transcript_not_matches` keys on, manufacturing a green), throw — never write a
 *  cassette whose verdict was changed by redaction.
 *
 *  Beyond pass/fail counts, the check also compares:
 *  1. All assertion code+pass pairs as a sorted set — a flip from pass→fail or fail→pass on a SPECIFIC
 *     assertion is caught even when the total failure count is the same.
 *  2. Failing assertion messages, normalized so [REDACTED] substitutions are tolerated while unexpected
 *     message mutations (e.g. a body swap that changes which value triggered the failure) are caught.
 *  3. Artifact SHA-256 hashes for text bodies — a redaction that replaces a body while keeping the
 *     assertion passing would corrupt the cassette's replay-time sha256 verify; catch it here first.
 *  4. `computer://` link COUNTS over the model-visible text. A redaction pattern that eats a link's
 *     closing delimiter (e.g. a path class that doesn't exclude `)`) destroys the link at extraction
 *     time — `computer_links_resolve` then passes VACUOUSLY on replay (zero links = presence-gated
 *     pass) while the verdict compare above sees pass==pass. A dropped link is a manufactured green,
 *     not a privacy fix. (The first committed hostloop cassette shipped exactly this bug.) */
export async function assertRedactionVerdictPreserved(base: Cassette, redacted: Cassette, cassetteDir?: string): Promise<void> {
  // Resolve skill dirs against the cassette's dir just like `verify-cassettes` does (`replayCassette` at
  // the batch site passes `dirname(f)`). Without it, the relocatable relative session path fails to resolve
  // and every redacted record self-check emitted a spurious `unverifiable-skill` staleness warning.
  const [rb, rr] = await Promise.all([replayCassette(base, [], { cassetteDir }), replayCassette(redacted, [], { cassetteDir })]);
  const vb = computeVerdict(rb, "replay");
  const vr = computeVerdict(rr, "replay");

  // 1. All assertion code+pass pairs as a sorted set.
  //    Each pair is "<assertionKey>:<pass>" — the first defined key names the assertion type.
  const assertionPairs = (result: RunResult): string[] =>
    result.assertions
      .map((a) => {
        const key = Object.keys(a.assertion).filter((k) => (a.assertion as Record<string, unknown>)[k] !== undefined)[0] ?? "(unknown)";
        return `${key}:${a.pass}`;
      })
      .sort();

  const basePairs = assertionPairs(rb);
  const redactedPairs = assertionPairs(rr);

  // (kept for the error detail message) failed assertion keys only
  const failedKeys = (pairs: string[]): string[] =>
    pairs
      .filter((p) => p.endsWith(":false"))
      .map((p) => p.slice(0, -":false".length))
      .sort();

  // 2. Failing assertion messages, normalized so [REDACTED] substitutions are acceptable.
  //    Strip any [REDACTED…] tokens from the message before comparing, so a redacted string that
  //    appears in an error message doesn't fire a false-positive on normalization.
  // the real token is `[REDACTED:label:hash]` (redact.ts token()), NOT a bare `[REDACTED]` —
  //    matching only the bare form left labeled/hashed tokens in the redacted message while the base message
  //    kept the original literal, manufacturing a false "redaction changed assertions" failure. Widen the
  //    pattern to tolerate the optional `:label:hash` suffix.
  const normalizeMsg = (msg: string | undefined): string => (msg ?? "").replace(/\[REDACTED(?::[^\]]+)?\]/g, "");
  const failedMsgs = (result: RunResult): string[] =>
    result.assertions
      .filter((a) => !a.pass)
      .map((a) => normalizeMsg(a.message))
      .sort();

  // 3. INTERNAL sha256 consistency of the REDACTED cassette: every committed body's stored sha256 must
  //    equal the hash of its actual bytes. A redaction that rewrote a body without recomputing sha256
  //    (this corruption) makes the redacted cassette throw at replay's materializeManifest verify —
  //    but that verify only runs when the scenario HAS a file/artifact assertion; without one, a corrupt
  //    cassette would be written silently. This guard catches it unconditionally, at record.
  //    (Replaces the old base-vs-redacted `path:sha` compare, which was doubly dead: artifact paths ARE
  //    redacted so it always benignly "mismatched", and the stale sha256 it compared never reflected the
  //    rewritten body, so it never caught real corruption.)
  const bodyShaInconsistent = (cassette: Cassette): string[] =>
    (cassette.artifacts ?? [])
      .filter((a) => !a.truncated && a.body !== undefined && a.sha256)
      .filter((a) => {
        const raw = a.encoding === "base64" ? Buffer.from(a.body as string, "base64") : Buffer.from(a.body as string, "utf8");
        return createHash("sha256").update(raw).digest("hex") !== a.sha256;
      })
      .map((a) => a.path);

  const inconsistentBodies = bodyShaInconsistent(redacted);

  // 4. computer:// link structure must survive redaction (see the doc comment).
  const baseLinkCount = extractComputerLinks(modelVisibleText(base.events)).length;
  const redactedLinkCount = extractComputerLinks(modelVisibleText(redacted.events)).length;

  const verdictMismatch = vb.pass !== vr.pass;
  const pairsMismatch = basePairs.join("|") !== redactedPairs.join("|");
  const msgsMismatch = failedMsgs(rb).join("|") !== failedMsgs(rr).join("|");
  const bodyShaBroken = inconsistentBodies.length > 0;
  const linksDestroyed = baseLinkCount !== redactedLinkCount;

  if (verdictMismatch || pairsMismatch || msgsMismatch || bodyShaBroken || linksDestroyed) {
    let detail: string;
    if (verdictMismatch) {
      // Name WHAT changed, not just that something did. Two diffs, because either can be the cause and
      // only one is usually non-empty: the failing-assertion set, and the verdict SIGNAL codes.
      // `computeVerdict` folds in non-assertion signals (result_error / transport_error /
      // requiresCapabilityUnmet / …), so a verdict can flip with an UNCHANGED failing-assertion set —
      // printing only the key diff would then read `[] → []` and send the operator to the wrong layer.
      const bf = failedKeys(basePairs);
      const rf = failedKeys(redactedPairs);
      const bs = vb.signals.map((s) => s.code);
      const rs = vr.signals.map((s) => s.code);
      detail =
        `pre-redaction pass=${vb.pass} → redacted pass=${vr.pass}; ` +
        `failing assertions: [${bf.join(", ")}] → [${rf.join(", ")}]; ` +
        `verdict signals: [${bs.join(", ")}] → [${rs.join(", ")}]`;
    } else if (pairsMismatch) {
      const bf = failedKeys(basePairs);
      const rf = failedKeys(redactedPairs);
      detail = `assertion failures changed: [${bf.join(", ")}] → [${rf.join(", ")}]`;
    } else if (msgsMismatch) {
      detail = "failing assertion messages changed unexpectedly after redaction";
    } else if (bodyShaBroken) {
      detail = `redacted artifact body sha256 no longer matches its bytes (replay would reject as corrupt): ${inconsistentBodies.join(", ")}`;
    } else {
      detail =
        `redaction destroyed computer:// link structure: ${baseLinkCount} link(s) pre-redaction → ${redactedLinkCount} after — ` +
        `computer_links_resolve would pass vacuously on replay (zero links = pass). Fix the redaction pattern to preserve ` +
        `link delimiters (exclude \`)\`/\`]\`/backtick from path character classes), or redact only the machine-specific path prefix`;
    }
    throw new Error(
      `cowork-harness: redaction changed assertion failures: ${detail} — redaction altered an ` +
        `asserted observable; refusing to write a cassette whose verdict was manufactured by redaction. ` +
        `Record against synthetic inputs, or narrow the redaction policy so it doesn't touch asserted values.`,
    );
  }
}

export interface ScenarioDiscovery {
  scenarios: string[]; // files with a top-level `prompt:` that parse as a valid Scenario
  skipped: string[]; // *.yaml with NO `prompt:` key — a session/other doc; announced, not a failure
  broken: { file: string; error: string }[]; // looks like a scenario (has `prompt:`) but unparseable/invalid
}

/** Classify the `*.yaml`/`*.yml` (non-recursive) under `dir` for batch `record`. Classification keys on a
 *  POSITIVE `prompt:` signal — NOT on "Scenario.parse threw", because a session YAML and a broken scenario
 *  both throw the same error. A doc with `prompt:` that fails to parse is BROKEN (a batch failure), never a
 *  silent skip — silently swallowing a broken scenario as a non-scenario is the false-green this guards. */
export function discoverScenarios(dir: string): ScenarioDiscovery {
  const files = readdirSync(dir)
    .filter((f) => /\.ya?ml$/i.test(f))
    .sort()
    .map((f) => join(dir, f));
  const out: ScenarioDiscovery = { scenarios: [], skipped: [], broken: [] };
  for (const f of files) {
    let raw: unknown;
    try {
      raw = parseYaml(readFileSync(f, "utf8"));
    } catch (e) {
      out.broken.push({ file: f, error: `YAML parse error: ${(e as Error).message}` });
      continue;
    }
    const hasPrompt = raw !== null && typeof raw === "object" && "prompt" in (raw as Record<string, unknown>);
    if (!hasPrompt) {
      out.skipped.push(f); // no prompt → a session/other doc; announced skip, not a failure
      continue;
    }
    try {
      parseScenarioFile(f);
      out.scenarios.push(f);
    } catch (e) {
      out.broken.push({ file: f, error: (e as Error).message });
    }
  }
  return out;
}

/** LENIENT structural schema for a cassette — guards exactly the fields the replay/scan/staleness paths
 *  dereference (`events`, `scenario.prompt`, `scenario.session`, `scenario.assert`) so a malformed-but-valid
 *  JSON cassette is a clean error instead of a runtime crash. Deliberately loose (`z.looseObject`, NOT the
 *  strict authoring-time ScenarioObject) so a forward-compatible cassette carrying unknown keys still replays. */
const CassetteShape = z.looseObject({
  events: z.array(z.string()),
  // The fingerprint was previously unvalidated — it arrived through the loose passthrough as untyped data,
  // so nothing at the READ boundary enforced the version/format invariant. `looseObject` keeps unknown
  // members, so this validates the two fields the epoch depends on without freezing the rest.
  fingerprint: z
    .looseObject({
      skillHash: z.string().optional(),
      hashFormat: z.string().optional(),
    })
    .optional(),
  scenario: z.looseObject({ prompt: z.string(), session: z.string(), assert: z.array(z.unknown()).optional() }),
  // v9 (Finding 23/24) — both optional; absent on any pre-v9 cassette (backward-compat).
  sessionFingerprint: z.string().optional(),
  folderPrefixMap: z.array(z.object({ from: z.string(), mount: z.string() })).optional(),
});

/** the ONE place the default cassette path is computed from a scenario name. Both `record --dry-run`
 *  and live `recordScenarioObject` route through this so the dry-run report can't print a different path than
 *  the one record actually writes (the raw name vs `slugForPath` divergence: a name with spaces/separators
 *  slugifies, so `cassettes/My Run.cassette.json` reported but `cassettes/my-run.cassette.json` written). */
export function defaultCassettePath(scenarioName: string): string {
  return join("cassettes", `${slugForPath(scenarioName)}.cassette.json`);
}

/**
 * Read a cassette for the PRIVACY SCAN ONLY, with no shape validation beyond "is there a transcript".
 *
 * The other half of the read-boundary split (see `ScannableCassette`). `readCassette` stays strict —
 * everything downstream of it (replay, staleness, the version/hashFormat invariant) depends on that, and
 * it was deliberately tightened for the hash-format epoch. This function does NOT relax it; it is a
 * separate, narrower door for the one job that never needed document validity in the first place.
 *
 * The only hard requirement is `events: string[]`. Everything else is best-effort and dropped when it is
 * not the expected shape, because a partially-corrupt document must still be scannable — that is the
 * entire point. Two consequences worth being explicit about:
 *
 *  - A dropped `fidelity`/`effectiveFidelity` leaves the tier UNDEFINED, which `scanCassette` treats as
 *    host-inheriting and scans structurally. Fail-closed, and the direction we want here.
 *  - This function MUST NOT throw. It runs on files that are already known to be malformed; a crash here
 *    reads as "the rest were fine" for every remaining file in a batch walk.
 */
export function readCassetteForScan(path: string): { scannable: ScannableCassette } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { error: `unreadable / invalid cassette JSON: ${(e as Error).message}` };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { error: "not a JSON object" };
  const o = raw as Record<string, unknown>;

  const strings = (v: unknown): string[] | undefined =>
    Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const obj = (v: unknown): Record<string, unknown> | undefined =>
    v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  // Only a tier this build positively recognizes survives; anything else becomes `undefined`, which
  // `scanCassette` treats as host-inheriting. Never widen this to "any string".
  const knownTier = (v: unknown): string | undefined => (typeof v === "string" && KNOWN_TIERS.has(v) ? v : undefined);

  // The ONE hard requirement. Without a transcript there is nothing to scan, and saying so is honest —
  // reporting "clean" for a file we could not read is the false-green this whole split exists to remove.
  const events = strings(o.events);
  if (events === undefined) return { error: "no readable transcript (`events` is not an array of strings)" };

  const scenario = obj(o.scenario) ?? {};
  const fingerprint = obj(o.fingerprint);
  const environment = obj(o.environment);
  const agentImage = environment ? obj(environment.agentImage) : undefined;

  return {
    scannable: {
      events,
      controlOut: strings(o.controlOut),
      // FAIL CLOSED on a tier we do not recognize. `scanCassette` exempts a positively-sealed tier and
      // scans everything else, INCLUDING `undefined` — but it tests set membership, so an arbitrary string
      // (`"garbage"`, or a typo'd `"containerr"`) is neither undefined nor host-inheriting and would SKIP
      // the structural host-inventory scan entirely. The strict reader cannot produce that (Zod validates
      // fidelity to a literal union); this reader can, because malformed input is its whole job. So a tier
      // that is not a known one is dropped to `undefined`, which scans.
      effectiveFidelity: knownTier(o.effectiveFidelity),
      // Artifacts are read for `path`/`body`/`encoding`; keep only entries that actually carry a string
      // path, so a malformed element cannot make `scanCassette` throw mid-walk.
      artifacts: (Array.isArray(o.artifacts) ? o.artifacts : []).filter(
        (a): a is NonNullable<Cassette["artifacts"]>[number] => obj(a) !== undefined && typeof (a as { path?: unknown }).path === "string",
      ),
      fingerprint:
        fingerprint === undefined
          ? undefined
          : {
              skillSources: strings(fingerprint.skillSources),
              fileSigs: (Array.isArray(fingerprint.fileSigs) ? fingerprint.fileSigs : []).filter(
                (e): e is [string, string] => Array.isArray(e) && typeof e[0] === "string",
              ),
            },
      userVisibleRoots: strings(o.userVisibleRoots),
      // Keep only entries carrying a string `from` so a malformed element cannot make the scan throw
      // mid-walk — same defensive shape as `artifacts` above.
      folderPrefixMap: (Array.isArray(o.folderPrefixMap) ? o.folderPrefixMap : []).flatMap((e) => {
        const el = obj(e);
        return el === undefined ? [] : [{ from: str(el.from), mount: str(el.mount) }];
      }),
      scenarioSource: str(o.scenarioSource),
      environment: agentImage === undefined ? undefined : { agentImage: { ref: str(agentImage.ref) } },
      scenario: {
        prompt: str(scenario.prompt),
        fidelity: knownTier(scenario.fidelity),
        answers: scenario.answers,
        assert: Array.isArray(scenario.assert) ? scenario.assert : undefined,
        name: str(scenario.name),
        session: str(scenario.session),
      },
    },
  };
}

/** The finding classes that mean "this recording carries the RECORDING MACHINE's identity" — as opposed to
 *  the content classes (`email`, `currency`, `domain`, `path`), which are frequently legitimate scenario
 *  content: a cap-table fixture is SUPPOSED to contain currency figures and customer domains. Quarantining
 *  on those would make `record` unusable and train the operator to pass the escape flag by reflex, which is
 *  how a safety gate becomes decoration. These two are never legitimate output of a scenario. */
const QUARANTINE_CLASSES: ReadonlySet<string> = new Set(["host-inventory", "machine-inventory"]);

/** Where a leaking recording goes instead of the path the operator asked for.
 *
 *  Inside the runs root, which already exists to keep sensitive run output OUT of the working tree and
 *  already honours `--run-dir`/`COWORK_HARNESS_RUNS_DIR`. NOT a gitignored directory inside the repo: a
 *  `.gitignore` entry is one `git add -f` from being defeated and, worse, makes the file invisible to
 *  `git status`, so the operator cannot see what they are carrying.
 *
 *  If the runs root is itself repo-visible (someone pointed `--run-dir` inside the working tree), fall back
 *  to the OS temp dir and SAY SO — quarantining a leak into another committable location would be theatre. */
function quarantineDir(): { dir: string; fellBack: boolean } {
  const preferred = join(runsWriteRoot(), "quarantine");
  if (isRepoVisiblePath(preferred)) return { dir: join(tmpdir(), "cowork-harness-quarantine"), fellBack: true };
  return { dir: preferred, fellBack: false };
}

/** RECORD-TIME verdict on a finished recording — evidence, where `hostInventoryPreflight` is a PREDICTION.
 *
 *  The preflight reads the tier and the destination path and refuses before the paid spawn. It is the right
 *  check and this does not replace it, but it never reads the resulting bytes and can be wrong in both
 *  directions. Until this existed, `scanCassette` had a single production call site — `verify-cassettes` —
 *  which runs at COMMIT time at the earliest.
 *
 *  Pure and exported so the policy is testable without a paid run. The caller executes the verdict; every
 *  branch here is a decision, not an effect.
 */
export function classifyRecordLeak(
  cassette: ScannableCassette,
  cassettePath: string,
  allowOverride: boolean,
): { kind: "ok" } | { kind: "override" | "outside-repo" | "quarantine"; detail: string } {
  const leaks = scanCassette(cassette, []).filter((f) => QUARANTINE_CLASSES.has(f.cls));
  if (leaks.length === 0) return { kind: "ok" };
  const detail = leaks.map((f) => `  [${f.cls}] ${f.where} — ${f.sample ?? "(no sample)"}`).join("\n");
  // The operator already asserted this fixture is deliberate (the same flag the preflight honours). Still
  // reported by the caller — an override must never be quiet about what it overrode.
  if (allowOverride) return { kind: "override", detail };
  // Outside a repo nothing publishes this by accident, so quarantining would be obstruction rather than
  // protection. Still worth saying loudly: the operator may be about to copy it somewhere.
  if (!isRepoVisiblePath(cassettePath)) return { kind: "outside-repo", detail };
  return { kind: "quarantine", detail };
}

/** Write a leaking recording somewhere it cannot be committed, plus a sibling explaining why.
 *
 *  Quarantine rather than discard: the tokens are already spent, so throwing the recording away is the most
 *  expensive possible answer and the one most likely to end in "just commit it anyway". Exported for tests.
 */
export function quarantineCassette(
  cassette: unknown,
  scenarioName: string,
  intendedPath: string,
  tier: string | undefined,
  detail: string,
  now: string,
): { path: string; fellBack: boolean } {
  const { dir, fellBack } = quarantineDir();
  mkdirSync(dir, { recursive: true });
  const stamp = now.replace(/[:.]/g, "-");
  const qPath = join(dir, `${slugForPath(scenarioName)}-${stamp}.cassette.json`);
  writeFileAtomic(qPath, JSON.stringify(cassette, null, 2));
  writeFileAtomic(
    `${qPath}.findings.txt`,
    `cowork-harness record — quarantined ${now}\nintended path: ${intendedPath}\ntier: ${tier ?? "(unknown)"}\n\n${detail}\n`,
  );
  return { path: qPath, fellBack };
}

/** Read + parse a cassette, never throwing — a malformed `*.cassette.json` must be TALLIED, not crash a
 *  whole batch (a crash mid-walk reads as "the rest were fine" — a false-green by abort).
 *  Exported for tests (the validate-and-warn-on-assert behavior). */
export function readCassette(path: string): { cassette: Cassette } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { error: `unreadable / invalid cassette JSON: ${(e as Error).message}` };
  }
  const parsed = CassetteShape.safeParse(raw);
  if (!parsed.success)
    return {
      error: `invalid cassette shape: ${parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ")}`,
    };
  const cassette = raw as Cassette;
  // `assert` is optional in an old/truncated cassette (the schema tolerates its absence) but downstream
  // (replayCassette/redact) iterates it unconditionally — normalize to [] here, at the one parse boundary,
  // so a missing-assert cassette can't NPE and abort a whole replay batch (readCassette's never-crash contract).
  const scn = cassette.scenario as { assert?: unknown[] };
  if (!Array.isArray(scn.assert)) scn.assert = [];
  // Validate each `scenario.assert` element against the (strict) assertion schema. An unrecognized/malformed
  // assertion in a cassette recorded by THIS or an OLDER harness is a hard REJECT — it would otherwise vanish
  // from replay evaluation and green by omission. A cassette recorded by a NEWER harness (future version) may
  // legitimately carry an assertion key this build doesn't know: keep warn-and-tolerate there (forward-compat).
  const recordedVersion = cassette.cassetteVersion ?? 0;
  if (recordedVersion < MIN_SUPPORTED_CASSETTE_VERSION) {
    return {
      error:
        `cassette recorded at v${recordedVersion} is older than the minimum supported version ` +
        `v${MIN_SUPPORTED_CASSETTE_VERSION} — re-record this cassette (pre-1.0, no compatibility is ` +
        `maintained for cassette formats below v${MIN_SUPPORTED_CASSETTE_VERSION})`,
    };
  }
  // VERSION/FORMAT INVARIANT, at the read boundary. `cassetteVersion` says which reader is required;
  // `fingerprint.hashFormat` says which transform produced the digests. Nothing else ties them together,
  // and the "absent means legacy" rule would silently mis-read a v12 document that forgot the stamp.
  //
  // Bound to the KNOWN current version only. A future v13/`jcs2` must NOT be rejected here — that belongs
  // to the future-cassette policy just below, which is the surface that already knows how to talk about
  // versions this build does not understand.
  if (cassette.fingerprint !== undefined) {
    const fmt = cassette.fingerprint.hashFormat;
    const shown = fmt === undefined ? "(absent)" : `'${fmt}'`;
    // KNOWN versions only, both directions. A future v13/`jcs2` is NOT judged here — that belongs to the
    // future-cassette policy below, which is the surface that knows how to talk about versions this build
    // does not understand. The check applies to a baseline-only fingerprint too: `hashFormat` is stamped on
    // every buildFingerprint return path, so its absence at the current version is a genuine inconsistency
    // rather than a shape this build ever writes.
    // Bound to HASH_FORMAT_EPOCH, not CASSETTE_VERSION. They are equal today and will not stay so: the
    // next SHAPE-only bump moves CASSETTE_VERSION to 13 and leaves the epoch at 12. Keyed on the shape
    // version, a v12 fingerprint missing `hashFormat` would start loading again, D7's "absent ⇒ legacy"
    // would apply to an epoch-stamped document, and live `jcs1` digests would be compared as though they
    // were the same algorithm. `requiredVersionFor` derives its BASE from the epoch for this same reason.
    if (recordedVersion === HASH_FORMAT_EPOCH && fmt !== "jcs1") {
      return {
        error:
          `cassette is stamped v${recordedVersion} but its fingerprint carries hashFormat ${shown} — a v${HASH_FORMAT_EPOCH} ` +
          `cassette must record 'jcs1'. The stamp and the digests disagree, so neither can be trusted; re-record`,
      };
    }
    if (recordedVersion < HASH_FORMAT_EPOCH && fmt !== undefined) {
      return {
        error:
          `cassette is stamped v${recordedVersion} (pre-epoch) but its fingerprint carries hashFormat ${shown} — a ` +
          `pre-v${HASH_FORMAT_EPOCH} cassette predates that field entirely, so the stamp and the digests disagree; re-record`,
      };
    }
  }
  const isFutureCassette = recordedVersion > CASSETTE_VERSION;
  const assertErrors: string[] = [];
  scn.assert.forEach((a, i) => {
    const r = AssertionSchema.safeParse(a);
    if (r.success) return;
    const detail = `scenario.assert[${i}]: ${r.error.issues.map((iss) => `${iss.path.join(".") || "<root>"}: ${iss.message}`).join("; ")}`;
    if (isFutureCassette)
      warn(
        `::warning:: [cassette] unrecognized assertion (tolerated — cassette v${recordedVersion} is newer than v${CASSETTE_VERSION}): ${detail}\n`,
      );
    else assertErrors.push(detail);
  });
  if (assertErrors.length)
    return {
      error:
        `cassette (v${recordedVersion} ≤ current v${CASSETTE_VERSION}) contains unrecognized assertion(s) — they would silently drop from replay: ` +
        `${assertErrors.join("; ")}. Fix the assertion, or re-record.`,
    };
  return { cassette };
}

/** The committed cassettes under `dir` whose fingerprint has drifted (baseline/skill) — the re-record
 *  work-list. Pure + token-free (reuses `checkStaleness`); the actual re-record needs the live agent. A
 *  malformed cassette is surfaced as stale (needs attention) rather than silently dropped. */
export function selectStaleCassettes(dir: string): { path: string; staleness: string[] }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".cassette.json"))
    .sort()
    .map((f) => join(dir, f))
    .map((path) => {
      const r = readCassette(path);
      return "error" in r ? { path, staleness: [r.error] } : { path, staleness: checkStaleness(r.cassette, dirname(path)) };
    })
    .filter((x) => x.staleness.length > 0);
}

interface RecordOpts {
  noRedact: boolean;
  allowFailing: boolean;
  force?: boolean; // --force: overwrite a default-path cassette even if it belongs to a different scenario (slug collision)
  cassettePath?: string; // explicit --out (single); otherwise cassettes/<name>.cassette.json
  maxArtifactBytes?: number; // override the inline-body cap (else env / 64 KiB default)
  scenarioSourceFile?: string; // the on-disk scenario YAML this was recorded from (for --rerecord-stale)
  // The batch paths (`record <dir>`, `--rerecord-stale`) run ONE redaction preflight before the first spawn
  // (a per-scenario warning under pMapBounded fires after siblings already paid, and a shared empty
  // policy would emit N interleaved duplicates) — they set this so the per-record preflight doesn't re-fire.
  skipRedactionPreflight?: boolean;
  // --allow-host-inventory-fixture: proceed with a host-inheriting record into a repo-tracked path. Named
  // distinctly from verify-cassettes' `--allow-host-inventory <regex>` (a value-taking class allow) so the
  // two cannot be confused: this one is a boolean consent to RECORD, not a finding suppressor.
  allowHostInventoryFixture?: boolean;
  // Live-decider plumbing: answer gates DURING the recording instead of pre-scripting them.
  // `onUnanswered` = --on-unanswered fail|first ("llm" when --decider-llm); `externalChannel` = --decider-dir
  // file rendezvous; `llmIntent` = --decider-llm one-line intent; `deciderChannel` labels the authoring stamp.
  onUnanswered?: OnUnanswered;
  externalChannel?: DecisionChannel;
  llmIntent?: string;
  llmModel?: string; // --decider-model: the LLM decider's answering model (flag > env > Sonnet default)
  deciderChannel?: "decider-dir" | "decider-llm";
}

/** Resolve the tier a record run WILL use, for the redaction preflight. Mirrors execute.ts's live
 *  resolution (env-INCLUSIVE — this is a live run, unlike the verify-time resolved-tier check, which pins env off).
 *  An unresolvable baseline returns "unresolvable" and the preflight stays quiet — the record itself
 *  will fail loudly on the same load moments later, and a guessed tier could mis-warn. */
export function resolvePreflightTier(scenario: Scenario): string {
  if (scenario.fidelity !== "cowork") return scenario.fidelity;
  try {
    return decideLoopFromBaseline(loadBaseline(scenario.baseline)) === "host" ? "hostloop" : "container";
  } catch {
    return "unresolvable";
  }
}

/** Redaction preflight. Historically the empty-policy discovery happened only AFTER the paid
 *  run, at the post-run policy load. Returns a `::warning::` line when any scenario about to record at a
 *  host-path-bearing tier (hostloop — native host paths; protocol — no sandbox, real cwd) has an EMPTY
 *  assembled redaction policy — the committed cassette would then embed real host paths and
 *  `verify-cassettes`' `path` scanner hard-fails them. `::warning::` (not `::notice::`): the condition
 *  predicts a future hard gate failure, the same severity the sibling tier/assert run-start warnings use.
 *  Callers emit it BEFORE the agent spawns (that timing is the point). Returns null when nothing is risky.
 *  A malformed .cowork-redact.json THROWS here — pre-spawn, before the run is paid for (strictly earlier
 *  than the post-run load that would throw anyway). */
/** Tiers whose RECORDING inherits the host environment. Mirrors HOST_INHERITING_TIERS but resolves `cowork`
 *  for real via resolvePreflightTier, which is cheap and exact pre-spawn. */
function isHostInheritingRecord(scenario: Scenario): boolean {
  const tier = resolvePreflightTier(scenario);
  // "unresolvable" = the baseline failed to load. Stay quiet and let the record itself fail loudly on the
  // same load moments later — the precedent resolvePreflightTier already documents. Guessing a tier here
  // would mis-refuse a run that was never going to start.
  return tier === "protocol" || tier === "hostloop";
}

/** Is `p` inside a git work tree AND not ignored? Tracked-ness is the wrong test: a brand-new
 *  `--out examples/replays/new.json` is untracked at this moment and is exactly how a fixture gets created.
 *  Runs git from the TARGET's own directory, not the process cwd — this repo works in `.worktrees/`, which is
 *  itself gitignored, so a cwd-relative check would call a worktree path "ignored" and skip the refusal. */
function isRepoVisiblePath(p: string): boolean {
  const abs = resolve(p);
  // Walk up to the nearest EXISTING ancestor before asking git anything. `git -C <nonexistent>` exits 128,
  // and treating that as "not in a repo" failed OPEN on the most dangerous case there is: the first-ever
  // record into a new directory (`--out examples/replays/sub/x.json`), which is precisely how a fresh
  // fixture gets created. The target itself never exists yet, so the parent is always the starting point.
  let dir = dirname(abs);
  while (!existsSync(dir)) {
    const up = dirname(dir);
    if (up === dir) return false; // walked off the filesystem root — nothing to ask git about
    dir = up;
  }
  const inTree = spawnSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  // A git that is absent or erroring (status null / non-zero with no usable answer) is NOT evidence that the
  // path is safe. Only a definitive "false" — git ran and said this is not a work tree — clears the check.
  if (inTree.status === null) return true; // git missing/failed to spawn: fail CLOSED
  if (inTree.status !== 0) return false; // git ran and said "not a work tree"
  if (inTree.stdout.trim() !== "true") return false;
  const ignored = spawnSync("git", ["-C", dir, "check-ignore", "-q", abs], { encoding: "utf8" });
  // check-ignore: 0 = ignored, 1 = not ignored, 128 = error. Only a clean 0 clears it; an error means we
  // could not prove the path is ignored, so treat it as repo-visible.
  return ignored.status !== 0;
}

/** Resolve symlinks as far as the path EXISTS, keeping the not-yet-created tail. Needed because the
 *  containment test below compares against `git rev-parse --show-toplevel`, which always returns a
 *  REAL path: on macOS a perfectly in-tree `/var/folders/...` cassette would otherwise read as outside a
 *  `/private/var/folders/...` root and warn on every record. The planned cassette itself never exists
 *  yet, so resolving only the existing ancestor is the whole trick. */
function realish(p: string): string {
  let dir = resolve(p);
  const tail: string[] = [];
  while (!existsSync(dir)) {
    const up = dirname(dir);
    if (up === dir) return resolve(p); // walked off the root — nothing to canonicalize
    tail.unshift(dir.slice(up.length + 1));
    dir = up;
  }
  try {
    return join(realpathSync(dir), ...tail);
  } catch {
    return resolve(p);
  }
}

/** Is `p` at or under `root`? Pure lexical containment on already-resolved absolute paths. */
function insideRoot(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The tree a cassette and its references must share for the cassette to be portable: the git top-level
 *  containing `anchor`, else the cwd. Cwd — NOT the session file's own directory: the conventional layout
 *  puts `sessions/` and `cassettes/` as SIBLINGS, so anchoring on the session dir would warn on every
 *  default record in a non-git tree, and a warning that fires on the happy path is one nobody reads. */
function portabilityRoot(anchor: string | undefined): string {
  if (anchor) {
    let dir = dirname(resolve(anchor));
    while (!existsSync(dir)) {
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    if (existsSync(dir)) {
      const top = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
      if (top.status === 0 && top.stdout.trim()) return resolve(top.stdout.trim());
    }
  }
  return realish(process.cwd());
}

/**
 * Warn — BEFORE the paid run — when the cassette's stored references would have to climb out of the
 * project tree to reach their targets.
 *
 * What this is NOT: a check that the written cassette can resolve its own references. That check is
 * VACUOUS by construction — `resolve(dir, relative(dir, X)) === X`, so it always passes on the recording
 * machine and would never fire. The condition that actually predicts the failure is CLIMB-OUT: a
 * reference stored as `../../Users/you/...` resolves fine here and nowhere else, so the cassette is
 * uncommittable and unverifiable the moment it leaves this filesystem layout.
 *
 * Both directions matter, and only checking one is how the first draft of this missed half the defect:
 *   - cassette OUTSIDE the tree, session inside — the reported case (`--out /tmp/...`);
 *   - cassette inside, session OUTSIDE — an absolute or `~` session path, equally unresolvable.
 * Both reduce to the same test: the cassette dir and every stored reference must sit under one root.
 *
 * `~` MUST be expanded first. `parseScenarioFile` resolves a file-relative `session:` to absolute but
 * deliberately leaves `~/...` alone (see `isFileRelative`), and a raw `~/x` looks RELATIVE to
 * `path.relative`, which would resolve it under the cwd and silently conclude it is in-tree.
 *
 * A warning, not a refusal: recording outside the tree is legitimate for a throwaway cassette. The point
 * is that today nothing says so at any point where the author can still act.
 */
export function cassettePortabilityPreflight(
  scenario: Scenario,
  plannedCassettePath: string,
  scenarioSourceFile?: string,
): { kind: "ok" } | { kind: "warn"; message: string } {
  const refs: { name: string; path: string }[] = [];
  // `(inline)` is stored as the literal sentinel, never as a path — nothing to resolve, nothing to break.
  if (scenario.session !== "(inline)") refs.push({ name: "session", path: realish(expandUserPath(scenario.session)) });
  if (scenarioSourceFile) refs.push({ name: "scenarioSource", path: realish(scenarioSourceFile) });
  if (refs.length === 0) return { kind: "ok" };

  const cassetteDir = realish(dirname(resolve(plannedCassettePath)));
  const root = portabilityRoot(scenarioSourceFile ?? refs[0].path);
  const cassetteOut = !insideRoot(root, cassetteDir);
  const strays = refs.filter((r) => !insideRoot(root, r.path));
  if (!cassetteOut && strays.length === 0) return { kind: "ok" };

  const which = cassetteOut
    ? `the cassette would be written outside ${tildeify(root)}`
    : `${strays.map((r) => `\`${r.name}\` (${tildeify(r.path)})`).join(" and ")} ${strays.length > 1 ? "live" : "lives"} outside ${tildeify(root)}`;
  return {
    kind: "warn",
    message:
      `::warning:: [record] this cassette will not be portable — ${which}, so its stored references are ` +
      `written as paths that climb out of the tree and resolve only from this exact layout.
` +
      `  cassette: ${tildeify(cassetteDir)}
` +
      `  Consequence: verify-cassettes cannot resolve the skill dirs from it and reports 'unverifiable' ` +
      `for staleness (can't verify ⇒ not green, exit 3), and since 2.0.0 a bare replay fails too. Recover with --session <file>, or re-record at the final location.
` +
      `  Fix: record into the same tree as the scenario and its session, and decide that path BEFORE ` +
      `spending the run — a cassette cannot be moved afterwards.
`,
  };
}

/**
 * Decide whether a record may write a host-inheriting transcript to this path.
 *
 * REFUSE only for a path that is not already a committed cassette. Refusing an in-place refresh would break
 * this repo's own `--rerecord-stale` workflow on every host-inheriting fixture, and the predictable result is
 * that everyone passes the escape flag by reflex — turning the guard off exactly where it matters. For an
 * existing fixture we warn and let the Layer A scan hard-gate the RESULT at commit/CI time.
 */
export function hostInventoryPreflight(
  scenario: Scenario,
  plannedCassettePath: string,
  allowed: boolean,
): { kind: "ok" } | { kind: "warn"; message: string } | { kind: "refuse"; message: string } {
  if (allowed) return { kind: "ok" };
  if (!isHostInheritingRecord(scenario)) return { kind: "ok" };
  if (!isRepoVisiblePath(plannedCassettePath)) return { kind: "ok" };
  const tier = resolvePreflightTier(scenario);
  const why =
    `fidelity '${tier}' inherits the host environment, so the recording will freeze THIS machine's ` +
    `MCP servers, agents and account metadata into the cassette`;
  if (existsSync(plannedCassettePath)) {
    return {
      kind: "warn",
      message:
        `::warning:: [record] re-recording a repo-tracked cassette at ${tier}: ${why}. ` +
        `Verify with 'verify-cassettes' before committing — it fails on a host-inventory finding.\n`,
    };
  }
  // The FIX line is branch-aware, and deliberately no longer offers "--out a path outside the repo".
  // Two defects that advice caused, both reported by consumers:
  //  1. It trades a loud refusal for a SILENT worse state. A cassette's `session`/`scenarioSource` are
  //     stored relative to its own dir, so one written outside the tree can never resolve its skill dirs
  //     again — `verify-cassettes` reports `unverifiable-skill` ("can't verify ⇒ not green", exit 3) and
  //     only a re-record fixes it. Two paid runs were spent discovering that.
  //  2. "Record at container" is not universally available: a scenario asserting a HOSTLOOP_ONLY_KEYS key
  //     fails "cannot verify" on every other tier, so that branch would send exactly those authors in a
  //     circle. Read the set from assert.ts rather than restating it here — a hand list is how the
  //     previous advice rotted.
  const blocked = HOSTLOOP_ONLY_KEYS.filter((k) => (scenario.assert ?? []).some((a) => a[k] !== undefined));
  const fix = blocked.length
    ? `  Fix: this scenario asserts ${blocked.join(", ")}, which only evaluate at hostloop — 'container' is not ` +
      `available to it. Audit the session (personal MCP servers, plugins, account metadata) and re-run with ` +
      `--allow-host-inventory-fixture once you're satisfied the recording carries none.\n`
    : `  Fix: record at 'container' fidelity (sealed, HOME=/tmp) — it inherits nothing from this machine, so the ` +
      `cassette stays committable AND verifiable.\n`;
  return {
    kind: "refuse",
    message:
      `refusing to record into a repo-visible path at ${tier} — ${why}, and committing that publishes it.\n` +
      `  path: ${plannedCassettePath}\n` +
      fix +
      `  NOT a fix: redirecting --out outside the repo. The cassette stores its session/scenario references ` +
      `relative to its own directory, so one written outside the tree can never resolve them again — ` +
      `verify-cassettes reports it 'unverifiable' for staleness (can't verify ⇒ not green) and only a ` +
      `re-record recovers.\n` +
      `  Override with --allow-host-inventory-fixture if this session has no personal MCP servers or plugins.`,
  };
}

export function redactionPreflightMessage(items: Array<{ scenario: Scenario; policyDirs: string[] }>): string | null {
  const risky: string[] = [];
  for (const it of items) {
    const tier = resolvePreflightTier(it.scenario);
    if (tier !== "hostloop" && tier !== "protocol") continue;
    const policy = loadRedactionPolicy(it.policyDirs);
    if (policy.patterns.length === 0 && policy.keyNames.length === 0) risky.push(`${it.scenario.name} (${tier})`);
  }
  if (risky.length === 0) return null;
  return (
    `::warning:: record: recording at a host-path-bearing tier with NO redaction policy — ${risky.join(", ")}. ` +
    `The cassette will embed real host paths, and verify-cassettes' \`path\` scanner will HARD-FAIL them at commit time. ` +
    `Add a .cowork-redact.json (\`cowork-harness init-redact\` copies the reference template) or set ` +
    `COWORK_HARNESS_REDACT_PATTERNS. (The always-on privacy scanner remains the universal net — ` +
    `container-tier recordings can trip it too.)\n`
  );
}

/** Return the `artifact_json.artifact` paths a scenario asserts that ended up truncated by SIZE (body
 *  >cap, hash-only) — the genuine green-record/red-replay case whose remedy is "raise the cap". This
 *  EXCLUDES read-only connected-folder inputs: those are body-less by policy (not size), raising the cap
 *  can't capture them, and `artifact_json` against one already fails LOUD-and-symmetrically at record,
 *  verify-run, and replay (evidence-unavailable, see assert.ts) — so they are neither an asymmetry nor a
 *  "too large" problem. Paths are normalized through `resolve` so `./outputs/x.json` and `outputs/x.json`
 *  join cleanly against the manifest's walk paths. */
export function artifactJsonTargetsTruncated(scenario: Scenario, workRoot: string, artifacts: ManifestEntry[]): string[] {
  // Flag ONLY size-truncated entries (`truncationReason === "size"`) — the genuine green-record/red-replay
  // case whose remedy is "raise the cap". "readonly"/"unreadable" are excluded: raising the cap can't
  // capture them, and artifact_json against one already fails loud-and-symmetrically (evidence-unavailable,
  // assert.ts). (A pre-v8 entry with no reason is not flagged — this guard only runs at record time, where
  // buildManifest always sets the reason.)
  const truncatedAbs = new Set<string>();
  for (const a of artifacts) if (a.truncated && a.truncationReason === "size") truncatedAbs.add(resolve(workRoot, a.path));
  if (truncatedAbs.size === 0) return [];
  const hits: string[] = [];
  for (const a of scenario.assert ?? []) {
    // EVERY body-reading key, not just artifact_json: artifact_text has the identical green-record/
    // red-replay shape (it passes against the on-disk file at record and finds no body on replay), and
    // a deliverable big enough to be worth scanning for a leak is exactly the one that clears the cap.
    for (const target of [a.artifact_json?.artifact, a.artifact_text?.artifact]) {
      if (!target) continue;
      if (truncatedAbs.has(resolve(workRoot, target)) && !hits.includes(target)) hits.push(target);
    }
  }
  return hits;
}

/** Probe for an on-disk scenario file at the two conventional locations relative to a cassette.
 *  Sibling layout: <cassetteDir>/../scenarios/<name>.yaml (the standard multi-skill repo layout).
 *  Flat layout:    <cassetteDir>/<name>.yaml (single-dir layout).
 *  Returns the first found path, or null if neither exists.
 *  Exported as _findScenarioOnDisk for unit tests only; not part of the public API. */
/** resolve the scenario SOURCE file to re-record from, for `record --rerecord-stale`. PREFER the
 *  cassette's persisted `scenarioSource` (robust to an authored `name:` ≠ filename); fall back to the
 *  name-derived `_findScenarioOnDisk` probe. Returns the resolved path + how it was found (for the caller's
 *  warning when a persisted source has gone missing). Exported for unit tests; not part of the public API. */
export function _resolveRerecordSource(
  cassettePath: string,
  cassette: Pick<Cassette, "scenarioSource"> & { scenario: { name?: string } },
): { path: string | null; via: "persisted" | "name-lookup" | "none"; persistedMissing?: string } {
  if (cassette.scenarioSource) {
    const persisted = resolve(dirname(cassettePath), cassette.scenarioSource);
    if (existsSync(persisted)) return { path: persisted, via: "persisted" };
    // Persisted source recorded but now gone — fall back to the name lookup, signalling the miss.
    const fallback = _findScenarioOnDisk(cassettePath, cassette.scenario.name);
    return { path: fallback, via: fallback ? "name-lookup" : "none", persistedMissing: cassette.scenarioSource };
  }
  const fallback = _findScenarioOnDisk(cassettePath, cassette.scenario.name);
  return { path: fallback, via: fallback ? "name-lookup" : "none" };
}

export function _findScenarioOnDisk(cassettePath: string, scenarioName: string | undefined): string | null {
  if (!scenarioName) return null; // a lenient (nameless) cassette has no derivable scenario path
  const safeName = slugForPath(scenarioName);
  const cassetteDir = dirname(cassettePath);
  const candidates = [
    join(cassetteDir, "..", "scenarios", `${safeName}.yaml`),
    join(cassetteDir, "..", "scenarios", `${safeName}.yml`),
    join(cassetteDir, `${safeName}.yaml`),
    join(cassetteDir, `${safeName}.yml`),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return resolve(c);
  }
  return null;
}

/** Record one scenario FILE → one cassette (parses the file, then shares the live-record tail with the
 *  in-memory path). The file's dir feeds the redaction-policy search (for a co-located .cowork-redact.json). */
async function recordScenarioFile(
  file: string,
  opts: RecordOpts,
): Promise<{ result: RunResult; cassettePath: string; artifacts: number; delta?: string }> {
  // remember the authored scenario source file so the cassette can persist it (relocatable) for a
  // later `--rerecord-stale` that prefers it over a name-derived guess.
  return recordScenarioObject(parseScenarioFile(file), { ...opts, scenarioSourceFile: file }, [dirname(file)]);
}

// `record`'s accepted flags — hoisted to exported consts (not a function-local literal) so both
// `parseArgs` below AND the flag-coverage guard test (test/record-usage-guard.test.ts) read the SAME
// list. Two hand-maintained copies of this set drifted in both directions before (P3/F2): a flag added
// to one and not the other. Consuming the same const in both places makes that class of drift
// impossible for the FLAG SET; RECORD_USAGE below (the single sourced --help / usage-error text) is the
// other half — the guard test cross-checks the two.
export const RECORD_BOOLEAN_FLAGS = [
  "--no-redact",
  "--allow-failing",
  "--rerecord-stale",
  "--from-embedded",
  "--force",
  "--quiet",
  "--verbose",
  "--dry-run",
  "--decider-llm",
  "--allow-host-inventory-fixture",
] as const;
export const RECORD_VALUE_FLAGS = [
  "--out",
  "--output-format",
  "--max-artifact-bytes",
  "--decider-dir",
  "--intent",
  "--decider-model",
  "--on-unanswered",
  "--concurrency",
  "--max-budget-usd",
] as const;

// --- Flag-coverage guard registry (P9) -------------------------------------------------------------
//
// P3 built a record-only guard: RECORD_BOOLEAN_FLAGS/RECORD_VALUE_FLAGS (the flag SET) plus
// INTENTIONALLY_UNDOCUMENTED (a single global allowlist) plus RECORD_USAGE (the single-sourced text).
// P9 generalizes this to `replay` and `verify-cassettes`, which had the same two-hand-maintained-strings
// problem `record` had (see the RECORD_USAGE comment below) AND no coverage guard at all. Generalizing
// surfaced two things a record-only shape couldn't represent:
//   - `verify-cassettes` accepts SEVEN `repeated:` flags (`--allow`/`--allow-domain`/`--allow-email`/
//     `--allow-path`/`--allow-machine-inventory`/`--allow-host-inventory`/`--allow-patterns-file`, see cmdVerifyCassettes below).
//     `repeated` is NOT `values` — parseArgs (src/cli-args.ts) collects repeated flags into
//     `p.repeated[]` (every occurrence kept); a plain `values` flag is last-write-wins (every earlier
//     occurrence silently discarded). Folding `repeatedFlags` into `valueFlags` here would make the
//     GUARD correct while making the REAL parser wrong the moment someone "simplified" cmdVerifyCassettes
//     to match — so `repeatedFlags` is its own axis, not a variant of `valueFlags`.
//   - a single global allowlist silently over-exempts: `record`'s `--quiet` is FUNCTIONAL and documented
//     (suppresses the `--dry-run` preview, see cmdRecord below) while `replay`'s and `verify-cassettes`'
//     `--quiet` are parsed and never read — genuinely inert. A global list containing `--quiet` would
//     exempt record's real, documented flag from coverage as a side effect of exempting the other two
//     commands' dead one — so its documentation could vanish later without CI noticing. Allowlists are
//     per-command; see RECORD_ALLOWLIST / REPLAY_ALLOWLIST / VERIFY_CASSETTES_ALLOWLIST below.
//
// Not modeled here: `src/run/skill-flag-surface.ts` (SKILL_FLAG_SURFACE) also has a per-flag registry for
// `skill`, but it answers a DIFFERENT question — not "is this flag documented?" but "what does `critique`
// do with this `skill` flag when forwarding a spawned turn?" (forward-to-both-turns / forward-to-task-only
// / reject-with-reason / owned-by-critique). Doc coverage and forwarding disposition are orthogonal axes
// on different consumers (usage text vs. critique's spawn); keep them as two registries, not one merged
// shape — forcing `skill`'s forwarding semantics into this coverage-only shape (or vice versa) would blur
// what each one actually guards.

/** One flag in a per-command allowlist: accepted by the parser, deliberately left out of that command's
 *  usage text, with a REASON (so the exemption is a decision on record, not a silent gap). */
export interface UsageAllowlistEntry {
  readonly flag: string;
  readonly reason: string;
}

/** One row of the flag-coverage guard registry (test/usage-guard.test.ts). Mirrors a command's own
 *  `parseArgs` config (booleanFlags/valueFlags/repeatedFlags/aliases) plus its single-sourced usage text
 *  and allowlist, so the guard test can assert:
 *   1. every accepted flag is documented in `usage` or named in `allowlist` (coverage), and
 *   2. every `--flag` token IN `usage` is either an accepted flag or a declared exception (the reverse,
 *      phantom-flag check — catches a doc that tells a user to pass a flag the parser rejects, which is
 *      exactly the `--best-effort-future-cassette` bug this generalization was written to fix).
 *  `aliases` is carried for parity with `parseArgs`'s own config (so this registry mirrors the real
 *  parser, not a hand-simplified view of it); none of the three commands' usage text mentions a short
 *  alias today, so it does not currently feed either check above. */
export interface UsageGuardEntry {
  readonly command: string;
  readonly booleanFlags: readonly string[];
  readonly valueFlags: readonly string[];
  readonly repeatedFlags: readonly string[];
  readonly aliases: Readonly<Record<string, string>>;
  readonly usage: string;
  readonly allowlist: readonly UsageAllowlistEntry[];
}

// Deliberate no-op: accepted for flag consistency with `run`/`skill`/`replay` but not (yet) wired up in
// `record` (the renderer plan is fixed — --verbose has nothing extra to show). Contrast --quiet, which IS
// wired up (suppresses only the --dry-run preview block, see cmdRecord) and so IS documented in
// RECORD_USAGE below, not allowlisted. Excluded from the flag-coverage guard on purpose — do NOT add a
// flag here just to silence the guard; document it in RECORD_USAGE instead.
export const RECORD_ALLOWLIST: readonly UsageAllowlistEntry[] = [
  {
    flag: "--verbose",
    reason:
      "accepted for flag consistency with run/skill/replay; record's renderer plan is fixed so there is nothing extra for it to show — inert here.",
  },
];

// Single-sourced `record` usage text — used for BOTH `record --help` (src/cli.ts's SUBCOMMAND_USAGE.record)
// and the no-positional usage error below. Previously two hand-maintained strings that drifted in both
// directions (--max-budget-usd/--decider-model missing from --help; --dry-run missing from the usage
// error).
//
// UNIFICATION DECISION (P9, applies to RECORD_USAGE / REPLAY_USAGE / VERIFY_CASSETTES_USAGE alike): of
// the two options — (a) both `--help` and the usage error print the SAME full multi-line string, or
// (b) a short USAGE + a long HELP that provably starts with it — this file picks (a) for all three
// commands. Reasons: `record` already shipped (a) and it works; `--help` and "you passed no target" are
// not meaningfully different audiences here (both want the full flag list, not a one-liner pointing
// at `--help`); and (b) would need its own "HELP starts with USAGE" pinning test to keep the two from
// re-drifting, which is exactly the kind of second guard this generalization exists to avoid adding.
// `replay` and `verify-cassettes` are unified onto (a) below, replacing the two independently-drifted
// copies each one had (cli.ts's was already a superset for `replay`; `verify-cassettes`' two copies had
// textually diverged --margins prose — the cli.ts wording is kept as the single source).
export const RECORD_USAGE =
  "usage: record <scenario.yaml | dir/> [--out <file>] [--output-format text|json] [--rerecord-stale] [--from-embedded] [--force] [--no-redact] [--allow-failing] [--max-artifact-bytes <n>] [--dry-run] [--concurrency <N>] [--max-budget-usd <x>] [--allow-host-inventory-fixture]\n" +
  "       --allow-host-inventory-fixture: proceed when recording at protocol/hostloop into a repo-visible path. Those tiers inherit the host env, so the cassette would freeze THIS machine's MCP servers/agents/account into a committed fixture; the record is refused by default. Use only when the session has no personal MCP servers or plugins.\n" +
  "       --concurrency <N>: record a dir/ batch (or --rerecord-stale) N at a time (default 1, max 8). Runs are fully isolated; the bound is for Docker address pool + API rate limits.\n" +
  "       --max-budget-usd <x>: refuse before spending if prior-run history says this scenario (or, on a batch, the whole batch) has cost more than x.\n" +
  "                             At --concurrency 1 a running total also stops the batch once x is reached; above that it is a pre-flight estimate only.\n" +
  '       answer gates LIVE: [--decider-dir <dir>] (single scenario only) | [--decider-llm [--intent "<one line>"] [--decider-model <id>]] | [--on-unanswered fail|first]\n' +
  "       (a live decider flags the cassette non-deterministic — re-recording may drift; replay stays deterministic. --rerecord-stale rejects these flags.)\n" +
  "       --quiet: suppress the --dry-run readiness/scenario preview block (✗ broken:/skipped: lines and exit codes are unaffected).\n" +
  "       NOTE: --allow-failing only relaxes the post-run VERDICT gate; it does NOT salvage an unanswered gate (that throws before any cassette is written — use --on-unanswered first / a decider).";

/** `record <scenario.yaml | dir> [--out <file>] [--rerecord-stale] [--no-redact] [--allow-failing]` —
 *  run live + save a cassette. A single file records one; a dir batches; --rerecord-stale treats
 *  the dir as committed cassettes and re-records only those whose fingerprint drifted. */
export async function cmdRecord(args: string[]) {
  // Computed up front (isJsonOutput, not a bare p.options read) so every error path — including a
  // parseArgs throw before options are known — emits the shared JSON error envelope in JSON mode.
  const asJson = isJsonOutput(args);
  let p;
  try {
    p = parseArgs(args, {
      // --quiet suppresses only the --dry-run preview block (see below); --verbose remains a no-op
      // (renderer plan is fixed). Both flag SETS are the exported RECORD_BOOLEAN_FLAGS/RECORD_VALUE_FLAGS
      // consts above — do not fork this list back into a local literal (that's the drift P3 fixed).
      booleans: [...RECORD_BOOLEAN_FLAGS],
      values: [...RECORD_VALUE_FLAGS],
      noDashValue: ["--out", "--decider-dir"],
      enums: { "--output-format": ["text", "json"], "--on-unanswered": ["fail", "first"] },
      // no `-V`: verbose is long-only everywhere (`-v` is version at the top level; the A3 shift-key-typo fix).
      aliases: { "-q": "--quiet" },
    });
  } catch (e) {
    return fail("record", "usage", (e as Error).message, undefined, asJson);
  }
  let maxArtifactBytes: number | undefined;
  const mab = p.options["--max-artifact-bytes"];
  if (mab !== undefined) {
    const n = parseMaxArtifactBytes(mab);
    if (n === null) {
      return fail("record", "usage", `record: --max-artifact-bytes must be a positive integer (got ${mab})`, undefined, asJson);
    }
    maxArtifactBytes = n;
  }
  const noRedact = p.flags["--no-redact"] ?? false;
  const allowHostInventoryFixture = p.flags["--allow-host-inventory-fixture"] ?? false;
  if (noRedact) log("record: --no-redact — content redaction is OFF; the cassette is written verbatim, so ensure inputs are synthetic.");
  const allowFailing = p.flags["--allow-failing"] ?? false;
  const force = p.flags["--force"] ?? false;
  const fromEmbedded = p.flags["--from-embedded"] ?? false; // --rerecord-stale: allow re-recording from the embedded snapshot when no on-disk source resolves
  const rerecordStale = p.flags["--rerecord-stale"] ?? false;
  // Live-decider flags: answer gates during the recording instead of pre-scripting them.
  const deciderDir = p.options["--decider-dir"];
  const deciderLlm = p.flags["--decider-llm"] ?? false;
  const intent = p.options["--intent"];
  const deciderModel = p.options["--decider-model"];
  const onUnansweredOpt = p.options["--on-unanswered"] as OnUnanswered | undefined;
  // `--help` presents these as alternatives (`--decider-dir | --decider-llm | --on-unanswered`) and they
  // are: buildDecider takes `opts.external ?? <policy terminal>`, so with a channel the policy terminal is
  // never constructed and the flag is inert. Accepting both silently discarded whichever the user meant.
  if (deciderDir !== undefined && onUnansweredOpt !== undefined)
    return fail(
      "record",
      "usage",
      `--on-unanswered ${onUnansweredOpt} conflicts with --decider-dir (the channel IS the terminal, so the policy would never apply). Drop one.`,
      undefined,
      asJson,
    );
  // Bounded batch parallelism (dir-batch / --rerecord-stale). Each record is already fully isolated per run
  // (unique sidecar networks + proxy, per-session run dir), so concurrency is safe — the bound exists to stay
  // under Docker's address pool + model API rate limits. Default 1 (sequential, ordered output).
  let concurrency = 1;
  const concRaw = p.options["--concurrency"];
  if (concRaw !== undefined) {
    const n = Number(concRaw);
    if (!Number.isInteger(n) || n < 1 || n > MAX_RECORD_CONCURRENCY) {
      return fail(
        "record",
        "usage",
        `record: --concurrency must be an integer 1..${MAX_RECORD_CONCURRENCY} (got ${concRaw})`,
        undefined,
        asJson,
      );
    }
    concurrency = n;
  }
  // `--max-budget-usd`: a cost cap for the paid path. Pre-flight only — there is no live cost signal to
  // abort a single run on (see budget.ts) — so on a batch this is a cumulative estimate from history plus,
  // at --concurrency 1 only, a running total between scenarios.
  let maxBudgetUsd: number | undefined;
  const budgetRaw = p.options["--max-budget-usd"];
  if (budgetRaw !== undefined) {
    const n = Number(budgetRaw);
    if (!Number.isFinite(n) || n <= 0) {
      return fail("record", "usage", `record: --max-budget-usd requires a positive number (got "${budgetRaw}")`, undefined, asJson);
    }
    maxBudgetUsd = n;
  }
  const target = p.positionals[0];
  if (!target) {
    return fail("record", "usage", RECORD_USAGE, undefined, asJson);
  }
  if (p.positionals.length > 1) {
    return fail(
      "record",
      "usage",
      `record takes a single scenario or dir (got ${p.positionals.length}: ${p.positionals.join(", ")})`,
      undefined,
      asJson,
    );
  }
  const isDir = existsSync(target) && statSync(target).isDirectory();
  // `--out` names ONE cassette; it has no meaning for a directory batch — reject rather than silently ignore.
  if (isDir && p.options["--out"] !== undefined) {
    return fail("record", "usage", "record: --out names a single cassette file and is not valid for a directory batch", undefined, asJson);
  }

  // Live-decider validation. Reuse the run/skill rules; reject ambiguous/unsupported combos
  // up front so a paid record never starts under a mis-specified policy.
  if (intent !== undefined && !deciderLlm) {
    return fail(
      "record",
      "usage",
      "record: --intent requires --decider-llm (it states the test intent for the model answering live questions)",
      undefined,
      asJson,
    );
  }
  if (deciderModel !== undefined && !deciderLlm) {
    return fail(
      "record",
      "usage",
      "record: --decider-model requires --decider-llm (it sets the model that answers live questions)",
      undefined,
      asJson,
    );
  }
  if (deciderLlm && deciderDir !== undefined) {
    return fail(
      "record",
      "usage",
      "record: --decider-llm and --decider-dir are mutually exclusive terminals (a model vs a driving agent). Drop one.",
      undefined,
      asJson,
    );
  }
  if (deciderLlm && onUnansweredOpt !== undefined) {
    return fail(
      "record",
      "usage",
      `record: --decider-llm conflicts with --on-unanswered ${onUnansweredOpt} (it forces the model terminal). Drop one.`,
      undefined,
      asJson,
    );
  }
  // --rerecord-stale re-records committed cassettes at the DEFAULT policy; a live decider there is undefined.
  if (rerecordStale && (deciderDir !== undefined || deciderLlm || onUnansweredOpt !== undefined)) {
    return fail(
      "record",
      "usage",
      "record: --rerecord-stale cannot be combined with --decider-dir/--decider-llm/--on-unanswered (it re-records existing cassettes at the default policy)",
      undefined,
      asJson,
    );
  }
  // --decider-dir answers ONE interactive run in-band; a directory batch would interleave gates across N
  // cassettes on a single channel — bad UX. Restrict to a single scenario. (--decider-llm has no human, so a
  // batch is fine.)
  if (deciderDir !== undefined && isDir) {
    return fail(
      "record",
      "usage",
      "record: --decider-dir answers a single interactive recording; use it with one scenario, not a directory batch",
      undefined,
      asJson,
    );
  }
  // --concurrency only applies to a batch (dir-batch or --rerecord-stale over a dir); a single scenario has
  // nothing to parallelize. (--decider-dir is already dir-rejected above, so it can't co-occur with a batch.)
  if (concurrency > 1 && !isDir) {
    return fail(
      "record",
      "usage",
      "record: --concurrency applies to a directory batch (or --rerecord-stale <dir>); a single scenario records one cassette",
      undefined,
      asJson,
    );
  }

  const dryRun = p.flags["--dry-run"] ?? false;

  if (dryRun) {
    // Conflict guard: --dry-run + --rerecord-stale is undefined — dry-run of a stale re-record
    // has no clear semantics (it would need to select stale cassettes, which requires real FS work).
    if (rerecordStale) {
      return fail("record", "usage", "record: --dry-run and --rerecord-stale cannot be combined", undefined, asJson);
    }

    // `--quiet` suppresses only this preview block (below) — never the ✗ broken:/skipped: diagnostics
    // (P5's hard constraint: muting the loader check's only useful output would gut the feature) and
    // never an exit code. It's a NO-OP outside --dry-run (record's other paths don't print a preview).
    const quiet = p.flags["--quiet"] ?? false;

    // This whole block is a RECORDING-READINESS PREVIEW, not a verdict on this dry run: token/agent are
    // irrelevant to --dry-run by construction (it never spends or spawns the agent), so their absence
    // here does NOT mean anything failed. Worded to read as "informational" rather than "broken" in a CI
    // log — a stale ✗-prefixed MISSING line, on a token-free check, used to read as a failure there.
    const token = realProbe.hasToken();
    const agent = realProbe.agentBinary();
    const tokenLine = token
      ? "  token:  found (would be used by a real, non-dry-run record)"
      : "  token:  (absent — fine for --dry-run; only a real record needs CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN)";
    const agentLine = agent.ok
      ? `  agent:  ${agent.path} (would be used by a real, non-dry-run record)`
      : `  agent:  (unresolved — fine for --dry-run; only a real record needs it — ${agent.error.split("\n")[0]})`;
    const agentPayload = agent.ok ? { ok: true as const, path: agent.path } : { ok: false as const, error: agent.error };

    if (isDir) {
      const disc = discoverScenarios(target);
      // Scenario-level refusals, per file. A dry run over N scenarios exists to learn about all N in one
      // pass, so this collects EVERY offender instead of failing at the first — aborting early turns a
      // 24-scenario preflight into 24 sequential round trips, which is the same cost the refusal exists
      // to avoid. Both checks are pure functions over the parsed scenario, i.e. free.
      //
      // `promptPolicyRejection` has always run in the single-file arm below and never here, so a batch
      // dry run greened a scenario the real `record` refuses per-scenario (recordScenarioObject). Adding
      // the contradiction check without it would have left an arbitrary split: batch dry-run enforcing
      // one scenario-level refusal but not its sibling.
      const parsedNames: string[] = [];
      const refusals: { file: string; message: string }[] = [];
      for (const f of disc.scenarios) {
        let sc;
        try {
          sc = parseScenarioFile(f);
        } catch {
          continue; // already classified as `broken` by discoverScenarios
        }
        parsedNames.push(sc.name);
        const why = promptPolicyRejection(sc) ?? assertContradiction(sc);
        if (why) refusals.push({ file: f, message: why });
      }
      // Free by construction (a run-history lookup), so it is reported whether or not a cap was passed.
      const estimate = estimateBatchCost(parsedNames);
      if (asJson) {
        out(
          jsonPayloadEnvelope("record", refusals.length === 0 && disc.broken.length === 0, {
            dryRun: true,
            target,
            scenarios: disc.scenarios,
            skipped: disc.skipped,
            broken: disc.broken,
            refusals,
            estimatedCostUsd: estimate.known,
            unpricedScenarios: estimate.unpriced,
            // The basis for `estimatedCostUsd`, so automation need not treat it as a bound. It is
            // `sum(max(local run history))` — see `batchCostEstimateLine`.
            estimateBasis: { source: "local-run-index", pricedRuns: estimate.pricedRuns, thinnestScenarioRuns: estimate.thinnest ?? 0 },
            token,
            agent: agentPayload,
          }),
        );
      } else {
        for (const s of disc.skipped) log(`· skipped: ${s}`);
        for (const b of disc.broken) log(`✗ broken: ${b.file}: ${b.error}`);
        // `--quiet` mutes the readiness PREVIEW only; a refusal is the loud half of "silent on success,
        // loud on failure" and must survive it, exactly as `broken:` does.
        for (const r of refusals) log(`✗ refused: ${r.file}: ${r.message}`);
      }
      if (disc.scenarios.length === 0) {
        if (disc.broken.length === 0) {
          if (!asJson) log(`record --dry-run: no scenarios discovered under ${target}`);
          // Exit 2 for "nothing discovered at all" — matches the non-dry-run batch path. The JSON payload
          // envelope was ALREADY emitted above; this is a status-only exit, so no error envelope here.
          return process.exit(2); // cli-error-envelope-exempt: dry-run payload envelope already emitted above
        }
        // Broken files found but no valid scenarios — exit 1 (broken, not nothing).
        return process.exit(1); // cli-error-envelope-exempt: dry-run payload envelope already emitted above
      }
      if (!asJson && !quiet) {
        log(`record --dry-run: ${disc.scenarios.length} scenario(s) in ${target}`);
        for (let i = 0; i < disc.scenarios.length; i++) log(`  [${i + 1}] ${disc.scenarios[i]}`);
        log(tokenLine);
        log(agentLine);
        log(`  ${batchCostEstimateLine(parsedNames, estimate)}`);
      }
      // The budget gate runs under --dry-run too, and refuses identically. A dry run whose whole job is
      // "tell me what this would do before I spend" must not report clean and then be refused for real —
      // that is a false preview, and it is free to check (history lookup, no spend).
      if (maxBudgetUsd !== undefined) {
        preflightBatchBudget("record", parsedNames, maxBudgetUsd, asJson);
        // Part of the preview: the cap is weaker than it looks above --concurrency 1, and the reader
        // deserves to learn that here rather than after spending.
        if (concurrency > 1) warn(CONCURRENCY_BUDGET_CAVEAT(concurrency));
      }
      // Exit 1 when there are broken files (they won't run but the user should know) or refused ones
      // (they parse, but no run could satisfy them — the real `record` would reject each in turn).
      return process.exit(disc.broken.length > 0 || refusals.length > 0 ? 1 : 0);
    }

    // Single scenario dry-run.
    let scenario;
    try {
      scenario = parseScenarioFile(target);
    } catch (e) {
      return fail("record", "usage", `record --dry-run: cannot parse scenario: ${(e as Error).message}`, undefined, asJson);
    }
    const promptReject = promptPolicyRejection(scenario);
    if (promptReject) return fail("record", "usage", promptReject, undefined, asJson);
    // Same rule as promptPolicyRejection directly above, and as the budget gate below: a refusal the
    // real `record` would raise has to raise here too, or this preview is false. Pure and spend-free.
    const contradiction = assertContradiction(scenario);
    if (contradiction) return fail("record", "usage", contradiction, undefined, asJson);
    // mirror the EXACT default cassette path recordScenarioObject uses (slugForPath via the shared
    // defaultCassettePath helper) so a name with spaces/separators reports the same path it writes.
    const cassettePath = p.options["--out"] ?? defaultCassettePath(scenario.name);
    if (asJson) {
      out(
        jsonPayloadEnvelope("record", true, {
          dryRun: true,
          target,
          scenario: scenario.name,
          fidelity: scenario.fidelity,
          cassette: cassettePath,
          token,
          agent: agentPayload,
        }),
      );
    } else if (!quiet) {
      log("record --dry-run");
      log(`  scenario: ${scenario.name}`);
      log(`  file:     ${target}`);
      if (scenario.fidelity) log(`  fidelity: ${scenario.fidelity}`);
      log(`  cassette: ${cassettePath}`);
      log(tokenLine);
      log(agentLine);
    }
    // Part of the preview for the same reason the budget gate is: a rehearsal whose whole job is "tell me
    // what this would do before I spend" must surface the thing that cannot be undone afterwards. `target`
    // IS the scenario source here, so the reference root resolves exactly as it will on the real record.
    const dryPort = cassettePortabilityPreflight(scenario, cassettePath, target);
    if (dryPort.kind === "warn") warn(dryPort.message);
    // See the dir branch above: the budget gate is part of the preview, not skipped by it.
    if (maxBudgetUsd !== undefined) preflightBudget("record", scenario.name, maxBudgetUsd, asJson);
    return process.exit(0);
  }

  // Auth guard: fail with a clear message if no model token is present.
  // In-Docker containers cannot read the macOS Keychain; the error would otherwise
  // surface as result:"error" + empty stderr after the agent spawns.
  // Note: --dry-run bypasses this guard (dry-run branch exits before reaching here).
  if (!(process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)) {
    return fail(
      "record",
      "runtime",
      "record: no model credentials — set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN " +
        "(in-Docker the macOS Keychain is not accessible; run `cowork-harness doctor` for full diagnostics)",
      undefined,
      asJson,
    );
  }

  // Shared live-decider opts for the dir-batch and single-scenario record paths. (--rerecord-stale is
  // excluded above, so it never sees these.) A plain `record` leaves every field undefined → no behavior change.
  const liveDecider: Pick<RecordOpts, "onUnanswered" | "llmIntent" | "llmModel" | "deciderChannel"> = {
    onUnanswered: deciderLlm ? "llm" : onUnansweredOpt,
    llmIntent: deciderLlm ? intent : undefined,
    llmModel: deciderLlm ? deciderModel : undefined,
    deciderChannel: deciderDir !== undefined ? "decider-dir" : deciderLlm ? "decider-llm" : undefined,
  };

  // re-record only the drifted cassettes in a committed cassette dir.
  if (rerecordStale) {
    if (!isDir) {
      return fail("record", "usage", "record --rerecord-stale takes a DIRECTORY of committed cassettes", undefined, asJson);
    }
    const stale = selectStaleCassettes(target);
    if (stale.length === 0) {
      log(`✓ record --rerecord-stale: all cassettes under ${target} are fresh — nothing to re-record`);
      return process.exit(0);
    }
    const staleTotal = stale.length;
    // Budget pre-flight for the whole re-record batch, BEFORE the first spawn — a refusal that fires
    // after items 1..N-1 are already paid for is not a pre-flight. Names come from each cassette's
    // frozen scenario (the stale set is cassettes, not YAML).
    const staleNames: string[] = [];
    for (const { path: cp } of stale) {
      const rc = readCassette(cp);
      if (!("error" in rc)) staleNames.push(rc.cassette.scenario.name);
    }
    if (maxBudgetUsd !== undefined) {
      preflightBatchBudget("record", staleNames, maxBudgetUsd, asJson);
      if (concurrency > 1) warn(CONCURRENCY_BUDGET_CAVEAT(concurrency));
    }
    const staleBudget = batchBudgetTracker(maxBudgetUsd, concurrency === 1);
    let staleSkipped = 0;
    // ONE redaction preflight for the whole re-record batch, before the first spawn (same rationale
    // as the dir-batch path below). Policy dirs per item = cwd + the cassette's own dir (its write target).
    if (!noRedact) {
      const preflightItems: Array<{ scenario: Scenario; policyDirs: string[] }> = [];
      for (const { path: cp } of stale) {
        const rc = readCassette(cp);
        if (!("error" in rc)) preflightItems.push({ scenario: rc.cassette.scenario, policyDirs: [process.cwd(), dirname(cp)] });
      }
      const preflight = redactionPreflightMessage(preflightItems);
      if (preflight) warn(preflight);
    }
    // Each item targets a DISTINCT committed cassette path (`cassettePath: cp`), so a parallel re-record can
    // never collide on output. Runs are fully isolated (unique sidecar networks/proxy per run), so the only
    // bound is --concurrency. Output lines are index-tagged so interleaved completions stay readable.
    const outcomes = await pMapBounded(stale, concurrency, async ({ path: cp, staleness }, i) => {
      const tag = `[${i + 1}/${staleTotal}]`;
      if (staleBudget.stopped()) {
        staleSkipped++;
        log(`  · ${tag} ${cp} SKIPPED — --max-budget-usd reached; this cassette was NOT re-recorded and stays stale`);
        return true; // not a failure: an incomplete batch, same framing as the run --repeat lane
      }
      const rc = readCassette(cp);
      if ("error" in rc) {
        log(`  ✗ ${tag} ${cp}: ${rc.error} — cannot re-record`);
        return false;
      }
      const cassette = rc.cassette;
      // PREFER the persisted authored-source path (robust to an authored `name:` ≠ filename — the
      // name-based probe misses that and would re-record the embedded snapshot, silently dropping edits).
      const src = _resolveRerecordSource(cp, cassette);
      if (src.persistedMissing)
        log(
          `  ⚠ ${tag} persisted scenario source "${src.persistedMissing}" not found — falling back to name lookup for "${cassette.scenario.name}"`,
        );
      const diskScenario = src.path;
      log(`${tag} ↻ re-recording ${cp} (stale: ${staleness.join("; ")})`);
      try {
        let r: { result: RunResult };
        if (diskScenario) {
          // re-record from the on-disk scenario YAML so any edits (e.g. added `skills:`) take effect.
          r = await recordScenarioFile(diskScenario, {
            noRedact,
            allowFailing,
            cassettePath: cp,
            maxArtifactBytes,
            skipRedactionPreflight: true,
            allowHostInventoryFixture,
          });
        } else if (!fromEmbedded) {
          // No on-disk scenario resolved. Re-recording from the embedded snapshot silently DROPS any edits
          // to the scenario YAML (the user believes stale cassettes were refreshed from edited YAML, but the
          // old snapshot was replayed into a new cassette) — so this is a HARD FAILURE by default. Pass
          // `--from-embedded` to intentionally re-record standalone cassettes from their embedded snapshot.
          log(
            `  ✗ ${tag} no on-disk scenario found for "${cassette.scenario.name}" — refusing to re-record from the embedded snapshot (edits to the scenario YAML would be silently dropped). ` +
              `Pass the scenario file directly (\`record <scenario.yaml>\`), or --from-embedded to re-record from the embedded snapshot on purpose.`,
          );
          return false;
        } else {
          // --from-embedded: explicitly re-record from the embedded snapshot (edits to the YAML won't apply).
          log(`  ⚠ ${tag} --from-embedded: re-recording "${cassette.scenario.name}" from the embedded snapshot (YAML edits won't apply)`);
          const sessionRef = cassette.scenario.session === "(inline)" ? "(inline)" : join(dirname(cp), cassette.scenario.session);
          r = await recordScenarioObject(
            { ...cassette.scenario, session: sessionRef },
            { noRedact, allowFailing, cassettePath: cp, maxArtifactBytes, skipRedactionPreflight: true, allowHostInventoryFixture },
          );
        }
        staleBudget.add(budgetFields(r.result).costUsd);
        log(`  ✓ ${tag} ${cp} (${r.result.result})`);
        return true;
      } catch (e) {
        log(`  ✗ ${tag} ${cp}: ${recordErrorText(e)}`);
        return false;
      }
    });
    const failures = outcomes.filter((ok) => !ok).length;
    const staleSummary = staleBudget.summary(staleTotal - staleSkipped, staleTotal);
    if (staleSummary) warn(staleSummary + "\n");
    return process.exit(failures > 0 ? 1 : 0);
  }

  // batch a directory of scenarios.
  if (isDir) {
    const disc = discoverScenarios(target);
    for (const s of disc.skipped) log(`· skipped (not a scenario — no \`prompt:\`): ${s}`);
    for (const b of disc.broken) log(`✗ ${b.file}: ${b.error}`);
    if (disc.scenarios.length === 0) {
      return fail(
        "record",
        "usage",
        `record: no scenarios discovered under ${target} (loud non-zero — not a vacuous "0 failures = green")`,
        undefined,
        asJson,
      );
    }
    // Guard: two scenarios whose `name:` slugifies to the SAME default cassette path would clobber each other
    // (last-wins sequentially; a write RACE under --concurrency). Detect up front and fail loud — applies at
    // any concurrency since the sequential clobber is itself a latent bug. (`--out` is dir-rejected above, so
    // every item uses its default path.)
    const targets = new Map<string, string>();
    const dupes: string[] = [];
    for (const f of disc.scenarios) {
      let cp: string;
      try {
        cp = defaultCassettePath(parseScenarioFile(f).name);
      } catch {
        continue; // unparseable here would have been classified `broken`; let the record path report it
      }
      const prev = targets.get(cp);
      if (prev) dupes.push(`${f} ↔ ${prev} → ${cp}`);
      else targets.set(cp, f);
    }
    if (dupes.length) {
      return fail(
        "record",
        "usage",
        `record: ${dupes.length} scenario(s) share a cassette output path (their \`name:\` slugifies identically) — would clobber/race; give them distinct \`name:\`:\n` +
          dupes.map((d) => `  ✗ ${d}`).join("\n"),
        undefined,
        asJson,
      );
    }

    const total = disc.scenarios.length;
    // Budget pre-flight for the whole batch, BEFORE the first spawn — same rationale as the redaction
    // preflight below and as `run`'s dir sweep: a refusal that spends money before refusing is not one.
    if (maxBudgetUsd !== undefined) {
      const names: string[] = [];
      for (const f of disc.scenarios) {
        try {
          names.push(parseScenarioFile(f).name);
        } catch {
          /* unparseable → classified `broken`; the record path reports it */
        }
      }
      preflightBatchBudget("record", names, maxBudgetUsd, asJson);
      if (concurrency > 1) warn(CONCURRENCY_BUDGET_CAVEAT(concurrency));
    }
    const batchBudget = batchBudgetTracker(maxBudgetUsd, concurrency === 1);
    let batchSkipped = 0;
    // ONE redaction preflight for the whole batch, BEFORE the first spawn — a per-scenario warning under
    // pMapBounded would fire for scenario N after 1…N−1 already paid, and a shared empty policy would
    // emit N interleaved duplicates. Same policy search set as each scenario's own record path.
    if (!noRedact) {
      const preflightItems: Array<{ scenario: Scenario; policyDirs: string[] }> = [];
      for (const f of disc.scenarios) {
        try {
          const sc = parseScenarioFile(f);
          preflightItems.push({ scenario: sc, policyDirs: [process.cwd(), dirname(f), dirname(defaultCassettePath(sc.name))] });
        } catch {
          /* unparseable → the record path reports it below */
        }
      }
      const preflight = redactionPreflightMessage(preflightItems);
      if (preflight) warn(preflight);
    }
    // Runs are fully isolated (unique sidecar networks/proxy per run, per-session run dir), so concurrency is
    // safe; --concurrency only bounds it (Docker address pool + API rate limits). Index-tag the lines so
    // interleaved completions stay readable.
    const outcomes = await pMapBounded(disc.scenarios, concurrency, async (f, i) => {
      const tag = `[${i + 1}/${total}]`;
      if (batchBudget.stopped()) {
        batchSkipped++;
        log(`  · ${tag} ${f} SKIPPED — --max-budget-usd reached; no cassette was written for it`);
        return true; // not a failure: an incomplete batch, same framing as the run --repeat lane
      }
      log(`${tag} recording ${f}…`);
      try {
        const r = await recordScenarioFile(f, {
          noRedact,
          allowFailing,
          maxArtifactBytes,
          skipRedactionPreflight: true,
          allowHostInventoryFixture,
          ...liveDecider,
        });
        batchBudget.add(budgetFields(r.result).costUsd);
        log(`  ✓ ${tag} → ${r.cassettePath} (${r.result.result})`);
        // the re-record delta (only present when this overwrote a prior cassette) — see describeBehaviourDelta
        if (r.delta) log(`    ${r.delta}`);
        return true;
      } catch (e) {
        log(`  ✗ ${tag} ${recordErrorText(e)}`);
        return false;
      }
    });
    const failures = disc.broken.length + outcomes.filter((ok) => !ok).length;
    const batchSummary = batchBudget.summary(total - batchSkipped, total);
    if (batchSummary) warn(batchSummary + "\n");
    log(
      failures > 0
        ? `✗ record: ${failures} of ${disc.scenarios.length + disc.broken.length} failed`
        : batchSkipped > 0
          ? `✓ record: ${total - batchSkipped} cassette(s), ${batchSkipped} skipped on budget`
          : `✓ record: ${disc.scenarios.length} cassette(s)`,
    );
    return process.exit(failures > 0 ? 1 : 0);
  }

  // Single scenario file. Budget pre-flight BEFORE the spawn — identical semantics to `run`'s single-run
  // gate (worst observed cost from this scenario's own history; loud degradation when it has none).
  if (maxBudgetUsd !== undefined) {
    try {
      preflightBudget("record", parseScenarioFile(target).name, maxBudgetUsd, asJson);
    } catch (e) {
      return fail("record", "usage", `record: cannot parse scenario: ${(e as Error).message}`, undefined, asJson);
    }
  }
  // `--decider-dir` opens an in-band file rendezvous for the driving agent; close it after the run
  // (mirrors `run`'s one-channel lifecycle).
  const channel = deciderDir !== undefined ? fileChannel(deciderDir) : undefined;
  try {
    const cassettePath = p.options["--out"];
    const r = await recordScenarioFile(target, {
      noRedact,
      allowFailing,
      force,
      cassettePath,
      maxArtifactBytes,
      allowHostInventoryFixture,
      externalChannel: channel,
      ...liveDecider,
    });
    if (asJson) out(jsonEnvelope("record", [r.result], { extra: { artifacts: r.artifacts, cassette: r.cassettePath } }));
    else {
      log(`✓ recorded ${r.result.result} · ${r.artifacts} artifact(s) → ${r.cassettePath}`);
      if (r.delta) log(`  vs the cassette it replaced: ${r.delta}`);
    }
  } catch (e) {
    return fail("record", "usage", `record: ${recordErrorText(e)}`, undefined, asJson, 1);
  } finally {
    channel?.close?.();
  }
}

/** Build the cassette `authoring` provenance stamp. Returns undefined for a deterministic
 *  record (no live-decider decision actually fired — `result.nonDeterministic` is usage-based, so a
 *  present-but-unused decider leaves it false); otherwise flags non-determinism + the channel that authored
 *  it. Pure → unit-testable without a live run. Exported for tests; not part of the public API. */
export function cassetteAuthoring(nonDeterministic: boolean | undefined, channel?: "decider-dir" | "decider-llm"): Cassette["authoring"] {
  return nonDeterministic ? { nonDeterministic: true, channel } : undefined;
}

/** Null out `preRunHashes` entries for paths whose artifact body was secret-scrubbed at record time.
 *  A scrubbed body's committed sha256 no longer matches the raw pre-run hash — left alone, replay's
 *  `input_unmodified` would compare the two and report a FALSE "modified in place" for a file the agent
 *  never touched. Nulling the entry makes that path report evidence-unavailable instead (loud, never a
 *  false verdict). Pure → unit-testable without a live run. Returns the map unchanged (same reference) when
 *  nothing needs nulling; `nulledPaths` is the subset actually present (and not already null) in
 *  `preRunHashes`, used to drive the record-time warning. */
export function nullOutScrubbedPreRunHashes(
  preRunHashes: Record<string, string | null> | undefined,
  scrubbedPaths: string[],
): { hashes: Record<string, string | null> | undefined; nulledPaths: string[] } {
  if (!preRunHashes || !scrubbedPaths.length) return { hashes: preRunHashes, nulledPaths: [] };
  const nulledPaths = scrubbedPaths.filter((p) => Object.hasOwn(preRunHashes, p) && preRunHashes[p] !== null);
  if (!nulledPaths.length) return { hashes: preRunHashes, nulledPaths: [] };
  const out = { ...preRunHashes };
  for (const p of nulledPaths) out[p] = null;
  return { hashes: out, nulledPaths };
}

/** The live-record TAIL shared by the file (batch/single) and in-memory (re-record) paths: run live, refuse
 *  a failing run unless opted in, snapshot + secret-scrub bodies, opt-in redact + verdict-preserve,
 *  then write. `extraPolicyDirs` adds the scenario-file dir to the .cowork-redact.json search. */
/** `on_unanswered: prompt` blocks on a TTY. `run` rejects it outright (it breaks determinism), and
 *  `record`'s own `--on-unanswered` enum excludes `prompt` for the same reason — but the SCENARIO field
 *  outranks the flag (`scenario.on_unanswered ?? opts.onUnanswered` in executeScenario), so the enum
 *  alone left the YAML door open on the command that writes a COMMITTED fixture. Returns the rejection
 *  message, or undefined when the scenario is recordable. */
export function promptPolicyRejection(scenario: Scenario): string | undefined {
  return scenario.on_unanswered === "prompt"
    ? `scenario "${scenario.name}" sets on_unanswered: prompt — rejected on \`record\` (a TTY wait can't produce a deterministic committed fixture). Use fail|first, or a decider channel.`
    : undefined;
}

async function recordScenarioObject(
  scenario: Scenario,
  opts: RecordOpts,
  extraPolicyDirs: string[] = [],
): Promise<{ result: RunResult; cassettePath: string; artifacts: number; delta?: string }> {
  // Same guard as the --dry-run path, on the funnel every real record passes through (dir batches and
  // --rerecord-stale never touch the dry-run branch).
  const promptReject = promptPolicyRejection(scenario);
  if (promptReject) throw new Error(promptReject);
  // Redaction preflight — MUST fire BEFORE the (paid) agent spawn below; the historical policy-load
  // point after the live run is exactly the after-the-fact discovery this exists to prevent. Same search
  // set as the post-run load. `--no-redact` skips it (explicit known-synthetic opt-out); the batch paths
  // skip it here because they preflight once for the whole batch (skipRedactionPreflight).
  if (!opts.skipRedactionPreflight && !opts.noRedact) {
    const plannedCassettePath = opts.cassettePath ?? defaultCassettePath(scenario.name);
    const preflight = redactionPreflightMessage([
      { scenario, policyDirs: [process.cwd(), ...extraPolicyDirs, dirname(plannedCassettePath)] },
    ]);
    if (preflight) warn(preflight);
  }
  // Host-inventory preflight — ALSO before the paid spawn. A host-inheriting tier freezes the recording
  // machine's own inventory into the transcript, so writing that to a repo-tracked path publishes the
  // operator's tool stack (this has happened). Refusing after the run would be strictly worse: the tokens
  // are already spent and the tempting fix is to commit it anyway.
  {
    const plannedCassettePath = opts.cassettePath ?? defaultCassettePath(scenario.name);
    const verdict = hostInventoryPreflight(scenario, plannedCassettePath, opts.allowHostInventoryFixture === true);
    if (verdict.kind === "refuse") return fail("record", "usage", verdict.message, undefined, isJsonOutput(process.argv)) as never;
    if (verdict.kind === "warn") warn(verdict.message);
    // Portability — also pre-spend, and for the same reason: after the run the tokens are gone and the
    // only remedy is to spend them again at the right path.
    const port = cassettePortabilityPreflight(scenario, plannedCassettePath, opts.scenarioSourceFile);
    if (port.kind === "warn") warn(port.message);
  }
  // Thread the live-decider opts. All undefined for a plain `record` → identical to the
  // previous opt-less call (executeScenario defaults onUnanswered to scenario.on_unanswered ?? "fail").
  const result = await executeScenario(scenario, {
    command: "record",
    onUnanswered: opts.onUnanswered,
    // record's `onUnanswered` is already explicit-only (`p.options["--on-unanswered"]`, undefined when
    // the flag is absent), unlike run's resolved `policy` — so the same value serves both roles here.
    onUnansweredFlag: opts.onUnanswered,
    externalChannel: opts.externalChannel,
    llmIntent: opts.llmIntent,
    llmModel: opts.llmModel,
  });
  // Provenance: stamp from the RESULT, not the flag. result.nonDeterministic (execute.ts) is
  // usage-based — true only if a decision actually came back by:"llm"|"external"|"human"|"first". So a
  // present-but-unused --decider-dir (scripted answers covered every gate) stays deterministic and is NOT
  // stamped. The cassette still REPLAYS deterministically (frozen answers); we only flag re-record drift.
  const authoring = cassetteAuthoring(result.nonDeterministic, opts.deciderChannel);
  if (authoring) {
    warn(
      `::warning:: record: cassette authored via ${opts.deciderChannel ?? "a live decider"} (≥1 gate answered live) — ` +
        `re-recording may drift. The cassette itself replays deterministically (answers are frozen).\n`,
    );
  }
  const safeName = slugForPath(scenario.name);
  // shared default-path helper (slugForPath) — identical to the `record --dry-run` report.
  const cassettePath = opts.cassettePath ?? defaultCassettePath(scenario.name);
  if (!opts.cassettePath) containedPath("cassettes", `${safeName}.cassette.json`); // path traversal guard
  mkdirSync(dirname(cassettePath), { recursive: true });
  // a failing live run frozen into a cassette is a latent false-signal — refuse unless opted in.
  // separate the run RESULT from the VERDICT (they're distinct — the run can succeed while an assertion
  // or parity check fails) and name which check failed, instead of the misleading "did NOT pass (result=success)".
  const liveVerdict = computeVerdict(result, "live");
  if (!liveVerdict.pass && !opts.allowFailing) {
    const why = liveVerdict.signals
      .filter((s) => s.severity === "fail")
      .map((s) => `${s.code}: ${s.message}`)
      .join("; ");
    throw new Error(
      `refusing to freeze a failing run: run result=${result.result}, but the live verdict FAILED — ${why} (re-run, or --allow-failing)`,
    );
  }
  // RELOCATABLE session path (relative to the cassette dir) — metadata-only, keeps a moved bundle honest.
  const relocatable: Scenario = {
    ...scenario,
    session: scenario.session === "(inline)" ? "(inline)" : relative(dirname(cassettePath), scenario.session),
  };
  // buildManifest reads output bodies RAW (executeScenario scrubs result/events/control-out, NOT
  // outputs/) — secret-scrub each body before it is committed.
  const secrets = collectSecrets();
  // Text bodies are scrubbed in-place. Base64 (binary) bodies cannot be scrubbed with plain
  // `scrub` — text-substitution corrupts the bytes and then false-fails the replay-time sha256 verify.
  // Instead use `scrubField`, which whole-field-decodes first: if the decoded content contains a secret
  // (covering the base64(prefix+TOKEN+suffix) case), the entire body is replaced with a redaction marker,
  // `encoding` is cleared (marker is plain text), and sha256 is recomputed so replay verification stays
  // intact. Artifact assertions on a redacted binary body will fail at replay — the ::warning:: flags this.
  // Snapshot under the run's REAL user-visible roots (outputs + resolved folder mount names), persisted
  // below as cassette.userVisibleRoots so replay matches — not the legacy hardcoded `.projects/` prefix.
  const recordRoots = result.userVisibleRoots ?? ["outputs", ".projects"];
  // Read-only connected-folder inputs are captured body-less (path + sha256, no body) — see buildManifest's
  // `bodyLessPrefixes` doc comment. `recordRoots`/`cassette.userVisibleRoots` stay the FULL set; only the
  // captured bodies under these prefixes are stripped.
  const rawManifest = result.workDir
    ? buildManifest(result.workDir, opts.maxArtifactBytes, recordRoots, result.readonlyFolderRoots ?? [])
    : [];
  const artifacts = rawManifest.map((a) => {
    if (a.body === undefined) return a;
    if (a.encoding === "base64") {
      const scrubbed = scrubField(a.body, secrets);
      if (scrubbed === a.body) return a;
      warn(
        `::warning:: record: artifact "${a.path}" contains a secret in base64-encoded content — ` +
          `body replaced with redaction marker; artifact_json/user_visible_artifact assertions on this artifact will fail at replay\n`,
      );
      // Recompute sha256 over the marker bytes (utf8) so materializeManifest's verify passes:
      // decodeBody reads encoding-undefined as utf8, matching this hash.
      const newSha256 = createHash("sha256").update(Buffer.from(scrubbed, "utf8")).digest("hex");
      return { ...a, body: scrubbed, encoding: undefined, sha256: newSha256 };
    }
    // Also apply scrubField to utf8 bodies: safe because scrubField calls scrub first and the
    // whole-field base64 branch only fires when the entire value is a pure base64 blob — ordinary
    // text passes through unchanged. This closes the gap for text artifacts whose content is
    // itself a base64(prefix+TOKEN+suffix) blob (e.g. a .txt file containing an encoded credential).
    const scrubbed = scrubField(a.body, secrets);
    if (scrubbed === a.body) return a;
    // The body changed (a literal secret was replaced inline, or the whole field was an encoded blob
    // swapped for a [REDACTED:*] marker). `a.sha256` was computed over the RAW pre-scrub bytes
    // (buildManifest, ~219), so it is now stale — recompute over the scrubbed utf8 bytes (mirror the
    // base64 branch above), otherwise replay's materializeManifest verify throws "body does not match
    // its recorded sha256". encoding is already undefined on this branch, so the spread keeps it.
    if (scrubbed === "[REDACTED:base64]" || scrubbed === "[REDACTED:uri]") {
      // Whole-field marker replacement destroys the deliverable CONTENT, so only the assertions that
      // READ the body fail at replay: `artifact_json` (parses it) and `artifact_text` (matches it).
      //
      // `user_visible_artifact` and `file_exists` still PASS — they check location and existence, and the
      // marker is written to disk with a recomputed sha256. `materializeManifest`'s doc comment in this
      // same file already says so. The warning previously named `user_visible_artifact`, which invited the
      // reading that a passing visibility assertion proves the scrubbed content survived. It proves only
      // that a file is there. (Inline literal scrubs leave the rest of the body intact, so they stay silent.)
      warn(
        `::warning:: record: artifact "${a.path}" contains a secret in whole-field encoded content — ` +
          `body replaced with redaction marker; artifact_json/artifact_text assertions on this artifact will fail at replay ` +
          `(user_visible_artifact/file_exists still PASS — they check location, not content)\n`,
      );
    }
    const newSha256 = createHash("sha256").update(Buffer.from(scrubbed, "utf8")).digest("hex");
    return { ...a, body: scrubbed, sha256: newSha256 };
  });
  // Record-time scrub divergence guard: any bodied artifact whose sha256 CHANGED above (the scrub pass
  // recomputed it over scrubbed bytes) had its content redacted — its committed sha256 no longer matches
  // the raw pre-run hash. Left alone, `preRunHashes[p]` would still be the raw hash and replay's
  // input_unmodified would compare it against the (different) scrubbed manifest sha256 and report a FALSE
  // "modified in place" for a file the agent never touched. Body-less entries are unaffected (never
  // scrubbed — sha256 stays the raw on-disk hash, `artifacts[i].sha256 === rawManifest[i].sha256`).
  const scrubbedPaths = rawManifest.filter((raw, i) => artifacts[i]!.sha256 !== raw.sha256).map((raw) => raw.path);
  const { hashes: preRunHashes, nulledPaths } = nullOutScrubbedPreRunHashes(result.preRunHashes, scrubbedPaths);
  // Gate the warning to when it's actually actionable: only fire when THIS scenario asserts
  // `input_unmodified` with a glob matching at least one nulled path — mirrors how the replay-side
  // loud-exclude warnings (nufExcludedLoudly/iumExcludedLoudly, above) check `scenario.assert.some(...)`
  // rather than warning unconditionally on every scrub. A scenario with no `input_unmodified` assertion
  // has no use for this warning; noise on every secret-scrubbed recording would drown out the signal.
  if (nulledPaths.length) {
    const affectsInputUnmodified = scenario.assert.some(
      (a) =>
        a.input_unmodified !== undefined &&
        nulledPaths.some((p) => anyGlobMatches(Array.isArray(a.input_unmodified) ? a.input_unmodified : [a.input_unmodified!], p)),
    );
    if (affectsInputUnmodified) {
      warn(
        `::warning:: record: pre-run hash nulled for secret-scrubbed path(s): ${nulledPaths.join(", ")} — ` +
          `content was redacted at record time; input_unmodified will report evidence-unavailable for these paths on replay\n`,
      );
    }
  }
  // if an `artifact_json` targets an artifact we had to truncate, it passes here (on-disk) but FAILS
  // replay (no committed body). Surface that record→replay asymmetry NOW, at its cause, instead of letting a
  // green record produce a red replay in CI. Honor --allow-failing (warn, don't block) like the verdict gate.
  if (result.workDir) {
    const truncatedAsserted = artifactJsonTargetsTruncated(scenario, result.workDir, artifacts);
    if (truncatedAsserted.length) {
      const cap = opts.maxArtifactBytes ?? defaultBodyCap();
      const msg =
        `assert targets artifact(s) too large to commit (>${cap} B, stored hash-only): ${truncatedAsserted.join(", ")} — ` +
        `this passes at record (on-disk) but FAILS replay (no body). Raise --max-artifact-bytes / ` +
        `COWORK_HARNESS_MAX_ARTIFACT_BYTES, or assert a smaller artifact.`;
      if (opts.allowFailing) warn(`::warning:: record: ${msg}\n`);
      else throw new Error(msg);
    }
  }
  const timelineRaw = readTimeline(result.outDir);
  // Record only a CLEAN timeline — a corrupt header or malformed entry lines is evidence-unavailable, so
  // recording `timeline: []` / `timelineHeader: undefined` would bake a novel "ran, no activity" shape into
  // the cassette instead of the honest "no timeline" (undefined) a corrupt read should produce. #43
  const timeline = timelineRaw && timelineRaw.malformedLines === 0 && !timelineRaw.headerCorrupt ? timelineRaw : undefined;
  // Load the baseline to extract agentBinaryFormat if available (optional).
  let agentBinaryFormat: string | undefined;
  try {
    const baseline = loadBaseline(result.baseline);
    agentBinaryFormat = baseline.agentBinary.format;
  } catch {
    // Baseline failed to load — proceed without agentBinaryFormat (it's optional).
  }
  // The STAMPED version — the minimum a reader needs to interpret THIS scenario, not the build's max
  // (CASSETTE_VERSION). Nearly every scenario (lane: local/omitted) stamps v10, unchanged (P8).
  const stampedVersion = requiredVersionFor(relocatable);
  // Read once — the decision stream feeds both the cassette body and the label-provenance stamp below.
  const recordedControlOut = safeLines(join(result.outDir, "control-out.jsonl"));
  const base: Cassette = {
    $schema: cassetteSchemaUrl(stampedVersion),
    generator: "cowork-harness",
    cassetteVersion: stampedVersion,
    scenario: relocatable,
    events: safeLines(join(result.outDir, "events.jsonl")),
    controlOut: recordedControlOut,
    effectiveFidelity: result.effectiveFidelity,
    artifacts,
    userVisibleRoots: recordRoots,
    // (v8: no cassette-level readonlyFolderRoots — the read-only reason rides per-entry on
    // ManifestEntry.truncationReason, set by buildManifest above from RunResult.readonlyFolderRoots.)
    // co-present with userVisibleRoots by construction — a cassette carrying preRunPaths never hits
    // replay's legacy-roots fallback.
    preRunPaths: result.preRunPaths,
    preRunOrigin: result.preRunOrigin, // baseline provenance — replay fails evidence-unavailable on a non-local-walk baseline
    // Nulled (not `result.preRunHashes` verbatim) for any path whose artifact body was secret-scrubbed
    // above — see the scrubbedPaths/nullOutScrubbedPreRunHashes block.
    preRunHashes,
    // persist the authored scenario source file RELATIVE to the cassette dir (relocatable, no
    // absolute host path) so `--rerecord-stale` re-records from the edited YAML even when name ≠ filename.
    scenarioSource: opts.scenarioSourceFile ? relative(dirname(cassettePath), opts.scenarioSourceFile) : undefined,
    // Persist the RUN-TIME fingerprint (computed by execute.ts WITH the resolved baseline object, so it
    // carries promptAssetsHash) rather than recomputing here without the object — a recompute would
    // silently drop promptAssetsHash. The `??` fallback only fires for a result that never carried one.
    // Label provenance is stamped HERE, not in buildFingerprint: it needs `controlOut` (the emitted gate
    // options), which only exists after the run. See stampLabelProvenance for why it scans the DELIVERED
    // dirs rather than the hashed set.
    fingerprint: withLabelProvenance(
      result.fingerprint ?? buildFingerprint(scenario.session, result.baseline, undefined, scenario.skills),
      recordedControlOut,
      scenario.session,
    ),
    authoring,
    timeline: timeline?.events,
    timelineHeader: timeline?.header,
    // v9: session-shape fingerprint (Finding 23) — undefined for an inline/unresolvable session, exactly
    // like `fingerprint`'s own skillHash-less case; `sessionFingerprintDrift` treats undefined as
    // "not checked" (never a false mismatch).
    sessionFingerprint: buildSessionFingerprint(scenario.session, undefined),
    // v9: record-time connected-folder host-path -> mount-name map (Finding 24) — undefined when the
    // zip against `recordRoots` doesn't line up (inline scenario, no folders, unreadable session);
    // replay then treats this as a v9 cassette that unexpectedly lacks the map (Finding 25).
    folderPrefixMap: buildRecordTimeFolderPrefixMap(scenario, recordRoots),
    // Recording environment provenance — see buildEnvironmentProvenance (pure, offline-testable).
    // The image is stamped ONLY for the tiers whose capabilities actually come from it: execute.ts
    // routes `container`/`hostloop` to `probeImageOmitted` (the agent image) and `microvm` to
    // `probeMicrovmOmitted` (the Lima guest), so those two are exactly the tiers where the image
    // decides missingCapabilityUse and therefore the verdict. Stamping it elsewhere would record an
    // image that had no bearing on the run. Keep this predicate in step with that one.
    environment: buildEnvironmentProvenance(
      result.effectiveFidelity,
      agentBinaryFormat,
      result.effectiveFidelity === "container" || result.effectiveFidelity === "hostloop"
        ? resolveAgentImageProvenance(resolveContainerRuntime(), resolveAgentImage())
        : undefined,
    ),
  };
  // (opt-in) content redaction over the whole surface. Empty policy → no-op. Non-empty → must be
  // VERDICT-PRESERVING: replay both and refuse to write on divergence (a manufactured green).
  const policy = opts.noRedact
    ? { patterns: [], keyNames: [] }
    : loadRedactionPolicy([process.cwd(), ...extraPolicyDirs, dirname(cassettePath)]);
  let cassette = base;
  if (policy.patterns.length || policy.keyNames.length) {
    const redacted = redactCassette(base, policy);
    await assertRedactionVerdictPreserved(base, redacted, dirname(cassettePath));
    cassette = redacted;
  }
  // Slug-collision guard (findings 19/20): a DEFAULT path is derived from `slugForPath(scenario.name)`, so
  // two DIFFERENT scenario names that slugify identically would silently clobber the same cassette. Refuse to
  // overwrite when the existing cassette on the default path was recorded for a DIFFERENT scenario name (a
  // routine same-scenario re-record — or a moved scenario, same name — is unaffected). `--out`/`--force` opt out.
  if (!opts.cassettePath && !opts.force && existsSync(cassettePath)) {
    try {
      const existing = JSON.parse(readFileSync(cassettePath, "utf8")) as { scenario?: { name?: string } };
      const existingName = existing.scenario?.name;
      if (existingName && existingName !== scenario.name)
        throw new Error(
          `refusing to overwrite ${cassettePath}: it belongs to scenario "${existingName}", but this record is "${scenario.name}" ` +
            `(their names slugify to the same default path — pass --out <file> to disambiguate, or --force to overwrite).`,
        );
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("refusing to overwrite")) throw e;
      /* an unreadable/malformed existing cassette is not a collision signal — let the write proceed */
    }
  }
  // Behaviour delta vs the cassette this one REPLACES. Re-recording is the only moment where "did my edit
  // change what the agent does?" is observable at all — replay re-checks a frozen transcript and is
  // structurally blind to it. Without this the answer is discarded every time: you pay for a re-record and
  // get an opaque new blob. A real corpus lost weeks to a skill that silently stopped asking its gates,
  // found eventually by diffing an old cassette against a new one BY HAND.
  //
  // Read BEFORE the write (the file is about to be overwritten) and buffer in memory — never a `.bak`,
  // which would become a committed-artifact and privacy question. Recorded only on an overwrite; a first
  // record has no prior to compare. Best-effort: an unreadable prior is simply no delta, never an error —
  // this is a reporting nicety appended to a successful record, and must not turn one into a failure.
  const priorSummary = existsSync(cassettePath) ? behaviourSummaryOfFile(cassettePath) : undefined;

  // RECORD-TIME PRIVACY SCAN. Scanned AFTER redaction, deliberately: redaction is the mechanism that is
  // supposed to remove this, so scanning the pre-redaction bytes would quarantine recordings that are clean.
  // The policy itself lives in `classifyRecordLeak` so it is testable without a paid run.
  const leak = classifyRecordLeak(cassette, cassettePath, opts.allowHostInventoryFixture === true);
  if (leak.kind === "override") {
    warn(
      `::warning:: [record] host inventory PRESENT in the recording, written anyway because ` +
        `--allow-host-inventory-fixture was passed:\n${leak.detail}`,
    );
  } else if (leak.kind === "outside-repo") {
    warn(
      `::warning:: [record] this recording carries THIS MACHINE's inventory. Its path is not repo-visible, ` +
        `so it is not quarantined — but do NOT copy it into a repo:\n${leak.detail}`,
    );
  } else if (leak.kind === "quarantine") {
    const q = quarantineCassette(cassette, scenario.name, cassettePath, scenario.fidelity, leak.detail, new Date().toISOString());
    throw new Error(
      `refusing to write ${cassettePath}: this recording carries THIS MACHINE's inventory, and that path is ` +
        `inside a git repo — committing it would publish your own tool stack.\n${leak.detail}\n` +
        `The recording was NOT discarded (you paid for it). It is quarantined at:\n  ${q.path}\n  ${q.path}.findings.txt\n` +
        (q.fellBack
          ? `  (the runs root is inside a git repo, so this fell back to the OS temp dir — quarantining into ` +
            `another committable location would be pointless.)\n`
          : "") +
        `Fix it by re-recording at a SEALED tier (--fidelity container), or from an environment without your ` +
        `personal MCP servers/agents configured. If this inventory is genuinely part of the fixture, re-run ` +
        `with --allow-host-inventory-fixture.`,
    );
  }

  writeFileAtomic(cassettePath, JSON.stringify(cassette, null, 2)); // atomic — no partial cassette on a mid-write crash
  const delta = priorSummary ? describeBehaviourDelta(priorSummary, behaviourSummary(cassette)) : undefined;
  return { result, cassettePath, artifacts: artifacts.length, delta };
}

/** The behavioural dimensions worth reporting across a re-record. Deliberately small and structural: these
 *  are the things whose CHANGE means the skill behaves differently, as opposed to the model rewording
 *  itself (which changes on every re-record and would make the delta pure noise). `gates` leads because a
 *  skill that stops asking is the regression this exists to surface. */
export interface BehaviourSummary {
  gates: number;
  toolCalls: number;
  artifacts: number;
}

/** Count the AskUserQuestion gates a cassette recorded. Sourced from `controlOut` (the decision stream),
 *  where an answered gate appears as a control_response whose `updatedInput` carries `questions[]` — the
 *  same shape the replay decision pipeline reads. A cassette without controlOut reports 0 gates, which is
 *  indistinguishable from "no gates fired"; that ambiguity is why the delta line says "0 → 2" rather than
 *  claiming a regression. */
export function behaviourSummary(cassette: Pick<Cassette, "controlOut" | "events" | "artifacts">): BehaviourSummary {
  let gates = 0;
  for (const raw of cassette.controlOut ?? []) {
    try {
      const e = typeof raw === "string" ? JSON.parse(raw) : raw;
      const qs = e?.response?.response?.updatedInput?.questions;
      if (Array.isArray(qs) && qs.length) gates += 1;
    } catch {
      /* a malformed controlOut line is another check's finding, not this one's */
    }
  }
  let toolCalls = 0;
  for (const raw of cassette.events ?? []) {
    try {
      const e = typeof raw === "string" ? JSON.parse(raw) : raw;
      const blocks = e?.message?.content;
      if (Array.isArray(blocks)) for (const b of blocks) if (b?.type === "tool_use") toolCalls += 1;
    } catch {
      /* ditto */
    }
  }
  return { gates, toolCalls, artifacts: (cassette.artifacts ?? []).length };
}

function behaviourSummaryOfFile(path: string): BehaviourSummary | undefined {
  try {
    return behaviourSummary(JSON.parse(readFileSync(path, "utf8")) as Cassette);
  } catch {
    return undefined; // unreadable prior ⇒ no delta; never fail a successful record over a reporting extra
  }
}

/** Render the delta, or state explicitly that behaviour is unchanged. Silence would be ambiguous between
 *  "nothing moved" and "nobody looked" — the distinction this whole feature exists to make. */
export function describeBehaviourDelta(before: BehaviourSummary, after: BehaviourSummary): string {
  const parts: string[] = [];
  const d = (label: string, a: number, b: number) => {
    if (a !== b) parts.push(`${label} ${a} → ${b}`);
  };
  d("gates", before.gates, after.gates);
  d("tool calls", before.toolCalls, after.toolCalls);
  d("artifacts", before.artifacts, after.artifacts);
  return parts.length ? parts.join(", ") : "no behavioural change (transcript wording only)";
}

/** A synthetic `result:"error"` RunResult for an unreadable/invalid cassette in a directory replay — so
 *  the JSON envelope's `ok` (results.every(pass)) turns false and can never report ok:true alongside a
 *  non-zero exit (the cardinal no-false-green rule). */
function replayErrorResult(file: string): RunResult {
  return assembleRunResult({
    turn: undefined, // replay reconstructs one recorded run; no multi-turn attribution
    command: "replay", // #48
    lane: undefined, // unreadable cassette — no scenario to read a lane from
    scratchpadEvidenceComplete: false, // no run happened; nothing was observed
    referencesRead: undefined, // synthetic error result for an unreadable cassette — no re-drive, nothing to derive
    ablated: undefined, // replay reconstructs a recorded run; ablation is a live-run control
    runLabel: undefined, // run-identity metadata is a LIVE-run property; a replay has no record-time label
    skillCommit: undefined,
    scenario: file,
    fidelity: "replay",
    baseline: "",
    result: "error",
    finalMessage: undefined, // truncated/error cassette — no re-drive, no result text
    decisions: [],
    egress: [],
    assertions: [],
    outDir: "",
    durationMs: 0,
    $schema: undefined,
    generator: undefined,
    mode: "run",
    execution: undefined, // cassette unreadable/invalid — no environment provenance recoverable
    prompt: undefined,
    resultErrorKind: undefined,
    errorSource: undefined, // no rec to read from on this early-bail lane
    resultSubtype: undefined, // (same — no result event to read a subtype from)
    stderrLogPath: undefined, // live path only — no live process on replay
    stalledOnQuestion: undefined,
    capabilityProbe: undefined,
    requiresCapabilityUnmet: undefined,
    toolCounts: undefined,
    webSearches: undefined,
    infraErrors: undefined,
    evidenceErrors: undefined,
    toolDurations: undefined,
    skillActivity: undefined,
    models: undefined,
    thinking: undefined,
    thinkingElided: undefined,
    toolErrors: undefined,
    modelUsage: undefined,
    redundantToolCalls: undefined,
    gateDeliveries: undefined,
    subagents: undefined,
    nonReproducibleAnswers: undefined,
    usage: undefined,
    cost: undefined,
    fingerprint: undefined,
    workDir: undefined,
    outputsDir: undefined,
    userVisibleRoots: undefined,
    readonlyFolderRoots: undefined,
    artifacts: undefined,
    workspaceFiles: undefined, // no live filesystem to scan on replay (see the doc note in execute.ts)
    contextEvents: undefined, // no rec to read from on this early-bail lane
    mcpErrors: undefined, // live-only — this early-bail lane never drives a session
    hookEvents: undefined, // no rec to read from on this early-bail lane
    fileToolAttempts: undefined, // no rec to read from on this early-bail lane
    pathDenials: undefined, // no rec to read from on this early-bail lane
    presentedFiles: undefined, // no rec to read from on this early-bail lane
    preRunPaths: undefined,
    preRunLinkAware: undefined,
    preRunHashes: undefined,
    preRunOrigin: undefined,
    partial: undefined,
    unansweredGate: undefined,
    nonDeterministic: undefined,
    nonDeterministicTerminal: undefined,
    permissiveAutoAllow: undefined,
    scan: undefined,
    effectiveFidelity: undefined,
    fidelityWarnings: undefined,
    staleness: undefined,
    mutation: undefined, // the protocol-error stub carries no mutation report
    skippedAssertions: undefined,
    toolResults: undefined,
    l0PluginDivergence: undefined,
    missingCapabilityUse: undefined,
    gateProvenance: undefined,
    skillsInvoked: undefined,
    skillToolAvailable: undefined,
    tasks: undefined,
    context: undefined,
    resources: undefined,
    outcome: undefined, // derived from `verdict`; absent for the same reason it is
    verdict: undefined, // synthetic early-bail error result for an unreadable cassette — no assertions were evaluated to derive one from; the JSON envelope's own live-computed Verdict (envelope.ts) covers this on stdout
  });
}

/** Single source of truth for which scenario fields `recordingShapingDrift` compares, in the canonical
 *  order used everywhere the set is presented ("/"-joined). Every message that enumerates the drift set —
 *  the `--reassert`/`--assert-from` `::notice::` below, `replay`'s `--help` usage string (src/cli.ts), and
 *  `replay`'s own doc comment above `cmdReplay` — derives from this list so it cannot drift a fourth time
 *  (P6: two of those three sites were already stale before `lane` was added).
 *
 *  `execution` is DELIBERATELY absent: it has exactly one legal value today (`cloud-describe` is a
 *  load-time error, see src/types.ts), so no on-disk sibling can ever differ from a frozen recording on it
 *  and the check could never fire. Add it here when a second `execution` value (a cloud runner) ships. */
export const RECORDING_SHAPING_FIELDS = ["prompt", "baseline", "fidelity", "lane", "answers", "skills", "requires_capabilities"] as const;

const normRecordingShapingValue = (v: unknown) => JSON.stringify(v ?? null);

/** Recording-shaping fields that MUST still match the recording for on-disk assertions to be evaluated
 *  against the frozen events soundly.
 *
 *  NOTE on symmetry: `frozen` is the cassette's `scenario`, parsed by `readCassette` through a `z.looseObject`
 *  PASSTHROUGH (CassetteShape) — NOT the full `Scenario` schema — so it carries whatever was serialized at
 *  record time and does NOT get fresh Zod defaults. `onDisk` IS fully `Scenario.parse`d. We bridge that
 *  asymmetry with `?? default` per field (so an absent `answers`/`baseline`/`skills` on either side normalizes
 *  to the same default), which is exact for prompt/baseline/skills/empty-answers. RESIDUAL LIMITATION: a
 *  non-empty `answers` array whose nested `AnswerRule` defaults differ between record-time and the current
 *  schema could produce a spurious drift hard-fail; re-record closes it. (Cassettes are written from a parsed
 *  scenario, so in practice both sides already carry the same post-Zod shape.)
 *
 *  Covers every field in `RECORDING_SHAPING_FIELDS` — the authored fields that shape what the recording is,
 *  including `lane` (it conditions assertion outcomes, src/assert.ts, so a lane-flipped sibling must hard-fail
 *  like the rest — P6). `session` is DELIBERATELY excluded: the cassette stores it relative-to-cassette-dir
 *  while parseScenarioFile resolves it absolute, so a string-equal would never match (it'd brick every sessioned
 *  scenario); and the session is already baked into the frozen events with no cheap content hash to compare. Skill
 *  *content* drift is policed separately (failOnSkillDrift on the opt-in path) — and only when a skill fingerprint
 *  was recorded; the caller warns when it wasn't. */
const RECORDING_SHAPING_CHECKS: Record<(typeof RECORDING_SHAPING_FIELDS)[number], (frozen: Scenario, onDisk: Scenario) => boolean> = {
  prompt: (frozen, onDisk) => (frozen.prompt ?? "") === (onDisk.prompt ?? ""),
  baseline: (frozen, onDisk) => (frozen.baseline ?? "latest") === (onDisk.baseline ?? "latest"),
  fidelity: (frozen, onDisk) => (frozen.fidelity ?? "container") === (onDisk.fidelity ?? "container"),
  lane: (frozen, onDisk) => (frozen.lane ?? "local") === (onDisk.lane ?? "local"),
  answers: (frozen, onDisk) => normRecordingShapingValue(frozen.answers ?? []) === normRecordingShapingValue(onDisk.answers ?? []),
  skills: (frozen, onDisk) => normRecordingShapingValue(frozen.skills ?? []) === normRecordingShapingValue(onDisk.skills ?? []),
  requires_capabilities: (frozen, onDisk) =>
    normRecordingShapingValue(frozen.requires_capabilities ?? []) === normRecordingShapingValue(onDisk.requires_capabilities ?? []),
};

function recordingShapingDrift(frozen: Scenario, onDisk: Scenario): string[] {
  return RECORDING_SHAPING_FIELDS.filter((key) => !RECORDING_SHAPING_CHECKS[key](frozen, onDisk));
}

/** Scenario-content drift for `verify-cassettes`: has the committed on-disk scenario's PROMPT diverged from
 *  the cassette's frozen copy? The fingerprint covers skill-dir content + baseline but NOT the scenario's own
 *  prompt, so an edited-but-not-re-recorded prompt silently diverges — invisible to `replay`/`verify-cassettes`
 *  and caught only by the opt-in `--assert-from`. Covers every field in `RECORDING_SHAPING_FIELDS` (prompt,
 *  baseline, fidelity, lane, answers, skills, requires_capabilities — see recordingShapingDrift), each
 *  default-normalized so a `[]`-vs-undefined churn can't false-positive. A resolvable+drifted field from an EXACTLY-recorded
 *  (persisted) source is a DEFINITE divergence → hard fail; a name-resolved match, or an unresolvable/
 *  unparseable source, is "can't compare" → a non-failing note, never a false-red (many valid cassettes ship
 *  without a committed source). */
export function scenarioContentDrift(
  cassette: Pick<Cassette, "scenarioSource" | "scenario">,
  cassetteFile: string,
): { verifiable: true; drifted: string[] } | { verifiable: false; reason?: string } {
  try {
    const src = _resolveRerecordSource(cassetteFile, cassette);
    // No on-disk source at all is the NORMAL standalone-cassette case — nothing to compare, and that's
    // expected, not noteworthy. Return `reason: undefined` so the caller stays silent (no note flood).
    if (!src.path) return { verifiable: false };
    let onDisk: Scenario;
    try {
      onDisk = parseScenarioFile(src.path);
    } catch (e) {
      // A source that DOES resolve but won't parse is a genuine "should be checkable but isn't" — worth a
      // note. Mirror the default replay lane: a mid-edit/invalid on-disk YAML must NEVER abort verify-cassettes.
      return {
        verifiable: false,
        reason: `on-disk scenario ${src.path} did not parse (${(e as Error).message}) — prompt drift not checked`,
      };
    }
    const drifted = recordingShapingDrift(cassette.scenario as Scenario, onDisk);
    // Only a PERSISTED (exactly-recorded) source is trustworthy enough to HARD-FAIL on. A name-lookup match
    // (the recorded scenarioSource is gone, or was never recorded) may be an unrelated same-named sibling —
    // downgrade any drift it finds to a non-failing note rather than red CI on a guess.
    if (drifted.length && src.via !== "persisted")
      return {
        verifiable: false,
        reason: `on-disk ${src.path} (resolved by name, not a recorded source) has drifted recording-shaping field(s) [${drifted.join(", ")}] — re-record or \`replay --assert-from\` to confirm`,
      };
    return { verifiable: true, drifted };
  } catch (e) {
    // Defense-in-depth: any resolution error (e.g. a lenient cassette missing scenario.name, which
    // `_findScenarioOnDisk` would slug) degrades to "can't check" — NEVER aborts the verify-cassettes batch.
    return { verifiable: false, reason: `scenario-drift check skipped (${(e as Error).message})` };
  }
}

/** Session-shape drift (Finding 23) for `verify-cassettes` ONLY — deliberately NOT part of
 *  `computeStaleness`/`checkStaleness`, so it can never change the default `replay` verdict (not even
 *  under `--strict`/`--fail-on-skill-drift`; mirrors how prompt drift (`scenarioContentDrift`, above) is
 *  its own bucket, not folded into the fingerprint-driven staleness checks). A pre-v9 cassette (no
 *  `sessionFingerprint`) is NOT checked at all — backward-compat, never a false-red on an existing
 *  committed cassette. When the cassette DOES carry one, it is compared against a fresh recompute from
 *  the CURRENT session file; if the session can't be resolved (inline scenario, moved/deleted file,
 *  unparsable YAML) the check can't run — "can't verify" is a non-failing note, never a mismatch (F45:
 *  flagged `unverifiable:true`, a typed signal distinct from a `drifted:false` that means "recomputed
 *  and confirmed identical", so a consumer can tell the two apart instead of reading both as "clean").
 *
 *  F51: `cassette.scenario.session` resolves via a relative offset from `cassetteDir` — the SAME
 *  mechanism `cassette.scenarioSource` uses (see `scenarioContentDrift`/`_resolveRerecordSource` above).
 *  If the cassette was relocated onto a directory tree that doesn't mirror the original layout, that
 *  offset can coincidentally land on an UNRELATED same-named session file, producing a false mismatch
 *  (never a false match — an unrelated file hashing equal by chance isn't the risk here). `sourceVia`
 *  — the caller's `_resolveRerecordSource(...).via` for the SAME cassette — is the only available trust
 *  signal for whether this cassette's relative-offset resolution is intact (a persisted-source hit means
 *  the tree still mirrors record time; a name-lookup fallback means it doesn't and the offset can't be
 *  trusted). Reusing it here mirrors `scenarioContentDrift`'s own "resolved by name, may be an unrelated
 *  same-named sibling → non-failing note" downgrade, without storing or hashing an absolute host path
 *  (forbidden — see the relocatable-cassette contract at ~528-529, ~2270, ~2399-2400). Only
 *  `"name-lookup"` downgrades — `"none"` means "nothing nearby to compare the layout against" (mirrors
 *  `scenarioContentDrift`'s own silent `!src.path` early-return, not its low-confidence branch) and is
 *  NOT evidence the tree moved. Omitting `sourceVia` entirely (the unit-level tests below, and any
 *  future caller that hasn't computed it) also keeps the pre-F51 behavior: trust the resolution, hard-fail
 *  on a genuine mismatch. */
export function sessionFingerprintDrift(
  cassette: Pick<Cassette, "sessionFingerprint" | "scenario">,
  cassetteDir: string | undefined,
  sourceVia?: "persisted" | "name-lookup" | "none",
  sessionOverride?: string,
): { drifted: boolean; note?: string; unverifiable?: boolean } {
  if (cassette.sessionFingerprint === undefined) return { drifted: false }; // pre-v9 — not checked
  const live = buildSessionFingerprint(cassette.scenario.session, cassetteDir, sessionOverride);
  if (live === undefined)
    return {
      drifted: false,
      unverifiable: true,
      note: "session-fingerprint: could not resolve the current session file to recompute — cannot verify session-shape staleness",
    };
  if (live === cassette.sessionFingerprint) return { drifted: false };
  // A recording made BEFORE `projects` was folded into the shape carries a hash that says nothing about
  // `projects[]`. Report that honestly as UNVERIFIABLE, not as a migration-with-all-clear: the recorded
  // value cannot distinguish "the field was simply never covered" from "the project mount changed since",
  // because there is nothing about `projects` in it to compare against. Claiming "nothing changed" here
  // would reintroduce, in the remedy, exactly the false green this field's coverage exists to close.
  //
  // The test is an EXACT match on the pre-`projects` shape, which is also why it can run ahead of the
  // name-lookup downgrade below: a byte-equal legacy hash is strong evidence the resolved file really is
  // this cassette's session (an unrelated same-named sibling matching exactly is not a coincidence worth
  // hedging), so the more specific and more actionable message wins.
  const legacy = buildSessionFingerprint(cassette.scenario.session, cassetteDir, sessionOverride, { omitProjects: true });
  if (legacy !== undefined && legacy === cassette.sessionFingerprint)
    return {
      drifted: false,
      unverifiable: true,
      note: "session-fingerprint: this cassette was recorded before `projects` was part of the session shape, so its hash covers everything EXCEPT `projects[]` — and everything it does cover matches. A change to a project mount since record time is therefore not detectable here. Re-record to gain that coverage.",
    };
  // Only "name-lookup" (a scenario WAS found, but not at its persisted/expected offset — the SAME
  // low-confidence signal scenarioContentDrift downgrades on) is grounds to distrust this mismatch.
  // "none" means "nothing to compare the layout against" (mirrors scenarioContentDrift's own `!src.path`
  // early return, which stays silent rather than downgrading) — it is NOT evidence the tree moved, so it
  // must NOT mask a genuine drift; keep the pre-F51 hard-fail for "none" and for an omitted argument.
  // An explicit `--session` IS the authoritative resolution, so the layout heuristic must not veto it.
  // Threading the override alone would still mask every genuine drift on a relocated cassette:
  // `_resolveRerecordSource` resolves the SCENARIO source, which is cassette-relative too, so any
  // relocation sets `persistedMissing` -> `sourceVia === "name-lookup"` -> downgraded to a note. The
  // operator named the session; a guess about directory structure cannot outrank that.
  if (sourceVia === "name-lookup" && sessionOverride === undefined)
    return {
      drifted: false,
      unverifiable: true,
      note: "session-fingerprint: differs from the current session file, but this cassette's directory structure could not be confirmed intact (scenario source resolved by name lookup, not its persisted path) — may be an unrelated same-named sibling; re-record, or verify manually before trusting the mismatch",
    };
  return { drifted: true };
}

/** Assertion keys (and `expect_denied`) that are NOT evaluated on the replay lane in a given cassette's shape.
 *  On the `--assert-from` opt-in path (where the author is actively editing) a freshly-added but unevaluable
 *  key would silently fail to protect anything — warn per key so it can't green by omission. Mirrors
 *  replayCassette's classification: manifest keys need a recorded `artifacts` manifest; gate keys need
 *  `controlOut`; egress/filesystem keys are live-only regardless. `expect_denied` is a scenario field (not an
 *  assert key) that desugars to live-only `egress_denied` checks — an edit to it is sourced but inert on
 *  replay, so warn when it differs from the frozen copy (closes the one remaining silent no-op). */
/** Why an on-disk assert key is not evaluable on THIS cassette's replay shape. `live-only` is DISTINCT
 *  from the rest: `record` freezes live-only keys and replay STRIPS them (never a NEW false-green), so
 *  `--write` may persist them; every OTHER reason means a key that would SILENTLY SKIP — a permanent
 *  false-green if frozen — so `--write` refuses it. */
type UncheckableReason = "manifest-missing" | "prerunpaths-missing" | "prerunhashes-missing" | "controlout-missing" | "live-only";

/** Classify which on-disk `assert:` keys are NOT evaluable on this cassette (reason code + human message
 *  per key), plus whether `expect_denied` changed. The shared core behind BOTH the warn path
 *  (`warnUncheckableOnDiskKeys`) and `replay --write`'s refuse decision — a single source so the two can't
 *  drift on which keys are "checkable". Preserves the original per-key precedence and dedup order. */
function classifyUncheckableOnDiskKeys(
  cassette: Cassette,
  frozen: Scenario,
  onDisk: Scenario,
): { keys: Map<keyof Assertion, { code: UncheckableReason; message: string }>; expectDeniedChanged: boolean } {
  const asserts = onDisk.assert ?? [];
  const hasManifest = !!cassette.artifacts?.length;
  const hasControlOut = !!cassette.controlOut?.length;
  // Reuse the exported classification constants — a hand-copied gateKeys list drifted once already (it was
  // missing computer_links_resolve on the manifest side), silently suppressing the on-disk warning.
  const manifestKeys = new Set<keyof Assertion>(MANIFEST_KEYS);
  const gateKeys = new Set<keyof Assertion>(QUESTION_GATE_KEYS);
  const liveOnlyKeys = new Set<keyof Assertion>(LIVE_ONLY_KEYS);
  const hasPreRun = cassette.preRunPaths !== undefined;
  const hasPreRunHashes = cassette.preRunHashes !== undefined;
  const keys = new Map<keyof Assertion, { code: UncheckableReason; message: string }>();
  for (const a of asserts) {
    for (const k of Object.keys(a) as (keyof Assertion)[]) {
      if (a[k] === undefined || keys.has(k)) continue;
      let entry: { code: UncheckableReason; message: string } | undefined;
      if (liveOnlyKeys.has(k)) entry = { code: "live-only", message: "live-only" };
      // no_unexpected_files mirrors replayCassette's presence-gating: an artifacts field that exists
      // (even empty) + preRunPaths ⇒ checkable (no reason); missing baseline ⇒ its dedicated reason,
      // never the generic manifest one (which would misdiagnose an empty-but-present manifest).
      else if (k === "no_unexpected_files" && cassette.artifacts === undefined)
        entry = { code: "manifest-missing", message: "no artifact manifest in this cassette" };
      else if (k === "no_unexpected_files" && !hasPreRun)
        entry = {
          code: "prerunpaths-missing",
          message: "no pre-run manifest in this cassette (recorded before the manifest seam) — re-record on a current harness",
        };
      // input_unmodified mirrors no_unexpected_files: checkable needs BOTH the artifacts manifest and the
      // preRunHashes baseline (a different pre-run field than no_unexpected_files' preRunPaths).
      else if (k === "input_unmodified" && cassette.artifacts === undefined)
        entry = { code: "manifest-missing", message: "no artifact manifest in this cassette" };
      else if (k === "input_unmodified" && !hasPreRunHashes)
        entry = {
          code: "prerunhashes-missing",
          message:
            "no pre-run hash manifest in this cassette (recorded pre-fingerprinted-manifest or on microvm) — re-record on a harness with hash-manifest support (container/hostloop)",
        };
      else if (k !== "no_unexpected_files" && k !== "input_unmodified" && manifestKeys.has(k) && !hasManifest)
        entry = { code: "manifest-missing", message: "no artifact manifest in this cassette" };
      else if (gateKeys.has(k) && !hasControlOut) entry = { code: "controlout-missing", message: "no controlOut in this cassette" };
      if (entry) keys.set(k, entry);
    }
  }
  const expectDeniedChanged = JSON.stringify(frozen.expect_denied ?? []) !== JSON.stringify(onDisk.expect_denied ?? []);
  return { keys, expectDeniedChanged };
}

/** Warn per on-disk key that a newly-added-but-uncheckable assert would silently protect nothing on replay
 *  (and per a live-only `expect_denied` edit). Thin wrapper over the shared classifier — output unchanged. */
function warnUncheckableOnDiskKeys(cassette: Cassette, frozen: Scenario, onDisk: Scenario): void {
  const { keys, expectDeniedChanged } = classifyUncheckableOnDiskKeys(cassette, frozen, onDisk);
  // expect_denied: sourced from on-disk but live-only on replay — warn if the author changed it expecting effect.
  if (expectDeniedChanged)
    warn(
      "::warning:: [replay] on-disk `expect_denied:` differs from the cassette but is live-only — it is sourced, NOT evaluated on replay (run a live `run` to check egress)\n",
    );
  for (const [k, r] of keys)
    warn(`::warning:: [replay] on-disk assert key \`${String(k)}\` is not checkable on replay (${r.message}) — skipped\n`);
}

/**
 * `replay --reassert --write` — persist the token-free-revalidated on-disk `assert:`/`expect_denied:` block
 * back into the cassette when ONLY the assert block changed. cmdReplay has already passed the drift guards
 * (`recordingShapingDrift` + skill-drift), so the frozen events still correspond to this scenario, AND
 * produced the reassert `verdict`. This mutates ONLY `scenario.assert` / `scenario.expect_denied` on the raw
 * parsed cassette (unknown/future fields round-trip) — never events/controlOut/fingerprint.
 *
 * Three guards, mirroring `record`:
 *  - M1 evaluability: refuse any added key that would SILENTLY SKIP on this cassette (every uncheckable
 *    reason except `live-only`) — freezing it is a permanent false-green. Live-only keys + `expect_denied`
 *    are written per record's freeze semantics (replay strips them; no NEW false-green).
 *  - M3 verdict: refuse a failing reassert verdict unless `--allow-failing` (record refuses too).
 *  - Redaction v2: redact ONLY the spliced block (the whole-cassette `redactCassette` re-tokenizes event
 *    lines and is non-idempotent), verify it stays verdict-preserving, and write the redacted block.
 */
async function writeReassertedAssertBlock(
  cassetteFile: string,
  rawCassette: Cassette,
  onDisk: Scenario,
  srcPath: string,
  verdict: ReturnType<typeof computeVerdict>,
  allowFailing: boolean,
): Promise<void> {
  // M1 — evaluability guard.
  const { keys } = classifyUncheckableOnDiskKeys(rawCassette, rawCassette.scenario, onDisk);
  const refused = [...keys.entries()].filter(([, r]) => r.code !== "live-only");
  if (refused.length) {
    const detail = refused.map(([k, r]) => `\`${String(k)}\` (${r.message})`).join(", ");
    throw new Error(
      `refusing to --write: ${refused.length} on-disk assert key(s) would freeze as a SILENT no-op on this cassette (a permanent false-green): ${detail}. ` +
        "These need evidence only a live re-record captures (artifact manifest / pre-run hashes / controlOut) — re-record to embed them.",
    );
  }
  // M3 — verdict gate (mirror record's refusal to freeze a failing run).
  if (!verdict.pass && !allowFailing) {
    const why = verdict.signals
      .filter((s) => s.severity === "fail")
      .map((s) => `${s.code}: ${s.message}`)
      .join("; ");
    throw new Error(`refusing to --write a FAILING reassert verdict — ${why} (fix the scenario, or pass --allow-failing; mirrors record)`);
  }
  // Redaction v2 — block-only. Load the policy from the SAME dir set record uses, or it under-redacts.
  const policy = loadRedactionPolicy([process.cwd(), dirname(srcPath), dirname(cassetteFile)]);
  let nextAssert: unknown[] = onDisk.assert ?? [];
  let nextExpectDenied: unknown[] = onDisk.expect_denied ?? [];
  if (policy.patterns.length || policy.keyNames.length) {
    const redactedAssert = redactStructural(onDisk.assert ?? [], policy) as unknown[];
    const redactedExpectDenied = redactStructural(onDisk.expect_denied ?? [], policy) as unknown[];
    // Verdict-preservation over two cassettes that differ ONLY in the assert block: events/controlOut are
    // identical, so any verdict delta is the redaction's doing (not a fresh-base assumption). Refuse on a flip.
    const base = {
      ...rawCassette,
      scenario: { ...rawCassette.scenario, assert: onDisk.assert ?? [], expect_denied: onDisk.expect_denied ?? [] },
    } as Cassette;
    const redacted = {
      ...rawCassette,
      scenario: { ...rawCassette.scenario, assert: redactedAssert, expect_denied: redactedExpectDenied },
    } as Cassette;
    await assertRedactionVerdictPreserved(base, redacted, dirname(cassetteFile));
    nextAssert = redactedAssert;
    nextExpectDenied = redactedExpectDenied;
  }
  // Write only if the (post-redaction) block differs from the frozen copy. Idempotent because we always
  // redact from the PLAINTEXT on-disk source (deterministic) — a second --write yields the same block.
  const scn = rawCassette.scenario as { assert?: unknown[]; expect_denied?: unknown[] };
  const assertSame = JSON.stringify(scn.assert ?? []) === JSON.stringify(nextAssert);
  const expectSame = JSON.stringify(scn.expect_denied ?? []) === JSON.stringify(nextExpectDenied);
  if (assertSame && expectSame) {
    warn(`::notice:: [replay --write] ${cassetteFile}: assert block already matches the on-disk block — no write\n`);
    return;
  }
  scn.assert = nextAssert;
  // Only manage expect_denied when it's meaningful — avoid gratuitously adding an empty field to a cassette
  // that never had one (keep the diff to what actually changed).
  if (nextExpectDenied.length || scn.expect_denied !== undefined) scn.expect_denied = nextExpectDenied;
  writeFileAtomic(cassetteFile, JSON.stringify(rawCassette, null, 2)); // atomic — no partial cassette on a crash
  warn(`::notice:: [replay --write] ${cassetteFile}: wrote the re-asserted block back to the cassette (events/controlOut unchanged)\n`);
}

/** `replay <file|dir>` — deterministic protocol-replay; re-evaluates content assertions. A directory
 *  replays every `*.cassette.json` (non-recursive, sorted) and exits on the worst verdict; an unreadable
 *  cassette is a per-file error (never aborts the batch, never a vacuous pass).
 *
 *  Assertion source: by default the assertions FROZEN in the cassette drive the verdict (byte-deterministic,
 *  no ambient filesystem dependency) — a sibling scenario whose `assert:` differs only triggers a discoverability
 *  `::notice::`. `--assert-from <file>` / `--reassert` is the explicit opt-in to re-check against the on-disk
 *  `assert:`+`expect_denied:`; on that path recording-shaping drift (prompt/baseline/fidelity/lane/answers/skills/
 *  requires_capabilities — see RECORDING_SHAPING_FIELDS) and skill staleness HARD-FAIL, so on-disk asserts can
 *  never green against events a different scenario/skill produced. */
/**
 * Compact a `parseScenarioFile` UsageError down to one readable clause for a `::notice::`.
 *
 * The underlying Zod message is a pretty-printed JSON issue array — many lines, mostly punctuation —
 * which would swamp a notice line. Pull out each issue's `message` ("Unrecognized key: \"lane\"") and
 * join them. Anything unexpected falls back to a whitespace-collapsed truncation, so a message shape
 * we did not anticipate still produces a usable line rather than a wall of JSON.
 *
 * MUST NOT THROW: it runs on the default replay lane's decoration path, where an error raised while
 * *reporting* an error would be exactly the bug this whole block is guarded against.
 */
export function compactSchemaError(message: string, limit = 200): string {
  const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
  const truncate = (s: string) => (s.length > limit ? s.slice(0, limit - 1) + "…" : s);
  try {
    const start = message.indexOf("[");
    if (start !== -1) {
      const issues: unknown = JSON.parse(message.slice(start));
      if (Array.isArray(issues)) {
        const parts = issues
          .map((i) =>
            i && typeof i === "object" && typeof (i as { message?: unknown }).message === "string"
              ? (i as { message: string }).message
              : "",
          )
          .filter(Boolean);
        if (parts.length) return truncate(collapse(parts.join("; ")));
      }
    }
  } catch {
    /* fall through to the raw-message fallback below */
  }
  return truncate(collapse(message));
}

// `replay`'s accepted flags — hoisted to exported consts for the same reason as RECORD_BOOLEAN_FLAGS/
// RECORD_VALUE_FLAGS above (P9 generalizes P3's guard to this command). --quiet/--verbose are accepted
// for flag consistency but are genuinely inert here (parsed, never read — see REPLAY_ALLOWLIST below).
export const REPLAY_BOOLEAN_FLAGS = [
  "--strict",
  "--fail-on-skill-drift",
  "--mutate",
  "--reassert",
  "--write",
  "--allow-failing",
  "--explain",
  "--best-effort-future-cassette",
  "--quiet",
  "--verbose",
] as const;
export const REPLAY_VALUE_FLAGS = ["--output-format", "--assert-from", "--session", "--mutate-max-per-file", "--mutate-max-total"] as const;

// A SEPARATE axis from REPLAY_VALUE_FLAGS, for the same reason VERIFY_CASSETTES_REPEATED_FLAGS is one:
// parseArgs collects every occurrence of a repeated flag into p.repeated[], while a value flag keeps only
// the LAST. Scoping is inherently multi-pattern ("everything but handoff/ and tmp/"), so folding these in
// would silently honour one pattern and drop the rest — a semantic regression, not a refactor. `replay`
// had no repeated-flag axis at all before these.
export const REPLAY_REPEATED_FLAGS = ["--mutate-include", "--mutate-exclude"] as const;

// Both inert on `replay` — parsed into p.flags, never read anywhere in cmdReplay below (verified by
// reading every `p.flags["--quiet"]`/`p.flags["--verbose"]` site in this file: none exists outside
// cmdRecord). Contrast RECORD_ALLOWLIST's --verbose entry: record's --quiet IS wired up there, so it's
// documented instead of allowlisted; here neither is, so both are.
export const REPLAY_ALLOWLIST: readonly UsageAllowlistEntry[] = [
  { flag: "--quiet", reason: "accepted for flag consistency; inert on this command" },
  { flag: "--verbose", reason: "accepted for flag consistency; inert on this command" },
];

// Single-sourced `replay` usage text — see the UNIFICATION DECISION comment above RECORD_USAGE for why
// both `replay --help` (src/cli.ts's SUBCOMMAND_USAGE.replay) and the no-target usage error below share
// this one string. Previously two independently hand-maintained strings (cli.ts's was a superset of this
// one; this one was missing --best-effort-future-cassette entirely, undiscoverable at the exact point
// (`cassette format too new: …`) that tells a user to pass it — the P9 bug this generalization fixes).
export const REPLAY_USAGE =
  "usage: replay <file.cassette.json | dir/> [--strict] [--fail-on-skill-drift] [--mutate] [--assert-from <scenario.yaml> | --reassert] [--session <file>] [--write [--allow-failing]] [--explain] [--best-effort-future-cassette] [--output-format text|json]\n" +
  "       --session <file>: resolve the cassette's skill sources from THIS session instead of the recorded cassette-relative path. The escape hatch for a MOVED cassette: a cassette stores `session:` relative to its own directory, so any relocation (git mv, a repo reorg, a copy into another project) leaves staleness unverifiable with no way to say where the tree went. Supplies a SESSION, not bare directories, so the session-level `staleness.hash_ignore` and the rest of the hash boundary survive the override. One cassette at a time — refused for a directory batch, since each cassette may have been recorded against a different source. The resolved path is echoed on stderr: an override that silently pinned the wrong tree would manufacture false greens.\n" +
  "       --mutate: perturb recorded JSON artifact values, re-run the assertions, and report which perturbations NOTHING caught — those fields are unguarded. SAMPLES: max 10 values per file, 50 total (per-file applies first), so `N/N caught by nothing` is N of the sample, not of your corpus; when a cap binds the report names it and the eligible total. Reporting only; never changes the verdict or exit code.\n" +
  "       --mutate-include <glob> / --mutate-exclude <glob>: scope which artifact paths are perturbed (repeatable; exclude wins). `*` stays inside a path segment, `**` crosses them — so `--mutate-exclude 'handoff/**'` drops per-run internals nobody should assert on, and the sample is spent on deliverables instead.\n" +
  "       --mutate-max-per-file <n> / --mutate-max-total <n>: raise the sampling caps (default 10 / 50). Per-file is applied FIRST, so with a handful of artifacts raising only --mutate-max-total changes nothing. Cost is linear — one full assertion re-run per perturbation.\n" +
  "       --explain: after the footer, print the evidence trail for each PASSING assert (which link resolved, which file matched, which value satisfied a bound) — text mode; json already carries assertions[].evidence.\n" +
  "       by default the assertions FROZEN in the cassette drive the verdict (deterministic); a sibling scenario whose assert: differs only prints a notice.\n" +
  `       --assert-from <file> / --reassert: token-free re-check against the on-disk assert:/expect_denied: — recording-shaping drift (${RECORDING_SHAPING_FIELDS.join("/")}) and skill staleness HARD-FAIL.\n` +
  "       --write (reassert path only): persist the re-validated block back into the cassette when ONLY the assert block changed — no paid re-record. Refuses keys that would silently skip (need a manifest/hashes/controlOut) and, without --allow-failing, a failing verdict; events/controlOut stay byte-identical.\n" +
  "       --allow-failing waives that verdict gate WHOLESALE — including the skill-drift failure --assert-from forces on. So `--assert-from --write --allow-failing` will persist an assert block validated against a recording whose skill sources have since changed. Re-record instead when the drift is real; the flag is for a verdict you have read and understood.\n" +
  "       text mode writes the footer to STDERR and nothing to stdout (a passing replay is 0 bytes) — machine output needs --output-format json. To tell YOUR failing asserts from injected drift/corruption findings, read verdict.failures[].kind (`assertion` vs `staleness`/`cassette-format`), not the exit code, which collapses them: jq '[.results[]? | .verdict.failures[]? | select(.kind==\"assertion\")] | length'.\n" +
  '       --best-effort-future-cassette: override the refusal to replay a cassette recorded by a NEWER format version and attempt it anyway. `verify-cassettes` deliberately does NOT accept this flag — a verification gate has no "read it anyway" path. Cost: an older CLI reading a newer cassette can silently misread a scenario key it does not recognize — this is a best-effort escape hatch, not a safe one.';

export async function cmdReplay(args: string[]) {
  // Up-front JSON detection (see cmdRecord) so every error path emits the shared envelope in JSON mode.
  const asJson = isJsonOutput(args);
  let p;
  try {
    p = parseArgs(args, {
      // Both flag SETS are the exported REPLAY_BOOLEAN_FLAGS/REPLAY_VALUE_FLAGS consts above — do not
      // fork this list back into a local literal (that's the drift P9 generalized P3's fix to prevent).
      booleans: [...REPLAY_BOOLEAN_FLAGS],
      values: [...REPLAY_VALUE_FLAGS],
      repeated: [...REPLAY_REPEATED_FLAGS],
      enums: { "--output-format": ["text", "json"] },
      aliases: { "-q": "--quiet" },
    });
  } catch (e) {
    return fail("replay", "usage", String((e as Error).message), undefined, asJson);
  }
  const target = p.positionals[0];
  if (!target) {
    return fail("replay", "usage", REPLAY_USAGE, undefined, asJson);
  }
  if (p.positionals.length > 1) {
    return fail("replay", "usage", `replay takes one target (got ${p.positionals.length}: ${p.positionals.join(", ")})`, undefined, asJson);
  }
  const json = p.options["--output-format"] === "json";
  const strict = p.flags["--strict"] ?? false; // escalate ALL staleness findings to failures (release gate)
  const bestEffortFutureCassette = p.flags["--best-effort-future-cassette"] ?? false; // opt into warn-and-replay for a future-version cassette
  // `--assert-from <file>` (explicit path) / `--reassert` (auto-resolve the sibling) opt INTO re-checking against
  // the on-disk `assert:`; mutually exclusive. On that path skill-content drift MUST hard-fail (else the frozen
  // events could green an edited assert against a skill that no longer produces them) — so OR in failOnSkillDrift.
  const assertFrom = p.options["--assert-from"];
  const reassert = p.flags["--reassert"] ?? false;
  if (assertFrom !== undefined && reassert) {
    return fail(
      "replay",
      "usage",
      "replay: --assert-from and --reassert are mutually exclusive (--assert-from names a file; --reassert auto-resolves the sibling)",
      undefined,
      asJson,
    );
  }
  const reassertMode = assertFrom !== undefined || reassert;
  // `--write` persists the re-validated on-disk assert block back into the cassette — only meaningful on the
  // reassert opt-in path (the drift guards there are what make it safe). `--allow-failing` relaxes the write's
  // verdict gate (mirrors record).
  const write = p.flags["--write"] ?? false;
  const allowFailing = p.flags["--allow-failing"] ?? false;
  // `--explain`: after each cassette's footer, print the evidence trail for its PASSING asserts (which link
  // resolved, which file matched, which value satisfied a bound) — what lets an author trust a green isn't
  // vacuous. Text-mode only; `--output-format json` already carries `assertions[].evidence` in the envelope.
  const explain = p.flags["--explain"] ?? false;
  if (write && !reassertMode) {
    return fail(
      "replay",
      "usage",
      "replay --write requires --reassert (or --assert-from <scenario.yaml>): it persists the RE-ASSERTED on-disk block, so there must be one to re-assert from",
      undefined,
      asJson,
    );
  }
  if (allowFailing && !write)
    warn("::notice:: [replay] --allow-failing only affects --write's verdict gate; it is a no-op without --write\n");
  const failOnSkillDrift = (p.flags["--fail-on-skill-drift"] ?? false) || reassertMode; // narrower gate: only skill-source drift fails
  const mutate = p.flags["--mutate"] ?? false;
  // Scoping + cap overrides for --mutate. Repeated flags come back as arrays; exclude is applied after
  // include so "everything under outputs/, except the scratch subtree" reads the obvious way.
  const mutateInclude = p.repeated["--mutate-include"] ?? [];
  const mutateExclude = p.repeated["--mutate-exclude"] ?? [];
  const mutateCap = (flag: string): number | undefined => {
    const raw = p.options[flag];
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1)
      return fail("replay", "usage", `${flag} must be a positive integer (got "${raw}")`, undefined, asJson) as never;
    return n;
  };
  const mutateMaxPerFile = mutateCap("--mutate-max-per-file");
  const mutateMaxTotal = mutateCap("--mutate-max-total");
  // These only shape a --mutate pass; accepting them silently without it would look like scoping worked.
  if (!mutate) {
    const orphan = [
      mutateInclude.length ? "--mutate-include" : "",
      mutateExclude.length ? "--mutate-exclude" : "",
      mutateMaxPerFile !== undefined ? "--mutate-max-per-file" : "",
      mutateMaxTotal !== undefined ? "--mutate-max-total" : "",
    ].filter(Boolean);
    if (orphan.length)
      return fail("replay", "usage", `${orphan.join(", ")} require(s) --mutate (they only shape a mutation pass).`, undefined, asJson);
  }
  if (strict && p.flags["--fail-on-skill-drift"])
    warn(
      "::notice:: [replay] --strict and --fail-on-skill-drift both passed — --strict is the superset (fails on every class), so --fail-on-skill-drift is redundant here\n",
    );
  const resolved = resolveInputs(target, ".cassette.json");
  if ("error" in resolved) {
    return fail("replay", "usage", `replay: ${resolved.error}`, undefined, asJson);
  }
  const plan: RenderPlan = {
    live: false,
    progress: false,
    verbose: false,
    color: process.stderr.isTTY === true && !process.env.NO_COLOR,
    compact: false,
  };
  // `--session` names ONE cassette's session. Over a directory each cassette may have been recorded
  // against a different source, so a single override cannot be right for all of them — refuse rather than
  // silently pin the wrong tree, which would manufacture false greens (worse than an honest "cannot
  // verify"). Same reasoning as `record --out` and the `--assert-from --write` guard below.
  const sessionOverride = p.options["--session"];
  const targetIsDir = existsSync(target) && statSync(target).isDirectory();
  if (sessionOverride !== undefined && (targetIsDir || resolved.files.length > 1)) {
    return fail(
      "replay",
      "usage",
      `replay --session <file> names one cassette's session and is not valid for a directory target (${resolved.files.length} cassette(s)) — run it per cassette`,
      undefined,
      asJson,
    );
  }
  if (sessionOverride !== undefined && (!existsSync(sessionOverride) || !statSync(sessionOverride).isFile())) {
    // `isFile()` too: a directory passed the existence gate and only surfaced later as an EISDIR parse
    // error, with the notice meanwhile claiming the override was "in effect".
    return fail("replay", "usage", `replay --session: not a session file: ${sessionOverride}`, undefined, asJson);
  }
  // An override must never be silent about where it looked — a wrong one pinning the wrong tree is the
  // failure mode that matters, and it is worse than the honest exit 3 it replaces.

  // Footgun guard: one --assert-from file applied to a whole dir asserts the SAME on-disk block against every
  // cassette (the drift gate protects divergent cassettes, but two with identical shaping fields would be
  // cross-asserted). Use --reassert (per-cassette sibling) for a dir. Warn rather than reject — it's occasionally
  // intentional (one shared assert block).
  if (assertFrom !== undefined && resolved.files.length > 1)
    warn(
      `::warning:: [replay] --assert-from <one file> applied to ${resolved.files.length} cassettes — the SAME on-disk assert: is checked against each; ` +
        "use --reassert to resolve each cassette's own sibling\n",
    );
  // `--assert-from <one file> --write` over a dir would clone-write ONE assert block into every cassette —
  // the cross-assert footgun made permanent. For a dir, require --reassert (each cassette's own sibling).
  if (write && assertFrom !== undefined && resolved.files.length > 1) {
    return fail(
      "replay",
      "usage",
      "replay --assert-from <one file> --write over a directory is refused (it would write one assert block into every cassette) — use --reassert for a per-cassette sibling",
      undefined,
      asJson,
    );
  }
  const results: RunResult[] = [];
  let worst = 0;
  // Rootfs-drift check, resolved AT MOST ONCE per `replay` invocation and ONLY if some cassette actually
  // recorded an image. Deliberately hooked here and not inside `replayCassette`: that function is also
  // driven per-cassette by `verify-cassettes` batches and twice per record by the redaction self-check,
  // so an inspect there would shell out during a privacy scan. Cassettes with no recorded image (protocol
  // and microvm tiers, and everything recorded before the field existed) never reach the spawn at all,
  // which is what keeps the token-free replay gates working with no container runtime present.
  let currentImage: AgentImageProvenance | undefined;
  const currentImageOnce = (): AgentImageProvenance =>
    (currentImage ??= resolveAgentImageProvenance(resolveContainerRuntime(), resolveAgentImage()));
  // WS-C: collect staleness notes across the batch instead of printing the same constant string once per
  // cassette. Keyed by the note's `kind:` prefix; the tail after the prefix is identical per kind, so one
  // exemplar + a count is strictly more informative than N repetitions.
  const notesByKind = new Map<string, { count: number; exemplar: string }>();
  const collectNotes = (ns: string[]) => {
    for (const n of ns) {
      const kind = /^([a-z-]+):/.exec(n)?.[1] ?? "note";
      const prev = notesByKind.get(kind);
      notesByKind.set(kind, { count: (prev?.count ?? 0) + 1, exemplar: prev?.exemplar ?? n });
    }
  };
  for (const f of resolved.files) {
    const rc = readCassette(f); // safe parse + lenient Zod — never throws
    // `--session` names a session FILE, and an inline scenario has none. Refuse rather than accept,
    // announce "override in effect", and then silently ignore it — three lines that contradict each other,
    // with the notice being the feature's own anti-false-green guarantee.
    if (sessionOverride !== undefined && "cassette" in rc && rc.cassette.scenario.session === "(inline)") {
      return fail(
        "replay",
        "usage",
        `replay --session: this cassette records an inline scenario, which has no session file to override — remove --session (its skill sources, if any, were declared inline at record time)`,
        undefined,
        asJson,
      );
    }
    if (sessionOverride !== undefined) {
      // Name the DIRS, not just the file: the dirs are what feed the hash, and they are what a wrong
      // override gets wrong. "override in effect: <path>" alone would look right while resolving to
      // nothing — the silent-false-green shape this flag must never have.
      const od = skillSourceDirs(sessionOverride, undefined);
      const where = od.dirs.length
        ? od.dirs.join(", ")
        : od.failure?.kind === "declared-dirs-missing"
          ? `NO usable skill dirs — it declares ${od.failure.declared} but none exist (mounts are relative to the session's own directory)`
          : od.failure?.kind === "unreadable"
            ? "NO skill dirs — this session could not be read or parsed"
            : od.failure?.kind === "not-found"
              ? "NO skill dirs — no file at that path"
              : "NO skill dirs — this session declares none";
      warn(`::notice:: [replay] --session override in effect: ${sessionOverride} -> ${where}\n`);
    }

    if ("error" in rc) {
      log(`replay: ${f}: ${rc.error}`);
      results.push(replayErrorResult(f)); // turns the envelope's ok false (no false green)
      worst = Math.max(worst, 2);
      continue;
    }
    const renderer = json ? undefined : makeRenderer(plan);
    // replayCassette catches malformed control frames per-line (→ replay_protocol_fidelity
    // failures) and re-throws nothing for them, but an UNEXPECTED throw (a harness bug, an OOM on a
    // pathological cassette) must NOT abort the whole batch — a crash mid-walk reads as "the rest were
    // fine" (false-green by abort). Wrap per-file: turn an unexpected throw into a tallied error result.
    // The on-disk assert resolution/parse/drift below MUST stay INSIDE this try: parseScenarioFile throws on
    // an invalid YAML, and on the opt-in path that throw should fail THIS cassette (a tallied error), not
    // escape the loop and abort the batch.
    let result: RunResult;
    // Captured on the reassert path so the post-verdict --write step (below) has the on-disk block + source.
    let reassertWriteCtx: { onDisk: Scenario; srcPath: string } | undefined;
    try {
      let cassette = rc.cassette;
      if (reassertMode) {
        // --- A-optin: explicit re-check against on-disk assert:/expect_denied: (safe by construction) ---
        let srcPath: string;
        if (assertFrom !== undefined) {
          srcPath = assertFrom;
        } else {
          const src = _resolveRerecordSource(f, rc.cassette);
          if (!src.path)
            throw new Error(
              `--reassert: no on-disk scenario found for ${f} (looked via ${src.via}${src.persistedMissing ? `; recorded source '${src.persistedMissing}' is missing` : ""})` +
                " — pass --assert-from <scenario.yaml> explicitly",
            );
          srcPath = src.path;
        }
        // parseScenarioFile throws on invalid YAML; its message doesn't name the file, so wrap to attribute the
        // failure to the path the user pointed at. Still inside the per-file try → this cassette errors, batch continues.
        let onDisk: Scenario;
        try {
          onDisk = parseScenarioFile(srcPath);
        } catch (e) {
          throw new Error(`--assert-from: failed to parse ${srcPath}: ${(e as Error).message}`);
        }
        const drift = recordingShapingDrift(rc.cassette.scenario, onDisk);
        if (drift.length)
          throw new Error(
            `--assert-from: ${drift.join(", ")} drifted from the recording (${srcPath}); the frozen events no longer correspond to this scenario — re-record instead of re-asserting`,
          );
        warnUncheckableOnDiskKeys(rc.cassette, rc.cassette.scenario, onDisk);
        // Shallow clone — never mutate the parsed cassette in place.
        cassette = {
          ...rc.cassette,
          scenario: { ...rc.cassette.scenario, assert: onDisk.assert ?? [], expect_denied: onDisk.expect_denied ?? [] },
        };
        // HONESTY: the skill-drift guard only bites when a skill fingerprint was recorded. computeStaleness
        // returns [] with no `fingerprint.skillHash`, so failOnSkillDrift has nothing to escalate — claiming
        // "skill-drift will hard-fail" for a fingerprint-less cassette would be false reassurance (the author
        // could green an edited assert against a since-changed skill). Word the notice by what's verifiable, and
        // WARN loudly when it isn't, so the gap is visible rather than papered over.
        // HONESTY: word the notice by what's ACTUALLY verified — the enumerated authored scenario fields
        // (recordingShapingDrift) plus skill-CONTENT drift when a fingerprint exists. The SESSION (model, data
        // mounts, discovery) is the dominant recording-shaping input but lives outside the scenario, is excluded
        // from the drift set, and is NOT fingerprinted — so a model/mount change between record and re-assert is
        // structurally undetectable here. Say that, rather than a blanket "recording-shaping fields verified".
        const skillVerifiable = !!rc.cassette.fingerprint?.skillHash;
        warn(
          `::notice:: [replay] re-asserting from on-disk ${srcPath} ` +
            `(authored fields ${RECORDING_SHAPING_FIELDS.join("/")} verified unchanged; ` +
            `skill-content drift ${skillVerifiable ? "will hard-fail" : "NOT verifiable — no skill fingerprint"}; ` +
            `session model/mounts/discovery is NOT verified — re-record if the session changed)\n`,
        );
        if (!skillVerifiable)
          warn(
            "::warning:: [replay] this cassette has no skill fingerprint, so skill-content drift can NOT be verified on --assert-from — " +
              "re-asserting against possibly-stale events; re-record to enable the skill-drift guard\n",
          );
        if (write) reassertWriteCtx = { onDisk, srcPath };
      } else {
        // --- A-default: frozen assertions drive the verdict; only kill the SILENT no-op with a notice ---
        // Pure decoration — never throws, never changes the verdict. If the sibling resolves and its assert:
        // differs from the frozen copy, point the user at --assert-from. Wrapped so a bad/mid-edit sibling
        // (unreadable, invalid YAML) degrades to no notice, not an error on the deterministic default lane.
        try {
          const src = _resolveRerecordSource(f, rc.cassette);
          if (src.path) {
            // A SCHEMA violation here is an actionable authoring mistake (a typo'd or too-new key), and
            // swallowing it is why a scenario carrying a key from a newer release looked like it replayed
            // fine — the loader's loud rejection was invisible through `replay`. Surface it as a notice.
            // A read/YAML-parse failure keeps the original silence: that is the half-written-sibling case
            // this block was wrapped for, and it must never speak up. Notice only — no verdict, no exit.
            let onDisk: Scenario | undefined;
            try {
              onDisk = parseScenarioFile(src.path);
            } catch (e) {
              if (e instanceof UsageError)
                warn(
                  `::notice:: [replay] ${src.path} does not load: ${compactSchemaError(e.message)} — replay used the scenario frozen in the cassette and is unaffected. ` +
                    `Run \`cowork-harness record ${src.path} --dry-run\` for the full error.\n`,
                );
            }
            // Drift notices need a parsed sibling; without one there is nothing to compare against.
            if (onDisk) {
              const norm = (a: unknown) => JSON.stringify(a ?? []);
              if (norm(onDisk.assert) !== norm(rc.cassette.scenario.assert))
                warn(
                  `::notice:: [replay] ${src.path} has a different \`assert:\` block; replay used the assertions frozen in the cassette. ` +
                    `Re-record, or \`replay --assert-from ${src.path}\` to re-check against the on-disk block.\n`,
                );
              // Prompt drift is invisible to the fingerprint (see scenarioContentDrift). Surface it as a
              // non-failing notice here too — the default lane never changes the verdict.
              if ((onDisk.prompt ?? "") !== (rc.cassette.scenario.prompt ?? ""))
                warn(
                  `::notice:: [replay] ${src.path} has a different \`prompt:\` than the cassette's frozen prompt; the frozen events reflect the recorded prompt. ` +
                    `Re-record to sync (verify-cassettes hard-fails this drift).\n`,
                );
            }
          }
        } catch {
          /* on-disk file is decoration on the default lane — a parse/read failure must not affect the run */
        }
      }
      result = await replayCassette(cassette, renderer ? [renderer] : [], {
        strict,
        failOnSkillDrift,
        mutate,
        mutateInclude,
        mutateExclude,
        mutateMaxPerFile,
        mutateMaxTotal,
        cassetteDir: dirname(f),
        sessionOverride,
        bestEffortFutureCassette,
        notesSink: collectNotes,
      });
    } catch (e) {
      log(`replay: ${f}: ${(e as Error)?.message ?? String(e)}`);
      results.push(replayErrorResult(f)); // turns the envelope's ok false (no false green)
      worst = Math.max(worst, 2);
      continue;
    }
    // Advisory rootfs-drift note. The image decides missingCapabilityUse, which computeVerdict fails on,
    // so replaying against a different rootfs than the recording can move the verdict with nothing in the
    // cassette having changed. Never fails the replay — a legitimately re-pulled image is the common case.
    const recordedImage = rc.cassette.environment?.agentImage;
    if (recordedImage) {
      const drift = imageProvenanceMismatch(recordedImage, currentImageOnce());
      if (drift) warn(`::warning:: [replay] ${f}: ${drift}\n`);
    }
    // the replay lane evaluates assertions + result only; one verdict source for footer AND exit.
    if (!json) renderFooter(result, plan, { renderer, lane: "replay" });
    if (explain && !json) {
      // Per-passing-assert evidence trail. Names the concrete thing each green matched, so a vacuous pass
      // (e.g. a presence-gated key that saw zero links) is legible instead of an unqualified "✓".
      const passing = result.assertions.filter((r) => r.pass);
      log(`\n[explain] ${f} — evidence for ${passing.length} passing assert(s):`);
      for (const r of passing) {
        const key = Object.keys(r.assertion).find((k) => (r.assertion as Record<string, unknown>)[k] !== undefined) ?? "(assert)";
        log(`  ✓ ${key}${r.evidence ? ` — ${r.evidence}` : " — (no evidence trail for this key)"}`);
      }
    }
    results.push(result);
    const verdict = computeVerdict(result, "replay");
    worst = Math.max(worst, verdict.exitCode);
    // --write: persist the re-asserted block back into the cassette (reassert path only; the drift guards
    // above already ran). A refusal is a per-file operational error (bump `worst`) — never a silent skip.
    if (write && reassertWriteCtx) {
      try {
        await writeReassertedAssertBlock(f, rc.cassette, reassertWriteCtx.onDisk, reassertWriteCtx.srcPath, verdict, allowFailing);
      } catch (e) {
        log(`replay --write: ${f}: ${(e as Error)?.message ?? String(e)}`);
        worst = Math.max(worst, 2);
      }
    }
  }
  // stdout = machine ONLY under --output-format json; humans get per-file footers on stderr.
  // One line per note kind, after the batch. `::notice::` (not `::warning::`) — these are non-gating by
  // construction, and on a CI annotation surface a self-described-harmless advisory must not outrank the
  // ACTIONABLE assert-drift notice beside it.
  const total = resolved.files.length;
  for (const [kind, { count, exemplar }] of notesByKind)
    warn(`::notice:: [replay] ${count}/${total} cassette(s) — ${exemplar.replace(new RegExp(`^${kind}:\\s*`), "")} [${kind}]\n`);

  if (json) out(jsonEnvelope("replay", results));
  return process.exit(worst);
}

type MarginKind = "max" | "min";
interface MarginRow {
  key: string;
  kind: MarginKind; // "max" = a ceiling (headroom = budget/recorded); "min" = a floor (headroom = recorded/budget)
  budget: number;
  recorded: number | null; // null = not derivable from a bare cassette replay in v1
  margin: number | null; // headroom ratio; null when recorded is null
}

/** Count-bound assertion keys `verify-cassettes --margins` folds a recorded count for. EXPLICIT and kept in
 *  sync with the schema — a key missing here silently drops from the margin report. The 6 budget-field keys
 *  reuse `budgetFields` (identical to what the asserts evaluate); the array-count keys read the same RunResult
 *  fields the AssertContext builder does. `questions_count_max` counts SUB-questions off the re-drive's
 *  `decisions[]` (matching the assert, which folds `rec.questions`); a controlOut-less cassette re-drives with
 *  no question decisions, so `computeCassetteMargins` nulls its recorded count there (see the guard below)
 *  rather than report a false-infinite margin off a spurious 0. */
const COUNT_BOUND_MARGIN_KEYS: {
  key: keyof Assertion;
  kind: MarginKind;
  recorded: (r: RunResult, bf: ReturnType<typeof budgetFields>) => number | undefined;
}[] = [
  { key: "tool_calls_max", kind: "max", recorded: (_r, bf) => bf.toolCallsTotal },
  { key: "max_tokens", kind: "max", recorded: (_r, bf) => bf.tokensTotal },
  { key: "max_cost_usd", kind: "max", recorded: (_r, bf) => bf.costUsd },
  { key: "max_turns", kind: "max", recorded: (_r, bf) => bf.turns },
  { key: "max_tool_errors", kind: "max", recorded: (_r, bf) => bf.toolErrorsTotal },
  { key: "max_redundant_tool_calls", kind: "max", recorded: (_r, bf) => bf.redundantCallsTotal },
  { key: "dispatch_count_max", kind: "max", recorded: (r) => r.subagents?.length },
  { key: "task_count_min", kind: "min", recorded: (r) => r.tasks?.length },
  {
    key: "gate_answer_count_min",
    kind: "min",
    recorded: (r) => (r.gateDeliveries === undefined ? undefined : r.gateDeliveries.filter((g) => g.delivered === true).length),
  },
  // Sub-question total, matching what `questions_count_max` evaluates (assert.ts folds `rec.questions`, one
  // entry per sub-question). Summed off `decisions[].questions` — populated on the replay re-drive.
  {
    key: "questions_count_max",
    kind: "max",
    recorded: (r) => (r.decisions ?? []).filter((d) => d.kind === "question").reduce((sum, d) => sum + (d.questions?.length ?? 0), 0),
  },
];

/** Fold the recorded count for each count-bound assert in a cassette's frozen block by replaying it
 *  (token-free). Returns [] when the cassette carries no count-bound asserts, so `--margins` skips a
 *  needless replay for those cassettes. A SINGLE-SAMPLE estimate — one cassette is not a variance. */
async function computeCassetteMargins(cassette: Cassette, cassetteDir: string, sessionOverride?: string): Promise<MarginRow[]> {
  const present = COUNT_BOUND_MARGIN_KEYS.map((spec) => {
    const entry = (cassette.scenario.assert ?? []).find((a) => (a as Record<string, unknown>)[spec.key as string] !== undefined);
    const budget = entry ? Number((entry as Record<string, unknown>)[spec.key as string]) : undefined;
    return budget !== undefined && Number.isFinite(budget) ? { spec, budget } : undefined;
  }).filter((x): x is { spec: (typeof COUNT_BOUND_MARGIN_KEYS)[number]; budget: number } => x !== undefined);
  if (present.length === 0) return [];
  const result = await replayCassette(cassette, [], { cassetteDir, sessionOverride });
  const bf = budgetFields(result);
  const hasControlOut = !!cassette.controlOut?.length;
  return present.map(({ spec, budget }) => {
    // A controlOut-less cassette re-drives with no question decisions (a truncated/legacy recording), so its
    // sub-question count is a spurious 0 → a false-infinite margin. Report "not derivable" (null) instead.
    const rec = spec.key === "questions_count_max" && !hasControlOut ? undefined : spec.recorded(result, bf);
    const recorded = rec === undefined ? null : rec;
    let margin: number | null = null;
    if (recorded !== null)
      margin = spec.kind === "max" ? (recorded === 0 ? Infinity : budget / recorded) : budget === 0 ? Infinity : recorded / budget;
    return { key: spec.key as string, kind: spec.kind, budget, recorded, margin };
  });
}

/** `verify-cassettes <file|dir>` — the CI gate (token/agent-free). Runs the privacy scan and the
 *  staleness check over one cassette or every `*.cassette.json` in a dir (non-recursive). Exit codes are
 *  split by whether verification actually ran: exit 1 = verification RAN and found a real problem (a PII
 *  finding, a genuine `StalenessFinding.class` — one NOT prefixed `unverifiable-` — or scenario-prompt
 *  drift); exit 3 = verification could NOT complete (any `unverifiable-*` staleness class, a cassette
 *  format newer than this harness understands, or a per-file read error/crash). A finding always wins
 *  over an unverifiable when both occur in the same run. `unscanned` notes are informational. Dedicated
 *  JSON envelope. `--margins` adds a per-count-assert recorded-vs-budget report (a per-cassette replay
 *  cost, single-sample). */
// `verify-cassettes`' accepted flags — hoisted to exported consts (P9, same reason as REPLAY_BOOLEAN_FLAGS
// above). NOTE the six `--allow*` flags are `repeatedFlags`, not `valueFlags`: parseArgs collects a
// repeated flag's every occurrence into p.repeated[]; a plain values-flag keeps only the LAST occurrence.
// Folding these into VERIFY_CASSETTES_VALUE_FLAGS would make only the last `--allow` survive parsing — a
// semantic regression, not a refactor — so they stay a separate axis both here and in cmdVerifyCassettes's
// own `parseArgs` call below.
export const VERIFY_CASSETTES_BOOLEAN_FLAGS = [
  "--skip-privacy",
  "--skip-staleness",
  "--skip-scenario-drift",
  "--margins",
  "--allow-empty",
  "--quiet",
  "--verbose",
] as const;
export const VERIFY_CASSETTES_VALUE_FLAGS = ["--output-format", "--session"] as const;
export const VERIFY_CASSETTES_REPEATED_FLAGS = [
  "--allow",
  "--allow-domain",
  "--allow-email",
  "--allow-path",
  "--allow-machine-inventory",
  "--allow-host-inventory",
  "--allow-patterns-file",
] as const;

// Both inert on `verify-cassettes` — same verification as REPLAY_ALLOWLIST (grepped every
// `p.flags["--quiet"]`/`p.flags["--verbose"]` read site in this file: only cmdRecord's exists).
export const VERIFY_CASSETTES_ALLOWLIST: readonly UsageAllowlistEntry[] = [
  { flag: "--quiet", reason: "accepted for flag consistency; inert on this command" },
  { flag: "--verbose", reason: "accepted for flag consistency; inert on this command" },
];

// Single-sourced `verify-cassettes` usage text — see the UNIFICATION DECISION comment above RECORD_USAGE.
// Previously two independently hand-maintained strings whose --margins prose had already drifted
// (cli.ts's "recorded-vs-budget + margin per count-bound assert…" vs. this file's "reports
// recorded-vs-budget for each count-bound assert…"); the cli.ts wording is kept as the single source.
export const VERIFY_CASSETTES_USAGE =
  "usage: verify-cassettes <file|dir> [--session <file>] [--skip-privacy|--skip-staleness] [--skip-scenario-drift] [--margins] [--allow-empty] [--allow <regex>]... [--allow-domain <regex>]... [--allow-email <regex>]... [--allow-path <regex>]... [--allow-machine-inventory <regex>]... [--allow-host-inventory <regex>]... [--allow-patterns-file <path>]... [--output-format json]\n" +
  "       --allow <regex> is a PATTERN (matched against a finding); --allow-patterns-file <path> is a FILE of patterns, one regex per line — not a path to allow.\n" +
  "       --margins: recorded-vs-budget + margin per count-bound assert (adds a per-cassette replay cost; single-sample estimate). Diagnostic only — never changes the gate verdict.\n" +
  "       --allow-empty: a directory that EXISTS but holds no cassettes exits 0 instead of the default loud 2 — for a repo that deliberately commits none. A missing/typo'd path still fails.\n" +
  "       --session <file>: resolve the cassette's skill sources from THIS session instead of the recorded cassette-relative path. The escape hatch for a MOVED cassette: a cassette stores `session:` relative to its own directory, so any relocation (git mv, a repo reorg, a copy into another project) leaves staleness unverifiable with no way to say where the tree went. Supplies a SESSION, not bare directories, so the session-level `staleness.hash_ignore` and the rest of the hash boundary survive the override. One cassette at a time — refused for a directory batch, since each cassette may have been recorded against a different source. The resolved path is echoed on stderr: an override that silently pinned the wrong tree would manufacture false greens.";

// The full flag-coverage guard registry (P9) — see the UsageGuardEntry doc comment above RECORD_ALLOWLIST.
// Defined here (after all three commands' consts exist) so it can reference them directly.
export const USAGE_GUARD_REGISTRY: readonly UsageGuardEntry[] = [
  {
    command: "record",
    booleanFlags: RECORD_BOOLEAN_FLAGS,
    valueFlags: RECORD_VALUE_FLAGS,
    repeatedFlags: [],
    aliases: { "-q": "--quiet" },
    usage: RECORD_USAGE,
    allowlist: RECORD_ALLOWLIST,
  },
  {
    command: "replay",
    booleanFlags: REPLAY_BOOLEAN_FLAGS,
    valueFlags: REPLAY_VALUE_FLAGS,
    repeatedFlags: REPLAY_REPEATED_FLAGS,
    aliases: { "-q": "--quiet" },
    usage: REPLAY_USAGE,
    allowlist: REPLAY_ALLOWLIST,
  },
  {
    command: "verify-cassettes",
    booleanFlags: VERIFY_CASSETTES_BOOLEAN_FLAGS,
    valueFlags: VERIFY_CASSETTES_VALUE_FLAGS,
    repeatedFlags: VERIFY_CASSETTES_REPEATED_FLAGS,
    aliases: { "-q": "--quiet" },
    usage: VERIFY_CASSETTES_USAGE,
    allowlist: VERIFY_CASSETTES_ALLOWLIST,
  },
];

export async function cmdVerifyCassettes(args: string[]) {
  // Up-front JSON detection (see cmdRecord) so every error path emits the shared envelope in JSON mode.
  const asJson = isJsonOutput(args);
  let p;
  try {
    p = parseArgs(args, {
      // Flag SETS are the exported VERIFY_CASSETTES_* consts above — do not fork this list back into a
      // local literal (P9 generalized P3's fix here too).
      booleans: [...VERIFY_CASSETTES_BOOLEAN_FLAGS],
      values: [...VERIFY_CASSETTES_VALUE_FLAGS],
      repeated: [...VERIFY_CASSETTES_REPEATED_FLAGS],
      enums: { "--output-format": ["text", "json"] },
      noDashValue: ["--allow-patterns-file"],
      aliases: { "-q": "--quiet" },
    });
  } catch (e) {
    return fail("verify-cassettes", "usage", String((e as Error).message), undefined, asJson);
  }
  const json = p.options["--output-format"] === "json";
  // Ship A escape hatch, same contract as `replay --session`: supplies a SESSION (so `staleness.hash_ignore`
  // and the rest of the boundary survive) for ONE relocated cassette. Refused for a batch — each cassette in a
  // directory may have been recorded against a different source, and silently pinning the wrong tree would
  // manufacture false greens, which is strictly worse than this command's honest exit 3.
  const vcSessionOverride = p.options["--session"];
  const skipPrivacy = p.flags["--skip-privacy"] ?? false;
  const skipStaleness = p.flags["--skip-staleness"] ?? false;
  if (skipPrivacy && skipStaleness) {
    return fail(
      "verify-cassettes",
      "usage",
      "verify-cassettes: --skip-privacy and --skip-staleness are mutually exclusive (together they'd check nothing)",
      undefined,
      asJson,
    );
  }
  const doPrivacy = !skipPrivacy;
  const doStaleness = !skipStaleness;
  const doScenarioDrift = !(p.flags["--skip-scenario-drift"] ?? false);
  const doMargins = p.flags["--margins"] ?? false; // diagnostic only — never affects the gate verdict/exit
  // Allow model: each entry is whole-token anchored + class-scoped. A bare `--allow <regex>` is a single
  // PATTERN applied to every class (back-compat); `--allow-domain`/`--allow-email`/`--allow-path`/
  // `--allow-machine-inventory` scope a pattern to one class so a domain allow can't bleed into the
  // email tripwire. `--allow-patterns-file <path>` is a different thing: it loads bare (all-class)
  // patterns from a version-controlled FILE of patterns, one regex per line, `#` comments and blanks
  // ignored — not "allow this file" (the flag does not accept a path to allow, it accepts a path to a
  // patterns list).
  const allow: AllowPattern[] = [];
  const addAllow = (src: string, cls: string | undefined, flag: string): void => {
    try {
      allow.push({ cls, re: new RegExp(src, "i") });
    } catch {
      return fail("verify-cassettes", "usage", `${flag}: invalid regex: ${src}`, undefined, asJson);
    }
  };
  for (const src of p.repeated["--allow"] ?? []) addAllow(src, undefined, "--allow");
  for (const src of p.repeated["--allow-domain"] ?? []) addAllow(src, "domain", "--allow-domain");
  for (const src of p.repeated["--allow-email"] ?? []) addAllow(src, "email", "--allow-email");
  for (const src of p.repeated["--allow-path"] ?? []) addAllow(src, "path", "--allow-path");
  for (const src of p.repeated["--allow-machine-inventory"] ?? []) addAllow(src, "machine-inventory", "--allow-machine-inventory");
  for (const src of p.repeated["--allow-host-inventory"] ?? []) addAllow(src, HOST_INVENTORY_CLS, "--allow-host-inventory");
  for (const file of p.repeated["--allow-patterns-file"] ?? []) {
    let body: string;
    try {
      body = readFileSync(file, "utf8");
    } catch (e) {
      return fail("verify-cassettes", "usage", `--allow-patterns-file: cannot read ${file}: ${(e as Error).message}`, undefined, asJson);
    }
    for (const raw of body.split("\n")) {
      const line = raw.trim();
      if (line && !line.startsWith("#")) addAllow(line, undefined, `--allow-patterns-file (${file})`);
    }
  }
  const target = p.positionals[0];
  if (!target) {
    return fail("verify-cassettes", "usage", VERIFY_CASSETTES_USAGE, undefined, asJson);
  }
  if (p.positionals.length > 1) {
    return fail(
      "verify-cassettes",
      "usage",
      `verify-cassettes takes one <file|dir> (got ${p.positionals.length}: ${p.positionals.join(", ")})`,
      undefined,
      asJson,
    );
  }
  const resolved = resolveInputs(target, ".cassette.json");
  if ("error" in resolved) {
    // `--allow-empty` opts into "a cassette-free directory is a clean pass" — for a repo that deliberately
    // keeps no committed cassettes (e.g. one whose CI gate is the token-free static lane), where the
    // default loud exit-2 forces every caller to wrap this command in an `ls` guard.
    //
    // Scoped to `empty-dir` ONLY, never `not-found`. Both arrive as `{error}`, and honoring the flag for
    // both would exit 0 on a typo'd or moved path — silently reporting "verified" for a directory that
    // does not exist. That is the vacuous pass this command's loud default exists to prevent, and the
    // caller most likely to hit it is the scripted CI job the flag is FOR.
    // An override must never be silently unconsumed. `--skip-staleness --session` is refused for exactly
    // this reason, and an empty directory is still a DIRECTORY target, which `--session` refuses anyway.
    // Returning ok:true here would skip the directory refusal, the "not a session file" check and the
    // announcement in one go.
    if (resolved.kind === "empty-dir" && (p.flags["--allow-empty"] ?? false) && vcSessionOverride === undefined) {
      const empty = { command: "verify-cassettes", ok: true, coverage: { privacy: doPrivacy, staleness: doStaleness }, results: [] };
      if (json) out(JSON.stringify(empty));
      else if (!p.flags["--quiet"]) log(`✓ verify-cassettes: no cassettes under ${target} — nothing to verify (--allow-empty)`);
      return;
    }
    return fail("verify-cassettes", "usage", `verify-cassettes: ${resolved.error}`, undefined, asJson);
  }
  const files = resolved.files;
  const vcTargetIsDir = existsSync(target) && statSync(target).isDirectory();
  if (vcSessionOverride !== undefined && (vcTargetIsDir || files.length > 1)) {
    return fail(
      "verify-cassettes",
      "usage",
      `verify-cassettes --session <file> names one cassette's session and is not valid for a directory target (${files.length} cassette(s)) — run it per cassette`,
      undefined,
      json,
    );
  }
  if (vcSessionOverride !== undefined && (!existsSync(vcSessionOverride) || !statSync(vcSessionOverride).isFile())) {
    return fail("verify-cassettes", "usage", `verify-cassettes --session: not a session file: ${vcSessionOverride}`, undefined, json);
  }
  if (vcSessionOverride !== undefined && skipStaleness) {
    // `--session` exists only to resolve skill sources for the staleness check. With --skip-staleness
    // nothing reads it, so accepting it and announcing "override in effect" advertises a resolution that
    // never happens.
    return fail(
      "verify-cassettes",
      "usage",
      "verify-cassettes --session has no effect with --skip-staleness — drop one of them",
      undefined,
      json,
    );
  }
  // An inline scenario has no session file, so an override can never apply. Refuse BEFORE announcing:
  // announcing first prints "override in effect: … -> <dirs>" directly above "this cassette records an
  // inline scenario, which has no session file to override" — a self-contradiction, and the exact shape
  // both commands are meant to avoid. (The per-cassette refusal below still covers a directory batch.)
  if (vcSessionOverride !== undefined && files.length === 1) {
    const only = readCassette(files[0]);
    if (!("error" in only) && only.cassette.scenario.session === "(inline)") {
      return fail(
        "verify-cassettes",
        "usage",
        "verify-cassettes --session: this cassette records an inline scenario, which has no session file to override — remove --session",
        undefined,
        asJson,
      );
    }
  }
  if (vcSessionOverride !== undefined) {
    // Name the DIRS, not just the file: the dirs are what feed the hash, and they are what a wrong
    // override gets wrong. "override in effect: <path>" alone would look right while resolving to
    // nothing — the silent-false-green shape this flag must never have.
    const od = skillSourceDirs(vcSessionOverride, undefined);
    const where = od.dirs.length
      ? od.dirs.join(", ")
      : od.failure?.kind === "declared-dirs-missing"
        ? `NO usable skill dirs — it declares ${od.failure.declared} but none exist (mounts are relative to the session's own directory)`
        : od.failure?.kind === "unreadable"
          ? "NO skill dirs — this session could not be read or parsed"
          : od.failure?.kind === "not-found"
            ? "NO skill dirs — no file at that path"
            : "NO skill dirs — this session declares none";
    warn(`::notice:: [verify-cassettes] --session override in effect: ${vcSessionOverride} -> ${where}\n`);
  }
  const results = files.map((f) => {
    try {
      return verifyOneCassette(f);
    } catch (e) {
      // A per-file crash must be TALLIED as that file's error, never abort the batch (results:[] reads
      // as "nothing to report" — a false-green by abort). Mirrors cmdReplay's per-file catch. A crash
      // is a bug to report, not staleness — it lands in `error` (exit 3, "could not verify"), never in
      // `staleness`/`findings` (exit 1, "verified and failed").
      return {
        file: f,
        findings: [],
        staleness: [],
        unverifiable: [],
        notes: [],
        version: [],
        scenarioDrift: [],
        error: (e as Error)?.message ?? String(e),
        privacyScanned: false, // a crash mid-verify never completed the scan, whatever it crashed on
      };
    }
  });
  function verifyOneCassette(f: string) {
    const rc = readCassette(f);
    // `--session` names a session FILE, and an inline scenario has none. Refuse rather than accept it,
    // announce "override in effect", and then silently ignore it.
    if (vcSessionOverride !== undefined && "cassette" in rc && rc.cassette.scenario.session === "(inline)") {
      return fail(
        "verify-cassettes",
        "usage",
        `verify-cassettes --session: this cassette records an inline scenario, which has no session file to override — remove --session`,
        undefined,
        json,
      );
    }
    if ("error" in rc) {
      // SHAPE INVALID — but that only blocks the STALENESS half. The privacy scan needs a readable
      // transcript, not a valid document, so try the narrow scan-only door before giving up. Before this,
      // a file that failed shape validation was reported with zero findings and never scanned at all,
      // which reads in every summary as "0 PII findings" — a clean-looking number from an instrument that
      // never ran. A file too broken to replay is exactly the kind a leak arrives in.
      const scanOnly = doPrivacy ? readCassetteForScan(f) : { error: "privacy scan disabled" };
      const salvaged = "scannable" in scanOnly ? scanCassette(scanOnly.scannable, allow) : [];
      return {
        file: f,
        findings: salvaged,
        staleness: [],
        unverifiable: [],
        notes: [],
        version: [],
        scenarioDrift: [],
        error: rc.error,
        // The honest signal, and the one the pre-commit gate keys on: did the privacy scan actually run?
        // `error` alone cannot answer that any more — it now covers both "never scanned" and "scanned
        // fine, just not replayable". Conflating them is what made the gate block on an eval fixture it
        // could in fact scan.
        privacyScanned: doPrivacy && "scannable" in scanOnly,
      };
    }
    const findings = doPrivacy ? scanCassette(rc.cassette, allow) : [];
    // Direct computeStaleness call (not the checkStaleness string adapter) so the NON-failing `notes`
    // channel reaches the envelope — a note (e.g. pre-effectiveFidelity explicit-tier) must be surfaced,
    // never dropped, and must never red the gate.
    const stale = doStaleness ? computeStaleness(rc.cassette, dirname(f), vcSessionOverride) : { findings: [], notes: [] };
    // Class-based split (StalenessFinding.class, src/types.ts): every `unverifiable-*` class means
    // "verification could not run" (exit 3), while every other class is a genuine drift finding
    // (exit 1) — preserve the class instead of collapsing straight to `.message` (that used to drop it,
    // which is exactly how a version-refused cassette false-greened an inverted "must-fail" canary: it
    // exited non-zero, just not for the reason the canary was checking).
    const staleness = stale.findings.filter((s) => !s.class.startsWith("unverifiable-")).map((s) => s.message);
    const unverifiable = stale.findings.filter((s) => s.class.startsWith("unverifiable-")).map((s) => s.message);
    const notes = [...stale.notes];
    // Session-shape fingerprint drift (Finding 23): gated by the SAME --skip-staleness toggle (it's a
    // staleness concept — session SHAPE, not skill content) but computed and hard-failed HERE ONLY, never
    // through computeStaleness/checkStaleness — so it can never affect the default `replay` verdict. A
    // pre-v9 cassette (no sessionFingerprint) is silently not checked; see sessionFingerprintDrift.
    if (doStaleness) {
      // F51: reuse the SAME "is this cassette's relative-offset resolution intact" signal
      // scenarioContentDrift (below) computes for the scenario source — the session path resolves via
      // the identical relative-to-cassetteDir mechanism, so a broken offset is equally untrustworthy
      // for either. Cheap (an existsSync probe or two), safe to compute unconditionally here.
      // #51: downgrade ONLY when a PERSISTED source path broke (persistedMissing) — that is the actual
      // "cassette relocated off its tree" signal. A cassette with NO persisted source at all also resolves
      // `via: "name-lookup"`, but that is not evidence of relocation, so it must keep the hard-fail (else a
      // programmatic-record cassette would silently downgrade every genuine session drift → false-green).
      const rr = _resolveRerecordSource(f, rc.cassette);
      const sourceVia = rr.persistedMissing ? "name-lookup" : "none";
      const sfd = sessionFingerprintDrift(rc.cassette, dirname(f), sourceVia, vcSessionOverride);
      if (sfd.drifted)
        staleness.push(
          "session-shape fingerprint differs from the current session file (connected folders/plugins/skills/mcp/egress/web_fetch config changed since record; projects and agent_env are hashed only when set) — re-record",
        );
      if (sfd.note) notes.push(sfd.note);
    }
    // Scenario-content (prompt) drift: the fingerprint doesn't cover the scenario's own prompt, so an
    // edited-but-not-re-recorded prompt would otherwise pass clean. A resolvable+drifted prompt is a hard
    // fail (its own bucket, so --skip-staleness can't mask it); an unresolvable/unparseable source is a
    // non-failing note (can't compare ⇒ not a false-red).
    const scenarioDrift: string[] = [];
    if (doScenarioDrift) {
      const drift = scenarioContentDrift(rc.cassette, f);
      if (drift.verifiable) {
        if (drift.drifted.length)
          scenarioDrift.push(
            `scenario recording-shaping field(s) [${drift.drifted.join(", ")}] differ from the cassette's frozen copy — the frozen events no longer correspond to this scenario; re-record or \`replay --assert-from\``,
          );
      } else if (drift.reason) {
        // Only when a resolvable source failed to parse — the common "no committed source" case is silent.
        notes.push(`scenario-drift: ${drift.reason}`);
      }
    }
    // a cassette written by a NEWER harness version may carry semantics this version can't correctly
    // interpret. This is a FORMAT/version failure, NOT staleness — bucket it under its own `version`
    // key so `--skip-staleness` doesn't produce the self-contradiction of coverage.staleness:false
    // reported alongside a staleness-class ok:false. It is always a hard fail (can't verify ⇒ not green),
    // independent of the staleness toggle.
    const recordedVersion = rc.cassette.cassetteVersion ?? 0;
    const version =
      recordedVersion > CASSETTE_VERSION
        ? [
            `cassette format v${recordedVersion} is newer than this harness understands (v${CASSETTE_VERSION}) — upgrade cowork-harness (can't verify ⇒ not green)`,
          ]
        : [];
    return {
      file: f,
      findings,
      staleness,
      unverifiable,
      notes,
      version,
      scenarioDrift,
      error: undefined as string | undefined,
      privacyScanned: doPrivacy, // false under --skip-privacy: "we did not look" is not "we looked and it was clean"
    };
  }
  // --margins (diagnostic; never affects the gate): replay each cassette that carries count-bound asserts
  // and report recorded-vs-budget + margin. A per-cassette replay cost the base command doesn't have.
  let margins: { file: string; rows: MarginRow[]; error?: string }[] | undefined;
  if (doMargins) {
    margins = [];
    for (const f of files) {
      const rc = readCassette(f);
      if ("error" in rc) continue; // unreadable — already flagged in `results`; skip its margins
      try {
        const rows = await computeCassetteMargins(rc.cassette, dirname(f), vcSessionOverride);
        if (rows.length) margins.push({ file: f, rows });
      } catch (e) {
        margins.push({ file: f, rows: [], error: (e as Error)?.message ?? String(e) }); // a diagnostic failure must not red the gate
      }
    }
  }
  const realFindings = results.flatMap((r) => r.findings.filter((x) => x.cls !== "unscanned"));
  const staleAny = results.some((r) => r.staleness.length > 0);
  const unverifiableAny = results.some((r) => r.unverifiable.length > 0);
  const unverifiableCount = results.reduce((n, r) => n + r.unverifiable.length, 0);
  const versionAny = results.some((r) => r.version.length > 0);
  const scenarioDriftAny = results.some((r) => r.scenarioDrift.length > 0);
  const errorAny = results.some((r) => r.error !== undefined);
  // Exit-code split (per-command; distinct from the run/skill family's exit 3 = boundary/integrity):
  //  - a real problem (a PII finding, a genuine (non-unverifiable-*) staleness finding, or scenario-prompt
  //    drift) VERIFIED and FAILED → exit 1. A real finding is the stronger signal: it wins even when the
  //    SAME run also carries an unverifiable/version/error entry elsewhere.
  //  - otherwise, anything that means verification COULD NOT complete (unverifiable-* staleness, a
  //    cassette from a version this harness can't read, or a per-file read error/crash) → exit 3. This is
  //    the split that keeps an inverted "any non-zero = tripwire fired" canary from false-greening on a
  //    version-refused cassette instead of the finding it was meant to catch.
  const hasFinding = realFindings.length > 0 || staleAny || scenarioDriftAny;
  const hasUnverifiable = unverifiableAny || versionAny || errorAny;
  const ok = !hasFinding && !hasUnverifiable;
  const exitCode = ok ? 0 : hasFinding ? 1 : 3;
  const coverage = { privacy: doPrivacy, staleness: doStaleness, scenarioDrift: doScenarioDrift };
  if (json) {
    out(jsonPayloadEnvelope("verify-cassettes", ok, { coverage, results, ...(margins ? { margins } : {}) }));
  } else {
    if (!doStaleness) log("⚠ cowork-harness: --skip-staleness: staleness check was skipped");
    if (!doPrivacy) log("⚠ cowork-harness: --skip-privacy: privacy scan was skipped");
    if (!doScenarioDrift) log("⚠ cowork-harness: --skip-scenario-drift: scenario prompt-drift check was skipped");
    // A per-class count, printed ONCE ahead of the per-file rows. A sweep that surfaces hundreds of
    // findings of a single class reads as hundreds of separate problems; a consumer piped the output
    // through `uniq -c` to discover 240 findings were one class with one cause. This is additive — every
    // per-file row below still prints, so the attribution the `notes` rationale protects is untouched.
    // It answers "what kind, and how many" before the reader starts scrolling, not instead of it.
    const byClass = new Map<string, number>();
    for (const r of results) for (const f of r.findings) byClass.set(f.cls, (byClass.get(f.cls) ?? 0) + 1);
    if (byClass.size)
      log(
        `findings by class: ${[...byClass.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([cls, n]) => `${cls} ${n}`)
          .join(" · ")}`,
      );
    for (const r of results) {
      if (r.error) log(`✗ ${r.file}: [error] ${r.error}`);
      for (const f of r.findings) log(`${f.cls === "unscanned" ? "·" : "✗"} ${r.file}: [${f.cls}] ${f.where} — ${f.sample}`);
      for (const s of r.staleness) log(`✗ ${r.file}: [stale] ${s}`);
      // Distinct token from `[stale]` — this class could NOT be verified (exit 3), it isn't a confirmed
      // drift finding (exit 1). Same ✗ severity marker: it still means "not clean", just for a different reason.
      for (const u of r.unverifiable) log(`✗ ${r.file}: [unverifiable] ${u}`);
      for (const d of r.scenarioDrift) log(`✗ ${r.file}: [scenario-drift] ${d}`);
      // Informational, never fails the gate (the `·` row mirrors the privacy channel's `unscanned` precedent).
      // Per-file on purpose — NOT aggregated like `replay <dir>`. verify-cassettes is a per-file AUDIT:
      // which file carries which note is the answer you came for, and collapsing that to a count would
      // destroy the attribution. The two reasons to aggregate in replay do not apply here either: this
      // uses log() (no ::warning::/::notice:: annotation at all), and a verify sweep is expected to
      // enumerate files. Deliberate asymmetry, not an oversight.
      for (const n of r.notes) log(`· ${r.file}: [note] ${n}`);
      for (const v of r.version) log(`✗ ${r.file}: [version] ${v}`);
    }
    log(
      ok
        ? `✓ verify-cassettes: ${files.length} cassette(s) clean`
        : `✗ verify-cassettes: ${realFindings.length} PII finding(s)${staleAny ? " + staleness drift" : ""}${scenarioDriftAny ? " + scenario prompt drift" : ""}${unverifiableCount > 0 ? ` + ${unverifiableCount} unverifiable` : ""}${versionAny ? " + version mismatch" : ""}${errorAny ? " + unreadable cassette(s)" : ""} across ${files.length} cassette(s) (exit ${exitCode})`,
    );
    if (!ok)
      log(
        "  exit 1 = verified & failed (a real finding); exit 3 = could not verify (unresolvable baseline/skill/tier, an unsupported cassette version, or a per-file read ERROR/CRASH — that's a bug to report, not a signal to re-record). A cassette that fails SHAPE validation is still privacy-scanned; `privacyScanned` in --output-format json says whether the scan ran.",
      );
    if (margins) {
      log(
        "\ncount-budget margins (recorded vs budget; a SINGLE-SAMPLE estimate — one cassette ≠ variance, use `run --repeat` for a distribution):",
      );
      if (margins.length === 0) log("  (no count-bound assertions in the checked cassette(s))");
      for (const m of margins) {
        log(`  ${m.file}:`);
        if (m.error) log(`    [margins error] ${m.error}`);
        for (const r of m.rows) {
          const rec = r.recorded === null ? "unavailable" : String(r.recorded);
          const marg = r.margin === null ? "n/a" : r.margin === Infinity ? "∞" : `${r.margin.toFixed(1)}×`;
          const tight = typeof r.margin === "number" && r.margin < 1.5 ? "  ⚠ tight" : "";
          log(`    ${r.key}: recorded=${rec}, budget=${r.budget} → margin ${marg}${tight}`);
        }
      }
    }
  }
  return process.exit(exitCode);
}

/** `cowork-harness rehash <dir/> [--dry-run] [--output-format text|json]`
 *  `cowork-harness rehash <file.cassette.json> --session <session.yaml>`
 *
 *  Migrates cassettes recorded under an older `cassetteVersion` — including across a HASH-FORMAT epoch —
 *  to the current version WITHOUT a full re-record, but ONLY when the content is provably unchanged.
 *
 *  The proof recomputes the recording's digest under the **ORIGINAL** algorithm and compares it to what was
 *  stored. `contentSig` is deliberately NOT the proof: it follows the same manifest transform `skillHash`
 *  does, so it is not comparable across a format change either, and it is blind to `D:` directory markers,
 *  so an added empty directory would slip past it while the real digest moved. `mode` and agent-scope must
 *  match as well, since both change which files are hashed.
 *
 *  Anything unprovable is REFUSED, never migrated. `--session` supplies the tree for a cassette that moved.
 *  Safe to run repeatedly: already-current cassettes are reported as skipped. */
export function cmdRehash(args: string[]): void {
  // isJsonOutput (not a bare `p.options` read): it works even when parseArgs throws below, and honors the
  // --output-format=json equals-form and the COWORK_HARNESS_OUTPUT_FORMAT env var a bare check would miss.
  const asJson = isJsonOutput(args);
  let p;
  try {
    p = parseArgs(args, {
      booleans: ["--dry-run"],
      values: ["--output-format", "--session"],
      enums: { "--output-format": ["text", "json"] },
    });
  } catch (e) {
    return fail("rehash", "usage", (e as Error).message, undefined, asJson);
  }
  const USAGE =
    "usage: rehash <dir/> [--dry-run] [--output-format text|json]   |   rehash <file.cassette.json> --session <session.yaml> [--dry-run]";
  if (p.positionals.length !== 1) {
    return fail("rehash", "usage", USAGE, undefined, asJson);
  }
  const target = p.positionals[0];
  const sessionOverride = p.options["--session"];
  // A MOVED cassette cannot resolve its recorded `session:` from its own directory, so it can never be
  // proved unchanged — and the hash-format epoch makes migration MANDATORY, which would leave it failing
  // every bare replay with no remedy at all. Mirrors `replay --session`: ONE cassette at a time, because
  // each may have been recorded against a different tree, so a directory batch cannot share one override.
  if (sessionOverride !== undefined) {
    if (!existsSync(target) || statSync(target).isDirectory()) {
      return fail("rehash", "usage", `rehash --session takes a single cassette FILE, not a directory: ${target}`, undefined, asJson);
    }
    // `isFile()` too, matching `replay --session`: a directory otherwise passes the existence gate and only
    // surfaces much later as "skill dirs not resolvable", which reads as a cassette problem rather than a
    // typo in the flag. One flag, one contract.
    if (!existsSync(sessionOverride) || !statSync(sessionOverride).isFile()) {
      return fail("rehash", "usage", `rehash --session: not a session file: ${sessionOverride}`, undefined, asJson);
    }
  } else if (!existsSync(target) || !statSync(target).isDirectory()) {
    const hint = existsSync(target) ? " — pass a directory, or a single cassette with --session <session.yaml>" : "";
    return fail("rehash", "usage", `rehash: not a directory: ${target}${hint}`, undefined, asJson);
  }
  const dir = target;

  const dryRun = p.flags["--dry-run"] ?? false;

  let liveBaseline: string;
  try {
    liveBaseline = loadBaseline("latest").appVersion;
  } catch (e) {
    return fail("rehash", "runtime", `rehash: cannot load latest baseline — ${(e as Error).message}`, undefined, asJson, 1);
  }

  const files =
    sessionOverride !== undefined
      ? [dir] // single-cassette mode: `dir` is the file itself, guarded above
      : readdirSync(dir)
          .filter((f) => f.endsWith(".cassette.json"))
          .sort()
          .map((f) => join(dir, f));

  if (files.length === 0) {
    if (asJson) out(jsonPayloadEnvelope("rehash", true, { dryRun, migrated: 0, skipped: 0, errors: 0, results: [] }));
    else log("✓ rehash: nothing to migrate — no cassettes in directory");
    return process.exit(0);
  }

  type Action = "migrated" | "skipped" | "error";
  const results: { file: string; action: Action; reason: string }[] = [];

  for (const file of files) {
    const rc = readCassette(file);
    if ("error" in rc) {
      results.push({ file, action: "error", reason: rc.error });
      continue;
    }
    const { cassette } = rc;
    const recordedVersion = cassette.cassetteVersion ?? 0;
    // The version THIS scenario requires — not CASSETTE_VERSION (the build's max). Without this,
    // `rehash` would bump a lane-free v10 cassette to v11 for no interpretive reason, reintroducing the
    // blanket cost P8 exists to avoid via the very command this plan names as the recovery path.
    const requiredVersion = requiredVersionFor(cassette.scenario);

    // INVARIANT BEFORE SKIP. `cassetteVersion` says which reader is required; `fingerprint.hashFormat`
    // says which transform produced the digests. Nothing ties them together, and the skip below returns
    // before anything inspects the fingerprint — so a v12 cassette missing `hashFormat` would be waved
    // through as current while carrying legacy digests, and the "absent means legacy" rule would then
    // mis-read it forever.
    // Same binding as the read boundary, and deliberately NOT gated on `skillHash`: a baseline-only v12
    // fingerprint without `hashFormat` is just as inconsistent, and gating would skip it as "current".
    if (recordedVersion === HASH_FORMAT_EPOCH && cassette.fingerprint !== undefined && cassette.fingerprint.hashFormat !== "jcs1") {
      results.push({
        file,
        action: "error",
        reason: `v${recordedVersion} cassette is missing fingerprint.hashFormat — inconsistent with its stamped version; re-record`,
      });
      continue;
    }
    // Already at (or above) the version this scenario requires — nothing to do.
    if (recordedVersion >= requiredVersion) {
      results.push({ file, action: "skipped", reason: `already at v${recordedVersion}` });
      continue;
    }

    // v10 records symlink/hardlink identity (ManifestEntry.linkKind) that the CONTENTSIG algorithm is
    // blind to, so `rehash`'s content-unchanged check cannot vouch for it — and rehash has only the old
    // manifest, not the vanished work tree, so it cannot synthesize the link entries a v10 cassette
    // promises. A silent version-stamp would mint a v10-labeled cassette that never actually captured its
    // links. Route a v9→v10 bump to a re-record. Placed AFTER the "already current" skip but this only
    // needs to block the eventual STAMP — the content/baseline gates below still run and their own
    // error reasons (content mismatch, unreadable sources, mode/agent-scope change) fire first, so this is reached only when a cassette would
    // otherwise have migrated cleanly.
    const crossesIntoV10 = recordedVersion < 10 && requiredVersion >= 10;

    // No fingerprint — no skill dirs were tracked; only baseline staleness applies, which requires re-record.
    if (!cassette.fingerprint?.skillHash) {
      // NO skillHash. `buildFingerprint` omits it in TWO different situations — genuinely zero skill
      // sources, and files that could not be read ("can't verify"). Treating both as "nothing to prove"
      // would bless an UNVERIFIABLE recording as current-format, so absence alone is not evidence.
      //
      // A metadata-only restamp needs POSITIVE proof of the zero-source case: a recorded
      // `sessionFingerprint` that still matches a resolvable session. That says the recording's session
      // shape is intact and genuinely declared nothing to hash. Without it, refuse.
      // A matching sessionFingerprint proves the session SHAPE is intact — it does NOT prove the session
      // declared nothing to hash. A recording whose hash failed over real, declared roots has a perfectly
      // matching shape too, and migrating that would bless an unverifiable recording as current-format.
      // So: shape intact AND the session resolves AND it declares ZERO roots.
      const zeroSession = sessionOverride !== undefined ? resolve(sessionOverride) : cassette.scenario.session;
      const shapeIntact =
        cassette.sessionFingerprint !== undefined && cassette.sessionFingerprint === buildSessionFingerprint(zeroSession, dirname(file));
      // `dirs` is the SURVIVING mounts — `declaredSkillDirs` has already dropped paths that do not exist —
      // so an empty `dirs` is ambiguous between "declared nothing" and "declared roots that are all
      // missing". The second is exactly the case this proof exists to reject: a cassette recorded against a
      // typo'd plugin path has no `skillHash` BECAUSE the hash failed, and a perfectly valid
      // `sessionFingerprint`. `failure` is the discriminator the resolver already computes for this —
      // absent means "resolved fine, and it genuinely declares none". (It never throws; it reports.)
      const zeroRes = skillSourceDirs(zeroSession, dirname(file));
      const genuinelyZero = zeroRes.failure === undefined && zeroRes.dirs.length === 0;
      if (!shapeIntact || !genuinelyZero) {
        results.push({
          file,
          // ERROR, not "skipped": a pre-epoch cassette still fails every bare replay, so reporting it as
          // "nothing to migrate" lets a batch exit 0 while leaving it unlabelled and broken. A failed proof
          // is a failure, exactly like a content mismatch.
          action: "error",
          reason:
            zeroRes.failure?.kind === "declared-dirs-missing"
              ? `no skillHash, and the session declares ${zeroRes.failure.declared} skill root(s) that do not resolve — absence means the hash FAILED, not that there was nothing to hash; re-record`
              : zeroRes.failure !== undefined
                ? `no skillHash, and the session could not be resolved (${zeroRes.failure.kind}) — cannot prove the recording had zero skill sources; re-record`
                : "no skillHash, and no matching session shape to prove the recording genuinely had zero skill sources — re-record if this cassette needs to be current",
        });
        continue;
      }
      // The v9→v10 link-identity refusal applies to EVERY migration path, including this one: a v9
      // baseline-only cassette never captured the symlink identity a v10+ stamp promises, and rehash
      // cannot synthesize it. Without this the metadata branch would stamp it current regardless.
      if (crossesIntoV10) {
        results.push({
          file,
          action: "error",
          reason: `v10 records symlink/hardlink identity (#38) the v${recordedVersion} manifest could not capture — \`rehash\` cannot add it; re-record to migrate`,
        });
        continue;
      }
      if (!dryRun) {
        // Metadata-only: no digest to migrate — but the version/format invariant still applies, so the
        // fingerprint must declare the current format rather than being left to read as legacy.
        const stamped: Cassette = {
          ...cassette,
          $schema: cassetteSchemaUrl(requiredVersion),
          cassetteVersion: requiredVersion,
          ...(cassette.fingerprint ? { fingerprint: { ...cassette.fingerprint, hashFormat: ACTIVE_HASH_FORMAT } } : {}),
        };
        writeFileAtomic(file, JSON.stringify(stamped, null, 2));
      }
      results.push({ file, action: "migrated", reason: `v${recordedVersion} → v${requiredVersion} (metadata only — zero skill sources)` });
      continue;
    }

    // BASELINE DRIFT DOES NOT BLOCK A FORMAT MIGRATION. `fingerprint.baseline` is the resolved Cowork app
    // version at record time — recorded metadata, never an input to `skillHash` — so it says nothing about
    // whether the content is provably unchanged.
    //
    // Skipping on it used to be harmless: an un-migrated cassette still replayed. After the epoch it is a
    // TRAP. A pre-epoch cassette fails a bare `replay` until it is restamped, so "skip" leaves it unplayable
    // while `rehash` exits 0 and prints "nothing to migrate" — and anyone who has run `sync`, or whose
    // committed cassettes predate the current `baselines/`, hits that on every file. The release notes sell
    // `rehash` as the one-command fix; a silent no-op reporting success is the opposite of that.
    //
    // So: migrate the hashes, KEEP the recorded baseline, and let baseline drift stay what it already is —
    // its own staleness finding at verify time, which a re-record (not a rehash) resolves.
    const baselineDrifted = cassette.fingerprint.baseline !== liveBaseline;

    // ONE resolution, ONE walk: `recomputeBothAlgos` folds BOTH the legacy proof and the replacement
    // fingerprint from the SAME snapshot. A second independent walk would let a file change in between,
    // so the proof would validate one tree while the migration wrote digests from another.
    //
    // An override is resolved ABSOLUTE: `skillSourceDirs` only joins `cassetteDir` for a RELATIVE session,
    // so passing both a relative override and its own dirname would double-join them.
    // An INLINE cassette has no session file, so there is nothing an override can point at. `replay` and
    // `verify-cassettes` get this for free because `resolveCassetteSessionPath` short-circuits on the
    // sentinel BEFORE considering an override — but substituting the override AS the session path here
    // bypasses that. Without this guard, an override tree that happened to match the recorded digest would
    // report "migrated" and stamp v12/jcs1 while the cassette still says `(inline)`: a bare `replay` then
    // fails with `inline-without-config`, `replay --session` is refused, and the operator has been told the
    // cassette is current with no recovery path left.
    if (sessionOverride !== undefined && cassette.scenario.session === "(inline)") {
      results.push({
        file,
        action: "error",
        reason: "--session cannot apply to an INLINE scenario (it has no session file to override) — re-record",
      });
      continue;
    }
    const migrateSession = sessionOverride !== undefined ? resolve(sessionOverride) : cassette.scenario.session;
    const proof = recomputeBothAlgos(migrateSession, dirname(file), cassette.scenario.skills, cassette.fingerprint.baseline);
    if (!proof) {
      results.push({ file, action: "error", reason: "skill dirs not resolvable from cassette location — cannot prove content unchanged" });
      continue;
    }
    if (proof.readErrors?.length) {
      results.push({ file, action: "error", reason: "unreadable skill sources — cannot prove content unchanged; re-record" });
      continue;
    }
    // `mode` and `agentScope` change the FILE SET, so a matching digest under a different boundary proves
    // nothing about the same content.
    const recModeR = cassette.fingerprint.mode ?? "raw";
    if (recModeR !== proof.mode) {
      results.push({
        file,
        action: "error",
        reason: `recorded in '${recModeR}' file-set mode, now '${proof.mode}' — re-record under the same mode`,
      });
      continue;
    }
    if ((cassette.fingerprint.agentScope ?? "off") !== (proof.agentScoped ? "skill" : "off")) {
      results.push({ file, action: "error", reason: "agent-scope differs from the recording — re-record under the same setting" });
      continue;
    }
    if (proof.legacyHash !== cassette.fingerprint.skillHash) {
      results.push({
        file,
        action: "error",
        reason: "skill content changed since recording (legacy skillHash mismatch) — re-record required",
      });
      continue;
    }

    // Content is provably unchanged, so a pure version-stamp WOULD be safe for a hash-only bump — but a
    // v9→v10 bump also promises symlink/hardlink identity that the old manifest never captured and rehash
    // cannot synthesize. Refuse the stamp and route to a re-record (see the crossesIntoV10 note above).
    if (crossesIntoV10) {
      results.push({
        file,
        action: "error",
        reason: `v10 records symlink/hardlink identity (#38) the v${recordedVersion} manifest could not capture — \`rehash\` cannot add it; re-record to migrate`,
      });
      continue;
    }

    // Content is provably unchanged. Build the migrated fingerprint — selective, allow-listed, and able to
    // REFUSE: a manifest that cannot be aligned entry-for-entry must not be stamped `jcs1` while carrying
    // the old per-file digests, or the cassette would claim to be current while every attribution lied.
    const migrated = migrateFingerprint(cassette.fingerprint, proof.live, proof.legacySigs);
    if ("error" in migrated) {
      results.push({ file, action: "error", reason: `${migrated.error} — re-record required` });
      continue;
    }

    if (!dryRun) {
      const updated: Cassette = {
        ...cassette,
        $schema: cassetteSchemaUrl(requiredVersion),
        generator: "cowork-harness",
        cassetteVersion: requiredVersion,
        fingerprint: migrated.fingerprint,
      };
      writeFileAtomic(file, JSON.stringify(updated, null, 2)); // atomic in-place rehash write (staleness keys on contentSig, not mtime — rename is safe)
    }
    results.push({
      file,
      action: "migrated",
      reason:
        `v${recordedVersion} → v${requiredVersion}${dryRun ? " (dry-run)" : ""}` +
        (baselineDrifted
          ? ` — NOTE: baseline still reads ${cassette.fingerprint.baseline} (live ${liveBaseline}); re-record to clear that separately`
          : ""),
    });
  }

  const migrated = results.filter((r) => r.action === "migrated").length;
  const skipped = results.filter((r) => r.action === "skipped").length;
  const errors = results.filter((r) => r.action === "error").length;

  const code = rehashExitCode({ migrated, errors });

  if (asJson) {
    out(jsonPayloadEnvelope("rehash", errors === 0, { dryRun, migrated, skipped, errors, results }));
  } else {
    // Summary FIRST. It used to print last, after every per-file line had scrolled past — and these two
    // counts ARE the decision, so a reader had to scroll back up to find them. The per-file lines below
    // are the detail behind it, not the thing being reported.
    if (migrated > 0 || errors > 0) {
      const glyph = errors > 0 ? (migrated > 0 ? "!" : "✗") : "✓";
      const verb = dryRun ? "migratable" : "migrated";
      // No single target version here — P8 stamps per-scenario (requiredVersionFor), so a batch can
      // migrate some cassettes to v10 and others to v11; each row's own reason already says which.
      log(
        `${glyph} rehash: ${migrated} ${verb}` +
          (errors > 0 ? `, ${errors} require a re-record` : "") +
          (skipped > 0 ? `, ${skipped} already current` : "") +
          (dryRun ? " (dry-run — nothing written)" : ""),
      );
    } else {
      log("✓ rehash: nothing to migrate");
    }
    for (const r of results) {
      const glyph = r.action === "migrated" ? "✓" : r.action === "error" ? "✗" : "·";
      log(`${glyph} ${r.file}: ${r.reason}`);
    }
  }
  return process.exit(code);
}

/** `rehash`'s exit code, documented in SPEC §11 and in its `--help`.
 *
 *  PARTIAL success gets its own code. `4 migrated, 18 failed` and `0 migrated, 22 failed` demand opposite
 *  responses — commit the four and budget a re-record for the rest, versus nothing here is salvageable —
 *  and while both were `1`, a shell consumer reading only the exit code could not tell them apart. The
 *  JSON envelope always carried the split as `migrated`/`skipped`/`errors`; a bare terminal run did not.
 *
 *  `4` rather than `3`: the exit-code space is per-command, and `3`'s "could not verify" meaning is
 *  load-bearing on `verify-cassettes` — a migration that partly succeeded is not a failed verification.
 *
 *  `skipped` is deliberately not an input: an already-current cassette needs no action, so it cannot
 *  turn a clean run dirty or a total failure partial. */
export function rehashExitCode(tally: { migrated: number; errors: number }): 0 | 1 | 4 {
  if (tally.errors === 0) return 0;
  return tally.migrated > 0 ? 4 : 1;
}

/** Record-time connected-folder host-path -> resolved-mount-name map (Finding 24), persisted onto a
 *  v9+ cassette's `folderPrefixMap`. Zips `recordRoots` (minus the leading `outputs`) against
 *  `scenario.session`'s `folders:` in file order — the SAME positional correspondence
 *  `buildLaunchPlan` itself relies on (one mount per `session.folders` entry, in that array's order) —
 *  but computed ONCE, right now, against the exact session state that produced `recordRoots`. That's
 *  the whole point: unlike a replay-time reconstruction would be, this can never be fooled by a session
 *  file that changes AFTER record but happens to keep the same folder count. Returns undefined when the
 *  lengths disagree (an inline scenario, an unreadable/unparseable session, or a genuine mismatch) — a v9
 *  cassette with no persisted map is a signal replay must respect, not paper over (see `buildFolderPrefixMap`). */
function buildRecordTimeFolderPrefixMap(scenario: Scenario, recordRoots: string[]): Array<{ from: string; mount: string }> | undefined {
  const roots = recordRoots.filter((r) => r !== "outputs");
  const folders = loadCassetteSessionFolders(scenario.session, undefined);
  if (roots.length !== folders.length) return undefined;
  return roots.map((mount, i) => ({ from: folders[i].from, mount }));
}

/**
 * Best-effort: recover the recorded scenario's connected-folder host paths (`session.folders[].from`)
 * for `computer_links_resolve`'s replay-lane host-shaped normalization. Mirrors
 * `skillSourceDirs`' own session-file resolution above (`cassetteDir` substitutes for the scenario's
 * original directory — the re-record-clean colocation convention this repo already relies on for
 * staleness fingerprinting). Returns `[]` (never throws) when the session file can't be read — a
 * folder-shaped host link then correctly reports "no recorded prefix matched" instead of crashing replay.
 *
 * ONLY the record-time path (`buildRecordTimeFolderPrefixMap` above) calls this now. Replay never does —
 * a v9+ cassette uses its persisted `folderPrefixMap` instead of re-deriving this from whatever the
 * session file looks like AT REPLAY TIME (see `buildFolderPrefixMap`).
 */
function loadCassetteSessionFolders(sessionPath: string, cassetteDir?: string): { from: string }[] {
  if (sessionPath === "(inline)") return [];
  // Third consumer of the same join — see resolveCassetteSessionPath. NO session override here on
  // purpose: the only caller is buildRecordTimeFolderPrefixMap, which runs at RECORD time, so a
  // replay-time `--session` can never reach it. A future replay-time caller must pass one.
  const { path: resolved } = resolveCassetteSessionPath(sessionPath, cassetteDir);
  if (!existsSync(resolved)) return [];
  try {
    return resolveSessionPaths(loadSession(parseSessionFile(resolved)), dirname(resolved)).folders;
  } catch {
    return [];
  }
}

/** The result of resolving the replay-lane `folderPrefixes` map for `computer_links_resolve` (Finding
 *  24/25). `map` is the host-path -> mount-name correspondence to normalize against; `requiredButAbsent`
 *  is true ONLY for a v9+ cassette that (unexpectedly) has no persisted `folderPrefixMap` — the signal
 *  that a host-shaped folder link must be treated as evidence-unavailable rather than silently falling
 *  back to a current-session reconstruction (which is exactly the risky path v9 exists to close). */
interface FolderPrefixResolution {
  map: Map<string, string>;
  requiredButAbsent: boolean;
}

/** All cassettes read by this build are v9+ (see MIN_SUPPORTED_CASSETTE_VERSION), so folderPrefixMap
 *  is always the record-time source of truth — no reconstruction-from-session fallback is needed. */
function buildFolderPrefixMap(cassette: Cassette): FolderPrefixResolution {
  if (cassette.folderPrefixMap) return { map: new Map(cassette.folderPrefixMap.map((e) => [e.from, e.mount])), requiredButAbsent: false };
  return { map: new Map(), requiredButAbsent: true };
}

/** Assertion keys ALWAYS evaluated on replay, independent of controlOut/manifest presence. Exported as the
 *  single source of truth for anything (docs, tests) that needs to enumerate replay-evaluated keys — see
 *  `test/cassette-docs-sync.test.ts`, which asserts docs/cassette.md documents every key here. */
export const ALWAYS_CONTENT_KEYS: (keyof Assertion)[] = [
  "transcript_contains",
  "transcript_not_contains",
  "transcript_matches",
  "transcript_not_matches",
  "tool_result_contains",
  "tool_result_not_contains",
  "tool_result_matches",
  "tool_result_not_matches",
  "tool_called",
  "tool_not_called",
  "subagent_tool_used",
  "subagent_tool_absent",
  "subagent_dispatched",
  "subagent_declared_but_unused",
  "subagent_output_contains",
  "dispatch_count_max",
  "skill_triggered",
  "no_skill_triggered",
  "skill_available",
  "connector_available",
  "tool_available",
  "skill_tool_used",
  "max_cost_usd",
  "max_tokens",
  "tool_calls_max",
  "tool_no_error",
  "tool_no_error_if_called",
  "max_tool_errors",
  "max_redundant_tool_calls",
  "max_turns",
  "compaction_occurred",
  "all_tasks_completed",
  "task_count_min",
  "task_status",
  "result",
  // content-class, NOT controlOut-gated: both the present_files tool_use and its own tool_result live
  // in the ordinary events stream, so the re-drive reproduces `RunResult.presentedFiles` exactly like
  // the other re-derived signals above (skill_triggered, redundantToolCalls, …).
  "no_scratchpad_leak",
  "present_files_called",
  // content-class, NOT controlOut-gated: fileToolAttempts re-derives from frozen tool_use blocks (the
  // gated-file-tool attempt, not the gate decision) — same re-derivation reasoning as fileToolAttempts
  // itself above (see the comment beside `fileToolAttempts: rec.fileToolAttempts` in replayCassette).
  "no_vm_path_file_op",
  "subagent_file_write",
  // content-class, NOT controlOut-gated: the composite reads only fileToolAttempts/toolResults (same
  // frozen-stream evidence as subagent_file_write above), scoped per-dispatch via parentToolUseId — see
  // assert.ts's subagent_dispatch_healthy evaluator.
  "subagent_dispatch_healthy",
  // Verdict modifiers — NOT filesystem/egress assertions. Keep all of them on replay (each evaluates to a
  // no-op pass via assert.ts) so a standalone modifier neither inflates the "filesystem/egress skipped"
  // count nor emits a misleading warning, AND so the replay path actually exercises their assert.ts noop
  // branches. The signal each one suppresses is independently zeroed on replay (handled in computeVerdict,
  // not here), so keeping the key as a content no-op cannot change a verdict outcome. Single source: the
  // VERDICT_MODIFIER_KEYS list (types.ts) — a newly-added modifier lands here automatically.
  ...VERDICT_MODIFIER_KEYS,
];

/** Assertion keys evaluated on replay only when `controlOut` (full-fidelity) is present. */
export const QUESTION_GATE_KEYS: (keyof Assertion)[] = [
  "question_asked",
  "question_options",
  "questions_count_max",
  "gate_answers_delivered",
  "gate_answer_count_min",
  "hook_blocked",
  "no_hook_blocked",
  // Decision-level pathDenials — reconstructed from cassette.events + controlOut (the can_use_tool
  // source is reconstructible ONLY from controlOut), same evidence class as hook_blocked above.
  "vm_path_denied",
  "path_denied",
  "no_path_denied",
];

/** Assertion keys evaluated on replay only when the cassette carries an `artifacts` manifest.
 *  `computer_links_resolve` joins this bucket (NOT ALWAYS_CONTENT_KEYS): resolving a NON-empty link set
 *  needs either a live filesystem (not available on replay) or the cassette's `artifacts` manifest — the
 *  exact same evidence gate `file_exists`/`user_visible_artifact` already use. A zero-link transcript
 *  technically wouldn't need the manifest, but gating it identically avoids a live/replay asymmetry where
 *  "zero links" quietly passes on a manifest-less cassette while any actual link forces the same
 *  "not checkable, skipped" treatment as the other manifest keys. */
export const MANIFEST_KEYS: (keyof Assertion)[] = [
  "file_exists",
  "artifact_text",
  "user_visible_artifact",
  "artifact_json",
  "computer_links_resolve",
  "computer_links_resolve_if_present",
  "no_unexpected_files",
  "input_unmodified",
];

/** Assertion keys evaluated ONLY on a live `run`/`record` — never on `replay` (no filesystem/network
 *  to probe). Exported as the single source of truth for anything (docs, tests) that needs to
 *  enumerate live-only keys — mirrors ALWAYS_CONTENT_KEYS/QUESTION_GATE_KEYS/MANIFEST_KEYS above. Does
 *  NOT include `expect_denied`, which is a scenario field (not an Assertion key) — see
 *  `warnUncheckableOnDiskKeys`. */
export const LIVE_ONLY_KEYS: (keyof Assertion)[] = [
  // LIVE-ONLY, and NOT a MANIFEST key despite reading the filesystem: proving a path is ABSENT needs an
  // exhaustive, healthy walk, and `buildManifest` collects through the health-DISCARDING
  // `collectArtifactPaths` (artifacts.ts). A containment-skipped or unreadable subtree is therefore
  // indistinguishable from an empty one on replay, so "not in the manifest" would pass while proving
  // nothing. Positive keys survive that (absent ⇒ "file not found" ⇒ fail-closed); this one would not.
  "file_absent",
  "egress_denied",
  "egress_allowed",
  "no_delete_in_outputs",
  "no_delete_in_mounts",
  "self_heal_ran",
  "transcript_no_host_path",
  "no_mcp_error",
  "max_peak_rss_bytes",
  "semantic_matches", // LIVE-ONLY: LLM-judge grade; skipped-loud on replay (the judge is a live model call)
  // LIVE-ONLY: needs the authored-file set (captured live), which the replay AssertContext has no
  // `authoredFiles` for; a MANIFEST_KEYS classification would evaluate on every manifest-carrying cassette
  // with authoredFiles===undefined → could-not-verify → hard-fail every embedding replay. Replay eval is a
  // genuine follow-up (re-derive authorship from cassette.preRunHashes vs the manifest); its value is capped
  // by the 64 KiB body cap (self-contained interactive HTML routinely exceeds it) + the assert-embed cost.
  "no_lost_write_back",
];

/** Replay a cassette through Run and re-evaluate the content assertions. With a `cassette.artifacts`
 *  manifest, filesystem assertions (file_exists/user_visible_artifact/artifact_json) ALSO run, against
 *  the materialized snapshot. `opts.strict` escalates ALL staleness findings to failing assertions;
 *  `opts.failOnSkillDrift` escalates only the skill-source classes (`skill`/`shared-root`/`unverifiable-skill`),
 *  leaving baseline drift a non-failing warning. Either way the findings are always surfaced in
 *  `RunResult.staleness` for JSON consumers. */
export async function replayCassette(
  cassette: Cassette,
  hooks: RunHooks[] = [],
  opts: {
    strict?: boolean;
    failOnSkillDrift?: boolean;
    cassetteDir?: string;
    /** Ship A: explicit `--session` override. Supplies a SESSION (not bare dirs) so the session-level
     *  `staleness.hash_ignore` and the rest of the hash boundary survive the override. */
    sessionOverride?: string;
    bestEffortFutureCassette?: boolean;
    /** --mutate: perturb recorded values and report which perturbations no assertion catches. Reporting
     *  only — never changes the verdict (an unguarded field is a gap in the scenario, not a failed run). */
    mutate?: boolean;
    /** --mutate scoping + cap overrides. Filtering happens BEFORE planning, so the caps then bind on the
     *  filtered set — which is the point: spend a bounded sample on the artifacts you actually assert on. */
    mutateInclude?: readonly string[];
    mutateExclude?: readonly string[];
    mutateMaxPerFile?: number;
    mutateMaxTotal?: number;
    /** Batch collector — when set, staleness notes go here INSTEAD of stderr (see the emission site). */
    notesSink?: (notes: string[]) => void;
  } = {},
): Promise<RunResult> {
  // Cassette format version: ABSENT = legacy (0); a FUTURE version means this harness may misread fields
  // it doesn't know about, so a future-version cassette is a hard FAILURE BY DEFAULT (future semantics may
  // not be interpreted correctly → a false-green is possible). Opt into a warn-and-continue with
  // `--best-effort-future-cassette` for exploratory use (the failing assertion is pushed below).
  const cassetteVersion = cassette.cassetteVersion ?? 0;
  const futureVersionMsg =
    cassetteVersion > CASSETTE_VERSION
      ? `cassette format v${cassetteVersion} is newer than this harness understands (v${CASSETTE_VERSION}) — results may be unreliable; upgrade cowork-harness`
      : undefined;
  if (futureVersionMsg && opts.bestEffortFutureCassette) {
    warn(`::warning:: [replay] ${futureVersionMsg} (--best-effort-future-cassette: proceeding anyway)\n`);
  }

  // P2: name an unknown top-level key on the frozen scenario. `readCassette` parses `scenario` through a
  // `z.looseObject` PASSTHROUGH (CassetteShape), so a key this build's `ScenarioObject` doesn't recognize is
  // carried but never consulted — replay behaves exactly as if it were absent (see the `replay` doc comment
  // above `cmdReplay`). That's silent by design for an ordinary same-version cassette (forward tolerance is
  // the point of `looseObject`); it stops being silent-by-DESIGN and becomes silent-by-ACCIDENT once the
  // cassette's own `cassetteVersion` says a newer build wrote it.
  //
  // Deliberately paired with the version signal (`futureVersionMsg`) rather than diffing keys on every
  // replay: `ScenarioObject`'s Zod defaults materialize into the frozen scenario at record time, so a FUTURE
  // release's new *defaulted* key would otherwise trip this notice on every replay of any newer cassette —
  // unfilterable spam, because this build cannot know an unknown key's default. Gating on `futureVersionMsg`
  // also keeps this notice complementary to P8 (which refuses to interpret cassette VALUES a build can't
  // understand) rather than overlapping it.
  //
  // MUST NOT THROW: an error while reporting an error is exactly the bug class this guards against — wrap
  // defensively even though `cassette.scenario` is normally a plain object.
  if (futureVersionMsg) {
    try {
      const knownKeys = new Set(Object.keys(ScenarioObject.shape));
      const frozenScenario = cassette.scenario as unknown;
      const frozenKeys = frozenScenario && typeof frozenScenario === "object" ? Object.keys(frozenScenario as Record<string, unknown>) : [];
      const unknownKeys = frozenKeys.filter((k) => !knownKeys.has(k));
      if (unknownKeys.length) {
        warn(
          `::notice:: [replay] frozen scenario carries unknown top-level key(s) this build does not recognize: ` +
            `${unknownKeys.join(", ")} (cassette format v${cassetteVersion} is newer than v${CASSETTE_VERSION} — ` +
            `the value was never consulted; verdict/exit code unaffected by this notice)\n`,
        );
      }
    } catch {
      // Defense-in-depth only — never let a reporting failure abort replay.
    }
  }

  const session = new CassetteAgentSession(cassette.events, cassette.controlOut);

  // cassette→skill/baseline staleness tripwire. Mirrors `asarFingerprint` — warn by default; `--strict`
  // turns a mismatch into a failing assertion (release gate). A green replay must not imply the skill is
  // unchanged (frozen-structure limit). The skill-hash recompute needs the local skill dirs to be resolvable
  // from the cassette's session path; when they aren't (a moved/committed cassette), we say so rather than
  // silently skipping.
  // Findings are surfaced UNCONDITIONALLY (class-tagged) in JSON (RunResult.staleness) even on the default
  // gate — a token-free consumer can distinguish "verified clean" from "couldn't verify" (the `unverifiable-*`
  // classes) WITHOUT the verdict changing. The `--strict` / `--fail-on-skill-drift` gates below are the ONLY
  // place a finding becomes a failing assertion. The single `warn()` loop is the lone stderr emitter — no
  // per-branch `warn()`, so a non-strict run never double-warns one cause. Uses the SHARED `computeStaleness`
  // (no longer a forked copy), so it inherits the per-file detail, the `debugSkillHashMismatch` hook, the
  // GITSET/agent-scope flip buckets, and the both-buckets attribution fix for free.
  const { findings: staleness, notes: stalenessNotes } = computeStaleness(cassette, opts.cassetteDir, opts.sessionOverride);
  for (const s of staleness) warn(`::warning:: [replay] cassette stale: ${s.message}\n`);
  // Notes are the non-failing informational channel — surfaced so they're never a silent drop, but
  // NEVER escalated by --strict. They are emitted at `::notice::`: `warn()` auto-prefixes `::warning::`
  // for an unprefixed message, so the comment here used to claim "plain-info (no ::warning::)" while the
  // code did the opposite — a self-contradiction that made a non-gating advisory shout louder than the
  // ACTIONABLE assert-drift signal next to it (which is a deliberate `::notice::`). Severity tracks
  // actionability, not novelty.
  // `notesSink` lets a BATCH caller collect instead of printing, so a fleet replay emits one summary line
  // per note kind rather than the same constant string once per cassette (measured: 5 notes over this
  // repo's own 3 example cassettes, one kind firing 3/3).
  if (opts.notesSink) opts.notesSink(stalenessNotes);
  else for (const n of stalenessNotes) warn(`::notice:: [replay] cassette note: ${n}\n`);

  // backward compat: warn loudly when controlOut is absent so the user knows question/gate
  // assertions are being EXCLUDED (not vacuously evaluated) from this run.
  if (!session.hasControlOut) {
    warn(
      "::warning:: [replay] cassette has no controlOut (pre-full-fidelity) — question/gate assertions are NOT checked; re-record to enable them\n",
    );
  }

  // ReplayDecider: look up recorded decision body → deserialize → return.
  // Only constructed (and only drives the decision pipeline) when controlOut is present.
  // Reuse the session's already-parsed controlOut index for the decider (no re-parsing).
  const replayDecider = session.hasControlOut ? buildReplayDecider(session, session.controlOutIndex) : NOOP_DECIDER;

  // pass Infinity as dialogTimeoutMs — the synchronous decider resolves before any timer,
  // and there is no child, so the synchronous respond() is safe here.
  const run = new Run(session, replayDecider, hooks, "replay", Infinity);
  let rec: RunRecord;
  let truncatedMsg: string | undefined;
  try {
    rec = await run.drive(cassette.scenario.prompt);
  } catch (e) {
    if (!(e instanceof UnansweredError)) throw e;
    // A question event with no recorded answer = a truncated cassette. Don't crash (exit 2) — synthesize
    // a minimal record and fall through so the mismatch/missingControlOut pushes below STILL run, then add
    // a failing replay_protocol_fidelity assertion (exit 1, the same class as the permission-truncation path).
    truncatedMsg = `truncated cassette: ${e.message}`;
    rec = minimalRec();
  }

  // Reconstruct hook fire/block events from the recorded stream + control-out. A hook_callback is a
  // control_request in the stream; the harness's reply (built-in or custom) is the matching
  // control_response in controlOut. Both are already recorded — no cassette field needed. Only when
  // controlOut is present: a custom hook's decision exists ONLY there, so without it we cannot know
  // whether a custom hook blocked, and the hook keys must exclude-loud rather than reconstruct a
  // partial (built-in-only) view that could false-green no_hook_blocked.
  let replayHookEvents: RunResult["hookEvents"];
  if (session.hasControlOut) {
    replayHookEvents = [];
    for (const line of cassette.events) {
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m?.type !== "control_request" || m?.request?.subtype !== "hook_callback") continue;
      const reqId = typeof m.request_id === "string" ? m.request_id : undefined;
      const reply = reqId ? session.controlOutIndex.get(reqId) : undefined;
      replayHookEvents.push(
        hookEventFrom(
          m.request.callback_id,
          reply,
          m.request.input,
          typeof m.request.tool_use_id === "string" ? m.request.tool_use_id : undefined,
        ),
      );
    }
  }

  // Reconstruct DECISION-level pathDenials from the SAME frozen stream + control-out pairing as
  // replayHookEvents above, plus the re-driven `rec` for the one source that's pure stream content.
  //  - producer (1) pretooluse: same hook_callback pairing as replayHookEvents, filtered to the path
  //    gate's own callback id (parseMessage never turns a hook_callback into a `decision` AgentEvent —
  //    see replayHookEvents' own doc comment — so this source is UNREACHABLE from the re-driven `rec`
  //    and must be reconstructed here, exactly like hookEvents).
  //  - producer (2) can_use_tool: pair the frozen `can_use_tool` request with its controlOut response —
  //    the pairing extension this channel needed (previously the pairing here covered ONLY hook_callback
  //    requests). Reconstructed directly (not read off `rec.pathDenials`) so it's never double-counted
  //    against the merge below.
  //  - producer (3) permission_denied: pure stream content (the tool_use + system_event both live in the
  //    ordinary events stream, not controlOut) — the re-drive reproduces it identically via run.ts's own
  //    correlation filter, so it's merged straight from `rec.pathDenials`.
  // Only when controlOut is present: without it, source (2) never even reaches the re-drive (a
  // can_use_tool `decision` event is skipped by CassetteAgentSession.start() in legacy mode), and source
  // (1)'s custom-hook decision doesn't exist anywhere else — so the whole channel is evidence-unavailable.
  let replayPathDenials: RunResult["pathDenials"];
  if (session.hasControlOut) {
    replayPathDenials = [];
    for (const line of cassette.events) {
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m?.type !== "control_request") continue;
      const reqId = typeof m.request_id === "string" ? m.request_id : undefined;
      const reply = reqId ? session.controlOutIndex.get(reqId) : undefined;
      if (m.request?.subtype === "hook_callback") {
        const callbackId = m.request.callback_id;
        if (callbackId !== HOSTLOOP_PATH_GATE_ID) continue;
        const toolUseId = typeof m.request.tool_use_id === "string" ? m.request.tool_use_id : undefined;
        const hev = hookEventFrom(callbackId, reply, m.request.input, toolUseId);
        if (hev.decision !== "block") continue;
        const fp = hev.paths?.file_path;
        const pp = hev.paths?.path;
        const vmHit = [fp, pp].find(isVmSessionsPath);
        replayPathDenials.push({
          source: "pretooluse",
          tool: hev.tool ?? "?",
          path: vmHit ?? fp ?? pp,
          callbackId,
          decisionReasonType: undefined,
          agentId: hev.agentId,
          decision: "deny",
          reason: hev.reason,
          toolUseId: hev.toolUseId,
        });
      } else if (m.request?.subtype === "can_use_tool" && reply) {
        let req: DecisionRequest | null;
        try {
          req = toDecisionRequest(m);
        } catch {
          continue; // malformed frame — already surfaced elsewhere as a replay_protocol_fidelity failure
        }
        if (!req || req.kind !== "permission" || !FILE_ATTEMPT_TOOLS.has(req.tool)) continue;
        const resp = deserializeDecision(req, reply);
        if (resp.kind !== "permission" || resp.behavior !== "deny") continue;
        const p = deniedPathFrom(req.input);
        if (p === undefined) continue;
        replayPathDenials.push({
          source: "can_use_tool",
          tool: req.tool,
          path: p,
          callbackId: undefined,
          decisionReasonType: req.decisionReasonType,
          agentId: req.agentId,
          decision: "deny",
          reason: resp.message,
          toolUseId: req.toolUseId,
        });
      }
    }
    replayPathDenials.push(...rec.pathDenials.filter((d) => d.source === "permission_denied"));
  }

  // build a conditional contentKeys — omit question/gate keys when controlOut is absent
  // (they would evaluate vacuously/incorrectly).
  const alwaysContentKeys = ALWAYS_CONTENT_KEYS;
  const questionGateKeys = QUESTION_GATE_KEYS;
  // with an artifact manifest, the filesystem assertions become replay-checkable (materialized below).
  // Without a manifest they stay live-only (stripped → skip warning), exactly as before. See
  // MANIFEST_KEYS' doc comment above for why computer_links_resolve joins this bucket.
  const hasPreRun = cassette.preRunPaths !== undefined;
  // no_unexpected_files gates on manifest PRESENCE (`artifacts !== undefined`), not length: its green
  // case is exactly "nothing created", so an empty-but-present manifest (a clean recording) is fully
  // evaluable against an empty materialized tree. The other manifest keys keep length-gating — an
  // empty manifest can never satisfy file_exists/artifact_json, so exclusion is harmless there.
  const nufReplayable = cassette.artifacts !== undefined && hasPreRun;
  // Excluded-but-LOUD: the manifest exists but the baseline doesn't (pre-0.24 or microvm recording —
  // record always captures on capture-capable tiers). The dedicated warning below announces the drop,
  // so — and only then — the skip tallies don't double-report it (gate-key precedent).
  const nufExcludedLoudly = cassette.artifacts !== undefined && !hasPreRun;
  // input_unmodified mirrors no_unexpected_files exactly: it's a pre/post DIFF whose green case
  // ("nothing changed") is valid against an empty-but-present manifest, and whose evidence requirement
  // is the `preRunHashes` baseline (NOT `preRunPaths` — a different pre-run field, captured together but
  // logically distinct). The generic length-gated `manifestKeys` bucket below would (a) silently strip it
  // when the manifest is empty-but-present even though a deletion is fully diagnosable against that empty
  // tree, and (b) ignore the preRunHashes baseline requirement entirely — the exact live/replay asymmetry
  // no_unexpected_files was special-cased to avoid.
  const hasPreRunHashes = cassette.preRunHashes !== undefined;
  const iumReplayable = cassette.artifacts !== undefined && hasPreRunHashes;
  const iumExcludedLoudly = cassette.artifacts !== undefined && !hasPreRunHashes;
  const manifestKeys: (keyof Assertion)[] = [
    ...(cassette.artifacts?.length ? MANIFEST_KEYS.filter((k) => k !== "no_unexpected_files" && k !== "input_unmodified") : []),
    ...(nufReplayable ? (["no_unexpected_files"] as (keyof Assertion)[]) : []),
    ...(iumReplayable ? (["input_unmodified"] as (keyof Assertion)[]) : []),
  ];
  // DELIBERATE asymmetry (live vs replay): live/verify-run without preRunPaths ⇒ evidence-unavailable
  // HARD-FAIL; replay of a baseline-less cassette ⇒ loud EXCLUDE here (same contract as gate keys
  // without controlOut) — the recording cannot support the key, not a vacuous pass.
  if (cassette.scenario.assert.some((a) => a.no_unexpected_files !== undefined) && nufExcludedLoudly)
    warn(
      "::warning:: [replay] no_unexpected_files: cassette has no pre-run manifest (recorded before the manifest seam) — key skipped on replay; re-record on a current harness\n",
    );
  if (cassette.scenario.assert.some((a) => a.input_unmodified !== undefined) && iumExcludedLoudly)
    warn(
      "::warning:: [replay] input_unmodified: cassette has no pre-run hash manifest (recorded pre-fingerprinted-manifest or on microvm) — key skipped on replay; re-record on harness with hash-manifest support (container/hostloop)\n",
    );
  // deterministic exhaustiveness check — every key in the Assertion schema must appear in exactly
  // one classification bucket. If a new key is added to the schema but not here, this throws at the first
  // replay, making the oversight impossible to miss in CI.
  {
    const ALL_CLASSIFICATION_KEYS = new Set<keyof Assertion>([
      ...alwaysContentKeys,
      ...questionGateKeys,
      // Spread, not hand-listed: the manifest bucket was the one enumerated by NAME here, so adding a
      // manifest key elsewhere threw at the first replay until someone remembered this literal too.
      ...MANIFEST_KEYS,
      ...LIVE_ONLY_KEYS, // single source of truth for the live-only bucket (stripped on replay)
      "replay_protocol_fidelity",
      // (verdict modifiers allow_permissive_auto_allow / allow_missing_capability / allow_l0_plugin_divergence
      //  arrive via ...alwaysContentKeys above — kept on replay as no-op passes.)
    ]);
    for (const key of Object.keys(AssertionSchema.shape) as (keyof Assertion)[]) {
      if (!ALL_CLASSIFICATION_KEYS.has(key))
        throw new Error(
          `cowork-harness: assertion key "${String(key)}" is not classified for replay — add it to one of the classification buckets in replayCassette`,
        );
    }
  }
  const {
    workRoot: replayWorkRoot,
    prefixes: replayPrefixes,
    truncatedPaths: replayTruncatedPaths,
    linkPaths: replayLinkPaths,
  } = manifestKeys.length
    ? materializeManifest(cassette.artifacts!, cassette.userVisibleRoots ?? ["outputs", ".projects"])
    : {
        workRoot: "",
        prefixes: [] as string[],
        truncatedPaths: new Map<string, ManifestEntry["truncationReason"]>(),
        linkPaths: new Set<string>(),
      };
  // computer_links_resolve's replay-lane folder-prefix resolution (Finding 24/25) — computed once,
  // outside the try, since it doesn't depend on anything materializeManifest produced.
  const folderPrefixResolution = buildFolderPrefixMap(cassette);
  // Populated only under --mutate; surfaced after the verdict so it reads as coverage info, not a failure.
  // Surfaced on the RunResult so `--mutate --output-format json` is machine-readable. It was previously
  // assigned here and never read by anything, so every consumer had to scrape stderr — which is how the
  // capped denominator went unnoticed in the first place.
  let mutationReport: RunResult["mutation"];
  // materializeManifest created a temp dir (`replayWorkRoot`) above; everything below uses it and
  // then returns. Wrap the rest in try/finally so the temp dir is removed on every exit path (normal
  // return OR a throw from evaluate/assert building) — otherwise `cwh-replay-*` dirs leak under tmpdir
  // across repeated replays. `replayWorkRoot` is declared OUTSIDE the try (visible in finally); the
  // returned object carries no reference into it, so post-return cleanup is safe.
  try {
    const contentKeys: (keyof Assertion)[] = [
      ...(session.hasControlOut ? [...alwaysContentKeys, ...questionGateKeys] : alwaysContentKeys),
      ...manifestKeys,
    ];

    // with AND-semantics in check(), we must STRIP each assertion to only its active content keys
    // before evaluating — otherwise a mixed object (e.g. {question_asked, result} with controlOut
    // absent, or {transcript_contains, file_exists}) would AND-evaluate a key that cannot be checked
    // on the replay lane and false-fail. Stripping (rather than a Zod superRefine that bans mixed
    // objects) keeps each evaluated entry single-replay-class while leaving the live path — where ALL
    // keys are legitimately checkable — to evaluate the full object. Objects with no active key drop out.
    const stripToContent = (a: Assertion): Assertion => {
      const stripped: Assertion = {};
      for (const k of contentKeys) if (a[k] !== undefined) (stripped as Record<string, unknown>)[k] = a[k];
      return stripped;
    };
    const replayable = cassette.scenario.assert.map(stripToContent).filter((a) => Object.keys(a).length > 0);

    // footgun: replay must be LOUD about anything it can't check, in two distinct classes —
    // a silent partial false-green is the project's cardinal sin.
    //  • FULL skip  — an assertion with no evaluated key at all (pure filesystem/egress, or pure
    //    gate-keys when controlOut is absent) + every `expect_denied` host. Not evaluated on replay.
    //  • PARTIAL skip — a MIXED assertion whose content half IS evaluated but whose genuine
    //    filesystem/egress half is silently dropped by stripToContent (e.g. {result, file_exists}).
    //    Counted separately so a mixed assertion can't green on its content half alone unnoticed.
    // `contentishKeys` (always-content ∪ question/gate) marks keys that are NEVER filesystem/egress;
    // a key outside it is genuinely live-only. (Gate keys dropped purely for missing controlOut are
    // already announced by the controlOut warning above, so they don't count as a PARTIAL drop.)
    const contentishKeys = new Set<keyof Assertion>([...alwaysContentKeys, ...questionGateKeys, ...manifestKeys]);
    let fullSkipCount = cassette.scenario.expect_denied?.length ?? 0;
    let partialSkipCount = 0;
    for (const a of cassette.scenario.assert) {
      const defined = (Object.keys(a) as (keyof Assertion)[]).filter((k) => a[k] !== undefined);
      if (defined.length === 0) continue;
      const keptContent = defined.some((k) => contentKeys.includes(k));
      if (!keptContent) {
        fullSkipCount++; // nothing on this assertion is checkable on replay
      } else if (
        defined.some(
          (k) =>
            !contentishKeys.has(k) &&
            !(k === "no_unexpected_files" && nufExcludedLoudly) &&
            !(k === "input_unmodified" && iumExcludedLoudly),
        )
      ) {
        // Suppress the tally for no_unexpected_files/input_unmodified ONLY when their dedicated warning
        // fired (nufExcludedLoudly/iumExcludedLoudly) — on a manifest-less/hashless cassette that warning
        // can't fire, so the drop must count here like any other filesystem key or it would be fully silent.
        partialSkipCount++; // content half evaluated; a filesystem/egress key was dropped
      }
    }
    if (fullSkipCount > 0) {
      warn(
        `::warning:: [replay] skipped ${fullSkipCount} filesystem/egress/expect_denied assertions (live-only) — not evaluated on replay\n`,
      );
    }
    if (partialSkipCount > 0) {
      warn(
        `::warning:: [replay] ${partialSkipCount} mixed assertion(s) had their filesystem/egress half dropped — only the content half was evaluated on replay\n`,
      );
    }

    // A v10+ cassette recorded its baseline with the link-aware walk. Single source of truth so the
    // evaluate() ctx and the returned RunResult can't disagree about which baseline semantics were used
    // (moot for replay's own no_unexpected_files — the materialized tree has no real symlinks — but honest).
    const replayLinkAware = (cassette.cassetteVersion ?? 0) >= 10;
    const assertCtx: AssertContext = {
      transcript: rec.transcript,
      toolsCalled: rec.toolsCalled,
      subagentTools: rec.subagentTools,
      egress: [],
      result: rec.result,
      workRoot: replayWorkRoot,
      userVisiblePrefixes: replayPrefixes,
      lane: cassette.scenario.lane, // replay is held to the RECORDED scenario's contract
      // Replay reads the body-less REASON per-entry from the materialized manifest (truncatedPaths, a
      // Map<path, reason>) — NOT a cassette-level roots list (removed in v8). Live/verify-run alone use
      // readonlyFolderRoots (they have no manifest at eval time), so it's empty here.
      readonlyFolderRoots: [],
      preRunPaths: cassette.preRunPaths,
      preRunLinkAware: replayLinkAware,
      preRunHashes: cassette.preRunHashes,
      preRunOrigin: cassette.preRunOrigin, // a cassette from a local-unreadable baseline fails evidence-unavailable on replay too
      // The authoritative post-run per-path sha256 from the manifest — NOT a re-hash of replayWorkRoot,
      // which materializeManifest fills with 0-byte placeholders for body-less entries (read-only inputs,
      // over-cap files). Re-hashing that placeholder would false-fail input_unmodified for a large-or-
      // read-only file that was never modified. Drop empty-sha256 entries (the "unreadable" catch branch
      // in buildManifest) so an unrecoverable file falls through to the re-hash/absent path honestly
      // instead of spuriously matching against "".
      postRunHashes: Object.fromEntries((cassette.artifacts ?? []).flatMap((e) => (e.sha256 ? [[e.path, e.sha256] as const] : []))),
      outputsDeletes: [],
      mountDeletes: [], // replay has no live scan — the same shape outputsDeletes already uses here
      questions: rec.questions,
      gateOptions: rec.gateOptions,
      // A truncated cassette could not be driven, so `gateOptions` is empty because nothing was OBSERVED
      // — not because no gate fired. Flag it so question_options fails evidence-unavailable. (A cassette
      // with no controlOut needs no flag: the whole QUESTION_GATE_KEYS bucket is excluded from that
      // replay, so the key is never reached.)
      gateOptionsMissing: truncatedMsg !== undefined,
      hostPathLeaked: false,
      selfHealRan: false,
      subagents: rec.subagents,
      gateDeliveries: rec.gateDeliveries,
      toolResultTexts: rec.toolResults.map((r) => r.assertText ?? r.text),
      toolResultsTruncated: rec.toolResults.map((r) => r.assertText === undefined),
      // content-class, same as toolResultTexts above — pairing info for subagent_file_write.
      toolResults: rec.toolResults.map((r) => ({ toolUseId: r.toolUseId, isError: r.isError })),
      toolErrors: rec.toolErrors,
      redundantToolCalls: rec.redundantToolCalls,
      truncatedPaths: replayTruncatedPaths,
      linkPaths: replayLinkPaths, // replay-only: file_exists/user_visible_artifact fail-closed on a link entry (placeholder ≠ resolution)
      skillsInvoked: rec.skillsInvoked,
      skillToolAvailable: rec.initTools.includes("Skill"),
      skillActivity: cassette.timeline ? foldSkillActivity(cassette.timeline) : undefined,
      tasks: Array.from(rec.tasks.values()),
      // Context/Connectors panel — backs skill_available/connector_available/tool_available.
      // All three replay from the frozen init event: the cassette re-drive runs run.ts's init handler, which
      // seeds rec.context.{tools,mcpServers,availableSkills} from the recorded init line (availableSkills
      // id-only — the whenToUse enrichment is a live-disk read in execute.ts with no cassette-frozen
      // equivalent, but skill_available matches ids only, so id-only is sufficient and these keys are
      // content-class on replay too). evidence-unavailable only when the re-drive yields no context at all
      // (an older cassette whose init line predates these fields) — never a vacuous pass.
      availableSkills: rec.context?.availableSkills,
      mcpServers: rec.context?.mcpServers as AssertContext["mcpServers"],
      availableTools: rec.context?.tools,
      // The re-drive reproduces `system_event` via parseMessage from the cassette's frozen stdout
      // stream — content-class, same as toolErrors/redundantToolCalls above.
      contextEvents: rec.contextEvents,
      // live-only — MCP round-trips are harness-computed at drive time, not reproducible from the
      // cassette's frozen stdout stream (unlike contextEvents/toolErrors above).
      mcpErrors: undefined,
      // live-only — replay never spawns a sandbox to sample; no resource telemetry to fold from a
      // frozen event stream (same reasoning as mcpErrors above).
      resources: undefined,
      // reconstructed above from cassette.events + controlOut; undefined when controlOut is absent
      // (excludes hook_blocked/no_hook_blocked loud, never a vacuous pass).
      hookEvents: replayHookEvents,
      // content-class — the tool_use blocks are frozen stream content, so the re-drive reproduces
      // fileToolAttempts exactly like the live lane (same reasoning as presentedFiles below).
      fileToolAttempts: rec.fileToolAttempts,
      // reconstructed above (beside replayHookEvents) from cassette.events + controlOut; undefined when
      // controlOut is absent.
      pathDenials: replayPathDenials,
      // content-class — re-derived by the re-drive above exactly like the live lane; uncollapsed so an
      // empty [] (nothing presented) vacuous-passes no_scratchpad_leak instead of reading as
      // evidence-unavailable.
      presentedFiles: rec.presentedFiles,
      evidenceErrors: rec.evidenceErrors,
      effectiveFidelity: cassette.effectiveFidelity,
      // Replay has no live filesystem — computer_links_resolve normalizes both link shapes against the
      // manifest instead (see the manifestKeys comment above + src/run/computer-links.ts).
      linkResolution: {
        mode: "replay",
        folderPrefixes: folderPrefixResolution.map,
        folderPrefixesRequiredButAbsent: folderPrefixResolution.requiredButAbsent,
        linkPaths: replayLinkPaths, // a link entry's placeholder proves existence, not resolution — fail evidence-unavailable
      },
      ...budgetFields(rec),
    };
    const assertions = evaluate(replayable, assertCtx);

    // MUTATION COVERAGE (--mutate). A green replay says the assertions passed; it cannot say whether they
    // would have FAILED had the output been wrong. A real 21-cassette corpus turned out to contain seven
    // scenarios asserting nothing meaningful — found only because someone wrote a throwaway script.
    //
    // The check: perturb one recorded value, re-run the SAME assertions against the SAME context, and see
    // whether any of them notices. Nothing noticed ⇒ that field is unguarded. Cheap because replay already
    // materialized the artifacts to disk and `evaluate()` is pure and synchronous — no model, no sandbox.
    //
    // Reporting only: never changes the verdict or the exit code. An unguarded field is a gap in YOUR
    // assertions, not a failure of this run, and turning it into one would red every existing corpus at
    // once. The mutated file is always restored, including when an assertion throws.
    if (opts.mutate) {
      const inlined = (cassette.artifacts ?? [])
        .filter((a): a is typeof a & { body: string } => typeof a.body === "string" && !a.truncated)
        .map((a) => ({ path: a.path, body: a.body }));
      // planMutationsWITHSTATS, not planMutations: the plan is CAPPED (10 per file, 50 total), so
      // reporting `uncaught/plan.length` alone reads as "N of your N fields are unguarded" when N is a
      // sample. A consumer aggregated twenty such lines into "1,020 perturbations, 0 caught" and came one
      // step from concluding their assertions verified nothing — the truth was their asserted paths were
      // never in the sample. The stats form exists precisely to make that discoverable; it was simply
      // never wired to its only caller.
      const include = opts.mutateInclude ?? [];
      const exclude = opts.mutateExclude ?? [];
      // Filter BEFORE planning so the caps bind on what survived, not on the whole corpus. An artifact
      // dropped here is absent from `eligible` too — the report describes the scope you asked for.
      const scoped = inlined.filter((a) => (include.length === 0 || matchesAnyGlob(a.path, include)) && !matchesAnyGlob(a.path, exclude));
      const planOpts = { maxPerFile: opts.mutateMaxPerFile, maxTotal: opts.mutateMaxTotal };
      const stats = planMutationsWithStats(scoped, planOpts);
      const plan = stats.mutations;
      const coverage = summarizeMutationPlan(stats, planOpts);
      const uncaught: string[] = [];
      const baselineFailed = new Set(assertions.map((a, i) => (a.pass ? -1 : i)).filter((i) => i >= 0));
      for (const m of plan) {
        const abs = join(replayWorkRoot, m.file);
        let original: string;
        try {
          original = readFileSync(abs, "utf8");
        } catch {
          continue; // not materialized (out of a user-visible root) — nothing to perturb
        }
        try {
          writeFileSync(abs, applyMutation(original, m));
          const after = evaluate(replayable, assertCtx);
          // "Caught" = some assertion that PASSED on the real value now fails. Comparing against the
          // baseline failure set (not `every(pass)`) keeps an already-red assertion from masking the gap.
          const caught = after.some((a, i) => !a.pass && !baselineFailed.has(i));
          if (!caught) uncaught.push(m.label);
        } finally {
          writeFileSync(abs, original); // restore unconditionally — a thrown assert must not leave a mutated tree
        }
      }
      mutationReport = {
        sampled: plan.length,
        eligible: coverage.eligible,
        truncatedBy: coverage.truncatedBy,
        caps: coverage.caps,
        uncaught,
      };
      // Only when truncation actually happened: on a corpus under both caps the counts ARE the whole
      // truth and the parenthetical is noise. Naming the binding cap matters — the per-file cap is
      // checked first, so "raise --mutate-max-total" is inert advice whenever per-file bound.
      const scope = coverage.truncatedBy
        ? ` (sampled ${coverage.sampled} of ${coverage.eligible} eligible value(s)` +
          (coverage.truncatedBy === "per-file"
            ? `; per-file cap ${coverage.caps.perFile} reached on ${coverage.filesAtPerFileCap} file(s)`
            : `; total cap ${coverage.caps.total} reached`) +
          `)`
        : "";
      if (!plan.length)
        // Attribute an empty plan to the FILTERS when they are what emptied it — otherwise the generic
        // "no perturbable values" explanation sends the reader looking for a JSON deliverable they have.
        log(
          scoped.length === 0 && inlined.length > 0
            ? `::notice:: [mutate] --mutate-include/--mutate-exclude filtered out all ${inlined.length} inlined JSON artifact(s) — nothing left to perturb`
            : `::notice:: [mutate] ${explainNoMutations(cassette.artifacts ?? [], scoped)}`,
        );
      else if (uncaught.length) {
        log(
          `::warning:: [mutate] ${uncaught.length}/${plan.length} sampled perturbation(s) CAUGHT BY NOTHING — these fields are unguarded${scope}:`,
        );
        for (const u of uncaught) log(`    ${u}`);
      } else
        log(`::notice:: [mutate] all ${plan.length} sampled perturbation(s) were caught — assertions cover every perturbed field${scope}`);
    }

    // under --strict, EVERY staleness finding becomes a failing assertion (non-zero exit), not just a
    // warning. --fail-on-skill-drift is the narrower gate: only the skill-source classes fail (incl.
    // `unverifiable-skill` — can't verify skill staleness ⇒ not green), while baseline / format / env-level
    // findings stay non-failing. `else if` makes --strict the superset when both are passed.
    const SKILL_DRIFT_CLASSES: ReadonlySet<StalenessFinding["class"]> = new Set(["skill", "shared-root", "unverifiable-skill"]);
    if (opts.strict)
      for (const s of staleness)
        assertions.push({
          assertion: {} as Assertion,
          pass: false,
          message: `cassette stale (--strict): ${s.message}`,
          source: "staleness",
        });
    else if (opts.failOnSkillDrift)
      for (const s of staleness.filter((s) => SKILL_DRIFT_CLASSES.has(s.class)))
        assertions.push({
          assertion: {} as Assertion,
          pass: false,
          message: `skill-source drift (--fail-on-skill-drift): ${s.message}`,
          source: "staleness",
        });
    // BREAKING in 2.0.0: `unverifiable-skill` fails the DEFAULT verdict. "Verified and unchanged" and
    // "could not be checked at all" are categorically different claims, and only the first should be green.
    // Before this a bare `replay` warned on stderr, recorded the class in `staleness[]`, and still returned
    // pass:true / exit 0 — so a cassette that had silently stopped proving anything kept passing the lane
    // most people run. Green-against-unverified is worse than a loud red: silence prompts a re-record,
    // green does not.
    //
    // Deliberately NARROW. `skill` / `shared-root` — "we checked, and it changed" — still require
    // `--fail-on-skill-drift`, so that flag keeps its meaning and no inverse escape hatch is needed. The
    // remedy for the commonest cause is `--session <file>`; re-recording is the other.
    // An explicit `--session` must never LOWER the verdict. Without it, an unresolvable cassette is a hard
    // fail (above); resolving it to the WRONG tree turns `unverifiable-skill` into ordinary `skill` drift,
    // which is warn-only — so the flag would convert a loud red into a green, which is precisely the
    // green-against-nothing this release argues is worse than a red. The operator asserted this tree, so
    // any drift they then see is real and actionable. Escalating here keeps the flag an escape from
    // "cannot verify", never an escape from "verified, and it changed".
    // `format` is in here deliberately. A mode / agent-scope / hash-epoch mismatch means the recorded and
    // live hashes are NOT COMPARABLE — the same "could not verify" the default gate reds on, reached by a
    // different route. Excluding it left a hole with exactly the shape this guard exists to close: pointing
    // --session at a NON-GIT tree turned the hard `unverifiable-skill` into a `format` warning and exit 0.
    // An explicit override can never LOWER the verdict, so every class meaning "this tree could not be
    // checked against the recording" escalates with it.
    else if (opts.sessionOverride !== undefined)
      for (const s of staleness.filter((s) => SKILL_DRIFT_CLASSES.has(s.class) || s.class === "format"))
        assertions.push({
          assertion: {} as Assertion,
          pass: false,
          message: `skill-source drift under an explicit --session: ${s.message}`,
          source: "staleness",
        });
    else
      for (const s of staleness.filter((s) => s.class === "unverifiable-skill"))
        assertions.push({
          assertion: {} as Assertion,
          pass: false,
          message: `skill staleness could not be verified: ${s.message}`,
          source: "staleness",
        });

    // future cassette version — hard failure under --strict (forward semantics may not be
    // correctly interpreted here, so a green replay would be a false-green).
    if (futureVersionMsg && !opts.bestEffortFutureCassette)
      assertions.push({
        assertion: {} as Assertion,
        pass: false,
        source: "cassette-format",
        message: `cassette format too new: ${futureVersionMsg} (pass --best-effort-future-cassette to attempt replay anyway)`,
      });

    // differing duplicate request_ids in control-out are CONTRADICTORY protocol data — an
    // UNCONDITIONAL cassette-corruption failure (no longer strict-only). --strict stays reserved for
    // staleness/extra-data, not contradictory protocol data that could replay a corrupt decision history.
    for (const id of session.duplicateControlOutIds) {
      assertions.push({
        assertion: { replay_protocol_fidelity: true },
        pass: false,
        message: `control-out.jsonl has duplicate request_id "${id}" with differing bodies — cassette is corrupt; re-record`,
        source: "cassette-format",
      });
    }

    // a malformed (non-JSON) control-out line is cassette corruption — UNCONDITIONAL failure.
    // controlOut is part of the replay contract; a corrupt cassette must never green just because the
    // malformed line happened not to be referenced.
    for (const idx of session.malformedControlOutLines) {
      assertions.push({
        assertion: { replay_protocol_fidelity: true },
        pass: false,
        message: `control-out.jsonl line ${idx} is not valid JSON — cassette is corrupt; re-record`,
        source: "cassette-format",
      });
    }

    // malformed event lines — always surface as a replay_protocol_error result (non-zero exit
    // in strict; a warning-level result that still appears in output in non-strict). A malformed line
    // could conceal a failed assertion (false-green risk), so it is never silently swallowed.
    for (const idx of session.malformedEventLines) {
      assertions.push({
        assertion: { replay_protocol_fidelity: true },
        pass: false,
        message: `cassette events line ${idx} is not valid JSON — replay_protocol_error (malformed line may conceal a failed assertion)`,
        source: "cassette-format",
      });
    }

    // a per-line PROTOCOL validation failure (valid JSON but a malformed control frame — bad
    // request_id / malformed AskUserQuestion body) is an unconditional replay_protocol_fidelity failure.
    // Caught per-line in start() so a single corrupt cassette can't abort the batch (see cmdReplay's
    // per-file try/catch); surfaced here as a failing assertion (fail-closed, not strict-gated).
    for (const pe of session.protocolErrorLines) {
      assertions.push({
        assertion: { replay_protocol_fidelity: true },
        pass: false,
        message: `cassette events line ${pe.line} is a malformed control frame — ${pe.message}`,
        source: "cassette-format",
      });
    }

    // surface each serializeDecision mismatch as a failing replay_protocol_fidelity assertion.
    // Shape: { assertion: { replay_protocol_fidelity: true }, pass: false, message } — well-typed via types.ts.
    for (const m of session.mismatches) {
      assertions.push({
        assertion: { replay_protocol_fidelity: true },
        pass: false,
        message: `serializeDecision output for ${m.id} != recorded envelope: expected ${m.expected} got ${m.actual}`,
        source: "cassette-format",
      });
    }

    // a decision present in events.jsonl with NO matching control_response in a full-fidelity
    // cassette is a truncated recording — fail loud rather than letting a recorded allow replay as a
    // silent abstain→deny. (Questions with a missing entry already throw UnansweredError upstream.)
    for (const id of session.missingControlOut) {
      assertions.push({
        assertion: { replay_protocol_fidelity: true },
        pass: false,
        message: `decision ${id} present in events.jsonl has no matching control_response in control-out.jsonl — cassette is truncated; re-record`,
        source: "cassette-format",
      });
    }

    // A truncated QUESTION (no recorded answer) surfaces here too — same exit-1 class as the permission case.
    if (truncatedMsg) {
      assertions.push({ assertion: { replay_protocol_fidelity: true }, pass: false, message: truncatedMsg, source: "cassette-format" });
    }

    // F46: RunResult.fingerprint is documented (src/types.ts:978-980) as the RUN-TIME staleness
    // fingerprint; a cassette only ever carries the FROZEN one computed at record time (never
    // recomputed on replay — that's what `computeStaleness`, ~line 858, diffs against). Surfacing it
    // unlabeled would misrepresent when it was taken, so a `frozen:true` marker rides along. Built as a
    // separate typed-cast variable (not an inline object literal) so it can carry the extra key without
    // an excess-property error under `Fingerprint`'s declared shape — additive, no cassetteVersion bump,
    // no schema `additionalProperties:false` on this node to violate.
    const frozenFingerprint: Fingerprint | undefined = cassette.fingerprint
      ? ({ ...cassette.fingerprint, frozen: true } as Fingerprint)
      : undefined;

    return assembleRunResult({
      turn: undefined, // replay reconstructs one recorded run; no multi-turn attribution
      command: "replay", // #48
      mutation: mutationReport, // --mutate only; undefined otherwise
      // A replay is held to the lane the RECORDED scenario declared — the frozen contract, not the
      // replaying machine's. Absent on a cassette recorded before the axis existed ⇒ local.
      lane: cassette.scenario.lane,
      // A replay materializes a recorded tree; it runs no scratchpad walk of its own, so it cannot answer
      // the undelivered question — cannot-tell, never a clean read.
      scratchpadEvidenceComplete: false,
      referencesRead: rec.filesRead.length ? rec.filesRead : undefined, // re-derived from the frozen Read events on the replay re-drive, same as toolCounts
      ablated: undefined, // replay reconstructs a recorded run; ablation is a live-run control
      runLabel: undefined, // run-identity metadata is a LIVE-run property; a replay has no record-time label
      skillCommit: undefined,
      scenario: cassette.scenario.name,
      mode: "run",
      // Pass through the frozen recording-time provenance — an older cassette that predates
      // Cassette.environment yields undefined (honest: pre-taxonomy recording), never a false "local" claim.
      execution: cassette.environment?.location ? { location: cassette.environment.location } : undefined,
      fidelity: `replay:${cassette.scenario.fidelity}`,
      // The tier the LIVE run actually used (cowork → hostloop/container); falls back to authored fidelity
      // for an older cassette that didn't record it.
      effectiveFidelity: `replay:${cassette.effectiveFidelity ?? cassette.scenario.fidelity}`,
      baseline: cassette.scenario.baseline,
      result: rec.result,
      resultErrorKind: rec.resultErrorKind, // re-derived by run.ts during the replay re-drive (same classifier)
      errorSource: rec.errorSource, // re-derived by run.ts during the replay re-drive, same as resultErrorKind
      resultSubtype: rec.resultSubtype, // re-derived from the frozen result event on the replay re-drive
      finalMessage: rec.resultText, // the SDK result text, re-derived from the frozen result event
      stderrLogPath: undefined, // live path only — no live process on replay
      stalledOnQuestion: rec.stalledOnQuestion, // re-derived by run.ts's detector during the replay re-drive — so a recorded stall fails replay too
      decisions: rec.decisions.map((d) => ({
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
      toolCounts: rec.toolCounts,
      webSearches: rec.webSearches.length ? rec.webSearches : undefined,
      infraErrors: infraErrorsForResult(rec),
      evidenceErrors: evidenceErrorsForResult(rec),
      toolDurations: cassette.timeline ? foldToolDurations(cassette.timeline) : undefined,
      skillActivity: cassette.timeline ? foldSkillActivity(cassette.timeline) : undefined,
      models: rec.models.length ? rec.models : undefined,
      thinking: rec.thinking.length ? rec.thinking : undefined,
      thinkingElided: rec.thinkingElided,
      toolErrors: rec.toolErrors,
      modelUsage: rec.modelUsage,
      redundantToolCalls: rec.redundantToolCalls,
      tasks: Array.from(rec.tasks.values()),
      // mcpServers is unknown[] on the RunRecord (verbatim from the SDK's init event) but RunResult
      // documents its loose per-server shape ({name, status?, ...}) for consumers — cast, not a
      // transformation; the underlying array is passed through unchanged.
      context: rec.context as RunResult["context"],
      gateDeliveries: rec.gateDeliveries,
      egress: [],
      assertions,
      subagents: cassette.timeline ? attributeSubagentSkills(rec.subagents, cassette.timeline) : rec.subagents,
      nonReproducibleAnswers: rec.unanswered,
      // The live/success/partial assemblers already passed these through; replay never did,
      // so a cassette that recorded usage/cost silently dropped it on replay. re-drive (rec) recomputes
      // them deterministically from the same events, so this is a content key, not a live-only one.
      usage: rec.usage,
      cost: rec.cost,
      skillsInvoked: rec.skillsInvoked,
      skillToolAvailable: rec.initTools.includes("Skill"),
      outDir: "(replay)",
      // Class-tagged staleness + skip counts, surfaced to JSON callers (the gate decision already happened
      // above via failing assertions; these fields are pure data so a green stays green by default).
      staleness: staleness.length ? staleness : undefined,
      skippedAssertions: { full: fullSkipCount, partial: partialSkipCount },
      // A cassette freezes the answer path: the replay itself is deterministic regardless of how the
      // original run was answered. Always explicit (never undefined) so renderer.ts:146 treats it
      // correctly — undefined would silently render as "deterministic".
      nonDeterministic: false,
      // Fields this lane has NEVER set (implicitly undefined before this refactor; explicit now).
      // `durationMs` in particular is a genuine pre-existing gap — replay reports no run duration
      // today. Preserve exactly; fixing it is out of scope for this pure refactor.
      $schema: undefined,
      generator: undefined,
      // F46: the scenario's prompt is already in hand (it's what drove the replay re-drive) — was
      // dropped as undefined even though a live/success/partial result always carries it.
      prompt: cassette.scenario.prompt,
      capabilityProbe: undefined,
      requiresCapabilityUnmet: undefined,
      workDir: undefined,
      outputsDir: undefined,
      userVisibleRoots: undefined,
      readonlyFolderRoots: undefined,
      artifacts: undefined,
      workspaceFiles: undefined, // no live filesystem to scan on replay (see the doc note in execute.ts)
      contextEvents: rec.contextEvents, // the re-drive reproduces system_event via parseMessage — powers compaction_occurred
      mcpErrors: undefined, // live-only — the re-drive never produces mcp_error
      hookEvents: replayHookEvents, // reconstructed above from cassette.events + controlOut; undefined when controlOut is absent
      // Content-class: the tool_use blocks live in the ordinary events stream (not controlOut), so the
      // re-drive reproduces fileToolAttempts automatically — same reasoning as presentedFiles below.
      fileToolAttempts: rec.fileToolAttempts,
      // reconstructed above (beside replayHookEvents) from cassette.events + controlOut, pairing the
      // pretooluse/can_use_tool sources with their controlOut reply and merging the permission_denied
      // source from the re-drive; undefined when controlOut is absent.
      pathDenials: replayPathDenials,
      // Content-class: the tool_use/tool_result pair lives in the ordinary events stream (not
      // controlOut), so the re-drive reproduces it exactly like mcpErrors' live-only counterpart does
      // NOT reproduce — this one genuinely re-derives. Uncollapsed (an empty [] is the real "nothing
      // presented" signal no_scratchpad_leak's vacuous pass needs, matching live).
      presentedFiles: rec.presentedFiles,
      preRunPaths: undefined,
      // Report the baseline semantics actually used during evaluation above (not undefined) so the returned
      // result doesn't misrepresent them. Same source of truth as the evaluate() ctx.
      preRunLinkAware: replayLinkAware,
      preRunHashes: undefined,
      preRunOrigin: undefined,
      partial: undefined,
      unansweredGate: undefined,
      nonDeterministicTerminal: undefined,
      permissiveAutoAllow: undefined,
      scan: undefined,
      fidelityWarnings: undefined,
      l0PluginDivergence: undefined,
      missingCapabilityUse: undefined,
      gateProvenance: undefined,
      // F46: cassette.fingerprint is the record-time snapshot; frozenFingerprint (above) is it plus a
      // `frozen:true` marker so a consumer can't mistake it for a fresh run-time recompute.
      fingerprint: frozenFingerprint,
      // F46: rec.toolResults is already built and fed to the eval context above (toolResultTexts/
      // toolResultsTruncated) — was dropped as undefined even though it's on hand.
      toolResults: rec.toolResults,
      durationMs: undefined,
      resources: undefined, // replay never spawns a sandbox to sample; no live resource telemetry
      // replay never writes a result.json (there is no on-disk persist point for this lane to populate
      // at) — cmdReplay's own JSON envelope (envelope.ts) independently attaches its own live-computed
      // Verdict to every emitted result, incl. a replay's, for stdout consumers.
      outcome: undefined, // derived from `verdict`; absent for the same reason it is
      verdict: undefined,
    });
  } finally {
    if (replayWorkRoot) rmSync(replayWorkRoot, { recursive: true, force: true });
  }
}

function safeLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim());
  } catch (err: unknown) {
    // File-not-found is normal (e.g. no control-out.jsonl on legacy cassettes) — stay quiet.
    // Any other error (permissions, corrupted inode, etc.) is unexpected and must be loud.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      warn(`::warning:: [replay] failed to read ${path}: ${String(err)}\n`);
    }
    return [];
  }
}

// readTimeline moved to src/agent/timeline.ts (see that file's doc comment for why) — imported above.
