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

const BASH_FENCE_LANGS = new Set(["bash", "sh", "shell", "zsh"]);
/** Opening/closing fence: ``` or ~~~ (>=3), optional info string (language) — mirrors the bundled
 *  `scenario.py` lint-skill fence tracker so both tools treat markdown the same way. */
const FENCE_RE = /^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)\s*$/;
/** A generic "path-ish" token: starts with `/`, runs until whitespace or a delimiter that could not be
 *  part of a bare path in prose/markdown (quote, backtick, closing paren/bracket). This is intentionally
 *  BROADER than a real path — it is filtered down to genuine `/sessions` candidates by `isVmSessionsPath`
 *  immediately after extraction, exactly as the brief specifies ("test candidates with isVmSessionsPath"). */
const GENERIC_PATH_RE = /\/[^\s"'`)\]]+/g;
const OUTPUT_ASSIGN_RE = /\b(OUTPUT_PATH|OUTPUT_DIR)\s*[:=]\s*"?(\/[^\s"'`)\]]+)/g;
const DIRECTIVE_RE = /\b(Write|Read|Edit|Glob|Grep)\(([^)]*)\)/g;
const PROSE_VERB_RE = /\b(write|writes|writing|wrote|save|saves|saving|saved|read|reads|reading|edit|edits|editing|edited)\b/gi;
const PROSE_PREP_RE = /\b(to|at)\b/gi;
/** Anti-instruction guard: "NEVER write to `/sessions/...`" (and siblings) must NOT fire. Deliberately
 *  broad (whole-line, not proximity-scoped) — a stray "not" elsewhere on the line also suppresses, which
 *  trades a few accepted false negatives for never flagging a line that is teaching the rule, not
 *  breaking it. That trade is the point of this analyzer's conservative posture. */
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
 *  path token. Scoped to the SAME line only (no cross-line prose inference). */
function proseContextBeforeToken(line: string, tokenIndex: number): boolean {
  const before = line.slice(0, tokenIndex);
  PROSE_PREP_RE.lastIndex = 0;
  let prepEnd = -1;
  let m: RegExpExecArray | null;
  while ((m = PROSE_PREP_RE.exec(before))) {
    const gap = before.length - (m.index + m[0].length);
    if (gap <= 6) prepEnd = m.index; // "to `/sessions" / "at `/sessions" — small gap for quote+space
  }
  if (prepEnd === -1) return false;
  PROSE_VERB_RE.lastIndex = 0;
  return PROSE_VERB_RE.test(before.slice(0, prepEnd));
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

interface LineInfo {
  lineNo: number;
  text: string;
  bashExempt: boolean; // inside a ```bash/sh/shell/zsh fenced block — never scanned
}

/** First pass: classify every line by fence state, and group non-bash fenced blocks (with their body
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
        lines.push({ lineNo, text: raw, bashExempt: false }); // the fence marker line itself carries no path
        continue;
      }
      if (marker[0] === fenceChar && marker.length >= fenceLen && !lang) {
        if (!BASH_FENCE_LANGS.has(fenceLang)) blocks.push({ lang: fenceLang, lines: currentBlock });
        inFence = false;
        fenceChar = "";
        fenceLen = 0;
        fenceLang = "";
        currentBlock = [];
        lines.push({ lineNo, text: raw, bashExempt: false });
        continue;
      }
      // a fence-looking line inside an open block — falls through as ordinary content below.
    }

    const bashExempt = inFence && BASH_FENCE_LANGS.has(fenceLang);
    const info: LineInfo = { lineNo, text: raw, bashExempt };
    lines.push(info);
    if (inFence && !bashExempt) currentBlock.push(info);
  }
  // An unterminated non-bash fence at EOF still has its buffered lines flushed (mirrors scenario.py's
  // own EOF flush for the analogous bash case).
  if (inFence && !BASH_FENCE_LANGS.has(fenceLang)) blocks.push({ lang: fenceLang, lines: currentBlock });

  return { lines, blocks };
}

/** Scan one SKILL.md's full text and return every finding, ordered by line number. `filePath` is used
 *  only to stamp `SkillFinding.path` (the caller resolves it once per target). */
export function analyzeSkillText(text: string, filePath: string): SkillFinding[] {
  const findings: SkillFinding[] = [];
  const seen = new Set<string>();
  const add = (rule: SkillAnalysisRuleId, lineNo: number, message: string) => {
    const key = `${rule} ${lineNo} ${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ rule, path: filePath, line: lineNo, message });
  };

  const { lines, blocks } = splitLines(text);

  // Rule 1, positive contexts 1+2 (OUTPUT_PATH/OUTPUT_DIR, file-tool directive target, prose idiom) —
  // every non-bash-exempt line.
  for (const { lineNo, text: lineText, bashExempt } of lines) {
    if (bashExempt) continue;
    if (NEGATION_RE.test(lineText)) continue; // anti-instruction guard — suppress the whole line
    for (const [token, contextLabel] of classifyLineRule1(lineText)) {
      add("sessions-path-to-file-tool", lineNo, `\`${token}\` in ${contextLabel} — ${TIER_NOTE}`);
    }
  }

  // Rule 1, positive context 3: a bare /sessions token inside a fenced (non-bash) block whose body
  // contains a Task( call or a subagent_type key — the dispatch-construct shape.
  for (const block of blocks) {
    const bodyText = block.lines.map((l) => l.text).join("\n");
    if (!DISPATCH_MARKER_RE.test(bodyText)) continue;
    for (const { lineNo, text: lineText } of block.lines) {
      if (NEGATION_RE.test(lineText)) continue;
      for (const { token } of extractSessionsTokens(lineText)) {
        add(
          "sessions-path-to-file-tool",
          lineNo,
          `\`${token}\` as a bare path inside a dispatch construct (a fenced block containing \`Task(\`/\`subagent_type\`) — ${TIER_NOTE}`,
        );
      }
    }
  }

  // Rule 2, same-line shape: find(...) substituted straight into Read(/Grep(.
  for (const { lineNo, text: lineText, bashExempt } of lines) {
    if (bashExempt) continue;
    if (NEGATION_RE.test(lineText)) continue;
    for (const token of ruleTwoSameLine(lineText)) {
      add(
        "sessions-find-into-file-read",
        lineNo,
        `a shell \`find\` under \`/sessions\` (\`${token}\`) is substituted directly into a Read(/Grep( directive — ${TIER_NOTE}`,
      );
    }
  }

  // Rule 2, two-line adjacent shape: a `find … /sessions …` line (not itself a Read(/Grep( call) whose
  // output visibly feeds the VERY NEXT non-blank line's Read(/Grep( directive. Kept narrow on purpose —
  // this is the one place this analyzer looks past a single line, and only one line ahead.
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i];
    if (cur.bashExempt) continue;
    if (!FIND_KEYWORD_RE.test(cur.text)) continue;
    if (READ_GREP_START_RE.test(cur.text)) continue; // handled by the same-line shape above
    const findTokens = extractSessionsTokens(cur.text);
    if (findTokens.length === 0) continue;
    if (NEGATION_RE.test(cur.text)) continue;
    let j = i + 1;
    while (j < lines.length && lines[j].text.trim() === "") j++;
    if (j >= lines.length) continue;
    const next = lines[j];
    if (next.bashExempt) continue;
    if (!/^\s*(Read|Grep)\(/.test(next.text)) continue;
    if (NEGATION_RE.test(next.text)) continue;
    for (const { token } of findTokens) {
      add(
        "sessions-find-into-file-read",
        next.lineNo,
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
