# Fidelity tiers & answer paths

Self-contained reference. Tracks `cowork-harness 1.1.0` (baseline `desktop-1.20186.1`).

## Fidelity tiers (`fidelity:` in the scenario)

| Tier | What runs | Use it for |
|---|---|---|
| `protocol` | L0 — agent on the host, no sandbox, no egress enforcement | Fastest control-loop / answer-shape checks. **Rejected** if the scenario asserts egress / `expect_denied` (would false-pass). |
| `container` (default) | L1 — agent in a Docker container with a per-run default-deny egress proxy | The everyday tier: real sandbox, real egress allowlist. |
| `microvm` | L2 — agent in an Apple-VZ Lima microVM with a guest firewall | VM-grade escape **isolation** of untrusted code. macOS arm64 only; needs `cowork-harness vm init`. Network transport **equals `container`** (same allowlist proxy) — *not* better network fidelity. |
| `hostloop` | Host-loop split-exec: the agent loop is a **native process on the host** (no container around the file tools — matching production); shell/web routed host-side via the workspace SDK-MCP server (`mcp__workspace__bash`) into a Docker VM sidecar | Reproduce Cowork's **production** split-execution model. |
| `cowork` | Auto-picks `hostloop` vs `container` the way Cowork itself does for the synced release | "Do what real Cowork does for this release." |

- `hostloop` / `cowork` are the production-faithful path; `container` is the practical default.
- Boundary assertions (`egress_*`, `expect_denied`) are enforced at `container`, `microvm`, `hostloop`,
  and `cowork` (`cowork` auto-resolves to a sandboxed tier; `container`'s and `hostloop`'s `bash` share
  the same Docker sandbox + egress proxy — `hostloop`'s native file tools run with no container at all,
  gated instead by a path-containment hook). Only `protocol` is rejected.
- A `hostloop` scenario with a **writable** connected folder (`mode: rw`/`rwd`) needs `allow_host_writes:
  true` — with no container around the native file tools, that combination gives the agent genuine,
  software-checked-only host filesystem access. Read-only folders and folder-less runs need no opt-in.
- **Set the tier in the scenario's `fidelity:` field — not a flag.** `--fidelity` is accepted only by
  `skill` (any tier) and `chat` (`protocol`/`container`/`hostloop`; only `microvm`/`cowork` unsupported); `run` rejects an extra `--fidelity`
  positional ("Fidelity is set by the scenario's `fidelity:` field, not a flag").

### `microvm` prerequisites & lifecycle

Requires macOS on arm64 and Lima (`brew install lima`; binary expected at
`/opt/homebrew/bin/limactl`, override with `COWORK_LIMACTL`).

```bash
cowork-harness vm init     # boot the L2 VM for this config (slow first time)
cowork-harness vm status   # show the instance + state
cowork-harness run my-scenario.yaml   # tier comes from the YAML's fidelity: microvm
cowork-harness vm delete   # stop + remove this config's VM
cowork-harness vm prune    # remove orphaned cowork-vm-* VMs from past configs
```

The instance is `cowork-vm-<config-hash>` — a config or agent-version change yields a new name, so a
stale VM is never silently reused (the old one is orphaned until `vm prune`). Pin a fixed name with
`COWORK_LIMA_INSTANCE`.

## Answer paths (resolving gates: AskUserQuestion + tool-permission)

Both AskUserQuestion and tool-permission requests arrive over the same `can_use_tool` control
channel. You choose how unmatched gates get answered. **The harness never silently fabricates an
answer.**

Default to **deterministic**: scripted `answers:` + `on_unanswered: fail`. Anything that brings a
live model into answering flags the run `nonDeterministic` — keep those out of deterministic
regressions.

| Path | How | Deterministic? |
|---|---|---|
| **Scripted** | `answers:` rules (regex→choice / tool→decision) + `on_unanswered: fail` | ✅ — the CI/agent default |
| **LLM decider** | `on_unanswered: llm` (YAML) **or** `--decider-llm` (CLI) | ❌ flags `nonDeterministic` |
| **Spawned helper** | `--decider-cmd '<helper>'` | depends on the helper |
| **In-band (driving agent)** | `--decider-dir <dir>` (+ a Monitor that writes responses) | depends |

Scripted `answers:` and a terminal (`--decider-llm` / `--decider-cmd` / `--decider-dir` / `on_unanswered`) compose as a normal Chain — scripted rules resolve matched gates, the terminal answers whatever's left. What's mutually exclusive is picking **two terminals** at once (e.g. `--decider-llm` with `--decider-cmd`, or `--decider-llm` with an explicit `--on-unanswered`) — the CLI rejects that combination. The in-band path's Monitor drives two
subcommands: `gates <dir>` (stream the pending questions) and `answer <dir> --gate N …` (reply to one).

**The `--decider-llm` answer protocol.** The answering model is shown the gate's options **numbered** and
replies with the option **number**; the harness maps that to the exact canonical label, so a model that
parrots the rendered `label: description` line can't whiff. Backstops bind a `label:`-prefixed echo and the
`(Recommended)` suffix; a conversational aside or any out-of-set reply **fails loud** (never a guess), and
the unanswered error names the `closest:` label. A multiSelect gate is answered with a comma-list of
numbers (`1, 3`); a mixed digit+label reply fails loud. The answering model defaults to a **Sonnet** id —
a weaker model tends to *prose-decline* a genuinely ambiguous judgment gate (replying in prose instead
of picking an option), which fails loud. Override with **`--decider-model <id>`** (on `skill`, `decide`,
`record`; precedence: flag > env `COWORK_HARNESS_DECIDER_MODEL` > the Sonnet default; requires
`--decider-llm`) — pin a cheaper model for simple gates to cut cost, or a stronger one for hard judgment
gates; it won't make an under-specified gate deterministic.

⚠️ **A decider can false-green a semantic assertion.** The decider sees only a short **transcript tail**,
not the mounted inputs — so its bind can be wrong two ways: a **fabrication** on a gate whose answer
*nobody can derive* (a user preference, an unstated fact), or a **factual miss on a gate whose answer is
in a document the decider was never shown** (and a *stronger* model can miss it just as easily). Either
is fine when your assertions are **structural** (an artifact exists, a section renders, JSON has a key) —
you only need the run to proceed. It is **NOT** fine when a **semantic** assertion sits downstream of
that answer: the green run is then a false pass on a wrong premise. **Rule: script *any* gate whose
answer feeds a semantic assertion (`--answer` / `--answer-policy`); don't `--decider-llm` it.** Reserve
the live decider for **structural-assertion** runs.

To make this auditable, every run reports **gate provenance** — `result.json` carries a `gateProvenance`
block (per gate: `answeredBy` = scripted / decided(llm|external) / first-option / prompt, plus `model`),
the footer prints a counts-only `gates: N · …` line, and `trace --view questions` annotates each gate
with its `by`/`model`. Use it to see exactly which assertions sit downstream of a *decided* (non-reproducible)
gate. It is informational — it never changes the verdict. Absent on the replay lane (deterministic by
construction).

**multiSelect gates** work on every path. Scripted: `choose:` a list. LLM decider (`--decider-llm`): a
comma-list of option numbers (`1, 3`). In-band `--decider-dir`: the
Monitor answers each gate with the `answer` subcommand, repeating its `--choose` flag
(`answer <dir> --gate N --choose Auth --choose Billing`). `--decider-cmd` / hand-written `resp-N.json`: send the
selections as a **JSON array** (`{"answers":{"<q>":["Auth","Billing"]}}`) — a bare comma-joined string
is read as one label and fails; a scalar is one selection; an array on a single-select gate fails loud.
All paths deliver the binary-verified `", "`-joined wire shape.

### The request envelope a `--decider-cmd` / `--decider-dir` helper parses

Both external channels write the **same** self-describing request line per gate, so a helper can read
valid labels off the wire instead of guessing. For a `question` gate it is shaped:

```json
{"type":"decision_request","id":"req_…","kind":"question",
 "questions":[{"question":"Which output format?","header":"Format",
              "options":[{"label":"Markdown"},{"label":"PDF"}],"multiSelect":false}],
 "reply_with":"{\"id\":\"req_…\",\"answers\":{\"Which output format?\":\"<label or 1-based index>\"}}"}
```

So a helper keys its answer on `questions[N].question`, enumerates choices from
`questions[N].options[].label`, and checks `questions[N].multiSelect` to decide scalar-vs-array reply.
The `reply_with` field is a literal fill-in template for the reply shape (array placeholder when
multiSelect). Notes: `options` is *optional* — a free-text / header-only gate arrives with no
`options`; key off `question` (falling back to `header`). This is the shared wire model for both
channels — `docs/decider-dir.md` shows the same shape, and the Python `serve_decider(fn)` adapter
hands `fn` exactly this dict.

### `--on-unanswered` accepted values (precise)

- On `skill`: `fail | prompt | first`.
- On `run`: `fail | first` (`prompt` rejected — it would break determinism).
- **`llm` is NOT an `--on-unanswered` value.** The bare flag `--on-unanswered llm` is rejected; use
  `--decider-llm` (CLI) or `on_unanswered: llm` (YAML).
- `agent` is **retired** — `on_unanswered: agent` is rejected by the schema. The enum is
  `["fail", "prompt", "llm", "first"]`.

### Determinism contract

- `fail` — the default for `run`. On an unscripted gate it hard-errors; the error names the exact
  `--answer`/`choose` to add, and also suggests `on_unanswered: llm` (in the scenario YAML) as a
  secondary escape valve for a gate whose wording drifts run-to-run — a regex chases a moving target,
  at the cost of non-determinism (one model call per gate). Correct, but flaky for skills whose gates
  appear stochastically.
- `first` — picks option 1 and warns loudly. **Flagged `nonDeterministic`** — not a deterministic
  substitute for scripted answers. (For a web_fetch approval gate it abstains → fail-closed.)
- `prompt` — asks at the TTY (`skill` only).
- `llm` — a model answers; flagged `nonDeterministic`.

When a skill's gates are *structurally stable* (the gate reliably appears, only the wording drifts),
scripting is robust — the `when_question` regex absorbs phrasing drift. When a skill decides
run-to-run *whether/which* to ask (structural stochasticity), `fail` will hard-error on a gate it
didn't anticipate; answer live instead (`--decider-llm` or `--decider-dir`), accepting that the run
is then no longer a deterministic regression.

### Dry-run a decider before a full run (`decide`)

`cowork-harness decide` validates a decider against one synthetic question in ~2s, no run — so you
catch a non-matching regex or a wire-protocol bug before twelve minutes of live execution:

```bash
cowork-harness decide \
  --question "Which output format do you want?" \
  --option Markdown --option PDF \
  --answer-policy examples/answer-policies/demo.yaml
# ✓ rule matched: "Which output format do you want?" → "Markdown"
```

It works with `--answer`/`--answer-policy` (reports which rule matched, or exits non-zero if none),
`--decider-cmd` (shows the exact request + answer), or `--decider-llm` (a live model answers).
Caveat: `decide` only builds a **single-select** sample (set choices with `--option`; there is no
multiSelect flag), so its printed request shows `options[].label` but never `multiSelect:true` — to
exercise the array reply path, run a real multiSelect gate or unit-test the helper directly.

LLM-decider free-text goes via `OTHER: <value>` on an **options-bearing** gate; a bare out-of-set
answer (no matching label, no `OTHER:`) fails loud (`UnansweredError` → exit 2) — it never stalls or
guesses an option. Open-ended (no-option) gates need no `OTHER:` prefix: free text is delivered
verbatim. (Scripted scenarios use the separate `answer:` escape hatch.)

A gate that fails loud (`on_unanswered: fail`, the default) still **salvages a PARTIAL run**: the harness
writes a `result.json` (marked `partial: true`) with the artifacts the agent produced before the whiff, so
the work isn't discarded — then exits 2. Inspect it with `cowork-harness inspect <run-dir>`. `verify-run`
and `scaffold` refuse to treat a partial run's half-finished output as a passing result.

## What a green does NOT prove

A passing run is evidence for exactly what it checked, not a blanket certificate. Three gaps come
up often enough to spell out:

- **A green `replay` proves "same as when recorded," not "correct today."** `replay` never touches
  a filesystem or network — it re-evaluates assertions from the frozen cassette. A fixed set of
  keys is live-only and **skipped outright** on replay (absent from `assertions[]`, not vacuously
  passed): `no_delete_in_outputs`, `self_heal_ran`, `transcript_no_host_path`, `egress_denied`,
  `egress_allowed`, `no_mcp_error`, `max_peak_rss_bytes`, `semantic_matches`, `no_lost_write_back`, and `expect_denied`.
  Everything else that *is* evaluated is checked against the **recording**, not fresh behavior — a
  green replay says the skill produced these events when it was recorded, not that it still does
  (`staleness[]` flags skill/baseline drift as a hint; only a live `run` re-confirms current
  behavior). See `docs/cassette.md` § "Still skipped on replay" and `docs/scenario.md` § "Which
  assertions survive replay."
- **Container-only assertions can't verify off the `container` tier.** `no_scratchpad_leak` and
  `present_files_called` check the `present_files` delivery path, which is served **only** on
  `container` — not `hostloop`/`microvm`. Asserting them off-container hard-fails at runtime (a red
  run, not a false green), so you won't be fooled if you write the assertion. The quieter trap is a
  scenario that runs at `hostloop`/`microvm`/`protocol` and simply omits these assertions: a green
  run there proves **nothing** about scratchpad-leak safety or present_files delivery, because that
  tier never exercises the delivery path the assertions would check. Use `fidelity: container` for
  present_files/scratchpad-delivery coverage.
- **The harness doesn't observe rendered-artifact interactions, browser downloads, or human
  clicks.** It runs the agent headless — no webview, no browser, no person clicking "Submit." A
  class of Cowork bug (a client-side write-back to a relative URL that resolves-but-fails against
  Cowork's own origin, or a broken blob-download fallback) is invisible to any live run, however
  faithfully sandboxed, because it only manifests in a rendered DOM a human is driving. See
  `docs/fidelity-gaps.md` § "Browser↔webview↔human-interaction boundary."

## Relevant environment variables

- `COWORK_HARNESS_RUNS_DIR` (or `--run-dir <path>`) — override the default run-output root `~/.cowork-harness/runs` (out of any working tree). flag > env > default.
- `COWORK_HARNESS_DECIDER_CMD_TIMEOUT_MS` / `COWORK_HARNESS_LLM_TIMEOUT_MS` — decider backstops
  (default 600 s; **fail loud** on timeout).
- `COWORK_HARNESS_DECIDER_DIR_POLL_MS` / `_TIMEOUT_MS` — the `--decider-dir` rendezvous (poll defaults: 300 ms for the run-side rendezvous, 500 ms for `gates --follow`).
- `COWORK_HARNESS_DIALOG_TIMEOUT_MS` — dialog auto-cancel (default 6 s).
- `COWORK_HARNESS_LLM_MAX_BYTES` — stdout bound on `--decider-llm` (default 8 MiB).
- `COWORK_HARNESS_LLM_RETRIES` — bounded retries for a transient non-zero `claude -p` exit on the
  `--decider-llm` transport (default 2, clamped 0–10; `0` disables for deterministic CI). Only a non-zero
  exit retries; a timeout / byte-overflow / spawn failure fails loud on the first attempt. The exit error
  carries the child's captured stdout/stderr so `exited 1` is diagnosable.
- `COWORK_HARNESS_SCRUB_KEYS` / `COWORK_HARNESS_SCRUB_VALUES` — extra env names / literal values to
  redact from logs (beyond the auth tokens + `ANTHROPIC_CUSTOM_HEADERS`).
- `COWORK_HARNESS_SOFT_MISSING` — downgrade a missing mount source from hard-error to warn-and-skip.
- `COWORK_VM_GATEWAY` / `COWORK_VM_PROXY_PORT` / `COWORK_LIMA_INSTANCE` — L2 (microVM) knobs.
- `COWORK_LOCKDOWN` — default `on`: gates sandbox hardening on every isolated tier — **aborts loudly**
  if the L2 guest firewall fails to apply (no silent unprotected run), and also gates the
  `container`/`hostloop` Docker hardening. Set `=off` to opt out and run without isolation deliberately.
