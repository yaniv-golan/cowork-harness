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

> The cheap authoring loop falls out of this: keep **one** run, then iterate answers and assertions
> against it with `trace` + `verify-run` for free. Re-keep after a skill change that moves gate phrasing —
> a kept run is a snapshot, not a live mirror.

---

## The run was green but you don't trust it — hunt the false-green

The harness can *silently* no-op a check: skip an assertion on replay, auto-answer a gate, observe an
empty egress allowlist. A green run is not automatically a correct run.

- **The "✓ passed ≠ correct" landmines** — the catalog of how a check can pass vacuously (mixed
  content/live assertion items, header-only gates that can't be keyed, replay-skipped egress keys) is in
  the companion skill's **Gotchas** section:
  [SKILL.md → Gotchas](../.claude/skills/cowork-harness/SKILL.md#gotchas--the--passed--correct-landmines).
  Read it before trusting a green you didn't expect.
- **`lint`** — run it on a scenario before committing: it catches assertions placed on the wrong CI lane,
  mixed content/live keys, and keys the replay lane can't check — the silent false-greens you can't see by
  eye.
- **`verify-cassettes`** — the token-free gate over committed cassettes: a privacy scan plus a staleness
  check ("edited the skill, forgot to re-record"). See [cassette.md](./cassette.md).
- **`COWORK_HARNESS_DEBUG_SKILLHASH`** — when a cassette is flagged stale and you can't see why, this env
  var dumps the exact file set feeding the skill hash (and flags OS-junk like `.DS_Store`) so the drift
  source is one line. See [README → Reproducibility knobs](../README.md#reproducibility-knobs).

---

See also: [boundary.md](./boundary.md) (is the sandbox even enforcing what you think?) and
[fidelity-gaps.md](./fidelity-gaps.md) (the known deltas vs. real Cowork — sometimes the "bug" is a
deliberate gap).
