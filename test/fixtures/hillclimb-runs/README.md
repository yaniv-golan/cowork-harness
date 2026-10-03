# hillclimb-runs fixtures

Excerpts of real kept runs of the repo's own public examples, and labelled SYNTHETIC fixtures, used by the `hillclimb` row/trace tests.

- `result-event-pair.jsonl`: the `system/init` frame and the final `{type:"result"}` frame of a kept container run of
  the repo's public example `examples/scenarios/csv-metrics.yaml` (agent 2.1.280). Every key and value is as recorded, except
  for two changes: content-bearing fields were removed (the tool, skill, plugin, agent and slash-command lists,
  `memory_paths`, `messaging_socket_path`, `permission_denials`), and the final answer text in `result` became
  `<trimmed: final answer text>`. The reader under test reads none of those fields.
- `assistant-models-fanout.jsonl`: SYNTHETIC, written by hand. It mirrors the shape of a real hostloop fan-out
  stream (`assistant` events, `parent_tool_use_id` null on the main loop and set on sub-agent events, `message.model`
  per event), reduced to those three fields. The main loop runs on `claude-opus-5`; one sub-agent runs on the same
  model and another on `claude-sonnet-5`. The real-data check for this path is the paid end-to-end run, with a
  sub-agent on a different model.
- `fanout-probe/`: a kept hostloop run of the repo's public example `examples/scenarios/subagent-manifest-probe.yaml`
  (one `Agent` dispatch, seven sub-agent tool calls). Real excerpts, with these changes:
  - `events.jsonl` keeps only the `assistant`, `user`, `result` and `system/init` frames; the init frame's tool,
    skill, plugin and agent lists were removed, as were control and task frames and one `<synthetic>`
    rate-limit assistant frame. The `result` frame's text became `<trimmed: rate-limit message>`. Inside the
    `Agent` tool result, the agent binary's hand-back frame and trailer were replaced with `<withheld: …>` markers.
  - The sub-agent transcript `subagents/agent-*.jsonl` keeps only its `assistant`/`user` lines. Its attachment
    lines were removed: they carried Anthropic's built-in sub-agent prompt and tool list, and the reader skips
    them. `.meta.json` is verbatim.
  - In every file the home directory became `~` and the login name became `USER`.
- `forked-skill/`: SYNTHETIC, written by hand. It mirrors the shape of a real hostloop run in which the main loop called
  `Skill` on a `context: fork` skill: the parent stream carries the fork's 17 tool calls and results as parented events,
  and the fork's `subagents/` transcript repeats them with the same tool ids. Its `.meta.json` has no `toolUseId`, as a
  real fork's meta does not. All text is `<trimmed>`.
- `account-frames.json`: the credential frames the billing-basis reader reads, keyed by what each one shows. The
  `init_*` frames are the `system/init` frame of `result-event-pair.jsonl` with `apiKeySource` set to a value kept
  runs recorded (`none`, `ANTHROPIC_API_KEY`), or to `apiKeyHelper`. Each `account_*` frame is the `init-1` `control_response` of a kept run, reduced to its
  `account` block, `pid`, `current_permission_mode` and `fast_mode_state` (the command, agent and model lists were
  removed). Every identity value was replaced: `email` became `user@example.invalid`, `organization` became
  `Example Org`, the `subscriptionType` value became `example-plan`, and the `pid` became `12345`. The
  `rate_limit_*` frames are kept `rate_limit_event` frames with their ids replaced by placeholders.
  `init_api_key_helper`, `account_auth_token`, `account_bedrock`, `account_api_key_helper` and
  `account_claude_ai_and_key` are SYNTHETIC: no kept run used those sources. Their shape follows the
  agent's own account schema (agent 2.1.286), with the identity fields left out as it leaves them out.
