// Queryable cross-run result store. index.jsonl (one JSON line per run) is the SOURCE OF TRUTH for
// "what runs exist" — the run-dir-per-run physical layout (<runsRoot>/<slug>/<runId>/) still holds the
// heavy artifacts (events.jsonl/trace.json/result.json); only the discovery/query layer moved here.
import { existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync, lstatSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, basename, dirname } from "node:path";
import type { RunResult } from "../types.js";
import { computeVerdict } from "./verdict.js";
import { budgetFields } from "../assert.js";
import { warn, writeTextAtomic } from "../io.js";
import { containedRealPath } from "../boundary-paths.js";

export interface RunIndexRow {
  v: 1;
  ts: string; // ISO
  command: "run" | "skill" | "record" | "chat";
  scenario: string;
  slug: string; // the <runsRoot>/<slug>/ path segment (slugForPath(scenario) at write time)
  runId: string; // the <slug>/<runId>/ path segment — local_<hrtime> | sess-<id>
  fidelity: string;
  effectiveFidelity?: string;
  baseline: string;
  result: "success" | "error";
  pass: boolean;
  // Run-identity (iterate-across-fixes loop): the human --label tag + a short prefix of the AUTHORITATIVE
  // content-exact skill-version key (fingerprint.skillHash) — so a harvest/group-by step reads both off
  // the index without opening each result.json. Additive-optional (no `v` bump). Re-derived honestly by
  // reindexFromRunsTree from result.json (unlike `git`).
  runLabel?: string;
  skillHash?: string;
  // 1-based turn number within a resumed (`--session-id`+`--resume`) session, straight from
  // RunResult.turn — set on essentially every run/skill/record completion (a fresh single-shot run gets
  // turn:1). THE per-completion identity discriminator `reindexFromRunsTree` merges rows by: a resumed
  // session's turns (and critique's task+reflection turns) all share one `outDir`, so `outDir` alone is
  // not a valid identity for them. Absent on the chat lane (never tracked) and on rows written before
  // this field existed.
  turn?: number;
  signals: string[]; // VerdictSignal["code"][]
  costUsd?: number;
  tokens?: number;
  turns?: number;
  cacheReadTokens?: number; // summed across all models in RunResult.modelUsage (stats surfacing)
  modelCostUsd?: number; // summed across all models in RunResult.modelUsage
  durationMs?: number;
  partial: boolean;
  nonDeterministic: boolean;
  outDir: string;
  git: { branch: string | null; sha: string | null };
}

/** Best-effort `git rev-parse` in cwd — null outside a repo (or if git isn't on PATH). Never throws. */
function gitInfo(): { branch: string | null; sha: string | null } {
  const rev = (args: string[]): string | null => {
    try {
      return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
    } catch {
      return null;
    }
  };
  return { branch: rev(["rev-parse", "--abbrev-ref", "HEAD"]), sha: rev(["rev-parse", "HEAD"]) };
}

/** RunResult.outDir is `<runsRoot>/<slug>/<runId>` — the slug/runId pair IS the physical layout's own
 *  addressing, so derive them from there rather than re-deriving from `scenario` (slugForPath is already
 *  applied once at write time; re-slugifying here could theoretically drift if the algorithm ever changes). */
function slugAndRunIdFromOutDir(outDir: string): { slug: string; runId: string } {
  return { runId: basename(outDir), slug: basename(dirname(outDir)) };
}

/** Turns a real RunResult into an index row, reusing computeVerdict/budgetFields rather than re-deriving
 *  pass/fail or cost from scratch — same "don't re-implement verdict logic per writer" principle as
 *  the repeat/matrix rollups. NOT pure by default (`ts`/`git` default to "now"/the current checkout, both real I/O)
 *  — correct for the LIVE-write call sites (execute.ts, right as a run completes: "now" and "this
 *  checkout" ARE the truth). `reindexFromRunsTree` overrides both explicitly, because for a HISTORICAL run
 *  being walked off disk, "now" and "the checkout doing the reindexing" are not the run's actual
 *  provenance — they'd be fabricated, not derived. */
export function indexRowFromResult(
  result: RunResult,
  opts: {
    command: "run" | "skill" | "record" | "chat";
    partial: boolean;
    ts?: string;
    git?: { branch: string | null; sha: string | null };
  },
): RunIndexRow {
  const verdict = computeVerdict(result, "live");
  const budget = budgetFields(result);
  const { slug, runId } = slugAndRunIdFromOutDir(result.outDir);
  // Separate from budgetFields — sums across RunResult.modelUsage's per-model entries, a
  // different data source than the SDK result message's own cost/usage totals.
  const modelUsageEntries = result.modelUsage ? Object.values(result.modelUsage) : undefined;
  const cacheReadTokens = modelUsageEntries?.reduce(
    (sum, m) => sum + (typeof m.cacheReadInputTokens === "number" ? m.cacheReadInputTokens : 0),
    0,
  );
  const modelCostUsd = modelUsageEntries?.reduce((sum, m) => sum + (typeof m.costUSD === "number" ? m.costUSD : 0), 0);
  return {
    v: 1,
    ts: opts.ts ?? new Date().toISOString(),
    command: opts.command,
    scenario: result.scenario,
    slug,
    runId,
    fidelity: result.fidelity,
    effectiveFidelity: result.effectiveFidelity,
    baseline: result.baseline,
    result: result.result,
    pass: verdict.pass,
    runLabel: result.runLabel,
    skillHash: result.fingerprint?.skillHash?.slice(0, 12), // short prefix — the full hash lives in result.json
    turn: result.turn,
    signals: verdict.signals.map((s) => s.code),
    costUsd: budget.costUsd,
    tokens: budget.tokensTotal,
    turns: budget.turns,
    cacheReadTokens,
    modelCostUsd,
    durationMs: result.durationMs,
    partial: opts.partial,
    nonDeterministic: !!result.nonDeterministic,
    outDir: result.outDir,
    git: opts.git ?? gitInfo(),
  };
}

function indexPath(runsRoot: string): string {
  return join(runsRoot, "index.jsonl");
}

/** The stable event identity `reindexFromRunsTree` merges rows by — NEVER `outDir` alone, which is a
 *  mutable STORAGE LOCATION, not an event: a resumed session's every turn (and critique's task +
 *  reflection turns) write to the same `outDir`. When `turn` is present (essentially every run/skill/record
 *  row from now on) it precisely distinguishes one completion from another sharing that outDir. Rows with
 *  no `turn` (the chat lane, or a row written before this field existed) fall back to bare `outDir` —
 *  this module's historical behavior for that case, and the only signal available to disambiguate them;
 *  it is not a fix for pre-existing legacy data, only for every row written going forward. */
function rowIdentity(r: RunIndexRow): string {
  return r.turn !== undefined ? `${r.outDir} turn:${r.turn}` : r.outDir;
}

/** Runtime shape check for a parsed index line — `JSON.parse` only proves valid JSON, not a valid
 *  `RunIndexRow`; a same-shaped-but-wrong-typed object (or one from an incompatible future schema) must
 *  never be cast and handed to `buildStats`, which dereferences `r.git.branch` unconditionally. Uses the
 *  otherwise-unused `v` field as the schema-version gate: anything not exactly `v:1` is rejected outright
 *  rather than assumed compatible. */
function isValidRunIndexRow(x: unknown): x is RunIndexRow {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  if (r.v !== 1) return false;
  if (typeof r.ts !== "string") return false;
  if (typeof r.command !== "string" || !["run", "skill", "record", "chat"].includes(r.command)) return false;
  if (typeof r.scenario !== "string") return false;
  if (typeof r.slug !== "string") return false;
  if (typeof r.runId !== "string") return false;
  if (typeof r.fidelity !== "string") return false;
  if (typeof r.baseline !== "string") return false;
  if (r.result !== "success" && r.result !== "error") return false;
  if (typeof r.pass !== "boolean") return false;
  if (!Array.isArray(r.signals)) return false;
  if (typeof r.partial !== "boolean") return false;
  if (typeof r.nonDeterministic !== "boolean") return false;
  if (typeof r.outDir !== "string") return false;
  // Type-checked because `rowIdentity` interpolates it: a string "2" would otherwise mint an identity
  // distinct from the numeric 2 the walk derives, resurrecting the duplicate-row failure the merge guards.
  if (r.turn !== undefined && typeof r.turn !== "number") return false;
  if (typeof r.git !== "object" || r.git === null) return false;
  const git = r.git as Record<string, unknown>;
  if (git.branch !== null && typeof git.branch !== "string") return false;
  if (git.sha !== null && typeof git.sha !== "string") return false;
  return true;
}

/** Single-line O_APPEND write — atomic at these sizes, safe under `record --concurrency`'s in-process
 *  pool (same reasoning as the writer note in async-pool.ts). Creates `runsRoot` if it doesn't exist yet
 *  (a fresh machine's first run). */
export function appendIndexRow(runsRoot: string, row: RunIndexRow): void {
  mkdirSync(runsRoot, { recursive: true });
  appendFileSync(indexPath(runsRoot), JSON.stringify(row) + "\n");
}

/** Reads every row, tolerating a corrupt/truncated TRAILING line (a crash mid-append) by skipping just
 *  that line rather than throwing and losing every prior row. Also validates every successfully-parsed
 *  line against the `RunIndexRow` shape (see `isValidRunIndexRow`) and quarantines (skips, with a warning)
 *  any row that is valid JSON but the wrong shape — the returned array is never a blind cast. Returns `[]`
 *  for a runs root with no index.jsonl yet — never throws on a fresh clone / pre-index-era runs root. */
export function readIndex(runsRoot: string): RunIndexRow[] {
  const p = indexPath(runsRoot);
  if (!existsSync(p)) return [];
  const rows: RunIndexRow[] = [];
  const lines = readFileSync(p, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      // Valid JSON, wrong shape (or an incompatible future `v`) — quarantined, not cast: a cast row
      // reaches `buildStats`, which dereferences `r.git.branch` unconditionally and either throws or
      // fabricates a pass/cost value. This is a DIFFERENT failure mode from the corrupt-JSON branch below
      // (which `.catch`es a parse error) and always warns — there is no "expected trailing" shape for a
      // syntactically-valid-but-wrong-schema row.
      if (!isValidRunIndexRow(parsed)) {
        warn(
          `::warning:: stats: quarantining invalid-shape row ${i + 1} of ${indexPath(runsRoot)} (valid JSON, wrong RunIndexRow shape — not indexed, not counted): ${line.slice(0, 120)}\n`,
        );
        continue;
      }
      rows.push(parsed);
    } catch {
      // A truncated TRAILING line (the last non-empty line) is the expected shape of a crash
      // mid-append — tolerated silently, one lost row is the documented worst case. A corrupt line
      // ANYWHERE ELSE is not that failure mode — it's the one observable symptom of a genuine
      // concurrent-write interleaving bug (or manual file corruption), and silently vanishing it would
      // mask exactly the risk this module's own docs call out. Warn, don't stay quiet.
      const isTrailing = lines.slice(i + 1).every((l) => !l.trim());
      if (!isTrailing)
        warn(
          `::warning:: stats: skipping corrupt line ${i + 1} of ${indexPath(runsRoot)} (not the trailing line — investigate, don't just --reindex over it): ${line.slice(0, 120)}\n`,
        );
    }
  }
  return rows;
}

/** Discriminated outcome of reading ONE on-disk result file (the root `result.json`, or an archived
 *  `result.turn-<N>.json`) during a `reindexFromRunsTree` walk. A plain row-or-null return would force the
 *  caller to re-derive which counter (`skipped`/`skippedReplay`/`skippedUnsafe`) a given failure maps to;
 *  returning the classification instead keeps that mapping in one place — the walk loop below — for both
 *  the root file and every archived turn, rather than two hand-rolled copies that could drift apart. */
type WalkedResultFile =
  | { kind: "row"; row: RunIndexRow }
  | { kind: "missing" } // no such file, or not a regular file — not countable evidence, no counter moves
  | { kind: "unsafe" } // a symlink, or resolves outside runsRoot — counted as skippedUnsafe
  | { kind: "corrupt" } // safely resolved but the containment check raced or the JSON didn't parse — counted as skipped
  | { kind: "replay" }; // a command:"replay" result — a re-check, not new evidence — counted as skippedReplay

/** Symlink-rejecting, containment-checked, replay-aware read of one result file for the walk below. Shared
 *  by the root `result.json` and every archived `result.turn-<N>.json` in a run dir so an archived turn
 *  gets EXACTLY the same defense-in-depth (never follow a symlink; require the real path to resolve inside
 *  `runsRoot`) and the same "a corrupt file is skipped, not fatal to the whole walk" handling the root file
 *  always had — not a hand-rolled variant for the archived case. */
function readResultFileForWalk(
  runsRoot: string,
  outDir: string,
  filePath: string,
  priorByOutDir: Map<string, RunIndexRow>,
): WalkedResultFile {
  let fileLstat;
  try {
    fileLstat = lstatSync(filePath);
  } catch {
    return { kind: "missing" }; // same miss the old existsSync(resultPath) check caught
  }
  if (fileLstat.isSymbolicLink()) return { kind: "unsafe" };
  if (!fileLstat.isFile()) return { kind: "missing" };
  // Both sides are confirmed to exist (lstat above) and neither is a symlink (rejected above) — realpath
  // containment is still checked as defense-in-depth against a non-symlink escape (e.g. a TOCTOU swap of
  // an ancestor component). `realpathSync` inside throws if the entry is deleted between the lstat above
  // and this call (a concurrent `runs gc`, say). Treat that as an ordinary miss — before containment
  // checking existed the same race was absorbed as `skipped++`, and letting the raw ENOENT escape would
  // abort the entire reindex over one vanished run dir.
  let contained: boolean;
  try {
    contained = containedRealPath(runsRoot, filePath);
  } catch {
    return { kind: "corrupt" };
  }
  if (!contained) return { kind: "unsafe" };
  try {
    const result = JSON.parse(readFileSync(filePath, "utf8")) as RunResult;
    // A `command:"replay"` result is a RE-CHECK, not new evidence — see the matching comment on the walk
    // loop below for why this must never be relabeled "run" and indexed as fresh evidence.
    if (result.command === "replay") return { kind: "replay" };
    const ts = fileLstat.mtime.toISOString(); // confirmed a regular (non-symlink) file above
    // RunResult.mode has no "skill"/"record" value, so a run originally recorded under one of those
    // commands would otherwise be relabeled "run"/"chat" on every reindex. Prefer the command now
    // persisted in result.json (#48); fall back to a prior index row (for results written before that
    // field existed), then to deriving from `result.mode` for a brand-new outDir with neither.
    const prior = priorByOutDir.get(outDir);
    // `result.command` here is already narrowed to exclude "replay" (returned above), so it maps straight
    // onto the index row's command union — no re-check ever reaches this row.
    const command = result.command ?? prior?.command ?? (result.mode === "chat" ? "chat" : "run");
    const row = indexRowFromResult(result, { command, partial: !!result.partial, ts, git: { branch: null, sha: null } });
    return { kind: "row", row };
  } catch {
    return { kind: "corrupt" };
  }
}

/** One-time local migration + self-heal: rebuilds index.jsonl by walking the physical
 *  `<runsRoot>/<slug>/<runId>/result.json` tree, MERGED with any prior index.jsonl — never a blind
 *  overwrite. Every run dir still on disk gets a FRESH row (re-derived from its real result.json,
 *  replacing any stale prior entry for that same outDir); every prior row whose outDir is no longer on
 *  disk (deleted by `prune`) is PRESERVED as-is. This is what makes "the index is the durable history"
 *  (docs/stats.md) actually true across a reindex, not just across ordinary writes — an earlier version of
 *  this function did a full overwrite, which silently discarded every pruned run's history on the very
 *  operation meant to rebuild/heal it. Safe to re-run (idempotent: reindexing twice with no filesystem
 *  changes produces the same row set).
 *
 *  Also walks every ARCHIVED turn (`result.turn-<N>.json`) in the run dir, not just the root — a
 *  `--resume` session or a `critique` task+reflection pair archives earlier turns when a later one
 *  overwrites `result.json` (execute.ts's archivePriorTurnFiles), and reading only the root would silently
 *  DROP them on a scratch rebuild. For a `critique` dir specifically the root IS the reflection turn, so
 *  that drop would keep the reflection row and lose the GRADED row — the one consumers pair generations
 *  on. See `readResultFileForWalk` for the per-file handling shared between the root and every archive.
 *
 *  `ts`/`git` for a freshly-walked row are NOT "now"/"this checkout" — those would be fabricated
 *  provenance for a run that may have happened days/branches ago. `ts` is the result file's own mtime
 *  (the closest available proxy for "when this run completed"); `git` is honestly `{branch:null,sha:null}`
 *  (unknowable from a bare result.json). `gitInfo()` is intentionally never called during a walk (it was
 *  in an earlier version, once per row — a real perf cost, N subprocess spawns for N run dirs, for a value
 *  that was wrong anyway).
 *
 *  A missing/corrupt result.json is skipped, not fatal — a partial/crashed run dir shouldn't block indexing
 *  everything else. A slug/runId directory entry, or a result file itself, that is a SYMLINK is rejected
 *  outright (never followed) and its real path is additionally required to resolve inside `runsRoot` before
 *  it is opened — a symlinked entry under the runs root must never cause an arbitrary external file to be
 *  read and indexed as harness evidence.
 *
 *  The MERGE below keys prior rows by `rowIdentity` (turn-aware), never by bare `outDir` — a resumed
 *  session's turns (and critique's task+reflection turns) legitimately share one `outDir`, and keying by
 *  that alone would collapse N historical rows down to one on every reindex. */
export function reindexFromRunsTree(runsRoot: string): {
  rows: RunIndexRow[];
  written: number;
  skipped: number;
  skippedReplay: number;
  skippedUnsafe: number;
} {
  const priorRows = readIndex(runsRoot);
  // Command-inheritance fallback ONLY (see below) — last-one-wins-per-outDir is fine for a heuristic hint,
  // but must never be the thing that decides which HISTORICAL rows survive a reindex (that collapse was
  // the actual defect: a mutable storage location standing in for an event identity).
  const priorByOutDir = new Map<string, RunIndexRow>();
  for (const r of priorRows) priorByOutDir.set(r.outDir, r);
  const priorByIdentity = new Map<string, RunIndexRow>();
  for (const r of priorRows) priorByIdentity.set(rowIdentity(r), r);

  const walkedIdentities = new Set<string>();
  const walked: RunIndexRow[] = [];
  let skipped = 0;
  let skippedReplay = 0;
  let skippedUnsafe = 0;
  if (existsSync(runsRoot)) {
    for (const slug of readdirSync(runsRoot)) {
      const slugDir = join(runsRoot, slug);
      let slugLstat;
      try {
        slugLstat = lstatSync(slugDir);
      } catch {
        continue;
      }
      if (slugLstat.isSymbolicLink()) {
        skippedUnsafe++;
        continue;
      }
      if (!slugLstat.isDirectory()) continue;
      for (const runId of readdirSync(slugDir)) {
        const outDir = join(slugDir, runId);
        let outDirLstat;
        try {
          outDirLstat = lstatSync(outDir);
        } catch {
          continue;
        }
        if (outDirLstat.isSymbolicLink()) {
          skippedUnsafe++;
          continue;
        }
        if (!outDirLstat.isDirectory()) continue;
        const resultPath = join(outDir, "result.json");
        const rootOutcome = readResultFileForWalk(runsRoot, outDir, resultPath, priorByOutDir);
        if (rootOutcome.kind === "missing") continue; // no result.json here — nothing to index for this outDir
        if (rootOutcome.kind === "unsafe") {
          skippedUnsafe++;
          continue;
        }
        if (rootOutcome.kind === "corrupt") {
          skipped++;
          continue;
        }
        if (rootOutcome.kind === "replay") {
          // `continue` leaves this outDir's rows out of walkedIdentities, so any PRIOR index row(s) for it
          // are PRESERVED as-is by the merge below — the one intentional exception to "every on-disk run
          // dir gets a fresh row".
          skippedReplay++;
          continue;
        }
        walked.push(rootOutcome.row);
        walkedIdentities.add(rowIdentity(rootOutcome.row));

        // Archived turns: `result.turn-<N>.json` files left behind when a resume/reflection overwrote the
        // root (see the function doc comment above). The match is STRICT on purpose — a `critique` dir
        // also carries `result.graded.json`, a byte-identical COPY of turn 1 (critique/command.ts), not an
        // archive. A looser glob (`result*.json` / `result.*.json`) would match it too and double-count
        // the graded turn on every reindex.
        for (const entry of readdirSync(outDir)) {
          if (!/^result\.turn-\d+\.json$/.test(entry)) continue;
          const turnOutcome = readResultFileForWalk(runsRoot, outDir, join(outDir, entry), priorByOutDir);
          if (turnOutcome.kind === "missing") continue; // vanished between readdir and lstat — an ordinary race
          if (turnOutcome.kind === "unsafe") {
            skippedUnsafe++;
            continue;
          }
          if (turnOutcome.kind === "corrupt") {
            skipped++;
            continue;
          }
          if (turnOutcome.kind === "replay") {
            skippedReplay++;
            continue;
          }
          walked.push(turnOutcome.row);
          walkedIdentities.add(rowIdentity(turnOutcome.row));
        }
      }
    }
  }
  // A turn-less prior row is SUPERSEDED by any walked row for its outDir, and must not be preserved
  // alongside one. Rows written before `turn` existed carry identity `<outDir>`, while the row the walk
  // re-derives from that same run's result.json carries `<outDir> turn:N` — the identities can never
  // match, so a plain "identity not walked" filter would preserve the stale row NEXT TO its own
  // replacement and permanently double-count every pre-existing run on the first reindex (and never
  // self-heal). Note `priorByIdentity` has already collapsed all turn-less rows for one outDir into a
  // single entry, so at most one such row per outDir is dropped here: the most recent turn — which is
  // exactly the completion the current result.json (and thus the walked row) represents.
  const walkedOutDirs = new Set(walked.map((r) => r.outDir));
  const preserved = [...priorByIdentity.values()].filter(
    (r) => !walkedIdentities.has(rowIdentity(r)) && !(r.turn === undefined && walkedOutDirs.has(r.outDir)),
  );
  const rows = [...walked, ...preserved];
  mkdirSync(runsRoot, { recursive: true });
  writeTextAtomic(indexPath(runsRoot), rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
  return { rows, written: walked.length, skipped, skippedReplay, skippedUnsafe };
}

/** An exact `runId` or `slug/runId` match — split out from `resolveRunsFromIndex` (below) so
 *  `resolveEventsFile` (trace-view.ts) can interleave index/filesystem lookups tier-by-tier
 *  (index-exact → fs-exact → index-fragment → fs-fragment): an index FRAGMENT hit must never shadow a
 *  filesystem EXACT hit for a run that predates the index. */
export function resolveRunsExactFromIndex(rows: RunIndexRow[], arg: string): RunIndexRow[] {
  return rows.filter((r) => r.runId === arg || `${r.slug}/${r.runId}` === arg);
}

/** Every row whose `runId` or `scenario` CONTAINS `arg` — the fragment tier, split out for the same
 *  interleaving reason as `resolveRunsExactFromIndex` above. */
export function resolveRunsFragmentFromIndex(rows: RunIndexRow[], arg: string): RunIndexRow[] {
  return rows.filter((r) => r.runId.includes(arg) || r.scenario.includes(arg));
}

/** Resolves `arg` against index rows with exact-then-fragment semantics — an exact `runId` or `slug/runId`
 *  match wins outright; otherwise every fragment match is a candidate, and ALL candidates are returned
 *  (ambiguity is the caller's to surface, never silently resolved to "whichever sorted first"). Composed
 *  from the two tiers above; kept as its own export for callers (and tests) that just want "the index's
 *  best answer" without needing tier-by-tier interleaving against another resolver. */
export function resolveRunsFromIndex(rows: RunIndexRow[], arg: string): RunIndexRow[] {
  const exact = resolveRunsExactFromIndex(rows, arg);
  if (exact.length) return exact;
  return resolveRunsFragmentFromIndex(rows, arg);
}

export interface StatsSummary {
  scenario: string;
  runs: number;
  passRate: number;
  p50CostUsd?: number;
  p95CostUsd?: number;
  p50DurationMs?: number;
  p95DurationMs?: number;
  p50Tokens?: number;
  p95Tokens?: number;
  p50Turns?: number;
  p95Turns?: number;
  p50CacheReadTokens?: number;
  p95CacheReadTokens?: number;
  p50ModelCostUsd?: number;
  p95ModelCostUsd?: number;
  lastGreenTs?: string;
  prunedRuns: number; // rows whose outDir no longer exists on disk — still aggregated, just flagged
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

/** Aggregation over already-loaded rows (filters applied first). NOT pure — `prunedRuns` below calls
 *  `existsSync(r.outDir)` per row, real filesystem I/O, so the same rows can produce a different
 *  `prunedRuns` count if the caller re-runs this after a `prune` in between. Every other field IS a pure
 *  function of `rows`/`filters`. `since` compares ISO-string timestamps lexically (both are ISO 8601, so
 *  this is safe and avoids a Date-parsing dependency). A row whose `outDir` no longer exists on disk
 *  (deleted by `prune`) still counts toward every stat — the index is the durable history — but is flagged `prunedRuns` so a consumer can tell "no evidence left to
 *  re-inspect" apart from "still on disk". */
export function buildStats(
  rows: RunIndexRow[],
  filters: { scenario?: string; since?: string; baseline?: string; branch?: string; last?: number },
): StatsSummary[] {
  let filtered = rows;
  if (filters.scenario) filtered = filtered.filter((r) => r.scenario === filters.scenario);
  if (filters.since) filtered = filtered.filter((r) => r.ts >= filters.since!);
  if (filters.baseline) filtered = filtered.filter((r) => r.baseline === filters.baseline);
  if (filters.branch) filtered = filtered.filter((r) => r.git.branch === filters.branch);

  const byScenario = new Map<string, RunIndexRow[]>();
  for (const r of filtered) {
    if (!byScenario.has(r.scenario)) byScenario.set(r.scenario, []);
    byScenario.get(r.scenario)!.push(r);
  }
  // `--last` windows to the N most recent rows PER SCENARIO, AFTER since/baseline/branch/scenario have
  // already narrowed the candidate set — "the last N runs matching these filters", not "of the last N
  // runs overall, whichever happen to match" (the latter would silently starve a scenario/branch out of
  // the window entirely once a higher-frequency one dominates the unfiltered recent rows).
  if (filters.last !== undefined) {
    const n = filters.last;
    for (const [scenario, group] of byScenario) {
      byScenario.set(
        scenario,
        group
          .slice()
          .sort((a, b) => (a.ts < b.ts ? 1 : -1))
          .slice(0, n),
      );
    }
  }

  const summaries: StatsSummary[] = [];
  for (const [scenario, group] of byScenario) {
    const numbers = (pick: (r: RunIndexRow) => number | undefined) =>
      group
        .map(pick)
        .filter((v): v is number => v !== undefined)
        .sort((a, b) => a - b);
    const costs = numbers((r) => r.costUsd);
    const durations = numbers((r) => r.durationMs);
    const tokens = numbers((r) => r.tokens);
    const turns = numbers((r) => r.turns);
    const cacheReadTokensArr = numbers((r) => r.cacheReadTokens);
    const modelCostArr = numbers((r) => r.modelCostUsd);
    const greens = group.filter((r) => r.pass).sort((a, b) => (a.ts < b.ts ? 1 : -1));
    summaries.push({
      scenario,
      runs: group.length,
      passRate: group.filter((r) => r.pass).length / group.length,
      p50CostUsd: costs.length ? percentile(costs, 0.5) : undefined,
      p95CostUsd: costs.length ? percentile(costs, 0.95) : undefined,
      p50DurationMs: durations.length ? percentile(durations, 0.5) : undefined,
      p95DurationMs: durations.length ? percentile(durations, 0.95) : undefined,
      p50Tokens: tokens.length ? percentile(tokens, 0.5) : undefined,
      p95Tokens: tokens.length ? percentile(tokens, 0.95) : undefined,
      p50Turns: turns.length ? percentile(turns, 0.5) : undefined,
      p95Turns: turns.length ? percentile(turns, 0.95) : undefined,
      p50CacheReadTokens: cacheReadTokensArr.length ? percentile(cacheReadTokensArr, 0.5) : undefined,
      p95CacheReadTokens: cacheReadTokensArr.length ? percentile(cacheReadTokensArr, 0.95) : undefined,
      p50ModelCostUsd: modelCostArr.length ? percentile(modelCostArr, 0.5) : undefined,
      p95ModelCostUsd: modelCostArr.length ? percentile(modelCostArr, 0.95) : undefined,
      lastGreenTs: greens[0]?.ts,
      prunedRuns: group.filter((r) => !existsSync(r.outDir)).length,
    });
  }
  return summaries;
}
