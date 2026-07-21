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
runLabel?, skillHash?, turn?, signals, costUsd?, tokens?, turns?, cacheReadTokens?, modelCostUsd?,
durationMs?, partial, nonDeterministic, outDir, git:{branch, sha}}`.
`pass`/`signals` come from the same `computeVerdict` every other verdict-facing surface (the footer, the
JSON envelope, `--repeat`'s rollup) uses — a row's `pass` can never read differently than the run's own
exit code did. `git` is best-effort (`git rev-parse` in the invoking cwd) — `null` outside a repo, which
is what makes "compare this branch's cost/pass-rate to main's" answerable via `--branch`. `turn` is the
1-based turn number within a resumed (`--session-id`+`--resume`) session (straight from `RunResult.turn`,
set on essentially every `run`/`skill`/`record` completion — a fresh single-shot run gets `turn:1`);
absent on the `chat` lane and on rows written before this field existed. It is the per-completion identity
`reindexFromRunsTree` merges rows by — a resumed session's turns (and `critique`'s task+reflection turns)
legitimately share one `outDir`, so `outDir` alone can't distinguish them.

`readIndex` never blindly trusts a parsed line: a line that's valid JSON but the wrong `RunIndexRow` shape
(or an incompatible future `v`) is **quarantined** — skipped, with a `::warning::`, rather than cast
through and handed to `buildStats`, which would otherwise dereference fields like `git.branch`
unconditionally on a malformed row. A quarantined row is not indexed and not counted in any stats output;
re-run `--reindex` to rebuild from `result.json` if you see this warning.

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

## Grouping by generation (the iterate-across-fixes loop)

> These recipes are step 5 of the loop in [debugging.md](./debugging.md#the-whole-loop-end-to-end) — the
> comparison step. What you pair is usually a [`critique`](./critique.md) finding set against the runs
> that produced it.

`stats` aggregates **by scenario**, and its filters are `--scenario`/`--since`/`--baseline`/`--branch`/
`--last`. There is no built-in group-by for the run-identity fields, so pair generations with `jq` over
`index.jsonl` directly — the index is the queryable source of truth, and both fields are on the row:

- **`skillHash`** — the correctness key. Content-exact; changes on any tracked edit. **Stored as a 12-char
  prefix** on the index row (the full hash is in each run's `result.json`), so a recipe groups on the
  prefix — fine for pairing within one project, but use `result.json` if you need the full value.
- **`runLabel`** — the `--label <tag>` you passed. Human-readable and orderable; ergonomics, not identity.

```bash
IDX=~/.cowork-harness/runs/index.jsonl

# pass-rate and cost per generation, newest first
jq -s 'map(select(.skillHash)) | group_by(.skillHash) | map({
    skillHash: .[0].skillHash, label: .[0].runLabel, runs: length,
    passRate: ((map(select(.pass)) | length) / length),
    costUsd: (map(.costUsd // 0) | add), latest: (map(.ts) | max)
  }) | sort_by(.latest) | reverse' "$IDX"

# which verdict signals fired per generation — the input a stagnation check needs
jq -s 'map(select(.skillHash)) | group_by(.skillHash) | map({
    skillHash: .[0].skillHash, label: .[0].runLabel,
    signals: (map(.signals) | flatten | group_by(.) | map({(.[0]): length}) | add)
  })' "$IDX"

# one scenario only, most recent two generations — the before/after of a single fix
jq -s --arg s "skill-my-skill" 'map(select(.scenario == $s and .skillHash))
  | group_by(.skillHash) | sort_by(map(.ts) | max) | .[-2:]' "$IDX"
```

**Rows without `skillHash` are excluded by the `select` above** — that is deliberate. A run that mounted no
skill or plugin has nothing to hash, and `chat` rows carry no fingerprint; silently folding them into a
generation bucket would misattribute them. If a run you expected is missing from the output, check whether
it mounted a skill at all rather than assuming the grouping dropped it.

## `--reindex`: the migration path

`index.jsonl` only exists going forward from the version that introduced it. If you have an existing
`~/.cowork-harness/runs/` full of pre-index runs (or the index file itself was ever lost or manually
edited into an unrecoverable state — normal corrupt-trailing-line tolerance aside), `--reindex` rebuilds
it by walking every run dir on disk — `<runsRoot>/<slug>/<runId>/turns/<N>/result.json` for each turn of a
multi-turn dir, or the root `result.json` for a single-turn/legacy one (the root file of a turn-layout dir
is a compatibility copy of the latest turn and is deliberately skipped, so a turn is never counted twice) —
then merging in any rows
the prior `index.jsonl` still held for run dirs no longer on disk (e.g. pruned ones):

```bash
cowork-harness stats --reindex   # rebuild, then print the default summary
```

This **overwrites** `index.jsonl` wholesale (it never appends in place), so it's safe to run more than
once. It is not a pure from-disk rebuild, though: rows for run dirs that are gone from disk (e.g. pruned)
are carried over from the prior index, so pruned-run history survives a reindex — see
[Interplay with `prune`](#interplay-with-prune). A run dir with a missing or corrupt `result.json` is
skipped, not fatal — one bad run dir never blocks indexing everything else. A stray `command:"replay"`
`result.json` is also skipped — a replay is a re-check against a frozen recording, not new evidence (the
not-indexed rule above), so reindex leaves it out rather than relabeling it `"run"`; any prior index row
for that run dir is preserved as-is. The report line counts the skip classes distinctly: `N skipped —
missing/corrupt result.json`, `N skipped — replay re-check, not evidence`, and `N skipped — symlinked run
dir/result.json rejected`.

A `<slug>` directory, a `<runId>` directory, or a `result.json` itself that is a **symlink** is rejected
outright and never followed — a symlinked entry under `runsRoot` must never cause an arbitrary external
file to be read and indexed as harness evidence. Its realpath is additionally required to resolve inside
`runsRoot` before it is opened, as defense-in-depth against a non-symlink escape (e.g. a TOCTOU swap of an
ancestor path component). All of this is counted in the `skippedUnsafe` skip class above, surfaced by
`cowork-harness stats --reindex`'s summary line — a rejected symlink is never silently dropped from the
report.

`result.json` now persists a `command` field (`run`/`skill`/`record`/`chat`), and `--reindex` prefers it:
`result.command` first, falling back to the prior index row's `command` (for results written before that
field existed), then to deriving from `RunResult.mode`. Previously reindex derived `command` from `mode`
alone, which has no `skill`/`record` value — so every rebuild silently relabeled a `skill`/`record` run as
`run`. Preferring the persisted `command` (with the prior-index fallback for older results) keeps a
`skill`/`record` run's history correctly labeled across repeated reindexes.

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
