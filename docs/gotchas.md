# Troubleshooting FAQ

## Setup & environment

- **`lint` exits 127.** `python3` isn't on `PATH`. Install it or point `PYTHON` at an interpreter.
- **A local skill folder mounts empty.** Untracked files are invisible to the mount — `git add` the skill
  first (see [README → Test a local skill in one command](../README.md#test-a-local-skill-in-one-command)).
- **`docker build` fails or the agent won't start on Apple Silicon.** Confirm `--platform linux/arm64` is in
  your `docker build` invocation and that Docker Desktop's VM is arm64, not Rosetta-emulated.
- **A git worktree can't find your token.** A worktree's `./.env` is gitignored and absent there even if the
  main checkout has one. Point at it: `cowork-harness --dotenv <path-to-main-checkout>/.env <cmd>`, or run
  `doctor` — it detects this and prints the exact remedy.
- **Reading `doctor`'s output.** Each line is one check: `✓` ok, `✗` fail (blocks the tier), `!` warn
  (works but worth fixing), `·` skipped (not needed for this tier). A `✗`/`!` line prints a `→ remedy`
  right after it — that's the fix, not a generic "something's wrong." Common `✗`s: Node < 20, no
  Docker/container runtime running, the agent image not built, the staged agent binary missing (open
  Cowork Desktop once to stage it), no auth token resolvable, or no platform baseline on disk (`sync`
  on macOS, or restore a `baselines/desktop-*.json`).
- **A `verify-cassettes` run fails on `scenarioDrift` after an intentional scenario edit.** You edited a
  committed scenario's `prompt`, `baseline`, `fidelity`, `answers`, `skills`, or `requires_capabilities`
  without re-recording — the frozen cassette no longer matches the on-disk scenario on one of these six
  recording-shaping fields. Either re-record, or pass `--skip-scenario-drift` if you're intentionally
  verifying the rest of the gate against an out-of-date recording (see [README → Commands at a glance](../README.md#commands-at-a-glance)).

## Skill-authoring & host-loop footguns

- **A skill works in the Claude Code CLI but misbehaves under Cowork's host-loop.** Two common footguns:
  a `${CLAUDE_PLUGIN_ROOT}` path hardcoded into in-VM bash (dead in the host-loop VM — resolve the mount
  at runtime instead), and a hook command that `export`s an env var or writes into `/tmp` (a host-side
  hook write isn't VM-visible to the agent). `cowork-harness lint-skill <SKILL.md | skill-dir>` (also
  runnable directly as `scenario.py lint-skill <SKILL.md | skill-dir>`) scans a skill's body (and any
  sibling `hooks.json`) for both, WARN-only and deliberately narrow (fenced bash/sh/shell code blocks,
  hooks-config JSON, and `Bash(...)` directives only — host-side prose and `Read`/`Grep` directives are
  left alone, so false negatives on unfenced snippets are expected).

- **Harvesting a `critique` run? Read the GRADED turn, not the run dir's root `result.json`.** A
  `critique` writes two turns into one run dir, and the root `result.json` is a compatibility copy of the
  **latest** turn — the *reflection* turn. Its `outcome`/`skillHash` describe the wrong run, and nothing
  about the value looks wrong. Read `result.graded.json` (or `turns/1/result.json`), or take
  `gradedOutcome`/`gradedSkillHash` straight from the critique report.

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
[SKILL.md → Gotchas](../.claude/skills/cowork-harness/SKILL.md#gotchas--the--passed--correct-landmines) or
[debugging.md](./debugging.md#the-run-was-green-but-you-dont-trust-it--hunt-the-false-green).
