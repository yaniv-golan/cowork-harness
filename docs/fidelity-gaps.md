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

- **Startup `--folder <dir>`** — a live bind mount; agent writes propagate back to the host. Restart `chat` with this flag if you need the agent to edit your project files.
- **`docker cp` snapshot** — run `docker cp /local/dir/. <containerName>:/sessions/<id>/mnt/dir/` in a second terminal to inject a read-only snapshot mid-session, then tell the agent the path. Writes stay in the container.

---

## Folder access in `chat` sessions

**Real Cowork behaviour:** The "add folder" button is disabled for chat sessions. `mountFolderForSession` returns `{ok: false, error: "Folder access isn't available in chat sessions."}` at the IPC layer.

**Harness behaviour:** Same shape. Both `chat` and `skill` accept a *startup* `--folder <dir>` (a live bind mount; agent writes propagate back to the host — see Workarounds above). What neither supports — matching Cowork — is *mid-session* / hot-plug folder injection after the session has started.

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

## Fidelity tier differences

The harness `--fidelity` flag selects how closely the execution environment matches real Cowork. Each tier trades fidelity for speed.

| Tier | What runs | Gaps vs. real Cowork |
|---|---|---|
| `protocol` | No Docker; control protocol only | No sandbox, no filesystem isolation, no egress — fastest iteration |
| `container` | Docker container (default) | Egress sandbox applied; no Apple VZ microVM; mount namespace frozen at start |
| `microvm` | Lima + Apple VZ VM | Closest to real Cowork; slow boot (~20s); macOS arm64 only |
| `hostloop` | Docker + host-side agent loop | Matches Cowork's host-loop mode; agent file tools run on host |
| `cowork` | Auto-picks `hostloop` or `container` via the same gate as real Cowork | Highest fidelity for automated tests |

The `chat` command accepts `protocol`, `container`, and `hostloop`. `microvm` and `cowork` are omitted — `microvm` has a slow boot (~20s) that makes interactive use painful, and `cowork` requires porting the `decideLoopFromBaseline` gate logic from `execute.ts`.
