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
| **A green you don't trust** | an assert that may have tested nothing, a stale cassette, an auto-answered or decided gate | `replay --explain` — the evidence trail behind each *passing* assert · `lint` — assertions on the wrong CI lane / mixed-class keys · `verify-cassettes` — privacy + staleness over committed cassettes · the Gotchas landmine catalog — how a check passes vacuously · `run --repeat N` / `skill --repeat N` — did it pass, or pass once? · `stats` — flaky or expensive over time |

A failed run also records `errorSource` (where the failure originated) and `stderrLogPath` (the captured
agent stderr) — read those before re-running; a re-record rarely tells you more than the captured stderr
already does.
<!-- END triage-canonical -->

Every run writes to `~/.cowork-harness/runs/<scenario>/<sessionId>/` (relocatable). A `chat` run instead
writes to `runs/chat/<sessionId>/` — the first path segment is the literal `chat`, not a scenario name.
The files there — `events.jsonl`, `egress.log`, `agent.stderr.log` at the root, and each turn's
`run.jsonl` / `trace.json` / `result.json` / `resources.jsonl` under **`turns/<N>/`** — are the raw
evidence; see [README → What you get out](../README.md#what-you-get-out-inspectable-output) for the layout
and how to relocate it. The tools below digest them so you rarely hand-parse.

> **Multi-turn run dirs.** `--session-id` + `--resume`, and every `critique` (task turn + reflection
> turn), write several turns into one directory. Each turn's artifacts live in its own `turns/<N>/` and
> are never renamed or overwritten — there is **no root compat copy**; on a `critique` dir, read
> `turns/1/result.json` (or `result.graded.json`) for the graded turn, `turns/2/` for the reflection one.
> `events.jsonl` and `timeline.jsonl` stay cumulative across turns; the harness scopes its own reads of
> them to the current turn.
>
> A run dir with root `result.json`/`run.jsonl` (or a name-mangled `result.turn-<N>.json` archive) and
> no `turns/` predates this layout — the tools refuse it by name; see
> [Old run dirs (pre-`turns/` layout)](#old-run-dirs-pre-turns-layout) at the end of this page for
> `migrate-run-dir`.

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
  `trace <run-dir> --view questions` (which shows each gate's `by`/`model`) tell you exactly which
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
verification loop stacked on the agent loop; the harness gives you the substrate, and now ships a grader too
(`critique` — see [critique.md](./critique.md), which maps loop-engineering vocabulary onto this repo's terms
and states plainly which loops we deliberately do not provide).

### The whole loop, end to end

The pieces below are documented separately; this is how they assemble. This is the loop a real consumer
built on top of the harness before any of it shipped — the commands now replace the rig they hand-rolled.

```bash
SKILL=./my-skill
# Skill needs an attached input (cap table, deck, transcript)? Add `--upload <path>` / `--folder <dir>`
# to BOTH step 1 and step 3 — critique forwards them to its own two turns, and step 3 must reproduce
# with the same inputs the harvest used. See critique.md → "Skills that need an attached file".

# 1. HARVEST — run the skill against a real input and grade what confused the agent.
#    `critique` runs the task, asks the agent what was unclear, then verifies every claim against a
#    frozen record of the run. Findings never gate; exit 2 only if no critique was produced.
cowork-harness critique "$SKILL" --prompt "<a real task for this skill>" --output-format json > gen-1.json

# 2. TRIAGE — act only on ACTIONABLE. DROPPED items failed their citation check: the agent made them up.
#    NOT ADJUDICABLE means the evidence can't decide — your judgement, not the tool's.

# 3. REPRODUCE — before acting on a finding, check it isn't a one-run fluke.
cowork-harness skill "$SKILL" "<the same task>" --repeat 5 --label gen-1

# 4. FIX the skill. Then re-run — and PROVE the re-run used the fixed body:
cowork-harness skill "$SKILL" "<the same task>" --repeat 5 --label gen-2
#    `fingerprint.skillHash` changes on any tracked edit. If it didn't change, you tested the old skill.

# 5. COMPARE generations — pass rate, cost, and which verdict signals fired per generation:
#    (recipes in stats.md; they group on skillHash — the index stores a 12-CHAR PREFIX of it, which is
#     enough to pair within one project; the full hash is in each run's result.json)
jq -s 'map(select(.skillHash)) | group_by(.skillHash) | map({gen: .[0].runLabel, runs: length,
       passRate: ((map(select(.pass)) | length) / length)})' ~/.cowork-harness/runs/index.jsonl

# 6. Repeat from 1. Stop when critique stops producing ACTIONABLE findings you agree with.
```

> **Reading the comparison honestly:** step 1's `critique` is itself two indexed `skill` invocations (the
> task turn and the reflection resume). They carry the SAME `skillHash` as that generation's `--repeat`
> batch but no `--label`, so a gen-1 group is ~7 rows, `runLabel` can come back `null`, and the reflection
> turn's row dilutes `passRate`. Filter on `runLabel` if you want the batch alone.

**What each piece is for**, so you can swap any of them:

| Step | Command | Why it's needed |
|---|---|---|
| Harvest | [`critique`](./critique.md) | Agent self-reports confabulate. This is the part you cannot safely hand-roll |
| Reproduce | `--repeat` (both `run` and `skill`) | A single green run proves it passed *once* |
| Generation identity | `fingerprint.skillHash` | Proves the re-run used the fixed body, not a cached one |
| Compare | [`stats.md`](./stats.md) recipes, [`diff`](../README.md) | Pass rate, signals, and cost per generation |
| Branch on outcome | `result.json` `outcome` | One field instead of reconciling `result` × `verdict.pass` × exit code |

**The loop itself is yours.** Nothing here re-runs a skill until it "improves" — step 4's fix and step 6's
stopping decision are human calls, deliberately. See [critique.md](./critique.md) for why.

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
- **`cowork-harness critique <skill-folder> --prompt "<probe>"`** → the shipped version of this discipline:
  runs the skill, asks the agent what confused it, and grades that self-report against a frozen record of
  the run (blinded evaluator + mechanical citation checking). See [critique.md](./critique.md) for cost
  and limits. EXPERIMENTAL.
- `cowork-harness inspect <run-dir>` → what the run produced (artifacts + previews), plus the run's
  `label` and `skillHash` at the harvest moment.
- **In-run alternative:** dispatch a checker **sub-agent** (maker/checker split) whose result folds into
  the verdict — see [subagents.md](./subagents.md).

**Don't cross-pair generations.** When you run the same skill across fixes, a harvest step must not pair
a *pre-fix* `result.json` with a *post-fix* critique. The authoritative key is
**`fingerprint.skillHash`** — content-exact, recorded on every live `run`/`skill` run that mounts a skill
or plugin, and it changes on any tracked edit (an un-`git add`-ed new file changes neither the hash nor the
mounted skill). A run that mounts nothing has nothing to hash and records no `skillHash`; the `chat` lane
records no fingerprint at all. Group and pair on it;
`inspect` and the run-index row surface a short prefix so you needn't open each `result.json`.
`--label <tag>` adds a human-readable, orderable generation name on top (skillHash is the correctness
key; the label is ergonomics). And `verify-run <run-dir> <scenario.yaml>` is the native staleness guard:
it **warns** when a kept run predates the current skill, and for a scenario with scripted `answers`
**hard-fails** rather than vouch for a stale gate snapshot.

---

## Old run dirs (pre-`turns/` layout)

A run dir written before the per-turn layout existed — root `result.json`/`run.jsonl`, or a name-mangled
`result.turn-<N>.json` archive, no `turns/` — is a different shape. `verify-run`, `inspect`, `scaffold`,
`diff`, `status --latest-for` and a resumed `--session-id` all refuse it **by name** rather than
silently misreading it, and `stats --reindex` counts it as skipped instead of dropping it from the
index. `trace` still reads it fine, which is why every refusal points there: its views come from
`events.jsonl`, which never moves.

**Convert it in place:**

```bash
cowork-harness migrate-run-dir              # DRY RUN by default — reports, changes nothing
cowork-harness migrate-run-dir --write      # apply
cowork-harness migrate-run-dir --scenario <name> --write   # one scenario at a time
```

It renames rather than copies, so the file timestamps `stats` and `status --latest-for` rank by survive
untouched. Back up the runs root first, read the dry-run report, and rebuild the index afterwards with
`stats --reindex`. Staging one scenario, checking it, then doing the rest is the safer order.

**What it refuses vs. infers.** A directory it cannot resolve is **refused and named** — an artifact
that is neither a duplicate of its slot nor placeable, a turn stamp that disagrees with its destination,
two operations targeting one path, telemetry whose turn boundary cannot be dated or whose samples would
land in a turn no transcript or result evidences, a directory it cannot read. It never attributes
telemetry by guess, and it never creates a `turns/<N>/` that nothing but a resources file vouches for.
The one inference it does make is positional: an **empty** file carries no content to attribute, so it
follows its position to an **evidenced** turn (a root file to its own turn, an archive to the turn its
name states) — never one that nothing else evidences.

---

See also: [boundary.md](./boundary.md) (is the sandbox even enforcing what you think?) and
[fidelity-gaps.md](./fidelity-gaps.md) (the known deltas vs. real Cowork — sometimes the "bug" is a
deliberate gap).
