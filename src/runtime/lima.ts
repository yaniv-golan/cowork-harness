import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { createHash } from "node:crypto";
import type { PlatformBaseline } from "../types.js";
import { resolveAgentBinary } from "../baseline.js";
import { envPositiveNumber, warn } from "../io.js";
import { forgetMicrovmCapabilities } from "./image-capabilities.js";

/** Host dir mounted writable into the VM at /sessions (the staging area; per-session subdirs). */
export const VM_WORK_HOST = join(homedir(), ".cowork-harness", "vm-work");

/** Guest mount point of `VM_WORK_HOST` — the literal in the lima template below. The microVM's guest
 *  session root is `${VM_GUEST_SESSIONS_ROOT}/<sessionId>` STRUCTURALLY: lima mounts the work root here
 *  and the per-session dirs live inside it, so this tier cannot honour a baseline that records the agent
 *  running anywhere else. Exported so the runtime anchors on the same string the template mounts, and so
 *  a test can check that pairing without booting a VM. */
export const VM_GUEST_SESSIONS_ROOT = "/sessions";

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
  return process.env.COWORK_HARNESS_LIMACTL ?? "/opt/homebrew/bin/limactl";
}

/**
 * The host path of the agent ELF this VM runs — resolved through the SAME `resolveAgentBinary` every
 * other executed-agent tier uses, so microvm gets its existence check, its sha verification against the
 * baseline pin, its pruned-binary fallback and its actionable error message.
 *
 * It previously read `agentBinary.stagedPath` raw. That handed a path Desktop had pruned straight into
 * the guest mount, where the exec failed with `env: 'claude': No such file or directory` and exit 127 —
 * the least informative message possible for a condition the other three tiers name precisely. Worse and
 * quieter: it also skipped `verifiedElf`, so the one tier that actually EXECUTES the ELF in a VM was the
 * only one not verifying it, while `container` hard-fails on the same mismatch. `baseline.ts` already
 * documented microvm as one of the strict executed-agent callers; only the wiring was missing.
 *
 * NOT `parityMount`: that tolerance exists for hostloop's non-executed bind mount. microvm runs this
 * binary, so it keeps the strict sha-hard-fail policy — same as container and chat-raw.
 *
 * `strict: false` is for the READ-ONLY callers (`vm status`, `vm prune`, `doctor`). Those must keep
 * working when the binary is missing — that is precisely when an operator runs them — so they degrade to
 * the raw pinned path rather than throwing. The instance name stays consistent with the config `vmInit`
 * builds in every case where a VM can actually be created, because both go through this one function.
 */
function stagedHostOf(baseline: PlatformBaseline, opts: { strict?: boolean } = {}): string {
  const raw = (baseline.agentBinary?.stagedPath ?? "").replace(/^~(?=$|\/)/, homedir());
  if (opts.strict) return resolveAgentBinary(baseline);
  try {
    return resolveAgentBinary(baseline);
  } catch {
    return raw; // read-only callers: a name is still derivable, and `vmInit` is where this fails loudly
  }
}

/**
 * The Lima instance name is DERIVED from a hash of the full `limaConfig()` (mounts, image,
 * provision, staged-binary version). Because the name encodes the config, a config change yields a
 * NEW instance name → `vmStatus()` is `Absent` → a fresh `create` with the current config, while the
 * old VM is simply orphaned. This makes stale-config reuse impossible BY CONSTRUCTION (no drift
 * stamp, no silent reuse of a VM built from older code) and auto-migrates every config change (e.g.
 * the `/sessions` mount, an agent-version bump). `COWORK_HARNESS_LIMA_INSTANCE` overrides for a pinned name.
 * Orphaned old VMs accumulate until `cowork-harness vm prune` (or `limactl delete`).
 */
export function instanceName(baseline: PlatformBaseline): string {
  if (process.env.COWORK_HARNESS_LIMA_INSTANCE) return process.env.COWORK_HARNESS_LIMA_INSTANCE;
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
 * NOT live-derive it (brittle). `COWORK_HARNESS_VM_GATEWAY` is the override, mirroring the
 * existing `COWORK_HARNESS_VM_PROXY_PORT` env pattern. The SAME value MUST feed both the iptables
 * allow rule (applyGuestFirewall) and the proxy URL (microvm.ts), so callers thread the
 * result of this one helper into both.
 */
export function vmGatewayIp(): string {
  const raw = process.env.COWORK_HARNESS_VM_GATEWAY ?? "192.168.5.2";
  // #95: this value is interpolated into a root-run iptables command inside the guest
  // (guestFirewallScript → `iptables -A OUTPUT -d ${gatewayIp}` executed via `sh -c`). Validate it as a
  // canonical IPv4 literal and reject everything else, so a malformed or hostile override can never inject
  // shell syntax into privileged provisioning. Defense-in-depth: the var is operator-set, but an
  // unvalidated string reaching a root `sh -c` should be impossible by construction, not by trust. IPv4
  // only — the Apple VZ user-network gateway is IPv4, and the digits-and-dots grammar excludes every shell
  // metacharacter (`;`, `$`, backtick, whitespace, …).
  const octets = raw.split(".");
  const canonicalIPv4 = octets.length === 4 && octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255 && String(Number(o)) === o);
  if (!canonicalIPv4)
    throw new Error(`COWORK_HARNESS_VM_GATEWAY must be a canonical IPv4 literal (e.g. 192.168.5.2); got ${JSON.stringify(raw)}`);
  return raw;
}

export function vmStatus(instance: string): string {
  const r = spawnSync(limaPath(), ["list", instance, "--format", "{{.Status}}"], { encoding: "utf8" });
  return (r.stdout ?? "").trim() || "Absent";
}

/**
 * How far a Running guest's provisioning got. `ready` = Lima's boot scripts (which run our provision blocks
 * on every boot) have finished AND the agent is on PATH. `failed` = they finished without the agent, so
 * waiting cannot help. `sealed` = the agent is missing and the guest firewall is already in place — a
 * previous run firewalled a VM that was still provisioning, so apt can never complete (once apt gives up,
 * the boot scripts end too, so boot-done alone does not tell sealed from failed). `pending` = still
 * running, or the guest cannot be asked yet.
 */
export type VmProvisioning = "ready" | "pending" | "sealed" | "failed";

/**
 * The guest-side readiness check, one `limactl shell` round trip. Lima's boot script deletes its
 * `lima-boot-done` marker at the start of every boot and rewrites it (non-empty: the instance id) after
 * the last provision script has run, whether or not those scripts succeeded — so the marker, not the
 * `Running` status, is what says provisioning ended. `/run` and `/var/run` are both checked, as Lima's
 * own requirement check does. Every check goes through `sudo -n` so a guest that would prompt reads as
 * "not done" instead of hanging. The script always exits 0 and prints exactly one state line; anything
 * else is read as `pending` by `provisioningFromProbe`.
 */
export function provisioningProbeScript(): string {
  return [
    "done=0; sudo -n test -s /run/lima-boot-done || sudo -n test -s /var/run/lima-boot-done && done=1",
    "if [ $done = 1 ] && sudo -n test -x /usr/local/bin/claude; then echo COWORK_PROVISIONING=ready",
    "elif sudo -n iptables -S OUTPUT 2>/dev/null | grep -qx -- '-P OUTPUT DROP'; then echo COWORK_PROVISIONING=sealed",
    "elif [ $done = 1 ]; then echo COWORK_PROVISIONING=failed",
    "else echo COWORK_PROVISIONING=pending",
    "fi",
    "exit 0",
  ].join("\n");
}

/** Map one readiness-probe spawn to a state. Only a clean exit carrying a recognised state line counts; a
 *  non-zero exit (ssh not up yet), a spawn error, a timeout (`status: null`) or unrecognised output all
 *  read as `pending` — never as `ready`. */
export function provisioningFromProbe(r: { status: number | null; stdout?: unknown; error?: Error }): VmProvisioning {
  if (r.error || r.status !== 0 || typeof r.stdout !== "string") return "pending";
  const m = /^COWORK_PROVISIONING=(ready|pending|sealed|failed)$/m.exec(r.stdout);
  return m ? (m[1] as VmProvisioning) : "pending";
}

/** Ask a Running guest how far its provisioning got. Bounded, so a wedged ssh cannot hang the caller. */
export function vmProvisioned(instance: string): VmProvisioning {
  const r = spawnSync(limaPath(), ["shell", "--workdir", "/", instance, "sh", "-c", provisioningProbeScript()], {
    encoding: "utf8",
    timeout: 60_000,
  });
  return provisioningFromProbe(r);
}

/** The poll loop's clock. An object (not bare functions) so a test can make the wait instant. */
export const provisionClock = {
  now: (): number => Date.now(),
  sleep: (ms: number): void => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  },
};

const PROVISION_POLL_MS = 5_000;
/** How long `limactl start` may take before Lima gives up on it. A first boot installs the toolchain and
 *  routinely runs past Lima's default; stopping short left a Running VM mid-provisioning. */
const LIMA_START_TIMEOUT = "20m";

function provisioningError(instance: string, reason: string): Error {
  return new Error(
    `microvm ${instance} never finished provisioning (${reason}). Delete it and retry: cowork-harness vm delete [<baseline>]`,
  );
}

/** Why a not-ready state is final. `afterRestart`: a sealed VM was already restarted once to recover it. */
function reasonFor(state: Exclude<VmProvisioning, "ready">, afterRestart: boolean): string {
  switch (state) {
    case "failed":
      return "provisioning ended without the agent on PATH at /usr/local/bin/claude";
    case "sealed":
      return afterRestart
        ? "its egress firewall was applied before provisioning finished, and a restart did not recover it"
        : "its egress firewall is in place but the agent is not on PATH";
    case "pending":
      return "provisioning had not finished when the restart returned";
  }
}

/** Wait for a reused Running guest to finish provisioning: poll every 5 s up to
 *  COWORK_HARNESS_VM_PROVISION_TIMEOUT_S (default 900). Returns the first non-pending state, or throws on timeout. */
function awaitProvisioning(instance: string): Exclude<VmProvisioning, "pending"> {
  const timeoutS = envPositiveNumber("COWORK_HARNESS_VM_PROVISION_TIMEOUT_S", 900);
  const deadline = provisionClock.now() + timeoutS * 1000;
  let noticed = false;
  for (;;) {
    const state = vmProvisioned(instance);
    if (state !== "pending") return state;
    const remaining = deadline - provisionClock.now();
    if (remaining <= 0)
      throw provisioningError(
        instance,
        `still provisioning after ${timeoutS}s — raise COWORK_HARNESS_VM_PROVISION_TIMEOUT_S if it is just slow`,
      );
    if (!noticed) {
      warn(`::notice:: [microvm] ${instance} is Running but still provisioning — waiting up to ${timeoutS}s\n`);
      noticed = true;
    }
    provisionClock.sleep(Math.min(PROVISION_POLL_MS, remaining));
  }
}

/** A reused Running VM is handed back only once it is provisioned. A `sealed` one is restarted once: the
 *  firewall's iptables rules do not survive a reboot and Lima re-runs the provision scripts on every boot,
 *  so a restart lets provisioning finish. Never deletes — that is the user's call, and the error says how. */
function reuseRunning(instance: string, status: string): { instance: string; status: string } {
  let state: VmProvisioning = awaitProvisioning(instance);
  const restarted = state === "sealed";
  if (restarted) {
    warn(`::notice:: [microvm] ${instance} was firewalled before provisioning finished — restarting it once\n`);
    try {
      run(["stop", "-f", instance]);
      run(["start", instance, "--tty=false", "--timeout", LIMA_START_TIMEOUT]);
    } catch (e) {
      throw provisioningError(instance, `it was firewalled before provisioning finished, and the restart failed: ${(e as Error).message}`);
    }
    state = vmProvisioned(instance);
  }
  if (state !== "ready") throw provisioningError(instance, reasonFor(state, restarted));
  return { instance, status };
}

/** Boot (or reuse) the VZ microVM. The instance name encodes the config (see instanceName), so a
 *  `Running`/`Stopped` instance of THIS name is guaranteed to match the current config — there is no
 *  stale-config reuse to guard against. Returns when it is Running AND provisioned: `Running` alone only
 *  means the guest booted, and a first boot cut off by `limactl start`'s timeout is Running with
 *  provisioning unfinished. The caller applies the guest firewall right after this returns, so returning
 *  a half-provisioned VM would seal it in that state (apt could never finish). */
export function vmInit(baseline: PlatformBaseline): { instance: string; status: string } {
  // Resolve BEFORE the reuse short-circuit below. A VM created while the pinned binary was present keeps
  // a mount pointing at that host path, so a later Desktop prune leaves a Running instance whose mount
  // resolves to nothing — the guest exec then dies with `env: 'claude': No such file or directory` and
  // exit 127. Validating only on the create path would miss precisely the reported case, since the
  // instance was already Running. Every spawn re-checks, so the failure is loud and named either way.
  const stagedHost = stagedHostOf(baseline, { strict: true }); // fails LOUD here, with the resolver's message
  const instance = instanceName(baseline);
  const status = vmStatus(instance);
  if (status === "Running") return reuseRunning(instance, status);

  mkdirSync(VM_WORK_HOST, { recursive: true });
  const cfg = limaConfig(stagedHost);
  const tmp = mkdtempSync(join(tmpdir(), "cowork-lima-"));
  const cfgPath = join(tmp, "cowork-vm.yaml");
  writeFileSync(cfgPath, cfg);

  if (status === "Absent") {
    run(["create", "--name", instance, cfgPath, "--tty=false"]);
  }
  run(["start", instance, "--tty=false", "--timeout", LIMA_START_TIMEOUT]);
  // `limactl start` waits for Lima's own boot-done requirement, so one probe is enough here: not ready
  // now means the start itself went wrong, and polling would only delay saying so.
  const state = vmProvisioned(instance);
  // Still provisioning is not a broken VM: a Running VM is waited for, so the next run picks it up.
  if (state === "pending")
    throw new Error(
      `microvm ${instance} has not finished provisioning (limactl start returned first) — re-run; the next run waits for provisioning to finish (COWORK_HARNESS_VM_PROVISION_TIMEOUT_S)`,
    );
  if (state !== "ready") throw provisioningError(instance, reasonFor(state, false));
  return { instance, status: vmStatus(instance) };
}

export function vmDelete(instance: string): void {
  spawnSync(limaPath(), ["stop", "-f", instance], { stdio: "ignore" });
  spawnSync(limaPath(), ["delete", "-f", instance], { stdio: "ignore" });
  forgetMicrovmCapabilities([instance]);
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
    mountPoint: "${VM_GUEST_SESSIONS_ROOT}"
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
