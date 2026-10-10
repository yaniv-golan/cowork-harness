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
output: `--quiet` does not mute the plan, only the per-arm progress lines before it.

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
- **Pass rates only.** Every row is a pass or a fail per rep, and `eval` compares how often each arm passes. A
  scenario's `metrics:` are not graded or compared here; [`hillclimb`](./hillclimb.md#numbers-a-scenario-declares-metrics)
  is the loop that records and compares them.

## Flags

- `--reps <n>` — reps per arm per scenario, default 5. Below 4 is refused unless `--allow-underpowered`
  (which accepts 2 or 3; rows whose exact test cannot reach `--alpha` are then labelled `underpowered`).
- `--concurrency <n>` — jobs in flight, default 2, 1 to 8. It must be 1 with `--decider-cmd` or
  `--decider-dir`, whose channel is shared by every job.
- `--alpha`, `--correction bh|holm` — see the labels below. `bh` uses a fixed q = 0.10.
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
- `--output-format json` — the envelope
  `{tool, version, command:"eval", ok, evalDir, arms, pins, sections, summary, cost, stoppedEarly, error}`,
  with `ok` true exactly when the exit code is 0.

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
| infrastructure: a spawn or protocol failure, a transport error, a usage limit, a decider timeout | excluded, reported |
| the agent could not authenticate: its reply is `Not logged in · Please run /login` or `Authentication required · Sign in again to continue` | excluded as infrastructure, reported (rule `auth`) |
| a usage or spend limit reported as the agent's final message (`You've hit your … limit`, out of usage credits, …) — including on a nonzero exit, and after a model has already spent | excluded as infrastructure, reported (rule `usage_limit`) |
| no model answered: every model the run reported is the agent's own `<synthetic>` marker and it cost $0 | excluded as infrastructure, reported (rule `no_model_answered`) |
| a run under `answer_channel: none` that ended on a question | counted as a run that completed (rule `parked_at_question`): its assertions are graded, and the pin and judge rows still apply |
| a stalled question in a scenario that asserts `allow_stall: true` | counted as a run that completed (rule `stall_allowed`): its assertions are graded, and the pin and judge rows still apply |
| the agent's own failure: a timeout, `error_max_turns`, a stalled or unanswered question, a crash | **fails every row** (it still counts) |
| the pin did not hold (`modelPinHonored` false, or unknown on a rep that otherwise completed), the snapshot changed under it, or a grade came from another judge prompt | excluded, reported |
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
- **The answer key.** An arm that contains one of the eval's scenario or session files (by location —
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

A refused eval leaves nothing in its eval dir.

## Exit codes

- `0` — completed. Without `--fail-on` no drop fails the eval; read the report. (An all-`insufficient`
  result, a scenario that compared nothing, or a judge disagreement still exits 1 — see below.)
- `1` — with `--fail-on possible`, a `possible` or `confirmed` drop (the semantic roll-up rows count, the
  classification rows do not) or an `insufficient_refusals` row ([below](#when-the-candidate-refuses-more));
  with `--fail-on confirmed`, a `confirmed` drop only. Also, with or without it: every row `insufficient`
  (`insufficient_refusals` rows do not count toward this), a scenario that compared nothing (below), or the
  judge model differed across reps. An A/A run under `--fail-on possible` can exit 1 on noise alone.
- `2` — usage, or any refusal before the first run (the `--max-budget-usd` refusal included).
- `3` — an arm snapshot could not be copied, or failed its staging preflight.

Under `--dry-run`: `0` the plan was printed; `2` any refusal the real eval would make before its first run;
`3` as above, or the dry run's temp dir is inside a git work tree, or git cannot tell whether it is (set
TMPDIR); a git the operator's Ctrl-C killed exits `130` instead. Every dry-run refusal's JSON
error envelope carries `dryRun: true`, and `plan` when the refusal came after the plan was computed.

### When every rep errored

Judged per scenario, for each arm:

- **Every rep of both arms errored** (infrastructure or the agent's own failure, in any mix): 0 against 0
  is not a comparison. The scenario's rows get no reps, so they are `insufficient`, and the eval exits 1.
- **Every rep of one arm is infrastructure**: that arm never ran the skill. Same outcome.
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
session hashes, pins, settings), `arms/`, `runs.jsonl` (one line per finished job, with every field the
report reads, and a `semantic_pairwise` grade's per-order outcomes under `order: both`, for reading position bias), `report.json` (`schemaVersion: 0`) and `report.md` (host paths outside `$HOME` redacted,
the count in the header).

The runs themselves are ordinary run dirs under the runs root, labelled `eval:<eval-id>:<arm>`, so
`prune`'s `--keep-last` applies to them: at the defaults an eval leaves 10 runs per scenario and a bare
`prune` keeps the newest 5. `prune` names each eval that lost runs. The report's evidence links then
point at deleted runs, but `eval report` still rebuilds the report, because it reads only the eval dir.
Pass a larger `--keep-last`, or prune a different runs root, to keep an eval's runs.

`stats <scenario>` pools both arms of an eval (they are ordinary indexed runs); separate them with
`--group-by label`.

The report schema, the labels and the statistical defaults (`--reps`, `--alpha`, `--correction`,
`--concurrency`, the `insufficient` threshold) are experimental and may change in a minor release.
