// The pure (non-process.exit-ing) glue behind `cmdStatus`'s dir resolution — split out of cli.ts so it
// has a home a test can `import` directly instead of spawning the built CLI. cli.ts unconditionally
// calls `main()` at module load (see its final `main().catch(...)` line), so importing cli.ts itself
// from a test would execute the CLI — every existing CLI-level test spawns `dist/cli.js` for exactly
// this reason. This module has no such self-execution, so it's safe to import directly.
//
// Deliberately its OWN module, not a home in latest-run.ts or run-status.ts: it needs both
// `resolveStatusDir`/`hasRunStatus` (run-status.ts) AND `findLatestRunUnderRoot` (latest-run.ts), and
// putting it in either of those would create a run-status → latest-run → execute → run-status import
// cycle (execute.ts imports run-status.ts for status-writing).
import { resolveStatusDir, hasRunStatus } from "./run-status.js";
import { findLatestRunUnderRoot } from "./latest-run.js";

/** Resolve a `status` CLI argument to the dir `cmdStatus` should actually read. Layers root-resolution
 *  on top of `resolveStatusDir`: if the resolved dir itself has no `status.json` (e.g. the caller passed
 *  their `--run-dir` ROOT rather than the exact per-session outDir), scan up to two levels under it for
 *  the newest session that does (`findLatestRunUnderRoot`) and use that instead. Falls back to the
 *  original dir, unchanged, when no nested session qualifies — `cmdStatus` then reports its own
 *  "no status.json" error against that dir, same as before this helper existed.
 *
 *  Can throw — `resolveStatusDir` throws for an argument that resolves to neither a literal directory
 *  nor a known run-id/fragment. Callers must handle that the same way they already handle
 *  `resolveStatusDir`'s own throw. */
export function resolveStatusTarget(arg: string): string {
  const dir = resolveStatusDir(arg);
  if (hasRunStatus(dir)) return dir;
  return findLatestRunUnderRoot(dir) ?? dir;
}
