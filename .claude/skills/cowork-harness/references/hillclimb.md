# `hillclimb` — the runner for a `/claude-api hillclimb` loop

Tracks `cowork-harness 4.2.0` (baseline `desktop-2.16120.0`). `hillclimb` is new after 4.2.0: on an older CLI
`cowork-harness hillclimb --help` is an unknown command. The command reference is
[docs/cli.md](https://github.com/yaniv-golan/cowork-harness/blob/main/docs/cli.md); this is the part a loop needs
while it runs. It covers `run`, `check` and `state-template`.

```bash
cowork-harness hillclimb state-template evals/ --flow .claude/hillclimb/flow   # save stdout as <flow>/_state.json
cowork-harness hillclimb run evals/ --flow .claude/hillclimb/flow --variant baseline --approve-harness   # you, once
cowork-harness hillclimb run evals/ --flow .claude/hillclimb/flow --variant v1 --reps 3
cowork-harness hillclimb check --flow .claude/hillclimb/flow
```

## Always pass `--flow`

All three commands default to `.claude/hillclimb/flow`, but pass `--flow <dir>` to every one, the same dir each
time:

- `state-template` writes the metrics legend to `<flow>/metrics.md` only when `--flow` is given. Without it,
  only the `_state.json` skeleton is printed (and a note on stderr says the legend was not written).
- A loop whose flow dir is anywhere else must name it on every call, or `check` reads a flow the runs never
  wrote, and `run` resumes into the wrong one.
- Keep each null run (`--ablate`) in its own sibling flow (`<flow>-null`). A flow that mixes ablated and
  scored rows is refused.

## The loop's commands

- **`hillclimb state-template <scenario.yaml | dir/> --flow <dir>`** prints the `_state.json` skeleton
  (`metrics`, `perf_fields`, `harness_paths`) to stdout. Save it as `<flow>/_state.json`. On a re-run, after a
  metric was added, merge only the NEW `metrics` entries: the rest of `_state.json` belongs to the loop. An
  existing `metrics.md` that differs is never overwritten; the new legend goes to `metrics.md.new` beside it.
- **`hillclimb run <scenario.yaml | dir/> --flow <dir> --variant baseline|v<N>`** runs every scenario
  `--reps` times (default 1) into `<flow>/<variant>/`: `results.jsonl`, `errors.jsonl`,
  `traces/<id>_rep<k>.json`, `progress.txt`, `summary.json`. stdout stays silent (except one envelope under
  `--output-format json`); progress goes to stderr every 30 s and to `progress.txt`.
- **`hillclimb check --flow <dir>`** checks the flow dir against our reading of the published hillclimb schema
  and the `_state.json` metric declarations, and warns when a baseline case has no headroom (every rep at the
  ceiling or the floor of the headline metric). The warning never changes the exit code.

A case is one scenario file. Its id is the file stem, made path-safe; `--case <id>` (repeatable) runs one case
by its stem or its scenario `name:`. In a directory, YAML with no `prompt:` (a session file) is skipped.

## The flags of `run`

`--flow DIR`, `--variant ID` (`baseline` or `v<N>`, N ≥ 1, no leading zero; default `baseline`), `--reps N`
(default 1), `--concurrency N` (default 4; 1 with a decider), `--timeout-s N` (default 1800; 0 = none; it bounds
the whole attempt, the judge included), `--model ID` and `--judge-model ID` (concrete ids; an alias is refused),
`--case ID`, `--approve-harness`, `--ablate`, `--dry-run`, `--no-copy-inputs`, `--decider-cmd CMD` or
`--decider-dir DIR`, `--output-format text|json`, `--dotenv FILE`, `--run-dir DIR`.

- **Resume is by slot.** A re-run of the same variant runs only the (case, rep) slots with no row in
  `results.jsonl`. A slot with only an `errors.jsonl` row re-runs on every pass, so a permanent fault re-runs
  forever; the scope line names those slots. Raising `--reps` adds reps.
- **Each variant runs from a snapshot** of the plugin taken on its first run, so a resumed or appended rep
  measures that variant, not the plugin the loop has since edited. Snapshots live in
  `~/.cowork-harness/hillclimb-snapshots` (`COWORK_HARNESS_HILLCLIMB_SNAPSHOTS` moves them: an absolute path
  outside any git work tree).
- **`--dry-run`** makes every check a pass makes, prints the slots it would run and a cost estimate from this
  machine's run history, and writes nothing.
- One runner per variant: a `.lock` in the variant dir refuses a second live runner.

## The harness gate — `--approve-harness` is yours, never the loop's

`run` refuses (exit 2) until `_state.json` holds an approved `harness_sha`, and again whenever it changes. The
sha covers every scenario file, its session file and its uploads, the lockfiles in the current directory, the
`_state.json` `harness_paths` entries, and the harness version and baseline. The plugin the loop edits is never
in it, and a `harness_paths` entry inside that plugin is refused. Review the change, then run once with
`--approve-harness` to record the new sha. It is a change detector, not a security boundary: the permission
allowlist on the loop's command is what bounds an unattended run.

## Refused before any spend (exit 2)

- an alias model or judge model, a case pinned to no concrete model;
- a session that does not declare exactly one `plugins.local_plugins` entry (the same one in every case), an
  inline session, or `on_unanswered: prompt`;
- `fidelity: protocol` without a managed config dir (its traces would miss the sub-agents' turns);
- a scenario or session file, or the flow dir, readable by the agent through a mount;
- duplicate or unusable case ids, an unknown `--case`, a `_state.json` that is not a JSON object;
- an unapproved or changed harness (see above), a missing variant snapshot, a live lock;
- a decider with `--concurrency` above 1.

The full list is in [SPEC.md §11](https://github.com/yaniv-golan/cowork-harness/blob/main/SPEC.md#11-machine-output---output-format-json).

## Exit codes

- `run`: `0` every attempted (case, rep) was scored; `1` an attempt failed (an `errors.jsonl` row, or a scored
  row whose trace or copies could not be written), the pass stopped mid-run (rows already written are kept),
  or `summary.json` could not be written; `2` refused before spending. `--dry-run` exits `0` unless a refusal fires.
- `check`: `0` clean, `1` an error finding, `2` usage.
- `state-template`: `0`, or `2` on usage or a refusal.

## What lands in the flow dir

Rows carry the per-assertion and rubric-claim grades, the served model, token usage, cost, latency, and
`skill_invoked`. A session's uploads are copied into `<flow>/inputs/` (`--no-copy-inputs` skips that), and the
files a run authored into `<flow>/<variant>/out/`. Text copies are secret-scrubbed and host-path-redacted; any
other file (a PDF, a spreadsheet) is copied as it is. A trace opens with the system append the agent was spawned
with (Anthropic's built-in system prompt withheld) and inlines each sub-agent's turns after its dispatch. Before
committing a flow dir, check what `inputs/` and `out/` hold.
