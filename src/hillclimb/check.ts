// Loop-readiness reports for `hillclimb check`, beside the schema reading in schema-check.ts.
//
// headroom: a baseline case whose every rep sits at the GOOD end of the headline metric (the ceiling)
// cannot show a gain, and one at the BAD end on every rep (the floor) cannot show a loss — often a broken
// case or grader. The guide asks for headroom before round 1 (eval-hillclimb.md l.35) and leaves the call to the loop, so
// this only ever warns: it never changes an exit code.

import type { FlowSnapshot, SchemaFinding } from "./schema-check.js";
import { rowAssertSigs } from "./metric-keys.js";

interface DeclaredMetric {
  id: string;
  kind?: string;
  better?: string;
  /** Typed as read: schema-check reports a non-number as an error, so these are only ever trusted when numbers. */
  scale?: unknown;
  min?: unknown;
}

export interface Headroom {
  metric?: string;
  better?: "higher" | "lower";
  /** Baseline cases with at least one measured, status-ok rep. */
  cases: number;
  ceiling: string[];
  floor: string[];
  /** Ready-to-print lines (`warning: …` / `note: …`). */
  warnings: string[];
}

function parseRows(text: string | undefined): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of (text ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r === "object") out.push(r);
    } catch {
      /* schema-check reports malformed lines */
    }
  }
  return out;
}

function declaredMetrics(snap: FlowSnapshot): DeclaredMetric[] {
  try {
    const st = JSON.parse(snap.state ?? "{}");
    return Array.isArray(st?.metrics) ? st.metrics.filter((m: DeclaredMetric) => m && typeof m.id === "string") : [];
  } catch {
    return [];
  }
}

export function headroom(snap: FlowSnapshot): Headroom {
  const base = snap.variants.baseline;
  const rows = parseRows(base?.results);
  if (rows.length === 0)
    return { cases: 0, ceiling: [], floor: [], warnings: ["note: no baseline rows yet — run the baseline before round 1"] };
  const declared = declaredMetrics(snap);
  // The report's headline: the first binary metric, else the first (build-report-lite.mjs l.304). With nothing declared, `pass`.
  const head = declared.find((m) => m.kind === "binary") ?? declared[0] ?? { id: "pass", kind: "binary" };
  const better = head.better === "lower" ? "lower" : "higher";
  let good: number | undefined;
  let bad: number | undefined;
  if (head.kind === "binary") [good, bad] = better === "higher" ? [1, 0] : [0, 1];
  // A float's good end is its declared bound in the improving direction: `scale` going up, `min` going down — and a
  // scenario declares `min` only when the floor is not 0 (docs/scenario.md), so an absent `min` is 0.
  else if (better === "higher" && typeof head.scale === "number") good = head.scale;
  else if (better === "lower" && (head.min === undefined || typeof head.min === "number")) good = head.min ?? 0;
  if (good === undefined && bad === undefined)
    return {
      metric: head.id,
      better,
      cases: 0,
      ceiling: [],
      floor: [],
      warnings: [
        `note: ${head.id} is ${better}-is-better with ${better === "lower" ? "a floor (min) that is not a number" : "no scale declared"} — the good end is unknown, so ceiling/floor are not computed`,
      ],
    };

  const byCase = new Map<string, number[]>();
  for (const r of rows) {
    if (r.status != null && r.status !== "ok") continue;
    const g = r.grade as Record<string, unknown> | undefined;
    const v = g?.[head.id];
    const n = typeof v === "boolean" ? +v : v;
    if (typeof n !== "number" || !Number.isFinite(n)) continue;
    const id = String(r.prompt_id ?? "");
    if (!byCase.has(id)) byCase.set(id, []);
    byCase.get(id)!.push(n);
  }
  const ceiling: string[] = [];
  const floor: string[] = [];
  for (const [id, vals] of byCase) {
    if (good !== undefined && vals.every((x) => x === good)) ceiling.push(id);
    else if (bad !== undefined && vals.every((x) => x === bad)) floor.push(id);
  }
  const n = byCase.size;
  const warnings: string[] = [];
  if (ceiling.length)
    warnings.push(
      `warning: ${ceiling.length}/${n} baseline cases are at the ceiling on ${head.id} (every rep at the good end): ${ceiling.join(", ")} — they cannot show a gain; consider harder cases, more reps or a finer-grained metric`,
    );
  if (floor.length)
    warnings.push(
      `warning: ${floor.length}/${n} baseline cases are at the floor on ${head.id} (every rep at the bad end): ${floor.join(", ")} — they cannot show a loss; check the case and its grader before round 1`,
    );
  return { metric: head.id, better, cases: n, ceiling, floor, warnings };
}

/** A declared float's value outside its range, [`min` (0 when absent), `scale`], on any variant's row: a wrong
 *  `path` or a percent-versus-fraction mix-up, which would also leave headroom's ceiling unreachable. Only a float
 *  with a numeric `scale` is checked (an unbounded one has no upper end). Warnings: they never change an exit code. */
export function metricRangeWarnings(snap: FlowSnapshot): string[] {
  const bounded = declaredMetrics(snap).filter(
    (m) => m.kind === "float" && typeof m.scale === "number" && (m.min === undefined || typeof m.min === "number"),
  );
  const out: string[] = [];
  if (!bounded.length) return out;
  for (const [variant, vs] of Object.entries(snap.variants))
    for (const r of parseRows(vs.results)) {
      const g = r.grade as Record<string, unknown> | undefined;
      for (const m of bounded) {
        const v = g?.[m.id];
        const lo = (m.min as number | undefined) ?? 0;
        const hi = m.scale as number;
        if (typeof v !== "number" || !Number.isFinite(v) || (v >= lo && v <= hi)) continue;
        out.push(
          `warning: grade.${m.id} = ${v} is outside its declared range [${lo}, ${hi}] (variant ${variant}, prompt_id ${String(r.prompt_id)}, rep ${String(r.rep)}) — check the metric's path and units`,
        );
      }
    }
  return out;
}

/** One warning per case whose rows (any variant) carry more than one `meta.assert_sig`: they were graded under different
 *  assertion sets (a pass resumed after an approved scenario edit), so a comparison over them mixes two graders. Each
 *  sig is named with its row count per variant, in first-seen order; a row with no sig is not counted. */
export function assertSigWarnings(snap: FlowSnapshot, flowArg = "<flow>", target = "<scenarios>"): string[] {
  const byCase = new Map<string, Map<string, Map<string, number>>>();
  for (const r of rowAssertSigs(snap)) {
    const sigs = byCase.get(r.promptId) ?? new Map<string, Map<string, number>>();
    const per = sigs.get(r.sig) ?? new Map<string, number>();
    per.set(r.variant, (per.get(r.variant) ?? 0) + 1);
    sigs.set(r.sig, per);
    byCase.set(r.promptId, sigs);
  }
  const out: string[] = [];
  for (const [id, sigs] of byCase) {
    if (sigs.size < 2) continue;
    const where = [...sigs].map(([sig, per]) => `${sig}: ${[...per].map(([v, n]) => `${v} ${n}`).join(", ")}`).join("; ");
    out.push(
      `warning: case ${id}'s rows were graded under ${sigs.size} assertion sets (${where}) — a comparison over them mixes graders; run \`hillclimb regrade ${target} --flow ${flowArg} --case ${id}\` to re-evaluate them (a scenario edited since the flow's last approval also needs --approve-harness on it, which is the user's to give)`,
    );
  }
  return out;
}

/** Ours, on `_state.json`: a declared float needs `better`. The upstream default is "higher", which on a
 *  cost-like metric silently climbs the wrong way. */
export function stateMetricFindings(snap: FlowSnapshot): SchemaFinding[] {
  return declaredMetrics(snap)
    .filter((m) => m.kind === "float" && m.better !== "higher" && m.better !== "lower")
    .map((m) => ({
      level: "error" as const,
      rule: "state.metrics",
      file: "_state.json",
      message: `metric ${m.id} is a float with no \`better\` ("higher" or "lower"); the report would assume higher`,
    }));
}

const variantNumber = (v: string): number => (v === "baseline" ? 0 : Number(v.slice(1)));

/** The variants holding a frozen pairwise reference (a file under `<variant>/ref/`), baseline first. */
function refVariants(snap: FlowSnapshot): string[] {
  const out = new Set<string>();
  for (const f of snap.files ?? []) {
    const m = /^(baseline|v[1-9]\d*)\/ref\//.exec(f);
    if (m) out.add(m[1]!);
  }
  return [...out].sort((a, b) => variantNumber(a) - variantNumber(b));
}

/** The second-reference hint (warn-only, never an exit code): a variant that beats the NEWEST reference on 90% or
 *  more of its measured rows has little left to show against it — freeze that variant's own reference, so the next
 *  rounds are compared with the new bar (`win_<vN>`). Only variants numbered after the newest reference count. */
export function pairwiseHints(snap: FlowSnapshot, flowArg = "<flow>", target = "<scenarios>"): string[] {
  const refs = refVariants(snap);
  const newest = refs[refs.length - 1];
  if (newest === undefined) return [];
  const col = newest === "baseline" ? "win" : `win_${newest}`;
  const out: string[] = [];
  for (const v of Object.keys(snap.variants).sort((a, b) => variantNumber(a) - variantNumber(b))) {
    if (variantNumber(v) <= variantNumber(newest)) continue;
    const vals: number[] = [];
    for (const r of parseRows(snap.variants[v]?.results)) {
      if (r.status != null && r.status !== "ok") continue;
      const g = r.grade as Record<string, unknown> | undefined;
      if (g?.[`${col}_present`] === 1 && typeof g[col] === "number") vals.push(g[col] as number);
    }
    if (!vals.length) continue;
    const mean = vals.reduce((s, x) => s + x, 0) / vals.length;
    if (mean >= 0.9)
      out.push(
        `note: ${v} scores ${mean.toFixed(2)} on ${col} over ${vals.length} row(s) — it has little left to show against the ${newest} reference; ` +
          `freeze ${v}'s own with \`hillclimb freeze-ref ${target} --flow ${flowArg} --variant ${v}\` to compare the next rounds with it`,
      );
  }
  return out;
}

/** A frozen reference must not change under a flow: every row judged against one (case, assert, reference) recorded
 *  the same document sha256 (`meta.pairwise_ref_sha256`). Two differing values mean the store was replaced. */
export function pairwiseRefFindings(snap: FlowSnapshot): SchemaFinding[] {
  const seen = new Map<string, { sha: string; where: string }>();
  const out: SchemaFinding[] = [];
  for (const [v, vs] of Object.entries(snap.variants))
    for (const r of parseRows(vs.results)) {
      const shas = (r.meta as Record<string, unknown> | undefined)?.pairwise_ref_sha256;
      if (!shas || typeof shas !== "object") continue;
      for (const [k, sha] of Object.entries(shas as Record<string, unknown>)) {
        if (typeof sha !== "string") continue;
        const id = `${String(r.prompt_id)} ${k}`;
        const prev = seen.get(id);
        if (prev === undefined) seen.set(id, { sha, where: `${v} rep ${String(r.rep)}` });
        else if (prev.sha !== sha)
          out.push({
            level: "error",
            rule: "pairwise.ref_changed",
            file: `${v}/results.jsonl`,
            message: `case ${String(r.prompt_id)}: ${k} (compose key/reference) was judged against a different reference document than ${prev.where} — a frozen reference changed under the flow; start a fresh flow dir`,
          });
      }
    }
  return out;
}
