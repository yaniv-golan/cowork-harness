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

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PER_TURN_ARTIFACTS, classifyRunDir, listTurns, type PerTurnArtifact } from "./turn-layout.js";

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
    listTurns(outDir).some((n) => existsSync(join(outDir, "turns", String(n), "run.jsonl")));
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
        ? join(outDir, "turns", String(a.turn), artifactForStem(a.stem))
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

    if (turns.length === 0) {
      // No `turns/` yet: the per-dir mapping governs.
      ops.push({ kind: "move", from, to: join(outDir, "turns", String(rootTurn), artifact) });
      continue;
    }

    // `turns/` exists: the 3-branch rule governs, ALWAYS. (The N+1 mapping applies only when `turns/`
    // is absent — otherwise both claim the same file and one reading renames onto an occupied slot.)
    const selfLabeling = artifact === "result.json" || artifact === "run.jsonl";
    const identicalTo = turns.find((n) => sameBytes(from, join(outDir, "turns", String(n), artifact)));
    if (selfLabeling && identicalTo !== undefined) {
      ops.push({ kind: "delete", path: from });
      continue;
    }
    // Lowest slot lacking this artifact. For non-self-labeling artifacts (trace/resources) byte-identity
    // is not proof of duplication — an empty file matches any other empty file — so they only ever move.
    const slot = turns.find((n) => !existsSync(join(outDir, "turns", String(n), artifact)));
    if (slot === undefined)
      return {
        kind: "refuse",
        reason: `root ${artifact} is neither a duplicate of any turn nor placeable — every turn already has one`,
      };
    const stamp = selfLabeling ? stampedTurn(from) : undefined;
    if (stamp !== undefined && stamp !== slot)
      return { kind: "refuse", reason: `root ${artifact} is stamped turn ${stamp} but the only free slot is turn ${slot}` };
    ops.push({ kind: "move", from, to: join(outDir, "turns", String(slot), artifact) });
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
