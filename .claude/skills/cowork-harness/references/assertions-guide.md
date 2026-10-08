# Assertions guide

Tracks `cowork-harness 4.6.0` (baseline `desktop-2.26454.2`). Read it when choosing assertion keys: the two orthogonal axes and the goal → key map. The full catalog starts at `assertion-catalog.md`, which indexes the per-family files that hold every key's row.

### Assertions: two orthogonal axes

Conflating these is the **biggest landmine**. An assertion key has two independent properties:

- **Axis A — robust to LLM phrasing drift?** Structural/boundary keys (`subagent_dispatched`,
  `egress_*`, `file_exists`, `user_visible_artifact`, `result`) are robust. Free-text content is
  not: match prose with `transcript_matches` / `transcript_contains` (stable lexical markers only —
  not semantic content the model paraphrases, which re-records red); check structured JSON with YAML
  `artifact_json` (or the [pytest lane](https://github.com/yaniv-golan/cowork-harness/blob/main/python/README.md) for complex predicates), not via a transcript substring.
  To check a command that RAN (not one the agent mentioned), use the object form `tool_called: {tool: <name>, input: {command: <regex>}, scope?, result?}` — see [assertion-catalog-outcome-files-tools.md](./assertion-catalog-outcome-files-tools.md).
- **Axis B — survives `replay`?** *Independent of Axis A.* On the token-free `replay` lane, only
  **content keys** evaluate; filesystem / egress keys are skipped (live-only) — loudly, via an
  `::warning::` annotation, not a silent no-op. A key
  being "robust" says nothing about whether it runs on your replay gate.

Getting Axis B wrong means a check that **does nothing in CI** — the harness warns loudly when it skips
(an `::warning::` annotation, not a silent no-op — see the Axis B bullet above), and the bundled linter
catches it before you push — run it (see *Scaffold a valid scenario, then lint before you push* in `authoring.md`).

See `references/assertion-catalog.md` for the full assertion catalog (an index into its per-family files), and `references/scenario-schema.md`'s
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
| an internal name/path did **not** leak into a delivered file | `artifact_text: {artifact, not_contains: [..]}` — `artifact_json`'s companion for non-JSON bodies; literal path, no glob, so one entry per delivered surface |
| a named path must **not** exist after the run | `file_absent: <path>` (**live/verify-run only**) — do NOT invert `no_unexpected_files`: that is an allowlist over *newly created* files and needs a pre-run manifest |
| a to-do workflow finished | `all_tasks_completed: true`, `task_status: {match, status}` |
| a skill / connector / tool was **offered** | `skill_available`, `connector_available`, `tool_available` (all `<regex>`) |
| a skill actually **ran** (or must NOT) | `skill_triggered: <regex>`, `no_skill_triggered: <regex>` |
| a tool ran **inside** a skill's scope | `skill_tool_used: {skill, tool}` |
| a sub-agent did the work | `subagent_output_contains: {contains}`, `subagent_dispatched: <regex>`, `dispatch_count_max: <N>` |
| a `context: fork` skill answered correctly | `tool_result_matches: '^Skill "[^"]*" completed \(forked execution\)[\s\S]*<pattern>'` — its answer is the `Skill` tool result, not a sub-agent output, so `subagent_output_contains` never sees it and `semantic_matches` sees it only with `include_fork_results: true` (foreground fork only — a backgrounded fork's result carries no answer). Only when the MODEL invokes the skill: a `/<skill> …` prompt runs the fork with no `Skill` call and no such result — use `skill_triggered` + `transcript_matches` there |
| a pre-existing input wasn't mutated (incl. `uploads/**`) | `input_unmodified: <glob> \| [<glob>, …]` (live/verify-run) |
| no authored interactive artifact silently loses its Submit under Cowork | `no_lost_write_back: true` (**live-only**; static Tier A over the run's authored `.html`/`.py`/`.js`; per-scenario gate for the same class `analyze-skill` scans) |
| a resource ceiling held | `max_peak_rss_bytes: <N>` (**live-only**) |
| the user was **shown** the right choices, in order | `question_options: {when_question, equals: [..]}` — the option SET/ORDER a gate offered (`question_asked` matches the text only); order is compared by default |
| the user was **told something specific** at a gate | `question_context: {when_question, matches}` — a regex over the question label + option labels + option **descriptions**. Reach for this when the wording may land in an option's `description`, which `question_asked` and `question_options` cannot see |
| every gate offered exactly one (or at most N) options of a kind | `question_option_count: {matches, exactly}` — counts the option LABELS matching a regex on EVERY sub-question asked (`when_question` narrows); zero sub-questions asked fails |
| every gate was answered by a scripted rule (an unattended run that still asks) | `gates_all_scripted: true` with `gate_answer_count_min: 1` — fails naming any gate the LLM decider, `first`, or an external or human decider answered; `{include_permissions: true}` also fails cowork parity's permissive auto-allow (replay needs a `controlOut` cassette) |
| a **plugin's** command hook (any event: PreToolUse, Stop, …) blocked, didn't block, or decided | `hook_event_blocked: <event>` (exit 2) or `{event, tool?, via?, max: 0}`, `no_hook_event_blocked: true`, `hook_decision: {event, decision}` — stream content, no `controlOut` needed |
| the **harness's own** hook callbacks (the built-in Task hook, a custom hook bundle) blocked / didn't block a tool | `hook_blocked: <regex>`, `no_hook_blocked: true` (replay needs a `controlOut` cassette) — a plugin's hook never reaches this list, so `no_hook_blocked` passes over a plugin block |
| every MCP round-trip succeeded | `no_mcp_error: true` (**live-only**) |
| a context compaction happened | `compaction_occurred: true` |
| THIS run wrote the file (not just that it is there) | `file_exists: {path, authored: true}` (also `user_visible_artifact`, and `authored: true` on `artifact_text`/`artifact_json`) — an untouched pre-run file fails; needs the pre-run manifest, which `authored` arms |

Every one of these still obeys the two axes above — several are live-only or need a `controlOut`
cassette on replay, so check the catalog's replay class before putting one on a PR gate.
`cowork-harness assertions --list` prints the full, always-current key set with one-line semantics
straight from the schema — treat it (and the catalog) as the source of truth; this map is a
goal-oriented index into it, not a second catalog.

## Pointwise or pairwise judging

`semantic_matches` grades fixed claims against the run alone; reach for it when the criteria are concrete and
checkable. `semantic_pairwise` asks whether the run is better than, as good as, or worse than a **frozen reference**
— an earlier run's output, frozen once with `ref freeze` — and fits when quality is easier to compare than to score
(a rewrite of an existing skill, "is v2 better than v1"). Three cautions:

- **Freeze once, never regenerate.** A reference frozen from a run changes meaning if it is replaced; freeze a NEW
  store when the task or the evidence options change (a different prompt or scope is refused, not compared).
- **A per-case comparison cannot see a cross-case collapse.** If every output drifts toward one style, each can still
  "beat the reference". Pair it with a structural or set-level assert when that risk matters.
- **Do not judge with the model under test.** Pin a different `judge_model`; the harness warns when they match.

#### Step-scoped scenarios — test one late step of a long pipeline

A pipeline skill (score → draft → appendix) is expensive to re-run end to end just to check its last step.
Start the run from the state the earlier steps leave behind instead:

1. Run the pipeline once to the point you want (or stop it there) with `--keep`, then
   `cowork-harness fixture export <run-dir> --out fixtures/after-scoring` — it copies the run's `outputs/`
   byte-for-byte and refuses (writing nothing) a file that carries a secret or a host path. Commit the directory.
2. Point the scenario at it and ask for the late step only:

   ```yaml
   fidelity: container
   prompt: Draft the investor memo from the scored deck.
   workspace_fixture: fixtures/after-scoring        # copied into outputs/ before turn 1
   assert:
     - file_exists: {path: outputs/memo.md, authored: true}
     - artifact_json: {artifact: outputs/scores/deck.json, path: total, exists: true, authored: false}
     - semantic_matches: {rubric: ["the memo cites the deck's total score"], evidence_files: ["outputs/memo.md"]}
   ```
3. Assert on what the STEP produces. A fixture file the step never touched is pre-run, not authored, so
   `semantic_matches` does not grade it (a rewritten one is graded). A `file_exists`/`user_visible_artifact`/
   `artifact_text`/`artifact_json` on a fixture path is refused at load unless it says `authored: true`
   (the step must write it) or `authored: false` (inheriting it is fine) — otherwise it would pass on the
   fixture alone.

What it models: re-invoking the skill in the same Cowork session after it stopped mid-work or finished — the
files persist in `outputs/` and the skill resumes from them. The only difference is that the prior conversation
context does not come along; a skill that depends on it cannot be tested this way. Editing the fixture stales
the scenario's cassette (`fixture` staleness — re-record). Full rules: [Starting from a saved
workspace](https://github.com/yaniv-golan/cowork-harness/blob/main/docs/scenario.md#starting-from-a-saved-workspace-workspace_fixture).
