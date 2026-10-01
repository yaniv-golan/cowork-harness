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
  (one `Agent` dispatch, seven sub-agent tool calls). `events.jsonl` keeps only the `assistant`, `user`, `result` and
  `system/init` frames; the init frame's tool, skill, plugin and agent lists were removed. Control, rate-limit and task
  frames were dropped, since the code under test reads none of them. The run's `claude-config/projects/<cwd>/<session>/subagents/`
  files are verbatim. In every file the home directory became `~` and the login name became `USER`.