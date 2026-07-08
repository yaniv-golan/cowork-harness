# Discovery: marketplaces, plugins, skills, MCP

The agent the harness runs **is** `claude-code` — the same binary Claude Desktop stages at `claude-code-vm/<ver>/claude` and launches in cowork mode via `CLAUDE_CODE_IS_COWORK=1` (the `--cowork` flag exists only in the staged in-VM binary; the harness uses the env var). So it discovers extensions from the same roots. The harness's job is to *populate those roots* the way Cowork does, while giving you override knobs for tests. The roots below were verified against the staged agent binary.

> **Most common case:** to mount one local skill for a test you have two equivalent options — put
> `skills.local: ["./skills/my-skill"]` in your session (stages a bare skill folder into the config dir),
> **or** wrap the skill in a local plugin folder and list it under `plugins.local_plugins` (what every bundled
> [worked example](../examples/) does — `examples/sessions/*.yaml`). Either is the whole setup; the rest of
> this doc is the full discovery model + override knobs.

## Discovery roots

| Kind | Real roots | Populated from (session setup) |
|---|---|---|
| **Plugins / marketplaces** | `CLAUDE_CONFIG_DIR/plugins`, `plugin_marketplaces` in settings, + Cowork mounts `mnt/.local-plugins/marketplaces/<marketplace>/<plugin>` (≥1.14271.0; older baselines use `.local-plugins/cache`), `mnt/.remote-plugins` (unconditional) | `plugins.local_plugins[]` → `.local-plugins/marketplaces/<marketplace>/<plugin>`; `plugins.remote_plugins[]` → `.remote-plugins/plugin_<id>` (migrated-Cowork uploaded/org-remote shape; id = stable hash of the declared source); `plugins.marketplaces[]` → `extraKnownMarketplaces`; `plugins.local_marketplaces[]` → local marketplace dirs whose `marketplace.json` is read and enabled plugins mounted via `--plugin-dir` (the `claude plugin marketplace add` registry is inert in cowork mode); `plugins.enabled[]` → `enabledPlugins` |
| **Skills** | `CLAUDE_CONFIG_DIR/skills`, + skills inside plugins | `skills.local[]` staged into the config dir; plugin skills discovered at the mounts |
| **MCP servers** | `--mcp-config <file>` / `.mcp.json`, `enabledMcpjsonServers` in settings | `mcp.config` → `--mcp-config`; `mcp.enabled[]` → `enabledMcpjsonServers` |

## How the harness wires it

For each run it builds a **clean, hermetic `CLAUDE_CONFIG_DIR`** (under the run dir, unless you pin `plugins.config_dir`) containing a generated `settings.json`:

```json
{
  "enabledPlugins": { "my-skill@local": true },
  "extraKnownMarketplaces": {
    "claude-code": { "source": { "source": "git", "url": "https://github.com/anthropics/claude-code.git" } }
  },
  "enabledMcpjsonServers": ["example-fs"],
  "localAgentModeTrustedFolders": ["/abs/path/to/project"],
  "autoMountFolders": false
}
```

Plugins are bind-mounted at the Cowork paths; the MCP config is passed via `--mcp-config`. Because nothing leaks from your real `~/.claude`, runs are reproducible across machines and CI.

## Overriding for tests

| Goal | How |
|---|---|
| Test a single local **skill** dir in isolation | `skills.local: ["./skills/my-skill"]` (staged into the config dir's `skills/`). Use `plugins.local_plugins` instead only for a **plugin** root — a dir with `.claude-plugin/plugin.json` — mounted via `--plugin-dir`. |
| Reproduce a real `~/.claude` setup | `plugins.config_dir: ~/.claude` (pins the real dir instead of a clean one) [^configdir] |
| Swap an MCP server for a stub | point `mcp.config` at a test `mcp.json` (see `examples/data/mcp.json`) |
| Exercise an org-remote plugin | `plugins.remote_plugins: ["./fixtures/org-plugin"]` |
| Disable all discovery | leave the `plugins` / `skills` / `mcp` blocks empty |

[^configdir]: Writing into an existing pinned `config_dir` is **refused by default** — the harness won't
clobber a real Claude config. Set `COWORK_HARNESS_ALLOW_CONFIG_DIR_WRITE=1` to permit it, or use a managed
(clean) dir with `config_dir: null`.

## What the model actually sees — and how to verify it

Populating the discovery roots is only half the story; the other half is **how a discovered
skill surfaces to the model**. When the Skill tool is available, the agent injects a
system-role reminder (`"The following skills are available for use with the Skill tool:"`)
with one line per skill, rendered as:

```
- ${name}: ${description} - ${whenToUse}
```

So `description` **and** `when_to_use` are both model-visible — joined with ` - `, sharing one
line and one budget. The listing is packed under a shared character budget (~8000 chars by
default, ~1536/skill cap); when it overflows, **every** skill collapses to name-only at once
(no description for any of them). A single bloated `when_to_use` can trigger that global
collapse. The byte-level budget algorithm and constants are documented in the
`claude-code-internals` skill (ref `02-agents-intelligence-interface.md`, an external skill not bundled here) — not restated here.

**To verify what a run's model actually received, read the VM session log, not `events.jsonl`:**

| Want | File |
|---|---|
| The real model context (system reminders, the rendered skill listing, attachments) | `runs/<scenario>/<run>/work/session/mnt/.claude/projects/<proj-slug>/*.jsonl` |
| Harness reconstruction (carries skill `description`, **omits** the rendered listing's `when_to_use`) | `runs/<scenario>/<run>/events.jsonl` |

Grepping `events.jsonl` for skill-listing content (e.g. a `when_to_use` phrase) yields a
**false negative** — the text is there in the model's context, just not in that reconstruction.

`<proj-slug>` is the project-slug directory name Claude Code's own CLI derives from its cwd when
writing session transcripts — this repo only bind-mounts the parent `projects/` dir
(`src/runtime/hostloop-stage.ts`) and never computes or names that subdirectory itself. Don't try
to compute it: `ls runs/<scenario>/<run>/work/session/mnt/.claude/projects/` — there's normally
exactly one entry, so use whatever name is actually there.

## MCP and the host/VM split — a fidelity note

In **real Cowork**, stdio MCP servers run **host-side** (the VM shell is sealed; host MCP servers get the full host env), and the agent reaches them across the VM boundary. This is *the* mechanism for cross-boundary work — a skill that needs a host resource must go through an MCP server.

At the **`container`** tier the harness runs MCP servers **alongside the agent** for simplicity. This faithfully reproduces "the skill must call an MCP server, not a host tool" (the host tools aren't in the container either), but it does **not** reproduce the host-side execution environment of the MCP server itself. This host/VM split is **not reproduced at any harness tier** — at the **`microvm`** tier the MCP server still runs **inside** the guest, the same as `container`. If your skill depends on an MCP server reaching host-only resources, flag it as an unreproduced gap. See [boundary.md](./boundary.md).
