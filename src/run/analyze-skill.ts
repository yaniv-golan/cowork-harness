import { existsSync, readFileSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "../cli-args.js";
import { isVmSessionsPath } from "../vm-paths.js";
import { fail, isJsonOutput, jsonPayloadEnvelope } from "./envelope.js";

// Synchronous fd writes (match cli.ts / doctor.ts / cassette.ts): machine→stdout, human→stderr.
const out = (s: string) => writeSync(1, s + "\n");
const log = (s: string) => writeSync(2, s + "\n");

/**
 * `analyze-skill` — a token-free, static CI check that flags a `/sessions/...` path handed to a
 * FILE TOOL or used as a dispatch/sub-agent OUTPUT path in a SKILL.md. On host-loop that class of
 * path is DENIED by production's own path gate (the agent's file tools run on the host filesystem;
 * `/sessions` is a VM path) — see `../hostloop/pretooluse-path-hook.ts` / `../hostloop/canusetool-gate.ts`.
 * This lets a consumer catch the defect BEFORE paying for a live host-loop run that would otherwise be
 * the only way to discover it.
 *
 * DESIGN SPLIT — read this before touching the regexes below: the DENY DECISION is production's own
 * logic, reused verbatim via `isVmSessionsPath` (imported, never re-implemented). Everything in this
 * file is the EXTRACTION layer around that decision — a heuristic guess at "does this SKILL.md text
 * hand a /sessions path to a file tool," which is the only part that can be wrong. Because a false
 * positive here would incorrectly fail a consumer's CI on innocent text, every rule below is
 * deliberately conservative: several EXEMPT guards exist specifically to suppress a firing that isn't
 * really the /sessions-to-file-tool defect, and when a heuristic can't tell, it does NOT flag (see the
 * "Honest limits" block at the bottom).
 */

export type SkillAnalysisRuleId = "sessions-path-to-file-tool" | "sessions-find-into-file-read";

export interface SkillFinding {
  rule: SkillAnalysisRuleId;
  path: string;
  line: number;
  message: string;
}

/** Fenced-block languages treated as "legitimate in-VM bash" and therefore exempt from every rule.
 *  Includes plain shell names plus the common shell-transcript aliases (`console`, `*-session`) — a
 *  `$ cmd` transcript block is exactly as bash-ish as a raw `bash` fence. Matched EXACTLY, not by
 *  prefix — an earlier `sh`-prefix match over-exempted unrelated langs that merely start with those
 *  letters (e.g. ` ```shiny `), silencing a real `Write(/sessions/...)` inside them. */
const BASH_FENCE_LANGS = new Set(["bash", "sh", "shell", "zsh", "console", "sh-session", "shell-session", "shellsession"]);
function isBashishLang(lang: string): boolean {
  return BASH_FENCE_LANGS.has(lang);
}
/** Opening/closing fence: ``` or ~~~ (>=3), optionally blockquote-prefixed (`> `, possibly nested), a
 *  language token, and — for the OPENER only — any trailing info-string/attributes (`title="x"`,
 *  `{.line-numbers}`) are tolerated and ignored: the language is always the FIRST word after the fence
 *  marker, never the whole rest of the line. A bare closer (no language token, nothing else on the line
 *  beyond optional trailing junk with no leading identifier chars) is still recognized as a close. */
const FENCE_RE = /^(?:>\s*)*\s*(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)(?:\s+.*)?$/;
/** A generic "path-ish" token: starts with `/`, runs until whitespace or a delimiter that could not be
 *  part of a bare path in prose/markdown (quote, backtick, closing paren/bracket). This is intentionally
 *  BROADER than a real path — it is filtered down to genuine `/sessions` candidates by `isVmSessionsPath`
 *  immediately after extraction, exactly as the brief specifies ("test candidates with isVmSessionsPath"). */
const GENERIC_PATH_RE = /\/[^\s"'`)\]]+/g;
const OUTPUT_ASSIGN_RE = /\b(OUTPUT_PATH|OUTPUT_DIR)\s*[:=]\s*"?(\/[^\s"'`)\]]+)/g;
const DIRECTIVE_RE = /\b(Write|Read|Edit|Glob|Grep)\(([^)]*)\)/g;
const PROSE_VERB_RE = /\b(write|writes|writing|wrote|save|saves|saving|saved|read|reads|reading|edit|edits|editing|edited)\b/gi;
const PROSE_PREP_RE = /\b(to|at)\b/gi;
/** Passive-voice auxiliary immediately preceding a verb match — "are saved", "is read", "were written".
 *  Passive documentation prose ("Deliverables are saved at ...") is not an imperative instruction to the
 *  agent, so it must not count as the prose POSITIVE context. */
const PASSIVE_AUX_RE = /\b(?:is|are|was|were|be|been|being)\s*$/i;
/** A mention of the `bash` tool. Scoped to the prose context only — an explicit `Write(/sessions/...)`
 *  directive is unambiguous regardless of a stray "bash" nearby, so this is never consulted for
 *  structured (OUTPUT_PATH/directive/bare-dispatch-path) contexts. Within prose, suppression has TWO
 *  tiers (see `proseContextBeforeToken`): the INSTRUMENT phrase "bash tool" (bare `BASH_TOOL_PHRASE_RE`
 *  below) suppresses if it appears ANYWHERE on the line — a fronted or trailing instrument clause
 *  ("Using the bash tool, write ... to /sessions/...", "Write ... to /sessions/... using the bash tool")
 *  is still the tool's own correct remediation even though it sits outside the clause that links the verb
 *  to the path. A BARE "bash" mention (no "tool") is narrower and stays CLAUSE-scoped (`bashInLastClause`)
 *  — "After the bash step completes, use the Write tool to write ... to /sessions/..." names an unrelated
 *  earlier clause ("bash step", not "the bash tool") and must not suppress. */
const BASH_TOOL_MENTION_RE = /\bbash\b/i;
/** The INSTRUMENT phrase "bash tool" (optionally "the bash tool") — see `BASH_TOOL_MENTION_RE` above for
 *  the two-tier rationale. Matched anywhere on the line, not clause-scoped. */
const BASH_TOOL_PHRASE_RE = /\bbash tool\b/i;
/** Clause-boundary punctuation (`,` `.` `;`) used to isolate the FINAL clause of a prose fragment —
 *  the one that actually contains the verb-to-path instruction — from any earlier clause. */
const CLAUSE_BOUNDARY_RE = /[,.;]/;
/** A line whose only content (after an optional short `key:`/`key=` label, optional surrounding
 *  quote/backtick, and optional trailing sentence/argument punctuation) is a single path token:
 *  "OUTPUT_PATH=/sessions/..." or a bare "/sessions/{{id}}/mnt/outputs/x.json" line — including the
 *  trailing-comma shape a multi-line `Task(...)`/`output_path="...",` argument list produces. Deliberately
 *  does NOT match a path embedded inside a larger sentence or command string
 *  (`Task(prompt="... /sessions/... ...")`) — that shape must NOT be treated as a bare dispatch-construct
 *  path. */
const BARE_PATH_LINE_RE = /^\s*(?:[A-Za-z_][\w-]*\s*[:=]\s*)?["'`]?(\/[^\s"'`]+)["'`]?[.,;]?\s*$/;
/** A `$VAR` / `${VAR}` reference — used on the Read(/Grep( SIDE of rule 2's two-line shape to check
 *  whether the directive's body references the find's captured output variable. */
const VAR_TOKEN_RE = /\$\{?(\w+)\}?/g;
/** `VAR=$(find ...)` command-substitution assignment — captures the ASSIGNED var name, not every `$VAR`
 *  referenced anywhere on the find line (an `-name "$NAME"` argument is find's INPUT, not its output). */
const FIND_ASSIGN_RE = /\b([A-Za-z_]\w*)\s*=\s*\$\(\s*find\b/i;
/** `find ... > $VAR` / `find ... > VAR` redirection — captures the OUTPUT var/file name, same rationale
 *  as `FIND_ASSIGN_RE`. */
const FIND_REDIRECT_RE = /\bfind\b[^|;]*?>\s*\$?\{?([A-Za-z_]\w*)\}?/i;
/** Anti-instruction guard: "NEVER write to `/sessions/...`" (and siblings). Applied whole-line
 *  (`hasNegationNearby`, current + adjacent line) ONLY to the low-confidence PROSE context — "Never use a
 *  file tool for VM paths. / Instead, write the report to `/sessions/...`" must not fire, since the
 *  anti-instruction sits one clause/line away. It is NOT consulted whole-line for the HIGH-confidence
 *  STRUCTURED contexts (OUTPUT_PATH/directive-target/bare-dispatch-path): a stray "not"/"avoid" elsewhere
 *  on the line or on an adjacent line must never suppress those — an author writing
 *  `Write(/sessions/...)` next to "Do not modify any other file." is still handing a `/sessions` path to a
 *  file tool. Structured contexts instead get a NARROW, directive-scoped carve-out
 *  (`directiveClauseHasNegation`) for the genuine teaching idiom "❌ Write(/sessions/...) — never do this;
 *  use the bash tool instead." — the negation must sit in the SAME clause as the directive itself, not
 *  merely on the same line. */
const NEGATION_RE = /\b(never|don'?t|do\s+not|avoid|not)\b/i;
const DISPATCH_MARKER_RE = /\bTask\(|\bsubagent_type\b/;
const FIND_KEYWORD_RE = /\bfind\b/i;
const READ_GREP_START_RE = /\b(Read|Grep)\(/;

const TIER_NOTE =
  "denied on host-loop (the file tool runs on the host filesystem; `/sessions` is a VM path) — use a " +
  "host/relative outputs path, or the `bash` tool for `/sessions`. VM tiers (container/microvm) permit `/sessions`.";

/** Strip trailing sentence/markdown punctuation a path-ish regex match can pick up (e.g. a period ending
 *  a sentence, or a trailing comma in a list). Never strips characters that are valid inside a path
 *  (`/`, `-`, `_`, `.` mid-token, `$`, `{`, `}`). */
function trimTrailingPunct(token: string): string {
  return token.replace(/[.,;:!?]+$/, "");
}

/** Extract every `/sessions`-shaped token on `line` (candidate extraction via `GENERIC_PATH_RE`,
 *  filtered by the production `isVmSessionsPath` predicate — the only non-heuristic part of this
 *  file). Returns each token's trimmed text and its start index in `line` (for proximity checks). */
function extractSessionsTokens(line: string): { token: string; index: number }[] {
  const hits: { token: string; index: number }[] = [];
  for (const m of line.matchAll(GENERIC_PATH_RE)) {
    const trimmed = trimTrailingPunct(m[0]);
    if (isVmSessionsPath(trimmed)) hits.push({ token: trimmed, index: m.index });
  }
  return hits;
}

/** Is `bash` mentioned in the FINAL clause of `before` (the clause containing the actual verb-to-path
 *  instruction), rather than merely somewhere earlier on the line? Splits on clause-boundary punctuation
 *  (`,` `.` `;`) and only inspects the last segment — "Use the bash tool to write the summary to
 *  `/sessions/...`" has no internal clause boundary, so the whole (single) clause is inspected and
 *  suppresses; "After the bash step completes, use the Write tool to write ... to `/sessions/...`" has a
 *  comma severing the "bash step" clause from the "use the Write tool" clause that actually governs the
 *  verb, so `bash` in the earlier clause does NOT suppress. */
function bashInLastClause(before: string): boolean {
  const segments = before.split(CLAUSE_BOUNDARY_RE);
  return BASH_TOOL_MENTION_RE.test(segments[segments.length - 1]);
}

/** Directive-clause negation check: does the CLAUSE containing the match span `[start, end)` on `line` also carry a negation token
 *  (`never`/`don't`/`do not`/`avoid`/`not`)? Finds the nearest clause-boundary punctuation (`,` `.` `;`)
 *  before `start` and at-or-after `end` and tests `NEGATION_RE` only within that bounded clause — NOT the
 *  whole line. This is a NARROW carve-out for a structured (OUTPUT_PATH=/directive-target) finding: it
 *  suppresses the teaching idiom "❌ Write(/sessions/...) — never do this; use the bash tool instead." (the
 *  directive and "never do this" share one clause, the em dash is not a clause boundary), but must NOT
 *  suppress the whole-line/adjacent-line negation guard's unrelated same-or-adjacent-line negations
 *  ("Write(/sessions/...) saves the report." on one line, "Do not modify any other file." on the next —
 *  different lines entirely, so this same-line clause scan never even sees the negation word). */
function directiveClauseHasNegation(line: string, start: number, end: number): boolean {
  let clauseStart = 0;
  let clauseEnd = line.length;
  const boundary = new RegExp(CLAUSE_BOUNDARY_RE.source, "g");
  let bm: RegExpExecArray | null;
  while ((bm = boundary.exec(line))) {
    const idx = bm.index;
    if (idx < start) clauseStart = idx + 1;
    if (idx >= end && idx < clauseEnd) clauseEnd = idx;
  }
  return NEGATION_RE.test(line.slice(clauseStart, clauseEnd));
}

/** POSITIVE context 2b: prose "write/save/read/edit … to|at `/sessions/...`" — a verb somewhere before a
 *  to/at preposition that sits immediately (within a few chars, allowing for a quote/backtick) before the
 *  path token. Scoped to the SAME line only (no cross-line prose inference).
 *
 *  Four guards narrow this to genuine IMPERATIVE file-tool instructions:
 *   - the INSTRUMENT phrase "bash tool" (`BASH_TOOL_PHRASE_RE`) anywhere on the WHOLE line suppresses
 *     entirely — "Using the bash tool, write the summary to `/sessions/...`" (fronted, comma-severed) and
 *     "Write the report to `/sessions/...` using the bash tool." (trailing, after the token) are both the
 *     tool's own correct remediation even though the instrument phrase sits outside the clause that links
 *     the verb to the path;
 *   - failing that, a BARE `bash` mention (no "tool") in the clause that links the verb to the path
 *     suppresses (see `bashInLastClause`) — narrower and clause-scoped on purpose: "After the bash step
 *     completes, use the Write tool to write ... to `/sessions/...`" has an earlier, punctuation-severed
 *     clause naming "bash step" (not "the bash tool"), a genuinely different, unrelated instrument, and
 *     must NOT suppress;
 *   - "read" immediately followed by "-only" is the adjective ("Uploads are read-only at ..."), not the
 *     verb "read";
 *   - a verb immediately preceded by a passive-voice auxiliary (is/are/was/were/be/been/being) is
 *     documentation ("Deliverables are saved at ...") — the passive doesn't direct the agent to act. */
function proseContextBeforeToken(line: string, tokenIndex: number): boolean {
  if (BASH_TOOL_PHRASE_RE.test(line)) return false;
  const before = line.slice(0, tokenIndex);
  if (bashInLastClause(before)) return false;
  PROSE_PREP_RE.lastIndex = 0;
  let prepEnd = -1;
  let m: RegExpExecArray | null;
  while ((m = PROSE_PREP_RE.exec(before))) {
    const gap = before.length - (m.index + m[0].length);
    if (gap <= 6) prepEnd = m.index; // "to `/sessions" / "at `/sessions" — small gap for quote+space
  }
  if (prepEnd === -1) return false;
  const clause = before.slice(0, prepEnd);
  PROSE_VERB_RE.lastIndex = 0;
  let vm: RegExpExecArray | null;
  while ((vm = PROSE_VERB_RE.exec(clause))) {
    const word = vm[0];
    const start = vm.index;
    if (/^read$/i.test(word) && /^-only\b/i.test(clause.slice(start + word.length))) continue;
    if (PASSIVE_AUX_RE.test(clause.slice(0, start))) continue;
    return true;
  }
  return false;
}

/** Rule 1 (`sessions-path-to-file-tool`) POSITIVE-context classification for one line, given it is
 *  already known NOT to be inside a bash-language fenced block (that exemption is applied by the caller
 *  before this runs). Returns token -> human context label, first-context-wins per token (so a token
 *  matched by more than one positive context still produces exactly one finding). A directive body that
 *  also contains `find` is deliberately EXCLUDED here — that shape is rule 2's narrower territory, not a
 *  generic directive-target hit.
 *
 *  `suppressProse` gates ONLY the prose context (an adjacent-clause anti-instruction word — see
 *  `hasNegationNearby`). The OUTPUT_PATH/OUTPUT_DIR assignment and file-tool directive-target contexts
 *  are machine-unambiguous — a stray "not"/"avoid" on the same or an adjacent line must never suppress
 *  them (an author writing `Write(/sessions/...)` next to "Do not modify any other file." is still handing
 *  a `/sessions` path to a file tool). Instead, each structured context gets its OWN narrow,
 *  directive-scoped carve-out (`directiveClauseHasNegation`): a negation token in the SAME CLAUSE as
 *  the assignment/directive itself (not merely the same or an adjacent line) suppresses that one hit —
 *  the genuine teaching idiom "❌ Write(/sessions/...) — never do this; use the bash tool instead." — while
 *  leaving the whole-line/adjacent-line negation guard's unrelated same-or-adjacent-line negations firing
 *  exactly as before. */
function classifyLineRule1(line: string, suppressProse: boolean): Map<string, string> {
  const result = new Map<string, string>();

  for (const m of line.matchAll(OUTPUT_ASSIGN_RE)) {
    const key = m[1];
    const trimmed = trimTrailingPunct(m[2]);
    if (!isVmSessionsPath(trimmed) || result.has(trimmed)) continue;
    if (directiveClauseHasNegation(line, m.index, m.index + m[0].length)) continue;
    result.set(trimmed, `a \`${key}\` assignment`);
  }

  for (const m of line.matchAll(DIRECTIVE_RE)) {
    const tool = m[1];
    const body = m[2];
    if (FIND_KEYWORD_RE.test(body)) continue; // rule 2's territory (find-substitution into a read)
    if (directiveClauseHasNegation(line, m.index, m.index + m[0].length)) continue; // same-clause teaching idiom carve-out
    for (const { token } of extractSessionsTokens(body)) {
      if (!result.has(token)) result.set(token, `a \`${tool}(...)\` directive target`);
    }
  }

  if (!suppressProse) {
    for (const { token, index } of extractSessionsTokens(line)) {
      if (result.has(token)) continue;
      if (proseContextBeforeToken(line, index)) result.set(token, "prose describing a write/save/read/edit to this path");
    }
  }

  return result;
}

/** Rule 2 (`sessions-find-into-file-read`), same-line shape: a `$(find … /sessions …)` (or any
 *  `find`-containing body) substituted directly inside a `Read(`/`Grep(` directive's parens. Narrow by
 *  design — only the two file-READ tools, and only when `find` and a `/sessions` token both appear inside
 *  the same directive's argument. */
function ruleTwoSameLine(line: string): string[] {
  const tokens: string[] = [];
  for (const m of line.matchAll(DIRECTIVE_RE)) {
    const tool = m[1];
    if (tool !== "Read" && tool !== "Grep") continue;
    const body = m[2];
    if (!FIND_KEYWORD_RE.test(body)) continue;
    for (const { token } of extractSessionsTokens(body)) tokens.push(token);
  }
  return tokens;
}

/** Rule 1 POSITIVE context 3, narrowed extraction: only a line whose ENTIRE trimmed content
 *  (after an optional short `key:`/`key=` label and an optional wrapping quote/backtick) IS the path
 *  token. A path embedded inside a larger sentence or command string — `Task(prompt="Using the bash
 *  tool run: cp report.md /sessions/.../outputs/")` — does not match: the brief's "bare /sessions path
 *  line/value", not "any /sessions token anywhere in a dispatch block". */
function extractBarePathLineToken(line: string): string | null {
  const m = BARE_PATH_LINE_RE.exec(line);
  if (!m) return null;
  const trimmed = trimTrailingPunct(m[1]);
  return isVmSessionsPath(trimmed) ? trimmed : null;
}

/** Every `$VAR` / `${VAR}` reference on `line` — used on the Read(/Grep( SIDE of rule 2's two-line shape
 *  (any var referenced in the directive's body is a candidate to match against the find line's OUTPUT
 *  var — see `findOutputVars`). */
function findLineVars(line: string): Set<string> {
  const vars = new Set<string>();
  const re = new RegExp(VAR_TOKEN_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) vars.add(m[1]);
  return vars;
}

/** The find LINE's OUTPUT-CAPTURE variable(s) only — `VAR=$(find … /sessions …)` command substitution,
 *  or `find … /sessions … > $VAR` / `> VAR` redirection. Deliberately NARROWER than "every `$VAR` on the
 *  line": a `find /sessions/... -name "$NAME"` argument uses `$NAME` as find's INPUT pattern, not its
 *  output, and must not be harvested as if `find` had assigned it — that was a real false positive
 *  (a `Read(docs/$NAME/index.md)` on the next line shared the token but read an unrelated host path). */
function findOutputVars(line: string): Set<string> {
  const vars = new Set<string>();
  const assign = FIND_ASSIGN_RE.exec(line);
  if (assign) vars.add(assign[1]);
  const redirect = FIND_REDIRECT_RE.exec(line);
  if (redirect) vars.add(redirect[1]);
  return vars;
}

interface LineInfo {
  lineNo: number;
  text: string;
  codeExempt: boolean; // inside a bash-ish fenced block or an indented code block — never scanned
}

/** Anti-instruction guard, extended to an ADJACENT line: "Never use a file tool for VM paths. /
 *  Instead, write the report to `/sessions/...`" must not fire — the anti-instruction sits one line away
 *  from the path, not on the same line. Checks the previous line, the current line, and the next line in
 *  `arr` (whatever line grouping the caller is iterating — the full document for the main passes, or a
 *  single fenced block's own lines for the dispatch-construct pass). */
function hasNegationNearby(arr: LineInfo[], idx: number): boolean {
  const prev = arr[idx - 1]?.text;
  const next = arr[idx + 1]?.text;
  return (
    NEGATION_RE.test(arr[idx].text) || (prev !== undefined && NEGATION_RE.test(prev)) || (next !== undefined && NEGATION_RE.test(next))
  );
}

/** A line indented 4+ spaces or a tab, with content, OUTSIDE any fence — Markdown's own "indented code
 *  block" convention. TENTATIVELY treated as a code context (exempt, like a bash fence) rather than
 *  scanned prose: an unfenced VM-bash template written this way is legitimate in-VM bash, not a
 *  violation. Over-exempting an indented sub-bullet that ISN'T code just trades a false negative for the
 *  false positive this guards against — the accepted posture throughout this file.
 *
 *  The exemption is NOT unconditional, though: a contiguous run of indented lines that contains a
 *  dispatch marker (`Task(`/`subagent_type`) is the analyzer's HEADLINE defect class, not VM bash — an
 *  indented `Task(...)` + `OUTPUT_PATH=/sessions/...` template must still be analyzed, EVEN when a blank
 *  line sits between the marker and the path: CommonMark treats a blank-line-separated indented
 *  block as ONE indented code block, and templates routinely contain blank lines for readability, so a
 *  blank line CONTINUES the run rather than splitting it. `splitLines` below groups contiguous indented
 *  runs (a blank line does not flush the run; only a non-blank, non-indented line does) and un-exempts
 *  (and registers as a dispatch block) any run whose body contains a dispatch marker OUTSIDE a `#`
 *  comment (see `flushIndentedRun`); a plain indented VM-bash template (no dispatch marker) stays
 *  exempt. */
const INDENTED_CODE_RE = /^(?: {4,}|\t)\S/;

/** Comment-stripped marker test: strip a `#`-comment tail from an indented-block line before it is tested for a dispatch marker —
 *  `# after the Task( dispatch returns, collect via bash:` must not un-exempt the block it heads, since a
 *  `Task(` mention inside a comment is not itself a dispatch construct. Simple `#`-to-end-of-line strip
 *  (no shell-quote awareness, consistent with this file's conservative, non-shell-parsing posture
 *  elsewhere); only used for the marker TEST, never applied to the line text stored/scanned elsewhere. */
function stripLineComment(text: string): string {
  const idx = text.indexOf("#");
  return idx === -1 ? text : text.slice(0, idx);
}

/** First pass: classify every line by fence state, and group non-bash-ish fenced blocks AND
 *  dispatch-marker-carrying indented runs (with their body lines) so the dispatch-construct rule (3rd
 *  POSITIVE context) can look at a whole block at once regardless of whether it's fenced or indented. */
function splitLines(text: string): { lines: LineInfo[]; blocks: { lang: string; lines: LineInfo[] }[] } {
  const rawLines = text.split(/\r?\n/);
  const lines: LineInfo[] = [];
  const blocks: { lang: string; lines: LineInfo[] }[] = [];

  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;
  let fenceLang = "";
  let currentBlock: LineInfo[] = [];

  let indentedRun: LineInfo[] = [];
  const flushIndentedRun = () => {
    if (indentedRun.length === 0) return;
    const bodyText = indentedRun.map((l) => stripLineComment(l.text)).join("\n"); // comment-stripped for the marker test only
    if (DISPATCH_MARKER_RE.test(bodyText)) {
      for (const info of indentedRun) info.codeExempt = false; // not VM bash — a dispatch template
      blocks.push({ lang: "indented-dispatch", lines: indentedRun });
    }
    indentedRun = [];
  };

  for (let i = 0; i < rawLines.length; i++) {
    const lineNo = i + 1;
    const raw = rawLines[i];
    const fm = FENCE_RE.exec(raw);
    if (fm) {
      const marker = fm[1];
      const lang = fm[2].toLowerCase();
      if (!inFence) {
        flushIndentedRun();
        inFence = true;
        fenceChar = marker[0];
        fenceLen = marker.length;
        fenceLang = lang;
        currentBlock = [];
        lines.push({ lineNo, text: raw, codeExempt: false }); // the fence marker line itself carries no path
        continue;
      }
      if (marker[0] === fenceChar && marker.length >= fenceLen && !lang) {
        if (!isBashishLang(fenceLang)) blocks.push({ lang: fenceLang, lines: currentBlock });
        inFence = false;
        fenceChar = "";
        fenceLen = 0;
        fenceLang = "";
        currentBlock = [];
        lines.push({ lineNo, text: raw, codeExempt: false });
        continue;
      }
      // a fence-looking line inside an open block — falls through as ordinary content below.
    }

    const isIndented = !inFence && INDENTED_CODE_RE.test(raw);
    const codeExempt = (inFence && isBashishLang(fenceLang)) || isIndented;
    const info: LineInfo = { lineNo, text: raw, codeExempt };
    lines.push(info);
    if (inFence && !codeExempt) currentBlock.push(info);

    if (isIndented) {
      indentedRun.push(info);
    } else if (raw.trim() !== "") {
      flushIndentedRun(); // a BLANK line does not flush — it continues the run (see INDENTED_CODE_RE doc)
    }
  }
  // An unterminated non-bash-ish fence at EOF still has its buffered lines flushed (mirrors scenario.py's
  // own EOF flush for the analogous bash case).
  if (inFence && !isBashishLang(fenceLang)) blocks.push({ lang: fenceLang, lines: currentBlock });
  flushIndentedRun();

  return { lines, blocks };
}

/** Scan one SKILL.md's full text and return every finding, ordered by line number. `filePath` is used
 *  only to stamp `SkillFinding.path` (the caller resolves it once per target). */
export function analyzeSkillText(text: string, filePath: string): SkillFinding[] {
  const findings: SkillFinding[] = [];
  // Dedup key is (rule, line, token) — NOT (rule, line, message) — so the SAME token on the SAME line
  // yields at most one finding even when more than one positive context matches it (e.g. an
  // `OUTPUT_PATH=` line that also sits inside a dispatch-construct fence). First-context-wins for
  // the message; later contexts on the same token+line are silently absorbed, not appended.
  const seen = new Set<string>();
  const add = (rule: SkillAnalysisRuleId, lineNo: number, token: string, message: string) => {
    const key = `${rule} ${lineNo} ${token}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ rule, path: filePath, line: lineNo, message });
  };

  const { lines, blocks } = splitLines(text);

  // Rule 1, positive contexts 1+2 (OUTPUT_PATH/OUTPUT_DIR, file-tool directive target, prose idiom) —
  // every non-exempt line. The negation guard applies ONLY to the low-confidence prose context
  // (`suppressProse`, passed to `classifyLineRule1`) — the OUTPUT_PATH/directive-target contexts are
  // machine-unambiguous and fire regardless of a same-or-adjacent-line "not"/"avoid"/"never".
  for (let i = 0; i < lines.length; i++) {
    const { lineNo, text: lineText, codeExempt } = lines[i];
    if (codeExempt) continue;
    const suppressProse = hasNegationNearby(lines, i);
    for (const [token, contextLabel] of classifyLineRule1(lineText, suppressProse)) {
      add("sessions-path-to-file-tool", lineNo, token, `\`${token}\` in ${contextLabel} — ${TIER_NOTE}`);
    }
  }

  // Rule 1, positive context 3: a BARE /sessions path line/value inside a fenced (non-bash-ish) block OR
  // a dispatch-marker-carrying indented run whose body contains a Task( call or a subagent_type key — the
  // dispatch-construct shape. Narrowed to a whole-line match (see `extractBarePathLineToken`) so a
  // /sessions token embedded inside a larger sentence or bash-mediated command string within the Task
  // prompt does NOT fire. No negation guard here (structured context, same as contexts 1+2 above) — a
  // bare dispatch-construct path is machine-unambiguous regardless of a neighboring anti-instruction line.
  for (const block of blocks) {
    const bodyText = block.lines.map((l) => l.text).join("\n");
    if (!DISPATCH_MARKER_RE.test(bodyText)) continue;
    for (let i = 0; i < block.lines.length; i++) {
      const { lineNo, text: lineText } = block.lines[i];
      const token = extractBarePathLineToken(lineText);
      if (!token) continue;
      add(
        "sessions-path-to-file-tool",
        lineNo,
        token,
        `\`${token}\` as a bare path inside a dispatch construct (a fenced/indented block containing \`Task(\`/\`subagent_type\`) — ${TIER_NOTE}`,
      );
    }
  }

  // Rule 2, same-line shape: find(...) substituted straight into Read(/Grep(.
  for (let i = 0; i < lines.length; i++) {
    const { lineNo, text: lineText, codeExempt } = lines[i];
    if (codeExempt) continue;
    if (hasNegationNearby(lines, i)) continue;
    for (const token of ruleTwoSameLine(lineText)) {
      add(
        "sessions-find-into-file-read",
        lineNo,
        token,
        `a shell \`find\` under \`/sessions\` (\`${token}\`) is substituted directly into a Read(/Grep( directive — ${TIER_NOTE}`,
      );
    }
  }

  // Rule 2, two-line adjacent shape: a `find … /sessions …` line (not itself a Read(/Grep( call) whose
  // output visibly feeds the VERY NEXT non-blank line's Read(/Grep( directive. Kept narrow on purpose —
  // this is the one place this analyzer looks past a single line, and only one line ahead. Adjacency
  // alone is not enough: the find line must carry a visible OUTPUT-CAPTURE data-flow marker — a
  // `VAR=$(find …)` assignment or a `find … > $VAR`/`> VAR` redirection (see `findOutputVars`) — and the
  // Read(/Grep( line must reference that SAME variable. Harvesting every `$VAR` referenced anywhere on
  // the find line (e.g. an `-name "$NAME"` INPUT pattern) is deliberately NOT enough: pure
  // token-sharing with find's own arguments, or pure proximity to an unrelated Read( targeting a
  // different path, must NOT fire.
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i];
    if (cur.codeExempt) continue;
    if (!FIND_KEYWORD_RE.test(cur.text)) continue;
    if (READ_GREP_START_RE.test(cur.text)) continue; // handled by the same-line shape above
    const findTokens = extractSessionsTokens(cur.text);
    if (findTokens.length === 0) continue;
    const curVars = findOutputVars(cur.text);
    if (curVars.size === 0) continue; // no OUTPUT-capture var on the find line — nothing to trace forward
    if (hasNegationNearby(lines, i)) continue;
    let j = i + 1;
    while (j < lines.length && lines[j].text.trim() === "") j++;
    if (j >= lines.length) continue;
    const next = lines[j];
    if (next.codeExempt) continue;
    const dm = /^\s*(Read|Grep)\(([^)]*)\)/.exec(next.text);
    if (!dm) continue;
    const nextVars = findLineVars(dm[2]);
    const sharesVar = [...curVars].some((v) => nextVars.has(v));
    if (!sharesVar) continue; // the Read(/Grep( body never references the find's captured variable
    if (hasNegationNearby(lines, j)) continue;
    for (const { token } of findTokens) {
      add(
        "sessions-find-into-file-read",
        next.lineNo,
        token,
        `a preceding shell \`find\` under \`/sessions\` (\`${token}\`, line ${cur.lineNo}) appears to feed this Read(/Grep( directive — ${TIER_NOTE}`,
      );
    }
  }

  return findings.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

/** Resolve the CLI target to the SKILL.md text to analyze: a file is used as-is, a directory is expected
 *  to contain a `SKILL.md`. */
function resolveSkillTarget(target: string): { file: string } | { error: string } {
  if (!existsSync(target)) return { error: `path not found: ${target}` };
  if (statSync(target).isDirectory()) {
    const md = join(target, "SKILL.md");
    if (!existsSync(md)) return { error: `no SKILL.md found under ${target}` };
    return { file: md };
  }
  return { file: target };
}

/**
 * `cowork-harness analyze-skill <SKILL.md | skill-dir/>` — a FOCUSED CI gate (unlike the advisory
 * `lint-skill`): exit 1 on ANY finding, exit 0 clean, exit 2 on a usage error. A clean run is a
 * PRE-FLIGHT signal only — it does not prove the skill is safe on host-loop, it proves this static
 * heuristic found nothing to flag. The authoritative, on-tier signal remains the runtime
 * `no_vm_path_file_op` / `pathDenials` assertions (see `docs/subagents.md`).
 */
export function cmdAnalyzeSkill(args: string[]): void {
  const asJson = isJsonOutput(args);
  let p;
  try {
    p = parseArgs(args, { values: ["--output-format"], enums: { "--output-format": ["text", "json"] } });
  } catch (e) {
    return fail("analyze-skill", "usage", String((e as Error).message), undefined, asJson);
  }
  const json = p.options["--output-format"] === "json";
  if (p.positionals.length === 0) {
    return fail("analyze-skill", "usage", "usage: analyze-skill <SKILL.md | skill-dir/> [--output-format text|json]", undefined, asJson);
  }
  if (p.positionals.length > 1) {
    return fail(
      "analyze-skill",
      "usage",
      `analyze-skill takes one <SKILL.md | skill-dir/> (got ${p.positionals.length}: ${p.positionals.join(", ")})`,
      undefined,
      asJson,
    );
  }
  const target = p.positionals[0];
  const resolved = resolveSkillTarget(target);
  if ("error" in resolved) {
    return fail("analyze-skill", "usage", `analyze-skill: ${resolved.error}`, undefined, asJson);
  }
  let text: string;
  try {
    text = readFileSync(resolved.file, "utf8");
  } catch (e) {
    return fail("analyze-skill", "usage", `analyze-skill: cannot read ${resolved.file}: ${(e as Error).message}`, undefined, asJson);
  }
  const findings = analyzeSkillText(text, resolved.file);
  const ok = findings.length === 0;

  if (json) {
    out(jsonPayloadEnvelope("analyze-skill", ok, { file: resolved.file, findings }));
  } else {
    if (ok) {
      log(`✓ analyze-skill: ${resolved.file} — no /sessions-to-file-tool findings`);
    } else {
      for (const f of findings) log(`✗ ${f.path}:${f.line}: [${f.rule}] ${f.message}`);
      log(`✗ analyze-skill: ${findings.length} finding(s) in ${resolved.file} (exit 1)`);
    }
    log(
      "  a clean result is a PRE-FLIGHT signal, not proof of on-tier resolution — the runtime " +
        "no_vm_path_file_op / vm_path_denied asserts remain authoritative (see docs/subagents.md).",
    );
  }
  return process.exit(ok ? 0 : 1);
}
