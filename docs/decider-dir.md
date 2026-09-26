# Answering live gates in-band: the `--decider-dir` recipe

`--decider-dir` lets a **driving agent** (another Claude instance, or you at a second terminal) answer
the session-under-test's live `AskUserQuestion` gates **in-band**, with full context, while the run
stays live. There is no resume, no re-worded question: the harness blocks on each gate, the driver
reads it, writes an answer, and the run continues from exactly where it paused.

This is the fourth answer channel, alongside scripted `--answer`/`--answer-policy` (deterministic),
`--decider-llm` (a model picks — defaults to Sonnet), and `--decider-cmd '<helper>'` (a spawned helper). Unlike the
scripted channels, `--decider-dir` answers questions you don't know in advance — so the harness
**flags the run non-deterministic** (the footer says so), and a fresh, empty directory is **required**
per run. Like every channel, it keeps the CLI's stdout free, so it composes with `--output-format json`.

## How it works

The harness and the driver rendezvous through files in `<dir>`:

1. When the session asks a question, the harness writes the decision request atomically to
   `<dir>/req-N.json` (one single-line JSON object per gate, sequence `N` starting at 1) and **blocks**,
   polling for `<dir>/resp-N.json`.
2. The driver answers by writing `<dir>/resp-N.json` (atomically, temp+rename). The harness reads it,
   renames `req-N.json` → `req-N.json.done` (so it can't be re-emitted), and the run resumes.
3. Gates are strictly serial — one outstanding gate at a time: `req-1` → `resp-1` → `req-2` → … .
4. On run completion the harness writes `<dir>/done.json`, which tells a `gates --follow` watcher to
   emit a terminal `{"done":true}` and exit. "Completion" includes **not starting**: if the scenario
   cannot be loaded at all, the marker is still written, so a watcher already following the dir
   terminates instead of hanging on a run that will never produce a gate.

For a **question** gate you do not hand-write those files — two CLI subcommands wrap the protocol:

> **See it work first, for free.** `cowork-harness decide --decider-dir "$(mktemp -d)"` fires ONE sample
> gate through this exact channel — the same `fileChannel` a real run uses, so the fresh-dir refusal and
> the wire shape are the production ones — then blocks until you answer it with the two subcommands below.
> No agent, no tokens, ~2s of setup. This is the cheapest way to learn the loop before wiring it into a
> paid run, and it exists because hand-rolling a Monitor over the raw files is the most common mistake here.

- **`cowork-harness gates <dir> [--follow]`** — stream pending gates. Emits one clean single-line JSON
  per new gate (`{seq, ...decision_request}`) and a terminal `{"done":true}` when the run finishes.
  With `--follow` it watches until done; without it, one pass and exit. The harness owns the watcher,
  so the driving agent points **one** Monitor at this instead of hand-rolling a `find`/seen-set/poll loop.
  Note: `gates` streams these **raw protocol lines** — it does *not* wrap them in the standard
  `{tool, version, command, ok}` result envelope (that's the in-band contract a Monitor consumes line by
  line); `--output-format json` is accepted but does not change the shape.
- **`cowork-harness answer <dir> --gate <N> (--choose <label> | --answer "<q>=<label>")`** — write the
  answer for gate `N` with the correct wire shape (the atomic temp+rename and the `{id, answers}`
  envelope are handled for you). `--choose <label>` answers the gate's first question by option label;
  `--answer "<q>=<label>"` is repeatable for multi-question gates and matches by question text.
  **multiSelect gate:** repeat `--choose` once per selection (`--choose Auth --choose Billing`) — the
  members are written as a JSON array and delivered as the binary-verified `", "`-joined wire shape. A
  repeated `--choose` on a *single-select* gate is rejected. (`--choose` only selects within the **first**
  sub-question; for a later sub-question, `--answer "<q>=<label>"` delivers exactly **one** selection per
  question — selecting *multiple* members of a non-first multiSelect needs a hand-written `resp-N.json`
  with a JSON array of labels.)

> **`answer` covers QUESTION gates only.** It writes `{id, answers}` and nothing else. The same channel
> also carries **permission**, **dialog** and **elicit** gates, whose replies take `{behavior}` /
> `{action}` — there is no subcommand for those, so write `resp-N.json` yourself. You do not have to guess
> the shape: every request advertises it. `req-N.json` carries a `reply_with` field holding the literal
> template for its own kind, e.g.
>
> ```json
> {"id":"…","behavior":"allow|deny"}                      // permission
> {"id":"…","behavior":"allow|deny","grant":"once|domain"} // permission, web_fetch approval
> ```
>
> Write it the way the harness does — to a temp file, then `rename` into place — so the poller never
> reads a partial file, and echo the request's `id`: a reply without it is rejected.

## Recipe

### (a) Start the run with a fresh, empty `--decider-dir`

Use a directory that does **not** already contain gate files — the harness refuses a dirty dir (it
throws `--decider-dir <dir> already has gate files … — use a fresh, empty directory per run`) so a
prior run's answers can never leak into this one. Run the harness in the background so the driver can
work the gate stream while it's live:

```bash
GATES=$(mktemp -d)
cowork-harness skill ~/my-plugin "Render the report" \
  --decider-dir "$GATES" \
  --output-format json &        # run in the background; stdout stays clean JSON
```

(`skill`, `run`, and `record` all accept `--decider-dir`. On `run`, scenarios normally pin answers for
reproducibility; `--decider-dir` is for the driving-agent workflow and flags the run non-deterministic.
On `record` it answers gates live during authoring instead of scripting `answers:` up front — single
scenario only, not a `dir/` batch — see [cassette.md](./cassette.md#answering-gates-during-recording).)

Pin the run's output location up front with the **global** `--run-dir <path>` flag (it must precede the
subcommand) if the driver will also need to find the run dir once the process is backgrounded — e.g. to
watch overall progress with `status --follow` alongside the gate stream (see step (b)).

### (b) Arm one Monitor on the gate stream

The driving agent watches the gate stream with a single follow command:

```bash
cowork-harness gates "$GATES" --follow
```

Each new pending gate arrives as one JSON line, e.g.:

```json
{"seq":1,"id":"req_abc","questions":[{"question":"Which format?","header":"Format","options":[{"label":"Markdown"},{"label":"HTML"}]}]}
```

A `{"done":true}` line means the run finished — stop watching.

A driver that also wants overall run progress (not just pending gates) can watch
`cowork-harness status <run-dir> --follow` in parallel — see [run-status.md](./run-status.md):
`gates --follow` surfaces question content, `status --follow` surfaces run/session lifecycle.

### (c) Reply to each gate

With full context, the driver picks an answer and writes it:

```bash
cowork-harness answer "$GATES" --gate 1 --choose "Markdown"
# → ✓ answered gate 1: {"Which format?":"Markdown"}
```

The blocked harness picks up `resp-1.json`, delivers the answer to the model, and continues. Repeat
for each gate the Monitor surfaces until `{"done":true}`.

### (d) The session-under-test stays live

There is no resume or re-asking: the same `AskUserQuestion` the model raised is answered in place and
the turn continues. When the run ends, its footer (or the JSON envelope) reports the result, **flagged
non-deterministic** because a live driver — not a scripted rule — chose the answers. For a reproducible
CI gate, capture the chosen labels and pin them as `--answer "<q>=<choice>"` lines instead.

## Worked example

Two terminals (or a driving agent issuing the same commands):

```bash
# Terminal 1 — the session under test
GATES=$(mktemp -d)
cowork-harness skill ~/my-plugin "Export the deck" --decider-dir "$GATES"

# Terminal 2 — the driver
cowork-harness gates "$GATES" --follow
# {"seq":1,"id":"req_1","questions":[{"question":"Output format?","options":[{"label":"PDF"},{"label":"PPTX"}]}]}

cowork-harness answer "$GATES" --gate 1 --choose "PDF"
# ✓ answered gate 1: {"Output format?":"PDF"}

# … the stream emits more gates as the run asks them …
# {"done":true}   ← run finished; the driver stops watching
```

## Notes and tuning

- **Fresh empty dir per run is mandatory.** A dirty dir is rejected loudly; use a new `mktemp -d` each run.
- **The run is non-deterministic.** The footer flags it so a green isn't mistaken for a scripted pass.
- **stdout stays free.** The protocol lives on disk and on stderr lifecycle lines, so `--output-format
  json` composes cleanly.
- **One gate at a time.** Answer in sequence; the harness will not emit `req-(N+1)` until `resp-N` lands.
- **multiSelect gates.** The emitted `req-N.json` advertises an array `reply_with` for a multiSelect
  question. If you answer by hand-writing `resp-N.json` (or via a `--decider-cmd` helper), send the
  selections as a **JSON array** — `{"answers":{"Which to enable?":["Auth","Billing"]}}` (labels or
  1-based indices). The harness validates each member and delivers the `", "`-joined wire shape. A
  bare scalar is accepted as a single selection; an array on a single-select gate fails loud. (The
  `answer` subcommand does this for you — just repeat `--choose`.)
- **Backstop timeout.** If no answer arrives within the deadline, the harness raises a loud
  `UnansweredError` rather than hanging forever: the run ends as an unanswered-gate partial (`result.json`
  with `partial: true` and a failing verdict, exit 2) and records `errorSource: "decider_timeout"` in
  `result.json` and `status.json`.
- **Env knobs:**
  - `COWORK_HARNESS_DECIDER_DIR_POLL_MS` — how often the harness polls for the answer file and how often
    `gates --follow` polls for new gates (defaults: 300 ms for the harness rendezvous, 500 ms for the
    watcher).
  - `COWORK_HARNESS_DECIDER_DIR_TIMEOUT_MS` — the per-gate backstop before a loud `UnansweredError`
    (default 600000, i.e. 10 minutes).

## Decider flags by command: `run` vs `record` vs `skill`

`run`, `record`, and `skill` each accept a different subset of the decider flags, and no single
`--help` shows all three side by side. This is the full cross-reference, verified against
`cowork-harness 1.17.0`'s own `--help` output for each command:

| Command | `--decider-dir` | `--decider-cmd` | `--decider-llm` | `--on-unanswered` accepts |
|---|---|---|---|---|
| `run` | yes | yes | no | `fail`\|`first` |
| `record` | yes | no | yes | `fail`\|`first` |
| `skill` | yes | yes | yes | `fail`\|`prompt`\|`first` |

- **`run` has no `--decider-llm`, by design** — a scenario run pins its answers for
  reproducibility, so `run --help` states it directly: "`run` omits `--decider-llm` by design —
  scenarios pin answers for reproducibility". The only route to a model decider on `run` is the
  scenario-YAML field `on_unanswered: llm` (see [scenario.md](./scenario.md)), which flags that run
  non-deterministic exactly as `--decider-llm` does on `skill`/`record`.
- **`record` has no `--decider-cmd`** — its `--help` lists only `--decider-dir` (single scenario
  only) and `--decider-llm` under "answer gates LIVE"; a spawned-helper decider is a `skill`/`run`-only
  path.
- **`--on-unanswered llm` is rejected as a flag value on every command** — `llm` is a
  scenario-YAML-only value (`on_unanswered: llm`); the CLI equivalent is the separate `--decider-llm`
  flag. Since `run` has no `--decider-llm` at all, the scenario YAML is the *only* route to a model
  decider there.
- **`run` additionally rejects `--on-unanswered prompt`** (it would break determinism), narrowing its
  accepted set to `fail`/`first` even though the flag's shape looks identical across commands.
- **A channel and a policy are mutually exclusive.** `--on-unanswered` alongside
  `--decider-dir`/`--decider-cmd` is a usage error on `run`, `record`, `skill` and `probe-dispatch`.
  The channel *is* the terminal — the decider chain ends at it, so the policy terminal is never built
  and the flag could only ever be inert. `--decider-llm` rejects the same pairing for the same reason.
  Pick the channel or the policy, not both.
- **`record` also rejects a scenario whose YAML sets `on_unanswered: prompt`.** The scenario field
  outranks the flag, so validating only the flag left a TTY wait reachable on the command that writes a
  committed fixture. `run` has always rejected it; `record` now matches.

Verification commands (all fail at argument parsing, before any scenario runs or spends anything):

```bash
node dist/cli.js run examples/scenarios/example-pdf-skill.yaml --decider-llm
#   unexpected argument(s): --decider-llm — `run` takes one <scenario.yaml | dir/> plus common flags…

node dist/cli.js record examples/scenarios/example-pdf-skill.yaml --decider-cmd foo
#   unknown flag: --decider-cmd

node dist/cli.js record examples/scenarios/example-pdf-skill.yaml --on-unanswered llm
#   --on-unanswered: expected one of fail|first, got llm
```

**Caution when probing this matrix yourself:** unlike the three commands above, flags that a
command *does* accept — e.g. `run --decider-dir <dir>` or `run --decider-cmd '<helper>'` — parse
successfully and go on to execute the scenario for real (real tokens, a real sandboxed agent). Only
the invalid combinations shown above are guaranteed to fail before any spend; don't assume every
decider-flag probe is free.

## See also

- [`../README.md`](../README.md) — the answer-channels overview (`--decider-llm` / `--answer-policy` / `--decider-cmd` /
  `--decider-dir`).
- [`scenario.md`](./scenario.md) — scenario answer rules and `on_unanswered` policies.
- [`cassette.md`](./cassette.md#answering-gates-during-recording) — `record --decider-dir`, the
  single-scenario recording variant of this recipe.
- [`run-status.md`](./run-status.md) — the `status --follow` companion for overall run progress.
- [`src/decide/external-channel.ts`](https://github.com/yaniv-golan/cowork-harness/blob/main/src/decide/external-channel.ts) — the file-rendezvous
  implementation (`fileChannel`, `streamGates`, `answerGate`).
