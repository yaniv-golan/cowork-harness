# examples/replays/

This directory contains committed cassette fixtures for token-free replay testing.

## example-pdf-skill.cassette.json

A **synthetic** fixture — NOT a real model recording. Hand-authored to exercise the full-fidelity
replay path end-to-end, including:

- An AskUserQuestion gate (permission → question → tool_result delivery)
- A Write permission gate
- `question_asked`, `gate_answers_delivered`, `transcript_contains`, `tool_called`, and `result` assertions

Run it with:

```sh
node dist/cli.js replay --cassette examples/replays/example-pdf-skill.cassette.json
```

Or with JSON output (for CI):

```sh
node dist/cli.js replay --cassette examples/replays/example-pdf-skill.cassette.json --output-format json
```

## Re-recording

To replace this fixture with a real recording from a live run:

```sh
node dist/cli.js record examples/scenarios/your-scenario.yaml --out examples/replays/your-name.cassette.json
```

Note: real recordings require a live ANTHROPIC_API_KEY and Docker. The synthetic fixture in this
directory is designed to run token-free on CI.
