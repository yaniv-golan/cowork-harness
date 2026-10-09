# Scenario & session schema, replay class, web_fetch, authoring gotchas

Self-contained reference for authoring `cowork-harness` scenarios. Tracks `cowork-harness 4.6.0`
(baseline `desktop-2.31226.0`). If your checkout is newer, prefer the live [`docs/scenario.md`](https://github.com/yaniv-golan/cowork-harness/blob/main/docs/scenario.md),
[`docs/session.md`](https://github.com/yaniv-golan/cowork-harness/blob/main/docs/session.md), and `SPEC.md`.

**Minimal scenario** — `prompt` and `fidelity` are required:

```yaml
prompt: "Use the my-skill skill to do X."
fidelity: container          # required — protocol | container | microvm | hostloop | cowork
assert:
  - result: success
```

Everything below is the full field catalog. The assertion catalog — every `assert:` key, plus the
verdict-signal table — starts at [`assertion-catalog.md`](./assertion-catalog.md), which indexes the per-family files.

## Table of contents
- [Scenario YAML](#scenario-yaml)
- [Session YAML](#session-yaml)
- [Scripted answers](#scripted-answers)
- [Assertion catalog](./assertion-catalog.md) (its own file)
- [Replay class — which assertions survive `replay`](#replay-class)
- [The web_fetch model](#the-web_fetch-model)
- [Scenario YAML vs the pytest lane](#scenario-yaml-vs-the-pytest-lane)
- [Authoring gotcha list](#authoring-gotcha-list)

## Scenario YAML

A scenario (`scenarios/*.yaml`) is one test: a prompt, scripted answers, and assertions. It
references a session for setup.

```yaml
name: my-test                       # OPTIONAL — defaults to the filename; keys runs/<name>/
baseline: latest                    # platform baseline: "latest" or "desktop-<ver>" (NOT "profile:")
session: ../sessions/my-session.yaml # pre-prompt setup (resolved relative to THIS file)
fidelity: container                 # REQUIRED (4.0.0+) — protocol | container | microvm | hostloop | cowork
execution: local                    # OPTIONAL — orthogonal to fidelity (a privilege/sandbox tier, all
                                    # local): local (default) | cloud-describe (RESERVED — no runner
                                    # exists yet; authoring it is a load-time error, not a silent no-op)
lane: local                         # OPTIONAL — which Cowork lane's DELIVERY CONTRACT the run is held to:
                                    # local (default) | remote. On `remote`, location delivers NOTHING (a
                                    # remote container has no auto-delivering outputs dir and is reclaimed
                                    # at session end) and `present_files` is NOT served (a local MCP server
                                    # can't reach a remote session) — so `user_visible_artifact` and
                                    # present_files_called/no_scratchpad_leak are REJECTED AT SCENARIO-LOAD
                                    # TIME (before the run starts, before any spend), not left to fail
                                    # unverifiable/can't-verify at assertion time. So is every key that
                                    # reads files inside the agent's container: artifact_text /
                                    # artifact_json / file_absent / no_unexpected_files /
                                    # computer_links_resolve* / no_lost_write_back, file_exists with
                                    # authored: true, and semantic_* with
                                    # evidence_files (semantic_* without it is judged on the transcript
                                    # only). Assert file_exists + transcript_matches instead; input_unmodified
                                    # still reads the local stand-in (unconfirmed). Orthogonal to fidelity
                                    # and execution — a `lane: remote` scenario still runs locally.
                                    # Delivery semantics only; the remote device bridge is deliberately
                                    # unmodeled.
                                    # NEEDS >= 1.14.0: on an older CLI a scenario carrying `lane:` does NOT
                                    # load (`Unrecognized key: "lane"`, exit 2) — it is NOT reinterpreted as
                                    # `lane: local`. Adopting the key means raising your floor. That
                                    # guarantee is the LOADER's. On replay the cassette's stamp decides:
                                    # recorded on >= 1.16.0, `lane: remote` raises it (v11+), so an older
                                    # replay/verify-cassettes refuses the cassette as too new
                                    # (`--best-effort-future-cassette` overrides that on replay). Recorded
                                    # by 1.14.0/1.15.0 it is stamped v10 and a pre-`lane` CLI ignores the
                                    # key (`rehash` re-stamps it). `lane: local` means what an older CLI
                                    # already does, so it lifts nothing.
on_unanswered: fail                 # policy for unscripted gates: fail | prompt | first | llm — run rejects prompt
                                    # ("agent" is retired — no longer a valid value)

prompt: |                           # the user turn
  Summarize report.pdf and write action items to outputs/actions.md

timeout_ms: 600000                  # OPTIONAL wall-clock budget; on expiry the harness kills the agent
                                    # and the run ends result:error / errorSource:timeout. Omit = no timeout.

answers:                            # scripted answers (see below)
  - when_question: "Which output format"
    choose: "Markdown"
  - when_tool: Bash
    allow_if: '!/\brm\b/.test(command)' # a word match; `includes('rm')` also denies "normalize"
    else: deny
  - when_tool: Write
    decide: allow

expect_denied: ["evil.example.com"] # shorthand: one egress_denied assertion per host

assert:
  - result: success
  - file_exists: outputs/actions.md
  - transcript_contains: "action items"
  - tool_called: Write
  - egress_denied: evil.example.com

skills: [report-gen]                # OPTIONAL — scope the cassette-staleness hash to these skills (each a
                                    # `skills/<name>` dir under a mounted plugin-root) + the plugin's shared
                                    # roots. Fail-closed to whole-tree on an unknown name. Omit = whole tree.

requires_capabilities: [ocr]        # OPTIONAL — declare a capability the skill needs (e.g. office_convert,
                                    # ocr, pdf_tables, opencv). If the running agent image provably omits
                                    # one, the harness ABORTS before the paid run (exit 3) — unless the
                                    # scenario also asserts `allow_missing_capability: true`, which downgrades
                                    # the abort to a notice and proceeds. Live tiers only.

allow_host_writes: true             # OPTIONAL — required to run `hostloop` fidelity with a WRITABLE
                                    # connected folder (session `mode: rw`/`rwd`): with no container
                                    # around hostloop's native file tools, that combination gives the
                                    # agent genuine, software-checked-only host filesystem access.
                                    # Read-only folders and folder-less runs need no opt-in.

allow_host_hooks: true              # OPTIONAL — required to run `protocol` fidelity when a staged plugin
                                    # declares runnable hooks — either `<plugin>/hooks/hooks.json` OR
                                    # the manifest's `hooks` key: L0 passes
                                    # --plugin-dir, so the CLI executes those hooks as NATIVE HOST
                                    # processes under your account, with no container sandbox. A plugin
                                    # that declares no hooks needs no opt-in, and a misplaced root-level
                                    # `hooks.json` cannot execute so it does not trigger the gate.
                                    # Use `--fidelity container` to run them sandboxed instead.
                                    # NEEDS cowork-harness >= 3.0.0. The loader is a strict object, so an
                                    # OLDER CLI does not default it — it hard-errors
                                    # `Unrecognized key: "allow_host_hooks"` and exits 2.

workspace_fixture: fixtures/step1   # OPTIONAL — a directory (relative to this file) copied into the
                                    # session's outputs/ before turn 1, to test one late step of a pipeline
                                    # (fresh runs only; never re-staged on --resume). Regular files only:
                                    # symlinks, hard links, .claude/.git/.mcp.json/CLAUDE.md and (git mode)
                                    # untracked files are refused at load, as is a presence/body assertion
                                    # on a fixture file that does not state `authored: true|false`.
                                    # 64 MiB cap (COWORK_HARNESS_WORKSPACE_FIXTURE_MAX_BYTES). Stamps v14.

metrics:                            # OPTIONAL — numbers read from JSON files the run wrote, reported in
  - { id: words, artifact: outputs/stats.json, path: totals.words, better: higher, scale: 5000 }
                                    # RunResult.metrics as {id, value} or {id, unavailable}; never in the
                                    # verdict. `better` required; exactly one of scale (the range's upper
                                    # bound; `min` is the floor, default 0) / unbounded: true.
                                    # A file the run did not write (incl. one rewritten with identical
                                    # bytes) is unavailable: pre_run; a kept run recorded with no
                                    # pre-run manifest, no_manifest. Arms the pre-run manifest.
```

Relative paths resolve from the file's own directory, so a scenario + session + referenced files
form a relocatable bundle. `~` expands to home (in a scenario's `session:` itself, 4.1.1 and later; a
cassette stores such a `session:` as written).

> **A recorded cassette is NOT part of that bundle and is NOT relocatable.** It rewrites its own
> references relative to **its own** directory at record time (`scenario.session` and
> `scenarioSource`), so moving it afterwards — a different `--out`, a
> `git mv`, a copy into another repo — leaves them unresolvable and `verify-cassettes` reports
> `unverifiable-skill` ("can't verify ⇒ not green", exit 3) until you re-record at the new location, or pass `--session <file>`.
> Decide where a cassette will live *before* you record it.

## Session YAML

A session (`sessions/*.yaml`) captures everything you'd configure in Cowork **before the first
prompt**. One session is reused by many scenarios. Mental model: **platform baseline = the release;
session = your setup.**

```yaml
# model & reasoning
model: claude-opus-4-8           # a run must resolve a model: --model (or a matrix axis) > this key >
                                  # COWORK_HARNESS_MODEL. A run that resolves none is refused. Set it HERE
                                  # for anything you will compare (a --repeat batch, a before/after, a
                                  # with/without): the env var is a property of the machine, not the
                                  # scenario. Read result.json's `models` back to confirm,
                                  # IGNORING any `<…>`-wrapped entry (`<synthetic>` = a turn the agent
                                  # fabricated locally, not a model id).
                                  # On the ad-hoc `skill` lane there is no session file, so `--model <id>`
                                  # (or COWORK_HARNESS_MODEL) is the ONLY way to pin it.
                                  # Adding or changing this key re-stales every cassette recorded from
                                  # the session (it is in the session fingerprint, so verify-cassettes
                                  # exits 1). To pin without re-recording now, pass --model or set
                                  # COWORK_HARNESS_MODEL; move it here at the next re-record.
account_name: my-account         # OPTIONAL — display name rendered into {{accountName}} / the prompt's
                                    # "User name:" line; NOT a credential/identity selector (see src/prompt.ts,
                                    # https://github.com/yaniv-golan/cowork-harness/blob/main/docs/session.md)
effort: high                     # low | medium | high | xhigh | max (+ extra, normalized to xhigh); validated against
                                  # the resolved model's offered levels
                                  # (https://github.com/yaniv-golan/cowork-harness/blob/main/docs/session.md);
                                  # omit for Cowork's medium fallback — real Cowork always emits --effort, never omits it
extended_thinking: true          # real Cowork on/off toggle; default true (ON) -> --max-thinking-tokens 31999,
                                  # or --thinking disabled when false (no arbitrary budget in real Cowork)
agent_max_turns: 500              # optional turn ceiling -> agent --max-turns; omit for the agent default
                                  # (distinct from the max_turns ASSERTION)
permission_mode: default         # default | acceptEdits | plan | bypassPermissions
permission_parity: cowork        # cowork (unscripted tool calls allowed) | strict (deny unscripted)
# answer_channel: none           # NOT Cowork: nobody answers the agent (--permission-prompts none; the agent then
                                  # offers no AskUserQuestion/EnterPlanMode/ExitPlanMode). Needs bypassPermissions +
                                  # a positive file assertion (file_absent doesn't count) + a
                                  # baseline that records cliCapabilities (protocol: a host claude whose --help lists
                                  # it). Refuses answers/deciders, permission_parity: strict, approved_domains, the
                                  # gate keys, questions_count_max, tool_called: AskUserQuestion, hostloop/cowork and
                                  # lane: remote. A closing `?` is parked_at_question (warn), not stalled. Full list:
                                  # https://github.com/yaniv-golan/cowork-harness/blob/main/docs/headless-no-answer.md

# sub-agent / tool-search env knob (tier-uniform; maps to agent env vars)
agent_env:
  subagent_model: claude-opus-4-8   # -> CLAUDE_CODE_SUBAGENT_MODEL
  tool_search: auto                 # auto | off -> ENABLE_TOOL_SEARCH; omit = binary default (ToolSearch ON)
  disable_experimental_betas: false # true -> CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 (also disables ToolSearch)
  artifacts_root: artifacts         # -> COWORK_ARTIFACTS_ROOT=<outputs as the agent sees it>/artifacts; refused at hostloop and cowork,
                                    # whose host-loop shell never sees the agent's env. An operator's own export of
                                    # the variable never reaches the agent at protocol or hostloop: set it here

# fenced debug escape hatch (NOT reachable via Cowork's UI)
debug:
  max_thinking_tokens: 50000     # overrides --max-thinking-tokens directly; bypasses extended_thinking's
                                  # on(31999)/off boundary — a run with this does NOT represent a real Cowork config
                                  # (removed: the old numeric/per-model `max_thinking_tokens` field — a session
                                  # YAML that still sets it fails to load with a targeted removal hint)

# work folders / uploads  → mnt/<folder-name>, mnt/uploads/<basename>
#   (mount name = collision-resolved folder basename; ≥1.14271.0, older baselines use mnt/.projects/<id>)
folders:
  - { from: ~/code/myproject, mode: rw }   # mounted at mnt/myproject; mode: r | rw | rwd
uploads:
  - ~/Downloads/report.pdf

# connected PROJECTS (userSelectedProjectUuids) — NOT the same as a work folder above, and not the
#   legacy mnt/.projects/<id> work-folder path older baselines used
projects:
  - { uuid: 7f3c…, from: ~/code/myproject }   # mounted READ-ONLY at mnt/.projects/<uuid>
                                              #   no mode: knob — production hardcodes ro
                                              #   never becomes the cwd; {{workspaceFolder}} stays at outputs

# discovery: marketplaces / plugins / skills / mcp
plugins:
  marketplaces: []               # plugin_marketplaces (git URLs or local paths)
  local_marketplaces: []         # local marketplace dirs (each has a marketplace.json)
  enabled: [my-skill@local]      # enabledPlugins (name@marketplace)
  local_plugins: [./skills/my-skill]   # host plugin dirs → mnt/.local-plugins/marketplaces/local-desktop-app-uploads/<plugin>
                                       #   (the marketplace segment is that fixed synthetic name; ≥1.14271.0 —
                                       #   older baselines use mnt/.local-plugins/cache)
  remote_plugins: []             # → mnt/.remote-plugins/plugin_<id> — how Cowork serves a UI-installed plugin
skills:
  local: []                      # extra host skill dirs
  suggest_enabled: true          # gate 245679952 override — `mcp__skills__suggest_skills` on/off (default true)
  proactive_suggest_enabled: false  # gate 1598976391 override — proactive description + `trigger` param; unset = always on from the 1.46388.3 baseline (where `false` models a surface production does not ship there), synced gate before it
mcp:
  config: null                   # --mcp-config file (standard mcpServers map)
  enabled: []

# network (Cowork egress, pre-prompt)
egress:
  extra_allow: []                # added to the release allowlist (bash / Path-B web_fetch only)
  unrestricted: false            # true == Cowork "*" (allow all)

# web_fetch (TEST CONVENIENCE — not a real Cowork setting)
web_fetch:
  approved_domains: []           # pre-approve hosts for the run (per-run only; seeds Run.approvedDomains)

# cassette-staleness fingerprint scope
staleness:
  hash_ignore: []                # gitignore-style globs (e.g. tests/, docs/, "**/*.md") excluded from the
                                 # staleness hash; composes with a plugin-local .cowork-hashignore file
```

The staleness hash uses each skill/plugin source dir's **git-tracked** file set by default (a non-repo dir
falls back to a raw walk; `COWORK_HARNESS_GITSET=0` opts out). **OS-junk** (`.DS_Store`/`Thumbs.db`/
`desktop.ini`) is always excluded, so a Finder touch can't re-stale a cassette; run-generated files a skill
writes into its own dir should be declared in `hash_ignore` / `.cowork-hashignore` — and so should
scenario or session YAMLs kept inside a mounted plugin dir: they are tracked files, so editing a scenario
there re-stales every cassette recorded from that plugin (committed `*.cassette.json` files are excluded
automatically). On a mismatch,
`verify-cassettes` names the exact changed file; `COWORK_HARNESS_DEBUG_SKILLHASH=1` dumps the full hashed set.
For a multi-skill plugin, scope a scenario's hash with `skills: [<name>]`; the opt-in
`COWORK_HARNESS_AGENT_SCOPE=skill` further treats a skill-named `agents/<name>.md` as that skill's private
input (instead of a fleet-wide shared root) so editing one skill's sub-agent contract re-stales only its cassettes.

**Mounting the skill under test:** put the skill folder in `plugins.local_plugins` and enable it via
`plugins.enabled: [<plugin>@local]`. The folder is copied fresh each run — **git-tracked files** inside a
repo, so `git add` a new skill (an all-untracked folder hard-fails as a would-be-empty mount;
`COWORK_HARNESS_GITSET=0` copies untracked). Tracked = in the index; the **content** copied is the
**working tree**, so uncommitted edits to a tracked file are tested without a commit — but real Cowork
ships the committed tree, so commit before recording the locking cassette. For an ad-hoc `skill` run
with no session file, the CLI flags `--folder <dir>` and `--upload <file>` are the equivalents of
`folders[]` / `uploads[]`.

**Installed vs. local-uploads layout:** to mirror a plugin installed through Cowork's UI, declare it under
`plugins.remote_plugins` instead — Cowork serves an installed plugin from `.remote-plugins/plugin_<id>`
(named by id, not plugin name), while `local_plugins` mounts two levels deeper
(`.local-plugins/marketplaces/local-desktop-app-uploads/<plugin>`). The choice matters to a skill that
locates its own files from the shell (at host-loop, Cowork's default, the braced `${CLAUDE_PLUGIN_ROOT}` is
replaced with a HOST path that the bash tool rewrites to the plugin's VM mount when it stands as its own
word, and a bare `$CLAUDE_PLUGIN_ROOT` is empty in the VM shell).
Do not derive the VM path from a host path the bash tool did not rewrite by keeping its `/mnt/…` tail:
under `hostloop` the harness's staged host path happens to end in the same `/mnt/.local-plugins/…` suffix
as the VM path, so that shortcut passes here and fails in real Cowork, whose host path has no such tail
([fidelity gap](https://github.com/yaniv-golan/cowork-harness/blob/main/docs/fidelity-gaps.md#hostloop-the-substituted-plugin-path-shares-the-vm-paths-suffix-real-coworks-does-not)).
Search for the skill's own `SKILL.md`, not for a directory named after the plugin — that finds nothing
under `.remote-plugins/plugin_<id>` — and set no `-maxdepth` that stops short of the deeper local layout:
`find /sessions/*/mnt/.local-plugins /sessions/*/mnt/.remote-plugins -path '*/skills/<skill-name>/SKILL.md' 2>/dev/null | head -1`.
Details: [docs/plugin-root.md](https://github.com/yaniv-golan/cowork-harness/blob/main/docs/plugin-root.md#in-vm-bash--what-the-shell-receives).

**Mount enforcement:** `mode:r` mounts get a real per-mount `:ro` bind (a write fails in-guest). The
`rw` vs `rwd` (write-but-no-delete) distinction is **not** mount-enforced — a delete in `outputs/` or a
connected folder succeeds and is only caught post-hoc (`no_delete_in_outputs`, `no_delete_in_mounts`, and by
default the `outputs_delete` signal on a baseline that records outputs `rw`; from Desktop 2.16120.0 outputs is
`rwd` and Cowork allows the delete, so nothing fails it by default there). A missing
mount source is a **hard error** (set `COWORK_HARNESS_SOFT_MISSING=1` to downgrade to warn-and-skip).
There is no `folders[].to` field — the mount name is always derived from the folder basename
(collision-resolved); `.projects` is now only a reserved name.

## Scripted answers

Each rule resolves an inbound `can_use_tool` control request — the same channel Cowork's question UI
uses. If no rule matches, the `on_unanswered` policy decides; the harness never silently fabricates
an answer.

**AskUserQuestion:**
```yaml
- when_question: "format|style"   # case-insensitive regex on the question text
  choose: "Markdown"              # the option label to select
```
`choose` tolerates the `(Recommended)` label suffix (`choose: Approve` matches `"Approve (Recommended)"`)
and the keywords `recommended` / `first`. For a **multiSelect** gate, pass a list — validated per-member
and delivered as the verified comma-joined wire shape (`"Auth, Billing"`):
```yaml
- when_question: "which features"
  choose: ["Auth", "Billing"]
```
For free-text **"Other"** (auto-offered on every gate), use `answer:` — an arbitrary string that bypasses
label validation by intent (mutually exclusive with `choose`):
```yaml
- when_question: "company name"
  answer: "Acme Holdings LLC"
```
**Batched gates are answered as one unit.** When one `AskUserQuestion` carries several sub-questions and
your rules match only some of them, the WHOLE batch goes to `on_unanswered` and the matched answers are not
delivered. The run reports it (warn signal `partly_scripted_gate`, `result.partlyScriptedGates` naming the
matched and unmatched sub-questions) without changing the verdict; script every sub-question to pin it.

**Tool permissions:**
```yaml
- when_tool: Write
  decide: allow                   # allow | deny
- when_tool: Bash
  allow_if: '!/\brm\b/.test(command) && !command.includes("curl")'  # JS predicate over tool input
  else: deny                      # decision when predicate is false (default deny)
- when_tool: "webfetch:example.com"   # a web_fetch approval (provenance-miss gate)
  decide: allow
  grant: domain                   # "Allow all for website" → host approved for the run; once = single fetch
```

The predicate sees the tool's input fields as locals (`command`, `file_path`, `url`, `domain`, …).
Unmatched tools fall to the **permission parity** default: read-only tools (`Read`, `Glob`, `Grep`)
always allow; otherwise `cowork` parity allows-with-audit, `strict` parity denies. **Exception:**
`webfetch:<domain>` is fail-closed (see web_fetch below).

**Reusable answer policies** (`--answer-policy <yaml>` on `skill`): the same `{when_question, choose}`
rules in a separate file. A missing/unparseable/non-list policy fails loud at load — never treated as
"0 rules."

**External deciders (`--decider-cmd`, `--decider-dir`):** the `"first"` string is **not** a shorthand
when returned by an external helper — it must match an actual label named `"first"`. Only the built-in
`choose: first` scripted keyword and the `on_unanswered: first` policy coerce to option 1. A helper
that accidentally returns `"first"` will fail the gate rather than silently green option 1.

## Replay class

A cassette (`record`/`replay`) has **no filesystem and no network**. `replay` re-evaluates only the
**content** assertions. The authoritative list is `ALWAYS_CONTENT_KEYS`/`QUESTION_GATE_KEYS`/`MANIFEST_KEYS` (composed) in `src/run/cassette.ts`.

**Scenario source — the WHOLE scenario is frozen; only `assert:` (+`expect_denied:`) can be opted back to
disk.** A cassette captures every key (`name`/`prompt`/`session`/`baseline`/`fidelity`/`lane`/`skills`/
`answers`/`execution`/`requires_capabilities`/`workspace_fixture`/`expect_denied`/`assert`), and a plain `replay` evaluates
**all** of them from that frozen copy (byte-deterministic, ignores the working tree); editing
`scenarios/<name>.yaml` does not change it — replay only prints a `::notice::` when a sibling's
`assert:`/`prompt:` differs, or when it fails to load at all. An edited `lane:`/`fidelity:`/`baseline:` reaches a replay ONLY by re-recording. `replay --assert-from
<scenario.yaml>` / `--reassert` is the opt-in token-free re-check against the on-disk block; it **hard-fails**
on recording-shaping drift (`prompt`/`answers`/`baseline`/`skills`) or skill-content staleness (it implies
`--fail-on-skill-drift`). `expect_denied`/filesystem/egress keys are sourced from on-disk but stay live-only —
sourcing ≠ evaluation (replay warns when you edit one). `verify-run` is the on-disk-`assert:` path for a kept
*run dir*; `--assert-from` is the equivalent for a *cassette*.

**Evaluated on replay (content):** `transcript_*`, `tool_*`, `subagent_*`, `subagent_file_write`,
`no_vm_path_file_op`, `dispatch_count_max`,
`skill_triggered`, `no_skill_triggered`, `skill_available`, `connector_available`, `tool_available`,
`skill_tool_used`, `max_cost_usd`, `max_tokens`, `tool_calls_max`, `tool_no_error`,
`max_tool_errors`, `max_redundant_tool_calls`, `max_turns`, `compaction_occurred`, `hook_event_fired`, `hook_event_blocked`, `no_hook_event_blocked`, `hook_decision`, `hook_output_contains`, `hook_output_not_contains`, `all_tasks_completed`, `task_status`, `task_count_min`, `no_scratchpad_leak`, `present_files_called`, `result`
(`max_cost_usd`/`max_tokens` assert the frozen recording's spend on replay, not fresh spend). The verdict
modifiers `allow_permissive_auto_allow` / `allow_missing_capability` / `allow_l0_host_config_contamination` /
`allow_stall` are also kept on replay, evaluated as no-op passes.

**Gate keys — replay only with a `controlOut` cassette:** `question_asked`, `question_options`, `question_context`, `question_option_count`, `questions_count_max`,
`gate_answers_delivered`, `gate_answer_count_min`, `gates_all_scripted`, `hook_blocked`, `no_hook_blocked`, `vm_path_denied`,
`path_denied`, `no_path_denied` (the latter three are also `fidelity: hostloop`-only — see
[`assertion-catalog-gates-hooks-modifiers.md`](./assertion-catalog-gates-hooks-modifiers.md)). With `controlOut` present they evaluate; on an old
cassette without it, a **loud warning** fires and they are **excluded** (not vacuously passed). Re-record to enable them.
`questions_count_max` counts sub-questions, not gates/tool-calls — see its row in [`assertion-catalog-gates-hooks-modifiers.md`](./assertion-catalog-gates-hooks-modifiers.md) and
`trace --view questions`. `hook_blocked`/`no_hook_blocked` need `controlOut` for a different reason than
the question keys: a custom hook's block/allow decision is an opaque async reply recorded only in
`control-out.jsonl`, not the `events` stream — reconstructing from the stream alone would show only the
built-in Task hook's view and could vacuously pass `no_hook_blocked` even if a custom hook genuinely blocked.

**Filesystem — replay-checkable WITH an artifact manifest:** `file_exists`, `user_visible_artifact`,
`artifact_json`, `artifact_text`, `computer_links_resolve` (+ `computer_links_resolve_if_present`) run on
replay when the cassette carries an `artifacts` snapshot
(`record` captures `outputs/` + connected folders; `replay` materializes it). `artifact_json` needs the
small-file JSON `body` inlined; a hash-only entry still satisfies `file_exists`. `computer_links_resolve`
resolves a `/sessions/…/mnt/…`-shaped link directly against the manifest, and a host-shaped (hostloop) link
by first normalizing it to a mount-relative path (recorded connected-folder prefixes + the outputs/uploads
mounts) — replay has no live filesystem to check a host path against directly (that only happens on a live
`run`/`verify-run`). `artifact_text` is manifest-class for the same reason `artifact_json` is — a
body-less, symlinked or over-cap entry fails evidence-unavailable rather than passing.
Without a manifest (older cassettes) all six are skipped (six need the manifest; two
more — `no_unexpected_files` and `input_unmodified` — need the pre-run path/hash capture, below); `no_unexpected_files` also
needs `preRunPaths` (≥0.24 recordings) — without it the key is excluded with a loud warning (live/verify-run
hard-fails evidence-unavailable instead). `input_unmodified` is the same shape but needs `preRunHashes`
(the pre-run per-path sha256 baseline) instead of `preRunPaths`; without it, likewise excluded with a loud
warning. A green replay re-confirms
*record-time* artifacts, not that the current skill still produces them — `replay --strict` fails when the
staleness `fingerprint` shows ANY skill/baseline drift, or `replay --fail-on-skill-drift` only on
skill-source drift; every replay result also reports it class-tagged in `staleness[]` for a JSON gate.

**Egress + other filesystem — still skipped on replay (live-only):** `file_absent` (proving a path is
ABSENT needs an exhaustive, healthy walk; a manifest records no walk health, so "not captured" and "not
there" are indistinguishable and the key would pass while proving nothing), `no_delete_in_outputs`,
`self_heal_ran`, `transcript_no_host_path`, `egress_*` / `expect_denied`, `no_mcp_error`, `max_peak_rss_bytes`,
`no_lost_write_back`. These run only on a live `run`/`record`.

**Mixed assertions on replay:** before evaluating, `replay` strips each assertion to its replay-checkable
keys and drops any left empty. So `{result, egress_denied}` evaluates on replay as `{result}` alone — its
`egress_denied` half is removed (not AND-ed against an unreadable value); with a manifest, `file_exists`/
`artifact_json` are not stripped. The harness is **loud in two classes**: a *full skip* (`::warning::`
with the count of pure live-only assertions not evaluated) and a *partial skip* (`::warning::` when a mixed
assertion's live-only half was dropped).
Two CI consequences: skipped assertions are **absent** from `results[].assertions[]` (not
present-and-passing), so don't assume a fixed assertion count across lanes; and a replay PR gate
verifies an artifact's content **only when the cassette carries an `artifacts` manifest** (then
`file_exists` / `user_visible_artifact` / `artifact_json` evaluate, per the filesystem note above) —
on a manifest-less cassette those are skipped, so the gate can't see the deliverable.

## The web_fetch model

`web_fetch` is gated by **URL provenance**, not the egress allowlist, and is **fail-closed**.

- **Provenance:** a URL is provenanced iff it appeared in the **prompt (user message)** or a **prior
  `web_fetch` result**. (WebSearch is a real Cowork tool the harness now captures structurally in
  `RunResult.webSearches`; for provenance its result text is scanned the same generic way as every
  other tool result — there's no Cowork-style dedicated structured WebSearch seed extractor, but a
  URL surfaced in a WebSearch result still gets provenanced.) → to make a
  fetch succeed deterministically, put the URL in the prompt.
- **Path A (provenanced):** fetches. The egress hostname allowlist is **NOT consulted** (decoupled).
  It is not a raw `curl -L`: redirects are followed manually (max 5) with a per-hop scheme +
  private/metadata-address SSRF backstop, so it can't redirect into `file://`, `169.254.169.254`, or
  a private host. A provenance *miss* raises the approval gate below.
- **Path B (no provenance enforced):** the per-hop gate is the full egress allowlist + scheme +
  private-address check.
- **The approval gate (`webfetch:<domain>`):** raised on a provenance miss; **fail-closed under
  cowork parity** — it is *not* auto-allowed like other unscripted tools, and `--on-unanswered first`
  does **not** allow it. Answer it three ways: a scripted rule (`when_tool: "webfetch:<domain>"` +
  `grant: domain|once`), a session `web_fetch.approved_domains: [host]` (test convenience, per-run),
  or a live terminal decider (`--decider-llm` / `--decider-cmd` / `--decider-dir`).
- **`egress_*` observes web_fetch on both paths** (an egress allow/deny event fires on the terminal
  hop and on a denied gate).

**The surprise:** adding a host to `egress.extra_allow` is a **no-op** for a provenanced fetch
(Path A ignores the allowlist); conversely a provenanced fetch succeeds to a host NOT in
`extra_allow`. Provenance is the gate, not the allowlist.

## Scenario YAML vs the pytest lane

Both run the skill under the real agent; neither replaces your own unit tests. Use **scenario YAML**
for portable, declarative regression suites with no Python toolchain (CI exit code) — structural,
boundary, and coarse-content checks. Use the **pytest `cowork` lane** (`python/`) when you need a
real predicate over a skill's **structured JSON output**:
`r.assert_artifact_json("artifacts/<slug>/sizing.json", lambda d: d["top_down"]["som"]["value"] > 0)`.
Find an artifact's real field paths by running once with `--keep`, then `cowork-harness inspect <run-dir>`
(a shallow field preview of each JSON artifact) or by reading the JSON directly.

## Authoring gotcha list

The "✓ passed ≠ correct" landmines relevant to **scenario/assertion authoring**, as
*symptom → why → fix*. `file:line` pointers track the version at the top of this file.
**Scope note:** this is the assertion/replay-focused view; the companion skill's `gotchas.md` catalog
is the broader one (it adds workflow/record/answer-path landmines this reference omits). **Neither list
is a strict superset of the other** — reach for this one while authoring `assert:`, and `gotchas.md` when
debugging a run's behavior. The two are **numbered independently**: a bare "gotcha N" means this list.

1. **Replay skips filesystem/egress assertions (two shapes) — with a loud warning.** *Full skip:* a pure
   live-only `egress_*`/`no_delete_in_outputs`/`self_heal_ran`/`transcript_no_host_path` item on a
   `replay` gate is filtered out, not passing. (`file_exists`/`user_visible_artifact`/`artifact_json`
   are replay-checkable **when the cassette carries an `artifacts` manifest**; without one they are
   skipped too.) *Partial skip:* a mixed `{result, egress_denied}` greens on `result` while
   `egress_denied` is dropped. Both now warn loudly. → put egress/live-only checks on a live gate; one
   concern per item; run the linter. (`LIVE_ONLY_KEYS`/`MANIFEST_KEYS` in `src/run/cassette.ts`.)

2. **Gate keys need a `controlOut` cassette.** `question_asked`, `question_options`, `question_context`,
   `question_option_count`, `questions_count_max`,
   `gate_answers_delivered`, `gate_answer_count_min`, `gates_all_scripted`, `hook_blocked`, `no_hook_blocked` only evaluate on
   replay with `controlOut`; on an old cassette they warn and are excluded (not passed).
   `gate_answers_delivered` **fails on
   unobserved delivery** (`delivered: null`) — absence of evidence is failure — but **passes
   vacuously when zero gates fired**; use `gate_answer_count_min: 1` to also require a gate to have
   fired. A **header-only gate** (empty `question`, only `header`) can never be keyed and is rejected
   loudly — every gate needs a non-empty `question`.
   (`QUESTION_GATE_KEYS` in `src/run/cassette.ts`; `src/assert.ts`.)

3. **The LLM-decider's two spellings.** Scripted answers + `on_unanswered: fail` is deterministic;
   the stochastic path flags the run `nonDeterministic`. The LLM decider is one mechanism, two
   spellings: `on_unanswered: llm` (YAML) and `--decider-llm` (CLI). The bare `--on-unanswered llm`
   is rejected (use `--decider-llm`). `agent` is **retired** — `on_unanswered: agent` is rejected by
   the schema. (`src/types.ts` — the `on_unanswered` enum; `src/cli.ts` — the CLI-side
   `--on-unanswered` value check; grep `--on-unanswered llm is not a user flag`.)

4. **`--on-unanswered first` is non-deterministic too** — it picks option 1 and is flagged
   `nonDeterministic`; not a deterministic substitute for scripted answers.

5. **Scripted answers cover wording drift, not structural stochasticity.** If a skill decides
   run-to-run *whether/which* to ask, `fail` hard-errors (correct but flaky) → answer live instead.

6. **YAML regex quoting.** Single-quote regexes (`'\d'`); double-quoted YAML eats `\`. Transcript is
   one concatenated string → use `[\s\S]`, not `.`. `transcript_matches` is case-insensitive.

7. **Multi-key assertion item = AND.** Passes iff every key passes. One concern per item unless
   conjunction is intended (and a mixed-class conjunction loses its filesystem half on replay — gotcha 1
   of THIS list; the two gotcha lists are numbered independently).

8. **`tool_called` proves a tool ran, not that it was attempted.** Tool counts are authoritative and
   de-duped: a requested-then-denied tool does NOT register as called; the synthetic
   `mcp__workspace__*` round-trip is not double-counted.

9. **Structured JSON → a structured-field assert, not a transcript substring.** Prefer YAML
   `artifact_json` (dotted `path` + operator); use the pytest lane (`assert_artifact_json` with a real
   predicate) only for checks too complex for a dotted path. Find field paths via `--keep`.

10. **`subagent_dispatched` matches by `resolvedAgentType` or `description` too** — a `Task` dispatch
    with no `subagent_type` at all falls back to the built-in `general-purpose` agent (a WILDCARD tool
    surface, `tools:["*"]`, incl. workspace bash) rather than leaving the type unresolved; the harness
    warns loudly on this fallback and records `subagents[].dispatchTypeOmitted`, so match on the
    resolved type or the dispatch description. `subagent_tool_absent` on a type-less dispatch is
    correspondingly weaker evidence (wildcard surface) — pin `subagent_type` explicitly when you need a
    tight guarantee.

11. **`subagent_declared_but_unused` fires on declared-but-didn't-use-THAT-tool**, even if the
    sub-agent used other tools.

12. **`dispatch_count_max` is your author-chosen budget under Cowork's production cap, not a
    reproduction of it.** It records the count and asserts on it; passing means "dispatched ≤N this
    run," not "the harness capped it." Cowork DOES cap `Task` fan-out agent-side (`taskRegistry`:
    concurrent 20 / per-session 200, landed 2.1.212/2.1.217), which the harness inherits by spawning the
    real agent binary — SEPARATE from gate `1648655587`'s `{perTask:1, global:3}` scheduled/cron-task
    session limiter, a different mechanism (binary-verified; SPEC §10).

13. **`protocol` is rejected (not silently passed) if the scenario asserts egress** — boundary
    assertions need `container`+. Fails loud by design.

14. **`transcript_no_host_path` scans wide** (assistant + system + thinking blocks) and catches
    `file://` URI forms — stricter than it once was; pin the harness version when teaching it.

15. **Read-only mounts are enforced; delete-deny is not.** `mode:r` → real `:ro` bind; `rw`/`rwd`
    delete-deny is post-hoc only (`no_delete_in_outputs`; outputs is `rwd`, delete-allowed, from Desktop 2.16120.0).

16. **Keep `.env` out of any mounted folder** — it's copied into the sandbox; the token could leak.
    Put it at a working-dir or install root. Token resolution: env > `--dotenv` > `./.env` > install
    `.env`.

17. **web_fetch: `egress.extra_allow` is a no-op on the provenanced path** — provenance is the gate
    (see the web_fetch section). multiSelect gates ARE supported across every answer channel: scripted
    (`choose:` list), in-band `--decider-dir` (repeat `--choose`, or a JSON-array reply), and
    `--decider-cmd` (JSON-array reply) — all deliver the same `", "`-joined wire shape; a member label
    containing a comma warns (the wire join is unescaped — a Cowork limitation).

18. **`replay_protocol_fidelity` is replay-synthesized only** — authoring it in a scenario is
    rejected (live it would be an empty assertion).

19. **External decider returning `"first"` does NOT coerce to option 1.** The `"first"` shorthand is
    only active in the built-in scripted-answer engine (`choose: first`) and the `on_unanswered: first`
    policy. A `--decider-cmd` or `--decider-dir` helper that returns the literal string `"first"` must
    match an actual label named `"first"` — otherwise the gate fails. This prevents a helper bug from
    silently green-ing option 1. (`src/decide/decider.ts:coerceLabel`.)

20. **Secret scrubbing catches base64-embedded tokens at record time.** The `scrubField` function
    (introduced in 0.7.0) runs two additional decode passes on each cassette field value: a whole-field
    base64 decode pass (fields ≥ 20 chars matching `[A-Za-z0-9+/=]+`) and a whole-field URI decode pass
    (fields containing `%`). If either decoded form contains a secret, the entire field value is replaced
    with `[REDACTED:base64]` or `[REDACTED:uri]` and its sha256 is recomputed over the marker bytes.
    Consequence: artifact assertions (`artifact_json`) over fields that were redacted will fail at replay
    — the harness emits `::warning::` at record time when this occurs. (`src/secrets.ts:scrubField`;
    `src/run/cassette.ts`.)

21. **A `mode: r` connected folder's contents are recorded body-less, not excluded.** `record` captures a
    read-only folder's files as `path` + `bytes` + `sha256` only (`truncated: true`, no `body`) — it's an
    input the agent read, not a deliverable it wrote. `file_exists`/`computer_links_resolve` still pass
    against it on replay (the hash-only entry still materializes a 0-byte placeholder); `artifact_json`/`artifact_text`
    report a clear evidence-unavailable on every lane (live/verify-run/replay agree). This is also why a
    `mode: r` input never trips the `binary` privacy finding
    or needs `--allow` in `verify-cassettes` — only a *committed* body is scanned. `scaffold` won't emit
    `file_exists` for one either, since it isn't in `RunResult.artifacts`. A `mode: rw`/`rwd` folder's
    contents are captured with a full body, same as `outputs/`. (`src/run/cassette.ts:buildManifest`'s
    `bodyLessPrefixes`; `src/session.ts:readonlyFolderRootsFromPlan`.)
