# CI recipe — replay vs live lanes

Self-contained reference. Tracks `cowork-harness 0.1.0` (baseline `desktop-1.12603.1`).

## The core split: token-free PR gate + live nightly

The harness has two execution lanes with different cost and coverage. Place assertions accordingly
(see the replay-class section of `scenario-schema.md`):

- **`replay` (token-free, spawn-free).** Replays a recorded cassette (`events.jsonl` +
  `control-out.jsonl`). No model tokens, no Docker. Evaluates **content** assertions only
  (`transcript_*`, `tool_*`, `subagent_*`, `dispatch_count_max`, `result`; plus the gate keys
  `question_asked` / `questions_count_max` / `gate_answers_delivered` **if** the cassette has
  `controlOut`). Filesystem/egress assertions are **silently skipped**. This is your **always-on PR
  gate**.
- **`run` / `record` (live).** Spawns the real agent in a sandbox: real model tokens + Docker.
  Evaluates **every** assertion, including filesystem/egress/boundary. This is your **nightly /
  pre-release job**.

The cardinal rule: **a replay PR gate cannot verify an artifact's content or any boundary** — it has
no filesystem and no network. Don't let a green replay gate convince you the deliverable is correct.
Run the bundled `scenario.py lint` in CI to catch a scenario that put a filesystem/egress-only check
on the replay lane (a silent no-op). Author new scenarios with `scenario.py scaffold` so they start
from a valid, self-linted skeleton.

## Recording a cassette

```bash
cowork-harness record scenarios/my-test.yaml      # live run that also writes the cassette
cowork-harness replay scenarios/my-test.yaml      # token-free re-evaluation of content assertions
```

Re-record whenever the protocol or your scenario's expected content changes. An old cassette without
`controlOut` excludes the gate keys (with a loud warning) — re-record to enable them.

## Four-stage pipeline

A typical skill repo runs four stages, fastest/cheapest first:

1. **Unit** — your skill's own tests (pytest/vitest of its scripts). Not the harness's job.
2. **Boundary / lint** — `python3 scripts/scenario.py lint scenarios/*.yaml` (no-silent-false-green
   invariants) + `cowork-harness boundary-check` where relevant. Token-free.
3. **Scenarios (replay)** — `cowork-harness replay scenarios/` on every PR. Token-free; content +
   structure + gate delivery.
4. **Parity / live (nightly)** — `cowork-harness run scenarios/` with a token + Docker; full
   filesystem/egress/boundary coverage. Optionally `cowork-harness sync` drift checks against a new
   Desktop release.

## GitHub Actions sketch

PR gate (token-free — runs on every push):

```yaml
name: cowork-skill-pr
on: [pull_request]
jobs:
  replay:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm i -g cowork-harness
      - run: python3 .claude/skills/cowork-harness/scripts/scenario.py lint scenarios/*.yaml
      - run: cowork-harness replay scenarios/ --output-format json
```

Nightly live job (needs a token + Docker; gate it on a secret so forks don't fail):

```yaml
name: cowork-skill-nightly
on:
  schedule: [{ cron: '0 7 * * *' }]
jobs:
  live:
    runs-on: macos-14            # arm64, for the container/microvm tiers
    if: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN != '' }}
    steps:
      - uses: actions/checkout@v4
      - run: npm i -g cowork-harness
      - run: cowork-harness run scenarios/ --output-format json
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

Keep the token in CI **secrets**, never in a `.env` inside a mounted skill/folder (it would be copied
into the sandbox).

## Reading results in CI

`--output-format json` emits a machine envelope on stdout (human output goes to stderr):
`{tool, version, command, ok, results[], error}` — one `RunResult` per scenario. Overall pass for a
scenario = `result === "success" && assertions.every(pass)`. Exit code is non-zero if any assertion
fails or a run errors, so a plain `cowork-harness run scenarios/` is already CI-ready without parsing
JSON.

A run writes `runs/<name>/<sessionId>/` with `events.jsonl`, `control-out.jsonl`, `run.jsonl`,
`trace.json`, `egress.log`, `result.json`. Digest one with `cowork-harness trace <run-id | dir>`.
Secrets are scrubbed from every persisted log by value.

## Don't assume a fixed assertion count across lanes

On `replay`, skipped assertions are **absent** from `results[].assertions[]` (filtered before
evaluation), not present-and-passing. A CI script that counts assertions will see a different count
on replay vs live — compare by assertion identity / pass-fail, not by total count.
