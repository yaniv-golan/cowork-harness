import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import type { PlatformBaseline, Scenario } from "../types.js";
import { DEFAULT_MAX_THINKING_TOKENS } from "../types.js";
import type { LaunchPlan } from "../session.js";
import { resolveMounts, resolveAgentBinary } from "../baseline.js";
import { agentArgs, spawnEnv, dockerRunArgv, resolveMaxThinkingTokens } from "./argv.js";
import { runtimeAuthEnv } from "./host-env.js";
import { stageWorkspace } from "./stage.js";

/**
 * L1 — container parity runtime. Runs the staged in-VM agent in a sandboxed arm64
 * Linux container that reproduces the Desktop→agent spawn contract (asar 1.12603.1):
 *   - cwd = /sessions/<id> (NOT the mnt root); CLAUDE_CONFIG_DIR = mnt/.claude
 *   - one WRITABLE bind for the whole session root (host FS otherwise sealed)
 *   - plugins via --plugin-dir; tool registry via --tools/--allowedTools
 *   - the spawn env object from baseline.spawn.env (NOT CLAUDE_CODE_USE_COWORK_PLUGINS)
 * The agent binary is bind-mounted from the user's own install (not in the image).
 */
export function spawnContainer(
  scenario: Scenario,
  baseline: PlatformBaseline,
  plan: LaunchPlan,
  outDir: string,
  sessionId: string,
  opts: { systemPromptAppend?: string; egressProxy?: string; dockerNetwork?: string; runToken?: string } = {},
) {
  const m = resolveMounts(baseline, sessionId, "proj1");
  const sessionRoot = m.cwd; // /sessions/<id>
  const mntRoot = m.mntRoot; // /sessions/<id>/mnt
  const configGuest = `${sessionRoot}/${baseline.spawn?.configDirInGuest ?? "mnt/.claude"}`;
  const AGENT_IN = "/usr/local/bin/claude";
  // Name by the per-invocation runToken (NOT sessionId) so a --resume after a failed run doesn't collide
  // on a leftover same-named container (F1), and so Ctrl-C can force-remove the container by name (the
  // anonymous `docker run --rm` client can't stop the daemon-managed container — orphan + network leak).
  const containerName = `cowork-ct-${opts.runToken ?? sessionId}`;

  // --- stage a single writable session tree on the host, bound rw at /sessions/<id> ---
  // Shared staging helper honors plan.resume uniformly (skips re-copy on resume — Cowork reuses the
  // same VM and never re-stages; see stage.ts).
  const sessionHost = join(resolve(outDir), "work", "session");
  const mntHost = join(sessionHost, "mnt");
  const { mcpStaged } = stageWorkspace(plan, mntHost);
  const mcpGuest = mcpStaged ? `${configGuest}/mcp.json` : undefined;

  const agentHost = resolveAgentBinary(baseline);
  const image = process.env.COWORK_AGENT_IMAGE ?? "cowork-agent-base:2";
  // #43: explicit opts take priority over process.env (concurrency-safe); env var is the
  // manual/dev fallback for direct `docker run` invocations that bypass the sidecar.
  const proxyHost = opts.egressProxy ?? process.env.COWORK_EGRESS_PROXY ?? "http://egress-proxy:8080";
  const network = opts.dockerNetwork ?? process.env.COWORK_DOCKER_NETWORK ?? "cowork-net";
  const runner = process.env.COWORK_CONTAINER_RUNTIME ?? "docker";

  // NOTE: local marketplaces are resolved to --plugin-dir in buildLaunchPlan (the in-VM
  // agent loads via --plugin-dir; the `claude plugin marketplace add` registry is inert
  // in cowork mode — SPEC §6). No pre-registration step needed.

  const env = spawnEnv(baseline, {
    configGuest,
    proxyHost,
    extra: runtimeAuthEnv(),
    maxThinkingTokens: resolveMaxThinkingTokens(
      plan.maxThinkingTokens,
      plan.model,
      baseline.spawn?.maxThinkingTokens ?? DEFAULT_MAX_THINKING_TOKENS,
    ),
  });
  const claudeArgs = agentArgs(baseline, plan, { mntRoot, systemPromptAppend: opts.systemPromptAppend, mcpGuest });
  const dockerArgs = dockerRunArgv({
    network,
    lockdown: (process.env.COWORK_LOCKDOWN ?? "on") !== "off",
    name: containerName,
    sessionRoot,
    sessionHost,
    agentHost,
    agentIn: AGENT_IN,
    image,
    env,
    agentArgv: claudeArgs,
    readOnlyMountPaths: plan.mounts.filter((m) => m.mode === "r").map((m) => m.mountPath), // #23: enforce mode:r as :ro binds
  });

  const child = spawn(runner, dockerArgs, { stdio: ["pipe", "pipe", "pipe"] });
  return { child, containerName };
}
