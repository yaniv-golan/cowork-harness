import { warn } from "../io.js";
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlatformBaseline, Scenario } from "../types.js";
import type { LaunchPlan, Mount } from "../session.js";
import { resolveMounts, resolveAgentBinary, resolveHostAgentBinary, cmpVersionStrings, MOUNT_BARE_NAME_MIN_VERSION } from "../baseline.js";
import { generateHostLoopShellSection } from "./hostloop-prompt.js";

/**
 * The host-loop "## Shell access" section is built dynamically from mount state (asar fn Lxr) at/above
 * this release, and read from the static `host-loop-append.md` asset below it. This is the SAME release
 * boundary as bare-name mounting (the asar switched both together), so it aliases the single shared
 * constant `MOUNT_BARE_NAME_MIN_VERSION` — keeping prompt-gating and mount-gating impossible to desync.
 */
const HOSTLOOP_DYNAMIC_PROMPT_MIN_VERSION = MOUNT_BARE_NAME_MIN_VERSION;
import { makeWorkspaceHandler, type McpHandler, type EgressEntry, type WebFetchProvenance } from "../hostloop/workspace-handler.js";
import { baseAgentArgs, hostNativeSpawnEnv, dockerRunArgv } from "./argv.js";
import { runtimeAuthEnv } from "./host-env.js";
import { resolveHostLoopBindMounts, stageHostLoopWorkspace } from "./hostloop-stage.js";
import { capturePreRunManifest } from "../run/pre-run-manifest.js";
import { checkHostLoopPathGate, PATH_GATE_TOOL_NAMES, type HostLoopPathGateConfig } from "../hostloop/pretooluse-path-hook.js";
import type { HookBundle } from "../agent/session.js";
import { stripComments } from "../prompt.js";

const HOSTLOOP_PATH_GATE_ID = "hostloop-path-gate";

/**
 * Pure builder for the hostloop native process's env: `hostNativeSpawnEnv`'s contract-layer output
 * layered over this REAL macOS process's own `...process.env` base (unlike container/microvm, which
 * spawn into a container with an explicit `-e KEY[=value]` allowlist — see dockerRunArgv — this process
 * inherits the operator's whole shell env). Real Cowork never sets `MAX_THINKING_TOKENS` (the
 * `--max-thinking-tokens`/`--thinking disabled` flag is the sole delivery channel — see
 * `hostNativeSpawnEnv`'s doc comment); a stray host `MAX_THINKING_TOKENS` already in the operator's shell
 * would otherwise leak straight through `...process.env` and — were the ELF to still read the env —
 * silently outrank the flag. Strip it explicitly. Extracted from `spawnHostLoop` so this env-construction
 * step is unit-testable without spawning anything.
 */
export function buildHostLoopNativeEnv(baseline: PlatformBaseline, opts: Parameters<typeof hostNativeSpawnEnv>[1]): NodeJS.ProcessEnv {
  const nativeEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...hostNativeSpawnEnv(baseline, opts),
  };
  delete nativeEnv.MAX_THINKING_TOKENS;
  return nativeEnv;
}

/**
 * HOST-LOOP runtime — reproduces Cowork's REAL host-loop architecture: the agent LOOP is a native macOS
 * process spawned directly on the host — no Docker sandbox around the file tools, matching production.
 * Only bash/web_fetch route into a Docker "VM" sidecar (this container has no agent inside it at all; it
 * exists solely as a `docker exec` target). Connected folders are BIND-MOUNTED into the sidecar and read
 * directly off the real host path by the native process's file tools — never copied while the agent
 * runs. This closes a false-green: a skill that hardcodes a VM-absolute path in Read/Edit used to
 * "succeed" under an earlier copy-into-container design that could never model that path, while failing
 * the same way in real Cowork.
 *
 * With no OS sandbox around the native file tools, the PreToolUse path-containment gate
 * (../hostloop/pretooluse-path-hook.ts) is hostloop's ENTIRE security boundary for real filesystem
 * access — see docs/boundary.md for the full layered safety posture (opt-in for writable folders, the
 * loud notice, and the runtime tripwire below that catches the gate silently failing to fire).
 */
export function spawnHostLoop(
  _scenario: Scenario,
  baseline: PlatformBaseline,
  plan: LaunchPlan,
  outDir: string,
  sessionId: string,
  opts: {
    systemPromptAppend?: string;
    runToken?: string;
    egressProxy?: string;
    dockerNetwork?: string;
    provenanceRef?: { current?: WebFetchProvenance }; // filled by execute.ts/chat.ts (Run-backed)
  } = {},
) {
  const m = resolveMounts(baseline, sessionId, "proj1");
  const sessionRoot = m.cwd;
  const mntRoot = m.mntRoot;
  // Name by the per-invocation runToken (NOT sessionId) so a --resume after a failed run doesn't collide
  // on a leftover same-named container. cwd/work dir stay keyed by sessionId (stable for resume).
  const containerName = `cowork-hl-${opts.runToken ?? sessionId}`;
  const network = opts.dockerNetwork ?? process.env.COWORK_DOCKER_NETWORK ?? "cowork-net";

  // Stage the writable session tree: NO folder copies (bind-mounted real paths instead), uploads/
  // plugins still staged (copies — same fidelity boundary as before), mcp.json staged into the CONFIG
  // dir (a host path the native argv can reference directly).
  const sessionHost = join(resolve(outDir), "work", "session");
  const mntHost = join(sessionHost, "mnt");
  const { mcpHostPath } = stageHostLoopWorkspace(plan, mntHost);
  // no_unexpected_files baseline: staged outputs + each bind-mounted folder SOURCE (never staged
  // at this tier) walked at its mountPath — the path space snapshotHostLoopWorkspace produces post-run.
  capturePreRunManifest(plan, mntHost, outDir, "hostloop");

  // CLAUDE_PLUGIN_ROOT / --plugin-dir for the NATIVE process point at the staged plugin copy (the
  // production-analog `installPath`) — a REAL host path the native process can resolve directly, unlike
  // the pre-split design where the agent ran in-container. bash's `docker exec` sidecar gets NO
  // CLAUDE_PLUGIN_ROOT at all (the env key is omitted below), matching real host-loop where in-guest bash
  // sees the var UNSET — the agent's `[ -z "$CLAUDE_PLUGIN_ROOT" ]` self-heal then discovers the mount via
  // `find /sessions/<id>/mnt ...`, exactly as before, but WITHOUT a bogus /host sentinel leaking into bash.
  const claudePluginRootHost = resolveClaudePluginRootHostPath(plan, mntHost);

  const agentNativeHost = resolveHostAgentBinary(baseline);
  const agentVmHost = resolveAgentBinary(baseline); // unchanged — still the sidecar VM image's basis (bash execs into it)
  const image = process.env.COWORK_AGENT_IMAGE ?? "cowork-agent-base:2";
  const runner = process.env.COWORK_CONTAINER_RUNTIME ?? "docker";

  // Host-loop deltas: native Bash/WebFetch/NotebookEdit OFF (shell goes through the workspace
  // SDK-MCP server — driver handles mcp_message), the workspace tools pre-approved, the
  // Shell-access prompt section. Host-loop excludes the asar's HOST_LOOP_EXCLUDED_BUILTIN_TOOLS =
  // {Bash, NotebookEdit, REPL, JavaScript, WebFetch}; of those only Bash/NotebookEdit/WebFetch exist in
  // the CLI agent's registry, so disallowing the three real ones is the faithful set.
  const hostOutputsDir = join(mntHost, "outputs");
  const systemPromptAppend = [opts.systemPromptAppend, hostLoopShellSection(baseline, m.sessionRoot, mntRoot, plan, hostOutputsDir)]
    .filter(Boolean)
    .join("\n\n");

  // The native process's argv reuses baseAgentArgs (the SAME pure contract layer container/microvm
  // use) but with HOST paths for the two guest-relative params: `mntRoot: mntHost` makes every
  // `--plugin-dir` a real host path to the staged copy, and `mcpGuest: mcpHostPath` makes
  // `--mcp-config` a real host path (there is no guest config dir for a native process).
  const nativeArgs = baseAgentArgs(baseline, plan, {
    mntRoot: mntHost,
    mcpGuest: mcpHostPath,
    systemPromptAppend,
    disallowed: ["Bash", "WebFetch", "NotebookEdit"],
    extraTools: ["mcp__workspace__bash", "mcp__workspace__web_fetch"],
  });
  const nativeEnv = buildHostLoopNativeEnv(baseline, {
    configDir: plan.configDir,
    extra: { CLAUDE_PLUGIN_ROOT: claudePluginRootHost ?? "", ...runtimeAuthEnv() },
    // Real host paths of connected folders (never staged copies) — the only spawn tier where these
    // are meaningful, since container/microvm folders are staged as copies with no real host path.
    folderHostPaths: plan.mounts.filter((mt) => mt.kind === "folder").map((mt) => mt.hostPath),
  });

  // The PreToolUse path-containment gate config. hostCwd = the harness-owned outputs dir (production's
  // `hostCwd = getOutputsDir(e)`); scratchRoots = [hostCwd] (hostCwd and hostOutputsDir are the SAME dir
  // here, so this is one entry, not two).
  const uploadsRoot = join(mntHost, "uploads");
  const spoolRoot = join(plan.configDir, "projects"); // production's spooled-tool-results dir analog: the staged config dir's own "projects" subdir
  const skillsRoot = join(plan.configDir, "skills");
  const pluginRoots = plan.mounts.filter((mt) => mt.kind !== "folder" && mt.kind !== "upload").map((mt) => join(mntHost, mt.mountPath));
  const gateCfg: HostLoopPathGateConfig = {
    hostCwd: hostOutputsDir,
    allowedRoots: [
      hostOutputsDir,
      uploadsRoot,
      spoolRoot,
      skillsRoot,
      ...plan.mounts.filter((mt) => mt.kind === "folder" && mt.mode !== "r").map((mt) => mt.hostPath),
      ...pluginRoots,
    ],
    readOnlyRoots: plan.mounts.filter((mt) => mt.kind === "folder" && mt.mode === "r").map((mt) => mt.hostPath),
    scratchRoots: [hostOutputsDir],
    // Bs === "chat" (asar byte 8079633): scratch ⟺ chat-type session. This function serves BOTH the
    // run/skill lanes AND `chat` (chat.ts). All are treated as cowork-type sessions regardless of folder
    // count, so scratchMode stays false: connected-folder writes are gated only by `allow_host_writes`
    // consent, NOT additionally restricted to the outputs dir the way a production chat-type session would
    // be. Chat here already requires explicit `--allow-host-writes` for an rw folder (safety.ts), and a
    // connected folder in chat is an operator-constructed fixture, not a production chat topology — so this
    // is a known, consented fidelity gap, not a safety break (security-reviewed 2026-07-04). Revisit if
    // chat hostloop should thread session-type scratchMode for closer fidelity.
    //
    // 1.20186.1 addendum: production chat-type sessions ALSO differ in (i) scratch containment,
    // (ii) chat read-roots including uploads + both projects spool dirs, (iii) connected-folder scope.
    // Retained divergence for the chat lane (see docs/fidelity-gaps.md "Chat-lane session topology");
    // the TASK-lane read-only categories (uploads/spool/plugin write-blocks) ARE modeled above.
    scratchMode: false,
    uploadsRoots: [uploadsRoot],
    spooledProjectsRoots: [spoolRoot],
    readOnlyPluginRoots: [skillsRoot, ...pluginRoots],
  };
  const pathGateFired = new Set<string>(); // tool_use_ids the gate actually saw — feeds the runtime tripwire below
  const hooks: HookBundle = {
    definitions: {
      PreToolUse: [{ matcher: [...PATH_GATE_TOOL_NAMES, "MultiEdit"].join("|"), hookCallbackIds: [HOSTLOOP_PATH_GATE_ID] }],
    },
    handle: async (id, input) => {
      if (id !== HOSTLOOP_PATH_GATE_ID) return {};
      if (typeof input?.tool_use_id === "string") pathGateFired.add(input.tool_use_id);
      // Wire-cwd cross-check: the hook payload carries input.cwd. The RESOLVER input stays the closure
      // hostCwd (faithful to production's own resolver, which uses its own cwd variable, not the wire
      // value), but a mismatch means the native spawn's cwd drifted from the gate's assumption — loud, never silent.
      if (typeof input?.cwd === "string" && input.cwd !== gateCfg.hostCwd)
        warn(`::warning:: [hostloop] path-gate cwd mismatch: wire=${input.cwd} spawner=${gateCfg.hostCwd}\n`);
      return checkHostLoopPathGate(input?.tool_name, input?.tool_input ?? {}, gateCfg);
    },
  };

  const child = spawn(agentNativeHost, nativeArgs, { cwd: hostOutputsDir, env: nativeEnv, stdio: ["pipe", "pipe", "pipe"] });

  // The VM sidecar container: bash/web_fetch's `docker exec` target. No agent inside it (the agent is
  // the native `child` above) — it runs a keep-alive command (dockerRunArgv's default when `agentArgv` is
  // omitted). Folders are bind-mounted here as REAL host paths (never copied); `.claude/skills`+
  // `.claude/projects` are the only `.claude` subpaths the VM sees (never the full dir — matching
  // production, which only mounts the full `.claude` dir for its VM-loop, not host-loop). readOnlyMountPaths
  // EXCLUDES folders (a `mode:"r"` folder is handled exclusively by extraBinds — including it too would
  // produce two `-v` flags at the same destination, a Docker "duplicate mount point" hard failure).
  const sidecarArgs = dockerRunArgv({
    network,
    lockdown: (process.env.COWORK_LOCKDOWN ?? "on") !== "off",
    sessionRoot,
    sessionHost,
    agentHost: agentVmHost,
    agentIn: "/usr/local/bin/claude", // kept bind-mounted (unused by any process) for parity/inspection; harmless
    image,
    env: {}, // NO CLAUDE_PLUGIN_ROOT — real host-loop leaves it unset in the VM; the agent self-heals via `find`
    name: containerName,
    readOnlyMountPaths: plan.mounts.filter((mt) => mt.mode === "r" && mt.kind !== "folder").map((mt) => mt.mountPath),
    extraBinds: resolveHostLoopBindMounts(plan, sessionRoot),
  });
  const sidecarChild = spawn(runner, sidecarArgs, { stdio: ["ignore", "ignore", "pipe"] });
  let sidecarStderrTail = "";
  sidecarChild.stderr?.on("data", (d) => {
    sidecarStderrTail = (sidecarStderrTail + d.toString()).slice(-4000);
  });
  const logInfra = (message: string) => {
    try {
      appendFileSync(join(outDir, "events.jsonl"), JSON.stringify({ type: "infra_error", ts: new Date().toISOString(), message }) + "\n");
    } catch {}
  };
  sidecarChild.on("error", (e) => logInfra(`hostloop VM sidecar failed to spawn: ${String(e)}`));
  sidecarChild.on("exit", (code, signal) => {
    if (code !== 0 && code !== null)
      logInfra(`hostloop VM sidecar exited unexpectedly (code=${code} signal=${signal}): ${sidecarStderrTail}`);
  });

  // Production's vmCwd is the first non-network-drive connected folder's mount name, falling back to
  // outputs — never the bare session root or bare mnt/. The harness has no network-drive detection; an
  // unmountable folder fails loud at container start instead (a documented, deliberate divergence).
  const firstFolder = plan.mounts.find((mt): mt is Mount => mt.kind === "folder");
  const execCwd = `${sessionRoot}/mnt/${firstFolder ? firstFolder.mountPath : "outputs"}`;

  // Host-routed web_fetch bypasses the sidecar proxy, so collect its egress decisions here and
  // surface them to execute.ts → result.egress, making host-loop web_fetch visible to egress assertions.
  const hostEgress: EgressEntry[] = [];
  const workspaceHandle = makeWorkspaceHandler({
    containerName,
    vmMnt: mntRoot,
    runner,
    webFetchAllow: plan.egressAllow,
    onEgress: (e) => hostEgress.push(e),
    onInfraError: logInfra,
    provenanceRef: opts.provenanceRef,
    execCwd,
  });
  const sdkMcp: { servers: string[]; handle: McpHandler } = { servers: ["workspace"], handle: workspaceHandle };
  return { child, sdkMcp, hooks, pathGateFired, containerName, hostEgress };
}

/** The staged plugin copy's host path (production-analog `installPath`): the SAME directory the
 *  sidecar's extraBinds mounts into the VM and the native `--plugin-dir` argv references. 2+ configured
 *  plugins keep the unresolvable sentinel for both consumers — a pre-existing per-plugin-hook scoping
 *  limitation, not something introduced here. */
function resolveClaudePluginRootHostPath(plan: LaunchPlan, mntHost: string): string | undefined {
  const pluginMounts = plan.mounts.filter(
    (mt) => mt.kind === "local-plugin" || mt.kind === "remote-plugin" || mt.kind === "marketplace-plugin",
  );
  if (pluginMounts.length !== 1) return undefined;
  return join(mntHost, pluginMounts[0].mountPath);
}

function hostLoopShellSection(
  baseline: PlatformBaseline,
  sessionRoot: string,
  mntRoot: string,
  plan: LaunchPlan,
  hostOutputsDir: string,
): string {
  const appVersion = baseline.appVersion;
  // Generator era (Desktop >= 1.14271.0): the section is built from live mount state, not a static
  // file. Branch BEFORE any file read so generator-era versions never hit the missing-asset throw.
  if (cmpVersionStrings(appVersion, HOSTLOOP_DYNAMIC_PROMPT_MIN_VERSION) >= 0) {
    const skillsDir = join(plan.configDir, "skills");
    const skillsPresent = existsSync(skillsDir) && readdirSync(skillsDir).length > 0;
    return generateHostLoopShellSection({
      sessionRoot,
      mntRoot,
      folders: plan.mounts.filter((m) => m.kind === "folder"),
      uploads: plan.mounts.filter((m) => m.kind === "upload"),
      skillsConfigDir: skillsPresent ? plan.configDir : undefined,
      hostOutputsDir,
    });
  }

  // Legacy era (< 1.14271.0): read the per-version static asset and substitute {{vmMnt}}.
  // The path must resolve to baselines/prompts/desktop-<appVersion>/host-loop-append.md.
  const vmMnt = mntRoot;
  const dir = fileURLToPath(new URL(`../../baselines/prompts/desktop-${appVersion}/host-loop-append.md`, import.meta.url));
  let content: string;
  try {
    content = readFileSync(dir, "utf8");
  } catch (err) {
    // A missing host-loop prompt asset is a real fidelity gap — the shell-access section would be
    // silently empty, making the run look green while missing key Cowork framing. By default this is fatal.
    // Set COWORK_HARNESS_ALLOW_MISSING_PROMPT=1 to continue with an empty section (still warns).
    if (process.env.COWORK_HARNESS_ALLOW_MISSING_PROMPT === "1") {
      warn(
        `::warning:: [hostloop] host-loop prompt asset not found at ${dir} (baseline desktop-${appVersion}) — host-loop shell section will be EMPTY. ` +
          `Run \`cowork-harness sync\` to update baselines, or set COWORK_AGENT_BINARY to a matching binary. (${String(err)})\n`,
      );
      return "";
    }
    throw new Error(`cowork-harness: missing host-loop shell prompt asset: ${dir}. Set COWORK_HARNESS_ALLOW_MISSING_PROMPT=1 to skip.`);
  }
  return stripComments(content).split("{{vmMnt}}").join(vmMnt).trim();
}
