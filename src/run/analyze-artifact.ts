import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";
import * as acorn from "acorn";
import * as walk from "acorn-walk";
import type { AnalysisFailure, SkillFinding } from "./analyze-skill.js";

/**
 * `analyze-artifact` — the Tier A static detector for the Cowork interactive-artifact write-back bug
 * class described below (see `analyze-artifact-runtime.ts` for the optional Tier B runtime confirmer).
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
/** Code/generator extensions this analyzer can PARSE with the in-process acorn parser: plain scripts
 *  (`.js`), ES modules (`.mjs`, parsed as `sourceType:"module"`), and `.py` generator templates (the
 *  archetype — the browser artifact lives in a Python triple-quoted string, extracted lexically as a
 *  `<script>` block). `.ts`/`.tsx`/`.jsx` are DELIBERATELY NOT advertised here (findings 13/14): acorn
 *  cannot parse TypeScript type-annotations or JSX, so advertising them only produced fail-closed
 *  `stage:"parse"` noise on every real generator/frontend source. Narrowing the advertised contract (no
 *  TypeScript/Babel dependency in this pass) is the pragmatic fix — a `.ts`/`.tsx`/`.jsx` target is now
 *  simply out of scope (like a `.md`), not a could-not-verify. */
const CODE_EXTS = new Set([".js", ".mjs", ".py"]);
const SOURCE_EXTS = new Set<string>([...HTML_EXTS, ...CODE_EXTS]);
/** Extensions whose whole-file body is an ES module (`import`/`export` at top level is legal). Drives
 *  `parseWithCaps`'s module-first parse order. */
const MODULE_EXTS = new Set([".mjs"]);

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
 *  (`.html/.htm/.js/.mjs/.py`), skipping `node_modules`/`.git`/`dist`/dot-dirs and `*.min.js` files.
 *  Follows directory symlinks (loop-guarded via `visited`, a `Set` of realpaths threaded by reference
 *  through the recursion — the same technique `analyze-skill.ts`'s `walkMarkdownDeep` uses). A
 *  `realpathSync`/`readdirSync` failure on a directory pushes a `select`-stage `AnalysisFailure` and yields
 *  `[]` for that branch — NEVER a silent empty return, per §B2.
 *
 *  CONTAINMENT: the FIRST call establishes `rootReal` (its own realpath); every descendant
 *  directory whose realpath resolves OUTSIDE that root is REJECTED with a `select`-stage failure and not
 *  descended into. Without this a directory symlink pointing outside the target (`skill/link -> /etc`)
 *  would traverse unrelated host trees, leak path names into reports, and generate findings outside the
 *  requested review boundary — mirrors the containment guard in `artifacts.ts`'s `collectArtifacts`. */
function walkSourceFiles(dir: string, visited: Set<string>, failures: AnalysisFailure[], rootReal?: string): string[] {
  let real: string;
  try {
    real = realpathSync(dir);
  } catch (e) {
    failures.push({ path: dir, stage: "select", reason: (e as Error).message });
    return [];
  }
  const root = rootReal ?? real; // first call anchors the containment root at its own realpath
  if (real !== root && !real.startsWith(root + sep)) {
    failures.push({
      path: dir,
      stage: "select",
      reason: `skipped: resolves to ${real}, outside the target root ${root} (directory symlink escaping scope)`,
    });
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
      out.push(...walkSourceFiles(full, visited, failures, root));
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
        out.push(...walkSourceFiles(full, visited, failures, root));
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

/** The candidacy write-back primitives — DERIVED FROM THE SAME TABLE the AST visitor (`analyzeScriptAst`)
 *  recognizes, not a narrower fetch/XHR/sendBeacon subset. Matches `fetch(`,
 *  `XMLHttpRequest`, `sendBeacon(`, the bare word `axios` (covers every axios shape — `axios.post(`,
 *  `axios.put(`, a bare `axios({…})`, `axios.request({…})`, and an axios INSTANCE via `axios.create(`,
 *  all of which spell the literal token "axios"), and a jQuery/`$` write verb (`$.post(`/`jQuery.put(`/…).
 *  Before the fix an HTML whose ONLY write-back was `axios.post("/save", …)` failed candidacy and returned
 *  `{}` (a silent false-clean) before the AST — which DOES recognize axios — ever ran. A bare `.post(` on
 *  an arbitrary receiver is deliberately NOT a candidacy tell (it is the axios-instance/Express-route
 *  ambiguity the AST only ever treats as advisory) — but any real axios instance carries the `axios`
 *  token elsewhere, so it is still caught. Checked lexically (not via AST) so it applies uniformly to
 *  `.html` markup, plain JS, AND `.py` generator templates (the archetype: the tell-tale string lives in a
 *  Python triple-quoted string, which this regex sees exactly as written). Also matches the optional-call
 *  spellings (`fetch?.(`, `sendBeacon?.(`) for the same reason `BLOCK_WRITE_BACK_HINT_RE` does below —
 *  a source whose ONLY write-back is spelled with `?.` must still reach candidacy, strictly widening
 *  (never narrowing) which sources are analyzed. The optional-call group nests its trailing `\s*` INSIDE
 *  the group (`(\?\.\s*)?` — never two independent `\s*` runs flanking one optional group) so there is
 *  exactly one way to partition a run of whitespace between the two alternatives; a non-matching tail
 *  (e.g. `fetch` followed by a very long whitespace run and no `(`) fails in linear time instead of
 *  backtracking over every whitespace-split combination. This regex runs over every candidate file before
 *  any byte/parse cap applies, so it must stay linear on adversarial input. */
const WRITE_BACK_PRIMITIVE_RE =
  /\bfetch\s*(\?\.\s*)?\(|XMLHttpRequest|sendBeacon\s*(\?\.\s*)?\(|\baxios\b|(\$|jQuery)\s*\.\s*(post|put|patch|delete|postForm|putForm|patchForm)\s*(\?\.\s*)?\(/;
/** A native declarative write-back: `<form … method=post …>` (any attribute order, quote style,
 *  quoted OR unquoted `method` value). Its own primitive per §B2 — an HTML candidate needs no `<script>`
 *  at all to qualify if this is present. */
const FORM_POST_TAG_RE = /<form\b[^>]*\bmethod\s*=\s*["']?post\b/i;
/** A submit control that overrides its form's method to POST via `formmethod=post` — a candidacy tell for
 *  an otherwise-GET `<form>` whose button forces a POST submission. */
const FORM_POST_SUBMIT_RE = /\bformmethod\s*=\s*["']?post\b/i;
function hasWriteBackPrimitive(text: string): boolean {
  return WRITE_BACK_PRIMITIVE_RE.test(text) || FORM_POST_TAG_RE.test(text) || FORM_POST_SUBMIT_RE.test(text);
}

/** Broader than `WRITE_BACK_PRIMITIVE_RE` — used ONLY to decide whether an UNPARSEABLE `<script>` block is
 *  worth treating as a could-not-verify vs. discounting as prose. Mirrors every write-back kind
 *  `analyzeScriptAst` recognizes: `fetch(`, a bare `.open(` XHR, `sendBeacon(`, and the bare word `axios`
 *  (deliberately NOT `\.post\s*\(` alone — the `\baxios\b` alternative already matches ANY axios call
 *  shape lexically, including `axios.put(`/`axios.patch(`/a bare `axios({...})`/`axios.request({...})`,
 *  since the literal word "axios" is present in all of them; the `.post(` alternative below exists only to
 *  catch `$.post(`/`jQuery.post(`, which have no such bare-word tell) — so an unparseable block whose only
 *  write-back is `xhr.open("POST",…)` or `$.post("/api/…")` is never silently discounted. Erring toward
 *  RECORDING (fail-closed): a block matching this is escalated to could-not-verify, not dropped.
 *
 *  Also mirrors OPTIONAL-CALL spellings (`?.`) of every one of those primitives — `xhr?.open?.(`,
 *  `fetch?.(`, `$.post?.(`, `navigator?.sendBeacon?.(` — because `analyzeScriptAst`'s AST visitor matches
 *  on the callee's property name only and never inspects acorn's `optional` flag, so a PARSEABLE block
 *  using `?.` is flagged identically to its non-optional spelling; an UNPARSEABLE block using `?.` must be
 *  recorded too, not discounted, for the same reason. Each optional-call group nests its trailing `\s*`
 *  INSIDE the group (`(\?\.\s*)?`, never a `\s*` on both sides of one optional group) for the same linear-
 *  time reason documented on `WRITE_BACK_PRIMITIVE_RE` above. One recognized form stays a documented,
 *  lexically undetectable limitation: a call to a same-file fetch-WRAPPER by its own (arbitrary) name
 *  inside an unparseable block — there is no fixed token to match on an arbitrary identifier; the
 *  wrapper's own `fetch(` body is still caught whenever it shares the block. (A member-spelled
 *  `window.fetch(`/`globalThis.fetch(`/`self.fetch(` is NOT in that category — `\bfetch` already matches
 *  right after the `.`, so this regex sees it fine; `analyzeScriptAst`'s AST visitor is what needed a
 *  matching `MemberExpression` arm, below.) `.put(`/`.patch(` sit alongside `.post(` for the same
 *  `$`/`jQuery` reason (no bare-word tell the way `axios` has one) — kept in step with the AST's
 *  whitelisted-receiver and any-receiver-advisory arms, which now recognize all three verbs; `.delete(` is
 *  deliberately NOT added here either, matching the AST's deliberate exclusion (see that arm's comment) —
 *  an unparseable block whose only token is `.delete(` on an arbitrary receiver is exactly the
 *  `Map`/`Set`/cache-object noise the AST side already declined to flag, so the hint side declines too. A
 *  few forms stay invisible to BOTH this regex AND the AST visitor below — the same accepted-approximation
 *  class as the wrapper-name limitation, not specific to either layer: a COMPUTED member spelling
 *  (`xhr["open"](…)`, `obj["post"](…)`) — neither the regex nor the visitor's `!c.computed` checks look
 *  inside a bracketed property access; a dot-with-whitespace member spelling (`xhr . open (…)` — legal JS,
 *  but this regex requires the `.` and property name adjacent) — the same limitation the pre-existing
 *  regex already had; and a call reached only through an aliased/re-exported binding the visitor's
 *  one-hop `consts` resolution can't unwind. */
const BLOCK_WRITE_BACK_HINT_RE =
  /\bfetch\s*(\?\.\s*)?\(|XMLHttpRequest|\.open\s*(\?\.\s*)?\(|sendBeacon\s*(\?\.\s*)?\(|\baxios\b|\.post\s*(\?\.\s*)?\(|\.put\s*(\?\.\s*)?\(|\.patch\s*(\?\.\s*)?\(/;

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
 *  `CapExceededError` on a cap hit (caller maps that to `stage:"node-limit"`/`"deadline"`).
 *
 *  SOURCE TYPE (findings 13/14): tries `sourceType:"script"` then `"module"` (order flipped when
 *  `preferModule`, e.g. a `.mjs` whole-file or a `<script type="module">` block). A script whose only
 *  invalid-as-script construct is a top-level `import`/`export` reparses cleanly as a module — this is the
 *  "controlled script→module retry" that makes real ES modules analyzable instead of a `stage:"parse"`
 *  could-not-verify. A genuinely broken source fails BOTH and the FIRST error (the preferred source type's)
 *  is thrown, preserving the original diagnostic.
 *
 *  DEADLINE: the wall-clock start is captured BEFORE `acorn.parse`, and parse time is charged
 *  against `DEADLINE_MS` immediately after. acorn's own `parse` is not interruptible in-process, so a
 *  pathological ≤`BYTE_CAP` source can still spend up to a few seconds inside a single `parse` call before
 *  the check fires — that residual is accepted this pass (a worker-isolated interruptible parser is out of
 *  scope). What is fixed: a slow parse now yields a typed `stage:"deadline"` analysis failure instead of
 *  being invisibly excluded from the deadline the analyzer advertises. */
function parseWithCaps(code: string, preferModule = false): acorn.Node {
  const start = Date.now();
  const order: acorn.Options["sourceType"][] = preferModule ? ["module", "script"] : ["script", "module"];
  let ast: acorn.Node | undefined;
  let firstErr: unknown;
  for (const sourceType of order) {
    try {
      ast = acorn.parse(code, { ecmaVersion: "latest", allowReturnOutsideFunction: true, sourceType });
      break;
    } catch (e) {
      if (firstErr === undefined) firstErr = e;
    }
  }
  if (!ast) throw firstErr; // genuine parse failure under BOTH source types
  if (Date.now() - start > DEADLINE_MS) throw new CapExceededError("deadline", `per-file analysis deadline (${DEADLINE_MS}ms) exceeded`);
  let count = 0;
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
  /** `<script type="module">` — parsed module-first (findings 13/14), since a module inline script may use
   *  top-level `import`/`export`. */
  module: boolean;
}

/** Non-external `<script>…</script>` blocks (skips `<script src=…>`) — works identically whether the
 *  literal `<script>` tag lives in real HTML markup or inside a `.py`/`.js` template string, since this
 *  is a lexical regex over the raw file text, not an HTML parse. Captures the opening tag separately so a
 *  `type="module"` attribute can select module-first parsing. */
const SCRIPT_BLOCK_RE = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi;
const SCRIPT_MODULE_TYPE_RE = /\btype\s*=\s*["']?module\b/i;
function extractScriptBlocks(text: string): ScriptBlock[] {
  const blocks: ScriptBlock[] = [];
  SCRIPT_BLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SCRIPT_BLOCK_RE.exec(text))) {
    const offset = m.index + m[0].indexOf(m[2]);
    blocks.push({ code: m[2], offset, module: SCRIPT_MODULE_TYPE_RE.test(m[1]) });
  }
  return blocks;
}

function lineOf(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}

// ------------------------------------------------------------------------------------------------- //
// Declarative `<form>` write-back — form ownership, submitter overrides, JS-handler awareness
// ------------------------------------------------------------------------------------------------- //

/** Read one HTML attribute's value from a tag's attribute string, supporting the double-quoted,
 *  single-quoted, AND unquoted attribute grammars (`action=https://…` with no quotes was
 *  previously invisible, folding a genuinely-remote form action to `""` → a false LOST). Returns `null`
 *  when the attribute is absent, `""` for a present-but-empty value. */
function getAttr(attrs: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'\`<>]+))`, "i");
  const m = re.exec(attrs);
  if (!m) return null;
  return m[2] ?? m[3] ?? m[4] ?? "";
}

interface FormNode {
  id: string | null;
  method: string; // uppercased; default "GET"
  action: string; // raw attribute value; "" when absent (submits to the current page URL)
  hasInlineHandler: boolean; // `onsubmit=` on the form tag
  line: number;
  openStart: number;
  innerEnd: number; // index of the closing `</form>` (or EOF) — bounds enclosed controls
}

interface SubmitControl {
  formId: string | null; // `form="<id>"` association (a control OUTSIDE its owning form)
  formaction: string | null;
  formmethod: string | null; // uppercased
  index: number;
}

/** A JS submit-handling signal anywhere in the page — an explicit `submit` listener, an `onsubmit`
 *  assignment in script, or a `requestSubmit(` call. Presence means a native form's default submission MAY
 *  be intercepted (preventDefault + a real `resp.ok` check), so a relative POST form is DOWNGRADED from
 *  hard-LOST to SUSPECT — we cannot prove the handler is correct, but we also must not
 *  hard-fail a progressive-enhancement form as "no JS handler". */
const SUBMIT_LISTENER_RE = /addEventListener\s*\(\s*["']submit["']|\.onsubmit\s*=|\brequestSubmit\s*\(/i;

/** Model every native `<form>` and every submit control (`<button>`, `<input type=submit|image>`),
 *  resolve each control's EFFECTIVE action/method (`formaction`/`formmethod` override the owning form;
 *  `form="<id>"` links a control to a form it is not nested inside), and emit an `Outcome` per POST
 *  submission whose effective action is relative/local (findings 20/21/22). Both override directions are
 *  handled: a remote form with a relative-`formaction` submitter IS flagged; a relative form with a
 *  remote-`formaction` submitter is NOT (the actual submission goes remote). A relative POST submission is
 *  LOST when no JS submit handler is in evidence, else SUSPECT. */
function analyzeForms(text: string): Outcome[] {
  const forms: FormNode[] = [];
  const formOpenRe = /<form\b([^>]*)>/gi;
  let fm: RegExpExecArray | null;
  while ((fm = formOpenRe.exec(text))) {
    const attrs = fm[1];
    const openStart = fm.index;
    const innerStart = fm.index + fm[0].length;
    const closeIdx = text.toLowerCase().indexOf("</form>", innerStart);
    const innerEnd = closeIdx === -1 ? text.length : closeIdx;
    const methodRaw = getAttr(attrs, "method");
    forms.push({
      id: getAttr(attrs, "id"),
      method: (methodRaw ?? "GET").toUpperCase(),
      action: getAttr(attrs, "action") ?? "",
      hasInlineHandler: getAttr(attrs, "onsubmit") !== null,
      line: lineOf(text, openStart),
      openStart,
      innerEnd,
    });
  }

  // Submit controls: <button> (submit is the DEFAULT type — anything but type=button/reset submits) and
  // <input type=submit|image>.
  const controls: SubmitControl[] = [];
  const buttonRe = /<button\b([^>]*)>/gi;
  let bm: RegExpExecArray | null;
  while ((bm = buttonRe.exec(text))) {
    const attrs = bm[1];
    const type = (getAttr(attrs, "type") ?? "submit").toLowerCase();
    if (type === "button" || type === "reset") continue;
    const fmm = getAttr(attrs, "formmethod");
    controls.push({
      formId: getAttr(attrs, "form"),
      formaction: getAttr(attrs, "formaction"),
      formmethod: fmm === null ? null : fmm.toUpperCase(),
      index: bm.index,
    });
  }
  const inputRe = /<input\b([^>]*)>/gi;
  let im: RegExpExecArray | null;
  while ((im = inputRe.exec(text))) {
    const attrs = im[1];
    const type = (getAttr(attrs, "type") ?? "text").toLowerCase();
    if (type !== "submit" && type !== "image") continue;
    const fmm = getAttr(attrs, "formmethod");
    controls.push({
      formId: getAttr(attrs, "form"),
      formaction: getAttr(attrs, "formaction"),
      formmethod: fmm === null ? null : fmm.toUpperCase(),
      index: im.index,
    });
  }

  const owningForm = (c: SubmitControl): FormNode | undefined => {
    if (c.formId != null) return forms.find((f) => f.id === c.formId);
    return forms.find((f) => c.index >= f.openStart && c.index < f.innerEnd);
  };

  const pageHasSubmitHandler = SUBMIT_LISTENER_RE.test(text);
  const outcomes: Outcome[] = [];

  // Each form's set of effective submissions: one per owned submit control (its `formaction`/`formmethod`
  // override applied), or — when the form owns NO submit control — the form's own action/method (an
  // Enter-key / `requestSubmit()` submission still fires). Evaluating ONLY the controls when they exist is
  // what prevents the "relative form + remote formaction" false LOST: the actual submission uses the
  // submitter's remote `formaction`, so no relative submission is manufactured from the form default.
  for (const form of forms) {
    const owned = controls.filter((c) => owningForm(c) === form);
    const submissions =
      owned.length === 0
        ? [{ action: form.action, method: form.method }]
        : owned.map((c) => ({ action: c.formaction ?? form.action, method: c.formmethod ?? form.method }));

    for (const sub of submissions) {
      if (sub.method !== "POST") continue;
      const target = classifyUrl(sub.action);
      if (target === "remote") continue; // real remote egress — not this bug class
      const actionDisplay = sub.action === "" ? "(current page)" : sub.action;
      if (target === "unknown") {
        outcomes.push({
          kind: "suspect",
          line: form.line,
          reason: `native <form method=post> submits to an action ("${actionDisplay}") that could not be resolved to a concrete origin — cannot rule out a same-origin write-back lost under Cowork`,
        });
        continue;
      }
      if (form.hasInlineHandler || pageHasSubmitHandler) {
        outcomes.push({
          kind: "suspect",
          line: form.line,
          reason: `native <form method=post> to a relative/local-origin endpoint ("${actionDisplay}") has a JS submit handler in scope that may intercept the submission (preventDefault + a resp.ok check) — advisory: the native submission would still lose the write-back under Cowork if the handler does not fully take over`,
        });
        continue;
      }
      outcomes.push({
        kind: "lost",
        line: form.line,
        reason:
          `native <form method=post> submits to a relative/local-origin endpoint ("${actionDisplay}") with no JS handler — resp.ok can ` +
          "never be checked, so the browser's default navigate-to-response silently swallows Cowork's non-ok reply",
      });
    }
  }
  return outcomes;
}

// ------------------------------------------------------------------------------------------------- //
// AST: constant folding, guard-truthiness, and write-back call-site classification
// ------------------------------------------------------------------------------------------------- //

type ConstsMap = Map<string, acorn.Expression | null>;

/** Collect every Identifier bound by a function parameter pattern (`Identifier`, and the nested names of
 *  `Object`/`Array`/`Assignment`/`Rest` patterns). Used to detect a file-level const NAME that is ALSO a
 *  parameter somewhere — i.e. it can be shadowed at a call site. */
function collectPatternNames(pattern: acorn.Pattern, out: Set<string>): void {
  switch (pattern.type) {
    case "Identifier":
      out.add(pattern.name);
      break;
    case "ObjectPattern":
      for (const p of pattern.properties) {
        if (p.type === "RestElement") collectPatternNames(p.argument, out);
        else collectPatternNames(p.value, out);
      }
      break;
    case "ArrayPattern":
      for (const el of pattern.elements) if (el) collectPatternNames(el, out);
      break;
    case "AssignmentPattern":
      collectPatternNames(pattern.left, out);
      break;
    case "RestElement":
      collectPatternNames(pattern.argument, out);
      break;
  }
}

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
  const paramNames = new Set<string>();
  walk.simple(ast, {
    VariableDeclarator(n) {
      if (n.id.type === "Identifier" && n.init) {
        if (consts.has(n.id.name)) poisoned.add(n.id.name); // declared more than once
        consts.set(n.id.name, n.init as acorn.Expression);
      }
    },
    AssignmentExpression(n) {
      if (n.left.type === "Identifier") {
        poisoned.add(n.left.name); // reassigned after declaration
      } else if (n.left.type === "MemberExpression" && !n.left.computed && n.left.object.type === "Identifier") {
        // a property write (`cfg.enabled = true`) mutates the object binding — its folded
        // INITIALIZER is now stale. Poison the object name so a later `if (cfg.enabled)` guard reads as
        // UNKNOWN (→ suspect), never folds the stale `false` initializer to dead/clean.
        poisoned.add(n.left.object.name);
      } else if (n.left.type === "MemberExpression" && n.left.computed && n.left.object.type === "Identifier") {
        poisoned.add(n.left.object.name); // `cfg["enabled"] = true`
      }
    },
    UpdateExpression(n) {
      if (n.argument.type === "Identifier") {
        poisoned.add(n.argument.name); // x++/x--
      } else if (n.argument.type === "MemberExpression" && n.argument.object.type === "Identifier") {
        poisoned.add(n.argument.object.name); // `cfg.count++` mutates cfg
      }
    },
    UnaryExpression(n) {
      // `delete cfg.enabled` removes a property — the folded initializer is stale.
      if (n.operator === "delete" && n.argument.type === "MemberExpression" && n.argument.object.type === "Identifier") {
        poisoned.add(n.argument.object.name);
      }
    },
    FunctionDeclaration(n) {
      for (const p of n.params) collectPatternNames(p, paramNames);
    },
    FunctionExpression(n) {
      for (const p of n.params) collectPatternNames(p, paramNames);
    },
    ArrowFunctionExpression(n) {
      for (const p of n.params) collectPatternNames(p, paramNames);
    },
  });
  // Scope safety: a file-level const NAME that is also bound as a function parameter anywhere
  // can be SHADOWED at a call site — e.g. `const ENABLED=false; function save(ENABLED){ if(ENABLED) … }`.
  // The flat map cannot tell the top-level const from the parameter, so folding the const's value at the
  // shadowed call site would prove LIVE code dead (a deterministic false green). Poisoning any such
  // collision forces those identifiers to UNKNOWN (→ suspect), never dead. Conservative: it also downgrades
  // a legitimately-foldable top-level const that merely SHARES a name with an unrelated parameter to
  // suspect — a precision loss, never a false green.
  for (const name of paramNames) if (consts.has(name)) poisoned.add(name);
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
    // a spread (`fetch(u, {...opts})`) can carry ANY `method` — the options shape is not
    // statically readable, so the whole object is UNKNOWN. Falling through to the default `"GET"` (the old
    // behavior) directly contradicted this function's own contract ("a spread → UNKNOWN — never silently
    // assumed safe") and produced the same silent-clean false green as .
    if (p.type === "SpreadElement") return "UNKNOWN";
    if (p.type !== "Property") continue;
    const keyName = p.key.type === "Identifier" ? p.key.name : p.key.type === "Literal" ? String(p.key.value) : null;
    if (keyName === "method") {
      const folded = foldStr(p.value as acorn.Expression, consts);
      return (folded ?? "UNKNOWN").toUpperCase();
    }
  }
  return "GET";
}

/** Resolve the `url` FIELD (not a folded string — the raw expression node, so the caller folds it exactly
 *  the way every other primitive's `urlNode` is folded) from an axios "config object" argument —
 *  `axios({method:"POST", url:"/api/save", data})`, `axios.request({...})`. Same one-hop `consts`
 *  resolution `methodOf` uses for `method`, applied to the sibling `url` key. `undefined` (no options, not
 *  an object, no `url` key) means "nothing to fold" — the caller's `foldStr(undefined, …)` already returns
 *  `null`, which is treated as the existing documented false negative, not a failure. */
function urlNodeFromConfig(optsNode: acorn.Expression | null | undefined, consts: ConstsMap): acorn.Expression | undefined {
  if (!optsNode) return undefined;
  let o: acorn.AnyNode = optsNode;
  if (o.type === "Identifier" && consts.has(o.name)) {
    const resolved = consts.get(o.name);
    if (resolved) o = resolved;
  }
  if (o.type !== "ObjectExpression") return undefined;
  for (const p of o.properties) {
    if (p.type !== "Property") continue;
    const keyName = p.key.type === "Identifier" ? p.key.name : p.key.type === "Literal" ? String(p.key.value) : null;
    if (keyName === "url") return p.value as acorn.Expression;
  }
  return undefined;
}

const COMMIT_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

type UrlTarget = "relative" | "remote" | "unknown";

/** A fixed synthetic page origin to resolve relative/protocol-relative URLs against. The host
 *  (`cowork.local.invalid`) is a reserved-TLD sentinel that can never collide with a real remote host, so
 *  "resolved host === page host" reliably means "same-origin / relative". */
const PAGE_ORIGIN = "http://cowork.local.invalid/artifact/index.html";
const PAGE_HOST = "cowork.local.invalid";

/** True iff `host` (already lowercased, IPv6 brackets stripped) is a loopback/local host that Cowork
 *  serves the artifact from — `localhost`, the whole IPv4 loopback block `127.0.0.0/8`, `0.0.0.0`, and the
 *  IPv6 loopback `::1` (and its IPv4-mapped form). A HOSTNAME-EXACT test — the pre-fix
 *  `/^https?:\/\/(localhost|127\.|0\.0\.0\.0)/` prefix match classified `localhost.evil.com` and
 *  `127.attacker.example` as local. */
function isLoopbackHost(host: string): boolean {
  if (host === "localhost" || host === "0.0.0.0") return true;
  if (host === "::1" || host === "::ffff:127.0.0.1" || host === "0:0:0:0:0:0:0:1") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m) {
    const oct = [m[1], m[2], m[3], m[4]].map((s) => Number(s));
    if (oct.every((n) => n >= 0 && n <= 255) && oct[0] === 127) return true;
  }
  return false;
}

/** Classify a URL string by RESOLVING it with the WHATWG URL parser against a fixed page origin, then
 *  comparing NORMALIZED hostnames exactly (findings 18/19) — never by regex shape:
 *   - a relative path (`/api/save`, `save`, `?x`, `#f`), a protocol-relative URL that resolves to the page
 *     host, or an absolute `http(s)` URL whose host is the page host or a loopback host → `"relative"`
 *     (same-origin-local — IS the Cowork bug class);
 *   - any other resolved `http(s)` host (`localhost.evil.com`, `//example.com/save`, a leading-space
 *     absolute URL) → `"remote"` (real egress, not this bug class);
 *   - a non-`http(s)` scheme after resolution (`mailto:`, `data:`, `tel:`, `blob:`, `javascript:`) →
 *     `"remote"` — it does NOT resolve against Cowork's origin, so it is not a local write-back and must
 *     not be flagged as one;
 *   - `null` (a computed/unresolvable URL) or a string the URL parser rejects → `"unknown"` (a documented
 *     Tier A could-not-verify — the caller decides suspect vs. silent per context). */
function classifyUrl(url: string | null): UrlTarget {
  if (url == null) return "unknown"; // computed/unresolvable URL
  const trimmed = url.trim();
  let u: URL;
  try {
    u = new URL(trimmed, PAGE_ORIGIN);
  } catch {
    return "unknown";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "remote"; // mailto:/data:/tel:/blob:/…
  let host = u.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host === PAGE_HOST) return "relative"; // resolved same-origin (relative or protocol-relative-to-page)
  if (isLoopbackHost(host)) return "relative";
  return "remote";
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
  if (n.type === "MemberExpression") {
    const readName = staticPropName(n); // handles `obj.flag` AND `obj["flag"]`
    if (readName === null) return "unknown";
    let obj: acorn.AnyNode = n.object;
    if (obj.type === "Identifier" && consts.has(obj.name)) {
      const resolved = consts.get(obj.name);
      if (resolved) obj = resolved;
    }
    if (obj.type === "ObjectExpression") {
      for (const p of obj.properties) {
        if (p.type !== "Property") continue;
        const keyName = p.key.type === "Identifier" ? p.key.name : p.key.type === "Literal" ? String(p.key.value) : null;
        if (keyName === readName) return evalBool(p.value, consts, depth + 1);
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
const PERSIST_CLAIM_RE = /\b(saved|submitt\w*|persist\w*|complet\w*|success\w*|delet\w*|remov\w*)\b/i;
const LOOKAHEAD_WINDOW = 1500;

type Outcome =
  | { kind: "lost"; line: number; reason: string }
  | { kind: "suspect"; line: number; reason: string }
  | { kind: "dead" }
  | { kind: "remote" }
  | { kind: "unsupported-guard"; line: number; reason: string };

/** The property NAME of a member callee for BOTH the plain `obj.open` (non-computed Identifier) AND the
 *  literal computed `obj["open"]`/`xhr["open"]` spellings — a formatter/minifier that emits
 *  bracketed string property access was previously invisible to every AST arm (they all gated on
 *  `!computed && property.type === "Identifier"`). A NON-literal computed access (`obj[k]`) stays `null`
 *  (genuinely dynamic). */
function staticPropName(m: acorn.MemberExpression): string | null {
  if (!m.computed && m.property.type === "Identifier") return m.property.name;
  if (m.computed && m.property.type === "Literal" && typeof m.property.value === "string") return m.property.value;
  return null;
}

/** Statement-type test — the span used to bound consequence analysis to the write-back call's
 *  OWN statement/promise chain rather than a fixed 1500-char forward slice that could vacuum up an
 *  unrelated later request/comment/string. */
function isStatementNode(t: string): boolean {
  return t.endsWith("Statement") || t === "VariableDeclaration";
}

/** The nearest enclosing statement node of the call (innermost). `fetch(...).then(...)` lives inside one
 *  `ExpressionStatement`, so its whole promise chain is captured; an unrelated following statement is not. */
function enclosingStatement(ancestors: acorn.AnyNode[]): acorn.AnyNode | null {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (isStatementNode(ancestors[i].type)) return ancestors[i];
  }
  return null;
}

/** True iff the call's RESULT flows OUT of its own statement — assigned to a variable, returned, spread,
 *  stored in an object/array, or passed as an argument — so its response-handling happens through data
 *  flow this static pass does not trace. Such a call is treated as SUSPECT (unresolved flow),
 *  never hard-LOST, avoiding the "an unconventional but correct response variable looks lost" false
 *  positive. Being the OBJECT of a `.then(...)`/`.catch(...)` member chain is NOT an escape — that chain is
 *  part of the same statement and IS inspected. */
function resultEscapesStatement(ancestors: acorn.AnyNode[]): boolean {
  let idx = ancestors.length - 1; // the call node itself (visitor passes it last)
  let node: acorn.AnyNode = ancestors[idx];
  let parent = ancestors[idx - 1];
  // Unwrap transparent wrappers: `await fetch(...)` (AwaitExpression) and `fetch?.(...)` (an optional call
  // is wrapped in a ChainExpression by the parser) — the WRAPPER is not a use of the value, so look through
  // it to the real consuming context.
  while (parent && (parent.type === "AwaitExpression" || parent.type === "ChainExpression")) {
    node = parent;
    idx -= 1;
    parent = ancestors[idx - 1];
  }
  if (!parent) return false;
  switch (parent.type) {
    case "ExpressionStatement":
      return false;
    case "MemberExpression":
      // `call.then(...)` (promise chain) → object === node → not an escape; `x.call` where call is the
      // property side can't happen for a call node, so object !== node means the call is used as a computed
      // key / receiver elsewhere → escape.
      return (parent as acorn.MemberExpression).object !== node;
    default:
      return true;
  }
}

function classifyConsequence(params: {
  kind: string;
  method: string;
  url: string | null;
  line: number;
  okWindow: string;
  consWindow: string;
  escapes: boolean;
}): Outcome {
  const { kind, method, url, line, okWindow, consWindow, escapes } = params;
  const urlDisplay = url ?? "(unresolved)";
  const dl = DOWNLOAD_FALLBACK_RE.test(consWindow);
  const noResponseChannel = kind === "beacon"; // fire-and-forget: can never learn of a non-ok response
  const okChecked = OK_CHECK_RE.test(okWindow.split(".catch")[0] ?? okWindow);
  const persistClaim = PERSIST_CLAIM_RE.test(consWindow);

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
  if (escapes) {
    // The response flows out of the call's own statement (assigned/returned/passed); this static pass does
    // not trace it, so a persist-claim heuristic could false-positive. Treat as SUSPECT, not LOST.
    return {
      kind: "suspect",
      line,
      reason: `relative ${method} write-back to "${urlDisplay}" (${kind}) — its result is stored/returned and consumed by data flow this static analyzer does not trace, so response handling could not be confirmed; treated as advisory rather than silently clean or hard-lost`,
    };
  }
  if (persistClaim) {
    return {
      kind: "lost",
      line,
      reason: `relative ${method} write-back to "${urlDisplay}" (${kind}) claims success without checking resp.ok/status — under Cowork the request resolves against Cowork's own origin with a non-ok response, producing a false success claim (saved/deleted/removed/etc.)`,
    };
  }
  return {
    kind: "suspect",
    line,
    reason: `relative ${method} write-back to "${urlDisplay}" (${kind}) — response handling could not be confidently classified as safe; treated as advisory rather than silently clean`,
  };
}

/** Walk one parsed `<script>` block's AST for write-back call sites — `fetch` (bare identifier OR
 *  member-spelled on any receiver: `window.fetch(`/`self.fetch(`/…), an XHR `.open(method,url)` with a
 *  non-GET method, `sendBeacon` (bare identifier OR member-spelled), a one-level fetch-wrapper (its inner
 *  call recognized with the same bare/member rule as top-level `fetch`), an `axios`/`$`/`jQuery`
 *  `.post`/`.put`/`.patch`/`.delete`/`.postForm`/`.putForm`/`.patchForm` (classified normally, may be
 *  `lost` — `.delete` is INCLUDED here, unlike the any-receiver arm below, because the literal
 *  `axios`/`$`/`jQuery` identifier has no ambiguity the way an arbitrary receiver's `.delete(` does), a
 *  bare `axios({...})` call OR `axios.request({...})` — the config-object argument may be an inline
 *  object literal OR a hoisted identifier resolved one hop through `consts` (`method`/`url` folded out of
 *  it the same way a `fetch` options argument is) — or a `.post`/`.put`/`.patch` on any OTHER receiver
 *  (classified `suspect` only, never `lost` — see that arm's comment; `.delete` is deliberately excluded
 *  there, see the same comment) — and classifies each into an `Outcome`. `block.offset` + `fileText` are
 *  used only to map an AST `.start` back to a real 1-based source line via `lineOf`. Two gaps stay
 *  documented, out of scope here: axios's OWN alternate config-call shape, `$.ajax({...})`, is not
 *  recognized (a different config-key vocabulary than axios's `method`/`url`); and a `formaction`/
 *  `formmethod` attribute on a submit button/input, which overrides its enclosing `<form>`'s own
 *  `action`/`method` — `relativeFormPosts` reads only the `<form>` tag itself, so a
 *  `<form action="https://remote"><button formaction="/api/save">` (a relative override on an otherwise
 *  remote, out-of-scope form) is a real declarative write-back this analyzer currently misses. */
function analyzeScriptAst(ast: acorn.Node, block: ScriptBlock, fileText: string): Outcome[] {
  const consts = buildConstsMap(ast);

  // Pass 1: one-level fetch-wrapper helpers — `function f(url, ...) { ... fetch(url, {method:"POST"}) ... }`.
  // The inner fetch call is recognized identically to the main visitor below: a bare `fetch` identifier OR
  // a member-spelled call on any receiver (`window.fetch(...)`, `self.fetch(...)`, …) — a wrapper whose
  // body happens to spell it the member way must still be recognized as a wrapper.
  const wrappers = new Map<string, number>();
  walk.simple(ast, {
    FunctionDeclaration(fn) {
      if (!fn.id) return;
      walk.simple(fn.body, {
        CallExpression(c) {
          const isFetchCallee =
            (c.callee.type === "Identifier" && c.callee.name === "fetch") ||
            (c.callee.type === "MemberExpression" && staticPropName(c.callee) === "fetch");
          if (isFetchCallee && c.arguments[0]?.type === "Identifier") {
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
      // `propName` resolves BOTH `obj.open` and the literal computed `obj["open"]`/`xhr["open"]` spellings
      // — every member arm below keys off it instead of an inline `!computed && Identifier`
      // check, so a formatter/minifier's bracketed property access is no longer invisible.
      const propName = c.type === "MemberExpression" ? staticPropName(c) : null;
      const recvName = c.type === "MemberExpression" && c.object.type === "Identifier" ? c.object.name : null;
      let kind: string | null = null;
      let urlNode: acorn.Expression | undefined;
      let method = "GET";
      // Set only by the any-receiver `.post(` arm below: forces the final "live" classification to
      // `suspect` regardless of response-handling heuristics, never `lost` — see that arm's comment.
      let forceAdvisory = false;

      if ((c.type === "Identifier" && c.name === "fetch") || (c.type === "MemberExpression" && propName === "fetch")) {
        // Covers both the bare identifier call (`fetch(...)`) and a member-spelled call on any receiver
        // (`window.fetch(...)`, `globalThis.fetch(...)`, `self.fetch(...)`, or any other `<obj>.fetch(...)`,
        // including the computed `window["fetch"](...)`).
        kind = "fetch";
        urlNode = n.arguments[0] as acorn.Expression | undefined;
        method = methodOf(n.arguments[1] as acorn.Expression | undefined, consts);
      } else if (c.type === "Identifier" && wrappers.has(c.name)) {
        kind = "fetch-wrapper";
        urlNode = n.arguments[wrappers.get(c.name)!] as acorn.Expression | undefined;
        method = "POST";
      } else if (c.type === "MemberExpression" && propName === "open" && n.arguments.length >= 2) {
        const m = (foldStr(n.arguments[0] as acorn.Expression, consts) ?? "UNKNOWN").toUpperCase();
        if (m !== "GET") {
          // An XHR `.open(method, url)` whose method could not be folded is `"UNKNOWN"` — a recognized write
          // primitive with an unresolved method, surfaced as suspect below, never silent.
          kind = "xhr";
          urlNode = n.arguments[1] as acorn.Expression;
          method = m;
        }
      } else if ((c.type === "Identifier" && c.name === "sendBeacon") || (c.type === "MemberExpression" && propName === "sendBeacon")) {
        // Mirrors the fetch arm: a bare `sendBeacon(...)` alias or the member-spelled
        // `navigator.sendBeacon(...)` / `navigator["sendBeacon"](...)`.
        kind = "beacon";
        urlNode = n.arguments[0] as acorn.Expression | undefined;
        method = "POST";
      } else if (
        c.type === "MemberExpression" &&
        propName !== null &&
        ["post", "put", "patch", "delete", "postForm", "putForm", "patchForm"].includes(propName) &&
        recvName !== null &&
        ["axios", "$", "jQuery"].includes(recvName)
      ) {
        // `.post(`/`.put(`/`.patch(`/`.delete(` on the known axios/$/jQuery identifiers (including the
        // computed `axios["post"](...)`). `.delete(` is included HERE (unlike the any-receiver arm below)
        // because the LITERAL `axios`/`$`/`jQuery` receiver is unambiguous. Also covers axios v1's multipart
        // form-data verb aliases `.postForm(`/`.putForm(`/`.patchForm(` (the `Form` suffix is stripped
        // before uppercasing, so `postForm` → `POST`).
        kind = `lib-${propName}`;
        urlNode = n.arguments[0] as acorn.Expression | undefined;
        method = propName.replace(/Form$/, "").toUpperCase();
      } else if (
        ((c.type === "Identifier" && c.name === "axios") ||
          (c.type === "MemberExpression" && propName === "request" && recvName === "axios")) &&
        (n.arguments[0]?.type === "ObjectExpression" || n.arguments[0]?.type === "Identifier")
      ) {
        // A bare `axios({...})` call OR `axios.request({...})` — a "config object" shape where `method` AND
        // `url` are both fields on the single object argument (inline literal OR a hoisted identifier
        // resolved one hop through `consts`). A spread in the config → `methodOf` returns UNKNOWN (finding
        // surfaced as suspect below, never a silent GET.
        kind = "axios-config";
        method = methodOf(n.arguments[0] as acorn.Expression, consts);
        urlNode = urlNodeFromConfig(n.arguments[0] as acorn.Expression, consts);
      } else if (c.type === "MemberExpression" && propName !== null && ["post", "put", "patch"].includes(propName)) {
        // A `.post(`/`.put(`/`.patch(` call on a receiver OUTSIDE the known axios/$/jQuery set — dominantly
        // an axios INSTANCE (`const api = axios.create({}); api.put(...)`), lexically indistinguishable from
        // unrelated code with a same-named method (Express `app.post("/route", handler)`). NEVER escalates
        // to `lost` — only ever `suspect` (advisory) via `forceAdvisory`. `.delete(` is deliberately
        // EXCLUDED (a `Map`/`Set`/cache `.delete(key)` would be advisory noise).
        kind = `lib-${propName}-other-receiver`;
        urlNode = n.arguments[0] as acorn.Expression | undefined;
        method = propName.toUpperCase();
        forceAdvisory = true;
      }

      if (!kind) return; // not a recognized write primitive — ordinary code

      const line = lineOf(fileText, block.offset + n.start);

      // Guard first: a provably-dead call never fires, so it yields NO finding even if its URL/method are
      // unresolved; an unsupported guard is a could-not-verify regardless of URL/method.
      const status = guardStatusOf(ancestors, consts);
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

      // a recognized write primitive whose METHOD could not be resolved (`UNKNOWN` — a
      // computed method string, a spread options object) is a could-not-verify, NOT a silent return. A
      // method resolved to a NON-commit verb (a determined GET/HEAD) is a genuine read — silent, no finding.
      if (method === "UNKNOWN") {
        outcomes.push({
          kind: "suspect",
          line,
          reason: `a recognized write primitive (${kind}) has an HTTP method this static analyzer could not resolve (a computed method string or a spread options object) — cannot rule out a committing method lost under Cowork; treated as advisory rather than silently clean`,
        });
        return;
      }
      if (!COMMIT_METHODS.has(method)) return; // determined read (GET/HEAD/…) — not a write-back

      const url = foldStr(urlNode, consts);
      const target = classifyUrl(url);
      if (target === "remote") return; // real remote egress — not this bug class
      // a recognized COMMITTING write primitive whose URL could not be folded is a
      // could-not-verify, not a silent false negative. (A `forceAdvisory` any-receiver `.post(` with an
      // unresolved URL is likewise surfaced as suspect below via its own branch — kept advisory.)
      if (target === "unknown") {
        outcomes.push({
          kind: "suspect",
          line,
          reason: `a recognized ${method} write primitive (${kind}) targets a URL this static analyzer could not resolve to a concrete origin (a computed/runtime-constructed URL) — cannot rule out a same-origin write-back lost under Cowork; treated as advisory rather than silently clean`,
        });
        return;
      }

      // target === "relative": reachable, committing, same-origin-local.
      if (status === "unknown") {
        outcomes.push({
          kind: "suspect",
          line,
          reason: `relative ${method} write-back to "${url}" (${kind}) is behind a guard whose runtime value cannot be proven statically — cannot rule out it firing under Cowork's origin`,
        });
        return;
      }
      if (forceAdvisory) {
        outcomes.push({
          kind: "suspect",
          line,
          reason: `a "${method.toLowerCase()}(" call on a receiver outside the known axios/$/jQuery set targets a relative URL ("${url}") — likely the axios-instance write-back idiom (const api = axios.create(); api.${method.toLowerCase()}(...)), but the receiver is not provably a write-back client, so this is advisory rather than an error`,
        });
        return;
      }
      // bound consequence analysis to the call's OWN statement/promise chain instead of a fixed
      // 1500-char forward slice. `okWindow` (response-consulted detection) is the enclosing statement — a
      // `.then(r => r.ok)` chain is in-statement; an unrelated later `resp.ok` is not. `consWindow`
      // (download-fallback / persist-claim detection) extends a short, bounded tail past the statement to
      // catch a trailing success toast (`fetch(POST); alert("Saved")`) without vacuuming up distant code.
      const stmt = enclosingStatement(ancestors);
      const callStart = n.start;
      const stmtEnd = stmt ? stmt.end : n.end;
      const consEnd = Math.min(Math.max(stmtEnd, n.end) + 300, callStart + LOOKAHEAD_WINDOW);
      const okWindow = fileText.slice(block.offset + callStart, block.offset + stmtEnd);
      const consWindow = fileText.slice(block.offset + callStart, block.offset + consEnd);
      const escapes = resultEscapesStatement(ancestors);
      outcomes.push(classifyConsequence({ kind, method, url, line, okWindow, consWindow, escapes }));
    },
  });

  return outcomes;
}

// ------------------------------------------------------------------------------------------------- //
// Per-file core
// ------------------------------------------------------------------------------------------------- //

/** Analyze ONE already-read source file for the Cowork write-back bug class. Returns
 *  `{ findings, failure? }`:
 *   - `findings` — EVERY verdict in the file (`artifact-write-back-lost` error / `artifact-write-back-suspect`
 *     advisory) from its real, parseable script/form write-back(s), deduped and errors-first
 *     (one artifact can carry several distinct endpoints). Empty when there is nothing to report.
 *   - `failure` — an OPTIONAL could-not-verify record (`AnalysisFailure`, see the stage enum): a block that
 *     carries a write-back hint but could not be parsed/cap-analyzed, an `unsupported-guard`, or a candidate
 *     whose every isolated `<script>` block was unparseable so nothing could be analyzed. Surfaced ALONGSIDE
 *     any `findings` (fail-closed) except an `unsupported-guard`, which short-circuits to `{findings:[], failure}`.
 *   - `{findings:[]}` (no failure) — not a Tier A candidate (ordinary code), or a candidate whose parseable
 *     write-back(s) are all clean/dead — genuinely clean.
 *  A block that fails to PARSE with no write-back hint is treated as prose (a docstring/comment the lexical
 *  `<script>` regex mis-extracted) and DISCOUNTED — one phantom block never sinks a file the rest of the loop
 *  could adjudicate. But discounting a block is never enough on its own to reach a silent clean pass: a
 *  fail-closed backstop with two triggers covers it — (1) EVERY isolated block was discounted and no
 *  finding/form resulted (nothing was ever analyzed), or (2) at least one block parsed, but the file text
 *  OUTSIDE every extracted block's span (top-level code, an inline `on*=` handler, surrounding template
 *  markup) still carries a write-back hint the block loop never got to analyze — a parseable sibling must
 *  not vouch for that un-analyzed remainder. Either trigger yields a could-not-verify, never `{}`. */
export function analyzeArtifactFile(path: string, text: string): { findings: SkillFinding[]; failure?: AnalysisFailure } {
  const ext = extname(path).toLowerCase();
  if (!SOURCE_EXTS.has(ext)) return { findings: [] };

  if (Buffer.byteLength(text, "utf8") > BYTE_CAP) {
    return {
      findings: [],
      failure: { path, stage: "size", reason: `source is ${Buffer.byteLength(text, "utf8")} bytes, exceeds the ${BYTE_CAP} byte cap` },
    };
  }

  if (!isCandidate(ext, text)) return { findings: [] }; // ordinary code — not a candidate, not a failure

  const isHtmlLike = HTML_EXTS.has(ext);
  const preferModule = MODULE_EXTS.has(ext);

  // Declarative <form> write-backs — form ownership, submitter formaction/formmethod overrides, and
  // JS-handler awareness (findings 20/21/22). Evaluated independent of any <script> extraction, so a
  // pure-declarative HTML page (no <script> at all) still produces a verdict (§B2/§B3 test (h)).
  const outcomes: Outcome[] = analyzeForms(text);

  let blocks = extractScriptBlocks(text);
  if (blocks.length === 0) {
    if (!isHtmlLike && ext !== ".py") {
      // A plain JS-family file (no <script> wrapper needed — the file itself IS the script).
      blocks = [{ code: text, offset: 0, module: preferModule }];
    } else if (ext === ".py") {
      // Candidacy already confirmed browser + write-back markers are present in the raw text, but no
      // <script> block could be isolated from a Python source — the archetype (write-back string in a
      // template) needs that extraction to succeed; when it can't, this is a could-not-verify, never a
      // silent pass.
      return {
        findings: [],
        failure: {
          path,
          stage: "extract",
          reason: "candidate .py source has browser/write-back markers but no <script>…</script> block could be isolated for analysis",
        },
      };
    }
    // isHtmlLike with zero <script> blocks: fine — a pure-declarative candidate, handled via analyzeForms.
  }

  // Per-block analysis. A block that FAILS TO PARSE (a genuine acorn SyntaxError) is NOT automatically
  // fatal: if its body carries no write-back hint it is almost certainly a docstring/comment that merely
  // mentions `<script>...</script>` (SCRIPT_BLOCK_RE is lexical and can't tell prose from real markup), so
  // we DISCOUNT it — one phantom block can't sink a file whose real block(s) yielded a verdict. If a hint
  // IS present we could not rule out a lost write-back, so we record a could-not-verify surfaced ALONGSIDE
  // any finding (fail-closed). A CAP hit (node-limit/deadline) is thrown AFTER a successful parse (see
  // parseWithCaps) — the block is proven-valid JS, never prose — so it is ALWAYS recorded, hint or not.
  const blockFailures: AnalysisFailure[] = [];
  let parsedBlockCount = 0;
  let discountedBlockCount = 0;
  for (const block of blocks) {
    let ast: acorn.Node;
    try {
      ast = parseWithCaps(block.code, block.module || preferModule);
    } catch (e) {
      if (e instanceof CapExceededError) {
        blockFailures.push({ path, stage: e.stage, reason: e.message });
      } else if (BLOCK_WRITE_BACK_HINT_RE.test(block.code)) {
        blockFailures.push({ path, stage: "parse", reason: (e as Error).message });
      } else {
        discountedBlockCount++;
      }
      continue;
    }
    parsedBlockCount++;
    outcomes.push(...analyzeScriptAst(ast, block, text));
  }

  // A real, PARSED block using control flow the analyzer can't represent as a guard is a deliberate
  // could-not-verify and still short-circuits the whole file (unchanged from prior behavior), unlike the
  // parse-failure path above (which surfaces a failure ALONGSIDE any finding). Rationale for the
  // asymmetry: an unsupported guard means the analyzer cannot trust ANY of its own same-file
  // classifications — the un-modelable control flow (e.g. a switch case) may gate the very call sites it
  // already classified as clean/dead — so a single could-not-verify that forces exit 3 is the
  // conservative verdict, and surfacing a possibly-wrong finding beside it could misdirect a fix. Both
  // paths are fail-closed (exit 3 either way); this is a difference in what gets SURFACED, not a
  // false-clean hole.
  const unsupported = outcomes.find((o): o is Extract<Outcome, { kind: "unsupported-guard" }> => o.kind === "unsupported-guard");
  if (unsupported) {
    return { findings: [], failure: { path, stage: "unsupported-guard", reason: unsupported.reason } };
  }

  // surface EVERY lost/suspect write-back in the file as its own finding (one artifact can
  // carry several distinct endpoints/bugs), deduped by rule+line+message, ordered errors-first then by
  // line so the highest-severity finding leads. Previously only the first lost (or first live) was kept,
  // hiding independent bugs in the same generated artifact.
  const live = outcomes.filter((o): o is Extract<Outcome, { kind: "lost" | "suspect" }> => o.kind === "lost" || o.kind === "suspect");
  const findings: SkillFinding[] = [];
  const seenFindingKeys = new Set<string>();
  const ordered = [...live].sort((a, b) => {
    const sev = (a.kind === "lost" ? 0 : 1) - (b.kind === "lost" ? 0 : 1);
    return sev !== 0 ? sev : a.line - b.line;
  });
  for (const o of ordered) {
    const rule = o.kind === "lost" ? "artifact-write-back-lost" : "artifact-write-back-suspect";
    const key = `${rule}:${o.line}:${o.reason}`;
    if (seenFindingKeys.has(key)) continue;
    seenFindingKeys.add(key);
    findings.push(
      o.kind === "lost"
        ? { rule, severity: "error", path, line: o.line, message: o.reason }
        : { rule, severity: "advisory", path, line: o.line, message: o.reason },
    );
  }

  let failure: AnalysisFailure | undefined = blockFailures[0];
  if (failure && blockFailures.length > 1) {
    // More than one sibling block failed to parse/cap-out — don't silently drop the rest; note the count
    // in the surfaced reason so a reader knows this file has multiple unresolved blocks, not just one.
    failure = { ...failure, reason: `${failure.reason} (+${blockFailures.length - 1} more unparseable block(s))` };
  }
  // Fail-closed backstop, two triggers. Gate the whole block on `!failure` ONLY — NOT `!finding`. An
  // ADVISORY `suspect` finding gates NOTHING downstream (exit precedence in analyze-skill.ts: a strict
  // `error` ⇒ 1, any `analysisFailures` ⇒ 3, else 0), and an ERROR finding gates nothing downstream
  // EITHER unless `--strict` is passed — so neither finding severity may suppress an un-analyzed-remainder
  // could-not-verify; doing so would leave a real un-analyzed write-back surface silently unreported under
  // default (non-strict) invocation. `blockFailures[0]` already set means a could-not-verify was recorded,
  // so `!failure` is the correct guard. The `{finding, failure}` return shape is already produced by the
  // hint-block path, so a finding-plus-remainder-failure file is consistent.
  //
  //  (1) NOTHING parsed AND no finding (`parsedBlockCount === 0 && !finding`): every isolated block was
  //      discounted as unparseable prose-or-opaque-template — could-not-verify. Kept as its own
  //      unconditional trigger (NOT folded into the remainder test): candidacy here can come from a
  //      declarative <form method=post> with a REMOTE action (skipped by relativeFormPosts → no finding,
  //      and no BLOCK_WRITE_BACK_HINT_RE token anywhere in the text), so the remainder is hint-free — a
  //      remainder-only test would false-green exactly that shape.
  //  (2) The remainder scan runs in every OTHER case reached here (trigger (1) did not fire): whether
  //      because a block parsed (`parsedBlockCount > 0`), or because nothing parsed but a finding DID
  //      result (a relative `<form method=post>` with zero <script> blocks at all — that finding must not
  //      suppress checking the rest of the file for an independent, un-analyzed write-back). The
  //      un-analyzed REMAINDER — the file text minus every extracted block's code span — is tested for a
  //      write-back hint (top-level JS-file code, an inline on*= handler, template markup); the block loop
  //      never analyzes that surface, so neither a parseable sibling block nor an already-flagged form can
  //      vouch for it. A hint there is a could-not-verify, recorded ALONGSIDE any finding.
  if (!failure && discountedBlockCount > 0) {
    if (parsedBlockCount === 0 && findings.length === 0) {
      failure = {
        path,
        stage: "extract",
        reason:
          "candidate source has browser/write-back markers but every isolated <script>…</script> block was unparseable — no analyzable write-back could be confirmed",
      };
    } else {
      let remainder = "";
      let cursor = 0;
      for (const block of blocks) {
        remainder += text.slice(cursor, block.offset);
        cursor = block.offset + block.code.length;
      }
      remainder += text.slice(cursor);
      if (BLOCK_WRITE_BACK_HINT_RE.test(remainder)) {
        failure = {
          path,
          stage: "extract",
          reason:
            "a write-back outside every isolated <script>…</script> block (top-level code or an inline handler) was never analyzed while an unparseable block was discounted as prose — could not rule out a lost write-back",
        };
      }
    }
  }

  return { findings, failure }; // findings may be empty and failure undefined → genuinely clean
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
      // a WALK path already filters to regular files, but an explicitly NAMED file target
      // (`collectArtifactSources` file branch) does not — a named FIFO/socket/device would reach the
      // `readFileSync` below and could BLOCK indefinitely (a named pipe reports size 0, defeating the byte
      // cap, and the per-file deadline only covers the AST walk). Accept regular files only; anything else
      // is a could-not-verify, never a hang or a silent skip. (`statSync` follows a symlink to its target,
      // so a symlink-to-regular-file is still accepted.)
      if (!st.isFile()) {
        pushFailure({
          path: resolved,
          stage: "read",
          reason: "not a regular file (FIFO/socket/device or other non-regular file) — cannot be safely read for analysis",
        });
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

      const { findings: fileFindings, failure } = analyzeArtifactFile(resolved, text);
      if (failure) pushFailure({ ...failure, path: failure.path || resolved });
      for (const finding of fileFindings) findings.push(finding);
    }
  }

  return { findings, analysisFailures, scanned: [...seenFiles].sort() };
}
