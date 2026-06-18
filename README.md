<p align="center">
  <img src="docs/assets/banner.png" alt="cowork-harness — headless, scriptable, CI-ready test harness for Claude Cowork skills" width="100%">
</p>

# cowork-harness

[![ci](https://github.com/yaniv-golan/cowork-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/yaniv-golan/cowork-harness/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node: >=20](https://img.shields.io/badge/node-%3E%3D20-339933.svg)](#quick-start)
[![Claude Code plugin](https://img.shields.io/badge/Claude_Code-plugin-F97316)](#drive-it-from-claude-code-companion-skill)
[![Built with Skill Creator Plus](https://img.shields.io/badge/Built_with-Skill_Creator_Plus-4ecdc4)](https://github.com/yaniv-golan/skill-creator-plus)
[![Agent Skills compatible](https://img.shields.io/badge/Agent_Skills-compatible-4A90D9)](https://agentskills.io)

Scriptable, CI-friendly test harness that reproduces **Claude Cowork's observable runtime contract** closely enough to test the skills you write — across many scenarios, headless, in CI — without the (locked) Desktop app. It reproduces not just Cowork's *behavior* but its *limitations*: sealed filesystem, default-deny egress, MCP-only cross-boundary — so a green test means green in real Cowork.

**Contents:** [Why it works](#why-this-works-for-skill-testing) · [Fidelity tiers](#fidelity-tiers-pick-per-scenario--per-ci-job) · [Quick start](#quick-start) · [Session + scenario](#two-files-session--scenario) · [Boundary](#sandboxing-container-vs-the-real-vm) · [Discovery](#discovery-marketplaces-plugins-skills-mcp) · [Testing & CI/CD](#testing--cicd) · [Maintenance](#maintenance-parity-between-releases) · [Docs](#documentation)

> **Requirements at a glance**
> - **Free demo (`replay`):** Node ≥ 20 — nothing else (no Docker, token, or Claude Desktop).
> - **Live tiers** (`container` default / `microvm` / `hostloop`): **Docker (arm64)** · **Claude Desktop opened once** (stages the agent — nothing is bundled) · a **Claude token** (real per-run cost; runs take minutes). The `protocol` tier skips Docker + the staged agent but still calls a real model, so it needs the token.
> - **Platform:** best on **macOS Apple Silicon**; **Windows is not supported** for the live tiers (use the token-free `replay`); `sync` and `microvm` are **macOS-arm64 only**. Full detail in [Quick start → prerequisites](#quick-start).

> **New here?** Read [docs/boundary.md](./docs/boundary.md) (the limitations model) and [docs/session.md](./docs/session.md) (the file you'll author).

> **What this is and isn't.** This is an *emulator of the contract*, not the Desktop runtime. Cowork's real session control plane lives behind the Desktop renderer's IPC (per-build UUID + `senderFrame` origin checks) and the app ships with remote debugging disabled (verified: `--remote-debugging-port` opens no listener; Electron `EnableNodeCliInspectArguments` fuse is OFF). So you **cannot** drive the real Apple Virtualization.framework microVM from a script. What you *can* faithfully reproduce is everything that actually changes how a **skill** behaves: the same agent binary in **cowork mode** (`CLAUDE_CODE_IS_COWORK=1` — there is no `--cowork` flag), the same mount layout, the same egress allowlist, and the same permission/question protocol. That's what this project does.

---

## Why this works for skill testing

A skill's behavior under Cowork is determined by four things, all reproducible outside the VM:

| Dimension | What Cowork does | How we reproduce it | Fidelity |
|---|---|---|---|
| **Agent** | Spawns the staged in-VM agent `claude-code-vm/<ver>/claude` in cowork mode (`CLAUDE_CODE_IS_COWORK=1` env — there is no `--cowork` flag) | Run the **same pinned agent**, **bind-mounted** from your Claude Desktop install's staged Linux/arm64 ELF (no npm path; override with `COWORK_AGENT_BINARY`) | **High** — same binary contract |
| **Mounts** | `/sessions/<id>/mnt/{uploads,.projects/<id>,.local-plugins,.remote-plugins}` | Recreate the same paths as bind mounts; skill-under-test discovered at the plugin mount, same as Cowork | **High** — same discovery path |
| **Egress** | gVisor netstack with a compiled domain allowlist (`vmAllowedDomains()` + `coworkEgressAllowedHosts`) | Default-deny egress proxy enforcing the **synced** allowlist | **Med-High** — allowlist-exact, transport-approximate |
| **Permissions / questions** | `onToolPermissionRequest` → `respondToToolPermission`; AskUserQuestion answered by the UI | The **Agent SDK `can_use_tool` control protocol** — the exact same channel — answered by your scenario script | **High** — same protocol Desktop uses |

The permission/question protocol is the backbone, and it's the *most stable* surface — it's the documented Agent SDK control protocol (`can_use_tool`, `hook_callback`, `mcp_message`, …). Everything fragile (agent version, mount paths, allowlist contents) is pushed into a **versioned baseline** that you re-sync per release. See [Maintenance](#maintenance-parity-between-releases).

---

## Fidelity tiers (pick per scenario / per CI job)

```
L0  protocol-only     claude -p stream-json on the host. No sandbox, no egress control.
                      Fastest. Tests skill logic + scripted answers. CI default for unit-style.

L1  container parity  Pinned agent in cowork mode inside an arm64 Linux container with the real
   (recommended)      mount layout and a default-deny egress proxy enforcing the synced allowlist.
                      Reproducible, CI-native (Docker/Podman). The faithful-yet-maintainable sweet spot.

L2  microvm parity    Optional. Agent inside a real Linux microVM (Lima/Apple-VZ) with a guest
   (opt-in, heavy)    default-deny iptables firewall funnelling to the same allowlist proxy as L1.
                      VM-grade escape isolation; egress transport equals L1's HTTP-CONNECT proxy —
                      no gVisor netstack reproduced. Not for CI; periodic high-fidelity checks only.

    ─── loop-mode overlays (orthogonal to L0/L1/L2: they pick WHERE the loop runs, not isolation) ───

    hostloop          Cowork's PRODUCTION split-execution: the agent loop runs host-side, while the
                      shell/web tools run in the container via the workspace SDK-MCP server
                      (mcp__workspace__bash). Reproduces the real host-loop boundary.

    cowork            Auto-picks hostloop vs container the way Cowork itself does, from GrowthBook
                      gate 1143815894 decoded in the synced baseline. "Do what real Cowork does."
```

Most skill testing runs **L1 (`container`)**. Use **L0 (`protocol`)** for fast inner-loop and pure-logic assertions; **L2 (`microvm`)** for VM-grade escape isolation of untrusted code (rare — it does **not** improve network-transport fidelity over L1); **`hostloop`/`cowork`** to reproduce Cowork's production split-execution model. Set the tier with `fidelity:` in a scenario or `--fidelity` on `skill`.

---

## Commands at a glance

Skill testing is the headline use, but the tool is a general harness over the Cowork runtime. Run any command with `--help` for its full flag reference.

| Command | What it does | Reach for it when… |
|---|---|---|
| `skill <folder> "<prompt>"` | Run a local skill/plugin folder once against the staged agent | ad-hoc "is the skill alive / does it do X?" — the fast inner loop |
| `run <scenario.yaml \| dir/>` | Run authored scenarios with `assert:` + a CI-ready exit code | you want a repeatable, **asserted regression test** |
| `chat <folder>` | Interactive multi-turn REPL against a skill (TTY) | debugging a multi-turn flow by hand |
| `record` / `replay` | `record` saves a control-protocol cassette (one scenario, or batch a `dir/`; `--rerecord-stale` refreshes only drifted ones; `--max-artifact-bytes` raises the 64 KiB inline-body cap); `replay` runs a cassette **file or a `dir/` of `*.cassette.json`** deterministically (`<file\|dir>`, `--cassette <file>` for the explicit single form; `--strict` fails on a stale one; exits on the worst verdict) | **token-free, Docker-free CI** from a once-recorded run |
| `verify-cassettes <file\|dir>` | Token-free CI gate over committed cassettes: a privacy scan (email/currency/domain → exit 1; whole-token allows via `--allow` / class-scoped `--allow-domain` / `--allow-email` / `--allow-file`) + a staleness check (`--staleness-only`). A dir argument scans `*.cassette.json` in that dir only (**non-recursive**) | gating **committed cassettes** against PII leaks + "edited the skill, forgot to re-record" |
| `verify-run <run-dir> <scenario.yaml>` | Re-evaluate a scenario's `assert:` against an already-kept run dir — **no live agent, no tokens, no Docker** (~1s) | iterating on a wrong assertion without a full live re-record |
| `trace <run-id>` | Digest a run's `events.jsonl` (`--tools`, `--gates`, `--dispatches` for the sub-agent dispatch tree + total) | "how many sub-agents *actually* dispatched, and which?" |
| `scaffold --from-run <id>` | Turn a kept run into a starter scenario YAML (gates→answers, artifacts→`file_exists`) | authoring a scenario from a real run instead of guessing |
| `lint <scenario.yaml>…` | Check scenarios for silent false-greens — assertions placed on the wrong CI lane, mixed content/live keys, missing `controlOut`-required keys (bundled `scenario.py`; needs python3 + PyYAML) | before committing a new scenario or after changing assertions |
| `assert --list` | List the available scenario assertions (generated from the schema) | "what can I assert?" without grepping the source |
| `decide` | Validate a decider against a sample question in ~2 s (no run) | sanity-check a `--decider-*` / `--answer` wiring before a long run |
| `gates` / `answer` | Stream / answer in-band gates for `--decider-dir` | a **driving agent** answers live questions via a Monitor |
| `boundary-check [baseline] [--session <file>]` | Prove the sandbox enforces Cowork's limitations; `--session` folds a session's `egress.extra_allow` into the probe allowlist | verifying the harness's own fidelity |
| `sync` / `list` | Derive/refresh & list platform baselines from the Desktop install | after Claude Desktop updates (baselines ship, so it's optional otherwise) |
| `doctor [--tier <t>]` | Read-only prerequisite check (Docker, staged agent, token, baseline); prints the exact `docker build` line if the agent image is missing | "can I run the live tiers — what's missing?" before a first live run |
| `vm <init\|status\|delete\|prune>` | Manage the L2 Apple-VZ / Lima microVM (`prune` removes orphaned VMs left by config/agent-version changes) | running `--fidelity microvm` |

There's also a **Python `cowork` pytest lane** (`python/`) for driving any of this from `pytest` beside your normal tests — see [`python/README.md`](./python/README.md).

---

## Test a local skill in one command

The fastest path — point at a **local folder**, no repo, no `claude plugin install`, no marketplace, no version bump, no cache layers. The folder is copied **fresh into the session on every run**, so you edit and re-run and your changes are live immediately:

```bash
# Auth once — export it, OR put it in a .env file (resolved: env > --dotenv > ./.env > <install>/.env):
#   cp .env.example .env   &&   echo "CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token)" >> .env
export CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token)

cowork-harness skill ~/my-plugin 'Use my-skill to do X'                    # single-quote: no $ expansion
cowork-harness skill ~/my-plugin --prompt-file ./prompt.txt               # prompt verbatim (raw bytes)
cowork-harness skill ~/my-plugin "..." --answer "which format=Markdown"   # script AskUserQuestion
cowork-harness skill ~/my-plugin "..." --fidelity protocol                # fast, no sandbox
cowork-harness skill ~/my-plugin "..." --dry-run                          # resolve & print the launch plan, don't run
cowork-harness skill ~/my-plugin "..." --keep                             # print the run dir to inspect
cowork-harness skill ~/my-plugin "..." --output-format json                      # machine-readable result on stdout
cowork-harness skill ~/my-plugin "..." --on-unanswered fail               # never fabricate an answer (CI/agents)
cowork-harness skill ~/my-plugin "..." --decider-cmd 'node answer.js'     # answer LIVE stochastic questions via a helper
cowork-harness skill ~/my-plugin 'review this deck' --upload deck.pdf      # attach a file → mnt/uploads (deck-review etc.)
cowork-harness skill ~/my-plugin "..." --session-id s1                     # pin a session…
cowork-harness skill ~/my-plugin '<next turn>' --session-id s1 --resume    # …then resume it (gated/checkpoint skills)
cowork-harness skill ~/my-plugin "..." --keep                            # then: trace the run
cowork-harness trace <run-id> --tools                                     # tool calls + sub-agent dispatches from events.jsonl
cowork-harness skill --help                                               # full per-command flag reference

cowork-harness chat ~/my-plugin                  # interactive multi-turn REPL (full harness: egress sandbox + control protocol)
# chat --raw  → native interactive cowork mode via `docker run -it` (needs Docker + the arm64
#               cowork-agent-base:1 image; the egress sandbox is NOT applied in --raw)
```

**Input policy — no silent false-greens.** When an AskUserQuestion arrives with no scripted
`--answer`, the policy is explicit: `fail` (error + the exact `--answer` to add — the default for
`run`/CI), `prompt` (ask at the TTY — the default for `skill` when interactive), or `first` (pick
option 1, loudly warn). Pick with `--on-unanswered`; left unset, `skill` is **adaptive** (`prompt` on
a TTY, `fail` when piped/CI) and `run` is always `fail`. Exit codes: `0`
pass · `1` assertion/agent failure · `2` usage /
unanswered-under-`fail` / boundary / runtime. After a run, the footer **echoes every auto-answered
question as a copy-pasteable `--answer "<q>=<choice>"` line** — run once exploratorily, then paste them
back to lock in a deterministic re-run.

**Output.** `skill` **renders the agent's work** (assistant text + tool calls) and a metered footer —
you see *what it did*, not just a green. `run` is verdict-first but **prints the failing transcript
inline** on a `FAIL` (no spelunking `runs/…`). Tune with `--quiet` (verdict only) / `--verbose`/`-V`
(+ thinking, tool inputs, sub-agent tree). `--output-format json` emits a stable machine envelope on stdout
(`{tool, version, command, ok, results[], error}`; errors are `{ok:false, error:{category,message,hint}}`)
— see [SPEC §11](./SPEC.md). Human output is stderr, machine output is stdout, so `--output-format json` pipes
cleanly. Honors `NO_COLOR`.

**Test a specific local plugin version** — just point at the folder at that version (it's copied fresh; no install, no version bump). Add more with `--plugin`:
```bash
cowork-harness skill ~/my-plugin "..." --plugin ~/other-plugin
```

**Test a specific local marketplace version** — point at the marketplace dir (the one with `.claude-plugin/marketplace.json`); it's registered fresh each run via `claude plugin marketplace add`, no clone/cache:
```bash
cowork-harness skill --marketplace ~/my-marketplace --enable my-skill@my-marketplace "Use my-skill"
```

It mounts the folder(s) at the Cowork plugin path, runs the staged agent in cowork mode, and prints PASS/RESULT (add `--keep` to print the run dir, or `--output-format json` for the machine-readable result). No YAML to author. (Author `scenarios/*.yaml` only for repeatable, asserted regression tests.)

## Quick start

**Install from npm:**

```bash
npm install -g cowork-harness    # puts the `cowork-harness` command on your PATH
```

**Or build from source:**

```bash
git clone https://github.com/yaniv-golan/cowork-harness && cd cowork-harness
npm install && npm run build && npm link    # puts the `cowork-harness` command on your PATH
# …or skip the link and call it directly: node dist/cli.js <cmd>
```

**Try it in 10 seconds — no token, no Docker.** A committed synthetic cassette replays on a fresh clone, so you can see a green run before setting anything up:

```bash
cowork-harness replay --cassette examples/replays/example-pdf-skill.cassette.json
```

Only the committed-cassette `replay` above is fully self-contained. Live `run`/`skill` need the prerequisites in the next section — and note the `protocol` tier skips Docker and the staged agent but **still calls a real model** (via the host `claude`), so it needs the auth token.

### Drive it from Claude Code (companion skill)

This repo ships a **companion skill** (`.claude/skills/cowork-harness/`) that teaches an agent how to drive the harness — author scenarios, pick a fidelity tier, script answers, place assertions in the right CI lane, and avoid the "✓ passed ≠ correct" traps. Install it into Claude Code via the bundled marketplace:

```bash
/plugin marketplace add yaniv-golan/cowork-harness
/plugin install cowork-harness@cowork-harness
```

The skill **self-bootstraps the CLI**: if `cowork-harness` isn't on your PATH it falls back to `npx cowork-harness@>=0.5.0` (a version floor that fails loud rather than silently fetching a too-old CLI; Node ≥ 20). Tiers above `protocol` still need Docker/Lima and a Claude Desktop agent binary — see the prerequisites below.

It also follows the open [Agent Skills](https://github.com/vercel-labs/skills) spec, so it installs cross-editor (Cursor, Codex, OpenCode, …) by pointing the `npx skills` CLI at `.claude/skills/cowork-harness` in this repo. (Working *inside* this repo, the skill auto-loads as a project skill — no install needed.)

**Prerequisites for anything above `protocol` fidelity** (the `protocol` tier skips items 1–2 — no Docker, no staged agent — but still calls a real model via the host `claude`, so it needs item 3, the auth token; only a committed-cassette `replay` needs nothing at all):
1. **Claude Desktop, opened once.** The Cowork agent binary is **bind-mounted from your own install** at run time — nothing Anthropic-owned is bundled. Open Cowork once so the agent ELF is staged (`…/claude-code-vm/<ver>/claude`); the harness auto-detects it, or set `COWORK_AGENT_BINARY=<path>` to point at it. Without a staged agent, container/cowork runs fail with "Open Cowork once to stage it…".
2. **Docker (arm64)** + the agent image: `docker build --platform linux/arm64 -t cowork-agent-base:1 -f docker/Dockerfile.agent .` (override the tag with `COWORK_AGENT_IMAGE`). The `-f docker/Dockerfile.agent .` paths are **repo-relative** — run it from a source checkout, not a global `npm install -g` (where the Dockerfile lives under the package dir).
3. **An auth token** — either `export CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token)` or a **`.env`** file (copy `.env.example` → `.env`; gitignored). The token resolves in priority order: exported env > `--dotenv <path>` > `./.env` (cwd) > `<install>/.env` (the package root), so a `npm link`ed install works from any directory. Keep `.env` at a working-dir or install root, never inside a mounted skill/project folder. (Use `--dotenv`, not `--env-file` — Node reserves the latter.)

> `sync` (below) is **optional for a first run** — the repo ships `baselines/desktop-*.json`, so `baseline: latest` already resolves. Run `sync` only to refresh the platform baseline after Claude Desktop updates. (`sync` is **macOS-only** today; on Linux/Windows use the committed baselines — they work cross-platform.)

```bash
# 1. (Optional · macOS-only) Sync a platform baseline from your installed Claude Desktop.
#    Skippable on a first run — the repo ships baselines; `baseline: latest` already resolves.
cowork-harness sync            # writes baselines/desktop-<appVersion>.json
cowork-harness sync --diff     # show what changed vs the committed baseline

# 2. Run a scenario (L1 container by default)
cowork-harness run examples/scenarios/example-pdf-skill.yaml   # minimal: plumbing only
cowork-harness run examples/scenarios/csv-metrics.yaml         # worked example: a real skill runs a bundled producer end-to-end
cowork-harness run examples/scenarios/csv-fx-normalize.yaml    # graceful degradation: the skill's network step is blocked, it falls back

# 3. Run a whole suite in CI (machine-readable results, CI-ready exit code)
cowork-harness run examples/scenarios/ --output-format json

# 4. Record a cassette once, then replay it deterministically (no token, no Docker)
#    (without --out, the cassette is named after the scenario — its `name:`, or the filename)
#    Commit cassettes under examples/replays/ (this repo) or cassettes/ (conventional skill-repo name).
cowork-harness record examples/scenarios/example-pdf-skill.yaml --out examples/replays/example-pdf-skill.cassette.json
cowork-harness replay --cassette examples/replays/example-pdf-skill.cassette.json

# A committed synthetic fixture is ready to replay on a fresh clone (no record step needed):
cowork-harness replay --cassette examples/replays/example-pdf-skill.cassette.json

# Cassettes are COMMITTED fixtures — record against synthetic data, and gate them in CI:
cowork-harness verify-cassettes examples/replays/   # privacy scan (email/currency/domain) + staleness; exit 1 on a finding
```

> **Privacy:** a cassette snapshots the transcript and the `outputs/` JSON bodies, so it's committed PII
> surface. Record against synthetic inputs; opt into record-time **redaction** with a `.cowork-redact.json`
> (verdict-preserving — `record` refuses to write if redaction would flip an assertion); and gate every
> commit with `verify-cassettes` (the always-on scan, `--allow <regex>` for synthetic/public names). See
> [docs/cassette.md](./docs/cassette.md).

> **What replay checks.** A cassette bundles BOTH recorded protocol directions: the child→driver
> `events` stream AND the driver→child `controlOut` decision responses. `replay` re-runs the
> orchestration from both, re-evaluates the **content** assertions, and re-exercises
> `serializeDecision` as a token-free O7 guard (the AskUserQuestion `{questions,answers}` answer-shape
> invariant). Evaluated on replay: `transcript_*`, `tool_*`, `subagent_*`, `dispatch_count_max`,
> `result`. **`question_asked`, `questions_count_max`, and `gate_answers_delivered` are also evaluated —
> but only when the cassette carries `controlOut` (full-fidelity)**; old cassettes without it get a
> loud warning and those three keys are excluded (not vacuously passed). **Filesystem assertions
> (`file_exists`, `user_visible_artifact`, `artifact_json`) are evaluated when the cassette carries an
> `artifacts` manifest** (`record` snapshots `outputs/`; `artifact_json` needs the small JSON body
> inlined) — and skipped (loud) on older, manifest-less cassettes. Genuinely live-only keys are always
> skipped (no network/live-FS in a replay): `egress_*`, `expect_denied`, `no_delete_in_outputs`,
> `self_heal_ran`, `transcript_no_host_path` — keep those in a periodic live `run`. The authoritative
> list is `contentKeys`; see [docs/cassette.md](./docs/cassette.md) for the full guide.

**Drive it from pytest** — the `cowork` lane (see [`python/README.md`](./python/README.md)):
`@pytest.mark.cowork` + a `cowork` fixture over the `--output-format json` surface, selectable with
`-m cowork` (opt-in, beside your fast tests).

---

## Two files: session + scenario

Configuration splits the way Cowork itself splits — *what you set up before the first prompt* vs. *what you ask*:

- **Session setup** (`sessions/*.yaml`) — everything you'd configure in Cowork's pre-prompt setup: model, effort, thinking budget (`max_thinking_tokens`), permission mode, **mounted work folders / projects**, uploaded files, and **discovery** (marketplaces, plugins, skills, MCP servers). Hand-authored, one per project, reused across scenarios.
- **Scenario** (`scenarios/*.yaml`) — the prompt, the **scripted answers**, and the assertions. References a session.

> **Worked examples to copy** live under [`examples/`](./examples/) (see [examples/README.md](./examples/README.md)). `examples/skills/csv-metrics/` + `examples/sessions/csv-metrics.yaml` + `examples/scenarios/csv-metrics.yaml` is a complete, non-trivial skill running end-to-end: the agent loads the skill, runs its **bundled producer** (`scripts/metrics.py`, stdlib-only so it works under default-deny egress), and writes a structured `outputs/metrics.json` + a `outputs/summary.md`. The scenario asserts the structure (skill loaded, producer ran, artifacts exist); the paired [`python/test_csv_metrics_lane.py`](./python/test_csv_metrics_lane.py) adds a predicate over the JSON content (`assert_artifact_json`). Read those files to see the whole loop — discovery → run → deliverable → assert — that every real skill follows. (`examples/scenarios/example-pdf-skill.yaml` is the minimal counterpart: harness plumbing, placeholder skill.)
>
> **Worked example #2 — graceful degradation under the sealed network.** `examples/skills/csv-fx-normalize/` + `examples/scenarios/csv-fx-normalize.yaml` shows the property you can *only* test by running against the real boundary: the skill's job needs the network (fetch an FX rate to convert EUR→USD), Cowork's default-deny egress blocks it, and the skill **falls back to source currency instead of crashing or hanging**. Its `egress_denied: api.frankfurter.app` assertion is backed by a *real* fetch the skill makes — not a synthetic probe — and `result: success` + the delivered artifact prove the fallback. This is the right way to assert egress: cause a genuine denial through real behavior.

```yaml
# scenarios/pdf.yaml   ← the filename is the test's identity (name: is an optional override)
baseline: latest                       # platform baseline (auto-synced from Desktop)
session: ../sessions/default.yaml     # pre-prompt setup, resolved relative to THIS file
fidelity: container                   # protocol | container | microvm

prompt: |
  Summarize report.pdf and write the action items to outputs/actions.md

# Scripted answers — the can_use_tool control channel, same as Desktop's question UI
answers:
  - when_question: "Which output format"   # substring/regex on AskUserQuestion
    choose: "Markdown"
  - when_tool: Bash                        # tool-permission decisions
    allow_if: "!command.includes('rm -rf')"
    else: deny
  - when_tool: Write
    decide: allow

expect_denied: ["evil.example.com"]       # assert this host is denied egress

assert:
  - transcript_contains: "action items"
  - file_exists: outputs/actions.md
  - tool_called: Write
  - egress_denied: evil.example.com
  - result: success
```

```yaml
# sessions/default.yaml  (abridged — see the file for every field)
# Relative paths below resolve from THIS file's dir (absolute and ~ are used as-is).
model: claude-opus-4-8
effort: high
max_thinking_tokens: 8000
permission_mode: default
permission_parity: cowork                   # cowork (allow unscripted tool calls, the default) | strict (deny unscripted)
folders:
  - { from: ~/code/myproject, to: proj1 }   # a work folder / Space -> mnt/.projects/proj1
uploads:
  - ~/Downloads/report.pdf                  # -> mnt/uploads
plugins:
  marketplaces: ["https://github.com/anthropics/claude-code.git"]
  # local_marketplaces: ["../my-marketplace"]  # LOCAL marketplace dirs (each with a marketplace.json)
  local_plugins: ["../skills/my-pdf-skill"] # mounted at mnt/.local-plugins/cache under the synthetic "local" marketplace
  enabled: ["my-pdf-skill@local"]           # name@marketplace: a local_plugins entry is referenced as <plugin>@local
mcp:
  config: ../data/mcp.json                  # standard mcpServers map (--mcp-config) — the way to attach an MCP server
egress:
  extra_allow: ["api.github.com"]
```

Multiple scenarios × sessions × platform baselines = your regression matrix. Drop YAML in `scenarios/` and CI runs them all.

## Sandboxing: container vs. the real VM

Cowork runs the agent in an **Apple Virtualization.framework microVM** (separate kernel). The harness's default `container` tier uses an OS container (shared kernel, namespaces/cgroups). For **testing skills you wrote**, that's faithful where it counts — same agent binary, same cowork mode, same mount layout, same egress allowlist, same permission protocol — because skill behavior is agent-loop + tool behavior, all kernel-invisible. The container is the right default precisely because it's CI-native; a VM needs nested virtualization most shared CI runners don't have.

It only *matters* to use a real VM when you're testing **isolation of untrusted skills** (container escape is easier than VM escape), or a skill that probes kernel internals. For that, the `microvm` tier runs the same agent in a real Linux microVM via **Lima with `vmType: vz` — the same Apple Virtualization.framework Cowork uses** (highest off-app fidelity). This tier is **macOS arm64 only** (it needs Apple's hypervisor); there is no Linux/Firecracker path. The launch contract is identical to the container tier; only the isolation boundary differs — egress is the same allowlist proxy as the container tier (no gVisor netstack at any harness tier). See [DESIGN.md — Architecture at a glance](./DESIGN.md#architecture-at-a-glance).

## Discovery: marketplaces, plugins, skills, MCP

The agent we run **is** `claude-code` (the same binary Cowork stages in `claude-code-vm/<ver>`), so it discovers extensions from the same roots — verified against the staged binary:

| Kind | Real root | How the harness populates it | Override |
|---|---|---|---|
| Plugins / marketplaces | `CLAUDE_CONFIG_DIR/plugins`, `plugin_marketplaces` + Cowork mounts `.local-plugins/cache`, `.remote-plugins` | session `plugins.local_plugins`/`remote_plugins` → mounted at those paths; `marketplaces`/`local_marketplaces`/`enabled` → `settings.json` | point `plugins.config_dir` at a test dir |
| Skills | `CLAUDE_CONFIG_DIR/skills` + skills inside plugins | session `skills.local` staged into the config dir; plugin skills discovered at the mount | swap the config dir or local dirs |
| MCP servers | `.mcp.json` / `--mcp-config`, `enabledMcpjsonServers` | session `mcp.config` → `--mcp-config`; `mcp.enabled` → `settings.json` | use a test `mcp.json` |

The harness builds a **clean managed `CLAUDE_CONFIG_DIR` per run** (with a generated `settings.json`) so discovery is hermetic and reproducible — nothing leaks from your real `~/.claude`. Pin `plugins.config_dir` to a fixed dir if you want to reproduce a specific real setup instead.

> Fidelity note: in real Cowork, stdio MCP servers run **host-side** (split execution — the VM shell is sealed, host MCP servers get full env). At the `container` tier the harness runs them alongside the agent for simplicity; if your skill depends on that host/VM split, document it as an unreproduced gap — `microvm` runs MCP inside the guest too, so no harness tier reproduces the split.

---

## What you get out (inspectable output)

Every run writes `runs/<scenario>/<sessionId>/`:

```
events.jsonl        full stream-json event log (child→driver; the cassette source)
control-out.jsonl   driver→child control_responses (the other cassette half)
run.jsonl           harness-observability log: decisions (+who decided), sub-agent dispatch
                    tree, egress, transcript, cost  (replaces transcript.json/decisions.jsonl)
trace.json          structured run trace: steps, questions, sub-agents, egress, decisions, cost
egress.log          raw allow/deny per outbound connection (microvm: at top level; container: under
                    proxy/ — the allow/deny decisions are also folded into run.jsonl/result.json)
result.json         assertion results + decisions + sub-agents + cost/usage + exit status
agent.stderr.log    the agent process's stderr (auth errors, flag rejects)
```

Secrets (the injected OAuth token / API key) are scrubbed from every persisted log by value.

---

## Architecture

```
                      ┌────────────────────────────────────────────────┐
  scenario.yaml ────► │  cowork-harness  (TypeScript CLI)              │
                      │    baseline loader ◄── baselines/desktop-*.json│
                      │    runtime selector  ──►  L0 / L1 / L2         │
                      └───────────────────────┬────────────────────────┘
                                              │  spawns + speaks stream-json
                      ┌───────────────────────▼────────────────────────┐
                      │  Agent:  claude -p   (CLAUDE_CODE_IS_COWORK=1) │
                      │    --input-format / --output-format stream-json│
                      │    cwd = /sessions/<id>/mnt                    │
                      │    mnt/uploads · mnt/.projects/* · plugins     │
                      └───────────────────────┬────────────────────────┘
            decision control request          │  outbound network (egress)
            (tool · question · dialog)        │  default-deny → allowlist
                      ┌───────────────────────▼────────────┐    ┌────────────────────────┐
                      │  AgentSession ──► Decider ──► Run  │    │  Egress proxy          │
                      │  protocol · policy · turn loop     │    │  default-deny;         │
                      │  + RunRecord                       │    │  allowlist = synced    │
                      │                                    │    │  vmAllowedDomains()    │
                      └────────────────────────────────────┘    └────────────────────────┘
```

- **AgentSession** speaks the Agent SDK control protocol over stream-json, emitting a typed event
  stream. When the agent emits a decision request (a tool permission, an `AskUserQuestion`, or a
  `request_user_dialog`/`elicitation`), the **Decider** resolves it — scripted `answers:` first, then
  the cowork/strict permission default, then the `on_unanswered` policy (fail/prompt/first) — and
  **Run** drives the turn loop and builds the `RunRecord` (decisions, the sub-agent dispatch tree,
  egress, cost).
- **Egress proxy** (L1/L2) enforces the synced allowlist; default-deny. Domains come from the baseline, plus per-scenario `extra_allow`.
- **The platform baseline** is the single source of release-specific truth. Code rides the stable protocol; data tracks the release.

See [DESIGN.md](./DESIGN.md) for the full parity matrix, the known deltas vs. real Cowork, and the threat-model notes on egress.

---

## Testing & CI/CD

The harness is built to *be* your skills' test suite, and it ships with its own. Two layers:

### Your skills' suite

Author scenarios in your own `scenarios/` dir, run the lot, get a non-zero exit on any failure:

```bash
cowork-harness run scenarios/            # your repo's scenarios; runs every *.yaml, CI-ready exit code
```

The provided [GitHub Actions workflow](.github/workflows/ci.yml) runs a **four-stage pipeline**. The **unit** stage is the token-free gate you can copy into your skill repo; the `boundary`, `scenarios`, and `parity-drift` stages are this repo's own fidelity self-tests and are not directly portable (they build the harness's Docker image and run harness-specific e2e scenarios — see [`ci-recipe.md`](./.claude/skills/cowork-harness/references/ci-recipe.md) for the skill-repo template):

| Stage | Runs | Needs | Gates |
|---|---|---|---|
| **unit** | format check · typecheck · unit tests · build · CLI smoke · token-free `replay` · `verify-cassettes` · `lint` | nothing | every push/PR |
| **boundary** | builds the pinned agent image, brings up the default-deny network, runs `boundary-check` | Docker, arm64 runner | proves the sandbox enforces Cowork's limits — **no API key** |
| **scenarios** | the live scenario suite at `container` fidelity, uploads transcripts/egress logs as artifacts | `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_OAUTH_TOKEN`) | fork PRs: the whole job is skipped (`if:` guard); same-repo without a key: warns and exits 0 |
| **parity-drift** | reminder to re-`sync` when Desktop updates | nothing | informational, never blocks |

This ordering means cheap checks fail fast, the **boundary parity gate runs without secrets** (so forks get it too), and expensive live runs only happen when a key is present.

### The harness's own suite

```bash
npm run ci            # typecheck + build + test (Stage 1 locally; run format:check separately)
npm test              # vitest: decider, egress allowlist, launch plan, example validation
cowork-harness boundary-check   # Stage 2: self-verify the sandbox (needs Docker)
```

Unit tests cover the scripted-answer logic, the egress allowlist matcher, the session→launch-plan materialization (mounts + discovery settings + env-strip), and a **schema guard** that fails if any shipped baseline/session/scenario stops validating. Add a test alongside any new schema field or `Decider` rule — see [CONTRIBUTING.md](./CONTRIBUTING.md).

> Copy your starting scenarios/sessions from **`examples/`**. The **`e2e/`** directory is the harness's *own* fidelity self-tests (smoke scenarios per tier) — not a template to copy.

### Reproducibility knobs

- `COWORK_LOCKDOWN=off` — relax container hardening for debugging (default `on`). With it `on`, an L2 microVM whose guest egress firewall fails to apply **aborts loudly** rather than running un-isolated.
- `COWORK_CONTAINER_RUNTIME=podman` — use Podman instead of Docker.
- `COWORK_AGENT_IMAGE=<tag>` — override the agent image name (default `cowork-agent-base:1`); `COWORK_AGENT_BINARY=<path>` — override the auto-detected staged agent ELF.
- `COWORK_HARNESS_DECIDER_DIR_POLL_MS` / `_TIMEOUT_MS` — tune the `--decider-dir` rendezvous poll/backstop; `COWORK_HARNESS_DECIDER_CMD_TIMEOUT_MS` / `COWORK_HARNESS_LLM_TIMEOUT_MS` — backstop a hung `--decider-cmd` helper / `--decider-llm` model call (default 600 s, fail loud); `COWORK_HARNESS_DIALOG_TIMEOUT_MS` — override the 6 s dialog auto-cancel.
- `COWORK_HARNESS_RUNS_DIR` — relocate the `runs/` output root (so `trace` resolves runs from any directory).
- **Networking / loop:** `COWORK_EGRESS_PROXY` overrides the egress-proxy URL injected into the sandbox; `COWORK_PROXY_IMAGE` overrides the egress proxy Docker image name (default `cowork-egress-proxy:1`); `COWORK_DOCKER_NETWORK` pins the Docker network the agent container joins; `CLAUDE_FORCE_HOST_LOOP=1` forces the host-loop path regardless of the baseline's loop decision (the `cowork` tier's auto-pick). `COWORK_LIMACTL` overrides the `limactl` binary path (default `/opt/homebrew/bin/limactl`).
- **Strictness escape hatches** (the harness fails loud by default): `COWORK_HARNESS_SOFT_MISSING=1` downgrades a missing mount source from a hard error to warn-and-exclude; `COWORK_HARNESS_ALLOW_CONFIG_DIR_WRITE=1` permits writing into an existing pinned `plugins.config_dir` (otherwise refused, to avoid clobbering a real Claude config).
- **Secret scrubbing:** `COWORK_HARNESS_SCRUB_KEYS=<KEY1,KEY2>` adds extra env-var names whose values are redacted from logs (beyond the known auth tokens + `ANTHROPIC_CUSTOM_HEADERS`); `COWORK_HARNESS_SCRUB_VALUES=<v1,v2>` redacts literal values regardless of env. **Committed-cassette redaction:** `COWORK_HARNESS_REDACT_PATTERNS=<rx1,rx2>` / `COWORK_HARNESS_REDACT_KEYS=<k1,k2>` extend the privacy layer that scrubs recorded `controlOut` before a cassette is written for commit.
- L2 microVM: `COWORK_VM_GATEWAY` overrides the Lima host-proxy gateway IP (default `192.168.5.2`); `COWORK_VM_PROXY_PORT` the proxy port. The Lima instance is named `cowork-vm-<config-hash>` (a config change → a fresh VM); `COWORK_LIMA_INSTANCE` pins a fixed name, and `vm prune` removes orphaned ones.
- Pin `baseline: desktop-<ver>` and `model:` in a session for byte-stable runs; use `latest` to track.

## Maintenance: parity between releases

This is the part built for longevity. The fragile, release-specific facts live in **one JSON baseline**; the orchestration code rides the stable stream-json protocol.

When a new Claude Desktop ships:

```bash
cowork-harness sync --diff
```

`cowork-sync` reads your **live install** and the **app.asar** and re-derives the baseline:

| Baseline field | Source (auto-detected) |
|---|---|
| `agentVersion` | `~/Library/Application Support/Claude/claude-code-vm/.sdk-version` |
| env-strip list | `app.asar` main bundle (BG env-strip) |
| `mountLayout` | `app.asar` (`{uuid,name,mountPath,hostPath}` model) |
| `egress.allowDomains` | `app.asar` `vmAllowedDomains()` + `firewallAlso` + `config.json:coworkEgressAllowedHosts` |
| `networkMode` | `config.json:coworkNetworkMode`, asar `vm_network_mode` |
| `requireFullVmSandbox` | `config.json:lastSeenRequireCoworkFullVmSandbox` |

The diff shows exactly what moved (agent bump, allowlist change, new mount). You review, commit the new `baselines/desktop-<ver>.json`, and the container pin updates automatically from the baseline. Parity drift then surfaces as **test diffs**, not silent rot.

> The sync script is the maintenance contract. If an Anthropic release changes something the sync script doesn't yet read, `sync --diff` flags an `unknown delta` from the asar fingerprint so you know to extend it — rather than parity quietly degrading.

---

## Limitations

- **Not the full Desktop network transport.** L1 is a container, not a VM; L2 *is* a real Apple-VZ microVM but still does not reproduce Cowork's gVisor netstack — its egress is the same allowlist proxy as L1 (with a guest iptables firewall in front). If your skill depends on VM-kernel specifics, validate at L2; if it depends on packet-level gVisor behavior, no tier reproduces it.
- **Cowork in-guest context is partial.** Desktop supplies host-loop staging, runtime `mountPath` RPC, and the bridge. We reproduce the *filesystem and cowork mode*, not those host-side services. Skills that call Desktop-only host RPCs won't run here (they wouldn't be portable anyway).
- **The agent binary is the staged ELF** (`claude-code-vm/<ver>/claude`), **bind-mounted** from your own Claude Desktop install — nothing Anthropic-owned is bundled or installed. There is **no npm path**; override the path with `COWORK_AGENT_BINARY`. Check licensing/ToS for your use.
- **Egress fidelity is allowlist-exact, transport-approximate** at L1 and L2. Domain allow/deny matches Cowork; the packet-level gVisor netstack is reproduced at neither — both use a default-deny allowlist proxy (L2 adds a guest iptables firewall).

These are documented per-tier in [DESIGN.md](./DESIGN.md) so a green test means what you think it means.

---

## For AI agents

This repo is built to be driven by agents, not just read by humans:

- **[AGENTS.md](./AGENTS.md)** — the canonical agent-instructions file (architecture seams, the build gate, invariants, ethos). Read it before changing code. Also indexed in **[llms.txt](./llms.txt)**.
- **Companion skill** — [`.claude/skills/cowork-harness/`](./.claude/skills/cowork-harness/SKILL.md) teaches an agent to drive the harness; install it via the marketplace (see [above](#drive-it-from-claude-code-companion-skill)).
- **Machine-readable interfaces** — stable `--output-format json` envelope on stdout, deterministic exit codes (`0`/`1`/`2`), and `--help` on every command.
- **JSON Schemas** — [`schema/scenario.schema.json`](./schema/scenario.schema.json) and [`schema/session.schema.json`](./schema/session.schema.json) describe every field of the YAML you author (generated from the source schemas; `npm run schema`).

---

## Documentation

| Doc | Read it for |
|---|---|
| [docs/README.md](./docs/README.md) | The docs index — a one-line map of every guide below. |
| [docs/boundary.md](./docs/boundary.md) | The limitations model — sealed FS, default-deny egress, MCP-only crossing; how each tier enforces it; how to verify. |
| [docs/session.md](./docs/session.md) | Every `sessions/*.yaml` field and its Cowork mapping. |
| [docs/scenario.md](./docs/scenario.md) | `scenarios/*.yaml` — prompt, scripted answers, assertions. |
| [docs/cassette.md](./docs/cassette.md) | `record`/`replay` cassettes — what replay checks, which assertions are skipped. |
| [docs/decider-dir.md](./docs/decider-dir.md) | The `--decider-dir` recipe — a driving agent answers live gates in-band via `gates`/`answer` + a Monitor. |
| [docs/discovery.md](./docs/discovery.md) | Where plugins/skills/MCP are found + overrides. |
| [docs/maintenance.md](./docs/maintenance.md) | Parity across Desktop releases via `sync`. |
| [DESIGN.md](./DESIGN.md) | Architecture deep-dive + full parity matrix. |
| [SPEC.md](./SPEC.md) | The authoritative testable contract (scenario/session schema, `RunResult`, exit codes). |
| [CHANGELOG.md](./CHANGELOG.md) | Release history. |
| [python/README.md](./python/README.md) | The `cowork` pytest lane for driving the harness from Python. |
| [SECURITY.md](./SECURITY.md) | Threat model — the sandbox is a fidelity fixture, not a security boundary. |

## Status

**Verified end-to-end against the live staged agent (2.1.177 / asar 1.13576.1).**

- ✅ **Three isolation tiers (L0/L1/L2) + two loop-mode overlays** — `protocol` (L0 control loop), `container` (L1 sandboxed arm64 + per-run default-deny egress sidecar), `microvm` (L2 real Apple-VZ Linux microVM + guest firewall); plus the loop-mode overlays `hostloop` (production split-execution: agent loop on host, shell/web via the workspace SDK-MCP server) and `cowork` (auto-picks host-loop vs container the way Cowork does — gate `1143815894`). Egress enforced at container/microvm/hostloop; `boundary-check` reports **ALL CONSTRAINTS ENFORCED**.
- ✅ **Three-seam driver** — `AgentSession` (control protocol) → `Decider` (scripted + `on_unanswered` policy, no silent false-greens) → `Run` (turn loop, sub-agent dispatch tree, `RunRecord`). Multi-turn `chat`, deterministic cassette `record`/`replay` (no token), `run.jsonl`/`trace.json` logging with secret-scrub.
- ✅ **Answering live questions, every way you'd need** — `--decider-llm --intent "<one line>"` (a small model picks per question, steered by your test intent — the ergonomic default; non-determinism is flagged so a green isn't mistaken for a scripted pass), `--answer-policy <yaml>`/`--answer "rx=c"` (declarative regex→label, deterministic CI), `--decider-cmd '<helper>'` (custom logic — the Python `serve_decider(fn)` adapter pre-builds the wire loop so the helper writes only the decision), and **`--decider-dir <dir>`** (the *driving agent* answers each gate **in-band** with full context — it arms a Monitor on `cowork-harness gates <dir> --follow` and replies with `cowork-harness answer <dir> --gate <N> --choose <label>`; the session-under-test stays live, no resume/re-worded question — binary-verified). Every channel keeps stdout free, so all compose with `--output-format json`. A question is **never silently answered with option 1** — unhandled fails loud. Validate any decider in ~2s with `cowork-harness decide`.
- ✅ **Sub-agent aggregation + `trace`** — recognizes the real `Agent` dispatch tool (binary-verified; `Task` is its alias) so `subagent_dispatched`/`dispatch_count_max` fire under `--fidelity cowork`, excluding the `TaskCreate` todo list; `cowork-harness trace <id> --tools` digests `events.jsonl` (each tool row now shows its **result status** `ok`/`error`), and `trace <id> --gates` shows the gate lifecycle (**question → injected answer → delivered result**); `result.json`/`--keep` surface the deep `mnt/outputs` deliverable path.
- ✅ **Answer delivery is verified, not assumed** — an AskUserQuestion answer is injected as the binary's full tool input (`{questions, answers}`, ELF-verified), so the answer actually reaches the model; `RunResult.gateDeliveries[]` + the `gate_answers_delivered` assertion catch any delivery failure, and `RunResult.toolCounts` gives the **truthful** per-tool call count (host-routed `WebSearch` shows here, not the always-0 `usage.server_tool_use`).
- ✅ **Binary-grounded fidelity** — cwd `/sessions/<id>`, the three-channel MCP model (`--mcp-config` honored in plain cowork mode; host/API-routed `web_fetch`; SDK-server delivery), host-loop tool partition, auth-env token-only drop, and production GrowthBook gates pinned per release.
- ✅ The agent binary is **bind-mounted from your own install** at run time — nothing Anthropic-owned is in any image or distributed.
- ✅ **File provision & session resume** — `--upload <file>` / `--folder <dir>` attach files & connect folders (`mnt/uploads`, `mnt/.projects`); `--session-id <id>` + `--resume` persist and continue a session via the agent's *native* resume (binary-verified), so checkpoint-and-resume gated skills are testable. Demonstrated end-to-end in the live-contract suite (`test/live-contract.test.ts`: codeword established → resumed → recalled).
- ✅ **The full unit suite + the live-contract suite green**; a `cowork` pytest lane (`python/`) for skill authors.
- ℹ️ **Auth:** a `claude setup-token` OAuth token (or `ANTHROPIC_API_KEY`), provided via the env, `--dotenv <path>`, `./.env`, or the install's own `.env` (gitignored; keep it out of mounted folders). It's passed into the sandbox **off the process argv** (Docker: `-e KEY` inherit-by-name; microVM: a stdin prologue) so the token isn't visible via `ps`/`/proc`, scrubbed from logs, never persisted in a runtime path; the token-only path mirrors the desktop. A fresh `CLAUDE_CONFIG_DIR` alone breaks local OAuth.

See [SPEC.md](./SPEC.md) (the testable contract), [DESIGN.md](./DESIGN.md) (architecture + parity), and [CHANGELOG.md](./CHANGELOG.md).
