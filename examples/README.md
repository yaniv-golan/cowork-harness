# Examples

Runnable, CI-verified worked examples — copy these as the starting point for testing your
own skill. Each scenario is executed in CI (`run examples/scenarios/`) and schema-validated
by `test/examples.test.ts`, so they can't silently rot.

> These are *examples* of the layout you'd author in your own skill repo. In **your** repo,
> `scenarios/` + `sessions/` typically live at the root; here they're under `examples/`
> because this is the harness's own repo. (The harness's internal fidelity self-tests live
> in `e2e/`, not here.)

## Layout

```
examples/
  scenarios/   one test each: prompt + scripted answers + assertions
  sessions/    pre-prompt setup (model, mounts, plugins) — referenced by scenarios via `session:`
  skills/      the example skills under test (each a Claude Code plugin folder)
  data/        sample inputs the scenarios consume (CSVs, a PDF, an mcp.json)
```

Paths inside a scenario/session resolve **relative to that file** (see
[../docs/session.md](../docs/session.md#path-expansion)), so this whole `examples/` tree is
self-contained and relocatable.

## The scenarios

| Scenario | What it demonstrates |
|---|---|
| `scenarios/example-pdf-skill.yaml` | the minimal shape — prompt + scripted answers + assertions (placeholder skill; harness plumbing only) |
| `scenarios/csv-metrics.yaml` | a non-trivial skill running a **bundled producer** end-to-end → structured `outputs/metrics.json` + a `summary.md` (paired with `python/test_csv_metrics_lane.py` for a JSON-content predicate) |
| `scenarios/csv-fx-normalize.yaml` | **graceful degradation** under default-deny egress — the skill's real network step is blocked, so `egress_denied` is backed by genuine behavior and the skill falls back instead of crashing |
| `scenarios/skill-loads.yaml` | an acceptance check that a local skill loads and the python toolchain is present |

## Run them

```bash
cowork-harness run examples/scenarios/csv-metrics.yaml   # one
cowork-harness run examples/scenarios/                    # all (CI-ready exit code)
```
