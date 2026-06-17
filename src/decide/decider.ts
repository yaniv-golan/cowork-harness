import { warn } from "../io.js";
import readline from "node:readline";
import type { AnswerRule } from "../types.js";
import type { DecisionRequest, DecisionResponse } from "../agent/session.js";
import type { DecisionChannel } from "./external-channel.js";
import { scrub } from "../secrets.js";
import { compileUserRegex } from "../regex.js";

/**
 * Seam 2 — Decider: policy for the agent's `decision` events. Deciders return a
 * `DecisionResponse` or `ABSTAIN` (the sentinel — never a throw for "not my job").
 * A real failure throws (e.g. `UnansweredError`). `Chain` walks links until one
 * returns non-ABSTAIN.
 */
export const ABSTAIN = Symbol("abstain");
export type Abstain = typeof ABSTAIN;

export interface RunContext {
  task: string;
  transcript(): string;
  toolLog(): { name: string; input: unknown }[];
  runId: string;
}

export interface Decision {
  response: DecisionResponse;
  by: "scripted" | "cowork" | "strict" | "human" | "llm" | "agent" | "external" | "first" | "fail" | "replay";
  rationale?: string;
  model?: string; // set by LlmDecider — surfaced in unanswered[].model for auditability
}

export interface Decider {
  decide(req: DecisionRequest, ctx: RunContext): Promise<Decision | Abstain>;
}

export class UnansweredError extends Error {
  constructor(
    message: string,
    public readonly hint: string,
  ) {
    super(message);
    this.name = "UnansweredError";
  }
}

/** Regex-escape question text for an actionable `--answer "<rx>=<choice>"` hint. */
function escapeRx(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function Chain(...deciders: Decider[]): Decider {
  return {
    async decide(req, ctx) {
      for (const d of deciders) {
        const r = await d.decide(req, ctx);
        if (r !== ABSTAIN) return r;
      }
      return ABSTAIN;
    },
  };
}

/** Scripted rules (`--answer`/`--answer-policy`/scenario `answers:`) → response, else ABSTAIN. */
export class ScriptedDecider implements Decider {
  constructor(private rules: AnswerRule[]) {}

  async decide(req: DecisionRequest, _ctx: RunContext): Promise<Decision | Abstain> {
    if (req.kind === "question") {
      const answers: Record<string, string> = {};
      const unmatched: string[] = []; // #4b: sub-questions no rule answered (named in the fallthrough warning)
      for (const q of req.questions) {
        const text = q.question ?? q.header ?? "";
        const rule = this.rules.find((r) => {
          if (!r.when_question) return false;
          const c = compileUserRegex(r.when_question);
          // Malformed pattern in a CLI-supplied rule (--answer/--answer-policy) — load-time validation
          // catches file-based scenarios; this guards the CLI path.
          if ("error" in c) throw new Error(`bad regex in when_question "${r.when_question}": ${c.error}`);
          return c.re.test(text);
        });
        if (!rule || (rule.choose === undefined && rule.answer === undefined)) {
          unmatched.push(text);
          continue;
        }
        if (rule.choose !== undefined && rule.answer !== undefined)
          throw new UnansweredError(
            `rule for "${text}" sets both choose and answer`,
            "use exactly one: choose: <label(s)> for an offered option, or answer: <text> for a free-text 'Other'",
          );
        // FREE-TEXT (#3): a free-text "Other" answer — an arbitrary string delivered verbatim, bypassing
        // label validation BY AUTHOR INTENT. Cowork auto-provides an "Other" free-text path on every gate
        // (binary-verified), so this is always faithful; `choose:` keeps the #49 label guard for the common case.
        if (rule.answer !== undefined) {
          answers[text] = rule.answer;
          continue;
        }
        // choose path — single label, or (multiSelect) a list of labels delivered comma-joined.
        const labels = q.options?.map((o) => o.label) ?? [];
        const picks = Array.isArray(rule.choose) ? rule.choose : [rule.choose!];
        if (picks.length > 1 && !q.multiSelect)
          throw new UnansweredError(
            `rule for "${text}" supplies ${picks.length} choices but the gate is single-select`,
            "use a single choose: value, or only supply a list for a multiSelect gate",
          );
        if (labels.length === 0) {
          // Degenerate gate with no options — nothing to validate against; pass the value(s) through.
          answers[text] = picks.join(", ");
          continue;
        }
        // #49: validate EACH chosen label against the offered options and deliver the CANONICAL label(s).
        // A member matching no option is a silent false-green (the run would record an impossible answer) —
        // fail loud, symmetric with the external/LLM terminals.
        const resolved = picks.map((p) => {
          const coerced = coerceLabel(p, labels);
          if (!coerced.matched)
            throw new UnansweredError(
              `scripted answer "${p}" for "${text}" matched no offered option`,
              `valid labels: ${labels.map((l) => JSON.stringify(l)).join(", ")}`,
            );
          return coerced.value;
        });
        // MULTISELECT comma-in-label hazard: the wire joins members with ", " WITHOUT escaping (binary-
        // verified), so a member label that itself contains a comma can't be unambiguously round-tripped.
        // This is a Cowork limitation, not ours — but silently joining it is a false-green, so warn loud.
        if (picks.length > 1) {
          const commaLabel = resolved.find((l) => l.includes(","));
          if (commaLabel)
            warn(
              `::warning:: multiSelect member label ${JSON.stringify(commaLabel)} for "${text}" contains a comma — the wire joins members with ", " WITHOUT escaping, so the model may re-read the selected set differently (Cowork limitation). Verify this gate.\n`,
            );
        }
        answers[text] = resolved.join(", ");
      }
      if (unmatched.length > 0) {
        // A gate's answers are delivered atomically — a partial scripted match cannot answer just one
        // sub-question, so the WHOLE gate falls through to the fallback. #4b: name the UNMATCHED
        // sub-questions (not just a count) so the author knows exactly which rule to add.
        if (Object.keys(answers).length > 0)
          warn(
            `::warning:: scripted rules answered ${Object.keys(answers).length}/${req.questions.length} sub-questions of this gate; UNMATCHED: ${unmatched
              .map((u) => JSON.stringify(u))
              .join(", ")} — the whole gate falls through to the fallback decider (answers are delivered atomically)\n`,
          );
        return ABSTAIN;
      }
      return { response: { kind: "question", answers }, by: "scripted" };
    }
    if (req.kind === "permission") {
      const rule = this.rules.find((r) => r.when_tool === req.tool);
      if (!rule) return ABSTAIN;
      let behavior: "allow" | "deny" = "deny";
      if (rule.decide) behavior = rule.decide;
      else if (rule.allow_if) behavior = evalPredicate(rule.allow_if, req.input) ? "allow" : (rule.else ?? "deny");
      return {
        response: {
          kind: "permission",
          behavior,
          ...(behavior === "allow" ? { updatedInput: req.input } : { message: "denied by scenario policy" }),
          // web_fetch grant scope (off-wire; only consumed by Run.requestWebFetchApproval). Default "once".
          ...(behavior === "allow" && req.tool.startsWith("webfetch:") ? { grant: rule.grant ?? "once" } : {}),
        },
        by: "scripted",
      };
    }
    return ABSTAIN; // dialog / elicit: scenario rules don't cover these
  }
}

// Read-only safe tools that never prompt. Must be a SUBSET of the Cowork toolset (baseline
// spawn.tools) — #7: `LS`/`NotebookRead`/`TodoWrite` were dropped (not in the Cowork toolset;
// spawn-contract line 17). Do NOT widen this to the full spawn.tools (it includes Bash/Edit/Write/
// Task), which would make strict parity allow Bash.
const DEFAULT_ALLOW = new Set(["Read", "Glob", "Grep"]);

/** #6: the rationale a cowork-parity off-registry auto-allow carries. Shared so run.ts can detect a
 *  permissive auto-allow (real Cowork would BLOCK for the user) without string-matching drift. */
export const PERMISSIVE_AUTOALLOW_RATIONALE = "allow-unscripted (cowork parity)";

/** Cowork/strict permission default: allow-unscripted (cowork) or deny (strict). Permission only. */
export class PermissionDefaultDecider implements Decider {
  constructor(private parity: "cowork" | "strict") {}
  async decide(req: DecisionRequest, _ctx?: RunContext): Promise<Decision | Abstain> {
    if (req.kind !== "permission") return ABSTAIN;
    // web_fetch on a provenance miss is a real user-gate in Cowork — handleToolPermission(`webfetch:<domain>`),
    // active by default on the 1p interactive tier (coworkWebFetchPrompt) — NOT a blanket auto-allow. Defer
    // to the terminal decider (scripted/prompt/llm; fail-closed otherwise) rather than greening it here. The
    // 3P-allowlist / scheduled-task tiers suppress that prompt and proceed, but the modeled baseline is 1p.
    if (req.tool.startsWith("webfetch:")) return ABSTAIN;
    if (DEFAULT_ALLOW.has(req.tool))
      return {
        response: { kind: "permission", behavior: "allow", updatedInput: req.input },
        by: this.parity,
        rationale: "default-allow built-in",
      };
    const allow = this.parity === "cowork";
    return {
      response: allow
        ? { kind: "permission", behavior: "allow", updatedInput: req.input }
        : { kind: "permission", behavior: "deny", message: "denied (strict, off-registry)" },
      by: this.parity,
      rationale: allow ? PERMISSIVE_AUTOALLOW_RATIONALE : "deny (strict parity)",
    };
  }
}

/** `fail` policy — throw with an actionable `--answer` hint. Terminal for questions. */
export class FailDecider implements Decider {
  async decide(req: DecisionRequest, _ctx?: RunContext): Promise<Decision | Abstain> {
    if (req.kind === "question") {
      const lines = req.questions.map((q) => {
        const text = q.question ?? q.header ?? "";
        const opts = q.options.map((o) => o.label).join(" | ");
        return `  • "${text}"  options: ${opts}\n    add: --answer "${escapeRx(text).slice(0, 40)}=<choice>"`;
      });
      throw new UnansweredError(`unscripted AskUserQuestion (on_unanswered=fail):\n${lines.join("\n")}`, lines.join("\n"));
    }
    if (req.kind === "dialog" || req.kind === "elicit") {
      throw new UnansweredError(
        `unanswered ${req.kind} request (on_unanswered=fail)`,
        "provide a decider or use --on-unanswered prompt|first",
      );
    }
    return ABSTAIN;
  }
}

/** `first` policy — pick option 1 (LOUDLY: warn + recorded). Dialog→cancel, elicit→decline. */
export class FirstOptionDecider implements Decider {
  async decide(req: DecisionRequest, _ctx?: RunContext): Promise<Decision | Abstain> {
    if (req.kind === "question") {
      const answers: Record<string, string> = {};
      for (const q of req.questions) {
        const text = q.question ?? q.header ?? "";
        if (q.options.length === 0)
          throw new UnansweredError(
            `question "${text}" has no options to pick from (--on-unanswered first)`,
            "the gate offered no options; a first-option policy cannot fabricate one",
          );
        const label = q.options[0].label;
        answers[text] = label;
        warn(`::warning:: unscripted question "${text}" → picked first option "${label}" (--on-unanswered first)\n`);
      }
      return { response: { kind: "question", answers }, by: "first", rationale: "first option (on_unanswered=first)" };
    }
    if (req.kind === "dialog")
      return { response: { kind: "dialog", behavior: "cancelled" }, by: "first", rationale: "auto-cancel (first)" };
    if (req.kind === "elicit") return { response: { kind: "elicit", action: "decline" }, by: "first", rationale: "auto-decline (first)" };
    return ABSTAIN;
  }
}

/** Pluggable model-completion transport (so LlmDecider is unit-testable without a real model call). */
export type Complete = (prompt: string, model: string) => Promise<string>;

/** Strict label match: exact → case-insensitive → contained-in-response. NULL on no match (caller fails
 *  loud — we deliberately do NOT fall back to option 1 like `coerceLabel`, which would silently mis-answer). */
export function matchLabel(raw: string, labels: string[]): string | null {
  const r = raw.trim();
  const exact = labels.find((l) => l === r) ?? labels.find((l) => l.toLowerCase() === r.toLowerCase());
  if (exact) return exact;
  // #6: the substring tier fires ONLY when EXACTLY ONE label is contained in the reply. With labels
  // ["No","Notation"] and reply "Notation", both the apex match and the contains-check used to pick
  // "No" (the first substring) — an ambiguous mis-steer. If two+ labels match (or none), return null so
  // the caller's UnansweredError fires (fail loud) rather than guessing the wrong option.
  const rl = r.toLowerCase();
  const substr = labels.filter((l) => rl.includes(l.toLowerCase()));
  return substr.length === 1 ? substr[0] : null;
}

/** Map a web_fetch approval answer (a grant-scope label, shorthand, or 1-based index) → {behavior, grant}.
 *  The ONLY label→grant map (off-wire, web_fetch-local). Throws loud on an unknown answer — NEVER a silent
 *  default-allow (the ethos's no-false-green rule). "domain" = "Allow all for website" (per-run host grant). */
export function coerceWebFetchGrant(answer: string): { behavior: "allow" | "deny"; grant?: "once" | "domain" } {
  const a = answer.trim().toLowerCase();
  if (a === "allow once" || a === "once" || a === "1") return { behavior: "allow", grant: "once" };
  if (a === "allow all for website" || a === "all" || a === "domain" || a === "2") return { behavior: "allow", grant: "domain" };
  if (a === "deny" || a === "3") return { behavior: "deny" };
  throw new UnansweredError(
    `web_fetch approval answer "${answer.trim().slice(0, 60)}" is not a valid grant option`,
    "expected one of: Allow once | Allow all for website | Deny",
  );
}

/**
 * `agent` policy — the LLM decider. Per live question, asks a small model to pick ONE option (by label,
 * never index — options reorder run-to-run), optionally steered by a one-line `--intent`. The ergonomic
 * default for agent-driven runs: state the test's meaning once instead of hand-writing a `--decider-cmd`
 * helper. NON-DETERMINISTIC by nature — `executeScenario` flags the run so a green LLM-steered pass can't
 * be mistaken for a scripted one. An out-of-set or unavailable answer FAILS LOUD (never a silent default).
 */
export class LlmDecider implements Decider {
  constructor(
    private complete: Complete,
    private intent?: string,
    private model: string = process.env.COWORK_HARNESS_DECIDER_MODEL || "claude-haiku-4-5-20251001",
  ) {}

  async decide(req: DecisionRequest, ctx?: RunContext): Promise<Decision | Abstain> {
    // Options-bearing permission (web_fetch approval): the LLM judges the stochastic gate and picks a grant
    // label. Ordinary (optionless) permissions → ABSTAIN (parity default handles them).
    if (req.kind === "permission") {
      if (!req.options) return ABSTAIN;
      const labels = req.options.map((o) => o.label);
      const raw = await this.complete(this.permPrompt(req, ctx), this.model);
      const pick = matchLabel(raw, labels);
      if (!pick)
        throw new UnansweredError(
          `LLM decider answer "${raw.trim().slice(0, 60)}" is not one of the options for "${req.tool}"`,
          `options were: ${labels.join(" | ")}`,
        );
      const { behavior, grant } = coerceWebFetchGrant(pick);
      process.stderr.write(`[llm-decider] ${req.tool} → "${pick}"${this.intent ? ` (intent: ${this.intent})` : ""}\n`);
      return {
        response: {
          kind: "permission",
          behavior,
          ...(behavior === "allow" ? { updatedInput: req.input, grant } : { message: "denied (llm)" }),
        },
        by: "llm",
        rationale: this.intent ?? "LLM judgment",
        model: this.model,
      };
    }
    if (req.kind !== "question") return ABSTAIN; // dialog/elicit → fail-closed terminal
    const answers: Record<string, string> = {};
    for (const q of req.questions) {
      const text = q.question ?? q.header ?? "";
      const labels = q.options.map((o) => o.label);
      const raw = await this.complete(this.prompt(text, q.options, ctx), this.model);
      const pick = matchLabel(raw, labels);
      if (!pick)
        throw new UnansweredError(
          `LLM decider answer "${raw.trim().slice(0, 60)}" is not one of the options for "${text}"`,
          `options were: ${labels.join(" | ")}`,
        );
      process.stderr.write(`[llm-decider] "${text}" → "${pick}"${this.intent ? ` (intent: ${this.intent})` : ""}\n`);
      answers[text] = pick;
    }
    return { response: { kind: "question", answers }, by: "llm", rationale: this.intent ?? "LLM judgment", model: this.model };
  }

  /** Prompt for a web_fetch approval gate (domain + url + the grant options). */
  private permPrompt(req: Extract<DecisionRequest, { kind: "permission" }>, ctx?: RunContext): string {
    const tail = (ctx?.transcript?.() ?? "").slice(-1000);
    const { domain, url } = req.input as { domain?: string; url?: string };
    return [
      this.intent
        ? `You are deciding a web_fetch approval on behalf of a tester. The tester's intent for THIS run: ${this.intent}\nPick the option that best serves that intent.`
        : `You are deciding whether to allow a web fetch, as a sensible user would.`,
      tail ? `Recent context (transcript tail):\n${tail}` : "",
      `The agent wants to fetch the URL ${url ?? "?"} (domain "${domain ?? "?"}").`,
      `Options:\n${(req.options ?? []).map((o) => `- ${o.label}${o.description ? `: ${o.description}` : ""}`).join("\n")}`,
      `Reply with ONLY the exact label of the single best option. No explanation, no punctuation — just the label.`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private prompt(question: string, options: { label: string; description?: string }[], ctx?: RunContext): string {
    const tail = (ctx?.transcript?.() ?? "").slice(-1000);
    return [
      this.intent
        ? `You are answering a question on behalf of a tester driving an automated test. The tester's intent for THIS run: ${this.intent}\nPick the option that best serves that intent.`
        : `You are answering a question with realistic, sensible judgment (as a typical user would).`,
      tail ? `Recent context (transcript tail):\n${tail}` : "",
      `Question: ${question}`,
      `Options:\n${options.map((o) => `- ${o.label}${o.description ? `: ${o.description}` : ""}`).join("\n")}`,
      `Reply with ONLY the exact label of the single best option. No explanation, no punctuation — just the label.`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }
}

/** `prompt` policy — ask a human at the TTY. Requires a TTY (else throws). */
export class PromptDecider implements Decider {
  // Inject the asker so the chat REPL can route gate prompts through the SAME readline interface it uses
  // for user turns — two interfaces on process.stdin race for input. Defaults to a private askRaw.
  constructor(private ask: (prompt: string) => Promise<string> = askRaw) {}
  async decide(req: DecisionRequest, _ctx?: RunContext): Promise<Decision | Abstain> {
    // Ordinary permissions → parity default. A web_fetch approval (options present) is prompted like a gate.
    if (req.kind === "permission" && !req.options) return ABSTAIN;
    if (!process.stdin.isTTY)
      throw new UnansweredError("prompt policy needs a terminal", "use --on-unanswered fail|first or run interactively");
    if (req.kind === "permission") {
      const labels = (req.options ?? []).map((o) => o.label);
      const ans = await this.ask(`${req.tool}?\n${labels.map((l, i) => `  ${i + 1}) ${l}`).join("\n")}\n> `);
      const { behavior, grant } = coerceWebFetchGrant(coerceLabel(ans, labels).value);
      return {
        response: {
          kind: "permission",
          behavior,
          ...(behavior === "allow" ? { updatedInput: req.input, grant } : { message: "denied (human)" }),
        },
        by: "human",
      };
    }
    if (req.kind === "question") {
      const answers: Record<string, string> = {};
      for (const q of req.questions) {
        const text = q.question ?? q.header ?? "";
        const raw = await this.ask(
          `${text}\n${q.options.map((o, i) => `  ${i + 1}) ${o.label}${o.description ? " — " + o.description : ""}`).join("\n")}\n> `,
        );
        // Human TTY input: coerce lenient input (index or label) — fallback to option 1 is acceptable here.
        answers[text] = coerceLabel(
          raw,
          q.options.map((o) => o.label),
        ).value;
      }
      return { response: { kind: "question", answers }, by: "human" };
    }
    if (req.kind === "dialog") {
      const ans = await this.ask(`[dialog ${req.dialogKind}] ok/cancel? `);
      return { response: { kind: "dialog", behavior: /^o/i.test(ans) ? "ok" : "cancelled" }, by: "human" };
    }
    if (req.kind === "elicit") {
      // The internal type (and serialize/deserialize/ExternalDecider) support cancel — offer it at the TTY
      // too, so a human can express all three: "accept"/"a" accepts, "cancel"/"c" cancels, else decline.
      const ans = await this.ask(`[elicit ${req.prompt ?? ""}] accept/decline/cancel? `);
      const action = /^a/i.test(ans) ? "accept" : /^c/i.test(ans) ? "cancel" : "decline";
      return { response: { kind: "elicit", action }, by: "human" };
    }
    return ABSTAIN;
  }
}

/**
 * `external` decider — the live "emit the question → get an answer → continue" loop. For each
 * UNscripted decision it writes a typed, self-describing `decision_request` line over a
 * `DecisionChannel` and reads one reply line back. This is the stochastic-question fix: the answerer
 * decides the ACTUAL live question (with a scrubbed transcript-tail for context), not a pre-written
 * `--answer` regex. The channel is a spawned helper (`--decider-cmd`) or a file rendezvous
 * (`--decider-dir`). Replies are lenient (label OR 1-based index, `id` optional).
 */
export class ExternalDecider implements Decider {
  constructor(
    private channel: DecisionChannel,
    private secrets: string[] = [],
  ) {}

  async decide(req: DecisionRequest, ctx?: RunContext): Promise<Decision | Abstain> {
    const request = this.emit(req, ctx);
    // Scrub the WHOLE serialized request (context + tool input) before it leaves the process — the
    // injected token must never reach stdout or the helper (Opus C1).
    this.channel.write(scrub(JSON.stringify(request), this.secrets));
    const line = await this.channel.readLine();
    if (line == null) throw new UnansweredError("external decider channel closed without a response", request.reply_with);
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new UnansweredError("external decider sent invalid JSON", request.reply_with);
    }
    if (parsed.id && req.id && parsed.id !== req.id)
      throw new UnansweredError(`external decider answered the wrong request (got ${parsed.id}, expected ${req.id})`, request.reply_with);
    return { response: this.normalize(req, parsed), by: "external", rationale: "answered externally" };
  }

  private contextTail(ctx?: RunContext): string {
    const t = ctx?.transcript?.() ?? "";
    return t.length > 1000 ? "…" + t.slice(-1000) : t;
  }

  /** Build the self-describing request line (with a literal `reply_with` fill-in template). */
  private emit(req: DecisionRequest, ctx?: RunContext): any {
    const base = { type: "decision_request", id: req.id, runId: ctx?.runId, kind: req.kind, context: this.contextTail(ctx) };
    if (req.kind === "question") {
      // JSON.stringify the KEY so a question containing a backslash / newline / control char / quote
      // produces a valid JSON object key — the old `"…".replace(/"/g,'\\"')` only escaped quotes and
      // could emit invalid guidance. (The value stays a literal placeholder, so the whole template
      // isn't itself parseable JSON — only the keys must be well-formed.)
      const pairs = req.questions.map((q) => `${JSON.stringify(q.question ?? q.header ?? "")}:"<label or 1-based index>"`).join(",");
      return { ...base, questions: req.questions, reply_with: `{"id":"${req.id}","answers":{${pairs}}}` };
    }
    if (req.kind === "permission")
      // web_fetch approval (options present): advertise the grant options so the helper can choose a scope.
      return req.options
        ? {
            ...base,
            tool: req.tool,
            input: req.input,
            options: req.options.map((o) => o.label),
            reply_with: `{"id":"${req.id}","behavior":"allow|deny","grant":"once|domain"}`,
          }
        : { ...base, tool: req.tool, input: req.input, reply_with: `{"id":"${req.id}","behavior":"allow|deny"}` };
    if (req.kind === "dialog")
      return { ...base, dialogKind: req.dialogKind, payload: req.payload, reply_with: `{"id":"${req.id}","behavior":"ok|cancelled"}` };
    return {
      ...base,
      server: req.server,
      prompt: req.prompt,
      schema: req.schema,
      reply_with: `{"id":"${req.id}","action":"accept|decline"}`,
    };
  }

  /** Normalize a lenient reply → the internal DecisionResponse (answers coerced via `coerceLabel`). */
  private normalize(req: DecisionRequest, parsed: any): DecisionResponse {
    if (req.kind === "question") {
      const answers: Record<string, string> = {};
      for (const q of req.questions) {
        const text = q.question ?? q.header ?? "";
        const labels = q.options.map((o) => o.label);
        const raw = parsed.answers?.[text];
        if (raw === undefined) {
          // #20: the reply didn't answer THIS question (a key mismatch — the helper must key `answers`
          // by the exact question text). ExternalDecider is the TERMINAL decider, so fabricating option 1
          // here would be a non-reproducible answer that greens the run — the silent false-green the ethos
          // forbids. THROW instead (no key → fail loud), rather than the old default-to-labels[0].
          throw new UnansweredError(
            `external decider reply had no answer for "${text}" (key mismatch)`,
            `Key your reply by the exact question text: {"answers":{${JSON.stringify(text)}:"<label or 1-based index>"}}`,
          );
        } else {
          const coerced = coerceLabel(raw, labels);
          if (!coerced.matched)
            // ExternalDecider is the TERMINAL decider — a present-but-mistyped label silently greening
            // option 1 is the false-green the ethos forbids. Fail loud (symmetric with the missing-key
            // throw above) so a typo cannot pass as a faithful answer.
            throw new UnansweredError(
              `external decider answer "${raw}" for "${text}" matched no option label`,
              `valid labels: ${labels.map((l) => JSON.stringify(l)).join(", ")}`,
            );
          answers[text] = coerced.value;
        }
      }
      return { kind: "question", answers };
    }
    if (req.kind === "permission") {
      // A PRESENT-but-invalid behavior (e.g. a "alow" typo) must fail LOUD, symmetric with the question
      // branch's mistyped-label throw — the old `parsed.behavior === "allow"` silently flipped any typo
      // to deny, a non-reproducible false-deny. Only "allow"/"deny" are valid; absent behavior keeps the
      // existing deny default (the helper may legitimately omit it).
      if (parsed.behavior != null && parsed.behavior !== "allow" && parsed.behavior !== "deny")
        throw new UnansweredError(
          `external decider permission behavior ${JSON.stringify(parsed.behavior)} is not a valid behavior`,
          `valid behaviors: "allow", "deny"`,
        );
      const allow = parsed.behavior === "allow";
      // web_fetch approval (options present): carry the grant scope. Helper may send {behavior, grant?};
      // an allow without an explicit grant defaults to "once" (no host-wide approval).
      if (req.options && allow) {
        const grant: "once" | "domain" = parsed.grant === "domain" ? "domain" : "once";
        return { kind: "permission", behavior: "allow", updatedInput: parsed.updatedInput ?? req.input, grant };
      }
      return allow
        ? { kind: "permission", behavior: "allow", updatedInput: parsed.updatedInput ?? req.input }
        : { kind: "permission", behavior: "deny", message: parsed.message ?? "denied (external)" };
    }
    if (req.kind === "dialog") return { kind: "dialog", behavior: parsed.behavior === "ok" ? "ok" : "cancelled", choice: parsed.choice };
    return {
      kind: "elicit",
      action: parsed.action === "accept" ? "accept" : parsed.action === "cancel" ? "cancel" : "decline",
      content: parsed.content,
    };
  }
}

function evalPredicate(expr: string, input: Record<string, unknown>): boolean {
  const keys = Object.keys(input);
  const vals = keys.map((k) => input[k]);
  // #7: scenario YAML is author-supplied (same trust class as --decider-cmd), so `new Function` is NOT
  // sandboxed — an author can run arbitrary code, by design. But a BROKEN predicate must fail LOUD, not
  // silently deny: the old bare `catch { return false }` turned a compile error (bad `new Function`) or
  // an eval-time throw into a fabricated "denied" green. Both now throw with the offending predicate named.
  // A predicate that legitimately returns falsy still returns false — only ERRORS throw.
  let fn: Function;
  try {
    fn = new Function(...keys, `"use strict"; return (${expr});`);
  } catch (e) {
    throw new Error(`allow_if predicate failed to compile: ${expr} — ${String((e as Error).message)}`);
  }
  try {
    return Boolean(fn(...vals));
  } catch (e) {
    throw new Error(`allow_if predicate threw at eval time: ${expr} — ${String((e as Error).message)}`);
  }
}

function askRaw(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(prompt, (a) => {
      rl.close();
      resolve(a.trim());
    });
  });
}
/** Coerce a raw answer (1-based index OR label, case-insensitive) to a canonical option label.
 *  Returns a discriminated result: `matched` is true when the value was found in `labels`
 *  (by index or case-insensitive name); false when the fallback to `labels[0]` was used.
 *  Shared by the TTY prompt and the external decider so both accept the same lenient forms (Opus L4). */
export function coerceLabel(a: string | number, labels: string[]): { value: string; matched: boolean } {
  if (typeof a === "number") {
    const resolved = labels[a - 1];
    return resolved !== undefined ? { value: resolved, matched: true } : { value: labels[0] ?? String(a), matched: false };
  }
  const s = a.trim();
  // #50: only treat the string as an index when it is ENTIRELY digits — `parseInt("1-no")` returns 1,
  // which would silently mis-select option 1. A digit-prefixed *label* falls through to the label match.
  const n = /^\d+$/.test(s) ? parseInt(s, 10) : NaN;
  if (!isNaN(n) && n >= 1 && n <= labels.length) return { value: labels[n - 1], matched: true };
  // Exact / case-insensitive label.
  const exact = labels.find((l) => l.toLowerCase() === s.toLowerCase());
  if (exact !== undefined) return { value: exact, matched: true };
  // CHOOSE-SUFFIX: tolerate the standard `(Recommended)` label suffix — the offered label is e.g.
  // "Approve (Recommended)" but authors write `choose: Approve`. Match ignoring a trailing "(Recommended)"
  // on EITHER side, and ALWAYS return the canonical full label (with the suffix) so the wire stays faithful.
  const stripRec = (x: string) =>
    x
      .toLowerCase()
      .replace(/\s*\(recommended\)\s*$/i, "")
      .trim();
  const suffixMatch = labels.find((l) => stripRec(l) === stripRec(s));
  if (suffixMatch !== undefined) return { value: suffixMatch, matched: true };
  // CHOOSE-SUFFIX keywords (lower priority than any literal label match above, so a real "First"/"Recommended"
  // label is never hijacked): `recommended` → the option suffixed "(Recommended)"; `first` → option 1.
  if (s.toLowerCase() === "recommended") {
    const rec = labels.find((l) => /\(recommended\)\s*$/i.test(l));
    if (rec !== undefined) return { value: rec, matched: true };
  }
  if (s.toLowerCase() === "first" && labels.length > 0) return { value: labels[0], matched: true };
  return { value: labels[0] ?? s, matched: false };
}

export type OnUnanswered = "fail" | "prompt" | "llm" | "first";

/** Build the decider chain: scripted → permission-parity default → on_unanswered terminal. */
export function buildDecider(opts: {
  rules: AnswerRule[];
  parity: "cowork" | "strict";
  onUnanswered: OnUnanswered;
  external?: Decider;
}): Decider {
  // `agent` (the LlmDecider) is injected as `external` by executeScenario; if somehow selected without
  // it, fall to FailDecider (loud) rather than silently default.
  const terminal: Decider =
    opts.external ??
    (opts.onUnanswered === "prompt" ? new PromptDecider() : opts.onUnanswered === "first" ? new FirstOptionDecider() : new FailDecider());
  return Chain(new ScriptedDecider(opts.rules), new PermissionDefaultDecider(opts.parity), terminal);
}
