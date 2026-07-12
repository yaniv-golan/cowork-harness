import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import type { PlatformBaseline, Scenario } from "../types.js";
import type { LaunchPlan } from "../session.js";
import { resolveMounts, resolveAgentBinary } from "../baseline.js";
import { agentArgs, spawnEnv, dockerRunArgv } from "./argv.js";
import { runtimeAuthEnv } from "./host-env.js";
import { stageWorkspace } from "./stage.js";
import { capturePreRunManifest } from "../run/pre-run-manifest.js";
import { makeCoworkHandler } from "../hostloop/cowork-handler.js";
import type { McpHandler } from "../hostloop/workspace-handler.js";

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
  _scenario: Scenario,
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
  // on a leftover same-named container, and so Ctrl-C can force-remove the container by name (the
  // anonymous `docker run --rm` client can't stop the daemon-managed container — orphan + network leak).
  const containerName = `cowork-ct-${opts.runToken ?? sessionId}`;

  // --- stage a single writable session tree on the host, bound rw at /sessions/<id> ---
  // Shared staging helper honors plan.resume uniformly (skips re-copy on resume — Cowork reuses the
  // same VM and never re-stages; see stage.ts).
  const sessionHost = join(resolve(outDir), "work", "session");
  const mntHost = join(sessionHost, "mnt");
  const outputsHostDir = join(mntHost, "outputs");
  const { mcpStaged } = stageWorkspace(plan, mntHost);
  // no_unexpected_files baseline: snapshot the user-visible roots' paths post-staging, pre-spawn.
  capturePreRunManifest(plan, mntHost, outDir, "container");
  const mcpGuest = mcpStaged ? `${configGuest}/mcp.json` : undefined;

  const agentHost = resolveAgentBinary(baseline);
  const image = process.env.COWORK_AGENT_IMAGE ?? "cowork-agent-base:2";
  // Explicit opts take priority over process.env (concurrency-safe); env var is the
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
    // The tier-uniform agent_env knob rides in via `extra`, which spawnEnv applies LAST — no scrub
    // needed here: the container's env is a constructed allowlist, never the operator's shell.
    extra: { ...runtimeAuthEnv(), ...plan.agentEnv },
  });
  const claudeArgs = agentArgs(baseline, plan, {
    mntRoot,
    systemPromptAppend: opts.systemPromptAppend,
    mcpGuest,
    // present_files must be a known, pre-approved cowork tool — otherwise the agent's first call gets
    // auto-allowed as OFF-REGISTRY, tripping the cowork-parity permissive-auto-allow guard and failing
    // the run (confirmed live against a real container spawn before this was added). extraAllowedTools
    // is stated explicitly (no hidden extraTools→allowedTools coupling), keeping this tier's
    // CURRENT pre-approval set unchanged.
    extraTools: ["mcp__cowork__present_files"],
    extraAllowedTools: ["mcp__cowork__present_files"],
  });
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
    readOnlyMountPaths: plan.mounts.filter((m) => m.mode === "r").map((m) => m.mountPath), // enforce mode:r as :ro binds
  });

  const child = spawn(runner, dockerArgs, { stdio: ["pipe", "pipe", "pipe"] });
  const sdkMcp: { servers: string[]; handle: McpHandler } = {
    servers: ["cowork"],
    handle: makeCoworkHandler({
      sessionRootVm: sessionRoot,
      sessionHostDir: sessionHost,
      outputsHostDir,
      folderMounts: plan.mounts.filter((m) => m.kind === "folder").map((m) => m.mountPath),
    }),
  };
  return { child, containerName, sdkMcp };
}
