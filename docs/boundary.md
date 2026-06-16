# The boundary model — reproducing Cowork's *limitations*

The point of this harness is not that a skill *can* do something — it's that a skill is **constrained the same way Cowork constrains it**. A test that's more permissive than Cowork produces **false passes**: a skill that works in the harness but breaks in production because it read a host folder that wasn't mounted, or tried to reach the network directly instead of through MCP.

This page describes the limitations the harness reproduces, how each tier enforces (or doesn't) them, and how to verify it.

## The three limitations that matter

| Limitation | In Cowork | Why a skill must respect it |
|---|---|---|
| **Sealed filesystem** | The agent runs in a microVM; it sees only mounted folders (`mnt/uploads`, `mnt/.projects/*`, plugin mounts, `mnt/outputs`). No `~/`, no `/Users`, no arbitrary host path. | A skill that hard-codes a host path works on your laptop and fails in Cowork. |
| **Default-deny egress** | `vm_network_mode: "gvisor"` with a compiled domain allowlist; off-list hosts are rejected. | A skill that calls an un-allowlisted API silently fails for real users. |
| **Cross-boundary only via MCP** | The VM shell is sealed; reaching host resources/services goes through MCP servers (which Cowork runs host-side). | A skill that shells out to a host tool instead of an MCP server won't have that tool in Cowork. |

## How each tier enforces the boundary

| | `protocol` (L0) | `container` (L1, default) | `microvm` (L2) |
|---|---|---|---|
| Sealed filesystem | ❌ none (runs on host) | ✅ only bind-mounts visible | ✅ only mounts visible |
| Default-deny egress | ❌ none | ✅ `internal` network + allowlist proxy | ✅ guest iptables default-deny + allowlist proxy |
| MCP-only crossing | ⚠️ not enforced | ✅ no host FS/procs; egress via proxy only | ✅ VM boundary |
| Escape resistance (untrusted code) | ❌ | ⚠️ container-grade | ✅ VM-grade |

**`protocol` runs on the host with no sandbox.** It's for fast logic iteration only. The CLI **refuses** to "pass" any scenario that asserts boundary behavior (`egress_denied`, `expect_denied`) at this tier — that would be a false pass. Use it for "did the skill produce the right output / answer the question correctly," not "does the skill respect the boundary."

**`container` is the default and reproduces all three constraints:**

- *Filesystem*: a container only sees its own image plus explicit bind mounts. It physically cannot read `~/` or `/Users` — the same sealed view as the VM. The harness mounts **only** what the session setup declares.
- *Egress*: `docker/compose.yml` puts agents on a network marked `internal: true` (no route off-box) and dual-homes only the egress proxy onto an external network. So the agent can reach **only** allowlisted hosts, and **only** through the proxy. Direct/raw egress is impossible — not merely discouraged.
- *Privileges*: `--cap-drop ALL`, `--security-opt no-new-privileges`, read-only rootfs + tmpfs. A skill can't escalate or persist outside the mounts. (Toggle with `COWORK_LOCKDOWN=off` for debugging; leave it on for parity.)

**`microvm`** adds VM-grade escape resistance for untrusted code. Its egress is the **same default-deny allowlist proxy as `container`**, enforced by a guest iptables firewall — **no gVisor netstack**. Use it when you're testing isolation of code you don't trust.

**`hostloop`** uses the **same container sandbox** as `container` (the `container` column above applies), but runs the agent loop host-side. `bash` is routed **into the container** (`docker exec`); **`web_fetch` is host-routed** (`curl` on the host), by design — Cowork fetches via the host API (gate `coworkWebFetchViaApi`, binary-verified), not the container egress path. So a web_fetch `egress_*` entry reflects host reachability + the web-fetch allowlist/provenance, **not** the container egress boundary; only `bash` egress exercises the sandbox proxy. (Container fidelity wires no host-routed web_fetch handler at all, so web_fetch provenance is intentionally absent there — it is a host-loop concept.) It reproduces Cowork's production split-execution, not a different isolation level. **`cowork`** is not a sandbox of its own: it resolves at run time to either `hostloop` or `container` — the same choice real Cowork makes, read from the synced baseline's GrowthBook host-loop gate (`1143815894` / `requireCoworkFullVmSandbox`). Because both of those use the identical container sandbox, **the boundary is the same either way** (the `container` column above); only the host-loop-vs-in-container *execution split* changes, not the isolation.

## Verifying the boundary holds

The harness validates its **own** faithfulness — don't take our word for it:

```bash
cowork-harness boundary-check          # uses the latest platform baseline
```

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

- At `container` tier, stdio **MCP servers run alongside the agent**, whereas Cowork runs them host-side (split execution). This host/VM split is **not reproduced at any tier** — `microvm` runs MCP inside the guest too — so a skill that depends on it (e.g. an MCP server reaching host-only resources) is an unreproduced gap. See [discovery.md](./discovery.md).
- The `container` **and `microvm`** egress boundary is a proxy + firewall, not a kernel gVisor netstack. Domain allow/deny is identical; raw-packet behavior is not.
- The sandbox is a **fidelity fixture, not a security boundary** against malicious code — see [SECURITY.md](../SECURITY.md).
- **Read-only mounts ARE enforced (#23); outputs delete-deny is still post-hoc (#9-A).** `mode:r` mounts (uploads = asar `'ro'`; local/remote plugins) get a per-mount nested `:ro` bind on the Docker tiers, so a write to them fails in the guest — matching Cowork. **But** the `rw`/`rwd` distinction (write-but-no-delete on `mnt/outputs/` + `.projects/`) is NOT yet enforced at the mount: Cowork denies deletes there (`rm` fails `Operation not permitted`; a skill may request approval via `allow_cowork_file_delete` and then delete), whereas the harness mounts those writable, so `rm` **succeeds** and the violation is caught afterward by the `no_delete_in_outputs` assertion (the `scanEvents` scanner covers both native `Bash` and host-loop `mcp__workspace__bash`). A skill that relies on the live `EPERM` (catches it → requests approval, or overwrites-in-place) behaves differently. A faithful per-mount delete-deny (FUSE/overlay + the approval-unblock path) is the separate planned sub-project (#9-A).
- **Host-derived / gate-conditional env vars are absent (#3).** Real Cowork sets identity + gated keys (`CLAUDE_CODE_ACCOUNT_UUID`/`_USER_EMAIL`/`_ORGANIZATION_UUID`, `CLAUDE_CODE_SUBAGENT_MODEL`, `ENABLE_TOOL_SEARCH`). The synced baseline does not carry their *values* (the gates are opaque state strings, not a key→value map), so injecting them would be fabrication, not binary-verified fidelity. Only matters for skills that read identity or those gates. Revisit if a future `sync` captures the values.
- **System prompt: base prose comes from the agent ELF's built-in default, not Cowork's host-rendered prompt (#1).** The harness layers reconstructed cowork-specific sections via `--append-system-prompt`; Cowork *replaces* the base prompt over `initialize` with a host-rendered version (its own `<env>` block: date, timezone, selected-folder list, model, account). The fact *categories* are covered by the ELF's built-in default, but exact wording/values may differ. We do not reconstruct/bundle Cowork's base prose (Anthropic-owned; not cleanly extractable) and cannot drive real Cowork to diff it (Desktop IPC is locked).
