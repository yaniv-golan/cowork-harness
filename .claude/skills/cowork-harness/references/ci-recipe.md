# CI recipe — replay vs live lanes

Self-contained reference. Tracks `cowork-harness 0.5.0` (baseline `desktop-1.13576.1`).

## The core split: token-free PR gate + live nightly (self-hosted)

The harness has two execution lanes with different cost, coverage, AND infrastructure requirements.
The split is not just about tokens — it decides **where each lane can run**:

- **`replay` / `verify-cassettes` (token-free, agent-free).** Replays a recorded cassette
  (`events.jsonl` + `control-out.jsonl`) and lints the committed cassettes. **No model tokens, no
  Docker, no agent binary** — runs on a stock GitHub Actions runner. Evaluates **content** assertions
  only (`transcript_*`, `tool_*`, `subagent_*`, `dispatch_count_max`, `result`; plus the gate keys
  `question_asked` / `questions_count_max` / `gate_answers_delivered` **if** the cassette has
  `controlOut`). Filesystem/egress assertions are **silently skipped**. This is your **always-on PR
  gate**.
- **`run` / `record` (live).** Spawns the real agent in a sandbox: real model tokens + Docker **+ the
  staged Claude Code agent ELF**, bind-mounted from a local Claude Desktop install or pointed to via
  `COWORK_AGENT_BINARY`. Nothing is bundled, and **the agent binary is not redistributable** — a clean
  GitHub-hosted runner has neither Desktop nor the ELF. So the live lane is **self-hosted / local-runner
  only**. Evaluates **every** assertion (filesystem/egress/boundary). This is your **nightly /
  pre-release job**, and recording new cassettes happens here too.

> **The realistic CI shape:** the replay gate + `verify-cassettes` run in stock GitHub Actions on every
> PR; recording and the live nightly run on your machine or a self-hosted runner that has the agent
> binary. Don't expect a "download the agent in CI" path — there isn't one (it's Anthropic's staged
> binary, not ours to ship).

The cardinal rule: **a replay PR gate cannot verify an artifact's content or any boundary** — it has
no filesystem and no network. Don't let a green replay gate convince you the deliverable is correct.
Run `cowork-harness lint` (the bundled `scenario.py lint`) in CI to catch a scenario that put a
filesystem/egress-only check on the replay lane (a silent no-op). Author new scenarios with
`scenario.py scaffold` so they start from a valid, self-linted skeleton.

## Recording a cassette

```bash
cowork-harness record scenarios/my-test.yaml      # live run that also writes the cassette
cowork-harness record scenarios/                  # batch: record every scenario in the dir
cowork-harness record cassettes/ --rerecord-stale # re-record ONLY the cassettes whose fingerprint drifted
cowork-harness replay cassettes/my-test.cassette.json  # token-free re-evaluation of content assertions
cowork-harness replay cassettes/                   # replay every *.cassette.json in the committed dir
```

Re-record whenever the protocol or your scenario's expected content changes. An old cassette without
`controlOut` excludes the gate keys (with a loud warning) — re-record to enable them. `record` **refuses
to freeze a failing live run** into a cassette (pass `--allow-failing` to override) — a committed red
cassette is a latent false-signal.

## Privacy: cassettes are committed fixtures → record only against SYNTHETIC inputs

A cassette snapshots the transcript **and** the `outputs/` JSON bodies (cap tables, instruments, names,
dollar figures). In a skill repo these cassettes get **committed**. So:

- **Record against synthetic data only** (e.g. "Cadence / Acme", made-up numbers) — never a real
  customer's cap table.
- **Opt-in redaction** rewrites configured PII out of the cassette at record time. Drop a
  `.cowork-redact.json` next to your scenarios (or set `COWORK_HARNESS_REDACT_PATTERNS` /
  `_KEYS`); empty by default. Redaction is **verdict-preserving** — `record` refuses to write if
  redaction would flip an assertion (a manufactured green). `--no-redact` skips it for known-synthetic
  inputs.
- **Always-on scan gate** — `verify-cassettes` flags email / currency / bare-domain matches it finds in
  the committed cassettes and **exits non-zero**, so "no leak" is a gate, not discipline. Suppress
  synthetic / public reference names (NVCA, Cooley GO, …) with `--allow <regex>`. (Multi-word proper
  names are NOT a default class — too noisy to gate on; add a pattern via config if your corpus needs it.)

```bash
cowork-harness verify-cassettes cassettes/                       # privacy scan + staleness, exit 1 on a finding
cowork-harness verify-cassettes cassettes/ --allow 'NVCA|Cooley GO|Acme'
cowork-harness verify-cassettes cassettes/ --staleness-only      # just the "edited the skill, didn't re-record" gate
```

## Four-stage pipeline

A typical skill repo runs four stages, fastest/cheapest first:

1. **Unit** — your skill's own tests (pytest/vitest of its scripts). Not the harness's job.
2. **Boundary / lint** — `cowork-harness lint scenarios/*.yaml` (no-silent-false-green invariants; needs
   python3 + PyYAML) + `cowork-harness verify-cassettes cassettes/` (privacy scan + staleness) +
   `cowork-harness boundary-check` where relevant. Token-free, agent-free.
3. **Scenarios (replay)** — `cowork-harness replay cassettes/` on every PR (the committed `*.cassette.json`).
   Token-free; content + structure + gate delivery.
4. **Parity / live (nightly, self-hosted)** — `cowork-harness run scenarios/` with a token + Docker +
   the agent binary; full filesystem/egress/boundary coverage. **Self-hosted / local runner only**
   (needs the ELF). Optionally `cowork-harness sync` drift checks against a new Desktop release.

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
      - run: cowork-harness lint scenarios/*.yaml                              # no-silent-false-green (needs python3 + PyYAML)
      - run: cowork-harness verify-cassettes cassettes/ --output-format json   # privacy + staleness gate
      - run: cowork-harness replay cassettes/ --output-format json             # token-free content/structure
```

Nightly live job — **self-hosted only** (needs the agent ELF, not present on GitHub-hosted runners):

```yaml
name: cowork-skill-nightly
on:
  schedule: [{ cron: '0 7 * * *' }]
jobs:
  live:
    runs-on: [self-hosted, macos, arm64]   # a box with Claude Desktop / COWORK_AGENT_BINARY
    if: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN != '' }}
    steps:
      - uses: actions/checkout@v4
      - run: npm i -g cowork-harness
      - run: cowork-harness run scenarios/ --output-format json
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          # COWORK_AGENT_BINARY: /path/to/claude-code-vm/<ver>/claude   # if not using a Desktop install
```

A GitHub-**hosted** runner has no agent binary, so `run`/`record` can't work there — that's why the live
lane is self-hosted. The PR gate above (replay + verify-cassettes) is what runs in hosted CI. Keep the
token in CI **secrets**, never in a `.env` inside a mounted skill/folder (it would be copied into the
sandbox).

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
