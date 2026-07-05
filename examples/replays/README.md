# examples/replays/

This directory contains committed cassette fixtures for token-free replay testing.

## example-pdf-skill.cassette.json

A **synthetic** fixture — NOT a real model recording. Hand-authored to exercise the full-fidelity
replay path end-to-end, including:

- An AskUserQuestion gate (permission → question → tool_result delivery)
- A Write permission gate
- `question_asked`, `gate_answers_delivered`, `transcript_contains`, `tool_called`, and `result` assertions

Run it with:

> Assumes the `cowork-harness` CLI is available — from a source checkout run `npm ci && npm run build && npm link` first, or `npm i -g cowork-harness@>=0.25.0`. (`replay` itself needs nothing else — no token, no Docker.)

```sh
cowork-harness replay examples/replays/example-pdf-skill.cassette.json
```

Or with JSON output (for CI):

```sh
cowork-harness replay examples/replays/example-pdf-skill.cassette.json --output-format json
```

> From a source checkout you can skip the `npm link` and call the CLI directly:
> `node dist/cli.js replay …`. The commands below use the installed `cowork-harness` binary.

## example-pdf-skill-ci-selftest-failing.yaml

A deliberately-failing sibling scenario for `example-pdf-skill.cassette.json`, used only by the
packaged Action's CI self-test (`.github/workflows/ci.yml`, job `action-self-test`) via
`replay --assert-from` to prove the Action propagates a real *assertion* failure (exit 1) end to
end — not just a usage error (exit 2, e.g. a nonexistent path). Its `assert:` block asserts
`tool_not_called: Skill`, which is permanently false against this cassette. Not a template to
copy for your own scenarios.

## Re-recording

To replace this fixture with a real recording from a live run:

```sh
cowork-harness record examples/scenarios/your-scenario.yaml --out examples/replays/your-name.cassette.json
```

Note: real recordings require a live CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY) and Docker. The synthetic fixture in this
directory is designed to run token-free on CI.
