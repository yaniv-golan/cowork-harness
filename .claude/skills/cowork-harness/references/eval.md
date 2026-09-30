# `eval` — paired before/after comparison of a skill edit (EXPERIMENTAL)

Tracks `cowork-harness 4.1.1` (baseline `desktop-2.16120.0`). The full guide is
[docs/eval.md](https://github.com/yaniv-golan/cowork-harness/blob/main/docs/eval.md); this is the part you
need while running it.

```bash
cowork-harness eval <scenario.yaml | dir/> --arm before=git:HEAD:plugins/my-skill --arm after=./plugins/my-skill \
  --model <concrete id> --judge-model <concrete id> [--holdout <scenario.yaml>]... [--fail-on possible|confirmed]
cowork-harness eval report <eval-dir>     # rebuild the report from the eval dir, no spend
```

## What it does

- Two arms: a plugin directory, or `git:<ref>:<path>` (read from the commit, `<path>` relative to the repo
  root). The FIRST arm is the baseline; a drop is the second arm passing less often.
- Only the session's single `plugins.local_plugins` entry is substituted. Each arm is copied once, before
  the first run, and every rep mounts the copy.
- scenarios × 2 × `--reps` live runs (10 per scenario at the default `--reps 5`), interleaved, plus one judge
  call per `semantic_matches` assert per run. The start-up line prints the job count. No budget flag.
- In a scenario directory, YAML with no `prompt:` (a session file) is skipped.
- Run an A/A first (`--allow-identical-arms`, the same source twice) to see your scenarios' noise.

## Reading the labels

| Label | Meaning |
|---|---|
| `confirmed drop/rise` | significant after the correction (bh q = 0.10, or holm) |
| `possible drop/rise` | p ≤ `--alpha` (0.05), not confirmed |
| `no detectable change` | with the smallest change this n could have detected (MDD) |
| `underpowered` | no outcome at these sizes could reach `--alpha` — NOT "no change" |
| `insufficient` | too few valid reps in an arm (4 of 5 needed by default) |

A drop is a signal to investigate, not proof: open the run dirs the report links for that row. In order,
first match wins: an infrastructure failure is excluded and reported — including a rep where no model
answered (the agent's `Not logged in` / `Authentication required` reply, rule `auth`; a usage or
spend limit as its final message, even on a nonzero exit after spend, rule `usage_limit`; or only
`<synthetic>` models at $0, rule `no_model_answered`). An agent-caused failure (timeout, max turns,
unanswered question, crash) then fails every row of its rep, even with its pin unknown. Only after that
are a pin the agent did not honour (false, or unknown on a rep that completed) and a snapshot that changed
excluded and reported. A loud UNCLASSIFIED count means a termination the classifier does not know — read
those runs. Per scenario: if EVERY rep of both arms errored, or every rep of one arm is infrastructure,
that scenario compared nothing — its rows are `insufficient` and the eval exits 1. If one arm's every rep
is the agent's own failure and the other arm ran, the reps are scored (a real drop) — exit 0 unless
`--fail-on`. Either way the header
names the arm, scenario, dominant error and a matching hint (`Every rep of arm <label> in <scenario> errored — …`).

## Refused before any run (exit 2)

- a model or judge that is an alias (`opus`, `best`) rather than a concrete id;
- an eval dir inside any git work tree (the snapshots would mount empty);
- identical arms (unless `--allow-identical-arms`);
- an arm that contains the eval's own scenario or session files (by location, copy or symlink), an
  `evals.json`, or a symlink resolving outside it;
- a scenario input a run would refuse (a missing path, a `tool_not_called` the tier can never violate);
- `--fail-on confirmed` when no row could reach `confirmed` at this `--reps`;
- no usable agent credential for a scenario's tier — the same check as `doctor --tier <tier>`'s `token` row,
  with its fix. A Keychain login or a `.credentials.json` in the config dir, without an env/.env token,
  passes only at `protocol`.

## Exit codes

`0` completed — no drop fails the eval unless you pass `--fail-on`. `1` a drop at the `--fail-on` level,
every row `insufficient`, a scenario that compared nothing, or the judge model differed across reps (an A/A run under `--fail-on possible`
can exit 1 on noise). `2` usage or a refusal. `3` an arm snapshot could not be copied or staged.

## Files

`<eval-dir>/` (default `~/.cowork-harness/evals/<eval-id>/`): `manifest.json`, `arms/`, `runs.jsonl`,
`report.json` (every rep with its bucket), `report.md`. The runs are ordinary run dirs labelled
`eval:<eval-id>:<arm>`; a bare `prune` keeps 5 per scenario and says which evals it trimmed — `eval report`
still works, but the evidence links then dangle.
