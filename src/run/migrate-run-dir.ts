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

/** Whether a JSONL sample file has rows on BOTH sides of the boundary — i.e. it is genuinely cumulative
 *  across turns rather than belonging wholly to one. */
function samplesSpan(path: string, boundaryMs: number): boolean {
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
        /* unparseable rows do not establish a span */
      }
      if (ts === undefined) continue;
      if (ts <= boundaryMs) low = true;
      else high = true;
      if (low && high) return true;
    }
  } catch {
    return false;
  }
  return false;
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
    const dest =
      a.retry === undefined
        ? turnArtifactPath(outDir, a.turn, artifactForStem(a.stem))
        : join(outDir, "turns", String(a.turn), `${a.stem}.retry-${a.retry}.jsonl`);
    const from = join(outDir, a.file);
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
    // attributes turn-1 samples to turn 2 — bytes preserved, telemetry wrong. CONTENT decides the
    // attribution; the filename is only a hint.
    if (artifact === "resources.jsonl" && maxArchive > 0) {
      const boundaryMs = completionMtimeOf(outDir, maxArchive);
      if (boundaryMs !== undefined && samplesSpan(from, boundaryMs)) {
        ops.push({
          kind: "split",
          from,
          boundaryMs,
          toLow: turnArtifactPath(outDir, maxArchive, artifact),
          toHigh: turnArtifactPath(outDir, rootTurn, artifact),
        });
        continue;
      }
      // Fallback is explicit, never a guess: if the boundary is unknowable the file stays at the root and
      // is reported. A left-behind root resources.jsonl keeps the dir classified `legacy`, so it remains
      // refused until handled — which is the correct outcome. Refusing beats mislabeling telemetry.
      if (boundaryMs === undefined) {
        return {
          kind: "refuse",
          reason: `cannot determine the turn boundary for a cumulative resources.jsonl (no mtime for result.turn-${maxArchive}.json) — refusing rather than attributing samples by guess`,
        };
      }
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
  const dests = ops.filter((o): o is Extract<MigrationOp, { kind: "move" }> => o.kind === "move").map((o) => o.to);
  const dup = dests.find((d, i) => dests.indexOf(d) !== i);
  if (dup !== undefined)
    return {
      kind: "refuse",
      reason: `two planned operations share destination ${dup.slice(outDir.length + 1)} — refusing rather than letting one silently win`,
    };

  if (ops.length === 0) return { kind: "noop", reason: "already the per-turn layout" };

  const st = statSync(outDir);
  return {
    kind: "plan",
    plan: { outDir, identity: { ino: st.ino, birthtimeMs: st.birthtimeMs }, ops, dirMtimes: { [outDir]: st.mtimeMs } },
  };
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
    if (!Array.isArray(plan.ops) || typeof plan.outDir !== "string") throw new Error("malformed");
  } catch {
    // A torn journal blocks this dir; refusing loudly keeps the batch alive, where an uncaught parse
    // error would abort it and violate "one bad dir never aborts the batch".
    return { kind: "refuse", reason: `unreadable migration journal at ${journal} — resolve or delete it by hand` };
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
