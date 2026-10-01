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
  `stats`/`trace`/`scaffold` too — see [docs/cli.md → Commands at a glance](./cli.md#commands-at-a-glance).

Each row: `{v, ts, command, scenario, slug, runId, fidelity, effectiveFidelity, baseline, result, pass,
runLabel?, skillHash?, turn?, critiqueRole?, skill?, critiqueTotalUsd?, signals, costUsd?, tokens?, turns?,
cacheReadTokens?, modelCostUsd?, judgeCostUsd?, deciderCostUsd?, durationMs?, partial, nonDeterministic, outDir, git:{branch, sha}}`.

`costUsd` is the run's `cost.usd`: the agent session's own SDK-reported spend. It does **not** include
the `semantic_matches` judge or the LLM decider (`on_unanswered: llm` / `--decider-llm`), which are
separate model calls, so neither `totalUsd` nor the `--max-budget-usd` estimates built from these rows
counts them. (A critique's evaluator passes are the exception: the roll-up row below carries them.) The
judge's spend is recorded beside it instead: `judgeCostUsd` sums the run's
`assertions[].judgeCostUsd` (every attempt of every `semantic_matches` and `semantic_pairwise` grade), and is absent when no
judge call was priced. The LLM decider's spend is recorded the same way: `deciderCostUsd` is the run's
`deciderCostUsd` (what every completed decider call reported, the gate that whiffed on a partial run included; a call
that threw is not counted, so it is a floor), absent when
no LLM decider answered or none of its calls was priced. `stats --runs` prints both beside each run's cost
(`judge=$…`, `decider=$…`), and its JSON `runs[]` entries carry `judgeCostUsd`/`deciderCostUsd`; neither is
added to `costUsd`, `totalUsd` or the cost percentiles.

**Summing a critique's cost: use the roll-up row, not the turns.** A `critique` is FOUR model workloads,
but only two of them produce a run — the graded turn and the reflection turn each write a row via the inner
`skill` run, while the two evaluator passes are direct API calls that produce no run and therefore no row.
Summing `costUsd` across the turn rows alone under-reports a critique by roughly 39%. Each completed
critique writes one extra row with `critiqueRole:"rollup"` carrying `critiqueTotalUsd` (the whole
four-workload spend) plus the `skill` it graded; the two turn rows carry `critiqueRole:"task"` and
`"reflection"`.

**`sum(costUsd)` over all rows is correct with no filtering.** The roll-up's `costUsd` is the EVALUATOR
passes only — the two turns already contribute their own — so nothing double-counts and nothing is missed.
`critiqueTotalUsd` is the per-critique convenience figure; summing THAT across roll-ups also gives true
total critique spend. A roll-up with `result:"error"` means a workload was unpriced, so its totals
UNDERCOUNT.

**Which statistics see a roll-up, and which do not.** Three different questions want three different row
sets, and `stats` keeps them apart deliberately:

| The question | Answered by | Roll-ups |
|---|---|---|
| *Is this a run, and did it pass?* | `runs`, `passRate`, `lastGreenTs`, `prunedRuns` | **excluded** — a roll-up has no verdict and no duration; counting it adds a phantom run and drags `passRate` toward 1 |
| *What does ONE run cost or take?* | every `p50`/`p95` | **excluded** — the p50 of `[task, reflection, evaluators]` is not a typical run cost |
| *What did all of this cost me?* | **`totalUsd`** | **included** — the only figure that reflects a critique's true spend |

So a critique's real cost is `totalUsd`, never the cost percentiles beside it. On the live example run,
`p50` reads `$0.1708` (a graded turn) against a `totalUsd` of `$1.0588` (the whole critique). The two are
answering different questions and are both correct.

`totalUsd` is `undefined` — never `$0.0000` — when nothing in the group carried cost telemetry, and
**`unpricedRuns`** counts rows in the cost set that had none, so a total that is a floor says so instead
of looking precise. The same rule as everywhere else here: an unpriced row is skipped, not counted as zero.

**`--max-budget-usd` is deliberately NOT built on `totalUsd`.** Its pre-flight reads per-RUN history, which
excludes roll-ups: it is asking "will my next run breach this cap", and a run is not a critique. Including
evaluator spend there would refuse runs costing a fraction of the cap.

`--reindex` reconstructs roll-ups from each run dir's `critique-report.json`, so a lost or corrupted index
recovers critique costs along with everything else — provided the run dirs survive. Reconstruction is
skipped for a critique that never produced a cost (e.g. a killed task turn), matching what the live path
would have written.

**`turn` and `turns` are different things, and the names invite misreading.** `turn` (singular) is the
1-based turn number within a resumed `--session-id`+`--resume` session — 1 for a normal single-shot run, 2
for critique's reflection turn. `turns` (plural) is the count of **agent** turns *inside* that one run, from
the SDK's own usage accounting. So `turn: 2, turns: 1` is not "turn 2 of 1" — it is "the second turn of the
session, which itself took one agent turn". Neither field bounds the other.

There are **three row shapes**, and only the first two carry either field: an ordinary run row (`turn` set,
`turns` set), a resumed turn row (same, with `turn > 1`), and a **critique roll-up** — which has *neither*,
because it accounts for the two evaluator passes and those are not runs at all. Read a missing `turn` as
"not a completion" rather than "turn zero", and check `critiqueRole` before assuming a row describes a
run.

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
cowork-harness stats --metric cost --last 20        # last 20 runs per group, cost view only
cowork-harness stats csv-metrics --group-by skill-hash   # one row per skill generation
cowork-harness stats csv-metrics --runs                   # + the individual runs behind each summary
```

Default output is a per-scenario summary line: run count, pass rate, cost/duration p50 & p95, the group's
**`total=` spend** (roll-ups included — see the table above; appended after the cost percentiles, and
followed by `(N unpriced)` when some row lacked cost telemetry), and the
most recent **passing** run's timestamp (`lastGreenTs` — absent if the scenario has never passed). Each
summary also carries `distinctSkillHashes` (how many skill generations the window folded together — see
*Grouping by generation*) and `distinctTiers`/`tiers` (how many effective fidelity tiers — see *Grouping
by tier* below; unlike `distinctSkillHashes`, this key is total so there is no companion counter for rows
it couldn't see), and the envelope carries `hashlessRuns` alongside `stats`.
`--metric pass-rate|cost|tokens|duration|turns|cache-tokens|model-cost` narrows the line to just that one
view (`cache-tokens` shows cache-read-token p50/p95; `model-cost` shows per-model cost p50/p95, distinct
from the plain `cost` metric's overall run cost). `--last <n>`
windows to the N most recent runs **per group** (not globally — a global cut would starve a
low-frequency scenario out of the window entirely once a high-frequency one dominates recent rows). A
group is a scenario unless `--group-by` says otherwise; see *Grouping by generation* below.

`--metric` is a text-mode-only view narrower — `--output-format json` always returns every field for every
scenario regardless of `--metric`, the same convention `--quiet`/`--verbose` already follow elsewhere in
this CLI (machine output stays fully populated; only the human-readable render narrows). A JSON consumer
that only wants cost data filters client-side (`jq '.stats[].p50CostUsd'`) rather than losing the other
fields to a server-side narrowing it didn't ask for.

## Grouping by generation (the iterate-across-fixes loop)

> These recipes are step 5 of the loop in [debugging.md](./debugging.md#the-whole-loop-end-to-end) — the
> comparison step. What you pair is usually a [`critique`](./critique.md) finding set against the runs
> that produced it.

`stats` groups **by scenario** by default, and aggregating a window that spans two skill versions
compares unlike things. Two flags query the run-identity fields directly:

```bash
cowork-harness stats my-scenario --group-by skill-hash   # one row per generation (for a controlled A/B, see eval.md)
cowork-harness stats my-scenario --skill-hash 8fc999c77cdf   # or narrow to one generation
cowork-harness stats my-scenario --label gen-2               # …by the human tag instead
```

`--runs` additionally lists the runs behind each summary — timestamp, verdict, `runId`, `skillHash`,
`runLabel`, `fidelity` (the tier the run actually ran at — `effectiveFidelity ?? fidelity`, total by
construction so it's never conditionally omitted the way `skillHash`/`runLabel` are), cost, duration, and
`(pruned)` when the evidence is gone from disk — so you can see which generation a given run belonged to
without opening its `result.json`. It selects **exactly** the rows the summary above it aggregated (same
filter path), and adds a `runs` array to the JSON envelope; without the flag that key is absent. `fidelity`
is JSON-only — the text-mode run line (`formatRunLine`) is unchanged.

An [`eval`](./eval.md)'s runs are indexed like any `run`, labelled `eval:<eval-id>:<arm>`, so `stats
<scenario>` pools both of its arms; separate them with `--group-by label` (or `skill-hash`). For a
before/after verdict, read the eval's own report rather than these rows.

`--group-by` accepts `scenario` (default) | `skill-hash` | `label` | `fidelity`. When a window you did NOT
narrow spans more than one generation, `stats` says so on stderr (`::warning:: … spans N skill
generations`) and reports `distinctSkillHashes` in the JSON envelope, so CI can gate on the field rather
than scraped text.
`--last <n>` windows per **group**, so `--group-by skill-hash --last 5` means "the last 5 runs of each
generation".

The two identity fields, on the row and in the summary:

- **`skillHash`** — the correctness key. Content-exact; changes on any tracked edit. **Stored as a 12-char
  prefix** on the index row (the full hash is in each run's `result.json`). `--skill-hash` matches either
  form — it compares prefix-tolerantly in both directions — with a 6-character floor, below which a
  "prefix" would pair unrelated generations.
- **`runLabel`** — the `--label <tag>` you passed. Human-readable and orderable; ergonomics, not identity.

A row that has no value for the field you grouped on (a `chat` row, a run that mounted no skill, a
pre-1.5.0 skill-lane row) is **excluded and counted**, never bucketed under a blank key — `stats` reports
`N run(s) excluded from grouping`, and the JSON envelope carries `hashlessRuns`.

**One blind spot, stated plainly:** `distinctSkillHashes` counts only runs that *recorded* a hash, so a
window mixing one generation with hashless runs is also comparing unlike things and the warning cannot
see it. `hashlessRuns` is reported only when you group, so on a default `stats <scenario>` those rows are
folded in silently. If a scenario's history mixes `chat`/no-skill runs with real ones, group explicitly.

### Grouping by tier (the environment axis)

`container` and `hostloop` runs of one scenario differ in pass rate, cost, and duration — averaging
them is the same unlike-things mistake as averaging skill generations. Each summary carries
`distinctTiers` and `tiers` (computed over `effectiveFidelity ?? fidelity` — what actually **ran**,
so a `--fidelity cowork` run counts as the tier the gate resolved it to). When a window spans more
than one tier, `stats` says so on stderr (`::warning:: … spans N fidelity tiers (…)`) and the remedy
is `--group-by fidelity`, which splits per tier (`fidelity=container` / `fidelity=hostloop` on each
line) and splits `totalUsd` with it — per-tier cost in one command. Unlike generation grouping,
every row has a tier, so nothing is ever excluded from this grouping and there is no
`hashlessRuns`-style counter for it. The generation warning and the tier warning fire
independently: a window mixing both axes is unlike-vs-unlike twice over, and each warning names a
different remedy.

**The `jq` recipes below are still worth knowing** — they cover what the flags deliberately do not.
`stats` reports cost *percentiles* over aggregatable rows only, so a per-generation **total spend** that
includes critique's evaluator passes still needs the recipe (see the `critiqueRole` note in it).

```bash
IDX=~/.cowork-harness/runs/index.jsonl

# pass-rate and cost per generation, newest first.
# NOTE the two `critiqueRole` clauses. This recipe reads RAW rows, so the exclusion `stats` applies
# internally does not protect it: a critique roll-up carries the graded `skillHash` and `pass:true`, so
# leaving it in adds a phantom run to every bucket and drags passRate toward 1. Cost is the opposite —
# the roll-up's costUsd is the evaluator passes the turn rows do NOT carry, so the sum WANTS it.
jq -s 'map(select(.skillHash)) | group_by(.skillHash) | map({
    skillHash: .[0].skillHash, label: .[0].runLabel,
    runs: (map(select(.critiqueRole != "rollup")) | length),
    passRate: ((map(select(.critiqueRole != "rollup" and .pass)) | length)
               / (map(select(.critiqueRole != "rollup")) | length)),
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
it by walking every run dir on disk — `<runsRoot>/<slug>/<runId>/turns/<N>/result.json` for each turn (no
root compat copy exists to double-count against), or the root `result.json` for a genuinely pre-layout
dir written before the `turns/<N>/` layout existed — then merging in any rows
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
field existed), then to deriving from `RunResult.mode`. Deriving `command` from `mode`
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
