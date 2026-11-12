# Discovery: marketplaces, plugins, skills, MCP

The agent the harness runs **is** `claude-code` — the same binary Claude Desktop stages at `claude-code-vm/<ver>/claude` and launches in cowork mode via `CLAUDE_CODE_IS_COWORK=1` (the `--cowork` flag exists only in the staged in-VM binary; the harness uses the env var). So it discovers extensions from the same roots. The harness's job is to *populate those roots* the way Cowork does, while giving you override knobs for tests. The roots below were verified against the staged agent binary.

> **Why this matters for testing, not just for setup.** Because the *binary* does the discovering, a
> triggering test is a test of the real router: the agent sees your `description` alongside every other
> staged skill and decides. That is what `skill_triggered` / `no_skill_triggered` actually check, and
> it is the guard worth running on every `description` edit. If you drive the agent loop yourself
> instead (the Agent SDK), you supply the skill directly — so you are exercising your own dispatcher,
> and a description that would never have been picked in production still passes. Same reason a broken
> plugin manifest shows up here the way it will for a user: the plugin doesn't load, and the skill is
> simply absent from `context.availableSkills`.

> **Most common case:** to mount one local skill for a test you have two equivalent options — put
> `skills.local: ["./skills/my-skill"]` in your session (stages a bare skill folder into the config dir),
> **or** wrap the skill in a local plugin folder and list it under `plugins.local_plugins` (what every bundled
> [worked example](../examples/) does — `examples/sessions/*.yaml`). Either is the whole setup; the rest of
> this doc is the full discovery model + override knobs.

## Discovery roots

| Kind | Real roots | Populated from (session setup) |
|---|---|---|
| **Plugins / marketplaces** | `CLAUDE_CONFIG_DIR/plugins`, `plugin_marketplaces` in settings, + Cowork mounts `mnt/.local-plugins/marketplaces/<marketplace>/<plugin>`, `mnt/.remote-plugins` (unconditional) | `plugins.local_plugins[]` → `.local-plugins/marketplaces/<marketplace>/<plugin>`; `plugins.remote_plugins[]` → `.remote-plugins/plugin_<id>` (migrated-Cowork uploaded/org-remote shape; id = stable hash of the declared source); `plugins.marketplaces[]` → `extraKnownMarketplaces`; `plugins.local_marketplaces[]` → local marketplace dirs whose `marketplace.json` is read and enabled plugins mounted via `--plugin-dir` (the `claude plugin marketplace add` registry is inert in cowork mode); `plugins.enabled[]` → `enabledPlugins` |
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

> **Every tier, `protocol` included.** The agent always reads the run's own config dir, never your `~/.claude`. A fresh config dir holds no login, so the agent needs a credential in the environment or a `.env` — `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or `ANTHROPIC_API_KEY`, or at `protocol` also `ANTHROPIC_AUTH_TOKEN`; a Keychain or `/login` session is not used, and a run without one is refused before it starts. What stays outside the seal: machine-level managed settings (`managed-settings.json`, `managed-mcp.json` in the system location) are not in any config dir, so they still reach an agent that runs on the host (`protocol`, `hostloop`). "Sealed" means user-level config.

## Overriding for tests

| Goal | How |
|---|---|
| Test a single local **skill** dir in isolation | `skills.local: ["./skills/my-skill"]` (staged into the config dir's `skills/`). Use `plugins.local_plugins` instead for a **plugin** root — a dir with `.claude-plugin/plugin.json`, or an Agent Skills repo root with none ([below](#testing-an-agent-skills-repo-no-pluginjson)) — mounted via `--plugin-dir`. |
| Swap an MCP server for a stub | point `mcp.config` at a test `mcp.json` (see `examples/data/mcp.json`) |
| Exercise an org-remote plugin | `plugins.remote_plugins: ["./fixtures/org-plugin"]` |
| Reproduce your installed plugins and skills | `plugins.from_host: true` (or name them). Copied into the run, hashed and recorded; see [session.md](./session.md#your-installed-set-pluginsfrom_host) |
| Disable all discovery | leave the `plugins` / `skills` / `mcp` blocks empty |

A pinned `plugins.config_dir` is **single-run**: the harness creates it (it must not exist yet), marks it with
`.cowork-harness-config-dir`, and reuses it only for the same run's later legs. An existing
directory it did not create — a real Claude config, or another run's — is refused, so the harness never writes into it.
A command that runs the scenario more than once (`run --repeat` above 1, `run --matrix` of more than one cell, `eval`, `hillclimb`) refuses
a pinned `config_dir` before the first run, rather than spending one run and refusing the next. So does a batch
(`run <dir/>`, `record <dir/>`, `record --rerecord-stale`) in which two scenarios pin the same dir; one is fine.

## Testing an Agent Skills repo (no `plugin.json`)

A repo laid out as `skills/<name>/SKILL.md` at its root, with no `.claude-plugin/plugin.json`, needs no wrapper: every
command accepts it as it is. What changes is how you mount it, and each mounting gives the skill a different id:

| You pass | What is mounted | Skill id the agent registers |
|---|---|---|
| `skill <root>`, `plugins.local_plugins: [<root>]`, `chat <root>` | the **whole root** as one plugin, named after the folder | `<folder>:<skill>` |
| `plugins.remote_plugins: [<root>]` | the whole root, staged as `.remote-plugins/plugin_<id>` | `plugin_<id>:<skill>` (the staged directory's name, not the folder's) |
| `chat --raw <root>` | the whole root, staged under a fixed `skill` directory | `skill:<skill>` |
| `skills.local: [<root>/skills/<name>]` | that one skill folder, standalone | `<skill>` |

On the `local_plugins` routes (the first row), with no manifest the plugin name falls back to the folder name, as the
staged agent's does; the other rows name it after their staged directory instead. On every plugin route the whole
root is plugin content: `README.md` and `AGENTS.md` are staged with it, and the agents in a root
`agents/` register under the same plugin name as that route's skills (`<folder>:<agent>` on the `local_plugins`
routes).

- **Commit first.** Inside a git repo the harness stages only git-tracked files (in the index: committed or
  `git add`-ed), so a new, untracked file is not in the run.
- **For Cowork fidelity, add a minimal manifest.** Claude Desktop's plugin install path (its zip install, the one
  traced) refuses a plugin with no `.claude-plugin/plugin.json`, and Desktop writes one for a server-synced plugin
  that lacks it, so on those routes a plugin reaches Cowork's agent with a manifest. A one-line `{"name": "my-skills-repo"}`, with the folder's name, keeps
  the `<folder>:<skill>` id; `remote_plugins` then registers `my-skills-repo:<skill>` as well. The alternative is to
  test the skill standalone through `skills.local`.
- **The static checkers expect the manifest too.** Without one they read the tree as a standalone skill:
  - `lint-skill` warns that `${CLAUDE_PLUGIN_ROOT}` is never replaced (true on `skills.local`; on the plugin routes the
    agent does replace it), calls the repo's own `<folder>:<agent>` another plugin's, and misses a mistyped agent id;
  - `resolve-agent-types <root>` prints no agents;
  - `analyze-skill <root>` scans no markdown file and reports a clean pass, and on `<root>/skills/<name>` it skips the
    root's `agents/`;
  - `critique` leaves an agent referenced as `<folder>:<agent>` out of the graded corpus, and grades a
    `<root>/skills/<name>` path as a bare folder; pass the root instead (with `--skill <name>` when it has several).

  Scenario `lint` is unaffected.

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
