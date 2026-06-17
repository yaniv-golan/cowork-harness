import { createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";
import readline from "node:readline";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

/**
 * Seam 1 — AgentSession: the stream-json control protocol over a runtime-provided child.
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
  // tool_result for delivery verification + `trace --gates` (Opus-review amendment #1).
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
  | { type: "init"; tools: string[]; mcpServers: unknown[]; cwd?: string }
  | { type: "assistant_text"; text: string; parentToolUseId?: string }
  | { type: "tool_use"; name: string; input: unknown; parentToolUseId?: string; toolUseId?: string; synthetic?: boolean } // toolUseId for tool_use↔tool_result pairing (amendment #2); synthetic = the MCP round-trip echo (trace-only, NOT counted — the real call already arrives as an assistant tool_use block, live-verified)
  | { type: "tool_result"; toolUseId?: string; isError: boolean; text: string; provenanceText?: string } // the OUTCOME of a tool call (from `user`/tool_result blocks). `text` is display-truncated; `provenanceText` is the larger raw value so URLs past the display cap still seed web_fetch provenance
  | {
      type: "subagent_dispatch";
      toolUseId: string;
      parentToolUseId?: string;
      agentType: string;
      declaredTools: string[];
      description?: string;
    } // A3 (parentToolUseId = nesting, for the dispatch tree)
  | { type: "thinking"; text: string } // F2
  | { type: "metrics"; data: Record<string, unknown> } // F2 (api_metrics → cost)
  | { type: "decision"; request: DecisionRequest }
  | { type: "result"; isError: boolean; usage?: Record<string, unknown> }
  | { type: "error"; source: "spawn" | "agent" | "protocol" | "exit"; message: string }
  | { type: "raw"; line: string };

export type SdkMcp = {
  servers: string[];
  // #30: handle is async — web_fetch may await a provenance approval through the Decider.
  handle: (
    server: string,
    jsonrpc: any,
  ) =>
    | Promise<{ result?: unknown; error?: { code: number; message: string } }>
    | { result?: unknown; error?: { code: number; message: string } };
};

export interface AgentSession {
  /** #45: write `initialize` before the first user turn (idempotent; `start()` also calls it).
   *  Optional — replay sessions (cassette) have no live control channel and omit it. */
  init?(opts?: { systemPromptAppend?: string; subagentAppend?: string; sdkMcp?: SdkMcp }): void;
  start(opts?: { systemPromptAppend?: string; subagentAppend?: string; sdkMcp?: SdkMcp }): AsyncIterable<AgentEvent>;
  sendUserTurn(text: string): void;
  respond(decisionId: string, r: DecisionResponse): void;
  close(): void;
}

// ---- Control-response envelopes (verified zod shape; the inner `response` nesting is load-bearing) ----
/** The one success-envelope shape every control_response shares; the four builders below differ ONLY in
 *  the inner `body`. Keeping a single core stops the wrapper drifting between them. */
function successEnvelope(requestId: string, body: Record<string, unknown>) {
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

// ---- #8: PreToolUse hooks (the harness mirrors Cowork's host-installed hooks) ----
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
    // the answer never reaches the model, and gate-steering silently no-ops (O7).
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

// ---- Canonical-JSON comparator (for the O7 replay guard) ----
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
 *  MUST NOT route through `serializeDecision` — that would make the O7 guard circular (the
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
    // O7 guard in respond() trips a loud replay_protocol_fidelity mismatch. Mirrors the elicit branch's
    // known-action validation below (declared-inverse symmetry).
    return { kind: "permission", behavior: "deny", message: "deserializeDecision: invalid permission behavior" };
  }
  if (req.kind === "question") {
    // AskUserQuestion: body is { behavior:"allow", updatedInput:{ questions, answers } }
    // We read `answers` back; `questions` was preserved in recording for the O7 guard.
    const ui = (body.updatedInput ?? {}) as Record<string, unknown>;
    return { kind: "question", answers: (ui.answers ?? {}) as Record<string, string> };
  }
  if (req.kind === "dialog") {
    return {
      kind: "dialog",
      behavior: body.behavior === "ok" ? "ok" : "cancelled",
      ...(body.behavior === "ok" && body.choice !== undefined ? { choice: body.choice } : {}),
    };
  }
  if (req.kind === "elicit") {
    // #22: validate against the known action set instead of an unchecked `as` cast. A recorded
    // action that is missing or unrecognized (a corrupt/truncated cassette) maps to "decline" — a
    // value that will NOT re-serialize back to the corrupt input, so the O7 guard in respond()
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

export class LiveAgentSession implements AgentSession {
  private events: WriteStream;
  private controlOut: WriteStream;
  private reqById = new Map<string, DecisionRequest>();
  private sdkMcp?: SdkMcp;
  private initWritten = false;
  /** Reject function set when proc emits an error — bridges the callback into the async generator.
   *  Set before the generator loop starts; called at most once (the Promise settles once). */
  private rejectError?: (e: Error) => void;
  /** Bounded tail of the child's stderr, for the nonzero-exit error message. */
  private stderrTail = "";

  constructor(
    private proc: ChildProcessByStdio<Writable, Readable, Readable>,
    private outDir: string,
  ) {
    this.events = createWriteStream(join(outDir, "events.jsonl"), { flags: "a" });
    this.controlOut = createWriteStream(join(outDir, "control-out.jsonl"), { flags: "a" });
    const errLog = createWriteStream(join(outDir, "agent.stderr.log"), { flags: "a" });
    this.proc.stderr.pipe(errLog);
    // keep a bounded stderr tail and capture the exit code/signal so a child that dies nonzero
    // (with no structured {type:"result"} error) is surfaced as a typed error event, not a silent stop.
    this.proc.stderr.on("data", (d) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-2000);
    });
    // #15: attach stdin error listener once at construction so dead-child writes don't produce
    // unhandled process errors. Routes to the same error path as spawn errors when possible.
    this.proc.stdin.on("error", (e) => {
      if (this.rejectError) this.rejectError(e);
      // else: the error fired before/after the generator — log it but don't throw
      else this.events.write(JSON.stringify({ _emu: "stdin_error", message: String(e) }) + "\n");
    });
  }

  /**
   * Write the `initialize` control_request (idempotent). #45: `Run.drive` calls this BEFORE the first
   * `sendUserTurn` so the wire order matches the SPEC (initialize precedes the user turn); `start()`
   * also calls it so a standalone `start()` (no prior `init`) still initializes. Guarded so the two
   * call sites never double-write init-1.
   */
  init(opts: { systemPromptAppend?: string; subagentAppend?: string; sdkMcp?: SdkMcp } = {}): void {
    if (this.initWritten) return;
    this.initWritten = true;
    this.sdkMcp = opts.sdkMcp;
    const initRequest: Record<string, unknown> = { subtype: "initialize" };
    if (opts.subagentAppend) initRequest.appendSubagentSystemPrompt = opts.subagentAppend;
    if (opts.sdkMcp?.servers.length) initRequest.sdkMcpServers = opts.sdkMcp.servers;
    initRequest.hooks = COWORK_PRETOOLUSE_HOOKS; // #8: block Task run_in_background, mirroring cowork
    this.write({ type: "control_request", request_id: "init-1", request: initRequest });
  }

  async *start(opts: { systemPromptAppend?: string; subagentAppend?: string; sdkMcp?: SdkMcp } = {}): AsyncIterable<AgentEvent> {
    this.init(opts); // idempotent — a no-op if drive() already wrote init-1 before the first user turn

    // #13: race-approach latch — `errorPromise` rejects when proc emits an error, which is
    // outside the readline loop. We race each rl.next() against it so the generator yields a
    // typed {type:"error"} event and terminates cleanly instead of silently blocking on stdout.
    let errorPromise = new Promise<never>((_res, rej) => (this.rejectError = rej));
    // Also write the _emu entry for backwards-compat with any tooling that reads events.jsonl.
    // #9: route the spawn error through `rejectError` (like the stdin handler) so the Promise.race
    // below rejects and the generator yields a typed {type:"error"} event instead of hanging on
    // stdout that will never arrive.
    this.proc.on("error", (e) => {
      this.events.write(JSON.stringify({ _emu: "spawn_error", message: String(e) }) + "\n");
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
        this.events.write(line + "\n");
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          yield { type: "raw", line };
          continue;
        }
        yield* this.translate(msg);
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
      // #46: AWAIT the stream flush before the generator resolves. executeScenario reads/scans/scrubs
      // events.jsonl + control-out.jsonl immediately after `drive()` returns; a fire-and-forget end()
      // races the final buffered writes. end(cb) fires the callback on 'finish' (fully flushed).
      await Promise.all([
        new Promise<void>((res) => this.events.end(() => res())),
        new Promise<void>((res) => this.controlOut.end(() => res())),
      ]);
    }
  }

  private async *translate(msg: any): AsyncIterable<AgentEvent> {
    // #8: a PreToolUse hook fired pre-dispatch (side-effecting, like mcp_message). Reply with the
    // installed hook's output so the agent blocks/allows; a dropped reply would deadlock the agent.
    if (msg.type === "control_request" && msg.request?.subtype === "hook_callback") {
      this.write(successEnvelope(msg.request_id, hookOutput(msg.request.callback_id, msg.request.input)));
      return;
    }
    // mcp_message is the only side-effecting branch (the driver computes + writes the response).
    if (msg.type === "control_request" && msg.request?.subtype === "mcp_message") {
      const server = msg.request.server_name;
      const jr = msg.request.message ?? {};
      if (this.sdkMcp) {
        let out: { result?: unknown; error?: { code: number; message: string } };
        try {
          out = await this.sdkMcp.handle(server, jr); // #30: async (web_fetch may await an approval)
        } catch (e) {
          // A throw from handle() (e.g. a broken allow_if predicate in the decider) must NOT bypass the
          // reply — an unanswered mcp_message blocks the in-VM agent on the round-trip forever (deadlock).
          // Reply with a JSON-RPC error instead, mirroring the no-handler defense below.
          const message = (e as Error)?.message ?? String(e);
          process.stderr.write(`::warning:: sdkMcp.handle threw for "${server}" — replying with a JSON-RPC error: ${message}\n`);
          out = { error: { code: -32603, message: `handler error: ${message}` } };
        }
        this.write(mcpResponseEnvelope(msg.request_id, out as any, jr.id));
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
      // #10: an mcp_message arrived but no sdkMcp handler is configured. Reply with a JSON-RPC error
      // (well-formed via mcpResponseEnvelope) instead of silently dropping it — a dropped request
      // leaves the in-VM agent waiting on the round-trip forever (protocol deadlock in host-loop mode).
      process.stderr.write(
        `::warning:: mcp_message for server "${server}" arrived but no sdkMcp handler is configured — replying with a JSON-RPC error (would otherwise deadlock)\n`,
      );
      this.write(mcpResponseEnvelope(msg.request_id, { error: { code: -32601, message: "no sdkMcp handler configured" } }, jr.id));
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
      // #13: an id with no matching request_id is a protocol drift. Writing a guessed envelope would
      // be worse, but a silent return leaves the agent blocked until timeout (looks like a hang).
      process.stderr.write(
        `::warning:: respond() for unknown decision id "${decisionId}" — no matching request_id was seen; the agent may block until timeout (protocol drift)\n`,
      );
      return;
    }
    // #14: serializeDecision returns a safe deny envelope on a kind mismatch (defense in depth). That
    // deny goes to the agent silently today — surface it loudly so the run record can't read "answered"
    // while the agent actually received a deny. (serializeDecision stays a pure declared inverse of
    // deserializeDecision; the warning lives here in the caller, not in the pure function.)
    if (req.kind !== r.kind)
      process.stderr.write(
        `::warning:: decider returned kind "${r.kind}" for a "${req.kind}" request (id ${decisionId}) → sending a safe deny/cancel; the agent did NOT receive an answer\n`,
      );
    this.write(serializeDecision(req, r));
  }

  close(): void {
    try {
      this.proc.stdin.end();
    } catch {
      /* already gone */
    }
  }

  private write(obj: unknown) {
    const line = JSON.stringify(obj);
    // The control protocol writes small single-line JSON frames, so stdin backpressure effectively never
    // engages; we ignore the write() return / drain here. A frame past the safe threshold is anomalous —
    // hard-FAIL rather than risk a partially-buffered write that silently corrupts the protocol stream.
    // (If large control frames ever become legitimate, switch to a drain-aware queue, making writes async.)
    if (line.length > 256 * 1024)
      throw new Error(
        `control frame is ${line.length} bytes (> 256 KiB safe limit) — refusing to write to avoid partial stdin buffering; this indicates an unexpectedly large control payload`,
      );
    this.controlOut.write(line + "\n");
    this.proc.stdin.write(line + "\n");
  }
}

/** Pure translation of one parsed stream-json message → AgentEvents (no side-effects). Shared by
 *  LiveAgentSession and CassetteAgentSession. mcp_message is handled by Live before this is called. */
export function parseMessage(msg: any): AgentEvent[] {
  const ev: AgentEvent[] = [];
  switch (msg.type) {
    case "system":
      if (msg.subtype === "init") ev.push({ type: "init", tools: msg.tools ?? [], mcpServers: msg.mcp_servers ?? [], cwd: msg.cwd });
      else if (msg.subtype === "api_metrics") ev.push({ type: "metrics", data: msg });
      else if (msg.subtype === "thinking") ev.push({ type: "thinking", text: String(msg.content ?? "") });
      break;
    case "control_request": {
      const dr = toDecisionRequest(msg);
      if (dr) ev.push({ type: "decision", request: dr });
      break;
    }
    case "assistant": {
      const parentToolUseId = msg.parent_tool_use_id ? String(msg.parent_tool_use_id) : undefined;
      for (const block of msg.message?.content ?? []) {
        if (block.type === "text") ev.push({ type: "assistant_text", text: block.text, parentToolUseId });
        else if (block.type === "thinking") ev.push({ type: "thinking", text: block.thinking ?? block.text ?? "" });
        else if (block.type === "tool_use") {
          ev.push({
            type: "tool_use",
            name: block.name,
            input: block.input,
            parentToolUseId,
            toolUseId: block.id ? String(block.id) : undefined,
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
            ev.push({
              type: "subagent_dispatch",
              toolUseId: String(block.id ?? ""),
              parentToolUseId,
              // Skills often dispatch with only {description, prompt} (no subagent_type) → agentType is
              // "unknown" but the description still identifies the dispatch (e.g. "TOP_DOWN market sizing").
              agentType: String(inp.subagent_type ?? inp.subagentType ?? "unknown"),
              declaredTools: declared,
              description: inp.description != null ? String(inp.description) : undefined,
            });
          }
        }
      }
      break;
    }
    case "user":
      // Tool OUTCOMES come back as `user` messages carrying tool_result blocks. We never parsed these
      // before, so every tool result — including the AskUserQuestion `q.map` error — was invisible to the
      // recorder/trace. Capture them for delivery verification + `trace --tools`/`--gates` (Part 2).
      for (const block of msg.message?.content ?? []) {
        if (block.type === "tool_result")
          ev.push({
            type: "tool_result",
            toolUseId: block.tool_use_id ? String(block.tool_use_id) : undefined,
            isError: !!block.is_error,
            text: toolResultText(block.content),
            provenanceText: toolResultRaw(block.content),
          });
      }
      break;
    case "result":
      ev.push({ type: "result", isError: !!msg.is_error, usage: msg.usage });
      break;
  }
  return ev;
}

/** Flatten a tool_result `content` (a string, or an array of `{type:"text",text}` blocks), capped at
 *  `max` chars. The 500-char DISPLAY value (toolResultText) keeps the recorder/trace compact; the larger
 *  PROVENANCE value (toolResultRaw) is what seeds web_fetch provenance, so a URL past char 500 isn't lost. */
function flattenToolResult(content: unknown, max: number): string {
  if (typeof content === "string") return content.slice(0, max);
  if (Array.isArray(content))
    return content
      .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
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

export function toDecisionRequest(msg: any): DecisionRequest | null {
  const sub = msg.request?.subtype;
  const id = msg.request_id;
  if (sub === "can_use_tool") {
    const tool = msg.request.tool_name ?? "";
    if (tool === "AskUserQuestion")
      // Capture the `toolu_…` tool_use_id (distinct from the UUID request_id) to pair the gate with its
      // tool_result later (amendment #1). The SDK puts it on the request envelope.
      return {
        id,
        kind: "question",
        questions: (msg.request.input?.questions ?? []) as QSpec[],
        toolUseId: msg.request.tool_use_id ? String(msg.request.tool_use_id) : undefined,
      };
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
