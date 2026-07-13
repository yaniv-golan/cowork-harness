---
name: cowork-harness
description: Test or debug a Claude Code skill/plugin under Claude Cowork's runtime — sandboxed agent, default-deny egress, the can_use_tool permission/question protocol — using the cowork-harness CLI. Use when validating or regression-testing a skill, authoring or debugging a scenario YAML (prompt + scripted answers + assert:), choosing a fidelity tier, scripting AskUserQuestion / tool-permission answers, or asserting artifacts, egress, or sub-agent dispatch. Especially when a harness run no-ops an assertion, fails on an unanswered gate, false-greens, a steered answer never reaches the model, or a web_fetch is unexpectedly denied or gated. NOT for generic unit testing (pytest/vitest of your own scripts) or non-Cowork CI. Covers the skill / run / chat / record / replay / trace / decide / assertions / scaffold commands and the session-vs-scenario split.
metadata:
  author: cowork-harness
  version: 0.32.0
  tracks-harness: cowork-harness 0.32.0 (baseline desktop-1.20186.1)
---

# cowork-harness

This skill teaches you to drive the **`cowork-harness` CLI** — a fixture that runs a Claude Code
skill the way **Claude Cowork** runs it (sandboxed agent, default-deny egress, the permission /
AskUserQuestion control protocol). It is *not* the CLI itself: you still invoke `cowork-harness …`
in the shell; this skill tells you how to author scenarios, pick a fidelity tier, choose an answer
path, place assertions in the right CI lane, and avoid the harness's "✓ passed ≠ actually correct"
traps.

The single most important idea: **a green run is not automatically a correct run.** The harness has
several ways to no-op a check while still producing a green run (skip an assertion on replay — now
flagged with a loud `::warning::`, not silent — auto-answer a gate, observe an empty egress
allowlist). This skill exists mostly to keep you out of those traps — the Gotchas section below is
the highest-value part. Read it.

> **Version note:** the facts and `file:line` pointers here track `cowork-harness 0.32.0` (baseline
> `desktop-1.20186.1`). If your checkout is newer, prefer the live `--help` and — in a repo checkout —
> `SPEC.md` / `docs/*.md` over this snapshot, and re-run the bundled linter.

## Preflight — make sure the harness can actually run

The 10-second inner loop, once the CLI is on PATH:

```bash
cowork-harness doctor                       # prerequisites OK? (Docker, agent, token, baseline)
cowork-harness skill ./my-skill "do X"      # run the skill once against the staged agent
```

Before the first command, confirm the CLI is reachable and **fail loud** (never fake a pass) when a tier's dependencies are missing:

- **One-shot check.** Run `cowork-harness doctor [--tier <tier>]` first — a read-only prerequisite check that inspects Docker, the staged agent, the token, and the baseline in one pass. The bullets below explain each thing it checks (and how to fix it).
- **Replay-only? Skip `doctor`.** Replaying committed cassettes needs no Docker, no staged agent, and no token — and every tier's `doctor` validates the auth token (the live tiers also Docker + the staged agent), so a ✗ there is expected, not a blocker. Go straight to `cowork-harness replay <cassette>`.
- **CLI on PATH, recent enough?** Run `cowork-harness --version` — this skill needs **≥ 0.32.0**. If it's missing or older, prefix every command with the version floor `npx "cowork-harness@>=0.32.0" <cmd>` (Node ≥ 20), or install once with `npm i -g "cowork-harness@>=0.32.0"`. **Pin `@>=0.32.0`, never `@latest`** — `@latest` can silently fetch an older CLI and the new commands fail as "unknown command", whereas the floor **fails loud** if no compatible version is published.

  What the ≥ 0.32.0 floor gates, by release:

  - **core set (pre-0.21.0 vintage, or mixed):** `assertions --list`, `scaffold <run-id>`, `trace --view dispatches`, `artifact_json` incl. the `in:` operator (passes when the resolved value deep-equals one of the listed members — value ∈ your list, not the reverse), `verify-cassettes` incl. the `--allow-domain`/`--allow-email`/`--allow-patterns-file` allows (`--allow-patterns-file <path>` is a FILE of patterns, one regex per line — not a path to allow, unlike `--allow <regex>`), batch `record <dir>`/`--rerecord-stale`, `record --concurrency <N>`, record-time redaction, multiSelect/`answer:`, `verify-run` answer-coverage, `record --max-artifact-bytes`, live record-time deciders, scenario `skills:` staleness scoping with `COWORK_HARNESS_AGENT_SCOPE=skill`, `chat --plugin`, and `/help` in the REPL.
  - **0.21.0:** `verify-cassettes --allow-path` (`path` — local absolute filesystem paths — is the scanner's 4th class), and `hostloop`'s native host/VM process split with its `allow_host_writes:` consent field.
  - **0.22.0:** `computer_links_resolve`.
  - **0.28.0:** `semantic_matches` (an LLM judge grades a fixed `rubric` of claims against the run's answer — **live-only**, so it is evidence-unavailable / skipped-loud on replay, never a vacuous pass), and **glob-matched** `tool_called`/`tool_not_called`/`subagent_tool_used`/`subagent_tool_absent` (a pattern like `mcp__workspace__*` matches any tool in the family; exact names match exactly).
  - **0.30.0:** resolved sub-agent identity on dispatch records (`resolvedAgentType`/`resolvedModel`), the five path-gate assertion keys `no_vm_path_file_op`/`vm_path_denied`/`path_denied`/`no_path_denied`/`subagent_file_write`, and the session-level `agent_env` knob.
  - **0.31.0:** the `lint-skill` (static host-loop footgun + `subagent_type` resolution linter) / `analyze-skill` (advisory `/sessions`-path static scan, `--strict`, `analyze-skill: ignore` marker) / `probe-dispatch` (single-dispatch mechanics probe) commands, `status --latest-for` (resolve a scenario's newest run dir by run time, not directory mtime), the `subagent_dispatch_healthy` composite assertion, and the persisted `result.json` fields `verdict`, `subagents[].referencesRead`/`subagents[].reasoning`, plus the `toolCounts`/`toolErrors`/`toolDurations` shape distinction.
  - **0.32.0:** `analyze-skill`'s directory scan now covering a skill/plugin's full contract surface (recursive `agents/`/`references/`/`commands/`, plugin-root-aware, symlink-following) with line/block-scoped `analyze-skill: ignore-next-line`/`ignore-start`/`ignore-end` markers and multi-path/glob input, and `lint-skill`'s provable in-plugin `subagent_type` typo now a WARN that gates under `--strict`.
- **Agent binary (sandboxed live tiers — `container`/`microvm`/`hostloop`/`cowork`).** The staged Claude Code agent is **bind-mounted** from a local Claude Desktop install, or point `COWORK_AGENT_BINARY` at a `claude-code-vm/<ver>/claude` ELF. Nothing is bundled. `protocol` (L0) and `replay` need no staged agent; for the sandboxed tiers, no agent → no run; report that, don't skip silently.
- **Docker / Lima.** Only `--fidelity protocol` (L0) runs without them. `container` / `microvm` / `hostloop` / `cowork` need Docker (Lima for L2). If they're absent, drop to `--fidelity protocol` and **say so** — a green that never exercised the sandbox is not a sandbox pass.
- **Auth.** `CLAUDE_CODE_OAUTH_TOKEN` (preferred) or `ANTHROPIC_API_KEY`, via env or `.env`. Minting an OAuth token needs the **`claude` CLI** (`npm i -g @anthropic-ai/claude-code`, then `claude setup-token`).
- **`--dotenv` is a GLOBAL flag — put it BEFORE the subcommand.** `cowork-harness --dotenv .env record …`, never `cowork-harness record … --dotenv .env`. Every *other* flag is subcommand-level, so muscle memory fights this one; the harness rejects the misplaced form with an exact-fix error, but placing it first avoids the round-trip.

## Orient — the three loops

Everything you do with the harness is one of **three loops**, and the rest of this skill is organized
into three Parts to match: **author** a scenario (Part I), **run / record / lock** it into a
reproducible regression (Part II), and **debug** a run that misbehaved or greened when it shouldn't
(Part III — reachable straight from here in one hop). Pick the loop you're in:

- **"Is it even alive?"** (inner loop) → `cowork-harness skill <folder> "<prompt>"`. Fastest; no
  scenario file.
- **Repeatable, asserted regression** → author a `scenarios/*.yaml` and run `cowork-harness run`.
  This is the CI-grade path and most of this skill.
- **Regression-test your skill's ANSWER quality** (not just its behavior — does its guidance still lead to
  correct answers after you edit it?) → author `semantic_matches` scenarios and gate on the per-claim
  profile. See **Recipe 5** in `references/task-recipes.md` (validity, N≥3, discrimination — the traps).
- **A run failed — or greened and you don't trust it** (the debugging loop) → don't re-run and hope.
  The run already wrote its evidence to a **kept run dir** (`~/.cowork-harness/runs/…`; `--keep` prints
  the path, `trace <run-id>` finds it). **Localize the failure post-hoc** from that evidence:
  `cowork-harness trace <run-dir>`'s views + the emitted `result.json` to see what the run actually did,
  then `verify-run` to re-check a suspect assertion — all token-free, no Docker, no re-record. This is
  the loop 0.32.0's observability is built for; the *Triage* and *Inspecting a run's observability
  output* sections in **Part III — Debug** are the detail (the fuller human-facing map lives in
  `docs/debugging.md` — repo-only, not shipped with the installed skill).
- **Multi-turn / interactive reproduction** → `cowork-harness chat` (interactive; gates answered at the
  TTY, **not** an asserted test — see *Debugging with `chat`* in **Part III — Debug**).

Full command set: `skill · run · chat · record · replay · verify-cassettes · rehash · prune · lint ·
lint-skill · analyze-skill · probe-dispatch ·
verify-run · trace · inspect · diff · stats · decide · gates · answer · scaffold · assertions --list · sync ·
list · boundary-check · status · vm <init|status|delete|prune> · doctor · init-redact`. Always check `cowork-harness <cmd> --help`.

**Two different `scaffold` tools — don't confuse them.** The native `cowork-harness scaffold <run-id>`
above turns an already-*recorded* run into a scenario (needs a run to exist first). The bundled
`scripts/scenario.py scaffold --name … --skill …` — see *Scaffold a valid scenario, then lint before
you push* in **Part I** — builds a scenario from flags alone, no run required. Passing that section's
flag set to the native command fails with `unknown flag: --name` (exit 2).

## Part I — AUTHOR a scenario

Everything below composes one deterministic, asserted `scenarios/*.yaml`: the session/scenario split,
how the skill mounts, the fidelity tier, the answer path, the two assertion axes, `web_fetch`
provenance, and the scaffold/lint tools that keep the YAML honest.

### Two files: session vs scenario

- **`sessions/*.yaml`** — pre-prompt setup: `model`, mounts (`folders`), and discovery
  (marketplaces / plugins / skills / mcp). One session is reused by many scenarios. A scenario that
  omits `session:` gets an all-defaults **inline** session (not a file on disk).
- **`scenarios/*.yaml`** — the test: `prompt`, scripted `answers:`, and `assert:`.

This split matters: release ground truth (`baseline:` / `baselines/`, produced by `sync`) is
**separate** from authored setup (`session:` / `sessions/`). "profile" is retired vocabulary — do
not use it. See `references/scenario-schema.md` for every field.

### Discovery: how the skill-under-test gets mounted

The skill is **copied fresh into the sandbox each run**. Wire it via `plugins.local_plugins` +
`plugins.enabled: [<plugin>@local]` in the session (or `--marketplace` / `--plugin` flags on
`skill`). A missing mount source is now a **hard error** (`mount source(s) not found …`); set
`COWORK_HARNESS_SOFT_MISSING=1` to fall back to warn-and-exclude. Mount names are always derived from
the folder basename (collision-resolved); there is no `to:` override. See `references/scenario-schema.md`.

> **`git add` a brand-new skill before testing it.** Inside a git repo the harness stages the
> **git-tracked** files (the fidelity boundary — real Cowork installs from a repo and sees only committed
> files). *Tracked* means **in the git index** (committed **or** `git add`-staged); the **content** staged
> is your **working tree**, so an uncommitted edit to an already-tracked file *is* tested — you needn't
> commit to iterate. Only brand-new (untracked) files must be `git add`-ed to appear. Commit before you
> record the **locking cassette**, though: real Cowork ships the *committed* tree, so a green on
> uncommitted edits isn't yet a green on what installs. An **all-untracked** skill folder used to mount *empty* and the agent reported "the skill isn't
> installed" then did the work itself — a green-looking run where the skill never loaded. That now
> **hard-fails** (`BoundaryError`, exit 3) naming the dir, and a partially-tracked folder emits a loud
> `::notice:: [stage]` listing the excluded files. Fix: `git add` the skill, or `COWORK_HARNESS_GITSET=0`
> to copy untracked files (won't reflect what ships). A folder **outside** any repo is copied raw (no guard).

### Choose a fidelity tier

| Tier | What it gives you | Use when |
|---|---|---|
| `protocol` | Fastest; no sandbox, no egress | Pure protocol/answer-shape tests. **Rejected** if the scenario asserts egress. |
| `container` | Real sandbox + real default-deny egress (**default**) | Most functional + boundary tests. |
| `microvm` | VM-grade escape **isolation** (macOS arm64). Egress transport is the *same allowlist proxy as `container`* — not better network fidelity | Testing untrusted code escape, not network behavior. |
| `hostloop` / `cowork` | Production split-exec: the agent loop is a **native process on the host** (no container around the file tools — matching production), with native Bash/WebFetch disabled and routed host-side via the workspace SDK-MCP server into a Docker VM sidecar | Highest-fidelity / parity runs. A writable connected folder needs `allow_host_writes: true` (see scenario-schema.md). |

Set the tier in the **scenario's `fidelity:` field**, not a flag — `run` rejects `--fidelity`
(it's a `skill`/`chat` flag; `run` takes fidelity only from the scenario). See
`references/fidelity-and-answers.md`.

### Choose an answer path (gates: AskUserQuestion + tool-permission)

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

**Which gates to anchor (re-record robustness).** The model rewords option labels (and sometimes the
question) every run, so a brittle exact-label `choose:` is itself a re-record-fragility source — it drifts and
forces a re-record. The practical rule: **label-anchor only the gates whose choice drives an `assert:`** (or
materially changes behavior); for gates whose answer is immaterial to your assertions, `on_unanswered: first`
is the more re-record-robust choice — accept the `nonDeterministic` flag rather than trade it for a flaky
anchor. (When label *order* is stable but the text drifts, a positional `choose` is the middle option — the
linter flags positional `choose` as order-dependent, so use it deliberately.) The caution stands: `first`
*masks* an unanswered gate, so don't use it for a gate you actually need answered a specific way.

#### External deciders and the "first" shorthand

When using `--decider-cmd` or `--decider-dir`, the helper's output is passed through
`coerceLabel` **with the "first" shorthand disabled**. This means a helper that returns the literal
string `"first"` must match an actual label named `"first"` — it is **not** coerced to option 1.
This prevents a helper bug (accidentally emitting `"first"`) from silently green-ing option 1.

The `"first"` shorthand remains active only for the built-in `--on-unanswered first` path. If you
write an external helper, return a label name or option index — never the bare word `"first"` unless
your gate actually has a label called `"first"`.

### Assertions: two orthogonal axes

Conflating these is the **biggest landmine**. An assertion key has two independent properties:

- **Axis A — robust to LLM phrasing drift?** Structural/boundary keys (`subagent_dispatched`,
  `egress_*`, `file_exists`, `user_visible_artifact`, `result`) are robust. Free-text content is
  not: match prose with `transcript_matches` / `transcript_contains` (stable lexical markers only —
  not semantic content the model paraphrases, which re-records red); check structured JSON with YAML
  `artifact_json` (or the pytest lane for complex predicates), not via a transcript substring.
- **Axis B — survives `replay`?** *Independent of Axis A.* On the token-free `replay` lane, only
  **content keys** evaluate; filesystem / egress keys are skipped (live-only) — loudly, via an
  `::warning::` annotation, not a silent no-op. A key
  being "robust" says nothing about whether it runs on your replay gate.

Getting Axis B wrong means a check that **does nothing in CI** — the harness warns loudly when it skips
(an `::warning::` annotation, not a silent no-op — see the Axis B bullet above), and the bundled linter
catches it before you push — run it (see *Scaffold a valid scenario, then lint before you push* below).

See `references/scenario-schema.md` for the full assertion catalog with each key's replay class.

#### Which assertion for which question (goal → key)

Beyond the outcome/content keys most scenarios reach for first (`result`, `transcript_*`,
`file_exists`/`user_visible_artifact`, `artifact_json`), the harness surfaces the agent's *behavior*
— tool health, sub-agent work, panels, skill attribution, resources — as assertable keys. Reach for
them by what you're trying to prove:

| You want to check that… | Reach for |
|---|---|
| the skill didn't error out of a tool | `tool_no_error: <regex>`, `max_tool_errors: <N>` |
| it didn't waste repeated identical calls | `max_redundant_tool_calls: <N>` |
| a deliverable reached the user | `user_visible_artifact: <path>` (+ `no_scratchpad_leak: true` if it delivers via `present_files` — **`container` only**) |
| a to-do workflow finished | `all_tasks_completed: true`, `task_status: {match, status}` |
| a skill / connector / tool was **offered** | `skill_available`, `connector_available`, `tool_available` (all `<regex>`) |
| a skill actually **ran** (or must NOT) | `skill_triggered: <regex>`, `no_skill_triggered: <regex>` |
| a tool ran **inside** a skill's scope | `skill_tool_used: {skill, tool}` |
| a sub-agent did the work | `subagent_output_contains: {contains}`, `subagent_dispatched: <regex>`, `dispatch_count_max: <N>` |
| a pre-existing input wasn't mutated (incl. `uploads/**`) | `input_unmodified: <glob>` or `[<glob>, …]` (live/verify-run; not microvm) |
| a resource ceiling held | `max_peak_rss_bytes: <N>` (**live-only**) |
| a hook blocked / didn't block a tool | `hook_blocked: <regex>`, `no_hook_blocked: true` (replay needs a `controlOut` cassette) |
| every MCP round-trip succeeded | `no_mcp_error: true` (**live-only**) |
| a context compaction happened | `compaction_occurred: true` |

Every one of these still obeys the two axes above — several are live-only or need a `controlOut`
cassette on replay, so check the catalog's replay class before putting one on a PR gate.
`cowork-harness assertions --list` prints the full, always-current key set with one-line semantics
straight from the schema — treat it (and the catalog) as the source of truth; this map is a
goal-oriented index into it, not a second catalog.

### web_fetch (fail-closed, two-path)

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

### Scaffold a valid scenario, then lint before you push

Don't hand-write the YAML from memory — that's how invented keys (`assertions:` vs `assert:`,
`json_file`, `answer_policy`) creep in. Start from the bundled generator, which emits the
known-good skeleton (right tier, scripted `answers:` + `on_unanswered: fail`, content assertions
separated from live-only ones, one concern per item) and **self-lints its own output**. The
generator is the bundled `scripts/scenario.py` — installed as a plugin, point `S` at
`${CLAUDE_PLUGIN_ROOT}/scripts/scenario.py`; from a repo checkout, use the literal path below:

```bash
S=".claude/skills/cowork-harness/scripts/scenario.py"
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
quoting, an egress assert on `protocol` fidelity, `transcript_no_host_path` on `hostloop`/`protocol`
(ERROR — fails by design at those tiers; WARN on `fidelity: cowork`, whose tier resolves per the
baseline's host-loop gate), non-empty `requires_capabilities` on `protocol` without
`allow_missing_capability` (ERROR — the capability probe can't run there, so the run hard-fails as
unverifiable), a `controlOut`-gated key on a non-`controlOut` replay, mixed-class assertion items,
and hallucinated schema (`assertions:` vs `assert:`, unknown keys). Exit code is non-zero on errors
(CI-friendly). `scaffold` auto-upgrades the tier if you ask for egress on `protocol`, so it never
emits a scenario `lint` would reject.

## Part II — RUN, RECORD & LOCK

You have an authored scenario. This Part runs it, reads the verdict, locks it into a
byte-deterministic cassette, checks a background run's liveness, and places the assertions in the
right CI lane.

### Run, then lock determinism

Read the verdict and the inline failing transcript. To pin a flaky-because-stochastic gate, paste
the echoed `--answer "<q>=<choice>"` footer lines back into the scenario's `answers:` for a
deterministic re-run. Use `cowork-harness trace <id>` to digest a run. If only an *assertion* is wrong (the
run itself was fine), `cowork-harness verify-run <run-dir> <scenario.yaml>` re-checks the `assert:` block against
a **kept** run dir (`--keep`, or a `--session-id` run) with no live re-record — tokens-free, ~1s per iteration.
When the scenario declares `answers:`, verify-run **also** checks they still match the run's actual gates (a
reworded gate or a `choose:` the run never offered fails here in ~1s instead of on a paid re-record). Or skip
the discovery/encode/record dance entirely and answer gates **live during the recording** with
`record --decider-dir`/`--decider-llm` (the cassette is flagged non-deterministic but replays deterministically).

**Author answers WITHOUT re-paying — the cheap loop.** You don't need a fresh paid record to discover a
scenario's gates or their labels: `--keep` ONE run, then `cowork-harness trace <run-dir> --view questions`
(and `verify-run`) read the gates + offered option labels out of that run's `events.jsonl` for free. Iterate
your `answers:` against that kept run, then record once. **But the kept run is a snapshot:** if you change the
skill's gate phrasing afterward, re-`--keep` — verify-run's answer-coverage *refuses* (exit 2, "predates the
current skill") rather than vouch against stale labels, but the trace/inspect path can't warn you, so re-keep
deliberately. (Same fail-closed family: corrupt gate evidence — unparseable `events.jsonl` lines, or fewer
gates than `trace.json` recorded questions — and a structurally invalid `result.json` also refuse rather
than certify.) (A token-free probe of "which gates fire" isn't possible — gates are model-decided per run.)

Run artifacts are written to `~/.cowork-harness/runs/…` by default — **outside any working tree**, so a run
launched from a repo root never drops sensitive skill inputs/outputs into it. Pass `--run-dir <path>` (or set
`COWORK_HARNESS_RUNS_DIR`) to relocate; in CI point it at a workspace path so an artifact-upload step can
collect the runs.

#### Validate a skill against real documents (not a cassette)

The loops above build **deterministic regressions**. A different job — drive a skill against *real* input
documents to judge whether it actually does the work (extraction, analysis), with no intent to record a
cassette — has its own recipe:

1. **Explore with the LLM decider.** `cowork-harness skill <dir> --decider-llm --intent "<one line of what
   this run is testing>"` lets a model (Sonnet default) answer each gate steered by your intent. The model replies with
   the option **number** and the harness maps it to the exact label (so it can't whiff by mis-typing the
   label text); an out-of-set answer fails loud. This is exploration, **not** a deterministic regression —
   the run is flagged non-deterministic and a green here is not a scripted pass. The answering model
   defaults to a Sonnet id (a weaker model tends to prose-decline an ambiguous judgment gate → fail-loud);
   override it with `--decider-model <id>` — a cheaper model (e.g. Haiku) for simple gates to cut cost,
   or Opus for the hardest judgment gates; it won't make an under-specified gate deterministic. A live
   decider can false-green a semantic assertion on an oracle-less gate — see `references/fidelity-and-answers.md`.
2. **Script the load-bearing gates — especially binary confirm gates.** Once you know which gates fire
   (`trace <run-dir> --view questions`), pin the ones whose choice drives the outcome with
   `--answer "<q>=<label>"` / `--answer-policy <yaml>`. When a skill **re-words its option labels run-to-run**
   (LLM-authored gates), pin a **stable leading substring** instead of the full label — `--answer
   "<q>=Israeli company"` binds whichever option starts with `Israeli company`. It is uniqueness-guarded and
   **fails loud** if the anchor ever matches two options (the documented trade: drift-tolerance, not strict
   CI reproducibility — for that, pin a full exact label or a free-text `answer:`).
3. **Budget ~1 re-run per file.** If a gate whiffs, the run no longer vanishes — it exits non-zero but
   **salvages a PARTIAL run** (the extraction the agent already did is written to disk). So the cost of a
   missed gate is one re-run with a better `--intent` or a scripted answer, not a lost paid run.
4. **Inspect the outputs to judge correctness.** `cowork-harness inspect <run-dir>` shows what the run
   produced — the artifacts plus a shallow field preview of each JSON artifact (e.g. the extracted figures).
   It works on a salvaged partial run too. (A partial run is marked `PARTIAL`; `verify-run` and `scaffold`
   refuse to treat its half-finished output as a passing result.)
5. **For image-only / scanned PDFs, use the full-parity image.** The default agent image omits OCR and
   PDF-table tooling; if a **scenario** sets `requires_capabilities` (a scenario field — not skill
   frontmatter) and the image provably omits one, the harness **aborts before the paid run (exit 3)** —
   unless the scenario asserts `allow_missing_capability: true`, which downgrades it to a notice and
   proceeds. Rebuild with `--build-arg COWORK_FULL_PARITY=1` and point `COWORK_AGENT_IMAGE` at it for those
   skills.

#### Interpreting verdict signals

The run verdict may include `WARN`-severity signals in addition to pass/fail. One to watch for:

- **`prompt_asset_missing`** — the run proceeded but a prompt asset referenced by the scenario was
  not found. The model ran against an incomplete prompt. This is a `WARN`, not a hard failure, so
  the run can still green. If you see it, fix the asset path — a green with a missing asset is
  not a valid pass.

### Checking whether a background run is alive

Never use `ps aux` to check on a `cowork-harness` run you launched in the background — it only sees
processes in your OWN PID namespace, which is frequently NOT the harness process's namespace (e.g. when
you're a sandboxed subagent). An empty `ps aux` match tells you nothing about whether the run is still
going.

Use **`cowork-harness status <dir> [--follow]`** instead — reads `<outDir>/status.json`, a file the
harness writes/updates throughout the run's lifecycle (including a crash-safety net for a thrown
error/`SIGTERM`, AND staleness detection for a hard `SIGKILL`/OOM-kill that no exit handler can catch —
either way you get `"error"`/`stale` instead of a permanently-trusted `"running"`), so liveness is
checkable regardless of PID namespace. The harness prints `[status] <outDir>` to stderr as soon as the
run starts, so capture stderr to get the exact directory. `--follow` fails loud on a timeout/staleness
rather than hanging forever. (Fuller recipe in `docs/run-status.md` — repo-only, not in the installed
payload; `cowork-harness status --help` has the flags.)

**A multi-minute `record`/`run` outlives a short-lived wrapper.** Don't launch a long record from a
subagent that returns before it finishes — the returning agent tears down its process tree and kills the
in-flight run mid-artifact-write. Run it foreground, or detached from any process that will exit first.
(The `status.json` liveness above is exactly what surfaces such a teardown as `"error"`/`stale` rather
than a stuck `"running"`.)

### Place assertions in the right CI lane

CI placement: a **token-free `replay` PR gate** (content/structure only) + a **nightly live `run`**
(filesystem/egress). Fastest setup: `uses: yaniv-golan/cowork-harness@main` (a packaged GitHub Action with a
PR job-summary reporter). See `references/ci-recipe.md` for the Action, the manual step-by-step form, and
the four-stage pipeline.

## Part III — Debug

A run misbehaved, or greened when you don't trust it. Debugging is a first-class loop, not an
afterthought: the run already wrote its evidence, so you **localize the failure post-hoc** rather than
re-run and hope. Start at the triage below, then use the observability output and, when you need to
reproduce interactively, `chat`.

### Triage — a run misbehaved, or a green looks wrong

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

**Is it your skill's bug, or a known harness gap?** Before deep-debugging a wrong behavior, rule out a
**deliberate fidelity gap** — the harness intentionally does *not* reproduce a few real-Cowork behaviors,
so a "bug" you see here that real Cowork also has isn't yours to fix. The tier semantics are in
`references/fidelity-and-answers.md` (shipped); the specific deltas vs. real Cowork and the sandbox
boundary model live in `docs/fidelity-gaps.md` / `docs/boundary.md` (repo-only, not in the installed
payload). If the behavior is on that gap list, it's expected — stop debugging your skill.

### Inspecting a run's observability output

A verdict is only the top of what a run records, and the run dir persists after the verdict
(`~/.cowork-harness/runs/…`). Beyond pass/fail, every `run`/`skill`/`chat` writes a `result.json` and a
trace you read back without a re-record — the debugging loop is *localize the failure from that
already-written evidence*, not re-run-and-hope. Use them to diagnose a failure (and, secondarily, to
decide which assertions from *Assertions: two orthogonal axes* are worth adding):

- **`cowork-harness trace <run-dir> --view <view>`** — focuses one of the run's rollups (the per-tool
  call-count/timing table, the sub-agent dispatch tree, the gate lifecycle, the tool/error rollups, …);
  bare `trace` digests the whole run. The view set is actively being extended — run `trace --help` for
  the current list rather than relying on a fixed enumeration here.
- **`cowork-harness stats [--metric <m>]`** — aggregate across the run index: `cost`, `duration`,
  `tokens`, `cache-tokens`, `model-cost`, `turns`, `pass-rate`.
- **`result.json` carries the raw fields** the assertions read: `verdict`, `toolDurations`, `models`, `toolErrors`,
  `redundantToolCalls`, `modelUsage`, `thinking`, `skillActivity`, `subagents[]` (prompt/`dispatchModel`/
  `resolvedModel`/output/`attributedSkillId`, `outputTruncated`, `referencesRead`, `reasoning`/`reasoningElided`),
  `context` (tools/mcpServers/availableSkills), `tasks`,
  `workspaceFiles`, `presentedFiles`, `hookEvents`, `mcpErrors`, `contextEvents`, `resources`
  (`probeFailures` distinguishes a failed sample from a tier that was never sampleable). Provenance/
  evidence-health fields: `command` (`run`/`skill`/`record`/`chat`/`replay` — finer than `mode`),
  `gateProvenance` (per-gate `scripted`/`decided(llm|external)`/`first-option`/`prompt` with a
  `bySource` histogram), `evidenceErrors` (dropped/malformed telemetry lines per stream, incl.
  `egressParse`), `fingerprint.frozen` (replay only — marks the shown staleness fingerprint as the
  cassette's record-time value, not a fresh recompute), and `assertTextTruncated` (companion to
  `outputTruncated` on a matched tool result). Three separately-shaped rollups, easy to conflate in a
  `jq` recipe: `toolCounts` is a flat `{tool: number}` call-count map, `toolErrors` is
  `{tool: {calls, errors}}`, and `toolDurations` is `{tool: {calls, totalMs, maxMs}}`. (Full per-field
  semantics: the README's "Observability fields" section — repo-only; `schema/run-result.json` is the
  machine source.)
- **Opaque failure?** A failed run also records **`errorSource`** (where the failure originated) and
  **`stderrLogPath`** (the captured agent stderr) — read those and `trace <run-dir>` *before* re-running;
  a re-record rarely tells you more than the captured stderr already does. Also check
  **`resultErrorKind`** (`"transport" | "agent" | "usage_limit"`) before spending another paid run: a
  `"usage_limit"` failure is a quota exhaustion, not a skill bug — retry after the limit resets rather
  than debugging; `"transport"`/`"agent"` means something actually broke, worth localizing before
  re-running.
- **Attributing cost to sub-agent work.** `subagents[]` gives the dispatch tree — each sub-agent's
  `dispatchModel`/`resolvedModel`, `toolsUsed`, `prompt`/`output`, and `attributedSkillId` — but **not** its own token/cost;
  aggregate cost is per-**model** in `modelUsage` (and `trace --view usage`), not per-sub-agent. So a
  cost spike from fan-out reads as `trace --view dispatches` (how many, which agent) against that model's
  per-model usage — the harness doesn't line-item each sub-agent's tokens.
- **Debugging a wrong Cowork UI panel.** Each panel is reconstructed in `result.json`: **Progress** =
  `tasks[]`, **Working folder** = `workspaceFiles[]` (classified output/mount/input, with a
  `trace --view files` diff), **Context / Connectors** = `context` (tools / mcpServers / availableSkills),
  **Scratch-pad → outputs** = `presentedFiles[]`. If a panel looks wrong in a run, read its field.

### Debugging with `chat`

`cowork-harness chat` opens an interactive multi-turn REPL against a live Cowork session. It is
**not** an asserted test — no `assert:` block, no cassette. Use it to explore behavior, reproduce a
bug interactively, or test a prompt before committing it to a scenario.

Each session still writes an informational `result.json` (`mode: "chat"`, no `assertions`) plus a
trace and index row under its run dir — the same telemetry (tool durations, model usage, resources,
etc.) that `run`/`skill` produce — so `cowork-harness trace <chat-run-dir>` / `stats` work on a chat
session too, even though it never yields a verdict.

**`--plugin <dir>` flag (repeatable).** Load additional skill folders alongside the primary session
plugin. Each `--plugin <dir>` appends the folder to `local_plugins`. Useful when the skill-under-test
depends on a sibling plugin:

```bash
cowork-harness chat ./skills/report-gen --plugin ./skills/shared-utils
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

Stated as *symptom → why → fix*. **This is the full landmine catalog;** `references/scenario-schema.md`
repeats the assertion/replay-relevant ones alongside the schema (a scoped subset, not a fuller list).

1. **An assertion passed but tested nothing on the PR gate.** *Why:* on a manifest-less cassette
   `replay` skips filesystem/egress keys (`file_exists`, `user_visible_artifact`, `artifact_json`,
   `egress_*`, `no_delete_in_outputs`, `self_heal_ran`, `transcript_no_host_path`); a *mixed* item like
   `{result, egress_denied}` greens on `result` while its `egress_denied` half is dropped. (`record`
   snapshots an `artifacts` manifest, which makes
   `file_exists`/`user_visible_artifact`/`artifact_json`/`computer_links_resolve`
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
   sub-agent used other tools. `subagent_dispatched` / `subagent_output_contains` match on dispatch
   type (`dispatchAgentType`), the binary-*resolved* type (`resolvedAgentType`), *or* the dispatch
   **description** — so a type-less dispatch that resolved to e.g. `general-purpose` is still
   selectable, by either the resolved type or the description. A `Task` dispatch that carries NO
   `subagent_type` at all falls back to the built-in `general-purpose` agent with a **wildcard tool
   surface** (`tools:["*"]`, including workspace bash) — faithful production behavior, and it fires
   routinely. The harness warns loudly on this fallback and records `subagents[].dispatchTypeOmitted`;
   an *explicit* `subagent_type: "general-purpose"` is a deliberate author choice and does not warn.
   Implication: `subagent_tool_absent` on a type-less dispatch is weaker evidence (wildcard surface) —
   pin `subagent_type` explicitly when you need a tight tool-absence guarantee.

   **Cross-tier "no shell" caveat.** On `hostloop`, native `Bash` calls route through the
   `mcp__workspace__bash` alias, so a "sub-agent used no shell" check must glob **both** `Bash` and
   `mcp__workspace__*` to hold across every tier.

6. **`dispatch_count_max` is an author-chosen budget, not a production cap.** It's a post-hoc count
   assertion: passing means "happened to dispatch ≤N this run," nothing more. Cowork imposes **no**
   in-conversation `Task`-dispatch cap — gate `1648655587`'s `{perTask:1, global:3}` governs the
   separate scheduled/cron-task session scheduler, not the `Task` tool (binary-verified; details in
   `SPEC.md` §10 — repo-only). So there is no "skip-on-cap" for the harness to reproduce; use this key
   only to catch a fan-out you don't want.

7. **`protocol` is rejected (not silently passed) if the scenario asserts egress** — boundary
   assertions need a sandboxed tier (`container`+). Good: this one fails loud by design.

8. **Read-only mounts are enforced; delete-deny is not.** `mode:r` mounts get a real `:ro` bind
   (a write fails in-guest). But `rw` vs `rwd` (write-but-no-delete on `outputs/` / connected folders) is
   *not* mount-enforced — `rm` succeeds and is only caught post-hoc by `no_delete_in_outputs`.

9. **Keep `.env` out of any mounted folder** — it is copied into the sandbox and the token could
   leak. Put it at a working-dir or install root (token resolution: env > `--dotenv` > `./.env` >
   install `.env`). **Inverse footgun — running from a git worktree:** a worktree's `./.env` is gitignored, so
   it's **absent** there and you'll get "no model credentials." *Fix:* pass `--dotenv <main-checkout>/.env`
   (or set the env var) — that's exactly what `--dotenv` is for.

10. **A base64 artifact that was scrubbed at record time will fail artifact assertions at replay.**
    When `record` detects a secret embedded in a base64 artifact, it replaces the entire artifact
    body with `[REDACTED:base64]` and emits a `::warning::`. Any `artifact_json` or content
    assertion targeting that artifact will fail at replay because the body no longer matches. *Fix:*
    do not let secrets flow into artifacts; if the artifact is intentionally opaque, drop the
    content assertion and gate on `file_exists` on the live lane instead.

11. **An external decider returning `"first"` does not select option 1.** The `"first"` keyword
    shorthand is disabled for `--decider-cmd` / `--decider-dir` helpers (see *Choose an answer path*
    → External deciders). If your helper
    accidentally emits `"first"` and no label named `"first"` exists, the gate fails — it does
    **not** silently pick the first option. This is intentional: a helper bug should fail loud, not
    green wrong. *Fix:* have helpers return a label name or numeric index.

12. **`prompt_asset_missing` is a WARN, not a hard failure — greens can hide it.** The
    `prompt_asset_missing` verdict signal (see *Interpreting verdict signals*) does not block a green verdict. Scan the verdict
    signals section after every run; a run that greened with this signal ran against an incomplete
    prompt. *Fix:* treat `prompt_asset_missing` as a blocking error in CI by checking the signals
    array.
13. **`result: success` means the agent didn't error, NOT that the task completed — always assert on
    artifacts/content.**
    - A turn that ends on a plain-text re-ask ("which file did you mean?") still reports
      `result: success`.
    - The harness catches this with a **`stalled`** verdict signal: a run that ends on a question and
      did **no productive work after its last gate** — both the no-gate case ("which file?" with no
      tool calls) AND the *answered-gate-then-re-ask* case (the agent answers an `AskUserQuestion`,
      then asks again in plain text and stops). Suppress with `allow_stall: true` if ending on a
      question is intended.
    - The signal is a **tool-position heuristic**, not deliverable detection, so it is imprecise both
      ways:
      - **False negative:** a post-gate tool *call* clears the flag whether it **succeeded or
        errored** — an agent that ran a tool after the gate and still stalled is not caught.
      - **False positive:** a deliverable written *before* a final confirmation gate does **not**
        clear it, so a write-then-confirm-then-question run is flagged — use `allow_stall: true` for a
        deliberate confirm-terminal skill.
    - The broad guard is therefore YOUR assertions — assert the deliverable (`file_exists` /
      `artifact_json` / `transcript_matches`), never just `result: success`.
    - `on_unanswered` governs **unanswered** `AskUserQuestion` gates; the `stalled` signal covers
      stalling *after* one is answered — two different failure modes.
    - **Free-text aside:** a "type-it-in-notes" option has **no scripted deterministic answer** today
      (the `OTHER:` directive works only on the LLM-decider path, not scripted `choose:`; on an
      options-bearing gate a bare out-of-set LLM answer fails loud (exit 2) — see the LLM-decider
      free-text note in `references/fidelity-and-answers.md`).
14. **A positional `choose` (`first` / index) is order-dependent.** `choose: "2"` survives label drift
    but NOT option *re-ordering* — if the gate presents its options in a different order run-to-run, the
    index lands on a different option (a silent re-record flake). Prefer an exact label when order is
    stable; `lint` flags positional `choose` with an advisory.
15. **A scripted `choose:` matching no offered option HARD-fails the run — `on_unanswered: first` does NOT
    backstop it.** This is distinct from an *unanswered* gate (no rule matched → falls to `on_unanswered`): a
    rule that DID match the gate but whose `choose:` names a label the gate never offered (the model reworded
    it) is treated as an authoring bug and fails loud — `first`/`llm` won't absorb it. The error now prints the
    **offered options** (and a closest-match suggestion), so fix the anchor from the error alone — no need to
    dig through `events.jsonl`. (This is exactly the drift `verify-run` answer-coverage catches in ~1s; use it
    before a paid record.)
16. **Batch record keeps going — you don't need a one-at-a-time wrapper.** `record <dir>` and `record <dir>
    --rerecord-stale` run **every** scenario, collect failures, and report them at the end (non-zero exit on
    any failure) — a failing scenario does NOT abort the batch. So a single `cowork-harness record cassettes/
    --rerecord-stale` surfaces ALL stale anchors in one pass (add `--concurrency <N>` to parallelize); a shell
    wrapper that loops one cassette at a time with `set -e` defeats this and rediscovers stale anchors serially.
    Two durability properties make the batch safe to trust: each cassette is written **atomically** (a
    same-directory temp file + rename), so an interrupted or OOM-killed batch never leaves a partial/corrupt
    cassette — a failed scenario simply produces none; and under `--concurrency <N>` each scenario runs **fully
    isolated** (its own egress sidecar network + proxy, its own per-session run dir), so parallel records don't
    cross-talk — the concurrency bound exists only for the Docker address pool + API rate limits, not correctness.

17. **Editing `scenarios/*.yaml` `assert:` does NOT change a plain `replay`.** *Why:* `replay` evaluates the
    assertions **frozen in the cassette** by default — it is byte-deterministic and ignores the working tree (so
    a committed cassette can't silently re-interpret against an uncommitted YAML). This used to be a *silent*
    no-op; now plain `replay` prints a `::notice::` when a sibling's `assert:` differs and points you at the fix.
    *Fix:* to re-check token-free against the edited block, `replay --assert-from <scenario.yaml>` (or
    `--reassert`). That opt-in path is safe by construction for the authored fields — it **hard-fails** if
    `prompt`/`answers`/`baseline`/`fidelity`/`skills`/`requires_capabilities` or the skill content (when a
    fingerprint exists) drifted from the recording (re-record then), and `expect_denied`/filesystem/egress keys
    are sourced but stay **live-only** (it warns; they don't move the replay verdict). **Caveat:** the `session`
    (model / data mounts / discovery) is NOT drift-checked or fingerprinted, so a **model change** between record
    and re-assert is undetected — the notice flags this; re-record if the session changed. `verify-run` reads
    on-disk `assert:` against a kept *run dir*; `replay --assert-from` is the equivalent for a *cassette*.

18. **`questions_count_max` counts sub-questions, not gates.** One `AskUserQuestion` tool call can
    bundle several sub-questions into a single gate; the assertion counts each sub-question, so a
    3-sub-question bundle counts as 3, not 1. `trace --view questions` shows the same per-gate
    sub-question count and a matching footer total — read that off instead of the tool-call count when
    sizing the budget.

19. **`gate_answers_delivered` passes vacuously when no gate fires — use `gate_answer_count_min: 1` to
    also require a gate.** Whether a gate fires is model-dependent, so `gate_answers_delivered: true`
    alone can't catch "the gate never fired at all"; pair it with `gate_answer_count_min` when
    presence matters, not just delivery.

20. **A `mode: r` connected folder's contents are recorded body-less, not excluded.** `record` captures a
    read-only folder's files as path + hash only (`truncated: true`, no `body`) — it's an input the agent
    read, not a deliverable it wrote. `file_exists`/`computer_links_resolve` still pass against it on replay
    (the hash-only entry still materializes a placeholder); `artifact_json` reports a clear
    evidence-unavailable on every lane (live/verify-run/replay agree — no green-record/red-replay). This is
    also why a `mode: r` input never trips the `binary` privacy finding or needs `--allow` — only a
    *committed* body is scanned. `scaffold` won't emit `file_exists` for one either (it's not in
    `RunResult.artifacts`). A `mode: rw`/`rwd` folder's contents are captured with a full body, same as
    `outputs/`.

21. **A `fidelity: cowork` cassette can go stale in a way `skill`/`format` drift won't catch.** Its recorded
    `effectiveFidelity` field pins which concrete tier (`hostloop` or `container`) the baseline resolved to
    AT RECORD TIME. If a later Desktop baseline flips that resolution, `verify-cassettes` reports it as a
    `resolved-tier` finding (re-record — the recording now exercises the wrong tier); a cassette with no
    `effectiveFidelity` at all, or an unloadable pinned `baseline:`, reports `unverifiable-tier` instead
    (couldn't check — also re-record). Both are `fidelity: cowork`-only; an explicit-tier scenario never
    produces them. (Details: `docs/cassette.md` § tier staleness — repo-only.)

For the assertion catalog, the YAML schema, the fidelity/answer tables, and the CI recipe, read the
files in `references/` (the gotchas above are the full list; the references repeat only the
assertion/replay-relevant ones).

## References

- `references/task-recipes.md` — end-to-end recipes for the four jobs fleet owners actually hit:
  evolve a cassette's `assert:` (usually no re-record), audit a fleet for tier drift, set up
  redaction before the first hostloop/protocol record, derive budget assertions without a
  two-pass record. Start here when the question is "how do I do X", not "what does flag Y mean".
- `references/scenario-schema.md` — scenario/session YAML schema, full assertion catalog (with each
  key's replay class), the web_fetch model, and an assertion/replay-scoped gotcha subset (the full
  landmine catalog lives in this SKILL's Gotchas section above).
- `references/fidelity-and-answers.md` — fidelity tiers, answer paths, the determinism contract.
- `references/ci-recipe.md` — the packaged GitHub Action, replay-vs-live lane split, and the four-stage
  GitHub Actions pipeline.
- `scripts/scenario.py` — `scaffold` a valid scenario skeleton, `lint` scenarios for the
  no-silent-false-green invariants (both usable as CI steps), and `resolve-agent-types <plugin-dir>`
  (validates a pinned `subagent_type` against the plugin's own `plugin.json` + `agents/*.md`).
- Checking a background run's status without `ps aux` — covered in *Checking whether a background run is
  alive* (Part II) above; the fuller recipe is in `docs/run-status.md` (repo-only, not shipped with the
  installed skill).
