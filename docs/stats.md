# Cross-run stats: `index.jsonl` + `cowork-harness stats`

Every `run`/`skill` invocation (and `record`'s own live execution) writes one JSON line to
`<runsRoot>/index.jsonl` at the same moment it writes `result.json` — a durable, queryable history of
every run, independent of whether the run dir itself survives a later `prune`. `cowork-harness stats`
reads it back.

## What gets indexed

- **`run`/`skill` invocations** — both the success path and a salvaged **partial** run (one that exited
  on an unanswered gate) are indexed, tagged `partial:true` for the latter.
- **`record`'s live execution** — tagged `command:"record"` so a recording session isn't misread as a
  `run` invocation in aggregate stats.
- **NOT indexed**: `replay` results (they're re-checks against a frozen recording, not new evidence).
  `chat` sessions ARE indexed (`command:"chat"`) once the REPL ends, so a chat session shows up in
  `stats`/`trace`/`scaffold` too — see [README → Commands at a glance](../README.md#commands-at-a-glance).

Each row: `{v, ts, command, scenario, slug, runId, fidelity, effectiveFidelity, baseline, result, pass,
signals, costUsd?, tokens?, turns?, durationMs?, partial, nonDeterministic, outDir, git:{branch, sha}}`.
`pass`/`signals` come from the same `computeVerdict` every other verdict-facing surface (the footer, the
JSON envelope, `--repeat`'s rollup) uses — a row's `pass` can never read differently than the run's own
exit code did. `git` is best-effort (`git rev-parse` in the invoking cwd) — `null` outside a repo, which
is what makes "compare this branch's cost/pass-rate to main's" answerable via `--branch`.

## `cowork-harness stats [<scenario>]`

```bash
cowork-harness stats                              # every indexed scenario
cowork-harness stats csv-metrics                   # one scenario
cowork-harness stats --since 2026-07-01 --branch feature-x
cowork-harness stats --metric cost --last 20        # last 20 runs per scenario, cost view only
```

Default output is a per-scenario summary line: run count, pass rate, cost/duration p50 & p95, and the
most recent **passing** run's timestamp (`lastGreenTs` — absent if the scenario has never passed).
`--metric pass-rate|cost|tokens|duration|turns|cache-tokens|model-cost` narrows the line to just that one
view (`cache-tokens` shows cache-read-token p50/p95; `model-cost` shows per-model cost p50/p95, distinct
from the plain `cost` metric's overall run cost). `--last <n>`
windows to the N most recent runs **per scenario** (not globally — a global cut would starve a
low-frequency scenario out of the window entirely once a high-frequency one dominates recent rows).

`--metric` is a text-mode-only view narrower — `--output-format json` always returns every field for every
scenario regardless of `--metric`, the same convention `--quiet`/`--verbose` already follow elsewhere in
this CLI (machine output stays fully populated; only the human-readable render narrows). A JSON consumer
that only wants cost data filters client-side (`jq '.stats[].p50CostUsd'`) rather than losing the other
fields to a server-side narrowing it didn't ask for.

## `--reindex`: the migration path

`index.jsonl` only exists going forward from the version that introduced it. If you have an existing
`~/.cowork-harness/runs/` full of pre-index runs (or the index file itself was ever lost or manually
edited into an unrecoverable state — normal corrupt-trailing-line tolerance aside), `--reindex` rebuilds
it from scratch by walking `<runsRoot>/<slug>/<runId>/result.json` for every run dir on disk:

```bash
cowork-harness stats --reindex   # rebuild, then print the default summary
```

This is a **true rebuild** (overwrites, never appends to, any prior `index.jsonl`), so it's safe to run
more than once. A run dir with a missing or corrupt `result.json` is skipped, not fatal — one bad run dir
never blocks indexing everything else.

## Interplay with `prune`

`prune` deletes run **dirs**, never index rows — the index is the durable history, so a pruned scenario's
stats don't silently disappear. `stats` marks a row `pruned` (visible in the JSON envelope's per-row
`prunedRuns` count) when its `outDir` no longer exists on disk, so you can tell "the aggregate number is
real, but there's no run dir left to `trace`/`inspect` for detail" apart from "still fully inspectable."

## How this composes with `trace`/`inspect`/`scaffold`/`status`

Those four commands already resolve a bare run-id or scenario **fragment** (e.g. `cowork-harness trace
abc123`) — that resolution now checks the index FIRST (faster, and the source of truth going forward),
falling through to the pre-index filesystem walk automatically for any run that predates the index or
was never indexed. Ambiguous-fragment handling (multiple matches → pick the most recent, warn loudly with
every candidate) is preserved exactly, whichever path resolves it — you will never see a behavior
difference, only (for indexed runs) a faster, index-backed lookup.
