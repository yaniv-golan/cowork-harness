# Troubleshooting FAQ

> **Start here when stuck:** a run misbehaved, or CI is green and you don't trust it → [debugging.md](./debugging.md) (the investigation loop + the false-green hunt). Skill-*authoring* landmines → the companion skill's gotchas catalog ([references/gotchas.md](../.claude/skills/cowork-harness/references/gotchas.md)). This page is the setup + authoring FAQ — symptom-keyed, skimmable.

## Setup & environment

- **`baseline agent binary not found` — a Desktop update pruned the ELF your scenario pins.** A Desktop
  update deletes the previous version's staged payload while often leaving an EMPTY version directory
  behind, so a `baseline:` pinning that agent version now resolves to nothing. `doctor` does not catch
  this: it validates the agent for its OWN current baseline, not the one each scenario pins, so it can
  print `✓ ready for container` seconds before the run dies. Four remedies, and they are NOT
  equivalent:
  - **Recover the pinned ELF.** The only remedy that keeps the exact pin: re-download that version from
    the release channel, check its sha256 against the baseline's, and set `COWORK_AGENT_BINARY` to it
    ([maintenance.md → Recovering an old agent version](./maintenance.md#recovering-an-old-agent-version)).
    Do the sha check yourself: an override makes the harness's own check advisory. This is what the error
    message points at.
  - **Repin `baseline:` to a version you actually have.** `cowork-harness list` does NOT answer this — it enumerates the baseline
    definitions shipped with the harness, which are present whatever Desktop pruned locally, so a pruned
    pin lists as healthy. Check the staged binary itself (note `stagedPath` is `~`-prefixed, and the
    pruned case leaves the DIRECTORY behind, so only the file test discriminates):

    ```bash
    python3 -c "import json,os;d=json.load(open('baselines/desktop-X.Y.Z.json'));\
    p=os.path.expanduser(d['agentBinary']['stagedPath']);print(os.path.isfile(p))"
    ```
    Correct for a
    reproducibility-bound suite — you keep an exact pin, you just move it deliberately and can say which
    agent the run used.
  - **`baseline: latest`.** Correct for a one-off capture or an inner loop. It never rots, but it drifts:
    the run silently follows whatever Desktop last staged, so two runs a month apart are not comparable.
    A hard pin and `latest` have OPPOSITE failure modes — a pin rots silently, `latest` drifts silently.
  - **`COWORK_HARNESS_ALLOW_AGENT_FALLBACK=1`.** Last resort. It runs the newest sibling binary instead
    of the pinned one, which is exactly the substitution the hard failure exists to prevent, and the sha
    check downgrades to advisory. Use it to get unblocked once, never in CI, and never when the answer
    depends on which agent version ran.
- **`Staged NATIVE agent binary not found` at `hostloop`.** The message says why, and `doctor --tier
  hostloop` gives the remedy for that cause. Claude Desktop 2.19675.0 stages the native agent per build,
  `claude-code/<ver>/<build>/claude.app/…`; the harness reads that layout and the older flat one. A pinned
  version Desktop replaced with a same-major.minor patch runs with a stderr note and no env var. A
  major/minor change, or a different build of a pinned build, needs `COWORK_HARNESS_ALLOW_AGENT_FALLBACK=1`.
  A build dir whose `.verified` marker is missing or names another build is skipped, and the message says
  which. If your
  Claude runs on your organization's infrastructure, Desktop stages nothing locally: set
  `COWORK_HOST_AGENT_BINARY` to a native agent binary.
- **`lint` exits 127.** `python3` isn't on `PATH`. Install it or point `PYTHON` at an interpreter.
- **A local skill folder loses its untracked files — and is REFUSED outright if nothing is tracked.**
  Untracked files are invisible to the mount, and zero tracked files is a hard failure rather than an
  empty mount (`src/session.ts`, the zero-tracked-files `BoundaryError`) — `git add` the skill
  first (see [docs/cli.md → Test a local skill in one command](./cli.md#test-a-local-skill-in-one-command)).
- **`docker build` fails or the agent won't start on Apple Silicon.** Confirm `--platform linux/arm64` is in
  your `docker build` invocation and that Docker Desktop's VM is arm64, not Rosetta-emulated.
- **A git worktree can't find your token.** A worktree's `./.env` is gitignored and absent there even if the
  main checkout has one. Point at it: `cowork-harness --dotenv <path-to-main-checkout>/.env <cmd>`, or run
  `doctor` — it detects this and prints the exact remedy.
- **Reading `doctor`'s output.** Each line is one check: `✓` ok, `✗` fail (blocks the tier), `!` warn
  (works but worth fixing), `·` skipped (not needed for this tier). A `✗`/`!` line prints a `→ remedy`
  right after it — that's the fix, not a generic "something's wrong." Common `✗`s: Node < 22, no
  Docker/container runtime running, the agent image not built, the staged agent binary missing (open
  Cowork Desktop once to stage it), no auth token resolvable, or no platform baseline on disk (`sync`
  on macOS, or restore a `baselines/desktop-*.json`).
- **A `verify-cassettes` run fails on `scenarioDrift` after an intentional scenario edit.** You edited a
  committed scenario's `prompt`, `baseline`, `fidelity`, `answers`, `skills`, or `requires_capabilities`
  without re-recording — the frozen cassette no longer matches the on-disk scenario on one of these six
  recording-shaping fields. Either re-record, or pass `--skip-scenario-drift` if you're intentionally
  verifying the rest of the gate against an out-of-date recording (see [docs/cli.md → Commands at a glance](./cli.md#commands-at-a-glance)).

## Operational tools when you're stuck

- **Is a background run still alive?** `cowork-harness status <run-id | run-dir> [--follow]` checks
  without `ps aux` — see [run-status.md](./run-status.md#cowork-harness-status-run-id--run-dir---follow).
- **Run history missing or looks wrong?** `cowork-harness stats --reindex` rebuilds `index.jsonl` by
  walking the on-disk run-dir tree — see [stats.md](./stats.md#--reindex-the-migration-path).
- **Not sure the sandbox actually isolates anything?** `cowork-harness boundary-check` proves the
  Docker sandbox against a given baseline — see [boundary.md](./boundary.md#verifying-the-boundary-holds).
- **A trace/tool-output path shows a VM path instead of a real one?** A run's `mounts.json` records the
  mount → host-path mapping that `trace --translate-paths` reads to print host paths for a `hostloop`
  run — see [run-status.md](./run-status.md#mountsjson--a-runs-vm-path-resolution-context).
- **`result.json`'s `models` contains `<synthetic>` (or another `<…>` value)?** Not a model, and not a
  harness string: the agent stamps `<synthetic>` on assistant messages it fabricates **locally** — no API
  call, zero-filled `usage` — and the harness records model ids verbatim. It is normal alongside a real id
  (`["claude-sonnet-5", "<synthetic>"]`) and is not a sign the run used a stub or a fixture. Drop every
  `<…>`-wrapped entry before reading the array as run provenance; comparing two runs without doing so can
  show a "model change" that is only a difference in whether a synthesized turn occurred.
- **An old run dir predates the per-turn `turns/<N>/` layout?** `cowork-harness migrate-run-dir`
  converts it in place (dry run by default; pass `--write` to apply) — see
  [debugging.md](./debugging.md#old-run-dirs-pre-turns-layout).

## Skill-authoring & host-loop footguns

- **A skill works in the Claude Code CLI but misbehaves under Cowork.** Two common footguns:
  a `${CLAUDE_PLUGIN_ROOT}` path opened from in-VM bash — at host-loop the agent has already replaced it
  with a HOST path the VM does not have, and a bare `$CLAUDE_PLUGIN_ROOT` is empty there
  (see [plugin-root.md](./plugin-root.md); resolve the mount at runtime instead) — and a hook command
  that `export`s an env var or writes into `/tmp` (a host-side
  hook write isn't VM-visible to the agent). `cowork-harness lint-skill <SKILL.md | skill-dir>` (also
  runnable directly as `scenario.py lint-skill <SKILL.md | skill-dir>`) scans a skill's body (and any
  sibling `hooks.json`) for both, WARN-only and deliberately narrow (fenced bash/sh/shell code blocks and
  `Bash(...)` directives for the first, hooks-config JSON for the second — host-side prose and
  `Read`/`Grep` directives are left alone, so false negatives on unfenced snippets are expected).

- **Harvesting a `critique` run? Read the GRADED turn (`turns/1/`), not `turns/2/`.** A `critique` writes
  two turns into one run dir — the task turn (`turns/1/`) and the reflection turn (`turns/2/`) — with no
  root compat copy of either. Reading `turns/2/result.json` by habit (e.g. "the result.json") describes the
  wrong run, and nothing about the value looks wrong. Read `result.graded.json` (or `turns/1/result.json`),
  or take `gradedOutcome`/`gradedSkillHash` straight from the critique report.

- **Iterating a skill across fixes? Don't cross-pair generations.** When you run the same skill before
  and after a fix and later harvest the runs (pairing each turn's `result.json` with a critique), it is easy to
  pair a *pre-fix* result with a *post-fix* critique and draw a conclusion against the wrong run. The
  guard is already in every `run`/`skill` run that mounts a skill or plugin: `fingerprint.skillHash` is
  content-exact and changes on any tracked edit, so **group/pair on it** (a short prefix is on the
  run-index row and in `cowork-harness inspect`). A run that mounts nothing records no `skillHash`.
  Add `--label <tag>` for a human-readable generation name, and timestamp/keep run dirs so a harvest step
  can order them. `verify-run` warns when a kept run predates the current skill. Full recipe:
  [debugging.md → Iterating a skill across fixes](./debugging.md#iterating-a-skill-across-fixes--the-verification-loop).

For the false-green ("✓ passed ≠ correct") landmine catalog, see
[the skill's gotchas catalog](../.claude/skills/cowork-harness/references/gotchas.md#gotchas--the--passed--correct-landmines) or
[debugging.md](./debugging.md#the-run-was-green-but-you-dont-trust-it--hunt-the-false-green).
