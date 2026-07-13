import type { PlatformBaseline } from "../types.js";
import { DEFAULT_MAX_THINKING_TOKENS } from "../types.js";
import type { LaunchPlan } from "../session.js";
import { SECRET_ENV_KEYS } from "./host-env.js";

/**
 * Pure contract layer — builds the agent CLI args, the spawn env, and the full
 * docker/limactl argv from resolved inputs, with NO side effects (no spawn, no fs,
 * no process.env reads). This is what the golden snapshot tests assert against the
 * SPEC (SPEC.md §3). The runtime modules stage fs + spawn around these.
 */

export interface AgentArgsOpts {
  mntRoot: string;
  systemPromptAppend?: string;
  mcpGuest?: string;
  disallowed?: string[]; // e.g. ["Bash","WebFetch"] for host-loop
  extraTools?: string[]; // e.g. mcp__workspace__bash — appended to --tools (registration)
  // Deliberately NOT defaulted from extraTools: registering a tool and pre-approving it
  // session-wide are different decisions, so each caller states its pre-approval set explicitly —
  // appended to --allowedTools ONLY. e.g. host-loop pre-approves bash but gates web_fetch through
  // can_use_tool, so the two lists diverge.
  extraAllowedTools?: string[];
}

/**
 * The agent CLI args WITHOUT the leading `claude` token (the microvm exec appends it separately
 * in the lima argv). The single source for the flag set + order; `agentArgs` (container/hostloop) and
 * `microvmAgentArgs` both delegate here so the two can never drift again (a past divergence dropped
 * `--max-thinking-tokens` from the microvm path). `mntRoot` differs per tier; disallowed/extraTools are
 * container/hostloop-only (the microvm passes neither).
 */
export function baseAgentArgs(
  baseline: PlatformBaseline,
  plan: LaunchPlan,
  opts: {
    mntRoot: string;
    mcpGuest?: string;
    systemPromptAppend?: string;
    disallowed?: string[];
    extraTools?: string[];
    extraAllowedTools?: string[];
  },
): string[] {
  const spawn = baseline.spawn;
  // Real Cowork ALWAYS emits `--effort`, for every model class (picker, no-picker, regex-default,
  // unknown) — falling back to the baseline's synced medium default when the session left it unset
  // (per-model validation of an EXPLICIT value already ran in buildLaunchPlan's validateEffort; the
  // trailing "medium" only guards a baseline synced before `spawn.effortDefault` existed).
  const effort = plan.effort ?? spawn?.effortDefault ?? "medium";
  const tools = [...(spawn?.tools ?? []).filter(notIn(opts.disallowed)), ...(opts.extraTools ?? [])];
  // extraAllowedTools is deliberately NOT defaulted from extraTools: registering a tool and
  // pre-approving it session-wide are different decisions, so each caller states its pre-approval set
  // explicitly (no hidden coupling). Callers keep their CURRENT sets — behavior is unchanged except
  // where a caller opts into the split (host-loop's web_fetch gate).
  const allowed = [...(spawn?.allowedTools ?? []).filter(notIn(opts.disallowed)), ...(opts.extraAllowedTools ?? [])];
  return [
    "-p",
    "--verbose",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--permission-prompt-tool",
    "stdio",
    "--permission-mode",
    // The session's permission_mode (threaded onto plan.permissionMode) must win at L1/L2 too — L0
    // already honors it. Without this, agentArgs hard-wired the baseline default and a session asking
    // for acceptEdits/bypassPermissions was silently ignored in every sandbox tier.
    plan.permissionMode ?? spawn?.permissionMode ?? "default",
    "--setting-sources",
    (spawn?.settingSources ?? ["user"]).join(","),
    "--effort",
    effort,
    // Extended thinking — a CLI FLAG ONLY (real Cowork sets no MAX_THINKING_TOKENS env; the SDK option
    // maps straight to the flag). `debugMaxThinkingTokens` (the fenced, non-Cowork escape hatch) ALWAYS
    // wins when set; otherwise the boolean resolves to the fixed 31999-or-disabled budget, matching
    // Cowork's own "no arbitrary N" invariant. Kept among the FIXED flags so the variadic
    // --tools/--allowedTools stay last (golden invariant).
    ...thinkingArgs(plan.extendedThinking, plan.debugMaxThinkingTokens),
    // Fenced, non-Cowork `debug.thinking_display` → `--thinking-display <mode>` (real Cowork passes none,
    // so this is emitted ONLY when the escape hatch is set; default omits it → byte-identical argv).
    ...(plan.debugThinkingDisplay ? ["--thinking-display", plan.debugThinkingDisplay] : []),
    // Agent turn budget — emitted ONLY when the session opts in (`agent_max_turns`). Omitted by default so
    // the agent inherits its own turn ceiling (fidelity: real Cowork passes no --max-turns for interactive
    // sessions). The flag is verified supported by the staged agent binary.
    ...(plan.agentMaxTurns !== undefined ? ["--max-turns", String(plan.agentMaxTurns)] : []),
    ...(opts.disallowed?.length ? ["--disallowedTools", ...opts.disallowed] : []),
    ...(opts.systemPromptAppend ? ["--append-system-prompt", opts.systemPromptAppend] : []),
    ...(plan.model ? ["--model", plan.model] : []),
    ...(opts.mcpGuest ? ["--mcp-config", opts.mcpGuest] : []),
    // Session persistence: pin the agent's native session id (so we can resume it), or resume a prior
    // one. Only emitted when a stable session was requested — default omits both → goldens unchanged.
    ...(plan.agentSessionId ? (plan.resume ? ["--resume", plan.agentSessionId] : ["--session-id", plan.agentSessionId]) : []),
    ...plan.pluginDirs.flatMap((p) => ["--plugin-dir", `${opts.mntRoot}/${p}`]),
    // variadic flags LAST so they don't swallow other options
    ...(tools.length ? ["--tools", ...tools] : []),
    ...(allowed.length ? ["--allowedTools", ...allowed] : []),
  ];
}

/** The full `claude …` args (container/hostloop): the shared base prefixed with the binary token. */
export function agentArgs(baseline: PlatformBaseline, plan: LaunchPlan, opts: AgentArgsOpts): string[] {
  return [
    "claude",
    ...baseAgentArgs(baseline, plan, {
      mntRoot: opts.mntRoot,
      mcpGuest: opts.mcpGuest,
      systemPromptAppend: opts.systemPromptAppend,
      disallowed: opts.disallowed,
      extraTools: opts.extraTools,
      extraAllowedTools: opts.extraAllowedTools,
    }),
  ];
}

/**
 * Resolve the extended-thinking CLI flag(s) — faithful port of Cowork's boolean resolver (binary-verified,
 * app.asar 1.19367.0: `zgi(e,t,r){return e ?? t ?? !r ? NX : 0}`; re-verified 1.20186.0, where the same
 * resolver is `Ua(r,e,t){return r??e??!t?o.DEFAULT_MAX_THINKING_TOKENS:0}` — helper renamed and the const
 * hoisted behind the `DEFAULT_MAX_THINKING_TOKENS` export alias `x7e`, value unchanged) (`NX` /
 * `x7e` = `DEFAULT_MAX_THINKING_TOKENS` = 31999) → the SDK maps a 0 budget to `{type:"disabled"}` and a positive one to
 * `{type:"enabled",budgetTokens:N}`, which become `--thinking disabled` / `--max-thinking-tokens <N>`.
 * There is no arbitrary N in real Cowork — `debugOverride` (the fenced, non-Cowork `debug.max_thinking_tokens`
 * escape hatch) is the ONLY way this harness emits one, and it ALWAYS wins over `extendedThinking` when set.
 */
export function thinkingArgs(extendedThinking: boolean | undefined, debugOverride: number | undefined): string[] {
  if (debugOverride !== undefined) return ["--max-thinking-tokens", String(debugOverride)];
  return (extendedThinking ?? true) ? ["--max-thinking-tokens", String(DEFAULT_MAX_THINKING_TOKENS)] : ["--thinking", "disabled"];
}

/** The spawn env object. `extra` carries runtime-provided values (auth, TZ, CLAUDE_PLUGIN_ROOT). Extended
 *  thinking is NOT delivered here — real Cowork sets no `MAX_THINKING_TOKENS` env; the SDK maps its
 *  `maxThinkingTokens` option straight to the `--max-thinking-tokens` / `--thinking disabled` CLI flag
 *  (see `thinkingArgs`), so the flag is the sole channel. */
export function spawnEnv(
  baseline: PlatformBaseline,
  opts: { configGuest: string; proxyHost: string; extra?: Record<string, string> },
): Record<string, string> {
  return {
    ...(baseline.spawn?.env ?? { CLAUDE_CODE_IS_COWORK: "1" }),
    CLAUDE_CONFIG_DIR: opts.configGuest,
    HOME: "/tmp",
    HTTP_PROXY: opts.proxyHost,
    HTTPS_PROXY: opts.proxyHost,
    http_proxy: opts.proxyHost,
    https_proxy: opts.proxyHost,
    // Binary-verified (asar @12472288): production sets this on the container spawn env too. The agent
    // validates it against win32|darwin|linux (ELF `YPt()`) — derivable headlessly from `process.platform`,
    // unlike the account-identity/OTEL vars below which need live Desktop state we don't have.
    CLAUDE_CODE_HOST_PLATFORM: process.platform,
    ...(opts.extra ?? {}),
  };
}

/**
 * The NATIVE spawn env for hostloop's agent process — a real macOS process, not a container occupant.
 * Deliberately NOT `spawnEnv`: no forced `HOME=/tmp` (this process runs on the actual host, so its own
 * state dirs must resolve against the real HOME, not a container-hardening fake one), and no
 * HTTP(S)_PROXY (production's native agent process does not proxy its own Anthropic API traffic —
 * bash/web_fetch already route around this process entirely via the workspace MCP handler, so nothing
 * here needs the sidecar proxy; this is the least-verified assumption in this design, flagged for
 * re-verification if a future Desktop release changes the native binary's egress behavior).
 * `configDir` is a REAL HOST PATH (CLAUDE_CONFIG_DIR), not a guest path — unlike `spawnEnv`.
 */
export function hostNativeSpawnEnv(
  baseline: PlatformBaseline,
  opts: {
    configDir: string;
    extra?: Record<string, string>;
    // Real HOST filesystem paths of currently-connected folders (Mount[] filtered to kind==="folder"),
    // not guest/mnt paths — hostloop is the only spawn tier where the agent process runs natively
    // against the real host tree, so it's the only tier where these are meaningful to emit.
    folderHostPaths?: string[];
  },
): Record<string, string> {
  return {
    ...(baseline.spawn?.env ?? { CLAUDE_CODE_IS_COWORK: "1" }),
    CLAUDE_CONFIG_DIR: opts.configDir,
    // NO MAX_THINKING_TOKENS — see spawnEnv's doc comment; the flag (thinkingArgs) is the sole channel.
    // The caller (hostloop.ts) additionally STRIPS any inherited host MAX_THINKING_TOKENS from this
    // process's `...process.env` base before spawning, so a stray host value can't silently override
    // the flag (env would otherwise win were the ELF to still read it — belt-and-suspenders).
    // Binary-verified (asar @12472288): same host-platform identity var as the container spawn env.
    CLAUDE_CODE_HOST_PLATFORM: process.platform,
    // Binary-verified (asar @12473150): production sets this only when connected folders are present
    // (`userSelectedFolders?.length && …`), joined with "|" — the agent reads it as an OTEL attribute
    // split on "|" (ELF @226793812). Hostloop-only by deliberate choice (production sets it even for
    // staged copies): emitting host paths at container/microvm would bake machine-specific /Users/…
    // paths into cassettes (breaking machine-independent replay) and let an in-guest `env` trip the
    // container-tier host_path_leak default-fail. Omit entirely (not "") when no folders are connected.
    ...(opts.folderHostPaths?.length ? { CLAUDE_CODE_WORKSPACE_HOST_PATHS: opts.folderHostPaths.join("|") } : {}),
    ...(opts.extra ?? {}),
  };
}

const HARDENING = [
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--read-only",
  "--tmpfs",
  "/tmp:rw,exec,nosuid,size=1g",
  "--pids-limit",
  "1024",
];

/** One nested bind layered over the session-tree bind, for hostloop's real (never-copied) folder mounts
 *  and the two `.claude/{skills,projects}` ro binds. `guestPath` is absolute in-container. */
export interface HostLoopBindMount {
  hostPath: string;
  guestPath: string;
  ro: boolean;
}

export interface DockerRunInput {
  network: string;
  lockdown: boolean;
  sessionRoot: string;
  sessionHost: string;
  // Absent for hostloop's VM sidecar: the agent process is a native macOS spawn, not a container
  // occupant, so there is no agent binary to bind-mount and no `claude …` argv to run — the sidecar
  // exists solely as a `docker exec` target for bash/web_fetch. container/microvm always pass both
  // (unchanged behavior — this is purely additive).
  agentHost?: string;
  agentIn?: string;
  image: string;
  env: Record<string, string>;
  agentArgv?: string[];
  name?: string; // host-loop needs a name for `docker exec`
  readOnlyMountPaths?: string[]; // mnt-relative paths of `mode:r` mounts → nested `:ro` binds
  extraBinds?: HostLoopBindMount[]; // real (never-copied) folder mounts + `.claude/{skills,projects}`
}

/** The full `docker run …` argv. When `agentArgv` is omitted (hostloop's VM-sidecar-only
 *  container), the container runs a keep-alive command instead of the agent — the agent process itself
 *  is spawned natively on the host and never occupies this container. */
export function dockerRunArgv(i: DockerRunInput): string[] {
  return [
    "run",
    "--rm",
    "-i",
    ...(i.name ? ["--name", i.name] : []),
    "--platform",
    "linux/arm64",
    "--network",
    i.network,
    ...(i.lockdown ? HARDENING : []),
    "-w",
    i.sessionRoot,
    // Render SECRET values by NAME only (`-e KEY`) so the token never lands in `docker run`'s
    // argv (visible via ps / /proc/<pid>/cmdline). Docker inherits the value from its own env — the
    // harness process env, where runtimeAuthEnv read it. Non-secret env keeps the explicit KEY=value.
    ...Object.entries(i.env).flatMap(([k, v]) => (SECRET_ENV_KEYS.has(k) ? ["-e", k] : ["-e", `${k}=${v}`])),
    ...(i.agentHost && i.agentIn ? ["-v", `${i.agentHost}:${i.agentIn}:ro`] : []),
    "-v",
    `${i.sessionHost}:${i.sessionRoot}`,
    // Per-mount read-only enforcement — a nested `:ro` bind over each `mode:r` subpath makes
    // uploads / plugins unwritable in the guest (matching Cowork: asar uploads = 'ro'), while the rest
    // of the session tree stays writable. Delete-deny for rw/rwd is the separate FUSE sub-project.
    ...(i.readOnlyMountPaths ?? []).flatMap((mp) => ["-v", `${i.sessionHost}/mnt/${mp}:${i.sessionRoot}/mnt/${mp}:ro`]),
    // Real folder mounts + `.claude/{skills,projects}`, layered AFTER the overlays above so they
    // correctly shadow the (now-absent, for folders) staged-copy destination.
    ...(i.extraBinds ?? []).flatMap((b) => ["-v", `${b.hostPath}:${b.guestPath}${b.ro ? ":ro" : ""}`]),
    i.image,
    ...(i.agentArgv ?? ["sleep", "infinity"]),
  ];
}

function notIn(excl?: string[]) {
  const set = new Set(excl ?? []);
  return (t: string) => !set.has(t);
}
