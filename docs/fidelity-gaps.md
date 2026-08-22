# Fidelity gaps

This document explains where the harness intentionally diverges from real Claude Cowork behaviour and why each gap exists. It's aimed at developers who hit something unexpected and want to know if it's a bug or an architectural limit.

> **TL;DR** — Most gaps are caused by one of three things: (1) Docker containers freeze their mount namespace at creation time; (2) real Cowork uses a proprietary native Swift binary (`@ant/claude-swift`) that wraps private Apple VZ APIs; or (3) the gap doesn't exist in real Cowork either — the harness faithfully reproduces a Cowork limitation.

For how the harness *enforces* the limitations it does reproduce (sealed filesystem, default-deny egress, MCP-only crossing, per tier), see [boundary.md](./boundary.md).

---

## Mid-session skill/plugin re-sync

Cowork re-syncs skills and plugins from the host into the session **while the session is running** —
Desktop's runtime config carries `skillsSyncIntervalMs` and `pluginsSyncIntervalMs` (20 min) plus a
`pluginsFullSyncStalenessMs` full-pass threshold (1 h). The skills timer additionally skips while the
app window is unfocused, so 20 minutes is a ceiling rather than a rate. The harness stages skills and
plugins once per run and never re-stages them.

**This is deliberate, and it should stay that way.** The reason is not merely that a timer would be
awkward to emulate: the harness stages from a git-tracked, immutable-per-run source, so "the skill
changed mid-run" has **no in-harness event to trigger on**. Modelling re-sync would mean inventing a
mutation the harness has no way to observe, then choosing when to fire it — which is authoring
behaviour, not reproducing it.

Determinism reinforces the call. A wall-clock re-stage makes the same scenario pass or fail depending
on how long the model took, which a cassette cannot freeze and `stats` cannot compare across runs. It
also weakens `skillHash` as a version key: a run whose skills change partway through has no single skill
set for the hash to name.

**The residual, stated plainly:** a long-running interactive `chat` session diverges from production.
Edit a skill mid-session in Cowork and the agent eventually picks it up; edit one mid-session here and
it never will. Restart the run to pick up an edit — which is the workflow the `skill` command already
assumes.

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

## Artifacts — two mechanisms, neither modeled

**Real Cowork behaviour:** Cowork has two mutually exclusive artifact mechanisms, and a given session
runs exactly one of them. The legacy mechanism bind-mounts one host directory per artifact into the
VM. The newer mechanism ("frame artifacts") instead gives the agent an `Artifact` tool in its tool
list — no per-artifact mount at all. Which one a session gets is decided by a server-delivered session
flag, `frameArtifactsEnabled`, that arrives with the rest of the session config alongside flags like
`memoryEnabled`/`skillsEnabled` — it is not a feature gate readable on the machine, so neither the
harness nor the user can observe its value locally. The flag is off by default today, so production
currently takes the legacy bind-mount path.

The bind-mount only happens in the **VM-loop** spawn path — host-loop never mounts artifact
directories, though the same host paths still appear in host-loop's read-only path allowlist as
readable-path entries, not mounts. When the `Artifact` tool is present, it sits in the session's tool
list but outside the pre-approved allowed-tools list, so it must go through the same `can_use_tool`
permission flow as `AskUserQuestion`.

**The tool is not VM-loop-only.** The frame-artifacts predicate tests the session flag, the session
type, the scheduled-task id, bridge and dispatch-child status and the HIPAA restriction — it does *not*
test the loop tier. So a **host-loop** session with the server flag on gets the `Artifact` tool as well,
even though host-loop never receives artifact *mounts*.

The same release added a **host-loop-only approval-integrity guard** in front of the permission chain,
and it is a shape nothing here models. Before any other check runs it denies an `Artifact` publish whose
`file_path` is a VM path (`/sessions/...`) — the host loop publishes from the host filesystem, where that
path does not exist. Then it records the file's identity (`realpath`, device, inode) at the moment the
approval is *requested*, and after the user answers it re-checks: if the file changed, moved, never
existed at that path, or cannot be verified, the publish is refused even though it was approved. It also
refuses an approval whose `updatedInput` widened a non-publish action into a publish. **This is a
post-decision veto** — an `allow` returned by the permission flow can still become a `deny` afterwards —
and the harness's Decider chain has no such stage: a decision here is final once made.

**Harness behaviour:** neither mechanism is modeled. The harness's mount kinds are connected folders,
projects, uploads, and the three plugin kinds (local, remote, marketplace) — there is no
artifact-directory mount, and no `Artifact` tool at any tier. (`outputs` is not a mount at all; it is a
synthetic root the run tree always carries.)

**The residual, stated plainly:** on the VM tiers, production currently mounts artifact directories
and the harness mounts none; on host-loop there are no artifact *mounts* to differ over, but the `tool`
is reachable there and the harness serves it at no tier.
This is a deliberate non-modeling decision, not an oversight: the mount branch is the one Anthropic is
retiring, and the harness has no way to observe the server flag that selects between the two
mechanisms. If the flag flips, the mount difference disappears on its own and the gap becomes the
missing `Artifact` tool instead. Revisit trigger: a real session showing `Artifact` in its tool list.

The two mechanisms are mutually exclusive but not exhaustive — there is a third state. The tool
additionally requires an **attended** turn, while the mount suppression does not check that, so a
session with the flag on whose turn is unattended (a scheduled or otherwise non-interactive run) gets
**neither** the artifact mounts nor the `Artifact` tool. Reading "one or the other" as a guarantee that
some artifact mechanism is always present would be wrong.

### The session flag also reaches into the agent, and unattended artifact actions hard-refuse

Two further properties widen this gap beyond "a tool is missing".

**The flag is not only a Desktop concern.** It decides what Desktop puts in the spawned tool list, and
the agent binary separately reads the corresponding spawn environment key itself, using it to select its
own artifact publish surface and a read-only artifact mode. So the flag governs agent behaviour
directly, not just the tool inventory — and its value travels with the session config, so neither the
harness nor the user can observe it locally.

**An unattended session gets a hard refusal rather than a prompt.** The agent carries a consent floor
for artifact actions: publishing, replying to a comment, resolving a comment thread, and writing to an
artifact's database each refuse outright when the session has no answerable approval surface, with the
refusal explicitly telling the model not to retry in that session. There is a fail-closed case too — if
the permission check cannot confirm an approval surface exists, the action is denied rather than
allowed. Listing one's own artifacts is carved out as read-only and stays permitted.

**Why this is documented rather than modeled**, beyond the flag being unobservable: artifact operations
are **server-backed**. The agent takes an artifacts API base URL and an API token, and the endpoints
involved are not in the sandbox's egress allowlist. Supplying the spawn flag and adding the tool would
therefore not reproduce production behaviour — it would offer a tool that resolves against a service the
sandbox cannot reach and holds no credential for. Reproducing the *refusal* path alone, without the
corresponding success path, would match neither of the states a real session can be in.

**What this means for a skill under test.** No artifact action is reachable here at all: the harness
serves no artifact tools and does not spawn the `Artifact` tool at any tier, so a skill cannot attempt a
publish, a comment, or a database write. This is an absent capability rather than a behavioural
difference — there is no action whose outcome differs. The practical consequence is that a skill relying
on artifacts cannot be exercised in this harness, and a green run says nothing about how it would behave
in a real unattended Cowork session, where these actions now refuse rather than prompt.

---

## HIPAA restriction is a process-global latch

**Real Cowork behaviour:** when an account or org is HIPAA-restricted, Cowork latches that state at
the module level in the Desktop process — once set, it stays set for the life of the process, across
every session the process handles, not just the one that triggered it. While latched, it disables
memory sync and the frame-artifacts feature described above.

**Harness behaviour:** HIPAA-restricted deployments are not modeled at all — there is no equivalent
latch, and no way to simulate one.

**Why it's worth documenting:** a real Desktop process can legitimately show a different tool list or
feature set than the baseline describes, with no observable feature-gate change to explain it — the
org's HIPAA status flips a process-global latch that nothing else surfaces. Useful to know before
chasing a phantom drift between a live probe and the pinned baseline.

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

## Server-driven system-prompt patches (`coworkSyspromptMap`)

**Real Cowork behaviour:** Desktop carries a **server-driven, per-session** patch channel for the cowork prompt section. Entries are keyed `<name>(.replace|.append)?`, and the suffix picks the mode. `append` adds text after the computed section. **`replace` discards the computed section entirely** and emits `[text, ...appends].join("\n\n")`. Built-in variants are validated at startup — a replace-mode variant must contain `{{promptCacheBoundary}}` or Desktop throws. A **server-supplied** entry is validated later, on the resolution path, which **degrades instead of throwing**: a boundary-less `replace` resolves to `missing_boundary`, the session gets a different prompt, and nothing errors. The channel is long-standing, present in 1.24012.1, 1.24012.11 and 1.25927.0 alike.

**Harness behaviour:** modeled nowhere. The harness always renders the section above as an append onto the `claude_code` preset from its per-baseline reconstruction asset. No variant is ever applied, and there is no flag to simulate one.

**Why it can't be replicated:** the entries come from the server, per session. There is no static artifact to reconstruct and no way to know what any given live session was served — a baseline can only record what is *in the asar*, and the patch content is not. What *can* be pinned is the channel's **shape**, and the shape is what makes it consequential: `checkSyspromptMapFacts` (see [maintenance.md](./maintenance.md#drift-detection--two-independent-signals)) hard-fails `sync` if the mode vocabulary widens past the closed `replace`/`append` set, the key grammar moves, the boundary invariant disappears, or the resolution-status machine changes. That guarantees a change in what the channel *can do* is caught before a user hits it; it does not tell you what any session was served.

**What this means for a test result:** if a live session is served an active `replace` variant, production drops the computed cowork section and the harness keeps it — a **structural** divergence, not a wording one. A skill whose behaviour leans on something that section says can pass here and behave differently live. There is no workaround at the harness level; treat a prompt-sensitive result as tier-limited evidence, the same way you would a paraphrase-sensitive one.

---

## Browser↔webview↔human-interaction boundary (interactive artifacts)

**Real Cowork behaviour:** Desktop can render a self-contained HTML/React artifact in an embedded
webview, served from Cowork's own origin. A human looks at the rendered page and can click it —
including a "Submit" button that fires a client-side `fetch`/XHR/`sendBeacon`/form POST back to
that origin, or a fallback that triggers a file download via a synthetic `<a>` click.

**Harness behaviour:** The harness runs the agent headless. There is no rendered browser, no
webview, and no human clicking anything. It can observe what the agent's tool calls *wrote* (file
contents, HTTP requests the agent itself made) but not what a client-side script does once loaded
into a real DOM by a person, nor what that person sees on screen.

### Why it can't be replicated live

This closes off an entire class of Cowork bug from live observation. The concrete shape: an
interactive HTML artifact's "Submit" button issues a client-side write-back to a *relative*
endpoint — `fetch("/api/save", {method:"POST"})`, an XHR POST, `sendBeacon("/…")`, or a plain
`<form method=post action="/…">`. Under real Cowork the artifact is served from **Cowork's own
origin**, so the relative URL *resolves* — but there's no such endpoint behind the webview, so the
request comes back non-ok. A page that doesn't check `resp.ok` runs its success branch anyway,
showing the user a false "Saved!". The common fallback — downloading the data via a synthetic `<a>`
blob-URL click — is **also** broken under Cowork: `a.click()` blanks/navigates Cowork's own
embedded artifact viewer instead of producing a retrievable download. A
`location.protocol === "file:"` guard doesn't catch this either, since the origin is a real
`http(s):` origin, not `file:`.

None of this is visible from outside a rendered browser with someone driving it. The agent's own
transcript shows a clean tool call and a well-formed artifact on disk; the failure only exists in
the DOM state a human would see after clicking — the harness's headless agent never renders or
clicks anything, so it never reaches that state. Reading the artifact's JavaScript closely enough
to reconstruct what it does is the only way to catch this without an actual browser and a human in
the loop.

**Consequence for the harness's design:** because no live run — however faithfully sandboxed — can
ever observe this, the fix has to live outside the live-execution path: either a static check of
the artifact-generating source for the relative-write-back pattern (no browser needed, runs the
same in CI as at authoring time), or an offline confirmer that loads the *materialized* artifact
into a headless DOM and drives it programmatically after the run. Both work without a rendered
browser or a human; a live run alone cannot.

The static check ships two ways: the out-of-band `analyze-skill` scan (source or a run dir), and the
per-scenario `no_lost_write_back: true` assertion, which runs the same detector over the files a run
authored and folds the result into the run's verdict (live/verify-run; see [subagents.md](./subagents.md)
and [scenario.md](./scenario.md)).

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

## Gate `1648655587` is the scheduled-task session limiter — distinct from the agent-side Task fan-out cap

**What the gate actually is (binary-verified 2026-07-04, asar 1.18286.0):** gate `1648655587`
(`{perTask:1, global:3}`) governs Cowork's **scheduled/recurring (cron) task** scheduler (`class
L9t` "[ScheduledTasks]"), NOT the in-conversation `Task` tool. It skips launching a scheduled-task
*session* beyond **≤1 concurrent session per scheduled task** / **≤3 concurrent scheduled-task
sessions globally**. This corrects an earlier mislabeling of this gate as an in-conversation
"Task-dispatch rate-limiter."

**Real Cowork behaviour for the `Task` tool:** the scheduled-task limiter does not apply, but `Task`
fan-out IS capped **agent-side** (`taskRegistry`, binary-verified agent 2.1.217), a separate mechanism:
a **concurrent** cap (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, default **20**; error
`subagent_concurrency_cap`; bypassed under gate `tengu_amber_kestrel` or ultracode x-high effort; landed
2.1.217) and a **per-session** cap (`CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION`, default **200**; error
`subagent_count_cap`; present since ≤2.1.215), with nesting off by default (depth 1, gate
`tengu_hazel_trellis`). So a skill that fans out past those limits IS throttled in production.

**Harness behaviour — faithful by inheritance:** the harness runs a single foreground session and has no
scheduled-task scheduler, so gate `1648655587` has **no applicable surface** to reproduce (pinned only as
a sync drift-sentinel, `src/sync/cowork-sync.ts`). The `taskRegistry` fan-out caps, by contrast, ARE in
effect: Desktop sets none of the cap env vars, so the real agent uses the defaults, and the harness
inherits them by spawning the same agent binary (it sets neither var) — a run that fans out past the cap
hits the same `subagent_concurrency_cap`/`subagent_count_cap` error real Cowork does. `dispatch_count_max`
(`src/assert.ts`) remains a useful **author-chosen** budget assertion — your tighter budget under that
production ceiling — not a reproduction of the cap.

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

---

## Protocol-tier sub-agents get no Cowork environment append

**Real Cowork behaviour:** every session delivers a per-loop sub-agent environment append
(`subagent_env_hl` on host-loop, `subagent_env_vm` in the VM loop) via the `initialize`
control_request; the agent applies it to Task-dispatched children (fork/`useExactTools` dispatches are
excluded agent-side).

**Harness behaviour:** hostloop delivers the hl branch, container/microvm the vm branch; the
**protocol** tier deliberately sends none. Protocol runs the CLI over a private `work/` cwd with no VM
mounts — neither branch's environment description is factually true there, so sending either would
teach the model false claims about its filesystem. Consequence: protocol sub-agents get no Cowork
environment framing. This is a decided divergence, not an oversight; use hostloop (the production
default loop) or container for sub-agent environment fidelity.

---

## Path-gate roots are frozen at spawn

**Real Cowork behaviour:** the host-loop path gate recomputes folder-permission and mid-session
read-only roots PER HOOK CALL (`getFolderPermissionPaths()` / `getMidSessionReadOnlyPaths()` in the
per-call root assembly), so a folder added mid-session is picked up live.

**Harness behaviour:** `allowedRoots`/`readOnlyRoots` are computed once at spawn (hostloop.ts). The
harness has no mid-session folder-add mechanism (see "Mid-session folder addition" above), so the
frozen set is behaviorally equivalent today — there is nothing that could change between calls.
Revisit if mid-session adds ever land.

---

## Chat-lane session topology (scratchMode stays false)

**Real Cowork behaviour:** chat-type sessions have scratch containment (writes confined to
hostCwd/outputs) and read-roots that include uploads plus both `projects` spool dirs; plugin content is
absent from chat roots entirely.

**Harness behaviour:** the `chat` lane runs cowork-type sessions with `scratchMode: false`
(hostloop.ts, consented gap, security-reviewed 2026-07-04). Consequences vs a production chat session:
writes are gated by `allow_host_writes` consent instead of scratch containment; spooled-projects
read-roots exist only as the task-lane spool dir; connected-folder scope differs. The task-lane
read-only categories (uploads hardlink write-block, spool, plugin) ARE modeled.

---

## VM tiers have no workspace tool aliases

**Real Cowork behaviour:** host-loop aliases `Bash→mcp__workspace__bash` and
`WebFetch→mcp__workspace__web_fetch`; the VM loop ALSO aliases WebFetch to a host-side SDK-MCP
`web_fetch` (gate `coworkWebFetchViaApi`, live true) — "Bash is the only tool that truly diverges
between loops."

**Harness behaviour:** host-loop sets both aliases (`WORKSPACE_TOOL_ALIASES`, hostloop.ts) on the
`initialize` control_request. The container/microvm tiers register only the `cowork` SDK server — no
workspace `web_fetch` server exists there to alias to — so they set NO aliases. Consequence: a VM-tier
model emitting a bare `WebFetch` errors in the harness where production resolves it. Host-loop is the
production-default loop; use hostloop for alias-sensitive scenarios.

## Skill/plugin discovery SDK-MCP servers — modeled on container/hostloop; microvm/protocol pending

**Real Cowork behaviour:** a cowork session's rendered tool surface includes Desktop-side SDK-MCP
discovery tools — `mcp__skills__list_skills`, `mcp__skills__suggest_skills`,
`mcp__plugins__list_plugins`, `mcp__plugins__search_plugins`, `mcp__plugins__suggest_plugin_install`
(the `mcp-registry` and `scheduled-tasks` families likewise) — delivered
over the control protocol (`sdkMcpServers` in `initialize`, tunneled as `mcp_message`). These are
**advisory** tools: the model calls `suggest_skills` when the user asks for recommendations or when
`list_skills` returns no match, and the result renders an "Add" card. The call has **no side effect**
(nothing installs; the user's Add click happens out of band). Ground truth: these tools appear in the
`system/init` `tools` array of real on-disk sessions (`local-agent-mode-sessions/**/audit.jsonl`); the
`suggestSkillsEnabled` gate `245679952` is on. A proactive-suggestion mode sits behind a second gate
`1598976391` (`proactiveSkillSuggestEnabled`), which is **served ON** for a standard account as of the
`1.24012.11` baseline — by a server-side rollout, not a Desktop change (the gate reads ON on earlier
Desktop versions too). With it off, `suggest_skills` keeps its base description and the model suggests
only when the conversation invites it. With it on, the tool gains an optional `trigger` parameter
(`user_asked` | `proactive`), a proactive description that also carries production's *constraints* (a
do-not-call list, a suggest-at-most-once-per-conversation rule, a no-lead-in rule, and forwarding the
same keywords **and trigger** to `search_plugins`), and an empty-catalog `note` that chains into
`search_plugins` for every trigger state — silence is only the `proactive` tail, and a trigger the model
never supplied is never forwarded back to it. One production effect is **not** modeled: the flag is also
passed into Desktop's `generateSkillsSystemPrompt`, where it swaps a guidance line inside the generated
`<skills_instructions>` block. The harness renders no such section at all, so that effect lands in an
already-unmodeled surface.

**Harness behaviour:** `container` and `hostloop` (and `cowork`, which resolves to one of those) now
declare a `skills` and a `plugins` SDK-MCP server alongside `cowork`/`workspace` (`combineSdkMcp`,
`src/hostloop/skills-handler.ts` / `plugins-handler.ts`), each tool `alwaysLoad` so it appears in
`system/init.tools` from turn one, exactly like real Cowork. `list_skills`/`list_plugins` are populated
deterministically from the session's actually-staged skills/plugins (never a live catalog call);
`suggest_skills`/`search_plugins`/`suggest_plugin_install` return a deterministic, empty-catalog advisory
result (the real add/install catalog is Anthropic's live library, out of scope and out of band — an
empty result with an honest `note` is the faithful stub, not a bug). The two gates are read from the
synced baseline (`readGateBool`, bare-boolean shape — distinct from the sub-flag gates `readGateFlag`
reads) with a session-level override (`skills.suggest_enabled` / `skills.proactive_suggest_enabled`, see
[session.md](./session.md)). Precedence is knob ▸ baseline gate ▸ hardcoded fallback, and the three are
distinct: omit the knob and the value comes from the **synced baseline** (on `latest` that is
`suggestSkillsEnabled` on and `proactiveSkillSuggestEnabled` **on**, mirroring what production serves);
the hardcoded fallback, which applies only to a baseline old enough to predate the gate entirely, stays
on for `suggestSkillsEnabled` and **off** for `proactiveSkillSuggestEnabled`.

**How exact is the model?** Not uniformly — and the difference matters, so it is stated plainly. The
tool **inventory** (which five tools exist), their **inputSchemas**, the **gating** semantics, and the
`list_skills`/`list_plugins` **output envelopes** are derived from the Desktop asar plus real on-disk
session logs. The tool **description strings**, and the `search_plugins`/`suggest_plugin_install`
response envelopes, are a **faithful prose/shape reconstruction** — semantically equivalent to what the
asar analysis describes, but not captured byte-for-byte from the wire. Descriptions are precisely what
drives a model's tool-selection, so treat close-call selection behaviour around these five tools as
approximate: a skill that hinges on the model choosing `suggest_skills` over `list_skills` in an
ambiguous case may diverge from real Cowork. Presence, schema-shape, and gate-driven availability do not.

**Still not modeled:**
- **`microvm` and `protocol`** declare no `sdkMcp` server at all today — the discovery tools are absent at
  those two tiers, same as before this work. Use `container`/`hostloop` for discovery-adjacent scenarios.
- **The `mcp-registry` and `scheduled-tasks` families**, and the separate **`cowork-onboarding` server**
  (`show_onboarding_role_picker`, gate `2114777685` force-on) — real, but out of this surface's scope.

**Where it still bites (microvm/protocol only) — and it is silent.** A scenario testing a skill whose
behaviour involves recommending or discovering other skills diverges at those two tiers: the real agent
would call `suggest_skills`/`list_skills`; the harness agent does the work another way or declines, with
no signal that a tool was absent. Two consequences to keep in mind:
- **A "did-not-suggest" style assertion can pass vacuously** at `microvm`/`protocol` — the suggest tool is
  not present to fire there, so the harness is more permissive than production for discovery behaviour on
  those tiers. Do not read a green there as proof production stays quiet.
- **`tool_available: "mcp__skills__.*"` is a false negative on `microvm`/`protocol` only** — on
  `container`/`hostloop`/`cowork` it is a real, evaluable positive/negative now; the assertion's miss
  message is tier-aware (see the `tool_available` note in the assertion catalog).

---

## Hooks — the harness installs one of production's six

**Real Cowork behaviour (binary-verified, `app.asar` 1.24012.9):** the Cowork spawn's `hooks` object —
identified by the `env` block immediately following it (`CLAUDE_CODE_IS_COWORK:"1"`,
`CLAUDE_CODE_ENTRYPOINT:"local-agent"`, matching the pinned baseline's `spawn.env`) — installs **three
event types and six hooks**:

| Event | Matcher | What it does | Modeled here |
|---|---|---|---|
| `PreToolUse` | `Task` | blocks `run_in_background`; emits `subagent_invoked` | **yes** |
| `PreToolUse` | `Skill` | emits `skill_invoked`; injects per-skill `additionalContext` | no |
| `PreToolUse` | force-ask set | `permissionDecision:"ask"` in *every* permission mode | no |
| `PreToolUse` | `mcp__.*` | remote-MCP deny → `decision:"block"` | no |
| `PostToolUse` | `WebSearch` | seeds `webFetchAllowedUrls` — a WebSearch **widens** the web_fetch allowlist | no |
| `UserPromptSubmit` | *(none)* | expands a leading `/slash` into `additionalContext` | no |

**Harness behaviour:** `initialize` installs the `PreToolUse:Task` hook only
(`COWORK_PRETOOLUSE_HOOKS`). The *mechanism* accepts any event (`HookBundle` is keyed by event name),
but the served set is deliberately narrow — see `SERVED_HOOK_EVENTS` in `src/agent/session.ts`. The full
production bundle is recorded in `spawn.hooks` of each baseline as a drift tripwire, so a Desktop release
that adds or drops one surfaces as sync drift rather than as a consumer bug report.

### Why the others aren't modeled — none would change behaviour here today

Checked one by one, rather than assumed:

| Hook | Why not serving it costs nothing today |
|---|---|
| `PreToolUse` force-ask | gates `allow_cowork_file_delete` / `request_cowork_directory` / `launch_code_session` / `save_skill` — **none registered by this harness**, so the matcher never fires. Becomes worth serving if `save_skill` is modeled. |
| `PreToolUse:mcp__.*` | denies *remote* MCP tools; the harness serves none, so nothing to deny. |
| `UserPromptSubmit` | layers `additionalContext` **on top of** an expansion the agent binary performs on its own, so the body injection here is identical to production — only Desktop's extra context is missing. See the note below on slash commands in `prompt:`. |
| `PreToolUse:Skill` | the one genuine blocker: its `additionalContext` is sourced from Desktop's plugin/skill registry, which the harness does not have. Inventing that text would put words in the model's context production never sends — worse than sending none, because it silently changes what the skill under test reacts to. |
| `PostToolUse:WebSearch` | **already covered by a different path** — see below. |

**`PostToolUse:WebSearch` — the effect IS modeled.** In production this hook seeds the per-session
`webFetchAllowedUrls` set from search results, so a later `web_fetch` of a result URL is permitted. The
harness reaches the same end without the hook: `ProvenanceTracker.seedFromToolResult` runs on **every**
tool result (`src/run/run.ts`), so WebSearch output seeds the set too. The divergence is precision, not
presence — production uses a structured extractor over the result objects, the harness a regex over the
rendered text — and `src/hostloop/provenance.ts` documents that trade in its own header.

**`UserPromptSubmit` — where the slash expansion actually happens.** The agent binary dispatches slash
commands on stream-json input exactly as it does in the terminal, so a `prompt:` that begins with `/name` is
expanded here with no hook involved. Measured against agent 2.1.239 in the harness's own spawn shape (`-p
--input-format stream-json --output-format stream-json --setting-sources user`):

- **A leading `/name` resolves before any model call**, splicing the skill body in as a user message. An
  unresolved name returns `Unknown command: /x` with `num_turns: 0` and **zero tokens** — the prompt is
  *not* forwarded to the model as literal text, so the run reads as a silent no-op.
- **Both staging routes register the name.** `skills.local` copies to `<configDir>/skills/<basename>`
  (`src/session.ts`), which `--setting-sources user` loads; plugin sources become `--plugin-dir`
  (`src/runtime/argv.ts`). Skills resolve by their bare frontmatter `name`, not plugin-qualified.
- **The slash must be at position 0** — the input is trimmed, then must start with `/`. A slash named
  mid-sentence ("review the deck with /deck-review") is never expanded; it reaches the model as prose, which
  may then pick the `Skill` tool on its own. That is the model-invocation path, i.e. the auto-trigger a
  slash normally bypasses, so the scenario quietly stops testing what it reads as testing.
  `lint` reports it as ⚠ `WARN [prompt-slash-not-leading]`.

The gap is therefore the hook's `additionalContext`, not the expansion.

### What this actually costs you

- A scenario cannot **assert** on any event but `PreToolUse`; `hook_blocked`/`no_hook_blocked` are
  `PreToolUse`-scoped in effect. This is about gating, not about hooks running — a plugin's own hooks do
  run (next section).
- The `PreToolUse:Skill` context injection is absent, so a skill whose behaviour depends on it will act
  differently here than in production.

### Adding one later is cheap — verified, not assumed

Serving another event was expected to force a cassette re-record. It does not: with `PostToolUse` added to
the served set, all three committed cassettes replayed clean and `verify-cassettes` passed
(`RECORDING_SHAPING_FIELDS` covers authored scenario fields, not the `initialize` hook bundle). The only
failures were the served-set parity guards, which is precisely their job — regenerate
`assertion-keys.json` and update the linter's fallback and they pass. So the gate on serving a hook is
**fidelity of its reply**, not migration cost.

### A separate channel — plugin `hooks/hooks.json` — **fires here** (live-verified)

The table above is what **Desktop** installs. A plugin's *own* hooks reach the agent by a different
route — the `--plugin-dir` argv — and the agent binary loads and executes them itself. The harness
neither serves nor blocks that path.

**Live-verified 2026-08-01, both tiers.** A fixture plugin declaring `SessionStart`, `UserPromptSubmit`
and `PostToolUse` had **all three fire** at `container` *and* at `hostloop` (each hook appended a sentinel;
every one appeared). So a plugin's own hooks are not a gap — they work. This also matches production: a
2026-07-07 probe on real Desktop saw a plugin `SessionStart` hook fire in both execution modes, and the
asar carries a UI filter that *skips* `SessionStart` hook stream messages, which only makes sense if they
arrive.

**What is missing is harness-side, and it is narrower than "hooks don't work":**

- **No assertion key** for any event but `PreToolUse`, so a scenario cannot *gate* on a hook firing. Assert
  the hook's observable effect (a file it writes, a tool it blocks) instead.
- **The additional hooks production installs** for those events (the table above) are not reproduced.

> **Placement footgun — silent, and it will fool you.** The binary reads **`<plugin>/hooks/hooks.json`**.
> The identical file at the plugin **root** fires nothing, with no error, no warning, and no log line
> anywhere. This nearly produced a wrong conclusion in the very probe that established the above: the
> first run placed `hooks.json` at the root, observed zero sentinels, and looked exactly like "plugin
> hooks don't fire in the harness." Moving the file one directory down flipped every result.
> `lint-skill` now flags a misplaced file (`hooks-json-misplaced`), and so does a `run` at mount time.

(Unchanged either way: the host-side seeding footgun — a hook that `export`s an env var or writes `/tmp`
host-side is not visible to the in-VM agent. See [plugin-root.md](./plugin-root.md).)

---

## Auto-mode permission rubric is not modeled

**Real Cowork behaviour:** Desktop 1.28929.0 embeds a client-side permission rubric that classifies
Cowork tool calls into named risk categories. Several of its rules require that the *user* — not the
agent — be the one who named the action, covering things like granting folder access, granting
file-delete permission, saving a skill, and creating or deleting scheduled tasks. It also carries
explicit carve-outs: reading connected folders or uploads and writing derived content to the outputs
directory is not treated as data exfiltration. The rubric applies only to auto-mode, only for
non-chat sessions, and only outside host-loop. **Its feature gate is ON** (`force`), so the rubric is
live for the sessions that qualify.

**Harness behaviour:** not modeled. A scenario's scripted permission answers can express "the user
allowed this but the rubric refused it" only by scripting the refusal directly — there is no mechanism
that decides a denial on its own the way the rubric would.

**The residual, stated plainly.** It is tempting to read the rubric's `!isChatSession` term as the reason
this cannot reach the harness. It is not: production's test requires an *explicit* `sessionType === "chat"`,
and the session this harness models carries no `sessionType` at all — the baseline's
`CLAUDE_CODE_TAGS: "lam_session_type:chat"` is a `??` default, and the frame-artifacts predicate the
harness models requires `sessionType === undefined` — so that term does not exclude it.

Nor is it "the harness never constructs `settings.autoMode`". That much is true — the spawn passes
`--permission-mode` and `--setting-sources`, never an autoMode payload — but it is not sufficient on its
own: auto-mode's `AUTO_MODE_TRUSTED_SOURCES` is `["userSettings","flagSettings","policySettings"]`, so
**`userSettings` is a trusted source**, and the harness passes `--setting-sources user`. At
`protocol` under OAuth the agent also reads the operator's REAL `CLAUDE_CONFIG_DIR` (a fresh one breaks
local login, so that tier keeps it deliberately — `src/runtime/protocol.ts`). Every other tier, `hostloop`
included, gets the managed dir: `hostNativeSpawnEnv` sets `CLAUDE_CONFIG_DIR` to `plan.configDir`
(`src/runtime/argv.ts`), and pinning `plugins.config_dir` at an EXISTING directory is refused outright
unless `COWORK_HARNESS_ALLOW_CONFIG_DIR_WRITE=1` (`src/session.ts`) — precisely so the harness cannot
write into a real `~/.claude`. An operator's own settings are therefore a trusted source for auto-mode's
`allow` / `soft_deny` / `hard_deny` / `environment` rules wherever that dir IS the real one.

What actually closes it is the activation predicate. Binary-verified in agent **2.1.237**, auto-mode is
entered on the permission mode alone:

```js
if (e.permissionMode === "auto") r = fme(r)
```

Trusted sources therefore govern only *where the rules would be read from*, never *whether the mode is on*.
Two structural guards keep the harness out of it, both pinned by `test/auto-mode-unreachable.test.ts`:
the session schema's `permission_mode` enum has no `"auto"` member, so no scenario can request it; and the
argv builder's only sources for the flag are that session value and the baseline's sentinel-pinned
`spawn.permissionMode` (`"default"`). The rubric is *structurally unreachable*, not excluded by session
type — and the test fails the day either guard is relaxed, which is when this gap needs re-triage rather
than after.

So the residual is: in a real VM-loop, non-chat Cowork session the rubric is now a second, host-side
judgement layer over every tool call in auto-mode, and its observable effect is that the PreToolUse hook
can answer `deferred_to_classifier` — an empty result — **instead of** `permissionDecision: "ask"`. A tool
this harness models as always-gated may therefore raise no prompt in production. A scenario can already
*express* a denial by scripting one; it cannot *decide* one the way the rubric would, and it cannot
reproduce a gate that silently stops prompting.

---

## Skill argument collection — the elicitation form branch is not reachable here

**Real Cowork behaviour:** when a skill is invoked, Cowork appends guidance to the invocation telling the
model to collect any missing arguments through the `visualize` server's elicitation module —
`mcp__visualize__read_me` to load the form patterns, then `mcp__visualize__show_widget` to render a form
with pills, free text, dates and a file dropzone — and to reserve `AskUserQuestion` for one-off
clarifications mid-task. The user's answers then arrive as **bullet points in the next user message**,
not as a tool result. The guidance is live for standard accounts (`286376943`, on/force).

**It is guidance, not enforcement, and production splits roughly evenly.** Measured across a corpus of
real Cowork session transcripts that all received this guidance: about half of the turns that collected
arguments used the elicitation form, and about half used `AskUserQuestion` — with a few sessions using
both. Neither channel is dead, and which one a given turn takes is not deterministic.

**What the harness does:** it never registers the `visualize` tools. The spawned MCP surface is
`mcp__workspace__bash`, `mcp__workspace__web_fetch`, `mcp__cowork__present_files` and the
skills/plugins discovery servers — no `read_me`, no `show_widget`. The elicitation module therefore does
not exist inside a run, and the model falls back to `AskUserQuestion` every time.

**The residual, stated plainly:** a harness run deterministically pins the `AskUserQuestion` branch. That
is good for reproducibility — the same scenario collects arguments the same way every time, which is what
makes scripted answers and cassettes work at all — but it means **the elicitation form branch of your
skill is never exercised here.** If your skill renders a form in production, the harness is testing the
other path. Scripted answers (`answers:`, `--answer`) and the deciders keep working exactly as
documented; they are unaffected by this gap, because the competing channel is simply absent.

**The residual is wider than "a branch goes untested", and this is the part worth acting on.** Because
the host's elicitation guidance is absent, so is every CONFLICT between it and your skill's own
instructions — and a real session produced exactly that. A skill whose SKILL.md mandates
`AskUserQuestion` *"(NOT plain chat)"* found itself holding two contradictory authorities, the skill's
mandate and the host's injected guidance, and had to adjudicate; it chose the form and reported the
conflict. That whole class — **skill instruction vs host instruction** — is structurally unobservable
here, because only one of the two authorities is ever present. A skill can therefore ship a directive
that production silently overrides, and every harness run stays green.

So when the opt-in stub server lands, its value is not only "the form branch runs". A scenario that can
turn the guidance **on without rendering a form** would make instruction conflicts observable at all,
which is the larger half.

A related sharp edge, for anyone driving MCP elicitation from their own server: the harness models an
`elicit` request kind, but scenario answers do **not** cover it. `answers:` / `--answer` and
`--decider-llm` both abstain on an elicit request; `--on-unanswered first` auto-declines it and
`--on-unanswered fail` treats it as terminal. Only an external decider — `--decider-cmd` or
`--decider-dir` — can accept, decline or cancel one.

| Gate kind | `answers:` / `--answer` | `--decider-llm` | `--decider-cmd` / `--decider-dir` | `--on-unanswered first` |
|---|---|---|---|---|
| `AskUserQuestion` | yes | yes | yes | picks the first option |
| tool permission (`when_tool`) | yes | yes | yes | — |
| `elicit` | **abstains** | **abstains** | yes (accept / decline / cancel) | **auto-declines** |

**Status: open gap, intended to be closed.** The plan is to keep today's behaviour as the default (so no
scenario changes and no migration), add an opt-in that registers a stub `visualize` server to make the
form branch reachable *deterministically*, route form submissions through the existing answer machinery
rather than a second one, and extend scenario answers to cover `elicit` so the table above stops having a
hole. Deliberately mirroring production's coin-flip is **not** the goal: reproducibility is the point of
the harness, so the aim is to let a scenario choose which branch to exercise.

## Skill authoring — `save_skill` and `propose_skills` are not modeled

**Real Cowork behaviour:** a cowork session on a standard account declares
`mcp__cowork__save_skill` on the same `cowork` SDK-MCP server that carries `present_files` —
gated on `canSaveSkill` (`3246569822`, on/force for a standard account) combined with the
session's `skillsEnabled`. Three properties matter more than the tool's existence:

- **It uploads; it does not write files.** The tool `POST`s a zipped skill to
  `/api/organizations/{org}/skills/upload-skill`, so a saved skill lands in the user's
  account-level library and persists across sessions. The local-storage code path belongs to
  the third-party (`custom-3p`) deployment, which a first-party account does not reach. With
  `overwrite: true` Cowork resolves the existing user-created skill of that name and replaces
  its `SKILL.md`, keeping the skill's other files.
- **It is force-asked.** `save_skill` is one of four tools in Cowork's force-ask set (with
  `request_cowork_directory`, `allow_cowork_file_delete`, `launch_code_session`): a PreToolUse
  hook returns `ask` for it *in every permission mode*, including `bypassPermissions`.
- **It is ToolSearch-deferred, not `alwaysLoad`.** Unlike `present_files` (see *File delivery* below
  for the `present_files`/`SendUserFile` lane split), it does not occupy
  `system/init.tools`; it materialises only when the model looks for it.

The rendered `<available_skills>` block also carries a `canSaveSkill`-dependent sentence: with the
gate on, staged skill files are described as a read-only cache whose edits do not persist, and the
model is pointed at `save_skill`; with it off, the model is told it cannot create or modify skills in
that session. That sentence is emitted only when the skill catalog is non-empty.

`propose_skills` (`mcp__cowork__propose_skills`, gate `canProposeSkills` `1824824999`) is off for a
standard account. It is render-only — it shows the user an approval card and writes nothing — and the
prose that prefers it over `save_skill` is scoped to Cowork's screen-recording ("watch record") flow,
which has no harness analog.

Two further signals mark `save_skill` as a live, first-class surface rather than a dormant declaration.
Desktop's client-side permission rubric devotes a named rule to skill persistence — it treats a saved
skill as standing instruction text for every future session, and holds that an agent's unanswered *offer*
to save is not user consent (that rubric is dark and auto-mode-only; see *Auto-mode permission rubric is
not modeled*). And the tool's enablement is not a function of `canSaveSkill` alone: it composes with the
frame-artifacts session flag into a combined capability. Neither affects the harness's position — the
tool is declared at no tier — but both raise the cost of the gap. A skill whose flow ends in "save this
for next time" cannot be exercised here at all, and that ending sits behind more production machinery
than the tool declaration alone suggests.

**Harness behaviour:** neither tool is declared, at any tier. Both gates are pinned in the synced
baseline (`provenance.gates.canSaveSkill`, `provenance.gates.canProposeSkills`) as drift sentinels, so
a production flip surfaces as a `sync` diff — but the gates are recorded, not enacted.

### Why it isn't modeled

The faithful side effect is an authenticated upload to the operator's *real* skill library, performed
with the operator's own credentials. Reproducing it would publish test skills into the author's account
on every run, and `overwrite: true` resolves and replaces an existing skill by name — so a scenario
exercising the update path could destroy the very skill under test. A byte-faithful implementation is
therefore actively unsafe, and only a *simulated* one (production's result strings and forced ask, with
no network call) is worth building. That is a bounded piece of work, deferred until a skill needs it,
rather than an architectural limit.

### Where it bites — and it is silent

A skill whose own job is authoring or persisting skills. In real Cowork such a skill reaches for
`save_skill`; in the harness the tool is absent, so the agent writes `SKILL.md` to disk instead and the
scenario greens — while the same workflow in production is told, by the prompt sentence above, that disk
edits do not persist. Treat a green on a skill-authoring workflow as unproven.

For every other skill the gap is inert: a tool that is ToolSearch-deferred and never sought costs
nothing in context and changes no tool-selection outcome.

### Workarounds

- **Assert on the file-writing path.** A skill-authoring scenario can assert the `SKILL.md` it composes
  (`file_exists`, `artifact_contains`) and treat account-level persistence as out of scope — that split
  is honest, and it is the part of the workflow the harness can verify.
- **Keep skill persistence out of the scenario's claim.** State in the scenario name or `expect_denied`
  reasoning that persistence is unverified, so a later reader does not over-read the pass.

---

## File delivery — `present_files` here, `SendUserFile` on remote Cowork

Cowork has **two** file-delivery tools, one per product lane, and an agent only ever sees the one for the
surface it runs on:

- **Desktop-local sandbox** (the lane this harness emulates): the Desktop host serves
  `mcp__cowork__present_files` on the `cowork` SDK-MCP server — schema
  `{files: [{file_path: string}]}`, `alwaysLoad` — which promotes scratchpad files into `mnt/outputs`.
  The spawn's explicit `tools:` allowlist does **not** include `SendUserFile`, so the agent-native tool is
  absent from the local toolset even though the agent binary contains it and its own enablement gate
  (`tengu_send_user_file`) would otherwise pass on the `local-agent` entrypoint. The host allowlist is the
  load-bearing exclusion, not the binary's gate.
- **Remote (cloud-container) Cowork**: delivery goes through the agent-native `SendUserFile` —
  `{files: string[], caption?: string, status: "normal"|"proactive"` (**required**)`, display?:
  "render"|"attach"}` — which *uploads* files and returns a `file_uuid` that Desktop's remote-lane
  companion tools consume (device commit, remote `create_artifact`/`update_artifact`).

  **`SendUserFile` is not "remote Cowork's tool".** It is broadly native to Claude Code surfaces — its
  own enablement gate passes on the `local-agent` entrypoint too. What keeps it out of a Cowork-local
  session is the **host spawn allowlist**, which conditionally adds `SendUserMessage` and never
  `SendUserFile`. The accurate statement is: *`present_files` is Cowork-local-only; `SendUserFile` is
  broadly native but absent from Cowork-local.* Either name still strands a lane, which is why the
  guidance below names no tool at all. (Mechanism, per Anthropic's Cowork architecture overview: local
  MCP servers don't run in remote sessions — so an `mcp__`-namespaced tool cannot cross the boundary.)

The agent's own prompt states the rule: *"If the `SendUserFile` tool is in your toolset, you're on a remote
surface where they can't [open a file path] — send the screenshots and recordings with it."*

Verified against the pinned baseline: the asar's spawn `tools:`/`allowedTools` arrays and its live
`present_files` handler (1.24012.9), the agent ELF's `SendUserFileTool` schema and `isEnabled()` gate
(2.1.219), and a live-recorded 2.1.219 init toolset that carries `mcp__cowork__present_files` and no
`SendUserFile`.

**Harness behaviour (before the fix below):** served `present_files` with the local lane's exact name and
schema, on the `container` tier only. Not serving `SendUserFile` is fidelity to the emulated lane, not a
gap. **But serving `present_files` on `container` alone was a gap** — closed next.

### Closed: `hostloop` serves `present_files` (production runs host-loop)

Real Cowork registers `present_files` **unconditionally** and `alwaysLoad`, and its handler carries *two*
branches — a VM branch and an `isHostLoopMode` branch that validates real host paths against
`[hostOutputsDir, uploads, autoMemoryDir, ...connectedFolders]` and passes them through **without
promoting**. The `hostLoop` gate is `source: "force", value: true` in the pinned baseline, so
production's actual configuration is the split-execution shape this harness's `hostloop` tier claims to
mirror — and that shape advertises the tool.

The harness serves it at `container` **and `hostloop`**, the latter via a handler mirroring production's
own host-loop branch: validate the path and pass it through, with no promotion. `present_files_called`
works at both tiers. `no_scratchpad_leak` stays container-gated on the merits — production's host-loop
branch never promotes, so there is no scratch→outputs copy to leak there.

**Still unmodeled at `microvm` and `protocol`.** `protocol` has no `/sessions/` layout for the handler's
path model to work against; `microvm` stages into a different tree than the artifact scan walks. Both
report can't-verify rather than passing vacuously.

### Remote device bridge — `internal__remote-devices__*`, deliberately unmodeled

The remote lane also has an internal MCP server the harness does not model at all, wire-named
`internal__remote-devices__<tool>` (note the `internal__` prefix, not `mcp__`). Agent-facing tools include
`device_bash`, `device_list_dir`, `device_stage_files`, `device_commit_files`,
`device_request_folder_access`, `get_device_info`, and device-artifact tools; `device_commit_files` is the
remote lane's write-to-disk leg and consumes a `file_uuid` from a prior `SendUserFile`. Desktop advertises
these *outward* to a cloud session over a device-OAuth bridge; every handler logs
`session_type: "cowork-remote"`, and no `internal__*` name appears in the local spawn's tool list.

`device_bash`'s own description states the topology plainly: *"Run a shell command on the user's local
machine, inside the desktop Cowork workspace (an isolated Linux VM). This is NOT the cloud container — the
`Bash` tool runs there; device_bash runs on the user's device."* So a remote session reaches back into a
local VM (process namespace `rcw-<session>`, which the disk janitor's orphan cleanup deliberately skips).

**Deliberately unmodeled.** Emulating it faithfully would mean real command execution and real writes on
the operator's machine on behalf of a simulated remote session. The exact inventory is also
feature-gated, so it varies by account. Recorded here so a remote-lane probe diffed against this harness
is not misfiled as a harness bug — triage the lane first (`CLAUDE_CODE_ENTRYPOINT`).

### Where it bites — it looks like a harness bug

Probing a *remote* Cowork session ("print your file-delivery tool schema") reports `SendUserFile` with a
required `status`, which diffs against this harness as "wrong name AND wrong schema". It is neither: the
two lanes genuinely disagree, and a harness that adopted `SendUserFile` would green skills that then fail
on real desktop-local Cowork — inverting the failure class the harness exists to catch. When a probe and
this harness disagree about file delivery, establish which lane the probe ran on first:
`CLAUDE_CODE_ENTRYPOINT` is `local-agent` on the local lane and `remote_cowork` on the remote one.

### Workarounds

- **Write the deliverable to a stated path — but do not stop there on remote.** On the local lane the
  directory *is* the channel: Cowork's own system prompt tells the agent to save final deliverables into
  the workspace folder, and `present_files` layers on top of that. **On the remote lane location delivers
  nothing.** Verified by live probe in a `CLAUDE_CODE_ENTRYPOINT=remote_cowork` session: both
  `/mnt/user-data/outputs/` and a cwd-relative `outputs/` had to be created — **neither existed**, where a
  provisioned channel would (the local lane's `mnt/outputs` pre-exists as a mounted host directory) — and
  files written into them produced no card and an empty Outputs panel. An undelivered file dies with the
  container.
- **Follow Anthropic's own deployed pattern**, from the first-party `skill-creator` skill: write the file
  and state its path, then *check whether a file-presenting tool is available — `present_files`, or
  `SendUserFile` on remote surfaces — and if so send the deliverable with it; if neither is available,
  the stated path is the delivery.* Capability-conditional, not surface-enumerated: it stays correct as
  surfaces change, and it degrades to the path when no tool exists.
- **Most skills say nothing about delivery at all.** Across the first-party skills bundled with Cowork,
  the only one that names a delivery tool in its body is `skill-creator` — the one whose entire output is
  a file the user must install elsewhere. Reach for an explicit send when the artifact is the point and
  must leave the session; otherwise writing it where the user can see it is the whole job. (Counter-example
  worth knowing: the `cowork-plugin` skill bundled inside the agent binary names `SendUserFile`
  *unconditionally* — so the capability-conditional form above is the safer pattern, not a universal one.)
- **Never name `device_commit_files` in a skill.** It writes to the user's real disk, only inside folders
  they explicitly connected, and it is Desktop-advertised infrastructure the agent assembles when a user
  asks for files on disk — not a skill-authoring API. No first-party skill, prompt, or doc instructs a
  skill to call it.
- **Assert on delivery, not on the tool.** `present_files_called` (served at `container`/`hostloop`) and
  `no_scratchpad_leak` (`container`-only, on the merits — see above) keep working; they name the harness's
  assertion keys, not a production tool name.
