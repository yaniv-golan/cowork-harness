import { DESKTOP_APP_VERSION_MIN_VERSION, cmpVersionStrings, recordedLayoutDivergence } from "../baseline.js";
import { warn } from "../io.js";
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
    /** Fixed flags a tier adds for itself (host-loop's `--settings` from Desktop 2.7032.0). Emitted before
     *  the plugin dirs and the variadic tail; absent → argv unchanged. */
    extraArgs?: string[];
  },
): string[] {
  const spawn = baseline.spawn;
  // A baseline with NO `spawn` block cannot be spawned faithfully at a sandbox tier: the tool set,
  // pre-approvals, effort default and config-dir location all come from it, and the `?? []` fallbacks
  // below would silently emit an agent with no Read/Write/Bash/Skill/Task at all — a run that cannot
  // execute the skill under test while still reporting a verdict. Refuse instead. (`protocol` builds its
  // own argv and inherits the host CLI's toolset, so it is unaffected and stays usable.)
  if (!spawn)
    throw new Error(
      `baseline "${baseline.appVersion}" has no \`spawn\` block, so a sandbox tier cannot reproduce Cowork's ` +
        `toolset, pre-approvals or config-dir layout — the agent would launch with none of its file/bash tools. ` +
        `Use a baseline recorded by \`sync\`, or run at \`fidelity: protocol\` (which builds its own argv).`,
    );
  // FIDELITY, not correctness: guest paths are always staged at `<sessionRoot>/mnt` (see
  // GUEST_MNT_SEGMENT), so a baseline recording a different mnt root is reproduced approximately. Say so
  // once, here, rather than letting the recorded value build a path no stager creates.
  const divergence = recordedLayoutDivergence(baseline);
  if (divergence)
    warn(
      `::warning:: baseline "${baseline.appVersion}" records a guest mnt root this harness cannot stage ` +
        `(recorded ${divergence.recorded}, staged ${divergence.staged}) — guest paths use the staged layout, ` +
        `so mount-path fidelity at this tier is approximate.\n`,
    );
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
    // Hook lifecycle frames — emitted ONLY when a staged plugin declares runnable hooks (see
    // LaunchPlan.includeHookEvents). Telemetry-only on the agent side; Desktop never passes it, so the
    // default omits it → goldens unchanged.
    ...(plan.includeHookEvents ? ["--include-hook-events"] : []),
    ...(opts.disallowed?.length ? ["--disallowedTools", ...opts.disallowed] : []),
    ...(opts.systemPromptAppend ? ["--append-system-prompt", opts.systemPromptAppend] : []),
    ...(plan.model ? ["--model", plan.model] : []),
    ...(opts.mcpGuest ? ["--mcp-config", opts.mcpGuest] : []),
    // Session persistence: pin the agent's native session id (so we can resume it), or resume a prior
    // one. Only emitted when a stable session was requested — default omits both → goldens unchanged.
    ...(plan.agentSessionId ? (plan.resume ? ["--resume", plan.agentSessionId] : ["--session-id", plan.agentSessionId]) : []),
    ...(opts.extraArgs ?? []),
    ...pluginDirArgs(plan, opts.mntRoot),
    // variadic flags LAST so they don't swallow other options
    ...(tools.length ? ["--tools", ...tools] : []),
    ...(allowed.length ? ["--allowedTools", ...allowed] : []),
  ];
}

/**
 * `--plugin-dir` args for every plugin root the plan declares, rooted at the tree the caller actually
 * staged. THE single derivation of this rule (docs/invariants.md: every agent-visible path is composed
 * from the tree the harness stages) — `baseAgentArgs` passes the guest `mnt` root, `spawnProtocol` passes
 * its real host work dir. Both spellings are POSIX, so one template join serves both.
 *
 * `protocol` used to pass NO `--plugin-dir` at all, on the theory that L0 could not reproduce Cowork's
 * cache layout. That was a self-inflicted limitation, not a capability one: the host CLI accepts the flag
 * (live-verified), and without it a declared plugin — or a bare skill dir — was never delivered to the
 * agent, so the positional argument was silently inert. Passing it makes L0 MORE faithful, not less; the
 * residual divergence is the ROOT, not the mechanism.
 */
export function pluginDirArgs(plan: Pick<LaunchPlan, "pluginDirs">, root: string): string[] {
  return plan.pluginDirs.flatMap((p) => ["--plugin-dir", `${root}/${p}`]);
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
/**
 * The proxy env every sandboxed process gets. ONE definition so the agent spawn and the boundary
 * self-test cannot fork — the same reason `validateBareDomain` is shared between the proxy and the
 * run-side seed path. A probe that tested a different env than the agent receives would be worse than
 * no probe: it would report on a configuration nothing actually runs.
 *
 * BOTH CASES ARE LOAD-BEARING, and not symmetrically. curl honours `http_proxy` in **lower case only**
 * for `http://` URLs — the httpoxy (CVE-2016-5385) mitigation, since a CGI `Proxy:` header lands in
 * `HTTP_PROXY`. Measured on the pinned image's curl 7.81.0: uppercase-only leaves a plain-HTTP request
 * UNPROXIED. Dropping the lowercase pair would silently stop proxying plain HTTP; dropping the
 * uppercase pair would break clients that read only that. Keep all four.
 *
 * `NO_PROXY` exempts loopback so the proxy never intercepts it. Two independent reasons:
 *   - The harness otherwise contradicts itself — the microvm firewall explicitly ACCEPTs loopback
 *     (`-o lo`, `-d 127.0.0.0/8` in lima.ts) but a proxy-honouring client never emits a loopback packet
 *     for those rules to accept, because these vars divert it to the gateway first.
 *   - At container tier the proxy lives in a DIFFERENT container, where `localhost` means the proxy
 *     itself — so a skill that starts a local server and curls it fails against an unrelated process.
 * Cowork describes its own allowlist as a "public-egress filter, not a sandbox" in which "IP literals
 * and localhost always resolve regardless of this list", which corroborates but does not prove the 1p
 * case (that text documents the 3p managed key; real enforcement is in-VM, not in the asar).
 *
 * Scope is loopback ONLY, deliberately narrower than Cowork's "IP literals" wording: the sandbox sits on
 * an `internal` network with no route off-box, so exempting private ranges buys no reachability while
 * widening the bypass surface.
 *
 * Residual, by design: a bypassed request never reaches the proxy, so it logs no `deny` row. An
 * `egress_denied` assertion against `localhost` (or a `*.localhost` subdomain, which both curl and
 * python-requests match here — RFC 6761 reserves those to loopback anyway) has no evidence to find.
 * Reachability is unchanged either way.
 */
export function proxyEnvVars(proxyHost: string): Record<string, string> {
  return {
    HTTP_PROXY: proxyHost,
    HTTPS_PROXY: proxyHost,
    http_proxy: proxyHost,
    https_proxy: proxyHost,
    NO_PROXY: "localhost,127.0.0.1,::1",
    no_proxy: "localhost,127.0.0.1,::1",
  };
}

export function spawnEnv(
  baseline: PlatformBaseline,
  opts: { configGuest: string; proxyHost: string; extra?: Record<string, string> },
): Record<string, string> {
  return {
    ...(baseline.spawn?.env ?? { CLAUDE_CODE_IS_COWORK: "1" }),
    CLAUDE_CONFIG_DIR: opts.configGuest,
    HOME: "/tmp",
    ...proxyEnvVars(opts.proxyHost),
    // Binary-verified (asar @12472288): production sets this on the container spawn env too. The agent
    // validates it against win32|darwin|linux (ELF `YPt()`) — derivable headlessly from `process.platform`,
    // unlike the account-identity/OTEL vars below which need live Desktop state we don't have.
    CLAUDE_CODE_HOST_PLATFORM: process.platform,
    // Desktop 2.2553.1. Production's W2 base env sets this unconditionally on first-party
    // (`<dep>.type==="3p"?"":app.getVersion()`), and the agent READS it: on the `claude-desktop` /
    // `local-agent` entrypoints — `local-agent` is what the harness pins — it becomes the fallback source
    // of the `anthropic-client-version` request header (the platform half is a hard-coded `desktop_app`) whenever
    // ANTHROPIC_CUSTOM_HEADERS carries none, which is our case. Without this injection the harness's agent
    // sends no client-identity headers at all, where production always sends them. It is ALLOWLISTED in
    // the sync (app.getVersion() is a host call, not structurally resolvable), so this is the only place
    // the value is supplied — same split as CLAUDE_CODE_HOST_PLATFORM above. VERSION-GATED, unlike that
    // key: HOST_PLATFORM is set by every asar on record, whereas this one is new in 2.2553.1, so injecting
    // it unconditionally would hand a run pinned to an older baseline a key that Desktop never set there.
    ...(cmpVersionStrings(baseline.appVersion, DESKTOP_APP_VERSION_MIN_VERSION) >= 0
      ? { CLAUDE_CODE_DESKTOP_APP_VERSION: baseline.appVersion }
      : {}),
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
    // Desktop 2.2553.1. Production's W2 base env sets this unconditionally on first-party
    // (`<dep>.type==="3p"?"":app.getVersion()`), and the agent READS it: on the `claude-desktop` /
    // `local-agent` entrypoints — `local-agent` is what the harness pins — it becomes the fallback source
    // of the `anthropic-client-version` request header (the platform half is a hard-coded `desktop_app`) whenever
    // ANTHROPIC_CUSTOM_HEADERS carries none, which is our case. Without this injection the harness's agent
    // sends no client-identity headers at all, where production always sends them. It is ALLOWLISTED in
    // the sync (app.getVersion() is a host call, not structurally resolvable), so this is the only place
    // the value is supplied — same split as CLAUDE_CODE_HOST_PLATFORM above. VERSION-GATED, unlike that
    // key: HOST_PLATFORM is set by every asar on record, whereas this one is new in 2.2553.1, so injecting
    // it unconditionally would hand a run pinned to an older baseline a key that Desktop never set there.
    ...(cmpVersionStrings(baseline.appVersion, DESKTOP_APP_VERSION_MIN_VERSION) >= 0
      ? { CLAUDE_CODE_DESKTOP_APP_VERSION: baseline.appVersion }
      : {}),
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
  /** The agent's working directory, when it is not the session root itself. `sessionRoot` is the BIND
   *  TARGET and the anchor every guest path is composed from; `cwd` is only where the process starts.
   *  Production's own working dir is a folder mount or `outputs`, so conflating the two would compose
   *  guest paths under a directory that is not the bind target. Defaults to `sessionRoot`. */
  agentCwd?: string;
  sessionHost: string;
  // `agentArgv` is absent for hostloop's VM sidecar: the agent is a native macOS spawn, not a container
  // occupant, so no `claude …` argv runs there — the sidecar exists solely as a `docker exec` target for
  // bash/web_fetch, and without an argv it runs the keep-alive default below.
  // `agentHost`/`agentIn` are NOT absent there, despite what this comment claimed for weeks: hostloop
  // still binds the staged ELF read-only for parity/inspection. "No agent runs in the sidecar" is true
  // of the argv and false of the bind; conflating them is what made the golden snapshot model a
  // container that does not exist at that tier. container/microvm pass all three.
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
    i.agentCwd ?? i.sessionRoot,
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
