import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { PlatformBaseline, Scenario } from "../types.js";
import type { LaunchPlan } from "../session.js";
import { resolveMounts } from "../baseline.js";
import { makeWorkspaceHandler, type McpHandler, type EgressEntry, type WebFetchProvenance } from "../hostloop/workspace-handler.js";
import { agentArgs, spawnEnv, dockerRunArgv, resolveMaxThinkingTokens } from "./argv.js";
import { runtimeAuthEnv } from "./host-env.js";
import { stageWorkspace } from "./stage.js";

/**
 * HOST-LOOP runtime — reproduces Cowork's host-loop mode: the agent loop runs "on the
 * host" with native Bash/WebFetch DISABLED and replaced by mcp__workspace__bash /
 * mcp__workspace__web_fetch (a workspace MCP server we run), and `${CLAUDE_PLUGIN_ROOT}`
 * is a HOST path that bash cannot resolve — so a skill's bash that references it must
 * self-heal via `find /sessions/<id>/mnt ...`, exactly like production Cowork.
 *
 * Single container: file/discovery use the mounted vm paths (/sessions/<id>/mnt), bash
 * (the MCP server) runs there too, but CLAUDE_PLUGIN_ROOT points at an UNMOUNTED
 * /host/... path so `[ -d "$CLAUDE_PLUGIN_ROOT" ]` is false in bash → self-heal triggers.
 */
export function spawnHostLoop(
  scenario: Scenario,
  baseline: PlatformBaseline,
  plan: LaunchPlan,
  outDir: string,
  sessionId: string,
  opts: {
    systemPromptAppend?: string;
    runToken?: string;
    egressProxy?: string;
    dockerNetwork?: string;
    provenanceRef?: { current?: WebFetchProvenance }; // #30: filled by execute.ts/chat.ts (Run-backed)
  } = {},
) {
  const m = resolveMounts(baseline, sessionId, "proj1");
  const sessionRoot = m.cwd;
  const mntRoot = m.mntRoot;
  const configGuest = `${sessionRoot}/${baseline.spawn?.configDirInGuest ?? "mnt/.claude"}`;
  const AGENT_IN = "/usr/local/bin/claude";
  // Name by the per-invocation runToken (NOT sessionId) so a --resume after a failed run doesn't collide
  // on a leftover same-named container (F1). cwd/work dir stay keyed by sessionId (stable for resume).
  const containerName = `cowork-hl-${opts.runToken ?? sessionId}`;
  // #43: explicit opts take priority over process.env (concurrency-safe); env var is the
  // manual/dev fallback for direct `docker run` invocations that bypass the sidecar.
  const proxyHost = opts.egressProxy ?? process.env.COWORK_EGRESS_PROXY ?? "http://egress-proxy:8080";
  const network = opts.dockerNetwork ?? process.env.COWORK_DOCKER_NETWORK ?? "cowork-net";

  // stage the writable session tree via the shared helper (honors plan.resume — skips re-copy on
  // resume, matching Cowork's same-VM-no-restage behavior; see stage.ts).
  const sessionHost = join(resolve(outDir), "work", "session");
  const mntHost = join(sessionHost, "mnt");
  // --mcp-config is HONORED in plain cowork mode (SPEC §6) — staged for host-loop too (was silently
  // dropped here before).
  const { mcpStaged } = stageWorkspace(plan, mntHost);
  const mcpGuest = mcpStaged ? `${configGuest}/mcp.json` : undefined;

  // CLAUDE_PLUGIN_ROOT = an UNMOUNTED host path -> bash can't resolve it -> self-heal.
  // #31: a single env var cannot model real Claude Code's per-plugin-hook scoping, and host-loop
  // only needs an UNRESOLVABLE path to trigger the skill's self-heal — the basename is incidental.
  // Picking pluginDirs[0] implied the var tracked a specific (the first) plugin; it does not.
  // Use a fixed sentinel that is deliberately unresolvable in-guest. Do NOT rely on it pointing
  // at a real plugin.
  const hostPluginRoot = "/host/plugins/unmounted";

  const agentHost = resolveAgentBinary(baseline);
  const image = process.env.COWORK_AGENT_IMAGE ?? "cowork-agent-base:1";
  const runner = process.env.COWORK_CONTAINER_RUNTIME ?? "docker";

  // Host-loop deltas: native Bash/WebFetch/NotebookEdit OFF (shell goes through the workspace
  // SDK-MCP server — driver handles mcp_message), the workspace tools pre-approved, the
  // Shell-access prompt section, and CLAUDE_PLUGIN_ROOT = an UNMOUNTED host path (self-heal).
  // Host-loop excludes the asar's HOST_LOOP_EXCLUDED_BUILTIN_TOOLS = {Bash, NotebookEdit, REPL,
  // JavaScript, WebFetch}; of those only Bash/NotebookEdit/WebFetch exist in the CLI agent's
  // registry (verified 2026-06-13 — REPL/JavaScript are asar names for other surfaces, absent
  // here), so disallowing the three real ones is the faithful set.
  const systemPromptAppend = [opts.systemPromptAppend, hostLoopShellSection(mntRoot, baseline.appVersion)].filter(Boolean).join("\n\n");
  const env = spawnEnv(baseline, {
    configGuest,
    proxyHost,
    extra: { CLAUDE_PLUGIN_ROOT: hostPluginRoot, ...runtimeAuthEnv() },
    maxThinkingTokens: resolveMaxThinkingTokens(plan.maxThinkingTokens, plan.model, baseline.spawn?.maxThinkingTokens ?? 31999),
  });
  const claudeArgs = agentArgs(baseline, plan, {
    mntRoot,
    systemPromptAppend,
    mcpGuest,
    disallowed: ["Bash", "WebFetch", "NotebookEdit"],
    extraTools: ["mcp__workspace__bash", "mcp__workspace__web_fetch"],
  });
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
    name: containerName, // so the driver can `docker exec` workspace-bash into this container
    readOnlyMountPaths: plan.mounts.filter((m) => m.mode === "r").map((m) => m.mountPath), // #23: enforce mode:r as :ro binds
  });

  const child = spawn(runner, dockerArgs, { stdio: ["pipe", "pipe", "pipe"] });
  // #31: host-routed web_fetch bypasses the sidecar proxy, so collect its egress decisions here and
  // surface them to execute.ts → result.egress, making host-loop web_fetch visible to egress assertions.
  const hostEgress: EgressEntry[] = [];
  const sdkMcp: { servers: string[]; handle: McpHandler } = {
    servers: ["workspace"],
    handle: makeWorkspaceHandler(containerName, mntRoot, runner, plan.egressAllow, (e) => hostEgress.push(e), opts.provenanceRef),
  };
  return { child, sdkMcp, containerName, hostEgress };
}

function hostLoopShellSection(vmMnt: string, appVersion: string): string {
  // Parameterize by baseline appVersion so fidelity tracks the actual installed Desktop release. (#27)
  // The path must resolve to baselines/prompts/desktop-<appVersion>/host-loop-append.md.
  const dir = fileURLToPath(new URL(`../../baselines/prompts/desktop-${appVersion}/host-loop-append.md`, import.meta.url));
  let content: string;
  try {
    content = readFileSync(dir, "utf8");
  } catch (err) {
    // Loud failure: a missing prompt asset is a real fidelity gap, not a silent no-op. (#27)
    process.stderr.write(
      `::warning:: [hostloop] host-loop prompt asset not found at ${dir} (baseline desktop-${appVersion}) — host-loop shell section will be EMPTY. ` +
        `Run \`cowork-harness sync\` to update baselines, or set COWORK_AGENT_BINARY to a matching binary. (${String(err)})\n`,
    );
    return "";
  }
  return content
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("{{vmMnt}}")
    .join(vmMnt)
    .trim();
}

function resolveAgentBinary(baseline: PlatformBaseline): string {
  const override = process.env.COWORK_AGENT_BINARY;
  if (override) {
    if (!existsSync(override)) throw new Error(`COWORK_AGENT_BINARY not found: ${override}`);
    return resolve(override);
  }
  const staged = (baseline.agentBinary?.stagedPath ?? "").replace(/^~(?=$|\/)/, homedir());
  if (!staged || !existsSync(staged)) {
    throw new Error(`Staged agent binary not found at "${staged}". Open Cowork once to stage it, or set COWORK_AGENT_BINARY.`);
  }
  return resolve(staged);
}
