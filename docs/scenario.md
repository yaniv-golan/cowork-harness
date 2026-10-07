# Scenario reference

A **scenario** (`scenarios/*.yaml`) is one test: a prompt, scripted answers to the agent's questions/permission requests, and assertions. It references a [session setup](./session.md) for the setup.

**Minimal scenario** — `prompt` and `fidelity` are required; everything else has defaults:

```yaml
prompt: "Use the my-skill skill to do X."
fidelity: container          # required — protocol | container | microvm | hostloop | cowork
assert:
  - result: success
```

The full schema below documents every optional field.

## On this page

- [Full schema](#full-schema)
- [Lanes (`lane:`)](#lanes-lane--which-delivery-contract-the-run-is-held-to)
- [Fidelity tiers (`fidelity:`)](#fidelity-tiers-fidelity)
- [Scripted answers](#scripted-answers)
- [Assertions](#assertions)
- [Starting from a saved workspace (`workspace_fixture:`)](#starting-from-a-saved-workspace-workspace_fixture)
- [Numeric metrics (`metrics:`)](#numeric-metrics-metrics)
- [Output](#output)
- [Running](#running)
- [The `microvm` tier](#the-microvm-tier--vm-init-prerequisites--troubleshooting)

## Full schema

> **Machine-readable:** [`schema/scenario.schema.json`](../schema/scenario.schema.json) is generated from the zod source of truth (`npm run schema`) and pinned by a drift-guard test. Editors with a YAML language server validate scenarios against it automatically — the bundled examples carry a `# yaml-language-server: $schema=../../schema/scenario.schema.json` hint.

```yaml
name: my-test                             # OPTIONAL — defaults to the filename (sans ext); keys runs/<name>/
baseline: latest                          # platform baseline: "latest" or "desktop-<ver>"
session: ../sessions/my-session.yaml     # the pre-prompt setup (resolved relative to THIS file)
fidelity: container                      # REQUIRED (4.0.0+) — protocol | container | microvm | hostloop | cowork (see below)
execution: local                         # OPTIONAL — orthogonal to fidelity (a privilege/sandbox tier, all
                                         # local today): local (default) | cloud-describe (RESERVED — no
                                         # runner exists yet; authoring it is a load-time error, not a
                                         # silent no-op)
lane: local                              # OPTIONAL — which Cowork lane's DELIVERY CONTRACT to hold the run
                                         # to: local (default) | remote (location delivers nothing;
                                         # present_files not served). Orthogonal to fidelity and execution
                                         # (see Lanes below)
on_unanswered: fail                      # optional: policy for unscripted questions (fail | prompt | first | llm — run rejects prompt; see Scripted answers below)
                                         # ("agent" is retired — no longer a valid value)

prompt: |                                # the user turn
  Summarize report.pdf and write action items to actions.md in my outputs folder   # describe the outcome, not a path: the right path differs by lane and Desktop — see the lane table below.

timeout_ms: 600000                       # OPTIONAL wall-clock budget; on expiry the harness kills the agent
                                         # and the run ends result:error / errorSource:timeout. Omit = no timeout.

answers:                                 # scripted answers (see below)
  - when_question: "Which output format"
    choose: "Markdown"
  - when_tool: Bash
    allow_if: '!/\brm\b/.test(command)' # a word match; `includes('rm')` also denies "normalize"
    else: deny
  - when_tool: Write
    decide: allow
  - when_tool: "webfetch:example.com"     # a web_fetch approval (provenance-miss gate)
    decide: allow
    grant: domain                         # "Allow all for website" → approve example.com for the run
                                          # (omit or `grant: once` for a single-fetch allow)

expect_denied: ["evil.example.com"]     # egress hosts asserted to be DENIED

skills: [report-gen]                     # OPTIONAL — scope cassette-staleness hash to these skills only
                                         # (each is a `skills/<name>` dir under a mounted plugin-root);
                                         # fail-closed to whole-tree on an unknown name. Omit = whole tree.

requires_capabilities: [pdf_tables]       # OPTIONAL — capability families the skill needs (a scenario FIELD,
                                         # not an assert key); a tier missing one fails unless allow_missing_capability

allow_host_writes: true                  # OPTIONAL — required consent to run `hostloop` with a WRITABLE
                                         # connected folder (session `folders:` mode rw/rwd) — and so ALSO
allow_host_hooks: true                   # OPTIONAL — required consent to run `protocol` when a staged plugin
                                         # declares runnable hooks (`<plugin>/hooks/hooks.json`); the CLI runs
                                         # them as NATIVE HOST processes, no container sandbox
                                         # for `fidelity: cowork` whenever the baseline's gate resolves it
                                         # to hostloop, which is what the shipped baselines do: the native
                                         # agent process gets genuine host filesystem access there, gated
                                         # only by a software check, not a container/VM wall. See below.

workspace_fixture: fixtures/after-step-1 # OPTIONAL — a directory (relative to THIS file) copied into the
                                         # session's outputs/ before turn 1, to test one late step of a
                                         # pipeline (see "Starting from a saved workspace" below)

metrics:                                 # OPTIONAL — numbers to measure, reported in RunResult.metrics
  - { id: words, artifact: outputs/stats.json, path: totals.words, better: higher, unbounded: true }
                                         # never part of the verdict (see "Numeric metrics" below)

assert:                                  # pass/fail checks (see below)
  - result: success
  - file_exists: outputs/actions.md
  - transcript_contains: "action items"
  - tool_called: Write
  - egress_denied: evil.example.com
```

> **Use `baseline:`, not `profile:`.** `profile:` was an earlier name for this key; it is retired —
> a scenario carrying `profile:` now errors as an unknown key, so write `baseline:`.

<a id="unknown-keys-the-loader-is-strict-lint-is-lenient"></a>

### Unknown keys: the loader is strict, and `cowork-harness lint` runs it

The scenario schema rejects **every** key it does not know — there is no `profile:` special case, and no
tolerance for a typo or a key borrowed from a newer release. The surfaces that see your file differ in how
they report it, and the difference matters:

| surface | on an unknown top-level key | exit |
|---|---|---|
| the **loader** — `run`, `skill`, `record` | **hard error**: `Unrecognized key: "<k>"`; the scenario does not run at all | `2` (a directory target reports each `✗ broken:` file and exits `1`) |
| **`cowork-harness lint`** | ✗ `ERROR [scenario-invalid]` (the loader's own error) plus ⚠ `WARN [unknown-top-key]` with the list of valid keys | `1` |
| `python3 scenario.py lint` (run directly) | ⚠ `WARN [unknown-top-key]` only — the script is offline and does not run the loader | `0` |
| **`replay`** / **`verify-cassettes`** (frozen scenario, older CLI) | decided by the cassette's version stamp: a key that changes what a verdict means raised it, so the older CLI **refuses the cassette as too new**; a meaning-neutral key is **ignored by design** — see below (for `lane: remote`, only a cassette recorded on ≥ 1.16.0 carries the raised stamp) | refused: `replay` exits `1`, `verify-cassettes` exits `3` (could not verify) · ignored: `0` |

Two consequences worth internalising:

- **`cowork-harness lint` reports everything the loader rejects**, as ERROR `scenario-invalid`: unknown
  keys, wrong value types (a scalar where a list belongs, such as `semantic_matches.rubric`), invalid enum
  values, a bad regex, a reserved value. It also reports a `baseline:` that names no baseline this installed
  CLI ships (ERROR `baseline-unknown`; `latest` always resolves). So a scenario `cowork-harness lint` calls
  clean is one `run`/`record` will load. It does **not** check what depends on the machine the run happens
  on — the session file and the paths it mounts (one best-effort exception:
  `slash-skill-name-differs-from-plugin` reads the session's plugin directories when they exist here, and
  stays silent when they do not), an absolute `baseline:` path that does not exist here (one that exists
  is checked, 4.1.1 and later), environment variables — nor
  the pre-spend refusals that `record --dry-run` adds (below). Any other YAML in a linted directory, such as
  a session or matrix file, is not a scenario and is reported too: keep those out of the linted set. The
  bundled script run directly (`python3 scenario.py lint`) stays the lenient, offline check. When both
  report on one file — `scenario-invalid` beside `unknown-top-key` or `enum-value-invalid` — the
  `scenario-invalid` ERROR is the authoritative answer to "does it load"; the linter's own finding next to
  it is the hint for fixing it (the valid keys, a rename).
- **Unknown *top-level* scenario keys are handled differently by the two paths.** The **loader**
  (`run`/`skill`/`record`, reading scenario YAML) rejects one outright: exit 2 for a single file, or exit 1
  for a directory, which reports each `✗ broken:` file. **`replay` does not reject the key itself — the
  cassette's version stamp decides.** A cassette's frozen scenario is read as a passthrough object, so a
  top-level key the running CLI does not know is carried in the file but never consulted. That is only
  safe when the key does not change what a verdict means, and the recorder is what guarantees it: a key
  that does (`lane: remote`, for one, when recorded on ≥ 1.16.0 — see below for the 1.14.0/1.15.0 window)
  raises the cassette's `cassetteVersion` stamp, so an older `replay` (exit `1`) or `verify-cassettes`
  (exit `3`) **refuses the cassette as too new** instead of evaluating it without the key. A
  meaning-neutral key leaves the stamp alone and is **ignored by design** — that forward tolerance is what
  lets an older CLI keep replaying a newer cassette that only added bookkeeping. The residual is a
  recorder that classifies a meaning-changing key as neutral; that is checked when the key is added, not
  at replay.

  *Frozen **assertions** are not loose:* an assertion key this CLI does not recognise, in a cassette
  recorded at this version or older, is a hard reject (exit 2) rather than a silent drop.

  A cassette recorded by **≥ 1.16.0** whose scenario carries `lane: remote` is stamped v11, which `replay`
  and `verify-cassettes` on an older CLI **refuse** — loudly. A cassette recorded by **1.14.0 or 1.15.0**
  carrying `lane: remote` is stamped v10 and is still silently misread by a pre-`lane` CLI; run `rehash` to
  re-stamp it. **And `replay --best-effort-future-cassette` overrides the refusal** — on that path an older
  CLI replays the v11 cassette and the silent misread returns, so do not reach for that flag to work around
  a version refusal on a cassette you did not record. See [docs/cassette.md → Cassette
  versioning](./cassette.md#cassette-versioning).

**To check whether a scenario loads, without spending anything:**

```bash
cowork-harness lint path/to/scenario.yaml               # runs the real loader + the authoring checks;
                                                         # add --cassette-dir <dir> to use exact scenarioSource evidence
                                                        # exit 1 on any ERROR, including "does not load"
cowork-harness record path/to/scenario.yaml --dry-run   # also the real loader; exit 2 if it does NOT load,
                                                        # and exit 1 if it loads but the real record would
                                                        # refuse it (unsatisfiable assert pairing,
                                                        # on_unanswered: prompt, host-inventory destination)
```

Both write nothing and need no token or staged agent. `lint` is the one to gate CI on; `record --dry-run`
adds the pre-spend policy refusals `lint` does not model (and, unlike `lint`, it does not look up a named
`baseline:`). Note that a plain `replay` cannot answer it at all — it evaluates the scenario frozen in the
cassette (see [What `replay` evaluates](#what-replay-evaluates--the-whole-scenario-frozen)); it does print
a `::notice::` when the sibling YAML fails to load, but the verdict is unaffected.

### Slash commands in `prompt:` — position matters

Reaching for `/<skill-name>` is what an author does when a skill will not trigger on its own, and it does
work here: the harness sends `prompt:` verbatim as the user turn, and the agent resolves a slash command
on that input exactly as it does in the terminal. The skill's `SKILL.md` body is spliced into the
conversation **before the model is called**, which is what makes the invocation deterministic rather than
a matter of the model choosing to reach for the `Skill` tool.

Three things decide whether it works:

- **The slash must start the prompt.** The parser trims leading whitespace, then requires the text to begin
  with `/`. A command named mid-sentence — `Review the deck with /deck-review` — is *not* expanded; it
  reaches the model as ordinary prose, which may then pick the `Skill` tool on its own. That is the
  auto-trigger path, so the scenario quietly stops testing what it looks like it tests. `lint` reports this
  as ⚠ `WARN [prompt-slash-not-leading]`.
- **The name must be registered.** In the agent, a skill resolves by its bare skill-directory name (not
  plugin-qualified, and not its frontmatter `name:`), from either staging route — `skills.local` in the
  session, or a plugin source mounted as `--plugin-dir`. A plugin skill's name has every character outside
  `[a-zA-Z0-9_-]` replaced by `-`, so `skills/my.skill/` answers to `/my-skill` (the one exception: a
  `SKILL.md` placed directly in a plugin's skills path is named by its frontmatter `name`).
  A name that is not registered is answered *by the agent, not the model*: the run ends with result text
  `Unknown command: /<name>`, `num_turns: 0`, and no tokens spent. If a slash run looks like it did
  nothing at all, check the result text first — that is this case, not a model that ignored you.
- **Expansion is not enforcement.** The body lands in context; the model still decides how to follow it.
  A skill whose `SKILL.md` is a router into `references/` can be expanded and still only partly obeyed.
- **Passing here does not mean the same typed prompt runs in Cowork.** The harness hands `prompt:` to the
  agent, and the agent resolves slash names permissively: a bare plugin-skill name expands to its
  `plugin:skill` id. Real Cowork resolves a *typed* slash command in the Desktop app, before any agent
  runs, and that resolver is stricter. Observed on Desktop 2.19675.0, 2026-10-03, 4 runs: a bare
  `/<skill>` whose name differs from its plugin's name was refused; a bare `/<skill>` whose plugin has the
  same name worked with one copy of the plugin installed and was refused with two; the qualified
  `/<plugin>:<skill>` was also refused with two copies installed; picking the skill from the slash menu
  worked every time. A refusal shows "Unknown skill", creates no task, and never reaches the agent, so the
  harness cannot see it and no assertion can catch it. To keep a slash scenario portable: expect a user to
  pick the skill from the menu, or name the skill like its plugin; do not install two copies of one
  plugin. The qualified `/<plugin>:<skill>` form is not a proven fix — it was not measured with a single
  copy installed, only seen refused with two. `lint`
  reports a bare name that differs from its staged plugin's name as ⚠
  `WARN [slash-skill-name-differs-from-plugin]`.

A skill declaring `user-invocable: false` in its frontmatter refuses the slash path by design and can only
be reached by the model.

## Lanes (`lane:`) — which delivery contract the run is held to

Cowork runs a session in one of two lanes: **local** (the agent on the user's machine) or **remote** (an
Anthropic-hosted cloud container).
[From 2026-10-06 new Pro and Max tasks run in the cloud](https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile);
before then no setting reliably decided the lane (see
[fidelity-gaps.md → Which lane a session actually ran on](./fidelity-gaps.md#which-lane-a-session-actually-ran-on)).
The lanes disagree about what *delivered* means, so a scenario declares which contract it is testing
against. `local` is this harness's default because `local` is the lane every tier models; Cowork's
[documented default](https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview) is the cloud.

| | `lane: local` (default) | `lane: remote` |
|---|---|---|
| A file under a user-visible root | **is delivered** — `outputs/` is durable, and Cowork's own prompt tells the agent to save deliverables there | **is not delivered** — a remote container has no auto-delivering outputs directory, and it is reclaimed at session end |
| `present_files` | served | **not served** — a local MCP server cannot reach a remote session |
| `user_visible_artifact` | asserts location, as always | rejected at scenario-LOAD time — location proves nothing there. **Tool-level delivery is not assertable on this lane** (the harness models no remote delivery tool): assert the written path plus the agent's own statement of it (`file_exists` + `transcript_matches`), or set `lane: local`. |
| `present_files_called` / `no_scratchpad_leak` | as documented per tier | rejected at scenario-LOAD time — the tool does not exist on that lane, so the scenario never runs |

> **`lane:` needs cowork-harness ≥ 1.14.0.** On an older CLI a scenario carrying it does **not** load —
> `Unrecognized key: "lane"`, exit 2 — rather than falling back to `lane: local`. So adopting the key means
> raising your floor (`npx "cowork-harness@^1.14.0"` <!-- floor-historical: illustrates the 1.14.0 feature gate, not the current floor -->, or the `npm i -g` pin in your CI recipe); it will
> not silently mean something different on an older runner **at the loader**. On `replay` the cassette's
> stamp carries the same guarantee: a cassette recorded ≥ 1.16.0 with `lane: remote` is stamped v11 or
> later, which `replay` and `verify-cassettes` on an older CLI both refuse as too new (`replay` alone takes
> `--best-effort-future-cassette` to override that refusal). `lane: local` means what an older CLI already
> does, so it raises nothing. See
> [Unknown keys](#unknown-keys-the-loader-is-strict-lint-is-lenient).

`lane` is orthogonal to **`fidelity`** (which isolation tier the harness runs in) and to **`execution`**
(where the run happens). A `lane: remote` scenario still executes locally, in whichever tier you chose —
what changes is the contract its assertions are held to.

**Scoped to delivery semantics.** The remote lane's device bridge (`device_bash`, `device_commit_files`,
and the rest of the `mcp__remote-devices__*` tools) is deliberately not modeled: emulating it faithfully would
mean real command execution and real writes on the operator's machine on behalf of a simulated session.
See [fidelity-gaps.md](./fidelity-gaps.md).

**When to reach for it.** `lane: remote` is the contract to hold a skill to when it will run on new Pro and Max
tasks, which run in the cloud from 2026-10-06: it checks whether the skill's delivery survives the cloud lane. A
skill that delivers by writing into
`outputs/` and nothing else will fail there — that is the finding, not a harness bug.

## Fidelity tiers (`fidelity:`)

| Tier | What runs | Use it for |
|---|---|---|
| `protocol` | L0 — the agent on the host, no sandbox (no egress enforcement) | fastest control-loop checks; **rejected** if the scenario asserts egress/`expect_denied` (would false-pass) |
| `container` | L1 — agent in a Docker container with a per-run default-deny egress proxy (VM-loop shape) | the everyday tier: real sandbox, real egress allowlist |
| `microvm` | L2 — agent in an Apple-VZ Lima microVM with a guest firewall | VM-grade escape isolation of untrusted code; network transport **equals `container`** (same allowlist proxy) — not for better network fidelity. macOS arm64 only; needs `cowork-harness vm init` |
| `hostloop` | host-loop: the agent LOOP is a native process spawned directly on the host (no container around the file tools — matching production); shell/web tool calls route host-side into a Docker VM sidecar via the workspace SDK-MCP server (`mcp__workspace__bash`) | reproduce Cowork's **production** split-execution model |
| `cowork` | auto-picks `hostloop` vs `container` the way Cowork itself does (gate `1143815894`, decoded from the synced baseline) | "do what real Cowork does for this release" |

`hostloop`/`cowork` are the production-faithful path (see [DESIGN.md](../DESIGN.md)); `container` is the
practical everyday tier. **`fidelity:` is required** (since 4.0.0; it defaulted to `container` before, so
`fidelity: container` keeps a pre-4.0 scenario's behaviour). The loader refuses a scenario without it —
`run`/`record` exit 2 and `lint` reports `scenario-invalid` — and names the fix. On a scenario that already
has a cassette, add the tier the cassette recorded: any other tier is a recording-shaping change that
`verify-cassettes` and `replay --assert-from` refuse until you re-record. The ad-hoc `skill` lane keeps its
own `--fidelity` default (`container`). Boundary assertions are enforced at `container`, `microvm`, `hostloop`, and `cowork`
(`cowork` auto-resolves to a sandboxed tier — `hostloop` or `container` — never `protocol`).

**`hostloop` with a writable connected folder needs `allow_host_writes: true`.** With no container around
the native file tools, a `mode: rw`/`rwd` folder (see [session.md](./session.md)) gives the agent genuine,
software-checked-only host filesystem access at this tier — the scenario refuses to run (loud, before any
spawn) without this explicit opt-in. Read-only folders and folder-less/scratch `hostloop` runs need no
opt-in. See [boundary.md](./boundary.md) for the full safety posture.

## Scripted answers

Each rule resolves an inbound `can_use_tool` control request — the same channel Cowork's question UI uses.

### AskUserQuestion
```yaml
- when_question: "format|style"   # regex (case-insensitive) on the question text
  choose: "Markdown"              # the option label to select
```
`choose` tolerates the standard `(Recommended)` label suffix (write `choose: Approve` for an offered
`"Approve (Recommended)"`), and accepts the keywords `choose: recommended` / `choose: first`.

**multiSelect gates** — supply a list of labels; the harness validates each against the offered options and
delivers them as the binary-verified comma-joined wire shape (`"Auth, Billing"`):
```yaml
- when_question: "which features"
  choose: ["Auth", "Billing"]     # multiSelect: a list of labels
```
(If a member label itself contains a comma, the harness warns — the wire joins with `", "` unescaped, a
Cowork limitation that can't round-trip such a set.)

**Free-text "Other"** — Cowork offers an "Other" free-text path on every gate; supply an arbitrary string
with `answer:` (distinct from `choose:`, which stays validated against the offered labels):
```yaml
- when_question: "company name"
  answer: "Acme Holdings LLC"     # free-text; bypasses label validation by intent
```
`choose` and `answer` are mutually exclusive on one rule (setting both fails loud). *(Reserved for later: a
whole-gate freeform `response:` — "typed instead of selecting" — is a distinct future key; if added it will
have an explicit precedence vs `answer`/`choose`, so today's two-key model stays forward-compatible.)*

If no rule matches a question, the **`on_unanswered` policy** decides — the harness never silently
fabricates an answer. Set it per scenario (`on_unanswered: fail | prompt | first | llm`) or per run
(`--on-unanswered`). **Where both are set, the scenario's YAML field wins** — a committed scenario is the
reproducible definition of its own test, so steer it by editing the YAML rather than by passing the flag;
the harness warns when the two disagree rather than dropping the flag in silence. **The two also accept
different value sets:** the CLI `--on-unanswered` flag takes only
`fail|first` on `run` (`fail|prompt|first` on `skill`) — `llm` is a scenario-YAML-only value, never a
valid `--on-unanswered` argument. The nearest CLI equivalent is the separate `--decider-llm` flag — which
`run` does **not** accept (`unexpected argument(s)`, exit 2; `run --help`: "run omits `--decider-llm` by
design"). `record`, `skill` and `decide` do; on `run`, `on_unanswered: llm` in the YAML is the only route,
and `--decider-dir` is the flag `run` does take. Default for
`run` is **`fail`** (the error names the exact `--answer`/`choose` to add, and also now mentions
`on_unanswered: llm` in the scenario YAML as a secondary escape valve — useful when a gate's wording
drifts run-to-run and a regex chases a moving target, but non-deterministic and one model call per gate,
so it's not unconditionally preferable to fixing the script); `first` picks option 1 and
warns loudly; `prompt` asks at the TTY. (`run` rejects `prompt` — it would break determinism.)

`llm` lets an **in-band LLM decider** answer the unscripted question (the scenario-YAML equivalent of
the CLI's `--decider-llm`). It is **non-deterministic** by construction, so a run that uses it is flagged
`nonDeterministic` in the record — keep it out of deterministic CI regressions; prefer scripted answers +
`fail` there. See the determinism note above and the decider flags in the [README](../README.md).

> **For large unattended batches, script the stable gates.** A pure live decider re-asks the model
> once per gate; across a back-to-back batch that is more wall-clock, more paid calls, and more exposure to
> a transient `claude -p` exit (now bounded-retried, but not free). For unattended multi-doc completion
> prefer scripted `--answer` / `--answer-policy` on the gates you can name, and keep the live decider for
> exploration. **Also script any gate whose answer feeds a *semantic* assertion:** a decided answer can be a
> confident guess — the decider sees only the transcript tail, not the mounted documents, so it can get a
> doc-answerable fact wrong (a stronger model included) — and a green run resting on it is a false pass.
> The partial run on a stall already echoes the gate + numbered options — paste them straight into `--answer`.

> **Where scripted answers hold up — and where they don't.** The `when_question` regex absorbs *wording*
> drift (an LLM phrases "confirm the stage" many ways), so scripting is robust for skills whose gates are
> structurally stable (the gate reliably appears). It does NOT cover *structural* stochasticity — a skill
> that decides run-to-run *whether* or *which* to ask: there, `on_unanswered: fail` will hard-error on a
> gate it didn't anticipate (correct, but flaky for that skill). For that case answer live instead —
> `--decider-llm` (a model answers, run flagged non-deterministic — **not accepted by `run`**; use
> `on_unanswered: llm` in the scenario there) or `--decider-dir` (you answer in-band; accepted by `run`)
> — accepting the run is then no longer a deterministic regression.
>
> **Stochastic option *labels* (distinct from stochastic *structure*).** If a skill regenerates both the
> question wording *and* the option labels each run, you can still pin the gate **deterministically** —
> anchor on a stable **leading substring** of the label, or on **position**:
>
> - `choose:` (and `--answer`) accept a **stable partial anchor** — a leading substring bound to whichever
>   single option *starts with it at a word boundary* (the label's next char, after optional whitespace, is
>   one of `:` `(` `,` `—` `–` or end-of-label; a `/` or a bare space does **not** count, so `Seed` won't
>   match `Seed / AI/ML`). `choose: "Israeli company"` binds `"Israeli company (IL only)"`; `choose: "2
>   founders"` binds `"2 founders, ~5M each"`. It is **uniqueness-guarded**: if the anchor matches two
>   options — or none — it **fails loud** (the error lists the offered options), never a silent mis-pick.
>   **Prefer this over a positional index** when the leading text is stable: it rides label drift *and*
>   survives option **re-ordering** (it matches content, not slot).
> - `choose:` also accepts a **1-based index** (`choose: "2"` selects the second option), which survives
>   *fully* regenerated labels — the fallback when even the leading text drifts. (Index applies only when
>   `choose` is *entirely* digits; a pure-digit option *label* collides with index semantics — use
>   `answer:` for that rare gate.)
> - `when_question: ".*"` is a catch-all that matches any phrasing.
>
> So `when_question: ".*"` + `choose: "2"` pins a gate whose wording and labels both drift, with no live
> decider — **but only when the option *order* is stable.** A positional `choose` is robust to label drift,
> NOT to option *re-ordering*: if the gate can present its options in a different order run-to-run, the index
> lands on a different option (a silent re-record flake; `lint` flags positional `choose` with an advisory).
> Escalate only as far as you must: an **exact label** (`choose: "<label>"`) when labels are stable → a
> **partial anchor** (above) when only the label's tail drifts (robust to re-ordering) → a **positional
> index** only when even the leading text regenerates and the option order holds. **Caveat:** rules are evaluated in order and the *first* matching `when_question` wins, so `.*`
> answers *any* gate — use it only as a **last-resort fallback for a single expected gate per turn**, and
> always place it *after* more-specific rules. This covers stochastic *labels*; it does **not** cover
> structural stochasticity (whether/which gate appears), which still needs a live decider as above.
>
> **When the labels *and* the order both regenerate, neither anchor holds** — a partial anchor has no
> stable leading text to bind, and a positional index has no stable slot to land on. The only remedy is
> free-text `answer:`, Cowork's **"Other"** free-text path (above): it is order- and label-independent
> because it is never validated against the offered labels at all. That is also its cost — the harness
> delivers whatever string you wrote, so it cannot tell you the gate still offers the option you meant,
> which is exactly the guard `choose:` gives up. A `choose:` whose label vanished fails loud; an `answer:`
> for an option the skill stopped offering sails through and the run keeps passing. Pin with `answer:`
> when nothing else binds, and treat it as un-anchored: it survives drift because it does not check.
> There is no `choose_matching:` or other regex-over-options key.

> **Batched gates are answered atomically.** A gate with several sub-questions is answered (and delivered)
> as one unit. If your scripted rules match only *some* sub-questions, the **whole gate** falls through to
> the `on_unanswered` policy, and the matched answers are not delivered. The run says so durably: the
> stderr warning names the unmatched sub-questions, `result.partlyScriptedGates` lists the matched and
> unmatched ones per batch, and the warn-severity `partly_scripted_gate` verdict signal (shown by `run`,
> `replay` and `verify-run`) reports it without changing the verdict or exit code. Fix it by scripting every
> sub-question of the batch. *Current* behavior — don't build on "a partial match always sends the whole gate to the fallback":
> it may later become **opt-in composable** (script some sub-questions, let the fallback fill the rest in one
> envelope), which would be introduced behind an explicit flag so this default is preserved.

### Reusable answer policies (`--answer-policy`)

When you drive a skill directly with `cowork-harness skill … --answer-policy <yaml>` (rather than a
scenario file), you can keep its known AskUserQuestion gates in a reusable YAML policy instead of repeating
`--answer "<rx>=<choice>"` flags. The policy is the **same regex→label rules** a scenario's `answers:`
block uses — a bare list of `{ when_question, choose }` rules, or an `{ answers: [...] }` doc:

```yaml
- when_question: "output format|which format"   # case-insensitive regex on the question text
  choose: "Markdown"                             # the option label to select
- when_question: "confirm.*stage"
  choose: "Looks right"
- when_question: ".*"                            # catch-all — LAST, after specific rules; single gate/turn
  choose: "2"                                    # 1-based position — survives regenerated option labels
```

A missing, unparseable, or non-list policy file **fails loud** at load time — a malformed policy is never
treated as "0 rules" (which would surface only when a gate went unanswered mid-run). A runnable copy is
[`examples/answer-policies/demo.yaml`](https://github.com/yaniv-golan/cowork-harness/blob/main/examples/answer-policies/demo.yaml). Use it for declarative,
deterministic CI: scripted answers + `fail` for everything they don't cover.

### Tool permissions
```yaml
- when_tool: Write
  decide: allow                   # allow | deny

- when_tool: Bash
  allow_if: '!/\brm\b/.test(command) && !command.includes("curl")'  # JS predicate over the tool input
  else: deny                      # decision when the predicate is false (default: deny)

- when_tool: "webfetch:example.com"   # a web_fetch APPROVAL (raised on a provenance miss)
  decide: allow
  grant: domain                       # "Allow all for website" → approve example.com for the rest of the
                                      # run; `grant: once` (or omit) = a single-fetch allow. Deny = deny.
```
The predicate is evaluated with the tool's input fields as locals (e.g. `command`, `file_path`, `url`, `domain`). Unmatched tools fall to the **permission parity** default (set on the session setup): read-only tools (`Read`, `Glob`, `Grep`) always allow; for everything else, the default `cowork` parity **allows** the unscripted tool but records an `allow-unscripted` audit finding (matching real Cowork, which would have asked a human), while `strict` parity **denies** it (for adversarial tests). **Exception — `webfetch:<domain>`:** real Cowork *gates* a web_fetch provenance miss (it does not auto-allow), so it is carved out of cowork parity and is **fail-closed** unless answered (a scripted rule as above, `web_fetch.approved_domains`, or an LLM/external terminal). A URL you put in the **prompt** is provenanced → fetched with no gate at all.

## Assertions

**What to assert (the model is stochastic — assert the right things).** Scenarios are strongest for
**structural / boundary** checks: `subagent_dispatched`, `dispatch_count_max`, `egress_*`/`expect_denied`,
`file_exists`/`user_visible_artifact`, `no_delete_in_outputs`, `gate_answers_delivered`, `result`. These
test the *shape* of behavior and constraint-respect — robust to LLM phrasing drift, and impossible to test
without actually running the agent. For **content correctness**, match the assertion to the deliverable:
- a skill whose output is **prose** (a markdown report) → `transcript_matches` (a regex, drift-tolerant) or
  `transcript_contains` (a literal, for stable markers). **Both see top-level `assistant_text` only** — text
  the agent emitted inside a tool call (a gate question or option) is invisible to them; assert that with
  `question_context`/`question_asked` instead. Avoid pinning exact long phrases. `transcript_matches`
  is **case-insensitive**; **single-quote** the regex in YAML (double-quoted YAML eats a backslash, so
  `"\d"` breaks — use `'\d'` or a block scalar); the transcript is one concatenated string, so use `[\s\S]`,
  not `.`, to span turns.
  - **Use it only for stable lexical markers** — a number format, a header, a literal token the skill always
    emits. **Do NOT use it to assert semantic content the model paraphrases** ("the skill flagged the blank
    field"): a regex pinned to one phrasing passes on one record and fails on a re-record when the model
    rewords it, even though the behavior is identical (a re-record flake). If the fact also lands in a
    structured artifact, assert *that* field instead (next bullet) — it's phrasing-independent.
- a skill that emits **structured JSON** → assert it directly in the scenario YAML with **`artifact_json`**
  (a dotted `path` + an operator — no Python; see below). Reach for the **pytest `cowork` lane**
  (`assert_artifact_json(path, lambda d: …)`, a full Python predicate over the parsed object) only when the
  check is too complex for a dotted path + single operator. Either way, prefer a structured-field assert over
  a transcript substring for anything the skill writes to an artifact.
- a skill whose output is a **written file** (a report, a deliverable on disk) → `user_visible_artifact: <path>`,
  **not** `file_exists`, for the user-facing deliverable. `user_visible_artifact` spans both visible roots
  (`outputs/` + each connected folder), while `file_exists` only checks `mnt/<path>` and does not check
  folder-relative deliverables.

  > **Where a relative path actually lands — measured on Cowork's local lane, 2026-08-27.** An earlier
  > version of this bullet said a model told to write `outputs/foo` writes `mnt/<folder>/outputs/foo`. That
  > was wrong about production *and* about both harness tiers.
  >
  > **From Desktop 2.7032.0 none of the relative forms below lands anywhere:** the agent runs at
  > `/var/empty`, so a relative `Read`/`Write`/`Edit` is **refused** ("File is in a directory that is denied
  > by your permission settings.") and only a relative `Grep`/`Glob` is re-anchored to outputs. Give the
  > file tools an absolute path under outputs.
  >
  > **Before Desktop 2.7032.0**, on the **local** lane the file tools resolved a relative path
  > against **`outputs/`**, **regardless of whether a folder was connected** — a connected folder sat
  > *beside* `outputs`, it did not become the file-tool base. Three consequences a skill author had to know
  > on those Desktops:
  >
  > | written as | lands at | visible? |
  > |---|---|---|
  > | `foo.md` (bare) | `outputs/foo.md` | **yes** |
  > | `./foo.md` | `outputs/foo.md` | **yes** |
  > | `outputs/foo.md` | `outputs/outputs/foo.md` | **no** — the prefix DOUBLES |
  > | `<folder>/foo.md` | `outputs/<folder>/foo.md` | **no** — a same-named DECOY inside outputs |
  >
  > The last row was the nastiest: addressing a connected folder by name never reached it, the write
  > succeeded, and nothing signalled the miss. In both eras **no relative path from the file tools reaches
  > a connected folder** — that needs an absolute path (from 2.7032.0 the attempt is refused rather than
  > silently decoyed).
  >
  > **The right guidance is LANE-DEPENDENT — there is no single answer.**
  >
  > | lane | file-tool base | write a deliverable as |
  > |---|---|---|
  > | local-lane **host-loop** (production on 2026-08-27, gate `1143815894` force-ON), Desktop **2.7032.0+** | none: the agent runs at `/var/empty`, and a relative `Read`/`Write`/`Edit` is **refused** | an **absolute** path under the outputs dir the prompt names |
  > | local-lane **host-loop**, Desktop before 2.7032.0 | `outputs/` | a **bare filename** |
  > | **VM-loop** (`fidelity: container`/`microvm`) | the session root, i.e. the scratchpad | a path under `{{workspaceFolder}}`, or deliver via `present_files` |
  > | **cloud** | `/home/claude`; no `mnt/` tree at all | neither of the above applies |
  >
  > So no relative form is right everywhere: on current production host-loop it is refused, on older
  > host-loop a bare filename was right, and at the harness's own default tier it lands in the scratchpad.
  > Name the tier (and, for host-loop, the baseline) you mean. The safest skill instruction describes the OUTCOME ("save it
  > where the user can see it") rather than a path, because the path differs by lane.
  >
  > **The same place has four names, and the product uses none of ours.** Worth stating once, because a
  > skill author reading Cowork's UI and this page is reading two vocabularies for one directory:
  >
  > | Cowork's UI says | this page says | in a scenario |
  > |---|---|---|
  > | **Working folder** | `outputs/` + each connected folder — the user-visible roots | `user_visible_artifact:` |
  > | **Scratchpad** | the scratchpad / session root — everything outside `mnt/` | not addressable; not delivered |
  >
  > `{{workspaceFolder}}` is a prompt token, not a UI concept: it renders to the *first* user-visible
  > root. And Cowork's **Scratchpad panel is an activity log, not a location listing** — measured: it lists
  > files as "wrote to"/"viewed" regardless of where they landed, so a file appearing there is NOT evidence
  > it is undelivered.
  >
  > **A `Write` under outputs is user-visible the moment it lands** on the local lane (before
  > Desktop 2.7032.0 a bare `Write` landed there; from it the path must be absolute), so `present_files`
  > on it is a no-op promotion rather than the step that delivers it.

  Reserve `file_exists` for a known fixed sandbox path.

Each list item under `assert:` is one assertion. An item with **multiple keys is an AND** — it passes only
if *every* key passes (don't rely on the first; keep one concern per item unless you mean conjunction).

### Which assertion for which question (goal → key)

The full catalog below is a reference, not a chooser — ordered by family rather than by how often
you need them. Start here instead, then read the row for whichever key you land on. (`cowork-harness
assertions --list` prints the same set grouped the same way.)

| You want to check that… | Reach for |
|---|---|
| the run succeeded at all | `result: success` — the floor under every scenario |
| a deliverable reached the user | `user_visible_artifact: <path>` — **not** `file_exists`, which misses folder-relative deliverables (+ `no_scratchpad_leak: true` when delivery goes through `present_files`; **`container` only**) |
| a structured field has the right value | `artifact_json: {artifact, path, equals\|matches\|…}` — phrasing-independent, unlike a transcript regex |
| the skill said something specific | `transcript_matches: '<rx>'` for stable lexical markers only — never for content the model paraphrases |
| **a gate still fires at all** | `gate_answer_count_min: 1` — the presence floor (a floor of `0` witnesses nothing). `gate_answers_delivered` alone passes **vacuously** when zero gates fire, so a skill that stops asking stays green; `lint` warns (`vacuous-gate-assert`) if you assert one without a companion |
| **no gate fires — a gate-clean scenario** | `questions_count_max: 0` — the explicit zero-gate declaration, which fails loudly if a gate ever appears. Do **not** also assert `gate_answers_delivered`: it asserts nothing when no gate fires, and `lint` says so. This is the other half of the `vacuous-gate-assert` remedy — pair the delivery check, or drop it |
| a scripted answer actually reached the model | `gate_answers_delivered: true` — pair it with the floor above |
| every gate was answered by a scripted rule (an unattended run) | `gates_all_scripted: true` — fails naming any gate the LLM decider, `first`, or an external or human decider answered; `{include_permissions: true}` also checks tool permissions. Zero gates passes, so pair it with the floor above or `questions_count_max` (`lint`: `unpaired-gates-all-scripted`) |
| a skill actually **ran** (or must not) | `skill_triggered: <rx>` / `no_skill_triggered: <rx>` — distinct from `skill_available`, which only means it was *offered* |
| a sub-agent did the work | `subagent_dispatched: <rx>`, `subagent_output_contains: {contains}`, `dispatch_count_max: <N>` |
| a `context: fork` skill answered correctly | `tool_result_matches: '^Skill "[^"]*" completed \(forked execution\)[\s\S]*<rx>'` — its answer is the `Skill` tool result, not a sub-agent output (foreground fork only — a backgrounded fork's result carries no answer; to grade the answer against a rubric instead, set `include_fork_results: true` on `semantic_matches`). **Model invocation only:** a prompt starting with `/<skill>` runs the fork with no `Skill` call, so this result text never exists — assert `skill_triggered` and match the answer with `transcript_matches` (`lint` warns: `slash-prompt-forked-result-anchor`) |
| the skill didn't error out of a tool | `tool_no_error: <rx>`, `max_tool_errors: <N>` |
| it didn't waste repeated identical calls | `max_redundant_tool_calls: <N>` |
| a to-do workflow finished | `all_tasks_completed: true`, `task_status: {match, status}` |
| the sandbox actually blocked the network | `egress_denied: <host>` — **live-only**, skipped loud on replay |
| a pre-existing input wasn't mutated | `input_unmodified: <glob> \| [<glob>, …]` (live / `verify-run`) |
| the harness's own hook callbacks (the built-in Task hook, a custom hook bundle) blocked (or didn't block) a tool | `hook_blocked: <rx>`, `no_hook_blocked: true` — replay needs a `controlOut` cassette; a plugin's hook never reaches this list |
| a plugin's own hook (PreToolUse, Stop, SessionStart, PostToolUse, …) ran (or blocked) | `hook_event_fired: <HookEvent>`, `hook_event_blocked: <HookEvent>` (or `{event, max: 0}`, `no_hook_event_blocked: true` for none) — stream content, no `controlOut` needed |
| a hook allowed, denied or asked about a tool by printing JSON | `hook_decision: {event: PreToolUse, decision: deny, tool: Bash}` |
| a hook that exits 0 but says on stderr that it failed open | `hook_output_not_contains: {event: Stop, stream: stderr, text: "…"}` (or `hook_output_contains` for the text it must print) |
| spend stayed inside a ceiling | `max_cost_usd`, `max_tokens`, `max_turns` — on **replay** these assert the *recording's* spend, which never changes |

Two axes decide whether a key you pick actually runs: the **tier** it needs (some are `container`-only) and
whether it **survives `replay`**. Both are in the key's row below, and the replay classes are summarised in
[Which assertions survive `replay`](#which-assertions-survive-replay-ci-placement).

| Assertion | Passes when |
|---|---|
| `result: success \| error` | the run ended with that status |
| `transcript_contains: <str>` | the assistant transcript includes the literal string. **Sees top-level `assistant_text` only — it excludes every `tool_use`/`tool_result`**, so text the agent emitted only inside a tool call (an `AskUserQuestion` gate question or option, a tool result) can never match at any phrasing; use the gate keys (`question_asked`, `question_context`, `question_options`) or `tool_result_contains` for those. |
| `transcript_not_contains: <str>` | it does not. **Sees top-level `assistant_text` only — it excludes every `tool_use`/`tool_result`**, so text the agent emitted only inside a tool call (an `AskUserQuestion` gate question or option, a tool result) can never match at any phrasing; use the gate keys (`question_asked`, `question_context`, `question_options`) or `tool_result_contains` for those. |
| `transcript_matches: <regex>` | the transcript matches the regex (case-insensitive) — fuzzy content for stochastic prose, e.g. `'SOM:?\s*\$[0-9.]+\s*M'`. **Sees top-level `assistant_text` only — it excludes every `tool_use`/`tool_result`**, so text the agent emitted only inside a tool call (an `AskUserQuestion` gate question or option, a tool result) can never match at any phrasing; use the gate keys (`question_asked`, `question_context`, `question_options`) or `tool_result_contains` for those. |
| `transcript_not_matches: <regex>` | it does not match (e.g. no leaked stack trace / `undefined`). **Sees top-level `assistant_text` only — it excludes every `tool_use`/`tool_result`**, so text the agent emitted only inside a tool call (an `AskUserQuestion` gate question or option, a tool result) can never match at any phrasing; use the gate keys (`question_asked`, `question_context`, `question_options`) or `tool_result_contains` for those. |
| `file_exists: <path>` | the path exists under the run's `work/` (e.g. `outputs/x.md`). Object form `{path, authored}`: `authored: true` also requires that THIS run created or rewrote it (see [`workspace_fixture`](#starting-from-a-saved-workspace-workspace_fixture)); `authored: false` states an inherited file is fine |
| `user_visible_artifact: <path>` (or `{path, authored}`, as `file_exists`) | the path exists **and** is under a user-visible root (`outputs/` + each connected folder's mount name) — i.e. the deliverable the user actually sees in Cowork. **Footgun:** if your skill delivers by writing to its working dir (the scratchpad) and calling `present_files` (rather than writing directly under `outputs/`), that promotion is modeled **only on `fidelity: container`**. On `hostloop` there is nothing to promote — a file the agent writes under the outputs dir is already under a user-visible root, so this assertion passes. On `microvm`/`protocol` the file stays in the scratchpad and this assertion false-reds. **The correct path is LANE-DEPENDENT** — see "Where a relative path actually lands" above. On the local lane's **host-loop** (what Desktop ran when measured) against Desktop **2.7032.0+**, any relative `Write` — `actions.md` or `outputs/actions.md` — is **refused**; write an absolute path under the outputs dir. (Before 2.7032.0 the file tools were rooted at `outputs/`, so a bare filename landed there and `outputs/actions.md` doubled to `outputs/outputs/actions.md`.) At `fidelity: container`/`microvm` (VM-loop) the base is the session root instead, so a bare filename lands in the scratchpad and you want `{{workspaceFolder}}` or `present_files`. Measured 2026-08-27. Describing the OUTCOME rather than a path also sidesteps the lane split — the delivery *tool* is named `present_files` on the local lane and `SendUserFile` on remote Cowork ([fidelity-gaps.md](./fidelity-gaps.md), "File delivery"), so a skill is better off describing the outcome than naming either. |
| `no_delete_in_outputs: true` | no delete op (`rm`/`mv`/…) touched `mnt/outputs` — **only `true` is valid**; writing `false` is rejected by the schema. It checks on **every baseline**. Whether Cowork itself allows the delete depends on the release: from Desktop 2.16120.0 a normal session mounts outputs `rwd` and deletes succeed; before that it was `rw` and `unlink`/`rmdir` failed with `EPERM`. **Omitting the key** therefore means: on a baseline recording outputs `rw`, a detected delete still fails the run via the `outputs_delete` verdict signal, which fires *because* the key was not authored (accept an intended one with `allow_outputs_delete: true`); on a baseline recording `rwd` (including `latest`), nothing checks outputs deletes — author the key to keep the check (see [fidelity gaps](./fidelity-gaps.md#deletes-in-outputs-follow-the-baselines-recorded-mount-mode)). Detects operations that UNLINK a name — a post-run bash-command scan plus a filesystem diff of `outputs/` per turn, not mount-level enforcement, so a green means none was *detected*, not that the mount enforced anything. A detected delete **fails** when the filesystem diff of `outputs/` proves it (a path present at turn start is gone), when a delete in command or call position has an `outputs/` path as its own operand (`rm`/`rmdir`/`unlink`/`shred -u` as a command — also behind `sudo`/`env`/`timeout`/`xargs`, inside `sh -c`/`eval`/`$(…)`, or launched through Python's `os.system`/`subprocess` — `find`/`fd` with `-delete` or `-exec rm`, `os.remove(…)`/`shutil.rmtree(…)`/`Path(…).unlink()`, or a move out of outputs), or when the diff could not verify the turn. A hit that rests only on the detector's inference — an unprovable target, a `cd` into outputs followed by a relative path, or an outputs path that merely shares a statement with a word like `rm` (a Python variable `rm = json.load(open(".../outputs/r.json"))`, quoted prose, a `sed`/`grep` pattern, a trailing comment) — with a clean diff is the `outputs_delete_unconfirmed` **warn** instead (an authored key passes on it; the `outputs_delete_unconfirmed` warn is still raised in the run output, and the hit is also kept as the assertion's evidence in the JSON envelope). A *statement* is one fragment of the command split on newline, `;`, `&&` and `\|\|` (quote-blind, after comments are stripped and same-command `VAR=value` assignments expanded one level), so some real deletes land in the warn tier — a loop body whose operand is the loop variable (`for f in …; do rm "$f"; done`), a `cd` then a relative path, chained variables (`A=…; B=$A/x; rm "$B"`), a Python path held in a variable set on another line (`p = …` then `os.remove(p)`, or `for p in …:` then `p.unlink()`), wrappers with flag combinations the classifier does not model (`sudo -Hu user rm`, `git -C dir rm`), and calls outside the modelled set such as Node's `fs.promises.rm(…)`; and quoted text in which a delete command with an outputs operand follows a shell separator, subshell or keyword — the classifier does not track quotes (`echo 'note; rm mnt/outputs/x'`, `echo "a & rm …/outputs/x"`), and a heredoc that *writes* a script rather than running it (`cat <<EOF > clean.sh` with an `rm …/outputs/x` line) still fails — waive that with `allow_outputs_delete`. A statement over 4 KiB or a command over 16 KiB is judged by the stricter original rule (a delete word, or `mv`, and an outputs path anywhere), so a huge one-line body with a variable named `rm` fails again. A command whose variable expansion would exceed the scanner's work budget (about a hundred distinct variables referenced in one 10 KB line) is not expanded: every mount it names literally counts as deleted in, and the classifier answers `named` when its own expansion is over the budget too. An operand joined through an empty variable (`$B${A}C` with `A=""`) is kept unprovable — flagged, never cleared as safe. When the diff could not verify the turn and nothing was flagged, the key distinguishes the two halves: an incomplete **post-run** walk fails it as evidence-unavailable (every output could have vanished unseen), while an incomplete **turn-start** snapshot, or a diff in `result.json` that is incomplete or malformed, passes it with the `outputs_diff_unavailable` warn (the text scan still ran and found nothing; only the pre-existing-file check is missing). Emptying a file in place (`truncate`, `>`, `shred` without `-u`) is not a delete and is permitted by Cowork, so it is not flagged. Renames: the command scan never flags `mv` within outputs, and the filesystem diff does not report a rename to a NEW path or a file the turn created being moved onto an existing one; but a file that existed at turn start, moved onto another file that also existed at turn start, IS reported (`outputs/a.md removed`), so it fails this key on every baseline and the default verdict on a `rw` baseline |
| `no_delete_in_mounts: true` | no delete op touched `outputs` or any `rw` connected folder, except mounts waived by `allow_delete_in`. It covers `outputs` on **every** baseline, including those (Desktop 2.16120.0+) where Cowork allows an outputs delete: its own evidence is the bash-command scan, and unless outputs is waived, authoring it also arms the outputs check, so a delete only the filesystem diff saw fails the run as `outputs_delete` (the signal, not this assertion; `allow_outputs_delete` waives it). Production denies `unlink`/`rmdir` on a `rw` connected folder until per-mount approval, so `no_delete_in_outputs` asserts only part of the rule; this is the mount-wide form. **Only `true` is valid.** Same post-run-scan caveat: a green means none was *detected*, not that the mount enforced anything |
| `no_unexpected_files: [<glob>, …]` | every **newly created** file under a user-visible root matches ≥1 workRoot-relative glob (`**` matches any depth — e.g. `outputs/handoff/**` for per-run subdirs); `[]` = no new files allowed; **new-files-only** (overwrite-in-place is invisible — pair with `artifact_json` / producer stamping); post-hoc detection like `no_delete_in_outputs`, not mount enforcement; live/verify-run without pre-run manifest ⇒ evidence-unavailable (live runs capture the baseline only when this key is asserted; recordings always capture, so a later assert-add replays without re-record); captured on every live sandbox tier including microvm (its outputs are snapshotted from the VM into the run dir); replay-checkable when the cassette carries `artifacts` **and** `preRunPaths`; an **incomplete** post-run filesystem walk (an unreadable subtree — permission/I-O error — not just a missing pre-run manifest) also ⇒ evidence-unavailable, so "no strays" is never trusted from a partial walk |
| `input_unmodified: <glob> \| [<glob>, …]` | a single glob or a list; every **pre-existing** file (incl. `uploads/**`) whose workRoot-relative path matches has an unchanged content hash after the run (the in-place-mutation detector — the counterpart to `no_unexpected_files`, which only watches for *new* files); a glob that matches **no** pre-run path fails loud (a typo or renamed mount would otherwise pass vacuously, verifying nothing); needs the pre-run content-hash manifest (harness ≥0.24 recordings) — same capture caveats as `no_unexpected_files` |
| `self_heal_ran: <bool>` | a bash command the model wrote did (not) name a plugin under `/sessions/<id>/mnt/.local-plugins/` or `/sessions/<id>/mnt/.remote-plugins/` — the plugin-root self-heal path. It reads the command as the model wrote it, so a host plugin path that `hostloop`'s bash tool rewrote to the VM mount does not count |

> ⚠️ **"This specific file must NOT exist" is `file_absent`, and it is LIVE-only.** Do not reach for
> `no_unexpected_files` — that is an *allowlist over newly created files*, a different claim with two
> traps: it is **new-files-only**, so a file that existed before the run is invisible to it however
> tight the allowlist, and it needs a pre-run manifest (on resume, a `--resume` turn reads the first turn's
> manifest if that turn captured one — so "new" there means new since the session began — otherwise the key
> fails evidence-unavailable). `file_absent` has neither precondition. It does not run on `replay`: proving
> absence needs an exhaustive, healthy walk, and a cassette records no walk health — "not in the
> manifest" and "the walk never saw it" are indistinguishable there, so the key would pass while
> proving nothing. It also fails **evidence-unavailable** on `lane: remote` and on a pre-run origin of
> `remote-unavailable`, where the filesystem is not locally observable.
| `file_absent: <path>` | the named path does **not** exist under the work root after the run — the direct negative-existence check (see the note above for why `no_unexpected_files` is not a substitute). **LIVE/verify-run only**, skipped-loud on replay; fails evidence-unavailable on `lane: remote` and on `preRunOrigin: remote-unavailable`. An escaping symlink FAILS rather than reading as absent |
| `artifact_text: {artifact, contains?: [..], not_contains?: [..], matches?, not_matches?, authored?}` | assert over a delivered artifact's **text body** — the companion to `artifact_json` for non-JSON deliverables, and the way to prove an internal path or filename did **not** leak into a file a user receives (a fix applied to `report.md` alone looks complete while `report.json` still carries it). `artifact` is a literal path, not a glob — one entry per delivered surface. At least one matcher is required. Manifest-class, like `artifact_json`: a body captured body-less (uploaded input, read-only folder input, **over the 64 KiB body cap** — raise `--max-artifact-bytes`) or recorded as a symlink fails **evidence-unavailable**, and for the negative matchers so does a body that is not lossless UTF-8, since a binary body read as text would "pass" against bytes it never saw |
| `no_lost_write_back: true` | fails if the run authored an interactive HTML artifact (or a `.py`/`.js` generator of one) whose **relative** Submit/POST write-back is lost under Cowork (served from Cowork's own origin → the write-back resolves non-ok and a "Saved!" is silently false). Runs the shipped **static Tier A** analyzer (`analyze-artifact`, no jsdom, deterministic) over the files the run authored (diffed against the pre-run manifest). A lost write-back on an **added** agent-authored source (`outputs/` or the scratchpad) **fails**; the same on a **pre-existing** file the skill merely modified on a read-write connected mount is **advisory** (not the skill's to own); `-suspect` findings are surfaced but pass. **Only `true` is valid** (omit to skip). **Live lane only** (needs the authored-file capture) — skipped-loud on replay; `verify-run` recomputes the authored set from the kept work dir. Runs on every live sandbox tier including **microvm** (its outputs are snapshotted from the VM into the run dir). Could-not-verify (fail-closed) on a `--resume` scratchpad walk or a candidate that couldn't be analyzed — never a silent clean |
| `tool_called: <glob>` | a tool the agent ran matched this glob (`*`/`?`, exact when literal, anchored, case-sensitive); `mcp__workspace__*` = any workspace tool. **Legacy tool names match too:** the agent binary canonicalizes a set of legacy spellings (`Task`→`Agent`, `KillShell`/`KillBash`→`TaskStop`, …) and the spawn tool list still declares the LEGACY one, so the init inventory shows `Task` while every actual call is emitted as `Agent`. Either spelling matches, and so do globs over either (`Ta*` matches a recorded `Agent`). Glob, not regex — an empty glob, or one containing a regex/brace-expansion metacharacter (`.*`, `.+`, `\|`, `()`, `[]`, `+`, `^`, `$`, `{}`, `\d`/`\w`/`\s`/`\b`), is now **rejected at scenario/cassette load** (a hard schema error) rather than silently matched-against-nothing |
| `tool_not_called: <glob>` | no tool the agent ran matched this glob (`mcp__*` = no MCP tool ran) — same load-time reject on an empty or regex-like glob as `tool_called`, and the same legacy-name matching. ⚠️ **A literal naming a tool the tier does not serve is REFUSED at load** (`Bash`/`WebFetch`/`NotebookEdit` at `hostloop`; `mcp__workspace__bash` at `container`/`microvm`) — those can never be violated, so the assertion verified nothing. The error names what to write instead. Globs and every other name are untouched: `--tools` gates the built-in set alone while each tier separately passes `--mcp-config`, so a session-MCP tool is offered without appearing in any tool list and is never refused |
| `tool_called: {tool: <glob> \| [..], input?, input_any?, result?, scope?, subagent_type?, count?}` | **object form** — asserts what a call CARRIED, where it RAN and what its paired result SAID, which no name glob and no `transcript_*` key can see (`transcript_*` reads top-level prose only, so it passes when the agent merely *says* it ran a command). `tool`: a glob or a list of globs (any-of; list both shells, `[Bash, mcp__workspace__bash]`, for a claim that must hold at hostloop too). `input: {<field>: <regex>}`: every named top-level input field must match (case-insensitive, unanchored; a missing field is no match; a non-string value is matched as JSON). `input_any: <regex>`: some top-level field matches. `result: {matches?, not_matches?, is_error?}`: predicates on the call's paired `tool_result` (by `toolUseId`, 10,240 characters of text — 32,768 for a top-level `Skill` result). `scope`: `main` (default — the main agent, including a `Skill`'s or `Agent(fork)`'s children, the set the string form reads), `subagent` (the parent is a sub-agent dispatch this run recorded, at any depth), or `any` (also calls whose parent is not a recorded dispatch, e.g. a `Skill` invoked inside a sub-agent). `subagent_type` (with `scope: subagent`): regex over the IMMEDIATE parent dispatch's type or description. `count: {min?, max?}` (default `min: 1`). **Fails closed:** an unpaired call never satisfies `result`; a truncated result or input that cannot settle a predicate, or a result.json without `toolCalls`, reports *evidence unavailable*, never a pass or a plain "not called". A red lists the calls it considered and names matches in another scope ("1 matching call in scope subagent — set `scope: any`"). `{tool: X}` alone is exactly `tool_called: X`. A cassette using this form stamps **v13**. |
| `tool_not_called: {tool: <glob> \| [..], input?, input_any?, result?, scope?, subagent_type?}` | **object form** — no call in scope satisfies every predicate (no `count`). Same fields and fail-closed rules as above: a candidate whose result is unpaired or truncated, or whose input was truncated, is *evidence unavailable*, never a pass. Refused at load when EVERY listed tool is one the tier does not serve. ⚠️ **Redaction hazard — this is the dangerous direction.** A committed cassette is redacted, which rewrites the recorded inputs: an `input` regex naming a literal the policy rewrites (a home path, an email) cannot see its target on replay. On replay, any candidate call whose field (or paired result, for `result.matches`) carries a redaction token is *evidence unavailable*, whatever the regex — the evaluator cannot know what the token replaced — so a negative check never passes over rewritten bytes. `record` warns — naming the redacted call and the ways out (narrow `scope`/`tool`, the string form, or live-only) — and refuses the write (the exact guard), and `lint` flags a regex naming a redactable literal (`tool-input-regex-redactable`) — a heuristic that reads `.cowork-redact.json` from the current and scenario directories only, not the cassette's. Match a part of the input redaction leaves alone (the verb and flags, a workspace-relative path), or keep the check on a live gate. Note also that the default `scope: main` does not see a sub-agent's call — use `scope: any` for "nothing anywhere ran X". |
| `reference_read: <regex>` | a skill `references/`/`scripts/` file whose path matches this regex was **accessed** during the run — main agent **or** sub-agents, through any observed channel: `Read`, `Grep`/`Glob` (their `path` input), or a `Bash`/`mcp__workspace__bash` command naming the path. Regex is **unanchored and case-insensitive** (every regex key in the harness uses the same helper), so `"env\\.md"` matches `references/env.md`. **Under-approximates by design** — the path must be rooted in the mounted plugin, so a `cd` into the skill dir followed by a bare `cat references/x.md`, a heredoc body, and a `$VAR`-built path are all invisible. Fails **evidence unavailable** (never vacuously) when the run recorded no observable tool stream |
| `no_observed_reference_access: <regex>` | no **observed** access to a `references/`/`scripts/` file matching the regex. Named `observed` deliberately: detection under-approximates (see `reference_read`), so this proves nothing was *seen*, **not** that the file went unread — an agent that `cd`s and `cat`s it passes this key. Use it to catch a reference the skill's routing never reaches, not as proof of non-use. Fails **evidence unavailable** when no observable tool stream was recorded, which is the direction that would otherwise pass vacuously |
| `tool_result_contains: <str>` | a tool result includes the literal string (content / replay-checkable — substring match, **per individual result**, each scanned up to a 10,240-character cap (a top-level `Skill` result, where a foreground fork's answer arrives, is kept up to 32,768 characters); a string spanning two separate results won't match) |
| `tool_result_not_contains: <str>` | no tool result includes the literal string — content / replay-checkable; **fails loud** if tool results are absent from `result.json` (absent ≠ empty) or display-truncated (no assertable text) — it never vacuously passes when it can't see the evidence |
| `tool_result_matches: <regex>` | the regex sibling of `tool_result_contains` — a case-insensitive regex matches at least one tool result (per-result, 10,240-character cap (a top-level `Skill` result, where a foreground fork's answer arrives, is kept up to 32,768 characters)); useful for an error-signature FAMILY (e.g. `E_[A-Z_]+\|invariant violation`) a script may print even when its exit code was swallowed by its wrapper, which a literal substring can't express |
| `tool_result_not_matches: <regex>` | the regex sibling of `tool_result_not_contains` — same fails-loud-on-absent-evidence semantics |
| `tool_no_error: <regex>` | no tool whose name matches the regex recorded any error (`RunResult.toolErrors[name].errors === 0` for every match) — **requires ≥1 matching tool call** (a regex that matched nothing fails, so a typo can't silently pass) |
| `tool_no_error_if_called: <regex>` | like `tool_no_error` but passes vacuously when no tool matches the regex — the presence-free variant for a tool that may legitimately not run |
| `max_tool_errors: <N>` | total tool errors across all tools (sum of `RunResult.toolErrors[*].errors`) ≤ N |
| `max_redundant_tool_calls: <N>` | total **wasted** repeated tool calls (sum of `count - 1` across every redundant `{name, args}` group in `RunResult.redundantToolCalls`) ≤ N — not the raw count of redundant groups |
| `subagent_tool_used: <glob>` | a sub-agent used a tool matching this glob (same semantics as `tool_called`, incl. the load-time reject on an empty or regex-like glob) |
| `subagent_tool_absent: <glob>` | no sub-agent used a tool matching this glob (same load-time reject as `tool_called`) |
| `no_vm_path_file_op: true` | **`fidelity: hostloop` only** — NO gated file tool (Read/Write/Edit/Glob/Grep/MultiEdit) attempted a path that is exactly `/sessions` or `/sessions/`-prefixed — the production VM-path boundary; content-class (re-derived from the frozen `tool_use` stream, so replay-checkable without `controlOut`); any other tier **FAILS** ("cannot verify" — `/sessions/...` is a valid path there, so excluding the key could green a wrong-tier scenario); **only `true` is valid** |
| `subagent_file_write: {path?, path_suffix?, tool?}` | a **sub-agent-origin** write attempt whose raw path equals `path` (exact — the stronger match) or ends with `path_suffix` has a paired **non-error** tool_result — the causal half of a delivery probe (pair with `artifact_json` to also check content); requires one of `path`/`path_suffix`; `tool` defaults to Write/Edit/MultiEdit; content-class (re-derived from the frozen attempt/result stream); **tier-agnostic** |
| `subagent_dispatch_healthy: {type?, delivered?, path?, path_suffix?, no_vm_paths?}` | **`fidelity: hostloop` only** — composite: `type` selects the dispatch(es) to check (same matching as `subagent_dispatched`; omit to require EVERY dispatch to be healthy — a `type` matching nothing FAILS); for each selected dispatch, `delivered` (default `true`, narrowed by `path`/`path_suffix` with the same exact-vs-suffix precedence as `subagent_file_write`) requires **that dispatch's own** paired non-error write, and `no_vm_paths` (default `true`) requires **that dispatch** attempted no `/sessions` VM path — both scoped via `parentToolUseId`, which is the per-dispatch correlation `subagent_file_write` (matches ANY sub-agent write) cannot express; content-class (`RunResult.fileToolAttempts` + `RunResult.toolResults`, re-derivable on replay); any non-hostloop tier **FAILS** ("cannot verify") |
| `subagent_dispatched: <regex>` | a sub-agent whose **dispatch or resolved agent type, or description**, matches was dispatched (skills often dispatch with only a `description` and no `subagent_type` → `dispatchAgentType:"unknown"`, so match by description, e.g. `subagent_dispatched: "TOP_DOWN"`; a type-less dispatch that RESOLVED to e.g. `general-purpose` via the binary's `task_started` event also matches on `resolvedAgentType`) |
| `subagent_declared_but_unused: <Tool>` | fails if a sub-agent declared the tool but never used **that** tool (even if it used others) — the v0.3.0 fabrication proxy. ⚠️ **It fires only on a dispatch that declares a tool list.** It reads `subagents[].declaredTools`, populated from a `tools`/`allowedTools` key in the dispatch input; the `Agent` tool carries neither, so `declaredTools` is `[]` and the key passes on every such dispatch (0 of 1091 real dispatches carry a non-empty list). Treat a green as "not applicable here", not as evidence against fabrication. |
| `subagent_output_contains: {match?, contains}` | a dispatched sub-agent's own output contains the `contains` substring, optionally narrowed to dispatch(es) whose `dispatchAgentType`/description match the `match` regex (omit `match` to check all dispatches) — a miss against a sub-agent output truncated at the assert cap fails **evidence unavailable**, not a proven absence. **Covers what the run dispatches** (`Agent`/`Task`, including `Agent(subagent_type:"fork")`), **not a `context: fork` skill** invoked through the `Skill` tool: that skill's own answer is never a dispatch — it comes back as the `Skill` tool result, which agent 2.1.284 builds as `Skill "<name>" completed (forked execution).`, a `Result:` line, then the answer. Assert on it with `tool_result_matches` anchored on that prefix, e.g. `tool_result_matches: '^Skill "[^"]*" completed \(forked execution\)[\s\S]*<pattern>'` (`[\s\S]*` because `.` stops at a newline; the match is case-insensitive, has no multiline flag so `^` is the start of the result, and sees the first 10,240 characters of each result — 32,768 for a top-level `Skill` result). This covers a **foreground** fork only: a backgrounded fork's result is the line `Skill "<name>" launched (forked execution, running in the background).`, which carries no answer |
| `dispatch_count_max: <N>` | at most N sub-agents were dispatched — an **author-chosen** budget. (Cowork imposes **no** in-conversation Task-dispatch cap; gate `1648655587`'s `{perTask:1, global:3}` governs the separate scheduled/cron-task session scheduler, not the `Task` tool — see SPEC §10.) |
| `skill_triggered: <regex>` | a skill matching the regex (by its invoked id, e.g. `"plugin:skill"`) was invoked — through the `Skill` tool, **or** by a prompt that starts with `/<skill> …` / `/<plugin>:<skill> …`. The agent expands a slash command itself and emits no `Skill` call (a `context: fork` skill forks directly), so the harness resolves the prompt's leading token against the init frame's skill inventory and records the hit as `slashInvokedSkills` in `result.json` (`skillsInvoked` stays Skill-tool-only). A slash hit is recorded under its qualified id, and the regex is also tried against its bare name, so `^skill$` matches it the way it matches a bare `Skill` call. A slash command the agent refused counts as not invoked: the run's result text STARTS with `This skill can only be invoked by Claude, not directly by users.` (a `user-invocable: false` skill) or `Unknown command: /<name>`, and no model spent output tokens — an answer that merely quotes either line is still an invocation. That refusal shape is read from the agent's code, not yet measured against a real refused run. Real Cowork can refuse a typed slash command earlier, in the Desktop app, with "Unknown skill" and no task at all — the agent never sees it, so the harness cannot either, and a green `skill_triggered` on a slash prompt is not evidence that the typed form resolves in Cowork (a bare name that differs from its plugin's name was refused there; observed on Desktop 2.19675.0, 2026-10-03, 4 runs; pick the skill from the menu, or name it like its plugin — the qualified form was not measured with a single copy installed; see [Slash commands in `prompt:`](#slash-commands-in-prompt--position-matters)). Fails as **evidence unavailable** (not a normal fail) when neither channel matched and one could not be observed: the agent's init tool list has no `Skill` tool at all (invocation can't be observed on this agent version), or the prompt's leading `/name` could not be resolved (more than one staged skill answers to a bare name, or the run delivered no skill inventory) |
| `no_skill_triggered: <regex>` | no invoked skill id matched the regex, counting a skill the prompt's leading slash command invoked as well as a `Skill` tool call — the negative-control / description-collision catcher; fails as **evidence unavailable** (never a vacuous pass) when skill-invocation data is absent (an old `result.json` predating this key), the `Skill` tool itself is unobservable, or the prompt's leading `/name` could not be resolved against the staged skills |
| `skill_tool_used: {skill, tool}` | a tool whose name matches `tool` ran inside a skill-activation window whose skill id matches `skill` — a heuristic for inline skills (a sticky, sequential window that faithfully matches the real agent's active-skill scope, not an exact per-tool boundary). **Scope:** the window's tool counts **include calls made by sub-agents dispatched during it**, so this key cannot say *which* agent made the call — use `subagent_tool_used` for a sub-agent-only claim. It matches tool **names** only, never the path a tool was called with, so "did it read *this* file" is not expressible here (the per-sub-agent reads are recorded at `subagents[].referencesRead`, and reference access across every channel at `subagents[].referencesAccessed` — assertable via `reference_read`) |
| `skill_available: <regex>` | a staged skill's id matched the regex — **offered**, not necessarily invoked (see `skill_triggered` for invocation) |
| `connector_available: <regex>` | an MCP server/connector's name matched the regex — available, not necessarily used |
| `tool_available: <regex>` | a tool in the init manifest matched the regex — available, not necessarily called (see `tool_called` for invocation). The `mcp__skills__*`/`mcp__plugins__*` discovery tools are modeled (as `alwaysLoad`) on `container`/`hostloop`/`cowork` — a miss there is a real absence; `microvm`/`protocol` still declare no such server, so a miss on those two tiers means "not modeled at this tier", not "provably unavailable" (see [fidelity-gaps.md](./fidelity-gaps.md)) |
| `all_tasks_completed: true` | every task in the run's task list reached status `completed` — **requires ≥1 task** (a zero-task run fails; assert `task_count_min` for presence); **only `true` is valid**; also fails **evidence unavailable** ("malformed") when any TaskCreate result was unparseable (corrupt task telemetry) |
| `task_count_min: <N>` | at least N tasks were created (`RunResult.tasks.length >= N`) — the presence companion for task assertions; also fails **evidence unavailable** ("malformed") when any TaskCreate result was unparseable (corrupt task telemetry) |
| `task_status: {match, status}` | a task whose subject or id matches the `match` regex reached `status` — also fails **evidence unavailable** ("malformed") when any TaskCreate result was unparseable (corrupt task telemetry), mirroring `all_tasks_completed`/`task_count_min` |
| `no_scratchpad_leak: true` | every file presented via `present_files` that was in the scratchpad was successfully promoted to `mnt/outputs` (none left behind) — vacuously passes if nothing was presented (pair with a presence check to require a delivery); content-class: both the `present_files` tool_use and its own tool_result live in the ordinary events stream, so this is meaningfully replay-checkable at the tier it evaluates on — the re-drive reproduces the classification at container, where the agent's cwd IS the session root the live lane measures from (at hostloop a re-drive has only the recorded cwd — `mnt/outputs` before Desktop 2.7032.0, `/private/var/empty` from it — so the booleans are not equivalent there); fails as **evidence unavailable** when `presentedFiles` telemetry is absent (an old run predating this key); **container-only on the merits**: hostloop serves `present_files` but never promotes (its handler passes a validated path through unchanged), so there is no scratch→outputs copy for this key to check — that's not a detection gap, though: at hostloop a delivered file under the outputs dir is visible there immediately (see `user_visible_artifact`'s footgun note above). On microvm and protocol, `present_files` isn't served at all, so there's no delivery record for this key to check — cannot-verify. Use `container` for present_files-based delivery you want this key to verify, or write directly to `outputs/`; **the tool name is lane-specific** — `present_files` is the local lane's tool (the one this harness emulates) while remote Cowork delivers via the agent-native `SendUserFile`, so a skill should describe the delivery outcome rather than naming either tool ([fidelity-gaps.md](./fidelity-gaps.md), "File delivery"); this key asserts the harness-side delivery record either way; **only `true` is valid** |
| `present_files_called: true` | at least one file was actually delivered via the `present_files` tool (at least one call carried a well-formed `file_path`, counted at the invocation — **not** read off the classified `presentedFiles` list, so a redaction policy that rewrites host paths cannot turn a real delivery into "never called"; a run whose every call carried an unusable path reports cannot-verify) — the presence companion to `no_scratchpad_leak` (which passes vacuously when nothing was presented). Pair them to require a delivery **and** require it not to leak; **`fidelity: container` or `hostloop`** — the harness serves `present_files` at both (hostloop via a handler mirroring production's own host-loop branch: validate the path, pass it through, no promotion). `protocol` and `microvm` report cannot-verify. See the `no_scratchpad_leak` row, which stays container-only for a different reason; and see the lane note above: the tool name differs on remote Cowork; **only `true` is valid** |
| `max_cost_usd: <N>` | the run's SDK-reported cost is ≤ N USD (the agent session only — the `semantic_matches` judge and the LLM decider (`on_unanswered: llm` / `--decider-llm`) are separate model calls that are **not** included) — fails as **evidence unavailable** when cost telemetry is absent (an old run predating this key). **Live lane only in spirit**: on replay this asserts the *frozen recording's* cost, not fresh spend — a cost regression is caught by a live run, not a token-free replay |
| `max_tokens: <N>` | `usage.input_tokens + usage.output_tokens` ≤ N (cache-read/creation tokens excluded — priced separately). Same replay caveat as `max_cost_usd`: asserts the recording, not fresh spend |
| `tool_calls_max: <N>` | total top-level tool calls (sum of `toolCounts`, sub-agent tools excluded) ≤ N — unlike the cost/token keys, this **is** meaningfully replay-checkable (the re-drive recomputes `toolCounts` deterministically from the recorded events) |
| `max_turns: <N>` | the SDK-reported (or fallback-counted) turn count ≤ N — replay-checkable (the re-drive recounts turns deterministically, same as `tool_calls_max`) |
| `compaction_occurred: true` | a context-compaction boundary occurred during the run (a `compact_boundary` system event was recorded); **only `true` is valid** — omit the key to not require one |
| `no_mcp_error: true` | no MCP round-trip failed during the run (`RunResult.mcpErrors` is empty) — **live lane only** (excluded on replay); **only `true` is valid** |
| `hook_blocked: <regex>` | one of the harness's own `PreToolUse` hook callbacks blocked a tool whose name matches the regex (`RunResult.hookEvents`; a plugin's command hook never reaches it: use `hook_event_blocked`) — replay-checkable only when the cassette carries `controlOut`. **Does not see the agent's own refusal**: on `hostloop` against Desktop 2.7032.0+, a relative `Read`/`Write`/`Edit` is denied by the agent's permission rules before any hook runs, so neither this key nor `path_denied` records it — assert it with `tool_result_contains: "denied by your permission settings"` |
| `no_hook_blocked: true` | no tool was blocked by the harness's own hook callbacks (`RunResult.hookEvents`; a plugin's command hook never reaches it, so use `no_hook_event_blocked` for those) — distinguishes a genuine tool crash from an intentional block; replay-checkable only when the cassette carries `controlOut`; **only `true` is valid** — **Mutually exclusive** with `hook_blocked` (one requires a block to exist, the other requires none — `run`/`skill`/`record` refuse the pair) |
| `hook_event_fired: <HookEvent>` | a **command hook** for this event (a plugin's `hooks/hooks.json` or manifest hook — `Stop`, `SessionStart`, `PostToolUse`, …) ran: a `hook_response` system frame with that `hook_event` was recorded (`RunResult.contextEvents`). Any outcome counts. The harness passes `--include-hook-events` whenever a staged plugin declares hooks — that is what puts events other than SessionStart/Setup on the stream — so a recording made without it reports "never fired". Content-class, grades on replay. Recorded end-to-end for `Stop` (`examples/probes/stop-hook-probe.scenario.yaml`) and `PreToolUse` (`examples/probes/hook-decision-probe.scenario.yaml`); the other names match the same frame but have not each been recorded |
| `hook_event_blocked: <HookEvent> \| {event, tool?, via?, min?, max?}` | that command hook **blocked**: a `hook_response` frame for the event denied — by exit code 2, or (object form only) by a JSON decision on stdout on a frame the agent marks `outcome: success` (exit 0, or an HTTP hook's 2xx status): a PreToolUse `permissionDecision: "deny"` or a top-level `decision: "block"`, which the agent treats alike. A JSON decision on any other frame, such as exit 1, is unreadable, since the frame does not show whether the agent applied it; a hook the agent cancelled (timed out or aborted) decided nothing. Only stdout that parses whole as a JSON object decides, since stdout is the hook's ordinary output too: a word like `deny`, prose, or JSON after other text is no decision. The bare event means at least one frame with exit code 2, the channel this key has always counted; a JSON deny is not counted there, and when the bare form fails it names any JSON deny it saw. The **object form** counts blocking frames by either channel, one per hook run (PreToolUse runs once per matching tool call, subagent calls included); `via: exit2` counts exit code 2 alone, `via: json` the JSON deny alone, and `via: any` (the default) either. `{event: Stop, max: 0}` is the per-event negative, and fails on a hook that denied by JSON alone. `tool` keeps only frames whose `hook_name` is `<event>:<tool>`: the tool that **fired** (or the SessionStart source), not the matcher in hooks.json. The shell is `Bash` at `container` and `mcp__workspace__bash` at `hostloop`, so the wrong name reports "never fired". An event whose frames carry no tool name (`Stop` is named `Stop`) reports evidence-unavailable for any `tool`. Fails naming the exit codes seen when the hook fired without blocking; fails "never fired" when no frame is in scope, `max: 0` included, so a disabled hook never passes. A frame whose outcome cannot be read (no exit code, a hook that started and never answered, stdout a redaction policy rewrote or the agent truncated, output the agent did not apply as a verdict) is evidence-unavailable when it could change the verdict. A Python hook whose script is missing (`python3 missing.py`) also exits 2, so it reads as a block. Cannot-verify when the run has no context events. Content-class. Recorded end-to-end for `Stop` and `PreToolUse` |
| `no_hook_event_blocked: true \| {event, tool?}` | no command hook blocked: every `hook_response` frame (or every frame for `event`) neither exited 2 nor denied by JSON, the same rule as `hook_event_blocked`'s object form. **Never vacuous**: no frame in scope is evidence-unavailable, and `true` also needs a frame of an event other than SessionStart/Setup, because those stream even when hook events were not requested (they stream only when a staged plugin declares hooks). A frame whose outcome cannot be read (no exit code, a hook that started and never answered, stdout a redaction policy rewrote or the agent truncated, output the agent did not apply as a verdict) is evidence-unavailable. Frames carry no plugin id, so a second staged plugin's hook, or a host plugin's at `protocol`, counts as a frame here (the run warns). Distinct from `no_hook_blocked`, which reads the harness's **own** PreToolUse callbacks from `controlOut`. Content-class |
| `hook_decision: {event, decision, tool?, min?, max?}` | counts the `hook_response` frames for `event` whose decision is `decision`, read from the hook's stdout JSON on a frame the agent marks `outcome: success` (exit 0, or an HTTP hook's 2xx status): `hookSpecificOutput.permissionDecision` on `PreToolUse` and `PreModelSwitch`, where it overrides a top-level `decision`, and which the agent ignores on other events; for `PermissionRequest` `hookSpecificOutput.decision.behavior`; for `Elicitation` and `ElicitationResult` an `action: decline`, a deny; else the top-level `decision`; or from exit code 2, which is a deny. A JSON decision on any other frame, such as exit 1, is unreadable, since the frame does not show whether the agent applied it; a hook the agent cancelled (timed out or aborted) decided nothing. `decision` is one of `allow`, `deny`, `ask`, `defer`, as the agent applies them, plus two aliases: `block` means `deny` and `approve` means `allow`. So `deny` matches exit 2, `permissionDecision: "deny"` and `decision: "block"` alike, and the message shows which. Range and `tool` as for `hook_event_blocked` (default: at least one). Only stdout that parses whole as a JSON object decides; empty or non-JSON stdout is no decision, not an error, unless the agent rejected the frame's output, so `allow` never matches a hook that printed nothing. Fails "never fired" when no frame is in scope. A frame whose decision cannot be read (stdout a redaction policy rewrote so it does not parse, truncated output, a frame with no `stdout` field, a decision shape it does not model, a top-level `decision` other than `approve` or `block`, output the agent did not apply (`outcome: "error"` with exit 0, or stderr that opens with the agent's rejection of the JSON, its refusal to read an incomplete capture, or its failure to run the hook), no exit code, a hook that started and never answered, a `hookSpecificOutput` whose `hookEventName` is missing or names another event) is evidence-unavailable when it could change the verdict. A frame that exits 2 is read as a deny whatever its stdout says: a harness rule, since no recording shows both at once. Content-class, grades on replay. Recorded end-to-end at `container` (`examples/probes/hook-decision-probe.scenario.yaml`) |
| `hook_output_contains: {event, stream?, text \| matches}` | a command hook's **output**: some `hook_response` frame for `event` carries (or no frame carries) `text` (a literal substring, case-sensitive) or `matches` (a regex, case-insensitive) in its `stdout`, its `stderr`, or either (`stream`, default `any`); `matches` is case-insensitive and has no multiline flag, so `^` / `$` anchor the whole stream, not a line. For a hook that **fails open** — exits 0 and says why on stderr — which `hook_event_fired` passes. Every frame for the event counts, blocking ones included; an event usually fires more than once (each tool call for PreToolUse, each turn for Stop), and a multi-turn run is graded per turn. **Never vacuous**: no frame for the event fails both keys, with `hook_event_fired`'s diagnosis. Over output a redaction policy rewrote (a replayed cassette, a scrubbed run dir) a literal `text` hit still counts, but a miss — or any `matches` result — is evidence-unavailable; a needle the policy rewrote is evidence-unavailable. A miss is also evidence-unavailable when a hook for the event started and never sent a response (an async or backgrounded hook, or one still running when the run ended — paired by `hook_id`; a recording without `hook_started` frames grades as before), or when the agent truncated a frame's output (`Output truncated (…KB total)` on its stdout). A `text` or `matches` holding a control character is refused at load (in double-quoted YAML `\b` is a backspace — single-quote it). Frames carry no plugin id, so a second staged plugin hooking the same event also counts, and so does a plugin installed on your machine when a `protocol` run reads your real config dir (no sealed managed config); the run warns when either applies. Graded at every tier: the harness passes `--include-hook-events` at `protocol` too, where the hooks run as native host processes. `record` warns when its redaction policy rewrites the needle or tokenises a stream the check reads. Content-class, grades on replay. Recorded end-to-end for `Stop` |
| `hook_output_not_contains: {event, stream?, text \| matches}` | no `hook_response` frame for `event` carries the text in the selected stream — the negative of `hook_output_contains`, with the same frames, matching and caveats. For a hook that **fails open** (exits 0 and says why on stderr), which `hook_event_fired` passes. **Never vacuous**: no frame for the event fails. It fails **evidence-unavailable** when a frame lacks the selected stream field (`stream: any` needs both), when a hook for the event started and never sent a response, when the agent truncated a frame's output, or when output it would pass on was rewritten by a redaction policy (on a redacted stream, a literal miss and any `matches` result are evidence-unavailable for either key, while a literal hit outside a token counts). The same event, needle and stream (or `stream: any` on this key) in both keys can never pass, so the run is refused and `lint` reports `assert-contradiction`. Content-class, grades on replay. Recorded end-to-end for `Stop` |
| `vm_path_denied: true` | **`fidelity: hostloop` only** — at least one recorded path denial (`RunResult.pathDenials`, any of the three sources) targeted a `/sessions` VM path; decision-level — replay-checkable only when the cassette carries `controlOut` (else skipped-and-surfaced, not a false-green); any other tier **FAILS** ("cannot verify"); **only `true` is valid** |
| `path_denied: {tool?, path_matches?, source?, agent_scope?}` | **`fidelity: hostloop` only** — a path denial matching **all** given matchers was recorded (`tool` glob, `path_matches` regex, `source` ∈ pretooluse/can_use_tool/permission_denied, `agent_scope` ∈ main/subagent/any — subagent means the binary's `agent_id` attribution is present); decision-level — needs `controlOut` on replay; any other tier **FAILS** ("cannot verify") |
| `no_path_denied: true` | **`fidelity: hostloop` only** — NO path denial was recorded at all (the channel is already path-scoped, unlike `no_hook_blocked`'s indiscriminate reject); decision-level — needs `controlOut` on replay; any other tier **FAILS** ("cannot verify"); **only `true` is valid** — **Mutually exclusive** with `path_denied` and `vm_path_denied` (same channel, opposite demands — refused by `run`/`skill`/`record`) |
| `max_peak_rss_bytes: <N>` | peak sampled RSS of the agent sandbox ≤ N bytes — **live lane only** (container/hostloop/microvm); evidence-unavailable on replay/protocol or when sampling captured no RSS |
| `semantic_matches: {rubric: [..], min_pass?, judge_model?, include_subagent_text?, include_fork_results?, evidence_files?: [..]}` | a pinned LLM judge grades each fixed `rubric` claim against the run's answer — the agent's final message, the transcript, and any files it authored — so a claim about written-file content grades like one about inlined prose. **What "the transcript" contains, exactly:** top-level `assistant_text` only. It **excludes every `tool_use`/`tool_result`**, and **excludes all sub-agent-originated text** (including fork-scoped `Skill`/`Agent(fork)` dispatches, which the tool-attribution path *does* treat as main-agent flow — the text path does not). **A `context: fork` skill's own answer is not graded by default**, even with `include_subagent_text: true`: it is not a dispatch (so it has no `subagents[]` entry to fold in), and it reaches the main agent as the `Skill` tool result, which the judged document excludes. **`include_fork_results: true`** grades it: every top-level `Skill` call is joined to its result by `toolUseId` (never by position; a top-level `Skill` result is captured up to 32,768 characters, every other tool result up to 10,240) and appended after any sub-agent sections as `## Fork skill result: <skill>` — or `## Skill result: <skill>` when the result lacks the agent's `completed (forked execution)` marker (an inline skill's result is only its launch line; the marker picks the heading, never whether the result is included). Each result is untrusted run text like a sub-agent's: scrubbed, then capped. The judge must see the WHOLE answer or none: a result cut at that 32,768-character capture cap (or by the aggregate document cap) fails evidence-unavailable with `fork_result_truncated`, a call with no paired result with `fork_result_unpaired`, a fork launched in the background (its result is only `Skill "X" launched (forked execution, running in the background)`, with no answer) with `fork_result_background`, and a result.json without `toolCalls`/`toolResults` with `fork_calls_unrecorded`; `paths` then lists the `Skill` calls' skill names. A fork invoked by a leading `/<skill>` prompt makes no `Skill` call, so there is nothing to join: no section is added, the fork's answer is already top-level transcript text, and a pass's evidence reads `graded Skill results: (none — no Skill call)`. Opt-in because a larger document can re-grade an existing rubric. Without it the judge sees the fork's answer only if the main agent restates it; `tool_result_matches` checks it structurally (see `subagent_output_contains`). ⚠️ **A rubric claim about whether a tool was called is therefore unassertable — that branch cannot grade true regardless of behaviour** (one exception: with `include_fork_results: true`, a `## Skill result: X` / `## Fork skill result: X` section lets the judge confirm that skill X ran, from its result). Use the structural keys (`tool_called`, `present_files_called`, `subagent_dispatched`, `hook_blocked`) for tool claims — and the object form `tool_called: {tool: <name>, input: {command: <regex>}}` for a claim about what a command actually ran. Sub-agent text lives in `RunResult.subagents[].reasoning` and reaches the judge only with `include_subagent_text: true` (opt-in; `kind:"text"` turns only, since sub-agent *thinking* arrives empty+redacted — see [subagents.md](./subagents.md)). Passes iff ≥ `min_pass` claims pass (default: all) — **live lane only** (an LLM judge call); skipped-loud on replay. Authored-file evidence is captured on every live sandbox tier including **microvm** (its session tree is snapshotted from the VM into the run dir) — but can be **incomplete** on any of them (a file dropped at the capture-size cap, or unreadable at read-back), and the incomplete case fails **evidence unavailable** rather than trusting a judge grade against a partial document. Every evidence-unavailable reason (below) is decided from the composed evidence before the judge is called, and for such an assert the judge is **not called**: it records no `semanticClaims`, `judgeModel`, `judgeCostUsd`, `judgeUsage`, `judgePromptHash`, `judgeTransport` or `judgedDoc` — only the refusal message and its `semanticEvidence` reason — so a refusal costs no judge spend and carries no per-claim grades a consumer could mistake for graded ones. `judge_model` pins the grading model (flag/env precedence: per-assertion `judge_model` > `COWORK_HARNESS_JUDGE_MODEL` env > the harness default, `claude-opus-4-8`) — pin it for a reproducible before/after comparison — or let [`eval`](./eval.md) compare two skill versions per claim, with the judge pinned. Each graded assert records `RunResult.assertions[].judgeModel` (the resolved model), `judgeCostUsd` (judge spend over both attempts, beside the agent's `cost.usd`, never inside it; absent when no call reported a cost) and `judgePromptHash` (the grading-prompt template; compare only runs that share it), `judgeTransport` (`{isolation, cliVersion?, strictMcp?}`: how the host `claude` was called — the isolation level of its flags, the CLI version, and `strictMcp: false` when the call left out `--strict-mcp-config` for an enterprise MCP config, so grades made under different conditions can be told apart; absent for a judge a library caller injects), `judgeAttempts` (how many calls the judge took: `1`, or `2` when its one retry after a malformed grade ran), plus `judgeUsage` (the judge's tokens, same basis as `judgeCostUsd`) and `judgedDoc` (`{sha256, sections: [{kind, path?, sha256, chars, redactions}]}`: a fingerprint of the exact document the judge received, after scrubbing and every cap — `kind` is `final`, `transcript`, `subagent`, `skill_result` (one `include_fork_results` section), `authored` (with `path`), `scratch_note` or `health`; sections are separated by one blank line and `chars` counts UTF-16 code units (`redactions` counts the `[REDACTED…` secret-scrub markers in the section; absent on a run recorded before it was counted), so walking the document by `chars + 2` recovers each one; a section the aggregate cap cut is hashed over what survived, and one wholly past the cut is not listed; it is recorded on an invalid grade too, and absent on an evidence-unavailable refusal, where no judge received a document). The `rubric` claims are scrubbed with the same secret set as the document before they are sent (a claim holding a secret reaches the judge as `[REDACTED]`, with one `::warning:: [semantic_matches]` naming the claim indexes; `judgePromptHash` is unaffected). **A claim that names a secret therefore cannot be graded for that secret** — the judge sees neither the value in the claim nor in the scrubbed document. Assert on it deterministically instead: `transcript_not_contains` or `artifact_text: {not_contains: [..]}`, which read the raw transcript and the raw file on the live run (replay and `verify-run` read the scrubbed record, where the value is already redacted). Per-claim grades are in `RunResult.assertions[].semanticClaims` (`[{index, claim, pass, rationale?}]`); `rationale` is the judge's one-sentence reason for that claim's grade, and a failed assert's footer prints it under each failed claim. It is untrusted model text that can quote the judged document (control characters collapsed to spaces, secrets scrubbed, then capped at 400 characters). Its content never affects `pass`, and it is absent when the judge gave none; a judge reply whose shape is broken (unparseable JSON, a malformed `{"results": …}` group beside a valid grade, or a partial restatement that contradicts it) is a malformed grade (retried once, then `judgeInvalid`); compare rationales only between runs that share `judgePromptHash`. **Scoping the evidence — `evidence_files`:** a list of globs naming the authored files this judge should grade. Without it, EVERY authored file is graded and ANY omission refuses the verdict — so a pipeline whose intermediates dwarf its deliverable (a `_work/` dir of scratch JSON) spends the capture budget before reaching the file the rubric is about, and can never pass. With it: only the named files reach the judge, the capture spends its budget on them FIRST and exempts them from the per-file cap, and only an in-scope omission/truncation refuses (an aggregate-document overflow that cuts the graded evidence also refuses, scoped or not). Paths are `<user-visible root>/<rel>` — `outputs/report.md`, **not** a bare `report.md`; session-root deliverables carry the synthetic `scratchpad/` prefix. Globs are `*`/`?`/`**` (not regex), matched over the full path. Globs matching NOTHING fail evidence-unavailable and the message lists every path the run authored, so the key shape is learnable from the failure; an empty list is a load-time error. It is **not** an existence assertion — use `file_exists` for that. Raise `$COWORK_HARNESS_AUTHORED_TOTAL_BYTES` when a legitimately large deliverable still does not fit. All of a scenario's `evidence_files` are unioned into ONE shared capture, so when two scoped asserts compete for the budget the winner is **walk order** (user-visible roots in order, then alphabetically within each, scratchpad last) — not assert order or glob specificity; the refusal names the starved file, not the one that consumed the budget, so read the whole scenario's scopes when a file you expected is missing. `RunResult.assertions[].semanticEvidence` carries the typed reason (`graded` | `scope_matched_nothing` | `in_scope_omitted` | `in_scope_truncated` | `evidence_incomplete` — the UNSCOPED counterpart of `in_scope_omitted`, and the one an unscoped scenario hits first | `authored_evidence_truncated` | `fork_result_truncated` | `fork_result_unpaired` | `fork_result_background` | `fork_calls_unrecorded`) plus the paths, so a consumer never scrapes the prose message. |
| `semantic_pairwise: {refs?: [..], rubric?: [..], pass_if?, order?, judge_model?, include_subagent_text?, include_fork_results?, evidence_files?: [..]}` | a pinned LLM judge compares this run's judged document with a **frozen reference** — the same document an earlier run (usually the baseline) produced, written once by `ref freeze` and never regenerated — and answers win, tie, loss or `both_bad`. **The judged document is the one `semantic_matches` builds** (final message + transcript + authored files, same `evidence_files` / `include_subagent_text` / `include_fork_results` options), so the transcript **excludes every `tool_use`/`tool_result`** and a criterion about whether a tool was called cannot be judged from it. `refs` are reference stores relative to the scenario file; the run is judged against every one, and `pass_if` (default `not_worse`) must hold against each: `win`, `not_worse` (win or tie), or `any` (graded at all — a metric only). `both_bad` fails `win` and `not_worse`. Which output the judge sees first is a seeded coin per run, assert and reference (`order: both` judges both orders: a win in one and a loss in the other is position bias and scores as a tie; any other disagreement keeps the worse outcome; each order's own outcome is recorded as `pairwise[].orders.candidate_first` / `.ref_first`, absent for a single-order grade, and a judge that favours whichever output it sees first shows across runs as `candidate_first` winning more often than `ref_first`). The judge never sees the words "reference" or "baseline". A reference must have been frozen with the same evidence options and for the same prompt; a missing, damaged, differently-scoped or other-prompt one **refuses the run before it spends anything**, as does a reference store inside any mounted source (the agent could read its own answer key). Unavailable evidence refuses with `semantic_matches`' typed reasons. Per-reference outcomes land in `assertions[].pairwise`; the judge's provenance (`judgeModel`, `judgeCostUsd`, `judgeUsage`, `judgePromptHash`, `judgeTransport`, `judgedDoc`, `judgeAttempts` — 1 plus every retry over all comparisons) is recorded as for `semantic_matches`, and `composedDoc` fingerprints the composed document even when no judge read it (every comparison neutral). **Under `hillclimb run`** the scenario's `refs:` is ignored: every pairwise assert is judged against the flow's own references (`<flow>/baseline/ref`, then each `<flow>/vN/ref` a `hillclimb freeze-ref` wrote), only the **baseline's** decides `pass_if`, and a later variant's is a metric recorded with `gate: false` — an unreadable one, or a judge reply that stayed invalid (`status: "invalid"`), blanks that comparison alone, never the verdict. The judge calls the host `claude` isolated and tool-less, so it needs Claude Code 2.1.197 or later there, checked before the run spends. **LIVE-ONLY** — skipped on replay. |
| `question_asked: <regex>` | the agent asked an AskUserQuestion whose **question text** matches (`question`, falling back to `header`). Text only — for the option set a gate offered, use `question_options` below ⚠️ **This text is model-composed and is reworded run to run** — pin a producer-authored constant, not model prose; if the wording may also move between the question and an option, use `question_context`. |
| `question_options: {when_question?, equals?: [..], contains?: [..], order?}` | the option SET (and by default the ORDER) a gate offered the user, **by label** — the half `question_asked` cannot reach (option *descriptions* are not compared here; use `question_context` for those): an agent that presents the right choices in the wrong order puts a different option in the default slot, and every artifact assertion still passes. `when_question` is a regex over the same label `question_asked` matches; omit it only when the run fired exactly one sub-question (more than one without a selector FAILS as ambiguous, rather than silently taking the first). Set exactly one of `equals` (the complete set) or `contains` (a subset); `order: exact` (the default) compares order too, `order: any` compares membership only. Evidence is captured when the gate is ASKED, so it covers a gate that was shown and then denied, stalled or left unanswered; a lane that cannot read it (a truncated cassette, a verify-run dir with no `events.jsonl`) fails **evidence-unavailable**, never vacuously ⚠️ **This text is model-composed and is reworded run to run** — pin a producer-authored constant, not model prose; if the wording may also move between the question and an option, use `question_context`. |
| `question_context: {when_question?, matches}` | a regex matched against **everything a gate put in front of the user**: the question label, every option **label**, and every option **description**. This is the key for "was the founder actually told X at the decision point?" when the skill's wording may land in any of those fields — `question_asked` sees only the question text and `question_options` compares only labels, so a sentence delivered inside an option's `description` is invisible to both. `when_question` narrows to matching sub-questions; **omitting it is not ambiguous here** (unlike `question_options`, which pins which gate offered which set — this key asks only whether the text was shown, so it searches every gate). Evidence is the **ask-time** `AskUserQuestion` payload, never a `tool_result`: a skill's producer script usually writes the same sentence into its own gate-state file, so a `tool_result_matches` on that phrase grades true whether or not the model ever surfaced it. Zero gates recorded **fails**; a lane that cannot read the payload fails **evidence-unavailable**, never vacuously ⚠️ **This text is model-composed and is reworded run to run** — pin a producer-authored constant, not model prose — this key already spans the question text, the option labels and their descriptions, so it is the drift-tolerant choice when the placement itself may move. |
| `question_option_count: {matches, exactly? \| min? \| max?, when_question?, case_sensitive?}` | counts the options whose **label** matches `matches` (a regex, case-insensitive unless `case_sensitive: true`), per sub-question, and requires the count to satisfy `exactly` (or `min`/`max`) on **every** selected sub-question — a rule over gates the model composes, such as "exactly one option per gate carries the reserved `No changes — ` prefix" (`{matches: '^No changes — ', exactly: 1}`) and "no prefixed option proposes a change" (`{matches: '^No changes — .*\b(add\|remove)\b', exactly: 0}`). `when_question` narrows to matching sub-questions; omitting it checks every one (no ambiguity: the rule is universal). A bundled `AskUserQuestion` with K sub-questions is K, as in `questions_count_max`; a sub-question with no options counts 0, and a duplicated label counts twice. Option **descriptions** are not searched (`question_context` covers them). Zero sub-questions asked, or none matching `when_question`, **fails** — so `exactly: 0` alone is satisfied by any unrelated gate: pair it with a positive rule or a `when_question`. Set `exactly`, or `min` and/or `max`; any other combination is refused at load. `case_sensitive: true` applies to the whole pattern, so keep a rule like the verb rule above case-insensitive (or spell `[Aa]dd`): case-sensitive, it misses `Add`. Single-quote the regexes: in a double-quoted YAML string `\b` is a backspace, which is refused at load. Each sub-question a gate asks counts, including one asked again after a denial. Evidence is the ask-time payload; a lane that cannot read it fails **evidence-unavailable**, and so does a count that a redaction-rewritten label or question could change (text that itself reads `[REDACTED…]` counts as rewritten) ⚠️ **This text is model-composed and is reworded run to run** — pin a producer-authored constant, not model prose |
| `questions_count_max: <N>` | at most N **sub-questions** asked — a bundled `AskUserQuestion` with K sub-questions counts as K, not 1 (this is a decision-load budget, not a per-tool-call count); `trace --view questions`'s footer total is computed the same way, so it always matches what this key compares against. **`: 0` is the way to declare a gate-clean scenario** — and is then **mutually exclusive** with `gate_answer_count_min: >= 1`, `question_asked` and `gate_answers_delivered: false` (a delivered gate records at least one question, so the pair can never both hold; `run`/`skill`/`record` refuse it before spending, and `lint` reports `assert-contradiction`) |
| `gate_answers_delivered: true` | every answered AskUserQuestion gate's answer actually reached the model — requires a positive, observed `tool_result` (an **unobserved** delivery fails too, not only an errored one — no silent false-green); **zero gates fired passes vacuously** (gate firing is model-dependent) — pair with `gate_answer_count_min: >= 1` to also require a gate, or, in a scenario that expects no gates, drop this key and declare `questions_count_max: 0` instead |
| `gate_answers_delivered: false` | asserts that at least one answered gate's answer was **confirmed not delivered** (an observed delivery failure); an unobserved/null delivery does **not** satisfy this — useful for negative-path tests of delivery failures. Requires a gate to have fired, so it is **mutually exclusive** with `questions_count_max: 0` (refused by `run`/`skill`/`record`) |
| `gate_answer_count_min: <N>` | at least N AskUserQuestion gates fired AND were delivered non-error — the presence companion to `gate_answers_delivered`'s vacuous-pass (mirrors `transcript_contains` pairing with `computer_links_resolve`). **`: 0` asserts nothing** — `delivered >= 0` always holds — so it does not satisfy that pairing; `>= 1` is then **mutually exclusive** with `questions_count_max: 0` (refused by `run`/`skill`/`record`) |
| `gates_all_scripted: true \| {include_permissions: true}` | every AskUserQuestion gate that fired was answered by a scripted rule (`answers:` / `--answer`) — not the LLM decider, `first`, or an external or human decider; a failure names each such gate and who answered it. A gate asked but never answered fails. **Evidence:** the run's decisions — a result with no decisions record, or an answer with no recognisable source, fails evidence-unavailable, never passes. On replay each gate is re-classified against the cassette's frozen `answers:`; that is evidence-unavailable when those answers were redacted, or when the cassette records that a live decider answered a gate yet its frozen rules cover every gate (they are not the rules it recorded with). **`{include_permissions: true}`** also checks tool permissions: a scripted `when_tool` rule or a fixed rule counts (a Read/Glob/Grep registry allow, a strict-parity deny, the harness's own path-gate deny, the fail-closed deny when nothing answered live — on replay that row means the recording held no answer, evidence-unavailable); a web_fetch deny that no answer source decided fails (`answered by abstain-fallback`), because real Cowork asks the user; cowork parity's permissive off-registry auto-allow never does, and a replayed web_fetch permission cannot be attributed (evidence-unavailable). Zero gates passes (nothing needed a person), so pair it with `gate_answer_count_min: >= 1` or `questions_count_max` to state whether gates were expected (`lint` warns `unpaired-gates-all-scripted`). |
| `allow_permissive_auto_allow: true` | verdict modifier — suppresses the default-fail when the run recorded a cowork-parity permissive auto-allow; use this for tests that **deliberately** assert Cowork's permissive behavior rather than strict scripted coverage |
| `allow_missing_capability: true` | verdict modifier (**live tiers only**) — suppresses the default-fail when the lean/`core` agent image omits a capability the skill used but real Cowork ships (OCR/LibreOffice/markitdown/opencv/PDF-tables); assert only when the skill's fallback is genuinely equivalent, else rebuild full parity (`--build-arg COWORK_FULL_PARITY=1`). Also opts out of the `requires_capabilities` declared-need check below. On `replay` the modifier is a no-op pass — there's no live tier to probe, so it neither suppresses nor triggers anything there. |
| `allow_l0_host_config_contamination: true` | verdict modifier — opts into L0/protocol plugin divergence, suppressing the plugin-fidelity default-fail |
| `allow_stall: true` | verdict modifier — suppresses the default-fail when a run ends on a question or a closing request for input (the closing sentence ends in `?`, or, once an `AskUserQuestion` gate has fired, is a request whose input comes back to the agent, such as "Please share X so I can…" / "Once you upload it, I'll…"; English-only — the full list is in the companion skill's `references/gotchas.md`, gotcha 13) having done no productive tool work after its last gate (the agent asked for input and stopped — incl. re-asking in plain text *after* answering an `AskUserQuestion`); assert only when ending on a question is the intended terminal state, otherwise script the answer (`answer:` / `--answer` / a decider) |
| `allow_undelivered_deliverables: true` | verdict modifier — suppresses the `undelivered_deliverables` WARN. Working in the scratchpad is Cowork's designed pattern, so a skill that legitimately leaves intermediates, caches or downloaded inputs behind can say so instead of carrying permanent noise. The signal is warn-only and never fails a run on its own; reach for this when the scratch activity is intentional, not to silence a real delivery gap. Also suppresses the sibling `delivery_unobservable` WARN on `lane: remote` (where delivery can't be measured at all — no remote delivery tool is modeled); on that lane the key means "I know delivery is unverifiable here and accept it", **not** "the files were delivered" |
| `allow_outputs_delete: true` | verdict modifier — accepts a detected outputs delete instead of failing the run, for a skill whose deletion is intended. It has an effect only on a baseline that records outputs as `rw` (Desktop before 2.16120.0), where omitting `no_delete_in_outputs` does **not** permit deletes: a detected delete fails via the `outputs_delete` signal *because* the key was not authored. On an `rwd` baseline (including `latest`) an outputs delete does not fail by default, so the key is accepted and does nothing, with no warning, unless `no_delete_in_mounts` arms the outputs check, where it waives that check's signal as on `rw`; keep it if the scenario also runs on an older baseline. **Mutually exclusive** with `no_delete_in_outputs` (asserting both is rejected at load). It silences `outputs_delete`, `outputs_delete_unconfirmed` and `outputs_diff_unavailable`. This WAIVES the harness's post-hoc detection — it does not model Cowork's `allow_cowork_file_delete` approval handshake, so a skill that would catch a real `EPERM` and escalate still behaves differently here |
| `allow_delete_in: [<mount>…]` | verdict modifier — accepts detected deletes in the named mounts, the per-mount analogue of `allow_outputs_delete` and the modelled counterpart of production's per-mount `fileDeleteApprovedMounts`. Suppresses the `mount_delete` WARN for those mounts and waives them for `no_delete_in_mounts`. **Waives the verdict only** — detection still runs and the hits stay in `result.json` for forensics, exactly as `allow_outputs_delete` behaves. Listing `"outputs"` alongside `no_delete_in_outputs` is rejected at load |
| `transcript_no_host_path: true` | no host path (a path under a host home or system root: `Users`, `home`, `root`, the Cowork install dir `opt/cowork`, and the macOS `private/var`, `private/tmp`, `var/folders` and `Volumes` roots, each written here without its leading slash — also inside a `file://` or `computer://` link) leaked into model-visible text (a path that came verbatim from the scenario's own input files, prompt, or declared plugins' or local skills' files is not a leak — see `host_path_leak` below) — **incompatible with `hostloop` AND `protocol`**: hostloop's native file tools legitimately expose real host paths (that's the tier's whole point), and protocol (L0) runs the agent's file tools on the real host cwd with no sealed filesystem, so this assertion fails BY DESIGN at both (the harness warns loud at run start if you assert it anyway); use `container`/`microvm` for this check |
| `egress_denied: <host>` | the host was blocked by the egress proxy |
| `egress_allowed: <host>` | the host was allowed through |
| `artifact_json: {…}` | assert over a JSON artifact's contents — see below. `artifact` may be a glob with `match: each\|any` (one check over many files). Both `artifact_*` keys take `authored: true\|false` with the `file_exists` meaning |
| `computer_links_resolve: true` | every `computer://` link in the model-visible transcript resolves to an artifact that exists in the run's collected outputs/mounts (a dangling link fails, naming which target was checked — host path, work tree, or replay manifest); **requires ≥1 link** (zero links fails — use `computer_links_resolve_if_present` for the presence-free variant) — **only `true` is valid**, writing `false` is rejected by the schema **Sees top-level `assistant_text` only — it excludes every `tool_use`/`tool_result`**, so a `computer://` link that appeared only inside a tool call or its result is invisible to it. |
| `computer_links_resolve_if_present: true` | like `computer_links_resolve` but passes vacuously when the transcript has zero `computer://` links — the presence-free variant; **only `true` is valid** **Sees top-level `assistant_text` only — it excludes every `tool_use`/`tool_result`**, so a `computer://` link that appeared only inside a tool call or its result is invisible to it. |

`expect_denied: [host, …]` is shorthand that adds an `egress_denied` assertion per host.

> **Authoring `subagent_*` assertions.** `subagent_tool_used`/`subagent_tool_absent`/`subagent_dispatched`
> and the type-less-dispatch trap they guard against are covered in full in
> [subagents.md](./subagents.md): the tool-composition rules that decide what a dispatched child can
> reach, and the caveat that `subagent_tool_absent` proves only "no matching *attempt*," not capability
> absence — plus the case-sensitive glob gap between host-loop's `mcp__workspace__*` and the VM tiers'
> literal `Bash` that a cross-tier "shell-free" policy needs to cover explicitly.

### Declaring required capabilities (`requires_capabilities`)

A scenario-level `requires_capabilities: [<family>, …]` declares the capability families the skill's core
path **needs** (e.g. `office_convert`, `ocr`, `pdf_tables`, `ml_extract`, `cv`, `magick`). The run
**hard-fails** if the running tier:

- **omits** a declared family (the lean `core` image lacks it), or
- **cannot verify** it — `protocol` or `COWORK_SKIP_CAPABILITY_PROBE=1`, where no live probe runs. (Not
  `replay`: it re-drives and resets the outcome, so the check neither fires nor suppresses there — as the
  paragraph below says.)

This closes the false-green for extraction-heavy skills: a PDF/Excel-ingestion skill that silently fell back
to manual parsing on a tier without the deps now fails loudly instead of passing. Unlike the *use*-detection
fail (which catches an omitted family the skill was observed using), this is a *declared-need* check, so it
fires even when the skill's fallback masks the gap. The check is computed at run time and persisted;
`verify-run` reads the persisted outcome and honors it, while `replay` re-drives and does not re-surface it —
a clean full-parity run records nothing here either way. Opt out with `allow_missing_capability: true` when
the fallback is genuinely equivalent.

When `requires_capabilities` is declared, the harness probes the image **before** driving and, if a declared
family is omitted, **fails fast — it aborts the run (exit 3) before spending a single token**, instead of
running ~12 min to a post-run hard-fail that's already known. Rebuild full parity
(`--build-arg COWORK_FULL_PARITY=1`) and point `COWORK_AGENT_IMAGE` at it, or assert
`allow_missing_capability: true` (which downgrades the abort to a notice and proceeds, same as it opts out of
the post-run check).

```yaml
requires_capabilities: [office_convert, pdf_tables]   # fail unless the tier provides (and can verify) these
```

Run **`cowork-harness assertions --list`** for the authoritative *assertion* set from the live schema (it
can't drift) — that list covers `assert:` keys only, so the scenario *fields* that also appear above
(`expect_denied`, `requires_capabilities`) are not in it.

`replay_protocol_fidelity` is replay-synthesized and **not** authorable in a scenario — writing it
errors at load. See [docs/cassette.md](./cassette.md) for the O7 guard.

#### Verdict signals

Beyond pass/fail assertions, a run can surface **verdict signals** in `result.verdict.signals`. There
are twenty-four codes. Eleven are **fail**-severity — they flip the run's pass/exit code even though
`result.result` itself stays `"success"`, so `assert result: success` alone won't catch them; check
`result.verdict.signals[].severity` or the run's exit code instead.
Only thirteen codes are **warn**-severity (informational, never flip pass/fail):

- `outputs_delete_unconfirmed` (**warn**, live lane) — a delete-shaped command near `mnt/outputs` that
  nothing confirms: no output present at turn start was deleted, and no flagged delete has an outputs path as
  its own operand — the flag rests on the detector's inference (an unprovable target, a relative `cd` into
  outputs, or an outputs path that only shares a statement with a Python variable named `rm`). A file created *and* deleted within the turn is
  invisible to the filesystem diff, so this can still be a real delete (in a loop, after a `cd`, through a
  chained or computed variable): read the command. `allow_outputs_delete` waives it. Not raised on a baseline
  recording outputs as `rwd` unless `no_delete_in_outputs` or `no_delete_in_mounts` (outputs not waived) is authored.
- `outputs_diff_unavailable` (**warn**, live lane) — the per-turn filesystem diff of `outputs/` could not
  verify this turn (no or incomplete turn-start snapshot, or an incomplete post-run walk), and the text
  scan flagged nothing. A delete made without a bash command (a script file, another tool) would have gone
  undetected. A text hit on such a turn fails as `outputs_delete` instead. Like the previous code, not raised on
  an `rwd` baseline unless `no_delete_in_outputs` or `no_delete_in_mounts` (outputs not waived) is authored.
- `non_deterministic` (**warn**) — the run was LLM/external/human-decided, not reproducible.
- `model_fallback` (**warn**) — the agent switched off the requested model mid-run, reported from the
  SDK's own `model_fallback` event (so the trigger is the agent's word, not an inference). A
  `model_not_found` / `model_blocked` / `permission_denied` trigger is a property of the pin — every run
  of the scenario falls back the same way until the pinned id changes; `overloaded` / `server_error` is
  transient. Warns rather than fails: the run happened and its assertions still mean something, but the
  model that produced it is not the one the scenario names.
- `prompt_asset_missing` (**warn**) — the run proceeded with a missing prompt asset (e.g.
  `COWORK_HARNESS_ALLOW_MISSING_PROMPT=1`); fidelity is degraded (the agent ran, but not against the full
  faithful prompt surface).
- `scan_unavailable` (**warn**) — post-run scan evidence unavailable (`RunResult.scan` undefined); the
  host-path guard and the text scan of the outputs-delete guard did not run this run — the outputs
  filesystem diff still ran, and a delete it proves still fails as `outputs_delete` wherever the outputs check is
  armed (a baseline recording outputs `rw`, or `no_delete_in_outputs` / `no_delete_in_mounts` authored) (assert
  `no_delete_in_outputs` / `transcript_no_host_path` to hard-fail on this instead).
- `mount_delete` (**warn**) — a delete touched a delete-denied mount other than `outputs` (a `rw`
  connected folder). Production denies `unlink`/`rmdir` on **every** Cowork FUSE mount until per-mount
  approval, so the run diverged from what production would have permitted. Warns rather than fails
  because the harness detects post-hoc what production enforces — the agent already proceeded where it
  would have hit `EPERM`. Assert `no_delete_in_mounts: true` to hard-fail on it, or
  `allow_delete_in: ["<mount>"]` to waive that mount.
- `exec_infra_error` (**warn**, host-loop) — one or more container `exec` calls failed for infrastructure
  reasons (daemon/container-level), so those tool calls returned an error to the agent. The run's other
  evidence is intact, which is why this warns rather than fails — unlike a `hostloop-sidecar` /
  `egress-sidecar` crash, which is fail-severity `infra_error` because a dead supervisor contaminates the
  whole run. Note the residual gap: if *every* exec failed, the agent ran nothing and this still only
  warns — inspect `result.infraErrors` when a run looks suspiciously empty.
- `ended_with_question` (**warn**, live lane) — the agent's final answer contains a question (or closes on
  a request for input, the same test `stalled` uses) and the run wrote no deliverable to `outputs/` — a
  likely dead-end that still exited `result:"success"`. The lenient sibling of the strict, fail-severity
  `stalled` (which catches a final turn that ends on a question or, after an `AskUserQuestion` gate, a closing
  request for input, with no post-gate tool work); this covers the residual (mid-message `?`, or tool work after the last gate that
  still ended asking). Heuristic — read the final message before acting; a question-posing answer that
  wrote a file never fires. Fix by scripting/steering the answer; assert `allow_stall: true` if intended.
- `undelivered_deliverables` (**warn**) — the skill produced file(s) outside every user-visible root and
  never delivered them. On a **remote** Cowork session the workspace is reclaimed at session end, so those
  files are destroyed; on a **local** one they persist but stay invisible to the user, since the scratchpad
  is not a surface they see. Either way the user does not get them. This fires without any assertion being
  written, which is the point: `present_files_called` covers the positive case only when an author thought
  to ask for it, and the runs that most need this are the ones where nobody did. It is **silent when the
  evidence cannot answer the question** — no workspace walk (`workspaceFiles` absent), or a tier that runs
  no scratchpad walk, absent delivery telemetry, or a resumed turn (the scratchpad still holds files
  delivered on an earlier turn, since `present_files` copies rather than moves) — because "cannot tell"
  must never read as "clean". **The fix is lane-dependent:** on `lane: local`, write deliverables under
  `outputs/` (or a connected folder), or deliver them explicitly. **On `lane: remote`, moving a file
  under `outputs/` does NOT clear this signal** — nothing is delivered by location there, so only an
  explicit delivery counts. Opt out with `allow_undelivered_deliverables: true` when the leftovers are
  intentional.
- `partly_scripted_gate` (**warn**) — a question batch your `answers:` matched only part of (see "Batched
  gates are answered atomically" above). The whole batch went to the `on_unanswered` fallback, so the
  matched answers were not delivered and the fallback may have contradicted them. The message names the
  matched and unmatched sub-questions and who answered the batch; `result.partlyScriptedGates` carries
  `{requestId, matched, unmatched}` per batch. Never fires on a single-question gate no rule matched (that
  is the ordinary unanswered case). `replay` re-derives it from the cassette's frozen `answers:`, and
  `verify-run` from the scenario you pass: `verify-run` clears once every sub-question is scripted, a replay
  once the run is re-recorded with them scripted. On a replay the message names the recorded answer, not who
  gave it live.
- `parked_at_question` (**warn**) — a run whose session declares `answer_channel: none` ended on a question
  nobody can answer: its last message ends in `?`, whether or not tools ran before it. With no answer channel,
  stopping at the question is the contract the run models, so it takes the place of the `stalled` fail and never
  changes the verdict. A finished answer ending on an offer warns too, and a request without a `?` does not; completion is judged from the file assertions such a scenario must
  carry (see [headless-no-answer.md](./headless-no-answer.md)).
- `delivery_unobservable` (**warn**, `lane: remote`) — the run produced file(s) whose delivery could not
  be assessed at all, because the harness serves no delivery tool on that lane (see
  [fidelity-gaps.md](./fidelity-gaps.md), "File delivery"). This is the honest "cannot verify" companion
  to `undelivered_deliverables`: rather than reporting every remote file as undelivered (which the
  evidence cannot support) or staying silent (which would read as clean), the run says the question was
  unanswerable. It is mutually exclusive with `undelivered_deliverables` by construction, and stays quiet
  on a run that produced nothing to deliver.

See the skill reference [`assertion-catalog.md`](../.claude/skills/cowork-harness/references/assertion-catalog.md) for the full signal list.

##### False negatives — signals that are tier/image artifacts, not skill defects

Several fail-severity signals read like a skill gap but are really a property of the reduced test image
or the fidelity tier. Recognize these before "fixing" a non-bug:

- **`missing_capability`** — the lean `core` agent image is a deliberate partial mirror of real Cowork's
  rootfs. A skill that used a capability the `core` image omits (but real Cowork **ships** — per the
  rootfs manifest captured at Desktop `2.9939.2`, `baselines/provisioning/rootfs-provisioning.json`,
  the dated evidence behind that claim; 6 baselines have shipped since without a re-capture; a manifest that lags the newest baseline says so here) trips this;
  the message says so ("likely a FALSE NEGATIVE (real Cowork ships them)"). **Fix:** rebuild full parity
  (`--build-arg COWORK_FULL_PARITY=1`, point `COWORK_AGENT_IMAGE` at the result), or assert
  `allow_missing_capability: true` when the skill's fallback is genuinely equivalent — **on an open-ended
  `skill` run** (no `assert:` block), the CLI equivalent is **`skill --allow-missing-capability`**. Two
  sources feed it: a skill *observed using* an omitted family (live lane), or a declared
  `requires_capabilities` the tier can't verify/provide (both lanes — an **unknown** family name hard-fails
  rather than passing silently). The parity-gated families and how a false negative shows up:

  <!-- capability-families:begin (guarded against CAPABILITY_FAMILIES by test/capability-families-doc-sync.test.ts) -->

  | Family | Probe tool (present in full parity) | A false negative looks like |
  |---|---|---|
  | `office_convert` | `soffice` (LibreOffice) | doc/xlsx→pdf conversion "not found" on `core` |
  | `ocr` | `tesseract` | scanned-PDF/image text extraction unavailable |
  | `ml_extract` | `markitdown` / `magika` / `onnxruntime` | rich document→markdown extraction missing |
  | `cv` | `cv2` (OpenCV) | `import cv2` / `libGL.so` failure |
  | `pdf_tables` | `camelot` / `tabula` | PDF table extraction module absent |
  | `magick` | `wand` (ImageMagick) | image transform `MagickWand` not present |

  <!-- capability-families:end -->

- **`host_path_leak`** — **skipped at `hostloop` and `protocol`** fidelity (the agent runs on real host
  paths there, so a host path in model-visible text is expected, not a leak). It is *armed* at
  `container`/`microvm` but only *fires* on an actual scanned leak with no authored
  `transcript_no_host_path`. At `fidelity: cowork` the skip follows the **resolved** tier — a `cowork`
  run that lands on `container` is armed. Author `transcript_no_host_path` to enforce cleanliness where
  it is valid (the assertion is incompatible-by-design with `hostloop`/`protocol`).
  A host path the **user supplied** is not a leak (at `container`/`microvm`): before the agent runs, the
  staged uploads and connected folders (and each turn's prompt) are scanned for host paths, and a path the
  agent later shows **verbatim** is exempt, so quoting a kept run's `result.json` or a log you connected
  does not fail the run. The staged copy of every declared plugin (`local_plugins`, `remote_plugins`,
  marketplace plugins) and of every `skills.local` skill is scanned the same way, so a skill whose own
  reference file lists host-shaped literals does not fail when the agent reads it. A plugin's or skill's own
  files never exempt a path at or under its host source location (compared by path segment): the agent sees
  it only under `/sessions/…`, so that path showing up is a leak. A path your uploads, folders or prompt name
  stays exempt as before, wherever it points. A path token ends at whitespace, a quote, a backtick, `,`, `;`, `)`, `]`, `<`, `>` or a
  backslash, and the match is by whole token: a sub-path of an input path, a different spelling (`/var/…`
  vs `/private/var/…`), or a path followed by a sentence-final `.` still counts. A token cut short where
  the path goes on — whitespace, `,` or `;` followed by more path (`/Users/a/My Documents/x`,
  `/Users/a/proj,old/x`) — is never exempt, since an unrelated input can carry the same truncated prefix.
  After whitespace, a run that itself starts a new path (`/…`) or a URL (`scheme://…`) is the next item,
  not a continuation, so `cp /Users/a/x /Users/a/y` or one path per line is judged path by path.
  The exemption never covers a location the harness created for this run — the run dir, the microvm
  session dir, the staged agent versions' dir, and the vm-work root, the runs root and the run's scenario dir themselves — nor a
  truncated spelling of one. It is captured on the first turn only, so a path the agent writes into a
  connected folder is not exempt on a later turn. Files over 2 MiB, binary files, `.git/` and
  `node_modules/` are not scanned (past 5,000 files or 64 MiB the rest are skipped too, with a notice) —
  their paths still count; plugin and skill files are scanned after the inputs, so they never use up the inputs' share. A result that relied on the exemption carries `scan.hostPathsFromInputs` (and
  `scan.inputHostPathTokens`, the corpus size) and prints a `::notice::`; the paths themselves are never
  written to `result.json`. The same rule applies to `transcript_no_host_path`.

- **`scan_unavailable`** (**warn**, live lane only) — `events.jsonl` was missing/corrupt, so
  `RunResult.scan` is undefined and the host-path guard and the outputs-delete **text scan did not run**
  (the outputs filesystem diff still did). Neither a pass
  nor a defect — assert `no_delete_in_outputs` / `transcript_no_host_path` to hard-fail on it.

#### `artifact_json` — assert structured JSON in YAML

For a skill that emits structured JSON, assert its contents in the scenario lane (no Python needed). A
dotted `path` selects into the document; one operator decides the check:
```yaml
- artifact_json: { artifact: outputs/cap_state.json, path: me.run_id, equals: "r1" }
- artifact_json: { artifact: outputs/cap_state.json, path: rounds.0.amount, gt: 0 }
- artifact_json: { artifact: outputs/instruments.json, path: exclusivity_days, absent: true }   # anti-hallucination
- artifact_json: { artifact: outputs/cap_state.json, path: stage, in: ["seed", "series-a"] }     # one of a stable set
```
Operators: `equals` (deep-equal) · `in: [<set>]` (deep-equal one of) · `gt` (number) · `exists: <bool>` · `absent: <bool>` · `is_null: <bool>`. **Omit every operator** to assert only that the `path` resolves (a bare existence check).
The three states are **distinct**: `absent` (the final key is missing from a parent that resolved) vs
`is_null` (present but JSON `null`) vs an **unresolved intermediate** segment (the artifact is malformed for
that path) — which **fails loud**, never a vacuous pass. (No JSONPath/jq — a dotted path keeps it
dependency-free and side-effect-free.)

**One check over many files: a glob `artifact`.** When the skill writes one JSON file per run or per item, put a
glob in `artifact` and say how the matches combine with `match:`, which is required with a glob and refused
without one:
```yaml
- artifact_json: { artifact: outputs/artifacts/runs/*/run_status.json, match: each, path: status, equals: "complete" }
- artifact_json: { artifact: outputs/reports/**/summary.json, match: any, path: verdict, in: ["pass", "warn"] }
```
- `match: each` passes when **every** matched file satisfies the check; `match: any` when **at least one** does.
- The glob syntax is the one `no_unexpected_files` uses: `*` and `?` within a path segment, and `**` as a whole
  segment for any depth. `[` is a literal character. Names match exactly as the filesystem spells them, with no
  case or Unicode folding.
- The glob covers the **user-visible roots** only (`outputs/` and the connected folders), the set a cassette
  records, so a live run and its `replay` see the same files. A file anywhere else never matches, and **uploaded
  inputs are not matched** (a cassette holds them hash-only). A glob that can reach no user-visible root, one
  starting with `uploads/` for example, fails and says why.
- **Zero matches fail.** The message names the glob and lists what the nearest existing directory holds, since the
  usual cause is a misspelled name.
- **Evidence-unavailable** (a fail) when:
  - more than 200 files match;
  - the walk can't see the whole tree (more than 32 levels below the glob's fixed leading part, over 20,000 entries,
    or an unreadable or escaping subtree, including an unreadable directory on that fixed part);
  - a match is a **symlink or hardlink**, a directory on the glob's literal path is a symlink, or a symlinked
    directory sits where a match could be (a linked run directory under `runs/*`). A literal `artifact` follows an
    in-root symlink on a live run, but a glob refuses links on both lanes, because a cassette records the link,
    not what it points to;
  - a match has no readable body (over the body cap, unreadable, or a read-only input).
  Under `each`, a match that plainly fails decides the verdict whatever else is unknown. Under `any`, one passing
  match decides it.
- The failure message lists the matched files that passed, failed and couldn't be evaluated.
- `authored: true` applies to each matched file.
- At `record`, a match stored hash-only because it is over the body cap is refused like a literal one: it would
  pass the live run and fail `replay`. So is a recording whose artifact walk couldn't see the whole tree, since
  the cassette would hold only what was seen. Under `--allow-failing` both are warnings.
- A glob ends with a file pattern: one ending in `/` is a load error.

> **`is_null: false` requires the path to be present.** If the path is absent, `is_null: false` fails loud
> (rather than vacuously passing). To assert "exists and is not null" write `exists: true` on one line and
> `is_null: false` on another. Use `absent: true` to assert the key does not exist at all.

> **Stable vs brittle asserts on stochastic (LLM-extracted) values.** A cassette freezes ONE stochastic
> output, so an `equals` on an LLM-extracted string will churn every time you re-record. Prefer **stable**
> operators for extracted values: `absent` / `exists` (the anti-hallucination negative is rock-stable),
> or `in: [<set>]` to accept any of a known-good set. Reserve `equals` for values the skill computes
> deterministically (ids, counts, enums). This pairs with record-time redaction: redaction rewrites the
> very strings an `equals` would pin, so `equals` on a redacted field would break on re-record anyway.

> **Boundary assertions** (`egress_*`, `expect_denied`) require a sandboxed fidelity — `container`, `microvm`, `hostloop`, or `cowork`. `container`'s and `hostloop`'s `bash` share the same Docker sandbox + egress proxy (though `hostloop`'s native file tools run with no container at all — see [boundary.md](./boundary.md)); `microvm` enforces the **same allowlist** inside a real Lima/Apple-VZ VM via a guest iptables firewall; `cowork` resolves to `hostloop` or `container`. Only `protocol` is rejected, to avoid a false pass — see [boundary.md](./boundary.md).

### Which assertions survive `replay` (CI placement)

A cassette (`record`/`replay`) has no filesystem or network. `replay` consumes BOTH recorded protocol
directions — the child→driver `events` stream and the driver→child `controlOut` decision responses —
and re-evaluates the **content** assertions. The authoritative list of content keys is the union of
`ALWAYS_CONTENT_KEYS`, `QUESTION_GATE_KEYS` (only when the cassette carries `controlOut`), and
`MANIFEST_KEYS` (only when it carries an artifacts manifest) — all exported from `src/run/cassette.ts`,
alongside the explicit exclusion list `LIVE_ONLY_KEYS`; the table below is derived from them.

> **This is a different question from "does my YAML edit take effect."** This section answers whether a key
> *can be evaluated on replay at all* (content-class vs live-only). It does **not** mean an edit to that key in
> `scenarios/<name>.yaml` reaches a default replay — a default replay reads the **frozen** copy regardless of
> class. Content-class ⇒ *evaluable* on replay, **not** *your edit runs*. Which copy is used is the separate
> frozen-by-default rule: see [What `replay` evaluates](#what-replay-evaluates--the-whole-scenario-frozen).

**Evaluated on replay (content assertions):**
`transcript_*` (incl. `transcript_matches`), `tool_*` (incl. `tool_available`), `subagent_*`, `dispatch_count_max`,
`skill_triggered`, `no_skill_triggered`, `reference_read`, `no_observed_reference_access`,
`max_cost_usd`, `max_tokens`, `tool_calls_max`, `max_turns`,
`max_tool_errors`, `max_redundant_tool_calls`, `skill_available`, `connector_available`,
`skill_tool_used`, `compaction_occurred`, `hook_event_fired`, `hook_event_blocked`, `no_hook_event_blocked`, `hook_decision`, `hook_output_contains`, `hook_output_not_contains`, `all_tasks_completed`, `task_count_min`, `task_status`, `no_scratchpad_leak`,
`present_files_called`, `no_vm_path_file_op`,
`result`, and the verdict modifiers `allow_permissive_auto_allow` / `allow_missing_capability` /
`allow_l0_host_config_contamination` / `allow_stall` / `allow_undelivered_deliverables` / `allow_outputs_delete` / `allow_delete_in` (kept on replay as no-op passes). `max_cost_usd`/`max_tokens`
assert the *frozen recording's* spend on replay, not fresh spend — see their table entries above.

**`question_asked`, `question_options`, `question_context`, `question_option_count`, `questions_count_max`, `gate_answers_delivered`,
`gate_answer_count_min`, and `gates_all_scripted`** are also content assertions, plus the hook-blocked keys `hook_blocked` and `no_hook_blocked`, and the
path-denial keys `vm_path_denied`, `path_denied`, and `no_path_denied` — all of
which require the cassette to carry `controlOut` (full-fidelity replay). When
`controlOut` is present, the decision pipeline runs on replay and populates `rec.questions` /
`rec.gateDeliveries` — so these keys are genuinely evaluated.
When `controlOut` is absent (old cassette), a **loud warning** fires and these keys are **excluded**
from evaluation (not vacuously passed). Re-record with a current harness to enable them.

**Filesystem assertions** (`file_exists`, `artifact_text`, `user_visible_artifact`, `artifact_json`, `computer_links_resolve`,
`computer_links_resolve_if_present`, `no_unexpected_files`, `input_unmodified`)
run on `replay` **when the cassette carries an artifact manifest** — `record` snapshots `outputs/` + connected
folders (paths + hashes + small JSON bodies) into the cassette, and `replay` materializes that snapshot to
evaluate them token-free. `artifact_json` needs the JSON body inlined (small files), and `artifact_text` needs
the body it matches against the same way; a hash-only (oversized) entry still satisfies `file_exists` but
neither of those two. `computer_links_resolve` resolves BOTH
`/sessions/…/mnt/…`-shaped links and host-shaped (hostloop) links against the manifest — a host-shaped link
normalizes to a mount-relative path first (via the recorded connected-folder prefixes + the outputs/uploads
mounts), since replay has no live filesystem to probe directly (that direct check only happens on a live
`run`/`verify-run`). Without a manifest (older cassettes), every one of these is **skipped** (loud).
`no_unexpected_files` and `input_unmodified` additionally need the pre-run path/hash capture (`preRunPaths` /
`preRunHashes`), and are excluded with a loud warning when it is missing, even if a manifest is present.

A `mode: r` connected folder (see [session.md](./session.md)) holds pre-existing INPUTS, not deliverables —
`record` captures its contents **body-less** (path + hash, `truncated: true`, no `body`): `file_exists` and
`computer_links_resolve` still pass against it (the placeholder materializes on replay), while `artifact_json`
or `artifact_text` against it reports a clear evidence-unavailable identically on live, verify-run, and replay (so a cassette
can't record green and replay red). This keeps a read-only input out of the cassette's committed content
(no bloat, no `binary` privacy finding) while `no_unexpected_files`/`computer_links_resolve` keep enumerating
the folder as a user-visible root. A `mode: rw`/`rwd` folder's contents are captured with a full body, same
as `outputs/`.
A green `replay` re-confirms *record-time* artifacts, **not** that the current skill still produces them —
that needs a live `run` (the cassette's staleness fingerprint warns when the skill/baseline/prompt-assets
drifted — `baseline`, `skill`/`shared-root`, `format`, `resolved-tier`, `prompt-assets`, plus the
`unverifiable-*` can't-verify variants of each (`unverifiable-skill` FAILS a bare replay since 2.0.0); `replay --strict` fails on any drift, `--fail-on-skill-drift`
on skill-source drift only, and every result reports it in `staleness[]` for a JSON gate). `prompt-assets`
covers a committed prompt-asset FILE (`spawn.promptTemplate`/`subagentAppend`/`subagentAppendHostLoop`),
or the sub-agent prompt text the harness generates rather than reads from an asset (the host-loop folder
manifest and trailing sentence, Desktop >=1.46388.3), edited under the same `appVersion` — a change `baseline`/`skill` drift alone would miss, since prompt
identity keyed on `appVersion` alone cannot see it.

**Egress + other filesystem** assertions (`file_absent`, `no_delete_in_outputs`, `no_delete_in_mounts`, `self_heal_ran`,
`transcript_no_host_path`, `egress_*`/`expect_denied`, `no_mcp_error`, `max_peak_rss_bytes`,
`semantic_matches`, `semantic_pairwise`, `no_lost_write_back`) are still **skipped** on `replay` — they only run on a live `run`/`record`
(token + Docker).

Two consequences for CI:
- Put the **always-on PR gate** on `replay` (token-free) and rely on `transcript_matches`/`transcript_*` +
  `subagent_*` + `question_asked`/`gate_answers_delivered` (with `controlOut`) for content/structure; put
  **filesystem/egress** checks in a **nightly/pre-release live job**.
  A `replay`-based PR gate verifies artifact *content* only when the cassette carries an artifact
  manifest (small inlined bodies, via `artifact_json` or `artifact_text`); without one it can't read the file,
  and oversized/hash-only entries satisfy `file_exists` but neither of those two.
- On `replay`, skipped assertions are **absent** from `results[].assertions[]` (filtered before evaluation),
  not present-and-passing — so a CI script must not assume a fixed assertion count across the two lanes.

<a id="where-replay-reads-assert-from--frozen-by-default-on-disk-by-opt-in"></a>

#### What `replay` evaluates — the whole scenario, frozen

<!-- The anchor alias above preserves this section's pre-1.15.0 slug, when it was titled "Where `replay`
     reads `assert:` from". Shipped CHANGELOG entries and any external link still point at it, and neither
     can be rewritten — the CHANGELOG because shipped sections are immutable, external links because they
     are not ours. Do not remove it. New links should use the heading's own slug. -->


**A cassette freezes the entire scenario, not just its `assert:` block.** `name`, `prompt`, `session`,
`baseline`, `fidelity`, `execution`, `lane`, `timeout_ms`, `answers`, `on_unanswered`, `expect_denied`,
`assert`, `skills`, `requires_capabilities`, `allow_host_writes`, `allow_host_hooks`, `workspace_fixture` and `metrics` — every field the schema defines — are
all captured at `record` time, and a plain `replay` evaluates **every one
of them from that frozen copy**. Nothing you edit in the working tree can change a plain replay's verdict.

The on-disk sibling YAML *is* opened — but only to print non-verdict-affecting `::notice::` lines when it
has drifted (a different `assert:`, a different `prompt:`, or a file that fails to load at all). Those
notices exist to kill the silent trap; they never move a result.

`--assert-from`/`--reassert` opt **only `assert:` (+`expect_denied:`)** back to the on-disk copy. They do
not re-read any other key — for the recording-shaping ones they only *drift-check*, and hard-fail on a
mismatch. So there is no flag that makes a plain `replay` honour an edited `lane:`, `fidelity:` or
`baseline:`: those reach a replay only by re-recording.

> **Authoring a scenario for a newer harness?** The frozen copy is why a `replay` gate can look happy
> while the YAML is unloadable. Check the file against the real loader with `cowork-harness lint
> <file.yaml>` (it also resolves a named `baseline:`), or `cowork-harness record <file.yaml> --dry-run`
> for the pre-spend refusals on top — see
> [Unknown keys: the loader is strict, and `cowork-harness lint` runs it](#unknown-keys-the-loader-is-strict-lint-is-lenient).

The rest of this section is the `assert:`-specific detail.

By default `replay` evaluates the assertions **frozen inside the cassette** (the copy `record` captured), so a
plain `replay` is byte-deterministic and independent of the working tree — editing `scenarios/<name>.yaml`'s
`assert:` does **not** change a default replay. To keep that from being a *silent* trap, when a sibling
scenario resolves and its `assert:` differs from the frozen copy, replay prints a `::notice::` pointing at the
opt-in flag.

This is a **separate axis** from content-class vs live-only ([Which assertions survive `replay`](#which-assertions-survive-replay-ci-placement)):
that axis says *whether* a key can be evaluated on replay; this one says *which copy* of the key is evaluated —
the recorded one, not your working-tree edit. A content-class key whose YAML you just edited is still evaluated
from the frozen copy until you re-record or `replay --reassert --write`.

`--assert-from <scenario.yaml>` (explicit) / `--reassert` (auto-resolve the sibling) re-check the cassette
against the **on-disk** `assert:` (+`expect_denied:`) — the token-free "edit the assert, re-check without a
paid re-record" loop. Because re-asserting against frozen events is only sound if the recording still
corresponds to the scenario, this path is safe by construction:
- **Recording-shaping drift hard-fails** — if `prompt`, `answers`, `baseline`, `fidelity`, `lane`, `skills`,
  or `requires_capabilities` differ from the recording, replay refuses (re-record instead).
- **The `session` is not verified on the replay path** — it's excluded from the drift check (stored
  relative in the cassette, resolves absolute on disk), so a session change between record and re-assert
  does not move the **replay** verdict — plain, `--strict` or `--assert-from`. The notice says so; re-record
  if the session changed. It *is* fingerprinted, and `verify-cassettes` checks that hash and reports a
  change as staleness (exit 1): `sessionFingerprint` covers the session's pinned `model:` and connected
  `folders`/`plugins`/`skills`/`mcp`/`egress`/`web_fetch`, plus `projects`, `agent_env`, `answer_channel` and `agent_env.artifacts_root` when set. A model
  supplied by `--model` or `COWORK_HARNESS_MODEL` is not in it (`environment.model` records what ran), and a
  cassette recorded before `model` joined the hash gets a note, not a failure — re-record to gain that
  coverage. (Skill *content* under the session IS guarded — next bullet.)
- **Skill-content staleness hard-fails** on this path (it implies `--fail-on-skill-drift`), so an edited assert
  can't green against a skill that no longer produces the frozen events.
- **Sourcing ≠ evaluation:** `expect_denied` and the filesystem/egress keys are read from the on-disk block but
  stay **live-only** on replay — editing them re-checks nothing here (replay warns when you do). Use a live
  `run` to check egress/filesystem.

See [docs/cassette.md](./cassette.md) for the mental model, file shape, and the O7 `replay_protocol_fidelity` guard.

#### How an assertion edit reaches CI

`--assert-from`/`--reassert` **validate** an edit; they do not **persist** it. Because a plain `replay` (what
CI runs by default) reads the block **frozen in the cassette**, a validated on-disk edit does **not** reach CI
until it is written back into the cassette — this is the load-bearing step consumers miss. Two ways to embed it:

- **Re-record** (`cowork-harness record`) — a live agent run, **paid**. Required when the recording *itself*
  must change: a new `prompt`, a new/edited skill, or a new assertion that needs telemetry the old cassette
  lacks (e.g. `input_unmodified` needs pre-run hashes). This also re-freezes the assert block as a side effect.
- **`cowork-harness replay <cassette> --reassert --write`** — **free**, when **only** the `assert:` block
  changed. It re-runs the token-free re-check above and, on a pass, persists the re-validated block back into
  the cassette; `controlOut` stays byte-identical, and `events` do too except that what the recorder now always
  removes is dropped from them (also when the block is already current). It **refuses** any key that would silently skip on
  that cassette (needs an artifact manifest, pre-run hashes, or `controlOut`) and — without `--allow-failing` —
  refuses a failing verdict, so `--write` can't bake in a green that plain `replay` won't reproduce.

Compact flow:

```
scenario edit
  → replay --assert-from (validate, free)
  → plain replay reads the FROZEN block (unchanged until you embed)
  → embed via  record (paid, recording changed)  OR  replay --reassert --write (free, assert-only)
```

For the exact flags see `cowork-harness replay --help`; the frozen-vs-on-disk sourcing rules are the
subsection above, and the live-run authoring loop is [`verify-run`](#re-checking-assertions-without-a-re-record-verify-run).

#### Mixed assertions on the replay lane

A multi-key assertion is an **AND** (every key must pass). That has a consequence on `replay`, where the
filesystem/egress keys can't be checked: before evaluating, `replay` **strips each assertion down to only
its content keys**, then drops any assertion left empty. So a mixed item like `{ result: success,
egress_denied: evil.com }` is evaluated on replay as `{ result: success }` alone — its `egress_denied`
half is removed rather than AND-ed against a value `replay` can't observe (which would false-fail).
(With an artifact manifest, `file_exists`/`user_visible_artifact`/`artifact_json` are **not** dropped —
they're replay-checkable; only the genuinely live-only keys above are stripped.) The full object —
every key checkable — is still evaluated on a live `run`/`record`.

Because that strip is silent on its own, `replay` is **loud about it in two classes** (a silent partial
false-green is the cardinal sin):
- **Full skip** — an assertion with no content key at all (pure filesystem/egress, plus every
  `expect_denied` host): a `::warning::` reports how many were skipped (not evaluated on replay).
- **Partial skip** — a **mixed** assertion whose content half *was* evaluated but whose genuine
  filesystem/egress half was dropped: a separate `::warning::` reports the count, so a mixed assertion
  can't quietly green on its content half alone. (Gate keys dropped only because `controlOut` is absent
  are already announced by the `controlOut` warning above and don't count as a partial skip.)

### Scenario YAML vs the pytest `cowork` lane — when to use which

Both run the skill under the real agent and assert; **neither replaces your unit tests** (keep those for
your skill's own scripts). Use **scenario YAML** for portable, declarative regression suites runnable via
`cowork-harness run` with **no Python toolchain** (CI exit code) — structural, boundary, and coarse-content
checks. Use the **pytest `cowork` lane** (`python/`) when you're already writing Python tests (you probably
are) or need a real predicate over a skill's **structured JSON output**:
`r.assert_artifact_json("artifacts/<slug>/sizing.json", lambda d: d["top_down"]["som"]["value"] > 0)` — a
full Python callable with autocomplete and `print(d)`, strictly richer than anything a YAML string can
express. **If you're checking structured JSON content and already write Python, prefer the pytest lambda**
(a YAML content-predicate would be equal power with worse tooling). Find an artifact's real field paths by
running once with `--keep`, then `cowork-harness inspect <run-dir>` (a shallow field preview of each JSON
artifact) or by reading the JSON under the run's `…/mnt/outputs/…` directly.

## Starting from a saved workspace (`workspace_fixture:`)

A long skill pipeline (score a deck, then draft the memo, then build the appendix) can be tested one step at a
time. `workspace_fixture: <dir>` names a directory whose contents are copied into the session's `outputs/`
before turn 1 — `<dir>/scores/deck.json` lands at `outputs/scores/deck.json` — so the prompt can ask for the
late step alone and the run pays only for that step.

```yaml
fidelity: container
prompt: Draft the investor memo from the scored deck.
workspace_fixture: fixtures/after-scoring     # relative to this scenario file
assert:
  - file_exists: {path: outputs/memo.md, authored: true}        # the step under test wrote it
  - artifact_json: {artifact: outputs/scores/deck.json, path: total, exists: true, authored: false}  # inherited is fine
```

**What it models.** A fixture run equals re-invoking the skill in the same Cowork session after it stopped
mid-work or finished: the files persist in `outputs/` and the skill resumes from them. The only difference is
that in Cowork the prior conversation context also persists, while a fixture run starts with a fresh context.
The copy keeps regular files and their permission bits, gives them fresh modification times, and tells the
model nothing about which files exist (no listing is added to the prompt).

**What the directory may hold.** Regular files only. Refused at load (exit 2, before anything is spawned),
each problem named: a symlink anywhere, a file with a second hard link, agent and configuration paths
(`.claude/`, `.git/`, `.mcp.json`, `CLAUDE.md`, `CLAUDE.local.md` — they configure the agent, they are not
deliverables), a directory that also is (or holds) a mounted folder, upload, plugin or skill dir, an empty
fixture, more than 64 MiB in total (`COWORK_HARNESS_WORKSPACE_FIXTURE_MAX_BYTES` raises the cap), and a single
file over the pre-run hash cap (50 MiB, `COWORK_HARNESS_PRERUN_HASH_CAP`), whose authorship could never be decided. In git
mode (the default; `COWORK_HARNESS_GITSET=0` turns it off) a file git does not track is refused too, so what a
cassette's signature covers is what is committed. OS metadata files (`.DS_Store`, `Thumbs.db`) are skipped.
A `semantic_pairwise` reference store must not sit inside the fixture (or hold it): the fixture is copied into
`outputs/`, where the agent would read the reference it is judged against, so that is refused too. Keep fixtures
outside the plugin tree, and inside the repository that holds the cassette: `record` refuses a
fixture its cassette could only reference by climbing out of that repository (the stored path would carry this
machine's directory names). `cowork-harness fixture export <run-dir> --out <dir>` turns a kept
run's outputs into one ([cli.md](./cli.md)).

**Staging.** Fresh runs only, on every tier: after the mounts, before the pre-run manifest. A `--resume`
turn re-stages nothing, but it must still declare the SAME `workspace_fixture` (and session) as the first turn:
the fixture is part of the pinned session's identity, so a turn that drops or changes it is refused as
belonging to another project. A host path a
fixture file contains counts as user-supplied input, so quoting it is not a `host_path_leak` — the same
exemption uploads get, at `container` and `microvm` (the tiers where that signal is armed). A `--resume` turn
never re-stages — it sees whatever the skill left in `outputs/`. A fresh run whose outputs dir is not empty is
refused (a pinned `--session-id` re-run at `microvm` clears the previous run's outputs first).

**Authorship — what the step produced.** Because the fixture lands before the pre-run manifest is taken, an
untouched fixture file is **pre-run**, not authored: `semantic_matches` grades only the files this run created
or rewrote (a fixture file the step rewrote is graded; one it never touched is not) — and so does a
`semantic_pairwise` judge, which compares the same authored document — and
`RunResult.artifacts[]` marks an untouched one `preRun: true` (`scaffold` skips those). `no_unexpected_files`
never trips on fixture files; `input_unmodified` can guard them ("the step must not rewrite the scored deck").
Deleting a fixture file is an outputs delete. On a baseline that records outputs as `rwd` (Desktop 2.16120.0
and later, including `latest`) it passes by default, as in production, where a skill deletes in outputs without
asking. On an older `rw` baseline the run fails on it by default; `allow_outputs_delete: true` opts out there.

**A presence assertion on a fixture file must say what it means.** `file_exists`, `user_visible_artifact`,
`artifact_text` and `artifact_json` check that a file is there (or what it says), not who wrote it — on a file
the fixture provides they pass before the step does anything. So a scenario that asserts one of them on a
fixture path — or names a directory the fixture provides, in any letter case — is **refused at load**
(`cowork-harness lint` reports it, and `run`, `record` and its `--dry-run`, `eval`, a `--resume` turn,
`verify-run` and `replay --assert-from` refuse it before evaluating anything) unless it states `authored:` — `authored: true` (this run must have created
or rewritten the file; an untouched pre-run file fails, and so does a run with no pre-run manifest to tell) or
`authored: false` (inheriting it is fine). `file_exists` and `user_visible_artifact` take an object form for
it, `{path, authored}`; `artifact_text` / `artifact_json` take `authored` as a field. `authored: true` works on
any scenario, fixture or not; it arms the pre-run manifest. Authorship is decided per invocation: on a
`--resume` turn — which captures no manifest of its own and would otherwise diff against the first turn's —
`authored: true` fails evidence-unavailable, so a turn never takes credit for what an earlier turn wrote. It
applies to a regular file: a directory fails (assert on a file the step writes inside it), a hard-linked file is
evidence-unavailable (the authored-file capture the judge grades excludes it too), and a symlink — or a path reached through a symlinked
directory — is never authored evidence. A path outside the folders the pre-run manifest walks (`outputs/`,
`uploads/` and the connected folders) — a staged plugin or skill file, say — is evidence-unavailable: it is
absent from the manifest because it was never walked, not because the run created it. The file is looked up by its on-disk name, so on a case-insensitive
filesystem `outputs/REPORT.md` is the fixture's `report.md` (likewise an NFC/NFD spelling of a non-ASCII
name). A copy or rename of a fixture file to a NEW name is new content at a new path and counts as authored,
exactly as the judge's authored capture counts it.

**Recording and replay.** A cassette stores the fixture path relative to itself and records every fixture file
in its manifest like any other outputs file, so replay needs no fixture and knows which files were pre-run.
Text fixture files are inlined (and go through the record redaction policy — when the policy rewrites an
untouched one, its pre-run hash is recorded as the redacted body's, so it still reads as unchanged and
`input_unmodified` on it stays checkable on replay); an untouched binary one is recorded hash-only (`truncationReason: "fixture"` — `file_exists` still passes on replay, a body assertion is
evidence-unavailable). The fixture's content signature (`fingerprint.workspaceFixtureSig`) is part of the
staleness check: replay recomputes it from the fixture directory, and a changed fixture is a `fixture` finding
(a warning by default; `--strict`, `--fail-on-skill-drift` and an explicit `--session` fail it), while a
fixture that cannot be found or scanned is `unverifiable-fixture`, which fails the replay. Only the
owner-executable bit counts among permission bits. A cassette that uses `workspace_fixture` or `authored`
stamps cassette format v14 ([cassette.md](./cassette.md)).

## Numeric metrics (`metrics:`)

A metric is a number the scenario measures: it is read from a JSON file the run wrote and reported in
`RunResult.metrics` (and in `regrade`'s output). It never changes the verdict — assert on it with `artifact_json`
if a value must pass or fail.

```yaml
metrics:
  - id: words                  # the name it is reported under; also a hillclimb grade key
    artifact: outputs/stats.json   # a JSON file, relative to the work root
    path: totals.words         # dotted path to the number (items.0.score; items.length reads an array's length)
    better: higher             # REQUIRED: higher | lower
    scale: 5000                # the UPPER BOUND of a bounded metric's range …
    # unbounded: true          # … or this, for one with no natural ceiling — set EXACTLY ONE of the two
    min: 0                     # OPTIONAL: the floor of the range (default 0); must be below scale
```

Refused at load: a missing `better`, both or neither of `scale` / `unbounded`, an id that is not word characters,
dots and hyphens (at most 129, not all dots), an id that collides with a key the hillclimb runner generates (`pass`,
`claims`, `a<N>…`, `*_present`, `*win*`, `*both_bad*`), two ids that differ only in letter case, and an `artifact`
that starts with `/` or a drive root (`c:/`), contains a `..` segment, a backslash or a NUL, or is blank (a colon alone is fine: `a:b.json` is a POSIX name), and a `min` that is not below `scale`. The published schema mirrors all of these except the duplicate-id check and `min` below `scale`. The range is
`[min, scale]`: a metric that runs from -1 to 1 is `min: -1, scale: 1`, not `scale: 2`. Declaring a metric arms the
pre-run manifest.

`RunResult.metrics` has one entry per declared id, in declaration order, each with exactly one of `value` (a finite
number) or `unavailable` (why not). It is absent when the scenario declares none (`metrics: []` included), on a
partial run, on `chat`, on a replay that could not drive the cassette, and on a replay whose frozen declaration is
invalid (warned). A missing value is never reported as `0`, and a string is never converted to a number. A number is
read as a double, so an integer above 2^53 loses precision.

| `unavailable` | meaning |
|---|---|
| `missing_artifact` | no readable regular file at `artifact` (absent, a directory, a FIFO or other special file, or a symlink leaving the work root), or (replay) a body that could not be read at record time |
| `missing_path` | the JSON has no value at `path` |
| `not_json` | the file is not valid JSON |
| `not_a_number` | the value is not a finite number (a string, a boolean, `null`, an object, or a number too large for a double) |
| `readonly` | the file is a read-only connected-folder input |
| `size` | the file is over the 10 MiB body cap, or (replay) over the cassette's inline-body cap |
| `remote` | `lane: remote` — the lane's filesystem is not locally observable |
| `pruned` | there is no work tree to read (a replay of a cassette with no artifact manifest), or (regrade) the kept file differs from what the run wrote |
| `pre_run` | the run did not write the file — see below |
| `no_manifest` | the run recorded no pre-run manifest, so whether it wrote the file cannot be decided — re-run or re-record the case with the metric declared (declaring a metric arms the manifest, and a cassette keeps it) |

**`pre_run`: a metric reads only what the run wrote.** "Wrote" is the rule `authored: true` uses: the file's content
hash compared with the pre-run manifest. A file absent before the run is new; one whose hash changed was rewritten;
either is measured. There is no record of the write itself, so **a file the run rewrote unchanged is treated as
untouched**: a fixture file the step rewrote with identical bytes is `pre_run`, exactly like one it never opened —
`pre_run` does not mean the agent did nothing. `pre_run` also covers every case where authorship cannot be decided,
as `authored: true` does: a `--resume` turn, a hard-linked file, a symlink at the path or a path through a
symlinked directory, a missing pre-run hash, and a path outside the folders the pre-run manifest walks. A run with no
pre-run manifest at all is `no_manifest` instead: nothing then says the run did not write the file. A live run never
reads `no_manifest` (declaring a metric arms the manifest); a kept run or cassette recorded without one does — a
metric added to a scenario after its run, or an old cassette.
So a metric should read a file under `outputs/` or a connected folder.

**In `hillclimb`** each metric is a grade key on every row, `<id>` beside `<id>_present`, with the reason an
unmeasured one was unavailable in `meta.metrics_unavailable`. Adding or removing a metric mid-flow is allowed; changing
one's declaration is refused, since the flow's rows were graded under the old one. See
[cli.md → Numeric metrics in hillclimb](./cli.md#numeric-metrics-in-hillclimb).

**Replay** measures the frozen declaration against the cassette's manifest, so it needs the body inline. A metric the
recording cannot support — no artifact manifest, a body over the inline cap or unreadable at record time, a missing
pre- or post-run hash — is reported unavailable and named once in a `::warning::`, with a remedy where a re-record
would measure it (raise `--max-artifact-bytes` for `size`) or a re-run or re-record with the metric declared would (`no_manifest`); one that states what the run did (a link, an untouched
file, a file outside the walked folders) is not warned about. `replay --assert-from` and
`--reassert` measure the on-disk declaration, as they do for `assert`, and `--write` freezes it with the assert
block; a plain replay notices an on-disk `metrics:` block that differs from the frozen one. **`verify-run`** and
**`regrade`** re-measure the current declaration from the kept work dir, but only while a file's bytes equal the
run's recorded post-run hash; otherwise `pruned` (a file under `uploads/` has no recorded hash, so it is always
`pruned` there). `verify-run` needs no judge, so it is the way to re-measure a scenario with no `semantic_matches`
or `semantic_pairwise` assert, which `regrade` refuses (`no_semantic_asserts`).

## Output

Each run writes to `~/.cowork-harness/runs/<name>/<sessionId>/` (relocate with `--run-dir <path>` or `COWORK_HARNESS_RUNS_DIR`):

```
events.jsonl      full stream-json (child→driver; also the cassette source)
control-out.jsonl driver→child control_responses (the other cassette half)
turns/<N>/        ONE DIRECTORY PER TURN, written once and never renamed. A run dir holds several
                  turns with --session-id + --resume, and always for `critique` (task + reflection),
                  and always for `chat` too (always turns/1/ — chat never resumes). Each holds that
                  turn's:
                    run.jsonl       harness log: decisions (+who), sub-agent dispatch tree, egress,
                                    transcript, cost
                    trace.json      structured trace: steps, questions, sub-agents, egress, cost
                    result.json     assertion results + decisions + sub-agents + usage + status
                                    (incl. workDir/outputsDir)
                    resources.jsonl per-sample resource telemetry
                  A single-turn run has just turns/1/. There is NO root compat copy — a bare
                  `<run-dir>/result.json` does not exist; a dir that has one instead predates this
                  layout and is refused (naming the shape) by verify-run/inspect/scaffold/--resume.
egress.log        allow/deny per outbound connection (L1/L2)
session.json      session manifest (only when --session-id/--resume is used): the ids resume needs, plus
                  the scenario name and the SESSION-STARTING turn's prompt (a --resume never rewrites
                  the manifest) so the file identifies its own run. RESUME MACHINERY —
                  result.json stays authoritative for identity; nothing validates the extra fields
status.json       run status (phase, exit, timing) — see docs/run-status.md
mounts.json       VM→host path map (feeds trace --translate-paths; hostloop runs)
timeline.jsonl    per-tool-call timing (feeds trace --view tool-durations)
agent.stderr.log  raw agent-process stderr
proxy/            egress sidecar proxy logs (L1/L2)
```

(`run.jsonl`/`trace.json` replace the old `transcript.json`/`decisions.jsonl`. Secrets are scrubbed
from every persisted log by value.) To read a run's `events.jsonl` as a digest — tool calls, real
sub-agent dispatches (deduped), decisions — run **`cowork-harness trace <run-id | dir> [--view tools]`**.
The deliverable a skill produces lands at the `outputsDir` (`…/mnt/outputs`), surfaced by `--keep` and
in the `--output-format json` envelope.

**`outDir` is the canonical run-dir handle.** The run envelope's `outDir` field (and the `[status]
<outDir>` line every `run`/`skill`/`chat` prints to stderr at start) is the authoritative path to a kept
run — don't reconstruct it by listing `~/.cowork-harness/runs/<name>/` yourself. In particular, **do not
use `ls -td runs/<scenario>/* | head -1`** to find "the latest run": directory mtime is not run recency
(a dir's mtime bumps on any later write inside it — an `inspect`, a `trace --translate-paths`, a slow
finalize — independent of when the run itself happened), so it can readily return a stale prior-session
dir instead of the run you actually just kept. For "what's the newest run for scenario X", use
**`cowork-harness status --latest-for <scenario-name-or-slug>`** instead — it resolves recency from the
run's own `.origin`/`result.json` timestamps, not directory mtime, and prints the resolved `outDir`.

**Terminal output.** `run` is verdict-first and prints the **failing transcript inline** on a `FAIL`;
`--verbose` shows the transcript for every scenario, `--quiet` shows only the verdict. `--output-format
json` emits the machine envelope `{tool, version, command, ok, results[], error}` on stdout (one
`RunResult` per scenario; overall pass = `result==="success" && assertions.every(pass)` **AND a clean
`computeVerdict`** — a verdict signal like `stalled` (ended on a question, or after an `AskUserQuestion` gate on a request for input, with no productive work after its last gate), `transport_error`, or a
missing-capability/boundary signal can still fail a run whose `result` is `success` and whose assertions all
pass, unless the matching `allow_*` modifier is asserted) — full schema
in [SPEC §11](../SPEC.md). Human output is stderr; stdout stays machine-only under `--output-format json`.

## Running

```bash
cowork-harness run examples/scenarios/csv-metrics.yaml   # one scenario
cowork-harness run examples/scenarios/                    # every *.yaml in the dir
```
Exit code is non-zero if any assertion fails or the run errors — CI-ready. (In your own skill repo
you'd keep these at the root, e.g. `run scenarios/`; the harness ships them under `examples/`.)

`run` takes exactly one `<scenario.yaml | dir/>` plus **common flags only** — it loudly rejects `--fidelity`
(the tier comes from the scenario's own `fidelity:` field, not a flag), `--answer`/`--answer-policy` (answers
are scripted in the YAML's `answers:` block instead), and any other flag not documented on this page, with
`unexpected argument(s): …`. Two flags `run` *does* accept beyond the common set:

- `--decider-model <id>` — overrides the answering model for `on_unanswered: llm` scenarios (flag >
  `COWORK_HARNESS_DECIDER_MODEL` env > Sonnet default); a no-op for scenarios that don't use the model
  terminal.
- `--ablate-skill` — the **control arm** of a with/without comparison: runs **this one invocation** with
  the skill(s)-under-test removed, to check whether the agent "succeeds" even without them. It is one
  arm, not both — run the same prompt a second time *without* the flag to get the treatment arm.
  Composed with `--repeat N` it produces **N ablated runs and zero treatment runs**, which is the
  intended reading of "N samples of the control" and not an A/B. **The rollup's verdict line names the
  arm** — `repeat "<skill>": PASS [ABLATED — control arm] — 5/5 passed (100%)` — so a one-armed batch
  cannot be read as a finished comparison, and each run's `[provenance]` footer line carries
  `ablated=true` besides. Every ablated run is also stamped `ablated: true` in `result.json`, so a
  consumer reading the record can never mistake one for a real run. Designing the comparison itself (scrubbing tells, shuffling, judging
  blind, unblinding after grading) is yours; the harness supplies the runs and the control arm.

Already have a run you like the shape of? `cowork-harness scaffold <run-id | run-dir>` turns a **kept**
run (`--keep`, or a `--session-id` run) into a starter scenario YAML — auto-filled from what it observed
(gates→answers, artifacts→file_exists) — instead of copying an existing example by hand and editing it to
match. Prints to stdout by default; add `--out <file.yaml>` to write it straight to `scenarios/`. Review
and tighten the generated `when_question` regexes before committing.

### Measuring flakiness (`run --repeat`, `skill --repeat`)

A single green run proves the scenario passed *once*. `--repeat <N>` (2–100) runs each resolved scenario N
times and aggregates a **variance rollup** — pass rate, per-assertion pass/fail attribution, a
verdict-signal histogram, cost/token totals, and a non-deterministic-run count — instead of a single
pass/fail. `results` in the JSON envelope still holds every raw run (nothing hidden); only `ok`/the exit
code are redefined for this mode, computed from the rollup rather than `results.every(pass)`.

```bash
cowork-harness run examples/scenarios/csv-metrics.yaml --repeat 10 --min-pass-rate 0.9
```

- `--min-pass-rate <0..1>` (default `1.0` — no flakiness tolerance) sets the batch's pass threshold.
- `--stop-on-diverge` stops the loop as soon as **both** a pass and a fail have been observed — saves
  paid runs once flakiness is already proven. That batch always **fails**, regardless of the numeric
  rate reached: divergence *is* the failure this flag exists to catch.
- `--max-budget-usd <x>` stops the loop once cumulative cost would exceed it. Cost here is each run's `cost.usd`, the agent session's own spend — the `semantic_matches` judge and the LLM decider (`on_unanswered: llm` / `--decider-llm`) are separate model calls that are **not** included, so the cap does not bound them. (Without `--repeat` the
  same flag is a PRE-flight refusal on a single run, estimated from that scenario's own cost history —
  there is no live cost signal to abort a run mid-flight on.) A budget-stopped batch
  **fails by default**, even if every completed run passed — "incomplete is not green" is the same
  principle `--matrix`'s `truncated` applies (see below). It still prints a loud `::warning::` naming the
  stop. Pass `--allow-budget-stop` to opt back into judging the batch on its own completed-runs pass rate
  instead. If a run reports no cost telemetry, the cap degrades LOUDLY (one warning) instead of silently
  running all N as if the cap didn't exist.
- **Available on `skill` too.** `skill <folder> "<prompt>" --repeat N` runs the same skill+prompt N times and prints the same rollup — "did this finding reproduce, or did it pass once?" is the question an iterate-across-fixes loop asks on the exploratory lane. `skill --repeat` additionally rejects `--session-id`/`--resume`: both pin ONE run dir, so each iteration would overwrite the previous one instead of producing N independent samples.
- `--repeat` (on **both** `run` and `skill`) rejects `--decider-dir`/`--decider-cmd` — an interactive driving agent or an external helper
  answering gates live × N runs isn't a reproducible measurement. `--decider-llm`/`on_unanswered: llm` are
  allowed, but a decided gate makes
  `RunResult.nonDeterministic: true`, and the rollup's `nonDeterministicRuns` count flags this: flakiness
  attribution downstream of a decided gate is confounded, since the gate itself isn't reproducible.

This also composes with `skill_triggered`/`no_skill_triggered` (see [Assertions](#assertions)) for a
**trigger-accuracy sweep**: a directory of prompt-variant scenarios, each asserting whether the intended
skill fires, run under `--repeat` to measure how reliably a description/trigger phrase actually invokes the
skill across repeated tries — see
[`examples/scenarios/trigger-accuracy-sweep/`](../examples/scenarios/trigger-accuracy-sweep/) for a worked
example.

### Matrix testing (`run --matrix`)

One scenario, a cross-product of axes, one command. `--matrix <matrix.yaml>` runs the resolved scenario
once per cell of a matrix file's declared axes and reports one row per cell, instead of one pass/fail for
the whole run. For a real, runnable starting point (not just the illustrative snippet below), see
[`examples/matrices/csv-metrics-matrix.yaml`](https://github.com/yaniv-golan/cowork-harness/blob/main/examples/matrices/csv-metrics-matrix.yaml) — it matrixes
`examples/scenarios/csv-metrics.yaml` across the two most recent shipped baselines:

```bash
cowork-harness run examples/scenarios/csv-metrics.yaml --matrix examples/matrices/csv-metrics-matrix.yaml --concurrency 2
```

A `matrix.yaml` can declare any/all of three axes:

```yaml
baselines: [desktop-1.17377.2, desktop-1.18286.0]   # optional axis; each value must resolve via loadBaseline
models: [claude-sonnet-4-6, claude-opus-4-8]         # optional axis; overrides the session model per cell
# skill_dirs: [<path-to-variant-A>, <path-to-variant-B>]   # optional axis; substitutes the skill under test —
#   point this at real alternate skill directories in your own repo. This repo doesn't ship a second variant
#   of csv-metrics to matrix against, so the shipped example (examples/matrices/csv-metrics-matrix.yaml) omits
#   this axis rather than inventing fake paths.
```

- Any axis may be omitted; an omitted/empty axis contributes exactly one cell (unmodified), so a matrix
  file with no axes at all still runs the scenario once.
- The cross-product is capped at `--max-cells` (default 16) — over the cap, the harness warns and runs
  only the first N; it never silently drops cells without saying so.
- A truncated matrix (some cells never ran because of the `--max-cells` cap) **fails by default** — an
  un-run cell is treated the same as "incomplete is not green" elsewhere in this doc (see `--repeat
  --max-budget-usd` above). Pass `--allow-truncated-matrix` to judge only the cells that actually ran.
- `--concurrency <n>` (default 1, max 8) runs cells N at a time via the same bounded pool `record
  --concurrency` uses — each cell is a fully isolated run, so the bound exists only to stay under Docker's
  address pool / the model API's rate limits, not for correctness. **Exception**: `--concurrency > 1` is
  rejected together with `--decider-dir`/`--decider-cmd` — the external-decider channel is ONE shared
  object across every cell, and every channel implementation is strictly serial over shared mutable state,
  not safe for concurrent gate answers. `--concurrency 1` (the default) with an external decider is fine.
- Exit code: a matrix is a **compatibility gate**, not a survey — any cell failing (a real assertion
  failure, OR a cell-level infrastructure error, e.g. the pinned baseline's agent binary isn't staged)
  fails the whole run. An infra failure renders as a distinct `cell error: …` line, never as a fake
  assertion failure, so you can tell "the skill failed" apart from "this cell never got to run the skill
  at all". `--matrix` composes with `--repeat`: each cell runs as its own repeat batch (N iterations of
  that cell's axes-overridden scenario), with the same unanswered-gate/budget-cap handling as standalone
  `--repeat`; the matrix verdict then judges each cell's rollup against `--min-pass-rate`.
- The `skill_dirs` axis has one constraint worth knowing up front: the session under test must declare
  **exactly one** `plugins.local_plugins` entry (the skill being matrixed), and every candidate directory
  in the axis must share that entry's **basename** — the mount name a plugin gets is derived purely from
  its source directory's basename (there's no author-chosen override), so a mismatched basename would
  silently change the mount name a scenario's assertions reference. Keep skill-dir variants under
  identically-named leaf directories at different parents, e.g. `variants/v1/my-skill/`,
  `variants/v2/my-skill/` — the harness rejects a basename mismatch loud rather than renaming anything for
  you.

### Dry-running a decider (`decide`)

`cowork-harness decide` validates a decider against a **sample question in ~2s, with no run** — so you
don't discover a wire-protocol bug or a non-matching regex twelve minutes into a live skill. It builds one
synthetic `AskUserQuestion` and feeds it to whichever decider you point at: `--answer "<rx>=<choice>"` /
`--answer-policy <yaml>` (scripted rules — reports which rule matched, or exits non-zero if none did),
`--decider-cmd '<helper>'` (shows the exact request the helper received and its answer), or `--decider-llm`
(a live model answers; flagged non-deterministic). Override the prompt with `--question` and repeat
`--option` to set the choices. `decide` does **not** accept `--decider-dir` (the file-rendezvous channel
is a live-run concern) — passing it is a hard usage error (exit 2). The synthetic gate is **single-select
only** (there is no multiSelect flag), so the printed request shows `options[].label` but never
`multiSelect:true` — to exercise a helper's array reply path, run a real multiSelect gate or unit-test
the helper directly.

```bash
# Does my answer-policy actually answer the gate I think it does?
cowork-harness decide \
  --question "Which output format do you want?" \
  --option Markdown --option PDF \
  --answer-policy examples/answer-policies/demo.yaml
# ✓ rule matched: "Which output format do you want?" → "Markdown"
```

### Re-checking assertions without a re-record (`verify-run`)

When an assertion is wrong (a typo, the wrong path, an over-pinned regex) but the *run* itself was fine, you
don't need a fresh live run to fix it. `cowork-harness verify-run <run-dir> <scenario.yaml>` re-evaluates the
scenario's `assert:` block against an already-kept run dir — **no live agent, no tokens, no Docker** — in about
a second:

```bash
export COWORK_HARNESS_MODEL=claude-sonnet-5   # a run must name its model (or pass --model <id>)
cowork-harness skill ~/my-plugin "..." --keep            # prints the run dir
cowork-harness verify-run ~/.cowork-harness/runs/<scenario>/<sessionId>/ my-scenario.yaml
# ✗ verify-run: 1/3 assertion(s) failed  → fix the assertion, re-run verify-run, repeat
```

It reconstructs the assert context (transcript, tool calls, egress, artifacts, questions) from the run's
persisted `result.json` + sidecars and uses the **same verdict path as a live record**. Two limits: it needs a
**kept** run dir (`--keep`, or a `--session-id` run), and filesystem assertions (`file_exists` /
`user_visible_artifact` / `artifact_json`) need the run's work dir still on disk — if it has been torn down,
`verify-run` refuses rather than reporting a false failure. (`--keep` is a `skill`-only flag; a plain
`cowork-harness run` already qualifies without it — `run` always keeps its runs under the runs root, so
`verify-run` can point straight at one.)

**Answer-coverage (when the scenario declares `answers:`).** The check is **gate-centric**: verify-run
confirms that **every gate the run actually fired** (parsed from the kept run's `events.jsonl`, which retains
the offered option labels) is covered by a matching `answer`, and that the answer's `choose:` named an option
the gate actually offered. It does **not** penalize answer rules that no fired gate matched — e.g. rules for
*conditional* gates that didn't fire this run. So a scenario with 5 answer rules whose run fired only 2 gates
passes at "2/2 gates matched". A **failure** means a *fired* gate had no matching answer, or a matched answer's
`choose:` named an option the run never offered (the model reworded the gate) — surfacing the drift in ~1s
instead of on a paid re-record. This **changes the exit-code contract**: a run that is green on `assert:` can
now exit `1` on such a mismatch. If the scenario declares answers but the kept run dir has no `events.jsonl`,
verify-run **refuses** (exit `2`, "can't verify ⇒ not green") rather than vacuously passing. The same
fail-closed rule covers *degraded* evidence: an `events.jsonl` with unparseable lines (truncation, a hand
edit, or raw agent-stdout noise), or one that yields fewer gates than `trace.json` recorded questions,
also refuses — a present-but-corrupt stream is otherwise indistinguishable from "zero gates fired" and
would certify answer coverage at a hollow 0/0. And independent of answers, a `result.json` that parses
but is structurally invalid (no `"success" | "error"` result field — truncated, hand-edited, or not
harness-written) refuses instead of being certified as success. The refusal also keys on provenance: a
`result.json` produced by `replay` (`command:"replay"`) refuses — a replay is a re-check of a recorded
cassette, not run evidence, so certifying it would launder a re-check into a fresh verification; point
`verify-run` at the original live run dir (or re-run live). A `mode:"chat"` result refuses too — chat
carries no assertions and no verdict by contract, so it must not be read as pass/fail. Both are keyed on
`command`/`mode`, never on `workspaceFiles` — a live run merely lacking an optional evidence field still
verifies.
A scenario with no `answers:` is unaffected (assert-only, exactly as before). Scenarios using
`on_unanswered: first`/`llm` treat an unmatched gate as an acceptable auto-answer, not a failure.

**Currency — the kept run must be current vs the skill.** Answer-coverage validates against the kept run's
gate **snapshot** (its `events.jsonl`). If the skill changed *after* the run was kept — e.g. you reworded a
gate or moved its options — those recorded gates are stale, and a green here would be false confidence. Every
run persists a skill fingerprint in `result.json`; on the answer-coverage path `verify-run` recomputes it live
and, if the skill source drifted, **refuses** (exit `2`, "the kept run predates the current skill") instead of
vouching against stale labels — re-`--keep` a fresh run (or re-record). A kept `--matrix` `skill_dirs` cell always refuses here: its fingerprint names the substituted candidate, while `verify-run` recomputes from the session file. The plain `assert:`-only re-eval (no
`answers:`) is unaffected. A kept run recorded by an older harness (no fingerprint) → a warning, not a refusal.

> **The cheapest authoring loop:** `--keep` ONE run, then `trace --view questions` / `verify-run` read the
> gates + offered labels out of that run's `events.jsonl` for free — fix your `answers:` without re-paying for
> a record. Just re-`--keep` after a skill change that moves gate phrasing (per the currency rule above). A
> mismatched `choose:` is reported with the **offered options** so you can fix the anchor from the error alone.

### Recipes for goals the harness has no flag for

The companion skill carries the same recipes ([task-recipes.md, Recipe 8](https://github.com/yaniv-golan/cowork-harness/blob/main/.claude/skills/cowork-harness/references/task-recipes.md#recipe-8--goals-the-harness-has-no-flag-for)).
Each recipe below uses only shipped flags and keys. Each says what it does **not** prove.

#### Force a context compaction

Pin a session, run the task, compact it by hand, check that turn, then continue:

```bash
cowork-harness skill ./my-plugin "<the task>" --session-id compact-1
cowork-harness skill ./my-plugin "/compact" --session-id compact-1 --resume
jq -e '[.contextEvents[]? | select(.subtype=="compact_boundary")] | length > 0' <run-dir>/turns/2/result.json
cowork-harness skill ./my-plugin "<continue the task>" --session-id compact-1 --resume
cowork-harness trace <run-dir>        # shows the latest turn: what the continued task did
```

The run dir is the one each turn's `[status]` line prints. A resumed session's dir holds one `turns/<n>/` per
turn, and `verify-run` refuses a dir with more than one turn, so the `compaction_occurred` assert cannot be checked
on it: read the `/compact` turn's own `result.json` instead (`jq` exits `0` when it recorded a compaction, `1` when it
did not). *Does not prove:* that the skill behaves as it would after an automatic compaction. A manual
`/compact` may not re-attach skills exactly as autocompact does (not verified), and re-attached skill text can come
back truncated, so a long `SKILL.md` may not return whole.

#### Ablate one `SKILL.md` section

Copy the plugin, delete the section from the copy, and run the two as `eval` arms.
Size it first, at no cost:

```bash
cp -R ./my-plugin /tmp/nosec && $EDITOR /tmp/nosec/skills/<skill>/SKILL.md   # remove the section
cowork-harness eval scenarios/ --arm full=./my-plugin --arm nosec=/tmp/nosec --dry-run --target-effect 30
```

*Does not prove:* which section drove a given action; it shows only whether removing it changes the graded outcome.

#### Test a skill's parsing of a Desktop form reply

Desktop's elicitation form sends its answers as the next user
message, as one line. Send that line as a resumed turn: `cowork-harness skill ./my-plugin "<the reply line>" --session-id s --resume`. The format,
from Desktop's own form guide:

- one line: `<Title> details — Label: value · Label: value`, labels being the form's field names in sentence case;
- a multi-select value comma-joined; a short multi-line value flattened with ` / `; a value of 81–200 characters
  in quotes;
- a value over 200 characters shown as `Label: (N chars — see below)`, and repeated in full after a
  `--- Full content ---` line;
- a skipped form arrives as one fixed sentence saying it was skipped.

*Does not prove:* that the model would choose the form (the harness serves no `visualize` tools; see
[fidelity-gaps.md](./fidelity-gaps.md#skill-argument-collection--the-elicitation-form-branch-is-not-reachable-here)),
or that a file the form attaches arrives.

#### Resume the work in a new conversation

Keep the first run, export its outputs, and start a second scenario from
them:

```bash
cowork-harness run step1.yaml --keep
cowork-harness fixture export <run-dir> --out scenarios/step1-out
```

```yaml
# scenarios/step2.yaml
workspace_fixture: step1-out
assert:
  - file_exists: {path: outputs/next.md, authored: true}            # this conversation wrote it
  - file_exists: {path: outputs/brief.md, authored: false}          # carried over, not rewritten
```

Record step 2 with `--out` inside the same tree as the fixture: `record` refuses a fixture outside the cassette's git repository (outside git, outside the cassette's directory).
*Does not prove:* how Cowork treats a new task over the same folder on either lane (not verified); the second
conversation starts with no memory of the first.

#### Assert a hook's JSON decision

A hook that decides by printing JSON and exiting 0 counts the same as one that exits 2: both deny. The one
exception is the bare `hook_event_blocked: <event>`, which counts exit code 2 alone; its object form counts both.
Assert the decision, and what the agent got back:

```yaml
assert:
  - hook_decision: {event: PreToolUse, decision: deny, tool: Bash}   # the tool that fired: Bash at container
  - tool_result_contains: "blocked by policy"
  # updatedInput: the recorded call input is what the model sent; the rewrite shows in the paired result
  - tool_called: {tool: Bash, result: {matches: 'outputs/archive/'}}
  - hook_event_blocked: {event: Stop, max: 0}   # the Stop hook ran and never blocked
```

*Does not prove:* that the model read the reason, or which plugin's hook decided (frames carry no plugin id).

#### Schema-check a written file

In the Python lane, pass a `jsonschema` check as the predicate:

```python
import jsonschema
def valid(doc):
    jsonschema.validate(doc, SCHEMA)   # raises with the failing path
    return True
result.assert_artifact_json("outputs/cap.json", valid)
```

In a scenario, name the exact paths (`artifact_json` per file), or cover a set with a glob `artifact` and
`match: each`, and add `no_unexpected_files` so no other file slips in. `artifact_json` checks fields one dotted path
at a time, not a whole schema. *Does not prove:* anything about a file no path or glob you listed reaches.

#### Hold a skill to an unattended host

Make any question fail the run, and give the answers in the prompt:

```yaml
fidelity: container
on_unanswered: fail            # the default for `run`; say it anyway
prompt: "Build the weekly report. Assume: region = all, format = markdown; ask nothing."
assert:
  - questions_count_max: 0
```

Leave `allow_stall` out, so ending on a question fails. `trace <run> --view questions` shows who answered each gate
(`answeredBy`). *Does not prove:* scheduled-task behaviour. Real scheduled tasks remove `AskUserQuestion` and tell
the model no user is present; the harness does not model them. To check instead that a skill parks correctly when
nobody can answer at all, use the session key `answer_channel: none`: the agent gets no question tool, and the run is
graded by the status file the skill writes ([headless-no-answer.md](./headless-no-answer.md)).

### Debugging with `chat`

> See [chat.md](./chat.md) for the full `chat` reference and flags.

`cowork-harness chat <skill-folder>` is an interactive multi-turn REPL for **hand-debugging** a skill under
the runtime — reach for it to reproduce a gate/permission flow interactively, poke a stochastic multi-turn
skill, or explore before authoring a scenario. It is *not* an asserted test (that's `run`); it's the
exploratory loop.

- **It needs a model** — `--model <id>` or `COWORK_HARNESS_MODEL`; a session that resolves none is refused
  (exit 2), with or without `--raw`.
- **Gates are answered interactively at the TTY** — `chat` carries no scripted `answers:`; an unscripted
  AskUserQuestion / permission request prompts you in the terminal.
- **It always writes a transcript** under `runs/chat/<sessionId>` (there is no `--keep` flag); inspect it
  afterward with `cowork-harness trace <dir>`. Exit with `/exit` or `/quit`.
- **Use plain `chat`, not `chat --raw`, for faithful debugging.** `--raw` is a native `docker run -it`
  session with **no egress sandbox** — convenient, but it does *not* reproduce Cowork's default-deny network,
  so behavior there isn't representative.
- **`chat` does not support `--session-id` / `--resume`** (those are `skill`-only; chat mints a throwaway
  session) — for checkpoint/resume debugging use `skill … --session-id … --resume`.
- **Promote a finding to a scenario to make it deterministic.** `chat` is live/non-deterministic and —
  unlike `skill`/`run` — prints no copy-pasteable `--answer` footer. Once you've reproduced a flow, re-express
  it as a `scenarios/*.yaml` with scripted `answers:` so it becomes a repeatable regression.

### Shipped examples to read

The repo ships runnable scenarios you can copy from, under [`examples/`](../examples/) — each pairs with an `examples/sessions/*.yaml` and, for the skills, a folder under `examples/skills/`. (The harness's own fidelity self-tests live separately in `e2e/`.) A few to start with:

| Scenario | Shows |
|---|---|
| `examples/scenarios/example-pdf-skill.yaml` | the minimal shape — prompt + scripted answers + assertions (placeholder skill; harness plumbing only) |
| `examples/scenarios/csv-metrics.yaml` | a non-trivial skill running a **bundled producer** end-to-end, writing a structured `outputs/metrics.json` + a `summary.md` (paired with `python/test_csv_metrics_lane.py` for a JSON-content predicate) |
| `examples/scenarios/csv-fx-normalize.yaml` | **graceful degradation** under default-deny egress — the skill's real network step is blocked, so `egress_denied` is backed by genuine behavior and the skill falls back instead of crashing |
| `examples/scenarios/skill-loads.yaml` | an acceptance check that a local skill loads and the python toolchain is present |

This is illustrative, not the full set — [`examples/README.md`](../examples/README.md) is the canonical,
complete inventory (it also covers the `hostloop` and trigger-accuracy-sweep examples); check there first
so this table doesn't need to stay in sync with it.

## The `microvm` tier — `vm init` prerequisites & troubleshooting

The `microvm` (L2) tier runs the agent inside an **Apple Virtualization.framework microVM via Lima**
(`vmType: vz`) — the same hypervisor class as Cowork — for VM-grade filesystem/escape isolation. Egress is
**not** gVisor: the guest gets a default-deny **iptables** firewall (allow loopback + DNS + the host
gateway only) that funnels all traffic to the **same allowlist proxy as the `container` tier**, so L2's
network transport equals L1's. Reach for it for escape isolation of untrusted code, not for better network
fidelity.

**Prerequisites:**
- **macOS on arm64 (Apple silicon).** The generated Lima config pins `vmType: vz`, `arch: aarch64`, and an
  arm64 Ubuntu 24.04 cloud image — there is no x86 path.
- **Lima installed.** The harness invokes `limactl` at `/opt/homebrew/bin/limactl` (Homebrew default);
  `brew install lima`. Override the binary path with `COWORK_LIMACTL` if it lives elsewhere.

**Lifecycle.** Boot (or reuse) the VM once, then run scenarios at the tier:

```bash
cowork-harness vm init            # boot the L2 VM for the current config (slow first time)
cowork-harness vm status          # show the instance and its state
cowork-harness run my-scenario.yaml   # the tier comes from the scenario's `fidelity: microvm` field, NOT a flag
cowork-harness vm delete          # stop + remove this config's VM
cowork-harness vm prune           # remove orphaned cowork-vm-* VMs from past configs
```

The instance name is `cowork-vm-<config-hash>` — derived from a hash of the full Lima config (mounts,
image, staged agent version). A config or agent-version change yields a **new** name, so a stale VM is
never silently reused; the old one is orphaned until `vm prune` (or `limactl delete`). Pin a fixed name
with `COWORK_LIMA_INSTANCE`.

Every `vm` subcommand takes an optional **baseline** (`vm delete desktop-<version>`; default `latest`) and
acts on the VM derived from it. The argument is never the `cowork-vm-<hash>` name `vm status` prints: a
VM name, or any baseline that doesn't exist, fails with a usage error (exit 2) that lists the committed
baselines and, for a VM name, which of them derive that VM on this machine. A VM name isn't accepted
because the mapping isn't one-to-one — several baselines can share a VM, and the hash depends on the
local install paths. Remove an orphaned VM with `vm prune`.

**Troubleshooting:**
- **`limactl … failed` / binary not found** — Lima isn't installed or isn't at the expected path. Install
  it (`brew install lima`) or set `COWORK_LIMACTL` to the real `limactl`.
- **A run errors with "microvm <instance> never finished provisioning (…)"** — the VM is Running but
  its provisioning (the apt/toolchain install and the agent symlink) did not complete. Before a run uses
  a Running VM, the harness checks that Lima's boot scripts finished and the agent is on PATH: a VM still
  provisioning is waited for (up to `COWORK_VM_PROVISION_TIMEOUT_S`, default 900 s), and one whose egress
  firewall was applied before provisioning finished (whether provisioning is still stuck or has since given
  up) is restarted once to recover. If provisioning ended without the agent, or the restart failed or did
  not help, delete it and retry: `cowork-harness vm delete`.
  `vm status` shows the state (`provisioning` in its JSON output; the text output appends it when the
  VM is Running but not ready), and so does `doctor --tier microvm`.
- **A run errors with "not mounted — VM not provisioned for this harness config"** — the VM predates a
  config change (its mounts don't match). Recreate it: `cowork-harness vm delete && cowork-harness vm init`.
- **Egress allowed/denied looks wrong** — the guest firewall and the proxy URL must point at the same
  gateway. The default Apple-VZ user-network gateway is `192.168.5.2`; override with `COWORK_VM_GATEWAY`
  (a canonical IPv4 literal — an invalid value is rejected, as it feeds the guest iptables rule),
  and the proxy port with `COWORK_VM_PROXY_PORT` (unset, the host binds an OS-assigned free port;
  `8899` is only the guest-config fallback when a VM is spawned without an explicit port — not the
  effective default of a normal run). The harness threads one resolved
  gateway value into both the iptables allow rule and the agent's `HTTP(S)_PROXY`, so set the env var
  rather than editing one side.
