# Debugging a run

When a run does the wrong thing — or greens when you don't trust it — this is the map. It routes you to
the right tool; the authoritative reference for each command's flags is its `--help` and the
[README → Commands at a glance](../README.md#commands-at-a-glance).

Two situations need different tools. Figure out which one you're in first:

- **The skill misbehaved** — wrong output, a gate you didn't expect, a tool denied. Investigate the run.
- **The run was green but you don't trust it** — an assertion that may have tested nothing, a stale
  cassette, an auto-answered gate. Hunt the false-green.

Every run writes to `~/.cowork-harness/runs/<scenario>/<sessionId>/` (relocatable). The files there —
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
3. **`chat` — reproduce it by hand.** An interactive multi-turn REPL against the live runtime, gates
   answered at the TTY. Use it to reproduce a permission/gate flow interactively or poke a stochastic
   multi-turn skill. It is *not* an asserted test — it's the exploratory loop. Full reference:
   [chat.md](./chat.md); the debugging-specific notes (use the sandboxed `chat`, not the raw passthrough;
   promote a finding to a scenario afterward) are in
   [scenario.md → Debugging with `chat`](./scenario.md#debugging-with-chat).
4. **`verify-run` — re-assert cheaply.** If the run itself was fine and only an *assertion* is wrong,
   re-check the scenario's assertions against the kept run dir with no live re-record (~1s). When the
   scenario scripts answers, it also re-checks they still match the run's actual gates — so a reworded gate
   or a chosen option the run never offered fails here in a second instead of on a paid re-record.
5. **`diff` — what changed between two runs (or a run and a cassette)?** Compares tool sequence,
   transcript, artifacts, and result/fidelity/baseline meta, with normalization masking per-run noise
   (tool-use ids, timestamps, session-dir markers, host paths) so two runs of the *same* scenario diff as
   identical despite that noise. Reach for it when "it worked yesterday" needs a concrete answer instead of
   a guess — `cowork-harness diff <old-run> <new-run>`. `--no-normalize` compares raw values for forensics;
   `--view tools|transcript|artifacts|meta` narrows to one section. Token-free (no live re-record needed).
   Comparing runs of two *different* scenarios is allowed (useful for skill-variant comparison) but warns
   on stderr — added/removed rows may then reflect scenario differences, not drift.
   The same command also compares two committed platform baselines (`diff desktop-<a> desktop-<b>
   [--changelog]`) — see [maintenance.md](./maintenance.md).

> The cheap authoring loop falls out of this: keep **one** run, then iterate answers and assertions
> against it with `trace` + `verify-run` for free. Re-keep after a skill change that moves gate phrasing —
> a kept run is a snapshot, not a live mirror.

---

## The run was green but you don't trust it — hunt the false-green

The harness can no-op a check in ways that still produce a green run: skip an assertion on replay (now
flagged with a loud `::warning::`, not silent), auto-answer a gate, observe an empty egress allowlist.
A green run is not automatically a correct run.

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

See also: [boundary.md](./boundary.md) (is the sandbox even enforcing what you think?) and
[fidelity-gaps.md](./fidelity-gaps.md) (the known deltas vs. real Cowork — sometimes the "bug" is a
deliberate gap).
