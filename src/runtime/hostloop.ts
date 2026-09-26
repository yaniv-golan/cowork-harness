import { warn } from "../io.js";
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlatformBaseline, Scenario, InfraErrorSource } from "../types.js";
import type { LaunchPlan } from "../session.js";
import { SCRUBBED_AGENT_ENV_KEYS, pluginSkillRootsFromPlan, mountedPluginsFromPlan, isConnectedContent } from "../session.js";
import { makeSkillsHandler, SKILLS_PLUGINS_TOOL_NAMES } from "../hostloop/skills-handler.js";
import { makePluginsHandler } from "../hostloop/plugins-handler.js";
import { makeCoworkHandlerHostLoop } from "../hostloop/cowork-handler-hostloop.js";
import { listMountedSkills } from "../run/skill-metadata.js";
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
import type { WebFetchDedupCache } from "../hostloop/webfetch-dedup.js";
import { baseAgentArgs, hostNativeSpawnEnv, dockerRunArgv, proxyEnvVars } from "./argv.js";
import { runtimeAuthEnv } from "./host-env.js";
import { resolveHostLoopBindMounts, stageHostLoopWorkspace } from "./hostloop-stage.js";
import { capturePreRunManifest } from "../run/pre-run-manifest.js";
import { checkHostLoopPathGate, PATH_GATE_TOOL_NAMES, type HostLoopPathGateConfig } from "../hostloop/pretooluse-path-hook.js";
import { combineSdkMcp, type HookBundle } from "../agent/session.js";
import { hostLoopPermissionArgs, hostLoopUsesSystemEmptyCwd, resolveHostProcessCwd } from "../hostloop/process-cwd.js";
import { stripComments } from "../prompt.js";
import { resolveAgentImage, resolveContainerRuntime } from "./agent-image.js";

/** The path-gate's own PreToolUse hook callback id — exported so RunRecord.pathDenials' pretooluse
 *  producer (run.ts) and its replay reconstruction (cassette.ts) can filter to THIS gate's own
 *  decisions and exclude every other custom-hook callback the same `hook_callback` mechanism fires. */
export const HOSTLOOP_PATH_GATE_ID = "hostloop-path-gate";

/** Production's host-loop tool aliases (asar `et()`; single-hop, deny rules do NOT expand across the
 *  alias). An alias never GRANTS a tool — it resolves only when the target is already in the caller's
 *  bound set, so a bare Bash/WebFetch from a sub-agent without the workspace tool bound still fails.
 *  BOTH names are host-loop-only. The VM loop replaces web_fetch alone and never touches Bash — use
 *  `VM_LOOP_TOOL_ALIASES` there, not this map. */
export const WORKSPACE_TOOL_ALIASES: Record<string, string> = { Bash: "mcp__workspace__bash", WebFetch: "mcp__workspace__web_fetch" };

/** The VM loop's alias set: web_fetch ONLY, applied when `coworkWebFetchViaApi` is on.
 *
 *  "Bash is the only tool that truly diverges between loops" — the VM loop keeps the built-in shell and
 *  aliases only WebFetch, so aliasing Bash here would invent a tool production does not replace.
 *
 *  Without this, disallowing `WebFetch` at container is a REGRESSION rather than a fidelity fix: the
 *  built-in stops resolving and nothing catches the bare name, so a model that emits `WebFetch` hard-fails
 *  where production silently resolves it to the workspace tool. The disallow and the alias are two halves
 *  of one behaviour and must ship together. */
export const VM_LOOP_TOOL_ALIASES: Record<string, string> = { WebFetch: "mcp__workspace__web_fetch" };

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
 *
 * Layers apply in precedence order — knob > baseline spawn.env > operator env (scrubbed):
 *   1. the operator's shell (`...process.env`), but with `SCRUBBED_AGENT_ENV_KEYS` deleted from THIS
 *      layer alone, before anything else touches it — container/microvm never inherit these keys, so
 *      leaking them only here (and on protocol) is exactly the asymmetry `agent_env` closes. Scrubbing
 *      AFTER the baseline overlay would also erase a value the baseline legitimately sets; scrubbing
 *      the operator layer first keeps that value intact.
 *   2. `hostNativeSpawnEnv`'s baseline-derived output (may legitimately set any scrubbed key).
 *   3. the authored `agentEnv` knob, applied last so it always wins.
 */
export function buildHostLoopNativeEnv(
  baseline: PlatformBaseline,
  opts: Parameters<typeof hostNativeSpawnEnv>[1] & { agentEnv?: Record<string, string> },
): NodeJS.ProcessEnv {
  const nativeEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const k of SCRUBBED_AGENT_ENV_KEYS) delete nativeEnv[k];
  Object.assign(nativeEnv, hostNativeSpawnEnv(baseline, opts));
  delete nativeEnv.MAX_THINKING_TOKENS;
  Object.assign(nativeEnv, opts.agentEnv ?? {});
  return nativeEnv;
}

/** True iff wire and spawner cwd differ after best-effort realpath canonicalization. A symlinked run-dir
 *  (/tmp→/private/tmp, /var→/private/var on macOS) makes the agent's realpath'd wire cwd differ from the
 *  un-canonicalized spawner cwd even for the SAME directory — a false alarm this collapses. The gate
 *  decision is unaffected (it realpaths candidate and roots itself); this only governs the diagnostic. */
/** The host-loop cwd SPLIT, in one place because the two halves are only correct TOGETHER.
 *
 *  Production keeps them deliberately different. Measured on desktop-local Cowork 2026-08-27 (before
 *  Desktop 2.7032.0):
 *   - the agent process sits at the OUTPUTS dir, so its file tools resolve a bare `Write` there
 *     (from 2.7032.0 it sits at `/var/empty` instead and a relative Write is refused — `processCwd`);
 *   - every `mcp__workspace__bash` call starts at the bare SESSION ROOT, and bash resets its cwd
 *     between calls ("no cwd/env carryover"), so a relative shell path can never be `cd`-ed elsewhere.
 *
 *  Cowork's own sub-agent prompt states the second half: "Each command starts in `<vmCwd>`; anything
 *  written outside `<vmCwd>/mnt/` (including /tmp) stays in that environment and never reaches the user
 *  or your file tools."
 *
 *  Collapsing them — which this harness did until 2026-08-27, running bash at the outputs dir — makes a
 *  skill that writes relative paths from a script look correct here and deliver nothing in production.
 *  Keep them as one function so a future edit cannot move one and leave the other. */
export function hostLoopCwds(
  sessionRoot: string,
  hostOutputsDir: string,
  /** From Desktop 2.7032.0 the agent process runs off outputs (`/var/empty`, or a per-session dir — see
   *  `resolveHostProcessCwd`). Omitted → the older contract, where it ran at outputs. */
  processCwd?: string,
): { agentProcessCwd: string; workspaceBashCwd: string; pathResolverBase: string } {
  // `pathResolverBase` is outputs in both eras: before, because the agent ran there; from 2.7032.0,
  // because Desktop's hook re-anchors a relative Grep/Glob to outputs.
  return { agentProcessCwd: processCwd ?? hostOutputsDir, workspaceBashCwd: sessionRoot, pathResolverBase: hostOutputsDir };
}

/** The agent-process half of a host-loop spawn, as one pure-ish function the spawn calls and tests can pin:
 *  the process cwd, the argv it implies (deny rules, outputs as a working directory), and the gate's view of
 *  it. Before Desktop 2.7032.0 all three are the older contract (agent at outputs, no rules). */
export function hostLoopProcessContract(
  baseline: PlatformBaseline,
  outDir: string,
  sessionRoot: string,
  hostOutputsDir: string,
  deps: { stat?: Parameters<typeof resolveHostProcessCwd>[0]["stat"] } = {},
): {
  processCwd: string | undefined;
  permission: ReturnType<typeof hostLoopPermissionArgs> | undefined;
  cwds: ReturnType<typeof hostLoopCwds>;
} {
  const processCwd = hostLoopUsesSystemEmptyCwd(baseline)
    ? resolveHostProcessCwd({ fallbackDir: join(resolve(outDir), "work", "host-cwd"), stat: deps.stat })
    : undefined;
  const permission = processCwd !== undefined ? hostLoopPermissionArgs({ processCwd, hostOutputsDir }) : undefined;
  return { processCwd, permission, cwds: hostLoopCwds(sessionRoot, hostOutputsDir, processCwd) };
}

export function pathGateCwdMismatch(wireCwd: string, spawnerCwd: string): boolean {
  const canon = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p; // non-resolvable path still deserves the loud compare
    }
  };
  return canon(wireCwd) !== canon(spawnerCwd);
}

/**
 * Pure builder for the hostloop `present_files` containment allowlist — the harness's hostloop
 * equivalents of production's own allowed set (binary-verified: real Cowork's host-loop branch accepts
 * `[hostOutputsDir, uploads, autoMemoryDir, ...connectedFolders]`). Deliberately narrower than that full
 * set: `uploads` and `autoMemoryDir` are left out because — respectively — presenting an uploaded file
 * back out isn't the pattern this closes (write-then-present targets outputs), and auto-memory has no
 * real host directory anywhere in this harness (a dormant feature; see `vm-paths.ts`'s
 * `autoMemoryHostDir` comment) — there is nothing to point a root at. A narrower allowlist can only
 * reject a path production would accept, never the reverse, so this stays a conservative (safe) fidelity
 * gap rather than a permissive one. Extracted so the allowlist is testable without spawning a real
 * process.
 */
export function hostLoopPresentFilesRoots(hostOutputsDir: string, plan: LaunchPlan): string[] {
  return [hostOutputsDir, ...plan.mounts.filter(isConnectedContent).map((mt) => mt.hostPath)];
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
/**
 * The VM sidecar's env — bash's `docker exec` target inherits it, so this IS bash's egress
 * configuration at this tier.
 *
 * Exported so the boundary self-test can probe the SAME value the runtime spawns with. That is not
 * tidiness: this used to be built inline, a probe asserted against a hand-built env, and when the
 * native host/VM process split dropped the proxy from the real path the probe kept passing. bash then
 * had no egress at all for thirteen releases — it could reach neither allowlisted nor denied hosts —
 * while four docs advertised the allowlist as enforced here. One builder, one consumer set, or the
 * guard guards nothing.
 *
 * Deliberately proxy-only. `CLAUDE_PLUGIN_ROOT` must stay ABSENT: real host-loop leaves it unset in the
 * guest and the agent self-heals by `find`ing the mount, so a value here would re-leak a host path bash
 * cannot resolve. Nothing else belongs in this env either.
 *
 * No proxy means an empty env, not a default one. Pointing bash at a proxy that isn't there would turn
 * "no egress" into "every request fails against a bogus host" — a worse failure wearing a stranger
 * message. (Unreachable in practice: every container-like tier constructs a sidecar before spawning,
 * and a construction throw aborts the run rather than reaching this call.)
 */
export function hostLoopSidecarEnv(egressProxy?: string): Record<string, string> {
  return egressProxy ? proxyEnvVars(egressProxy) : {};
}

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
    // coworkWebFetchViaApi (readGateFlag, execute.ts/chat.ts) — when on, web_fetch is gated through
    // can_use_tool (production shape: bash pre-approved, web_fetch is not) instead of pre-approved
    // alongside bash (the allowlist-fallback shape, gate off).
    webFetchViaApi?: boolean;
    /** coworkWebFetchDedup per-session cache (execute.ts/chat.ts build it only when the gate is on). */
    dedup?: WebFetchDedupCache;
    /** Resolved gate 245679952 (execute.ts/chat.ts — readGateBool ▸ session knob ▸ default true). Gates
     *  the `skills` server's `suggest_skills` tool (see hostloop/skills-handler.ts). */
    suggestSkillsEnabled?: boolean;
    /** Resolved proactive suggest mode (`resolveSkillDiscoveryGates`: session knob ▸ for a baseline from
     *  1.46388.3, always true — Desktop reads no gate there ▸ for an older baseline gate 1598976391, on from
     *  1.24012.11, false when absent). Only consulted when `suggestSkillsEnabled` is true. */
    proactiveSkillSuggestEnabled?: boolean;
  } = {},
) {
  const m = resolveMounts(baseline, sessionId, "proj1");
  const sessionRoot = m.cwd;
  const mntRoot = m.mntRoot;
  // Name by the per-invocation runToken (NOT sessionId) so a --resume after a failed run doesn't collide
  // on a leftover same-named container. cwd/work dir stay keyed by sessionId (stable for resume).
  const containerName = `cowork-hl-${opts.runToken ?? sessionId}`;
  // Always supplied by the caller (see container.ts for why the removed env-var branch was unreachable).
  const network = opts.dockerNetwork ?? "cowork-net";

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
  // Bind-mounted into the bash sidecar for parity; not run by any harness-spawned process here (sidecar CMD
  // is a keep-alive, bash is `docker exec … sh -c`, the executed agent is agentNativeHost above — model bash
  // could invoke it inside the hardened sidecar, an accepted patch-only residual). So tolerate a patch-newer
  // VM ELF when the pin was pruned by a Desktop update, instead of hard-failing a run that doesn't execute it.
  const agentVmHost = resolveAgentBinary(baseline, { parityMount: true });
  const image = resolveAgentImage();
  const runner = resolveContainerRuntime();

  // Host-loop deltas: native Bash/WebFetch/NotebookEdit OFF (shell goes through the workspace
  // SDK-MCP server — driver handles mcp_message), the workspace tools pre-approved, the
  // Shell-access prompt section. Host-loop excludes the asar's HOST_LOOP_EXCLUDED_BUILTIN_TOOLS =
  // {Bash, PowerShell, NotebookEdit, REPL, JavaScript, WebFetch} (PowerShell joined at Desktop
  // 1.24012.9). REPL/JavaScript are not in the CLI agent's registry at all; PowerShell IS, but it is
  // win32-gated and never registers on the macOS/Linux runtimes this harness targets. So the three
  // that can actually register here are Bash/NotebookEdit/WebFetch, and disallowing them is the
  // faithful set. Adding PowerShell here would be a no-op today — and would need revisiting only if
  // this harness ever grows a Windows runtime (the sync extractor's Windows paths are still TODO).
  const hostOutputsDir = join(mntHost, "outputs");
  // From Desktop 2.7032.0 the agent process runs OFF outputs, with deny rules for that directory and
  // outputs added back as a working directory (see src/hostloop/process-cwd.ts). The fallback dir is per
  // run and outside `sessionHost`, which the bash sidecar mounts — Desktop's equivalent is not VM-visible.
  // `outDir` is stable across a resume, so both turns run at the same cwd (the agent keys its transcript
  // on it).
  const { processCwd, permission, cwds } = hostLoopProcessContract(baseline, outDir, sessionRoot, hostOutputsDir);
  // `lane: remote` serves no cowork server, so the tool must not be advertised or pre-approved either:
  // a registered tool with no backing server is a phantom capability the model can try and fail to use.
  const coworkTools = plan.lane === "remote" ? [] : ["mcp__cowork__present_files"];
  // Hoisted from the path-gate config below: the SAME staged dir is both the Read-allowed uploads root
  // and the uploads bullet's file-tool path — one value, so the prompt and the gate can never disagree.
  const uploadsRoot = join(mntHost, "uploads");
  const systemPromptAppend = [
    opts.systemPromptAppend,
    hostLoopShellSection(baseline, m.sessionRoot, mntRoot, plan, hostOutputsDir, uploadsRoot),
  ]
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
    disallowed: ["Bash", "WebFetch", "NotebookEdit", ...(permission?.disallowed ?? [])],
    ...(permission ? { extraArgs: permission.extraArgs } : {}),
    // The 5 skills/plugins discovery tools declare + pre-approve on the SAME cowork lane as workspace's
    // own bash/web_fetch (spec §3: `isEnabled` = `sessionType==="cowork"`, which hostloop satisfies).
    // bash + web_fetch are both REGISTERED regardless of the webFetchViaApi gate; the 5 discovery tools
    // are unconditional. `present_files` joins them unconditionally too — real Cowork registers it
    // `alwaysLoad` with no session-type/connected-folder gate (F2 in the closure plan) — and it MUST also
    // be in extraAllowedTools: alwaysLoad alone is not sufficient pre-approval (the same off-registry
    // auto-allow reasoning `spawnContainer` already documents for its own present_files pre-approval).
    extraTools: ["mcp__workspace__bash", "mcp__workspace__web_fetch", ...coworkTools, ...SKILLS_PLUGINS_TOOL_NAMES],
    extraAllowedTools: opts.webFetchViaApi
      ? // web_fetch is gated via can_use_tool (production shape) — pre-approve bash + present_files + the discovery tools only
        ["mcp__workspace__bash", ...coworkTools, ...SKILLS_PLUGINS_TOOL_NAMES]
      : // gate off (allowlist fallback) — keep web_fetch pre-approved alongside bash + present_files + the discovery tools
        ["mcp__workspace__bash", "mcp__workspace__web_fetch", ...coworkTools, ...SKILLS_PLUGINS_TOOL_NAMES],
  });
  const nativeEnv = buildHostLoopNativeEnv(baseline, {
    configDir: plan.configDir,
    extra: { CLAUDE_PLUGIN_ROOT: claudePluginRootHost ?? "", ...runtimeAuthEnv() },
    // Real host paths of connected folders (never staged copies) — the only spawn tier where these
    // are meaningful, since container/microvm folders are staged as copies with no real host path.
    folderHostPaths: plan.mounts.filter((mt) => mt.kind === "folder").map((mt) => mt.hostPath),
    // The tier-uniform agent_env knob — wins over both the (scrubbed) operator layer and baseline spawn.env.
    agentEnv: plan.agentEnv,
  });

  // The PreToolUse path-containment gate config. hostCwd = the harness-owned outputs dir (production's
  // `hostCwd = getOutputsDir(e)`), the base a relative path resolves against in both eras;
  // scratchRoots = [hostCwd] (production's writable set is `[outputs]` from 2.7032.0, and was two names for
  // the same dir before it).
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
    ...(permission ? { processCwdSpellings: permission.cwdSpellings } : {}),
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
      if (typeof input?.cwd === "string" && pathGateCwdMismatch(input.cwd, cwds.agentProcessCwd))
        warn(`::warning:: [hostloop] path-gate cwd mismatch: wire=${input.cwd} spawner=${cwds.agentProcessCwd}\n`);
      return checkHostLoopPathGate(input?.tool_name, input?.tool_input ?? {}, gateCfg);
    },
  };

  const child = spawn(agentNativeHost, nativeArgs, {
    cwd: cwds.agentProcessCwd,
    env: nativeEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });

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
    agentIn: "/usr/local/bin/claude", // kept bind-mounted for parity/inspection; not run by any harness-spawned process (reachable only by model bash in the hardened sidecar, an accepted patch-only residual)
    image,
    // bash's egress config — `docker exec` inherits the container's env, so these reach every bash call.
    // Still NO CLAUDE_PLUGIN_ROOT: real host-loop leaves it unset in the VM and the agent self-heals via
    // `find`. See hostLoopSidecarEnv for why this must not be built inline.
    env: hostLoopSidecarEnv(opts.egressProxy),
    name: containerName,
    readOnlyMountPaths: plan.mounts.filter((mt) => mt.mode === "r" && mt.kind !== "folder").map((mt) => mt.mountPath),
    extraBinds: resolveHostLoopBindMounts(plan, sessionRoot),
  });
  const sidecarChild = spawn(runner, sidecarArgs, { stdio: ["ignore", "ignore", "pipe"] });
  // Two emitters, not one: this sidecar DYING and a single `docker exec` FAILING are different events with
  // different blast radii, and collapsing them into one sink made every failed exec contaminate the whole
  // run. Both still append the out-of-band `infra_error` row to events.jsonl (so a cassette recorded from
  // this run carries it — parseMessage's "infra_error" case re-derives it on replay), but a LIVE drive
  // never re-reads that file — `AgentSession` only yields events parsed from the agent's own stdout, which
  // can never carry a harness-appended row. `infraErrors` is the second half: the shared sink
  // executeScenario/chat fold into the live RunRecord after teardown, mirroring the egress sidecar's own
  // `fatalError` pattern (src/egress/sidecar.ts) so a genuine sidecar crash still hard-fails the verdict.
  const infraErrors: { source: InfraErrorSource; message: string }[] = [];
  const { logSidecarInfra, logExecInfra } = makeInfraEmitters(outDir, infraErrors);
  const { markTearingDown } = watchHostLoopSidecar(sidecarChild, logSidecarInfra);

  // Every `mcp__workspace__bash` call starts at the bare SESSION ROOT — not a connected folder, not
  // outputs. MEASURED on desktop-local Cowork 2026-08-27, twice: `pwd` returned `/sessions/<id>` with no
  // folder connected AND with one connected. Cowork's own sub-agent prompt says the same thing: "Each
  // command starts in `<vmCwd>`; anything written outside `<vmCwd>/mnt/` (including /tmp) stays in that
  // environment and never reaches the user or your file tools."
  //
  // This REPLACES a `${sessionRoot}/mnt/${firstFolder ?? "outputs"}` derivation whose comment claimed
  // production's vmCwd was the first connected folder "never the bare session root". That claim came from
  // the asar's `cwd: c.vmCwd` spawn argument, which is NOT load-bearing on the cowork path — only the
  // `chat` branch prepends an explicit `cd ${vmCwd}`, which would be redundant if the argument worked.
  // The old value was never faithful: it reproduced a prompt claim rather than an observed behaviour.
  //
  // It is deliberately NOT the agent-process cwd (outputs before Desktop 2.7032.0, `/var/empty` from it —
  // `cwds.agentProcessCwd` above), while the SHELL sits at the session root. Production keeps those two values
  // different on purpose; collapsing them is the bug this replaces. Both are pinned together in
  // test/baseline.test.ts — a single-value assertion cannot express the split.
  const execCwd = cwds.workspaceBashCwd;

  // Host-routed web_fetch bypasses the sidecar proxy, so collect its egress decisions here and
  // surface them to execute.ts → result.egress, making host-loop web_fetch visible to egress assertions.
  const hostEgress: EgressEntry[] = [];
  const workspaceHandle = makeWorkspaceHandler({
    containerName,
    vmMnt: mntRoot,
    runner,
    webFetchAllow: plan.egressAllow,
    onEgress: (e) => hostEgress.push(e),
    onInfraError: logExecInfra,
    provenanceRef: opts.provenanceRef,
    dedup: opts.dedup,
    execCwd,
  });
  const workspaceBundle: { servers: string[]; handle: McpHandler } = { servers: ["workspace"], handle: workspaceHandle };
  // Toolset parity with production (F2/F3 in the closure plan: production's `present_files` is
  // `alwaysLoad` unconditionally, and production RUNS host-loop mode) — see `hostLoopPresentFilesRoots`'s
  // own doc comment for the allowlist rationale. Server name "cowork" matches the container tier's own
  // bundle (`spawnContainer`) so the tool's full name is the SAME `mcp__cowork__present_files` on both
  // tiers — required for the shared `present_files_called`/`no_scratchpad_leak` telemetry pipeline
  // (`Run.notePresentedFiles`, `src/run/run.ts`) to recognize the call at all.
  // `lane: remote` withholds present_files entirely — a local MCP server cannot reach a remote Cowork
  // session, so a remote agent genuinely does not have this tool. Serving it would hand the model a
  // capability production lacks, greening a skill that then fails there.
  const coworkBundle: { servers: string[]; handle: McpHandler } | undefined =
    plan.lane === "remote"
      ? undefined
      : {
          servers: ["cowork"],
          handle: makeCoworkHandlerHostLoop({ allowedRoots: hostLoopPresentFilesRoots(hostOutputsDir, plan) }),
        };
  // Deterministic, run-derived catalogs for the discovery stubs — read straight off the ALREADY-staged
  // configDir/skills + plugin mounts (buildLaunchPlan materializes both before spawn), never a live call.
  const mountedSkills = listMountedSkills(plan.configDir, pluginSkillRootsFromPlan(plan));
  const mountedPlugins = mountedPluginsFromPlan(plan);
  const skillsBundle: { servers: string[]; handle: McpHandler } = {
    servers: ["skills"],
    handle: makeSkillsHandler({
      mountedSkills,
      mountedPluginNames: mountedPlugins.map((p) => p.pluginName),
      suggestSkillsEnabled: opts.suggestSkillsEnabled ?? true,
      proactiveSkillSuggestEnabled: opts.proactiveSkillSuggestEnabled ?? false,
    }),
  };
  const pluginsBundle: { servers: string[]; handle: McpHandler } = {
    servers: ["plugins"],
    handle: makePluginsHandler({ mountedPlugins }),
  };
  const sdkMcp = combineSdkMcp(workspaceBundle, ...(coworkBundle ? [coworkBundle] : []), skillsBundle, pluginsBundle);
  // `sessionRoot` here is the HOST tree (`sessionHost`), not the VM path: the agent runs natively on the
  // host at this tier, so the paths
  // it reports — and the ones its present_files handler validates — are host paths. Returned for the same
  // reason as container's: the caller must not re-derive it.
  // `agentProcessCwd` is returned only when it is deliberately outside the session tree, so the run's
  // present_files space check can accept that one cwd (see `Run.setExpectedAgentCwd`).
  return {
    child,
    sdkMcp,
    hooks,
    pathGateFired,
    containerName,
    hostEgress,
    infraErrors,
    markTearingDown,
    sessionRoot: sessionHost,
    ...(processCwd !== undefined ? { agentProcessCwd: processCwd } : {}),
  };
}

/** The two infra-error emitters a host-loop run needs, sharing one sink and one events.jsonl writer.
 *  Every row carries its `source` so the verdict can tell a dead supervisor apart from a failed command,
 *  and so the replay re-drive can reconstruct the same distinction from the frozen events. */
export function makeInfraEmitters(outDir: string, sink: Array<{ source: InfraErrorSource; message: string }>) {
  const emit = (source: InfraErrorSource) => (message: string) => {
    try {
      appendFileSync(
        join(outDir, "events.jsonl"),
        JSON.stringify({ type: "infra_error", ts: new Date().toISOString(), source, message }) + "\n",
      );
    } catch {}
    sink.push({ source, message });
  };
  return { logSidecarInfra: emit("hostloop-sidecar"), logExecInfra: emit("hostloop-exec") };
}

/** Minimal child-process shape {@link watchHostLoopSidecar} needs (a subset of node:child_process's
 *  `ChildProcess`) — parameterized so tests can drive it with a plain `EventEmitter`-backed fake instead
 *  of a real spawn. */
export interface SidecarWatchTarget {
  stderr?: { on(event: "data", listener: (chunk: Buffer) => void): unknown } | null;
  on(event: "error", listener: (err: unknown) => void): unknown;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

/**
 * Watches the host-loop VM sidecar's child process (the foreground `docker run` for the `sleep infinity`
 * keep-alive container — see `dockerRunArgv`) and routes any infrastructure failure through `logInfra`.
 * The container is a keep-alive: it never exits on its own, so for the DURATION OF A RUN any exit —
 * whatever the code, whatever the signal — is a genuine crash (this is what fixes the prior blind spot:
 * a signal-killed child reports `code === null` exactly like a clean-looking exit, so code alone can't
 * tell an OOM kill from nothing happening).
 *
 * The one exit this function must NOT report is this harness's OWN teardown: `execute.ts`'s/`chat.ts`'s
 * finally block force-removes the sidecar container (`docker rm -f`) on every run, success or failure,
 * which makes this same child exit too. Call the returned `markTearingDown()` immediately before that
 * removal (both the normal finally path and the Ctrl-C cleanup path) so the resulting exit is recognized
 * as intentional shutdown rather than reported as a mid-run infra error — a naive fix that skips this
 * would red every hostloop run.
 */
export function watchHostLoopSidecar(
  sidecarChild: SidecarWatchTarget,
  logInfra: (message: string) => void,
): { markTearingDown: () => void } {
  let tearingDown = false;
  let stderrTail = "";
  sidecarChild.stderr?.on("data", (d: Buffer) => {
    stderrTail = (stderrTail + d.toString()).slice(-4000);
  });
  sidecarChild.on("error", (e) => {
    if (!tearingDown) logInfra(`hostloop VM sidecar failed to spawn: ${String(e)}`);
  });
  sidecarChild.on("exit", (code, signal) => {
    if (tearingDown) return;
    logInfra(`hostloop VM sidecar exited unexpectedly (code=${code} signal=${signal}): ${stderrTail}`);
  });
  return { markTearingDown: () => (tearingDown = true) };
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
  hostUploadsDir: string,
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
      hostUploadsDir,
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
