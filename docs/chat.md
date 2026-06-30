# chat reference

`cowork-harness chat` is an interactive multi-turn REPL for debugging a skill under the full
harness — egress sandbox, control protocol, live model. You type a turn, the agent responds;
gates (permission requests, AskUserQuestion) come to your TTY. There is no scenario file, no
assertions, no cassette — just a live session against the skill you are exploring.

Reach for `chat` when you want to:

- Reproduce a gate or permission flow interactively before scripting it in a scenario.
- Poke a stochastic multi-turn skill across many turns without writing assertions.
- Explore a skill's behaviour to understand what a scenario should assert.

Once you have reproduced a finding, promote it to a `scenarios/*.yaml` with scripted `answers:`
so it becomes a repeatable regression.

## Usage

```
cowork-harness chat <skill-folder> [prompt] [options]
```

| Argument / Flag | Default | Description |
|---|---|---|
| `<skill-folder>` | (required) | Path to the skill directory to load. |
| `[prompt]` | — | Optional seed prompt; injected as the first turn before the REPL opens. |
| `--fidelity protocol\|container\|hostloop` | `container` (or `$COWORK_HARNESS_FIDELITY`) | Runtime tier (see below). |
| `--model <id>` | `$COWORK_HARNESS_MODEL` | Override the model; passed as `--model` to the agent binary. |
| `--upload <file>` | — | Attach a file (repeatable). Visible at `mnt/uploads/<basename>`. |
| `--folder <dir>` | — | Connect a project folder (repeatable). Visible at `mnt/<basename>`. Staged as a **fresh copy** — agent writes land in the run's `mnt/<basename>` output, not back in the host original. |
| `--plugin <dir>` | — | Load an additional local plugin alongside the main skill folder (repeatable). Rejected in `--raw` mode. |
| `--verbose` / `-V` | off | Show thinking blocks, tool inputs, and the full sub-agent tree. Default: tool call markers only. |
| `--run-dir <path>` (global) | `$COWORK_HARNESS_RUNS_DIR` or `~/.cowork-harness/runs` | Relocate the run/transcript output dir. A **global** flag (stripped before the chat parser), so it works on `chat` too. |
| `--raw` | off | Skip the control protocol; spawns `docker run -it` in native cowork mode. Egress sandbox is NOT applied. `--upload`, `--folder`, `--plugin`, and `--fidelity` are **rejected** (they can't be honored in native mode); `--model` is still applied. |

## Fidelity tiers

| Tier | What runs | Use it for |
|---|---|---|
| `protocol` | Agent on the host, no Docker, no sandbox. | Fastest; no egress enforcement. |
| `container` (default) | Agent in a Docker container with per-session default-deny egress proxy. | Everyday debugging with a real sandbox. |
| `hostloop` | Agent runs in the container (like `container`), but native Bash/WebFetch are disabled and routed host-side via the workspace SDK-MCP server — workspace bash executes in the container via `docker exec`, `web_fetch` via host `curl`. | Reproducing Cowork's production split-execution model. |

`container` is the right default for almost all debugging. Use `protocol` when you need rapid
iteration and do not care about egress behavior. Use `hostloop` when you are chasing a bug that
only manifests in the production execution split.

`--raw` is a different escape hatch entirely: it bypasses the harness control protocol and runs
`docker run -it` directly. Because the harness egress sidecar is not attached, network behavior
is unrestricted and does not reflect Cowork's default-deny sandbox. Use it only when you
specifically want unmediated access to the native Cowork agent. `--upload`, `--folder`, `--plugin`,
and `--fidelity` are **rejected** in `--raw` mode (the command exits with a usage error listing them,
rather than silently ignoring them); only `--model` is carried through.

## In-session commands

The REPL prompt reads `type your message (/help for commands)`. The following commands are
available:

| Command | Effect |
|---|---|
| `/help` | Print the list of available in-session commands. |
| `/exit` | End the session and print the transcript path. |
| `/quit` | Alias for `/exit`. |

Ctrl-D (EOF) also terminates the session.

## Mount paths

Files and folders are mounted at the same paths the real Cowork client uses:

| CLI flag | Agent sees |
|---|---|
| `--upload ~/data/report.pdf` | `mnt/uploads/report.pdf` |
| `--folder ~/code/myproject` | `mnt/myproject` |

`--folder` stages a **fresh copy** of the directory into the session tree (not a live bind mount of the
original). Files the agent writes under `mnt/<basename>` land in the run's output there, **not** back in
the corresponding host directory.

### Adding files mid-session

Mid-session attachment is not supported — there is no `/upload` in-session command. To add files
or folders, restart `chat` with the appropriate `--upload` / `--folder` flags. See
[`docs/fidelity-gaps.md`](./fidelity-gaps.md) for the underlying reason.

## Transcript

The session transcript is always written to `~/.cowork-harness/runs/chat/<session-id>/` (relocate with
`--run-dir <path>` or `COWORK_HARNESS_RUNS_DIR`). The path is printed when the session ends. If the
session crashes before the footer prints, the run ID appears in the startup banner
(`cowork chat [<fidelity>] — run: <session-id>`) — use it to find the transcript directory.

To read the transcript as a digest (tool calls, sub-agent dispatches, decisions):

```bash
cowork-harness trace <session-id>               # the run-id form resolves under the runs root, from any dir
cowork-harness trace <session-id> --view tools  # tool calls with summarized inputs (≤100 chars; full inputs live in events.jsonl)
```

There is no `--keep` flag — `chat` always writes the transcript and always keeps it.

## `chat` vs `skill`

| | `chat` | `skill` |
|---|---|---|
| Turns | Multi-turn REPL | One-shot |
| Gates | Answered interactively at the TTY | Scripted answers / decider flags |
| Session ID | Throwaway (minted per invocation) | Supports `--session-id` / `--resume` |
| Assertions | None | Full `assert:` block via scenario |
| Cassette | No | Via the top-level `record` / `replay` subcommands (not `skill` flags) |
| Primary use | Exploring, reproducing flows | CI-style testing, checkpoint/resume |

`chat` does not support `--session-id` or `--resume`. For checkpoint/resume debugging, use
`cowork-harness skill … --session-id … --resume`.

## Example

```bash
cowork-harness chat skills/my-skill \
  --upload ~/data/report.pdf \
  --folder ~/code/myproject \
  "Summarize the PDF"
```

Starts a session with the PDF attached and the project folder connected. The seed prompt is sent
as the first turn; you continue typing follow-up messages. The agent's responses, tool calls, and
any gates appear on your terminal. Type `/exit` when done (or `/help` to see the command list).

To load an additional plugin alongside the skill:

```bash
cowork-harness chat skills/my-skill \
  --plugin plugins/extra-tools \
  "What tools do you have?"
```

The `--plugin` flag is repeatable; each directory is loaded as a local plugin in addition to the
main skill folder.

To use the fastest tier without Docker:

```bash
cowork-harness chat skills/my-skill --fidelity protocol "What tools do you have?"
```

## Relationship to scenarios

`chat` is non-deterministic and produces no copy-pasteable `--answer` footer (unlike `skill`,
which prints one on unscripted gates). Once you have explored a flow and know which gates appear
and what answers they need, express it as a `scenarios/*.yaml` with scripted `answers:` and run
it with `cowork-harness run`. That makes the finding a repeatable, assertable regression.
