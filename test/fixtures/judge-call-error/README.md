# Judge call-error fixture

`claude-p-401-api-key.json` is one real `claude -p --output-format json` envelope, captured once from Claude Code
2.1.319 with a deliberately invalid `ANTHROPIC_API_KEY` and no other credential set:

```
env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY=<invalid> \
  claude -p --output-format json --model sonnet --tools "" --no-session-persistence \
  --safe-mode --strict-mcp-config --setting-sources user "say ok"
```

- The process exited **1**. stderr was empty.
- The call failed at authentication, before any model call (`total_cost_usd: 0`, `modelUsage: {}`).
- `session_id` and `uuid` are replaced with zeros; every other byte is as captured.
- Two details the transport must not trust: `subtype` is `"success"` on this error, and `modelUsage` is empty. The
  markers that identify an API failure are `api_error_status` and `terminal_reason: "api_error"`.

Tests replay it through a fake `claude` that prints it and exits 1, the real exit code.

`claude-p-404-unknown-model.json` is one real envelope from the same CLI and a working `CLAUDE_CODE_OAUTH_TOKEN`,
with a model id that does not exist:

```
printf 'ok' | env -u ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN=<valid> \
  claude -p --output-format json --model claude-no-such-model-1 --tools "" --no-session-persistence \
  --safe-mode --strict-mcp-config --setting-sources user
```

- The process exited **1**, with `is_error: true`, `api_error_status: 404` and `terminal_reason: "api_error"` at
  `total_cost_usd: 0`. An unknown model is an API 404, not a refusal at start-up, so the pre-spend check refuses it
  and names the model as the fix.
- `session_id` and `uuid` are replaced with zeros; every other byte is as captured.
