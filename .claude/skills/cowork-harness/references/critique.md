# Critique — the facts a plugin install can't otherwise reach

Tracks `cowork-harness 2.1.0` (baseline `desktop-1.34493.1`). This is **not** a trim of the full
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
