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
  judge call per `semantic_matches` assert per run. There is no budget flag; the start-up line prints the
  job count before the first run, and `stats` prices past runs of the same scenarios.
- **Tier.** Each scenario runs at its own `fidelity:`, with that tier's prerequisites (Docker and the
  agent image for `container`, and so on) — check them with `cowork-harness doctor --tier <tier>`. The
  agent credential is checked for you: see [What it holds fixed](#what-it-holds-fixed-refused-before-any-run-exit-2).
- **Run an A/A first.** `eval` with the same source as both arms (`--allow-identical-arms`) shows how
  far your scenarios' rates move when nothing changed. Read that before trusting a before/after.

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
- **Rows.** Every assertion of every scenario is a row. Each `semantic_matches` rubric claim is its own
  row; the assertion's own pass (a function of its claims through `min_pass`) is shown as a *derived*
  row.
- **Units.** Each rep is one run, graded once ("runs × grades").

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
- **an arm in which every rep errored**, named with its most frequent bucket and rule — for example
  `errored_infra (auth) 5/5`. Nothing was compared, so every row is `insufficient` (see
  [Exit codes](#exit-codes)); `report.json` lists these under `summary.erroredArms`;
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
| no model answered: the agent could not authenticate (its reply is `Not logged in · Please run /login` or `Authentication required · Sign in again to continue`), or every model it reported is its own `<synthetic>` marker and the run cost $0 (a spend limit, say) | excluded as infrastructure, reported (rule `auth` or `no_model_answered`) |
| the agent's own failure: a timeout, `error_max_turns`, a stalled or unanswered question, a crash | **fails every row** (it still counts) |
| the pin did not hold (`modelPinHonored` false, or unknown on a rep that otherwise completed), the snapshot changed under it, or a grade came from another judge prompt | excluded, reported |
| one assertion's judge output was invalid | only that assertion's rows lose the rep |

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
- **`--fail-on confirmed`** when no row could reach `confirmed` at this `--reps` and correction.
- **The agent credential**, for every tier the scenarios run at, by the same check
  `cowork-harness doctor --tier <tier>` prints as its `token` row: a failing check refuses the eval with
  doctor's message and fix. A token in the environment or `.env` passes at every tier. Without one, a
  Claude Code login in the macOS Keychain is enough only at `protocol` (which keeps your real config dir,
  so the agent signs itself in; doctor shows it as a warning); every other tier gives the agent a managed
  config dir, and there it is refused. The check cannot see a token that is present but expired — a rep
  that then fails to authenticate is excluded as infrastructure (above).

A refused eval leaves nothing in its eval dir.

## Exit codes

- `0` — completed. Without `--fail-on` no drop fails the eval; read the report. (An all-`insufficient`
  result, an arm in which every rep errored, or a judge disagreement still exits 1 — see below.)
- `1` — with `--fail-on possible`, a `possible` or `confirmed` drop (the semantic roll-up rows count, the
  classification rows do not); with `--fail-on confirmed`, a `confirmed` drop. Also, with or without it:
  every row `insufficient`, or the judge model differed across reps. An arm in which **every** rep
  errored — infrastructure or the agent's own failure, in any mix — compared nothing, so every row of the
  eval is reported `insufficient` and this rule applies; the header names the arm and its most frequent
  error. An A/A run under `--fail-on possible` can exit 1 on noise alone.
- `2` — usage, or any refusal before the first run.
- `3` — an arm snapshot could not be copied, or failed its staging preflight.

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

`eval` compares behaviour inside the harness, and that comparison does not depend on which Cowork lane
you target. Assertions about the environment itself — paths, `present_files`, what lands in `outputs/`
— describe the local lane.

## Files, and `prune`

`<eval-dir>/manifest.json` (everything fixed before the first run: arms, snapshot signatures, scenario and
session hashes, pins, settings), `arms/`, `runs.jsonl` (one line per finished job, with every field the
report reads), `report.json` (`schemaVersion: 0`) and `report.md` (host paths outside `$HOME` redacted,
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
