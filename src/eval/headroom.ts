// `eval report <dir> --headroom`: the assertion and claim rows one arm still has room to move on — what a hillclimb
// pass could raise. Read-only over the report; it never changes the exit code.
//
// A row is listed when the arm passed it on some reps but not all (0 < k < n), with headroom min(p, 1 − p), or when
// the arm has fewer than HEADROOM_MIN_REPS reps on it ("too few reps to tell": 0/3 and 3/3 say little). A row at 0% or
// 100% over enough reps is not listed.

import { UsageError } from "../errors.js";
import type { EvalReport, ReportRow } from "./report.js";

export const HEADROOM_MIN_REPS = 4;

export interface HeadroomRow {
  section: "tuned" | "heldOut";
  scenario: string | null;
  kind: ReportRow["kind"];
  text: string;
  assertionIndex?: number;
  k: number;
  n: number;
  /** k / n; null when the arm has no rep on the row. */
  rate: number | null;
  /** min(rate, 1 − rate); null with no rep. */
  headroom: number | null;
  /** Fewer than HEADROOM_MIN_REPS reps: listed whatever the rate. */
  tooFewReps: boolean;
}

/** `--arm`: an arm's label, or its role (A or B). A value that is one arm's label and the other's role is refused. */
export function resolveHeadroomArm(report: Pick<EvalReport, "arms">, arm: string): "A" | "B" {
  const byLabel = report.arms.filter((a) => a.label === arm).map((a) => a.role);
  const byRole = arm === "A" || arm === "B" ? [arm] : [];
  const roles = [...new Set([...byLabel, ...byRole])];
  if (roles.length === 1) return roles[0] as "A" | "B";
  const known = report.arms.map((a) => `${a.label} (${a.role})`).join(", ");
  if (roles.length === 0) throw new UsageError(`--arm ${arm} names no arm of this eval (${known})`);
  throw new UsageError(`--arm ${arm} is ambiguous: it is one arm's label and the other arm's role (${known}) — pass the other spelling`);
}

export function headroomRows(report: Pick<EvalReport, "sections">, role: "A" | "B"): HeadroomRow[] {
  const out: HeadroomRow[] = [];
  for (const section of ["tuned", "heldOut"] as const) {
    for (const r of report.sections[section]?.rows ?? []) {
      const k = role === "A" ? r.k1 : r.k2;
      const n = role === "A" ? r.n1 : r.n2;
      const tooFewReps = n < HEADROOM_MIN_REPS;
      if (!tooFewReps && (k === 0 || k === n)) continue;
      const rate = n > 0 ? k / n : null;
      out.push({
        section,
        scenario: r.scenario,
        kind: r.kind,
        text: r.text,
        ...(r.assertionIndex !== undefined ? { assertionIndex: r.assertionIndex } : {}),
        k,
        n,
        rate,
        headroom: rate === null ? null : Math.min(rate, 1 - rate),
        tooFewReps,
      });
    }
  }
  // Most headroom first; a row with no rep last; then by scenario and text, so the order is stable.
  return out.sort(
    (a, b) =>
      (b.headroom ?? -1) - (a.headroom ?? -1) ||
      String(a.scenario ?? "").localeCompare(String(b.scenario ?? "")) ||
      a.text.localeCompare(b.text),
  );
}

export function headroomText(rows: readonly HeadroomRow[], arm: { label: string; role: "A" | "B" }): string {
  const head = `headroom (arm ${arm.role}, ${arm.label}): ${rows.length} row(s) with room to move`;
  if (!rows.length) return `${head} — every row is at 0% or 100% over ${HEADROOM_MIN_REPS}+ reps`;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return [
    head,
    ...rows.map(
      (r) =>
        `  ${r.section === "heldOut" ? "held out" : "tuned"} · ${r.scenario ?? "(all)"} · ${r.kind} ${r.text} · ${r.k}/${r.n}` +
        (r.rate === null ? "" : ` (${pct(r.rate)})`) +
        (r.tooFewReps ? " — too few reps to tell" : ` — headroom ${pct(r.headroom!)}`),
    ),
  ].join("\n");
}
