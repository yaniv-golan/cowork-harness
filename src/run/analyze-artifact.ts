import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import * as acorn from "acorn";
import * as walk from "acorn-walk";
import type { AnalysisFailure, SkillFinding } from "./analyze-skill.js";

/**
 * `analyze-artifact` — the Tier A static detector for the Cowork interactive-artifact write-back bug
 * class (see `docs/internal/2026-07-15-harness-improvements-from-skillcreator-plan.md`, Item 1 §B2/§B3).
 *
 * THE BUG: a skill emits an interactive `.html` artifact (directly, or generated from a `.py`/`.js`
 * template). Under Cowork the artifact is served from Cowork's OWN origin, so a relative write-back —
 * `fetch("/api/…", {method:"POST"})`, an XHR POST, `sendBeacon("/…")`, or a native
 * `<form method=post action="/…">` — resolves but returns non-ok. A page that doesn't consult the
 * response (or falls back to a blob download, which is also broken under Cowork's embedded viewer)
 * shows a false "Saved!" while the data silently never leaves the browser.
 *
 * SCOPE SPLIT (own this file's half only): this module OWNS source collection
 * (`collectArtifactSources`), per-file candidacy + AST analysis (`analyzeArtifactFile`), and
 * orchestration (`analyzeArtifacts`). It does NOT own exit-code precedence, `--strict` gating, the
 * `analyze-skill: ignore` marker, or rendering — those live in `analyze-skill.ts`'s `cmdAnalyzeSkill`,
 * which is expected to call into this module (see that file's imports of `SkillFinding`/`AnalysisFailure`
 * — reused here verbatim, never redefined).
 *
 * NO FALSE GREEN: every source this module SELECTS either yields a verdict (a finding, or an explicit
 * "no relative write-back / provably dead" clean) or an `AnalysisFailure` — never a silent skip. Only a
 * source that fails CANDIDACY (no browser+write-back markers at all) returns `{}` with neither — that is
 * "ordinary code", not a would-be candidate that broke.
 */

// ------------------------------------------------------------------------------------------------- //
// Source selection
// ------------------------------------------------------------------------------------------------- //

const HTML_EXTS = new Set([".html", ".htm"]);
const CODE_EXTS = new Set([".js", ".mjs", ".ts", ".jsx", ".tsx", ".py"]);
const SOURCE_EXTS = new Set<string>([...HTML_EXTS, ...CODE_EXTS]);

/** Directory names never descended into during source collection: `node_modules`/`.git`/`dist` (vendored
 *  or build-output trees, never a skill's own authored surface) plus any dot-prefixed directory. Mirrors
 *  `analyze-skill.ts`'s `DENYLISTED_WALK_DIR_NAMES`, extended with `dist` per §B2 ("Skip `node_modules`,
 *  `.git`, `dist`, `*.min.js`"). */
const DENYLISTED_DIR_NAMES = new Set(["node_modules", ".git", "dist"]);
function isDenylistedDirName(name: string): boolean {
  return DENYLISTED_DIR_NAMES.has(name) || name.startsWith(".");
}
function isMinifiedJs(name: string): boolean {
  return /\.min\.js$/i.test(name);
}

/** `.claude-plugin/plugin.json` OR bare `plugin.json` at `dir` — the plugin-root manifest test. A local
 *  copy of `analyze-skill.ts`'s `isPluginManifestDir` (not exported there, and this module deliberately
 *  does NOT reuse the markdown resolver — see the file-level doc comment and §B2's "NOT the markdown
 *  resolver" bullet). Semantics must stay identical to the markdown-side test. */
function isPluginManifestDir(dir: string): boolean {
  return existsSync(join(dir, ".claude-plugin", "plugin.json")) || existsSync(join(dir, "plugin.json"));
}

/** Non-recursive subdirectory NAMES directly inside `dir` (used to enumerate `skills/*` entries for a
 *  plugin-root target). Records a `select`-stage `AnalysisFailure` on a `readdirSync` failure instead of
 *  silently returning `[]` — mirrors §B2's "never a silent skip" for a selected/enumerated source. */
function listSubdirNames(dir: string, failures: AnalysisFailure[]): string[] {
  if (!existsSync(dir)) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    failures.push({ path: dir, stage: "select", reason: (e as Error).message });
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
        continue; // dangling symlink — nothing on the other end
      }
      if (st.isDirectory()) out.push(e.name);
    }
  }
  return out;
}

/** Recursive walk under `dir` collecting every file whose extension is in `SOURCE_EXTS`
 *  (`.html/.htm/.js/.mjs/.ts/.jsx/.tsx/.py`), skipping `node_modules`/`.git`/`dist`/dot-dirs and
 *  `*.min.js` files. Follows directory symlinks (loop-guarded via `visited`, a `Set` of realpaths
 *  threaded by reference through the recursion — the same technique `analyze-skill.ts`'s
 *  `walkMarkdownDeep` uses). A `realpathSync`/`readdirSync` failure on a directory pushes a `select`-stage
 *  `AnalysisFailure` and yields `[]` for that branch — NEVER a silent empty return, per §B2. */
function walkSourceFiles(dir: string, visited: Set<string>, failures: AnalysisFailure[]): string[] {
  let real: string;
  try {
    real = realpathSync(dir);
  } catch (e) {
    failures.push({ path: dir, stage: "select", reason: (e as Error).message });
    return [];
  }
  if (visited.has(real)) return [];
  visited.add(real);

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    failures.push({ path: dir, stage: "select", reason: (e as Error).message });
    return [];
  }

  const out: string[] = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (isDenylistedDirName(e.name)) continue;
      out.push(...walkSourceFiles(full, visited, failures));
      continue;
    }
    let isFile = e.isFile();
    if (e.isSymbolicLink()) {
      let st;
      try {
        st = statSync(full); // follows the link — resolves to the TARGET's type
      } catch {
        continue; // dangling symlink — nothing on the other end to scan
      }
      if (st.isDirectory()) {
        if (isDenylistedDirName(e.name)) continue;
        out.push(...walkSourceFiles(full, visited, failures));
        continue;
      }
      isFile = st.isFile();
    }
    if (!isFile) continue;
    if (isMinifiedJs(e.name)) continue;
    const ext = extname(e.name).toLowerCase();
    if (SOURCE_EXTS.has(ext)) out.push(resolve(full));
  }
  return out;
}

/** Translate ONE glob filename segment (`*.html`, `agent-*.js`) into a case-insensitive `RegExp`. `*` is
 *  the only supported wildcard; matched against a bare file NAME, never a full path. Mirrors
 *  `analyze-skill.ts`'s `globSegmentToRegExp`, duplicated locally (not exported there). */
function globSegmentToRegExp(segment: string): RegExp {
  const parts = segment.split("*").map((literal) => literal.replace(/[.+^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${parts.join(".*")}$`, "i");
}

/** Expand ONE glob target to its matching source files. Only two shapes are supported, mirroring
 *  `analyze-skill.ts`'s `expandGlob`: `dir/*.ext` (shallow) and `dir/**\/*.ext` (recursive, reusing
 *  `walkSourceFiles`). Any other placement of `*` is a `select`-stage failure naming the two supported
 *  shapes — never silently misinterpreted. */
function expandSourceGlob(pattern: string): { files: string[]; failures: AnalysisFailure[] } {
  const segments = pattern.split("/");
  const nameSegment = segments[segments.length - 1];
  let dirSegments = segments.slice(0, -1);
  const recursive = dirSegments.length > 0 && dirSegments[dirSegments.length - 1] === "**";
  if (recursive) dirSegments = dirSegments.slice(0, -1);

  if (dirSegments.some((s) => s.includes("*")) || !nameSegment.includes("*")) {
    return {
      files: [],
      failures: [
        {
          path: pattern,
          stage: "select",
          reason: `unsupported glob shape: ${pattern} — only "dir/*.ext" (shallow) and "dir/**/*.ext" (recursive) are supported`,
        },
      ],
    };
  }

  const dir = dirSegments.length > 0 ? dirSegments.join("/") : ".";
  const nameRe = globSegmentToRegExp(nameSegment);
  const failures: AnalysisFailure[] = [];

  if (recursive) {
    const visited = new Set<string>();
    const all = walkSourceFiles(resolve(dir), visited, failures);
    return { files: all.filter((f) => nameRe.test(basename(f))), failures };
  }

  if (!existsSync(dir)) return { files: [], failures: [] };
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return { files: [], failures: [{ path: dir, stage: "select", reason: (e as Error).message }] };
  }
  const files: string[] = [];
  for (const e of entries) {
    if (!nameRe.test(e.name)) continue;
    const full = join(dir, e.name);
    let isFile = e.isFile();
    if (e.isSymbolicLink()) {
      try {
        isFile = statSync(full).isFile();
      } catch {
        continue;
      }
    }
    if (!isFile) continue;
    if (!SOURCE_EXTS.has(extname(e.name).toLowerCase())) continue;
    files.push(resolve(full));
  }
  return { files, failures };
}

/** Resolve ONE target — an individual file, a standalone skill dir, a plugin root, a nested-plugin skill
 *  dir, or a `*`-bearing glob — to the union of `.html/.htm/.js/.mjs/.ts/.jsx/.tsx/.py` SOURCE files in
 *  scope, per §B2's source-collection contract. This is this module's OWN collection primitive — it does
 *  NOT reuse `analyze-skill.ts`'s `resolveSkillTarget` (that walker is markdown-only and deliberately
 *  never reaches `scripts/*.py`); it reuses only the SHAPE of the sibling-exclusion boundary
 *  (a plugin's other skills stay out of scope for a single skill-dir target), reimplemented locally
 *  because the underlying helpers there are not exported.
 *
 *  Shapes:
 *   - a FILE target → that file alone, iff its extension is a source extension (else `{files:[]}`, not
 *     an error — a non-source file target is simply out of scope, not a failure);
 *   - a `*`-bearing target → `expandSourceGlob`;
 *   - a DIRECTORY with its OWN `SKILL.md` (a standalone skill dir, OR a skill dir that is ALSO a plugin
 *     root — dual shape) → its WHOLE subtree, recursively, including `scripts/`, `assets/`, and
 *     `references/`. Sibling skills are excluded for free: this walk only ever recurses INTO `dir`
 *     itself, so a sibling `skills/<other>` dir one level up is never visited — this is the
 *     "nested-plugin skill" shape too (a skill dir inside an enclosing plugin), since it has the same
 *     own-`SKILL.md` shape and the same sibling-exclusion property;
 *   - a DIRECTORY that is a plugin root WITHOUT its own top-level `SKILL.md` → the union of EACH
 *     contained skill's own subtree (`skills/<name>/**` for every `<name>` with a `SKILL.md`), not the
 *     plugin's other content (`agents/`, `commands/`, or root-level files outside any skill) — mirrors
 *     the plan's "plugin root (each contained skill's subtree)";
 *   - a DIRECTORY matching neither shape (e.g. a bare `scripts/` dir pointed at directly) → a permissive
 *     fallback that just walks it — there is no sibling boundary to enforce because no skill/plugin
 *     structure was recognized.
 *
 *  A `realpathSync`/`readdirSync` failure anywhere in the walk (including the top-level target itself, a
 *  `skills/` enumeration, or any nested directory) is a `select`-stage `AnalysisFailure`, never a silent
 *  skip. Returned `files` is deduped by resolved absolute path and sorted for determinism.
 */
export function collectArtifactSources(target: string): { files: string[]; failures: AnalysisFailure[] } {
  if (target.includes("*")) return expandSourceGlob(target);

  if (!existsSync(target)) {
    return { files: [], failures: [{ path: target, stage: "select", reason: `path not found: ${target}` }] };
  }

  let st;
  try {
    st = statSync(target);
  } catch (e) {
    return { files: [], failures: [{ path: target, stage: "select", reason: (e as Error).message }] };
  }

  if (!st.isDirectory()) {
    if (!SOURCE_EXTS.has(extname(target).toLowerCase())) return { files: [], failures: [] };
    return { files: [resolve(target)], failures: [] };
  }

  const dir = resolve(target);
  const failures: AnalysisFailure[] = [];
  const files = new Set<string>();
  const visited = new Set<string>();

  const hasTopSkillMd = existsSync(join(dir, "SKILL.md"));
  const isPluginRoot = isPluginManifestDir(dir);

  if (hasTopSkillMd) {
    // Standalone skill dir, OR a skill dir that is simultaneously a plugin root (dual shape, e.g. this
    // repo's own `.claude/skills/cowork-harness/`) — either way its own whole subtree is in scope, and
    // sibling skills are excluded for free (we only ever recurse into `dir`). Also covers the
    // nested-plugin-skill shape (own SKILL.md, enclosing plugin elsewhere) identically.
    for (const f of walkSourceFiles(dir, visited, failures)) files.add(f);
  } else if (isPluginRoot) {
    // Bare plugin root: scope is each CONTAINED skill's subtree, not the plugin's other content.
    const skillsDir = join(dir, "skills");
    for (const name of listSubdirNames(skillsDir, failures)) {
      const skillDir = join(skillsDir, name);
      if (!existsSync(join(skillDir, "SKILL.md"))) continue; // not a scannable skill dir
      for (const f of walkSourceFiles(skillDir, visited, failures)) files.add(f);
    }
  } else {
    // Unrecognized shape (no SKILL.md anywhere in scope, no plugin manifest) — permissive fallback: scan
    // whatever is there. There is no sibling boundary to enforce because no skill/plugin structure was
    // recognized in the first place.
    for (const f of walkSourceFiles(dir, visited, failures)) files.add(f);
  }

  return { files: [...files].sort(), failures };
}

// ------------------------------------------------------------------------------------------------- //
// Candidacy
// ------------------------------------------------------------------------------------------------- //

/** `fetch(`, `XMLHttpRequest`, or `sendBeacon(` anywhere in the raw text — the write-back primitives
 *  named verbatim in §B2. Checked lexically (not via AST) so it applies uniformly to `.html` markup,
 *  plain JS/TS, AND `.py` generator templates (the archetype: the tell-tale string lives in a Python
 *  triple-quoted string, which this regex sees exactly as written). */
const WRITE_BACK_PRIMITIVE_RE = /\bfetch\s*\(|XMLHttpRequest|sendBeacon\s*\(/;
/** A native declarative write-back: `<form … method=post …>` (any attribute order, quote style). Its own
 *  primitive per §B2 — an HTML candidate needs no `<script>` at all to qualify if this is present. */
const FORM_POST_TAG_RE = /<form\b[^>]*\bmethod\s*=\s*["']?post["']?[^>]*>/i;
function hasWriteBackPrimitive(text: string): boolean {
  return WRITE_BACK_PRIMITIVE_RE.test(text) || FORM_POST_TAG_RE.test(text);
}

/** A browser/HTML-emit marker: `<script`, `document.`, `innerHTML`, or a literal HTML-document string
 *  emit (`<!DOCTYPE html`/`<html …>`). Required (in addition to a write-back primitive) for the
 *  non-HTML extensions — the marker is the evidence that a `.py`/`.js` generator source actually emits a
 *  browser artifact, not just any code that happens to also call `fetch`. */
const BROWSER_MARKER_RE = /<script[\s>]|document\.|innerHTML|<!DOCTYPE\s+html|<html[\s>]/i;

/** True iff `path`'s extension + `text`'s content make it a Tier A CANDIDATE per §B2:
 *   - `.html/.htm` → iff a write-back primitive is present (no browser-marker requirement — a
 *     declarative `<form method=post>` page IS the headline bug);
 *   - the code/generator extensions → iff BOTH a browser marker AND a write-back primitive are present.
 *  A source with the right extension but no matching markers is "ordinary code" — ordinary code must not
 *  fail strict, so this returns `false` (the caller then returns `{}`: no finding, no failure). */
function isCandidate(ext: string, text: string): boolean {
  if (HTML_EXTS.has(ext)) return hasWriteBackPrimitive(text);
  return BROWSER_MARKER_RE.test(text) && hasWriteBackPrimitive(text);
}

// ------------------------------------------------------------------------------------------------- //
// Resource caps
// ------------------------------------------------------------------------------------------------- //

/** Byte cap per §B2 ("Adopt an explicit byte cap … 3,000,000 bytes"). A SELECTED source at or under this
 *  size still goes through candidacy/analysis; over it, analysis is abandoned before candidacy is even
 *  judged (a byte-cap hit is `analysis-unavailable`, never "not a candidate"). */
const BYTE_CAP = 3_000_000;
/** Parser-node cap — bounds a pathological (or adversarial) AST from consuming unbounded time/memory
 *  during the semantic walk. Sized well above any real hand-authored artifact script; a crafted fixture
 *  can still exceed it deliberately (see the test suite). */
const NODE_LIMIT = 20_000;
/** Per-file wall-clock deadline (ms) — the byte cap alone doesn't bound a pathological AST shape, and a
 *  non-regular-file read (fifo/slow mount) isn't bounded by a byte cap at all; this is the backstop. */
const DEADLINE_MS = 3_000;

class CapExceededError extends Error {
  constructor(
    public readonly stage: "node-limit" | "deadline",
    message: string,
  ) {
    super(message);
  }
}

/** `acorn.parse` plus a bounded `acorn-walk` full pass that enforces `NODE_LIMIT`/`DEADLINE_MS`. Throws
 *  the underlying `SyntaxError` on a genuine parse failure (caller maps that to `stage:"parse"`), or a
 *  `CapExceededError` on a cap hit (caller maps that to `stage:"node-limit"`/`"deadline"`). */
function parseWithCaps(code: string): acorn.Node {
  const ast = acorn.parse(code, { ecmaVersion: "latest", allowReturnOutsideFunction: true, sourceType: "script" });
  let count = 0;
  const start = Date.now();
  walk.full(ast, () => {
    count++;
    if (count > NODE_LIMIT) throw new CapExceededError("node-limit", `parser node cap (${NODE_LIMIT}) exceeded`);
    if (Date.now() - start > DEADLINE_MS) throw new CapExceededError("deadline", `per-file analysis deadline (${DEADLINE_MS}ms) exceeded`);
  });
  return ast;
}

// ------------------------------------------------------------------------------------------------- //
// Extraction — pulling parseable JS out of `.html`/`.py`/`.js`-family sources
// ------------------------------------------------------------------------------------------------- //

interface ScriptBlock {
  code: string;
  /** Byte offset of `code` within the ORIGINAL file text — used to map an AST node's `.start` back to a
   *  real source line via `lineOf`. */
  offset: number;
}

/** Non-external `<script>…</script>` blocks (skips `<script src=…>`) — works identically whether the
 *  literal `<script>` tag lives in real HTML markup or inside a `.py`/`.js` template string, since this
 *  is a lexical regex over the raw file text, not an HTML parse. */
const SCRIPT_BLOCK_RE = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
function extractScriptBlocks(text: string): ScriptBlock[] {
  const blocks: ScriptBlock[] = [];
  SCRIPT_BLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SCRIPT_BLOCK_RE.exec(text))) {
    const offset = m.index + m[0].indexOf(m[1]);
    blocks.push({ code: m[1], offset });
  }
  return blocks;
}

function lineOf(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}

// ------------------------------------------------------------------------------------------------- //
// Declarative `<form method=post>` write-back
// ------------------------------------------------------------------------------------------------- //

const FORM_TAG_RE = /<form\b[^>]*>/gi;
const METHOD_ATTR_RE = /\bmethod\s*=\s*["']?([a-zA-Z]+)["']?/i;
const ACTION_ATTR_RE = /\baction\s*=\s*["']([^"']*)["']/i;
/** An absolute, non-local scheme URL (`https://example.com/...`) — the ONE thing that makes a form
 *  target NOT this bug class. `localhost`/`127.*`/`0.0.0.0` are still treated as local/in-scope, same as
 *  the JS URL classifier below. */
const ABSOLUTE_REMOTE_URL_RE = /^[a-z][a-z0-9+.-]*:\/\/(?!(localhost|127\.|0\.0\.0\.0))/i;

interface DeclarativeFormHit {
  line: number;
}

/** Every native `<form method=post …>` whose `action` is relative/local (or absent — an absent `action`
 *  submits back to the current page URL, which is inherently same-origin). Each hit is, by definition, a
 *  LOST write-back per §B2/§B3: there is no JS handler, so no `resp.ok` check is even possible, and the
 *  browser's default navigate-to-response is what silently eats Cowork's non-ok response. */
function relativeFormPosts(text: string): DeclarativeFormHit[] {
  const hits: DeclarativeFormHit[] = [];
  FORM_TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FORM_TAG_RE.exec(text))) {
    const tag = m[0];
    const methodMatch = METHOD_ATTR_RE.exec(tag);
    const method = (methodMatch ? methodMatch[1] : "GET").toUpperCase();
    if (method !== "POST") continue;
    const actionMatch = ACTION_ATTR_RE.exec(tag);
    const action = actionMatch ? actionMatch[1] : "";
    if (ABSOLUTE_REMOTE_URL_RE.test(action)) continue; // real remote egress, not this bug class
    hits.push({ line: lineOf(text, m.index) });
  }
  return hits;
}

// ------------------------------------------------------------------------------------------------- //
// AST: constant folding, guard-truthiness, and write-back call-site classification
// ------------------------------------------------------------------------------------------------- //

type ConstsMap = Map<string, acorn.Expression | null>;

/** File-level single-assignment approximation: every `const x = <init>` (well, every `VariableDeclarator`
 *  regardless of `const`/`let`/`var` — a conservative over-approximation, since a REASSIGNED `let` would
 *  make this wrong, but reassignment of a would-be static flag is rare and this only ever feeds
 *  "provable-truthy" judgments that fall back to "unknown" on anything it can't fold anyway). */
function buildConstsMap(ast: acorn.Node): ConstsMap {
  const consts: ConstsMap = new Map();
  // NO-FALSE-GREEN: a name that is REASSIGNED (or declared more than once, or mutated by ++/--) is NOT
  // single-assignment — folding it to its declared init could evaluate a guard to `false` → dead → clean
  // when the reassigned runtime value would have kept the write-back live (a false green). Poison such
  // names so `foldStr`/`evalBool` treat them as UNKNOWN (→ a guard becomes `suspect`, a URL becomes a
  // documented false negative — never a silent clean).
  const poisoned = new Set<string>();
  walk.simple(ast, {
    VariableDeclarator(n) {
      if (n.id.type === "Identifier" && n.init) {
        if (consts.has(n.id.name)) poisoned.add(n.id.name); // declared more than once
        consts.set(n.id.name, n.init as acorn.Expression);
      }
    },
    AssignmentExpression(n) {
      if (n.left.type === "Identifier") poisoned.add(n.left.name); // reassigned after declaration
    },
    UpdateExpression(n) {
      if (n.argument.type === "Identifier") poisoned.add(n.argument.name); // x++/x--
    },
  });
  for (const name of poisoned) consts.delete(name);
  return consts;
}

/** Constant-fold a string-valued expression: string literal, template literal WITHOUT unresolved
 *  identifiers, `+`-concatenation, `[...].join(sep)`, a one-hop identifier lookup via `consts`, or the
 *  `.slice(0)` copy idiom. Returns `null` when the value can't be determined statically — a DOCUMENTED
 *  Tier A false negative (§B2: "a generator whose … URLs are themselves computed is missed by Tier A"),
 *  never itself a failure. */
function foldStr(node: acorn.Expression | acorn.Node | null | undefined, consts: ConstsMap, depth = 0): string | null {
  if (!node || depth > 6) return null;
  const n = node as acorn.AnyNode;
  if (n.type === "Literal" && typeof n.value === "string") return n.value;
  if (n.type === "TemplateLiteral") {
    let out = "";
    for (let i = 0; i < n.quasis.length; i++) {
      out += n.quasis[i].value.cooked ?? "";
      if (i < n.expressions.length) {
        const v = foldStr(n.expressions[i], consts, depth + 1);
        if (v == null) return null;
        out += v;
      }
    }
    return out;
  }
  if (n.type === "BinaryExpression" && n.operator === "+") {
    const l = foldStr(n.left, consts, depth + 1);
    const r = foldStr(n.right, consts, depth + 1);
    return l != null && r != null ? l + r : null;
  }
  if (n.type === "Identifier" && consts.has(n.name)) return foldStr(consts.get(n.name), consts, depth + 1);
  if (
    n.type === "CallExpression" &&
    n.callee.type === "MemberExpression" &&
    !n.callee.computed &&
    n.callee.property.type === "Identifier" &&
    n.callee.property.name === "join" &&
    n.callee.object.type === "ArrayExpression"
  ) {
    const sep = n.arguments[0] ? foldStr(n.arguments[0] as acorn.Expression, consts, depth + 1) : ",";
    const parts = n.callee.object.elements.map((e) => (e ? foldStr(e as acorn.Expression, consts, depth + 1) : null));
    return sep != null && parts.every((p) => p != null) ? (parts as string[]).join(sep) : null;
  }
  if (
    n.type === "CallExpression" &&
    n.callee.type === "MemberExpression" &&
    !n.callee.computed &&
    n.callee.property.type === "Identifier" &&
    n.callee.property.name === "slice"
  ) {
    return foldStr(n.callee.object as acorn.Expression, consts, depth + 1); // `s.slice(0)` copy idiom
  }
  return null;
}

/** Resolve the HTTP method from a `fetch`/wrapper options argument: an inline object literal, or an
 *  identifier resolved one hop through `consts`. `undefined`/absent options → `"GET"` (fetch's default).
 *  An options shape we can't read (a spread, a computed key, a non-object) → `"UNKNOWN"` — never silently
 *  assumed safe. */
function methodOf(optsNode: acorn.Expression | null | undefined, consts: ConstsMap): string {
  if (!optsNode) return "GET";
  let o: acorn.AnyNode = optsNode;
  if (o.type === "Identifier" && consts.has(o.name)) {
    const resolved = consts.get(o.name);
    if (resolved) o = resolved;
  }
  if (o.type !== "ObjectExpression") return "UNKNOWN";
  for (const p of o.properties) {
    if (p.type !== "Property") continue;
    const keyName = p.key.type === "Identifier" ? p.key.name : p.key.type === "Literal" ? String(p.key.value) : null;
    if (keyName === "method") {
      const folded = foldStr(p.value as acorn.Expression, consts);
      return (folded ?? "UNKNOWN").toUpperCase();
    }
  }
  return "GET";
}

const COMMIT_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

type UrlTarget = "relative" | "remote" | "unknown";

/** Classify a folded URL string. `localhost`/`127.*`/`0.0.0.0` absolute URLs are treated as
 *  same-origin-local (still in scope — a relative/same-origin-local target IS the bug class); any other
 *  absolute scheme is real remote egress and is skipped entirely (not this bug class). A relative path
 *  (starts with `/`, or has no `scheme://` at all) is `"relative"`. */
function classifyUrl(url: string | null): UrlTarget {
  if (url == null) return "unknown"; // documented Tier A false negative — computed/unresolvable URL
  if (/^https?:\/\/(localhost|127\.|0\.0\.0\.0)/i.test(url)) return "relative";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return "remote";
  return "relative";
}

// ---- guard-truthiness: provable-truthy vs unknown vs unsupported (the headline false-green fix) ---- //

type BoolFold = "true" | "false" | "unknown";
function invertBool(v: BoolFold): BoolFold {
  return v === "true" ? "false" : v === "false" ? "true" : "unknown";
}

/** Statically evaluate a boolean-valued expression to `"true"`/`"false"`/`"unknown"`. Handles a boolean
 *  literal, `!<expr>`, a one-hop `consts` identifier lookup, and a single non-computed property read off
 *  an object literal resolved (one hop) through `consts` (e.g. `OPTS.is_static` where
 *  `const OPTS = {is_static: true}`). Anything else — a runtime flag, a function call, a comparison, an
 *  unresolved member expression — is `"unknown"`: a MERELY LEXICAL guard match is NOT provable-truthy. */
function evalBool(node: acorn.Node | null | undefined, consts: ConstsMap, depth = 0): BoolFold {
  if (!node || depth > 6) return "unknown";
  const n = node as acorn.AnyNode;
  if (n.type === "Literal" && typeof n.value === "boolean") return n.value ? "true" : "false";
  if (n.type === "UnaryExpression" && n.operator === "!") return invertBool(evalBool(n.argument, consts, depth + 1));
  if (n.type === "Identifier") {
    if (consts.has(n.name)) return evalBool(consts.get(n.name), consts, depth + 1);
    return "unknown";
  }
  if (n.type === "MemberExpression" && !n.computed && n.property.type === "Identifier") {
    let obj: acorn.AnyNode = n.object;
    if (obj.type === "Identifier" && consts.has(obj.name)) {
      const resolved = consts.get(obj.name);
      if (resolved) obj = resolved;
    }
    if (obj.type === "ObjectExpression") {
      for (const p of obj.properties) {
        if (p.type !== "Property") continue;
        const keyName = p.key.type === "Identifier" ? p.key.name : p.key.type === "Literal" ? String(p.key.value) : null;
        if (keyName === n.property.name) return evalBool(p.value, consts, depth + 1);
      }
    }
    return "unknown";
  }
  return "unknown";
}

type GuardInfo = { kind: "test"; test: acorn.Node; polarity: 1 | -1 } | { kind: "unsupported" };

/** Walk `ancestors` (innermost/self last, per `acorn-walk`'s `ancestor` visitor) outward to find the
 *  NEAREST construct that gates reachability of the call site: an `IfStatement` consequent/alternate, a
 *  `ConditionalExpression` consequent/alternate, or the right-hand side of a `LogicalExpression &&`.
 *  Stops (no guard) at the nearest enclosing function boundary — this module reasons about guards only
 *  within the call site's own function, matching the "one-level" scope used for fetch-wrapper
 *  propagation elsewhere. A `SwitchCase` on the path is control flow this module can't represent as a
 *  simple truthy/falsy gate → `{kind:"unsupported"}` (maps to `stage:"unsupported-guard"`). `null` means
 *  the call site is not guarded at all (equivalent to a provably-live guard). */
function nearestGuard(ancestors: acorn.AnyNode[]): GuardInfo | null {
  for (let i = ancestors.length - 2; i >= 0; i--) {
    const node = ancestors[i];
    const child = ancestors[i + 1];
    if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
      return null;
    }
    if (node.type === "SwitchCase") return { kind: "unsupported" };
    if (node.type === "IfStatement") {
      if (node.consequent === child) return { kind: "test", test: node.test, polarity: 1 };
      if (node.alternate === child) return { kind: "test", test: node.test, polarity: -1 };
    }
    if (node.type === "ConditionalExpression") {
      if (node.consequent === child) return { kind: "test", test: node.test, polarity: 1 };
      if (node.alternate === child) return { kind: "test", test: node.test, polarity: -1 };
    }
    if (node.type === "LogicalExpression" && node.operator === "&&" && node.right === child) {
      return { kind: "test", test: node.left, polarity: 1 };
    }
  }
  return null;
}

type GuardStatus = "live" | "dead" | "unknown" | "unsupported";

function guardStatusOf(ancestors: acorn.AnyNode[], consts: ConstsMap): GuardStatus {
  const guard = nearestGuard(ancestors);
  if (!guard) return "live";
  if (guard.kind === "unsupported") return "unsupported";
  const raw = evalBool(guard.test, consts);
  const effective = guard.polarity === 1 ? raw : invertBool(raw);
  return effective === "true" ? "live" : effective === "false" ? "dead" : "unknown";
}

// ---- consequence classification for a LIVE (unguarded or provably-live-guarded) write-back call ---- //

const OK_CHECK_RE = /(resp?\.ok\b|res\.ok\b|response\.ok\b|\.status\s*(===|!==|==|!=|<=|>=|<|>))/;
const DOWNLOAD_FALLBACK_RE = /(createObjectURL|\.download\s*=|triggerDownload)/;
const PERSIST_CLAIM_RE = /\b(saved|submitt\w*|persist\w*|complet\w*|success\w*)\b/i;
const LOOKAHEAD_WINDOW = 1500;

type Outcome =
  | { kind: "lost"; line: number; reason: string }
  | { kind: "suspect"; line: number; reason: string }
  | { kind: "dead" }
  | { kind: "remote" }
  | { kind: "unsupported-guard"; line: number; reason: string };

function classifyConsequence(params: { kind: string; method: string; url: string | null; line: number; after: string }): Outcome {
  const { kind, method, url, line, after } = params;
  const urlDisplay = url ?? "(unresolved)";
  const dl = DOWNLOAD_FALLBACK_RE.test(after);
  const noResponseChannel = kind === "beacon"; // fire-and-forget: can never learn of a non-ok response
  const okChecked = OK_CHECK_RE.test(after.split(".catch")[0] ?? after);
  const persistClaim = PERSIST_CLAIM_RE.test(after);

  if (dl) {
    return {
      kind: "lost",
      line,
      reason:
        `relative ${method} write-back to "${urlDisplay}" (${kind}) falls back to a client-side download ` +
        "(createObjectURL/.download) on failure — under Cowork this artifact is served from Cowork's own " +
        "origin, so the write-back resolves-but-non-ok AND the download fallback is also broken inside " +
        "Cowork's embedded viewer: the data is lost either way",
    };
  }
  if (noResponseChannel) {
    return {
      kind: "lost",
      line,
      reason: `sendBeacon("${urlDisplay}") is fire-and-forget — there is no response channel to consult, so a non-ok Cowork response can never be detected`,
    };
  }
  if (okChecked) {
    return {
      kind: "suspect",
      line,
      reason: `relative ${method} write-back to "${urlDisplay}" (${kind}) consults the response before proceeding — degrades locally on a non-ok Cowork response, but the write-back itself still never reaches a real backend under Cowork`,
    };
  }
  if (persistClaim) {
    return {
      kind: "lost",
      line,
      reason: `relative ${method} write-back to "${urlDisplay}" (${kind}) claims success without checking resp.ok/status — under Cowork the request resolves against Cowork's own origin with a non-ok response, producing a false "saved" claim`,
    };
  }
  return {
    kind: "suspect",
    line,
    reason: `relative ${method} write-back to "${urlDisplay}" (${kind}) — response handling could not be confidently classified as safe; treated as advisory rather than silently clean`,
  };
}

/** Walk one parsed `<script>` block's AST for write-back call sites (`fetch`, an XHR `.open(method,url)`
 *  with a non-GET method, `sendBeacon`, a one-level fetch-wrapper, or an `axios`/`$`/`jQuery` `.post`) and
 *  classify each into an `Outcome`. `block.offset` + `fileText` are used only to map an AST `.start` back
 *  to a real 1-based source line via `lineOf`. */
function analyzeScriptAst(ast: acorn.Node, block: ScriptBlock, fileText: string): Outcome[] {
  const consts = buildConstsMap(ast);

  // Pass 1: one-level fetch-wrapper helpers — `function f(url, ...) { ... fetch(url, {method:"POST"}) ... }`.
  const wrappers = new Map<string, number>();
  walk.simple(ast, {
    FunctionDeclaration(fn) {
      if (!fn.id) return;
      walk.simple(fn.body, {
        CallExpression(c) {
          if (c.callee.type === "Identifier" && c.callee.name === "fetch" && c.arguments[0]?.type === "Identifier") {
            const argName = (c.arguments[0] as acorn.Identifier).name;
            const idx = fn.params.findIndex((p) => p.type === "Identifier" && p.name === argName);
            const meth = methodOf(c.arguments[1] as acorn.Expression | undefined, consts);
            if (idx >= 0 && COMMIT_METHODS.has(meth)) wrappers.set(fn.id!.name, idx);
          }
        },
      });
    },
  });

  const outcomes: Outcome[] = [];
  walk.ancestor(ast, {
    CallExpression(n, _state, ancestors) {
      const c = n.callee;
      let kind: string | null = null;
      let urlNode: acorn.Expression | undefined;
      let method = "GET";

      if (c.type === "Identifier" && c.name === "fetch") {
        kind = "fetch";
        urlNode = n.arguments[0] as acorn.Expression | undefined;
        method = methodOf(n.arguments[1] as acorn.Expression | undefined, consts);
      } else if (c.type === "Identifier" && wrappers.has(c.name)) {
        kind = "fetch-wrapper";
        urlNode = n.arguments[wrappers.get(c.name)!] as acorn.Expression | undefined;
        method = "POST";
      } else if (
        c.type === "MemberExpression" &&
        !c.computed &&
        c.property.type === "Identifier" &&
        c.property.name === "open" &&
        n.arguments.length >= 2
      ) {
        const m = (foldStr(n.arguments[0] as acorn.Expression, consts) ?? "UNKNOWN").toUpperCase();
        if (m !== "GET") {
          kind = "xhr";
          urlNode = n.arguments[1] as acorn.Expression;
          method = m;
        }
      } else if (c.type === "MemberExpression" && !c.computed && c.property.type === "Identifier" && c.property.name === "sendBeacon") {
        kind = "beacon";
        urlNode = n.arguments[0] as acorn.Expression | undefined;
        method = "POST";
      } else if (
        c.type === "MemberExpression" &&
        !c.computed &&
        c.property.type === "Identifier" &&
        c.property.name === "post" &&
        c.object.type === "Identifier" &&
        ["axios", "$", "jQuery"].includes(c.object.name)
      ) {
        kind = "lib-post";
        urlNode = n.arguments[0] as acorn.Expression | undefined;
        method = "POST";
      }

      if (!kind || !COMMIT_METHODS.has(method)) return;

      const url = foldStr(urlNode, consts);
      const target = classifyUrl(url);
      if (target === "remote" || target === "unknown") return; // real egress, or a documented false negative

      const status = guardStatusOf(ancestors, consts);
      const line = lineOf(fileText, block.offset + n.start);
      if (status === "unsupported") {
        outcomes.push({
          kind: "unsupported-guard",
          line,
          reason: `relative ${method} write-back (${kind}) sits inside control flow (a switch case) this static analyzer can't represent as a simple guard`,
        });
        return;
      }
      if (status === "dead") {
        outcomes.push({ kind: "dead" });
        return;
      }
      if (status === "unknown") {
        outcomes.push({
          kind: "suspect",
          line,
          reason: `relative ${method} write-back to "${url ?? "(unresolved)"}" (${kind}) is behind a guard whose runtime value cannot be proven statically — cannot rule out it firing under Cowork's origin`,
        });
        return;
      }
      // status === "live": either genuinely unguarded, or a guard that provably evaluates truthy for
      // this branch — either way the call is reachable, so classify its consequence normally.
      const after = fileText.slice(block.offset + n.start, block.offset + n.start + LOOKAHEAD_WINDOW);
      outcomes.push(classifyConsequence({ kind, method, url, line, after }));
    },
  });

  return outcomes;
}

// ------------------------------------------------------------------------------------------------- //
// Per-file core
// ------------------------------------------------------------------------------------------------- //

/** Analyze ONE already-read source file for the Cowork write-back bug class. Returns EXACTLY ONE of:
 *   - `{finding}` — a verdict finding (`artifact-write-back-lost` error, or `artifact-write-back-suspect`
 *     advisory);
 *   - `{failure}` — a could-not-verify record (`AnalysisFailure`, see the stage enum on that type);
 *   - `{}` — either the source is not a Tier A CANDIDATE at all (ordinary code — no finding, no failure),
 *     or it IS a candidate but has no live relative write-back (no relative write-back at all, or every
 *     one found is behind a provably-dead guard) — genuinely clean.
 *  Never returns both `finding` and `failure` — a could-not-verify signal always wins over a same-file
 *  finding (see the parse-failure short-circuit below), so a real problem is never masked by a partial
 *  verdict from the rest of the file. */
export function analyzeArtifactFile(path: string, text: string): { finding?: SkillFinding; failure?: AnalysisFailure } {
  const ext = extname(path).toLowerCase();
  if (!SOURCE_EXTS.has(ext)) return {};

  if (Buffer.byteLength(text, "utf8") > BYTE_CAP) {
    return {
      failure: { path, stage: "size", reason: `source is ${Buffer.byteLength(text, "utf8")} bytes, exceeds the ${BYTE_CAP} byte cap` },
    };
  }

  if (!isCandidate(ext, text)) return {}; // ordinary code — not a candidate, not a failure

  const isHtmlLike = HTML_EXTS.has(ext);

  // Declarative <form method=post> write-backs — evaluated independent of any <script> extraction, so a
  // pure-declarative HTML page (no <script> at all) still produces a verdict (§B2/§B3 test (h)).
  const formHits = relativeFormPosts(text);

  let blocks = extractScriptBlocks(text);
  if (blocks.length === 0) {
    if (!isHtmlLike && ext !== ".py") {
      // A plain JS-family file (no <script> wrapper needed — the file itself IS the script).
      blocks = [{ code: text, offset: 0 }];
    } else if (ext === ".py") {
      // Candidacy already confirmed browser + write-back markers are present in the raw text, but no
      // <script> block could be isolated from a Python source — the archetype (write-back string in a
      // template) needs that extraction to succeed; when it can't, this is a could-not-verify, never a
      // silent pass.
      return {
        failure: {
          path,
          stage: "extract",
          reason: "candidate .py source has browser/write-back markers but no <script>…</script> block could be isolated for analysis",
        },
      };
    }
    // isHtmlLike with zero <script> blocks: fine — a pure-declarative candidate, handled via formHits.
  }

  const outcomes: Outcome[] = [];
  for (const hit of formHits) {
    outcomes.push({
      kind: "lost",
      line: hit.line,
      reason:
        "native <form method=post> submits to a relative/local-origin endpoint with no JS handler — resp.ok can " +
        "never be checked, so the browser's default navigate-to-response silently swallows Cowork's non-ok reply",
    });
  }

  for (const block of blocks) {
    let ast: acorn.Node;
    try {
      ast = parseWithCaps(block.code);
    } catch (e) {
      if (e instanceof CapExceededError) {
        return { failure: { path, stage: e.stage, reason: e.message } };
      }
      return { failure: { path, stage: "parse", reason: (e as Error).message } };
    }
    outcomes.push(...analyzeScriptAst(ast, block, text));
  }

  const unsupported = outcomes.find((o): o is Extract<Outcome, { kind: "unsupported-guard" }> => o.kind === "unsupported-guard");
  if (unsupported) {
    return { failure: { path, stage: "unsupported-guard", reason: unsupported.reason } };
  }

  const live = outcomes.filter((o): o is Extract<Outcome, { kind: "lost" | "suspect" }> => o.kind === "lost" || o.kind === "suspect");
  if (live.length === 0) return {}; // no relative write-back at all, or every one is provably dead code

  const lost = live.find((o) => o.kind === "lost");
  if (lost) {
    return { finding: { rule: "artifact-write-back-lost", severity: "error", path, line: lost.line, message: lost.reason } };
  }
  const suspect = live[0];
  return { finding: { rule: "artifact-write-back-suspect", severity: "advisory", path, line: suspect.line, message: suspect.reason } };
}

// ------------------------------------------------------------------------------------------------- //
// Orchestrator
// ------------------------------------------------------------------------------------------------- //

/** `collectArtifactSources` → read each selected file (a `select`-stage collection failure is already
 *  surfaced by that step) → `analyzeArtifactFile` → aggregate. Dedupes selected files by resolved
 *  absolute path ACROSS all `targets` (a file reachable via two overlapping targets, e.g. a plugin root
 *  and one of its own skill dirs named explicitly, is analyzed once). A `stat`/`read` failure on an
 *  individual selected file is a `read`-stage `AnalysisFailure`; a selected file over `BYTE_CAP` is a
 *  `size`-stage failure BEFORE it is read into memory at all. */
export function analyzeArtifacts(targets: string[]): { findings: SkillFinding[]; analysisFailures: AnalysisFailure[]; scanned: string[] } {
  const findings: SkillFinding[] = [];
  const analysisFailures: AnalysisFailure[] = [];
  const seenFiles = new Set<string>();
  const seenFailures = new Set<string>();

  const pushFailure = (f: AnalysisFailure) => {
    const key = `${f.stage}:${f.path}:${f.reason}`;
    if (seenFailures.has(key)) return;
    seenFailures.add(key);
    analysisFailures.push(f);
  };

  for (const target of targets) {
    const { files, failures } = collectArtifactSources(target);
    for (const f of failures) pushFailure(f);

    for (const file of files) {
      const resolved = resolve(file);
      if (seenFiles.has(resolved)) continue;
      seenFiles.add(resolved);

      let st;
      try {
        st = statSync(resolved);
      } catch (e) {
        pushFailure({ path: resolved, stage: "read", reason: (e as Error).message });
        continue;
      }
      if (st.size > BYTE_CAP) {
        pushFailure({ path: resolved, stage: "size", reason: `source is ${st.size} bytes, exceeds the ${BYTE_CAP} byte cap` });
        continue;
      }

      let text: string;
      try {
        text = readFileSync(resolved, "utf8");
      } catch (e) {
        pushFailure({ path: resolved, stage: "read", reason: (e as Error).message });
        continue;
      }

      const { finding, failure } = analyzeArtifactFile(resolved, text);
      if (failure) pushFailure({ ...failure, path: failure.path || resolved });
      if (finding) findings.push(finding);
    }
  }

  return { findings, analysisFailures, scanned: [...seenFiles].sort() };
}
