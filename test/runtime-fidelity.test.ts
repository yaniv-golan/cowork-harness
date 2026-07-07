import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { vmGatewayIp, guestFirewallScript, limaConfig, instanceName } from "../src/runtime/lima.js";
import { firewallFailureAction, microvmShellScript, MICROVM_SECRET_SENTINEL } from "../src/runtime/microvm.js";
import { dockerRunArgv } from "../src/runtime/argv.js";
import type { PlatformBaseline } from "../src/types.js";

/**
 * Token-free unit tests for the runtime fidelity/isolation fixes. These exercise PURE
 * helpers extracted from the runtimes — the full L2 (Lima microVM) and host-loop (Docker)
 * paths need Lima/Docker to run end-to-end and are covered on the `test:live` /
 * `pytest -m cowork` lane, NOT here.
 *
 * What is Docker/Lima-gated (NOT asserted here):
 *  - that applyGuestFirewall() actually installs iptables in a booted VM;
 *  - that the spawn env on a live microVM uses the resolved gateway IP (wiring is
 *    asserted indirectly via guestFirewallScript + the proxyUrl construction sharing
 *    vmGatewayIp(), but the live HTTP(S)_PROXY value needs a VM);
 *  - that the symlink in the provisioned guest resolves (we assert the GENERATED
 *    `ln -sf` line, not its effect inside a booted VM);
 *  - that host-loop's CLAUDE_PLUGIN_ROOT is unresolvable in-guest (we assert the
 *    sentinel string only; the bash self-heal trigger needs a Docker container).
 */

describe("Lima gateway IP is overridable and threaded into the firewall rule", () => {
  const saved = process.env.COWORK_VM_GATEWAY;
  afterEach(() => {
    if (saved === undefined) delete process.env.COWORK_VM_GATEWAY;
    else process.env.COWORK_VM_GATEWAY = saved;
  });

  it("defaults to the Apple VZ user-network gateway 192.168.5.2", () => {
    delete process.env.COWORK_VM_GATEWAY;
    expect(vmGatewayIp()).toBe("192.168.5.2");
  });

  it("honors the COWORK_VM_GATEWAY override", () => {
    process.env.COWORK_VM_GATEWAY = "10.0.2.2";
    expect(vmGatewayIp()).toBe("10.0.2.2");
  });

  it("emits the resolved gateway IP into the iptables allow rule", () => {
    process.env.COWORK_VM_GATEWAY = "10.0.2.2";
    const script = guestFirewallScript(8899, vmGatewayIp());
    // The allow rule must point at the SAME gateway the proxy URL uses (drift kill).
    expect(script).toContain("-d 10.0.2.2 -p tcp --dport 8899 -j ACCEPT");
    expect(script).not.toContain("192.168.5.2");
  });

  it("default gateway still produces the 192.168.5.2 rule", () => {
    delete process.env.COWORK_VM_GATEWAY;
    const script = guestFirewallScript(8899, vmGatewayIp());
    expect(script).toContain("-d 192.168.5.2 -p tcp --dport 8899 -j ACCEPT");
  });
});

describe("firewall failure fails loud under lockdown, opt-out skips", () => {
  it("throws when lockdown is on (the default)", () => {
    expect(firewallFailureAction(true)).toBe("throw");
  });

  it("skips when lockdown is off (the explicit COWORK_LOCKDOWN=off opt-out)", () => {
    expect(firewallFailureAction(false)).toBe("skip");
  });
});

describe("Lima provision symlink uses the actual staged basename", () => {
  it("links the staged claude-linux-arm64 binary to /usr/local/bin/claude", () => {
    const cfg = limaConfig("/Users/me/.cowork/agent/claude-linux-arm64");
    expect(cfg).toContain("ln -sf /opt/cowork/agent/claude-linux-arm64 /usr/local/bin/claude");
  });

  it("links a plain `claude` staged binary correctly (target unchanged)", () => {
    const cfg = limaConfig("/Users/me/.cowork/agent/claude");
    expect(cfg).toContain("ln -sf /opt/cowork/agent/claude /usr/local/bin/claude");
  });
});

describe("work root is mounted at /sessions (no /cowork-work + symlink)", () => {
  it("limaConfig mounts VM_WORK_HOST at /sessions, not /cowork-work", () => {
    const cfg = limaConfig("/Users/me/.cowork/agent/claude");
    expect(cfg).toContain('mountPoint: "/sessions"');
    expect(cfg).not.toContain('mountPoint: "/cowork-work"');
  });

  it("the in-guest script just cds into the real /sessions mount and execs — no symlink/mkdir, fails loud", () => {
    const script = microvmShellScript("/sessions/sess-abc");
    expect(script).toMatch(/^set -e; cd '\/sessions\/sess-abc'/);
    expect(script).toContain('exec "$@"');
    expect(script).not.toContain("ln -sfn");
    expect(script).not.toContain("mkdir");
    // a missing mount fails loud (exit 1 + actionable message), not a silent exec with the wrong cwd
    expect(script).toContain("exit 1");
    expect(script).toContain("not provisioned for this harness config");
  });

  it("the script reads the secret prologue from stdin (up to the sentinel) before exec, so the token is never in argv", () => {
    const script = microvmShellScript("/sessions/sess-abc");
    expect(script).toContain("read -r"); // consume the prologue line-by-line
    expect(script).toContain(MICROVM_SECRET_SENTINEL); // stop at the sentinel
    expect(script).toContain("export "); // export each KEY=value
    // the read loop precedes the exec (secrets are in the env before claude starts)
    expect(script.indexOf("read -r")).toBeLessThan(script.indexOf('exec "$@"'));
  });
});

describe("Lima instance name is derived from the config hash", () => {
  const saved = process.env.COWORK_LIMA_INSTANCE;
  afterEach(() => {
    if (saved === undefined) delete process.env.COWORK_LIMA_INSTANCE;
    else process.env.COWORK_LIMA_INSTANCE = saved;
  });
  const mk = (stagedPath: string): PlatformBaseline => ({ agentBinary: { stagedPath } }) as unknown as PlatformBaseline;

  it("is cowork-vm-<hash8>, stable for one config and DIFFERENT when the config changes", () => {
    delete process.env.COWORK_LIMA_INSTANCE;
    const a = instanceName(mk("/Users/me/.cowork/agent/2.1.170/claude"));
    const a2 = instanceName(mk("/Users/me/.cowork/agent/2.1.170/claude"));
    const b = instanceName(mk("/Users/me/.cowork/agent/2.1.171/claude")); // agent version bump → new config
    expect(a).toMatch(/^cowork-vm-[0-9a-f]{8}$/);
    expect(a2).toBe(a); // deterministic for the same config
    expect(b).not.toBe(a); // a config change yields a NEW instance → stale VM can't be silently reused
  });

  it("honors the COWORK_LIMA_INSTANCE override (pinned name)", () => {
    process.env.COWORK_LIMA_INSTANCE = "my-vm";
    expect(instanceName(mk("/Users/me/.cowork/agent/claude"))).toBe("my-vm");
  });
});

describe("host-loop sidecar leaves CLAUDE_PLUGIN_ROOT UNSET (matches real host-loop: VM bash sees no value)", () => {
  // Real host-loop leaves CLAUDE_PLUGIN_ROOT unset in the VM (live probe: in-guest bash saw an empty
  // value); the agent's `[ -z "$CLAUDE_PLUGIN_ROOT" ]` self-heal then fires via `find …/mnt`, exactly as
  // an unresolvable sentinel used to trigger it — but WITHOUT a bogus /host path leaking into the guest.
  // spawnHostLoop spawns Docker (not token-free), so we assert at the argv seam it renders through.
  const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const base = { network: "none", lockdown: true, sessionRoot: "/s", sessionHost: "/h", image: "img" } as const;

  it("dockerRunArgv omits CLAUDE_PLUGIN_ROOT when the env doesn't set it (the post-fix host-loop sidecar env)", () => {
    const argv = dockerRunArgv({ ...base, env: {} });
    expect(argv.join(" ")).not.toContain("CLAUDE_PLUGIN_ROOT");
  });

  it("dockerRunArgv DOES render the key when present — so OMISSION (not a sentinel) is what leaves it unset", () => {
    const argv = dockerRunArgv({ ...base, env: { CLAUDE_PLUGIN_ROOT: "/x" } });
    expect(argv.join(" ")).toContain("CLAUDE_PLUGIN_ROOT=/x");
  });

  it("the old unresolvable sentinel is gone from the host-loop sidecar", () => {
    // Regression guard: re-introducing a `/host/plugins/unmounted` sentinel would leak a bogus path into
    // guest bash again (the very drift from real host-loop this removed).
    expect(readFileSync(join(SRC, "runtime", "hostloop.ts"), "utf8")).not.toContain("/host/plugins/unmounted");
  });
});
