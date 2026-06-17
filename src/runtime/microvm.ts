import { spawn } from "node:child_process";
import { join } from "node:path";
import type { PlatformBaseline, Scenario } from "../types.js";
import { DEFAULT_MAX_THINKING_TOKENS } from "../types.js";
import type { LaunchPlan } from "../session.js";
import { limaPath, vmInit, applyGuestFirewall, vmGatewayIp, VM_WORK_HOST } from "./lima.js";
import { resolveMounts } from "../baseline.js";
import { spawnEnv, resolveMaxThinkingTokens, baseAgentArgs } from "./argv.js";
import { stageWorkspace } from "./stage.js";
import { runtimeAuthEnv, SECRET_ENV_KEYS } from "./host-env.js";

/** Sentinel terminating the #29 stdin secret prologue (unlikely to collide with env content). */
export const MICROVM_SECRET_SENTINEL = "__COWORK_SECRETS_END__";

/**
 * L2 — microVM parity runtime. Runs the staged agent inside a REAL Apple VZ Linux
 * microVM (separate kernel) — the closest analog to Cowork's own sandbox, for
 * untrusted-skill isolation. Mirrors the L1 spawn contract: cwd = /sessions/<id>
 * (via a symlink to the lima-mounted work dir), config at mnt/.claude, plugins via
 * --plugin-dir, the verified spawn env, --tools/--allowedTools.
 *
 * Egress: a host-side allowlist proxy + a guest default-deny iptables firewall.
 */
export function spawnMicroVm(
  scenario: Scenario,
  baseline: PlatformBaseline,
  plan: LaunchPlan,
  outDir: string,
  sessionId: string,
  opts: { systemPromptAppend?: string; proxyPort?: number } = {},
) {
  const { instance } = vmInit(baseline);
  const m = resolveMounts(baseline, sessionId, "proj1");
  const sessionVm = m.cwd; // /sessions/<id>
  const mntVm = m.mntRoot; // /sessions/<id>/mnt
  const configVm = `${sessionVm}/${baseline.spawn?.configDirInGuest ?? "mnt/.claude"}`;

  // Stage into the lima-mounted work dir (host VM_WORK_HOST -> guest /cowork-work) via the shared
  // helper. It honors plan.resume for ALL of .claude + mounts + mcp.json (the #26/I2 .claude guard
  // generalized): on resume Cowork reuses the same VM and never re-stages, and skipping the mount
  // re-copy also avoids reverting in-session edits to a rw / .projects mount (see stage.ts).
  const sessionHost = join(VM_WORK_HOST, sessionId);
  const mntHost = join(sessionHost, "mnt");
  const { mcpStaged } = stageWorkspace(plan, mntHost);
  const mcpVm = mcpStaged ? `${configVm}/mcp.json` : undefined;
  // (Local marketplaces are resolved to --plugin-dir in buildLaunchPlan; the registry
  // is inert in cowork mode — SPEC §6. No registration step.)

  // Guest default-deny egress (allow only the host proxy gateway + DNS). Use the port the caller
  // allocated for THIS run's host proxy (so host bind and guest firewall/proxy agree); fall back to the
  // env/8899 default only when spawned without an explicit port.
  const proxyPort = opts.proxyPort ?? Number(process.env.COWORK_VM_PROXY_PORT ?? 8899);
  const gatewayIp = vmGatewayIp(); // #39: one resolved value feeds both the firewall rule and proxy URL.
  const lockdown = (process.env.COWORK_LOCKDOWN ?? "on") !== "off";
  if (lockdown) {
    try {
      applyGuestFirewall(instance, proxyPort, gatewayIp);
    } catch (err) {
      // #40: a swallowed firewall failure left L2 running with NO iptables while advertising
      // default-deny isolation — a silent false-green (violates the repo's core principle). With
      // lockdown on (the default) this MUST fail loud; COWORK_LOCKDOWN=off is the explicit opt-out.
      if (firewallFailureAction(lockdown) === "throw") {
        throw new Error(
          `[microvm] guest firewall failed to apply — L2 egress isolation is NOT in effect; the VM is left running. ` +
            `Set COWORK_LOCKDOWN=off to run WITHOUT isolation deliberately. (${String(err)})`,
        );
      }
    }
  }
  const proxyUrl = `http://${gatewayIp}:${proxyPort}`;

  // Use the shared contract-layer env builder so all four proxy vars (incl. lowercase
  // http_proxy/https_proxy) and the auth-env fidelity drop are identical to container/host-loop.
  const env = spawnEnv(baseline, {
    configGuest: configVm,
    proxyHost: proxyUrl,
    extra: runtimeAuthEnv(),
    maxThinkingTokens: resolveMaxThinkingTokens(
      plan.maxThinkingTokens,
      plan.model,
      baseline.spawn?.maxThinkingTokens ?? DEFAULT_MAX_THINKING_TOKENS,
    ),
  });
  // #29: keep SECRET values off the `limactl shell …` argv (host-visible via ps). Public env rides
  // argv via `env KEY=value`; secrets are handed to the guest over a stdin PROLOGUE the shell script
  // consumes before exec'ing claude (NOT argv, NOT disk).
  const envPairs = Object.entries(env)
    .filter(([k]) => !SECRET_ENV_KEYS.has(k))
    .map(([k, v]) => `${k}=${v}`);
  const secretPairs = Object.entries(env).filter(([k]) => SECRET_ENV_KEYS.has(k));

  const claudeArgs = microvmAgentArgs(baseline, plan, mntVm, { mcpVm, systemPromptAppend: opts.systemPromptAppend });

  const script = microvmShellScript(sessionVm);
  const child = spawn(limaPath(), ["shell", instance, "sh", "-c", script, "_", "env", ...envPairs, "claude", ...claudeArgs], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  // Write the secret prologue FIRST — before the caller's LiveAgentSession writes init-1 — so it lands
  // ahead of the control stream on the pipe. The shell reads up to MICROVM_SECRET_SENTINEL, exports each
  // line, then `exec`s claude with stdin positioned at the protocol stream. (Live-lane behavior; the
  // script shape is unit-tested.)
  for (const [k, v] of secretPairs) child.stdin.write(`${k}=${v}\n`);
  child.stdin.write(`${MICROVM_SECRET_SENTINEL}\n`);
  return child;
}

/**
 * #40: pure policy for what to do when applyGuestFirewall() throws. When lockdown is on
 * (the default), a firewall failure must fail loud ("throw") — L2 advertises default-deny
 * egress, so running with no iptables is a silent false-green. COWORK_LOCKDOWN=off is the
 * explicit opt-out, deliberately running without isolation ("skip"). Extracted so the
 * decision is unit-testable token-free (the live iptables path needs Lima).
 */
export function firewallFailureAction(lockdown: boolean): "throw" | "skip" {
  return lockdown ? "throw" : "skip";
}

/**
 * #63: the in-guest shell script. The work root is mounted directly at /sessions, so `sessionVm`
 * (/sessions/<id>) is a REAL dir — cd into it and exec the agent (no symlink, no mkdir). `set -e` +
 * the explicit cd guard FAIL LOUD if the mount is missing (a stale/un-provisioned VM) instead of
 * silently exec'ing with the wrong cwd and an unwritable CLAUDE_CONFIG_DIR (the old `;`-chained
 * script's silent false-green). The agent + public env ride in argv ($@); #29: SECRET env arrives
 * on a stdin PROLOGUE (read up to the sentinel, exported) so the token is never in argv or on disk.
 * Pure + exported so the script shape is unit-testable.
 */
export function microvmShellScript(sessionVm: string): string {
  const cdFail = `microvm: ${sessionVm} is not mounted — VM not provisioned for this harness config; recreate it (cowork-harness vm delete && vm init)`;
  // Consume the #29 secret prologue (one KEY=value per line) up to the sentinel, exporting each, then
  // exec the agent — at which point stdin is positioned at the control-protocol stream for claude.
  return (
    `set -e; cd ${sessionVm} 2>/dev/null || { echo "${cdFail}" >&2; exit 1; }; ` +
    `while IFS= read -r __cs; do [ "$__cs" = "${MICROVM_SECRET_SENTINEL}" ] && break; export "$__cs"; done; ` +
    `exec "$@"`
  );
}

/**
 * The microVM `claude …` args (sans the leading "claude" token, which the lima argv appends). Delegates
 * to the shared `baseAgentArgs` so it can NEVER drift from the container/hostloop flag set again — the
 * exact divergence that once dropped `--max-thinking-tokens` from this path. The microvm uses the guest
 * mount root `mntVm` and passes no disallowed/extraTools. Exported for unit testing of the flag wiring.
 */
export function microvmAgentArgs(
  baseline: PlatformBaseline,
  plan: LaunchPlan,
  mntVm: string,
  opts: { mcpVm?: string; systemPromptAppend?: string } = {},
): string[] {
  return baseAgentArgs(baseline, plan, { mntRoot: mntVm, mcpGuest: opts.mcpVm, systemPromptAppend: opts.systemPromptAppend });
}
