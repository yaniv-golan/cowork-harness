/**
 * The object form of `tool_called` / `tool_not_called`: a claim about what a tool call CARRIED (its
 * top-level input fields), WHERE it ran (main agent / sub-agent), and what its PAIRED result said.
 *
 * Evidence is `RunResult.toolCalls` (one classifier in `Run`, read identically on the live, replay and
 * verify-run lanes) joined to `toolResults` by `toolUseId`. Every "could not look" case fails CLOSED:
 *  - no `toolCalls` at all (an older result.json)                       → evidence unavailable, both ways;
 *  - an input field cut at its 10 KB cap that the regex missed           → the call is UNKNOWN;
 *  - a result predicate on an unpaired call, or one a truncated result
 *    cannot settle                                                        → the call is UNKNOWN;
 *  - a regex the recorder's redaction rewrote, or a redacted field the
 *    regex names a redactable literal of                                 → UNKNOWN / unavailable.
 * An UNKNOWN call can never make a negative pass, nor make a positive "not called" — it becomes
 * `evidence unavailable`.
 */
import type { AssertContext } from "./assert.js";
import type { ToolCalledObject, ToolNotCalledObject, ToolCallRecord } from "./types.js";
import { compileUserRegex } from "./regex.js";
import { scrubForTerminal } from "./io.js";
import { REDACTION_TOKEN_RE, hasRedactionToken, regexNamesRedactableLiteral } from "./redactable-literal.js";

type KeyResult = { pass: true; evidence?: string } | { pass: false; message: string };
type Status = "yes" | "no" | "unknown";
type Key = "tool_called" | "tool_not_called";

/** The globs to hand to the STRING evaluator when the value is a string, or an object carrying nothing
 *  but `tool` at the default scope — so `{tool: X}` behaves exactly like `"X"` everywhere. Undefined means
 *  "not routable": either the key is absent or the object form's own evaluator must run. */
export function routedToolGlobs(v: unknown): string[] | undefined {
  if (typeof v === "string") return [v];
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  // A predicate that constrains nothing — `input: {}`, `result: {}`, `count: {}` (count's default is
  // min 1, exactly the string form's meaning), `scope: main` — is no predicate: an empty conjunction is
  // true. Routing these keeps `{tool: X, input: {}}` ≡ `"X"` on every lane instead of making an empty
  // object fail evidence-unavailable on a result.json that predates toolCalls.
  const isEmptyObject = (x: unknown) =>
    !!x && typeof x === "object" && !Array.isArray(x) && Object.values(x as object).every((y) => y === undefined);
  const extra = Object.keys(o).filter(
    (k) =>
      k !== "tool" &&
      o[k] !== undefined &&
      !(k === "scope" && o.scope === "main") &&
      !((k === "input" || k === "result" || k === "count") && isEmptyObject(o[k])),
  );
  if (extra.length) return undefined;
  if (typeof o.tool === "string") return [o.tool];
  if (Array.isArray(o.tool) && o.tool.every((g) => typeof g === "string")) return o.tool as string[];
  return undefined;
}

/** Every regex source the object form carries, with where it lives — for bad-regex and redaction checks. */
export function toolCallObjectRegexes(o: ToolCalledObject | ToolNotCalledObject): Array<{ where: string; source: string }> {
  const out: Array<{ where: string; source: string }> = [];
  for (const [f, src] of Object.entries(o.input ?? {})) out.push({ where: `input.${f}`, source: src });
  if (o.input_any !== undefined) out.push({ where: "input_any", source: o.input_any });
  if (o.result?.matches !== undefined) out.push({ where: "result.matches", source: o.result.matches });
  if (o.result?.not_matches !== undefined) out.push({ where: "result.not_matches", source: o.result.not_matches });
  if (o.subagent_type !== undefined) out.push({ where: "subagent_type", source: o.subagent_type });
  return out;
}

const all = (xs: Status[]): Status => (xs.includes("no") ? "no" : xs.includes("unknown") ? "unknown" : "yes");

/** A regex MISS over `text` that cannot be trusted as absence: the text was cut, or it carries a
 *  redaction token. For a NEGATIVE-direction predicate (a miss is what lets the check pass) ANY token
 *  makes the miss unknown: the replaced bytes are unknowable, and no offline heuristic knows every policy
 *  (a custom literal, a wholesale `keys:` rule). For a positive-direction predicate a miss only fails, so
 *  it stays a plain "no" unless the regex names a literal of a kind redaction rewrites — which just makes
 *  the red say "could not look" instead of "not called". */
function missIsUnknown(text: string, truncated: boolean | undefined, source: string, negativeDirection: boolean): boolean {
  if (truncated === true) return true;
  if (!hasRedactionToken(text)) return false;
  return negativeDirection || regexNamesRedactableLiteral(source);
}

/** A passing evidence line never quotes a redaction token: it would present rewritten bytes as though
 *  they were what the check saw. */
const scrubTokens = (s: string): string => s.replace(REDACTION_TOKEN_RE, "(redacted)");

/** The text a regex HIT is judged on: every redaction token replaced by a sentinel no author regex can
 *  match into, so `key`, `REDACTED` or a 12-hex-digit pattern never "hits" a token's own label or hash.
 *  A MISS is still judged by missIsUnknown on the original text (token present ⇒ unknown). */
const HIT_SENTINEL = "\u0000";
const hitText = (s: string): string => s.replace(REDACTION_TOKEN_RE, HIT_SENTINEL);

export function checkToolCallObject(
  key: Key,
  o: ToolCalledObject | ToolNotCalledObject,
  ctx: AssertContext,
  toolMatches: (pattern: string, name: string) => boolean,
  warnIfRegexish: (key: string, pattern: string) => void,
): KeyResult {
  const fail = (message: string): KeyResult => ({ pass: false, message });
  const negative = key === "tool_not_called";
  const globs = Array.isArray(o.tool) ? o.tool : [o.tool];
  for (const g of globs) warnIfRegexish(key, g);
  const shownTool = globs.join(" | ");

  // A frozen regex that record-time redaction rewrote (a `[REDACTED:…]` token spliced into the source —
  // which is now a character class) no longer says what the author wrote. Both directions are unknowable.
  const sources = toolCallObjectRegexes(o);
  const redactedSrc = sources.find((s) => hasRedactionToken(s.source));
  if (redactedSrc)
    return fail(
      `evidence unavailable: ${key}.${redactedSrc.where} was rewritten by the cassette's redaction policy ("${scrubForTerminal(redactedSrc.source).slice(0, 120)}") — ` +
        `it cannot be evaluated on replay. Assert on a literal the policy does not rewrite, or check it on a live run`,
    );
  const compiled = new Map<string, RegExp>();
  for (const s of sources) {
    const c = compileUserRegex(s.source);
    if ("error" in c) return fail(`${key}: bad regex "${s.source}" in ${s.where}: ${c.error}`);
    compiled.set(s.where, c.re);
  }

  if (ctx.toolCalls === undefined)
    return fail(
      `evidence unavailable: ${ctx.toolCallsMissing ? "tool calls absent from result.json (recorded before the field existed)" : "no tool-call record on this lane"} — ` +
        `cannot evaluate the object form of ${key}`,
    );

  const scope = o.scope ?? "main";
  const dispatches = new Map(ctx.subagents.filter((s) => s.toolUseId !== undefined).map((s) => [s.toolUseId!, s]));
  const typeRe = compiled.get("subagent_type");
  const typeOk = (c: ToolCallRecord): boolean => {
    if (!typeRe) return true;
    const d = c.parentToolUseId !== undefined ? dispatches.get(c.parentToolUseId) : undefined;
    if (!d) return false;
    return (
      typeRe.test(d.dispatchAgentType) ||
      (d.resolvedAgentType !== undefined && typeRe.test(d.resolvedAgentType)) ||
      typeRe.test(d.description ?? "")
    );
  };
  const inScope = (c: ToolCallRecord): boolean => (scope === "any" || c.origin === scope) && typeOk(c);

  const inputStatus = (c: ToolCallRecord): Status => {
    const parts: Status[] = [];
    for (const [f, src] of Object.entries(o.input ?? {})) {
      const v = c.input[f];
      if (!v) parts.push("no");
      else if (compiled.get(`input.${f}`)!.test(hitText(v.text))) parts.push("yes");
      else parts.push(missIsUnknown(v.text, v.truncated, src, negative) ? "unknown" : "no");
    }
    if (o.input_any !== undefined) {
      const re = compiled.get("input_any")!;
      const fields = Object.values(c.input);
      if (fields.some((v) => re.test(hitText(v.text)))) parts.push("yes");
      else parts.push(fields.some((v) => missIsUnknown(v.text, v.truncated, o.input_any!, negative)) ? "unknown" : "no");
    }
    return all(parts);
  };

  const resultStatus = (c: ToolCallRecord): { s: Status; note: string } => {
    if (!o.result) return { s: "yes", note: "" };
    if (ctx.toolResults === undefined) return { s: "unknown", note: "results absent" };
    const r = c.toolUseId !== undefined ? ctx.toolResults.find((x) => x.toolUseId === c.toolUseId) : undefined;
    if (!r) return { s: "unknown", note: "unpaired" };
    const text = r.text ?? "";
    const parts: Status[] = [];
    if (o.result.is_error !== undefined) parts.push(r.isError === o.result.is_error ? "yes" : "no");
    if (o.result.matches !== undefined)
      parts.push(
        compiled.get("result.matches")!.test(hitText(text))
          ? "yes"
          : missIsUnknown(text, r.assertTextTruncated, o.result.matches, negative)
            ? "unknown"
            : "no",
      );
    if (o.result.not_matches !== undefined)
      parts.push(
        compiled.get("result.not_matches")!.test(hitText(text))
          ? "no"
          : missIsUnknown(text, r.assertTextTruncated, o.result.not_matches, !negative)
            ? "unknown"
            : "yes",
      );
    return { s: all(parts), note: r.assertTextTruncated ? "paired, truncated" : "paired" };
  };

  // Show the fields the author named (or the first field) — what DID run is the most useful line in a red.
  const shownFields = Object.keys(o.input ?? {});
  const describe = (c: ToolCallRecord, note: string): string => {
    const names = shownFields.length ? shownFields : Object.keys(c.input).slice(0, 1);
    const fields = names
      .map((f) => `${f}=${c.input[f] ? JSON.stringify(scrubForTerminal(c.input[f].text).slice(0, 120)) : "(absent)"}`)
      .join(" ");
    return `${c.name}[${c.origin}]${fields ? " " + fields : ""}${note ? ` (${note})` : ""}`;
  };

  const named = ctx.toolCalls.filter((c) => globs.some((g) => toolMatches(g, c.name)));
  const satisfied: string[] = [];
  const unknown: string[] = [];
  const rejected: string[] = [];
  const outOfScope = new Map<string, number>();
  for (const c of named) {
    const inp = inputStatus(c);
    if (!inScope(c)) {
      if (inp !== "no") {
        const where = typeOk(c) || scope !== "subagent" ? c.origin : `${c.origin}, other subagent_type`;
        outOfScope.set(where, (outOfScope.get(where) ?? 0) + 1);
      }
      continue;
    }
    if (inp === "no") {
      rejected.push(describe(c, "input mismatch"));
      continue;
    }
    const res = resultStatus(c);
    if (res.s === "no") rejected.push(describe(c, `result mismatch, ${res.note}`));
    else if (inp === "unknown" || res.s === "unknown")
      unknown.push(describe(c, inp === "unknown" ? "input truncated or redacted" : `result ${res.note}`));
    else satisfied.push(describe(c, res.note));
  }

  const sample = (xs: string[]) => xs.slice(0, 5).join("; ") + (xs.length > 5 ? `; …(+${xs.length - 5})` : "");
  const scopeHint = [...outOfScope]
    .map(
      ([where, n]) =>
        `${n} matching call${n === 1 ? "" : "s"} in scope ${where} — set \`scope: any\` (or \`scope: ${where.split(",")[0]}\`) to count ${n === 1 ? "it" : "them"}`,
    )
    .join("; ");
  const context =
    (rejected.length
      ? ` Considered in scope ${scope}: ${sample(rejected)}.`
      : named.length === 0
        ? ` No ${shownTool} call was recorded at all.`
        : "") + (scopeHint ? ` ${scopeHint}.` : "");

  // What a negative pass did NOT look at: name-matching calls outside the scope, by origin.
  const notChecked = (): string => {
    const by = new Map<string, number>();
    for (const c of named) if (!inScope(c)) by.set(c.origin, (by.get(c.origin) ?? 0) + 1);
    if (!by.size) return "";
    const label = (o: string) => (o === "subagent" ? "sub-agent" : o === "main" ? "main-agent" : "unknown-origin");
    const parts = [...by].map(([o, n]) => `${n} ${label(o)} call${n === 1 ? "" : "s"}`);
    return `; ${parts.join(", ")} not checked (use \`scope: any\` to include ${by.size === 1 && [...by.values()][0] === 1 ? "it" : "them"})`;
  };
  if (negative) {
    if (satisfied.length)
      return fail(
        `tool unexpectedly called: ${satisfied.length} ${shownTool} call(s) in scope ${scope} satisfied every predicate: ${sample(satisfied)}`,
      );
    if (unknown.length)
      return fail(
        `evidence unavailable: ${unknown.length} ${shownTool} call(s) in scope ${scope} could not be ruled out — ${sample(unknown)}. ` +
          `A negative check cannot pass over evidence it could not read`,
      );
    return {
      pass: true,
      evidence:
        `tool_not_called: no ${shownTool} call satisfied every predicate — ${named.filter(inScope).length} in scope ${scope} checked` +
        notChecked(),
    };
  }
  const min = (o as ToolCalledObject).count?.min ?? 1;
  const max = (o as ToolCalledObject).count?.max;
  const n = satisfied.length;
  if (n === 0 && min === 0 && (max === undefined || unknown.length <= max))
    return {
      pass: true,
      evidence: `tool_called: 0 ${shownTool} call(s) in scope ${scope} satisfied every predicate, which count.min 0 allows (${named.length} name-matching call(s) checked)`,
    };
  if (n >= min && (max === undefined || n + unknown.length <= max))
    return {
      pass: true,
      evidence: scrubTokens(`tool_called: ${n} ${shownTool} call(s) in scope ${scope} satisfied every predicate: ${sample(satisfied)}`),
    };
  if (max !== undefined && n > max)
    return fail(`tool called too often: ${n} ${shownTool} call(s) satisfied every predicate (max ${max}): ${sample(satisfied)}`);
  if (unknown.length)
    return fail(
      `evidence unavailable: ${n} ${shownTool} call(s) satisfied every predicate (need ${min}${max !== undefined ? `..${max}` : "+"}), and ${unknown.length} more could not be settled — ${sample(unknown)}`,
    );
  return fail(
    n === 0
      ? `tool not called: no ${shownTool} call in scope ${scope} satisfied every predicate.${context}`
      : `tool called too rarely: ${n} ${shownTool} call(s) satisfied every predicate (min ${min}).${context}`,
  );
}
