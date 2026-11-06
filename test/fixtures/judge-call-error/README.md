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
