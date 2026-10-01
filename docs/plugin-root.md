# `${CLAUDE_PLUGIN_ROOT}` — one token, two namespaces

A skill references its own bundled files through `${CLAUDE_PLUGIN_ROOT}`. The token means **different
things depending on WHERE it is evaluated**, and getting this wrong is the single most common Cowork
authoring footgun — a skill that works in the Claude Code CLI silently breaks under Cowork's in-VM
shell at host-loop, Cowork's default.

This is an authoring guide: it describes the **observable behavior** a skill author must design around.

## The rule

> **Host-side file tools (`Read`/`Grep`) → the token resolves to the plugin's files. Correct everywhere.**
> **In-VM `bash` → do NOT rely on the token. Discover the mount at runtime instead.**
> **The one exception:** a value the VM step only forwards to a host-side file tool (see
> [below](#a-value-you-forward-to-a-host-side-file-tool)).

### Host-side reads — correct in every tier

When your skill body tells the agent to **read** a bundled reference — a `Read` or `Grep` directive in the
prose, e.g.

> Read `${CLAUDE_PLUGIN_ROOT}/references/pricing.md` before answering.

— the token resolves to the plugin's files and the read succeeds in **every** fidelity tier. This is the
correct, common idiom for a skill to consult its own references, and the `lint-skill` linter (below)
deliberately leaves it alone.

### In-VM bash — the token is NOT reliable

When your skill runs **shell** — a ` ```bash ` step or a `Bash(...)` directive — the token is a different
story:

- **In a plugin skill, the shell never sees the braced token.** The agent replaces the literal
  `${CLAUDE_PLUGIN_ROOT}` with a path in the skill's TEXT when the skill loads, so the model runs the
  command with that path already written in. Which path depends on the loop mode: at **host-loop**
  (Cowork's default) it is a HOST staging path that does not exist inside the VM, so
  `bash ${CLAUDE_PLUGIN_ROOT}/scripts/build.sh` runs a script path the VM does not have and fails; at
  **VM-loop** it is the plugin's mount under `/sessions/<slug>/mnt/…`, which does exist. Quoting and
  argument position make no difference: the shell is handed a finished string.
- **Only the braced form is replaced.** A bare `$CLAUDE_PLUGIN_ROOT` (or `${CLAUDE_PLUGIN_ROOT:-…}`) is left
  for the shell, which reads the environment variable, and at host-loop that is empty in the VM shell. In a
  skill that is not part of a plugin nothing is replaced, so the braced form expands empty there too.
- **A plugin hook command is different.** The agent substitutes the token when it runs the hook and also
  sets the variable, so a hook gets a path valid where it runs: on the host at host-loop, in the VM at
  VM-loop. `lint-skill` does not flag the token in a hook command.
- The plugin's files ARE present in the VM — they are bind-mounted under the session's
  `mnt/.local-plugins/…` (the local-uploads channel, or a marketplace plugin) or
  `mnt/.remote-plugins/plugin_<id>` (a plugin installed through Cowork's UI, or an org-remote one). So the
  fix is to **discover the mount**, not to depend on the env var:

  ```bash
  # derive the plugin root from the script's own location, when the script lives inside the plugin:
  PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
  # or search both plugin mounts for this skill's own SKILL.md:
  SKILL_MD="$(find /sessions/*/mnt/.local-plugins /sessions/*/mnt/.remote-plugins \
    -path '*/skills/<skill-name>/SKILL.md' 2>/dev/null | head -1)"
  SKILL_DIR="${SKILL_MD%/SKILL.md}"          # …/skills/<skill-name>
  PLUGIN_ROOT="${SKILL_DIR%/skills/*}"        # assumes the usual <plugin>/skills/<skill-name>/ layout
  ```

  **Search by the skill's own path, not by the plugin's directory name.** An installed plugin's directory
  is named by its id (`.remote-plugins/plugin_<id>`), never by the plugin name, so a `find … -name
  '<plugin-name>'` matches nothing for it. A local plugin sits deeper
  (`.local-plugins/marketplaces/<marketplace>/<plugin>/…`, or `.local-plugins/cache/<marketplace>/<plugin>/<version>/…`
  for a marketplace plugin), so keep `-maxdepth` off, or loose enough to reach
  `<plugin>/skills/<skill-name>/SKILL.md` from there. The `-path '*/skills/<skill-name>/…'` form is also
  the one `lint-skill` checks against the skill's own name (the `guard-pattern-mismatch` WARN below). If
  two plugins in one session ship a skill with the same name, match on something only yours has — a
  `.claude-plugin/plugin.json` whose `name` is your plugin's, for example.

  The scenario key decides which of the two layouts a harness run reproduces: `remote_plugins:` mounts a
  plugin the way Cowork serves one installed through its UI (`.remote-plugins/plugin_<id>`), and
  `local_plugins:` mounts it through Cowork's local-uploads channel, two directory levels deeper
  (`.local-plugins/marketplaces/local-desktop-app-uploads/<plugin>`). To test a skill that will ship as an
  installed plugin, declare it under `remote_plugins:` — see [session.md](./session.md).

### A value you forward to a host-side file tool

Some skills pass the plugin root through a VM step only so that it ends up in text a host-side tool
reads. For example, `python3 build_prompt.py --plugin-root-agent "${CLAUDE_PLUGIN_ROOT}"`, where the
script writes the value into a sub-agent's prompt and the sub-agent `Read`s files under it. That works in
both modes: at host-loop the sub-agent's `Read` is a host-side file tool and the host path is exactly
right (a `/sessions/…` path is denied there), and at VM-loop the path and the sub-agent's file tools are
both in the VM. Do not "fix" it with mount discovery, which would hand a host-loop sub-agent a VM path it
cannot read.

The line shape alone does not tell the two cases apart. `python3 tool.py --data-dir
"${CLAUDE_PLUGIN_ROOT}/data"`, where the script opens the directory itself, is broken at host-loop; the
difference is in what the receiving program does with the value, which the skill text does not show. So
`lint-skill` warns on both, and a site you have checked is suppressed with a reason (see
[Catch both before a paid run](#catch-both-before-a-paid-run)).

## How the tiers map

The harness reproduces host-loop and VM-loop plugin staging as two distinct mount layouts (different
guest paths, different staging mechanism). Pick a scenario `fidelity` to exercise the staging layout you
care about.

| Fidelity tier | Resolution mode | Braced `${CLAUDE_PLUGIN_ROOT}` in a plugin skill | Bare `$CLAUDE_PLUGIN_ROOT` in the VM shell |
|---|---|---|---|
| `hostloop` | host-loop | replaced at load with a HOST path, which does not exist in the VM | **empty** (observed in real Cowork's local lane) |
| `container` / `microvm` | VM-loop analog (agent runs in the VM) | replaced at load with the plugin's VM mount path | the harness sets no value; a single live probe of real Cowork's VM-loop saw it set to a `/sessions/…/mnt/.remote-plugins/…` path that belonged to ANOTHER plugin in the session, so it is not this plugin's root; not re-verified since |

Because real Cowork runs host-loop by default, and the bare variable's value at VM-loop rests on one
observation, **author for the mount-discovery pattern unconditionally**: never let a VM shell step open a
path built from `${CLAUDE_PLUGIN_ROOT}`; discover the mount, as shown above.

`CLAUDE_SKILL_DIR` is empty in the in-VM shell at host-loop too, and the path the agent substitutes into the skill's
text does not help: at host-loop it is a HOST path, which does not exist in the VM. Do not rewrite it
into a VM path by its suffix either — the harness's host path happens to share the VM path's
`/mnt/.local-plugins/…` suffix, but real Cowork's does not, so that rewrite passes here and fails in
Cowork (see [fidelity-gaps.md](./fidelity-gaps.md#hostloop-the-substituted-plugin-path-shares-the-vm-paths-suffix-real-coworks-does-not)).

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

It warns on `${CLAUDE_PLUGIN_ROOT}` in an in-VM bash context (fenced `bash`/`sh` blocks and `Bash(...)`
directives; the message says which of the two forms above you wrote and what happens to it) and on a hook
that exports an env var / writes `/tmp` for the in-VM agent — while leaving correct host-side
`Read`/`Grep` references untouched. It is a narrow, heuristic v1 (see its `--help` for the documented
limits), so treat a clean result as "no *obvious* footgun," not a proof.

**A reviewed forwarding site** ([above](#a-value-you-forward-to-a-host-side-file-tool)) is suppressed in
place, with the reason, by wrapping the whole fence in markers (a marker inside the fence is ignored):

````markdown
<!-- lint-skill: ignore-start plugin-root-in-vm-bash: the value only lands in the sub-agent's prompt, for its Read -->
```bash
python3 "$S/build_prompt.py" --plugin-root-agent "${CLAUDE_PLUGIN_ROOT}"
```
<!-- lint-skill: ignore-end -->
````

The finding is still printed, marked as suppressed with your reason, and stops failing `--strict`. Every
other `plugin-root-in-vm-bash` site in the skill keeps warning, so the next real `--data-dir` bug is not
hidden. The full syntax, `--ignore-rule` for run-wide decisions such as an accepted size cap, and
`--suppressions <file>` for reviewed sites listed outside the skill (no `SKILL.md` edit, so no cassette goes
stale), are in the [CLI guide](./cli.md#flags-worth-knowing).

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
