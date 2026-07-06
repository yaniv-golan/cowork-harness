import { z } from "zod";
import { warn } from "../io.js";
import { createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";
import readline from "node:readline";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { TimelineWriter } from "./timeline.js";

/**
 * AgentSession: the stream-json control protocol over a runtime-provided child.
 * Owns ONLY the protocol (not the container, not teardown). Emits a typed `AgentEvent`
 * stream; the consumer answers `decision` events via `respond()` and drives turns via
 * `sendUserTurn()`. `close()` is the sole place stdin ends.
 *
 * Records BOTH directions for cassettes: child→driver stdout → `events.jsonl`, and the
 * driver→child control_responses we write to stdin → `control-out.jsonl` (the half that
 * was previously unrecorded).
 */

// ---- Decision channels (the agent's out-of-band asks; Ch25/L108 widened these) ----
export interface QSpec {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}
export type DecisionRequest =
  // `options` is OFF-WIRE (web_fetch approval is host-synthesized): the grant-scope choices a decider
  // answers with for a `webfetch:<domain>` gate. Absent for ordinary agent permissions (binary allow/deny).
  | { id: string; kind: "permission"; tool: string; input: Record<string, unknown>; options?: { label: string; description?: string }[] }
  // toolUseId (the `toolu_…` id, distinct from the UUID `id`/request_id) pairs this gate with its
  // tool_result for delivery verification + `trace --gates`.
  | { id: string; kind: "question"; questions: QSpec[]; toolUseId?: string }
  | { id: string; kind: "dialog"; dialogKind: string; payload: unknown } // request_user_dialog (~6s auto-cancel)
  | { id: string; kind: "elicit"; server?: string; prompt?: string; schema?: unknown }; // elicitation / side_question
export type DecisionResponse =
  // `grant` is a WEB_FETCH-LOCAL, OFF-WIRE field (once = this fetch only; domain = approve the whole host
  // for the run). web_fetch approval is host-synthesized (Run.requestWebFetchApproval) and never serialized,
  // so `grant` must NEVER reach serializeDecision — a guard there throws if it does (catches a future
  // refactor that routes web_fetch through the wire, where serialize would silently drop it).
  | { kind: "permission"; behavior: "allow" | "deny"; updatedInput?: unknown; message?: string; grant?: "once" | "domain" }
  | { kind: "question"; answers: Record<string, string> }
  | { kind: "dialog"; behavior: "ok" | "cancelled"; choice?: unknown }
  | { kind: "elicit"; action: "accept" | "decline" | "cancel"; content?: unknown };

export type AgentEvent =
  | { type: "init"; tools: string[]; mcpServers: unknown[]; skills: string[]; cwd?: string }
  | { type: "assistant_text"; text: string; parentToolUseId?: string; model?: string }
  | { type: "tool_use"; name: string; input: unknown; parentToolUseId?: string; toolUseId?: string; synthetic?: boolean; model?: string } // toolUseId for tool_use↔tool_result pairing; synthetic = the MCP round-trip echo (trace-only, NOT counted — the real call already arrives as an assistant tool_use block, live-verified); model = the assistant message's model
  | { type: "tool_result"; toolUseId?: string; isError: boolean; text: string; provenanceText?: string; assertText?: string } // the OUTCOME of a tool call (from `user`/tool_result blocks). `text` is display-truncated; `provenanceText` is the larger raw value so URLs past the display cap still seed web_fetch provenance; `assertText` is assertion-fidelity cap (10 KB)
  | {
      type: "subagent_dispatch";
      toolUseId: string;
      parentToolUseId?: string;
      agentType: string;
      declaredTools: string[];
      description?: string;
      prompt?: string; // input.prompt, assertText-capped
      model?: string; // the dispatching message's model
    } // parentToolUseId = nesting, for the dispatch tree.
  | { type: "thinking"; text: string; model?: string } // model set only when this thinking block came from an assistant message (not the system-subtype "thinking" event, which has no message.model)
  | { type: "metrics"; data: Record<string, unknown> } // api_metrics → cost
  | { type: "decision"; request: DecisionRequest }
  | {
      type: "result";
      isError: boolean;
      usage?: Record<string, unknown>;
      resultText?: string;
      subtype?: string; // resultText/subtype carry the SDK result payload so a transport-error result can be classified
      costUsd?: number; // SDK's total_cost_usd for this invocation (was dropped on the floor before)
      numTurns?: number; // SDK's num_turns for this invocation (was dropped on the floor before)
      // per-model cost/token breakdown, cumulative for the whole run — a TOP-LEVEL sibling of `usage` on
      // the raw result message, NOT nested inside it (empirically confirmed against a real captured
      // stream). Opaque per-entry shape (SDK-owned); RunResult types it more precisely.
      modelUsage?: Record<string, Record<string, unknown>>;
    }
  | { type: "error"; source: "spawn" | "agent" | "protocol" | "exit"; message: string }
  | { type: "raw"; line: string };

export type SdkMcp = {
  servers: string[];
  // handle is async — web_fetch may await a provenance approval through the Decider.
  handle: (
    server: string,
    jsonrpc: any,
  ) =>
    | Promise<{ result?: unknown; error?: { code: number; message: string } }>
    | { result?: unknown; error?: { code: number; message: string } };
};

/**
 * A caller-supplied PreToolUse hook bundle, threaded through `AgentSession.init/start` opts exactly like
 * `sdkMcp` (mirrors that existing pattern so this protocol layer never learns what "allowedRoots" means
 * — no policy leaks in here). `definitions` is merged onto the ALWAYS-installed `COWORK_PRETOOLUSE_HOOKS`
 * in the `initialize` control_request; `handle` is consulted for any `hook_callback` whose `callback_id`
 * isn't one of the built-in ids. Used by hostloop's path-containment gate — the harness's only current caller.
 */
export interface HookBundle {
  definitions: { PreToolUse: Array<{ matcher: string; hookCallbackIds: string[] }> };
  handle: (callbackId: string, input: any) => Promise<Record<string, unknown>> | Record<string, unknown>;
}

export interface AgentSession {
  /** write `initialize` before the first user turn (idempotent; `start()` also calls it).
   *  Optional — replay sessions (cassette) have no live control channel and omit it. */
  init?(opts?: { subagentAppend?: string; sdkMcp?: SdkMcp; hooks?: HookBundle }): void;
  start(opts?: { subagentAppend?: string; sdkMcp?: SdkMcp; hooks?: HookBundle }): AsyncIterable<AgentEvent>;
  sendUserTurn(text: string): void;
  respond(decisionId: string, r: DecisionResponse): void;
  close(): void;
}

// ---- Protocol ingress validation (fail-closed) ----
/** Every control_request that the driver answers carries a non-empty string `request_id` — it is the
 *  address the control_response is written back to. A missing / non-string / empty id means the agent sent
 *  a malformed control frame; reject LOUDLY rather than echoing an unusable id into a response envelope
 *  (which the in-VM agent could never match → it blocks until timeout). Shared by every control-request
 *  branch (mcp_message, hook_callback, decision) so none can drift into trusting an unchecked id. */
export function requireRequestId(msg: any): string {
  if (typeof msg?.request_id !== "string" || msg.request_id === "")
    throw new Error(`control-in: malformed request_id: ${JSON.stringify(msg?.request_id)}`);
  return msg.request_id;
}

/** The AskUserQuestion control-request body was previously cast to QSpec[] with no runtime check,
 *  so a malformed control frame (questions not an array, options missing, label not a string) flowed into
 *  the deciders as trusted data and could crash or fabricate answers. Validate the supported question body
 *  shape at protocol ingress and convert a malformed frame into a typed protocol error. */
const OptionSchema = z.looseObject({ label: z.string(), description: z.string().optional() });
// `question` and `options` are OPTIONAL here ON PURPOSE. The runtime already tolerates both being absent:
// optionless / free-text gates are handled by the deciders (`q.options?.map(...) ?? []`), and a
// header-only gate with no `question` text gets a SPECIFIC loud diagnostic in Run (run.ts). Requiring them
// here would reject those real shapes at protocol ingress with a generic error, defeating the sibling fixes
// (a real optionless / header-only frame would crash the live run or false-fail replay). Its job is to
// reject TRULY malformed bodies — `questions` not an array, or an option present but missing a string
// `label` — not to be stricter than the protocol the deciders already accept.
const QSpecSchema = z.looseObject({
  question: z.string().optional(),
  header: z.string().optional(),
  options: z.array(OptionSchema).optional(),
  multiSelect: z.boolean().optional(),
});
const QuestionsSchema = z.array(QSpecSchema);

// ---- Control-response envelopes (verified zod shape; the inner `response` nesting is load-bearing) ----
/** The one success-envelope shape every control_response shares; the four builders below differ ONLY in
 *  the inner `body`. Keeping a single core stops the wrapper drifting between them.
 *  Exported (in addition to the four builders) so protocol-conformance tooling — e.g. the golden
 *  vector generator — can wrap `hookOutput()`'s bare body in the real envelope instead of hand-rolling
 *  a lookalike; it has no other external callers. */
export function successEnvelope(requestId: string, body: Record<string, unknown>) {
  return { type: "control_response", response: { subtype: "success", request_id: requestId, response: body } };
}
export function allowEnvelope(requestId: string, updatedInput: Record<string, unknown>) {
  return successEnvelope(requestId, { behavior: "allow", updatedInput });
}
export function denyEnvelope(requestId: string, message: string) {
  return successEnvelope(requestId, { behavior: "deny", message });
}
export function mcpResponseEnvelope(
  requestId: string,
  payload: { result?: unknown; error?: unknown } | Record<string, never>,
  id: unknown,
) {
  return successEnvelope(requestId, id !== undefined && id !== null ? { mcp_response: { jsonrpc: "2.0", id, ...payload } } : {});
}
const dialogEnvelope = successEnvelope;

// ---- PreToolUse hooks (the harness mirrors Cowork's host-installed hooks) ----
// Binary-verified (app.asar 1.12603.1): in cowork mode the host installs a PreToolUse `Task` hook that
// blocks `run_in_background` ("Background agents disabled"). Over the stream-json transport, `initialize`
// declares `hooks: {PreToolUse:[{matcher, hookCallbackIds:[id]}]}`; when the hook fires the agent sends a
// `control_request {subtype:"hook_callback", callback_id, input, tool_use_id}` and we reply with a
// success control_response carrying the hook output ({decision:"block",…} or {} to allow). The hook is
// evaluated in the agent loop → tier-uniform (container/microvm/host-loop) by construction.
const TASK_BG_HOOK_ID = "cowork-task-bg-block";
/** The PreToolUse hooks the harness installs in cowork mode (sent on `initialize`). */
export const COWORK_PRETOOLUSE_HOOKS = { PreToolUse: [{ matcher: "Task", hookCallbackIds: [TASK_BG_HOOK_ID] }] };
/** Pure output for a fired hook callback. Unknown ids → no-op (allow); the only installed hook blocks
 *  `Task` with `run_in_background` to match Cowork's verbatim reason string. */
export function hookOutput(callbackId: string, input: any): Record<string, unknown> {
  if (callbackId === TASK_BG_HOOK_ID && input?.tool_input?.run_in_background) {
    return { decision: "block", reason: "Background agents disabled" };
  }
  return {};
}

/** The key the in-VM AskUserQuestion handler indexes answers by — it does
 *  `questions.map(({question}) => answers[question])`, so the answer map MUST be keyed by `question`,
 *  never `header`. (A header-only gate has an empty key; the run loop rejects it loud.) */
export function questionKey(q: QSpec): string {
  return q.question ?? "";
}
/** Human-readable label for records/traces/regex-matching — falls back to `header` for display only. */
export function questionLabel(q: QSpec): string {
  return q.question || q.header || "";
}

/** Serialize a DecisionResponse to the wire envelope for a given request. */
export function serializeDecision(req: DecisionRequest, r: DecisionResponse): Record<string, unknown> {
  if (req.kind === "permission" && r.kind === "permission") {
    // Off-wire pin: a web_fetch grant must never be serialized (web_fetch approval is host-synthesized and
    // never hits the wire). If a grant-bearing permission reaches here, a refactor routed web_fetch through
    // the protocol — fail loud rather than silently drop `grant`.
    if (r.grant !== undefined)
      throw new Error("serializeDecision: a web_fetch `grant` permission must not be serialized (it is off-wire by construction)");
    return r.behavior === "allow"
      ? allowEnvelope(req.id, (r.updatedInput as Record<string, unknown>) ?? req.input)
      : denyEnvelope(req.id, r.message ?? "denied");
  }
  if (req.kind === "question" && r.kind === "question") {
    // AskUserQuestion: the binary's BUILT-IN handler (enabled in cowork mode) executes with this
    // updatedInput and does `questions.map(({question}) => answers[question])` to build the tool_result
    // (ELF-verified: `mapToolResultToToolResultBlockParam`). So updatedInput MUST carry the full input —
    // `questions` AND `answers`. Dropping `questions` → `undefined is not an object (evaluating 'q.map')`,
    // the answer never reaches the model, and gate-steering silently no-ops.
    return allowEnvelope(req.id, { questions: req.questions, answers: r.answers });
  }
  if (req.kind === "dialog" && r.kind === "dialog") {
    return dialogEnvelope(req.id, r.behavior === "ok" ? { behavior: "ok", choice: r.choice } : { behavior: "cancelled" });
  }
  if (req.kind === "elicit" && r.kind === "elicit") {
    return dialogEnvelope(req.id, { action: r.action, ...(r.content !== undefined ? { content: r.content } : {}) });
  }
  // mismatched kinds → safe cancel/deny
  return denyEnvelope(req.id, "decider returned a mismatched response kind");
}

// ---- Canonical-JSON comparator (for the replay guard) ----
/** Recursively sort object keys then JSON.stringify — normalises insertion-order differences so a
 *  semantically-identical key reorder does NOT produce a false mismatch in the replay guard.
 *  `undefined`-valued keys are dropped by stringify, so absent-vs-undefined still normalises. */
export function canon(x: unknown): string {
  if (x === null || typeof x !== "object") return JSON.stringify(x);
  if (Array.isArray(x)) return "[" + x.map(canon).join(",") + "]";
  const sorted = Object.keys(x as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => {
      const v = (x as Record<string, unknown>)[k];
      if (v !== undefined) acc[k] = v;
      return acc;
    }, {});
  return (
    "{" +
    Object.entries(sorted)
      .map(([k, v]) => JSON.stringify(k) + ":" + canon(v))
      .join(",") +
    "}"
  );
}

/** Declared inverse of `serializeDecision` — kept adjacent with a pinning comment.
 *  Input = the `response.response` body from a recorded `control_response` success envelope.
 *  Output = the `DecisionResponse` the live decider originally produced.
 *  Keyed on the LIVE `req.kind` (not the body) to stay consistent with `serializeDecision`.
 *
 *  MUST NOT route through `serializeDecision` — that would make the replay guard circular (the
 *  re-serialize-and-compare check in CassetteAgentSession.respond() would always match). */
export function deserializeDecision(req: DecisionRequest, body: Record<string, unknown>): DecisionResponse {
  if (req.kind === "permission") {
    if (body.behavior === "deny") {
      return { kind: "permission", behavior: "deny", message: String(body.message ?? "denied") };
    }
    // allow: recover updatedInput (may be req.input due to lossy default in serializeDecision:88)
    if (body.behavior === "allow") return { kind: "permission", behavior: "allow", updatedInput: body.updatedInput };
    // Any OTHER permission body ({}, {behavior:"cancelled"}, garbage — a corrupt/truncated cassette) must
    // NOT silently replay as allow. Map to a deny that will NOT re-serialize to the recorded body, so the
    // guard in respond() trips a loud replay_protocol_fidelity mismatch. Mirrors the elicit branch's
    // known-action validation below (declared-inverse symmetry).
    return { kind: "permission", behavior: "deny", message: "deserializeDecision: invalid permission behavior" };
  }
  if (req.kind === "question") {
    // AskUserQuestion: body is { behavior:"allow", updatedInput:{ questions, answers } }
    // We read `answers` back; `questions` was preserved in recording for the guard.
    // Validate `answers` instead of a blind cast — a non-object, array, or answers map with
    // non-string values coerces to {} which will NOT re-serialize to the recorded body, so the
    // replay_protocol_fidelity guard trips loud rather than silently coercing corrupt data.
    const ui = (body.updatedInput ?? {}) as Record<string, unknown>;
    const raw = ui.answers;
    const isValidAnswers =
      raw !== null &&
      typeof raw === "object" &&
      !Array.isArray(raw) &&
      Object.values(raw as Record<string, unknown>).every((v) => typeof v === "string");
    return { kind: "question", answers: isValidAnswers ? (raw as Record<string, string>) : {} };
  }
  if (req.kind === "dialog") {
    return {
      kind: "dialog",
      behavior: body.behavior === "ok" ? "ok" : "cancelled",
      ...(body.behavior === "ok" && body.choice !== undefined ? { choice: body.choice } : {}),
    };
  }
  if (req.kind === "elicit") {
    // validate against the known action set instead of an unchecked `as` cast. A recorded
    // action that is missing or unrecognized (a corrupt/truncated cassette) maps to "decline" — a
    // value that will NOT re-serialize back to the corrupt input, so the guard in respond()
    // trips a loud replay_protocol_fidelity mismatch rather than silently coercing. A valid
    // "accept"/"cancel"/"decline" passes through and round-trips byte-identically.
    const raw = body.action;
    const action: "accept" | "decline" | "cancel" = raw === "accept" || raw === "cancel" ? raw : "decline";
    return {
      kind: "elicit",
      action,
      ...(body.content !== undefined ? { content: body.content } : {}),
    };
  }
  // fallback: deny-like
  return { kind: "permission", behavior: "deny", message: "deserializeDecision: unknown req kind" };
}

/** the largest control-out frame we mirror verbatim into control-out.jsonl. A frame above this
 *  cannot be faithfully recorded (a truncation marker is unreplayable), so we fail the live recording
 *  rather than freeze an unreplayable cassette. */
export const CONTROL_OUT_MIRROR_CAP = 256 * 1024;

export class LiveAgentSession implements AgentSession {
  private events: WriteStream;
  private controlOut: WriteStream;
  private timeline: TimelineWriter;
  private lineIndex = 0;
  private reqById = new Map<string, DecisionRequest>();
  private sdkMcp?: SdkMcp;
  private hookBundle?: HookBundle;
  private initWritten = false;
  /** Reject function set when proc emits an error — bridges the callback into the async generator.
   *  Set before the generator loop starts; called at most once (the Promise settles once). */
  private rejectError?: (e: Error) => void;
  /** Bounded tail of the child's stderr, for the nonzero-exit error message. */
  private stderrTail = "";
  private writeQueue: string[] = [];
  private pumping = false;
  private queueIdle?: () => void;
  private closing = false;

  constructor(
    private proc: ChildProcessByStdio<Writable, Readable, Readable>,
    private outDir: string,
  ) {
    this.events = createWriteStream(join(outDir, "events.jsonl"), { flags: "a" });
    this.controlOut = createWriteStream(join(outDir, "control-out.jsonl"), { flags: "a" });
    this.timeline = new TimelineWriter(outDir);
    const errLog = createWriteStream(join(outDir, "agent.stderr.log"), { flags: "a" });
    this.proc.stderr.pipe(errLog);
    // keep a bounded stderr tail and capture the exit code/signal so a child that dies nonzero
    // (with no structured {type:"result"} error) is surfaced as a typed error event, not a silent stop.
    this.proc.stderr.on("data", (d) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-2000);
    });
    // attach stdin error listener once at construction so dead-child writes don't produce
    // unhandled process errors. Routes to the same error path as spawn errors when possible.
    this.proc.stdin.on("error", (e) => {
      if (this.rejectError) this.rejectError(e);
      // else: the error fired before/after the generator — log it but don't throw
      else if (!this.closing) this.events.write(JSON.stringify({ _emu: "stdin_error", message: String(e) }) + "\n");
    });
  }

  /**
   * Write the `initialize` control_request (idempotent). `Run.drive` calls this BEFORE the first
   * `sendUserTurn` so the wire order matches the SPEC (initialize precedes the user turn); `start()`
   * also calls it so a standalone `start()` (no prior `init`) still initializes. Guarded so the two
   * call sites never double-write init-1.
   */
  init(opts: { subagentAppend?: string; sdkMcp?: SdkMcp; hooks?: HookBundle } = {}): void {
    if (this.initWritten) return;
    this.initWritten = true;
    this.sdkMcp = opts.sdkMcp;
    this.hookBundle = opts.hooks;
    const initRequest: Record<string, unknown> = { subtype: "initialize" };
    if (opts.subagentAppend) initRequest.appendSubagentSystemPrompt = opts.subagentAppend;
    if (opts.sdkMcp?.servers.length) initRequest.sdkMcpServers = opts.sdkMcp.servers;
    // Merge the caller-supplied PreToolUse definitions (e.g. hostloop's path gate) onto the
    // always-installed COWORK_PRETOOLUSE_HOOKS (Task run_in_background block) — never replace it.
    initRequest.hooks = opts.hooks
      ? { PreToolUse: [...COWORK_PRETOOLUSE_HOOKS.PreToolUse, ...opts.hooks.definitions.PreToolUse] }
      : COWORK_PRETOOLUSE_HOOKS;
    this.write({ type: "control_request", request_id: "init-1", request: initRequest });
  }

  async *start(opts: { subagentAppend?: string; sdkMcp?: SdkMcp; hooks?: HookBundle } = {}): AsyncIterable<AgentEvent> {
    this.init(opts); // idempotent — a no-op if drive() already wrote init-1 before the first user turn

    // race-approach latch — `errorPromise` rejects when proc emits an error, which is
    // outside the readline loop. We race each rl.next() against it so the generator yields a
    // typed {type:"error"} event and terminates cleanly instead of silently blocking on stdout.
    let errorPromise = new Promise<never>((_res, rej) => (this.rejectError = rej));
    // Also write the _emu entry for backwards-compat with any tooling that reads events.jsonl.
    // route the spawn error through `rejectError` (like the stdin handler) so the Promise.race
    // below rejects and the generator yields a typed {type:"error"} event instead of hanging on
    // stdout that will never arrive.
    this.proc.on("error", (e) => {
      if (!this.closing) this.events.write(JSON.stringify({ _emu: "spawn_error", message: String(e) }) + "\n");
      if (this.rejectError) this.rejectError(e instanceof Error ? e : new Error(String(e)));
    });

    const rl = readline.createInterface({ input: this.proc.stdout });
    const iter = rl[Symbol.asyncIterator]();
    try {
      while (true) {
        // Race the next readline item against a spawn/stdin error.
        let next: IteratorResult<string>;
        try {
          next = await Promise.race([iter.next(), errorPromise]);
        } catch (spawnErr) {
          // Error won the race — emit a typed error event and stop.
          const msg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
          yield { type: "error", source: "spawn", message: msg };
          return;
        }
        if (next.done) break;
        const line = next.value;
        if (!line.trim()) continue;
        if (!this.closing) this.events.write(line + "\n");
        // Ordinal of the Nth real stdout line consumed here — NOT a raw events.jsonl line index (see
        // timeline.ts's TimelineEvent doc comment: harness-injected `_emu` markers are written to
        // events.jsonl outside this loop and are never counted). Captured once per raw line and
        // reused for every AgentEvent derived from it — one line commonly yields several (e.g. a
        // tool_use that is also a sub-agent dispatch), and they must share this same `line` value.
        const lineIndex = this.lineIndex++;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          yield { type: "raw", line };
          continue;
        }
        try {
          for await (const ev of this.translate(msg)) {
            this.timeline.record(ev, lineIndex);
            yield ev;
          }
        } catch (e) {
          yield { type: "error", source: "protocol", message: (e as Error)?.message ?? String(e) };
          return;
        }
      }
      // stdout closed. Give a pending 'exit' one tick to land (NOT a blocking wait on 'close' — a
      // mock/fake child may never emit it), then surface a nonzero/signal exit as a typed error — a
      // crashed child that emitted no {type:"result"} error line would otherwise be a silent stop.
      await new Promise<void>((res) => setImmediate(res));
      const code = this.proc.exitCode;
      const signal = this.proc.signalCode;
      if (signal || (code !== null && code !== 0)) {
        const tail = this.stderrTail.trim();
        yield {
          type: "error",
          source: "exit",
          message: `agent process exited ${signal ? `on signal ${signal}` : `with code ${code}`}${tail ? ` — stderr tail: ${tail}` : ""}`,
        };
      }
    } finally {
      this.rejectError = undefined; // generator is done; stop routing errors here
      this.closing = true; // discard any late write() from translate()'s async hook/mcp paths
      await this.drainAll(); // queue empty + all callbacks confirmed before ending either stream
      // AWAIT the stream flush before the generator resolves. executeScenario reads/scans/scrubs
      // events.jsonl + control-out.jsonl immediately after `drive()` returns; a fire-and-forget end()
      // races the final buffered writes. end(cb) fires the callback on 'finish' (fully flushed).
      await Promise.all([
        new Promise<void>((res) => this.events.end(() => res())),
        new Promise<void>((res) => this.controlOut.end(() => res())),
        new Promise<void>((res) => this.timeline.end(() => res())),
      ]);
    }
  }

  private async *translate(msg: any): AsyncIterable<AgentEvent> {
    // a PreToolUse hook fired pre-dispatch (side-effecting, like mcp_message). Reply with the
    // installed hook's output so the agent blocks/allows; a dropped reply would deadlock the agent.
    if (msg.type === "control_request" && msg.request?.subtype === "hook_callback") {
      // validate request_id BEFORE emitting a response — a malformed id would write an
      // unaddressable control_response and leave the in-VM agent blocked on the hook round-trip.
      const reqId = requireRequestId(msg);
      const callbackId = msg.request.callback_id;
      // An unknown-to-the-built-ins callback id is routed to the caller-supplied hook bundle
      // (e.g. hostloop's path gate) instead of falling through hookOutput's unconditional allow —
      // a configured custom hook whose callback never reaches its real handler would silently un-gate
      // hostloop's entire security boundary.
      if (callbackId !== TASK_BG_HOOK_ID && this.hookBundle) {
        let out: Record<string, unknown>;
        try {
          out = await this.hookBundle.handle(callbackId, msg.request.input);
        } catch (e) {
          const message = (e as Error)?.message ?? String(e);
          warn(`::warning:: hook bundle handler threw for callback "${callbackId}" — blocking (fail-closed): ${message}\n`);
          out = { decision: "block", reason: `hook handler error: ${message}` };
        }
        this.write(successEnvelope(reqId, out));
        return;
      }
      this.write(successEnvelope(reqId, hookOutput(callbackId, msg.request.input)));
      return;
    }
    // mcp_message is the only side-effecting branch (the driver computes + writes the response).
    if (msg.type === "control_request" && msg.request?.subtype === "mcp_message") {
      // same fail-closed request_id check as the decision path — never echo an unchecked id.
      const reqId = requireRequestId(msg);
      const server = msg.request.server_name;
      const jr = msg.request.message ?? {};
      if (this.sdkMcp) {
        let out: { result?: unknown; error?: { code: number; message: string } };
        try {
          out = await this.sdkMcp.handle(server, jr); // async (web_fetch may await an approval)
        } catch (e) {
          // A throw from handle() (e.g. a broken allow_if predicate in the decider) must NOT bypass the
          // reply — an unanswered mcp_message blocks the in-VM agent on the round-trip forever (deadlock).
          // Reply with a JSON-RPC error instead, mirroring the no-handler defense below.
          const message = (e as Error)?.message ?? String(e);
          warn(`::warning:: sdkMcp.handle threw for "${server}" — replying with a JSON-RPC error: ${message}\n`);
          out = { error: { code: -32603, message: `handler error: ${message}` } };
        }
        this.write(mcpResponseEnvelope(reqId, out as any, jr.id));
        // Echo the MCP round-trip as a SYNTHETIC tool_use for provenance/trace only. The real tool call
        // also arrives as an assistant tool_use block (live-verified: mcp__workspace__bash co-occurs with
        // this mcp_message), which is what gets counted — so this is marked synthetic and excluded from
        // toolsCalled/toolCounts to avoid polluting them with a bogus `mcp__server__*` entry.
        if (server)
          yield {
            type: "tool_use",
            name: jr.params?.name ? `mcp__${server}__${jr.params.name}` : `mcp__${server}__*`,
            input: jr.params ?? {},
            synthetic: true,
          };
        return;
      }
      // an mcp_message arrived but no sdkMcp handler is configured. Reply with a JSON-RPC error
      // (well-formed via mcpResponseEnvelope) instead of silently dropping it — a dropped request
      // leaves the in-VM agent waiting on the round-trip forever (protocol deadlock in host-loop mode).
      warn(
        `::warning:: mcp_message for server "${server}" arrived but no sdkMcp handler is configured — replying with a JSON-RPC error (would otherwise deadlock)\n`,
      );
      this.write(mcpResponseEnvelope(reqId, { error: { code: -32601, message: "no sdkMcp handler configured" } }, jr.id));
      return;
    }
    for (const ev of parseMessage(msg)) {
      if (ev.type === "decision") this.reqById.set(ev.request.id, ev.request);
      yield ev;
    }
  }

  sendUserTurn(text: string): void {
    this.write({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
  }

  respond(decisionId: string, r: DecisionResponse): void {
    const req = this.reqById.get(decisionId);
    if (!req) {
      // an id with no matching request_id is a protocol drift. Writing a guessed envelope would
      // be worse, but a silent return leaves the agent blocked until timeout (looks like a hang).
      warn(
        `::warning:: respond() for unknown decision id "${decisionId}" — no matching request_id was seen; the agent may block until timeout (protocol drift)\n`,
      );
      return;
    }
    // serializeDecision returns a safe deny envelope on a kind mismatch (defense in depth). That
    // deny goes to the agent silently today — surface it loudly so the run record can't read "answered"
    // while the agent actually received a deny. (serializeDecision stays a pure declared inverse of
    // deserializeDecision; the warning lives here in the caller, not in the pure function.)
    if (req.kind !== r.kind)
      warn(
        `::warning:: decider returned kind "${r.kind}" for a "${req.kind}" request (id ${decisionId}) → sending a safe deny/cancel; the agent did NOT receive an answer\n`,
      );
    this.write(serializeDecision(req, r));
    // Invariant: each decision id is answered at most once. Delete after a successful write so
    // stale entries don't accumulate (live sessions may process thousands of decisions per run).
    this.reqById.delete(decisionId);
  }

  close(): void {
    try {
      this.proc.stdin.end();
    } catch {
      /* already gone */
    }
  }

  private write(obj: unknown): void {
    const line = JSON.stringify(obj);
    if (this.closing) return; // session draining — discard silently
    // check stream writability before writing — a closed/destroyed stdin after a child crash
    // loses decision frames silently. Throw immediately so callers surface the failure rather than
    // hanging or silently dropping frames.
    if (this.proc.stdin.destroyed || !this.proc.stdin.writable)
      throw new Error("control-protocol write failed: child stdin is no longer writable (process may have crashed)");
    this.writeQueue.push(line + "\n");
    void this.pump().catch((err) => {
      // Route unexpected pump errors through rejectError so they surface as a typed error + clean
      // teardown instead of a silent hang. Known failure modes call rejectError themselves before
      // the pump returns, so this only fires on unanticipated throws.
      if (this.rejectError) this.rejectError(err instanceof Error ? err : new Error(String(err)));
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.writeQueue.length) {
        const frame = this.writeQueue.shift()!;
        if (this.proc.stdin.destroyed || !this.proc.stdin.writable) {
          this.events.write(JSON.stringify({ _emu: "control_undelivered", frame }) + "\n");
          if (this.rejectError) this.rejectError(new Error("stdin no longer writable while draining queue"));
          while (this.writeQueue.length) {
            const remaining = this.writeQueue.shift()!;
            this.events.write(JSON.stringify({ _emu: "control_undelivered", frame: remaining }) + "\n");
          }
          break;
        }
        // Await the write callback directly — the ONLY reliable signal for child-process stdin
        // pipes (EPIPE goes to the callback, not an 'error' event; 'drain'/'close' are unreliable).
        // Awaiting inline also bounds in-flight depth to 1, giving deterministic replay ordering.
        const writeErr = await new Promise<Error | null>((resolve) => {
          try {
            this.proc.stdin.write(frame, (err) => {
              resolve(err ?? null);
            });
          } catch (e) {
            resolve(e instanceof Error ? e : new Error(String(e)));
          }
        });
        if (writeErr) {
          this.events.write(JSON.stringify({ _emu: "control_undelivered", frame }) + "\n");
          if (this.rejectError) this.rejectError(writeErr);
          while (this.writeQueue.length) {
            const remaining = this.writeQueue.shift()!;
            this.events.write(JSON.stringify({ _emu: "control_undelivered", frame: remaining }) + "\n");
          }
          break;
        } else {
          if (frame.length > CONTROL_OUT_MIRROR_CAP) {
            // an over-cap control frame can no longer be mirrored verbatim into control-out.jsonl.
            // Previously we wrote a `_emu:control_out_truncated` marker — but that marker is UNREPLAYABLE
            // (buildControlOutIndex skips it → the decision lands in missingControlOut → replay fails loud
            // as "truncated; re-record"). FAIL at RECORD time instead, so the marker never reaches a cassette
            // and the operator learns the real cause (a control frame too large) at its source. Route through
            // rejectError + break for the same typed-error + clean-teardown path as a write failure above.
            if (this.rejectError)
              this.rejectError(
                new Error(
                  `control-out frame too large to mirror (${frame.length} bytes > ${CONTROL_OUT_MIRROR_CAP} cap) — ` +
                    `a cassette recorded from this run would be unreplayable. Reduce the control payload (e.g. a smaller AskUserQuestion answer / tool input).`,
                ),
              );
            break;
          }
          this.controlOut.write(frame);
        }
      }
    } finally {
      this.pumping = false;
      // Unconditionally drain any remaining frames — handles a synchronous throw from
      // controlOut.write/events.write inside the try body, which would otherwise leave
      // writeQueue non-empty and queueIdle unfired, hanging drainAll().
      while (this.writeQueue.length) {
        const remaining = this.writeQueue.shift()!;
        try {
          this.events.write(JSON.stringify({ _emu: "control_undelivered", frame: remaining }) + "\n");
        } catch {
          /* events may already be ended; discard silently */
        }
      }
      const idle = this.queueIdle;
      this.queueIdle = undefined;
      idle?.();
    }
  }

  private drainAll(): Promise<void> {
    if (!this.pumping && this.writeQueue.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.queueIdle = resolve;
    });
  }
}

/** Pure translation of one parsed stream-json message → AgentEvents (no side-effects). Shared by
 *  LiveAgentSession and CassetteAgentSession. mcp_message is handled by Live before this is called. */
export function parseMessage(msg: any): AgentEvent[] {
  const ev: AgentEvent[] = [];
  switch (msg.type) {
    case "system":
      if (msg.subtype === "init")
        ev.push({ type: "init", tools: msg.tools ?? [], mcpServers: msg.mcp_servers ?? [], skills: msg.skills ?? [], cwd: msg.cwd });
      else if (msg.subtype === "api_metrics") ev.push({ type: "metrics", data: msg });
      else if (msg.subtype === "thinking") ev.push({ type: "thinking", text: String(msg.content ?? "") });
      break;
    case "control_request": {
      const dr = toDecisionRequest(msg);
      if (dr) ev.push({ type: "decision", request: dr });
      break;
    }
    case "assistant": {
      // Protocol v1: parentToolUseId is message-level. Block-level parent_tool_use_id (if present)
      // is canonical — prefer it when both exist (block-level is more precise for nested dispatches).
      const msgParentToolUseId = msg.parent_tool_use_id ? String(msg.parent_tool_use_id) : undefined;
      // message.model is present on every real assistant stream-json message (live-confirmed) —
      // read once per message, thread onto assistant_text/tool_use/thinking/subagent_dispatch.
      const model = typeof msg.message?.model === "string" ? msg.message.model : undefined;
      let blockIndex = 0;
      for (const block of msg.message?.content ?? []) {
        // Block-level parent wins over message-level when both are present (see comment above).
        const parentToolUseId = block.parent_tool_use_id ? String(block.parent_tool_use_id) : msgParentToolUseId;
        if (block.type === "text") ev.push({ type: "assistant_text", text: block.text, parentToolUseId, model });
        else if (block.type === "thinking") ev.push({ type: "thinking", text: block.thinking ?? block.text ?? "", model });
        else if (block.type === "tool_use") {
          ev.push({
            type: "tool_use",
            name: block.name,
            input: block.input,
            parentToolUseId,
            toolUseId: block.id ? String(block.id) : undefined,
            model,
          });
          // Sub-agent dispatch. The real cowork agent uses the `Agent` tool (`{description,
          // subagent_type, prompt}`); older/other surfaces use `Task`. We recognize either name, plus
          // any tool whose input carries `subagent_type` (rename-robust). Crucially we DON'T match the
          // cowork `TaskCreate`/`TaskUpdate` todo-list tools (`{subject, description, activeForm}` /
          // `{taskId, status}`) — they have no `subagent_type`, so they're excluded and never miscount.
          const inp = (block.input ?? {}) as Record<string, unknown>;
          if (block.name === "Agent" || block.name === "Task" || "subagent_type" in inp) {
            const declared = Array.isArray(inp.tools)
              ? (inp.tools as unknown[]).map(String)
              : Array.isArray(inp.allowedTools)
                ? (inp.allowedTools as unknown[]).map(String)
                : []; // the `Agent` tool declares no tools list → []; declared-but-unused is legacy-`Task`-only
            // When block.id is absent, synthesize a fallback to avoid collapsing all anonymous
            // dispatches into the empty-string identity, which breaks dispatch tracking.
            const toolUseId = block.id ? String(block.id) : `unpaired-${blockIndex}`;
            ev.push({
              type: "subagent_dispatch",
              toolUseId,
              parentToolUseId,
              // Skills often dispatch with only {description, prompt} (no subagent_type) → agentType is
              // "unknown" but the description still identifies the dispatch (e.g. "TOP_DOWN market sizing").
              agentType: String(inp.subagent_type ?? inp.subagentType ?? "unknown"),
              declaredTools: declared,
              description: inp.description != null ? String(inp.description) : undefined,
              prompt: inp.prompt != null ? toolResultAssertText(String(inp.prompt)) : undefined,
              model,
            });
          }
        }
        blockIndex++;
      }
      break;
    }
    case "user":
      // Tool OUTCOMES come back as `user` messages carrying tool_result blocks. We never parsed these
      // before, so every tool result — including the AskUserQuestion `q.map` error — was invisible to the
      // recorder/trace. Capture them for delivery verification + `trace --tools`/`--gates`.
      for (const block of msg.message?.content ?? []) {
        if (block.type === "tool_result")
          ev.push({
            type: "tool_result",
            toolUseId: block.tool_use_id ? String(block.tool_use_id) : undefined,
            isError: !!block.is_error,
            text: toolResultText(block.content),
            provenanceText: toolResultRaw(block.content),
            assertText: toolResultAssertText(block.content),
          });
      }
      break;
    case "result":
      ev.push({
        type: "result",
        isError: !!msg.is_error,
        usage: msg.usage,
        // preserve the SDK result payload + subtype so run.ts can tell a transport drop
        // (e.g. "API Error: Connection closed", subtype error_during_execution) from a skill failure.
        resultText: typeof msg.result === "string" ? msg.result : undefined,
        subtype: typeof msg.subtype === "string" ? msg.subtype : undefined,
        costUsd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : undefined,
        numTurns: typeof msg.num_turns === "number" ? msg.num_turns : undefined,
        modelUsage:
          msg.modelUsage && typeof msg.modelUsage === "object" ? (msg.modelUsage as Record<string, Record<string, unknown>>) : undefined,
      });
      break;
  }
  return ev;
}

/** Flatten a tool_result `content` (a string, or an array of content blocks), capped at
 *  `max` chars. The 500-char DISPLAY value (toolResultText) keeps the recorder/trace compact; the larger
 *  PROVENANCE value (toolResultRaw) is what seeds web_fetch provenance, so a URL past char 500 isn't lost.
 * preserve all content block types — text blocks use their text value; all other block types
 *  (json, resource, link, unknown shapes) are JSON-stringified so no content is silently dropped. */
function flattenToolResult(content: unknown, max: number): string {
  if (typeof content === "string") return content.slice(0, max);
  if (Array.isArray(content))
    return content
      .map((b) => {
        if (b && typeof b === "object" && "text" in b) return String((b as { text: unknown }).text);
        // Non-text blocks (json, resource, link, unknown): JSON-stringify to preserve all content.
        // JSON.stringify returns `undefined` for blocks that contain functions or other
        // non-serializable values; wrap those in an explicit marker so downstream code can identify
        // and skip them rather than treating the literal string "undefined" as block content.
        const serialized = JSON.stringify(b);
        return serialized !== undefined ? serialized : JSON.stringify({ type: "unsupported", raw: "[unserializable]" });
      })
      .join(" ")
      .slice(0, max);
  return "";
}
function toolResultText(content: unknown): string {
  return flattenToolResult(content, 500);
}
/** Larger cap for provenance (URL extraction) — matches the web_fetch body cap so any URL the agent
 *  could realistically act on is seeded; still bounded so a pathological result can't blow up memory. */
function toolResultRaw(content: unknown): string {
  return flattenToolResult(content, 200_000);
}
/** Assertion-fidelity cap — enough to cover realistic tool outputs for content assertions without
 *  blowing up result.json; deliberately larger than the 500-char display cap so text past the display
 *  truncation is still assertable. */
function toolResultAssertText(content: unknown): string {
  return flattenToolResult(content, 10_240);
}

export function toDecisionRequest(msg: any): DecisionRequest | null {
  const sub = msg.request?.subtype;
  // Validate request_id early — every DecisionRequest.id is a non-empty string. A missing or
  // non-string request_id means the agent sent a malformed control_request; reject loudly rather
  // than silently building a DecisionRequest with an unusable id (respond() would always miss it).
  const id = requireRequestId(msg);
  if (sub === "can_use_tool") {
    const tool = msg.request.tool_name ?? "";
    if (tool === "AskUserQuestion") {
      // validate the questions body at ingress instead of an unchecked `as QSpec[]` cast — a
      // malformed control frame (questions not an array, an option with no `label`, …) is a protocol
      // error, not trusted decider input. The thrown Error is caught per-line on the replay path
      // and surfaces as a typed control-protocol failure on the live path.
      const parsed = QuestionsSchema.safeParse(msg.request.input?.questions ?? []);
      if (!parsed.success)
        throw new Error(
          `control-in: malformed AskUserQuestion questions for request ${id}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ")}`,
        );
      // Capture the `toolu_…` tool_use_id (distinct from the UUID request_id) to pair the gate with its
      // tool_result later. The SDK puts it on the request envelope.
      return {
        id,
        kind: "question",
        questions: parsed.data as QSpec[],
        toolUseId: msg.request.tool_use_id ? String(msg.request.tool_use_id) : undefined,
      };
    }
    return { id, kind: "permission", tool, input: msg.request.input ?? {} };
  }
  if (sub === "request_user_dialog")
    return { id, kind: "dialog", dialogKind: msg.request.dialogKind ?? msg.request.dialog_kind ?? "unknown", payload: msg.request.payload };
  if (sub === "elicitation" || sub === "side_question")
    return {
      id,
      kind: "elicit",
      server: msg.request.mcp_server_name ?? msg.request.server,
      prompt: msg.request.message ?? msg.request.prompt,
      schema: msg.request.requestedSchema,
    };
  return null;
}
