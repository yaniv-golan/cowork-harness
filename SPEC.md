# Authoritative spec — cowork-harness

The single source of truth for **what the harness must produce** given its inputs. Golden snapshot tests assert the **contract layer** against this; live contract tests assert the **runtime layer** against the real binary. Anything that contradicts the binary wins over this doc — keep them in sync via `cowork-harness sync` + the [spawn contract](./docs/cowork-spawn-contract-1.12603.1.md).

> **Reading this for how-to?** This is the *contract* (envelopes, exit codes, assertion semantics). To
> author a scenario or run the harness, start at the [README](./README.md) and [docs/](./docs/README.md);
> come here when a doc and the code disagree.

## 0. Model

```
platform baseline (baselines/desktop-*.json)   what Cowork's runtime IS this release (auto-synced)
session setup (sessions/*.yaml)           what the user set up pre-prompt (model, folders, plugins, …)
scenario (scenarios/*.yaml | `skill` cmd)    the prompt + scripted answers + assertions
                         │
                         ▼
            buildLaunchPlan(session, baseline) ──► LaunchPlan (pure data)
                         │
        decideLoop(baseline, overrides) ──► effective fidelity
                         │
   ┌─────────────────────┼───────────────────────────────────────┐
   ▼ (pure: argv+env)    ▼                                        ▼
 contract layer    runtime layer (stage fs, spawn, drive)   egress sidecar
```

Two layers, tested differently:

- **Contract layer** — pure functions of `(baseline, session, scenario, sessionId)`: the launch plan, the docker/limactl **argv + env**, the control-protocol **messages**, the loop **decision**, the **assertions**. Deterministic ⇒ golden snapshot tests (§7).
- **Runtime layer** — fs staging, process spawn, the live agent. Needs Docker + a token ⇒ live contract tests (§8).

## 1. Loop decision (`src/loop-decision.ts`) — exact replica of Cowork `f_()`

```
decideLoop(i):
  if i.requireFullVmSandbox === true   → "vm"      # HeA()
  if i.devForceHostLoop      === true  → "host"    # CLAUDE_FORCE_HOST_LOOP=1 + dev-approved
  return i.gateHostLoopOn ? "host" : "vm"          # gate 1143815894
```

`fidelity: cowork` ⇒ `decideLoopFromBaseline(baseline)` → `host`⇒`hostloop`, `vm`⇒`container`. Gate state from `baseline.provenance.gates["hostLoop:1143815894"]` (synced from `fcache`; currently `on(force)` ⇒ `cowork → hostloop`). Explicit `protocol|container|microvm|hostloop` bypass the decision.

## 2. Launch plan (`buildLaunchPlan`) — pure

Given a session + baseline, returns:

| field | value |
|---|---|
| `configDir` | managed host dir (or `session.plugins.config_dir`); contains `settings.json`, `cowork_settings.json`, `skills/` |
| `mounts[]` | `{hostPath, mountPath, mode}`, `mountPath` **relative to mnt**: `uploads/<f>`, `<collision-resolved-basename>` (work folders), `.local-plugins/marketplaces/<marketplace>/<plugin>` (marketplace-resolved), `.local-plugins/cache/<name>` (direct `local_plugins`), `.remote-plugins/<name>`. (≥1.14271.0; older baselines mount work folders at `.projects/<id>`, which is now a reserved name.) |
| `pluginDirs[]` | mnt-relative plugin roots → `--plugin-dir` (incl. marketplace-resolved plugins) |
| `model/effort/extendedThinking/permissionMode/permissionParity` | from session |
| `egressAllow[]` | `baseline.network.allowDomains` + `session.egress.extra_allow` (or `["*"]` if unrestricted) |

**Marketplace resolution (required):** for each `local_marketplaces` dir, parse `.claude-plugin/marketplace.json`; for each `session.plugins.enabled` entry `name@mkt` matching `manifest.name`, resolve `manifest.plugins[name].source` → a `.local-plugins/marketplaces/<marketplace>/<plugin>` mount + pluginDir. This reproduces the real desktop spawn argv (`--plugin-dir …/marketplaces/<mp>/<plugin>`). (Cowork loads plugins via `--plugin-dir`; the registry is inert in-VM — §6.)

## 3. Spawn argv + env (contract layer) — what each tier MUST emit

Resolved inputs: `sessionRoot=/sessions/<id>`, `mntRoot=/sessions/<id>/mnt`, `configGuest=/sessions/<id>/mnt/.claude`.

### 3.1 Common agent args (container, microvm, and hostloop's native process)

Hostloop's agent process is a NATIVE host spawn (§3.4), not a container occupant — it reuses this exact
arg-building function (`baseAgentArgs`) but with **HOST paths** for the two guest-relative params
(`mntRoot`/`mcpGuest` become real host paths to the staged mnt tree/mcp.json), and the argv is passed
directly to `child_process.spawn(nativeBinary, args, …)` with **no leading `claude` token** (container/
microvm still prepend it for the `docker run … claude …`/`limactl … claude …` command form).
```
claude -p --verbose
  --input-format stream-json --output-format stream-json
  --permission-prompt-tool stdio
  --permission-mode <session.permissionMode ?? baseline.spawn.permissionMode ?? default>
  --setting-sources user
  --effort <session.effort ?? baseline.spawn.effortDefault>
  --max-thinking-tokens <resolved budget>        # always emitted (never 0)
  [--append-system-prompt <rendered cowork sections>]
  [--model <session.model>]
  [--mcp-config <configGuest>/mcp.json]         # if session.mcp.config set — HONORED in plain cowork mode (§6)
  (--plugin-dir <mntRoot>/<p>)…                 # one per pluginDirs entry
  --tools <baseline.spawn.tools…>                # variadic, LAST
  --allowedTools <baseline.spawn.allowedTools…>  # variadic, LAST
```
Variadic `--tools`/`--allowedTools` MUST be last (they consume to end-of-args).

### 3.2 Spawn env (container/microvm)

Hostloop's native process does NOT use this env shape — see §3.4 for its own `hostNativeSpawnEnv`
(deliberately different: real `HOME`, no forced `/tmp`, no HTTP(S)_PROXY).
```
<baseline.spawn.env …>                  # CLAUDE_CODE_IS_COWORK=1, ENTRYPOINT=local-agent,
                                        # DISABLE_BACKGROUND_TASKS=1, ENABLE_APPEND_SUBAGENT_PROMPT=1, …
CLAUDE_CONFIG_DIR = <configGuest>
MAX_THINKING_TOKENS = <baseline.spawn.maxThinkingTokens>   # never 0
HOME = /tmp
HTTP(S)_PROXY / http(s)_proxy = <egress proxy>
[TZ] [ANTHROPIC_API_KEY] [CLAUDE_CODE_OAUTH_TOKEN]        # passthrough iff set in host env
```
MUST NOT set `CLAUDE_CODE_USE_COWORK_PLUGINS`. MUST NOT blanket-passthrough host `CLAUDE_*`.

**Auth-env fidelity note (2026-06-13).** Real Cowork passes **only** the OAuth token: the desktop's
VM-env builder `rtA()` sets `CLAUDE_CODE_OAUTH_TOKEN` and blanks `ANTHROPIC_API_KEY` /
`ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_CUSTOM_HEADERS` to `""`, then `itA()` **deletes** each empty one —
so the final env has the token and **no** API-key vars at all. **IMPLEMENTED** (`host-env.ts`
`runtimeAuthEnv()`): when `CLAUDE_CODE_OAUTH_TOKEN` is present the harness mirrors the desktop and
passes **only** the token, dropping `ANTHROPIC_API_KEY`; `ANTHROPIC_API_KEY` is forwarded **only** when
there is no token (the CI/headless fallback the harness intentionally keeps). (`CLAUDE_CODE_EXECPATH`
is the agent's *own* `process.execPath` — never forward a host value; covered by the "no blanket
`CLAUDE_*`" rule above.)

### 3.3 L1 container (`spawnContainer`)
```
docker run --rm -i --platform linux/arm64 --network <net>
  [--cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp:… --pids-limit 1024]  # lockdown
  -w /sessions/<id>
  -e …(§3.2)
  -v <agentHost>:/usr/local/bin/claude:ro
  -v <sessionHost>:/sessions/<id>            # writable session world
  cowork-agent-base:2
  claude …(§3.1)
```

### 3.4 host-loop (`spawnHostLoop`) — a NATIVE host process + a no-agent Docker VM sidecar

Reproduces production's real host-loop architecture: the agent LOOP is a native macOS process spawned
directly on the host (no container around its file tools), while `bash`/`web_fetch` route into a Docker
container that never runs an agent at all.

**The native process:**
```
child_process.spawn(<resolveHostAgentBinary(baseline)>, [ …§3.1 args, HOST paths … ], {
  cwd: <mntHost>/outputs,
  env: { ...process.env, ...hostNativeSpawnEnv(baseline, { configDir: plan.configDir, … }) },
})
```
- `--disallowedTools Bash WebFetch NotebookEdit`; append `mcp__workspace__bash mcp__workspace__web_fetch` to `--tools`/`--allowedTools`. (The asar `HOST_LOOP_EXCLUDED_BUILTIN_TOOLS` = {Bash, NotebookEdit, REPL, JavaScript, WebFetch}; only Bash/NotebookEdit/WebFetch exist in the CLI agent's 26-tool registry — REPL/JavaScript are absent here.)
- `CLAUDE_PLUGIN_ROOT` / `--plugin-dir` point at the STAGED plugin copy — a REAL host path (`join(mntHost, m.mountPath)`), the same directory the sidecar's bind mount below also targets. (2+ configured plugins keep an unresolvable sentinel for both consumers — a pre-existing per-plugin-hook scoping limitation.)
- `cwd` = the harness-owned `<mntHost>/outputs` dir — this MUST equal the PreToolUse gate's `hostCwd` (below); a mismatch is cross-checked live via the hook payload's `input.cwd` and warned loudly, never silently trusted.
- Connected folders are NEVER staged/copied for the native process — they're read directly at their real `Mount.hostPath` (bind-mounted into the sidecar too, so the native tools and `bash` see the same bytes).
- system-prompt append includes the host-loop "Shell access" section (unchanged generator).
- the driver declares `sdkMcpServers:["workspace"]` and handles `mcp_message` (§4, §5) — this is unchanged; the workspace MCP server still routes `bash`/`web_fetch` into the sidecar container regardless of who runs the agent loop.
- a `hooks` bundle (§4a) installs the PreToolUse path-containment gate alongside the always-on Task-bg-block hook.

**The VM sidecar container** (`docker run`, `--name cowork-hl-<id>` so the driver can `docker exec`):
```
docker run --rm -i --platform linux/arm64 --network <net>
  [lockdown flags, same as §3.3]
  -w /sessions/<id>
  -e … (NO agent-env — just CLAUDE_PLUGIN_ROOT=/host/plugins/unmounted, the bash-side self-heal sentinel)
  -v <sessionHost>:/sessions/<id>                                    # outputs/uploads/staged plugins
  [-v <sessionHost>/mnt/<p>:/sessions/<id>/mnt/<p>:ro]…              # mode:r NON-folder mounts only
  -v <folder.hostPath>:/sessions/<id>/mnt/<folderMountPath>[:ro]…    # REAL folder paths — never copies
  -v <configDir>/skills:/sessions/<id>/mnt/.claude/skills:ro
  -v <configDir>/projects:/sessions/<id>/mnt/.claude/projects:ro
  cowork-agent-base:2
  sleep infinity                                                     # NO agent runs here
```
No agent binary is bind-mounted into this container and no `claude …` argv runs in it — it exists solely
as a `docker exec` target. The full `.claude` dir is NOT bound wholesale (that shape is VM-loop only);
this sidecar sees only `.claude/skills` + `.claude/projects`, matching production. `bash`'s exec cwd is
`/sessions/<id>/mnt/<firstConnectedFolder ?? "outputs">` (production's real `vmCwd` semantics — never the
bare session root or bare `mnt/`).

**Caution for a future edit:** `mode:"r"` non-folder mounts get their `:ro` overlay from
`readOnlyMountPaths`; `mode:"r"` FOLDER mounts get their `:ro` from the folder-bind line above instead —
composing both for the same folder produces two `-v` flags at one destination, a Docker "duplicate mount
point" hard failure. `readOnlyMountPaths` MUST exclude `kind:"folder"` mounts.

### 3.4a The PreToolUse path-containment gate (`src/hostloop/pretooluse-path-hook.ts`)

With no container around the native file tools, this gate — a byte-faithful port of production's own
inline PreToolUse hook body — is hostloop's ENTIRE security boundary for real filesystem access.
Installed via the `hooks` seam (§4, a caller-supplied `HookBundle` merged onto the always-on
`COWORK_PRETOOLUSE_HOOKS` in the `initialize` control_request). Denies any `Read`/`Write`/`Edit`/`Glob`/
`Grep`/`MultiEdit` whose resolved path falls outside the session's allowed roots (outputs, uploads,
skills, writable connected folders, the staged plugin copy; read-only folders are readable but not
writable). A `/sessions/...`-shaped path is denied with a distinct "is a VM path, use bash" message. A
run-end runtime tripwire (`execute.ts`'s `findUngatedPathToolCalls` / `chat.ts`'s inline `tripwireHook`)
hard-fails the run/session if a gated tool call ever completes successfully with no evidence the gate
fired for it — version-skew insurance, not doubt about the currently-pinned binary.

A `hostloop` scenario with a WRITABLE connected folder requires the top-level `allow_host_writes: true`
scenario field (or `--allow-host-writes` for `chat`) — `checkHostLoopWriteConsent` refuses to spawn
otherwise. Read-only folders and folder-less/scratch hostloop runs need no opt-in.

### 3.5 L2 microvm (`spawnMicroVm`)
`limactl shell <inst> sh -c 'set -e; cd /sessions/<id> 2>/dev/null || { echo "<not provisioned>" >&2; exit 1; }; while IFS= read -r __cs; do [ "$__cs" = "__COWORK_SECRETS_END__" ] && break; export "$__cs"; done; exec "$@"' _ env <non-secret pairs> claude …(§3.1)`. The work root (`VM_WORK_HOST`) is mounted **directly at `/sessions`** (not `/cowork-work` + a per-run symlink), so `/sessions/<id>` is a real dir — `getcwd()` = `/sessions/<id>` (§9), the encoded-cwd matches the container tier, and `CLAUDE_CONFIG_DIR` is a writable host-mounted path so the agent persists its session (enabling `--resume`). `set -e` + the explicit `cd` guard make a missing mount FAIL LOUD (a stale/un-provisioned VM) instead of silently exec'ing with the wrong cwd. `<inst>` is **hash-derived** (`cowork-vm-<sha8(limaConfig)>`): a config change (mounts/image/provision/agent-version) yields a new name ⇒ a fresh VM, so a stale-config VM is never silently reused (no drift). Egress: host proxy at `192.168.5.2:<port>` + guest default-deny iptables. **Secrets: the auth token rides a stdin PROLOGUE** (one `KEY=value` per line up to the `__COWORK_SECRETS_END__` sentinel; the shell `read`s + `export`s them, then `exec`s `claude` with stdin positioned at the control stream) — off the host argv (`ps`/`limactl`) AND off disk. Non-secret env still rides argv via `env <pairs>`.

### 3.6 L0 protocol (`spawnProtocol`)
Host `claude` (NO `--cowork`, NO cowork env), `cwd = work/`, mounts flattened under `work/`. Control-loop validation only.

## 4. Control protocol (`src/agent/session.ts` — `LiveAgentSession`)

The protocol seam is `LiveAgentSession` (the old monolithic `src/control/controller.ts` was split into
the three seams `AgentSession` (`src/agent/session.ts`) / `Decider` (`src/decide/decider.ts`) / `Run`
(`src/run/run.ts`)). Golden snapshots are built by the shared envelope builders in `src/run/envelope.ts`.

1. Driver → CLI **first**: `{type:"control_request", request_id:"init-1", request:{subtype:"initialize", [appendSubagentSystemPrompt], [sdkMcpServers], hooks:{PreToolUse:[…]}}}`. `hooks.PreToolUse` always includes the Task-`run_in_background`-block entry; a caller-supplied `HookBundle` (opts.hooks — hostloop's path-containment gate, §3.4a) appends its own matcher/callback-id, never replacing the built-in one. A `hook_callback` control_request for an id the driver doesn't recognize as a built-in is dispatched to the bundle's `handle()`; a throw there is treated as `{decision:"block"}` (fail-closed), never silently allowed.
2. Driver → CLI: the user turn (`sendUserTurn`; multi-turn capable).
3. CLI → driver `can_use_tool` / `request_user_dialog` / `elicitation` → `Decider` replies (§5); `request_user_dialog` has a ~6 s auto-cancel.
4. CLI → driver `mcp_message` (host-loop) → driver replies `mcp_response` (§5); both directions recorded (`events.jsonl` + `control-out.jsonl`).
5. CLI → driver `result` → `Run` pulls the next turn, or `close()` ends stdin.

### 4.1 `events.jsonl` schema (what `parseMessage` reads; `trace` digests)

Each line is one stream-json message. The message types that carry signal:
- `{type:"system", subtype:"init", tools:[…], mcp_servers:[…], cwd}` — the registry + cwd.
- `{type:"assistant", parent_tool_use_id?, message:{content:[…]}}` — content blocks are `{type:"text"}`,
  `{type:"thinking"}`, or `{type:"tool_use", id, name, input}`. A non-null `parent_tool_use_id` means
  the block ran **inside a sub-agent**.
- `{type:"control_request", request_id, request:{subtype}}` — `can_use_tool` (→ permission, or question
  when `tool_name==="AskUserQuestion"`), `request_user_dialog`, `elicitation`/`side_question`, `mcp_message`.
- `{type:"result", is_error, usage}` — turn end.

**Sub-agent dispatch recognition (binary fact):** the real cowork dispatch tool is **`Agent`** (agent
ELF 2.1.197 as of baseline desktop-1.18286.0: `{name:"Agent", aliases:["Task"], description:"Launch a new agent",
inputSchema:{description, subagent_type, prompt}}`). `parseMessage` synthesizes a `subagent_dispatch`
for a `tool_use` whose `name` is `Agent` **or** `Task` (the alias) **or** whose `input` carries
`subagent_type`. The cowork **`TaskCreate`/`TaskUpdate`** tools are the *todo list*
(`{subject, description, activeForm}` / `{taskId, status}`) and **`Monitor`** is a command watcher —
none carry `subagent_type`, so they are NOT dispatches. `subagent_declared_but_unused` needs a declared
tools list, which the `Agent` tool does not provide → inert on the cowork path (legacy-`Task` only).

### 4.2 Deciders (the terminal of the chain: scripted → parity → terminal)

The chain `Chain(ScriptedDecider, PermissionDefaultDecider, terminal)` resolves each `decision` event;
the terminal is one of:

- **`FailDecider`/`FirstOptionDecider`/`PromptDecider`** — `--on-unanswered fail|first|prompt`.
- **`LlmDecider`** (CLI `--decider-llm [--intent "…"]`; scenario YAML `on_unanswered: llm`) — per question, the
  answering model (host `claude -p`; defaults to Sonnet, override via `--decider-model` / `COWORK_HARNESS_DECIDER_MODEL`)
  picks a label; out-of-set → `UnansweredError`
  (loud, no `coerceLabel` fallback). Transport is `claude -p` not a direct `/v1/messages` (the harness
  process is not behind the egress proxy); a transient non-zero exit is bounded-retried
  (`COWORK_HARNESS_LLM_RETRIES`, default 2, clamped 0–10; timeout/byte-overflow/spawn-failure are not
  retried) and the exit error carries the child's stdout/stderr so the failure is diagnosable. The run is
  flagged `nonDeterministic`.
- **`ExternalDecider`** over a `DecisionChannel` (`src/decide/external-channel.ts`) — two transports of
  the SAME wire protocol: **spawn** (`--decider-cmd '<cmd>'` → a `shell:true` helper) and **file
  rendezvous** (`--decider-dir <dir>` → `req-N.json`/`resp-N.json`). For each unscripted decision it emits
  `{type:"decision_request", id, runId, kind, …payload, context, reply_with}` (secret-scrubbed before
  write — `0600` files for the dir; the helper's own pipe for spawn) and reads one reply; answers are
  coerced via `coerceLabel(raw, labels, enableFirstShorthand)`. **CB-1:** `ExternalDecider` calls
  `coerceLabel` with `enableFirstShorthand=false` — a helper returning the literal string `"first"` must
  match an actual label named `"first"`; it is NOT silently coerced to option 1. (The `"first"` shorthand
  remains active at its default `true` for internal deciders only.) EOF / invalid JSON / wrong-`id` /
  timeout → `UnansweredError` (exit 2). A question that reaches the terminal unanswered (`ABSTAIN`)
  **throws** — never a silent option-1 (`run.ts`).

Both external channels keep the CLI's stdout FREE (the protocol is on the helper's own pipes / in files),
so both compose with `--output-format json` (no terminal `{type:"result"}` line). The legacy **stdio** channel
(`--on-unanswered external`) — which seized the CLI's own stdout/stdin as a JSONL stream — was **removed**;
`--decider-dir` subsumes it without owning stdout (passing it now fails loud at `resolvePolicy` with a
redirect). `--decider-dir` is flagged `nonDeterministic` (a driving agent answers). The harness owns its
transport: `cowork-harness gates <dir> --follow` streams one JSON line per pending gate + a terminal
`{"done":true}` (a `process.on("exit")` marker guarantees completion on any exit path), and
`cowork-harness answer <dir> --gate <N> --choose <label>` writes the atomic `resp`. For `--decider-cmd`,
the Python package's `serve_decider(fn)` is the symmetric pre-built loop (the helper writes only the
decision function; the adapter owns readline/parse/answer-envelope/flush). The driving agent arms ONE
Monitor on `gates --follow` (binary-verified: a Monitor stdout line wakes the persistent session via a
`task-notification`). The dialog ~6 s auto-cancel is relaxed to ∞ under an external/LLM/prompt terminal
(`COWORK_HARNESS_DIALOG_TIMEOUT_MS` overrides).

### 4.3 File provision & session persistence (local fidelity)

Real Cowork stages files via the Files API + a `stage_file` control message and persists sessions
server-side (`/v1/sessions`), but the agent's *behavior* depends only on (a) the file being present at
the expected path and (b) the session being resumable. The harness models both **locally**:

- **Files** — `session.uploads` / `--upload <file>` → `mnt/uploads/<name>`; `session.folders` /
  `--folder <dir>` → `mnt/<collision-resolved-basename>` (the `register_repo_root` analog; ≥1.14271.0,
  older baselines `.projects/<id>`). Behaviorally faithful: the agent `Read`s the file at the same path
  it would in Desktop.
- **Persistence** — `--session-id <id>` derives a stable cwd (`/sessions/sess-<id>`) + run dir and pins
  the agent's native session UUID (persisted in `<outDir>/session.json`). The agent writes its session to
  `CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<uuid>.jsonl` (= `mnt/.claude/projects/…` on the host). The
  work-dir staging is additive (`mkdir -p` + `cpSync` merge — `plan.configDir` has no `projects/`), so a
  reused run dir **preserves** the sessionFile, any skill-written checkpoint state (e.g. deck-review's
  `gate_state.json` — a *skill* artifact, not a harness one), and `mnt/outputs`. `--resume` reuses
  the dir and passes the agent's native `--resume <uuid>` — the agent reloads `messages` +
  `fileHistorySnapshots` + `deferredToolUse`. We do NOT reimplement resume. Verified end-to-end (a
  codeword established in run 1 is recalled after `--resume` in run 2) and against the host binary.
- **Divergences (don't affect skill behavior):** files don't transit `/v1/files`; no cloud
  `/v1/sessions` event log; no cross-session document store.

## 5. Control-response envelopes (exact shapes — golden-tested)

```
allow:  {type:"control_response", response:{subtype:"success", request_id, response:{behavior:"allow", updatedInput}}}
deny:   {type:"control_response", response:{subtype:"success", request_id, response:{behavior:"deny", message}}}
AskUserQuestion allow.updatedInput.answers = Record<questionText, chosenLabel>
mcp_message reply: {type:"control_response", response:{subtype:"success", request_id, response:{mcp_response:{jsonrpc:"2.0", id, result|error}}}}
```
Payload sits under an **inner** `response`. Missing the nesting ⇒ `ZodError: expected object`.

## 6. MCP (binary fact)

**Three MCP delivery channels (corrected 2026-06-13 — first-party probe):**

> **At a glance:** channel 1 = SDK servers over the control protocol (the workspace shell + the host's own
> MCP servers) — and the home of **`web_fetch`**, which runs via a host-API **two-path model** (Path A:
> provenance-gated, no hostname allowlist; Path B: egress-domain-gated), **decoupled from `bash`/`plan.egressAllow`**.
> Channels 2-3 = CLI `--mcp-config` / `.mcp.json` servers (honored in plain cowork mode; dropped only in
> hermetic mode). Details per channel below.

1. **SDK servers over the control protocol** — declared via `sdkMcpServers` in `initialize`; tool calls tunnel as `mcp_message`. This is how the **desktop host** bridges its own servers (incl. `claude_desktop_config.json` `mcpServers`, spawned host-side with full host env) and how the harness delivers the workspace shell. The workspace handler (`src/hostloop/workspace-handler.ts`) implements `initialize`/`tools/list`/`tools/call`; `bash`→`docker exec -w <mntRoot> <container> sh -c <cmd>` (container-egress-gated). **CB-8:** `makeWorkspaceHandler` accepts an `onInfraError?: (message: string) => void` callback at parameter position 6 (after `onEgress`); on infrastructure errors (ETIMEDOUT / killed / no code+stdout+stderr) the handler calls `onInfraError?.(e.message)`, returns a textResult with `"[infrastructure error: …]"`, and `spawnHostLoop` wires `onInfraError` to append `{type:"infra_error", ts, message}` to `events.jsonl`. **`web_fetch` is NOT container-egress-gated:** real Cowork routes it through the host API (gate `1978029737` `coworkWebFetchViaApi:true` → `POST /api/organizations/<org>/cowork/web_fetch`), gated by a **separate web-fetch hostname allowlist** (`getWebFetchAllowedUrls`, `*`=unrestricted) + a **URL-provenance** rule (URL must have appeared in a prior message/result). The harness mirrors this with the **two-path model** (`src/hostloop/workspace-handler.ts`, binary-verified `G1t`/`U1t`): **Path A** (provenance engaged — `coworkWebFetchViaApi` on) gates on the **exact-URL provenance set** ONLY (seeded from user-turn + tool-result URLs; `src/hostloop/provenance.ts`), with **no** hostname allowlist — but still an `http(s)`-scheme + private-address **SSRF backstop re-checked on every redirect hop** (a manual redirect loop, not `curl -L`) — a miss raises a per-domain approval (`webfetch:<domain>` permission with options `Allow once | Allow all for website | Deny`) routed through the Decider; "Allow all for website" approves the host for the rest of the run (`Run.approvedDomains`, per-run/ephemeral). **Path B** (gate off) is a direct host fetch gated by the egress domain list via the same `wen()`/`compile()` matcher container egress uses, with `redirect:"manual"` re-checking `U1t` (scheme + private-address SSRF + allowlist) on **every** redirect hop. web_fetch is thus **decoupled from `plan.egressAllow`** on Path A (egress applies to `bash`/Path B only). An unanswered cold miss is fail-closed; scenarios answer via `--answer "webfetch:<domain>=allow"` (with `grant`), `web_fetch.approved_domains`, or an LLM/external terminal. `bash` stays container-egress-sandboxed.
2. **CLI-spawned `--mcp-config` / `.mcp.json` servers — HONORED in plain cowork mode** (NOT ignored). **Verified:** a valid `--mcp-config` populates `mcp_servers` (`[{name,status:"pending"|"connected"}]`); these run in-sandbox with the env-allowlist `CLAUDE_CODE_MCP_ALLOWLIST_ENV` (`RW8`/`oG8`/`LU5` = {HOME, LOGNAME, PATH, SHELL, TERM, USER}). The harness MAY use this as a convenience injection path.
3. **The drop is SAFE/HERMETIC-mode-gated, not cowork-gated.** `--mcp-config` is filtered to SDK-only (`ap5()`) **only when** safe mode (`I5()`) or `xB8()` is true, and `xB8()` requires **both** `CLAUDE_CODE_REMOTE` **and** `CLAUDE_CODE_REMOTE_HERMETIC_MODE`. **Verified:** with both set, `mcp_servers:[]`; without them (plain `SESSION_KIND=bg`), the config is honored. The earlier "cowork ignores `--mcp-config`" was a hermetic-session observation over-generalized.

## 7. Golden snapshot targets (contract layer)

For canonical fixtures (a minimal session, a plugin session, a marketplace session, host-loop), snapshot — with volatile paths normalized (`outDir`, `<id>`, `$HOME`) — the:
- `buildLaunchPlan` output (mounts, pluginDirs, env keys, egressAllow),
- docker/limactl **argv** per tier (container, hostloop, microvm),
- the **initialize** request and the **allow/deny/answers/mcp_response** envelopes,
- the loop **decision** for each input combination.

A diff in any of these = an intentional contract change (review the snapshot) or a regression.

## 8. Live contract tests (runtime layer; token+Docker gated)

Assert the **binary** still matches the contract (run on `sync`, skip without token/Docker):
- spawn flags in §3.1 are accepted (no "unknown option").
- `--permission-prompt-tool stdio` + initialize ⇒ AskUserQuestion routes; the answer shape drives the model.
- `sdkMcpServers:["workspace"]` ⇒ `mcp_servers:[{workspace,connected}]` + `mcp__workspace__bash` surfaces.
- a VALID `--mcp-config` (plain cowork) ⇒ the server appears in `mcp_servers` (HONORED); the same config with `CLAUDE_CODE_REMOTE=1`+`CLAUDE_CODE_REMOTE_HERMETIC_MODE=1` ⇒ `mcp_servers:[]` (hermetic drop). Guards the §6 three-channel model. (A *nonexistent* file errors with "Invalid MCP configuration" — do NOT use that to assert inertness.)
- cowork mode ⇒ `cwd:/sessions/<id>`, `TodoWrite` absent from the registry.

## 9. Invariants (never regress)
- cwd = `/sessions/<id>`; config = `mnt/.claude`. Holds for the AGENT PROCESS on `container`/`microvm`
  (incl. microVM, which mounts the work root directly at `/sessions` (§3.5) so `getcwd()` is the real
  `/sessions/<id>`, not a symlink resolving to a `/cowork-work` physical path — a microVM cwd of
  `/cowork-work/<id>` is a regression, breaking session persistence + cross-tier encoded-cwd parity) — and
  for hostloop's `bash`/VM-sidecar view (§3.4). **`hostloop`'s NATIVE agent process is the one deliberate
  exception**: its cwd is the real host `<mntHost>/outputs` path (matching production's own
  `hostCwd = getOutputsDir(e)`), because it runs directly on the host, not inside `/sessions/<id>`. This
  divergence is the fidelity-correct choice, not a bug — do not "fix" it to match this invariant.
- `CLAUDE_CODE_USE_COWORK_PLUGINS` never set; host `CLAUDE_*` never blanket-forwarded.
- `MAX_THINKING_TOKENS` never `0`.
- plugins via `--plugin-dir`; marketplaces resolved to plugin dirs.
- variadic tool flags last.
- host FS sealed (only declared binds); egress default-deny at L1/L2.
- `web_fetch` is host/API-routed (NOT container-egress); `bash` is container-egress-sandboxed (§6).
- secrets never written to disk in a runtime path.

## 10. Production gate constraints (fidelity — pinned from `provenance.gates`)

Behaviors real Cowork enforces via server-side GrowthBook gates (binary-verified, app.asar 1.12603.1;
states in `baseline.provenance.gates`). A skill that ignores these behaves differently in real Cowork.

- **Scheduled-task session limiter** (gate `1648655587`, `{perTask:1, global:3}`). Binary-verified
  2026-07-04 (asar 1.18286.0, `class L9t` "[ScheduledTasks]"): this gate governs Cowork's
  **scheduled/recurring (cron) task** scheduler, NOT the in-conversation `Task` tool. The desktop
  host **SKIPS** launching a scheduled-task *session* that would exceed the cap
  (`recordSkipAndEmit`/`PerTaskLimit`|`GlobalLimit` — not queue, not error): **≤1 concurrent session
  per scheduled task** and **≤3 concurrent scheduled-task sessions globally** (`_pendingTaskDispatches`
  included). It does **not** cap in-conversation `Task`-tool sub-agent fan-out — the Desktop imposes
  no such cap at all (the `Task` PreToolUse hook only blocks `run_in_background`). The harness runs a
  single foreground session with no scheduled-task scheduler, so this gate has **no applicable
  surface** to reproduce; it is pinned only as a sync drift-sentinel. `dispatch_count_max` remains an
  author-chosen budget assertion, not enforcement of this gate.
- **`web_fetch` routing** (gate `1978029737`, `coworkWebFetchViaApi:true`) — see §6; implemented.
- **Env vars that DON'T affect skill behavior** (documented as not-needed, per the fidelity filter):
  `CLAUDE_CODE_DONT_INHERIT_ENV` (moot under host-loop, which disables native Bash), the bg
  auth-handshake vars (`CLAUDE_BG_CLAIM_AUTH` etc., single-use host↔worker),
  `CLAUDE_CODE_ENVIRONMENT_KIND`, `CLAUDE_CODE_WORKER_EPOCH`. Not set.
  (`CLAUDE_CODE_WORKSPACE_HOST_PATHS` moved out of this list in 0.23.0: it IS now emitted —
  hostloop only, when connected folders are present — alongside `CLAUDE_CODE_HOST_PLATFORM`,
  which is set on every cowork-spawn tier; binary-verified, see `docs/fidelity-gaps.md` and the
  0.23.0 CHANGELOG entry.)

## 11. Machine output (`--output-format json`)

### 11.0 Replay fidelity contract

`replay` consumes BOTH recorded protocol directions:

- **`cassette.events`** (child→driver): the full assistant turn stream (text, tool_use, tool_result,
  decision requests, result).
- **`cassette.controlOut`** (driver→child): the serialized decision responses. When present, a
  `ReplayDecider` serves these back into the decision pipeline, populating `rec.questions`,
  `rec.gateAnswers`, and `rec.gateDeliveries` exactly as in a live run.

**Assertion evaluation on replay:**
- **Content assertions** (`contentKeys` in `src/run/cassette.ts`) are evaluated — `transcript_*`,
  `tool_*` (incl. `tool_no_error`), `max_tool_errors`, `max_redundant_tool_calls`, `subagent_*` (incl.
  `subagent_output_contains`), `dispatch_count_max`, `skill_triggered`, `no_skill_triggered`,
  `skill_tool_used`, `skill_available`, `connector_available`, `tool_available`, `all_tasks_completed`,
  `task_status`, `compaction_occurred`, `max_cost_usd`, `max_tokens`, `tool_calls_max`, `max_turns`,
  `result`, the verdict modifiers (`allow_permissive_auto_allow`, `allow_missing_capability`,
  `allow_l0_plugin_divergence`, `allow_stall`), and (when `controlOut` is present) `question_asked`,
  `questions_count_max`, `gate_answers_delivered`, `gate_answer_count_min`, `hook_blocked`,
  `no_hook_blocked`. `max_cost_usd`/`max_tokens` are evaluated against the *frozen recording's*
  usage/cost on replay, not fresh spend; `tool_calls_max`/`max_turns` are meaningfully
  replay-checkable (the re-drive recomputes both deterministically).
- **Filesystem assertions** (`file_exists`, `user_visible_artifact`, `artifact_json`, `computer_links_resolve`,
  `no_unexpected_files`, `input_unmodified`) are evaluated **when the cassette carries an `artifacts` manifest**
  (`record` snapshots `outputs/` + connected folders; `replay` materializes it token-free — `artifact_json` needs the
  small JSON body inlined). `no_unexpected_files` additionally requires `preRunPaths` (optional cassette
  metadata since 0.24; container/hostloop recordings only — microvm cannot capture the baseline); without it
  replay **excludes** the key with a loud warning (live/verify-run without a
  pre-run manifest hard-fails evidence-unavailable). `input_unmodified` (the in-place-mutation detector —
  every pre-existing file matching a glob keeps an unchanged content hash) mirrors this exactly against its
  own baseline, `preRunHashes` (the pre-run per-path sha256 manifest, captured alongside `preRunPaths` but a
  distinct field); without it replay excludes the key with the same loud-warning treatment. On older,
  manifest-less cassettes they are skipped (loud) — absent from `assertions[]`, not present-and-passing.
- **Egress / live-only assertions** (`no_delete_in_outputs`, `self_heal_ran`, `transcript_no_host_path`,
  `no_mcp_error`, `max_peak_rss_bytes`, `egress_*`, `expect_denied`) are always skipped on replay — absent
  from `assertions[]`. The count of skipped (full / partial) assertions is reported in
  `RunResult.skippedAssertions`, so a JSON consumer doesn't read a green replay as having evaluated
  everything.

**Staleness (replay):** a stale cassette (skill/baseline drift) WARNS but stays `ok:true` by default — a
green replay does not imply the recording is still valid. Each finding is surfaced class-tagged in
`RunResult.staleness[]` for a token-free gate to act on. `replay --strict` fails on any class;
`replay --fail-on-skill-drift` fails only on skill-source classes (`skill` / `shared-root` /
`unverifiable-skill`). Both realize the gate as failing `assertions[]` entries (so `ok`/exit stay consistent).
- **`question_asked` / `questions_count_max` / `gate_answers_delivered` / `gate_answer_count_min` /
  `hook_blocked` / `no_hook_blocked`** additionally require `controlOut`. Without it, a loud
  `::warning::` fires and these keys are excluded (not vacuously passed). The hook keys need
  `controlOut` for a different reason than the question keys: a custom hook's block/allow decision is
  an opaque async reply recorded only in `control-out.jsonl`, not in the `events` stream, so it cannot
  be reconstructed without it. The authoritative list is `contentKeys` in `src/run/cassette.ts`;
  `docs/cassette.md` mirrors it — consult it for the full table.
- **`gate_answers_delivered: true` passes vacuously when zero `AskUserQuestion` gates fired** (gate
  firing is model-dependent). Pair it with `gate_answer_count_min: <N>` to also require that at least
  N gates fired AND were delivered non-error — the presence companion, mirroring
  `computer_links_resolve` (zero-passes) paired with `transcript_contains` (presence). Both keys fail
  evidence-unavailable, never vacuous-pass, when gate-delivery telemetry itself is absent from
  `result.json` (an old/partial run on the verify-run lane).
- **`questions_count_max` counts sub-questions, not `AskUserQuestion` tool calls/gates.** A bundled
  gate with K sub-questions counts as K (`src/run/run.ts`'s recorder pushes one `rec.questions` entry
  per sub-question; `src/assert.ts` compares against that count). `trace --view questions` shows the
  same per-gate sub-question count and a matching footer total, so the two surfaces agree — see
  `docs/cassette.md` / `docs/scenario.md`'s `questions_count_max` row.

**Assertion source (replay):** by default `replay` evaluates the `assert:` block **frozen in the cassette**
— byte-deterministic and independent of the working tree. When a sibling scenario resolves and its `assert:`
differs from the frozen copy, a `::notice::` points at the opt-in flag (no verdict change). `--assert-from
<scenario.yaml>` / `--reassert` re-evaluate against the **on-disk** `assert:` (+`expect_denied:`) for a
token-free assertion-iteration loop. That path is safe by construction: it **hard-fails** on recording-shaping
drift (`prompt` / `baseline` / `fidelity` / `answers` / `skills` / `requires_capabilities`) and, when a skill
fingerprint was recorded, on skill-content staleness (it implies `--fail-on-skill-drift`). `expect_denied` and
the filesystem/egress keys are sourced from on-disk but remain live-only (sourced ≠ evaluated; replay warns on
such an edit). The `session` (model / data mounts / discovery) is **not** drift-checked or fingerprinted, so a
model/mount change between record and re-assert is undetected — the notice states this; re-record if the
session changed.

**`replay_protocol_fidelity` (O7 guard):** after the run, `replay` re-serializes each decision
response via `serializeDecision` and compares to the frozen `controlOut` envelope (canonical
key-sorted JSON). A mismatch produces a synthesized `{ assertion: { replay_protocol_fidelity: true },
pass: false, message }` entry in `assertions[]` and exits 1. This catches regressions in
`serializeDecision` — e.g. dropping `questions` from the AskUserQuestion `updatedInput` — on the
token-free lane. `replay_protocol_fidelity` is not a user-authored `contentKeys` entry — it is
synthesized and evaluated automatically on every replay (see the O7 guard above).

`run`, `skill`, and `replay` emit a single JSON object on **stdout** under `--output-format json` (nothing
else hits stdout in that mode — the renderer/footer/`[env]`/`[input]` all go to stderr). The
`run`/`skill`/`replay` shape:

```jsonc
{
  "tool": "cowork-harness",
  "version": "<pkg version>",  // populated from package.json at runtime
  "command": "run" | "skill" | "replay",
  "ok": true,                 // false if any result failed OR an error occurred
  "results": [ RunResult & { verdict } ], // one per scenario; skill/replay = array of 1
  "error": null               // or the error envelope (below) when a run THREW
}
```

Each emitted result carries a **`verdict`** — a non-mutating serialization-time projection of `computeVerdict`,
`{ "pass": bool, "exitCode": 0|1, "signals": [{ "code","severity","message" }], "guards": [{ "name","status" }] }`
— so a consumer can read each result's pass/fail **and why** (the `signals[]`, e.g. an all-green-assertions run
that is `pass:false` purely on a `stalled` signal) without recomputing. `verdict` is on the JSON envelope only,
not on the on-disk `result.json` (which stays the raw `RunResult`). The top-level `ok` is derived from the same
per-result verdicts, so it cannot diverge from them, the exit code, or the text footer.

Other commands use dedicated envelopes — `verify-cassettes` (§11.1), and `decide` / `boundary-check`
each emit their own shape — so this is not a single universal envelope across every command.

`ok = error===null && results.length>0 && results.every(r => r.result==="success" && r.assertions.every(a=>a.pass) && computeVerdict(r).pass)`.
`result:"success"` and passing assertions are necessary but **not sufficient** — `computeVerdict` adds a
verdict-signal layer that can still fail a run (e.g. `stalled` — ended on a question with no productive work after its last gate, `transport_error`,
`missing_capability`, `permissive_auto_allow`, `outputs_delete`, `host_path_leak`, `l0_plugin_divergence`),
each suppressible only by the matching `allow_*` modifier. `result` means "the agent turn didn't error," NOT
"the task completed."

**`run --repeat N`** redefines `ok` for that invocation only — no parallel `batchVerdict` field, per
the project's no-backward-compat stance. The envelope gains an optional
`"rollups": [RepeatRollup]` array (one entry per scenario file; `src/run/repeat.ts`), and:

```
ok = rollups.every(r => rollupPasses(r, minPassRate))
rollupPasses(r) = r.stoppedEarly === "diverged" ? false : r.passRate >= minPassRate   // default minPassRate: 1.0
```

`results[]` still holds **every** raw `RunResult` from every repeat iteration — nothing is hidden from a
`--repeat` caller; only `ok`'s derivation source changes (`rollups`, not `results.every(verdict.pass)`).
`RepeatRollup`: `{ scenario, requested, completed, stoppedEarly?: "budget"|"diverged", passes, passRate,
signalHistogram, perAssertion: [{ index, key, passes, fails, sampleFailure? }], totalCostUsd?, totalTokens?,
nonDeterministicRuns }`. A `--max-budget-usd` early stop is a `::warning::`, not itself a failure — that
batch is still judged on its own completed-runs `passRate`. A `--stop-on-diverge` early stop (both a pass
and a fail observed) always fails that batch, regardless of the numeric rate.

**`RunResult`** (`src/types.ts`):
```jsonc
{
  "scenario": "string",
  "fidelity": "protocol|container|microvm|hostloop|cowork  (replay: \"replay:<f>\")",
  "baseline": "string",                          // platform baseline appVersion
  "result": "success" | "error",                // did the agent turn end without error (NOT "task completed")
  "stalledOnQuestion?": bool,                     // H2/H3: ended on a question with no productive tool work after its last gate → `stalled` verdict fail unless allow_stall
  "decisions": [{ "kind","name","decision","by","model?","rationale?","detail?" }], // model set for by:"llm" gates
  "toolCounts?": { "WebSearch": 8, … },          // truthful per-tool call count (top-level; host-routed WebSearch shows HERE, not usage.server_tool_use)
  "gateDeliveries?":[{ "question","delivered": true|false|null, "error?" }], // did each answered gate's answer reach the model (null = unobserved)
  "egress":    [{ "host","decision":"allow|deny" }],
  "assertions":[{ "assertion": <Assertion>, "pass": bool, "message?": "string" }],
  "subagents": [{ "toolUseId","parentToolUseId?","agentType","declaredTools":[],"toolsUsed":[] }],
  "nonReproducibleAnswers?":[{ "question","chosen","by","rationale?","model?" }], // decisions answered by a non-deterministic/non-authoritative source (llm/external/human/first); scripted answers are excluded
  "usage?": { "turns?": number, /* …SDK usage fields (input_tokens, output_tokens, etc.), pass-through */ },
  "cost?": { "usd?": number, "raw?": {...} }, // usd = SDK's total_cost_usd for this invocation; raw = the api_metrics event payload (independent source)
  "durationMs?": number,
  "fingerprint?": { "baseline", "skillHash?", "skillSources?":[], "skillScope?":[], "sharedHash?", "contentSig?", "fileSigs?":[["relpath","contentSha"]], "fileSigsOmitted?": bool, "mode?": "git|raw", "agentScope?": "skill" }, // skill/plugin staleness fingerprint recorded at run time; lets `verify-run` detect a kept run whose gate snapshot predates a skill change
  "outDir": "string",
  "workDir?": "string",                          // the agent's working root (mnt/) inside the run dir
  "outputsDir?": "string",                       // the user-visible deliverable mount (mnt/outputs)
  "userVisibleRoots?": ["string"],               // user-visible mount roots (relative to mnt/) — `outputs` plus each connected folder's resolved mount name; plugins excluded
  "readonlyFolderRoots?": ["string"],            // subset of userVisibleRoots that are read-only (mode:"r") connected-folder mounts — inputs, not deliverables; `artifacts` excludes them
  "artifacts?": [{ "path","bytes" }],            // files written under the user-visible roots (paths + sizes only — no content snapshot)
  "preRunPaths?": ["string"],                    // workRoot-relative paths under the user-visible roots that existed BEFORE the agent ran — the `no_unexpected_files` baseline; absent when the tier didn't capture it (microvm) or the run predates the seam
  "effectiveFidelity?": "string",                // tier actually used (differs from `fidelity` when "cowork" resolved)
  "nonDeterministic?": bool,                      // true if any decision came from a non-deterministic source → not reproducible
  "gateProvenance?": { "total": number, "bySource": {…}, "gates": [{ "question","answeredBy","answer","model?" }] }, // how each AskUserQuestion gate was answered; informational (never fails the verdict); live/partial lane only (absent on replay)
  "permissiveAutoAllow?": ["string"],             // tools auto-allowed by cowork parity that real Cowork BLOCKS → green is NOT faithful
  "staleness?": [{ "class": "baseline|skill|shared-root|format|unverifiable-baseline|unverifiable-skill|resolved-tier|unverifiable-tier", "message" }], // replay only; cassette-staleness findings, surfaced for a JSON gate. Non-failing by default (a stale but passing replay stays ok:true); `--strict` fails on every class, `--fail-on-skill-drift` on skill/shared-root/unverifiable-skill only. `resolved-tier` = a `fidelity: cowork` cassette's recorded effectiveFidelity no longer matches the tier the scenario's baseline (pinned `baseline:` or `latest`) resolves to today — the recording exercises the wrong tier; `unverifiable-tier` = the tier check couldn't run for a baseline-dependent (`fidelity: cowork`) cassette (no recorded effectiveFidelity, or its pinned baseline failed to load). Tier resolution is baseline-only (the CLAUDE_FORCE_HOST_LOOP env override is suppressed) so verify results can't differ across machines.
  "skippedAssertions?": { "full": number, "partial": number }, // replay only; count of live-only assertions NOT evaluated (full = whole assertion skipped; partial = content half ran, fs/egress half dropped). The skipped ones are absent from `assertions[]`.
  "toolResults?": [{ "toolUseId?","isError","text","assertText?" }], // tool-result text at assertion-fidelity cap (10 KB); backs tool_result_contains/tool_result_not_contains
  "skillsInvoked?": ["string"],                  // Wave 1: skill/plugin ids invoked via the Skill tool_use event, call order, duplicates kept. Backs skill_triggered/no_skill_triggered.
  "skillToolAvailable?": bool                     // Wave 1: whether the agent's init tool list included "Skill" — false ⇒ skill_triggered/no_skill_triggered fail as evidence-unavailable (agent-version drift)
}
```

**VerdictSignal codes** — synthesized entries that appear in `assertions[]` alongside user-authored
assertions (never user-authored themselves):

| code | severity | trigger |
|---|---|---|
| `replay_protocol_fidelity` | error | `serializeDecision` mismatch vs frozen `controlOut` (replay only) |
| `prompt_asset_missing` | warn | `fidelityWarnings` contains `"referenced asset not found"` — run proceeded with a missing prompt asset; result may be degraded (CB-7) |

**Error envelope** — a thrown failure (not an assertion failure) under `--output-format json`:
```jsonc
{ "tool":"cowork-harness","version":"...","command":"...","ok":false,"results":[],
  "error": { "category": "usage|unanswered|boundary|runtime|internal", "message": "string", "hint?": "string" } }
```
Categories come from TYPED errors (`UnansweredError`→`unanswered`, `BoundaryError`→`boundary`).

**Exit codes** (branchable without parsing): `0` all-pass · `1` assertion/agent failure · `2` usage /
unanswered-under-`fail` / runtime · `3` boundary/integrity. (`--output-format json` writes via `writeSync` so the envelope
is never truncated by `process.exit` on a pipe.)

**Reserved:** exit `4` on the `run`/`skill` family is reserved for a future "needs input / surfaced
question" outcome (the deferred `on_unanswered: surface` / `needs_input` Track 2). It is currently
unused — reserving it now keeps a later addition additive rather than a renumbering of the burned
`0`/`1`/`2`/`3` space. Exit-code space is **per-command**, not global (`status` uses `0`/`1`/`2`/`3`
with its own meanings); this reservation applies only to the `run`/`skill` family.

**Per-command exceptions:** `lint` exits `127` when `python3` is missing (spawn error); `replay` exits
`2` on a malformed/unreadable cassette (distinct from the `0`/`1` verdict); `sync` exits `2` on a
non-macOS platform (the platform guard, alongside the `sync` hard-failure → `1` note below).

> The `3` "boundary" category here is the **typed `BoundaryError`** raised during a `run`/`skill` (e.g.
> asserting egress behavior at `protocol` fidelity). It is distinct from the **`boundary-check` command**,
> whose own probe failures follow the assertion convention and exit **`1`** (a failed sandbox probe is a
> failing check, not a usage/typed error). Likewise `sync` hard failures (missing baseline versions, a
> refused empty allowlist) exit `1`.

### 11.1 `verify-cassettes` — dedicated envelope (NOT the RunResult shape)

`verify-cassettes <file|dir>` is the token/agent-free CI gate over committed cassettes (privacy scan +
staleness). It does **not** reuse the `run/skill/replay` envelope (that routes `ok` through live-lane
verdict logic a finding doesn't have) — it emits its own, published as
**`schema/verify-cassettes.json`** (a §12-covered contract surface, pinned by
`test/verify-envelope-schema.test.ts`):

```jsonc
{ "command": "verify-cassettes",
  "ok": true,                       // false if any real finding, staleness drift, version mismatch, or unreadable cassette
  "coverage": { "privacy": true, "staleness": true },  // which scans ran (false under --skip-privacy / --skip-staleness)
  "results": [ { "file": "string",
                 "findings": [ { "where": "string", "cls": "email|currency|domain|path|machine-inventory|unscanned", "sample": "string" } ],
                 "staleness": [ "string" ],   // drift / unresolvable-fingerprint messages (gate failures)
                 "notes": [ "string" ],       // NON-failing informational channel (never affects ok/exit) — e.g. a pre-effectiveFidelity cassette with an explicit tier: statically knowable, nothing baseline-dependent to verify. Text output: a `·`-prefixed row.
                 "version": [ "string" ],     // cassette written by a NEWER harness than this one understands — always a hard fail (can't verify ⇒ not green), independent of --skip-staleness
                 "error?": "string" } ] }     // a malformed cassette is TALLIED here, never crashes the batch
```

The full net (email/currency/domain/path/machine-inventory) runs over the WHOLE cassette (deliverable
bodies/filenames, `prompt`/`answers`/`assert`, and the agent's reasoning + tool I/O), with one
structural exception: the agent **capability-manifest** messages — the `system/init` event and the
`initialize` registry `control_response` (`request_id:"init-1"`) — get `email` + `path` +
`machine-inventory` only (they carry the tool/skill catalog + MCP-server names a regex can't
distinguish from customer data, so `currency`/`domain` are excluded there). `email`, `path`, and
`machine-inventory` still scan them: the registry `account` field can carry the dev's email, those
same messages' own structural fields (`cwd`/`plugins[].path`/`memory_paths`) are exactly where a real
local filesystem path lives, and a live-enumerated app/process inventory sentinel is never legitimate
catalog boilerplate either. `ok = no finding with cls!="unscanned"  &&  no staleness message  &&  no version message  &&  no error`. An `unscanned` finding (a
`>64 KiB`/unreadable artifact body, which is hash-only — nothing committed to leak) is reported but does NOT
fail the gate. **Exit codes:** `0` clean · `1` any finding/staleness/version/error · `2` usage (e.g.
`--skip-privacy`+`--skip-staleness` together, or zero cassettes under a dir — a loud non-zero, never a
vacuous pass). The `in:` assert operator (§ scenario schema) and `record <dir>`/`--rerecord-stale` batch
recording are also part of 0.8.0; see `docs/scenario.md` and `docs/cassette.md`.

**CB-3/CB-4 — `chat` REPL flags and `/help`:** The `chat` subcommand accepts `[--plugin <dir>]…`
(repeatable; CB-3) — each `<dir>` is appended to `localPlugins` and injected alongside the default
skill folder in `plugins.local_plugins`. In `--raw` mode, `--plugin` flags are silently ignored (native
docker mode mounts one skill folder only; a warning is logged). The REPL now accepts `/help` as a
built-in command (CB-4), printing `"Commands: /exit  /quit  /help"` without sending a turn; the startup
prompt reads `"type your message (/help for commands)"`. **CB-2:** `flagValue()` in `src/cli.ts` and
the inline `--model` parser in `src/run/chat.ts` both reject empty-string values (`""`/whitespace) with
a usage error (exit 2); passing `--model ""` or `--model` with no following value is now a hard error
rather than silently propagating an empty model string.

**CB-6 — `scrubField` and artifact redaction (`src/secrets.ts`, `src/run/cassette.ts`):** The exported
`scrubField(value, secrets)` function applies a three-pass scrub to a single field value: (1) direct
`scrub()` — covers literal tokens, `base64(TOKEN)`, `encodeURIComponent(TOKEN)`, etc.; (2) whole-field
base64 decode (≥20 chars, `/^[A-Za-z0-9+/=]+$/`) → if the decoded form contains a secret hit, returns
`"[REDACTED:base64]"`; (3) whole-field URI decode (if `%` present) → returns `"[REDACTED:uri]"` on a
hit. Cassette artifact scrubbing uses `scrubField`: base64-encoded artifact bodies are replaced wholesale
with `"[REDACTED:base64]"` (encoding cleared, sha256 recomputed over the marker bytes; a `::warning::`
is emitted about assertion breakage at replay); utf8 artifact bodies pass through `scrubField` (safe —
text passes unchanged unless the entire value is a base64 blob). A guard in `redactCassette()` skips
`redactJsonLine` on bodies that already start with `"[REDACTED"` to prevent sha256 corruption on
already-redacted markers. The TLD list used by the domain scanner was also extended from 22 to 51
entries (CB-5), adding major European, Asian, and Latin American ccTLDs
(`ch|nl|se|no|it|jp|br|nz|in|sg|kr|mx|es|pt|pl|be|at|dk|fi|ie|ru|cn|tw|hu|cz|ro|il|za|ar|cl|pe|tr`).

## 12. Versioning & the 1.0 compatibility contract

From `1.0.0` the project follows [semver](https://semver.org/). The surfaces below are the **covered
contract**: a backwards-incompatible change to any of them is a MAJOR bump. Everything else — most
importantly human-readable text — is explicitly NOT covered and may change in any release. (Pre-1.0,
nothing here is guaranteed; minor versions may break any surface — see [RELEASING.md](./RELEASING.md).)

**Covered (semver-guaranteed):**

- **CLI surface** — command names, their accepted flags, and the **per-command** exit codes (§11).
  Exit codes are per-command, not global: `run`/`skill` use `0` pass / `1` assertion-or-agent fail /
  `2` usage / `3` boundary-integrity, with `4` reserved (§11). Removing a command or flag, or changing
  an exit-code meaning, is breaking.
- **Scenario & session schemas** — `schema/scenario.schema.json`, `schema/session.schema.json` (the
  authored-input contract). Tightening validation on a previously-valid document is breaking.
- **Baseline JSON shape** — the `baselines/desktop-*.json` field structure (CI's committed source of
  truth; consumers commit and diff these).
- **RunResult envelope** — `schema/run-result.json` under `--output-format json` (§11): the
  `ok` / `results[]` / `error` shape and the verdict-signal codes (§11.0).
- **`verify-cassettes` envelope** — `schema/verify-cassettes.json` under `--output-format json`
  (§11.1): the `command` / `ok` / `coverage` / `results[]` shape with the per-file
  `findings` / `staleness` / `notes` / `version` / `error` channels. This is the machine output the
  CI recipes and the packaged Action steer consumers to parse; renaming or removing a key is
  breaking, adding one is not.
- **Cassette format** — the current `cassetteVersion` (**8**, `schema/cassette.v8.json`) and its
  verdict-modifier assertion keys. Older-version cassettes (the retained
  `schema/cassette.v2/v3/v5/v6/v7.json` — no v4 schema was ever published) stay replayable; dropping a
  still-emitted version's readability is breaking.
- **Control protocol** — `schema/protocol.v1.json` + the golden control-response vectors (§5).
- **Environment variables** — the documented `COWORK_HARNESS_*` knobs plus `COWORK_AGENT_BINARY` and
  `COWORK_AGENT_IMAGE`. Renaming a documented var or changing its meaning is breaking.
- **Packaged GitHub Action** — `action.yml` inputs (`command`, `path`, `version`, `strict`,
  `fail-on-skill-drift`, `extra-args`, `summary`, `anthropic-api-key`) and outputs (`ok`,
  `envelope-path`, `summary-md`).

**NOT covered (may change in any release — do NOT depend on):**

- **Human-readable renderer output** — verdict footers, `::notice::` / `::warning::` lines, transcript
  formatting, and the exact text of log/error messages. **Grep-stability of human-readable text is
  explicitly NOT a contract** — assert against the JSON envelope, not stdout text.
- **`trace` row shapes** and other debug/diagnostic output.
- **`docs/internal/**`** — untracked working notes.
- **The reconstructed system-prompt append text** — a paraphrase by design (see
  [docs/fidelity-gaps.md](./docs/fidelity-gaps.md)); behaviorally equivalent, not byte-stable.
