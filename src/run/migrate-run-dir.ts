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

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { PER_TURN_ARTIFACTS, classifyRunDir, listTurns, turnArtifactPath, type PerTurnArtifact } from "./turn-layout.js";
import { parseArgs } from "../cli-args.js";
import { runsWriteRoot } from "./trace-view.js";

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
    // A turn is a positive integer. A fractional or <1 value is not a turn number — trusting it would
    // migrate history into `turns/1.5/`, which `listTurns`' `^\d+$` scan can never address, while a
    // re-assessment then calls the dir "already current". Treat a malformed stamp as absent (the cross-
    // check is corroborating only, never the deciding test — see the header).
    return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : undefined;
  } catch {
    return undefined;
  }
}

/** A turn's completion time — the mtime of its result, wherever that result currently lives.
 *
 *  Checks the root archive FIRST and then `turns/<N>/result.json`, because a partially-migrated dir has
 *  already moved the archive into the turn dir. Looking only at the root made the boundary undiscoverable
 *  on exactly that shape, which silently disabled the resources split: the cumulative file was then
 *  carried whole into one turn, a half-written destination was accepted as telemetry, and the run
 *  reported success. `renameSync` preserves mtimes, so the timestamp is identical in either location. */
function completionMtimeOf(outDir: string, turn: number, rootResultIsTurn?: number): number | undefined {
  // A third location, and the one the telemetry-bearing mixed shape needs: the ROOT `result.json`, when
  // this assessment has already identified it as THAT turn's. Without it every mixed dir carrying a
  // resources file refused for an unknowable boundary — while the plan was holding the very file that
  // dates it. `renameSync` preserves mtimes, so all three locations carry the same timestamp.
  const candidates = [join(outDir, `result.turn-${turn}.json`), turnArtifactPath(outDir, turn, "result.json")];
  if (rootResultIsTurn === turn) candidates.push(join(outDir, "result.json"));
  for (const p of candidates) {
    try {
      if (existsSync(p)) return statSync(p).mtimeMs;
    } catch {
      /* try the next location */
    }
  }
  return undefined;
}

// ── RESOURCES ATTRIBUTION, table-driven ────────────────────────────────────────────────────────────
//
// Every `resources.jsonl` sample was produced DURING some turn. Turn K ran over (completion(K-1),
// completion(K)], where completion(K) is the mtime of turn K's result (renameSync preserves it, so it is
// stable wherever that result currently lives). So attribution is a bucketing of samples by ONE
// whole-directory completion table — not a pile of special cases keyed on directory shape, which is what
// let the same defect recur for four review rounds. Content decides; a filename or a file's position is
// only a hint. A file that cannot be attributed UNAMBIGUOUSLY is refused, by one rule, named.
//
// The op stays the two-way `split`: the real population maxes out at TWO turns (census 2026-07-22), so a
// file spanning ≥3 turns exists nowhere real and is refused rather than adding an N-way op — the crash
// contract and journal are left exactly as four rounds cleared them.

/** One turn in the whole-directory completion table, with its completion time or undefined when that
 *  turn's result cannot be dated. Turn K ran over `(completion(K-1), completion(K)]`. */
interface TurnCompletion {
  turn: number;
  completionMs: number | undefined;
}

/** Every turn that could OWN a sample: `turns/` ∪ ALL archives (a `resources.turn-<N>.jsonl` means turn N
 *  produced telemetry, so N can own samples even though it is undated) ∪ `rootArtifactTurn`. Sorted asc.
 *  Whether such a turn has a HOME to place a file into is a separate question — see `evidencedTurns`. */
function completionTable(
  outDir: string,
  archives: Archive[],
  turns: number[],
  rootArtifactTurn: number,
  rootResultTurn: number,
): TurnCompletion[] {
  const turnSet = new Set<number>(turns);
  for (const a of archives) turnSet.add(a.turn);
  turnSet.add(rootArtifactTurn);
  return [...turnSet].sort((a, b) => a - b).map((turn) => ({ turn, completionMs: completionMtimeOf(outDir, turn, rootResultTurn) }));
}

/** Turns EVIDENCED by a transcript or result — the only turns a resources file may be PLACED into,
 *  whether by position (the empty-file gate) or by content (bucketed samples). Deliberately excludes
 *  resources-only archives: a stray `resources.turn-5.jsonl` must never MINT turn 5 — not when empty, and
 *  not by carrying samples that bucket past every dated completion into its own self-named table entry.
 *  `rootArtifactTurn` counts ONLY when a root transcript or result exists to move there (`rootHasHome`):
 *  without one it is arithmetic (maxArchive+1, or a gap), and placing telemetry by it mints the same
 *  transcript-less `turns/<N>/` through a different channel — a fully-archived dir's trailing sample is
 *  as likely the last real turn's own post-result sample as a phantom next turn's. */
function evidencedTurns(outDir: string, archives: Archive[], turns: number[], rootArtifactTurn: number, rootHasHome: boolean): Set<number> {
  const s = new Set<number>();
  // A `turns/<N>/` that exists but holds NO run.jsonl or result.json is not evidence: it is a crash between
  // turnWriteDir's mkdir and the turn's first write. `listTurns` counts the bare dir (pure enumeration), so
  // seeding from it directly let a trailing resources sample land in an empty dir and mint a telemetry-only
  // turn — the same phantom the archive/rootArtifactTurn gates below refuse. Mirrors currentTurnFromDirs'
  // and assessRunDir's own "no transcript/result = not a real turn".
  for (const n of turns)
    if (existsSync(turnArtifactPath(outDir, n, "run.jsonl")) || existsSync(turnArtifactPath(outDir, n, "result.json"))) s.add(n);
  for (const a of archives) if (a.stem !== "resources") s.add(a.turn);
  if (rootHasHome) s.add(rootArtifactTurn);
  return s;
}

/** The turn a single sample belongs to, or `ambiguous` when the table cannot prove one turn.
 *
 *  Turn at table position `i` owns `(completion(i-1), completion(i)]`. A sample `ts` is assignable ONLY
 *  when both endpoints of the interval it falls in are pinned:
 *   - `ts <= completion[hi]` for the smallest dated `hi` → turn `hi`, but only if `hi`'s predecessor is
 *     dated (else `ts` might be the predecessor's) or `hi` is first;
 *   - `ts` past every dated completion → the highest turn, but only if AT MOST ONE turn follows the last
 *     dated completion (else any of several undated tail turns could own it);
 *   - no dated completion at all → the sole turn if there is one, else ambiguous.
 *  This is the single predicate; there is no separate walk. The undated cases are the ones four review
 *  rounds' successors kept getting wrong. */
function bucketOneSample(ts: number, table: TurnCompletion[]): { turn: number } | { ambiguous: true } {
  const n = table.length;
  let hi = -1;
  for (let i = 0; i < n; i++) {
    const c = table[i].completionMs;
    if (c !== undefined && ts <= c) {
      hi = i;
      break;
    }
  }
  if (hi !== -1) {
    if (hi === 0) return { turn: table[0].turn };
    return table[hi - 1].completionMs === undefined ? { ambiguous: true } : { turn: table[hi].turn };
  }
  // ts is past every dated completion.
  let lastDated = -1;
  for (let i = n - 1; i >= 0; i--)
    if (table[i].completionMs !== undefined) {
      lastDated = i;
      break;
    }
  if (lastDated === -1) return n === 1 ? { turn: table[0].turn } : { ambiguous: true }; // no boundaries: sole turn, else can't tell
  // Turns after `lastDated` are all undated. Unambiguous only if there is at most one of them (or none —
  // then ts is a trailing sample of the dated highest turn).
  return lastDated >= n - 2 ? { turn: table[n - 1].turn } : { ambiguous: true };
}

/** Plan a single resources file (root `resources.jsonl` or a `resources.turn-<N>.jsonl` archive) by the
 *  completion table. `ownTurn` is the turn the file's POSITION names — used only to place an EMPTY file,
 *  and only into an EVIDENCED turn (a transcript/result home), never one it would mint. */
function planResourcesFile(
  outDir: string,
  from: string,
  ownTurn: number,
  table: TurnCompletion[],
  evidenced: Set<number>,
): { kind: "op"; op: MigrationOp } | { kind: "refuse"; reason: string } {
  const rel = from.slice(outDir.length + 1);
  const dest = (turn: number) => turnArtifactPath(outDir, turn, "resources.jsonl");
  const placeInto = (turn: number): { kind: "op"; op: MigrationOp } | { kind: "refuse"; reason: string } => {
    const to = dest(turn);
    if (existsSync(to) && !sameBytes(from, to))
      return { kind: "refuse", reason: `${rel} would overwrite the existing ${to.slice(outDir.length + 1)}` };
    return existsSync(to) ? { kind: "op", op: { kind: "delete", path: from } } : { kind: "op", op: { kind: "move", from, to } };
  };

  let lines: string[];
  try {
    lines = readFileSync(from, "utf8").split("\n").filter(Boolean);
  } catch {
    return { kind: "refuse", reason: `${rel} is unreadable — refusing rather than migrating telemetry it cannot inspect` };
  }

  if (lines.length === 0) {
    // EMPTY: no content to attribute, so it follows its POSITION — but only to an EVIDENCED turn (one
    // with a transcript or result), never one it would mint. A resources archive's own turn is in the
    // completion table but NOT necessarily evidenced, so this check is `evidenced`, not table membership.
    if (!evidenced.has(ownTurn))
      return { kind: "refuse", reason: `${rel} is empty and turn ${ownTurn} is not evidenced by any transcript or result` };
    return placeInto(ownTurn);
  }

  const turnsHit = new Set<number>();
  let sawTimestamp = false;
  for (const line of lines) {
    let ts: number | undefined;
    try {
      const v = (JSON.parse(line) as { ts?: unknown }).ts;
      if (typeof v === "number") ts = v;
    } catch {
      /* unparseable line carries no evidence */
    }
    if (ts === undefined) continue;
    sawTimestamp = true;
    const b = bucketOneSample(ts, table);
    if ("ambiguous" in b)
      return {
        kind: "refuse",
        reason: `${rel} has a sample whose turn cannot be determined (an adjacent turn is undated) — refusing rather than attributing by guess`,
      };
    turnsHit.add(b.turn);
  }
  if (!sawTimestamp)
    return { kind: "refuse", reason: `${rel} has no usable sample timestamps — refusing rather than attributing telemetry by guess` };

  // Same rule as the empty gate, on the CONTENT path: a bucketed turn must be EVIDENCED (a transcript or
  // result home). A resources-only archive puts its turn in the completion table — it can be undated tail
  // there — but placing a file into it would MINT `turns/<N>/` holding nothing but telemetry: a turn with
  // no transcript, which `listTurns` then reports as addressable. The sample could equally be the last
  // real turn's trailing one; a stray filename must not steal it.
  const unevidenced = [...turnsHit].filter((t) => !evidenced.has(t)).sort((a, b) => a - b);
  if (unevidenced.length > 0)
    return {
      kind: "refuse",
      reason: `${rel} has samples that would land in turn${unevidenced.length > 1 ? "s" : ""} ${unevidenced.join(", ")}, which no transcript or result evidences — refusing rather than minting a turn from telemetry alone`,
    };

  const hit = [...turnsHit].sort((a, b) => a - b);
  if (hit.length === 1) return placeInto(hit[0]);

  if (hit.length === 2 && hit[1] === hit[0] + 1) {
    // Exactly two ADJACENT turns → the existing two-way split at the earlier turn's completion.
    const boundaryMs = table.find((e) => e.turn === hit[0])?.completionMs;
    if (boundaryMs === undefined)
      return { kind: "refuse", reason: `${rel} spans turns ${hit.join(" and ")} but turn ${hit[0]}'s completion is undated` };
    const toLow = dest(hit[0]);
    const toHigh = dest(hit[1]);
    for (const d of [toLow, toHigh])
      if (existsSync(d)) return { kind: "refuse", reason: `splitting ${rel} would overwrite the existing ${d.slice(outDir.length + 1)}` };
    return { kind: "op", op: { kind: "split", from, boundaryMs, toLow, toHigh } };
  }

  // ≥3 turns, or two non-adjacent — a single boundary cannot express it. Zero real dirs are ≥3 turns
  // (census), so this refuses a shape that exists nowhere rather than adding an N-way op.
  return {
    kind: "refuse",
    reason: `${rel} spans turns ${hit.join(", ")} — a single boundary cannot attribute more than two adjacent turns`,
  };
}

/** Assess a run dir and return a complete plan, or a refusal. NEVER mutates anything. */
export function assessRunDir(outDir: string): Assessment {
  // READABILITY FIRST. Every shape probe below goes through existsSync/readdir, which report an
  // UNREADABLE directory exactly like an empty one — so a permission error rendered as "aborted stub, no
  // per-turn artifacts to migrate", exit 0. For a migration tool "could not look" must never be
  // indistinguishable from "nothing to do": the first is unfinished work, the second is done.
  try {
    readdirSync(outDir);
  } catch (e) {
    return {
      kind: "refuse",
      reason: `cannot read ${outDir}: ${(e as Error).message} — refusing rather than reporting it as having nothing to migrate`,
    };
  }

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

  const turns = listTurns(outDir);

  // ONE TURN FOR ALL ROOT ARTIFACTS. They were written by a single turn, and only `result.json` carries a
  // `.turn` stamp — a transcript or trace has no way to identify itself. Deciding per-artifact meant a
  // stamped result landed in `turns/1` while its own run.jsonl refused for having no stamp, on exactly the
  // mixed shape every refusal message routes to this command.
  //
  // The stamp may fill a GAP in the existing sequence, including a turn dir that does not exist yet, but
  // never invent a slot BEYOND the highest turn on disk: `turns/2` beside a root result stamped turn 1 is
  // a real pre-layout resume, whereas a result stamped turn 9 beside `turns/1` is not evidence that turns
  // 2-9 happened, and materialising `turns/9` would fabricate history from one field.
  let rootArtifactTurn = rootTurn;
  if (turns.length > 0) {
    const highestOnDisk = Math.max(...turns);
    const stamp = existsSync(join(outDir, "result.json")) ? stampedTurn(join(outDir, "result.json")) : undefined;
    const firstGap = [...Array(highestOnDisk).keys()].map((i) => i + 1).find((n) => !turns.includes(n));
    if (stamp !== undefined && stamp <= highestOnDisk && !turns.includes(stamp)) rootArtifactTurn = stamp;
    else if (stamp !== undefined && stamp <= highestOnDisk)
      rootArtifactTurn = stamp; // an existing turn: per-artifact rules below decide
    else if (firstGap !== undefined) rootArtifactTurn = firstGap;
    else rootArtifactTurn = highestOnDisk;
  }

  // One completion table for the whole directory. Every resources file — root and archive — buckets
  // against it, so there is a single notion of which turn a sample belongs to.
  const table = completionTable(outDir, archives, turns, rootArtifactTurn, rootArtifactTurn);
  const rootHasHome = existsSync(join(outDir, "run.jsonl")) || existsSync(join(outDir, "result.json"));
  const evidenced = evidencedTurns(outDir, archives, turns, rootArtifactTurn, rootHasHome);

  for (const a of archives) {
    const from = join(outDir, a.file);

    // An ARCHIVE-NAMED resources file can be cumulative too — the resume fix mints exactly that by
    // renaming a spanning root `resources.jsonl` to `resources.turn-<prior>.jsonl`. Trusting the name
    // would carry turn-N and turn-N+1 samples into one slot. CONTENT decides; the filename is only the
    // POSITION used to place an empty one.
    if (a.stem === "resources" && a.retry === undefined) {
      const r = planResourcesFile(outDir, from, a.turn, table, evidenced);
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

  for (const artifact of rootArtifacts) {
    const from = join(outDir, artifact);

    // A root `resources.jsonl` buckets against the same whole-dir table as every archive one — its
    // POSITION (rootArtifactTurn) is used only to place it when empty. Whether it is cumulative (samples
    // spanning two turns → split) or one turn's own (single bucket → move) is decided by CONTENT, not by
    // the directory's shape. The old shape-keyed discriminator (`rootIsLatest`/`highestTurn-1`) is where
    // a whole class of misplacement lived: it split a gap-filling root file across the wrong boundary.
    if (artifact === "resources.jsonl") {
      const r = planResourcesFile(outDir, from, rootArtifactTurn, table, evidenced);
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
    // BYTE-IDENTITY PROVES "ALREADY STORED" ONLY FOR THE SLOT THIS ARTIFACT RESOLVES TO.
    //
    // Dropping on a match against ANY turn destroyed data on this branch's own canonical shape: two
    // tool-less turns produce identical minimal traces, so a root trace.json (turn 1's) matched
    // turns/2/trace.json and was DELETED — on a success path, leaving turns/1 without one. The same held
    // for an empty transcript, manufacturing the "result without a run.jsonl" state that
    // `currentTurnFromDirs` defines as not-a-turn.
    //
    // Matching a DIFFERENT turn means the opposite of duplication: this copy is the only instance of its
    // own turn's artifact. So compare against the resolved slot only, and let everything else fall through
    // to placement. (That restriction was originally scoped to non-self-labeling artifacts; the shape
    // above shows an empty run.jsonl has the same problem, so it applies to all four.)
    // Compare against the RESOLVED slot directly, not find-first. A root trace identical to BOTH turns
    // (two tool-less turns) resolves to `rootArtifactTurn` but find-first returned turn 1, so an artifact
    // that WAS a duplicate of its own slot fell through to a spurious "neither a duplicate nor placeable".
    if (sameBytes(from, turnArtifactPath(outDir, rootArtifactTurn, artifact))) {
      ops.push({ kind: "delete", path: from });
      continue;
    }
    // WHERE DOES IT GO? The artifact's own `.turn` stamp decides when it has one — including into a slot
    // that does not exist yet. Searching only EXISTING turn dirs meant the canonical mixed shape (root
    // turn-1 artifacts beside `turns/2/`, i.e. a pre-layout dir resumed under current code) was refused
    // with "every turn already has one" while `turns/1` did not exist at all. Six commands route users
    // here with "Convert it in place"; refusing that shape closed the loop the branch's whole UX rests on.
    const free = (n: number): boolean => !existsSync(turnArtifactPath(outDir, n, artifact));
    const slot = free(rootArtifactTurn) ? rootArtifactTurn : turns.find(free);
    if (slot === undefined)
      return {
        kind: "refuse",
        reason: `root ${artifact} is neither a duplicate of any turn nor placeable — every existing turn already has one`,
      };
    // A stamp that disagrees with the chosen slot means the file is not what the layout says it is;
    // placing it anyway would fabricate a turn. Refuse rather than guess.
    const ownStamp = selfLabeling ? stampedTurn(from) : undefined;
    if (ownStamp !== undefined && ownStamp !== slot)
      return { kind: "refuse", reason: `root ${artifact} is stamped turn ${ownStamp} but it would be placed in turn ${slot}` };
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

/** Remove a journal and any directory it leaves empty behind it.
 *
 *  Removing only the file left one `.migrating/<scenario>/` shell per scenario — 96 of them on a real
 *  runs root — which reads as a migration still in flight even though nothing is pending. `rmdirSync`
 *  fails harmlessly when the directory still holds another journal, so a scenario with one crashed and
 *  one successful dir keeps the shared parent (and the survivor's record) intact. */
function removeJournal(path: string): void {
  rmSync(path, { force: true });
  for (const dir of [dirname(path), dirname(dirname(path))]) {
    try {
      rmdirSync(dir); // throws ENOTEMPTY when anything is still in there — exactly the wanted guard
    } catch {
      return; // stop climbing at the first non-empty level
    }
  }
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
  removeJournal(journal);
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
    // Deliberately does NOT say "delete it". A journal records a half-applied plan, and deleting it
    // leaves the directory in a state the assessor must reconstruct from the files alone — which is how
    // a torn split destination once got laundered as real telemetry. Moving it aside preserves the
    // evidence; the dir stays refused until a human looks, which is the safe resting state.
    return {
      kind: "refuse",
      reason:
        `unreadable or malformed migration journal at ${journal} — this run dir is half-migrated. ` +
        `Move the journal aside (do not delete it: it is the only record of what was already applied) and inspect the dir before retrying.`,
    };
  }

  // IDENTITY. Without this a journal outlives its directory: if the dir was deleted and a fresh run later
  // reused the same scenario/runId path, the stale plan would replay onto it — mislabeling the new run
  // and minting phantom turns, reported as success.
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(outDir);
  } catch {
    removeJournal(journal);
    return { kind: "orphaned" };
  }
  if (st.ino !== plan.identity?.ino || Math.round(st.birthtimeMs) !== Math.round(plan.identity?.birthtimeMs)) {
    removeJournal(journal);
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
  removeJournal(journal);
  return { kind: "recovered" };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// CLI — `cowork-harness migrate-run-dir [<runs-dir>] [--write] [--verbose]`

export interface MigrationReport {
  migrated: number;
  recovered: number;
  noop: number;
  skipped: number;
  /** Journals whose run dir no longer exists, removed by the sweep. */
  orphaned: number;
  refused: { dir: string; reason: string }[];
}

/** Remove journals whose run dir is gone.
 *
 *  The walk below iterates RUN DIRS, so a journal for a deleted dir is never visited — and `prune` skips
 *  any scenario with a live journal, printing "run migrate-run-dir to finish". Without this sweep that
 *  advice is false: the migrator never touches the journal, so the scenario is skipped forever and
 *  nothing in the system can clear it. */
function sweepOrphanedJournals(runsRoot: string, write: boolean, onlyScenario?: string): number {
  const journalRoot = journalRootFor(runsRoot);
  let swept = 0;
  let scenarios: string[];
  try {
    scenarios = readdirSync(journalRoot);
  } catch {
    return 0; // no journal store — the ordinary case
  }
  for (const scenario of scenarios) {
    // --scenario stages a rollout one scenario at a time; the sweep is a mutation and a count, so it must
    // stay inside that scope too. Sweeping another scenario's journal here (before the walker's own filter)
    // removed state the scoped run never asked to touch, and reported it under the scoped run's totals.
    if (onlyScenario !== undefined && scenario !== onlyScenario) continue;
    const dir = join(journalRoot, scenario);
    let files: string[];
    try {
      if (!statSync(dir).isDirectory()) continue;
      files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      continue;
    }
    for (const f of files) {
      const runDir = join(runsRoot, scenario, f.replace(/\.json$/, ""));
      if (existsSync(runDir)) continue; // still live — recovery owns it
      swept++;
      if (write) {
        try {
          removeJournal(join(dir, f));
        } catch {
          /* best-effort: a journal we cannot remove is reported, not fatal */
        }
      }
    }
  }
  return swept;
}

/** Walk a runs root, recovering any interrupted migration and then migrating what needs it.
 *
 *  `write: false` (the DEFAULT) plans and reports without touching anything — with thousands of
 *  directories at stake the safe mode has to be the one you get by accident. Recovery is attempted FIRST
 *  for every dir: assessing a half-migrated directory and executing a fresh plan over it would clobber
 *  the journal that records what was already done. */
export function migrateRunsRoot(
  runsRoot: string,
  opts: { write: boolean; scenario?: string; onDir?: (dir: string, outcome: string) => void },
): MigrationReport {
  const report: MigrationReport = { migrated: 0, recovered: 0, noop: 0, skipped: 0, orphaned: 0, refused: [] };
  const journalRoot = journalRootFor(runsRoot);
  if (!existsSync(runsRoot)) return report;
  report.orphaned = sweepOrphanedJournals(runsRoot, opts.write, opts.scenario);

  for (const scenario of readdirSync(runsRoot).sort()) {
    if (scenario === MIGRATION_JOURNAL_DIR) continue;
    // Scoping exists so a rollout can be staged one scenario at a time — migrating 1,630 directories in
    // a single irreversible step is exactly the thing the dry-run/backup ritual is trying to avoid.
    if (opts.scenario !== undefined && scenario !== opts.scenario) continue;
    const scenarioDir = join(runsRoot, scenario);
    let ids: string[];
    try {
      if (!statSync(scenarioDir).isDirectory()) continue;
      ids = readdirSync(scenarioDir).sort();
    } catch {
      continue;
    }

    for (const id of ids) {
      const dir = join(scenarioDir, id);
      // One bad directory must never abort the batch, so every per-dir failure becomes a refusal row.
      try {
        if (!statSync(dir).isDirectory()) continue;

        if (opts.write) {
          const rec = recoverIfNeeded(dir, { journalRoot });
          if (rec.kind === "refuse") {
            report.refused.push({ dir, reason: rec.reason });
            opts.onDir?.(dir, "refuse");
            continue;
          }
          if (rec.kind === "recovered") {
            report.recovered++;
            opts.onDir?.(dir, "recovered");
            continue;
          }
        }

        const a = assessRunDir(dir);
        if (a.kind === "refuse") {
          report.refused.push({ dir, reason: a.reason });
        } else if (a.kind === "skip") {
          report.skipped++;
        } else if (a.kind === "noop") {
          report.noop++;
        } else {
          if (opts.write) executeMigration(a.plan, { journalRoot });
          report.migrated++;
        }
        // Report the OUTCOME, not the assessment kind: a dir that was migrated should not say "plan".
        opts.onDir?.(dir, a.kind === "plan" ? (opts.write ? "migrated" : "to-migrate") : a.kind);
      } catch (e) {
        report.refused.push({ dir, reason: (e as Error).message });
        opts.onDir?.(dir, "refuse");
      }
    }
  }
  return report;
}

/** `cowork-harness migrate-run-dir [<runs-dir>] [--write] [--verbose]`
 *
 *  DRY-RUN IS THE DEFAULT. Writing requires `--write`. With thousands of directories of unre-runnable
 *  history at stake, the safe mode has to be the one you get by accident. */
export function cmdMigrateRunDir(args: string[]): void {
  const out = (s: string) => process.stderr.write(s + "\n");
  let p;
  try {
    p = parseArgs(args, { booleans: ["--write", "--verbose"], values: ["--scenario"] });
  } catch (e) {
    out((e as Error).message);
    return process.exit(2);
  }
  if (p.positionals.length > 1) {
    out(`migrate-run-dir takes an optional <runs-dir> (got ${p.positionals.length}: ${p.positionals.join(", ")})`);
    return process.exit(2);
  }

  const write = p.flags["--write"] ?? false;
  const scenario = p.options["--scenario"];
  const verbose = p.flags["--verbose"] ?? false;
  const runsRoot = p.positionals[0] ?? runsWriteRoot();
  if (!existsSync(runsRoot)) {
    out(`✓ migrate-run-dir: ${runsRoot} does not exist — nothing to migrate`);
    return process.exit(0);
  }

  // An unknown scenario must not look like a clean no-op: "0 to migrate" is what success also prints.
  if (scenario !== undefined && !existsSync(join(runsRoot, scenario))) {
    out(`migrate-run-dir: no scenario "${scenario}" under ${runsRoot}`);
    return process.exit(2);
  }

  const r = migrateRunsRoot(runsRoot, {
    write,
    scenario,
    onDir: verbose ? (dir, outcome) => out(`  ${outcome.padEnd(9)} ${dir}`) : undefined,
  });

  const prefix = write ? "" : "(dry-run) ";
  // Past tense once the work is done: "N to migrate" after migrating reads as if nothing happened.
  const verb = write ? "migrated" : "to migrate";
  out(
    `${prefix}migrate-run-dir: ${r.migrated} ${verb} · ${r.recovered} recovered · ${r.orphaned} orphaned journal(s) swept · ${r.noop} already current · ` +
      `${r.skipped} skipped (no per-turn artifacts) · ${r.refused.length} refused`,
  );
  // Refusals are ENUMERATED, never just counted: each one is a directory a human has to look at, and a
  // bare count is indistinguishable from "nothing to do here".
  for (const { dir, reason } of r.refused) out(`  ✗ ${dir}\n      ${reason}`);
  if (!write && r.migrated > 0) out(`\nRe-run with --write to apply. Back up ${runsRoot} first.`);
  // The index derives a row's timestamp from result.json's mtime, so it must be rebuilt from the moved
  // files. Saying so here is the difference between a documented rollout step and one people actually do.
  if (write && (r.migrated > 0 || r.recovered > 0)) out(`\nNow rebuild the index: cowork-harness stats --reindex`);

  // Non-zero when anything was refused: a refusal is unfinished work, and a CI caller must see it.
  return process.exit(r.refused.length > 0 ? 1 : 0);
}
