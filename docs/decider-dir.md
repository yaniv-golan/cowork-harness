# Answering live gates in-band: the `--decider-dir` recipe

`--decider-dir` lets a **driving agent** (another Claude instance, or you at a second terminal) answer
the session-under-test's live `AskUserQuestion` gates **in-band**, with full context, while the run
stays live. There is no resume, no re-worded question: the harness blocks on each gate, the driver
reads it, writes an answer, and the run continues from exactly where it paused.

This is the fourth answer channel, alongside scripted `--answer`/`--answer-policy` (deterministic),
`--decider-llm` (a small model picks), and `--decider-cmd '<helper>'` (a spawned helper). Unlike the
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
   emit a terminal `{"done":true}` and exit.

You **do not** hand-write those files. Two CLI subcommands wrap the protocol:

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
  repeated `--choose` on a *single-select* gate is rejected. (`--choose` answers the first
  sub-question; a multi-*question* multiSelect gate needs `--answer "<q>=<label>"` per sub-question.)

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

(`skill` and `run` both accept `--decider-dir`. On `run`, scenarios normally pin answers for
reproducibility; `--decider-dir` is for the driving-agent workflow and flags the run non-deterministic.)

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
  `UnansweredError` rather than hanging forever.
- **Env knobs:**
  - `COWORK_HARNESS_DECIDER_DIR_POLL_MS` — how often the harness polls for the answer file and how often
    `gates --follow` polls for new gates (defaults: 300 ms for the harness rendezvous, 500 ms for the
    watcher).
  - `COWORK_HARNESS_DECIDER_DIR_TIMEOUT_MS` — the per-gate backstop before a loud `UnansweredError`
    (default 600000, i.e. 10 minutes).

## See also

- `README.md` — the answer-channels overview (`--decider-llm` / `--answer-policy` / `--decider-cmd` /
  `--decider-dir`).
- `docs/scenario.md` — scenario answer rules and `on_unanswered` policies.
- `src/decide/external-channel.ts` — the file-rendezvous implementation (`fileChannel`, `streamGates`,
  `answerGate`).
