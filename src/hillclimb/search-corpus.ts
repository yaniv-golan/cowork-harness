// A hillclimb flow's frozen search corpus, read from its rows: which pool each row was served from
// (`meta.search_corpus`), each variant's per-case skill signature (for the provenance check), the mixed-row refusal,
// and the `hillclimb check` findings. Pure over a flow snapshot.

import type { ComparedArm } from "../search-corpus/provenance.js";
import { asymmetry, asymmetryLine, sideMetrics, type CorpusRepCounts } from "../search-corpus/asymmetry.js";
import type { FlowSnapshot } from "./schema-check.js";

export interface RowSearchCorpus {
  sha256: string;
  label: string;
  provenance?: string;
  confounded?: boolean;
  served?: number;
  miss?: number;
  refused?: number;
  mean_top_score?: number;
  signals?: string[];
  allow_mixed_search?: boolean;
  pool_mismatch?: unknown;
}

export interface FlowRow {
  variant: string;
  file: "results" | "errors";
  caseId: string;
  meta: Record<string, unknown>;
  failureClass?: string;
}

function parse(text: string | undefined): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const l of (text ?? "").split("\n")) {
    if (!l.trim()) continue;
    try {
      const v = JSON.parse(l) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) out.push(v as Record<string, unknown>);
    } catch {
      /* a torn line is the schema check's business */
    }
  }
  return out;
}

export function flowRows(snap: FlowSnapshot): FlowRow[] {
  const rows: FlowRow[] = [];
  for (const [variant, v] of Object.entries(snap.variants))
    for (const [file, text] of [
      ["results", v.results],
      ["errors", v.errors],
    ] as const)
      for (const r of parse(text)) {
        const meta = r.meta && typeof r.meta === "object" ? (r.meta as Record<string, unknown>) : {};
        rows.push({
          variant,
          file,
          caseId: String(r.prompt_id ?? ""),
          meta,
          ...(typeof r.failure_class === "string" ? { failureClass: r.failure_class } : {}),
        });
      }
  return rows;
}

export const rowCorpus = (r: FlowRow): RowSearchCorpus | undefined => {
  const sc = r.meta.search_corpus;
  return sc && typeof sc === "object" && typeof (sc as RowSearchCorpus).sha256 === "string" ? (sc as RowSearchCorpus) : undefined;
};

/** Every other variant with rows, as a compared arm: its per-scenario signature from its rows' `content_sig` (scored
 *  and error rows alike, skipping a row of another snapshot). */
export function otherVariantArms(
  rows: readonly FlowRow[],
  variant: string,
  scenarioOf: (caseId: string) => string | undefined,
): ComparedArm[] {
  const by = new Map<string, Record<string, string>>();
  for (const r of rows) {
    if (r.variant === variant || r.meta.arm_source_drift === true || typeof r.meta.content_sig !== "string") continue;
    const sc = scenarioOf(r.caseId);
    if (sc === undefined) continue;
    const sigs = by.get(r.variant) ?? {};
    sigs[sc] ??= r.meta.content_sig;
    by.set(r.variant, sigs);
  }
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([label, sigs]) => ({ label, sigs }));
}

/** The pool hashes the flow's rows were served from; `null` stands for live search. */
export function rowPools(rows: readonly FlowRow[]): Map<string | null, number> {
  const m = new Map<string | null, number>();
  for (const r of rows) {
    const k = rowCorpus(r)?.sha256 ?? null;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

/** The pass is refused before spend when the flow already holds rows served otherwise (another pool, or live). */
export function mixedRowsRefusal(rows: readonly FlowRow[], sha256: string | null): string | null {
  const others = [...rowPools(rows).entries()].filter(([k]) => k !== sha256);
  if (!others.length) return null;
  const what = others.map(([k, n]) => `${n} row(s) ${k === null ? "searched live" : `served from pool ${k.slice(0, 8)}`}`).join(", ");
  return `the flow already holds ${what}, and this pass ${sha256 === null ? "searches live" : `is served from pool ${sha256.slice(0, 8)}`}: rows served differently are not comparable. Use a fresh flow dir, or pass --allow-mixed-search (printed on every row)`;
}

export interface CorpusFinding {
  severity: "error" | "warning";
  rule: string;
  message: string;
}

/** `hillclimb check`'s frozen-corpus findings. */
export function searchCorpusFindings(snap: FlowSnapshot): CorpusFinding[] {
  const rows = flowRows(snap);
  const out: CorpusFinding[] = [];
  const pools = rowPools(rows);
  if (pools.size > 1) {
    // Every frozen row was written by a pass that chose --allow-mixed-search: said, not an error.
    const allowed = rows.filter((r) => rowCorpus(r)).every((r) => rowCorpus(r)!.allow_mixed_search === true);
    out.push({
      severity: allowed ? "warning" : "error",
      rule: "search_corpus.mixed",
      message: `rows were served from ${[...pools.entries()].map(([k, n]) => `${k === null ? "live search" : `pool ${k.slice(0, 8)}`} (${n})`).join(", ")}: a score across them compares the pools, not the variants`,
    });
  }
  const mismatched = rows.filter((r) => r.failureClass === "search_pool_mismatch");
  if (mismatched.length)
    out.push({
      severity: "error",
      rule: "search_corpus.pool_mismatch",
      message: `${mismatched.length} attempt(s) were not served from their pass's pinned pool (${[...new Set(mismatched.map((r) => r.variant))].join(", ")}): the pool copy under the snapshot root changed; delete it and re-run those slots`,
    });
  const confounded = rows.filter((r) => r.file === "results" && rowCorpus(r)?.confounded === true);
  if (confounded.length)
    out.push({
      severity: "warning",
      rule: "search_corpus.confounded",
      message: `${confounded.length} row(s) (${[...new Set(confounded.map((r) => r.variant))].join(", ")}) were served from a pool drawn from one variant or from unknown sources: CONFOUNDED`,
    });
  const judged = rows.filter((r) => r.file === "results" && rowCorpus(r)?.signals?.includes("search_corpus_semantic_judge"));
  if (judged.length)
    out.push({
      severity: "warning",
      rule: "search_corpus.semantic_judge",
      message: `${judged.length} row(s) were graded by a judge on recorded searches: a grade there is not evidence of research quality`,
    });
  const counts = (v: string): CorpusRepCounts[] =>
    rows.flatMap((r) => {
      const c = r.variant === v && r.file === "results" ? rowCorpus(r) : undefined;
      return c && typeof c.served === "number" && typeof c.miss === "number"
        ? [{ served: c.served, miss: c.miss, ...(typeof c.mean_top_score === "number" ? { meanTopScore: c.mean_top_score } : {}) }]
        : [];
    });
  if (snap.variants.baseline) {
    const base = sideMetrics(counts("baseline"));
    for (const v of Object.keys(snap.variants)
      .filter((x) => x !== "baseline")
      .sort()) {
      const mine = sideMetrics(counts(v));
      if (mine.reps === 0 || base.reps === 0) continue;
      const cell = asymmetry({ label: "baseline", m: base }, { label: v, m: mine });
      if (cell.judged && cell.fires)
        out.push({
          severity: "warning",
          rule: "search_corpus.asymmetric",
          message: `${v} vs baseline: ${asymmetryLine(cell, base, mine)}`,
        });
    }
  }
  return out;
}

/** The cost line's frozen-corpus clause over a variant's rows (scored and error rows alike), or null. */
export function searchCorpusCostClause(rows: readonly FlowRow[]): string | null {
  const frozen = rows.filter((r) => rowCorpus(r));
  if (!frozen.length) return null;
  const sum = (k: "served" | "miss" | "refused") => frozen.reduce((n, r) => n + (rowCorpus(r)![k] ?? 0), 0);
  const mismatches = frozen.filter((r) => r.failureClass === "search_pool_mismatch").length;
  const labels = [...new Set(frozen.map((r) => rowCorpus(r)!.label))];
  return (
    `search frozen: ${sum("served")} served, ${sum("miss")} miss, ${sum("refused")} refused over ${frozen.length} row(s)` +
    (mismatches ? `, ${mismatches} pool mismatch(es)` : "") +
    ` ${labels.map((l) => `[${l}]`).join(" ")}`
  );
}
