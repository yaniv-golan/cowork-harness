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
  | {
      id: string;
      kind: "permission";
      tool: string;
      input: Record<string, unknown>;
      options?: { label: string; description?: string }[];
      toolUseId?: string; // request.tool_use_id — pairs the ask with its tool_use (correlation for path telemetry)
      agentId?: string; // request.agent_id — present ONLY when the ask fired inside a sub-agent (binary-verified hook/request schema)
      decisionReason?: string; // request.decision_reason — the SDK's suggested deny reason (e.g. the workingDir constant)
      decisionReasonType?: string; // request.decision_reason_type (e.g. "workingDir")
    }
  // toolUseId (the `toolu_…` id, distinct from the UUID `id`/request_id) pairs this gate with its
  // tool_result for delivery verification + `trace --view questions`.
  | { id: string; kind: "question"; questions: QSpec[]; toolUseId?: string }
  | { id: string; kind: "dialog"; dialogKind: string; payload: unknown } // request_user_dialog (~6s auto-cancel)
  | { id: string; kind: "elicit"; server?: string; prompt?: string; schema?: unknown }; // elicitation / side_question
export type DecisionResponse =
  // `grant` is a WEB_FETCH-LOCAL, OFF-WIRE field (once = this fetch only; domain = approve the whole host
  // for the run). web_fetch approval is host-synthesized (Run's decideWebFetchDomain) and never serialized,
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
  | {
      type: "tool_result";
      toolUseId?: string;
      isError: boolean;
      text: string;
      provenanceText?: string;
      assertText?: string;
      assertTextTruncated?: boolean; // assertText was cut at the 10 KB assert cap — a substring search past the cut is unverifiable, not absent (#9)
      textBlocks?: string[];
    } // the OUTCOME of a tool call (from `user`/tool_result blocks). `text` is display-truncated; `provenanceText` is the larger raw value so URLs past the display cap still seed web_fetch provenance; `assertText` is assertion-fidelity cap (10 KB); `textBlocks` is the UNFLATTENED per-block text array (undefined for a string/non-array content, or an array with no text blocks) — `text`/`assertText`/`provenanceText` join a multi-block content array with a single space, losing per-entry boundaries a multi-file tool result (e.g. present_files, one path per input file) needs preserved
  | {
      type: "subagent_dispatch";
      toolUseId: string;
      parentToolUseId?: string;
      dispatchAgentType: string; // the DISPATCH-INPUT type ("unknown" when the input omitted subagent_type); the BINARY-resolved type (incl. the general-purpose fallback) arrives later on the record via task_started — see RunRecord.subagents[].resolvedAgentType
      typeOmitted: boolean; // the dispatch input carried no subagent_type key at all (proven by the full input parse, never a prefix grep) — a deliberate explicit "general-purpose" is NOT this
      declaredTools: string[];
      description?: string;
      prompt?: string; // input.prompt, assertText-capped
      dispatchModel?: string; // the DISPATCHING message's model (ex-"model" — renamed when resolvedModel landed beside it on RunResult.subagents[])
    } // parentToolUseId = nesting, for the dispatch tree.
  | {
      // The dispatch's paired result envelope: `tool_use_result` on the `user` message carries the
      // RESOLVED child metadata (resolvedModel/agentId/agentType/status) — a TOP-LEVEL sibling of
      // `message`, previously discarded entirely (only content blocks were parsed). Keyed by the first
      // tool_result block's id so it joins onto the matching `subagent_dispatch` by toolUseId.
      type: "subagent_result_meta";
      toolUseId: string;
      resolvedModel?: string;
      agentId?: string;
      agentType?: string;
      status?: string;
    }
  | { type: "thinking"; text: string; model?: string } // model set only when this thinking block came from an assistant message (not the system-subtype "thinking" event, which has no message.model)
  | { type: "metrics"; data: Record<string, unknown> } // api_metrics → cost
  | { type: "decision"; request: DecisionRequest }
  | {
      type: "result";
      isError: boolean;
      usage?: Record<string, unknown>;
      resultText?: string;
      subtype?: string; // resultText/subtype carry the SDK result payload so a transport-error result can be classified
      apiErrorStatus?: number; // HTTP status of an API error (429 + terminal usage-limit text ⇒ quota exhausted)
      costUsd?: number; // SDK's total_cost_usd for this invocation (was dropped on the floor before)
      numTurns?: number; // SDK's num_turns for this invocation (was dropped on the floor before)
      // per-model cost/token breakdown, cumulative for the whole run — a TOP-LEVEL sibling of `usage` on
      // the raw result message, NOT nested inside it (empirically confirmed against a real captured
      // stream). Opaque per-entry shape (SDK-owned); RunResult types it more precisely.
      modelUsage?: Record<string, Record<string, unknown>>;
    }
  | { type: "error"; source: "spawn" | "agent" | "protocol" | "exit"; message: string }
  | { type: "infra_error"; message: string } // an infrastructure frame (e.g. VM/egress sidecar crash) appended to events.jsonl outside the SDK stream
  | { type: "raw"; line: string }
  | { type: "system_event"; subtype: string; data: Record<string, unknown> } // a `system` message we don't special-case (e.g. compact_boundary)
  | { type: "mcp_error"; server: string; code?: number; message: string } // an MCP round-trip the harness answered with a JSON-RPC error
  | {
      type: "hook_event";
      callbackId: string;
      decision: "block" | "allow";
      reason?: string;
      tool?: string;
      paths?: { file_path?: string; path?: string }; // BOTH keys the VM path-gate scans (pretooluse-path-hook.ts) — never first-match-only
      toolUseId?: string; // msg.request.tool_use_id — a SIBLING of `input` on the hook_callback request, NOT inside it
      agentId?: string; // input.agent_id — present only when the hook fired inside a sub-agent
    }; // a PreToolUse hook fired

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

/** Outcome of `respond()`: whether the answer actually reached its destination (the live agent's
 *  stdin, or — on replay — the recording). `delivered:false` means the answer was NOT applied, so the
 *  caller must NOT record it as "answered". Deliberately a status return, never a throw: a late answer
 *  racing session teardown is a normal shutdown condition, not an error.
 *
 *  CAVEAT (LiveAgentSession only): `delivered:true` here means the control_response frame was
 *  successfully QUEUED, NOT that the child's stdin write callback actually confirmed it — that
 *  confirmation lands asynchronously in `pump()`, after `respond()` (a synchronous method on this
 *  interface, per every current caller) has already returned. A pipe that dies between the queue and
 *  the actual OS write (EPIPE) is therefore reported `delivered:true` optimistically, then recorded as
 *  `control_undelivered` in events.jsonl a tick later. Making `respond()` itself awaitable would give
 *  the correct answer but ripples into every `AgentSession` consumer that reads `.delivered`
 *  synchronously today; short of that, the OPTIONAL `hasUndeliveredReconciliation(decisionId)` method
 *  below (implemented by `LiveAgentSession`, omitted by replay sessions — it doesn't force that ripple on
 *  any other implementer) lets a caller that needs ground truth reconcile the optimistic answer after the
 *  fact instead of trusting it blindly. `Run.drive()` (run.ts) is that caller today. */
export type DecisionDelivery = { delivered: boolean; reason?: "session-closing" | "unknown-decision" };

export interface AgentSession {
  /** write `initialize` before the first user turn (idempotent; `start()` also calls it).
   *  Optional — replay sessions (cassette) have no live control channel and omit it. */
  init?(opts?: { subagentAppend?: string; sdkMcp?: SdkMcp; hooks?: HookBundle; toolAliases?: Record<string, string> }): void;
  start(opts?: {
    subagentAppend?: string;
    sdkMcp?: SdkMcp;
    hooks?: HookBundle;
    toolAliases?: Record<string, string>;
  }): AsyncIterable<AgentEvent>;
  sendUserTurn(text: string): void;
  respond(decisionId: string, r: DecisionResponse): DecisionDelivery;
  close(): void;
  /** Forcibly terminate the agent process (wall-clock timeout). Unlike `close()` (which only ends stdin
   *  and lets a well-behaved agent exit), this SIGTERMs the child — tier-agnostic, since the child is
   *  whatever was spawned (docker/limactl/native). Optional: replay/mock sessions have no live process. */
  kill?(): void;
  /** Ground truth for a `respond()` answer that was reported `delivered:true` optimistically (see
   *  `DecisionDelivery`'s doc comment above): true iff the control_response frame for `decisionId` was
   *  later confirmed to have NEVER reached the child (an async EPIPE/destroyed-pipe write failure
   *  discovered after `respond()` already returned). Optional and NOT implemented by every session on
   *  purpose — only a session with a live stdin pipe (`LiveAgentSession`) can discover this after the
   *  fact; a replay/cassette session has no live pipe to fail, so it omits this method entirely and a
   *  caller's `?.()` call reads `undefined` (nothing to reconcile — correct, a frozen cassette can't
   *  produce a fresh write failure). A caller that needs ground truth (rather than the synchronous
   *  best-effort `respond()` signal) should call this defensively, once the stream has settled, for every
   *  decisionId it optimistically recorded as delivered. */
  hasUndeliveredReconciliation?(decisionId: string): boolean;
}

// ---- Protocol ingress validation (fail-closed) ----
/** Every control_request that the driver answers carries a non-empty string `request_id` — it is the
 *  address the control_response is written back to. A missing / non-string / empty id means the agent sent
 *  a malformed control frame; reject LOUDLY rather than echoing an unusable id into a response envelope
 *  (which the in-VM agent could never match → it blocks until timeout). Shared by every control-request
 *  branch (mcp_message, hook_callback, decision) so none can drift into trusting an unchecked id. */
function requireRequestId(msg: any): string {
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
function allowEnvelope(requestId: string, updatedInput: Record<string, unknown>) {
  return successEnvelope(requestId, { behavior: "allow", updatedInput });
}
function denyEnvelope(requestId: string, message: string) {
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

/** Map a hook reply body (built-in `hookOutput` result OR a custom bundle reply) + the request input
 *  into a hook_event. A reply carrying `decision:"block"` (or `hookSpecificOutput.permissionDecision:"deny"`)
 *  is a block; anything else is allow. `tool` is the gated tool name from the request input. Shared by the
 *  live emit and the replay reconstruction so both classify a block identically. */
export function hookEventFrom(
  callbackId: string,
  reply: Record<string, unknown> | undefined,
  input: any,
  toolUseId?: string, // = msg.request.tool_use_id — a SIBLING of `input` on the request, NOT inside it
): {
  type: "hook_event";
  callbackId: string;
  decision: "block" | "allow";
  reason?: string;
  tool?: string;
  paths?: { file_path?: string; path?: string };
  toolUseId?: string;
  agentId?: string;
} {
  const r = reply ?? {};
  const nested = (r.hookSpecificOutput ?? {}) as Record<string, unknown>;
  const isBlock = r.decision === "block" || nested.permissionDecision === "deny";
  const reason =
    typeof r.reason === "string"
      ? r.reason
      : typeof nested.permissionDecisionReason === "string"
        ? (nested.permissionDecisionReason as string)
        : undefined;
  const tool = typeof input?.tool_name === "string" ? input.tool_name : undefined;
  // BOTH path keys — the VM path-gate scans file_path AND path (pretooluse-path-hook.ts:92-107) and
  // denies on whichever is a /sessions path, so recording only the first would mis-report a
  // {file_path:"/allowed", path:"/sessions/x"} call as "/allowed".
  const ti = (input?.tool_input ?? {}) as Record<string, unknown>;
  const paths: { file_path?: string; path?: string } = {};
  if (typeof ti.file_path === "string") paths.file_path = ti.file_path;
  if (typeof ti.path === "string") paths.path = ti.path;
  const agentId = typeof input?.agent_id === "string" ? input.agent_id : undefined; // inside the hook input, present only within a sub-agent
  return {
    type: "hook_event",
    callbackId,
    decision: isBlock ? "block" : "allow",
    reason,
    tool,
    paths: paths.file_path !== undefined || paths.path !== undefined ? paths : undefined,
    toolUseId,
    agentId,
  };
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
const CONTROL_OUT_MIRROR_CAP = 256 * 1024;

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
  // `decisionId` is only set for a control_response written by `respond()` — it's how a later
  // `pump()` write failure gets traced back to the decision that was already optimistically reported
  // `delivered:true` (see DecisionDelivery's doc comment + `hasUndeliveredReconciliation`).
  private writeQueue: { line: string; decisionId?: string }[] = [];
  private pumping = false;
  private queueIdle?: () => void;
  private closing = false;
  /** DecisionIds whose `respond()`-written control_response frame was optimistically reported
   *  `delivered:true` but whose actual stdin write later failed (EPIPE / destroyed pipe) — populated by
   *  `recordUndelivered()`. See `hasUndeliveredReconciliation`'s doc comment. */
  private reconciledUndelivered = new Set<string>();

  constructor(
    private proc: ChildProcessByStdio<Writable, Readable, Readable>,
    outDir: string,
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
  init(opts: { subagentAppend?: string; sdkMcp?: SdkMcp; hooks?: HookBundle; toolAliases?: Record<string, string> } = {}): void {
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
    // Production's host-loop-only tool alias map (Bash→mcp__workspace__bash, WebFetch→mcp__workspace__web_fetch)
    // — omitted entirely (not an empty object) when the caller passes none, so container/microvm's
    // initialize request is byte-identical to before this option existed.
    if (opts.toolAliases && Object.keys(opts.toolAliases).length) initRequest.toolAliases = opts.toolAliases;
    this.write({ type: "control_request", request_id: "init-1", request: initRequest });
  }

  async *start(
    opts: { subagentAppend?: string; sdkMcp?: SdkMcp; hooks?: HookBundle; toolAliases?: Record<string, string> } = {},
  ): AsyncIterable<AgentEvent> {
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
        yield hookEventFrom(
          callbackId,
          out,
          msg.request.input,
          typeof msg.request.tool_use_id === "string" ? msg.request.tool_use_id : undefined,
        );
        return;
      }
      const builtInOut = hookOutput(callbackId, msg.request.input);
      this.write(successEnvelope(reqId, builtInOut));
      yield hookEventFrom(
        callbackId,
        builtInOut,
        msg.request.input,
        typeof msg.request.tool_use_id === "string" ? msg.request.tool_use_id : undefined,
      );
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
          this.write(mcpResponseEnvelope(reqId, out as any, jr.id));
          yield { type: "mcp_error", server, code: -32603, message: `handler error: ${message}` };
          return;
        }
        // `notify` is a driver-side follow-up, NOT part of the JSON-RPC response — strip it before
        // building the wire envelope (otherwise it leaks into the mcp_response the agent receives), then
        // inject it separately as a synthetic user turn below.
        const { notify, ...rpc } = out as { result?: unknown; error?: { code: number; message: string }; notify?: string };
        this.write(mcpResponseEnvelope(reqId, rpc, jr.id));
        // A cowork present_files promotion returns a notifySession follow-up — inject it as a synthetic user
        // turn so the agent learns the promoted outputs path (mirrors the real host's post-promotion notification).
        if (typeof notify === "string" && notify) {
          this.write({ type: "user", message: { role: "user", content: [{ type: "text", text: notify }] } });
        }
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
      yield { type: "mcp_error", server, code: -32601, message: "no sdkMcp handler configured" };
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

  respond(decisionId: string, r: DecisionResponse): DecisionDelivery {
    const req = this.reqById.get(decisionId);
    if (!req) {
      // an id with no matching request_id is a protocol drift. Writing a guessed envelope would
      // be worse, but a silent return leaves the agent blocked until timeout (looks like a hang).
      warn(
        `::warning:: respond() for unknown decision id "${decisionId}" — no matching request_id was seen; the agent may block until timeout (protocol drift)\n`,
      );
      return { delivered: false, reason: "unknown-decision" };
    }
    // serializeDecision returns a safe deny envelope on a kind mismatch (defense in depth). That
    // deny goes to the agent silently today — surface it loudly so the run record can't read "answered"
    // while the agent actually received a deny. (serializeDecision stays a pure declared inverse of
    // deserializeDecision; the warning lives here in the caller, not in the pure function.)
    if (req.kind !== r.kind)
      warn(
        `::warning:: decider returned kind "${r.kind}" for a "${req.kind}" request (id ${decisionId}) → sending a safe deny/cancel; the agent did NOT receive an answer\n`,
      );
    // `decisionId` tags the queued frame so a later write failure in pump() (an async EPIPE — see
    // DecisionDelivery's doc comment) can be traced back to this decision and reconciled via
    // `hasUndeliveredReconciliation`, even though the `delivered:true` returned below is only a
    // synchronous "queued successfully" signal, not stdin write confirmation.
    const delivered = this.write(serializeDecision(req, r), decisionId);
    // Invariant: each decision id is answered at most once. Delete after the write so stale
    // entries don't accumulate (live sessions may process thousands of decisions per run).
    this.reqById.delete(decisionId);
    // If the session was already draining, write() discarded the frame — report non-delivery so the
    // caller records the truth instead of a false "answered".
    return delivered ? { delivered: true } : { delivered: false, reason: "session-closing" };
  }

  /** True once a `respond()`-written control_response for `decisionId` is confirmed to have NEVER
   *  reached the child (an async EPIPE/destroyed-pipe failure discovered in `pump()` after `respond()`
   *  already returned `{delivered:true}` — see DecisionDelivery's doc comment for why `respond()` can't
   *  just wait for this itself). Declared OPTIONAL on the `AgentSession` interface (not required) so
   *  `respond()` stays synchronous (every current caller reads `.delivered` immediately) and a
   *  replay/cassette session — with no live pipe to ever fail — need not implement it; `Run.drive()`
   *  calls it defensively (`this.session.hasUndeliveredReconciliation?.(id)`) once the stream has settled,
   *  to reconcile every decision it optimistically recorded as delivered against this ground truth. */
  hasUndeliveredReconciliation(decisionId: string): boolean {
    return this.reconciledUndelivered.has(decisionId);
  }

  close(): void {
    try {
      this.proc.stdin.end();
    } catch {
      /* already gone */
    }
  }

  kill(): void {
    try {
      this.proc.kill("SIGTERM");
      // Escalate to SIGKILL if the child ignores SIGTERM (unref so the timer can't keep the process alive).
      setTimeout(() => {
        try {
          if (this.proc.exitCode === null && this.proc.signalCode === null) this.proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, 2000).unref?.();
    } catch {
      /* already gone */
    }
  }

  /** Record that `frame` never reached the child's stdin. When it came from `respond()` (carries
   *  `decisionId`), first mark that decision reconciled-undelivered (see
   *  `hasUndeliveredReconciliation`'s doc comment) so the optimistic `delivered:true` `respond()`
   *  already returned can be overridden by a caller that checks — THEN write the `_emu:
   *  "control_undelivered"` marker (unchanged shape, plus the new `decisionId` field when present). */
  private recordUndelivered(frame: string, decisionId?: string): void {
    if (decisionId) this.reconciledUndelivered.add(decisionId);
    this.events.write(JSON.stringify({ _emu: "control_undelivered", frame, ...(decisionId ? { decisionId } : {}) }) + "\n");
  }

  private write(obj: unknown, decisionId?: string): boolean {
    const line = JSON.stringify(obj);
    if (this.closing) return false; // session draining — discard silently (caller reads the false return)
    // check stream writability before writing — a closed/destroyed stdin after a child crash
    // loses decision frames silently. Throw immediately so callers surface the failure rather than
    // hanging or silently dropping frames.
    if (this.proc.stdin.destroyed || !this.proc.stdin.writable)
      throw new Error("control-protocol write failed: child stdin is no longer writable (process may have crashed)");
    // `decisionId` is threaded through to pump() ONLY so an async write failure discovered later can be
    // traced back to the decision that this frame answers (see DecisionDelivery's doc comment on why
    // `respond()` itself can't wait for that confirmation).
    this.writeQueue.push({ line: line + "\n", decisionId });
    void this.pump().catch((err) => {
      // Route unexpected pump errors through rejectError so they surface as a typed error + clean
      // teardown instead of a silent hang. Known failure modes call rejectError themselves before
      // the pump returns, so this only fires on unanticipated throws.
      if (this.rejectError) this.rejectError(err instanceof Error ? err : new Error(String(err)));
    });
    return true;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.writeQueue.length) {
        const { line: frame, decisionId } = this.writeQueue.shift()!;
        if (this.proc.stdin.destroyed || !this.proc.stdin.writable) {
          this.recordUndelivered(frame, decisionId);
          if (this.rejectError) this.rejectError(new Error("stdin no longer writable while draining queue"));
          while (this.writeQueue.length) {
            const remaining = this.writeQueue.shift()!;
            this.recordUndelivered(remaining.line, remaining.decisionId);
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
          this.recordUndelivered(frame, decisionId);
          if (this.rejectError) this.rejectError(writeErr);
          while (this.writeQueue.length) {
            const remaining = this.writeQueue.shift()!;
            this.recordUndelivered(remaining.line, remaining.decisionId);
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
          this.recordUndelivered(remaining.line, remaining.decisionId);
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

/** Validate one of the `system/init` frame's optional array fields (`tools`, `mcp_servers`, `skills`).
 *  Previously each field was defaulted with `?? []`, which only guards against `null`/`undefined` — a
 *  non-array scalar or object (a malformed/misbehaving agent build) survived untouched into the `init`
 *  AgentEvent, and `Run.drive` later does `ev.skills.map(...)` → an uncaught TypeError, not a typed
 *  protocol failure. Throwing here (mirroring `requireRequestId` / the AskUserQuestion `questions` check
 *  above) converts a malformed field into a typed protocol error at both call sites that already catch a
 *  `parseMessage` throw (`LiveAgentSession.start`'s try/catch around `translate()`, and
 *  `CassetteAgentSession.start`'s per-line catch in cassette.ts). */
function requireInitArray(msg: Record<string, unknown>, field: string): unknown[] {
  const v = msg[field];
  if (v === undefined) return [];
  if (!Array.isArray(v))
    throw new Error(`control-in: malformed system/init frame: "${field}" must be an array, got ${v === null ? "null" : typeof v}`);
  return v;
}

/** Pure translation of one parsed stream-json message → AgentEvents (no side-effects). Shared by
 *  LiveAgentSession and CassetteAgentSession. mcp_message is handled by Live before this is called. */
export function parseMessage(msg: any): AgentEvent[] {
  const ev: AgentEvent[] = [];
  switch (msg.type) {
    case "infra_error":
      // An infrastructure frame (VM/egress sidecar crash) appended to events.jsonl by the runtime, outside
      // the SDK stdout stream. Preserved in the frozen cassette, so the replay re-drive re-derives it too.
      ev.push({ type: "infra_error", message: typeof msg.message === "string" ? msg.message : "infrastructure error" });
      break;
    case "system":
      if (msg.subtype === "init")
        ev.push({
          type: "init",
          tools: requireInitArray(msg, "tools") as string[],
          mcpServers: requireInitArray(msg, "mcp_servers"),
          skills: requireInitArray(msg, "skills") as string[],
          cwd: msg.cwd,
        });
      else if (msg.subtype === "api_metrics") ev.push({ type: "metrics", data: msg });
      else if (msg.subtype === "thinking") ev.push({ type: "thinking", text: String(msg.content ?? "") });
      else if (typeof msg.subtype === "string")
        // Any other system subtype (compact_boundary, and anything a future build adds) is surfaced
        // structurally instead of dropped. `data` carries the raw message minus the type/subtype envelope.
        ev.push({ type: "system_event", subtype: msg.subtype, data: systemEventData(msg) });
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
      for (const rawBlock of msg.message?.content ?? []) {
        // A content-array entry that isn't an object (null, a bare number/string — a malformed/corrupt
        // frame) previously reached `block.parent_tool_use_id`/`block.type` etc. unguarded; most of
        // those accesses silently return undefined for a primitive, but `block === null` throws
        // immediately ("Cannot read properties of null"). Validate once, up front, and turn a malformed
        // block into a typed protocol error (same throw-and-catch convention as
        // requireRequestId/requireInitArray) instead of an uncaught TypeError.
        if (!rawBlock || typeof rawBlock !== "object")
          throw new Error(
            `control-in: malformed assistant content block at index ${blockIndex}: expected an object, got ${rawBlock === null ? "null" : typeof rawBlock}`,
          );
        const block = rawBlock as Record<string, any>;
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
          // Normalize BEFORE the `in` check below: `block.input ?? {}` only guards null/undefined, so a
          // non-object input (e.g. a bare number `42`) survived as-is and `"subagent_type" in inp` threw
          // ("Cannot use 'in' operator to search for 'subagent_type' in 42"). A scalar/array input isn't
          // itself malformed — it just can never BE a dispatch — so normalizing to `{}` here (without
          // throwing) correctly falls through to "not a dispatch" instead of crashing. The raw
          // `block.input` above (in the `tool_use` AgentEvent) is left untouched.
          const inp = block.input && typeof block.input === "object" ? (block.input as Record<string, unknown>) : {};
          if (block.name === "Agent" || block.name === "Task" || "subagent_type" in inp) {
            const declared = Array.isArray(inp.tools)
              ? (inp.tools as unknown[]).map(String)
              : Array.isArray(inp.allowedTools)
                ? (inp.allowedTools as unknown[]).map(String)
                : []; // the `Agent` tool declares no tools list → []; declared-but-unused is legacy-`Task`-only
            // When block.id is absent, synthesize a fallback to avoid collapsing all anonymous dispatches
            // into the empty-string identity (which breaks dispatch tracking). The fallback keys off the
            // ASSISTANT MESSAGE's id (stable and unique per message) plus the intra-message blockIndex — so
            // it is unique across messages AND deterministic across record→replay (the message id is frozen
            // in the cassette bytes). A process-lifetime counter would be unique but would synthesize a
            // DIFFERENT id on replay, breaking the timeline↔subagent join (attributedSkillId) that keys on
            // the exact toolUseId. `msg.uuid` is a defensive secondary key; "anon" only for a synthetic
            // frame carrying neither (never a real stream).
            const msgKey = String(msg.message?.id ?? msg.uuid ?? "anon");
            const toolUseId = block.id ? String(block.id) : `unpaired-${msgKey}-b${blockIndex}`;
            ev.push({
              type: "subagent_dispatch",
              toolUseId,
              parentToolUseId,
              // Skills often dispatch with only {description, prompt} (no subagent_type) → dispatchAgentType
              // is "unknown" but the description still identifies the dispatch (e.g. "TOP_DOWN market sizing").
              dispatchAgentType: String(inp.subagent_type ?? inp.subagentType ?? "unknown"),
              // Parse-time fact from the FULL input parse (never a prefix grep): the dispatch input carried
              // neither key at all. Distinguishes an omitted type (the wildcard-fallback trap — the binary
              // resolves it to general-purpose with tools:["*"]) from an EXPLICIT subagent_type:"general-purpose"
              // (a deliberate choice, not a trap).
              typeOmitted: !("subagent_type" in inp) && !("subagentType" in inp),
              declaredTools: declared,
              description: inp.description != null ? String(inp.description) : undefined,
              prompt: inp.prompt != null ? toolResultAssertText(String(inp.prompt)) : undefined,
              dispatchModel: model,
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
      // recorder/trace. Capture them for delivery verification + `trace --view tools`/`--view questions`.
      //
      // The dispatch's paired result envelope: tool_use_result carries the RESOLVED child metadata
      // (resolvedModel/agentId/agentType/status) as a TOP-LEVEL sibling of message — previously
      // discarded (only content blocks were parsed). Keyed by the first tool_result block's id.
      {
        const env = msg.tool_use_result;
        if (env && typeof env === "object" && !Array.isArray(env)) {
          const blocks = Array.isArray(msg.message?.content) ? msg.message.content : [];
          const tr = blocks.find(
            (b: Record<string, unknown> | null) => b && typeof b === "object" && (b as Record<string, unknown>).type === "tool_result",
          );
          const toolUseId =
            tr && (tr as Record<string, unknown>).tool_use_id ? String((tr as Record<string, unknown>).tool_use_id) : undefined;
          const e = env as Record<string, unknown>;
          const has = typeof e.resolvedModel === "string" || typeof e.agentType === "string" || typeof e.status === "string";
          if (toolUseId && has)
            ev.push({
              type: "subagent_result_meta",
              toolUseId,
              resolvedModel: typeof e.resolvedModel === "string" ? e.resolvedModel : undefined,
              agentId: typeof e.agentId === "string" ? e.agentId : undefined,
              agentType: typeof e.agentType === "string" ? e.agentType : undefined,
              status: typeof e.status === "string" ? e.status : undefined,
            });
        }
      }
      for (const block of msg.message?.content ?? []) {
        // Guard a non-object content entry (null/scalar — a malformed/corrupt frame): `block.type` on a
        // primitive silently returns undefined, but `block === null` throws. Mirror the assistant loop's
        // up-front object check so a bad user block is skipped, not a crash. #2
        if (!block || typeof block !== "object") continue;
        if (block.type === "tool_result") {
          const provText = toolResultRaw(block.content);
          ev.push({
            type: "tool_result",
            toolUseId: block.tool_use_id ? String(block.tool_use_id) : undefined,
            isError: !!block.is_error,
            text: toolResultText(block.content),
            provenanceText: provText,
            assertText: toolResultAssertText(block.content),
            // The assert-fidelity value was cut iff the fuller provenance flatten already exceeds the assert
            // cap (same join, wider slice) — carry the flag so a content assertion against a subagent's
            // capped output can report "cannot verify" instead of a false absence past the cut. #9
            assertTextTruncated: provText.length > ASSERT_TEXT_CAP,
            textBlocks: toolResultTextBlocks(block.content),
          });
        }
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
        // HTTP status of the API error on an is_error result (401/403/413/429/529). 429 + a terminal
        // usage-limit message ⇒ quota exhausted (classified as usage_limit, distinct from a transient 429).
        apiErrorStatus: typeof msg.api_error_status === "number" ? msg.api_error_status : undefined,
        costUsd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : undefined,
        numTurns: typeof msg.num_turns === "number" ? msg.num_turns : undefined,
        modelUsage:
          msg.modelUsage && typeof msg.modelUsage === "object" ? (msg.modelUsage as Record<string, Record<string, unknown>>) : undefined,
      });
      break;
  }
  return ev;
}

/** The raw system message minus its `type`/`subtype` envelope — the event-specific payload. */
function systemEventData(msg: Record<string, unknown>): Record<string, unknown> {
  const { type: _t, subtype: _s, ...rest } = msg;
  return rest as Record<string, unknown>;
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
const ASSERT_TEXT_CAP = 10_240;
function toolResultAssertText(content: unknown): string {
  return flattenToolResult(content, ASSERT_TEXT_CAP);
}
/** The raw per-block text array, UNFLATTENED — undefined for a string/non-array content, or an
 *  array with no `type:"text"` blocks. `flattenToolResult` joins every block's text with a single
 *  space, which is fine for display/assertion but loses per-entry boundaries for a tool whose result
 *  is genuinely one entry per input (e.g. present_files: one path per presented file, in order). */
function toolResultTextBlocks(content: unknown): string[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const texts = content
    .filter((b): b is { type: string; text: unknown } => !!b && typeof b === "object" && (b as Record<string, unknown>).type === "text")
    .map((b) => String(b.text));
  return texts.length ? texts : undefined;
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
    return {
      id,
      kind: "permission",
      tool,
      input: msg.request.input ?? {},
      toolUseId: msg.request.tool_use_id ? String(msg.request.tool_use_id) : undefined,
      agentId: msg.request.agent_id ? String(msg.request.agent_id) : undefined,
      decisionReason: typeof msg.request.decision_reason === "string" ? msg.request.decision_reason : undefined,
      decisionReasonType: typeof msg.request.decision_reason_type === "string" ? msg.request.decision_reason_type : undefined,
    };
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
