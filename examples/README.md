# Examples

Runnable, CI-verified worked examples — copy these as the starting point for testing your
own skill. Every scenario is schema-validated (`test/examples.test.ts`) and lint-checked, and
the committed cassettes replay token-free on **every** CI run, fork PRs included. The live
`run examples/scenarios/` pass additionally executes when `ANTHROPIC_API_KEY` is available to
the workflow (main-repo pushes/PRs) — it's skipped on fork PRs, which never receive the secret.
See `.github/workflows/ci.yml`.

> **Reading this on npm?** The npm package ships only `replays/` and this README — the
> `scenarios/`, `sessions/`, `skills/`, and `data/` trees described below need a source checkout
> (`git clone https://github.com/yaniv-golan/cowork-harness`). See the what-ships table under
> [README → Drive it from Claude Code](../README.md#drive-it-from-claude-code-companion-skill).

> These are *examples* of the layout you'd author in your own skill repo. In **your** repo,
> `scenarios/` + `sessions/` typically live at the root; here they're under `examples/`
> because this is the harness's own repo. (The harness's internal fidelity self-tests live
> in `e2e/`, not here.)

> **Untracked files don't mount.** Inside a git repo, the harness stages only **git-tracked** files
> into the sandbox — `git add` a new skill/scenario file here or it (or the whole folder) mounts
> empty. See [README → Test a local skill in one command](../README.md#test-a-local-skill-in-one-command).

**New here?** [docs/boundary.md](../docs/boundary.md) explains what the sandbox does and doesn't
enforce (the limitations model); [docs/README.md](../docs/README.md) is the full documentation
index; `cowork-harness doctor` checks your local prerequisites (Docker, agent binary, auth token)
before you run anything above `protocol` fidelity.

## Layout

```
examples/
  scenarios/   one test each: prompt + scripted answers + assertions
  sessions/    pre-prompt setup (model, mounts, plugins) — referenced by scenarios via `session:`
  skills/      the example skills under test (each a Claude Code plugin folder)
  data/        sample inputs the scenarios consume (CSVs, a PDF, an mcp.json)
  replays/     committed synthetic cassettes for token-free, Docker-free `replay`
  matrices/    `run --matrix <file>` compatibility-matrix configs (baseline/model/skill_dir axes)
  answer-policies/  reusable scripted-answer YAML fragments, loaded with `--answer-policy <yaml>` on
                    `skill`/`decide` (or authored inline via a scenario's `answers:` block) — see
                    docs/scenario.md § Reusable answer policies (--answer-policy)
  probes/      live-contract probe scenarios (driven by test/live-contract.test.ts — not part of the copyable starter set)
```

Answer policies: see [docs/scenario.md § Reusable answer policies](../docs/scenario.md#reusable-answer-policies---answer-policy).

Matrices: the worked matrix config is `matrices/csv-metrics-matrix.yaml` — see the `run --matrix` bullet under [README → Commands at a glance](../README.md#commands-at-a-glance) ("Flags worth knowing").

`replays/` has its own [README](./replays/README.md) explaining what each committed cassette covers.

Paths inside a scenario/session resolve **relative to that file** (see
[../docs/session.md](../docs/session.md#path-expansion)), so this whole `examples/` tree is
self-contained and relocatable.

## The scenarios

| Scenario | Fidelity | What it demonstrates |
|---|---|---|
| `scenarios/protocol-smoke.yaml` | `protocol` | the **smoke test with no Docker, no staged agent (still needs a token)** — just the host control loop. Asserts only control-loop + skill-logic facts (a scripted answer reaches the model, a file is written). See note below on the omitted `transcript_no_host_path` assertion. |
| `scenarios/example-pdf-skill.yaml` | `container` | the minimal sandboxed shape — prompt + scripted answers + assertions (placeholder skill; harness plumbing only) |
| `scenarios/csv-metrics.yaml` | `container` | a non-trivial skill running a **bundled producer** end-to-end → structured `outputs/metrics.json` + a `summary.md` (paired with `../python/test_csv_metrics_lane.py` for a JSON-content predicate) |
| `scenarios/csv-fx-normalize.yaml` | `container` | **graceful degradation** under default-deny egress — the skill's real network step is blocked, so `egress_denied` is backed by genuine behavior and the skill falls back instead of crashing. Its `egress_denied` assertion needs a sandboxed tier (`container`+) and is pre-rejected at `protocol` fidelity (no sandbox to enforce it would be a false pass) |
| `scenarios/skill-loads.yaml` | `container` | an acceptance check that a local skill loads and the python toolchain is present |
| `scenarios/trigger-accuracy-sweep/` | `container` | a **trigger-accuracy sweep** — a positive prompt and a negative-control prompt against the same skill, each asserting `skill_triggered`/`no_skill_triggered`; run the directory under `run --repeat N` to measure how reliably a description/trigger phrase actually invokes the skill across repeated tries (see [docs/scenario.md § Measuring flakiness](../docs/scenario.md#measuring-flakiness-run---repeat)) |
| `scenarios/hostloop-computer-links.yaml` | `hostloop` | the harness's **only `hostloop`-tier worked example** — the agent writes a file and shares it back as a `computer://` link, asserting the link `computer_links_resolve`s to the real collected artifact (the "host" side of a hostloop mount is production's own real host path, so this is where link resolution is most load-bearing). Committed as `replays/hostloop-computer-links.cassette.json`, the harness's only token-free replay fixture at the `hostloop` tier. |

> **Why `protocol-smoke.yaml` omits `transcript_no_host_path`:** at `protocol` fidelity (L0), the
> harness runs with no sandbox, so it does **not** seal the filesystem — a host-path leak into the
> transcript is expected there, not a bug. The scenario's own comment explains the omission (only
> `true` is a valid value for this assertion; sandboxed tiers add `- transcript_no_host_path: true`).

## Run them

**Two paths need neither Docker nor a staged agent** — the live `container` examples below need
both, plus an auth token:

- **Token-free, Docker-free replay.** A committed synthetic cassette replays on a fresh clone:

  ```bash
  cowork-harness replay examples/replays/example-pdf-skill.cassette.json
  ```

- **The `protocol` tier — no Docker, no staged agent (still needs a token).** The `protocol` (L0) fidelity tier runs the host control loop
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

### Running the live examples

```bash
cowork-harness run examples/scenarios/csv-metrics.yaml   # one
cowork-harness run examples/scenarios/                    # every top-level *.yaml (non-recursive; CI-ready exit code)
```

> From a source checkout, `node dist/cli.js run …` works too (skip the `npm link`).

> **CI note:** this live pass only runs when `ANTHROPIC_API_KEY` is set (main-repo pushes/PRs); fork
> PRs get lint + schema validation + token-free replay only — see `.github/workflows/ci.yml`.

The `container` scenarios above are **live `run`s**: they spawn the staged Cowork agent in a
sandboxed arm64 container, so they need Docker (arm64) + the agent image, a Claude Desktop agent
ELF staged once, and an auth token. The full setup (and the resolution order for each) is in the
README's [Prerequisites](../README.md#prerequisites-for-anything-above-protocol-fidelity) — it isn't duplicated here.
