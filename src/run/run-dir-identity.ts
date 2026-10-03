// Which tree does a kept run's evidence live in?
//
// A run's result.json records its evidence by ABSOLUTE host path: `outDir` (the run dir itself), `workDir` (the
// agent's tree, where the authored files live), `outputsDir` and `stderrLogPath`. A run dir copied or moved after
// its run keeps those paths. Read through them, a COPY's command would read the ORIGINAL's evidence while naming
// (and writing its regrade file into) the copy: a user edits a deliverable in the copy, regrades it, and the judge
// reads the original — with no drift and no warning. The danger is reading another run's evidence, which can only
// happen while the recorded location still exists. So, before anything is read:
//
//  - Every recorded path must be absolute and normalized (no `.`, `..` or `//` segment: the harness never writes
//    one, and a `lnk/..` that collapses lexically is followed by the kernel through the link) — else refused.
//  - Nothing recorded at all: nothing can point elsewhere; the dir given stands (`same`, no paths). Every reader then
//    has no work dir and refuses the evidence it needs on its own. Evidence paths recorded with no `outDir`: which
//    run they belong to cannot be shown — refused.
//  - (A) `same`: the recorded `outDir` resolves (realpath.native — a symlinked parent, or /var ↔ /private/var, is the
//    same dir; no case folding, the filesystem decides) to the dir given. Every other recorded path must sit inside
//    it, segment by segment, resolved the same way; one outside is refused.
//  - (B) refused: the recorded `outDir` EXISTS and is another dir — a copy beside its original. Exit 2.
//  - (C) `relocated`: the recorded `outDir` no longer exists — a moved dir, a downloaded CI artifact, a runs root
//    restored elsewhere. Nothing can be read there, so each recorded path PROVABLY inside the recorded `outDir`
//    (segment-wise, no `..`) is re-rooted onto the dir given; the re-rooted path, where it exists, must resolve
//    inside the given dir (a symlink in the moved tree cannot carry a read outside). A path that cannot be re-rooted
//    is UNAVAILABLE: absent to every reader, never read at its recorded location.
//
// Readers take the decided paths (`withDecidedPaths`), never `result.workDir` directly.
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { RunResult } from "../types.js";
import { warn } from "../io.js";

/** The result.json fields that name evidence by absolute host path. */
export const RECORDED_PATH_FIELDS = ["outDir", "workDir", "outputsDir", "stderrLogPath"] as const;
export type RecordedPathField = (typeof RECORDED_PATH_FIELDS)[number];
export type RecordedRunPaths = Partial<Pick<RunResult, RecordedPathField>>;

export type RunDirDecision =
  /** The recorded paths are this dir's own (or nothing is recorded): `paths` are the recorded ones. */
  | { kind: "same"; paths: RecordedRunPaths }
  /** The recorded run dir is gone: `paths` are re-rooted onto the dir given; `unavailable` could not be. */
  | {
      kind: "relocated";
      recordedOutDir: string;
      paths: RecordedRunPaths;
      unavailable: Array<{ field: RecordedPathField; recorded: string; why: string }>;
      note: string;
    }
  | { kind: "refuse"; message: string };

/** `p` resolved through its longest existing ancestor: the on-disk spelling of what exists, the rest as written.
 *  Only ever called on a normalized absolute path, so the unresolved tail holds no `..`. */
function canonical(p: string): string {
  const tail: string[] = [];
  let cur = p;
  for (;;) {
    try {
      return join(realpathSync.native(cur), ...tail.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return p;
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

/** Whether something is at `p`. Only "not there" (ENOENT/ENOTDIR — a dangling link included: nothing to read) is
 *  absence; any other failure (EACCES …) counts as present, so it can only refuse. */
function present(p: string): boolean {
  try {
    realpathSync.native(p);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}

const NOT_GREEN = "(can't verify ⇒ not green)";

/** The way out of a (B) refusal. hillclimb finds a row's run dir under the current runs root by run id, so its remedy
 *  is the runs root; every other command takes the run dir itself. */
function remedy(cmd: string, outDir: string): string {
  if (cmd.startsWith("hillclimb"))
    return `Re-run the case, or point --run-dir at the runs root it was written under (${dirname(dirname(outDir))}).`;
  return `Re-run the scenario, or ${cmd} the original at ${outDir}.`;
}

/**
 * Decide where a kept run's evidence is read from (see the rule above). `runDir` is the dir as the caller gave it
 * (echoed that way); `cmd` leads every message.
 */
export function decideRunDir(runDir: string, result: RecordedRunPaths, cmd: string): RunDirDecision {
  const recorded = RECORDED_PATH_FIELDS.flatMap((k) => {
    const v = (result as Record<string, unknown>)[k];
    return typeof v === "string" && v !== "" ? [[k, v] as const] : [];
  });
  if (recorded.length === 0) return { kind: "same", paths: {} };
  for (const [k, v] of recorded) {
    if (!isAbsolute(v))
      return {
        kind: "refuse",
        message: `${cmd}: ${runDir}'s result.json records ${k} ${v}, which is not an absolute path; refusing to read it. ${NOT_GREEN}`,
      };
    if (normalize(v) !== v)
      return {
        kind: "refuse",
        message: `${cmd}: ${runDir}'s result.json records ${k} ${v}, which is not a normalized path (a \`.\`, \`..\` or \`//\` segment the harness never writes); refusing to read it. ${NOT_GREEN}`,
      };
  }
  const outDir = recorded.find(([k]) => k === "outDir")?.[1];
  if (outDir === undefined)
    return {
      kind: "refuse",
      message:
        `${cmd}: ${runDir}'s result.json records ${recorded.map(([k]) => k).join(", ")} but no outDir, so which run that ` +
        `evidence belongs to cannot be shown; refusing to read it. Re-run the scenario. ${NOT_GREEN}`,
    };
  const given = canonical(resolve(runDir));
  const evidence = recorded.filter(([k]) => k !== "outDir");

  // (A) the run's own dir.
  const ownDir = canonical(outDir);
  if (ownDir === given) {
    for (const [k, v] of evidence) {
      if (!within(ownDir, canonical(v)))
        return {
          kind: "refuse",
          message: `${cmd}: ${runDir}'s result.json records ${k} ${v}, outside the run dir ${outDir}; refusing to read another dir's evidence. ${NOT_GREEN}`,
        };
    }
    return { kind: "same", paths: Object.fromEntries(recorded) as RecordedRunPaths };
  }

  // (B) a copy beside its original.
  if (present(outDir))
    return {
      kind: "refuse",
      message:
        `${cmd}: ${runDir} was copied from ${outDir}, which is still there; its result.json points at that dir, so the ` +
        `evidence it names (the work dir, the authored files) is the original's, not this copy's. ${remedy(cmd, outDir)} ${NOT_GREEN}`,
    };

  // (C) the recorded dir is gone: re-root what is provably inside it.
  const base = resolve(runDir);
  const paths: RecordedRunPaths = { outDir: base };
  const unavailable: Array<{ field: RecordedPathField; recorded: string; why: string }> = [];
  for (const [k, v] of evidence) {
    const rel = relative(outDir, v);
    if (!(rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)))) {
      unavailable.push({ field: k, recorded: v, why: "outside the recorded run dir" });
      continue;
    }
    const moved = rel === "" ? base : join(base, rel);
    if (!within(given, canonical(moved))) {
      unavailable.push({ field: k, recorded: v, why: "resolves outside this run dir (a link)" });
      continue;
    }
    paths[k] = moved;
  }
  const note =
    `note: ${runDir} was recorded at ${outDir} (no longer there); reading its evidence from ${runDir}` +
    (unavailable.length ? `; unavailable: ${unavailable.map((u) => `${u.field} (${u.why})`).join(", ")}` : "");
  return { kind: "relocated", recordedOutDir: outDir, paths, unavailable, note };
}

/** `result` with its recorded paths replaced by the decided ones; a recorded path with no decided one is removed, so
 *  every reader sees it absent. A refusal has no paths: the caller refuses before reading. */
export function withDecidedPaths<T extends RecordedRunPaths>(result: T, d: Exclude<RunDirDecision, { kind: "refuse" }>): T {
  const out = { ...result };
  for (const k of RECORDED_PATH_FIELDS) {
    if (d.paths[k] !== undefined) (out as RecordedRunPaths)[k] = d.paths[k];
    else delete (out as RecordedRunPaths)[k];
  }
  return out;
}

const noted = new Set<string>();
/** Print a relocation's note once per process (one command): a command can open the same run dir several times. */
export function noteRelocation(d: RunDirDecision): void {
  if (d.kind !== "relocated" || noted.has(d.note)) return;
  noted.add(d.note);
  warn(`::notice:: ${d.note}\n`);
}
