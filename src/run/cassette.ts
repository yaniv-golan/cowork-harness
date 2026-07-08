import { z } from "zod";
import { warn } from "../io.js";
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
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname, relative, isAbsolute, resolve, sep } from "node:path";
import {
  type Scenario,
  type RunResult,
  type Assertion,
  type Fingerprint,
  type StalenessFinding,
  Assertion as AssertionSchema,
  VERDICT_MODIFIER_KEYS,
} from "../types.js";
import { executeScenario, parseScenarioFile, collectArtifactPaths, parseSessionFile, slugForPath } from "./execute.js";
import { assembleRunResult } from "./assemble-run-result.js";
import { loadSession, resolveSessionPaths } from "../session.js";
import { loadBaseline } from "../baseline.js";
import { decideLoopFromBaseline } from "../loop-decision.js";
import { Run, infraErrorsForResult, evidenceErrorsForResult, type RunHooks, type RunRecord } from "./run.js";
import {
  parseMessage,
  serializeDecision,
  deserializeDecision,
  canon,
  hookEventFrom,
  type AgentSession,
  type AgentEvent,
  type DecisionRequest,
} from "../agent/session.js";
import { readTimeline, type TimelineHeader, type TimelineEvent } from "../agent/timeline.js";
import { foldToolDurations, foldSkillActivity, attributeSubagentSkills } from "./timeline-fold.js";
import { ABSTAIN, UnansweredError, type Decider, type OnUnanswered } from "../decide/decider.js";
import { fileChannel, type DecisionChannel } from "../decide/external-channel.js";
import { pMapBounded } from "../async-pool.js";

/** Upper bound for `record --concurrency`. Above a handful, concurrent runs exhaust Docker's default address
 *  pool (each run creates two networks) and press model API rate limits — both surface as actionable errors. */
const MAX_RECORD_CONCURRENCY = 8;
import { evaluate, budgetFields, type AssertContext } from "../assert.js";
import { anyGlobMatches } from "../glob.js";
import { extractComputerLinks } from "./computer-links.js";
import { makeRenderer, renderFooter, type RenderPlan } from "./renderer.js";
import { jsonEnvelope, jsonPayloadEnvelope, parseOutputFormat, fail, isJsonOutput } from "./envelope.js";
import { parseArgs } from "../cli-args.js";
import { resolveInputs } from "./inputs.js";
import { realProbe } from "./doctor.js";
import { hashSkillDirs, hashSharedOnly, computeContentSig, skillHashEntries, OS_JUNK_PATTERN, agentSkillName } from "./skill-hash.js";
import { computeVerdict } from "./verdict.js";
import { redactJsonLine, redactText, redactStructural, loadRedactionPolicy, type RedactionPolicy } from "../redact.js";
import { collectSecrets, scrub, scrubField } from "../secrets.js";
import { scanText, DEFAULT_SCAN_PATTERNS, MANIFEST_SCAN_PATTERNS, type ScanFinding, type AllowInput, type AllowPattern } from "../scan.js";
import { parse as parseYaml } from "yaml";

// Synchronous fd writes (match cli.ts): a `process.stdout.write` + `process.exit()` pair truncates the
// machine envelope on a PIPE (fd 1 goes non-blocking once the stream is touched; the async tail is dropped
// at exit past the ~64KB buffer). writeSync blocks until drained.
const out = (s: string) => writeSync(1, s + "\n");
const log = (s: string) => writeSync(2, s + "\n");

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
   *  mode:r connected-folder input (assert on a deliverable instead); "unreadable" = a read/containment
   *  failure at record time (sha256 is ""). ABSENT on pre-v8 cassettes → replay falls back to naming both
   *  size/readonly causes. v8+. */
  truncationReason?: "size" | "readonly" | "unreadable";
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
  // fidelity; `agentBinaryFormat` mirrors baseline.agentBinary.format. Additive, looseObject → no
  // CASSETTE_VERSION bump. Readers that don't know it ignore it (backward-compat).
  environment?: { location: "local" | "cloud"; tier?: string; agentBinaryFormat?: string };
}

/** Current cassette format version. Readers tolerate ABSENT (legacy → 0) and warn on a FUTURE version. */
// v2: the fingerprint may be SCOPED to a scenario's `skills:` (whole-tree default stays byte-identical
// to v1). Bumped because a scoped `skillHash` is not reproducible by a pre-v2 reader — which would recompute
// whole-tree and mis-flag a scoped cassette as stale; the version lets such a reader warn instead.
// v3: adds `contentSig` to Fingerprint — an algorithm-independent content fingerprint that survives
// hash-algorithm changes, enabling `rehash` to migrate cassettes without a full re-record.
// v4: persists `userVisibleRoots` (outputs + resolved folder mount names) so replay derives
// user_visible_artifact from the real mount set instead of a hardcoded `.projects/` prefix. A folder-
// artifact cassette recorded pre-v4 has no folder root stored → must be RE-RECORDED, not rehashed
// (rehash only re-hashes skill fingerprints; it cannot reconstruct folder names).
// v5: `skillHash` EXCLUDES OS-junk files (.DS_Store/Thumbs.db/desktop.ini/…) so an out-of-band OS
// metadata touch can't re-stale a cassette; per-file manifest (`fileSigs`) added for exact-diff reporting.
// v6 (staleness redesign — breaking): `contentSig` is UNIFIED onto the `skillHash` walk (same file set:
// OS-junk/scope/ignore + in-tree-symlink-by-target), and the **git-tracked file set is the DEFAULT boundary**
// (a dir in a git work tree hashes/delivers only tracked files; non-repo dirs fall back to raw). The
// `contentSig` algorithm therefore changed → a pre-v6 cassette's `contentSig` is non-comparable, so `rehash`
// routes pre-v6 cassettes to a re-record (honest "algorithm changed" message, not "content changed").
// v7: NUL-byte entry separator in hashDir and computeContentSig (replaces `\n`) to prevent hash collisions
// for file paths containing newline characters.
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
export const CASSETTE_VERSION = 10;
// The contentSig algorithm version. Bumped whenever computeContentSig's INPUT/encoding changes (the v6
// unification). `rehash` only byte-compares contentSig within the same algo version; across a bump it
// re-records. Derived from cassetteVersion: < 6 ⇒ algo 1 (legacy), ≥ 6 ⇒ algo 2 (unified),
// ≥ 7 ⇒ algo 3 (NUL-byte separator), ≥ 8 ⇒ algo 4 (skillHash folds fixed-length content shas +
// contentSig/link entries are type-prefixed & NUL-framed — closes unframed-concatenation collisions).
const CONTENTSIG_ALGO = 4;
const contentSigAlgoOf = (cassetteVersion: number) => (cassetteVersion >= 8 ? 4 : cassetteVersion >= 7 ? 3 : cassetteVersion >= 6 ? 2 : 1);

/** Canonical URL of the JSON Schema for this cassette format version.
 *  Appears in every written cassette as `$schema` so editors and unfamiliar readers
 *  can discover what tool produced the file and what the format means. */
const CASSETTE_SCHEMA_URL = `https://raw.githubusercontent.com/yaniv-golan/cowork-harness/main/schema/cassette.v${CASSETTE_VERSION}.json`;

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

/** a buffer round-trips losslessly through UTF-8 only if re-encoding the decoded string reproduces
 *  the exact bytes. Binary content (and lone surrogates / invalid sequences) fail this — store them base64. */
function isLosslessUtf8(buf: Buffer): boolean {
  return Buffer.from(buf.toString("utf8"), "utf8").equals(buf);
}

/** Snapshot the user-visible artifacts under `workRoot` into manifest entries.
 *  Exported for token-free record→replay round-trip tests. */
export function buildManifest(
  workRoot: string,
  cap?: number,
  roots: string[] = ["outputs", ".projects"],
  bodyLessPrefixes: string[] = [],
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
  return collectArtifactPaths(workRoot, roots).map((e): ManifestEntry => {
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
    // cassette-level roots list: "readonly" (a mode:r input — assert on a deliverable) vs "size" (over
    // the body cap — raise --max-artifact-bytes). "unreadable" is the catch branches above.
    if (isBodyLess(path)) return { path, bytes, sha256, truncated: true, truncationReason: "readonly" };
    if (buf.length > limit) return { path, bytes, sha256, truncated: true, truncationReason: "size" };
    // store an encoding marker. UTF-8-safe bodies stay text (readable cassettes); binary bodies go
    // base64 so the record→replay round-trip is byte-exact and the sha256 verify stays valid.
    if (isLosslessUtf8(buf)) return { path, bytes, sha256, body: buf.toString("utf8") };
    return { path, bytes, sha256, body: buf.toString("base64"), encoding: "base64" };
  });
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
function skillSourceDirs(sessionPath: string, cassetteDir?: string): { dirs: string[]; baseDir: string; hashIgnore: string[] } {
  const resolved = cassetteDir && !isAbsolute(sessionPath) ? join(cassetteDir, sessionPath) : sessionPath;
  const baseDir = dirname(resolved);
  if (sessionPath === "(inline)" || !existsSync(resolved)) return { dirs: [], baseDir, hashIgnore: [] };
  let cfg;
  try {
    // Mirror loadSessionFromFile (execute.ts): parse the YAML, then RESOLVE its relative skill/plugin
    // paths against the session-file dir (`baseDir` — the post-cassetteDir-join location, so this works for
    // both the record call (no cassetteDir) and the replay call (cassetteDir set)). Passing the raw path
    // string to loadSession() throws (it wants parsed YAML) — the swallowed throw is why skillHash was
    // silently never computed.
    cfg = resolveSessionPaths(loadSession(parseSessionFile(resolved)), baseDir);
  } catch {
    return { dirs: [], baseDir, hashIgnore: [] };
  }
  const allDeclared = [...cfg.skills.local, ...cfg.plugins.local_plugins, ...cfg.plugins.remote_plugins, ...cfg.plugins.local_marketplaces];
  const dirs = allDeclared.filter((d) => {
    if (existsSync(d)) return true;
    process.stderr.write(`cowork-harness: skill source dir declared in session does not exist: ${d} — skipping from fingerprint\n`);
    return false;
  });
  // session-declared ignore globs (added to any plugin-local .cowork-hashignore inside hashSkillDirs).
  return { dirs, baseDir, hashIgnore: cfg.staleness.hash_ignore };
}

export function buildFingerprint(
  sessionPath: string,
  baselineAppVersion: string,
  cassetteDir?: string,
  scopeSkills?: string[],
): Fingerprint {
  const { dirs, baseDir, hashIgnore } = skillSourceDirs(sessionPath, cassetteDir);
  if (dirs.length === 0) return { baseline: baselineAppVersion };
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
    return { baseline: baselineAppVersion, skillSources: dirs.sort().map((d) => relative(baseDir, d)) };
  }
  // Store skillSources RELATIVE to the session-file dir — diagnostics only (the replay recompute re-derives
  // the dirs from the session), so a relative path is enough and never leaks an absolute `/Users/...` path.
  const fp: Fingerprint = {
    baseline: baselineAppVersion,
    skillHash: hashResult.hash,
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
  // for scoped cassettes, store the shared-root hash separately so checkStaleness can name
  // the changed bucket (skill vs shared root) at verify time.
  if (scopeSkills && scopeSkills.length) {
    // Only store sharedHash when ALL dirs are plugin-roots; a mix that includes individual-skill-mount dirs
    // (dirs without a top-level skills/) makes bucket diagnosis unreliable — those dirs contribute to
    // skillHash but not to sharedHash, so a change there would be mis-attributed to the scoped skill.
    const allPluginRoots = dirs.every((d) => {
      try {
        return statSync(join(d, "skills")).isDirectory();
      } catch {
        return false;
      }
    });
    if (allPluginRoots) {
      const sh = hashSharedOnly(dirs, hashIgnore);
      if (sh !== null) fp.sharedHash = sh;
    }
  }
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
  if (live.skillHash !== rec.skillHash) return "the skill/plugin source changed since this run was recorded";
  return null;
}

/** Session-SHAPE fingerprint (Finding 23) — a stable hash of the resolved session's content-relevant
 *  fields: connected folders (+ mode), plugin/skill/mcp discovery config, and the egress allowlist.
 *  Distinct from `buildFingerprint`'s skillHash (skill/plugin FILE content) — this covers what mounts/
 *  discovery/network the recorded run SAW, which can drift (a folder swapped, a plugin added, egress
 *  widened) with the skill tree itself completely unchanged, invisible to `fingerprint`. Mirrors
 *  `buildFingerprint`'s hashing approach (resolve the session, hash a canonical JSON shape) but over
 *  session shape rather than file content — so no raw host path is stored, only the digest. Returns
 *  undefined ("can't verify", never a false mismatch) for an inline scenario or when the session file
 *  can't be read/parsed from `sessionPath` (resolved against `cassetteDir` exactly like
 *  `skillSourceDirs`). Arrays are sorted before hashing so authoring order can't spuriously move the hash. */
export function buildSessionFingerprint(sessionPath: string, cassetteDir?: string): string | undefined {
  if (sessionPath === "(inline)") return undefined;
  const resolved = cassetteDir && !isAbsolute(sessionPath) ? join(cassetteDir, sessionPath) : sessionPath;
  if (!existsSync(resolved)) return undefined;
  let cfg;
  try {
    cfg = resolveSessionPaths(loadSession(parseSessionFile(resolved)), dirname(resolved));
  } catch {
    return undefined;
  }
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
 *  can't tell apart from customer data). Two stable structural forms:
 *   - the `system/init` event (tools/mcp_servers/skills/cwd registry), and
 *   - the `initialize` `control_response` (`request_id: "init-1"`; body = commands/agents/models/account).
 *  These get `email` + `path` + `machine-inventory` scanning (email is universal — the `account` field
 *  can carry the dev's own email; path is universal too — these messages' own structural fields,
 *  `cwd`/`plugins[].path`/`memory_paths`, are exactly where a real local filesystem path lives;
 *  machine-inventory is universal too — a live-enumerated app/process inventory sentinel is never
 *  legitimate manifest boilerplate, unlike the noisy classes which are suppressed only here). */
function isCapabilityManifest(line: string): boolean {
  let m: { type?: string; subtype?: string; response?: { request_id?: string; response?: Record<string, unknown> } };
  try {
    m = JSON.parse(line);
  } catch {
    return false;
  }
  if (m?.type === "system" && m?.subtype === "init") return true;
  if (m?.type === "control_response") {
    const r = m.response ?? {};
    if (r.request_id === "init-1") return true;
    const body = r.response;
    if (body && typeof body === "object" && "commands" in body && "agents" in body) return true; // shape fallback
  }
  return false;
}

export function scanCassette(cassette: Cassette, allow: AllowInput[]): ScanFinding[] {
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
  findings.push(...scanText(cassette.scenario.prompt, "scenario.prompt", allow, FULL));
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
  return findings;
}

const DEBUG_SKILLHASH_ENV = "COWORK_HARNESS_DEBUG_SKILLHASH";

/** Debug: dump the per-file entries currently feeding the skill hash for a session (same resolution as
 *  `buildFingerprint`), so a staleness mismatch shows WHICH files are in the hash — incl. unexpected
 *  OS-junk / run-generated files that are the usual "stale immediately after record" cause. */
export function explainSkillHash(
  sessionPath: string,
  cassetteDir: string | undefined,
  scopeSkills?: string[],
): { path: string; sha: string }[] {
  const { dirs, hashIgnore } = skillSourceDirs(sessionPath, cassetteDir);
  if (dirs.length === 0) return [];
  return skillHashEntries(dirs, scopeSkills, hashIgnore);
}

/** Debug: on a skillHash mismatch, if COWORK_HARNESS_DEBUG_SKILLHASH=1, write the file set the hash sees
 *  to stderr (flagging OS-junk) plus whether the algorithm-independent contentSig also drifted. When the flag
 *  is OFF, write a one-line hint so the affordance is discoverable. Diagnostics only — never affects the gate. */
function debugSkillHashMismatch(cassette: Cassette, cassetteDir: string, fp: Fingerprint, live: Fingerprint): void {
  if (process.env[DEBUG_SKILLHASH_ENV] !== "1") {
    process.stderr.write(
      `cowork-harness: skill-hash: set ${DEBUG_SKILLHASH_ENV}=1 to list the files feeding the hash (find the drift source)\n`,
    );
    return;
  }
  const scope = cassette.scenario.skills?.length ? cassette.scenario.skills.join(", ") : "whole-tree";
  let entries: { path: string; sha: string }[] = [];
  try {
    entries = explainSkillHash(cassette.scenario.session, cassetteDir, cassette.scenario.skills);
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
          `cassette predates effectiveFidelity, but the scenario pins an explicit tier ('${authored}') — tier statically knowable; nothing baseline-dependent to verify`,
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
export function computeStaleness(cassette: Cassette, cassetteDir: string | undefined): { findings: StalenessFinding[]; notes: string[] } {
  const tier = computeTierStaleness(cassette);
  const findings: StalenessFinding[] = [...tier.findings];
  const notes: string[] = [...tier.notes];
  const fp = cassette.fingerprint;
  if (!fp) return { findings, notes };
  let liveBaseline: string | undefined;
  try {
    liveBaseline = loadBaseline("latest").appVersion;
  } catch {
    /* baseline not loadable */
  }
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
  if (fp.skillHash) {
    const live = buildFingerprint(cassette.scenario.session, fp.baseline, cassetteDir, cassette.scenario.skills);
    const recMode = fp.mode ?? "raw";
    const liveMode = live.mode ?? "raw";
    if (live.skillHash === undefined)
      findings.push({
        class: "unverifiable-skill",
        message: "skill dirs not resolvable from the cassette location — cannot verify skill staleness (can't verify ⇒ not green)",
      });
    else if (recMode !== liveMode)
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
      debugSkillHashMismatch(cassette, cassetteDir ?? "", fp, live); // surface WHICH files drifted
      const recordedVersion = cassette.cassetteVersion ?? 0;
      if (recordedVersion < CASSETTE_VERSION) {
        findings.push({
          class: "format",
          message: `recorded under an older hash format (v${recordedVersion} → v${CASSETTE_VERSION}) — re-record once after upgrading`,
        });
      } else if (fp.sharedHash !== undefined && live.sharedHash !== undefined) {
        // attribute drift to the shared and/or skill bucket(s). `skillScope` is always
        // non-empty when `sharedHash` is set (single assignment site under the same guard in buildFingerprint);
        // the `?? []` is a defensive guard only — the on-disk cassette shape is not schema-validated.
        const scopeArr = fp.skillScope ?? [];
        const scopeLabel = scopeArr.map((s) => `skills/${s}`).join(", ") || "skill";
        const scopeSet = new Set(scopeArr);
        const scopeAgents = (live.agentScope ?? "off") === "skill";
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
        const summary = fp.fileSigs && live.fileSigs ? diffFileSigs(fp.fileSigs, live.fileSigs) : null;
        if (summary) findings.push({ class: "skill", message: `skill files changed since record — ${summary} — re-record` });
        else findings.push({ class: "skill", message: "local skill/plugin dir contents changed since record — re-record" });
      }
    }
  }
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
    subagentTools: new Set(),
    subagents: [],
    questions: [],
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
export class CassetteAgentSession implements AgentSession {
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

  respond(id: string, r: import("../agent/session.js").DecisionResponse): void {
    if (!this.hasControlOut) return; // no-op in legacy mode
    const req = this.reqById.get(id);
    if (!req) return;
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
function buildReplayDecider(session: CassetteAgentSession, controlOutIndex: Map<string, Record<string, unknown>>): Decider {
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
    const normRoots = redactedRoots.map(norm);
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
  const redactedPreRunPaths = cassette.preRunPaths?.map((p) => redactText(p, policy));
  // preRunHashes VALUES are hex sha256 (or null) — no secrets, never redacted. The KEYS are paths (same
  // privacy surface as preRunPaths entries), so redact each key and keep the value as-is.
  const redactedPreRunHashes =
    cassette.preRunHashes && Object.fromEntries(Object.entries(cassette.preRunHashes).map(([k, v]) => [redactText(k, policy), v]));
  return {
    ...cassette,
    scenario,
    userVisibleRoots: redactedRoots,
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
      detail = `pre-redaction pass=${vb.pass} → redacted pass=${vr.pass}`;
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
    const aj = a.artifact_json;
    if (!aj?.artifact) continue;
    if (truncatedAbs.has(resolve(workRoot, aj.artifact)) && !hits.includes(aj.artifact)) hits.push(aj.artifact);
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
  cassette: Pick<Cassette, "scenarioSource"> & { scenario: { name: string } },
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

export function _findScenarioOnDisk(cassettePath: string, scenarioName: string): string | null {
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
async function recordScenarioFile(file: string, opts: RecordOpts): Promise<{ result: RunResult; cassettePath: string; artifacts: number }> {
  // remember the authored scenario source file so the cassette can persist it (relocatable) for a
  // later `--rerecord-stale` that prefers it over a name-derived guess.
  return recordScenarioObject(parseScenarioFile(file), { ...opts, scenarioSourceFile: file }, [dirname(file)]);
}

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
      // --quiet/--verbose accepted for flag consistency but currently no-op in record (renderer plan is fixed).
      booleans: [
        "--no-redact",
        "--allow-failing",
        "--rerecord-stale",
        "--from-embedded",
        "--force",
        "--quiet",
        "--verbose",
        "--dry-run",
        "--decider-llm",
      ],
      values: [
        "--out",
        "--output-format",
        "--max-artifact-bytes",
        "--decider-dir",
        "--intent",
        "--decider-model",
        "--on-unanswered",
        "--concurrency",
      ],
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
  const target = p.positionals[0];
  if (!target) {
    return fail(
      "record",
      "usage",
      "usage: record <scenario.yaml | dir/> [--out <file>] [--output-format text|json] [--rerecord-stale] [--no-redact] [--allow-failing] [--max-artifact-bytes <n>] [--concurrency <N>]\n" +
        '       answer gates live during the recording: [--decider-dir <dir>] (single scenario) | [--decider-llm [--intent "…"] [--decider-model <id>]] | [--on-unanswered fail|first]',
      undefined,
      asJson,
    );
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

    const token = realProbe.hasToken();
    const agent = realProbe.agentBinary();
    const tokenLine = token ? "  token:  found" : "  token:  ✗ MISSING — set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY";
    const agentLine = agent.ok ? `  agent:  ${agent.path}` : `  agent:  ✗ ${agent.error.split("\n")[0]}`;
    const agentPayload = agent.ok ? { ok: true as const, path: agent.path } : { ok: false as const, error: agent.error };

    if (isDir) {
      const disc = discoverScenarios(target);
      if (asJson) {
        out(
          jsonPayloadEnvelope("record", true, {
            dryRun: true,
            target,
            scenarios: disc.scenarios,
            skipped: disc.skipped,
            broken: disc.broken,
            token,
            agent: agentPayload,
          }),
        );
      } else {
        for (const s of disc.skipped) log(`· skipped: ${s}`);
        for (const b of disc.broken) log(`✗ broken: ${b.file}: ${b.error}`);
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
      if (!asJson) {
        log(`record --dry-run: ${disc.scenarios.length} scenario(s) in ${target}`);
        for (let i = 0; i < disc.scenarios.length; i++) log(`  [${i + 1}] ${disc.scenarios[i]}`);
        log(tokenLine);
        log(agentLine);
      }
      // Exit 1 when there are broken files (they won't run but the user should know).
      return process.exit(disc.broken.length > 0 ? 1 : 0);
    }

    // Single scenario dry-run.
    let scenario;
    try {
      scenario = parseScenarioFile(target);
    } catch (e) {
      return fail("record", "usage", `record --dry-run: cannot parse scenario: ${(e as Error).message}`, undefined, asJson);
    }
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
    } else {
      log("record --dry-run");
      log(`  scenario: ${scenario.name}`);
      log(`  file:     ${target}`);
      if (scenario.fidelity) log(`  fidelity: ${scenario.fidelity}`);
      log(`  cassette: ${cassettePath}`);
      log(tokenLine);
      log(agentLine);
    }
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
      "record: no model credentials — set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY " +
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
            { noRedact, allowFailing, cassettePath: cp, maxArtifactBytes, skipRedactionPreflight: true },
          );
        }
        log(`  ✓ ${tag} ${cp} (${r.result.result})`);
        return true;
      } catch (e) {
        log(`  ✗ ${tag} ${cp}: ${recordErrorText(e)}`);
        return false;
      }
    });
    const failures = outcomes.filter((ok) => !ok).length;
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
      log(`${tag} recording ${f}…`);
      try {
        const r = await recordScenarioFile(f, { noRedact, allowFailing, maxArtifactBytes, skipRedactionPreflight: true, ...liveDecider });
        log(`  ✓ ${tag} → ${r.cassettePath} (${r.result.result})`);
        return true;
      } catch (e) {
        log(`  ✗ ${tag} ${recordErrorText(e)}`);
        return false;
      }
    });
    const failures = disc.broken.length + outcomes.filter((ok) => !ok).length;
    log(
      failures > 0
        ? `✗ record: ${failures} of ${disc.scenarios.length + disc.broken.length} failed`
        : `✓ record: ${disc.scenarios.length} cassette(s)`,
    );
    return process.exit(failures > 0 ? 1 : 0);
  }

  // Single scenario file. `--decider-dir` opens an in-band file rendezvous for the driving agent; close it
  // after the run (mirrors `run`'s one-channel lifecycle).
  const channel = deciderDir !== undefined ? fileChannel(deciderDir) : undefined;
  try {
    const cassettePath = p.options["--out"];
    const r = await recordScenarioFile(target, {
      noRedact,
      allowFailing,
      force,
      cassettePath,
      maxArtifactBytes,
      externalChannel: channel,
      ...liveDecider,
    });
    if (asJson) out(jsonEnvelope("record", [r.result], { extra: { artifacts: r.artifacts, cassette: r.cassettePath } }));
    else log(`✓ recorded ${r.result.result} · ${r.artifacts} artifact(s) → ${r.cassettePath}`);
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
async function recordScenarioObject(
  scenario: Scenario,
  opts: RecordOpts,
  extraPolicyDirs: string[] = [],
): Promise<{ result: RunResult; cassettePath: string; artifacts: number }> {
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
  // Thread the live-decider opts. All undefined for a plain `record` → identical to the
  // previous opt-less call (executeScenario defaults onUnanswered to scenario.on_unanswered ?? "fail").
  const result = await executeScenario(scenario, {
    command: "record",
    onUnanswered: opts.onUnanswered,
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
      // Whole-field marker replacement destroys the deliverable content — artifact_json /
      // user_visible_artifact assertions on this artifact will fail at replay, exactly like the base64
      // case above. Warn so the author isn't surprised. (Inline literal scrubs leave the rest of the
      // body intact, so they stay silent.)
      warn(
        `::warning:: record: artifact "${a.path}" contains a secret in whole-field encoded content — ` +
          `body replaced with redaction marker; artifact_json/user_visible_artifact assertions on this artifact will fail at replay\n`,
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
      (a) => a.input_unmodified !== undefined && nulledPaths.some((p) => anyGlobMatches(a.input_unmodified!, p)),
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
        `artifact_json asserts artifact(s) too large to commit (>${cap} B, stored hash-only): ${truncatedAsserted.join(", ")} — ` +
        `this passes at record (on-disk) but FAILS replay (no body). Raise --max-artifact-bytes / ` +
        `COWORK_HARNESS_MAX_ARTIFACT_BYTES, or assert a smaller artifact.`;
      if (opts.allowFailing) warn(`::warning:: record: ${msg}\n`);
      else throw new Error(msg);
    }
  }
  const timeline = readTimeline(result.outDir);
  // Load the baseline to extract agentBinaryFormat if available (optional).
  let agentBinaryFormat: string | undefined;
  try {
    const baseline = loadBaseline(result.baseline);
    agentBinaryFormat = baseline.agentBinary.format;
  } catch {
    // Baseline failed to load — proceed without agentBinaryFormat (it's optional).
  }
  const base: Cassette = {
    $schema: CASSETTE_SCHEMA_URL,
    generator: "cowork-harness",
    cassetteVersion: CASSETTE_VERSION,
    scenario: relocatable,
    events: safeLines(join(result.outDir, "events.jsonl")),
    controlOut: safeLines(join(result.outDir, "control-out.jsonl")),
    effectiveFidelity: result.effectiveFidelity,
    artifacts,
    userVisibleRoots: recordRoots,
    // (v8: no cassette-level readonlyFolderRoots — the read-only reason rides per-entry on
    // ManifestEntry.truncationReason, set by buildManifest above from RunResult.readonlyFolderRoots.)
    // co-present with userVisibleRoots by construction — a cassette carrying preRunPaths never hits
    // replay's legacy-roots fallback.
    preRunPaths: result.preRunPaths,
    // Nulled (not `result.preRunHashes` verbatim) for any path whose artifact body was secret-scrubbed
    // above — see the scrubbedPaths/nullOutScrubbedPreRunHashes block.
    preRunHashes,
    // persist the authored scenario source file RELATIVE to the cassette dir (relocatable, no
    // absolute host path) so `--rerecord-stale` re-records from the edited YAML even when name ≠ filename.
    scenarioSource: opts.scenarioSourceFile ? relative(dirname(cassettePath), opts.scenarioSourceFile) : undefined,
    fingerprint: buildFingerprint(scenario.session, result.baseline, undefined, scenario.skills),
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
    // Recording environment provenance — location is always "local" (this harness records only local),
    // tier is the resolved effective fidelity, agentBinaryFormat is optional (from baseline.agentBinary.format).
    environment: { location: "local", tier: result.effectiveFidelity, agentBinaryFormat },
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
  writeFileAtomic(cassettePath, JSON.stringify(cassette, null, 2)); // atomic — no partial cassette on a mid-write crash
  return { result, cassettePath, artifacts: artifacts.length };
}

/** A synthetic `result:"error"` RunResult for an unreadable/invalid cassette in a directory replay — so
 *  the JSON envelope's `ok` (results.every(pass)) turns false and can never report ok:true alongside a
 *  non-zero exit (the cardinal no-false-green rule). */
function replayErrorResult(file: string): RunResult {
  return assembleRunResult({
    scenario: file,
    fidelity: "replay",
    baseline: "",
    result: "error",
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
    presentedFiles: undefined, // no rec to read from on this early-bail lane
    preRunPaths: undefined,
    preRunLinkAware: undefined,
    preRunHashes: undefined,
    partial: undefined,
    unansweredGate: undefined,
    nonDeterministic: undefined,
    nonDeterministicTerminal: undefined,
    permissiveAutoAllow: undefined,
    scan: undefined,
    effectiveFidelity: undefined,
    fidelityWarnings: undefined,
    staleness: undefined,
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
  });
}

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
 *  Covers `prompt`/`baseline`/`fidelity`/`answers`/`skills`/`requires_capabilities` — the authored fields that
 *  shape what the recording is. `session` is DELIBERATELY excluded: the cassette stores it relative-to-cassette-dir
 *  while parseScenarioFile resolves it absolute, so a string-equal would never match (it'd brick every sessioned
 *  scenario); and the session is already baked into the frozen events with no cheap content hash to compare. Skill
 *  *content* drift is policed separately (failOnSkillDrift on the opt-in path) — and only when a skill fingerprint
 *  was recorded; the caller warns when it wasn't. */
function recordingShapingDrift(frozen: Scenario, onDisk: Scenario): string[] {
  const drifted: string[] = [];
  const norm = (v: unknown) => JSON.stringify(v ?? null);
  if ((frozen.prompt ?? "") !== (onDisk.prompt ?? "")) drifted.push("prompt");
  if ((frozen.baseline ?? "latest") !== (onDisk.baseline ?? "latest")) drifted.push("baseline");
  if ((frozen.fidelity ?? "container") !== (onDisk.fidelity ?? "container")) drifted.push("fidelity");
  if (norm(frozen.answers ?? []) !== norm(onDisk.answers ?? [])) drifted.push("answers");
  if (norm(frozen.skills ?? []) !== norm(onDisk.skills ?? [])) drifted.push("skills");
  if (norm(frozen.requires_capabilities ?? []) !== norm(onDisk.requires_capabilities ?? [])) drifted.push("requires_capabilities");
  return drifted;
}

/** Scenario-content drift for `verify-cassettes`: has the committed on-disk scenario's PROMPT diverged from
 *  the cassette's frozen copy? The fingerprint covers skill-dir content + baseline but NOT the scenario's own
 *  prompt, so an edited-but-not-re-recorded prompt silently diverges — invisible to `replay`/`verify-cassettes`
 *  and caught only by the opt-in `--assert-from`. Now covers ALL recording-shaping fields (prompt, baseline,
 *  fidelity, answers, skills, requires_capabilities — see recordingShapingDrift), each default-normalized so
 *  a `[]`-vs-undefined churn can't false-positive. A resolvable+drifted field from an EXACTLY-recorded
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
 *  unparsable YAML) the check can't run — "can't verify" is a non-failing note, never a mismatch. */
export function sessionFingerprintDrift(
  cassette: Pick<Cassette, "sessionFingerprint" | "scenario">,
  cassetteDir: string | undefined,
): { drifted: boolean; note?: string } {
  if (cassette.sessionFingerprint === undefined) return { drifted: false }; // pre-v9 — not checked
  const live = buildSessionFingerprint(cassette.scenario.session, cassetteDir);
  if (live === undefined)
    return {
      drifted: false,
      note: "session-fingerprint: could not resolve the current session file to recompute — cannot verify session-shape staleness",
    };
  return { drifted: live !== cassette.sessionFingerprint };
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
export type UncheckableReason = "manifest-missing" | "prerunpaths-missing" | "prerunhashes-missing" | "controlout-missing" | "live-only";

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
          message:
            "no pre-run manifest in this cassette (recorded pre-0.24 or on microvm) — re-record on harness ≥0.24 (container/hostloop)",
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
 *  `assert:`+`expect_denied:`; on that path recording-shaping drift (prompt/answers/baseline/skills) and skill
 *  staleness HARD-FAIL, so on-disk asserts can never green against events a different scenario/skill produced. */
export async function cmdReplay(args: string[]) {
  // Up-front JSON detection (see cmdRecord) so every error path emits the shared envelope in JSON mode.
  const asJson = isJsonOutput(args);
  let p;
  try {
    p = parseArgs(args, {
      // --quiet/--verbose accepted for flag consistency but currently no-op in replay (renderer plan is fixed).
      booleans: [
        "--strict",
        "--fail-on-skill-drift",
        "--reassert",
        "--write",
        "--allow-failing",
        "--explain",
        "--best-effort-future-cassette",
        "--quiet",
        "--verbose",
      ],
      values: ["--output-format", "--assert-from"],
      enums: { "--output-format": ["text", "json"] },
      aliases: { "-q": "--quiet" },
    });
  } catch (e) {
    return fail("replay", "usage", String((e as Error).message), undefined, asJson);
  }
  const target = p.positionals[0];
  if (!target) {
    return fail(
      "replay",
      "usage",
      "usage: replay <file.cassette.json | dir/> [--strict] [--fail-on-skill-drift] [--assert-from <scenario.yaml> | --reassert] [--write [--allow-failing]] [--explain] [--output-format text|json]",
      undefined,
      asJson,
    );
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
  for (const f of resolved.files) {
    const rc = readCassette(f); // safe parse + lenient Zod — never throws
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
            `(authored fields prompt/baseline/fidelity/answers/skills/requires_capabilities verified unchanged; ` +
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
            const onDisk = parseScenarioFile(src.path);
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
        } catch {
          /* on-disk file is decoration on the default lane — a parse/read failure must not affect the run */
        }
      }
      result = await replayCassette(cassette, renderer ? [renderer] : [], {
        strict,
        failOnSkillDrift,
        cassetteDir: dirname(f),
        bestEffortFutureCassette,
      });
    } catch (e) {
      log(`replay: ${f}: ${(e as Error)?.message ?? String(e)}`);
      results.push(replayErrorResult(f)); // turns the envelope's ok false (no false green)
      worst = Math.max(worst, 2);
      continue;
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
async function computeCassetteMargins(cassette: Cassette, cassetteDir: string): Promise<MarginRow[]> {
  const present = COUNT_BOUND_MARGIN_KEYS.map((spec) => {
    const entry = (cassette.scenario.assert ?? []).find((a) => (a as Record<string, unknown>)[spec.key as string] !== undefined);
    const budget = entry ? Number((entry as Record<string, unknown>)[spec.key as string]) : undefined;
    return budget !== undefined && Number.isFinite(budget) ? { spec, budget } : undefined;
  }).filter((x): x is { spec: (typeof COUNT_BOUND_MARGIN_KEYS)[number]; budget: number } => x !== undefined);
  if (present.length === 0) return [];
  const result = await replayCassette(cassette, [], { cassetteDir });
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
 *  staleness check over one cassette or every `*.cassette.json` in a dir (non-recursive). Exit 1 on any
 *  real PII finding or staleness drift; `unscanned` notes are informational. Dedicated JSON envelope.
 *  `--margins` adds a per-count-assert recorded-vs-budget report (a per-cassette replay cost, single-sample). */
export async function cmdVerifyCassettes(args: string[]) {
  // Up-front JSON detection (see cmdRecord) so every error path emits the shared envelope in JSON mode.
  const asJson = isJsonOutput(args);
  let p;
  try {
    p = parseArgs(args, {
      booleans: ["--skip-privacy", "--skip-staleness", "--skip-scenario-drift", "--margins", "--quiet", "--verbose"],
      values: ["--output-format"],
      repeated: ["--allow", "--allow-domain", "--allow-email", "--allow-path", "--allow-machine-inventory", "--allow-patterns-file"],
      enums: { "--output-format": ["text", "json"] },
      noDashValue: ["--allow-patterns-file"],
      aliases: { "-q": "--quiet" },
    });
  } catch (e) {
    return fail("verify-cassettes", "usage", String((e as Error).message), undefined, asJson);
  }
  const json = p.options["--output-format"] === "json";
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
    return fail(
      "verify-cassettes",
      "usage",
      "usage: verify-cassettes <file|dir> [--skip-privacy|--skip-staleness] [--skip-scenario-drift] [--margins] [--allow <regex>]... [--allow-domain <regex>]... [--allow-email <regex>]... [--allow-path <regex>]... [--allow-machine-inventory <regex>]... [--allow-patterns-file <path>]... [--output-format json]\n" +
        "  --allow <regex> is a PATTERN (matched against a finding); --allow-patterns-file <path> is a FILE of patterns, one regex per line — not a path to allow.\n" +
        "  --margins reports recorded-vs-budget for each count-bound assert (adds a per-cassette replay cost; a SINGLE-SAMPLE estimate — one cassette ≠ variance). Diagnostic only; never changes the gate verdict.",
      undefined,
      asJson,
    );
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
    return fail("verify-cassettes", "usage", `verify-cassettes: ${resolved.error}`, undefined, asJson);
  }
  const files = resolved.files;
  const results = files.map((f) => {
    const rc = readCassette(f);
    if ("error" in rc) return { file: f, findings: [], staleness: [], notes: [], version: [], scenarioDrift: [], error: rc.error };
    const findings = doPrivacy ? scanCassette(rc.cassette, allow) : [];
    // Direct computeStaleness call (not the checkStaleness string adapter) so the NON-failing `notes`
    // channel reaches the envelope — a note (e.g. pre-effectiveFidelity explicit-tier) must be surfaced,
    // never dropped, and must never red the gate.
    const stale = doStaleness ? computeStaleness(rc.cassette, dirname(f)) : { findings: [], notes: [] };
    const staleness = stale.findings.map((s) => s.message);
    const notes = [...stale.notes];
    // Session-shape fingerprint drift (Finding 23): gated by the SAME --skip-staleness toggle (it's a
    // staleness concept — session SHAPE, not skill content) but computed and hard-failed HERE ONLY, never
    // through computeStaleness/checkStaleness — so it can never affect the default `replay` verdict. A
    // pre-v9 cassette (no sessionFingerprint) is silently not checked; see sessionFingerprintDrift.
    if (doStaleness) {
      const sfd = sessionFingerprintDrift(rc.cassette, dirname(f));
      if (sfd.drifted)
        staleness.push(
          "session-shape fingerprint differs from the current session file (connected folders/plugin/skill/mcp/egress config changed since record) — re-record",
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
    return { file: f, findings, staleness, notes, version, scenarioDrift, error: undefined as string | undefined };
  });
  // --margins (diagnostic; never affects the gate): replay each cassette that carries count-bound asserts
  // and report recorded-vs-budget + margin. A per-cassette replay cost the base command doesn't have.
  let margins: { file: string; rows: MarginRow[]; error?: string }[] | undefined;
  if (doMargins) {
    margins = [];
    for (const f of files) {
      const rc = readCassette(f);
      if ("error" in rc) continue; // unreadable — already flagged in `results`; skip its margins
      try {
        const rows = await computeCassetteMargins(rc.cassette, dirname(f));
        if (rows.length) margins.push({ file: f, rows });
      } catch (e) {
        margins.push({ file: f, rows: [], error: (e as Error)?.message ?? String(e) }); // a diagnostic failure must not red the gate
      }
    }
  }
  const realFindings = results.flatMap((r) => r.findings.filter((x) => x.cls !== "unscanned"));
  const staleAny = results.some((r) => r.staleness.length > 0);
  const versionAny = results.some((r) => r.version.length > 0);
  const scenarioDriftAny = results.some((r) => r.scenarioDrift.length > 0);
  const errorAny = results.some((r) => r.error !== undefined);
  const ok = realFindings.length === 0 && !staleAny && !versionAny && !scenarioDriftAny && !errorAny;
  const coverage = { privacy: doPrivacy, staleness: doStaleness, scenarioDrift: doScenarioDrift };
  if (json) {
    out(jsonPayloadEnvelope("verify-cassettes", ok, { coverage, results, ...(margins ? { margins } : {}) }));
  } else {
    if (!doStaleness) log("⚠ cowork-harness: --skip-staleness: staleness check was skipped");
    if (!doPrivacy) log("⚠ cowork-harness: --skip-privacy: privacy scan was skipped");
    if (!doScenarioDrift) log("⚠ cowork-harness: --skip-scenario-drift: scenario prompt-drift check was skipped");
    for (const r of results) {
      if (r.error) log(`✗ ${r.file}: [error] ${r.error}`);
      for (const f of r.findings) log(`${f.cls === "unscanned" ? "·" : "✗"} ${r.file}: [${f.cls}] ${f.where} — ${f.sample}`);
      for (const s of r.staleness) log(`✗ ${r.file}: [stale] ${s}`);
      for (const d of r.scenarioDrift) log(`✗ ${r.file}: [scenario-drift] ${d}`);
      // Informational, never fails the gate (the `·` row mirrors the privacy channel's `unscanned` precedent).
      for (const n of r.notes) log(`· ${r.file}: [note] ${n}`);
      for (const v of r.version) log(`✗ ${r.file}: [version] ${v}`);
    }
    log(
      ok
        ? `✓ verify-cassettes: ${files.length} cassette(s) clean`
        : `✗ verify-cassettes: ${realFindings.length} PII finding(s)${staleAny ? " + staleness drift" : ""}${scenarioDriftAny ? " + scenario prompt drift" : ""}${versionAny ? " + version mismatch" : ""}${errorAny ? " + unreadable cassette(s)" : ""} across ${files.length} cassette(s)`,
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
  return process.exit(ok ? 0 : 1);
}

/** `cowork-harness rehash <dir/> [--dry-run] [--output-format text|json]`
 *
 *  Migrates cassettes recorded under an older `cassetteVersion` to the current version
 *  WITHOUT a full re-record — but ONLY when `contentSig` confirms the skill content is
 *  provably unchanged. Cassettes without `contentSig` (pre-v3) cannot be rehashed; re-record once.
 *
 *  Safe to run repeatedly: already-current cassettes are reported as skipped. */
export function cmdRehash(args: string[]): void {
  // isJsonOutput (not a bare `p.options` read): it works even when parseArgs throws below, and honors the
  // --output-format=json equals-form and the COWORK_HARNESS_OUTPUT_FORMAT env var a bare check would miss.
  const asJson = isJsonOutput(args);
  let p;
  try {
    p = parseArgs(args, {
      booleans: ["--dry-run"],
      values: ["--output-format"],
      enums: { "--output-format": ["text", "json"] },
    });
  } catch (e) {
    return fail("rehash", "usage", (e as Error).message, undefined, asJson);
  }
  if (p.positionals.length !== 1) {
    return fail("rehash", "usage", "usage: rehash <dir/> [--dry-run] [--output-format text|json]", undefined, asJson);
  }
  const dir = p.positionals[0];
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return fail("rehash", "usage", `rehash: not a directory: ${dir}`, undefined, asJson);
  }

  const dryRun = p.flags["--dry-run"] ?? false;

  let liveBaseline: string;
  try {
    liveBaseline = loadBaseline("latest").appVersion;
  } catch (e) {
    return fail("rehash", "runtime", `rehash: cannot load latest baseline — ${(e as Error).message}`, undefined, asJson, 1);
  }

  const files = readdirSync(dir)
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

    // Already at current version — nothing to do.
    if (recordedVersion >= CASSETTE_VERSION) {
      results.push({ file, action: "skipped", reason: `already at v${recordedVersion}` });
      continue;
    }

    // v10 records symlink/hardlink identity (ManifestEntry.linkKind) that the CONTENTSIG algorithm is
    // blind to, so `rehash`'s content-unchanged check cannot vouch for it — and rehash has only the old
    // manifest, not the vanished work tree, so it cannot synthesize the link entries a v10 cassette
    // promises. A silent version-stamp would mint a v10-labeled cassette that never actually captured its
    // links. Route a v9→v10 bump to a re-record. Placed AFTER the "already current" skip but this only
    // needs to block the eventual STAMP — the content/baseline gates below still run and their own
    // skip/error reasons (baseline drift, no contentSig) take precedence, so this fires only when a
    // cassette would otherwise have migrated cleanly.
    const crossesIntoV10 = recordedVersion < 10 && CASSETTE_VERSION >= 10;

    // No fingerprint — no skill dirs were tracked; only baseline staleness applies, which requires re-record.
    if (!cassette.fingerprint?.skillHash) {
      results.push({
        file,
        action: "skipped",
        reason: "no skillHash in fingerprint — only baseline drift is possible; re-record if needed",
      });
      continue;
    }

    // Pre-v3: no contentSig present — can't verify content is unchanged; must re-record once to adopt it.
    if (!cassette.fingerprint.contentSig) {
      results.push({
        file,
        action: "error",
        reason: "no contentSig (recorded before v3) — re-record once to enable `rehash` for future format bumps",
      });
      continue;
    }

    // Baseline drifted — a re-record is required regardless of skill content.
    if (cassette.fingerprint.baseline !== liveBaseline) {
      results.push({
        file,
        action: "skipped",
        reason: `baseline drifted (${cassette.fingerprint.baseline} → ${liveBaseline}) — re-record required`,
      });
      continue;
    }

    // Compute current contentSig from skill dirs relative to the cassette location.
    const liveFingerprint = buildFingerprint(
      cassette.scenario.session,
      cassette.fingerprint.baseline,
      dirname(file),
      cassette.scenario.skills,
    );

    if (!liveFingerprint.contentSig) {
      results.push({ file, action: "error", reason: "skill dirs not resolvable from cassette location — cannot compute contentSig" });
      continue;
    }

    // v6: contentSig is only comparable WITHIN the same algorithm version. The v6 unification changed the
    // algorithm, so a pre-v6 cassette's contentSig is apples-to-oranges — route it to a re-record with an
    // HONEST message (NOT "content changed", which would falsely imply the skill changed).
    if (contentSigAlgoOf(recordedVersion) !== CONTENTSIG_ALGO) {
      results.push({
        file,
        action: "error",
        reason: `the content-fingerprint algorithm changed in v${CASSETTE_VERSION} (unified file set / git-tracked) — \`rehash\` cannot bridge an input-set change; re-record to migrate`,
      });
      continue;
    }

    // The content check: current contentSig must match the recorded one (same algo version).
    if (liveFingerprint.contentSig !== cassette.fingerprint.contentSig) {
      results.push({
        file,
        action: "error",
        reason: "skill content changed since recording (contentSig mismatch) — re-record required",
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

    // Safe to migrate: content is provably unchanged. Recompute the full fingerprint under the
    // current algorithm and bump cassetteVersion.
    if (!dryRun) {
      const updated: Cassette = {
        ...cassette,
        $schema: CASSETTE_SCHEMA_URL,
        generator: "cowork-harness",
        cassetteVersion: CASSETTE_VERSION,
        fingerprint: { ...liveFingerprint },
      };
      writeFileAtomic(file, JSON.stringify(updated, null, 2)); // atomic in-place rehash write (staleness keys on contentSig, not mtime — rename is safe)
    }
    results.push({
      file,
      action: "migrated",
      reason: `v${recordedVersion} → v${CASSETTE_VERSION}${dryRun ? " (dry-run)" : ""}`,
    });
  }

  const migrated = results.filter((r) => r.action === "migrated").length;
  const skipped = results.filter((r) => r.action === "skipped").length;
  const errors = results.filter((r) => r.action === "error").length;

  if (asJson) {
    out(jsonPayloadEnvelope("rehash", errors === 0, { dryRun, migrated, skipped, errors, results }));
  } else {
    for (const r of results) {
      const glyph = r.action === "migrated" ? "✓" : r.action === "error" ? "✗" : "·";
      log(`${glyph} ${r.file}: ${r.reason}`);
    }
    if (migrated > 0 || errors > 0) {
      log(
        errors > 0
          ? `✗ rehash: ${migrated} migrated, ${skipped} skipped, ${errors} could not migrate${dryRun ? " (dry-run)" : ""}`
          : `✓ rehash: ${migrated} cassette(s) migrated to v${CASSETTE_VERSION}${dryRun ? " (dry-run — nothing written)" : ""}`,
      );
    } else {
      log("✓ rehash: nothing to migrate");
    }
  }
  return process.exit(errors > 0 ? 1 : 0);
}

/** Record-time connected-folder host-path -> resolved-mount-name map (Finding 24), persisted onto a
 *  v9+ cassette's `folderPrefixMap`. Zips `recordRoots` (minus the leading `outputs`) against
 *  `scenario.session`'s `folders:` in file order — the SAME positional correspondence
 *  `buildLaunchPlan` itself relies on (one mount per `session.folders` entry, in that array's order) —
 *  but computed ONCE, right now, against the exact session state that produced `recordRoots`. That's
 *  the whole point: unlike the legacy replay-time reconstruction (`loadCassetteSessionFolders` below,
 *  still used for a pre-v9 cassette), this can never be fooled by a session file that changes AFTER
 *  record but happens to keep the same folder count. Returns undefined when the lengths disagree (an
 *  inline scenario, an unreadable/unparseable session, or a genuine mismatch) — a v9 cassette with no
 *  persisted map is a signal replay must respect, not paper over (see `buildFolderPrefixMap` / Finding 25). */
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
 * ONLY the legacy (pre-v9) replay path below calls this now — see `buildFolderPrefixMap`. A v9+
 * cassette uses its persisted `folderPrefixMap` instead of re-deriving this from whatever the session
 * file looks like AT REPLAY TIME.
 */
function loadCassetteSessionFolders(sessionPath: string, cassetteDir?: string): { from: string }[] {
  if (sessionPath === "(inline)") return [];
  const resolved = cassetteDir && !isAbsolute(sessionPath) ? join(cassetteDir, sessionPath) : sessionPath;
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

/**
 * Build the replay-lane `folderPrefixes` map (recorded connected-folder host path -> its resolved
 * mount name) for `computer_links_resolve`.
 *
 * v9+ cassette: use the PERSISTED `folderPrefixMap` (built at record time by
 * `buildRecordTimeFolderPrefixMap`) verbatim — never re-read the session file at replay time. Doing so
 * is exactly the bug this persisted map exists to close: a session file that changed since record but
 * still declares the same folder COUNT would otherwise zip cleanly into the WRONG host-path ->
 * mount-name pairs, a silent misresolution. When a v9+ cassette unexpectedly carries no persisted map,
 * return an empty map with `requiredButAbsent: true` — the caller must not fall back to reconstruction.
 *
 * Pre-v9 cassette: keep the legacy behavior — reconstruct from `userVisibleRoots` (persisted at record
 * time, v4+; lists `["outputs", ...folder mount names]` in the SAME order `buildLaunchPlan` pushes
 * folder mounts) zipped positionally against `loadCassetteSessionFolders`'s read of the CURRENT session
 * file. Only zips when the lengths agree; a legacy cassette without `userVisibleRoots`, or one whose
 * session file changed folder count since recording, yields an empty map (host-shaped folder links then
 * fall through to "no recorded prefix matched", never a wrong match) — unchanged, `requiredButAbsent`
 * never applies to a pre-v9 cassette.
 */
function buildFolderPrefixMap(cassette: Cassette, cassetteDir?: string): FolderPrefixResolution {
  const cassetteVersion = cassette.cassetteVersion ?? 0;
  if (cassetteVersion >= 9) {
    if (cassette.folderPrefixMap) return { map: new Map(cassette.folderPrefixMap.map((e) => [e.from, e.mount])), requiredButAbsent: false };
    return { map: new Map(), requiredButAbsent: true };
  }
  const map = new Map<string, string>();
  const roots = (cassette.userVisibleRoots ?? []).filter((r) => r !== "outputs");
  const folders = loadCassetteSessionFolders(cassette.scenario.session, cassetteDir);
  if (roots.length === folders.length) {
    for (let i = 0; i < roots.length; i++) map.set(folders[i].from, roots[i]);
  }
  return { map, requiredButAbsent: false };
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
  "questions_count_max",
  "gate_answers_delivered",
  "gate_answer_count_min",
  "hook_blocked",
  "no_hook_blocked",
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
  "egress_denied",
  "egress_allowed",
  "no_delete_in_outputs",
  "self_heal_ran",
  "transcript_no_host_path",
  "no_mcp_error",
  "max_peak_rss_bytes",
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
  opts: { strict?: boolean; failOnSkillDrift?: boolean; cassetteDir?: string; bestEffortFutureCassette?: boolean } = {},
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
  const { findings: staleness, notes: stalenessNotes } = computeStaleness(cassette, opts.cassetteDir);
  for (const s of staleness) warn(`::warning:: [replay] cassette stale: ${s.message}\n`);
  // Notes are the non-failing informational channel (pre-effectiveFidelity explicit-tier) — surfaced so
  // they're never a silent drop, but plain-info (no ::warning::) and never escalated by --strict.
  for (const n of stalenessNotes) warn(`[replay] cassette note: ${n}\n`);

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
      replayHookEvents.push(hookEventFrom(m.request.callback_id, reply, m.request.input));
    }
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
      "::warning:: [replay] no_unexpected_files: cassette has no pre-run manifest (recorded pre-0.24 or on microvm) — key skipped on replay; re-record on harness ≥0.24 (container/hostloop)\n",
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
      "file_exists",
      "user_visible_artifact",
      "artifact_json",
      "computer_links_resolve",
      "computer_links_resolve_if_present",
      "no_unexpected_files",
      "input_unmodified",
      "egress_denied",
      "egress_allowed",
      "no_delete_in_outputs",
      "self_heal_ran",
      "transcript_no_host_path",
      "no_mcp_error",
      "max_peak_rss_bytes",
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
  const folderPrefixResolution = buildFolderPrefixMap(cassette, opts.cassetteDir);
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

    // #1 footgun: replay must be LOUD about anything it can't check, in two distinct classes —
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
    const assertions = evaluate(replayable, {
      transcript: rec.transcript,
      toolsCalled: rec.toolsCalled,
      subagentTools: rec.subagentTools,
      egress: [],
      result: rec.result,
      workRoot: replayWorkRoot,
      userVisiblePrefixes: replayPrefixes,
      // Replay reads the body-less REASON per-entry from the materialized manifest (truncatedPaths, a
      // Map<path, reason>) — NOT a cassette-level roots list (removed in v8). Live/verify-run alone use
      // readonlyFolderRoots (they have no manifest at eval time), so it's empty here.
      readonlyFolderRoots: [],
      preRunPaths: cassette.preRunPaths,
      preRunLinkAware: replayLinkAware,
      preRunHashes: cassette.preRunHashes,
      // The authoritative post-run per-path sha256 from the manifest — NOT a re-hash of replayWorkRoot,
      // which materializeManifest fills with 0-byte placeholders for body-less entries (read-only inputs,
      // over-cap files). Re-hashing that placeholder would false-fail input_unmodified for a large-or-
      // read-only file that was never modified. Drop empty-sha256 entries (the "unreadable" catch branch
      // in buildManifest) so an unrecoverable file falls through to the re-hash/absent path honestly
      // instead of spuriously matching against "".
      postRunHashes: Object.fromEntries((cassette.artifacts ?? []).flatMap((e) => (e.sha256 ? [[e.path, e.sha256] as const] : []))),
      outputsDeletes: [],
      questions: rec.questions,
      hostPathLeaked: false,
      selfHealRan: false,
      subagents: rec.subagents,
      gateDeliveries: rec.gateDeliveries,
      toolResultTexts: rec.toolResults.map((r) => r.assertText ?? r.text),
      toolResultsTruncated: rec.toolResults.map((r) => r.assertText === undefined),
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
    });

    // under --strict, EVERY staleness finding becomes a failing assertion (non-zero exit), not just a
    // warning. --fail-on-skill-drift is the narrower gate: only the skill-source classes fail (incl.
    // `unverifiable-skill` — can't verify skill staleness ⇒ not green), while baseline / format / env-level
    // findings stay non-failing. `else if` makes --strict the superset when both are passed.
    const SKILL_DRIFT_CLASSES: ReadonlySet<StalenessFinding["class"]> = new Set(["skill", "shared-root", "unverifiable-skill"]);
    if (opts.strict)
      for (const s of staleness)
        assertions.push({ assertion: {} as Assertion, pass: false, message: `cassette stale (--strict): ${s.message}` });
    else if (opts.failOnSkillDrift)
      for (const s of staleness.filter((s) => SKILL_DRIFT_CLASSES.has(s.class)))
        assertions.push({ assertion: {} as Assertion, pass: false, message: `skill-source drift (--fail-on-skill-drift): ${s.message}` });

    // future cassette version — hard failure under --strict (forward semantics may not be
    // correctly interpreted here, so a green replay would be a false-green).
    if (futureVersionMsg && !opts.bestEffortFutureCassette)
      assertions.push({
        assertion: {} as Assertion,
        pass: false,
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
      });
    }

    // surface each serializeDecision mismatch as a failing replay_protocol_fidelity assertion.
    // Shape: { assertion: { replay_protocol_fidelity: true }, pass: false, message } — well-typed via types.ts.
    for (const m of session.mismatches) {
      assertions.push({
        assertion: { replay_protocol_fidelity: true },
        pass: false,
        message: `serializeDecision output for ${m.id} != recorded envelope: expected ${m.expected} got ${m.actual}`,
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
      });
    }

    // A truncated QUESTION (no recorded answer) surfaces here too — same exit-1 class as the permission case.
    if (truncatedMsg) {
      assertions.push({ assertion: { replay_protocol_fidelity: true }, pass: false, message: truncatedMsg });
    }

    return assembleRunResult({
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
      prompt: undefined,
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
      partial: undefined,
      unansweredGate: undefined,
      nonDeterministicTerminal: undefined,
      permissiveAutoAllow: undefined,
      scan: undefined,
      fidelityWarnings: undefined,
      l0PluginDivergence: undefined,
      missingCapabilityUse: undefined,
      gateProvenance: undefined,
      fingerprint: undefined,
      toolResults: undefined,
      durationMs: undefined,
      resources: undefined, // replay never spawns a sandbox to sample; no live resource telemetry
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
