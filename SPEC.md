# Authoritative spec — cowork-harness

The single source of truth for **what the harness must produce** given its inputs. Golden snapshot tests assert the **contract layer** against this; live contract tests assert the **runtime layer** against the real binary. Anything that contradicts the binary wins over this doc — keep them in sync via `cowork-harness sync` + the [spawn contract](./docs/cowork-spawn-contract-1.12603.1.md) (historical, pinned to 1.12603.1 and not updated per release — live values are in `baseline.spawn` / `baselines/desktop-*.json`).

> **Reading this for how-to?** This is the *contract* (envelopes, exit codes, assertion semantics). To
> author a scenario or run the harness, start at the [README](./README.md) and [docs/](./docs/README.md);
> come here when a doc and the code disagree.

**Contents**

- [0. Model](#0-model)
- [1. Loop decision](#1-loop-decision-srcloop-decisionts--exact-replica-of-cowork-f_)
- [2. Launch plan](#2-launch-plan-buildlaunchplan--pure)
- [3. Spawn argv + env](#3-spawn-argv--env-contract-layer--what-each-tier-must-emit)
- [4. Control protocol](#4-control-protocol-srcagentsessionts--liveagentsession)
- [5. Control-response envelopes](#5-control-response-envelopes-exact-shapes--golden-tested)
- [6. MCP](#6-mcp-binary-fact)
- [7. Golden snapshot targets](#7-golden-snapshot-targets-contract-layer)
- [8. Live contract tests](#8-live-contract-tests-runtime-layer-tokendocker-gated)
- [9. Invariants](#9-invariants-never-regress)
- [10. Production gate constraints](#10-production-gate-constraints-fidelity--pinned-from-provenancegates)
- [11. Machine output (`--output-format json`)](#11-machine-output---output-format-json)
- [12. Versioning & the 1.0 compatibility contract](#12-versioning--the-10-compatibility-contract)

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

`execution` (scenario field, `src/types.ts`) is a separate axis, orthogonal to `fidelity` (a
privilege/sandbox tier): `local` (default — run the agent locally) | `cloud-describe` (RESERVED — no
runner exists yet; authoring it is a load-time error, not a silent no-op).

## 2. Launch plan (`buildLaunchPlan`) — pure

Given a session + baseline, returns:

| field | value |
|---|---|
| `configDir` | managed host dir (or `session.plugins.config_dir`); contains `settings.json`, `cowork_settings.json`, `skills/` |
| `mounts[]` | `{hostPath, mountPath, mode}`, `mountPath` **relative to mnt**: `uploads/<f>`, `<collision-resolved-basename>` (work folders), `.local-plugins/marketplaces/<marketplace>/<plugin>` (marketplace-resolved), `.local-plugins/cache/<name>` (direct `local_plugins`), `.remote-plugins/plugin_<id>` (uploaded / org-remote; `id` is a stable hash of the DECLARED source, not a basename — two entries sharing a basename would collide). (≥1.14271.0; older baselines mount work folders at `.projects/<id>`, which is now a reserved name.) |
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
  --effort <session.effort ?? baseline.spawn.effortDefault>   # always emitted; medium fallback; per-model validated
  (--max-thinking-tokens 31999 | --thinking disabled)   # session.extended_thinking on|off (default on)
                                                #   debug.max_thinking_tokens → --max-thinking-tokens <N> (fenced, non-Cowork)
  [--append-system-prompt <rendered cowork sections>]
  [--model <resolved model>]                   # --model flag / matrix axis > session.model > COWORK_HARNESS_MODEL
                                                #   (empty = unset); a run where none pins one is refused (§11)
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
# NO MAX_THINKING_TOKENS — real Cowork delivers the thinking budget via the CLI flag only (see §3.1), never an env var
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
directly on the host (no container around its file tools), while `bash` routes into a Docker container that
never runs an agent at all. `web_fetch` does **not**: it is host-routed (§6, and the `web_fetch` note in the
SDK-servers section below), so it never crosses the container egress boundary.

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
- the driver declares `sdkMcpServers:["workspace"]` and handles `mcp_message` (§4, §5) — this is unchanged; the workspace MCP server still routes `bash` into the sidecar container regardless of who runs the agent loop (`web_fetch` is host-routed on both paths — see the `web_fetch` note below).
- a `hooks` bundle (§4a) installs the PreToolUse path-containment gate alongside the always-on Task-bg-block hook.

**The VM sidecar container** (`docker run`, `--name cowork-hl-<id>` so the driver can `docker exec`):
```
docker run --rm -i --platform linux/arm64 --network <net>
  [lockdown flags, same as §3.3]
  -w /sessions/<id>
  -e HTTP_PROXY/HTTPS_PROXY/http_proxy/https_proxy/NO_PROXY/no_proxy  (the run's egress proxy — `docker
     exec` inherits container env, so this is bash's egress config at this tier; empty when there is no
     proxy. NO agent-env, and specifically NO CLAUDE_PLUGIN_ROOT: real host-loop leaves it unset in the
     guest and the agent self-heals by `find`ing the mount)
  -v <sessionHost>:/sessions/<id>                                    # outputs/uploads/staged plugins
  [-v <sessionHost>/mnt/<p>:/sessions/<id>/mnt/<p>:ro]…              # mode:r NON-folder mounts only
  -v <folder.hostPath>:/sessions/<id>/mnt/<folderMountPath>[:ro]…    # REAL folder paths — never copies
  -v <configDir>/skills:/sessions/<id>/mnt/.claude/skills:ro
  -v <configDir>/projects:/sessions/<id>/mnt/.claude/projects:ro
  cowork-agent-base:2
  -v <staged ELF>:/usr/local/bin/claude:ro   (parity/inspection; nothing spawned runs it)
  sleep infinity                                                     # NO agent ARGV runs here
```
No `claude …` argv runs in this container — it exists solely as a `docker exec` target. The agent ELF
**is** bind-mounted (`-v <staged ELF>:/usr/local/bin/claude:ro`), for parity and inspection only: nothing
the harness spawns executes it here, since the agent is the native host process. Read "no agent runs" as
a statement about the argv, not about the bind. The full `.claude` dir is NOT bound wholesale (that shape is VM-loop only);
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
spooled projects, skills, writable connected folders, the staged plugin copy). Three of those roots are
READ-ONLY categories, not a blanket allow: a mutating call into `uploads` (hardlink write-block —
per-session-type text), the spooled-projects dir, or the staged skills/plugin copies (no exemption for
plugin content anymore) is denied with that category's own message while remaining readable. A
`/sessions/...`-shaped path is denied with a distinct "is a VM path, use bash" message. A run-end runtime
tripwire (`execute.ts`'s `findUngatedPathToolCalls` / `chat.ts`'s inline `tripwireHook`) hard-fails the
run/session if a gated tool call ever completes successfully with no evidence the gate fired for it —
version-skew insurance, not doubt about the currently-pinned binary.

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
(`COWORK_HARNESS_DIALOG_TIMEOUT_MS=inf`/`-1` overrides; a FINITE value under an external/LLM/prompt answerer is refused as a usage error, since those answerers are authoritative).

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
AskUserQuestion allow.updatedInput = { questions: DecisionRequest["questions"], answers: Record<questionText, chosenLabel> } — BOTH keys required; dropping `questions` breaks the binary's built-in `questions.map(...)` handler (see §O7 below).
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

1. **SDK servers over the control protocol** — declared via `sdkMcpServers` in `initialize`; tool calls tunnel as `mcp_message`. This is how the **desktop host** bridges its own servers (incl. `claude_desktop_config.json` `mcpServers`, spawned host-side with full host env) and how the harness delivers the workspace shell. The workspace handler (`src/hostloop/workspace-handler.ts`) implements `initialize`/`tools/list`/`tools/call`; `bash`→`docker exec -w <mntRoot> <container> sh -c <cmd>` (container-egress-gated). **CB-8:** `makeWorkspaceHandler` accepts an `onInfraError?: (message: string) => void` callback at parameter position 6 (after `onEgress`); on infrastructure errors (ETIMEDOUT / an unrequested kill / a daemon-level failure / no code+stdout+stderr) the handler calls `onInfraError?.(e.message)`, returns a textResult with `"[infrastructure error: …]"`, and `spawnHostLoop` wires it to append `{type:"infra_error", ts, source, message}` to `events.jsonl` **and** to a live sink folded into `RunResult.infraErrors` (the file row alone is invisible to a live drive, which only parses the agent's own stdout). `source` distinguishes `hostloop-exec` (this per-exec path, WARN) from `hostloop-sidecar` (the sidecar process dying, FAIL); it is carried through the frozen cassette so replay reaches the same verdict, and a row without it defaults to the fail class. A **model-requested `timeout_ms` expiry is deliberately NOT infra** — Node reports it as killed with a NULL code, and the handler returns the command's own output with `Command timed out after <duration>` merged into stderr, matching production (binary-verified, agent `2.1.215`). **`web_fetch` is NOT container-egress-gated:** real Cowork routes it through the host API (gate `1978029737` `coworkWebFetchViaApi:true` → `POST /api/organizations/<org>/cowork/web_fetch`), gated by a **separate web-fetch hostname allowlist** (`getWebFetchAllowedUrls`, `*`=unrestricted) + a **URL-provenance** rule (URL must have appeared in a prior message/result). The harness mirrors this with the **two-path model** (`src/hostloop/workspace-handler.ts`, binary-verified `G1t`/`U1t`): **Path A** (provenance engaged — `coworkWebFetchViaApi` on) gates on the **exact-URL provenance set** ONLY (seeded from user-turn + tool-result URLs; `src/hostloop/provenance.ts`), with **no** hostname allowlist — but still an `http(s)`-scheme + private-address **SSRF backstop re-checked on every redirect hop** (a manual redirect loop, not `curl -L`) — a miss raises a per-domain approval (`webfetch:<domain>` permission with options `Allow once | Allow all for website | Deny`) routed through the Decider; "Allow all for website" approves the host for the rest of the run (`Run.approvedDomains`, per-run/ephemeral). On Path A, **AFTER** the provenance/approval gate, **`coworkWebFetchDedup`** (gate `1978029737`, on for baselines ≥ `1.22209.3`) applies a per-session **negative-work cache** (`src/hostloop/webfetch-dedup.ts`, binary-verified): a repeat `web_fetch` of the same **normalized** URL (`normalizeUrl`) within the TTL (baseline-sourced, default `900000` ms; cap `100`, FIFO eviction; a hit does NOT refresh recency) returns a marker telling the model to re-use the earlier result, with **no network request and no egress event** — matching production's zero-network dedup. Only successful (HTTP-2xx, trimmed-nonempty) fetches are cached, keyed under both the request URL and the terminal `destination_url`; errors/empty/non-2xx are never cached. Dedup is baseline-gated (an older baseline lacking the flag never dedups) and Path-A-only. **Path B** (gate off) is a direct host fetch gated by the egress domain list via the same `wen()`/`compile()` matcher container egress uses, with `redirect:"manual"` re-checking `U1t` (scheme + private-address SSRF + allowlist) on **every** redirect hop. web_fetch is thus **decoupled from `plan.egressAllow`** on Path A (egress applies to `bash`/Path B only). An unanswered cold miss is fail-closed; scenarios answer via `--answer "webfetch:<domain>=allow"` (with `grant`), `web_fetch.approved_domains`, or an LLM/external terminal. `bash` stays container-egress-sandboxed.
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
- extended thinking is delivered via the `--max-thinking-tokens` / `--thinking` flags, never a `MAX_THINKING_TOKENS` env var (stripped from hostloop's inherited env).
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
  included). It does **not** govern in-conversation `Task`-tool sub-agent fan-out — that is capped
  **separately, agent-side** (`taskRegistry`, binary-verified in agent 2.1.217): a **concurrent** cap
  (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, default **20**; error `subagent_concurrency_cap` "Do not
  retry"; bypassed under gate `tengu_amber_kestrel` or ultracode x-high effort; landed 2.1.217) and a
  **per-session** cap (`CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION`, default **200**; error
  `subagent_count_cap`; present since ≤2.1.215), with nesting **off by default** (depth 1, gate
  `tengu_hazel_trellis`, error `subagent_depth_cap`). Desktop sets none of these env vars, so the agent
  uses the defaults — and the harness **inherits** them by spawning the same agent binary (it sets
  neither var), so this is faithful, not reproduced in harness code. The `Task` PreToolUse hook
  additionally blocks `run_in_background`. The harness runs a
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

Every envelope, like the CLI's own output, is secret-scrubbed with the same set as the run's files (CB-6: the known auth tokens, `COWORK_HARNESS_SCRUB_KEYS`, `COWORK_HARNESS_SCRUB_VALUES` and their encoded forms), so a value `result.json` shows as `[REDACTED]` reads `[REDACTED]` in the envelope too. The scrub replaces matching TEXT, so the envelope stays parseable for secrets of realistic length; a very short or common value, or one equal to a JSON token (`e`, `1`, `true`), is redacted wherever that text appears, JSON syntax included, and can make the envelope unparseable. What is not scrubbed (child processes that write to the terminal directly, and the other exceptions) is listed in [docs/cli.md](./docs/cli.md#secret-scrubbing-and-cassette-redaction).

### 11.0 Replay fidelity contract

`replay` consumes BOTH recorded protocol directions:

- **`cassette.events`** (child→driver): the full assistant turn stream (text, tool_use, tool_result,
  decision requests, result).
- **`cassette.controlOut`** (driver→child): the serialized decision responses. When present, a
  `ReplayDecider` serves these back into the decision pipeline, populating `rec.questions`,
  `rec.gateAnswers`, and `rec.gateDeliveries` exactly as in a live run.

**Assertion evaluation on replay:**
- **Content assertions** (`ALWAYS_CONTENT_KEYS`/`QUESTION_GATE_KEYS` in `src/run/cassette.ts`) are evaluated — `transcript_*`,
  `tool_*` (incl. `tool_no_error`), `max_tool_errors`, `max_redundant_tool_calls`, `subagent_*` (incl.
  `subagent_output_contains`), `dispatch_count_max`, `skill_triggered`, `no_skill_triggered`,
  `skill_tool_used`, `skill_available`, `connector_available`, `tool_available`, `all_tasks_completed`,
  `task_status`, `compaction_occurred`, `max_cost_usd`, `max_tokens`, `tool_calls_max`, `max_turns`,
  `result`, the verdict modifiers (`allow_permissive_auto_allow`, `allow_missing_capability`,
  `allow_l0_host_config_contamination`, `allow_stall`, `allow_undelivered_deliverables`, `allow_outputs_delete`,
  `allow_delete_in`),
  and (when `controlOut` is present) `question_asked`,
  `questions_count_max`, `gate_answers_delivered`, `gate_answer_count_min`, `hook_blocked`,
  `no_hook_blocked` (illustrative — see `ALWAYS_CONTENT_KEYS`/`QUESTION_GATE_KEYS` in `src/run/cassette.ts` for the authoritative
  set; this list is not re-verified exhaustive on every addition). `max_cost_usd`/`max_tokens` are evaluated against the *frozen recording's*
  usage/cost on replay, not fresh spend; `tool_calls_max`/`max_turns` are meaningfully
  replay-checkable (the re-drive recomputes both deterministically).
- **Filesystem assertions** (`file_exists`, `user_visible_artifact`, `artifact_json`, `computer_links_resolve`,
  `computer_links_resolve_if_present`, `no_unexpected_files`, `input_unmodified`) are evaluated **when the cassette carries an `artifacts` manifest**
  (`record` snapshots `outputs/` + connected folders; `replay` materializes it token-free — `artifact_json` needs the
  small JSON body inlined). `no_unexpected_files` additionally requires `preRunPaths` (optional cassette
  metadata since 0.24; captured on every live sandbox recording tier including microvm — its outputs are snapshotted from the VM into the run dir); without it
  replay **excludes** the key with a loud warning (live/verify-run without a
  pre-run manifest hard-fails evidence-unavailable). `input_unmodified` (the in-place-mutation detector —
  every pre-existing file matching a glob keeps an unchanged content hash) mirrors this exactly against its
  own baseline, `preRunHashes` (the pre-run per-path sha256 manifest, captured alongside `preRunPaths` but a
  distinct field); without it replay excludes the key with the same loud-warning treatment. On older,
  manifest-less cassettes they are skipped (loud) — absent from `assertions[]`, not present-and-passing.
- **Egress / live-only assertions** (`file_absent`, `no_delete_in_outputs`, `no_delete_in_mounts`, `self_heal_ran`, `transcript_no_host_path`,
  `no_mcp_error`, `max_peak_rss_bytes`, `semantic_matches`, `semantic_pairwise`, `no_lost_write_back`, `egress_*`, `expect_denied`) are always skipped on replay — absent
  from `assertions[]`. The count of skipped (full / partial) assertions is reported in
  `RunResult.skippedAssertions`, so a JSON consumer doesn't read a green replay as having evaluated
  everything.

**Staleness (replay):** a cassette whose skill sources have DRIFTED (`skill` / `shared-root`, and the
baseline classes) WARNS but stays `ok:true` by default — a green replay does not imply the recording is
still valid. **`unverifiable-skill` is the exception and FAILS by default (since 2.0.0):** "the check could
not run at all" is a different claim from "the check ran and nothing changed", and only the second is a
green. Each finding is surfaced class-tagged in `RunResult.staleness[]` for a token-free gate to act on.
`replay --strict` fails on any class; `replay --fail-on-skill-drift` additionally fails the skill-source
drift classes (`skill` / `shared-root`). All realize the gate as failing `assertions[]` entries (so
`ok`/exit stay consistent). A cassette carrying no `fingerprint.skillHash` is unaffected — there was
nothing to verify — and keeps replaying green.
- **`question_asked` / `questions_count_max` / `gate_answers_delivered` / `gate_answer_count_min` /
  `hook_blocked` / `no_hook_blocked`** additionally require `controlOut`. Without it, a loud
  `::warning::` fires and these keys are excluded (not vacuously passed). The hook keys need
  `controlOut` for a different reason than the question keys: a custom hook's block/allow decision is
  an opaque async reply recorded only in `control-out.jsonl`, not in the `events` stream, so it cannot
  be reconstructed without it. The authoritative list is `QUESTION_GATE_KEYS` in `src/run/cassette.ts`;
  `docs/cassette.md` mirrors it — consult it for the full table.
- **`gate_answers_delivered: true` passes vacuously when zero `AskUserQuestion` gates fired** (gate
  firing is model-dependent). Pair it with `gate_answer_count_min: <N>` to also require that at least
  N gates fired AND were delivered non-error — the presence companion, mirroring
  `computer_links_resolve` (zero-passes) paired with `transcript_contains` (presence). Both keys fail
  evidence-unavailable, never vacuous-pass, when gate-delivery telemetry itself is absent from
  `result.json` (an old/partial run on the verify-run lane). A floor of `gate_answer_count_min: 0` is
  **not** that companion — `delivered >= 0` always holds. In a scenario that expects no gates, the
  correct form is `questions_count_max: 0` alone, without `gate_answers_delivered`.
- **`questions_count_max: 0` and a gate-presence assertion are mutually exclusive**, and `run` / `skill`
  / `record` **refuse** such a scenario before spawning (exit 2 on `run`/`skill`, 1 on `record` — the
  same convention as the `on_unanswered: prompt` refusal). A delivered gate records at least one
  question, so `questions_count_max: 0` cannot hold alongside `gate_answer_count_min: >= 1`,
  `question_asked`, or `gate_answers_delivered: false`. This is a **command-level** refusal, not a
  schema tightening: `schema/scenario.schema.json` still accepts the document, so §12's covered
  input contract is unchanged. `lint` reports the same pairing as `assert-contradiction` (ERROR).
- **The same refusal covers every presence/absence pair on one evidence channel.** Besides the gate
  pair above: `hook_blocked` + `no_hook_blocked` (one hook-event list) and `path_denied` /
  `vm_path_denied` + `no_path_denied` (one path-denial list). In each case one assertion requires a
  record to exist and its sibling requires none to, so no run satisfies both. Where the evidence is
  absent both halves fail evidence-unavailable rather than passing, and the denial keys are
  hostloop-only so a wrong tier fails both too — no combination produces a both-pass.
- **A `tool_not_called` / `subagent_tool_absent` naming a tool the tier does not serve is REFUSED**, by
  `run` / `skill` / `record`, before spawning and before the run directory is created (exit 2 on
  `run`/`skill`; `run <dir/>` without `--repeat` checks every scenario before the first one runs). The
  `record --dry-run` previews REPORT it under `inputErrors[]` rather than refusing it (exit code and `ok`
  unchanged, §11). `hostloop` replaces `Bash` and
  `WebFetch` with `mcp__workspace__*` and removes `NotebookEdit`; `container` and `microvm` serve no
  workspace shell. A negative assertion naming one of those can never be violated, so it passes vacuously
  and verifies nothing. Like the contradiction refusals above this is a **command-level** refusal, not a
  schema tightening — `schema/scenario.schema.json` still accepts the document, so §12's covered input
  contract is unchanged. Literals only (a glob may match something the tier does serve), and the table is
  closed to tools the harness itself removes or registers: `--tools` gates the built-in set alone while
  every tier separately passes `--mcp-config`, so a session-MCP tool name is never refused. `protocol` is
  never judged — it passes no tool flags, so its surface is the operator's own host CLI registry. `lint`
  reports the same pairing as `tool-not-called-tier-vacuous` (WARN).

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
such an edit). The `session` is **not drift-checked on the replay path**, so a session change between record and
re-assert does not move the replay verdict — the notice states this; re-record if the session changed.
It *is* fingerprinted, but only `verify-cassettes` checks that hash (§11.1): `sessionFingerprint`
covers the session's connected `folders`/`plugins`/`skills`/`mcp`/`egress`/`web_fetch` and the `model:` the
session file pins, plus `projects` and `agent_env` when set. A model supplied by `--model` or
`COWORK_HARNESS_MODEL` is not in that hash; the cassette's `environment.model` records the model that ran.

**`replay_protocol_fidelity` (O7 guard):** after the run, `replay` re-serializes each decision
response via `serializeDecision` and compares to the frozen `controlOut` envelope (canonical
key-sorted JSON). A mismatch produces a synthesized `{ assertion: { replay_protocol_fidelity: true },
pass: false, message }` entry in `assertions[]` and exits 1. This catches regressions in
`serializeDecision` — e.g. dropping `questions` from the AskUserQuestion `updatedInput` — on the
token-free lane. `replay_protocol_fidelity` is not a user-authored content-key entry
(`ALWAYS_CONTENT_KEYS`/`QUESTION_GATE_KEYS`/`MANIFEST_KEYS` in `src/run/cassette.ts`) — it is
synthesized and evaluated automatically on every replay (see the O7 guard above).

`run`, `skill`, and `replay` emit a single JSON object on **stdout** under `--output-format json` (nothing
else hits stdout in that mode — the renderer/footer/`[env]`/`[input]` all go to stderr). The
`run`/`skill`/`replay` shape:

**Which commands, and what stdout carries.** `COWORK_HARNESS_OUTPUT_FORMAT` is the default for the flag on
**every** command that takes `--output-format`, on its success path and its error path alike; an explicit
`--output-format text|json` overrides it. (Before 4.0.0 several commands — `doctor`, `status`,
`verify-run`, `vm`, `analyze-skill`, `replay`, `verify-cassettes`, `critique` — honoured the variable only
on their error path.) Under json, stdout carries exactly one document — in the shared `{tool, version,
command, ok, …, error}` frame, or in a command's Dedicated shape (below) — or nothing: help (`--help`)
always goes to **stderr** with stdout empty, and a command's payload — `scaffold`'s scenario YAML, `skill
--dry-run`'s preview — rides inside the envelope. (`gates` is the one stream: NDJSON, one line per
gate.) An error on any command is the shared error envelope.

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
`{ "pass": bool, "exitCode": 0|1, "signals": [{ "code","severity","message" }], "guards": [{ "name","status" }], "failures": [{ "assertion?","message","kind" }] }`
— so a consumer can read each result's pass/fail **and why** (the `signals[]`, e.g. an all-green-assertions run
that is `pass:false` purely on a `stalled` signal, or `failures[]` for a flat jq-friendly reason list) without
recomputing. As of 0.31.0, the same `verdict` is **also persisted on the on-disk `result.json`** for a kept run
(`jq '.verdict' turns/<N>/result.json` — there is no root compat copy; a multi-turn run dir's turns each hold
their own) — computed once by `computeVerdict` so the streamed
and on-disk copies can't
diverge; `chat` runs carry no `verdict` (field absent, not persisted). The top-level `ok` is derived from the
same per-result verdicts, so it cannot diverge from them, the exit code, or the text footer.

Other commands intentionally do NOT share this exact shape. By mechanism (`src/run/envelope.ts`),
there are three families:

- **`results[]`-bearing (internally `jsonEnvelope`)** — the stable `{tool, version, command, ok,
  results[], error}` shape described above. Emitted by **`run`, `skill`, `record` (a single file;
  its `ok` follows its own rule, below), `replay`, `verify-run`**. (`chat` writes the same `RunResult`-shaped `result.json` to disk, but has no
  `--output-format json`/`isJsonOutput` support at all — it never emits a stdout envelope of any
  shape.)
  - **`verify-run` is a hybrid, deliberately.** It emits `results[]` (always exactly one entry — it
    judges one run dir, the same shape `run` emits for a single scenario) **and** keeps its
    historical flat `pass` / `assertions[]` / `signals[]` / `answerCoverage` keys beside it, so the
    same verdict is readable two ways. It was payload-shaped through 1.24.0; the divergence meant a
    `.results[]? | .verdict.failures[]? | select(.kind=="assertion")` query copied from `run`
    returned `[]` — indistinguishable from "no failures" — against a run that FAILED. Parity is what
    makes a `kind` query written for one command transfer to the other.
- **Payload-shaped (internally `jsonPayloadEnvelope`)** — shares the `{tool, version, command, ok,
  error}` frame but swaps `results[]` for a command-specific payload. The `ok` is the caller's own
  success criterion, not a per-`RunResult` verdict (the helper itself never calls `computeVerdict`,
  though a caller may compute `ok` however it likes — e.g. `probe-dispatch` sets it from its
  projection's `verdict.pass`). Callers include **`assertions`, `probe-dispatch`,
  `diff`, `trace`, `analyze-skill`, `lint`/`lint-skill`**, plus `record --dry-run`'s discovery
  payload, the `record <dir/>` / `record --rerecord-stale` batch payload (below), `scaffold <run>`
  (`scenario`: the YAML, `out`: the file written or `null`), `skill --dry-run` (`dryRun: true` plus the
  preview's fields), `critique --corpus-only`'s corpus payload, `eval` and `eval report` (`evalDir`, `arms`, `pins`,
  `sections`, `summary`, `cost`, `stoppedEarly`), `eval --dry-run` (`dryRun: true`, `plan` — no `evalDir`, none
  is created; §12 covers `plan.cost`'s summary keys and nothing else of `plan`), `hillclimb run` (`flow`, `variant`, `scheduled`, `scored` — the
  rows written to `results.jsonl` this pass, named so it never shadows the envelope's `ok` — `failed`, `exitCode`, and on `--dry-run`
  `dryRun: true` with the estimate at `plan.cost`, where `eval --dry-run` puts it), `hillclimb check` (`reading`, `disclaimer`, `profile`, `findings`, `errors`, `notes`, `warnings`),
  `hillclimb state-template` (`state`, `metrics_md`, and with `--flow` `metrics_md_file`), `verify-cassettes` (§11.1), `doctor` (§11.2), `rehash`,
  `answer` (`gate`, `answers`), `fixture export` (exit `0` written, `2` usage or refusal; payload experimental,
  §12: `message`, `written`, `skipped`, `refused` (`[]`), `notes`, `bytes`, `outputsDir`, `partial`, `result`; a
  refusal is the error envelope, its message in `error.message`, carrying `refused[]` and whichever of the other
  fields were known when it refused — `written`/`skipped`/`notes`/`bytes` only once the outputs tree was read),
  `ref freeze` (`caseId`, `frozen`, `added`; experimental, §12), `ref verify` (`stores[]`, each
  `{store, entries, problems, notes}`; experimental, §12), and `regrade` (below).
- **Dedicated (hand-shaped, no shared helper)** — its own bespoke shape: **`list`** (a raw JSON
  array, no wrapper object, oldest → newest; the entry `latest` resolves to carries `latest: true`), **`boundary-check`**, **`init-redact`**, **`decide`**,
  **`gates`** (an NDJSON stream, not a single object — one line per pending gate; a terminal
  `{"done":true}` only once the run has written `done.json`, so one pass over a run still in progress
  ends on its last gate line with no terminal line; when the channel fails, the standard error envelope
  is the last line, after any gate lines already streamed), **`stats`**, **`status`**, **`inspect`**, and **`vm`**.

**`record`'s `ok` is the exit code's verdict, in every arm** (a single file, `<dir/>`,
`--rerecord-stale`, and `--dry-run`): `ok` ⇔ exit `0`. A recording's own verdict is published beside it —
`results[0].verdict.pass` for a single file, `items[].verdict.pass` for a batch — and the two differ exactly
when `--allow-failing` records a failing run on purpose (exit `0`, `ok: true`, `verdict.pass: false`).
**A `record` refusal after the run publishes the run.** Once the agent has finished and returned a result,
anything that stops the cassette being written — a failing verdict without `--allow-failing`, an assert on
an artifact too large to commit (also waived by `--allow-failing`), the record-time scan quarantining a host/machine-inventory finding, or any
other error before the write (a cassette directory that cannot be created, say) — exits `1` with
`ok: false`, `error.category: "runtime"`, and that run in `results[0]` (a single file) or on its `failed`
item as `verdict`/`result` (a batch), and its cost counts toward a batch's `--max-budget-usd` running total
(which stops a batch only at `--concurrency 1`). It is `runtime`, not `usage`, because the scenario loaded
and ran; what refused it is the run's own evidence. Every other failure has `results: []` and no
`verdict`/`result` on a batch item: a refusal before the run (credentials, an unresolved model, the budget
pre-flight, a policy refusal) and a run that ends in a thrown error before it returns a result (an
unanswered gate, say). Before 4.0.0 the post-run refusals printed `results: []` with category `usage`, so
the run they refused, and its cost, were not in the document.
Before 4.0.0 single-file `record` set `ok` from the verdict, so that case printed `ok: false` beside exit
`0`; and `record <empty dir/> --dry-run` printed `ok: true` beside exit `2`.
The batch arms (`record <dir/>`, `record --rerecord-stale <dir/>`) print one payload-shaped document, last,
right before the exit:

```jsonc
{ "tool": "cowork-harness", "version": "...", "command": "record", "ok": true,
  "target": "<dir>", "rerecordStale?": true,
  "items": [ { "file?": "<scenario>", "cassette?": "<cassette>",
               "status": "recorded" | "failed" | "skipped-budget",
               "error?": "string",                 // failed only
               "verdict?": { "pass": bool, ... }, // recorded, or failed after the run: the run's verdict
               "result?": { /* RunResult + verdict/provenance/outcome, as single-file record publishes it */ } } ],
  "skipped?": ["<non-scenario file>"],             // <dir/> only: files without a `prompt:`
  "error": null }
```

A scenario file that did not load is a `failed` item. A batch stopped by `--max-budget-usd` exits `0`, so
`ok: true` can accompany `skipped-budget` items — unlike `run --repeat`, whose budget-stopped batch fails
unless `--allow-budget-stop`. `--rerecord-stale` with nothing stale prints `ok: true` and `items: []`.
A refusal before the first recording (no credentials, an unresolved model, the budget pre-flight, a slug
collision) prints the error envelope instead, as before.

**`regrade`** re-grades a kept run's `semantic_matches` asserts with the judge and prints one payload-shaped
document, `{tool, version, command: "regrade", ok, runs: [...], error: null}`, described by
**`schema/regrade.json`** (a §12-covered surface). Each `runs[]` entry is one run dir:
`{runDir, turn, scenarioSha256, regradeFile, pass, invalidGrades, judgeCostUsd?, unpricedGrades, uncheckedCount,
uncheckedSections[], docMatchesLive, differingSections[], liveDocDrift[], assertions[], notRegraded[], authoredCapture}`,
and the document's top level also carries `judgeCostUsd?` and `unpricedGrades` summed over every run dir. `runs[]`
holds only graded run dirs: a refusal refuses the whole batch and prints the error envelope instead.
`scenarioSha256` is the SHA-256 of the scenario file's bytes. `judgeCostUsd` is the sum of the priced judge
calls and is absent when none was priced (never `0` for unknown); `unpricedGrades > 0` makes it a floor.
`invalidGrades` counts asserts the judge could not grade (`judgeInvalid`), which also fail. `assertions[]` carries the re-graded asserts in the `RunResult.assertions[]` shape plus
`assertionIndex` (the assert's position in the scenario) and its own `docMatchesLive`; `notRegraded[]` lists
every other assert as `{assertionIndex, keys}`.

`docMatchesLive` is `true` | `false` | `"scope_changed"` | `"unknown"` | `"live_refused"` | `"not_graded"`. **Per
assert** it describes that assert's own document: whether the recomposed judged document equals, section for
section, the `judgedDoc` the live run recorded (`unknown` when this assert's scope has no live fingerprint, never
`true`; `live_refused` when every live assert with that scope refused its evidence and no fingerprint was
recorded — one that recorded a `judgedDoc` is compared like a graded one; `not_graded` when the re-grade's own
assert refused its evidence, so no judge was called for it and no document was handed to one; `false` also when
its document carries a section an accepted drift is in). **Per run** — the value to consume — it is `false`
whenever `liveDocDrift[]` is non-empty, and otherwise the worst over the asserts in the order `false`,
`live_refused`, `unknown`, `scope_changed`, `true`, and `not_graded` only when every assert is. So an accepted
drift is never reported as `true` or `not_graded` at the run level, even beside a graded assert whose own
document is `true`. None of these values changes the exit code. `differingSections[]` entries are
`{assertionIndex, kind, path?, change: "changed"|"added"|"removed"}`. `ok` is `true` iff every re-graded assert
passed, i.e. iff the exit code is `0`. `docMatchesLive: false` says the bytes differ, not why (an authored file
changed since the run, a different secret-scrub set, a sub-agent section, a Skill-result section).

Two evidence refusals are decided before any judge call, for every run dir:

- **Drift.** Each live assert that recorded a `judgedDoc` is rebuilt from the live run's own inputs (its scope,
  the live `evidence_files` union, and the recorded budget — for a run recorded before `authoredCapture` existed,
  the `--authored-total-bytes` value passed) with this process's secrets, and any difference refuses unless
  `--allow-doc-drift` is passed — whatever the new scenario's scope. An accepted drift is graded and reported in
  `liveDocDrift[]` (`{liveAssertionIndex, sections: [{kind, path?, change}]}`, indexed by the assert's position in
  the LIVE run's `assertions[]`; an empty `sections` means only the whole-document hash differs).
- **Unchecked content.** A graded document's sections are measured against the live documents just rebuilt: a
  section none of them has is content the live judge never read — brought in by a widened scope (`evidence_files`,
  `include_subagent_text`, `include_fork_results`) or a larger `--authored-total-bytes`. It refuses unless `--allow-unchecked` is passed;
  accepted, it is graded, warned about and listed in `uncheckedSections[]` (`{assertionIndex, kind, path?}`) with
  `uncheckedCount` its length. A section the rebuild has is either what the live judge read or an already-reported
  drift, so the two flags are independent. In particular, under `--allow-doc-drift` alone an ADDED drift section
  (an old run given a larger `--authored-total-bytes` than it really used shows up this way) counts as covered,
  so its content reaches the judge without `--allow-unchecked`: it was detected and explicitly overridden, and the
  drift warning names its files. `--allow-unchecked` covers only content the drift check could not compare at all.
  The harness's own evidence-health and scratch notes (fixed text and file paths, scrubbed with this process's
  secrets) are never unchecked content, so a smaller budget — which only drops or truncates file content, and may
  add a health note saying so — is never refused as unchecked; content it truncates makes that assert refuse its
  own evidence. An assert whose evidence will be refused sends nothing and is not measured.

Not checked: a run in which no live assert recorded a `judgedDoc` has no rebuilt document to measure against — its
asserts are `unknown` or `live_refused`, neither drift- nor secret-checked, and are warned about before the judge
call, not refused. A blind assert beside a comparable sibling is measured against the sibling's rebuilt document,
so its extra content can refuse. The envelope is scrubbed with the same secret set as the file.

**Exit codes:** `0` every re-graded assert passes · `1` any fails or is judge-invalid · `2`, with three meanings:
a usage error; a refusal before any judge call (a multi-turn, partial, replay or chat run dir, a pruned work dir,
a missing transcript sidecar, a run that did not record `authoredCapture` without `--authored-total-bytes`, an
alias judge model, a scenario with no `semantic_matches`, and the two evidence refusals above); or a failure
writing a regrade file after earlier run dirs were graded. Each is the shared error envelope. The evidence
refusals are collected over every run dir and carry `error.code` — `doc_drift` when any dir drifted, else
`unchecked_content` — and a top-level `refusals[]`, one entry per run dir and code: `{runDir, code,
uncheckedCount?, uncheckedSections?, liveDocDrift?}`; every other refusal stops at the first run dir that
fires it and carries no code. So `refusals[]` is complete only when no other refusal fires: a batch with a
drifted dir and a later dir refused for another reason (a pruned work dir, say) reports only the latter, with no
code and no `refusals[]`.
A write failure carries the run dirs already graded and written in a top-level `runs[]`.
`result.json` is never modified.

The command lists above are illustrative, not a frozen contract — this is not a single universal
envelope across every command, so check a given command's own section (or grep its
`jsonEnvelope`/`jsonPayloadEnvelope` call site in `src/run/envelope.ts`/`src/cli.ts`) for its exact
shape before parsing it generically.

**`--max-budget-usd` in JSON: the `budget` marker and `error.code`.** The cap is a fact about the
invocation, not about any one `RunResult`, so it is published on the envelope frame — beside `ok` and
`error`, on every family (`results[]`-bearing, payload-shaped, and the error envelope) — as a top-level
`budget` key, whenever a `--max-budget-usd` pre-flight ran: `run` (a file, `<dir/>`, `--matrix`), `skill`,
`record` (a file, `<dir/>`, `--rerecord-stale`, and both `--dry-run` arms), and `eval` (a real eval and
`--dry-run` alike). It is **absent** when no cap
was passed and on a `--repeat` lane, which skips the pre-flight and enforces a running total instead
(reported as `rollups[].stoppedEarly: "budget"`). One shape, used in both places below:

```jsonc
"budget": {
  "capUsd": 0.5,                       // the --max-budget-usd value
  "basis": "single" | "batch",         // single: each scenario's OWN worst observed cost vs the cap (run, skill,
                                       //   a record file, each scenario of run <dir/>); batch: the SUM over a
                                       //   record <dir/> / --rerecord-stale batch, or over an eval's schedule
                                       //   (each scenario's worst x its 2 x --reps runs), vs the cap
  "enforced": true | false | "lower_bound",
                                       // true: every scenario was priced. false (single): at least one scenario
                                       //   had no history and ran with NO cap. "lower_bound" (batch): unpriced
                                       //   scenarios contributed $0, so the cap was checked against a lower bound
  "reason?": "no_history",             // present exactly when enforced !== true
  "estimateUsd?": 0.31,                // single: the largest worst-observed cost among the priced scenarios;
                                       //   batch: the summed estimate. Absent when nothing was priced
  "unpriced": ["<scenario>"],          // scenarios with no priced history in runsDir's index; [] when enforced
  "runsDir": "<abs path>",             // the runs root whose index.jsonl was read
  "runsDirRedirected": bool            // --run-dir / COWORK_HARNESS_RUNS_DIR moved it off the default
}
```

History is read from `runsDir`'s index only; a `--run-dir` that points somewhere new each invocation
therefore starts every scenario unpriced. When `runsDirRedirected` is true the stderr warning says so and
names `--run-dir` / `COWORK_HARNESS_RUNS_DIR` as the cause (the flag works by setting the variable, so the
two are not distinguished).

A budget **refusal** is the error envelope with `error.category: "runtime"` (unchanged), plus
**`error.code: "budget_exceeded"`** and **`error.budget`** — the same shape as above, describing the
estimate that was refused (`enforced` is `true`, or `"lower_bound"` when the known part of a batch alone
exceeds the cap). Exit codes are unchanged (`1` on `record`, `2` on `run`/`skill`/`eval`). `error.code` narrows a
category and never replaces one; it is **absent** on every other error, so `error.code ===
"budget_exceeded"` is the whole test for "refused on cost" and a load failure is never mistaken for it.
When the refusal replaces a payload envelope, that payload's findings stay on the error envelope as the
same top-level keys: a `record <dir/> --dry-run` refusal carries `dryRun`, `target`, `scenarios`,
`skipped`, `broken[]`, `refusals[]` and `inputErrors[]`; a `record <file> --dry-run` refusal carries
`inputErrors[]`; a real `record <dir/>` refusal carries `target`, `broken[]` and `skipped`; an `eval` refusal
carries the `plan` when one was computed before it (on a dry run, or a real eval with `--max-budget-usd`, whose
plan is cost-only), and a dry run's refusal always carries `dryRun: true`. (Through 4.2.0
these went to stderr only, and the message prose was the only discriminator.)
On `run <dir/>` each scenario is pre-flighted on its own, so the top-level `budget` (merged across every
scenario checked so far) can differ from `error.budget`, which describes the refused scenario only.

`ok = error===null && results.length>0 && results.every(r => r.result==="success" && r.assertions.every(a=>a.pass) && computeVerdict(r).pass)`.
`result:"success"` and passing assertions are necessary but **not sufficient** — `computeVerdict` adds a
verdict-signal layer that can still fail a run (e.g. `stalled` — ended on a question or a closing request for input with no productive work after its last gate, `transport_error`,
`missing_capability`, `permissive_auto_allow`, `outputs_delete`, `host_path_leak`, `l0_host_config_contamination`),
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
abridged to the fields most consumers branch on. The complete field list is
[`schema/run-result.json`](./schema/run-result.json), the covered surface named in
[§12](#12-versioning--the-10-compatibility-contract), kept in step with the `RunResult` type by
`test/run-result-schema-sync.test.ts`.
```jsonc
{
  "scenario": "string",
  "command?": "run|skill|record|chat|replay",    // the CLI command that produced this result — finer than `mode` (which only distinguishes run/chat); `reindex` prefers this over `mode` so a `skill`/`record` row isn't relabeled `run`
  "fidelity": "protocol|container|microvm|hostloop|cowork  (replay: \"replay:<f>\")",
  "baseline": "string",                          // platform baseline appVersion
  "result": "success" | "error",                // did the agent turn end without error (NOT "task completed")
  "resultErrorKind?": "transport|agent|usage_limit", // when result==="error": a tail-end transport drop, a genuine agent/skill failure, or usage_limit (quota exhausted — is_error + HTTP 429 + a terminal usage-limit message; not the skill's fault, retry after reset)
  "errorSource?": "spawn|protocol|exit|agent|result|no_result|timeout|decider_timeout", // finer diagnostic detail alongside resultErrorKind; no_result = stream ended with no terminal event; timeout = the harness's own wall-clock limit fired; decider_timeout = an external decider channel did not answer a gate within its backstop (an unanswered-gate partial)
  "resultSubtype?": "string",                    // the SDK result message's subtype verbatim (e.g. error_max_turns), pass-through diagnostic
  "stderrLogPath?": "string",                    // absolute path to the agent's full stderr log; live only, absent on replay
  "stalledOnQuestion?": bool,                     // H2/H3: ended on a question or closing request for input, no productive tool work after its last gate → `stalled` verdict fail unless allow_stall
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
  "fingerprint?": { "baseline", "hashFormat?": "jcs1", "skillHash?", "skillSources?":[], "skillScope?":[], "sharedHash?", "contentSig?", "fileSigs?":[["relpath","hashedSha"]], "fileSigsOmitted?": bool, "mode?": "git|raw", "agentScope?": "skill" }, // skill/plugin staleness fingerprint recorded at run time; lets `verify-run` detect a kept run whose gate snapshot predates a skill change. `hashFormat` names the manifest transform that produced the digests — ABSENT means the LEGACY (pre-v12) transform, never raw bytes. A `fileSigs` sha is the sha of the bytes that FOLD INTO skillHash, which for a plugin manifest is not the file's own bytes
  "outDir": "string",
  "workDir?": "string",                          // the agent's working root (mnt/) inside the run dir
  "outputsDir?": "string",                       // the user-visible deliverable mount (mnt/outputs)
  "userVisibleRoots?": ["string"],               // user-visible mount roots (relative to mnt/) — `outputs` plus each connected folder's resolved mount name; plugins excluded
  "readonlyFolderRoots?": ["string"],            // subset of userVisibleRoots that are read-only (mode:"r") connected-folder mounts — inputs, not deliverables; `artifacts` excludes them
  "artifacts?": [{ "path","bytes" }],            // files written under the user-visible roots (paths + sizes only — no content snapshot)
  "preRunPaths?": ["string"],                    // workRoot-relative paths under the user-visible roots that existed BEFORE the agent ran — the `no_unexpected_files` baseline; absent on a --resume run or when the run predates the seam (every live sandbox tier captures it now, microvm included)
  "effectiveFidelity?": "string",                // tier actually used (differs from `fidelity` when "cowork" resolved)
  "nonDeterministic?": bool,                      // true if any decision came from a non-deterministic source → not reproducible
  "gateProvenance?": { "total": number, "bySource": {…}, "gates": [{ "question","answeredBy","answer","model?" }] }, // how each AskUserQuestion gate was answered; informational (never fails the verdict); live/partial lane only (absent on replay)
  "permissiveAutoAllow?": ["string"],             // tools auto-allowed by cowork parity that real Cowork BLOCKS → green is NOT faithful
  "staleness?": [{ "class": "baseline|skill|shared-root|format|unverifiable-baseline|unverifiable-skill|resolved-tier|unverifiable-tier|prompt-assets|unverifiable-prompt-assets", "message" }], // replay only; cassette-staleness findings, surfaced for a JSON gate. Drift classes are non-failing by default (a stale but passing replay stays ok:true); `unverifiable-skill` FAILS by default since 2.0.0. `--strict` fails on every class, `--fail-on-skill-drift` adds skill/shared-root. `resolved-tier` = a `fidelity: cowork` cassette's recorded effectiveFidelity no longer matches the tier the scenario's baseline (pinned `baseline:` or `latest`) resolves to today — the recording exercises the wrong tier; `unverifiable-tier` = the tier check couldn't run for a baseline-dependent (`fidelity: cowork`) cassette (no recorded effectiveFidelity, or its pinned baseline failed to load). Tier resolution is baseline-only (the CLAUDE_FORCE_HOST_LOOP env override is suppressed) so verify results can't differ across machines. `prompt-assets` = the baseline's committed prompt-asset files (spawn.promptTemplate/subagentAppend/subagentAppendHostLoop), or the sub-agent prompt text the harness generates rather than reads from an asset (the folder manifest + trailing sentence, Desktop >=1.46388.3), changed since record under the SAME appVersion — warn by default, `--strict` fails, re-record; `unverifiable-prompt-assets` = a recorded `fingerprint.promptAssetsHash` exists but the live baseline's prompt assets can't be hashed (a moved/dangling pointer) — can't verify ⇒ not green.
  "skippedAssertions?": { "full": number, "partial": number }, // replay only; count of live-only assertions NOT evaluated (full = whole assertion skipped; partial = content half ran, fs/egress half dropped). The skipped ones are absent from `assertions[]`.
  "toolResults?": [{ "toolUseId?","isError","text","assertText?" }], // tool-result text at assertion-fidelity cap (10,240 chars; 32,768 for a top-level main-agent Skill result); backs tool_result_contains/tool_result_not_contains and their regex siblings tool_result_matches/tool_result_not_matches
  "skillsInvoked?": ["string"],                  // Wave 1: skill/plugin ids invoked via the Skill tool_use event, call order, duplicates kept. Backs skill_triggered/no_skill_triggered.
  "slashInvokedSkills?": ["string"],             // staged skill ids the turn's prompt invoked by a leading slash command (`/<skill> …`, `/<plugin>:<skill> …`), resolved against the init skill inventory — the agent expands these itself with no Skill tool_use, so they never appear in skillsInvoked. [] = none; absent = cannot tell (ambiguous bare name, a slash prompt with no inventory, or an older result). skill_triggered/no_skill_triggered read both
  "skillToolAvailable?": bool,                    // Wave 1: whether the agent's init tool list included "Skill" — false ⇒ skill_triggered/no_skill_triggered fail as evidence-unavailable (agent-version drift)
  "scan?": { "outputsDeletes": ["string"], "outputsDeleteBasis?": ["fs-diff|named|inferred"], "hostPathLeaked": bool, "inputHostPathTokens?": number, "hostPathsFromInputs?": number, "selfHealRan?": bool, … }, // post-run scan signals (live lane only). outputsDeleteBasis is positional with outputsDeletes: fs-diff = proven by the filesystem diff; named = a delete in command/call position has an outputs path as its own operand; inferred = flagged by the detector's inference. hostPathLeaked excludes host paths that came verbatim from the scenario's inputs (container/microvm): inputHostPathTokens = how many distinct host-path tokens those inputs carried, hostPathsFromInputs = how many matches they exempted (both omitted when zero)
  "fsDiff?": { "status": "clean|findings|unavailable", "reason?": "baseline-incomplete|post-walk-incomplete", "findings": ["string"] }, // the outputs-delete filesystem diff for this turn (live lane only): outputs/ at turn start vs. after the turn. clean = no path present at turn start was deleted; unavailable = it could not verify. A sibling of scan so a filesystem-proven delete survives a missing events.jsonl
  "evidenceErrors?": { "taskTracking?": number, "webSearchParse?": number, "presentFilesMalformed?": number, "egressParse?": number } // dropped/malformed telemetry lines per stream; a >0 taskTracking/presentFilesMalformed count fails the dependent assertion "malformed" rather than silently dropping bad entries; webSearchParse/egressParse are observability-only
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
{ "tool":"cowork-harness","version":"...","command":"...","ok":false,
  "results":[],  // [] except record's post-run refusal: the refused run, beside the non-null error
  "budget?": { /* §11 --max-budget-usd marker — present when a pre-flight ran */ },
  "error": { "category": "usage|unanswered|boundary|runtime|internal", "message": "string", "hint?": "string",
             "code?": "budget_exceeded|doc_drift|unchecked_content", "budget?": { /* §11 --max-budget-usd */ } } }
```
`error.code` narrows a category, never replaces it: `budget_exceeded` is the `--max-budget-usd` refusal (§11);
`doc_drift` and `unchecked_content` are `regrade`'s evidence refusals, whose error envelope also carries a
top-level `refusals[]` (see `regrade` above).
Categories come from TYPED errors (`UnansweredError`→`unanswered`, `BoundaryError`→`boundary`).
`results` is `[]` with one exception: when `record` refuses to write a cassette after the agent finished,
the run it refused is in `results[0]` beside the non-null `error` (category `runtime`, exit `1`; see
`record` above).

**Exit codes** (branchable without parsing): `0` all-pass · `1` assertion/agent failure · `2` usage /
unanswered-under-`fail` / runtime · `3` boundary/integrity. (`--output-format json` writes via `writeSync` so the envelope
is never truncated by `process.exit` on a pipe.)

**Reserved:** exit `4` on the `run`/`skill` family is reserved for a future "needs input / surfaced
question" outcome (the deferred `on_unanswered: surface` / `needs_input` Track 2). It is currently
unused — reserving it now keeps a later addition additive rather than a renumbering of the burned
`0`/`1`/`2`/`3` space. Exit-code space is **per-command**, not global (`status` uses `0`/`1`/`2`/`3`
with its own meanings); this reservation applies only to the `run`/`skill` family. `rehash` does use `4`,
for partial migration success (above) — a different command, so it does not consume this reservation.

**`gates <dir>`:** one pass over a directory that does not exist, or any path that is not a directory,
is a usage error (exit `2`); `--follow` waits for a directory that does not exist yet (the run creates it)
and says so once on stderr. A gate request that cannot be parsed is a `runtime` error (exit `2`): under
`--follow` after bounded retries, in one pass on the first read. Before 4.0.0 one pass over a missing
directory, or over a malformed request, exited `0` with nothing printed.
**A declared input path that does not exist, or is the wrong kind, is a usage error.** A scenario file,
or its `session:` file, that is missing, a directory, unreadable or not valid YAML (a leading `~` in
`session:` expands to the current user's home directory); a `baseline:` path to a file that is a directory,
not valid JSON or not a platform baseline; a plugin folder, `--upload`, `--folder`, a session's `uploads`/`folders`/`projects`/`skills.local`/`local_plugins`/
`local_marketplaces` (or a marketplace `entry.source`), an `enabled` plugin missing from its local
marketplace, a file where a directory is required (or the reverse), two sources mapping to one mount
destination, a `plugins.config_dir` that is not a directory, an unsafe mount-name segment (a `:` in an
upload's file name), a session `effort:` the schema rejects or the model does not offer, and a
`--session-id` with characters outside `[A-Za-z0-9_-]` are refused as category `usage` (exit `2` on `run`/`skill`; `record` keeps its `1` for a
refused recording), before the run directory is created, so a refused run leaves no run dir; `chat`
makes the same check before it creates its run dir. `run <dir/>` (without `--repeat`, whose rollup reports
such a scenario) checks every scenario's input paths and baseline name before the first one runs, and one
refusal names every offender (a single file keeps the unprefixed message and hint). `skill
--dry-run` makes the same check, so its preview of such a path exits `2` — `--ablate-skill` included, since
ablation drops the plugin from the run but the path is still the caller's input; an unresolved model is not
an input error and the preview reports it as `model: null`. `record <file> --dry-run` makes the same check
over its scenario's session, so both previews surface a bad input path; there it is a refusal of a scenario
that loaded, so it exits `1` (and when the scenario also has a tier-vacuous assertion, the refusal names
the vacuity, as the real `record` does). `record <dir/> --dry-run` makes the same check per scenario and
lists each input the real record would refuse (a session file, an input path, effort or baseline name, a
baseline file that does not load, or a tier-vacuous negative tool assertion) under `inputErrors[]` (`{file,
message, hint?}`) in its payload, with a `⚠ input error:` stderr line that survives `--quiet`; `record <file>
--dry-run` reports a session file that cannot be read, and a tier-vacuous assertion alone, the same way. It is additive, so `ok` and the exit code
do not change (such a scenario is a `failed` item on the real `record <dir/>`); a gate that wants it
checks `.ok and (.inputErrors == [])`. The previews check existence and kind, not the git tracked-set
filter, which only a real run applies. Under `COWORK_HARNESS_SOFT_MISSING` a missing source is
excluded instead, and the preview
prints the same exclusion warning the run prints. `verify-run` follows the same rule: a run dir that does
not exist or is a file, or a scenario file that does not load, is `usage`; a directory holding no completed
run stays `runtime`. `answer` splits the same way: a directory or gate that is not there is `usage`; a gate
request that exists but cannot be read or parsed, or an answer that cannot be written, is `runtime`.
**Per-command exceptions:** `critique` **never gates on findings** — it exits `0` for any finding of any classification, and even when the task run it graded ERRORED (that is a finding about the skill, not a broken instrument). It exits `2` only for a usage error or an **instrument failure**: the turn was killed, the reflection protocol broke, or the evaluator was never invoked *or threw* — i.e. no critique was produced. Do not gate CI on `critique`; that inverts its design. `eval` (and `eval report`) exits `0` when the comparison completed — whatever drops the rows show, unless `--fail-on` was given; `1` for a drop at the `--fail-on` level (`possible` or `confirmed`; no gating without the flag — under `possible` a drop includes an `insufficient_refusals` row, one the candidate's excess `semantic_matches` refusals for unavailable evidence took below the rep threshold, which would otherwise hide a drop as `insufficient`), every row `insufficient`, or a judge model that differed across reps; `2` for a usage error or any refusal before the first run (an alias model, an eval dir inside a git work tree, identical arms, the answer-key guard, a scenario input a run would refuse, an unreachable `--fail-on confirmed`, a `--max-budget-usd` refusal — `error.code: "budget_exceeded"`); `3` when an arm snapshot could not be copied or failed its staging preflight. Its `--output-format json` envelope is `{tool, version, command:"eval", ok, evalDir, arms, pins, sections, summary, cost, stoppedEarly, error}`, with `ok` ⇔ exit `0`. `eval --dry-run` runs no agent and creates no eval dir: it exits `0` with the plan (`{tool, version, command:"eval", ok:true, dryRun:true, plan, budget?, error:null}`), `2` for any refusal the real eval would make before its first run (the budget refusal included), `3` as above, or when its temp dir is inside a git work tree or git cannot tell whether it is (set TMPDIR) — its arm snapshots go to a temp dir that is removed afterwards. `hillclimb run` exits `0` when every attempted (case, rep) was scored, `1` when any attempt failed (an `errors.jsonl` row, or a scored row whose trace or copies could not be written), the pass stopped mid-run (rows already written are kept), or `summary.json` could not be written after the pass, and `2` for any refusal before spending: a usage error, the harness gate, an alias model, a flow-dir or `_state.json` problem, split or duplicate case ids, an unknown `--case`, the answer-key guard, a `harness_paths` entry inside the tuned plugin, a missing or incomplete variant snapshot, a scenario input a run would refuse, a `semantic_pairwise` reference that is missing, damaged or exposed through a mount (the gate a run applies), a host `claude` that cannot run the judge or LLM decider isolated (checked when a scenario uses `semantic_matches` or `semantic_pairwise`, or `on_unanswered: llm` with no decider channel, as on `eval`), or a decider with `--concurrency` above 1; `--dry-run` exits `0` unless such a refusal fires; the harness gate does not refuse a dry run, which reports its status instead. `--timeout-s` bounds the whole attempt: the agent phase through the scenario's `timeout_ms` (lowered to it), and the judge phase through a deadline no judge may start after; an attempt that reaches it is an `errors.jsonl` row (`timeout`), never a scored one. Its envelope's `ok` ⇔ exit `0`. Its `--dry-run` `plan.cost` is the same object `eval --dry-run` emits at `plan.cost` (covered keys `jobs`, `meanUsd`, `p50Usd`, `p95Usd`, `worstObservedUsd`, `lowerBound`, `unpriced`, `pricedRuns`, `thinnest`; `p95Usd` and `worstObservedUsd` are pessimistic figures, never bounds, and `worstObservedUsd` is not the `--max-budget-usd` gate's figure), priced on `eval --dry-run`'s basis exactly — the scenario's runs on this machine at its effective tier and baseline, turn 1, every `hillclimb:` run excluded — so each covered key means the same on both commands. `jobs` is the slots the pass would still run after resuming. A scored row records how its judge ran in `meta.judge_transport` (`assertions[].judgeTransport`'s shape, `{isolation, cliVersion?, strictMcp?}`), or `meta.judge_transports` listing each distinct one when its asserts were judged differently; neither is present when no host judge recorded one, so a round judged under a different isolation can be told apart from a regression. `hillclimb check` exits `0` clean, `1` on any error finding (a headroom warning never changes it), `2` usage; `hillclimb state-template` exits `0`, or `2` on usage or a refusal. `lint` exits `127` when `python3` is missing (spawn error), and `1` — never `0` — when the scenario loader rejected a file but its findings could not be handed to the linter (an unwritable temp directory); `replay` exits
`2` on a **whole-cassette operational failure** — anything `readCassette` rejects (unreadable, invalid
shape, unsupported version, unrecognized assertion key) or any per-file throw, plus the batch loop's
own source-resolution failures (`--assert-from`/`--reassert` drift, scenario-parse errors, `--write`
persistence refusals). Each is caught per-file in the batch loop, tallied as an error result, and never
aborts the rest of the batch. This is distinct from a malformation found *inside* an otherwise-parseable
cassette (e.g. a corrupt `events` line, a bad control frame) — those surface as ordinary **exit-`1`
assertion failures** (`replay_protocol_error` / `replay_protocol_fidelity`) via the normal `0`/`1`
verdict, not exit `2`. `sync` exits `2` on a non-macOS platform (the platform guard,
alongside the `sync` hard-failure → `1` note below).
**`record <file>` separates a refused scenario from a broken one by exit code, and `--dry-run` answers
identically.** A scenario the **loader** rejects — absent file, unparseable YAML, an unknown key, an
invalid enum value — exits **`2`**, matching `run` and `replay`. A **pre-spend policy refusal** — a
scenario no run could satisfy, `on_unanswered: prompt`, the host-inventory destination refusal, a slug
collision, a scenario that resolves no model — exits **`1`**. So `2` means it did not load and `1` means it loaded and this record was
refused, on the preview and the real command alike. The `--max-budget-usd` refusal is one of the `1`s: it
keeps its `runtime` error category, but since 4.0.0 it exits `1` on both paths (it exited `2` before), so
no refusal of a scenario that loaded shares `2` with one that did not. `skill` and `run` are unchanged: their
`--max-budget-usd` refusal still exits `2`. That split is what makes `record <file> --dry-run`
usable as a "does this still load?" check: a corpus where the destination refusal is routine would
otherwise report every valid scenario with the same code as a broken one. The scenario is parsed once,
BEFORE the credential guard, so "does this file load" never depends on holding a token. "Would this
record" reads a second file: to answer the model refusal, `--dry-run` also opens the scenario's session
(the model resolves from `--model`, the session's `model:`, then `COWORK_HARNESS_MODEL`). A session that
does not load is skipped by the model check, not refused by it; the input check answers it instead: a
session file that cannot be read is reported under `inputErrors[]` (exit and `ok` unchanged), a session the
schema rejects is refused like a bad input path, and the real record refuses both. On the real
`record <file>` the credential guard still comes first: with no credentials, `record` exits `2` (`runtime`,
"no model credentials") before the model refusal can answer.
A `record <dir/>` target keeps the same 1-vs-2 meaning at batch scale: a directory whose files all fail
to load exits `1` (they are broken, not absent), while a directory with no scenarios at all exits `2`.
Where a `--max-budget-usd` cap could also refuse, both outcomes exit `1`: **all** files broken exits `1`
(nothing loaded, so there is nothing to spend on and the budget gate never runs), and **some** broken
alongside a loadable scenario over the cap also exits `1`, because the budget refusal is a refusal of a
scenario that loaded. Before 4.0.0 the second case exited `2`.
On a `record <dir/>` target only the **path-independent** refusals (prompt policy,
assert contradiction, duplicate cassette target, a scenario that resolves no model — `--model` applies
batch-wide, so this arm knows it exactly) join `broken[]` in exiting `1`; the path-DEPENDENT ones
(host-inventory destination, cassette portability) are advisory `notes[]` that do not affect the exit
code, because a dir target takes no `--out` and the preview would be guessing the destination. Inputs the
real record would refuse (a session file that cannot be read, an input path, effort or baseline name, a
baseline file that does not load, a tier-vacuous assertion) are listed
under `inputErrors[]`, which also leaves the exit code at `0` (see the input-path rule above).
**`verify-cassettes` uses its OWN three-way split, not the `run`/`skill` meanings above:** `0` clean ·
`1` verification RAN and found a real problem (any PII finding, any staleness finding whose
`StalenessFinding.class` is NOT `unverifiable-*`, or scenario-prompt drift) · `2` usage · `3`
verification could NOT complete (any `unverifiable-*`-class staleness finding, a recorded scenario source
the loader rejects so the prompt-drift check cannot run, a cassette written by a newer harness than this
one understands, or a per-file read error/crash — including a
malformed/unreadable cassette, which is tallied there rather than as a `1` finding). A real finding
always outranks a could-not-verify signal within the same run, so exit `1` wins if both occur.
**`rehash` uses its own four-way split:** `0` all migrated (or nothing needed migrating) · **`4` PARTIAL —
some migrated, some could not** · `1` nothing migrated and at least one could not · `2` usage. The partial
code is distinct because the two failing shapes demand opposite responses — commit what migrated and budget
a re-record for the rest, versus nothing here is salvageable — and while both were `1` a shell consumer
reading only the exit code could not tell them apart (the JSON envelope always carried the split as
`migrated`/`skipped`/`errors`). `4` rather than `3`: the code space is per-command, and `3`'s "could not
verify" meaning is load-bearing on `verify-cassettes` — a migration that partly succeeded is not a failed
verification.
**Collision warning:** the `run`/`skill` family's exit `3` means *boundary/integrity* (§11 above);
`verify-cassettes`' exit `3` means *could not verify*. These are unrelated per-command meanings that
happen to share a number — a CI script that branches on exit code across commands must not conflate
them. See §11.1.

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
  "ok": true,                       // false if any real finding, staleness drift, unverifiable staleness, version mismatch, or unreadable cassette
  "coverage": { "privacy": true, "staleness": true },  // which scans ran (false under --skip-privacy / --skip-staleness)
  "results": [ { "file": "string",
                 "findings": [ { "where": "string", "cls": "email|currency|domain|path|machine-inventory|host-inventory|unscanned|binary", "sample": "string" } ],
                 "staleness": [ "string" ],   // GENUINE drift: a StalenessFinding whose class is NOT `unverifiable-*` (gate failure, exit 1)
                 "unverifiable": [ "string" ],// a StalenessFinding whose class IS `unverifiable-*`, or a `scenario-drift:` entry for a recorded scenario source the loader rejects (e.g. no `fidelity:`) — could not verify (exit 3, unless the SAME run also has a `staleness`/`findings`/`scenarioDrift` entry, which wins exit 1). A YAML syntax break in that source stays a `notes[]` entry
                 "notes": [ "string" ],       // NON-failing informational channel (never affects ok/exit) — e.g. a pre-effectiveFidelity cassette with an explicit tier: statically knowable, nothing baseline-dependent to verify. Text output: a `·`-prefixed row.
                 "version": [ "string" ],     // cassette written by a NEWER harness than this one understands — always a could-not-verify failure (exit 3), independent of --skip-staleness
                 "error?": "string",          // a malformed/unreadable cassette (or a per-file crash) is TALLIED here, never crashes the batch — a could-not-verify failure (exit 3)
                 "privacyScanned": true } ] }  // did the privacy scan actually RUN on this file? It needs a readable TRANSCRIPT (an `events` array of
                                              // strings), NOT a valid cassette — so a file that fails shape validation still reports findings AND an
                                              // `error`, and `error` alone cannot answer "was this checked". `false` = the scan could not run (unreadable
                                              // JSON, no `events`, a crash) or was disabled with `--skip-privacy`; there, `findings: []` is an absence of
                                              // evidence, not evidence of absence. A gate that must not treat "could not verify" as "verified clean"
                                              // keys on THIS, never on `error`.
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
catalog boilerplate either. `ok = no finding with cls!="unscanned"  &&  no staleness message  &&  no unverifiable message  &&  no version message  &&  no error`. An `unscanned` finding (a
`>64 KiB`/unreadable artifact body, which is hash-only — nothing committed to leak) is reported but does NOT
fail the gate.

**Exit codes:** `0` clean · `1` **verification RAN and found a real problem** — any `findings[]` entry
(cls != `unscanned`), any `staleness[]` entry, or any `scenarioDrift[]` entry · `2` usage (e.g.
`--skip-privacy`+`--skip-staleness` together, or zero cassettes under a dir — a loud non-zero, never a
vacuous pass; **`--allow-empty` opts out for the empty-directory case only**, exiting `0` with
`ok:true, results:[]` — a *missing* path still exits `2`, so the flag can never green a typo) · `3` **verification could NOT complete** — any `unverifiable[]` entry, any `version[]`
entry, or any `error` (a malformed/unreadable cassette or a per-file crash). A real finding always wins
`1` over a co-occurring could-not-verify signal in the same run. This split exists so a consumer's
non-zero-exit tripwire can't false-green on a could-not-verify outcome (e.g. a cassette a newer harness
wrote) mistaking it for the finding the tripwire was built to catch — see the collision note in §11.
The `in:` assert operator (§ scenario schema) and `record <dir>`/`--rerecord-stale` batch
recording are also part of 0.8.0; see `docs/scenario.md` and `docs/cassette.md`.

**CB-3/CB-4 — `chat` REPL flags and `/help`:** The `chat` subcommand accepts `[--plugin <dir>]…`
(repeatable; CB-3) — each `<dir>` is appended to `localPlugins` and injected alongside the default
skill folder in `plugins.local_plugins`. In `--raw` mode, `--upload`/`--folder`/`--plugin`/`--fidelity`/
`--allow-host-writes` are REJECTED with a usage error (exit 2) — native docker mode mounts one skill
folder only and offers no equivalent for the others, so `chat.ts` fails loud rather than silently
dropping them. The REPL now accepts `/help` as a
built-in command (CB-4), printing `"Commands: /exit  /quit  /help"` without sending a turn; the startup
prompt reads `"type your message (/help for commands)"`. **CB-2:** `flagValue()` in `src/cli.ts` and
the inline `--model` parser in `src/run/chat.ts` both reject empty-string values (`""`/whitespace) with
a usage error (exit 2); passing `--model ""` or `--model` with no following value is now a hard error
rather than silently propagating an empty model string. An empty `COWORK_HARNESS_MODEL` counts as unset
on every lane, for the same reason.

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

### 11.2 `doctor` — dedicated envelope

`doctor [--tier <t>]` is the read-only prerequisite check ("can I run the live tiers — what's
missing?"). Its `--output-format json` output does **not** reuse the `run/skill/replay` envelope (no
`RunResult` to judge) — it emits its own, published as **`schema/doctor.json`** (a §12-covered contract
surface):

```jsonc
// Completed probe (normal path — routed through the shared jsonPayloadEnvelope, so error is always null):
{ "tool": "cowork-harness", "version": "...", "command": "doctor",
  "ok": true,                        // false iff any `required` check has status:"fail" for the selected tier
  "error": null,
  "tier": "container",               // protocol|container|microvm|hostloop|cowork
  "checks": [ { "id": "node", "title": "Node ≥ 22", "status": "ok", "detail": "node 22.x.x",
                "remedy?": "string", "required": true } ] }  // status: ok|fail|warn|skip

// Shared error envelope (a thrown failure — bad flag, or the top-level catch):
{ "tool": "cowork-harness", "version": "...", "command": "doctor", "ok": false, "results": [],
  "error": { "category": "usage|unanswered|boundary|runtime|internal", "message": "string", "hint?": "string" } }
```

`ok = !checks.some(c => c.required && c.status === "fail")`. **Exit codes:** `0` all required checks
pass · `1` a required check is `status:"fail"` for the selected tier (the completed-probe shape, still
`error:null`) · `2` usage (bad `--tier`/unexpected args) or an unexpected internal failure caught by the
top-level catch (`category:"internal"`). The `checks[].id` set is **not** enumerated as a closed
contract — it grows as tiers/checks are added, the same way `trace` row shapes are excluded from §12's
covered list.

## 12. Versioning & the 1.0 compatibility contract

From `1.0.0` the project follows [semver](https://semver.org/). The surfaces below are the **covered
contract**: a backwards-incompatible change to any of them is a MAJOR bump. Everything else — most
importantly human-readable text — is explicitly NOT covered and may change in any release.
Covered-surface changes follow semver as of `1.0.0` — see [RELEASING.md](./RELEASING.md).

**Covered (semver-guaranteed):**

- **CLI surface** — command names, their accepted flags, and the **per-command** exit codes (§11).
  Exit codes are per-command, not global: `run`/`skill` use `0` pass / `1` assertion-or-agent fail /
  `2` usage / `3` boundary-integrity, with `4` reserved (§11). Removing a command or flag, or changing
  an exit-code meaning, is breaking. A flag's default is part of its meaning. (4.0.0's changes under
  this clause are listed after this section.)
- **Scenario & session schemas** — `schema/scenario.schema.json`, `schema/session.schema.json` (the
  authored-input contract). Tightening validation on a previously-valid document is breaking.
- **Baseline JSON shape** — the `baselines/desktop-*.json` field structure (CI's committed source of
  truth; consumers commit and diff these).
- **RunResult envelope** — `schema/run-result.json` under `--output-format json` (§11): the
  `ok` / `results[]` / `error` shape and the verdict-signal codes (§11.0), and the `--max-budget-usd`
  `budget` marker and `error.code` values (§11). Renaming or removing a key, or
  changing what an existing key means, is breaking; adding one is not. For `toolDurations` (keyed by tool
  name) the set of entries is not the key's meaning: adding an entry, such as a tool listed with
  `calls: 0`, is additive. This is stated per key, not for every map — `toolCounts`, for example, lists
  only tools that were called.
- **`verify-cassettes` envelope** — `schema/verify-cassettes.json` under `--output-format json`
  (§11.1): the `command` / `ok` / `coverage` / `results[]` shape with the per-file
  `findings` / `staleness` / `unverifiable` / `notes` / `version` / `error` channels, and the exit-code
  split (`0`/`1`/`2`/`3`, §11) they map to. This is the machine output the CI recipes and the packaged
  Action steer consumers to parse; renaming or removing a key is breaking, adding one is not.
- **`doctor` envelope** — `schema/doctor.json` under `--output-format json` (§11.2): the completed-probe
  shape (`tool` / `version` / `command` / `ok` / `error:null` / `tier` / `checks[]`, each check's
  `id` / `title` / `status` / `detail` / `required` / optional `remedy`) and the shared error-envelope
  shape (`results:[]` / `error.category`) it falls back to on a thrown failure; renaming or removing a
  key is breaking, adding one is not. The `checks[].id` set itself is NOT covered — it grows with new
  tiers/checks.
- **`regrade` envelope** — `schema/regrade.json` under `--output-format json` (§11): the frame (`tool` /
  `version` / `command` / `ok` / `error:null` / `judgeCostUsd?` / `unpricedGrades` / `runs[]`); each `runs[]`
  entry's keys (`runDir`, `turn`, `scenarioSha256`, `regradeFile`, `pass`, `invalidGrades`, `judgeCostUsd?`,
  `unpricedGrades`, `uncheckedCount`, `uncheckedSections[]`, `docMatchesLive`, `differingSections[]`,
  `liveDocDrift[]`, `assertions[]`, `notRegraded[]`, `authoredCapture`) and their nested shapes; on an
  `assertions[]` entry, only `assertionIndex`, `docMatchesLive`, `pass`, `judgeInvalid`, `judgeModel`,
  `judgeCostUsd` and `semanticClaims` (its other keys follow the `RunResult` assertion entry, which is not
  pinned field by field); and the error envelope's `error.code` values (`doc_drift`, `unchecked_content`),
  `refusals[]` and post-write-failure `runs[]`. The enums are covered as sets: `docMatchesLive`, `change`,
  `authoredCapture.source`, a section's `kind`, `error.code`. **Adding a key or an enum value is MINOR** — a
  consumer must treat an unknown `docMatchesLive` as not `true` (one validating against an older schema copy
  rejects the new value); removing or renaming a key or a value, or changing a key's type or meaning, is MAJOR.
  The published schema stays permissive (no `additionalProperties: false`). Meaning that is covered too: a
  per-assert `docMatchesLive` describes that assert's own document, and the run-level value is `false` whenever a
  drift was detected and accepted (`liveDocDrift[]` non-empty) — it is the value to consume. Exit codes: `0`
  every re-graded assert passes (`ok: true` iff exit `0`) · `1` any fails or is judge-invalid · `2` a usage
  error, a refusal before any judge call (the evidence refusals carry `error.code`), or a failure writing a
  regrade file after earlier run dirs were graded (§11). The regrade output FILE is not part of this (below).
- **The planned-schedule cost summary** — `plan.cost` in the `eval --dry-run` JSON envelope, validated by
  `schema/schedule-cost.json` (one serializer, `scheduleCostJson`). Covered: `jobs` (agent runs scheduled),
  `meanUsd`, `p50Usd`, `p95Usd`, `worstObservedUsd`, `lowerBound`, `unpriced[]`, `pricedRuns` and `thinnest` (null
  when nothing is priced). **Their one basis:** each scenario's prior runs in the runs dir's index on the
  schedule's effective tier (`cowork` resolved) and its baseline, turn 1 only, `hillclimb:`-labelled runs
  excluded, agent cost only (no judge or decider spend). `worstObservedUsd` is on that same basis — the sum over
  the priced scenarios of jobs × the most expensive run on it — and is NOT the `--max-budget-usd` gate's figure,
  which reads a wider basis (any tier, baseline or turn, hillclimb runs included; the experimental
  `budgetGateWorstUsd`). Each dollar key sums the priced scenarios only; an unpriced one adds $0, is named in
  `unpriced[]`, and sets `lowerBound`. Every other key of that object (`budgetGateWorstUsd`, `judge*`,
  `decider*`, `items[]`) is experimental. Adding a key is MINOR; removing or renaming one, or changing its basis or
  meaning, is MAJOR.
- **Cassette format** — the maximum `cassetteVersion` this build writes/reads is **14**
  (`schema/cassette.v14.json`) and its verdict-modifier assertion keys.

  `cassetteVersion` means **the minimum reader for the whole cassette**, which covers how its digests are
  computed as well as which `scenario` keys it uses: a reader older than the cassette's hash format
  recomputes `skillHash`/`contentSig` under a different algorithm and reports drift that is not there. The
  stamp therefore floors at the **hash-format epoch** (v12); the scenario-aware differential applies above
  that floor. A backwards-incompatible change to `fingerprint.skillHash` is a MAJOR bump — every stored
  value changes, and digests from different formats are not comparable (`replay` reports
  `unverifiable-skill`; `rehash` migrates without a re-record where it can prove the content unchanged).

  It is not which recorder wrote it: `record` stamps `requiredVersionFor`, the value-aware minimum for that
  scenario, floored at the hash-format epoch. The value-aware part means the stamp reads a field's actual
  VALUE rather than its presence — `lane: "local"`/omitted asks for semantics any older reader already
  gives, so it lifts nothing, while `lane: "remote"` would. The epoch floor dominates most scenarios, so
  cassettes stamp **v12**; the differential decides anything above it — today one value does: an `assert`
  entry using the object form of `tool_called` / `tool_not_called` stamps **v13**. A v12 `verify-cassettes`
  refuses that cassette as too new; a v12 `replay` (3.10.0 and earlier) warns the assertion is tolerated and
  then crashes evaluating it, so upgrade before replaying one. From v13 on, `replay` refuses a newer-format
  cassette before evaluating any assertion. A `semantic_matches` entry carrying `include_fork_results`, or any
  `semantic_pairwise` entry, stamps **v14** (one bump shared with the other keys of this release that an older reader cannot read), so a v13 reader refuses it as
  too new rather than as an unrecognized assertion. The minimum supported read version is **v9**
  (`MIN_SUPPORTED_CASSETTE_VERSION`): a cassette below the floor is refused at load time with a
  re-record error (a pre-1.0 decision — no compatibility is maintained for formats below v9, and
  their schema files are no longer shipped; the retained schema files are `schema/cassette.v9.json`
  through `schema/cassette.v14.json`). A cassette whose stamped version exceeds what a given build understands is
  refused loudly by both `replay` and `verify-cassettes`; `replay` alone offers an opt-in override
  (`--best-effort-future-cassette`), which `verify-cassettes` does not accept — a verification gate has no
  "read it anyway" path. `record --rerecord-stale`'s selection and `rehash`'s own version check accept a
  future-stamped cassette without refusing, since neither produces a pass/fail verdict. Post-1.0, raising
  the read floor past a still-readable version is breaking.
- **Control protocol** — `schema/protocol.v1.json` + the golden control-response vectors (§5).
  Removing or narrowing a described frame is breaking; **DESCRIBING A FRAME THE HARNESS ALREADY
  ANSWERS IS NOT** — it can only make a validator that was rejecting real traffic start accepting it,
  so no working consumer changes behaviour. (The same additive latitude the `verify-cassettes` and
  `doctor` envelopes above are granted. Stated explicitly because its absence here read as a
  prohibition: three subtypes the harness had always answered — `request_user_dialog`, `elicitation`
  and `side_question` — plus the fail-closed `subtype:"error"` envelope went undescribed rather than
  added. A schema that rejects frames the code sends is worse than one that grows.) The golden vector
  pack is coupled: every schema definition must be exercised by a vector, so a new frame ships with
  evidence or not at all.
- **Environment variables** — the documented `COWORK_HARNESS_*` knobs plus `COWORK_AGENT_BINARY` and
  `COWORK_AGENT_IMAGE`. Renaming a documented var or changing its meaning is breaking.
- **Packaged GitHub Action** — `action.yml` inputs (`command`, `path`, `version`, `strict`,
  `fail-on-skill-drift`, `extra-args`, `summary`, `anthropic-api-key`, `model`) and outputs (`ok`,
  `envelope-path`, `summary-md`).

**4.0.0's major changes.** These changes made 4.0.0 a major release, each under the clause named:

- *CLI surface (a flag's default).* Under `lint --strict` the default `--min-severity` is WARN, so INFO
  neither fails nor prints unless `--min-severity INFO` is passed.
- *CLI surface (an exit-code meaning).* `record`'s `--max-budget-usd` refusal exits `1` like its other
  pre-spend refusals (§11); it exited `2` before 4.0.0. `skill`/`run` still exit `2` on that refusal: on `run`/`skill`,
  a `runtime`-category pre-spend refusal also exits `2`, alongside usage errors.
- *Scenario schema (tightened validation).* `fidelity:` is required; before 4.0.0 it defaulted to
  `container`. No exit code changes meaning: a scenario without the key is a loader rejection, so
  `run` (a file or a directory) and `record <file>` exit `2` as for any file that does not load, and
  `record <dir/>` lists it as broken and exits `1`, as for any broken file in a batch (§11). Its knock-on in the
  *`verify-cassettes` envelope*: a cassette's recorded scenario source that the loader rejects is an
  `unverifiable[]` entry (exit `3`), where before 4.0.0 it was a non-failing note, so a gate that is
  green on 3.x can fail on 4.0.0.
- *CLI surface (an invocation 3.x accepted is refused).* A run that resolves no model — no
  `--model`, no matrix `models:` axis, no session `model:`, no `COWORK_HARNESS_MODEL` — is refused before
  it spends; before 4.0.0 it warned and ran on the agent binary's own default. No exit code changes
  meaning: it is a usage error on `run`/`skill`/`probe-dispatch`/`chat`/`critique` (`2`), and on `record`
  a pre-spend refusal of a scenario that loaded (`1`, `--dry-run` included, §11). `skill --dry-run` does
  not refuse; it reports `model: null`. The packaged Action gains an optional `model` input (additive).
- *Environment variables (a documented var's meaning).* `COWORK_HARNESS_OUTPUT_FORMAT=json` selects json
  on every command's success path, not only its error path (§11): `doctor`, `status`, `verify-run`, `vm`,
  `analyze-skill`, `replay`, `verify-cassettes` and `critique` printed human text with the variable set.
- *RunResult envelope (what `ok` means) — `record`.* `record`'s `ok` is "exited 0" in every arm (§11): a
  single-file `--allow-failing` recording of a failing run now says `ok: true` (it said `false`), and
  `record <empty dir/> --dry-run` says `ok: false` (it said `true`, beside exit `2`).
- *Error envelope (category and `results`) — `record`.* A `record` refusal after the run (a failing
  verdict without `--allow-failing`, an assert on an artifact too large to commit (also waived by `--allow-failing`), a quarantined
  inventory finding, or any other error before the cassette is written) has category `runtime`; it was
  `usage`. Its error envelope carries the refused run in `results[0]` beside the non-null `error`, and a
  batch's `failed` item carries `verdict`/`result`; both were absent. The exit code (`1`) is unchanged
  (§11).
- *CLI surface (an exit-code meaning).* `gates <dir>` without `--follow` exits `2` (usage) on a directory
  that does not exist, and `2` (runtime) on a malformed gate request; both exited `0`. A path that is not
  a directory is a usage error with or without `--follow`.
- *CLI surface (an exit-code meaning).* `skill <plugin-folder> … --dry-run` (with or without
  `--ablate-skill`) exits `2` when a declared path does not exist or is the wrong kind; it exited `0` with
  a preview. `record <file> --dry-run` refuses the same paths in its scenario's session, with record's `1`;
  it exited `0`.
- *stdout content under `--output-format json`.* Not strictly a covered envelope, listed so no consumer is
  surprised: `scaffold <run>` prints an envelope carrying the YAML (it printed bare YAML); `skill --dry-run`
  wraps its preview in the standard frame; `lint --help`, `lint-skill --help` and `critique --help` print
  their help on stderr with stdout empty (lint's printed a usage-error document, critique's printed help on
  stdout).

**NOT covered (may change in any release — do NOT depend on):**

- **Human-readable renderer output** — verdict footers, `::notice::` / `::warning::` lines, transcript
  formatting, and the exact text of log/error messages. **Grep-stability of human-readable text is
  explicitly NOT a contract** — assert against the JSON envelope, not stdout text.
- **`trace` row shapes** and other debug/diagnostic output.
- **The `regrade` output file** (`turns/<N>/regrade/<prompt-hash>-<judge-model>-<time>.json`) — its name,
  layout and contents are EXPERIMENTAL and may change in any minor release. The command — its name, flags and
  exit codes — and its JSON envelope (`schema/regrade.json`, including the `regradeFile` key that holds the file's
  path) are covered above.
- **`fixture export`'s JSON payload** — the command, its flags and exit codes are covered; the payload keys are
  experimental and may change in a minor release.
- **The `ref freeze` / `ref verify` JSON payloads and the reference-store layout** (`<store>/<case-id>/ref.json`,
  `doc-<key>.txt`/`.json`) — EXPERIMENTAL. The command — its name, subcommands, flags and exit codes — is covered
  above; the payload keys and the on-disk layout may change in a minor release (a store is read only through `ref`
  and `semantic_pairwise`).
- **`lint-skill` / `analyze-skill` JSON envelopes** (`--output-format json`) — NOT yet frozen. Unlike
  the `doctor`/`verify-cassettes`/RunResult envelopes above, these have no `schema/*.json` and may change
  (fields, rule ids, the artifact-write-back finding shape) while the analyzers stabilize. Parse at your
  own risk until they are promoted to a covered surface.
- **The `critique` report** (`--output-format json` / the `critique-report.json` run-dir artifact) —
  NOT yet frozen, and — uniquely — it DOES have a schema file: `schema/critique-report.json` is
  **descriptive** (authoritative field names/shapes, test-pinned against the builder) so automation can
  parse against a schema rather than prose, but it is NOT this section's compatibility contract —
  critique is EXPERIMENTAL and additive field changes may land in any minor release (the schema's own
  `description` says so). Its presence in the surface-drift baseline is for change *visibility*, not
  coverage. It is the promotion CANDIDATE once critique stabilizes, on the `doctor.json` template.
  `critique --corpus-only`'s preview payload (the `corpus` object above) is the same experimental
  surface — a documented subset of `evidenceBudget`, same field names and meaning — and may change while
  it stabilizes too.
- **The `eval` report** — `report.json` (`schemaVersion: 0`), `report.md`, `manifest.json`, `runs.jsonl` and the
  `arms`/`pins`/`sections`/`summary`/`cost` payload of its JSON envelope — plus its row labels and the defaults of
  its statistical flags (`--reps`, `--alpha`, `--correction`, `--concurrency`, and the `insufficient` threshold) —
  and `--dry-run`'s `plan` payload (`schemaVersion: 0`) apart from `plan.cost`'s covered summary keys above,
  including its estimates, its text, its history window, the 80% power target and its assumed sequential design
  (`implemented: false`). `eval` is EXPERIMENTAL; these are expected to change as the wording and thresholds are
  tuned. The command name, its flags (`--dry-run`, `--target-effect` — which requires `--dry-run` — and
  `--max-budget-usd` included), its `--arm` source grammar, its exit codes (§11), the `budget` marker and
  `error.code` on it (§11), and `--fail-on`'s meaning — no gating unless it is given — are covered.
- **The `hillclimb` flow files beyond the published runner-scaffold contract** — the harness's own row `meta`
  keys, the `out/` copies and sidecars, the `metrics.md` wording and `hillclimb check`'s findings text — and the
  experimental keys of the `--dry-run` `plan.cost` object (`budgetGateWorstUsd`, `judgeMeanUsd`, `judgeP50Usd`, `items`).
  The command name, its flags and defaults, its exit codes (§11), the run envelope's fields and the covered
  `plan.cost` keys are covered, and so is `COWORK_HARNESS_HILLCLIMB_SNAPSHOTS` (an absolute snapshot root; a
  relative value is refused). A trace marks each sub-agent dispatch with a `system` turn saying what that
  child received, from its own transcript only: the harness's sub-agent append (when the child's prompt ends
  with exactly the append the session sent; Anthropic's built-in sub-agent prompt is withheld), "none received",
  or "not recorded in its transcript" when the transcript holds no prompt snapshot. The marker wording is not
  covered.
- **The bundled `scenario.py`'s functions, constants and module layout** — the `lint` / `lint-skill` /
  `scaffold` subcommands (and the CLI's passthroughs to them) are the surface; the script is not an
  importable API, and a consumer that vendors or imports a `_helper` from it is copying an implementation
  detail that may be renamed, re-split or removed in any release. Ask for a subcommand or flag instead —
  `critique --corpus-only` exists because a consumer had vendored two of these to get a number the CLI
  did not expose.
  The same goes for `COWORK_HARNESS_LINT_EXTRA_FINDINGS`, the variable through which `cowork-harness lint`
  hands its scenario-loader findings to the script: an internal handoff, not a knob.
- **`docs/internal/**`** — untracked working notes.
- **The reconstructed system-prompt append text** — a paraphrase by design (see
  [docs/fidelity-gaps.md](./docs/fidelity-gaps.md)); behaviorally equivalent, not byte-stable.
