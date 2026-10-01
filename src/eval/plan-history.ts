// The eval planner's history loader: selects, from the run index and the kept result.json files, the runs
// the planner's cost and rate estimates are drawn from. All I/O lives here; `planner.ts` is pure.
//
// Two bases, deliberately different:
//   - COST (index only): the rows `stats <name> --baseline <b> --group-by fidelity` aggregates for the eval's
//     effective tier, minus resumed turns and hillclimb variants — plus, separately, the `--max-budget-usd`
//     gate's own unfiltered worst-observed figure (see `CostHistory`).
//   - RATES (index, then result.json): each run re-classified by the eval's own classifier, so an
//     infrastructure failure is excluded and an agent error scores 0 exactly as it would in the eval.
import { readFileSync, statSync } from "node:fs";
import type { Assertion } from "../types.js";
import { isLiveModelId } from "../types.js";
import { isRun, scenarioCostHistory, tierOf, type RunIndexRow } from "../run/run-index.js";
import { latestTurn, turnArtifactPath } from "../run/turn-layout.js";
import { deriveModelProvenance } from "../run/model-provenance.js";
import { classifyRep, classifyTermination, repRowValues, scenarioRows, type ClassifiableResult, type RowKey } from "./classify.js";
import { EXACT_CONTENT_MIN, HISTORY_WINDOW, type CostHistory, type RowHistory } from "./planner.js";

/** `runLabel` prefix of runs a hillclimb flow made. Its runs are variants under test (often ablated), not
 *  the plugin under eval, so both bases exclude them by default. */
export const HILLCLIMB_LABEL_PREFIX = "hillclimb:";
/** `runLabel` prefix of an eval's own reps. Kept: arm A's reps are the best exact-content history. */
export const EVAL_LABEL_PREFIX = "eval:";
/** At most this many result.json files are read per scenario while filling the rate window. */
export const MAX_HISTORY_READS = 500;
/** A result.json larger than this is counted `unreadable`, never parsed. */
export const MAX_RESULT_BYTES = 32 * 1024 * 1024;

/** Commands whose runs are eval-comparable reps (a chat session is not). */
const REP_COMMANDS: ReadonlySet<RunIndexRow["command"]> = new Set(["run", "skill", "record"]);

export interface HistoryFilters {
  scenario: string;
  baseline: string;
  /** The eval's EFFECTIVE tier for this scenario — what `cowork` resolves to, as rows record it in
   *  `effectiveFidelity`. Compared with each row's `effectiveFidelity ?? fidelity`. */
  tier: string;
  /** Include runs labelled `hillclimb:` (default false: excluded from both bases). */
  includeHillclimb?: boolean;
}

const isHillclimb = (r: RunIndexRow) => r.runLabel?.startsWith(HILLCLIMB_LABEL_PREFIX) === true;
/** A fresh run is turn 1; a row written before turns were recorded has none and is a fresh run too. */
const isFirstTurn = (r: RunIndexRow) => r.turn === undefined || r.turn <= 1;

/** The cost basis for one scenario (index only), plus the budget gate's own worst-observed figure. */
export function loadCostHistory(rows: readonly RunIndexRow[], f: HistoryFilters): CostHistory {
  const basis = rows.filter(
    (r) =>
      isRun(r) &&
      r.scenario === f.scenario &&
      r.baseline === f.baseline &&
      tierOf(r) === f.tier &&
      isFirstTurn(r) &&
      (f.includeHillclimb === true || !isHillclimb(r)),
  );
  // The gate's basis, not the filtered one: this is the figure `--max-budget-usd` refuses on.
  const gate = scenarioCostHistory([...rows], f.scenario);
  return {
    scenario: f.scenario,
    samples: basis.map((r) => ({
      ...(typeof r.costUsd === "number" ? { agentUsd: r.costUsd } : {}),
      ...(typeof r.judgeCostUsd === "number" ? { judgeUsd: r.judgeCostUsd } : {}),
      ...(typeof r.deciderCostUsd === "number" ? { deciderUsd: r.deciderCostUsd } : {}),
    })),
    ...(gate.length ? { worstObservedUsd: Math.max(...gate) } : {}),
    gatePricedRuns: gate.length,
    distinctSkillHashes: new Set(basis.map((r) => r.skillHash).filter((h): h is string => h !== undefined)).size,
    distinctTiers: new Set(basis.map(tierOf)).size,
  };
}

export interface RowHistoryOptions extends HistoryFilters {
  /** The frozen scenario's assertions (the eval's rows come from these, never from a result). */
  assertions: readonly Assertion[];
  /** The eval's agent model pin for this scenario. A run counts only when its models honour THIS pin. */
  agentPin: string | undefined;
  /** Arm A's content signature, for the exact-content count and preference. */
  armASig?: string;
  /** The current grading-prompt identity. A run graded under another prompt keeps its structural rows. */
  judgePromptHash?: string;
  window?: number;
  maxReads?: number;
  maxResultBytes?: number;
}

/** Runs each hard key excluded (they never take a window slot). */
export interface ExcludedByKey {
  /** Critique roll-up rows: bookkeeping, not runs. */
  notRun: number;
  command: number;
  tier: number;
  baseline: number;
  turn: number;
  hillclimb: number;
  ablated: number;
  model: number;
  pruned: number;
  unreadable: number;
}

export interface RowHistoryLoad {
  /** The rows the rates come from: arm A's exact-content reps when there are at least EXACT_CONTENT_MIN
   *  of them, else every rep in the window. */
  rows: Array<{ row: RowKey; history: RowHistory }>;
  basis: "exact_content" | "relaxed";
  /** The relaxed (config-matched) rates, present beside the exact-content ones when those were chosen. */
  relaxedRows?: Array<{ row: RowKey; history: RowHistory }>;
  /** Runs in the window (after every hard key). */
  reps: number;
  /** Reps that scored at least one row (not excluded as infrastructure or drift). */
  validReps: number;
  /** validReps / reps; absent when the window is empty. */
  validFraction?: number;
  /** Valid reps that ran arm A's exact content. */
  exactContentReps: number;
  /** Reps an earlier eval made (`runLabel` starts `eval:`). */
  evalReps: number;
  excludedByKey: ExcludedByKey;
  /** Model-key exclusions by the run's live main model(s); "(no live model)" when it reported none. */
  modelsExcluded: Record<string, number>;
  /** The window's oldest and newest `ts`. */
  tsSpan?: { from: string; to: string };
  /** Index verdicts over the newest `window` runs passing the index keys — CONTEXT ONLY. A passing verdict
   *  says nothing certain about any one row (a `min_pass` rubric passes with failed claims, and an older
   *  assert list grades different rows), so no rate is derived from it. */
  verdictRate: { pass: number; runs: number };
  reads: number;
  readCapHit: boolean;
}

type Loaded = ClassifiableResult & {
  ablated?: boolean;
  modelFallbacks?: Parameters<typeof deriveModelProvenance>[2];
  modelUsage?: Record<string, unknown>;
};

function readResult(row: RunIndexRow, maxBytes: number): Loaded | "pruned" | "unreadable" {
  const turn = row.turn ?? latestTurn(row.outDir);
  if (turn === undefined) return "pruned";
  const p = turnArtifactPath(row.outDir, turn, "result.json");
  let size: number;
  try {
    size = statSync(p).size;
  } catch {
    return "pruned";
  }
  if (size > maxBytes) return "unreadable";
  try {
    const parsed: unknown = JSON.parse(readFileSync(p, "utf8"));
    return parsed !== null && typeof parsed === "object" ? (parsed as Loaded) : "unreadable";
  } catch {
    return "unreadable";
  }
}

const isSemanticRow = (row: RowKey) => row.kind === "semantic_rollup" || row.kind === "claim";

function tally(rows: readonly RowKey[], reps: ReadonlyArray<ReturnType<typeof repRowValues>>) {
  return rows.map((row, i) => {
    const h: RowHistory = { k: 0, n: 0, excluded: {} };
    for (const values of reps) {
      const v = values[i];
      if (v.value !== undefined) {
        h.n++;
        h.k += v.value;
      } else if (v.excluded !== undefined) h.excluded![v.excluded] = (h.excluded![v.excluded] ?? 0) + 1;
    }
    return { row, history: h };
  });
}

/** Per-row rate history for one scenario, from the newest `window` runs that pass every hard key. */
export function loadRowHistory(rows: readonly RunIndexRow[], o: RowHistoryOptions): RowHistoryLoad {
  const window = o.window ?? HISTORY_WINDOW;
  const maxReads = o.maxReads ?? MAX_HISTORY_READS;
  const maxBytes = o.maxResultBytes ?? MAX_RESULT_BYTES;
  const ex: ExcludedByKey = {
    notRun: 0,
    command: 0,
    tier: 0,
    baseline: 0,
    turn: 0,
    hillclimb: 0,
    ablated: 0,
    model: 0,
    pruned: 0,
    unreadable: 0,
  };
  const modelsExcluded: Record<string, number> = {};

  // Index keys first: no file is opened for a row the index alone rules out.
  const candidates = rows
    .filter((r) => r.scenario === o.scenario)
    .filter((r) => {
      if (!isRun(r)) return (void ex.notRun++, false);
      if (!REP_COMMANDS.has(r.command)) return (void ex.command++, false);
      if (tierOf(r) !== o.tier) return (void ex.tier++, false);
      if (r.baseline !== o.baseline) return (void ex.baseline++, false);
      if (!isFirstTurn(r)) return (void ex.turn++, false);
      if (o.includeHillclimb !== true && isHillclimb(r)) return (void ex.hillclimb++, false);
      return true;
    })
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  const verdictWindow = candidates.slice(0, window);

  const sRows = scenarioRows(o.scenario, o.assertions);
  const used: Array<{ row: RunIndexRow; result: Loaded; values: ReturnType<typeof repRowValues>; valid: boolean; exact: boolean }> = [];
  let reads = 0;
  let readCapHit = false;
  for (const r of candidates) {
    if (used.length >= window) break;
    if (reads >= maxReads) {
      readCapHit = true;
      break;
    }
    reads++;
    const result = readResult(r, maxBytes);
    if (result === "pruned" || result === "unreadable") {
      ex[result]++;
      continue;
    }
    if (result.ablated === true) {
      ex.ablated++;
      continue;
    }
    // Termination before the model key: an infrastructure failure (a sign-in error reports only a
    // `<synthetic>` model) is excluded as infrastructure, inside the window, exactly as the eval would.
    const infra = classifyTermination({ result }).bucket === "errored_infra";
    if (!infra) {
      const honoured = deriveModelProvenance(o.agentPin, result.models, result.modelFallbacks, result.modelUsage).modelPinHonored;
      if (honoured !== true) {
        ex.model++;
        const live = (result.models ?? []).filter(isLiveModelId);
        const key = live.length ? [...new Set(live)].join(", ") : "(no live model)";
        modelsExcluded[key] = (modelsExcluded[key] ?? 0) + 1;
        continue;
      }
    }
    // The pin was just checked against the EVAL's pin; the run's own stamp answered a different question
    // (its own pin, possibly an unverifiable alias), so it must not exclude the rep a second time.
    const asScored: Loaded = infra ? result : { ...result, modelPinHonored: true };
    let c = classifyRep({ result: asScored }, { judgePromptHash: o.judgePromptHash });
    let promptMismatch = false;
    if (c.bucket === "judge_prompt_mismatch") {
      // A different grading prompt cannot have affected a structural assertion: keep those rows, drop only
      // the semantic rows of this rep. (The eval itself drops the whole rep; this is the planner's refinement.)
      promptMismatch = true;
      c = classifyRep({ result: asScored }, {});
    }
    let values = repRowValues(sRows, o.assertions, c, asScored);
    if (promptMismatch) values = values.map((v) => (isSemanticRow(v.row) ? { row: v.row, excluded: "judge_prompt_mismatch" as const } : v));
    const valid = c.bucket === "valid" || c.bucket === "judge_invalid" || c.bucket === "errored_agent";
    const exact = valid && o.armASig !== undefined && result.fingerprint?.contentSig === o.armASig;
    used.push({ row: r, result, values, valid, exact });
  }

  const relaxed = tally(
    sRows,
    used.map((u) => u.values),
  );
  const exactContentReps = used.filter((u) => u.exact).length;
  const preferExact = exactContentReps >= EXACT_CONTENT_MIN;
  const validReps = used.filter((u) => u.valid).length;
  const ts = used.map((u) => u.row.ts).sort();
  return {
    rows: preferExact
      ? tally(
          sRows,
          used.filter((u) => u.exact).map((u) => u.values),
        )
      : relaxed,
    basis: preferExact ? "exact_content" : "relaxed",
    ...(preferExact ? { relaxedRows: relaxed } : {}),
    reps: used.length,
    validReps,
    ...(used.length ? { validFraction: validReps / used.length } : {}),
    exactContentReps,
    evalReps: used.filter((u) => u.row.runLabel?.startsWith(EVAL_LABEL_PREFIX) === true).length,
    excludedByKey: ex,
    modelsExcluded,
    ...(ts.length ? { tsSpan: { from: ts[0], to: ts[ts.length - 1] } } : {}),
    verdictRate: { pass: verdictWindow.filter((r) => r.pass).length, runs: verdictWindow.length },
    reads,
    readCapHit,
  };
}
