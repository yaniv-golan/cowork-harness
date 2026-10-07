# Assertion catalog

Tracks `cowork-harness 4.5.0` (baseline `desktop-2.26454.2`). Every `assert:` key with its semantics, and the
verdict-signal table. Which keys survive `replay` is in [`scenario-schema.md`](./scenario-schema.md#replay-class);
the scenario and session YAML fields are there too.

## Assertion catalog

Each list item under `assert:` is one assertion. **An item with multiple keys is an AND** — it
passes only if every key passes. Keep one concern per item unless you mean conjunction.

One schema key is deliberately not in the table: `replay_protocol_fidelity` is synthesized by `replay`
and is not authorable (see gotcha 18 in [`scenario-schema.md`](./scenario-schema.md#authoring-gotcha-list)).

Looking for a key *by what you want to prove* (tool health, sub-agent work, panels, skill
attribution, resources, diagnostics)? `assertions-guide.md`'s "goal → key" map is the by-purpose index into this
table; the per-key tables in the three files below are the full reference, and `cowork-harness assertions --list` prints the
same set live from the schema.

The per-key table is split by assertion family so each file stays well within what one Read returns whole:

- [`assertion-catalog-outcome-files-tools.md`](./assertion-catalog-outcome-files-tools.md): result, transcript_*, file and artifact, delete and write-back, tool_called / tool_not_called, reference access, tool_result_*.
- [`assertion-catalog-agents-skills-budgets.md`](./assertion-catalog-agents-skills-budgets.md): subagent_*, dispatch, skills and connectors, cost / token / turn / tool-error budgets, tasks, scratchpad and present_files delivery.
- [`assertion-catalog-gates-hooks-modifiers.md`](./assertion-catalog-gates-hooks-modifiers.md): AskUserQuestion gates, hooks, path denial, allow_* verdict modifiers, host-path leaks, egress, MCP, RSS, semantic judging, artifact_json, computer:// links.

**Name-matching styles differ by key (don't mix them up):** `tool_called`, `tool_not_called`,
`subagent_tool_used`, `subagent_tool_absent` are **glob** (anchored, case-sensitive, `*`/`?`). `tool_available`,
`skill_triggered`/`no_skill_triggered`, `skill_available`, `connector_available`, `skill_tool_used`,
`subagent_type` are **regex** (unanchored, case-insensitive). So `tool_called: mcp__workspace__*` (glob) but
`tool_available: mcp__workspace__.*` (regex) — a `.*` in a `tool_called` glob is a load-time schema error, not silently-matches-nothing.

**Content correctness:** match the assertion to the deliverable. Prose → `transcript_matches`
(regex, drift-tolerant) or `transcript_contains` (literal marker). `transcript_matches` is
case-insensitive; **single-quote** the regex in YAML (double-quoted YAML eats backslashes, so `"\d"`
breaks — use `'\d'`); the transcript is one concatenated string, so use `[\s\S]`, not `.`, to span
turns. Use `transcript_matches` only for **stable lexical markers**, not semantic content the model
paraphrases (that re-records red). Structured JSON → assert it in YAML with **`artifact_json`** (dotted
`path` + operator); use the pytest lane (`assert_artifact_json`) only for predicates too complex for a
dotted path.

**VerdictSignals in `result.verdict.signals`:** `computeVerdict` pushes signals into `result.verdict.signals`; eleven
are **fail**-severity (they flip the run's pass/exit code even though `result.result` itself stays
`"success"`) and thirteen are **warn**-severity (informational, never flip pass/fail). All twenty-four signal
codes (`VerdictSignal["code"]` in `src/run/verdict.ts`):

| Code | Severity | Meaning |
|---|---|---|
| `assertion` | fail | An authored `assert:` item failed |
| `result_error` | fail | The run's SDK result was `"error"` |
| `usage_limit` | fail | Usage/quota limit hit (not a skill failure) — retry after the limit resets. Emitted when `RunResult.resultErrorKind === "usage_limit"` |
| `transport_error` | fail | The connection dropped mid/after-run |
| `permissive_auto_allow` | fail | A cowork-parity auto-allow real Cowork would block (opt out: `allow_permissive_auto_allow`) |
| `outputs_delete` | fail | An unauthorized delete touched `mnt/outputs` on a baseline that records outputs `rw` (not raised on `rwd`, Desktop 2.16120.0+, unless `no_delete_in_outputs` or `no_delete_in_mounts` (outputs not waived) is authored — with `no_delete_in_outputs` that assertion fails instead; with `no_delete_in_mounts` this signal itself fires, and its message names that key), confirmed: the per-turn filesystem diff proves it, a delete in command/call position has an `outputs/` path as its own operand, or the diff could not verify the turn. Authoring `no_delete_in_outputs` moves it into that assertion; `allow_outputs_delete` waives it |
| `outputs_delete_unconfirmed` | warn | A delete-shaped command near `mnt/outputs` nothing confirms: no output present at turn start was deleted and no flagged delete has an outputs path as its own operand (e.g. a Python variable named `rm` next to an outputs path, quoted prose, a `sed`/`grep` pattern). A *statement* is a fragment split on newline/`;`/`&&`/`\|\|`, quote-blind, so some real deletes also land here — a loop body whose operand is the loop variable (`for f in …; do rm "$f"; done`), a `cd` then a relative path, chained variables (`A=…; B=$A/x; rm "$B"`), a Python path held in a variable set on another line (`p = …` then `os.remove(p)`, or `for p in …:` then `p.unlink()`), wrappers with flag combinations the classifier does not model (`sudo -Hu user rm`, `git -C dir rm`), and calls outside the modelled set such as Node's `fs.promises.rm(…)` — read the command. Raised even when `no_delete_in_outputs` is authored (that assertion passes on it); not raised on an `rwd` baseline (Desktop 2.16120.0+) unless that key, or `no_delete_in_mounts` with outputs not waived, is authored. Kept false positives that still fail `outputs_delete`: quoted text in which a delete command with an outputs operand follows a shell separator, subshell or keyword — the classifier does not track quotes (`echo 'note; rm mnt/outputs/x'`, `echo "a & rm …/outputs/x"`), and a heredoc that *writes* a script rather than running it (`cat <<EOF > clean.sh` with an `rm …/outputs/x` line). Waive: `allow_outputs_delete` |
| `outputs_diff_unavailable` | warn | The per-turn filesystem diff of `outputs/` could not verify this turn and the text scan flagged nothing — a delete made without a bash command would have gone undetected. With a text hit the turn fails `outputs_delete` instead. Like `outputs_delete_unconfirmed`, not raised on an `rwd` baseline unless `no_delete_in_outputs` or `no_delete_in_mounts` (outputs not waived) is authored |
| `mount_delete` | warn | A delete touched a delete-denied mount other than `outputs` (a `rw` connected folder). Production denies `unlink`/`rmdir` there until per-mount approval, so the run diverged. Warn, not fail: the harness detects post-hoc what production enforces. Author `no_delete_in_mounts` to hard-fail, or `allow_delete_in` to waive |
| `host_path_leak` | fail | A host path leaked into model-visible text (opt out: author `transcript_no_host_path`). A path copied verbatim from the scenario's own uploads, connected folders, prompt, or declared plugins' or local skills' files is not a leak |
| `l0_host_config_contamination` | fail | `protocol` ran against the operator's REAL config dir, so host-installed plugins/skills/MCP servers may have answered instead of the thing under test — the run did not necessarily measure it (opt out: `allow_l0_host_config_contamination`). Name predates the meaning: delivery at L0 works, contamination is what this reports |
| `missing_capability` | fail | A `requires_capabilities` need was unmet, or the skill used a capability the image omits (opt out: `allow_missing_capability`, or `skill --allow-missing-capability` on an open-ended run) |
| `infra_error` | fail | A supervising process died mid-run (VM/egress sidecar) — the run's evidence is contaminated, not author-suppressible |
| `stalled` | fail | The run ended asking for input with no tool work after the last gate. "Asking" = the final turn's closing sentence ends in `?`; or, once an `AskUserQuestion` gate has fired, it ends in `?` after trailing bold/quotes/`)`/emoji, is a `?` followed only by a `For example: …`/parenthetical aside, or is a request that says the input comes back to the agent (`Please share/provide/upload… so I can…`/`…here`, `Let me know which… you'd like me to use`, `Once you share… I'll…`, `I need X to proceed`, `Once I have the file, I'll…` after a sentence asking for it). Polite closers and hand-offs (`Let me know if…`, `Feel free…`, `with your`/`to your`, `before sending`, `If you…`) and a closing code block or blockquote never count. Hand-offs to a named third party (`with the team`, `to the founders`, `with the CFO`) never count either; `here` is a cue only after share/paste/upload/drop/reply/type/send or as the last word. English-only. Opt out with `allow_stall` (on `run`, `replay` and `eval`); without it, under `eval` a stalled rep is `errored_agent` and fails every row |
| `non_deterministic` | warn | The run was LLM/external/human-decided — not reproducible |
| `model_fallback` | warn | The agent fell back off the requested model mid-run (SDK `model_fallback` event); a `model_not_found`/`model_blocked` trigger repeats every run until the pin changes |
| `prompt_asset_missing` | warn | The run proceeded with a missing prompt asset (`COWORK_HARNESS_ALLOW_MISSING_PROMPT=1`); fidelity is degraded |
| `scan_unavailable` | warn | Post-run scan evidence unavailable (`RunResult.scan` undefined) — the host-path guard and the outputs-delete text scan did not run this run; the outputs filesystem diff still ran |
| `ended_with_question` | warn | Live-lane heuristic: the final answer contains a question (or closes on a request for input, the same test as `stalled`) and the run wrote no deliverable to `outputs/` — the lenient sibling of `stalled` (covers a mid-message `?`, or tool work after the last gate that still ended asking). Opt out: `allow_stall` |
| `undelivered_deliverables` | warn | The skill produced file(s) OUTSIDE every user-visible root and never delivered them, so they stay invisible to the user. Fires on every run without opting in, because the scenarios that most need it are the ones whose author never considered delivery. Silent when the evidence cannot answer the question (no workspace walk, a tier that runs no scratchpad walk, absent delivery telemetry, a resumed turn, or a lane where delivery is unobservable — see `delivery_unobservable`) — never a vacuous clean. **`lane: local` only**: on remote, delivery cannot be measured at all, so that lane reports `delivery_unobservable` instead of guessing. Opt out: `allow_undelivered_deliverables` |
| `delivery_unobservable` | warn | `lane: remote` only — the run produced file(s), but whether any reached the user CANNOT be verified: nothing is delivered by location on that lane and the harness models no remote delivery tool (production uses the agent-native `SendUserFile`). The honest counterpart to `undelivered_deliverables`, which would otherwise fire on every remote run that writes anything — a signal that always fires carries no information. Mutually exclusive with it; quiet when the run produced nothing to deliver. A harness coverage gap, not a skill defect. Opt out: `allow_undelivered_deliverables` |
| `partly_scripted_gate` | warn | A question batch (one `AskUserQuestion` with several sub-questions) that the scenario's `answers:` matched only PART of. Answers are delivered atomically, so the whole batch went to the `on_unanswered` fallback and the matched answers were NOT delivered — the fallback may contradict them. The message names the matched and unmatched sub-questions and who answered instead; `result.partlyScriptedGates` carries the full lists. Fires only on a partial match within one batch (a single-question gate no rule matched is the ordinary unanswered case). Re-derived on `replay` (from the cassette's frozen answers) and `verify-run` (from the current scenario). Fix: script every sub-question of the batch |
| `parked_at_question` | warn | The session declares `answer_channel: none` and the run ended on a question nobody can answer, by `stalled`'s rule (its last message asks and no tool ran after its last gate; a skill that runs a tool before asking passes with neither). Takes the place of the `stalled` fail: with no answer channel, stopping at the question is the contract. Completion is judged from the file assertions such a scenario must carry (refused at load without one). No opt-out needed |
| `exec_infra_error` | warn | Host-loop: one or more container `exec` calls failed for infrastructure reasons, so those tool calls returned an error to the agent. Warns rather than fails because the run's other evidence is intact — unlike `infra_error`, where a dead supervisor contaminates everything. Caveat: if *every* exec failed, the agent ran nothing and this still only warns — check `result.infraErrors` |

A **fail**-severity signal does not change `result.result` (still `"success"`), but it DOES fail the
overall run verdict and exit code — `assert result: success` alone won't catch it; check
`result.verdict.signals[].severity` or the run's exit code. Only the thirteen **warn** codes are truly benign.
