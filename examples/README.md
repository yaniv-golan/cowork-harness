# Examples

Runnable, CI-verified worked examples — copy these as the starting point for testing your
own skill. Each scenario is executed in CI (`run examples/scenarios/`) and schema-validated
by `test/examples.test.ts`, so they can't silently rot.

> These are *examples* of the layout you'd author in your own skill repo. In **your** repo,
> `scenarios/` + `sessions/` typically live at the root; here they're under `examples/`
> because this is the harness's own repo. (The harness's internal fidelity self-tests live
> in `e2e/`, not here.)

## Layout

```
examples/
  scenarios/   one test each: prompt + scripted answers + assertions
  sessions/    pre-prompt setup (model, mounts, plugins) — referenced by scenarios via `session:`
  skills/      the example skills under test (each a Claude Code plugin folder)
  data/        sample inputs the scenarios consume (CSVs, a PDF, an mcp.json)
  replays/     committed synthetic cassettes for token-free, Docker-free `replay`
```

Paths inside a scenario/session resolve **relative to that file** (see
[../docs/session.md](../docs/session.md#path-expansion)), so this whole `examples/` tree is
self-contained and relocatable.

## The scenarios

| Scenario | Fidelity | What it demonstrates |
|---|---|---|
| `scenarios/protocol-smoke.yaml` | `protocol` | the **zero-infra smoke test** — no Docker, no staged agent, just the host control loop. Asserts only control-loop + skill-logic facts (a scripted answer reaches the model, a file is written). L0 does **not** seal the filesystem, so a host-path leak is expected — the YAML's comment explains why `transcript_no_host_path` is **omitted** here (only `true` is a valid value; sandboxed tiers add `- transcript_no_host_path: true`) |
| `scenarios/example-pdf-skill.yaml` | `container` | the minimal sandboxed shape — prompt + scripted answers + assertions (placeholder skill; harness plumbing only) |
| `scenarios/csv-metrics.yaml` | `container` | a non-trivial skill running a **bundled producer** end-to-end → structured `outputs/metrics.json` + a `summary.md` (paired with `../python/test_csv_metrics_lane.py` for a JSON-content predicate) |
| `scenarios/csv-fx-normalize.yaml` | `container` | **graceful degradation** under default-deny egress — the skill's real network step is blocked, so `egress_denied` is backed by genuine behavior and the skill falls back instead of crashing. Its `egress_denied` assertion needs a sandboxed tier (`container`+) and is pre-rejected at `protocol` fidelity (no sandbox to enforce it would be a false pass) |
| `scenarios/skill-loads.yaml` | `container` | an acceptance check that a local skill loads and the python toolchain is present |

## Run them

```bash
cowork-harness run examples/scenarios/csv-metrics.yaml   # one
cowork-harness run examples/scenarios/                    # all (CI-ready exit code)
```

> From a source checkout, `node dist/cli.js run …` works too (skip the `npm link`).

### Prerequisites

The `container` scenarios above are **live `run`s**: they spawn the staged Cowork agent in a
sandboxed arm64 container, so they need Docker (arm64) + the agent image, a Claude Desktop agent
ELF staged once, and an auth token. The full setup (and the resolution order for each) is in the
README's [Prerequisites](../README.md#prerequisites-for-anything-above-protocol-fidelity) — it isn't duplicated here.

**Two paths that need none of that:**

- **Token-free, Docker-free replay.** A committed synthetic cassette replays on a fresh clone:

  ```bash
  cowork-harness replay examples/replays/example-pdf-skill.cassette.json
  ```

- **The `protocol` tier — zero infra.** The `protocol` (L0) fidelity tier runs the host control loop
  directly: no Docker, no staged agent. `scenarios/protocol-smoke.yaml` is authored at this tier.
  To run a different scenario at L0, set `fidelity: protocol` in its YAML (fidelity is a scenario
  field, not a CLI flag on `run`):

  ```bash
  cowork-harness run examples/scenarios/protocol-smoke.yaml   # already protocol in YAML
  ```

  L0 still calls a real model (so your normal `claude` login / token applies), but it has **no
  sandbox** — egress/`expect_denied` assertions are pre-rejected here, and a host path naturally
  leaks into tool output (the FS isn't sealed). Use it for fast logic iteration; graduate to
  `container` for boundary fidelity.
