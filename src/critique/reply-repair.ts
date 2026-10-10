// A bounded repair for an evaluator reply whose `{"items":[...]}` document is complete except for its trailing
// closer(s) — the model ended on `…}]` without the final `}`. Without it, one missing character discards a whole
// critique.
//
// STRICT, by construction:
//   - the reply is scanned from its start; outside any bracket (prose) quotes are not strings, inside a bracket they
//     are, with escapes honoured;
//   - every closer must match its opener;
//   - the text must end OUTSIDE a string, with unclosed openers left, and the OUTERMOST unclosed opener must be the
//     `{` of a `{"items":` document — so nothing before the document is dropped, and nothing it is nested in is
//     silently left unclosed;
//   - the repair appends exactly those closers, in order, and nothing else — no truncation, no inner fix;
//   - the result must then parse as JSON. Anything else is refused (null), and the caller fails as before.
// A reply cut mid-item, mid-string, or with a missing inner comma does not parse after the append, so it is refused.
// One shape this cannot tell apart: a cut right after a complete number (`"n":1` where `12` was meant) parses; only
// string fields are validated or used, so it is harmless here.

const OPEN_TO_CLOSE: Record<string, string> = { "{": "}", "[": "]" };

export interface ReplyRepair {
  /** The repaired document: the unclosed `{"items":…` tail plus the appended closers. */
  text: string;
  /** The closers appended, in order (e.g. `}`). */
  appended: string;
  /** The items array itself was left open (`]` appended): the model may have been cut off mid-list, so items after
   *  the last complete one can be missing. */
  possiblyTruncated: boolean;
}

/** Repair `raw` if — and only if — its one unclosed top-level document is a `{"items":` document missing only its
 *  trailing closers. Returns null otherwise. */
export function repairTrailingClosers(raw: string): ReplyRepair | null {
  const stack: Array<{ c: string; at: number }> = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    // A quote is a string only inside a bracket: a double quote in surrounding prose is not JSON.
    if (c === '"' && stack.length > 0) inString = true;
    else if (c === "{" || c === "[") stack.push({ c, at: i });
    else if (c === "}" || c === "]") {
      const top = stack.pop();
      // A stray closer in prose (nothing open) is not ours to judge; a mismatched one inside a document refuses.
      if (top !== undefined && OPEN_TO_CLOSE[top.c] !== c) return null;
    }
  }
  if (inString || stack.length === 0) return null;
  const outer = stack[0]!;
  if (!/^\{\s*"items"\s*:/.test(raw.slice(outer.at))) return null;
  const appended = [...stack]
    .reverse()
    .map((o) => OPEN_TO_CLOSE[o.c]!)
    .join("");
  const text = raw.slice(outer.at) + appended;
  try {
    JSON.parse(text);
  } catch {
    return null;
  }
  return { text, appended, possiblyTruncated: appended.includes("]") };
}
