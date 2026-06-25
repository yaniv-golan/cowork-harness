import { z } from "zod";
import { warn } from "../io.js";
import { readFileSync, writeFileSync, renameSync, mkdirSync, mkdtempSync, existsSync, readdirSync, statSync } from "node:fs";
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
import { executeScenario, parseScenarioFile, collectArtifacts, parseSessionFile, slugForPath } from "./execute.js";
import { loadSession, resolveSessionPaths } from "../session.js";
import { loadBaseline } from "../baseline.js";
import { Run, type RunHooks, type RunRecord } from "./run.js";
import {
  parseMessage,
  serializeDecision,
  deserializeDecision,
  canon,
  type AgentSession,
  type AgentEvent,
  type DecisionRequest,
} from "../agent/session.js";
import { ABSTAIN, UnansweredError, type Decider, type OnUnanswered } from "../decide/decider.js";
import { fileChannel, type DecisionChannel } from "../decide/external-channel.js";
import { pMapBounded } from "../async-pool.js";

/** Upper bound for `record --concurrency`. Above a handful, concurrent runs exhaust Docker's default address
 *  pool (each run creates two networks) and press model API rate limits — both surface as actionable errors. */
const MAX_RECORD_CONCURRENCY = 8;
import { evaluate } from "../assert.js";
import { makeRenderer, renderFooter, type RenderPlan } from "./renderer.js";
import { jsonEnvelope, parseOutputFormat } from "./envelope.js";
import { parseArgs } from "../cli-args.js";
import { resolveInputs } from "./inputs.js";
import { realProbe } from "./doctor.js";
import { hashSkillDirs, hashSharedOnly, computeContentSig, skillHashEntries, OS_JUNK_PATTERN } from "./skill-hash.js";
import { computeVerdict } from "./verdict.js";
import { redactJsonLine, redactText, redactStructural, loadRedactionPolicy, type RedactionPolicy } from "../redact.js";
import { collectSecrets, scrub, scrubField } from "../secrets.js";
import { scanText, DEFAULT_SCAN_PATTERNS, EMAIL_SCAN_PATTERNS, type ScanFinding, type AllowInput, type AllowPattern } from "../scan.js";
import { parse as parseYaml } from "yaml";

const out = (s: string) => process.stdout.write(s + "\n");
const log = (s: string) => process.stderr.write(s + "\n");

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

/** H5: write a committed cassette atomically — a mid-write crash must never leave a partial/corrupt file at
 *  the real path. Write to a same-dir temp (pid-suffixed so two concurrent writers can't collide) then
 *  `renameSync` over the target (atomic on POSIX). Mirrors the external-channel.ts temp+rename pattern. */
function writeFileAtomic(path: string, data: string): void {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/** #1: a snapshotted artifact — relative path + size + content hash, plus an inlined raw body for small
 *  files (so `artifact_json`/`file_exists`/`user_visible_artifact` survive token-free replay). A file too
 *  big to inline is hash-only with `truncated:true` (a loud marker — silent truncation reads as "covered"). */
interface ManifestEntry {
  path: string; // relative to the work root, e.g. "outputs/cap_state.json"
  bytes: number;
  sha256: string;
  body?: string; // inlined small-file body (≤ cap) — materialized on replay so JSON asserts work
  /** how `body` is encoded. "utf8" (default/absent) for text; "base64" for non-UTF-8/binary
   *  bodies, which would otherwise corrupt on a `toString("utf8")` round-trip (and then false-fail the
   *  sha256 verify, since the hash is over the RAW bytes). */
  encoding?: "utf8" | "base64";
  truncated?: boolean; // too big to inline → hash-only (file_exists/user_visible_artifact PASS — existence proven by path+sha; artifact_json cannot run)
}

/** #1b: a staleness tripwire over the inputs that determine the recording — mirrors `asarFingerprint`
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
  artifacts?: ManifestEntry[]; // #1: user-visible-roots snapshot (paths + hashes + small JSON bodies)
  fingerprint?: Fingerprint; // #1b: cassette→skill/baseline staleness tripwire
  // v4: the user-visible mount roots captured at record time (`outputs` + each connected folder's resolved
  // mount name). Replay reads THIS instead of a hardcoded `["outputs",".projects"]` prefix — folder mount
  // names are dynamic/gated. ABSENT on pre-v4 cassettes → replay falls back to the legacy prefix.
  userVisibleRoots?: string[];
  // the authored scenario SOURCE file this cassette was recorded from, RELATIVE to the cassette dir
  // (relocatable, no absolute host path). `record --rerecord-stale` prefers this over a `slugForPath(name)`
  // guess so an authored `name:` that differs from the filename still re-records from the edited YAML rather
  // than silently re-recording the embedded snapshot. ABSENT when recorded from an in-memory/inline scenario.
  scenarioSource?: string;
  // provenance: how this cassette's gate answers were authored. PRESENT with nonDeterministic:true means a
  // live decider actually answered ≥1 gate during recording (a driving agent via `--decider-dir`, a model
  // via `--decider-llm`, or an `--on-unanswered first` auto-pick) — so RE-recording may drift. The cassette
  // itself still REPLAYS deterministically (the answers are frozen). ABSENT = fully scripted/deterministic
  // authoring. Pure metadata: readers (replay/verify-cassettes) ignore it; no cassetteVersion bump needed.
  authoring?: { nonDeterministic: boolean; channel?: "decider-dir" | "decider-llm" };
}

/** Current cassette format version. Readers tolerate ABSENT (legacy → 0) and warn on a FUTURE version. */
// v2 (F-6): the fingerprint may be SCOPED to a scenario's `skills:` (whole-tree default stays byte-identical
// to v1). Bumped because a scoped `skillHash` is not reproducible by a pre-F-6 reader — which would recompute
// whole-tree and mis-flag a scoped cassette as stale; the version lets such a reader warn instead.
// v3: adds `contentSig` to Fingerprint — an algorithm-independent content fingerprint that survives
// hash-algorithm changes, enabling `rehash` to migrate cassettes without a full re-record.
// v4: persists `userVisibleRoots` (outputs + resolved folder mount names) so replay derives
// user_visible_artifact from the real mount set instead of a hardcoded `.projects/` prefix. A folder-
// artifact cassette recorded pre-v4 has no folder root stored → must be RE-RECORDED, not rehashed
// (rehash only re-hashes skill fingerprints; it cannot reconstruct folder names).
// v5 (H9): `skillHash` EXCLUDES OS-junk files (.DS_Store/Thumbs.db/desktop.ini/…) so an out-of-band OS
// metadata touch can't re-stale a cassette; per-file manifest (`fileSigs`) added for exact-diff reporting.
// v6 (staleness redesign — breaking): `contentSig` is UNIFIED onto the `skillHash` walk (same file set:
// OS-junk/scope/ignore + in-tree-symlink-by-target), and the **git-tracked file set is the DEFAULT boundary**
// (a dir in a git work tree hashes/delivers only tracked files; non-repo dirs fall back to raw). The
// `contentSig` algorithm therefore changed → a pre-v6 cassette's `contentSig` is non-comparable, so `rehash`
// routes pre-v6 cassettes to a re-record (honest "algorithm changed" message, not "content changed").
export const CASSETTE_VERSION = 6;
// The contentSig algorithm version. Bumped whenever computeContentSig's INPUT/encoding changes (the v6
// unification). `rehash` only byte-compares contentSig within the same algo version; across a bump it
// re-records. Derived from cassetteVersion: < 6 ⇒ algo 1 (legacy), ≥ 6 ⇒ algo 2 (unified).
const CONTENTSIG_ALGO = 2;
const contentSigAlgoOf = (cassetteVersion: number) => (cassetteVersion >= 6 ? 2 : 1);

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

/** The effective inline-body cap. Overridable (F-9) so a large structured deliverable can opt into inlining
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

/** #1: snapshot the user-visible artifacts under `workRoot` into manifest entries.
 *  Exported for token-free record→replay round-trip tests. */
export function buildManifest(workRoot: string, cap?: number, roots: string[] = ["outputs", ".projects"]): ManifestEntry[] {
  const limit = cap ?? defaultBodyCap();
  return collectArtifacts(workRoot, roots).map(({ path, bytes }) => {
    // collectArtifacts paths are derived from a directory walk; even though it already skips symlinks,
    // an entry must not inline content outside the work root. Re-confirm containment before reading the body.
    let abs: string;
    try {
      abs = containedPath(workRoot, path);
    } catch {
      return { path, bytes, sha256: "", truncated: true };
    }
    let buf: Buffer;
    try {
      buf = readFileSync(abs);
    } catch {
      return { path, bytes, sha256: "", truncated: true };
    }
    const sha256 = createHash("sha256").update(buf).digest("hex");
    if (buf.length > limit) return { path, bytes, sha256, truncated: true };
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

/** #1: materialize a manifest into a temp work root so replay can run the filesystem assertions against it.
 *  Small files get their inlined body (decoded per its encoding marker); hash-only (truncated)
 *  files get an empty placeholder. A truncated entry carries path+bytes+sha256 — positive proof the
 *  file existed at record time — so file_exists and user_visible_artifact PASS from the manifest;
 *  only artifact_json fails loud (it needs the inlined body). each path is containment-checked before
 *  writing so a hostile cassette entry can't escape the temp root. every non-truncated body is verified
 *  against its recorded sha256 (over the decoded RAW bytes) — a mismatch fails replay (throws). */
export function materializeManifest(
  entries: ManifestEntry[],
  roots: string[] = ["outputs", ".projects"],
): { workRoot: string; prefixes: string[]; truncatedPaths: Set<string> } {
  const workRoot = mkdtempSync(join(tmpdir(), "cwh-replay-"));
  const truncatedPaths = new Set<string>();
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
    if (e.truncated) truncatedPaths.add(relative(resolve(workRoot), abs));
  }
  return { workRoot, prefixes: roots, truncatedPaths };
}

/** #1b: the local skill/plugin/marketplace source dirs a session mounts — the "skill dir" hash unit.
 *  Returns ABSOLUTE dirs (for hashing/reading) plus `baseDir`, the session-file dir the relative
 *  `skillSources` are stored against (so the committed fingerprint carries no absolute host path — C1). */
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
  // F-6: session-declared ignore globs (added to any plugin-local .cowork-hashignore inside hashSkillDirs).
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
  // and unrelated VCS noise don't self-invalidate the fingerprint they were recorded under. F-6: when
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
  // Phase C: record the boundary mode only when git (the default raw needs no marker → keeps v<5 cassettes and
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
  // G-4: for scoped cassettes, store the shared-root hash separately so checkStaleness can name
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

/** A2: scan the WHOLE cassette surface for PII (default classes: email/currency/domain). A `truncated`
 *  artifact has NO committed body (hash-only) — nothing to leak — but is reported as `unscanned` so coverage
 *  is never silently implied. Real-class findings fail the gate; `unscanned` is informational. */
/** The agent's CAPABILITY MANIFEST — environment boilerplate, never user data, and the sole concentrated
 *  source of `domain`/`currency` scan noise (tool/skill catalog descriptions + MCP-server names a regex
 *  can't tell apart from customer data). Two stable structural forms:
 *   - the `system/init` event (tools/mcp_servers/skills/cwd registry), and
 *   - the `initialize` `control_response` (`request_id: "init-1"`; body = commands/agents/models/account).
 *  These get `email`-only scanning (email is universal — the `account` field can carry the dev's own email);
 *  the noisy classes are suppressed only here. */
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
  const FULL = DEFAULT_SCAN_PATTERNS; // email + currency + domain
  const EMAIL = EMAIL_SCAN_PATTERNS; // email only — for the capability-manifest messages
  // Transcript: full net EXCEPT the capability-manifest messages (catalog noise), where only email runs.
  cassette.events.forEach((l, i) => findings.push(...scanText(l, `events[${i}]`, allow, isCapabilityManifest(l) ? EMAIL : FULL)));
  cassette.controlOut?.forEach((l, i) => findings.push(...scanText(l, `controlOut[${i}]`, allow, isCapabilityManifest(l) ? EMAIL : FULL)));
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
        } else {
          findings.push({ where: `artifact ${a.path}`, cls: "unscanned", sample: "(binary body — decoded but not text-scannable)" });
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

/** H9 debug: dump the per-file entries currently feeding the skill hash for a session (same resolution as
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

/** H9 debug: on a skillHash mismatch, if COWORK_HARNESS_DEBUG_SKILLHASH=1, write the file set the hash sees
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

/** v5: diff two per-file manifests (recorded vs live) into an exact "what changed" SUMMARY — the actionable
 *  upgrade over the bucket-level "something changed". Returns just the summary (no prefix/suffix), so the
 *  caller can append it to the bucket/generic message (preserving the G-4 shared-vs-scoped semantic). Samples
 *  up to 3 paths per category. Null when the manifests are equal (hashes differ but files don't — caller
 *  falls back to its bucket message). */
function diffFileSigs(recorded: Array<[string, string]>, live: Array<[string, string]>): string | null {
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
  if (!added.length && !removed.length && !changed.length) return null;
  const sample = (a: string[]) => `${a.slice(0, 3).join(", ")}${a.length > 3 ? `, +${a.length - 3} more` : ""}`;
  const parts: string[] = [];
  if (changed.length) parts.push(`${changed.length} changed (${sample(changed)})`);
  if (added.length) parts.push(`${added.length} added (${sample(added)})`);
  if (removed.length) parts.push(`${removed.length} removed (${sample(removed)})`);
  return parts.join("; ");
}

/** B3 staleness GATE: recompute the fingerprint and report drift. Unlike `replayCassette` (which WARNS),
 *  the gate treats an unresolvable skillHash as a failure — can't verify ⇒ not green. No fingerprint → nothing
 *  to check (legacy cassette). */
export function checkStaleness(cassette: Cassette, cassetteDir: string): string[] {
  const fp = cassette.fingerprint;
  if (!fp) return [];
  const msgs: string[] = [];
  let liveBaseline: string | undefined;
  try {
    liveBaseline = loadBaseline("latest").appVersion;
  } catch {
    /* baseline not loadable */
  }
  // Gate mode: can't verify ⇒ not green. The cassette carries a baseline-of-record but we can't load the
  // current one to compare — a fail, not a silent skip (baselines ship with the package, so this is rare).
  if (liveBaseline === undefined)
    msgs.push(
      "cannot load the latest baseline to verify staleness — run `cowork-harness sync` or ship baselines/ (can't verify ⇒ not green)",
    );
  else if (liveBaseline !== fp.baseline) msgs.push(`baseline moved ${fp.baseline} → ${liveBaseline} since record — re-record`);
  if (fp.skillHash) {
    const live = buildFingerprint(cassette.scenario.session, fp.baseline, cassetteDir, cassette.scenario.skills);
    const recMode = fp.mode ?? "raw";
    const liveMode = live.mode ?? "raw";
    if (live.skillHash === undefined)
      msgs.push("skill dirs not resolvable from the cassette location — cannot verify staleness (gate fails: can't verify ⇒ not green)");
    else if (recMode !== liveMode)
      // Phase C: a hash from a different boundary mode is not comparable — don't emit a misleading content diff.
      msgs.push(
        `recorded in '${recMode}' file-set mode, verifying in '${liveMode}' (COWORK_HARNESS_GITSET) — re-record under the same mode`,
      );
    else if ((fp.agentScope ?? "off") !== (live.agentScope ?? "off"))
      // Agent-scoping flip (COWORK_HARNESS_AGENT_SCOPE): the scoped hash covers a different file set, so it's
      // not comparable — re-record under the same setting (mirrors the GITSET mode flip above).
      msgs.push(
        `recorded with agent-scope '${fp.agentScope ?? "off"}', verifying with '${live.agentScope ?? "off"}' (COWORK_HARNESS_AGENT_SCOPE) — re-record under the same setting`,
      );
    else if (live.skillHash !== fp.skillHash) {
      debugSkillHashMismatch(cassette, cassetteDir, fp, live); // H9: surface WHICH files drifted (or a hint to enable it)
      const recordedVersion = cassette.cassetteVersion ?? 0;
      // v5: name the EXACT changed/added/removed file(s) from the per-file manifest, APPENDED to the
      // bucket/generic message so the G-4 shared-vs-scoped semantic is preserved AND the file is named.
      const summary = fp.fileSigs && live.fileSigs ? diffFileSigs(fp.fileSigs, live.fileSigs) : null;
      const detail = summary ? ` [${summary}]` : "";
      if (recordedVersion < CASSETTE_VERSION) {
        msgs.push(`recorded under an older hash format (v${recordedVersion} → v${CASSETTE_VERSION}) — re-record once after upgrading`);
      } else if (fp.sharedHash !== undefined && live.sharedHash !== undefined) {
        // G-4: bucket-level diagnosis — which component of the scoped hash changed?
        const scope = fp.skillScope!.map((s) => `skills/${s}`).join(", ");
        if (live.sharedHash !== fp.sharedHash) {
          msgs.push(`shared root changed since record (scope: ${scope})${detail} — re-record`);
        } else {
          msgs.push(`${scope} changed since record${detail} — re-record`);
        }
      } else if (summary) {
        msgs.push(`skill files changed since record — ${summary} — re-record`);
      } else {
        msgs.push("local skill/plugin dir contents changed since record — re-record");
      }
    }
  }
  return msgs;
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
  };
}

/**
 * CassetteAgentSession: replays a recorded control-protocol cassette deterministically —
 * no token, no model, no flakiness.
 *
 * When `controlOut` is present (full-fidelity mode): decision events are yielded so Run drives
 * the decision pipeline; respond() re-serializes and compares to the frozen recording (O7 guard).
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
  /** #18/#4: decision ids that were yielded (and reached respond) but have NO recorded control_response
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
      // malformed AskUserQuestion body). On the LIVE path that throw is the right fail-closed behaviour, but
      // during REPLAY it fires deep inside start() and — re-thrown by replayCassette — aborts the entire
      // batch (one bad cassette poisons every later file). Catch it per-line, record a typed protocol error
      // so replayCassette surfaces a failing replay_protocol_fidelity assertion, and CONTINUE.
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
    // frozen recording — this is the O7 guard: if serializeDecision regresses (e.g. drops
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
      // #18/#4: a decision was yielded in full-fidelity mode but has no recorded control_response —
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

/** Apply CONTENT redaction (the opt-in policy) across the WHOLE cassette surface (C1): events/controlOut
 *  protocol lines (structurally — string leaves AND object keys, keeping JSON valid + the O7 question/answer
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
  const redactedArtifacts = cassette.artifacts?.map((a) => ({
    ...a,
    path: redactText(a.path, policy), // C1: a filename can name a customer (outputs/Acme-cap-table.json)
    // a base64 (binary) body has no text PII to redact, and redacting it would corrupt the bytes
    // and then false-fail the replay-time sha256 verify — leave binary bodies untouched.
    // Also skip bodies that are already secret-scrub redaction markers ([REDACTED:*]): rewriting
    // them without recomputing sha256 would produce a misleading "corrupt cassette" error at replay.
    ...(a.body !== undefined && a.encoding !== "base64" && !a.body.startsWith("[REDACTED") ? { body: redactJsonLine(a.body, policy) } : {}),
  }));
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
  return {
    ...cassette,
    scenario,
    userVisibleRoots: redactedRoots,
    artifacts: redactedArtifacts,
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

/** A3 / C4 cardinal-sin guard: redaction must be VERDICT-PRESERVING. Replay both the pre-redaction and the
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
 *     assertion passing would corrupt the cassette's replay-time sha256 verify; catch it here first. */
export async function assertRedactionVerdictPreserved(base: Cassette, redacted: Cassette): Promise<void> {
  const [rb, rr] = await Promise.all([replayCassette(base), replayCassette(redacted)]);
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

  // 3. Artifact SHA-256 hashes for text bodies — compare only non-truncated text-body entries.
  //    Binary (base64) bodies are excluded since redaction deliberately leaves them unchanged; their
  //    hash is already protected by the replay-time materializeManifest sha256 verify.
  const artifactHashes = (cassette: Cassette): string[] =>
    (cassette.artifacts ?? [])
      .filter((a) => !a.truncated && a.body !== undefined && a.encoding !== "base64" && a.sha256)
      .map((a) => `${a.path}:${a.sha256}`)
      .sort();

  const baseHashes = artifactHashes(base);
  const redactedHashes = artifactHashes(redacted);

  const verdictMismatch = vb.pass !== vr.pass;
  const pairsMismatch = basePairs.join("|") !== redactedPairs.join("|");
  const msgsMismatch = failedMsgs(rb).join("|") !== failedMsgs(rr).join("|");
  const hashesMismatch = baseHashes.join("|") !== redactedHashes.join("|");

  if (verdictMismatch || pairsMismatch || msgsMismatch || hashesMismatch) {
    let detail: string;
    if (verdictMismatch) {
      detail = `pre-redaction pass=${vb.pass} → redacted pass=${vr.pass}`;
    } else if (pairsMismatch) {
      const bf = failedKeys(basePairs);
      const rf = failedKeys(redactedPairs);
      detail = `assertion failures changed: [${bf.join(", ")}] → [${rf.join(", ")}]`;
    } else if (msgsMismatch) {
      detail = "failing assertion messages changed unexpectedly after redaction";
    } else {
      const changed = redactedHashes.filter((h) => !baseHashes.includes(h)).map((h) => h.split(":")[0]);
      detail = `artifact body hash(es) changed: ${changed.join(", ")}`;
    }
    throw new Error(
      `cowork-harness: redaction changed assertion failures: ${detail} — redaction altered an ` +
        `asserted observable; refusing to write a cassette whose verdict was manufactured by redaction (A3). ` +
        `Record against synthetic inputs, or narrow the redaction policy so it doesn't touch asserted values.`,
    );
  }
}

export interface ScenarioDiscovery {
  scenarios: string[]; // files with a top-level `prompt:` that parse as a valid Scenario
  skipped: string[]; // *.yaml with NO `prompt:` key — a session/other doc; announced, not a failure
  broken: { file: string; error: string }[]; // looks like a scenario (has `prompt:`) but unparseable/invalid
}

/** B1: classify the `*.yaml`/`*.yml` (non-recursive) under `dir` for batch `record`. Classification keys on a
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
  // validate each `scenario.assert` element against the assertion schema — but VALIDATE-AND-WARN,
  // never reject. CassetteShape is deliberately `z.looseObject`; a strict-by-default load would hard-reject
  // cassettes recorded by a NEWER harness that added an assertion key this build doesn't know (a forward-compat
  // regression). So a malformed/unknown assert element is surfaced as a loud warning, not a load error.
  scn.assert.forEach((a, i) => {
    const r = AssertionSchema.safeParse(a);
    if (!r.success)
      warn(
        `::warning:: [cassette] scenario.assert[${i}] is not a recognized assertion shape: ` +
          `${r.error.issues.map((iss) => `${iss.path.join(".") || "<root>"}: ${iss.message}`).join("; ")} ` +
          `(tolerated for forward-compat; pass --strict to a future hardened loader to reject)\n`,
      );
  });
  return { cassette };
}

/** B2: the committed cassettes under `dir` whose fingerprint has drifted (baseline/skill) — the re-record
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
  cassettePath?: string; // explicit --out (single); otherwise cassettes/<name>.cassette.json
  maxArtifactBytes?: number; // F-9: override the inline-body cap (else env / 64 KiB default)
  scenarioSourceFile?: string; // the on-disk scenario YAML this was recorded from (for --rerecord-stale)
  // Live-decider plumbing: answer gates DURING the recording instead of pre-scripting them.
  // `onUnanswered` = --on-unanswered fail|first ("llm" when --decider-llm); `externalChannel` = --decider-dir
  // file rendezvous; `llmIntent` = --decider-llm one-line intent; `deciderChannel` labels the authoring stamp.
  onUnanswered?: OnUnanswered;
  externalChannel?: DecisionChannel;
  llmIntent?: string;
  deciderChannel?: "decider-dir" | "decider-llm";
}

/** F-9: return the `artifact_json.artifact` paths a scenario asserts that ended up TRUNCATED in the manifest
 *  (body >cap, hash-only). Such an assertion passes at record (evaluated on the live on-disk file) but FAILS
 *  at replay (the materialized body is empty → "not valid JSON"). Paths are normalized through `resolve` so
 *  `./outputs/x.json` and `outputs/x.json` join cleanly against the manifest's walk paths. */
export function artifactJsonTargetsTruncated(scenario: Scenario, workRoot: string, artifacts: ManifestEntry[]): string[] {
  const truncatedAbs = new Set<string>();
  for (const a of artifacts) if (a.truncated) truncatedAbs.add(resolve(workRoot, a.path));
  if (truncatedAbs.size === 0) return [];
  const hits: string[] = [];
  for (const a of scenario.assert ?? []) {
    const aj = a.artifact_json;
    if (!aj?.artifact) continue;
    if (truncatedAbs.has(resolve(workRoot, aj.artifact)) && !hits.includes(aj.artifact)) hits.push(aj.artifact);
  }
  return hits;
}

/** G-1: probe for an on-disk scenario file at the two conventional locations relative to a cassette.
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
 *  run live + save a cassette. A single file records one; a dir batches (B1); --rerecord-stale (B2) treats
 *  the dir as committed cassettes and re-records only those whose fingerprint drifted. */
export async function cmdRecord(args: string[]) {
  let p;
  try {
    p = parseArgs(args, {
      // --quiet/--verbose accepted for flag consistency but currently no-op in record (renderer plan is fixed).
      booleans: ["--no-redact", "--allow-failing", "--rerecord-stale", "--quiet", "--verbose", "--dry-run", "--decider-llm"],
      values: ["--out", "--output-format", "--max-artifact-bytes", "--decider-dir", "--intent", "--on-unanswered", "--concurrency"],
      noDashValue: ["--out", "--decider-dir"],
      enums: { "--output-format": ["text", "json"], "--on-unanswered": ["fail", "first"] },
      aliases: { "-q": "--quiet", "-V": "--verbose" },
    });
  } catch (e) {
    log((e as Error).message);
    return process.exit(2);
  }
  let maxArtifactBytes: number | undefined;
  const mab = p.options["--max-artifact-bytes"];
  if (mab !== undefined) {
    const n = parseMaxArtifactBytes(mab);
    if (n === null) {
      log(`record: --max-artifact-bytes must be a positive integer (got ${mab})`);
      return process.exit(2);
    }
    maxArtifactBytes = n;
  }
  const noRedact = p.flags["--no-redact"] ?? false;
  if (noRedact) log("record: --no-redact — content redaction is OFF; the cassette is written verbatim, so ensure inputs are synthetic.");
  const allowFailing = p.flags["--allow-failing"] ?? false;
  const rerecordStale = p.flags["--rerecord-stale"] ?? false;
  // Live-decider flags: answer gates during the recording instead of pre-scripting them.
  const deciderDir = p.options["--decider-dir"];
  const deciderLlm = p.flags["--decider-llm"] ?? false;
  const intent = p.options["--intent"];
  const onUnansweredOpt = p.options["--on-unanswered"] as OnUnanswered | undefined;
  // Bounded batch parallelism (dir-batch / --rerecord-stale). Each record is already fully isolated per run
  // (unique sidecar networks + proxy, per-session run dir), so concurrency is safe — the bound exists to stay
  // under Docker's address pool + model API rate limits. Default 1 (sequential, ordered output).
  let concurrency = 1;
  const concRaw = p.options["--concurrency"];
  if (concRaw !== undefined) {
    const n = Number(concRaw);
    if (!Number.isInteger(n) || n < 1 || n > MAX_RECORD_CONCURRENCY) {
      log(`record: --concurrency must be an integer 1..${MAX_RECORD_CONCURRENCY} (got ${concRaw})`);
      return process.exit(2);
    }
    concurrency = n;
  }
  const asJson = p.options["--output-format"] === "json";
  const target = p.positionals[0];
  if (!target) {
    log(
      "usage: record <scenario.yaml | dir/> [--out <file>] [--output-format text|json] [--rerecord-stale] [--no-redact] [--allow-failing] [--max-artifact-bytes <n>] [--concurrency <N>]\n" +
        '       answer gates live during the recording: [--decider-dir <dir>] (single scenario) | [--decider-llm [--intent "…"]] | [--on-unanswered fail|first]',
    );
    return process.exit(2);
  }
  if (p.positionals.length > 1) {
    log(`record takes a single scenario or dir (got ${p.positionals.length}: ${p.positionals.join(", ")})`);
    return process.exit(2);
  }
  const isDir = existsSync(target) && statSync(target).isDirectory();
  // `--out` names ONE cassette; it has no meaning for a directory batch — reject rather than silently ignore.
  if (isDir && p.options["--out"] !== undefined) {
    log("record: --out names a single cassette file and is not valid for a directory batch");
    return process.exit(2);
  }

  // Live-decider validation. Reuse the run/skill rules; reject ambiguous/unsupported combos
  // up front so a paid record never starts under a mis-specified policy.
  if (intent !== undefined && !deciderLlm) {
    log("record: --intent requires --decider-llm (it states the test intent for the model answering live questions)");
    return process.exit(2);
  }
  if (deciderLlm && deciderDir !== undefined) {
    log("record: --decider-llm and --decider-dir are mutually exclusive terminals (a model vs a driving agent). Drop one.");
    return process.exit(2);
  }
  if (deciderLlm && onUnansweredOpt !== undefined) {
    log(`record: --decider-llm conflicts with --on-unanswered ${onUnansweredOpt} (it forces the model terminal). Drop one.`);
    return process.exit(2);
  }
  // --rerecord-stale re-records committed cassettes at the DEFAULT policy; a live decider there is undefined.
  if (rerecordStale && (deciderDir !== undefined || deciderLlm || onUnansweredOpt !== undefined)) {
    log(
      "record: --rerecord-stale cannot be combined with --decider-dir/--decider-llm/--on-unanswered (it re-records existing cassettes at the default policy)",
    );
    return process.exit(2);
  }
  // --decider-dir answers ONE interactive run in-band; a directory batch would interleave gates across N
  // cassettes on a single channel — bad UX. Restrict to a single scenario. (--decider-llm has no human, so a
  // batch is fine.)
  if (deciderDir !== undefined && isDir) {
    log("record: --decider-dir answers a single interactive recording; use it with one scenario, not a directory batch");
    return process.exit(2);
  }
  // --concurrency only applies to a batch (dir-batch or --rerecord-stale over a dir); a single scenario has
  // nothing to parallelize. (--decider-dir is already dir-rejected above, so it can't co-occur with a batch.)
  if (concurrency > 1 && !isDir) {
    log("record: --concurrency applies to a directory batch (or --rerecord-stale <dir>); a single scenario records one cassette");
    return process.exit(2);
  }

  const dryRun = p.flags["--dry-run"] ?? false;

  if (dryRun) {
    // Conflict guard: --dry-run + --rerecord-stale is undefined — dry-run of a stale re-record
    // has no clear semantics (it would need to select stale cassettes, which requires real FS work).
    if (rerecordStale) {
      log("record: --dry-run and --rerecord-stale cannot be combined");
      return process.exit(2);
    }

    const token = realProbe.hasToken();
    const agent = realProbe.agentBinary();
    const tokenLine = token ? "  token:  found" : "  token:  ✗ MISSING — set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY";
    const agentLine = agent.ok ? `  agent:  ${agent.path}` : `  agent:  ✗ ${agent.error.split("\n")[0]}`;

    if (isDir) {
      const disc = discoverScenarios(target);
      for (const s of disc.skipped) log(`· skipped: ${s}`);
      for (const b of disc.broken) log(`✗ broken: ${b.file}: ${b.error}`);
      if (disc.scenarios.length === 0) {
        if (disc.broken.length === 0) {
          log(`record --dry-run: no scenarios discovered under ${target}`);
          // Exit 2 for "nothing discovered at all" — matches the non-dry-run B1 path.
          return process.exit(2);
        }
        // Broken files found but no valid scenarios — exit 1 (broken, not nothing).
        return process.exit(1);
      }
      log(`record --dry-run: ${disc.scenarios.length} scenario(s) in ${target}`);
      for (let i = 0; i < disc.scenarios.length; i++) log(`  [${i + 1}] ${disc.scenarios[i]}`);
      log(tokenLine);
      log(agentLine);
      // Exit 1 when there are broken files (they won't run but the user should know).
      return process.exit(disc.broken.length > 0 ? 1 : 0);
    }

    // Single scenario dry-run.
    let scenario;
    try {
      scenario = parseScenarioFile(target);
    } catch (e) {
      log(`record --dry-run: cannot parse scenario: ${(e as Error).message}`);
      return process.exit(2);
    }
    // mirror the EXACT default cassette path recordScenarioObject uses (slugForPath via the shared
    // defaultCassettePath helper) so a name with spaces/separators reports the same path it writes.
    const cassettePath = p.options["--out"] ?? defaultCassettePath(scenario.name);
    log("record --dry-run");
    log(`  scenario: ${scenario.name}`);
    log(`  file:     ${target}`);
    if (scenario.fidelity) log(`  fidelity: ${scenario.fidelity}`);
    log(`  cassette: ${cassettePath}`);
    log(tokenLine);
    log(agentLine);
    return process.exit(0);
  }

  // Auth guard: fail with a clear message if no model token is present.
  // In-Docker containers cannot read the macOS Keychain; the error would otherwise
  // surface as result:"error" + empty stderr after the agent spawns.
  // Note: --dry-run bypasses this guard (dry-run branch exits before reaching here).
  if (!(process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)) {
    log(
      "record: no model credentials — set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY " +
        "(in-Docker the macOS Keychain is not accessible; run `cowork-harness doctor` for full diagnostics)",
    );
    return process.exit(2);
  }

  // Shared live-decider opts for the B1 (dir-batch) and single-scenario record paths. (--rerecord-stale is
  // excluded above, so it never sees these.) A plain `record` leaves every field undefined → no behavior change.
  const liveDecider: Pick<RecordOpts, "onUnanswered" | "llmIntent" | "deciderChannel"> = {
    onUnanswered: deciderLlm ? "llm" : onUnansweredOpt,
    llmIntent: deciderLlm ? intent : undefined,
    deciderChannel: deciderDir !== undefined ? "decider-dir" : deciderLlm ? "decider-llm" : undefined,
  };

  // B2: re-record only the drifted cassettes in a committed cassette dir.
  if (rerecordStale) {
    if (!isDir) {
      log("record --rerecord-stale takes a DIRECTORY of committed cassettes");
      return process.exit(2);
    }
    const stale = selectStaleCassettes(target);
    if (stale.length === 0) {
      log(`✓ record --rerecord-stale: all cassettes under ${target} are fresh — nothing to re-record`);
      return process.exit(0);
    }
    const staleTotal = stale.length;
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
          // G-1: re-record from the on-disk scenario YAML so any edits (e.g. added `skills:`) take effect.
          r = await recordScenarioFile(diskScenario, { noRedact, allowFailing, cassettePath: cp, maxArtifactBytes });
        } else {
          // No on-disk scenario found — fall back to the embedded snapshot (original behavior).
          // The user should pass the scenario file directly (`record <scenario.yaml>`) to pick up edits.
          log(
            `  ⚠ ${tag} no on-disk scenario found for "${cassette.scenario.name}" — re-recording from embedded snapshot (edits to the scenario YAML won't apply; use \`record <scenario.yaml>\` to re-record from disk)`,
          );
          const sessionRef = cassette.scenario.session === "(inline)" ? "(inline)" : join(dirname(cp), cassette.scenario.session);
          r = await recordScenarioObject(
            { ...cassette.scenario, session: sessionRef },
            { noRedact, allowFailing, cassettePath: cp, maxArtifactBytes },
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

  // B1: batch a directory of scenarios.
  if (isDir) {
    const disc = discoverScenarios(target);
    for (const s of disc.skipped) log(`· skipped (not a scenario — no \`prompt:\`): ${s}`);
    for (const b of disc.broken) log(`✗ ${b.file}: ${b.error}`);
    if (disc.scenarios.length === 0) {
      log(`record: no scenarios discovered under ${target} (loud non-zero — not a vacuous "0 failures = green")`);
      return process.exit(2);
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
      log(
        `record: ${dupes.length} scenario(s) share a cassette output path (their \`name:\` slugifies identically) — would clobber/race; give them distinct \`name:\`:`,
      );
      for (const d of dupes) log(`  ✗ ${d}`);
      return process.exit(2);
    }

    const total = disc.scenarios.length;
    // Runs are fully isolated (unique sidecar networks/proxy per run, per-session run dir), so concurrency is
    // safe; --concurrency only bounds it (Docker address pool + API rate limits). Index-tag the lines so
    // interleaved completions stay readable.
    const outcomes = await pMapBounded(disc.scenarios, concurrency, async (f, i) => {
      const tag = `[${i + 1}/${total}]`;
      log(`${tag} recording ${f}…`);
      try {
        const r = await recordScenarioFile(f, { noRedact, allowFailing, maxArtifactBytes, ...liveDecider });
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
      cassettePath,
      maxArtifactBytes,
      externalChannel: channel,
      ...liveDecider,
    });
    if (asJson) out(JSON.stringify({ command: "record", result: r.result.result, artifacts: r.artifacts, cassette: r.cassettePath }));
    else log(`✓ recorded ${r.result.result} · ${r.artifacts} artifact(s) → ${r.cassettePath}`);
  } catch (e) {
    log(`record: ${recordErrorText(e)}`);
    return process.exit(1);
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

/** The live-record TAIL shared by the file (B1/single) and in-memory (B2 re-record) paths: run live, refuse
 *  a failing run unless opted in (A3), snapshot + secret-scrub bodies (C2), opt-in redact + verdict-preserve
 *  (A1/A3), write. `extraPolicyDirs` adds the scenario-file dir to the .cowork-redact.json search. */
async function recordScenarioObject(
  scenario: Scenario,
  opts: RecordOpts,
  extraPolicyDirs: string[] = [],
): Promise<{ result: RunResult; cassettePath: string; artifacts: number }> {
  // Thread the live-decider opts. All undefined for a plain `record` → identical to the
  // previous opt-less call (executeScenario defaults onUnanswered to scenario.on_unanswered ?? "fail").
  const result = await executeScenario(scenario, {
    onUnanswered: opts.onUnanswered,
    externalChannel: opts.externalChannel,
    llmIntent: opts.llmIntent,
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
  // A3: a failing live run frozen into a cassette is a latent false-signal — refuse unless opted in.
  // F-5: separate the run RESULT from the VERDICT (they're distinct — the run can succeed while an assertion
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
  // C2: buildManifest reads output bodies RAW (executeScenario scrubs result/events/control-out, NOT
  // outputs/) — secret-scrub each body before it is committed.
  const secrets = collectSecrets();
  // Text bodies are scrubbed in-place (C2). Base64 (binary) bodies cannot be scrubbed with plain
  // `scrub` — text-substitution corrupts the bytes and then false-fails the replay-time sha256 verify.
  // Instead use `scrubField`, which whole-field-decodes first: if the decoded content contains a secret
  // (covering the base64(prefix+TOKEN+suffix) case), the entire body is replaced with a redaction marker,
  // `encoding` is cleared (marker is plain text), and sha256 is recomputed so replay verification stays
  // intact. Artifact assertions on a redacted binary body will fail at replay — the ::warning:: flags this.
  // Snapshot under the run's REAL user-visible roots (outputs + resolved folder mount names), persisted
  // below as cassette.userVisibleRoots so replay matches — not the legacy hardcoded `.projects/` prefix.
  const recordRoots = result.userVisibleRoots ?? ["outputs", ".projects"];
  const artifacts = (result.workDir ? buildManifest(result.workDir, opts.maxArtifactBytes, recordRoots) : []).map((a) => {
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
    return { ...a, body: scrubField(a.body, secrets) };
  });
  // F-9: if an `artifact_json` targets an artifact we had to truncate, it passes here (on-disk) but FAILS
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
    // persist the authored scenario source file RELATIVE to the cassette dir (relocatable, no
    // absolute host path) so `--rerecord-stale` re-records from the edited YAML even when name ≠ filename.
    scenarioSource: opts.scenarioSourceFile ? relative(dirname(cassettePath), opts.scenarioSourceFile) : undefined,
    fingerprint: buildFingerprint(scenario.session, result.baseline, undefined, scenario.skills),
    authoring,
  };
  // A1 (opt-in) content redaction over the whole surface (C1). Empty policy → no-op. Non-empty → must be
  // VERDICT-PRESERVING (A3): replay both and refuse to write on divergence (a manufactured green).
  const policy = opts.noRedact
    ? { patterns: [], keyNames: [] }
    : loadRedactionPolicy([process.cwd(), ...extraPolicyDirs, dirname(cassettePath)]);
  let cassette = base;
  if (policy.patterns.length || policy.keyNames.length) {
    const redacted = redactCassette(base, policy);
    await assertRedactionVerdictPreserved(base, redacted);
    cassette = redacted;
  }
  writeFileAtomic(cassettePath, JSON.stringify(cassette, null, 2)); // H5: atomic — no partial cassette on a mid-write crash
  return { result, cassettePath, artifacts: artifacts.length };
}

/** A synthetic `result:"error"` RunResult for an unreadable/invalid cassette in a directory replay — so
 *  the JSON envelope's `ok` (results.every(pass)) turns false and can never report ok:true alongside a
 *  non-zero exit (the cardinal no-false-green rule). */
function replayErrorResult(file: string): RunResult {
  return {
    scenario: file,
    fidelity: "replay",
    baseline: "",
    result: "error",
    decisions: [],
    egress: [],
    assertions: [],
    outDir: "",
    durationMs: 0,
  };
}

/** `replay <file|dir>` — deterministic protocol-replay; re-evaluates content assertions. A directory
 *  replays every `*.cassette.json` (non-recursive, sorted) and exits on the worst verdict; an unreadable
 *  cassette is a per-file error (never aborts the batch, never a vacuous pass). */
export async function cmdReplay(args: string[]) {
  let p;
  try {
    p = parseArgs(args, {
      // --quiet/--verbose accepted for flag consistency but currently no-op in replay (renderer plan is fixed).
      booleans: ["--strict", "--fail-on-skill-drift", "--quiet", "--verbose"],
      values: ["--output-format"],
      enums: { "--output-format": ["text", "json"] },
      aliases: { "-q": "--quiet", "-V": "--verbose" },
    });
  } catch (e) {
    log(String((e as Error).message));
    return process.exit(2);
  }
  const target = p.positionals[0];
  if (!target) {
    log("usage: replay <file.cassette.json | dir/> [--strict] [--fail-on-skill-drift] [--output-format text|json]");
    return process.exit(2);
  }
  if (p.positionals.length > 1) {
    log(`replay takes one target (got ${p.positionals.length}: ${p.positionals.join(", ")})`);
    return process.exit(2);
  }
  const json = p.options["--output-format"] === "json";
  const strict = p.flags["--strict"] ?? false; // #1b: escalate ALL staleness findings to failures (release gate)
  const failOnSkillDrift = p.flags["--fail-on-skill-drift"] ?? false; // narrower gate: only skill-source drift fails
  if (strict && failOnSkillDrift)
    warn(
      "::notice:: [replay] --strict and --fail-on-skill-drift both passed — --strict is the superset (fails on every class), so --fail-on-skill-drift is redundant here\n",
    );
  const resolved = resolveInputs(target, ".cassette.json");
  if ("error" in resolved) {
    log(`replay: ${resolved.error}`);
    return process.exit(2);
  }
  const plan: RenderPlan = { live: false, progress: false, verbose: false, color: process.stderr.isTTY === true && !process.env.NO_COLOR };
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
    let result: RunResult;
    try {
      result = await replayCassette(rc.cassette, renderer ? [renderer] : [], { strict, failOnSkillDrift, cassetteDir: dirname(f) });
    } catch (e) {
      log(`replay: ${f}: ${(e as Error)?.message ?? String(e)}`);
      results.push(replayErrorResult(f)); // turns the envelope's ok false (no false green)
      worst = Math.max(worst, 2);
      continue;
    }
    // SEAM B: the replay lane evaluates assertions + result only; one verdict source for footer AND exit.
    if (!json) renderFooter(result, plan, { renderer, lane: "replay" });
    results.push(result);
    worst = Math.max(worst, computeVerdict(result, "replay").exitCode);
  }
  // stdout = machine ONLY under --output-format json; humans get per-file footers on stderr.
  if (json) out(jsonEnvelope("replay", results));
  return process.exit(worst);
}

/** `verify-cassettes <file|dir>` — the CI gate (token/agent-free). Runs the privacy scan (A2) and the
 *  staleness check (B3) over one cassette or every `*.cassette.json` in a dir (non-recursive). Exit 1 on any
 *  real PII finding or staleness drift; `unscanned` notes are informational. Dedicated JSON envelope. */
export function cmdVerifyCassettes(args: string[]) {
  let p;
  try {
    p = parseArgs(args, {
      booleans: ["--skip-privacy", "--skip-staleness", "--quiet", "--verbose"],
      values: ["--output-format"],
      repeated: ["--allow", "--allow-domain", "--allow-email", "--allow-file"],
      enums: { "--output-format": ["text", "json"] },
      noDashValue: ["--allow-file"],
      aliases: { "-q": "--quiet", "-V": "--verbose" },
    });
  } catch (e) {
    log(String((e as Error).message));
    return process.exit(2);
  }
  const json = p.options["--output-format"] === "json";
  const skipPrivacy = p.flags["--skip-privacy"] ?? false;
  const skipStaleness = p.flags["--skip-staleness"] ?? false;
  if (skipPrivacy && skipStaleness) {
    log("verify-cassettes: --skip-privacy and --skip-staleness are mutually exclusive (together they'd check nothing)");
    return process.exit(2);
  }
  const doPrivacy = !skipPrivacy;
  const doStaleness = !skipStaleness;
  // Allow model (F-2): each entry is whole-token anchored + class-scoped. A bare `--allow` applies to every
  // class (back-compat); `--allow-domain`/`--allow-email` scope to one class so a domain allow can't bleed
  // into the email tripwire. `--allow-file` (F-8) loads bare (all-class) patterns from a version-controlled
  // file, one per line, `#` comments and blanks ignored.
  const allow: AllowPattern[] = [];
  const addAllow = (src: string, cls: string | undefined, flag: string): void => {
    try {
      allow.push({ cls, re: new RegExp(src, "i") });
    } catch {
      log(`${flag}: invalid regex: ${src}`);
      process.exit(2);
    }
  };
  for (const src of p.repeated["--allow"] ?? []) addAllow(src, undefined, "--allow");
  for (const src of p.repeated["--allow-domain"] ?? []) addAllow(src, "domain", "--allow-domain");
  for (const src of p.repeated["--allow-email"] ?? []) addAllow(src, "email", "--allow-email");
  for (const file of p.repeated["--allow-file"] ?? []) {
    let body: string;
    try {
      body = readFileSync(file, "utf8");
    } catch (e) {
      log(`--allow-file: cannot read ${file}: ${(e as Error).message}`);
      return process.exit(2);
    }
    for (const raw of body.split("\n")) {
      const line = raw.trim();
      if (line && !line.startsWith("#")) addAllow(line, undefined, `--allow-file (${file})`);
    }
  }
  const target = p.positionals[0];
  if (!target) {
    log(
      "usage: verify-cassettes <file|dir> [--skip-privacy|--skip-staleness] [--allow <regex>]... [--allow-domain <regex>]... [--allow-email <regex>]... [--allow-file <path>]... [--output-format json]",
    );
    return process.exit(2);
  }
  if (p.positionals.length > 1) {
    log(`verify-cassettes takes one <file|dir> (got ${p.positionals.length}: ${p.positionals.join(", ")})`);
    return process.exit(2);
  }
  const resolved = resolveInputs(target, ".cassette.json");
  if ("error" in resolved) {
    log(`verify-cassettes: ${resolved.error}`);
    return process.exit(2);
  }
  const files = resolved.files;
  const results = files.map((f) => {
    const rc = readCassette(f);
    if ("error" in rc) return { file: f, findings: [], staleness: [], error: rc.error };
    const findings = doPrivacy ? scanCassette(rc.cassette, allow) : [];
    const staleness = doStaleness ? checkStaleness(rc.cassette, dirname(f)) : [];
    // a cassette written by a NEWER harness version may carry semantics this version can't
    // correctly interpret — treat it as a staleness failure in verify-cassettes (can't verify ⇒ not green).
    const recordedVersion = rc.cassette.cassetteVersion ?? 0;
    if (recordedVersion > CASSETTE_VERSION)
      staleness.push(
        `cassette format v${recordedVersion} is newer than this harness understands (v${CASSETTE_VERSION}) — upgrade cowork-harness (can't verify ⇒ not green)`,
      );
    return { file: f, findings, staleness, error: undefined as string | undefined };
  });
  const realFindings = results.flatMap((r) => r.findings.filter((x) => x.cls !== "unscanned"));
  const staleAny = results.some((r) => r.staleness.length > 0);
  const errorAny = results.some((r) => r.error !== undefined);
  const ok = realFindings.length === 0 && !staleAny && !errorAny;
  const coverage = { privacy: doPrivacy, staleness: doStaleness };
  if (json) {
    out(JSON.stringify({ command: "verify-cassettes", ok, coverage, results }));
  } else {
    if (!doStaleness) log("⚠ cowork-harness: --skip-staleness: staleness check was skipped");
    if (!doPrivacy) log("⚠ cowork-harness: --skip-privacy: privacy scan was skipped");
    for (const r of results) {
      if (r.error) log(`✗ ${r.file}: [error] ${r.error}`);
      for (const f of r.findings) log(`${f.cls === "unscanned" ? "·" : "✗"} ${r.file}: [${f.cls}] ${f.where} — ${f.sample}`);
      for (const s of r.staleness) log(`✗ ${r.file}: [stale] ${s}`);
    }
    log(
      ok
        ? `✓ verify-cassettes: ${files.length} cassette(s) clean`
        : `✗ verify-cassettes: ${realFindings.length} PII finding(s)${staleAny ? " + staleness drift" : ""}${errorAny ? " + unreadable cassette(s)" : ""} across ${files.length} cassette(s)`,
    );
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
  let p;
  try {
    p = parseArgs(args, {
      booleans: ["--dry-run"],
      values: ["--output-format"],
      enums: { "--output-format": ["text", "json"] },
    });
  } catch (e) {
    log((e as Error).message);
    return process.exit(2);
  }
  if (p.positionals.length !== 1) {
    log("usage: rehash <dir/> [--dry-run] [--output-format text|json]");
    return process.exit(2);
  }
  const dir = p.positionals[0];
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    log(`rehash: not a directory: ${dir}`);
    return process.exit(2);
  }

  const dryRun = p.flags["--dry-run"] ?? false;
  const asJson = p.options["--output-format"] === "json";

  let liveBaseline: string;
  try {
    liveBaseline = loadBaseline("latest").appVersion;
  } catch (e) {
    log(`rehash: cannot load latest baseline — ${(e as Error).message}`);
    return process.exit(1);
  }

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".cassette.json"))
    .sort()
    .map((f) => join(dir, f));

  if (files.length === 0) {
    if (asJson) out(JSON.stringify({ command: "rehash", dryRun, migrated: 0, skipped: 0, errors: 0, results: [] }));
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
      writeFileAtomic(file, JSON.stringify(updated, null, 2)); // H5: atomic in-place rehash write (staleness keys on contentSig, not mtime — rename is safe)
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
    out(JSON.stringify({ command: "rehash", dryRun, migrated, skipped, errors, results }));
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

/** Replay a cassette through Run and re-evaluate the content assertions. With a `cassette.artifacts`
 *  manifest (#1), filesystem assertions (file_exists/user_visible_artifact/artifact_json) ALSO run, against
 *  the materialized snapshot. `opts.strict` (#1b) escalates ALL staleness findings to failing assertions;
 *  `opts.failOnSkillDrift` escalates only the skill-source classes (`skill`/`shared-root`/`unverifiable-skill`),
 *  leaving baseline drift a non-failing warning. Either way the findings are always surfaced in
 *  `RunResult.staleness` for JSON consumers. */
export async function replayCassette(
  cassette: Cassette,
  hooks: RunHooks[] = [],
  opts: { strict?: boolean; failOnSkillDrift?: boolean; cassetteDir?: string } = {},
): Promise<RunResult> {
  // Cassette format version: ABSENT = legacy (0); a FUTURE version means this harness may misread fields
  // it doesn't know about. in strict mode this is a hard failure (future semantics may not be
  // correctly interpreted → a false-green is possible). In non-strict mode, warn clearly that results may
  // be unreliable and continue (forward-compat best-effort).
  const cassetteVersion = cassette.cassetteVersion ?? 0;
  const futureVersionMsg =
    cassetteVersion > CASSETTE_VERSION
      ? `cassette format v${cassetteVersion} is newer than this harness understands (v${CASSETTE_VERSION}) — results may be unreliable; upgrade cowork-harness`
      : undefined;
  if (futureVersionMsg) {
    if (opts.strict) {
      // fail fast via the staleness path — the assertions push is handled below with staleness[]
    } else {
      warn(`::warning:: [replay] ${futureVersionMsg}\n`);
    }
  }

  const session = new CassetteAgentSession(cassette.events, cassette.controlOut);

  // #1b: cassette→skill/baseline staleness tripwire. Mirrors `asarFingerprint` — warn by default; `--strict`
  // turns a mismatch into a failing assertion (release gate). A green replay must not imply the skill is
  // unchanged (frozen-structure limit). The skill-hash recompute needs the local skill dirs to be resolvable
  // from the cassette's session path; when they aren't (a moved/committed cassette), we say so rather than
  // silently skipping.
  // Findings are pushed UNCONDITIONALLY (class-tagged) so they're surfaced in JSON (RunResult.staleness) even
  // on the default gate — a token-free consumer can then distinguish "verified clean" from "couldn't verify"
  // (the `unverifiable-*` classes) WITHOUT the verdict changing. The `--strict` / `--fail-on-skill-drift`
  // gates below are the ONLY place a finding becomes a failing assertion. The single `warn()` loop at the end
  // is the lone stderr emitter — no per-branch `warn()`, so a non-strict run never double-warns one cause.
  const staleness: StalenessFinding[] = [];
  if (cassette.fingerprint) {
    const fp = cassette.fingerprint;
    let liveBaseline: string | undefined;
    let baselineLoadFailed = false;
    try {
      liveBaseline = loadBaseline("latest").appVersion;
    } catch {
      baselineLoadFailed = true;
      staleness.push({
        class: "unverifiable-baseline",
        message: "baseline could not be loaded — cannot verify staleness (env/platform, not skill drift)",
      });
    }
    if (!baselineLoadFailed && liveBaseline && liveBaseline !== fp.baseline)
      staleness.push({
        class: "baseline",
        message: `baseline moved ${fp.baseline} → ${liveBaseline} since record — re-record before trusting this replay`,
      });
    if (fp.skillHash) {
      const live = buildFingerprint(cassette.scenario.session, fp.baseline, opts.cassetteDir, cassette.scenario.skills);
      if (live.skillHash === undefined) {
        staleness.push({
          class: "unverifiable-skill",
          message:
            "skill dirs not resolvable from this cassette location — cannot verify skill staleness (the baseline check still applies)",
        });
      } else if (live.skillHash !== fp.skillHash) {
        const recordedVersion = cassette.cassetteVersion ?? 0;
        if (recordedVersion < CASSETTE_VERSION) {
          staleness.push({
            class: "format",
            message: `recorded under an older hash format (v${recordedVersion} → v${CASSETTE_VERSION}) — re-record once after upgrading`,
          });
        } else if (fp.sharedHash !== undefined && live.sharedHash !== undefined) {
          const scope = fp.skillScope?.length ? fp.skillScope.map((s) => `skills/${s}`).join(", ") : "skill";
          if (live.sharedHash !== fp.sharedHash) {
            staleness.push({
              class: "shared-root",
              message: `shared root changed since record (scope: ${scope}) — re-record before trusting this replay`,
            });
          } else {
            staleness.push({ class: "skill", message: `${scope} changed since record — re-record before trusting this replay` });
          }
        } else {
          staleness.push({
            class: "skill",
            message: "local skill/plugin dir contents changed since record — re-record before trusting this replay",
          });
        }
      }
    }
    for (const s of staleness) warn(`::warning:: [replay] cassette stale: ${s.message}\n`);
  }

  // §2.5 backward compat: warn loudly when controlOut is absent so the user knows question/gate
  // assertions are being EXCLUDED (not vacuously evaluated) from this run.
  if (!session.hasControlOut) {
    warn(
      "::warning:: [replay] cassette has no controlOut (pre-full-fidelity) — question/gate assertions are NOT checked; re-record to enable them\n",
    );
  }

  // §2.2 ReplayDecider: look up recorded decision body → deserialize → return.
  // Only constructed (and only drives the decision pipeline) when controlOut is present.
  // Reuse the session's already-parsed controlOut index for the decider (no re-parsing).
  const replayDecider = session.hasControlOut ? buildReplayDecider(session, session.controlOutIndex) : NOOP_DECIDER;

  // §2.6: pass Infinity as dialogTimeoutMs — the synchronous decider resolves before any timer,
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

  // §2.5: build a conditional contentKeys — omit question/gate keys when controlOut is absent
  // (they would evaluate vacuously/incorrectly).
  const alwaysContentKeys: (keyof Assertion)[] = [
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
    "dispatch_count_max",
    "result",
    // Verdict modifiers — NOT filesystem/egress assertions. Keep all of them on replay (each evaluates to a
    // no-op pass via assert.ts) so a standalone modifier neither inflates the "filesystem/egress skipped"
    // count nor emits a misleading warning, AND so the replay path actually exercises their assert.ts noop
    // branches. The signal each one suppresses is independently zeroed on replay (handled in computeVerdict,
    // not here), so keeping the key as a content no-op cannot change a verdict outcome. Single source: the
    // VERDICT_MODIFIER_KEYS list (types.ts) — a newly-added modifier lands here automatically.
    ...VERDICT_MODIFIER_KEYS,
  ];
  const questionGateKeys: (keyof Assertion)[] = ["question_asked", "questions_count_max", "gate_answers_delivered"];
  // #1: with an artifact manifest, the filesystem assertions become replay-checkable (materialized below).
  // Without a manifest they stay live-only (stripped → skip warning), exactly as before.
  const manifestKeys: (keyof Assertion)[] = cassette.artifacts?.length ? ["file_exists", "user_visible_artifact", "artifact_json"] : [];
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
      "egress_denied",
      "egress_allowed",
      "no_delete_in_outputs",
      "self_heal_ran",
      "transcript_no_host_path",
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
  } = manifestKeys.length
    ? materializeManifest(cassette.artifacts!, cassette.userVisibleRoots ?? ["outputs", ".projects"])
    : { workRoot: "", prefixes: [] as string[], truncatedPaths: new Set<string>() };
  const contentKeys: (keyof Assertion)[] = [
    ...(session.hasControlOut ? [...alwaysContentKeys, ...questionGateKeys] : alwaysContentKeys),
    ...manifestKeys,
  ];

  // #5: with AND-semantics in check(), we must STRIP each assertion to only its active content keys
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

  // §5 + #1 footgun: replay must be LOUD about anything it can't check, in two distinct classes —
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
    } else if (defined.some((k) => !contentishKeys.has(k))) {
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

  const assertions = evaluate(replayable, {
    transcript: rec.transcript,
    toolsCalled: rec.toolsCalled,
    subagentTools: rec.subagentTools,
    egress: [],
    result: rec.result,
    workRoot: replayWorkRoot,
    userVisiblePrefixes: replayPrefixes,
    outputsDeletes: [],
    questions: rec.questions,
    hostPathLeaked: false,
    selfHealRan: false,
    subagents: rec.subagents,
    gateDeliveries: rec.gateDeliveries,
    toolResultTexts: rec.toolResults.map((r) => r.assertText ?? r.text),
    truncatedPaths: replayTruncatedPaths,
  });

  // #1b: under --strict, EVERY staleness finding becomes a failing assertion (non-zero exit), not just a
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
  if (futureVersionMsg && opts.strict)
    assertions.push({ assertion: {} as Assertion, pass: false, message: `cassette format too new (--strict): ${futureVersionMsg}` });

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

  // §2.4: surface each serializeDecision mismatch as a failing replay_protocol_fidelity assertion.
  // Shape: { assertion: { replay_protocol_fidelity: true }, pass: false, message } — well-typed via types.ts.
  for (const m of session.mismatches) {
    assertions.push({
      assertion: { replay_protocol_fidelity: true },
      pass: false,
      message: `serializeDecision output for ${m.id} != recorded envelope: expected ${m.expected} got ${m.actual}`,
    });
  }

  // #18/#4: a decision present in events.jsonl with NO matching control_response in a full-fidelity
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

  return {
    scenario: cassette.scenario.name,
    fidelity: `replay:${cassette.scenario.fidelity}`,
    // The tier the LIVE run actually used (cowork → hostloop/container); falls back to authored fidelity
    // for an older cassette that didn't record it.
    effectiveFidelity: `replay:${cassette.effectiveFidelity ?? cassette.scenario.fidelity}`,
    baseline: cassette.scenario.baseline,
    result: rec.result,
    resultErrorKind: rec.resultErrorKind, // Fix 5: re-derived by run.ts during the replay re-drive (same classifier)
    stalledOnQuestion: rec.stalledOnQuestion, // H2: re-derived by run.ts's detector during the replay re-drive — so a recorded stall fails replay too
    decisions: rec.decisions.map((d) => ({ kind: d.kind, name: d.name, decision: d.decision, by: d.by })),
    toolCounts: rec.toolCounts,
    gateDeliveries: rec.gateDeliveries,
    egress: [],
    assertions,
    subagents: rec.subagents,
    unanswered: rec.unanswered,
    outDir: "(replay)",
    // Class-tagged staleness + skip counts, surfaced to JSON callers (the gate decision already happened
    // above via failing assertions; these fields are pure data so a green stays green by default).
    staleness: staleness.length ? staleness : undefined,
    skippedAssertions: { full: fullSkipCount, partial: partialSkipCount },
    // A cassette freezes the answer path: the replay itself is deterministic regardless of how the
    // original run was answered. Always explicit (never undefined) so renderer.ts:146 treats it
    // correctly — undefined would silently render as "deterministic" (#47 C1 [review-2]).
    nonDeterministic: false,
  };
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
