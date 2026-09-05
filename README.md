<p align="center">
  <img src="https://raw.githubusercontent.com/yaniv-golan/cowork-harness/main/docs/assets/banner.png" alt="cowork-harness — headless, scriptable, CI-ready test harness for Claude Cowork skills" width="100%">
</p>

# cowork-harness

[![ci](https://github.com/yaniv-golan/cowork-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/yaniv-golan/cowork-harness/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node: >=22](https://img.shields.io/badge/node-%3E%3D22-339933.svg)](./docs/cli.md#quick-start)
[![Claude Code plugin](https://img.shields.io/badge/Claude_Code-plugin-F97316)](./docs/companion-skill.md)
[![Built with Skill Creator Plus](https://img.shields.io/badge/Built_with-Skill_Creator_Plus-4ecdc4)](https://github.com/yaniv-golan/skill-creator-plus)
[![Agent Skills compatible](https://img.shields.io/badge/Agent_Skills-compatible-4A90D9)](https://agentskills.io)

> **Unofficial.** An independent project, not affiliated with, endorsed by, or supported by Anthropic.
> "Claude" and "Claude Cowork" are Anthropic's. This harness emulates Cowork's *observable runtime
> contract* and drives Anthropic's own agent binary from your local Claude Desktop install — it
> bundles no Anthropic code, and it is not Cowork.

Scriptable, CI-friendly test harness that reproduces **Claude Cowork's observable runtime contract** closely enough to test the skills you write — across many scenarios, headless, in CI — without the (locked) Desktop app. It reproduces not just Cowork's *behavior* but its *limitations*: sealed filesystem, default-deny egress, MCP-only cross-boundary — so a green test has cleared the constraints that break skills in Cowork. That is a far stronger signal than a bare `claude -p` run, and it is not a guarantee: this is an emulator of the contract, and the deliberate divergences are catalogued in [docs/fidelity-gaps.md](./docs/fidelity-gaps.md).

And because every run is recorded, you get the thing a transcript can't give you: **evidence of what the agent actually did, not what it said it did** — which skill was invoked (if any), which files a sub-agent really read, which hosts it reached, which options a person was really shown. See [Why not just `claude -p` or the Agent SDK?](#why-not-just-claude--p-or-the-agent-sdk).

**Debugging a run?** → [docs/debugging.md](./docs/debugging.md) — a separate page, not a section below.


> **New here?** Start by running a committed cassette `replay` and browsing [`examples/`](./examples/) (see [examples/README.md](./examples/README.md)) to see green runs before any setup — then read [docs/boundary.md](./docs/boundary.md) (the limitations model) and [docs/session.md](./docs/session.md) (the file you'll author).

> **What this is and isn't.** This is an *emulator of the contract*, not the Desktop runtime. Cowork runs a session in one of two lanes: **local** — the Desktop app driving the agent on your own machine against an Apple Virtualization.framework microVM sandbox (on the pinned baseline the agent loop runs on the **host** and reaches into the VM for shell; a VM-loop configuration that runs the whole agent inside the microVM also exists — see [DESIGN.md](./DESIGN.md), "Which Cowork? — both are implemented") — or **remote**, where the agent runs in an Anthropic-hosted cloud container (the default for new sessions since 2026-07-07; local stays available). **This harness emulates the local lane's runtime**, and holds a run to either lane's *delivery* contract via a scenario's [`lane:`](./docs/scenario.md#lanes-lane--which-delivery-contract-the-run-is-held-to) key — the lanes deliver files differently, which is the part that changes skill behaviour (see [docs/fidelity-gaps.md](./docs/fidelity-gaps.md), "File delivery"). You **cannot** drive the local microVM from a script (Cowork's session control plane is closed off; see [DESIGN.md §1](./DESIGN.md#1-what-real-cowork-actually-is-and-why-scripting-it-is-closed) for why). What you *can* faithfully reproduce is everything that actually changes how a **skill** behaves: the same agent binary in cowork mode (`CLAUDE_CODE_IS_COWORK=1` — there is no `--cowork` flag), the same mount layout, the same egress allowlist, and the same permission/question protocol. That's what this project does.

**Zero-friction preview — no token, no Docker.** A committed cassette replays from a fresh clone (the example
cassette ships in the repo; just Node ≥ 22):

```bash
git clone https://github.com/yaniv-golan/cowork-harness && cd cowork-harness
npm ci && npm run build
node dist/cli.js replay examples/replays/example-pdf-skill.cassette.json
```

(Installing globally — `npm install -g "cowork-harness@^3.3.0"` — gives you the `cowork-harness` CLI for your own
scenarios and cassettes; the bundled example above also replays from a global install — see the `$(npm root -g)` path below.)

Full setup → [Quick start](./docs/cli.md#quick-start).

---

## Pick your path

Three ways to use this project. Each row is the whole hook — follow the link for the full page.

| I want to… | Start here | Needs |
|---|---|---|
| **Run scenarios myself** from a terminal | **[docs/cli.md](./docs/cli.md)**<br><br>`npm i -g "cowork-harness@^3.3.0"`<br>`cowork-harness replay examples/replays/example-pdf-skill.cassette.json` | Node ≥ 22. The replay demo above is token-free and needs nothing else; live tiers above `protocol` need Docker + a staged agent binary |
| **Have Claude Code drive it** for me | **[docs/companion-skill.md](./docs/companion-skill.md)**<br><br>`/plugin marketplace add yaniv-golan/cowork-harness`<br>`/plugin install cowork-harness@cowork-harness` | Claude Code. The skill self-bootstraps the CLI via `npx "cowork-harness@^3.3.0"` |
| **Gate my skill in CI** | **[docs/ci.md](./docs/ci.md)**<br><br>`- uses: yaniv-golan/cowork-harness@v3`<br>`  with: { command: replay, path: cassettes/ }` | Nothing for the token-free gate; the live lane needs a self-hosted runner with Docker + an agent binary |

Not sure a harness is what you need? The next two sections are the argument.

## Why this works for skill testing

A skill's behavior under Cowork is determined by four things, all reproducible outside the VM:

| Dimension | What Cowork does | How we reproduce it | Fidelity |
|---|---|---|---|
| **Agent** | Spawns the staged in-VM agent `claude-code-vm/<ver>/claude` in cowork mode (`CLAUDE_CODE_IS_COWORK=1` env — there is no `--cowork` flag) | Run the **same pinned agent**, **bind-mounted** from your Claude Desktop install's staged Linux/arm64 ELF binary (the native Linux executable format; no npm path; override with `COWORK_AGENT_BINARY`) | **High** — same binary contract |
| **Mounts** | `/sessions/<id>/mnt/{uploads,<folder-name>,.local-plugins,.remote-plugins}` (work folders mount at the collision-resolved folder basename; ≥1.14271.0, older baselines use `.projects/<id>`) | Recreate the same paths as bind mounts; skill-under-test discovered at the plugin mount, same as Cowork | **High** — same discovery path |
| **Egress** | gVisor (a userspace network stack) with a compiled domain allowlist (`vmAllowedDomains()` + `coworkEgressAllowedHosts`) | Default-deny egress proxy enforcing the **pinned** allowlist | **Med-High** — domain-exact against a reconstructed list, transport-approximate |
| **Permissions / questions** | `onToolPermissionRequest` → `respondToToolPermission`; AskUserQuestion answered by the UI | The **Agent SDK `can_use_tool` control protocol** — the exact same channel — answered by your scenario script | **High** — same protocol Desktop uses |

The permission/question protocol is the backbone, and it's the *most stable* surface — it's the documented Agent SDK control protocol (`can_use_tool`, `hook_callback`, `mcp_message`, …). Everything fragile (agent version, mount paths, allowlist contents) is pushed into a **versioned baseline** that you re-sync per release. See [Maintenance](./docs/maintenance.md).

> **Design principle: fail loud, never silently wrong.** An unscripted question, a stale cassette, an unadded skill file, a missing capability — every one of these is a hard error or a loud warning, never a silent pass. Where you see "fails loud" or "no silent false-greens" elsewhere in this doc, it's this same principle applied to one specific mechanism.

---

## Why not just `claude -p` or the Agent SDK?

Both are excellent, and if you're building an *agent* you should use them. This harness exists for a narrower job: **testing a skill the way Cowork will actually run it.** Five things it gives you that are hard or impossible to reach from a plain CLI session or your own SDK loop — each one anchored to the mechanism or the record field that backs it, so you can check the claim rather than take it:

| What you get | Why the CLI / SDK doesn't give it |
|---|---|
| **The real Cowork agent, in cowork mode** | `claude -p` runs the CLI on your `PATH`. Cowork runs the *staged* `claude-code-vm/<ver>/claude` under `CLAUDE_CODE_IS_COWORK=1`, which changes the system prompt, the tool registry, and the permission flow. The harness runs that binary. See [Why this works](#why-this-works-for-skill-testing). |
| **A test of the real router, not your reimplementation of it** | Whether your skill triggers is a decision the agent makes when it sees your `description` alongside every other skill. The harness populates a real `CLAUDE_CONFIG_DIR` + the Cowork plugin mounts and lets the binary do the choosing — so `skill_triggered` / `no_skill_triggered` is a genuine check on a description edit. Drive the loop yourself and you're testing your own dispatcher. See [discovery.md](./docs/discovery.md). |
| **Real plugin loading** | Staging delivers the **git-tracked** file set, modelling an install from a repo that sees only committed files. So a plugin that fails to load — a bad manifest, an unadded file — shows up the way it will in production: the skill simply isn't in `context.availableSkills`. An SDK harness hands the model a prompt and never exercises loading at all, so that whole class of bug is invisible to it. |
| **Derived evidence, not a raw event stream** | `--output-format stream-json` gives you `tool_use` events. It does not give you `skillActivity` (which skill was active when a tool fired), `skillsInvoked`, `subagents[].referencesRead` (which files each sub-agent actually read), `presentedFiles`, `ablated`, or `gateProvenance` — those are computed. `context.availableSkills` isn't in the stream at all: it's read off each staged skill's `SKILL.md` frontmatter, so you can compare *what was offered* against *what was used*. See [What you get out](./docs/cli.md#what-you-get-out-inspectable-output). |
| **The limitations, not just the behaviour** | Sealed filesystem, default-deny egress, MCP-only crossing. A pass here can't be riding on your laptop's network access or a file the sandbox would never have had — and `egress_denied` / `transcript_no_host_path` let you assert that directly. See [boundary.md](./docs/boundary.md). |

Two more that matter in practice:

- **A blocking gate you can actually answer.** `AskUserQuestion` *blocks*: it is a question to a human, and `claude -p` has no human. A gated skill under a plain CLI run either stalls at the gate or never reaches the code behind it — so the half of your skill that lives past the first question is untestable, not merely awkward to test. The harness answers over the same `can_use_tool` control protocol Desktop uses, from your scenario's scripted `answers:` — or from a live decider when you're still discovering what it asks — so the gate genuinely fires and is answered deterministically. `on_unanswered:` decides what an *un*scripted gate does (fail loud by default). See [scenario.md](./docs/scenario.md), [decider-dir.md](./docs/decider-dir.md).
- **Token-free CI.** Record a run once, commit the cassette, and every PR re-runs it deterministically at **zero spend** — assertions, tool stream, gate answers and all. A cassette replays in well under a second with no token, no Docker and no model call (the three shipped examples replay in ~0.6s total), which is what makes an always-on per-PR gate affordable. See [cassette.md](./docs/cassette.md).

**What it doesn't do.** It runs and records; it does not design your experiment. Comparing "with skill" against "without skill" credibly — scrubbing tells, shuffling, judging blind, unblinding after grading — is still yours to build; the harness contributes the run execution and the control arm (`--ablate-skill`, one arm per invocation). And it emulates the *contract*, not the Desktop runtime: see [Limitations](#limitations) and [fidelity-gaps.md](./docs/fidelity-gaps.md) for what it deliberately does not reproduce.

---


## What a test looks like

You author one file. It is the prompt, the answers to any questions the skill asks, and what must be
true when it finishes:

```yaml
# scenarios/pdf.yaml
session: ../sessions/default.yaml
fidelity: container

prompt: |
  Summarize report.pdf and write the action items to outputs/actions.md

answers:                                   # the same control channel Desktop's question UI uses
  - when_question: "Which output format"   # regex on an AskUserQuestion gate
    choose: "Markdown"
  - when_tool: Bash
    allow_if: "!command.includes('rm -rf')"
    else: deny

expect_denied: ["evil.example.com"]        # this host must be refused egress

assert:
  - user_visible_artifact: outputs/actions.md   # the file actually reached the user
  - tool_called: Write
  - transcript_contains: "action items"
```

`cowork-harness run scenarios/pdf.yaml` prints a verdict and writes the whole run to disk:

```text
✓ success [container] · 7 tools · 24.3s · $0.18
   [provenance] model=claude-sonnet-5  skill=offered,invoked  ablated=false
   guards: capability-use ✓  permissive-auto-allow ✓  host-path ✓  outputs-delete ✓
```

That `skill=offered,invoked` is the part a transcript cannot give you: whether the skill was *selected*,
not just whether the answer looked right. `offered,NOT-invoked` on a green run means the model solved
it without your skill — which is a finding, not a pass.

**Two runs are often worth more than one.** The same scenario at two fidelity tiers, diffed, is a
discovery technique in its own right: a skill that passes at `container` and fails at `hostloop` has
told you something specific about where it will break, and the difference *is* the finding. See
[Fidelity tiers](#fidelity-tiers-pick-per-scenario--per-ci-job).

**Prove your assertions can fail.** The harness fails loud rather than passing silently, but it cannot
stop you writing an assertion that could never go red. Break the thing under test on purpose once —
move the file, rename the skill — and confirm you get the ✗. An assertion you have never seen fail is
not yet evidence.

### What that catches

A real one, from someone dogfooding a skill of their own. The prompt named their skill outright; the
run came back green and the answer read fine. The record said otherwise:

```text
skillsInvoked: []          # the skill was offered and never invoked
toolCounts:    {}          # zero tools — it never read anything
finalMessage:  "This is a quick syntax question, not a full skill-creation
                workflow, so I'll just answer it directly."
```

The model declined the skill and answered from its own knowledge. The guidance being tested was
correct and simply never consulted — so the run was measuring the model, not the skill. No transcript
of the *answer* would have shown that, because the answer was fine.

They widened the skill's description in response, re-ran the same probe, and it now invokes — then
pinned the fix with a scenario so it cannot regress silently. **That is the loop this is for:** find a
failure the output hides, fix it, and verify with the same instrument that found it. The snapshot
above is a moment, not a standing bug — reproduce it today against that skill and it passes, which is
the point.

That is the general shape: not "did the output look right", but "did the thing I am shipping actually
run, under the constraints it will meet in production".

> **Requirements at a glance** (a summary — full detail in [Prerequisites](./docs/cli.md#prerequisites-for-anything-above-protocol-fidelity) on the CLI page)
> - **Free demo (`replay`):** Node ≥ 22 — nothing else (no Docker, token, or Claude Desktop).
> - **Global `npm install -g`:** ships the runnable `examples/` subtrees — `replays/`, `scenarios/`, `sessions/`, `skills/`, `data/` — under `$(npm root -g)/cowork-harness/`, so `replay` and `run examples/scenarios/…` both work from one; `matrices/`, `answer-policies/` and `probes/` still need a source checkout. Full detail in [Prerequisites](./docs/cli.md#prerequisites-for-anything-above-protocol-fidelity) on the CLI page.
> - **`lint` (optional, token-free):** also needs **`python3`** on PATH — the scenario linter shells out to it (PyYAML is bundled); a missing `python3` is a hard `exit 127`.
> - **Live tiers** need three things:
>   - **Claude Desktop, opened once** — stages the agent; nothing is bundled.
>   - **A Claude token** — real per-run cost, runs take minutes; mint one with `claude setup-token` (needs the **`claude` CLI**: `npm i -g @anthropic-ai/claude-code`).
>   - **A runtime** — **Docker (arm64)** for `container` (default) / `hostloop`, or **Lima (Apple-VZ)** for `microvm`.
>   - The `protocol` tier skips the runtime + the staged agent but still calls a real model, so it still needs the token. Run `cowork-harness doctor --tier <t>` to check exactly what a given tier needs.
> - **Platform:** best on **macOS Apple Silicon**; **Windows is not supported** for the live tiers (use the token-free `replay`); `sync` and `microvm` are **macOS-arm64 only**. Full detail in [Prerequisites](./docs/cli.md#prerequisites-for-anything-above-protocol-fidelity) on the CLI page.

## Fidelity tiers (pick per scenario / per CI job)

```
L0  protocol-only     claude -p stream-json (the agent's JSON-lines I/O format) on the host. No sandbox,
                      no egress control. Fastest. Pure-logic / inner-loop assertions.

L1  container parity  Pinned agent in cowork mode inside an arm64 Linux container with the real
   (recommended)      mount layout and a default-deny egress proxy enforcing the synced allowlist.
                      Reproducible, CI-native (Docker/Podman). The faithful-yet-maintainable sweet spot.

L2  microvm parity    Optional. Agent inside a real Linux microVM (Lima/Apple-VZ) with a guest
   (opt-in, heavy)    default-deny iptables firewall funnelling to the same allowlist proxy as L1.
                      VM-grade escape isolation; egress transport equals L1's HTTP-CONNECT proxy (the
                      HTTP tunneling method used for HTTPS-through-a-proxy) — no gVisor netstack
                      reproduced. Not for CI; periodic high-fidelity checks only.

    ─── loop-mode overlays (orthogonal to L0/L1/L2: they pick WHERE the loop runs, not isolation) ───

    hostloop          Cowork's PRODUCTION split-execution. The agent loop is a NATIVE process spawned
                      directly on the host (no container around the file tools, matching production) —
                      native Bash/WebFetch are disabled and routed host-side via the workspace SDK-MCP
                      server — an in-process MCP server the Agent SDK talks to directly (tool name
                      mcp__workspace__bash), whose bash calls route into a Docker VM sidecar; web_fetch
                      routes via host curl. A PreToolUse path-containment hook is the security boundary
                      for real filesystem access at this tier — see docs/boundary.md.

    Both container and hostloop also declare the skills/plugins skill/plugin-discovery SDK-MCP servers
    (mcp__skills__list_skills/suggest_skills, mcp__plugins__list_plugins/search_plugins/
    suggest_plugin_install) alongside cowork/workspace — see docs/fidelity-gaps.md.

    cowork            Auto-picks hostloop vs container the way Cowork itself does — decoded from
                      GrowthBook gate 1143815894 (Cowork's internal feature-flag system) in the
                      synced baseline. "Do what real Cowork does."
```

**Decision guide** — `fidelity:` takes exactly one of these five values (`protocol`/`container`/`microvm` vary isolation strength; `hostloop`/`cowork` are overlays that instead pick *where the loop runs* — there's no combining the two groups):

| Question | Choose |
|---|---|
| Is the skill logic / gate flow even alive? | `protocol` |
| Does it behave under Cowork's mounts + egress? | `container` (default) |
| Need VM-grade escape isolation for untrusted code? | `microvm` — not for CI, macOS arm64 only |
| Bug only shows in the production host/VM split? | `hostloop` — live-only, macOS only, needs the native binary |
| Want it auto-picked the way Cowork itself picks, this release? | `cowork` — resolves to `hostloop` or `container`, never `protocol`/`microvm` |

Note: `cowork` above is one value of `fidelity:`. Two other `cowork`-named settings are unrelated —
`permission_parity: cowork` (a session setting for how unscripted tool calls are treated; see
[Two files: session + scenario](./docs/cli.md#two-files-session--scenario)) and "cowork mode" (the
`CLAUDE_CODE_IS_COWORK=1` env flag every live tier passes to the agent binary, regardless of which
fidelity tier you picked).

Recorded cassettes pin the tier a `fidelity: cowork` scenario actually resolved to as `effectiveFidelity`, which backs the `resolved-tier`/`unverifiable-tier` staleness classes — see [docs/cassette.md](./docs/cassette.md).

Set the tier with `fidelity:` in a scenario, or `--fidelity` on `skill` / `chat` / `critique` / `probe-dispatch`.

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
                      │    cwd = /sessions/<id>                        │
                      │    mnt/uploads · mnt/<folder-name> · plugins   │
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

> The diagram above shows the VM-loop path (`container`/`microvm`). At `hostloop` fidelity the agent loop
> instead runs as a native host process with no container around it, routing shell/file access through a
> workspace SDK-MCP server into a VM sidecar — see the Spawn contract section in DESIGN.md for detail.

- **AgentSession** speaks the Agent SDK control protocol over stream-json, emitting a typed event
  stream. When the agent emits a decision request (a tool permission, an `AskUserQuestion`, or a
  `request_user_dialog`/`elicitation`), the **Decider** resolves it — scripted `answers:` first, then
  the cowork/strict permission default, then the `on_unanswered` policy (fail/prompt/first/llm) — and
  **Run** drives the turn loop and builds the `RunRecord` (decisions, the sub-agent dispatch tree,
  egress, cost).
- **Egress proxy** (L1/L2) enforces the synced allowlist; default-deny. Domains come from the baseline, plus per-scenario `extra_allow`.
- **The platform baseline** is the single source of release-specific truth. Code rides the stable protocol; data tracks the release.

See [DESIGN.md](./DESIGN.md) for the full parity matrix, the known deltas vs. real Cowork, and the threat-model notes on egress.

---

## Limitations

- **Not the full Desktop network transport.** L1 is a container, not a VM; L2 *is* a real Apple-VZ microVM but still does not reproduce Cowork's gVisor netstack — its egress is the same allowlist proxy as L1 (with a guest iptables firewall in front). If your skill depends on VM-kernel specifics, validate at L2; if it depends on packet-level gVisor behavior, no tier reproduces it.
- **Cowork in-guest context is partial.** Desktop supplies host-loop staging, runtime `mountPath` RPC, and the bridge. We reproduce the *filesystem and cowork mode*, not those host-side services. Skills that call Desktop-only host RPCs won't run here (they wouldn't be portable anyway).
- **The agent binary is the staged ELF** (`claude-code-vm/<ver>/claude`), **bind-mounted** from your own Claude Desktop install — nothing Anthropic-owned is bundled or installed. There is **no npm path**; override the path with `COWORK_AGENT_BINARY`. Check licensing/ToS for your use.
- **Egress fidelity is domain-exact against a pinned list, transport-approximate** at L1 and L2. Allow/deny is decided per domain the way Cowork decides it, but the allowlist itself is a hand-curated reconstruction rather than an extraction — the first-party deployment delivers it per session from the server, not in the app bundle, so it cannot be read out — and the baseline's `network.$comment` flags four entries as unverified as VM egress. The packet-level gVisor netstack is reproduced at neither tier; both use a default-deny allowlist proxy (L2 adds a guest iptables firewall).

These are documented per-tier in [DESIGN.md](./DESIGN.md) so a green test means what you think it means.

---

## For AI agents

This repo is built to be driven by agents, not just read by humans:

- **[AGENTS.md](./AGENTS.md)** — the canonical agent-instructions file (architecture seams, the build gate, invariants, ethos). Read it before changing code. Also indexed in **[llms.txt](./llms.txt)**.
- **Companion skill** — [`.claude/skills/cowork-harness/`](./.claude/skills/cowork-harness/SKILL.md) teaches an agent to drive the harness; install it via the marketplace (see [above](./docs/companion-skill.md)).
- **Machine-readable interfaces** — stable `--output-format json` envelope on stdout, deterministic exit codes (`0`/`1`/`2`/`3`, with a couple of documented per-command exceptions — see [SPEC.md](./SPEC.md) for the full table), and `--help` on every command.
- **JSON Schemas** — [`schema/scenario.schema.json`](./schema/scenario.schema.json) and [`schema/session.schema.json`](./schema/session.schema.json) describe every field of the YAML you author (generated from the source schemas; `npm run schema`). [`schema/protocol.v1.json`](./schema/protocol.v1.json) (hand-authored) schemas the harness's own control-channel wire protocol, with a golden vector pack at [`fixtures/protocol/v1/`](./fixtures/protocol/v1/) — see [docs/protocol.md](./docs/protocol.md). [`schema/critique-report.json`](./schema/critique-report.json) describes `critique`'s JSON report / `critique-report.json` artifact for automation consumers (budget pacers, harvesters) — **descriptive, not §12-frozen** while critique is EXPERIMENTAL (see [SPEC.md §12](./SPEC.md#12-versioning--the-10-compatibility-contract)).

`AGENTS.md`, `SPEC.md`, and `DESIGN.md` **are** shipped in the npm package (see `package.json` `files`) —
a global install has them locally too, not just on GitHub.

---

## Documentation

| Doc | Read it for |
|---|---|
| [docs/cli.md](./docs/cli.md) | **The CLI page** — install, prerequisites per tier, the command table, the two files you author, run output, and the `COWORK_*` knobs. |
| [docs/companion-skill.md](./docs/companion-skill.md) | **The companion skill** — install and orientation; usage itself lives in the skill's `SKILL.md`. |
| [docs/ci.md](./docs/ci.md) | **CI** — the token-free gate, the packaged GitHub Action, the live lane, and what the two version pins mean. |
| [docs/README.md](./docs/README.md) | The docs index — a one-line map of every guide below. |
| [docs/boundary.md](./docs/boundary.md) | The limitations model — sealed FS, default-deny egress, MCP-only crossing; how each tier enforces it; how to verify. |
| [docs/session.md](./docs/session.md) | Every `sessions/*.yaml` field and its Cowork mapping. |
| [docs/scenario.md](./docs/scenario.md) | `scenarios/*.yaml` — prompt, scripted answers, assertions. |
| [docs/subagents.md](./docs/subagents.md) | The sub-agent capability/path model — tier-qualified outputs contract, tool-composition rules, the type-less dispatch trap. |
| [docs/chat.md](./docs/chat.md) | The interactive `chat` REPL — multi-turn debugging, flags, attaching files/folders. |
| [docs/debugging.md](./docs/debugging.md) | Debugging a run — `inspect`/`trace`/`verify-run`/`diff`/`chat` for a misbehaving skill; the false-green hunt for a green you don't trust; and the **iterate-across-fixes verification loop** (ground findings in run evidence; pair by `fingerprint.skillHash`). |
| [docs/cassette.md](./docs/cassette.md) | `record`/`replay` cassettes — what replay checks, which assertions are skipped. |
| [docs/critique.md](./docs/critique.md) | **EXPERIMENTAL** — `critique`: run a skill, ask the agent what confused it, then grade that self-report against a frozen record. Its verdict is an advisory lead, not an attestation. |
| [docs/run-status.md](./docs/run-status.md) | Checking whether a background run is alive — the `status.json` file + `cowork-harness status [--follow]`. |
| [docs/stats.md](./docs/stats.md) | The `stats` command + `index.jsonl` — querying pass rate, cost/duration/token/turn percentiles, and last-green across every past run. |
| [docs/gotchas.md](./docs/gotchas.md) | Troubleshooting FAQ — exit 127, empty skill mount, arm64 Docker issues, git-worktree token traps, scenarioDrift after an edit, plus skill-authoring/host-loop footguns. |
| [docs/fidelity-gaps.md](./docs/fidelity-gaps.md) | The known deltas vs. real Cowork — what the harness does and doesn't reproduce. |
| [docs/decider-dir.md](./docs/decider-dir.md) | The `--decider-dir` recipe — a driving agent answers live gates in-band via `gates`/`answer` + a Monitor. |
| [docs/discovery.md](./docs/discovery.md) | Where plugins/skills/MCP are found + overrides. |
| [docs/plugin-root.md](./docs/plugin-root.md) | How `${CLAUDE_PLUGIN_ROOT}` resolves per execution mode (host-loop vs VM-loop) — for when a skill's bundled-file path doesn't resolve. |
| [docs/maintenance.md](./docs/maintenance.md) | Parity across Desktop releases via `sync`. |
| [docs/cowork-spawn-contract-1.12603.1.md](./docs/cowork-spawn-contract-1.12603.1.md) | The binary-grounded spawn/control contract (cwd, env, mounts, control-protocol fields) the harness implements — **frozen historical research**, verified on `desktop-1.12603.1` and re-verified unchanged through `desktop-1.20186.0`. Volatile fields (`agentVersion`, egress allowlist, gates) live in `baselines/`, not here. |
| [docs/decisions/](./docs/decisions/) | Architecture decision records — the "why" behind a cross-cutting default. |
| [DESIGN.md](./DESIGN.md) | Architecture deep-dive + full parity matrix. |
| [SPEC.md](./SPEC.md) | The authoritative testable contract (scenario/session schema, `RunResult`, exit codes). |
| [docs/invariants.md](./docs/invariants.md) | A consolidated index of the harness's cross-cutting invariants, one row per invariant with its enforcement point and test anchor. |
| [docs/protocol.md](./docs/protocol.md) | The `schema/protocol.v1.json` control-channel wire-protocol schema — versioning policy, golden vector pack, and its descriptive-not-normative scope. |
| [CHANGELOG.md](./CHANGELOG.md) | Release history. |
| [python/README.md](./python/README.md) | The `cowork` pytest lane for driving the harness from Python. |
| [examples/README.md](./examples/README.md) | The worked examples to copy — sessions, scenarios, and skills you can run end-to-end. Published too, under `$(npm root -g)/cowork-harness/`; `matrices/`, `answer-policies/` and `probes/` need a source checkout (see the "What ships" table). |
| [SECURITY.md](./SECURITY.md) | Threat model — the sandbox is a fidelity fixture, not a security boundary. |
| [RELEASING.md](./RELEASING.md) | The release flow — branch → PR → tag → npm publish. |
| [llms.txt](./llms.txt) | The AI-agent index — a machine-readable map of this repo's docs for an agent bootstrapping context. |

## Versioning

From `1.0.0` this project follows [semver](https://semver.org/). What that covers is enumerated in
**[SPEC.md §12](./SPEC.md#12-versioning--the-10-compatibility-contract)** — the CLI commands/flags and
exit codes, the scenario/session/baseline/`RunResult`/cassette/protocol schemas, the documented
`COWORK_HARNESS_*` (+ `COWORK_AGENT_BINARY`/`COWORK_AGENT_IMAGE`) env vars, and the packaged Action's
inputs/outputs. Human-readable terminal text is explicitly **not** part of the contract — parse the
`--output-format json` envelope, not stdout. As of 1.0.0, a backwards-incompatible change to a covered surface is a major bump.

## Status

The latest shipped baseline — what `baseline: latest` resolves to (`cowork-harness list`) — is
**`desktop-1.46388.3`**. Release-by-release verification notes (what was re-verified against
which live agent/asar) are recorded in [CHANGELOG.md](./CHANGELOG.md); the feature catalogue
this section would otherwise duplicate lives in the sections above.
