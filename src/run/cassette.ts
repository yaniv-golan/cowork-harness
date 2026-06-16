import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { type Scenario, type RunResult, type Assertion } from "../types.js";
import { executeScenario, parseScenarioFile } from "./execute.js";
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
import { jsonEnvelope } from "./envelope.js";

const out = (s: string) => process.stdout.write(s + "\n");
const log = (s: string) => process.stderr.write(s + "\n");

interface Cassette {
  scenario: Scenario;
  events: string[]; // recorded child→driver stdout (events.jsonl) — the cassette source
  controlOut?: string[]; // driver→child control_responses (control-out.jsonl) — for full-fidelity replay
  effectiveFidelity?: string; // the tier the live record actually resolved to (e.g. cowork → hostloop)
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
        process.stderr.write(`::warning:: [replay] cassette events line ${i} is not valid JSON — skipping\n`);
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
      process.stderr.write(`::warning:: [replay] control-out.jsonl line ${i} is not valid JSON — skipping\n`);
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

/** `record <scenario.yaml> [--out <file>]` — run live + save a cassette. */
export async function cmdRecord(args: string[]) {
  const outIdx = args.indexOf("--out");
  // #9: bounds-check --out's value — a trailing `--out` makes cassettePath undefined → a raw
  // dirname(undefined)/writeFileSync(undefined) crash surfacing as an `internal` error.
  if (outIdx >= 0 && args[outIdx + 1] === undefined) {
    log("usage: record <scenario.yaml> --out <file.cassette.json>  (--out needs a value)");
    process.exit(2);
  }
  // #8: skip --out's VALUE when scanning for the scenario positional, so the common flag-first form
  // `record --out out.json scenario.yaml` records scenario.yaml (not out.json) as the scenario.
  const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--out");
  if (!file) {
    log("usage: record <scenario.yaml> [--out <file.cassette.json>]");
    process.exit(2);
  }
  const scenario = parseScenarioFile(file);
  const result = await executeScenario(scenario);
  const events = safeLines(join(result.outDir, "events.jsonl"));
  const controlOut = safeLines(join(result.outDir, "control-out.jsonl"));
  const cassettePath = outIdx >= 0 ? args[outIdx + 1] : join("cassettes", `${scenario.name}.cassette.json`);
  mkdirSync(dirname(cassettePath), { recursive: true });
  // Store a RELOCATABLE session path (relative to the cassette dir) instead of the absolute resolved path
  // parseScenarioFile baked in — replay never loads the session for the pipeline, so this is metadata-only,
  // but it keeps a moved bundle honest. Record the resolved tier so replay can report effectiveFidelity.
  const relocatable: Scenario = {
    ...scenario,
    session: scenario.session === "(inline)" ? "(inline)" : relative(dirname(cassettePath), scenario.session),
  };
  const cassette: Cassette = { scenario: relocatable, events, controlOut, effectiveFidelity: result.effectiveFidelity };
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
  log(`✓ recorded ${events.length} events · ${turns} turns · ${tools} tool calls → ${cassettePath}  (${result.result})`);
}

/** `replay --cassette <file>` — deterministic protocol-replay; re-evaluates content assertions. */
export async function cmdReplay(args: string[]) {
  const cIdx = args.indexOf("--cassette");
  const path = cIdx >= 0 ? args[cIdx + 1] : args.find((a) => !a.startsWith("--"));
  if (!path) {
    log("usage: replay --cassette <file.cassette.json>");
    process.exit(2);
  }
  const json =
    (args.includes("--output-format") && args[args.indexOf("--output-format") + 1] === "json") || args.includes("--output-format=json");
  const cassette: Cassette = JSON.parse(readFileSync(path, "utf8"));
  const plan: RenderPlan = { live: false, progress: false, verbose: false, color: process.stderr.isTTY === true && !process.env.NO_COLOR };
  const renderer = json ? undefined : makeRenderer(plan);
  const result = await replayCassette(cassette, renderer ? [renderer] : []);
  const bad = result.assertions.filter((a) => !a.pass);
  // stdout = machine ONLY under --output-format json; humans get the footer on stderr.
  if (json) out(jsonEnvelope("replay", [result]));
  else renderFooter(result, plan, { renderer });
  process.exit(bad.length ? 1 : 0);
}

/** Replay a cassette through Run and re-evaluate the content (non-filesystem) assertions. */
export async function replayCassette(cassette: Cassette, hooks: RunHooks[] = []): Promise<RunResult> {
  const session = new CassetteAgentSession(cassette.events, cassette.controlOut);

  // §2.5 backward compat: warn loudly when controlOut is absent so the user knows question/gate
  // assertions are being EXCLUDED (not vacuously evaluated) from this run.
  if (!session.hasControlOut) {
    process.stderr.write(
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
  ];
  const questionGateKeys: (keyof Assertion)[] = ["question_asked", "questions_count_max", "gate_answers_delivered"];
  const contentKeys: (keyof Assertion)[] = session.hasControlOut ? [...alwaysContentKeys, ...questionGateKeys] : alwaysContentKeys;

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
  const contentishKeys = new Set<keyof Assertion>([...alwaysContentKeys, ...questionGateKeys]);
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
    process.stderr.write(
      `::warning:: [replay] skipped ${fullSkipCount} filesystem/egress/expect_denied assertions (live-only) — not evaluated on replay\n`,
    );
  }
  if (partialSkipCount > 0) {
    process.stderr.write(
      `::warning:: [replay] ${partialSkipCount} mixed assertion(s) had their filesystem/egress half dropped — only the content half was evaluated on replay\n`,
    );
  }

  const assertions = evaluate(replayable, {
    transcript: rec.transcript,
    toolsCalled: rec.toolsCalled,
    subagentTools: rec.subagentTools,
    egress: [],
    result: rec.result,
    workRoot: "",
    userVisiblePrefixes: [],
    outputsDeletes: [],
    questions: rec.questions,
    hostPathLeaked: false,
    selfHealRan: false,
    subagents: rec.subagents,
    gateDeliveries: rec.gateDeliveries,
  });

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
      process.stderr.write(`::warning:: [replay] failed to read ${path}: ${String(err)}\n`);
    }
    return [];
  }
}
