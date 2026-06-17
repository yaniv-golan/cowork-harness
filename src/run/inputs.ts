import { existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Resolve a CLI target (a file or a directory) to a sorted list of files — the shared file-or-dir helper
 * for `run`, `replay`, and `verify-cassettes`. A directory matches by one or more extensions (run needs
 * both `.yaml` and `.yml`). A missing path or an EMPTY directory returns `{ error }` so the caller fails
 * loud (a vacuous "0 files = pass" is the cardinal false-green this prevents). A single file is returned
 * as-is regardless of extension (the caller asked for that exact file).
 */
export function resolveInputs(target: string, exts: string | string[]): { files: string[]; isDir: boolean } | { error: string } {
  if (!existsSync(target)) return { error: `path not found: ${target}` };
  if (!statSync(target).isDirectory()) return { files: [target], isDir: false };
  const list = Array.isArray(exts) ? exts : [exts];
  const files = readdirSync(target)
    .filter((f) => list.some((e) => f.endsWith(e)))
    .sort()
    .map((f) => join(target, f));
  if (files.length === 0) return { error: `no ${list.join("/")} files under ${target} — nothing to do (loud non-zero, not a vacuous pass)` };
  return { files, isDir: true };
}
