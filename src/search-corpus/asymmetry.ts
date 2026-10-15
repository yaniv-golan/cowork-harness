/**
 * Per-arm (or per-variant) frozen-corpus metrics side by side, and the asymmetry marker. Pure: computed from each
 * rep's persisted `searchCorpus` counts, so `eval report` and `hillclimb check` recompute it from disk.
 *
 * The marker says the two sides were served differently by the same pool: a miss-rate gap above MISS_GAP, or a ratio
 * of mean top scores below TOP_RATIO. Both thresholds are PLACEHOLDERS: the kept runs could not separate a provenance
 * bias from noise, so no value was derived from them. What the data did fix is the floor: below MIN_SEARCHES served
 * plus missed searches on either side, one search moves the rate by more than the gap, so the cell is not judged.
 * At the default floor (0.40), with single-rep sides of at least 11 searches, it fired on 0 of 7 same-variant
 * comparisons (1 of 7 at 0.45); its false-alarm rate at a real eval's operating point is unmeasured.
 */

export const ASYMMETRY_MISS_GAP = 0.1;
export const ASYMMETRY_TOP_RATIO = 0.8;
/** The smallest n with 1/n < ASYMMETRY_MISS_GAP: one search alone cannot fire the marker. */
export const ASYMMETRY_MIN_SEARCHES = 11;

export interface CorpusRepCounts {
  served: number;
  miss: number;
  meanTopScore?: number;
}

export interface CorpusSideMetrics {
  reps: number;
  served: number;
  miss: number;
  /** miss / (served + miss); undefined with no search. */
  missRate?: number;
  /** Served-weighted mean of the reps' mean top scores; undefined when nothing was served with a score. */
  meanTopScore?: number;
}

export function sideMetrics(reps: readonly CorpusRepCounts[]): CorpusSideMetrics {
  const served = reps.reduce((n, r) => n + r.served, 0);
  const miss = reps.reduce((n, r) => n + r.miss, 0);
  const scored = reps.filter((r) => r.meanTopScore !== undefined && r.served > 0);
  const w = scored.reduce((n, r) => n + r.served, 0);
  return {
    reps: reps.length,
    served,
    miss,
    ...(served + miss > 0 ? { missRate: miss / (served + miss) } : {}),
    ...(w > 0 ? { meanTopScore: scored.reduce((n, r) => n + r.meanTopScore! * r.served, 0) / w } : {}),
  };
}

export type AsymmetryCell = { judged: false; reason: string } | { judged: true; fires: boolean; missGap: number; topRatio?: number };

/** The marker for one cell (a scenario, or the total) between two named sides. */
export function asymmetry(a: { label: string; m: CorpusSideMetrics }, b: { label: string; m: CorpusSideMetrics }): AsymmetryCell {
  for (const s of [a, b]) {
    const n = s.m.served + s.m.miss;
    if (n < ASYMMETRY_MIN_SEARCHES) return { judged: false, reason: `${s.label}: ${n} search${n === 1 ? "" : "es"}` };
  }
  const missGap = Math.abs(a.m.missRate! - b.m.missRate!);
  const ta = a.m.meanTopScore;
  const tb = b.m.meanTopScore;
  const topRatio = ta !== undefined && tb !== undefined && Math.max(ta, tb) > 0 ? Math.min(ta, tb) / Math.max(ta, tb) : undefined;
  return {
    judged: true,
    fires: missGap > ASYMMETRY_MISS_GAP || (topRatio !== undefined && topRatio < ASYMMETRY_TOP_RATIO),
    missGap,
    ...(topRatio !== undefined ? { topRatio } : {}),
  };
}

export const ASYMMETRY_THRESHOLDS = {
  missGap: ASYMMETRY_MISS_GAP,
  topRatio: ASYMMETRY_TOP_RATIO,
  minSearches: ASYMMETRY_MIN_SEARCHES,
  placeholder: true,
} as const;

/** The line every surface prints for a cell. "Not judged" never reads as "no asymmetry". */
export function asymmetryLine(cell: AsymmetryCell, a: CorpusSideMetrics, b: CorpusSideMetrics): string {
  if (!cell.judged) return `asymmetry: not judged (${cell.reason})`;
  const rate = (m: CorpusSideMetrics) => (m.missRate === undefined ? "—" : m.missRate.toFixed(2));
  const top = cell.topRatio === undefined ? "" : `; top-score ratio ${cell.topRatio.toFixed(2)}`;
  if (!cell.fires) return `asymmetry: none (miss rate ${rate(a)} vs ${rate(b)}${top})`;
  const why =
    cell.missGap > ASYMMETRY_MISS_GAP
      ? `gap ${cell.missGap.toFixed(2)} > ${ASYMMETRY_MISS_GAP}`
      : `top-score ratio ${cell.topRatio!.toFixed(2)} < ${ASYMMETRY_TOP_RATIO}`;
  return `asymmetry: miss rate ${rate(a)} vs ${rate(b)} (${why}, a placeholder threshold)${top} — CONFOUNDED`;
}
