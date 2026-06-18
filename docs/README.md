# Documentation

Start with the [project README](../README.md) for the overview and quick start, then dig in here.

## Guides

| Doc | What it covers |
|---|---|
| [boundary.md](./boundary.md) | **The limitations model** — how the harness reproduces Cowork's sealed filesystem, default-deny egress, and MCP-only crossing, per fidelity tier; how to verify it. Read this if you care about *constraint* fidelity. |
| [session.md](./session.md) | Reference for `sessions/*.yaml` — every pre-prompt setting (model, folders/projects, uploads, discovery, egress) and its Cowork mapping. |
| [scenario.md](./scenario.md) | Reference for `scenarios/*.yaml` — prompt, scripted answers, assertions. |
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
| Commands at a glance (what / when) | [README → Commands at a glance](../README.md#commands-at-a-glance); full flags via `<command> --help` — includes `doctor` (prerequisite check before first live run) |
| Fidelity — three isolation tiers (L0/L1/L2) + two loop overlays (`hostloop`, `cowork`) | [boundary.md](./boundary.md), [README](../README.md) |
| Control-protocol / spawn contract | [cowork-spawn-contract-1.12603.1.md](./cowork-spawn-contract-1.12603.1.md) (verified on `desktop-1.12603.1`; control-protocol fields unchanged through `desktop-1.13576.1`; volatile fields — `agentVersion`, egress allowlist, GrowthBook gates — tracked in `baselines/`); see also [SPEC.md](../SPEC.md) |
| AI agent instructions for this repo | [AGENTS.md](../AGENTS.md) |
| Security & threat model | [../SECURITY.md](../SECURITY.md) |
| Contributing | [../CONTRIBUTING.md](../CONTRIBUTING.md) |
