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
  extraTools?: string[]; // e.g. mcp__workspace__bash — appended to --tools AND --allowedTools
}

/**
 * §3.1 — the agent CLI args WITHOUT the leading `claude` token (the microvm exec appends it separately
 * in the lima argv). The single source for the flag set + order; `agentArgs` (container/hostloop) and
 * `microvmAgentArgs` both delegate here so the two can never drift again (a past divergence dropped
 * `--max-thinking-tokens` from the microvm path). `mntRoot` differs per tier; disallowed/extraTools are
 * container/hostloop-only (the microvm passes neither).
 */
export function baseAgentArgs(
  baseline: PlatformBaseline,
  plan: LaunchPlan,
  opts: { mntRoot: string; mcpGuest?: string; systemPromptAppend?: string; disallowed?: string[]; extraTools?: string[] },
): string[] {
  const spawn = baseline.spawn;
  const effort = plan.effort ?? spawn?.effortDefault ?? "medium";
  const tools = [...(spawn?.tools ?? []).filter(notIn(opts.disallowed)), ...(opts.extraTools ?? [])];
  const allowed = [...(spawn?.allowedTools ?? []).filter(notIn(opts.disallowed)), ...(opts.extraTools ?? [])];
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
    // Emit the thinking budget as a CLI flag too (channel fidelity — Cowork passes it). The ELF ALSO
    // honors the MAX_THINKING_TOKENS env (set in spawnEnv) and env wins (binary-verified), so both
    // channels carry the same resolved value. Kept among the FIXED flags so the variadic
    // --tools/--allowedTools stay last (golden invariant).
    "--max-thinking-tokens",
    String(resolveMaxThinkingTokens(plan.maxThinkingTokens, plan.model, spawn?.maxThinkingTokens ?? DEFAULT_MAX_THINKING_TOKENS)),
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

/** §3.1 — the full `claude …` args (container/hostloop): the shared base prefixed with the binary token. */
export function agentArgs(baseline: PlatformBaseline, plan: LaunchPlan, opts: AgentArgsOpts): string[] {
  return [
    "claude",
    ...baseAgentArgs(baseline, plan, {
      mntRoot: opts.mntRoot,
      mcpGuest: opts.mcpGuest,
      systemPromptAppend: opts.systemPromptAppend,
      disallowed: opts.disallowed,
      extraTools: opts.extraTools,
    }),
  ];
}

/**
 * §3.2 / #23 — resolve the thinking-token budget. Faithful port of Cowork's `f7e` resolver
 * (binary-verified, app.asar 1.12603.1):
 *   function f7e(A,e){return typeof A=="number"?A : e&&e in A ? A[e] : A.default??hre}   // hre=31999
 * `value` = the session's `max_thinking_tokens` (a flat number or a per-model map), `model` = the
 * model id, `fallback` = the baseline default (synced `maxThinkingTokens`, = DEFAULT_MAX_THINKING_TOKENS).
 */
export function resolveMaxThinkingTokens(
  value: number | Record<string, number> | undefined,
  model: string | undefined,
  fallback: number,
): number {
  // #33: defense-in-depth — resolve, then reject a non-positive budget (the schema enforces positive
  // for YAML, but this guards any other caller/path). "Never 0" is a hard invariant.
  const resolved =
    value === undefined
      ? fallback
      : typeof value === "number"
        ? value
        : model && model in value
          ? value[model]
          : (value.default ?? fallback);
  if (!Number.isInteger(resolved) || resolved <= 0) throw new Error(`max_thinking_tokens must be a positive integer (got ${resolved})`);
  return resolved;
}

/** §3.2 — the spawn env object. `extra` carries runtime-provided values (auth, TZ, CLAUDE_PLUGIN_ROOT). */
export function spawnEnv(
  baseline: PlatformBaseline,
  opts: { configGuest: string; proxyHost: string; extra?: Record<string, string>; maxThinkingTokens?: number },
): Record<string, string> {
  return {
    ...(baseline.spawn?.env ?? { CLAUDE_CODE_IS_COWORK: "1" }),
    CLAUDE_CONFIG_DIR: opts.configGuest,
    // #23: session override (resolved per-model) wins; else the synced baseline default (hre=31999). Never 0.
    MAX_THINKING_TOKENS: String(opts.maxThinkingTokens ?? baseline.spawn?.maxThinkingTokens ?? DEFAULT_MAX_THINKING_TOKENS),
    HOME: "/tmp",
    HTTP_PROXY: opts.proxyHost,
    HTTPS_PROXY: opts.proxyHost,
    http_proxy: opts.proxyHost,
    https_proxy: opts.proxyHost,
    ...(opts.extra ?? {}),
  };
}

export const HARDENING = [
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

export interface DockerRunInput {
  network: string;
  lockdown: boolean;
  sessionRoot: string;
  sessionHost: string;
  agentHost: string;
  agentIn: string;
  image: string;
  env: Record<string, string>;
  agentArgv: string[];
  name?: string; // host-loop needs a name for `docker exec`
  readOnlyMountPaths?: string[]; // #23: mnt-relative paths of `mode:r` mounts → nested `:ro` binds
}

/** §3.3/§3.4 — the full `docker run …` argv. */
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
    // #28: render SECRET values by NAME only (`-e KEY`) so the token never lands in `docker run`'s
    // argv (visible via ps / /proc/<pid>/cmdline). Docker inherits the value from its own env — the
    // harness process env, where runtimeAuthEnv read it. Non-secret env keeps the explicit KEY=value.
    ...Object.entries(i.env).flatMap(([k, v]) => (SECRET_ENV_KEYS.has(k) ? ["-e", k] : ["-e", `${k}=${v}`])),
    "-v",
    `${i.agentHost}:${i.agentIn}:ro`,
    "-v",
    `${i.sessionHost}:${i.sessionRoot}`,
    // #23: per-mount read-only enforcement — a nested `:ro` bind over each `mode:r` subpath makes
    // uploads / plugins unwritable in the guest (matching Cowork: asar uploads = 'ro'), while the rest
    // of the session tree stays writable. Delete-deny for rw/rwd is the separate #9-A FUSE sub-project.
    ...(i.readOnlyMountPaths ?? []).flatMap((mp) => ["-v", `${i.sessionHost}/mnt/${mp}:${i.sessionRoot}/mnt/${mp}:ro`]),
    i.image,
    ...i.agentArgv,
  ];
}

function notIn(excl?: string[]) {
  const set = new Set(excl ?? []);
  return (t: string) => !set.has(t);
}
