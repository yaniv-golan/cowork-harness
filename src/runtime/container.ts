import { spawn } from "node:child_process";
import { artifactsRootEnv } from "../answer-channel.js";
import { resolve, join } from "node:path";
import type { PlatformBaseline, Scenario } from "../types.js";
import { type LaunchPlan, pluginSkillRootsFromPlan, mountedPluginsFromPlan, isConnectedContent } from "../session.js";
import { resolveMounts, resolveAgentBinary } from "../baseline.js";
import { agentArgs, spawnEnv, dockerRunArgv } from "./argv.js";
import { runtimeAuthEnv } from "./host-env.js";
import { stageWorkspace } from "./stage.js";
import { capturePreRunManifest } from "../run/pre-run-manifest.js";
import { captureInputHostPathCorpus } from "../run/input-host-paths.js";
import { makeCoworkHandler } from "../hostloop/cowork-handler.js";
import { makeSkillsHandler, SKILLS_PLUGINS_TOOL_NAMES } from "../hostloop/skills-handler.js";
import { makePluginsHandler } from "../hostloop/plugins-handler.js";
import { makeWorkspaceHandler, type WebFetchProvenance, type EgressEntry } from "../hostloop/workspace-handler.js";
import type { WebFetchDedupCache } from "../hostloop/webfetch-dedup.js";
import { combineSdkMcp } from "../agent/session.js";
import { listMountedSkills } from "../run/skill-metadata.js";
import type { McpHandler } from "../hostloop/workspace-handler.js";
import { resolveAgentImage, resolveContainerRuntime } from "./agent-image.js";

/** The VM loop's web_fetch surface, as three coupled answers derived from ONE gate reading.
 *
 *  Exported and pure because the bug this prevents lives at the CALL SITE, not in any one value: the
 *  three parts (advertise, do-not-pre-approve, disallow the built-in) are only correct together, and
 *  each can be dropped independently without any other test noticing. An adversarial review deleted the
 *  disallow and the alias and the entire suite still passed.
 *
 *  - `advertised`   — the workspace tool the model can see.
 *  - `preApproved`  — deliberately EMPTY. Production gates web_fetch at can_use_tool (its VM-loop
 *                     registration passes the same approval hook the host loop does), so pre-approving
 *                     would make a scripted `webfetch:<domain>` answer and `decide: deny` silently inert.
 *  - `disallowed`   — the built-in name production removes. Ships with the alias in execute.ts; without
 *                     that alias a bare `WebFetch` resolves onto nothing instead of the workspace tool. */
export function vmLoopWebFetchSurface(webFetchViaApi: boolean): { advertised: string[]; preApproved: string[]; disallowed: string[] } {
  if (!webFetchViaApi) return { advertised: [], preApproved: [], disallowed: [] };
  return { advertised: ["mcp__workspace__web_fetch"], preApproved: [], disallowed: ["WebFetch"] };
}

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
  opts: {
    systemPromptAppend?: string;
    egressProxy?: string;
    dockerNetwork?: string;
    runToken?: string;
    /** Resolved gate 245679952 (execute.ts/chat.ts — readGateBool ▸ session knob ▸ default true). Gates
     *  the `skills` server's `suggest_skills` tool (see hostloop/skills-handler.ts). */
    suggestSkillsEnabled?: boolean;
    /** Resolved proactive suggest mode (`resolveSkillDiscoveryGates`: session knob ▸ for a baseline from
     *  1.46388.3, always true — Desktop reads no gate there ▸ for an older baseline gate 1598976391, on from
     *  1.24012.11, false when absent). Only consulted when `suggestSkillsEnabled` is true. */
    proactiveSkillSuggestEnabled?: boolean;
    /** Resolved gate 1978029737 ▸ `coworkWebFetchViaApi` (execute.ts). When ON, production's VM-LOOP site
     *  registers a workspace server exposing **web_fetch only**, disallows the built-in `WebFetch`, and
     *  aliases the name to `mcp__workspace__web_fetch`. It does NOT touch Bash — that replacement lives in
     *  the host-loop patch, which is why this tier keeps the built-in shell. Production's own default for
     *  this flag is FALSE, so it is passed explicitly rather than defaulted here. */
    webFetchViaApi?: boolean;
    /** web_fetch plumbing, mirroring the host-loop wiring so the two tiers cannot drift apart. */
    provenanceRef?: { current?: WebFetchProvenance };
    dedup?: WebFetchDedupCache;
    onEgress?: (entry: EgressEntry) => void;
  } = {},
) {
  const m = resolveMounts(baseline, sessionId, "proj1");
  // BIND TARGET (and the anchor for every guest path), vs the agent's working dir. Equal on every synced
  // baseline; kept distinct because production's cwd is a folder mount or `outputs`, not the session root.
  const sessionRoot = m.sessionRoot; // /sessions/<id>
  const agentCwd = m.cwd;
  const mntRoot = m.mntRoot; // <sessionRoot>/mnt — the tree stageWorkspace creates
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
  // One guest tree serves the file tools and bash alike: both fixture tokens get the bind target.
  const { mcpStaged } = stageWorkspace(plan, mntHost, { sessionRoot, vmSessionRoot: sessionRoot });
  // no_unexpected_files baseline: snapshot the user-visible roots' paths post-staging, pre-spawn.
  capturePreRunManifest(plan, mntHost, outDir, "container");
  // Host-path tokens in the user's staged inputs, so the post-run host_path_leak scan can tell a path the
  // user supplied from one the sandbox leaked. First turn only (a no-op on resume).
  captureInputHostPathCorpus(plan, mntHost, outDir);
  const mcpGuest = mcpStaged ? `${configGuest}/mcp.json` : undefined;

  const agentHost = resolveAgentBinary(baseline);
  const image = resolveAgentImage();
  // Both are always supplied by the caller: every container-like tier stands up a sidecar before
  // spawning, and a construction throw aborts the run rather than reaching here. The literal defaults
  // remain only as a total-function guard for a hand-constructed call, and match docker/compose.yml's
  // service names so a direct-compose rig still resolves.
  //
  // Each of these once had an env-var fallback wedged in front of the default, advertised in README as a
  // working override. Neither could ever execute, because the explicit value is never absent. They were
  // deleted rather than wired up at the sidecar: redirecting a run at a proxy the harness did not start
  // would silently move the very boundary `boundary-check` exists to prove.
  const proxyHost = opts.egressProxy ?? "http://egress-proxy:8080";
  const network = opts.dockerNetwork ?? "cowork-net";
  const runner = resolveContainerRuntime();

  // NOTE: local marketplaces are resolved to --plugin-dir in buildLaunchPlan (the in-VM
  // agent loads via --plugin-dir; the `claude plugin marketplace add` registry is inert
  // in cowork mode — SPEC §6). No pre-registration step needed.

  const env = spawnEnv(baseline, {
    configGuest,
    proxyHost,
    // The tier-uniform agent_env knob rides in via `extra`, which spawnEnv applies LAST — no scrub
    // needed here: the container's env is a constructed allowlist, never the operator's shell.
    extra: { ...runtimeAuthEnv(), ...plan.agentEnv, ...artifactsRootEnv(plan.artifactsRoot, `${mntRoot}/outputs`) },
  });
  // `lane: remote` serves no cowork server, so the tool must not be advertised or pre-approved either:
  // a registered tool with no backing server is a phantom capability the model can try and fail to use.
  const coworkTools = plan.lane === "remote" ? [] : ["mcp__cowork__present_files"];
  // Mirror production's VM-loop web_fetch swap: the built-in name goes away and the workspace tool takes
  // its place. ADVERTISED but deliberately NOT pre-approved — production's VM-loop registration passes
  // the same `requestWebFetchApproval` hook the host loop does, so the call is gated at can_use_tool.
  // `spawnHostLoop` splits extraTools/extraAllowedTools for exactly this reason; pre-approving here
  // would make a scripted `webfetch:<domain>` answer, and a `decide: deny` on it, silently inert.
  const { advertised: webFetchTools, disallowed: webFetchDisallowed } = vmLoopWebFetchSurface(!!opts.webFetchViaApi);
  const claudeArgs = agentArgs(baseline, plan, {
    mntRoot,
    systemPromptAppend: opts.systemPromptAppend,
    mcpGuest,
    // present_files must be a known, pre-approved cowork tool — otherwise the agent's first call gets
    // auto-allowed as OFF-REGISTRY, tripping the cowork-parity permissive-auto-allow guard and failing
    // the run (confirmed live against a real container spawn before this was added). extraAllowedTools
    // is stated explicitly (no hidden extraTools→allowedTools coupling), keeping this tier's
    // CURRENT pre-approval set unchanged.
    // The 5 skills/plugins discovery tools are declared on the SAME cowork lane as present_files (spec
    // §3: `isEnabled` = `sessionType==="cowork"`, which container satisfies) — pre-approved for the same
    // off-registry-auto-allow reason present_files is.
    disallowed: webFetchDisallowed,
    extraTools: [...coworkTools, ...webFetchTools, ...SKILLS_PLUGINS_TOOL_NAMES],
    // web_fetch is absent here ON PURPOSE — see webFetchTools above. It is the one registered tool this
    // tier does not pre-approve, because production gates it at can_use_tool.
    extraAllowedTools: [...coworkTools, ...SKILLS_PLUGINS_TOOL_NAMES],
  });
  const dockerArgs = dockerRunArgv({
    network,
    lockdown: (process.env.COWORK_LOCKDOWN ?? "on") !== "off",
    name: containerName,
    sessionRoot,
    agentCwd,
    sessionHost,
    agentHost,
    agentIn: AGENT_IN,
    image,
    env,
    agentArgv: claudeArgs,
    readOnlyMountPaths: plan.mounts.filter((m) => m.mode === "r").map((m) => m.mountPath), // enforce mode:r as :ro binds
  });

  const child = spawn(runner, dockerArgs, { stdio: ["pipe", "pipe", "pipe"] });
  // `lane: remote` withholds present_files entirely: a local MCP server cannot reach a remote Cowork
  // session (Anthropic's architecture doc — "local MCP servers don't run in remote sessions"), so a
  // remote agent genuinely does not have this tool. Serving it would hand the model a capability
  // production lacks, greening a skill that then fails there — the inverse of this harness's purpose.
  const coworkBundle: { servers: string[]; handle: McpHandler } | undefined =
    plan.lane === "remote"
      ? undefined
      : {
          servers: ["cowork"],
          handle: makeCoworkHandler({
            sessionRootVm: sessionRoot,
            sessionHostDir: sessionHost,
            outputsHostDir,
            folderMounts: plan.mounts.filter(isConnectedContent).map((m) => m.mountPath), // present_files roots: a project path is real and mounted
          }),
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
  // VM-LOOP web_fetch. Production's non-host-loop site, gated on `coworkWebFetchViaApi`, registers a
  // workspace server exposing **web_fetch only**, disallows the built-in `WebFetch`, and aliases the name.
  // Bash is deliberately untouched here — that replacement is host-loop-only, which is why this tier keeps
  // the built-in shell. `containerName` is supplied because the handler's type wants it; the web_fetch
  // path never execs into the container.
  const workspaceBundle = opts.webFetchViaApi
    ? {
        servers: ["workspace"],
        handle: makeWorkspaceHandler({
          containerName,
          vmMnt: `${sessionRoot}/mnt`,
          provenanceRef: opts.provenanceRef,
          dedup: opts.dedup,
          onEgress: opts.onEgress,
          // MUST be passed. The handler defaults this to ["*"], and compile(["*"]) is `() => true` — so
          // omitting it hands the tier an UNRESTRICTED fetcher that runs in the harness's own Node
          // process, outside the container network namespace and therefore invisible to the sidecar
          // proxy. That silently voids this tier's default-deny egress promise for this one tool.
          webFetchAllow: plan.egressAllow,
          tools: ["web_fetch"],
        }),
      }
    : undefined;
  const sdkMcp = combineSdkMcp(
    ...(workspaceBundle ? [workspaceBundle] : []),
    ...(coworkBundle ? [coworkBundle] : []),
    skillsBundle,
    pluginsBundle,
  );
  // `sessionRoot` is the VM path the agent sees (`-w` above, and the cowork handler's own
  // `sessionRootVm`). Returned so the caller classifies present_files against the root THIS spawn used,
  // instead of re-deriving one — the two lived in different path spaces (host vs VM) once, which made
  // every container leak read as `leaked: false`.
  return { child, containerName, sdkMcp, sessionRoot };
}
