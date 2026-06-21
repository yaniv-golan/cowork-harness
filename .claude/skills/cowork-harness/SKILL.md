---
name: cowork-harness
description: Test or debug a Claude Code skill/plugin under Claude Cowork's runtime — sandboxed agent, default-deny egress, the can_use_tool permission/question protocol — using the cowork-harness CLI. Use when validating or regression-testing a skill, authoring or debugging a scenario YAML (prompt + scripted answers + assert:), choosing a fidelity tier, scripting AskUserQuestion / tool-permission answers, or asserting artifacts, egress, or sub-agent dispatch. Especially when a harness run no-ops an assertion, fails on an unanswered gate, false-greens, a steered answer never reaches the model, or a web_fetch is unexpectedly denied or gated. NOT for generic unit testing (pytest/vitest of your own scripts) or non-Cowork CI. Covers the skill / run / chat / record / replay / trace / decide / assert / scaffold commands and the session-vs-scenario split.
metadata:
  author: cowork-harness
  version: 0.8.0
  tracks-harness: cowork-harness 0.8.0 (baseline desktop-1.14271.0)
---

# cowork-harness

This skill teaches you to drive the **`cowork-harness` CLI** — a fixture that runs a Claude Code
skill the way **Claude Cowork** runs it (sandboxed agent, default-deny egress, the permission /
AskUserQuestion control protocol). It is *not* the CLI itself: you still invoke `cowork-harness …`
in the shell; this skill tells you how to author scenarios, pick a fidelity tier, choose an answer
path, place assertions in the right CI lane, and avoid the harness's "✓ passed ≠ actually correct"
traps.

The single most important idea: **a green run is not automatically a correct run.** The harness has
several ways to *silently* no-op a check (skip an assertion on replay, auto-answer a gate, observe
an empty egress allowlist). This skill exists mostly to keep you out of those traps — the Gotchas
section below is the highest-value part. Read it.

> **Version note:** the facts and `file:line` pointers here track `cowork-harness 0.8.0` (baseline
> `desktop-1.14271.0`). If your checkout is newer, prefer the live `--help`, `SPEC.md`, and
> `docs/*.md` over this snapshot, and re-run the bundled linter.

## 0. Preflight — make sure the harness can actually run

Before the first command, confirm the CLI is reachable and **fail loud** (never fake a pass) when a tier's dependencies are missing:

- **CLI on PATH, recent enough?** Run `cowork-harness --version` — this skill needs **≥ 0.8.0** (the commands/assertions it teaches: `assertions --list`, `scaffold <run-id>`, `trace --view dispatches`, `artifact_json` incl. the `in:` operator, `verify-cassettes`, batch `record <dir>`/`--rerecord-stale`, record-time redaction, multiSelect/`answer:`, `verify-run`, `record --max-artifact-bytes`, `verify-cassettes --allow-domain`/`--allow-email`/`--allow-file`, scenario `skills:` staleness scoping, `chat --plugin`, and `/help` in the chat REPL). If it's missing *or older than 0.8.0*, prefix every command with `npx` using a version floor: `npx cowork-harness@>=0.8.0 <cmd>` (Node ≥ 20). The floor matters — plain `@latest` would silently fetch an older CLI and the new commands would fail as "unknown command"; `@>=0.8.0` instead **fails loud** if no compatible version is published. To install once instead: `npm i -g cowork-harness@latest`.
- **Agent binary (every tier).** The staged Claude Code agent is **bind-mounted** from a local Claude Desktop install, or point `COWORK_AGENT_BINARY` at a `claude-code-vm/<ver>/claude` ELF. Nothing is bundled. No agent → no run; report that, don't skip silently.
- **Docker / Lima.** Only `--fidelity protocol` (L0) runs without them. `container` / `microvm` / `hostloop` / `cowork` need Docker (Lima for L2). If they're absent, drop to `--fidelity protocol` and **say so** — a green that never exercised the sandbox is not a sandbox pass.
- **Auth.** `CLAUDE_CODE_OAUTH_TOKEN` (preferred) or `ANTHROPIC_API_KEY`, via env or `.env`.

## 1. Pick the loop

- **"Is it even alive?"** (inner loop) → `cowork-harness skill <folder> "<prompt>"`. Fastest; no
  scenario file.
- **Repeatable, asserted regression** → author a `scenarios/*.yaml` and run `cowork-harness run`.
  This is the CI-grade path and most of this skill.
- **Multi-turn debugging** → `cowork-harness chat` (interactive; gates answered at the TTY, **not** an
  asserted test — see *Debugging with `chat`* in `docs/scenario.md`).

Full command set: `skill · run · chat · record · replay · verify-cassettes · verify-run · trace ·
decide · gates · answer · scaffold · assertions (assert deprecated) · sync · list · boundary-check · vm <init|status|delete|prune>`. Always check `cowork-harness <cmd> --help`.

## 2. Two files: session vs scenario

- **`sessions/*.yaml`** — pre-prompt setup: `model`, mounts (`folders`), and discovery
  (marketplaces / plugins / skills / mcp). One session is reused by many scenarios. A scenario that
  omits `session:` gets an all-defaults **inline** session (not a file on disk).
- **`scenarios/*.yaml`** — the test: `prompt`, scripted `answers:`, and `assert:`.

This split matters: release ground truth (`baseline:` / `baselines/`, produced by `sync`) is
**separate** from authored setup (`session:` / `sessions/`). "profile" is retired vocabulary — do
not use it. See `references/scenario-schema.md` for every field.

## 3. Discovery: how the skill-under-test gets mounted

The skill is **copied fresh into the sandbox each run**. Wire it via `plugins.local_plugins` +
`plugins.enabled: [<plugin>@local]` in the session (or `--marketplace` / `--plugin` flags on
`skill`). A missing mount source is now a **hard error** (`mount source(s) not found …`); set
`COWORK_HARNESS_SOFT_MISSING=1` to fall back to warn-and-exclude. Mount names are always derived from
the folder basename (collision-resolved); there is no `to:` override. See `references/scenario-schema.md`.

## 4. Choose a fidelity tier

| Tier | What it gives you | Use when |
|---|---|---|
| `protocol` | Fastest; no sandbox, no egress | Pure protocol/answer-shape tests. **Rejected** if the scenario asserts egress. |
| `container` | Real sandbox + real default-deny egress (**default**) | Most functional + boundary tests. |
| `microvm` | VM-grade escape **isolation** (macOS arm64). Egress transport is the *same allowlist proxy as `container`* — not better network fidelity | Testing untrusted code escape, not network behavior. |
| `hostloop` / `cowork` | Production split-exec (host runs the loop, guest runs tools) | Highest-fidelity / parity runs. |

Set the tier in the **scenario's `fidelity:` field**, not a flag — `run` rejects `--fidelity`
(it's a `skill`-only flag). See `references/fidelity-and-answers.md`.

## 5. Choose an answer path (gates: AskUserQuestion + tool-permission)

Default to **deterministic**: scripted `answers:` + `on_unanswered: fail`. Anything that brings a
live model into answering flags the run `nonDeterministic` — keep those out of deterministic
regressions.

| Path | How | Deterministic? |
|---|---|---|
| Scripted | `answers:` rules + `on_unanswered: fail` | ✅ (the CI/agent default) |
| LLM decider | `on_unanswered: llm` (YAML) **or** `--decider-llm` (CLI) | ❌ flags nonDeterministic |
| Spawned helper | `--decider-cmd '<helper>'` | depends on helper |
| In-band (driving agent) | `--decider-dir <dir>` (+ a Monitor) | depends |

Exact accepted values (teach precisely): `--on-unanswered` takes `fail|prompt|first` on `skill`,
only `fail|first` on `run`. **`llm` is NOT an `--on-unanswered` value** — the bare flag
`--on-unanswered llm` is rejected (use `--decider-llm`); the YAML spelling is `on_unanswered: llm`.
The word `agent` is **retired** — do not write `on_unanswered: agent` (the schema rejects it).
`--on-unanswered first` is itself flagged `nonDeterministic` — it is *not* a deterministic stand-in
for scripted answers. See `references/fidelity-and-answers.md`.

### External deciders and the "first" shorthand

When using `--decider-cmd` or `--decider-dir`, the helper's output is passed through
`coerceLabel` **with the "first" shorthand disabled**. This means a helper that returns the literal
string `"first"` must match an actual label named `"first"` — it is **not** coerced to option 1.
This prevents a helper bug (accidentally emitting `"first"`) from silently green-ing option 1.

The `"first"` shorthand remains active only for the built-in `--on-unanswered first` path. If you
write an external helper, return a label name or option index — never the bare word `"first"` unless
your gate actually has a label called `"first"`.

## 6. Assertions: two orthogonal axes

Conflating these is the **biggest landmine**. An assertion key has two independent properties:

- **Axis A — robust to LLM phrasing drift?** Structural/boundary keys (`subagent_dispatched`,
  `egress_*`, `file_exists`, `user_visible_artifact`, `result`) are robust. Free-text content is
  not: match prose with `transcript_matches` / `transcript_contains` (stable lexical markers only —
  not semantic content the model paraphrases, which re-records red); check structured JSON with YAML
  `artifact_json` (or the pytest lane for complex predicates), not via a transcript substring.
- **Axis B — survives `replay`?** *Independent of Axis A.* On the token-free `replay` lane, only
  **content keys** evaluate; filesystem / egress keys are **silently skipped** (live-only). A key
  being "robust" says nothing about whether it runs on your replay gate.

Getting Axis B wrong means a check that **silently does nothing in CI**. The harness now warns
loudly when it skips, and the bundled linter catches it before you push — run it (§9).

See `references/scenario-schema.md` for the full assertion catalog with each key's replay class.

## 7. web_fetch (fail-closed, two-path)

`web_fetch` behaves unlike `curl`. A URL is gated by **provenance**, not the egress allowlist:

- A URL is *provenanced* iff it appeared in the **prompt** or a **prior `web_fetch` result**. To
  make a fetch succeed, put the URL in the prompt.
- **Provenanced** → fetches (still SSRF-guarded per redirect hop); the egress hostname allowlist is
  **not consulted**.
- **Not provenanced** → raises a per-domain approval gate (`webfetch:<domain>`) that is
  **fail-closed** (it is *not* auto-allowed; `--on-unanswered first` won't allow it). Answer it with
  a scripted rule (`when_tool: "webfetch:<domain>"` + `grant: domain|once`), a session
  `web_fetch.approved_domains`, or a live decider.

Surprise to remember: adding a host to `egress.extra_allow` is a **no-op** for a provenanced fetch.
Full model in `references/scenario-schema.md`.

## 8. Run, then lock determinism

Read the verdict and the inline failing transcript. To pin a flaky-because-stochastic gate, paste
the echoed `--answer "<q>=<choice>"` footer lines back into the scenario's `answers:` for a
deterministic re-run. Use `cowork-harness trace <id>` to digest a run. If only an *assertion* is wrong (the
run itself was fine), `cowork-harness verify-run <run-dir> <scenario.yaml>` re-checks the `assert:` block against
a **kept** run dir (`--keep`, or a `--session-id` run) with no live re-record — tokens-free, ~1s per iteration.

Run artifacts are written to `~/.cowork-harness/runs/…` by default — **outside any working tree**, so a run
launched from a repo root never drops sensitive skill inputs/outputs into it. Pass `--run-dir <path>` (or set
`COWORK_HARNESS_RUNS_DIR`) to relocate; in CI point it at a workspace path so an artifact-upload step can
collect the runs.

### Interpreting verdict signals

The run verdict may include `WARN`-severity signals in addition to pass/fail. One to watch for:

- **`prompt_asset_missing`** — the run proceeded but a prompt asset referenced by the scenario was
  not found. The model ran against an incomplete prompt. This is a `WARN`, not a hard failure, so
  the run can still green. If you see it, fix the asset path — a green with a missing asset is
  not a valid pass.

## 9. Scaffold a valid scenario, lint before you push, then place in CI

Don't hand-write the YAML from memory — that's how invented keys (`assertions:` vs `assert:`,
`json_file`, `answer_policy`) creep in. Start from the bundled generator, which emits the
known-good skeleton (right tier, scripted `answers:` + `on_unanswered: fail`, content assertions
separated from live-only ones, one concern per item) and **self-lints its own output**:

```bash
S="${CLAUDE_PLUGIN_ROOT}/skills/cowork-harness/scripts/scenario.py"
# Working from a repo checkout instead of an installed plugin?
# S=".claude/skills/cowork-harness/scripts/scenario.py"
python3 "$S" scaffold --name report-check --skill ./skills/report-gen \
  --prompt "Generate the weekly report to outputs/report.md." \
  --content 'weekly report' --artifact outputs/report.md \
  --egress-allowed api.weather.example.com --out scenarios/report-check.yaml
```

Then lint every scenario — it encodes the no-silent-false-green invariants. Use the CLI wrapper
`cowork-harness lint` (it runs the same bundled `scenario.py lint`):

```bash
cowork-harness lint scenarios/*.yaml
```

`lint` flags: filesystem/egress-only assertions on a `replay` gate (silent no-op), bad regex
quoting, an egress assert on `protocol` fidelity, a `controlOut`-gated key on a non-`controlOut`
replay, mixed-class assertion items, and hallucinated schema (`assertions:` vs `assert:`, unknown
keys). Exit code is non-zero on errors (CI-friendly). `scaffold` auto-upgrades the tier if you ask
for egress on `protocol`, so it never emits a scenario `lint` would reject.

CI placement: a **token-free `replay` PR gate** (content/structure only) + a **nightly live `run`**
(filesystem/egress). See `references/ci-recipe.md` for the four-stage pipeline.

## 10. Debugging with `chat`

`cowork-harness chat` opens an interactive multi-turn REPL against a live Cowork session. It is
**not** an asserted test — no `assert:` block, no cassette. Use it to explore behavior, reproduce a
bug interactively, or test a prompt before committing it to a scenario.

**`--plugin <dir>` flag (repeatable).** Load additional skill folders alongside the primary session
plugin. Each `--plugin <dir>` appends the folder to `local_plugins`. Useful when the skill-under-test
depends on a sibling plugin:

```bash
cowork-harness chat --plugin ./skills/report-gen --plugin ./skills/shared-utils
```

**Note:** `--raw` mode (native `docker run -it`) can't honor the harness-managed flags, so `--upload`,
`--folder`, `--plugin`, and `--fidelity` are **rejected** with a usage error if combined with `--raw`;
only `--model` is carried through.

**`/help` in the REPL.** Type `/help` at the prompt to see available commands:

```
Commands: /exit  /quit  /help
```

The startup banner now reads `type your message (/help for commands)` as a reminder. `/exit` and
`/quit` both terminate the session.

## Gotchas — the "✓ passed ≠ correct" landmines

Stated as *symptom → why → fix*. The full catalog (with `file:line`) is in the references; these
are the ones that bite hardest.

1. **An assertion passed but tested nothing on the PR gate.** *Why:* on a manifest-less cassette
   `replay` skips filesystem/egress keys (`file_exists`, `user_visible_artifact`, `artifact_json`,
   `egress_*`, `no_delete_in_outputs`, `self_heal_ran`, `transcript_no_host_path`); a *mixed* item like
   `{result, egress_denied}` greens on `result` while its `egress_denied` half is dropped. (`record`
   snapshots an `artifacts` manifest, which makes `file_exists`/`user_visible_artifact`/`artifact_json`
   replay-checkable — but the live-only egress keys stay skipped.) *Fix:* put egress/live-only checks on
   a live gate; keep one concern per `assert:` item; run the linter. The harness warns loudly on skip.

2. **A steered gate answer never reached the model.** *Why:* `serializeDecision` must emit
   `updatedInput: { questions, answers }`; a header-only gate (empty `question`) can never be keyed.
   *Fix:* give every gate a non-empty `question`. (multiSelect gates ARE supported on **every** answer
   channel: scripted `choose:` list, in-band `--decider-dir` via a repeated `--choose` / a JSON-array
   reply, and `--decider-cmd` via a JSON-array reply — all deliver the same `", "`-joined wire shape.
   Free-text "Other" via `answer:`. Do NOT hand-write a multiSelect reply as a bare comma-joined
   string — send an array; a scalar is treated as one selection.) `question_asked` / `questions_count_max` /
   `gate_answers_delivered` only evaluate on replay **with a `controlOut` cassette** — re-record an
   old cassette or they're excluded (loudly), not vacuously passed. `gate_answers_delivered` *fails*
   on unobserved delivery (absence of evidence is failure, not neutral).

3. **A multi-key `assert:` item is an AND.** A single list item with more than one key passes iff
   **every** key passes. *Fix:* one concern per item unless you genuinely mean conjunction (and a
   mixed-class conjunction still loses its filesystem half on replay — see gotcha 1).

4. **`tool_called` doesn't mean "attempted".** Tool counts are authoritative and de-duped: a tool
   that was *requested then denied* does **not** register as called. *Fix:* don't assert `tool_called`
   to prove an attempt; it proves the tool actually ran.

5. **`subagent_declared_but_unused` fires on declared-but-didn't-use-THAT-tool**, even if the
   sub-agent used other tools. And `subagent_dispatched` matches by dispatch **description** too —
   skills often dispatch with no `subagent_type` (`agentType:"unknown"`), so match the description.

6. **`dispatch_count_max` asserts but does NOT enforce.** The harness records the count; it does not
   reproduce Cowork's skip-on-cap (`{perTask:1, global:3}`, deferred). Passing means "happened to
   dispatch ≤N this run," not "the harness capped it." Don't read enforcement into the assert.

7. **`protocol` is rejected (not silently passed) if the scenario asserts egress** — boundary
   assertions need a sandboxed tier (`container`+). Good: this one fails loud by design.

8. **Read-only mounts are enforced; delete-deny is not.** `mode:r` mounts get a real `:ro` bind
   (a write fails in-guest). But `rw` vs `rwd` (write-but-no-delete on `outputs/` / connected folders) is
   *not* mount-enforced — `rm` succeeds and is only caught post-hoc by `no_delete_in_outputs`.

9. **Keep `.env` out of any mounted folder** — it is copied into the sandbox and the token could
   leak. Put it at a working-dir or install root (token resolution: env > `--dotenv` > `./.env` >
   install `.env`).

10. **A base64 artifact that was scrubbed at record time will fail artifact assertions at replay.**
    When `record` detects a secret embedded in a base64 artifact, it replaces the entire artifact
    body with `[REDACTED:base64]` and emits a `::warning::`. Any `artifact_json` or content
    assertion targeting that artifact will fail at replay because the body no longer matches. *Fix:*
    do not let secrets flow into artifacts; if the artifact is intentionally opaque, drop the
    content assertion and gate on `file_exists` on the live lane instead.

11. **An external decider returning `"first"` does not select option 1.** The `"first"` keyword
    shorthand is disabled for `--decider-cmd` / `--decider-dir` helpers (see §5). If your helper
    accidentally emits `"first"` and no label named `"first"` exists, the gate fails — it does
    **not** silently pick the first option. This is intentional: a helper bug should fail loud, not
    green wrong. *Fix:* have helpers return a label name or numeric index.

12. **`prompt_asset_missing` is a WARN, not a hard failure — greens can hide it.** The
    `prompt_asset_missing` verdict signal (see §8) does not block a green verdict. Scan the verdict
    signals section after every run; a run that greened with this signal ran against an incomplete
    prompt. *Fix:* treat `prompt_asset_missing` as a blocking error in CI by checking the signals
    array.

For the complete gotcha list, the assertion catalog, the YAML schema, the fidelity/answer tables,
and the CI recipe, read the files in `references/`.

## References

- `references/scenario-schema.md` — scenario/session YAML schema, full assertion catalog (with each
  key's replay class), the web_fetch model, and the complete gotcha list.
- `references/fidelity-and-answers.md` — fidelity tiers, answer paths, the determinism contract.
- `references/ci-recipe.md` — replay-vs-live lane split and the four-stage GitHub Actions pipeline.
- `scripts/scenario.py` — `scaffold` a valid scenario skeleton and `lint` scenarios for the
  no-silent-false-green invariants (both usable as CI steps).
