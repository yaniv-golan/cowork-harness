# examples/replays/

This directory contains committed cassette fixtures for token-free replay testing.

## example-pdf-skill.cassette.json

A **synthetic** fixture — NOT a real model recording. Hand-authored to exercise the full-fidelity
replay path end-to-end, including:

- Reading `report.pdf` from uploads and writing a markdown checklist to `outputs/actions.md`
- `result`, `user_visible_artifact`, `transcript_contains`, `tool_called`, and `tool_not_called` assertions

(No gate exchange is recorded in this fixture — the paired scenario, `examples/scenarios/example-pdf-skill.yaml`,
scripts `answers:` for a possible AskUserQuestion/Write gate, but none fired in this run. For a fixture that
DOES exercise a real gate exchange, see `example-multiselect-gate.cassette.json`.)

Run it with:

> Assumes the `cowork-harness` CLI is available — from a source checkout run `npm ci && npm run build && npm link` first, or `npm i -g "cowork-harness@^2.1.0"`. (`replay` itself needs nothing else — no token, no Docker.)

```sh
cowork-harness replay examples/replays/example-pdf-skill.cassette.json
```

> **Installed globally instead of from a checkout?** The `examples/replays/...` path above is
> relative to a source checkout and won't resolve from an arbitrary cwd. Resolve it against the
> package root instead: `cowork-harness replay "$(npm root -g)/cowork-harness/examples/replays/example-pdf-skill.cassette.json"`
> — or copy the cassette into your own project and pass that path.

Or with JSON output (for CI):

```sh
cowork-harness replay examples/replays/example-pdf-skill.cassette.json --output-format json
```

> From a source checkout you can skip the `npm link` and call the CLI directly:
> `node dist/cli.js replay …`. The commands below use the installed `cowork-harness` binary.

## example-multiselect-gate.cassette.json

A fixture exercising a **multi-select** `AskUserQuestion` gate — a single question
that allows choosing more than one option (`choose: [Auth, Audit]`, comma-separated), asserting
`result: success` and `transcript_contains` for each chosen feature. Recorded at `protocol` tier.

> Its capability manifest used to be a hand-written synthetic catalog, because a `protocol`-tier
> recording keeps the operator's real config dir and would otherwise publish that machine's installed
> plugins. As of the 1.32885.1 re-record it is a **real captured manifest from a sealed run** — recorded
> with `ANTHROPIC_API_KEY` set, which switches the tier to a fresh managed config dir, so what it carries
> is the product's own built-in commands/agents/skills and no operator inventory. `verify-cassettes`
> enforces that distinction on every commit.

> Replaying a cassette needs neither Docker nor a staged agent **whatever tier it was recorded at** —
> replay reads the recorded frames and never spawns anything. The token-free CI lane replays the
> `container`, `protocol` and `hostloop` fixtures side by side for exactly that reason. The tier a
> cassette was recorded at determines what it captured, not what replaying it costs.

```sh
cowork-harness replay examples/replays/example-multiselect-gate.cassette.json
```

## hostloop-computer-links.cassette.json

The harness's only `hostloop`-tier replay fixture: the agent writes `outputs/report.md` and shares
it back as a `computer://` link, asserting `file_exists`, `transcript_contains: computer://`, and
`computer_links_resolve`. See [`examples/README.md`](../README.md#the-scenarios) for the fuller
writeup of what this scenario demonstrates about hostloop link resolution.

```sh
cowork-harness replay examples/replays/hostloop-computer-links.cassette.json
```

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
