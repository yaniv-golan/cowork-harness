import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../cli-args.js";
import { resolveAgentBinary, loadBaseline } from "../baseline.js";
import { limaPath } from "../runtime/lima.js";
import { pkgVersion } from "./envelope.js";

// Synchronous fd writes (match cli.ts): machine→stdout, human→stderr.
const out = (s: string) => process.stdout.write(s + "\n");
const log = (s: string) => process.stderr.write(s + "\n");

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
  imageName(): string;
  imagePresent(): boolean;
  proxyImageName(): string;
  proxyImagePresent(): boolean;
  agentBinary(): { ok: true; path: string } | { ok: false; error: string };
  hasToken(): boolean;
  baseline(): { ok: true; version: string } | { ok: false; error: string };
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
    const r = spawnSync(this.runtimeName(), ["--version"], { stdio: "ignore" });
    return !r.error && r.status === 0;
  },
  runtimeDaemonUp() {
    const r = spawnSync(this.runtimeName(), ["info"], { stdio: "ignore" });
    return !r.error && r.status === 0;
  },
  limaAvailable() {
    const r = spawnSync(limaPath(), ["--version"], { stdio: "ignore" });
    return !r.error && r.status === 0;
  },
  imageName: () => process.env.COWORK_AGENT_IMAGE ?? "cowork-agent-base:2",
  imagePresent() {
    const r = spawnSync(this.runtimeName(), ["image", "inspect", this.imageName()], { stdio: "ignore" });
    return !r.error && r.status === 0;
  },
  proxyImageName: () => process.env.COWORK_PROXY_IMAGE ?? "cowork-egress-proxy:1",
  proxyImagePresent() {
    const r = spawnSync(this.runtimeName(), ["image", "inspect", this.proxyImageName()], { stdio: "ignore" });
    return !r.error && r.status === 0;
  },
  agentBinary() {
    try {
      return { ok: true, path: resolveAgentBinary(loadBaseline("latest")) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
  hasToken: () => !!(process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
  baseline() {
    try {
      return { ok: true, version: loadBaseline("latest").appVersion };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
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
    return {
      id: "agent",
      title: "Staged agent binary",
      status: agent.ok ? "ok" : "fail",
      detail: agent.ok ? agent.path : agent.error.split("\n")[0],
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
    checks.push({ id: "agent", title: "Staged agent binary", status: "skip", detail: `not needed for ${tier}`, required: false });
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
      detail: present ? `${image} present` : up ? `${image} missing` : `(skipped — ${runtime} not reachable)`,
      remedy: present || !up ? undefined : `build it: ${agentBuildLine(runtime, image)}`,
      required: up, // only gate on the image once the runtime is actually reachable
    });

    checks.push(agentCheck());

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
  checks.push({
    id: "token",
    title: "Auth token",
    status: token ? "ok" : "fail",
    detail: token ? "found (env / .env)" : "no CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY",
    remedy: token ? undefined : "export CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token) or put it in .env",
    required: true, // every doctor tier calls a real model (only a committed-cassette replay needs none)
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
    log((e as Error).message);
    return process.exit(2);
  }
  const tier = (p.options["--tier"] as Tier) ?? "container";
  const json = p.options["--output-format"] === "json";

  // reject unexpected positional arguments.
  if (p.positionals.length > 0) {
    log(`unexpected arguments: ${p.positionals.join(" ")}`);
    return process.exit(2);
  }

  const checks = runDoctorChecks(tier);
  const blocking = checks.filter((c) => c.required && c.status === "fail");
  const ok = blocking.length === 0;

  if (json) {
    out(JSON.stringify({ tool: "cowork-harness", version: pkgVersion(), command: "doctor", tier, ok, checks }));
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
