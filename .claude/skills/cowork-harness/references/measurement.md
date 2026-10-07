# Measurement

Tracks `cowork-harness 4.5.0` (baseline `desktop-2.26454.0`). Read it before comparing runs: `--repeat`, `--ablate-skill`, and the hygiene that keeps a batch valid.

### Measure — before/after, with/without (`--repeat`, `--ablate-skill`)

A single green proves the run passed **once**. Two questions need more than that, and both have a
discipline that is cheap to follow and expensive to skip.

**"Did it pass, or pass once?"** → `--repeat N` (2-100, on `skill` AND `run`) samples the same
skill+prompt N times and prints a variance rollup instead of a single verdict. `--min-pass-rate` sets
the batch threshold, `--stop-on-diverge` stops the moment flakiness is proven, `--max-budget-usd` caps
spend. The cap counts each run's `cost.usd` only — the agent session — and estimates a single run
from prior runs' `cost.usd`; the `semantic_matches` judge and the LLM decider (`on_unanswered: llm` /
`--decider-llm`) are separate model calls it never sees.

**"Does the skill actually help?"** → `--ablate-skill` runs the prompt with every skill/plugin
discovery source removed, so the agent answers from its own priors. **It is ONE arm, not a paired
experiment**: this invocation is the control. Run the same prompt a second time *without* the flag for
the treatment arm and compare them yourself. Composed with `--repeat 5` it produces **5 ablated runs
and 0 treatment runs** — N samples of the control, which is the intended reading and is not an A/B.
The rollup says so on its verdict line: `repeat "<skill>": PASS [ABLATED — control arm] — 5/5 passed`.
Every ablated run is stamped `ablated: true` in `result.json` and carries `ablated=true` on its
`[provenance]` footer line; a run that isn't stamped is a real run.
What the harness gives you here is the run execution and the control arm — designing the comparison
(scrubbing giveaways, shuffling, judging blind, unblinding only after grading) is still yours.

**"Did my edit change it?"** → `cowork-harness eval` (EXPERIMENTAL): the version before your edit and the
one after, interleaved, with the agent and judge models pinned, compared per assertion and per rubric
claim with an exact test. It is a regression signal to investigate, not proof — see
[`eval.md`](eval.md) and Recipe 5 step 6 in [`task-recipes.md`](task-recipes.md).

### Tool timing — what `toolDurations` measures

`result.json`'s `toolDurations` and `trace <run> --view tool-durations` report, per tool, the **wall gap
from `tool_use` to `tool_result`** as the harness saw them (`toolDurationsBasis: "wall_gap"`). That gap
includes model/transport and permission latency, and an `Agent`/`Task` entry spans its whole sub-agent
run, so it is not execution time and summing it across tools double-counts. `calls`, `totalMs` and
`maxMs` cover paired calls only; `unpaired` counts calls never paired with a `tool_result` the harness observed, which have no duration.
The fold covers main-agent and sub-agent calls alike, where observed (microvm sub-agent result delivery is unobserved). Narrow the trace view with `--scope main|subagent`,
which reads the run's own classification from `result.json`, and add `--per-call` for one row per call.
Compare timings between runs of the same tier and model only.

**Measurement hygiene — four things that silently invalidate a batch:**

1. **Pin the model in the session.** A run that resolves no model is refused, but one pinned only by
   `COWORK_HARNESS_MODEL` takes its model from the machine, so two shells can run two models. Set
   `model:` in the session (or pass the same `--model` on every `skill` run). Adding `model:` to a session
   that already has cassettes re-stales them (`verify-cassettes` exits 1 — the model is in the session
   fingerprint); to pin without re-recording now, use `--model` or `COWORK_HARNESS_MODEL` and move the
   pin into the session at the next re-record. Read `result.json`'s `models` back before believing any cross-run comparison — and when
   you do, **ignore any entry wrapped in angle brackets**: `<synthetic>` is the agent marking a turn it
   fabricated locally (no API call), not a model, so two runs of the same pinned model can differ on this
   array purely by whether such a turn occurred.
2. **Freeze a recoverable source first**: commit it, or snapshot the skill folder next to the run dir.
   `fingerprint.skillHash` is content-exact but one-way, so an edit mid-batch silently splits your
   dataset into two generations — and a hash whose source was never frozen identifies a generation that
   is unrecoverable. `stats --group-by skill-hash` separates them after the fact; nothing recovers the
   source. (`stats --reindex` rebuilds the runs index from the run dirs when it is lost or predates it.)
3. **Check which arm you actually ran** before analysing anything: `ablated` and
   `context.availableSkills` in each `result.json`.
4. **Classify each rep three ways**: invocation (`skillsInvoked`), observed source access (did it read
   `SKILL.md` directly?) and answer quality. "Not invoked" is not "answered from priors" outside the
   ablated arm — see [Recipe 5](./task-recipes.md), step 3.
