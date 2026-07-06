// E3 — matrix runner. Cross-product of baseline/model/skill_dir axes over one scenario, reusing E1's
// rollup/table substrate. Pure functions only — no I/O, no execution; the CLI loop in cli.ts drives cells
// through runOneScenario/pMapBounded and hands the results here.
import { z } from "zod";
import { firstAssertionKey, rollupPasses, type RepeatRollup } from "./repeat.js";
import type { RunResult } from "../types.js";
import { budgetFields } from "../assert.js";
import { computeVerdict } from "./verdict.js";

export const MatrixFile = z.strictObject({
  baselines: z.array(z.string()).optional(),
  models: z.array(z.string()).optional(),
  skill_dirs: z.array(z.string()).optional(),
});
export type MatrixFile = z.infer<typeof MatrixFile>;

export interface MatrixCellAxes {
  baseline?: string;
  model?: string;
  skillDir?: string;
}

export interface MatrixCell {
  index: number;
  axes: MatrixCellAxes;
}

export interface MatrixExpansion {
  cells: MatrixCell[];
  totalBeforeCap: number;
  truncated: boolean;
}

/** Cross-product of the declared axes, in `baselines × models × skill_dirs` order. An absent/empty axis
 *  contributes exactly one `undefined` value (not zero) — so a matrix with no axes at all still expands
 *  to one cell (the base scenario, unmodified), never to zero cells. Capped at `maxCells`; the plan's own
 *  "no silent caps" principle means callers must surface `truncated`/`totalBeforeCap`, not swallow them. */
export function expandMatrix(matrix: MatrixFile, maxCells: number): MatrixExpansion {
  const baselines = matrix.baselines?.length ? matrix.baselines : [undefined];
  const models = matrix.models?.length ? matrix.models : [undefined];
  const skillDirs = matrix.skill_dirs?.length ? matrix.skill_dirs : [undefined];
  const all: MatrixCellAxes[] = [];
  for (const baseline of baselines) for (const model of models) for (const skillDir of skillDirs) all.push({ baseline, model, skillDir });
  const totalBeforeCap = all.length;
  const cells = all.slice(0, maxCells).map((axes, index) => ({ index, axes }));
  return { cells, totalBeforeCap, truncated: totalBeforeCap > maxCells };
}

export interface MatrixCellResult {
  index: number;
  axes: MatrixCellAxes;
  pass: boolean;
  failedAssertions: string[]; // assertion display keys (firstAssertionKey), NOT populated for an `error` cell
  signals: string[]; // VerdictSignal["code"][] — WHY pass is false beyond assertions (e.g. "stalled", "host_path_leak"); [] for an `error` cell
  costUsd?: number;
  durationMs?: number;
  effectiveFidelity?: string;
  outDir?: string; // the cell's own run dir — lets a JSON consumer join cells[] back to results[]/artifacts on disk; absent for an `error` cell (never ran to a persisted result)
  /** A cell-level INFRASTRUCTURE failure (e.g. "agent binary unavailable for this baseline", or an
   *  unanswered gate) — distinct from a skill/assertion failure. Set instead of failedAssertions/signals,
   *  never alongside real assertion data, so a consumer can tell "the skill failed" apart from "this cell
   *  never got to run the skill at all". */
  error?: string;
}

/** Turns one cell's real RunResult into a MatrixCellResult — the ONE place that reads RunResult fields for
 *  the matrix rollup, so cli.ts's cell loop stays a thin driver. Reuses computeVerdict/budgetFields/
 *  firstAssertionKey rather than re-deriving pass/fail or cost from scratch (don't re-implement
 *  verdict logic per-mode). */
export function matrixCellResultFromRun(cell: MatrixCell, result: RunResult): MatrixCellResult {
  const verdict = computeVerdict(result, "live");
  const failedAssertions = result.assertions.filter((a) => !a.pass).map((a) => firstAssertionKey(a.assertion));
  return {
    index: cell.index,
    axes: cell.axes,
    pass: verdict.pass,
    failedAssertions,
    signals: verdict.signals.map((s) => s.code),
    costUsd: budgetFields(result).costUsd,
    durationMs: result.durationMs,
    effectiveFidelity: result.effectiveFidelity,
    outDir: result.outDir,
  };
}

export interface MatrixRollup {
  cells: MatrixCellResult[];
  requested: number; // totalBeforeCap from expandMatrix
  ranCells: number; // cells actually executed (after the --max-cells cap)
  truncated: boolean;
  anyFail: boolean; // a matrix is a compatibility gate, not a survey — any cell failing (assertion OR infra) fails the batch
}

export function buildMatrixRollup(cells: MatrixCellResult[], requested: number, truncated: boolean): MatrixRollup {
  return { cells, requested, ranCells: cells.length, truncated, anyFail: cells.some((c) => !c.pass) };
}

/** A compact human label for one cell's axes — reused for both the per-cell run label (cli.ts, so each
 *  cell's live footer is distinguishable) and the rollup table row. */
export function axesLabel(axes: MatrixCellAxes): string {
  const parts = [
    axes.baseline !== undefined ? `baseline=${axes.baseline}` : null,
    axes.model !== undefined ? `model=${axes.model}` : null,
    axes.skillDir !== undefined ? `skill_dir=${axes.skillDir}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "(no axes)";
}

/** Compact text-mode rollup table after a `--matrix` run. The truncation warning itself is emitted once,
 *  at expansion time in cli.ts (before any cell runs, so it fires in BOTH --output-format modes) —
 *  not repeated here, so a truncated matrix doesn't print the same `::warning::` twice in text mode. */
export function formatMatrixRollup(r: MatrixRollup): string[] {
  const lines: string[] = [];
  lines.push(`matrix: ${r.cells.filter((c) => c.pass).length}/${r.ranCells} cells passed${r.anyFail ? " — FAIL" : ""}`);
  for (const c of r.cells) {
    const label = axesLabel(c.axes);
    if (c.error) {
      lines.push(`  ✗ [${c.index}] ${label} — cell error: ${c.error}`);
      continue;
    }
    const status = c.pass ? "✓" : "✗";
    const detail = [
      c.effectiveFidelity ? `[${c.effectiveFidelity}]` : null,
      c.costUsd !== undefined ? `$${c.costUsd.toFixed(4)}` : null,
      c.durationMs !== undefined ? `${(c.durationMs / 1000).toFixed(1)}s` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    lines.push(`  ${status} [${c.index}] ${label}${detail ? " " + detail : ""}`);
    if (!c.pass && c.failedAssertions.length) lines.push(`      failed: ${c.failedAssertions.join(", ")}`);
    // A cell can fail on a verdict signal with NO failing assertion at all (e.g. `stalled`,
    // `host_path_leak`) — without this, that cell renders ✗ with no visible reason (E1's rollup surfaces
    // the same signals via its histogram; do the same here per-cell).
    if (!c.pass && c.signals.length) lines.push(`      signals: ${c.signals.join(", ")}`);
  }
  return lines;
}

/** `--matrix` + `--repeat` composed: each cell is its own repeat batch (N iterations of that cell's
 *  axes-overridden scenario), not a single run. `rollup` is the cell's full `RepeatRollup` — carries the
 *  richer per-iteration distribution a plain `MatrixCellResult`'s scalar fields can't (percentiles aren't
 *  meaningful here, but pass rate / signal histogram / per-assertion attribution / stoppedEarly all are).
 *  `error` is a PRE-EXECUTION infra failure (e.g. a session-override error, or an unavailable agent
 *  binary before the repeat loop could even start) — same meaning as `MatrixCellResult.error`, mutually
 *  exclusive with `rollup` (a cell either got far enough to produce a rollup, or it didn't). */
export interface MatrixCellRepeatResult {
  index: number;
  axes: MatrixCellAxes;
  rollup?: RepeatRollup;
  error?: string;
}

export interface MatrixRepeatRollup {
  cells: MatrixCellRepeatResult[];
  requested: number; // totalBeforeCap from expandMatrix (cell count, not iteration count)
  ranCells: number;
  truncated: boolean;
  anyFail: boolean; // any cell's rollup fails rollupPasses(minPassRate), OR any cell hit a pre-execution error
}

/** Reuses `rollupPasses` (E1) for each cell's own pass/fail judgment — a matrix-of-repeats never
 *  re-implements the batch-verdict formula, it just applies it per cell. */
export function buildMatrixRepeatRollup(
  cells: MatrixCellRepeatResult[],
  requested: number,
  truncated: boolean,
  minPassRate: number,
): MatrixRepeatRollup {
  return {
    cells,
    requested,
    ranCells: cells.length,
    truncated,
    anyFail: cells.some((c) => c.error !== undefined || (c.rollup !== undefined && !rollupPasses(c.rollup, minPassRate))),
  };
}

/** Compact text-mode rollup table after a composed `--matrix --repeat` run — one line per cell
 *  summarizing that cell's OWN repeat batch (reusing `rollupPasses` for the pass/fail verdict, matching
 *  `formatMatrixRollup`'s truncation-warning convention: emitted once at expansion time in cli.ts, not
 *  repeated here). */
export function formatMatrixRepeatRollup(r: MatrixRepeatRollup, minPassRate: number): string[] {
  const lines: string[] = [];
  const cellsPassing = r.cells.filter((c) => c.rollup && rollupPasses(c.rollup, minPassRate)).length;
  lines.push(`matrix: ${cellsPassing}/${r.ranCells} cells passed${r.anyFail ? " — FAIL" : ""}`);
  for (const c of r.cells) {
    const label = axesLabel(c.axes);
    if (c.error || !c.rollup) {
      lines.push(`  ✗ [${c.index}] ${label} — cell error: ${c.error ?? "no rollup produced"}`);
      continue;
    }
    const passed = rollupPasses(c.rollup, minPassRate);
    const status = passed ? "✓" : "✗";
    const stopNote = c.rollup.stoppedEarly
      ? ` (stopped early: ${c.rollup.stoppedEarly}, ${c.rollup.completed}/${c.rollup.requested} completed)`
      : "";
    lines.push(
      `  ${status} [${c.index}] ${label} — ${c.rollup.passes}/${c.rollup.completed} passed (${(c.rollup.passRate * 100).toFixed(0)}%)${stopNote}`,
    );
    if (!passed) {
      const signals = Object.entries(c.rollup.signalHistogram);
      if (signals.length) lines.push(`      signals: ${signals.map(([code, n]) => `${code}×${n}`).join(", ")}`);
    }
  }
  return lines;
}
