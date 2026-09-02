# Critique — the facts a plugin install can't otherwise reach

Tracks `cowork-harness 3.2.1` (baseline `desktop-1.40609.1`). This is **not** a trim of the full
[`docs/critique.md`](https://github.com/yaniv-golan/cowork-harness/blob/main/docs/critique.md) (repo-only —
flags, cost, reproduction discipline, known limitations all live there). This file covers exactly what a
plugin install cannot otherwise discover: the run-dir artifact a harvester actually reads, the report's
real field names, and what the evaluator was and was not shown. See **Recipe 5** in `task-recipes.md` for
the harvest → reproduce → fix loop this feeds.

## The run-dir artifact a harvester reads

Beyond `critique-report.json` (the machine-readable report), a critique writes **`critique-evidence-package.txt`**
at the run-dir root whenever the evaluator ran — the **armored** corpus the evaluator was actually graded
against. Re-grade a disputed finding **offline** against this exact file instead of re-running the skill: a
finding's `evidence` excerpt must resolve verbatim against this package, or it landed in `DROPPED`.

| File | When | What |
|---|---|---|
| `critique-report.json` | always | the report a harvester parses |
| `critique-evidence-package.txt` | evaluator ran | the exact armored corpus graded — re-gradeable offline |
| `critique-salvage.json` | exit 2 only | raw pre-parse evaluator replies, for salvage without console-scraping |

## Cost across critiques — the index, not the reports

A critique is FOUR model workloads but only TWO produce a run, so only two produce index rows; the
evaluator passes produce none. Each critique therefore appends a **roll-up row** (`critiqueRole:"rollup"`)
carrying `critiqueTotalUsd` — the whole four-workload spend. Its own `costUsd` is the **evaluator passes
only**, so `sum(costUsd)` over every row is exactly true spend with nothing double-counted or missed. The
turn rows carry `critiqueRole:"task"` / `"reflection"`.

Two things a harvester needs: roll-ups are excluded from `stats` aggregation (they carry no verdict —
counting them adds a phantom run and drags `passRate` toward 1), so **filter them out of any pass-rate
computed over raw rows** — that exclusion also governs `stats --group-by skill-hash`, so a per-generation
**total spend** still needs the raw rows (only the roll-up carries the evaluator passes); and a roll-up with `result:"error"` had an unpriced workload, so its totals
UNDERCOUNT. The index is the only cost record that survives run-dir pruning.

## An exit-2 report — which turn failed, and whether it was really infrastructure

Exit 2 means no findings were produced, so the report's only job is to say what went wrong. Three fields
carry that; read all three before touching anything.

| Field | Meaning |
|---|---|
| `infraFailure` | the reason |
| `infraFailurePhase` | `task turn` (the graded run) or `reflection turn` (critique's own protocol turn) |
| `infraFailureKind` | why it failed — a harness `ErrCategory` (error envelope, exit 2/3) **or** a `resultErrorKind` (`usage_limit`/`transport`/`agent`) from a turn that RAN and errored (exit 1, top-level `error: null`). **Absent** = killed, or no envelope |
| `gradedErrorReason` | on a `taskResult: "error"` run (still gradeable, exit 0): why the GRADED turn errored, so a quota exhaustion is not read as a skill defect |

**Do NOT read "has a kind" as "the instrument is fine".** The CLI's top-level catch turns every
unexpected throw into category **`internal`** — Docker down, container start failure, missing staged
agent, harness bug — and `runtime` carries a refused run dir. Only **`unanswered`, `usage`, `boundary`**
and, from the result-row taxonomy, **`usage_limit`** (quota exhausted — retry after reset) and
**`transport`** (a tail-end drop) are the caller's problem. `agent` is not: for critique's own protocol
turn that IS the instrument breaking. The header encodes exactly that split and fails closed (an
unrecognized kind renders as infrastructure):

- `RUN FAILED (<turn>, <kind>): …` → ordinary, actionable, instrument healthy.
- `INFRASTRUCTURE/PROTOCOL FAILURE (<turn>): …` → `internal`/`runtime`/`agent`/unknown/killed/no-envelope.

**A turn that exits 1 is not a crash.** It RAN and reported an errored result, with `error: null` and a
full `results[0]` — an exit-code-only reading of that path is what leaves an exhausted quota looking like
a broken instrument.

**Read the reason, not the category.** The reason carries the failed turn's own message *and* hint
verbatim. That matters most for `unanswered`, which is 36 distinct throw sites and only ONE of them is
"the skill asked an unscripted question" — the others are a mis-typed `--answer` label, malformed
`--answer-policy` YAML, a crashed or bad-JSON `--decider-cmd` helper, an out-of-set `--decider-llm`
reply, an unanswered dialog/elicit, even a self-declared harness bug. A remedy picked from the category
is wrong for nearly all of them; each site's own hint is written for its case. (Also note `--on-unanswered`
*conflicts* with `--decider-dir`/`--decider-cmd`, so it is not a blanket fallback.)

For the genuine unscripted-gate case: script it (`--answer`, `--answer-policy`), or, when the skill's
gates are LLM-authored and reworded every run so a literal regex will not match twice, use `--decider-llm`
(or the scenario's `on_unanswered: llm`).

## Which model was graded — `gradedModels`

**The two turns are a SUBPROCESS.** They inherit no model from whatever invoked `critique` — not your
session, not a project setting. With no `--model`, the graded run uses the spawned agent's own default,
which may not be the model you are otherwise working under, and nothing about the run announces it.

`gradedModels` (text header: `graded model(s):`) is read back from the graded turn's own `result.json` and
is the only record of which model produced the behaviour being graded — distinct from the evaluator's
resolved model, which is a **different workload with its own default** (`claude-opus-4-8`), reported
separately. An evaluator line naming a model you did not pass is therefore expected, not evidence your
`--model` was ignored. Pin with `--model <id>` whenever a critique will be compared against another, and
read `gradedModels` back to confirm it took.

It is **observed, not requested** — the ids come from the model stamped on the graded turn's assistant
messages, never from the flag. So `graded model(s): unknown` means no assistant message reached the run
(crash, kill, or a gate before the first reply); passing `--model` does not change that line. Past runs
can be checked without re-running: the same ids are in each kept run dir's `turns/1/result.json`.

## The report's item shape — no `title`, no `summary`

Each `items[]` entry's prose fields are **`idea`** and **`recommendedAction`** — there is no `title` field
and no `summary` field. A consumer that parses for either gets silently blank output instead of an error.
Full required set: `source` (`evaluator`|`self-report`), `idea`, `classification`, `evidence` (the cited
excerpt, verbatim-checked against the evidence package), `recommendedAction`. The optional
`findingFingerprint` hashes `idea`+`classification`+`recommendedAction` — high-precision, low-recall: a
match proves the same finding recurred; a mismatch does NOT prove it didn't (the same finding reworded
fingerprints differently).

## What the evaluator was actually shown — `evidenceBudget`

Skill-authored content (`SKILL.md`, every `references/**` file, `agents/<skill>.md`) ships **WHOLE, not
rationed** — up to a **512 KiB combined ceiling** across all three together. A breach cuts **loudly**: the
named file and byte counts are reported, never silent, never refused. The **transcript** is bounded
separately at **128 KiB**, cut **head+tail with an elided middle**, so a run's setup and its conclusion
both survive a cut instead of just one end.

You do not need a paid run to find out where you stand: **`cowork-harness lint-skill <skill-dir>` sizes
your corpus against the same ceiling**, reporting `skill-corpus-near-evidence-ceiling` (INFO) from 80%
and `skill-corpus-over-evidence-ceiling` (WARN, so it fails `--strict`) past it. It counts the three
classes the ceiling governs — `SKILL.md`, every file under `references/` (**any extension**: the packager
applies no extension filter, so JSON schemas and rule packs count toward your total), and a plugin
skill's `agents/<name>.md`. It does not apply staging's git-tracked filter, so an untracked reference
inflates the figure; `corpusCuts` below stays the authority.

The report's `evidenceBudget` object says exactly what was shown — read it instead of inferring budgets
from `dist/` source:

| Field | What |
|---|---|
| `corpusBytes` | total skill-content bytes found, BEFORE any cut |
| `corpusCeiling` | the 512 KiB combined ceiling |
| `corpusCuts` | per-file cut record — empty on every real skill; non-empty only once the ceiling is actually breached |
| `corpusExcluded` | skill files present on the host but never delivered to the agent (see below) |
| `trimRecord` | which section the transcript trim shaved, and by how much |
| `packageTruncated` | `true` if ANY section was cut — check this, not `corpusCuts`, for "was anything trimmed": a transcript-only cut leaves `corpusCuts` empty and would otherwise read as "nothing cut" |

## An untracked skill file is not graded

Staging delivers **git-tracked files only** (same rule as a marketplace plugin install) — an untracked
file under the skill folder was never in the agent's mount, so grading against it would manufacture a
false `already-covered` verdict. It is named in `corpusExcluded` instead, and an untracked `SKILL.md`
specifically reports `skillMdStatus: "untracked"`, forcing the mechanical `already-covered` →
`not-adjudicable` downgrade. `git add` it (or commit before critiquing) if it should count as evidence.

## Read `referencesAccessed`, not `referencesRead`

`referencesRead` counts the **`Read` tool only**. An agent that reaches a reference with a `Bash cat`, a
`Grep` or a `Glob` leaves nothing in it, so its emptiness is **not** evidence the content went unread.
`referencesAccessed` is the wide signal — every file reached, with the channel each was reached through
(`read` / `grep` / `bash`) — and it is what the critique headline is computed from.

Two properties to carry: only the `read` channel is strong evidence the agent opened the file (a `bash`
entry means a command named the path); and detection **under-approximates** — a `cd` into the skill dir
then a bare relative `cat`, a heredoc body and a `$VAR`-built path are all invisible. So an absent path is
weak evidence, never proof. **Presence is the cannot-verify channel:** `[]` means the drive ran and saw
nothing (a real negative); an ABSENT field means there was no observable drive, and must never be read as
"none".

## `referencesRead` is main-agent-only — `noSkillFilesRead` is not

`result.json`'s top-level `referencesRead` lists **main-agent Reads only**. A dispatcher-style skill does
its reading one level down, and those Reads live under `subagents[].referencesRead` — so an empty
top-level list on a sub-agent-heavy run is not evidence the material went unread. The critique report's
**`noSkillFilesRead`** unions both, which is why it is the signal to read.

It is stated **observationally** and must be rendered that way: the predicate matches `references/` and
`scripts/` only — never `assets/`, never `SKILL.md` (delivered whole, never Read as a file) — and keys on
the `Read` **tool**. A skill that reached its material with `Grep`, or kept it under `assets/`, reports
`true` having demonstrably done the work. `undefined` has **two** causes and neither means "nothing was read": a degraded turn-1 result
(genuinely unknown), or a skill that ships no `references/` and no `scripts/` at all — there is nothing
for the signal to be about, so emitting it would be noise about material that does not exist.
