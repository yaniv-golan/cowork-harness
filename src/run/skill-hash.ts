import { createHash } from "node:crypto";
import { readdirSync, statSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
function hashDir(dir: string, hash: ReturnType<typeof createHash>, errors: string[], rel = "", accept?: AcceptFn): void {
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
    // skip symlinks explicitly (both to files and directories) — a symlink can escape the
    // skill dir tree. Model: collectArtifacts in execute.ts uses lstatSync + skip for the same reason.
    if (st.isSymbolicLink()) {
      process.stderr.write(`cowork-harness: skill-hash: skipping symlink ${abs} (not followed)\n`);
      continue;
    }
    if (st.isDirectory()) {
      if (SKILL_HASH_DIR_DENYLIST.has(name)) continue; // skip VCS/cache subtrees entirely
      if (accept && !accept(relPath)) continue; // F-6: scoped out (an unlisted skill's subtree)
      hash.update(`D:${relPath}\n`); // structure marker — an empty/renamed dir registers too
      hashDir(abs, hash, errors, relPath, accept);
    } else if (st.isFile()) {
      if (name.endsWith(".cassette.json")) continue; // a recorded cassette is output, not skill source
      if (relPath === HASH_IGNORE_FILE) continue; // the ignore file is harness metadata, not skill source
      if (accept && !accept(relPath)) continue; // F-6: scoped/ignored out
      hash.update(`F:${relPath}\n`); // relative path, not basename — a move changes the digest
      // F-6: hash the plugin MANIFEST without its `version` — a pure version bump is metadata with no
      // runtime-behavior impact, yet it would otherwise re-stale every cassette (it flapped 4/6 in a batch).
      // Every behavior-bearing field (mcpServers, hooks, dependencies, …) still counts. Falls back to raw
      // bytes if the manifest isn't valid JSON.
      if (relPath.endsWith(".claude-plugin/plugin.json") || relPath === "plugin.json") {
        try {
          const manifest = JSON.parse(readFileSync(abs, "utf8"));
          delete manifest.version;
          hash.update(JSON.stringify(manifest));
          continue;
        } catch {
          /* not valid JSON — fall through to raw-byte hashing */
        }
      }
      try {
        hash.update(readFileSync(abs));
      } catch (e) {
        // propagate read errors — a temporarily unreadable file would otherwise produce a
        // stale-but-clean hash that silently passes the staleness gate. Push to errors so the caller
        // treats this as "can't verify ⇒ not green".
        const msg = `cowork-harness: skill-hash: cannot read file ${abs}: ${String((e as Error)?.message ?? e)}`;
        process.stderr.write(`${msg} — skipping\n`);
        errors.push(msg);
      }
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

/** Accept function for shared-root-only hashing: include everything EXCEPT `skills/<name>/` subtrees.
 *  Used by `hashSharedOnly` to isolate the shared-root contribution for bucket-level diagnostics. */
function sharedOnlyAccept(): AcceptFn {
  return (relPath) => {
    const parts = relPath.split("/");
    if (parts[0] !== "skills") return true; // shared content + plugin root files
    if (parts.length === 1) return true; // the `skills` dir marker itself
    return false; // exclude ALL skills/<name>/… subtrees
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
  const accept = sharedOnlyAccept();
  const hash = createHash("sha256");
  for (const d of pluginRoots) {
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
function scopedAccept(keep: Set<string>): AcceptFn {
  return (relPath) => {
    const parts = relPath.split("/");
    if (parts[0] !== "skills") return true; // shared content
    if (parts.length === 1) return true; // the `skills` dir marker itself
    return keep.has(parts[1]); // skills/<name>/… — only the kept skills
  };
}

/** Algorithm-independent content fingerprint over `dirs`.
 *  SHA-256 over globally-sorted `"dirN/relpath:content-sha256"` entries for every regular file
 *  in every dir, using the same VCS/cache exclusions as `hashDir` but NO hashIgnore rules
 *  (those are staleness-algorithm-specific and change between CASSETTE_VERSIONs).
 *  Does NOT strip plugin.json version — hashes raw file bytes.
 *  Each dir is prefixed by its 0-based sort index (dir0, dir1, …) to prevent collisions
 *  between dirs that share the same basename (e.g. two plugins both named `skills`).
 *  Returns `undefined` for an empty or all-missing dirs list. */
export function computeContentSig(dirs: string[]): string | undefined {
  if (dirs.length === 0) return undefined;
  const entries: string[] = [];

  function walkForSig(dir: string, prefix: string, rel: string): void {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return; // unreadable dir → treat as empty
    }
    for (const name of names) {
      const abs = join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      const fullRelPath = `${prefix}/${relPath}`;
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (SKILL_HASH_DIR_DENYLIST.has(name)) continue;
        walkForSig(abs, prefix, relPath);
      } else if (st.isFile()) {
        if (name.endsWith(".cassette.json")) continue;
        if (name === HASH_IGNORE_FILE) continue;
        let content: Buffer;
        try {
          content = readFileSync(abs);
        } catch {
          continue;
        }
        const sha = createHash("sha256").update(content).digest("hex");
        entries.push(`${fullRelPath}:${sha}`);
      }
    }
  }

  // Sort dirs for determinism, then prefix by index to prevent basename collisions
  // (two dirs with the same basename — e.g. both named `skills` — would otherwise alias).
  const sorted = [...dirs].sort();
  for (let i = 0; i < sorted.length; i++) {
    walkForSig(sorted[i], `dir${i}`, "");
  }

  if (entries.length === 0) return undefined;
  entries.sort(); // global sort across all dirs
  return createHash("sha256").update(entries.join("\n")).digest("hex");
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
export function hashSkillDirs(dirs: string[], scopeSkills?: string[], sessionIgnore?: string[]): HashSkillDirsResult {
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
  for (const d of sorted) {
    // Consumer-declared ignore for THIS root = the plugin-local .cowork-hashignore + the session-level globs.
    const ignoreRes = [...readHashIgnore(d), ...(sessionIgnore ?? [])].map(compileIgnore).filter((re): re is RegExp => re !== null);
    const scopeFn = keep && isDir(join(d, "skills")) ? scopedAccept(keep) : undefined;
    // No scope + no ignore → undefined accept → byte-identical to the legacy whole-tree hash.
    const accept =
      scopeFn || ignoreRes.length ? (rel: string) => (scopeFn ? scopeFn(rel) : true) && !ignoreRes.some((re) => re.test(rel)) : undefined;
    hashDir(d, hash, allErrors, "", accept);
  }
  const scoped = keep !== null;
  const readErrors = allErrors.length > 0 ? allErrors : undefined;
  return scoped
    ? { hash: hash.digest("hex"), scoped: true, ...(readErrors ? { readErrors } : {}) }
    : { hash: hash.digest("hex"), scoped: false, ...(missedSkills ? { missedSkills } : {}), ...(readErrors ? { readErrors } : {}) };
}
