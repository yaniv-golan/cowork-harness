# The boundary model — reproducing Cowork's *limitations*

The point of this harness is not that a skill *can* do something — it's that a skill is **constrained the same way Cowork constrains it**. A test that's more permissive than Cowork produces **false passes**: a skill that works in the harness but breaks in production because it read a host folder that wasn't mounted, or tried to reach the network directly instead of through MCP.

This page describes the limitations the harness reproduces, how each tier enforces (or doesn't) them, and how to verify it.

> **Verify it in one command:** `cowork-harness boundary-check` proves the **L1 Docker** sandbox actually
> enforces these limits (sealed FS, default-deny egress) — no token, no model. It probes the `container`
> path; the `microvm` guest-iptables firewall is **not** exercised here. `hostloop`'s agent process is a
> native host spawn (see below) — the container sandbox this check proves out is the VM sidecar its
> `bash`/`web_fetch` route into, not a sandbox around the agent's own file tools. The rest of this page is
> the *why* and the per-tier detail.

## The three limitations that matter

| Limitation | In Cowork | Why a skill must respect it |
|---|---|---|
| **Sealed filesystem** | The agent runs in a microVM; it sees only mounted folders (`mnt/uploads`, work folders at `mnt/<folder-name>` — the collision-resolved basename, at `mnt/.projects/<name>` on Desktop older than 1.14271.0; plugins under `.local-plugins/…`, `mnt/outputs`). No `~/`, no `/Users`, no arbitrary host path. | A skill that hard-codes a host path works on your laptop and fails in Cowork. |
| **Default-deny egress** | `vm_network_mode: "gvisor"` with a compiled domain allowlist; off-list hosts are rejected. | A skill that calls an un-allowlisted API silently fails for real users. |
| **Cross-boundary only via MCP** | The VM shell is sealed; reaching host resources/services goes through MCP servers (which Cowork runs host-side). | A skill that shells out to a host tool instead of an MCP server won't have that tool in Cowork. |

## How each tier enforces the boundary

| | `protocol` (L0) | `container` (L1, default) | `microvm` (L2) |
|---|---|---|---|
| Sealed filesystem | ❌ none (runs on host) | ✅ only bind-mounts visible | ✅ only mounts visible |
| Default-deny egress | ❌ none | ✅ `internal` network + allowlist proxy | ✅ guest iptables default-deny + allowlist proxy |
| MCP-only crossing | ⚠️ not enforced | ✅ no host FS/procs; egress via proxy only | ✅ VM boundary |
| Escape resistance (untrusted code) | ❌ | ⚠️ container-grade | ✅ VM-grade |

**`protocol` runs on the host with no sandbox.** It's for fast logic iteration only. The CLI **refuses** to "pass" any scenario that asserts boundary behavior (`egress_denied`, `egress_allowed`, `expect_denied`) at this tier — that would be a false pass. Use it for "did the skill produce the right output / answer the question correctly," not "does the skill respect the boundary."

**`container` is the default and reproduces all three constraints:**

- *Filesystem*: a container only sees its own image plus explicit bind mounts. It physically cannot read `~/` or `/Users` — the same sealed view as the VM. The harness mounts **only** what the session setup declares.
- *Egress*: each run is placed on a **per-run** Docker network marked `internal: true` (no route off-box; see the lifecycle note below) and only the egress proxy is dual-homed onto an external network. So the agent can reach **only** allowlisted hosts, and **only** through the proxy. Direct/raw egress is impossible — not merely discouraged. (`docker/compose.yml` is a standalone reference for this shape; the live harness creates the networks per-run in `src/egress/sidecar.ts` — it does not invoke compose.)
- *Privileges*: `--cap-drop ALL`, `--security-opt no-new-privileges`, read-only rootfs + tmpfs. A skill can't escalate or persist outside the mounts. (Toggle with `COWORK_LOCKDOWN=off` for debugging; leave it on for parity.)

> **Egress-network lifecycle (operational).** On `container`/`hostloop`, each run creates a **per-run** pair
> of Docker networks (`cowork-int-<id>` / `cowork-out-<id>`) plus an egress-proxy container, and **reaps all
> three on every exit** — success, exception, agent crash, or unanswered gate — and on **Ctrl-C** (a
> `SIGINT`/`SIGTERM` handler reaps in-flight runs before exiting). The only path that can orphan them is a
> hard `SIGKILL`/`kill -9`; clean those with `docker network prune` (or `docker network rm cowork-int-*
> cowork-out-*`). There is **no hard concurrency ceiling**, but each concurrent run consumes one internal +
> one external network from Docker's address pool, so very high parallelism can hit `all predefined address
> pools have been fully subnetted` (the harness re-frames that error with this guidance) — widen the daemon
> `default-address-pools` if you need more. (`microvm` uses a host-port proxy + Lima VM, not Docker
> networks; run `cowork-harness vm prune` (see `vm --help`, or the microvm tier section in [scenario.md](./scenario.md)) for guest cleanup.)

**`microvm`** adds VM-grade escape resistance for untrusted code. Its egress is the **same default-deny allowlist proxy as `container`**, enforced by a guest iptables firewall — **no gVisor netstack**. Use it when you're testing isolation of code you don't trust.

**`hostloop`** reproduces Cowork's real host-loop architecture: the agent LOOP itself is a **native process spawned directly on the host** — Read/Write/Edit/Glob/Grep run with NO container around them, matching production exactly (Desktop stages this same native macOS binary alongside the Linux/arm64 ELF the other tiers use). Only `bash`/`web_fetch` route into a Docker "VM" sidecar via MCP (`bash` via `docker exec`; **`web_fetch` is host-routed**, `curl` on the host, by design — Cowork fetches via the host API (gate `coworkWebFetchViaApi`, binary-verified), not the container egress path). So a web_fetch `egress_*` entry reflects host reachability + the web-fetch allowlist/provenance, **not** the container egress boundary; only `bash` egress exercises the sandbox proxy.

Because the native file tools run with no OS sandbox, hostloop's filesystem boundary is a **software check**, not a container/VM wall: a PreToolUse hook (a byte-faithful port of production's own containment check) denies any Read/Write/Edit/Glob/Grep/MultiEdit whose resolved path falls outside the session's mounted roots (outputs, uploads, skills, connected folders, the staged plugin copy) — this is production's OWN security model for host-loop, not something weaker the harness substitutes. A run-end tripwire hard-fails if a gated tool call ever completes with no evidence the hook fired (version-skew insurance, not doubt about the currently-pinned binary). A `hostloop` scenario with a **writable** connected folder therefore gives the native process genuine host filesystem access and requires explicit consent (`allow_host_writes: true` in the scenario, or `--allow-host-writes` for `chat`) — the same consent a real user gives by clicking "connect folder" in Desktop, made visible in committed scenario YAML. Connected folders are bind-mounted (never copied) into both the native process's view and the VM sidecar's view — one set of bytes, matching production, which is what lets a hardcoded VM-absolute path in a skill fail here exactly as it fails in real Cowork.

**`cowork`** is not a sandbox of its own: it resolves at run time to either `hostloop` or `container` — the same choice real Cowork makes, read from the synced baseline's GrowthBook host-loop gate (`1143815894`). (An org policy `requireCoworkFullVmSandbox` forces the VM loop and *overrides* the gate.) The two resolved tiers do **not** share one boundary model: `container` seals the agent's file tools inside the container wall; `hostloop` runs them natively on the host under the software path-containment gate described above. A scenario authored with `fidelity: cowork` should not assume which one it lands on for filesystem-boundary assertions — pin `hostloop`/`container` explicitly if the distinction matters to the test.

## Verifying the boundary holds

The harness validates its **own** faithfulness — don't take our word for it:

```bash
cowork-harness boundary-check          # uses the latest platform baseline
```

To verify the sandbox still enforces boundaries **given a session's egress widening**, pass that session:

```bash
cowork-harness boundary-check --session ./sessions/with-github.yaml
```

`--session` loads the session YAML and folds its egress additions (`egress.extra_allow` / `egress.unrestricted`) into the allowlist the probes test against — so the `allowlist-permits` / `allowlist-enforced` checks reflect the same allowlist a scenario using that session would run under.

You can pin a specific baseline by passing it as a positional (`boundary-check <baseline>`; default is the latest platform baseline), and emit machine-readable results for CI with `--output-format json`.

This runs probes (independent of any agent) and asserts each constraint:

```
Boundary parity: ALL CONSTRAINTS ENFORCED
PASS  host-fs-sealed         — host paths (/Users, /host) invisible
PASS  direct-egress-denied   — no route to internet without proxy
PASS  allowlist-enforced     — off-list host refused by proxy
PASS  allowlist-permits      — allowlisted host reachable via proxy
```

Run it in CI before your scenario suite so a Docker/network misconfiguration that *weakens* the sandbox fails loudly instead of silently turning your tests into false passes.

## Writing limitation tests

Two complementary styles:

1. **Implicit** — just run your real scenario at `container` fidelity. If the skill tries to step outside the boundary, it fails the same way it would in Cowork, and your behavioral assertions catch the fallout.
2. **Explicit negative tests** — assert the boundary actively blocks something:

```yaml
# the skill should reach GitHub (allowlisted) but never example.com
session: ./sessions/with-github.yaml   # egress.extra_allow: ["api.github.com"]
expect_denied: ["example.com"]
assert:
  - egress_allowed: api.github.com
  - egress_denied: example.com
```

For "must use MCP, not a host tool," give the session an MCP server for the capability and **omit** the host tool; if the skill assumed the host tool, it fails — exactly as in Cowork.

## Known fidelity gaps

For the full catalog of what the harness deliberately does NOT reproduce vs real Cowork, see [fidelity-gaps.md](./fidelity-gaps.md). The gaps most relevant to the limitations model are:

- At `container` tier, stdio **MCP servers run alongside the agent**, whereas Cowork runs them host-side (split execution). This host/VM split is **not reproduced at any tier** — `microvm` runs MCP inside the guest too — so a skill that depends on it (e.g. an MCP server reaching host-only resources) is an unreproduced gap. See [discovery.md](./discovery.md).
- The `container` **and `microvm`** egress boundary is a proxy + firewall, not a kernel gVisor netstack. Domain allow/deny is identical; raw-packet behavior is not.
- The sandbox is a **fidelity fixture, not a security boundary** against malicious code — see [SECURITY.md](../SECURITY.md).
- **Read-only mounts ARE enforced; outputs delete-deny is still post-hoc.** `mode:r` mounts (uploads = asar `'ro'`; local/remote plugins) get a per-mount nested `:ro` bind on the Docker tiers, so a write to them fails in the guest — matching Cowork. **But** the `rw`/`rwd` distinction (write-but-no-delete on `mnt/outputs/` + connected folders) is NOT yet enforced at the mount: Cowork denies deletes there (`rm` fails `Operation not permitted`; a skill may request approval via `allow_cowork_file_delete` and then delete), whereas the harness mounts those writable, so `rm` **succeeds** and the violation is caught afterward by the `no_delete_in_outputs` assertion (the `scanEvents` scanner covers both native `Bash` and host-loop `mcp__workspace__bash`). A skill that relies on the live `EPERM` (catches it → requests approval, or overwrites-in-place) behaves differently. A faithful per-mount delete-deny (FUSE/overlay + the approval-unblock path) is the separate planned FUSE/overlay sub-project. The `no_delete_in_outputs` detector parses `mv` direction (a move *into* `outputs/` is no longer mistaken for a delete), and an operator who knows a prefix is genuine scratch can set `COWORK_HARNESS_SAFE_STAGING_PREFIX=/tmp/your-scratch` (comma-separated for several) to suppress deletes *provably* scoped under it. There is no default prefix — `/tmp` is not assumed safe (a skill may stage a deliverable there) — so default behavior is unchanged (flag every co-occurrence); unresolved/command-substituted delete targets always flag.
- **`hostloop`'s `uploads` mount is writable by the native file tools, where production's VM mounts it read-only for `bash`.** Production's own containment allowlist for its host-loop file tools includes the uploads directory (so a native `Write` there is genuinely allowed there too), but its VM additionally mounts `uploads` `:ro`, so a production `Write` from `bash` fails at the mount layer even though containment would allow it. This harness has no read-only enforcement layer for the NATIVE file tools (only the sidecar's Docker `:ro` bind enforces it for `bash`), so a native `Write` to `uploads` succeeds where production's `bash`-side `Write` would fail. Stricter-vs-looser, immaterial in practice (`uploads` is harness-owned staging content, not user data), but a real, documented divergence rather than a silently-absorbed one.
- **`hostloop`'s path-containment gate replicates a real hole in production's own resolver, by design.** A NEW file **two** levels deep under a symlinked parent (e.g. `allowed/esc/sub/new.txt` where `sub` doesn't exist) resolves the parent's realpath failure as ENOENT and falls back to the lexical path — allowed, even though a parent-creating `Write` would actually follow the symlink outside the root. Per this project's fidelity-first principle, the port replicates production's own behavior here rather than "fixing" it into something stricter than the real product.
- **Identity + gated env vars are absent; the two host-derived platform keys are emitted.** Real Cowork sets identity + gated keys (`CLAUDE_CODE_ACCOUNT_UUID`/`_USER_EMAIL`/`_ORGANIZATION_UUID`, `CLAUDE_CODE_SUBAGENT_MODEL`, `ENABLE_TOOL_SEARCH`); the synced baseline does not carry their *values* (the gates are opaque state strings, not a key→value map), so injecting them would be fabrication, not binary-verified fidelity. But the two *host-derived* keys **are** emitted: `CLAUDE_CODE_HOST_PLATFORM` (every assembling tier) and `CLAUDE_CODE_WORKSPACE_HOST_PATHS` (`hostloop`, when connected folders are present) — see [`fidelity-gaps.md`](./fidelity-gaps.md). Only matters for skills that read identity or those gates. Revisit if a future `sync` captures the gated values.
- **System prompt: base prose comes from the agent ELF's built-in default, not Cowork's host-rendered prompt.** The harness layers reconstructed cowork-specific sections via `--append-system-prompt`; Cowork by default does the channel-equivalent — `systemPrompt:{type:"preset",preset:"claude_code",append:<cowork sections>}` over `initialize`, i.e. it KEEPS the `claude_code` base preset and APPENDS (full-replacement only fires on a server-pushed `spVariant.mode==="replace"` — the exception, not the default; binary-verified, see the channel-divergence finding). So the *channel* matches; the residual gap is *content* (we reconstruct partial cowork sections vs Cowork's full `y8r` append, which also carries the host-rendered `<env>` block: date, timezone, selected-folder list, model, account). The fact *categories* are covered by the ELF's built-in default, but exact wording/values may differ. We do not reconstruct/bundle Cowork's base prose (Anthropic-owned; not cleanly extractable) and cannot *programmatically* drive real Cowork to diff it (Desktop IPC is locked). **Update (2026-06-18):** *manual* behavioral capture — asking the running Cowork agent to describe its own system prompt — IS available, and was used to add a reconstructed `<identity>` section to the append (Cowork self-identifies as "Claude … the Cowork assistant, not Claude Code"; the base `claude_code` preset alone would say "Claude Code"). The "IPC locked" caveat applies to automated diffing, not manual capture.
