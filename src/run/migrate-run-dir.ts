// `migrate-run-dir` — convert a pre-layout run dir to the per-turn layout.
//
// WHY THIS EXISTS. Removing the legacy read layer makes every pre-layout dir unreadable. The real
// population is not disposable: 1,635 legacy dirs across 96 scenarios, holding history that cannot be
// re-run. Migration keeps that history AND delivers the single shape the removal is for.
//
// THE PRIMITIVE IS `rename`, NEVER copy. Same-filesystem rename preserves mtime, birthtime and inode;
// copy destroys mtime. That matters because mtime IS data here: run-index derives every indexed row's
// `ts` from `result.json`'s mtime, and latest-run uses it for `--latest-for` recency. A copy-based
// migrator collapses 1,635 dirs of history onto migration day. Rename also removes the need for a
// byte-verify pass and makes crash recovery tractable: each artifact is atomically at exactly one of
// {source, destination}.
//
// PHASE 1 (assess) IS TOTALLY MUTATION-FREE and returns a complete plan, or refuses the whole directory.
// Assessment and execution were interleaved in earlier designs, and that is precisely what deleted and
// fabricated turns: a rule would mutate one artifact and then discover the directory was inconsistent.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { PER_TURN_ARTIFACTS, classifyRunDir, listTurns, turnArtifactPath, type PerTurnArtifact } from "./turn-layout.js";

/** One planned filesystem operation. A `split` is write+write+delete, which is why done-ness for it is
 *  defined as "source is gone" rather than "destination exists" — see the recovery contract. */
export type MigrationOp =
  | { kind: "move"; from: string; to: string }
  | { kind: "split"; from: string; boundaryMs: number; toLow: string; toHigh: string }
  | { kind: "delete"; path: string };

export interface MigrationPlan {
  outDir: string;
  /** Identity of the run dir this plan was built for. Recovery verifies it so a journal can never be
   *  replayed onto a DIFFERENT directory that later reused the same path. */
  identity: { ino: number; birthtimeMs: number };
  ops: MigrationOp[];
  /** Directory mtimes to restore after execution. Renaming files into `turns/` re-stamps the parent
   *  dir even though the files' own mtimes survive — and the run dir's mtime is a live signal
   *  (`runs-gc` prune ranking, `trace-view` fragment tiebreak). */
  dirMtimes: Record<string, number>;
}

export type Assessment =
  | { kind: "plan"; plan: MigrationPlan }
  /** Already the current shape. */
  | { kind: "noop"; reason: string }
  /** An aborted-run stub with no per-turn artifacts at all — 2,111 of the real 3,798. NOT a failure:
   *  there is nothing to migrate, and reporting these as errors would drown the report. */
  | { kind: "skip"; reason: string }
  | { kind: "refuse"; reason: string };

const ARCHIVE_RE = /^(result|run|trace|resources)\.turn-(\d+)(?:\.retry-(\d+))?\.(json|jsonl)$/;

function artifactForStem(stem: string): PerTurnArtifact {
  return (stem === "run" || stem === "resources" ? `${stem}.jsonl` : `${stem}.json`) as PerTurnArtifact;
}

interface Archive {
  file: string;
  stem: string;
  turn: number;
  retry?: number;
}

function archivesIn(outDir: string): Archive[] {
  const out: Archive[] = [];
  for (const e of readdirSync(outDir)) {
    const m = ARCHIVE_RE.exec(e);
    if (m) out.push({ file: e, stem: m[1], turn: Number(m[2]), retry: m[3] === undefined ? undefined : Number(m[3]) });
  }
  return out;
}

function sameBytes(a: string, b: string): boolean {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

/** The `.turn` stamp, when the artifact carries one. Absent from 404 of 1,630 real legacy results, so
 *  this is a corroborating cross-check only — never the deciding test. */
function stampedTurn(path: string): number | undefined {
  try {
    const v = (JSON.parse(readFileSync(path, "utf8")) as { turn?: unknown }).turn;
    return typeof v === "number" ? v : undefined;
  } catch {
    return undefined;
  }
}

/** The prior turn's completion time — the mtime of its archived result. `renameSync` preserves mtimes, so
 *  this survives both the original archiving and the migration itself. */
function completionMtimeOf(outDir: string, turn: number): number | undefined {
  const p = join(outDir, `result.turn-${turn}.json`);
  try {
    return existsSync(p) ? statSync(p).mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

/** Where a sample file's rows fall relative to the boundary. `unusable` means no row carried a parseable
 *  numeric `ts` — attribution is then a GUESS, and guessing is what the split exists to avoid. */
type SampleSpread = "before" | "after" | "spanning" | "unusable";

function classifySamples(path: string, boundaryMs: number): SampleSpread {
  let low = false;
  let high = false;
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line) continue;
      let ts: number | undefined;
      try {
        const v = (JSON.parse(line) as { ts?: unknown }).ts;
        if (typeof v === "number") ts = v;
      } catch {
        /* an unparseable row contributes no evidence either way */
      }
      if (ts === undefined) continue;
      // `<=`: a sample taken exactly at the prior turn's completion belongs to THAT turn.
      if (ts <= boundaryMs) low = true;
      else high = true;
    }
  } catch {
    return "unusable";
  }
  if (low && high) return "spanning";
  if (low) return "before";
  if (high) return "after";
  return "unusable";
}

/** Plan the one artifact whose attribution is decided by CONTENT rather than by its filename.
 *
 *  `owningTurn` is the turn the file is nominally associated with — the archive's own N, or `maxArchive`
 *  for a root file. Samples at or before that turn's completion belong to it; later samples belong to the
 *  next turn. Handles the root and archive-named forms identically, because the resume fix renames one
 *  into the other and the two must not migrate differently. */
function planResources(
  outDir: string,
  from: string,
  owningTurn: number,
): { kind: "op"; op: MigrationOp } | { kind: "refuse"; reason: string } {
  const rel = from.slice(outDir.length + 1);
  const boundaryMs = completionMtimeOf(outDir, owningTurn);
  if (boundaryMs === undefined)
    return {
      kind: "refuse",
      reason: `cannot determine the turn boundary for ${rel} (no mtime for result.turn-${owningTurn}.json) — refusing rather than attributing samples by guess`,
    };

  const lowDest = turnArtifactPath(outDir, owningTurn, "resources.jsonl");
  const highDest = turnArtifactPath(outDir, owningTurn + 1, "resources.jsonl");
  const spread = classifySamples(from, boundaryMs);

  if (spread === "unusable")
    return {
      kind: "refuse",
      reason: `${rel} has no usable sample timestamps — refusing rather than attributing telemetry by guess`,
    };

  // A split WRITES both destinations, so an occupied one is destroyed rather than merged. The
  // uniqueness pass below only sees moves, so this has to be checked here.
  if (spread === "spanning") {
    for (const dest of [lowDest, highDest]) {
      if (existsSync(dest))
        return { kind: "refuse", reason: `splitting ${rel} would overwrite the existing ${dest.slice(outDir.length + 1)}` };
    }
    return { kind: "op", op: { kind: "split", from, boundaryMs, toLow: lowDest, toHigh: highDest } };
  }

  // Wholly one side: a plain move, but to the turn the CONTENT indicates — not automatically the latest.
  const dest = spread === "before" ? lowDest : highDest;
  if (existsSync(dest) && !sameBytes(from, dest))
    return { kind: "refuse", reason: `${rel} would overwrite the existing ${dest.slice(outDir.length + 1)}` };
  return existsSync(dest) ? { kind: "op", op: { kind: "delete", path: from } } : { kind: "op", op: { kind: "move", from, to: dest } };
}

/** Assess a run dir and return a complete plan, or a refusal. NEVER mutates anything. */
export function assessRunDir(outDir: string): Assessment {
  const shape = classifyRunDir(outDir);
  if (shape.kind === "none") return { kind: "skip", reason: "aborted stub — no per-turn artifacts to migrate" };

  const archives = archivesIn(outDir);
  const rootArtifacts = PER_TURN_ARTIFACTS.filter((a) => existsSync(join(outDir, a)));
  if (shape.kind === "turns" && archives.length === 0 && rootArtifacts.length === 0)
    return { kind: "noop", reason: "already the per-turn layout" };

  // NO LAUNDERING. A dir with no transcript anywhere migrates into a `turns` shape that `requireTurns`
  // passes and `diff` then reports as identical to any other such dir, exit 0 — turning a refused
  // legacy dir into a gate-passing empty one. Mirrors currentTurnFromDirs' "no transcript = not a turn".
  const hasTranscript =
    existsSync(join(outDir, "run.jsonl")) ||
    archives.some((a) => a.stem === "run") ||
    listTurns(outDir).some((n) => existsSync(turnArtifactPath(outDir, n, "run.jsonl")));
  if (!hasTranscript)
    return { kind: "refuse", reason: "no run.jsonl anywhere — refusing rather than laundering an empty dir past the gates" };

  const ops: MigrationOp[] = [];

  // PER-DIR mapping, never per-artifact-family: the root turn is one past the highest archive number
  // across ALL families. The 12 real archive dirs archive result/run but never trace, so a per-family
  // reading puts the root trace.json (the LATEST turn's) into turns/1 — wrong in 12/12 cases.
  const maxArchive = archives.reduce((m, a) => Math.max(m, a.turn), 0);
  const rootTurn = maxArchive + 1;

  for (const a of archives) {
    const from = join(outDir, a.file);

    // An ARCHIVE-NAMED resources file can be cumulative too — the resume fix mints exactly that by
    // renaming a spanning root `resources.jsonl` to `resources.turn-<prior>.jsonl`. Trusting the name
    // would carry turn-N and turn-N+1 samples into one slot. CONTENT decides; the filename is a hint.
    if (a.stem === "resources" && a.retry === undefined) {
      const r = planResources(outDir, from, a.turn);
      if (r.kind === "refuse") return r;
      ops.push(r.op);
      continue;
    }

    const dest =
      a.retry === undefined
        ? turnArtifactPath(outDir, a.turn, artifactForStem(a.stem))
        : // Retry archives are not PER_TURN_ARTIFACTS; keep the stem's own extension rather than
          // hardcoding .jsonl, which mislabelled `result.turn-1.retry-2.json`.
          join(
            outDir,
            "turns",
            String(a.turn),
            `${a.stem}.retry-${a.retry}${a.stem === "run" || a.stem === "resources" ? ".jsonl" : ".json"}`,
          );
    if (existsSync(dest)) {
      // Collision: identical is a duplicate to drop, different is unresolvable.
      if (sameBytes(from, dest)) ops.push({ kind: "delete", path: from });
      else return { kind: "refuse", reason: `${a.file} collides with existing ${dest.slice(outDir.length + 1)} and differs` };
    } else ops.push({ kind: "move", from, to: dest });
  }

  const turns = listTurns(outDir);
  for (const artifact of rootArtifacts) {
    const from = join(outDir, artifact);

    // A CUMULATIVE resources file must be split, not carried. On the 12 real archive dirs
    // `resources.jsonl` spans BOTH turns (they predate `beginTurn`'s resources rename): the first sample
    // lands seconds before turn 1 completed and the last during turn 2. Carrying it whole into one slot
    // attributes turn-1 samples to turn 2 — bytes preserved, telemetry wrong.
    if (artifact === "resources.jsonl" && maxArchive > 0) {
      const r = planResources(outDir, from, maxArchive);
      if (r.kind === "refuse") return r;
      ops.push(r.op);
      continue;
    }

    if (turns.length === 0) {
      // No `turns/` yet: the per-dir mapping governs.
      ops.push({ kind: "move", from, to: turnArtifactPath(outDir, rootTurn, artifact) });
      continue;
    }

    // `turns/` exists: the 3-branch rule governs, ALWAYS. (The N+1 mapping applies only when `turns/`
    // is absent — otherwise both claim the same file and one reading renames onto an occupied slot.)
    const selfLabeling = artifact === "result.json" || artifact === "run.jsonl";
    const identicalTo = turns.find((n) => sameBytes(from, turnArtifactPath(outDir, n, artifact)));
    if (selfLabeling && identicalTo !== undefined) {
      ops.push({ kind: "delete", path: from });
      continue;
    }
    // Lowest slot lacking this artifact. For non-self-labeling artifacts (trace/resources) byte-identity
    // is not proof of duplication — an empty file matches any other empty file — so they only ever move.
    const slot = turns.find((n) => !existsSync(turnArtifactPath(outDir, n, artifact)));
    if (slot === undefined)
      return {
        kind: "refuse",
        reason: `root ${artifact} is neither a duplicate of any turn nor placeable — every turn already has one`,
      };
    const stamp = selfLabeling ? stampedTurn(from) : undefined;
    if (stamp !== undefined && stamp !== slot)
      return { kind: "refuse", reason: `root ${artifact} is stamped turn ${stamp} but the only free slot is turn ${slot}` };
    ops.push({ kind: "move", from, to: turnArtifactPath(outDir, slot, artifact) });
  }

  // DESTINATION UNIQUENESS. The archive mapping and the 3-branch rule each check EXISTING occupancy;
  // neither sees the other's plan. Without this, two operations can target one path and the second
  // silently wins — destroying whatever the first moved there.
  // SPLITS COUNT TOO. Checking moves only left split destinations unguarded, and a split WRITES its
  // destinations — so a split whose `toLow` matched an archive move's target silently overwrote whatever
  // the move had just put there.
  const dests = ops.flatMap((o) => (o.kind === "move" ? [o.to] : o.kind === "split" ? [o.toLow, o.toHigh] : []));
  const dup = dests.find((d, i) => dests.indexOf(d) !== i);
  if (dup !== undefined)
    return {
      kind: "refuse",
      reason: `two planned operations share destination ${dup.slice(outDir.length + 1)} — refusing rather than letting one silently win`,
    };

  if (ops.length === 0) return { kind: "noop", reason: "already the per-turn layout" };

  const st = statSync(outDir);
  // Every directory whose mtime the migration will disturb, not just the run dir: moving a file into
  // `turns/<N>/` re-stamps that dir AND `turns/`. Only the run dir has a known reader today
  // (prune's keep-slot ranking, trace-fragment tiebreaking), but restoring one level and leaving the
  // others is the same partial fix that let the mtime signal break unnoticed before.
  const dirMtimes: Record<string, number> = { [outDir]: st.mtimeMs };
  const turnsRoot = join(outDir, "turns");
  if (existsSync(turnsRoot)) {
    dirMtimes[turnsRoot] = statSync(turnsRoot).mtimeMs;
    for (const n of listTurns(outDir)) {
      const td = join(turnsRoot, String(n));
      if (existsSync(td)) dirMtimes[td] = statSync(td).mtimeMs;
    }
  }
  return { kind: "plan", plan: { outDir, identity: { ino: st.ino, birthtimeMs: st.birthtimeMs }, ops, dirMtimes } };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// PHASE 2 — EXECUTE, and the recovery contract.
//
// THE JOURNAL LIVES OUTSIDE THE RUN DIR. Every earlier design put it inside, which is self-defeating:
// the run dir's own mtime is the signal being protected (prune's keep-slot ranking, trace-fragment
// tiebreaking), so writing or removing a marker inside it re-dirties exactly what the journal exists to
// restore. Outside, the safe order exists with no window: journal → ops → restore mtimes → remove journal.
//
// RECOVERY IS THE SAME EXECUTOR, RESUMED — not a separate code path. That is only achievable because the
// journal carries the COMPLETE typed plan (every op kind, plus the boundary a split needs and the mtimes
// to restore). Four prior designs each lost this at a different level and produced a directory that
// refused forever.
//
// DONE-NESS IS DEFINED BY THE SOURCE, NEVER THE DESTINATION. A destination may exist and be torn, or may
// hold foreign bytes; neither proves the operation completed.

/** The journal store, relative to the runs root. Deliberately a SIBLING of the scenario dirs rather than
 *  inside a run dir: a run dir's own mtime is a live signal (prune keep-slot ranking, trace-fragment
 *  tiebreaking), so a marker written inside it would dirty exactly what the journal exists to restore.
 *
 *  `runs-gc` imports this rather than re-declaring it — prune has to recognise the same directory in
 *  order to skip it, and two independent string literals would eventually drift apart. */
export const MIGRATION_JOURNAL_DIR = ".migrating";

/** The journal root for a given runs root. */
export function journalRootFor(runsRoot: string): string {
  return join(runsRoot, MIGRATION_JOURNAL_DIR);
}

/** Where a run dir's journal lives. NESTED, not `<scenario>__<runId>`: the flat form is ambiguous —
 *  `a__b/c` and `a/b__c` both encode to `a__b__c`, and one dir's migration would then consume another's
 *  journal and execute the wrong plan against it. */
export function journalPathFor(journalRoot: string, outDir: string): string {
  return join(journalRoot, basename(dirname(outDir)), `${basename(outDir)}.json`);
}

export interface ExecuteOpts {
  journalRoot: string;
  /** Per-op progress hook (the CLI uses it for --verbose). Tests throw from it to simulate a crash. */
  onOp?: (op: MigrationOp, index: number) => void;
}

/** Throws unless every field recovery depends on is present and of the right shape. Recovery reads the
 *  journal as a plan; a field it silently lacks becomes a wrong decision rather than an error. */
function assertWellFormed(plan: MigrationPlan): void {
  const ok =
    plan !== null &&
    typeof plan === "object" &&
    typeof plan.outDir === "string" &&
    Array.isArray(plan.ops) &&
    plan.dirMtimes !== null &&
    typeof plan.dirMtimes === "object" &&
    plan.identity !== null &&
    typeof plan.identity === "object" &&
    typeof plan.identity.ino === "number" &&
    typeof plan.identity.birthtimeMs === "number" &&
    plan.ops.every(
      (o) =>
        (o?.kind === "move" && typeof o.from === "string" && typeof o.to === "string") ||
        (o?.kind === "delete" && typeof o.path === "string") ||
        (o?.kind === "split" &&
          typeof o.from === "string" &&
          typeof o.boundaryMs === "number" &&
          typeof o.toLow === "string" &&
          typeof o.toHigh === "string"),
    );
  if (!ok) throw new Error("malformed journal");
}

function writeJournalAtomic(path: string, plan: MigrationPlan): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(plan, null, 2));
  renameSync(tmp, path);
}

/** True when this op has already been performed. Keyed on the SOURCE in every case. */
function opIsDone(op: MigrationOp): boolean {
  if (op.kind === "move") return !existsSync(op.from);
  if (op.kind === "split") return !existsSync(op.from);
  return !existsSync(op.path);
}

/** Perform one op. Splits re-execute from scratch and OVERWRITE both destinations: a partially written
 *  destination from a crashed attempt must never be trusted, and the boundary comes from the journal
 *  rather than being recomputed from a source the split is midway through consuming. */
function performOp(op: MigrationOp): void {
  if (op.kind === "move") {
    mkdirSync(dirname(op.to), { recursive: true });
    renameSync(op.from, op.to);
    return;
  }
  if (op.kind === "split") {
    const lines = readFileSync(op.from, "utf8").split("\n").filter(Boolean);
    const low: string[] = [];
    const high: string[] = [];
    for (const line of lines) {
      let ts = Number.POSITIVE_INFINITY;
      try {
        const v = (JSON.parse(line) as { ts?: unknown }).ts;
        if (typeof v === "number") ts = v;
      } catch {
        /* an unparseable sample sorts to the later turn rather than being dropped */
      }
      (ts <= op.boundaryMs ? low : high).push(line);
    }
    for (const [dest, rows] of [
      [op.toLow, low],
      [op.toHigh, high],
    ] as const) {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, rows.length ? `${rows.join("\n")}\n` : "");
    }
    rmSync(op.from, { force: true });
    return;
  }
  rmSync(op.path, { force: true });
}

/** Restore recorded directory mtimes. Renaming files into `turns/` re-stamps the parent directories even
 *  though rename preserves the files' own mtimes. */
function restoreDirMtimes(plan: MigrationPlan): void {
  for (const [dir, ms] of Object.entries(plan.dirMtimes)) {
    try {
      if (existsSync(dir)) utimesSync(dir, ms / 1000, ms / 1000);
    } catch {
      /* best-effort: a failed mtime restore must not strand a migrated dir */
    }
  }
}

function runOps(plan: MigrationPlan, onOp?: ExecuteOpts["onOp"]): void {
  plan.ops.forEach((op, i) => {
    onOp?.(op, i);
    if (!opIsDone(op)) performOp(op);
  });
}

/** Execute a plan. Writes the journal FIRST so a crash at any later point is recoverable, and removes it
 *  LAST — after the mtime restore, since removing it does not touch the run dir. */
export function executeMigration(plan: MigrationPlan, opts: ExecuteOpts): void {
  const journal = journalPathFor(opts.journalRoot, plan.outDir);
  // An existing journal means an interrupted migration. Re-executing a freshly assessed plan over it
  // would clobber the only record of what was already half-done — the caller must recover first.
  if (existsSync(journal))
    throw new Error(`a migration journal already exists for ${plan.outDir} — recover it before migrating again (${journal})`);
  writeJournalAtomic(journal, plan);
  runOps(plan, opts.onOp);
  restoreDirMtimes(plan);
  rmSync(journal, { force: true });
}

export type RecoveryResult =
  | { kind: "none" }
  | { kind: "recovered" }
  /** The journal belongs to a directory that no longer exists at this path — swept, not replayed. */
  | { kind: "orphaned" }
  | { kind: "refuse"; reason: string };

/** Finish an interrupted migration, if one is recorded for this dir. Safe to call unconditionally. */
export function recoverIfNeeded(outDir: string, opts: ExecuteOpts): RecoveryResult {
  const journal = journalPathFor(opts.journalRoot, outDir);
  if (!existsSync(journal)) return { kind: "none" };

  let plan: MigrationPlan;
  try {
    plan = JSON.parse(readFileSync(journal, "utf8")) as MigrationPlan;
    assertWellFormed(plan);
  } catch {
    // A torn OR structurally invalid journal blocks this dir; refusing loudly keeps the batch alive,
    // where an uncaught error would abort it and violate "one bad dir never aborts the batch".
    //
    // Validating only `ops`-is-an-array and `outDir`-is-a-string was not enough, and the two failures it
    // let through were worse than a throw: a journal missing `dirMtimes` threw from Object.entries deep in
    // the restore, and a journal whose ops were unrecognisable made EVERY op look already-done — so
    // recovery reported success and deleted the journal, destroying the record of an interrupted plan.
    // Nothing is deleted on this path: a journal we cannot understand is never a journal we may discard.
    return { kind: "refuse", reason: `unreadable or malformed migration journal at ${journal} — resolve or delete it by hand` };
  }

  // IDENTITY. Without this a journal outlives its directory: if the dir was deleted and a fresh run later
  // reused the same scenario/runId path, the stale plan would replay onto it — mislabeling the new run
  // and minting phantom turns, reported as success.
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(outDir);
  } catch {
    rmSync(journal, { force: true });
    return { kind: "orphaned" };
  }
  if (st.ino !== plan.identity?.ino || Math.round(st.birthtimeMs) !== Math.round(plan.identity?.birthtimeMs)) {
    rmSync(journal, { force: true });
    return { kind: "orphaned" };
  }

  // A pending move whose destination exists with DIFFERENT bytes is unresolvable: skipping would strand
  // the source and keep the foreign bytes.
  for (const op of plan.ops) {
    if (op.kind !== "move" || opIsDone(op)) continue;
    if (existsSync(op.to) && !sameBytes(op.from, op.to))
      return { kind: "refuse", reason: `${op.to} already exists with different content than the pending ${op.from}` };
  }

  runOps(plan, opts.onOp);
  restoreDirMtimes(plan);
  rmSync(journal, { force: true });
  return { kind: "recovered" };
}
