# `test/evals/hillclimb-acceptance/` — the hillclimb acceptance set

Scenarios for a live, paid end-to-end run of `/claude-api hillclimb` with `cowork-harness hillclimb run` as
the runner. Like the rest of `test/evals/`, they are a maintainer instrument: not part of `npm run ci`, never
run on a PR, and they cost real money.

Every file here is synthetic or the project's own: the companion skill, `examples/data/sales.csv`, a copy of
the example `metrics.py`, and an outputs tree that script produced from that CSV.

| Path | What it is |
|---|---|
| `flow-a/` | The companion skill, driven by the hillclimb loop. Five copies of gate scenarios (pinned here so a rubric edit in `scenarios/` never moves this set), a prose deliverable graded with `semantic_pairwise`, and a case built to end on a request for input (`stalled`). |
| `flow-b/` | The synthetic `plugin/`, driven by the operator: the full pipeline, a step resumed from `workspace_fixture`, a `context: fork` skill graded with `include_fork_results`, a sub-agent pinned to a different model than the main loop, and a pairwise case. |
| `plugin/` | `csv-acceptance`: the `csv-report` skill (the one under test), the forked `csv-audit` skill and the `csv-checker` agent. |
| `operator/` | One-off checks outside any flow: refusals before spend (a mount that exposes the flow dir or a reference store; a presence assert on a fixture file without `authored:`) and the `authored` semantics on fixture files. |

The fixture files under `flow-b/fixtures/` must stay tracked by git: `workspace_fixture` stages tracked
files only.
