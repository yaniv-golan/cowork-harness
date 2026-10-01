# Assertions guide

Tracks `cowork-harness 4.2.1` (baseline `desktop-2.16120.0`). Read it when choosing assertion keys: the two orthogonal axes and the goal → key map. The full catalog is `assertion-catalog.md`.

### Assertions: two orthogonal axes

Conflating these is the **biggest landmine**. An assertion key has two independent properties:

- **Axis A — robust to LLM phrasing drift?** Structural/boundary keys (`subagent_dispatched`,
  `egress_*`, `file_exists`, `user_visible_artifact`, `result`) are robust. Free-text content is
  not: match prose with `transcript_matches` / `transcript_contains` (stable lexical markers only —
  not semantic content the model paraphrases, which re-records red); check structured JSON with YAML
  `artifact_json` (or the [pytest lane](https://github.com/yaniv-golan/cowork-harness/blob/main/python/README.md) for complex predicates), not via a transcript substring.
  To check a command that RAN (not one the agent mentioned), use the object form `tool_called: {tool, input: {command: <regex>}, scope?, result?}` — see [assertion-catalog.md](./assertion-catalog.md).
- **Axis B — survives `replay`?** *Independent of Axis A.* On the token-free `replay` lane, only
  **content keys** evaluate; filesystem / egress keys are skipped (live-only) — loudly, via an
  `::warning::` annotation, not a silent no-op. A key
  being "robust" says nothing about whether it runs on your replay gate.

Getting Axis B wrong means a check that **does nothing in CI** — the harness warns loudly when it skips
(an `::warning::` annotation, not a silent no-op — see the Axis B bullet above), and the bundled linter
catches it before you push — run it (see *Scaffold a valid scenario, then lint before you push* in `authoring.md`).

See `references/assertion-catalog.md` for the full assertion catalog, and `references/scenario-schema.md`'s
*Replay class* for which keys survive `replay`.

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
| a `context: fork` skill answered correctly | `tool_result_matches: '^Skill "[^"]*" completed \(forked execution\)[\s\S]*<pattern>'` — its answer is the `Skill` tool result, not a sub-agent output, so `subagent_output_contains` and `semantic_matches` never see it (foreground fork only — a backgrounded fork's result carries no answer). Only when the MODEL invokes the skill: a `/<skill> …` prompt runs the fork with no `Skill` call and no such result — use `skill_triggered` + `transcript_matches` there |
| a pre-existing input wasn't mutated (incl. `uploads/**`) | `input_unmodified: <glob>` or `[<glob>, …]` (live/verify-run) |
| no authored interactive artifact silently loses its Submit under Cowork | `no_lost_write_back: true` (**live-only**; static Tier A over the run's authored `.html`/`.py`/`.js`; per-scenario gate for the same class `analyze-skill` scans) |
| a resource ceiling held | `max_peak_rss_bytes: <N>` (**live-only**) |
| the user was **shown** the right choices, in order | `question_options: {when_question, equals}` — the option SET/ORDER a gate offered (`question_asked` matches the text only); order is compared by default |
| the user was **told something specific** at a gate | `question_context: {when_question, matches}` — a regex over the question label + option labels + option **descriptions**. Reach for this when the wording may land in an option's `description`, which `question_asked` and `question_options` cannot see |
| a hook blocked / didn't block a tool | `hook_blocked: <regex>`, `no_hook_blocked: true` (replay needs a `controlOut` cassette) |
| every MCP round-trip succeeded | `no_mcp_error: true` (**live-only**) |
| a context compaction happened | `compaction_occurred: true` |

Every one of these still obeys the two axes above — several are live-only or need a `controlOut`
cassette on replay, so check the catalog's replay class before putting one on a PR gate.
`cowork-harness assertions --list` prints the full, always-current key set with one-line semantics
straight from the schema — treat it (and the catalog) as the source of truth; this map is a
goal-oriented index into it, not a second catalog.
