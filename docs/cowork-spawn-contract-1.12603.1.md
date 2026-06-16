# Cowork spawn contract — app.asar 1.12603.1 / agent ELF 2.1.170

Binary-verified this session. Anchors: asar `/tmp/asar-review/.vite/build/index.js` find `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS:"1"` (spawn env), `function TSO(` (settings filename), `{{workspaceContext}}` (prompt template); ELF `strings | grep`.

## Execution mode
- **Production runs host-loop** (gate `1143815894` forced on in this machine's fcache). Harness emulates **VM-loop** (gate off / `requireCoworkFullVmSandbox` orgs). Both real; bash-visible world (`/sessions/<id>/mnt/...`) is shared, agent-loop world differs. Record per-baseline.

## Cowork mode enablement
- `CLAUDE_CODE_IS_COWORK="1"` (env). **NOT** `--cowork` (SDK passes no such flag) and **NOT** `CLAUDE_CODE_USE_COWORK_PLUGINS` (Desktop does not set it).
- `TSO()` verbatim: `if(q.coworkPlugins||K8(process.env.CLAUDE_CODE_USE_COWORK_PLUGINS))return"cowork_settings.json";return"settings.json"`. So setting USE_COWORK_PLUGINS flips userSettings → `$CLAUDE_CONFIG_DIR/cowork_settings.json` and plugin cache → `$CLAUDE_CONFIG_DIR/cowork_plugins` — files the host never populates for the in-VM agent. **Do not set it.**

## SDK query options (→ CLI flags)
- `cwd: "/sessions/<id>"` (NOT mnt root). → container `-w /sessions/<id>`.
- `CLAUDE_CONFIG_DIR = /sessions/<id>/mnt/.claude`.
- `pathToClaudeCodeExecutable: /usr/local/bin/claude`.
- `plugins: [{type:"local", path:"/sessions/<id>/mnt/.local-plugins/cache/<name>"}]` → `--plugin-dir <path>` (repeatable). Enabled-plugin resolution is host-side; the VM agent never reads `enabledPlugins`.
- `tools: [Task,Bash,Glob,Grep,Read,Edit,Write,NotebookEdit,WebFetch,TaskCreate,TaskUpdate,TaskGet,TaskList,TaskStop,WebSearch,Skill,REPL,JavaScript,AskUserQuestion,ToolSearch]` → `--tools …`. (No TodoWrite/NotebookRead/BashOutput/KillShell.)
- `allowedTools:` same built-ins **minus AskUserQuestion** + curated `mcp__*` (cowork servers the harness doesn't run) → `--allowedTools <built-ins>`.
- `permissionMode:"default"`, `allowDangerouslySkipPermissions:!0` → `--allow-dangerously-skip-permissions` is a *capability grant* (permits bypass switching), mode stays default. Harness: skip the flag (deliberate delta).
- `settingSources:["user"]` → `--setting-sources=user`.
- `effort:` default `"medium"` → `--effort`. (`CLAUDE_EFFORT` env is a no-op.)
- `maxThinkingTokens:` default `DEFAULT_MAX_THINKING_TOKENS=31999` → `--max-thinking-tokens` (always passed; never 0).
- System prompt: the SDK `initConfig.systemPrompt` schema accepts both a full string (replacement) AND a `{type:"preset",preset:"claude_code",append}` shape (plus `appendSystemPrompt` / `appendSubagentSystemPrompt`). **Cowork's two local-agent spawn sites (asar ~12,658,441 fork, ~12,751,439 main) use the PRESET+APPEND form by default** — the agent's built-in `claude_code` base prompt **plus** the cowork append (`y8r`, asar ~9,841,199); full-replacement only fires when a server-pushed `spawnSeed.systemPrompt`/`spVariant.mode==="replace"` is present (the exception). On the wire that is `appendSystemPrompt`, **semantically identical** to the harness's `--append-system-prompt` flag — so the harness's append-onto-preset is faithful (it intentionally does NOT bundle the verbatim prompt; it renders a reconstruction — see `src/prompt.ts` + `baselines/prompts/desktop-1.12603.1/system-prompt-append.md`). *(An earlier reading of this line as "Cowork sends a full `initConfig.systemPrompt` replacement" was wrong — corrected after binary re-verification, 2026-06-16.)* `appendSubagentSystemPrompt` travels over `initialize` (gated by `CLAUDE_CODE_ENABLE_APPEND_SUBAGENT_PROMPT`).

## Spawn env object (static keys; literal values)
```
CLAUDE_CONFIG_DIR=/sessions/<id>/mnt/.claude
CLAUDE_CODE_OAUTH_TOKEN=<token>            ANTHROPIC_BASE_URL=<apiHost>
ANTHROPIC_API_KEY="" ANTHROPIC_AUTH_TOKEN="" ANTHROPIC_CUSTOM_HEADERS="" (blanked, then re-set with app-version header)
CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1     CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL=true
MCP_CONNECTION_NONBLOCKING=true            CLAUDE_CODE_DISABLE_CRON=1
CLAUDE_CODE_ENTRYPOINT=local-agent         CLAUDE_CODE_TAGS=lam_session_type:chat
CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1     CLAUDE_CODE_DISABLE_AGENTS_FLEET=1
CLAUDE_CODE_IS_COWORK=1                     CLAUDE_CODE_ENABLE_APPEND_SUBAGENT_PROMPT=1
ENABLE_PROMPT_CACHING_1H=1                 DISABLE_MICROCOMPACT=1
CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1       CLAUDE_CODE_ENABLE_TASKS=true
CLAUDE_CODE_HOST_PLATFORM=<platform>       TZ=<host tz>
```
Host-derived/conditional (do not hardcode): `CLAUDE_CODE_ACCOUNT_UUID/_USER_EMAIL/_ORGANIZATION_UUID`, `CLAUDE_CODE_WORKSPACE_HOST_PATHS`, `OTEL_*`, gate-conditional `MCP_*`/`ENABLE_TOOL_SEARCH`/`CLAUDE_CODE_SUBAGENT_MODEL`.

## Permission model (canUseTool, three layers)
1. `allowedTools` pre-approval — built-ins never prompt.
2. `canUseTool`: `mcp__workspace__web_fetch` auto-allow after egress-allowlist URL check; session rule cache `Hen(...)` auto-allows user-approved (`permission_auto_approved`); `duA()` always-ask set never cached.
3. Unmatched → `handleToolPermission` → human UI (no auto default). Plus a PreToolUse hook forces "ask" for 5 cowork tools (`mcp__cowork__allow_cowork_file_delete`, `request_cowork_directory`, `launch_code_session`, `create/update_scheduled_task`); PreToolUse `Task` blocks `run_in_background`.

## System prompt (verbatim-extractable)
- Base template at asar offset ~9,005,714; tokens `{{cwd}} {{workspaceFolder}} {{workspaceContext}} {{userSelectedFolders}} {{skillsDir}} {{folderSelected}} {{modelName}} {{accountName}} {{emailAddress}} {{currentDate}} {{currentTimezone}} {{promptCacheBoundary}}`. Builder `y8r`: `{{cwd}}→/sessions/<id>`, `{{skillsDir}}→/sessions/<id>/mnt/.claude`, `{{workspaceFolder}}→/sessions/<id>/mnt/<firstFolder>` or `/sessions/<id>/mnt/outputs` if none. Server `spVariant`/`rendererAppends` can override — un-modelable delta.
- Guest = "lightweight Linux VM (Ubuntu 22)".

## Other agent-side facts
- `disableSkillShellExecution=true` in cowork mode (`iE6`) — inline ```! shell blocks don't run.
- Outputs delete: per-mount delete-deny + always-ask `mcp__cowork__allow_cowork_file_delete` + `fileDeleteApprovedMounts` → `rm` fails `Operation not permitted`, skill must request permission.
