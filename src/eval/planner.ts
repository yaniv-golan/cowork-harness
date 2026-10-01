// The eval planner's estimator: what a paired eval would cost, and what it could detect, from history.
// Pure — no I/O, no clock, no randomness — so every number a plan prints is reproducible from its inputs.
// The history it reasons from is loaded by `plan-history.ts`; this module never touches the filesystem.
//
// Two definitions the whole module rests on:
//   - "Detectable at N" means the eval report's OWN minimum detectable difference (`minimumDetectableDifference`
//     in stats.ts), at A = the projected count and n1 = n2 = N, is <= the effect. The planner and the report
//     therefore cannot disagree about what N shows a difference. The MDD here is read from a cached matrix of
//     the same `fisherTwoSided` values the report computes; a test pins the two equal for every k1 and N <= 40.
//   - Power is the probability that a TRUE difference of the target size is observed AND reaches the level,
//     in the right direction, under independent binomial sampling of each arm. At the smallest detectable N
//     it is typically only about 60%, which is why every N carries its power and `nForPower80` exists.
import { fisherTwoSided, wilsonInterval, type Correction, type Mdd } from "./stats.js";
import { percentile } from "../run/run-index.js";

/** Rate history window: the newest this-many qualifying runs per scenario. */
export const HISTORY_WINDOW = 50;
/** Below this many valid reps (rates) or priced runs (cost), the history is labelled thin. */
export const THIN_BELOW = 5;
/** The power `nForPower80` sizes for. A constant; a flag can be added later without changing its meaning. */
export const POWER_TARGET = 0.8;
/** With at least this many valid reps of arm A's exact content, rates come from those reps (the relaxed,
 *  config-matched rates are shown beside them). */
export const EXACT_CONTENT_MIN = THIN_BELOW;
/** The MDD is a float difference of two ratios: 0.5 can come back as 0.5000000000000001. */
const TOLERANCE = 1e-9;
/** Binomial mass below this, per arm, is skipped in the power sum. */
const PMF_FLOOR = 1e-12;

// ---- cost ------------------------------------------------------------------------------------------------

/** One history run's spend. Absent ≠ 0: an unpriced field is skipped, never summed as free. */
export interface CostSample {
  agentUsd?: number;
  judgeUsd?: number;
  deciderUsd?: number;
}

/** A scenario's cost history, already filtered by the loader.
 *
 *  `samples` is THE cost basis: the runs `stats <name> --baseline <b> --group-by fidelity` aggregates for
 *  the eval's effective tier, minus resumed turns (turn > 1) and hillclimb runs. Every covered cost figure
 *  — mean, p50, p95, worst observed, priced runs, thinnest, lower bound — is computed from it and nothing
 *  else.
 *
 *  `budgetGateWorstUsd` / `budgetGatePricedRuns` are a different, wider basis: the `--max-budget-usd`
 *  gate's own (scenario name only, any tier or baseline, every turn). They are carried only so a caller can
 *  preview what the gate would refuse on; they never feed a covered figure. */
export interface CostHistory {
  scenario: string;
  samples: CostSample[];
  budgetGateWorstUsd?: number;
  budgetGatePricedRuns: number;
  distinctSkillHashes: number;
  distinctTiers: number;
  /** Runs of this scenario each cost-basis filter left out (from the loader). */
  excluded?: { notRun: number; tier: number; baseline: number; turn: number; hillclimb: number };
}

export interface PerRepCost {
  /** Cost-basis runs with an agent cost. */
  pricedRuns: number;
  meanUsd?: number;
  p50Usd?: number;
  /** Floor-index p95: the max of the runs when there are 20 or fewer (`p95IsMax`). */
  p95Usd?: number;
  p95IsMax: boolean;
  judgeMeanUsd?: number;
  judgeP50Usd?: number;
  judgeP95Usd?: number;
  judgePricedRuns: number;
  /** Cost-basis runs with no judge cost (no judged assertion, or unpriced). */
  judgeUnpriced: number;
  deciderP50Usd?: number;
  deciderP95Usd?: number;
  /** The worst single priced run on the cost basis. */
  worstObservedUsd?: number;
  /** The budget gate's wider basis (any tier or baseline): its worst run and how many priced runs it has. */
  budgetGateWorstUsd?: number;
  budgetGatePricedRuns: number;
  /** Fewer than THIN_BELOW priced runs. */
  thin: boolean;
}

const ascending = (xs: Array<number | undefined>): number[] =>
  xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
const mean = (xs: readonly number[]): number | undefined => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined);
const pct = (xs: readonly number[], p: number): number | undefined => (xs.length ? percentile(xs, p) : undefined);

export function perRepCost(h: CostHistory): PerRepCost {
  const agent = ascending(h.samples.map((s) => s.agentUsd));
  const judge = ascending(h.samples.map((s) => s.judgeUsd));
  const decider = ascending(h.samples.map((s) => s.deciderUsd));
  const opt = (k: string, v: number | undefined) => (v === undefined ? {} : { [k]: v });
  return {
    pricedRuns: agent.length,
    ...opt("meanUsd", mean(agent)),
    ...opt("p50Usd", pct(agent, 0.5)),
    ...opt("p95Usd", pct(agent, 0.95)),
    p95IsMax: agent.length > 0 && Math.min(agent.length - 1, Math.floor(0.95 * agent.length)) === agent.length - 1,
    ...opt("judgeMeanUsd", mean(judge)),
    ...opt("judgeP50Usd", pct(judge, 0.5)),
    ...opt("judgeP95Usd", pct(judge, 0.95)),
    judgePricedRuns: judge.length,
    judgeUnpriced: h.samples.length - judge.length,
    ...opt("deciderP50Usd", pct(decider, 0.5)),
    ...opt("deciderP95Usd", pct(decider, 0.95)),
    ...opt("worstObservedUsd", agent.length ? agent[agent.length - 1] : undefined),
    ...opt("budgetGateWorstUsd", h.budgetGateWorstUsd),
    budgetGatePricedRuns: h.budgetGatePricedRuns,
    thin: agent.length < THIN_BELOW,
  };
}

/** One scheduled scenario: how many agent runs the schedule makes of it, and its history. */
export interface ScheduleCostItem {
  scenario: string;
  /** Agent runs scheduled (an eval: 2 arms x reps; a one-arm flow: the reps it will run). */
  jobs: number;
  history: CostHistory;
}

export interface ScheduleCostItemEstimate {
  scenario: string;
  jobs: number;
  /** The cost basis had at least one priced run. */
  priced: boolean;
  meanUsd?: number;
  p50Usd?: number;
  p95Usd?: number;
  worstObservedUsd?: number;
  /** jobs x the budget gate's worst (experimental; a different basis from every other figure). */
  budgetGateWorstUsd?: number;
  judgeMeanUsd?: number;
  judgeP50Usd?: number;
  perRep: PerRepCost;
}

export interface ScheduleCost {
  /** Agent runs scheduled, summed over every scenario (priced or not). */
  jobs: number;
  /** Sums over the PRICED scenarios: unpriced ones contribute 0 and make the total a lower bound. */
  meanUsd: number;
  p50Usd: number;
  p95Usd: number;
  /** Sum over the priced scenarios of jobs x the worst cost-basis run — every run at the worst seen. */
  worstObservedUsd: number;
  /** Sum over scenarios with gate history of jobs x the gate's worst (any tier or baseline). Experimental:
   *  a preview of the `--max-budget-usd` gate's basis, which is wider than every other figure here. */
  budgetGateWorstUsd: number;
  judgeMeanUsd: number;
  judgeP50Usd: number;
  unpriced: string[];
  lowerBound: boolean;
  /** Cost-basis priced runs behind the estimate, over the priced scenarios. */
  pricedRuns: number;
  /** The thinnest priced scenario's run count; null when nothing was priced. */
  thinnest: number | null;
  items: ScheduleCostItemEstimate[];
}

export function estimateScheduleCost(items: readonly ScheduleCostItem[]): ScheduleCost {
  const out: ScheduleCost = {
    jobs: 0,
    meanUsd: 0,
    p50Usd: 0,
    p95Usd: 0,
    worstObservedUsd: 0,
    budgetGateWorstUsd: 0,
    judgeMeanUsd: 0,
    judgeP50Usd: 0,
    unpriced: [],
    lowerBound: false,
    pricedRuns: 0,
    thinnest: null,
    items: [],
  };
  for (const it of items) {
    const perRep = perRepCost(it.history);
    const priced = perRep.pricedRuns > 0;
    const times = (v: number | undefined) => (v === undefined ? undefined : it.jobs * v);
    const est: ScheduleCostItemEstimate = { scenario: it.scenario, jobs: it.jobs, priced, perRep };
    const set = (k: keyof ScheduleCostItemEstimate, v: number | undefined) => {
      if (v !== undefined) (est as unknown as Record<string, number>)[k] = v;
    };
    set("meanUsd", times(perRep.meanUsd));
    set("p50Usd", times(perRep.p50Usd));
    set("p95Usd", times(perRep.p95Usd));
    set("worstObservedUsd", times(perRep.worstObservedUsd));
    set("budgetGateWorstUsd", times(perRep.budgetGateWorstUsd));
    set("judgeMeanUsd", times(perRep.judgeMeanUsd));
    set("judgeP50Usd", times(perRep.judgeP50Usd));
    out.jobs += it.jobs;
    out.budgetGateWorstUsd += est.budgetGateWorstUsd ?? 0;
    out.judgeMeanUsd += est.judgeMeanUsd ?? 0;
    out.judgeP50Usd += est.judgeP50Usd ?? 0;
    if (priced) {
      out.meanUsd += est.meanUsd!;
      out.p50Usd += est.p50Usd!;
      out.p95Usd += est.p95Usd!;
      out.worstObservedUsd += est.worstObservedUsd!;
      out.pricedRuns += perRep.pricedRuns;
      out.thinnest = out.thinnest === null ? perRep.pricedRuns : Math.min(out.thinnest, perRep.pricedRuns);
    } else out.unpriced.push(it.scenario);
    out.items.push(est);
  }
  out.lowerBound = out.unpriced.length > 0;
  return out;
}

const usd = (x: number) => `$${x.toFixed(4)}`;

/** The one-line text estimate. Phrased so a partially-unpriced total can never read as authoritative (the
 *  same LOWER BOUND wording as the batch budget line), and so neither p95 nor the worst-observed sum reads
 *  as a bound — neither is one. Every figure on it is on the one cost basis; the budget gate's wider figure
 *  is not printed here, so it can never sit beside "contribute $0". */
export function scheduleCostLine(c: ScheduleCost): string {
  const n = c.items.length;
  const bound = c.lowerBound
    ? ` — LOWER BOUND (${c.unpriced.length}/${n} scenario(s) have no priced run history and contribute $0: ` +
      `${c.unpriced.slice(0, 5).join(", ")}${c.unpriced.length > 5 ? `, +${c.unpriced.length - 5} more` : ""})`
    : "";
  // Floor-index p95 is the max for 20 or fewer runs: say so whenever it is, not only for thin history.
  const p95AtMax = c.items.filter((i) => i.priced && i.perRep.p95IsMax).length;
  const basis =
    c.thinnest === null
      ? ""
      : ` — basis: ${c.pricedRuns} prior run(s) on THIS machine, thinnest scenario has ${c.thinnest}` +
        (c.thinnest < THIN_BELOW ? " (thin)" : "") +
        (p95AtMax ? `; p95 is the max observed run for ${p95AtMax} scenario(s) (20 or fewer priced runs)` : "");
  return (
    `estimated cost of ${c.jobs} run(s): p50 ${usd(c.p50Usd)} · mean ${usd(c.meanUsd)} · ` +
    `p95 ${usd(c.p95Usd)} (pessimistic: every run at its scenario's p95 — not a bound) · ` +
    `worst observed ${usd(c.worstObservedUsd)} (every run at its scenario's worst on this basis — not a bound)` +
    `${bound}${basis}`
  );
}

/** The cost object both `eval --dry-run` and `hillclimb run --dry-run` emit — one function, so the two
 *  commands cannot disagree about what a key means.
 *
 *  COVERED (stable from this release on both commands): `jobs` (agent runs scheduled), `meanUsd`, `p50Usd`,
 *  `p95Usd`, `worstObservedUsd`, `lowerBound`, `unpriced`, `pricedRuns`, `thinnest`. Every covered key is
 *  always present (`thinnest` is null when nothing was priced), and every one describes ONE basis: the
 *  scenario's runs on the eval's effective tier and baseline, turn 1, hillclimb runs excluded by default
 *  (see `CostHistory`). The dollar figures sum over the priced scenarios only; an unpriced one adds $0 to
 *  each of them and is named in `unpriced`.
 *
 *  EXPERIMENTAL (may change): `budgetGateWorstUsd` (the `--max-budget-usd` gate's wider any-tier basis),
 *  `judgeMeanUsd`, `judgeP50Usd` and `items[]` (with its `perRep`). */
export interface ScheduleCostJson {
  // ---- covered ----
  jobs: number;
  meanUsd: number;
  p50Usd: number;
  p95Usd: number;
  worstObservedUsd: number;
  lowerBound: boolean;
  unpriced: string[];
  pricedRuns: number;
  thinnest: number | null;
  // ---- experimental ----
  budgetGateWorstUsd: number;
  judgeMeanUsd: number;
  judgeP50Usd: number;
  items: Array<Omit<ScheduleCostItemEstimate, "perRep"> & { perRep: PerRepCost }>;
}

export function scheduleCostJson(c: ScheduleCost): ScheduleCostJson {
  return {
    jobs: c.jobs,
    meanUsd: c.meanUsd,
    p50Usd: c.p50Usd,
    p95Usd: c.p95Usd,
    worstObservedUsd: c.worstObservedUsd,
    lowerBound: c.lowerBound,
    unpriced: [...c.unpriced],
    pricedRuns: c.pricedRuns,
    thinnest: c.thinnest,
    // ---- experimental below ----
    budgetGateWorstUsd: c.budgetGateWorstUsd,
    judgeMeanUsd: c.judgeMeanUsd,
    judgeP50Usd: c.judgeP50Usd,
    items: c.items.map((i) => ({
      scenario: i.scenario,
      jobs: i.jobs,
      priced: i.priced,
      ...(i.meanUsd !== undefined ? { meanUsd: i.meanUsd } : {}),
      ...(i.p50Usd !== undefined ? { p50Usd: i.p50Usd } : {}),
      ...(i.p95Usd !== undefined ? { p95Usd: i.p95Usd } : {}),
      ...(i.worstObservedUsd !== undefined ? { worstObservedUsd: i.worstObservedUsd } : {}),
      ...(i.budgetGateWorstUsd !== undefined ? { budgetGateWorstUsd: i.budgetGateWorstUsd } : {}),
      ...(i.judgeMeanUsd !== undefined ? { judgeMeanUsd: i.judgeMeanUsd } : {}),
      ...(i.judgeP50Usd !== undefined ? { judgeP50Usd: i.judgeP50Usd } : {}),
      perRep: { ...i.perRep },
    })),
  };
}

// ---- the cached p-value matrices ------------------------------------------------------------------------

/** p[k1 * (N + 1) + k2] = fisherTwoSided(k1, N, k2, N): the two-sided p of every equal-arm table at N. It
 *  does not depend on any rate, so one matrix per N serves every row, level and direction — the MDD, the
 *  attainable floor and the power rejection region are all read from it. Built by calling the report's own
 *  `fisherTwoSided` for every cell (no symmetry shortcut: the values must be the report's, bit for bit). */
const pMatrices = new Map<number, Float64Array>();
let builds = 0;

function pMatrix(N: number): Float64Array {
  let m = pMatrices.get(N);
  if (m === undefined) {
    m = new Float64Array((N + 1) * (N + 1));
    for (let a = 0; a <= N; a++) for (let b = 0; b <= N; b++) m[a * (N + 1) + b] = fisherTwoSided(a, N, b, N);
    pMatrices.set(N, m);
    builds++;
  }
  return m;
}

/** Test seam: how many p-value matrices have been built in this process. */
export function pValueMatrixBuilds(): number {
  return builds;
}

/** Test seam: drop every cached matrix and region, so a timing test measures a cold build. */
export function resetPlannerCaches(): void {
  pMatrices.clear();
  regions.clear();
}

/** The same value `minimumDetectableDifference(k1, N, N, level)` returns, read from the cached matrix. */
export function cachedMdd(k1: number, N: number, level: number): { drop: Mdd; rise: Mdd } {
  const m = pMatrix(N);
  let drop: Mdd = k1 === 0 ? "n/a" : "none";
  let rise: Mdd = k1 === N ? "n/a" : "none";
  for (let k2 = 0; k2 <= N; k2++) {
    const cmp = k2 - k1;
    if (cmp === 0 || m[k1 * (N + 1) + k2] > level) continue;
    const diff = Math.abs(k2 / N - k1 / N);
    if (cmp < 0 && drop !== "n/a") drop = drop === "none" ? diff : Math.min(drop, diff);
    if (cmp > 0 && rise !== "n/a") rise = rise === "none" ? diff : Math.min(rise, diff);
  }
  return { drop, rise };
}

/** `attainableFloor(N, N)` from the cached matrix (the smallest p any table at N can reach). */
function cachedFloor(N: number): number {
  const m = pMatrix(N);
  let best = 1;
  for (const p of m) best = Math.min(best, p);
  return best;
}

/** Rejection region per (N, level): for each k1, the k2 values (in each direction) whose table reaches the
 *  level. Cached, so the N searches and every row reuse it. */
const regions = new Map<string, { rise: number[][]; drop: number[][] }>();
function rejectionRegion(N: number, level: number) {
  const key = `${N}|${level}`;
  let r = regions.get(key);
  if (r === undefined) {
    const m = pMatrix(N);
    r = { rise: [], drop: [] };
    for (let k1 = 0; k1 <= N; k1++) {
      const up: number[] = [];
      const down: number[] = [];
      for (let k2 = 0; k2 <= N; k2++) {
        if (k2 === k1 || m[k1 * (N + 1) + k2] > level) continue;
        (k2 > k1 ? up : down).push(k2);
      }
      r.rise.push(up);
      r.drop.push(down);
    }
    regions.set(key, r);
  }
  return r;
}

const logFact: number[] = [0];
function lf(n: number): number {
  for (let i = logFact.length; i <= n; i++) logFact[i] = logFact[i - 1] + Math.log(i);
  return logFact[n];
}

/** Binomial pmf of 0..N at rate p, in log space. */
function binomialPmf(N: number, p: number): Float64Array {
  const out = new Float64Array(N + 1);
  if (p <= 0) out[0] = 1;
  else if (p >= 1) out[N] = 1;
  else for (let k = 0; k <= N; k++) out[k] = Math.exp(lf(N) - lf(k) - lf(N - k) + k * Math.log(p) + (N - k) * Math.log(1 - p));
  return out;
}

export type Direction = "drop" | "rise";

/** P(an eval with N valid reps per arm labels this row a `direction` at `level`) when A's true rate is pA and
 *  B's is pB. Only same-direction rejections count: a detected rise must be a rise. */
export function powerAt(N: number, pA: number, pB: number, level: number, direction: Direction): number {
  const region = rejectionRegion(N, level)[direction];
  const a = binomialPmf(N, pA);
  const b = binomialPmf(N, pB);
  let s = 0;
  for (let k1 = 0; k1 <= N; k1++) {
    if (a[k1] < PMF_FLOOR) continue;
    let inner = 0;
    for (const k2 of region[k1]) if (b[k2] >= PMF_FLOOR) inner += b[k2];
    s += a[k1] * inner;
  }
  return Math.min(1, s);
}

// ---- rows ------------------------------------------------------------------------------------------------

/** A row's history: k passing of n valid reps, and why other reps were left out. */
export interface RowHistory {
  k: number;
  n: number;
  excluded?: Record<string, number>;
}

export interface RowPlanOptions {
  /** The planned `--reps`. */
  reps: number;
  alpha: number;
  correction: Correction;
  q: number;
  /** The section's family size (the `confirmed` single-row level depends on it). */
  m: number;
  /** Smallest N the search considers (4, or 2 with `--allow-underpowered`). */
  minReps: number;
  /** Largest N the search considers (the eval's `--reps` cap). */
  maxReps: number;
  /** The target effect as a fraction (0.5 = 50pp). */
  targetEffect?: number;
  /** Historical valid / scheduled fraction; inflates each N into the reps to schedule. */
  validFraction?: number;
}

/** A searched N: a number, `null` (not within maxReps) or "impossible" (the effect leaves [0, 1]).
 *  `stableFrom` is the smallest N from which the criterion holds at EVERY larger N up to maxReps — neither
 *  the MDD nor power is monotone in N. `power` is the power at `n` for the target effect. */
export interface NSearch {
  n: number | null | "impossible";
  stableFrom: number | null;
  power?: number;
  /** ceil(n / validFraction): the reps to schedule for n VALID reps. */
  scheduleReps?: number;
}

export interface LevelSearch {
  possible: NSearch;
  confirmedSingleRow: NSearch;
}

export interface TargetAtBound {
  /** The Wilson bound the target was recomputed at. */
  p: number;
  possible: NSearch;
  confirmedSingleRow: NSearch;
  nForPower80: LevelSearch;
}

export interface RowPlan {
  rate: { k: number; n: number; p: number; lo: number; hi: number; thin: boolean } | "unknown";
  /** Absent when the rate is unknown. `range`: the min and max of each direction over EVERY k1 in the
   *  Wilson interval at --reps (ordered: a number, then "none", then "n/a"). */
  mddAtReps?: { drop: Mdd; rise: Mdd; range: { drop: [Mdd, Mdd]; rise: [Mdd, Mdd] } };
  /** Rate-free: the smallest MDD any k1 allows at --reps. Always present. */
  bestCaseMddAtReps: { drop: Mdd; rise: Mdd };
  target?: {
    effect: number;
    drop: LevelSearch;
    rise: LevelSearch;
    nForPower80: { drop: LevelSearch; rise: LevelSearch };
    powerAtReps: { drop: PowerPair; rise: PowerPair };
    /** At a ceiling (k = n) or floor (k = 0), where the target is impossible at the point estimate: the
     *  same searches at the Wilson bound that makes it possible (the lower bound for a rise, the upper for a
     *  drop) — "if the true rate is X". */
    atBound?: { drop?: TargetAtBound; rise?: TargetAtBound };
  };
  notes: string[];
}

type PowerPair = { possible: number | "impossible"; confirmedSingleRow: number | "impossible" };

/** The level a single row must reach to be `confirmed` in a family of m: Holm's first step alpha/m; under BH
 *  the rank-1 threshold q/m, capped at alpha because `confirmed` is a subset of `possible`. */
export function confirmedSingleRowLevel(o: { correction: Correction; alpha: number; q: number; m: number }): number {
  const m = Math.max(1, o.m);
  return o.correction === "holm" ? o.alpha / m : Math.min(o.alpha, o.q / m);
}

/** A's projected passing count at N reps from a historical rate. */
export function projectedK1(p: number, N: number): number {
  return Math.min(N, Math.max(0, Math.round(p * N)));
}

const mddRank = (x: Mdd): number => (typeof x === "number" ? x : x === "none" ? 2 : 3);
const minMdd = (a: Mdd, b: Mdd): Mdd => (mddRank(b) < mddRank(a) ? b : a);
const maxMdd = (a: Mdd, b: Mdd): Mdd => (mddRank(b) > mddRank(a) ? b : a);
const meets = (x: Mdd, effect: number) => typeof x === "number" && x <= effect + TOLERANCE;

/** Is a `direction` shift of `effect` from rate p inside [0, 1]? (The boundary itself is possible.) */
function possibleShift(p: number, effect: number, direction: Direction): boolean {
  return direction === "rise" ? p + effect <= 1 + TOLERANCE : p - effect >= -TOLERANCE;
}

function search(min: number, max: number, holds: (N: number) => boolean): { n: number | null; stableFrom: number | null } {
  const ok: boolean[] = [];
  let n: number | null = null;
  for (let N = min; N <= max; N++) {
    ok[N] = holds(N);
    if (ok[N] && n === null) n = N;
  }
  let stableFrom: number | null = null;
  for (let N = max; N >= min && ok[N]; N--) stableFrom = N;
  return { n, stableFrom };
}

function nSearches(
  p: number,
  effect: number,
  direction: Direction,
  levels: { possible: number; confirmedSingleRow: number },
  o: RowPlanOptions,
) {
  const pB = direction === "rise" ? Math.min(1, p + effect) : Math.max(0, p - effect);
  const finish = (s: { n: number | null; stableFrom: number | null }, level: number): NSearch => ({
    ...s,
    ...(typeof s.n === "number" ? { power: powerAt(s.n, p, pB, level, direction) } : {}),
    ...(typeof s.n === "number" && o.validFraction !== undefined && o.validFraction > 0
      ? { scheduleReps: Math.ceil(s.n / o.validFraction) }
      : {}),
  });
  const impossible: NSearch = { n: "impossible", stableFrom: null };
  const each = (fn: (level: number) => NSearch): LevelSearch => ({
    possible: fn(levels.possible),
    confirmedSingleRow: fn(levels.confirmedSingleRow),
  });
  if (!possibleShift(p, effect, direction)) return { mdd: each(() => impossible), power80: each(() => impossible), atReps: null };
  const mdd = each((level) =>
    finish(
      search(o.minReps, o.maxReps, (N) => meets(cachedMdd(projectedK1(p, N), N, level)[direction], effect)),
      level,
    ),
  );
  const power80 = each((level) =>
    finish(
      search(o.minReps, o.maxReps, (N) => powerAt(N, p, pB, level, direction) >= POWER_TARGET),
      level,
    ),
  );
  const atReps = {
    possible: powerAt(o.reps, p, pB, levels.possible, direction),
    confirmedSingleRow: powerAt(o.reps, p, pB, levels.confirmedSingleRow, direction),
  };
  return { mdd, power80, atReps };
}

const pp = (x: number) => `${Math.round(x * 100)}%`;
const ppEffect = (x: number) => `${Math.round(x * 1000) / 10}pp`;

/** Plan one row: its rate, its MDD at --reps (point, Wilson range, best case), and with a target effect the
 *  smallest N that detects it and the smallest N with 80% power, at the `possible` and single-row `confirmed`
 *  levels. A row with no history gets only the rate-free best case. */
export function planRow(h: RowHistory | undefined, o: RowPlanOptions): RowPlan {
  const N = o.reps;
  const notes: string[] = [];
  const levels = { possible: o.alpha, confirmedSingleRow: confirmedSingleRowLevel(o) };
  let best = { drop: "none" as Mdd, rise: "none" as Mdd };
  for (let k1 = 0; k1 <= N; k1++) {
    const x = cachedMdd(k1, N, o.alpha);
    best = { drop: minMdd(best.drop, x.drop), rise: minMdd(best.rise, x.rise) };
  }
  if (h === undefined || h.n === 0) {
    notes.push("no per-row history: rate unknown; only the best case (min over every rate) is shown");
    return { rate: "unknown", bestCaseMddAtReps: best, notes };
  }
  const p = h.k / h.n;
  const w = wilsonInterval(h.k, h.n);
  const rate = { k: h.k, n: h.n, p, lo: w.lower, hi: w.upper, thin: h.n < THIN_BELOW };
  if (rate.thin) notes.push(`thin history: ${h.k}/${h.n} valid reps (95% CI ${pp(w.lower)}–${pp(w.upper)})`);

  const point = cachedMdd(projectedK1(p, N), N, o.alpha);
  let range = { drop: [point.drop, point.drop] as [Mdd, Mdd], rise: [point.rise, point.rise] as [Mdd, Mdd] };
  for (let k1 = projectedK1(w.lower, N); k1 <= projectedK1(w.upper, N); k1++) {
    const x = cachedMdd(k1, N, o.alpha);
    range = {
      drop: [minMdd(range.drop[0], x.drop), maxMdd(range.drop[1], x.drop)],
      rise: [minMdd(range.rise[0], x.rise), maxMdd(range.rise[1], x.rise)],
    };
  }
  if (h.k === h.n) notes.push("ceiling: a rise is undetectable at any N at the point estimate");
  if (h.k === 0) notes.push("floor: a drop is undetectable at any N at the point estimate");
  const plan: RowPlan = { rate, mddAtReps: { ...point, range }, bestCaseMddAtReps: best, notes };
  if (o.targetEffect === undefined) return plan;

  const effect = o.targetEffect;
  const drop = nSearches(p, effect, "drop", levels, o);
  const rise = nSearches(p, effect, "rise", levels, o);
  const pair = (x: typeof drop): PowerPair => x.atReps ?? { possible: "impossible", confirmedSingleRow: "impossible" };
  const atBound: NonNullable<RowPlan["target"]>["atBound"] = {};
  // At a ceiling (k = n) a rise is impossible at the point estimate, and at a floor (k = 0) a drop is; the
  // interval says the true rate may not be there, so show what the target needs at the interval's far end.
  for (const dir of ["drop", "rise"] as const) {
    const atEdge = dir === "rise" ? h.k === h.n : h.k === 0;
    if (!atEdge || (dir === "rise" ? rise : drop).atReps !== null) continue;
    const bound = dir === "rise" ? w.lower : w.upper;
    if (!possibleShift(bound, effect, dir)) continue;
    const s = nSearches(bound, effect, dir, levels, o);
    atBound[dir] = { p: bound, possible: s.mdd.possible, confirmedSingleRow: s.mdd.confirmedSingleRow, nForPower80: s.power80 };
    const n = s.mdd.possible.n;
    notes.push(
      `if the true rate is ${pp(bound)}, a ${ppEffect(effect)} ${dir} needs N = ${n === null ? `more than ${o.maxReps}` : n} (possible)`,
    );
  }
  plan.target = {
    effect,
    drop: drop.mdd,
    rise: rise.mdd,
    nForPower80: { drop: drop.power80, rise: rise.power80 },
    powerAtReps: { drop: pair(drop), rise: pair(rise) },
    ...(atBound.drop || atBound.rise ? { atBound } : {}),
  };
  return plan;
}

// ---- the sequential preview -------------------------------------------------------------------------------

export interface SequentialPreviewOptions {
  reps: number;
  /** The section's family size. */
  m: number;
  alpha: number;
  /** Reps per arm between looks. 2 = a look after every complete ABBA block: the most looks, so the most
   *  conservative per-look alpha. */
  lookEveryReps?: number;
  rows?: Array<{ id: string; p: number }>;
  targetEffect?: number;
}

export interface SequentialPreview {
  scheme: {
    name: "bonferroni-looks-holm";
    lookEveryReps: number;
    looks: number;
    perLookAlpha: number;
    correction: "holm";
    /** Always false: this previews a planned design; nothing runs it yet. */
    implemented: false;
  };
  /** "best case (a single row at its attainable floor)". */
  basis: string;
  /** The first look at which a single row at its attainable floor can reach `confirmed`; null = never at
   *  this --reps. */
  firstConfirmableLook: { look: number; repsPerArm: number } | null;
  /** Reps after the last complete block: they run but no look counts them. */
  unpairedReps: number;
  byRow?: Array<{
    id: string;
    firstLookForTarget: { drop: { look: number; repsPerArm: number } | null; rise: { look: number; repsPerArm: number } | null };
  }>;
  notes: string[];
}

/** Preview of a not-yet-implemented sequential design: a look every `lookEveryReps` reps per arm, L =
 *  floor(reps / lookEveryReps) looks, each at alpha / L (Bonferroni across looks), Holm within a look. */
export function sequentialPreview(o: SequentialPreviewOptions): SequentialPreview {
  const every = o.lookEveryReps ?? 2;
  if (!Number.isInteger(every) || every < 1) throw new RangeError(`lookEveryReps must be a positive integer, got ${every}`);
  const L = Math.floor(o.reps / every);
  const m = Math.max(1, o.m);
  const perLookAlpha = L > 0 ? o.alpha / L : 0;
  const level = L > 0 ? perLookAlpha / m : 0;
  let first: SequentialPreview["firstConfirmableLook"] = null;
  for (let look = 1; look <= L && first === null; look++) {
    const r = look * every;
    // No planned-reps threshold here: the design takes the threshold from reps COMPLETED, which any look of
    // 2+ reps meets (`insufficientThreshold(r) <= r`), and a 1-rep look's floor (1) can never reach a level.
    if (cachedFloor(r) <= level) first = { look, repsPerArm: r };
  }
  const unpairedReps = o.reps - L * every;
  const notes = [
    "--sequential is not implemented (planned); this previews its assumed design: a look every " +
      `${every} reps per arm, alpha/L per look (Bonferroni across looks), Holm within a look. ` +
      "A look every block is the most conservative spacing; the final design may use fewer looks.",
    "L grows with --reps, so the first confirmable look can move later as --reps grows.",
  ];
  if (unpairedReps > 0) notes.push(`${unpairedReps} unpaired rep(s) per arm after the last complete block: no look counts them`);
  const out: SequentialPreview = {
    scheme: { name: "bonferroni-looks-holm", lookEveryReps: every, looks: L, perLookAlpha, correction: "holm", implemented: false },
    basis: "best case (a single row at its attainable floor)",
    firstConfirmableLook: first,
    unpairedReps,
    notes,
  };
  if (o.rows && o.targetEffect !== undefined) {
    const effect = o.targetEffect;
    out.byRow = o.rows.map(({ id, p }) => {
      const firstFor = (dir: Direction) => {
        if (!possibleShift(p, effect, dir)) return null;
        for (let look = 1; look <= L; look++) {
          const r = look * every;
          if (meets(cachedMdd(projectedK1(p, r), r, level)[dir], effect)) return { look, repsPerArm: r };
        }
        return null;
      };
      return { id, firstLookForTarget: { drop: firstFor("drop"), rise: firstFor("rise") } };
    });
  }
  return out;
}
