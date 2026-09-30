// "Did the agent's closing text ask the user for input?" — the question test shared by the `stalled`
// detector (run.ts) and its lenient `ended_with_question` sibling (verdict.ts). One helper, so the two can
// never disagree about what counts as asking.
//
// A trailing `?` alone missed real stalls: a skill that asked four AskUserQuestion gates and then closed on
// "Please share your pre-money valuation and the total amount you're raising so I can run the numbers."
// stopped exactly as a "…for the Series A?" sibling did, and passed. The widening is a closed list of
// shapes matched against the LAST SENTENCE only (of the last line of the last paragraph), so a request
// buried mid-answer never counts and a polite closer after finished work is rejected before any pattern runs.

const LEAD = new Set([..." \t\r\n\f\v>*_`#-"]);
const TRAIL = new Set([..." \t\r\n\f\v*_`"]);
/** Strip Markdown emphasis/quote/bullet/heading wrappers at either end of a line or sentence. A loop, not
 *  `/[\s*_`]+$/`: an unanchored-start trailing class is quadratic on a long whitespace run (a 200k-space
 *  message took ~48 s), and this runs on untrusted model output. */
function unwrap(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && LEAD.has(s[a])) a++;
  while (b > a && TRAIL.has(s[b - 1])) b--;
  return s.slice(a, b);
}

/** The sentences of the last non-empty line of the last paragraph, wrappers stripped. */
function closingSentences(text: string): string[] {
  const para =
    text
      .trim()
      .split(/\n\s*\n/)
      .pop() ?? "";
  const line = para.split("\n").map(unwrap).filter(Boolean).pop() ?? "";
  return line
    .split(/(?<=[.!?])\s+(?=\S)/)
    .map(unwrap)
    .filter(Boolean);
}

/** What the agent asks the user to hand over. `let me know` counts only with `which`/`whether` — "let me
 *  know if…" and "let me know what you think" are closers. */
const REQUEST_VERB = String.raw`(?:share|provide|send|upload|attach|paste|confirm|specify|tell me|give me|reply with|choose|pick|select|let me know (?:which|whether))`;

/** Polite closers after completed work. Checked FIRST, and a match vetoes every pattern below. */
const CLOSER =
  /\b(?:any (?:feedback|thoughts|questions|comments|changes)|your (?:feedback|thoughts|questions|comments)|what you think|feel free|don't hesitate|do not hesitate|happy to)\b|^(?:please\s+|just\s+)?(?:let me know|tell me) if\b|^if you\b/i;

/** The request shapes. Each is anchored at the start of the closing sentence. */
const REQUEST_PATTERNS: readonly RegExp[] = [
  // "Please share X so I can run the numbers." / "Kindly provide …"
  new RegExp(String.raw`^(?:please|kindly)\s+${REQUEST_VERB}\b`, "i"),
  // "Let me know which option you prefer."
  /^(?:just\s+)?let me know (?:which|whether)\b/i,
  // "Once you share X, I'll …" / "Once I have the file, I'll …"
  new RegExp(
    String.raw`^(?:once|as soon as|when)\s+(?:you(?:'ve)?\s+${REQUEST_VERB}|I (?:have|get|receive) (?:the|that|this|those|these|your|it|them)\b)[^.!?]*\bI(?:'ll| will| can)\b`,
    "i",
  ),
  // "I need X to proceed." — `I need to …` is the agent narrating its own next step, not a request.
  /^I(?: still)?(?:'ll| will)? need (?!to\b)[^.!?]*\b(?:to (?:proceed|continue|get started)|before I can)\b/i,
];

/** A question followed only by an aside: "Which area? For example: a, b, or c." / "…signed? (Day matters.)" */
const TRAILER = /^(?:\(.*\)|(?:for example|for instance|e\.g\.)\b.*)$/i;

/**
 * True when the closing text asks the user for input WITHOUT ending on a `?`: an imperative request for
 * something the run needs (see REQUEST_PATTERNS), or a question followed only by an example/parenthetical
 * trailer. Never true for a polite closer (see CLOSER). Callers OR this with their own `?` test.
 */
export function endsOnRequestForInput(text: string | undefined): boolean {
  const s = closingSentences(text ?? "");
  const last = s[s.length - 1];
  if (last === undefined) return false;
  if (TRAILER.test(last)) return s.length >= 2 && s[s.length - 2].endsWith("?");
  if (CLOSER.test(last)) return false;
  return REQUEST_PATTERNS.some((re) => re.test(last));
}
