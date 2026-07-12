import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
 *
 * ADVISORY POSTURE: because the extraction is still heuristic and can over-flag innocent
 * documentation/teaching text, findings are WARNINGS, not a hard gate — `cmdAnalyzeSkill` exits 0 by
 * default even when findings are printed; `--strict` opts into a hard gate (exit 1 on any finding,
 * mirroring `lint-skill --strict`). A SKILL.md can also silence the ENTIRE warning class for itself via
 * the `analyze-skill: ignore` marker (see `hasIgnoreMarker` below) — for a VM-tier-only skill that
 * legitimately uses `/sessions` paths, or one that merely documents them in prose/teaching examples.
 */

export type SkillAnalysisRuleId = "sessions-path-to-file-tool" | "sessions-find-into-file-read" | "unclosed-ignore-fence";

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

/** The file-level silence marker: a LINE whose only meaningful content — allowing just leading/trailing
 *  whitespace and one optional wrapper — is `analyze-skill: ignore`. Accepted wrappers: an HTML comment
 *  (`<!-- analyze-skill: ignore -->`), a markdown reference-link comment (`[//]: # (analyze-skill:
 *  ignore)`), a `#`-prefixed line (`# analyze-skill: ignore`), a list bullet (`- analyze-skill: ignore`
 *  / `* analyze-skill: ignore`), or bare. Anchored per line (`^\s*...\s*$`), NOT a whole-file substring
 *  search — a SKILL.md that merely *documents* the marker in prose (e.g. `` add `analyze-skill:
 *  ignore` to suppress warnings ``) must NOT accidentally self-silence: text before or after the marker
 *  on the same line (prose, or the marker embedded mid-sentence inside backticks) disqualifies that
 *  line. This is the ONE switch documented to turn off every `analyze-skill` path-fidelity finding for
 *  a SKILL.md — a VM-tier-only skill that legitimately uses `/sessions` paths puts a genuine
 *  marker LINE in and the whole warning class goes quiet for that file, INCLUDING a real true positive
 *  (an explicit author override, not a narrower FP guard). */
/** Builds a line-anchored marker regex for `analyze-skill: <word>`, with the SAME five accepted
 *  wrappers as the original hand-written `analyze-skill: ignore` pattern (HTML comment, markdown
 *  reference-link comment, `#`-prefixed, list bullet, bare) — factored out so the three SCOPED marker
 *  spellings (`ignore-next-line`, `ignore-start`, `ignore-end`) get byte-identical line-anchoring to the
 *  file-wide marker, not a re-derived approximation. `word` is always one of a fixed set of literal
 *  marker names (no regex-special characters), so no escaping is needed. Anchoring to `\s*$` right after
 *  `word` is what prevents cross-marker collisions without any extra logic: `ignore-start` never matches
 *  the `ignore` pattern (or vice versa) because the shorter word's alternative requires whitespace-to-EOL
 *  immediately after it, and `-start`/`-next-line` is not whitespace. */
function buildMarkerLineRe(word: string): RegExp {
  return new RegExp(
    `^\\s*(?:<!--\\s*analyze-skill:\\s*${word}\\s*-->|\\[[^\\]]*\\]:\\s*#\\s*\\(\\s*analyze-skill:\\s*${word}\\s*\\)|#+\\s*analyze-skill:\\s*${word}|[-*]\\s*analyze-skill:\\s*${word}|analyze-skill:\\s*${word})\\s*$`,
    "i",
  );
}

const IGNORE_MARKER_LINE_RE = buildMarkerLineRe("ignore");
/** `analyze-skill: ignore-next-line` — suppresses findings on the SINGLE line immediately following
 *  the marker line (not the marker line itself). See `computeScopedIgnores`. */
const IGNORE_NEXT_LINE_MARKER_RE = buildMarkerLineRe("ignore-next-line");
/** `analyze-skill: ignore-start` — opens a suppression fence; findings on this line through the
 *  matching `ignore-end` line (inclusive) are suppressed. See `computeScopedIgnores`. */
const IGNORE_START_MARKER_RE = buildMarkerLineRe("ignore-start");
/** `analyze-skill: ignore-end` — closes the nearest open `ignore-start` fence. See
 *  `computeScopedIgnores`. */
const IGNORE_END_MARKER_RE = buildMarkerLineRe("ignore-end");

/** Does `text` carry the `analyze-skill: ignore` marker as its OWN line (see `IGNORE_MARKER_LINE_RE`)?
 *  Exported so the CLI can print an explanatory note distinguishing "suppressed by marker" from
 *  "genuinely clean" without re-deriving the regex. */
export function hasIgnoreMarker(text: string): boolean {
  return text.split(/\r?\n/).some((line) => IGNORE_MARKER_LINE_RE.test(line));
}

/** Result of one pass over `text` for the two SCOPED ignore markers (`ignore-next-line` and the
 *  `ignore-start`/`ignore-end` fence) — deliberately separate from the file-wide `analyze-skill: ignore`
 *  marker (`hasIgnoreMarker`), which is an all-or-nothing author override handled earlier by
 *  `analyzeSkillText`'s own early return. */
interface ScopedIgnores {
  /** Every 1-based line number whose findings are suppressed: `ignore-next-line`'s target line, plus
   *  every line within a closed (or, suppressed-to-EOF, unclosed) `ignore-start`/`ignore-end` fence. */
  suppressedLines: Set<number>;
  /** Line number of each `ignore-start` marker that reached EOF with no matching `ignore-end` — the
   *  must-fix case: each one becomes its own gating `unclosed-ignore-fence` finding (see
   *  `analyzeSkillText`), never a silent notice. */
  unclosedStartLines: number[];
}

/** One pass over `text`'s raw lines (NOT the fence/indent-aware `LineInfo[]` `splitLines` produces —
 *  ignore markers apply to the raw document text regardless of code-fence state, same as the file-wide
 *  marker) computing which lines the two scoped markers suppress. Fences do not nest: once an
 *  `ignore-start` is open, a second `ignore-start` line is ordinary (non-marker) content until the first
 *  `ignore-end` closes it — this keeps the state machine (and the "which fence does this ignore-end
 *  close" question) unambiguous. An `ignore-start` still open at EOF suppresses every line from itself
 *  through EOF (fail-open, deliberately: an author who forgets `ignore-end` should not have every
 *  subsequent finding in the file resurface) AND is recorded in `unclosedStartLines` so
 *  `analyzeSkillText` can emit the gating `unclosed-ignore-fence` finding at the
 *  fence's own start line — a line the fence's own suppression range does not need to cover for this to
 *  work, since that finding is added directly, never filtered against `suppressedLines`. */
function computeScopedIgnores(text: string): ScopedIgnores {
  const rawLines = text.split(/\r?\n/);
  const suppressedLines = new Set<number>();
  const unclosedStartLines: number[] = [];
  let openStart: number | null = null;

  for (let i = 0; i < rawLines.length; i++) {
    const lineNo = i + 1;
    const line = rawLines[i];
    if (openStart === null) {
      if (IGNORE_NEXT_LINE_MARKER_RE.test(line)) {
        if (lineNo + 1 <= rawLines.length) suppressedLines.add(lineNo + 1);
        continue;
      }
      if (IGNORE_START_MARKER_RE.test(line)) {
        openStart = lineNo;
        continue;
      }
    } else if (IGNORE_END_MARKER_RE.test(line)) {
      for (let l = openStart; l <= lineNo; l++) suppressedLines.add(l);
      openStart = null;
    }
  }

  if (openStart !== null) {
    unclosedStartLines.push(openStart);
    for (let l = openStart; l <= rawLines.length; l++) suppressedLines.add(l);
  }

  return { suppressedLines, unclosedStartLines };
}

/** Scan one SKILL.md's full text and return every finding, ordered by line number. `filePath` is used
 *  only to stamp `SkillFinding.path` (the caller resolves it once per target). Returns `[]` immediately,
 *  before any rule runs, when the file carries the FILE-WIDE `analyze-skill: ignore` marker (see
 *  `hasIgnoreMarker`) — that marker is an explicit whole-file author override and must suppress even a
 *  genuine true positive, INCLUDING this file's own `unclosed-ignore-fence` finding below (an unclosed
 *  scoped fence is moot once the whole file is silenced).
 *
 *  The two SCOPED markers (`ignore-next-line`, `ignore-start`/`ignore-end`) are narrower: rather than an
 *  early return, every rule below still runs over the FULL file, and the scoped-ignore line ranges
 *  (`computeScopedIgnores`) are used only to FILTER the resulting findings by line at the end — so a
 *  teaching example wrapped in `ignore-start`/`ignore-end` (or preceded by `ignore-next-line`) doesn't
 *  blind the rest of the file to a genuine finding elsewhere, the exact regression the file-wide marker
 *  caused and this task fixes. */
export function analyzeSkillText(text: string, filePath: string): SkillFinding[] {
  if (hasIgnoreMarker(text)) return [];
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

  // Scoped-ignore filter: drop every finding whose line falls inside an `ignore-next-line` target or an
  // `ignore-start`/`ignore-end` fence (open or closed — an unclosed fence still suppresses to EOF, see
  // `computeScopedIgnores`). Applied here, AFTER every rule above has already run over the full file, so
  // a scoped ignore narrows what's REPORTED without narrowing what's SCANNED.
  const { suppressedLines, unclosedStartLines } = computeScopedIgnores(text);
  const scoped = suppressedLines.size === 0 ? findings : findings.filter((f) => !suppressedLines.has(f.line));

  // Unclosed-fence must-fix: an `ignore-start` with no matching `ignore-end` is itself a real, gating
  // finding — added directly (not via `add`/`seen`, and never filtered against `suppressedLines`, so the
  // fence's own suppress-to-EOF range can never silently swallow it) so it prints under the normal
  // finding path and gates under `--strict` exactly like any other finding. This is the must-fix this
  // task exists to guarantee: a forgotten `ignore-end` fails VISIBLE, never a silent stderr-only notice.
  for (const lineNo of unclosedStartLines) {
    scoped.push({
      rule: "unclosed-ignore-fence",
      path: filePath,
      line: lineNo,
      message:
        "`analyze-skill: ignore-start` has no matching `analyze-skill: ignore-end` before EOF — findings from " +
        "this line through EOF are suppressed (fail-open), but this fence itself is a finding: add the missing " +
        "`ignore-end`, or remove the stray `ignore-start`.",
    });
  }

  return scoped.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

/** Result of resolving a directory (or file) target to the set of contract-bearing markdown files to
 *  analyze — see `resolveSkillTarget` below for the shape rules. `files` is deduped by resolved
 *  absolute path (a target dir can match more than one shape at once — see the top-level-SKILL.md +
 *  plugin-root overlap this repo's own `.claude/skills/cowork-harness/` demonstrates); `unscanned` names
 *  contract dirs (or entries) that exist on disk but were deliberately left OUT of this target's scope —
 *  a sibling skill in the enclosing plugin (when the target is one skill dir inside that plugin, not the
 *  plugin root itself), or a `skills/<name>` entry with no `SKILL.md` — the scope banner prints these so
 *  a narrower-than-expected scan is never silent. As of this fix, `references/` and `commands/` are no
 *  longer among the things a skill-dir target leaves unscanned in its enclosing plugin (see rule 3
 *  below) — every contract dir this tool scans anywhere else is now either SCANNED here or explicitly
 *  named in `unscanned`, never silently dropped. */
export interface SkillTargetResolution {
  files: string[];
  unscanned: string[];
}

/** `.claude-plugin/plugin.json` OR bare `plugin.json` at `dir` — the plugin-root manifest test, shared by
 *  the plugin-root shape and the enclosing-plugin walk-up. Mirrors `scenario.py`'s own
 *  `_find_enclosing_plugin_dir` acceptance of either manifest location. */
function isPluginManifestDir(dir: string): boolean {
  return existsSync(join(dir, ".claude-plugin", "plugin.json")) || existsSync(join(dir, "plugin.json"));
}

/** Walk UP from `startDir` to the nearest ancestor (inclusive of `startDir` itself) carrying a plugin
 *  manifest — the enclosing plugin for a skill dir that is not itself a plugin root. Net-new; there is no
 *  prior TS implementation. Semantic reference: `scenario.py:_find_enclosing_plugin_dir` (accepts either
 *  manifest location, walks `[start, *start.parents]`). Returns `null` once the filesystem root is
 *  reached with no manifest found (`dirname(dir) === dir`). */
function findEnclosingPluginDir(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    if (isPluginManifestDir(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Directory names the recursive markdown walker (`walkMarkdownDeep`) never descends into: `node_modules`
 *  and `.git` (vendored/VCS trees that can be enormous and are never a skill's own contract surface), plus
 *  ANY dot-prefixed directory (`.git` itself, `.github`, a stray `.cache`, etc. — dot-dirs are tooling/VCS
 *  convention, not skill contract dirs). Checked by NAME only and applied identically to a real directory
 *  and a symlinked directory (see `walkMarkdownDeep`) — a symlinked `node_modules` is exactly as
 *  uninteresting as a real one. */
const DENYLISTED_WALK_DIR_NAMES = new Set(["node_modules", ".git"]);
function isDenylistedWalkDirName(name: string): boolean {
  return DENYLISTED_WALK_DIR_NAMES.has(name) || name.startsWith(".");
}

/** Recursive `*.md` walk under `dir` (used for EVERY `agents/**`, `commands/**`, and `references/**` shape
 *  — Claude Code discovers namespaced commands/agents in subdirectories, e.g. `commands/tasks/build.md` /
 *  `agents/sub/x.md`, so a single-level listing silently narrowed the scan; this walker is now the ONLY
 *  markdown-collection primitive `resolveSkillTarget` uses) via a hand-rolled `readdirSync` walker — glob
 *  dependencies are unavailable on Node 20 in this repo's runtime target. Matches `.md`/`.MD`/any case
 *  (case-insensitive — Markdown tooling doesn't care about extension case, and neither should this
 *  scanner). `[]` when `dir` doesn't exist.
 *
 *  FOLLOWS directory symlinks — via `statSync` on the entry's full path, which resolves THROUGH the link,
 *  unlike a `Dirent`'s own `isDirectory()`, which always reports `false` for a symlink dirent (Node
 *  reports the link's OWN type there, not its target's). A symlinked `references/` (or a symlinked file
 *  inside one) is a real, scannable contract surface, not a boundary to silently drop — the earlier
 *  never-follow posture was itself a silent-narrowing bug, not a safety feature.
 *
 *  Guarded against symlink LOOPS by `visited`: a `Set` of `realpathSync`'d directory paths threaded BY
 *  REFERENCE through every recursive call (never reset per call, including across the top-level caller's
 *  own recursive descent). Before a directory (real or symlinked) is read, its realpath is checked against
 *  `visited`; if already present, the descent is skipped and `[]` is returned for that branch. This is what
 *  turns a `references/loop -> ..` self-referencing symlink into a single harmless extra pass over
 *  already-covered ground instead of infinite recursion.
 *
 *  Skips `node_modules`, `.git`, and any dot-prefixed directory (`isDenylistedWalkDirName`) — vendored or
 *  VCS trees are never a skill's own contract surface and can be large enough to make an unfiltered walk
 *  expensive. A dangling symlink (its `statSync` throws) is silently skipped: there is nothing on the
 *  other end to scan, which is not the same failure class as a real contract dir being out of scope. */
function walkMarkdownDeep(dir: string, visited: Set<string> = new Set()): string[] {
  if (!existsSync(dir)) return [];
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    return [];
  }
  if (visited.has(real)) return [];
  visited.add(real);

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: string[] = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (isDenylistedWalkDirName(e.name)) continue;
      out.push(...walkMarkdownDeep(full, visited));
      continue;
    }
    if (e.isSymbolicLink()) {
      let st;
      try {
        st = statSync(full); // follows the link — resolves to the TARGET's type
      } catch {
        continue; // dangling symlink — nothing on the other end to scan
      }
      if (st.isDirectory()) {
        if (isDenylistedWalkDirName(e.name)) continue;
        out.push(...walkMarkdownDeep(full, visited));
      } else if (st.isFile() && /\.md$/i.test(e.name)) {
        out.push(full);
      }
      continue;
    }
    if (e.isFile() && /\.md$/i.test(e.name)) out.push(full);
  }
  return out;
}

/** Non-recursive subdirectory NAMES directly inside `dir` (used to enumerate `skills/*` entries). This is
 *  a single-level listing, never itself recursive, so it needs no loop-guard of its own: a symlinked
 *  `skills/<name>` pointing back into an ancestor is only a hazard for something that RECURSES through
 *  it, and the caller's own `walkMarkdownDeep` calls into that skill's `references/` carry their own
 *  loop-guard (a fresh `visited` set per top-level walk). `[]` when `dir` doesn't exist.
 *
 *  INCLUDES a symlinked directory — via `statSync`, which follows the link — rather than excluding it. A
 *  symlinked `skills/linked` pointing at a real skill dir elsewhere is a real, scannable skill, not a
 *  boundary to silently drop: excluding it (the earlier behavior, via `Dirent.isDirectory()`, which is
 *  `false` for every symlink) made `skills/linked` invisible to this listing and, with no other skill
 *  present, made the whole target resolve to zero files — an incorrect exit-2 usage error for a dir that
 *  plainly had a scannable skill, and in a mixed plugin (a symlinked skill alongside real ones) a silent
 *  false green: the symlinked skill's contents were never analyzed and nothing said so. A dangling
 *  symlink is silently skipped — nothing on the other end. */
function listSubdirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      out.push(e.name);
      continue;
    }
    if (e.isSymbolicLink()) {
      let st;
      try {
        st = statSync(join(dir, e.name));
      } catch {
        continue; // dangling symlink
      }
      if (st.isDirectory()) out.push(e.name);
    }
  }
  return out;
}

/** Resolve the CLI target to the FULL UNION of contract-bearing markdown files to analyze:
 *
 *  - a FILE target → that file only (unchanged single-file behavior);
 *  - a DIRECTORY target is expanded to every shape it matches, deduped by resolved absolute path (a dir
 *    can match more than one shape — see this repo's own `.claude/skills/cowork-harness/`, which is
 *    simultaneously a top-level-SKILL.md dir AND a plugin root):
 *      1. top-level "SKILL.md" present → add it + every markdown file RECURSIVELY under top-level
 *         "references/";
 *      2. ".claude-plugin/plugin.json" or bare "plugin.json" present (a plugin root) → add every
 *         markdown file RECURSIVELY under root "agents/", "references/", and "commands/" — Claude Code
 *         discovers namespaced commands/agents in subdirectories (`commands/tasks/build.md`,
 *         `agents/sub/x.md`), so these are `**` walks, not a single-level listing (see
 *         `walkMarkdownDeep`) — and each "skills/<name>/SKILL.md" (+ every markdown file recursively
 *         under that skill's own "references/"); "skills/<name>" may itself be a directory SYMLINK and is
 *         still picked up (see `listSubdirs`);
 *      3. the dir is a skill dir INSIDE a plugin (its own "SKILL.md" present, and walking UP finds an
 *         enclosing plugin manifest) → ALSO add every markdown file RECURSIVELY under the enclosing
 *         plugin's root "agents/", "references/", AND "commands/" — `references/` and `commands/` are
 *         contract dirs this tool scans in every other shape above, so a skill-dir target must not be
 *         narrower than a plugin-root target for the SAME underlying plugin.
 *
 *  Every recursive walk above (`walkMarkdownDeep`) FOLLOWS directory symlinks (loop-guarded against
 *  `references/loop -> ..`-style self-reference) and matches `.md`/`.MD` case-insensitively — nothing
 *  under a scanned root is silently dropped for being a symlink or an unusual extension case. The
 *  plugin's sibling `skills/*` entries (other than the target itself, for shape 3) remain genuinely OUT
 *  of scope for a skill-dir target — named in `unscanned`, never silently dropped.
 *
 *  ZERO scannable files is a USAGE ERROR, never a silent clean pass — the caller reports it via `fail()`.
 *  The message DISTINGUISHES two cases: no shape recognized at all (no top-level SKILL.md, no plugin
 *  manifest anywhere), vs. a recognized plugin shape that simply has no markdown contract files (e.g. a
 *  hooks/MCP-only plugin with `agents/`/`references/`/`commands/`/`skills/` all absent or empty) —
 *  conflating the two produced a confusing "looked for plugin.json" message even for a dir that plainly
 *  HAD one. */
export function resolveSkillTarget(target: string): SkillTargetResolution | { error: string } {
  if (!existsSync(target)) return { error: `path not found: ${target}` };
  if (!statSync(target).isDirectory()) return { files: [target], unscanned: [] };

  const dir = resolve(target);
  const files = new Set<string>();
  const unscanned: string[] = [];

  const topSkillMd = join(dir, "SKILL.md");
  const hasTopSkillMd = existsSync(topSkillMd);
  if (hasTopSkillMd) {
    files.add(topSkillMd);
    for (const f of walkMarkdownDeep(join(dir, "references"))) files.add(f);
  }

  const isPluginRoot = isPluginManifestDir(dir);
  if (isPluginRoot) {
    for (const f of walkMarkdownDeep(join(dir, "agents"))) files.add(f);
    for (const f of walkMarkdownDeep(join(dir, "references"))) files.add(f);
    for (const f of walkMarkdownDeep(join(dir, "commands"))) files.add(f);
    const skillsDir = join(dir, "skills");
    for (const name of listSubdirs(skillsDir)) {
      const subSkillMd = join(skillsDir, name, "SKILL.md");
      if (!existsSync(subSkillMd)) {
        unscanned.push(`${join(skillsDir, name)} (no SKILL.md — not a scannable skill dir)`);
        continue;
      }
      files.add(subSkillMd);
      for (const f of walkMarkdownDeep(join(skillsDir, name, "references"))) files.add(f);
    }
  } else if (hasTopSkillMd) {
    const enclosing = findEnclosingPluginDir(dir);
    if (enclosing) {
      for (const f of walkMarkdownDeep(join(enclosing, "agents"))) files.add(f);
      for (const f of walkMarkdownDeep(join(enclosing, "references"))) files.add(f);
      for (const f of walkMarkdownDeep(join(enclosing, "commands"))) files.add(f);
      const siblingSkillsDir = join(enclosing, "skills");
      for (const name of listSubdirs(siblingSkillsDir)) {
        const siblingDir = join(siblingSkillsDir, name);
        if (siblingDir === dir) continue; // this skill itself, already in scope
        unscanned.push(`${siblingDir} (sibling skill in the enclosing plugin — out of scope for a skill-dir target)`);
      }
    }
  }

  if (files.size === 0) {
    if (!hasTopSkillMd && !isPluginRoot) {
      return {
        error:
          `no contract-bearing markdown found under ${target} — looked for: a top-level SKILL.md ` +
          "(+ references/**/*.md); a plugin root (.claude-plugin/plugin.json or plugin.json, pulling in " +
          "agents/**/*.md, references/**/*.md, commands/**/*.md, and skills/*/SKILL.md + " +
          "skills/*/references/**/*.md); or a skill dir whose SKILL.md sits somewhere inside an enclosing " +
          "plugin (pulling in that plugin's agents/**/*.md, references/**/*.md, and commands/**/*.md)",
      };
    }
    // A shape WAS recognized (a plugin manifest exists at `dir` — `hasTopSkillMd` can't be true here,
    // since that branch always adds `topSkillMd` itself and `files` would be non-empty) — it simply has
    // no markdown contract files: no agents/, references/, commands/, or skills/*/SKILL.md content, e.g.
    // a hooks/MCP-only plugin. Distinct message so "no recognized shape" and "recognized shape, nothing
    // to scan" are never conflated.
    return {
      error:
        `${target} matches a plugin shape (.claude-plugin/plugin.json or plugin.json present) but has no ` +
        "markdown contract files to scan — no agents/**/*.md, references/**/*.md, commands/**/*.md, or " +
        "skills/*/SKILL.md found; likely a hooks/MCP-only plugin with nothing for analyze-skill to check",
    };
  }

  return { files: [...files].sort(), unscanned };
}

/**
 * `cowork-harness analyze-skill <SKILL.md | skill-dir/>` — an ADVISORY, token-free scan (unlike the
 * `lint-skill` two-footgun WARN check, which is also advisory by default): findings are printed but
 * exit 0 by DEFAULT, since the extraction is heuristic and can over-flag innocent documentation. Pass
 * `--strict` to turn it into a hard gate (exit 1 on any finding, mirroring `lint-skill --strict`
 * exactly). A SKILL.md can silence the whole warning class for itself with the `analyze-skill: ignore`
 * marker (see `hasIgnoreMarker`) — 0 findings, exit 0 even under `--strict`. exit 2 on a usage error. A
 * clean/suppressed run is a PRE-FLIGHT signal only — it does not prove the skill is safe on host-loop,
 * it proves this static heuristic found nothing to flag (or was told not to look). The authoritative,
 * on-tier signal remains the runtime `no_vm_path_file_op` / `pathDenials` assertions (see
 * `docs/subagents.md`).
 */
export function cmdAnalyzeSkill(args: string[]): void {
  const asJson = isJsonOutput(args);
  let p;
  try {
    p = parseArgs(args, {
      values: ["--output-format"],
      enums: { "--output-format": ["text", "json"] },
      booleans: ["--strict"],
    });
  } catch (e) {
    return fail("analyze-skill", "usage", String((e as Error).message), undefined, asJson);
  }
  const json = p.options["--output-format"] === "json";
  const strict = p.flags["--strict"] === true;
  if (p.positionals.length === 0) {
    return fail(
      "analyze-skill",
      "usage",
      "usage: analyze-skill <SKILL.md | skill-dir/> [--strict] [--output-format text|json]",
      undefined,
      asJson,
    );
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
  const { files: fileList, unscanned } = resolved;

  const perFile: { file: string; findings: SkillFinding[]; suppressed: boolean }[] = [];
  for (const file of fileList) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (e) {
      return fail("analyze-skill", "usage", `analyze-skill: cannot read ${file}: ${(e as Error).message}`, undefined, asJson);
    }
    const suppressed = hasIgnoreMarker(text);
    const findings = analyzeSkillText(text, file); // [] when `suppressed` — see analyzeSkillText
    perFile.push({ file, findings, suppressed });
  }

  const totalFindings = perFile.reduce((n, f) => n + f.findings.length, 0);
  const ok = totalFindings === 0;
  const failing = strict && totalFindings > 0; // suppressed files never contribute findings, so --strict can't fail on them

  if (json) {
    out(
      jsonPayloadEnvelope("analyze-skill", ok, {
        files: perFile,
        scanned: fileList,
        unscanned,
        strict,
      }),
    );
  } else {
    for (const pf of perFile) {
      log(`── ${pf.file} ──`);
      if (pf.suppressed) {
        log(`⊘ analyze-skill: ${pf.file} — path-fidelity warnings suppressed for this file by the ` + "`analyze-skill: ignore` marker");
      } else if (pf.findings.length === 0) {
        log(`✓ analyze-skill: ${pf.file} — no /sessions-to-file-tool findings`);
      } else {
        for (const f of pf.findings) log(`⚠ ${f.path}:${f.line}: [${f.rule}] ${f.message}`);
      }
    }
    if (totalFindings > 0) {
      log(
        `⚠ analyze-skill: ${totalFindings} finding(s) across ${fileList.length} file(s) — advisory (exit 0)` +
          (strict ? ", failing on --strict (exit 1)" : "; pass --strict to fail on findings"),
      );
    } else {
      log(`✓ analyze-skill: ${fileList.length} file(s) scanned — no findings`);
    }
    log(
      "  a clean result is a PRE-FLIGHT signal, not proof of on-tier resolution — the runtime " +
        "no_vm_path_file_op / vm_path_denied asserts remain authoritative (see docs/subagents.md).",
    );
    log(`  scope: scanned ${fileList.length} file(s) — ${fileList.join(", ")}`);
    log(unscanned.length > 0 ? `  scope: left unscanned — ${unscanned.join("; ")}` : "  scope: no contract dirs left unscanned");
  }
  return process.exit(failing ? 1 : 0);
}
