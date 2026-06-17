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

/** Hash a directory's structure + file CONTENTS recursively (sorted) — stable across machines. The hash
 *  folds in each entry's RELATIVE path (not just its basename) plus a type marker, so a file MOVING within
 *  the tree (`a/x.json` → `a/sub/x.json`, same content) changes the hash. Skips VCS/cache dirs and any
 *  recorded cassette (`*.cassette.json` — output, not skill source). */
function hashDir(dir: string, hash: ReturnType<typeof createHash>, rel = ""): void {
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
      hash.update(`D:${relPath}\n`); // structure marker — an empty/renamed dir registers too
      hashDir(abs, hash, relPath);
    } else if (st.isFile()) {
      if (name.endsWith(".cassette.json")) continue; // a recorded cassette is output, not skill source
      hash.update(`F:${relPath}\n`); // relative path, not basename — a move changes the digest
      try {
        hash.update(readFileSync(abs));
      } catch {
        /* unreadable file — skip content */
      }
    }
  }
}

/** Hash a set of skill/plugin source dirs into one sha256 hex digest (sorted for determinism). */
export function hashSkillDirs(dirs: string[]): string {
  const hash = createHash("sha256");
  for (const d of [...dirs].sort()) hashDir(d, hash);
  return hash.digest("hex");
}
