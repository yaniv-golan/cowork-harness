# `${CLAUDE_PLUGIN_ROOT}` — one token, two namespaces

A skill references its own bundled files through `${CLAUDE_PLUGIN_ROOT}`. The token means **different
things depending on WHERE it is evaluated**, and getting this wrong is a common Cowork authoring
footgun — most often a bare `$CLAUDE_PLUGIN_ROOT` in a shell step, which is empty in Cowork's in-VM shell,
or a plugin path handed through the shell to a host-side file tool.

This is an authoring guide: it describes the **observable behavior** a skill author must design around.

## The rule

> **Host-side file tools (`Read`/`Grep`) → the braced token resolves to the plugin's files. Correct everywhere.**
> **In-VM `bash` → the braced `${CLAUDE_PLUGIN_ROOT}` works when the shell or a program it runs opens the
> path; the bare `$CLAUDE_PLUGIN_ROOT` does not.**
> **The exception:** a value the VM step only forwards to a host-side file tool arrives there as a VM
> path, which host-side tools refuse at host-loop (see [below](#a-value-you-forward-to-a-host-side-file-tool)).

### Host-side reads — correct in every tier

When your skill body tells the agent to **read** a bundled reference — a `Read` or `Grep` directive in the
prose, e.g.

> Read `${CLAUDE_PLUGIN_ROOT}/references/pricing.md` before answering.

— the token resolves to the plugin's files and the read succeeds in **every** fidelity tier. This is the
correct, common idiom for a skill to consult its own references, and the `lint-skill` linter (below)
deliberately leaves it alone.

### In-VM bash — what the shell receives

When your skill runs **shell** — a ` ```bash ` step or a `Bash(...)` directive — the token is a different
story:

- **In a plugin skill, the shell never sees the braced token.** The agent replaces the literal
  `${CLAUDE_PLUGIN_ROOT}` with a path in the skill's TEXT when the skill loads, so the model runs the
  command with that path already written in. Which path depends on the loop mode. At **VM-loop** it is
  the plugin's mount under `/sessions/<slug>/mnt/…`. At **host-loop** (Cowork's default) it is a HOST
  path, and Cowork's bash tool rewrites it to the plugin's `/sessions/<slug>/mnt/…` mount before the
  command runs (Desktop 1.40609.0 and later), so `bash ${CLAUDE_PLUGIN_ROOT}/scripts/build.sh` works in
  both. The rewrite matches the host path as a whole word: bare, inside an opening quote, or with its
  spaces escaped or quoted. It does not match when the path is glued to other text:
  `${CLAUDE_PLUGIN_ROOT}-v2`, `${CLAUDE_PLUGIN_ROOT}:…`, `x${CLAUDE_PLUGIN_ROOT}` and
  `file://${CLAUDE_PLUGIN_ROOT}` keep the host path, which does not exist in the VM. Keep the path its own
  word, followed by `/`, whitespace, a quote or the end of the command. The rewrite changes only the
  command that runs: the transcript shows the host path, and a path the command prints is the VM path.
  It is also skipped for a plugin whose VM mount path has a character outside letters, digits, `.`, `_`,
  `-` and `/` (a mount name with a space, say).
- **Only the braced form is replaced.** A bare `$CLAUDE_PLUGIN_ROOT` (or `${CLAUDE_PLUGIN_ROOT:-…}`) is left
  for the shell, which reads the environment variable, and at host-loop that is empty in the VM shell. In a
  skill that is not part of a plugin nothing is replaced, so the braced form expands empty there too.
- **A plugin hook command is different.** The agent substitutes the token when it runs the hook and also
  sets the variable, so a hook gets a path valid where it runs: on the host at host-loop, in the VM at
  VM-loop. `lint-skill` does not flag the token in a hook command.
- The plugin's files ARE present in the VM — they are bind-mounted under the session's
  `mnt/.local-plugins/…` (the local-uploads channel, or a marketplace plugin) or
  `mnt/.remote-plugins/plugin_<id>` (a plugin installed through Cowork's UI, or an org-remote one). Where
  the braced token is not available — a bare `$CLAUDE_PLUGIN_ROOT`, a skill outside a plugin, a path
  built by gluing text onto the root — **discover the mount** instead:

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
script writes the value into a sub-agent's prompt and the sub-agent `Read`s files under it. At host-loop
this breaks whenever the path is rewritten: Cowork's bash tool rewrites the host path in the command to
the plugin's `/sessions/…` mount, so the script receives, and forwards, a VM path, and a host-loop
sub-agent's `Read` refuses a `/sessions/…` path. At VM-loop the path and the sub-agent's file tools are
both in the VM, and it works. Measured on Desktop 2.19675.0: a sub-agent handed the forwarded path is
refused on `Read`, while one that names `${CLAUDE_PLUGIN_ROOT}` in its own definition reads the file.

So do not pass the plugin root through bash for a host-side reader. Let the reader name
`${CLAUDE_PLUGIN_ROOT}` in its own text instead: a plugin agent's definition (`agents/<name>.md`) has the
token in its body substituted with the plugin's path when the agent loads — a host path at host-loop,
which its `Read` can open. A task prompt the model writes is not substituted.

The line shape alone does not tell this case apart from a program that opens the path itself.
`python3 tool.py --data-dir "${CLAUDE_PLUGIN_ROOT}/data"` works at host-loop, because the program opens
the rewritten VM path; the difference is in what the receiving program does with the value, which the
skill text does not show. `lint-skill` reports the whole root passed as the value of an option named for a location (`root`, `dir`, `path`, `plugin` or `base` in its name) — the usual forwarding shape — as a WARN,
and every other braced use as an INFO (see
[Catch both before a paid run](#catch-both-before-a-paid-run)).

## How the tiers map

The harness reproduces host-loop and VM-loop plugin staging as two distinct mount layouts (different
guest paths, different staging mechanism). Pick a scenario `fidelity` to exercise the staging layout you
care about.

| Fidelity tier | Resolution mode | Braced `${CLAUDE_PLUGIN_ROOT}` in a plugin skill | Bare `$CLAUDE_PLUGIN_ROOT` in the VM shell |
|---|---|---|---|
| `hostloop` | host-loop | replaced at load with a HOST path; the bash tool rewrites it to the plugin's VM mount before the command runs (baselines from 1.40609.0) | **empty** (observed in real Cowork's local lane) |
| `container` / `microvm` | VM-loop analog (agent runs in the VM) | replaced at load with the plugin's VM mount path | the harness sets no value; a single live probe of real Cowork's VM-loop saw it set to a `/sessions/…/mnt/.remote-plugins/…` path that belonged to ANOTHER plugin in the session, so it is not this plugin's root; not re-verified since |

In a VM shell step, use the braced `${CLAUDE_PLUGIN_ROOT}` as a word of its own, or discover the mount
as shown above. Never rely on the bare `$CLAUDE_PLUGIN_ROOT`: it is empty at host-loop, and its value
at VM-loop rests on one observation.

A bare `$CLAUDE_SKILL_DIR` is empty in the in-VM shell at host-loop too. The braced `${CLAUDE_SKILL_DIR}`
is substituted with a path under the plugin, so a bash command that uses it as its own word is rewritten
like `${CLAUDE_PLUGIN_ROOT}`. Do not convert a host path into a VM path yourself by keeping its suffix:
the harness's host path happens to share the VM path's `/mnt/.local-plugins/…` suffix and real Cowork's
does not, so a conversion that runs on a path the bash tool did not rewrite — one read from a file or a
tool result, say — passes here and fails in Cowork (see [fidelity-gaps.md](./fidelity-gaps.md#hostloop-the-substituted-plugin-path-shares-the-vm-paths-suffix-real-coworks-does-not)).

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

It reports the plugin root in an in-VM bash context (fenced `bash`/`sh` blocks and `Bash(...)`
directives): a bare `$CLAUDE_PLUGIN_ROOT`, or any form in a standalone skill with no `plugin.json` above it
(nothing replaces the token there), as the WARN `plugin-root-in-vm-bash`; the whole braced root passed as
the value of an option named for a location (`root`, `dir`, `path`, `plugin` or `base` in its name), outside quotes and not to `claude` itself, as the WARN
`plugin-root-forwarded-from-vm-bash`, the forwarding shape above;
and any other braced use as the INFO `plugin-root-braced-in-vm-bash`, whose message says when the rewrite
applies and when a forwarded value breaks. It also warns on a hook
that exports an env var / writes `/tmp` for the in-VM agent — while leaving correct host-side
`Read`/`Grep` references untouched. It is a narrow, heuristic v1 (see its `--help` for the documented
limits), so treat a clean result as "no *obvious* footgun," not a proof.

**A reviewed site** is suppressed in place, with the reason, by wrapping the whole fence in markers (a
marker inside the fence is ignored). For example, an option that takes the plugin root and opens files
under it, which the forwarding WARN cannot tell from a forward:

````markdown
<!-- lint-skill: ignore-start plugin-root-forwarded-from-vm-bash: build.py opens the templates under --root itself -->
```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/build.py" --root "${CLAUDE_PLUGIN_ROOT}"
```
<!-- lint-skill: ignore-end -->
````

The finding is still printed, marked as suppressed with your reason, and stops failing `--strict`. Every
other site in the skill keeps reporting, so the next forwarded value is not hidden. The full syntax, `--ignore-rule` for run-wide decisions such as an accepted size cap, and
`--suppressions <file>` for reviewed sites listed outside the skill (no `SKILL.md` edit, so no cassette goes
stale), are in the [CLI guide](./cli.md#flags-worth-knowing).

**Plain `lint-skill` (no `--strict`) is advisory-only** — it prints these findings but exits 0. CI should
run `lint-skill --strict path/to/skill/` to actually gate on them (this also gates on the provable
in-plugin `subagent_type` typo — see [subagents.md](./subagents.md#static-subagent_type-resolution-resolve-agent-types--lint-skill)).

- **Another WARN, `guard-pattern-mismatch`:** the mount-discovery self-heal pattern above ([recovering
  a lost `${CLAUDE_PLUGIN_ROOT}`](#in-vm-bash--what-the-shell-receives)) recovers the mount by
  `find`-ing it at runtime by a `-path` glob naming the skill/plugin — but a copy-pasted glob that
  actually names a *different* skill's or plugin's directory silently fails to discover THIS skill's
  own mount instead. `lint-skill` extracts the `-path` glob's skill/plugin/scripts-segment token and
  compares it against the SKILL.md's own frontmatter `name:` (or parent-directory name) and its
  enclosing plugin name, warning when they don't match.

See also [session.md](./session.md) (plugin mounts), [scenario.md](./scenario.md) (fidelity tiers), and
[subagents.md](./subagents.md) (the same env-var-absence rule as it applies to a dispatched sub-agent's
own tool set).
