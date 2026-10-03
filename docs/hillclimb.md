# Hill-climbing a skill: `hillclimb` and the `/claude-api hillclimb` loop

`/claude-api hillclimb` is a loop in Claude Code's bundled `claude-api` skill. It improves an artifact round by
round against an eval: it baselines, proposes a change, runs the eval again, keeps or reverts the change, and
repeats. It does not run your eval itself. It asks for a runner that writes each case's transcript, served model,
token usage and grades into a fixed directory layout, which it and its report builders then read.

`cowork-harness hillclimb run` is that runner for a skill or plugin, under Cowork's runtime. Point the loop at it
and every round runs your scenarios in the sandboxed agent, grades them with your `assert:` blocks, and writes the
layout the loop expects. The harness makes no keep-or-revert decision of its own. The goal, the best round, the
stopping rule and the edits to your skill stay the loop's.

`eval` compares two versions of a skill you already have; `hillclimb` runs each round of the loop that produces them;
`critique` finds what is wrong with a skill; `skill` and `run` check that it works.

The command, its flags and defaults, its exit codes and the run envelope are a covered surface. The harness's own
row `meta` keys, the `out/` copies, the `metrics.md` wording, `hillclimb check`'s findings text, the `freeze-ref` and
`regrade` JSON payloads, `regrade.md` and its backups are EXPERIMENTAL and may change in a minor release
([SPEC.md](../SPEC.md)).

This page is for the person setting the loop up. With the companion skill installed, the loop agent can read two pages of the companion skill:
[`references/hillclimb-recipe.md`](../.claude/skills/cowork-harness/references/hillclimb-recipe.md) (what to do at
each step of the loop) and [`references/hillclimb.md`](../.claude/skills/cowork-harness/references/hillclimb.md)
(every command, flag, refusal and exit code). The CLI reference is [cli.md](./cli.md).

- [Terms](#terms)
- [Quick start](#quick-start)
- [Where the flow dir goes](#where-the-flow-dir-goes)
- [How the loop's steps map to commands](#how-the-loops-steps-map-to-commands)
- [What each row measures](#what-each-row-measures)
- [Numbers a scenario declares (`metrics:`)](#numbers-a-scenario-declares-metrics)
- [Judging against a frozen reference (`semantic_pairwise`)](#judging-against-a-frozen-reference-semantic_pairwise)
- [Cost and spend](#cost-and-spend)
- [Differences from the loop's own runner](#differences-from-the-loops-own-runner)
- [Guardrails the harness adds](#guardrails-the-harness-adds)
- [What a round can and cannot see](#what-a-round-can-and-cannot-see)
- [What hillclimb is not for](#what-hillclimb-is-not-for)
- [Troubleshooting](#troubleshooting)

## Terms

| Term | Meaning |
|---|---|
| Flow | One directory of rounds (`--flow`): `_state.json`, `metrics.md`, then one directory per variant |
| Variant | One round: `baseline` (the first variant, the starting plugin), then `v1`, `v2`, …; each runs a snapshot of the plugin taken on its first run |
| Case | One scenario file; its id is the file stem |
| Rep, slot | One run of a case in a variant, counted from 0; a (case, rep) pair is a slot, and a pass resumes by slot |
| Harness gate | A sha over the inputs the loop must not change (scenarios, sessions, uploads, workspace fixtures, lockfiles, `harness_paths`, the `--skill` selection, the harness version and Desktop baseline), recorded by `--approve-harness` in `_state.json` |
| Pairwise reference | A frozen output a `semantic_pairwise` assert is judged against: the baseline's, then any a `hillclimb freeze-ref --flow <dir>` adds |

Other terms, defined where they are used: a fill (`hillclimb regrade --flow <dir> --fill-refs`) adds the columns
a newer reference creates to rows written before it. The lite report builder ships with the loop's guide; the
loop runs it on the flow dir after a round. A decider answers questions the scenario's `answers:` does not script
(`--decider-cmd`, `--decider-dir`, or a scenario's `on_unanswered: llm`). The noise floor is how far the headline
moves between reps of the same variant; a case has headroom when its baseline reps are not all at the best or worst
value. A split holds out cases the loop does not tune on; a stratum is the group a stratified split draws from
evenly (here, a scenario's directory).

"Baseline" means two things here: the `baseline` variant, and the Desktop baseline (`desktop-…`), the pinned
Cowork version the harness models. Only the second is part of the harness gate.

## Quick start

A flow is one directory of rounds: `baseline/`, then `v1/`, `v2/`, …. Every scenario file in the target is one
case. Run every command from the same directory, with the same target path and the same `--flow`. `--flow` must be
an absolute path, or a path below the working directory with no `..` segment:

```bash
# 1. The _state.json skeleton the loop starts from, and the metrics legend (<flow>/metrics.md).
#    Pass the same --skill the loop will pass, if any.
mkdir -p ~/hc/my-skill
cowork-harness hillclimb state-template evals/ --flow ~/hc/my-skill > ~/hc/my-skill/_state.json

# 2. You, once: review what the harness gate covers (a plain --dry-run lists the files it hashes), then record
#    its sha. Spends nothing. Pass the same --skill the loop will pass, if any.
cowork-harness hillclimb run evals/ --flow ~/hc/my-skill --dry-run
cowork-harness hillclimb run evals/ --flow ~/hc/my-skill --dry-run --approve-harness

# 3. Optional: one case of the baseline, to see a row and its cost before the loop runs every case.
#    It is the baseline's first run, so it fixes the baseline's snapshot: make no plugin edit after it.
#    Pass the same fixed flags as the runner command in step 5 (--skill, --model, --judge-model).
cowork-harness hillclimb run evals/ --flow ~/hc/my-skill --variant baseline --case <id> --reps 1
```

4. Start Claude Code in your repo, run `/claude-api hillclimb`, and when it starts, tell it: read
   `references/hillclimb-recipe.md` from the cowork-harness skill and follow it.
5. When it asks for the eval command, give it the runner command, with `--variant` left for it to fill and every
   fixed flag before it:

   ```bash
   cowork-harness hillclimb run evals/ --flow ~/hc/my-skill [--skill S] [--model M] [--judge-model J] --variant <v> --reps 3
   ```

   The loop runs it once per round (`baseline`, then `v1`, `v2`, …); don't run the rounds yourself. Before its
   first unattended round, the loop asks you to allow that command for the session: allow the prefix up to
   `--variant`, not a wildcard. That allowlist entry is what bounds an unattended round. The harness gate never
   covers the command-line model flags, so check `model` and `judge_model` on each round's rows against your plan.
6. Once the loop has run a round, `cowork-harness hillclimb check --flow ~/hc/my-skill` checks the flow against
   the loop's schema and warns about cases with no headroom.

Every command defaults to `--flow .claude/hillclimb/flow`, inside your repo; the examples put it outside instead
(see the next section).

Requirements:

- a `cowork-harness` whose `hillclimb --help` lists `--skill` (help goes to stderr:
  `cowork-harness hillclimb --help 2>&1 | grep -- --skill`);
- a Claude Code whose bundled `claude-api` skill has `hillclimb`, to run the loop;
- what each case's tier needs: a credential the agent can use, and Docker and a staged agent at every tier but
  `protocol`. `cowork-harness doctor --tier <tier>` checks them ([cli.md](./cli.md#quick-start));
- a `fidelity:` on every scenario (it is required);
- Claude Code 2.1.197 or later on the host when a scenario uses `semantic_matches`, `semantic_pairwise` or
  `on_unanswered: llm` (the judge and the LLM decider call it);
- one plugin under test: each scenario's session names its directory as its only `plugins.local_plugins` entry,
  the same one in every case ([session.md](./session.md));
- concrete model ids for the agent and the judge (an alias such as `sonnet` is refused, because the loop compares
  rounds by the model that served them).

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
| Verify the served model and retries | A run served by another model is an `errors.jsonl` row (`serving_substitution`), and so is one with no evidence of the pinned model, unless the agent itself failed first (then it is a scored agent failure). A run whose agent sent another effort than `--effort` asked for, or none, is one too (`effort_not_sent`) |
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
  scores `pass: 0`). Averaging an absent value as 0 reads a capture problem as a regression. When the refusal
  names a file the capture budget left out, scope the judge to the files it grades with `evidence_files`
  ([scenario.md](./scenario.md)).
- **`skill_invoked`** is 1 or 0 for whether the run invoked the tracked skill (`meta.skill_tracked` names it). A
  blank means not measured: no skill was tracked, or the run's record could not tell.
- **Reps count from 0**: `rep: 0`, `traces/<id>_rep0.json`, `out/<id>_rep0/`.
- **An agent's own failure is a scored row**: every graded key 0, `meta.failure_class: "errored_agent"`, and the
  rule that classified it in `meta.termination_rule` (for example a run that ended asking for input). A row with
  `status: "truncated"` hit the output-token limit.
- **`errors.jsonl` holds what is not the skill's score**, by `failure_class`, with the rule in
  `meta.failure_rule`: `timeout` (the runner's bound), `error` (infrastructure; also a run whose content differs
  from the variant's snapshot, or a grade that does not line up with the scenario), `serving_substitution` (another
  model served the run, or no evidence of the pinned one, or the agent sent another effort than requested or none:
  `meta.failure_rule: "effort_not_sent"`) and `judge_invalid`. When several apply, a timeout wins,
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

## Model and effort per variant

Model and effort are the loop's biggest lever, and a staircase over them is usually the first experiment. Each
variant can run its own:

- **The main loop's model:** `--model <id>` (a concrete id) on the variant's passes.
- **The main loop's effort:** `--effort low|medium|high|xhigh|max` (`extra` is read as `xhigh`) on the variant's
  passes. Without it, each case runs its session's `effort:`, else the baseline's default (`medium`).
- **A sub-agent's model and effort:** the `model:` and `effort:` frontmatter of the plugin's `agents/*.md`. They
  are part of the plugin, so each variant's snapshot carries its own, outside the harness gate. This route has not
  yet been verified in a live run.

Neither flag is in the harness sha, so changing one needs no re-approval. Pass the same values on every pass of a
variant: a pass that would run a case at another model or effort than the variant's rows for that case ran is
refused before spending (see [Guardrails](#guardrails-the-harness-adds)).

**Effort levels are per model.** A level the model does not offer is refused before spending (`claude-sonnet-4-6`
has no `xhigh`), and so is any effort, from `--effort` or the session, on a model with no effort selector. Those are
the models the baseline lists with no levels and the ones the agent itself never sends an effort for (any
`claude-3-*`, `claude-opus-4-0`, `claude-opus-4-1`, `claude-sonnet-4-0`, `claude-sonnet-4-5`, `claude-haiku-4-5`, read
from agent 2.1.286), matched with or without a snapshot date (`claude-haiku-4-5-20251001`). `xhigh` or `max` with
the session's `extended_thinking: false` is refused too, since the agent lowers its effort when thinking is off, and
so is thinking off on a model that does not allow it. For a model the baseline lists no levels for, the pass prints
a note and the sent-effort check below decides.

**Requested and sent.** Every row records what it asked for and what the agent sent:

- `meta.model_requested` and `meta.effort`: the requested model pin and effort.
- `model` and `meta.effort_sent`: the model that served the main loop, and the effort its calls went out with. The
  agent writes that effort into its own session transcript for every main-loop call, after its own overrides,
  caps and clamps, and the run dir keeps the transcript; `meta.effort_sent` is read from there.

A row whose agent did not send the requested effort is an `errors.jsonl` row (`serving_substitution`,
`meta.failure_rule: "effort_not_sent"`), with one exception: an agent that failed before any main-loop assistant
message stays a scored agent failure (every graded key 0), its effort unconfirmed, as the served-model rule
treats a run with no model evidence. In detail:

- a main-loop assistant message sent with another effort, with a value that is not an effort level (never
  recorded), or with none: an error row, even when the agent then failed;
- no main-loop assistant message in the agent's transcript (or no transcript): an error row on a run whose main
  loop answered and whose agent did not fail; when the agent failed, the scored agent failure above, with no
  `meta.effort_sent`.

A model with no effort selector may send none: its rows record `meta.effort` (what the harness passed) beside
`meta.effort_selector: false`, and no `meta.effort_sent`. A comparison over effort therefore compares efforts the
agent sent. What remains unobserved is how the server treats a level it accepted.

`summary.json` records `model_requested`, `effort` and `effort_sent` over the variant's whole `results.jsonl`,
recomputed after every pass: the one value every row carries, or `"mixed"` when rows carry more than one, or when
some carry it and some do not (a `--case` pass at another effort, rows written before the field existed, or a
scored agent failure with no `effort_sent`); the key is left out only when no row carries it. It records `effort_selector: false` when every row's model has no effort
selector, `"mixed"` when only some do.

**A skill's own frontmatter moves the main loop.** `model:` or `effort:` in the tuned skill's `SKILL.md`
frontmatter applies to the main loop while the skill runs, not to a sub-agent. An `effort:` that changes the main
loop's effort makes the rows `effort_not_sent` error rows (seen when the skill is invoked as a slash command; not
verified for a skill the model invokes itself). A `model:` is expected to make every row `serving_substitution`;
this is inferred, not verified. Put sub-agent settings in `agents/*.md` instead.

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
declares `win_<vN>` only once no scored row lacks it). Run the fill without `--case`: rows of cases with no
pairwise assertion need the column too, and gain it with no judge call. A row whose case has no scenario file in
the target any more cannot be filled: it is listed, and lacks the column:

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
    Find each run dir by the row's `meta.run_id`: the runs root's `index.jsonl` maps each `runId` to its
    `outDir` (`<runs root>/<scenario slug>/<run_id>`, the dir `hillclimb regrade` reads; the root is `~/.cowork-harness/runs`, or `--run-dir` /
    `COWORK_HARNESS_RUNS_DIR`). A row's `meta.run_dir` is a pointer for reading one rep, and it is redacted
    when the runs root is outside your home directory.
    This needs the kept run dirs: the rows alone cannot rebuild judge spend, so a loop that sums only
    `results.jsonl` and `errors.jsonl`, as the loop's guide describes, undercounts it.
- **There is no spend cap on `hillclimb run`.** It takes no `--max-budget-usd`. Recompute spend from the files
  after every round, as the loop's guide does, and stop at your budget. (`--max-budget-usd` on `run` and `eval` is
  a pre-flight refusal priced from the agent's cost history, not a cap on spend: only a `--repeat` batch keeps a running
  total, and an `eval` is never stopped mid-way.)
- **A ballpark before you start.** A round is cases × reps agent runs, plus the judge calls of every judged
  assertion on every row (a `semantic_pairwise` assert makes one per reference it is judged against, and `order: both` doubles it). One
  live run observed about 33 s per pairwise judge call. Price one case first: the optional one-case baseline run in
  the [Quick start](#quick-start) shows a row's `cost_usd` and `latency_s`, and its kept run's `result.json` the
  judge's `judgeCostUsd`.
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
  `agent_env.subagent_model`) is shared by every variant and covered by the harness gate, so changing it is a gated edit
  that every later resume also runs; `--model` and `--effort` on the command line select the agent's model and
  effort outside the gate (see [Model and effort per variant](#model-and-effort-per-variant)), so leave them out of
  the allowlisted prefix if the loop's goal is moving to another model or effort. Cowork's system prompt is
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
- **`_state.json` gains `harness_skill`** beside `harness_sha` when you pass `--skill`, and `harness_files` (a
  sha256 per hashed entry, so a gate refusal names what changed); all are written only by `--approve-harness`. An
  approval without `harness_files` still loads: its refusal says `changed: unknown (older approval)` and lists
  every file.
- **`tags`** on a row is the scenario file's directory name. The loop stratifies a split by its first tag, so
  scenarios in one flat directory form one stratum.
- **No refusal class.** A model refusal is graded like any other answer; to count refusals, add an assertion
  or a metric for them.

### What a re-grade can and cannot change

`hillclimb regrade` re-grades the flow's rows from their kept run dirs, without running the agent:

- it re-evaluates a deterministic assertion (`file_exists`, `tool_called`, …) whose definition changed against
  the kept run, and re-measures every declared metric, so an assertion fix or a metric added mid-climb reaches
  the rows already written (a value the run itself measured is kept when the kept file cannot be read);
- when a harness upgrade changes how an unchanged assertion evaluates, it keeps the recorded outcome and notes
  it; edit the assertion, or re-run the case, to re-grade it;
- an assertion whose text contains a value the secret scrub removes is matched under this process's scrub. When
  this process reproduces the recorded text (the same secrets), it is re-graded like any other, and a re-judge
  sends the redacted rubric the live run sent, except that an edit inside the scrubbed literal (one secret for
  another) cannot be told from no edit. So once any of that case's assertions is edited, its rows are listed,
  untouched, on every re-grade until the case is re-run. When this process cannot reproduce the recorded text,
  the graded outcome is kept and the assertion is never re-evaluated or re-judged over scrubbed evidence: a
  re-judge it would need lists the row, with the remedy (re-grade with the run's scrub settings, or pass
  `--allow-doc-drift`, under which the judge sees the rubric as written against the scrubbed evidence, so its
  grade may not match the live run's). Stderr names such an assertion, since whether it was edited cannot be
  known: an edited one takes a re-run of the case;
- it re-judges a judged assertion when something the judge sees changed (its rubric or claims, its judge model or
  prompt template, or a `semantic_pairwise` assertion's references), recording why in
  `meta.regrade_rejudged_because`; `--rejudge` re-judges every one;
- it recomputes `pass` whenever an outcome it is graded with is not the run's own;
- `--fill-refs` judges only the pairwise comparisons a row lacks and never moves `pass`: a row whose fill would
  is listed instead. After a grader edit, run
  a default re-grade first: a fill lists the rows whose grader changed instead of filling them. `--rejudge` does not
  combine with `--fill-refs`.

A row is listed instead of re-graded when, among other cases (see the reference), its kept run dir is gone, or
when the evidence its judge read has changed since it was graded (an edited kept run, or a harness change to how
the document is composed or scrubbed); `--rejudge` grades the latter, unless the current evidence would be less
redacted than the graded one (that row stays listed until the run's scrub settings are set, or
`--rejudge --allow-doc-drift`). Each row records `meta.assert_sig`, the assertions it was graded under: `hillclimb
run` warns when a resumed pass would mix them, and `hillclimb check` flags a case whose rows carry more than one,
and a case whose rows were graded under another assertion set than its scenario's now — compared with the scenario
target when one is passed (`hillclimb check evals/ --flow <dir>`), else with the scenario files the last
`--approve-harness` hashed (`_state.json` `harness_files`), else those `harness_paths` lists. A recorded file
counts as a case's scenario when it has a `prompt:` and its stem is the case's id, so a session file named after
the case is not one. A note names a case it could not compare: nothing recorded, a recorded scenario not found
from the current directory (run `check` where the flow was approved), or, with a target, a case the target holds
no scenario for. The remedy's `regrade` target is one that hashes exactly the files the flow was approved over:
the scenarios' directory when it holds exactly them, else the case's own file (or its directory), else
`<scenarios>`.

## Guardrails the harness adds

- **The harness gate.** `hillclimb run` and `hillclimb regrade` refuse until `_state.json` holds an approved
  sha, and again whenever it changes. The sha covers every scenario file (all cases, whatever `--case`
  selects), each session file, its uploads and workspace fixtures, the lockfiles in the current directory, the
  `harness_paths` entries, the `--skill` selection, and the harness version and baseline. It never covers the
  plugin the loop edits. Upgrading `cowork-harness`, or a `sync` that moves a case's Desktop baseline (not the
  `baseline` variant), therefore trips it: that is the loop's
  re-baseline signal. With no lockfile in the current directory, dependency changes are outside the sha (a pass
  says so). `--model`, `--effort` and `--judge-model` are not in it. `hillclimb freeze-ref` needs no approval: the gate covers
  `run` and `regrade`. `--approve-harness` is yours to pass, never the loop's.
- **One model and effort per case in a variant.** A pass that would run a case at another requested model or
  effort than the variant's rows for that case recorded (`meta.model_requested`, `meta.effort`) is refused before
  spending, naming the case, what the rows ran and what the pass would run: run the change as a new variant, or
  keep the setting the rows ran with. Rows written before those fields existed are held to the model that served
  them (a dated snapshot of the pin counts as the pin), and warn when they record none; their effort is unknown,
  which always warns. A case whose model has no effort selector is not held to its rows' effort when they say
  so too (`meta.effort_selector: false`): that effort is only the baseline default, which a `sync` may move.
  Another variant is free to differ: that is the lever. A `--case` pass whose flag value differs from what the
  variant's other cases ran prints one warning per distinct value those cases ran.
- **No answer key in reach.** A pass is refused when the agent could read the flow dir, a scenario or session
  file, a `harness_paths` file or the runs root through a mount, a workspace fixture or the plugin. A file
  listed in `harness_paths` that sits inside a workspace fixture counts as an input and is not refused, so keep
  graders outside fixtures.
- **The headroom warning.** `hillclimb check`, and the end of every baseline pass, warn about the cases whose
  baseline reps are all at the good or bad end of the headline metric. It never changes the exit code.
- **Run labels.** Every run is labelled `hillclimb:<flow dir name>:<variant>` in the run index (`stats --label`).
  Two flows whose directories share a name share a label. These runs are left out of the cost history that
  `--dry-run` and `eval --dry-run` price from.

## What a round can and cannot see

- **A metric is read from a file the run writes,** so the skill under test writes it, and an edit can move the
  number without improving the work. Never have the skill compute its own score; put the ground truth in the
  scenario, as `artifact_json` expected values or rubric claims.
- **The judge sees no uploads and no tool results** (except a `Skill` call's result under
  `include_fork_results: true`). It reads the final message, the assistant's transcript text
  and the files the run wrote ([scenario.md](./scenario.md), `semantic_matches`). To grade faithfulness to an
  uploaded document, write the source facts into the rubric.
- **The harness gate does not hash connected-folder contents or live web responses.** A case that reads either can
  move between rounds with no edit, and a tool result is never judged. Freeze such inputs for the climb, as uploads
  or a workspace fixture, which the gate covers.
- **A variant that rewords or batches its questions can miss the scripted `answers:`.** The run ends asking for
  input and is scored as an agent failure (every key 0): read `meta.termination_rule` before blaming quality. A fix
  to `answers:` is a gated scenario edit, but it marks no row stale (`meta.assert_sig` covers `assert` and
  `expect_denied` only) and a re-grade cannot answer a question again, so start a fresh flow dir (its own `state-template` and
  `--dry-run --approve-harness` first, as in the [Quick start](#quick-start)) and run the baseline there: in this flow every slot already has a row, and a pass resumes by slot.
- **Judge variance.** Set `order: both` on a `semantic_pairwise` assert to cancel position bias. The frozen
  reference is one sample (the lowest-rep good row), so an unusually good or bad reference shifts every comparison.
- **Effort and the sub-agent model are session-level.** `effort` and `agent_env.subagent_model` are read from the session
  file, which every variant shares and the harness gate covers, so one flow runs every variant at one setting, and
  a change is a gated edit that every later resume also runs. The loop's guide can climb a staircase of model and
  effort settings, which does not map onto one flow.
  `hillclimb run` takes no per-variant effort or sub-agent model flag: to compare settings, run one flow per setting, from a scenario directory whose session sets it.
- **Deciders and concurrency.** `--decider-cmd` and `--decider-dir` need `--concurrency 1`; a scenario's
  `on_unanswered: llm` does not. `latency_s` is measured under the pass's concurrency, so compare latency only
  between passes at the same `--concurrency`.
- **Confirm a winner with `eval` before merging.** A round's delta is directional; `eval` runs a paired,
  interleaved comparison of the baseline and the winning plugin versions with pinned models ([eval.md](./eval.md)).

## What hillclimb is not for

- Multi-turn conversations: every case is one prompt.
- Comparing session-level settings other than model and effort (for example `agent_env.subagent_model` or
  `extended_thinking`) within one flow: those are gated and shared by every variant. Vary a sub-agent's model and
  effort through the plugin's `agents/*.md` instead (see [Model and effort per variant](#model-and-effort-per-variant)).
- Cases that read live web content or a connected folder that changes between rounds.
- A score the skill computes about itself.
- A significance claim to publish: use `eval`.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `no usable agent credential for fidelity <tier>` | No credential source resolves: put `CLAUDE_CODE_OAUTH_TOKEN` in `./.env` or the environment, or pass `--dotenv <file>` (a git worktree has no copy of the main checkout's `.env`). `cowork-harness doctor --tier <tier>` runs the same check |
| `run ended error (auth)` | A credential was found but the agent could not authenticate with it (expired or revoked: `claude setup-token`), or at container or microvm only `ANTHROPIC_AUTH_TOKEN` is set, which does not reach the agent there. The pass prints the sources it looks up once |
| `[baseline] reference freeze: skipped` | The case has no good row to freeze its reference from yet (its slots failed). The next baseline pass that scores one freezes it, or `hillclimb freeze-ref … --variant baseline --case <id>` |
| `no approved harness sha` / `harness changed since last approved run` | Review the files the message names as changed, then `hillclimb run … --dry-run --approve-harness` with the loop's `--skill`. A change you did not make: check the working directory and the target path |
| A resumed variant refuses: snapshot missing | The flow dir moved, or the snapshot root was cleaned. Restore it, or run into a new variant |
| A file the skill needs is missing in the run | It is untracked: `git add` it before the variant's first run (the pass printed a count of untracked files) |
| `skill_invoked` is blank | The plugin has several skills (pass `--skill <name>`, the bare name, on every pass), it has none, or the run's record could not tell (`meta.skill_tracked` is set but the cell is blank) |
| A non-baseline pass refuses on a pairwise case | The baseline reference is missing: `hillclimb freeze-ref … --variant baseline --case <id>`, or, when the message says freezing cannot repair it, a fresh flow dir |
| The same slots run on every pass | They are `errors.jsonl` rows with a permanent fault; read `failure_class` and `error` |
| `regrade` lists rows "kept run dir is gone" | Pass the `--run-dir` the runs were written with; a removed run cannot be re-graded (`prune --include-hillclimb` removes them) |
| A new metric or `win_<vN>` column is missing on older rows | They were written before it: fill a metric with `hillclimb regrade` (a row reading `no_manifest` needs a re-run), a reference's column with `hillclimb regrade --flow <dir> --fill-refs`, before comparing. A row whose case has no scenario file in the target is listed instead and stays without it |
