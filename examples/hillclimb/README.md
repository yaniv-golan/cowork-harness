# A hillclimb walkthrough: improving a deliberately weak skill

This example lets you watch Claude Code's `/claude-api hillclimb` loop improve a skill, with
`cowork-harness hillclimb run` as the runner every round goes through. Everything in it is synthetic.

> **Don't copy this skill.** `plugin/skills/sales-brief/` is weak on purpose. Its whole instruction is "write a short
> brief to `outputs/brief.md`", and it never mentions the profiler script it ships with. It exists to give the loop
> something to fix. Copy the setup (the cases, the session, the commands), not the skill.

## What is in it

| Path | What it is |
|---|---|
| `plugin/` | `sales-brief-example`: one skill, `sales-brief`, plus its bundled `scripts/profile.py` |
| `data/orders.csv` | 24 synthetic orders. One order is repeated, one has no amount, one is all zeros |
| `sessions/sales-brief.yaml` | The session every case runs: the agent model, the CSV as an upload, the plugin |
| `scenarios/` | Four cases, each checked a different way (below) |

| Case | What it checks | How |
|---|---|---|
| `totals` | The total and the leading region come from the skill's own profiler | `artifact_json` on `outputs/metrics.json`, `artifact_text`, and a metric |
| `data-quality` | The brief flags the problems in the data, unprompted | `artifact_text` on the order ids, and a three-claim rubric graded by a judge |
| `manager-brief` | The brief is better for a manager than an earlier one | `semantic_pairwise` against a frozen reference, in both presentation orders |
| `control-regions` | A request the weak skill already meets keeps working | `artifact_text` |

## Before you start

- **Claude Code with the `/claude-api` skill's `hillclimb` mode** (2.1.260 or later), to run the loop.
- **The cowork-harness companion skill in Claude Code**, which holds the recipe the loop follows:
  `/plugin marketplace add yaniv-golan/cowork-harness`, then `/plugin install cowork-harness@cowork-harness`.
- **What a `container` case needs**: Docker, the Cowork agent staged by Claude Desktop (open Desktop once) or
  `COWORK_AGENT_BINARY`, and a credential the agent can use. Check all of it with
  `cowork-harness doctor --tier container`; see [docs/cli.md](../../docs/cli.md#prerequisites-for-anything-above-protocol-fidelity).
- **A copy of this folder outside the installed package.** The loop edits the skill; don't let it edit your install.
  If you put the copy inside a git repository, `git add` the whole folder: inside a git work tree the harness stages
  only tracked files, and an untracked plugin is refused with "the plugin hashes to nothing".
- **A flow dir outside `.claude/`.** Claude Code protects `.claude/`, so an allow rule cannot cover the loop's own
  writes there ([docs/hillclimb.md](../../docs/hillclimb.md#where-the-flow-dir-goes)).

## Run it

```bash
# Copy the example out. From an npm install (use `npm root` instead of `npm root -g` for a local install):
cp -R "$(npm root -g)/cowork-harness/examples/hillclimb" ~/hc-demo
# … or from a clone of the repository: cp -R examples/hillclimb ~/hc-demo
cd ~/hc-demo
cowork-harness doctor --tier container

# 1. The flow dir and the _state.json skeleton the loop starts from.
mkdir -p ~/hc-demo-flow
cowork-harness hillclimb state-template scenarios/ --flow ~/hc-demo-flow > ~/hc-demo-flow/_state.json

# 2. Review what the harness gate covers, then record its sha. Spends nothing. (From a copied folder it notes that
#    there is no lockfile in the current directory; that is expected here.)
cowork-harness hillclimb run scenarios/ --flow ~/hc-demo-flow --model claude-sonnet-5 --judge-model claude-opus-4-8 --concurrency 2 --reps 5 --dry-run
cowork-harness hillclimb run scenarios/ --flow ~/hc-demo-flow --model claude-sonnet-5 --judge-model claude-opus-4-8 --concurrency 2 --reps 5 --dry-run --approve-harness
```

Then start Claude Code in `~/hc-demo` and send this as the first message:

```text
/claude-api hillclimb the sales-brief skill in plugin/. Read references/hillclimb-recipe.md from the
cowork-harness skill and follow it. The runner (append --variant <v> --reps 5):
cowork-harness hillclimb run scenarios/ --flow ~/hc-demo-flow --model claude-sonnet-5 --judge-model claude-opus-4-8 --concurrency 2
Flow dir ~/hc-demo-flow. Reps 5, no split. The lever is the skill folder plugin/skills/sales-brief/ only;
the scenarios, the data and the session are off-limits.
```

When it asks: the goal is `pass`. "One round at a time" lets you look at each round before the next. Give it a
budget. Before the baseline it runs a no-skill check in a sibling flow, `~/hc-demo-flow-null`: run steps 1 and 2
again with that `--flow` when it asks. The loop never passes `--approve-harness`; if a round stops on the harness
gate, look at the change and re-run step 2's second command yourself, with that round's `--flow`.

**Permission prompts.** In default permission mode the loop wraps the runner in its own shell command (a `cd`, a log
redirect, an exit-code echo) and keeps its records with shell commands, so expect a few prompts each round. An allow
rule for the runner covers only the bare command. In auto mode, rounds can run without prompts.

## What it costs and how long it takes

Measured on one run of this example: agent `claude-sonnet-5` in the container tier, judge `claude-opus-4-8`, five reps
per case, concurrency 2.

- **Per round** (20 agent runs): about $2.40-$2.80 for the agent and $0.35-$2.15 for the judge, at list price. The judge share
  grows with each frozen reference the head-to-head case is compared with. A pass took 6-11 minutes, plus the loop's
  own reading and editing.
- **A whole climb** (the loop's no-skill check, the baseline and four rounds): about $21 at list price (agent $15.84,
  judge $5.35), plus the loop's own Claude Code usage, which the harness doesn't count. In the measured run round 3's
  brief was also frozen as a second reference by hand after round 3: re-judging the earlier rows against it cost
  about $2.23 more, and it doubled round 4's head-to-head judge calls.
- These are the agent's own cost figures. On a claude.ai subscription login they are list-price estimates, not
  charges (`billing_basis` in each variant's `summary.json`). `--dry-run` prices from runs already on your machine,
  so on a fresh install it shows a lower bound of $0.

## What you should see

Results vary by model and by run; five reps per case is enough to see large effects, not small ones. On the run
measured here:

| Round | The loop's change | pass | totals | win vs the baseline brief | agent $/run |
|---|---|---|---|---|---|
| no skill | skill removed (the loop's check that the skill matters) | 0.00 | 0/5 | — | $0.138 |
| baseline | — | 0.75 | 0/5 | 0.50 (against itself) | $0.140 |
| 1 | run the bundled profiler into `outputs/` (rejected) | 0.60 | 3/5 | 0.00 | $0.134 |
| 2 | the profiler, writing to the user-visible outputs folder (rejected) | 0.75 | 5/5 | 0.00 | $0.121 |
| 3 | the brief's figures leave out the rows it flags | 0.90 | 5/5 | 0.30 | $0.129 |
| 4 | the brief ends with one concrete recommended action | 0.95 | 5/5 | 0.80 | $0.130 |

- **Round 1.** The loop read the traces: the agent listed `scripts/`, read `profile.py`, then ignored it. It added a
  "run the profiler" step. Pass fell, and the loop rejected the change, naming two causes: a relative `outputs/`,
  which Cowork resolves against the session root, a folder the user never sees; and a raw-versus-corrected total
  that muddled the brief's opening. The judge preferred the baseline brief on all five runs, in both orders.
- **Round 2.** The profiler wrote to the absolute user-visible folder, and the brief instruction was dropped. `totals`
  went to 5/5, but the brief lost every head-to-head again: "the candidate flags order 1017 as a duplicate yet still
  includes its $1,800 in the headline $26,300". Rejected.
- **Round 3.** The brief computes its own figures with the flagged rows left out. Three of five head-to-heads became
  ties. The two losses: "ends on an italic file-pointer note rather than an action".
- **Round 4.** The loop's own next lever. The brief won four of five head-to-heads, consistently in both orders: "the
  candidate ends with a dedicated, concrete sales recommendation".

**Read it honestly.**
- **The real defect was fixed beyond noise.** A skill that never told the agent to run its own profiler: pass on the three cases without
  the head-to-head went from 10/15 to 15/15 (one-sided Fisher p = 0.021).
- **Round 4's head-to-head win is directional, not proven.** Four wins and one loss at five runs.
- **One expected weakness didn't show up.** The data-quality case was meant to fail without an instruction to check
  the data; Sonnet 5 flagged both problems on every run anyway.
- **The measured run predates some renaming.** The cases and the plugin had different names, and the skill files had
  no comments. The prompts, checks, rubrics, data and skill body are the same.

## Practices worth copying

- **Pin the agent and the judge** (`--model`, `--judge-model`), and check `model` and `judge_model` on each round's rows.
- **Use enough reps to see the effect you care about.** Five per case separates 0/5 from 5/5; it can't separate 0.5
  from 0.7.
- **Mix the checks:** deterministic assertions for what can be checked exactly, a rubric for what a judge must read, and
  a head-to-head against a frozen reference for "better", not just "passes".
- **Keep a control case** that already passes, so a regression shows.
- **Write down what you expect before the first paid round** (which cases fail, by how much, and what counts as noise),
  and report a round that doesn't beat it.
- **Keep the flow dir outside `.claude/`**, and use auto mode or allow rules if you want rounds to run unattended.
- **Let the loop reject changes.** Two of the four rounds here were rejected, each with a diagnosis.

See [docs/hillclimb.md](../../docs/hillclimb.md) for every command, flag and difference from the loop's own runner.
