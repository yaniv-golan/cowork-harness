import { warn } from "../io.js";
import { isUsageLimit } from "../usage-limit.js";
import { randomUUID, createHash } from "node:crypto";
import type { AgentSession, AgentEvent, DecisionRequest, DecisionResponse, QSpec } from "../agent/session.js";
import type { UsageInfo, CostInfo, RunResult } from "../types.js";
import { questionKey, questionLabel, canon } from "../agent/session.js";
import {
  ABSTAIN,
  UnansweredError,
  PERMISSIVE_AUTOALLOW_RATIONALE,
  type Decider,
  type Decision,
  type RunContext,
} from "../decide/decider.js";
import { ProvenanceTracker } from "../hostloop/provenance.js";
import { normalizeHost, validateBareDomain } from "../boundary-paths.js";

/** Bound a captured decision input so a large tool payload can't bloat the run record. Objects pass
 *  through structurally (consumers read fields like `.command`); only an over-cap JSON serialization is
 *  truncated to a marker string. */
function capDecisionInput(input: unknown): unknown {
  try {
    const json = JSON.stringify(input);
    if (json !== undefined && json.length > 10 * 1024) return { truncated: true, bytes: json.length };
    return input;
  } catch {
    return { unserializable: true };
  }
}

/** Classify a `Read` tool's `file_path` as a skill reference/script access, returning the skill-relative
 *  suffix (`references/foo.md`, `scripts/bar.py`) or undefined if it isn't one. Namespace-agnostic: it
 *  keys off the mounted plugin-root marker (`.local-plugins`/`.remote-plugins`) plus a `references/` or
 *  `scripts/` segment, so it works regardless of the container-vs-host path shape. `SKILL.md` is delivered
 *  whole (never Read as a file), so this only ever covers references/ and scripts/. */
export function skillReferenceReadPath(filePath: string): string | undefined {
  if (!filePath || !/(?:\.local-plugins|\.remote-plugins)\//.test(filePath)) return undefined;
  const m = filePath.match(/\/((?:references|scripts)\/.+)$/);
  return m ? m[1] : undefined;
}

/** Extract the ordered `file_path` list from a `mcp__cowork__present_files` tool_use's `input`
 *  (`{ files: [{ file_path }, …] }`) — guards every shape (missing/non-array `files`, a non-object or
 *  non-string-`file_path` entry) so a malformed input can't throw mid-drive; a bad entry is just
 *  dropped, not fatal (mirrors the input-guarding style used across this file, e.g. pendingTaskCreates). */
function presentFilesInput(input: unknown): { files: string[]; malformed: number } {
  const files = (input as { files?: unknown } | undefined)?.files;
  if (files === undefined) return { files: [], malformed: 0 };
  if (!Array.isArray(files)) return { files: [], malformed: 1 }; // a non-array `files` is a malformed call
  const mapped = files.map((f) =>
    f && typeof f === "object" && typeof (f as Record<string, unknown>).file_path === "string"
      ? ((f as Record<string, unknown>).file_path as string)
      : undefined,
  );
  return { files: mapped.filter((p): p is string => p !== undefined), malformed: mapped.filter((p) => p === undefined).length };
}

/** Collapse a RunRecord's infra/evidence-error telemetry to the RunResult shape (undefined when clean, so
 *  JSON.stringify drops the key on a healthy run). Shared by every RunResult assembler so the two fields
 *  can't silently diverge across lanes. */
export function infraErrorsForResult(rec: Pick<RunRecord, "infraErrors">): RunResult["infraErrors"] {
  return rec.infraErrors.length ? rec.infraErrors : undefined;
}
export function evidenceErrorsForResult(rec: Pick<RunRecord, "evidenceErrors">): RunResult["evidenceErrors"] {
  const e = rec.evidenceErrors;
  return e.taskTracking || e.webSearchParse || e.presentFilesMalformed ? e : undefined;
}

/** Find the JSON array following a WebSearch tool_result's "Links: " marker, respecting quoted-string
 *  boundaries (a plain bracket-depth count would mis-close on a title containing a literal ']'). Returns
 *  undefined if the marker is absent or the array's closing bracket is never reached (e.g. the tool_result
 *  text was truncated past the assertText cap). */
function extractLinksArray(text: string): string | undefined {
  const marker = "Links: [";
  const start = text.indexOf(marker);
  if (start === -1) return undefined;
  const arrayStart = start + marker.length - 1; // position of the opening '['
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = arrayStart; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return text.slice(arrayStart, i + 1);
    }
  }
  return undefined; // truncated — no matching close bracket found
}

/** Parse a WebSearch tool_result's embedded Links array into {title,url} pairs. Returns undefined (never
 *  throws) on any malformed/truncated input — the caller drops the whole entry rather than storing a
 *  partial/corrupt one. */
function parseWebSearchLinks(text: string): Array<{ title: string; url: string }> | undefined {
  const jsonArray = extractLinksArray(text);
  if (!jsonArray) return undefined;
  try {
    const arr: unknown = JSON.parse(jsonArray);
    if (!Array.isArray(arr)) return undefined;
    return arr
      .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
      .map((r) => ({ title: String(r.title ?? ""), url: String(r.url ?? "") }))
      .filter((r) => r.url);
  } catch {
    return undefined;
  }
}

/** the observable sub-agent dispatch tree (single owner = RunRecord). */
interface SubagentDispatch {
  toolUseId: string;
  parentToolUseId?: string;
  agentType: string;
  declaredTools: string[];
  toolsUsed: Array<{ name: string; count: number }>;
  description?: string; // the dispatch's `description` — identifies it when the skill set no subagent_type
  prompt?: string; // dispatch input.prompt, assertText-capped
  model?: string; // the dispatching message's model
  output?: string; // the dispatch's own paired tool_result, assertText-capped — populated by a finalize step, not at push time
  outputTruncated?: boolean; // `output` was cut at the assert cap (#9) — set in denormalizeSubagentOutputs
}

interface DecisionRecord {
  kind: "tool" | "question" | "dialog" | "elicit";
  name: string;
  decision: string;
  by: string;
  // The gate's request_id (UUID). Present on question decisions so `trace --view questions` can pair a persisted
  // decision to its events.jsonl row BY ID rather than positionally — a retried/duplicated gate event
  // would otherwise shift every later row's `by`/`model` label. Absent on older records (positional fallback).
  requestId?: string;
  model?: string; // decider model for by:"llm" gates — surfaced in gate provenance for auditability
  detail?: unknown;
  rationale?: string;
  // The FULL offered option set (label + description) as originally presented by the model — present
  // only on kind:"question" gates. `detail` already carries the flat {question: chosen-answer} map for
  // gate-provenance.ts's existing readers; this is additive, not a replacement.
  questions?: QSpec[];
}

export interface RunRecord {
  runId: string;
  result: "success" | "error";
  // when result === "error", whether the error looks like a transport drop (connection closed after a
  // clean result) vs a genuine agent/skill failure. Undefined on success or unclassified errors.
  resultErrorKind?: "transport" | "agent" | "usage_limit";
  // finer error source than resultErrorKind's binary — the raw `error`-event source, or "result" for
  // the SDK-wrapped is_error result path, or "no_result" when the stream closed with no terminal event,
  // or "timeout" when the harness's wall-clock limit killed the run. Undefined when no error fired; a
  // recovered non-fatal agent error that later succeeds keeps its first source. Optional ⇒ no literal churn.
  errorSource?: "spawn" | "protocol" | "exit" | "agent" | "result" | "no_result" | "timeout";
  // the SDK result message's `subtype` verbatim (error_max_turns / error_during_execution / success / …).
  // Pass-through diagnostic — captured on the result event, surfaced so a debugger can tell turn-exhaustion
  // from a generic execution error. Undefined until a result event with a subtype is seen.
  resultSubtype?: string;
  // The SDK result message's text (`{type:"result"}`.result) — the model's designated FINAL answer,
  // distinct from the joined `transcript` (every assistant turn concatenated). This is what
  // llm-transport treats as "the answer"; surfaced as RunResult.finalMessage. Undefined until a result
  // event carries text.
  resultText?: string;
  // set true when the run ended on an unanswered plain-text question (see the post-loop detector in
  // drive()). Mapped into RunResult by execute.ts (live) and cassette.ts (replay re-drive).
  stalledOnQuestion?: boolean;
  initTools: string[];
  cwd?: string;
  transcript: string;
  toolsCalled: Set<string>;
  toolCounts: Record<string, number>; // TRUTHFUL per-tool call count from the tool_use stream (top-level only)
  subagentTools: Set<string>;
  subagents: SubagentDispatch[];
  questions: string[];
  decisions: DecisionRecord[];
  permissiveAutoAllow: string[]; // tools auto-allowed by cowork parity for unscripted/off-registry perms (real Cowork blocks these)
  unanswered: { question: string; chosen: string; by: string; rationale?: string; model?: string }[];
  toolResults: { toolUseId?: string; isError: boolean; text: string; assertText?: string; assertTextTruncated?: boolean }[]; // captured tool OUTCOMES
  gateAnswers: { question: string; toolUseId?: string; answers: Record<string, string> }[]; // answered AskUserQuestion gates
  gateDeliveries: {
    question: string;
    delivered: boolean | null;
    error?: string;
    reason?: "ok" | "errored" | "unobserved" | "no-pairing-metadata";
  }[]; // did the answer reach the model? (null = unobserved or no-pairing-metadata)
  usage?: UsageInfo;
  cost?: CostInfo;
  skillsInvoked: string[]; // top-level Skill tool_use ids, in call order, duplicates kept
  filesRead: string[]; // skill-relative reference/script files the agent Read (progressive-disclosure signal), deduped, first-seen order
  models: string[]; // distinct model ids seen across assistant_text/tool_use/thinking events, first-seen order, deduped
  thinking: { text: string }[]; // reasoning blocks, capped: last 50 × 10KB each
  thinkingElided: number; // count of older thinking blocks dropped past the 50-block cap
  toolErrors: Record<string, { calls: number; errors: number }>; // per-tool call/error rollup
  modelUsage?: Record<string, Record<string, unknown>>; // per-model cost/token breakdown, from the SDK's own result-message field
  redundantToolCalls: Array<{ name: string; argHash: string; count: number }>; // repeated identical calls, count>=2 only
  tasks: Map<string, { id: string; subject: string; status: string; description?: string; activeForm?: string }>; // Progress panel — deleted tasks removed from the map, never surfaced
  // Context/Connectors panel. availableSkills is optional and NOT set here — it's filled in
  // by the RunResult assemblers (execute.ts), which read it straight off the staged skill set on disk
  // rather than accumulating it from live events like tools/mcpServers.
  // tools/mcpServers are OPTIONAL: they're set only when the SDK `system/init` event arrives. A pre-init
  // crash leaves them undefined (evidence-unavailable) rather than an empty inventory that would falsely
  // read as "the agent had no tools/connectors". availableSkills is re-derived from disk, so it's exempt.
  context: { tools?: string[]; mcpServers?: unknown[]; availableSkills?: Array<{ id: string; whenToUse?: string }> };
  contextEvents: Array<{ subtype: string; data: Record<string, unknown> }>; // system events we don't special-case (compaction etc.)
  mcpErrors: Array<{ server: string; code?: number; message: string }>; // MCP round-trips the harness answered with a JSON-RPC error (no handler, or the handler threw)
  hookEvents: Array<{ callbackId: string; decision: "block" | "allow"; reason?: string; tool?: string }>; // PreToolUse hook fire/block events (built-in Task hook + any custom hook bundle)
  // Files delivered via the cowork `present_files` tool, in call order — derived from each
  // `mcp__cowork__present_files` tool_use (the input file list) paired with its own tool_result (the
  // returned path per file, in the same order). CONTENT-CLASS: both halves live in the ordinary
  // tool_use/tool_result stream (events.jsonl), so this is re-derived identically on the replay
  // re-drive — no controlOut/onPresent dependency. `promoted` = the file was in the scratchpad and
  // landed under `mnt/outputs`; `leaked` = it was in the scratchpad but did NOT land there (the
  // handler's copy-failure branch — present_files' own "remains in the scratchpad" case). A path
  // already under a mount (passthrough) is neither promoted nor leaked.
  presentedFiles: Array<{ from: string; to: string; promoted: boolean; leaked: boolean }>;
  // Structured WebSearch calls: query (from tool_use.input) + per-result {title,url} (parsed from the
  // paired tool_result's "Web search results for query: ...\n\nLinks: [...]" convention — an
  // AGENT-BINARY convention, verified against a real captured hostloop-fidelity cassette; re-verify the
  // format on agent-version bumps). A parse failure drops that ONE call silently (see
  // parseWebSearchLinks) rather than crashing the run.
  webSearches: Array<{ toolUseId?: string; query: string; results: Array<{ title: string; url: string }> }>;
  /** Infrastructure errors (VM/egress sidecar crashes) — a non-empty list is a both-lane hard verdict fail
   *  (not author-suppressible), the evidence is contaminated. Populated from `infra_error` events (live +
   *  replay re-drive) and the sidecar's post-run `fatalError`. */
  infraErrors: Array<{ source: string; message: string }>;
  /** Companion counters for malformed/dropped telemetry — a >0 count means the relevant evidence stream
   *  was partially unparseable, so the dependent assertion fails "malformed" rather than silently dropping
   *  the bad entries. (resource malformed lines live on `resources.malformedLines`; hash errors on
   *  `workspaceFiles[].hashError`.) */
  evidenceErrors: { taskTracking: number; webSearchParse: number; presentFilesMalformed: number; egressParse?: number };
}

export interface RunHooks {
  onEvent?(e: AgentEvent): void;
  finalize?(r: RunRecord): void;
}

const DIALOG_AUTOCANCEL_MS = 6000; // request_user_dialog host auto-cancel

// transport-layer signatures. Deliberately NARROW — `API Error`/`terminated` are dropped because they
// collide with skill-emitted error text and would misclassify genuine failures as transport.
const TRANSPORT_SIGNATURE = /connection closed|ECONNRESET|socket hang up|fetch failed/i;

/**
 * classify a `result==="error"` as a tail-end TRANSPORT drop vs a genuine agent/skill failure, so the
 * verdict can distinguish "the connection dropped after a clean result" from "the skill failed". Satisfiable
 * by construction (the earlier draft's "prior result THIS turn" gate was empty — a turn has one result):
 *   - "result" path (SDK wrapped a transport failure into an is_error result): transport iff the signature
 *     matches. The result IS the signal — no prior-result gate.
 *   - "exit" path (nonzero child exit): transport iff a clean result already landed this run AND the stderr
 *     tail matches — the "child dropped after printing a result" case. Otherwise a genuine crash → agent.
 *   - "spawn"/"protocol": always agent (a real fault).
 * NOTE: the exact wire envelope of "API Error: Connection closed" is not yet pinned from a captured cassette;
 * a non-matching signature simply falls back to "agent" (today's behavior) — never a false-green, since
 * transport_error is itself severity:fail.
 */
export function classifyResultError(
  source: "result" | "exit" | "spawn" | "protocol",
  signature: string,
  sawSuccessResult: boolean,
  apiErrorStatus?: number,
): "transport" | "agent" | "usage_limit" {
  // Quota exhaustion: an is_error result carrying HTTP 429 AND terminal usage-limit text (a bare 429 is an
  // ambiguous transient/overload window the SDK retries, so BOTH are required — see usage-limit.ts). Only
  // the "result" path carries api_error_status.
  if (source === "result" && isUsageLimit(signature, apiErrorStatus)) return "usage_limit";
  const isTransport = TRANSPORT_SIGNATURE.test(signature);
  if (source === "result") return isTransport ? "transport" : "agent";
  if (source === "exit") return sawSuccessResult && isTransport ? "transport" : "agent";
  return "agent";
}

/** Run: the turn loop + decision dispatch + RunRecord building. */
export class Run {
  private rec: RunRecord;
  private toolLog: { name: string; input: unknown; synthetic?: boolean; parentToolUseId?: string }[] = [];
  private toolNameByUseId = new Map<string, string>();
  // toolUseIds whose children are the MAIN AGENT's own work, not an isolated sub-agent's: a top-level
  // (or fork-nested) Skill call, or an explicit Agent(subagent_type:"fork") dispatch — both inherit the
  // main agent's context rather than starting isolated. Seeded as each qualifying tool_use/dispatch is
  // processed, and since a parent always streams before its children, it's complete by the time any
  // child needs to check membership. A POSITIVE set: a parented tool only counts as main-agent flow when
  // its parent is positively confirmed here, so an unrecognized parent stays dropped/sub-agent-attributed
  // exactly as before — fail-safe toward undercount, never toward overcount.
  private forkScopedIds = new Set<string>();
  // TaskCreate's tool_use carries no id (only subject/description) — the real id only appears in the
  // paired tool_result text ("Task #<N> created successfully: <subject>"). Keyed by toolUseId so the
  // eventual tool_result can look up which pending create it resolves, mirroring toolNameByUseId's pattern.
  private pendingTaskCreates = new Map<string, { subject: string; description?: string; activeForm?: string }>();
  // Pending `mcp__cowork__present_files` calls, keyed by toolUseId — the input file list, stashed at
  // tool_use time and resolved by the matching tool_result (see notePresentedFiles). Same
  // stash-then-resolve pattern as pendingTaskCreates above.
  private pendingPresentFiles = new Map<string, string[]>();
  // Pending WebSearch calls, keyed by toolUseId — the query, stashed at tool_use time and resolved by
  // the matching tool_result (see the tool_result case in drive()). Same stash-then-resolve pattern as
  // pendingTaskCreates/pendingPresentFiles above.
  private pendingWebSearches = new Map<string, string>();
  // per-session web_fetch provenance set. Run owns it (it sees user turns + tool_results) and
  // seeds it during drive(); the workspace handler reads membership + escalates misses via the Decider.
  private provenance = new ProvenanceTracker();
  // web_fetch per-DOMAIN approvals ("Allow all for website"). Per-Run, ephemeral (starts empty) —
  // verified the grant is session-scoped, not persistent. An approved host fetches with no re-prompt.
  private approvedDomains = new Set<string>();

  constructor(
    private session: AgentSession,
    private decider: Decider,
    private hooks: RunHooks[] = [],
    runId = "run",
    private dialogTimeoutMs: number = DIALOG_AUTOCANCEL_MS,
    private runTimeoutMs?: number,
  ) {
    this.rec = {
      runId,
      result: "error",
      initTools: [],
      transcript: "",
      toolsCalled: new Set(),
      toolCounts: {},
      filesRead: [],
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
      context: {}, // tools/mcpServers stay undefined until system/init arrives (see the type comment); a pre-init crash → evidence-unavailable, not empty inventory
      contextEvents: [],
      mcpErrors: [],
      hookEvents: [],
      presentedFiles: [],
      webSearches: [],
      infraErrors: [],
      evidenceErrors: { taskTracking: 0, webSearchParse: 0, presentFilesMalformed: 0 },
    };
  }

  private static readonly THINKING_CAP = 50;
  private static readonly THINKING_TEXT_CAP_BYTES = 10 * 1024;

  private noteModel(model?: string): void {
    if (model && !this.rec.models.includes(model)) this.rec.models.push(model);
  }

  private noteThinking(text: string): void {
    const capped = text.length > Run.THINKING_TEXT_CAP_BYTES ? text.slice(0, Run.THINKING_TEXT_CAP_BYTES) : text;
    this.rec.thinking.push({ text: capped });
    if (this.rec.thinking.length > Run.THINKING_CAP) {
      this.rec.thinking.shift();
      this.rec.thinkingElided++;
    }
  }

  /** Fold `toolLog` into `rec.redundantToolCalls` — groups by `name:canon(input)`, keeping only
   *  groups with count>=2 (repeated identical calls). Runs once at drive-completion (needs the FULL
   *  toolLog), not per-event. `argHash` is a truncated sha256 of the canonicalized input, so the
   *  rollup never carries raw args (redaction-safe by construction — see RunResult.redundantToolCalls).
   *
   *  Scoped to main-agent entries only (top-level, plus fork-inner via `forkScopedIds`), non-synthetic —
   *  matching toolErrors/toolCounts's existing scope (see the tool_use case above). toolLog itself stays
   *  unconditional (the stall detector below relies on that), so the filter lives here instead: a
   *  synthetic MCP echo carries a DIFFERENT input shape than the real call (raw JSON-RPC params vs. flat
   *  tool args), so it never collides with the real entry's group — but N real MCP calls would otherwise
   *  ALSO produce N synthetic echoes, i.e. a second `count:N` group, doubling `redundantCallsTotal` to
   *  2·(N-1) instead of the true N-1. Isolated sub-agent-scoped entries are excluded for the same reason
   *  toolCounts excludes them: a sub-agent's internal repeats aren't a main-agent redundancy.
   *  `forkScopedIds` is fully populated by the time this runs (drive-completion, after every tool_use has
   *  been processed), so a fork-inner repeat lands in the same group as a top-level one would. */
  private foldRedundantToolCalls(): void {
    const groups = new Map<string, number>();
    for (const { name, input, synthetic, parentToolUseId } of this.toolLog) {
      if (synthetic || (parentToolUseId && !this.forkScopedIds.has(parentToolUseId))) continue;
      const key = `${name}:${canon(input)}`;
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    const out: { name: string; argHash: string; count: number }[] = [];
    for (const [key, count] of groups) {
      if (count < 2) continue;
      const sepIdx = key.indexOf(":");
      const name = key.slice(0, sepIdx);
      const argHash = createHash("sha256")
        .update(key.slice(sepIdx + 1))
        .digest("hex")
        .slice(0, 16);
      out.push({ name, argHash, count });
    }
    this.rec.redundantToolCalls = out;
  }

  private ctx(): RunContext {
    return { task: this.rec.transcript, transcript: () => this.rec.transcript, toolLog: () => this.toolLog, runId: this.rec.runId };
  }

  /** The in-progress record. When `drive()` throws on an unanswered gate, this holds everything accumulated
   *  up to the whiff (transcript, decisions, tool counts, artifacts-on-disk are separate) — the caller uses
   *  it to salvage a partial run instead of discarding the work. Fully initialized in the constructor, so
   *  it's a usable shell even on a very-early throw. The post-loop gate-delivery pairing has NOT run on the
   *  throw path, so `gateDeliveries` is empty here. */
  partial(): RunRecord {
    return this.rec;
  }

  /** Drive one-shot (string) or multi-turn (async iterable) and return the record. */
  async drive(turns: string | AsyncIterable<string>, startOpts?: Parameters<AgentSession["start"]>[0]): Promise<RunRecord> {
    const turnIter = typeof turns === "string" ? oneShot(turns) : turns[Symbol.asyncIterator]();
    const transcript: string[] = [];
    // run-level latch — did any turn reach a clean (non-error) result before the child died? Read by
    // the exit-error path to tell "child dropped after a successful result" (transport) from a crash.
    let sawSuccessResult = false;

    // write the `initialize` control_request BEFORE the first user turn, matching the SPEC wire
    // order (initialize precedes the user turn). Idempotent — `start()` also calls init(), and replay
    // (cassette) sessions omit init() entirely, so this is a no-op there.
    this.session.init?.(startOpts);
    // Prime the first user turn before reading the stream.
    const first = await turnIter.next();
    if (!first.done) {
      this.provenance.seedFromText(first.value); // seed provenance from the user's prompt
      this.session.sendUserTurn(first.value);
    }

    // Wall-clock timeout (opt-in). On expiry, KILL the child (not just close stdin — a runaway agent
    // ignores an stdin close) and latch `timedOut` so the post-loop code labels errorSource:"timeout"
    // (overriding the "exit" the kill produces). unref so the timer never keeps the process alive.
    let timedOut = false;
    let runTimer: ReturnType<typeof setTimeout> | undefined;
    if (this.runTimeoutMs !== undefined && isFinite(this.runTimeoutMs) && this.runTimeoutMs > 0) {
      runTimer = setTimeout(() => {
        timedOut = true;
        (this.session.kill ?? this.session.close).call(this.session);
      }, this.runTimeoutMs);
      runTimer.unref?.();
    }

    try {
      outerLoop: for await (const ev of this.session.start(startOpts)) {
        for (const h of this.hooks) h.onEvent?.(ev);
        switch (ev.type) {
          case "init":
            this.rec.initTools = ev.tools;
            this.rec.cwd = ev.cwd;
            this.rec.context = { tools: ev.tools, mcpServers: ev.mcpServers, availableSkills: ev.skills.map((id) => ({ id })) };
            break;
          case "assistant_text":
            this.noteModel(ev.model);
            if (!ev.parentToolUseId) transcript.push(ev.text);
            break;
          case "tool_use": {
            this.noteModel(ev.model);
            // A parented tool_use is MAIN AGENT flow — and counts exactly like a top-level call — when its
            // parent is a confirmed fork parent (forkScopedIds): a Skill call, or an Agent(fork) dispatch,
            // both of which inherit the main agent's context rather than starting isolated. Anything else
            // parented falls to the sub-agent branch below (attributed if the parent is a recognized
            // dispatch, dropped otherwise — unchanged from before).
            const isMainAgentFlow = !ev.parentToolUseId || this.forkScopedIds.has(ev.parentToolUseId);
            if (isMainAgentFlow && !ev.synthetic) {
              // synthetic = the MCP round-trip echo; the real call already arrived as an assistant tool_use
              // block (live-verified), so counting the synthetic too would double-list it / add a bogus name.
              this.rec.toolsCalled.add(ev.name);
              this.rec.toolCounts[ev.name] = (this.rec.toolCounts[ev.name] ?? 0) + 1; // count main-agent calls (isolated sub-agent tools excluded, matching toolsCalled)
              // a top-level (or fork-nested) Skill invocation — duplicates kept (re-triggering is signal).
              if (ev.name === "Skill") this.rec.skillsInvoked.push(String((ev.input as Record<string, unknown> | undefined)?.skill ?? ""));
              // Progressive-disclosure signal: which of the skill's reference/script files the agent
              // actually Read (SKILL.md is delivered whole, never Read as a file — so this covers
              // references/* and scripts/*). Deduped, first-seen order.
              if (ev.name === "Read") {
                const ref = skillReferenceReadPath(String((ev.input as Record<string, unknown> | undefined)?.file_path ?? ""));
                if (ref && !this.rec.filesRead.includes(ref)) this.rec.filesRead.push(ref);
              }
              if (ev.toolUseId) this.toolNameByUseId.set(ev.toolUseId, ev.name);
              // A Skill call inherits the main agent's context when it runs (fork context) — seed its id so
              // any children it dispatches are recognized as main-agent flow too, transitively.
              if (ev.name === "Skill" && ev.toolUseId) this.forkScopedIds.add(ev.toolUseId);
              // Progress panel: TaskCreate's input has no id — stash it, resolved by the
              // paired tool_result below. TaskUpdate's input carries taskId directly, so it applies here.
              if (ev.name === "TaskCreate" && ev.toolUseId) {
                const inp = (ev.input as Record<string, unknown> | undefined) ?? {};
                this.pendingTaskCreates.set(ev.toolUseId, {
                  subject: String(inp.subject ?? ""),
                  description: inp.description != null ? String(inp.description) : undefined,
                  activeForm: inp.activeForm != null ? String(inp.activeForm) : undefined,
                });
              }
              if (ev.name === "TaskUpdate") {
                const inp = (ev.input as Record<string, unknown> | undefined) ?? {};
                const taskId = inp.taskId != null ? String(inp.taskId) : undefined;
                const status = inp.status != null ? String(inp.status) : undefined;
                const existing = taskId ? this.rec.tasks.get(taskId) : undefined;
                if (existing && status) existing.status = status;
              }
              if (ev.name === "WebSearch" && ev.toolUseId) {
                const inp = (ev.input as Record<string, unknown> | undefined) ?? {};
                this.pendingWebSearches.set(ev.toolUseId, String(inp.query ?? ""));
              }
            } else if (ev.parentToolUseId) {
              // isolated sub-agent work — only count this as a sub-agent tool when its parent is a
              // RECOGNIZED dispatch (Agent/Task/subagent_type). Any parented tool_use carries a
              // parentToolUseId, but adding all of them to subagentTools over-counts and produces false
              // positives/negatives on subagent_tool_used / subagent_tool_absent. Scope to the same
              // dispatch the per-subagent toolsUsed push already uses. (Deep-nesting/unknown parents fall
              // through here too and are dropped, exactly as before.)
              const sa = this.rec.subagents.find((s) => s.toolUseId === ev.parentToolUseId);
              if (sa) {
                this.rec.subagentTools.add(ev.name);
                const entry = sa.toolsUsed.find((d) => d.name === ev.name);
                if (entry) entry.count++;
                else sa.toolsUsed.push({ name: ev.name, count: 1 });
              }
            }
            // A `present_files` call is stashed regardless of main-agent/sub-agent scope above — the
            // observability question ("did a presented scratchpad file actually reach outputs?") applies
            // run-wide, not just to main-agent-attributed tool calls.
            if (ev.name === "mcp__cowork__present_files" && ev.toolUseId) {
              const pf = presentFilesInput(ev.input);
              this.pendingPresentFiles.set(ev.toolUseId, pf.files);
              this.rec.evidenceErrors.presentFilesMalformed += pf.malformed;
            }
            this.toolLog.push({ name: ev.name, input: ev.input, synthetic: ev.synthetic, parentToolUseId: ev.parentToolUseId }); // still logged for provenance/trace
            break;
          }
          case "tool_result": {
            this.rec.toolResults.push({
              toolUseId: ev.toolUseId,
              isError: ev.isError,
              text: ev.text,
              assertText: ev.assertText,
              assertTextTruncated: ev.assertTextTruncated,
            });
            if (ev.toolUseId) this.notePresentedFiles(ev.toolUseId, ev.textBlocks);
            if (ev.toolUseId) {
              const name = this.toolNameByUseId.get(ev.toolUseId);
              if (name) {
                const bucket = this.rec.toolErrors[name] ?? { calls: 0, errors: 0 };
                bucket.calls++;
                if (ev.isError) bucket.errors++;
                this.rec.toolErrors[name] = bucket;
              }
              // Progress panel: resolve a pending TaskCreate's real id from the tool_result
              // text — the ONLY place the id appears. A non-matching format (or an errored result) is
              // silently dropped, not a crash; no TaskDelete/cancel path has ever been observed.
              const pending = this.pendingTaskCreates.get(ev.toolUseId);
              if (pending) {
                this.pendingTaskCreates.delete(ev.toolUseId);
                const m = /^Task #(\S+) created successfully/.exec(ev.text);
                if (m) this.rec.tasks.set(m[1], { id: m[1], status: "pending", ...pending });
                // A non-error TaskCreate result that didn't match the expected format = the task is lost
                // from telemetry (upstream wording drift). Count it so task assertions fail malformed
                // rather than silently under-counting. An errored result legitimately created no task.
                else if (!ev.isError) this.rec.evidenceErrors.taskTracking++;
              }
              const pendingSearch = this.pendingWebSearches.get(ev.toolUseId);
              if (pendingSearch !== undefined) {
                this.pendingWebSearches.delete(ev.toolUseId);
                // MUST use assertText (10KB cap, src/agent/session.ts's toolResultAssertText), NOT ev.text
                // (500-char DISPLAY cap, toolResultText) — a real multi-result Links array routinely
                // exceeds 500 chars, so ev.text alone would silently drop nearly every real search.
                const results = parseWebSearchLinks(ev.assertText ?? ev.text);
                if (results) this.rec.webSearches.push({ toolUseId: ev.toolUseId, query: pendingSearch, results });
                // A parse failure would otherwise erase the search silently — count it so parser drift is
                // visible in RunResult.evidenceErrors instead of vanishing.
                else this.rec.evidenceErrors.webSearchParse++;
              }
            }
            this.provenance.seedFromToolResult(ev.provenanceText ?? ev.text); // seed from the UNtruncated value so URLs past the display cap are still fetchable
            // (matches Cowork's tool_response provenance hook)
            // Delivery check: if this is the result of an answered gate and it ERRORED, the injected
            // answer never reached the model (the q.map class). Surface it in real time — "resp consumed"
            // (file read) is NOT "delivered" (model received).
            if (ev.isError && ev.toolUseId) {
              const gate = this.rec.gateAnswers.find((g) => g.toolUseId === ev.toolUseId);
              if (gate)
                warn(`::warning:: [gate] DELIVERY FAILED for "${gate.question}" → tool error: ${ev.text.split("\n")[0].slice(0, 120)}\n`);
            }
            break;
          }
          case "thinking":
            this.noteModel(ev.model);
            this.noteThinking(ev.text);
            break;
          case "subagent_dispatch":
            this.rec.subagents.push({
              toolUseId: ev.toolUseId,
              parentToolUseId: ev.parentToolUseId,
              agentType: ev.agentType,
              declaredTools: ev.declaredTools,
              toolsUsed: [],
              description: ev.description,
              prompt: ev.prompt,
              model: ev.model,
            });
            // An explicit Agent(subagent_type:"fork") inherits the main agent's context (unlike every
            // other dispatch type, which starts isolated) — so its children are main-agent flow. Still
            // push to rec.subagents unconditionally above, so dispatch_count_max stays unaffected.
            if (ev.agentType === "fork" && ev.toolUseId) this.forkScopedIds.add(ev.toolUseId);
            break;
          case "metrics":
            // merge, don't overwrite — a "result" event may have already set/will later set `usd`
            this.rec.cost = { ...this.rec.cost, raw: ev.data };
            break;
          case "decision":
            this.rec.transcript = transcript.join("\n");
            await this.handleDecision(ev.request);
            break;
          case "result":
            // Pass through the SDK subtype on BOTH branches (a diagnostic, not just an error signal) —
            // error_max_turns / error_during_execution on failure, success on the clean path.
            if (ev.subtype !== undefined) this.rec.resultSubtype = ev.subtype;
            // The SDK's designated final answer text (surfaced as RunResult.finalMessage). Kept even on
            // an is_error result — the result text often IS the diagnostic.
            if (ev.resultText !== undefined) this.rec.resultText = ev.resultText;
            if (ev.isError) {
              this.rec.result = "error";
              // path (a): the SDK wrapped a transport failure into an is_error result — the result IS the
              // signal (no prior-result gate). Classify off the SDK result payload + subtype.
              this.rec.resultErrorKind = classifyResultError(
                "result",
                `${ev.subtype ?? ""} ${ev.resultText ?? ""}`,
                sawSuccessResult,
                ev.apiErrorStatus,
              );
              this.rec.errorSource = "result";
            } else {
              this.rec.result = "success";
              sawSuccessResult = true;
            }
            // fold the SDK's num_turns into usage as `turns` (there is no dedicated turns
            // field) — only when there's something to report, so a bare `{isError:false}` result event
            // (still common in synthetic/older cassette events) leaves usage undefined, not a spurious {}.
            this.rec.usage =
              ev.usage || ev.numTurns !== undefined
                ? { ...ev.usage, ...(ev.numTurns !== undefined ? { turns: ev.numTurns } : {}) }
                : undefined;
            if (ev.costUsd !== undefined) this.rec.cost = { ...this.rec.cost, usd: ev.costUsd };
            if (ev.modelUsage) this.rec.modelUsage = ev.modelUsage;
            {
              const next = await turnIter.next();
              if (next.done) this.session.close();
              else {
                this.provenance.seedFromText(next.value); // seed provenance from each new user turn
                this.session.sendUserTurn(next.value);
              }
            }
            break;
          case "error":
            // spawn/protocol errors are fatal — set result, close the session, and stop the loop.
            // source:"agent" is non-terminal (the SDK may still emit a recovering `result` event).
            // CRITICAL: set rec.result BEFORE break — gateDeliveries mapping runs after the loop exits.
            //
            // source:"exit" is ALSO fatal. LiveAgentSession only emits an "exit" error for a
            // nonzero/signal child exit (session.ts: `signal || (code !== null && code !== 0)`) — a clean
            // exit:0 produces NO "exit" event — so there is no benign exit case to preserve here. This
            // event lands AFTER stdout closes, which means a successful turn already set rec.result =
            // "success" via the preceding `result` event; a nonzero exit after that result must override
            // it back to "error" (a child that crashes after printing a result is NOT a passing run). The
            // stderr tail is already embedded in ev.message by LiveAgentSession.
            if (ev.source === "spawn" || ev.source === "protocol" || ev.source === "exit") {
              this.rec.result = "error";
              // path (b): a nonzero EXIT after a clean result, with a transport stderr tail, is the
              // "tail-end drop after artifacts written" case → transport. spawn/protocol (and an exit with no
              // prior success / a non-transport crash tail) stay "agent" — a genuine fault.
              this.rec.resultErrorKind = classifyResultError(ev.source, ev.message, sawSuccessResult);
              this.rec.errorSource = ev.source;
              this.rec.decisions.push({ kind: "tool", name: ev.source, decision: "error", by: "agent", detail: ev.message });
              this.session.close();
              break outerLoop;
            }
            this.rec.errorSource ??= ev.source; // keep the first observed source; a later recovering result won't clear it
            this.rec.decisions.push({ kind: "tool", name: ev.source, decision: "error", by: "agent", detail: ev.message });
            break;
          case "system_event":
            this.rec.contextEvents.push({ subtype: ev.subtype, data: ev.data });
            break;
          case "infra_error":
            // An infrastructure crash contaminates the run's evidence — collect it as a both-lane hard
            // fail (computeVerdict), not author-suppressible. Re-derived on the replay drive from the frozen
            // events, so a recorded crash fails replay too.
            this.rec.infraErrors.push({ source: "sidecar", message: ev.message });
            break;
          case "mcp_error":
            this.rec.mcpErrors.push({ server: ev.server, code: ev.code, message: ev.message });
            break;
          case "hook_event":
            this.rec.hookEvents.push({ callbackId: ev.callbackId, decision: ev.decision, reason: ev.reason, tool: ev.tool });
            break;
        }
      }
    } finally {
      if (runTimer) clearTimeout(runTimer);
      // Guarantee stdin ends on EVERY exit path — including a clean EOF or a crash that emits no `result`
      // event (the inline close()s only cover result-done + spawn/protocol error). close() is idempotent
      // (it try/catches stdin.end), so the double-close on the normal paths is a safe no-op.
      this.session.close();
    }

    this.rec.transcript = transcript.join("\n");
    // Stream-end reconciliation: a TaskCreate / WebSearch whose tool_use was seen but whose paired
    // tool_result never arrived (stream truncated between use and result) stays in its pending map,
    // never reaching rec.tasks/rec.webSearches AND never bumping an evidenceError — so a dependent
    // assertion would evaluate the resolved SUBSET as if it were complete. Flush every still-pending
    // entry into the matching incomplete-evidence counter so task/search assertions fail "cannot verify
    // (incomplete)" (taskTracking gates all_tasks_completed / task_count_min / task_status) instead of
    // silently under-counting. #5
    this.rec.evidenceErrors.taskTracking += this.pendingTaskCreates.size;
    this.pendingTaskCreates.clear();
    this.rec.evidenceErrors.webSearchParse += this.pendingWebSearches.size;
    this.pendingWebSearches.clear();
    // Wall-clock timeout override: the kill above surfaces as an "exit" error (or ends the stream), but the
    // authoritative reason is the timeout. Set it here so it wins over the exit/no_result labeling below.
    if (timedOut) {
      this.rec.result = "error";
      this.rec.errorSource = "timeout";
    }
    // no-terminal-event detection (the reviewer's turn/time-exhaustion black box). This block runs only on
    // a clean loop-end — an UnansweredError from handleDecision throws PAST it (→ buildPartialResult), and
    // every terminal path already set errorSource (result → "result", fatal error → its source, non-fatal
    // agent error → "agent"). So `result` still at the ctor default "error" AND no errorSource means the
    // stream closed with no result and no error event at all. Diagnostic only; re-derives on replay (reads
    // only rec state), like the stall detector below.
    if (this.rec.result === "error" && !this.rec.errorSource) this.rec.errorSource = "no_result";
    // stall-on-question detection. A turn that ends on a plain-text re-ask ("which file?") gets
    // is_error:false → result:"success" (a false-green — the SDK turn didn't error, but the task didn't
    // complete). Flag it (computeVerdict turns it into a `stalled` fail unless allow_stall). Conservative
    // conjunction to keep the default-fail safe: (1) the run cleanly succeeded, (2) the FINAL top-level
    // assistant message is a question, and (3) NO productive tool ran AFTER the last gate.
    //
    // (3) is keyed on toolLog position, not "no tools at all": an AskUserQuestion gate arrives as a real
    // assistant tool_use block (→ toolLog; see toolCounts in any gated result.json), so a naive
    // `toolLog.length === 0` would miss the founder repro where the agent answered a gate, then re-asked
    // in plain text and stalled, having done productive work BEFORE the gate. So we slice toolLog AFTER the
    // last AskUserQuestion and count non-gate calls: zero ⇒ the agent waited on input and did nothing further.
    // With no gate, lastIndexOf === -1 → the slice is the whole log → this reduces to the exact "no tools at
    // all" behavior. The count includes parented(subagent)/synthetic entries (toolLog pushes unconditionally)
    // — they only RAISE the count, never a new false positive. on_unanswered owns the *unanswered* gate; this
    // owns the agent stalling AFTER an answered one. Reads only local/rec state, so it re-derives identically
    // on the replay re-drive. Scenario-lane only (one oneShot turn); the chat driver runs it but never reads
    // the flag (no computeVerdict), so it is inert there.
    const lastText = transcript.length > 0 ? transcript[transcript.length - 1].trim() : "";
    const lastGateIdx = this.toolLog.map((t) => t.name).lastIndexOf("AskUserQuestion");
    const productiveAfterGate = this.toolLog.slice(lastGateIdx + 1).filter((t) => t.name !== "AskUserQuestion").length;
    if (this.rec.result === "success" && lastText.endsWith("?") && productiveAfterGate === 0) {
      this.rec.stalledOnQuestion = true;
    }
    // pair each answered gate with its tool_result (by toolUseId). delivered=true iff a non-error
    // result was observed; false iff it errored; null if no result was observed (e.g. protocol
    // fidelity, or the run ended before the tool ran) — null is neutral for `gate_answers_delivered`.
    this.rec.gateDeliveries = this.rec.gateAnswers.map((g) => {
      // No toolUseId = no pairing metadata (distinct from "tool result not observed"). Both report
      // delivered:null but `reason` tells them apart so a missing pairing doesn't read as benign.
      if (!g.toolUseId) return { question: g.question, delivered: null, reason: "no-pairing-metadata" as const };
      const tr = this.rec.toolResults.find((r) => r.toolUseId === g.toolUseId);
      if (!tr) return { question: g.question, delivered: null, reason: "unobserved" as const };
      return {
        question: g.question,
        delivered: !tr.isError,
        reason: tr.isError ? ("errored" as const) : ("ok" as const),
        ...(tr.isError ? { error: tr.text.split("\n")[0].slice(0, 200) } : {}),
      };
    });
    this.denormalizeSubagentOutputs();
    this.foldRedundantToolCalls();
    for (const h of this.hooks) h.finalize?.(this.rec);
    return this.rec;
  }

  /** Resolves a pending `present_files` call (stashed by toolUseId at tool_use time) against its own
   *  tool_result: `textBlocks` carries the returned path per input file, IN ORDER (the pinned
   *  present_files contract — one text entry per input file). Zips `from` (input) with `to` (result)
   *  by index and classifies each pair against the VM cwd (`weA`, the scratchpad predicate):
   *    - `promoted`  — `from` was in the scratchpad AND `to` landed under `mnt/outputs/` (the handler's
   *      success branch).
   *    - `leaked`    — `from` was in the scratchpad but `to` did NOT land there (the handler's
   *      copy-failure branch — the file "remains in the scratchpad").
   *    - neither     — `from` was already under a mount (passthrough); nothing to promote or leak.
   *  Without `rec.cwd` (an init event that predates it, or a MockSession test that omits init),
   *  `isScratchpad` returns false for every path — fail-safe toward "nothing classified" rather than a
   *  fabricated promoted/leaked verdict. A result with fewer entries than inputs pairs what it can and
   *  drops the unmatched tail (never guesses a `to`). */
  private notePresentedFiles(toolUseId: string, textBlocks: string[] | undefined): void {
    const froms = this.pendingPresentFiles.get(toolUseId);
    if (!froms) return;
    this.pendingPresentFiles.delete(toolUseId);
    const tos = textBlocks ?? [];
    const cwd = this.rec.cwd;
    // Without cwd we CANNOT classify any presented path as scratchpad-or-not, so every file below would
    // be recorded leaked:false — a silently permissive pass. Count it as incomplete leak telemetry so
    // no_scratchpad_leak fails "cannot verify" instead of vacuously green (the from/to are still recorded
    // for forensics; only the promoted/leaked booleans are unreliable in this case). #14
    if (cwd === undefined && froms.length > 0) this.rec.evidenceErrors.presentFilesMalformed += froms.length;
    const isScratchpad = (p: string): boolean => cwd !== undefined && p.startsWith(`${cwd}/`) && !p.startsWith(`${cwd}/mnt/`);
    for (let i = 0; i < froms.length; i++) {
      const from = froms[i];
      const to = tos[i];
      if (to === undefined) continue;
      const scratchpad = isScratchpad(from);
      const promoted = scratchpad && cwd !== undefined && to.startsWith(`${cwd}/mnt/outputs/`);
      const leaked = scratchpad && !promoted;
      this.rec.presentedFiles.push({ from, to, promoted, leaked });
    }
  }

  /** Pairs each subagent dispatch's toolUseId against rec.toolResults to populate its `output`
   *  (the dispatch's own return value) — mirrors the gate-delivery pairing pattern above. */
  private denormalizeSubagentOutputs(): void {
    for (const sa of this.rec.subagents) {
      const tr = this.rec.toolResults.find((r) => r.toolUseId === sa.toolUseId);
      if (tr) {
        sa.output = tr.assertText ?? tr.text;
        // Mark truncation so subagent_output_contains reports "cannot verify" (not a false absence) when
        // the searched substring could lie past the assert-cap cut. #9
        if (tr.assertTextTruncated) sa.outputTruncated = true;
      }
    }
  }

  private async handleDecision(req: DecisionRequest) {
    if (req.kind === "question") for (const q of req.questions) this.rec.questions.push(questionLabel(q));

    // an empty `questions` array would be "answered" with `{}` (scripted) and recorded as success —
    // a silent false-green. The in-VM schema enforces `questions.min(1)` so the model can't emit this
    // (ELF-verified, asar/ELF 2.1.170), but a hand-crafted cassette / fuzz input could. Fail LOUD.
    if (req.kind === "question" && req.questions.length === 0)
      throw new UnansweredError(
        "AskUserQuestion gate has an empty `questions` array — there is nothing to answer",
        "a gate must carry at least one question (the in-VM AskUserQuestion schema enforces questions.min(1))",
      );

    // A header-only gate (no `question` text) has an empty answer key — the in-VM handler indexes by
    // `question`, so the injected answer could never be delivered. Fail LOUD instead of silently no-oping.
    if (req.kind === "question") {
      const headerOnly = req.questions.filter((q) => !questionKey(q));
      if (headerOnly.length)
        throw new UnansweredError(
          "AskUserQuestion gate has a question with no `question` text (header-only) — the in-VM handler indexes answers by `question`, so it cannot be delivered",
          "the gate must carry a non-empty `question` (header alone is a display label, not the answer key)",
        );
    }

    // multiSelect gates ARE supported (binary-verified 2026-06-17): the answer wire-shape is a comma-joined
    // string (`answers[q]` = "Label A, Label B"). The ScriptedDecider validates each member against the
    // offered options and joins; fallback terminals answer with a single (valid) member.

    const decided = await this.withDialogTimeout(req, this.decider.decide(req, this.ctx()));
    if (decided === ABSTAIN) {
      // A QUESTION must NEVER be silently answered with option 1 (the worst failure mode: a wrong-branch
      // run that still prints ✓ success). If no terminal answered it, fail LOUD. (Permission/dialog/elicit
      // fail CLOSED — deny/cancel/decline — which is the correct safe default, not a fabricated answer.)
      if (req.kind === "question") {
        const q = req.questions[0] ? questionLabel(req.questions[0]) : "";
        throw new UnansweredError(
          `no decider answered the question "${q}" (terminal returned ABSTAIN — never silently default to option 1)`,
          'add a scripted --answer "<rx>=<choice>", an --answer-policy/--decider-cmd, or --on-unanswered fail|first',
        );
      }
      const fallback = denyLike(req);
      this.session.respond(req.id, fallback);
      this.rec.decisions.push({ kind: kindOf(req), name: nameOf(req), decision: "abstain→deny", by: "none" });
      return;
    }
    const delivery = this.session.respond(req.id, decided.response);
    if (!delivery.delivered) {
      // The answer never reached the agent — the session was already draining when respond() ran
      // (a decider answer racing teardown). Record the TRUTH, not "answered": a false "answered" here
      // would let the run read as if the gate was satisfied when the agent never got the frame. #20
      this.rec.decisions.push({
        kind: kindOf(req),
        name: nameOf(req),
        decision: "undelivered",
        by: decided.by,
        rationale: `answer not delivered (${delivery.reason ?? "unknown"})`,
      });
    } else if (isDecisionKindMismatch(req, decided.response, "permission")) {
      // serializeDecision rewrites a kind-mismatched response to a deny envelope (session.ts) — the agent
      // did NOT get the intended answer. Record the TRUTH ("mismatch→deny"), not "answered", and skip the
      // gateAnswers push (no answer was delivered). ✓ success ≠ correct. (the mismatch detection +
      // warning is the SHARED helper that the synthetic web_fetch path also uses.)
      this.rec.decisions.push({
        kind: kindOf(req),
        name: nameOf(req),
        decision: "mismatch→deny",
        by: decided.by,
        rationale: "decider returned a mismatched response kind",
      });
    } else {
      this.recordDecision(req, decided.response, decided.by, decided.rationale, decided.model);
    }
  }

  /** request_user_dialog has a host ~6s auto-cancel — race the decider against it. The window is
   *  relaxed under an external/prompt decider (the caller is authoritative; see execute.ts). */
  private async withDialogTimeout<T>(req: DecisionRequest, p: Promise<T>): Promise<T | typeof ABSTAIN> {
    if (req.kind !== "dialog" || !isFinite(this.dialogTimeoutMs)) return p;
    let t: ReturnType<typeof setTimeout>;
    const timeout = new Promise<typeof ABSTAIN>((res) => (t = setTimeout(() => res(ABSTAIN), this.dialogTimeoutMs)));
    // use .finally() so clearTimeout runs on BOTH resolve AND reject, preventing a timer
    // leak when the decider promise rejects (the race rejects but the setTimeout stays alive).
    return Promise.race([p.finally(() => clearTimeout(t)), timeout]);
  }

  // Typed: `resp` is the discriminated DecisionResponse and `by` is the Decision["by"] union (a typo'd
  // attribution is now a compile error). resp fields are read via resp.kind narrowing; req fields via req.
  private recordDecision(req: DecisionRequest, resp: DecisionResponse, by: Decision["by"], rationale?: string, model?: string) {
    if (req.kind === "question") {
      const answers = resp.kind === "question" ? resp.answers : {};
      this.rec.decisions.push({
        kind: "question",
        name: "AskUserQuestion",
        decision: "answered",
        by,
        requestId: req.id, // for id-keyed pairing in `trace --view questions` (not positional)
        model,
        detail: answers,
        rationale,
        questions: req.questions,
      });
      // For the human-readable label, include ALL questions — not just questions[0]. Single-question gates
      // produce "<question>"; multi-question gates produce "<q1> / <q2>". The answers map is already complete.
      const label = req.questions.map(questionLabel).filter(Boolean).join(" / ") || "";
      // Record the answered gate (with its toolUseId) so finalize can pair it with the tool_result to
      // verify the answer actually reached the model. Independent of `by` — delivery ≠ attribution.
      this.rec.gateAnswers.push({ question: label, toolUseId: req.toolUseId, answers });
      for (const [question, chosen] of Object.entries(answers)) {
        if (by !== "scripted") this.rec.unanswered.push({ question, chosen: String(chosen), by, rationale, model });
      }
    } else if (req.kind === "permission") {
      const behavior = resp.kind === "permission" ? resp.behavior : undefined;
      // On a DENY, surface WHICH invocation was blocked (e.g. the exact Bash command), not just the tool
      // name. The input rides through the same record-time scrub as every other captured value; cap it so
      // a large input can't bloat the record. Allow keeps detail unset (the input isn't diagnostic there).
      const detail = behavior === "deny" ? { input: capDecisionInput(req.input) } : undefined;
      this.rec.decisions.push({ kind: "tool", name: req.tool, decision: behavior ?? "?", by, rationale, detail });
      // A cowork-parity off-registry auto-allow is a SILENT false-green risk — real Cowork blocks for the
      // user. Make it loud (stderr) AND machine-distinguishable (rec.permissiveAutoAllow → the envelope),
      // so a green carrying one isn't mistaken for a faithful pass.
      if (behavior === "allow" && by === "cowork" && rationale === PERMISSIVE_AUTOALLOW_RATIONALE) {
        this.rec.permissiveAutoAllow.push(req.tool);
        warn(
          `::warning:: [permission] "${req.tool}" auto-allowed by cowork parity (unscripted, off-registry) — real Cowork would BLOCK for the user. Not a faithful pass; pin with --answer or set permission_parity: strict.\n`,
        );
      }
    } else {
      const outcome = resp.kind === "dialog" ? resp.behavior : resp.kind === "elicit" ? resp.action : "?";
      this.rec.decisions.push({ kind: req.kind, name: req.kind, decision: outcome, by, rationale });
    }
  }

  // ── web_fetch provenance, exposed to the workspace handler (via the bundle execute.ts builds) ──

  /** Pre-approve web_fetch hosts for this run (test convenience: `web_fetch.approved_domains`) — as if
   *  "Allow all for website" had been clicked earlier this session. Per-run only (no persistence).
   *
   * each seed goes through the SAME `validateBareDomain` policy as the egress proxy's
   *  `compile()`, then `normalizeHost`, so an empty string / URL / scheme / path / port can no longer be
   *  admitted as an entry that could never match a bare fetch host. Invalid seeds THROW (consistent with
   *  `compile()` — fail loud, not silently warn-and-skip). A seed "domain" is matched by exact host
   *  equality (`approvedDomains.has(normalizeHost(domain))` in requestWebFetchApproval), so a `*` /
   *  `*.suffix` WILDCARD is meaningless here and is rejected — provenance approval is per concrete host.
   *  (The IPv6/punycode/wildcard normalization deferrals documented on `normalizeHost` still apply.) */
  seedApprovedDomains(domains: string[]): void {
    for (const d of domains) {
      const v = validateBareDomain(d); // throws on empty / scheme / path / port / whitespace
      if (v.kind !== "exact")
        throw new Error(
          `invalid web_fetch approved_domains entry "${d}" — use a concrete host, not a "${v.kind === "all" ? "*" : "*.suffix"}" wildcard`,
        );
      this.approvedDomains.add(normalizeHost(v.value));
    }
  }

  /** Is this URL already in the session's provenance set? */
  provenanceHas(url: string): boolean {
    return this.provenance.has(url);
  }

  /** Mark a URL allowed (after an approval / permissive bypass) — sticky for the session. */
  provenanceAdd(url: string): void {
    this.provenance.add(url);
  }

  /**
   * Harness-initiated web_fetch approval for a provenance miss — a synthetic `webfetch:<domain>`
   * permission routed through the SAME Decider and RECORDED in rec.decisions (so it shows in
   * result.decisions and flips nonDeterministic when answered by agent/external/human). Mirrors
   * Cowork's host-initiated handleToolPermission(`webfetch:${domain}`, {domain,url}). This does NOT
   * go through handleDecision (no agent control_request exists for the synthetic id), so it resolves
   * ABSTAIN→deny explicitly and never calls session.respond.
   */
  async requestWebFetchApproval(domain: string, url: string): Promise<boolean> {
    // Per-run "Allow all for website" grant: an already-approved host fetches with NO gate and records
    // nothing (a 2nd fetch to an approved host does not re-prompt). Checked BEFORE the decider.
    // Normalize both sides so "Example.com" and "example.com" match the same stored entry.
    if (this.approvedDomains.has(normalizeHost(domain))) return true;
    const req: DecisionRequest = {
      id: `webfetch-${randomUUID()}`,
      kind: "permission",
      tool: `webfetch:${domain}`,
      input: { domain, url },
      options: [{ label: "Allow once" }, { label: "Allow all for website" }, { label: "Deny" }],
    };
    const d = await this.decider.decide(req, this.ctx());
    // "fail" conflated the FailDecider class with the internal abstain-fallback path. Use a distinct
    // provenance value so readers can tell "no decider answered" apart from an explicit FailDecider deny.
    const by = d === ABSTAIN ? "abstain-fallback" : d.by;
    // Pass the RESPONSE BODY + by (recordDecision reads resp.behavior) — not the whole Decision.
    const resp: DecisionResponse =
      d === ABSTAIN ? { kind: "permission", behavior: "deny", message: "no decider answer (fail-closed)" } : d.response;
    // mirror handleDecision's mismatched-kind guard. A decider that answers a "permission" request
    // with a non-permission response is a protocol error — previously this recorded `decision:"?"` (via
    // recordDecision's behavior===undefined branch) with NO warning. Record `mismatch→deny`, warn loudly,
    // and DENY the fetch (fail-closed), instead of silently treating it as "?".
    if (d !== ABSTAIN && isDecisionKindMismatch(req, resp, "webfetch")) {
      this.rec.decisions.push({
        kind: kindOf(req),
        name: nameOf(req),
        decision: "mismatch→deny",
        by,
        rationale: "decider returned a mismatched response kind",
      });
      return false;
    }
    const allow = resp.kind === "permission" && resp.behavior === "allow";
    const grant = resp.kind === "permission" ? resp.grant : undefined;
    this.recordDecision(req, resp, by);
    // "Allow all for website" → approve the host for the rest of the run (off-wire; Run-side state).
    if (allow && grant === "domain") this.approvedDomains.add(normalizeHost(domain));
    return allow;
  }
}

/** shared decision-kind validation. A decider response whose `kind` differs from the request's is a
 *  protocol mismatch — the agent would receive a safe deny (serializeDecision rewrites it), NOT the intended
 *  answer. Return true + WARN loudly so neither the normal-permission path (handleDecision) nor the synthetic
 *  web_fetch path (requestWebFetchApproval) can silently record a mismatched response as if it were honored. */
function isDecisionKindMismatch(req: DecisionRequest, resp: DecisionResponse, context: string): boolean {
  if (resp.kind === req.kind) return false;
  warn(
    `::warning:: [${context}] decider returned kind "${resp.kind}" for a "${req.kind}" request (${nameOf(req)}) → mismatch→deny; the agent did NOT receive the intended answer\n`,
  );
  return true;
}

function kindOf(req: DecisionRequest): DecisionRecord["kind"] {
  return req.kind === "permission" ? "tool" : (req.kind as DecisionRecord["kind"]);
}
function nameOf(req: DecisionRequest): string {
  return req.kind === "permission" ? req.tool : req.kind === "question" ? "AskUserQuestion" : req.kind;
}
function denyLike(req: DecisionRequest): any {
  if (req.kind === "permission") return { kind: "permission", behavior: "deny", message: "no decider" };
  if (req.kind === "dialog") return { kind: "dialog", behavior: "cancelled" };
  if (req.kind === "elicit") return { kind: "elicit", action: "decline" };
  // A question must never reach here — handleDecision fails loud above. Defense in depth: never
  // fabricate an option-1 answer for a question.
  throw new UnansweredError("internal: a question reached the deny fallback", "this is a bug — a question must be answered or fail loud");
}

async function* oneShot(s: string): AsyncGenerator<string> {
  yield s;
}
