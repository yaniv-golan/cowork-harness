import { createHash } from "node:crypto";
import { readdirSync, statSync, readFileSync } from "node:fs";
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
  // A leading slash means "anchored to the mount root" (like a leading / in .gitignore).
  // Strip it before further processing; the anchoring is encoded in the regex prefix below.
  const leadingSlash = p.startsWith("/") && !p.startsWith("/**/");
  if (leadingSlash) p = p.slice(1);
  if (!p) return null;
  const leadingGlobstar = p.startsWith("**/");
  if (leadingGlobstar) p = p.slice(3);
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

function hashDir(dir: string, hash: ReturnType<typeof createHash>, rel = "", accept?: AcceptFn): void {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const name of entries) {
    const abs = join(dir, name);
    const relPath = rel ? `${rel}/${name}` : name;
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (SKILL_HASH_DIR_DENYLIST.has(name)) continue; // skip VCS/cache subtrees entirely
      if (accept && !accept(relPath)) continue; // F-6: scoped out (an unlisted skill's subtree)
      hash.update(`D:${relPath}\n`); // structure marker — an empty/renamed dir registers too
      hashDir(abs, hash, relPath, accept);
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
      } catch {
        /* unreadable file — skip content */
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

/**
 * Hash a set of skill/plugin source dirs into one sha256 hex digest (sorted for determinism).
 *
 * F-6: when `scopeSkills` is non-empty, scope the hash to those skills under each PLUGIN-ROOT (a mounted dir
 * with a top-level `skills/`): hash the plugin's shared roots plus only the named `skills/<name>` dirs.
 * DEFAULT (no `scopeSkills`) = whole tree, byte-identical to the legacy hash. Fail-closed: if there is no
 * plugin-root, or any named skill is absent from every plugin-root (a typo/rename), hash the WHOLE tree —
 * narrowing the gate on a bad name would be a silent staleness false-negative. Individual-skill mounts and
 * marketplaces (no top-level `skills/`) always hash whole (the structural rule degenerates safely).
 */
export function hashSkillDirs(dirs: string[], scopeSkills?: string[], sessionIgnore?: string[]): string {
  const hash = createHash("sha256");
  const sorted = [...dirs].sort();
  // Resolve F-6 skill scoping fail-closed: only narrow to `keep` when every named skill exists under some
  // plugin-root; otherwise `keep` stays null → whole-tree (a typo can't silently narrow the gate).
  let keep: Set<string> | null = null;
  if (scopeSkills && scopeSkills.length) {
    const pluginRoots = sorted.filter((d) => isDir(join(d, "skills")));
    const available = new Set<string>();
    for (const d of pluginRoots) for (const n of skillDirNames(d)) available.add(n);
    if (pluginRoots.length && scopeSkills.every((s) => available.has(s))) keep = new Set(scopeSkills);
  }
  for (const d of sorted) {
    // Consumer-declared ignore for THIS root = the plugin-local .cowork-hashignore + the session-level globs.
    const ignoreRes = [...readHashIgnore(d), ...(sessionIgnore ?? [])].map(compileIgnore).filter((re): re is RegExp => re !== null);
    const scopeFn = keep && isDir(join(d, "skills")) ? scopedAccept(keep) : undefined;
    // No scope + no ignore → undefined accept → byte-identical to the legacy whole-tree hash.
    const accept =
      scopeFn || ignoreRes.length ? (rel: string) => (scopeFn ? scopeFn(rel) : true) && !ignoreRes.some((re) => re.test(rel)) : undefined;
    hashDir(d, hash, "", accept);
  }
  return hash.digest("hex");
}
