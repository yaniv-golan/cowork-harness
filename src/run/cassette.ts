import { z } from "zod";
import { warn } from "../io.js";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname, relative, isAbsolute, resolve, sep } from "node:path";
import { type Scenario, type RunResult, type Assertion, Assertion as AssertionSchema } from "../types.js";
import { executeScenario, parseScenarioFile, collectArtifacts, parseSessionFile } from "./execute.js";
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
import { ABSTAIN, UnansweredError, type Decider } from "../decide/decider.js";
import { evaluate } from "../assert.js";
import { makeRenderer, renderFooter, type RenderPlan } from "./renderer.js";
import { jsonEnvelope, parseOutputFormat } from "./envelope.js";
import { parseArgs } from "../cli-args.js";
import { resolveInputs } from "./inputs.js";
import { hashSkillDirs, hashSharedOnly } from "./skill-hash.js";
import { computeVerdict } from "./verdict.js";
import { redactJsonLine, redactText, redactStructural, loadRedactionPolicy, type RedactionPolicy } from "../redact.js";
import { collectSecrets, scrub } from "../secrets.js";
import { scanText, DEFAULT_SCAN_PATTERNS, EMAIL_SCAN_PATTERNS, type ScanFinding, type AllowInput, type AllowPattern } from "../scan.js";
import { parse as parseYaml } from "yaml";

const out = (s: string) => process.stdout.write(s + "\n");
const log = (s: string) => process.stderr.write(s + "\n");

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
  truncated?: boolean; // too big to inline → hash-only (file_exists works; artifact_json cannot)
}

/** #1b: a staleness tripwire over the inputs that determine the recording — mirrors `asarFingerprint`
 *  (warn-don't-fail; `--strict` hardens). `baseline` is the canonical staleness cause (a Cowork bump);
 *  `skillHash` covers local skill/plugin edits (the dev-loop case). */
interface Fingerprint {
  baseline: string; // appVersion at record time
  skillHash?: string; // hash of the session's local skill/plugin/marketplace dir contents (if any)
  skillSources?: string[]; // the local dirs that fed skillHash (for the replay recompute + diagnostics)
  skillScope?: string[]; // F-6: the skills the hash was scoped to (empty/absent = whole-tree); diagnostics
  sharedHash?: string; // G-4: shared-root hash for scoped cassettes; absent on whole-tree or non-plugin-root mounts
}

export interface Cassette {
  // Schema version of the cassette FORMAT (not the package). Bump when the structure changes in a way a
  // reader must branch on (a new manifest-entry shape, a fingerprint-algorithm change, a2's nonDeterministic
  // provenance, …). ABSENT = pre-versioning legacy (treated as 0). Stamping it now — while ~no cassettes
  // exist in the wild — lets future evolution branch cleanly instead of guessing a cassette's age.
  cassetteVersion?: number;
  scenario: Scenario;
  events: string[]; // recorded child→driver stdout (events.jsonl) — the cassette source
  controlOut?: string[]; // driver→child control_responses (control-out.jsonl) — for full-fidelity replay
  effectiveFidelity?: string; // the tier the live record actually resolved to (e.g. cowork → hostloop)
  artifacts?: ManifestEntry[]; // #1: outputs/.projects snapshot (paths + hashes + small JSON bodies)
  fingerprint?: Fingerprint; // #1b: cassette→skill/baseline staleness tripwire
}

/** Current cassette format version. Readers tolerate ABSENT (legacy → 0) and warn on a FUTURE version. */
// v2 (F-6): the fingerprint may be SCOPED to a scenario's `skills:` (whole-tree default stays byte-identical
// to v1). Bumped because a scoped `skillHash` is not reproducible by a pre-F-6 reader — which would recompute
// whole-tree and mis-flag a scoped cassette as stale; the version lets such a reader warn instead.
const CASSETTE_VERSION = 2;

const DEFAULT_MANIFEST_BODY_CAP = 64 * 1024; // inline JSON/text bodies ≤ 64 KiB; larger → hash-only + truncated marker

/** The effective inline-body cap. Overridable (F-9) so a large structured deliverable can opt into inlining
 *  rather than silently truncating — which would pass `artifact_json` at record (on-disk) but fail at replay
 *  (no body). Env `COWORK_HARNESS_MAX_ARTIFACT_BYTES`; `record --max-artifact-bytes` takes precedence via the
 *  explicit `cap` argument to buildManifest. Invalid/non-positive env is ignored (falls back to the default). */
function defaultBodyCap(): number {
  const env = process.env.COWORK_HARNESS_MAX_ARTIFACT_BYTES;
  if (env !== undefined) {
    const n = Number(env);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
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
export function buildManifest(workRoot: string, cap?: number): ManifestEntry[] {
  const limit = cap ?? defaultBodyCap();
  return collectArtifacts(workRoot, ["outputs", ".projects"]).map(({ path, bytes }) => {
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
 *  files get an empty placeholder (file_exists still passes; artifact_json on them fails loud — it needs the
 *  body, which only small files carry). each path is containment-checked before writing so a hostile
 *  cassette entry can't escape the temp root. every non-truncated body is verified against its
 *  recorded sha256 (over the decoded RAW bytes) — a mismatch fails replay (throws). */
export function materializeManifest(entries: ManifestEntry[]): { workRoot: string; prefixes: string[] } {
  const workRoot = mkdtempSync(join(tmpdir(), "cwh-replay-"));
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
  }
  return { workRoot, prefixes: ["outputs", ".projects"] };
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
  const dirs = [...cfg.skills.local, ...cfg.plugins.local_plugins, ...cfg.plugins.remote_plugins, ...cfg.plugins.local_marketplaces].filter(
    (d) => existsSync(d),
  );
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
  // Store skillSources RELATIVE to the session-file dir — diagnostics only (the replay recompute re-derives
  // the dirs from the session), so a relative path is enough and never leaks an absolute `/Users/...` path.
  const fp: Fingerprint = { baseline: baselineAppVersion, skillHash: hashResult.hash, skillSources: dirs.sort().map((d) => relative(baseDir, d)) };
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
  return findings;
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
    if (live.skillHash === undefined)
      msgs.push("skill dirs not resolvable from the cassette location — cannot verify staleness (gate fails: can't verify ⇒ not green)");
    else if (live.skillHash !== fp.skillHash) {
      const recordedVersion = cassette.cassetteVersion ?? 0;
      if (recordedVersion < CASSETTE_VERSION) {
        msgs.push(`recorded under an older hash format (v${recordedVersion} → v${CASSETTE_VERSION}) — re-record once after upgrading`);
      } else if (fp.sharedHash !== undefined && live.sharedHash !== undefined) {
        // G-4: bucket-level diagnosis — which component of the scoped hash changed?
        const scope = fp.skillScope!.map((s) => `skills/${s}`).join(", ");
        if (live.sharedHash !== fp.sharedHash) {
          msgs.push(`shared root changed since record (scope: ${scope}) — re-record`);
        } else {
          msgs.push(`${scope} changed since record — re-record`);
        }
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
    this.controlOutIndex = buildControlOutIndex(controlOut ?? []);
  }

  async *start(): AsyncIterable<AgentEvent> {
    for (let i = 0; i < this.events.length; i++) {
      const line = this.events[i];
      if (!line.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        warn(`::warning:: [replay] cassette events line ${i} is not valid JSON — skipping\n`);
        continue;
      }
      for (const ev of parseMessage(msg)) {
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
function buildControlOutIndex(controlOut: string[]): Map<string, Record<string, unknown>> {
  const index = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < controlOut.length; i++) {
    const line = controlOut[i];
    if (!line.trim()) continue;
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      warn(`::warning:: [replay] control-out.jsonl line ${i} is not valid JSON — skipping\n`);
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
      index.set(String(rid), body as Record<string, unknown>);
    }
  }
  return index;
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
  return {
    ...cassette,
    scenario,
    events: cassette.events.map((l) => redactJsonLine(l, policy)),
    controlOut: cassette.controlOut?.map((l) => redactJsonLine(l, policy)),
    artifacts: cassette.artifacts?.map((a) => ({
      ...a,
      path: redactText(a.path, policy), // C1: a filename can name a customer (outputs/Acme-cap-table.json)
      // a base64 (binary) body has no text PII to redact, and redacting it would corrupt the bytes
      // and then false-fail the replay-time sha256 verify — leave binary bodies untouched.
      ...(a.body !== undefined && a.encoding !== "base64" ? { body: redactJsonLine(a.body, policy) } : {}),
    })),
    fingerprint: cassette.fingerprint
      ? { ...cassette.fingerprint, skillSources: cassette.fingerprint.skillSources?.map((s) => redactText(s, policy)) }
      : undefined,
  };
}

/** A3 / C4 cardinal-sin guard: redaction must be VERDICT-PRESERVING. Replay both the pre-redaction and the
 *  redacted cassette (token-free) and compare verdicts; if redaction flipped any replay-checkable assertion
 *  (e.g. stripped a value a `transcript_not_matches` keys on, manufacturing a green), throw — never write a
 *  cassette whose verdict was changed by redaction. */
export async function assertRedactionVerdictPreserved(base: Cassette, redacted: Cassette): Promise<void> {
  const [rb, rr] = await Promise.all([replayCassette(base), replayCassette(redacted)]);
  const vb = computeVerdict(rb, "replay");
  const vr = computeVerdict(rr, "replay");
  const failedKeys = (result: RunResult): string[] =>
    result.assertions
      .filter((a) => !a.pass)
      .map((a) => Object.keys(a.assertion).filter((k) => (a.assertion as Record<string, unknown>)[k] !== undefined)[0] ?? "(unknown)")
      .sort();
  const baseFailedKeys = failedKeys(rb);
  const redactedFailedKeys = failedKeys(rr);
  const verdictMismatch = vb.pass !== vr.pass;
  const countMismatch = baseFailedKeys.length !== redactedFailedKeys.length;
  const keysMismatch = baseFailedKeys.join(",") !== redactedFailedKeys.join(",");
  if (verdictMismatch || countMismatch || keysMismatch) {
    const detail = verdictMismatch
      ? `pre-redaction pass=${vb.pass} → redacted pass=${vr.pass}`
      : `assertion failures changed: [${baseFailedKeys.join(", ")}] → [${redactedFailedKeys.join(", ")}]`;
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
 *  JSON cassette is a clean error instead of a runtime crash. Deliberately `.passthrough()` (NOT the strict
 *  authoring-time ScenarioObject) so a forward-compatible cassette carrying unknown keys still replays. */
const CassetteShape = z
  .object({
    events: z.array(z.string()),
    scenario: z.object({ prompt: z.string(), session: z.string(), assert: z.array(z.unknown()).optional() }).passthrough(),
  })
  .passthrough();

/** Read + parse a cassette, never throwing — a malformed `*.cassette.json` must be TALLIED, not crash a
 *  whole batch (a crash mid-walk reads as "the rest were fine" — a false-green by abort). */
function readCassette(path: string): { cassette: Cassette } | { error: string } {
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
export function _findScenarioOnDisk(cassettePath: string, scenarioName: string): string | null {
  const cassetteDir = dirname(cassettePath);
  const candidates = [
    join(cassetteDir, "..", "scenarios", `${scenarioName}.yaml`),
    join(cassetteDir, "..", "scenarios", `${scenarioName}.yml`),
    join(cassetteDir, `${scenarioName}.yaml`),
    join(cassetteDir, `${scenarioName}.yml`),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return resolve(c);
  }
  return null;
}

/** Record one scenario FILE → one cassette (parses the file, then shares the live-record tail with the
 *  in-memory path). The file's dir feeds the redaction-policy search (for a co-located .cowork-redact.json). */
async function recordScenarioFile(file: string, opts: RecordOpts): Promise<{ result: RunResult; cassettePath: string; artifacts: number }> {
  return recordScenarioObject(parseScenarioFile(file), opts, [dirname(file)]);
}

/** `record <scenario.yaml | dir> [--out <file>] [--rerecord-stale] [--no-redact] [--allow-failing]` —
 *  run live + save a cassette. A single file records one; a dir batches (B1); --rerecord-stale (B2) treats
 *  the dir as committed cassettes and re-records only those whose fingerprint drifted. */
export async function cmdRecord(args: string[]) {
  let p;
  try {
    p = parseArgs(args, {
      // --quiet/--verbose accepted for flag consistency but currently no-op in record (renderer plan is fixed).
      booleans: ["--no-redact", "--allow-failing", "--rerecord-stale", "--quiet", "--verbose"],
      values: ["--out", "--output-format", "--max-artifact-bytes"],
      noDashValue: ["--out"],
      enums: { "--output-format": ["text", "json"] },
      aliases: { "-q": "--quiet", "-V": "--verbose" },
    });
  } catch (e) {
    log((e as Error).message);
    return process.exit(2);
  }
  let maxArtifactBytes: number | undefined;
  const mab = p.options["--max-artifact-bytes"];
  if (mab !== undefined) {
    const n = Number(mab);
    if (!Number.isFinite(n) || n <= 0) {
      log(`record: --max-artifact-bytes must be a positive integer (got ${mab})`);
      return process.exit(2);
    }
    maxArtifactBytes = Math.floor(n);
  }
  const noRedact = p.flags["--no-redact"] ?? false;
  if (noRedact) log("record: --no-redact — content redaction is OFF; the cassette is written verbatim, so ensure inputs are synthetic.");
  const allowFailing = p.flags["--allow-failing"] ?? false;
  const rerecordStale = p.flags["--rerecord-stale"] ?? false;
  const asJson = p.options["--output-format"] === "json";
  const target = p.positionals[0];
  if (!target) {
    log(
      "usage: record <scenario.yaml | dir/> [--out <file>] [--output-format text|json] [--rerecord-stale] [--no-redact] [--allow-failing] [--max-artifact-bytes <n>]",
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
    let failures = 0;
    for (const { path: cp, staleness } of stale) {
      const rc = readCassette(cp);
      if ("error" in rc) {
        failures++;
        log(`  ✗ ${cp}: ${rc.error} — cannot re-record`);
        continue;
      }
      const cassette = rc.cassette;
      const diskScenario = _findScenarioOnDisk(cp, cassette.scenario.name);
      log(`↻ re-recording ${cp} (stale: ${staleness.join("; ")})`);
      try {
        let r: { result: RunResult };
        if (diskScenario) {
          // G-1: re-record from the on-disk scenario YAML so any edits (e.g. added `skills:`) take effect.
          r = await recordScenarioFile(diskScenario, { noRedact, allowFailing, cassettePath: cp, maxArtifactBytes });
        } else {
          // No on-disk scenario found — fall back to the embedded snapshot (original behavior).
          // The user should pass the scenario file directly (`record <scenario.yaml>`) to pick up edits.
          log(
            `  ⚠ no on-disk scenario found for "${cassette.scenario.name}" — re-recording from embedded snapshot (edits to the scenario YAML won't apply; use \`record <scenario.yaml>\` to re-record from disk)`,
          );
          const sessionRef = cassette.scenario.session === "(inline)" ? "(inline)" : join(dirname(cp), cassette.scenario.session);
          r = await recordScenarioObject(
            { ...cassette.scenario, session: sessionRef },
            { noRedact, allowFailing, cassettePath: cp, maxArtifactBytes },
          );
        }
        log(`  ✓ ${cp} (${r.result.result})`);
      } catch (e) {
        failures++;
        log(`  ✗ ${cp}: ${(e as Error).message}`);
      }
    }
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
    let failures = disc.broken.length;
    for (const f of disc.scenarios) {
      try {
        const r = await recordScenarioFile(f, { noRedact, allowFailing, maxArtifactBytes });
        log(`✓ ${f} → ${r.cassettePath} (${r.result.result})`);
      } catch (e) {
        failures++;
        log(`✗ ${f}: ${(e as Error).message}`);
      }
    }
    log(
      failures > 0
        ? `✗ record: ${failures} of ${disc.scenarios.length + disc.broken.length} failed`
        : `✓ record: ${disc.scenarios.length} cassette(s)`,
    );
    return process.exit(failures > 0 ? 1 : 0);
  }

  // Single scenario file.
  try {
    const cassettePath = p.options["--out"];
    const r = await recordScenarioFile(target, { noRedact, allowFailing, cassettePath, maxArtifactBytes });
    if (asJson) out(JSON.stringify({ command: "record", result: r.result.result, artifacts: r.artifacts, cassette: r.cassettePath }));
    else log(`✓ recorded ${r.result.result} · ${r.artifacts} artifact(s) → ${r.cassettePath}`);
  } catch (e) {
    log(`record: ${(e as Error).message}`);
    return process.exit(1);
  }
}

/** The live-record TAIL shared by the file (B1/single) and in-memory (B2 re-record) paths: run live, refuse
 *  a failing run unless opted in (A3), snapshot + secret-scrub bodies (C2), opt-in redact + verdict-preserve
 *  (A1/A3), write. `extraPolicyDirs` adds the scenario-file dir to the .cowork-redact.json search. */
async function recordScenarioObject(
  scenario: Scenario,
  opts: RecordOpts,
  extraPolicyDirs: string[] = [],
): Promise<{ result: RunResult; cassettePath: string; artifacts: number }> {
  const result = await executeScenario(scenario);
  const cassettePath = opts.cassettePath ?? join("cassettes", `${scenario.name}.cassette.json`);
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
  // a base64 (binary) body must NOT be scrubbed — scrub mutates text matches and would corrupt the
  // bytes, then false-fail the replay-time sha256 verify. Text bodies are scrubbed as before (C2).
  const artifacts = (result.workDir ? buildManifest(result.workDir, opts.maxArtifactBytes) : []).map((a) =>
    a.body !== undefined && a.encoding !== "base64" ? { ...a, body: scrub(a.body, secrets) } : a,
  );
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
    cassetteVersion: CASSETTE_VERSION,
    scenario: relocatable,
    events: safeLines(join(result.outDir, "events.jsonl")),
    controlOut: safeLines(join(result.outDir, "control-out.jsonl")),
    effectiveFidelity: result.effectiveFidelity,
    artifacts,
    fingerprint: buildFingerprint(scenario.session, result.baseline, undefined, scenario.skills),
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
  writeFileSync(cassettePath, JSON.stringify(cassette, null, 2));
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

/** `replay <file|dir>` (or `--cassette <file>`) — deterministic protocol-replay; re-evaluates content
 *  assertions. A directory replays every `*.cassette.json` (non-recursive, sorted) and exits on the worst
 *  verdict; an unreadable cassette is a per-file error (never aborts the batch, never a vacuous pass). */
export async function cmdReplay(args: string[]) {
  let p;
  try {
    p = parseArgs(args, {
      // --quiet/--verbose accepted for flag consistency but currently no-op in replay (renderer plan is fixed).
      booleans: ["--strict", "--quiet", "--verbose"],
      values: ["--cassette", "--output-format"],
      noDashValue: ["--cassette"],
      enums: { "--output-format": ["text", "json"] },
      aliases: { "-q": "--quiet", "-V": "--verbose" },
    });
  } catch (e) {
    log(String((e as Error).message));
    return process.exit(2);
  }
  // §8.1: reject ambiguous invocation — both positional and --cassette given. Positional is canonical.
  if (p.options["--cassette"] !== undefined && p.positionals.length > 0) {
    log("replay: provide the cassette path as a positional OR via --cassette, not both.\n       --cassette is a legacy alias; prefer: replay <file.cassette.json>");
    return process.exit(2);
  }
  const target = p.positionals[0] ?? p.options["--cassette"];
  if (!target) {
    log("usage: replay <file.cassette.json | dir/> [--strict] [--output-format text|json]");
    return process.exit(2);
  }
  if (p.positionals.length > 1) {
    log(`replay takes one target (got ${p.positionals.length}: ${p.positionals.join(", ")})`);
    return process.exit(2);
  }
  const json = p.options["--output-format"] === "json";
  const strict = p.flags["--strict"] ?? false; // #1b: escalate staleness warnings to failures (release gate)
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
    const result = await replayCassette(rc.cassette, renderer ? [renderer] : [], { strict, cassetteDir: dirname(f) });
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
      // Q9: --skip-privacy/--skip-staleness are the new canonical names; old --privacy-only/--staleness-only kept as aliases.
      booleans: ["--skip-privacy", "--skip-staleness", "--privacy-only", "--staleness-only", "--quiet", "--verbose"],
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
  const skipPrivacy = (p.flags["--skip-privacy"] || p.flags["--privacy-only"]) ?? false;
  const skipStaleness = (p.flags["--skip-staleness"] || p.flags["--staleness-only"]) ?? false;
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
    if (!doStaleness) log("⚠ cowork-harness: --privacy-only: staleness check was skipped");
    if (!doPrivacy) log("⚠ cowork-harness: --staleness-only: privacy scan was skipped");
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

/** Replay a cassette through Run and re-evaluate the content assertions. With a `cassette.artifacts`
 *  manifest (#1), filesystem assertions (file_exists/user_visible_artifact/artifact_json) ALSO run, against
 *  the materialized snapshot. `opts.strict` (#1b) escalates staleness warnings to failing assertions. */
export async function replayCassette(
  cassette: Cassette,
  hooks: RunHooks[] = [],
  opts: { strict?: boolean; cassetteDir?: string } = {},
): Promise<RunResult> {
  // Cassette format version: ABSENT = legacy (0); a FUTURE version means this harness may misread fields
  // it doesn't know about — warn loudly (forward-compat guard). Same-or-older replays normally.
  const cassetteVersion = cassette.cassetteVersion ?? 0;
  if (cassetteVersion > CASSETTE_VERSION)
    warn(
      `::warning:: [replay] cassette format v${cassetteVersion} is newer than this harness understands (v${CASSETTE_VERSION}) — some fields may be ignored or misread; upgrade cowork-harness\n`,
    );

  const session = new CassetteAgentSession(cassette.events, cassette.controlOut);

  // #1b: cassette→skill/baseline staleness tripwire. Mirrors `asarFingerprint` — warn by default; `--strict`
  // turns a mismatch into a failing assertion (release gate). A green replay must not imply the skill is
  // unchanged (frozen-structure limit). The skill-hash recompute needs the local skill dirs to be resolvable
  // from the cassette's session path; when they aren't (a moved/committed cassette), we say so rather than
  // silently skipping.
  const staleness: string[] = [];
  if (cassette.fingerprint) {
    const fp = cassette.fingerprint;
    let liveBaseline: string | undefined;
    let baselineLoadFailed = false;
    try {
      liveBaseline = loadBaseline("latest").appVersion;
    } catch {
      baselineLoadFailed = true;
      if (opts.strict) {
        staleness.push("baseline could not be loaded — cannot verify staleness (--strict: treating as stale)");
      } else {
        warn("cowork-harness: strict staleness check skipped — baseline could not be loaded\n");
      }
    }
    if (!baselineLoadFailed && liveBaseline && liveBaseline !== fp.baseline)
      staleness.push(`baseline moved ${fp.baseline} → ${liveBaseline} since record — re-record before trusting this replay`);
    if (fp.skillHash) {
      const live = buildFingerprint(cassette.scenario.session, fp.baseline, opts.cassetteDir, cassette.scenario.skills);
      if (live.skillHash === undefined)
        warn(
          "::warning:: [replay] skill fingerprint not re-checkable (local skill dirs not resolvable from this cassette location) — baseline check still applies\n",
        );
      else if (live.skillHash !== fp.skillHash) {
        const recordedVersion = cassette.cassetteVersion ?? 0;
        if (recordedVersion < CASSETTE_VERSION) {
          staleness.push(
            `recorded under an older hash format (v${recordedVersion} → v${CASSETTE_VERSION}) — re-record once after upgrading`,
          );
        } else if (fp.sharedHash !== undefined && live.sharedHash !== undefined) {
          const scope = fp.skillScope?.length ? fp.skillScope.map((s) => `skills/${s}`).join(", ") : "skill";
          if (live.sharedHash !== fp.sharedHash) {
            staleness.push(`shared root changed since record (scope: ${scope}) — re-record before trusting this replay`);
          } else {
            staleness.push(`${scope} changed since record — re-record before trusting this replay`);
          }
        } else {
          staleness.push("local skill/plugin dir contents changed since record — re-record before trusting this replay");
        }
      }
    }
    for (const s of staleness) warn(`::warning:: [replay] cassette stale: ${s}\n`);
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
    "tool_called",
    "tool_not_called",
    "subagent_tool_used",
    "subagent_tool_absent",
    "subagent_dispatched",
    "subagent_declared_but_unused",
    "dispatch_count_max",
    "result",
    // A verdict modifier, not a filesystem/egress assertion — keep it on replay (it evaluates to a no-op
    // pass) so it neither inflates the "filesystem/egress skipped" count nor emits a misleading warning.
    "allow_permissive_auto_allow",
  ];
  const questionGateKeys: (keyof Assertion)[] = ["question_asked", "questions_count_max", "gate_answers_delivered"];
  // #1: with an artifact manifest, the filesystem assertions become replay-checkable (materialized below).
  // Without a manifest they stay live-only (stripped → skip warning), exactly as before.
  const manifestKeys: (keyof Assertion)[] = cassette.artifacts?.length ? ["file_exists", "user_visible_artifact", "artifact_json"] : [];
  // Bug 37: deterministic exhaustiveness check — every key in the Assertion schema must appear in exactly
  // one classification bucket. If a new key is added to the schema but not here, this throws at the first
  // replay, making the oversight impossible to miss in CI.
  {
    const ALL_CLASSIFICATION_KEYS = new Set<keyof Assertion>([
      ...alwaysContentKeys,
      ...questionGateKeys,
      "file_exists", "user_visible_artifact", "artifact_json",
      "egress_denied", "egress_allowed", "no_delete_in_outputs", "self_heal_ran", "transcript_no_host_path",
      "replay_protocol_fidelity",
      "allow_l0_plugin_divergence",
    ]);
    for (const key of Object.keys(AssertionSchema.shape) as (keyof Assertion)[]) {
      if (!ALL_CLASSIFICATION_KEYS.has(key))
        throw new Error(`cowork-harness: assertion key "${String(key)}" is not classified for replay — add it to one of the classification buckets in replayCassette`);
    }
  }
  const { workRoot: replayWorkRoot, prefixes: replayPrefixes } = manifestKeys.length
    ? materializeManifest(cassette.artifacts!)
    : { workRoot: "", prefixes: [] as string[] };
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
  });

  // #1b: under --strict, a staleness mismatch is a failing assertion (non-zero exit), not just a warning.
  if (opts.strict)
    for (const s of staleness) assertions.push({ assertion: {} as Assertion, pass: false, message: `cassette stale (--strict): ${s}` });

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
    decisions: rec.decisions.map((d) => ({ kind: d.kind, name: d.name, decision: d.decision, by: d.by })),
    toolCounts: rec.toolCounts,
    gateDeliveries: rec.gateDeliveries,
    egress: [],
    assertions,
    subagents: rec.subagents,
    unanswered: rec.unanswered,
    outDir: "(replay)",
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
