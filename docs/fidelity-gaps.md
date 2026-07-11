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

**Harness behaviour:** The append is a per-baseline **paraphrased reconstruction** (`baselines/prompts/desktop-<ver>/system-prompt-append.md`) — behaviorally equivalent, not byte-identical (verbatim shipping of Anthropic's prompt text is deliberately avoided). Two intentional divergences, each logged in the asset header:

- **Generic refusal/safety policy is elided** — the agent's base prompt already carries safety; only cowork-behavior-driving sections are reconstructed. (Formatting/tone guidance *is* included as of the 1.18286.0 asset — the base prompt does not carry it.)
- **The Desktop artifact renderer's library/CDN catalog is trimmed** from the artifacts section — the harness has no artifact UI; the file-behavior rules (single-file HTML/React, .md-vs-.docx choice) are kept.

**Residual behavior note:** `<sharing_files>` now instructs `computer://` links exactly as production does — this is no longer a divergence. The harness resolves those links in the **display layer**, at **hostloop** fidelity only (the tier where the "host" side of a mount is production's own real host path); delivery is verified with the `computer_links_resolve` assertion. Container/microvm display keeps VM-shaped `/sessions/…` links — the honest form for those tiers, since translating to the harness's own staging paths would be less faithful than showing the VM path production's model also emits. Assert links via `computer_links_resolve`, not literal link text.

**Why:** paraphrase is a licensing/bundling constraint; the artifacts trim follows from a UI surface that doesn't exist off-Desktop.

---

## Host-derived identity env vars

**Real Cowork behaviour:** The Desktop→agent spawn sets a block of host-derived identity/telemetry env
vars (binary-verified against `app.asar` 1.18286.0 and the in-VM ELF): `CLAUDE_CODE_HOST_PLATFORM`,
`CLAUDE_CODE_WORKSPACE_HOST_PATHS`, `CLAUDE_CODE_ACCOUNT_UUID`, `CLAUDE_CODE_USER_EMAIL`,
`CLAUDE_CODE_ORGANIZATION_UUID`, and the `OTEL_*` telemetry config.

**Harness behaviour:** The two that are derivable headlessly **are now emitted** at the spawn-env seam
(`src/runtime/argv.ts`): `CLAUDE_CODE_HOST_PLATFORM` (= `process.platform`, on every tier that assembles
the Cowork spawn env — container/microvm/hostloop; protocol (L0) spawns with the plain base env) and
`CLAUDE_CODE_WORKSPACE_HOST_PATHS` (the real host paths of connected folders, `"|"`-joined, **hostloop
only**). The hostloop-only scoping is a **deliberate, documented divergence**: production stages folders
into the VM as copies and still sets the var with real host paths, and the harness knows the mount-source
host paths at container/microvm too — but emitting them there would bake machine-specific `/Users/…` paths
into cassettes (breaking machine-independent replay) and would let a model that runs `env` in the guest
trip the harness's own container-tier `host_path_leak` default-fail. The remainder are **intentionally
not emitted**:

| Var | Why not emitted |
|---|---|
| `CLAUDE_CODE_ACCOUNT_UUID` / `_USER_EMAIL` / `_ORGANIZATION_UUID` | Live authenticated Desktop account state (`u.accountId` / `r.emailAddress` / `u.orgId`). The harness holds only an opaque OAuth token — these UUIDs and the account email are not derivable from it. Production even guards the whole block on all three being present, so omitting them together is closer to a real unauthenticated/partial session than emitting fabricated values. |
| `OTEL_*` | Derived from Desktop's telemetry config and points at Anthropic telemetry infrastructure; no faithful headless value. |
| `CLAUDE_CODE_SUBAGENT_MODEL` | Gate/config-conditional on a Desktop config function that is normally unset; value not statically determinable. |
| `ENABLE_TOOL_SEARCH` | Statsig-gated (same dynamic-flag class the sync pins as `DARK_GATES` drift sentinels); emitting unconditionally would overstate production. The `ToolSearch` tool itself is already modeled in the baseline `tools`/`allowedTools`. |

**Why:** the account-identity vars require live Desktop account state the headless harness structurally
cannot know; emitting fabricated values would be a worse divergence than their documented absence.

---

## Guest runtime identity — per-session Unix user, uid/gid, and HOME

**Real Cowork behaviour (runtime-verified 2026-07-04 against coworkd's own logs, recovered from a
local install's VM disk images, Desktop 1.18286.0-era):** inside the VM, Cowork's init (`coworkd`)
provisions a **dedicated Unix account per session** at session start —
`useradd -u <uid> -g <gid> -M -d /sessions/<slug> -s /bin/bash <slug>` — and spawns both the agent
process (`/usr/local/bin/claude`) and every `bash` tool call as that user, via per-command
`oneshot-<uuid>` supervisor jobs that also perform the session's mounts. Username = the session
slug; uid = gid, allocated sequentially upward per session (observed 1014–1455 on one long-lived
image); `HOME=/sessions/<slug>` — the **writable session root**, not a throwaway dir. (Internal
service sessions get the same treatment under other names, e.g. `office-convert-<hex8>` for
LibreOffice conversions.)

**Harness behaviour:** the container/microvm agent runs as the image's **static uid-1000 `ubuntu`**
user (`docker/Dockerfile.agent`) with a forced **`HOME=/tmp`** (`spawnEnv`,
`src/runtime/argv.ts`). The hostloop *native* agent runs as the real macOS user — faithful, since
production's host-loop process does too — but its VM sidecar (bash/web) shares the container-tier
identity. Observable divergences for a skill: `whoami` (slug vs `ubuntu`), `id -u` (per-session
value ≥1014 vs 1000), `~`/`$HOME` resolution (`/sessions/<slug>` vs `/tmp` — a `~`-relative write
lands in the session tree in production but in the container tmpfs here), and file ownership as
shown by `ls -l`.

**Why:** the uid-1000 choice predates this evidence — "the real rootfs does" described the image's
static `/etc/passwd`, not the runtime account coworkd creates. Currently a documented divergence;
the HOME value is a cheap env fix, and username/uid parity is feasible (a generated passwd bind +
`--user`) but unimplemented. Matters only to skills that read their own identity or write under
`~`.

---

## Session slug shape

**Real Cowork behaviour (same forensic source):** VM session slugs are Docker-style name triples
`<adjective>-<adjective>-<noun>` (e.g. `beautiful-bold-planck`, `friendly-laughing-bell`) —
hundreds observed, zero UUID-shaped. A `local_<uuid>` shape *does* exist in production, but only
**host-side**, as Desktop's session-record filenames (`claude-code-sessions/…/local_<uuid>.json`),
never as the in-VM `/sessions/<slug>` path.

**Harness behaviour:** `local_<hrtime-base36>` (e.g. `local_9hldogcxp`; `src/run/execute.ts`), or
`sess-<id>` under `--session-id` — coincidentally shaped like production's *host-side* record id,
in the guest position where production puts a name triple. Nothing in the harness or its scanners
parses slug shape (they match on the `/sessions/` prefix), so this is cosmetic — visible only to a
skill that echoes or pattern-matches its own cwd.

---

## Gate `1648655587` is the scheduled-task session limiter — no in-conversation Task cap exists

**What the gate actually is (binary-verified 2026-07-04, asar 1.18286.0):** gate `1648655587`
(`{perTask:1, global:3}`) governs Cowork's **scheduled/recurring (cron) task** scheduler (`class
L9t` "[ScheduledTasks]"), NOT the in-conversation `Task` tool. It skips launching a scheduled-task
*session* beyond **≤1 concurrent session per scheduled task** / **≤3 concurrent scheduled-task
sessions globally**. This corrects an earlier mislabeling of this gate as an in-conversation
"Task-dispatch rate-limiter."

**Real Cowork behaviour for the `Task` tool:** none of the above applies — the Desktop imposes **no
concurrency cap** on in-conversation `Task`-tool sub-agent fan-out (the `Task` PreToolUse hook only
blocks `run_in_background`). So a skill that fans out many sub-agents in one conversation is not
throttled in production either.

**Harness behaviour:** the harness runs a single foreground session and has no scheduled-task
scheduler, so gate `1648655587` has **no applicable surface** to reproduce; it is pinned only as a
sync drift-sentinel (`src/sync/cowork-sync.ts`). There is no production Task-fan-out cap to be
unfaithful to. `dispatch_count_max` (`src/assert.ts`) remains a useful **author-chosen** budget
assertion — catch a fan-out you don't want — not enforcement of a production cap.

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

---

## Booting the real rootfs image under a generic VZ host

**Real Cowork behaviour:** the rootfs boots under Anthropic's proprietary `@ant/claude-swift`
VZ host, which provides Anthropic-specific virtio devices (the `smol-bin` device and a control
channel) that the guest's own init depends on.

**Harness behaviour:** not supported — tested infeasible (2026-06-21). Booting the extracted
rootfs under a generic VZ host (Lima) fails structurally: `coworkd`, the rootfs's PID-1 init
(not standard systemd/cloud-init), loops on `failed to mount smol-bin: smol-bin device not
found after 10s` waiting for the host-side virtio device only Claude Desktop's own VZ host
provides — and Lima in turn hangs waiting for its own guest agent, because cloud-init/NoCloud
is present in the image but never reached (coworkd hijacks boot before multi-user, so Lima can
never SSH in). Replicating Anthropic's device model is out of scope. A runnable diagnostic
script (`scripts/boot-rootfs-vz.ts`) existed through 0.29.0 and was removed as dead weight —
this section preserves its finding.

### Why it can't be replicated

The blocker is the device model, not the filesystem: the guest's PID-1 is hardwired to
host-provided virtio devices that only the proprietary Swift host binary implements. The
supported real-rootfs parity path sidesteps boot entirely: `scripts/build-rootfs-image.ts`
`docker import`s the rootfs *filesystem* and the harness execs the agent directly — bypassing
`coworkd` init and its host-device coupling — producing an agent image with verified
byte-for-byte file parity, consumed via `COWORK_AGENT_IMAGE`.
