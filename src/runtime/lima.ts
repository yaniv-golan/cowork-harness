import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { createHash } from "node:crypto";
import type { PlatformBaseline } from "../types.js";

/** Host dir mounted writable into the VM at /sessions (the staging area; per-session subdirs). */
export const VM_WORK_HOST = join(homedir(), ".cowork-harness", "vm-work");

/**
 * L2 microVM provisioning via Lima with `vmType: vz` — Apple Virtualization.framework,
 * the SAME hypervisor Claude Cowork uses. This gives a real Linux kernel (VM-grade
 * isolation) instead of a shared-kernel container, for testing untrusted skills.
 *
 * `vm init` boots a long-lived VM that:
 *   - mounts the staged agent binary (read-only) and a work root (writable),
 *   - installs a guest default-deny egress firewall (allow DNS + the host proxy only),
 * so the agent inside the VM is constrained like Cowork's gVisor allowlist.
 *
 * The VM is reused across scenarios (boot is slow); per-run state lives under mounts.
 */
export function limaPath(): string {
  return process.env.COWORK_LIMACTL ?? "/opt/homebrew/bin/limactl";
}

function stagedHostOf(baseline: PlatformBaseline): string {
  return (baseline.agentBinary?.stagedPath ?? "").replace(/^~(?=$|\/)/, homedir());
}

/**
 * #62/#63: the Lima instance name is DERIVED from a hash of the full `limaConfig()` (mounts, image,
 * provision, staged-binary version). Because the name encodes the config, a config change yields a
 * NEW instance name → `vmStatus()` is `Absent` → a fresh `create` with the current config, while the
 * old VM is simply orphaned. This makes stale-config reuse impossible BY CONSTRUCTION (no drift
 * stamp, no silent reuse of a VM built from older code) and auto-migrates every config change (e.g.
 * the `/sessions` mount, an agent-version bump). `COWORK_LIMA_INSTANCE` overrides for a pinned name.
 * Orphaned old VMs accumulate until `cowork-harness vm prune` (or `limactl delete`).
 */
export function instanceName(baseline: PlatformBaseline): string {
  if (process.env.COWORK_LIMA_INSTANCE) return process.env.COWORK_LIMA_INSTANCE;
  const hash = createHash("sha256")
    .update(limaConfig(stagedHostOf(baseline)))
    .digest("hex")
    .slice(0, 8);
  return `cowork-vm-${hash}`;
}

/**
 * The Lima `vmType: vz` user-network gateway — where the host allowlist proxy listens
 * from inside the VM. `192.168.5.2` is the documented default for Apple VZ user
 * networking, but it is NOT robustly derivable from a stable `limactl` field, so we do
 * NOT live-derive it (brittle). `COWORK_VM_GATEWAY` is the override, mirroring the
 * existing `COWORK_VM_PROXY_PORT` env pattern. The SAME value MUST feed both the iptables
 * allow rule (applyGuestFirewall) and the proxy URL (microvm.ts), so callers thread the
 * result of this one helper into both. (#39)
 */
export function vmGatewayIp(): string {
  return process.env.COWORK_VM_GATEWAY ?? "192.168.5.2";
}

export function vmStatus(instance: string): string {
  const r = spawnSync(limaPath(), ["list", instance, "--format", "{{.Status}}"], { encoding: "utf8" });
  return (r.stdout ?? "").trim() || "Absent";
}

/** Boot (or reuse) the VZ microVM. The instance name encodes the config (see instanceName), so a
 *  `Running`/`Stopped` instance of THIS name is guaranteed to match the current config — there is no
 *  stale-config reuse to guard against. Returns when it is Running. */
export function vmInit(baseline: PlatformBaseline): { instance: string; status: string } {
  const instance = instanceName(baseline);
  const status = vmStatus(instance);
  if (status === "Running") return { instance, status };

  const stagedHost = stagedHostOf(baseline);
  mkdirSync(VM_WORK_HOST, { recursive: true });
  const cfg = limaConfig(stagedHost);
  const tmp = mkdtempSync(join(tmpdir(), "cowork-lima-"));
  const cfgPath = join(tmp, "cowork-vm.yaml");
  writeFileSync(cfgPath, cfg);

  if (status === "Absent") {
    run(["create", "--name", instance, cfgPath, "--tty=false"]);
  }
  run(["start", instance, "--tty=false"]);
  return { instance, status: vmStatus(instance) };
}

export function vmDelete(instance: string): void {
  spawnSync(limaPath(), ["stop", "-f", instance], { stdio: "ignore" });
  spawnSync(limaPath(), ["delete", "-f", instance], { stdio: "ignore" });
}

/** Delete every `cowork-vm-*` instance except `keep` (the current config's instance) — orphaned VMs
 *  left behind by past config/agent-version changes. Returns the names pruned. */
export function vmPrune(keep: string): string[] {
  const r = spawnSync(limaPath(), ["list", "--format", "{{.Name}}"], { encoding: "utf8" });
  const stale = (r.stdout ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter((n) => n.startsWith("cowork-vm-") && n !== keep);
  for (const n of stale) vmDelete(n);
  return stale;
}

/**
 * Lima config: Apple VZ, arm64, the staged agent mounted read-only at a stable path,
 * a writable work root, and a provisioning script that installs the agent on PATH and
 * a default-deny egress firewall (allow loopback + DNS + the host proxy gateway only).
 */
export function limaConfig(stagedHost: string): string {
  // Lima mounts must be DIRECTORIES — mount the binary's parent dir, symlink in-guest.
  const stagedDir = dirname(stagedHost);
  // #38: symlink from the ACTUAL staged basename, not a hard-coded "claude". The mount
  // exposes /opt/cowork/agent/<basename(stagedHost)>; a staged binary named e.g.
  // claude-linux-arm64 would otherwise yield a dangling symlink (the `|| true` below
  // hides the failure until exec time). Link TARGET stays /usr/local/bin/claude (the
  // harness execs `claude`).
  const agentBasename = basename(stagedHost);
  // NB: the L2 Lima guest is Ubuntu 24.04 (the available arm64 cloud image) — this is intentionally
  // NOT the same as the L1 `container` base image that the synced baseline records (baselines/*.json,
  // Cowork's `ubuntu:22.04`). Different layers, different images; don't "align" them.
  return `# Generated by cowork-harness — Apple VZ microVM (same hypervisor as Cowork).
vmType: "vz"
arch: "aarch64"
images:
  - location: "https://cloud-images.ubuntu.com/releases/24.04/release/ubuntu-24.04-server-cloudimg-arm64.img"
    arch: "aarch64"
cpus: 2
memory: "2GiB"
disk: "20GiB"
mounts:
  - location: "${stagedDir}"
    mountPoint: "/opt/cowork/agent"
    writable: false
  # #63: the work root is mounted directly at /sessions (NOT /cowork-work + a per-run symlink), so the
  # agent's cwd is a REAL /sessions/<id> dir — getcwd() = /sessions/<id> (SPEC §9 inv. #1), the
  # encoded-cwd matches the container tier, and CLAUDE_CONFIG_DIR is a writable host-mounted path so
  # the agent persists its session (enabling --resume). Lima creates the mountpoint, writable by the
  # mounting user — no guest /sessions permission problem.
  - location: "${VM_WORK_HOST}"
    mountPoint: "/sessions"
    writable: true
provision:
  - mode: system
    script: |
      #!/bin/sh
      set -e
      # Put the staged agent on PATH (mounted read-only from the host).
      ln -sf /opt/cowork/agent/${agentBasename} /usr/local/bin/claude || true
      apt-get update -y && apt-get install -y --no-install-recommends iptables curl ca-certificates ripgrep git || true
networks: []
`;
}

/**
 * Build the guest default-deny egress iptables script. Pure (no spawn) so the generated
 * rule — including the gateway IP (#39) — is unit-testable token-free. `gatewayIp` is the
 * SAME value the caller uses for the proxy URL (threaded from vmGatewayIp()), so the
 * iptables allow rule and HTTP(S)_PROXY provably point at one address.
 */
export function guestFirewallScript(proxyGatewayPort: number, gatewayIp: string): string {
  return [
    "set -e",
    "sudo iptables -F OUTPUT || true",
    "sudo iptables -P OUTPUT DROP || true",
    "sudo iptables -A OUTPUT -o lo -j ACCEPT",
    "sudo iptables -A OUTPUT -d 127.0.0.0/8 -j ACCEPT",
    // DNS + the host gateway (where the allowlist proxy listens) only.
    "sudo iptables -A OUTPUT -p udp --dport 53 -j ACCEPT",
    "sudo iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT",
    `sudo iptables -A OUTPUT -d ${gatewayIp} -p tcp --dport ${proxyGatewayPort} -j ACCEPT`,
    "sudo iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT",
  ].join("; ");
}

/**
 * Apply a guest default-deny egress firewall, allowing only the host proxy + DNS.
 * `gatewayIp` defaults to vmGatewayIp() but is passed explicitly by callers so the
 * firewall rule and the proxy URL share one resolved value (#39).
 */
export function applyGuestFirewall(instance: string, proxyGatewayPort: number, gatewayIp: string = vmGatewayIp()): void {
  run(["shell", instance, "sh", "-c", guestFirewallScript(proxyGatewayPort, gatewayIp)]);
}

function run(args: string[]): void {
  const r = spawnSync(limaPath(), args, { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`limactl ${args[0]} failed (exit ${r.status})`);
}
