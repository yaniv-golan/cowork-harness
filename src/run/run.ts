import { warn } from "../io.js";
import { randomUUID } from "node:crypto";
import type { AgentSession, AgentEvent, DecisionRequest, DecisionResponse } from "../agent/session.js";
import type { UsageInfo, CostInfo } from "../types.js";
import { questionKey, questionLabel } from "../agent/session.js";
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

// Re-export the shared `normalizeHost` from run.ts's public surface. It used to be a private helper
// here (assert.ts needs it too); it now lives in boundary-paths.ts as the single source
// of truth, and is re-exported so existing `run.js` importers keep working.
export { normalizeHost };

/** the observable sub-agent dispatch tree (single owner = RunRecord). */
export interface SubagentDispatch {
  toolUseId: string;
  parentToolUseId?: string;
  agentType: string;
  declaredTools: string[];
  toolsUsed: string[];
  description?: string; // the dispatch's `description` — identifies it when the skill set no subagent_type
}

export interface DecisionRecord {
  kind: "tool" | "question" | "dialog" | "elicit";
  name: string;
  decision: string;
  by: string;
  model?: string; // decider model for by:"llm" gates — surfaced in gate provenance for auditability
  detail?: unknown;
  rationale?: string;
}

export interface RunRecord {
  runId: string;
  result: "success" | "error";
  // when result === "error", whether the error looks like a transport drop (connection closed after a
  // clean result) vs a genuine agent/skill failure. Undefined on success or unclassified errors.
  resultErrorKind?: "transport" | "agent";
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
  toolResults: { toolUseId?: string; isError: boolean; text: string; assertText?: string }[]; // captured tool OUTCOMES
  gateAnswers: { question: string; toolUseId?: string; answers: Record<string, string> }[]; // answered AskUserQuestion gates
  gateDeliveries: {
    question: string;
    delivered: boolean | null;
    error?: string;
    reason?: "ok" | "errored" | "unobserved" | "no-pairing-metadata";
  }[]; // did the answer reach the model? (null = unobserved or no-pairing-metadata)
  usage?: UsageInfo;
  cost?: CostInfo;
  skillsInvoked: string[]; // top-level Skill tool_use ids, in call order, duplicates kept (Wave 1 / E8 seam)
  models: string[]; // distinct model ids seen across assistant_text/tool_use/thinking events, first-seen order, deduped (§4.3, M2)
  thinking: { text: string }[]; // reasoning blocks, capped: last 50 × 10KB each (§4.5, M3)
  thinkingElided: number; // count of older thinking blocks dropped past the 50-block cap
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
): "transport" | "agent" {
  const isTransport = TRANSPORT_SIGNATURE.test(signature);
  if (source === "result") return isTransport ? "transport" : "agent";
  if (source === "exit") return sawSuccessResult && isTransport ? "transport" : "agent";
  return "agent";
}

/** Run: the turn loop + decision dispatch + RunRecord building. */
export class Run {
  private rec: RunRecord;
  private toolLog: { name: string; input: unknown }[] = [];
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
  ) {
    this.rec = {
      runId,
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

    try {
      outerLoop: for await (const ev of this.session.start(startOpts)) {
        for (const h of this.hooks) h.onEvent?.(ev);
        switch (ev.type) {
          case "init":
            this.rec.initTools = ev.tools;
            this.rec.cwd = ev.cwd;
            break;
          case "assistant_text":
            this.noteModel(ev.model);
            if (!ev.parentToolUseId) transcript.push(ev.text);
            break;
          case "tool_use": {
            this.noteModel(ev.model);
            if (ev.parentToolUseId) {
              // only count this as a sub-agent tool when its parent is a RECOGNIZED dispatch
              // (Agent/Task/subagent_type). Any parented tool_use carries a parentToolUseId, but
              // adding all of them to subagentTools over-counts and produces false positives/negatives
              // on subagent_tool_used / subagent_tool_absent. Scope to the same dispatch the per-subagent
              // toolsUsed push already uses.
              const sa = this.rec.subagents.find((s) => s.toolUseId === ev.parentToolUseId);
              if (sa) {
                this.rec.subagentTools.add(ev.name);
                if (!sa.toolsUsed.includes(ev.name)) sa.toolsUsed.push(ev.name);
              }
            } else if (!ev.synthetic) {
              // synthetic = the MCP round-trip echo; the real call already arrived as an assistant tool_use
              // block (live-verified), so counting the synthetic too would double-list it / add a bogus name.
              this.rec.toolsCalled.add(ev.name);
              this.rec.toolCounts[ev.name] = (this.rec.toolCounts[ev.name] ?? 0) + 1; // count top-level calls (subagent tools excluded, matching toolsCalled)
              // Wave 1 / E8: a top-level Skill invocation — duplicates kept (re-triggering is signal).
              if (ev.name === "Skill") this.rec.skillsInvoked.push(String((ev.input as Record<string, unknown> | undefined)?.skill ?? ""));
            }
            this.toolLog.push({ name: ev.name, input: ev.input }); // still logged for provenance/trace
            break;
          }
          case "tool_result": {
            this.rec.toolResults.push({ toolUseId: ev.toolUseId, isError: ev.isError, text: ev.text, assertText: ev.assertText });
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
              agentType: ev.agentType,
              declaredTools: ev.declaredTools,
              toolsUsed: [],
              description: ev.description,
            });
            break;
          case "metrics":
            // merge, don't overwrite — a "result" event may have already set/will later set `usd` (Wave 0 seam)
            this.rec.cost = { ...this.rec.cost, raw: ev.data };
            break;
          case "decision":
            this.rec.transcript = transcript.join("\n");
            await this.handleDecision(ev.request);
            break;
          case "result":
            if (ev.isError) {
              this.rec.result = "error";
              // path (a): the SDK wrapped a transport failure into an is_error result — the result IS the
              // signal (no prior-result gate). Classify off the SDK result payload + subtype.
              this.rec.resultErrorKind = classifyResultError("result", `${ev.subtype ?? ""} ${ev.resultText ?? ""}`, sawSuccessResult);
            } else {
              this.rec.result = "success";
              sawSuccessResult = true;
            }
            // Wave 0 seam: fold the SDK's num_turns into usage as `turns` (there is no dedicated turns
            // field) — only when there's something to report, so a bare `{isError:false}` result event
            // (still common in synthetic/older cassette events) leaves usage undefined, not a spurious {}.
            this.rec.usage =
              ev.usage || ev.numTurns !== undefined
                ? { ...ev.usage, ...(ev.numTurns !== undefined ? { turns: ev.numTurns } : {}) }
                : undefined;
            if (ev.costUsd !== undefined) this.rec.cost = { ...this.rec.cost, usd: ev.costUsd };
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
              this.rec.decisions.push({ kind: "tool", name: ev.source, decision: "error", by: "agent", detail: ev.message });
              this.session.close();
              break outerLoop;
            }
            this.rec.decisions.push({ kind: "tool", name: ev.source, decision: "error", by: "agent", detail: ev.message });
            break;
        }
      }
    } finally {
      // Guarantee stdin ends on EVERY exit path — including a clean EOF or a crash that emits no `result`
      // event (the inline close()s only cover result-done + spawn/protocol error). close() is idempotent
      // (it try/catches stdin.end), so the double-close on the normal paths is a safe no-op.
      this.session.close();
    }

    this.rec.transcript = transcript.join("\n");
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
    for (const h of this.hooks) h.finalize?.(this.rec);
    return this.rec;
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
    this.session.respond(req.id, decided.response);
    // serializeDecision rewrites a kind-mismatched response to a deny envelope (session.ts) — the agent
    // did NOT get the intended answer. Record the TRUTH ("mismatch→deny"), not "answered", and skip the
    // gateAnswers push (no answer was delivered). ✓ success ≠ correct. (the mismatch detection +
    // warning is the SHARED helper that the synthetic web_fetch path also uses.)
    if (isDecisionKindMismatch(req, decided.response, "permission")) {
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
      this.rec.decisions.push({ kind: "question", name: "AskUserQuestion", decision: "answered", by, model, detail: answers, rationale });
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
      this.rec.decisions.push({ kind: "tool", name: req.tool, decision: behavior ?? "?", by, rationale });
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
