// Paired-evaluation statistics. Pure: no I/O, no clock, no randomness — every function is a deterministic
// map from counts to numbers, so a report re-rendered from the same counts is byte-identical.
//
// Conventions used throughout:
//   - arm 1 is A (the baseline, the first `--arm`), arm 2 is B (the candidate). k = passing reps, n = valid
//     reps for that row. A DROP is B's rate below A's; a RISE is B's rate above A's.
//   - p-values are two-sided Fisher exact, defined as the sum of the probabilities of every table with the
//     observed margins that is no more probable than the observed one. That is NOT twice the one-sided p,
//     and the two differ whenever the margins are asymmetric (4/5 vs 1/4: 13/63 vs 1/3).

/** Two-sided 95% normal quantile, to the precision the published Newcombe tables were computed at. */
export const Z95 = 1.959963984540054;

/** Relative tolerance when comparing a table's probability to the observed one. The mirror image of a
 *  symmetric table has the same exact probability, but the two float products can differ in the last ulp;
 *  without a tolerance the mirror is dropped and the two-sided p is halved. */
const REL_TOL = 1e-9;

function assertCount(name: string, v: number): void {
  if (!Number.isInteger(v) || v < 0) throw new RangeError(`${name} must be a non-negative integer, got ${v}`);
}

function assertTable(k1: number, n1: number, k2: number, n2: number): void {
  assertCount("k1", k1);
  assertCount("n1", n1);
  assertCount("k2", k2);
  assertCount("n2", n2);
  if (n1 === 0 || n2 === 0) throw new RangeError(`each arm needs at least one valid rep (n1=${n1}, n2=${n2})`);
  if (k1 > n1 || k2 > n2) throw new RangeError(`k cannot exceed n (${k1}/${n1}, ${k2}/${n2})`);
}

const logFactCache: number[] = [0];
function logFact(n: number): number {
  for (let i = logFactCache.length; i <= n; i++) logFactCache[i] = logFactCache[i - 1] + Math.log(i);
  return logFactCache[n];
}
const logChoose = (n: number, k: number): number => logFact(n) - logFact(k) - logFact(n - k);

/** Probability of the 2x2 table (a of n1, t-a of n2) given the margins — the hypergeometric pmf. */
function tableProb(a: number, n1: number, t: number, n2: number): number {
  return Math.exp(logChoose(n1, a) + logChoose(n2, t - a) - logChoose(n1 + n2, t));
}

/** Two-sided Fisher exact p for k1/n1 vs k2/n2 (sum of tables no more probable than the observed one). */
export function fisherTwoSided(k1: number, n1: number, k2: number, n2: number): number {
  assertTable(k1, n1, k2, n2);
  const t = k1 + k2;
  const observed = tableProb(k1, n1, t, n2);
  const limit = observed * (1 + REL_TOL);
  let p = 0;
  for (let a = Math.max(0, t - n2); a <= Math.min(n1, t); a++) {
    const pa = tableProb(a, n1, t, n2);
    if (pa <= limit) p += pa;
  }
  return Math.min(1, p);
}

export interface Interval {
  lower: number;
  upper: number;
}

/** Wilson score interval for one proportion k/n. */
export function wilsonInterval(k: number, n: number, z: number = Z95): Interval {
  assertCount("k", k);
  assertCount("n", n);
  if (n === 0 || k > n) throw new RangeError(`need 0 <= k <= n and n > 0 (${k}/${n})`);
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return {
    lower: k === 0 ? 0 : Math.max(0, (centre - half) / denom),
    upper: k === n ? 1 : Math.min(1, (centre + half) / denom),
  };
}

export interface DifferenceInterval extends Interval {
  /** The point estimate k1/n1 - k2/n2. */
  difference: number;
}

/** Newcombe's hybrid score interval for p1 - p2 (Newcombe 1998, method 10): each arm's Wilson interval,
 *  combined without continuity correction. Pass B first to get the B - A interval a row reports. */
export function newcombeDifference(k1: number, n1: number, k2: number, n2: number, z: number = Z95): DifferenceInterval {
  assertTable(k1, n1, k2, n2);
  const p1 = k1 / n1;
  const p2 = k2 / n2;
  const w1 = wilsonInterval(k1, n1, z);
  const w2 = wilsonInterval(k2, n2, z);
  const difference = p1 - p2;
  return {
    difference,
    lower: Math.max(-1, difference - Math.sqrt((p1 - w1.lower) ** 2 + (w2.upper - p2) ** 2)),
    upper: Math.min(1, difference + Math.sqrt((w1.upper - p1) ** 2 + (p2 - w2.lower) ** 2)),
  };
}

/** Indices of `ps` in ascending p order (stable, so tied p keep their input order). */
const ascendingOrder = (ps: readonly number[]): number[] => ps.map((_, i) => i).sort((a, b) => ps[a] - ps[b] || a - b);

/** Benjamini-Hochberg adjusted p-values (step-up), in input order. A row is a discovery at FDR q when its
 *  adjusted value is <= q. Tied p-values get identical adjusted values. */
export function bhAdjust(ps: readonly number[]): number[] {
  const m = ps.length;
  const order = ascendingOrder(ps);
  const out = new Array<number>(m);
  let running = 1;
  for (let rank = m; rank >= 1; rank--) {
    const idx = order[rank - 1];
    running = Math.min(running, (ps[idx] * m) / rank);
    out[idx] = running;
  }
  return out;
}

/** Holm adjusted p-values (step-down), in input order. A row is rejected at FWER alpha when its adjusted
 *  value is <= alpha. Tied p-values get identical adjusted values. */
export function holmAdjust(ps: readonly number[]): number[] {
  const m = ps.length;
  const order = ascendingOrder(ps);
  const out = new Array<number>(m);
  let running = 0;
  for (let rank = 1; rank <= m; rank++) {
    const idx = order[rank - 1];
    running = Math.max(running, Math.min(1, (m - rank + 1) * ps[idx]));
    out[idx] = running;
  }
  return out;
}

/** The smallest two-sided p any table with these arm sizes can produce. Computed by enumerating every
 *  (k1, k2), so unequal arms (after exclusions) get their real floor rather than the smaller arm's. */
export function attainableFloor(n1: number, n2: number): number {
  assertTable(0, n1, 0, n2);
  let best = 1;
  for (let k1 = 0; k1 <= n1; k1++) for (let k2 = 0; k2 <= n2; k2++) best = Math.min(best, fisherTwoSided(k1, n1, k2, n2));
  return best;
}

export type Correction = "bh" | "holm";

export interface CorrectionOptions {
  correction: Correction;
  /** BH's false-discovery rate. */
  q: number;
  /** The per-row level for `possible`, and Holm's family-wise level. */
  alpha: number;
}

const correctionLevel = (o: CorrectionOptions): number => (o.correction === "bh" ? o.q : o.alpha);

/** How many rows must sit at `floor` SIMULTANEOUSLY for any of them to reach `confirmed` in a family of m
 *  rows, or null when no number can. Under BH the rank-j threshold is j*q/m, so collapses help each other;
 *  under Holm the first step needs alpha/m whatever the others do. A floor above alpha is always null:
 *  `confirmed` implies `possible`. */
export function minRowsToConfirm(floor: number, m: number, o: CorrectionOptions): number | null {
  if (m <= 0 || floor > o.alpha) return null;
  if (o.correction === "holm") return floor <= o.alpha / m ? 1 : null;
  for (let j = 1; j <= m; j++) if (floor <= (j * o.q) / m) return j;
  return null;
}

/** The largest number of rows in this family that could reach `confirmed` together, if every row sat at its
 *  own attainable floor. Rows whose floor exceeds alpha still count in m but can never be confirmed. */
export function confirmableRowCount(floors: readonly number[], o: CorrectionOptions): number {
  if (floors.length === 0) return 0;
  const adjusted = o.correction === "bh" ? bhAdjust(floors) : holmAdjust(floors);
  const level = correctionLevel(o);
  return floors.filter((f, i) => f <= o.alpha && adjusted[i] <= level).length;
}

/** A minimum detectable difference: a positive rate difference, "none" when no table reaches alpha in that
 *  direction at these sizes, or "n/a" when the direction is impossible (a drop from 0%, a rise from 100%). */
export type Mdd = number | "none" | "n/a";

/** Smallest drop and smallest rise from A's observed k1/n1 that a B arm of n2 valid reps could show at
 *  two-sided p <= alpha, by discrete search over k2. A at 0% has a rise-only MDD; A at 100% a drop-only one. */
export function minimumDetectableDifference(k1: number, n1: number, n2: number, alpha: number): { drop: Mdd; rise: Mdd } {
  assertTable(k1, n1, 0, n2);
  let drop: Mdd = k1 === 0 ? "n/a" : "none";
  let rise: Mdd = k1 === n1 ? "n/a" : "none";
  for (let k2 = 0; k2 <= n2; k2++) {
    const cmp = k2 * n1 - k1 * n2; // sign of k2/n2 - k1/n1, exactly
    if (cmp === 0 || fisherTwoSided(k1, n1, k2, n2) > alpha) continue;
    const diff = Math.abs(k2 / n2 - k1 / n1);
    if (cmp < 0 && drop !== "n/a") drop = drop === "none" ? diff : Math.min(drop, diff);
    if (cmp > 0 && rise !== "n/a") rise = rise === "none" ? diff : Math.min(rise, diff);
  }
  return { drop, rise };
}

/** Fewest valid reps an arm needs for a row to be tested: max(2, min(4, reps - 1)), so `--reps 5` tolerates
 *  one lost rep per arm and one infrastructure error cannot turn every row of `--reps 4` insufficient.
 *  `allowUnderpowered` lowers it to two valid reps per arm (one rep is not a rate); rows whose floor then
 *  exceeds alpha are labelled `underpowered`, never `no detectable change`. */
export function insufficientThreshold(reps: number, allowUnderpowered: boolean): number {
  if (allowUnderpowered) return 2;
  return Math.max(2, Math.min(4, reps - 1));
}

/** The label is the row's verdict: `--fail-on` and the renderer consume it, nothing else.
 *  - `confirmed` is a SUBSET of `possible`: it needs the corrected value within its level AND the unadjusted
 *    p <= alpha. That is stricter than plain BH at q = 0.10, which alone could confirm a row with
 *    alpha < p <= q; a row the per-row test does not flag is never confirmed.
 *  - `underpowered` replaces `no detectable change` whenever no table at this row's sizes can reach alpha
 *    (its attainable floor > alpha): the row was never testable, so "no change" would read as a clean pass.
 *  - `insufficient`: an arm has fewer valid reps than the threshold. */
export type RowLabel =
  "confirmed drop" | "confirmed rise" | "possible drop" | "possible rise" | "no detectable change" | "underpowered" | "insufficient";
export type Direction = "drop" | "rise" | "none";

export interface LabelInput {
  k1: number;
  n1: number;
  k2: number;
  n2: number;
  /** Unadjusted two-sided p. */
  p: number;
  /** The corrected value, or undefined when the row is outside the family. */
  adjustedP: number | undefined;
  alpha: number;
  /** The corrected value's level: BH's q, or alpha under Holm. */
  level: number;
  threshold: number;
  /** The row's attainable floor when the caller already computed it; derived from n1/n2 otherwise. */
  floor?: number;
}

export interface LabelOutput {
  label: RowLabel;
  direction: Direction;
  /** This row's attainable floor (1 when an arm has no valid rep). */
  floor: number;
}

export function labelRow(i: LabelInput): LabelOutput {
  const cmp = i.n1 > 0 && i.n2 > 0 ? i.k2 * i.n1 - i.k1 * i.n2 : 0;
  const direction: Direction = cmp < 0 ? "drop" : cmp > 0 ? "rise" : "none";
  const floor = i.floor ?? (i.n1 > 0 && i.n2 > 0 ? attainableFloor(i.n1, i.n2) : 1);
  return { direction, floor, label: labelCore({ ...i, direction, floor }) };
}

/** The label decision both row kinds share, in its fixed order: insufficient, underpowered, then the test. A
 *  metric row passes its own direction words (`worse` / `better`), so the same code labels both. */
function labelCore<D extends string>(i: {
  direction: D | "none";
  n1: number;
  n2: number;
  threshold: number;
  floor: number;
  p: number;
  adjustedP: number | undefined;
  alpha: number;
  level: number;
}): "insufficient" | "underpowered" | "no detectable change" | `confirmed ${D}` | `possible ${D}` {
  if (i.n1 < i.threshold || i.n2 < i.threshold) return "insufficient";
  if (i.floor > i.alpha) return "underpowered";
  if (i.direction === "none" || i.p > i.alpha) return "no detectable change";
  if (i.adjustedP !== undefined && i.adjustedP <= i.level) return `confirmed ${i.direction as D}`;
  return `possible ${i.direction as D}`;
}

export interface FamilyRowInput {
  id: string;
  k1: number;
  n1: number;
  k2: number;
  n2: number;
}

export interface FamilyRowOutput extends FamilyRowInput, LabelOutput {
  /** Undefined only when an arm has no valid rep. On an `insufficient` row it is computed but is NOT a
   *  tested value (the row is outside the family and uncorrected): a renderer must not print it as one. */
  p?: number;
  /** Undefined when the row is `insufficient` (not in the correction family). */
  adjustedP?: number;
  /** B - A with its 95% Newcombe interval; undefined when an arm has no valid rep. */
  interval?: DifferenceInterval;
  mdd?: { drop: Mdd; rise: Mdd };
}

export interface FamilyOptions extends CorrectionOptions {
  threshold: number;
}

export interface FamilyOutput {
  /** Family size: the rows with enough valid reps to be tested. */
  m: number;
  rows: FamilyRowOutput[];
  /** `minRowsToConfirm` at the family's lowest row floor; null when `confirmed` is unreachable. */
  minRowsToConfirm: number | null;
  confirmableRows: number;
}

/** Test, correct and label one family (one report section). Insufficient rows are reported with their rates
 *  but kept out of the correction, so an untestable row cannot raise every other row's threshold.
 *  `underpowered` rows DO count in m (the family is every tested row of the section): they have enough reps
 *  to be tested, just not enough to reach alpha, and dropping them would make m depend on the outcome. */
export function evaluateFamily(rows: readonly FamilyRowInput[], o: FamilyOptions): FamilyOutput {
  const measured = rows.map((r) => {
    const hasBoth = r.n1 > 0 && r.n2 > 0;
    return {
      r,
      testable: hasBoth && r.n1 >= o.threshold && r.n2 >= o.threshold,
      p: hasBoth ? fisherTwoSided(r.k1, r.n1, r.k2, r.n2) : undefined,
      interval: hasBoth ? newcombeDifference(r.k2, r.n2, r.k1, r.n1) : undefined,
      mdd: hasBoth ? minimumDetectableDifference(r.k1, r.n1, r.n2, o.alpha) : undefined,
      floor: hasBoth ? attainableFloor(r.n1, r.n2) : 1,
    };
  });
  const family = measured.filter((x) => x.testable);
  const ps = family.map((x) => x.p as number);
  const adjusted = o.correction === "bh" ? bhAdjust(ps) : holmAdjust(ps);
  const adjustedById = new Map(family.map((x, i) => [x.r.id, adjusted[i]]));
  const level = correctionLevel(o);
  const out = measured.map((x): FamilyRowOutput => {
    const adjustedP = adjustedById.get(x.r.id);
    const lab = labelRow({ ...x.r, p: x.p ?? 1, adjustedP, alpha: o.alpha, level, threshold: o.threshold, floor: x.floor });
    return {
      ...x.r,
      ...lab,
      ...(x.p !== undefined ? { p: x.p } : {}),
      ...(adjustedP !== undefined ? { adjustedP } : {}),
      ...(x.interval ? { interval: x.interval } : {}),
      ...(x.mdd ? { mdd: x.mdd } : {}),
    };
  });
  const floors = family.map((x) => x.floor);
  return {
    m: family.length,
    rows: out,
    minRowsToConfirm: family.length ? minRowsToConfirm(Math.min(...floors), family.length, o) : null,
    confirmableRows: confirmableRowCount(floors, o),
  };
}

type Counts = { k1: number; n1: number; k2: number; n2: number };

/** Rows at 100% in both arms: an improvement is undetectable for them (the ceiling line). */
export function ceilingRowCount(rows: readonly Counts[]): number {
  return rows.filter((r) => r.n1 > 0 && r.n2 > 0 && r.k1 === r.n1 && r.k2 === r.n2).length;
}

/** Rows at 0% in both arms: a drop is undetectable for them (the ceiling line's mirror). */
export function zeroRowCount(rows: readonly Counts[]): number {
  return rows.filter((r) => r.n1 > 0 && r.n2 > 0 && r.k1 === 0 && r.k2 === 0).length;
}

// ---- metric rows: the exact Wilcoxon–Mann–Whitney rank-sum test ------------------------------------------
//
// A metric row compares each arm's per-rep numbers. Every rep enters the test as an ORDINAL key `(level, g)`,
// ordered by level and then by g, where a higher key is better:
//   level 0 — an excluded rep placed at the worst end by the adversarial completion (below),
//   level 1 — a worst-ranked rep (the skill did not produce the number),
//   level 2 — a measured value, with g = the value for `better: higher` and −value for `better: lower`,
//   level 3 — an excluded rep placed at the best end by the adversarial completion.
// Keys tie only when both parts are equal, so a worst-ranked rep ties only with other worst-ranked reps (never
// with a measured value at a bounded metric's bound), and each adversarial group ties only within itself.

export interface MetricKey {
  level: 0 | 1 | 2 | 3;
  g: number;
}

/** Which arm the observed rank sum favours: `B` when B's keys rank higher (B is better). */
export type Favours = "A" | "B" | "none";

export interface WmwResult {
  /** Two-sided exact p: the share of all relabelings with |W − E| >= the observed, conditional on the ties. */
  p: number;
  /** The smallest p any relabeling of these exact pooled keys can produce (1 when every key is tied). */
  floor: number;
  favours: Favours;
}

const cmpMetricKey = (x: MetricKey, y: MetricKey): number => x.level - y.level || x.g - y.g;

/** Twice each key's mid-rank (an integer: first + last + 2 over a tie group's 0-based positions). */
function doubledMidRanks(pool: readonly MetricKey[]): number[] {
  const order = pool.map((_, i) => i).sort((i, j) => cmpMetricKey(pool[i], pool[j]));
  const out = new Array<number>(pool.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && cmpMetricKey(pool[order[j + 1]], pool[order[i]]) === 0) j++;
    for (let t = i; t <= j; t++) out[order[t]] = i + j + 2;
    i = j + 1;
  }
  return out;
}

/** counts[s] = how many size-k subsets of `items` sum to s. Float64 counts are exact integers while the total
 *  stays below 2^53 (every pooled size up to about 56); beyond that the ratio is still accurate to ~1e-16. */
function subsetSumCounts(items: readonly number[], k: number): Float64Array {
  const total = items.reduce((a, b) => a + b, 0);
  const width = total + 1;
  const dp = new Float64Array((k + 1) * width);
  dp[0] = 1;
  let reach = 0;
  items.forEach((v, idx) => {
    reach += v;
    for (let size = Math.min(idx + 1, k); size >= 1; size--) {
      const row = size * width;
      const prev = (size - 1) * width;
      for (let s = reach; s >= v; s--) dp[row + s] += dp[prev + s - v];
    }
  });
  return dp.slice(k * width, (k + 1) * width);
}

/** The exact two-sided rank-sum test of A's keys against B's, conditional on the observed ties. Pure and
 *  integer in the statistic: doubled mid-rank sums, compared without a tolerance. */
export function wmwExact(a: readonly MetricKey[], b: readonly MetricKey[]): WmwResult {
  if (a.length === 0 || b.length === 0) throw new RangeError(`each arm needs at least one rep (n1=${a.length}, n2=${b.length})`);
  const pool = [...a, ...b];
  const ranks = doubledMidRanks(pool);
  const n2 = b.length;
  const twoE = n2 * (pool.length + 1); // 2·E[W] = n2·(N+1)
  const observed = ranks.slice(a.length).reduce((s, r) => s + r, 0);
  const obsDev = Math.abs(observed - twoE);
  const counts = subsetSumCounts(ranks, n2);
  let total = 0;
  let tail = 0;
  let maxDev = 0;
  for (let s = 0; s < counts.length; s++) {
    if (counts[s] === 0) continue;
    total += counts[s];
    const dev = Math.abs(s - twoE);
    if (dev >= obsDev) tail += counts[s];
    if (dev > maxDev) maxDev = dev;
  }
  let extreme = 0;
  for (let s = 0; s < counts.length; s++) if (counts[s] !== 0 && Math.abs(s - twoE) >= maxDev) extreme += counts[s];
  return {
    p: Math.min(1, tail / total),
    floor: maxDev === 0 ? 1 : Math.min(1, extreme / total),
    favours: observed > twoE ? "B" : observed < twoE ? "A" : "none",
  };
}

/** The attainable two-sided p values of an untied n1 v n2 rank test, ascending, each with its null mass at or
 *  below it (P(p <= that value)). The p at deviation d is the mass at deviations >= d, so both lists coincide. */
export function wmwAttainable(n1: number, n2: number): number[] {
  const N = n1 + n2;
  const counts = subsetSumCounts(
    Array.from({ length: N }, (_, i) => 2 * (i + 1)),
    n2,
  );
  const twoE = n2 * (N + 1);
  let total = 0;
  const byDev = new Map<number, number>();
  for (let s = 0; s < counts.length; s++) {
    if (counts[s] === 0) continue;
    total += counts[s];
    const dev = Math.abs(s - twoE);
    byDev.set(dev, (byDev.get(dev) ?? 0) + counts[s]);
  }
  const out: number[] = [];
  let tail = 0;
  for (const d of [...byDev.keys()].sort((x, y) => y - x)) {
    tail += byDev.get(d)!;
    out.push(Math.min(1, tail / total));
  }
  return out;
}

/** P(p <= level) for a null row with n1 v n2 untied reps: the exact false-positive mass of one row. */
export function wmwNullMass(n1: number, n2: number, level: number): number {
  let mass = 0;
  for (const p of wmwAttainable(n1, n2)) if (p <= level * (1 + REL_TOL)) mass = p;
  return mass;
}

export interface MetricArmInput {
  /** The measured values (finite numbers). */
  values: readonly number[];
  /** Reps ranked worst: the agent failed, or the skill did not produce the number (class W). */
  worst: number;
  /** Reps whose number is missing because of the scorer, the capture or a cap (class X): excluded, guarded. */
  excluded: number;
}

export interface MetricRowP {
  /** The labelled, corrected and gated p: max(survivor, adversarial) when any rep is excluded. */
  p: number;
  /** The test over the measured and worst-ranked reps alone. */
  survivorP: number;
  /** The adversarial completion's p (1 when its direction differs from the survivors'); absent with no X rep. */
  adversarialP?: number;
  /** The survivors' direction. */
  favours: Favours;
  /** The survivors' conditional floor. */
  floor: number;
  /** Reps in the test per arm (measured + worst-ranked; excluded reps do not count). */
  n1: number;
  n2: number;
}

const goodness = (better: "higher" | "lower", v: number): number => (better === "higher" ? v : -v);

function armKeys(better: "higher" | "lower", arm: MetricArmInput): MetricKey[] {
  return [
    ...arm.values.map((v): MetricKey => ({ level: 2, g: goodness(better, v) })),
    ...Array.from({ length: arm.worst }, (): MetricKey => ({ level: 1, g: 0 })),
  ];
}

/** A row's p with its excluded reps guarded: a verdict that holds only because an excluded rep's number is
 *  unknown is not a verdict. The adversarial completion puts the excluded reps of the arm the survivors favour
 *  at the worst end (beyond every worst-ranked rep) and the other arm's at the best end, and the row's p is the
 *  larger of the two — so a scorer failure can neither manufacture nor hide a direction. */
export function metricRowP(row: { better: "higher" | "lower"; a: MetricArmInput; b: MetricArmInput }): MetricRowP {
  const a = armKeys(row.better, row.a);
  const b = armKeys(row.better, row.b);
  const base = { n1: a.length, n2: b.length };
  if (a.length === 0 || b.length === 0) return { ...base, p: 1, survivorP: 1, favours: "none", floor: 1 };
  const survivor = wmwExact(a, b);
  const out = { ...base, p: survivor.p, survivorP: survivor.p, favours: survivor.favours, floor: survivor.floor };
  if (row.a.excluded === 0 && row.b.excluded === 0) return out;
  if (survivor.favours === "none") return { ...out, p: 1, adversarialP: 1 };
  const worstEnd = (n: number) => Array.from({ length: n }, (): MetricKey => ({ level: 0, g: 0 }));
  const bestEnd = (n: number) => Array.from({ length: n }, (): MetricKey => ({ level: 3, g: 0 }));
  const favoured = survivor.favours === "A" ? "a" : "b";
  const adv = wmwExact(
    [...a, ...(favoured === "a" ? worstEnd(row.a.excluded) : bestEnd(row.a.excluded))],
    [...b, ...(favoured === "b" ? worstEnd(row.b.excluded) : bestEnd(row.b.excluded))],
  );
  // Each adversarial group is one tied block. That is not always the completion with the LARGEST p (ties shrink
  // the null's spread; distinct values at the extreme can give a larger one), but a search over every interleaving
  // at n = 5–7 with up to three excluded reps, at levels 0.0083–0.10, found no label it changes: the survivors' p
  // already decides max(survivor, adversarial) wherever the two could differ.
  const adversarialP = adv.favours === survivor.favours ? adv.p : 1;
  return { ...out, p: Math.max(survivor.p, adversarialP), adversarialP };
}

export interface HodgesLehmann {
  /** The median of the n1·n2 differences b − a. */
  shift: number;
  lower: number;
  upper: number;
  /** The interval's achieved coverage — never assume 95%. */
  coverage: number;
  k: number;
}

/** Cumulative Mann–Whitney U null counts (no ties) and their total, for n1 v n2. */
function uNullCumulative(n1: number, n2: number): { cum: number[]; total: number } {
  const N = n1 + n2;
  const counts = subsetSumCounts(
    Array.from({ length: N }, (_, i) => i + 1),
    n2,
  );
  const minW = (n2 * (n2 + 1)) / 2;
  const cum: number[] = [];
  let run = 0;
  for (let u = 0; u <= n1 * n2; u++) {
    run += counts[minW + u] ?? 0;
    cum.push(run);
  }
  return { cum, total: run };
}

/** Hodges–Lehmann shift of B over A with its distribution-free interval [D(k), D(n1·n2+1−k)]: k is the largest
 *  whose coverage 1 − 2·P(U <= k−1) is still >= 0.95 (so the smallest coverage >= 0.95); when even k = 1 falls
 *  short (3v3: 90.0%), k = 1 and its coverage is reported. Over measured values only. */
export function hodgesLehmann(a: readonly number[], b: readonly number[]): HodgesLehmann | undefined {
  if (a.length === 0 || b.length === 0) return undefined;
  const diffs = b.flatMap((y) => a.map((x) => y - x)).sort((x, y) => x - y);
  const mid = diffs.length >> 1;
  const shift = diffs.length % 2 ? diffs[mid] : (diffs[mid - 1] + diffs[mid]) / 2;
  const { cum, total } = uNullCumulative(a.length, b.length);
  const coverage = (k: number) => 1 - (2 * cum[k - 1]) / total;
  let k = 1;
  while (k + 1 <= Math.floor((diffs.length + 1) / 2) && coverage(k + 1) >= 0.95) k++;
  return { shift, lower: diffs[k - 1], upper: diffs[diffs.length - k], coverage: coverage(k), k };
}

/** Sample SD (n − 1); undefined below two values. */
export function sampleSd(xs: readonly number[]): number | undefined {
  if (xs.length < 2) return undefined;
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1));
}

/** The pooled within-arm SD and its degrees of freedom (n1 + n2 − 2); undefined when df < 1. */
export function pooledSd(a: readonly number[], b: readonly number[]): { sd: number; df: number } | undefined {
  const df = a.length + b.length - 2;
  if (df < 1 || a.length === 0 || b.length === 0) return undefined;
  const ss = (xs: readonly number[]) => {
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    return xs.reduce((s, x) => s + (x - mean) ** 2, 0);
  };
  return { sd: Math.sqrt((ss(a) + ss(b)) / df), df };
}

/** Lanczos log-gamma (g = 7, n = 9), accurate to ~1e-15 for x > 0. */
function logGamma(x: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let s = c[0];
  for (let i = 1; i < 9; i++) s += c[i] / (x + i);
  const t = x + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(s);
}

/** The regularized lower incomplete gamma P(s, x): a series below s + 1, a continued fraction above. */
function gammaP(s: number, x: number): number {
  if (x <= 0) return 0;
  const lg = logGamma(s);
  if (x < s + 1) {
    let sum = 1 / s;
    let term = sum;
    for (let n = 1; n < 500; n++) {
      term *= x / (s + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-16) break;
    }
    return sum * Math.exp(-x + s * Math.log(x) - lg);
  }
  let b = x + 1 - s;
  let c = 1 / 1e-300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - s);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-16) break;
  }
  return 1 - Math.exp(-x + s * Math.log(x) - lg) * h;
}

/** The chi-square quantile: the x with P(df/2, x/2) = p, by bisection. */
export function chiSquareQuantile(p: number, df: number): number {
  let lo = 0;
  let hi = Math.max(1, df);
  while (gammaP(df / 2, hi / 2) < p) hi *= 2;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (gammaP(df / 2, mid / 2) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** The normal-theory 95% interval on an SD s with df degrees of freedom: s·sqrt(df/χ²(0.975)) to
 *  s·sqrt(df/χ²(0.025)). An SD from 5 reps is itself noisy, and this says how noisy. */
export function pooledSdInterval95(s: number, df: number): Interval | undefined {
  if (!(df >= 1)) return undefined;
  return { lower: s * Math.sqrt(df / chiSquareQuantile(0.975, df)), upper: s * Math.sqrt(df / chiSquareQuantile(0.025, df)) };
}

/** Minimum detectable shift in SD units (normal shift, 80% power, B better, directional), keyed by n per arm and
 *  the attainable no-tie p it must reach. Computed OFFLINE by seeded simulation (4,000 sims per 0.2 SD grid
 *  point; `scripts/eval-mds-table.py` regenerates every row) — an estimate, ±0.2 — because exact WMW power under a
 *  shift has no closed form and a simulation here would break this module's no-randomness contract. */
const MDS_TABLE: Record<number, ReadonlyArray<readonly [p: number, sd: number]>> = {
  4: [[2 / 70, 3.0]],
  5: [
    [2 / 252, 3.2],
    [4 / 252, 2.8],
    [8 / 252, 2.4],
  ],
  6: [
    [2 / 924, 3.4],
    [4 / 924, 3.0],
    [8 / 924, 2.6],
    [14 / 924, 2.4],
    [24 / 924, 2.2],
    [38 / 924, 2.0],
  ],
};

/** The MDS for a row tested at `level` with n reps per arm: the shift the table gives for the largest attainable
 *  p <= level. Undefined when n is outside the table or no attainable p is within the level. */
export function mdsSdUnits(n: number, level: number): number | undefined {
  const cells = MDS_TABLE[n];
  if (!cells) return undefined;
  let found: number | undefined;
  for (const [p, sd] of cells) if (p <= level * (1 + REL_TOL)) found = sd;
  return found;
}

// ---- the metric family -------------------------------------------------------------------------------------

export type MetricLabel =
  | "confirmed worse"
  | "confirmed better"
  | "possible worse"
  | "possible better"
  | "no detectable change"
  | "underpowered"
  | "insufficient"
  | "unresolved";

export interface MetricRowInput {
  id: string;
  better: "higher" | "lower";
  a: MetricArmInput;
  b: MetricArmInput;
}

export interface MetricFamilyOptions {
  rule: Correction;
  /** The per-row level for `possible`; `confirmed` also needs p <= alpha. */
  alpha: number;
  q: number;
  /** The corrected value's level: Holm's alpha / F (F = families in the section), or BH's q. */
  level: number;
  threshold: number;
}

export interface MetricMds {
  /** n per arm the table was read at: the smaller arm's tested reps. */
  n: number;
  possible: { sdUnits: number; units: number; unitsRange: Interval };
  /** null when the family cannot confirm a single row at this n. */
  confirmed: { sdUnits: number; units: number; unitsRange: Interval } | null;
}

export interface MetricRowOutput {
  id: string;
  better: "higher" | "lower";
  label: MetricLabel;
  /** `worse` / `better` read through `better`; the raw numeric direction of B against A is `numericDirection`. */
  direction: "worse" | "better" | "none";
  numericDirection: "up" | "down" | "none";
  /** The labelled p (see metricRowP). */
  p: number;
  survivorP: number;
  adversarialP?: number;
  /** Undefined outside the family (`insufficient`). */
  adjustedP?: number;
  floor: number;
  /** Tested reps per arm (measured + worst-ranked). */
  n1: number;
  n2: number;
  medians: { a?: number; b?: number };
  sd: { a?: number; b?: number };
  pooledSd?: number;
  pooledSdInterval95?: Interval;
  mds?: MetricMds;
  /** Over measured values only. */
  hl?: HodgesLehmann;
}

export interface MetricFamilyOutput {
  /** Rows tested (in the correction family): every row except `insufficient` ones. */
  m: number;
  rows: MetricRowOutput[];
  minRowsToConfirm: number | null;
  confirmableRows: number;
}

const medianOf = (xs: readonly number[]): number | undefined => {
  if (xs.length === 0) return undefined;
  const v = [...xs].sort((x, y) => x - y);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
};

/** The single-row `confirmed` level of a family of m rows: Holm level / m, or min(alpha, q / m) under BH. */
export function metricConfirmLevel(o: Pick<MetricFamilyOptions, "rule" | "alpha" | "q" | "level">, m: number): number {
  const mm = Math.max(1, m);
  return o.rule === "holm" ? o.level / mm : Math.min(o.alpha, o.q / mm);
}

/** Options for minRowsToConfirm / confirmableRowCount that express this family's rule. Under Holm the family's
 *  level IS the per-row alpha those helpers test the floor against (it is <= alpha, so `confirmed` ⊂ `possible`). */
export function metricCorrectionOptions(o: Pick<MetricFamilyOptions, "rule" | "alpha" | "q" | "level">): CorrectionOptions {
  return o.rule === "holm" ? { correction: "holm", alpha: o.level, q: o.q } : { correction: "bh", alpha: o.alpha, q: o.q };
}

/** Test, correct and label one section's metric rows. `insufficient` rows stay out of m; `underpowered` and
 *  `unresolved` rows stay in it, so m does not depend on the outcome. */
export function evaluateMetricFamily(rows: readonly MetricRowInput[], o: MetricFamilyOptions): MetricFamilyOutput {
  const tested = rows.map((r) => {
    const rp = metricRowP(r);
    return { r, rp, testable: rp.n1 > 0 && rp.n2 > 0 && rp.n1 >= o.threshold && rp.n2 >= o.threshold };
  });
  const family = tested.filter((x) => x.testable);
  const ps = family.map((x) => x.rp.p);
  const adjusted = o.rule === "bh" ? bhAdjust(ps) : holmAdjust(ps);
  const adjustedById = new Map(family.map((x, i) => [x.r.id, adjusted[i]]));
  const confirmLevel = metricConfirmLevel(o, family.length);
  const out = tested.map(({ r, rp }): MetricRowOutput => {
    const adjustedP = adjustedById.get(r.id);
    const direction = rp.favours === "B" ? "better" : rp.favours === "A" ? "worse" : "none";
    const bUp = rp.favours === "none" ? undefined : (rp.favours === "B") === (r.better === "higher");
    const core = labelCore({
      direction,
      n1: rp.n1,
      n2: rp.n2,
      threshold: o.threshold,
      floor: rp.floor,
      p: rp.p,
      adjustedP,
      alpha: o.alpha,
      level: o.level,
    });
    const unresolved = core === "no detectable change" && rp.adversarialP !== undefined && rp.survivorP <= o.alpha && rp.p > o.alpha;
    const label: MetricLabel = unresolved ? "unresolved" : core;
    const pooled = pooledSd(r.a.values, r.b.values);
    const interval = pooled ? pooledSdInterval95(pooled.sd, pooled.df) : undefined;
    const n = Math.min(rp.n1, rp.n2);
    const possibleSd = mdsSdUnits(n, o.alpha);
    const confirmedSd = mdsSdUnits(n, confirmLevel);
    const scaled = (sdUnits: number) => ({
      sdUnits,
      units: sdUnits * pooled!.sd,
      unitsRange: { lower: sdUnits * interval!.lower, upper: sdUnits * interval!.upper },
    });
    const hl = hodgesLehmann(r.a.values, r.b.values);
    return {
      id: r.id,
      better: r.better,
      label,
      direction,
      numericDirection: bUp === undefined ? "none" : bUp ? "up" : "down",
      p: rp.p,
      survivorP: rp.survivorP,
      ...(rp.adversarialP !== undefined ? { adversarialP: rp.adversarialP } : {}),
      ...(adjustedP !== undefined ? { adjustedP } : {}),
      floor: rp.floor,
      n1: rp.n1,
      n2: rp.n2,
      medians: { a: medianOf(r.a.values), b: medianOf(r.b.values) },
      sd: { a: sampleSd(r.a.values), b: sampleSd(r.b.values) },
      ...(pooled ? { pooledSd: pooled.sd } : {}),
      ...(interval ? { pooledSdInterval95: interval } : {}),
      // No within-arm spread (pooled SD 0) gives no scale to read a shift in: no MDS, rather than "≈ 0". The arms
      // can still differ (every A at 0, every B at 9), so this is not "every value tied" (that is floor 1).
      ...(pooled && pooled.sd > 0 && interval && possibleSd !== undefined
        ? { mds: { n, possible: scaled(possibleSd), confirmed: confirmedSd !== undefined ? scaled(confirmedSd) : null } }
        : {}),
      ...(hl ? { hl } : {}),
    };
  });
  const floors = family.map((x) => x.rp.floor);
  const co = metricCorrectionOptions(o);
  return {
    m: family.length,
    rows: out,
    minRowsToConfirm: family.length ? minRowsToConfirm(Math.min(...floors), family.length, co) : null,
    confirmableRows: confirmableRowCount(floors, co),
  };
}

/** P(Fisher p <= level) for a null pass row of n1 v n2 reps whose true rate is pi in both arms — the exact A/A
 *  false-positive mass at that rate. The report evaluates it at a row's pooled observed rate: descriptive only. */
export function fisherNullMass(n1: number, n2: number, pi: number, level: number): number {
  const binom = (n: number, k: number) => Math.exp(logChoose(n, k) + (k ? k * Math.log(pi) : 0) + (n - k ? (n - k) * Math.log(1 - pi) : 0));
  let mass = 0;
  for (let k1 = 0; k1 <= n1; k1++)
    for (let k2 = 0; k2 <= n2; k2++) if (fisherTwoSided(k1, n1, k2, n2) <= level * (1 + REL_TOL)) mass += binom(n1, k1) * binom(n2, k2);
  return Math.min(1, mass);
}
