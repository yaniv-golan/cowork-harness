import { createHash } from "node:crypto";
import { jcsSerialize, JcsCanonicalizationError } from "./jcs.js";

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
const SKILL_HASH_DIR_DENYLIST = new Set([".git", "node_modules", "__pycache__", ".pytest_cache", ".mypy_cache"]);

/** The plugin-local ignore file: gitignore-style globs the PLUGIN declares as non-runtime, co-located
 *  with the plugin so its hash boundary travels with it. Read per mount root; not itself hashed. */
const HASH_IGNORE_FILE = ".cowork-hashignore";

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
  if (p.startsWith("/**/")) p = p.slice(1); // normalize /**/foo -> **/foo
  const leadingGlobstar = p.startsWith("**/");
  if (leadingGlobstar) p = p.slice(3);
  // A leading slash means "anchored to the mount root" (like a leading / in .gitignore).
  // Strip it before further processing; the anchoring is encoded in the regex prefix below.
  const leadingSlash = p.startsWith("/");
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
/** Optional per-entry filter (scoping). Receives a root-relative path; returns false to EXCLUDE that
 *  file or directory subtree from the hash. Absent ⇒ include everything. */
type AcceptFn = (relPath: string, isDirectory: boolean) => boolean;

/** uses lstatSync (does NOT follow symlinks) so an in-tree symlink can't silently include
 *  out-of-tree content. Symlinks to directories are skipped with a warning; symlinks to files are
 *  skipped with a warning (same policy as collectArtifacts in execute.ts).
 * push any read error into `errors` rather than silently continuing — the caller treats a
 *  non-empty errors array as a staleness failure (can't verify ⇒ not green). */
/** What KIND of file this is, for the manifest carve-out. Deliberately NOT a transform id: the entry
 *  records what the file IS and the transform decides what to do with it. */
export type ManifestKind = "none" | "claude-manifest" | "root-manifest";

/** One entry the hash walk folded, in a form that can reproduce EVERY rendering from a single walk.
 *  `rootOrdinal` is the index of the source root in the sorted root list — required because `skillHash`
 *  is ROOT-MAJOR while the wire manifest is globally path-sorted, and duplicate root-relative paths
 *  across roots are legal. Without it a flat list cannot reconstruct the digest's traversal order. */
export type HashEntry =
  | { kind: "file"; rootOrdinal: number; path: string; sha: string; manifestKind: ManifestKind }
  | { kind: "link"; rootOrdinal: number; path: string; target: string }
  | { kind: "dir"; rootOrdinal: number; path: string };

/** Sink for the walk. Emitted for files, links AND directories — directories fold a `D:` structure
 *  marker into `skillHash`, so a snapshot without them cannot detect empty-directory drift. */
/** Which manifest spelling this path is, if any. */
export function classifyManifest(relPath: string): ManifestKind {
  if (relPath.endsWith(".claude-plugin/plugin.json")) return "claude-manifest";
  if (relPath === "plugin.json") return "root-manifest";
  return "none";
}

/**
 * The `jcs1` manifest transform — how every skill digest hashes a plugin manifest.
 *
 * Same semantic projection (drop `version`), canonical serialization instead of insertion-order
 * `JSON.stringify`. Two failure modes that must NOT be conflated:
 *   - unparseable JSON  → raw bytes. Deterministic and re-derivable from the file, so
 *     it needs no stored marker.
 *   - parseable but not canonicalizable (a non-finite number) → THROWS. Never falls back to raw bytes: a
 *     parseable manifest still has a `version` field, and raw hashing would silently restore it.
 */
export function jcs1HashedContent(bytes: Buffer, manifestKind: ManifestKind): Buffer | string {
  if (manifestKind === "none") return bytes;
  let manifest: unknown;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    return bytes; // not JSON — raw bytes
  }
  if (manifest && typeof manifest === "object" && !Array.isArray(manifest)) delete (manifest as Record<string, unknown>).version;
  return jcsSerialize(manifest); // may throw JcsCanonicalizationError — the caller turns that into a read error
}

/** Fold a snapshot into a digest. The byte stream is IDENTICAL to the streaming walk it replaced —
 *  `D:`/`L:`/`F:` framing in walk order, folding the fixed-length content sha. */
export function foldSnapshot(entries: HashEntry[]): string {
  const hash = createHash("sha256");
  for (const e of entries) {
    if (e.kind === "dir") hash.update(`D:${e.path}\0`);
    else if (e.kind === "link") hash.update(`L:${e.path}\0${e.target}\0`);
    else {
      hash.update(`F:${e.path}\0`);
      hash.update(e.sha);
    }
  }
  return hash.digest("hex");
}

type WalkEntry = HashEntry extends infer T ? (T extends HashEntry ? Omit<T, "rootOrdinal"> : never) : never;
type OnEntryFn = (entry: WalkEntry) => void;

/** `exact` (only `hashHostTree`, for `plugins.from_host`) hashes every byte a copy delivers: no name is skipped, a file's
 *  raw bytes and its executable bit are folded (no manifest transform), and an escaping symlink is an error rather
 *  than a skip. Every other caller passes nothing and is unchanged. */
function hashDir(dir: string, errors: string[], rel = "", accept?: AcceptFn, onEntry?: OnEntryFn, root = dir, exact = false): void {
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
    // (v6): an IN-TREE symlink (target resolves inside the skill root) is hashed by its TARGET STRING —
    // NOT followed (no out-of-tree content) — so a re-point is detected while the target file's own content
    // is hashed separately. An ESCAPING symlink (target outside the root) is skipped + warned (as before:
    // a symlink can otherwise pull in out-of-tree content). Emitted via onFile too, so contentSig/manifest
    // (entries-based) stay identical to skillHash.
    if (st.isSymbolicLink()) {
      if (accept && !accept(relPath, false)) continue;
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
      if (!inTree && exact) {
        errors.push(`symlink ${relPath} points outside the tree (${target})`);
        continue;
      }
      if (!inTree) {
        process.stderr.write(`cowork-harness: skill-hash: skipping escaping symlink ${abs} -> ${target} (not followed)\n`);
        continue;
      }
      const targetRel = relative(rootResolved, resolvedTarget).split(sep).join("/");
      // NUL-separates path from target (not ` -> `): otherwise `a`->`b -> c` and `a -> b`->`c` collide.
      if (onEntry) onEntry({ kind: "link", path: relPath, target: targetRel });
      continue;
    }
    if (st.isDirectory()) {
      if (!exact && (SKILL_HASH_DIR_DENYLIST.has(name) || OS_JUNK_PATTERN.test(relPath))) continue; // skip VCS/cache and OS-junk subtrees entirely
      if (accept && !accept(relPath, true)) continue; // scoped out (an unlisted skill's subtree)
      if (onEntry) onEntry({ kind: "dir", path: relPath }); // `D:` structure marker — an empty/renamed dir registers // the digest has always folded these; the SNAPSHOT now sees them too
      hashDir(abs, errors, relPath, accept, onEntry, root, exact);
    } else if (st.isFile()) {
      if (!exact && name.endsWith(".cassette.json")) continue; // a recorded cassette is output, not skill source
      if (!exact && relPath === HASH_IGNORE_FILE) continue; // the ignore file is harness metadata, not skill source
      // OS-junk (.DS_Store / Thumbs.db / desktop.ini / …) is OS metadata the OS rewrites out-of-band (a
      // .DS_Store touch by Finder must NOT re-stale a cassette). Excluded under the same rationale as the dir
      // denylist (.git/node_modules) — provably-non-behavioral content the mount still delivers. Cassette
      // version bumped so existing cassettes get a graceful "older format — re-record once" (not "changed").
      if (!exact && OS_JUNK_PATTERN.test(relPath)) continue;
      if (accept && !accept(relPath, false)) continue; // scoped/ignored out
      // NOTE: the digest is not folded here — `foldSnapshot` folds the emitted entries.
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
      // hash the plugin MANIFEST without its `version` — a pure version bump is metadata with no
      // runtime-behavior impact, yet it would otherwise re-stale every cassette (it flapped 4/6 in a batch).
      // Every behavior-bearing field (mcpServers, hooks, dependencies, …) still counts. Falls back to raw
      // bytes if the manifest isn't valid JSON. `hashedContent` is EXACTLY what folds into the digest — the
      // onFile sink reports its sha so the debug dump reflects what the hash actually saw.
      if (exact) {
        const mode = (st.mode & 0o111) !== 0 ? "x\0" : "-\0";
        if (onEntry)
          onEntry({
            kind: "file",
            path: relPath,
            sha: createHash("sha256").update(mode).update(bytes).digest("hex"),
            manifestKind: "none",
          });
        continue;
      }
      const manifestKind = classifyManifest(relPath);
      let jcs1Sha: string;
      try {
        jcs1Sha = createHash("sha256").update(jcs1HashedContent(bytes, manifestKind)).digest("hex");
      } catch (e) {
        // Parseable but not canonicalizable. A read error, NEVER a raw-byte fallback — see jcs1HashedContent.
        const msg =
          e instanceof JcsCanonicalizationError
            ? `cowork-harness: skill-hash: cannot canonicalize ${abs}: ${e.message}`
            : `cowork-harness: skill-hash: ${String((e as Error)?.message ?? e)} (${abs})`;
        process.stderr.write(`${msg} — skipping\n`);
        errors.push(msg);
        continue;
      }
      // The entry carries the fixed-length content SHA, NOT raw content: raw bytes have no
      // length/terminator, so `F:a\0<A>F:b\0<B>` would collide with a single file `a` whose content is
      // `<A>F:b\0<B>` (a staleness false-negative). A 64-hex sha is self-delimiting and its charset is
      // disjoint from the `F:`/`L:`/`D:` prefixes, closing the unframed-concatenation hole.
      if (onEntry) onEntry({ kind: "file", path: relPath, sha: jcs1Sha, manifestKind });
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
export function agentSkillName(parts: string[], isDirectory = false): string | null {
  if (parts[0] !== "agents" || parts.length < 2) return null;
  return parts.length === 2 && !isDirectory ? parts[1].replace(/\.[^.]+$/, "") : parts[1];
}

/** Accept function for shared-root-only hashing: include everything EXCEPT `skills/<name>/` subtrees. With
 *  agent scoping ON, a skill-named `agents/<n>` also LEAVES the shared bucket (it's attributed to the skill in
 *  the main walk), so a change there is named "skill changed", not "shared root changed". */
function sharedOnlyAccept(dirSkills: Set<string>, scopeAgents: boolean): AcceptFn {
  return (relPath, isDirectory) => {
    const parts = relPath.split("/");
    if (parts[0] === "skills") return parts.length === 1; // keep the `skills` marker dir; exclude subtrees
    if (scopeAgents) {
      const an = agentSkillName(parts, isDirectory);
      if (an !== null && dirSkills.has(an)) return false; // skill-named agent → not shared
    }
    return true; // shared content + plugin root files
  };
}

/**
 * Hash ONLY the shared-root content (everything outside `skills/`) of plugin-roots in `dirs`.
 * Returns `null` when none of the dirs have a top-level `skills/` layout (individual-skill mounts,
 * marketplaces) — in that case there's no shared/skill split to report.
 * Used by `checkStaleness` to name the changed bucket in scoped cassettes.
 */
export function hashSharedOnly(dirs: string[], sessionIgnore?: string[]): string | null {
  const sorted = [...dirs].sort();
  const pluginRoots = sorted.filter((d) => isDir(join(d, "skills")));
  if (pluginRoots.length === 0) return null;
  const scopeAgents = agentScopeEnabled();
  const snapshot: HashEntry[] = [];
  for (const [rootOrdinal, d] of pluginRoots.entries()) {
    // Per-root skill names so a skill-named agent under THIS root leaves THIS root's shared bucket.
    const accept = sharedOnlyAccept(scopeAgents ? new Set(skillDirNames(d)) : new Set(), scopeAgents);
    const ignoreRes = [...readHashIgnore(d), ...(sessionIgnore ?? [])].map(compileIgnore).filter((re): re is RegExp => re !== null);
    const combinedAccept: AcceptFn = ignoreRes.length
      ? (rel, isDir) => accept(rel, isDir) && !ignoreRes.some((re) => re.test(rel))
      : accept;
    const errors: string[] = [];
    hashDir(d, errors, "", combinedAccept, (e) => snapshot.push({ ...e, rootOrdinal } as HashEntry));
    // hashSharedOnly is used only for bucket-level diagnostics; errors are already logged to stderr.
    // The primary staleness check goes through hashSkillDirs which surfaces errors to callers.
  }
  return foldSnapshot(snapshot);
}

/** Structural accept: under a plugin-root, include everything NOT under `skills/`, plus only the
 *  `skills/<name>` subtrees whose name is in `keep`. This hashes the plugin's shared roots (agents/, scripts/,
 *  references/, plugin.json, …) PLUS the named skills — so editing one skill re-stales only its cassettes,
 *  while a shared-dependency change still re-stales everything (no false-fresh). */
function scopedAccept(keep: Set<string>, dirSkills: Set<string>, scopeAgents: boolean): AcceptFn {
  return (relPath, isDirectory) => {
    const parts = relPath.split("/");
    if (parts[0] === "skills") {
      if (parts.length === 1) return true; // the `skills` dir marker itself
      return keep.has(parts[1]); // skills/<name>/… — only the kept skills
    }
    // Agent scoping (opt-in): a skill-named `agents/<n>` is private to skill <n> — hash it only when <n> is
    // kept; a NON-skill-named agent (generic/shared) stays fleet-wide. OFF by default → the old whole-shared rule.
    if (scopeAgents) {
      const an = agentSkillName(parts, isDirectory);
      if (an !== null && dirSkills.has(an)) return keep.has(an);
    }
    return true; // shared content (incl. non-skill-named agents)
  };
}

/** Content fingerprint over `dirs` — UNIFIED (v6) onto the SAME walk as `skillHash`: it derives from
 *  `skillHashEntries`, so it covers the EXACT same file set (OS-junk excluded, scope, `.cowork-hashignore`,
 *  git-tracked mode, in-tree-symlink policy) instead of the old separate walk that followed symlinks and
 *  ignored scope/ignore. SHA-256 over globally-sorted `relpath:content-sha256` pairs. Returns `undefined`
 *  for an empty/all-missing set. */
export function contentSigFromSnapshot(snapshot: HashEntry[]): string | undefined {
  // Same rendering `computeContentSig` uses, but from an ALREADY-WALKED snapshot.
  const entries = snapshot
    .map((e) => (e.kind === "dir" ? `D:${e.path}\0` : e.kind === "link" ? `L:${e.path}\0lnk:${e.target}` : `F:${e.path}\0${e.sha}`))
    .sort();
  if (entries.length === 0) return undefined;
  return createHash("sha256").update(entries.join("\0")).digest("hex");
}

export function computeContentSig(dirs: string[], scopeSkills?: string[], sessionIgnore?: string[]): string | undefined {
  if (dirs.length === 0) return undefined;
  // Type-prefix + NUL-separate path from sha: without them, a file named `a:lnk` with content-sha
  // `<64hex>` collides with a symlink `a` -> target `<64hex>` (both `a:lnk:<64hex>`). `e.sha` starts with
  // `lnk:` only for links (a 64-hex file sha cannot — l/n/k/: are non-hex), so it disambiguates the kind.
  // v5 (CONTENTSIG_ALGO): DIRECTORY entries fold too. `skillHash` has always folded a `D:` structure
  // marker, so without them `contentSig` was blind to an added/removed EMPTY directory — it called itself
  // a content fingerprint while missing a change the primary digest caught. Encoding mirrors the walk's
  // framing exactly: `D:<path>\0`, `F:<path>\0<sha>`, `L:<path>\0lnk:<target>`, globally sorted by the
  // rendered string so kind participates in the order and duplicate paths across roots stay distinct.
  return contentSigFromSnapshot(skillHashSnapshot(dirs, scopeSkills, sessionIgnore));
}

/** Diagnostics: OS-junk / non-runtime files that have no business in a skill hash but (today) ARE hashed
 *  if present in scope — the classic cause of "stale immediately after record" on macOS (`.DS_Store` is
 *  rewritten by Finder). Used to flag entries in the debug dump and to nudge `.cowork-hashignore`. */
export const OS_JUNK_PATTERN = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|\.AppleDouble|__MACOSX)$/;

/** Diagnostics: the per-file entries the skill hash currently folds in — same walk/scope/ignore as
 *  `hashSkillDirs`, but emitting `{ path, sha }` instead of one digest. Sorted by path. Lets a caller dump
 *  exactly what the hash sees so an unexpected drift source is visible at a glance. */
export function skillHashSnapshot(dirs: string[], scopeSkills?: string[], sessionIgnore?: string[]): HashEntry[] {
  return hashSkillDirs(dirs, scopeSkills, sessionIgnore).snapshot; // WALK order — what reproduces `skillHash`
}

/** Render a snapshot to the wire manifest shape (`fileSigs`). Files carry their hashed-content sha;
 *  links carry `lnk:<target>`; **directories are dropped** — the wire manifest has never listed them,
 *  and adding them would break the index-aligned migration proof and a covered wire surface.
 *
 *  NOTE: `contentSig` does NOT share this rendering. It folds `D:` markers itself (CONTENTSIG_ALGO 5) via
 *  `contentSigFromSnapshot`. Do not add directories here "to keep contentSig in sync" — they are separate
 *  renderings of the same snapshot, deliberately. */
export function renderWireEntries(snapshot: HashEntry[]): { path: string; sha: string }[] {
  const out: { path: string; sha: string }[] = [];
  for (const e of snapshot) {
    // The same sha `skillHash` folds: the per-file manifest exists to name WHICH file drifted.
    if (e.kind === "file") out.push({ path: e.path, sha: e.sha });
    else if (e.kind === "link") out.push({ path: e.path, sha: `lnk:${e.target}` });
  }
  // Code-unit sort (NOT localeCompare) so the dump order matches the hash walk's own `readdirSync().sort()`.
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function skillHashEntries(dirs: string[], scopeSkills?: string[], sessionIgnore?: string[]): { path: string; sha: string }[] {
  return renderWireEntries(skillHashSnapshot(dirs, scopeSkills, sessionIgnore));
}

export interface HashSkillDirsResult {
  /** The sha256 hex digest. */
  hash: string;
  /** Every entry the walk folded, in WALK order, each carrying its content sha. Returned rather
   *  than streamed through a sink so there is exactly one source of truth: a sink that forgot to stamp
   *  `rootOrdinal` silently produced a snapshot that could not reproduce the digest. */
  snapshot: HashEntry[];
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
  /** Which boundary the hash used. "git" = git-tracked set — the DEFAULT (unless COWORK_HARNESS_GITSET=0)
   *  AND every dir was a usable git work tree; "raw" = the filesystem walk, used when GITSET=0 OR any dir
   *  is not a repo. Recorded in the fingerprint so a mode change between record and verify is detectable. */
  mode: "git" | "raw";
  /** Opt-in agent scoping was applied (COWORK_HARNESS_AGENT_SCOPE=skill AND this hash was skill-scoped).
   *  Recorded in the fingerprint so a record/verify env mismatch is detectable, like `mode`. */
  agentScoped: boolean;
}

/**
 * Hash a set of skill/plugin source dirs into one sha256 hex digest (sorted for determinism).
 *
 * When `scopeSkills` is non-empty, scope the hash to those skills under each PLUGIN-ROOT (a mounted dir
 * with a top-level `skills/`): hash the plugin's shared roots plus only the named `skills/<name>` dirs.
 * DEFAULT (no `scopeSkills`) = whole tree. Fail-closed: if there is no
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
  // ONE walk builds the snapshot; the digest is folded FROM it.
  const snapshot: HashEntry[] = [];
  const sorted = [...dirs].sort();
  // Resolve skill scoping fail-closed: only narrow to `keep` when every named skill exists under some
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
  // Gated: when COWORK_HARNESS_GITSET=1, restrict each dir's files to the git-tracked set. A dir
  // that isn't a usable repo falls back to raw for THAT dir; mode is "git" only if EVERY dir resolved via git.
  const gitOn = gitModeEnabled();
  const scopeAgents = agentScopeEnabled();
  let allGit = gitOn && sorted.length > 0;
  for (const [rootOrdinal, d] of sorted.entries()) {
    // Consumer-declared ignore for THIS root = the plugin-local .cowork-hashignore + the session-level globs.
    const ignoreRes = [...readHashIgnore(d), ...(sessionIgnore ?? [])].map(compileIgnore).filter((re): re is RegExp => re !== null);
    // Per-root skill names so a skill-named agent under THIS root scopes to THIS root's skill.
    const dirSkills = keep && scopeAgents ? new Set(skillDirNames(d)) : new Set<string>();
    const scopeFn = keep && isDir(join(d, "skills")) ? scopedAccept(keep, dirSkills, scopeAgents) : undefined;
    const tracked = gitOn ? gitTrackedSet(d) : null;
    if (gitOn && tracked === null) allGit = false; // this dir isn't a repo → raw for it → not pure git mode
    const gitFn = tracked ? gitAccept(tracked) : null; // admits tracked files + their ancestor dirs
    // No scope + no ignore + no git filter → undefined accept → the whole tree.
    const accept =
      scopeFn || ignoreRes.length || gitFn
        ? (rel: string, isDir: boolean) =>
            (scopeFn ? scopeFn(rel, isDir) : true) && !ignoreRes.some((re) => re.test(rel)) && (gitFn ? gitFn(rel) : true)
        : undefined;
    // Stamp the root index here rather than threading it through hashDir's recursion: `skillHash` is
    // root-major, so an entry's root is the only thing a flat list cannot otherwise recover.
    hashDir(d, allErrors, "", accept, (e) => snapshot.push({ ...e, rootOrdinal } as HashEntry));
  }
  const scoped = keep !== null;
  // Agent scoping is applied only when env-on AND the hash was skill-scoped (it refines `skills:` scoping).
  // Like `mode`, this is recorded even if no skill-named agent happens to exist, so flipping the env is an
  // honest "re-record under the same mode" rather than a silent hash change.
  const agentScoped = scopeAgents && scoped;
  const readErrors = allErrors.length > 0 ? allErrors : undefined;
  const mode: "git" | "raw" = allGit ? "git" : "raw";
  const hash = { digest: (_enc?: string) => foldSnapshot(snapshot) };
  return scoped
    ? { hash: hash.digest("hex"), snapshot, scoped: true, mode, agentScoped, ...(readErrors ? { readErrors } : {}) }
    : {
        hash: hash.digest("hex"),
        snapshot,
        scoped: false,
        mode,
        agentScoped,
        ...(missedSkills ? { missedSkills } : {}),
        ...(readErrors ? { readErrors } : {}),
      };
}

/** The digest of a `plugins.from_host` input as staged: every file (raw bytes and executable bit), every directory
 *  and every in-tree symlink, in sorted path order. `errors` holds what could not be read and any symlink that
 *  points outside the tree; the caller refuses on either. */
export function hashHostTree(dir: string, skipNames?: ReadonlySet<string>): { sha256: string; errors: string[] } {
  const errors: string[] = [];
  const snapshot: HashEntry[] = [];
  // `skipNames` lets a caller hash a host source as its copy would be: the names the copy filter drops.
  const accept: AcceptFn | undefined = skipNames ? (rel) => !skipNames.has(rel.slice(rel.lastIndexOf("/") + 1)) : undefined;
  hashDir(dir, errors, "", accept, (e) => snapshot.push({ ...e, rootOrdinal: 0 } as HashEntry), dir, true);
  return { sha256: foldSnapshot(snapshot), errors };
}
