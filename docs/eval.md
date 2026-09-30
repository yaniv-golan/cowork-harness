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

## What it compares

- **Arms.** Exactly two `--arm [<label>=]<source>` values. The **first is A, the baseline**; a *drop*
  means B passes less often than A. A `<source>` is a plugin directory, or `git:<ref>:<path>` — a
  directory as committed at `<ref>`, with `<path>` relative to the root of the repository that contains
  your current directory.
- **What is substituted.** Only `plugins.local_plugins`, and every scenario's session must declare
  exactly one entry (the same one). Each arm's plugin is mounted in its place. Skills declared any other
  way (`skills.local`, marketplaces) stay as the session declares them, in both arms.
- **Snapshots.** Each arm is copied once, before any run, into `<eval-dir>/arms/<label>/`. Every rep
  mounts the copy, so editing the source while the eval runs has no effect. A directory arm in a git
  work tree contributes its **git-tracked** files — what the stager would deliver — and the report
  header counts the untracked files it left out; `--include-untracked` copies everything instead
  (refused for a `git:` arm). A `git:` arm is extracted file by file from the commit, so a file marked
  `export-ignore` is still included.
- **Rows.** Every assertion of every scenario is a row. Each `semantic_matches` rubric claim is its own
  row; the assertion's own pass (a function of its claims through `min_pass`) is shown as a *derived*
  row.
- **Units.** Each rep is one run, graded once ("runs × grades").

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
- per-arm medians of cost, judge cost, turns and duration (descriptive, no test);
- "no control arm: prior-answerable claims are not flagged".

The correction family is every claim row and every non-semantic assertion row of a section. The
semantic roll-up rows and the two classification rows (the errored-by-agent rate and the invocation
rate) are shown separately and never reach `confirmed`.

### What happens to a rep that went wrong

| Rep | Counted as |
|---|---|
| ran to completion | valid |
| the agent's own failure: a timeout, `error_max_turns`, a stalled or unanswered question, a crash | **fails every row** (it still counts) |
| infrastructure: a spawn or protocol failure, a transport error, a usage limit, a decider timeout | excluded, reported |
| the pin did not hold (`modelPinHonored` false or unknown), the snapshot changed under it, or a grade came from another judge prompt | excluded, reported |
| one assertion's judge output was invalid | only that assertion's rows lose the rep |

## What it holds fixed (refused before any run, exit 2)

- **The agent model** (`--model`, else the session's `model:`, else `COWORK_HARNESS_MODEL`) must be a
  concrete id — `opus`, `best` and the like are refused, because an alias can resolve differently between
  the arms.
- **The judge model**: `--judge-model <id>` grades every `semantic_matches` assert with one concrete
  model. Without it, every assert's `judge_model` and the default chain must be concrete. If the judge
  that actually answered still differs across reps, the eval exits 1.
- **The eval dir** must be outside every git work tree (including a gitignored directory inside one):
  the stager delivers a mount's git-tracked files only, so a snapshot inside a repository would mount
  empty.
- **Identical arms** are refused; `--allow-identical-arms` runs an A/A comparison, which is how you see
  the noise floor of your own scenarios.
- **The answer key.** An arm that contains one of the eval's scenario or session files (by location, or
  as a byte-identical copy under any name), or any `evals.json`, is refused: the agent could read the
  answers.

## Exit codes

`0` completed, no drop at the `--fail-on` level · `1` a drop at the `--fail-on` level (default
`possible`; the semantic roll-up rows count, the classification rows do not), every row `insufficient`,
or the judge model differed across reps · `2` usage, or any refusal before the first run · `3` an arm
snapshot failed its staging preflight.

## Picking scenarios

- **Hold some out.** A scenario you tuned the skill against is weak evidence that the edit helps: you
  shaped the skill to it. Keep scenarios you did not look at while editing, and pass each with
  `--holdout <scenario.yaml>`. They are reported, and corrected, in their own section. `--holdout` may name every scenario; the report then has only the held-out section. Nothing is
  concluded about overfitting automatically; compare the two sections yourself.
- **Pick hard cases.** A scenario every version passes 5/5 sits at the ceiling and cannot show an
  improvement. Choose questions a person would find hard, where the skill's guidance is what makes the
  difference.
- **Write discriminating claims** — see Recipe 5 in the skill's `references/task-recipes.md`.

## Lane note

`eval` compares behaviour inside the harness, and that comparison does not depend on which Cowork lane
you target. Assertions about the environment itself — paths, `present_files`, what lands in `outputs/`
— describe the local lane.

## Files

`<eval-dir>/manifest.json` (everything fixed before the first run: arms, snapshot signatures, scenario and
session hashes, pins, settings), `arms/`, `runs.jsonl` (one line per finished job, with every field the
report reads), `report.json` (`schemaVersion: 0`) and `report.md` (host paths outside `$HOME` redacted,
the count in the header). The runs themselves are ordinary run dirs under the runs root, labelled
`eval:<eval-id>:<arm>`; `prune` may remove them later, which leaves the report's evidence links dangling
but does not stop `eval report` from rebuilding it.

The report schema, the labels and the statistical defaults (`--reps`, `--alpha`, `--correction`, the
`insufficient` threshold) are experimental and may change in a minor release.
