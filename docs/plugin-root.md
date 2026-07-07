# `${CLAUDE_PLUGIN_ROOT}` — one token, two namespaces

A skill references its own bundled files through `${CLAUDE_PLUGIN_ROOT}`. The token means **different
things depending on WHERE it is evaluated**, and getting this wrong is the single most common Cowork
authoring footgun — a skill that works in the Claude Code CLI silently breaks in Cowork's host-loop VM.

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

- In the **host-loop** runtime, the in-VM shell has `CLAUDE_PLUGIN_ROOT` **unset**. A line like
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

The harness reproduces two resolution modes; pick a scenario `fidelity` to exercise the one you care about.

| Fidelity tier | Resolution mode | In-VM bash sees `${CLAUDE_PLUGIN_ROOT}` |
|---|---|---|
| `hostloop` | host-loop | **unset** — discover the mount at runtime |
| `container` / `microvm` | VM-loop analog (agent runs in the VM) | the bind-mounted plugin path |

Because host-loop is the stricter of the two (the token is unset there), **author for host-loop** and the
skill works in both: never hardcode `${CLAUDE_PLUGIN_ROOT}` in a VM shell step; discover the mount.

## A second, related footgun: host-side hooks

A `SessionStart` (or any) hook that runs **host-side** and tries to seed state for the in-VM agent — e.g.
`export SOME_VAR=…` or writing a `/tmp/...` file — silently no-ops in Cowork: the host write is not visible
inside the VM. (It works in the CLI, which is why it slips through.) Do the setup **inside** the VM instead
(in the skill body, or a script the agent runs), not in a host hook.

## Catch both before a paid run

The bundled linter flags both antipatterns from a skill's source, before you spend a live Cowork run:

```bash
python3 .claude/skills/cowork-harness/scripts/scenario.py lint-skill path/to/skill/
```

It warns on `${CLAUDE_PLUGIN_ROOT}` used as a path in an in-VM bash context (fenced `bash`/`sh` blocks,
`hooks.json` command values, `Bash(...)` directives) and on a hook that exports an env var / writes `/tmp`
for the in-VM agent — while leaving correct host-side `Read`/`Grep` references untouched. It is a narrow,
heuristic v1 (see its `--help` for the documented limits), so treat a clean result as "no *obvious*
footgun," not a proof.

See also [session.md](./session.md) (plugin mounts) and [scenario.md](./scenario.md) (fidelity tiers).
