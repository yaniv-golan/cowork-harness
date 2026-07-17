import { spawnSync } from "node:child_process";
import { existsSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../cli-args.js";
import { resolveAgentBinary, resolveHostAgentBinary, classifyNativeStagingDrift, loadBaseline, sha256File } from "../baseline.js";
import { limaPath, vmStatus, instanceName } from "../runtime/lima.js";
import { fail, isJsonOutput, jsonPayloadEnvelope } from "./envelope.js";

// Synchronous fd writes (match cli.ts): machine→stdout, human→stderr. A `process.stdout.write` +
// `process.exit()` pair truncates on a PIPE (async tail dropped at exit past the ~64KB buffer); writeSync
// blocks until drained.
const out = (s: string) => writeSync(1, s + "\n");
const log = (s: string) => writeSync(2, s + "\n");

type Tier = "protocol" | "container" | "microvm" | "hostloop" | "cowork";
const LIVE_TIERS: Tier[] = ["container", "microvm", "hostloop", "cowork"];
const isLive = (t: Tier) => LIVE_TIERS.includes(t);

type Status = "ok" | "fail" | "warn" | "skip";
export interface DoctorCheck {
  id: string;
  title: string;
  status: Status;
  detail: string;
  remedy?: string;
  required: boolean; // does this check gate the exit code for the selected tier?
}

/** Injectable probe so the checks are unit-testable without a real Docker/agent/host. The default
 *  implementation uses the real runtime; tests pass a fake. */
export interface DoctorProbe {
  nodeMajor(): number;
  platform(): string;
  arch(): string;
  runtimeName(): string;
  runtimeAvailable(): boolean;
  runtimeDaemonUp(): boolean;
  limaAvailable(): boolean; // microvm (L2) only — `limactl` present (Lima / Apple Virtualization.framework)
  vmInstanceStatus(): string; // microvm (L2) only — `limactl list <instance> --format {{.Status}}` for the current baseline's derived Lima instance; surfaces whether `vm init` has provisioned it yet ("Running"/"Stopped"/"Absent")
  imageName(): string;
  imagePresent(): boolean;
  proxyImageName(): string;
  proxyImagePresent(): boolean;
  agentBinary(): { ok: true; path: string } | { ok: false; error: string };
  // Native macOS agent binary that `hostloop`/`cowork` spawn directly (distinct from the Linux ELF
  // `agentBinary()` resolves — see resolveHostAgentBinary in baseline.ts). Not meaningful for other tiers.
  // `note` is set when the resolved path came from a PATCH-tolerated staging-drift substitution (see
  // `classifyNativeStagingDrift`) — surfaced so the substitution is visible, not silent.
  hostAgentBinary(): { ok: true; path: string; note?: string } | { ok: false; error: string };
  hasToken(): boolean;
  // macOS only: is there a Claude Code OAuth credential in the login Keychain? Used purely to improve the
  // "no token" remedy — the in-Docker agent can't read the Keychain, so doctor points the user at .env.
  hasKeychainToken(): boolean;
  // When cwd is a git WORKTREE with no local ./.env but the main checkout has one, returns that .env path —
  // the gitignored .env doesn't travel to a worktree, a common "no token" first-run trap. null otherwise.
  worktreeEnv(): string | null;
  baseline(): { ok: true; version: string } | { ok: false; error: string };
  // Advisory only (never blocks doctor) — is `python3` on PATH? `lint` requires it. Optional so existing
  // test doubles don't need updating: when a probe doesn't implement it, doctor falls back to a real
  // PATH check (mirrors realProbe's implementation below).
  hasPython3?(): boolean;
}

/** Package-root `docker build` line for the agent image — resolved relative to THIS file (works from a
 *  global install, not just a source checkout). Replaces a `build-image` command. */
export function agentBuildLine(runtime: string, image: string): string {
  const dockerfile = fileURLToPath(new URL("../../docker/Dockerfile.agent", import.meta.url));
  const pkgRoot = dirname(dirname(dockerfile)); // .../docker -> package root (the build context)
  return `${runtime} build --platform linux/arm64 -t ${image} -f ${dockerfile} ${pkgRoot}`;
}

export const realProbe: DoctorProbe = {
  nodeMajor: () => Number(process.versions.node.split(".")[0]),
  platform: () => process.platform,
  arch: () => process.arch,
  runtimeName: () => process.env.COWORK_CONTAINER_RUNTIME ?? "docker",
  runtimeAvailable() {
    const r = spawnSync(this.runtimeName(), ["--version"], { stdio: "ignore", timeout: 5000 });
    return !r.error && r.status === 0;
  },
  runtimeDaemonUp() {
    const r = spawnSync(this.runtimeName(), ["info"], { stdio: "ignore", timeout: 5000 });
    return !r.error && r.status === 0;
  },
  limaAvailable() {
    const r = spawnSync(limaPath(), ["--version"], { stdio: "ignore", timeout: 5000 });
    return !r.error && r.status === 0;
  },
  vmInstanceStatus() {
    try {
      return vmStatus(instanceName(loadBaseline("latest")));
    } catch (e) {
      return `unknown (${(e as Error).message.split("\n")[0]})`;
    }
  },
  imageName: () => process.env.COWORK_AGENT_IMAGE ?? "cowork-agent-base:2",
  imagePresent() {
    const r = spawnSync(this.runtimeName(), ["image", "inspect", this.imageName()], { stdio: "ignore", timeout: 5000 });
    return !r.error && r.status === 0;
  },
  proxyImageName: () => process.env.COWORK_PROXY_IMAGE ?? "cowork-egress-proxy:2",
  proxyImagePresent() {
    const r = spawnSync(this.runtimeName(), ["image", "inspect", this.proxyImageName()], { stdio: "ignore", timeout: 5000 });
    return !r.error && r.status === 0;
  },
  agentBinary() {
    try {
      return { ok: true, path: resolveAgentBinary(loadBaseline("latest")) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
  hostAgentBinary() {
    try {
      const baseline = loadBaseline("latest");
      const path = resolveHostAgentBinary(baseline);
      // Same classifier the resolver used internally — so doctor's note can never disagree with what
      // resolveHostAgentBinary actually did.
      const drift = classifyNativeStagingDrift(baseline);
      const note = drift.kind === "patch" ? `patch-tolerated: pinned ${drift.pinned}, using ${drift.found}` : undefined;
      return { ok: true, path, note };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
  hasToken: () => !!(process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
  // Read-only presence probe (macOS only). `-w` is deliberately OMITTED so the secret is never printed/
  // captured — we only care about the exit status (0 = a "Claude Code-credentials" entry exists). A locked
  // keychain returns non-zero → treated as "absent" (best-effort hint; harmless false-negative).
  hasKeychainToken: () => {
    if (process.platform !== "darwin") return false;
    const r = spawnSync("security", ["find-generic-password", "-s", "Claude Code-credentials"], { stdio: "ignore" });
    return r.status === 0;
  },
  worktreeEnv: () => {
    if (existsSync(join(process.cwd(), ".env"))) return null; // a local .env exists → not the worktree trap
    const gitDir = spawnSync("git", ["rev-parse", "--git-dir"], { encoding: "utf8" });
    const commonDir = spawnSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8" });
    if (gitDir.status !== 0 || commonDir.status !== 0) return null; // not a git repo
    const gd = resolve(gitDir.stdout.trim());
    const cd = resolve(commonDir.stdout.trim());
    if (gd === cd) return null; // not a worktree (git-dir === common-dir in the main checkout)
    const mainEnv = join(dirname(cd), ".env"); // common-dir is <main>/.git → its parent is the main checkout
    return existsSync(mainEnv) ? mainEnv : null;
  },
  baseline() {
    try {
      return { ok: true, version: loadBaseline("latest").appVersion };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
  hasPython3() {
    const r = spawnSync("python3", ["--version"], { stdio: "ignore", timeout: 5000 });
    return !r.error && r.status === 0;
  },
};

/** Pure check list for the selected tier. Live-only prereqs (`runtime`/`image`/`agent`) are reported as
 *  `skip` (not required) on `protocol`. `os` is informational (warn) except `microvm`, which hard-requires
 *  macOS arm64 (Apple's hypervisor). */
export function runDoctorChecks(tier: Tier, probe: DoctorProbe = realProbe): DoctorCheck[] {
  const live = isLive(tier);
  const checks: DoctorCheck[] = [];

  const node = probe.nodeMajor();
  checks.push({
    id: "node",
    title: "Node ≥ 20",
    status: node >= 20 ? "ok" : "fail",
    detail: `node ${process.versions.node}`,
    remedy: node >= 20 ? undefined : "install Node 20+ (https://nodejs.org)",
    required: true,
  });

  const plat = probe.platform();
  const arch = probe.arch();
  const macArm = plat === "darwin" && arch === "arm64";
  checks.push({
    id: "os",
    title: "OS / arch",
    status: macArm ? "ok" : tier === "microvm" ? "fail" : "warn",
    detail: `${plat}/${arch}`,
    remedy: macArm
      ? undefined
      : tier === "microvm"
        ? "microvm needs macOS Apple Silicon (Apple Virtualization.framework); use `container` instead"
        : plat === "win32"
          ? "Windows is not a supported host for the live tiers — use macOS Apple Silicon, or the token-free `replay`"
          : "best on macOS arm64; other hosts may need emulation, and `sync`/`microvm` are macOS-arm64 only",
    required: tier === "microvm",
  });

  // The staged agent ELF is bind-mounted into the sandbox at every live tier (container guest AND the
  // Lima microVM guest), so this check is shared by both live paths.
  const agentCheck = (): DoctorCheck => {
    const agent = probe.agentBinary();
    // Surface the ELF's sha256 provenance so setup is self-explaining (a hard mismatch already fails the
    // resolve above and lands in agent.error). Best-effort re-hash — doctor is a read-only truth check.
    let shaNote = "";
    if (agent.ok) {
      try {
        const ab = loadBaseline("latest").agentBinary;
        if (ab?.sha256) {
          const match = sha256File(agent.path) === ab.sha256;
          shaNote = `  [sha256 ${match ? "✓" : "✗"} vs baseline, ${ab.shaProvenance ?? "unknown"}]`;
        }
      } catch {
        /* provenance is a hint; never let it fail the check */
      }
    }
    return {
      id: "agent",
      title: "Staged agent binary (VM/container ELF)",
      status: agent.ok ? "ok" : "fail",
      detail: agent.ok ? agent.path + shaNote : agent.error.split("\n")[0],
      remedy: agent.ok
        ? undefined
        : "open Claude Cowork once to stage the agent, or set COWORK_AGENT_BINARY=<path> (put it in your .env so --dotenv covers it, like the token)",
      required: true,
    };
  };

  const runtime = probe.runtimeName();
  if (!live) {
    checks.push({ id: "runtime", title: "Container runtime", status: "skip", detail: `not needed for ${tier}`, required: false });
    checks.push({ id: "image", title: "Agent image", status: "skip", detail: `not needed for ${tier}`, required: false });
    checks.push({
      id: "agent",
      title: "Staged agent binary (VM/container ELF)",
      status: "skip",
      detail: `not needed for ${tier}`,
      required: false,
    });
  } else if (tier === "microvm") {
    // L2 runs on Lima + Apple Virtualization.framework — NOT Docker. Check `limactl`, not the container
    // runtime / agent image / egress-proxy image (the microVM uses its own rootfs and a host-side proxy).
    const limaOk = probe.limaAvailable();
    checks.push({
      id: "lima",
      title: "Lima (limactl)",
      status: limaOk ? "ok" : "fail",
      detail: limaOk ? `${limaPath()} found` : `limactl not found (${limaPath()})`,
      remedy: limaOk ? undefined : "install Lima (`brew install lima`) or set COWORK_LIMACTL=<path>",
      required: true,
    });
    const vmStatusStr = limaOk ? probe.vmInstanceStatus() : "Absent";
    const vmProvisioned = vmStatusStr === "Running" || vmStatusStr === "Stopped";
    checks.push({
      id: "vm-instance",
      title: "Lima VM instance (vm init)",
      status: !limaOk ? "skip" : vmProvisioned ? "ok" : "warn",
      detail: !limaOk
        ? "not checked — limactl missing"
        : vmProvisioned
          ? `instance ${vmStatusStr.toLowerCase()} — provisioned`
          : `no provisioned instance yet (status: ${vmStatusStr})`,
      remedy:
        vmProvisioned || !limaOk
          ? undefined
          : "run `cowork-harness vm init` once to pre-provision (a live microvm run self-provisions too, just with first-run VM-boot latency)",
      required: false,
    });
    checks.push(agentCheck());
  } else {
    const avail = probe.runtimeAvailable();
    const up = avail && probe.runtimeDaemonUp();
    checks.push({
      id: "runtime",
      title: "Container runtime",
      status: up ? "ok" : "fail",
      detail: avail ? (up ? `${runtime} daemon reachable` : `${runtime} found but daemon not reachable`) : `${runtime} not found`,
      remedy: up
        ? undefined
        : avail
          ? `start ${runtime} (the daemon isn't responding to \`${runtime} info\`)`
          : `install ${runtime} (or set COWORK_CONTAINER_RUNTIME)`,
      required: true,
    });

    const image = probe.imageName();
    const present = up && probe.imagePresent();
    checks.push({
      id: "image",
      title: "Agent image",
      status: present ? "ok" : up ? "fail" : "skip",
      detail: present
        ? `${image} present — lean core; OCR / PDF-table skills need the full-parity image (--build-arg COWORK_FULL_PARITY=1)`
        : up
          ? `${image} missing`
          : `(skipped — ${runtime} not reachable)`,
      remedy: present || !up ? undefined : `build it: ${agentBuildLine(runtime, image)}`,
      required: up, // only gate on the image once the runtime is actually reachable
    });

    checks.push(agentCheck());

    if (tier === "hostloop" || tier === "cowork") {
      const hostAgent = probe.hostAgentBinary();
      // A patch-tolerated staging-drift substitution stays `ok` (it's safe — the native binary has no
      // sha256 pin), but the note names the pinned-vs-found versions so the substitution is visible.
      const note = hostAgent.ok && hostAgent.note ? `  [${hostAgent.note}]` : "";
      checks.push({
        id: "hostAgent",
        title: "Staged native agent binary (hostloop)",
        status: hostAgent.ok ? "ok" : "fail",
        detail: hostAgent.ok ? hostAgent.path + note : hostAgent.error.split("\n")[0],
        remedy: hostAgent.ok
          ? undefined
          : "open Claude Cowork once to stage the native macOS binary, or set COWORK_HOST_AGENT_BINARY=<path>",
        required: true,
      });
    }

    // Egress proxy image — informational, never blocking: the egress sidecar builds it on the fly
    // (ensureProxyImage) when absent, so report status but don't gate the verdict on it.
    const proxy = probe.proxyImageName();
    const proxyPresent = up && probe.proxyImagePresent();
    checks.push({
      id: "proxy",
      title: "Egress proxy image",
      status: proxyPresent ? "ok" : "skip",
      detail: !up
        ? `(skipped — ${runtime} not reachable)`
        : proxyPresent
          ? `${proxy} present`
          : `${proxy} absent — built automatically on first run`,
      required: false,
    });
  }

  const token = probe.hasToken();
  // First-run trap: a Claude Code login writes the OAuth token to the macOS Keychain, but the
  // in-Docker agent can't read the Keychain — only env / .env. If the env is empty BUT a Keychain credential
  // exists, the generic "set a token" remedy is a dead end; point the user straight at the .env copy instead.
  const keychainOnly = !token && plat === "darwin" && probe.hasKeychainToken();
  // Worktree trap: a git worktree's gitignored ./.env is absent there, so a token in the main checkout's
  // .env doesn't apply. Point at it via --dotenv. (Keychain takes precedence — it's the "you have a token,
  // just unreadable in-Docker" case.)
  const worktreeEnv = !token && !keychainOnly ? probe.worktreeEnv() : null;
  checks.push({
    id: "token",
    title: "Auth token",
    status: token ? "ok" : "fail",
    detail: token
      ? "found (env / .env)"
      : keychainOnly
        ? "found a 'Claude Code-credentials' Keychain entry, but the in-Docker agent can't read the Keychain"
        : worktreeEnv
          ? "no token in this git worktree (its ./.env is gitignored, so it's absent here)"
          : "no CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN",
    remedy: token
      ? undefined
      : keychainOnly
        ? "copy your Keychain token into ./.env so the in-Docker agent can read it: echo CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token) >> .env — or, if the token is already in another file, point at it: cowork-harness --dotenv <path> <cmd> (the global --dotenv is honored by doctor too)"
        : worktreeEnv
          ? `the main checkout has a .env — point at it: cowork-harness --dotenv ${worktreeEnv} <cmd> (or set CLAUDE_CODE_OAUTH_TOKEN)`
          : "export CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token) (or set ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN), put it in ./.env, or point at another file: cowork-harness --dotenv <path> <cmd>",
    required: true, // required for every tier doctor validates — each of those tiers calls a real model when actually run; only a committed-cassette replay needs none (and replay skips doctor)
  });

  const bl = probe.baseline();
  checks.push({
    id: "baseline",
    title: "Platform baseline",
    status: bl.ok ? "ok" : "fail",
    detail: bl.ok ? `desktop-${bl.version}` : bl.error.split("\n")[0],
    remedy: bl.ok ? undefined : "run `cowork-harness sync` (macOS) or restore baselines/desktop-*.json",
    required: true,
  });

  // Advisory-only — `lint` needs python3, but doctor's own checks (record/replay/run) don't, so a miss
  // never blocks any tier.
  const python3Ok = (probe.hasPython3 ?? realProbe.hasPython3!)();
  checks.push({
    id: "python3",
    title: "python3 (for `lint`)",
    status: python3Ok ? "ok" : "warn",
    detail: python3Ok ? "python3 found on PATH" : "python3 not found on PATH",
    remedy: python3Ok ? undefined : "install python3 — only needed for `cowork-harness lint`",
    required: false,
  });

  return checks;
}

const GLYPH: Record<Status, string> = { ok: "✓", fail: "✗", warn: "!", skip: "·" };

/** `cowork-harness doctor [--tier <t>] [--output-format json]` — read-only prerequisite check. */
export function cmdDoctor(args: string[]): void {
  let p;
  try {
    p = parseArgs(args, {
      values: ["--tier", "--output-format"],
      enums: {
        "--tier": ["protocol", "container", "microvm", "hostloop", "cowork"],
        "--output-format": ["text", "json"],
      },
    });
  } catch (e) {
    fail("doctor", "usage", (e as Error).message, undefined, isJsonOutput(args));
  }
  const tier = (p.options["--tier"] as Tier) ?? "container";
  const json = p.options["--output-format"] === "json";

  // reject unexpected positional arguments.
  if (p.positionals.length > 0) {
    fail("doctor", "usage", `unexpected arguments: ${p.positionals.join(" ")}`, undefined, isJsonOutput(args));
  }

  const checks = runDoctorChecks(tier);
  const blocking = checks.filter((c) => c.required && c.status === "fail");
  const ok = blocking.length === 0;

  if (json) {
    // Routed through the shared envelope (schema/doctor.json, SPEC §11.x/§12) so the completed-probe
    // shape carries `error: null` like every other command's normal-path JSON — a consumer branching
    // on `error !== null` sees a consistent frame across `doctor` and the rest of the CLI.
    out(jsonPayloadEnvelope("doctor", ok, { tier, checks }));
  } else {
    log(`cowork-harness doctor — tier: ${tier}\n`);
    for (const c of checks) {
      log(`  ${GLYPH[c.status]} ${c.title} — ${c.detail}`);
      if (c.remedy && (c.status === "fail" || c.status === "warn")) log(`      → ${c.remedy}`);
    }
    log(
      ok
        ? `\n✓ ready for \`${tier}\`${checks.some((c) => c.status === "warn") ? " (with warnings)" : ""}`
        : `\n✗ not ready for \`${tier}\` — ${blocking.length} blocking issue(s): ${blocking.map((c) => c.id).join(", ")}`,
    );
  }
  return process.exit(ok ? 0 : 1);
}
