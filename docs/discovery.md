# Discovery: marketplaces, plugins, skills, MCP

The agent the harness runs **is** `claude-code` — the same binary Claude Desktop stages at `claude-code-vm/<ver>/claude` and launches in cowork mode via `CLAUDE_CODE_IS_COWORK=1` (there is no `--cowork` flag). So it discovers extensions from the same roots. The harness's job is to *populate those roots* the way Cowork does, while giving you override knobs for tests. The roots below were verified against the staged agent binary.

## Discovery roots

| Kind | Real roots | Populated from (session setup) |
|---|---|---|
| **Plugins / marketplaces** | `CLAUDE_CONFIG_DIR/plugins`, `plugin_marketplaces` in settings, + Cowork mounts `mnt/.local-plugins/cache`, `mnt/.remote-plugins` | `plugins.local_plugins[]` → `.local-plugins/cache`; `plugins.remote_plugins[]` → `.remote-plugins`; `plugins.marketplaces[]` → `extraKnownMarketplaces`; `plugins.enabled[]` → `enabledPlugins` |
| **Skills** | `CLAUDE_CONFIG_DIR/skills`, + skills inside plugins | `skills.local[]` staged into the config dir; plugin skills discovered at the mounts |
| **MCP servers** | `--mcp-config <file>` / `.mcp.json`, `enabledMcpjsonServers` in settings | `mcp.config` → `--mcp-config`; `mcp.enabled[]` → `enabledMcpjsonServers` |

## How the harness wires it

For each run it builds a **clean, hermetic `CLAUDE_CONFIG_DIR`** (under the run dir, unless you pin `plugins.config_dir`) containing a generated `settings.json`:

```json
{
  "enabledPlugins": ["my-skill@local"],
  "extraKnownMarketplaces": ["https://github.com/anthropics/claude-code.git"],
  "enabledMcpjsonServers": ["example-fs"],
  "localAgentModeTrustedFolders": ["/abs/path/to/project"],
  "autoMountFolders": false
}
```

Plugins are bind-mounted at the Cowork paths; the MCP config is passed via `--mcp-config`. Because nothing leaks from your real `~/.claude`, runs are reproducible across machines and CI.

## Overriding for tests

| Goal | How |
|---|---|
| Test a single local skill in isolation | `plugins.local_plugins: ["./skills/my-skill"]`, nothing else |
| Reproduce a real `~/.claude` setup | `plugins.config_dir: ~/.claude` (pins the real dir instead of a clean one) |
| Swap an MCP server for a stub | point `mcp.config` at a test `mcp.json` (see `examples/data/mcp.json`) |
| Exercise an org-remote plugin | `plugins.remote_plugins: ["./fixtures/org-plugin"]` |
| Disable all discovery | leave the `plugins` / `skills` / `mcp` blocks empty |

## MCP and the host/VM split — a fidelity note

In **real Cowork**, stdio MCP servers run **host-side** (the VM shell is sealed; host MCP servers get the full host env), and the agent reaches them across the VM boundary. This is *the* mechanism for cross-boundary work — a skill that needs a host resource must go through an MCP server.

At the **`container`** tier the harness runs MCP servers **alongside the agent** for simplicity. This faithfully reproduces "the skill must call an MCP server, not a host tool" (the host tools aren't in the container either), but it does **not** reproduce the host-side execution environment of the MCP server itself. This host/VM split is **not reproduced at any harness tier** — at the **`microvm`** tier the MCP server still runs **inside** the guest, the same as `container`. If your skill depends on an MCP server reaching host-only resources, flag it as an unreproduced gap. See [boundary.md](./boundary.md).
