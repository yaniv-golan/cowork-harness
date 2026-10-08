# Authoring a scenario

Tracks `cowork-harness 4.6.0` (baseline `desktop-2.26454.2`). Read it when composing a `scenarios/*.yaml`: session vs scenario, discovery, the fidelity tier, the answer path, `web_fetch`, and scaffold + lint.

## Part I — AUTHOR a scenario

Everything below composes one deterministic, asserted `scenarios/*.yaml`: the session/scenario split,
how the skill mounts, the fidelity tier, the answer path, the two assertion axes, `web_fetch`
provenance, and the scaffold/lint tools that keep the YAML honest.

### Two files: session vs scenario

- **`sessions/*.yaml`** — pre-prompt setup: `model`, mounts (`folders`), and discovery
  (marketplaces / plugins / skills / mcp). One session is reused by many scenarios. A scenario's
  `session:` is a **path** to such a file, never a nested block: `session: { plugins: … }` fails to load. A
  scenario that omits `session:` gets an all-defaults session with no plugin declared, so a scenario that tests a
  plugin needs a session file.
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
| `container` | Real sandbox + real default-deny egress (the pre-4.0 default; every scenario now names its tier). Models the **VM loop**: keeps the built-in `Bash`, but `WebFetch` is replaced by `mcp__workspace__web_fetch` — assert on that name, not `WebFetch`. (`run`/`record` only; `chat --fidelity container` still offers the built-in.) **The name is tier-specific**: `microvm` never offers it and `protocol` serves the operator's own host registry. A `tool_not_called`/`subagent_tool_absent` naming a tool its tier does not serve is **REFUSED at scenario load** (the message names what to write instead), so moving a scenario between tiers now errors rather than silently voiding the assertion — except at `protocol`, which is never judged | Most functional + boundary tests. |
| `microvm` | VM-grade escape **isolation** (macOS arm64). Egress transport is the *same allowlist proxy as `container`* — not better network fidelity. Unlike `container`, still offers the built-in `WebFetch` | Testing untrusted code escape, not network behavior. |
| `hostloop` / `cowork` | Production split-exec: the agent loop is a **native process on the host** (no container around the file tools — matching production), with **both** native `Bash` and `WebFetch` disabled and routed host-side via the workspace SDK-MCP server into a Docker VM sidecar (the VM loop replaces web_fetch only) | Highest-fidelity / parity runs. A writable connected folder needs `allow_host_writes: true` (see scenario-schema.md). |

Set the tier in the **scenario's `fidelity:` field**, not a flag — `run` rejects `--fidelity`
(it's a `skill`/`chat` flag; `run` takes fidelity only from the scenario). See
`references/fidelity-and-answers.md`.

**Every tier models Cowork's LOCAL lane** — agent on the user's machine, shell rooted at
`/sessions/<id>`, folders at `/sessions/<id>/mnt/<name>`, delivery via `present_files`. Cowork's
**remote** lane runs server-side in a cloud container with a different filesystem (`$HOME/mnt/`),
different delivery (`/mnt/user-data/outputs/` + `SendUserFile`) and a server-authored prompt; no tier
reproduces it and none can — that container is not something a local tool can stand up.
[From 2026-10-06 new Pro and Max tasks run in the cloud](https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile);
before then no setting reliably decided the lane. Check the session's own lane
([how](https://github.com/yaniv-golan/cowork-harness/blob/main/docs/fidelity-gaps.md#which-lane-a-session-actually-ran-on)).
So: behaviour conclusions (triggering, tool sequencing, gate handling) travel between lanes; anything
asserting a **path, mount, delivery mechanism or egress rule** is a claim about the local lane only. Declare
`lane: remote` when the scenario is about that lane — the affected assertions then refuse to grade
rather than passing (see the `delivery_unobservable` WARN and the `lane: remote` load-time rejections
in `run-record-replay.md`; among the keys that load, `file_absent`, `artifact_text` and `artifact_json` fail
when graded, since that lane's container filesystem is not locally observable. Other keys that read the work
tree, such as `no_unexpected_files` and `input_unmodified`, still grade the local tree on that lane).

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
            ──► `cowork-harness chat`   (TTY; no pass/fail verdict — see debugging.md)
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

**Nobody will answer at all** (a headless host where the skill must park at its gate): none of the channels
above. Use the session key `answer_channel: none`, which removes the question tool and grades the skill's own
status file. It is not a Cowork setting; see [docs/headless-no-answer.md](https://github.com/yaniv-golan/cowork-harness/blob/main/docs/headless-no-answer.md).

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
`json_file`, `answer_policy`) creep in. Start from `cowork-harness scaffold`, which emits the
known-good skeleton (right tier, scripted `answers:` + `on_unanswered: fail`, content assertions
separated from live-only ones, one concern per item) and **self-lints its own output**. It has two
forms: from flags alone (below, no run needed), or `scaffold <run-id>` from a run you already kept.

```bash
cowork-harness scaffold --name report-check --skill ./skills/report-gen \
  --prompt "Generate the weekly report to outputs/report.md." \
  --content 'weekly report' --artifact outputs/report.md \
  --egress-allowed api.weather.example.com --out scenarios/report-check.yaml
```

Each repeatable flag adds one item: `--content` a `transcript_matches`, `--tool` a `tool_called`, `--subagent` a
`subagent_dispatched`, `--file` a `file_exists`, `--artifact` a `user_visible_artifact`, `--egress-allowed` /
`--egress-denied` an `egress_allowed` / `egress_denied`, `--gate REGEX=CHOICE` a scripted answer and `--web-fetch`
an approval rule; `--no-delete` adds `no_delete_in_outputs: true`, and `--no-validate` skips the self-lint.
The flag-built form runs the bundled `scripts/scenario.py scaffold`, which also runs directly with the
same flags (installed as a plugin, `${CLAUDE_PLUGIN_ROOT}/scripts/scenario.py`).

Then lint every scenario — it encodes the no-silent-false-green invariants. Use the CLI wrapper
`cowork-harness lint`: it runs the bundled `scenario.py lint` **and** the harness's own scenario loader,
so a file `run`/`record` would refuse fails lint too (running `scenario.py lint` directly skips the loader, and says so):

```bash
cowork-harness lint scenarios/*.yaml
```

`lint` exits non-zero on any ERROR (CI-friendly); `--strict` also fails on WARN. Every rule it reports:

| Rule | Severity | Fires on |
|---|---|---|
| `assert-contradiction` | ERROR | assert items no single run can satisfy together |
| `assertions-key` | ERROR | `assertions:` instead of `assert:` — none of the checks would run |
| `authored-replay-fidelity` | ERROR | an authored `replay_protocol_fidelity` (only the replay lane synthesizes it) |
| `capabilities-on-protocol` | ERROR | non-empty `requires_capabilities` on `protocol` without `allow_missing_capability` — the probe cannot run there, so the run fails as unverifiable |
| `cassette-evidence-skipped` | INFO | with `--cassette-dir`: a cassette (or the directory) could not be read, so it cannot quiet replay-evidence advice |
| `container-only-key-off-container` | ERROR | `no_scratchpad_leak` off `container` — hostloop's `present_files` never promotes, so there is nothing to leak (WARN on `cowork`, whose tier resolves per the baseline gate) |
| `egress-on-protocol` | ERROR | an egress assertion (`egress_*` / `expect_denied`) on `protocol`, which enforces no egress |
| `enum-value-invalid` | ERROR | a field value outside its allowed set |
| `artifact-json-match` | ERROR | an `artifact_json` glob `artifact` (with `*` or `?`) with no `match` or ending in `/`, or a literal one that sets `match` |
| `fidelity-missing` | ERROR | no `fidelity:` (required since 4.0.0) |
| `file-absent-contradiction` | ERROR | one path under both `file_exists` and `file_absent` |
| `gate-needs-controlout` | INFO | gate assertions, which evaluate on replay only when the cassette has `controlOut` |
| `hook-output-control-char` | ERROR | a `hook_output_contains` / `hook_output_not_contains` `text` or `matches` holding a control character (a double-quoted YAML `\b` is a backspace) — the harness refuses it at load |
| `host-path-assert-cowork` | WARN | `transcript_no_host_path` on `cowork` — it fails by design if the tier resolves to hostloop |
| `host-path-assert-tier` | ERROR | `transcript_no_host_path` on `hostloop` / `protocol`, where it fails by design |
| `lane-remote-incompatible-key` | ERROR | `present_files_called` / `no_scratchpad_leak` / `user_visible_artifact` on `lane: remote` (the runtime rejects them at load, so the tier rules are suppressed there) |
| `lane-remote-unobservable-key` | WARN | `artifact_json` / `artifact_text` / `file_absent` on `lane: remote`: they load but always fail when graded on a live run or verify-run (replay skips the live-only `file_absent`), since that lane's container filesystem is not locally observable. Instead, assert `file_exists` + `transcript_matches` for content, or `transcript_not_matches` for an absence |
| `linter-extra-findings-invalid` | ERROR | the loader findings `cowork-harness lint` hands the linter could not be read |
| `linter-unclassified-key` | ERROR | a valid assertion key this linter cannot classify (the linter is out of date) |
| `manifest-needs-snapshot` | INFO | manifest-backed keys, which evaluate on replay only when the cassette carries an `artifacts` manifest (not reported on `lane: remote` for `user_visible_artifact` / `artifact_json` / `artifact_text`, which cannot pass there) |
| `mixed-assert-item` | WARN | one assert item mixing replay-checkable and live-only keys (replay drops the live-only half) |
| `no-scenarios` | ERROR | a linted directory with no `*.yaml` / `*.yml` |
| `not-found` | ERROR | a named file that does not exist |
| `parse` | ERROR | a file that is not YAML, or not a mapping |
| `positional-choose-order` | INFO | an answer rule with a positional `choose` (first / index), which option re-ordering can move |
| `present-files-key-off-tier` | ERROR | `present_files_called` on `protocol` / `microvm` (served only at `container` / `hostloop`) |
| `prompt-slash-not-leading` | WARN | a `prompt:` that names `/<skill>` without starting with it, so it is never expanded |
| `reference-access-contradiction` | ERROR | one reference under both `reference_read` and `no_observed_reference_access` |
| `regex-double-quoted` | WARN | a double-quoted regex with an unescaped backslash (YAML strips it) |
| `replay-noop` | WARN | every assertion is live-only or a verdict modifier, so a replay gate verifies nothing |
| `slash-prompt-forked-result-anchor` | WARN | a `prompt:` starting with `/<skill>` plus a `tool_result_*` anchored on `forked execution` — a slash-invoked skill makes no `Skill` call, so that tool result never exists; assert `skill_triggered` instead |
| `slash-skill-name-differs-from-plugin` | WARN | a `prompt:` starting with a bare `/<skill>` that names a skill of a plugin the scenario's session stages, where the plugin's name differs — the agent expands it, but real Cowork's app has refused that typed form; pick it from the slash menu or name the skill like its plugin (`/<plugin>:<skill>` was not measured with a single copy installed). Names follow the agent: `.claude-plugin/plugin.json` `name`/`skills`, else the dir name; a skill's sanitized directory name. Reads the `session:` file and its `local_plugins`/`remote_plugins`; silent for an inline `session:`, for marketplace-delivered plugins, and when the files are not on this machine |
| `tool-called-always-passes` | INFO | `tool_called` with `count: {min: 0}` and no `max` — it asserts nothing |
| `tool-input-regex-redactable` | WARN | a `tool_not_called` input literal the redaction policy rewrites in the committed cassette (or a policy pattern it cannot check offline) |
| `tool-input-shell-tier` | INFO | the object form with `tool: Bash` and a `command` on `hostloop` / `cowork`, where shell runs as `mcp__workspace__bash` — list both |
| `tool-not-called-tier-vacuous` | WARN | `tool_not_called` / `subagent_tool_absent` naming a tool the tier never serves |
| `transcript-command-shaped` | WARN | a `transcript_*` value shaped like a shell command — those keys read prose only, never a tool call |
| `unknown-assert-key` | WARN | an assertion key not in the catalog (the loader rejects it) |
| `unknown-top-key` | WARN | a scenario key not in the schema |
| `vacuous-gate-assert` | WARN | `gate_answers_delivered` with no presence companion (zero gates passes it), or inert beside `questions_count_max: 0` |
| `unpaired-gates-all-scripted` | WARN | `gates_all_scripted` with neither `gate_answer_count_min` (≥ 1) nor `questions_count_max` — zero gates passes it, so nothing says whether gates were expected |
| `scenario-invalid` | ERROR | the harness's scenario loader refuses the file (via `cowork-harness lint` only — see below) |
| `baseline-unknown` | ERROR | `baseline:` names no baseline this CLI ships (via `cowork-harness lint` only) |
| `workspace-fixture-invalid` | ERROR | the run refuses the scenario's `workspace_fixture` directory — missing, a symlink, a hard link, agent-config paths, untracked files in git mode, empty, or over a size cap (via `cowork-harness lint` only) |
| `workspace-fixture-not-relative` | WARN | `workspace_fixture` is an absolute or `~/` path rather than one relative to the scenario file — it names a directory on one machine; when it does not exist where lint runs it is not checked (via `cowork-harness lint` only) |
| `workspace-fixture-vacuous-assert` | ERROR | a `file_exists` / `user_visible_artifact` / `artifact_text` / `artifact_json` names a file (or directory) the `workspace_fixture` provides without stating `authored:` — it would pass on the fixture alone (via `cowork-harness lint` only) |
| `lint-loader-internal` | ERROR | the wrapper could not run its loader check on a file — a harness bug; it never falls back to a lint that skipped the loader |

`scaffold` auto-upgrades the tier if you ask for egress on `protocol`, so it never emits a scenario `lint`
would reject.

**Lint the skill itself: `cowork-harness lint-skill <skill-dir>`.** It checks the skill, not a scenario:
Cowork host-loop footguns (a bare `$CLAUDE_PLUGIN_ROOT` in a VM bash step, the plugin root forwarded
through bash to a host-side reader, hook events, a misplaced
`hooks.json`, an unresolvable `subagent_type`), the evidence corpus a `critique` can package
(`references/critique.md`), and two size caps. `skill-body-over-reattach-cap` (WARN) fires when the
`SKILL.md` body, frontmatter excluded, passes 19,000 B — after a compaction the agent re-attaches only the
start of an invoked skill — and `skill-body-near-reattach-cap` (INFO) from 80% of that;
`skill-reference-over-read-cap` (WARN) fires on a `references/**.md` over 60,000 B, past which a
whole-file Read returns a partial view. `--strict` fails on WARN, never on INFO. To accept a reviewed
judgement-call finding, list it in a `--suppressions <file>` JSON file (one entry per accepted site:
`rule`, `file`, the exact source line as `match`, and a required `reason`), pass `--ignore-rule
<rule>[=<glob>]` (repeatable; the glob matches the finding's file) or fence the text in `SKILL.md` with `<!-- lint-skill: ignore-start <rule>[,<rule>…]: <reason> -->`
… `<!-- lint-skill: ignore-end -->` (outside any code fence). A suppressed finding is still printed; it
stops gating. A provable rule (an ERROR, a misplaced `hooks.json`, a missing pinned agent) cannot be
suppressed: naming it, or an unknown rule, in `--ignore-rule` or a `--suppressions` entry is a usage error (exit 2); in a marker it is
WARN `lint-skill-ignore-invalid`, as is any other malformed marker. An unclosed marker is WARN
`lint-skill-ignore-unclosed`, and a marker, `--ignore-rule` or entry that suppresses nothing is INFO
`lint-skill-ignore-unused` (WARN under `--strict-ignores`).

**A marker is an edit to `SKILL.md`, and it costs what any edit costs.** The skill hash covers the file's
content (unless the session's `staleness.hash_ignore` excludes it), so adding or moving a marker stales every cassette of that skill (a paid re-record to clear), and
the agent reads the marker text like the rest of the file, which counts toward the re-attach cap. When
either cost matters, prefer `--suppressions <file>`, kept outside the plugin: it touches neither, and each
entry accepts exactly one site, so a new copy of an accepted line still fails `--strict`. Add
`--strict-ignores` so an entry whose site is gone fails too. `--ignore-rule <rule>=<glob>` also touches
neither, but it suppresses the rule for the whole file, including any new site.

**`cowork-harness lint` runs the loader: a file it calls clean is one `run`/`record` will load.** Anything
the loader refuses — an unknown key, a wrong value type (a scalar `semantic_matches.rubric`), a bad regex,
a reserved value — is ✗ ERROR `scenario-invalid` (exit 1, with or without `--strict`), and a `baseline:`
naming no baseline this installed CLI ships is ✗ ERROR `baseline-unknown` (`latest` always resolves). It
does not check what depends on the machine the run happens on (the session file and its mounts, an
absolute `baseline:` path that does not exist here — one that exists is checked (4.1.1 and later) —
environment variables). A session or matrix YAML in a linted directory is not
a scenario and is reported as one that does not load — keep those out of the linted set. `python3
scenario.py lint` run directly stays offline and lenient: there an unknown key is only a ⚠ WARN (exit 0).
`cowork-harness record <file.yaml> --dry-run` also runs the loader and adds the pre-spend refusals (exit 2
on a schema error; a directory reports each `✗ broken:` file and exits 1). **Read the exit code, not just
its sign:** `record <file>` — with or without
`--dry-run` — answers `2` for "did not load" and `1` for "loaded fine, but this record is refused" (a
pre-spend policy refusal, including `--max-budget-usd`, which exited 2 before 4.0.0; `skill`/`run` still
exit 2 on it). Treating any non-zero
as "scenario broken" mis-reports every refused-but-valid scenario. Corollary: **the loader** fails LOUD on an unknown key (never silently).
`replay` reads a frozen scenario from a cassette, and what an OLDER CLI does with a key it doesn't know is
decided when the cassette is recorded. A key that changes what a verdict means (e.g. `lane: remote`) raises
the cassette's version stamp, so the older `replay` / `verify-cassettes` refuses it as too new instead of
evaluating it (`replay --best-effort-future-cassette` overrides that and names the key). For `lane: remote`
that holds for a cassette recorded on ≥ 1.16.0 (stamped v11); one recorded by 1.14.0 or 1.15.0 is stamped
v10, a pre-`lane` CLI ignores the key there, and `rehash` re-stamps it. A meaning-neutral key leaves the
stamp alone and is ignored by design. Full split:
[docs/scenario.md](https://github.com/yaniv-golan/cowork-harness/blob/main/docs/scenario.md#unknown-keys-the-loader-is-strict-lint-is-lenient).
