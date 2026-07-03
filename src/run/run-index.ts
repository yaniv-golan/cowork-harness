// E4 — queryable cross-run result store. index.jsonl (one JSON line per run) is the SOURCE OF TRUTH for
// "what runs exist" — the run-dir-per-run physical layout (<runsRoot>/<slug>/<runId>/) still holds the
// heavy artifacts (events.jsonl/trace.json/result.json); only the discovery/query layer moved here.
import { existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, basename, dirname } from "node:path";
import type { RunResult } from "../types.js";
import { computeVerdict } from "./verdict.js";
import { budgetFields } from "../assert.js";

export interface RunIndexRow {
  v: 1;
  ts: string; // ISO
  command: "run" | "skill" | "record";
  scenario: string;
  slug: string; // the <runsRoot>/<slug>/ path segment (slugForPath(scenario) at write time)
  runId: string; // the <slug>/<runId>/ path segment — local_<hrtime> | sess-<id>
  fidelity: string;
  effectiveFidelity?: string;
  baseline: string;
  result: "success" | "error";
  pass: boolean;
  signals: string[]; // VerdictSignal["code"][]
  costUsd?: number;
  tokens?: number;
  turns?: number;
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

/** Pure: turns a real RunResult into an index row. The ONE place that reads RunResult fields for the
 *  index, reusing computeVerdict/budgetFields rather than re-deriving pass/fail or cost from scratch —
 *  same "don't re-implement verdict logic per writer" principle as E1/E3's rollups. */
export function indexRowFromResult(result: RunResult, opts: { command: "run" | "skill" | "record"; partial: boolean }): RunIndexRow {
  const verdict = computeVerdict(result, "live");
  const budget = budgetFields(result);
  const { slug, runId } = slugAndRunIdFromOutDir(result.outDir);
  return {
    v: 1,
    ts: new Date().toISOString(),
    command: opts.command,
    scenario: result.scenario,
    slug,
    runId,
    fidelity: result.fidelity,
    effectiveFidelity: result.effectiveFidelity,
    baseline: result.baseline,
    result: result.result,
    pass: verdict.pass,
    signals: verdict.signals.map((s) => s.code),
    costUsd: budget.costUsd,
    tokens: budget.tokensTotal,
    turns: budget.turns,
    durationMs: result.durationMs,
    partial: opts.partial,
    nonDeterministic: !!result.nonDeterministic,
    outDir: result.outDir,
    git: gitInfo(),
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
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as RunIndexRow);
    } catch {
      // a truncated trailing line from a crash mid-append — skip it, keep everything else.
    }
  }
  return rows;
}

/** One-time local migration: rebuilds index.jsonl from the physical `<runsRoot>/<slug>/<runId>/result.json`
 *  tree — a TRUE rebuild (overwrites, never appends to, any prior index.jsonl), so it's safe to re-run.
 *  A missing/corrupt result.json is skipped, not fatal — a partial/crashed run dir shouldn't block indexing
 *  everything else. */
export function reindexFromRunsTree(runsRoot: string): { rows: RunIndexRow[]; written: number; skipped: number } {
  const rows: RunIndexRow[] = [];
  let skipped = 0;
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
        const resultPath = join(slugDir, runId, "result.json");
        if (!existsSync(resultPath)) continue;
        try {
          const result = JSON.parse(readFileSync(resultPath, "utf8")) as RunResult;
          rows.push(indexRowFromResult(result, { command: "run", partial: false }));
        } catch {
          skipped++;
        }
      }
    }
  }
  mkdirSync(runsRoot, { recursive: true });
  writeFileSync(indexPath(runsRoot), rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
  return { rows, written: rows.length, skipped };
}

/** Resolves `arg` against index rows with the SAME exact-then-fragment semantics `resolveEventsFile`
 *  already established (trace-view.ts) — an exact `runId` or `slug/runId` match wins outright; otherwise
 *  every row whose `runId` or `scenario` CONTAINS `arg` is a candidate, and ALL candidates are returned
 *  (ambiguity is the caller's to surface, never silently resolved to "whichever sorted first"). */
export function resolveRunsFromIndex(rows: RunIndexRow[], arg: string): RunIndexRow[] {
  const exact = rows.filter((r) => r.runId === arg || `${r.slug}/${r.runId}` === arg);
  if (exact.length) return exact;
  return rows.filter((r) => r.runId.includes(arg) || r.scenario.includes(arg));
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
  lastGreenTs?: string;
  prunedRuns: number; // rows whose outDir no longer exists on disk — still aggregated, just flagged
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

/** Pure aggregation over already-loaded rows (filters applied first). `since` compares ISO-string
 *  timestamps lexically (both are ISO 8601, so this is safe and avoids a Date-parsing dependency). A row
 *  whose `outDir` no longer exists on disk (deleted by `prune`) still counts toward every stat — the index
 *  is the durable history — but is flagged `prunedRuns` so a consumer can tell "no evidence left to
 *  re-inspect" apart from "still on disk". */
export function buildStats(rows: RunIndexRow[], filters: { scenario?: string; since?: string; baseline?: string; branch?: string }): StatsSummary[] {
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

  const summaries: StatsSummary[] = [];
  for (const [scenario, group] of byScenario) {
    const numbers = (pick: (r: RunIndexRow) => number | undefined) =>
      group.map(pick).filter((v): v is number => v !== undefined).sort((a, b) => a - b);
    const costs = numbers((r) => r.costUsd);
    const durations = numbers((r) => r.durationMs);
    const tokens = numbers((r) => r.tokens);
    const turns = numbers((r) => r.turns);
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
      lastGreenTs: greens[0]?.ts,
      prunedRuns: group.filter((r) => !existsSync(r.outDir)).length,
    });
  }
  return summaries;
}
