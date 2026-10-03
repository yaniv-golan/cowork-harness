// Is the run dir a command was given the run its result.json describes?
//
// A run's result.json records its evidence by ABSOLUTE host path: `outDir` (the run dir itself), `workDir` (the
// agent's tree, where the authored files live), `outputsDir` and `stderrLogPath`. Every command that reopens a kept
// run reads through those paths. A run dir copied or moved after its run keeps the old paths, so on a copy the
// command would read the ORIGINAL's evidence while naming (and writing its regrade file into) the copy: a user
// edits a deliverable in the copy, regrades it, and the judge reads the original — with no drift and no warning.
//
// The rule, applied before anything is read through a recorded path:
//  - nothing recorded at all (no outDir, workDir, outputsDir or stderrLogPath): nothing can point elsewhere, so the
//    given dir stands. Every reader then has no work dir to read and refuses the evidence it needs on its own.
//  - evidence paths recorded but no outDir: which run they belong to cannot be shown — refused.
//  - `outDir` must be the given dir: both resolved through `realpath.native` (a dir reached through a symlinked
//    parent, or macOS's /var ↔ /private/var, is the same dir), compared whole, never as a string prefix and never
//    case-folded (realpath.native returns the on-disk spelling, so the filesystem decides what is the same dir).
//    A recorded dir that no longer exists keeps its unresolved tail, so a MOVED run dir is refused like a copy.
//  - every other recorded path must be absolute and sit inside the recorded `outDir`, segment by segment, resolved
//    the same way. A path need not exist: a container run's work dir is torn down by design, and its absence is
//    refused (or not) by each reader for what it needs.
//
// No re-rooting: rewriting the recorded paths onto the given dir would trust that every field naming evidence is
// one of these four and that the copy is complete. Refusing needs neither.
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { RunResult } from "../types.js";

/** The result.json fields that name evidence by absolute host path. */
export const RECORDED_PATH_FIELDS = ["outDir", "workDir", "outputsDir", "stderrLogPath"] as const;

export type RecordedRunPaths = Partial<Pick<RunResult, (typeof RECORDED_PATH_FIELDS)[number]>>;

/** `p` resolved through its longest existing ancestor: the on-disk spelling of what exists, the rest as written. */
function canonical(p: string): string {
  const tail: string[] = [];
  let cur = resolve(p);
  for (;;) {
    try {
      return join(realpathSync.native(cur), ...tail.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(p);
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

/** `p` is `root` or inside it, segment by segment. */
function within(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * The refusal for a run dir whose result.json names another dir's evidence, or `undefined` when it names its own
 * (see the rule above). `runDir` is the dir as the caller gave it, and is echoed that way; `cmd` leads the message.
 */
export function relocatedRunDirRefusal(runDir: string, result: RecordedRunPaths, cmd: string): string | undefined {
  const recorded = RECORDED_PATH_FIELDS.flatMap((k) => {
    const v = (result as Record<string, unknown>)[k];
    return typeof v === "string" && v !== "" ? [[k, v] as const] : [];
  });
  if (recorded.length === 0) return undefined;
  const outDir = recorded.find(([k]) => k === "outDir")?.[1];
  if (outDir === undefined)
    return (
      `${cmd}: ${runDir}'s result.json records ${recorded.map(([k]) => k).join(", ")} but no outDir, so which run that ` +
      `evidence belongs to cannot be shown; refusing to read it. Re-run the scenario. (can't verify ⇒ not green)`
    );
  for (const [k, v] of recorded) {
    if (!isAbsolute(v))
      return `${cmd}: ${runDir}'s result.json records ${k} ${v}, which is not an absolute path; refusing to read it. (can't verify ⇒ not green)`;
  }
  const ownDir = canonical(outDir);
  if (ownDir !== canonical(runDir))
    return (
      `${cmd}: ${runDir} was copied or moved from ${outDir}; its result.json still points there, so the evidence it ` +
      `names (the work dir, the authored files) is that dir's, not this one's. Re-run the scenario, or ${cmd} the ` +
      `original at ${outDir} (move it back there if it was moved). (can't verify ⇒ not green)`
    );
  for (const [k, v] of recorded) {
    if (k !== "outDir" && !within(ownDir, canonical(v)))
      return (
        `${cmd}: ${runDir}'s result.json records ${k} ${v}, outside the run dir ${outDir}; refusing to read another ` +
        `dir's evidence. (can't verify ⇒ not green)`
      );
  }
  return undefined;
}
