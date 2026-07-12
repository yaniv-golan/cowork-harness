# `${CLAUDE_PLUGIN_ROOT}` — one token, two namespaces

A skill references its own bundled files through `${CLAUDE_PLUGIN_ROOT}`. The token means **different
things depending on WHERE it is evaluated**, and getting this wrong is the single most common Cowork
authoring footgun — a skill that works in the Claude Code CLI silently breaks under Cowork's in-VM
shell, on every fidelity tier.

This is an authoring guide: it describes the **observable behavior** a skill author must design around.

## The rule

> **Host-side file tools (`Read`/`Grep`) → the token resolves to the plugin's files. Correct everywhere.**
> **In-VM `bash` → do NOT rely on the token. Discover the mount at runtime instead.**

### Host-side reads — correct in every tier

When your skill body tells the agent to **read** a bundled reference — a `Read` or `Grep` directive in the
prose, e.g.

> Read `${CLAUDE_PLUGIN_ROOT}/references/pricing.md` before answering.

— the token resolves to the plugin's files and the read succeeds in **every** fidelity tier. This is the
correct, common idiom for a skill to consult its own references, and the `lint-skill` linter (below)
deliberately leaves it alone.

### In-VM bash — the token is NOT reliable

When your skill runs **shell** — a ` ```bash ` step, a `Bash(...)` directive, or a hook command — the token
is a different story:

- On **every** fidelity tier, the in-VM shell has `CLAUDE_PLUGIN_ROOT` **unset**. A line like
  `bash ${CLAUDE_PLUGIN_ROOT}/scripts/build.sh` expands to `bash /scripts/build.sh` (or an empty path) and
  fails. The agent's own plugin-hook self-heal recovers by **discovering** the mount at runtime, but a
  hardcoded `${CLAUDE_PLUGIN_ROOT}` path in *your* script does not get that treatment.
- The plugin's files ARE present in the VM — they are bind-mounted under the session's
  `mnt/.local-plugins/…` (marketplace/local plugins) or `mnt/.remote-plugins/plugin_<id>` (uploaded /
  org-remote plugins). So the fix is to **discover the mount**, not to depend on the env var:

  ```bash
  # derive the plugin root from the script's own location, or search the session mount:
  PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"              # if the script lives inside the plugin
  # or, when you only know the plugin name:
  PLUGIN_ROOT="$(find /sessions/*/mnt/.*-plugins -maxdepth 3 -type d -name '<plugin-name>' | head -1)"
  ```

## How the tiers map

The harness reproduces host-loop and VM-loop plugin staging as two distinct mount layouts (different
guest paths, different staging mechanism), but the token's behavior in a Bash-tool subprocess is
identical on both: unset. Pick a scenario `fidelity` to exercise the staging layout you care about.

| Fidelity tier | Resolution mode | In-VM bash sees `${CLAUDE_PLUGIN_ROOT}` |
|---|---|---|
| `hostloop` | host-loop | **unset** — discover the mount at runtime |
| `container` / `microvm` | VM-loop analog (agent runs in the VM) | **unset** — the plugin's files ARE present at the bind-mounted path, but not via this env var; discover the mount at runtime |

The env var is absent from a Bash-tool subprocess on **every** tier, not just host-loop — a plugin's
own file references resolve because the agent substitutes the path directly into the plugin's prompt
TEXT when the definition loads, not because any tier's shell inherits `CLAUDE_PLUGIN_ROOT`. Because the
token is unset everywhere in-VM bash actually runs, **author for the mount-discovery pattern
unconditionally**: never hardcode `${CLAUDE_PLUGIN_ROOT}` in a VM shell step; discover the mount, as
shown above.

## A second, related footgun: host-side hooks

A `SessionStart` (or any) hook that runs **host-side** and tries to seed state for the in-VM agent — e.g.
`export SOME_VAR=…` or writing a `/tmp/...` file — silently no-ops in Cowork: the host write is not visible
inside the VM. (It works in the CLI, which is why it slips through.) Do the setup **inside** the VM instead
(in the skill body, or a script the agent runs), not in a host hook.

## Catch both before a paid run

The bundled linter flags both antipatterns from a skill's source, before you spend a live Cowork run:

```bash
cowork-harness lint-skill path/to/skill/
```

(also runnable directly as `python3 .claude/skills/cowork-harness/scripts/scenario.py lint-skill path/to/skill/`)

It warns on `${CLAUDE_PLUGIN_ROOT}` used as a path in an in-VM bash context (fenced `bash`/`sh` blocks,
`hooks.json` command values, `Bash(...)` directives) and on a hook that exports an env var / writes `/tmp`
for the in-VM agent — while leaving correct host-side `Read`/`Grep` references untouched. It is a narrow,
heuristic v1 (see its `--help` for the documented limits), so treat a clean result as "no *obvious*
footgun," not a proof.

**Plain `lint-skill` (no `--strict`) is advisory-only** — it prints these WARNs but exits 0. CI should
run `lint-skill --strict path/to/skill/` to actually gate on them (this also gates on the provable
in-plugin `subagent_type` typo — see [subagents.md](./subagents.md#static-subagent_type-resolution-resolve-agent-types--lint-skill)).

- **A third WARN, `guard-pattern-mismatch`:** the mount-discovery self-heal pattern above ([recovering
  a lost `${CLAUDE_PLUGIN_ROOT}`](#in-vm-bash--the-token-is-not-reliable)) recovers the mount by
  `find`-ing it at runtime by a `-path` glob naming the skill/plugin — but a copy-pasted glob that
  actually names a *different* skill's or plugin's directory silently fails to discover THIS skill's
  own mount instead. `lint-skill` extracts the `-path` glob's skill/plugin/scripts-segment token and
  compares it against the SKILL.md's own frontmatter `name:` (or parent-directory name) and its
  enclosing plugin name, warning when they don't match.

See also [session.md](./session.md) (plugin mounts), [scenario.md](./scenario.md) (fidelity tiers), and
[subagents.md](./subagents.md) (the same env-var-absence rule as it applies to a dispatched sub-agent's
own tool set).
