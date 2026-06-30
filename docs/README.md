# Documentation

Start with the [project README](../README.md) for the overview and quick start, then dig in here.

**Reading order (start here):** [../examples/README.md](../examples/README.md) (token-free `replay` + worked examples) → [boundary.md](./boundary.md) (the limitations model) → [session.md](./session.md) + [scenario.md](./scenario.md) (authoring tests) → [cassette.md](./cassette.md) (record/replay deep-dive).

> **Before a first *live* run** (any tier above `replay`/`protocol`): run `cowork-harness doctor` (or `doctor --tier <t>`) to check Docker + staged agent + token. `lint` needs **python3** on PATH; `--fidelity microvm` needs a one-time `cowork-harness vm init`.

## Guides

| Doc | What it covers |
|---|---|
| [boundary.md](./boundary.md) | **The limitations model** — how the harness reproduces Cowork's sealed filesystem, default-deny egress, and MCP-only crossing, per fidelity tier; how to verify it. Read this if you care about *constraint* fidelity. |
| [session.md](./session.md) | Reference for `sessions/*.yaml` — every pre-prompt setting (model, folders/projects, uploads, discovery, egress) and its Cowork mapping. |
| [scenario.md](./scenario.md) | Reference for `scenarios/*.yaml` — prompt, scripted answers, assertions. |
| [chat.md](./chat.md) | Reference for the interactive `chat` command — multi-turn sessions, `--folder`, fidelity tiers, and how it differs from `skill`. |
| [debugging.md](./debugging.md) | **Debugging a run** — the post-hoc loop (`inspect` → `trace` → `chat` → `verify-run`) for a misbehaving skill, and how to hunt a false-green (Gotchas, `lint`, `verify-cassettes`). A router into the tools, not a re-doc. |
| [fidelity-gaps.md](./fidelity-gaps.md) | What the harness deliberately does NOT reproduce vs real Cowork — the known, faithful gaps. |
| [decider-dir.md](./decider-dir.md) | The `--decider-dir` recipe — answer LIVE questions in-band from a driving agent: the gates/answer file channel (`req-N.json`/`resp-N.json`) plus a Monitor walkthrough. |
| [cassette.md](./cassette.md) | Cassette `record`/`replay` — file shape, the assertion table (content vs. skipped), full-fidelity replay (`controlOut` + the O7 guard), backward compat, and the committed CI fixture. |
| [discovery.md](./discovery.md) | Where the agent finds marketplaces, plugins, skills, MCP servers — and how to override each for tests. |
| [maintenance.md](./maintenance.md) | Keeping parity across Claude Desktop releases with `cowork-harness sync`. |
| [../python/README.md](../python/README.md) | The **`cowork` pytest lane** — drive any of the above from `pytest` (incl. `serve_decider` for live-question helpers). |
| [../DESIGN.md](../DESIGN.md) | Architecture deep-dive + the full parity matrix + why scripting the real Desktop runtime is closed. |
| [../SPEC.md](../SPEC.md) | **The authoritative contract** — the precise behavior the harness implements (persistence/resume, control-response envelopes, dispatch caps, …). Read this when a doc and the code disagree. |
| [../CHANGELOG.md](../CHANGELOG.md) | Release notes + the binary-grounding (asar / agent-ELF version) each entry was verified against. |

## Reference

| Topic | Where |
|---|---|
| Commands at a glance (what / when) | [README → Commands at a glance](../README.md#commands-at-a-glance) — the **complete** command catalog; full flags via `<command> --help` (includes `doctor`, the prerequisite check before a first live run) |
| `lint` / `scaffold` (scenario authoring) | [scenario.md](./scenario.md); `cowork-harness lint --help`, `cowork-harness scaffold --help` |
| `verify-run` (re-assert a kept run, no tokens) · `decide` (smoke-test a decider against a sample question, no run) | `cowork-harness verify-run --help`, `cowork-harness decide --help` |
| Debugging a run (a misbehaving skill, or a green you don't trust) | [debugging.md](./debugging.md) |
| In-band gate answering from a driving agent (`gates` / `answer`) | [decider-dir.md](./decider-dir.md) |
| Fidelity — three isolation tiers (L0/L1/L2) + two loop overlays (`hostloop`, `cowork`) | [boundary.md](./boundary.md), [README](../README.md) |
| Control-protocol / spawn contract | [cowork-spawn-contract-1.12603.1.md](./cowork-spawn-contract-1.12603.1.md) (verified on `desktop-1.12603.1`; control-protocol fields unchanged through `desktop-1.13576.1`; mount-layout fork at ≥`1.14271.0`; volatile fields — `agentVersion`, egress allowlist, GrowthBook gates — tracked in `baselines/`); see also [SPEC.md](../SPEC.md) |
| AI agent instructions for this repo | [AGENTS.md](../AGENTS.md) |
| Security & threat model | [../SECURITY.md](../SECURITY.md) |
| Contributing | [../CONTRIBUTING.md](../CONTRIBUTING.md) |
| CI recipe — copy-paste GitHub Actions for the token-free PR gate + nightly live lane | [../.claude/skills/cowork-harness/references/ci-recipe.md](../.claude/skills/cowork-harness/references/ci-recipe.md) |
| Releasing — the branch → PR → tag publish flow | [../RELEASING.md](../RELEASING.md) |
