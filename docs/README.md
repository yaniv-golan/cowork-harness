# Documentation

Start with the [project README](../README.md) for the overview and quick start, then dig in here.

**Reading order (author → run → debug):** get oriented with [../examples/README.md](../examples/README.md) (token-free `replay` + worked examples) and [boundary.md](./boundary.md) (the limitations model) → **author:** [session.md](./session.md) + [scenario.md](./scenario.md) → **run, record & lock:** [cassette.md](./cassette.md) (record/replay deep-dive), [stats.md](./stats.md) (cross-run history), [run-status.md](./run-status.md) (liveness) → **debug:** [debugging.md](./debugging.md) (when a run misbehaves or you don't trust a green) + [chat.md](./chat.md) (interactive reproduction) → [gotchas.md](./gotchas.md) (troubleshooting FAQ — setup + authoring).

**Specialized guides (read on demand, not in the linear path above):** [subagents.md](./subagents.md) — sub-agent dispatch/path model; [discovery.md](./discovery.md) — marketplace/skill/MCP discovery; [plugin-root.md](./plugin-root.md) — `${CLAUDE_PLUGIN_ROOT}` resolution; [decider-dir.md](./decider-dir.md) — in-band LIVE gate answering; [fidelity-gaps.md](./fidelity-gaps.md) — known harness-vs-Cowork gaps; [maintenance.md](./maintenance.md) — `sync`ing across Desktop releases; [protocol.md](./protocol.md) — control-channel wire schema; [invariants.md](./invariants.md) — cross-cutting invariant index.

> **Before a first *live* run** (any tier above `replay`/`protocol`): run `cowork-harness doctor` (or `doctor --tier <t>`) to check Docker + staged agent + token. `lint` needs **python3** on PATH; `--fidelity microvm` needs a one-time `cowork-harness vm init`. Replay-only usage (running only committed cassettes) can **skip** `doctor` entirely — its default `container` tier checks Docker + the staged agent, neither of which replay touches. Note that **every tier `doctor` checks** validates an auth token — even `doctor --tier protocol` requires one, since `protocol` still calls a real model — which is a further reason replay-only users simply skip `doctor` (a token ✗ there is expected, not a blocker for replay).

## Guides

Grouped by the same **author → run → debug** spine as the reading order above.

| Doc | What it covers |
|---|---|
| [boundary.md](./boundary.md) | **The limitations model** — how the harness reproduces Cowork's sealed filesystem, default-deny egress, and MCP-only crossing, per fidelity tier; how to verify it. Read this if you care about *constraint* fidelity. |
| [session.md](./session.md) | **Author** — reference for `sessions/*.yaml`: every pre-prompt setting (model, folders/projects, uploads, discovery, egress) and its Cowork mapping. |
| [scenario.md](./scenario.md) | **Author** — reference for `scenarios/*.yaml`: prompt, scripted answers, assertions. |
| [subagents.md](./subagents.md) | **Author/debug** — the sub-agent capability/path model: the tier-qualified outputs-addressing contract (host-loop vs. VM-loop), the tool-composition rules, the type-less dispatch trap, and model-resolution precedence. |
| [cassette.md](./cassette.md) | **Run, record & lock** — cassette `record`/`replay`: file shape, the assertion table (content vs. skipped), full-fidelity replay (`controlOut` — the recorded driver→child control responses — plus the O7 guard, which re-exercises the decision-serialization logic on replay), backward compat, and the committed CI fixture. |
| [stats.md](./stats.md) | **Run** — the `stats` command + `index.jsonl`: querying pass rate, cost/duration/token/turn percentiles, and last-green across every past run, filtered/windowed per scenario. |
| [run-status.md](./run-status.md) | **Run** — checking whether a background run is alive without `ps aux`: the `status.json` file + `cowork-harness status [--follow]`. |
| [debugging.md](./debugging.md) | **Debug** — the post-hoc loop (`inspect` → `trace` → `verify-run` → `diff` → `chat`) for a misbehaving skill, how to hunt a false-green (Gotchas, `lint`, `verify-cassettes`), and the **iterate-across-fixes verification loop** (ground findings in run evidence; pair generations by `fingerprint.skillHash`). A router into the tools, not a re-doc. |
| [chat.md](./chat.md) | **Debug** — reference for the interactive `chat` command: multi-turn sessions, `--folder`, fidelity tiers, and how it differs from `skill`. |
| [decider-dir.md](./decider-dir.md) | **Debug** — the `--decider-dir` recipe: answer LIVE questions in-band from a driving agent: the gates/answer file channel (`req-N.json`/`resp-N.json`) plus a Monitor walkthrough. |
| [fidelity-gaps.md](./fidelity-gaps.md) | **Debug** — what the harness deliberately does NOT reproduce vs real Cowork: the known, faithful gaps (sometimes the "bug" is one of these). |
| [discovery.md](./discovery.md) | Where the agent finds marketplaces, plugins, skills, MCP servers — and how to override each for tests. |
| [plugin-root.md](./plugin-root.md) | How `${CLAUDE_PLUGIN_ROOT}` resolves differently per execution mode (host-loop vs VM-loop) and how the harness stages plugin dirs — read when a skill's own `${CLAUDE_PLUGIN_ROOT}` path doesn't resolve. |
| [maintenance.md](./maintenance.md) | Keeping parity across Claude Desktop releases with `cowork-harness sync`. |
| [protocol.md](./protocol.md) | The hand-authored `schema/protocol.v1.json` control-channel wire-protocol schema — versioning policy, golden vector pack, and its explicit descriptive-not-normative scope. |
| [invariants.md](./invariants.md) | A consolidated index of the harness's cross-cutting invariants, one row per invariant with its enforcement point and test anchor. |
| [../python/README.md](../python/README.md) | The **`cowork` pytest lane** — drive any of the above from `pytest` (incl. `serve_decider` for live-question helpers). |
| [../DESIGN.md](../DESIGN.md) | Architecture deep-dive + the full parity matrix + why scripting the real Desktop runtime is closed. |
| [../SPEC.md](../SPEC.md) | **The authoritative contract** — the precise behavior the harness implements (persistence/resume, control-response envelopes, dispatch caps, …). Read this when a doc and the code disagree. |
| [../CHANGELOG.md](../CHANGELOG.md) | Release notes + the binary-grounding (asar / agent-ELF version) each entry was verified against. |
| [gotchas.md](./gotchas.md) | Troubleshooting FAQ — setup + authoring footguns: exit 127, empty skill mount, arm64 Docker issues, git-worktree token traps, scenarioDrift after an edit, plus skill-authoring/host-loop footguns. |

## Reference

| Topic | Where |
|---|---|
| Commands at a glance (what / when) | [README → Commands at a glance](../README.md#commands-at-a-glance) — the **complete** command catalog; full flags via `<command> --help` (includes `doctor`, the prerequisite check before a first live run) |
| `lint` / `scaffold` (scenario authoring) | [scenario.md](./scenario.md); `cowork-harness lint --help`, `cowork-harness scaffold --help` |
| `lint-skill` (skill authoring — static checks on a `SKILL.md` / skill dir; `--strict` gates in CI) | [README → Commands at a glance](../README.md#commands-at-a-glance), [gotchas.md](./gotchas.md), [plugin-root.md](./plugin-root.md); `cowork-harness lint-skill --help` |
| `analyze-skill` (static path-fidelity check — flags host-loop-only `/sessions/...` path literals, plus interactive-artifact write-back detection) | [subagents.md → Static path-fidelity check (analyze-skill)](./subagents.md#static-path-fidelity-check-analyze-skill); `cowork-harness analyze-skill --help` |
| `verify-run` (re-assert a kept run, no tokens) · `decide` (smoke-test a decider against a sample question, no run) | `cowork-harness verify-run --help`, `cowork-harness decide --help`, [scenario.md → Dry-running a decider](./scenario.md#dry-running-a-decider-decide) |
| Debugging a run (a misbehaving skill, or a green you don't trust) | [debugging.md](./debugging.md) |
| In-band gate answering from a driving agent (`gates` / `answer`) | [decider-dir.md](./decider-dir.md) |
| Checking a background run's liveness (`status`) and locating a scenario's newest run (`status --latest-for`) | [run-status.md](./run-status.md) |
| Fidelity — three isolation tiers (L0/L1/L2) + two loop overlays (`hostloop`, `cowork`) | [boundary.md](./boundary.md), [README](../README.md) |
| Control-protocol / spawn contract | [cowork-spawn-contract-1.12603.1.md](./cowork-spawn-contract-1.12603.1.md) (frozen historical research, verified on `desktop-1.12603.1`; control-protocol fields re-verified unchanged through `desktop-1.13576.1`; mount-layout fork at ≥`1.14271.0`; volatile fields — `agentVersion`, egress allowlist, GrowthBook gates — tracked in `baselines/`); see also [SPEC.md](../SPEC.md) |
| AI agent instructions for this repo | [AGENTS.md](../AGENTS.md) |
| Security & threat model | [../SECURITY.md](../SECURITY.md) |
| Contributing | [../CONTRIBUTING.md](../CONTRIBUTING.md) |
| CI recipe — copy-paste GitHub Actions for the token-free PR gate + nightly live lane | [../.claude/skills/cowork-harness/references/ci-recipe.md](../.claude/skills/cowork-harness/references/ci-recipe.md) |
| Releasing — the branch → PR → tag publish flow | [../RELEASING.md](../RELEASING.md) |
| Machine-readable project summary | [../llms.txt](../llms.txt) |
| Architecture decision records — the "why" behind a cross-cutting default (e.g. verification strictness, fidelity) | [docs/decisions/](./decisions/) |
