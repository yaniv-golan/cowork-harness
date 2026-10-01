// `hillclimb state-template`: the `_state.json` skeleton and the `metrics.md` the LOOP saves. The runner never
// writes either: `_state.json` is loop-owned except for `harness_sha` (runner-scaffold.mjs l.12-13), and `metrics.md` is the
// loop's free-text rubric the full viewer renders (eval-hillclimb.md l.131). This only prints what the rows will carry, so the
// declarations come from the same producer the row writer uses.
//
// Never printed: goal, best, harness_sha, the split ids, approve_each_round, current_round — all loop-owned
//. After a metric is added mid-loop, the loop re-runs this and merges only the NEW `metrics` entries.

import type { Assertion } from "../types.js";
import { flowMetricDecls, metricUnion, type GradeKeyDecl, type MetricDecl } from "./grade-keys.js";

export interface PerfField {
  id: string;
  label: string;
  unit?: string;
}

export interface StateTemplate {
  state: { metrics: GradeKeyDecl[]; perf_fields: PerfField[]; harness_paths: string[] };
  metricsMd: string;
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

export function stateTemplate(opts: {
  cases: ReadonlyArray<{ assertions: readonly Assertion[]; metrics?: readonly MetricDecl[] }>;
  harnessPaths: readonly string[];
  decider: boolean;
}): StateTemplate {
  const metrics = flowMetricDecls(opts.cases);
  const perf = opts.decider ? [...PERF, { id: "decider_usd", label: "Decider $", unit: "$" }] : [...PERF];
  return {
    state: { metrics, perf_fields: perf, harness_paths: [...opts.harnessPaths] },
    metricsMd: metricsMd(metrics, metricUnion(opts.cases)),
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
  for (const m of floats)
    L.push(
      `- \`${m.id}\` — a scenario-declared number, ${m.better} is better, ${m.scale !== undefined ? `bounded above by ${m.scale}` : "no upper bound"}. ` +
        `\`${m.id}_present\` is 1 when it was measured; when 0 the value is absent (not 0), so its mean is over measured rows only.`,
    );
  const perIndex = declared.filter((d) => /^a\d+/.test(d.id));
  L.push("");
  if (perIndex.length) {
    L.push("Per-assertion keys (every case has the same assertion list):", "");
    for (const d of perIndex) {
      const m = /^a(\d+)(?:_c(\d+)|(_present))?$/.exec(d.id)!;
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
