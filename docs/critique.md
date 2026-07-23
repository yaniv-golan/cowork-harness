# `critique` — grounded skill self-critique (EXPERIMENTAL)

> **Experimental surface.** Shape and output may change. It is a **discovery instrument, never a gate**:
> findings of any classification exit 0.

`cowork-harness critique` runs a skill, asks the agent what confused it — and then **does not believe the
answer**. Agent self-reports confabulate routinely ("there was no documentation about X" when the logs show
it read the docs). This grades every claim against a frozen record of what actually happened.

```bash
cowork-harness critique ./my-skill --prompt "<a task that exercises the skill>"
```

## How it resists confabulation

Three mechanisms, all code rather than prompt instructions:

1. **A frozen evidence record.** A byte-boundary snapshot is taken *before* the agent reflects, so the
   reflection turn's own output can never leak into the evidence it is graded against.
2. **A structurally blind first pass.** The evaluator's independent pass is never sent the self-report —
   not "told to ignore it". It cannot see text that was never put in its prompt.
3. **Mechanical citation checking.** Every claim must quote the evidence verbatim. Anything that does not
   resolve is dropped into a clearly-labelled section rather than reported as a finding.

> **Building an improvement loop?** This is the harvest step. The end-to-end assembly — harvest,
> reproduce, fix, prove the re-run used the fixed body, compare generations — is in
> [debugging.md](./debugging.md#the-whole-loop-end-to-end).

## If you came from "loop engineering"

This command is the **evaluator half** of the Evaluator-Optimizer pattern (Anthropic's *Building
Effective Agents* taxonomy) / the **verification loop** (LangChain's stacked-loop framing). It adds two
things those descriptions do not specify: the grader is *structurally blind* to what it is grading, and
every claim is mechanically checked against evidence. The **optimizer** half — fix, re-run, accept —
stays yours, deliberately.

It is also the mechanized form of the problem Osmani names and leaves to human diligence:

> "'done' is a claim and not a proof" · "the model that wrote the code is way too nice grading its own homework"

Where your vocabulary lands here:

| Loop-engineering term | Here |
|---|---|
| Agent loop (ReAct) | The skill's own run — `critique` grades it, it does not replace it |
| Verification loop / grader / rubric | `critique`, plus `verdict` + assertions for the deterministic half |
| **Evaluator-Optimizer** | `critique` is the **evaluator** half only — blinded, citation-checked. The optimizer half (fix and re-run) is yours |
| **Reflection loop** | The second turn. But note: reflection alone is what this tool exists to *distrust* |
| Maker/checker split | Enforced by construction — pass 1 never receives the self-report |
| Ralph loop (run until an external validator passes) | `run`/`skill` are that validator; `verdict.pass`/exit code is the signal. **Not `critique`** — findings never gate |
| Stopping condition | Exit codes ([SPEC.md](../SPEC.md)); `verdict.pass` |
| Bounded execution | `--timeout` (both lanes); `--max-budget-usd` on `run`/`skill --repeat` |
| Circuit breaker / stagnation detection | Consumer-side. We supply the per-iteration signals — `verdict.signals`, `fingerprint.skillHash`, the run index (see [stats.md](./stats.md)'s generation-pairing recipes) |
| Trace | `trace`, `trace --full-results` |
| **Hill-climbing loop** | **Deliberately not provided.** See below |

**What we do not do, stated plainly.** There is no convergence orchestrator: nothing here re-runs a skill,
scores it, and re-runs until it "improves". `critique` never edits a skill and never gates. That is a
design boundary, not a gap — a tool that closes its own loop starts optimizing for its own metric, which
manufactures exactly the false-greens this project exists to prevent. You own the loop; we make the
evidence going into it trustworthy.

**One naming collision to know about:** `hostloop` in this repo is a **fidelity tier** — where the agent
process runs. It has nothing to do with loop engineering's "loops".

## Flags

`critique` accepts the `skill` flags that make sense for a graded run, under the **same names** — what you
know from `skill` transfers. Anything that cannot work is refused with a reason rather than silently
ignored.

**Probe** (one required)

| Flag | |
|---|---|
| `--prompt "<text>"` | the task to run the skill against |
| `--prompt-file <path>` | read the probe verbatim from a file — for probes containing quotes, `$`, or newlines |

**Files and sources** — forwarded to the graded run. **Required for "analyze this document" skills.**

| Flag | |
|---|---|
| `--upload <path>` | mount a file at `mnt/uploads/<name>` (repeatable) |
| `--folder <dir>` | connect a folder at `mnt/<name>` (repeatable) |
| `--plugin <dir>`, `--marketplace <dir>` + `--enable <name@mkt>` | extra skill sources |

**Session shape** — both turns must agree on these, so they reach the reflection turn too.

| Flag | |
|---|---|
| `--model <id>` | session model for the agent doing the work *and* reflecting |
| `--allow-missing-capability` | don't fail either turn when the lean image omits a capability |

**Graded-run tuning** — the task turn only; the reflection turn stays pinned deterministic.

| Flag | |
|---|---|
| `--timeout <ms>` | wall-clock budget for the task turn (critique's own kill-switch stretches to fit) |
| `--label <tag>` | generation tag in the run index, for pairing critiques across fixes |
| `--answer "<q-regex>=<choice>"`, `--answer-policy <yaml>` | pre-answer the skill's gates — **this is what makes gated skills critiquable at all** |
| `--on-unanswered fail\|first` | unscripted-gate policy (`prompt` is refused — there is no TTY inside) |
| `--decider-llm` / `--intent` / `--decider-model` / `--decider-cmd` / `--decider-dir` | answer live gates in the graded run |

**Critique's own**

| Flag | |
|---|---|
| `--evaluator-model <id>` | the grading model (env: `COWORK_HARNESS_EVALUATOR_MODEL`) |
| `--output-format json\|text` | critique's *report* format — the inner turns always speak JSON internally |
| `--fidelity container` | container tier only — **`[not-built]`, not permanent**; see [Known limitations](#known-limitations) before designing around it |
| `--keep` | accepted as a no-op; runs are always kept |
| `--dotenv <path>` | credentials — works **before** `critique` (the global form) or **after** it |
| `--run-dir <path>` | **global, unlike `--dotenv`** — must still PRECEDE the subcommand; a trailing `critique … --run-dir` is rejected |

**Refused, and why**

| Flag | Reason |
|---|---|
| `--session-id` / `--resume` | critique mints and manages its own session — the reflection turn *is* a resume of it |
| `--repeat` + companions | fixed two-turn protocol; loop `critique` itself and pair by `fingerprint.skillHash` |
| `--ablate-skill` | grading a skill you removed is incoherent |
| `--quiet`/`-q` / `--verbose` / `--compact` / `--demo` / `--dry-run` | inner-turn rendering or preview — no effect on the report |

**Repeating a flag.** `--upload`, `--folder`, `--plugin`, `--marketplace`, `--enable` and `--answer` accumulate,
so repeating them is how you pass several. Every other value-taking flag is single-valued and repeating it is
a **usage error** (exit `2`) rather than a silent last-wins — `--prompt a --prompt b` would otherwise discard
a probe you typed. Boolean flags may be repeated harmlessly.

### Skills that need an attached file

```bash
cowork-harness critique ./captable-skill \
  --prompt "Analyze this cap table and flag anything unusual" \
  --upload ./acme-captable.xlsx
```

Both internal turns receive the source flags — they have to, or the reflection turn's resume computes a
different session identity and fails. The evidence package records **which files were attached** (names and
sizes), so the evaluator can tell "the agent said there was no file, and correctly so" from a confabulation.

It does **not** record their contents — see Known limitations.

## Cost and prerequisites

- **Four model workloads per critique**: two container runs (task + reflection) and two evaluator passes.
- The evaluator defaults to the most expensive tier. Override with `--evaluator-model <id>` or
  **`COWORK_HARNESS_EVALUATOR_MODEL`**.
- Requires the **container tier** (Docker/Lima) and an authenticated `claude` CLI on PATH.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | The critique ran. **Any** findings, of any classification — including a task run that itself errored, which is a legitimate finding about the skill. |
| `1` | **Operator interrupt only** (SIGINT/SIGTERM — e.g. Ctrl-C). Not part of the findings taxonomy, but reachable: a sweep wrapper treating `1` as impossible will misread a cancelled run as a crash. |
| `2` | Usage error, **or an instrument failure** — the turn was killed, the reflection protocol broke, or the evaluator was never invoked *or threw*. No critique was produced. A broken instrument is not a discovery outcome. |

Never gate CI on findings; that is the whole design.

## Reading the report

| Section | Meaning |
|---|---|
| `ACTIONABLE` | Grounded in the evidence and worth doing |
| `OTHER CLASSIFIED FINDINGS` | Grounded but low value, already covered by the skill, or contradicted by the evidence |
| `NOT ADJUDICABLE` | The evidence cannot decide — a human judgement call |
| `DROPPED` | The citation did not resolve. **Not validated** — shown for transparency only |

## Running it on a skill you did not write

The evidence package carries the skill's own text into the evaluator, so a hostile skill can try to steer
the grader. The package is **armored**: untrusted content sits inside per-run nonce markers, and only
nonce-tagged headings outside those markers count as instructions. A skill cannot pre-author the nonce.

**What that does and does not buy you.** It defeats *structural* attacks — counterfeit headings, fake output
contracts, forged boundaries — verified by a red-team probe across three models. It does **not** stop
content that merely *argues* (prose asserting the skill already documents everything). Fencing separates
planes; it cannot make a reader immune to persuasion. Treat critique output on an untrusted skill as a lead,
which is how you should treat it anyway.

Resistance is also **per-model and perishable**: it is verified for the shipped default evaluator model.
Changing the evaluator model invalidates that verification.

## Known limitations

Each limitation is tagged with **why** it exists, because that — not the limitation itself — is what tells
you whether to design around it permanently:

| Tag | Meaning |
|---|---|
| `structural` | Permanent. Architect around it. |
| `unverified` | Works or doesn't — **nobody has proven it**. Not known-impossible; may lift. |
| `deliberate` | A design choice with a rationale. |
| `not-built` | Simply absent. No obstacle but the work. |

The same tags appear in `critique --help`, generated from one source (`src/critique/limitations.ts`), so
the two cannot disagree.

- **`[not-built]` Container tier only** — `--fidelity hostloop|cowork|microvm|protocol` is refused.
  **This is now a statement about unbuilt work, not evidence or physics.** The resume-continuity proof that
  was missing has PASSED at hostloop against its *native* agent binary (`test/live-contract.test.ts`,
  "resume-continuity proof at hostloop"; 4/4 live runs): a resumed turn both recalled a prior-turn-only
  conversation codeword *and* freshly re-read the mounted skill, so the container proof demonstrably
  transfers to the native binary. **What remains is only build work:** unpinning three hard-coded container
  sites, stamping the tier on the session manifest so a cross-tier resume fails loud, and plumbing
  host-write consent for `skill`/`critique` (the one real design call — hostloop writes to the user's real
  filesystem, whereas container is throwaway).
  *If you are deciding whether to build a permanent second test lane for hostloop-only findings: don't —
  the tier is proven reachable, so the pin is pending work, not a permanent boundary.*
- **`[deliberate]` SKILL.md is capped at 16KB** in the evidence; a larger one degrades toward "not
  adjudicable". The package is bounded so the evaluator sees a whole record rather than a truncated tail.
  Note the truncation caveat is a *prompted* nudge toward `not-adjudicable`, not a mechanical downgrade —
  only an unreadable SKILL.md forces one.
- **`[not-built]` English-only prompts.** No localization has been attempted; nothing blocks it.
- **`[not-built]` The evidence package is not persisted.** A disputed finding cannot be re-checked
  against the record it was graded on.
- **`[not-built]` The report is written to stdout** only — capture it with shell redirection;
  `--output-format` changes the format, never the destination.

### Reading the graded turn's result

`critique` runs two turns into one run directory. Each turn's artifacts live in **`turns/<N>/`**, written
once and never renamed — so the graded turn is `turns/1/`, and the reflection turn is `turns/2/`. There is
**no root compat copy of anything** — `<run-dir>/result.json` does not exist. Rather than expect you to
reach into `turns/1/` yourself:

- the graded turn's **`outcome` and `skillHash` are in the report itself** (`gradedOutcome` /
  `gradedSkillHash` in `--output-format json`, and in the text header) — a harvester never needs a turn
  file; and
- the graded result is also written under the stable name **`result.graded.json`**, and the graded turn's
  trace as **`trace.graded.json`** — both at the run-dir root, alongside `turns/1/` and `turns/2/`.

Both `*.graded.json` names are written at the moment the graded turn completes, so they are correct
immediately and survive a reflection turn that never finishes. Prefer them, or `turns/1/` directly, to
`turns/2/result.json` — which is the reflection turn's numbers, not the graded ones.
- **`[deliberate]` Attached-file content usually stays out of the evidence — but that is the common case, not a
  guarantee.** "Attached inputs" lists names and sizes only, never bytes, and the primary transcript
  source is assistant prose. But packaging falls back to a raw slice of `events.jsonl` when the archived
  transcript is missing, and that stream carries full tool results — so if the agent read the attached
  file, its content can enter the Transcript section (bounded, still armor-fenced) and a content-level
  citation would resolve. Claims about a document's *contents* are therefore usually NOT ADJUDICABLE, not
  always.
- **`[structural]` Citation seams.** Armor inserts a marker line between each section heading and its body. A quote that
  spans that seam *without* including the marker does not resolve and is DROPPED. Quotes wholly inside one
  section are unaffected. **Measured:** on a benign package, 9 findings across 5 live pass-1 runs produced
  **0 dropped citations (0%)** — models quote body content, not across headings. Since a pre-armor rate
  cannot be below zero, armor costs nothing measurable here. DROPPED items are always shown, so any future
  regression would be visible rather than silent.
