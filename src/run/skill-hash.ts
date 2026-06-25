import { createHash } from "node:crypto";
import { readdirSync, statSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join, resolve, dirname, sep, relative } from "node:path";
import { gitModeEnabled, gitTrackedSet, gitAccept } from "./skill-files.js";

/**
 * Directory names excluded from the skill-content staleness hash — VCS / language caches that are NEVER
 * skill behavior. Deliberately does NOT include `tests`/`test`: a skill could legitimately ship behavioral
 * code under such a directory, and excluding it by name would let a real source change go undetected (a
 * silent false-negative — the worst outcome for a staleness gate). The self-invalidation bug (a recorded
 * cassette written under the hashed tree changing its own hash) is fixed by the `*.cassette.json` file
 * exclusion below, which carries no false-negative risk.
 */
export const SKILL_HASH_DIR_DENYLIST = new Set([".git", "node_modules", "__pycache__", ".pytest_cache", ".mypy_cache"]);

/** The plugin-local ignore file (F-6): gitignore-style globs the PLUGIN declares as non-runtime, co-located
 *  with the plugin so its hash boundary travels with it. Read per mount root; not itself hashed. */
export const HASH_IGNORE_FILE = ".cowork-hashignore";

/**
 * Compile one consumer-declared ignore glob into a RegExp tested against an entry's root-relative POSIX path
 * (file or directory). Supported subset (documented in docs/session.md): `*` = within-segment wildcard;
 * a double-star = cross-segment; a trailing slash is optional; a SLASH-FREE pattern (e.g. `tests`, `*.md`)
 * matches that name at ANY depth (gitignore-style); a pattern WITH a slash is anchored to the mount root
 * (`docs/api`), unless it begins with a leading globstar segment (any depth). Comments (`#`) and blank lines
 * compile to null.
 */
export function compileIgnore(raw: string): RegExp | null {
  let p = raw.trim();
  if (!p || p.startsWith("#")) return null;
  p = p.replace(/\/+$/, ""); // trailing slash optional (dir matches via subtree prune)
  if (!p) return null;
  const leadingGlobstar = p.startsWith("**/");
  if (leadingGlobstar) p = p.slice(3);
  // A leading slash means "anchored to the mount root" (like a leading / in .gitignore).
  // Strip it before further processing; the anchoring is encoded in the regex prefix below.
  const leadingSlash = p.startsWith("/") && !p.startsWith("/**/");
  if (leadingSlash) p = p.slice(1);
  if (!p) return null;
  // anchored: has an internal slash (e.g. docs/api) OR had a leading slash — both anchor to mount root.
  const anchored = (leadingSlash || p.includes("/")) && !leadingGlobstar;
  let body = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*" && p[i + 1] === "*") {
      body += ".*";
      i++;
    } else if (c === "*") {
      body += "[^/]*";
    } else if (".+^${}()|[]\\?".includes(c)) {
      // `?` is NOT a supported wildcard here (only `*`/`**`), so escape it to a literal — unescaped it would
      // act as the regex optional-quantifier and over-match (e.g. `a?b` would match `ab`).
      body += "\\" + c;
    } else {
      body += c;
    }
  }
  return new RegExp(`${anchored ? "^" : "^(?:.*/)?"}${body}(?:/.*)?$`);
}

function readHashIgnore(root: string): string[] {
  try {
    return readFileSync(join(root, HASH_IGNORE_FILE), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return []; // no plugin-local ignore file
  }
}

/** Hash a directory's structure + file CONTENTS recursively (sorted) — stable across machines. The hash
 *  folds in each entry's RELATIVE path (not just its basename) plus a type marker, so a file MOVING within
 *  the tree (`a/x.json` → `a/sub/x.json`, same content) changes the hash. Skips VCS/cache dirs and any
 *  recorded cassette (`*.cassette.json` — output, not skill source). */
/** Optional per-entry filter (F-6 scoping). Receives a root-relative path; returns false to EXCLUDE that
 *  file or directory subtree from the hash. Absent ⇒ include everything (byte-identical to the legacy hash). */
type AcceptFn = (relPath: string) => boolean;

/** uses lstatSync (does NOT follow symlinks) so an in-tree symlink can't silently include
 *  out-of-tree content. Symlinks to directories are skipped with a warning; symlinks to files are
 *  skipped with a warning (same policy as collectArtifacts in execute.ts).
 * push any read error into `errors` rather than silently continuing — the caller treats a
 *  non-empty errors array as a staleness failure (can't verify ⇒ not green). */
/** Optional per-file sink (H9 diagnostics): called for every file FOLDED INTO the hash, with its
 *  root-relative path and the sha256 of exactly the content that was hashed (version-stripped for
 *  plugin.json, raw bytes otherwise). Lets `explainSkillHash` dump the file set the hash sees — so an
 *  unexpected drift source (a `.DS_Store`, a run-generated file) is one line instead of a black-box hunt. */
type OnFileFn = (relPath: string, hashedSha: string) => void;

function hashDir(
  dir: string,
  hash: ReturnType<typeof createHash>,
  errors: string[],
  rel = "",
  accept?: AcceptFn,
  onFile?: OnFileFn,
  root = dir,
): void {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch (e) {
    const msg = `cowork-harness: skill-hash: cannot read directory ${dir}: ${String((e as Error)?.message ?? e)}`;
    process.stderr.write(`${msg} — skipping\n`);
    errors.push(msg);
    return;
  }
  for (const name of entries) {
    const abs = join(dir, name);
    const relPath = rel ? `${rel}/${name}` : name;
    let st;
    try {
      // lstatSync does NOT follow symlinks — so a symlinked entry is detected as a symlink,
      // not as the file/dir it points to. This prevents following out-of-tree symlinks.
      st = lstatSync(abs);
    } catch (e) {
      const msg = `cowork-harness: skill-hash: cannot stat ${abs}: ${String((e as Error)?.message ?? e)}`;
      process.stderr.write(`${msg} — skipping\n`);
      errors.push(msg);
      continue;
    }
    // S5 (v6): an IN-TREE symlink (target resolves inside the skill root) is hashed by its TARGET STRING —
    // NOT followed (no out-of-tree content) — so a re-point is detected while the target file's own content
    // is hashed separately. An ESCAPING symlink (target outside the root) is skipped + warned (as before:
    // a symlink can otherwise pull in out-of-tree content). Emitted via onFile too, so contentSig/manifest
    // (entries-based) stay identical to skillHash.
    if (st.isSymbolicLink()) {
      if (accept && !accept(relPath)) continue;
      let target: string;
      try {
        target = readlinkSync(abs);
      } catch {
        process.stderr.write(`cowork-harness: skill-hash: skipping unreadable symlink ${abs}\n`);
        continue;
      }
      const resolvedTarget = resolve(dirname(abs), target);
      const rootResolved = resolve(root);
      const inTree = resolvedTarget === rootResolved || resolvedTarget.startsWith(rootResolved + sep);
      if (!inTree) {
        process.stderr.write(`cowork-harness: skill-hash: skipping escaping symlink ${abs} -> ${target} (not followed)\n`);
        continue;
      }
      const targetRel = relative(rootResolved, resolvedTarget).split(sep).join("/");
      hash.update(`L:${relPath} -> ${targetRel}\n`); // link structure; a re-point changes the digest
      if (onFile) onFile(relPath, `lnk:${targetRel}`);
      continue;
    }
    if (st.isDirectory()) {
      if (SKILL_HASH_DIR_DENYLIST.has(name)) continue; // skip VCS/cache subtrees entirely
      if (accept && !accept(relPath)) continue; // F-6: scoped out (an unlisted skill's subtree)
      hash.update(`D:${relPath}\n`); // structure marker — an empty/renamed dir registers too
      hashDir(abs, hash, errors, relPath, accept, onFile, root);
    } else if (st.isFile()) {
      if (name.endsWith(".cassette.json")) continue; // a recorded cassette is output, not skill source
      if (relPath === HASH_IGNORE_FILE) continue; // the ignore file is harness metadata, not skill source
      // H9: OS-junk (.DS_Store / Thumbs.db / desktop.ini / …) is OS metadata the OS rewrites out-of-band (a
      // .DS_Store touch by Finder must NOT re-stale a cassette). Excluded under the same rationale as the dir
      // denylist (.git/node_modules) — provably-non-behavioral content the mount still delivers. Cassette
      // version bumped so existing cassettes get a graceful "older format — re-record once" (not "changed").
      if (OS_JUNK_PATTERN.test(relPath)) continue;
      if (accept && !accept(relPath)) continue; // F-6: scoped/ignored out
      hash.update(`F:${relPath}\n`); // relative path, not basename — a move changes the digest
      let bytes: Buffer;
      try {
        bytes = readFileSync(abs);
      } catch (e) {
        // propagate read errors — a temporarily unreadable file would otherwise produce a
        // stale-but-clean hash that silently passes the staleness gate. Push to errors so the caller
        // treats this as "can't verify ⇒ not green".
        const msg = `cowork-harness: skill-hash: cannot read file ${abs}: ${String((e as Error)?.message ?? e)}`;
        process.stderr.write(`${msg} — skipping\n`);
        errors.push(msg);
        continue;
      }
      // F-6: hash the plugin MANIFEST without its `version` — a pure version bump is metadata with no
      // runtime-behavior impact, yet it would otherwise re-stale every cassette (it flapped 4/6 in a batch).
      // Every behavior-bearing field (mcpServers, hooks, dependencies, …) still counts. Falls back to raw
      // bytes if the manifest isn't valid JSON. `hashedContent` is EXACTLY what folds into the digest — the
      // onFile sink reports its sha so the debug dump reflects what the hash actually saw.
      let hashedContent: Buffer | string = bytes;
      if (relPath.endsWith(".claude-plugin/plugin.json") || relPath === "plugin.json") {
        try {
          const manifest = JSON.parse(bytes.toString("utf8"));
          delete manifest.version;
          hashedContent = JSON.stringify(manifest);
        } catch {
          /* not valid JSON — fall through to raw-byte hashing */
        }
      }
      hash.update(hashedContent);
      if (onFile) onFile(relPath, createHash("sha256").update(hashedContent).digest("hex"));
    }
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The immediate subdir names of `<root>/skills` (the per-skill dirs of a plugin-root). */
function skillDirNames(root: string): string[] {
  try {
    return readdirSync(join(root, "skills")).filter((n) => isDir(join(root, "skills", n)));
  } catch {
    return [];
  }
}

/** Opt-in (default OFF): treat `agents/<skillname>.md` as that skill's PRIVATE input rather than a fleet-wide
 *  shared root, so editing one skill's sub-agent contract re-stales only that skill's cassettes. Only takes
 *  effect for `skills:`-scoped scenarios (it refines that scope). Sets a fingerprint `agentScope` marker so a
 *  record/verify env mismatch is an honest "re-record under the same mode" (mirrors COWORK_HARNESS_GITSET). */
function agentScopeEnabled(): boolean {
  return process.env.COWORK_HARNESS_AGENT_SCOPE === "skill";
}

/** Map the first path segment under `agents/` to the skill name it would belong to: a FILE strips its
 *  extension (`agents/cap-table.md` → `cap-table`), a DIR is used as-is (`agents/cap-table/x.md` → `cap-table`).
 *  Returns null for non-`agents/` paths or a bare `agents` marker. Exported so staleness attribution can
 *  classify a changed `agents/<name>.md` exactly as the hash walk does (agent-scoped → skill-private). */
export function agentSkillName(parts: string[]): string | null {
  if (parts[0] !== "agents" || parts.length < 2) return null;
  return parts.length === 2 ? parts[1].replace(/\.[^.]+$/, "") : parts[1];
}

/** Accept function for shared-root-only hashing: include everything EXCEPT `skills/<name>/` subtrees. With
 *  agent scoping ON, a skill-named `agents/<n>` also LEAVES the shared bucket (it's attributed to the skill in
 *  the main walk), so a change there is named "skill changed", not "shared root changed". */
function sharedOnlyAccept(dirSkills: Set<string>, scopeAgents: boolean): AcceptFn {
  return (relPath) => {
    const parts = relPath.split("/");
    if (parts[0] === "skills") return parts.length === 1; // keep the `skills` marker dir; exclude subtrees
    if (scopeAgents) {
      const an = agentSkillName(parts);
      if (an !== null && dirSkills.has(an)) return false; // skill-named agent → not shared
    }
    return true; // shared content + plugin root files
  };
}

/**
 * Hash ONLY the shared-root content (everything outside `skills/`) of plugin-roots in `dirs`.
 * Returns `null` when none of the dirs have a top-level `skills/` layout (individual-skill mounts,
 * marketplaces) — in that case there's no shared/skill split to report.
 * Used by `checkStaleness` to name the changed bucket in scoped cassettes (G-4).
 */
export function hashSharedOnly(dirs: string[], sessionIgnore?: string[]): string | null {
  const sorted = [...dirs].sort();
  const pluginRoots = sorted.filter((d) => isDir(join(d, "skills")));
  if (pluginRoots.length === 0) return null;
  const scopeAgents = agentScopeEnabled();
  const hash = createHash("sha256");
  for (const d of pluginRoots) {
    // Per-root skill names so a skill-named agent under THIS root leaves THIS root's shared bucket.
    const accept = sharedOnlyAccept(scopeAgents ? new Set(skillDirNames(d)) : new Set(), scopeAgents);
    const ignoreRes = [...readHashIgnore(d), ...(sessionIgnore ?? [])].map(compileIgnore).filter((re): re is RegExp => re !== null);
    const combinedAccept: AcceptFn = ignoreRes.length ? (rel) => accept(rel) && !ignoreRes.some((re) => re.test(rel)) : accept;
    const errors: string[] = [];
    hashDir(d, hash, errors, "", combinedAccept);
    // hashSharedOnly is used only for bucket-level diagnostics; errors are already logged to stderr.
    // The primary staleness check goes through hashSkillDirs which surfaces errors to callers.
  }
  return hash.digest("hex");
}

/** F-6 structural accept: under a plugin-root, include everything NOT under `skills/`, plus only the
 *  `skills/<name>` subtrees whose name is in `keep`. This hashes the plugin's shared roots (agents/, scripts/,
 *  references/, plugin.json, …) PLUS the named skills — so editing one skill re-stales only its cassettes,
 *  while a shared-dependency change still re-stales everything (no false-fresh). */
function scopedAccept(keep: Set<string>, dirSkills: Set<string>, scopeAgents: boolean): AcceptFn {
  return (relPath) => {
    const parts = relPath.split("/");
    if (parts[0] === "skills") {
      if (parts.length === 1) return true; // the `skills` dir marker itself
      return keep.has(parts[1]); // skills/<name>/… — only the kept skills
    }
    // Agent scoping (opt-in): a skill-named `agents/<n>` is private to skill <n> — hash it only when <n> is
    // kept; a NON-skill-named agent (generic/shared) stays fleet-wide. OFF by default → the old whole-shared rule.
    if (scopeAgents) {
      const an = agentSkillName(parts);
      if (an !== null && dirSkills.has(an)) return keep.has(an);
    }
    return true; // shared content (incl. non-skill-named agents)
  };
}

/** Content fingerprint over `dirs` — UNIFIED (v6) onto the SAME walk as `skillHash`: it derives from
 *  `skillHashEntries`, so it covers the EXACT same file set (OS-junk excluded, F-6 scope, `.cowork-hashignore`,
 *  git-tracked mode, in-tree-symlink policy) instead of the old separate walk that followed symlinks and
 *  ignored scope/ignore. SHA-256 over globally-sorted `relpath:content-sha256` pairs. Returns `undefined`
 *  for an empty/all-missing set. (Used by `rehash` to detect content change across a *format-only* hash bump;
 *  this v6 unification is an algorithm change, so a pre-v6 cassette's contentSig is non-comparable — `rehash`
 *  routes those to a re-record, see cassette.ts.) */
export function computeContentSig(dirs: string[], scopeSkills?: string[], sessionIgnore?: string[]): string | undefined {
  if (dirs.length === 0) return undefined;
  const entries = skillHashEntries(dirs, scopeSkills, sessionIgnore).map((e) => `${e.path}:${e.sha}`);
  if (entries.length === 0) return undefined;
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

/** H9 diagnostics: OS-junk / non-runtime files that have no business in a skill hash but (today) ARE hashed
 *  if present in scope — the classic cause of "stale immediately after record" on macOS (`.DS_Store` is
 *  rewritten by Finder). Used to flag entries in the debug dump and to nudge `.cowork-hashignore`. */
export const OS_JUNK_PATTERN = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|\.AppleDouble|__MACOSX)$/;

/** H9 diagnostics: the per-file entries the skill hash currently folds in — same walk/scope/ignore as
 *  `hashSkillDirs`, but emitting `{ path, sha }` instead of one digest. Sorted by path. Lets a caller dump
 *  exactly what the hash sees so an unexpected drift source is visible at a glance. */
export function skillHashEntries(dirs: string[], scopeSkills?: string[], sessionIgnore?: string[]): { path: string; sha: string }[] {
  const entries: { path: string; sha: string }[] = [];
  hashSkillDirs(dirs, scopeSkills, sessionIgnore, (path, sha) => entries.push({ path, sha }));
  // Code-unit sort (NOT localeCompare) so the dump order matches the hash walk's own `readdirSync().sort()`.
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export interface HashSkillDirsResult {
  /** The sha256 hex digest. */
  hash: string;
  /** true when `scopeSkills` was given and every named skill was found under a plugin-root (scope applied);
   *  false when the whole-tree fallback was used (scope not applied). */
  scoped: boolean;
  /** When `scoped` is false and `scopeSkills` was provided, the skill names that were absent from every
   *  plugin-root and caused the fallback. */
  missedSkills?: string[];
  /** non-empty when any file or directory was unreadable during hashing. The caller MUST treat
   *  this as a staleness failure (can't verify ⇒ not green) — a hash computed over partial data is
   *  unreliable. */
  readErrors?: string[];
  /** Phase C: which boundary the hash used. "git" = git-tracked set (COWORK_HARNESS_GITSET=1 AND every dir
   *  was a usable repo); "raw" = the legacy filesystem walk (default, or any non-repo dir). Recorded in the
   *  fingerprint so a mode change between record and verify is itself detectable. */
  mode: "git" | "raw";
  /** Opt-in agent scoping was applied (COWORK_HARNESS_AGENT_SCOPE=skill AND this hash was skill-scoped).
   *  Recorded in the fingerprint so a record/verify env mismatch is detectable, like `mode`. */
  agentScoped: boolean;
}

/**
 * Hash a set of skill/plugin source dirs into one sha256 hex digest (sorted for determinism).
 *
 * F-6: when `scopeSkills` is non-empty, scope the hash to those skills under each PLUGIN-ROOT (a mounted dir
 * with a top-level `skills/`): hash the plugin's shared roots plus only the named `skills/<name>` dirs.
 * DEFAULT (no `scopeSkills`) = whole tree, byte-identical to the legacy hash. Fail-closed: if there is no
 * plugin-root, or any named skill is absent from every plugin-root (a typo/rename), hash the WHOLE tree —
 * narrowing the gate on a bad name would be a silent staleness false-negative. Individual-skill mounts and
 * marketplaces (no top-level `skills/`) always hash whole (the structural rule degenerates safely).
 *
 * Returns a {@link HashSkillDirsResult} with the digest and a `scoped` diagnostic so callers can detect
 * the whole-tree fallback (e.g. log a warning when a named skill was not found).
 * also returns `readErrors` when any input was unreadable — callers must treat this as a
 * staleness failure.
 */
export function hashSkillDirs(dirs: string[], scopeSkills?: string[], sessionIgnore?: string[], onFile?: OnFileFn): HashSkillDirsResult {
  const hash = createHash("sha256");
  const sorted = [...dirs].sort();
  // Resolve F-6 skill scoping fail-closed: only narrow to `keep` when every named skill exists under some
  // plugin-root; otherwise `keep` stays null → whole-tree (a typo can't silently narrow the gate).
  let keep: Set<string> | null = null;
  let missedSkills: string[] | undefined;
  if (scopeSkills && scopeSkills.length) {
    const pluginRoots = sorted.filter((d) => isDir(join(d, "skills")));
    const available = new Set<string>();
    for (const d of pluginRoots) for (const n of skillDirNames(d)) available.add(n);
    if (pluginRoots.length && scopeSkills.every((s) => available.has(s))) {
      keep = new Set(scopeSkills);
    } else if (scopeSkills.length) {
      missedSkills = scopeSkills.filter((s) => !available.has(s));
    }
  }
  const allErrors: string[] = [];
  // Phase C (gated): when COWORK_HARNESS_GITSET=1, restrict each dir's files to the git-tracked set. A dir
  // that isn't a usable repo falls back to raw for THAT dir; mode is "git" only if EVERY dir resolved via git.
  const gitOn = gitModeEnabled();
  const scopeAgents = agentScopeEnabled();
  let allGit = gitOn && sorted.length > 0;
  for (const d of sorted) {
    // Consumer-declared ignore for THIS root = the plugin-local .cowork-hashignore + the session-level globs.
    const ignoreRes = [...readHashIgnore(d), ...(sessionIgnore ?? [])].map(compileIgnore).filter((re): re is RegExp => re !== null);
    // Per-root skill names so a skill-named agent under THIS root scopes to THIS root's skill.
    const dirSkills = keep && scopeAgents ? new Set(skillDirNames(d)) : new Set<string>();
    const scopeFn = keep && isDir(join(d, "skills")) ? scopedAccept(keep, dirSkills, scopeAgents) : undefined;
    const tracked = gitOn ? gitTrackedSet(d) : null;
    if (gitOn && tracked === null) allGit = false; // this dir isn't a repo → raw for it → not pure git mode
    const gitFn = tracked ? gitAccept(tracked) : null; // admits tracked files + their ancestor dirs
    // No scope + no ignore + no git filter → undefined accept → byte-identical to the legacy whole-tree hash.
    const accept =
      scopeFn || ignoreRes.length || gitFn
        ? (rel: string) => (scopeFn ? scopeFn(rel) : true) && !ignoreRes.some((re) => re.test(rel)) && (gitFn ? gitFn(rel) : true)
        : undefined;
    hashDir(d, hash, allErrors, "", accept, onFile);
  }
  const scoped = keep !== null;
  // Agent scoping is applied only when env-on AND the hash was skill-scoped (it refines `skills:` scoping).
  // Like `mode`, this is recorded even if no skill-named agent happens to exist, so flipping the env is an
  // honest "re-record under the same mode" rather than a silent hash change.
  const agentScoped = scopeAgents && scoped;
  const readErrors = allErrors.length > 0 ? allErrors : undefined;
  const mode: "git" | "raw" = allGit ? "git" : "raw";
  return scoped
    ? { hash: hash.digest("hex"), scoped: true, mode, agentScoped, ...(readErrors ? { readErrors } : {}) }
    : {
        hash: hash.digest("hex"),
        scoped: false,
        mode,
        agentScoped,
        ...(missedSkills ? { missedSkills } : {}),
        ...(readErrors ? { readErrors } : {}),
      };
}
