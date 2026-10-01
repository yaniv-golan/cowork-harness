// `hillclimb state-template`: the `_state.json` skeleton and the `metrics.md` the LOOP saves. The runner never
// writes either: `_state.json` is loop-owned except for `harness_sha` (runner-scaffold.mjs l.12-13), and `metrics.md` is the
// loop's free-text rubric the full viewer renders (eval-hillclimb.md l.131). This only prints what the rows will carry, so the
// declarations come from the same producer the row writer uses.
//
// Never printed: goal, best, harness_sha, the split ids, approve_each_round, current_round — all loop-owned
//. After a metric is added mid-loop, the loop re-runs this and merges only the NEW `metrics` entries.

import type { Assertion } from "../types.js";
import { flowHasPairwise, flowMetricDecls, metricUnion, type GradeKeyDecl, type MetricDecl } from "./grade-keys.js";

export interface PerfField {
  id: string;
  label: string;
  unit?: string;
}

export interface StateTemplate {
  state: { metrics: GradeKeyDecl[]; perf_fields: PerfField[]; harness_paths: string[] };
  metricsMd: string;
  /** Why a pairwise column was left undeclared (printed to stderr). */
  notes: string[];
}

const PERF: PerfField[] = [
  { id: "cost_usd", label: "Cost", unit: "$" },
  { id: "latency_s", label: "Latency", unit: "s" },
  { id: "tool_calls", label: "Tool calls" },
  { id: "web_searches", label: "Web searches" },
  { id: "in_tokens", label: "In tokens" },
  { id: "out_tokens", label: "Out tokens" },
  { id: "skill_invoked", label: "Skill invoked" },
];

const PER_INDEX_ID = /^a(\d+)(?:_c(\d+)|(_present))?$/;
/** A per-index `semantic_pairwise` key: `a<i>_win`, `a<i>_win_<vN>`, each with its `_present` companion. */
const PER_INDEX_WIN_ID = /^a(\d+)_(win(?:_v[1-9]\d*)?)(_present)?$/;

export function stateTemplate(opts: {
  cases: ReadonlyArray<{ name?: string; assertions: readonly Assertion[]; metrics?: readonly MetricDecl[] }>;
  harnessPaths: readonly string[];
  decider: boolean;
  /** The flow's later-variant references (`v3`, …), each with how many scored rows lack its column. Known only with
   *  `--flow`. A column is declared only when NO scored row lacks it: rows written before its reference was frozen do
   *  not carry it, and `check` would then fail every one of them. */
  pairwiseRefs?: ReadonlyArray<{ ref: string; rowsMissing: number }>;
}): StateTemplate {
  const notes: string[] = [];
  const declare = (opts.pairwiseRefs ?? []).filter((r) => r.rowsMissing === 0).map((r) => r.ref);
  for (const r of opts.pairwiseRefs ?? [])
    if (r.rowsMissing > 0)
      notes.push(
        `win_${r.ref} is not declared: ${r.rowsMissing} scored row(s) were written before ${r.ref}'s reference was frozen and do not carry it, ` +
          `— run \`hillclimb regrade --fill-refs\` to add it to them, then re-run this command`,
      );
  if (opts.pairwiseRefs === undefined && flowHasPairwise(opts.cases))
    notes.push("pass --flow to declare a win_<vN> column for each later variant's frozen reference (only `win` is declared without it)");
  const metrics = flowMetricDecls(opts.cases, { metricRefs: declare });
  const perf = opts.decider ? [...PERF, { id: "decider_usd", label: "Decider $", unit: "$" }] : [...PERF];
  return {
    state: { metrics, perf_fields: perf, harness_paths: [...opts.harnessPaths] },
    metricsMd: metricsMd(metrics, metricUnion(opts.cases)),
    notes,
  };
}

function metricsMd(declared: readonly GradeKeyDecl[], floats: readonly MetricDecl[]): string {
  const ids = new Set(declared.map((d) => d.id));
  const L: string[] = ["# Metrics", "", "Written by `cowork-harness hillclimb state-template`. Every scored row carries these keys.", ""];
  L.push(
    "- `pass` — 1 when the run's verdict passed (every assertion, plus the run-level checks), else 0. The headline.",
    "- `pass_present` — 0 when the verdict failed ONLY because a `semantic_matches` judge's evidence was refused " +
      "(not graded); `pass` is then absent, not 0, so a capture problem does not read as the skill regressing.",
  );
  if (ids.has("claims"))
    L.push(
      "- `claims` — the share of the run's graded `semantic_matches` rubric claims that passed (passed / graded, 0–1). " +
        "Claims of an assertion whose evidence was refused are not graded and are left out. `explanation.claims` lists every " +
        "graded claim, failed first.",
      "- `claims_present` — 1 when at least one claim was graded on the row; when 0, `claims` is absent (not 0).",
    );
  if (ids.has("win"))
    L.push(
      "- `win` — the mean `semantic_pairwise` value against the flow's baseline reference: 1 a win, 0.5 a tie or both " +
        "outputs bad, 0 a loss, averaged over the case's pairwise assertions. The baseline's own rows are 0.5 (neutral). " +
        "`explanation.win` carries the judge's reasons (untrusted model text).",
      "- `win_present` — 0 when a pairwise comparison with the baseline could not be made (refused evidence, a missing " +
        "or damaged reference); `win` and `both_bad` are then absent (not 0).",
      "- `both_bad` — 1 when the judge found both outputs bad on any pairwise assertion (a weak reference shows here first).",
    );
  for (const d of declared.filter((x) => /^win_v\d+$/.test(x.id)))
    L.push(
      `- \`${d.id}\` — the same as \`win\`, against ${d.id.slice(4)}'s frozen reference: a metric only, it never decides \`pass\`. \`${d.id}_present\` is 0 when that comparison could not be made.`,
    );
  for (const m of floats)
    L.push(
      `- \`${m.id}\` — a scenario-declared number: the value at \`${m.path}\` in \`${m.artifact}\`, ${m.better} is better, ` +
        `${m.scale !== undefined ? `bounded above by ${m.scale}` : "no upper bound"}, floor ${m.min ?? 0}. ` +
        `\`${m.id}_present\` is 1 when it was measured; when 0 the value is absent (not 0), so its mean is over measured rows only, ` +
        "and the row's `meta.metrics_unavailable` says why.",
    );
  // Anchored: a scenario metric may start like one (`a11y_score`) and is a float, defined above.
  const perIndex = declared.filter((d) => PER_INDEX_ID.test(d.id) || PER_INDEX_WIN_ID.test(d.id));
  L.push("");
  if (perIndex.length) {
    L.push("Per-assertion keys (every case has the same assertion list):", "");
    for (const d of perIndex) {
      const w = PER_INDEX_WIN_ID.exec(d.id);
      if (w) {
        L.push(
          `- \`${d.id}\` — ${w[3] ? `1 when assertion ${w[1]}'s \`${w[2]}\` was measured` : `\`${w[2]}\` of assertion ${w[1]} alone`}.`,
        );
        continue;
      }
      const m = PER_INDEX_ID.exec(d.id);
      if (!m) continue;
      const what =
        m[2] !== undefined
          ? `claim ${m[2]} of assertion ${m[1]}`
          : m[3]
            ? `1 when assertion ${m[1]} was graded`
            : `assertion ${m[1]} passed`;
      L.push(`- \`${d.id}\` — ${what}.`);
    }
  } else
    L.push(
      "Per-assertion keys (`a<i>`, `a<i>_c<j>`, `a<i>_present`) are on every row as drill-down data but are not declared: " +
        "the cases' assertion lists differ, so the same key would mean different things on different rows.",
    );
  return L.join("\n") + "\n";
}
