import { randomUUID } from "node:crypto";
import type { AgentSession, AgentEvent, DecisionRequest, DecisionResponse } from "../agent/session.js";
import { questionKey, questionLabel } from "../agent/session.js";
import { ABSTAIN, UnansweredError, PERMISSIVE_AUTOALLOW_RATIONALE, type Decider, type RunContext } from "../decide/decider.js";
import { ProvenanceTracker } from "../hostloop/provenance.js";

/** A3: the observable sub-agent dispatch tree (single owner = RunRecord). */
export interface SubagentDispatch {
  toolUseId: string;
  parentToolUseId?: string;
  agentType: string;
  declaredTools: string[];
  toolsUsed: string[];
  description?: string; // the dispatch's `description` — identifies it when the skill set no subagent_type (O1)
}

export interface DecisionRecord {
  kind: "tool" | "question" | "dialog" | "elicit";
  name: string;
  decision: string;
  by: string;
  detail?: unknown;
  rationale?: string;
}

export interface RunRecord {
  runId: string;
  result: "success" | "error";
  initTools: string[];
  cwd?: string;
  transcript: string;
  toolsCalled: Set<string>;
  toolCounts: Record<string, number>; // O6: TRUTHFUL per-tool call count from the tool_use stream (top-level only)
  subagentTools: Set<string>;
  subagents: SubagentDispatch[];
  questions: string[];
  decisions: DecisionRecord[];
  permissiveAutoAllow: string[]; // #6: tools auto-allowed by cowork parity for unscripted/off-registry perms (real Cowork blocks these)
  unanswered: { question: string; chosen: string; by: string; rationale?: string; model?: string }[];
  toolResults: { toolUseId?: string; isError: boolean; text: string }[]; // Part 2: captured tool OUTCOMES
  gateAnswers: { question: string; toolUseId?: string; answers: Record<string, string> }[]; // answered AskUserQuestion gates
  gateDeliveries: {
    question: string;
    delivered: boolean | null;
    error?: string;
    reason?: "ok" | "errored" | "unobserved" | "no-pairing-metadata";
  }[]; // Part 3: did the answer reach the model? (null = unobserved or no-pairing-metadata)
  usage?: Record<string, unknown>;
  cost?: Record<string, unknown>;
}

export interface RunHooks {
  onEvent?(e: AgentEvent): void;
  finalize?(r: RunRecord): void;
}

const DIALOG_AUTOCANCEL_MS = 6000; // request_user_dialog host auto-cancel (Ch25/L108)

/** Seam 3 — Run: the turn loop + decision dispatch + RunRecord building. */
export class Run {
  private rec: RunRecord;
  private toolLog: { name: string; input: unknown }[] = [];
  // #30: per-session web_fetch provenance set. Run owns it (it sees user turns + tool_results) and
  // seeds it during drive(); the workspace handler reads membership + escalates misses via the Decider.
  private provenance = new ProvenanceTracker();
  // web_fetch per-DOMAIN approvals ("Allow all for website"). Per-Run, ephemeral (starts empty) — Phase 0
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
    };
  }

  private ctx(): RunContext {
    return { task: this.rec.transcript, transcript: () => this.rec.transcript, toolLog: () => this.toolLog, runId: this.rec.runId };
  }

  /** Drive one-shot (string) or multi-turn (async iterable) and return the record. */
  async drive(turns: string | AsyncIterable<string>, startOpts?: Parameters<AgentSession["start"]>[0]): Promise<RunRecord> {
    const turnIter = typeof turns === "string" ? oneShot(turns) : turns[Symbol.asyncIterator]();
    const transcript: string[] = [];

    // #45: write the `initialize` control_request BEFORE the first user turn, matching the SPEC wire
    // order (initialize precedes the user turn). Idempotent — `start()` also calls init(), and replay
    // (cassette) sessions omit init() entirely, so this is a no-op there.
    this.session.init?.(startOpts);
    // Prime the first user turn before reading the stream.
    const first = await turnIter.next();
    if (!first.done) {
      this.provenance.seedFromText(first.value); // #30: seed provenance from the user's prompt
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
            if (!ev.parentToolUseId) transcript.push(ev.text);
            break;
          case "tool_use": {
            if (ev.parentToolUseId) {
              // #15: only count this as a sub-agent tool when its parent is a RECOGNIZED dispatch
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
              this.rec.toolCounts[ev.name] = (this.rec.toolCounts[ev.name] ?? 0) + 1; // O6: count top-level calls (subagent tools excluded, matching toolsCalled)
            }
            this.toolLog.push({ name: ev.name, input: ev.input }); // still logged for provenance/trace
            break;
          }
          case "tool_result": {
            this.rec.toolResults.push({ toolUseId: ev.toolUseId, isError: ev.isError, text: ev.text });
            this.provenance.seedFromToolResult(ev.text); // #30: URLs in a prior result become fetchable
            // (matches Cowork's tool_response provenance hook)
            // Delivery check (Part 3): if this is the result of an answered gate and it ERRORED, the injected
            // answer never reached the model (the O7 q.map class). Surface it in real time — "resp consumed"
            // (file read) is NOT "delivered" (model received).
            if (ev.isError && ev.toolUseId) {
              const gate = this.rec.gateAnswers.find((g) => g.toolUseId === ev.toolUseId);
              if (gate)
                process.stderr.write(
                  `::warning:: [gate] DELIVERY FAILED for "${gate.question}" → tool error: ${ev.text.split("\n")[0].slice(0, 120)}\n`,
                );
            }
            break;
          }
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
            this.rec.cost = ev.data;
            break;
          case "decision":
            this.rec.transcript = transcript.join("\n");
            await this.handleDecision(ev.request);
            break;
          case "result":
            this.rec.result = ev.isError ? "error" : "success";
            this.rec.usage = ev.usage;
            {
              const next = await turnIter.next();
              if (next.done) this.session.close();
              else {
                this.provenance.seedFromText(next.value); // #30: seed provenance from each new user turn
                this.session.sendUserTurn(next.value);
              }
            }
            break;
          case "error":
            // #16: spawn/protocol errors are fatal — set result, close the session, and stop the loop.
            // source:"agent" is non-terminal (the SDK may still emit a recovering `result` event).
            // CRITICAL: set rec.result BEFORE break — gateDeliveries mapping runs after the loop exits.
            if (ev.source === "spawn" || ev.source === "protocol") {
              this.rec.result = "error";
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
    // Part 3: pair each answered gate with its tool_result (by toolUseId). delivered=true iff a non-error
    // result was observed; false iff it errored (O7 class); null if no result was observed (e.g. protocol
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

    // #48: an empty `questions` array would be "answered" with `{}` (scripted) and recorded as success —
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
    // offered options and joins; fallback terminals answer with a single (valid) member. See MULTISELECT in
    // docs/internal/harness-improvements-plan-2026-06-16.md.

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
    // gateAnswers push (no answer was delivered). ✓ success ≠ correct.
    if (decided.response.kind !== req.kind) {
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
    // #19: use .finally() so clearTimeout runs on BOTH resolve AND reject, preventing a timer
    // leak when the decider promise rejects (the race rejects but the setTimeout stays alive).
    return Promise.race([p.finally(() => clearTimeout(t)), timeout]);
  }

  private recordDecision(req: DecisionRequest, resp: any, by: string, rationale?: string, model?: string) {
    if (req.kind === "question") {
      this.rec.decisions.push({ kind: "question", name: "AskUserQuestion", decision: "answered", by, detail: resp.answers, rationale });
      // #18: for the human-readable label, include ALL questions — not just questions[0]. Single-question
      // gates produce the same output as before ("<question>"); multi-question gates produce
      // "<q1> / <q2>" so the label is accurate and traceable. The answers map is already complete.
      const label = req.questions.map(questionLabel).filter(Boolean).join(" / ") || "";
      // Record the answered gate (with its toolUseId) so finalize can pair it with the tool_result to
      // verify the answer actually reached the model (Part 3). Independent of `by` — delivery ≠ attribution.
      this.rec.gateAnswers.push({
        question: label,
        toolUseId: req.toolUseId,
        answers: resp.answers ?? {},
      });
      for (const [question, chosen] of Object.entries(resp.answers ?? {})) {
        if (by !== "scripted") this.rec.unanswered.push({ question, chosen: String(chosen), by, rationale, model });
      }
    } else if (req.kind === "permission") {
      this.rec.decisions.push({ kind: "tool", name: req.tool, decision: resp.behavior, by, rationale });
      // #6: a cowork-parity off-registry auto-allow is a SILENT false-green risk — real Cowork blocks
      // for the user. Make it loud (stderr) AND machine-distinguishable (rec.permissiveAutoAllow → the
      // envelope), so a green carrying one isn't mistaken for a faithful pass.
      if (resp.behavior === "allow" && by === "cowork" && rationale === PERMISSIVE_AUTOALLOW_RATIONALE) {
        this.rec.permissiveAutoAllow.push(req.tool);
        process.stderr.write(
          `::warning:: [permission] "${req.tool}" auto-allowed by cowork parity (unscripted, off-registry) — real Cowork would BLOCK for the user. Not a faithful pass; pin with --answer or set permission_parity: strict. (#6)\n`,
        );
      }
    } else {
      this.rec.decisions.push({ kind: req.kind, name: req.kind, decision: resp.behavior ?? resp.action ?? "?", by, rationale });
    }
  }

  // ── #30: web_fetch provenance, exposed to the workspace handler (via the bundle execute.ts builds) ──

  /** Pre-approve web_fetch hosts for this run (test convenience: `web_fetch.approved_domains`) — as if
   *  "Allow all for website" had been clicked earlier this session. Per-run only (no persistence). */
  seedApprovedDomains(domains: string[]): void {
    for (const d of domains) this.approvedDomains.add(d);
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
    // nothing (Phase 0: a 2nd fetch to an approved host does not re-prompt). Checked BEFORE the decider.
    if (this.approvedDomains.has(domain)) return true;
    const req: DecisionRequest = {
      id: `webfetch-${randomUUID()}`,
      kind: "permission",
      tool: `webfetch:${domain}`,
      input: { domain, url },
      options: [{ label: "Allow once" }, { label: "Allow all for website" }, { label: "Deny" }],
    };
    const d = await this.decider.decide(req, this.ctx());
    const allow = d !== ABSTAIN && d.response.kind === "permission" && d.response.behavior === "allow";
    const grant = d !== ABSTAIN && d.response.kind === "permission" ? d.response.grant : undefined;
    const by = d === ABSTAIN ? "fail" : d.by;
    // Pass the RESPONSE BODY + by (recordDecision reads resp.behavior) — not the whole Decision.
    const resp: DecisionResponse =
      d === ABSTAIN ? { kind: "permission", behavior: "deny", message: "no decider answer (fail-closed)" } : d.response;
    this.recordDecision(req, resp, by);
    // "Allow all for website" → approve the host for the rest of the run (off-wire; Run-side state).
    if (allow && grant === "domain") this.approvedDomains.add(domain);
    return allow;
  }
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
  // A question must never reach here — handleDecision fails loud above (C1). Defense in depth: never
  // fabricate an option-1 answer for a question.
  throw new UnansweredError("internal: a question reached the deny fallback", "this is a bug — a question must be answered or fail loud");
}

async function* oneShot(s: string): AsyncGenerator<string> {
  yield s;
}
