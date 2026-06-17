import { warn } from "../io.js";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname, relative, isAbsolute } from "node:path";
import { type Scenario, type RunResult, type Assertion } from "../types.js";
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
import { computeVerdict } from "./verdict.js";
import { redactJsonLine, redactText, redactStructural, loadRedactionPolicy, type RedactionPolicy } from "../redact.js";
import { collectSecrets, scrub } from "../secrets.js";
import { scanText, type ScanFinding } from "../scan.js";

const out = (s: string) => process.stdout.write(s + "\n");
const log = (s: string) => process.stderr.write(s + "\n");

/** #1: a snapshotted artifact — relative path + size + content hash, plus an inlined raw body for small
 *  files (so `artifact_json`/`file_exists`/`user_visible_artifact` survive token-free replay). A file too
 *  big to inline is hash-only with `truncated:true` (a loud marker — silent truncation reads as "covered"). */
interface ManifestEntry {
  path: string; // relative to the work root, e.g. "outputs/cap_state.json"
  bytes: number;
  sha256: string;
  body?: string; // inlined RAW text for small files (≤ cap) — materialized on replay so JSON asserts work
  truncated?: boolean; // too big to inline → hash-only (file_exists works; artifact_json cannot)
}

/** #1b: a staleness tripwire over the inputs that determine the recording — mirrors `asarFingerprint`
 *  (warn-don't-fail; `--strict` hardens). `baseline` is the canonical staleness cause (a Cowork bump);
 *  `skillHash` covers local skill/plugin edits (the dev-loop case). */
interface Fingerprint {
  baseline: string; // appVersion at record time
  skillHash?: string; // hash of the session's local skill/plugin/marketplace dir contents (if any)
  skillSources?: string[]; // the local dirs that fed skillHash (for the replay recompute + diagnostics)
}

interface Cassette {
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
const CASSETTE_VERSION = 1;

const MANIFEST_BODY_CAP = 64 * 1024; // inline JSON/text bodies ≤ 64 KiB; larger → hash-only + truncated marker

/** #1: snapshot the user-visible artifacts under `workRoot` into manifest entries. */
function buildManifest(workRoot: string): ManifestEntry[] {
  return collectArtifacts(workRoot, ["outputs", ".projects"]).map(({ path, bytes }) => {
    const abs = join(workRoot, path);
    let buf: Buffer;
    try {
      buf = readFileSync(abs);
    } catch {
      return { path, bytes, sha256: "", truncated: true };
    }
    const sha256 = createHash("sha256").update(buf).digest("hex");
    if (buf.length <= MANIFEST_BODY_CAP) return { path, bytes, sha256, body: buf.toString("utf8") };
    return { path, bytes, sha256, truncated: true };
  });
}

/** #1: materialize a manifest into a temp work root so replay can run the filesystem assertions against it.
 *  Small files get their inlined body; hash-only (truncated) files get an empty placeholder (file_exists
 *  still passes; artifact_json on them fails loud — it needs the body, which only small files carry). */
function materializeManifest(entries: ManifestEntry[]): { workRoot: string; prefixes: string[] } {
  const workRoot = mkdtempSync(join(tmpdir(), "cwh-replay-"));
  for (const e of entries) {
    const abs = join(workRoot, e.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, e.body ?? "");
  }
  return { workRoot, prefixes: ["outputs", ".projects"] };
}

/** Hash a directory's structure + file CONTENTS recursively (sorted) — stable across machines. The hash
 *  folds in each entry's RELATIVE path (not just its basename) plus a type marker, so a file MOVING within
 *  the tree (`a/x.json` → `a/sub/x.json`, same content) changes the hash (S2 — basename-only missed moves). */
function hashDir(dir: string, hash: ReturnType<typeof createHash>, rel = ""): void {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const name of entries) {
    const abs = join(dir, name);
    const relPath = rel ? `${rel}/${name}` : name;
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      hash.update(`D:${relPath}\n`); // structure marker — an empty/renamed dir registers too
      hashDir(abs, hash, relPath);
    } else if (st.isFile()) {
      hash.update(`F:${relPath}\n`); // relative path, not basename — a move changes the digest
      try {
        hash.update(readFileSync(abs));
      } catch {
        /* unreadable file — skip content */
      }
    }
  }
}

/** #1b: the local skill/plugin/marketplace source dirs a session mounts — the "skill dir" hash unit.
 *  Returns ABSOLUTE dirs (for hashing/reading) plus `baseDir`, the session-file dir the relative
 *  `skillSources` are stored against (so the committed fingerprint carries no absolute host path — C1). */
function skillSourceDirs(sessionPath: string, cassetteDir?: string): { dirs: string[]; baseDir: string } {
  const resolved = cassetteDir && !isAbsolute(sessionPath) ? join(cassetteDir, sessionPath) : sessionPath;
  const baseDir = dirname(resolved);
  if (sessionPath === "(inline)" || !existsSync(resolved)) return { dirs: [], baseDir };
  let cfg;
  try {
    // Mirror loadSessionFromFile (execute.ts): parse the YAML, then RESOLVE its relative skill/plugin
    // paths against the session-file dir (`baseDir` — the post-cassetteDir-join location, so this works for
    // both the record call (no cassetteDir) and the replay call (cassetteDir set)). Passing the raw path
    // string to loadSession() throws (it wants parsed YAML) — the swallowed throw is why skillHash was
    // silently never computed.
    cfg = resolveSessionPaths(loadSession(parseSessionFile(resolved)), baseDir);
  } catch {
    return { dirs: [], baseDir };
  }
  const dirs = [...cfg.skills.local, ...cfg.plugins.local_plugins, ...cfg.plugins.remote_plugins, ...cfg.plugins.local_marketplaces].filter(
    (d) => existsSync(d),
  );
  return { dirs, baseDir };
}

export function buildFingerprint(sessionPath: string, baselineAppVersion: string, cassetteDir?: string): Fingerprint {
  const { dirs, baseDir } = skillSourceDirs(sessionPath, cassetteDir);
  if (dirs.length === 0) return { baseline: baselineAppVersion };
  const hash = createHash("sha256");
  for (const d of dirs.sort()) hashDir(d, hash);
  // Store skillSources RELATIVE to the session-file dir — diagnostics only (the replay recompute re-derives
  // the dirs from the session), so a relative path is enough and never leaks an absolute `/Users/...` path.
  return { baseline: baselineAppVersion, skillHash: hash.digest("hex"), skillSources: dirs.map((d) => relative(baseDir, d)) };
}

/** A2: scan the WHOLE cassette surface for PII (default classes: email/currency/domain). A `truncated`
 *  artifact has NO committed body (hash-only) — nothing to leak — but is reported as `unscanned` so coverage
 *  is never silently implied. Real-class findings fail the gate; `unscanned` is informational. */
export function scanCassette(cassette: Cassette, allow: RegExp[]): ScanFinding[] {
  const findings: ScanFinding[] = [];
  cassette.events.forEach((l, i) => findings.push(...scanText(l, `events[${i}]`, allow)));
  cassette.controlOut?.forEach((l, i) => findings.push(...scanText(l, `controlOut[${i}]`, allow)));
  for (const a of cassette.artifacts ?? []) {
    if (a.body !== undefined) findings.push(...scanText(a.body, `artifact ${a.path}`, allow));
    else if (a.truncated)
      findings.push({ where: `artifact ${a.path}`, cls: "unscanned", sample: "(body not committed — too large or unreadable)" });
  }
  findings.push(...scanText(cassette.scenario.prompt, "scenario.prompt", allow));
  findings.push(...scanText(JSON.stringify(cassette.scenario.answers ?? null), "scenario.answers", allow));
  findings.push(...scanText(JSON.stringify(cassette.scenario.assert ?? null), "scenario.assert", allow));
  for (const s of cassette.fingerprint?.skillSources ?? []) findings.push(...scanText(s, "fingerprint.skillSources", allow));
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
    /* no baseline available (e.g. CI without `sync`) — skip the baseline arm */
  }
  if (liveBaseline && liveBaseline !== fp.baseline) msgs.push(`baseline moved ${fp.baseline} → ${liveBaseline} since record — re-record`);
  if (fp.skillHash) {
    const live = buildFingerprint(cassette.scenario.session, fp.baseline, cassetteDir);
    if (live.skillHash === undefined)
      msgs.push("skill dirs not resolvable from the cassette location — cannot verify staleness (gate fails: can't verify ⇒ not green)");
    else if (live.skillHash !== fp.skillHash) msgs.push("local skill/plugin dir contents changed since record — re-record");
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
    artifacts: cassette.artifacts?.map((a) => (a.body !== undefined ? { ...a, body: redactJsonLine(a.body, policy) } : a)),
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
  const vb = computeVerdict(await replayCassette(base), "replay");
  const vr = computeVerdict(await replayCassette(redacted), "replay");
  if (vb.pass !== vr.pass)
    throw new Error(
      `redaction changed the replay verdict (pre-redaction pass=${vb.pass} → redacted pass=${vr.pass}) — redaction altered an ` +
        `asserted observable; refusing to write a cassette whose verdict was manufactured by redaction (A3). ` +
        `Record against synthetic inputs, or narrow the redaction policy so it doesn't touch asserted values.`,
    );
}

/** `record <scenario.yaml> [--out <file>]` — run live + save a cassette. */
export async function cmdRecord(args: string[]) {
  const outIdx = args.indexOf("--out");
  // #9: bounds-check --out's value — a trailing `--out` makes cassettePath undefined → a raw
  // dirname(undefined)/writeFileSync(undefined) crash surfacing as an `internal` error.
  if (outIdx >= 0 && args[outIdx + 1] === undefined) {
    log("usage: record <scenario.yaml> --out <file.cassette.json>  (--out needs a value)");
    process.exit(2);
  }
  // Skip --out's VALUE when scanning for the scenario positional, so the common flag-first form
  // `record --out out.json scenario.yaml` records scenario.yaml (not out.json) as the scenario.
  const scenarioPositionals = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--out");
  const file = scenarioPositionals[0];
  if (!file) {
    log("usage: record <scenario.yaml> [--out <file.cassette.json>]");
    process.exit(2);
  }
  // Reject extra scenario positionals rather than silently dropping all but the first (record takes ONE).
  if (scenarioPositionals.length > 1) {
    log(`record takes a single scenario (got ${scenarioPositionals.length}: ${scenarioPositionals.join(", ")})`);
    process.exit(2);
  }
  const noRedact = args.includes("--no-redact"); // A1 escape hatch for known-synthetic inputs
  const allowFailing = args.includes("--allow-failing"); // A3: explicitly permit freezing a red live run
  const scenario = parseScenarioFile(file);
  const result = await executeScenario(scenario);
  const events = safeLines(join(result.outDir, "events.jsonl"));
  const controlOut = safeLines(join(result.outDir, "control-out.jsonl"));
  const cassettePath = outIdx >= 0 ? args[outIdx + 1] : join("cassettes", `${scenario.name}.cassette.json`);
  mkdirSync(dirname(cassettePath), { recursive: true });
  // A3: a failing live run frozen into a committed cassette is a latent false-signal — refuse unless the
  // caller opts in. (Distinct from the redaction-verdict guard below; this catches a red run BEFORE redaction.)
  if (!computeVerdict(result, "live").pass && !allowFailing) {
    log(
      `record: live run did NOT pass (result=${result.result}) — refusing to freeze a failing run into a cassette. Re-run, or pass --allow-failing.`,
    );
    process.exit(1);
  }
  // Store a RELOCATABLE session path (relative to the cassette dir) instead of the absolute resolved path
  // parseScenarioFile baked in — replay never loads the session for the pipeline, so this is metadata-only,
  // but it keeps a moved bundle honest. Record the resolved tier so replay can report effectiveFidelity.
  const relocatable: Scenario = {
    ...scenario,
    session: scenario.session === "(inline)" ? "(inline)" : relative(dirname(cassettePath), scenario.session),
  };
  // #1: snapshot the user-visible artifacts (from the live work root, before --keep cleanup) so
  // file_exists/user_visible_artifact/artifact_json survive token-free replay. C2: buildManifest reads the
  // output bodies RAW — executeScenario scrubs result/events/control-out but NOT outputs/ — so secret-scrub
  // each body here before it is committed. #1b: a staleness tripwire over the recording's inputs.
  const secrets = collectSecrets();
  const artifacts = (result.workDir ? buildManifest(result.workDir) : []).map((a) =>
    a.body !== undefined ? { ...a, body: scrub(a.body, secrets) } : a,
  );
  const fingerprint = buildFingerprint(scenario.session, result.baseline);
  const base: Cassette = {
    cassetteVersion: CASSETTE_VERSION,
    scenario: relocatable,
    events,
    controlOut,
    effectiveFidelity: result.effectiveFidelity,
    artifacts,
    fingerprint,
  };
  // A1 (opt-in) content redaction over the whole cassette surface (C1). If the policy is empty, this is a
  // no-op and `base` is written verbatim. If non-empty, redaction must be VERDICT-PRESERVING (A3): a green
  // a redaction manufactured is the cardinal sin, so we replay both and refuse to write on divergence.
  const policy = noRedact ? { patterns: [], keyNames: [] } : loadRedactionPolicy([process.cwd(), dirname(file), dirname(cassettePath)]);
  let cassette = base;
  if (policy.patterns.length || policy.keyNames.length) {
    const redacted = redactCassette(base, policy);
    await assertRedactionVerdictPreserved(base, redacted);
    cassette = redacted;
  }
  writeFileSync(cassettePath, JSON.stringify(cassette, null, 2));
  // capture summary: turns (assistant messages) + tool calls in the recording
  let turns = 0;
  let tools = 0;
  for (const e of cassette.events) {
    let m: any;
    try {
      m = JSON.parse(e);
    } catch {
      continue;
    }
    if (m.type === "assistant") {
      turns++;
      for (const b of m.message?.content ?? []) if (b.type === "tool_use") tools++;
    }
  }
  log(
    `✓ recorded ${events.length} events · ${turns} turns · ${tools} tool calls · ${artifacts.length} artifact(s) → ${cassettePath}  (${result.result})`,
  );
}

/** `replay --cassette <file>` — deterministic protocol-replay; re-evaluates content assertions. */
export async function cmdReplay(args: string[]) {
  const cIdx = args.indexOf("--cassette");
  const path = cIdx >= 0 ? args[cIdx + 1] : args.find((a) => !a.startsWith("--"));
  // Bounds/flag-check the path: `replay --cassette --output-format json` must NOT treat `--output-format`
  // as the cassette path (then fail later as a confusing file/JSON error) — reject a flag-looking value.
  if (!path || path.startsWith("-")) {
    log("usage: replay --cassette <file.cassette.json>");
    process.exit(2);
  }
  let json: boolean;
  try {
    json = parseOutputFormat(args) === "json"; // validate the value (don't silently treat `xml` as text)
  } catch (e) {
    log(String((e as Error).message));
    process.exit(2);
  }
  const strict = args.includes("--strict"); // #1b: escalate staleness warnings to failures (release gate)
  const cassette: Cassette = JSON.parse(readFileSync(path, "utf8"));
  const plan: RenderPlan = { live: false, progress: false, verbose: false, color: process.stderr.isTTY === true && !process.env.NO_COLOR };
  const renderer = json ? undefined : makeRenderer(plan);
  const result = await replayCassette(cassette, renderer ? [renderer] : [], { strict, cassetteDir: dirname(path) });
  // SEAM B: the replay lane evaluates assertions + result only (a cassette can't reproduce the scan /
  // permissive signals). One verdict source for the footer AND the exit, so they can't diverge (and the
  // exit now honors result:"error", which the old `bad.length`-only check missed).
  const verdict = computeVerdict(result, "replay");
  // stdout = machine ONLY under --output-format json; humans get the footer on stderr.
  if (json) out(jsonEnvelope("replay", [result]));
  else renderFooter(result, plan, { renderer, lane: "replay" });
  process.exit(verdict.exitCode);
}

/** `verify-cassettes <file|dir>` — the CI gate (token/agent-free). Runs the privacy scan (A2) and the
 *  staleness check (B3) over one cassette or every `*.cassette.json` in a dir (non-recursive). Exit 1 on any
 *  real PII finding or staleness drift; `unscanned` notes are informational. Dedicated JSON envelope. */
export function cmdVerifyCassettes(args: string[]) {
  let json: boolean;
  try {
    json = parseOutputFormat(args) === "json";
  } catch (e) {
    log(String((e as Error).message));
    return process.exit(2);
  }
  const privacyOnly = args.includes("--privacy-only");
  const stalenessOnly = args.includes("--staleness-only");
  const doPrivacy = !stalenessOnly;
  const doStaleness = !privacyOnly;
  const allow: RegExp[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--allow") continue;
    const src = args[++i];
    if (src === undefined) {
      log("--allow needs a regex value");
      return process.exit(2);
    }
    try {
      allow.push(new RegExp(src, "i"));
    } catch {
      log(`--allow: invalid regex: ${src}`);
      return process.exit(2);
    }
  }
  const target = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--allow");
  if (!target) {
    log("usage: verify-cassettes <file|dir> [--privacy-only|--staleness-only] [--allow <regex>]... [--output-format json]");
    return process.exit(2);
  }
  if (!existsSync(target)) {
    log(`verify-cassettes: path not found: ${target}`);
    return process.exit(2);
  }
  const files = statSync(target).isDirectory()
    ? readdirSync(target)
        .filter((f) => f.endsWith(".cassette.json"))
        .sort()
        .map((f) => join(target, f))
    : [target];
  if (files.length === 0) {
    log(`verify-cassettes: no .cassette.json files under ${target} — nothing verified (loud non-zero, not a vacuous pass)`);
    return process.exit(2);
  }
  const results = files.map((f) => {
    const cassette: Cassette = JSON.parse(readFileSync(f, "utf8"));
    const findings = doPrivacy ? scanCassette(cassette, allow) : [];
    const staleness = doStaleness ? checkStaleness(cassette, dirname(f)) : [];
    return { file: f, findings, staleness };
  });
  const realFindings = results.flatMap((r) => r.findings.filter((x) => x.cls !== "unscanned"));
  const staleAny = results.some((r) => r.staleness.length > 0);
  const ok = realFindings.length === 0 && !staleAny;
  if (json) {
    out(JSON.stringify({ command: "verify-cassettes", ok, results }));
  } else {
    for (const r of results) {
      for (const f of r.findings) log(`${f.cls === "unscanned" ? "·" : "✗"} ${r.file}: [${f.cls}] ${f.where} — ${f.sample}`);
      for (const s of r.staleness) log(`✗ ${r.file}: [stale] ${s}`);
    }
    log(
      ok
        ? `✓ verify-cassettes: ${files.length} cassette(s) clean`
        : `✗ verify-cassettes: ${realFindings.length} PII finding(s)${staleAny ? " + staleness drift" : ""} across ${files.length} cassette(s)`,
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
    try {
      liveBaseline = loadBaseline("latest").appVersion;
    } catch {
      /* no baseline available (e.g. CI without baselines) — skip the baseline arm */
    }
    if (liveBaseline && liveBaseline !== fp.baseline)
      staleness.push(`baseline moved ${fp.baseline} → ${liveBaseline} since record — re-record before trusting this replay`);
    if (fp.skillHash) {
      const live = buildFingerprint(cassette.scenario.session, fp.baseline, opts.cassetteDir);
      if (live.skillHash === undefined)
        warn(
          "::warning:: [replay] skill fingerprint not re-checkable (local skill dirs not resolvable from this cassette location) — baseline check still applies\n",
        );
      else if (live.skillHash !== fp.skillHash)
        staleness.push("local skill/plugin dir contents changed since record — re-record before trusting this replay");
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
