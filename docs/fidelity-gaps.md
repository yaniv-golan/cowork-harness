# Fidelity gaps

This document explains where the harness intentionally diverges from real Claude Cowork behaviour and why each gap exists. It's aimed at developers who hit something unexpected and want to know if it's a bug or an architectural limit.

> **TL;DR** — Most gaps are caused by one of three things: (1) Docker containers freeze their mount namespace at creation time; (2) real Cowork uses a proprietary native Swift binary (`@ant/claude-swift`) that wraps private Apple VZ APIs; or (3) the gap doesn't exist in real Cowork either — the harness faithfully reproduces a Cowork limitation.

For how the harness *enforces* the limitations it does reproduce (sealed filesystem, default-deny egress, MCP-only crossing, per tier), see [boundary.md](./boundary.md).

---

## Mid-session folder addition

**Real Cowork behaviour:** In an agent-mode session you can click the paperclip to add a working folder mid-session and the agent immediately has live read/write access to it.

**Harness behaviour:** Not supported live. The closest equivalent is `docker cp`, which injects a one-way snapshot — agent writes stay in the container and do not propagate back to the host.

### Why it can't be replicated

Real Cowork's `mountFolderForSession` has three distinct paths (verified against `app.asar`):

| Session state | What Cowork does |
|---|---|
| **Host-loop mode** | Registers the host path; notifies agent `"Read/Bash work there directly."` No mount — agent file tools already run on the host process. |
| **VM running** | Calls `@ant/claude-swift`'s `native.vm.mountPath(vmProcessId, hostPath, mountName, "rw")` — a proprietary native Swift binary that hot-mounts a VirtioFS share into the running Apple VZ microVM via private, undocumented VZ APIs. |
| **VM not running** | Queued for next resume: `"It will be available at /sessions/{vm}/mnt/... on next resume."` Not live even in real Cowork. |

The live VM hot-mount path uses `@ant/claude-swift` (`swift_addon.node`), a native Anthropic binary that calls Apple VZ framework internals not exposed in the public API. Neither Docker nor Lima exposes an equivalent:

- **Docker** — mount namespaces are frozen at container creation; `docker update` has no mount support; `nsenter --mount` + `mount --bind` requires `CAP_SYS_ADMIN`, which the harness deliberately withholds.
- **Lima / Apple VZ** — `limactl` has no hot-plug mount command; `VZVirtualMachineConfiguration` accepts filesystem devices only before `startWithCompletionHandler`.

### Workarounds

- **Startup `--folder <dir>`** — stages a **fresh copy** of the dir into the session tree (not a live bind mount of the original). The agent reads and writes that copy, but its writes land in the run's `mnt/<folder>` output, **not** back in your original host directory. Restart `chat` with this flag to give the agent a working copy of your project files, then collect any edits from the run's `mnt/<folder>`.
- **`docker cp` snapshot** — run `docker cp /local/dir/. <containerName>:/sessions/<id>/mnt/dir/` in a second terminal to inject a one-way snapshot mid-session, then tell the agent the path. Agent writes stay in the container and do not propagate back to the host.

---

## Folder access in `chat` sessions

**Real Cowork behaviour:** The "add folder" button is disabled for chat sessions. `mountFolderForSession` returns `{ok: false, error: "Folder access isn't available in chat sessions."}` at the IPC layer.

**Harness behaviour:** Same shape. Both `chat` and `skill` accept a *startup* `--folder <dir>` (which stages a fresh copy of the dir; agent writes land in the run's `mnt/<folder>` output, not back in the host original — see Workarounds above). What neither supports — matching Cowork — is *mid-session* / hot-plug folder injection after the session has started.

This is **not a harness gap**. Startup folder access works in both commands; the only missing piece is mid-session injection, a faithful reproduction of Cowork's own limit (attaching a folder at session creation is allowed; adding one to a live session is blocked).

---

## `--raw` mode bypasses the egress sandbox

**Real Cowork behaviour:** All outbound network traffic from the agent is filtered through the configured egress allowlist.

**Harness behaviour:** `--raw` skips the control protocol and spawns the Claude binary directly via `docker run -it`, so the egress sandbox is never applied. `--raw` is a development escape hatch — intended for quick iteration without the protocol overhead, not for testing egress behaviour.

The `--help` text notes this at runtime. If you need to test egress policy, use `--fidelity container` (the default) or `--fidelity hostloop`.

---

## No session resume in `chat`

**Real Cowork behaviour:** Sessions persist and can be resumed across launches.

**Harness behaviour:** `chat` mints a throwaway session per invocation. There is no `--resume` flag.

The `skill` command supports `--session-id` + `--resume` for checkpoint-resume skills. This gap is not fundamental — it's implementation work. The resume path in `execute.ts` manages directory lifecycle (fresh vs. stale tree, `rmSync` on reuse) that `chat.ts` doesn't replicate. It's tracked as a future improvement.

**Workaround:** For checkpoint/resume debugging, use `skill … --session-id s1 --resume` for each turn instead of `chat`.

---

## System-prompt reconstruction

**Real Cowork behaviour:** Desktop appends a large cowork system prompt (identity, behavior policy, computer-use/file rules) on top of the agent's built-in base prompt.

**Harness behaviour:** The append is a per-baseline **paraphrased reconstruction** (`baselines/prompts/desktop-<ver>/system-prompt-append.md`) — behaviorally equivalent, not byte-identical (verbatim shipping of Anthropic's prompt text is deliberately avoided). Three intentional divergences, each logged in the asset header:

- **Generic refusal/safety policy is elided** — the agent's base prompt already carries safety; only cowork-behavior-driving sections are reconstructed. (Formatting/tone guidance *is* included as of the 1.18286.0 asset — the base prompt does not carry it.)
- **`computer://` links are described, not instructed.** Real Cowork's model ends file deliveries with `[View your report](computer://…)` links; the harness's workspace token renders a `/sessions/…` path the prompt itself forbids exposing, so harness transcripts reference files directly instead of emitting `computer://` URIs. Don't assert on `computer://` in transcripts.
- **The Desktop artifact renderer's library/CDN catalog is trimmed** from the artifacts section — the harness has no artifact UI; the file-behavior rules (single-file HTML/React, .md-vs-.docx choice) are kept.

**Why:** paraphrase is a licensing/bundling constraint; the other two follow from tokens and UI surfaces that don't exist off-Desktop.

---

## Fidelity tier differences

The harness `--fidelity` flag selects how closely the execution environment matches real Cowork. Each tier trades fidelity for speed. For the canonical description of each tier (what it runs, when to pick it), see [README → Fidelity tiers](../README.md#fidelity-tiers-pick-per-scenario--per-ci-job) and [boundary.md](./boundary.md); the table below is the *gaps* view — what each tier does **not** reproduce.

| Tier | Gaps vs. real Cowork (what it does **not** reproduce) |
|---|---|
| `protocol` | No sandbox, no filesystem isolation, no egress boundary. |
| `container` (default) | No Apple VZ microVM; the container mount namespace is frozen at start (no mid-session mounts). |
| `microvm` | Slow boot (~20s); macOS arm64 only; egress is the same allowlist proxy as `container`, **not** a gVisor netstack. |
| `hostloop` | Not an isolation gap — it reproduces Cowork's real host-loop split: the agent loop is a native host process (no container around the file tools, matching production's own risk model — see [docs/boundary.md](./boundary.md)); only shell/web route through a Docker VM sidecar. |
| `cowork` | Resolves to `hostloop` or `container` at run time — inherits whichever tier's gaps. |

The `chat` command accepts `protocol`, `container`, and `hostloop`. `microvm` and `cowork` are omitted — `microvm` has a slow boot (~20s) that makes interactive use painful, and `cowork` would require replicating the cowork-tier wiring, which resolves the tier via the shared `decideLoopFromBaseline` gate logic (`src/run/execute.ts` → `src/loop-decision.ts`).
