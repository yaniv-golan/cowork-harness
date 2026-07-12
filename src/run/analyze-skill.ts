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
 *  `$ cmd` transcript block is exactly as bash-ish as a raw `bash` fence. Anything with a `sh`/`bash`/
 *  `shell`/`zsh` PREFIX is also treated as bash-ish (e.g. `bash-session`, `shellscript`), per the
 *  conservative "when unsure, do not flag" posture — see `isBashishLang`. */
const BASH_FENCE_LANGS = new Set(["bash", "sh", "shell", "zsh", "console", "shell-session", "sh-session"]);
function isBashishLang(lang: string): boolean {
  if (BASH_FENCE_LANGS.has(lang)) return true;
  return /^(bash|sh|shell|zsh)/.test(lang);
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
/** A mention of the `bash` tool anywhere on the line — "Use the bash tool to write ... to /sessions/..."
 *  is the tool's own correct remediation, not a file-tool violation. Scoped to the prose context
 *  only (an explicit `Write(/sessions/...)` directive is unambiguous regardless of a stray "bash" nearby). */
const BASH_TOOL_MENTION_RE = /\bbash\b/i;
/** A line whose only content (after an optional short `key:`/`key=` label and optional surrounding
 *  quote/backtick) is a single path token: "OUTPUT_PATH=/sessions/..." or a bare
 *  "/sessions/{{id}}/mnt/outputs/x.json" line. Deliberately does NOT match a path embedded inside a
 *  larger sentence or command string (`Task(prompt="... /sessions/... ...")`) — that shape must NOT be
 *  treated as a bare dispatch-construct path. */
const BARE_PATH_LINE_RE = /^\s*(?:[A-Za-z_][\w-]*\s*[:=]\s*)?["'`]?(\/[^\s"'`]+)["'`]?\s*$/;
/** A `$VAR` / `${VAR}` reference — used to require VISIBLE DATA FLOW between a `find` line and the
 *  Read(/Grep( line it appears to feed: pure line adjacency is not enough, the two lines must
 *  share a variable. */
const VAR_TOKEN_RE = /\$\{?(\w+)\}?/g;
/** Anti-instruction guard: "NEVER write to `/sessions/...`" (and siblings) must NOT fire. Deliberately
 *  broad (whole-line, not proximity-scoped) — a stray "not" elsewhere on the line also suppresses, which
 *  trades a few accepted false negatives for never flagging a line that is teaching the rule, not
 *  breaking it. That trade is the point of this analyzer's conservative posture. The guard also looks at
 *  the IMMEDIATELY ADJACENT line (previous and next), not just the current one — "Never use a file tool
 *  for VM paths. / Instead, write the report to `/sessions/...`" must not fire either, since the
 *  anti-instruction sits one clause/line away (see `hasNegationNearby`). */
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

/** POSITIVE context 2b: prose "write/save/read/edit … to|at `/sessions/...`" — a verb somewhere before a
 *  to/at preposition that sits immediately (within a few chars, allowing for a quote/backtick) before the
 *  path token. Scoped to the SAME line only (no cross-line prose inference).
 *
 *  Three guards narrow this to genuine IMPERATIVE file-tool instructions:
 *   - a `bash` mention anywhere on the line suppresses entirely — "Use the bash tool to write ... to
 *     `/sessions/...`" is the tool's own correct remediation, not a file-tool violation;
 *   - "read" immediately followed by "-only" is the adjective ("Uploads are read-only at ..."), not the
 *     verb "read";
 *   - a verb immediately preceded by a passive-voice auxiliary (is/are/was/were/be/been/being) is
 *     documentation ("Deliverables are saved at ...") — the passive doesn't direct the agent to act. */
function proseContextBeforeToken(line: string, tokenIndex: number): boolean {
  if (BASH_TOOL_MENTION_RE.test(line)) return false;
  const before = line.slice(0, tokenIndex);
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
 *  generic directive-target hit. */
function classifyLineRule1(line: string): Map<string, string> {
  const result = new Map<string, string>();

  for (const m of line.matchAll(OUTPUT_ASSIGN_RE)) {
    const key = m[1];
    const trimmed = trimTrailingPunct(m[2]);
    if (isVmSessionsPath(trimmed) && !result.has(trimmed)) result.set(trimmed, `a \`${key}\` assignment`);
  }

  for (const m of line.matchAll(DIRECTIVE_RE)) {
    const tool = m[1];
    const body = m[2];
    if (FIND_KEYWORD_RE.test(body)) continue; // rule 2's territory (find-substitution into a read)
    for (const { token } of extractSessionsTokens(body)) {
      if (!result.has(token)) result.set(token, `a \`${tool}(...)\` directive target`);
    }
  }

  for (const { token, index } of extractSessionsTokens(line)) {
    if (result.has(token)) continue;
    if (proseContextBeforeToken(line, index)) result.set(token, "prose describing a write/save/read/edit to this path");
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

/** Every `$VAR` / `${VAR}` reference on `line` — used to require VISIBLE DATA FLOW between a `find` line
 *  and the Read(/Grep( line it appears to feed: the two lines must share a variable, not just sit
 *  next to each other. */
function findLineVars(line: string): Set<string> {
  const vars = new Set<string>();
  const re = new RegExp(VAR_TOKEN_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) vars.add(m[1]);
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
 *  block" convention. Treated as a code context (exempt, like a bash fence) rather than scanned prose:
 *  an unfenced VM-bash template written this way is legitimate in-VM bash, not a violation. Over-exempting
 *  an indented sub-bullet that ISN'T code just trades a false negative for the false positive this
 *  guards against — the accepted posture throughout this file. */
const INDENTED_CODE_RE = /^(?: {4,}|\t)\S/;

/** First pass: classify every line by fence state, and group non-bash-ish fenced blocks (with their body
 *  lines) so the dispatch-construct rule (3rd POSITIVE context) can look at a whole block at once. */
function splitLines(text: string): { lines: LineInfo[]; blocks: { lang: string; lines: LineInfo[] }[] } {
  const rawLines = text.split(/\r?\n/);
  const lines: LineInfo[] = [];
  const blocks: { lang: string; lines: LineInfo[] }[] = [];

  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;
  let fenceLang = "";
  let currentBlock: LineInfo[] = [];

  for (let i = 0; i < rawLines.length; i++) {
    const lineNo = i + 1;
    const raw = rawLines[i];
    const fm = FENCE_RE.exec(raw);
    if (fm) {
      const marker = fm[1];
      const lang = fm[2].toLowerCase();
      if (!inFence) {
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

    const codeExempt = (inFence && isBashishLang(fenceLang)) || (!inFence && INDENTED_CODE_RE.test(raw));
    const info: LineInfo = { lineNo, text: raw, codeExempt };
    lines.push(info);
    if (inFence && !codeExempt) currentBlock.push(info);
  }
  // An unterminated non-bash-ish fence at EOF still has its buffered lines flushed (mirrors scenario.py's
  // own EOF flush for the analogous bash case).
  if (inFence && !isBashishLang(fenceLang)) blocks.push({ lang: fenceLang, lines: currentBlock });

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
  // every non-exempt line.
  for (let i = 0; i < lines.length; i++) {
    const { lineNo, text: lineText, codeExempt } = lines[i];
    if (codeExempt) continue;
    if (hasNegationNearby(lines, i)) continue; // anti-instruction guard — suppress line + adjacent line
    for (const [token, contextLabel] of classifyLineRule1(lineText)) {
      add("sessions-path-to-file-tool", lineNo, token, `\`${token}\` in ${contextLabel} — ${TIER_NOTE}`);
    }
  }

  // Rule 1, positive context 3: a BARE /sessions path line/value inside a fenced (non-bash-ish) block
  // whose body contains a Task( call or a subagent_type key — the dispatch-construct shape. Narrowed to
  // a whole-line match (see `extractBarePathLineToken`) so a /sessions token embedded inside a larger
  // sentence or bash-mediated command string within the Task prompt does NOT fire.
  for (const block of blocks) {
    const bodyText = block.lines.map((l) => l.text).join("\n");
    if (!DISPATCH_MARKER_RE.test(bodyText)) continue;
    for (let i = 0; i < block.lines.length; i++) {
      const { lineNo, text: lineText } = block.lines[i];
      if (hasNegationNearby(block.lines, i)) continue;
      const token = extractBarePathLineToken(lineText);
      if (!token) continue;
      add(
        "sessions-path-to-file-tool",
        lineNo,
        token,
        `\`${token}\` as a bare path inside a dispatch construct (a fenced block containing \`Task(\`/\`subagent_type\`) — ${TIER_NOTE}`,
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
  // alone is not enough: the find line must carry a visible data-flow marker (a `$VAR`/`${VAR}`
  // reference) and the Read(/Grep( line must reference that SAME variable — pure proximity to an
  // unrelated Read( targeting a different path must NOT fire.
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i];
    if (cur.codeExempt) continue;
    if (!FIND_KEYWORD_RE.test(cur.text)) continue;
    if (READ_GREP_START_RE.test(cur.text)) continue; // handled by the same-line shape above
    const findTokens = extractSessionsTokens(cur.text);
    if (findTokens.length === 0) continue;
    const curVars = findLineVars(cur.text);
    if (curVars.size === 0) continue; // no data-flow marker on the find line — nothing to trace forward
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
