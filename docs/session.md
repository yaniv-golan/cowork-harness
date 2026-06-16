# Session reference

A **session** (a "session setup", `sessions/*.yaml`) captures everything you configure in Claude Cowork **before the first prompt** of a new session. It's hand-authored, lives in your repo, and is reused across scenarios. It is deliberately separate from the [platform baseline](./maintenance.md) (`baselines/desktop-*.json`), which is auto-synced and describes what Cowork's runtime *is* this release.

> One-line mental model: **platform baseline = the release; session = your setup.**

## Full schema

```yaml
# ── model & reasoning (Cowork model picker + toggles) ──────────────────────────
model: claude-opus-4-8           # setModel; omit for the agent default
effort: high                     # setEffort: low | medium | high | xhigh
max_thinking_tokens: 31999       # thinking budget: a number, or a per-model map {default, <model>: <n>}; default 31999
permission_mode: default         # setPermissionMode: default | acceptEdits | plan | bypassPermissions
permission_parity: cowork        # cowork (unscripted tool calls allowed, Cowork default) | strict (deny unscripted)

# ── work folders / projects (Cowork "add folder" / Spaces) → mnt/.projects/<id> ─
folders:
  - { from: ~/code/myproject, to: proj1, mode: rw }    # to=basename; mode default rw (delete denied, like
                                                       # Cowork); use rwd only to model a delete-approved mount
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
  local_plugins:                 # host plugin dirs → mnt/.local-plugins/cache (marketplace-style)
    - ./skills/my-skill
  remote_plugins: []             # host plugin dirs → mnt/.remote-plugins (org-remote-style)
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
  approved_domains: []           # pre-approve these hosts for the run, as if "Allow all for website" was
                                 # clicked earlier this session (seeds Run.approvedDomains). Per-run only —
                                 # Cowork has no persistent pre-approval. A web_fetch to a listed host
                                 # raises no approval gate. (web_fetch's real gate is the URL provenance
                                 # set, seeded from URLs you put in the prompt — see boundary.md.)
```

## Field reference

### Model & reasoning
| Field | Type | Cowork control | Notes |
|---|---|---|---|
| `model` | string | model picker | e.g. `claude-opus-4-8`. Omit to use the agent default. |
| `effort` | enum | effort selector | `low` \| `medium` \| `high` \| `xhigh`. Passed as the `--effort` CLI flag (the `CLAUDE_EFFORT` env var is a no-op). |
| `max_thinking_tokens` | number \| map | thinking budget | a flat **positive integer**, or a per-model map `{ default, <model>: <n> }` of them (0/negative are rejected, #33), resolved per-model (Cowork's `f7e`) and emitted as `MAX_THINKING_TOKENS`. Default `31999` (binary-verified `DEFAULT_MAX_THINKING_TOKENS`). The `extended_thinking` bool is inert — not a real Cowork toggle; use this field. |
| `permission_mode` | enum | permission mode | `default` \| `acceptEdits` \| `plan` \| `bypassPermissions` → `--permission-mode`. |
| `permission_parity` | enum | (harness policy) | `cowork` (default) \| `strict`. `cowork` mirrors Cowork's permission default — unscripted tool calls are allowed; `strict` denies any tool call that no scripted answer / decider covers. Affects the harness `Decider`, not a Cowork control. |

### Folders, projects, uploads
| Field | Maps to | Mounted at |
|---|---|---|
| `folders[]` | "add folder" / Spaces | `mnt/.projects/<to>` |
| `trusted_folders[]` | `localAgentModeTrustedFolders` | (settings.json; mount without prompt) |
| `auto_mount_folders` | `autoMountFolders` | (settings.json) |
| `uploads[]` | pre-prompt file upload | `mnt/uploads/<basename>` |

For an ad-hoc `skill` run (no session file), the CLI flags **`--upload <file>`** and **`--folder <dir>`**
are the equivalents of `uploads[]` and `folders[]`.

`folders[].mode` is `r` \| `rw` \| `rwd` (read / read-write / read-write-delete), matching Cowork's per-mount grants. Enforcement: `r` mounts get a per-mount `:ro` bind on the Docker tiers (#23), so writes fail in the guest; the `rw` vs `rwd` delete-deny distinction is not yet mount-enforced (post-hoc `no_delete_in_outputs` + the planned #9-A FUSE sub-project — see [boundary.md](./boundary.md)).

### Discovery
See [discovery.md](./discovery.md) for the full model. In short: the harness builds a clean `CLAUDE_CONFIG_DIR` with a generated `settings.json`, mounts plugins at the Cowork paths, and wires `--mcp-config` — every field here is an override knob.

| Field | Maps to | Notes |
|---|---|---|
| `plugins.marketplaces[]` | `plugin_marketplaces` / `extraKnownMarketplaces` | git URLs or local paths. |
| `plugins.local_marketplaces[]` | `claude plugin marketplace add` | LOCAL marketplace dirs (each holds a `marketplace.json`); plugins they reference are mounted. The `skill --marketplace` flag is the ad-hoc equivalent. |
| `plugins.enabled[]` | `enabledPlugins` | `name@marketplace`. |
| `plugins.local_plugins[]` / `remote_plugins[]` | Cowork plugin mounts | → `mnt/.local-plugins/cache` / `mnt/.remote-plugins`. |
| `mcp.config` / `mcp.enabled[]` | `--mcp-config` / `enabledMcpjsonServers` | the supported way to attach an MCP server to a session under test. |

### Egress
`extra_allow` adds hosts to the release allowlist for this session; `unrestricted: true` reproduces Cowork's `"*"` (allow-all). The allowlist is enforced at `container`/`microvm` fidelity — see [boundary.md](./boundary.md).

## Path expansion

`~` expands to your home directory. **Relative paths resolve from the session file's own directory** — so a scenario + its session + the files they reference form a self-contained, relocatable bundle that `run` resolves the same way from any working directory. (A scenario's `session:` likewise resolves relative to the *scenario* file.) Absolute paths and `~` are used as-is. Paths passed as CLI args instead — `skill --upload/--folder` — resolve from your current working directory, since you typed them in your shell.

## Tips

- Keep **one session per realistic setup** (e.g. `sessions/sales.yaml`, `sessions/clinical.yaml`) and point many scenarios at each.
- To reproduce a *specific* real Cowork setup, pin `plugins.config_dir` to a copy of that `~/.claude` instead of letting the harness build a clean one.
- Omit `model` in committed sessions if you want CI to track the agent default; pin it when a test depends on a specific model's behavior.
