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
 * The Lima instance name is DERIVED from a hash of the full `limaConfig()` (mounts, image,
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
 * result of this one helper into both.
 */
export function vmGatewayIp(): string {
  const raw = process.env.COWORK_VM_GATEWAY ?? "192.168.5.2";
  // #95: this value is interpolated into a root-run iptables command inside the guest
  // (guestFirewallScript → `iptables -A OUTPUT -d ${gatewayIp}` executed via `sh -c`). Validate it as a
  // canonical IPv4 literal and reject everything else, so a malformed or hostile override can never inject
  // shell syntax into privileged provisioning. Defense-in-depth: the var is operator-set, but an
  // unvalidated string reaching a root `sh -c` should be impossible by construction, not by trust. IPv4
  // only — the Apple VZ user-network gateway is IPv4, and the digits-and-dots grammar excludes every shell
  // metacharacter (`;`, `$`, backtick, whitespace, …).
  const octets = raw.split(".");
  const canonicalIPv4 = octets.length === 4 && octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255 && String(Number(o)) === o);
  if (!canonicalIPv4) throw new Error(`COWORK_VM_GATEWAY must be a canonical IPv4 literal (e.g. 192.168.5.2); got ${JSON.stringify(raw)}`);
  return raw;
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
  // Symlink from the ACTUAL staged basename, not a hard-coded "claude". The mount
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
      # BLOCK 1 — REQUIRED tools + the agent symlink. Fail loudly; MUST be self-contained and must NOT depend
      # on the (best-effort) toolchain block below — a toolchain install failure can never strand the agent
      # (a regression boot-verification caught: a failed pip pin had aborted set -e BEFORE this symlink).
      apt-get update -y && apt-get install -y --no-install-recommends iptables curl ca-certificates ripgrep git gnupg
      # Put the staged agent on PATH (mounted read-only from the host) and verify it resolves to an
      # executable — a masked symlink failure would leave 'claude' missing while vm init still succeeded.
      ln -sf /opt/cowork/agent/${agentBasename} /usr/local/bin/claude
      test -x /usr/local/bin/claude
  - mode: system
    script: |
      #!/bin/sh
      # BLOCK 2 — document/data toolchain parity with the container Layer-A. BEST-EFFORT:
      # a separate provision block (Block 1 already secured the agent), and intentionally NOT set -e — a
      # single drifted pin must not strand the rest. NB the L2 guest is Ubuntu 24.04 / python 3.12 (NOT the
      # container's 22.04 / 3.10 — intentional), so versions DRIFT from the 22.04 set; that's accepted drift,
      # and the capability probe reports whatever didn't land. Order: apt then node then env then npm then pip
      # (pip last and tolerant). --ignore-installed avoids the "cannot uninstall pkg installed by debian"
      # PEP-668 clash; jsonschema is dropped (apt ships 4.x on 24.04 and pip can't downgrade it — drift).
      apt-get install -y --no-install-recommends python3 python3-pip jq poppler-utils ghostscript graphviz \\
        pandoc libmagic1 ruby ffmpeg qpdf libcairo2 libpango-1.0-0 libgl1 libglib2.0-0 fonts-dejavu-core fonts-liberation || true
      curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs || true
      printf 'IS_SANDBOX=yes\\nPYTHONUNBUFFERED=1\\nVM_IMAGE_BUILD=2\\nNODE_PATH=/usr/local/lib/node_modules_global/lib/node_modules\\nNPM_CONFIG_PREFIX=/usr/local/lib/node_modules_global\\n' >> /etc/environment
      NPM_CONFIG_PREFIX=/usr/local/lib/node_modules_global npm install -g docx@9.7.1 marked@18.0.5 pdf-lib@1.17.1 pptxgenjs@4.0.1 sharp@0.34.5 tsx@4.22.4 typescript@6.0.3 || true
      python3 -m pip install --break-system-packages --ignore-installed --no-cache-dir \\
        numpy==2.2.6 pandas==2.3.3 openpyxl==3.1.5 et_xmlfile==2.0.0 xlsxwriter==3.2.9 \\
        python-docx==1.2.0 python-pptx==1.0.2 odfpy==1.4.1 pdfplumber==0.11.9 pypdf==6.13.1 \\
        pdfminer.six==20251230 pikepdf==10.8.0 matplotlib==3.10.9 pillow==12.2.0 reportlab==4.5.1 \\
        lxml==6.1.1 beautifulsoup4==4.15.0 tabulate==0.10.0 requests==2.34.2 python-magic==0.4.24 || true
networks: []
`;
}

/**
 * Build the guest default-deny egress iptables script. Pure (no spawn) so the generated
 * rule — including the gateway IP — is unit-testable token-free. `gatewayIp` is the
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
    // Allow DNS (to ANY resolver — see caveat) plus the host gateway where the allowlist proxy listens.
    // CAVEAT (fidelity-gated): outbound 53 is unscoped, so DNS-tunneling is technically possible.
    // This is a TEST FIXTURE, not a security boundary, and the north star is Cowork parity — tightening
    // DNS to a fixed resolver would DIVERGE from Cowork unless Cowork itself scopes it (verify against the
    // binary/live lane before changing). Left at parity deliberately; the earlier "…only" comment overstated it.
    "sudo iptables -A OUTPUT -p udp --dport 53 -j ACCEPT",
    "sudo iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT",
    `sudo iptables -A OUTPUT -d ${gatewayIp} -p tcp --dport ${proxyGatewayPort} -j ACCEPT`,
    "sudo iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT",
  ].join("; ");
}

/**
 * Apply a guest default-deny egress firewall, allowing only the host proxy + DNS.
 * `gatewayIp` defaults to vmGatewayIp() but is passed explicitly by callers so the
 * firewall rule and the proxy URL share one resolved value.
 */
export function applyGuestFirewall(instance: string, proxyGatewayPort: number, gatewayIp: string = vmGatewayIp()): void {
  run(["shell", instance, "sh", "-c", guestFirewallScript(proxyGatewayPort, gatewayIp)]);
}

function run(args: string[]): void {
  const r = spawnSync(limaPath(), args, { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`limactl ${args[0]} failed (exit ${r.status})`);
}
