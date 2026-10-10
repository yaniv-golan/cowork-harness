// A bounded repair for an evaluator reply whose `{"items":[...]}` document is complete except for its FINAL closing
// brace — the model ended on `…}]` without the last `}`. Without it, one missing character discards a whole critique.
// Only that one brace is ever appended: a reply that would need a `]` (the findings list left open) is what a reply
// cut off mid-list looks like, and is refused so the critique is re-run rather than silently missing findings.
//
// STRICT, by construction:
//   - the reply is scanned from its start; outside any bracket (prose) quotes are not strings, inside a bracket they
//     are, with escapes honoured;
//   - every closer must match its opener;
//   - the text must end OUTSIDE a string with exactly one unclosed opener, and it must be the `{` of a `{"items":`
//     document — so nothing before the document is dropped, nothing it is nested in is left unclosed, and the repair
//     appends exactly one `}`: no `]`, no truncation, no inner fix;
//   - the result must then parse as JSON. Anything else is refused (null), and the caller fails as before.
// A reply cut mid-item, mid-string, or with a missing inner comma does not parse after the append, so it is refused.
// One shape this cannot tell apart: a cut right after a complete number (`"n":1` where `12` was meant) parses; only
// string fields are validated or used, so it is harmless here.

const OPEN_TO_CLOSE: Record<string, string> = { "{": "}", "[": "]" };

export interface ReplyRepair {
  /** The repaired document: the unclosed `{"items":…` tail plus the appended `}`. */
  text: string;
  /** What was appended: always the single closing brace `}`. */
  appended: "}";
}

/** Repair `raw` if — and only if — its one unclosed top-level document is a `{"items":` document missing only its
 *  final `}`. Returns null otherwise. */
export function repairMissingFinalBrace(raw: string): ReplyRepair | null {
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
  // Exactly one opener left, and it is the items document's own `{`: anything more (a `]` to close the list) is refused.
  if (inString || stack.length !== 1) return null;
  const outer = stack[0]!;
  if (outer.c !== "{" || !/^\{\s*"items"\s*:/.test(raw.slice(outer.at))) return null;
  const text = raw.slice(outer.at) + "}";
  try {
    JSON.parse(text);
  } catch {
    return null;
  }
  return { text, appended: "}" };
}
