# DESIGN — parity model, deltas, and the maintenance contract

This document is the reference for *how faithful* each tier is, *what we deliberately don't reproduce*, and *why the chosen seams keep parity cheap to maintain*. Everything here is grounded in analysis of the live Claude Desktop `app.asar` (spawn contract and gates first verified at build 1.12603.1; updated through the newest baseline in `baselines/` (see `baselines/desktop-*.json`; `cowork-harness sync --diff` adds the next one)) and the on-disk runtime state on macOS.

> **Just want to pick a tier or write a scenario?** This doc is the *why*. For the *how*, start at the
> [README](./README.md) (tiers, quick start) and [docs/](./docs/README.md) (scenario/session reference).
> Read on for the parity model, the deliberate deltas, and the maintenance contract.

## Architecture at a glance

```mermaid
flowchart TB
    SCN["scenario.yaml"] --> CLI
    SYNC["cowork-sync<br/>reads live Desktop install + app.asar"]

    subgraph CLI["cowork-harness · TypeScript CLI"]
        direction TB
        BL["baseline loader<br/>baselines/desktop-*.json<br/>agent ver · mounts · egress allowlist"]
        RS["runtime selector → L0 / L1 / L2"]
    end
    SYNC -.->|derives| BL

    CLI -->|"spawns + speaks stream-json"| AGENT
    subgraph AGENT["Agent · staged claude-code-vm/&lt;ver&gt;/claude · CLAUDE_CODE_IS_COWORK=1<br/>(not `claude -p` on PATH — that is L0 protocol only)"]
        direction TB
        IO["--input-format / --output-format stream-json"]
        FS["cwd = /sessions/&lt;id&gt;<br/>mnt/uploads · mnt/&lt;folder-name&gt; · plugins"]
    end

    AGENT -->|"decision control request<br/>(tool · question · dialog · elicitation)"| DRV["AgentSession → Decider → Run<br/>protocol seam · policy seam · turn loop + RunRecord"]
    AGENT -->|"outbound network"| EG["Egress proxy<br/>default-deny · allowlist = synced vmAllowedDomains()"]
```

(README carries the same diagram in ASCII, since npm doesn't render Mermaid.)

> The agent node above is the **VM-loop** path (`container`/`microvm`), which runs the staged Linux ELF.
> `hostloop` runs a **different** staged binary — the native macOS `claude-code/<ver>/claude.app/…` — as a
> host process with no container around it, and `protocol` (L0) is the only tier that uses `claude` from
> your `PATH`. See § 6 and [docs/fidelity-gaps.md](./docs/fidelity-gaps.md).

## 1. What "real Cowork" actually is (and why scripting it is closed)

Cowork runs a session in one of two lanes. This section describes the **local** lane — the Desktop app driving the
agent on the user's own machine, with an **Apple Virtualization.framework microVM** as the sandbox — which is the lane
this harness emulates. Where the agent LOOP runs inside that lane is a separate axis, and on the pinned baseline it is
the host, not the VM: see "Which Cowork? — both are implemented" under
[§6, Control protocol mapping](#6-control-protocol-mapping) below, which is authoritative over the
sandbox-centric description here. The **remote** lane runs the agent in an Anthropic-hosted cloud container instead, and is
the default for new sessions from 2026-07-07 (local stays available, and both are in active use). The lanes differ
in how a file reaches the user, which is what changes skill behaviour: see
[docs/fidelity-gaps.md](./docs/fidelity-gaps.md) → "File delivery" for the split and
[docs/scenario.md](./docs/scenario.md)'s `lane:` key for holding a run to either contract. The local lane:

- VM bundle: `~/Library/Application Support/Claude/vm_bundles/claudevm.bundle/` (`rootfs.img`, `sessiondata.img`, `efivars.fd`, `machineIdentifier`, `gvisorMacAddress`, `vmIP`); a warm pool at `vm_bundles/warm/<sha>/`.
- In-VM agent: `~/Library/Application Support/Claude/claude-code-vm/<ver>/claude` (currently **2.1.281**, per `baselines/desktop-2.9939.2.json`, an **ELF aarch64** binary), spawned by the host **in cowork mode via the `CLAUDE_CODE_IS_COWORK=1` env var** — *not* a `--cowork` flag (that flag is plugin-scope and the staged agent rejects it; see the control-protocol note below). Each baseline records this ELF's `sha256` (`agentBinary.sha256`/`shaProvenance`), and the resolver integrity-checks the binary it's about to run against that hash by default (opt out `COWORK_HARNESS_VERIFY_AGENT_SHA=0`), so "the same pinned agent" is enforced, not just asserted. Old versions are re-downloadable + verifiable from the official release channel — from the channel that baseline's `agentBinary.releaseBaseUrl` names, which is **not always the stable path** (Desktop stages release candidates too); the exact command is in `docs/maintenance.md`.
- Network: `vm_network_mode: "gvisor"`, egress through a userspace netstack with a **compiled domain allowlist**; off-list partners rejected (`partner rejected: entry not on compiled allowlist`).
- Control plane: Electron renderer→main typed IPC on channels named `$eipc_message$_<per-build-UUID>_$_claude.web_$_<Class>_$_<method>`, every handler validating `event.senderFrame.url` against a trusted-origin allowlist. The session manager is `LocalAgentModeSessions` (80 methods: `start`, `sendMessage`, `setDraftSessionFolders`, `onToolPermissionRequest`, `respondToToolPermission`, `getTranscript`, `onEvent`, …), bridged to the renderer as `window.cowork`.

**Why you can't script it:** the only in-context entry is the renderer, and remote debugging is closed on the shipping build — verified empirically (`--remote-debugging-port` opens no listener across clean trials) and structurally (Electron `EnableNodeCliInspectArguments` fuse OFF). Deep links don't create sessions; there's no host CLI entry (cowork mode is an in-guest env var, `CLAUDE_CODE_IS_COWORK=1` — not a `--cowork` flag; see §"Cowork mode is enabled by env" below). So we emulate the **contract**, not the app.

> **This page vs. the other four.** Fidelity is documented in five places, on purpose — each answers a
> different question:
>
> | Question | Page |
> |---|---|
> | *Which tier should I pick?* | [README → Fidelity tiers](./README.md#fidelity-tiers-pick-per-scenario--per-ci-job) — the decision table |
> | *What does each tier enforce?* | [boundary.md](./docs/boundary.md) |
> | *What does each tier NOT reproduce?* | [fidelity-gaps.md](./docs/fidelity-gaps.md) |
> | *Why is it built this way?* | **this page, § 2 below** |
> | *I only have the installed plugin* | [references/fidelity-and-answers.md](./.claude/skills/cowork-harness/references/fidelity-and-answers.md) — offline snapshot |

## 2. Parity matrix (per tier)

> Rows below are the three **isolation tiers** (L0/L1/L2). The two **loop-mode** tiers —
> `hostloop` (production split-execution) and `cowork` (auto-picks host-loop vs container) —
> are overlays on these and are covered in §"Spawn contract + host-loop vs VM-loop" below
> and the README tier table, not as separate columns here.
>
> **L0/L1/L2 are doc shorthand only** — the actual `fidelity:` values you write are `protocol` /
> `container` / `microvm` (plus the `hostloop` / `cowork` overlays). You never write `L1`.

| Aspect | Real Cowork | L0 protocol | L1 container | L2 microvm |
|---|---|---|---|---|
| Agent binary | staged `claude-code-vm/<ver>`, `CLAUDE_CODE_IS_COWORK=1` | host `claude` (may differ), run plain (control-loop only) | **pinned** `<ver>`, `CLAUDE_CODE_IS_COWORK=1` | pinned `<ver>`, `CLAUDE_CODE_IS_COWORK=1` |
| CPU/OS | linux/arm64 guest | host OS | linux/arm64 container | linux/arm64 guest |
| Mount layout | `/sessions/<id>/mnt/...` | cwd only (no mnt tree) | **full mnt tree** (bind) | **full mnt tree** |
| Skill discovery | plugin mount, runtime | local dir | **plugin mount** | **plugin mount** |
| Permission/question protocol | `can_use_tool` via IPC | `can_use_tool` stream-json | `can_use_tool` stream-json | `can_use_tool` stream-json |
| Egress control | gVisor + allowlist | **none** | allowlist proxy (default-deny) | allowlist proxy (default-deny, guest iptables) |
| Net transport | gVisor netstack | host | proxy (TCP/HTTP CONNECT) | proxy (TCP/HTTP CONNECT) |
| Filesystem isolation | VM | process | **container** | **VM** |
| Speed | — | fastest | fast | slow |
| CI-friendly | — | yes | **yes** | no |

**Rule of thumb:** test skill *logic + question handling* at L0; test skill *behavior under Cowork's mounts + egress* at L1; reach for L2 only when you need VM-grade escape isolation of untrusted code — L2's egress transport equals L1's (the same allowlist proxy), so it adds no network-transport fidelity.

## 3. Deliberate deltas (a green test still means something)

| Delta | Why it's acceptable for skill testing | When it bites |
|---|---|---|
| No Apple VZ kernel | Skills are agent-loop + tool behavior; kernel-invisible | Skill probes `/proc`, kernel version, VM artifacts |
| L1 and L2 egress is a proxy, not gVisor | Allow/deny is decided per domain against the pinned allowlist, which is what skills observe | Skill depends on raw-socket / non-HTTP egress behavior, or on a domain where the pinned list and production's server-delivered set differ |
| No host-loop staging / mountPath RPC / bridge | Those are Desktop host services, not part of a portable skill | Skill calls a Desktop-only host RPC (non-portable by definition) |
| Host `claude` at L0 may differ from pinned ver | L0 is the fast lane; use L1 for version-exact | Version-specific tool/flag behavior — pin via L1 |
| Files mounted locally, not via `/v1/files` + `stage_file` | The skill only needs the file *present* at `mnt/uploads/`; it `Read`s the same path either way | Skill depends on the Files-API round-trip itself (id, gating) rather than file contents |
| Sessions resumed via the agent's native `--resume` + work-dir reuse, not the cloud `/v1/sessions` event log / cross-session store | The agent reloads `messages` + `fileHistorySnapshots` + `deferredToolUse` from its own sessionFile — behaviorally identical for a gate round-trip | Skill reads the server-side session event stream or the cross-session document store directly |

These are surfaced in the run report so a passing scenario is honest about which tier produced it. The
file/persistence deltas are **local-fidelity by design** — see SPEC §4.3; the resume path is binary-
verified (a fact set in run 1 is recalled after `--resume` in run 2).

## 4. The maintenance seam (why this survives releases)

Parity rot happens when release-specific facts are hard-coded in logic. We isolate them:

```
STABLE (rarely changes; lives in code)
  - the stream-json control protocol (can_use_tool / hook_callback / mcp_message / ...)
  - the scenario schema and assertions
  - the runtime selector and proxy mechanism

VOLATILE (changes per release; lives in baselines/*.json, sync-regenerated)
  - agentVersion
  - network.allowDomains + network.mode + requireFullVmSandbox
  - gates
  - asarFingerprint (provenance + "unknown delta" tripwire)

HAND-AUTHORED (in baselines/*.json, drift-guarded — sync does NOT extract these)
  - mountLayout (mount modes)
  - spawn.env.CLAUDE_CODE_IS_COWORK + bgEnvStrip.knownVars (BG env-strip list)
```

The sync extractor (`src/sync/cowork-sync.ts`, driven by `cowork-harness sync`):
1. reads the live install (`claude-code-vm/.sdk-version`, `config.json`) and the `app.asar` main bundle,
2. re-derives every VOLATILE field,
3. computes an `asarFingerprint` over the cowork-relevant code regions,
4. emits `baselines/desktop-<appVersion>.json` and diffs against the committed one.

If the fingerprint changes but no known field did, sync reports `unknown delta` — your signal that Anthropic moved something the extractor doesn't read yet. That converts silent parity rot into a visible, actionable diff.

### Per-release runbook
```bash
cowork-harness sync --diff      # review agent bump / allowlist change / mount change
# extend src/sync/cowork-sync.ts if "unknown delta" is reported
git add baselines/desktop-<new>.json && git commit -m "parity: sync to Desktop <new>"
cowork-harness run examples/scenarios/   # regression: drift now shows as test diffs
```

### Rootfs / image drift checks

The agent *image* is a second fidelity surface (separate from the baseline facts above), and its drift is
caught the same "silent rot → visible signal" way:

- `scripts/capture-rootfs-manifest.ts --check <image>` diffs the **whole** Layer-A pip set — generated from
  `docker/Dockerfile.agent` rather than a hand-maintained subset, so a missing PDF/image package (pdf2image,
  pypdfium2, seaborn, …) fails the check instead of slipping through — plus the Node version, the apt
  document stack (`dpkg-query`), and global npm packages (`npm ls -g`).
- `scripts/build-rootfs-image.ts` tags the imported image by a **content hash** of `rootfs.img` (not
  size+mtime), so an in-place content change can't reuse a stale cached image; the hash is printed in build
  output.
- The image-capability probe cache keys on the image's **content** (id + created time), not a mutable tag —
  a rebuilt-in-place tag re-probes instead of serving stale capability facts.

## 5. Egress model details

Real Cowork compiles `{kind:"allowlist", domains:[...vmAllowedDomains(), ...coworkEgressAllowedHosts]}` (or `{kind:"unrestricted"}` iff the set contains `"*"`). The default allowlist below is a **pinned, hand-curated reconstruction, not an extraction** — on the first-party deployment this harness models the VM egress allowlist is not in the app bundle at all (that deployment class returns `vmEgressPolicy(){return null}`, so the session's SERVER-DELIVERED `egressAllowedDomains` is used instead), which means it cannot be read out of the asar. It is the list the harness **enforces**; whether it equals production's server-delivered set is unverified, and four entries (`www.`, `console.`, `support.`, `docs.anthropic.com`) are flagged unverified-as-VM-egress in the baseline's own `network.$comment`. `sync` carries the list forward and never re-derives it:

```
api.anthropic.com  a-api.anthropic.com  a-cdn.anthropic.com  api-staging.anthropic.com
console.anthropic.com  docs.anthropic.com  mcp-proxy.anthropic.com  support.anthropic.com
www.anthropic.com  *.claude.ai (assets / downloads / pivot / preview)  sentry.io
```

L1 reproduces this as a **default-deny forward proxy**: the agent's `HTTP(S)_PROXY` points at it, and only allowlisted hosts (baseline + the session's `egress.extra_allow`) get `CONNECT`-through; everything else is refused and logged to `egress.log`. Scenario `expect_denied` asserts denials. This matches what a skill *observes* (a blocked host fails) even though the transport differs from gVisor.

> Security note: the proxy is a **test fixture**, not a security boundary. Don't run untrusted skills against real credentials at L1 expecting VM-grade isolation; use L2 (real VM) for that. L1's job is faithful *behavioral* egress, not adversarial containment.

## 6. Control protocol mapping

| Cowork (Desktop IPC) | Harness (stream-json control) |
|---|---|
| `onToolPermissionRequest` (subscribe) | inbound `can_use_tool` control_request |
| `respondToToolPermission(allow/deny)` | `control_response` allow/deny |
| AskUserQuestion answered by question UI | allow + `updatedInput = {questions, answers}` — BOTH keys required (Record<questionText, answer>) |
| `onEvent` live stream | stream-json assistant/tool messages → `events.jsonl` |
| `getTranscript` | accumulated stream → the `transcript` line in `run.jsonl` |
| `setDraftSessionFolders` / `addFolderToSession` | bind-mount into `mnt/<folder-name>` before launch |

The policy that produces those `allow`/`deny` responses is the **Decider** seam (see the architecture diagram); to smoke-test a decider against a sample question without a full run, use `cowork-harness decide`.

> **Machine-readable form:** the five shapes below are schema'd as `schema/protocol.v1.json`, with a golden vector pack at `fixtures/protocol/v1/` — see [docs/protocol.md](./docs/protocol.md) for scope, versioning, and how to conformance-test against them.

### Control protocol — VERIFIED end-to-end against the live host CLI (macOS)

> **This heading deliberately carries no version or baseline figures.** It used to restate the agent
> version and baseline of the last live pass, and those went stale independently of the note below it
> — at one point naming three different agent versions across two adjacent sentences. **The "Scope of
> that claim" note below is the single authority** for which baseline and agent were actually
> exercised, and for what the pass did and did not cover. Read it before citing this heading.
>
> (Historical note, kept because it is a deliberate decision rather than an omission: the
> `desktop-1.20186.1` baseline is a patch-only Desktop release — egress allowlist, spawn config and the
> Cowork system-prompt fingerprint all unchanged from `1.20186.0`, with the staged VM ELF re-synced
> 2.1.202 → 2.1.205 — and the live pass of that era was deliberately **not** restamped onto it.)

> **Scope of that claim.** `2026-09-25 / desktop-2.9939.2` is the baseline carrying the latest live pass, run against agent **2.1.281**, and it is the newest committed baseline — no baselines have shipped since. The pass ran against the staged agent (the VM ELF `claude-code-vm/2.1.281`, sha256 matching the baseline per `doctor`) on macOS arm64, agent image `cowork-agent-base:2`, on harness **3.8.1** (main `0be9dd8`), from a fresh worktree. The protocol tier runs the host `claude` CLI by design, not the staged agent; on this pass that CLI was **2.1.282**. It covered **all four** suites: `boundary-check` **6/6** (host-fs-sealed, direct-egress-denied, allowlist-enforced, allowlist-permits, loopback-not-proxied, hostloop-bash-egress); `npm run test:live` **5 files, 20 tests — 19 passed, 1 failed, 0 skipped** on the first run (the collection was audited beforehand with `vitest list`: live-contract 14, live-matrix 2, live-outputs-delete 2, live-resume-continuity 1, live-stop-hook 1); the e2e self-tests **9/9 success** (canary-hostloop, smoke-askuserquestion, smoke-l1-container, smoke-l1-egress, smoke-l2-microvm, smoke-multiselect-deciderdir, smoke-multiselect, smoke-present-files, smoke-semantic-evidence-files); and `run examples/scenarios/` **6/7 success** on its first run (csv-fx-normalize, csv-metrics, hostloop-computer-links, protocol-smoke, skill-loads, subagent-manifest-probe — the last at 9/9 assertions with one sub-agent). Every run's `result.json` was read from disk: all assertions evaluated, none skipped. **The two non-greens, stated rather than rounded away.** (1) The `test:live` red is `live-matrix`'s second cell (protocol tier, `desktop-1.18286.0`): the model asked its A-or-B question in plain text instead of calling `AskUserQuestion`, so the run ended on an unanswered question. It is the same red as in the previous pass, and it cannot come from this baseline, because the protocol tier runs the host CLI (2.1.282), not the staged agent. The file passed on a re-run (2/2). (2) `example-pdf-skill` (container) failed one of five assertions on the counted run — "user-visible artifact not found: `project/outputs/actions.md`". The agent wrote the right content one directory too high, into the connected folder, having read the prompt's relative `outputs/actions.md` as "the connected folder is the outputs folder". It passed on a separate re-run (5/5). Both are model variance, not a 2.9939.2 regression. **Zero skips** in the live lane is the part worth stating: every `describe` there is `skipIf`-gated on Docker, the staged-binary version and the token, so a gated case reports as SKIPPED rather than passing vacuously. `smoke-multiselect-deciderdir` runs the `--decider-llm` path, and `smoke-l2-microvm` passed in a real Apple-VZ VM with its own kernel, created for the run and deleted after (unpinned, so it ran on `claude-sonnet-5`). Tiers exercised: **all four — `protocol`, `container`, `hostloop` and `microvm`**. Both credential paths were exercised: the `.env` credentials for the container/protocol tiers, and the agent's own macOS-Keychain self-sourcing at `hostloop`. Spend: **$4.05**, summed from all 35 `result.json` files; a floor, since a live-contract test that spawns the agent without writing a harness run dir is not counted. **Scope-out, so this is not read as more than it is.** (a) A live pass verifies observed behaviour, not the whole spawn contract by construction. (b) These suites are model-dependent, so a single red is evidence of model variance until a re-run says otherwise. (c) The first `examples/scenarios/` run is the one counted; there was no second. (d) **CI does not live-validate anything.** Its "scenario suite (… live inference)" job is skipped as a whole without an `ANTHROPIC_API_KEY` repository secret, and none is set, so it shows as *skipped*. Before 2026-09 it instead ran with every real step skipped and reported *success*, so an older green check there means nothing ran. This note, not CI, is the live evidence. Separately and not a live matter: all three committed cassettes in `examples/replays/` were re-recorded against `desktop-2.9939.2` on 2026-09-25, each at its own tier (`protocol`, `container`, `hostloop`); `verify-cassettes` exits 0 with all three clean and one accepted `unscanned` entry (`example-pdf-skill`'s uploaded artifact body, too large to commit). The `protocol` cassette records host CLI 2.1.282 for the reason above. Re-stamp this paragraph, naming the baseline, whenever a live pass is actually re-run.

> The staged agent ELF is unchanged (2.1.181) across the 1.14271.0→1.15200.0 asar bump, and 2.1.187 across the 1.15200.0→1.15962.0 bump. The live scenario suite (`protocol` + `container` tiers) was re-run against the 1.15200.0 baseline; the 1.15962.0 bump was verified via asar analysis (content byte-identical: host-loop generator, system prompt, identity string, gates, and egress domains all unchanged) plus a full local test suite pass. The 1.15962.1→1.17377.1 bump moved the staged agent to **2.1.197** and added `api.claude.ai` to the egress allowlist; re-verified via `sync` (no unknown deltas) plus a manual asar spot-check of the reconstructed prompt content (substantively unchanged — see the Parity entry in CHANGELOG.md) and a full live scenario-suite pass (`protocol` + `container` tiers).

The handshake and shapes below were confirmed empirically with an end-to-end run, not inferred:

1. **Spawn flags:** `-p --verbose --input-format stream-json --output-format stream-json --permission-prompt-tool stdio`. The `stdio` permission-prompt-tool is what routes `can_use_tool`/AskUserQuestion to the driver; `--verbose` is required by `--output-format=stream-json --print`.
2. **Handshake:** the driver sends `{type:"control_request", request_id, request:{subtype:"initialize"}}` as the first message, then the user turn. Without it, permissions/questions are auto-handled (AskUserQuestion is silently dismissed).
3. **Inbound permission/question:** `{type:"control_request", request_id, request:{subtype:"can_use_tool", tool_name, input, tool_use_id}}`. For AskUserQuestion, `input.questions[] = {question, header, options:[{label,description}], multiSelect}`.
4. **Response envelope (nested!):** `{type:"control_response", response:{subtype:"success", request_id, response:{behavior:"allow", updatedInput} | {behavior:"deny", message}}}`. The payload sits under an **inner** `response`; missing that nesting yields `ZodError: expected object, received undefined`.
5. **AskUserQuestion answer:** allow with `updatedInput = {questions, answers}` — BOTH keys required (dropping `questions` breaks the binary's built-in `questions.map(...)` handler); `answers = Record<questionText, chosenLabel>` (the CLI's own schema is `z.record(z.string(), z.string())`). The model receives the answer and proceeds.

> **Cowork mode is enabled by env, not a flag.** In the staged agent (2.1.197) `--cowork` is a *plugin-scope* flag ("can only be used with user scope") and is rejected by the agent invocation; cowork mode is entered via **`CLAUDE_CODE_IS_COWORK=1`**. (Do **not** also set `CLAUDE_CODE_USE_COWORK_PLUGINS` — Desktop doesn't, and it flips the agent's userSettings filename to `cowork_settings.json` and plugin cache to `cowork_plugins/` via `TSO()` — the minified Desktop helper that derives the cowork settings/cache paths; plugins are delivered via `--plugin-dir`.) The host CLI is a different (macOS) build, so L0 runs plain (control-loop validation only); L1/L2 run the staged **Linux/arm64** binary — bind-mounted from the user's own install.

### Spawn contract + host-loop vs VM-loop (binary-verified through asar 1.17377.1; asar analysis since carried through 1.20186.0 — the full spawn contract is byte-identical across the 1.18286.0→1.18286.2 bump, and behaviorally identical across the 1.18286.2→1.19367.0→1.20186.0 re-minifications: the value-resolved contract is unchanged and only minified symbol names + bundle layout moved (in 1.20186.0, hoisted helpers became namespace-method calls and const spreads became export aliases), re-verified via the structural anchors and the live-asar spawn-contract tests plus a 1.20186.0-shaped drift-guard fixture — the live end-to-end pass now covers `1.20186.0` too (see the "Control protocol" note above), superseding the prior `1.19367.0` pin)

The full Desktop→agent spawn contract (cwd `/sessions/<id>`, `CLAUDE_CONFIG_DIR=mnt/.claude`, the env object, `--tools`/`--allowedTools`/`--plugin-dir`/`--effort`/`--setting-sources`, permission layers, prompt templates) is documented in [docs/cowork-spawn-contract-1.12603.1.md](./docs/cowork-spawn-contract-1.12603.1.md) — historical, pinned to 1.12603.1 and not updated per release — and encoded in `baseline.spawn`, which is the live source of truth.

**Which Cowork? — both are implemented.** Production runs **host-loop** (the host-loop GrowthBook gate `1143815894`, forced on per the decoded *fcache* — Desktop's on-disk GrowthBook feature-flag cache): the agent loop runs on the host, shell is `mcp__workspace__bash` into the VM, `${CLAUDE_PLUGIN_ROOT}` is a host path. VM-loop (gate off / `requireCoworkFullVmSandbox` orgs) runs the whole agent in the sandbox.

- `fidelity: container | microvm` → **VM-loop** (the whole agent in the sandbox).
- `fidelity: hostloop` → **host-loop**: the agent LOOP is a **native process spawned directly on the host** (Desktop stages this same native macOS binary alongside the Linux/arm64 ELF the other tiers use), with native Bash/WebFetch disabled (`--disallowedTools`) and the agent's shell routed through the **workspace SDK-MCP server** — declared via `sdkMcpServers:["workspace"]` in the `initialize` handshake, with the driver (`src/agent/session.ts` + `src/hostloop/workspace-handler.ts`) handling `mcp_message` JSON-RPC and executing `bash` via `docker exec` into a VM sidecar container (no agent runs inside it) at `/sessions/<id>/mnt`. `${CLAUDE_PLUGIN_ROOT}` for the native process points at the staged plugin copy directly (a real host path); bash's `docker exec` still gets an intentionally-unresolvable sentinel so it self-heals via `find /sessions/<id>/mnt …`, exactly like production. Connected folders are bind-mounted (never copied) into both the native process's view and the VM sidecar, so the native file tools and bash see the same bytes. With no container around the native file tools, a PreToolUse hook (`src/hostloop/pretooluse-path-hook.ts`, a byte-faithful port of production's own containment check) is the security boundary for real filesystem access — see [docs/boundary.md](./docs/boundary.md) for the full safety posture (writable-folder consent, the runtime tripwire).
- `fidelity: cowork` → **auto-picks** host-loop vs VM-loop using Cowork's own decision logic (`src/loop-decision.ts`, an exact replica of Desktop's minified `f_()` loop-decision function): `requireFullVmSandbox ? vm : (dev override ? host : gate 1143815894)`. With the synced gate forced on, `cowork → hostloop`. (The replicated `f_()` **decision shape** is pinned to asar 1.12603.1 per `src/loop-decision.ts`; the 1.15200.0→1.15962.0 sync re-derives only the **gate value** it reads, not the logic.)

The **bash-visible world is identical** in both (`/sessions/<id>/mnt/...`); the agent-loop world differs (`${CLAUDE_PLUGIN_ROOT}` resolution, the shell tool). Use `hostloop` (or `cowork`) for production-faithful skill testing; `container` for fast VM-loop.
