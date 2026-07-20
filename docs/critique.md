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

This command is the **Evaluator-Optimizer** pattern (Data Science Dojo's catalog) / the **verification
loop** (LangChain's stacked-loop framing) — with two things those descriptions do not specify: the grader
is *structurally blind* to what it is grading, and every claim is mechanically checked against evidence.

It is also the mechanized form of the problem Osmani names and leaves to human diligence:

> "'done' is a claim and not a proof" · "the model that wrote the code is way too nice grading its own homework"

Where your vocabulary lands here:

| Loop-engineering term | Here |
|---|---|
| Agent loop (ReAct) | The skill's own run — `critique` grades it, it does not replace it |
| Verification loop / grader / rubric | `critique`, plus `verdict` + assertions for the deterministic half |
| **Evaluator-Optimizer** | `critique` — blinded evaluator, citation-checked |
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

## Cost and prerequisites

- **Four model workloads per critique**: two container runs (task + reflection) and two evaluator passes.
- The evaluator defaults to the most expensive tier. Override with `--evaluator-model <id>` or
  **`COWORK_HARNESS_EVALUATOR_MODEL`**.
- Requires the **container tier** (Docker/Lima) and an authenticated `claude` CLI on PATH.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | The critique ran. **Any** findings, of any classification — including a task run that itself errored, which is a legitimate finding about the skill. |
| `2` | Usage error, **or an instrument failure** — the turn was killed, the reflection protocol broke, or the evaluator was never invoked. No critique was produced. A broken instrument is not a discovery outcome. |

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

- **Container tier only** — the resume continuity this depends on is verified there and nowhere else.
- **SKILL.md is capped at 16KB**; a larger one degrades toward "not adjudicable".
- **English-only prompts.**
- The evidence package is not persisted; the report is written to stdout.
- **Citation seams.** Armor inserts a marker line between each section heading and its body. A quote that
  spans that seam *without* including the marker does not resolve and is DROPPED. Quotes wholly inside one
  section are unaffected. **Measured:** on a benign package, 9 findings across 5 live pass-1 runs produced
  **0 dropped citations (0%)** — models quote body content, not across headings. Since a pre-armor rate
  cannot be below zero, armor costs nothing measurable here. DROPPED items are always shown, so any future
  regression would be visible rather than silent.
