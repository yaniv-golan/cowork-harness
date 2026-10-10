// A bounded repair for an evaluator reply whose `{"items":[...]}` document is complete except for its trailing
// closer(s) — the model ended on `…}]` without the final `}`. Without it, one missing character discards a whole
// critique.
//
// STRICT, by construction:
//   - the document must start at a `{"items":` opener;
//   - from there to the end of the reply, every closer must match its opener, outside strings (escapes honoured);
//   - the text must end OUTSIDE a string, with only unclosed openers left;
//   - the repair appends exactly those closers, in order, and nothing else — no truncation, no item dropped, no
//     inner fix;
//   - the result must then parse as JSON. Anything else is refused (null), and the caller fails as before.
// A reply cut mid-item, mid-string, or with a missing inner comma does not parse after the append, so it is refused.

const OPEN_TO_CLOSE: Record<string, string> = { "{": "}", "[": "]" };

export interface ReplyRepair {
  /** The repaired document: the unclosed `{"items":…` tail plus the appended closers. */
  text: string;
  /** The closers appended, in order (e.g. `}`). */
  appended: string;
}

/** Scan `s` from 0, tracking strings and the bracket stack. `null` when a closer does not match its opener, when the
 *  scan ends inside a string, or when the stack returns to empty (the document closed on its own — not a candidate). */
function unclosedOpeners(s: string): string[] | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") stack.push(c);
    else if (c === "}" || c === "]") {
      const top = stack.pop();
      if (top === undefined || OPEN_TO_CLOSE[top] !== c) return null;
      if (stack.length === 0) return null; // the document closed itself; nothing to repair here
    }
  }
  if (inString || stack.length === 0) return null;
  return stack;
}

/** Repair `raw` if — and only if — exactly one `{"items":` document in it is missing only its trailing closers.
 *  Returns null otherwise. */
export function repairTrailingClosers(raw: string): ReplyRepair | null {
  const found: ReplyRepair[] = [];
  for (const m of raw.matchAll(/\{\s*"items"\s*:/g)) {
    const tail = raw.slice(m.index!);
    const open = unclosedOpeners(tail);
    if (open === null) continue;
    const appended = open
      .reverse()
      .map((o) => OPEN_TO_CLOSE[o]!)
      .join("");
    const text = tail + appended;
    try {
      JSON.parse(text);
    } catch {
      continue;
    }
    found.push({ text, appended });
  }
  // Two repairable candidates would be an ambiguity this repair must not resolve.
  return found.length === 1 ? found[0]! : null;
}
