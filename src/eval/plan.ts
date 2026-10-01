// `eval --dry-run`'s plan: composes the estimator (`planner.ts`) over the history the loader selected
// (`plan-history.ts`) into one payload, and renders that payload as text. Pure — the command supplies every
// input, so a plan is reproducible from them, and the text is drawn from the payload alone, so the two can
// never say different things.
//
// The payload is EXPERIMENTAL (`schemaVersion: 0`) except `cost`'s covered summary keys (see
// `scheduleCostJson`): those are stable from this release on `eval --dry-run` and on `hillclimb run --dry-run`.
import type { RowKey } from "./classify.js";
import type { RowHistoryLoad } from "./plan-history.js";
import { attainableFloor, minRowsToConfirm, type Correction, type Mdd } from "./stats.js";
import {
  HISTORY_WINDOW,
  estimateScheduleCost,
  planRow,
  scheduleCostJson,
  scheduleCostLine,
  sequentialPreview,
  type CostHistory,
  type NSearch,
  type RowPlan,
  type ScheduleCostJson,
  type SequentialPreview,
} from "./planner.js";

/** The largest N any search considers: `eval`'s own `--reps` cap. */
export const PLAN_MAX_REPS = 100;
/** Reps per arm between the looks of the previewed sequential design: one complete ABBA block. */
export const LOOK_EVERY_REPS = 2;

/** The mandatory caveat, printed on every plan. */
export const DETECTABLE_CAVEAT =
  "Detectable = an observed difference this large reaches p ≤ alpha. At the smallest such N the chance of observing a true difference of this size that large is typically about 60%; see `power` and `nForPower80`.";

export interface PlanScenarioInput {
  name: string;
  heldOut: boolean;
  /** The EFFECTIVE tier the scenario runs at (`cowork` resolved), which the history is filtered on. */
  tier: string;
  /** The baseline's app version, as index rows record it. */
  baseline: string;
  agentPin: string;
  rows: readonly RowKey[];
  cost: CostHistory;
  rates: RowHistoryLoad;
}

export interface PlanInput {
  reps: number;
  alpha: number;
  correction: Correction;
  q: number;
  /** Percentage points (30 = 30pp). The source of truth for every `…Pp` key; the estimator gets pp / 100. */
  targetEffectPp?: number;
  allowUnderpowered: boolean;
  history: { runsDir: string; runsDirRedirected: boolean; indexRows: number };
  scenarios: readonly PlanScenarioInput[];
}

/** What the eval would cost at some reps per arm: for one scenario, and for the whole eval (every scenario
 *  runs at the same --reps). Absent figures mean no priced history; `lowerBound` says the eval total left
 *  some scenario out. */
export interface CostAtReps {
  reps: number;
  scenarioP50Usd?: number;
  scenarioP95Usd?: number;
  evalP50Usd: number;
  evalP95Usd: number;
  lowerBound: boolean;
}

export type PlannedSearch = NSearch & { cost?: CostAtReps };
export interface PlannedLevels {
  possible: PlannedSearch;
  confirmedSingleRow: PlannedSearch;
}

export interface PlannedRow {
  id: string;
  kind: RowKey["kind"];
  label: string;
  assertionIndex: number;
  claim?: string;
  /** In the section's correction family (a `semantic_rollup` row is derived, and is not). */
  inFamily: boolean;
  rate: RowPlan["rate"];
  /** The config-matched rate, when the exact-content rate was preferred. */
  relaxedRate?: { k: number; n: number };
  mddAtReps?: RowPlan["mddAtReps"];
  bestCaseMddAtReps: RowPlan["bestCaseMddAtReps"];
  target?: {
    effectPp: number;
    drop: PlannedLevels;
    rise: PlannedLevels;
    nForPower80: { drop: PlannedLevels; rise: PlannedLevels };
    powerAtReps: NonNullable<RowPlan["target"]>["powerAtReps"];
    atBound?: {
      drop?: { p: number; possible: PlannedSearch; confirmedSingleRow: PlannedSearch; nForPower80: PlannedLevels };
      rise?: { p: number; possible: PlannedSearch; confirmedSingleRow: PlannedSearch; nForPower80: PlannedLevels };
    };
  };
  notes: string[];
}

export interface PlannedScenario {
  name: string;
  heldOut: boolean;
  tier: string;
  baseline: string;
  agentPin: string;
  cost: ScheduleCostJson["items"][number] & {
    excluded: NonNullable<CostHistory["excluded"]>;
    distinctSkillHashes: number;
    distinctTiers: number;
  };
  rateHistory: Omit<RowHistoryLoad, "rows" | "relaxedRows">;
  rows: PlannedRow[];
}

export interface PlannedSection {
  /** Rows in the correction family (`semantic_rollup` rows excluded). */
  m: number;
  /** The fixed design the eval runs today: the smallest p any table at --reps can reach, and how many
   *  collapsed rows `confirmed` needs (null: unreachable). */
  fixed: { attainableFloor: number; minRowsToConfirm: number | null };
  sequential: SequentialPreview;
}

export interface EvalPlan {
  schemaVersion: 0;
  reps: number;
  alpha: number;
  correction: Correction;
  q: number;
  targetEffectPp: number | null;
  minReps: number;
  maxReps: number;
  history: { runsDir: string; runsDirRedirected: boolean; indexRows: number; rateWindow: number };
  /** The schedule's cost at --reps. Its summary keys are COVERED (see `scheduleCostJson`). */
  cost: ScheduleCostJson;
  scenarios: PlannedScenario[];
  sections: { tuned: PlannedSection | null; heldOut: PlannedSection | null };
  caveats: string[];
  notes: string[];
}

const ARM_COUNT = 2;

export function planEval(input: PlanInput): EvalPlan {
  const { reps, alpha, correction, q } = input;
  const minReps = input.allowUnderpowered ? 2 : 4;
  const effect = input.targetEffectPp !== undefined ? input.targetEffectPp / 100 : undefined;
  const items = (r: number) => input.scenarios.map((s) => ({ scenario: s.name, jobs: ARM_COUNT * r, history: s.cost }));
  const atReps = estimateScheduleCost(items(reps));

  // Cost at another --reps, per scenario and for the whole eval. Cached: many rows land on the same N.
  const costCache = new Map<number, ReturnType<typeof estimateScheduleCost>>();
  const costAt = (n: number, scenario: string): CostAtReps => {
    let c = costCache.get(n);
    if (c === undefined) costCache.set(n, (c = estimateScheduleCost(items(n))));
    const it = c.items.find((i) => i.scenario === scenario);
    return {
      reps: n,
      ...(it?.p50Usd !== undefined ? { scenarioP50Usd: it.p50Usd } : {}),
      ...(it?.p95Usd !== undefined ? { scenarioP95Usd: it.p95Usd } : {}),
      evalP50Usd: c.p50Usd,
      evalP95Usd: c.p95Usd,
      lowerBound: c.lowerBound,
    };
  };
  const withCost = (s: NSearch, scenario: string): PlannedSearch =>
    typeof s.n === "number" ? { ...s, cost: costAt(s.n, scenario) } : { ...s };
  const levels = (l: { possible: NSearch; confirmedSingleRow: NSearch }, scenario: string): PlannedLevels => ({
    possible: withCost(l.possible, scenario),
    confirmedSingleRow: withCost(l.confirmedSingleRow, scenario),
  });

  const familySize = (held: boolean) =>
    input.scenarios.filter((s) => s.heldOut === held).reduce((n, s) => n + s.rows.filter((r) => r.kind !== "semantic_rollup").length, 0);
  const m = { tuned: familySize(false), heldOut: familySize(true) };

  const costJson = scheduleCostJson(atReps);
  const scenarios: PlannedScenario[] = input.scenarios.map((s, si) => {
    const mSection = s.heldOut ? m.heldOut : m.tuned;
    const rateOf = new Map(s.rates.rows.map((r) => [r.row.id, r.history]));
    const relaxedOf = new Map((s.rates.relaxedRows ?? []).map((r) => [r.row.id, r.history]));
    const rows: PlannedRow[] = s.rows.map((row) => {
      const p = planRow(rateOf.get(row.id), {
        reps,
        alpha,
        correction,
        q,
        m: mSection,
        minReps,
        maxReps: PLAN_MAX_REPS,
        ...(effect !== undefined ? { targetEffect: effect } : {}),
        ...(s.rates.validFraction !== undefined ? { validFraction: s.rates.validFraction } : {}),
      });
      const relaxed = relaxedOf.get(row.id);
      const out: PlannedRow = {
        id: row.id,
        kind: row.kind,
        label: row.label,
        assertionIndex: row.assertionIndex,
        ...(row.claim !== undefined ? { claim: row.claim } : {}),
        inFamily: row.kind !== "semantic_rollup",
        rate: p.rate,
        ...(relaxed ? { relaxedRate: { k: relaxed.k, n: relaxed.n } } : {}),
        ...(p.mddAtReps ? { mddAtReps: p.mddAtReps } : {}),
        bestCaseMddAtReps: p.bestCaseMddAtReps,
        notes: p.notes,
      };
      if (p.target && input.targetEffectPp !== undefined) {
        const t = p.target;
        const bound = (b: NonNullable<NonNullable<RowPlan["target"]>["atBound"]>["drop"]) =>
          b && {
            p: b.p,
            possible: withCost(b.possible, s.name),
            confirmedSingleRow: withCost(b.confirmedSingleRow, s.name),
            nForPower80: levels(b.nForPower80, s.name),
          };
        out.target = {
          effectPp: input.targetEffectPp,
          drop: levels(t.drop, s.name),
          rise: levels(t.rise, s.name),
          nForPower80: { drop: levels(t.nForPower80.drop, s.name), rise: levels(t.nForPower80.rise, s.name) },
          powerAtReps: t.powerAtReps,
          ...(t.atBound
            ? {
                atBound: {
                  ...(t.atBound.drop ? { drop: bound(t.atBound.drop) } : {}),
                  ...(t.atBound.rise ? { rise: bound(t.atBound.rise) } : {}),
                },
              }
            : {}),
        };
      }
      return out;
    });
    const { rows: _r, relaxedRows: _rr, ...rateHistory } = s.rates;
    return {
      name: s.name,
      heldOut: s.heldOut,
      tier: s.tier,
      baseline: s.baseline,
      agentPin: s.agentPin,
      cost: {
        ...costJson.items[si],
        excluded: s.cost.excluded ?? { notRun: 0, tier: 0, baseline: 0, turn: 0, hillclimb: 0 },
        distinctSkillHashes: s.cost.distinctSkillHashes,
        distinctTiers: s.cost.distinctTiers,
      },
      rateHistory,
      rows,
    };
  });

  const floor = attainableFloor(reps, reps);
  const section = (held: boolean): PlannedSection | null => {
    const size = held ? m.heldOut : m.tuned;
    if (size === 0) return null;
    const known = scenarios
      .filter((s) => s.heldOut === held)
      .flatMap((s) => s.rows)
      .filter((r) => r.inFamily && r.rate !== "unknown")
      .map((r) => ({ id: r.id, p: (r.rate as { p: number }).p }));
    return {
      m: size,
      fixed: { attainableFloor: floor, minRowsToConfirm: minRowsToConfirm(floor, size, { correction, q, alpha }) },
      sequential: sequentialPreview({
        reps,
        m: size,
        alpha,
        lookEveryReps: LOOK_EVERY_REPS,
        ...(effect !== undefined ? { rows: known, targetEffect: effect } : {}),
      }),
    };
  };

  const caveats = ["detectable-is-not-power", "arm-agnostic-cost", "judge-spend-not-capped", "p95-and-worst-are-not-bounds"];
  if (atReps.lowerBound) caveats.push("cost-lower-bound");
  const notes: string[] = [];
  if (correction === "bh")
    notes.push(
      "under bh, a single row's `confirmed` level shown here is the rank-1 threshold min(alpha, q/m); other rows collapsing alongside it raise the threshold, so several drops together can confirm earlier",
    );
  return {
    schemaVersion: 0,
    reps,
    alpha,
    correction,
    q,
    targetEffectPp: input.targetEffectPp ?? null,
    minReps,
    maxReps: PLAN_MAX_REPS,
    history: { ...input.history, rateWindow: HISTORY_WINDOW },
    cost: costJson,
    scenarios,
    sections: { tuned: section(false), heldOut: section(true) },
    caveats,
    notes,
  };
}

// ---- text ----------------------------------------------------------------------------------------------

const usd = (x: number) => `$${x.toFixed(4)}`;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const pp = (x: Mdd) => (typeof x === "number" ? `${Math.round(x * 1000) / 10}pp` : x === "none" ? "none at this N" : "n/a");
const rangeText = (r: [Mdd, Mdd]) => (r[0] === r[1] ? pp(r[0]) : `${pp(r[0])} to ${pp(r[1])}`);

function searchText(s: PlannedSearch): string {
  if (s.n === "impossible") return "impossible (the effect leaves 0–100% at this rate)";
  if (s.n === null) return `not within --reps ≤ ${PLAN_MAX_REPS}`;
  const parts = [`N=${s.n}`];
  if (s.stableFrom !== s.n) parts.push(s.stableFrom === null ? `not stable up to ${PLAN_MAX_REPS}` : `stable from ${s.stableFrom}`);
  if (s.power !== undefined) parts.push(`power ≈ ${pct(s.power)}`);
  if (s.scheduleReps !== undefined && s.scheduleReps !== s.n) parts.push(`schedule ${s.scheduleReps} for ${s.n} valid`);
  if (s.cost)
    parts.push(
      (s.cost.scenarioP50Usd !== undefined ? `${usd(s.cost.scenarioP50Usd)} p50 this scenario, ` : "this scenario unpriced, ") +
        `${usd(s.cost.evalP50Usd)} p50 whole eval${s.cost.lowerBound ? " (LOWER BOUND)" : ""}`,
    );
  return `${parts[0]} (${parts.slice(1).join("; ")})`.replace(" ()", "");
}

function rateText(r: PlannedRow): string {
  if (r.rate === "unknown") return "rate unknown";
  const x = r.rate;
  return (
    `rate ${pct(x.p)} (${x.k}/${x.n}, 95% CI ${pct(x.lo)}–${pct(x.hi)}${x.thin ? ", THIN" : ""})` +
    (r.relaxedRate ? ` [config-matched: ${r.relaxedRate.k}/${r.relaxedRate.n}]` : "")
  );
}

/** The plan as stderr lines. `causeText` is the redirected-runs-root clause (`noHistoryCauseText()`), appended
 *  wherever the plan says history is missing. */
export function planText(plan: EvalPlan, o: { tilde?: (p: string) => string; causeText?: string } = {}): string[] {
  const tilde = o.tilde ?? ((p: string) => p);
  const cause = o.causeText ?? "";
  const L: string[] = [];
  const n = plan.scenarios.length;
  L.push("[eval] DRY RUN — no agent runs and no eval dir is created; the figures below are estimates from history");
  L.push(
    `[eval] history: ${tilde(plan.history.runsDir)} (index: ${plan.history.indexRows} row(s))` +
      (plan.history.runsDirRedirected ? " — redirected by --run-dir / COWORK_HARNESS_RUNS_DIR" : "") +
      `; rates from the newest ≤${plan.history.rateWindow} qualifying runs per scenario`,
  );
  L.push(
    `[eval] cost at --reps ${plan.reps} (2 arms × ${plan.reps} reps × ${n} scenario(s)): ${scheduleCostLine(plan.cost)}` +
      (plan.cost.lowerBound ? cause : ""),
  );
  L.push(
    `  judge: p50 ${usd(plan.cost.judgeP50Usd)} · mean ${usd(plan.cost.judgeMeanUsd)} for this schedule — NOT covered by --max-budget-usd, which counts the agent's cost only`,
  );
  if (plan.cost.deciderP50Usd > 0 || plan.cost.deciderMeanUsd > 0)
    L.push(
      `  LLM decider: p50 ${usd(plan.cost.deciderP50Usd)} · mean ${usd(plan.cost.deciderMeanUsd)} for this schedule — not covered by --max-budget-usd either`,
    );
  L.push("  history is arm-agnostic: it prices the scenarios as they ran before, so arm B's cost may differ");

  for (const s of plan.scenarios) {
    L.push(`[eval] scenario ${s.name} — tier ${s.tier}, baseline ${s.baseline}, agent ${s.agentPin}${s.heldOut ? ", held out" : ""}`);
    const c = s.cost;
    const r = c.perRep;
    if (c.priced) {
      const ratio = r.p50Usd && r.worstObservedUsd !== undefined ? ` (worst/p50 ${(r.worstObservedUsd / r.p50Usd).toFixed(1)}×)` : "";
      L.push(
        `  cost: ${r.pricedRuns} priced run(s)${r.thin ? " (THIN)" : ""} — per run p50 ${usd(r.p50Usd!)} · mean ${usd(r.meanUsd!)} · ` +
          `p95 ${usd(r.p95Usd!)}${r.p95IsMax ? " (= the max: 20 or fewer runs)" : ""} · worst ${usd(r.worstObservedUsd!)}${ratio}`,
      );
    } else
      L.push(`  cost: no priced run on tier ${s.tier} and baseline ${s.baseline} — contributes $0 (the total is a LOWER BOUND)${cause}`);
    if (r.budgetGateWorstUsd !== undefined)
      L.push(
        `  budget-gate basis (what --max-budget-usd refuses on): worst ${usd(r.budgetGateWorstUsd)} over ${r.budgetGatePricedRuns} priced run(s) of this scenario name on ANY tier, baseline or turn`,
      );
    if (c.distinctSkillHashes > 1)
      L.push(`  ⚠ the cost history spans ${c.distinctSkillHashes} skill versions: costs from different versions are pooled`);
    const left = [
      c.excluded.turn ? `${c.excluded.turn} resumed turn(s)` : "",
      c.excluded.hillclimb ? `${c.excluded.hillclimb} hillclimb run(s)` : "",
    ].filter(Boolean);
    L.push(
      `  (per-run cost reproduces with: cowork-harness stats ${s.name} --baseline ${s.baseline} --group-by fidelity, the ${s.tier} group` +
        (left.length ? ` — except this plan leaves out ${left.join(" and ")}, which stats counts` : "") +
        ")",
    );

    const h = s.rateHistory;
    if (h.reps === 0) L.push(`  rates: no qualifying run with a readable result — every row is unknown`);
    else
      L.push(
        `  rates: ${h.validReps} valid of ${h.reps} rep(s)` +
          (h.validFraction !== undefined && h.validFraction < 1 ? ` (valid fraction ${h.validFraction.toFixed(2)})` : "") +
          (h.basis === "exact_content"
            ? ` — from the ${h.exactContentReps} that ran arm A's exact content (config-matched rates shown beside)`
            : ` — config-matched (same scenario, tier, baseline, model); ${h.exactContentReps} ran arm A's exact content`) +
          (h.evalReps ? `; ${h.evalReps} from earlier evals` : "") +
          (h.tsSpan ? `; ${h.tsSpan.from.slice(0, 10)} to ${h.tsSpan.to.slice(0, 10)}` : ""),
      );
    if (h.reps > 0 && h.exactContentReps === 0)
      L.push(
        "  no rep ran arm A's exact content — expected after an edit, and always with an --include-untracked arm, history recorded under COWORK_HARNESS_GITSET=0, or a session that declares a different skill dir set",
      );
    const models = Object.entries(h.modelsExcluded);
    if (models.length)
      L.push(
        `  ⚠ ${h.excludedByKey.model} run(s) on another model left out (${models.map(([k, v]) => `${k}: ${v}`).join(", ")}); the pin is ${s.agentPin}`,
      );
    if (h.judgeModelDiffers)
      L.push(`  ${h.judgeModelDiffers} run(s) were graded by another judge model: their claim and roll-up rows leave them out`);
    if (h.readCapHit) L.push(`  ⚠ stopped after ${h.reads} result.json reads (the read cap): the rate window may be short`);
    const ex = Object.entries(h.excludedByKey).filter(([, v]) => v > 0);
    if (ex.length) L.push(`  left out of the rates: ${ex.map(([k, v]) => `${k} ${v}`).join(" · ")}`);
    if (h.verdictRate.runs)
      L.push(
        `  runs passing overall: ${h.verdictRate.pass}/${h.verdictRate.runs} (index verdicts — context only; no row rate is drawn from it)`,
      );

    for (const row of s.rows) {
      const head =
        `  row [${row.assertionIndex}] ${row.label}` +
        (row.kind === "claim" ? ` claim "${row.claim}"` : row.kind === "semantic_rollup" ? " (roll-up, outside the family)" : "");
      const mdd = row.mddAtReps
        ? `MDD at --reps ${plan.reps}: drop ${pp(row.mddAtReps.drop)} · rise ${pp(row.mddAtReps.rise)}` +
          (row.mddAtReps.range.drop[0] !== row.mddAtReps.range.drop[1] || row.mddAtReps.range.rise[0] !== row.mddAtReps.range.rise[1]
            ? ` (over the CI: drop ${rangeText(row.mddAtReps.range.drop)}, rise ${rangeText(row.mddAtReps.range.rise)})`
            : "")
        : `best case at --reps ${plan.reps} (any rate): drop ${pp(row.bestCaseMddAtReps.drop)} · rise ${pp(row.bestCaseMddAtReps.rise)}`;
      L.push(`${head}: ${rateText(row)} · ${mdd}`);
      if (row.target) {
        const t = row.target;
        for (const dir of ["drop", "rise"] as const) {
          const atR = t.powerAtReps[dir];
          L.push(
            `      ${t.effectPp}pp ${dir}: possible ${searchText(t[dir].possible)}; confirmed (single row) ${searchText(t[dir].confirmedSingleRow)}; ` +
              `80% power: possible ${searchText(t.nForPower80[dir].possible)}, confirmed ${searchText(t.nForPower80[dir].confirmedSingleRow)}` +
              (typeof atR.possible === "number" ? `; power at --reps ${plan.reps} ≈ ${pct(atR.possible)}` : ""),
          );
        }
      }
      for (const note of row.notes) L.push(`      ${note}`);
    }
  }

  for (const [name, sec] of [
    ["tuned", plan.sections.tuned],
    ["held-out", plan.sections.heldOut],
  ] as const) {
    if (!sec) continue;
    const seq = sec.sequential;
    const j = sec.fixed.minRowsToConfirm;
    L.push(
      `[eval] fixed design (what eval runs today), ${name} section: ${sec.m} row(s) in the family; at --reps ${plan.reps} ` +
        (j === null
          ? "`confirmed` is unreachable"
          : j === 1
            ? "one collapsed row can reach `confirmed`"
            : `\`confirmed\` needs >= ${j} collapsed rows`),
    );
    L.push(
      `[eval] sequential, ${name} section (planned, NOT implemented — assumed: a look every ${seq.scheme.lookEveryReps} reps per arm, L=${seq.scheme.looks}, alpha/L per look, holm within a look): ` +
        (seq.firstConfirmableLook
          ? `first look where \`confirmed\` is reachable, ${seq.basis}: look ${seq.firstConfirmableLook.look} (${seq.firstConfirmableLook.repsPerArm} reps per arm)`
          : `\`confirmed\` is never reachable at --reps ${plan.reps}, ${seq.basis} — a sequential run could never confirm here, and the planned --sequential would refuse it`),
    );
    const f = (x: { look: number; repsPerArm: number } | null) => (x ? `look ${x.look} (${x.repsPerArm} reps)` : "none");
    const reached = (seq.byRow ?? []).filter((r) => r.firstLookForTarget.drop || r.firstLookForTarget.rise);
    for (const r of reached)
      L.push(
        `  ${r.id}: first look for ${plan.targetEffectPp}pp — drop ${f(r.firstLookForTarget.drop)}, rise ${f(r.firstLookForTarget.rise)}`,
      );
    if (seq.byRow && reached.length < seq.byRow.length)
      L.push(
        `  ${seq.byRow.length - reached.length} of ${seq.byRow.length} row(s) with a known rate reach a ${plan.targetEffectPp}pp change at no look within --reps ${plan.reps}`,
      );
    for (const note of seq.notes.slice(1)) L.push(`  ${note}`);
  }
  for (const note of plan.notes) L.push(`[eval] note: ${note}`);
  L.push(`[eval] ${DETECTABLE_CAVEAT} (alpha ${plan.alpha})`);
  return L;
}
