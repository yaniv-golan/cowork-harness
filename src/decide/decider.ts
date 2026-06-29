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
  by: "scripted" | "cowork" | "strict" | "human" | "llm" | "agent" | "external" | "first" | "fail" | "replay" | "abstain-fallback";
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

/** Case-insensitive Levenshtein distance (small, dependency-free) — used only to suggest the nearest offered
 *  option when a scripted `choose:` matched none, so the author can fix the anchor without digging. */
function levenshtein(a: string, b: string): number {
  a = a.toLowerCase();
  b = b.toLowerCase();
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? diag : 1 + Math.min(prev[j], prev[j - 1], diag);
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** The offered label closest to `input`, when it's near enough to be a likely typo/rewording (distance within
 *  ⅓ of the longer string). Returns null when nothing is close — better to say nothing than mis-suggest. */
function nearestLabel(input: string, labels: string[]): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const l of labels) {
    const d = levenshtein(input, l);
    if (d < bestD) {
      bestD = d;
      best = l;
    }
  }
  if (best === null) return null;
  return bestD <= Math.ceil(Math.max(input.length, best.length) / 3) ? best : null;
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
  // pre-compiled regex map, keyed by when_question pattern string. Compiled once at construction
  // so the hot decision path never calls compileUserRegex() per question. An invalid pattern throws at
  // construction time (i.e. at scenario/CLI-arg loading time), not on the first matching attempt.
  private compiledPatterns: Map<string, RegExp>;

  constructor(private rules: AnswerRule[]) {
    this.compiledPatterns = new Map();
    for (const rule of rules) {
      if (rule.when_question !== undefined && !this.compiledPatterns.has(rule.when_question)) {
        const c = compileUserRegex(rule.when_question);
        if ("error" in c) throw new Error(`bad regex in when_question "${rule.when_question}": ${c.error}`);
        this.compiledPatterns.set(rule.when_question, c.re);
      }
    }
  }

  async decide(req: DecisionRequest, _ctx: RunContext): Promise<Decision | Abstain> {
    if (req.kind === "question") {
      const answers: Record<string, string> = {};
      const unmatched: string[] = []; // #4b: sub-questions no rule answered (named in the fallthrough warning)
      for (const q of req.questions) {
        const text = q.question ?? q.header ?? "";
        const rule = this.rules.find((r) => {
          if (!r.when_question) return false;
          // Use the pre-compiled regex (compiled at construction time — never compileUserRegex() here).
          const re = this.compiledPatterns.get(r.when_question)!;
          return re.test(text);
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
        warnDuplicateLabels(labels, JSON.stringify(text));
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
        const resolved = dedupeFirstSeen(
          picks.map((p) => {
            warnNumericLabelCollision(p, labels, JSON.stringify(text));
            // scriptedPrefix=true: enable the opt-in author-anchor tier (a stable partial `choose:` that rides
            // LLM-authored label drift), uniqueness-guarded; only the scripted path gets it.
            const coerced = coerceLabel(p, labels, true, true);
            if (!coerced.matched) {
              const near = nearestLabel(p, labels);
              throw new UnansweredError(
                `scripted answer "${p}" for "${text}" matched no offered option`,
                `valid labels: ${labels.map((l) => JSON.stringify(l)).join(", ")}` + (near ? ` — closest: ${JSON.stringify(near)}` : ""),
              );
            }
            return coerced.value;
          }),
        );
        // MULTISELECT comma-in-label hazard: the wire joins members with ", " WITHOUT escaping (binary-
        // verified), so a member label that itself contains a comma can't be unambiguously round-tripped.
        // This is a Cowork limitation, not ours — but silently joining it is a false-green, so warn loud.
        // Gate on the DEDUPED resolved set: a selection collapsing to one member has no inter-member join.
        if (resolved.length > 1) {
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
        // Slice the raw text FIRST, then escape — escaping first and slicing at a fixed index can sever an
        // escape pair (a special char's `\` lands at index 39, the char drops) leaving a dangling trailing
        // `\` that makes the suggested `--answer` regex uncompilable. Slicing the source makes that impossible.
        return `  • "${text}"  options: ${opts}\n    add: --answer "${escapeRx(text.slice(0, 40))}=<choice>"`;
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

/** Strict label match: exact → case-insensitive → near-miss (surrounding quotes / trailing sentence
 *  punctuation trimmed). NULL on no match (caller fails loud — we deliberately do NOT fall back to option 1
 *  like `coerceLabel`, which would silently mis-answer).
 *  When `fuzzy` is true, also accept a substring match (ONLY when exactly one label appears in the reply
 *  to avoid ambiguity). Callers that consume human or LLM output should leave `fuzzy` at its default
 *  (false) to require an exact answer — the substring heuristic is opt-in only. */
export function matchLabel(raw: string, labels: string[], fuzzy = false): string | null {
  const r = raw.trim();
  const exact = labels.find((l) => l === r) ?? labels.find((l) => l.toLowerCase() === r.toLowerCase());
  if (exact) return exact;
  // Near-miss tier: a model (or human) often replies `Confirmed.` or `"Confirmed"` for the label
  // `Confirmed`, especially on binary confirm gates. Strip surrounding quotes + trailing `.!,;`/whitespace
  // and re-run the exact/ci match. NEVER strip `:` — it is the `OTHER:` free-text sentinel callers rely on,
  // and the trim must not let a near-miss swallow it. Strict (not fuzzy), so it can't mis-bind a substring.
  const norm = trimNearMiss(r);
  if (norm && norm !== r) {
    const near = labels.find((l) => l === norm) ?? labels.find((l) => l.toLowerCase() === norm.toLowerCase());
    if (near) return near;
  }
  if (!fuzzy) return null;
  // fuzzy=true: the substring tier fires ONLY when EXACTLY ONE label is contained in the reply. With
  // labels ["No","Notation"] and reply "Notation", both the apex match and the contains-check used to
  // pick "No" (the first substring) — an ambiguous mis-steer. If two+ labels match (or none), return
  // null so the caller's UnansweredError fires (fail loud) rather than guessing the wrong option.
  const rl = r.toLowerCase();
  const substr = labels.filter((l) => rl.includes(l.toLowerCase()));
  return substr.length === 1 ? substr[0] : null;
}

// Boundary-prefix separator sets. The ECHO set (LLM reply matched against a label) is `:` ONLY — the label
// is matched against the model's FREE-TEXT reply, so any extra separator admits a conversational-aside
// false positive ("No, I disagree…"→No via comma; "Seed (probably) but Series A"→Seed via paren). Both
// reproduced echoes used `:` (the old `label: description` render). The SCRIPTED set (author anchor matched
// against a clean, skill-authored OPTION LABEL — no free prose) is richer, so a stable anchor can ride
// label drift ("Israeli company" → "Israeli company (IL only)" via `(`; "2 founders" → "2 founders, ~5M
// each" via `,`). em-dash = U+2014, en-dash = U+2013.
const ECHO_SEPARATORS = ":";
const SCRIPTED_SEPARATORS = ":(,—–";

/** Strip surrounding quotes + trailing sentence punctuation (`.!,;` + whitespace) — NEVER `:` (the
 *  `OTHER:` sentinel). The one near-miss normalization, shared by `matchLabel` and the LLM suffix/echo
 *  backstops so the tiers compose (e.g. `"Approve."` reaches the suffix tier as `Approve`). */
function trimNearMiss(s: string): string {
  return s
    .replace(/^["'`]+/, "")
    .replace(/["'`]+$/, "")
    .replace(/[.!,;\s]+$/, "");
}

/** True when `label` is an index-0 (case-insensitive) prefix of `text`, followed by — skipping optional
 *  whitespace — a char in `separators` or end-of-string. The single shared boundary predicate behind the
 *  LLM echo tier (separators=`:`) and the scripted author anchor (richer set); only the terminal set is a
 *  per-caller parameter, so the boundary/whitespace logic can never fork. `/` and bare whitespace are never
 *  separators (so "Seed" does not boundary-match "Seed / AI/ML", and prose "Series A is my pick" is rejected). */
export function isBoundaryPrefix(label: string, text: string, separators: string): boolean {
  if (!label) return false;
  const l = label.toLowerCase();
  const t = text.toLowerCase();
  if (!t.startsWith(l)) return false;
  let i = l.length;
  while (i < t.length && /\s/.test(t[i]!)) i++;
  return i >= t.length || separators.includes(t[i]!);
}

/** Echo tier (label ⊑ reply): among labels that are boundary-prefixes of `reply` (echo separator set),
 *  return the LONGEST — two index-0 prefixes of the same reply are necessarily nested, so the longest is
 *  unique and most-specific (= the actually-echoed label); null when none. Fixes the `label: description`
 *  whiff where the model parrots the rendered bullet. */
export function echoPrefixMatch(reply: string, labels: string[]): string | null {
  // trimNearMiss strips a leading wrapping quote so a quoted echo (`"Seed / AI/ML: …"`) still matches at
  // index 0; the trailing strip is harmless (the description tail is past the boundary anyway).
  const r = trimNearMiss(reply);
  const cands = labels.filter((l) => isBoundaryPrefix(l, r, ECHO_SEPARATORS));
  if (cands.length === 0) return null;
  return cands.reduce((a, b) => (b.length > a.length ? b : a));
}

/** Strip a trailing ` (Recommended)` (either side) and lowercase+trim — the (Recommended)-suffix
 *  canonicalization key, shared by `coerceLabel` and `suffixCanonMatch`. */
function stripRec(x: string): string {
  return x
    .toLowerCase()
    .replace(/\s*\(recommended\)\s*$/i, "")
    .trim();
}

/** (Recommended)-suffix canonicalization for the LLM path, uniqueness-guarded: bind iff EXACTLY ONE
 *  label's stripped form equals the stripped reply; returns the full canonical label or null. */
export function suffixCanonMatch(raw: string, labels: string[]): string | null {
  // trimNearMiss first so trim composes with suffix-canon — `"Approve."` binds the `Approve (Recommended)`
  // option (stripRec alone leaves the trailing `.` and would miss it). The trim never strips `:`.
  const s = stripRec(trimNearMiss(raw));
  const cands = labels.filter((l) => stripRec(l) === s);
  return cands.length === 1 ? cands[0]! : null;
}

/** The index protocol: an ENTIRELY-digit reply (the `#50` rule) in `[1, n]` → that 1-based index; null
 *  otherwise (out of range, or any non-bare-digit like "2)", "option 2", "2 and 4" → caller falls to the
 *  label tiers / fails loud). */
export function parseIndexReply(raw: string, n: number): number | null {
  const s = raw.trim();
  if (!/^\d+$/.test(s)) return null;
  const v = parseInt(s, 10);
  return v >= 1 && v <= n ? v : null;
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
    private model: string = process.env.COWORK_HARNESS_DECIDER_MODEL || "claude-sonnet-4-5",
    // #62: the default transport spawns `claude -p <prompt>` with the prompt as ARGV (process-table visible).
    // The prompt embeds an unscrubbed transcript tail, so without these a tracked secret in the last ~1000
    // chars lands in `ps`/`/proc/<pid>/cmdline`. Scrub the prompt at each complete() call — symmetric with
    // ExternalDecider, which scrubs its serialized request before it leaves the process.
    private secrets: string[] = [],
  ) {}

  async decide(req: DecisionRequest, ctx?: RunContext): Promise<Decision | Abstain> {
    // Options-bearing permission (web_fetch approval): the LLM judges the stochastic gate and picks a grant
    // label. Ordinary (optionless) permissions → ABSTAIN (parity default handles them).
    if (req.kind === "permission") {
      if (!req.options) return ABSTAIN;
      const labels = req.options.map((o) => o.label);
      const raw = await this.complete(scrub(this.permPrompt(req, ctx), this.secrets), this.model);
      // Echo backstop, at parity with the question path's `echoPrefixMatch` tier: the model often
      // parrots the offered option plus a self-glossed tail past a `:` boundary ("Allow once: fetch
      // this URL one time"). Bind the echoed label instead of failing loud. The OTHER:/suffix tiers are
      // inapplicable to a web_fetch grant (a closed set — no free-text, no "(Recommended)" labels), so
      // only the echo tier is added; the bound value is a bare canonical label coerceWebFetchGrant accepts.
      let pick = matchLabel(raw, labels);
      if (!pick) pick = echoPrefixMatch(raw, labels);
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
      warnDuplicateLabels(labels, JSON.stringify(text));
      // a no-option question is an open-ended / free-text gate (Cowork's "Other" path). matchLabel
      // against an empty labels array is unconditionally null, so the label branch would always throw
      // UnansweredError and the gate could never be answered. Ask the LLM for a free-text answer and deliver
      // it verbatim through the same answers map (serialized into updatedInput:{questions,answers} downstream,
      // the pinned AskUserQuestion path) — symmetric with ScriptedDecider/ExternalDecider's labels.length===0
      // passthrough.
      if (labels.length === 0) {
        const free = (await this.complete(scrub(this.freeTextPrompt(text, ctx), this.secrets), this.model)).trim();
        if (free === "")
          throw new UnansweredError(
            `LLM decider returned an empty answer for the open-ended question "${text}"`,
            "an open-ended (no-option) gate needs a non-empty free-text answer",
          );
        process.stderr.write(`[llm-decider] "${text}" → free-text${this.intent ? ` (intent: ${this.intent})` : ""}\n`);
        answers[text] = free;
        continue;
      }
      const multi = q.multiSelect === true;
      const raw = await this.complete(scrub(this.prompt(text, q.options, multi, ctx), this.secrets), this.model);
      // MULTI-SELECT (the index protocol is the ONLY accepted form): a comma-list of bare, in-range option
      // numbers (e.g. "1, 3"). Anything else — a label echo, or a mixed "1, Seed" — fails loud rather than
      // partial-binding. (Before this branch the LLM path had no multiSelect handling at all, so a multiSelect
      // gate could only ever select ONE option.) Members are mapped to canonical labels and ", "-joined.
      if (multi) {
        const parts = raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const picks: string[] = [];
        for (const p of parts) {
          const i = parseIndexReply(p, labels.length);
          if (i === null)
            throw new UnansweredError(
              `LLM decider multi-select answer "${raw.trim().slice(0, 60)}" for "${text}" must be option numbers (e.g. "1, 3")`,
              `options were: ${labels.map((l, n) => `${n + 1}) ${l}`).join("  ")}`,
            );
          if (!picks.includes(labels[i - 1]!)) picks.push(labels[i - 1]!);
        }
        if (picks.length === 0)
          throw new UnansweredError(
            `LLM decider returned no selection for the multi-select gate "${text}"`,
            `reply one or more option numbers, comma-separated (e.g. "1, 3")`,
          );
        const commaLabel = picks.find((l) => l.includes(","));
        if (commaLabel)
          warn(
            `::warning:: multiSelect member label ${JSON.stringify(commaLabel)} for "${text}" contains a comma — the wire joins members with ", " WITHOUT escaping, so the model may re-read the selected set differently (Cowork limitation). Verify this gate.\n`,
          );
        process.stderr.write(`[llm-decider] "${text}" → ${JSON.stringify(picks)}${this.intent ? ` (intent: ${this.intent})` : ""}\n`);
        answers[text] = picks.join(", ");
        continue;
      }
      // SINGLE-SELECT. PRIMARY — the index protocol: a bare, in-range option number (the model is instructed
      // to reply a number). Code maps the number → the exact canonical label; the model never types the
      // matched string, so the `label: description` echo whiff can't occur on the common path.
      const idx = parseIndexReply(raw, labels.length);
      if (idx !== null) {
        process.stderr.write(`[llm-decider] "${text}" → "${labels[idx - 1]}" (#${idx})${this.intent ? ` (intent: ${this.intent})` : ""}\n`);
        answers[text] = labels[idx - 1]!;
        continue;
      }
      // BACKSTOP (model emitted text, not a number). exact + trailing-trim near-miss FIRST, so a real option
      // literally named "OTHER: …" binds as a label before the OTHER sentinel (matchLabel never strips `:`).
      let pick = matchLabel(raw, labels);
      // OTHER: free-text sentinel — AFTER the exact/trim match (so a literal OTHER:-named label wins) and
      // BEFORE the permissive suffix/echo tiers (so a genuine free-text OTHER is never grabbed by the echo tier).
      if (!pick) {
        // Strip a single MATCHED wrapping code-fence/quote (`` `OTHER: …` ``, `"OTHER: …"`) so the `^\s*OTHER:`
        // anchor still matches — a model often code-fences a verbatim directive, and a leading backtick/quote on
        // `raw` would otherwise defeat it (observed live: `` `OTHER: Sector not specified` `` → whiffed → fail-loud
        // stall). Only a matched same-char PAIR is removed (not a bare trailing quote like trimNearMiss): the
        // free-text VALUE is delivered verbatim, so `OTHER: Acme Inc.` keeps its period and `OTHER: labeled "X"`
        // keeps its closing quote. A real `OTHER:`-named option label already bound via matchLabel above (incl.
        // its own quote-trim), so this can't hijack one.
        const t = raw.trim();
        const fenced = /^([`'"])([\s\S]*)\1$/.exec(t);
        const other = /^\s*OTHER:\s*([\s\S]+)/i.exec(fenced ? fenced[2] : t);
        if (other) {
          const free = other[1].trim();
          if (free === "")
            throw new UnansweredError(
              `LLM decider returned an empty OTHER answer for "${text}"`,
              "an OTHER free-text directive needs a non-empty value",
            );
          process.stderr.write(`[llm-decider] "${text}" → free-text (Other)${this.intent ? ` (intent: ${this.intent})` : ""}\n`);
          answers[text] = free;
          continue;
        }
      }
      // Permissive label tiers (uniqueness-guarded, return the canonical label): (Recommended)-suffix
      // canonicalization, then the label-echo fix (label ⊑ reply, `:` boundary, longest-wins).
      if (!pick) pick = suffixCanonMatch(raw, labels);
      if (!pick) pick = echoPrefixMatch(raw, labels);
      if (!pick) {
        const near = nearestLabel(raw, labels);
        throw new UnansweredError(
          `LLM decider answer "${raw.trim().slice(0, 60)}" is not one of the options for "${text}"`,
          `options were: ${labels.join(" | ")}${near ? ` — closest: ${JSON.stringify(near)}` : ""}. Reply the option NUMBER, or \`OTHER: <value>\` for a custom answer. ` +
            `If the model declined in prose instead of picking an option, the answering model is set by ` +
            `\`--decider-model\` / \`COWORK_HARNESS_DECIDER_MODEL\` (a different/more capable model may bind it; ` +
            `on a founder-only-knowledge gate it may guess rather than truly know).`,
        );
      }
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

  // Numbered render + "reply the NUMBER" is the index protocol: the model returns an index and CODE maps it
  // to the canonical label, so the model never types the label string (the `label: description` echo whiff).
  // Descriptions go on their OWN line (not `label: description`) so the colon-echo isn't invited.
  private prompt(question: string, options: { label: string; description?: string }[], multi: boolean, ctx?: RunContext): string {
    const tail = (ctx?.transcript?.() ?? "").slice(-1000);
    return [
      this.intent
        ? `You are answering a question on behalf of a tester driving an automated test. The tester's intent for THIS run: ${this.intent}\nPick the option that best serves that intent.`
        : `You are answering a question with realistic, sensible judgment (as a typical user would).`,
      tail ? `Recent context (transcript tail):\n${tail}` : "",
      `Question: ${question}`,
      `Options:\n${options.map((o, i) => `${i + 1}) ${o.label}${o.description ? `\n   ${o.description}` : ""}`).join("\n")}`,
      multi
        ? `Reply with ONLY the option numbers, comma-separated (e.g. \`1, 3\`) — no label text, no explanation.`
        : `Reply with ONLY the option number (e.g. \`2\`) — no label text, no explanation. ` +
          `If none of the options fits and the intent calls for a custom value (the gate always allows a ` +
          `free-text "Other" entry), reply with exactly \`OTHER: <your value>\` instead.`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  /** Prompt for an open-ended (no-option) question — Cowork's free-text "Other" gate. Asks for a direct
   *  answer rather than a label pick. */
  private freeTextPrompt(question: string, ctx?: RunContext): string {
    const tail = (ctx?.transcript?.() ?? "").slice(-1000);
    return [
      this.intent
        ? `You are answering an open-ended question on behalf of a tester driving an automated test. The tester's intent for THIS run: ${this.intent}\nAnswer in a way that best serves that intent.`
        : `You are answering an open-ended question with realistic, sensible judgment (as a typical user would).`,
      tail ? `Recent context (transcript tail):\n${tail}` : "",
      `Question: ${question}`,
      `This question has no preset options — reply with a concise free-text answer. No preamble.`,
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
      // a web_fetch approval with options present but empty would spin the coercedPerm loop
      // forever — coerceLabel always returns matched:false when labels is empty. Fail immediately with
      // a clear protocol error (the protocol guarantees at least one option on an options-bearing gate).
      if (labels.length === 0)
        throw new UnansweredError(
          `protocol error: permission request for "${req.tool}" carries an empty options array`,
          "the protocol guarantees at least one option on an options-bearing permission gate",
        );
      const permPrompt = `${req.tool}?\n${labels.map((l, i) => `  ${i + 1}) ${l}`).join("\n")}\n> `;
      let coercedPerm: { value: string; matched: boolean };
      do {
        const ans = await this.ask(permPrompt);
        // coerceLabel accepts: 1-based index, exact label (case-insensitive), "(Recommended)" suffix
        // tolerance, "recommended" keyword, and "first" keyword (option 1). "last" is NOT a keyword.
        coercedPerm = coerceLabel(ans, labels);
        if (!coercedPerm.matched)
          process.stderr.write(`Unrecognized input. Please enter a number (1–${labels.length}) or one of: ${labels.join(", ")}\n`);
      } while (!coercedPerm.matched);
      const { behavior, grant } = coerceWebFetchGrant(coercedPerm.value);
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
        const optionLabels = q.options.map((o) => o.label);
        warnDuplicateLabels(optionLabels, JSON.stringify(text));
        // an empty options array would spin the coerced* loops forever — coerceLabel always returns
        // matched:false when labels is empty, so `do…while (!coerced.matched)` never terminates. Guard before
        // the loop, mirroring the permission path's empty-options guard and FirstOptionDecider's. A
        // single-select with no options is an open-ended gate (Cowork's free-text "Other" path) — accept the
        // typed answer verbatim; a multiSelect with no options is a protocol contradiction — fail loud.
        if (optionLabels.length === 0) {
          if (q.multiSelect)
            throw new UnansweredError(
              `protocol error: multi-select question "${text}" carries an empty options array`,
              "a multi-select gate cannot offer zero options; check the gate payload",
            );
          let free = "";
          do {
            free = (await this.ask(`${text}\n(open-ended — type your answer)\n> `)).trim();
            if (free === "") process.stderr.write(`Please enter a non-empty answer.\n`);
          } while (free === "");
          answers[text] = free;
          continue;
        }
        if (q.multiSelect) {
          // Multi-select gate: accept comma-separated indices or labels; validate each pick; serialize
          // as a comma-joined string matching the AskUserQuestion wire shape (binary-verified).
          const optionList = `${text}\n${q.options.map((o, i) => `  ${i + 1}) ${o.label}${o.description ? " — " + o.description : ""}`).join("\n")}\nSelect one or more, comma-separated:\n> `;
          let resolved: string[] | null = null;
          do {
            const raw = await this.ask(optionList);
            const parts = raw
              .split(",")
              .map((p) => p.trim())
              .filter(Boolean);
            if (parts.length === 0) {
              process.stderr.write(`Please enter at least one choice (comma-separated numbers or labels).\n`);
              continue;
            }
            const picks: string[] = [];
            let invalid = false;
            for (const part of parts) {
              warnNumericLabelCollision(part, optionLabels, JSON.stringify(text));
              // coerceLabel accepts: 1-based index, exact label (case-insensitive), "(Recommended)" suffix
              // tolerance, "recommended" keyword, and "first" keyword (option 1). "last" is NOT a keyword.
              const coerced = coerceLabel(part, optionLabels);
              if (!coerced.matched) {
                process.stderr.write(
                  `Unrecognized input "${part}". Please enter numbers (1–${optionLabels.length}) or labels: ${optionLabels.join(", ")}\n`,
                );
                invalid = true;
                break;
              }
              picks.push(coerced.value);
            }
            if (!invalid) resolved = picks;
          } while (resolved === null);
          // Dedupe the resolved set (first-seen) so a human typing "1,1" / "A,A" delivers a checkbox-faithful
          // distinct set, mirroring the LLM/scripted/external paths.
          answers[text] = dedupeFirstSeen(resolved!).join(", ");
        } else {
          const optionList = `${text}\n${q.options.map((o, i) => `  ${i + 1}) ${o.label}${o.description ? " — " + o.description : ""}`).join("\n")}\n> `;
          let coerced: { value: string; matched: boolean };
          do {
            const raw = await this.ask(optionList);
            warnNumericLabelCollision(raw, optionLabels, JSON.stringify(text));
            // coerceLabel accepts: 1-based index, exact label (case-insensitive), "(Recommended)" suffix
            // tolerance, "recommended" keyword, and "first" keyword (option 1). "last" is NOT a keyword.
            coerced = coerceLabel(raw, optionLabels);
            if (!coerced.matched)
              process.stderr.write(
                `Unrecognized input. Please enter a number (1–${optionLabels.length}) or one of: ${optionLabels.join(", ")}\n`,
              );
          } while (!coerced.matched);
          answers[text] = coerced.value;
        }
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
      // A multiSelect question advertises the ARRAY reply shape so a helper/driver sends a list; a
      // single-select question keeps the scalar placeholder. (Only the keys must be well-formed JSON —
      // the values are placeholders, so the template as a whole isn't parseable, by design.)
      const pairs = req.questions
        .map(
          (q) =>
            `${JSON.stringify(q.question ?? q.header ?? "")}:${q.multiSelect ? `["<label or 1-based index>", "…"]` : `"<label or 1-based index>"`}`,
        )
        .join(",");
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
      reply_with: `{"id":"${req.id}","action":"accept|cancel|decline"}`,
    };
  }

  /** Normalize a lenient reply → the internal DecisionResponse (answers coerced via `coerceLabel`). */
  private normalize(req: DecisionRequest, parsed: any): DecisionResponse {
    if (req.kind === "question") {
      const answers: Record<string, string> = {};
      for (const q of req.questions) {
        const text = q.question ?? q.header ?? "";
        // `options` is non-optional in the static QSpec, but the wire payload is cast through unchecked
        // (a header-only gate can arrive with no options), so `q.options.map` would TypeError on undefined.
        const labels = q.options?.map((o) => o.label) ?? [];
        warnDuplicateLabels(labels, JSON.stringify(text));
        const validLabels = `valid labels: ${labels.map((l) => JSON.stringify(l)).join(", ")}`;
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
        } else if (q.multiSelect) {
          // MULTISELECT: accept an array of labels/indices (the natural machine contract — a helper or
          // driver emits JSON), or a single scalar (a one-element selection, parity with ScriptedDecider
          // which wraps a scalar `choose` into `[choose]`). Normalize to the canonical ", "-joined string
          // (the binary-verified AskUserQuestion wire shape) — mirror ScriptedDecider exactly.
          const members = Array.isArray(raw) ? raw : [raw];
          // Empty-check FIRST, before the optionless passthrough — an empty array answers nothing.
          if (members.length === 0)
            throw new UnansweredError(
              `external decider sent an empty selection for multiSelect ${JSON.stringify(text)}`,
              `supply at least one label or 1-based index in the array`,
            );
          if (labels.length === 0) {
            // Degenerate optionless multiSelect gate — pass the member(s) through verbatim (parity with
            // the free-text branch below; the external helper is the authoritative answerer). Guard each
            // member is a string/number first — a non-scalar (object/null/boolean) would otherwise stringify
            // to "[object Object]"/"null"/"false" and silently green the run. `bad !== undefined` (not a
            // truthiness test) so a falsy-but-bad member like boolean `false` still throws.
            const bad = members.find((m) => typeof m !== "string" && typeof m !== "number");
            if (bad !== undefined)
              throw new UnansweredError(
                `external decider sent a non-string member (${Array.isArray(bad) ? "an array" : bad === null ? "null" : typeof bad}) for the optionless multiSelect ${JSON.stringify(text)}`,
                `each member must be a string label or a 1-based index`,
              );
            answers[text] = members.map(String).join(", ");
            continue;
          }
          const resolved = dedupeFirstSeen(
            members.map((m) => {
              warnNumericLabelCollision(m, labels, JSON.stringify(text));
              // "first" shorthand stays disabled for externals (a literal "first" must match a real label).
              const c = coerceLabel(m, labels, false);
              if (!c.matched)
                throw new UnansweredError(
                  `external decider member ${JSON.stringify(m)} for ${JSON.stringify(text)} matched no option label`,
                  validLabels,
                );
              return c.value;
            }),
          );
          // Comma-in-label hazard — mirror ScriptedDecider EXACTLY: the wire joins members with ", " WITHOUT
          // escaping (Cowork limitation), so a member label containing a comma can't be unambiguously
          // round-tripped. Gate on the DEDUPED resolved set (a set collapsing to one member has no join).
          if (resolved.length > 1) {
            const commaLabel = resolved.find((l) => l.includes(","));
            if (commaLabel)
              warn(
                `::warning:: multiSelect member label ${JSON.stringify(commaLabel)} for "${text}" contains a comma — the wire joins members with ", " WITHOUT escaping, so the model may re-read the selected set differently (Cowork limitation). Verify this gate.\n`,
              );
          }
          answers[text] = resolved.join(", ");
          continue;
        } else {
          // SINGLE-SELECT: reject an array up front — a list answer for a single-select gate is a protocol
          // error, not a one-element coercion (fail loud, symmetric with the multiSelect guards).
          if (Array.isArray(raw))
            throw new UnansweredError(
              `external decider sent an array for single-select ${JSON.stringify(text)} — send one label or 1-based index`,
              validLabels,
            );
          // when the question has no options it is a free-text / open-ended gate — coerceLabel
          // always returns matched:false for an empty labels array and would throw below. Accept any
          // non-empty string verbatim (the external helper is the authoritative answerer for these gates).
          if (labels.length === 0) {
            // Guard the type BEFORE String(raw): a non-scalar object would stringify to "[object Object]"
            // and silently green the run (the options-present path routes through coerceLabel's typeof
            // guard; this optionless branch must enforce the same). Arrays are already rejected above.
            if (typeof raw !== "string" && typeof raw !== "number")
              throw new UnansweredError(
                `external decider sent a non-string answer (${raw === null ? "null" : typeof raw}) for the optionless question "${text}"`,
                `provide a string (or 1-based index) as the answer`,
              );
            if (String(raw).trim() === "")
              throw new UnansweredError(
                `external decider sent an empty answer for the open-ended question "${text}"`,
                `provide a non-empty string as the answer`,
              );
            answers[text] = String(raw);
            continue;
          }
          warnNumericLabelCollision(raw, labels, JSON.stringify(text));
          // "first" is a documented shorthand for scripted/human deciders but NOT for external helpers —
          // a helper returning the literal string "first" must match an actual label, not be coerced to option 1.
          const coerced = coerceLabel(raw, labels, false);
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
        if (parsed.grant != null && parsed.grant !== "domain" && parsed.grant !== "once")
          throw new UnansweredError(
            `external decider grant ${JSON.stringify(parsed.grant)} is not a valid grant scope`,
            `valid grant values: "once", "domain"`,
          );
        const grant: "once" | "domain" = parsed.grant === "domain" ? "domain" : "once";
        return { kind: "permission", behavior: "allow", updatedInput: parsed.updatedInput ?? req.input, grant };
      }
      return allow
        ? { kind: "permission", behavior: "allow", updatedInput: parsed.updatedInput ?? req.input }
        : { kind: "permission", behavior: "deny", message: parsed.message ?? "denied (external)" };
    }
    if (req.kind === "dialog") {
      if (parsed.behavior != null && parsed.behavior !== "ok" && parsed.behavior !== "cancelled")
        throw new UnansweredError(
          `external decider dialog behavior ${JSON.stringify(parsed.behavior)} is not a valid behavior`,
          `valid behaviors: "ok", "cancelled"`,
        );
      return { kind: "dialog", behavior: parsed.behavior === "ok" ? "ok" : "cancelled", choice: parsed.choice };
    }
    if (parsed.action != null && parsed.action !== "accept" && parsed.action !== "cancel" && parsed.action !== "decline")
      throw new UnansweredError(
        `external decider elicit action ${JSON.stringify(parsed.action)} is not a valid action`,
        `valid actions: "accept", "cancel", "decline"`,
      );
    return {
      kind: "elicit",
      action: parsed.action === "accept" ? "accept" : parsed.action === "cancel" ? "cancel" : "decline",
      content: parsed.content,
    };
  }
}

function evalPredicate(expr: string, input: Record<string, unknown>): boolean {
  // (additive): expose the whole input object as `input` so predicates can reach keys that are not
  // valid JS identifiers — `input["file-path"]`, `input["foo.bar"]`. We ALSO keep binding each input key as
  // a bare parameter (`command.includes(...)`), the form used by shipped example scenarios and the docs —
  // dropping it would silently false-deny those on first run. Only identifier-shaped keys can be bound as a
  // bare parameter (a key like `file-path` is not a legal parameter name and would fail `new Function`
  // compilation regardless of the predicate body); non-identifier keys are reachable only via `input[...]`.
  const isIdentifier = (k: string) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k);
  // `input` itself is always available; if an input key is literally named "input" the explicit object wins
  // (don't bind it twice — a duplicate parameter name is a compile error under "use strict").
  const namedKeys = Object.keys(input).filter((k) => isIdentifier(k) && k !== "input");
  const params = ["input", ...namedKeys];
  const args: unknown[] = [input, ...namedKeys.map((k) => input[k])];
  // #7: scenario YAML is author-supplied (same trust class as --decider-cmd), so `new Function` is NOT
  // sandboxed — an author can run arbitrary code, by design. But a BROKEN predicate must fail LOUD, not
  // silently deny: the old bare `catch { return false }` turned a compile error (bad `new Function`) or
  // an eval-time throw into a fabricated "denied" green. Both now throw with the offending predicate named.
  // A predicate that legitimately returns falsy still returns false — only ERRORS throw.
  let fn: Function;
  try {
    fn = new Function(...params, `"use strict"; return (${expr});`);
  } catch (e) {
    throw new Error(`allow_if predicate failed to compile: ${expr} — ${String((e as Error).message)}`);
  }
  try {
    return Boolean(fn(...args));
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
/** Warn if a labels array contains duplicate values — duplicates make the second occurrence permanently
 *  unreachable via `coerceLabel` (which uses `find`, returning the first match). Called wherever a
 *  `labels` array is built from gate options so duplicate gates are surfaced at decision time. */
function warnDuplicateLabels(labels: string[], context: string): void {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const l of labels) {
    const key = l.toLowerCase();
    if (seen.has(key)) dupes.add(l);
    else seen.add(key);
  }
  if (dupes.size > 0)
    warn(
      `::warning:: gate ${context} has duplicate option labels: ${[...dupes].map((d) => JSON.stringify(d)).join(", ")} — the second occurrence is permanently unreachable via coerceLabel (find returns the first match). Fix the gate to use unique labels.\n`,
    );
}

/** Warn when a pure-digit pick is BOTH an exact option label AND a valid 1-based index pointing at a
 *  DIFFERENT option. coerceLabel resolves such a collision to the literal label (exact-wins, fidelity-
 *  correct), but the bare-index protocol is ambiguous for numeric-labeled gates. This is a SEPARATE
 *  render-site helper — kept out of coerceLabel so the pure value-discarding validator (cli.ts write-time)
 *  never fires it; it is called only at the RESOLVING call sites, which run once at answer-consume time. */
function warnNumericLabelCollision(pick: string | number, labels: string[], context: string): void {
  const s = typeof pick === "number" ? String(pick) : typeof pick === "string" ? pick.trim() : "";
  if (!/^\d+$/.test(s)) return;
  if (!labels.some((l) => l.toLowerCase() === s.toLowerCase())) return;
  const n = parseInt(s, 10);
  if (n >= 1 && n <= labels.length && labels[n - 1].toLowerCase() !== s.toLowerCase())
    warn(
      `::warning:: choice ${JSON.stringify(s)} for ${context} matches BOTH the literal option label ${JSON.stringify(s)} and 1-based index ${n} (${JSON.stringify(labels[n - 1])}) — selecting the label. The bare-index protocol is ambiguous for numeric-labeled gates; use a non-numeric anchor to disambiguate.\n`,
    );
}

/** Dedupe a resolved (canonical-label) member list in first-seen order — mirrors the LLM path's
 *  `picks.includes()` guard so scripted/external/human multiSelect deliver a checkbox-faithful set
 *  (real Cowork's multiSelect always has distinct members; "A, A" is unfaithful). */
function dedupeFirstSeen(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    if (!seen.has(it)) {
      seen.add(it);
      out.push(it);
    }
  }
  return out;
}

/** Coerce a raw answer (1-based index OR label, case-insensitive) to a canonical option label.
 *  Returns a discriminated result: `matched` is true when the value was found in `labels`
 *  (by index or case-insensitive name); false when the fallback to `labels[0]` was used.
 *  Shared by the TTY prompt and the external decider so both accept the same lenient forms (Opus L4). */
export function coerceLabel(
  a: string | number,
  labels: string[],
  enableFirstShorthand = true,
  scriptedPrefix = false,
): { value: string; matched: boolean } {
  // A non-string/number answer (e.g. an array or object that slipped past a caller's type guard — the
  // external reply is parsed from arbitrary JSON) used to fall into `a.trim()` and crash with a bare
  // `TypeError: a.trim is not a function`, aborting the run. The module's contract is fail-loud, never
  // crash: throw an actionable UnansweredError instead. A multiSelect array is handled upstream in
  // ExternalDecider.normalize before it reaches here, so this fires only on a genuinely malformed value.
  if (typeof a !== "string" && typeof a !== "number")
    throw new UnansweredError(
      `answer must be a label string or a 1-based index, got ${Array.isArray(a) ? "an array" : typeof a}`,
      `for a multiSelect gate send an array of labels; otherwise one label or index`,
    );
  if (typeof a === "number") {
    const resolved = labels[a - 1];
    return resolved !== undefined ? { value: resolved, matched: true } : { value: labels[0] ?? String(a), matched: false };
  }
  const s = a.trim();
  // Exact / case-insensitive label — checked BEFORE the bare-index interpretation so a numeric option
  // label resolves to the LITERAL label, not labels[index-1]. With options ['5','3','8'] and choose '3',
  // index-first would return labels[2]='8' with matched:true (a silent wrong answer). On a genuine numeric
  // collision the label wins (fidelity-correct: the label is what reaches the wire); the resolving call
  // sites surface the ambiguity loudly via warnNumericLabelCollision (kept OUT of this pure helper so the
  // value-discarding validator at cli.ts never fires it). This is also a behavior change to the EXTERNAL
  // machine-helper contract (label-wins on a numeric collision), shipped documented rather than silent.
  const exact = labels.find((l) => l.toLowerCase() === s.toLowerCase());
  if (exact !== undefined) return { value: exact, matched: true };
  // #50: only treat the string as an index when it is ENTIRELY digits — `parseInt("1-no")` returns 1,
  // which would silently mis-select option 1. A digit-prefixed *label* falls through to the label match.
  const n = /^\d+$/.test(s) ? parseInt(s, 10) : NaN;
  if (!isNaN(n) && n >= 1 && n <= labels.length) return { value: labels[n - 1], matched: true };
  // CHOOSE-SUFFIX: tolerate the standard `(Recommended)` label suffix — the offered label is e.g.
  // "Approve (Recommended)" but authors write `choose: Approve`. Match ignoring a trailing "(Recommended)"
  // on EITHER side, and ALWAYS return the canonical full label (with the suffix) so the wire stays faithful.
  const suffixMatch = labels.find((l) => stripRec(l) === stripRec(s));
  if (suffixMatch !== undefined) return { value: suffixMatch, matched: true };
  // CHOOSE-SUFFIX keywords (lower priority than any literal label match above, so a real "First"/"Recommended"
  // label is never hijacked): `recommended` → the option suffixed "(Recommended)"; `first` → option 1.
  if (s.toLowerCase() === "recommended") {
    const rec = labels.find((l) => /\(recommended\)\s*$/i.test(l));
    if (rec !== undefined) return { value: rec, matched: true };
  }
  if (enableFirstShorthand && s.toLowerCase() === "first" && labels.length > 0) return { value: labels[0], matched: true };
  // SCRIPTED AUTHOR-PREFIX (opt-in; scripted path only) — a stable partial anchor that rides LLM-authored
  // label drift, e.g. `choose: "Israeli company"` binds whichever option starts with it ("Israeli company
  // (IL only)"). Uniqueness-guarded against an OPTION LABEL (a clean string, not free prose — no aside
  // hazard), exactly-one or fall through to loud. Lower than every exact/suffix/keyword tier so it never
  // shadows a precise pin. Determinism cost (documented): an anchor unique today can match 2 options after
  // drift → a previously-green pin then fails LOUD (never a false-green). For deterministic CI, pin a full
  // label or use a free-text `answer:`.
  if (scriptedPrefix) {
    const cands = labels.filter((opt) => isBoundaryPrefix(s, opt, SCRIPTED_SEPARATORS));
    if (cands.length === 1) return { value: cands[0]!, matched: true };
  }
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
