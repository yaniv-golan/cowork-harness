// Queryable cross-run result store. index.jsonl (one JSON line per run) is the SOURCE OF TRUTH for
// "what runs exist" — the run-dir-per-run physical layout (<runsRoot>/<slug>/<runId>/) still holds the
// heavy artifacts (events.jsonl/trace.json/result.json); only the discovery/query layer moved here.
import { existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, basename, dirname } from "node:path";
import type { RunResult } from "../types.js";
import { computeVerdict } from "./verdict.js";
import { budgetFields } from "../assert.js";
import { warn } from "../io.js";

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

/** Single-line O_APPEND write — atomic at these sizes, safe under `record --concurrency`'s in-process
 *  pool (same reasoning as the writer note in async-pool.ts). Creates `runsRoot` if it doesn't exist yet
 *  (a fresh machine's first run). */
export function appendIndexRow(runsRoot: string, row: RunIndexRow): void {
  mkdirSync(runsRoot, { recursive: true });
  appendFileSync(indexPath(runsRoot), JSON.stringify(row) + "\n");
}

/** Reads every row, tolerating a corrupt/truncated TRAILING line (a crash mid-append) by skipping just
 *  that line rather than throwing and losing every prior row. Returns `[]` for a runs root with no
 *  index.jsonl yet — never throws on a fresh clone / pre-index-era runs root. */
export function readIndex(runsRoot: string): RunIndexRow[] {
  const p = indexPath(runsRoot);
  if (!existsSync(p)) return [];
  const rows: RunIndexRow[] = [];
  const lines = readFileSync(p, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as RunIndexRow);
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
 *  `ts`/`git` for a freshly-walked row are NOT "now"/"this checkout" — those would be fabricated
 *  provenance for a run that may have happened days/branches ago. `ts` is `result.json`'s own mtime
 *  (the closest available proxy for "when this run completed"); `git` is honestly `{branch:null,sha:null}`
 *  (unknowable from a bare result.json). `gitInfo()` is intentionally never called during a walk (it was
 *  in an earlier version, once per row — a real perf cost, N subprocess spawns for N run dirs, for a value
 *  that was wrong anyway).
 *
 *  A missing/corrupt result.json is skipped, not fatal — a partial/crashed run dir shouldn't block indexing
 *  everything else. */
export function reindexFromRunsTree(runsRoot: string): { rows: RunIndexRow[]; written: number; skipped: number; skippedReplay: number } {
  const priorByOutDir = new Map<string, RunIndexRow>();
  for (const r of readIndex(runsRoot)) priorByOutDir.set(r.outDir, r);

  const walkedOutDirs = new Set<string>();
  const walked: RunIndexRow[] = [];
  let skipped = 0;
  let skippedReplay = 0;
  if (existsSync(runsRoot)) {
    for (const slug of readdirSync(runsRoot)) {
      const slugDir = join(runsRoot, slug);
      let slugStat;
      try {
        slugStat = statSync(slugDir);
      } catch {
        continue;
      }
      if (!slugStat.isDirectory()) continue;
      for (const runId of readdirSync(slugDir)) {
        const outDir = join(slugDir, runId);
        const resultPath = join(outDir, "result.json");
        if (!existsSync(resultPath)) continue;
        try {
          const result = JSON.parse(readFileSync(resultPath, "utf8")) as RunResult;
          // A `command:"replay"` result is a RE-CHECK, not new evidence. Skip it entirely rather
          // than relabeling it "run" (the fallback below would, since replay carries mode:"run") and
          // laundering a re-check into the evidence index. `continue` leaves this outDir out of
          // walkedOutDirs, so any PRIOR index row for it is PRESERVED as-is by the merge below — the one
          // intentional exception to "every on-disk run dir gets a fresh row".
          if (result.command === "replay") {
            skippedReplay++;
            continue;
          }
          const ts = statSync(resultPath).mtime.toISOString();
          // RunResult.mode has no "skill"/"record" value, so a run originally recorded under one of those
          // commands would otherwise be relabeled "run"/"chat" on every reindex. Prefer the command now
          // persisted in result.json (#48); fall back to a prior index row (for results written before that
          // field existed), then to deriving from `result.mode` for a brand-new outDir with neither.
          const prior = priorByOutDir.get(outDir);
          // `result.command` here is already narrowed to exclude "replay" (skipped above), so it maps
          // straight onto the index row's command union — no re-check ever reaches this row.
          const command = result.command ?? prior?.command ?? (result.mode === "chat" ? "chat" : "run");
          walked.push(
            indexRowFromResult(result, {
              command,
              partial: !!result.partial,
              ts,
              git: { branch: null, sha: null },
            }),
          );
          walkedOutDirs.add(outDir);
        } catch {
          skipped++;
        }
      }
    }
  }
  const preserved = [...priorByOutDir.values()].filter((r) => !walkedOutDirs.has(r.outDir));
  const rows = [...walked, ...preserved];
  mkdirSync(runsRoot, { recursive: true });
  writeFileSync(indexPath(runsRoot), rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
  return { rows, written: walked.length, skipped, skippedReplay };
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
