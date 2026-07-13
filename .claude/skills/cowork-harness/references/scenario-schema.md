# Scenario & session schema, assertion catalog, web_fetch, full gotchas

Self-contained reference for authoring `cowork-harness` scenarios. Tracks `cowork-harness 0.32.0`
(baseline `desktop-1.20186.1`). If your checkout is newer, prefer the live `docs/scenario.md`,
`docs/session.md`, and `SPEC.md`.

**Minimal scenario** — `prompt` is the only required field:

```yaml
prompt: "Use the my-skill skill to do X."
assert:
  - result: success
```

Everything below is the full field + assertion catalog.

## Table of contents
- [Scenario YAML](#scenario-yaml)
- [Session YAML](#session-yaml)
- [Scripted answers](#scripted-answers)
- [Assertion catalog](#assertion-catalog)
- [Replay class — which assertions survive `replay`](#replay-class)
- [The web_fetch model](#the-web_fetch-model)
- [Scenario YAML vs the pytest lane](#scenario-yaml-vs-the-pytest-lane)
- [Full gotcha list](#full-gotcha-list)

## Scenario YAML

A scenario (`scenarios/*.yaml`) is one test: a prompt, scripted answers, and assertions. It
references a session for setup.

```yaml
name: my-test                       # OPTIONAL — defaults to the filename; keys runs/<name>/
baseline: latest                    # platform baseline: "latest" or "desktop-<ver>" (NOT "profile:")
session: ../sessions/default.yaml   # pre-prompt setup (resolved relative to THIS file)
fidelity: container                 # protocol | container | microvm | hostloop | cowork
execution: local                    # OPTIONAL — orthogonal to fidelity (a privilege/sandbox tier, all
                                    # local): local (default) | cloud-describe (RESERVED — no runner
                                    # exists yet; authoring it is a load-time error, not a silent no-op)
on_unanswered: fail                 # policy for unscripted gates: fail | prompt | first | llm
                                    # ("agent" is retired — no longer a valid value)

prompt: |                           # the user turn
  Summarize report.pdf and write action items to outputs/actions.md

timeout_ms: 600000                  # OPTIONAL wall-clock budget; on expiry the harness kills the agent
                                    # and the run ends result:error / errorSource:timeout. Omit = no timeout.

answers:                            # scripted answers (see below)
  - when_question: "Which output format"
    choose: "Markdown"
  - when_tool: Bash
    allow_if: "!command.includes('rm')"
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
```

Relative paths resolve from the file's own directory, so a scenario + session + referenced files
form a relocatable bundle. `~` expands to home.

## Session YAML

A session (`sessions/*.yaml`) captures everything you'd configure in Cowork **before the first
prompt**. One session is reused by many scenarios. Mental model: **platform baseline = the release;
session = your setup.**

```yaml
# model & reasoning
model: claude-opus-4-8           # omit for the agent default
account_name: my-account         # OPTIONAL — display name rendered into {{accountName}} / the prompt's
                                    # "User name:" line; NOT a credential/identity selector (see src/prompt.ts, docs/session.md)
effort: high                     # low | medium | high | xhigh | max (+ extra, normalized to xhigh); validated against
                                  # the resolved model's offered levels (docs/session.md); omit for Cowork's medium
                                  # fallback — real Cowork always emits --effort, never omits it
extended_thinking: true          # real Cowork on/off toggle; default true (ON) -> --max-thinking-tokens 31999,
                                  # or --thinking disabled when false (no arbitrary budget in real Cowork)
agent_max_turns: 500              # optional turn ceiling -> agent --max-turns; omit for the agent default
                                  # (distinct from the max_turns ASSERTION)
permission_mode: default         # default | acceptEdits | plan | bypassPermissions
permission_parity: cowork        # cowork (unscripted tool calls allowed) | strict (deny unscripted)

# sub-agent / tool-search env knob (tier-uniform; maps to agent env vars)
agent_env:
  subagent_model: claude-opus-4-8   # -> CLAUDE_CODE_SUBAGENT_MODEL
  tool_search: auto                 # auto | off -> ENABLE_TOOL_SEARCH; omit = binary default (ToolSearch ON)
  disable_experimental_betas: false # true -> CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 (also disables ToolSearch)

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

# discovery: marketplaces / plugins / skills / mcp
plugins:
  marketplaces: []               # plugin_marketplaces (git URLs or local paths)
  local_marketplaces: []         # local marketplace dirs (each has a marketplace.json)
  enabled: [my-skill@local]      # enabledPlugins (name@marketplace)
  local_plugins: [./skills/my-skill]   # host plugin dirs → mnt/.local-plugins/marketplaces/local-desktop-app-uploads/<plugin>
                                       #   (the marketplace segment is that fixed synthetic name; ≥1.14271.0 —
                                       #   older baselines use mnt/.local-plugins/cache)
  remote_plugins: []
skills:
  local: []                      # extra host skill dirs
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
writes into its own dir should be declared in `hash_ignore` / `.cowork-hashignore`. On a mismatch,
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

**Mount enforcement:** `mode:r` mounts get a real per-mount `:ro` bind (a write fails in-guest). The
`rw` vs `rwd` (write-but-no-delete) distinction is **not** mount-enforced — a delete in `outputs/` or a
connected folder succeeds and is only caught post-hoc by the `no_delete_in_outputs` assertion. A missing
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

**Tool permissions:**
```yaml
- when_tool: Write
  decide: allow                   # allow | deny
- when_tool: Bash
  allow_if: "!command.includes('rm') && !command.includes('curl')"  # JS predicate over tool input
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

## Assertion catalog

Each list item under `assert:` is one assertion. **An item with multiple keys is an AND** — it
passes only if every key passes. Keep one concern per item unless you mean conjunction.

Looking for a key *by what you want to prove* (tool health, sub-agent work, panels, skill
attribution, resources, diagnostics)? SKILL.md §6's "goal → key" map is the by-purpose index into this
table; the table below is the full per-key reference, and `cowork-harness assertions --list` prints the
same set live from the schema.

| Assertion | Passes when |
|---|---|
| `result: success \| error` | the run ended with that status |
| `transcript_contains: <str>` | the assistant transcript includes the literal string |
| `transcript_not_contains: <str>` | it does not |
| `transcript_matches: <regex>` | the transcript matches (case-insensitive) — for stochastic prose |
| `transcript_not_matches: <regex>` | it does not match (e.g. no leaked stack trace) |
| `file_exists: <path>` | the path exists under the run's `work/` (anchored at `mnt/`, e.g. `outputs/x.md`). For a user-facing deliverable prefer `user_visible_artifact` — with a connected folder the file lands in `mnt/<folder>` (= `{{workspaceFolder}}`), not `mnt/outputs`, so `file_exists: outputs/x.md` misses it |
| `user_visible_artifact: <path>` | exists **and** under a user-visible root (`outputs/` + each connected folder's mount name) — the right primitive for a workspace deliverable when a folder is connected |
| `no_delete_in_outputs: true` | no delete op touched `mnt/outputs` — **only `true` is valid**; `false` is rejected (omit to allow deletes) |
| `no_unexpected_files: [<glob>, …]` | every **newly created** file under a user-visible root matches ≥1 glob (workRoot-relative paths; `**` = whole path segment for any depth — use `outputs/handoff/**` for per-run subdirs); `[]` = no new files; **new-files-only** — overwriting a pre-existing file in place is invisible (use content-level producer stamping); live/verify-run without a pre-run manifest ⇒ evidence-unavailable hard-fail (live runs capture the baseline only when this key is asserted; recordings always capture); an **incomplete post-run filesystem walk** (an unreadable subtree — a permission/I-O error) also fails evidence-unavailable rather than reporting "no strays" over a partial tree — distinct from the missing-manifest/microvm case, which fails for a different reason; **microvm cannot capture** (use container/hostloop); replay needs `cassette.preRunPaths` (≥0.24 container/hostloop recordings) — cassettes without it **exclude** the key with a loud warning |
| `input_unmodified: <glob>` or `[<glob>, …]` | a single glob or a list; every **pre-existing** file (incl. uploaded files under `uploads/**`) whose workRoot-relative path matches ≥1 glob keeps an unchanged content hash after the run — the in-place-mutation companion to `no_unexpected_files`'s new-files check (`[]` is rejected by the schema — list at least one glob); a matched file that was deleted counts as a content change (fails); live/verify-run without a pre-run hash manifest ⇒ evidence-unavailable hard-fail; **microvm cannot capture**; replay needs `cassette.preRunHashes` — cassettes without it **exclude** the key with a loud warning; on replay it compares against the manifest's recorded `sha256`, never a re-hash of the materialized tree |
| `self_heal_ran: <bool>` | a plugin-root self-heal script was (not) invoked |
| `tool_called: <glob>` | a tool the agent ran matched this **glob** — `*` = any run, `?` = one char, exact when literal, anchored + case-sensitive. Exact name (`Write`) matches only that tool; `mcp__workspace__*` matches any workspace tool. GLOB, not regex (`.` is literal) — an empty glob, or one containing a regex/brace-expansion metacharacter (`.*`, `.+`, `\|`, `()`, `[]`, `+`, `^`, `$`, `{}`, `\d`/`\w`/`\s`/`\b`), is **rejected at load** (a hard schema error, not a runtime warning) — it would match no real tool name and pass a `_not_`/`_absent` assert vacuously. Applies whether the glob comes from an authored scenario or a recorded cassette's frozen assert. The bundled `scenario.py lint` does NOT perform this check — only the harness enforces it, at actual load (`run`/`skill`/`record`) |
| `tool_not_called: <glob>` | NO tool the agent ran matched this glob (`mcp__*` = "no MCP tool ran"). Same glob semantics as `tool_called`, including the empty/regex-ish rejection |
| `tool_result_contains: <str>` | a tool result includes the literal string (content / replay-checkable — substring match) |
| `tool_result_not_contains: <str>` | no tool result includes the literal string (content / replay-checkable; fails loud when tool results are absent) |
| `subagent_tool_used: <glob>` | a sub-agent used a tool matching this glob (same `*`/`?`, anchored, case-sensitive semantics as `tool_called`, including the empty/regex-ish rejection) |
| `subagent_tool_absent: <glob>` | no sub-agent used a tool matching this glob (same rejection) |
| `no_vm_path_file_op: true` | **`fidelity: hostloop` only** — NO gated file tool attempted a `/sessions`(-prefixed) path (`RunResult.fileToolAttempts`) — content-class, replay-checkable without `controlOut`; any other tier FAILS "cannot verify" (`/sessions/...` is valid there). **Only `true` is valid** |
| `subagent_file_write: {path?, path_suffix?, tool?}` | a sub-agent-origin write attempt whose raw path equals `path` (exact) or ends with `path_suffix` has a paired non-error tool_result — the causal half of a delivery probe; requires one of `path`/`path_suffix`; `tool` defaults to Write/Edit/MultiEdit; content-class; tier-agnostic |
| `subagent_dispatch_healthy: {type?, delivered?, path?, path_suffix?, no_vm_paths?}` | **`fidelity: hostloop` only** — composite: selects dispatch(es) via `type` (same matching as `subagent_dispatched`; omit to require every dispatch) and, for EACH selected dispatch, checks it (not just any sub-agent) delivered a paired non-error write (`delivered`, default true — narrowed by `path`/`path_suffix`, same exact-vs-suffix precedence as `subagent_file_write`) and made no `/sessions` VM-path attempt (`no_vm_paths`, default true) — both scoped to that dispatch's OWN `parentToolUseId`, the per-dispatch correlation `subagent_file_write` (which matches ANY sub-agent write) cannot express; a `type` that matches no dispatch FAILS; content-class (`RunResult.fileToolAttempts` + `RunResult.toolResults`); any non-hostloop tier FAILS "cannot verify" |
| `subagent_dispatched: <regex>` | a sub-agent whose `dispatchAgentType`, binary-*resolved* `resolvedAgentType`, **or dispatch description** matches |
| `subagent_declared_but_unused: <Tool>` | a sub-agent declared the tool but never used **that** tool (even if it used others) |
| `subagent_output_contains: {match?, contains}` | a dispatched sub-agent's own output contains the substring `contains` — `match` (optional regex over `dispatchAgentType`/`resolvedAgentType`/`description`) narrows to specific dispatch(es); omitted, checks whether ANY dispatch's output contains it (existence check, not "all"); a miss against an output that was **truncated at the assert cap** reports evidence-unavailable instead of a proven absence — the substring could lie past the cut |
| `dispatch_count_max: <N>` | at most N sub-agents dispatched — an author-chosen budget (Cowork imposes no in-conversation Task-dispatch cap; records only, enforces nothing — see gotcha 12) |
| `skill_triggered: <regex>` | a skill matching the regex (invoked id, e.g. `"plugin:skill"`) was invoked via the `Skill` tool — evidence-unavailable (not a normal fail) if the agent's init tools have no `Skill` tool |
| `no_skill_triggered: <regex>` | no invoked skill id matched — the negative-control / description-collision catcher; evidence-unavailable (never a vacuous pass) if invocation data is absent or the `Skill` tool is unobservable |
| `skill_available: <regex>` | a staged skill's id matched the regex (offered, not necessarily invoked — see `skill_triggered` for invocation) — content-class: the id list comes from the agent's init `skills` listing, so it replays from the frozen init event (id-only; the `whenToUse` enrichment is live-disk and thus absent on replay, but the id is what's matched); evidence-unavailable only if `RunResult.context.availableSkills` is absent entirely (an older cassette recorded before the available-skills listing was captured) |
| `connector_available: <regex>` | an MCP server/connector's name matched the regex (available, not necessarily used) — evidence-unavailable if `RunResult.context.mcpServers` is absent |
| `tool_available: <regex>` | a tool in the init manifest matched the regex (available, not necessarily called — see `tool_called` for invocation) — evidence-unavailable if `RunResult.context.tools` is absent |

**Name-matching styles differ by key (don't mix them up):** `tool_called`, `tool_not_called`,
`subagent_tool_used`, `subagent_tool_absent` are **glob** (anchored, case-sensitive, `*`/`?`). `tool_available`,
`skill_triggered`/`no_skill_triggered`, `skill_available`, `connector_available`, `skill_tool_used`,
`subagent_type` are **regex** (unanchored, case-insensitive). So `tool_called: mcp__workspace__*` (glob) but
`tool_available: mcp__workspace__.*` (regex) — a `.*` in a `tool_called` glob is a load-time schema error, not silently-matches-nothing.
| `skill_tool_used: {skill, tool}` | a tool whose name matches `tool` ran inside a skill-activation window whose `skillId` matches `skill` (`RunResult.skillActivity`) — evidence-unavailable if skill-activity telemetry is absent; heuristic for inline skills (a sticky, sequential window matching the agent's `activeSkill` scope, not an exact per-tool boundary) |
| `max_cost_usd: <N>` | the run's SDK-reported cost is ≤ N USD — evidence-unavailable if cost telemetry is absent. **Replay asserts the frozen recording's cost, not fresh spend** — a real regression needs a live `run` |
| `max_tokens: <N>` | `usage.input_tokens + usage.output_tokens` ≤ N (cache tokens excluded) — same replay caveat as `max_cost_usd` |
| `tool_calls_max: <N>` | total top-level tool calls (sum of `toolCounts`) ≤ N — meaningfully replay-checkable (re-drive recomputes `toolCounts` deterministically) |
| `tool_no_error: <regex>` | no tool whose name matches the regex recorded any error (`RunResult.toolErrors[name].errors === 0` for every match) — **requires ≥1 matching tool call** (a regex matching nothing fails, so a typo can't silently pass); evidence-unavailable if tool-error telemetry is absent |
| `tool_no_error_if_called: <regex>` | like `tool_no_error` but passes vacuously when no tool matches the regex — the presence-free variant |
| `max_tool_errors: <N>` | total tool errors across all tools (sum of `RunResult.toolErrors[*].errors`) ≤ N — evidence-unavailable if tool-error telemetry is absent |
| `max_redundant_tool_calls: <N>` | total WASTED repeated tool calls (sum of `(count-1)` across every redundant `{name,args}` group in `RunResult.redundantToolCalls`) ≤ N — not the raw count of redundant groups; evidence-unavailable if redundant-call telemetry is absent |
| `max_turns: <N>` | the SDK-reported (or fallback-counted) turn count ≤ N — meaningfully replay-checkable (re-drive recounts turns deterministically, same as `tool_calls_max`) |
| `compaction_occurred: true` | a context-compaction boundary occurred (a `compact_boundary` system event was recorded) — lives in the stdout stream, so meaningfully replay-checkable; evidence-unavailable if context-event telemetry is absent. **Only `true` is valid** — omit to not require it |
| `all_tasks_completed: true` | every task in `RunResult.tasks[]` reached status `"completed"` — **requires ≥1 task** (a zero-task run fails; assert `task_count_min` for presence); evidence-unavailable if tasks telemetry is absent |
| `task_count_min: <N>` | at least N tasks were created (`RunResult.tasks.length >= N`) — the presence companion for task assertions |
| `task_status: {match, status}` | a task whose `subject` OR `id` matches the regex `match` reached `status` — evidence-unavailable if tasks telemetry is absent; also fails **malformed** when a TaskCreate result was unparseable (corrupt task telemetry), mirroring the guard `all_tasks_completed`/`task_count_min` already had |
| `no_scratchpad_leak: true` | every file presented via `present_files` that was in the scratchpad was successfully promoted to `mnt/outputs` (none left behind) — vacuously passes if nothing was presented (pair with a presence check to require a delivery); content-class: both the `present_files` tool_use and its own tool_result live in the ordinary events stream, so `RunResult.presentedFiles` re-derives identically on replay (meaningfully replay-checkable, same as `skill_triggered`); evidence-unavailable if `presentedFiles` telemetry is absent (an older run predating the feature). **`fidelity: container` only** — `present_files` is not served on hostloop/microvm, so a scratchpad-delivered file is neither promoted to `mnt/outputs` nor detected there (a skill that delivers via write-to-cwd→`present_files` will false-red `user_visible_artifact` on those tiers; use `container`, or write directly to `outputs/`). **Only `true` is valid** |
| `present_files_called: true` | at least one file was actually delivered via the `present_files` tool (`RunResult.presentedFiles` is non-empty) — the presence companion to `no_scratchpad_leak` (which passes vacuously when nothing was presented). Pair them to require a delivery **and** require it not to leak. Content-class (re-derives identically on replay). **`fidelity: container` only** — `present_files` is not served on hostloop/microvm. **Only `true` is valid** |
| `question_asked: <regex>` | the agent asked an AskUserQuestion whose text matches |
| `questions_count_max: <N>` | at most N **sub-questions** asked — a bundled `AskUserQuestion` with K sub-questions counts as K, not 1; `trace --view questions`'s footer total uses the same definition |
| `gate_answers_delivered: true` | every answered gate's answer reached the model (observed `tool_result`; unobserved = fail); **zero gates fired passes vacuously** — pair with `gate_answer_count_min` to also require a gate |
| `gate_answers_delivered: false` | asserts at least one answered gate's answer was **confirmed not delivered** (an observed delivery failure); an unobserved/null delivery does **not** satisfy this — for negative-path delivery tests |
| `gate_answer_count_min: <N>` | at least N AskUserQuestion gates fired AND were delivered non-error — presence companion to `gate_answers_delivered`'s vacuous-pass |
| `hook_blocked: <regex>` | a PreToolUse hook blocked a tool whose name matches the regex (`RunResult.hookEvents`) — evidence-unavailable if hook telemetry is absent. Replay: needs a `controlOut` cassette (a custom hook's decision lives only there, not the recorded stream) |
| `no_hook_blocked: true` | no tool was hook-blocked during the run (distinguishes a real tool crash from an intentional hook block) — evidence-unavailable if hook telemetry is absent. Replay: needs a `controlOut` cassette. **Only `true` is valid** |
| `vm_path_denied: true` | **`fidelity: hostloop` only** — at least one recorded path denial (`RunResult.pathDenials`, any source) targeted a `/sessions` VM path — evidence-unavailable if path-denial telemetry is absent. Replay: needs a `controlOut` cassette. Any other tier FAILS "cannot verify". **Only `true` is valid** |
| `path_denied: {tool?, path_matches?, source?, agent_scope?}` | **`fidelity: hostloop` only** — a path denial matching ALL given matchers (`tool` glob, `path_matches` regex, `source` ∈ pretooluse/can_use_tool/permission_denied, `agent_scope` ∈ main/subagent/any) was recorded. Replay: needs a `controlOut` cassette. Any other tier FAILS "cannot verify" |
| `no_path_denied: true` | **`fidelity: hostloop` only** — NO path denial was recorded at all (the channel is already path-scoped, unlike `no_hook_blocked`'s indiscriminate reject). Replay: needs a `controlOut` cassette. Any other tier FAILS "cannot verify". **Only `true` is valid** |
| `allow_permissive_auto_allow: true` | verdict modifier — suppresses the default-fail when the run recorded a cowork-parity permissive auto-allow; for tests that deliberately assert Cowork's permissive behavior |
| `allow_missing_capability: true` | verdict modifier — suppresses the default-fail when the (partial "core") agent image omits a capability the skill used but real Cowork ships (OCR/LibreOffice/markitdown/opencv/PDF-tables). Assert only when the skill's fallback is genuinely equivalent; otherwise rebuild full parity (`--build-arg COWORK_FULL_PARITY=1`). Also opts out of the `requires_capabilities` declared-need check. Live tiers only |
| `allow_l0_plugin_divergence: true` | verdict modifier — opt into L0/protocol plugin divergence: suppresses the default-fail when a plugin behaves differently at `protocol` (L0) fidelity than under a sandboxed tier. Live tiers only |
| `allow_stall: true` | verdict modifier — suppresses the `stalled` default-fail when a run ends on a question having done no productive tool work after its last gate (the agent asked for input and stopped — incl. re-asking in plain text after answering an `AskUserQuestion`); assert only when ending on a question is intended, else script the answer (`answer:` / `--answer` / a decider) |
| `transcript_no_host_path: true` | no host path (`/Users/`, `/opt/cowork/`, `/home/`, `/root/`) leaked into model-visible text — **incompatible with `hostloop` AND `protocol`**: hostloop's native file tools legitimately expose real host paths, and protocol (L0) runs the agent's file tools on the real host cwd with no sealed filesystem, so this fails BY DESIGN on both (the harness warns at run start if asserted anyway); use `container`/`microvm` for this check |
| `egress_denied: <host>` | the host was blocked by the egress proxy |
| `egress_allowed: <host>` | the host was allowed through |
| `no_mcp_error: true` | no MCP round-trip failed (`RunResult.mcpErrors` is empty — no unhandled server, no handler throw) — live-only: MCP round-trips are harness-computed, not in the SDK stdout stream, so evidence-unavailable on replay (never a vacuous pass). **Only `true` is valid** |
| `max_peak_rss_bytes: <N>` | peak sampled RSS of the agent sandbox ≤ N bytes (`RunResult.resources.peakRssBytes`) — live-only: replay never spawns a sandbox to sample, so evidence-unavailable on replay/protocol (never a vacuous pass); also evidence-unavailable when sampling captured no RSS value |
| `semantic_matches: {rubric: [...], min_pass?, judge_model?}` | a pinned LLM judge grades each fixed `rubric` claim against the run's answer — the **union of the agent's final result text (`RunResult.finalMessage`), the transcript, and the final on-disk content of any files the agent authored during the run** — so a claim about content the skill led the agent to *write to a file* grades as reliably as one about inlined prose (authored-file evidence is unavailable on the **microvm** tier — no pre-run manifest to diff against, so no files are captured; `container`/`hostloop` do capture them). Beyond the microvm case, when the authored-file evidence backing the judged document is **incomplete** — a file dropped at the capture-size cap, unreadable at read-back, or (on `--resume`) the scratchpad walk skipped — the assert fails evidence-unavailable rather than trusting a judge grade over a partial document; this is separate from the malformed-grade `judgeInvalid` path below. The assert passes iff ≥ `min_pass` claims pass (default: all — avoid for a gating scenario). Results align by claim index and are recorded per-claim in `RunResult.assertions[].semanticClaims` (`[{index, claim, pass}]`, so a consumer can diff the per-claim profile across runs); a rep whose grade can't be parsed (after one retry) is marked `RunResult.assertions[].judgeInvalid` and **never silently dropped** — it is excluded from the pass denominator, and the guard against a misleading score from that exclusion is the gate's minimum-valid-rep floor (`MIN_VALID` ≥ 4) plus this visibility, not a claim that denominator-shrinking inflation is impossible. Within a rep, a grade that's still unparseable after the retry **fails that assert outright** (evidence-unavailable, not a vacuous pass) — a persistently-flaky judge reds the run rather than silently passing. `judge_model` pins the grader (default when neither it nor `COWORK_HARNESS_JUDGE_MODEL` is set: `claude-opus-4-8`; a dated id keeps a before/after comparison reproducible). Live-only: the judge is a live model call, so evidence-unavailable / skipped-loud on replay (never a vacuous pass) |
| `artifact_json: {artifact, path, …}` | assert a JSON artifact's contents — `equals`/`gt`/`in`/`exists`/`absent`/`is_null` over a dotted `path` (`in` = membership in a list, for a stochastic/LLM value; `absent` ≠ `is_null`; an unresolved intermediate fails loud) |
| `computer_links_resolve: true` | every `computer://` link in the model-visible transcript resolves to an artifact that exists in the run's collected outputs/mounts — a dangling link fails, naming which target was checked (a live host path, the collected work tree, or the replay manifest). **Requires ≥1 link** (zero links fails — use `computer_links_resolve_if_present` for the presence-free variant). **Only `true` is valid** (`false` is rejected by the schema) |
| `computer_links_resolve_if_present: true` | like `computer_links_resolve` but passes vacuously when the transcript has zero `computer://` links — the presence-free variant. **Only `true` is valid** |

`expect_denied: [host, …]` adds one `egress_denied` per host. Run `cowork-harness assertions --list` for this
table from the live schema. Example: `artifact_json: { artifact: outputs/cap.json, path: me.run_id, equals: "r1" }`.

**Content correctness:** match the assertion to the deliverable. Prose → `transcript_matches`
(regex, drift-tolerant) or `transcript_contains` (literal marker). `transcript_matches` is
case-insensitive; **single-quote** the regex in YAML (double-quoted YAML eats backslashes, so `"\d"`
breaks — use `'\d'`); the transcript is one concatenated string, so use `[\s\S]`, not `.`, to span
turns. Use `transcript_matches` only for **stable lexical markers**, not semantic content the model
paraphrases (that re-records red). Structured JSON → assert it in YAML with **`artifact_json`** (dotted
`path` + operator); use the pytest lane (`assert_artifact_json`) only for predicates too complex for a
dotted path.

**VerdictSignals in `result.signals`:** `computeVerdict` pushes signals into `result.signals`; most
are **fail**-severity (they flip the run's pass/exit code even though `result.result` itself stays
`"success"`) and only three are **warn**-severity (informational, never flip pass/fail). Current signal
codes (`VerdictSignal["code"]` in `src/run/verdict.ts`):

| Code | Severity | Meaning |
|---|---|---|
| `assertion` | fail | An authored `assert:` item failed |
| `result_error` | fail | The run's SDK result was `"error"` |
| `usage_limit` | fail | Usage/quota limit hit (not a skill failure) — retry after the limit resets. Emitted when `RunResult.resultErrorKind === "usage_limit"` |
| `transport_error` | fail | The connection dropped mid/after-run |
| `permissive_auto_allow` | fail | A cowork-parity auto-allow real Cowork would block (opt out: `allow_permissive_auto_allow`) |
| `outputs_delete` | fail | An unauthorized delete touched `mnt/outputs` (opt out: author `no_delete_in_outputs`) |
| `host_path_leak` | fail | A host path leaked into model-visible text (opt out: author `transcript_no_host_path`) |
| `l0_plugin_divergence` | fail | L0/protocol plugin loading diverged from Cowork (opt out: `allow_l0_plugin_divergence`) |
| `missing_capability` | fail | A `requires_capabilities` need was unmet, or the skill used a capability the image omits (opt out: `allow_missing_capability`) |
| `infra_error` | fail | A VM/egress sidecar crashed mid-run — not author-suppressible |
| `stalled` | fail | The run ended on an unanswered question (opt out: `allow_stall`) |
| `non_deterministic` | warn | The run was LLM/external/human-decided — not reproducible |
| `prompt_asset_missing` | warn | The run proceeded with a missing prompt asset (`COWORK_HARNESS_ALLOW_MISSING_PROMPT=1`); fidelity is degraded |
| `scan_unavailable` | warn | Post-run scan evidence unavailable (`RunResult.scan` undefined) — the host-path and outputs-delete guards did not run this run |

A **fail**-severity signal does not change `result.result` (still `"success"`), but it DOES fail the
overall run verdict and exit code — `assert result: success` alone won't catch it; check
`result.signals[].severity` or the run's exit code. Only the three **warn** codes are truly benign.

## Replay class

A cassette (`record`/`replay`) has **no filesystem and no network**. `replay` re-evaluates only the
**content** assertions. The authoritative list is `ALWAYS_CONTENT_KEYS`/`QUESTION_GATE_KEYS`/`MANIFEST_KEYS` (composed) in `src/run/cassette.ts`.

**Assertion source — frozen by default, on-disk by opt-in.** A plain `replay` evaluates the `assert:` block
**frozen in the cassette** (byte-deterministic, ignores the working tree); editing `scenarios/<name>.yaml` does
not change it — replay only prints a `::notice::` when a sibling's `assert:` differs. `replay --assert-from
<scenario.yaml>` / `--reassert` is the opt-in token-free re-check against the on-disk block; it **hard-fails**
on recording-shaping drift (`prompt`/`answers`/`baseline`/`skills`) or skill-content staleness (it implies
`--fail-on-skill-drift`). `expect_denied`/filesystem/egress keys are sourced from on-disk but stay live-only —
sourcing ≠ evaluation (replay warns when you edit one). `verify-run` is the on-disk-`assert:` path for a kept
*run dir*; `--assert-from` is the equivalent for a *cassette*.

**Evaluated on replay (content):** `transcript_*`, `tool_*`, `subagent_*`, `subagent_file_write`,
`no_vm_path_file_op`, `dispatch_count_max`,
`skill_triggered`, `no_skill_triggered`, `skill_available`, `connector_available`, `tool_available`,
`skill_tool_used`, `max_cost_usd`, `max_tokens`, `tool_calls_max`, `tool_no_error`,
`max_tool_errors`, `max_redundant_tool_calls`, `max_turns`, `compaction_occurred`, `all_tasks_completed`, `task_status`, `task_count_min`, `no_scratchpad_leak`, `present_files_called`, `result`
(`max_cost_usd`/`max_tokens` assert the frozen recording's spend on replay, not fresh spend). The verdict
modifiers `allow_permissive_auto_allow` / `allow_missing_capability` / `allow_l0_plugin_divergence` /
`allow_stall` are also kept on replay, evaluated as no-op passes.

**Gate keys — replay only with a `controlOut` cassette:** `question_asked`, `questions_count_max`,
`gate_answers_delivered`, `gate_answer_count_min`, `hook_blocked`, `no_hook_blocked`, `vm_path_denied`,
`path_denied`, `no_path_denied` (the latter three are also `fidelity: hostloop`-only — see the assertion
table). With `controlOut` present they evaluate; on an old
cassette without it, a **loud warning** fires and they are **excluded** (not vacuously passed). Re-record to enable them.
`questions_count_max` counts sub-questions, not gates/tool-calls — see the catalog row above and
`trace --view questions`. `hook_blocked`/`no_hook_blocked` need `controlOut` for a different reason than
the question keys: a custom hook's block/allow decision is an opaque async reply recorded only in
`control-out.jsonl`, not the `events` stream — reconstructing from the stream alone would show only the
built-in Task hook's view and could vacuously pass `no_hook_blocked` even if a custom hook genuinely blocked.

**Filesystem — replay-checkable WITH an artifact manifest:** `file_exists`, `user_visible_artifact`,
`artifact_json`, `computer_links_resolve` run on replay when the cassette carries an `artifacts` snapshot
(`record` captures `outputs/` + connected folders; `replay` materializes it). `artifact_json` needs the
small-file JSON `body` inlined; a hash-only entry still satisfies `file_exists`. `computer_links_resolve`
resolves a `/sessions/…/mnt/…`-shaped link directly against the manifest, and a host-shaped (hostloop) link
by first normalizing it to a mount-relative path (recorded connected-folder prefixes + the outputs/uploads
mounts) — replay has no live filesystem to check a host path against directly (that only happens on a live
`run`/`verify-run`). Without a manifest (older cassettes) all five are skipped (five need the manifest; two
more — `no_unexpected_files` and `input_unmodified` — need the pre-run path/hash capture, below); `no_unexpected_files` also
needs `preRunPaths` (≥0.24 recordings) — without it the key is excluded with a loud warning (live/verify-run
hard-fails evidence-unavailable instead). `input_unmodified` is the same shape but needs `preRunHashes`
(the pre-run per-path sha256 baseline) instead of `preRunPaths`; without it, likewise excluded with a loud
warning. A green replay re-confirms
*record-time* artifacts, not that the current skill still produces them — `replay --strict` fails when the
staleness `fingerprint` shows ANY skill/baseline drift, or `replay --fail-on-skill-drift` only on
skill-source drift; every replay result also reports it class-tagged in `staleness[]` for a JSON gate.

**Egress + other filesystem — still skipped on replay (live-only):** `no_delete_in_outputs`,
`self_heal_ran`, `transcript_no_host_path`, `egress_*` / `expect_denied`, `no_mcp_error`, `max_peak_rss_bytes`.
These run only on a live `run`/`record`.

**Mixed assertions on replay:** before evaluating, `replay` strips each assertion to its replay-checkable
keys and drops any left empty. So `{result, egress_denied}` evaluates on replay as `{result}` alone — its
`egress_denied` half is removed (not AND-ed against an unreadable value); with a manifest, `file_exists`/
`artifact_json` are no longer stripped. The harness is **loud in two classes**: a *full skip* (`::warning::`
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

## Full gotcha list

The "✓ passed ≠ correct" landmines relevant to **scenario/assertion authoring**, as
*symptom → why → fix*. `file:line` pointers track the version at the top of this file.
**Scope note:** this is the assertion/replay-focused view; the **companion `SKILL.md`'s Gotchas
section is the full landmine catalog** (it adds workflow/record/answer-path landmines this schema
reference omits). Neither list is a strict superset of the other — reach for this one while authoring
`assert:`, and SKILL's when debugging a run's behavior.

1. **Replay skips filesystem/egress assertions (two shapes) — with a loud warning.** *Full skip:* a pure
   live-only `egress_*`/`no_delete_in_outputs`/`self_heal_ran`/`transcript_no_host_path` item on a
   `replay` gate is filtered out, not passing. (`file_exists`/`user_visible_artifact`/`artifact_json`
   are replay-checkable **when the cassette carries an `artifacts` manifest**; without one they are
   skipped too.) *Partial skip:* a mixed `{result, egress_denied}` greens on `result` while
   `egress_denied` is dropped. Both now warn loudly. → put egress/live-only checks on a live gate; one
   concern per item; run the linter. (`LIVE_ONLY_KEYS`/`MANIFEST_KEYS` in `src/run/cassette.ts`.)

2. **Gate keys need a `controlOut` cassette.** `question_asked`, `questions_count_max`,
   `gate_answers_delivered`, `gate_answer_count_min`, `hook_blocked`, `no_hook_blocked` only evaluate on
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
   the schema. (`src/types.ts:365` — the `on_unanswered` enum; `src/cli.ts:899` — the CLI-side
   `--on-unanswered` value check.)

4. **`--on-unanswered first` is non-deterministic too** — it picks option 1 and is flagged
   `nonDeterministic`; not a deterministic substitute for scripted answers.

5. **Scripted answers cover wording drift, not structural stochasticity.** If a skill decides
   run-to-run *whether/which* to ask, `fail` hard-errors (correct but flaky) → answer live instead.

6. **YAML regex quoting.** Single-quote regexes (`'\d'`); double-quoted YAML eats `\`. Transcript is
   one concatenated string → use `[\s\S]`, not `.`. `transcript_matches` is case-insensitive.

7. **Multi-key assertion item = AND.** Passes iff every key passes. One concern per item unless
   conjunction is intended (and a mixed-class conjunction loses its filesystem half on replay — gotcha 1).

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

12. **`dispatch_count_max` is an author-chosen budget, not a production cap.** It records the count
    and asserts on it; passing means "dispatched ≤N this run," not "the harness capped it." Cowork
    imposes no in-conversation Task-dispatch cap to reproduce — gate `1648655587`'s
    `{perTask:1, global:3}` is the scheduled/cron-task session limiter, a different mechanism
    (binary-verified; SPEC §10).

13. **`protocol` is rejected (not silently passed) if the scenario asserts egress** — boundary
    assertions need `container`+. Fails loud by design.

14. **`transcript_no_host_path` scans wide** (assistant + system + thinking blocks) and catches
    `file://` URI forms — stricter than it once was; pin the harness version when teaching it.

15. **Read-only mounts are enforced; delete-deny is not.** `mode:r` → real `:ro` bind; `rw`/`rwd`
    delete-deny is post-hoc only (`no_delete_in_outputs`).

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
    against it on replay (the hash-only entry still materializes a 0-byte placeholder); `artifact_json`
    reports a clear evidence-unavailable on every lane (live/verify-run/replay agree). This is also why a
    `mode: r` input never trips the `binary` privacy finding
    or needs `--allow` in `verify-cassettes` — only a *committed* body is scanned. `scaffold` won't emit
    `file_exists` for one either, since it isn't in `RunResult.artifacts`. A `mode: rw`/`rwd` folder's
    contents are captured with a full body, same as `outputs/`. (`src/run/cassette.ts:buildManifest`'s
    `bodyLessPrefixes`; `src/session.ts:readonlyFolderRootsFromPlan`.)
