# Scenario & session schema, assertion catalog, web_fetch, full gotchas

Self-contained reference for authoring `cowork-harness` scenarios. Tracks `cowork-harness 0.1.0`
(baseline `desktop-1.12603.1`). If your checkout is newer, prefer the live `docs/scenario.md`,
`docs/session.md`, and `SPEC.md`.

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
on_unanswered: fail                 # policy for unscripted gates: fail | prompt | first | llm

prompt: |                           # the user turn
  Summarize report.pdf and write action items to outputs/actions.md

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
effort: high                     # low | medium | high | xhigh
max_thinking_tokens: 31999       # positive int, or per-model map {default, <model>: <n>}; default 31999
permission_mode: default         # default | acceptEdits | plan | bypassPermissions
permission_parity: cowork        # cowork (unscripted tool calls allowed) | strict (deny unscripted)

# work folders / uploads  → mnt/.projects/<to>, mnt/uploads/<basename>
folders:
  - { from: ~/code/myproject, to: proj1, mode: rw }   # mode: r | rw | rwd
uploads:
  - ~/Downloads/report.pdf

# discovery: marketplaces / plugins / skills / mcp
plugins:
  marketplaces: []               # plugin_marketplaces (git URLs or local paths)
  local_marketplaces: []         # local marketplace dirs (each has a marketplace.json)
  enabled: [my-skill@local]      # enabledPlugins (name@marketplace)
  local_plugins: [./skills/my-skill]   # host plugin dirs → mnt/.local-plugins/cache
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
```

**Mounting the skill under test:** put the skill folder in `plugins.local_plugins` and enable it via
`plugins.enabled: [<plugin>@local]`. The folder is copied fresh each run. For an ad-hoc `skill` run
with no session file, the CLI flags `--folder <dir>` and `--upload <file>` are the equivalents of
`folders[]` / `uploads[]`.

**Mount enforcement:** `mode:r` mounts get a real per-mount `:ro` bind (a write fails in-guest). The
`rw` vs `rwd` (write-but-no-delete) distinction is **not** mount-enforced — a delete in `outputs/` /
`.projects/` succeeds and is only caught post-hoc by the `no_delete_in_outputs` assertion. A missing
mount source is a **hard error** (set `COWORK_HARNESS_SOFT_MISSING=1` to downgrade to warn-and-skip);
a `folders[].to` with `/` or `..` is rejected.

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

## Assertion catalog

Each list item under `assert:` is one assertion. **An item with multiple keys is an AND** — it
passes only if every key passes. Keep one concern per item unless you mean conjunction.

| Assertion | Passes when |
|---|---|
| `result: success \| error` | the run ended with that status |
| `transcript_contains: <str>` | the assistant transcript includes the literal string |
| `transcript_not_contains: <str>` | it does not |
| `transcript_matches: <regex>` | the transcript matches (case-insensitive) — for stochastic prose |
| `transcript_not_matches: <regex>` | it does not match (e.g. no leaked stack trace) |
| `file_exists: <path>` | the path exists under the run's `work/` (e.g. `outputs/x.md`) |
| `user_visible_artifact: <path>` | exists **and** under a user-visible prefix (`outputs/`, `.projects/`) |
| `no_delete_in_outputs: true` | no delete op touched `mnt/outputs` |
| `self_heal_ran: <bool>` | a plugin-root self-heal script was (not) invoked |
| `tool_called: <Tool>` | the agent invoked the tool (actually ran it) |
| `tool_not_called: <Tool>` | the agent never invoked it |
| `subagent_tool_used: <Tool>` | a sub-agent used the tool |
| `subagent_tool_absent: <Tool>` | no sub-agent used the tool |
| `subagent_dispatched: <regex>` | a sub-agent whose `agentType` **or dispatch description** matches |
| `subagent_declared_but_unused: <Tool>` | a sub-agent declared the tool but never used **that** tool (even if it used others) |
| `dispatch_count_max: <N>` | at most N sub-agents dispatched (records only — does NOT enforce a cap) |
| `question_asked: <regex>` | the agent asked an AskUserQuestion whose text matches |
| `questions_count_max: <N>` | the agent asked at most N questions |
| `gate_answers_delivered: true` | every answered gate's answer reached the model (observed `tool_result`; unobserved = fail) |
| `transcript_no_host_path: true` | no host path (`/Users`, `/opt`) leaked into model-visible text |
| `egress_denied: <host>` | the host was blocked by the egress proxy |
| `egress_allowed: <host>` | the host was allowed through |
| `artifact_json: {artifact, path, …}` | assert a JSON artifact's contents — `equals`/`gt`/`exists`/`absent`/`is_null` over a dotted `path` (`absent` ≠ `is_null`; an unresolved intermediate fails loud) |

`expect_denied: [host, …]` adds one `egress_denied` per host. Run `cowork-harness assert --list` for this
table from the live schema. Example: `artifact_json: { artifact: outputs/cap.json, path: me.run_id, equals: "r1" }`.

**Content correctness:** match the assertion to the deliverable. Prose → `transcript_matches`
(regex, drift-tolerant) or `transcript_contains` (literal marker). `transcript_matches` is
case-insensitive; **single-quote** the regex in YAML (double-quoted YAML eats backslashes, so `"\d"`
breaks — use `'\d'`); the transcript is one concatenated string, so use `[\s\S]`, not `.`, to span
turns. Structured JSON → the pytest lane (see below).

## Replay class

A cassette (`record`/`replay`) has **no filesystem and no network**. `replay` re-evaluates only the
**content** assertions. The authoritative list is `contentKeys` in `src/run/cassette.ts`.

**Evaluated on replay (content):** `transcript_*`, `tool_*`, `subagent_*`, `dispatch_count_max`,
`result`.

**Gate keys — replay only with a `controlOut` cassette:** `question_asked`, `questions_count_max`,
`gate_answers_delivered`. With `controlOut` present they evaluate; on an old cassette without it, a
**loud warning** fires and they are **excluded** (not vacuously passed). Re-record to enable them.

**Filesystem — replay-checkable WITH an artifact manifest:** `file_exists`, `user_visible_artifact`,
`artifact_json` run on replay when the cassette carries an `artifacts` snapshot (`record` captures
`outputs/`/`.projects/`; `replay` materializes it). `artifact_json` needs the small-file JSON `body`
inlined; a hash-only entry still satisfies `file_exists`. Without a manifest (older cassettes) they're
skipped. A green replay re-confirms *record-time* artifacts, not that the current skill still produces them
— `replay --strict` fails when the staleness `fingerprint` shows the skill/baseline drifted.

**Egress + other filesystem — still skipped on replay (live-only):** `no_delete_in_outputs`,
`self_heal_ran`, `transcript_no_host_path`, `egress_*` / `expect_denied`. These run only on a live `run`/`record`.

**Mixed assertions on replay:** before evaluating, `replay` strips each assertion to its replay-checkable
keys and drops any left empty. So `{result, egress_denied}` evaluates on replay as `{result}` alone — its
`egress_denied` half is removed (not AND-ed against an unreadable value); with a manifest, `file_exists`/
`artifact_json` are no longer stripped. The harness is **loud in two classes**: a *full skip* (`::warning::`
with the count of pure live-only assertions not evaluated) and a *partial skip* (`::warning::` when a mixed
assertion's live-only half was dropped).
Two CI consequences: skipped assertions are **absent** from `results[].assertions[]` (not
present-and-passing), so don't assume a fixed assertion count across lanes; and a replay PR gate
**cannot** verify an artifact's content.

## The web_fetch model

`web_fetch` is gated by **URL provenance**, not the egress allowlist, and is **fail-closed**.

- **Provenance:** a URL is provenanced iff it appeared in the **prompt (user message)** or a **prior
  `web_fetch` result**. (There is no WebSearch tool, so no search-result seed path.) → to make a
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
Find an artifact's real field paths by running once with `--keep` and inspecting the JSON.

## Full gotcha list

The "✓ passed ≠ correct" landmines, as *symptom → why → fix*. `file:line` pointers track the version
at the top of this file.

1. **Replay silently skips filesystem/egress assertions (two shapes).** *Full skip:* a pure
   `file_exists`/`egress_*`/`user_visible_artifact`/`no_delete_in_outputs`/`self_heal_ran`/
   `transcript_no_host_path` item on a `replay` gate is filtered out, not passing. *Partial skip:* a
   mixed `{result, file_exists}` greens on `result` while `file_exists` is dropped. Both now warn
   loudly. → put artifact-*content* on a live gate; one concern per item; run the linter.
   (`src/run/cassette.ts:303-318` contentKeys; warnings `:358,363`.)

2. **Gate keys need a `controlOut` cassette.** `question_asked`, `questions_count_max`,
   `gate_answers_delivered` only evaluate on replay with `controlOut`; on an old cassette they warn
   and are excluded (not passed). `gate_answers_delivered` **fails on unobserved delivery**
   (`delivered: null`) — absence of evidence is failure. A **header-only gate** (empty `question`,
   only `header`) can never be keyed and is rejected loudly — every gate needs a non-empty `question`.
   (`src/run/cassette.ts:317`; `src/assert.ts:169-200`.)

3. **The LLM-decider's two spellings.** Scripted answers + `on_unanswered: fail` is deterministic;
   the stochastic path flags the run `nonDeterministic`. The LLM decider is one mechanism, two
   spellings: `on_unanswered: llm` (YAML) and `--decider-llm` (CLI). The bare `--on-unanswered llm`
   is rejected (use `--decider-llm`). `agent` is **retired** — `on_unanswered: agent` is rejected by
   the schema. (`src/types.ts:121`; `src/cli.ts:390`.)

4. **`--on-unanswered first` is non-deterministic too** — it picks option 1 and is flagged
   `nonDeterministic`; not a deterministic substitute for scripted answers.

5. **Scripted answers cover wording drift, not structural stochasticity.** If a skill decides
   run-to-run *whether/which* to ask, `fail` hard-errors (correct but flaky) → answer live instead.

6. **YAML regex quoting.** Single-quote regexes (`'\d'`); double-quoted YAML eats `\`. Transcript is
   one concatenated string → use `[\s\S]`, not `.`. `transcript_matches` is case-insensitive.

7. **Multi-key assertion item = AND.** Passes iff every key passes. One concern per item unless
   conjunction is intended (and a mixed-class conjunction loses its filesystem half on replay — #1).

8. **`tool_called` proves a tool ran, not that it was attempted.** Tool counts are authoritative and
   de-duped: a requested-then-denied tool does NOT register as called; the synthetic
   `mcp__workspace__*` round-trip is not double-counted.

9. **Structured JSON → pytest lane**, not a transcript substring (`assert_artifact_json` with a real
   predicate). Find field paths via `--keep`.

10. **`subagent_dispatched` matches by `description` too** — skills often dispatch with no
    `subagent_type` (`agentType:"unknown"`), so match the dispatch description.

11. **`subagent_declared_but_unused` fires on declared-but-didn't-use-THAT-tool**, even if the
    sub-agent used other tools.

12. **`dispatch_count_max` asserts but does NOT enforce.** It records the count; it does not
    reproduce Cowork's skip-on-cap (`{perTask:1, global:3}`, deferred). Passing means "dispatched ≤N
    this run," not "the harness capped it."

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
    (see the web_fetch section). multiSelect gates ARE supported (answer with a `choose:` list → comma-joined
    wire shape); a member label containing a comma warns (the wire join is unescaped — a Cowork limitation).

18. **`replay_protocol_fidelity` is replay-synthesized only** — authoring it in a scenario is
    rejected (live it would be an empty assertion).
