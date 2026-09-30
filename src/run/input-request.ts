// "Did the agent's closing text ask the user for input?" — the question test shared by the `stalled`
// detector (run.ts) and its lenient `ended_with_question` sibling (verdict.ts). One helper, so the two can
// never disagree about what counts as asking.
//
// A trailing `?` alone missed real stalls: a skill that asked four AskUserQuestion gates and then closed on
// "Please share your pre-money valuation and the total amount you're raising so I can run the numbers."
// stopped exactly as a "…for the Series A?" sibling did, and passed. The widening is a closed list of
// shapes matched against the LAST SENTENCE only (of the last line of the last paragraph), so a request
// buried mid-answer never counts and a polite closer after finished work is rejected before any pattern runs.
// Every imperative must also carry a cue that the input comes BACK to the agent ("so I can…", "here",
// "and I'll…"): "Please share this with your team." is a closer after finished work, not a stall.
// English only: a closing request in any other language falls back to the `?` rule.

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

/** Trailing wrappers that can follow a closing `?`: emphasis, quotes, a closing paren, emoji. */
const QUESTION_TAIL = /[\s*_`)"'\u201d\u2019\uFE0F\u200D]|\p{Extended_Pictographic}/u;
/** True when the sentence ends in `?` once trailing wrappers are stripped ("**Which one?**", "(A or B?)"). */
function endsInQuestionMark(sentence: string): boolean {
  const cps = [...sentence];
  let i = cps.length - 1;
  while (i >= 0 && QUESTION_TAIL.test(cps[i])) i--;
  return i >= 0 && cps[i] === "?";
}

/** The sentences of the last non-empty line of the last paragraph, wrappers stripped. Empty when that
 *  paragraph ends in a fenced code block or its last line is a `>` blockquote — quoted or generated
 *  text, not the agent asking in its own voice. */
function closingSentences(text: string): string[] {
  const para =
    text
      .trim()
      .split(/\n\s*\n/)
      .pop() ?? "";
  const lines = para.split("\n").filter((l) => l.trim() !== "");
  const lastRaw = (lines[lines.length - 1] ?? "").trim();
  if (lastRaw.startsWith("```") || lastRaw.startsWith("~~~") || lastRaw.startsWith(">")) return [];
  const line = unwrap(lastRaw);
  const sentences = line
    .split(/(?<=[.!?])\s+(?=\S)/)
    .map(unwrap)
    .filter(Boolean);
  // A trailing emoji/wrapper-only "sentence" ("Which one? 🙂") belongs to the sentence before it.
  while (sentences.length > 1 && [...sentences[sentences.length - 1]].every((c) => QUESTION_TAIL.test(c))) {
    const tail = sentences.pop();
    sentences[sentences.length - 1] += " " + tail;
  }
  return sentences;
}

/** A closing request is a sentence, not an essay: past this length only the `?` test runs, which also
 *  bounds the backtracking patterns below on untrusted model output. */
const MAX_SENTENCE = 1000;

/** What the agent asks the user to hand over. `let me know` counts only with `which`/`whether` — "let me
 *  know if…" and "let me know what you think" are closers. */
const REQUEST_VERB = String.raw`(?:share|provide|send|upload|attach|paste|confirm|specify|tell me|give me|reply with|choose|pick|select|let me know (?:which|whether))`;

/** The cue that the requested input comes back to the agent. Required by every imperative shape. */
const CUE =
  /\bso (?:that )?I\b|\band I(?:'ll| will)\b|\bto (?:proceed|continue|get started)\b|\b(?:paste|share|upload|drop|reply|type|send)\b[^.!?]*\bhere\b|\bhere[.!]?$|\bwith me\b|\bto me\b|\bfor me to\b|\bin (?:the )?chat\b|\brepl(?:y|ies)\b|\byou(?:'d| would) like (?:me )?to\b|\byou (?:want|need) me to\b/i;

/** Polite closers after completed work, and hand-offs to someone else. Checked FIRST; a match vetoes every
 *  imperative shape below. */
/** A third party the input is aimed at ("with the team", "to the founders", "with the CFO"). A named list,
 *  not any "to/with the <noun>": "Please reply with the numbers so I can…" is a real request. "with me" /
 *  "to me" are cues, not recipients. */
const RECIPIENT =
  /\b(?:to|with) (?:(?:the|our|his|her|their|your) (?:\w+ )?(?:team|teams|board|cfo|ceo|coo|founders?|co-?founders?|partners?|investors?|lawyers?|counsel|attorneys?|accountants?|clients?|customers?|managers?|colleagues|stakeholders|committee|auditors?|advisors?|group|syndicate|lps?)|him|them|everyone|anyone)\b/i;
const CLOSER =
  /\b(?:any (?:feedback|thoughts|questions|comments|changes)|your (?:feedback|thoughts|questions|comments)|thoughts|feedback|what you think|feel free|don't hesitate|do not hesitate|happy to|with your|to your|before (?:signing|sending)|whichever|how it goes|a shout)\b|^(?:please\s+|just\s+)?(?:let me know|tell me) if\b|^if you\b/i;

/** "Please share X so I can run the numbers." / "Let me know which one you want me to use." */
const IMPERATIVE = new RegExp(String.raw`^(?:(?:please|kindly)\s+${REQUEST_VERB}|(?:just\s+)?let me know (?:which|whether))\b`, "i");
/** "Once you share X, I'll …" — the "I'll" is the cue. */
const ONCE_YOU = new RegExp(String.raw`^(?:once|as soon as|when)\s+you(?:'ve)?\s+${REQUEST_VERB}\b[^.!?]*\bI(?:'ll| will| can)\b`, "i");
/** "Once I have the file, I'll …" — a request only when the sentence before it asked for the input. */
const ONCE_I_HAVE =
  /^(?:once|as soon as|when)\s+I (?:have|get|receive) (?:the|that|this|those|these|your|it|them)\b[^.!?]*\bI(?:'ll| will| can)\b/i;
const PRIOR_REQUEST = new RegExp(String.raw`\b(?:please|kindly)\s[^.!?]*\b${REQUEST_VERB}\b`, "i");
/** "I need X to proceed." — the whole sentence. "I need to …" is the agent narrating its own next step, and
 *  "…before I can make a firm call, but the base case is solid" is not a request. */
const I_NEED = /^I(?: still)?(?:'ll| will)? need (?!to\b)[^.!?]*\b(?:to (?:proceed|continue|get started)|before I can\b[^.!?,;]*)[.!]?$/i;

/** A question followed only by an aside: "Which area? For example: a, b, or c." / "…signed? (Day matters.)" */
const TRAILER = /^(?:\(.*\)|(?:for example|for instance|e\.g\.)\b.*)$/i;

/**
 * True when the closing sentence asks the user for input: it ends in `?` once wrappers are stripped
 * ("**Which scenario?**"), it is a question followed only by an example/parenthetical trailer, or it is a
 * cued imperative request (see IMPERATIVE / ONCE_YOU / ONCE_I_HAVE / I_NEED). Never true for a polite
 * closer or a hand-off (see CLOSER), nor when the closing text is a code fence or blockquote. Callers apply
 * it only once an AskUserQuestion gate has fired, and OR it with their own raw `?` test.
 */
export function endsOnRequestForInput(text: string | undefined): boolean {
  const s = closingSentences(text ?? "");
  const last = s[s.length - 1];
  if (last === undefined) return false;
  if (endsInQuestionMark(last)) return true;
  if (TRAILER.test(last)) return s.length >= 2 && endsInQuestionMark(s[s.length - 2]);
  if (last.length > MAX_SENTENCE || CLOSER.test(last) || RECIPIENT.test(last)) return false;
  if (I_NEED.test(last) || ONCE_YOU.test(last)) return true;
  if (ONCE_I_HAVE.test(last)) {
    const prev = s[s.length - 2];
    return (
      prev !== undefined &&
      prev.length <= MAX_SENTENCE &&
      PRIOR_REQUEST.test(prev) &&
      CUE.test(prev) &&
      !CLOSER.test(prev) &&
      !RECIPIENT.test(prev)
    );
  }
  return IMPERATIVE.test(last) && CUE.test(last);
}
