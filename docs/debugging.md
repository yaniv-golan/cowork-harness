# Debugging a run

When a run does the wrong thing — or greens when you don't trust it — this is the map. It routes you to
the right tool; the authoritative reference for each command's flags is its `--help` and the
[README → Commands at a glance](../README.md#commands-at-a-glance).

<!-- BEGIN triage-canonical -->
Two situations need different tools — figure out which one you're in first, then reach for the tool
instead of re-running and hoping. The run already wrote its evidence to a kept run dir (`--keep` prints
the path; `trace <run-id>` finds it), and every tool below reads that evidence **token-free** — no
Docker, no re-record.

| Situation | Symptom | Reach for (in order) |
|---|---|---|
| **The skill misbehaved** | wrong output, an unexpected gate, a denied tool, an opaque crash | `inspect` — what did it produce? · `trace <run-dir> --view <view>` — what did it actually do (tools, gates, sub-agent tree)? · `verify-run` — re-assert cheaply when only an assertion is wrong · `diff <old-run> <new-run>` — what changed since it worked · `chat` — reproduce it by hand |
| **A green you don't trust** | an assert that may have tested nothing, a stale cassette, an auto-answered or decided gate | `replay --explain` — the evidence trail behind each *passing* assert · `lint` — assertions on the wrong CI lane / mixed-class keys · `verify-cassettes` — privacy + staleness over committed cassettes · the Gotchas landmine catalog — how a check passes vacuously · `run --repeat N` — did it pass, or pass once? · `stats` — flaky or expensive over time |

A failed run also records `errorSource` (where the failure originated) and `stderrLogPath` (the captured
agent stderr) — read those before re-running; a re-record rarely tells you more than the captured stderr
already does.
<!-- END triage-canonical -->

Every run writes to `~/.cowork-harness/runs/<scenario>/<sessionId>/` (relocatable). A `chat` run instead
writes to `runs/chat/<sessionId>/` — the first path segment is the literal `chat`, not a scenario name.
The files there —
`events.jsonl`, `run.jsonl`, `trace.json`, `result.json`, `egress.log`, `agent.stderr.log` — are the raw
evidence; see [README → What you get out](../README.md#what-you-get-out-inspectable-output) for the layout
and how to relocate it. The tools below digest them so you rarely hand-parse.

**Why paths look different at different fidelity tiers:** at `hostloop`, `computer://` links and tool
arguments render as real host paths (`/Users/…`) because hostloop's file tools run natively against your
machine — the displayed path is the one the model actually touched. At `container`/`microvm`/`protocol`,
the same content stays VM-shaped (`/sessions/<id>/mnt/…`) because a mount's "host" side there is
harness-internal staging, not a real user directory — translating it would be *less* faithful, not more.
This isn't scattered per-command logic: the gate and the rewrite both live in one place,
`makeDisplayTranslator` in `src/run/display-translate.ts`, with one exception carved out — `--compact`/
`--demo` (shareable) output stays untranslated even at hostloop, so a shared transcript never leaks a real
host path.

---

## The skill misbehaved — investigate the run

A post-hoc loop over a **kept** run dir — one you preserved with `--keep` (or any `--session-id` run)
rather than let the harness clean up. None of these spend tokens or need Docker — they read the run that
already happened.

1. **`inspect` — what did it produce?** The artifacts the run wrote, plus a shallow field preview of each
   JSON artifact. Works on a salvaged `PARTIAL` run too. Reach for it first to confirm whether the job
   was actually done before asking *why* it wasn't.
2. **`trace` — what did it actually do?** Digests the run's `events.jsonl` into the tools it called, the
   questions (gates) it was asked and how they were answered, and the sub-agent dispatch tree. This is how
   you answer "how many sub-agents *really* dispatched?" or "which gate fired, with what offered labels?"
3. **`verify-run` — re-assert cheaply.** If the run itself was fine and only an *assertion* is wrong,
   re-check the scenario's assertions against the kept run dir with no live re-record (~1s). When the
   scenario scripts answers, it also re-checks they still match the run's actual gates — so a reworded gate
   or a chosen option the run never offered fails here in a second instead of on a paid re-record.
4. **`diff` — what changed between two runs (or a run and a cassette)?** Compares tool sequence,
   transcript, artifacts, and result/fidelity/baseline meta, with normalization masking per-run noise
   (tool-use ids, timestamps, session-dir markers, host paths) so two runs of the *same* scenario diff as
   identical despite that noise. Reach for it when "it worked yesterday" needs a concrete answer instead of
   a guess — `cowork-harness diff <old-run> <new-run>`. `--no-normalize` compares raw values for forensics;
   `--view tools|transcript|artifacts|meta` narrows to one section. Token-free (no live re-record needed).
   Comparing runs of two *different* scenarios is allowed (useful for skill-variant comparison) but warns
   on stderr — added/removed rows may then reflect scenario differences, not drift.
   The same command also compares two committed platform baselines (`diff desktop-<a> desktop-<b>
   [--changelog]`) — see [maintenance.md](./maintenance.md).
5. **`chat` — reproduce it by hand.** An interactive multi-turn REPL against the live runtime, gates
   answered at the TTY. Use it to reproduce a permission/gate flow interactively or poke a stochastic
   multi-turn skill. It is *not* an asserted test — it's the exploratory loop. Full reference:
   [chat.md](./chat.md); the debugging-specific notes (use the sandboxed `chat`, not the raw passthrough;
   promote a finding to a scenario afterward) are in
   [scenario.md → Debugging with `chat`](./scenario.md#debugging-with-chat).

> The cheap authoring loop falls out of this: keep **one** run, then iterate answers and assertions
> against it with `trace` + `verify-run` for free. Re-keep after a skill change that moves gate phrasing —
> a kept run is a snapshot, not a live mirror.

---

## The run was green but you don't trust it — hunt the false-green

The harness can no-op a check in ways that still produce a green run: skip an assertion on replay (now
flagged with a loud `::warning::`, not silent), auto-answer a gate, observe an empty egress allowlist.
A green run is not automatically a correct run.

- **`replay --explain`** — the flagship tool for exactly this hunt: after the footer, it prints the
  evidence trail behind every **passing** assert (which `computer://` link resolved, which file matched,
  which value satisfied a bound), so you can tell a real green from a vacuous one at a glance instead of
  re-deriving it by hand. Text mode only; `--output-format json` already carries the same data in
  `assertions[].evidence`. See `replay --help`.
- **The "✓ passed ≠ correct" landmines** — the catalog of how a check can pass vacuously (mixed
  content/live assertion items, header-only gates that can't be keyed, replay-skipped egress keys) is in
  the companion skill's **Gotchas** section:
  [SKILL.md → Gotchas](../.claude/skills/cowork-harness/SKILL.md#gotchas--the--passed--correct-landmines).
  Read it before trusting a green you didn't expect.
- **Gate provenance** — a green run whose premise came from a *decided* (LLM/external) gate is the classic
  false-green. `result.json`'s `gateProvenance` block, the footer `gates: N · …` line, and
  `trace <run-dir> --view questions` (which now shows each gate's `by`/`model`) tell you exactly which
  gates were decided vs scripted — so you can spot a semantic assertion resting on a non-reproducible
  answer. Pin those gates with `--answer`. (Informational; live/`partial` lane only — see
  [fidelity-and-answers.md](../.claude/skills/cowork-harness/references/fidelity-and-answers.md).)
- **`lint`** — run it on a scenario before committing: it catches assertions placed on the wrong CI lane,
  mixed content/live keys, and keys the replay lane can't check — the silent false-greens you can't see by
  eye.
- **`verify-cassettes`** — the token-free gate over committed cassettes: a privacy scan plus a staleness
  check ("edited the skill, forgot to re-record"). See [cassette.md](./cassette.md).
- **`COWORK_HARNESS_DEBUG_SKILLHASH`** — when a cassette is flagged stale and you can't see why, this env
  var dumps the exact file set feeding the skill hash (and flags OS-junk like `.DS_Store`) so the drift
  source is one line. See [README → Reproducibility knobs](../README.md#reproducibility-knobs).
- **`run --repeat N`** — "did it pass, or did it pass once?" A green run proves nothing about reliability
  on its own. Repeat the same scenario N times and read the variance rollup (pass rate, per-assertion
  attribution, the signal histogram) instead of trusting a single green — `--min-pass-rate` sets the batch
  threshold, `--stop-on-diverge` stops as soon as flakiness is proven (that batch always fails).
- **`stats`** — "is this scenario flaky/expensive *over time*, across many separate `run`s (not just one
  `--repeat` batch)?" Every `run`/`skill`/`record` invocation is indexed automatically; `stats [<scenario>]`
  aggregates pass rate, cost/duration percentiles, and last-green timestamp across all of them —
  `--since`/`--branch` narrow to "since I started this fix" or "on this branch vs. main." See
  [stats.md](./stats.md).

---

## Iterating a skill across fixes — the verification loop

Hardening a skill is a loop: run it, read what it did, fix, run again. Two disciplines keep the loop
honest — **verify before you trust**, and **don't cross-pair generations**. This is a Reflexion-style
verification loop stacked on the agent loop; the harness gives you the substrate, you own the grader.

**Verify — ground a finding before trusting it.** A green run is not a correct run, and a skill's
self-reported finding (a self-critique appendix, "I extracted X") is not real until its cited evidence is
found in the run's own output. The harness emits everything a grader needs; the grader itself lives
*outside* the harness (it's your check, not a Cowork-runtime behavior):

- `result.json` → **`finalMessage`** (the skill's own answer/critique) and **`toolResults[]`** (tool
  outputs, capped).
- `cowork-harness trace <run-dir> --output-format json` → the tool-call stream. Add **`--full-results`**
  so a *successful* call's full input + result are captured (the default view slices them to ~100/120
  chars; full capture was error-only before). This is what lets an external grader confirm "the skill
  claims it read X and derived Y" against the actual call.
- `cowork-harness inspect <run-dir>` → what the run produced (artifacts + previews), plus the run's
  `label` and `skillHash` at the harvest moment.
- **In-run alternative:** dispatch a checker **sub-agent** (maker/checker split) whose result folds into
  the verdict — see [subagents.md](./subagents.md).

**Don't cross-pair generations.** When you run the same skill across fixes, a harvest step must not pair
a *pre-fix* `result.json` with a *post-fix* critique. The authoritative key is
**`fingerprint.skillHash`** — content-exact, recorded on every live run, and it changes on any tracked
edit (an un-`git add`-ed new file changes neither the hash nor the mounted skill). Group and pair on it;
`inspect` and the run-index row surface a short prefix so you needn't open each `result.json`.
`--label <tag>` adds a human-readable, orderable generation name on top (skillHash is the correctness
key; the label is ergonomics). And `verify-run <run-dir> <scenario.yaml>` is the native staleness guard:
it **warns** when a kept run predates the current skill, and for a scenario with scripted `answers`
**hard-fails** rather than vouch for a stale gate snapshot.

---

See also: [boundary.md](./boundary.md) (is the sandbox even enforcing what you think?) and
[fidelity-gaps.md](./fidelity-gaps.md) (the known deltas vs. real Cowork — sometimes the "bug" is a
deliberate gap).
