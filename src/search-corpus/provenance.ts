/**
 * Where a frozen pool's records came from, relative to the variants an eval or a hillclimb pass compares. Pure.
 *
 * A record is evidence for an arm only when it was recorded under the scenario being compared AND its source run's
 * skill content signature (`variantHash`, the run's `fingerprint.contentSig`) equals that arm's signature for the
 * scenario. The signature folds in the scenario's skills scope and session, so a hash that differs across scenarios
 * proves nothing: a record from a scenario that is not compared is `unknown` evidence, never `disjoint`. A record of a
 * compared scenario whose hash matches no arm is `other` (a third variant), the only evidence of disjointness.
 *
 * Presence comes from the manifest's source list, which names every run that produced a kept record, duplicates
 * included, matched on the hash alone (sources carry no scenario, so this can only over-count presence). Shares come
 * from the records: each kept record carries its FIRST contributor's source, so `counts.crossRunDuplicates` (d)
 * bounds how far a share can be off, and the worst case decides. A pool built before that count existed cannot be
 * bounded: a split that would read balanced is resolved toward refusing.
 */

import type { PoolManifest } from "./pool.js";
import type { PoolRecord } from "./harvest.js";

export type ProvenanceClass = "disjoint" | "balanced" | "one-sided" | "unknown";

/** No compared variant may contribute more than this share of the compared-variant records (design §6). */
export const ONE_SIDED_SHARE = 0.6;

export interface ComparedArm {
  label: string;
  /** Scenario name → the arm's skill content signature for it. */
  sigs: Record<string, string>;
}

export interface ScenarioProvenance {
  class: ProvenanceClass;
  /** Records per arm label (an A/A pair counts a matching record for both). */
  n: Record<string, number>;
  nOther: number;
  nUnknown: number;
  /** The arm a one-sided pool was drawn from. */
  drawnFrom?: string;
  /** Why the class is what it is, when that is not plain from the counts. */
  reason?: string;
}

export interface PoolProvenance {
  class: ProvenanceClass;
  perScenario: Record<string, ScenarioProvenance>;
  /** True when shares were bounded by a recorded duplicate count; false for a pool built before it was recorded. */
  sharesBounded: boolean;
  /** Set by the caller when `--allow-confounded-pool` let a one-sided pool run. */
  allowConfoundedPool?: true;
}

const RANK: Record<ProvenanceClass, number> = { disjoint: 0, balanced: 1, unknown: 2, "one-sided": 3 };

export function worseClass(a: ProvenanceClass, b: ProvenanceClass): ProvenanceClass {
  return RANK[a] >= RANK[b] ? a : b;
}

export function classifyProvenance(
  manifest: Pick<PoolManifest, "sources" | "counts">,
  records: ReadonlyArray<Pick<PoolRecord, "source">>,
  scenarios: readonly string[],
  arms: readonly ComparedArm[],
): PoolProvenance {
  const compared = new Set(scenarios);
  const d = manifest.counts.crossRunDuplicates;
  const perScenario: Record<string, ScenarioProvenance> = {};
  let overall: ProvenanceClass = "disjoint";
  for (const sc of scenarios) {
    const n: Record<string, number> = Object.fromEntries(arms.map((a) => [a.label, 0]));
    let nOther = 0;
    let nUnknown = 0;
    for (const r of records) {
      const s = r.source;
      if (s.variantHash === null || s.scenario === null || !compared.has(s.scenario)) {
        nUnknown++;
        continue;
      }
      if (s.scenario !== sc) continue;
      const hit = arms.filter((a) => a.sigs[sc] === s.variantHash);
      if (hit.length === 0) nOther++;
      for (const a of hit) n[a.label]!++;
    }
    const present = arms.filter(
      (a) => n[a.label]! > 0 || manifest.sources.some((s) => s.variantHash !== null && s.variantHash === a.sigs[sc]),
    );
    const identical = arms.length === 2 && arms[0]!.sigs[sc] === arms[1]!.sigs[sc];
    let p: ScenarioProvenance;
    if (present.length === 0) p = { class: "disjoint", n, nOther, nUnknown };
    else if (identical) p = { class: "balanced", n, nOther, nUnknown, reason: "both arms have the same skill content" };
    else if (present.length === 1) p = { class: "one-sided", n, nOther, nUnknown, drawnFrom: present[0]!.label };
    else {
      const [a, b] = arms as [ComparedArm, ComparedArm];
      const nA = n[a.label]!;
      const nB = n[b.label]!;
      const major = nA >= nB ? a.label : b.label;
      if (nA + nB === 0)
        p = {
          class: "balanced",
          n,
          nOther,
          nUnknown,
          reason: "both arms' runs are sources, but none of their records is from this scenario",
        };
      else if (d === undefined)
        p = {
          class: "one-sided",
          n,
          nOther,
          nUnknown,
          drawnFrom: major,
          reason:
            "this pool was built before the harness recorded duplicate results, so its split between arms cannot be bounded — rebuild it with `search-pool build` (no spend), or re-export it from a pool built by this harness, or pass --allow-confounded-pool",
        };
      else {
        const share = (Math.max(nA, nB) + d) / (nA + nB + d);
        p =
          share > ONE_SIDED_SHARE
            ? {
                class: "one-sided",
                n,
                nOther,
                nUnknown,
                drawnFrom: major,
                ...(d > 0
                  ? {
                      reason: `${d} duplicate result(s) could belong to either arm; the worst case is ${(share * 100).toFixed(0)}% from ${major} — pass --allow-confounded-pool to run anyway, and every surface will say CONFOUNDED`,
                    }
                  : {}),
              }
            : { class: "balanced", n, nOther, nUnknown };
      }
    }
    // Unknown evidence marks a pool CONFOUNDED and upgrades disjoint/balanced; it never lifts a one-sided refusal.
    if (nUnknown > 0 && p.class !== "one-sided") p = { ...p, class: "unknown" };
    perScenario[sc] = p;
    overall = worseClass(overall, p.class);
  }
  return { class: overall, perScenario, sharesBounded: d !== undefined };
}

/** The refusal for a one-sided pool, naming the scenario, the arm and the counts; null when the pool may run. */
export function provenanceRefusal(p: PoolProvenance): string | null {
  if (p.class !== "one-sided") return null;
  const [sc, s] = Object.entries(p.perScenario).find(([, v]) => v.class === "one-sided")!;
  const total = Object.values(s.n).reduce((x, y) => x + y, 0);
  return (
    `the search pool's records for scenario "${sc}" come from ${s.drawnFrom} (${s.n[s.drawnFrom!] ?? 0} of ${total} records from the compared variants)` +
    (s.reason
      ? `: ${s.reason}`
      : "; a frozen corpus built from one arm favours it — pass --allow-confounded-pool to run anyway, and every surface will say CONFOUNDED")
  );
}

/** The CONFOUNDED line every surface prints, or null for a clean pool. */
export function provenanceLine(p: PoolProvenance): string {
  if (p.class === "one-sided") {
    const from = [...new Set(Object.values(p.perScenario).flatMap((s) => (s.drawnFrom ? [s.drawnFrom] : [])))].join(", ");
    return `pool provenance: one-sided — CONFOUNDED: pool drawn from ${from}${p.allowConfoundedPool ? " (--allow-confounded-pool)" : ""}`;
  }
  if (p.class === "unknown") return "pool provenance: unknown — CONFOUNDED: some records' sources are unknown or from another scenario";
  return `pool provenance: ${p.class}`;
}
