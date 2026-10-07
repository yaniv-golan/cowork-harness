# Headless runs with no answer channel

Real Cowork always has someone to answer the agent: every question (`AskUserQuestion`) and every
permission prompt reaches the user. Some hosts run a skill with **nobody** to answer — a headless SDK
host, for instance. A skill written for both kinds of host often records its own progress in a status
file and writes `waiting` *before* it asks, so a host that cannot answer finds the run parked at the gate.

The session key `answer_channel: none` reproduces that contract. It is **not** a Cowork setting, and every
surface says so: the run banner, the footer and `stats` label the run
`[headless, no answer channel — not Cowork]`, and `result.json` carries `answerChannel: "none"`.

## What it changes

The agent is spawned with `--permission-prompts none` in place of `--permission-prompt-tool stdio`, so it
answers its own permission prompts with a deny instead of sending them to the harness. The flag also removes
`AskUserQuestion`, `EnterPlanMode` and `ExitPlanMode` from the tools the agent offers the model (agent 2.1.293,
the same in every permission mode), so the model has no question tool to call. Anything that still reaches the
harness is refused (see below). Everything else about the spawn — the rest of the toolset, the system prompt,
the mounts, the egress allowlist — is unchanged, so the delivery, egress, file and transcript assertions still
grade real behaviour.

- **A run ends `success` whether or not the skill finished.** Completion is judged from the files the
  skill wrote, so a scenario must carry at least one positive file assertion (`artifact_json`,
  `artifact_text`, `file_exists` or `user_visible_artifact`) or it fails to load. `file_absent` does not
  count: a skill that did nothing passes it. The harness checks that the key is there, not that only the
  skill could satisfy it: point it at a value the skill writes (the status file's `status`), not at a file an
  upload or connected folder already provides. A `workspace_fixture` file is refused unless the assertion
  states `authored:`.
- **Stopping at a question is the contract, not a stall.** A successful run whose last message ends in `?`
  gets the `parked_at_question` warning, never the `stalled` failure. The warning does not change the verdict
  or the exit code: the file assertions decide those. Unlike `stalled`, it fires even when tools ran before
  the question, since a gated skill always runs its own script first. It reads only the closing `?`, so it has
  two known misses: a finished answer that ends on an offer ("Want me to deliver it?") warns too, and a request
  for input phrased without one ("Please share the raise amount.") does not fire.
- **A request that reaches the harness anyway** (an agent that ignored the flag) is refused, never
  answered, and the run ends `error` with `errorSource: "answer_channel_violation"`. Answering it would
  invent the channel the run declares absent. `result.json` does not say which request arrived; the run's
  `events.jsonl` and `control-out.jsonl` do.

## What the model does at the gate

With no question tool on offer, the model asks in prose and ends its turn. In three runs of the example below
(agent 2.1.293, `claude-sonnet-5`), the model invoked the skill, ran its script, which wrote `waiting`, then
ended with a plain-text question asking which option to continue with. Each run ended `success`, both
assertions passed, and each is reported with the `parked_at_question` warning. Whether the skill parked at the
right gate shows only in the status file, which is why a file assertion is required.

## Requirements and refusals

Each of these is a load error, raised before anything is staged or spent, and reported the same way by
`record --dry-run` and the pre-flight of a `run`, `record`, `eval` or `hillclimb` batch:

| Refused | Why |
|---|---|
| `permission_mode` other than `bypassPermissions` | under any other mode the agent's ordinary permission asks are denied too, including Cowork's own `present_files`, and plan mode can never exit |
| `fidelity: hostloop`, or `cowork` | the host loop's folder-grant and web_fetch guards are answered over the channel this removes |
| `lane: remote` | the cloud lane's permission surface is unmeasured |
| `answers:`, `on_unanswered`, `--on-unanswered`, `--decider-llm`, `--decider-cmd`, `--decider-dir`, `--decider-model` | no question reaches the harness, so nothing can be scripted or decided |
| `permission_parity: strict` | it configures how permission asks are answered, and none are asked |
| `web_fetch.approved_domains` | approving a domain answers a prompt this run cannot show |
| `question_asked`, `question_options`, `question_context`, `question_option_count`, `gate_answers_delivered`, `gate_answer_count_min`, `gates_all_scripted` | each grades a gate the harness answered |
| `questions_count_max` | it counts the questions that reach the harness, and none do, so it would always pass |
| `tool_called` naming `AskUserQuestion` (or a glob such as `AskUser*`) | the flag removes the tool, so it can never be called; assert the status file instead |
| an agent that does not accept `--permission-prompts none` | the pinned agent's support is recorded by `sync` in the baseline (`agentBinary.cliCapabilities`); a baseline synced before that field existed is refused with a re-sync hint. At `protocol`, the `claude` on your `PATH` is checked with `--help` instead. Every agent measured so far has the option, so the refusal for one that lacks it is tested on synthetic samples only |

`tool_not_called: AskUserQuestion` is accepted, though with the tool removed it always passes. `chat` and
`skill` build their own session from flags, so they cannot declare the key.

The assertion rules above also apply when a run with no answer channel is graded against a new `assert:`
block: `verify-run`, `replay --assert-from` / `--reassert` and `hillclimb regrade` refuse a block the run
itself would refuse at load.

## Telling a skill where to write: `agent_env.artifacts_root`

A skill that takes its run-status directory from `COWORK_ARTIFACTS_ROOT` can be pointed at outputs with one
session field. The value is a path relative to outputs; each tier resolves it against outputs as the agent
sees it, so the same session file works at `container`, `microvm` and `protocol`. It is not tied to
`answer_channel` and works without it, but it is refused at `hostloop`, whose shell commands run in a
separate container that never sees the agent's environment.

## Example

```yaml
# sessions/headless.yaml
model: claude-sonnet-5
answer_channel: none
permission_mode: bypassPermissions
agent_env:
  artifacts_root: artifacts       # COWORK_ARTIFACTS_ROOT = <outputs>/artifacts
plugins:
  local_plugins: [../my-plugin]
```

```yaml
# scenarios/parks-at-gate.yaml
name: parks-at-gate
baseline: latest
session: ../sessions/headless.yaml
fidelity: container
prompt: "…invoke the gated skill…"
assert:
  # the status file the skill's own script wrote before the gate (paths are relative to the work root)
  - artifact_json: { artifact: outputs/artifacts/runs/r1/run_status.json, path: status, equals: waiting }
  # the script that writes it ran, rather than the model writing the file itself
  - tool_called: { tool: Bash, input: { command: "step1\\.py" } }
```

`artifact_json` takes a literal path, so the run id must be predictable: pin it in the skill's own
fixture, or read a fixed id the skill documents. A working copy of this pair is
`examples/probes/gated-probe-headless.scenario.yaml` with `examples/sessions/gated-probe-headless.yaml`.

## What this is not

It models one property of a host — nobody answers — on Cowork's own spawn. It is not an emulation of any
other product: a real headless host differs in its image, filesystem layout, plugin path and lifecycle.
Use it to check that a skill parks correctly at its gate, not to certify the skill on that host.

A recording made with the key freezes it into the cassette (format v15), replays with the channel still
absent, and goes stale under `verify-cassettes` if the key is removed from the session.
