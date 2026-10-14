# `eval` — paired A/B evaluation of a skill edit (EXPERIMENTAL)

`eval` answers one question: **did this edit to my skill change how often each claim passes?** It runs
every scenario with each of two versions of your plugin, interleaved, and compares the per-claim pass
rates with an exact test.

```bash
cowork-harness eval evals/scenarios/ \
  --arm before=git:HEAD:plugins/my-skill \
  --arm after=./plugins/my-skill \
  --model claude-sonnet-5 --judge-model claude-opus-4-8
```

The report lands in `~/.cowork-harness/evals/<eval-id>/report.md` (or `--out <dir>`), and
`cowork-harness eval report <eval-dir>` rebuilds it from that directory at no cost.

**A drop is a signal to investigate, not proof.** Read the run dirs the report links before acting on
it.

## Cost and prerequisites

- **Live only.** Every rep is a real agent run; `eval` never replays a cassette.
- **Runs.** scenarios × 2 arms × `--reps` — 10 runs per scenario at the default `--reps 5` — plus one
  judge call per `semantic_matches` assert per run. `--dry-run` prices the schedule from history before
  you spend anything ([Planning before you spend](#planning-before-you-spend---dry-run)), and
  `--max-budget-usd <x>` refuses the eval before its first run when history says it would cost more than x.
  Both read the agent's cost only: judge and LLM-decider spend are not counted, as on every other command.
- **Tier.** Each scenario runs at its own `fidelity:`, with that tier's prerequisites (Docker and the
  agent image for `container`, and so on) — check them with `cowork-harness doctor --tier <tier>`. The
  agent credential is checked for you: see [What it holds fixed](#what-it-holds-fixed-refused-before-any-run-exit-2).
- **Run an A/A first.** `eval` with the same source as both arms (`--allow-identical-arms`) shows how
  far your scenarios' rates move when nothing changed. Read that before trusting a before/after.

### Cutting the cost per rep

Every rep re-runs the whole scenario, so a case that tests the last step of a long pipeline pays for every step
before it on every rep. Start such a case from a workspace fixture instead: a directory whose files are copied into
the session's `outputs/` before turn 1, so the prompt asks for the late step alone
([Starting from a saved workspace](./scenario.md#starting-from-a-saved-workspace-workspace_fixture)).

- **Make one from a kept run.** `cowork-harness fixture export <run-dir> --out <dir>`, then point the case's
  `workspace_fixture:` at `<dir>` and commit both ([fixture export](./cli.md#exporting-a-runs-outputs-as-a-fixture-fixture-export)).
  Add `--session-paths` when the skill reads back paths it recorded (an outputs-dir probe, a sub-agent's output
  path). `--exclude <path>` leaves out a file the step re-creates, such as a probe the skill re-runs.
- **Limits.** A fixture with session-path tokens is refused on the `protocol` tier, and `--session-paths` refuses a
  protocol run. Binary files are never rewritten; one that holds a token is refused. Any other host path in a text
  file is still refused (`--allow-host-paths` accepts an ordinary one, never a path into a run dir).
- **What the case then measures.** Only the steps after the fixture. An untouched fixture file is pre-run, not
  authored, so a judge grades only what this step wrote, and the conversation starts fresh. The earlier steps are no
  longer exercised: keep a full-pipeline case for them.

## Planning before you spend (`--dry-run`)

`eval … --dry-run` makes every check the real eval makes before its first run, then prints a plan and exits
0. It runs no agent, builds no `--decider-cmd`/`--decider-dir` channel, and creates no eval dir: the arm
snapshots it needs for the checks go to a temp dir that is removed afterwards. (The credential check still
runs, as on `record --dry-run`; it may run the `security` Keychain probe or a container runtime's
`--version`. So does the host-`claude` isolation check when a scenario calls the judge or the LLM decider: it
runs `claude --help` / `--version`, and a host `claude` that is missing, or too old to run them isolated, refuses the dry
run as it refuses the eval.) A refusal is the real eval's refusal, with the same message and exit code, so a clean dry run
is never refused for real on anything it could have checked. One refusal is the dry run's own: its temp dir
must be outside any git work tree, for the same reason the eval dir must (the snapshots would hash as empty),
so a TMPDIR inside one, or one git cannot answer for, exits 3 — set TMPDIR to a directory outside any git
work tree. The plan is the dry run's
output: `--quiet` does not mute the plan, only the per-arm progress lines before it. A section that declares
metrics also gets a line for its metric family (its size, rule and `confirmed` reach; `plan.sections.*.metricFamily`);
metric rows are not planned, since no rate history describes them.

```
cowork-harness eval evals/ --arm before=./skill --arm after=../skill-edit --dry-run --target-effect 30pp
```

Everything comes from the runs dir's history of each scenario (`~/.cowork-harness/runs`, or `--run-dir`):

- **Cost at `--reps`.** p50, mean, p95 and worst observed, each per scenario × its 2 × `--reps` runs, summed
  over the scenarios that have priced history. The history is the scenario's runs on the tier it will run at
  (`cowork` resolved to its concrete tier) and on its baseline, first turns only, with `hillclimb:`-labelled
  runs left out. `stats <name> --baseline <b> --group-by fidelity` prints the same per-run figures for that
  tier, except that it counts resumed turns and hillclimb runs; the plan names both counts when they are
  non-zero. p95 is the most expensive run when a scenario has 20 or fewer; neither p95 nor the worst-observed
  sum is a bound. A scenario with no priced run contributes $0 and makes the total a **LOWER BOUND** — on a
  fresh `--run-dir`, every scenario. History is arm-agnostic: arm B's cost may differ from arm A's past runs.
  The judge's spend is printed beside it, and is not covered by `--max-budget-usd`.
- **Each row's rate.** Each kept run's `result.json` is re-scored by the eval's own classifier — an
  infrastructure failure is left out, an agent error scores 0 on every row, a run graded against a different
  assertion is left out for that row only. Only runs on the eval's agent model count, and a claim row only
  counts runs graded by the eval's judge model for that assertion. The newest 50 qualifying runs per scenario
  are used. When 5 or more of them ran arm A's exact content (its content signature), the rate comes from
  those, with the config-matched rate shown beside it; otherwise from all of them, with the exact-content
  count printed. After an edit, with an `--include-untracked` arm, history recorded under
  `COWORK_HARNESS_GITSET=0`, or a session that declares a different set of skill dirs, no run matches arm A's
  content, by design. A rate from fewer than 5 runs is labelled THIN, and every rate carries its 95% interval.
  A row with no usable history is `unknown`: the plan then shows only the best case (the smallest change any
  rate allows at `--reps`). The index's pass/fail verdicts are shown as context only; no row rate is drawn
  from them.
- **What `--reps` can detect.** Per row, the minimum detectable drop and rise at `--reps` — the same figure
  the report prints, at the historical rate and across its interval. *Detectable* means an observed difference
  this large reaches p ≤ `--alpha`; at the smallest such N a true difference of that size is observed that
  large typically only about 60% of the time. That is why every N also carries its **power**.
- **`--target-effect <pp>`** (percentage points, `30pp` or `30`, 1 to 100; dry run only). Per row and
  direction: the smallest N at which that change is detectable at `possible` and, for a single row, at
  `confirmed`; the smallest N with 80% power (`nForPower80`); the power at `--reps`; and the cost of the eval at
  each N, for that scenario and for the whole eval. Neither detectability nor power is monotone in N, so each
  N comes with the N from which it holds at every larger N. With a historical valid-rep fraction below 1, the
  plan also says how many reps to schedule for N valid ones. A row at 100% cannot show a rise at its point
  estimate; the plan then shows what the target would need if the true rate were the interval's lower end.
- **Sequential preview.** A look at every complete ABBA block — the most looks, so the most conservative
  per-look level — with alpha split evenly across the looks and Holm within a look: the first look at which a
  single row could reach `confirmed`. `--sequential` is not implemented; this previews its planned design and
  may change with it. The fixed design the eval runs today is printed beside it.

`--output-format json` prints `{tool, version, command:"eval", ok:true, dryRun:true, plan, budget?, error:null}`.
`plan.cost`'s summary keys — `jobs`, `meanUsd`, `p50Usd`, `p95Usd`, `worstObservedUsd`, `lowerBound`,
`unpriced`, `pricedRuns`, `thinnest` — are a covered surface ([schema/schedule-cost.json](../schema/schedule-cost.json));
everything else in `plan` is experimental (`schemaVersion: 0`).

### `--max-budget-usd`

`--max-budget-usd <x>` works with and without `--dry-run`. It sums, over the scenarios, each scenario's most
expensive prior run times its 2 × `--reps` runs, and refuses before any run when that exceeds x (exit 2,
`error.code: "budget_exceeded"`, with the `budget` marker and the plan on the error envelope). It is the
`record` batch gate's rule, and it reads that gate's basis — any tier, baseline or turn of the scenario's
name, hillclimb runs included — which is wider than the plan's `worstObservedUsd`; the plan prints it as the
budget-gate basis. A real eval with a cap reads the run index only (never the kept `result.json` files), so the
plan its refusal carries is cost-only (`plan.costOnly: true`, every row `unknown`). A cap
equal to the estimate passes. With no priced history the check is against a lower bound, and the `budget`
marker says so (`enforced: "lower_bound"`). It is a pre-flight only: the eval is never stopped mid-way.

## What it compares

- **Arms.** Exactly two `--arm [<label>=]<source>` values. The **first is A, the baseline**; a *drop*
  means B passes less often than A. A `<source>` is a plugin directory, or `git:<ref>:<path>` — a
  directory as committed at `<ref>`, with `<path>` relative to the root of the repository that contains
  your current directory.
- **What is substituted.** Only `plugins.local_plugins`, and every scenario's session must declare
  exactly one entry, pointing at the same directory and ending in the same directory name. Each arm's
  plugin is mounted in its place. Skills declared any other way (`skills.local`, marketplaces) stay as the
  session declares them, in both arms.
- **Scenarios.** A file, or every `*.yaml` in a directory. In a directory, a YAML file with no `prompt:`
  (the session file most suites keep beside their scenarios, such as `_session.yaml`) is skipped, with a
  notice.
- **Snapshots.** Each arm is copied once, before any run, into `<eval-dir>/arms/<label>/`. Every rep
  mounts the copy, so editing the source while the eval runs has no effect. A directory arm in a git
  work tree contributes its **git-tracked** files — what the stager would deliver — and the report
  header counts the untracked files it left out; `--include-untracked` copies everything instead
  (refused for a `git:` arm). A `git:` arm is extracted file by file from the commit, so a file marked
  `export-ignore` is still included. Symlinks are copied as links, unchanged, in both kinds of arm.
- **The runs look like any other run.** Each job's run id — which becomes the agent's working
  directory — has the ordinary `local_…` shape and is derived from a hash, so it names neither the eval
  nor the arm. Both arms see the same system prompt apart from that id.
- **Rows.** Every assertion of every scenario is a row, except one whose only keys are verdict modifiers
  (`allow_stall`, `allow_outputs_delete`, and the other `allow_*` keys): it always grades `pass`, so it could
  not detect a change and would only enlarge the correction family. An assertion that combines a modifier with
  another key (`{result: success, allow_stall: true}`) is a row. Each `semantic_matches` rubric claim is its own
  row; the assertion's own pass (a function of its claims through `min_pass`) is shown as a *derived*
  row. A `semantic_pairwise` assertion is one row, its pass under `pass_if` (so `pass_if: any` gives a row that
  is always 1 when graded). Both arms are judged against the same frozen references; eval reports the pass rate,
  not a win-rate distribution, and never compares arm A's output with arm B's directly. A reference that cannot be
  read counts as a refusal, never a fail, and a missing one refuses the whole eval before any run.
- **Units.** Each rep is one run, graded once ("runs × grades").
- **Metrics.** Each number a scenario declares under `metrics:` is a *metric row*, compared between the arms with an
  exact rank test in its own correction family; see [Metric rows](#metric-rows). Every other row is a pass or a fail
  per rep, and `eval` compares how often each arm passes.

## Flags

- `--reps <n>` — reps per arm per scenario, default 5. Below 4 is refused unless `--allow-underpowered`
  (which accepts 2 or 3; rows whose exact test cannot reach `--alpha` are then labelled `underpowered`).
- `--concurrency <n>` — jobs in flight, default 2, 1 to 8. It must be 1 with `--decider-cmd` or
  `--decider-dir`, whose channel is shared by every job.
- `--alpha`, `--correction bh|holm` — see the labels below. `bh` uses a fixed q = 0.10. Pass rows default to `bh`.
  Metric rows default to Holm at `--alpha` split across the section's families (0.025 beside pass rows); an
  explicit `--correction bh` grades them with BH at q = 0.10, unsplit ([Metric rows](#metric-rows)).
- `--holdout <scenario.yaml>` — repeatable; see [Picking scenarios](#picking-scenarios).
- `--skill <name>` — the skill whose invocation each rep records. A plugin with one skill (or a root
  `SKILL.md`) needs none; for a plugin with several skills, name one. Without a single skill, the
  per-rep invocation fact is `unobservable`; it never affects a row.
- `--on-unanswered fail|first`, `--decider-cmd`, `--decider-dir` — how unscripted questions are answered,
  as on `run`.
- `--fail-on possible|confirmed` — opt in to gating (see [Exit codes](#exit-codes)).
- `--dry-run` — print the plan and exit; see [Planning before you spend](#planning-before-you-spend---dry-run).
- `--target-effect <pp>` — with `--dry-run`, the change to size N for, in percentage points.
- `--max-budget-usd <x>` — refuse before any run when history says the eval would cost more than x; see
  [`--max-budget-usd`](#--max-budget-usd).
- `--search-corpus <pool>` — serve both arms' web searches from one recorded pool, hostloop only; see
  [A frozen search corpus](#a-frozen-search-corpus---search-corpus). `--search-corpus-miss empty|error` and
  `--search-corpus-min-score <n>` work as on `run`.
- `--allow-confounded-pool` — run a pool whose records come from one arm (or whose split cannot be bounded); every
  surface then says CONFOUNDED.
- `--allow-mixed-pool` — accept a pool built with `search-pool build --mixed` (several skills).
- `--output-format json` — the envelope
  `{tool, version, command:"eval", ok, evalDir, arms, pins, sections, summary, cost, stoppedEarly, error}`
  (plus `searchCorpus` with `--search-corpus`), with `ok` true exactly when the exit code is 0.

## How to read the report

Each row leads with B − A and a 95% Newcombe interval, then a two-sided Fisher exact p, then a label:

| Label | Meaning |
|---|---|
| `confirmed drop` / `confirmed rise` | significant after the correction (`bh` at q = 0.10, or `holm` at `--alpha`) and at `--alpha` itself |
| `possible drop` / `possible rise` | p ≤ `--alpha` (default 0.05), not confirmed |
| `no detectable change` | anything else; the row shows the smallest change this n could have detected (MDD), or `none at this n` |
| `underpowered` | no outcome at this row's sizes could reach `--alpha`; never read this as "no change" |
| `insufficient` | an arm has too few valid reps (4 at the default `--reps 5`, so one lost rep per arm is tolerated) |
| `insufficient_refusals` | `insufficient`, where the candidate refused at least 2 more `semantic_matches` grades for unavailable evidence than the baseline and that excess took the row below the threshold; a drop signal that `--fail-on possible` gates on ([below](#when-the-candidate-refuses-more)) |

When the interval excludes 0 but the exact test cannot flag the row, the row says so rather than
printing two verdicts.

The header states what every number depends on:

- **the attainable p floor** at this `--reps` and how many rows `confirmed` needs. At `--reps 5` a
  single row going from 5/5 to 0/5 has p = 0.0079: it is always `possible`, but under `bh` with 13 or more
  rows it cannot be `confirmed` on its own;
- **the ceiling line**: rows at 100% in both arms, where an improvement is undetectable (and rows at 0%,
  where a drop is);
- **per arm**: each rep's bucket, an `errorSource` histogram, and a loud **UNCLASSIFIED** count for any
  termination the classifier does not recognise (excluded — read those run dirs);
- **per arm, the `semantic_matches` grades refused for unavailable evidence**, by reason
  (`report.json`: `arms[].evidenceUnavailable`). A refusal is neither a pass nor a fail, so it leaves that
  assertion's rows for that rep; an arm that refuses more often is producing evidence the judge cannot see
  whole (a deliverable that outgrew the capture budget, say), and this count is where that shows;
- **every (arm, scenario) in which every rep errored**, named with its most frequent bucket and rule —
  for example `errored_infra (auth) 5/5` — and a hint that follows the rule (sign-in, quota, start-up,
  network, decider, or read the run dirs). Whether that scenario's rows were compared is stated on the
  line (see [below](#when-every-rep-errored)); `report.json` lists these under `summary.erroredArms`;
- **per arm, the metric values** ranked worst (by cause) and, loudly, those excluded (by reason) or that broke the
  comparison (`report.json`: `arms[].metricStates`; see [Metric rows](#metric-rows));
- per-arm medians of cost, judge cost, turns and duration (descriptive, no test);
- "no control arm: prior-answerable claims are not flagged".

The correction family is every claim row and every non-semantic assertion row of a section. The
semantic roll-up rows and the two classification rows (the errored-by-agent rate and the invocation
rate) are shown separately and never reach `confirmed`. `report.json` lists every rep with the bucket
it landed in.

### What happens to a rep that went wrong

| Rep | Counted as |
|---|---|
| ran to completion | valid |
| infrastructure: a spawn or protocol failure, a transport error, a usage limit (the main loop's, or a sub-agent's — even on a rep that otherwise timed out or hit `error_max_turns`; not on a rep that then stopped at an unanswered question, which counts as the agent's), a decider timeout | excluded, reported |
| the agent could not authenticate: its reply is `Not logged in · Please run /login` or `Authentication required · Sign in again to continue` | excluded as infrastructure, reported (rule `auth`) |
| a usage or spend limit reported as the agent's final message (`You've hit your … limit`, out of usage credits, …) — including on a nonzero exit, and after a model has already spent | excluded as infrastructure, reported (rule `usage_limit`) |
| no model answered: every model the run reported is the agent's own `<synthetic>` marker and it cost $0 | excluded as infrastructure, reported (rule `no_model_answered`) |
| a run under `answer_channel: none` that ended on a question | counted as a run that completed (rule `parked_at_question`): its assertions are graded, and the pin and judge rows still apply |
| a stalled question in a scenario that asserts `allow_stall: true` | counted as a run that completed (rule `stall_allowed`): its assertions are graded, and the pin and judge rows still apply |
| the agent's own failure: a timeout, `error_max_turns`, a stalled or unanswered question, a crash | **fails every row** (it still counts) |
| the pin did not hold (`modelPinHonored` false, or unknown on a rep that otherwise completed), the snapshot changed under it, or a grade came from another judge prompt | excluded, reported |
| with `--search-corpus`: not served from the pinned pool — refused before it ran because the eval's copy changed, served from another pool or miss mode, or (under the pin) with no frozen corpus at all | excluded as infrastructure, counted and named (`search_pool_mismatch`); any such rep makes the eval exit 1. It outranks every other bucket, but keeps its termination rule (a usage limit beside it still shows as one) |
| with `--search-corpus`: a search the corpus refused (`searchCorpus.metrics.refused > 0`) | excluded as infrastructure, counted and named (`search_refused`): that arm worked from different evidence. It outranks the agent's own failure, because a refused search hands the agent an error |
| one assertion's judge output was invalid | only that assertion's rows lose the rep |
| one `semantic_matches` assertion refused for unavailable evidence (its `semanticEvidence` reason is not `graded`) | only that assertion's rows lose the rep — the roll-up and every claim — and it is counted per arm, by reason |

An eval dir whose `runs.jsonl` was written before the refusal reason was kept in it carries no reason.
`eval report` then recognises a refusal only where the kept fields prove one — a lone `semantic_matches`
assertion that failed although its claims met `min_pass` (counted as `unrecorded`); a refusal whose
claims also missed `min_pass` cannot be told from a graded fail and is scored as one.

A **stalled** rep is one whose run the `stalled` verdict signal would flag: the agent ended asking for input
(a closing `?`, or, after an `AskUserQuestion` gate, a closing request such as "Please share X so I can…")
with no tool work after its last gate. `eval` applies the same opt-out as `run` and `replay`: in a scenario
that asserts `allow_stall: true` (its intended terminal state is a question), a stalled rep's assertions
are graded like those of any completed run. Without it, the stall is the agent's failure: the rep is
`errored_agent` and fails every row. The request test is English-only — see the `stalled` row in the
companion skill's `references/assertion-catalog.md`.

The `auth` and `usage_limit` rows need the reply to come from the agent itself, which writes it as a
`<synthetic>` turn. A skill's own message that merely reads like one ("You've reached your daily limit
of 5 files") is the skill's failure and is scored.

The rows are checked in that order, and the first that matches decides. Two consequences:

- **An agent failure outranks a pin exclusion.** A rep that crashed fails every row even when its pin is
  unknown — a crash before the first model reply leaves no model evidence, and excluding it would hide a
  skill that breaks on its first turn. So "unknown" excludes only a rep that ran to completion.
- **A pin that is unknown because no model answered is infrastructure**, not the agent's failure and not
  a pin exclusion. "No model answered" needs positive evidence — a `<synthetic>`-only model list *and* $0
  spent, or the agent's authentication text; a run that recorded no model at all is still the agent's. A
  successful run whose model list is `<synthetic>`-only (a prompt that starts with `/plugin:skill`) is not
  affected by this rule.

## Metric rows

A scenario's `metrics:` ([Numeric metrics](./scenario.md)) each become one row per scenario: the same id in two
scenarios gives two rows. The row compares the two arms' per-rep numbers. A scenario may declare metrics and no
`assert:` at all; an eval is refused only when it has neither a compared assertion nor a metric.

**The test** is the exact two-sided Wilcoxon–Mann–Whitney rank-sum test. It is exact with ties (it conditions on
them), it needs no assumption about the metric's distribution, and a monotone rescale (a log, a square) changes
nothing, so a skewed count or cost costs nothing. Its direction is read through the metric's `better`: a row is
`worse` or `better`, never "drop" or "rise", so a cost metric that fell reads as `better`. The row also carries the
raw `numericDirection` (`up` / `down`). Beside it: each arm's median and n, the Hodges–Lehmann shift (the median of
every B − A difference) with its distribution-free interval and that interval's **achieved coverage** (96.8% at
5 v 5, 90.0% at 3 v 3 — never assume 95%), each arm's SD, the pooled SD with its 95% interval, and the minimum
detectable shift (MDS).

**What it can detect.** The floor (the smallest p any outcome can give) is 0.10 at 3 v 3 (so every metric row is
`underpowered` at `--reps 3`), 0.0286 at 4 v 4, 0.0079 at 5 v 5 and 0.0022 at 6 v 6. At unequal arms it is higher
than a pass row's (0.0571 at 3 v 4, 0.0159 at 4 v 5): a metric row is never easier to flag than a pass row. At
`--reps 4` one lost rep (3 v 4) leaves a metric row `underpowered` while the same scenario's pass rows still test, so
use `--reps 5` for metrics. Ties raise the floor; a metric whose every value is equal is `underpowered` ("every
value tied"), never `no detectable change`. **At 5 reps a metric row reliably (80% power) flags only a shift of about
2.4 SD** — near-complete separation of the two arms; 6 reps bring it to 2.0 SD. That is the price of an exact test
at n = 5: any test that claims more there does it by giving up its false-positive rate. The row's `mds` field turns
it into the metric's own units (`2.4 SD ≈ 7.1 [4.8–13.6]`, the range from the SD's own interval); the SD figures are
estimates from an offline table (n = 4 to 6 only).

**A rep whose number is missing** falls into one of three classes:

| Rep / metric state | Counted as |
|---|---|
| a measured value | ranked by value |
| the agent failed (`errored_agent`: timeout, max turns, crash, an unanswered gate) | **worst rank**, whatever the metric |
| `missing_artifact`, `missing_path`, `not_json`, `not_a_number`, `pre_run` (the skill did not produce the number) | **worst rank** |
| `size`, `readonly`, `remote`, and a command metric's `command_failed`, `command_timeout`, `command_output`, `nondeterministic` and `no_events` — the scorer, the capture or a cap, not the skill | **excluded**, counted per arm, and guarded (below) |
| `pruned`, `no_manifest`, a completed rep with no entry for the id (`metric_unrecorded`), and a command metric's `command_changed` (the rep was scored by another script than the one the manifest froze), `command_missing` and `command_not_allowed` — the comparison itself is broken | the row is **`not compared`**: out of the family, never gates, and the eval exits 1 |
| infrastructure, drift, pin and judge-prompt mismatches, a refused search, a frozen-pool mismatch | excluded, as on every row |

A worst-ranked rep ranks strictly below every measured value, including a value at a bounded metric's own worst
bound, and ties only with other worst-ranked reps: "did not produce the number" is not "produced the worst number".
Like the 0 a failed rep scores on pass rows (intention to treat), this keeps the test exact, and it makes a metric row
a sharp crash detector: with the metric unchanged and B failing in 2 or 3 of its 5 reps, the row can flag `worse`
where no pass row can (P(`possible worse`) = 7.1% at 2 failed reps, 28.6% at 3; a pass row at 5/5 vs 3/5 or 2/5 has
p 0.44 / 0.17). Every `worse` row says how many of each arm's reps were worst-ranked and why. The mirror blind spot:
a flaky baseline (A failing) pulls a real B regression toward `no detectable change`, as it does for a pass row.

**No verdict rests on an excluded rep.** An excluded rep's number is unknown, so the row's p is the larger of the
p over the remaining reps and the p of an *adversarial completion* that places the excluded reps where they would
hurt the observed direction most. A scorer failure can therefore neither manufacture nor hide a direction, and never
fires `--fail-on`. When the remaining reps alone reach `--alpha` but the guarded p does not, the row is **`unresolved`**
(it shows the unguarded p, never gates, and stays in the family). When the candidate's ≥ 2 extra excluded reps took a
row below the rep threshold, it is **`insufficient_unmeasured`**, a worse-signal `--fail-on possible` gates on — the
analogue of [`insufficient_refusals`](#when-the-candidate-refuses-more). A candidate whose scorer fails exactly on its
bad runs still hides a regression behind `unresolved`; the loud per-arm count of excluded values is the signal.

**The correction.** Each section has up to two families: its pass rows, graded exactly as before (`bh` at q = 0.10
by default, or `holm` at `--alpha`, never split), and its metric rows. By default the metric family is Holm at
`--alpha` divided by the number of families with a row in the section: 0.025 beside pass rows, 0.05 in a
metrics-only section. Under an explicit `--correction bh` it is BH at q = 0.10, unsplit; under an explicit `holm`,
Holm split as by default. `confirmed` also needs p ≤ `--alpha`. At 5 reps a metric row can be `confirmed` beside pass
rows only when the section declares 3 metrics or fewer; 4 to 11 need `--reps 6`, and `--reps 4` never confirms a
metric beside pass rows. Every report states, per section and family, the correction, its row count and the chance
an A/A eval would `confirm` at least one of its rows: exact for a Holm metric family (assuming no ties; ties only
lower it), at the observed rates for a Holm pass family, and the bound alone under BH. At 5 v 5, three metric rows
beside pass rows: 2.4%. A line also says when `confirmed` adds no evidence over `possible` in a family at these reps.

| Label | Meaning |
|---|---|
| `confirmed worse` / `confirmed better` | significant after the metric family's correction and at `--alpha` |
| `possible worse` / `possible better` | p ≤ `--alpha`, not confirmed |
| `no detectable change`, `underpowered`, `insufficient` | as for pass rows (the threshold counts measured and worst-ranked reps, not excluded ones) |
| `unresolved` | only the excluded reps' absence would make it significant; never gates |
| `insufficient_unmeasured` | the candidate's excess excluded reps took it below the threshold; `--fail-on possible` gates on it |
| `not compared` | a broken metric state on some rep; exit 1 |

**Gating.** `--fail-on possible` fails on `possible worse`, `confirmed worse` and `insufficient_unmeasured`;
`--fail-on confirmed` on `confirmed worse` only. A metric that got worse is the same signal as a pass-rate drop.
The gate acts on `worse` only, so its false-fail rate per null metric row is half the two-sided figure: 1.59% at
`--fail-on possible` (4.7% for three rows), and 0.79% at `--fail-on confirmed` for one metric beside pass rows.
`--fail-on confirmed` is refused before any run only when no family of any section can reach `confirmed`, and when
some family cannot, the eval says before spending which families the gate can fire on
(`report.json` `summary.confirmReach`).

**When a metric row is worth it.** Count metrics for a targeted defect fix (leak counts, warning codes, one kind
of red-team finding): a ×3.3 rate change is detectable (`possible`) at 5 reps, and ×4.1 confirms. Score-rule tuning
replays for free (`replay`, `regrade`); a metric at its ceiling has no headroom. For anything else, run an A/A
first and read the rows' `sd` and `mds`: if `MDS possible` in units is larger than the change you hope for, raise
`--reps` or make the metric discriminate.

An eval dir written before metrics were graded has no frozen declarations: its report says metrics were not recorded,
grades none, and its exit code is unchanged. Re-run the eval to grade them.

## What it holds fixed (refused before any run, exit 2)

- **The agent model** (`--model`, else the session's `model:`, else `COWORK_HARNESS_MODEL`) must be a
  concrete id — `opus`, `best` and the like are refused, because an alias can resolve differently between
  the arms.
- **The judge model**: `--judge-model <id>` grades every `semantic_matches` assert with one concrete
  model. Without it, every assert's `judge_model` and the default chain must be concrete. If the judge
  that actually answered still differs across reps, the eval exits 1.
- **The eval dir** must be outside every git work tree (including a gitignored directory inside one):
  the stager delivers a mount's git-tracked files only, so a snapshot inside a repository would mount
  empty. When git cannot answer for the directory, the eval is refused too.
- **Identical arms** are refused; `--allow-identical-arms` runs an A/A comparison.
- **The answer key.** An arm that contains one of the eval's scenario or session files, or a command
  metric's script or dep (by location —
  for a `git:` arm, the working-tree directory its path names — or as a byte-identical copy under any
  name, a symlink included), any `evals.json`, or any symlink that resolves outside the snapshot is
  refused: the agent could read the answers.
- **The scenarios' inputs**, as a run checks them, over each arm's snapshot: every input path, and a
  `tool_not_called` the scenario's tier can never violate.
- **The plugin under test** must be the session's one `plugins.local_plugins` entry; a session that
  declares it only under `remote_plugins` is refused (see [Lane note](#lane-note)).
- **`--fail-on confirmed`** when no row could reach `confirmed` at this `--reps` and correction.
- **The agent credential**, for every tier the scenarios run at, by the same check
  `cowork-harness doctor --tier <tier>` prints as its `token` row: a failing check refuses the eval with
  doctor's message and fix. A token in the environment or `.env` passes at every tier. Without one, a
  Claude Code login — in the macOS Keychain, or a `.credentials.json` in the config dir
  (`CLAUDE_CONFIG_DIR`, else `~/.claude`; only its existence is checked) — is enough only at `protocol`,
  which keeps your real config dir, so the agent signs itself in; doctor shows it as a warning. Every
  other tier gives the agent a managed config dir, and there it is refused. The check cannot see a token that is present but expired — a rep
  that then fails to authenticate is excluded as infrastructure (above).

- **A frozen search corpus** (`--search-corpus`): the pool must load and verify; a mixed pool needs
  `--allow-mixed-pool`; each arm × scenario must pass the checks a `run --search-corpus` makes (hostloop, the
  credential from the environment, the agent's search anchors); and a pool whose records come from one arm is
  refused unless `--allow-confounded-pool` ([below](#a-frozen-search-corpus---search-corpus)).

A refused eval leaves nothing in its eval dir.

## A frozen search corpus (`--search-corpus`)

`--search-corpus <pool>` serves every web search of both arms from one pool built with `search-pool build`,
instead of searching live. Both arms then see the same recorded results, so the web's day-to-day variance drops
out of the comparison.

**It holds search fixed, so it cannot evaluate a change to what or when the skill searches.** A new query gets a
miss or a nearby record, and a pool built from the old version makes any rewording read as a regression. Evaluate a
search change live (no corpus, more reps). If you also want a frozen eval of the steps after search, split it: a
live eval of the search change, then a frozen eval with a pool built evenly from both versions' live runs.

- **The pool is pinned and copied.** Before the first run the pool is copied into `<eval-dir>/search-pool/`, and its
  hash (with `--search-corpus-min-score`, if given) and miss mode are pinned in the manifest. Every rep is served
  from the copy and checks it against the pin before it starts; a rep whose copy does not match is refused before
  it spends, and lands in `search_pool_mismatch` (above). Any such rep makes the eval exit 1, with the count in
  `summary.searchPoolMismatch`.
- **Where the pool's records came from** is checked before any spend, per scenario, against the two arms' skill
  content signatures (the value each run's `fingerprint.contentSig` records):
  - `disjoint` — no record from either arm (a third version's runs);
  - `balanced` — records from both arms, neither holding more than 60% of them;
  - `one-sided` — records from one arm only, or one holding more than 60% — **refused** unless
    `--allow-confounded-pool`, and then labelled `CONFOUNDED: pool drawn from <arm>` on every surface;
  - `unknown` — some records name no signature, or come from a scenario the eval does not compare (a signature
    folds in the scenario's skills scope and session, so another scenario's hash proves nothing): labelled
    CONFOUNDED, not refused. One unknown record never turns a one-sided pool into a runnable one.

  A record several runs produced is kept once, under its first run, so the pool records how many duplicates it
  dropped and the 60% test takes the worst case. A pool built or exported before 4.10 does not record that count:
  one that would read `balanced` is refused, because its split cannot be bounded. Rebuild it with
  `search-pool build`, or re-export it from a pool built by this harness; `--allow-confounded-pool` runs it as
  CONFOUNDED. Matching is by skill content as hashed under the scenario's session: build pools from runs of the
  same scenario and session, or a pool from your own arm can read as a third version.
- **Both arms' search metrics side by side.** The report prints, per arm and per scenario, the searches served and
  missed, the miss rate and the mean top score over each arm's scored reps, and how many reps a refused search
  excluded.
- **The asymmetry marker** says the two arms were served unequally by the same pool: a miss-rate gap above 0.10 or
  a mean-top-score ratio below 0.8 marks the comparison CONFOUNDED even for a `disjoint` or `balanced` pool. Both
  thresholds are **placeholders**: the kept runs could not separate a provenance bias from noise, so no value was
  derived from them. Below 11 served plus missed searches on either side the cell is "not judged" (one search would
  move the rate past the gap). At the default floor (0.40), with single-rep arms of at least 11 searches, it fired on
  0 of 7 same-version comparisons (1 of 7 at 0.45), served mostly from pools of 6 to 17 runs; its false-alarm rate at
  a real eval's operating point (several reps summed per arm) is unmeasured. Treat it as a rough guard. CONFOUNDED
  never changes the exit code; it is `summary.confounded` in `report.json`.
- **A judge on recorded searches.** Each arm's count of reps whose verdict carried `search_corpus_semantic_judge`
  (a `semantic_matches` or `semantic_pairwise` grade of a frozen run) is printed: a grade there is not evidence of
  research quality.
- `eval --dry-run` copies and verifies the pool too (into its temp dir), so it refuses where the real eval would.
  Its cost and pass-rate history leaves frozen-corpus runs out: their searches were not billed and not live.

## Exit codes

- `0` — completed. Without `--fail-on` no drop fails the eval; read the report. (An all-`insufficient`
  result, a scenario that compared nothing, or a judge disagreement still exits 1 — see below.)
- `1` — with `--fail-on possible`, a `possible` or `confirmed` drop (the semantic roll-up rows count, the
  classification rows do not), an `insufficient_refusals` row ([below](#when-the-candidate-refuses-more)), or a
  metric row that is `possible worse`, `confirmed worse` or `insufficient_unmeasured`; with `--fail-on confirmed`, a
  `confirmed` drop or a `confirmed worse` metric only. Also, with or without it: every row `insufficient`, metric rows
  included (`insufficient_refusals` / `insufficient_unmeasured` rows do not count toward this), a scenario that
  compared nothing (below), a metric row `not compared`, the judge model differed across reps, or (with
  `--search-corpus`) any rep was not served from the pinned pool. An A/A run under `--fail-on possible` can exit 1 on noise alone.
- `2` — usage, or any refusal before the first run (the `--max-budget-usd` refusal included; with `--search-corpus`, a
  one-sided, mixed or unbounded pool, a pool that cannot be read, or a corpus check a run would fail).
- `3` — an arm snapshot or the pool copy could not be made, or failed its staging preflight.

Under `--dry-run`: `0` the plan was printed; `2` any refusal the real eval would make before its first run;
`3` as above, or the dry run's temp dir is inside a git work tree, or git cannot tell whether it is (set
TMPDIR); a git the operator's Ctrl-C killed exits `130` instead. Every dry-run refusal's JSON
error envelope carries `dryRun: true`, and `plan` when the refusal came after the plan was computed.

### When every rep errored

Judged per scenario, for each arm:

- **Every rep of both arms errored** (infrastructure or the agent's own failure, in any mix): 0 against 0
  is not a comparison. The scenario's rows get no reps, so they are `insufficient`, and the eval exits 1.
- **Every rep of one arm is infrastructure** — counting a refused search and a frozen-pool mismatch, in any mix:
  that arm never ran the skill on the evidence. Same outcome. The other exclusions (drift, pin, judge prompt) keep
  their rows `insufficient` without this exit.
- **Every rep of one arm is the agent's own failure, and the other arm has valid reps**: a skill that
  crashes every time is exactly the regression an eval should show, so the reps are scored (each fails
  every row) and the rows show the drop. The header still names the arm and its error. It exits 0 unless
  `--fail-on` is set, like any other drop.

### When the candidate refuses more

A `semantic_matches` grade refused for unavailable evidence leaves its assertion's rows, so a rate is over
the reps that were graded. That has a blind spot: an edit that makes the deliverable outgrow the evidence
budget makes the candidate refuse more, its rows lose reps, and a row that falls below the threshold would
be plain `insufficient` — no drop, while the edit broke exactly what the rows measure. Such a row is
labelled `insufficient_refusals` instead when the baseline had enough reps, the candidate refused at least 2
more grades than the baseline, and crediting back only that excess would have given it enough. (One extra
refusal, or a refusal beside a rep lost some other way, does not label a row.) It is a drop signal at the
`possible` level: `--fail-on possible` gates on it, `--fail-on confirmed` does not (nothing was tested, so
nothing is confirmed), and without `--fail-on` it does not change the exit code — the same as a `possible
drop`. A baseline that refuses more never labels a row.

Re-reporting an eval dir written before this label existed (`eval report <dir>`) can change its row labels,
and with `--fail-on` its exit code: refusals it can prove from the kept fields (the `unrecorded` case above)
now leave the rows, and may label one `insufficient_refusals`.

The header also warns, per assertion, whenever the two arms' refusals differ by 2 reps or more, or either
arm refused at least 20% of its scored reps, naming both counts (`summary.refusalImbalances` in
`report.json`). A roll-up row of an assertion with keys besides `semantic_matches` keeps a refused rep as
a fail — the grade keeps one pass for every key together, so dropping it could drop a sibling key's real
failure; only its claim rows lose the rep.

## Picking scenarios

- **Hold some out.** A scenario you tuned the skill against is weak evidence that the edit helps: you
  shaped the skill to it. Keep scenarios you did not look at while editing, and pass each with
  `--holdout <scenario.yaml>`. They are reported, and corrected, in their own section. `--holdout` may
  name every scenario; the report then has only the held-out section. Nothing is concluded about
  overfitting automatically; compare the two sections yourself.
- **Pick hard cases.** A scenario every version passes 5/5 sits at the ceiling and cannot show an
  improvement. Choose questions a person would find hard, where the skill's guidance is what makes the
  difference.
- **Write discriminating claims** — see Recipe 5 in the skill's `references/task-recipes.md`.

## Lane note

`eval` compares two versions of one plugin under the same conditions, but those conditions include where
the plugin is mounted, and that is not the same for every way Cowork delivers a plugin. `eval` swaps only
a `plugins.local_plugins` entry, mounted at `mnt/.local-plugins/marketplaces/<marketplace>/<plugin>`
(Cowork's local-uploads channel). A plugin installed through Cowork's UI is served from
`mnt/.remote-plugins/plugin_<id>` instead — `plugins.remote_plugins` in a session (see
[session.md](./session.md)). A skill that locates its own files at runtime sees a different path under
each, so a result for the `local_plugins` layout does not carry over to the installed one unless the skill
finds its files the same way under both.

A session that declares its plugin only under `plugins.remote_plugins` is refused (exit `2`: the session
must declare exactly one `plugins.local_plugins` entry). To compare such a plugin, point `eval` at a copy
of the session that declares the same directory under `local_plugins` instead, and check the skill's own
path handling separately with an ordinary `run` of the `remote_plugins` session.

Assertions about the environment itself — paths, `present_files`, what lands in `outputs/` — describe the
local lane.

## Files, and `prune`

`<eval-dir>/manifest.json` (everything fixed before the first run: arms, snapshot signatures, scenario and
session hashes, each scenario's assertions and metric declarations, pins, settings including the metric family's
correction), `arms/`, `runs.jsonl` (one line per finished job, with every field the report reads — each rep's
metric values included — and a `semantic_pairwise` grade's per-order outcomes under `order: both`, for reading position bias), `report.json` (`schemaVersion: 0`; each section's `metricRows`, `metricFamily` and `families`, and
`summary.metricLabels`, `metricsRecorded`, `families`, `confirmReach` and `notCompared`) and `report.md` (host paths
outside `$HOME` redacted, the count in the header). With `--search-corpus`, also `search-pool/` (the pinned copy every
rep was served from), the manifest's `pins.searchCorpus` and `searchCorpusProvenance` (`schemaVersion: 1`, so an
older harness refuses the dir rather than report it without its label), each `runs.jsonl` line's `searchCorpus`
counts, and `report.json`'s `searchCorpus` and `summary.searchPoolMismatch` / `summary.confounded`.

The runs themselves are ordinary run dirs under the runs root, labelled `eval:<eval-id>:<arm>`, so
`prune`'s `--keep-last` applies to them: at the defaults an eval leaves 10 runs per scenario and a bare
`prune` keeps the newest 5. `prune` names each eval that lost runs. The report's evidence links then
point at deleted runs, but `eval report` still rebuilds the report, because it reads only the eval dir.
Pass a larger `--keep-last`, or prune a different runs root, to keep an eval's runs.

`stats <scenario>` pools both arms of an eval (they are ordinary indexed runs); separate them with
`--group-by label`.

The report schema, the labels and the statistical defaults (`--reps`, `--alpha`, `--correction`,
`--concurrency`, the `insufficient` threshold) are experimental and may change in a minor release.
