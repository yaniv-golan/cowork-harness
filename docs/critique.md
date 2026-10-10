# `critique` — grounded skill self-critique (EXPERIMENTAL)

> **Experimental surface.** Shape and output may change. It is a **discovery instrument, never a gate**:
> findings of any classification exit 0. Its verdict is **advisory — a discovery lead, not an independent
> attestation**: the skill under review controls text that enters the evaluator's prompt, so treat the
> result as something to investigate, not as proof (see [Known limitations](#known-limitations)).

`cowork-harness critique` runs a skill, asks the agent what confused it — and then **does not believe the
answer**. Agent self-reports confabulate routinely ("there was no documentation about X" when the logs show
it read the docs). This grades every claim against a frozen record of what actually happened.

```bash
cowork-harness critique ./my-skill --prompt "<a task that exercises the skill>" --model claude-sonnet-5
```

Both turns need a model: `--model <id>` (forwarded to both) or `COWORK_HARNESS_MODEL`. With neither,
critique refuses before its task turn. The examples below assume the variable is set.

## On this page

- [How it resists confabulation](#how-it-resists-confabulation)
- [How it works](#how-it-works)
- [If you came from "loop engineering"](#if-you-came-from-loop-engineering)
- [Flags](#flags)
- [Cost and prerequisites](#cost-and-prerequisites)
- [Exit codes](#exit-codes)
- [Reading the report](#reading-the-report)
- [Reading several critiques of the same skill](#reading-several-critiques-of-the-same-skill) — and `critique --compare`
- [Critiquing a commit — `git:<ref>:<path>`](#critiquing-a-commit--gitrefpath)
- [A public summary — `--summary-out`](#a-public-summary----summary-out)
- [Running it on a skill you did not write](#running-it-on-a-skill-you-did-not-write)
- [Known limitations](#known-limitations)

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

## How it works

Five steps, in this order. The middle one is not a model call — it is the boundary that makes step 4
trustworthy.

1. **Task turn** — your skill runs against the probe. An ordinary graded run.
2. `── boundary: the run record is frozen here ──` — this is mechanism 1
   [above](#how-it-resists-confabulation), and its scope is exactly what that wording says: the
   reflection turn's own **output** cannot reach the record it is graded against.
3. **Reflection turn** — a **resume of the same session**, so the agent still has its own context when
   asked what confused it. Its answer is the self-report.
4. **Evaluator pass 1 — independent.** Reads the frozen turn-1 record and the packaged corpus. It is
   never sent the self-report (mechanism 2), and its claims are citation-checked against the package
   before anything else is interpolated.
5. **Evaluator pass 2 — adjudicating.** Everything pass 1 saw, **plus the self-report and pass 1's
   validated findings**. **Skipped entirely when no self-report was captured**, in which case the report
   carries pass 1's independent findings alone — so a critique is up to four model workloads (zero with
   `--corpus-only`), not always four.

### Who sees what

The blindness in step 4 is the whole value proposition, so it is worth reading as a matrix rather than
a sequence:

| Workload | Sees the skill folder | Sees the run | Sees the self-report | Sees pass 1's findings |
|---|---|---|---|---|
| 1 · task turn | whole folder, incl. `scripts/` | is the run | — | — |
| 2 · reflection turn | whole folder, incl. `scripts/` | its own session | writes it | — |
| 3 · evaluator pass 1 | packaged corpus only | frozen turn-1 record | **no** | — |
| 4 · evaluator pass 2 | packaged corpus only | frozen turn-1 record | yes, when captured (truncated, JSON-fenced) | validated only |

Rows 1-2 versus 3-4 carry the asymmetry that surprises people most: the graded and reflection turns
mount your whole skill folder including `scripts/`, while the evaluator only ever receives a **packaged
corpus** — a bounded copy of the authored text, never the folder. What goes into it, and what is
deliberately left out, is the `evidenceBudget` object under
[Reading the report](#reading-the-report).

An evidence section that is **empty** means the packager could not read it, never that the thing did not
happen — see [Known limitations](#known-limitations) for the degraded-turn-1 states and how a verdict is
downgraded rather than guessed.

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
| Bounded execution | `--timeout` (both lanes); `--max-budget-usd` on `run`/`skill` — a cumulative cap with `--repeat`, a history-based pre-flight refusal without it. `critique` itself rejects it: four workloads, so a single-run estimate gates on the wrong number |
| Circuit breaker / stagnation detection | Consumer-side. We supply the per-iteration signals — `verdict.signals`, `fingerprint.skillHash`, the run index (see [stats.md](./stats.md)'s generation-pairing recipes) |
| Trace | `trace`, `trace --full-results` |
| Regression gate for an edit | [`eval`](./eval.md) — a paired before/after of two versions of the skill; still not a loop |
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
| `--model <id>` | session model for the agent doing the work *and* reflecting. Required unless `COWORK_HARNESS_MODEL` is set (from the environment or `--dotenv`): without either, critique refuses before its task turn (exit 2) |
| `--allow-missing-capability` | don't fail either turn when the lean image omits a capability |
| `--allow-host-writes` | consent to a writable connected folder at `--fidelity hostloop` (native host FS access); forwarded to both turns. No effect off hostloop or without a writable `--folder`. Refused loud otherwise |

**Graded-run tuning** — the task turn only; the reflection turn stays pinned deterministic.

| Flag | |
|---|---|
| `--timeout <ms>` | wall-clock budget for the task turn (default **30 min**; critique's own kill-switch stretches to fit). The turn is killed *after* its model spend, so too-short costs the money **and** the result — the default errs long deliberately |
| `--label <tag>` | generation tag in the run index and the report, for pairing critiques across fixes; `--compare` groups by it |
| `--allow-stall` | don't fail the task turn when it ends on a question or, after an `AskUserQuestion` gate, a request for input (the `stalled` signal) — the CLI equivalent of `allow_stall: true` |
| `--answer "<q-regex>=<choice>"`, `--answer-policy <yaml>` | pre-answer the skill's gates — **this is what makes gated skills critiquable at all** |
| `--on-unanswered fail\|first` | unscripted-gate policy (`prompt` is refused — there is no TTY inside) |
| `--decider-llm` / `--intent` / `--decider-model` / `--decider-cmd` / `--decider-dir` | answer live gates in the graded run (these forward to the graded `skill` turn, which accepts all of them — `run` and `record` each accept a narrower subset, see [decider-dir.md → Decider flags by command](./decider-dir.md#decider-flags-by-command-run-vs-record-vs-skill)) |

**Critique's own**

| Flag | |
|---|---|
| `--evaluator-model <id>` | the grading model (env: `COWORK_HARNESS_EVALUATOR_MODEL`) |
| `--output-format json\|text` | critique's *report* format — the inner turns always speak JSON internally |
| `--out <path>` | **also** write the selected-format report to this file (stdout unchanged). The format comes from `--output-format`, which defaults to **text** — so `--out report.json` writes TEXT unless you also pass `--output-format json`, and a downstream `json.load()` then fails with `Expecting value: line 1 column 1`, which reads as a corrupt report rather than a format mismatch. A mismatch between the extension and the format warns at argument-parse time, before the run spawns |
| `--summary-out <path>` | **also** write a public-safe summary — no finding text — to this file; see [A public summary](#a-public-summary----summary-out). `--summary-include-cost` / `--summary-include-prompt-hash` add what it leaves out by default |
| `--compare <report.json…>` | a separate mode: lay several critique reports or summaries side by side, no spend — see [`critique --compare`](#critique---compare--the-reports-side-by-side). Takes only `--strict`, `--out` and `--output-format` |
| `--skill <name>` | multi-skill **plugin** target: grade `skills/<name>/SKILL.md` (+ every `agents/**.md` it can dispatch, + any plugin-root `references/` file the skill actually links) instead of a missing plugin-root SKILL.md — see below |
| `--fidelity container\|hostloop\|cowork` | container (default) or hostloop; `cowork` resolves via the baseline's loop gate to one of those two and pins BOTH turns to it. `microvm`/`protocol` refused with a reason — see [Known limitations](#known-limitations). At hostloop a writable `--folder` needs `--allow-host-writes` |
| `--keep` | accepted as a no-op; runs are always kept |
| `--dotenv <path>` | credentials and knobs (e.g. `COWORK_HARNESS_EVALUATOR_MODEL`) — works **before** `critique` or **after** it (once); applies to critique's own process, where the evaluator runs, and to both turns |
| `--run-dir <path>` | relocate the runs root — works **before** `critique` or **after** it; both turns inherit it |

**Refused, and why**

| Flag | Reason |
|---|---|
| `--session-id` / `--resume` | critique mints and manages its own session — the reflection turn *is* a resume of it |
| `--repeat` + companions | fixed two-turn protocol; loop `critique` itself and compare the reports with `critique --compare` |
| `--ablate-skill` | grading a skill you removed is incoherent |
| `--quiet`/`-q` / `--verbose` / `--compact` / `--demo` / `--dry-run` | inner-turn rendering or preview — no effect on the report (which already collapses host paths to `~`) |

**Repeating a flag.** `--upload`, `--folder`, `--plugin`, `--marketplace`, `--enable` and `--answer` accumulate,
so repeating them is how you pass several. Every other value-taking flag is single-valued and repeating it is
a **usage error** (exit `2`) rather than a silent last-wins — `--prompt a --prompt b` would otherwise discard
a probe you typed. Boolean flags may be repeated harmlessly.

### Multi-skill plugins (`--skill`)

A multi-skill plugin has `skills/<name>/SKILL.md` and **no root `SKILL.md`** — a plugin root graded as a
plain skill folder has no SKILL.md to read, which downgrades every coverage finding to "not
adjudicable". So:

- **`--skill <name>`** makes the packager grade `skills/<name>/SKILL.md`, and also packages the invoked
  skill's **dispatchable `agents/**.md`** (sub-agent system prompts) and its own **`references/**` content**
  — for sub-agent-heavy skills that is where most operative guidance lives — plus, for a multi-skill
  plugin, the **shared plugin-root `references/`** files the skill actually links (never the whole shared
  tree, and never an unlinked one — see [Known limitations](#known-limitations) for the recognized link
  forms, the measured reason the whole tree is rejected, and `evidenceBudget.corpusOmitted`).
- A multi-skill root with **no `--skill` is refused before any model spend**; a single-skill plugin
  auto-selects with a notice.
- **`critique <plugin>/skills/<name>` is the same run as `critique <plugin> --skill <name>`.** Cowork
  installs plugins, never a bare skill folder, so a skill-folder positional inside a plugin is *promoted*:
  critique mounts the enclosing plugin and grades `<name>`, with a `::notice::` saying so. Same mount, same
  packaged corpus, same `skillHash` (the whole plugin's), same `gradedSkill`. It falls back to mounting the
  skill folder alone — with a notice naming why — only when `--skill` cannot reach the skill from the
  plugin: the folder is not at exactly `skills/<name>` (say `tools/x`), it is a git submodule or nested
  repo the plugin's index never descends into, or its spelling's case differs from the tracked path. A
  fallback run lacks everything the plugin provides outside that folder (agents, shared references), and
  its corpus lacks them too. A skill folder that carries its **own** plugin manifest is a plugin in its own
  right: it is mounted as one, never promoted, and a notice says the plugin around it is not mounted.
- **Selection only:** with a plugin-root positional, `--skill` does not change what both turns mount
  (session identity is unchanged), and **`fingerprint.skillHash` is unchanged by `--skill`** — it keys the
  *mounted plugin* (for a promoted `<plugin>/skills/<name>` spelling too), so it pairs generations
  per-plugin, not per-skill. **Workflow implication: pairing critiques of a
  multi-skill plugin by skillHash alone CROSS-PAIRS different skills** — pair by the per-skill
  **`corpusHash` / `skillTreeHash`** ([Has the skill changed?](#has-the-skill-changed--corpushash-skilltreehash-packagedcorpushash)),
  or by **(`gradedSkillHash`, `gradedSkill`)**; the report's `gradedSkill` field carries the resolved
  `skills/<name>` (`--skill` or the auto-selection), or, for a skill folder that cannot be promoted to its
  plugin, the name the agent registers it under. `--label` remains available for coarser
  generation tags.
- **A fleet-consistency defect is out of scope for any single critique, by construction.** The graded
  agent mounts the whole plugin and can observe sibling behaviour; the evaluator's corpus is ONE skill,
  so a self-report claim about a sibling can only ever route to `not-adjudicable`. A worked example from
  the field: one skill scored a deck into four bands while its sibling's checklist was binary on failure
  *count*, so the better-scoring analysis got the harsher word — visible to a reader of both reports,
  invisible to either critique. Pairing critiques (above) tells you a finding reproduced; it does not
  surface a defect that exists only in the disagreement BETWEEN two skills. That one needs a human
  reading both, or a check outside this tool.
- The report carries an advisory **`skillInvocationObserved`** whenever a single skill is being graded
  (`--skill`, a single-skill plugin, or a `<plugin>/skills/<name>` positional). `true` means an
  observable channel named the selected skill — the main agent's `Skill` tool call, a sub-agent's `Skill`
  call (read from the turn's `events.jsonl`, which carries the name the timeline drops), or a leading
  slash token in the prompt that resolves to a *staged skill*. The slash rule is the binary's, measured:
  the `/` must be the first character, the token runs to the first whitespace (`/plugin:skill.` is sent as
  prose, not expanded), and a bare `/name` resolves to the plugin skill. That is the agent's rule, which
  the harness exercises; real Cowork's Desktop app resolves a typed slash command first and is stricter
  (observed on Desktop 2.19675.0, 2026-10-03, 4 runs: it refused a bare name that differs from its
  plugin's name, and both the bare and qualified forms when two copies of one plugin were installed), so a
  run observed here is not proof the same typed prompt reaches the agent in Cowork. Expanding one inlines SKILL.md as
  a user message rather than calling the tool, so a slash-command run shows `skillsInvoked: []` and is
  **not** a non-invocation. `false` means all three channels were observable and none fired. The field
  is **absent** when a channel could not be observed or the one that fired is ambiguous — an older
  `result.json` with no prompt, or a slash prompt on a run with no skill inventory; an unreadable events slice; a top-level `Skill` call
  whose id the record could not read; a bare `/name` that more than one staged skill answers to; or a
  plugin that ships both a command and a skill under one name (`commandShadowsSkill`), where the slash
  entry and the `Skill` tool launch either through one registry; or another skill of the plugin that the agent
  registers under the same id (it rewrites every character outside `[a-zA-Z0-9_-]` to `-`, so `skills/my.skill/`
  and `skills/my-skill/` collide). Absent is never a synonym for `false`,
  and the text report prints a NOTE when it is absent.

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

- **Up to four model workloads per critique (zero with `--corpus-only`)** — the two graded turns and the
  two evaluator passes of [How it works](#how-it-works) (pass 2 is skipped when no self-report was
  captured). See [Knowing before you pay](#knowing-before-you-pay) for the no-spend corpus check.
- **No `[provenance]` footer on critique's stderr, by construction.** That line is the `skill`/`run`
  lane's per-run footer; critique spawns its two graded turns with their output captured, so it never
  reaches your terminal. The same facts are in the report instead: `gradedModels`,
  `gradedEffectiveFidelity`, `skillInvocationObserved`. A consumer grepped both streams for it and found
  nothing — that is the expected shape, not a missing line.
- The evaluator defaults to the most expensive tier. Override with `--evaluator-model <id>` or
  **`COWORK_HARNESS_EVALUATOR_MODEL`**.
- **Which workload dominates spend depends on the skill — read it per run, don't assume.** Evaluator
  cost is roughly **fixed** (bounded by the evidence package: corpus + transcript caps); the graded task
  turn is **unbounded**. On a trivial probe the two evaluator passes (steps 4-5) are ~3/4 of the total; on a real
  document-analysis run the ratio **inverts** (measured on one: task turn ~61%, evaluator ~30%). The
  report's `cost:` line prints the four-way split and the evaluator's share of the total, and `costUsd`
  carries the same numbers — use those. A cheaper `--evaluator-model` can only ever buy you the
  evaluator's share, so when the task turn dominates the levers are `--model`, `--timeout` and probe
  scope instead. For a wide batch: calibrate with run 1's `costUsd`
  (gate on `costUsd.complete` — `false` means the total undercounts), then decide. Caveat: the armor's
  injection-resistance is verified for the
  shipped **default** evaluator model only — changing it voids that specific verification (matters when
  critiquing skills you did not write). That verification was measured with an evaluator that had tools; it has not
  been repeated with the tool-less evaluator, isolated from your own Claude Code setup (see
  `COWORK_HARNESS_CLAUDE_BIN` in the CLI guide).
- **Trending spend across critiques: use the run index, not the reports.** Each critique appends a
  roll-up row (`critiqueRole:"rollup"`) carrying `critiqueTotalUsd`; its `costUsd` is the evaluator
  passes only, so `sum(costUsd)` over every row is exactly true spend — the two graded turns already
  contribute their own rows. The index is also the only cost record that survives run-dir pruning.
  See [stats.md](./stats.md).
- **container** needs Docker/Lima; **hostloop** needs Docker (the bash/web_fetch sidecar) **plus** the
  staged native agent binary, and writes to the real host filesystem — a writable `--folder` there requires
  `--allow-host-writes`. Both tiers need a `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY` as a CI
  fallback) in the environment or `.env` — the graded turns self-spawn the installed CLI, which runs the
  staged agent binary rather than a host `claude`. The two evaluator passes are what need an authenticated
  `claude` CLI on PATH, overridable via `COWORK_HARNESS_CLAUDE_BIN`.

### Research, egress, and the lean image

- **Reading `egress.log` on a research-heavy critique:** a `WebSearch` does **not** produce search-host
  entries in the container `egress.log`. An egress log showing only `api.anthropic.com` (plus denied
  telemetry) is consistent with WebSearch working normally — it is *not* evidence that research was
  blocked. `web_fetch` is **not** in that log on either tier: since `a459c80` (2.4.0) the container
  tier registers the same host-side workspace handler that `hostloop` does whenever
  `coworkWebFetchViaApi` is on (every baseline from `desktop-1.13576.1`), so its fetches run in the
  harness's own Node process, outside the container network namespace, and the sidecar proxy never sees
  them. Both tiers' `web_fetch` decisions land in `RunResult.egress` as bare `{host, decision}`
  records — no `ts`, no `port`, no `reason` — while every row the sidecar proxy writes carries a
  `ts` (its single log call stamps one before any per-decision detail, of which there are four shapes:
  `{port, reason}` on a CONNECT deny, `{method, reason}`, `{method, path, port, bytes}`, `{port}`). So
  the discriminator is `ts`: present on every proxy row, never on a `web_fetch` row. And a *provenanced* URL (one that appeared
  in the prompt or a prior `web_fetch` result) is gated by the provenance set alone, so the hostname
  allowlist is not consulted for it on either tier.
- **Sub-agent research is not in the main turn's `toolCounts`.** A `WebSearch` issued by a dispatched
  sub-agent does not increment the main `toolCounts.WebSearch` — a `0` there with researched facts in
  the output usually means the sub-agents did the searching. Those searches ARE captured (live/record
  lane) as `subagents[].webSearches` (query + bounded result text), surfaced by
  `trace --view subagent-research`, and packaged into critique's evidence as a "Sub-agent research"
  section — so the evaluator can ground a sub-agent's "researched" claim instead of marking it
  not-adjudicable. A sub-agent can dispatch its **own** sub-agent, and only dispatches the parent stream
  surfaced get a `subagents[]` entry — a search made deeper is attributed to the nearest ancestor that
  has one and tagged `viaAgentId`, rendered `← via nested agent …` in the evidence label and
  `[via nested agent …]` in the trace view. Read that as "research happened **under** this dispatch",
  not "this dispatch searched": grounding a claim about which agent did the work needs the difference.
  Absent on replay (the child transcript only exists while the real binary ran) — absence is never
  evidence of no research.
- **Critiquing a document-analysis skill?** The lean default image omits OCR / LibreOffice / PDF-table
  tooling (native `Read` handles text PDFs fine). If the skill needs them, pass
  `--allow-missing-capability`, or point `COWORK_AGENT_IMAGE` at a full-parity build
  (`--build-arg COWORK_FULL_PARITY=1`). The lean default is deliberate — don't treat a
  `missing_capability` signal there as a skill defect.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | The critique ran. **Any** findings, of any classification — including a task run that itself errored, which is a legitimate finding about the skill — except one that hit the account's usage limit (exit `2`). |
| `1` | **Operator interrupt only** (SIGINT/SIGTERM — e.g. Ctrl-C). Not part of the findings taxonomy, but reachable: a sweep wrapper treating `1` as impossible will misread a cancelled run as a crash. |
| `2` | Usage error, a task turn that hit the account's usage limit (an ordinary `RUN FAILED`, not a broken instrument), **or an instrument failure** — the turn was killed, the reflection protocol broke, or the evaluator was never invoked *or threw*. No critique was produced. A broken instrument is not a discovery outcome. |

`critique --compare` exits `0` when it compared and `2` for a refusal or usage error; `--corpus-only` exits `0`
on a measurement and `2` for a refusal. A `--summary-out` file that cannot be written, or is withheld by the
secret scrub, never changes the exit code.

Never gate CI on findings; that is the whole design.

### Reading an exit-2 report: which turn, and why

An exit-2 report has no findings, so the only thing it tells you is what went wrong — and it must not send
you at the wrong subsystem. Two fields carry that, in `--output-format json` and in the text header:

| Field | Says |
|---|---|
| `infraFailurePhase` | which turn failed — `task turn` (the graded run) or `reflection turn` (critique's own protocol turn) |
| `infraFailureKind` | why the turn failed — a harness `ErrCategory` when it printed an error envelope, **or** a `resultErrorKind` (`usage_limit` / `transport` / `agent`) when it RAN and reported an errored result. **Absent** = killed, or exited with no envelope at all |

**A category alone does not mean the instrument is healthy.** `cli.ts`'s top-level catch funnels every
unexpected throw into category `internal` — a Docker daemon that is down, a container that fails to
start, a missing staged agent, a harness bug — and `runtime` carries a refused run dir. Only three
categories are the caller's problem, and the header is keyed on exactly that split:

A turn that **ran and errored** exits `1` with a full result envelope whose top-level `error` is `null` —
so its cause lives in `results[0]`, not in an error object. That is where an exhausted quota shows up:
`usage_limit` renders as *"the account's quota is exhausted; retry after the reset"* — or, when a sub-agent hit it, names
that sub-agent and its limit text — not as a broken instrument and not as a skill defect. A **task turn** that reports
`usage_limit` — its own final result, or a sub-agent's — is a task-turn failure: no reflection turn is spawned on
the spent quota, no critique is produced, and critique exits `2` with `RUN FAILED (task turn, usage_limit)`.

- **`RUN FAILED (<turn>, <kind>): …`** — `unanswered`, `usage`, `boundary`, `usage_limit` or `transport`.
  An ordinary, actionable
  failure the harness already diagnosed, with a healthy instrument underneath. The reason carries the
  harness's own message and hint verbatim; **follow those** rather than a category-level guess — an
  `unanswered` can be an unscripted gate, a mis-typed `--answer` label, malformed `--answer-policy` YAML,
  a crashed `--decider-cmd` helper or an out-of-set `--decider-llm` reply, and the remedy differs.
- **`INFRASTRUCTURE/PROTOCOL FAILURE (<turn>): …`** — everything else: `internal`, `runtime`, `agent` (for
  critique's own protocol turn, an agent-level failure *is* the instrument breaking), a kind this build has
  not been taught, a killed turn (timeout, byte cap), or no envelope at all. This wording means the
  instrument itself may be broken. It fails **closed**: an unrecognized kind lands here.

The graded turn gets the same treatment from the other side. `taskResult: "error"` is a **gradeable**
outcome — the critique proceeds and the findings stand — but `gradedErrorReason` now names *why*, so a
dropped connection is not read as a defect in the skill under review. The exception is `usage_limit` (above):
the account's quota cut that turn, so there is nothing honest to grade.

## Reading the report

| Section | Meaning |
|---|---|
| `ACTIONABLE` | Grounded in the evidence and worth doing |
| `OTHER CLASSIFIED FINDINGS` | Grounded but low value, already covered by the skill, or contradicted by the evidence |
| `NOT ADJUDICABLE` | The evidence cannot decide — a human judgement call |
| `DROPPED` | The citation did not resolve. **Not validated** — shown for transparency only |

Every report also carries the advisory scoping machine-readably: a `verdictProvenance` object in
`--output-format json`, and a "verdict scope:" line in the text report — both marking the verdict as an
advisory self-run, not an independent attestation.

The header also reports the pinned **fidelity** (plus the tier/baseline the graded turn *recorded*, so a
mismatch is visible rather than assumed away) and a per-critique **cost** rollup across all four model
workloads — the two graded turns *and* the two evaluator passes — marked `INCOMPLETE` whenever any
workload could not be priced. In JSON these are `fidelity` / `gradedEffectiveFidelity` / `gradedBaseline`
/ `costUsd` — plus `requestedFidelity`, present only when `--fidelity cowork` was passed and naming what
it resolved to — and a `droppedEvaluatorItems` count appears when the per-item-tolerant parse dropped
malformed evaluator items (the surviving findings are then not necessarily the complete reply). An
**`evidenceBudget`** object reports how much of the skill's authored content was packaged: `corpusBytes`
(total found, before any cut) against `corpusCeiling` (512 KiB, combined across SKILL.md + the skill's
own references + every packaged agent md + every packaged plugin-root reference), `corpusPackaged`
(every file whose CONTENT shipped into the corpus sections, by the same key — so a reader can see which
sub-agent bodies and shared references the grade rests on; a file the ceiling zeroed is not listed, a
partially cut one is, with its loss in `corpusCuts`), `corpusCuts` (per-file — empty on every real skill; only non-empty once the ceiling is
actually breached), `corpusOmitted` (plugin-root `references/` files present on the HOST under
`<plugin>/references/` but **not** packaged — a raw walk, so an untracked file that staging would not
deliver is listed here too, and `alsoUntracked` says so when trackedness was evaluated; that property is
ABSENT, never `false`, when it could not be — git mode off, an unreadable index, a non-work-tree, or a
work tree with nothing tracked —
with why: `not-linked` — nothing in the skill's authored text or a packaged agent body points at
it, and the graded agent's own read didn't either; `not-utf8` — it failed to decode as clean UTF-8, e.g. a
font asset (only plugin-root references are filtered this way — the skill's **own** `references/**` still
ships with no extension or content filter at all); or `ambiguous-read` — the graded agent read a path that
exists under both the skill's own `references/` and the plugin root's, so which tree it read cannot be
attributed), `corpusExcluded` (files present on the host but never delivered to the agent by
staging — untracked, with git-mode on), and `trimRecord` (any section the overall belt-and-suspenders cap
shaved). `cowork-harness lint-skill <skill-dir>` answers a narrower proximity question **without a paid
run** — `skill-corpus-near-evidence-ceiling` (INFO) from 80%, `skill-corpus-over-evidence-ceiling` (WARN,
so it fails `--strict`) past it. It counts the same four classes: `SKILL.md`, every
file under `references/` (**any extension** — the packager applies no extension filter, so JSON schemas
and rule packs count), every `agents/**.md` a plugin skill can dispatch, and every plugin-root
`references/` file the skill links. The one clause it cannot mirror is the run-dependent one — a root
reference included only because the graded agent READ it — since a static lint has no run to read. It also does not apply
staging's git-tracked filter, so an untracked skill-local reference inflates the figure the other way —
it errs toward warning early either way, and a real report's `corpusCuts`/`corpusOmitted` stay the
authority.
On a normal skill this is one reassuring line; the other fields only grow teeth on a genuinely
oversized skill or an untracked-file mistake.

### Knowing before you pay

```bash
cowork-harness critique ./my-skill --corpus-only
cowork-harness critique ./my-plugin --skill my-skill --corpus-only --output-format json
```

NO SPEND — no session, no spawn, no model call. This runs the same `packageEvidence` call a paid
critique makes, over an empty run dir, and stops. The text report is one block:

```
critique --corpus-only  .claude/skills/cowork-harness
  evidence corpus (pre-run FLOOR): 281,029 B = 53.6% of the 524,288 B ceiling
  packaged: 6 file(s)
  corpusHash sha256:…  (git-tracked)
  skillTreeHash sha256:…
  lower bound — plugin-root references the agent READS during the graded turn are added at critique time, so a paid run's corpusBytes is >= this
```

(the harness's own bundled skill, on the tree this was written from — your numbers will differ)

`--output-format json` emits the standard payload envelope (`{tool, command, ok, ...}` — `tool`/`command`
are the discriminator; a critique **report** carries neither) with a `corpus` object holding the same six
fields as `evidenceBudget` above (`trimRecord`/`packageTruncated` are absent — they describe a package a
graded run produced) plus `ignoredFlags` (every run-shaping flag you passed that this mode parsed but
did not act on), the same `note`, and the corpus hashes below with their `corpusManifest` and `source`.

**The number is a FLOOR, always.** A plugin-root reference the agent READS during the graded turn (not
just linked from authored text) is added to the corpus at critique time — no static instrument can see
that read — so a paid run's `corpusBytes` is `>=` the preview's, and a `corpusOmitted[].reason` can move
from `not-linked` to `ambiguous-read` once a real run exists. Exit `0` means *measured*, even over the
ceiling — it is a measurement, not a gate; gate yourself with `jq -e
'.corpus.corpusBytes <= .corpus.corpusCeiling'`. Exit `2` covers a usage error, an unresolvable target, no
readable `SKILL.md`, or a git work tree with 0 tracked files (mirrored from staging's own refusal; a
folder that is not a work tree is measured raw, as staging copies it) — staging's git rules, which
`lint-skill`'s static count never applied.

### Has the skill changed? — `corpusHash`, `skillTreeHash`, `packagedCorpusHash`

Every report, and every `--corpus-only` payload, carries three content hashes (`sha256:…`), each over files
keyed by their path inside the mounted folder, so two clones of the same commit hash alike whatever their
directory is called:

| Hash | Covers | Equal between `--corpus-only` and a graded run? |
|---|---|---|
| `corpusHash` | the evaluator's static corpus: `SKILL.md`, the skill's `references/**`, the resolved agents, and the plugin-root references they link to | yes, unless one of those files changed in between |
| `skillTreeHash` | every file staging delivered for the skill — its whole folder, `scripts/` included — plus the resolved agents and linked plugin-root references | yes, unless one of those files changed in between |
| `packagedCorpusHash` | what the packager put in the evaluator's corpus: the static corpus plus plugin-root files the graded agent READ, and how much of each file the ceiling kept | no: it moves whenever the agent's reading differs, or that reading pushes the corpus over the ceiling |

- **Which to key on.** `skillTreeHash` is the "anything changed" key. `corpusHash` is a FLOOR for it: an
  unchanged `corpusHash` does not mean unchanged behaviour, because `scripts/` and other files outside the
  corpus are not in it. `packagedCorpusHash` is evidence of what was graded, not a "changed" key.
- **Which files.** `corpusManifest` lists one row per corpus file (`origin`, `key`, `status`, `sha256`, and
  `keptBytes` when the ceiling cut it); diff two manifests to see which file made two hashes differ. A file
  that is delivered but cannot be read is a row with `status: "unreadable"` (`missing` for a resolved agent
  whose file does not exist), so it moves the hash too.
- **What was delivered.** `hashBasis` says how the delivered set was decided: `git-tracked` (a folder in a
  git work tree — its tracked files, hashed from their working-tree bytes, so a local edit to a tracked file
  changes the hash), `worktree-all` (no work tree, or `COWORK_HARNESS_GITSET=0`: every file), or
  `git-commit` (a `git:` target, below). In git mode a file under the skill that staging does not deliver —
  untracked or ignored — is not mounted and not hashed; it is listed in `skillTreeUntracked` (the first 50
  names; `skillTreeUntrackedCount` has the total) and warned about before a paid critique, so a script you
  changed but never added is visible instead of reading as "unchanged". `.git` itself is never listed or
  hashed.
- **An edit during the run.** A graded critique packages the corpus twice: before it spends, and after both
  turns. If a corpus or skill-tree file changed in between, the report carries `corpusDrift` (the earlier
  hashes and the files that changed, scripts included), the text report warns, and its hashes describe the
  later state. Critique a commit
  (`git:<ref>:<path>`) to rule this out.
- `corpusHashScheme` versions the rules; hashes compare only within one scheme. `gradedSkillHash` is
  unchanged and still keys the whole mounted plugin.

**Why not just `lint-skill --strict`?** It's free and needs no git, but it diverges from what a critique
actually packages on four measured axes: it counts (1) an untracked file staging would drop and (3) a
symlink pointing outside the plugin that the packager's containment rule refuses — both **over-counts**
— and it cannot see (2) a plugin-root reference read at run time, and (4) sums `st_size` where the
packager measures decoded UTF-8 length — both **under-counts**. Axis (4) moves only where a file is NOT
valid UTF-8 (each invalid byte decodes to a 3-byte U+FFFD); clean multibyte text — em dashes, curly
quotes — round-trips byte-exact, so on ordinary markdown its delta is zero. It also emits nothing below 80% of the
ceiling, so a skill in that band gets no number at all. On a clean tree — everything tracked, no symlinks,
clean UTF-8, and before any run — the two numbers agree exactly (measured: all six skills of a consumer
plugin, delta zero); the axes bite only when one of those conditions is violated, which is precisely
when you cannot tell from the static number alone. `--corpus-only` closes (1) and (3) by construction
(it runs the real staging filter and the real containment rule) and states (2) as the floor rather than
guessing at it.

**The corpus is a subset of the mount.** Every file the evaluator receives is one staging delivered:
every corpus class — `SKILL.md`, skill `references/**`, `agents/**.md`, plugin-root `references/` — is
checked against ONE git-tracked set, read at the folder the graded turn mounts, exactly as staging reads
it. A skill that is a git submodule of its plugin (staging delivers an empty `skills/<name>/`), or a
`--skill` subdirectory with nothing tracked under it, is therefore never packaged — and both a paid
critique and `--corpus-only` refuse such a target **before any spend**, in staging's terms (exit 2,
"`skills/<name>/` has 0 git-tracked files under …"), as they do a target with no readable, tracked
`SKILL.md`.

**`--dry-run` is refused on `critique`** with a reason pointing here: there is no meaningful two-turn
preview, so `--corpus-only` answers the no-spend evidence-corpus question and `skill --dry-run` answers
the no-spend invocation-plan question.

**`scripts/` is outside the evaluator's corpus — deliberately, and with one consequence worth knowing.**
The four classes above are the whole corpus: `SKILL.md`, the skill's own `references/**`, every
dispatchable `agents/**.md`, and — for a multi-skill plugin — the shared plugin-root `references/` files
the skill actually links (never the whole shared tree; see [Multi-skill plugins](#multi-skill-plugins---skill)
above). The
*graded* agent, by contrast, has the skill's `scripts/` mounted and is explicitly invited to reflect on it
(the reflection prompt asks about "SKILL.md and anything under `references/` or `scripts/`"). The two
actors therefore see different things, which is correct — the evaluator grades authored *guidance*, not
implementation. But it means a reflection finding grounded in a script's behaviour has no corpus text
behind it, so citation validation cannot confirm or refute it and it tends to land as not-adjudicable.
If a script's contract matters to how the skill is *used*, state it in `SKILL.md` or a `references/` file;
that is what reaches the evaluator.

**A corpus-ceiling breach has a second, sharper consequence than the not-adjudicable steer: DROPPED
findings.** Citation validation checks each finding's `evidence` excerpt verbatim against the *packaged*
(cut) copy — so a finding that quotes text past a per-file cut cannot resolve and lands in **DROPPED**,
even when the quote is a perfectly accurate excerpt of the real file. A skill well over the ceiling should
expect a not-adjudicable/DROPPED skew concentrated on whichever file(s) `corpusCuts` names; if you see
findings in DROPPED against a corpus that reported cuts, this is why — front-load the operative guidance,
split the oversized file, or treat those items as leads to re-check by hand.

### Run-dir artifacts

Beyond stdout, every critique leaves durable artifacts at the run-dir root (best-effort writes —
`turns/1/`, `turns/2/` and the `*.graded.json` aliases sit alongside them):

| File | When | What |
|---|---|---|
| `critique-report.json` | always | the machine-readable report a harvester reads without shell redirection |
| `critique-evidence-package.txt` | when the evaluator ran | the **armored** corpus the evaluator actually graded against — re-grade a disputed finding offline against the exact record |
| `critique-salvage.json` | exit 2 only | the self-report + each evaluator pass's RAW reply (captured **pre-parse**), so salvage is a file read, not console scraping |

These files, and the `--out` file, are secret-scrubbed when they are written, like the run's own
`result.json`: every value in `COWORK_HARNESS_SCRUB_VALUES`, the env vars named in
`COWORK_HARNESS_SCRUB_KEYS`, and the auth variables (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_CUSTOM_HEADERS`) is written as `[REDACTED]`. What critique prints to the
terminal follows the CLI-wide scrub described in
[docs/cli.md](./cli.md#secret-scrubbing-and-cassette-redaction). The text files are scrubbed as text. The
JSON files are scrubbed **by value**, so they parse whatever the scrub set, and only these exact fields are
kept as written, because they are join keys or closed enums:

- at the report root (and under `reportState` in the salvage file): `sessionId`, `outDir`, `skillFolder`,
  `skillDir`, `gradedSkill`, `gradedSkillHash`, `gradedModels`, `evaluatorModel`, `requestedModel`,
  `fidelity`, `requestedFidelity`, `gradedEffectiveFidelity`, `gradedBaseline`, `taskResult`,
  `gradedOutcome`, `selfReportStatus`, `skillMdStatus`, `infraFailurePhase`, `infraFailureKind`,
  `verdictProvenance`, `harnessVersion`, `corpusHash`, `packagedCorpusHash`, `skillTreeHash`, `hashBasis`,
  `source.kind`, `source.commit`, `corpusManifest[].origin`, `corpusManifest[].status`, `corpusManifest[].sha256`,
  and `corpusDrift`'s two hashes (a manifest `key` is a file name, and is scrubbed);
- `items[].source`, `items[].classification`, `items[].findingFingerprint`, `gateAnswers[].answeredBy`,
  `evidenceBudget.corpusOmitted[].reason`;
- in the `--corpus-only` payload: `mode`, `skillFolder`, `skillDir`, `skill`, `corpus.corpusOmitted[].reason`,
  and the same hash, basis, source and manifest fields. Its stdout is scrubbed the same way as its file.

A field with the same name anywhere else is scrubbed. Two consequences:

- `findingFingerprint` is hashed over the **scrubbed** `idea` and `recommendedAction`, so it can't be used
  to confirm a guess at a scrubbed value. A finding whose text carries no scrub value fingerprints exactly
  as before; one that does fingerprints as its `[REDACTED]` text, and clusters only with runs that scrubbed
  the same values.
- An item's `evidence` excerpt stays a substring of `critique-evidence-package.txt`, except where the
  excerpt starts or ends partway through a scrubbed value.

These artifacts (and the report's JSON shape) are part of critique's **EXPERIMENTAL** surface — useful
and stable in practice, but not yet a frozen SPEC §12 covered surface; field additions are expected.
The report's field names and shapes are authoritatively described by
[`schema/critique-report.json`](../schema/critique-report.json) (descriptive + test-pinned against the
actual builder, unlike the §12-frozen `doctor.json`), so automation consumers — budget pacers gating on
`costUsd.complete`, harvesters pairing on `gradedSkill` — parse against a schema, not prose.

## Reading several critiques of the same skill

`critique --repeat` is refused (fixed two-turn protocol). To see how stable a critique is, run it more than
once with the same probe and read the reports together:

```bash
for i in 1 2 3; do
  cowork-harness critique ./my-plugin --skill my-skill --prompt "<same probe>" \
    --output-format json --out "runs/critique-$i.json"
done
```

- **Same skill generation?** pair by `skillTreeHash` (every delivered file of the skill; `corpusHash` is a floor —
  see [Has the skill changed?](#has-the-skill-changed--corpushash-skilltreehash-packagedcorpushash)).
  (`gradedSkillHash`, `gradedSkill`) is coarser: `gradedSkillHash` keys the whole mounted plugin, so an edit to a
  sibling skill moves it; `gradedSkill` is the report's resolved `skills/<name>` (or the registered name of a skill
  folder that cannot be promoted to its plugin).
- **Same finding?** Read the reports side by side, finding by finding, aligned by `classification`. No key in the
  report proves two findings are the same:
  - **`findingFingerprint`** hashes the model-written `idea`, the `classification` and the `recommendedAction`. It
    matches only when the wording repeats exactly, and across repeats of the same probe it often never recurs. A
    match is a LOWER bound — it shows the same wording came back; no match shows nothing.
  - **The cited `evidence` excerpt** is shared by unrelated findings as often as by the same one: a short passage of
    the skill gets cited for different ideas. Two items quoting the same excerpt are a cue to read both, not a match.
- To make the graded runs deterministic across repeats, copy the report's echoed `--answer` lines
  (the graded run's resolved gate answers) into the next invocation.

### `critique --compare` — the reports side by side

```bash
cowork-harness critique --compare runs/critique-*.json
cowork-harness critique --compare before/*.json after/*.json --output-format json   # two --label groups
```

No spend and no model: it reads `--output-format json` reports (or `--out` files written as json) and
`--summary-out` files, and lays them out for a person to read. It renders **no verdict** — no "reproduced",
"one-off", "gone" or "new" — because no key in a report can prove two findings are the same finding:

- **Groups** are by `--label`: one group, or two (before/after). Label every critique or none. More than two
  groups is refused.
- **`byClassification`** lists every finding per report, aligned by classification.
- **`sameWording`**: an exact `findingFingerprint` seen in k of N reports — the same wording came back. A
  LOWER bound: reworded repeats do not match.
- **`sharedExcerpt`**: the same cited passage under the same classification in k of N reports, with how many
  distinct ideas and actions cite it — a cue to read those items together, not a match. Not-adjudicable
  items and excerpts under 12 characters are left out. Full reports only.
- **`fingerprints`**: every exact fingerprint with its k/N in each group (one entry per group).
- **`possibleRewordings`**: pairs of items in different reports, same classification, whose ideas share most
  of their words — a lexical judgement, labelled as one. Full reports only (a summary has no text).
- **`noiseFloorControl: true`** when both groups have the same `corpusHash` and one, shared `skillTreeHash`: the
  same skill in both, so any difference is run-to-run variation. A `scripts/` edit moves `skillTreeHash` only, so
  it is never a noise-floor control.

It refuses (exit 2): a mix of graded skills, of `corpusHashScheme` or `fingerprintScheme`, or of harness
major versions; a mix of `corpusHash` within one group (give the other corpus its own `--label`); the same
critique given twice (a summary and its own report count as the same critique); a report from before 4.8.0;
a `--corpus-only` envelope; any run flag. A critique that produced no result, whose evaluator canary
failed, or that drifted during its run is **excluded from N** and listed in `excluded`. A group that mixes
evaluator models (`mixedEvaluator`), hash bases (`mixedBasis`), skill trees (`mixedSkillTree` — a `scripts/` edit
inside the group) or probes (`mixedProbe`), or that holds a pass-1-only critique (`pass1Only`), is **marked**,
and `--strict` refuses it. Two marks are recorded but never refused: `mixedPackagedCorpus` (it moves with what
the agent happened to read) and `probeUnverified` (a member has no probe hash — the default for a summary
written without `--summary-include-prompt-hash` — so a same-probe group cannot be confirmed). Its output carries finding text (`"publicSafe": false`): keep it
out of a public repository — that is what `--summary-out` is for. `--out` writes the same bytes as stdout.
The JSON payload is described by [`schema/critique-compare.json`](../schema/critique-compare.json).

> **Why one critique is a SAMPLE, measured.** Two runs of the same skill over the same document
> produced 78 vs 50 extracted figures, and 12 vs **0** first-pass errors from the same producer bug.
> The bug was real and reproducible in isolation; the second run simply never generated an input shape
> that tripped it. For any defect gated on *what the model happens to produce*, a clean report is not
> evidence of absence — which is why it is worth running more than once.

## Critiquing a commit — `git:<ref>:<path>`

```bash
cowork-harness critique git:HEAD:plugins/my-plugin --skill my-skill --prompt "<probe>"
cowork-harness critique git:v1.4.0:plugins/my-plugin/skills/my-skill --corpus-only
```

The skill folder may be `git:<ref>:<path>`, relative to the repository the current directory is in. The
commit's files are written to a snapshot and critique runs on it, so an edit, a `git add` or a moved HEAD
during the run changes nothing, and two critiques of one commit grade the same files. The report records
`source: {kind: "git", ref, path, commit}` (the resolved commit id), and the hashes use basis `git-commit`.

- A path at `<plugin>/skills/<name>` is resolved in the **commit's** tree to skill `<name>` of the plugin —
  the same mount, corpus and graded skill as `critique <plugin> --skill <name>`. Any other path inside a
  plugin is refused with that spelling.
- Refused before any spend (exit 2): a ref that is not a commit, a path that is not a directory at it, a
  submodule, a path with `..` or a leading `-`, a git filter (Git LFS and similar — the commit holds pointers,
  not content) set by a `.gitattributes` in scope, by `.git/info/attributes` or by `core.attributesFile`, and a
  committed symlink whose real path is outside the snapshot or that points at nothing.
- The snapshot is kept under `~/.cowork-harness/critique-snapshots/` (or `COWORK_HARNESS_CRITIQUE_SNAPSHOTS_DIR`),
  never under the runs directory, so the run's mount still resolves later. A refusal before the graded run
  starts removes it. Nothing else does: delete a snapshot once the runs that mounted it are gone.
  `--corpus-only` uses a temporary one (under `TMPDIR`) and removes it. Neither location may be inside a git
  work tree.
- Under `git-tracked`, a dir target's bytes are the working tree's; under `git-commit` they are the commit's.
  A smudge filter, `core.autocrlf` or `ident` can make the two differ for the same commit.
- For a `git:` target the report's `skillFolder` is the snapshot directory (under `--corpus-only`, a temporary
  one that is already gone); the argument as given is in `source.ref` and `source.path`.

## A public summary — `--summary-out`

`--summary-out <file>` writes a second, small JSON file meant to be committed to a **public** repository — a
ledger line per critique. It is built by allowlist from the report: identifiers (`sessionId`, `gradedSkill`,
`label`, `source.commit`), the hashes, enums and counts, and per finding only `findingFingerprint`,
`classification`, `source` and `adjudicable`. No idea, evidence or action text, no prompt, no host path, no
git ref or path. Its shape is [`schema/critique-summary.json`](../schema/critique-summary.json).

- Every value is checked against the shape its field must have (a model id must read `claude-…`, a label
  `[A-Za-z0-9._:+-]`, a hash `sha256:<64 hex>`). A value that fails is written `null` and named in `withheld`.
- The finished summary goes through the secret scrub. If the scrub would change anything, the file is **not
  written**, a warning says so, and the exit code is unchanged.
- Cost (`--summary-include-cost`) and the probe's sha256 (`--summary-include-prompt-hash`, which confirms a
  guessed probe) are left out unless asked for.
- A dropped item (its citation is not verbatim in the evidence) is left out. A not-adjudicable item is kept,
  with `adjudicable: false`.
- It is written on every outcome that writes a report, with `status` (`critiqued`, `task_turn_failed`,
  `reflection_turn_failed`, `evaluator_failed`), and by `--corpus-only` (`status: "corpus_only"`, no items).
- A plain skill folder, which the report leaves without `gradedSkill`, is named by its `SKILL.md`
  frontmatter, else its folder (`gradedSkillKind: "folder"`).

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
Changing the evaluator model invalidates that verification. It was also measured before the evaluator ran
tool-less and isolated from your own Claude Code setup; the isolation removes what an injection could reach (no
tool can run), but the probe has not been repeated under it.

This is the same "advisory, not an attestation" property named under [Known limitations](#known-limitations):
a skill you did not write can steer the grade, so its output is a lead to run down — never proof.

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

- **`[deliberate]` The verdict is an advisory self-run — a discovery lead, not an independent attestation.**
  The skill under review controls text (its `SKILL.md`) that enters the evaluator's prompt, so a crafted
  skill can steer the grade. Treat the output as a lead to investigate — never as trustworthy proof of a
  skill's quality or safety, and never as a gate. This holds whether you authored the skill or are probing
  one you did not (see *Running it on a skill you did not write* above). It is a separate point from "never a
  gate / findings exit 0", which is about not blocking CI on findings.
- **Tiers.** critique runs at `--fidelity container` (default), `hostloop`, or `cowork`. The
  container→hostloop pin was lifted on 2026-07-23 once hostloop resume-continuity was proven live against
  the *native* agent binary (`test/live-contract.test.ts`, "resume-continuity proof at hostloop"; 4/4
  runs). `cowork` is not a fourth environment: it means *"whichever tier real Cowork would use here"*, and
  is resolved **once, before either turn is spawned**, from the pinned baseline's loop gate — both turns
  then receive the resolved literal. That single resolution is what makes it safe; a cross-tier `--resume`
  (turn 1 at one tier, turn 2 at another) is blocked fail-loud by the session-manifest fidelity stamp. The
  resolution is echoed to stderr as `[loop] cowork → <tier>` and reported as
  `requestedFidelity` alongside the tier that ran, so a report never reads as though you named the tier
  yourself. The two tiers still refused, each for its own reason:
- **`[unverified]` The microvm tier is refused** — resume-continuity is unproven for the microVM guest (a
  different Apple-VZ guest and in-guest session store than the proven container/hostloop tiers). A live
  resume-continuity proof there would lift it.
- **`[not-built]` The protocol tier is refused** — it never plumbs a session id or `--resume`, so
  critique's two-turn resume protocol has nothing to resume. Adding session plumbing to the protocol tier
  (which also runs with no sandbox) would be the work.
- **`[deliberate]` Skill-authored content ships WHOLE, not rationed** — of what the mount carries: SKILL.md,
  the skill's own `references/**`, and every dispatchable `agents/**.md` are packaged in full, up to a **512 KiB combined
  corpus ceiling** covering all three together. For a multi-skill plugin, a **fourth** class joins the
  ceiling: plugin-root `references/` files that the skill's own text, a packaged agent body, or the graded
  agent's own read of it actually points at. Recognized link forms are `${CLAUDE_PLUGIN_ROOT}/references/x.md`,
  `<plugin-name>/references/x.md`, or a relative path that resolves into the plugin-root `references/`
  dir — a bare `references/x.md` in a skill's own text means the skill's **own** references, never the
  root's. Packaging the WHOLE shared tree instead was measured and rejected: on a real 6-skill plugin it
  pushed one skill's corpus to 107% of the ceiling and made the allocator cut that skill's own SKILL.md by
  37,295 B, and because the `already-covered` classification judges by presence with no notion of which
  skill authored a file, another skill's shared docs would silently excuse a real gap. A fourth link
  form is less obvious: a token resolving to the shared `references/` **directory** arms bare-filename
  matching **for that line only**, so ``From `${CLAUDE_PLUGIN_ROOT}/references/` (shared): `a.md`, `b.md```
  links both files though neither carries a path. That is the shape most real plugins use. The cost is
  that matching is textual with no notion of intent — a filename on an arming line is packaged even if the
  prose says *not* to read it, and a link inside a fenced code block counts like any other — so each
  packaged section states the `file:line` it came from, the same provenance the sub-agent sections carry
  and for the same reason. A plugin-root
  reference must additionally decode as clean UTF-8 to be packaged — a binary asset such as a font is
  excluded — while the skill's **own** `references/**` still has no extension or content filter at all;
  that asymmetry is deliberate, not an oversight. Every plugin-root file the rule leaves out is reported in
  `evidenceBudget.corpusOmitted` (`not-linked`, `not-utf8`, or `ambiguous-read`, plus `alsoUntracked`
  where it could be evaluated), never dropped silently.
  The ceiling itself is a sanity valve, not an allocation (~2.3x the largest skill measured
  when it was sized); a breach is cut **loudly** — the named file and byte counts are reported — never
  refused, and never silent. The **transcript** is bounded separately at **128 KiB**, with a head+tail cut
  and an elided middle, so both a run's setup and its conclusions survive a cut rather than just one end.
  A **missing**, **unreadable**, or **untracked** SKILL.md forces the mechanical `"already-covered"` →
  `"not adjudicable"` downgrade; a claim about content that fell outside a cut section is likewise routed
  to `not-adjudicable`, never treated as evidence the thing didn't happen.
- **`[not-built]` English-only prompts.** No localization has been attempted; nothing blocks it.

### Reading the graded turn's result

`critique` runs two turns into one run directory. Each turn's artifacts live in **`turns/<N>/`**, written
once and never renamed — so the graded turn is `turns/1/`, and the reflection turn is `turns/2/`. There is
**no root compat copy of anything** — `<run-dir>/result.json` does not exist. Rather than expect you to
reach into `turns/1/` yourself:

- **whether the skill's own `references/`/`scripts/` were ever reached is in the report** (`noSkillFilesRead`
  in `--output-format json`, and a header line). It reads `referencesAccessed` — main agent **and**
  sub-agents, through **any** observed tool channel (`Read`, `Grep`, or a `Bash` command naming the
  path under the mounted plugin), not the `Read` tool alone. Detection **under-approximates**: a `cd` into
  the skill dir followed by a bare `cat references/x.md`, a heredoc body and a `$VAR`-built path are all
  invisible, so a "nothing was accessed" line is **weak evidence of non-use, never proof the content went
  unread** — do not re-architect a reference document on it alone. Where the run recorded no observable
  tool stream the report makes **no claim** rather than rendering a clean negative;
- the graded turn's **model ids are in the report itself** (`gradedModels` in `--output-format json`, and
  as `graded model(s):` in the text header), read back from the graded turn's own `result.json`. **The
  turns are a subprocess and inherit no model from whatever invoked `critique`** — they take `--model`,
  or `COWORK_HARNESS_MODEL` from critique's own environment, and critique refuses before the task turn
  when neither is set. Read `gradedModels` back to confirm which model served the run. Note this is **observed, not requested**: the ids come from the model stamped on the graded
  turn's assistant messages, never from the flag — so `graded model(s): unknown` means no assistant
  message reached the run (a crash, a kill, a gate before the first reply), which passing `--model`
  does not change;
- **how the evaluator ran is in the report itself**: `evaluatorTransport` in `--output-format json`
  (`{isolation, cliVersion?, effort?, settingsEnvOverride?, settingsMaxEffort?, strictMcp?}` — the isolation level of
  the host `claude` call, that CLI's version, the `--effort` it was called with (`high`; absent from a report written
  before it was recorded), the effort/thinking keys a user-settings `env` block sets (names only, blanked by the call),
  a user `maxEffortLevel` (which lowers the effort when below it), and
  `strictMcp: false` when it left out `--strict-mcp-config` for an enterprise MCP config), present
  with `evaluatorModel`, so two critiques' evaluator verdicts can be compared knowing both ran under the same
  conditions;
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
- **`[deliberate]` An invocation the record cannot attribute to one skill is reported absent, never
  false.** `skillInvocationObserved` reads three channels — the main agent's `Skill` tool calls, a
  sub-agent's `Skill` calls (from the turn's `events.jsonl`, which carries the skill name on the parented
  frame), and a leading slash token in the prompt. Two shapes leave a channel readable but the answer
  undecidable: a bare `/name` that more than one staged skill answers to (the agent resolves it to a
  plugin skill; the record does not say which when several qualify — and when the several are two copies
  of one plugin, Cowork's app, which resolves a typed slash before the agent, refused it outright in the
  runs observed on Desktop 2.19675.0, 2026-10-03; two different plugins sharing a skill name were not
  measured), and a plugin shipping both
  `commands/<n>.md` and `skills/<n>/SKILL.md`, where the slash entry and the `Skill` tool launch either
  through one registry and the run records the name, not the kind. Both report *absent* rather than a
  guessed `true` — and the text report says so in a NOTE, so "could not observe" never reads like "not
  applicable".
