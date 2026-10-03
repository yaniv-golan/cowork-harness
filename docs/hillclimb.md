# Hill-climbing a skill: `hillclimb` and the `/claude-api hillclimb` loop

`/claude-api hillclimb` is a loop in Claude Code's bundled `claude-api` skill. It improves an artifact round by
round against an eval: it baselines, proposes a change, runs the eval again, keeps or reverts the change, and
repeats. It does not run your eval itself. It asks for a runner that writes each case's transcript, served model,
token usage and grades into a fixed directory layout, which it and its report builders then read.

`cowork-harness hillclimb run` is that runner for a skill or plugin, under Cowork's runtime. Point the loop at it
and every round runs your scenarios in the sandboxed agent, grades them with your `assert:` blocks, and writes the
layout the loop expects. The harness makes no keep-or-revert decision of its own. The goal, the best round, the
stopping rule and the edits to your skill stay the loop's.

This page is for the person setting the loop up. With the companion skill installed, the loop agent can read two pages of the companion skill:
[`references/hillclimb-recipe.md`](../.claude/skills/cowork-harness/references/hillclimb-recipe.md) (what to do at
each step of the loop) and [`references/hillclimb.md`](../.claude/skills/cowork-harness/references/hillclimb.md)
(every command, flag, refusal and exit code). The CLI reference is [cli.md](./cli.md).

- [Quick start](#quick-start)
- [Where the flow dir goes](#where-the-flow-dir-goes)
- [How the loop's steps map to commands](#how-the-loops-steps-map-to-commands)
- [What each row measures](#what-each-row-measures)
- [Numbers a scenario declares (`metrics:`)](#numbers-a-scenario-declares-metrics)
- [Judging against a frozen reference (`semantic_pairwise`)](#judging-against-a-frozen-reference-semantic_pairwise)
- [Cost and spend](#cost-and-spend)
- [Differences from the loop's own runner](#differences-from-the-loops-own-runner)
- [Guardrails the harness adds](#guardrails-the-harness-adds)
- [Troubleshooting](#troubleshooting)

## Quick start

A flow is one directory of rounds: `baseline/`, then `v1/`, `v2/`, …. Every scenario file in the target is one
case. Run every command from the same directory, with the same target path and the same `--flow`. `--flow` must be
an absolute path, or a path below the working directory with no `..` segment:

```bash
# 1. The _state.json skeleton the loop starts from, and the metrics legend (<flow>/metrics.md).
mkdir -p ~/hc/my-skill
cowork-harness hillclimb state-template evals/ --flow ~/hc/my-skill > ~/hc/my-skill/_state.json

# 2. You, once: review what the harness gate covers (a plain --dry-run lists the files it hashes), then record
#    its sha. Spends nothing. Pass the same --skill the loop will pass, if any.
cowork-harness hillclimb run evals/ --flow ~/hc/my-skill --dry-run
cowork-harness hillclimb run evals/ --flow ~/hc/my-skill --dry-run --approve-harness

# 3. The loop's runner command, once per round.
cowork-harness hillclimb run evals/ --flow ~/hc/my-skill --variant baseline --reps 3
cowork-harness hillclimb run evals/ --flow ~/hc/my-skill --variant v1 --reps 3

# 4. Check the flow against the loop's schema; warns about cases with no headroom.
cowork-harness hillclimb check --flow ~/hc/my-skill
```

Then start Claude Code in your repo, run `/claude-api hillclimb`, and when it asks for the eval command, give it
step 3's command with `--variant` left for it to fill. Put every fixed flag before `--variant`
(`run evals/ --flow ~/hc/my-skill [--skill S] [--judge-model J] --variant <v> --reps <R>`). Before its first
unattended round, the loop asks you to allow that command for the session: allow the prefix up to `--variant`,
not a wildcard. That allowlist entry is what bounds an unattended round. The harness gate never covers the
command-line model flags, so check `model` and `judge_model` on each round's rows against your plan.

Every command defaults to `--flow .claude/hillclimb/flow`, inside your repo; the examples put it outside instead
(see the next section). Help goes to stderr: `cowork-harness hillclimb run --help 2>&1 | grep -- --skill`.

Requirements: a `cowork-harness` whose `hillclimb run --help` lists `--skill`; one plugin under test (each
scenario's session names it as its only `plugins.local_plugins` entry); concrete model ids for the agent and the
judge (an alias such as `sonnet` is refused, because the loop compares rounds by the model that served them).

## Where the flow dir goes

Keep the flow dir out of your repo, or ignore most of it. Rows, traces and the copies under `<variant>/out/`
hold the run's outputs and judge rationales (secret-scrubbed and host-path-redacted text; binary files copied as
they are), and `inputs/` holds a copy of the files the session uploads (up to 2 MiB each and 20 MiB per rep), as `inputs/<hash>-<name>`, shared by
every variant (`--no-copy-inputs` skips it). `summary.json` is the loop's: the runner only adds keys it lacks.

The loop's guide suggests committing the flow dir without its traces, so the history survives. If you do, ignore
at least these, and read what remains before the first commit:

```gitignore
<flow>/*/traces/
<flow>/inputs/
<flow>/*/out/
<flow>/*/regrade-*.bak.jsonl
<flow>/*/.lock
<flow>/*/ref/
```

Three things live outside the flow dir, and the loop needs all three for the whole climb:

- **The kept run dirs** under the runs root (`~/.cowork-harness/runs`, or `--run-dir` / `COWORK_HARNESS_RUNS_DIR`).
  `hillclimb regrade` and `hillclimb freeze-ref` find them by each row's `meta.run_id`, and `meta.run_dir`
  points into them (redacted when the runs root is outside your home directory). Pass the same
  `--run-dir` to every command. `prune` keeps hillclimb-labelled runs, outside `--keep-last`; run
  `prune --include-hillclimb` only after the climb ends, since it removes that evidence for every flow under the
  runs root, live ones included.
- **The per-variant snapshots** in `~/.cowork-harness/hillclimb-snapshots` (`COWORK_HARNESS_HILLCLIMB_SNAPSHOTS`
  moves them). A resumed or appended rep runs its variant's snapshot. They are keyed by the flow dir's real path,
  so moving or renaming the flow dir orphans them.
- **The working directory and target spelling.** The harness gate hashes path names relative to the current
  directory, and the lockfiles found there. Running a command from somewhere else, or naming the target through
  another path, changes the sha and refuses the pass.

## How the loop's steps map to commands

| The loop asks for | What to use |
|---|---|
| The eval command, and where it writes results | `hillclimb run <target> --flow <dir> --variant <v> --reps <n>`; results in `<flow>/<variant>/` |
| Does the runner retry failed cases? | No case-level retry, as in the loop's own runner: a failed attempt is an `errors.jsonl` row and runs again on the next pass. API-level retries are counted per row (`meta.retries`) |
| Per case: transcript, model, usage, grades from one model call | Every row and its `traces/<id>_rep<k>.json` come from the same run; the model is read from the run, not from your config |
| Prove the eval can detect a win (noise floor, headroom) | Compute the noise floor from the baseline rows. `hillclimb check` and the end of a baseline pass warn about cases at the ceiling or floor. `eval --dry-run --target-effect` is an optional sizing aid from your run history |
| Prove the mechanism is wired | The `skill_invoked` column (pass `--skill <name>` when the plugin has several skills), and a null run: `hillclimb run … --flow <dir>-null --ablate` into a sibling flow. The null flow has its own `_state.json` and gate: you run `state-template` and the `--dry-run --approve-harness` for it first |
| Recompute the headline from raw results | Rows carry every grade key; recompute from `results.jsonl` |
| Spot-check grading; fix a rubric and re-grade in place | Edit the rubric, approve the new sha (`--dry-run --approve-harness`, with the loop's `--skill`), then `hillclimb regrade <target> --flow <dir>`. See [what a re-grade can change](#what-a-re-grade-can-and-cannot-change) |
| Verify the served model and retries | A run served by another model is an `errors.jsonl` row (`serving_substitution`), and so is one with no evidence of the pinned model, unless the agent itself failed first (then it is a scored agent failure) |
| A probe or canary on one case | `hillclimb run … --case <id>`; it is the variant's first run, so it fixes that variant's snapshot |
| Print the resolved scope every run | Every pass prints how many (case, rep) slots it will run and names the slots it re-runs after a failure; `--dry-run` adds the cost estimate |
| `_state.json` and `harness_paths` | `hillclimb state-template … --flow <dir>`: save its stdout; after adding a metric, merge only the new `metrics` entries |
| The runner's harness gate and `--approve-harness` | The same contract: the pass refuses until you record the sha. See [Guardrails](#guardrails-the-harness-adds) |
| Progress while a round runs | `<flow>/<variant>/progress.txt`, rewritten every 30 seconds |
| A split for 5-10 cases | Don't split; report the delta as directional. Case ids are scenario file stems (a stem outside `[A-Za-z0-9_.-]`, or longer than 129 characters, is rewritten; `original_id` keeps it) |

## What each row measures

`<flow>/metrics.md` is the legend for every key a row carries; read it before averaging. The main ones:

- **`pass`** is the scenario's verdict, 1 or 0. `state-template` declares it first, and the loop's report reads
  the first binary metric as its headline, so `pass` is the headline unless you reorder `_state.json`.
- **Per assertion and per rubric claim:** `a<i>` for each assertion, `a<i>_c<j>` for each claim of a
  `semantic_matches` rubric, and `claims` (passed claims over graded claims, 0-1). `state-template` declares the
  per-assertion keys only when every case has the same assertion list; otherwise they are drill-down only, and
  `metrics.md` says so.
- **`<key>_present: 0` means the value is absent, not 0.** `pass_present: 0` marks a verdict that failed only
  because one single-key `semantic_matches` assertion's evidence was refused (with a multi-key assertion the row
  scores `pass: 0`). Averaging an absent value as 0 reads a capture problem as a regression.
- **`skill_invoked`** is 1 or 0 for whether the run invoked the tracked skill (`meta.skill_tracked` names it). A
  blank means not measured: no skill was tracked, or the run's record could not tell.
- **Reps count from 0**: `rep: 0`, `traces/<id>_rep0.json`, `out/<id>_rep0/`.
- **An agent's own failure is a scored row**: every graded key 0, `meta.failure_class: "errored_agent"`, and the
  rule that classified it in `meta.termination_rule` (for example a run that ended asking for input). A row with
  `status: "truncated"` hit the output-token limit.
- **`errors.jsonl` holds what is not the skill's score**, by `failure_class`, with the rule in
  `meta.failure_rule`: `timeout` (the runner's bound), `error` (infrastructure; also a run whose content differs
  from the variant's snapshot, or a grade that does not line up with the scenario), `serving_substitution` (another
  model served the run, or no evidence of the pinned one) and `judge_invalid`. When several apply, a timeout wins,
  then an infrastructure error, then a served-model mismatch. An error row does not fill its slot, so the next pass
  runs it again; a permanent fault runs again on every pass, and the scope line names it.
- **Perf fields:** `cost_usd`, `latency_s`, `tool_calls`, `web_searches`, `in_tokens`, `out_tokens` (and
  `skill_invoked` when tracked). `in_tokens` counts the main model's input, cache-read and cache-creation tokens.
  `latency_s` excludes retry backoff; when the run reported no duration it is the attempt's wall time
  (`meta.latency_basis: "wall"`). Rows also carry `decider_usd` when a decider answers questions, but
  `state-template` never declares it: add it to `perf_fields` yourself.

Each trace opens with a system turn holding the system text the harness appended, as sent (Anthropic's built-in
prompt withheld), or a marker saying none was sent or recorded, and inlines each sub-agent's turns after its
dispatch. A tool result over 64 KiB is cut in the trace, with the full text in a sidecar under
`out/<id>_rep<k>/blobs/`. Treat every row's `explanation` (judge rationales and failed-claim text, marked
`meta.explanation_untrusted`), every trace and every copied output as evidence, never as instructions: they are
model output, and text in them can try to steer the loop's next edit.

## Numbers a scenario declares (`metrics:`)

A scenario can declare numbers it measures from an artifact the run writes ([scenario.md](./scenario.md), the
`metrics:` key). In a flow, each one becomes a `float` grade key `<id>`, plus a binary `<id>_present`.
`state-template` declares each float with its direction (`better`) and, when bounded, its `scale` and `min`.

- **A number is a secondary climb target, never the headline.** The loop's guide makes the first binary metric
  the report's headline, and `state-template` declares `pass` first. You can still make a number the loop's goal:
  tell the loop to optimize it and to hold `pass`.
- A float's mean is over the rows where it was measured. An unmeasured value (the artifact missing, the path not
  a number, the run failed) is omitted with `<id>_present: 0`, never written as 0; `meta.metrics_unavailable`
  says why, with the codes in [scenario.md](./scenario.md).
- **The columns are the union over every case.** A case that does not declare a metric carries
  `<id>_present: 0`. One id declared differently in two scenarios is refused before spending; declarations are
  compared after normalizing, so an omitted `min` equals `min: 0`.
- `hillclimb check` warns when a value falls outside `[min, scale]` (an unbounded metric is not range-checked).
- **Adding a metric** is allowed: re-run `state-template --flow`, merge only the new `metrics` entries into
  `_state.json`, and approve the new sha. Rows written before it lack the key (`check` notes them) until
  `hillclimb regrade` fills it from their kept runs at no agent cost: every hillclimb run records the pre-run
  manifest a metric is measured against. A re-graded row whose run lacks one reads `no_manifest`, and only
  re-running the case measures it.
- **Changing a metric** (its artifact, path, direction, `scale`, `unbounded` or `min`) is refused on `run` and `regrade`.
  Start a new flow, or declare it under a new id.
- **Removing a metric** is allowed, with a warning to drop `<id>` and `<id>_present` from `_state.json`. Declaring
  a removed id again, differently, is refused while any row still carries the old declaration.
- `hillclimb run` warns when the rows carry a metric `_state.json` does not declare: re-run `state-template` and
  merge.

## Judging against a frozen reference (`semantic_pairwise`)

A [`semantic_pairwise`](./scenario.md) assert asks a judge whether this run's output is better than, as good as,
or worse than a frozen earlier output. In a flow, the references are the flow's own: the baseline pass freezes
the baseline's reference for each pairwise case from its lowest-rep good row, and every later variant is judged
against it (`win`: 1 win, 0.5 tie, 0 loss; 0.5 on the baseline's own rows). The scenario's `refs:` is ignored.

When a variant wins nearly every comparison (`check` notes a mean of 0.9 or more), raise the bar: freeze that
variant's output as a second reference, fill its column on the earlier rows, then declare it (`state-template`
declares `win_<vN>` only once no scored row lacks it):

```bash
cowork-harness hillclimb freeze-ref evals/ --flow ~/hc/my-skill --variant v3
cowork-harness hillclimb regrade evals/ --flow ~/hc/my-skill --fill-refs
cowork-harness hillclimb state-template evals/ --flow ~/hc/my-skill   # then merge the new win_v3 entries
```

Only the baseline's reference decides `pass`; a later reference is a metric.

## Cost and spend

- **`cost_usd` on a row is the agent's whole cost for that run**: the main model, sub-agents and auxiliary calls,
  as Cowork's agent reports it, across every model the run called. Use it for the loop's `$/run` and `spend`.
  Don't derive cost from `model` × `usage`: `usage`, `in_tokens` and `out_tokens` cover only the pinned model's
  id, so a sub-agent or auxiliary call on another model is left out of them.
- **Judge spend is separate.** It is not in `cost_usd`. A
  row's `judge_model` and `judge_usage` say who judged its current grades; they are not a spend ledger (a
  re-grade replaces them).
- **Spend for a climb:**
  - agent spend = the sum of `cost_usd` over every `results.jsonl`, plus `meta.cost_usd` on every
    `errors.jsonl` row (failed attempts are billed; an error row's top-level `usage` is the main model only);
  - judge and decider spend = for every row's kept run dir (scored and error rows alike), the
    `judgeCostUsd` of each assertion and the `deciderCostUsd` in that run's `result.json`, plus the
    top-level `judgeCostUsd` of every re-grade file a `hillclimb regrade` wrote into the same run dir
    (`turns/<N>/regrade/*.json`). Use the file's top-level figure, never its per-assertion ones: a re-grade file
    also lists the grades it kept, with their original cost. Those files are never overwritten, a row re-graded
    with no judge call (deterministic assertions and metrics only) writes none, and a file with no top-level
    `judgeCostUsd` recorded no judge spend, so the sum counts every judge call once. Unpriced judge grades and
    failed decider calls are not counted, so the total is a floor.
    Find each run dir the way `hillclimb regrade` does, by the row's `meta.run_id`: the runs root's
    `index.jsonl` maps each `runId` to its `outDir` (the root is `~/.cowork-harness/runs`, or `--run-dir` /
    `COWORK_HARNESS_RUNS_DIR`). A row's `meta.run_dir` is a pointer for reading one rep, and it is redacted
    when the runs root is outside your home directory.
    This needs the kept run dirs: the rows alone cannot rebuild judge spend, so a loop that sums only
    `results.jsonl` and `errors.jsonl`, as the loop's guide describes, undercounts it.
- **There is no spend cap on `hillclimb run`.** Recompute spend from the files after every round, as the loop's
  guide does, and stop at your budget. (`--max-budget-usd` on `run` and `eval` caps agent spend only.)
- **`--dry-run` prints an estimate** of the agent spend for the slots it would run, from this machine's run
  history; hillclimb runs themselves are left out of that history. On a machine with no history for a scenario,
  the estimate lists it as unpriced and is a lower bound. Judge spend is not in the estimate.

## Differences from the loop's own runner

The loop's guide ships a reference runner. `hillclimb run` writes the files and fields of that runner's contract
that the loop and the lite report builder read, with these differences:

- **Scenarios are single-prompt.** Every case is one prompt (harness-wide); a trace is one conversation.
- **Anthropic's built-in system prompt is withheld.** A trace's system turn carries the system text the harness
  appended (its model of Cowork's), as sent. A sub-agent's system turn carries what that sub-agent received, or says none was
  received (a forked skill, or the `protocol` tier). Anthropic's own built-in prompts are never written.
- **The full report viewer is untested.** These flows are checked against a pinned revision of the lite report
  builder (it reads a fixture flow with no warning).
  The full viewer is not in every install and has not been run against these flows; it may expect a single
  leading system turn where sub-agents add more, and it may draw a float with no `scale` on a 0-10 axis.
- **`cost_usd` is the agent's reported total, not a derivation** from `model` × `usage`, and it excludes the
  judge. Judge spend has to be read from the kept run dirs (see [Cost and spend](#cost-and-spend)).
- **The kept runs and snapshots live outside the flow dir** (see [Where the flow dir goes](#where-the-flow-dir-goes)).
  Copying a round's directory is not enough to keep it re-gradable.
- **Inside a git work tree, each variant runs a snapshot of the plugin's git-tracked files.** A file the loop adds is left out until it is
  `git add`ed (a stderr line counts the files left out). A `--case` canary is the variant's first run, so a fix
  made after it goes into a new variant.
- **The lever is the plugin.** Each variant snapshots the plugin. The session file (`model`, `effort`,
  `subagent_model`) is shared by every variant and covered by the harness gate, so changing it is a gated edit
  that every later resume also runs; `--model` on the command line selects the agent model outside the gate, so
  leave it out of the allowlisted prefix if the loop's goal is moving to another model. Cowork's system prompt is
  not tunable.
- **A missing reference is refused before spending.** The reference runner hands the grader a missing reference
  as `null`; `hillclimb run` refuses a non-baseline pass while a pairwise case has no baseline reference.
- **Timeouts.** `--timeout-s` (default 1800) bounds the agent: a longer scenario `timeout_ms` is lowered to it, and
  reaching it is an `errors.jsonl` `timeout` row. A scenario's own shorter `timeout_ms` is the skill's limit: a
  scored agent failure. No judge starts after the bound, but one already running finishes.
- **A workspace fixture starts with a fresh conversation.** A case with
  [`workspace_fixture`](./scenario.md#starting-from-a-saved-workspace-workspace_fixture) resumes from saved
  outputs the way re-invoking the skill in the same Cowork session does, except that in Cowork the earlier
  conversation is still in context and here it is not.
- **`_state.json` gains `harness_skill`** beside `harness_sha` when you pass `--skill`; both are written only by
  `--approve-harness`.
- **`tags`** on a row is the scenario file's directory name. The loop stratifies a split by its first tag, so
  scenarios in one flat directory form one stratum.
- **No refusal class.** A model refusal is graded like any other answer; to count refusals, add an assertion
  or a metric for them.

### What a re-grade can and cannot change

`hillclimb regrade` re-grades the flow's rows from their kept run dirs, without running the agent:

- it re-evaluates a deterministic assertion (`file_exists`, `tool_called`, …) whose definition changed against
  the kept run, and re-measures every declared metric, so an assertion fix or a metric added mid-climb reaches
  the rows already written;
- `--reevaluate` (no judge, no agent cost) also takes the fresh outcome of every unchanged deterministic
  assertion, for a fix in the harness's own evaluator; it lists a row whose kept run cannot be evaluated
  faithfully;
- it re-judges a judged assertion when something the judge sees changed (its rubric or claims, its judge model or
  prompt template, or a `semantic_pairwise` assertion's references), recording why in
  `meta.regrade_rejudged_because`; `--rejudge` re-judges every one;
- it recomputes `pass`;
- `--fill-refs` judges only the pairwise comparisons a row lacks, so `pass` cannot move. After a grader edit, run
  a default re-grade first: a fill lists the rows whose grader changed instead of filling them. `--rejudge` and
  `--reevaluate` do not combine with `--fill-refs`.

A row is listed instead of re-graded when, among other cases (see the reference), its kept run dir is gone, or
when the evidence its judge read has changed since it was graded (an edited kept run, or a harness change to how
the document is composed or scrubbed); `--rejudge` grades the latter, unless the current evidence would be less
redacted than the graded one (that row stays listed until the run's scrub settings are set, or `--rejudge --allow-
doc-drift`). Each row records `meta.assert_sig`, the assertions it was graded under: `hillclimb run` warns when a
resumed pass would mix them, and `hillclimb check` flags a case whose rows carry more than one.

## Guardrails the harness adds

- **The harness gate.** `hillclimb run` and `hillclimb regrade` refuse until `_state.json` holds an approved
  sha, and again whenever it changes. The sha covers every scenario file (all cases, whatever `--case`
  selects), each session file, its uploads and workspace fixtures, the lockfiles in the current directory, the
  `harness_paths` entries, the `--skill` selection, and the harness version and baseline. It never covers the
  plugin the loop edits. Upgrading `cowork-harness`, or a `sync` that moves a case's baseline, therefore trips it: that is the loop's
  re-baseline signal. With no lockfile in the current directory, dependency changes are outside the sha (a pass
  says so). `--model` and `--judge-model` are not in it. `hillclimb freeze-ref` needs no approval: the gate covers
  `run` and `regrade`. `--approve-harness` is yours to pass, never the loop's.
- **No answer key in reach.** A pass is refused when the agent could read the flow dir, a scenario or session
  file, a `harness_paths` file or the runs root through a mount, a workspace fixture or the plugin. A file
  listed in `harness_paths` that sits inside a workspace fixture counts as an input and is not refused, so keep
  graders outside fixtures.
- **The headroom warning.** `hillclimb check`, and the end of every baseline pass, warn about the cases whose
  baseline reps are all at the good or bad end of the headline metric. It never changes the exit code.
- **Run labels.** Every run is labelled `hillclimb:<flow dir name>:<variant>` in the run index (`stats --label`).
  Two flows whose directories share a name share a label. These runs are left out of the cost history that
  `--dry-run` and `eval --dry-run` price from.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `no approved harness sha` / `harness changed since last approved run` | Review the files the message lists, then `hillclimb run … --dry-run --approve-harness` with the loop's `--skill`. A change you did not make: check the working directory and the target path |
| A resumed variant refuses: snapshot missing | The flow dir moved, or the snapshot root was cleaned. Restore it, or run into a new variant |
| A file the skill needs is missing in the run | It is untracked: `git add` it before the variant's first run (the pass printed a count of untracked files) |
| `skill_invoked` is blank | The plugin has several skills (pass `--skill <name>`, the bare name, on every pass), it has none, or the run's record could not tell (`meta.skill_tracked` is set but the cell is blank) |
| A non-baseline pass refuses on a pairwise case | The baseline reference is missing: `hillclimb freeze-ref … --variant baseline --case <id>`, or, when the message says freezing cannot repair it, a fresh flow dir |
| The same slots run on every pass | They are `errors.jsonl` rows with a permanent fault; read `failure_class` and `error` |
| `regrade` lists rows "kept run dir is gone" | Pass the `--run-dir` the runs were written with; a removed run cannot be re-graded (`prune --include-hillclimb` removes them) |
| A new metric or `win_<vN>` column is missing on older rows | They were written before it: fill a metric with `hillclimb regrade` (a row reading `no_manifest` needs a re-run), a reference's column with `hillclimb regrade --fill-refs`, before comparing |
