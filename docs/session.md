# Session reference

A **session** (a "session setup", `sessions/*.yaml`) captures everything you configure in Claude Cowork **before the first prompt** of a new session. It's hand-authored, lives in your repo, and is reused across scenarios. It is deliberately separate from the [platform baseline](./maintenance.md) (`baselines/desktop-*.json`), which is auto-synced and describes what Cowork's runtime *is* this release.

> One-line mental model: **platform baseline = the release; session = your setup.**

**Minimal session** — the smallest setup that mounts one skill and pins a model; every field is optional
(a scenario with no `session:` gets an all-defaults inline session):

```yaml
model: claude-opus-4-8
skills:
  local: ["./skills/my-skill"]
```

The full schema below documents every field.

## Full schema

```yaml
# ── model & reasoning (Cowork model picker + toggles) ──────────────────────────
model: claude-opus-4-8           # setModel; omit for the agent default
effort: high                     # setEffort: low | medium | high | xhigh | max (+ `extra`, normalized to xhigh) — validated
                                  # per the resolved model's offered levels (see the field reference below); omit for
                                  # Cowork's medium fallback (real Cowork always emits --effort, never omits it)
extended_thinking: true          # real Cowork on/off toggle (setExtendedThinking); default true (ON) -> --max-thinking-tokens
                                  # 31999, or --thinking disabled when false. No arbitrary budget — always 31999-or-off.
agent_max_turns: 500             # optional turn ceiling -> agent --max-turns; omit for the agent default (distinct from the max_turns ASSERTION)
permission_mode: default         # setPermissionMode: default | acceptEdits | plan | bypassPermissions
permission_parity: cowork        # cowork (unscripted tool calls allowed, Cowork default) | strict (deny unscripted)
account_name: Ada Lovelace       # {{accountName}} in the prompt append's <env> "User name:" line; default "User" (>=1.18286.0 reconstruction)

# ── fenced debug escape hatch (NOT reachable via Cowork's UI) ────────────────────
debug:
  max_thinking_tokens: 50000     # overrides the emitted --max-thinking-tokens budget directly, bypassing
                                 # extended_thinking's on(31999)/off boundary. A run authored with this does
                                 # NOT represent a real Cowork config — real Cowork never emits any budget
                                 # besides 31999 (or no budget, when thinking is off).
  thinking_display: summarized   # emits --thinking-display <summarized|omitted>. Forces readable (never
                                 # raw) thinking TEXT for BOTH the main loop and sub-agents. Real Cowork
                                 # passes NO such flag, so by default the API's per-model default applies
                                 # (omitted on Opus 4.8 / Sonnet 5 → empty thinking text, surfaced as
                                 # {text:"", redacted:true}). Debug-only; diverges from Cowork + costs tokens.

# ── tier-uniform agent-env knob ───────────────────────────────────────────────
agent_env:
  subagent_model: claude-haiku-x            # -> CLAUDE_CODE_SUBAGENT_MODEL
  tool_search: "off"                        # -> ENABLE_TOOL_SEARCH ("auto" | "off"); omit for the binary default (ON)
  disable_experimental_betas: false         # -> CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS="1" when true (also disables ToolSearch)

# ── work folders / projects (Cowork "add folder" / Spaces) → mnt/<folder-name> ──
#    (mount name = collision-resolved folder basename; ≥1.14271.0, older baselines use mnt/.projects/<id>)
folders:
  - { from: ~/code/myproject, mode: rw }    # mounted at mnt/myproject; mode default rw (delete denied, like
                                            # Cowork); use rwd only to model a delete-approved mount
                                            # NOTE: at `fidelity: hostloop`, a rw/rwd folder needs the
                                            # scenario's `allow_host_writes: true` (see scenario.md) —
                                            # hostloop's native file tools have no container around them.
trusted_folders:                 # localAgentModeTrustedFolders (mount without a trust prompt)
  - ~/code/myproject
auto_mount_folders: false        # autoMountFolders

# ── files uploaded before the first prompt → mnt/uploads ───────────────────────
uploads:
  - ~/Downloads/report.pdf

# ── discovery: marketplaces / plugins / skills / mcp ───────────────────────────
plugins:
  config_dir: null               # CLAUDE_CONFIG_DIR; null = harness builds a clean managed dir
  marketplaces:                  # plugin_marketplaces (git URLs or local paths)
    - https://github.com/anthropics/claude-code.git
  local_marketplaces: []         # LOCAL marketplace dirs → registered via `claude plugin marketplace add`
  enabled:                       # enabledPlugins (name@marketplace)
    - my-skill@local
  local_plugins:                 # host plugin dirs → mnt/.local-plugins/marketplaces/<marketplace>/<plugin>
                                 #   (≥1.14271.0; older baselines use mnt/.local-plugins/cache)
    - ./skills/my-skill
  remote_plugins: []             # uploaded / org-remote plugin dirs → mnt/.remote-plugins/plugin_<id> (migrated-Cowork shape)
skills:
  local: []                      # extra host skill dirs → CLAUDE_CONFIG_DIR/skills
mcp:
  config: null                   # --mcp-config file (standard mcpServers map), e.g. ../data/mcp.json
  enabled: []                    # enabledMcpjsonServers

# ── network (Cowork egress, pre-prompt) ────────────────────────────────────────
egress:
  extra_allow: []                # added to the synced allowlist for this session (bash/Path-B web_fetch)
  unrestricted: false            # true == Cowork "*" (allow all)

# ── web_fetch (TEST CONVENIENCE — not a real Cowork setting) ────────────────────
web_fetch:
  approved_domains: []           # pre-approve these hosts for the run — simulates the in-session effect of
                                 # clicking "Allow all for website" (seeds Run.approvedDomains), but for THIS
                                 # run only: the set starts empty every run (Cowork has no persistent
                                 # pre-approval). A web_fetch to a listed host raises no approval gate.
                                 # (web_fetch's real gate is the URL provenance set, seeded from URLs you
                                 # put in the prompt — see boundary.md.)

# ── staleness fingerprint scope ──────────────────────────────────────────────────
staleness:
  hash_ignore: []                # gitignore-style globs for paths that DON'T affect recorded behavior
                                 # (e.g. [tests/, docs/, "**/*.md"]) — editing them won't re-stale a
                                 # cassette. Glob forms, hard-exclusions, and per-skill scoping: see
                                 # "Staleness hash_ignore globs" below.
```

### Staleness `hash_ignore` globs

`hash_ignore` globs are matched against each mounted skill/plugin dir's **root-relative** path:

| Form | Matches |
|---|---|
| `tests` / `tests/` | a `tests` entry at ANY depth (bare name; trailing slash optional) |
| `/tests` | anchored to the mount root only (leading slash = root-relative) |
| `docs/api` | a root-anchored path with a slash component |
| `**/tests` | explicit any-depth (same as bare `tests`) |
| `**/*.md` | any `.md` at any depth |

The cassette-staleness hash skips ignored paths, so editing them no longer re-stales cassettes. The
harness also **hard-excludes** universally-non-runtime paths: VCS/caches/cassettes, the `plugin.json`
`version` field, and (v5+) OS-junk (`.DS_Store` / `Thumbs.db` / `desktop.ini`) — so a Finder touch can't
re-stale a cassette. A plugin's own runtime boundary (and any run-generated files a skill writes into its
own dir) are yours to declare here or in a plugin-local `.cowork-hashignore` file at the mount root. For
per-skill scoping in a multi-skill plugin, set `skills: [<name>]` on the **scenario** (see scenario.md /
cassette.md); opt-in `COWORK_HARNESS_AGENT_SCOPE=skill` further scopes a skill-named `agents/<name>.md` to
that skill instead of the shared root.

## Field reference

### Model & reasoning
| Field | Type | Cowork control | Notes |
|---|---|---|---|
| `model` | string | model picker | e.g. `claude-opus-4-8`. Omit to use the agent default. |
| `effort` | enum | effort selector | Accepts `low` \| `medium` \| `high` \| `xhigh` \| `max` \| `extra` (`extra` is the UI label for `xhigh` — normalized to `xhigh` on load). Validated against the *resolved* model's per-model config in the platform baseline (`spawn.effortByModel` / `spawn.effortRegexDefault`), per Cowork's four model classes: a **picker model** (e.g. `claude-opus-4-8`) must use one of its offered levels, else this is a load-time error naming them; a **no-effort model** (`claude-haiku-4-5`, `claude-sonnet-4-5` — no picker in the Cowork UI at all) rejects an explicit `effort:` outright; a **regex-default model** (the fable/mythos family) validates against that class's levels; an **unrecognized/omitted model** accepts any of the six tokens with no per-model check. Omit `effort:` entirely to get Cowork's flat `medium` fallback (binary-verified: real Cowork always emits `--effort`, defaulting to `medium` rather than the model's UI-only `recommended`, for every class — it never omits the flag). Passed as the `--effort` CLI flag (the `CLAUDE_EFFORT` env var is a no-op). |
| `extended_thinking` | boolean | extended thinking toggle | Real, honored, **default `true` (ON)** — binary-verified (`setExtendedThinking(sessionId, enabled)`). ON resolves to the fixed `DEFAULT_MAX_THINKING_TOKENS` budget (`31999`) → `--max-thinking-tokens 31999`; OFF → `--thinking disabled`. No arbitrary N — real Cowork is always 31999-or-off. Delivered as a CLI flag only; there is **no** `MAX_THINKING_TOKENS` env in real Cowork. See `debug.max_thinking_tokens` for a fenced, non-Cowork way to emit an arbitrary budget. |
| `agent_max_turns` | number | turn ceiling | a positive integer → the agent's `--max-turns` (early-exits after N agentic turns). Omit for the agent's own default — faithful to interactive Cowork, which passes no `--max-turns` (only scheduled tasks default to 100). **Distinct from the `max_turns` assertion**, which is a post-hoc upper-bound *check*, not a ceiling *setter*. |
| `permission_mode` | enum | permission mode | `default` \| `acceptEdits` \| `plan` \| `bypassPermissions` → `--permission-mode`. |
| `permission_parity` | enum | (harness policy) | `cowork` (default) \| `strict`. `cowork` mirrors Cowork's permission default — unscripted tool calls are allowed; `strict` denies any tool call that no scripted answer / decider covers. Affects the harness `Decider`, not a Cowork control. |
| `account_name` | string | signed-in account name | Rendered into the prompt append's `<env>` "User name:" line (`{{accountName}}`, ≥1.18286.0 reconstruction). Real Cowork uses the signed-in account's name; defaults to `"User"` when unset. |
| `debug.max_thinking_tokens` | number | *(none — harness-only escape hatch)* | **NOT reachable via Cowork's UI.** A fenced override that emits `--max-thinking-tokens <N>` verbatim, bypassing `extended_thinking`'s on(31999)/off boundary. A positive integer only (0/negative rejected). A run authored with this does not represent a real Cowork config — use it only for targeted local testing. |
| `debug.thinking_display` | `"summarized"` \| `"omitted"` | *(none — harness-only escape hatch)* | **NOT reachable via Cowork's UI.** Emits `--thinking-display <mode>`. `"summarized"` forces readable (never raw — the API returns no chain-of-thought) thinking TEXT for BOTH the main loop and sub-agents; `"omitted"` forces the empty-text mode. Omitted ⇒ no flag ⇒ the API's per-model default applies (`"summarized"` on Sonnet 4.6, `"omitted"` on Opus 4.8 / Sonnet 5, where thinking text comes back empty → `RunResult.thinking` / `subagents[].reasoning` mark it `redacted:true`). Real Cowork passes no such flag; a run authored with this diverges from Cowork and costs extra tokens — local debugging only. |

> **Removed:** the old numeric/per-model `max_thinking_tokens` field is gone — a session YAML that still
> sets it fails to load with a targeted hint pointing at `extended_thinking` / `debug.max_thinking_tokens`.

### Agent-env knob (tier-uniform)

`hostloop` and `protocol` spawn the agent over the **operator's full shell env** (`...process.env` /
`{...plan.baseEnv}`), while `container`/`microvm` build a **constructed allowlist**. Left alone, that means
an operator-exported `CLAUDE_CODE_SUBAGENT_MODEL`, `ENABLE_TOOL_SEARCH`, or
`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` silently affects only the two env-inheriting tiers — the exact
same session behaves differently depending on which fidelity tier you run it at. `agent_env` is the
authored, uniform replacement: it applies across **all four execution tiers**
(`protocol`/`container`/`microvm`/`hostloop`; `fidelity: cowork` resolves to one of them), and the three
keys above are additionally **scrubbed from the operator layer** on `hostloop`/`protocol` (the only tiers
that inherit one) before any baseline/knob overlay — so a stray shell value can never leak through on some
tiers and not others.

| Field | Type | Env key | Notes |
|---|---|---|---|
| `agent_env.subagent_model` | string | `CLAUDE_CODE_SUBAGENT_MODEL` | Binary precedence: env > dispatch param > frontmatter > inherit — this knob outranks a subagent's own `model:` frontmatter. |
| `agent_env.tool_search` | enum | `ENABLE_TOOL_SEARCH` | `"auto"` \| `"off"`. **Naming trap:** unset (key absent) is binary mode `tst` — ToolSearch is **ON** first-party by default. There is no `"standard"` value to set here; the binary's own `"standard"` mode name means **DISABLED**, not "the standard/default mode" — `tool_search: "off"` is the correct way to disable it, emitting `ENABLE_TOOL_SEARCH="off"` (the binary's actual disable spelling). |
| `agent_env.disable_experimental_betas` | boolean | `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` | `true` emits `"1"`; also disables ToolSearch as a side effect on the binary side. Omit/`false` emits no key. |

**Precedence is tier-qualified** (not a single uniform three-layer rule):

- `hostloop` / `container` / `microvm` (each layers a baseline `spawn.env`): **knob > baseline spawn.env
  > operator env (scrubbed)**.
- `protocol` (no baseline-env overlay — it spawns from `{...plan.baseEnv}` only): the two-layer **knob >
  operator env (scrubbed)**.

An unset `agent_env` field emits no key at all (never an empty string) — the agent falls back to its own
default for that key. Setting any `agent_env` field moves the session-**shape** fingerprint (the
`verify-cassettes` drift channel — see cassette.md), so a knob change stales a cassette recorded before it,
instead of silently replaying the pre-knob env behavior forever. A session with no `agent_env` (the
default `{}`) hashes identically to one authored before this field existed.

### Folders, projects, uploads
| Field | Maps to | Mounted at |
|---|---|---|
| `folders[]` | "add folder" / Spaces | `mnt/<folder-name>` (collision-resolved basename; ≥1.14271.0, older baselines use `.projects/<id>`) |
| `trusted_folders[]` | `localAgentModeTrustedFolders` | (settings.json; mount without prompt) |
| `auto_mount_folders` | `autoMountFolders` | (settings.json) |
| `uploads[]` | pre-prompt file upload | `mnt/uploads/<basename>` |

For an ad-hoc `skill` run (no session file), the CLI flags **`--upload <file>`** and **`--folder <dir>`**
are the equivalents of `uploads[]` and `folders[]`.

`folders[].mode` is `r` \| `rw` \| `rwd` (read / read-write / read-write-delete), matching Cowork's per-mount grants. (There is no `to:` field — the mount name is always derived from the folder basename, collision-resolved; `.projects` is now only a reserved name.) Enforcement: `r` mounts get a per-mount `:ro` bind on the Docker tiers, so writes fail in the guest; the `rw` vs `rwd` delete-deny distinction is not yet mount-enforced (post-hoc `no_delete_in_outputs` + the planned FUSE delete-deny sub-project — see [boundary.md](./boundary.md)).

### Discovery
See [discovery.md](./discovery.md) for the full model. In short: the harness builds a clean `CLAUDE_CONFIG_DIR` with a generated `settings.json`, mounts plugins at the Cowork paths, and wires `--mcp-config` — every field here is an override knob.

| Field | Maps to | Notes |
|---|---|---|
| `plugins.marketplaces[]` | `plugin_marketplaces` / `extraKnownMarketplaces` | git URLs or local paths. |
| `plugins.local_marketplaces[]` | `claude plugin marketplace add` | LOCAL marketplace dirs (each holds a `marketplace.json`); plugins they reference are mounted. The `skill --marketplace` flag is the ad-hoc equivalent. |
| `plugins.enabled[]` | `enabledPlugins` | `name@marketplace`. |
| `plugins.local_plugins[]` / `remote_plugins[]` | Cowork plugin mounts | → `mnt/.local-plugins/marketplaces/<marketplace>/<plugin>` (≥1.14271.0; older baselines use `.local-plugins/cache`) / `mnt/.remote-plugins/plugin_<id>` (migrated-Cowork uploaded/org-remote shape; the id is a stable hash of the declared source). A skill that references these via `${CLAUDE_PLUGIN_ROOT}` must mind [the two-namespace resolution model](./plugin-root.md) — the token is unset in host-loop VM bash. |
| `skills.local[]` | `CLAUDE_CONFIG_DIR/skills` | extra host **skill** dirs (a folder *without* `.claude-plugin/plugin.json`) staged into the config dir's `skills/`. Use this for a single-skill folder; use `plugins.local_plugins` for a plugin root. |
| `mcp.config` / `mcp.enabled[]` | `--mcp-config` / `enabledMcpjsonServers` | the supported way to attach an MCP server to a session under test. |

> Inside a git repo, `folders[]` and `skills.local[]` stage only **git-tracked** files into the mount (matching
> real Cowork's install-from-repo behavior) — an untracked skill mounts empty. The **content** staged is the
> working tree, so uncommitted edits to a tracked file are tested without committing; but commit before
> recording the locking cassette, since real Cowork ships the committed tree. See
> [README → Test a local skill in one command](../README.md#test-a-local-skill-in-one-command).

### Egress
`extra_allow` adds hosts to the release allowlist for this session; `unrestricted: true` reproduces Cowork's `"*"` (allow-all). The allowlist is enforced at `container`/`microvm`/`hostloop` fidelity (and `cowork`, which resolves to one of those) — only `protocol` has no egress boundary; see [boundary.md](./boundary.md).

## Path expansion

`~` expands to your home directory. **Relative paths resolve from the session file's own directory** — so a scenario + its session + the files they reference form a self-contained, relocatable bundle that `run` resolves the same way from any working directory. (A scenario's `session:` likewise resolves relative to the *scenario* file.) Absolute paths and `~` are used as-is. Paths passed as CLI args instead — `skill --upload/--folder` — resolve from your current working directory, since you typed them in your shell.

## Tips

- Keep **one session per realistic setup** (e.g. `sessions/sales.yaml`, `sessions/clinical.yaml`) and point many scenarios at each.
- To reproduce a *specific* real Cowork setup, pin `plugins.config_dir` to a copy of that `~/.claude` instead of letting the harness build a clean one.
- Omit `model` in committed sessions if you want CI to track the agent default; pin it when a test depends on a specific model's behavior.
