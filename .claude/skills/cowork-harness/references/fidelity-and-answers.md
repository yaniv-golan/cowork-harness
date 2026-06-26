# Fidelity tiers & answer paths

Self-contained reference. Tracks `cowork-harness 0.15.0` (baseline `desktop-1.15200.0`).

## Fidelity tiers (`fidelity:` in the scenario)

| Tier | What runs | Use it for |
|---|---|---|
| `protocol` | L0 — agent on the host, no sandbox, no egress enforcement | Fastest control-loop / answer-shape checks. **Rejected** if the scenario asserts egress / `expect_denied` (would false-pass). |
| `container` (default) | L1 — agent in a Docker container with a per-run default-deny egress proxy | The everyday tier: real sandbox, real egress allowlist. |
| `microvm` | L2 — agent in an Apple-VZ Lima microVM with a guest firewall | VM-grade escape **isolation** of untrusted code. macOS arm64 only; needs `cowork-harness vm init`. Network transport **equals `container`** (same allowlist proxy) — *not* better network fidelity. |
| `hostloop` | Host-loop split-exec: agent loop on the host, shell/web routed into the container via the workspace SDK-MCP server (`mcp__workspace__bash`) | Reproduce Cowork's **production** split-execution model. |
| `cowork` | Auto-picks `hostloop` vs `container` the way Cowork itself does for the synced release | "Do what real Cowork does for this release." |

- `hostloop` / `cowork` are the production-faithful path; `container` is the practical default.
- Boundary assertions (`egress_*`, `expect_denied`) are enforced at `container`, `microvm`, and
  `hostloop` (all share the container sandbox + egress proxy). Only `protocol` is rejected.
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

The answer paths are orthogonal — don't mix them on one run. The in-band path's Monitor drives two
subcommands: `gates <dir>` (stream the pending questions) and `answer <dir> --gate N …` (reply to one).

**The `--decider-llm` answer protocol.** The answering model is shown the gate's options **numbered** and
replies with the option **number**; the harness maps that to the exact canonical label, so a model that
parrots the rendered `label: description` line can't whiff. Backstops bind a `label:`-prefixed echo and the
`(Recommended)` suffix; a conversational aside or any out-of-set reply **fails loud** (never a guess), and
the unanswered error names the `closest:` label. A multiSelect gate is answered with a comma-list of
numbers (`1, 3`); a mixed digit+label reply fails loud. Raise the answering model for genuinely ambiguous
*judgment* gates with **`--decider-model <id>`** (on `skill`, `decide`, `record`; precedence: flag > env
`COWORK_HARNESS_DECIDER_MODEL` > the Haiku default; requires `--decider-llm`) — it sharpens judgment but
won't make an under-specified gate deterministic.

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
  `--answer`/`choose` to add. Correct, but flaky for skills whose gates appear stochastically.
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

## Relevant environment variables

- `COWORK_HARNESS_RUNS_DIR` (or `--run-dir <path>`) — override the default run-output root `~/.cowork-harness/runs` (out of any working tree). flag > env > default.
- `COWORK_HARNESS_DECIDER_CMD_TIMEOUT_MS` / `COWORK_HARNESS_LLM_TIMEOUT_MS` — decider backstops
  (default 600 s; **fail loud** on timeout).
- `COWORK_HARNESS_DECIDER_DIR_POLL_MS` / `_TIMEOUT_MS` — the `--decider-dir` rendezvous.
- `COWORK_HARNESS_DIALOG_TIMEOUT_MS` — dialog auto-cancel (default 6 s).
- `COWORK_HARNESS_LLM_MAX_BYTES` — stdout bound on `--decider-llm` (default 8 MiB).
- `COWORK_HARNESS_SCRUB_KEYS` / `COWORK_HARNESS_SCRUB_VALUES` — extra env names / literal values to
  redact from logs (beyond the auth tokens + `ANTHROPIC_CUSTOM_HEADERS`).
- `COWORK_HARNESS_SOFT_MISSING` — downgrade a missing mount source from hard-error to warn-and-skip.
- `COWORK_VM_GATEWAY` / `COWORK_VM_PROXY_PORT` / `COWORK_LIMA_INSTANCE` — L2 (microVM) knobs.
- `COWORK_LOCKDOWN` — default `on`: **aborts loudly** if the L2 guest firewall fails to apply (no
  silent unprotected run). Set `=off` to opt out and run without isolation deliberately.
