import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import type { PlatformBaseline, Scenario } from "../types.js";
import { DEFAULT_MAX_THINKING_TOKENS } from "../types.js";
import type { LaunchPlan } from "../session.js";
import { resolveMounts } from "../baseline.js";
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
  opts: { systemPromptAppend?: string; egressProxy?: string; dockerNetwork?: string } = {},
) {
  const m = resolveMounts(baseline, sessionId, "proj1");
  const sessionRoot = m.cwd; // /sessions/<id>
  const mntRoot = m.mntRoot; // /sessions/<id>/mnt
  const configGuest = `${sessionRoot}/${baseline.spawn?.configDirInGuest ?? "mnt/.claude"}`;
  const AGENT_IN = "/usr/local/bin/claude";

  // --- stage a single writable session tree on the host, bound rw at /sessions/<id> ---
  // Shared staging helper honors plan.resume uniformly (skips re-copy on resume — Cowork reuses the
  // same VM and never re-stages; see stage.ts).
  const sessionHost = join(resolve(outDir), "work", "session");
  const mntHost = join(sessionHost, "mnt");
  const { mcpStaged } = stageWorkspace(plan, mntHost);
  const mcpGuest = mcpStaged ? `${configGuest}/mcp.json` : undefined;

  const agentHost = resolveAgentBinary(baseline);
  const image = process.env.COWORK_AGENT_IMAGE ?? "cowork-agent-base:1";
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
    sessionRoot,
    sessionHost,
    agentHost,
    agentIn: AGENT_IN,
    image,
    env,
    agentArgv: claudeArgs,
    readOnlyMountPaths: plan.mounts.filter((m) => m.mode === "r").map((m) => m.mountPath), // #23: enforce mode:r as :ro binds
  });

  return spawn(runner, dockerArgs, { stdio: ["pipe", "pipe", "pipe"] });
}

/** Resolve the staged Linux agent binary on the host (override: COWORK_AGENT_BINARY). */
function resolveAgentBinary(baseline: PlatformBaseline): string {
  const override = process.env.COWORK_AGENT_BINARY;
  if (override) {
    if (!existsSync(override)) throw new Error(`COWORK_AGENT_BINARY not found: ${override}`);
    return resolve(override);
  }
  const staged = (baseline.agentBinary?.stagedPath ?? "").replace(/^~(?=$|\/)/, homedir());
  if (!staged || !existsSync(staged)) {
    throw new Error(
      `Staged agent binary not found at "${staged}". It is extracted from your Claude Desktop install ` +
        `(claude-code-vm/<ver>/claude). Open Cowork once to stage it, or set COWORK_AGENT_BINARY to its path.`,
    );
  }
  return resolve(staged);
}
