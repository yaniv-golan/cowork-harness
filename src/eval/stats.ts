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
  const floor = i.n1 > 0 && i.n2 > 0 ? attainableFloor(i.n1, i.n2) : 1;
  const base = { direction, floor };
  if (i.n1 < i.threshold || i.n2 < i.threshold) return { ...base, label: "insufficient" };
  if (floor > i.alpha) return { ...base, label: "underpowered" };
  if (direction === "none" || i.p > i.alpha) return { ...base, label: "no detectable change" };
  if (i.adjustedP !== undefined && i.adjustedP <= i.level) return { ...base, label: `confirmed ${direction}` };
  return { ...base, label: `possible ${direction}` };
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
    const lab = labelRow({ ...x.r, p: x.p ?? 1, adjustedP, alpha: o.alpha, level, threshold: o.threshold });
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
