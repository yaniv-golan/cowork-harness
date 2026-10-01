# pairwise-judge fixtures

`claude-p-json-schema-envelope.json` — one REAL `claude -p --output-format json` envelope from Claude Code
2.1.286, captured once (claude-haiku-4-5, trivial prompt) with:

```
claude -p --model claude-haiku-4-5 --output-format json \
  --json-schema '<PAIRWISE_JSON_SCHEMA>' --system-prompt '<short judge preamble>' --tools ""
```

Only `session_id` and `uuid` were changed (zeroed). It pins two facts the pairwise judge depends on: the
structured answer arrives in a separate `structured_output` field (`result` holds the same JSON as text), and a
clean run reports `subtype: "success"`. Re-capture, never hand-edit, if the CLI's envelope changes.
