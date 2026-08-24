---
name: cowork-harness
description: Test or debug a Claude Code skill/plugin under Claude Cowork's runtime — sandboxed agent, default-deny egress, the can_use_tool permission/question protocol — using the cowork-harness CLI. Use when validating or regression-testing a skill, authoring or debugging a scenario YAML (prompt + scripted answers + assert:), choosing a fidelity tier, scripting AskUserQuestion / tool-permission answers, or asserting artifacts, egress, or sub-agent dispatch. Especially when a harness run no-ops an assertion, fails on an unanswered gate, false-greens, a steered answer never reaches the model, or a web_fetch is unexpectedly denied or gated. Also when iterating or hardening a skill across fixes, or grounding a skill's self-critique against its own run evidence — including a document-analysis skill (cap table, deck, financial model, transcript) that needs an uploaded file attached to be critiqued at all. NOT for generic unit testing (pytest/vitest of your own scripts) or non-Cowork CI. Covers the skill / run / chat / record / replay / trace / decide / assertions / scaffold commands and the session-vs-scenario split.
metadata:
  author: cowork-harness
  version: 2.1.0
  tracks-harness: cowork-harness 2.1.0 (baseline desktop-1.34493.1)
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

> **Version note:** the facts and `file:line` pointers here track `cowork-harness 2.1.0` (baseline
> `desktop-1.34493.1`). If your checkout is newer, prefer the live `--help` and — in a repo checkout —
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
- **CLI on PATH, recent enough?** Run `cowork-harness --version` — this skill needs **≥ 2.1.0**. If it's missing or older, prefix every command with the version floor `npx "cowork-harness@^2.1.0" <cmd>` (Node ≥ 22), or install once with `npm i -g "cowork-harness@^2.1.0"`. **Pin `@^2.1.0`, never `@latest`** — `@latest` can silently fetch an older CLI and the new commands fail as "unknown command", whereas the floor **fails loud** if no compatible version is published.

  This skill documents the CURRENT surface, not release history. If `cowork-harness --version` is
  OLDER than the floor, the per-release record of what you are missing is [CHANGELOG.md](https://github.com/yaniv-golan/cowork-harness/blob/main/CHANGELOG.md)
  — upgrade rather than work around it, since this skill's `file:line` pointers and flag names track the floor.
- **Agent binary (sandboxed live tiers — `container`/`microvm`/`hostloop`/`cowork`).** The staged Claude Code agent is **bind-mounted** from a local Claude Desktop install, or point `COWORK_AGENT_BINARY` at a `claude-code-vm/<ver>/claude` ELF. Nothing is bundled. `protocol` (L0) and `replay` need no staged agent; for the sandboxed tiers, no agent → no run; report that, don't skip silently.
- **Docker / Lima.** Only `--fidelity protocol` (L0) runs without them. `container` / `microvm` / `hostloop` / `cowork` need Docker (Lima for L2). If they're absent, drop to `--fidelity protocol` and **say so** — a green that never exercised the sandbox is not a sandbox pass.
- **Auth.** `CLAUDE_CODE_OAUTH_TOKEN` (preferred), or `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`, via env or `.env`. Minting an OAuth token needs the **`claude` CLI** (`npm i -g @anthropic-ai/claude-code`, then `claude setup-token`).
- **`--dotenv` is a GLOBAL flag — put it BEFORE the subcommand.** `cowork-harness --dotenv .env record …`, never `cowork-harness record … --dotenv .env`. Every *other* flag is subcommand-level, so muscle memory fights this one; the harness rejects the misplaced form with an exact-fix error, but placing it first avoids the round-trip. **One exception: `critique` also accepts `--dotenv` per-command** (`critique <folder> --prompt "…" --dotenv <path>`) — available as of **1.6.0** (documented but unreachable before then); `--run-dir` stays global-only everywhere.

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
- **"What is WRONG with this skill?"** (a graded critique, not a pass/fail) → `cowork-harness critique
  <folder> --prompt "<probe>"`. Four model workloads and 10–20 minutes; budget from
  `report.costUsd.totalUsd`. Reach for it when you want **findings**. **For "what does this skill
  **DO**" — routing, artifact location, narration — use `skill` instead**: no evaluator, a fraction of
  the cost, and it answers that question directly. Report and evidence-package shapes:
  `references/critique.md`.
- **A run failed — or greened and you don't trust it** (the debugging loop) → don't re-run and hope.
  The run already wrote its evidence to a **kept run dir** (`~/.cowork-harness/runs/…`; `--keep` prints
  the path, `trace <run-id>` finds it). **Localize the failure post-hoc** from that evidence:
  `cowork-harness trace <run-dir>`'s views + the emitted `result.json` to see what the run actually did,
  then `verify-run` to re-check a suspect assertion — all token-free, no Docker, no re-record. This is
  the loop 0.32.0's observability is built for; the *Triage* and *Inspecting a run's observability
  output* sections in **Part III — Debug** are the detail (the fuller human-facing map lives in
  [`docs/debugging.md`](https://github.com/yaniv-golan/cowork-harness/blob/main/docs/debugging.md) — repo-only, not shipped with the installed skill).
  **"Evidence" here means the RUN's own record** — events, trace, transcript. `critique`'s evaluator
  grades against a different artifact, `critique-evidence-package.txt`, which none of these tools
  surface; see `references/critique.md`.
- **Multi-turn / interactive reproduction** → `cowork-harness chat` (interactive; gates answered at the
  TTY, **not** an asserted test — see *Debugging with `chat`* in **Part III — Debug**).
  **"Interactive" splits two ways — don't take the wrong branch.** Want to answer gates yourself *and*
  still get an asserted, `assert:`-checked run? That is `--decider-dir` (*Choose an answer path* below),
  **not** `chat`. Reach for `chat` only when you are exploring by hand and do NOT want a verdict.

> **"repo-only" in this skill means "not bundled with the installed SKILL"** — not "unavailable". An
> **npm** install ships `docs/`, `README.md` and `SPEC.md` in the tarball, so try
> `node_modules/cowork-harness/docs/<name>.md` before assuming a pointer dangles. A **plugin**
> install loads a trimmed source-only cache where those pointers genuinely do dangle.

Full command set: `skill · run · chat · record · replay · verify-cassettes · rehash · prune · migrate-run-dir · lint ·
lint-skill · analyze-skill · probe-dispatch ·
verify-run · trace · inspect · diff · critique · stats · decide · gates · answer · scaffold · assertions --list · sync ·
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
> uncommitted edits isn't yet a green on what installs. An **all-untracked** skill folder mounts *empty* and the agent reports "the skill isn't
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

<!-- answer-channels:begin -->
**Pick by asking one question about your situation**, not by scanning a table — the channels are not
interchangeable and the wrong one either masks a gate or can't run at all:

```
Will this run be re-executed UNATTENDED? (CI, a committed cassette, --repeat, --matrix)
│
├─ YES ──► scripted `answers:` / `--answer` / `--answer-policy` + `on_unanswered: fail`
│          The ONLY reproducible channel. Non-negotiable for CI and committed cassettes.
│          Labels reworded every run? STAY HERE: pin a stable leading SUBSTRING
│          (uniqueness-guarded, fails loud) or a positional `choose`. Both keep determinism.
│
└─ NO — a discovery / validation run. Who holds the context to answer?
   │
   ├─ a model, steered by one line of intent
   │        ──► `--decider-llm --intent "<…>"`          [skill · record]
   │            NOT on `run` — there the spelling is the scenario-YAML `on_unanswered: llm`.
   │            Can false-green an oracle-less semantic gate.
   │
   ├─ deterministic logic you can write down
   │        ──► `--decider-cmd '<helper>'`               [skill · run]
   │            Determinism is your helper's, not the harness's. NOT on `record`.
   │
   ├─ YOU, the driving agent, holding the task context
   │        ──► `--decider-dir <FRESH, EMPTY dir>`       [skill · run · record]
   │            + `cowork-harness gates <dir> --follow`  (arm a Monitor here)
   │            + `cowork-harness answer <dir> --gate N --choose "<label>"`
   │            Its ONE unique property: it needs no advance knowledge of the option SET.
   │            (Label *text* drift alone does not need this — substring anchors handle that.)
   │
   └─ a human at a keyboard, and you are NOT producing a test
            ──► `cowork-harness chat`   (TTY; no pass/fail verdict — see below)
```

| Channel | Deterministic? | Don't use it when |
|---|---|---|
| Scripted | ✅ the CI/agent default | you cannot know the option set in advance |
| `--decider-llm` / `on_unanswered: llm` | ❌ nonDeterministic | the gate has no oracle a model could judge |
| `--decider-cmd` | delegated to your helper | the logic needs task context code doesn't have |
| `--decider-dir` | ❌ nonDeterministic | nobody is present to drive it — it BLOCKS per gate |
| `on_unanswered: first` | ❌ nonDeterministic | the answer matters — it *masks* the gate |

**Cost of `--decider-dir`, stated plainly:** flags the run `nonDeterministic`; needs a live driver + a
Monitor, so it is **unusable unattended**; blocks at each gate, strictly serial; needs a fresh empty dir
per run (a dirty one is refused); rejected with `--repeat`, `--on-unanswered`, `--decider-cmd`, and with
`--matrix --concurrency > 1`; and a cassette recorded this way carries a **re-record cost** — regenerating
it needs the driver present again.

**Rehearse it in ~2s before wiring it into a real run** — `cowork-harness decide --decider-dir <dir>` fires
one sample gate through the same channel, then blocks (10-min backstop) until you answer it with the two
commands above. It is the cheapest way to see the protocol work. Full recipe, including the multiSelect
wire shape and the `gates --follow` Monitor loop:
[`docs/decider-dir.md`](https://github.com/yaniv-golan/cowork-harness/blob/main/docs/decider-dir.md)
(repo-only — an npm install ships it at `node_modules/cowork-harness/docs/decider-dir.md`). <!-- npm-only-ok -->

**It is a FEEDER for the scripted default, not a rival.** `record --decider-dir` is a first-class way to
*produce* a cassette: the non-reproducibility is spent once at authoring time and the cassette replays
deterministically forever. The loop is **discover → transcribe → script** — answer live, then paste the
run's echoed `--answer "<q>=<choice>"` footer lines into the scenario's `answers:` so re-records go back to
being unattended. Skip the transcribe step only for one-off/exploratory runs.
<!-- answer-channels:end -->

**For a QUESTION gate, never hand-write the `req-N.json`/`resp-N.json` files.** `gates` and `answer` wrap
the protocol — the atomic temp+rename, the `{id, answers}` envelope, the multiSelect array shape.
Hand-rolling a Monitor over the raw files is the single most common mistake on this channel.

`answer` writes `{id, answers}` and nothing else, so it covers **question gates only**. The channel also
carries **permission**, **dialog** and **elicit** gates, whose replies need `{behavior}` / `{action}` — for
those, write `resp-N.json` yourself, following the `reply_with` template the gate's own `req-N.json`
advertises (it spells out the exact shape, e.g. `{"id":"…","behavior":"allow|deny"}`).

Exact accepted values (teach precisely): `--on-unanswered` takes `fail|prompt|first` on `skill`,
only `fail|first` on `run`. **`llm` is NOT an `--on-unanswered` value** — the bare flag
`--on-unanswered llm` is rejected (use `--decider-llm`); the YAML spelling is `on_unanswered: llm`.
The word `agent` is **retired** — do not write `on_unanswered: agent` (the schema rejects it).
`--on-unanswered` also conflicts with `--decider-dir`/`--decider-cmd`/`--decider-llm` (the channel or
model IS the terminal, so a policy alongside it never applies) — pass one, not both. On `record`, a
scenario setting `on_unanswered: prompt` is rejected too: the YAML field outranks the flag, and a TTY
wait can't produce a deterministic committed fixture.
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

**Drifting label TEXT and an unknowable option SET are different problems — don't reach past the cheap
fix.** Text that rewords while the choices stay the same is a *scripted* problem with a deterministic
answer: a uniqueness-guarded leading substring, or a positional `choose`. Only when you cannot know what
the options will *be* — they're generated per input document, so no anchor can be written in advance — does
the answer move to a live channel (`--decider-dir` if you're driving, `--decider-llm` if nobody is).

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
  `artifact_json` (or the [pytest lane](https://github.com/yaniv-golan/cowork-harness/blob/main/python/README.md) for complex predicates), not via a transcript substring.
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
| an internal name/path did **not** leak into a delivered file | `artifact_text: {artifact, not_contains}` — `artifact_json`'s companion for non-JSON bodies; literal path, no glob, so one entry per delivered surface |
| a named path must **not** exist after the run | `file_absent: <path>` (**live/verify-run only**) — do NOT invert `no_unexpected_files`: that is an allowlist over *newly created* files and needs a pre-run manifest |
| a to-do workflow finished | `all_tasks_completed: true`, `task_status: {match, status}` |
| a skill / connector / tool was **offered** | `skill_available`, `connector_available`, `tool_available` (all `<regex>`) |
| a skill actually **ran** (or must NOT) | `skill_triggered: <regex>`, `no_skill_triggered: <regex>` |
| a tool ran **inside** a skill's scope | `skill_tool_used: {skill, tool}` |
| a sub-agent did the work | `subagent_output_contains: {contains}`, `subagent_dispatched: <regex>`, `dispatch_count_max: <N>` |
| a pre-existing input wasn't mutated (incl. `uploads/**`) | `input_unmodified: <glob>` or `[<glob>, …]` (live/verify-run) |
| no authored interactive artifact silently loses its Submit under Cowork | `no_lost_write_back: true` (**live-only**; static Tier A over the run's authored `.html`/`.py`/`.js`; per-scenario gate for the same class `analyze-skill` scans) |
| a resource ceiling held | `max_peak_rss_bytes: <N>` (**live-only**) |
| the user was **shown** the right choices, in order | `question_options: {when_question, equals}` — the option SET/ORDER a gate offered (`question_asked` matches the text only); order is compared by default |
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
unverifiable), `no_scratchpad_leak` off `container` (ERROR on `protocol`/`microvm`/`hostloop` — hostloop's
`present_files` passes a validated path through without promoting, so there is no scratch→outputs copy
to leak; WARN on `cowork`, whose tier resolves per the baseline gate) or `present_files_called` on
`protocol`/`microvm` (ERROR — served only at `container`/`hostloop`), or `present_files_called`/`no_scratchpad_leak`/`user_visible_artifact` on `lane: remote` (ERROR — the runtime rejects those at scenario load time, so the tier rules are suppressed there), a `controlOut`-gated key on a non-`controlOut` replay, mixed-class assertion items,
and hallucinated schema (`assertions:` vs `assert:`, unknown keys). Exit code is non-zero on errors
(CI-friendly). `scaffold` auto-upgrades the tier if you ask for egress on `protocol`, so it never
emits a scenario `lint` would reject.

**`lint` is the LENIENT check — the loader is the strict one.** An unknown top-level key is a ⚠ WARN in
`lint` (exit 0) but a **hard error** in the runtime (`Unrecognized key: "<k>"`, exit 2) — so a scenario
that lints with warnings may still not run. To check whether a scenario actually loads, without spending:
`cowork-harness record <file.yaml> --dry-run` (exit 2 on a schema error; a directory reports each
`✗ broken:` file and exits 1). Corollary: **the loader** fails LOUD on an unknown key (never silently) —
but **`replay` does not**: a frozen top-level key it doesn't recognize (e.g. `lane:` recorded pre-1.16.0) is
silently ignored and can flip a lane-sensitive verdict green; only frozen **assertion** keys stay
hard-rejected there. Full split + the v11 version-regime:
[docs/scenario.md](https://github.com/yaniv-golan/cowork-harness/blob/main/docs/scenario.md#unknown-keys-the-loader-is-strict-lint-is-lenient).

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
`run` takes no `--dry-run`: to check that a scenario **loads** without spending, use
`cowork-harness record <file.yaml> --dry-run` — it runs the real loader AND the same scenario-level
refusals the real `record` applies (`on_unanswered: prompt`, and an unsatisfiable assert pairing) **plus the
cassette-portability pre-flight below**, so it cannot green something a paid run would reject. On a directory it reports every offender and the batch
cost estimate. `lint` checks the assertion invariants (both above).

**Decide WHERE the cassette lives before you record it — a cassette cannot be moved afterwards.**
Without `--out`, `record` writes `cassettes/<scenario-name-slug>.cassette.json` (gitignored by
default); pass `--out <path>` to put it somewhere tracked, e.g. `examples/replays/<name>.cassette.json`.
That choice is permanent: the cassette rewrites `scenario.session` and `scenarioSource` **relative to
its own directory** at record time, so moving the file later — a different `--out`, a `git mv`, a copy
into another repo — leaves those unresolvable and
`verify-cassettes` reports `unverifiable-skill` ("can't verify ⇒ not green", exit 3) until you
re-record at the new location — or point `replay`/`verify-cassettes` at the session with `--session <file>`, which resolves it without a re-record. Since 2.0.0 a bare `replay` FAILS on this class rather than warning. **`record` now says so BEFORE it spends:** a pre-flight — at the same
pre-spend point as the host-inventory refusal, and in `record --dry-run`, so the rehearsal is free —
warns when the cassette would be written outside the scenario's tree, or when `session:` itself lives
outside it (an absolute or `~` path: the mirror case, invisible to a check that only looks at where the
cassette lands). A warning, not a refusal — an out-of-tree throwaway cassette is legitimate; what was
missing was anything saying so while you could still act. Related: recording at a **host-inheriting** tier
(`protocol`/`hostloop`/`cowork`→hostloop) into a repo-visible path is refused outright (gotcha 25).
The clean answer there is `fidelity: container` (sealed, `HOME=/tmp`, nothing to leak) — **not**
redirecting `--out` outside the repo and moving the file in afterwards, which trades a loud refusal
for a cassette that cannot verify staleness from its own location — recoverable only by passing
`--session <file>` on every invocation thereafter.

**Author answers WITHOUT re-paying — the cheap loop.** You don't need a fresh paid record to discover a
scenario's gates or their labels: `--keep` ONE run, then `cowork-harness trace <run-dir> --view questions`
(and `verify-run`) read the gates + offered option labels out of that run's `events.jsonl` for free. Iterate
your `answers:` against that kept run, then record once. **But the kept run is a snapshot:** if you change the
skill's gate phrasing afterward, re-`--keep` — verify-run's answer-coverage *refuses* (exit 2, "predates the
current skill") rather than vouch against stale labels, but the trace/inspect path can't warn you, so re-keep
deliberately. (Same fail-closed family: corrupt gate evidence — unparseable `events.jsonl` lines, or fewer
gates than `trace.json` recorded questions — a structurally invalid `result.json`, a `command:"replay"`
result (a replay is a re-check of a recorded cassette, not run evidence — verify the original live run dir),
and a `mode:"chat"` result (chat carries no assertions or verdict by contract) also refuse rather than
certify.) (A token-free probe of "which gates fire" isn't possible — gates are model-decided per run.)

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
3. **Budget ~1 re-run per file.** If a gate whiffs, the run does not vanish — it exits non-zero but
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
6. **Iterate across fixes — verify before you trust, and don't cross-pair generations.** A green run is
   not a correct run, and a skill's self-reported finding is not real until its cited evidence is found in
   the run's own output. Ground each finding against `result.json` (`finalMessage` = the skill's own
   answer/critique; `toolResults` = tool outputs) and the tool-call stream via
   `cowork-harness trace <run-dir> --output-format json` — add `--full-results` so a successful call's full
   input + result are captured, not just errored ones. When iterating, tag generations with `--label` and
   pair a critique only with a `result.json` whose `fingerprint.skillHash` **matches** the skill that
   produced it (`inspect`/the run-index row surface a short `skillHash` prefix; `verify-run` warns when a
   kept run predates the current skill). **The hazard is general, not critique-specific:** repeated
   `run`/`skill` invocations of one scenario accumulate in the SAME scenario directory regardless of skill
   version, so a plain `stats <scenario>` silently averages pre-fix and post-fix runs together. Compare
   generations with **`stats <scenario> --group-by skill-hash`** (or narrow with `--skill-hash <prefix>` /
   `--label <tag>`); an un-split window spanning more than one generation now warns.
   **Multi-skill plugin caveat (post-1.7.0 CLIs with `--skill`):**
   skillHash keys the whole MOUNTED plugin, so on a multi-skill plugin the hash alone cross-pairs
   critiques of DIFFERENT skills — pair by the report's `(gradedSkillHash, gradedSkill)` pair. **On a pre-1.5.0 CLI the `skill` lane emits no `fingerprint.skillHash` at all**, so a
   pairing step there silently groups on an absent key instead of erroring — check the field is present, or
   require ≥ 1.5.0. See [`docs/debugging.md`](https://github.com/yaniv-golan/cowork-harness/blob/main/docs/debugging.md)
   (repo-only) for the full loop.

#### Interpreting verdict signals

The run verdict may include `WARN`-severity signals in addition to pass/fail. One to watch for:

- **`prompt_asset_missing`** — the run proceeded but a prompt asset referenced by the scenario was
  not found. The model ran against an incomplete prompt. This is a `WARN`, not a hard failure, so
  the run can still green. If you see it, fix the asset path — a green with a missing asset is
  not a valid pass.

**False negatives — signals that are tier/image artifacts, not skill defects.** Some fail-severity
signals read like a skill gap but are really a property of the reduced test image or the fidelity tier.
Recognize these before "fixing" a non-bug:

- **`missing_capability`** — the lean `core` agent image is a deliberate partial mirror of real Cowork's
  rootfs, so a skill that used `soffice`/LibreOffice (`office_convert`), `tesseract` (`ocr`),
  `markitdown`/`magika` (`ml_extract`), `cv2` (`cv`), `camelot`/`tabula` (`pdf_tables`), or `wand`
  (`magick`) can trip this even though real Cowork **ships** those. The message says so ("likely a FALSE
  NEGATIVE (real Cowork ships them)"). Fix: rebuild full parity (`--build-arg COWORK_FULL_PARITY=1`, point
  `COWORK_AGENT_IMAGE` at it), or — if the skill's fallback is genuinely equivalent — assert
  `allow_missing_capability: true`. (Two sources: a skill *observed using* an omitted family, live lane;
  or a declared `requires_capabilities` the tier can't provide, both lanes — an unknown family name
  hard-fails rather than silently passing.) **On an open-ended `skill` run** (no `assert:` block to carry
  the modifier), pass **`--allow-missing-capability`** — the CLI equivalent of the assertion.
- **`ended_with_question`** (`WARN`, live lane) — a heuristic: the agent's final answer contains a
  question and the run wrote **no deliverable to `outputs/`** — it may have ended on a request for input
  instead of finishing. Warn-only; the fix is scripting/steering the answer (`answer:` / `--answer` / a
  decider, or `--decider-llm --intent`), not editing the skill's prose. The strict, fail-severity sibling
  `stalled` already catches a *trailing*-`?` final turn that did no tool work after the last gate; this
  covers the residual (a mid-message `?`, or tool work after the last gate that still ended asking). Read
  the final message before acting — a legitimate question-posing answer that wrote a file never fires.
  Assert `allow_stall: true` if ending on a question is the intended terminal state.
- **`undelivered_deliverables`** (`WARN`) — the skill produced file(s) **outside every user-visible root**
  and never delivered them. On a **remote** Cowork session the workspace is reclaimed at session end, so
  they are destroyed; on a **local** one they persist but stay invisible to the user. Either way the user
  does not get them. It fires with no assertion written — `present_files_called` covers the positive case
  only when you thought to ask for it, and the runs that most need this are the ones where nobody did.
  **Silent when the evidence cannot answer the question** (no workspace walk, or a tier that runs no
  scratchpad walk, absent delivery telemetry, or a resumed turn) — "cannot tell" never reads as "clean".
  **The fix is lane-dependent.** On `lane: local`, write deliverables under `outputs/` or a connected
  folder, or deliver them explicitly. **On `lane: remote`, moving a file under `outputs/` does NOT help** —
  nothing is delivered by location there, so only an explicit delivery counts. Assert
  **`allow_undelivered_deliverables: true`** when the leftovers are intentional (intermediates, caches,
  downloaded inputs) rather than a delivery gap.
- **`delivery_unobservable`** (`WARN`, `lane: remote` only) — the run produced file(s) but the harness
  serves **no delivery tool on that lane**, so whether they reached the user is unanswerable. This is the
  honest cannot-verify companion to `undelivered_deliverables`: reporting every remote file as undelivered
  would claim more than the evidence supports, and staying silent would read as clean. Mutually exclusive
  with `undelivered_deliverables`, and quiet on a run that produced nothing to deliver. Not a skill defect —
  a harness coverage gap (see the *File delivery* section of fidelity-gaps).
- **`mount_delete`** (`WARN`) — a delete touched a **delete-denied mount other than `outputs`**: a `rw`
  connected folder. Production denies `unlink`/`rmdir` on *every* Cowork FUSE mount until per-mount
  approval, not just outputs — a connected folder shows the identical default — so this run diverged from
  what production would have allowed. `WARN` rather than `FAIL` because the harness **detects** post-hoc
  what production **enforces**: by the time the scan sees it, the agent already proceeded where it would
  have hit `EPERM`, so failing the run would overstate what a post-hoc scan knows. Author
  `no_delete_in_mounts: true` to hard-fail on it, or `allow_delete_in: ["<mount>"]` to waive that mount
  (detection still runs and the hit is still recorded — the waiver is a verdict decision).
- **`host_path_leak`** — skipped at **`hostloop` and `protocol`** fidelity (the agent runs on real host
  paths there, so a host path in model-visible text is expected, not a leak); it is *armed* at
  `container`/`microvm`, but only *fires* on an actual scanned leak with no authored
  `transcript_no_host_path`. At `fidelity: cowork` the skip follows the **resolved** tier, so a `cowork`
  run that lands on `container` is armed. Author `transcript_no_host_path` to enforce cleanliness where
  it's valid.
- **`exec_infra_error`** (`WARN`, host-loop) — one or more container `exec` calls failed for
  infrastructure reasons (daemon/container-level), so those tool calls returned an error to the agent
  rather than the command's own output. Warn-severity because the run's other evidence is intact — unlike
  the fail-severity `infra_error`, where a **supervising process** died and contaminated everything. Note
  a model-requested `timeout_ms` expiry is *not* this: it returns the command's partial output with
  `Command timed out after <duration>` in stderr, matching production. Known gap: if **every** exec
  failed, the agent ran nothing yet the run still only warns — read `result.infraErrors` when a run looks
  suspiciously empty.
- **`scan_unavailable`** (`WARN`) — emitted only on the live lane: `events.jsonl` was missing/corrupt, so
  `RunResult.scan` is undefined and the host-path + outputs-delete guards **did not run this run**. Not a
  pass or a defect — assert `no_delete_in_outputs` / `transcript_no_host_path` to hard-fail on it instead.

The full 17-code signal table (severity + per-signal opt-out) is in
[`references/scenario-schema.md`](./references/scenario-schema.md); [`docs/scenario.md`](https://github.com/yaniv-golan/cowork-harness/blob/main/docs/scenario.md) (repo-only) carries
the fuller narrative.

### Measure — before/after, with/without (`--repeat`, `--ablate-skill`)

A single green proves the run passed **once**. Two questions need more than that, and both have a
discipline that is cheap to follow and expensive to skip.

**"Did it pass, or pass once?"** → `--repeat N` (2-100, on `skill` AND `run`) samples the same
skill+prompt N times and prints a variance rollup instead of a single verdict. `--min-pass-rate` sets
the batch threshold, `--stop-on-diverge` stops the moment flakiness is proven, `--max-budget-usd` caps
spend.

**"Does the skill actually help?"** → `--ablate-skill` runs the prompt with every skill/plugin
discovery source removed, so the agent answers from its own priors. **It is ONE arm, not a paired
experiment**: this invocation is the control. Run the same prompt a second time *without* the flag for
the treatment arm and compare them yourself. Composed with `--repeat 5` it produces **5 ablated runs
and 0 treatment runs** — N samples of the control, which is the intended reading and is not an A/B.
The rollup says so on its verdict line: `repeat "<skill>": PASS [ABLATED — control arm] — 5/5 passed`.
Every ablated run is stamped `ablated: true` in `result.json` and carries `ablated=true` on its
`[provenance]` footer line; a run that isn't stamped is a real run.
What the harness gives you here is the run execution and the control arm — designing the comparison
(scrubbing giveaways, shuffling, judging blind, unblinding only after grading) is still yours.

**Measurement hygiene — four things that silently invalidate a batch:**

1. **Pin the model.** With no `model:` in the session (or `--model` on the `skill` lane) the run uses
   whatever the staged agent binary defaults to — not a harness constant, and it can move under a
   baseline bump. Read `result.json`'s `models` back before believing any cross-run comparison — and when
   you do, **ignore any entry wrapped in angle brackets**: `<synthetic>` is the agent marking a turn it
   fabricated locally (no API call), not a model, so two runs of the same pinned model can differ on this
   array purely by whether such a turn occurred.
2. **Commit the skill first.** `fingerprint.skillHash` is content-exact, so an edit mid-batch silently
   splits your dataset into two generations — and a hash whose source was never committed identifies a
   generation that is unrecoverable. `stats --group-by skill-hash` separates them after the fact;
   nothing recovers the source.
3. **Check which arm you actually ran** before analysing anything: `ablated` and
   `context.availableSkills` in each `result.json`.
4. **Read `skillsInvoked`.** A rep where the skill never triggered is a measurement of the model, not
   of your skill — discard or re-run it.

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
run starts, so capture stderr to get the exact directory — **unless you passed `--compact` (or `--demo`,
which implies it), which suppress that line** (it is a raw, un-tildeified host path, exactly what those shareable-output
modes exist to withhold; `status.json` is still written either way, so `status` still works) — but
`<dir>` also accepts the run-dir root
passed to `--run-dir` (a directory without its own `status.json`): it scans up to two levels down for the
newest session's `status.json` and reads that. `--follow` fails loud on a timeout/staleness
rather than hanging forever. (Fuller recipe in [`docs/run-status.md`](https://github.com/yaniv-golan/cowork-harness/blob/main/docs/run-status.md) — repo-only, not in the installed
payload; `cowork-harness status --help` has the flags.)

**Poll with `--follow`, not with a shell loop over `status`'s stdout.** The one-shot text form prints to
**stderr** and writes nothing to stdout; `--output-format json` (one envelope) and `--follow` (one JSON
line per status change) are the **stdout** forms. A poll that greps `status`'s stdout therefore matches
nothing, exits 1, and returns instantly against a run with minutes left to go — a silent false "done":

```bash
# WRONG — stdout is empty, so grep exits 1, `!` inverts it, and the loop never sleeps.
until ! cowork-harness status "$D" | grep -q '● running'; do sleep 30; done

# RIGHT — the harness owns the poll loop and exits when the run reaches a terminal state.
cowork-harness status "$D" --follow
```

**A multi-minute `record`/`run` outlives a short-lived wrapper.** Don't launch a long record from a
subagent that returns before it finishes — the returning agent tears down its process tree and kills the
in-flight run mid-artifact-write. Run it foreground, or detached from any process that will exit first.
(The `status.json` liveness above is exactly what surfaces such a teardown as `"error"`/`stale` rather
than a stuck `"running"`.)

### Place assertions in the right CI lane

CI placement: a **token-free `replay` PR gate** (content/structure only) + a **nightly live `run`**
(filesystem/egress). Fastest setup: `uses: yaniv-golan/cowork-harness@v2` (a packaged GitHub Action with a
PR job-summary reporter). See `references/ci-recipe.md` for the Action, the manual step-by-step form, and
the four-stage pipeline.

## Part III — Debug

A run misbehaved, or greened when you don't trust it. Debugging is a first-class loop, not an
afterthought: the run already wrote its evidence, so you **localize the failure post-hoc** rather than
re-run and hope. Start at the triage below, then use the observability output and, when you need to
reproduce interactively, `chat`.

> **"Evidence" below means the run's own record** — events, trace, transcript; what `trace` / `inspect` /
> `diff` / `verify-run` / `replay --explain` read. `critique`'s **evaluator** grades against a separate,
> narrower record — `critique-evidence-package.txt`, what a grade was actually computed against — none of
> the five tools above surface it; see `references/critique.md`.

### Triage — a run misbehaved, or a green looks wrong

<!-- BEGIN triage-canonical -->
Two situations need different tools — figure out which one you're in first, then reach for the tool
instead of re-running and hoping. The run already wrote its evidence to a kept run dir (`--keep` prints
the path; `trace <run-id>` finds it), and every tool below reads that evidence **token-free** — no
Docker, no re-record.

| Situation | Symptom | Reach for (in order) |
|---|---|---|
| **The skill misbehaved** | wrong output, an unexpected gate, a denied tool, an opaque crash | `inspect` — what did it produce? · `trace <run-dir> --view <view>` — what did it actually do (tools, gates, sub-agent tree)? · `verify-run` — re-assert cheaply when only an assertion is wrong · `diff <old-run> <new-run>` — what changed since it worked · `chat` — reproduce it by hand |
| **A green you don't trust** | an assert that may have tested nothing, a stale cassette, an auto-answered or decided gate | `replay --explain` — the evidence trail behind each *passing* assert · `replay --mutate` — perturbs a CAPPED SAMPLE of recorded JSON values (10/file, 50 total) and reports which perturbations NOTHING caught; the report names the sample size, so read it as a sample not a total (reporting only; never moves the verdict/exit code) · `lint` — assertions on the wrong CI lane / mixed-class keys · `verify-cassettes` — privacy + staleness over committed cassettes · the Gotchas landmine catalog — how a check passes vacuously · `run --repeat N` / `skill --repeat N` — did it pass, or pass once? · `stats` — flaky or expensive over time |

A failed run also records `errorSource` (where the failure originated) and `stderrLogPath` (the captured
agent stderr) — read those before re-running; a re-record rarely tells you more than the captured stderr
already does.
<!-- END triage-canonical -->

**Is it your skill's bug, or a known harness gap?** Before deep-debugging a wrong behavior, rule out a
**deliberate fidelity gap** — the harness intentionally does *not* reproduce a few real-Cowork behaviors,
so a "bug" you see here that real Cowork also has isn't yours to fix. The tier semantics are in
`references/fidelity-and-answers.md` (shipped); the specific deltas vs. real Cowork and the sandbox
boundary model live in [`docs/fidelity-gaps.md`](https://github.com/yaniv-golan/cowork-harness/blob/main/docs/fidelity-gaps.md) / [`docs/boundary.md`](https://github.com/yaniv-golan/cowork-harness/blob/main/docs/boundary.md) (repo-only, not in the installed
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
- **`lane: local|remote`** (scenario key, default `local`) — which Cowork lane's DELIVERY CONTRACT the run
  is held to. Cowork picks the lane per session ("Run this task: In the cloud / On your computer") and
  cloud is the default for new sessions; the lanes disagree about what *delivered* means. On `remote`,
  location delivers nothing (a remote container has no auto-delivering outputs dir and is reclaimed at
  session end), `present_files` is NOT served, and `user_visible_artifact` /
  `present_files_called` / `no_scratchpad_leak` are rejected at LOAD time as unable to pass. Reach for it
  to check a skill's delivery survives the lane most new sessions get. Orthogonal to `fidelity` — a
  `lane: remote` scenario still runs locally.
- **`cowork-harness stats [--metric <m>]`** — aggregate across the run index: `cost`, `duration`,
  `tokens`, `cache-tokens`, `model-cost`, `turns`, `pass-rate`. Filters: `--since`/`--baseline`/`--branch`,
  plus `--skill-hash <prefix>`/`--label <tag>` to narrow to ONE skill generation and
  `--group-by scenario|skill-hash|label|fidelity` to split per generation — or per effective fidelity
  tier — instead of aggregating across them (a window spanning >1 generation warns — see Gotcha 6;
  >1 tier warns too, independently, with `--group-by fidelity` as its own remedy). `--runs` lists the
  individual runs behind each summary with their `skillHash`/`runLabel`, so
  you can tell which arm a run belonged to without opening its `result.json`. `--last <n>` windows per group.
- **`result.json` carries the raw fields** the assertions read: `verdict`, `lane` (which Cowork delivery
  contract the run was held to — see Gotcha 24), `scratchpadEvidenceComplete` (did a COMPLETE scratchpad
  walk observe this run — what distinguishes "nothing was left undelivered" from "cannot tell"), `cost` (`cost.usd` = the SDK's
  `total_cost_usd` for the run — the authoritative single-run spend; NOT the same source as summing
  `modelUsage[].costUSD`, which is what `trace --view usage` reports, so the two can differ),
  `usage` (`input_tokens`/`output_tokens`/`turns`), `toolDurations`, `models`, `toolErrors`,
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
  semantics: the README's "Observability fields" section — repo-only; [`schema/run-result.json`](https://github.com/yaniv-golan/cowork-harness/blob/main/schema/run-result.json) is the
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
  `tasks[]`, **Working folder** = `workspaceFiles[]` (classified output/mount/input/scratchpad — the last being the agent's working area outside every user-visible root, with a
  `trace --view files` diff), **Context / Connectors** = `context` (tools / mcpServers / availableSkills),
  **Scratch-pad → outputs** = `presentedFiles[]`. If a panel looks wrong in a run, read its field. An
  **absent** `workspaceFiles`/`artifacts` (a replay result, or a run whose workspace root was missing at
  collection) is evidence **UNAVAILABLE**, not an empty run — `trace --view files` reports a loud
  UNAVAILABLE marker (`workspaceFilesRecorded: false` in JSON, and no phantom "removed" diff rows) and
  `inspect` prints `artifacts: UNAVAILABLE` (`artifactsRecorded: false`) instead of `artifacts (0):`.

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
   `artifact_text`, `egress_*`, `no_delete_in_outputs`, `self_heal_ran`, `transcript_no_host_path`); a
   *mixed* item like
   `{result, egress_denied}` greens on `result` while its `egress_denied` half is dropped. (`record`
   snapshots an `artifacts` manifest, which makes
   `file_exists`/`user_visible_artifact`/`artifact_json`/`artifact_text`/`computer_links_resolve`
   replay-checkable — but the live-only egress keys stay skipped, and `file_absent` is never
   replay-checkable at all: proving absence needs an exhaustive, healthy walk a manifest does not record.) *Fix:* put egress/live-only checks on
   a live gate; keep one concern per `assert:` item; run the linter. The harness warns loudly on skip.

2. **A steered gate answer never reached the model.** *Why:* `serializeDecision` must emit
   `updatedInput: { questions, answers }`; a header-only gate (empty `question`) can never be keyed.
   *Fix:* give every gate a non-empty `question`. (multiSelect gates ARE supported on **every** answer
   channel: scripted `choose:` list, in-band `--decider-dir` via a repeated `--choose` / a JSON-array
   reply, and `--decider-cmd` via a JSON-array reply — all deliver the same `", "`-joined wire shape.
   Free-text "Other" via `answer:`. Do NOT hand-write a multiSelect reply as a bare comma-joined
   string — send an array; a scalar is treated as one selection.) `question_asked` / `question_options` /
   `questions_count_max` / `gate_answers_delivered` only evaluate on replay **with a `controlOut` cassette** — re-record an
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

6. **`dispatch_count_max` is your author-chosen budget UNDER Cowork's production cap, not a
   reproduction of it.** It's a post-hoc count assertion: passing means "happened to dispatch ≤N this
   run." Cowork DOES cap `Task` fan-out **agent-side** (`taskRegistry`: concurrent **20** /
   per-session **200**, landed 2.1.212/2.1.217) — SEPARATE from the scheduled-task session limiter
   (gate `1648655587`'s `{perTask:1, global:3}`, a different mechanism; binary-verified, `SPEC.md` §10
   — repo-only). The harness **inherits** the production cap by spawning the real agent binary, so a
   `dispatch_count_max` pass means "your tighter budget held," not "near a real limit"; use it to catch
   a fan-out you don't want.

7. **`protocol` is rejected (not silently passed) if the scenario asserts egress** — boundary
   assertions need a sandboxed tier (`container`+). Good: this one fails loud by design.

8. **Read-only mounts are enforced; delete-deny is a HARNESS gap — production DOES enforce it.**
   `mode:r` mounts get a real `:ro` bind (a write fails in-guest). But `rw` vs `rwd`
   (write-but-no-delete on `outputs/` / connected folders) is *not* mount-enforced **in the harness** —
   `rm` succeeds and is only caught post-hoc by `no_delete_in_outputs`. **Real Cowork enforces it live:**
   outputs is a FUSE mount, and `unlink`/`rmdir` fail `Operation not permitted`; a skill must request
   approval via `allow_cowork_file_delete` (which re-mounts the folder `rwd` mid-session) to delete.
   **Only unlinking is denied.** Emptying a file in place — `truncate -s 0`, `> file`, `shred` without
   `-u` — and renaming *within* outputs both SUCCEED in production, so the harness does not flag them
   either. Renaming a file OUT of outputs fails (`EXDEV`, then `EPERM` on the copy-then-unlink
   fallback), so that stays a delete. Two consequences: a skill should not stage disposable scratch
   under `outputs/` (in production, cleanup there costs an approval prompt), and a skill's
   "catch-EPERM-then-request-approval" branch cannot be exercised at any harness tier (the `rm` just
   succeeds here). Do not read this gotcha as "delete-deny may not be real in production" — it is real.
   If a scenario's deletion IS intended, assert `allow_outputs_delete: true` rather than dropping
   `no_delete_in_outputs` — omitting it does not permit anything.

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
    - **Free-text aside:** the scripted key for a "type-it-in-notes" option is **`answer:`** — an
      arbitrary string delivered verbatim, bypassing label validation by author intent (Cowork
      auto-provides an "Other" free-text path on every gate). Mutually exclusive with `choose:`; setting
      both fails loud. What has no scripted equivalent is the `OTHER:` *directive*
      (it works only on the LLM-decider path, not scripted `choose:`, and only on
      **single-select** gates — a **multi-select** gate is index-only, so `OTHER:` fails loud there; on an
      options-bearing single-select gate a bare out-of-set LLM answer also fails loud (exit 2) — see the
      LLM-decider free-text note in `references/fidelity-and-answers.md`). An LLM decision answered via
      `OTHER:` is marked `[via Other free-text]` in its `gateProvenance` rationale.
14. **A positional `choose` (`first` / index) is order-dependent.** `choose: "2"` survives label drift
    but NOT option *re-ordering* — if the gate presents its options in a different order run-to-run, the
    index lands on a different option (a silent re-record flake). Prefer an exact label when order is
    stable; `lint` flags positional `choose` with an advisory. Unstable option order is also what the
    **user** sees — a reordered gate puts a different choice in the default slot — so pin what was shown
    with `question_options`, rather than only hardening the answer rule against it.
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

17. **Editing `scenarios/*.yaml` does NOT change a plain `replay` — the WHOLE scenario is frozen, not just
    `assert:`.** *Why:* a cassette captures every key (`lane:`, `fidelity:`, `baseline:`, `prompt:`, `skills:` …)
    and `replay` evaluates all of them from that frozen copy — byte-deterministic, ignoring the working tree (so
    a committed cassette can't silently re-interpret against an uncommitted YAML). **Only `assert:`
    (+`expect_denied:`) can be opted back to disk; any other edited key reaches a replay only by re-recording.**
    This is *loud* rather than a *silent* no-op: plain `replay` prints a `::notice::` when a sibling's
    `assert:`/`prompt:` differs, and when the sibling **fails to load** at all (a typo'd or too-new key) — and
    points you at the fix.
    *Fix:* to re-check token-free against the edited block, `replay --assert-from <scenario.yaml>` (or
    `--reassert`). That opt-in path is safe by construction for the authored fields — it **hard-fails** if
    `prompt`/`answers`/`baseline`/`fidelity`/`lane`/`skills`/`requires_capabilities` or the skill content (when a
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

19. **`gate_answers_delivered` passes vacuously when no gate fires — pair it, or drop it.** Whether a
    gate fires is model-dependent, so `gate_answers_delivered: true` alone can't catch "the gate never
    fired at all". If the scenario is meant to gate, pair it with `gate_answer_count_min: 1` (a floor of
    `0` witnesses nothing). If the scenario is gate-clean by design, drop the key — it asserts nothing
    there — and declare `questions_count_max: 0`, which fails loudly if a gate ever appears. Asserting
    `questions_count_max: 0` alongside a gate-presence key is unsatisfiable: `run`/`skill`/`record`
    refuse it before spending.

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
    produces them. (Details: [`docs/cassette.md`](https://github.com/yaniv-golan/cowork-harness/blob/main/docs/cassette.md) § tier staleness — repo-only.)

22. **`lint` floods CI with INFO advisories that don't apply to you.** *Why:* two rules —
    `manifest-needs-snapshot` and `gate-needs-controlout` — fire on the mere presence of manifest/gate
    assertion keys. The linter is **static**: it never reads your cassettes, so it cannot know whether
    yours already carry an `artifacts` manifest and `controlOut` (a current cassette does). On a healthy
    fleet every one of those lines is a false alarm. One exception: `manifest-needs-snapshot` is
    suppressed for `user_visible_artifact` on `lane: remote` — the only manifest-backed key that lane also
    rejects outright (`lane-remote-incompatible-key`, an ERROR), so the INFO would be redundant advice
    about a key the scenario can never even load with. `gate-needs-controlout` has no such exception. *Fix:*
    `lint --min-severity WARN` in CI (≥1.11.0) — the INFO advisories stay one flag away for interactive use.
    `--strict --min-severity ERROR` behaves as a plain lint, not a contradiction.
23. **`verify-cassettes`/`replay` report a `discovery-surface` note on cassettes you just recorded fine.**
    *Why:* the cassette froze its `system/init` tool inventory from before the skills/plugins discovery
    servers existed at that tier (added 1.10.0). It is a non-gating **note**, never a finding — it cannot
    fail your gate. *Fix:* nothing, unless the scenario asserts `tool_available` on
    `mcp__skills__*`/`mcp__plugins__*`; then re-record. It stays silent at `microvm`/`protocol`, where
    re-recording would never produce those tools anyway.

24. **Never name the file-delivery tool in a `SKILL.md`.** *Why:* Cowork has **two**, one per product
    lane, and an agent only sees the one for the surface it is on. The desktop-local sandbox this harness
    emulates is served `mcp__cowork__present_files` (`{files:[{file_path}]}`); **remote** cloud-container
    Cowork instead gives the agent the native `SendUserFile` (`files: string[]`, required `status`,
    optional `caption`/`display`). A skill that hardcodes either name works on one lane and fails on the
    other — and probing a remote session makes this harness look like it emulates the wrong tool under the
    wrong schema. It doesn't; the lanes genuinely disagree. *Fix:* describe the **outcome** ("deliver the
    file to the user") and let the model pick its surface's tool. The `no_scratchpad_leak` /
    `present_files_called` assertion keys are harness-side names and stay valid either way.
    ([`docs/fidelity-gaps.md`](https://github.com/yaniv-golan/cowork-harness/blob/main/docs/fidelity-gaps.md)
    → "File delivery" has the binary-verified detail; repo-only.)

25. **Two distinct host-inventory consent flags — a record-time one and a verify-time one.** `record
    --allow-host-inventory-fixture` is the boolean consent to proceed recording a host-inheriting
    (`protocol`/`hostloop`/`cowork`-resolving-to-hostloop) cassette into a repo-visible path — otherwise
    `record` refuses before it spends (freezing this machine's MCP servers/agents/account into a committed
    fixture is the risk). That pre-spend check **warns rather than refuses when the cassette already
    exists** — refusing would fire on every `--rerecord-stale` pass — and it reads the tier and the
    destination path, never the bytes. So `record` also scans the FINISHED recording, after redaction and
    before the write: a `host-inventory`/`machine-inventory` finding on a repo-visible path is
    **quarantined** to `<runs-root>/quarantine/` with a `.findings.txt` naming what leaked, and the command
    fails without writing the path you asked for (the recording is not discarded — you paid for it).
    `verify-cassettes --allow-host-inventory <regex>` is unrelated: a per-finding suppressor for the
    scanner's `host-inventory` class on an already-committed cassette. Passing one where the other command
    wants it fails as an unrecognized flag — they don't interchange. Depth: `references/ci-recipe.md`.

26. **A `skill`-lane `PASS` does not mean the skill ran, or that the run was the one you wanted.** *Why:*
    an open-ended `skill` run has no `assert:` block, so its verdict reports only that **no guard fired**
    (no error, stall, host-path leak, `outputs/` delete, permissive auto-allow or capability gap). On
    `run` the same word additionally means *your assertions held*; on `skill --repeat N`, `PASS — N/N`
    means N runs cleared the guards — it says nothing about which model served them, whether the skill
    was invoked, or whether they were the ablated arm. *Fix:* read the three fields the record already
    carries before drawing any conclusion — `skillsInvoked` / `skillActivity` (was it invoked at all),
    `models` (which model), `ablated` + `context.availableSkills` (which arm). An answer that reads
    exactly like skill output is not evidence: the skill's own source is mounted where the model can
    read it — in production too — so on a self-referential prompt it may read `SKILL.md` and answer
    directly, with `skillActivity` empty.

27. **`allow_stall: true` is a scenario assertion, so the `skill` lane cannot use it.** *Why:* the
    `stalled` guard fires when a run's final message ends in `?` with no productive tool call after the
    last gate — which includes a complete answer that closes by *offering* a follow-up ("want me to run
    this through a structured pass?"). The documented opt-out lives in an `assert:` block, and an
    open-ended `skill` run has none, so the failure message names a remedy that lane can't perform.
    *Fix:* on `skill`, read the final message before believing `stalled`, or move the check to a
    `run` scenario where `allow_stall: true` is authorable.

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
  alive* (Part II) above; the fuller recipe is in [`docs/run-status.md`](https://github.com/yaniv-golan/cowork-harness/blob/main/docs/run-status.md) (repo-only, not shipped with the
  installed skill).
