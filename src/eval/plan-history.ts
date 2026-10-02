// The eval planner's history loader: selects, from the run index and the kept result.json files, the runs
// the planner's cost and rate estimates are drawn from. All I/O lives here; `planner.ts` is pure.
//
// Two bases, deliberately different:
//   - COST (index only): the rows `stats <name> --baseline <b> --group-by fidelity` aggregates for the eval's
//     effective tier, minus resumed turns and hillclimb variants — plus, separately, the `--max-budget-usd`
//     gate's own unfiltered worst-observed figure (see `CostHistory`).
//   - RATES (index, then result.json): each run re-classified by the eval's own classifier, so an
//     infrastructure failure is excluded and an agent error scores 0 exactly as it would in the eval.
import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync } from "node:fs";
import type { Assertion } from "../types.js";
import { isLiveModelId } from "../types.js";
import { isRun, scenarioCostHistory, tierOf, type RunIndexRow } from "../run/run-index.js";
import { turnArtifactPath } from "../run/turn-layout.js";
import { deriveModelProvenance, normalizeModelId } from "../run/model-provenance.js";
import { classifyRep, classifyTermination, repRowValues, scenarioRows, type ClassifiableResult, type RowKey } from "./classify.js";
import { EXACT_CONTENT_MIN, HISTORY_WINDOW, type CostHistory, type RowHistory } from "./planner.js";

// `runLabel` prefixes. Hillclimb runs are variants under test (often ablated), not the plugin under eval, so
// both bases exclude them by default. An eval's own reps are kept: arm A's reps are the best exact-content history.
import { EVAL_LABEL_PREFIX, HILLCLIMB_LABEL_PREFIX } from "../run/run-labels.js";
export { EVAL_LABEL_PREFIX, HILLCLIMB_LABEL_PREFIX };
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

/** The cost basis for one scenario (index only), with how many runs each filter left out, plus — kept apart
 *  — the budget gate's own wider worst-observed figure. */
export function loadCostHistory(rows: readonly RunIndexRow[], f: HistoryFilters): CostHistory {
  const excluded = { notRun: 0, tier: 0, baseline: 0, turn: 0, hillclimb: 0 };
  const basis = rows
    .filter((r) => r.scenario === f.scenario)
    .filter((r) => {
      if (!isRun(r)) return (void excluded.notRun++, false);
      if (tierOf(r) !== f.tier) return (void excluded.tier++, false);
      if (r.baseline !== f.baseline) return (void excluded.baseline++, false);
      if (!isFirstTurn(r)) return (void excluded.turn++, false);
      if (f.includeHillclimb !== true && isHillclimb(r)) return (void excluded.hillclimb++, false);
      return true;
    });
  // The gate's basis, not the filtered one: the figure `--max-budget-usd` refuses on. Carried separately;
  // it never feeds a covered cost figure.
  const gate = scenarioCostHistory([...rows], f.scenario);
  return {
    scenario: f.scenario,
    samples: basis.map((r) => ({
      ...(typeof r.costUsd === "number" ? { agentUsd: r.costUsd } : {}),
      ...(typeof r.judgeCostUsd === "number" ? { judgeUsd: r.judgeCostUsd } : {}),
      ...(typeof r.deciderCostUsd === "number" ? { deciderUsd: r.deciderCostUsd } : {}),
    })),
    ...(gate.length ? { budgetGateWorstUsd: Math.max(...gate) } : {}),
    budgetGatePricedRuns: gate.length,
    distinctSkillHashes: new Set(basis.map((r) => r.skillHash).filter((h): h is string => h !== undefined)).size,
    distinctTiers: new Set(basis.map(tierOf)).size,
    excluded,
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
  /** The eval's judge model pin, when one is set. A run whose semantic grade names a different `judgeModel`
   *  keeps its structural rows; only that assertion's claim and roll-up rows lose the run. */
  judgeModelPin?: string;
  /** Per-assertion judge pins (assertion index → model), as the eval resolves them (`resolveJudgePins`): each
   *  semantic assertion is checked against its own pin. An index present here wins over `judgeModelPin`.
   *  Both are compared the way the eval compares judge models (`normalizeModelId`). */
  judgeModelPins?: ReadonlyMap<number, string>;
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
  /** Runs in the window with at least one semantic grade by a judge model other than `judgeModelPin`. */
  judgeModelDiffers: number;
  /** The window's oldest and newest `ts`. */
  tsSpan?: { from: string; to: string };
  /** Index verdicts — CONTEXT ONLY. Its basis (`basis: "index"`) is the newest `window` runs that pass the
   *  INDEX keys (scenario, tier, baseline, command, turn, hillclimb), BEFORE any result.json is read, so it
   *  can include runs the rates above exclude (pruned, unreadable, ablated, another model). That is on
   *  purpose: it is the only figure left when every run dir was pruned. A passing verdict says nothing
   *  certain about any one row (a `min_pass` rubric passes with failed claims, and an older assert list
   *  grades different rows), so no rate is derived from it. */
  verdictRate: { pass: number; runs: number; basis: "index" };
  reads: number;
  readCapHit: boolean;
}

type Loaded = ClassifiableResult & {
  ablated?: boolean;
  modelFallbacks?: Parameters<typeof deriveModelProvenance>[2];
  modelUsage?: Record<string, unknown>;
};

/** The fields the classifier and the model check dereference, checked before either sees the object: a
 *  result.json that parses but has the wrong shape is `unreadable`, never half-read. */
function wellShaped(x: unknown): x is Loaded {
  if (x === null || typeof x !== "object" || Array.isArray(x)) return false;
  const r = x as Record<string, unknown>;
  const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
  const optObject = (v: unknown) => v === undefined || isObject(v);
  /** Absent, or an array every element of which passes `each`. */
  const optArrayOf = (v: unknown, each: (e: unknown) => boolean) => v === undefined || (Array.isArray(v) && v.every(each));
  const grade = (g: unknown) => isObject(g) && isObject(g.assertion) && optArrayOf(g.semanticClaims, isObject);
  return (
    typeof r.result === "string" &&
    optArrayOf(r.models, (m) => typeof m === "string") &&
    optArrayOf(r.modelFallbacks, isObject) &&
    optObject(r.modelUsage) &&
    optObject(r.fingerprint) &&
    optArrayOf(r.assertions, grade)
  );
}

/** Read one run's result.json: a REGULAR file only (opened without following a symlink, and non-blocking so
 *  a FIFO cannot stall the read), at most `maxBytes`. */
function readResult(row: RunIndexRow, maxBytes: number): Loaded | "pruned" | "unreadable" {
  // A row with no turn predates turn tracking and is a fresh run (the hard keys admit it as one), so its rep
  // is turn 1 — never a later resumed turn that happens to share the run dir.
  const p = turnArtifactPath(row.outDir, row.turn ?? 1, "result.json");
  let fd: number;
  try {
    fd = openSync(p, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "pruned" : "unreadable";
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) return "unreadable";
    const parsed: unknown = JSON.parse(readFileSync(fd, "utf8"));
    return wellShaped(parsed) ? parsed : "unreadable";
  } catch {
    return "unreadable";
  } finally {
    closeSync(fd);
  }
}

/** A row the judge graded: every row of a `semantic_matches` assertion (its roll-up and claims) and the one row of
 *  a `semantic_pairwise` assertion — the same set the eval's classifier holds to a judge prompt and model. */
const judgedRow = (assertions: readonly Assertion[]) => (row: RowKey) => {
  const a = assertions[row.assertionIndex];
  return a?.semantic_matches !== undefined || a?.semantic_pairwise !== undefined;
};

/** One rep's value on one row; `excluded` adds the planner's own reasons to the eval's row exclusions. */
type RowValueLike = { row: RowKey; value?: 0 | 1; excluded?: string };

function tally(rows: readonly RowKey[], reps: ReadonlyArray<readonly RowValueLike[]>) {
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
  let judgeModelDiffers = 0;

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
  const used: Array<{ row: RunIndexRow; result: Loaded; values: RowValueLike[]; valid: boolean; exact: boolean }> = [];
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
    const termination = classifyTermination({ result }).bucket;
    const infra = termination === "errored_infra";
    if (!infra) {
      const honoured = deriveModelProvenance(o.agentPin, result.models, result.modelFallbacks, result.modelUsage).modelPinHonored;
      // The eval's own precedence: an agent error ranks above a model mismatch, so a crash before any model
      // answered (no evidence either way) is scored 0 on every row, not dropped from the denominator. Only
      // POSITIVE evidence of another model excludes a run — or, for a success, no evidence at all (nothing
      // vouches for the pin).
      if (honoured === false || (honoured === undefined && termination === "valid")) {
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
      // the judged rows of this rep. (The eval itself drops the whole rep; this is the planner's refinement.)
      promptMismatch = true;
      c = classifyRep({ result: asScored }, {});
    }
    const isSemanticRow = judgedRow(o.assertions);
    let values: RowValueLike[] = repRowValues(sRows, o.assertions, c, asScored);
    if (promptMismatch) values = values.map((v) => (isSemanticRow(v.row) ? { row: v.row, excluded: "judge_prompt_mismatch" } : v));
    // A different judge model graded this run's semantic assertion(s): those rows lose the run, the
    // structural rows keep it. An agent error is 0 on every row regardless (no grade was the judge's).
    if ((o.judgeModelPin !== undefined || o.judgeModelPins !== undefined) && c.bucket !== "errored_agent") {
      const grades = (asScored.assertions ?? []).filter((a) => a.source === undefined);
      const other = (i: number) => {
        const pin = o.judgeModelPins?.get(i) ?? o.judgeModelPin;
        const m = (grades[i] as { judgeModel?: unknown } | undefined)?.judgeModel;
        return pin !== undefined && typeof m === "string" && normalizeModelId(m) !== normalizeModelId(pin);
      };
      if (sRows.some((row) => isSemanticRow(row) && other(row.assertionIndex))) judgeModelDiffers++;
      values = values.map((v) =>
        isSemanticRow(v.row) && v.value !== undefined && other(v.row.assertionIndex) ? { row: v.row, excluded: "judge_model_differs" } : v,
      );
    }
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
    judgeModelDiffers,
    ...(ts.length ? { tsSpan: { from: ts[0], to: ts[ts.length - 1] } } : {}),
    verdictRate: { pass: verdictWindow.filter((r) => r.pass).length, runs: verdictWindow.length, basis: "index" },
    reads,
    readCapHit,
  };
}
